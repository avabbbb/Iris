import { estimateRunCost, planRunApproval } from './runApproval';
import { CONTEXT_CARD_READ_ONLY_MESSAGE, CONTEXT_CARD_TYPE, contextCardWriteViolation } from '../components/workflow/contextCard';
import { AGENT_SESSION_READ_ONLY_MESSAGE, AGENT_SESSION_TYPE, agentSessionWriteViolation } from '../components/workflow/agentSessionCard';
import { terminalFromFailure, terminalFromRunResult, type WorkflowRunTerminal } from './workflowRunTerminal';
import { planMentionPrunes, type MentionPrune } from '../components/workflow/promptReferenceAlignment';
import { WORKFLOW_NODE_PATCH_FIELDS, WORKFLOW_OPERATION_FIELDS } from '../tools/iris/workflow-operation-schema.js';
import { nanoid } from 'nanoid';
import { WORKFLOW_MUTATION_COMMANDS, workflowCommandSummary } from '../components/workflow/agentOps';
import { createWorkflowNode } from '../components/workflow/constants';
import { alternateAsNode, findAlternateOwner, missingNodeMessage } from '../components/workflow/batchAlternates';
import { applyWorkflowMutation, applyWorkflowViewOperations } from '../components/workflow/draftAuthority';
import { applyWorkflowOps } from '../components/workflow/ops';
import { appendWorkflowDraftLog, createWorkflowDraftLogEntry } from '../components/workflow/draftLog';
import { isWorkflowNodeTool, resolveWorkflowNodeToolCommand, workflowNodeToolIsPaid, workflowNodeToolSpec, workflowNodeToolSpecs, workflowNodeToolsFor } from '../components/workflow/nodeToolCatalog';
import { getWorkflowOperationCapabilityByNodeTool, parseWorkflowOperationNodeToolArguments } from '../components/workflow/operationRegistry';
import { getWorkflowPersistenceError, useWorkflowStore } from '../components/workflow/store';
import { reorderReferenceOperations } from '../components/workflow/references';
import type { WorkflowConnection, WorkflowDocumentOperation, WorkflowMutationSource, WorkflowNode, WorkflowNodeMetadata, WorkflowNodeType, WorkflowProject } from '../components/workflow/types';
import { normalizeWorkflowExecutionError, type WorkflowExecutor, type WorkflowRunCommand, type WorkflowRunResult } from './workflowExecutor';
import { displayError } from './displayError';
import { buildProductionBible } from '../components/workflow/productionBible';
import { nodeSearchQueryFromArgs, searchWorkflowNodes } from '../components/workflow/nodeSearch';
import { buildProjectLedger, renderProjectLedger } from '../components/workflow/projectLedger';
import { buildWorkflowPromptDocument, promptDocumentMentions, workflowPromptMentionAttrs } from '../components/workflow/promptDocument';
import { buildScriptMaterializeOps, ScriptMaterializeError } from '../components/workflow/scriptMaterialize';
import { checkGenerateInvariant, currentGenerateReferences, generateModeOf, listWorkflowModels, planWorkflowGenerate, WorkflowGenerateError } from './workflowGenerateCommand';
import { WorkflowGroupError, buildGroupCreateOps, groupRunOrder, isGroupFrame } from '../components/workflow/canvasGroups';
import { SLASH_SHORTCUTS, SlashShortcutError, buildShortcutApplyOps, describeSlashShortcuts, getSlashShortcut } from '../components/workflow/slashShortcuts';
import type { UserApiKey } from '../types';
import { planGenerationGate, seedancePreflightForNodes } from './generationPlan';
import { describeSeedanceFailures } from './seedancePreflight';
import { executeWorkflowExport, planWorkflowExport, WorkflowExportError, type WorkflowExportRuntime } from '../components/workflow/nodeExport';
import { agentModelCatalogSummary, normalizeOperationModelIds } from './agentModelCatalog';
import { checkRevision, revisionConflictMessage } from '../components/workflow/revisionRebase';

export interface WorkflowCommandEnvelope {
  id: string;
  command: string;
  args: Record<string, unknown>;
  source: 'ui' | 'cli' | 'agent' | 'operator';
  idempotencyKey?: string;
  caller?: { agentIdentity?: string; hostSessionId?: string };
  workspaceLease?: {
    leaseId: string;
    agentIdentity: string;
    clientId: string;
    projectId: string;
    baseRevision: number | null;
    issuedAt: number;
    expiresAt: number;
  };
}

const WORKFLOW_HUMAN_APPROVAL = Symbol('flovart.workflow-human-approval');

export function withWorkflowHumanApproval(envelope: WorkflowCommandEnvelope): WorkflowCommandEnvelope {
  const approved = { ...envelope, args: { ...envelope.args } };
  delete approved.args.confirmed;
  Object.defineProperty(approved, WORKFLOW_HUMAN_APPROVAL, { value: true });
  return approved;
}

function hasWorkflowHumanApproval(envelope: WorkflowCommandEnvelope): boolean {
  return (envelope as WorkflowCommandEnvelope & { [WORKFLOW_HUMAN_APPROVAL]?: true })[WORKFLOW_HUMAN_APPROVAL] === true;
}

declare const SPEND_GRANT: unique symbol;
/**
 * 付费授权凭证（审计 PR-8，C4）：画布工具适配器（nodeToolRunner）的最后一个参数，只能由下面的
 * nodeToolSpendGrant 签发（品牌字段只存在于类型里、本类型的签发函数不导出）。不带凭证直接调用适配器、
 * 或手写一个对象冒充凭证，tsc 都会报错。9b7c579b 之前 outpaint / mask 在 Agent 路径上没确认就到了付费图片服务。
 * - free：工具说明书里不是 paid（免费 / 只调 LLM）；
 * - user-initiated：用户在界面里自己点的（不是外部 Agent），确认就是那次点击；
 * - human-approved：外部 Agent 的付费调用，已带一次性人工批准（withWorkflowHumanApproval）。
 */
export type SpendGrant = { readonly [SPEND_GRANT]: true; readonly basis: 'free' | 'user-initiated' | 'human-approved'; readonly tool: string };

function isExternalAgentEnvelope(envelope: WorkflowCommandEnvelope): boolean {
  return envelope.source === 'agent' || (envelope.source === 'cli' && Boolean(envelope.caller?.agentIdentity));
}

/** 按工具说明书的计费判定独立签发（不复用确认判定）：确认判定再出错，付费工具也拿不到凭证。null = 不能执行。 */
function nodeToolSpendGrant(envelope: WorkflowCommandEnvelope, tool: string): SpendGrant | null {
  const grant = (basis: SpendGrant['basis']) => ({ basis, tool }) as SpendGrant;
  if (isWorkflowNodeTool(tool) && !workflowNodeToolIsPaid(tool)) return grant('free');
  if (!isExternalAgentEnvelope(envelope)) return grant('user-initiated');
  return hasWorkflowHumanApproval(envelope) ? grant('human-approved') : null;
}

export interface WorkflowCommandResult {
  ok: boolean;
  commandId: string;
  result?: unknown;
  confirmation?: { required: boolean; summary: string; code?: 'CONFIRMATION_REQUIRED' };
  error?: { code: string; message: string; expectedRevision?: number; actualRevision?: number; changedObjectIds?: string[]; retryable?: boolean; details?: Record<string, unknown> };
}

export interface WorkflowDispatcherDependencies {
  getState: () => { projects: WorkflowProject[]; activeProjectId: string | null };
  createProject: (title?: string) => string;
  setActiveProject: (id: string | null) => void;
  deleteProjects: (ids: string[]) => void;
  updateProject: (id: string, patch: Partial<Omit<WorkflowProject, 'id' | 'createdAt'>>) => void;
  executor?: WorkflowExecutor;
  getExecutor?: () => WorkflowExecutor | undefined;
  /** grant 只能由审批层（nodeToolSpendGrant）签发；见 SpendGrant。 */
  nodeToolRunner?: (projectId: string, nodeId: string, tool: string, args: Record<string, unknown>, grant: SpendGrant) => Promise<unknown>;
  persistenceError?: () => unknown;
  /** 当前 BYOK Key：models.list / generate 判断哪些模型与模式真正可运行 */
  getUserApiKeys?: () => UserApiKey[];
  /** 素材库查询：media.import 的 assetId 来源 */
  lookupAsset?: (assetId: string) => WorkflowImportAsset | undefined;
  /** URL → durable Workflow 媒体记录；默认在浏览器里下载后走 ingestWorkflowMedia */
  importMediaUrl?: (url: string) => Promise<WorkflowImportedMedia>;
  /** workflow.export：读媒体原文件与保存到本机；默认读 Workflow 媒体存储并走 saveBlob（桌面另存为 / 浏览器下载）。 */
  exportRuntime?: WorkflowExportRuntime;
}

export interface WorkflowImportAsset {
  id: string;
  name?: string;
  mimeType: string;
  width?: number;
  height?: number;
}

export interface WorkflowImportedMedia {
  type: 'image' | 'video' | 'audio';
  metadata: WorkflowNodeMetadata;
  width: number;
  height: number;
  /** 写入成功后释放 pending 保护；失败时丢弃已存的媒体 */
  commit?: () => void;
  discard?: () => Promise<void> | void;
}

const browserExportRuntime: WorkflowExportRuntime = {
  loadMedia: async source => {
    const { loadWorkflowMediaBlob } = await import('../components/workflow/media');
    return loadWorkflowMediaBlob(source.storageKey, source.href, source.artifactRef);
  },
  save: async (blob, fileName) => {
    const { saveBlob } = await import('./desktopNetwork');
    return saveBlob(blob, fileName);
  },
};

async function browserImportMediaUrl(url: string): Promise<WorkflowImportedMedia> {
  const { ingestWorkflowMedia, fitWorkflowMediaSize, releaseWorkflowMediaRecord, discardWorkflowMediaRecord } = await import('../components/workflow/media');
  const response = await fetch(url);
  if (!response.ok) throw new Error('下载素材失败：HTTP ' + response.status);
  const blob = await response.blob();
  const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'imported') || 'imported';
  const record = await ingestWorkflowMedia(new File([blob], name, { type: blob.type || response.headers.get('content-type') || '' }));
  const { type, ...metadata } = record;
  const size = fitWorkflowMediaSize(type, record.naturalWidth, record.naturalHeight);
  return {
    type,
    metadata: { ...metadata, status: 'success' },
    width: size.width,
    height: size.height,
    commit: () => releaseWorkflowMediaRecord(record.storageKey),
    discard: () => discardWorkflowMediaRecord(record.storageKey),
  };
}

const NOTE_IS_ANNOTATION_MESSAGE = '文本节点是备注，只给人看、不参与生成：生成请用 iris_generate（提示词写进生成节点的 Prompt Bar）；用户明确要求写备注时用 iris_note_write。';

/** 非 UI 来源（Agent / CLI / MCP / Runtime）不得用通用写入建文本节点。 */
function agentTextNodeViolation(source: WorkflowCommandEnvelope['source'], operations: WorkflowDocumentOperation[]): boolean {
  if (source === 'ui') return false;
  return operations.some(op => (op.type === 'add_node' || op.type === 'create_connected_node') && op.node?.type === 'text');
}

function stableShortId(prefix: string, seed: string) {
  let hash = 2166136261;
  for (const char of seed) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  return prefix + hash.toString(36);
}

const MAX_IDEMPOTENCY_ENTRIES = 256;
const NODE_TYPES: WorkflowNodeType[] = ['image', 'text', 'video', 'audio'];
const DOCUMENT_OPERATION_TYPES = new Set<WorkflowDocumentOperation['type']>([
  'add_node', 'create_connected_node', 'update_node', 'delete_nodes', 'delete_connections', 'connect_nodes',
  'move_nodes', 'reorder_nodes', 'reorder_connections', 'group_nodes', 'ungroup_nodes', 'set_batch_primary',
]);
const DOCUMENT_MUTATION_COMMANDS = new Set([
  'workflow.apply', 'workflow.node.create', 'workflow.node.create-connected', 'workflow.node.update',
  'workflow.node.delete', 'workflow.node.move', 'workflow.node.resize', 'workflow.connect', 'workflow.disconnect',
]);
export const WORKFLOW_READ_COMMANDS: ReadonlySet<string> = new Set(['workflow.project.list', 'workflow.inspect', 'workflow.selection.get', 'workflow.models.list', 'workflow.shortcut.list', 'workflow.nodes.search', 'workflow.cost.estimate', 'workflow.node.tool.list']);
const SENSITIVE_KEY = /(?:api.?key|authorization|token|secret|password|storage.?key|file.?path|local.?path|data.?url)/i;
const MEDIA_KEY = /^(?:href|poster|src|url)$/i;
const LOCAL_PATH = /^(?:[a-z]:\\|\\\\|\/home\/|\/Users\/|\/tmp\/)/i;

export function redactWorkflowAgentValue<T>(value: T, key = ''): T {
  if (SENSITIVE_KEY.test(key)) return '[redacted]' as T;
  if (typeof value === 'string') {
    if (MEDIA_KEY.test(key) || /^(?:data:|blob:|file:)/i.test(value) || LOCAL_PATH.test(value)) return '[media]' as T;
    return value
      .replace(/(?:data|blob|file):[^\s"']+/gi, '[media]')
      .replace(/(?:[a-z]:\\|\\\\)[^\r\n"']+/gi, '[local-path]') as T;
  }
  if (Array.isArray(value)) return value.map(item => redactWorkflowAgentValue(item)) as T;
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [childKey, redactWorkflowAgentValue(child, childKey)])) as T;
}

const redactNode = (node: WorkflowNode) => ({
  ...redactWorkflowAgentValue(node),
  // 备选 id 可直接用于 media_view / set_batch_primary / ungroup_nodes。
  ...(node.metadata.alternates?.length ? { alternateIds: node.metadata.alternates.map(item => item.id) } : {}),
  metadata: {
    ...redactWorkflowAgentValue(node.metadata),
    hasMedia: Boolean(node.metadata.href || node.metadata.poster || node.metadata.storageKey),
  },
});

const redactProject = (project: WorkflowProject) => ({
  ...redactWorkflowAgentValue(project),
  nodes: project.nodes.map(redactNode),
});

const INSPECT_CHANGE_SET_SUMMARY = 5;
const INSPECT_RECEIPT_SUMMARY = 3;

// inspect 默认只给最近的变更摘要：完整 ChangeSet / Receipt 的 before/after 会把模型上下文塞满。
const inspectProject = (project: WorkflowProject) => {
  const { draftChangeSets = [], workflowMutationReceipts = [], draftRedoStack: _redoStack, ...rest } = redactProject(project);
  return {
    ...rest,
    draftChangeSets: draftChangeSets.slice(-INSPECT_CHANGE_SET_SUMMARY).map(item => ({
      id: item.id,
      at: item.at,
      actor: item.actor,
      intent: item.intent,
      status: item.status,
      baseDraftVersion: item.baseDraftVersion,
      resultDraftVersion: item.resultDraftVersion,
      nodeIds: item.nodeChanges.map(change => change.id),
      connectionIds: item.connectionChanges.map(change => change.id),
    })),
    draftChangeSetsTotal: draftChangeSets.length,
    workflowMutationReceipts: workflowMutationReceipts.slice(-INSPECT_RECEIPT_SUMMARY).map(item => ({
      mutationId: item.mutationId,
      previousRevision: item.previousRevision,
      revision: item.revision,
      replayed: item.replayed,
      changeSetId: item.changeSetId,
      createdAt: item.createdAt,
    })),
    workflowMutationReceiptsTotal: workflowMutationReceipts.length,
  };
};

/** 轻量图：只给 id/type/title/位置/尺寸，避免 Agent 每次拉全量 metadata。 */
const inspectSummary = (project: WorkflowProject) => ({
  projectId: project.id,
  title: project.title,
  draftVersion: project.draftVersion || 1,
  selectedNodeIds: project.selectedNodeIds,
  viewport: project.viewport,
  nodes: project.nodes.map(node => ({
    id: node.id,
    type: node.type,
    title: node.title,
    position: node.position,
    width: node.width,
    height: node.height,
    visible: node.isVisible !== false,
    locked: node.isLocked === true,
    status: node.metadata.status || 'idle',
    ...(node.type === 'video' && typeof node.metadata.durationMs === 'number' && node.metadata.durationMs > 0 ? { durationSec: Math.round(node.metadata.durationMs / 100) / 10 } : {}),
    // Context Card：用户定稿的结论，只读；正文用 inspect nodeId 读 metadata.content。
    ...(node.type === CONTEXT_CARD_TYPE ? { contextCard: { readOnly: true, sourceCount: node.metadata.contextCard?.sources.length || 0 } } : {}),
    // Agent 会话卡：会话的投影，只读；不带摘录正文（会话内容不回流进画布摘要）。
    ...(node.type === AGENT_SESSION_TYPE ? { agentSession: { readOnly: true, referenceCount: node.metadata.agentSession?.references.length || 0 } } : {}),
    // 多结果的备选挂在节点上（不是画布节点）；详情用 inspect nodeId 读 metadata.alternates。
    ...(node.metadata.alternates?.length ? { alternateCount: node.metadata.alternates.length, alternateIds: node.metadata.alternates.map(item => item.id) } : {}),
  })),
  connectionCount: project.connections.length,
  connections: project.connections.map(connection => ({
    id: connection.id,
    fromNodeId: connection.fromNodeId,
    toNodeId: connection.toNodeId,
    kind: connection.kind,
    role: connection.role,
    order: connection.order,
  })),
});

/** 单节点详查：含直接入/出边与邻居 id，足够 Agent 做局部修改而不用整图 inspect。 */
const inspectNode = (project: WorkflowProject, nodeId: string) => {
  const node = project.nodes.find(item => item.id === nodeId);
  if (!node) return null;
  const inbound = project.connections.filter(connection => connection.toNodeId === nodeId);
  const outbound = project.connections.filter(connection => connection.fromNodeId === nodeId);
  return {
    projectId: project.id,
    title: project.title,
    draftVersion: project.draftVersion || 1,
    node: redactNode(node),
    inbound,
    outbound,
    upstreamNodeIds: [...new Set(inbound.map(connection => connection.fromNodeId))],
    downstreamNodeIds: [...new Set(outbound.map(connection => connection.toNodeId))],
    ...(generateModeOf(node) ? { references: inspectReferences(project, node) } : {}),
    ...(mediaFacts(node) ? { media: mediaFacts(node) } : {}),
  };
};

/** 生成节点的参考，按 chip 顺序（order 1 起 = 图片1/视频1… 的排序依据），带 role / purpose / region。 */
function inspectReferences(project: WorkflowProject, node: WorkflowNode) {
  const labels = new Map(workflowPromptMentionAttrs(node.id, project.nodes, project.connections).map(item => [item.id, item.label]));
  const byId = new Map(project.nodes.map(item => [item.id, item]));
  return currentGenerateReferences(node, project.nodes, project.connections).map((reference, index) => ({
    order: index + 1,
    nodeId: reference.nodeId,
    label: labels.get(reference.nodeId) || byId.get(reference.nodeId)?.title || reference.nodeId,
    kind: byId.get(reference.nodeId)?.type,
    ...(reference.role ? { role: reference.role } : {}),
    ...(reference.purpose ? { purpose: reference.purpose } : {}),
    ...(reference.region ? { region: reference.region } : {}),
  }));
}

/** 媒体的时长与尺寸（有记录时）：Agent 规划输出时长时不必先 media_view。 */
function mediaFacts(node: WorkflowNode): { durationSec?: number; width?: number; height?: number } | null {
  const metadata = node.metadata;
  const durationSec = typeof metadata.durationMs === 'number' && metadata.durationMs > 0 ? Math.round(metadata.durationMs / 100) / 10 : undefined;
  const width = typeof metadata.naturalWidth === 'number' && metadata.naturalWidth > 0 ? metadata.naturalWidth : undefined;
  const height = typeof metadata.naturalHeight === 'number' && metadata.naturalHeight > 0 ? metadata.naturalHeight : undefined;
  if (durationSec === undefined && width === undefined) return null;
  return { ...(durationSec !== undefined ? { durationSec } : {}), ...(width ? { width } : {}), ...(height ? { height } : {}) };
}

const error = (
  commandId: string,
  code: string,
  message: string,
  details: Pick<NonNullable<WorkflowCommandResult['error']>, 'expectedRevision' | 'actualRevision' | 'changedObjectIds'> = {},
): WorkflowCommandResult => ({ ok: false, commandId, error: { code, message, ...details } });
/** 运行失败的统一错误：保留原错误码，details.run 给出统一终态（P0-3）。 */
const runError = (commandId: string, terminal: WorkflowRunTerminal, message?: string): WorkflowCommandResult => ({
  ok: false,
  commandId,
  error: { code: terminal.failedReason?.code || 'RUN_FAILED', message: message || terminal.failedReason?.message || 'Workflow 生成失败。', details: { run: terminal } },
});
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const requiredString = (value: unknown, label: string) => {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new Error(`${label}不能为空`);
  return text;
};
const finiteNumber = (value: unknown, label: string, fallback?: number) => {
  if ((value === undefined || value === null || value === '') && fallback !== undefined) return fallback;
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label}必须是有限数字`);
  return number;
};
const positiveNumber = (value: unknown, label: string) => {
  const number = finiteNumber(value, label);
  if (number <= 0) throw new Error(`${label}必须大于 0`);
  return number;
};
const recordArg = (value: unknown, label: string) => {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error(`${label}必须是对象`);
  return value;
};

/** AI/CLI/MCP 驱动的 Draft Action 记入项目草稿日志；纯 UI 手动编辑跳过（手动编辑已有独立撤销栈）。 */
function draftLogPatch(
  project: WorkflowProject,
  envelope: WorkflowCommandEnvelope,
  ok: boolean,
  extra?: { message?: string; nodeIds?: string[]; connectionIds?: string[] },
): Partial<WorkflowProject> {
  if (envelope.source === 'ui') return {};
  const entry = createWorkflowDraftLogEntry({
    source: envelope.source,
    command: envelope.command,
    args: envelope.args,
    ok,
    message: extra?.message,
    nodeIds: extra?.nodeIds,
    connectionIds: extra?.connectionIds,
  });
  return { draftLog: appendWorkflowDraftLog(project, entry).draftLog };
}

function validatedNode(args: Record<string, unknown>, fallbackId?: string): WorkflowNode {
  if (args.type === undefined || args.type === null || args.type === '') throw new Error('type 不能为空：image / video / audio（文本备注请用 iris_note_write）');
  const type = String(args.type) as WorkflowNodeType;
  if (!NODE_TYPES.includes(type)) throw new Error(`不支持的节点类型：${type}`);
  const metadata = recordArg(args.metadata, 'metadata') as WorkflowNodeMetadata;
  const node = createWorkflowNode(String(args.id || fallbackId || nanoid()), type, {
    x: finiteNumber(args.x, 'x', 0),
    y: finiteNumber(args.y, 'y', 0),
  }, metadata);
  if (args.title !== undefined) node.title = requiredString(args.title, 'title');
  if (args.width !== undefined) node.width = positiveNumber(args.width, 'width');
  if (args.height !== undefined) node.height = positiveNumber(args.height, 'height');
  return node;
}

const AUTO_LAYOUT_GAP_X = 96;
const AUTO_LAYOUT_GAP_Y = 40;

/**
 * Agent 建节点未给 x/y 时的落位：放在上游节点（无上游时为全部节点）右侧一列，
 * 从上游顶边开始向下避让已有节点。旧行为是一律落在 (0,0)，多个节点会叠在原点。
 */
export function autoPlaceWorkflowNode(nodes: WorkflowNode[], node: Pick<WorkflowNode, 'width' | 'height'>, upstreamIds: string[] = []): { x: number; y: number } {
  const upstream = nodes.filter(item => upstreamIds.includes(item.id));
  const anchors = upstream.length ? upstream : nodes;
  if (!anchors.length) return { x: 0, y: 0 };
  const x = Math.max(...anchors.map(item => item.position.x + item.width)) + AUTO_LAYOUT_GAP_X;
  let y = Math.min(...anchors.map(item => item.position.y));
  // y 单调下移，每个阻挡节点至多命中一次。
  for (let guard = 0; guard <= nodes.length; guard += 1) {
    const blocker = nodes.find(item => x < item.position.x + item.width + AUTO_LAYOUT_GAP_Y
      && item.position.x < x + node.width + AUTO_LAYOUT_GAP_Y
      && y < item.position.y + item.height + AUTO_LAYOUT_GAP_Y
      && item.position.y < y + node.height + AUTO_LAYOUT_GAP_Y);
    if (!blocker) break;
    y = blocker.position.y + blocker.height + AUTO_LAYOUT_GAP_Y;
  }
  return { x, y };
}

function withSpecSize(node: WorkflowNode): WorkflowNode {
  const spec = createWorkflowNode(node.id, node.type, node.position || { x: 0, y: 0 });
  return { ...node, position: node.position || spec.position, width: node.width ?? spec.width, height: node.height ?? spec.height };
}

/** workflow.apply 里不带 position 的 add_node / create_connected_node 按同一规则落位；上游取 fromNodeId 或同批 connect_nodes。 */
export function autoPlaceDocumentOperations(nodes: WorkflowNode[], operations: WorkflowDocumentOperation[]): WorkflowDocumentOperation[] {
  const placed = [...nodes];
  return operations.map(op => {
    if (op.type !== 'add_node' && op.type !== 'create_connected_node') return op;
    if (!op.node || typeof op.node !== 'object') return op;
    const sized = withSpecSize(op.node);
    if (op.node.position) {
      placed.push(sized);
      return op;
    }
    const upstreamIds = op.type === 'create_connected_node'
      ? [op.fromNodeId]
      : operations.flatMap(item => (item.type === 'connect_nodes' && item.toNodeId === op.node.id ? [item.fromNodeId] : []));
    const node = { ...sized, position: autoPlaceWorkflowNode(placed, sized, upstreamIds) };
    placed.push(node);
    return { ...op, node };
  });
}

export function documentOperationsArg(value: unknown): WorkflowDocumentOperation[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('operations 必须是非空数组');
  return value.map((operation, index) => {
    if (!isRecord(operation) || typeof operation.type !== 'string' || !DOCUMENT_OPERATION_TYPES.has(operation.type as WorkflowDocumentOperation['type'])) {
      throw new Error('operations[' + index + '] 不是受支持的 Document Operation；可用 type：' + [...DOCUMENT_OPERATION_TYPES].join('、'));
    }
    // 未知字段直接报错并列出可用字段，避免 changes/fields 之类的猜测写法被静默丢弃后误报「无修改」。
    const allowed = (WORKFLOW_OPERATION_FIELDS as Record<string, readonly string[]>)[operation.type];
    if (allowed) {
      const unknownFields = Object.keys(operation).filter(key => !allowed.includes(key));
      if (unknownFields.length) {
        throw new Error('operations[' + index + '] ' + operation.type + ' 不支持字段 ' + unknownFields.join('、') + '；可用字段：' + allowed.join('、'));
      }
    }
    if (operation.type === 'add_node' || operation.type === 'create_connected_node') {
      const node = operation.node;
      if (!isRecord(node) || typeof node.type !== 'string' || !node.type.trim()) {
        throw new Error('operations[' + index + '] ' + operation.type + '.node 必须是带 type 的对象');
      }
      if (node.type === 'operation') {
        throw new Error('operations[' + index + '] 不再支持 operation 节点：生成与后处理的结果直接写成 image / video / audio 结果节点（iris_generate 或 iris_image_tool / iris_video_tool / iris_audio_tool）。');
      }
      // 新节点没给 id 时由系统生成（结果的 affectedNodeIds 会带回）；绝不落一个 id 为空的节点。
      if (typeof node.id === 'string' && node.id.trim()) return operation as unknown as WorkflowDocumentOperation;
      return { ...operation, node: { ...node, id: nanoid() } } as unknown as WorkflowDocumentOperation;
    }
    if (operation.type !== 'update_node') return operation as unknown as WorkflowDocumentOperation;
    // Agent 常把节点 id 写成 nodeId：归一化为 id；缺失时显式报错，不再落成静默空操作。
    const { nodeId, ...rest } = operation;
    const id = typeof rest.id === 'string' && rest.id.trim() ? rest.id
      : typeof nodeId === 'string' && nodeId.trim() ? nodeId
      : '';
    if (!id) throw new Error('operations[' + index + '] update_node 缺少节点 id');
    if (rest.patch !== undefined) {
      if (!isRecord(rest.patch)) throw new Error('operations[' + index + '] update_node.patch 必须是对象');
      const patchFields: readonly string[] = WORKFLOW_NODE_PATCH_FIELDS;
      const unknownPatch = Object.keys(rest.patch).filter(key => !patchFields.includes(key));
      if (unknownPatch.length) {
        throw new Error('operations[' + index + '] update_node.patch 不支持字段 ' + unknownPatch.join('、') + '；可用字段：' + patchFields.join('、') + '（提示词、配置写在 patch.metadata 里）');
      }
    }
    if (rest.metadata !== undefined && !isRecord(rest.metadata)) throw new Error('operations[' + index + '] update_node.metadata 必须是对象');
    if (!isRecord(rest.patch) && !isRecord(rest.metadata)) {
      throw new Error('operations[' + index + '] update_node 需要 patch 或 metadata，例如 {"type":"update_node","id":"' + id + '","patch":{"title":"新标题"}}');
    }
    return { ...rest, id } as unknown as WorkflowDocumentOperation;
  });
}

/**
 * reorder_connections 的 Agent 写法 {targetNodeId, orderedSourceIds}：展开成“断开目标入边 → 按新顺序重连”，
 * 让 Draft ChangeSet 记下真实的连线增删（可撤销、可重放）。同批前面带 id 的 connect_nodes 也算进去。
 * 只给完整 ids 的旧写法同样按目标节点分组展开。
 */
export function expandReferenceReorders(
  connections: readonly WorkflowConnection[],
  operations: WorkflowDocumentOperation[],
  createId: () => string = nanoid,
  /** 某个 reorder_connections 已经是目标顺序（展开为空）时回调：调用方据此报「无需修改」，而不是交给提交层报「ops 为空」。 */
  onNoop?: (note: { index: number; targetNodeId: string; orderedSourceIds: string[] }) => void,
): WorkflowDocumentOperation[] {
  let working: WorkflowConnection[] = [...connections];
  return operations.flatMap((operation, index): WorkflowDocumentOperation[] => {
    if (operation.type === 'connect_nodes' && operation.id) {
      working = [...working, { id: operation.id, fromNodeId: operation.fromNodeId, toNodeId: operation.toNodeId }];
      return [operation];
    }
    if (operation.type === 'delete_connections') {
      const ids = new Set(operation.ids || []);
      working = operation.all ? [] : working.filter(connection => !ids.has(connection.id));
      return [operation];
    }
    if (operation.type !== 'reorder_connections') return [operation];
    const raw = operation as { type: 'reorder_connections'; ids?: unknown; targetNodeId?: unknown; orderedSourceIds?: unknown };
    let plans: Array<{ targetNodeId: string; orderedSourceIds: string[] }>;
    if (raw.targetNodeId === undefined && raw.orderedSourceIds === undefined) {
      if (!Array.isArray(raw.ids) || !raw.ids.length) throw new Error('operations[' + index + '] reorder_connections 需要 targetNodeId + orderedSourceIds，或完整的 ids');
      const byId = new Map(working.map(connection => [connection.id, connection]));
      const ordered = raw.ids.map(id => byId.get(String(id)));
      if (ordered.some(connection => !connection)) throw new Error('operations[' + index + '] reorder_connections.ids 里有不存在的连接 id；推荐改用 {targetNodeId, orderedSourceIds}（上游节点 id）');
      const targets = [...new Set(ordered.map(connection => connection!.toNodeId))];
      // 只需覆盖涉及到的目标节点的全部入边（以前要求列出画布上所有连接）。
      const required = working.filter(connection => targets.includes(connection.toNodeId));
      if (new Set(raw.ids.map(String)).size !== raw.ids.length || raw.ids.length !== required.length) {
        throw new Error('operations[' + index + '] reorder_connections.ids 必须完整列出目标节点（' + targets.join('、') + '）的全部 ' + required.length + ' 条入边且不能重复；推荐改用 {targetNodeId, orderedSourceIds}');
      }
      plans = targets.map(targetNodeId => ({ targetNodeId, orderedSourceIds: ordered.filter(connection => connection!.toNodeId === targetNodeId).map(connection => connection!.fromNodeId) }));
    } else {
      const targetNodeId = requiredString(raw.targetNodeId, 'reorder_connections.targetNodeId');
      if (!Array.isArray(raw.orderedSourceIds) || raw.orderedSourceIds.some(id => typeof id !== 'string')) {
        throw new Error('operations[' + index + '] reorder_connections.orderedSourceIds 必须是节点 id 数组');
      }
      const inbound = new Set(working.filter(connection => connection.toNodeId === targetNodeId).map(connection => connection.fromNodeId));
      const stray = (raw.orderedSourceIds as string[]).filter(id => !inbound.has(id));
      if (stray.length) {
        const connectionIds = new Set(working.filter(connection => connection.toNodeId === targetNodeId).map(connection => connection.id));
        const current = [...inbound].join('、') || '（无）';
        if (stray.every(id => connectionIds.has(id))) {
          throw new Error('operations[' + index + '] reorder_connections.orderedSourceIds 要写上游节点 id，不是连接 id；' + targetNodeId + ' 当前的上游参考按顺序是：' + current);
        }
        throw new Error('operations[' + index + '] reorder_connections：' + stray.join('、') + ' 不是 ' + targetNodeId + ' 的上游参考（当前上游：' + current + '），先 connect_nodes');
      }
      plans = [{ targetNodeId, orderedSourceIds: raw.orderedSourceIds as string[] }];
    }
    return plans.flatMap(plan => {
      const ops = reorderReferenceOperations(working, plan.targetNodeId, plan.orderedSourceIds, () => 'conn-' + createId());
      if (!ops.length) onNoop?.({ index, targetNodeId: plan.targetNodeId, orderedSourceIds: working.filter(connection => connection.toNodeId === plan.targetNodeId).map(connection => connection.fromNodeId) });
      for (const op of ops) {
        if (op.type === 'delete_connections') working = working.filter(connection => !op.ids.includes(connection.id));
        else working = [...working, { id: op.id, fromNodeId: op.fromNodeId, toNodeId: op.toNodeId, kind: op.kind, role: op.role, order: op.order }];
      }
      return ops as WorkflowDocumentOperation[];
    });
  });
}

/** 入边有变化的目标节点：新的参考顺序（可见媒体上游，chip 编号按这个顺序）。 */
function referenceOrderPreview(before: readonly WorkflowConnection[], after: readonly WorkflowConnection[], nodes: readonly WorkflowNode[]): Record<string, string[]> {
  const inbound = (list: readonly WorkflowConnection[], target: string) => list.filter(connection => connection.toNodeId === target).map(connection => connection.fromNodeId).join('|');
  const targets = [...new Set([...before, ...after].map(connection => connection.toNodeId))].filter(target => inbound(before, target) !== inbound(after, target));
  const byId = new Map(nodes.map(node => [node.id, node]));
  return Object.fromEntries(targets.map(target => [target, after
    .filter(connection => connection.toNodeId === target)
    .map(connection => connection.fromNodeId)
    .filter(id => { const node = byId.get(id); return Boolean(node && node.isVisible !== false && ['image', 'video', 'audio'].includes(node.type)); })]));
}

const mutationSource = (source: WorkflowCommandEnvelope['source']): WorkflowMutationSource => (
  source === 'operator' ? 'dsh' : source
);

// 节点来源：外部 Agent / CLI / 运维通道新建的节点标 origin='agent'，画布 UI 标 'user'；已显式给出的不覆盖。
export function tagWorkflowNodeOrigin(operations: WorkflowDocumentOperation[], source: WorkflowCommandEnvelope['source']): WorkflowDocumentOperation[] {
  const origin: 'agent' | 'user' = source === 'ui' ? 'user' : 'agent';
  return operations.map(op => {
    if (op.type !== 'add_node' && op.type !== 'create_connected_node') return op;
    if (!op.node || typeof op.node !== 'object' || op.node.metadata?.origin) return op;
    return { ...op, node: { ...op.node, metadata: { ...(op.node.metadata || {}), origin } } };
  });
}

function validateEnvelope(envelope: WorkflowCommandEnvelope): WorkflowCommandResult | null {
  if (!envelope || typeof envelope !== 'object') return error('', 'BAD_REQUEST', '命令 envelope 无效。');
  if (!String(envelope.id || '').trim()) return error('', 'BAD_REQUEST', '命令 id 不能为空。');
  if (!String(envelope.command || '').trim()) return error(envelope.id, 'BAD_REQUEST', '命令名称不能为空。');
  if (!isRecord(envelope.args)) return error(envelope.id, 'BAD_REQUEST', '命令参数必须是对象。');
  if (!['ui', 'cli', 'agent', 'operator'].includes(envelope.source)) return error(envelope.id, 'BAD_REQUEST', '命令来源无效。');
  return null;
}

function requiresWorkflowConfirmation(envelope: WorkflowCommandEnvelope) {
  const isExternalAgent = isExternalAgentEnvelope(envelope);
  if (!isExternalAgent) return false;
  // 批量文档操作里夹带删除节点，与单独 workflow.node.delete 同等风险，必须确认。
  if (envelope.command === 'workflow.apply') {
    try {
      return documentOperationsArg(envelope.args.operations || envelope.args.ops).some(op => op.type === 'delete_nodes');
    } catch {
      return false; // 参数非法时后续执行会直接报错，不会落写。
    }
  }
  // 只写 Prompt Bar 不扣费；run=true 时与 node.run 同等，需要确认。
  if (envelope.command === 'workflow.generate' || envelope.command === 'workflow.shortcut.apply') return envelope.args.run === true || envelope.args.run === 'true';
  if (envelope.command === 'workflow.group.run') return !(envelope.args.dryRun === true || envelope.args['dry-run'] === true);
  if (!WORKFLOW_MUTATION_COMMANDS.has(envelope.command) || !isExternalAgent) return false;
  if (envelope.command === 'workflow.project.delete' || envelope.command === 'workflow.node.delete' || envelope.command === 'workflow.node.run') return true;
  if (envelope.command !== 'workflow.node.tool') return false;
  const tool = String(envelope.args.tool || '');
  if (!isWorkflowNodeTool(tool)) return false;
  // 与工具说明书同一份计费判定：outpaint / mask 等旧工具同样调用付费服务，一样要确认。
  return workflowNodeToolIsPaid(tool);
}

/** 工具策略层用：这条命令是否已经由命令面自己发起确认（避免重复弹窗）。 */
/** 工具参数（去掉命令信封字段）。 */
function nodeToolArgsOf(args: Record<string, unknown>): Record<string, unknown> {
  const toolArgs: Record<string, unknown> = { ...args };
  for (const key of ['projectId', 'nodeId', 'id', 'tool', 'confirmed', 'workspaceMode', 'expectedRevision', 'mutationId']) delete toolArgs[key];
  return toolArgs;
}

/**
 * workflow.node.tool 的提交前检查：工具存在、源节点存在且类型适用、参数符合说明书。
 * 在弹确认卡之前做，跑不起来的调用不会先让用户批准再失败。
 */
export function checkWorkflowNodeToolCall(nodes: readonly WorkflowNode[], args: Record<string, unknown>):
  | { ok: true; nodeId: string; tool: string; toolArgs: Record<string, unknown> }
  | { ok: false; code: string; message: string; details?: Record<string, unknown> } {
  const tool = typeof args.tool === 'string' ? args.tool.trim() : '';
  if (!tool) return { ok: false, code: 'BAD_REQUEST', message: 'tool 不能为空。可用工具见 workflow.node.tool.list。' };
  const spec = workflowNodeToolSpec(tool);
  if (!spec || !isWorkflowNodeTool(tool)) {
    return { ok: false, code: 'BAD_REQUEST', message: `不支持的画布工具：${tool}。可用：${workflowNodeToolSpecs().map(item => item.tool).join('、')}`, details: { tools: workflowNodeToolSpecs().map(item => item.tool) } };
  }
  const toolArgs = nodeToolArgsOf(args);
  const sourceIds = tool === 'video-merge' && Array.isArray(toolArgs.sourceNodeIds) ? toolArgs.sourceNodeIds.map(String) : [];
  const nodeId = String(args.nodeId || args.id || sourceIds[0] || '').trim();
  if (!nodeId) return { ok: false, code: 'BAD_REQUEST', message: 'nodeId 不能为空' };
  if (!nodes.some(item => item.id === nodeId)) return { ok: false, code: 'NOT_FOUND', message: missingNodeMessage(nodes, nodeId) };
  // video-merge 只处理 sourceNodeIds；其他工具处理 nodeId。
  for (const id of sourceIds.length ? sourceIds : [nodeId]) {
    const node = nodes.find(item => item.id === id);
    if (!node) return { ok: false, code: 'NOT_FOUND', message: missingNodeMessage(nodes, id) };
    if (!spec.inputTypes.includes(node.type)) {
      const usable = workflowNodeToolsFor(node.type).map(item => item.tool);
      return {
        ok: false,
        code: 'TOOL_NOT_APPLICABLE',
        message: `${tool}（${spec.label}）只能用于 ${spec.inputTypes.join(' / ')} 节点，${id} 是 ${node.type} 节点。` + (usable.length ? `这个节点可用：${usable.join('、')}` : '这个节点没有可用的画布工具。'),
        details: { nodeId: id, nodeType: node.type, inputTypes: spec.inputTypes, usableTools: usable },
      };
    }
  }
  const capability = getWorkflowOperationCapabilityByNodeTool(tool);
  if (capability) {
    try {
      return { ok: true, nodeId, tool, toolArgs: parseWorkflowOperationNodeToolArguments(capability.id, toolArgs) };
    } catch (cause) {
      const issues = (cause as { issues?: { path?: unknown[]; message?: string }[] }).issues;
      const detail = Array.isArray(issues) && issues.length
        ? issues.map(issue => (issue.path?.length ? issue.path.join('.') + '：' : '') + issue.message).join('；')
        : displayError(cause);
      return { ok: false, code: 'BAD_REQUEST', message: `${tool} 参数不对：${detail}。${spec.usage}`, details: { parameters: spec.parameters } };
    }
  }
  const required = (spec.parameters.required as string[] | undefined) || [];
  const missing = required.filter(key => toolArgs[key] === undefined || toolArgs[key] === '');
  if (missing.length) return { ok: false, code: 'BAD_REQUEST', message: `${tool} 缺少参数：${missing.join('、')}。${spec.usage}`, details: { parameters: spec.parameters } };
  if (tool === 'mask' && !toolArgs.maskNodeId && !toolArgs.maskHref) return { ok: false, code: 'BAD_REQUEST', message: `mask 需要 maskNodeId 或 maskHref。${spec.usage}`, details: { parameters: spec.parameters } };
  return { ok: true, nodeId, tool, toolArgs };
}

export function workflowCommandNeedsConfirmation(command: string, args: Record<string, unknown>): boolean {
  const resolved = resolveWorkflowNodeToolCommand(command, args.tool);
  return requiresWorkflowConfirmation({ id: 'policy-probe', command: resolved.ok ? resolved.command : command, args, source: 'agent' } as WorkflowCommandEnvelope);
}

/**
 * 节点 ID 列表的统一解析（node.run 与 focus.nodes 共用）：
 * 接受数组、逗号分隔字符串（CLI `--node-ids a,b`）或 JSON 数组字符串。
 */
export function parseWorkflowNodeIdList(value: unknown, name = 'nodeIds'): string[] {
  let raw: unknown = value;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.startsWith('[')) {
      try { raw = JSON.parse(trimmed); } catch { throw new Error(name + ' 不是合法的 JSON 数组。'); }
    } else {
      raw = trimmed.split(',');
    }
  }
  if (!Array.isArray(raw)) throw new Error(name + ' 必须是节点 ID 数组或逗号分隔的字符串。');
  const ids = raw.map(item => (typeof item === 'string' ? item.trim() : item)).filter(item => item !== '');
  const nodeIds = [...new Set(ids.map(item => requiredString(item, name)))];
  if (!nodeIds.length) throw new Error(name + ' 不能为空。');
  return nodeIds;
}

/**
 * node.run / generate 的结构化结果：runId、批次（封面 + 全部成员）、每张产物。
 * artifact 字段保留为封面产物，兼容只读单张的旧调用方。
 */
export function workflowRunPayload(run: WorkflowRunResult) {
  const outputs = run.outputs;
  const takes = outputs?.artifacts.map(({ nodeId, artifactId, kind, mimeType }) => ({ nodeId, artifactId, kind, mimeType }))
    || (run.artifact ? [{ nodeId: run.nodeId, artifactId: run.artifact.artifactId, kind: run.artifact.kind, mimeType: run.artifact.mimeType }] : []);
  return {
    runId: run.runId,
    status: terminalFromRunResult(run).status,
    ...(run.artifact ? { artifact: run.artifact } : {}),
    batch: {
      ...(outputs?.batchId ? { batchId: outputs.batchId } : {}),
      headNodeId: outputs?.headNodeId || run.nodeId,
      memberNodeIds: outputs?.nodeIds || [run.nodeId],
    },
    primaryNodeId: outputs?.headNodeId || run.nodeId,
    takes,
  };
}

/** workflow.node.run 的目标节点：nodeId 单跑，或 nodeIds 一次确认后批量并行。 */
function workflowRunNodeIds(args: Record<string, unknown>): string[] {
  if (args.nodeIds === undefined) return [requiredString(args.nodeId || args.id, 'nodeId')];
  if (args.nodeId !== undefined || args.id !== undefined) throw new Error('nodeId 与 nodeIds 只能二选一。');
  return parseWorkflowNodeIdList(args.nodeIds);
}

/** workflow.focus.nodes 的目标节点：与 node.run 相同的列表语义；单个 nodeId 也可以是逗号分隔。 */
function workflowFocusNodeIds(args: Record<string, unknown>): string[] {
  if (args.nodeIds !== undefined) return parseWorkflowNodeIdList(args.nodeIds);
  if (args.nodeId !== undefined) return parseWorkflowNodeIdList(args.nodeId, 'nodeId');
  throw new Error('nodeIds 不能为空');
}

export function createWorkflowDispatcher(dependencies: WorkflowDispatcherDependencies) {
  const idempotencyCache = new Map<string, WorkflowCommandResult>();
  const cache = (key: string | undefined, result: WorkflowCommandResult) => {
    if (!key) return;
    idempotencyCache.set(key, result);
    while (idempotencyCache.size > MAX_IDEMPOTENCY_ENTRIES) idempotencyCache.delete(idempotencyCache.keys().next().value!);
  };

  /** 文档写入的唯一提交路径：draftAuthority 原子应用 → 写回 store → 回读提交结果。 */
  const commitDocument = (
    envelope: WorkflowCommandEnvelope,
    project: WorkflowProject,
    operations: WorkflowDocumentOperation[],
    options: { mutationId: string; expectedRevision: number; intent: string; clientId?: string; expectedObjectVersions?: Record<string, number> },
  ): WorkflowCommandResult => {
    const applied = applyWorkflowMutation(project, {
      clientId: options.clientId,
      projectId: project.id,
      expectedRevision: options.expectedRevision,
      mutationId: options.mutationId,
      source: mutationSource(envelope.source),
      intent: options.intent,
      ops: operations,
      expectedObjectVersions: options.expectedObjectVersions || {},
    });
    if (applied.ok === false) return error(envelope.id, applied.error.code, applied.error.message, {
      expectedRevision: applied.error.expectedRevision,
      actualRevision: applied.error.actualRevision,
      changedObjectIds: applied.error.changedObjectIds,
    });
    const affectedNodeIds = applied.changeSet.nodeChanges.map(change => change.id);
    const affectedConnectionIds = applied.changeSet.connectionChanges.map(change => change.id);
    const affectedIds = {
      ...(affectedNodeIds.length ? { nodeIds: affectedNodeIds } : {}),
      ...(affectedConnectionIds.length ? { connectionIds: affectedConnectionIds } : {}),
    };
    dependencies.updateProject(project.id, {
      nodes: applied.project.nodes,
      connections: applied.project.connections,
      selectedNodeIds: applied.project.selectedNodeIds,
      viewport: applied.project.viewport,
      draftVersion: applied.project.draftVersion,
      draftChangeSets: applied.project.draftChangeSets,
      draftRedoStack: applied.project.draftRedoStack,
      workflowMutationReceipts: applied.project.workflowMutationReceipts,
      ...(applied.receipt.replayed ? {} : draftLogPatch(project, envelope, true, affectedIds)),
    });
    const persistedError = dependencies.persistenceError?.();
    if (persistedError) return error(envelope.id, 'PERSISTENCE_FAILED', 'Workflow 持久化失败，请检查浏览器存储。');
    const committed = dependencies.getState().projects.find(item => item.id === project.id);
    if (!committed) return error(envelope.id, 'COMMIT_FAILED', 'Workflow 修改未提交。');
    const committedObjects = new Map<string, WorkflowNode | WorkflowConnection>([
      ...committed.nodes.map(item => [item.id, item] as const),
      ...committed.connections.map(item => [item.id, item] as const),
    ]);
    const objectVersions = Object.fromEntries(
      [...affectedNodeIds, ...affectedConnectionIds]
        .map(id => [id, committedObjects.get(id)?.objectVersion] as const)
        .filter((entry): entry is readonly [string, number] => typeof entry[1] === 'number'),
    );
    return { ok: true, commandId: envelope.id, result: {
      ...applied.receipt,
      summary: workflowCommandSummary(envelope.command, envelope.args),
      draftVersion: applied.project.draftVersion,
      affectedNodeIds,
      affectedConnectionIds,
      objectVersions,
    } };
  };

  const execute = async (incoming: WorkflowCommandEnvelope): Promise<WorkflowCommandResult> => {
    // 媒体工具命令（workflow.image/video/audio.tool）落到同一个 workflow.node.tool 实现。
    const toolCommand = incoming && typeof incoming === 'object' ? resolveWorkflowNodeToolCommand(String(incoming.command || ''), isRecord(incoming.args) ? incoming.args.tool : undefined) : { ok: true as const, command: '' };
    if (toolCommand.ok === false) return error(incoming.id, 'BAD_REQUEST', toolCommand.message);
    const envelope: WorkflowCommandEnvelope = !incoming || toolCommand.command === incoming.command ? incoming : { ...incoming, command: toolCommand.command };
    const envelopeError = validateEnvelope(envelope);
    if (envelopeError) return envelopeError;
    const documentMutation = DOCUMENT_MUTATION_COMMANDS.has(envelope.command);
    const cacheKey = !documentMutation && !WORKFLOW_READ_COMMANDS.has(envelope.command)
      && envelope.idempotencyKey && `${envelope.source}:${envelope.idempotencyKey}`;
    if (cacheKey && idempotencyCache.has(cacheKey)) return idempotencyCache.get(cacheKey)!;
    const { command, args } = envelope;
    if (command === 'workflow.node.run' && args.nodeIds !== undefined) {
      // 按批审批：清单里每个节点都必须是能运行的生成节点，弹卡之前就把跑不起来的项拒掉。
      const state = dependencies.getState();
      const runProject = state.projects.find(item => item.id === String(args.projectId || state.activeProjectId || ''));
      if (runProject) {
        let requested: string[];
        try { requested = workflowRunNodeIds(args); } catch (cause) { return error(envelope.id, 'BAD_REQUEST', displayError(cause)); }
        const approval = planRunApproval(runProject.nodes, requested);
        if (approval.ok === false) return { ok: false, commandId: envelope.id, error: { code: approval.code, message: approval.message, details: { nodeIds: approval.nodeIds } } };
      }
    }
    if (command === 'workflow.node.tool') {
      const state = dependencies.getState();
      const toolProject = state.projects.find(item => item.id === String(args.projectId || state.activeProjectId || ''));
      if (toolProject) {
        const checked = checkWorkflowNodeToolCall(toolProject.nodes, args);
        if (checked.ok === false) return { ok: false, commandId: envelope.id, error: { code: checked.code, message: checked.message, ...(checked.details ? { details: checked.details } : {}) } };
      }
    }
    if (requiresWorkflowConfirmation(envelope) && !hasWorkflowHumanApproval(envelope)) {
      return {
        ok: true,
        commandId: envelope.id,
        confirmation: { required: true, code: 'CONFIRMATION_REQUIRED', summary: workflowCommandSummary(command, args) },
      };
    }

    try {
      const state = dependencies.getState();
      const projectId = command === 'workflow.apply'
        ? requiredString(args.projectId, 'projectId')
        : String(args.projectId || state.activeProjectId || '');
      const project = state.projects.find(item => item.id === projectId);
      let result: WorkflowCommandResult;

      if (command === 'workflow.project.list') {
        result = { ok: true, commandId: envelope.id, result: state.projects.map(({ id, title, createdAt, updatedAt }) => ({ id, title, createdAt, updatedAt })) };
      } else if (command === 'workflow.project.create') {
        const id = dependencies.createProject(args.title === undefined ? undefined : requiredString(args.title, 'title'));
        const freshProject = dependencies.getState().projects.find(item => item.id === id);
        if (freshProject && envelope.source !== 'ui') {
          dependencies.updateProject(id, draftLogPatch(freshProject, envelope, true));
        }
        result = { ok: true, commandId: envelope.id, result: { projectId: id } };
      } else if (command === 'workflow.project.use') {
        if (!project) return error(envelope.id, 'NOT_FOUND', `Workflow 项目不存在：${projectId}`);
        dependencies.setActiveProject(projectId);
        if (envelope.source !== 'ui') dependencies.updateProject(projectId, draftLogPatch(project, envelope, true));
        result = { ok: true, commandId: envelope.id, result: { projectId } };
      } else if (command === 'workflow.project.delete') {
        if (!project) return error(envelope.id, 'NOT_FOUND', `Workflow 项目不存在：${projectId}`);
        dependencies.deleteProjects([projectId]);
        result = { ok: true, commandId: envelope.id, result: { projectId } };
      } else if (command === 'workflow.inspect') {
        if (!project) return error(envelope.id, 'NOT_FOUND', '当前没有可用的 Workflow 项目。');
        const summary = args.summary === true || args.view === 'summary' || args.mode === 'summary';
        const nodeId = typeof args.nodeId === 'string' ? args.nodeId.trim() : '';
        if (args.ledger === true || args.ledger === 'true' || args.view === 'ledger') {
          // 项目账本：锚点速查 + 镜头表 + 资产索引，从同一份 workflow 推导，不落画布文本节点。
          const ledger = buildProjectLedger(project);
          result = { ok: true, commandId: envelope.id, result: { projectId: project.id, title: project.title, draftVersion: project.draftVersion || 1, ledger, text: renderProjectLedger(ledger) } };
        } else if (nodeId) {
          const scoped = inspectNode(project, nodeId);
          const alternate = scoped ? null : findAlternateOwner(project.nodes, nodeId);
          if (!scoped && !alternate) return error(envelope.id, 'NOT_FOUND', `节点不存在：${nodeId}`);
          result = scoped
            ? { ok: true, commandId: envelope.id, result: scoped }
            : {
              ok: true,
              commandId: envelope.id,
              result: {
                projectId: project.id,
                title: project.title,
                draftVersion: project.draftVersion || 1,
                // 备选不是画布节点：给出它自己的媒体 / 来源，以及所属节点，调用方据此决定查看、设为首图或拆分。
                alternateOf: alternate!.node.id,
                node: redactNode(alternateAsNode(alternate!.node, alternate!.alternate)),
                note: missingNodeMessage(project.nodes, nodeId),
              },
            };
        } else if (summary) {
          result = { ok: true, commandId: envelope.id, result: { ...inspectSummary(project), availableModels: agentModelCatalogSummary() } };
        } else {
          // 制作圣经：结构化的锚点 / 镜头表 / 一致性问题，让 Agent 不必自己从节点里拼项目状态。
          result = { ok: true, commandId: envelope.id, result: { ...inspectProject(project), productionBible: buildProductionBible(project), availableModels: agentModelCatalogSummary() } };
        }
      } else if (command === 'workflow.selection.get') {
        if (!project) return error(envelope.id, 'NOT_FOUND', '当前没有可用的 Workflow 项目。');
        const selectedNodeIds = project.selectedNodeIds.filter(nodeId => project.nodes.some(node => node.id === nodeId));
        result = {
          ok: true,
          commandId: envelope.id,
          result: {
            projectId: project.id,
            selectedNodeIds,
            nodes: project.nodes.filter(node => selectedNodeIds.includes(node.id)).map(redactNode),
            viewport: project.viewport,
            draftVersion: project.draftVersion || 1,
          },
        };
      } else if (command === 'workflow.export') {
        // 只读文档：单媒体原文件 / 多节点或分组 ZIP / 脚本节点 CSV（P1-7）。
        const exportProject = project;
        if (!exportProject) return error(envelope.id, 'NOT_FOUND', '当前没有可用的 Workflow 项目。');
        try {
          const plan = planWorkflowExport(exportProject, {
            nodeIds: args.nodeIds === undefined ? undefined : parseWorkflowNodeIdList(args.nodeIds),
            groupId: typeof args.groupId === 'string' && args.groupId.trim() ? args.groupId.trim() : undefined,
            fileName: typeof args.fileName === 'string' ? args.fileName : undefined,
          });
          const exported = await executeWorkflowExport(plan, dependencies.exportRuntime || browserExportRuntime, {
            save: args.save !== false && args.save !== 'false',
            inline: args.inline === true || args.inline === 'true',
          });
          result = { ok: true, commandId: envelope.id, result: { projectId: exportProject.id, ...exported } };
        } catch (cause) {
          if (cause instanceof WorkflowExportError) {
            return { ok: false, commandId: envelope.id, error: { code: cause.code, message: cause.message, details: cause.details } };
          }
          throw cause;
        }
      } else if (command === 'workflow.nodes.search') {
        if (!project) return error(envelope.id, 'NOT_FOUND', '当前没有可用的 Workflow 项目。');
        result = { ok: true, commandId: envelope.id, result: { projectId: project.id, ...searchWorkflowNodes(project.nodes, nodeSearchQueryFromArgs(args)) } };
      } else if (command === 'workflow.models.list') {
        result = { ok: true, commandId: envelope.id, result: listWorkflowModels(args, dependencies.getUserApiKeys?.() || []) };
      } else if (command === 'workflow.shortcut.list') {
        result = { ok: true, commandId: envelope.id, result: { shortcuts: describeSlashShortcuts() } };
      } else if (command === 'workflow.node.tool.list') {
        // 画布工具说明书：适用节点类型、计费（free / paid / llm）、参数 JSON Schema、产出。
        // nodeId → 只列这个节点能用的；tool → 只看这一个。
        const tool = typeof args.tool === 'string' ? args.tool.trim() : '';
        const nodeId = typeof args.nodeId === 'string' ? args.nodeId.trim() : '';
        let tools = workflowNodeToolSpecs();
        let nodeType: string | undefined;
        if (nodeId) {
          const node = project?.nodes.find(item => item.id === nodeId);
          if (!node) return error(envelope.id, 'NOT_FOUND', project ? missingNodeMessage(project.nodes, nodeId) : '当前没有可用的 Workflow 项目。');
          nodeType = node.type;
          tools = workflowNodeToolsFor(node.type);
        }
        if (tool) {
          if (!workflowNodeToolSpec(tool)) return error(envelope.id, 'BAD_REQUEST', `不支持的画布工具：${tool}。可用：${workflowNodeToolSpecs().map(item => item.tool).join('、')}`);
          tools = tools.filter(item => item.tool === tool);
        }
        result = { ok: true, commandId: envelope.id, result: { ...(nodeId ? { nodeId, nodeType } : {}), tools } };
      } else if (!project) {
        return error(envelope.id, 'NOT_FOUND', '当前没有可用的 Workflow 项目。');
      } else if (command === 'workflow.cost.estimate') {
        // 运行前预估：与审批卡同一份计划，只读、不弹卡、不扣费。nodeIds 与 groupId 二选一。
        const hasGroup = typeof args.groupId === 'string' && args.groupId.trim() !== '';
        if (hasGroup === (args.nodeIds !== undefined)) return error(envelope.id, 'BAD_REQUEST', 'nodeIds 与 groupId 必须且只能给一个。');
        let nodeIds: string[];
        let groupId: string | undefined;
        if (hasGroup) {
          groupId = String(args.groupId).trim();
          if (!isGroupFrame(project.nodes.find(node => node.id === groupId))) return error(envelope.id, 'NOT_FOUND', '分组不存在：' + groupId);
          nodeIds = groupRunOrder(project.nodes, project.connections, groupId);
          if (!nodeIds.length) return error(envelope.id, 'NOTHING_TO_RUN', '分组 ' + groupId + ' 里没有可执行的生成节点（需要写了提示词、未锁定的图片 / 视频节点）。');
        } else {
          nodeIds = parseWorkflowNodeIdList(args.nodeIds);
        }
        const keys = dependencies.getUserApiKeys?.() || [];
        const estimate = estimateRunCost(project.nodes, nodeIds, node => planGenerationGate(node, project, keys));
        if ('ok' in estimate) return { ok: false, commandId: envelope.id, error: { code: estimate.code, message: estimate.message, details: { nodeIds: estimate.nodeIds } } };
        result = { ok: true, commandId: envelope.id, result: { projectId: project.id, ...(groupId ? { groupId } : {}), ...estimate } };
      } else if (command === 'workflow.node.run' || command === 'workflow.node.stop') {
        const nodeIds = command === 'workflow.node.run' ? workflowRunNodeIds(args) : [requiredString(args.nodeId || args.id, 'nodeId')];
        const missingNodeId = nodeIds.find(nodeId => !project.nodes.some(node => node.id === nodeId));
        if (missingNodeId) return error(envelope.id, 'NOT_FOUND', missingNodeMessage(project.nodes, missingNodeId));
        const executor = dependencies.getExecutor?.() || dependencies.executor;
        if (!executor || (command === 'workflow.node.stop' && !executor.stopNode)) {
          return error(envelope.id, 'RUNNER_UNAVAILABLE', command === 'workflow.node.run' ? 'Workflow 生成适配器尚未连接。' : 'Workflow 停止适配器尚未连接。');
        }
        const expectedRevision = args.expectedRevision === undefined ? undefined : finiteNumber(args.expectedRevision, 'expectedRevision');
        if (expectedRevision !== undefined) {
          // 只跑这些节点：它们自 expectedRevision 以来没被改动就照常运行，别的节点被挪动不算冲突。
          const check = checkRevision(project, command, args, expectedRevision);
          if (!check.ok) return error(envelope.id, 'REVISION_CONFLICT', revisionConflictMessage(check), { expectedRevision: check.expectedRevision, actualRevision: check.actualRevision, changedObjectIds: check.changedObjectIds });
        }
        if (command === 'workflow.node.run') {
          // Seedance 合规预检：一项不合格整批不提交，并列出节点（D.4-5）。
          const preflight = seedancePreflightForNodes(nodeIds.map(nodeId => project.nodes.find(node => node.id === nodeId)!), project);
          if (!preflight.ok) {
            return { ok: false, commandId: envelope.id, error: {
              code: 'SEEDANCE_PREFLIGHT_FAILED',
              message: describeSeedanceFailures(preflight),
              details: { failures: preflight.failures },
            } };
          }
        }
        const surface = envelope.source === 'agent' ? 'browser-agent' : envelope.source === 'operator' ? 'runtime' : envelope.source;
        const runCommandFor = (nodeId: string): WorkflowRunCommand => ({ projectId: project.id, nodeId, ...(expectedRevision === undefined ? {} : { expectedRevision }) });
        if (command === 'workflow.node.stop' || nodeIds.length === 1) {
          const [nodeId] = nodeIds;
          let executionResult: WorkflowRunResult | undefined;
          try {
            if (command === 'workflow.node.run') executionResult = await executor.runNode(runCommandFor(nodeId), { surface, correlationId: envelope.id });
            else await executor.stopNode!(runCommandFor(nodeId), { surface, correlationId: envelope.id });
          } catch (cause) {
            const normalized = normalizeWorkflowExecutionError(cause);
            if (command === 'workflow.node.stop') return error(envelope.id, normalized.code, normalized.message);
            return runError(envelope.id, terminalFromFailure(normalized.code, normalized.message, normalized.runId));
          }
          if (executionResult && executionResult.status !== 'completed') return runError(envelope.id, terminalFromRunResult(executionResult));
          const latestProject = dependencies.getState().projects.find(item => item.id === project.id) || project;
          dependencies.updateProject(project.id, draftLogPatch(latestProject, envelope, true, { nodeIds: [nodeId] }));
          result = { ok: true, commandId: envelope.id, result: {
            projectId: project.id,
            nodeId,
            ...(executionResult ? workflowRunPayload(executionResult) : {}),
          } };
        } else {
          // 批量：一次确认覆盖整批；各节点并行交给同一 WorkflowExecutor，逐节点报告结果，失败只影响自身。
          const runs = await Promise.all(nodeIds.map(async nodeId => {
            try {
              const executionResult = await executor.runNode(runCommandFor(nodeId), { surface, correlationId: envelope.id + ':' + nodeId });
              if (executionResult && executionResult.status !== 'completed') {
                const terminal = terminalFromRunResult(executionResult);
                return { nodeId, ok: false, status: terminal.status, runId: executionResult.runId, failedReason: terminal.failedReason, error: terminal.failedReason! };
              }
              return { nodeId, ok: true, ...(executionResult ? workflowRunPayload(executionResult) : { status: 'succeeded' as const }) };
            } catch (cause) {
              const normalized = normalizeWorkflowExecutionError(cause);
              const terminal = terminalFromFailure(normalized.code, normalized.message, normalized.runId);
              return { nodeId, ok: false, status: terminal.status, failedReason: terminal.failedReason, error: terminal.failedReason! };
            }
          }));
          const succeeded = runs.filter(run => run.ok).map(run => run.nodeId);
          if (!succeeded.length) {
            const first = runs.map(run => ('error' in run ? run.error : undefined)).find(Boolean);
            return { ok: false, commandId: envelope.id, error: { code: first?.code || 'RUN_FAILED', message: '批量运行的 ' + runs.length + ' 个节点全部失败：' + (first?.message || ''), details: { runs: runs.map(run => ({ nodeId: run.nodeId, status: run.status, failedReason: 'failedReason' in run ? run.failedReason : undefined })) } } };
          }
          const latestProject = dependencies.getState().projects.find(item => item.id === project.id) || project;
          dependencies.updateProject(project.id, draftLogPatch(latestProject, envelope, true, { nodeIds: succeeded }));
          result = { ok: true, commandId: envelope.id, result: { projectId: project.id, runs, failed: runs.length - succeeded.length } };
        }
      } else if (command === 'workflow.generate' || command === 'workflow.shortcut.apply') {
        const isShortcut = command === 'workflow.shortcut.apply';
        const mutationId = String(args.mutationId || envelope.idempotencyKey || '').trim() || (isShortcut ? 'shortcut-' : 'generate-') + envelope.id;
        const expectedRevision = args.expectedRevision === undefined ? (project.draftVersion || 1) : finiteNumber(args.expectedRevision, 'expectedRevision');
        let plan: ReturnType<typeof planWorkflowGenerate>;
        let shortcutSummary: Record<string, unknown> | undefined;
        try {
          if (isShortcut) {
            const scene = typeof args.scene === 'string' ? args.scene.trim() : '';
            const shortcut = getSlashShortcut(scene);
            if (!shortcut) return error(envelope.id, 'NOT_FOUND', '没有这个快捷工具：' + (scene || '（空）') + '；先调用 workflow.shortcut.list。可用：' + SLASH_SHORTCUTS.map(item => item.scene).join('、'));
            const applied = buildShortcutApplyOps({
              shortcut,
              nodes: project.nodes,
              connections: project.connections,
              targetId: typeof args.nodeId === 'string' && args.nodeId.trim() ? args.nodeId.trim() : undefined,
              text: typeof args.text === 'string' ? args.text : undefined,
              mutationId,
              keys: dependencies.getUserApiKeys?.() || [],
              place: (node, upstreamIds) => autoPlaceWorkflowNode(project.nodes, node, upstreamIds),
            });
            plan = applied.plan;
            shortcutSummary = { scene: shortcut.scene, placement: applied.placement, sourceIds: applied.sourceIds, ...(applied.grid ? { grid: applied.grid, splitTool: 'image.split-grid@1' } : {}) };
          } else {
            plan = planWorkflowGenerate({
              nodes: project.nodes,
              connections: project.connections,
              args,
              mutationId,
              keys: dependencies.getUserApiKeys?.() || [],
              place: (node, upstreamIds) => autoPlaceWorkflowNode(project.nodes, node, upstreamIds),
            });
          }
        } catch (cause) {
          if (!(cause instanceof WorkflowGenerateError) && !(cause instanceof SlashShortcutError)) throw cause;
          const compatible = Array.isArray(cause.details?.compatibleModels) ? cause.details.compatibleModels as Array<{ id: string; configured?: boolean }> : [];
          const hint = compatible.length ? ' 可用模型：' + compatible.slice(0, 8).map(item => item.id + (item.configured ? '' : '（未配置）')).join('、') : '';
          return { ok: false, commandId: envelope.id, error: { code: cause.code, message: cause.message + hint, ...(cause.details ? { details: cause.details } : {}) } };
        }
        const summary = {
          ...(shortcutSummary || {}),
          projectId: project.id,
          nodeId: plan.nodeId,
          created: plan.created,
          mode: plan.mode,
          prompt: plan.prompt,
          model: plan.model,
          references: plan.references,
          referenceSource: plan.referenceSource,
          autoLinked: plan.autoLinked,
          diagnostics: plan.diagnostics,
        };
        if (args.dryRun === true || args['dry-run'] === true) {
          result = { ok: true, commandId: envelope.id, result: { ...summary, dryRun: true, applied: false, draftVersion: project.draftVersion || 1, operationCount: plan.operations.length, willRun: args.run === true } };
          cache(cacheKey, result);
          return result;
        }
        const committed = commitDocument(envelope, project, tagWorkflowNodeOrigin(plan.operations, envelope.source), {
          mutationId,
          expectedRevision,
          intent: (isShortcut ? '快捷工具「' + String(shortcutSummary?.scene) + '」：' : '') + (plan.created ? '新建生成节点并写入提示词：' : '写入提示词：') + plan.nodeId,
        });
        // 内容与节点完全一致（例如先 run=false 写好、再用同样参数 run=true）：没有可提交的修改不算失败，按当前节点继续。
        const unchanged = !committed.ok && committed.error?.message.startsWith('该操作没有修改 Workflow Draft');
        if (!committed.ok && !unchanged) return committed;
        const draftVersion = unchanged ? (project.draftVersion || 1) : (committed.result as { draftVersion?: number }).draftVersion;
        // P0-A：回读已提交的节点核对 mode / submode / 参考；不一致时不运行（写入已完成，可撤销），把问题结构化交回。
        const committedProject = dependencies.getState().projects.find(item => item.id === project.id);
        const invariantIssues = committedProject ? checkGenerateInvariant(plan, committedProject, args) : [];
        const wantsRun = args.run === true || args.run === 'true';
        if (invariantIssues.length && wantsRun) {
          return { ok: false, commandId: envelope.id, error: {
            code: 'GENERATE_INVARIANT_FAILED',
            message: '提示词已写入节点 ' + plan.nodeId + '，但写入结果与请求不一致，没有运行（避免花钱生成错的东西）：' + invariantIssues.map(issue => issue.message).join('；'),
            retryable: false,
            details: { nodeId: plan.nodeId, draftVersion, issues: invariantIssues, references: plan.references, model: plan.model },
          } };
        }
        const warnings = invariantIssues.length ? { warnings: invariantIssues } : {};
        if (!wantsRun) {
          result = { ok: true, commandId: envelope.id, result: { ...summary, ...warnings, draftVersion, ran: false } };
        } else {
          const executor = dependencies.getExecutor?.() || dependencies.executor;
          if (!executor) return error(envelope.id, 'RUNNER_UNAVAILABLE', '提示词已写入节点 ' + plan.nodeId + '；Workflow 生成适配器尚未连接，无法运行。');
          const surface = envelope.source === 'agent' ? 'browser-agent' : envelope.source === 'operator' ? 'runtime' : envelope.source;
          let executionResult: WorkflowRunResult;
          try {
            executionResult = await executor.runNode({ projectId: project.id, nodeId: plan.nodeId, promptIntent: plan.promptIntent }, { surface, correlationId: envelope.id });
          } catch (cause) {
            const normalized = normalizeWorkflowExecutionError(cause);
            return runError(envelope.id, terminalFromFailure(normalized.code, normalized.message, normalized.runId), '提示词已写入节点 ' + plan.nodeId + '；运行失败：' + normalized.message);
          }
          if (executionResult.status !== 'completed') {
            const terminal = terminalFromRunResult(executionResult);
            return runError(envelope.id, terminal, '提示词已写入节点 ' + plan.nodeId + '；' + (executionResult.status === 'cancelled' ? '' : '运行失败：') + terminal.failedReason!.message);
          }
          result = { ok: true, commandId: envelope.id, result: { ...summary, draftVersion, ran: true, run: workflowRunPayload(executionResult) } };
        }
      } else if (command === 'workflow.group.create') {
        const nodeIds = parseWorkflowNodeIdList(args.nodeIds);
        const mutationId = String(args.mutationId || envelope.idempotencyKey || '').trim() || 'group-' + envelope.id;
        const expectedRevision = args.expectedRevision === undefined ? (project.draftVersion || 1) : finiteNumber(args.expectedRevision, 'expectedRevision');
        let plan: ReturnType<typeof buildGroupCreateOps>;
        try {
          plan = buildGroupCreateOps(project.nodes, nodeIds, { groupId: stableShortId('group-', mutationId), title: typeof args.title === 'string' ? args.title : undefined });
        } catch (cause) {
          if (cause instanceof WorkflowGroupError) return error(envelope.id, cause.code, cause.message);
          throw cause;
        }
        const committed = commitDocument(envelope, project, plan.ops, { mutationId, expectedRevision, intent: '分组：' + plan.memberIds.length + ' 个节点' });
        if (!committed.ok) return committed;
        result = { ok: true, commandId: envelope.id, result: { projectId: project.id, groupId: plan.groupId, memberIds: plan.memberIds, draftVersion: (committed.result as { draftVersion?: number }).draftVersion } };
      } else if (command === 'workflow.group.run') {
        const groupId = requiredString(args.groupId, 'groupId');
        if (!isGroupFrame(project.nodes.find(node => node.id === groupId))) return error(envelope.id, 'NOT_FOUND', '分组不存在：' + groupId + '（先用 workflow.group.create 建分组）');
        const order = groupRunOrder(project.nodes, project.connections, groupId);
        if (!order.length) return error(envelope.id, 'NOTHING_TO_RUN', '分组 ' + groupId + ' 里没有可执行的生成节点（需要写了提示词、未锁定的图片 / 视频节点）。');
        if (args.dryRun === true || args['dry-run'] === true) {
          result = { ok: true, commandId: envelope.id, result: { projectId: project.id, groupId, order, dryRun: true } };
          cache(cacheKey, result);
          return result;
        }
        const executor = dependencies.getExecutor?.() || dependencies.executor;
        if (!executor) return error(envelope.id, 'RUNNER_UNAVAILABLE', 'Workflow 生成适配器尚未连接。');
        const surface = envelope.source === 'agent' ? 'browser-agent' : envelope.source === 'operator' ? 'runtime' : envelope.source;
        // 整组执行：一次确认覆盖整组；按依赖拓扑顺序逐个运行（下游等上游出图），上游失败时跳过依赖它的下游。
        const failed = new Set<string>();
        const runs: Array<{ nodeId: string; ok: boolean; skipped?: boolean; error?: { code: string; message: string } } & Record<string, unknown>> = [];
        for (const nodeId of order) {
          const blockedBy = project.connections.find(connection => connection.toNodeId === nodeId && failed.has(connection.fromNodeId))?.fromNodeId;
          if (blockedBy) {
            failed.add(nodeId);
            runs.push({ nodeId, ok: false, skipped: true, error: { code: 'UPSTREAM_FAILED', message: '上游节点 ' + blockedBy + ' 失败，已跳过。' } });
            continue;
          }
          try {
            const executionResult = await executor.runNode({ projectId: project.id, nodeId }, { surface, correlationId: envelope.id + ':' + nodeId });
            if (executionResult?.status === 'failed' || executionResult?.status === 'cancelled') {
              failed.add(nodeId);
              runs.push({ nodeId, ok: false, error: { code: executionResult.status === 'cancelled' ? 'RUN_CANCELLED' : executionResult.error?.code || 'RUN_FAILED', message: executionResult.error?.message || (executionResult.status === 'cancelled' ? '生成已停止。' : 'Workflow 生成失败。') } });
              continue;
            }
            runs.push({ nodeId, ok: true, ...(executionResult ? workflowRunPayload(executionResult) : {}) });
          } catch (cause) {
            const normalized = normalizeWorkflowExecutionError(cause);
            failed.add(nodeId);
            runs.push({ nodeId, ok: false, error: { code: normalized.code, message: normalized.message } });
          }
        }
        const succeeded = runs.filter(run => run.ok).map(run => run.nodeId);
        if (!succeeded.length) return error(envelope.id, runs[0]?.error?.code || 'RUN_FAILED', '整组 ' + order.length + ' 个节点全部失败：' + (runs[0]?.error?.message || ''));
        const latestProject = dependencies.getState().projects.find(item => item.id === project.id) || project;
        dependencies.updateProject(project.id, draftLogPatch(latestProject, envelope, true, { nodeIds: succeeded }));
        result = { ok: true, commandId: envelope.id, result: { projectId: project.id, groupId, order, runs, failed: runs.length - succeeded.length } };
      } else if (command === 'workflow.note.write') {
        const content = typeof args.text === 'string' ? args.text : typeof args.content === 'string' ? args.content : '';
        if (!content.trim()) throw new Error('text 不能为空');
        const mutationId = String(args.mutationId || envelope.idempotencyKey || '').trim() || 'note-' + envelope.id;
        const expectedRevision = args.expectedRevision === undefined ? (project.draftVersion || 1) : finiteNumber(args.expectedRevision, 'expectedRevision');
        const noteId = typeof args.noteId === 'string' ? args.noteId.trim() : '';
        let operation: WorkflowDocumentOperation;
        let targetNoteId: string;
        if (noteId) {
          const existing = project.nodes.find(node => node.id === noteId);
          if (!existing) return error(envelope.id, 'NOT_FOUND', '备注不存在：' + noteId);
          if (existing.type !== 'text') return error(envelope.id, 'BAD_REQUEST', '节点 ' + noteId + ' 不是备注；生成节点的提示词请用 iris_generate 写入。');
          operation = { type: 'update_node', id: noteId, metadata: { content }, ...(typeof args.title === 'string' && args.title.trim() ? { patch: { title: args.title.trim() } } : {}) };
          targetNoteId = noteId;
        } else {
          targetNoteId = stableShortId('note-', mutationId);
          const node = createWorkflowNode(targetNoteId, 'text', { x: 0, y: 0 }, { content, origin: 'agent' });
          node.title = typeof args.title === 'string' && args.title.trim() ? args.title.trim() : '备注';
          const anchorId = typeof args.attachToNodeId === 'string' ? args.attachToNodeId.trim() : '';
          const anchor = anchorId ? project.nodes.find(item => item.id === anchorId) : undefined;
          if (anchorId && !anchor) return error(envelope.id, 'NOT_FOUND', '节点不存在：' + anchorId);
          const gap = 48;
          const placement = String(args.placement || 'right');
          if (!['right', 'below', 'above', 'left'].includes(placement)) throw new Error('placement 只能是 right / below / above / left');
          node.position = anchor
            ? placement === 'below' ? { x: anchor.position.x, y: anchor.position.y + anchor.height + gap }
              : placement === 'above' ? { x: anchor.position.x, y: anchor.position.y - node.height - gap }
              : placement === 'left' ? { x: anchor.position.x - node.width - gap, y: anchor.position.y }
              : { x: anchor.position.x + anchor.width + gap, y: anchor.position.y }
            : autoPlaceWorkflowNode(project.nodes, node);
          // 备注永远不连线：不进生成链，也不当参考
          operation = { type: 'add_node', node };
        }
        const committed = commitDocument(envelope, project, [operation], { mutationId, expectedRevision, intent: noteId ? '更新备注：' + noteId : '写备注' });
        if (!committed.ok) return committed;
        result = { ok: true, commandId: envelope.id, result: { projectId: project.id, noteId: targetNoteId, created: !noteId, draftVersion: (committed.result as { draftVersion?: number }).draftVersion } };
      } else if (command === 'workflow.script.materialize') {
        const scriptNodeId = typeof args.scriptNodeId === 'string' ? args.scriptNodeId.trim() : '';
        if (!scriptNodeId) throw new Error('scriptNodeId 不能为空');
        const kind = args.kind === undefined || args.kind === '' ? 'image' : args.kind;
        if (kind !== 'image' && kind !== 'video') throw new Error('kind 只能是 image 或 video');
        const script = project.nodes.find(node => node.id === scriptNodeId);
        if (!script) return error(envelope.id, 'NOT_FOUND', '脚本节点不存在：' + scriptNodeId);
        if (script.type === 'text') return error(envelope.id, 'NOTE_IS_ANNOTATION', NOTE_IS_ANNOTATION_MESSAGE);
        const mutationId = String(args.mutationId || envelope.idempotencyKey || '').trim() || 'materialize-' + envelope.id;
        const expectedRevision = args.expectedRevision === undefined ? (project.draftVersion || 1) : finiteNumber(args.expectedRevision, 'expectedRevision');
        let sequence = 0;
        let plan: ReturnType<typeof buildScriptMaterializeOps>;
        try {
          plan = buildScriptMaterializeOps(script, {
            kind,
            rows: Array.isArray(args.rows) ? args.rows.map(Number) : typeof args.rows === 'number' ? String(args.rows) : args.rows as string | undefined,
            nodes: project.nodes,
            connections: project.connections,
            // 同一 mutationId 重放得到相同节点 id（幂等）
            createId: () => stableShortId('shot-', mutationId + ':' + (sequence++)),
          });
        } catch (cause) {
          if (cause instanceof ScriptMaterializeError) return error(envelope.id, cause.code === 'NOT_SCRIPT' ? 'UNSUPPORTED_TARGET' : cause.code, cause.message);
          throw cause;
        }
        const dryRun = args.dryRun === true || args['dry-run'] === true;
        const summary = {
          projectId: project.id,
          scriptNodeId,
          kind,
          nodeIds: plan.created.map(item => item.nodeId),
          created: plan.created,
          skipped: plan.skipped,
          diagnostics: plan.diagnostics,
          ...(plan.batchId ? { batchId: plan.batchId } : {}),
          ran: false,
          next: plan.created.length ? '节点已建好、未运行。确认后用 iris_workflow_node_run 的 nodeIds 运行（可分批）。' : '没有需要新建的分镜节点。',
        };
        if (dryRun || !plan.operations.length) {
          result = { ok: true, commandId: envelope.id, result: { ...summary, dryRun, applied: false, draftVersion: project.draftVersion || 1 } };
        } else {
          const committed = commitDocument(envelope, project, tagWorkflowNodeOrigin(plan.operations, envelope.source), {
            mutationId,
            expectedRevision,
            intent: `分镜建${kind === 'image' ? '图片' : '视频'}生成节点：${plan.created.map(item => item.row).join(',')}`,
          });
          if (!committed.ok) return committed;
          result = { ok: true, commandId: envelope.id, result: { ...summary, applied: true, draftVersion: (committed.result as { draftVersion?: number }).draftVersion } };
        }
      } else if (command === 'workflow.media.import') {
        const url = typeof args.url === 'string' ? args.url.trim() : '';
        const assetId = typeof args.assetId === 'string' ? args.assetId.trim() : '';
        if (Boolean(url) === Boolean(assetId)) throw new Error('url 与 assetId 必须二选一');
        const mutationId = String(args.mutationId || envelope.idempotencyKey || '').trim() || 'import-' + envelope.id;
        const expectedRevision = args.expectedRevision === undefined ? (project.draftVersion || 1) : finiteNumber(args.expectedRevision, 'expectedRevision');
        const attachToNodeId = typeof args.attachToNodeId === 'string' ? args.attachToNodeId.trim() : '';
        const attachTarget = attachToNodeId ? project.nodes.find(node => node.id === attachToNodeId) : undefined;
        if (attachToNodeId && !attachTarget) return error(envelope.id, 'NOT_FOUND', '节点不存在：' + attachToNodeId);
        if (attachTarget && !generateModeOf(attachTarget)) {
          return error(envelope.id, attachTarget.type === 'text' ? 'NOTE_IS_ANNOTATION' : 'BAD_REQUEST', '只能把素材接到图片/视频生成节点上作参考：' + attachToNodeId);
        }
        const importedId = stableShortId('media-', mutationId);
        let imported: WorkflowImportedMedia;
        if (assetId) {
          const asset = dependencies.lookupAsset?.(assetId);
          if (!asset) return error(envelope.id, 'NOT_FOUND', '素材库里没有这个素材：' + assetId);
          const type = asset.mimeType.startsWith('video/') ? 'video' : asset.mimeType.startsWith('audio/') ? 'audio' : 'image';
          const spec = createWorkflowNode(importedId, type, { x: 0, y: 0 });
          imported = {
            type,
            metadata: { sourceType: 'assetLibrary', assetId, href: 'asset-library:' + assetId, name: asset.name || '素材引用', mimeType: asset.mimeType, naturalWidth: asset.width, naturalHeight: asset.height, status: 'success' },
            width: spec.width,
            height: spec.height,
          };
        } else {
          if (!/^https?:\/\//i.test(url)) throw new Error('url 只支持 http(s) 地址');
          // 同一 mutationId 重放：节点已在画布上就不再下载
          if (project.nodes.some(node => node.id === importedId)) {
            result = { ok: true, commandId: envelope.id, result: { projectId: project.id, nodeId: importedId, replayed: true, draftVersion: project.draftVersion || 1 } };
            cache(cacheKey, result);
            return result;
          }
          try {
            imported = await (dependencies.importMediaUrl || browserImportMediaUrl)(url);
          } catch (cause) {
            return error(envelope.id, 'IMPORT_FAILED', '素材导入失败：' + displayError(cause));
          }
        }
        const node = { ...createWorkflowNode(importedId, imported.type, { x: 0, y: 0 }, imported.metadata), width: imported.width, height: imported.height, freeResize: false };
        if (typeof args.title === 'string' && args.title.trim()) node.title = args.title.trim();
        node.position = attachTarget
          ? { x: attachTarget.position.x + attachTarget.width / 2 - node.width / 2, y: attachTarget.position.y - node.height - 100 }
          : autoPlaceWorkflowNode(project.nodes, node);
        const operations: WorkflowDocumentOperation[] = [{ type: 'add_node', node }];
        let mentioned = false;
        if (attachTarget) {
          const connectionId = 'conn-' + importedId;
          operations.push({ type: 'connect_nodes', id: connectionId, fromNodeId: importedId, toNodeId: attachTarget.id });
          // 默认同时在目标 Prompt Bar 末尾加 @chip：有 mention 时未被 mention 的上游不会参与生成
          if (args.mention !== false) {
            const nodes = [...project.nodes, node];
            const connections = [...project.connections, { id: connectionId, fromNodeId: importedId, toNodeId: attachTarget.id }];
            const previousIds = promptDocumentMentions(attachTarget.metadata.richTextDocument).map(item => item.id);
            const built = buildWorkflowPromptDocument({
              text: attachTarget.metadata.prompt || '',
              targetNodeId: attachTarget.id,
              nodes,
              connections,
              ensureMentionIds: [...previousIds, importedId],
            });
            operations.push({ type: 'update_node', id: attachTarget.id, metadata: { prompt: built.prompt, richTextDocument: built.richTextDocument } });
            mentioned = built.mentionIds.includes(importedId);
          }
        }
        const committed = commitDocument(envelope, project, tagWorkflowNodeOrigin(operations, envelope.source), { mutationId, expectedRevision, intent: '导入素材：' + (node.title || importedId) });
        if (!committed.ok) {
          await imported.discard?.();
          return committed;
        }
        imported.commit?.();
        result = { ok: true, commandId: envelope.id, result: {
          projectId: project.id,
          nodeId: importedId,
          type: imported.type,
          ...(attachTarget ? { attachedTo: attachTarget.id, mentioned } : {}),
          draftVersion: (committed.result as { draftVersion?: number }).draftVersion,
        } };
      } else if (command === 'workflow.node.tool') {
        const checked = checkWorkflowNodeToolCall(project.nodes, args);
        if (checked.ok === false) return { ok: false, commandId: envelope.id, error: { code: checked.code, message: checked.message, ...(checked.details ? { details: checked.details } : {}) } };
        const { nodeId, tool, toolArgs: normalizedArgs } = checked;
        const runner = dependencies.nodeToolRunner;
        if (!runner) return error(envelope.id, 'RUNNER_UNAVAILABLE', 'Workflow 画布工具适配器尚未连接。');
        // 兜底：上面的确认判定若漏判付费工具，这里按计费说明书拿不到凭证，仍然先要人工确认。
        const grant = nodeToolSpendGrant(envelope, tool);
        if (!grant) {
          return { ok: true, commandId: envelope.id, confirmation: { required: true, code: 'CONFIRMATION_REQUIRED', summary: workflowCommandSummary(command, args) } };
        }
        const outcome = await runner(project.id, nodeId, tool, normalizedArgs, grant);
        const committed = Boolean(outcome && typeof outcome === 'object' && (outcome as { status?: string }).status === 'committed');
        // 把新产出的节点 ID 交回调用方（Agent 据此继续连线或运行），不用再整图 inspect 一次。
        const before = new Set(project.nodes.map(node => node.id));
        const after = dependencies.getState().projects.find(item => item.id === project.id)?.nodes || [];
        // 没有 operation 中间节点：新建的都是结果节点；resultNodeId 是带生成记录、可原位重跑 / 切换 take 的主结果。
        const outputNodeIds = after.filter(node => !before.has(node.id) && node.type !== 'operation').map(node => node.id);
        const resultNodeId = after.find(node => !before.has(node.id) && node.metadata.operation)?.id;
        dependencies.updateProject(project.id, draftLogPatch(project, envelope, true, { nodeIds: [nodeId] }));
        result = { ok: true, commandId: envelope.id, result: { projectId: project.id, nodeId, tool, committed, outputNodeIds, ...(resultNodeId ? { resultNodeId } : {}) } };
      } else {
        const requestedNodeId = String(args.nodeId || args.id || '');
        if (['workflow.node.update', 'workflow.node.delete', 'workflow.node.move', 'workflow.node.resize'].includes(command)
          && !project.nodes.some(node => node.id === requestedNodeId)) return error(envelope.id, 'NOT_FOUND', `节点不存在：${requestedNodeId}`);
        if (command === 'workflow.disconnect' && !project.connections.some(connection => connection.id === String(args.connectionId || args.id || ''))) {
          return error(envelope.id, 'NOT_FOUND', '指定的连接不存在。');
        }
        const mutationId = command === 'workflow.apply'
          ? requiredString(args.mutationId, 'mutationId')
          : requiredString(args.mutationId || envelope.idempotencyKey || args.changeSetId || envelope.id, 'mutationId');
        if (command === 'workflow.apply' && args.expectedRevision === undefined) throw new Error('expectedRevision 不能为空');
        const expectedRevision = args.expectedRevision === undefined ? (project.draftVersion || 1) : finiteNumber(args.expectedRevision, 'expectedRevision');
        let operation: WorkflowDocumentOperation | undefined;
        let operations: WorkflowDocumentOperation[] | undefined;
        const noopOperations: Array<{ index: number; targetNodeId: string; orderedSourceIds: string[]; reason: string }> = [];
        if (command === 'workflow.apply') {
          const requested = documentOperationsArg(args.operations || args.ops);
          operations = expandReferenceReorders(project.connections, autoPlaceDocumentOperations(project.nodes, requested), nanoid, note => noopOperations.push({ ...note, reason: '参考顺序已经是 ' + note.orderedSourceIds.join(' → ') + '，无需修改' }));
          if (!operations.length) {
            // P1-C：只有已经有序的 reorder_connections 时，展开后没有任何写入；以前直接交给提交层，报「ops 至少包含一个 Document Operation」。
            result = { ok: true, commandId: envelope.id, result: {
              projectId: project.id,
              applied: false,
              noop: true,
              ...(args.dryRun === true || args['dry-run'] === true ? { dryRun: true } : {}),
              draftVersion: project.draftVersion || 1,
              operationCount: 0,
              noopOperations,
              message: noopOperations.map(item => 'operations[' + item.index + '] ' + item.reason).join('；') || '没有需要写入的修改',
            } };
            cache(cacheKey, result);
            return result;
          }
        } else if (command === 'workflow.node.create') {
          const node = validatedNode(args, 'node-' + mutationId);
          if (args.x === undefined && args.y === undefined) node.position = autoPlaceWorkflowNode(project.nodes, node);
          operation = { type: 'add_node', node };
        } else if (command === 'workflow.node.create-connected') {
          const fromNodeId = requiredString(args.fromNodeId || args.from, 'fromNodeId');
          const node = validatedNode(args, 'node-' + mutationId);
          if (args.x === undefined && args.y === undefined) node.position = autoPlaceWorkflowNode(project.nodes, node, [fromNodeId]);
          operation = { type: 'create_connected_node', fromNodeId, node };
        } else if (command === 'workflow.node.update') {
          const patch: Record<string, unknown> = { ...recordArg(args.patch || args.updates, 'patch') };
          // 常用字段的简写：--title 等价于 --patch-json '{"title":…}'（以前被静默忽略，报「写入内容与当前节点完全一致」）。
          if (args.title !== undefined && patch.title === undefined) patch.title = requiredString(args.title, 'title');
          if ('id' in patch) throw new Error('patch 不能修改节点 id');
          if (Object.keys(patch).length === 0) throw new Error('workflow.node.update 缺少要修改的内容：用 --patch-json \'{"title":"新标题"}\'（或 --title）指定要改的字段。');
          operation = { type: 'update_node', id: requiredString(requestedNodeId, 'nodeId'), patch: patch as never };
        } else if (command === 'workflow.node.delete') {
          operation = { type: 'delete_nodes', ids: [requiredString(requestedNodeId, 'nodeId')] };
        } else if (command === 'workflow.node.move') {
          operation = { type: 'move_nodes', positions: [{ id: requiredString(requestedNodeId, 'nodeId'), position: { x: finiteNumber(args.x, 'x'), y: finiteNumber(args.y, 'y') } }] };
        } else if (command === 'workflow.node.resize') {
          operation = { type: 'update_node', id: requiredString(requestedNodeId, 'nodeId'), patch: { width: positiveNumber(args.width, 'width'), height: positiveNumber(args.height, 'height') } };
        } else if (command === 'workflow.connect') {
          operation = { type: 'connect_nodes', id: args.id ? requiredString(args.id, 'id') : undefined, fromNodeId: requiredString(args.fromNodeId || args.from, 'fromNodeId'), toNodeId: requiredString(args.toNodeId || args.to, 'toNodeId') };
        } else if (command === 'workflow.disconnect') {
          operation = { type: 'delete_connections', ids: [requiredString(args.connectionId || args.id, 'connectionId')] };
        } else if (command === 'workflow.select') {
          if (!Array.isArray(args.ids) || args.ids.some(id => typeof id !== 'string')) throw new Error('ids 必须是字符串数组');
          const viewed = applyWorkflowViewOperations(project, [{ type: 'select_nodes', ids: args.ids.map(String) }]);
          if (viewed.ok === false) return error(envelope.id, viewed.error.code, viewed.error.message);
          dependencies.updateProject(project.id, { selectedNodeIds: viewed.project.selectedNodeIds, viewport: viewed.project.viewport });
          result = { ok: true, commandId: envelope.id, result: { projectId: project.id, draftVersion: project.draftVersion || 1 } };
          cache(cacheKey, result);
          return result;
        } else if (command === 'workflow.viewport.set') {
          const k = positiveNumber(args.k ?? args.zoom, 'k');
          const viewed = applyWorkflowViewOperations(project, [{ type: 'set_viewport', viewport: { x: finiteNumber(args.x, 'x'), y: finiteNumber(args.y, 'y'), k } }]);
          if (viewed.ok === false) return error(envelope.id, viewed.error.code, viewed.error.message);
          dependencies.updateProject(project.id, { selectedNodeIds: viewed.project.selectedNodeIds, viewport: viewed.project.viewport });
          result = { ok: true, commandId: envelope.id, result: { projectId: project.id, draftVersion: project.draftVersion || 1 } };
          cache(cacheKey, result);
          return result;
        } else if (command === 'workflow.focus.nodes') {
          const nodeIds = workflowFocusNodeIds(args);
          const missing = nodeIds.find(nodeId => !project.nodes.some(node => node.id === nodeId));
          if (missing) return error(envelope.id, 'NOT_FOUND', `节点不存在：${missing}`);
          const targets = project.nodes.filter(node => nodeIds.includes(node.id));
          const minX = Math.min(...targets.map(node => node.position.x));
          const minY = Math.min(...targets.map(node => node.position.y));
          const maxX = Math.max(...targets.map(node => node.position.x + node.width));
          const maxY = Math.max(...targets.map(node => node.position.y + node.height));
          const width = Math.max(240, finiteNumber(args.width, 'width', 1200));
          const height = Math.max(240, finiteNumber(args.height, 'height', 800));
          const padding = Math.max(0, finiteNumber(args.padding, 'padding', 80));
          const scale = Math.min(1, (width - padding * 2) / Math.max(1, maxX - minX), (height - padding * 2) / Math.max(1, maxY - minY));
          const k = Math.min(1, Math.max(.1, scale));
          const viewport = {
            x: width / 2 - ((minX + maxX) / 2) * k,
            y: height / 2 - ((minY + maxY) / 2) * k,
            k,
          };
          dependencies.updateProject(project.id, { viewport });
          result = { ok: true, commandId: envelope.id, result: { projectId: project.id, draftVersion: project.draftVersion || 1, nodeIds, viewport } };
          cache(cacheKey, result);
          return result;
        } else {
          return error(envelope.id, 'UNKNOWN_COMMAND', `未知 Workflow 命令：${command}`);
        }
        if (agentTextNodeViolation(envelope.source, operations || [operation!])) return error(envelope.id, 'NOTE_IS_ANNOTATION', NOTE_IS_ANNOTATION_MESSAGE);
        if (contextCardWriteViolation(envelope.source, operations || [operation!], project.nodes)) return error(envelope.id, 'CONTEXT_CARD_READ_ONLY', CONTEXT_CARD_READ_ONLY_MESSAGE);
        if (agentSessionWriteViolation(envelope.source, operations || [operation!], project.nodes)) return error(envelope.id, 'AGENT_SESSION_READ_ONLY', AGENT_SESSION_READ_ONLY_MESSAGE);
        operations = tagWorkflowNodeOrigin(operations || [operation!], envelope.source);
        // modelId 只能是真实产品模型：别名归一成规范 id，编造的 id 直接报错并列出可用 id（整批不落写）。
        operations = normalizeOperationModelIds(operations, project.nodes);
        // P0-2：断开/删除上游时，同步清掉下游 Prompt Bar 里对应的 @chip，并在结果里告诉调用方。
        let mentionPrunes: MentionPrune[] = [];
        if (operations.some(op => op.type === 'delete_connections' || op.type === 'delete_nodes')) {
          const projected = applyWorkflowOps({
            projectId: project.id, title: project.title, nodes: project.nodes, connections: project.connections,
            selectedNodeIds: project.selectedNodeIds, viewport: project.viewport,
          }, operations);
          if (!projected.rejections.length) {
            mentionPrunes = planMentionPrunes(project, projected.snapshot);
            operations = [...operations, ...mentionPrunes.map(prune => ({
              type: 'update_node' as const,
              id: prune.nodeId,
              metadata: { prompt: prune.prompt, richTextDocument: prune.richTextDocument },
            }))];
          }
        }
        const prunedMentions = mentionPrunes.map(prune => ({ nodeId: prune.nodeId, removedReferenceIds: prune.removedIds, prompt: prune.prompt }));
        if (command === 'workflow.apply' && (args.dryRun === true || args['dry-run'] === true)) {
          const preview = applyWorkflowOps({
            projectId: project.id,
            title: project.title,
            nodes: project.nodes,
            connections: project.connections,
            selectedNodeIds: project.selectedNodeIds,
            viewport: project.viewport,
          }, operations);
          if (preview.rejections.length) {
            return error(envelope.id, 'BAD_REQUEST', '预演失败：' + preview.rejections.map(item => item.reason).join('；'));
          }
          const beforeNodeIds = new Set(project.nodes.map(node => node.id));
          const afterNodeIds = new Set(preview.snapshot.nodes.map(node => node.id));
          const beforeConnectionIds = new Set(project.connections.map(connection => connection.id));
          const afterConnectionIds = new Set(preview.snapshot.connections.map(connection => connection.id));
          result = {
            ok: true,
            commandId: envelope.id,
            result: {
              dryRun: true,
              applied: false,
              draftVersion: project.draftVersion || 1,
              operationCount: operations.length,
              summary: workflowCommandSummary(command, args),
              nodeIds: [...afterNodeIds].filter(id => !beforeNodeIds.has(id)),
              removedNodeIds: [...beforeNodeIds].filter(id => !afterNodeIds.has(id)),
              connectionIds: [...afterConnectionIds].filter(id => !beforeConnectionIds.has(id)),
              removedConnectionIds: [...beforeConnectionIds].filter(id => !afterConnectionIds.has(id)),
              ...(prunedMentions.length ? { prunedMentions } : {}),
              ...(noopOperations.length ? { noopOperations } : {}),
              // 预演后每个被改动的生成节点的参考顺序（chip 编号 = 这个顺序），调用方据此确认 reorder 的效果。
              referenceOrder: referenceOrderPreview(project.connections, preview.snapshot.connections, preview.snapshot.nodes),
            },
          };
          cache(cacheKey, result);
          return result;
        }
        const expectedObjectVersions = Object.fromEntries(Object.entries(recordArg(args.expectedObjectVersions, 'expectedObjectVersions')).map(([id, value]) => [id, positiveNumber(value, `expectedObjectVersions.${id}`)]));
        const intent = typeof args.intent === 'string' && args.intent.trim()
          ? args.intent.trim()
          : createWorkflowDraftLogEntry({
            source: envelope.source,
            command,
            args,
            ok: true,
          }).summary;
        result = commitDocument(envelope, project, operations, {
          mutationId,
          expectedRevision,
          intent,
          clientId: typeof args.clientId === 'string' ? args.clientId : undefined,
          expectedObjectVersions,
        });
        if (!result.ok) return result;
        if (prunedMentions.length && result.result && typeof result.result === 'object') {
          result = { ...result, result: { ...(result.result as Record<string, unknown>), prunedMentions } };
        }
        if (noopOperations.length && result.result && typeof result.result === 'object') {
          result = { ...result, result: { ...(result.result as Record<string, unknown>), noopOperations } };
        }
      }

      cache(cacheKey, result);
      return result;
    } catch (cause) {
      return error(envelope.id, 'BAD_REQUEST', displayError(cause));
    }
  };
  const inFlightRuns = new Map<string, Promise<WorkflowCommandResult>>();
  // P0-B：写命令返回的 draftVersion 必须是所有内部写入（提交 → 运行时挂生成记录 / 写回结果 / 草稿日志）之后的最终版本，
  // 调用方才能直接拿它当下一次的 expectedRevision；以前返回的是第一次提交时的版本，运行又推进了几次，下一次写必然冲突。
  const withFinalRevision = async (envelope: WorkflowCommandEnvelope, pending: Promise<WorkflowCommandResult>) => stampFinalRevision(envelope, await pending, dependencies);
  return (envelope: WorkflowCommandEnvelope): Promise<WorkflowCommandResult> => {
    // 同一 idempotencyKey 的并发重复 run（Agent 重试、双击）共享一次执行；结果缓存只在完成后写入，挡不住并发。
    const key = (envelope?.command === 'workflow.node.run' || envelope?.command === 'workflow.generate' || envelope?.command === 'workflow.shortcut.apply' || envelope?.command === 'workflow.group.run') && envelope.idempotencyKey ? envelope.source + ':' + envelope.idempotencyKey : undefined;
    if (!key) return withFinalRevision(envelope, execute(envelope));
    const pending = inFlightRuns.get(key);
    if (pending) return withFinalRevision(envelope, pending);
    const running = execute(envelope).finally(() => inFlightRuns.delete(key));
    inFlightRuns.set(key, running);
    return withFinalRevision(envelope, running);
  };
}

/**
 * 给写命令的结果盖上最终版本：draftVersion（以及 revision 字段，如果有）= 返回那一刻项目的版本。
 * 内部多次写入时另带 committedDraftVersion（本次文档提交本身的版本），便于排查。读命令原样返回。
 * 失败结果里有 details.draftVersion 的同样刷新，让调用方修好后直接重试。
 */
const RUN_LIKE_COMMANDS: ReadonlySet<string> = new Set(['workflow.node.run', 'workflow.group.run', 'workflow.node.tool', 'workflow.generate', 'workflow.shortcut.apply']);

export function stampFinalRevision(envelope: WorkflowCommandEnvelope, result: WorkflowCommandResult, dependencies: Pick<WorkflowDispatcherDependencies, 'getState'>): WorkflowCommandResult {
  if (!envelope || WORKFLOW_READ_COMMANDS.has(envelope.command) || envelope.command === 'workflow.focus.nodes') return result;
  const body = result.ok ? result.result : result.error?.details;
  if (!isRecord(body)) return result;
  const state = dependencies.getState();
  const projectId = typeof body.projectId === 'string' ? body.projectId : String(envelope.args?.projectId || state.activeProjectId || '');
  const project = state.projects.find(item => item.id === projectId);
  if (!project) return result;
  const finalVersion = project.draftVersion || 1;
  const hasDraft = typeof body.draftVersion === 'number';
  const hasRevision = typeof body.revision === 'number';
  if (!result.ok) {
    if (!hasDraft || body.draftVersion === finalVersion) return result;
    return { ...result, error: { ...result.error!, details: { ...body, draftVersion: finalVersion, committedDraftVersion: body.draftVersion } } };
  }
  // 运行 / 画布工具这类原本不带版本号的写命令也补上，Agent 不必再 inspect 一次；其它命令只刷新已有的版本字段。
  if (!hasDraft && !hasRevision && !RUN_LIKE_COMMANDS.has(envelope.command)) return result;
  if (hasDraft && body.draftVersion === finalVersion && (!hasRevision || body.revision === finalVersion)) return result;
  const stamped: Record<string, unknown> = { ...body, draftVersion: finalVersion };
  if (hasDraft && body.draftVersion !== finalVersion) stamped.committedDraftVersion = body.draftVersion;
  if (hasRevision) stamped.revision = finalVersion;
  return { ...result, result: stamped };
}

let browserNodeToolRunner: WorkflowDispatcherDependencies['nodeToolRunner'];
let browserUserApiKeys: (() => UserApiKey[]) | undefined;
let browserAssetLookup: WorkflowDispatcherDependencies['lookupAsset'];

/** App 注入当前 BYOK Key（只在浏览器内存里读取，不进入命令结果）。 */
export function setWorkflowUserApiKeysProvider(provider?: () => UserApiKey[]) {
  browserUserApiKeys = provider;
}

export function setWorkflowAssetLookup(lookup?: WorkflowDispatcherDependencies['lookupAsset']) {
  browserAssetLookup = lookup;
}
let browserWorkflowExecutor: WorkflowExecutor | undefined;

export function setWorkflowExecutor(executor?: WorkflowExecutor) {
  browserWorkflowExecutor = executor;
}

export function setWorkflowNodeToolRunner(runner?: WorkflowDispatcherDependencies['nodeToolRunner']) {
  browserNodeToolRunner = runner;
}

const browserDependencies: WorkflowDispatcherDependencies = {
  getState: () => useWorkflowStore.getState(),
  createProject: title => useWorkflowStore.getState().createProject(title),
  setActiveProject: id => useWorkflowStore.getState().setActiveProject(id),
  deleteProjects: ids => useWorkflowStore.getState().deleteProjects(ids),
  updateProject: (id, patch) => useWorkflowStore.getState().updateProject(id, patch),
  getExecutor: () => browserWorkflowExecutor,
  nodeToolRunner: (projectId, nodeId, tool, args, grant) => {
    if (!browserNodeToolRunner) throw new Error('Workflow 画布工具适配器尚未连接。');
    return browserNodeToolRunner(projectId, nodeId, tool, args, grant);
  },
  persistenceError: getWorkflowPersistenceError,
  getUserApiKeys: () => browserUserApiKeys?.() || [],
  lookupAsset: assetId => browserAssetLookup?.(assetId),
};

export const dispatchWorkflowCommand = createWorkflowDispatcher(browserDependencies);
