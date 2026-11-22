// Cut 导出的落盘目标：优先把 MP4 流式写进 OPFS 临时文件（StreamTarget），成片是磁盘上的 File，
// 长片不再整段堆在内存里（BufferTarget 会把整个 MP4 留在一个 ArrayBuffer 里，几 GB 的片子会撑爆标签页）。
// 浏览器没有 OPFS 可写流（旧 Safari、隐私模式）时退回 BufferTarget。
import { BufferTarget, StreamTarget, type Target } from 'mediabunny';

export const CUT_EXPORT_DIR = 'iris-cut-exports';
/** 上次导出留下的临时文件超过这个时长就清理（成片已放回画布或下载，Blob 仍可能被页面引用，所以不立刻删）。 */
export const CUT_EXPORT_STALE_MS = 24 * 60 * 60 * 1000;

type WritableLike = WritableStream & { close?: () => Promise<void>; abort?: (reason?: unknown) => Promise<void> };
interface FileHandleLike { getFile(): Promise<File>; createWritable?: (options?: { keepExistingData?: boolean }) => Promise<WritableLike> }
interface DirectoryLike {
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandleLike>;
  removeEntry(name: string): Promise<void>;
  entries?: () => AsyncIterableIterator<[string, unknown]>;
}
interface RootLike { getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirectoryLike> }

export interface CutExportTarget {
  readonly kind: 'opfs' | 'memory';
  readonly target: Target;
  /** finalize 之后调用：拿到成片。 */
  finish(): Promise<Blob>;
  /** 取消 / 失败时调用：删掉写了一半的临时文件。 */
  discard(): Promise<void>;
}

const exportName = (now: number) => `export-${now}-${Math.random().toString(36).slice(2, 8)}.mp4`;
const createdAt = (name: string) => Number(/^export-(\d+)-/.exec(name)?.[1] ?? NaN);

async function defaultRoot(): Promise<RootLike | null> {
  try {
    const storage = (globalThis.navigator as Navigator | undefined)?.storage;
    if (!storage?.getDirectory) return null;
    return await storage.getDirectory() as unknown as RootLike;
  } catch {
    return null;
  }
}

async function removeStale(dir: DirectoryLike, now: number) {
  if (!dir.entries) return;
  const stale: string[] = [];
  try {
    for await (const [name] of dir.entries()) {
      const at = createdAt(name);
      if (Number.isFinite(at) && now - at > CUT_EXPORT_STALE_MS) stale.push(name);
    }
  } catch {
    return;
  }
  for (const name of stale) await dir.removeEntry(name).catch(() => undefined);
}

function memoryTarget(): CutExportTarget {
  const target = new BufferTarget();
  return {
    kind: 'memory',
    target,
    finish: async () => {
      if (!target.buffer) throw new Error('Export produced no data.');
      return new Blob([target.buffer], { type: 'video/mp4' });
    },
    discard: async () => undefined,
  };
}

export async function createCutExportTarget(options: { root?: RootLike | null; now?: number } = {}): Promise<CutExportTarget> {
  const root = options.root === undefined ? await defaultRoot() : options.root;
  if (!root) return memoryTarget();
  const now = options.now ?? Date.now();
  let dir: DirectoryLike;
  let name: string;
  let handle: FileHandleLike;
  let writable: WritableLike;
  try {
    dir = await root.getDirectoryHandle(CUT_EXPORT_DIR, { create: true });
    await removeStale(dir, now);
    name = exportName(now);
    handle = await dir.getFileHandle(name, { create: true });
    if (!handle.createWritable) throw new Error('no createWritable');
    writable = await handle.createWritable({ keepExistingData: false });
  } catch {
    return memoryTarget();
  }
  // FileSystemWritableFileStream 原生接受 { type: 'write', position, data }，正好是 StreamTarget 的块格式；
  // chunked 先攒 16 MiB 再写，减少 OPFS 写入次数。muxer 完成时会关闭这个流。
  const target = new StreamTarget(writable as WritableStream, { chunked: true });
  let discarded = false;
  return {
    kind: 'opfs',
    target,
    finish: async () => {
      const file = await handle.getFile();
      if (!file.size) throw new Error('Export produced no data.');
      // 包一层只是补上 MIME；Blob 引用磁盘文件，不会把内容读进内存。
      return new Blob([file], { type: 'video/mp4' });
    },
    discard: async () => {
      if (discarded) return;
      discarded = true;
      await writable.abort?.().catch(() => undefined);
      await dir.removeEntry(name).catch(() => undefined);
    },
  };
}
