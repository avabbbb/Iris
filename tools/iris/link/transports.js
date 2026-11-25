// 同一套 Agent link 命令的两种传输：
// - local：本机 loopback（~/.iris/agent.json → 本地 Agent 服务 /api/tools → 标签页的 SSE tool_call），可信本地 CLI；
// - web：线上 Iris（~/.iris/link.json → /api/link 中继 → 标签页的 WebSocket）。
// 两边在标签页里走同一个处理器（services/link/agentLinkCommands.ts），返回同一个形状 { ok, data | error }。
import { existsSync } from 'node:fs';
import { LINK_ERROR, linkCommandNeedsIdempotency } from './protocol.js';
import { linkFilePath } from './link-store.js';
import { LinkClientError, WebLinkClient } from './web-link-client.js';

export const LINK_TARGETS = Object.freeze(['auto', 'local', 'web']);

function normalizeResult(value) {
  // 标签页处理器返回 { ok, data } / { ok:false, error }；本地 Agent 的 /api/tools 原样转回这个对象。
  if (value && typeof value === 'object' && value.ok === false) {
    const error = value.error || {};
    throw new LinkClientError(error.code || 'LINK_COMMAND_FAILED', error.message || String(error) || '标签页执行失败。', { retryable: Boolean(error.retryable), details: error.details ?? null });
  }
  if (value && typeof value === 'object' && value.ok === true && 'data' in value) return value.data;
  return value;
}

function requireIdempotency(cmd, args, options) {
  if (linkCommandNeedsIdempotency(cmd, args) && !String(options.idempotencyKey || '').trim()) {
    throw new LinkClientError(LINK_ERROR.INVALID_ARGUMENT, `${cmd} requires --idempotency-key so retries cannot start the same turn or write twice.`);
  }
}

export function createLocalTransport(options = {}) {
  let workspace = options.workspace || null;
  const getWorkspace = async () => {
    if (!workspace) {
      const { IrisWorkspaceClient } = await import('../workspace-client.js');
      workspace = new IrisWorkspaceClient(options.workspaceOptions);
    }
    return workspace;
  };
  return {
    kind: 'local',
    // 本机可信 CLI：授予除「批准付费」以外的全部范围（付费 / 删除照常只能在页面上批准）。
    scopes: ['agent.read', 'agent.run', 'agent.approve', 'tools.invoke'],
    async request(cmd, args = {}, requestOptions = {}) {
      requireIdempotency(cmd, args, requestOptions);
      const client = await getWorkspace();
      try {
        const result = await client.execute(cmd, args, 'cli', {
          ...(requestOptions.idempotencyKey ? { idempotencyKey: requestOptions.idempotencyKey } : {}),
          ...(requestOptions.timeoutMs ? { timeoutMs: requestOptions.timeoutMs } : {}),
        });
        return normalizeResult(result);
      } catch (error) {
        if (error instanceof LinkClientError) throw error;
        const code = error?.code === 'WORKSPACE_UNAVAILABLE' ? LINK_ERROR.TAB_OFFLINE : error?.code || 'LOCAL_COMMAND_FAILED';
        throw new LinkClientError(code, error instanceof Error ? error.message : String(error), { retryable: Boolean(error?.retryable), details: error?.details ?? null });
      }
    },
    async describe() {
      const client = await getWorkspace();
      const status = await client.status();
      return { transport: 'local', url: client.config.url, workspace: status };
    },
    close() {},
  };
}

export function createWebTransport(options = {}) {
  const client = options.client || new WebLinkClient(options);
  return {
    kind: 'web',
    client,
    get scopes() { return client.scopes; },
    async request(cmd, args = {}, requestOptions = {}) {
      requireIdempotency(cmd, args, requestOptions);
      try {
        return normalizeResult(await client.request(cmd, args, requestOptions));
      } catch (error) {
        // 访问令牌在长 follow 中途过期：刷新后重连，重发一次（写命令带同一个幂等键，标签页会去重）。
        if (error instanceof LinkClientError && error.code === LINK_ERROR.TOKEN_EXPIRED && !requestOptions.retried) {
          client.close();
          client.closedByUs = false;
          await client.refresh();
          return this.request(cmd, args, { ...requestOptions, retried: true });
        }
        throw error;
      }
    },
    async describe() {
      const status = await client.status();
      return { transport: 'web', url: client.baseUrl, relay: status };
    },
    close() { client.close(); },
  };
}

/** --target auto：本机 Agent 有已连接的标签页就用 local；否则有 link.json 就用 web。 */
export async function resolveLinkTransport(target = 'auto', options = {}) {
  const wanted = String(target || 'auto');
  if (!LINK_TARGETS.includes(wanted)) throw new LinkClientError(LINK_ERROR.INVALID_ARGUMENT, `--target 只能是 ${LINK_TARGETS.join(' | ')}。`);
  if (wanted === 'local') return createLocalTransport(options.local);
  if (wanted === 'web') return createWebTransport(options.web);
  const probeLocal = options.probeLocal || (async () => {
    const { agentConfigPath } = await import('../local-agent.js');
    if (!existsSync(agentConfigPath())) return false;
    try {
      const { IrisWorkspaceClient } = await import('../workspace-client.js');
      const status = await new IrisWorkspaceClient({ timeoutMs: 1500 }).status();
      return status.state === 'ready';
    } catch {
      return false;
    }
  });
  if (await probeLocal()) return createLocalTransport(options.local);
  const linkFile = options.web?.storeOptions?.file || linkFilePath(options.env);
  if (options.web?.record || existsSync(linkFile)) return createWebTransport(options.web);
  throw new LinkClientError(LINK_ERROR.NOT_LINKED, '没有找到可用的 Iris：本机没有已连接的 Iris 页面，也没有线上连接。运行 iris login web --open（沙箱用 --device），或在本机启动 Iris 后重试。');
}
