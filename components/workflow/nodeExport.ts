import type { ScriptShot, WorkflowArtifactRef, WorkflowNode, WorkflowProject } from './types';

// workflow.export（libtv-docs-study P1-7）：单个媒体节点导出原文件；多节点 / 分组导出 ZIP（按节点名命名）；
// 脚本节点导出分镜 CSV。计划、CSV、ZIP 打包都是纯函数；读媒体与保存文件由调用方注入。

export interface WorkflowExportTarget {
  nodeIds?: readonly string[];
  /** 分组 = 同一 batchId 的节点（group_nodes 写入的 batchId）。 */
  groupId?: string;
  fileName?: string;
}

export interface WorkflowExportMediaSource {
  storageKey?: string;
  href?: string;
  artifactRef?: WorkflowArtifactRef;
  mimeType?: string;
}

export type WorkflowExportEntry =
  | { nodeId: string; title: string; fileName: string; kind: 'media'; mimeType: string; source: WorkflowExportMediaSource }
  | { nodeId: string; title: string; fileName: string; kind: 'csv'; mimeType: 'text/csv'; content: string };

export interface WorkflowExportSkip {
  nodeId: string;
  title?: string;
  reason: string;
}

export interface WorkflowExportPlan {
  /** single：直接导出一个原文件 / CSV；zip：打包。 */
  mode: 'single' | 'zip';
  fileName: string;
  entries: WorkflowExportEntry[];
  skipped: WorkflowExportSkip[];
}

export class WorkflowExportError extends Error {
  constructor(public code: 'INVALID_ARGUMENT' | 'NOT_FOUND' | 'NOTHING_TO_EXPORT', message: string, public details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'WorkflowExportError';
  }
}

const MIME_EXTENSION: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/bmp': 'bmp',
  'image/svg+xml': 'svg', 'image/avif': 'avif', 'image/tiff': 'tiff',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/ogg': 'ogg', 'audio/webm': 'weba', 'audio/aac': 'aac', 'audio/mp4': 'm4a', 'audio/flac': 'flac',
};

const DEFAULT_MIME: Record<string, string> = { image: 'image/png', video: 'video/mp4', audio: 'audio/mpeg' };

/** 文件名去掉路径与非法字符，保留中文。 */
export function safeExportName(value: string, fallback = 'node'): string {
  const cleaned = value.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, 80);
  return cleaned || fallback;
}

function extensionFor(mimeType: string, name?: string): string {
  const fromMime = MIME_EXTENSION[mimeType.toLowerCase().split(';')[0].trim()];
  if (fromMime) return fromMime;
  const match = name ? /\.([a-z0-9]{2,5})$/i.exec(name) : null;
  return match ? match[1].toLowerCase() : mimeType.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'bin';
}

function mediaKind(node: WorkflowNode): 'image' | 'video' | 'audio' | undefined {
  if (node.type === 'image' || node.type === 'video' || node.type === 'audio') return node.type as 'image' | 'video' | 'audio';
  const mime = node.metadata.mimeType || node.metadata.artifactRef?.mimeType || '';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return node.metadata.artifactRef?.kind;
}

function hasMedia(node: WorkflowNode): boolean {
  const { storageKey, href, artifactRef } = node.metadata;
  return Boolean(storageKey || artifactRef?.taskId || (href && !/^blob:/i.test(href)));
}

const CSV_COLUMNS: Array<[string, (shot: ScriptShot) => unknown]> = [
  ['镜号', shot => shot.index],
  ['时长(秒)', shot => shot.durationSec],
  ['运镜', shot => shot.camera],
  ['场景', shot => shot.scene],
  ['动作', shot => shot.action],
  ['台词', shot => shot.dialogue],
  ['情绪', shot => shot.emotion],
  ['音效', shot => shot.sfx],
  ['图片提示词', shot => shot.imagePromptOverride],
  ['视频提示词', shot => shot.videoPromptOverride],
  ['图片节点', shot => shot.imageNodeId],
  ['视频节点', shot => shot.videoNodeId],
];

function csvCell(value: unknown): string {
  if (value === undefined || value === null) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

/** 分镜表 CSV：UTF-8 BOM（Excel 直接打开不乱码）+ CRLF。 */
export function scriptShotsToCsv(shots: readonly ScriptShot[]): string {
  const rows = [CSV_COLUMNS.map(([header]) => header)];
  for (const shot of [...shots].sort((a, b) => a.index - b.index)) rows.push(CSV_COLUMNS.map(([, pick]) => csvCell(pick(shot))));
  return '\uFEFF' + rows.map(row => row.join(',')).join('\r\n') + '\r\n';
}

function uniqueName(name: string, used: Set<string>): string {
  if (!used.has(name.toLowerCase())) { used.add(name.toLowerCase()); return name; }
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let index = 2; ; index++) {
    const candidate = stem + ' (' + index + ')' + ext;
    if (!used.has(candidate.toLowerCase())) { used.add(candidate.toLowerCase()); return candidate; }
  }
}

/** 解析目标、逐节点决定导出方式；不能导出的节点进 skipped 并说明原因。 */
export function planWorkflowExport(project: Pick<WorkflowProject, 'title' | 'nodes'>, target: WorkflowExportTarget): WorkflowExportPlan {
  const nodeIds = (target.nodeIds ?? []).filter(Boolean);
  if (nodeIds.length && target.groupId) throw new WorkflowExportError('INVALID_ARGUMENT', 'nodeIds 与 groupId 二选一，只能给一个。');
  if (!nodeIds.length && !target.groupId) throw new WorkflowExportError('INVALID_ARGUMENT', '请给出要导出的 nodeIds 或 groupId。');
  let nodes: WorkflowNode[];
  if (target.groupId) {
    nodes = project.nodes.filter(node => node.batchId === target.groupId).sort((a, b) => (a.batchIndex ?? 0) - (b.batchIndex ?? 0));
    if (!nodes.length) throw new WorkflowExportError('NOT_FOUND', '分组不存在或为空：' + target.groupId);
  } else {
    const missing = nodeIds.filter(id => !project.nodes.some(node => node.id === id));
    if (missing.length) throw new WorkflowExportError('NOT_FOUND', '节点不存在：' + missing.join('、'), { missing });
    nodes = [...new Set(nodeIds)].map(id => project.nodes.find(node => node.id === id)!);
  }

  const used = new Set<string>();
  const entries: WorkflowExportEntry[] = [];
  const skipped: WorkflowExportSkip[] = [];
  for (const node of nodes) {
    const base = safeExportName(node.title || node.id, node.id);
    if (node.type === 'script') {
      const shots = node.metadata.scriptBreakdown?.shots ?? [];
      if (!shots.length) { skipped.push({ nodeId: node.id, title: node.title, reason: '脚本节点还没有分镜行' }); continue; }
      entries.push({ nodeId: node.id, title: node.title, kind: 'csv', mimeType: 'text/csv', fileName: uniqueName(base + '.csv', used), content: scriptShotsToCsv(shots) });
      continue;
    }
    if (node.type === 'text') { skipped.push({ nodeId: node.id, title: node.title, reason: '文本节点只是备注，不导出' }); continue; }
    const kind = mediaKind(node);
    if (!kind) { skipped.push({ nodeId: node.id, title: node.title, reason: '不是媒体或脚本节点（' + node.type + '）' }); continue; }
    if (!hasMedia(node)) { skipped.push({ nodeId: node.id, title: node.title, reason: '节点还没有可导出的媒体' }); continue; }
    const { storageKey, href, artifactRef } = node.metadata;
    const mimeType = node.metadata.mimeType || artifactRef?.mimeType || DEFAULT_MIME[kind];
    entries.push({
      nodeId: node.id,
      title: node.title,
      kind: 'media',
      mimeType,
      fileName: uniqueName(base + '.' + extensionFor(mimeType, node.metadata.name), used),
      source: { ...(storageKey ? { storageKey } : {}), ...(href ? { href } : {}), ...(artifactRef ? { artifactRef } : {}), mimeType },
    });
  }
  if (!entries.length) {
    throw new WorkflowExportError('NOTHING_TO_EXPORT', '没有可导出的内容：' + skipped.map(item => '「' + (item.title || item.nodeId) + '」' + item.reason).join('；'), { skipped });
  }
  const mode = entries.length === 1 && !target.groupId ? 'single' : 'zip';
  const zipBase = safeExportName(target.fileName || (target.groupId ? (project.title || 'Iris') + '-分组' : (project.title || 'Iris') + '-导出'), 'Iris-export');
  const fileName = mode === 'single'
    ? (target.fileName ? safeExportName(target.fileName) + entries[0].fileName.slice(entries[0].fileName.lastIndexOf('.')) : entries[0].fileName)
    : zipBase.replace(/\.zip$/i, '') + '.zip';
  return { mode, fileName, entries, skipped };
}

// ---------- 最小 ZIP 写出（STORE，不压缩：媒体本身已压缩；UTF-8 文件名） ----------

let crcTable: Uint32Array | undefined;
export function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

export function buildStoredZip(files: ReadonlyArray<{ name: string; data: Uint8Array }>, now = new Date()): Uint8Array {
  const encoder = new TextEncoder();
  const stamp = dosDateTime(now);
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const crc = crc32(file.data);
    const size = file.data.length;
    if (size > 0xfffffffe || offset > 0xfffffffe) throw new Error('ZIP 超过 4GB，暂不支持');
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true); lv.setUint16(8, 0, true);
    lv.setUint16(10, stamp.time, true); lv.setUint16(12, stamp.date, true);
    lv.setUint32(14, crc, true); lv.setUint32(18, size, true); lv.setUint32(22, size, true);
    lv.setUint16(26, name.length, true); lv.setUint16(28, 0, true);
    local.set(name, 30);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true); cv.setUint16(10, 0, true);
    cv.setUint16(12, stamp.time, true); cv.setUint16(14, stamp.date, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, size, true); cv.setUint32(24, size, true);
    cv.setUint16(28, name.length, true); cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local, file.data);
    centrals.push(central);
    offset += local.length + size;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true); ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + centralSize + 22);
  let cursor = 0;
  for (const part of [...locals, ...centrals, end]) { out.set(part, cursor); cursor += part.length; }
  return out;
}

// ---------- 执行 ----------

export interface WorkflowExportResult {
  fileName: string;
  mimeType: string;
  bytes: number;
  mode: 'single' | 'zip';
  saved: boolean;
  files: Array<{ nodeId: string; fileName: string; mimeType: string; bytes: number }>;
  skipped: WorkflowExportSkip[];
  /** inline=true 时附带的文件内容（base64），供外部 Agent 落盘。 */
  dataBase64?: string;
}

export interface WorkflowExportRuntime {
  loadMedia: (source: WorkflowExportMediaSource) => Promise<Blob>;
  save?: (blob: Blob, fileName: string) => Promise<boolean>;
}

export const WORKFLOW_EXPORT_INLINE_LIMIT = 20 * 1024 * 1024;

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

// jsdom 等环境的 Blob 可能没有 arrayBuffer()，回退 FileReader。
function blobBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer().then(buffer => new Uint8Array(buffer));
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error || new Error('无法读取文件数据'));
    reader.readAsArrayBuffer(blob);
  });
}

export interface WorkflowExportPayload {
  fileName: string;
  mimeType: string;
  bytes: number;
  mode: 'single' | 'zip';
  data: Uint8Array;
  files: Array<{ nodeId: string; fileName: string; mimeType: string; bytes: number }>;
  skipped: WorkflowExportSkip[];
}

export async function buildWorkflowExportPayload(
  plan: WorkflowExportPlan,
  runtime: Pick<WorkflowExportRuntime, 'loadMedia'>,
): Promise<WorkflowExportPayload> {
  const files: Array<{ entry: WorkflowExportEntry; data: Uint8Array; mimeType: string }> = [];
  for (const entry of plan.entries) {
    if (entry.kind === 'csv') {
      files.push({ entry, data: new TextEncoder().encode(entry.content), mimeType: 'text/csv' });
    } else {
      const blob = await runtime.loadMedia(entry.source);
      files.push({ entry, data: await blobBytes(blob), mimeType: blob.type || entry.mimeType });
    }
  }
  const single = plan.mode === 'single';
  const data = single ? files[0].data : buildStoredZip(files.map(file => ({ name: file.entry.fileName, data: file.data })));
  const mimeType = single ? files[0].mimeType : 'application/zip';
  return {
    fileName: plan.fileName,
    mimeType,
    bytes: data.length,
    mode: plan.mode,
    data,
    files: files.map(file => ({ nodeId: file.entry.nodeId, fileName: file.entry.fileName, mimeType: file.mimeType, bytes: file.data.length })),
    skipped: plan.skipped,
  };
}

export async function executeWorkflowExport(
  plan: WorkflowExportPlan,
  runtime: WorkflowExportRuntime,
  options: { save?: boolean; inline?: boolean } = {},
): Promise<WorkflowExportResult> {
  const payload = await buildWorkflowExportPayload(plan, runtime);
  if (options.inline && payload.bytes > WORKFLOW_EXPORT_INLINE_LIMIT) {
    throw new WorkflowExportError('INVALID_ARGUMENT', '导出文件 ' + (payload.bytes / 1024 / 1024).toFixed(1) + 'MB，超过 inline 上限 20MB；请去掉 inline，改由用户保存到本机。');
  }
  let saved = false;
  if (options.save !== false && runtime.save) saved = await runtime.save(new Blob([payload.data as BlobPart], { type: payload.mimeType }), payload.fileName);
  return {
    fileName: payload.fileName,
    mimeType: payload.mimeType,
    bytes: payload.bytes,
    mode: payload.mode,
    saved,
    files: payload.files,
    skipped: payload.skipped,
    ...(options.inline ? { dataBase64: toBase64(payload.data) } : {}),
  };
}
