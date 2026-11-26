// 通过 Iris Link（~/.iris/link.json → /api/link/ws）转发 CLI 的 workspace / workflow.* 命令。
// 复用标签页里现有的 agent.tools.invoke（同一份 Tool Policy / Spend Mandate / 页面审批托盘），
// 不新增中继协议，也不绕过任何付费或删除确认。
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { COMMAND_REGISTRY } from '../core.js';
import { followRunTrace } from './agent-commands.js';
import { linkFilePath } from './link-store.js';
import { LINK_ERROR } from './protocol.js';
import { createWebTransport } from './transports.js';
import { LinkClientError } from './web-link-client.js';

const CLI_WRAPPER_KEYS = new Set([
  '_',
  'json',
  'pretty',
  'target',
  'url',
  'help',
  'h',
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

function toKebab(name) {
  return name.replace(/([A-Z])/g, '-$1').toLowerCase();
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

/** 将 CLI 解析后的参数转换成标签页内置工具 Schema 期望的参数对象（projectId 放在外层传入）。 */
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
    // 兼容 workflow.apply 的 --ops 别名
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

function unwrapToolResult(result) {
  if (!result || typeof result !== 'object') return { ok: true, result };
  const details = result.details;
  if (details && typeof details === 'object' && !details.truncated) return details;
  if (typeof result.text === 'string' && result.text.trim()) {
    try { return { ok: true, result: JSON.parse(result.text) }; } catch { /* return text fallback below */ }
  }
  return { ok: true, result };
}

/**
 * 通过已配对的 Iris Link（web transport）执行 workspace.status 或 workflow.* 命令。
 * 需要标签页在线；执行写入/读取工具需配对时授予 `tools.invoke` scope。
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

    const { projectId, toolArgs } = buildWebLinkToolInvocation(command, args);
    const idempotencyKey = String(options.idempotencyKey || args.idempotencyKey || args['idempotency-key'] || '').trim() || randomUUID();
    const started = await transport.request('agent.tools.invoke', {
      tool: command,
      args: toolArgs,
      execute: true,
      ...(projectId ? { projectId } : {}),
    }, { idempotencyKey });

    if (!started?.runId) return { ok: true, result: started };

    let doneEvent = null;
    const final = await followRunTrace(transport, started.runId, {
      ...(options.followOptions || {}),
      onEvent: event => {
        if (event.type === 'done') doneEvent = event;
        if (event.type === 'approval.pending') {
          const hint = event.cliApprovable
            ? `等待批准：可在 Iris 页面托盘批准，或运行 iris agent approve --run ${started.runId}`
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
    return unwrapToolResult(doneEvent?.result);
  } finally {
    if (ownedTransport) transport.close();
  }
}
