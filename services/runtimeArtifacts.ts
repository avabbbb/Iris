import { invoke, isTauri } from '@tauri-apps/api/core';

interface CachedArtifactBlob {
  promise: Promise<Blob>;
  lastUsedAt: number;
  /** 已加载完成的字节数；加载中为 0。 */
  bytes: number;
}

const blobCache = new Map<string, CachedArtifactBlob>();
// 运行时媒体可达数百 MB：按条目数和总字节数双重限额，超限按 LRU 淘汰最旧条目。
export const MAX_BLOB_CACHE_ENTRIES = 16;
export const MAX_BLOB_CACHE_BYTES = 512 * 1024 * 1024;

function cachedBytes(): number {
  let total = 0;
  for (const entry of blobCache.values()) total += entry.bytes;
  return total;
}

function touchBlobCacheEntry(taskId: string): void {
  const entry = blobCache.get(taskId);
  if (!entry) return;
  entry.lastUsedAt = Date.now();
  while (blobCache.size > MAX_BLOB_CACHE_ENTRIES || cachedBytes() > MAX_BLOB_CACHE_BYTES) {
    let oldestId: string | undefined;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [id, candidate] of blobCache) {
      if (id !== taskId && candidate.lastUsedAt < oldestAt) {
        oldestAt = candidate.lastUsedAt;
        oldestId = id;
      }
    }
    if (!oldestId) break;
    blobCache.delete(oldestId);
  }
}

/** 解析 Rust 端的二进制帧：`[u32 BE mime 长度][mime UTF-8][文件字节]`。Blob 直接引用同一块内存，不再拷贝。 */
export function decodeRuntimeArtifactFrame(frame: ArrayBuffer, fallbackMimeType?: string): Blob {
  if (frame.byteLength < 4) throw new Error('Runtime 媒体响应不完整');
  const mimeLength = new DataView(frame).getUint32(0, false);
  if (4 + mimeLength > frame.byteLength) throw new Error('Runtime 媒体响应不完整');
  const mimeType = new TextDecoder().decode(new Uint8Array(frame, 4, mimeLength));
  return new Blob([new Uint8Array(frame, 4 + mimeLength)], { type: mimeType || fallbackMimeType || 'application/octet-stream' });
}

export async function loadRuntimeArtifactBlob(taskId: string, fallbackMimeType?: string): Promise<Blob> {
  if (typeof window === 'undefined' || !isTauri()) {
    throw new Error('Runtime 媒体只能在桌面应用中读取');
  }
  const cached = blobCache.get(taskId);
  if (cached) {
    touchBlobCacheEntry(taskId);
    return cached.promise;
  }
  const pending: CachedArtifactBlob = {
    lastUsedAt: Date.now(),
    bytes: 0,
    promise: invoke<ArrayBuffer>('runtime_artifact_read', { taskId })
      .then(frame => {
        const blob = decodeRuntimeArtifactFrame(frame, fallbackMimeType);
        pending.bytes = blob.size;
        touchBlobCacheEntry(taskId);
        return blob;
      })
      .catch(error => {
        blobCache.delete(taskId);
        throw error;
      }),
  };
  blobCache.set(taskId, pending);
  touchBlobCacheEntry(taskId);
  return pending.promise;
}
