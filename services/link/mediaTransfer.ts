// Iris Link 无 S3/R2 分片传输缓冲（纯浏览器内存）：
// - 上传：CLI 分片推入本地图片/视频/音频 → 校验字节数与 SHA-256 → 交给 workflow.media.import 入浏览器 IndexedDB。
// - 下载：workflow.export 产出或超 180 KiB 的画布快照 → 暂存内存 → CLI 分片拉回并校验 SHA-256，不经任何对象存储。
import {
  LINK_ERROR,
  LINK_MAX_MEDIA_BYTES,
  LINK_MEDIA_CHUNK_BYTES,
} from '../../tools/iris/link/protocol.js';

const TRANSFER_TTL_MS = 2 * 60_000;
const MAX_ACTIVE_UPLOADS = 4;
const MAX_CACHED_DOWNLOADS = 6;

const MEDIA_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/opus',
};

export class MediaTransferError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'MediaTransferError';
  }
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', copy.buffer);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function decodeBase64(value: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(String(value || ''));
  } catch {
    throw new MediaTransferError(LINK_ERROR.INVALID_ARGUMENT, '分片不是合法的 base64 数据。');
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function inferMediaMime(fileName: string, rawMime: string): string {
  const mime = String(rawMime || '').split(';')[0].trim().toLowerCase();
  if (mime.startsWith('image/') || mime.startsWith('video/') || mime.startsWith('audio/')) return mime;
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  return MEDIA_MIME_BY_EXT[ext] || '';
}

interface UploadSession {
  uploadId: string;
  fileName: string;
  mimeType: string;
  bytes: number;
  sha256: string;
  chunkBytes: number;
  totalChunks: number;
  chunks: Array<Uint8Array | undefined>;
  receivedChunks: number;
  receivedBytes: number;
  expiresAt: number;
}

interface DownloadBuffer {
  downloadId: string;
  fileName: string;
  mimeType: string;
  bytes: number;
  sha256: string;
  chunkBytes: number;
  totalChunks: number;
  data: Uint8Array;
  expiresAt: number;
}

const uploads = new Map<string, UploadSession>();
const downloads = new Map<string, DownloadBuffer>();

function pruneExpired(now = Date.now()) {
  for (const [id, session] of uploads) {
    if (session.expiresAt <= now) uploads.delete(id);
  }
  for (const [id, buffer] of downloads) {
    if (buffer.expiresAt <= now) downloads.delete(id);
  }
}

export function startMediaUpload(input: {
  fileName?: unknown;
  mimeType?: unknown;
  bytes?: unknown;
  sha256?: unknown;
  chunkBytes?: unknown;
}) {
  const now = Date.now();
  pruneExpired(now);
  if (uploads.size >= MAX_ACTIVE_UPLOADS) {
    throw new MediaTransferError('TRANSFER_BUSY', `同时进行中的媒体上传已达上限（${MAX_ACTIVE_UPLOADS}），请稍后重试。`, true);
  }
  const fileName = String(input.fileName || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim().slice(0, 120) || 'imported';
  const bytes = Number(input.bytes);
  if (!Number.isInteger(bytes) || bytes <= 0) {
    throw new MediaTransferError(LINK_ERROR.INVALID_ARGUMENT, 'bytes 必须是大于 0 的整数。');
  }
  if (bytes > LINK_MAX_MEDIA_BYTES) {
    throw new MediaTransferError(LINK_ERROR.INVALID_ARGUMENT, `文件大小 ${(bytes / 1024 / 1024).toFixed(1)} MB 超过直传上限 ${(LINK_MAX_MEDIA_BYTES / 1024 / 1024).toFixed(0)} MB。`);
  }
  const mimeType = inferMediaMime(fileName, String(input.mimeType || ''));
  if (!mimeType) {
    throw new MediaTransferError(LINK_ERROR.INVALID_ARGUMENT, '只支持导入图片、视频或音频文件（无法识别的媒体类型）。');
  }
  const sha256 = String(input.sha256 || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new MediaTransferError(LINK_ERROR.INVALID_ARGUMENT, 'sha256 必须是 64 位十六进制摘要。');
  }
  const requestedChunk = Number(input.chunkBytes);
  const chunkBytes = Number.isInteger(requestedChunk) && requestedChunk >= 1024 && requestedChunk <= LINK_MEDIA_CHUNK_BYTES
    ? requestedChunk
    : LINK_MEDIA_CHUNK_BYTES;
  const totalChunks = Math.ceil(bytes / chunkBytes);
  const uploadId = 'upl_' + crypto.randomUUID().replace(/-/g, '').slice(0, 20);
  uploads.set(uploadId, {
    uploadId,
    fileName,
    mimeType,
    bytes,
    sha256,
    chunkBytes,
    totalChunks,
    chunks: new Array<Uint8Array | undefined>(totalChunks),
    receivedChunks: 0,
    receivedBytes: 0,
    expiresAt: now + TRANSFER_TTL_MS,
  });
  return { uploadId, fileName, mimeType, bytes, chunkBytes, totalChunks };
}

export function appendMediaUploadChunk(input: {
  uploadId?: unknown;
  index?: unknown;
  dataBase64?: unknown;
}) {
  const now = Date.now();
  pruneExpired(now);
  const uploadId = String(input.uploadId || '').trim();
  const session = uploads.get(uploadId);
  if (!session) {
    throw new MediaTransferError('TRANSFER_NOT_FOUND', `上传会话不存在或已过期：${uploadId || '(空)'}。`, true);
  }
  const index = Number(input.index);
  if (!Number.isInteger(index) || index < 0 || index >= session.totalChunks) {
    throw new MediaTransferError(LINK_ERROR.INVALID_ARGUMENT, `分片序号越界：${String(input.index)}（共 ${session.totalChunks} 片）。`);
  }
  const chunk = decodeBase64(String(input.dataBase64 || ''));
  if (chunk.length === 0 || chunk.length > session.chunkBytes) {
    throw new MediaTransferError(LINK_ERROR.INVALID_ARGUMENT, `分片大小异常：${chunk.length} 字节。`);
  }
  const previous = session.chunks[index];
  if (previous) {
    session.receivedBytes -= previous.length;
  } else {
    session.receivedChunks += 1;
  }
  session.chunks[index] = chunk;
  session.receivedBytes += chunk.length;
  if (session.receivedBytes > session.bytes) {
    uploads.delete(uploadId);
    throw new MediaTransferError(LINK_ERROR.INVALID_ARGUMENT, '累计分片字节数超过声明的文件大小，已中止本次上传。');
  }
  session.expiresAt = now + TRANSFER_TTL_MS;
  return {
    uploadId,
    index,
    receivedChunks: session.receivedChunks,
    totalChunks: session.totalChunks,
    receivedBytes: session.receivedBytes,
    bytes: session.bytes,
  };
}

export async function finalizeMediaUpload(uploadIdInput: unknown) {
  const now = Date.now();
  pruneExpired(now);
  const uploadId = String(uploadIdInput || '').trim();
  const session = uploads.get(uploadId);
  if (!session) {
    throw new MediaTransferError('TRANSFER_NOT_FOUND', `上传会话不存在或已过期：${uploadId || '(空)'}。`, true);
  }
  if (session.receivedChunks !== session.totalChunks || session.receivedBytes !== session.bytes) {
    throw new MediaTransferError('TRANSFER_INCOMPLETE', `上传未完整：已收 ${session.receivedChunks}/${session.totalChunks} 片（${session.receivedBytes}/${session.bytes} 字节）。`, true);
  }
  uploads.delete(uploadId);
  const assembled = new Uint8Array(session.bytes);
  let offset = 0;
  for (let i = 0; i < session.totalChunks; i += 1) {
    const chunk = session.chunks[i];
    if (!chunk) throw new MediaTransferError('TRANSFER_INCOMPLETE', `缺少第 ${i} 片数据。`, true);
    assembled.set(chunk, offset);
    offset += chunk.length;
  }
  const actualSha = await sha256Hex(assembled);
  if (actualSha !== session.sha256) {
    throw new MediaTransferError('CHECKSUM_MISMATCH', '文件 SHA-256 校验失败，请重新上传。', true);
  }
  return {
    fileName: session.fileName,
    mimeType: session.mimeType,
    bytes: session.bytes,
    sha256: actualSha,
    data: assembled,
  };
}

export async function registerDownloadBuffer(input: {
  data: Uint8Array;
  fileName: string;
  mimeType: string;
  chunkBytes?: number;
}) {
  const now = Date.now();
  pruneExpired(now);
  if (input.data.length > LINK_MAX_MEDIA_BYTES) {
    throw new MediaTransferError(LINK_ERROR.INVALID_ARGUMENT, `数据大小 ${(input.data.length / 1024 / 1024).toFixed(1)} MB 超过直传上限 ${(LINK_MAX_MEDIA_BYTES / 1024 / 1024).toFixed(0)} MB。`);
  }
  while (downloads.size >= MAX_CACHED_DOWNLOADS) {
    const oldestKey = downloads.keys().next().value;
    if (oldestKey) downloads.delete(oldestKey);
    else break;
  }
  const chunkBytes = input.chunkBytes && input.chunkBytes >= 1024 && input.chunkBytes <= LINK_MEDIA_CHUNK_BYTES
    ? input.chunkBytes
    : LINK_MEDIA_CHUNK_BYTES;
  const sha256 = await sha256Hex(input.data);
  const totalChunks = Math.max(1, Math.ceil(input.data.length / chunkBytes));
  const downloadId = 'dl_' + crypto.randomUUID().replace(/-/g, '').slice(0, 20);
  downloads.set(downloadId, {
    downloadId,
    fileName: input.fileName,
    mimeType: input.mimeType,
    bytes: input.data.length,
    sha256,
    chunkBytes,
    totalChunks,
    data: input.data,
    expiresAt: now + TRANSFER_TTL_MS,
  });
  return {
    downloadId,
    fileName: input.fileName,
    mimeType: input.mimeType,
    bytes: input.data.length,
    sha256,
    chunkBytes,
    totalChunks,
  };
}

export function readDownloadChunk(input: {
  downloadId?: unknown;
  index?: unknown;
  release?: unknown;
}) {
  const now = Date.now();
  pruneExpired(now);
  const downloadId = String(input.downloadId || '').trim();
  const buffer = downloads.get(downloadId);
  if (!buffer) {
    throw new MediaTransferError('TRANSFER_NOT_FOUND', `下载缓存不存在或已过期：${downloadId || '(空)'}。`, true);
  }
  const index = Number(input.index);
  if (!Number.isInteger(index) || index < 0 || index >= buffer.totalChunks) {
    throw new MediaTransferError(LINK_ERROR.INVALID_ARGUMENT, `分片序号越界：${String(input.index)}（共 ${buffer.totalChunks} 片）。`);
  }
  const start = index * buffer.chunkBytes;
  const end = Math.min(buffer.data.length, start + buffer.chunkBytes);
  const slice = buffer.data.subarray(start, end);
  const done = index === buffer.totalChunks - 1;
  if (input.release === true) {
    downloads.delete(downloadId);
  } else {
    buffer.expiresAt = now + TRANSFER_TTL_MS;
  }
  return {
    downloadId,
    index,
    totalChunks: buffer.totalChunks,
    bytes: slice.length,
    dataBase64: encodeBase64(slice),
    done,
  };
}

export function resetLinkMediaTransfersForTests() {
  uploads.clear();
  downloads.clear();
}
