import { createWorkflowNode } from './constants';
import type { WorkflowConnection, WorkflowMediaAlternate, WorkflowNode, WorkflowNodeMetadata } from './types';

/**
 * 多结果 = 一个首图节点 + 挂在它身上的备选（DESIGN 01 §13.3 / 10 §2.4）。
 *
 * 生成 N 张（或 N 条视频）时，第一份结果原位写进源节点；其余不是画布节点，而是 `metadata.alternates`。
 * 首图节点是普通节点：PromptBar、工具条、连线、prompt / 模型 / Take 记录都在它身上。
 * “设为首图”只交换媒体字段（含图片 / 视频类型），节点 ID、位置中心、连线、prompt、配方都不动，
 * 一条 update_node 提交，撤销一步即可还原。
 */

/** 交换时随媒体走的字段；prompt、config、operation、连线、位置都留在节点上。 */
export const ALTERNATE_MEDIA_KEYS = [
  'href', 'storageKey', 'artifactRef', 'poster', 'posterStorageKey', 'previewStorageKey', 'remoteUrl',
  'name', 'mimeType', 'bytes', 'naturalWidth', 'naturalHeight', 'durationMs', 'filters', 'pipelineRender',
] as const satisfies readonly (keyof WorkflowNodeMetadata)[];

/** 备选自身保留的来源字段（拆成独立节点时还原，Agent 读它判断出处）。 */
const ALTERNATE_SOURCE_KEYS = [
  'prompt', 'richTextDocument', 'config', 'sourceOperationNodeId', 'operationTakeId', 'operationOutputRole',
] as const satisfies readonly (keyof WorkflowNodeMetadata)[];

/**
 * 结果总数（首图 + 备选）≤ 这个数时，首图节点显示成原来的斜叠卡片（悬停散开，点“N 张”展开成 2 列网格）；
 * 更多时用节点下方带多选的停靠网格。阈值按总数算：4 张 = 首图 + 3 个备选。
 */
export const ALTERNATE_STACK_MAX_TOTAL = 4;

/** 这个节点的备选用斜叠卡片展示（有备选且总数不超过 ALTERNATE_STACK_MAX_TOTAL）。 */
export function usesAlternateStack(node: Pick<WorkflowNode, 'metadata'> | null | undefined) {
  const count = nodeAlternates(node).length;
  return count > 0 && count + 1 <= ALTERNATE_STACK_MAX_TOTAL;
}

export const isAlternateMediaType = (type: string): type is 'image' | 'video' => type === 'image' || type === 'video';

export function nodeAlternates(node: Pick<WorkflowNode, 'metadata'> | null | undefined): WorkflowMediaAlternate[] {
  const list = node?.metadata.alternates;
  return Array.isArray(list) ? list : [];
}

/** 节点当前那份媒体的稳定 ID。 */
export const primaryVariantId = (node: Pick<WorkflowNode, 'id' | 'metadata'>) => node.metadata.mediaVariantId || node.id;

function pick(metadata: WorkflowNodeMetadata, keys: readonly (keyof WorkflowNodeMetadata)[]): WorkflowNodeMetadata {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (metadata[key] !== undefined) out[key] = metadata[key];
  return out as WorkflowNodeMetadata;
}

function hasMedia(metadata: WorkflowNodeMetadata) {
  return Boolean(metadata.storageKey || metadata.href || metadata.artifactRef || metadata.poster || metadata.posterStorageKey);
}

/** 把一个（旧的叠放兄弟）节点变成备选；ID 沿用节点 ID，Agent / Take 记录里的引用仍能对上。 */
export function alternateFromNode(node: WorkflowNode, extra: Partial<WorkflowMediaAlternate> = {}): WorkflowMediaAlternate {
  return {
    id: primaryVariantId(node),
    type: node.type === 'video' ? 'video' : 'image',
    title: node.title,
    width: node.width,
    height: node.height,
    ...(node.batchId ? { batchId: node.batchId } : {}),
    ...(node.batchIndex !== undefined ? { batchIndex: node.batchIndex } : {}),
    ...extra,
    metadata: { ...pick(node.metadata, ALTERNATE_SOURCE_KEYS), ...pick(node.metadata, ALTERNATE_MEDIA_KEYS), status: 'success' },
  };
}

/** 备选在预览 / 导出 / 拆分时以节点形态出现（不进入文档）。 */
export function alternateAsNode(owner: WorkflowNode, alternate: WorkflowMediaAlternate): WorkflowNode {
  return {
    id: alternate.id,
    type: alternate.type,
    title: alternate.title || (alternate.type === 'video' ? '生成视频' : '生成图片'),
    position: owner.position,
    width: alternate.width || owner.width,
    height: alternate.height || owner.height,
    isVisible: true,
    metadata: { ...alternate.metadata, status: 'success' },
  };
}

/** 保持节点宽度与中心，按新媒体比例换高（没有比例时沿用备选记录的尺寸比例）。 */
function sizeFor(node: WorkflowNode, metadata: WorkflowNodeMetadata, fallback?: { width?: number; height?: number }) {
  const ratio = metadata.naturalWidth && metadata.naturalHeight
    ? metadata.naturalHeight / metadata.naturalWidth
    : fallback?.width && fallback?.height ? fallback.height / fallback.width : node.height / node.width;
  const width = node.width;
  const height = Math.max(60, Math.round(width * ratio));
  return {
    width,
    height,
    position: { x: node.position.x, y: node.position.y + (node.height - height) / 2 },
  };
}

/**
 * 设为首图：备选的媒体换进节点，节点原来的媒体换到该备选原来的位置（同一槽位，再换一次即还原）。
 * 返回新节点；找不到备选时返回 null。
 */
export function promoteAlternate(node: WorkflowNode, alternateId: string): WorkflowNode | null {
  const list = nodeAlternates(node);
  const index = list.findIndex(item => item.id === alternateId);
  if (index < 0) return null;
  const target = list[index];
  // 节点自身的 batchId 属于它所在的分组（手动 / 分镜），不是这份媒体的批次；换下时沿用目标槽位的批次
  // （同一批的结果互换；序号不跟着走，版本号等来源信息在媒体自己的 metadata 里）。
  const outgoing = alternateFromNode({ ...node, batchId: undefined, batchIndex: undefined }, target.batchId ? { batchId: target.batchId } : {});
  const cleared: WorkflowNodeMetadata = { ...node.metadata };
  for (const key of ALTERNATE_MEDIA_KEYS) delete cleared[key];
  const incoming = pick(target.metadata, ALTERNATE_MEDIA_KEYS);
  const nextList = list.map((item, itemIndex) => (itemIndex === index ? outgoing : item));
  const size = sizeFor(node, target.metadata, target);
  return {
    ...node,
    type: target.type,
    ...size,
    metadata: {
      ...cleared,
      ...incoming,
      primaryImageId: undefined,
      mediaVariantId: target.id === node.id ? undefined : target.id,
      alternates: nextList,
    },
  };
}

export function removeAlternates(node: WorkflowNode, ids: readonly string[]): WorkflowNode {
  const drop = new Set(ids);
  const next = nodeAlternates(node).filter(item => !drop.has(item.id));
  return { ...node, metadata: { ...node.metadata, alternates: next.length ? next : undefined } };
}

/**
 * 新生成的结果放到最前（最新一批先看到），旧备选保留在后面——不丢任何历史结果。
 */
export function prependAlternates(node: WorkflowNode, alternates: readonly WorkflowMediaAlternate[]): WorkflowNode {
  if (!alternates.length) return node;
  const existing = nodeAlternates(node).filter(item => !alternates.some(next => next.id === item.id));
  return { ...node, metadata: { ...node.metadata, alternates: [...alternates, ...existing] } };
}

/**
 * 拆成独立节点：选中的备选变成普通节点，排在首图右侧（网格，不压住首图），节点 ID 尽量沿用备选 ID。
 */
export function splitAlternates(node: WorkflowNode, ids: readonly string[], existingIds: ReadonlySet<string>, createId: () => string) {
  const wanted = new Set(ids);
  const picked = nodeAlternates(node).filter(item => wanted.has(item.id));
  const gap = 32;
  const columns = Math.min(4, Math.max(1, Math.ceil(Math.sqrt(picked.length))));
  const cellWidth = node.width;
  const created = picked.map((alternate, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const ratio = alternate.metadata.naturalWidth && alternate.metadata.naturalHeight
      ? alternate.metadata.naturalHeight / alternate.metadata.naturalWidth
      : alternate.width && alternate.height ? alternate.height / alternate.width : node.height / node.width;
    const width = cellWidth;
    const height = Math.max(60, Math.round(width * ratio));
    const id = existingIds.has(alternate.id) ? createId() : alternate.id;
    const created = createWorkflowNode(id, alternate.type, {
      x: node.position.x + node.width + gap * 2 + column * (cellWidth + gap),
      y: node.position.y + row * (node.height + gap),
    }, { ...alternate.metadata, status: 'success' });
    return {
      ...created,
      title: alternate.title || created.title,
      width,
      height,
      ...(node.parentId ? { parentId: node.parentId } : {}),
    };
  });
  return { primary: removeAlternates(node, picked.map(item => item.id)), nodes: created };
}

/** 找出某个备选 ID 挂在哪个节点上。 */
export function findAlternateOwner(nodes: readonly WorkflowNode[], alternateId: string) {
  for (const node of nodes) {
    const alternate = nodeAlternates(node).find(item => item.id === alternateId);
    if (alternate) return { node, alternate };
  }
  return null;
}

/**
 * 按 ID 找画布节点；找不到时再看它是不是某个节点的备选（多结果的第 2–N 张不是画布节点，
 * 但 Agent / 外部调用者会从旧 inspect、Take 记录里拿到这些 ID）。
 */
export function resolveNodeOrAlternate(nodes: readonly WorkflowNode[], id: string):
  | { kind: 'node'; node: WorkflowNode }
  | { kind: 'alternate'; owner: WorkflowNode; alternate: WorkflowMediaAlternate; node: WorkflowNode }
  | null {
  const node = nodes.find(item => item.id === id);
  if (node) return { kind: 'node', node };
  const found = findAlternateOwner(nodes, id);
  return found ? { kind: 'alternate', owner: found.node, alternate: found.alternate, node: alternateAsNode(found.node, found.alternate) } : null;
}

/** 只接受画布节点的命令（运行、连线、改参数）遇到备选 ID 时的说明，避免只回一句「节点不存在」。 */
export function missingNodeMessage(nodes: readonly WorkflowNode[], id: string) {
  const owner = findAlternateOwner(nodes, id);
  return owner
    ? `${id} 是节点 ${owner.node.id} 的备选结果（多结果的其中一张），不是独立画布节点：查看用 media_view，要单独操作先「拆成独立节点」或「设为首图」`
    : `节点不存在：${id}`;
}

/**
 * 旧数据迁移：生成产生的叠放批次（同 batchId、带 batchIndex 的媒体节点，首图 batchIndex 0 / batchGroupSource 'auto'）
 * 折叠成首图节点上的备选。
 *
 * - 手动打组（'manual'）与分镜 / 批量命令建的分组（没有 batchIndex）不动——它们是不同的节点，不是同一节点的多份结果。
 * - 旧指针 `primaryImageId` 指向别的成员：先把它换成首图，用户看到的封面不变。
 * - 有连线的成员不折叠（否则会丢连线），改成普通独立节点；与首图完全重叠时挪到首图右侧，保证能点到、能拖。
 * - 首图不是图片 / 视频（例如运行中途被换掉媒体）：整组解散成普通节点。
 */
export function foldResultBatches(nodes: WorkflowNode[], connections: readonly WorkflowConnection[]): { nodes: WorkflowNode[]; changed: boolean } {
  const groups = new Map<string, WorkflowNode[]>();
  for (const node of nodes) {
    if (!node.batchId) continue;
    const group = groups.get(node.batchId) || [];
    group.push(node);
    groups.set(node.batchId, group);
  }
  const linked = new Set<string>();
  for (const connection of connections) { linked.add(connection.fromNodeId); linked.add(connection.toNodeId); }
  const replace = new Map<string, WorkflowNode>();
  const remove = new Set<string>();
  // 与首图同位叠放、拆出来的成员：先记下，所有批次处理完后再统一找空位（避开其它节点和首图下方的备选条）。
  const pending: Array<{ id: string; root: WorkflowNode; index: number }> = [];
  for (const group of groups.values()) {
    if (group.some(node => node.batchGroupSource === 'manual')) continue;
    if (!group.every(node => node.batchIndex !== undefined)) continue;
    const ordered = [...group].sort((left, right) => (left.batchIndex ?? 0) - (right.batchIndex ?? 0));
    if (ordered.length < 2) {
      const only = ordered[0];
      if (only && only.batchGroupSource === 'auto') replace.set(only.id, { ...only, batchId: undefined, batchIndex: undefined, batchGroupSource: undefined });
      continue;
    }
    const root = ordered.find(node => node.batchIndex === 0) || ordered[0];
    const detach = (node: WorkflowNode, index: number) => {
      const overlapping = node.id !== root.id && node.position.x === root.position.x && node.position.y === root.position.y;
      replace.set(node.id, {
        ...node,
        batchId: undefined,
        batchIndex: undefined,
        batchGroupSource: undefined,
        metadata: { ...node.metadata, primaryImageId: undefined },
      });
      if (overlapping) pending.push({ id: node.id, root, index });
    };
    if (!isAlternateMediaType(root.type) || !hasMedia(root.metadata)) {
      ordered.forEach(detach);
      continue;
    }
    const foldable = ordered.filter(node => node.id !== root.id && isAlternateMediaType(node.type) && node.isVisible !== false && !linked.has(node.id) && hasMedia(node.metadata));
    const foldIds = new Set(foldable.map(node => node.id));
    let primary: WorkflowNode = {
      ...root,
      batchId: undefined,
      batchIndex: undefined,
      batchGroupSource: undefined,
      metadata: { ...root.metadata, primaryImageId: undefined },
    };
    primary = prependAlternates(primary, foldable.map(node => alternateFromNode(node)));
    const pointer = root.metadata.primaryImageId;
    if (pointer && pointer !== root.id && foldIds.has(pointer)) primary = promoteAlternate(primary, pointer) || primary;
    replace.set(root.id, primary);
    foldable.forEach(node => remove.add(node.id));
    ordered.filter(node => node.id !== root.id && !foldIds.has(node.id)).forEach(detach);
  }
  if (!replace.size && !remove.size) return { nodes, changed: false };
  const next = nodes.filter(node => !remove.has(node.id)).map(node => replace.get(node.id) || node);
  if (pending.length) {
    const pendingIds = new Set(pending.map(item => item.id));
    const occupied: Rect[] = next.filter(node => !pendingIds.has(node.id)).map(node => footprint(node));
    const placed = new Map<string, WorkflowNode>();
    for (const { id, root, index } of pending) {
      const node = replace.get(id)!;
      const position = freeSpot(node, root, index, occupied);
      occupied.push({ x: position.x, y: position.y, width: node.width, height: node.height });
      placed.set(id, { ...node, position });
    }
    return { nodes: next.map(node => placed.get(node.id) || node), changed: true };
  }
  return { nodes: next, changed: true };
}

export interface Rect { x: number; y: number; width: number; height: number }
const FOLD_GAP = 40;
/** 节点占的画布区域；有备选的节点把叠放卡片斜出的边角 / 下方网格也算进去（网格按节点宽 0.6 粗估，宁大勿小）。 */
export function footprint(node: WorkflowNode): Rect {
  const alternates = nodeAlternates(node).length;
  const dock = alternates ? (usesAlternateStack(node) ? 24 : Math.round(node.width * 0.6)) : 0;
  return { x: node.position.x, y: node.position.y, width: node.width, height: node.height + dock };
}
const intersects = (a: Rect, b: Rect) => a.x < b.x + b.width + FOLD_GAP / 2 && b.x < a.x + a.width + FOLD_GAP / 2 && a.y < b.y + b.height + FOLD_GAP / 2 && b.y < a.y + a.height + FOLD_GAP / 2;
/** 依次试：首图右侧同一行 → 再往右逐列；都被占时退回原先的右侧错位位置（不会比旧行为更糟）。 */
function freeSpot(node: WorkflowNode, root: WorkflowNode, index: number, occupied: Rect[]) {
  const rootBox = footprint(root);
  for (let column = 0; column < 12; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      const x = root.position.x + root.width + FOLD_GAP + column * (node.width + FOLD_GAP);
      const y = root.position.y + row * (Math.max(node.height, rootBox.height / 2) + FOLD_GAP);
      const box = { x, y, width: node.width, height: node.height };
      if (!occupied.some(rect => intersects(rect, box))) return { x, y };
    }
  }
  return { x: root.position.x + root.width + FOLD_GAP + index * 24, y: root.position.y + index * 24 };
}
