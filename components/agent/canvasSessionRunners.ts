// 画布会话卡的后台运行（P1b 排队修复）：面板主运行时忙（正在跑 / 等审批）时，卡片的「发送」不再排在面板后面干等，
// 而是交给这里另起的后台运行时（BrowserAgentRuntime.connect({ register: false, session })）去跑。
// - 复用现有的 Runtime / Session Authority（会话认领）/ Tool Policy（createBrowserAgentTools 的 getApproval）/ 付费授权（AgentSpendMandate）；
//   不另建一套平行系统：这里只是调度 + 每个会话自己的审批队列 + 事件到显示消息的纯归约。
// - 最多同时跑 2 个；同一个会话（或同一张卡）同一时刻只跑一轮，其余排队；队列不会被排在最前面、暂时跑不了的请求卡住。
// - 审批按会话分开（A 等审批不挡 B）；付费授权 mandate 与面板共用同一份（mandateRef），上限内自动批准、用掉的额度两边都看得到。
// - 卡片上的停止只取消这一张卡的运行；刷新后：没开始的请求重新排队，跑到一半的标成「被刷新中断」（已完成的步骤在会话里）。
import type { ImageContent } from '@earendil-works/pi-ai';
import type { TurnContextDraft } from '../../services/turnContext';
import type { AgentConfirmRequest, AgentSpendMandate } from '../../services/agentSpendMandate';
import { consumeSpendMandate, evaluateSpendMandate, planBlocked } from '../../services/agentSpendMandate';
import type { AgentConfirmVerdict } from '../../services/runApproval';
import type { AgentAskRequest, AgentAskResult } from '../../services/browserAgentKernel';
import type { WorkflowAgentDisplayMessage } from '../workflow/WorkflowAgentMessages';
import type { AgentMessageReference } from './agentMessageRefs';
import { applyTextDelta, applyThinkingDelta, carryLiveState, finishThinking } from './agentStreamMessages';

export const CANVAS_RUNNER_MAX_CONCURRENT = 2;
const STORAGE_PREFIX = 'iris.canvasRunners.v1:';

export type CanvasRunnerPhase = 'queued' | 'running' | 'awaitingApproval' | 'done' | 'error' | 'cancelled' | 'interrupted';

export interface CanvasRunnerRequest {
  id: string;
  cardNodeId: string;
  /** 卡片已绑定的会话；没有表示新建一个会话。 */
  sessionId?: string;
  text: string;
  /** 卡片绑定、仍在画布上的素材（与面板 QueueDraft.references 同形）。 */
  references?: Array<{ id: string; type: 'node' | 'asset'; label: string; mediaType?: string }>;
}

export interface CanvasRunnerApproval {
  id: string;
  summary: string;
  request?: AgentConfirmRequest;
  blocked: boolean;
}

export interface CanvasRunnerState {
  request: CanvasRunnerRequest;
  phase: CanvasRunnerPhase;
  sessionId?: string;
  /** 本轮的显示消息（用户消息在第一条）。 */
  messages: WorkflowAgentDisplayMessage[];
  /** 当前待批准的一项（排在最前）+ 排队的其它项数。 */
  approval?: CanvasRunnerApproval;
  queuedApprovals: number;
  error?: string;
  startedAt?: number;
  endedAt?: number;
}

/** 运行时句柄：BrowserAgentRuntime 满足它；测试注入替身。 */
export interface CanvasRunnerRuntime {
  subscribe(listener: (event: { type: string; [key: string]: unknown }) => void): () => void;
  send(text: string, images?: ImageContent[], skill?: null, turnContext?: TurnContextDraft | null): Promise<unknown>;
  cancel(): void;
  snapshot(): Promise<unknown>;
  close(): Promise<void>;
}

export interface CanvasRunnerStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface CanvasSessionRunnerDeps {
  projectId: string;
  /** 另起一个不登记为项目活动运行时的后台运行时，并认领（打开 / 新建）会话。 */
  connect(input: {
    session: { id: string } | 'new';
    confirm: (summary: string, request?: AgentConfirmRequest) => Promise<AgentConfirmVerdict>;
    ask: (request: AgentAskRequest) => Promise<AgentAskResult>;
  }): Promise<CanvasRunnerRuntime>;
  /** 把卡片请求变成发给内核的文本 / 画面 / turn context（与面板 buildOutgoing 同口径）。 */
  prepare?(request: CanvasRunnerRequest): Promise<{ text: string; images?: ImageContent[]; turnContext?: TurnContextDraft | null }>;
  /** 内核快照 → 显示消息（面板的 displayMessages）；结束时换成带持久 entry id 的那份。 */
  toDisplay?(snapshot: unknown): WorkflowAgentDisplayMessage[];
  /** 与面板共用的付费授权（mandateRef）。enabled=false（手动确认模式）时不自动批准。 */
  mandate?: { get(): AgentSpendMandate | null; set(next: AgentSpendMandate): void; enabled(): boolean };
  /** 面板主运行时正在这个会话上跑：先排队，别去抢。 */
  isSessionBusy?(sessionId: string): boolean;
  onChange?(state: CanvasRunnerState): void;
  /** 后台运行时打开 / 新建会话后：把会话 id 写进卡片（bindAgentSessionCard）。 */
  onSession?(cardNodeId: string, sessionId: string, request: CanvasRunnerRequest): Promise<void> | void;
  /** 一轮结束（完成 / 出错 / 停止）。 */
  onFinished?(state: CanvasRunnerState): void;
  storage?: CanvasRunnerStorage | null;
  maxConcurrent?: number;
  language?: 'en' | 'zho';
  toolLabel?(name: string): string | undefined;
  toolResultText?(result: unknown): string;
  now?(): number;
}

/* ── 事件 → 显示消息（纯函数） ── */

export interface RunnerStreamCursor {
  /** 当前助手消息的流式 id：message_start 时换新。 */
  streamId: string;
  seq: number;
}

export interface RunnerEventContext {
  now: number;
  language: 'en' | 'zho';
  toolLabel?: (name: string) => string | undefined;
  toolResultText?: (result: unknown) => string;
}

function defaultResultText(result: unknown): string {
  const content = result && typeof result === 'object' ? (result as { content?: unknown }).content : undefined;
  if (Array.isArray(content)) {
    return content.map(item => (item && typeof item === 'object' && (item as { type?: string }).type === 'text' ? String((item as { text?: unknown }).text || '') : '')).filter(Boolean).join('\n');
  }
  return typeof result === 'string' ? result : '';
}

/**
 * 内核事件（pi-agent-core：message_start / message_update / tool_execution_* / error）归约成显示消息。
 * 与面板 mapKernelEvent + handleEvent 同一口径（复用 agentStreamMessages 的纯更新），不碰 React 状态。
 */
export function reduceRunnerEvent(
  messages: readonly WorkflowAgentDisplayMessage[],
  cursor: RunnerStreamCursor,
  event: { type: string; [key: string]: unknown },
  context: RunnerEventContext,
): { messages: WorkflowAgentDisplayMessage[]; cursor: RunnerStreamCursor } {
  const items = messages as WorkflowAgentDisplayMessage[];
  if (event.type === 'message_start') {
    const seq = cursor.seq + 1;
    return { messages: items, cursor: { seq, streamId: 'stream-runner-' + seq } };
  }
  if (event.type === 'message_update') {
    const update = (event as { assistantMessageEvent?: { type?: string; delta?: string } }).assistantMessageEvent;
    if (update?.type === 'text_delta' && update.delta) return { messages: applyTextDelta(items, cursor.streamId, update.delta, context.now), cursor };
    if (update?.type === 'thinking_delta' && update.delta) return { messages: applyThinkingDelta(items, cursor.streamId, update.delta, context.now), cursor };
    return { messages: items, cursor };
  }
  if (event.type === 'tool_execution_start') {
    const id = String(event.toolCallId || '');
    const name = String(event.toolName || '');
    if (items.some(item => item.id === 'tool-' + id)) return { messages: items, cursor };
    return {
      messages: [...items.map(item => finishThinking(item, context.now)), {
        id: 'tool-' + id,
        role: 'tool',
        toolName: name,
        toolCallId: id,
        args: event.args,
        detail: event.args,
        startedAt: context.now,
        title: context.toolLabel?.(name) || name,
        text: '',
        status: 'pending',
      }],
      cursor,
    };
  }
  if (event.type === 'tool_execution_end') {
    const id = 'tool-' + String(event.toolCallId || '');
    const text = (context.toolResultText || defaultResultText)(event.result);
    return {
      messages: items.map(item => (item.id === id ? { ...item, text, detail: event.result, endedAt: context.now, status: event.isError ? 'error' : 'success' } : item)),
      cursor,
    };
  }
  if (event.type === 'error') {
    const text = String(event.message || event.error || (context.language === 'en' ? 'The run failed.' : '这一轮出错了。'));
    return { messages: [...items, { id: 'runner-error-' + (cursor.seq + 1), role: 'error', text }], cursor: { ...cursor, seq: cursor.seq + 1 } };
  }
  return { messages: items, cursor };
}

/** 一轮结束：把仍在计时的思考定格，pending 的工具按「没跑完」处理（停止 / 中断）。 */
export function settleRunnerMessages(messages: readonly WorkflowAgentDisplayMessage[], now: number, outcome: 'done' | 'cancelled' | 'error'): WorkflowAgentDisplayMessage[] {
  return messages.map(item => {
    const finished = finishThinking(item, now);
    if (finished.role === 'tool' && finished.status === 'pending' && outcome !== 'done') return { ...finished, status: 'denied' as const, endedAt: finished.endedAt ?? now };
    return finished;
  });
}

/* ── 调度 ── */

interface RunnerEntry {
  state: CanvasRunnerState;
  runtime?: CanvasRunnerRuntime;
  cancelled: boolean;
  approvals: Array<CanvasRunnerApproval & { resolve: (verdict: AgentConfirmVerdict) => void }>;
  cursor: RunnerStreamCursor;
  queuedAt: number;
}

interface PersistedRunner {
  request: CanvasRunnerRequest;
  phase: CanvasRunnerPhase;
  sessionId?: string;
}

const ACTIVE: ReadonlySet<CanvasRunnerPhase> = new Set(['running', 'awaitingApproval']);

export class CanvasSessionRunners {
  private readonly entries = new Map<string, RunnerEntry>();
  private readonly max: number;
  private queueSeq = 0;
  private approvalSeq = 0;
  private disposed = false;

  constructor(private readonly deps: CanvasSessionRunnerDeps) {
    this.max = Math.max(1, deps.maxConcurrent ?? CANVAS_RUNNER_MAX_CONCURRENT);
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private get storageKey(): string {
    return STORAGE_PREFIX + this.deps.projectId;
  }

  /** 卡片当前（或最近一轮）的后台运行状态。 */
  get(cardNodeId: string): CanvasRunnerState | undefined {
    return this.entries.get(cardNodeId)?.state;
  }

  list(): CanvasRunnerState[] {
    return [...this.entries.values()].map(entry => entry.state);
  }

  /** 这张卡片有排队或运行中的后台轮次（面板据此把它的后续请求也交给后台，不去抢它的会话）。 */
  isActive(cardNodeId: string): boolean {
    const phase = this.entries.get(cardNodeId)?.state.phase;
    return phase === 'queued' || phase === 'running' || phase === 'awaitingApproval';
  }

  /** 某个会话正被后台运行（排队的不算：它还没认领会话）。 */
  isRunningSession(sessionId: string): boolean {
    return [...this.entries.values()].some(entry => ACTIVE.has(entry.state.phase) && entry.state.sessionId === sessionId);
  }

  runningCount(): number {
    return [...this.entries.values()].filter(entry => ACTIVE.has(entry.state.phase)).length;
  }

  /** 排队一轮。同一张卡已有排队 / 运行中的轮次时拒绝（卡片输入框本来就在忙时禁用）。 */
  enqueue(request: CanvasRunnerRequest): boolean {
    if (this.disposed) return false;
    if (this.isActive(request.cardNodeId)) return false;
    const entry: RunnerEntry = {
      state: { request, phase: 'queued', ...(request.sessionId ? { sessionId: request.sessionId } : {}), messages: [userMessage(request)], queuedApprovals: 0 },
      cancelled: false,
      approvals: [],
      cursor: { streamId: 'stream-runner-0', seq: 0 },
      queuedAt: ++this.queueSeq,
    };
    this.entries.set(request.cardNodeId, entry);
    this.emit(entry);
    this.persist();
    this.pump();
    return true;
  }

  /**
   * 调度：按排队顺序，能跑的就跑（运行数 < 上限、同会话 / 同卡没有在跑、面板没占着这个会话）。
   * 跑不了的跳过、留在队里，不挡后面的请求。面板空出会话时调用一次即可重新调度。
   */
  pump(): void {
    if (this.disposed) return;
    const queued = [...this.entries.values()].filter(entry => entry.state.phase === 'queued').sort((a, b) => a.queuedAt - b.queuedAt);
    for (const entry of queued) {
      if (this.runningCount() >= this.max) return;
      const sessionId = entry.state.sessionId;
      if (sessionId && (this.isRunningSession(sessionId) || this.deps.isSessionBusy?.(sessionId))) continue;
      void this.run(entry);
    }
  }

  private async run(entry: RunnerEntry): Promise<void> {
    const { request } = entry.state;
    this.update(entry, { phase: 'running', startedAt: this.now() });
    this.persist();
    let runtime: CanvasRunnerRuntime | undefined;
    let outcome: 'done' | 'error' | 'cancelled' = 'done';
    let errorText: string | undefined;
    let detach: (() => void) | undefined;
    try {
      runtime = await this.deps.connect({
        session: entry.state.sessionId ? { id: entry.state.sessionId } : 'new',
        confirm: (summary, confirmRequest) => this.confirm(entry, summary, confirmRequest),
        ask: () => Promise.resolve({
          ok: false,
          error: this.deps.language === 'en'
            ? 'This turn runs in the background on the canvas and cannot show a form. Continue with the most reasonable assumption and state it in your reply.'
            : '这一轮在画布后台运行，不能弹表单提问。请按最合理的假设继续，并在回复里说明假设。',
        }),
      });
      entry.runtime = runtime;
      if (entry.cancelled) throw new CancelledRun();
      const opened = await runtime.snapshot() as { sessionId?: string };
      const sessionId = String(opened?.sessionId || entry.state.sessionId || '');
      if (sessionId && sessionId !== entry.state.sessionId) {
        this.update(entry, { sessionId });
        this.persist();
      }
      if (sessionId) await this.deps.onSession?.(request.cardNodeId, sessionId, request);
      detach = runtime.subscribe(event => {
        if (entry.cancelled && event.type !== 'tool_execution_end') return;
        const next = reduceRunnerEvent(entry.state.messages, entry.cursor, event, {
          now: this.now(),
          language: this.deps.language || 'zho',
          ...(this.deps.toolLabel ? { toolLabel: this.deps.toolLabel } : {}),
          ...(this.deps.toolResultText ? { toolResultText: this.deps.toolResultText } : {}),
        });
        entry.cursor = next.cursor;
        if (next.messages !== entry.state.messages) this.update(entry, { messages: next.messages });
      });
      if (entry.cancelled) throw new CancelledRun();
      const prepared = this.deps.prepare ? await this.deps.prepare(request) : { text: request.text };
      if (entry.cancelled) throw new CancelledRun();
      if (prepared.turnContext) await runtime.send(prepared.text, prepared.images, null, prepared.turnContext);
      else await runtime.send(prepared.text, prepared.images, null);
      if (entry.cancelled) throw new CancelledRun();
      const snapshot = await runtime.snapshot() as { messages?: Array<{ role?: string; isError?: boolean; error?: string; stopReason?: string }> };
      const last = [...(snapshot?.messages || [])].reverse().find(item => item.role === 'assistant');
      if (last && (last.stopReason === 'error' || last.error)) { outcome = 'error'; errorText = String(last.error || ''); }
      if (this.deps.toDisplay) {
        const display = this.deps.toDisplay(snapshot);
        const turn = lastTurn(display);
        if (turn.length) this.update(entry, { messages: carryLiveState(entry.state.messages, turn) });
      }
    } catch (error) {
      if (entry.cancelled || error instanceof CancelledRun) outcome = 'cancelled';
      else { outcome = 'error'; errorText = error instanceof Error ? error.message : String(error); }
    } finally {
      detach?.();
      this.rejectApprovals(entry);
      const failure = entry.state.messages.find(item => item.role === 'error');
      if (outcome === 'done' && failure) { outcome = 'error'; errorText = failure.text; }
      const messages = settleRunnerMessages(entry.state.messages, this.now(), outcome);
      this.update(entry, {
        phase: outcome,
        messages: outcome === 'error' && errorText && !failure ? [...messages, { id: 'runner-error-final', role: 'error', text: errorText }] : messages,
        endedAt: this.now(),
        ...(errorText ? { error: errorText } : {}),
      });
      entry.runtime = undefined;
      // 关闭即释放会话认领（Session Authority），面板之后才能打开这个会话。
      if (runtime) await runtime.close().catch(() => undefined);
      this.persist();
      this.deps.onFinished?.(entry.state);
      this.pump();
    }
  }

  /** 后台运行时的确认入口：先看共用的付费授权，其余进这个会话自己的审批队列（卡片上批准 / 拒绝）。 */
  private confirm(entry: RunnerEntry, summary: string, request?: AgentConfirmRequest): Promise<AgentConfirmVerdict> {
    if (entry.cancelled || this.disposed) return Promise.resolve(false);
    const mandate = this.deps.mandate;
    const current = mandate?.get() ?? null;
    if (mandate && mandate.enabled() && current && request && evaluateSpendMandate(current, request).allow) {
      mandate.set(consumeSpendMandate(current, request));
      return Promise.resolve(true);
    }
    return new Promise<AgentConfirmVerdict>(resolve => {
      entry.approvals.push({ id: 'runner-approval-' + ++this.approvalSeq, summary, ...(request ? { request } : {}), blocked: planBlocked(request), resolve });
      this.syncApprovals(entry);
    });
  }

  private syncApprovals(entry: RunnerEntry): void {
    const head = entry.approvals[0];
    const phase: CanvasRunnerPhase = head ? 'awaitingApproval' : ACTIVE.has(entry.state.phase) ? 'running' : entry.state.phase;
    this.update(entry, {
      phase,
      queuedApprovals: Math.max(0, entry.approvals.length - 1),
      approval: head ? { id: head.id, summary: head.summary, ...(head.request ? { request: head.request } : {}), blocked: head.blocked } : undefined,
    });
    if (phase !== entry.state.phase || ACTIVE.has(phase)) this.persist();
  }

  /** 卡片上的批准 / 拒绝：只认这个会话当前最前面那一项；预算门挡住的不能批准（只能拒绝）。 */
  decide(cardNodeId: string, approvalId: string, approved: boolean): boolean {
    const entry = this.entries.get(cardNodeId);
    const head = entry?.approvals[0];
    if (!entry || !head || head.id !== approvalId) return false;
    if (approved && head.blocked) return false;
    entry.approvals.shift();
    head.resolve(approved);
    this.syncApprovals(entry);
    return true;
  }

  /** 卡片上的停止：排队的直接撤掉；运行中的取消内核这一轮并拒绝它待批的项。不影响其它会话。 */
  cancel(cardNodeId: string): boolean {
    const entry = this.entries.get(cardNodeId);
    if (!entry) return false;
    if (entry.state.phase === 'queued') {
      entry.cancelled = true;
      this.update(entry, { phase: 'cancelled', endedAt: this.now() });
      this.persist();
      this.deps.onFinished?.(entry.state);
      this.pump();
      return true;
    }
    if (!ACTIVE.has(entry.state.phase)) return false;
    entry.cancelled = true;
    this.rejectApprovals(entry);
    entry.runtime?.cancel();
    return true;
  }

  private rejectApprovals(entry: RunnerEntry): void {
    const pending = entry.approvals.splice(0);
    for (const item of pending) item.resolve(false);
    if (pending.length || entry.state.approval) this.update(entry, { approval: undefined, queuedApprovals: 0, ...(entry.state.phase === 'awaitingApproval' ? { phase: 'running' as const } : {}) });
  }

  /** 刷新后恢复：没开始的请求按原顺序重新排队；跑到一半的标成被刷新中断（内核每步落盘，已完成的步骤在会话里）。 */
  restore(): CanvasRunnerState[] {
    const saved = readPersisted(this.deps.storage, this.storageKey);
    const restored: CanvasRunnerState[] = [];
    for (const item of saved) {
      if (this.entries.has(item.request.cardNodeId)) continue;
      if (item.phase === 'queued') {
        if (this.enqueue(item.request)) restored.push(this.entries.get(item.request.cardNodeId)!.state);
        continue;
      }
      const entry: RunnerEntry = {
        state: {
          request: item.request,
          phase: 'interrupted',
          ...(item.sessionId ? { sessionId: item.sessionId } : {}),
          messages: [userMessage(item.request)],
          queuedApprovals: 0,
          error: this.deps.language === 'en' ? 'The page reloaded mid-turn; finished steps are saved in the conversation.' : '页面刷新中断了这一轮；已完成的步骤保存在会话里。',
        },
        cancelled: true,
        approvals: [],
        cursor: { streamId: 'stream-runner-0', seq: 0 },
        queuedAt: ++this.queueSeq,
      };
      this.entries.set(item.request.cardNodeId, entry);
      this.emit(entry);
      restored.push(entry.state);
    }
    this.persist();
    return restored;
  }

  /** 面板卸载：取消所有后台轮次（状态留在存储里，下次打开按刷新恢复处理）。 */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const running = [...this.entries.values()].filter(entry => ACTIVE.has(entry.state.phase));
    for (const entry of running) {
      for (const item of entry.approvals.splice(0)) item.resolve(false);
      entry.runtime?.cancel();
    }
    await Promise.all(running.map(entry => entry.runtime?.close().catch(() => undefined)));
  }

  private update(entry: RunnerEntry, patch: Partial<CanvasRunnerState>): void {
    entry.state = { ...entry.state, ...patch };
    if ('approval' in patch && patch.approval === undefined) delete entry.state.approval;
    this.emit(entry);
  }

  private emit(entry: RunnerEntry): void {
    if (!this.disposed) this.deps.onChange?.(entry.state);
  }

  private persist(): void {
    const storage = this.deps.storage;
    if (!storage || this.disposed) return;
    const items: PersistedRunner[] = [...this.entries.values()]
      .filter(entry => entry.state.phase === 'queued' || ACTIVE.has(entry.state.phase))
      .sort((a, b) => a.queuedAt - b.queuedAt)
      .map(entry => ({ request: entry.state.request, phase: entry.state.phase, ...(entry.state.sessionId ? { sessionId: entry.state.sessionId } : {}) }));
    try {
      if (items.length) storage.setItem(this.storageKey, JSON.stringify(items));
      else storage.removeItem(this.storageKey);
    } catch { /* storage may be unavailable */ }
  }
}

class CancelledRun extends Error {
  constructor() { super('cancelled'); }
}

function userMessage(request: CanvasRunnerRequest): WorkflowAgentDisplayMessage {
  return { id: 'runner-user-' + request.id, role: 'user', text: request.text, ...(request.references?.length ? { references: request.references.map((ref): AgentMessageReference => ({ id: ref.id, kind: ref.type, label: ref.label })) } : {}) };
}

/** 显示消息里最后一条用户消息起的那一轮（含用户消息）。 */
function lastTurn(messages: readonly WorkflowAgentDisplayMessage[]): WorkflowAgentDisplayMessage[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) if (messages[index].role === 'user') return messages.slice(index);
  return [];
}

function readPersisted(storage: CanvasRunnerStorage | null | undefined, key: string): PersistedRunner[] {
  if (!storage) return [];
  try {
    const parsed = JSON.parse(storage.getItem(key) || '[]');
    return Array.isArray(parsed) ? parsed.filter((item): item is PersistedRunner => Boolean(item?.request?.cardNodeId && item.request.id && typeof item.request.text === 'string')) : [];
  } catch {
    return [];
  }
}

/** 浏览器里的默认存储：sessionStorage（同一标签页刷新能恢复，关掉标签页就丢，不跨标签页抢会话）。 */
export function defaultRunnerStorage(): CanvasRunnerStorage | null {
  try { return typeof window !== 'undefined' && window.sessionStorage ? window.sessionStorage : null; } catch { return null; }
}
