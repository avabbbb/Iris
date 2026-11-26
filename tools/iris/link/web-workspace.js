// 通过 Iris Link（~/.iris/link.json → /api/link/ws）或本机 loopback 传输直接操作网页版 Iris：
// - 只读命令走 workflow.read（仅需默认 agent.read scope，不依赖打开内置 Agent 面板）；
// - 写/执行命令走 workflow.exec（完整保留 Tool Policy / Spend Mandate / 页面审批托盘）；
// - 本地媒体导入（--file）与导出落盘（--output）通过 96 KiB 内存分片 + SHA-256 校验直传，无需 S3/R2。
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { COMMAND_REGISTRY } from '../core.js';
import { followRunTrace } from './agent-commands.js';
import { linkFilePath, readLink } from './link-store.js';
import { LINK_ERROR, LINK_MAX_MEDIA_BYTES, LINK_MEDIA_CHUNK_BYTES } from './protocol.js';
import { createWebTransport } from './transports.js';
import { LinkClientError, WebLinkClient } from './web-link-client.js';

const CLI_WRAPPER_KEYS = new Set([
  '_',
  'json',
  'pretty',
  'target',
  'url',
  'help',
  'h',
  'file',
  'filePath',
  'file-path',
  'output',
  'out',
  'outputPath',
  'output-path',
  'agentIdentity',
  'agent-identity',
  'hostSessionId',
  'host-session-id',
  'idempotencyKey',
  'idempotency-key',
  'workspaceMode',
  'workspace-mode',
  'projectId',
  'project-id',
]);

export const WEB_LINK_READ_COMMANDS = new Set([
  'provider.status',
  'workflow.project.list',
  'workflow.inspect',
  'workflow.selection.get',
  'workflow.models.list',
  'workflow.shortcut.list',
  'workflow.nodes.search',
  'workflow.cost.estimate',
  'workflow.node.tool.list',
]);

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/opus',
};

const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));

function toKebab(name) {
  return name.replace(/([A-Z])/g, '-$1').toLowerCase();
}

function sha256Buffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function coerceTypedArg(name, raw, descriptor) {
  const base = String(descriptor || '').replace(/\?$/, '');
  if (base === 'number') {
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new LinkClientError(LINK_ERROR.INVALID_ARGUMENT, `--${toKebab(name)} 必须是合法数字。`);
    return value;
  }
  if (base === 'boolean') return raw === true || String(raw).toLowerCase() === 'true';
  if (base === 'string[]') {
    if (Array.isArray(raw)) return raw.map(String);
    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (trimmed.startsWith('[')) {
        try { return JSON.parse(trimmed); } catch (error) {
          throw new LinkClientError(LINK_ERROR.INVALID_ARGUMENT, `--${toKebab(name)} 不是合法 JSON 数组：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return trimmed ? trimmed.split(',').map(item => item.trim()).filter(Boolean) : [];
    }
  }
  if ((base === 'object' || base === 'array') && typeof raw === 'string') {
    try { return JSON.parse(raw); } catch (error) {
      throw new LinkClientError(LINK_ERROR.INVALID_ARGUMENT, `--${toKebab(name)} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return raw;
}

/** 将 CLI 解析后的参数转换成画布命令期望的参数对象（projectId 放在外层传入）。 */
export function buildWebLinkToolInvocation(command, rawArgs = {}) {
  const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};
  const projectId = String(args.projectId ?? args['project-id'] ?? '').trim() || undefined;
  const definition = COMMAND_REGISTRY[command];
  const toolArgs = {};
  if (definition?.args && typeof definition.args === 'object') {
    for (const [name, descriptor] of Object.entries(definition.args)) {
      if (name === 'projectId' || name === 'workspaceMode') continue;
      const kebab = toKebab(name);
      const raw = args[name] ?? args[kebab];
      if (raw === undefined) continue;
      toolArgs[name] = coerceTypedArg(name, raw, descriptor);
    }
    if (command === 'workflow.apply' && toolArgs.operations === undefined && args.ops !== undefined) {
      toolArgs.operations = coerceTypedArg('operations', args.ops, 'array');
    }
  } else {
    for (const [key, value] of Object.entries(args)) {
      if (CLI_WRAPPER_KEYS.has(key) || value === undefined) continue;
      toolArgs[key] = value;
    }
  }
  return { projectId, toolArgs };
}

export function hasSavedWebLink(options = {}) {
  const file = options.storeOptions?.file || linkFilePath(options.env || process.env);
  return existsSync(file);
}

/** 查询已保存的 Iris Link 在线状态（走 HTTP /api/link/status，不暴露任何令牌）。 */
export async function probeWebLinkStatus(options = {}) {
  if (!options.client && !hasSavedWebLink(options)) return null;
  let record = null;
  try {
    record = options.client?.record || readLink(options.storeOptions || { env: options.env });
  } catch {
    return null;
  }
  if (!record && !options.client) return null;
  try {
    const client = options.client || new WebLinkClient({
      record,
      baseUrl: options.baseUrl,
      storeOptions: options.storeOptions,
      fetchImpl: options.fetchImpl,
    });
    const status = await client.status();
    return {
      ok: true,
      linked: true,
      url: client.baseUrl,
      tabOnline: Boolean(status?.tabOnline),
      scopes: Array.isArray(status?.scopes) ? status.scopes : (client.scopes || []),
      tab: status?.tab || null,
      clientName: status?.clientName || record?.clientName || null,
    };
  } catch (error) {
    return {
      ok: false,
      linked: true,
      url: record?.baseUrl || options.baseUrl || null,
      tabOnline: false,
      scopes: record?.scopes || [],
      tab: null,
      error: typeof error?.toJSON === 'function'
        ? error.toJSON()
        : { code: error?.code || 'LINK_UNREACHABLE', message: error instanceof Error ? error.message : String(error) },
    };
  }
}

async function requestWithRateLimitRetry(transport, cmd, args, requestOptions = {}, maxRetries = 8) {
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await transport.request(cmd, args, requestOptions);
    } catch (error) {
      if (error?.code === LINK_ERROR.RATE_LIMITED && attempt < maxRetries) {
        await sleep(Math.min(1000, 120 * (attempt + 1)));
        continue;
      }
      throw error;
    }
  }
  throw new LinkClientError(LINK_ERROR.RATE_LIMITED, 'Iris Link 请求频率超限，请稍后重试。', { retryable: true });
}

async function fetchDownloadBuffer(transport, descriptor, progress = () => {}) {
  const totalChunks = Math.max(1, Number(descriptor.totalChunks) || 1);
  const parts = [];
  for (let index = 0; index < totalChunks; index += 1) {
    const chunk = await requestWithRateLimitRetry(transport, 'media.download.chunk', {
      downloadId: descriptor.downloadId,
      index,
      release: index === totalChunks - 1,
    });
    parts.push(Buffer.from(String(chunk.dataBase64 || ''), 'base64'));
    if (totalChunks > 4 && ((index + 1) % 8 === 0 || index === totalChunks - 1)) {
      progress(`下载分片 ${index + 1}/${totalChunks}`);
    }
  }
  const assembled = Buffer.concat(parts);
  if (descriptor.bytes !== undefined && assembled.length !== Number(descriptor.bytes)) {
    throw new LinkClientError('TRANSFER_INCOMPLETE', `下载字节数不一致：期望 ${descriptor.bytes}，实收 ${assembled.length}。`, { retryable: true });
  }
  if (descriptor.sha256) {
    const actualSha = sha256Buffer(assembled);
    if (actualSha !== String(descriptor.sha256).toLowerCase()) {
      throw new LinkClientError('CHECKSUM_MISMATCH', '下载数据的 SHA-256 校验失败，请重试。', { retryable: true });
    }
  }
  return assembled;
}

async function unwrapMaybeChunked(transport, payload, progress = () => {}) {
  if (!payload || typeof payload !== 'object') return payload;
  if (payload.chunked === true && typeof payload.downloadId === 'string') {
    const assembled = await fetchDownloadBuffer(transport, payload, progress);
    return JSON.parse(assembled.toString('utf8'));
  }
  return payload;
}

function unwrapLegacyInvokeResult(result) {
  if (!result || typeof result !== 'object') return { ok: true, result };
  const details = result.details;
  if (details && typeof details === 'object' && !details.truncated) return details;
  if (typeof result.text === 'string' && result.text.trim()) {
    try { return { ok: true, result: JSON.parse(result.text) }; } catch { /* fallback below */ }
  }
  return { ok: true, result };
}

async function followExecRun(transport, command, runId, options = {}) {
  const progress = options.progress || (() => {});
  let doneEvent = null;
  const final = await followRunTrace(transport, runId, {
    ...(options.followOptions || {}),
    onEvent: event => {
      if (event.type === 'done') doneEvent = event;
      if (event.type === 'approval.pending') {
        const hint = event.cliApprovable
          ? `等待批准：可在 Iris 页面托盘批准，或运行 iris agent approve --run ${runId}`
          : '等待你在 Iris 页面上批准（付费或删除操作仅能在页面确认）';
        progress(`${hint} — ${event.summary || command}`);
      }
    },
  });
  if (final.phase !== 'done') {
    return {
      ok: false,
      error: {
        code: final.phase === 'cancelled' ? 'CANCELLED' : 'WORKSPACE_COMMAND_FAILED',
        message: final.error || `${command} 未完成（${final.phase}）。`,
        retryable: false,
      },
    };
  }
  const rawResult = doneEvent?.result;
  const unwrapped = await unwrapMaybeChunked(transport, rawResult, progress);
  if (unwrapped && typeof unwrapped === 'object' && ('ok' in unwrapped || 'commandId' in unwrapped)) {
    return unwrapped;
  }
  return unwrapLegacyInvokeResult(unwrapped);
}

export function localImportFileArg(args = {}) {
  const value = args.file ?? args.filePath ?? args['file-path'];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function localExportOutputArg(args = {}) {
  const value = args.output ?? args.out ?? args.outputPath ?? args['output-path'];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** 无 S3/R2：将本地图片/视频/音频分片直传到浏览器画布并入 IndexedDB。 */
export async function uploadLocalMediaOverTransport(transport, args = {}, options = {}) {
  const localPath = localImportFileArg(args);
  if (!localPath) throw new LinkClientError(LINK_ERROR.INVALID_ARGUMENT, '缺少本地文件路径（--file <path>）。');
  const resolved = resolve(localPath);
  let data;
  try {
    data = await readFile(resolved);
  } catch (error) {
    throw new LinkClientError('FILE_READ_ERROR', `无法读取本地媒体文件 ${resolved}：${error instanceof Error ? error.message : String(error)}`);
  }
  if (data.length === 0) throw new LinkClientError(LINK_ERROR.INVALID_ARGUMENT, `文件为空：${resolved}`);
  if (data.length > LINK_MAX_MEDIA_BYTES) {
    throw new LinkClientError(
      LINK_ERROR.INVALID_ARGUMENT,
      `文件 ${(data.length / 1024 / 1024).toFixed(1)} MB 超过直传上限 ${(LINK_MAX_MEDIA_BYTES / 1024 / 1024).toFixed(0)} MB。`,
    );
  }
  const fileName = basename(resolved);
  const mimeType = String(args.mimeType || args['mime-type'] || MIME_BY_EXT[extname(fileName).toLowerCase()] || '').trim();
  const sha256 = sha256Buffer(data);
  const baseKey = String(options.idempotencyKey || args.idempotencyKey || args['idempotency-key'] || '').trim() || randomUUID();
  const progress = options.progress || (() => {});

  const started = await requestWithRateLimitRetry(transport, 'media.upload.start', {
    fileName,
    mimeType,
    bytes: data.length,
    sha256,
    chunkBytes: LINK_MEDIA_CHUNK_BYTES,
  }, { idempotencyKey: `${baseKey}:start` });

  const chunkBytes = Number(started.chunkBytes) || LINK_MEDIA_CHUNK_BYTES;
  const totalChunks = Math.max(1, Number(started.totalChunks) || Math.ceil(data.length / chunkBytes));
  for (let index = 0; index < totalChunks; index += 1) {
    const slice = data.subarray(index * chunkBytes, Math.min(data.length, (index + 1) * chunkBytes));
    await requestWithRateLimitRetry(transport, 'media.upload.chunk', {
      uploadId: started.uploadId,
      index,
      dataBase64: slice.toString('base64'),
    });
    if (totalChunks > 4 && ((index + 1) % 8 === 0 || index === totalChunks - 1)) {
      progress(`上传分片 ${index + 1}/${totalChunks}`);
    }
  }

  const projectId = String(args.projectId ?? args['project-id'] ?? '').trim() || undefined;
  const attachToNodeId = String(args.attachToNodeId ?? args['attach-to-node-id'] ?? '').trim() || undefined;
  const title = typeof args.title === 'string' && args.title.trim() ? args.title.trim() : undefined;
  const mention = args.mention === undefined ? undefined : (args.mention === true || String(args.mention).toLowerCase() === 'true');
  const expectedRevision = args.expectedRevision ?? args['expected-revision'];
  const mutationId = String(args.mutationId ?? args['mutation-id'] ?? baseKey).trim();

  const finished = await requestWithRateLimitRetry(transport, 'media.upload.finish', {
    uploadId: started.uploadId,
    ...(projectId ? { projectId } : {}),
    ...(title ? { title } : {}),
    ...(attachToNodeId ? { attachToNodeId } : {}),
    ...(mention !== undefined ? { mention } : {}),
    ...(expectedRevision !== undefined ? { expectedRevision: Number(expectedRevision) } : {}),
    mutationId,
  }, { idempotencyKey: `${baseKey}:finish` });

  if (finished?.immediate) return unwrapMaybeChunked(transport, finished.result, progress);
  if (finished?.runId) return followExecRun(transport, 'workflow.media.import', finished.runId, options);
  return unwrapMaybeChunked(transport, finished, progress);
}

/** 无 S3/R2：将网页画布的导出文件（原图/视频/ZIP/CSV）分片拉回本地磁盘或 inline base64。 */
export async function downloadExportOverTransport(transport, args = {}, options = {}) {
  const { projectId, toolArgs } = buildWebLinkToolInvocation('workflow.export', args);
  const progress = options.progress || (() => {});
  const outputArg = localExportOutputArg(args);
  const inline = toolArgs.inline === true;

  const started = await requestWithRateLimitRetry(transport, 'media.download.start', {
    ...(projectId ? { projectId } : {}),
    ...(toolArgs.nodeIds !== undefined ? { nodeIds: toolArgs.nodeIds } : {}),
    ...(toolArgs.groupId !== undefined ? { groupId: toolArgs.groupId } : {}),
    ...(toolArgs.fileName !== undefined ? { fileName: toolArgs.fileName } : {}),
  });

  const assembled = await fetchDownloadBuffer(transport, started, progress);
  let savedTo = null;
  if (outputArg) {
    const resolvedOut = resolve(outputArg);
    const isExistingDir = existsSync(resolvedOut) && statSync(resolvedOut).isDirectory();
    const targetPath = isExistingDir ? join(resolvedOut, started.fileName || 'iris-export.bin') : resolvedOut;
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, assembled);
    savedTo = targetPath;
  }

  return {
    ok: true,
    result: {
      projectId: started.projectId ?? projectId ?? null,
      fileName: started.fileName,
      mimeType: started.mimeType,
      bytes: started.bytes,
      sha256: started.sha256,
      mode: started.mode,
      saved: Boolean(savedTo),
      ...(savedTo ? { savedTo } : {}),
      files: started.files || [],
      skipped: started.skipped || [],
      ...(inline ? { dataBase64: assembled.toString('base64') } : {}),
    },
  };
}

/**
 * 通过已配对的 Iris Link（web transport）执行 workspace / workflow.* / provider.status 命令。
 * 无需 S3/R2，也不依赖本机 Vite 或打开内置 Agent 面板。
 */
export async function executeWorkspaceCommandOverWebLink(command, args = {}, options = {}) {
  const ownedTransport = !options.transport;
  const transport = options.transport || createWebTransport({
    baseUrl: typeof args.url === 'string' ? args.url : undefined,
    storeOptions: options.storeOptions,
    fetchImpl: options.fetchImpl,
  });
  const progress = options.progress || (() => {});
  try {
    if (command === 'workspace.status') {
      const status = await transport.request('link.status', {});
      return {
        authority: 'iris-link-web',
        state: 'ready',
        ...status,
      };
    }

    if (command === 'workflow.media.import' && localImportFileArg(args)) {
      return await uploadLocalMediaOverTransport(transport, args, options);
    }

    if (command === 'workflow.export' && (localExportOutputArg(args) || args.inline === true || String(args.inline).toLowerCase() === 'true')) {
      return await downloadExportOverTransport(transport, args, options);
    }

    const { projectId, toolArgs } = buildWebLinkToolInvocation(command, args);

    if (WEB_LINK_READ_COMMANDS.has(command)) {
      try {
        const readResult = await transport.request('workflow.read', {
          command,
          args: toolArgs,
          ...(projectId ? { projectId } : {}),
        });
        return await unwrapMaybeChunked(transport, readResult, progress);
      } catch (error) {
        // 兼容尚未重新部署 workflow.read 的旧线上页面：回退到 agent.tools.invoke。
        if (error?.code !== LINK_ERROR.UNKNOWN_COMMAND || command === 'provider.status') throw error;
      }
    }

    const idempotencyKey = String(options.idempotencyKey || args.idempotencyKey || args['idempotency-key'] || '').trim() || randomUUID();
    if (command.startsWith('workflow.')) {
      try {
        const execResult = await transport.request('workflow.exec', {
          command,
          args: toolArgs,
          ...(projectId ? { projectId } : {}),
        }, { idempotencyKey });
        if (execResult?.immediate) return await unwrapMaybeChunked(transport, execResult.result, progress);
        if (execResult?.runId) return await followExecRun(transport, command, execResult.runId, options);
        return await unwrapMaybeChunked(transport, execResult, progress);
      } catch (error) {
        if (error?.code !== LINK_ERROR.UNKNOWN_COMMAND) throw error;
      }
    }

    const started = await transport.request('agent.tools.invoke', {
      tool: command,
      args: toolArgs,
      execute: true,
      ...(projectId ? { projectId } : {}),
    }, { idempotencyKey });
    if (!started?.runId) return { ok: true, result: started };
    return await followExecRun(transport, command, started.runId, options);
  } finally {
    if (ownedTransport) transport.close();
  }
}
