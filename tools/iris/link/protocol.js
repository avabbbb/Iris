// Iris Link 协议（CLI ↔ 中继 ↔ 浏览器标签页）的唯一常量来源。
// 中继（worker/linkRelay.ts）、CLI（tools/iris/link/*）、标签页（services/link/*）都从这里取：
// 帧类型、错误码、权限范围（scope）、命令 → scope 映射、大小上限。改这里就是改协议，改完同步 docs/dev/iris-link-protocol.md。
//
// 设计要点（详见文档）：
// - 中继只转发：不解析 args 内容、不存画布、不接触模型 Key；只看帧头（t / id / cmd）做 scope 与大小检查。
// - 执行全部在标签页里：命令走现有 Tool Policy / 审批 / Spend Mandate / Session Authority。
// - CLI 永远不能批准付费或破坏性操作；非付费确认只有在配对时授予 agent.approve 才能由 CLI 处理。

export const LINK_PROTOCOL_VERSION = '1';
/** WebSocket 子协议：第一个是协议名（中继回显），第二个携带令牌（bearer.<token>），令牌不进 URL。 */
export const LINK_WS_SUBPROTOCOL = 'iris-link.v1';
export const LINK_WS_BEARER_PREFIX = 'bearer.';

export const DEFAULT_LINK_WEB_URL = 'https://iris.avabbbb.com';

/** 单帧上限（字节，UTF-8）。超过的帧中继直接拒绝（FRAME_TOO_LARGE），不截断。 */
export const LINK_MAX_FRAME_BYTES = 256 * 1024;
/** 配对码有效期 / 轮询间隔。 */
export const LINK_PAIR_TTL_MS = 10 * 60_000;
export const LINK_PAIR_POLL_INTERVAL_MS = 2_000;
/** 访问令牌（短期）与 refresh（轮换）有效期。 */
export const LINK_ACCESS_TTL_MS = 15 * 60_000;
export const LINK_REFRESH_TTL_MS = 30 * 24 * 60 * 60_000;
/** 每个房间每个 CLI 连接的请求速率：令牌桶容量 / 每秒补充。 */
export const LINK_RATE_BURST = 60;
export const LINK_RATE_PER_SEC = 20;
/** 每个来源 IP 每分钟最多发起几次配对。 */
export const LINK_PAIR_START_PER_MIN = 10;
/** 每个房间最多同时几个 CLI 连接、几个标签页连接（标签页同一时刻只有一个在线，多余的被替换）。 */
export const LINK_MAX_CLI_SOCKETS = 4;

/**
 * 权限范围。配对时 CLI 申请、用户在页面上逐项勾选授予；中继按 scope 拦命令，标签页再按自己保存的授予记录复核一次。
 * - agent.read：link.status、agent.sessions、agent.trace、agent.tools.list
 * - agent.run：agent.send、agent.cancel、agent.deny（拒绝只会减少花费）
 * - agent.approve：处理「非付费、非破坏性」的工具确认（付费 / 删除永远只能在页面上批准）
 * - tools.invoke：agent.tools.invoke --execute（默认 dry-run 只需 agent.read）
 */
export const LINK_SCOPES = Object.freeze(['agent.read', 'agent.run', 'agent.approve', 'tools.invoke']);
export const LINK_DEFAULT_SCOPES = Object.freeze(['agent.read', 'agent.run']);
export const LINK_SCOPE_LABELS = Object.freeze({
  'agent.read': { zho: '查看会话、轨迹和工具列表', en: 'Read sessions, traces and the tool list' },
  'agent.run': { zho: '发起 / 取消 Agent 会话，拒绝待审批项', en: 'Start or cancel Agent turns, deny pending approvals' },
  'agent.approve': { zho: '批准非付费的工具确认（付费、删除仍需你在页面上批准）', en: 'Approve non-paid tool confirmations (paid and destructive steps still need you on the page)' },
  'tools.invoke': { zho: '直接调用画布工具（照常走审批与预算）', en: 'Invoke canvas tools directly (approvals and budgets still apply)' },
});

/** 走 link 的命令（标签页里执行）。名字沿用 COMMAND_REGISTRY 的点分风格。 */
export const LINK_COMMANDS = Object.freeze({
  'link.status': { scope: 'agent.read', write: false },
  'agent.sessions': { scope: 'agent.read', write: false },
  'agent.send': { scope: 'agent.run', write: true },
  'agent.trace': { scope: 'agent.read', write: false },
  'agent.approve': { scope: 'agent.approve', write: true },
  'agent.deny': { scope: 'agent.run', write: true },
  'agent.cancel': { scope: 'agent.run', write: true },
  'agent.tools.list': { scope: 'agent.read', write: false },
  // execute=true 时标签页额外要求 tools.invoke；中继只按基础 scope 拦。
  'agent.tools.invoke': { scope: 'agent.read', write: false },
});

export function isLinkCommand(command) {
  return Object.hasOwn(LINK_COMMANDS, String(command || ''));
}

/** 命令在给定授予下是否允许；返回缺的 scope（允许时 null）。args 只用来判断 tools.invoke 的 execute。 */
export function missingLinkScope(command, scopes, args = {}) {
  const definition = LINK_COMMANDS[command];
  if (!definition) return 'unknown';
  const granted = new Set(scopes || []);
  if (!granted.has(definition.scope)) return definition.scope;
  if (command === 'agent.tools.invoke' && args && args.execute === true && !granted.has('tools.invoke')) return 'tools.invoke';
  return null;
}

/** 写命令必须带幂等键（重试不重复发起回合 / 落写）。 */
export function linkCommandNeedsIdempotency(command, args = {}) {
  if (command === 'agent.tools.invoke') return Boolean(args && args.execute === true);
  return Boolean(LINK_COMMANDS[command]?.write);
}

export function normalizeLinkScopes(value) {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const out = [];
  for (const raw of list) {
    const scope = String(raw || '').trim();
    if (LINK_SCOPES.includes(scope) && !out.includes(scope)) out.push(scope);
  }
  return out;
}

/** 帧类型。 */
export const LINK_FRAME = Object.freeze({
  /** CLI → 标签页：{ t, id, cmd, args, idem? }；中继补上 grant（scopes / clientName / linkId）。 */
  REQUEST: 'req',
  /** 标签页 → CLI：{ t, id, ok, data? , error? } */
  RESPONSE: 'res',
  /** 标签页 → CLI（广播）：{ t, event, data } */
  EVENT: 'evt',
  /** 中继 → 任意一端：{ t, code, message? }（TAB_ONLINE / TAB_OFFLINE / REVOKED / RATE_LIMITED …） */
  SYSTEM: 'sys',
  /** 标签页 → 中继：{ t:'hello', tab:{ title?, projectId? } } */
  HELLO: 'hello',
});

export const LINK_ERROR = Object.freeze({
  TAB_OFFLINE: 'TAB_OFFLINE',
  TAB_TIMEOUT: 'TAB_TIMEOUT',
  APPROVAL_PENDING: 'APPROVAL_PENDING',
  APPROVAL_REQUIRES_USER: 'APPROVAL_REQUIRES_USER',
  SCOPE_DENIED: 'SCOPE_DENIED',
  RATE_LIMITED: 'RATE_LIMITED',
  FRAME_TOO_LARGE: 'FRAME_TOO_LARGE',
  BAD_FRAME: 'BAD_FRAME',
  UNAUTHORIZED: 'UNAUTHORIZED',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  REVOKED: 'REVOKED',
  ORIGIN_DENIED: 'ORIGIN_DENIED',
  PAIR_EXPIRED: 'PAIR_EXPIRED',
  PAIR_DENIED: 'PAIR_DENIED',
  PAIR_PENDING: 'PAIR_PENDING',
  NOT_LINKED: 'NOT_LINKED',
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  AGENT_PANEL_CLOSED: 'AGENT_PANEL_CLOSED',
  UNKNOWN_RUN: 'UNKNOWN_RUN',
  UNKNOWN_COMMAND: 'UNKNOWN_COMMAND',
});

/** WebSocket 关闭码（4000–4999 应用自定义）。 */
export const LINK_CLOSE = Object.freeze({
  REVOKED: 4401,
  REPLACED: 4409,
  TOO_LARGE: 4413,
  RATE_LIMITED: 4429,
  /** 访问令牌过期：CLI 用 refresh 换新令牌后重连。 */
  TOKEN_EXPIRED: 4440,
});

/**
 * 令牌格式：ilk_<kind>_<roomId>_<secret>。kind = a(access) / r(refresh) / t(tab) / p(配对轮询)。
 * roomId 让 Worker 不查表就能路由到房间；房间只存 SHA-256，令牌只在它所属的房间里有效。
 */
export const LINK_TOKEN_PREFIX = 'ilk';
const TOKEN_RE = /^ilk_([artp])_([a-f0-9]{32})_([A-Za-z0-9_-]{32,})$/;

export function parseLinkToken(token) {
  const match = TOKEN_RE.exec(String(token || ''));
  if (!match) return null;
  return { kind: match[1], roomId: match[2], secret: match[3] };
}

/** 配对码：8 位、去掉易混字符，显示成 XXXX-XXXX。 */
export const LINK_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function normalizeLinkCode(value) {
  const raw = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (raw.length !== 8) return null;
  for (const char of raw) if (!LINK_CODE_ALPHABET.includes(char)) return null;
  return raw.slice(0, 4) + '-' + raw.slice(4);
}

export function utf8Length(text) {
  return new TextEncoder().encode(String(text)).length;
}
