// Spatial Context P1：Context Card（docs/design/11-iris.md §3，01-interaction §12.2–12.4）。
// 用户在助手回复上「钉到画布」并明确 Commit 后才创建独立的 plugin:context-card 节点（不复用备注 text 节点）。
// 标题 / 正文就是节点 title / metadata.content；metadata.contextCard 只放来源与出处。创建、编辑都走 workflow.apply，
// mutationId 由 host + sessionId + messageId 派生：同一条消息重复 Commit 只定位已有卡片，不新增。
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { createWorkflowNode } from './constants';
import type {
  WorkflowContextCardMeta,
  WorkflowContextCardSource,
  WorkflowDocumentOperation,
  WorkflowNode,
  WorkflowProject,
} from './types';
import type { AssetItem } from '../../types';
import { assetContentFingerprint, nodeContentFingerprint, sourceState, type SourceState } from '../../services/turnContext';

export const CONTEXT_CARD_TYPE = 'plugin:context-card';
export const CONTEXT_CARD_PLUGIN_ID = 'iris.context-card';
export const CONTEXT_CARD_SIZE = { width: 320, height: 240 } as const;

/**
 * Commit 时按正文长度给卡片一个贴合内容的默认尺寸（宽 320，正文最多约 6 行），不留大块空白。
 * 版式数值与 styles/workflow.css 的 .context-card 一致：内边距 12、标题 20、正文 12/18、来源条 28、尾行 24、间距 8。
 */
export function contextCardDefaultSize(body: string, sourceCount: number): { width: number; height: number } {
  const width = CONTEXT_CARD_SIZE.width;
  const inner = width - 2 - 24;
  const lines = String(body || '').split('\n').reduce((sum, paragraph) => {
    let visual = 0;
    for (const char of paragraph) visual += char.charCodeAt(0) > 0x2e80 ? 12 : 6.6;
    return sum + Math.max(1, Math.ceil(visual / inner));
  }, 0);
  const bodyLines = Math.min(6, Math.max(2, lines));
  const height = 2 + 12 + 20 + 8 + bodyLines * 18 + (sourceCount > 0 ? 8 + 28 : 0) + 8 + 24 + 12;
  return { width, height };
}

export type ContextCardSourceMessage = WorkflowContextCardMeta['sourceMessage'];

export interface ContextCardSourceInput {
  kind: 'node' | 'asset';
  id: string;
  label: string;
}

export function isContextCardNode(node: Pick<WorkflowNode, 'type'> | undefined): boolean {
  return node?.type === CONTEXT_CARD_TYPE;
}

function messageKey(message: ContextCardSourceMessage): string {
  return [message.host, message.sessionId || '', message.messageId || ''].join(':');
}

/** 同一条消息 → 同一个节点 id（幂等的落点）。没有 messageId 时无法幂等，由调用方给随机 id。 */
export function contextCardNodeId(message: ContextCardSourceMessage): string {
  return 'ctx-' + bytesToHex(sha256(utf8ToBytes(messageKey(message)))).slice(0, 12);
}

export function contextCardMutationId(message: ContextCardSourceMessage, attempt = 0): string {
  return 'context-card:' + messageKey(message) + (attempt > 0 ? ':r' + attempt : '');
}

/** 画布上已有的同一条消息的卡片（按派生 id，或按 sourceMessage 兜底）。 */
export function findContextCard(project: Pick<WorkflowProject, 'nodes'>, message: ContextCardSourceMessage): WorkflowNode | undefined {
  const id = contextCardNodeId(message);
  return project.nodes.find(node => node.id === id)
    ?? project.nodes.find(node => isContextCardNode(node) && node.metadata.contextCard
      && messageKey(node.metadata.contextCard.sourceMessage) === messageKey(message)
      && Boolean(message.messageId));
}

/** Commit 那一刻的来源：只收用户在审查步骤保留的、仍可解析的来源，指纹取当前内容。 */
export function contextCardSourcesAtCommit(sources: readonly ContextCardSourceInput[], nodes: readonly WorkflowNode[], assets?: readonly AssetItem[]): WorkflowContextCardSource[] {
  const out: WorkflowContextCardSource[] = [];
  for (const source of sources) {
    if (!source.id || out.some(item => item.kind === source.kind && item.id === source.id)) continue;
    if (source.kind === 'node') {
      const node = nodes.find(item => item.id === source.id);
      if (!node) continue;
      out.push({ kind: 'node', id: node.id, label: source.label || node.title, fingerprintAtCommit: nodeContentFingerprint(node) });
    } else {
      const asset = assets?.find(item => item.id === source.id);
      out.push({ kind: 'asset', id: source.id, label: source.label || asset?.name || source.id, fingerprintAtCommit: asset ? assetContentFingerprint(asset) : '' });
    }
  }
  return out;
}

/** 卡片放在来源节点右侧；没有节点来源时交给 workflow.apply 自动落位。 */
export function contextCardPosition(nodes: readonly WorkflowNode[], sources: readonly WorkflowContextCardSource[]): { x: number; y: number } | undefined {
  const sourceNodes = nodes.filter(node => sources.some(source => source.kind === 'node' && source.id === node.id));
  if (!sourceNodes.length) return undefined;
  const right = Math.max(...sourceNodes.map(node => node.position.x + node.width));
  const top = Math.min(...sourceNodes.map(node => node.position.y));
  const x = right + 80;
  let y = top;
  // 避开已经在那里的卡片 / 节点（简单向下错位）。
  while (nodes.some(node => node.position.x < x + CONTEXT_CARD_SIZE.width && node.position.x + node.width > x && node.position.y < y + CONTEXT_CARD_SIZE.height && node.position.y + node.height > y)) y += CONTEXT_CARD_SIZE.height + 24;
  return { x, y };
}

export function buildContextCardNode(input: {
  id: string;
  title: string;
  body: string;
  sourceMessage: ContextCardSourceMessage;
  sources: WorkflowContextCardSource[];
  committedAt: string;
  position?: { x: number; y: number };
}): WorkflowNode {
  const contextCard: WorkflowContextCardMeta = {
    schemaVersion: 1,
    sourceMessage: { host: input.sourceMessage.host, ...(input.sourceMessage.sessionId ? { sessionId: input.sourceMessage.sessionId } : {}), ...(input.sourceMessage.messageId ? { messageId: input.sourceMessage.messageId } : {}) },
    sources: input.sources,
    committedAt: input.committedAt,
  };
  const node = createWorkflowNode(input.id, CONTEXT_CARD_TYPE, input.position ?? { x: 0, y: 0 }, { content: input.body, contextCard, origin: 'user' });
  const size = contextCardDefaultSize(input.body, input.sources.length);
  const out: WorkflowNode = { ...node, title: input.title, width: size.width, height: size.height };
  // 没有位置时删掉，让 workflow.apply 的自动落位接手。
  if (!input.position) delete (out as Partial<WorkflowNode>).position;
  return out;
}

export type WorkflowApplyDispatch = (envelope: {
  id: string;
  command: string;
  source: 'ui';
  idempotencyKey?: string;
  args: Record<string, unknown>;
}) => Promise<{ ok: boolean; result?: unknown; error?: { code?: string; message?: string } }>;

async function defaultDispatch(): Promise<WorkflowApplyDispatch> {
  const { dispatchWorkflowCommand } = await import('../../services/workflowDispatcher');
  return dispatchWorkflowCommand as unknown as WorkflowApplyDispatch;
}

async function getProject(projectId: string): Promise<WorkflowProject | undefined> {
  const { useWorkflowStore } = await import('./store');
  return useWorkflowStore.getState().projects.find(project => project.id === projectId);
}

async function applyOnce(dispatch: WorkflowApplyDispatch, project: WorkflowProject, mutationId: string, operations: WorkflowDocumentOperation[], intent: string) {
  return dispatch({
    id: mutationId,
    command: 'workflow.apply',
    source: 'ui',
    idempotencyKey: mutationId,
    args: { projectId: project.id, expectedRevision: project.draftVersion || 1, mutationId, operations, intent },
  });
}

export type ContextCardCommitResult =
  | { ok: true; status: 'created' | 'existing'; nodeId: string; mutationId?: string }
  | { ok: false; error: string };

/**
 * 明确 Commit：画布上已有同一条消息的卡片就只返回它（调用方定位），否则经 workflow.apply 创建。
 * 同一 mutationId 已被用过（卡片后来被删除 / 撤销）时用 :rN 后缀重新创建，避免撞上不同载荷的幂等冲突。
 */
export async function commitContextCard(input: {
  projectId: string;
  title: string;
  body: string;
  sourceMessage: ContextCardSourceMessage;
  sources: readonly ContextCardSourceInput[];
  assets?: readonly AssetItem[];
  now?: () => Date;
  dispatch?: WorkflowApplyDispatch;
}): Promise<ContextCardCommitResult> {
  const project = await getProject(input.projectId);
  if (!project) return { ok: false, error: '项目不存在或已删除。' };
  const title = input.title.trim();
  const body = input.body.trim();
  if (!title || !body) return { ok: false, error: '卡片标题和正文不能为空。' };
  const idempotent = Boolean(input.sourceMessage.messageId);
  const existing = idempotent ? findContextCard(project, input.sourceMessage) : undefined;
  if (existing) return { ok: true, status: 'existing', nodeId: existing.id };
  const sources = contextCardSourcesAtCommit(input.sources, project.nodes, input.assets);
  const nodeId = idempotent ? contextCardNodeId(input.sourceMessage) : 'ctx-' + crypto.randomUUID().slice(0, 12);
  const node = buildContextCardNode({
    id: nodeId,
    title,
    body,
    sourceMessage: input.sourceMessage,
    sources,
    committedAt: (input.now?.() ?? new Date()).toISOString(),
    position: contextCardPosition(project.nodes, sources),
  });
  const used = new Set((project.workflowMutationReceipts || []).map(receipt => receipt.mutationId));
  const base = idempotent ? contextCardMutationId(input.sourceMessage) : 'context-card:' + nodeId;
  let attempt = 0;
  while (used.has(attempt ? base + ':r' + attempt : base)) attempt += 1;
  const mutationId = attempt ? base + ':r' + attempt : base;
  const dispatch = input.dispatch ?? await defaultDispatch();
  const result = await applyOnce(dispatch, project, mutationId, [{ type: 'add_node', node }], '钉到画布：' + title);
  if (!result.ok) return { ok: false, error: result.error?.message || '创建 Context Card 失败。' };
  return { ok: true, status: 'created', nodeId, mutationId };
}

/** 用户显式重新保存：旧版本进 history，正文 / 标题替换；来源不自动增减。 */
export async function saveContextCardEdit(input: {
  projectId: string;
  nodeId: string;
  title: string;
  body: string;
  now?: () => Date;
  dispatch?: WorkflowApplyDispatch;
}): Promise<ContextCardCommitResult> {
  const project = await getProject(input.projectId);
  const node = project?.nodes.find(item => item.id === input.nodeId);
  const card = node?.metadata.contextCard;
  if (!project || !node || !card) return { ok: false, error: 'Context Card 不存在。' };
  const title = input.title.trim();
  const body = input.body.trim();
  if (!title || !body) return { ok: false, error: '卡片标题和正文不能为空。' };
  if (title === node.title && body === (node.metadata.content || '')) return { ok: true, status: 'existing', nodeId: node.id };
  const history = [...(card.history || []), { title: node.title, content: node.metadata.content || '', sources: card.sources, committedAt: card.committedAt }];
  const next: WorkflowContextCardMeta = { ...card, committedAt: (input.now?.() ?? new Date()).toISOString(), history };
  const mutationId = 'context-card-edit:' + node.id + ':v' + (history.length + 1);
  const dispatch = input.dispatch ?? await defaultDispatch();
  const result = await applyOnce(dispatch, project, mutationId, [{ type: 'update_node', id: node.id, patch: { title }, metadata: { content: body, contextCard: next } }], '更新 Context Card：' + title);
  if (!result.ok) return { ok: false, error: result.error?.message || '保存 Context Card 失败。' };
  return { ok: true, status: 'created', nodeId: node.id, mutationId };
}

export interface ContextCardSourceStatus extends WorkflowContextCardSource {
  state: SourceState;
}

/** 卡片来源的当前状态：只比较内容指纹，移动 / 缩放 / 改名不会触发「来源已更新」。 */
export function contextCardSourceStates(node: Pick<WorkflowNode, 'metadata'>, nodes: readonly WorkflowNode[], assets?: readonly AssetItem[]): { sources: ContextCardSourceStatus[]; missing: number; updated: number } {
  const sources = (node.metadata.contextCard?.sources || []).map(source => ({
    ...source,
    state: sourceState({ kind: source.kind, id: source.id, fingerprint: source.fingerprintAtCommit || undefined }, nodes, assets),
  }));
  return { sources, missing: sources.filter(item => item.state === 'missing').length, updated: sources.filter(item => item.state === 'updated').length };
}

export type ContinueDiscussionPlan =
  | { mode: 'open'; sessionId: string; messageId?: string }
  | { mode: 'new'; title: string; body: string; references: ContextCardSourceInput[] };

/**
 * 「继续讨论」：原内置会话还在就打开它并定位到那条消息；外部会话或会话已删除时，以卡片定稿 + 仍可访问的来源开新会话。
 * 讨论用实时来源（已更新的来源照常带上，删除的去掉）。
 */
export function planContinueDiscussion(node: Pick<WorkflowNode, 'title' | 'metadata'>, input: { sessionExists: (sessionId: string) => boolean; nodes: readonly WorkflowNode[]; assets?: readonly AssetItem[] }): ContinueDiscussionPlan {
  const card = node.metadata.contextCard;
  const message = card?.sourceMessage;
  if (message?.host === 'iris' && message.sessionId && input.sessionExists(message.sessionId)) {
    return { mode: 'open', sessionId: message.sessionId, ...(message.messageId ? { messageId: message.messageId } : {}) };
  }
  const states = card ? contextCardSourceStates(node, input.nodes, input.assets).sources : [];
  return {
    mode: 'new',
    title: node.title,
    body: node.metadata.content || '',
    references: states.filter(source => source.state !== 'missing').map(source => {
      const live = source.kind === 'node' ? input.nodes.find(item => item.id === source.id) : undefined;
      return { kind: source.kind, id: source.id, label: live?.title || source.label };
    }),
  };
}

/** 非 UI 来源（Agent / CLI / 外部宿主）不能新建、改写、删除或连线 Context Card：它是用户定稿的结论，只读。 */
export function contextCardWriteViolation(source: string, operations: readonly WorkflowDocumentOperation[], nodes: readonly WorkflowNode[]): boolean {
  if (source === 'ui' || source === 'promptbar') return false;
  const cardIds = new Set(nodes.filter(isContextCardNode).map(node => node.id));
  return operations.some(op => {
    if (op.type === 'add_node' || op.type === 'create_connected_node') return isContextCardNode(op.node) || (op.type === 'create_connected_node' && cardIds.has(op.fromNodeId));
    if (op.type === 'update_node') return cardIds.has(op.id);
    if (op.type === 'delete_nodes') return op.ids.some(id => cardIds.has(id));
    if (op.type === 'connect_nodes') return cardIds.has(op.fromNodeId) || cardIds.has(op.toNodeId);
    return false;
  });
}

export const CONTEXT_CARD_READ_ONLY_MESSAGE = 'Context Card 是用户定稿（Commit）的创作结论：只读，当作上下文阅读，不能连线、改写或删除。';
