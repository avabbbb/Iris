// 标签页里的 Iris Link 命令处理器：本机 loopback（workflowAgentBridge 的 tool_call）与线上中继（webLinkHost 的 WebSocket）
// 进来的 link 命令都到这里，返回同一个形状 { ok, data } / { ok:false, error }。
// 全部复用现有系统：回合由面板登记的后台运行时跑（Session Authority / Tool Policy / Spend Mandate 不变），
// 工具调用走 createBrowserAgentTools 的同一个审批层与浏览器契约；付费 / 删除的确认永远只能由用户在页面上批准。
import { Validator } from '@cfworker/json-schema';
import {
  LINK_CHUNKED_RESULT_THRESHOLD,
  LINK_ERROR,
  LINK_MAX_MEDIA_BYTES,
  LINK_PROTOCOL_VERSION,
  isLinkCommand,
  linkCommandNeedsIdempotency,
  missingLinkScope,
  utf8Length,
} from '../../tools/iris/link/protocol.js';
import { useWorkflowStore } from '../../components/workflow/store';
import { createAgentSessionCard, selectionBounds } from '../../components/workflow/agentSessionCard';
import { workflowCommandSummary } from '../../components/workflow/agentOps';
import { buildWorkflowExportPayload, planWorkflowExport, WorkflowExportError } from '../../components/workflow/nodeExport';
import { readApprovalMode, readUserToolPolicy, resolveToolApproval, toolApprovalFor, type ApprovalContext } from '../agentToolPolicy';
import { createBrowserAgentTools } from '../browserAgentKernel';
import { consumeSpendMandate, evaluateSpendMandate, planBlocked, type AgentConfirmRequest } from '../agentSpendMandate';
import { workflowConfirmRequest } from '../workflowAgentBridge';
import {
  browserImportMediaBlob,
  dispatchWorkflowCommand,
  dispatchWorkflowMediaImportBlob,
  getBrowserProviderStatusSummary,
  withWorkflowHumanApproval,
  WORKFLOW_READ_COMMANDS,
  type WorkflowCommandEnvelope,
  type WorkflowCommandResult,
} from '../workflowDispatcher';
import { getAgentLinkHost, type AgentLinkPanelHost } from './agentLinkHost';
import { agentLinkRunManager, findLinkRun, LINK_TERMINAL_PHASES, linkApprovalView, type AgentLinkRunManager, type LinkRun } from './agentLinkRuns';
import {
  appendMediaUploadChunk,
  finalizeMediaUpload,
  MediaTransferError,
  readDownloadChunk,
  registerDownloadBuffer,
  startMediaUpload,
} from './mediaTransfer';

export interface AgentLinkCommandContext {
  /** 这次调用被授予的范围（线上：标签页自己保存的配对记录；本机：可信 CLI 的全部非付费范围）。 */
  scopes: readonly string[];
  idempotencyKey?: string;
  source: 'local' | 'web';
  clientName?: string;
}

export type AgentLinkCommandResult =
  | { ok: true; data: unknown }
  | { ok: false; error: { code: string; message: string; retryable?: boolean; details?: unknown } };

export const LOCAL_LINK_SCOPES = Object.freeze(['agent.read', 'agent.run', 'agent.approve', 'tools.invoke']);

class LinkCommandError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false, readonly details?: unknown) {
    super(message);
  }
}

const fail = (code: string, message: string, retryable = false, details?: unknown): never => {
  throw new LinkCommandError(code, message, retryable, details);
};

function activeProjectId(args: Record<string, unknown>): string {
  const state = useWorkflowStore.getState();
  const projectId = typeof args.projectId === 'string' && args.projectId ? args.projectId : state.activeProjectId;
  if (!projectId || !state.projects.some(project => project.id === projectId)) fail('WORKSPACE_UNAVAILABLE', '这个标签页没有打开的画布项目。');
  return projectId as string;
}

function requireHost(projectId: string): AgentLinkPanelHost {
  const host = getAgentLinkHost(projectId);
  if (!host) fail(LINK_ERROR.AGENT_PANEL_CLOSED, '内置 Agent 没有就绪：在 Iris 画布右侧打开 Agent 对话面板，并配好文本模型后重试。', true);
  return host as AgentLinkPanelHost;
}

function requireRun(args: Record<string, unknown>): { manager: AgentLinkRunManager; run: LinkRun } {
  const runId = String(args.runId || '');
  const found = runId ? findLinkRun(runId) : null;
  if (!found) fail(LINK_ERROR.UNKNOWN_RUN, `没有这个 run：${runId || '(空)'}（标签页刷新后 run 记录会清空）。`);
  return found as { manager: AgentLinkRunManager; run: LinkRun };
}

function approvalContext(host: AgentLinkPanelHost | null): ApprovalContext {
  return host ? host.approval() : { mode: readApprovalMode(), userPolicy: readUserToolPolicy() };
}

/* ── 命令 ── */

function linkStatus(ctx: AgentLinkCommandContext) {
  const state = useWorkflowStore.getState();
  const project = state.projects.find(item => item.id === state.activeProjectId) || null;
  const host = getAgentLinkHost(project?.id);
  return {
    protocolVersion: LINK_PROTOCOL_VERSION,
    source: ctx.source,
    grant: { scopes: [...ctx.scopes], ...(ctx.clientName ? { clientName: ctx.clientName } : {}) },
    tab: { projectId: project?.id ?? null, projectTitle: project?.title ?? null, nodes: project?.nodes.length ?? 0 },
    agent: host
      ? { ready: true, model: host.model(), approvalMode: host.approval().mode }
      : { ready: false, model: null, hint: '在 Iris 画布右侧打开 Agent 对话面板，并配好文本模型。' },
  };
}

async function sessions(args: Record<string, unknown>) {
  const projectId = activeProjectId(args);
  const host = requireHost(projectId);
  const manager = agentLinkRunManager(projectId);
  const own = manager.ownRunners();
  const list = await host.listSessions();
  const runs = [...manager.runs.values()];
  return {
    projectId,
    sessions: list.map(item => {
      const running = host.isSessionBusy(item.id) || host.canvasRunners.isRunningSession(item.id) || Boolean(own?.isRunningSession(item.id));
      const run = runs.filter(entry => entry.sessionId === item.id).sort((a, b) => b.createdAt - a.createdAt)[0];
      return { id: item.id, title: item.title, updatedAt: item.updatedAt, running, ...(run ? { lastRunId: run.runId } : {}) };
    }),
    runs: runs.sort((a, b) => b.createdAt - a.createdAt).map(run => manager.summary(run)),
  };
}

async function send(args: Record<string, unknown>, ctx: AgentLinkCommandContext) {
  const prompt = String(args.prompt || '').trim();
  if (!prompt) fail(LINK_ERROR.INVALID_ARGUMENT, 'agent.send 需要 prompt。');
  if (prompt.length > 20_000) fail(LINK_ERROR.INVALID_ARGUMENT, 'prompt 太长（上限 20000 字符）。');
  const projectId = activeProjectId(args);
  const host = requireHost(projectId);
  const manager = agentLinkRunManager(projectId);
  const sessionId = typeof args.sessionId === 'string' && args.sessionId ? args.sessionId : undefined;
  const canvas = args.canvas === true;
  return manager.once(ctx.idempotencyKey, 'agent.send', async () => {
    if (sessionId) {
      const known = await host.listSessions();
      if (!known.some(item => item.id === sessionId)) fail(LINK_ERROR.INVALID_ARGUMENT, `这个项目里没有会话 ${sessionId}；用 agent.sessions 查看。`);
    }
    const run = manager.createRun({ kind: 'agent', prompt, canvas, ...(sessionId ? { sessionId } : {}), ...(ctx.clientName ? { clientName: ctx.clientName } : {}) });
    if (canvas) {
      // 画布会话卡：放在现有内容右侧的空位；同一个幂等键只建一张卡（createAgentSessionCard 的 requestId 幂等）。
      const project = useWorkflowStore.getState().projects.find(item => item.id === projectId)!;
      const bounds = selectionBounds(project.nodes);
      const anchor = bounds ? { x: bounds.x + bounds.width + 48, y: bounds.y, width: 1, height: 1 } : { x: 120, y: 120, width: 1, height: 1 };
      const card = await createAgentSessionCard({ projectId, requestId: 'cli-' + (ctx.idempotencyKey || run.runId), origin: 'ask', anchor, prompt });
      if (card.ok === false) {
        run.error = card.error;
        manager.setPhase(run, 'error');
        manager.finish(run);
        fail('CANVAS_CARD_FAILED', card.error);
      }
      const cardNodeId = (card as { nodeId: string }).nodeId;
      manager.bindCard(run, cardNodeId);
      // 卡片已绑定会话时沿用它（同一张卡继续聊）。
      const meta = useWorkflowStore.getState().projects.find(item => item.id === projectId)?.nodes.find(node => node.id === cardNodeId)?.metadata.agentSession;
      const cardSession = sessionId || meta?.sessionId;
      if (cardSession) run.sessionId = cardSession;
      const queued = host.canvasRunners.enqueue({ id: run.runId, cardNodeId, ...(cardSession ? { sessionId: cardSession } : {}), text: prompt, references: [] });
      if (!queued) {
        run.error = '这张会话卡正在运行，等它结束后再发。';
        manager.setPhase(run, 'error');
        manager.finish(run);
        fail('AGENT_BUSY', run.error, true);
      }
    } else {
      const queued = manager.runnersFor(host).enqueue({ id: run.runId, cardNodeId: run.cardNodeId, ...(sessionId ? { sessionId } : {}), text: prompt });
      if (!queued) fail('AGENT_BUSY', '无法排队这一轮。', true);
    }
    return { runId: run.runId, phase: run.phase, canvas, ...(run.sessionId ? { sessionId: run.sessionId } : {}), ...(canvas ? { cardNodeId: run.cardNodeId } : {}) };
  });
}

async function trace(args: Record<string, unknown>) {
  const { manager, run } = requireRun(args);
  const afterSeq = Math.max(0, Number(args.afterSeq) || 0);
  const waitMs = Math.max(0, Math.min(25_000, Number(args.waitMs) || 0));
  await manager.waitForEvents(run.runId, afterSeq, waitMs);
  return manager.traceView(run.runId, afterSeq);
}

function decide(args: Record<string, unknown>, ctx: AgentLinkCommandContext, approved: boolean) {
  const { manager, run } = requireRun(args);
  return manager.once(ctx.idempotencyKey, approved ? 'agent.approve' : 'agent.deny', async () => {
    const pending = run.approval;
    if (!pending || LINK_TERMINAL_PHASES.has(run.phase)) fail('NO_PENDING_APPROVAL', `run ${run.runId} 当前没有待审批项。`);
    const approvalId = typeof args.approvalId === 'string' && args.approvalId ? args.approvalId : pending!.approvalId;
    if (approvalId !== pending!.approvalId) fail('APPROVAL_CHANGED', `待审批项已经变了（当前是 ${pending!.approvalId}）；先 agent.trace 看最新的一项。`, true, { approvalId: pending!.approvalId });
    if (approved) {
      // CLI 永远不能批准付费 / 破坏性 / 被预算门挡住的项；非付费确认也要配对时授予了 agent.approve。
      if (!pending!.cliApprovable) {
        fail(LINK_ERROR.APPROVAL_REQUIRES_USER, pending!.paid
          ? '这一步会产生费用，只能由你在 Iris 页面上批准（CLI 不能批准付费操作）。'
          : pending!.destructive ? '这一步会删除内容，只能在 Iris 页面上批准。' : pending!.blocked ? '这一步被预算 / 提交前检查挡住了，不能批准。' : '这一步只能在 Iris 页面上批准。', false, { approval: { approvalId, paid: pending!.paid, destructive: pending!.destructive, blocked: pending!.blocked } });
      }
      if (!ctx.scopes.includes('agent.approve')) fail(LINK_ERROR.SCOPE_DENIED, '配对时没有授予 agent.approve；在页面上批准，或重新 iris login web --scopes agent.read,agent.run,agent.approve。');
    }
    run.decisions.set(approvalId, { approved, by: 'cli' });
    let ok = false;
    if (run.kind === 'invoke') {
      if (run.invokeApproval && run.invokeApproval.id === approvalId) {
        const pendingInvoke = run.invokeApproval;
        run.invokeApproval = undefined;
        pendingInvoke.resolve(approved);
        ok = true;
      }
    } else if (run.canvas) {
      ok = getAgentLinkHost(run.projectId)?.canvasRunners.decide(run.cardNodeId, approvalId, approved) ?? false;
    } else {
      ok = manager.ownRunners()?.decide(run.cardNodeId, approvalId, approved) ?? false;
    }
    if (!ok) { run.decisions.delete(approvalId); fail('APPROVAL_CHANGED', '待审批项已经被处理（可能在页面上）；agent.trace 查看结果。', true); }
    return { runId: run.runId, approvalId, decision: approved ? 'approved' : 'denied' };
  });
}

function cancel(args: Record<string, unknown>, ctx: AgentLinkCommandContext) {
  const { manager, run } = requireRun(args);
  return manager.once(ctx.idempotencyKey, 'agent.cancel', async () => {
    if (LINK_TERMINAL_PHASES.has(run.phase)) return { runId: run.runId, cancelled: false, phase: run.phase };
    let ok = false;
    if (run.kind === 'invoke') {
      run.abort?.abort();
      if (run.invokeApproval) { const pending = run.invokeApproval; run.invokeApproval = undefined; pending.resolve(false); }
      ok = true;
    } else if (run.canvas) ok = getAgentLinkHost(run.projectId)?.canvasRunners.cancel(run.cardNodeId) ?? false;
    else ok = manager.ownRunners()?.cancel(run.cardNodeId) ?? false;
    return { runId: run.runId, cancelled: ok, phase: run.phase };
  });
}

/* ── 工具 ── */

function toolPolicyKey(tool: { name: string; label: string }): string {
  // 命令面工具的 label 就是命令（workflow.*）；其它工具按工具名进策略（与 guard 一致）。
  return /^[a-z]+\.[a-z.]+$/.test(tool.label) && (tool.label.startsWith('workflow.') || tool.label.startsWith('agent.')) ? tool.label : tool.name;
}

function linkTools(projectId: string, confirm: (summary: string, request?: AgentConfirmRequest) => Promise<boolean>, approval: () => ApprovalContext, changeSetId: string) {
  return createBrowserAgentTools({
    projectId,
    confirm,
    activeChangeSetId: changeSetId,
    getNodes: () => useWorkflowStore.getState().projects.find(project => project.id === projectId)?.nodes || [],
    getApproval: approval,
  });
}

function toolsList(args: Record<string, unknown>) {
  const projectId = activeProjectId(args);
  const host = getAgentLinkHost(projectId);
  const context = approvalContext(host);
  const tools = linkTools(projectId, async () => false, () => context, '');
  return {
    projectId,
    approvalMode: context.mode,
    tools: tools.map(tool => {
      const key = toolPolicyKey(tool);
      const decision = toolApprovalFor(key, {});
      const resolution = resolveToolApproval({ ...context, tool: key, decision });
      return {
        name: tool.name,
        command: key === tool.name ? null : key,
        description: String(tool.description || '').slice(0, 400),
        tier: decision.tier,
        policy: resolution.action,
        ...(decision.hardGate ? { hardGate: decision.hardGate } : {}),
        ...(resolution.action !== 'allow' && 'reason' in resolution && resolution.reason ? { reason: resolution.reason } : {}),
      };
    }),
  };
}

function toolsInvoke(args: Record<string, unknown>, ctx: AgentLinkCommandContext) {
  const projectId = activeProjectId(args);
  const host = getAgentLinkHost(projectId);
  const context = approvalContext(host);
  const name = String(args.tool || '');
  const toolArgs = args.args && typeof args.args === 'object' && !Array.isArray(args.args) ? args.args as Record<string, unknown> : {};
  const manager = agentLinkRunManager(projectId);
  const probe = linkTools(projectId, async () => false, () => context, '');
  const tool = probe.find(item => item.name === name || item.label === name);
  if (!tool) fail(LINK_ERROR.INVALID_ARGUMENT, `没有这个工具：${name}；用 agent.tools.list 查看。`);
  const key = toolPolicyKey(tool!);
  const decision = toolApprovalFor(key, toolArgs);
  const resolution = resolveToolApproval({ ...context, tool: key, decision });
  const validation = new Validator(JSON.parse(JSON.stringify(tool!.parameters)) as object, '2020-12', false).validate(toolArgs);
  const check = {
    tool: tool!.name,
    command: key === tool!.name ? null : key,
    tier: decision.tier,
    policy: resolution.action,
    ...(decision.hardGate ? { hardGate: decision.hardGate } : {}),
    ...('reason' in resolution && resolution.reason ? { reason: resolution.reason } : {}),
    paid: decision.hardGate === 'spend',
    valid: validation.valid,
    ...(validation.valid ? {} : { validationErrors: validation.errors.slice(0, 8).map(item => `${item.instanceLocation} ${item.error}`) }),
  };
  if (args.execute !== true) return Promise.resolve({ mode: 'dry-run', ...check, note: check.policy === 'deny' ? '当前 Tool Policy 会拒绝这次调用。' : check.policy === 'prompt' ? '执行时需要审批：付费 / 删除只能在页面上批准。' : '执行时会直接放行。' });
  if (!validation.valid) fail(LINK_ERROR.INVALID_ARGUMENT, '参数不符合工具 schema。', false, check);
  if (resolution.action === 'deny') fail('POLICY_DENIED', 'reason' in resolution ? resolution.reason : 'Tool Policy 拒绝了这次调用。', false, check);
  return manager.once(ctx.idempotencyKey, 'agent.tools.invoke', async () => {
    const run = manager.createRun({ kind: 'invoke', prompt: `${tool!.name} ${JSON.stringify(toolArgs).slice(0, 160)}`, canvas: false, ...(ctx.clientName ? { clientName: ctx.clientName } : {}) });
    run.abort = new AbortController();
    let approvalSeq = 0;
    // 与回合同一个审批语义：先看共用的付费授权，其余进这个 run 的审批（页面托盘批准；非付费的 CLI 可按 scope 批准）。
    const confirm = (summary: string, request?: AgentConfirmRequest): Promise<boolean> => {
      if (run.abort?.signal.aborted) return Promise.resolve(false);
      const mandate = getAgentLinkHost(projectId)?.mandate;
      const current = mandate?.get() ?? null;
      if (mandate && mandate.enabled() && current && request && evaluateSpendMandate(current, request).allow) {
        mandate.set(consumeSpendMandate(current, request));
        manager.push(run, { type: 'approval.auto', reason: 'spend-mandate', command: request.command });
        return Promise.resolve(true);
      }
      return new Promise<boolean>(resolve => {
        const id = run.runId + '-ap' + ++approvalSeq;
        run.invokeApproval = { id, resolve: approved => { manager.setApproval(run, undefined); manager.setPhase(run, 'running'); resolve(approved); } };
        manager.setApproval(run, { ...linkApprovalView(id, summary, request, false), ...(request ? { request } : {}) });
        manager.setPhase(run, 'awaitingApproval');
      });
    };
    const tools = linkTools(projectId, confirm, () => approvalContext(getAgentLinkHost(projectId)), String(ctx.idempotencyKey || run.runId));
    const live = tools.find(item => item.name === tool!.name)!;
    manager.setPhase(run, 'running');
    const toolCallId = 'invoke-' + run.runId;
    manager.push(run, { type: 'tool.start', toolCallId, tool: live.name, label: live.label, kind: 'tool' });
    const startedAt = Date.now();
    void live.execute(toolCallId, toolArgs as never, run.abort.signal)
      .then(result => {
        const details = (result as { details?: unknown }).details;
        const isError = Boolean(details && typeof details === 'object' && (details as { isError?: boolean }).isError);
        manager.push(run, { type: 'tool.end', toolCallId, tool: live.name, status: isError ? 'error' : 'success', ms: Date.now() - startedAt });
        run.result = compactResult(result);
        manager.setPhase(run, run.abort?.signal.aborted ? 'cancelled' : isError ? 'error' : 'done');
      })
      .catch(error => {
        const message = error instanceof Error ? error.message : String(error);
        manager.push(run, { type: 'tool.end', toolCallId, tool: live.name, status: run.abort?.signal.aborted ? 'denied' : 'error', ms: Date.now() - startedAt, error: message.slice(0, 300) });
        run.error = message.slice(0, 600);
        manager.setPhase(run, run.abort?.signal.aborted ? 'cancelled' : 'error');
      })
      .finally(() => manager.finish(run));
    return { mode: 'execute', ...check, runId: run.runId, phase: run.phase };
  });
}

/** 工具结果给 CLI：只回文字内容与结构化 details 的前 64KB，媒体 data URL 不回传。 */
function compactResult(result: unknown): unknown {
  const value = result as { content?: Array<{ type?: string; text?: string }>; details?: unknown };
  const text = (value?.content || []).filter(item => item?.type === 'text').map(item => String(item.text || '')).join('\n');
  let details: unknown = value?.details;
  try {
    const raw = JSON.stringify(details, (_key, item) => (typeof item === 'string' && item.startsWith('data:') ? '[media omitted]' : item));
    details = raw && raw.length > 64_000 ? { truncated: true, preview: raw.slice(0, 64_000) } : raw ? JSON.parse(raw) : undefined;
  } catch {
    details = undefined;
  }
  return { text: text.slice(0, 64_000), ...(details !== undefined ? { details } : {}) };
}

/* ── 直接画布操作 & 无 S3/R2 分片直传 ── */

const LONG_EXEC_COMMANDS = new Set([
  'workflow.node.run',
  'workflow.group.run',
  'workflow.generate',
  'workflow.shortcut.apply',
  'workflow.node.tool',
  'workflow.image.tool',
  'workflow.video.tool',
  'workflow.audio.tool',
]);

const PROJECT_LESS_COMMANDS = new Set([
  'workflow.project.list',
  'workflow.project.create',
  'workflow.models.list',
  'workflow.shortcut.list',
  'workflow.node.tool.list',
]);

/** 响应 JSON 超过 180 KiB 时自动存入内存下载缓冲并分片回传，避免大图 inspect 触发 FRAME_TOO_LARGE。 */
async function packLinkData(value: unknown): Promise<unknown> {
  const serialized = JSON.stringify(value);
  if (utf8Length(serialized) <= LINK_CHUNKED_RESULT_THRESHOLD) return value;
  const encoded = new TextEncoder().encode(serialized);
  const buffer = await registerDownloadBuffer({
    data: encoded,
    fileName: 'response.json',
    mimeType: 'application/json',
  });
  return { chunked: true, ...buffer };
}

function resolveOptionalProjectId(args: Record<string, unknown>, commandArgs: Record<string, unknown>, command: string): string | undefined {
  const state = useWorkflowStore.getState();
  const explicit = String(args.projectId || commandArgs.projectId || '').trim();
  const projectId = explicit || state.activeProjectId || '';
  if (PROJECT_LESS_COMMANDS.has(command)) return projectId || undefined;
  if (!projectId || !state.projects.some(project => project.id === projectId)) {
    fail('WORKSPACE_UNAVAILABLE', '这个标签页没有打开的画布项目。');
  }
  return projectId;
}

async function workflowRead(args: Record<string, unknown>, ctx: AgentLinkCommandContext) {
  const command = String(args.command || '').trim();
  if (command === 'provider.status') return getBrowserProviderStatusSummary();
  if (!WORKFLOW_READ_COMMANDS.has(command)) {
    fail(LINK_ERROR.SCOPE_DENIED, `workflow.read 只允许只读命令，不能执行：${command || '(空)'}。`);
  }
  const commandArgs = args.args && typeof args.args === 'object' && !Array.isArray(args.args)
    ? { ...(args.args as Record<string, unknown>) }
    : {};
  const projectId = resolveOptionalProjectId(args, commandArgs, command);
  const envelope: WorkflowCommandEnvelope = {
    id: crypto.randomUUID(),
    command,
    args: {
      ...commandArgs,
      ...(projectId ? { projectId } : {}),
      workspaceMode: 'browser',
    },
    source: ctx.source === 'local' ? 'cli' : 'agent',
  };
  const result = await dispatchWorkflowCommand(envelope);
  return packLinkData(result);
}

function startApprovalGatedWorkflowRun(
  managerKey: string,
  command: string,
  envelope: WorkflowCommandEnvelope,
  summary: string,
  confirmRequest: AgentConfirmRequest,
  ctx: AgentLinkCommandContext,
  executeFn: (approvedEnvelope: WorkflowCommandEnvelope) => Promise<WorkflowCommandResult>,
  requireApprovalFirst: boolean,
) {
  const manager = agentLinkRunManager(managerKey);
  return manager.once(ctx.idempotencyKey, 'workflow.exec', async () => {
    const run = manager.createRun({
      kind: 'invoke',
      prompt: `${command} ${JSON.stringify(envelope.args).slice(0, 160)}`,
      canvas: false,
      ...(ctx.clientName ? { clientName: ctx.clientName } : {}),
    });
    run.abort = new AbortController();
    let approvalSeq = 0;

    const requestApproval = (promptSummary: string, request: AgentConfirmRequest): Promise<boolean> => {
      if (run.abort?.signal.aborted) return Promise.resolve(false);
      const mandate = getAgentLinkHost(managerKey)?.mandate;
      const current = mandate?.get() ?? null;
      if (mandate && mandate.enabled() && current && evaluateSpendMandate(current, request).allow) {
        mandate.set(consumeSpendMandate(current, request));
        manager.push(run, { type: 'approval.auto', reason: 'spend-mandate', command: request.command });
        return Promise.resolve(true);
      }
      return new Promise<boolean>(resolve => {
        const id = run.runId + '-ap' + ++approvalSeq;
        run.invokeApproval = {
          id,
          resolve: approved => {
            manager.setApproval(run, undefined);
            manager.setPhase(run, 'running');
            resolve(approved);
          },
        };
        const blocked = planBlocked(request);
        manager.setApproval(run, { ...linkApprovalView(id, promptSummary, request, blocked), request });
        manager.setPhase(run, 'awaitingApproval');
      });
    };

    const toolCallId = 'exec-' + run.runId;
    manager.setPhase(run, 'running');
    manager.push(run, { type: 'tool.start', toolCallId, tool: command, label: command, kind: 'tool' });
    const startedAt = Date.now();

    void (async () => {
      let humanApproved = false;
      if (requireApprovalFirst) {
        const approved = await requestApproval(summary, confirmRequest);
        if (!approved) throw new Error(run.abort?.signal.aborted ? '用户取消了操作。' : '用户拒绝了操作。');
        humanApproved = true;
      }
      let result = await executeFn(humanApproved ? withWorkflowHumanApproval(envelope) : envelope);
      if (result.confirmation?.required) {
        const approved = await requestApproval(result.confirmation.summary || summary, confirmRequest);
        if (!approved) throw new Error(run.abort?.signal.aborted ? '用户取消了操作。' : '用户拒绝了操作。');
        result = await executeFn(withWorkflowHumanApproval(envelope));
      }
      const packed = await packLinkData(result);
      const isError = result.ok === false;
      manager.push(run, {
        type: 'tool.end',
        toolCallId,
        tool: command,
        status: isError ? 'error' : 'success',
        ms: Date.now() - startedAt,
        ...(isError && result.error?.message ? { error: result.error.message.slice(0, 300) } : {}),
      });
      run.result = packed;
      if (isError && result.error?.message) run.error = result.error.message.slice(0, 600);
      manager.setPhase(run, run.abort?.signal.aborted ? 'cancelled' : isError ? 'error' : 'done');
    })()
      .catch(error => {
        const message = error instanceof Error ? error.message : String(error);
        manager.push(run, {
          type: 'tool.end',
          toolCallId,
          tool: command,
          status: run.abort?.signal.aborted ? 'denied' : 'error',
          ms: Date.now() - startedAt,
          error: message.slice(0, 300),
        });
        run.error = message.slice(0, 600);
        manager.setPhase(run, run.abort?.signal.aborted ? 'cancelled' : 'error');
      })
      .finally(() => manager.finish(run));

    return { mode: 'execute', runId: run.runId, phase: run.phase };
  });
}

async function workflowExec(args: Record<string, unknown>, ctx: AgentLinkCommandContext) {
  const command = String(args.command || '').trim();
  if (!command.startsWith('workflow.')) {
    fail(LINK_ERROR.INVALID_ARGUMENT, `workflow.exec 只接受 workflow.* 命令：${command || '(空)'}。`);
  }
  const commandArgs = args.args && typeof args.args === 'object' && !Array.isArray(args.args)
    ? { ...(args.args as Record<string, unknown>) }
    : {};
  const projectId = resolveOptionalProjectId(args, commandArgs, command);
  const host = getAgentLinkHost(projectId);
  const context = approvalContext(host);
  const decision = toolApprovalFor(command, commandArgs);
  const resolution = resolveToolApproval({ ...context, tool: command, decision });
  if (resolution.action === 'deny') {
    fail('POLICY_DENIED', 'reason' in resolution && resolution.reason ? resolution.reason : 'Tool Policy 拒绝了这次调用。');
  }
  const envelope: WorkflowCommandEnvelope = {
    id: crypto.randomUUID(),
    command,
    args: {
      ...commandArgs,
      ...(projectId ? { projectId } : {}),
      workspaceMode: 'browser',
    },
    source: ctx.source === 'local' ? 'cli' : 'agent',
    idempotencyKey: ctx.idempotencyKey,
  };
  const confirmRequest: AgentConfirmRequest = {
    ...workflowConfirmRequest(envelope),
    tier: decision.tier,
    tool: command,
    ...(decision.reason ? { reason: decision.reason } : {}),
  };
  const needsApproval = resolution.action === 'prompt' || Boolean(decision.hardGate);
  const isLong = LONG_EXEC_COMMANDS.has(command);

  if (!needsApproval && !isLong) {
    const dispatched = await dispatchWorkflowCommand(envelope);
    if (!dispatched.confirmation?.required) {
      return { immediate: true, result: await packLinkData(dispatched) };
    }
    return startApprovalGatedWorkflowRun(
      projectId || '__workspace__',
      command,
      envelope,
      dispatched.confirmation.summary || workflowCommandSummary(command, envelope.args),
      confirmRequest,
      ctx,
      env => dispatchWorkflowCommand(env),
      true,
    );
  }

  return startApprovalGatedWorkflowRun(
    projectId || '__workspace__',
    command,
    envelope,
    workflowCommandSummary(command, envelope.args),
    confirmRequest,
    ctx,
    env => dispatchWorkflowCommand(env),
    needsApproval,
  );
}

async function mediaUploadFinish(args: Record<string, unknown>, ctx: AgentLinkCommandContext) {
  const projectId = activeProjectId(args);
  const assembled = await finalizeMediaUpload(args.uploadId);
  const importArgs: Record<string, unknown> = {
    ...(typeof args.title === 'string' && args.title.trim() ? { title: args.title.trim() } : { title: assembled.fileName }),
    ...(typeof args.attachToNodeId === 'string' && args.attachToNodeId.trim() ? { attachToNodeId: args.attachToNodeId.trim() } : {}),
    ...(args.mention !== undefined ? { mention: args.mention } : {}),
    ...(args.expectedRevision !== undefined ? { expectedRevision: args.expectedRevision } : {}),
    ...(typeof args.mutationId === 'string' && args.mutationId.trim() ? { mutationId: args.mutationId.trim() } : {}),
    projectId,
    workspaceMode: 'browser',
  };
  const host = getAgentLinkHost(projectId);
  const context = approvalContext(host);
  const decision = toolApprovalFor('workflow.media.import', importArgs);
  const resolution = resolveToolApproval({ ...context, tool: 'workflow.media.import', decision });
  if (resolution.action === 'deny') {
    fail('POLICY_DENIED', 'reason' in resolution && resolution.reason ? resolution.reason : 'Tool Policy 拒绝导入素材。');
  }
  const envelope: WorkflowCommandEnvelope = {
    id: crypto.randomUUID(),
    command: 'workflow.media.import',
    args: importArgs,
    source: ctx.source === 'local' ? 'cli' : 'agent',
    idempotencyKey: ctx.idempotencyKey,
  };
  const importBlob = () => browserImportMediaBlob(
    new Blob([assembled.data as BlobPart], { type: assembled.mimeType }),
    assembled.fileName,
    assembled.mimeType,
  );
  if (resolution.action === 'allow' && !decision.hardGate) {
    const dispatched = await dispatchWorkflowMediaImportBlob(envelope, importBlob);
    return { immediate: true, result: await packLinkData(dispatched) };
  }
  const confirmRequest: AgentConfirmRequest = {
    ...workflowConfirmRequest(envelope),
    tier: decision.tier,
    tool: 'workflow.media.import',
    ...(decision.reason ? { reason: decision.reason } : {}),
  };
  return startApprovalGatedWorkflowRun(
    projectId,
    'workflow.media.import',
    envelope,
    `导入本地素材「${assembled.fileName}」（${(assembled.bytes / 1024).toFixed(1)} KB）到画布`,
    confirmRequest,
    ctx,
    env => dispatchWorkflowMediaImportBlob(env, importBlob),
    true,
  );
}

async function mediaDownloadStart(args: Record<string, unknown>) {
  const projectId = activeProjectId(args);
  const project = useWorkflowStore.getState().projects.find(item => item.id === projectId)!;
  const rawNodeIds = args.nodeIds;
  const nodeIds = Array.isArray(rawNodeIds)
    ? rawNodeIds.map(String).filter(Boolean)
    : typeof rawNodeIds === 'string'
      ? rawNodeIds.split(',').map(item => item.trim()).filter(Boolean)
      : undefined;
  const groupId = typeof args.groupId === 'string' && args.groupId.trim() ? args.groupId.trim() : undefined;
  const fileName = typeof args.fileName === 'string' && args.fileName.trim() ? args.fileName.trim() : undefined;
  try {
    const plan = planWorkflowExport(project, { nodeIds, groupId, fileName });
    const payload = await buildWorkflowExportPayload(plan, {
      loadMedia: async source => {
        const { loadWorkflowMediaBlob } = await import('../../components/workflow/media');
        return loadWorkflowMediaBlob(source.storageKey, source.href, source.artifactRef);
      },
    });
    if (payload.bytes > LINK_MAX_MEDIA_BYTES) {
      fail(LINK_ERROR.INVALID_ARGUMENT, `导出文件 ${(payload.bytes / 1024 / 1024).toFixed(1)} MB 超过直传上限 ${(LINK_MAX_MEDIA_BYTES / 1024 / 1024).toFixed(0)} MB。`);
    }
    const buffer = await registerDownloadBuffer({
      data: payload.data,
      fileName: payload.fileName,
      mimeType: payload.mimeType,
    });
    return {
      projectId,
      ...buffer,
      mode: payload.mode,
      files: payload.files,
      skipped: payload.skipped,
    };
  } catch (cause) {
    if (cause instanceof WorkflowExportError) fail(cause.code, cause.message, false, cause.details);
    throw cause;
  }
}

/* ── 入口 ── */

export async function handleAgentLinkCommand(command: string, rawArgs: unknown, ctx: AgentLinkCommandContext): Promise<AgentLinkCommandResult> {
  try {
    if (!isLinkCommand(command)) fail(LINK_ERROR.UNKNOWN_COMMAND, `不是 Iris Link 命令：${command}`);
    const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs as Record<string, unknown> : {};
    // 标签页按自己的授予记录复核一次 scope（不只信中继）。
    const missing = missingLinkScope(command, ctx.scopes, args);
    if (missing) fail(LINK_ERROR.SCOPE_DENIED, `这个连接没有被授予 ${missing}。`);
    if (linkCommandNeedsIdempotency(command, args) && !ctx.idempotencyKey) fail(LINK_ERROR.INVALID_ARGUMENT, `${command} 需要幂等键（--idempotency-key）。`);
    let data: unknown;
    switch (command) {
      case 'link.status': data = linkStatus(ctx); break;
      case 'agent.sessions': data = await sessions(args); break;
      case 'agent.send': data = await send(args, ctx); break;
      case 'agent.trace': data = await trace(args); break;
      case 'agent.approve': data = await decide(args, ctx, true); break;
      case 'agent.deny': data = await decide(args, ctx, false); break;
      case 'agent.cancel': data = await cancel(args, ctx); break;
      case 'agent.tools.list': data = toolsList(args); break;
      case 'agent.tools.invoke': data = await toolsInvoke(args, ctx); break;
      case 'workflow.read': data = await workflowRead(args, ctx); break;
      case 'workflow.exec': data = await workflowExec(args, ctx); break;
      case 'media.upload.start': data = startMediaUpload(args); break;
      case 'media.upload.chunk': data = appendMediaUploadChunk(args); break;
      case 'media.upload.finish': data = await mediaUploadFinish(args, ctx); break;
      case 'media.download.start': data = await mediaDownloadStart(args); break;
      case 'media.download.chunk': data = readDownloadChunk(args); break;
      default: fail(LINK_ERROR.UNKNOWN_COMMAND, command);
    }
    return { ok: true, data };
  } catch (error) {
    if (error instanceof LinkCommandError) return { ok: false, error: { code: error.code, message: error.message, retryable: error.retryable, ...(error.details !== undefined ? { details: error.details } : {}) } };
    if (error instanceof MediaTransferError) return { ok: false, error: { code: error.code, message: error.message, retryable: error.retryable, ...(error.details !== undefined ? { details: error.details } : {}) } };
    return { ok: false, error: { code: 'LINK_COMMAND_FAILED', message: error instanceof Error ? error.message : String(error), retryable: false } };
  }
}

/** 页面托盘上的批准 / 拒绝（用户本人，不受 CLI 限制）。 */
export function decideLinkApprovalFromPage(runId: string, approvalId: string, approved: boolean): boolean {
  const found = findLinkRun(runId);
  if (!found) return false;
  const { manager, run } = found;
  if (!run.approval || run.approval.approvalId !== approvalId) return false;
  if (approved && run.approval.blocked) return false;
  run.decisions.set(approvalId, { approved, by: 'page' });
  if (run.kind === 'invoke') {
    const pending = run.invokeApproval;
    if (!pending || pending.id !== approvalId) return false;
    run.invokeApproval = undefined;
    pending.resolve(approved);
    return true;
  }
  return manager.ownRunners()?.decide(run.cardNodeId, approvalId, approved) ?? false;
}
