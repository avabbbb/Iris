import path from 'node:path';
import { AGENT_DIR, workspaceForProject } from './config.js';
import { IrisAgentKernel } from './kernel.js';
import { createProductionRuntimeStream, RUNTIME_AGENT_TEXT_MODEL } from './runtime-connection.js';

export class IrisAgentService {
  constructor({
    databasePath = path.join(AGENT_DIR, 'agent-sessions.db'),
    model = RUNTIME_AGENT_TEXT_MODEL,
    streamFn = createProductionRuntimeStream(),
    tools = [],
  } = {}) {
    this.databasePath = databasePath;
    this.model = model;
    this.streamFn = streamFn;
    this.tools = tools;
    this.sessions = new Map();
    // 每个 projectId 一条串行发送队列：同项目 turn 链式排队执行，
    // 避免 kernel.activeChangeSetId 被并发 turn 交叉污染。
    this.sendQueues = new Map();
    // turnId → { projectId, state: 'queued' | 'running', cancelled }。事件、排队和取消都按 turnId 路由：
    // 同项目排队的请求只收到自己那一轮的事件，取消可以精确指定排队中的某一轮。
    this.turns = new Map();
    // projectId → 正在执行的 turnId。
    this.activeTurns = new Map();
  }

  async getSession(projectId) {
    const id = String(projectId || 'default');
    let session = this.sessions.get(id);
    if (!session) {
      session = (async () => {
        const kernel = new IrisAgentKernel({
          databasePath: this.databasePath,
          model: this.model,
          streamFn: this.streamFn,
          tools: this.tools,
        });
        await kernel.openSession({ projectId: id, cwd: workspaceForProject(id) });
        return kernel;
      })();
      this.sessions.set(id, session);
      session.catch(() => this.sessions.delete(id));
    }
    return session;
  }

  async snapshot(projectId) {
    return (await this.getSession(projectId)).snapshot();
  }

  /**
   * 排进项目串行队列。turnId 由调用方给（便于在流开始前就能取消），缺省时生成。
   * 返回的 promise 带 turnId 属性；排队中被取消的回合以 TURN_CANCELLED 拒绝且不会启动。
   */
  send(projectId, text, images = [], skillAttachment, { turnId } = {}) {
    const id = String(projectId || 'default');
    let ownTurnId;
    try {
      ownTurnId = normalizeTurnId(turnId) || crypto.randomUUID();
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.turns.has(ownTurnId)) {
      const duplicate = Promise.reject(turnError('TURN_ID_IN_USE', `回合 ${ownTurnId} 已在排队或执行`));
      duplicate.turnId = ownTurnId;
      return duplicate;
    }
    const turn = { projectId: id, state: 'queued', cancelled: false };
    this.turns.set(ownTurnId, turn);
    const previous = this.sendQueues.get(id) || Promise.resolve();
    const run = previous.then(async () => {
      if (turn.cancelled) throw turnError('TURN_CANCELLED', '这一轮在排队时已取消');
      const kernel = await this.getSession(id);
      if (turn.cancelled) throw turnError('TURN_CANCELLED', '这一轮在排队时已取消');
      turn.state = 'running';
      this.activeTurns.set(id, ownTurnId);
      try {
        return await kernel.send(text, images, skillAttachment);
      } finally {
        if (this.activeTurns.get(id) === ownTurnId) this.activeTurns.delete(id);
      }
    }).finally(() => this.turns.delete(ownTurnId));
    const tail = run.then(() => undefined, () => undefined);
    this.sendQueues.set(id, tail);
    tail.then(() => { if (this.sendQueues.get(id) === tail) this.sendQueues.delete(id); });
    run.turnId = ownTurnId;
    return run;
  }

  /** 当前项目正在执行的回合；没有则 undefined。 */
  activeTurn(projectId) {
    return this.activeTurns.get(String(projectId || 'default'));
  }

  turnState(turnId) {
    return this.turns.get(String(turnId))?.state;
  }

  /** 只接收指定回合的事件：同项目排在后面的请求不会收到前一轮的流。 */
  async subscribeTurn(projectId, turnId, listener) {
    const id = String(projectId || 'default');
    return this.subscribe(id, event => (this.activeTurns.get(id) === turnId ? listener(event) : undefined));
  }

  async subscribe(projectId, listener) {
    return (await this.getSession(projectId)).subscribe(listener);
  }

  /**
   * 取消。给了 turnId：排队中的回合直接出队（不会启动），正在执行的回合中止，其它项目或已结束的回合不受影响。
   * 不给 turnId（旧客户端）：只中止该项目正在执行的回合，与原行为一致。
   * 返回 { cancelled, state }，state 是取消时该回合所处的阶段。
   */
  async cancel(projectId, turnId) {
    const id = String(projectId || 'default');
    if (turnId !== undefined && turnId !== null && turnId !== '') {
      const key = String(turnId);
      const turn = this.turns.get(key);
      if (!turn || turn.projectId !== id) return { cancelled: false, state: 'unknown' };
      turn.cancelled = true;
      if (turn.state === 'running' && this.sessions.has(id)) (await this.getSession(id)).cancel();
      return { cancelled: true, state: turn.state };
    }
    // 会话不存在时不再强开新 session。
    if (!this.sessions.has(id)) return { cancelled: false, state: 'unknown' };
    const active = this.activeTurns.get(id);
    (await this.getSession(id)).cancel();
    return { cancelled: Boolean(active), state: active ? 'running' : 'idle' };
  }

  async close() {
    const sessions = await Promise.allSettled(this.sessions.values());
    await Promise.all(sessions.flatMap(result => result.status === 'fulfilled' ? [result.value.close()] : []));
    this.sessions.clear();
    this.sendQueues.clear();
    for (const turn of this.turns.values()) turn.cancelled = true;
    this.activeTurns.clear();
  }
}

const TURN_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function normalizeTurnId(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const text = String(value);
  if (!TURN_ID_PATTERN.test(text)) throw turnError('TURN_ID_INVALID', 'turnId 只能包含字母、数字和 ._:-，最长 128 个字符');
  return text;
}

function turnError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
