// Iris Link 的回合记录：CLI 发起的每一轮（agent.send / tools.invoke --execute）在标签页里是一个 run，
// 轨迹事件从画布会话卡同一份归约（reduceAgentSessionTrace）逐条 diff 出来，按 seq 编号供 agent.trace 长轮询。
// 只记录 provider 真实返回 / 工具真实执行的内容：思考摘要只在模型给了 reasoning 时出现，token 只在 provider 上报时出现。
import { CanvasSessionRunners, type CanvasRunnerState } from '../../components/agent/canvasSessionRunners';
import { currentTurnMessages, reduceAgentSessionTrace, type AgentSessionTrace } from '../../components/workflow/agentSessionTrace';
import { useWorkflowStore } from '../../components/workflow/store';
import type { AgentConfirmRequest } from '../agentSpendMandate';
import { DELETE_REASON, SPEND_REASON } from '../agentToolPolicy';
import { onAgentLinkDecision, onAgentLinkHost, onAgentLinkRunner, type AgentLinkPanelHost } from './agentLinkHost';

export type LinkRunPhase = 'queued' | 'running' | 'awaitingApproval' | 'done' | 'error' | 'cancelled' | 'interrupted';
export const LINK_TERMINAL_PHASES: ReadonlySet<string> = new Set(['done', 'error', 'cancelled', 'interrupted']);

export interface LinkTraceEvent {
  seq: number;
  at: string;
  type: string;
  [key: string]: unknown;
}

export interface LinkApprovalView {
  approvalId: string;
  summary: string;
  kind: string;
  tier?: string;
  paid: boolean;
  destructive: boolean;
  blocked: boolean;
  /** CLI 能否处理：只有非付费、非破坏性、未受阻、不是 exec 级的确认。 */
  cliApprovable: boolean;
}

export interface LinkRun {
  runId: string;
  kind: 'agent' | 'invoke';
  projectId: string;
  prompt: string;
  canvas: boolean;
  cardNodeId: string;
  sessionId?: string;
  phase: LinkRunPhase;
  createdAt: number;
  endedAt?: number;
  clientName?: string;
  events: LinkTraceEvent[];
  seq: number;
  approval?: LinkApprovalView & { request?: AgentConfirmRequest };
  reply?: string;
  error?: string;
  result?: unknown;
  /** diff 状态 */
  seen: { steps: Map<string, string>; thinking: string; skills: Set<string>; memory: number; artifacts: Set<string>; budget: string; context: boolean; approvals: Set<string>; errors: number };
  decisions: Map<string, { approved: boolean; by: 'cli' | 'page' }>;
  /** invoke run 自己的审批等待（不经 CanvasSessionRunners）。 */
  invokeApproval?: { id: string; resolve: (approved: boolean) => void };
  /** invoke run 被取消时中止执行。 */
  abort?: AbortController;
}

const MAX_RUNS = 64;
/** 长轮询时新事件的合并窗口。 */
const LINK_TRACE_COALESCE_MS = 150;
const MAX_EVENTS = 4000;
const REPLY_MAX = 4000;

/** 确认请求 → CLI 能看到的审批信息。拿不到请求时按「不能由 CLI 处理」处理（fail closed）。 */
export function linkApprovalView(approvalId: string, summary: string, request: AgentConfirmRequest | undefined, blocked: boolean): LinkApprovalView {
  const paid = request?.kind === 'generation' || request?.reason === SPEND_REASON;
  const destructive = request?.kind === 'destructive' || request?.reason === DELETE_REASON;
  const tier = request?.tier ?? (request?.kind === 'other' ? 'write' : request ? 'exec' : undefined);
  return {
    approvalId,
    summary: String(summary || request?.reason || request?.command || '').slice(0, 600),
    kind: request?.kind ?? 'unknown',
    ...(tier ? { tier } : {}),
    paid,
    destructive,
    blocked,
    cliApprovable: Boolean(request) && !paid && !destructive && !blocked && tier !== 'exec',
  };
}

type Listener = () => void;

/**
 * 每个项目一个管理器：持有 link 发起的 run、它们的轨迹，以及一个只给非画布回合用的后台调度器
 * （CanvasSessionRunners，与画布卡同一份实现：最多并行 2 个、同会话串行、每个会话自己的审批队列）。
 */
export class AgentLinkRunManager {
  readonly runs = new Map<string, LinkRun>();
  private readonly byCard = new Map<string, string>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly idem = new Map<string, Promise<unknown>>();
  private readonly listeners = new Set<Listener>();
  private own: CanvasSessionRunners | null = null;
  private ownHost: AgentLinkPanelHost | null = null;
  private seqRun = 0;
  private readonly detach: Array<() => void> = [];

  constructor(readonly projectId: string, private readonly now: () => number = Date.now) {
    this.detach.push(onAgentLinkRunner((projectId, state) => { if (projectId === this.projectId) this.onRunnerState(state); }));
    this.detach.push(onAgentLinkDecision((projectId, decision) => {
      if (projectId !== this.projectId) return;
      const runId = this.byCard.get(decision.cardNodeId);
      const run = runId ? this.runs.get(runId) : undefined;
      if (run && !run.decisions.has(decision.approvalId)) run.decisions.set(decision.approvalId, { approved: decision.approved, by: 'page' });
    }));
    this.detach.push(onAgentLinkHost((projectId, host) => {
      if (projectId !== this.projectId || host === this.ownHost) return;
      // 面板关掉 / 换了线路：后台调度器跟着旧宿主一起结束（运行中的回合按取消处理）。
      void this.disposeRunners();
    }));
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private changed() { for (const listener of this.listeners) listener(); }

  /** 同一个幂等键只执行一次，重复调用拿同一个结果。 */
  once<T>(key: string | undefined, command: string, run: () => Promise<T>): Promise<T> {
    if (!key) return run();
    const id = command + '\u0000' + key;
    const existing = this.idem.get(id);
    if (existing) return existing as Promise<T>;
    const promise = run();
    this.idem.set(id, promise);
    promise.catch(() => this.idem.delete(id));
    while (this.idem.size > 256) {
      const oldest = this.idem.keys().next().value;
      if (oldest === undefined) break;
      this.idem.delete(oldest);
    }
    return promise;
  }

  runnersFor(host: AgentLinkPanelHost): CanvasSessionRunners {
    if (this.own && this.ownHost === host) return this.own;
    void this.disposeRunners();
    this.ownHost = host;
    this.own = new CanvasSessionRunners({
      projectId: host.projectId,
      language: host.language,
      connect: input => host.connectBackground(input),
      ...(host.prepare ? { prepare: request => host.prepare!(request) } : {}),
      ...(host.toDisplay ? { toDisplay: snapshot => host.toDisplay!(snapshot) } : {}),
      mandate: host.mandate,
      isSessionBusy: sessionId => host.isSessionBusy(sessionId) || host.canvasRunners.isRunningSession(sessionId),
      onChange: state => this.onRunnerState(state),
      onFinished: state => this.onRunnerState(state),
      storage: null,
      ...(host.toolLabel ? { toolLabel: name => host.toolLabel!(name) } : {}),
      ...(host.toolResultText ? { toolResultText: result => host.toolResultText!(result) } : {}),
    });
    return this.own;
  }

  ownRunners(): CanvasSessionRunners | null {
    return this.own;
  }

  async disposeRunners(): Promise<void> {
    const runners = this.own;
    this.own = null;
    this.ownHost = null;
    if (!runners) return;
    const active = [...this.runs.values()].filter(run => !run.canvas && run.kind === 'agent' && !LINK_TERMINAL_PHASES.has(run.phase));
    await runners.dispose();
    for (const run of active) {
      this.setPhase(run, 'interrupted');
      this.push(run, { type: 'error', message: 'Agent 面板已关闭或切换了模型线路，这一轮被中断；已完成的步骤保存在会话里。' });
      this.finish(run);
    }
  }

  createRun(input: { kind: 'agent' | 'invoke'; prompt: string; canvas: boolean; cardNodeId?: string; sessionId?: string; clientName?: string }): LinkRun {
    const runId = 'lr-' + this.now().toString(36) + '-' + (++this.seqRun).toString(36) + '-' + Math.random().toString(36).slice(2, 6);
    const run: LinkRun = {
      runId,
      kind: input.kind,
      projectId: this.projectId,
      prompt: input.prompt,
      canvas: input.canvas,
      cardNodeId: input.cardNodeId || 'link-' + runId,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      phase: 'queued',
      createdAt: this.now(),
      ...(input.clientName ? { clientName: input.clientName } : {}),
      events: [],
      seq: 0,
      seen: { steps: new Map(), thinking: '', skills: new Set(), memory: 0, artifacts: new Set(), budget: '', context: false, approvals: new Set(), errors: 0 },
      decisions: new Map(),
    };
    this.runs.set(runId, run);
    this.byCard.set(run.cardNodeId, runId);
    while (this.runs.size > MAX_RUNS) {
      const oldest = [...this.runs.values()].find(item => LINK_TERMINAL_PHASES.has(item.phase));
      if (!oldest) break;
      this.runs.delete(oldest.runId);
      this.byCard.delete(oldest.cardNodeId);
    }
    this.push(run, { type: 'phase', phase: 'queued' });
    this.changed();
    return run;
  }

  bindCard(run: LinkRun, cardNodeId: string): void {
    this.byCard.delete(run.cardNodeId);
    run.cardNodeId = cardNodeId;
    this.byCard.set(cardNodeId, run.runId);
  }

  push(run: LinkRun, event: Omit<LinkTraceEvent, 'seq' | 'at'>): void {
    run.seq += 1;
    run.events.push({ seq: run.seq, at: new Date(this.now()).toISOString(), ...event } as LinkTraceEvent);
    if (run.events.length > MAX_EVENTS) run.events.splice(0, run.events.length - MAX_EVENTS);
    this.wake(run.runId);
  }

  setPhase(run: LinkRun, phase: LinkRunPhase): void {
    if (run.phase === phase) return;
    run.phase = phase;
    this.push(run, { type: 'phase', phase });
    this.changed();
  }

  finish(run: LinkRun): void {
    run.endedAt = run.endedAt ?? this.now();
    if (run.approval) {
      this.resolveApprovalEvent(run, run.approval.approvalId);
      run.approval = undefined;
    }
    this.push(run, {
      type: 'done',
      phase: run.phase,
      ...(run.sessionId ? { sessionId: run.sessionId } : {}),
      ...(run.canvas ? { cardNodeId: run.cardNodeId } : {}),
      ...(run.error ? { error: run.error } : {}),
      ...(run.result !== undefined ? { result: run.result } : {}),
    });
    this.changed();
  }

  private wake(runId: string): void {
    const set = this.waiters.get(runId);
    if (!set) return;
    this.waiters.delete(runId);
    for (const resolve of set) resolve();
  }

  /** agent.trace 的长轮询：有 afterSeq 之后的新事件、run 结束或超时就返回。 */
  async waitForEvents(runId: string, afterSeq: number, waitMs: number): Promise<void> {
    const run = this.runs.get(runId);
    if (!run || LINK_TERMINAL_PHASES.has(run.phase) || waitMs <= 0) return;
    // 已有新事件：稍等一下把紧接着的事件合并成一批（流式思考时不让 CLI 一事件一请求）。
    if (run.seq > afterSeq) { await new Promise(resolve => setTimeout(resolve, LINK_TRACE_COALESCE_MS)); return; }
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { this.waiters.get(runId)?.delete(done); resolve(); }, Math.min(waitMs, 25_000));
      const done = () => { clearTimeout(timer); resolve(); };
      const set = this.waiters.get(runId) || new Set();
      set.add(done);
      this.waiters.set(runId, set);
    });
    if (run.seq > afterSeq && !LINK_TERMINAL_PHASES.has(run.phase)) await new Promise(resolve => setTimeout(resolve, LINK_TRACE_COALESCE_MS));
  }

  traceView(runId: string, afterSeq = 0) {
    const run = this.runs.get(runId);
    if (!run) return null;
    const events = run.events.filter(event => event.seq > afterSeq);
    const firstKept = run.events[0]?.seq ?? 1;
    return {
      runId,
      kind: run.kind,
      phase: run.phase,
      seq: run.seq,
      done: LINK_TERMINAL_PHASES.has(run.phase) && run.events[run.events.length - 1]?.type === 'done',
      ...(run.sessionId ? { sessionId: run.sessionId } : {}),
      ...(run.canvas ? { cardNodeId: run.cardNodeId } : {}),
      ...(run.approval ? { approval: publicApproval(run.approval), code: 'APPROVAL_PENDING' } : {}),
      ...(run.reply ? { reply: run.reply } : {}),
      ...(run.error ? { error: run.error } : {}),
      ...(afterSeq + 1 < firstKept ? { truncated: true } : {}),
      events,
    };
  }

  summary(run: LinkRun) {
    return {
      runId: run.runId,
      kind: run.kind,
      phase: run.phase,
      canvas: run.canvas,
      ...(run.canvas ? { cardNodeId: run.cardNodeId } : {}),
      ...(run.sessionId ? { sessionId: run.sessionId } : {}),
      prompt: run.prompt.slice(0, 200),
      createdAt: new Date(run.createdAt).toISOString(),
      ...(run.endedAt ? { endedAt: new Date(run.endedAt).toISOString() } : {}),
      ...(run.approval ? { approval: publicApproval(run.approval) } : {}),
      ...(run.clientName ? { clientName: run.clientName } : {}),
    };
  }

  /** 页面上需要用户处理的审批（非画布回合与工具调用；画布回合在卡片上批）。 */
  pendingTrayApprovals(): Array<{ run: LinkRun; approval: LinkApprovalView }> {
    return [...this.runs.values()].filter(run => run.approval && !run.canvas).map(run => ({ run, approval: publicApproval(run.approval!) }));
  }

  private resolveApprovalEvent(run: LinkRun, approvalId: string): void {
    if (!run.seen.approvals.has(approvalId)) return;
    run.seen.approvals.delete(approvalId);
    const decision = run.decisions.get(approvalId);
    this.push(run, { type: 'approval.resolved', approvalId, approved: decision ? decision.approved : null, by: decision?.by ?? 'page' });
  }

  setApproval(run: LinkRun, approval: (LinkApprovalView & { request?: AgentConfirmRequest }) | undefined): void {
    const current = run.approval?.approvalId;
    if (current && current !== approval?.approvalId) this.resolveApprovalEvent(run, current);
    run.approval = approval;
    if (approval && !run.seen.approvals.has(approval.approvalId)) {
      run.seen.approvals.add(approval.approvalId);
      this.push(run, { type: 'approval.pending', ...publicApproval(approval) });
    }
    this.changed();
  }

  /** 画布会话卡调度器（面板的或自己的）状态 → run 轨迹。 */
  onRunnerState(state: CanvasRunnerState): void {
    const runId = this.byCard.get(state.request.cardNodeId);
    const run = runId ? this.runs.get(runId) : undefined;
    if (!run || run.kind !== 'agent') return;
    if (LINK_TERMINAL_PHASES.has(run.phase) && run.events[run.events.length - 1]?.type === 'done') return;
    if (state.sessionId && state.sessionId !== run.sessionId) run.sessionId = state.sessionId;
    const phase = state.phase as LinkRunPhase;
    // 审批先于 phase：让 CLI 看到 awaitingApproval 时 approval.pending 已在轨迹里。
    this.setApproval(run, state.approval ? { ...linkApprovalView(state.approval.id, state.approval.summary, state.approval.request, state.approval.blocked), ...(state.approval.request ? { request: state.approval.request } : {}) } : undefined);
    this.recordMessages(run, state);
    if (phase !== run.phase) this.setPhase(run, phase);
    if (LINK_TERMINAL_PHASES.has(phase)) {
      if (state.error && phase === 'error') run.error = state.error;
      this.finish(run);
    }
  }

  private recordMessages(run: LinkRun, state: CanvasRunnerState): void {
    const { prompt, after } = currentTurnMessages(state.messages);
    const running = !LINK_TERMINAL_PHASES.has(state.phase);
    const nodes = useWorkflowStore.getState().projects.find(project => project.id === this.projectId)?.nodes || [];
    let trace: AgentSessionTrace;
    try {
      trace = reduceAgentSessionTrace(after, { running, nodes, language: 'zho', now: this.now(), ...(prompt ? { prompt } : {}) });
    } catch {
      return;
    }
    const seen = run.seen;
    if (!seen.context && trace.context.length) {
      seen.context = true;
      this.push(run, { type: 'context', items: trace.context.map(item => ({ kind: item.kind, ...(item.id ? { id: item.id } : {}), label: item.label })) });
    }
    // 思考摘要只在一句话说完（句末标点）或这段思考结束时发一次，不按流式 delta 逐字刷屏。
    const sentenceDone = /[。！？!?；;.…]$/.test(trace.thinking.summary);
    if (trace.thinking.present && trace.thinking.summary && trace.thinking.summary !== seen.thinking && (sentenceDone || !trace.thinking.active || !running)) {
      seen.thinking = trace.thinking.summary;
      this.push(run, { type: 'thinking', summary: trace.thinking.summary, active: trace.thinking.active, ...(trace.thinking.ms ? { ms: trace.thinking.ms } : {}) });
    }
    for (const step of trace.steps) {
      const key = step.toolCallId || step.id;
      const previous = seen.steps.get(key);
      if (previous === undefined) {
        this.push(run, { type: 'tool.start', toolCallId: key, tool: step.toolName, label: step.label, kind: step.kind, ...(step.target ? { target: step.target } : {}) });
        seen.steps.set(key, 'running');
      }
      const terminal = step.status === 'success' || step.status === 'error' || step.status === 'denied';
      if (terminal && seen.steps.get(key) !== step.status) {
        seen.steps.set(key, step.status);
        this.push(run, { type: 'tool.end', toolCallId: key, tool: step.toolName, status: step.status, ...(step.ms !== undefined ? { ms: step.ms } : {}), ...(step.error ? { error: step.error } : {}), ...(step.conflict ? { conflict: true } : {}) });
      }
    }
    for (const skill of trace.skills) {
      if (seen.skills.has(skill.id)) continue;
      seen.skills.add(skill.id);
      this.push(run, { type: 'skill', id: skill.id });
    }
    if (trace.memory.count > seen.memory) {
      seen.memory = trace.memory.count;
      this.push(run, { type: 'memory', count: trace.memory.count, titles: trace.memory.titles.slice(0, 12) });
    }
    for (const artifact of trace.artifacts) {
      if (seen.artifacts.has(artifact.nodeId)) continue;
      seen.artifacts.add(artifact.nodeId);
      this.push(run, { type: 'artifact', nodeId: artifact.nodeId, label: artifact.label, ...(artifact.type ? { nodeType: artifact.type } : {}) });
    }
    // Budget：token 只在 provider 上报时有；付费次数按 session-budget 的口径。
    const budget = { ...(trace.budget.tokens ? { tokens: trace.budget.tokens } : {}), paidRuns: trace.budget.paidRuns };
    const budgetKey = JSON.stringify(budget);
    if ((trace.budget.tokens || trace.budget.paidRuns > 0) && budgetKey !== seen.budget) {
      seen.budget = budgetKey;
      this.push(run, { type: 'budget', ...budget });
    }
    const errors = after.filter(message => message.role === 'error');
    for (const message of errors.slice(seen.errors)) this.push(run, { type: 'error', message: String(message.text || '').slice(0, 600) });
    seen.errors = errors.length;
    if (!running) {
      const reply = [...after].reverse().find(message => message.role === 'assistant' && message.text && message.text.trim());
      if (reply && !run.reply) {
        run.reply = reply.text.slice(0, REPLY_MAX);
        this.push(run, { type: 'text', excerpt: run.reply, ...(reply.text.length > REPLY_MAX ? { truncated: true } : {}) });
      }
    }
  }

  dispose(): void {
    for (const off of this.detach.splice(0)) off();
    void this.disposeRunners();
  }
}

export function publicApproval(approval: LinkApprovalView & { request?: AgentConfirmRequest }): LinkApprovalView {
  const { request: _request, ...view } = approval;
  return view;
}

/* ── 每个项目一个管理器 ── */

const managers = new Map<string, AgentLinkRunManager>();
const trayListeners = new Set<Listener>();
let trayVersion = 0;

export function agentLinkRunManager(projectId: string): AgentLinkRunManager {
  let manager = managers.get(projectId);
  if (!manager) {
    manager = new AgentLinkRunManager(projectId);
    manager.subscribe(() => { trayVersion += 1; for (const listener of trayListeners) listener(); });
    managers.set(projectId, manager);
  }
  return manager;
}

export function findLinkRun(runId: string): { manager: AgentLinkRunManager; run: LinkRun } | null {
  for (const manager of managers.values()) {
    const run = manager.runs.get(runId);
    if (run) return { manager, run };
  }
  return null;
}

export function allLinkManagers(): AgentLinkRunManager[] {
  return [...managers.values()];
}

/** 审批托盘（useSyncExternalStore）。 */
export function subscribeLinkTray(listener: Listener): () => void {
  trayListeners.add(listener);
  return () => trayListeners.delete(listener);
}
export function linkTrayVersion(): number {
  return trayVersion;
}

export function resetAgentLinkRunsForTests(): void {
  for (const manager of managers.values()) manager.dispose();
  managers.clear();
  trayListeners.clear();
  trayVersion = 0;
}
