import crypto from 'node:crypto';
import { WorkspaceLeaseError, WorkspaceLeaseManager } from './workspace-lease.js';
import { buildDelivery, collectNodeIds } from './delivery.js';
import { buildPlanCard, PRE_SUBMIT_ERROR_CODES, SESSION_CONTROL_COMMANDS, SessionBudget, UNCERTAIN_SUBMIT_CODES } from './session-budget.js';
import { planBatchPick } from './batch-pick.js';
import { importIrisPipelineModule } from './iris-modules.js';
import { appendRunArtifactReceipts } from './receipts.js';
import { AGENT_TASK_COMMAND_SET, createAgentTaskLayer } from './task-layer.js';

const { PIPELINE_COMMANDS } = await importIrisPipelineModule('commands');

const sendEvent = (response, type, payload) => response.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);

const HOST_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const LEASED_WORKFLOW_COMMANDS = new Set([
  'workflow.inspect', 'workflow.selection.get', 'workflow.apply', 'workflow.node.run', 'workflow.node.stop',
  'workflow.node.create', 'workflow.node.create-connected', 'workflow.node.update', 'workflow.node.delete',
  'workflow.node.move', 'workflow.node.resize', 'workflow.node.tool', 'workflow.image.tool', 'workflow.video.tool', 'workflow.audio.tool', 'workflow.connect', 'workflow.disconnect',
  'workflow.select', 'workflow.viewport.set', 'workflow.generate', 'workflow.models.list', 'workflow.nodes.search', 'workflow.cost.estimate', 'workflow.node.tool.list', 'workflow.shortcut.list', 'workflow.shortcut.apply', 'workflow.group.create', 'workflow.group.run', 'workflow.note.write',
  'workflow.media.import', 'workflow.script.materialize', 'workflow.export',
]);
// 与 components/workflow/revisionRebase.ts 的 NODE_REBASE_COMMANDS 一致：这些命令的版本冲突交给浏览器按节点判断。
const NODE_REBASE_COMMANDS = new Set(['workflow.node.update', 'workflow.node.run', 'workflow.apply']);

export class WorkflowAgentSessionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'WorkflowAgentSessionError';
    this.code = code;
    this.details = details;
    this.retryable = ['LINK_OFFLINE', 'WORKSPACE_UNAVAILABLE', 'LEASE_EXPIRED'].includes(code);
  }

  toJSON() {
    return { code: this.code, message: this.message, retryable: this.retryable, details: this.details };
  }
}

const hostWriterView = writer => writer
  ? {
    agentIdentity: writer.agentIdentity,
    projectId: writer.projectId || null,
    hasSessionId: Boolean(writer.hostSessionId),
  }
  : null;

const ACTIVITY_LIMIT = 200;
const ACTIVITY_SUMMARY_KEYS = ['nodeId', 'type', 'title', 'label', 'toolId', 'from', 'to', 'sourceId', 'targetId'];

function summarizeActivityArgs(args) {
  if (!args || typeof args !== 'object') return null;
  const parts = [];
  for (const key of ACTIVITY_SUMMARY_KEYS) {
    const value = args[key];
    if (typeof value === 'string' && value) parts.push(key + '=' + value.slice(0, 60));
  }
  return parts.length ? parts.join(' ') : null;
}

function sessionError(code, message, details) {
  return new WorkflowAgentSessionError(code, message, details);
}

// 这些命令要等真实生成或人工确认结束才回包（视频生成上限约 600s），不能套用普通 60s 超时，
// 否则外部 Agent 会在任务仍在运行时收到「操作超时」并重复提交。
export const LONG_RUNNING_COMMANDS = new Set([
  'workflow.node.run', 'workflow.node.tool', 'workflow.image.tool', 'workflow.video.tool', 'workflow.audio.tool', 'workflow.generate', 'workflow.shortcut.apply', 'workflow.group.run', 'workflow.media.import', 'workflow.export', 'production.run', 'production.approve',
  // 高风险删除在浏览器里等「允许/拒绝」弹窗，人的反应时间不受 60s 约束。
  'workflow.node.delete', 'workflow.project.delete',
]);

export class WorkflowAgentSession {
  constructor({ timeoutMs = 60000, longRunningTimeoutMs = 900_000, taskTimeoutMs = 30 * 60_000, isKnownAgentIdentity, workspaceLease, webUrl = null, budget, taskStore } = {}) {
    this.timeoutMs = timeoutMs;
    this.longRunningTimeoutMs = longRunningTimeoutMs;
    this.clients = new Map();
    this.pending = new Map();
    this.snapshot = null;
    this.snapshots = new Map();
    this.activeClientId = null;
    this.activeHostWriter = null;
    this.isKnownAgentIdentity = isKnownAgentIdentity;
    this.workspaceLease = workspaceLease || new WorkspaceLeaseManager();
    this.activity = [];
    // 字符串或函数（WebUI 地址可能在会话建立后才被发现）；用于生成交付契约里的 canvasUrl。
    this.webUrl = webUrl;
    // 会话预算 / 暂停 / dry-run（P1）：只做硬上限，不绕过浏览器里的人工确认。
    this.budget = budget || new SessionBudget();
    // 异步任务层（agent.task.*）：后台执行长命令，外部 Agent 轮询 get(afterSeq)。
    this.tasks = createAgentTaskLayer({
      run: (command, args, source, idempotencyKey, signal, caller, runOptions) => this.callCommand(command, args, source, idempotencyKey, signal, caller, runOptions),
      stop: (command, args, source, caller) => this.callCommand(command, args, source, undefined, undefined, caller),
      taskTimeoutMs,
      // 任务台账（index.js 传入 Agent 数据目录下的 agent-tasks.json）：重启后 agent.task.get 仍能读到任务。
      store: taskStore,
      // 对账 / 恢复轮询：从浏览器推来的画布快照里读任务关联节点的状态与供应商任务 ID。
      inspect: record => this.inspectTaskNodes(record),
      onEvent: (taskId, event) => this.emit('agent_task', { taskId, ...event }),
    });
  }

  /** 任务关联节点的当前状态；没有可用的画布快照时返回 null（保持任务原状态，稍后再对账）。 */
  inspectTaskNodes(record) {
    const projectId = record?.args?.projectId ? String(record.args.projectId) : null;
    const candidates = projectId
      ? [...this.snapshots.values()].filter(snapshot => String(snapshot?.id || '') === projectId)
      : [this.snapshot, ...this.snapshots.values()].filter(Boolean);
    const ids = new Set(record?.nodeIds || []);
    for (const snapshot of candidates) {
      const nodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes : [];
      if (nodes.some(node => ids.has(String(node?.id)))) return nodes;
    }
    return null;
  }

  health() {
    return {
      ok: true,
      hasWorkflow: Boolean(this.snapshot),
      clients: this.clients.size,
      pending: this.pending.size,
      activeProjectId: this.snapshot?.id || null,
      snapshotUpdatedAt: this.snapshot?.snapshotUpdatedAt || null,
      clientId: this.activeClientId || this.snapshot?.clientId || null,
      revision: this.snapshot?.draftVersion ?? this.snapshot?.revision ?? null,
      activeWriter: this.activeClientId ? { clientId: this.activeClientId, projectId: this.snapshot?.id || null } : null,
      activeHostWriter: hostWriterView(this.activeHostWriter),
    };
  }

  openEvents(url, response) {
    const clientId = url.searchParams.get('clientId') || crypto.randomUUID();
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    this.clients.set(clientId, response);
    sendEvent(response, 'hello', { ok: true, clientId });
    const timer = setInterval(() => {
      try {
        sendEvent(response, 'ping', { time: Date.now() });
      } catch {
        clearInterval(timer);
      }
    }, 15000);
    response.on('close', () => {
      clearInterval(timer);
      // A reconnect may reuse a client id before the old SSE response emits
      // `close`. Never let the old response evict the replacement session; a
      // client that was already removed must still run lease/pending cleanup.
      const current = this.clients.get(clientId);
      if (current && current !== response) return;
      this.clients.delete(clientId);
      this.snapshots.delete(clientId);
      this.workspaceLease.revokeClient(clientId);
      if (this.activeClientId === clientId) {
        const projectId = this.snapshot?.id || null;
        this.activeClientId = null;
        this.snapshot = null;
        this.emit('writer_unavailable', { clientId, projectId });
      }
      this.pending.forEach((pending, requestId) => {
        if (pending.clientId !== clientId) return;
        this.pending.delete(requestId);
        pending.reject(sessionError('WORKSPACE_UNAVAILABLE', 'Iris 浏览器连接已断开，当前 Workflow 不可用。', { clientId }));
      });
    });
  }

  updateSnapshot(snapshot, clientId) {
    const next = {
      ...(snapshot && typeof snapshot === 'object' ? snapshot : {}),
      clientId,
      snapshotUpdatedAt: new Date().toISOString(),
    };
    if (clientId) {
      this.snapshots.delete(clientId);
      this.snapshots.set(clientId, next);
      // The first visible browser claims the writer slot. A second tab may
      // publish a snapshot, but it cannot silently steal the active writer.
      if (!this.activeClientId || !this.clients.has(this.activeClientId)) {
        this.activeClientId = clientId;
        this.snapshot = next;
        this.emit('writer_changed', { clientId, projectId: next.id || null });
      } else if (this.activeClientId === clientId) {
        this.snapshot = next;
      }
    } else {
      this.snapshot = next;
    }
  }

  activateClient({ clientId, projectId } = {}) {
    const id = String(clientId || '');
    const snapshot = this.snapshots.get(id);
    if (!id || !snapshot || !this.clients.has(id)) throw new Error('指定的 Browser Workflow 不可用。');
    if (projectId && String(projectId) !== String(snapshot.id || '')) throw new Error(`Workflow Browser binding 不匹配：${projectId}`);
    this.activeClientId = id;
    this.snapshot = snapshot;
    this.emit('writer_changed', { clientId: id, projectId: snapshot.id || null });
    return { clientId: id, projectId: snapshot.id || null, revision: snapshot.draftVersion ?? snapshot.revision ?? null };
  }

  normalizeAgentIdentity(value) {
    const id = String(value || '').trim().toLowerCase();
    if (!HOST_ID_PATTERN.test(id)) throw sessionError('INVALID_ARGUMENT', 'Agent Identity 无效。');
    if (this.isKnownAgentIdentity && !this.isKnownAgentIdentity(id)) {
      throw sessionError('UNKNOWN_AGENT_HOST', `未注册的 Agent Identity：${id}`);
    }
    return id;
  }

  hostWriterState() {
    return hostWriterView(this.activeHostWriter);
  }

  acquireWorkspaceLease(input) {
    try {
      return this.workspaceLease.acquire(input);
    } catch (cause) {
      if (cause instanceof WorkspaceLeaseError) throw sessionError(cause.code, cause.message, cause.details);
      throw cause;
    }
  }

  validateWorkspaceLease(input) {
    try {
      return this.workspaceLease.validate(input);
    } catch (cause) {
      if (cause instanceof WorkspaceLeaseError) throw sessionError(cause.code, cause.message, cause.details);
      throw cause;
    }
  }

  renewWorkspaceLease(leaseId) {
    try {
      return this.workspaceLease.renew(leaseId);
    } catch (cause) {
      if (cause instanceof WorkspaceLeaseError) throw sessionError(cause.code, cause.message, cause.details);
      throw cause;
    }
  }

  releaseWorkspaceLease(leaseId) {
    return this.workspaceLease.release(leaseId);
  }

  workspaceLeaseState() {
    return this.workspaceLease.list();
  }

  expireWorkspaceLeases() {
    this.workspaceLease.expire();
    return this.workspaceLease.list();
  }

  isLeasedWorkflowCommand(command) {
    return LEASED_WORKFLOW_COMMANDS.has(command);
  }

  browserLeaseContext(boundSnapshot, clientId, args = {}) {
    return {
      clientId,
      projectId: String(args.projectId || boundSnapshot?.id || ''),
      currentClientId: clientId,
      currentProjectId: boundSnapshot?.id || null,
      currentRevision: boundSnapshot?.draftVersion ?? boundSnapshot?.revision ?? 1,
    };
  }

  ensureWorkspaceLease({ command, args, source, caller, context, idempotencyKey }) {
    if (!this.isLeasedWorkflowCommand(command)) return null;
    const identity = caller?.agentIdentity || source;
    const hostSessionId = caller?.hostSessionId || null;
    const explicitLeaseId = args.leaseId || args['lease-id'];
    const mutation = !['workflow.inspect', 'workflow.selection.get'].includes(command);
    const mutationId = args.mutationId || args['mutation-id'] || args.idempotencyKey || args['idempotency-key'] || idempotencyKey;
    try {
      const lease = explicitLeaseId
        ? this.workspaceLease.validate({
          leaseId: explicitLeaseId,
          agentIdentity: identity,
          hostSessionId,
          source,
          ...context,
          mutationId,
          mutation,
          expectedRevision: args.expectedRevision,
        deferRevision: NODE_REBASE_COMMANDS.has(command),
        })
        : this.workspaceLease.acquire({
          agentIdentity: identity,
          hostSessionId,
          source,
          clientId: context.clientId,
          projectId: context.projectId,
          baseRevision: context.currentRevision,
        });
      return this.workspaceLease.validate({
        leaseId: lease.leaseId,
        agentIdentity: identity,
        hostSessionId,
        source,
        ...context,
        mutationId,
        mutation,
        expectedRevision: args.expectedRevision,
        deferRevision: NODE_REBASE_COMMANDS.has(command),
      });
    } catch (cause) {
      if (cause instanceof WorkspaceLeaseError) throw sessionError(cause.code, cause.message, cause.details);
      throw cause;
    }
  }

  activateAgentHost({ agentIdentity, hostSessionId, projectId } = {}) {
    const id = this.normalizeAgentIdentity(agentIdentity);
    const sessionId = hostSessionId === undefined || hostSessionId === null || hostSessionId === ''
      ? null
      : String(hostSessionId).trim().slice(0, 500);
    if (hostSessionId !== undefined && !sessionId) throw sessionError('INVALID_ARGUMENT', 'hostSessionId 不能为空。');
    const requestedProject = projectId === undefined || projectId === null || projectId === ''
      ? this.snapshot?.id || null
      : String(projectId).trim();
    if (projectId !== undefined && !requestedProject) throw sessionError('INVALID_ARGUMENT', 'projectId 不能为空。');
    if (requestedProject && this.snapshot?.id && requestedProject !== this.snapshot.id) {
      throw sessionError(
        'AGENT_PROJECT_INACTIVE',
        '当前 Browser Writer 没有激活这个 Workflow 项目；请先激活对应的 Browser 页面。',
        { activeProjectId: this.snapshot.id, requestedProjectId: requestedProject },
      );
    }
    const previous = this.activeHostWriter;
    const sameIdentity = previous?.agentIdentity === id;
    if (sameIdentity && previous.hostSessionId && sessionId && previous.hostSessionId !== sessionId) {
      throw sessionError('AGENT_HOST_SESSION_MISMATCH', '当前 Agent Host Session 不匹配，请先显式结束旧会话。', { agentIdentity: id });
    }
    const next = {
      agentIdentity: id,
      hostSessionId: sessionId || (sameIdentity ? previous.hostSessionId : null),
      projectId: requestedProject,
    };
    this.activeHostWriter = next;
    this.emit('host_writer_changed', {
      previous: hostWriterView(previous),
      active: hostWriterView(next),
    });
    return {
      activeHostWriter: hostWriterView(next),
      switched: Boolean(previous && (previous.agentIdentity !== next.agentIdentity || previous.projectId !== next.projectId)),
    };
  }

  authorizeExternalHost(caller, args = {}) {
    const requestedIdentity = caller?.agentIdentity;
    const requestedProject = args.projectId || this.snapshot?.id || null;
    const requestedSession = caller?.hostSessionId ? String(caller.hostSessionId).trim() : null;
    const active = this.activeHostWriter;
    if (!requestedIdentity) {
      if (active) throw sessionError(
        'AGENT_HOST_REQUIRED',
        `当前 Workflow 由 ${active.agentIdentity} 控制；请使用当前 Host Projection 再继续。`,
        { activeHostWriter: hostWriterView(active) },
      );
      return;
    }
    const identity = this.normalizeAgentIdentity(requestedIdentity);
    if (!active) {
      this.activeHostWriter = { agentIdentity: identity, hostSessionId: requestedSession, projectId: requestedProject };
      this.emit('host_writer_changed', { previous: null, active: hostWriterView(this.activeHostWriter) });
      return;
    }
    if (active.agentIdentity !== identity) throw sessionError(
      'AGENT_WRITER_INACTIVE',
      `${identity} 不是当前 Workflow 的 Active Host；请先在 Iris Host Picker 显式切换。`,
      { activeHostWriter: hostWriterView(active), requestedAgentIdentity: identity },
    );
    if (active.hostSessionId && active.hostSessionId !== requestedSession) {
      throw sessionError('AGENT_HOST_SESSION_MISMATCH', '当前 Agent Host Session 不匹配，请重新建立 Host 会话。', { agentIdentity: identity });
    }
    if (active.projectId && requestedProject && active.projectId !== requestedProject) throw sessionError(
      'AGENT_PROJECT_INACTIVE',
      '当前 Agent Host 没有激活这个 Workflow 项目；请在 Iris 中显式激活当前项目。',
      { activeHostWriter: hostWriterView(active), requestedProjectId: requestedProject },
    );
  }

  emit(type, payload) {
    this.clients.forEach((client, clientId) => {
      try { sendEvent(client, type, payload); }
      catch {
        this.clients.delete(clientId);
        try { client.end(); } catch { /* connection already closed */ }
      }
    });
  }

  resolveResult({ requestId, clientId, result, error }) {
    const pending = requestId ? this.pending.get(requestId) : null;
    if (!pending) return false;
    if (clientId && pending.clientId !== clientId) return false;
    this.pending.delete(requestId);
    error ? pending.reject(sessionError('WORKFLOW_COMMAND_FAILED', typeof error === 'string' ? error : error.message || 'Workflow command failed')) : pending.resolve(result);
    return true;
  }

  recordActivity({ command, source, caller, args }) {
    const entry = {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      command: String(command || ''),
      source: String(source || ''),
      agentIdentity: caller?.agentIdentity ? String(caller.agentIdentity) : (this.activeHostWriter?.agentIdentity || null),
      projectId: args?.projectId ? String(args.projectId) : (this.snapshot?.id || null),
      summary: summarizeActivityArgs(args),
      // 运行中就带上目标节点，前端据此把「Agent 正在做的事」高亮到画布节点。
      nodeIds: collectNodeIds(args),
      status: 'running',
      durationMs: null,
      error: null,
    };
    this.activity.push(entry);
    if (this.activity.length > ACTIVITY_LIMIT) this.activity.splice(0, this.activity.length - ACTIVITY_LIMIT);
    this.emit('activity', { ...entry });
    return entry;
  }

  finishActivity(entry, { ok, error } = {}) {
    entry.status = ok ? 'ok' : 'error';
    entry.durationMs = Date.now() - Date.parse(entry.at);
    if (!ok) entry.error = { code: error?.code || null, message: String(error?.message || error || '').slice(0, 200) };
    this.emit('activity', { ...entry });
  }

  activityLog(limit = ACTIVITY_LIMIT) {
    const count = Math.max(1, Math.min(ACTIVITY_LIMIT, Number(limit) || ACTIVITY_LIMIT));
    return this.activity.slice(-count).map(entry => ({ ...entry }));
  }

  clientsView() {
    return [...this.clients.keys()].map(clientId => {
      const snapshot = this.snapshots.get(clientId);
      return {
        clientId,
        projectId: snapshot?.id || null,
        projectTitle: typeof snapshot?.title === 'string' ? snapshot.title.slice(0, 80) : null,
        active: clientId === this.activeClientId,
        snapshotUpdatedAt: snapshot?.snapshotUpdatedAt || null,
      };
    });
  }

  async callCommand(command, args = {}, source = 'mcp', idempotencyKey, signal, caller, runOptions = {}) {
    if (command === 'status') return this.dispatchCommand(command, args, source, idempotencyKey, signal, caller);
    // 异步任务层：start 立即返回 taskId，子命令在后台以任务超时执行（不受 60s 限制）。
    if (AGENT_TASK_COMMAND_SET.has(command)) return this.tasks.handle(command, args, { source, idempotencyKey, caller });
    if (PIPELINE_COMMANDS.has(command)) return this.callPipeline(command, args, source, idempotencyKey, signal, caller);
    if (command === 'workflow.batch.pick') return this.batchPick(args, source, idempotencyKey, signal, caller);
    if (SESSION_CONTROL_COMMANDS.has(command)) {
      const control = this.budget.handleControl(command, args, caller);
      if (control.ok && (command === 'session.pause' || command === 'session.resume')) {
        this.emit(command === 'session.pause' ? 'session_paused' : 'session_resumed', control.result);
      }
      return control;
    }
    // dry-run：不进浏览器、不花钱，先给计划卡（会动哪些节点、几次付费生成、预算会不会拦）。
    // workflow.generate 的 dryRun 由浏览器按真实模型能力预演（模型解析、引用、诊断），不在这里截走。
    if ((args?.dryRun === true || args?.['dry-run'] === true) && command !== 'workflow.generate') {
      return { ok: true, result: buildPlanCard(command, args, { snapshot: this.snapshot, budget: this.budget }) };
    }
    // 先原子预留再异步提交：并发的两条付费请求不会看到同一份剩余额度。
    const { blocked, reservation, inFlight } = this.budget.reserve(command, args, { key: idempotencyKey });
    if (blocked) return blocked;
    // 同键请求还在途：合并到第一次的结果（成功 / 失败 / 超时 / 抛错都一样），不再预留、不再提交。
    if (inFlight?.pending) return inFlight.pending;
    const run = this.runReserved(command, args, source, idempotencyKey, signal, caller, runOptions, reservation);
    // 同步登记（runReserved 在第一次 await 前不会让出），重试在任何交错下都能看到它。
    if (reservation?.key) reservation.pending = run;
    return run;
  }

  async runReserved(command, args, source, idempotencyKey, signal, caller, runOptions, reservation) {
    const entry = this.recordActivity({ command, source, caller, args });
    try {
      const result = await this.dispatchCommand(command, args, source, idempotencyKey, signal, caller, runOptions);
      const failed = Boolean(result) && typeof result === 'object' && result.ok === false;
      if (reservation) {
        if (failed && UNCERTAIN_SUBMIT_CODES.has(result.error?.code)) this.budget.commit(reservation, { uncertain: true });
        else if (failed || result?.confirmation?.required) this.budget.release(reservation);
        else this.budget.commit(reservation);
      }
      if (!failed && command === 'workflow.node.run') await this.recordRunReceipts(result, args, caller);
      const delivery = failed ? null : this.deliveryFor(command, result, caller, args, entry);
      if (delivery && delivery.nodeIds.length) entry.nodeIds = delivery.nodeIds;
      this.finishActivity(entry, failed ? { ok: false, error: result.error } : { ok: true });
      return delivery ? { ...result, delivery } : result;
    } catch (error) {
      // 发出前就被拦下的（租约、写入者、项目不匹配、参数错误）退回额度；
      // 其余异常（超时、连接中断、发出后取消）无法确认请求是否已发出：按已用计，不退回。
      if (reservation) {
        if (PRE_SUBMIT_ERROR_CODES.has(error?.code)) this.budget.release(reservation);
        else this.budget.commit(reservation, { uncertain: true });
      }
      this.finishActivity(entry, { ok: false, error });
      throw error;
    }
  }

  // Agent 视频流水线：run 有自己的持久 trace 与预算（tools/iris/pipeline/），不经浏览器租约；会话只记活动并保存 runId 引用。
  async callPipeline(command, args = {}, source = 'mcp', idempotencyKey, signal, caller) {
    const entry = this.recordActivity({ command, source, caller, args });
    const pipelineCaller = source === 'agent' ? 'built-in' : (caller?.agentIdentity || source);
    try {
      const { executePipelineCommand } = await importIrisPipelineModule('index');
      const result = await executePipelineCommand(command, args, { caller: pipelineCaller, mutationId: idempotencyKey, signal });
      this.finishActivity(entry, result.ok ? { ok: true } : { ok: false, error: result.error });
      return result;
    } catch (error) {
      this.finishActivity(entry, { ok: false, error });
      throw error;
    }
  }

  // 批量自动挑选：评分 → 通过 workflow.apply 发 set_batch_primary（可撤销写入，走正常租约与草稿日志）→ 写 decision 回执。
  async batchPick(args = {}, source = 'mcp', idempotencyKey, signal, caller) {
    let plan;
    try {
      plan = planBatchPick({ snapshot: this.snapshot, batchId: args.batchId, scores: args.scores, aspect: args.aspect });
    } catch (error) {
      return { ok: false, error: { code: 'INVALID_ARGUMENT', message: error instanceof Error ? error.message : String(error), retryable: false } };
    }
    if (args.dryRun === true || args['dry-run'] === true) return { ok: true, result: { ...plan, applied: false } };
    const applied = await this.callCommand('workflow.apply', {
      projectId: plan.projectId,
      operations: plan.operations,
      intent: '批量自动挑选主图',
    }, source, idempotencyKey || plan.receipt.externalRef, signal, caller);
    if (applied && applied.ok === false) return applied;
    let receipt = null;
    if (this.receiptStore && plan.receipt.projectId) {
      try {
        receipt = await this.receiptStore.appendMany([plan.receipt], caller || {});
      } catch (error) {
        receipt = { error: error instanceof Error ? error.message : String(error) };
      }
    }
    return { ok: true, result: { ...plan, applied: true, receipt }, ...(applied?.delivery ? { delivery: applied.delivery } : {}) };
  }

  // node.run 成功后自动写产物回执（按 runId 去重）；回执失败只告警，不影响生成结果。
  async recordRunReceipts(result, args, caller) {
    if (!this.receiptStore) return;
    try {
      const { added } = await appendRunArtifactReceipts(this.receiptStore, result, args, caller || {});
      added.forEach(receipt => this.emit('receipt', receipt));
    } catch (error) {
      console.warn('[iris-agent] auto artifact receipt failed:', error instanceof Error ? error.message : String(error));
    }
  }

  resolveWebUrl() {
    try {
      return typeof this.webUrl === 'function' ? this.webUrl() : this.webUrl;
    } catch {
      return null;
    }
  }

  deliveryFor(command, response, caller, args, entry) {
    return buildDelivery({
      command,
      response,
      sessionId: caller?.hostSessionId || this.activeHostWriter?.hostSessionId || entry.id,
      projectId: args?.projectId || this.snapshot?.id || null,
      webUrl: this.resolveWebUrl(),
    });
  }

  async dispatchCommand(command, args = {}, source = 'mcp', idempotencyKey, signal, caller, runOptions = {}) {
    if (command === 'status') {
      return {
        ok: true,
        result: {
          surface: 'agent-session',
          authority: 'browser-workflow',
          ...this.health(),
        },
      };
    }
    const workspaceMode = args?.workspaceMode;
    if (command.startsWith('workflow.') && (workspaceMode === 'native' || workspaceMode === 'headless')) {
      throw sessionError('WORKSPACE_REQUIRED', 'Workflow 命令必须通过可见的 Browser Workflow 执行；隐藏工作区不可用。');
    }
    const requestedClientId = typeof args?.clientId === 'string' && args.clientId ? args.clientId : null;
    const boundSnapshot = requestedClientId ? this.snapshots.get(requestedClientId) : this.snapshot;
    if (command.startsWith('workflow.') && requestedClientId && !this.clients.has(requestedClientId)) {
      throw sessionError('WORKSPACE_UNAVAILABLE', '指定的 Iris Workflow 页面已经不可用。', { clientId: requestedClientId });
    }
    if (command.startsWith('workflow.') && requestedClientId && requestedClientId !== this.activeClientId) {
      throw sessionError('LEASE_TARGET_CHANGED', '指定的 Iris Workflow 不是当前可写页面。', { clientId: requestedClientId, activeClientId: this.activeClientId });
    }
    const clientId = this.clients.has(boundSnapshot?.clientId) ? boundSnapshot.clientId : null;
    if (args?.projectId && boundSnapshot?.id && args.projectId !== boundSnapshot.id) {
      const readOnlyInspect = command === 'workflow.inspect' || command === 'workflow.selection.get';
      const hint = readOnlyInspect
        ? 'inspect reads only the active visible Browser Workflow; pass that projectId or activate the target project in Iris first'
        : 'commands run only on the active visible Browser Workflow; activate the target project in Iris first';
      throw sessionError(
        'LEASE_TARGET_CHANGED',
        `Workflow 目标不匹配：请求的项目 ${args.projectId} 不是当前 Active Browser Workflow（${boundSnapshot.id}）。`,
        { requestedProjectId: args.projectId, activeProjectId: boundSnapshot.id, hint },
      );
    }
    const client = this.clients.get(clientId);
    if (!client) throw sessionError('WORKSPACE_UNAVAILABLE', '当前没有已连接并同步项目的 Iris Workflow。');
    if (command.startsWith('workflow.') && (source === 'cli' || (source === 'mcp' && caller))) {
      this.authorizeExternalHost(caller, args);
    }
    const lease = this.ensureWorkspaceLease({ command, args, source, caller, idempotencyKey, context: this.browserLeaseContext(boundSnapshot, clientId, args) });
    if (signal?.aborted) throw sessionError('CANCELLED', 'Workflow 操作已取消', { command });
    const requestId = crypto.randomUUID();
    const forwardedArgs = { ...args };
    delete forwardedArgs.leaseId;
    delete forwardedArgs['lease-id'];
    const envelope = {
      id: requestId,
      command,
      args: forwardedArgs,
      source,
      idempotencyKey: idempotencyKey || args.idempotencyKey,
      ...(lease ? { workspaceLease: lease } : {}),
      ...(caller ? { caller } : {}),
    };
    sendEvent(client, 'tool_call', { requestId, envelope });
    return new Promise((resolve, reject) => {
      const cleanup = () => signal?.removeEventListener('abort', onAbort);
      const onAbort = () => {
        this.pending.delete(requestId);
        cleanup();
        reject(sessionError('CANCELLED', 'Workflow 操作已取消', { command, requestId }));
      };
      const timeoutMs = runOptions.timeoutMs > 0
        ? runOptions.timeoutMs
        : LONG_RUNNING_COMMANDS.has(command) ? this.longRunningTimeoutMs : this.timeoutMs;
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        cleanup();
        // 不自动重试：浏览器可能仍在等人工确认或仍在执行，重发会重复落写。
        reject(sessionError('COMMAND_TIMEOUT', 'Workflow 操作超时（' + Math.round(timeoutMs / 1000) + 's 内浏览器未回执，可能仍在等待画布上的确认）', { command, requestId, timeoutMs }));
      }, timeoutMs);
      this.pending.set(requestId, {
        clientId,
        resolve: value => { clearTimeout(timer); cleanup(); resolve(value); },
        reject: error => { clearTimeout(timer); cleanup(); reject(error); },
      });
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}
