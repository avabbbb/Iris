// Spatial Context P0：一轮用户消息的结构化来源（docs/design/11-iris.md §3，01-interaction §12.1）。
// 发送时由真实持久化的 session/message id 绑定显式来源：稳定 node/asset id、内容指纹（不含位置 / 尺寸 / 标题）、
// 实际送进模型的媒体范围。写成会话里只追加的 custom entry（不进模型上下文）；发送文本里的「引用上下文」只用于旧会话兼容。
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { canonicalize } from 'json-canonicalize';
import type { WorkflowNode } from '../components/workflow/types';
import type { AssetItem } from '../types';

export const TURN_CONTEXT_ENTRY = 'iris.turn_context';
export const TURN_CONTEXT_SCHEMA_VERSION = 1;

export type TurnSourceKind = 'node' | 'asset';

/** 这个来源实际送进模型的画面；sent=false 表示只以 id/名字的文本引用出现。 */
export interface TurnSourceMedia {
  sent: boolean;
  /** 送达的图片块数（视频帧网格算 1 张）。 */
  imageCount: number;
  kind?: 'image' | 'video-grid' | 'video-frames';
  /** 视频：网格取帧的秒数，或首/中/尾帧标签。 */
  frames?: Array<number | string>;
  /** 没送达的原因（超过张数上限 / 不是媒体节点 / 读取失败 / 素材库引用只发文本）。 */
  note?: string;
}

export interface TurnContextSource {
  kind: TurnSourceKind;
  id: string;
  label: string;
  /** 发送时的节点类型 / 素材 MIME，仅用于显示。 */
  mediaType?: string;
  contentFingerprint: string;
  media: TurnSourceMedia;
}

export interface TurnContextGroup {
  label: string;
  batchId?: string;
  nodeIds: string[];
}

export interface TurnContextRecord {
  schemaVersion: typeof TURN_CONTEXT_SCHEMA_VERSION;
  sessionId: string;
  messageId: string;
  projectId: string;
  /** 发送时的项目级 revision（draftVersion）；节点没有单独的 revision。 */
  projectRevisionAtSend: number;
  sentAt: string;
  origin: 'composer' | 'group' | 'steer';
  /** 画布「添加到 Agent」分组：发送那一刻冻结的成员。 */
  group?: TurnContextGroup;
  sources: TurnContextSource[];
}

/** 面板交给内核的部分；session/message id 与时间由内核在消息落盘时补上。 */
export type TurnContextDraft = Omit<TurnContextRecord, 'schemaVersion' | 'sessionId' | 'messageId' | 'sentAt'>;

function shortHash(value: unknown): string {
  return bytesToHex(sha256(utf8ToBytes(canonicalize(value as object)))).slice(0, 16);
}

function compact<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== '')) as Partial<T>;
}

/**
 * 节点内容指纹：只取影响内容的字段（媒体引用、提示词、模型 / 参数、文本），不含 position / width / height / title，
 * 也不含运行状态、进度、封面等派生字段，所以拖动、缩放、改名都不会变成「来源已更新」。
 */
export function nodeContentFingerprint(node: Pick<WorkflowNode, 'type' | 'metadata'>): string {
  const meta = node.metadata || ({} as WorkflowNode['metadata']);
  return shortHash(compact({
    type: node.type,
    content: meta.content,
    prompt: meta.prompt,
    storageKey: meta.storageKey,
    href: meta.href,
    assetId: meta.assetId,
    artifact: meta.artifactRef ? compact({ id: (meta.artifactRef as { id?: string }).id, hash: (meta.artifactRef as { contentHash?: string }).contentHash }) : undefined,
    importHash: meta.browserImport?.contentHash,
    mediaVariantId: meta.mediaVariantId,
    primaryImageId: meta.primaryImageId,
    operationTakeId: meta.operationTakeId,
    config: meta.config,
    filters: meta.filters,
  }));
}

const assetFingerprints = new WeakMap<object, string>();

/** 素材库条目的内容指纹：媒体本身 + 生成参数；名字、文件夹、标签不算。 */
export function assetContentFingerprint(asset: Pick<AssetItem, 'id' | 'dataUrl' | 'mimeType' | 'prompt' | 'model' | 'provider' | 'generationParams'>): string {
  const cached = assetFingerprints.get(asset);
  if (cached) return cached;
  const fingerprint = shortHash(compact({
    id: asset.id,
    media: asset.dataUrl ? shortHash({ dataUrl: asset.dataUrl }) : undefined,
    mimeType: asset.mimeType,
    prompt: asset.prompt,
    model: asset.model,
    provider: asset.provider,
    generationParams: asset.generationParams,
  }));
  assetFingerprints.set(asset, fingerprint);
  return fingerprint;
}

export type SourceState = 'ok' | 'missing' | 'updated';

/** 来源现在的状态：找不到 = 不可用，指纹不同 = 来源已更新。没有指纹（旧消息）只判断在不在。 */
export function sourceState(
  source: { kind: TurnSourceKind; id?: string; fingerprint?: string },
  nodes: readonly WorkflowNode[] | undefined,
  assets?: readonly AssetItem[],
): SourceState {
  if (!source.id) return 'ok';
  if (source.kind === 'node') {
    if (!nodes) return 'ok';
    const node = nodes.find(item => item.id === source.id);
    if (!node) return 'missing';
    return source.fingerprint && nodeContentFingerprint(node) !== source.fingerprint ? 'updated' : 'ok';
  }
  if (!assets) return 'ok';
  const asset = assets.find(item => item.id === source.id);
  if (!asset) return 'missing';
  return source.fingerprint && assetContentFingerprint(asset) !== source.fingerprint ? 'updated' : 'ok';
}

/** 一轮的来源输入：面板的引用 chip（可能来自「添加到 Agent」分组）。 */
export interface TurnReferenceInput {
  id: string;
  type: TurnSourceKind;
  label: string;
  mediaType?: string;
  group?: { label: string; batchId?: string };
}

/** 面板读画面后的逐节点结果（loadAgentNodeMedia 的 sources），含 6 张上限裁剪后的实际张数。 */
export type NodeMediaSent = Record<string, TurnSourceMedia>;

export function buildTurnContextDraft(input: {
  projectId: string;
  projectRevision: number;
  references: readonly TurnReferenceInput[];
  nodes: readonly WorkflowNode[];
  assets?: readonly AssetItem[];
  media?: NodeMediaSent;
  origin?: TurnContextRecord['origin'];
}): TurnContextDraft | null {
  const sources: TurnContextSource[] = [];
  for (const reference of input.references) {
    if (sources.some(item => item.kind === reference.type && item.id === reference.id)) continue;
    if (reference.type === 'node') {
      const node = input.nodes.find(item => item.id === reference.id);
      // 发送那一刻已不在画布上的引用不写入：来源只记录真正可解析的对象。
      if (!node) continue;
      sources.push({
        kind: 'node',
        id: node.id,
        label: reference.label || node.title,
        mediaType: node.type,
        contentFingerprint: nodeContentFingerprint(node),
        media: input.media?.[node.id] ?? { sent: false, imageCount: 0, note: node.type === 'image' || node.type === 'video' ? '未附带画面' : '非媒体节点，仅文本引用' },
      });
    } else {
      const asset = input.assets?.find(item => item.id === reference.id);
      sources.push({
        kind: 'asset',
        id: reference.id,
        label: reference.label || asset?.name || reference.id,
        ...(asset?.mimeType || reference.mediaType ? { mediaType: asset?.mimeType || reference.mediaType } : {}),
        contentFingerprint: asset ? assetContentFingerprint(asset) : '',
        media: { sent: false, imageCount: 0, note: '素材库引用，仅以 assetId 文本发送' },
      });
    }
  }
  if (!sources.length) return null;
  const grouped = input.references.filter(reference => reference.type === 'node' && reference.group && sources.some(source => source.id === reference.id));
  const group = grouped.length ? {
    label: grouped[0].group!.label,
    ...(grouped[0].group!.batchId ? { batchId: grouped[0].group!.batchId } : {}),
    nodeIds: grouped.filter(reference => reference.group!.label === grouped[0].group!.label).map(reference => reference.id),
  } : undefined;
  return {
    projectId: input.projectId,
    projectRevisionAtSend: input.projectRevision,
    origin: input.origin ?? (group ? 'group' : 'composer'),
    ...(group ? { group } : {}),
    sources,
  };
}

export function isTurnContextRecord(value: unknown): value is TurnContextRecord {
  const record = value as TurnContextRecord | null;
  return Boolean(record && record.schemaVersion === TURN_CONTEXT_SCHEMA_VERSION && typeof record.messageId === 'string' && Array.isArray(record.sources));
}

/** 会话 entries → messageId → 记录（只追加；同一消息有多条时取最后一条）。 */
export function turnContextsByMessage(entries: ReadonlyArray<{ type: string; customType?: string; data?: unknown }>): Map<string, TurnContextRecord> {
  const out = new Map<string, TurnContextRecord>();
  for (const entry of entries) {
    if (entry.type !== 'custom' || entry.customType !== TURN_CONTEXT_ENTRY || !isTurnContextRecord(entry.data)) continue;
    out.set(entry.data.messageId, entry.data);
  }
  return out;
}

/** 显示用：结构化记录 → 消息引用（带指纹与送达媒体）。 */
export function turnContextReferences(record: TurnContextRecord): Array<{ id: string; kind: TurnSourceKind; label: string; fingerprint?: string; media?: TurnSourceMedia }> {
  return record.sources.map(source => ({
    id: source.id,
    kind: source.kind,
    label: source.label,
    ...(source.contentFingerprint ? { fingerprint: source.contentFingerprint } : {}),
    media: source.media,
  }));
}

/**
 * 读画面的逐节点结果 → 实际送进模型的范围。面板把本地附件放在前面、整轮最多 max 张，
 * 所以节点的图从 offset 开始计数，超出部分不算送达。
 */
export function sentNodeMedia(
  sources: ReadonlyArray<{ nodeId: string; imageCount: number; kind?: TurnSourceMedia['kind']; frames?: Array<number | string>; note?: string }> | undefined,
  offset: number,
  max: number,
): NodeMediaSent {
  const out: NodeMediaSent = {};
  let cursor = offset;
  for (const source of sources || []) {
    const kept = Math.max(0, Math.min(source.imageCount, max - cursor));
    cursor += source.imageCount;
    out[source.nodeId] = {
      sent: kept > 0,
      imageCount: kept,
      ...(source.kind ? { kind: source.kind } : {}),
      ...(source.frames && kept > 0 ? { frames: source.kind === 'video-frames' ? source.frames.slice(0, kept) : source.frames } : {}),
      ...(source.note ? { note: source.note } : kept < source.imageCount ? { note: `超过本轮 ${max} 张上限，只送达 ${kept} 张` } : {}),
    };
  }
  return out;
}
