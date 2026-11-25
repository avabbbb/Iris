// 画布 Agent 会话卡（plugin:agent-session，docs/design/01-interaction.md §12.0）。
// 卡片是 Session 的投影：节点只存 sessionId、绑定素材和最新一轮的 entryId + 摘录；正文、工具日志和审批都在 Drawer 的同一个会话里。
// 创建 / 绑定 / 记录摘要都走 workflow.apply（source=ui），新卡片只放进空位，从不移动已有节点。
import { createWorkflowNode } from './constants';
import { footprint, type Rect } from './batchAlternates';
import type {
  WorkflowAgentSessionMeta,
  WorkflowAgentSessionReference,
  WorkflowAgentSessionTurn,
  WorkflowDocumentOperation,
  WorkflowNode,
  WorkflowProject,
} from './types';
import type { WorkflowApplyDispatch } from './contextCard';

export const AGENT_SESSION_TYPE = 'plugin:agent-session';
export const AGENT_SESSION_PLUGIN_ID = 'iris.agent-session';
/**
 * 卡片尺寸（P1b）：标题 20 + 身份行 14 + 运行轨迹（思考 2 行 + 工具 3 行 / 审批行 / 摘录 4 行）+ 上下文 Chip 22 + 输入 / 继续问。
 * Chip 行同时放素材、本轮 Skill 和记忆，所以不再按有没有素材决定高度。
 */
export const AGENT_SESSION_CARD_SIZE = { width: 340, height: 284 } as const;
export function agentSessionCardSize(_referenceCount: number): { width: number; height: number } {
  return { width: AGENT_SESSION_CARD_SIZE.width, height: AGENT_SESSION_CARD_SIZE.height };
}
/** 新卡片与已有节点之间至少留出的空隙。 */
export const AGENT_SESSION_GAP = 32;
export const AGENT_SESSION_EXCERPT_MAX = 280;

export function isAgentSessionNode(node: Pick<WorkflowNode, 'type'> | undefined): boolean {
  return node?.type === AGENT_SESSION_TYPE;
}

/* ── 就近布局：只找空位，不挪任何已有节点 ── */

export function rectsOverlap(a: Rect, b: Rect, gap = 0): boolean {
  return a.x < b.x + b.width + gap && a.x + a.width + gap > b.x && a.y < b.y + b.height + gap && a.y + a.height + gap > b.y;
}

/** 节点占的画布区域：复用批次备选的 footprint（叠放 / 网格备选也算在内）。 */
function occupiedRects(nodes: readonly WorkflowNode[]): Rect[] {
  return nodes.filter(node => node.isVisible !== false && node.position).map(node => footprint(node));
}

export interface FreeSpot { x: number; y: number; fallback: boolean }

/**
 * 在锚点附近找一个放得下 size 的空位。
 * - 锚点是一块区域（选区）时：优先右侧顶对齐，其次下方、左侧、上方，逐步外扩；卡片不压住锚点本身。
 * - 锚点是一个点（双击位置）时：优先就放在这个点，放不下再就近外扩。
 * 搜索半径内都被占满时退到所有内容的最右侧（fallback=true），仍然不移动任何节点。
 */
export function findFreeSpot(nodes: readonly WorkflowNode[], anchor: Rect, size: { width: number; height: number }, options: { gap?: number; radius?: number; step?: number } = {}): FreeSpot {
  const gap = options.gap ?? AGENT_SESSION_GAP;
  const step = options.step ?? 24;
  const radius = options.radius ?? 1400;
  const occupied = occupiedRects(nodes);
  const isPoint = anchor.width <= 0 && anchor.height <= 0;
  const blocked = (rect: Rect) => occupied.some(other => rectsOverlap(rect, other, gap)) || (!isPoint && rectsOverlap(rect, anchor, gap));
  const preferred = isPoint
    ? { x: anchor.x, y: anchor.y }
    : { x: anchor.x + anchor.width + gap, y: anchor.y };
  if (!blocked({ ...preferred, ...size })) return { ...preferred, fallback: false };
  let best: { x: number; y: number; score: number } | null = null;
  for (let dx = -radius; dx <= radius; dx += step) {
    for (let dy = -radius; dy <= radius; dy += step) {
      const x = Math.round(preferred.x + dx);
      const y = Math.round(preferred.y + dy);
      const distance = Math.hypot(dx, dy);
      if (best && distance >= best.score) continue;
      const rect = { x, y, width: size.width, height: size.height };
      // 方向偏好：右 → 下 → 左 → 上。往上 / 往左挪比往下 / 往右更「贵」，所以同样远时卡片落在下方或右侧。
      const penalty = (dy < 0 ? -dy * 1.2 : 0) + (dx < 0 ? -dx * 0.6 : 0);
      const score = distance + penalty;
      if (best && score >= best.score) continue;
      if (blocked(rect)) continue;
      best = { x, y, score };
    }
  }
  if (best) return { x: best.x, y: best.y, fallback: false };
  const right = occupied.reduce((max, rect) => Math.max(max, rect.x + rect.width), anchor.x + anchor.width);
  return { x: Math.round(right + gap * 2), y: Math.round(anchor.y), fallback: true };
}

/** 选中节点的外接矩形。 */
export function selectionBounds(nodes: readonly WorkflowNode[]): Rect | null {
  const visible = nodes.filter(node => node.position);
  if (!visible.length) return null;
  const left = Math.min(...visible.map(node => node.position.x));
  const top = Math.min(...visible.map(node => node.position.y));
  const right = Math.max(...visible.map(node => node.position.x + node.width));
  const bottom = Math.max(...visible.map(node => node.position.y + node.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/* ── 摘录 ── */

/** 回复 → 卡片摘录：去掉 Markdown 记号、合并空白，截到 max 字。 */
export function agentSessionExcerpt(text: string, max = AGENT_SESSION_EXCERPT_MAX): string {
  const plain = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_`~]+/g, '')
    .split('\n').map(line => line.trim()).filter(Boolean).join('\n');
  return plain.length > max ? plain.slice(0, max - 1).trimEnd() + '…' : plain;
}

/** 流式预览：只取前 lines 行（卡片只显示进度和前几行，完整内容在 Drawer）。 */
export function agentSessionPreviewLines(text: string, lines = 3): string {
  return agentSessionExcerpt(text, 400).split('\n').slice(0, lines).join('\n');
}

/** 卡片标题：第一轮问题的前 24 个字；没有问题时按来源给默认标题。 */
export function agentSessionTitle(prompt: string, origin: WorkflowAgentSessionMeta['origin'], references: readonly WorkflowAgentSessionReference[] = []): string {
  const line = String(prompt || '').split('\n').map(item => item.trim()).find(Boolean) || '';
  if (line) return line.length > 24 ? line.slice(0, 23) + '…' : line;
  if (origin === 'discuss') return references.length === 1 ? '讨论「' + references[0].label + '」' : `讨论 ${references.length} 个素材`;
  return '问 Agent';
}

/* ── 创建 / 绑定 / 记录 ── */

function referenceKey(references: readonly WorkflowAgentSessionReference[]): string {
  return references.map(ref => ref.kind + ':' + ref.id).sort().join('|');
}

/** 选中素材 → 绑定引用（去重、保持选区顺序；锁定 / 隐藏节点也可以引用，但 Agent 会话卡和 Context Card 不作为素材）。 */
export function agentSessionReferencesFromNodes(nodes: readonly WorkflowNode[]): WorkflowAgentSessionReference[] {
  const out: WorkflowAgentSessionReference[] = [];
  for (const node of nodes) {
    if (isAgentSessionNode(node) || out.some(item => item.id === node.id)) continue;
    out.push({ kind: 'node', id: node.id, label: node.title || '未命名节点' });
  }
  return out;
}

/** 同一选区已经有一张还没发出第一轮的讨论卡：重复点击只定位它。 */
export function findPendingDiscussCard(nodes: readonly WorkflowNode[], references: readonly WorkflowAgentSessionReference[]): WorkflowNode | undefined {
  const key = referenceKey(references);
  return nodes.find(node => isAgentSessionNode(node)
    && node.metadata.agentSession?.origin === 'discuss'
    && !node.metadata.agentSession.sessionId
    && !node.metadata.agentSession.lastTurn
    && referenceKey(node.metadata.agentSession.references) === key);
}

export function agentSessionNodeId(requestId: string): string {
  return 'ags-' + requestId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24);
}

export function buildAgentSessionNode(input: {
  id: string;
  origin: WorkflowAgentSessionMeta['origin'];
  references: WorkflowAgentSessionReference[];
  position: { x: number; y: number };
  prompt?: string;
  createdAt: string;
}): WorkflowNode {
  const agentSession: WorkflowAgentSessionMeta = {
    schemaVersion: 1,
    host: 'iris',
    origin: input.origin,
    references: input.references.map(ref => ({ kind: ref.kind, id: ref.id, label: ref.label })),
    createdAt: input.createdAt,
  };
  const node = createWorkflowNode(input.id, AGENT_SESSION_TYPE, input.position, { agentSession, origin: 'user' });
  return { ...node, title: agentSessionTitle(input.prompt || '', input.origin, input.references), ...agentSessionCardSize(input.references.length) };
}

async function defaultDispatch(): Promise<WorkflowApplyDispatch> {
  const { dispatchWorkflowCommand } = await import('../../services/workflowDispatcher');
  return dispatchWorkflowCommand as unknown as WorkflowApplyDispatch;
}

async function getProject(projectId: string): Promise<WorkflowProject | undefined> {
  const { useWorkflowStore } = await import('./store');
  return useWorkflowStore.getState().projects.find(project => project.id === projectId);
}

async function apply(input: { projectId: string; mutationId: string; operations: WorkflowDocumentOperation[]; intent: string; dispatch?: WorkflowApplyDispatch }) {
  const project = await getProject(input.projectId);
  if (!project) return { ok: false as const, error: '项目不存在或已删除。' };
  const dispatch = input.dispatch ?? await defaultDispatch();
  const result = await dispatch({
    id: input.mutationId,
    command: 'workflow.apply',
    source: 'ui',
    idempotencyKey: input.mutationId,
    args: { projectId: project.id, expectedRevision: project.draftVersion || 1, mutationId: input.mutationId, operations: input.operations, intent: input.intent },
  });
  return result.ok ? { ok: true as const } : { ok: false as const, error: result.error?.message || '写入画布失败。' };
}

export type AgentSessionCardResult =
  | { ok: true; status: 'created' | 'existing'; nodeId: string; fallback?: boolean }
  | { ok: false; error: string };

// 同一手势的并发调用（双击 Enter、连点按钮）在 apply 完成前共享同一个 promise。
const inflight = new Map<string, Promise<AgentSessionCardResult>>();

/**
 * 创建会话卡：
 * - ask：anchor 是双击 / 快捷键的位置（点），卡片尽量就放在那里；
 * - discuss：anchor 是选区外接矩形，卡片放到选区旁的空位，选中素材绑定为引用。同一选区还没发出的讨论卡只定位不新建。
 * requestId 是这次手势的幂等键：同一个 requestId 只会建一张卡。
 */
export function createAgentSessionCard(input: {
  projectId: string;
  requestId: string;
  origin: WorkflowAgentSessionMeta['origin'];
  anchor: Rect;
  references?: WorkflowAgentSessionReference[];
  prompt?: string;
  now?: () => Date;
  dispatch?: WorkflowApplyDispatch;
}): Promise<AgentSessionCardResult> {
  const references = input.references || [];
  const lockKey = input.projectId + '\u0000' + (input.origin === 'discuss' ? 'discuss:' + referenceKey(references) : 'ask:' + input.requestId);
  const running = inflight.get(lockKey);
  if (running) return running;
  const task = (async (): Promise<AgentSessionCardResult> => {
    const project = await getProject(input.projectId);
    if (!project) return { ok: false, error: '项目不存在或已删除。' };
    const nodeId = agentSessionNodeId(input.requestId);
    if (project.nodes.some(node => node.id === nodeId)) return { ok: true, status: 'existing', nodeId };
    if (input.origin === 'discuss') {
      if (!references.length) return { ok: false, error: '先选中要讨论的素材。' };
      const pending = findPendingDiscussCard(project.nodes, references);
      if (pending) return { ok: true, status: 'existing', nodeId: pending.id };
    }
    const spot = findFreeSpot(project.nodes, input.anchor, agentSessionCardSize(references.length));
    const node = buildAgentSessionNode({
      id: nodeId,
      origin: input.origin,
      references,
      position: { x: spot.x, y: spot.y },
      prompt: input.prompt,
      createdAt: (input.now?.() ?? new Date()).toISOString(),
    });
    const result = await apply({ projectId: project.id, mutationId: 'agent-session:' + nodeId, operations: [{ type: 'add_node', node }], intent: input.origin === 'discuss' ? '与 Agent 讨论' : '问 Agent', dispatch: input.dispatch });
    if (result.ok === false) return { ok: false, error: result.error };
    return { ok: true, status: 'created', nodeId, ...(spot.fallback ? { fallback: true } : {}) };
  })();
  inflight.set(lockKey, task);
  void task.finally(() => { if (inflight.get(lockKey) === task) inflight.delete(lockKey); });
  return task;
}

/** 第一轮发出时把真实的内置会话 id 写进卡片（以后只按 sessionId 投影）；第一轮的问题顺便作为标题。 */
export async function bindAgentSessionCard(input: { projectId: string; nodeId: string; sessionId: string; prompt?: string; dispatch?: WorkflowApplyDispatch }) {
  const project = await getProject(input.projectId);
  const node = project?.nodes.find(item => item.id === input.nodeId);
  const meta = node?.metadata.agentSession;
  if (!project || !node || !meta) return { ok: false as const, error: '会话卡不存在。' };
  if (meta.sessionId === input.sessionId) return { ok: true as const };
  const firstTurn = !meta.sessionId && !meta.lastTurn;
  const title = firstTurn && input.prompt ? agentSessionTitle(input.prompt, meta.origin, meta.references) : node.title;
  return apply({
    projectId: project.id,
    mutationId: 'agent-session-bind:' + node.id + ':' + input.sessionId,
    operations: [{ type: 'update_node', id: node.id, patch: { title }, metadata: { agentSession: { ...meta, sessionId: input.sessionId } } }],
    intent: '绑定 Agent 会话',
    dispatch: input.dispatch,
  });
}

/**
 * P1 建的旧卡（196 / 226 高）放不下 P1b 的身份行 + 运行轨迹：打开（挂载）时自动增高到当前最小高度，一张卡只做一次。
 * 只加高不变窄，用户手动拉得更高的保持原样。
 */
export async function ensureAgentSessionCardHeight(input: { projectId: string; nodeId: string; dispatch?: WorkflowApplyDispatch }) {
  const project = await getProject(input.projectId);
  const node = project?.nodes.find(item => item.id === input.nodeId);
  if (!project || !node || !node.metadata.agentSession) return { ok: false as const, error: '会话卡不存在。' };
  if (node.height >= AGENT_SESSION_CARD_SIZE.height) return { ok: true as const };
  return apply({
    projectId: project.id,
    mutationId: 'agent-session-grow:' + node.id + ':' + AGENT_SESSION_CARD_SIZE.height,
    operations: [{ type: 'update_node', id: node.id, patch: { height: AGENT_SESSION_CARD_SIZE.height } }],
    intent: '会话卡增高',
    dispatch: input.dispatch,
  });
}

/** 一轮结束：只记 entryId、问题前一小段和回复摘录。同一 entryId 只写一次。 */
export async function recordAgentSessionTurn(input: { projectId: string; nodeId: string; turn: Omit<WorkflowAgentSessionTurn, 'excerpt' | 'prompt'> & { prompt: string; reply: string }; dispatch?: WorkflowApplyDispatch }) {
  const project = await getProject(input.projectId);
  const node = project?.nodes.find(item => item.id === input.nodeId);
  const meta = node?.metadata.agentSession;
  if (!project || !node || !meta) return { ok: false as const, error: '会话卡不存在。' };
  const turn: WorkflowAgentSessionTurn = {
    ...(input.turn.entryId ? { entryId: input.turn.entryId } : {}),
    prompt: agentSessionExcerpt(input.turn.prompt, 80),
    excerpt: agentSessionExcerpt(input.turn.reply),
    status: input.turn.status,
    at: input.turn.at,
  };
  const previous = meta.lastTurn;
  if (previous && previous.entryId && previous.entryId === turn.entryId && previous.excerpt === turn.excerpt) return { ok: true as const };
  const mutationId = 'agent-session-turn:' + node.id + ':' + (turn.entryId || turn.at);
  return apply({ projectId: project.id, mutationId, operations: [{ type: 'update_node', id: node.id, metadata: { agentSession: { ...meta, lastTurn: turn } } }], intent: '更新 Agent 会话摘要', dispatch: input.dispatch });
}

/** 会话卡里的这一轮 → 面板发送用的显式引用（与 @ Chip 同形，内核据此写 iris.turn_context）。 */
export function agentSessionTurnReferences(meta: Pick<WorkflowAgentSessionMeta, 'references'>, nodes: readonly WorkflowNode[]): Array<{ id: string; type: 'node' | 'asset'; label: string; mediaType?: string }> {
  const out: Array<{ id: string; type: 'node' | 'asset'; label: string; mediaType?: string }> = [];
  for (const ref of meta.references) {
    if (ref.kind === 'asset') { out.push({ id: ref.id, type: 'asset', label: ref.label }); continue; }
    const node = nodes.find(item => item.id === ref.id);
    if (node) out.push({ id: node.id, type: 'node', label: node.title || ref.label, mediaType: node.type });
  }
  return out;
}

/** 非 UI 来源（Agent / CLI / 外部宿主）不能新建、改写、删除或连线会话卡：它是 Session 的投影，由面板维护。 */
export function agentSessionWriteViolation(source: string, operations: readonly WorkflowDocumentOperation[], nodes: readonly WorkflowNode[]): boolean {
  if (source === 'ui' || source === 'promptbar') return false;
  const cardIds = new Set(nodes.filter(isAgentSessionNode).map(node => node.id));
  return operations.some(op => {
    if (op.type === 'add_node' || op.type === 'create_connected_node') return isAgentSessionNode(op.node) || (op.type === 'create_connected_node' && cardIds.has(op.fromNodeId));
    if (op.type === 'update_node') return cardIds.has(op.id);
    if (op.type === 'delete_nodes') return op.ids.some(id => cardIds.has(id));
    if (op.type === 'connect_nodes') return cardIds.has(op.fromNodeId) || cardIds.has(op.toNodeId);
    return false;
  });
}

export const AGENT_SESSION_READ_ONLY_MESSAGE = 'Agent 会话卡是会话的投影：只读，不能连线、改写或删除；在 Drawer 里继续这个会话。';
