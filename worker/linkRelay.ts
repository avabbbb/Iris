// Iris Link 中继：/api/link/*（Cloudflare Worker + Durable Object，WebSocket Hibernation API）。
// 每个配对一个房间（idFromName('room:<roomId>')）；配对码查房间用 'code:<CODE>'，配对发起的按 IP 限速用 'rl:<ip>'。
// 中继只转发帧：不解析 args、不存画布、不接触模型 Key。房间里只存配对元数据与令牌的 SHA-256。
// 协议常量见 tools/iris/link/protocol.js，说明与威胁模型见 docs/dev/iris-link-protocol.md。
import {
  DEFAULT_LINK_WEB_URL,
  LINK_ACCESS_TTL_MS,
  LINK_CLOSE,
  LINK_CODE_ALPHABET,
  LINK_DEFAULT_SCOPES,
  LINK_ERROR,
  LINK_FRAME,
  LINK_MAX_CLI_SOCKETS,
  LINK_MAX_FRAME_BYTES,
  LINK_PAIR_POLL_INTERVAL_MS,
  LINK_PAIR_START_PER_MIN,
  LINK_PAIR_TTL_MS,
  LINK_PROTOCOL_VERSION,
  LINK_RATE_BURST,
  LINK_RATE_PER_SEC,
  LINK_REFRESH_TTL_MS,
  LINK_WS_BEARER_PREFIX,
  LINK_WS_SUBPROTOCOL,
  missingLinkScope,
  normalizeLinkCode,
  normalizeLinkScopes,
  parseLinkToken,
  utf8Length,
} from '../tools/iris/link/protocol.js';

export const LINK_PREFIX = '/api/link/';

/* ── 运行时类型（只声明用到的部分；仓库没装 @cloudflare/workers-types） ── */

export interface LinkSocket {
  send(message: string): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}
interface LinkStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  deleteAll(): Promise<void>;
  setAlarm(time: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}
export interface LinkDurableObjectState {
  storage: LinkStorage;
  acceptWebSocket(ws: LinkSocket, tags?: string[]): void;
  getWebSockets(tag?: string): LinkSocket[];
  setWebSocketAutoResponse?(pair: unknown): void;
}
interface DurableObjectStub { fetch(request: Request | string, init?: RequestInit): Promise<Response> }
interface DurableObjectId { toString(): string }
export interface LinkNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}
export interface LinkEnv {
  IRIS_LINK?: LinkNamespace;
  /** 额外允许的页面来源（逗号分隔），例如预览域名或本地开发的 http://127.0.0.1:37522。 */
  LINK_ALLOWED_ORIGINS?: string;
  /** 配对页的对外地址（默认取请求的 origin）。 */
  LINK_PUBLIC_URL?: string;
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...extra } });
}
function fail(status: number, code: string, message: string, extra: Record<string, unknown> = {}): Response {
  return json({ ok: false, error: { code, message, ...extra } }, status);
}

const hex = (bytes: ArrayBuffer | Uint8Array) => Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');

export async function sha256Hex(text: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}
function randomSecret(length = 32): string {
  return btoa(String.fromCharCode(...randomBytes(length))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function randomRoomId(): string {
  return hex(randomBytes(16));
}
export function randomLinkCode(): string {
  let raw = '';
  // 拒绝采样，避免取模偏差。
  while (raw.length < 8) {
    for (const byte of randomBytes(16)) {
      if (byte < 248 && raw.length < 8) raw += LINK_CODE_ALPHABET[byte % LINK_CODE_ALPHABET.length];
    }
  }
  return raw.slice(0, 4) + '-' + raw.slice(4);
}
function makeToken(kind: 'a' | 'r' | 't' | 'p', roomId: string): string {
  return 'ilk_' + kind + '_' + roomId + '_' + randomSecret(32);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ── 来源校验 ── */

export function allowedOrigins(request: Request, env: LinkEnv): Set<string> {
  const set = new Set<string>([new URL(DEFAULT_LINK_WEB_URL).origin, new URL(request.url).origin]);
  if (env.LINK_PUBLIC_URL) { try { set.add(new URL(env.LINK_PUBLIC_URL).origin); } catch { /* ignore */ } }
  for (const raw of (env.LINK_ALLOWED_ORIGINS || '').split(',')) {
    const value = raw.trim();
    if (!value) continue;
    try { set.add(new URL(value).origin); } catch { /* ignore */ }
  }
  return set;
}

/**
 * 页面接口（配对确认、标签页连接）：必须带允许列表里的 Origin。
 * 浏览器对同源 GET 不发 Origin，这时认浏览器自己声明的 Sec-Fetch-Site: same-origin（跨站网页伪造不了）。
 */
function requirePageOrigin(request: Request, env: LinkEnv): Response | null {
  const origin = request.headers.get('origin');
  if (!origin && request.method === 'GET' && request.headers.get('sec-fetch-site') === 'same-origin') return null;
  if (!origin || !allowedOrigins(request, env).has(origin)) return fail(403, LINK_ERROR.ORIGIN_DENIED, '这个页面来源不能操作 Iris Link。');
  return null;
}
/** CLI 接口：不允许陌生网页带着 Origin 调用（CLI 不发 Origin；允许列表里的页面也可以）。 */
function rejectForeignOrigin(request: Request, env: LinkEnv): Response | null {
  const origin = request.headers.get('origin');
  if (origin && !allowedOrigins(request, env).has(origin)) return fail(403, LINK_ERROR.ORIGIN_DENIED, '这个页面来源不能操作 Iris Link。');
  return null;
}

function bearer(request: Request): string {
  const header = request.headers.get('authorization') || '';
  return header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
}

/** 浏览器 WebSocket 不能带 Authorization：令牌放在第二个子协议 bearer.<token> 里，不进 URL / 日志。 */
export function websocketToken(request: Request): string {
  const header = request.headers.get('sec-websocket-protocol') || '';
  const parts = header.split(',').map(item => item.trim());
  const token = parts.find(item => item.startsWith(LINK_WS_BEARER_PREFIX));
  return token ? token.slice(LINK_WS_BEARER_PREFIX.length) : '';
}

function clientIp(request: Request): string {
  return request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown';
}
function maskIp(ip: string): string {
  if (ip.includes('.')) { const parts = ip.split('.'); return parts.length === 4 ? `${parts[0]}.${parts[1]}.x.x` : ip; }
  if (ip.includes(':')) return ip.split(':').slice(0, 3).join(':') + ':…';
  return ip;
}

async function readJson(request: Request, max = 16 * 1024): Promise<Record<string, unknown> | null> {
  const text = await request.text();
  if (utf8Length(text) > max) return null;
  try {
    const value = JSON.parse(text || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/* ── Worker 入口 ── */

function stub(env: LinkEnv, name: string): DurableObjectStub {
  const ns = env.IRIS_LINK;
  if (!ns) throw new Error('IRIS_LINK Durable Object binding is missing');
  return ns.get(ns.idFromName(name));
}

async function callDo(env: LinkEnv, name: string, path: string, body: unknown): Promise<Response> {
  return stub(env, name).fetch('https://link.internal' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

export async function handleLinkRequest(request: Request, env: LinkEnv): Promise<Response> {
  if (!env.IRIS_LINK) return fail(503, 'LINK_UNAVAILABLE', 'Iris Link 中继没有部署（缺少 IRIS_LINK Durable Object 绑定）。');
  const url = new URL(request.url);
  const route = url.pathname.slice(LINK_PREFIX.length);
  const method = request.method.toUpperCase();
  if (method === 'OPTIONS') return new Response(null, { status: 204 });

  if (route === 'ws' && method === 'GET') {
    if ((request.headers.get('upgrade') || '').toLowerCase() !== 'websocket') return fail(426, LINK_ERROR.BAD_FRAME, '需要 WebSocket。');
    const role = url.searchParams.get('role');
    if (role !== 'cli' && role !== 'tab') return fail(400, LINK_ERROR.INVALID_ARGUMENT, 'role 只能是 cli 或 tab。');
    const originError = role === 'tab' ? requirePageOrigin(request, env) : rejectForeignOrigin(request, env);
    if (originError) return originError;
    const parsed = parseLinkToken(websocketToken(request));
    if (!parsed || (role === 'cli' && parsed.kind !== 'a') || (role === 'tab' && parsed.kind !== 't')) return fail(401, LINK_ERROR.UNAUTHORIZED, '令牌无效。');
    // 原样转发升级请求（带上子协议头）到房间。
    return stub(env, 'room:' + parsed.roomId).fetch(new Request('https://link.internal/ws?role=' + role, request));
  }

  if (route === 'pair/start' && method === 'POST') {
    const originError = rejectForeignOrigin(request, env);
    if (originError) return originError;
    const ip = clientIp(request);
    const limited = await callDo(env, 'rl:' + ip, '/rl', { limit: LINK_PAIR_START_PER_MIN, windowMs: 60_000 });
    if (limited.status === 429) return fail(429, LINK_ERROR.RATE_LIMITED, '配对请求太频繁，请稍后再试。');
    const body = await readJson(request);
    if (!body) return fail(400, LINK_ERROR.INVALID_ARGUMENT, '请求体必须是 JSON。');
    const clientName = String(body.clientName || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 80) || 'iris-cli';
    const clientAgent = String(body.clientAgent || request.headers.get('user-agent') || '').replace(/[\u0000-\u001f]/g, '').slice(0, 160);
    const scopes = normalizeLinkScopes(body.scopes);
    const roomId = randomRoomId();
    const code = randomLinkCode();
    const pollToken = makeToken('p', roomId);
    const cf = (request as Request & { cf?: { country?: string; city?: string } }).cf;
    const init = await callDo(env, 'room:' + roomId, '/room/init', {
      roomId,
      code,
      clientName,
      clientAgent,
      source: { ip: maskIp(ip), country: cf?.country || null, city: cf?.city || null },
      requestedScopes: scopes.length ? scopes : [...LINK_DEFAULT_SCOPES],
      pollHash: await sha256Hex(pollToken),
      mode: body.mode === 'device' ? 'device' : 'open',
    });
    if (!init.ok) return init;
    await callDo(env, 'code:' + code, '/code/set', { roomId, expiresAt: Date.now() + LINK_PAIR_TTL_MS });
    const base = (env.LINK_PUBLIC_URL || url.origin).replace(/\/+$/, '');
    return json({
      ok: true,
      protocolVersion: LINK_PROTOCOL_VERSION,
      code,
      pollToken,
      verificationUrl: base + '/link',
      verificationUrlComplete: base + '/link?code=' + encodeURIComponent(code),
      expiresIn: Math.round(LINK_PAIR_TTL_MS / 1000),
      interval: Math.round(LINK_PAIR_POLL_INTERVAL_MS / 1000),
    });
  }

  if ((route === 'pair/info' && method === 'GET') || (route === 'pair/decide' && method === 'POST')) {
    const originError = requirePageOrigin(request, env);
    if (originError) return originError;
    const body = method === 'POST' ? await readJson(request) : { code: url.searchParams.get('code') };
    if (!body) return fail(400, LINK_ERROR.INVALID_ARGUMENT, '请求体必须是 JSON。');
    const code = normalizeLinkCode(body.code);
    if (!code) return fail(400, LINK_ERROR.INVALID_ARGUMENT, '配对码格式不对（8 位，例如 ABCD-2345）。');
    const lookup = await callDo(env, 'code:' + code, '/code/get', {});
    if (!lookup.ok) return fail(404, LINK_ERROR.PAIR_EXPIRED, '配对码不存在或已过期，请在终端重新运行 iris login web。');
    const { roomId } = await lookup.json() as { roomId: string };
    if (route === 'pair/info') return callDo(env, 'room:' + roomId, '/room/info', { code });
    const decided = await callDo(env, 'room:' + roomId, '/room/decide', { code, approve: body.approve === true, scopes: normalizeLinkScopes(body.scopes), tabLabel: String(body.tabLabel || '').slice(0, 80) });
    // 配对码一次性：无论批准还是拒绝都作废。
    if (decided.ok) await callDo(env, 'code:' + code, '/code/delete', {});
    return decided;
  }

  if (route === 'pair/poll' && method === 'POST') {
    const originError = rejectForeignOrigin(request, env);
    if (originError) return originError;
    const body = await readJson(request);
    const parsed = parseLinkToken(body?.pollToken);
    if (!parsed || parsed.kind !== 'p') return fail(401, LINK_ERROR.UNAUTHORIZED, '轮询令牌无效。');
    return callDo(env, 'room:' + parsed.roomId, '/room/poll', { pollToken: body!.pollToken });
  }

  if (route === 'token/refresh' && method === 'POST') {
    const originError = rejectForeignOrigin(request, env);
    if (originError) return originError;
    const body = await readJson(request);
    const parsed = parseLinkToken(body?.refreshToken);
    if (!parsed || parsed.kind !== 'r') return fail(401, LINK_ERROR.UNAUTHORIZED, 'refresh 令牌无效。');
    return callDo(env, 'room:' + parsed.roomId, '/room/refresh', { refreshToken: body!.refreshToken });
  }

  if ((route === 'revoke' && method === 'POST') || (route === 'status' && method === 'GET')) {
    const token = bearer(request);
    const parsed = parseLinkToken(token);
    if (!parsed || parsed.kind === 'p') return fail(401, LINK_ERROR.UNAUTHORIZED, '令牌无效。');
    // 标签页令牌只能从允许的页面来源使用；CLI 令牌不能被陌生网页使用。
    const originError = parsed.kind === 't' ? requirePageOrigin(request, env) : rejectForeignOrigin(request, env);
    if (originError) return originError;
    return callDo(env, 'room:' + parsed.roomId, route === 'revoke' ? '/room/revoke' : '/room/status', { token });
  }

  return fail(404, 'not_found', '未知的 Iris Link 接口。');
}

/* ── Durable Object ── */

interface RoomRecord {
  state: 'pending' | 'approved' | 'denied' | 'issued';
  roomId: string;
  code: string;
  clientName: string;
  clientAgent: string;
  source: { ip: string; country: string | null; city: string | null };
  requestedScopes: string[];
  grantedScopes: string[];
  mode: 'open' | 'device';
  createdAt: number;
  pairExpiresAt: number;
  pollHash: string;
  tabHash?: string;
  tabLabel?: string;
  accessHash?: string;
  accessExpiresAt?: number;
  refreshHash?: string;
  refreshExpiresAt?: number;
  approvedAt?: number;
}

interface SocketMeta {
  role: 'cli' | 'tab';
  sid: string;
  connectedAt: number;
  /** CLI：访问令牌到期时间；过期后要求刷新。 */
  expiresAt?: number;
  /** CLI：令牌桶。 */
  tokens?: number;
  refillAt?: number;
  tab?: { title?: string; projectId?: string | null };
}

type WebSocketPairCtor = new () => { 0: LinkSocket; 1: LinkSocket };

export class IrisLinkRelay {
  private now: () => number = () => Date.now();

  constructor(private readonly state: LinkDurableObjectState, private readonly env: LinkEnv) {
    const Pair = (globalThis as { WebSocketRequestResponsePair?: new (a: string, b: string) => unknown }).WebSocketRequestResponsePair;
    // 心跳由运行时自动回 pong，不唤醒休眠中的房间。
    if (Pair && state.setWebSocketAutoResponse) state.setWebSocketAutoResponse(new Pair('ping', 'pong'));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/ws') return this.acceptSocket(request, url.searchParams.get('role') === 'tab' ? 'tab' : 'cli');
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    switch (url.pathname) {
      case '/rl': return this.rateLimit(body);
      case '/code/set': return this.codeSet(body);
      case '/code/get': return this.codeGet();
      case '/code/delete': await this.state.storage.deleteAll(); return json({ ok: true });
      case '/room/init': return this.roomInit(body);
      case '/room/info': return this.roomInfo(body);
      case '/room/decide': return this.roomDecide(body);
      case '/room/poll': return this.roomPoll(body);
      case '/room/refresh': return this.roomRefresh(body);
      case '/room/revoke': return this.roomRevoke(body);
      case '/room/status': return this.roomStatus(body);
      default: return fail(404, 'not_found', 'unknown relay route');
    }
  }

  async alarm(): Promise<void> {
    const room = await this.state.storage.get<RoomRecord>('room');
    const code = await this.state.storage.get<{ expiresAt: number }>('code');
    const now = this.now();
    if (code && code.expiresAt <= now) { await this.state.storage.deleteAll(); return; }
    if (!room) return;
    const pendingExpired = (room.state === 'pending' || room.state === 'approved' || room.state === 'denied') && room.pairExpiresAt <= now;
    const refreshExpired = room.state === 'issued' && (room.refreshExpiresAt || 0) <= now;
    if (pendingExpired || refreshExpired) {
      this.closeAll(LINK_CLOSE.REVOKED, 'expired');
      await this.state.storage.deleteAll();
      return;
    }
    await this.scheduleAlarm(room);
  }

  /* 限速：固定窗口计数。 */
  private async rateLimit(body: Record<string, unknown>): Promise<Response> {
    const limit = Number(body.limit) || LINK_PAIR_START_PER_MIN;
    const windowMs = Number(body.windowMs) || 60_000;
    const now = this.now();
    const current = (await this.state.storage.get<{ start: number; count: number }>('rl')) || { start: now, count: 0 };
    const window = now - current.start >= windowMs ? { start: now, count: 0 } : current;
    window.count += 1;
    await this.state.storage.put('rl', window);
    await this.state.storage.setAlarm(window.start + windowMs * 2);
    return window.count > limit ? fail(429, LINK_ERROR.RATE_LIMITED, 'rate limited') : json({ ok: true, remaining: limit - window.count });
  }

  private async codeSet(body: Record<string, unknown>): Promise<Response> {
    const expiresAt = Number(body.expiresAt) || this.now() + LINK_PAIR_TTL_MS;
    await this.state.storage.put('code', { roomId: String(body.roomId || ''), expiresAt });
    await this.state.storage.setAlarm(expiresAt);
    return json({ ok: true });
  }
  private async codeGet(): Promise<Response> {
    const code = await this.state.storage.get<{ roomId: string; expiresAt: number }>('code');
    if (!code || code.expiresAt <= this.now()) return fail(404, LINK_ERROR.PAIR_EXPIRED, 'expired');
    return json({ ok: true, roomId: code.roomId });
  }

  private async room(): Promise<RoomRecord | undefined> {
    return this.state.storage.get<RoomRecord>('room');
  }

  private async scheduleAlarm(room: RoomRecord): Promise<void> {
    const at = room.state === 'issued' ? room.refreshExpiresAt || this.now() + LINK_REFRESH_TTL_MS : room.pairExpiresAt;
    await this.state.storage.setAlarm(at);
  }

  private async roomInit(body: Record<string, unknown>): Promise<Response> {
    if (await this.room()) return fail(409, 'ROOM_EXISTS', 'room exists');
    const now = this.now();
    const room: RoomRecord = {
      state: 'pending',
      roomId: String(body.roomId || ''),
      code: String(body.code || ''),
      clientName: String(body.clientName || 'iris-cli'),
      clientAgent: String(body.clientAgent || ''),
      source: (body.source as RoomRecord['source']) || { ip: 'unknown', country: null, city: null },
      requestedScopes: normalizeLinkScopes(body.requestedScopes),
      grantedScopes: [],
      mode: body.mode === 'device' ? 'device' : 'open',
      createdAt: now,
      pairExpiresAt: now + LINK_PAIR_TTL_MS,
      pollHash: String(body.pollHash || ''),
    };
    await this.state.storage.put('room', room);
    await this.scheduleAlarm(room);
    return json({ ok: true });
  }

  private async roomInfo(body: Record<string, unknown>): Promise<Response> {
    const room = await this.room();
    if (!room || room.code !== body.code || room.pairExpiresAt <= this.now()) return fail(404, LINK_ERROR.PAIR_EXPIRED, '配对码不存在或已过期。');
    if (room.state !== 'pending') return fail(409, 'PAIR_DECIDED', '这个配对码已经处理过了。');
    return json({
      ok: true,
      code: room.code,
      clientName: room.clientName,
      clientAgent: room.clientAgent,
      source: room.source,
      requestedScopes: room.requestedScopes,
      mode: room.mode,
      requestedAt: new Date(room.createdAt).toISOString(),
      expiresAt: new Date(room.pairExpiresAt).toISOString(),
    });
  }

  private async roomDecide(body: Record<string, unknown>): Promise<Response> {
    const room = await this.room();
    if (!room || room.code !== body.code || room.pairExpiresAt <= this.now()) return fail(404, LINK_ERROR.PAIR_EXPIRED, '配对码不存在或已过期。');
    if (room.state !== 'pending') return fail(409, 'PAIR_DECIDED', '这个配对码已经处理过了。');
    if (body.approve !== true) {
      room.state = 'denied';
      await this.state.storage.put('room', room);
      return json({ ok: true, approved: false });
    }
    // 只能授予 CLI 申请过的范围（页面上可以少给，不能多给）。
    const requested = new Set(room.requestedScopes);
    const granted = normalizeLinkScopes(body.scopes).filter(scope => requested.has(scope));
    if (!granted.includes('agent.read')) granted.unshift('agent.read');
    const tabToken = makeToken('t', room.roomId);
    room.state = 'approved';
    room.grantedScopes = granted;
    room.tabHash = await sha256Hex(tabToken);
    room.tabLabel = String(body.tabLabel || '');
    room.approvedAt = this.now();
    await this.state.storage.put('room', room);
    return json({ ok: true, approved: true, tabToken, roomId: room.roomId, clientName: room.clientName, scopes: granted });
  }

  private async roomPoll(body: Record<string, unknown>): Promise<Response> {
    const room = await this.room();
    const token = String(body.pollToken || '');
    const parsed = parseLinkToken(token);
    if (!room || !parsed || !timingSafeEqual(await sha256Hex(token), room.pollHash)) return fail(401, LINK_ERROR.UNAUTHORIZED, '轮询令牌无效或配对已过期。');
    if (room.state === 'pending') {
      if (room.pairExpiresAt <= this.now()) return fail(410, LINK_ERROR.PAIR_EXPIRED, '配对码已过期，请重新运行 iris login web。');
      return json({ ok: false, error: { code: LINK_ERROR.PAIR_PENDING, message: '等待在 Iris 页面上确认。' } }, 202);
    }
    if (room.state === 'denied') {
      await this.state.storage.deleteAll();
      return fail(403, LINK_ERROR.PAIR_DENIED, '用户在 Iris 页面上拒绝了这次连接。');
    }
    if (room.state === 'issued') return fail(409, 'ALREADY_ISSUED', '令牌已经签发过；重新运行 iris login web。');
    // approved → 第一次轮询时签发（明文只出现在这一次响应里，房间只存哈希）。
    const issued = await this.issueTokens(room);
    return json({ ok: true, ...issued });
  }

  private async issueTokens(room: RoomRecord) {
    const roomId = room.roomId;
    const accessToken = makeToken('a', roomId);
    const refreshToken = makeToken('r', roomId);
    const now = this.now();
    room.state = 'issued';
    room.accessHash = await sha256Hex(accessToken);
    room.accessExpiresAt = now + LINK_ACCESS_TTL_MS;
    room.refreshHash = await sha256Hex(refreshToken);
    room.refreshExpiresAt = now + LINK_REFRESH_TTL_MS;
    room.pollHash = '';
    await this.state.storage.put('room', room);
    await this.scheduleAlarm(room);
    return {
      roomId,
      accessToken,
      refreshToken,
      accessExpiresAt: new Date(room.accessExpiresAt).toISOString(),
      refreshExpiresAt: new Date(room.refreshExpiresAt).toISOString(),
      scopes: room.grantedScopes,
      clientName: room.clientName,
    };
  }

  private async roomRefresh(body: Record<string, unknown>): Promise<Response> {
    const room = await this.room();
    const token = String(body.refreshToken || '');
    const parsed = parseLinkToken(token);
    if (!room || !parsed || room.state !== 'issued' || !room.refreshHash || !timingSafeEqual(await sha256Hex(token), room.refreshHash)) {
      return fail(401, LINK_ERROR.REVOKED, '连接已撤销或 refresh 令牌无效，请重新运行 iris login web。');
    }
    if ((room.refreshExpiresAt || 0) <= this.now()) return fail(401, LINK_ERROR.TOKEN_EXPIRED, 'refresh 令牌已过期，请重新运行 iris login web。');
    // refresh 轮换：旧 refresh 立即失效。
    return json({ ok: true, ...(await this.issueTokens(room)) });
  }

  /** 校验任意一种本房间令牌，返回它的种类。 */
  private async verify(room: RoomRecord | undefined, token: string): Promise<'a' | 'r' | 't' | null> {
    const parsed = parseLinkToken(token);
    if (!room || !parsed) return null;
    const hash = await sha256Hex(token);
    if (parsed.kind === 'a' && room.accessHash && timingSafeEqual(hash, room.accessHash)) return 'a';
    if (parsed.kind === 'r' && room.refreshHash && timingSafeEqual(hash, room.refreshHash)) return 'r';
    if (parsed.kind === 't' && room.tabHash && timingSafeEqual(hash, room.tabHash)) return 't';
    return null;
  }

  private async roomRevoke(body: Record<string, unknown>): Promise<Response> {
    const room = await this.room();
    const kind = await this.verify(room, String(body.token || ''));
    if (!kind) return fail(401, LINK_ERROR.UNAUTHORIZED, '令牌无效或连接已撤销。');
    this.broadcast('cli', { t: LINK_FRAME.SYSTEM, code: LINK_ERROR.REVOKED, message: '连接已被撤销。' });
    this.broadcast('tab', { t: LINK_FRAME.SYSTEM, code: LINK_ERROR.REVOKED, message: '连接已被撤销。' });
    this.closeAll(LINK_CLOSE.REVOKED, 'revoked');
    await this.state.storage.deleteAll();
    await this.state.storage.deleteAlarm();
    return json({ ok: true, revoked: true, by: kind === 't' ? 'tab' : 'cli' });
  }

  private async roomStatus(body: Record<string, unknown>): Promise<Response> {
    const room = await this.room();
    const kind = await this.verify(room, String(body.token || ''));
    if (!kind || !room) return fail(401, LINK_ERROR.UNAUTHORIZED, '令牌无效或连接已撤销。');
    if (kind === 'a' && (room.accessExpiresAt || 0) <= this.now()) return fail(401, LINK_ERROR.TOKEN_EXPIRED, '访问令牌已过期。');
    const tab = this.state.getWebSockets('tab').map(ws => this.meta(ws)).find(Boolean);
    return json({
      ok: true,
      protocolVersion: LINK_PROTOCOL_VERSION,
      clientName: room.clientName,
      scopes: room.grantedScopes,
      tabOnline: Boolean(tab),
      tab: tab?.tab || null,
      cliConnections: this.state.getWebSockets('cli').length,
      approvedAt: room.approvedAt ? new Date(room.approvedAt).toISOString() : null,
      refreshExpiresAt: room.refreshExpiresAt ? new Date(room.refreshExpiresAt).toISOString() : null,
    });
  }

  /* ── WebSocket ── */

  private meta(ws: LinkSocket): SocketMeta | null {
    try { return (ws.deserializeAttachment() as SocketMeta) || null; } catch { return null; }
  }

  private async acceptSocket(request: Request, role: 'cli' | 'tab'): Promise<Response> {
    const room = await this.room();
    const token = websocketToken(request);
    const kind = await this.verify(room, token);
    if (!room || (role === 'cli' && kind !== 'a') || (role === 'tab' && kind !== 't')) return fail(401, LINK_ERROR.UNAUTHORIZED, '令牌无效或连接已撤销。');
    if (role === 'cli' && (room.accessExpiresAt || 0) <= this.now()) return fail(401, LINK_ERROR.TOKEN_EXPIRED, '访问令牌已过期。');
    if (role === 'cli' && this.state.getWebSockets('cli').length >= LINK_MAX_CLI_SOCKETS) return fail(429, LINK_ERROR.RATE_LIMITED, '同一个连接的 CLI 会话太多。');
    const Pair = (globalThis as unknown as { WebSocketPair: WebSocketPairCtor }).WebSocketPair;
    const pair = new Pair();
    const client = pair[0];
    const server = pair[1];
    const sid = randomSecret(9);
    if (role === 'tab') {
      // 同一个配对只有一个执行标签页：新的替换旧的。
      for (const old of this.state.getWebSockets('tab')) {
        try { old.send(JSON.stringify({ t: LINK_FRAME.SYSTEM, code: 'REPLACED', message: '另一个标签页接管了这个连接。' })); old.close(LINK_CLOSE.REPLACED, 'replaced'); } catch { /* gone */ }
      }
    }
    this.state.acceptWebSocket(server, [role]);
    const meta: SocketMeta = role === 'cli'
      ? { role, sid, connectedAt: this.now(), expiresAt: room.accessExpiresAt, tokens: LINK_RATE_BURST, refillAt: this.now() }
      : { role, sid, connectedAt: this.now(), tab: {} };
    server.serializeAttachment(meta);
    if (role === 'tab') {
      server.send(JSON.stringify({ t: LINK_FRAME.SYSTEM, code: 'LINKED', clientName: room.clientName, scopes: room.grantedScopes }));
      this.broadcast('cli', { t: LINK_FRAME.SYSTEM, code: 'TAB_ONLINE' });
    } else {
      const online = this.state.getWebSockets('tab').length > 0;
      server.send(JSON.stringify({ t: LINK_FRAME.SYSTEM, code: online ? 'TAB_ONLINE' : LINK_ERROR.TAB_OFFLINE, scopes: room.grantedScopes }));
    }
    return new Response(null, { status: 101, webSocket: client, headers: { 'sec-websocket-protocol': LINK_WS_SUBPROTOCOL } } as ResponseInit & { webSocket: LinkSocket });
  }

  async webSocketMessage(ws: LinkSocket, message: string | ArrayBuffer): Promise<void> {
    const meta = this.meta(ws);
    if (!meta) { ws.close(1011, 'no meta'); return; }
    if (typeof message !== 'string') { this.reply(ws, null, LINK_ERROR.BAD_FRAME, '只接受文本帧。'); return; }
    if (message === 'ping') { ws.send('pong'); return; }
    const size = utf8Length(message);
    let frame: Record<string, unknown>;
    try { frame = JSON.parse(message); } catch { this.reply(ws, null, LINK_ERROR.BAD_FRAME, '帧不是合法 JSON。'); return; }
    if (!frame || typeof frame !== 'object') { this.reply(ws, null, LINK_ERROR.BAD_FRAME, '帧格式不对。'); return; }
    if (meta.role === 'cli') await this.fromCli(ws, meta, frame, size);
    else await this.fromTab(ws, meta, frame, size);
  }

  async webSocketClose(ws: LinkSocket): Promise<void> {
    const meta = this.meta(ws);
    try { ws.close(1000, 'closed'); } catch { /* already closed */ }
    if (meta?.role === 'tab') {
      const others = this.state.getWebSockets('tab').filter(item => item !== ws);
      if (!others.length) this.broadcast('cli', { t: LINK_FRAME.SYSTEM, code: LINK_ERROR.TAB_OFFLINE, message: 'Iris 标签页已关闭或断开。' });
    }
  }

  async webSocketError(ws: LinkSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  private reply(ws: LinkSocket, id: unknown, code: string, message: string) {
    try { ws.send(JSON.stringify({ t: LINK_FRAME.RESPONSE, id: typeof id === 'string' ? id : null, ok: false, error: { code, message } })); } catch { /* gone */ }
  }

  private async fromCli(ws: LinkSocket, meta: SocketMeta, frame: Record<string, unknown>, size: number): Promise<void> {
    const id = typeof frame.id === 'string' && frame.id.length <= 64 ? frame.id : null;
    if (frame.t !== LINK_FRAME.REQUEST || !id || typeof frame.cmd !== 'string') { this.reply(ws, id, LINK_ERROR.BAD_FRAME, '只接受 req 帧（id ≤ 64、cmd 必填）。'); return; }
    if (size > LINK_MAX_FRAME_BYTES) { this.reply(ws, id, LINK_ERROR.FRAME_TOO_LARGE, `请求超过 ${LINK_MAX_FRAME_BYTES} 字节。`); return; }
    const now = this.now();
    if ((meta.expiresAt || 0) <= now) {
      this.reply(ws, id, LINK_ERROR.TOKEN_EXPIRED, '访问令牌已过期，请刷新后重连。');
      ws.close(LINK_CLOSE.TOKEN_EXPIRED, 'token expired');
      return;
    }
    // 令牌桶限速（状态跟着连接走，休眠后也在）。
    const elapsed = Math.max(0, now - (meta.refillAt || now)) / 1000;
    meta.tokens = Math.min(LINK_RATE_BURST, (meta.tokens ?? LINK_RATE_BURST) + elapsed * LINK_RATE_PER_SEC);
    meta.refillAt = now;
    if (meta.tokens < 1) { ws.serializeAttachment(meta); this.reply(ws, id, LINK_ERROR.RATE_LIMITED, '请求太频繁，请稍后再试。'); return; }
    meta.tokens -= 1;
    ws.serializeAttachment(meta);
    const room = await this.room();
    if (!room || room.state !== 'issued') { this.reply(ws, id, LINK_ERROR.REVOKED, '连接已撤销。'); ws.close(LINK_CLOSE.REVOKED, 'revoked'); return; }
    const args = frame.args && typeof frame.args === 'object' && !Array.isArray(frame.args) ? frame.args as Record<string, unknown> : {};
    const missing = missingLinkScope(frame.cmd, room.grantedScopes, args);
    if (missing === 'unknown') { this.reply(ws, id, LINK_ERROR.UNKNOWN_COMMAND, `不是 Iris Link 命令：${frame.cmd}`); return; }
    if (missing) { this.reply(ws, id, LINK_ERROR.SCOPE_DENIED, `配对时没有授予 ${missing}；需要的话重新运行 iris login web 申请。`); return; }
    const tab = this.state.getWebSockets('tab')[0];
    if (!tab) { this.reply(ws, id, LINK_ERROR.TAB_OFFLINE, 'Iris 标签页没有打开（或已断开）。打开 Iris 后重试。'); return; }
    tab.send(JSON.stringify({
      t: LINK_FRAME.REQUEST,
      id: meta.sid + ':' + id,
      cmd: frame.cmd,
      args,
      ...(typeof frame.idem === 'string' && frame.idem ? { idem: frame.idem.slice(0, 128) } : {}),
      grant: { scopes: room.grantedScopes, clientName: room.clientName },
    }));
  }

  private async fromTab(ws: LinkSocket, meta: SocketMeta, frame: Record<string, unknown>, size: number): Promise<void> {
    if (frame.t === LINK_FRAME.HELLO) {
      const tab = frame.tab && typeof frame.tab === 'object' ? frame.tab as Record<string, unknown> : {};
      meta.tab = { title: String(tab.title || '').slice(0, 120), projectId: typeof tab.projectId === 'string' ? tab.projectId.slice(0, 80) : null };
      ws.serializeAttachment(meta);
      return;
    }
    if (frame.t === LINK_FRAME.EVENT) {
      if (size > LINK_MAX_FRAME_BYTES) return;
      this.broadcast('cli', { t: LINK_FRAME.EVENT, event: String(frame.event || ''), data: frame.data ?? null });
      return;
    }
    if (frame.t !== LINK_FRAME.RESPONSE || typeof frame.id !== 'string') return;
    const sep = frame.id.indexOf(':');
    if (sep <= 0) return;
    const sid = frame.id.slice(0, sep);
    const id = frame.id.slice(sep + 1);
    const target = this.state.getWebSockets('cli').find(item => this.meta(item)?.sid === sid);
    if (!target) return;
    if (size > LINK_MAX_FRAME_BYTES) { this.reply(target, id, LINK_ERROR.FRAME_TOO_LARGE, `标签页的结果超过 ${LINK_MAX_FRAME_BYTES} 字节；缩小查询范围（例如 summary=true）。`); return; }
    try { target.send(JSON.stringify({ ...frame, id })); } catch { /* CLI gone */ }
  }

  private broadcast(tag: 'cli' | 'tab', frame: unknown) {
    const text = JSON.stringify(frame);
    for (const ws of this.state.getWebSockets(tag)) { try { ws.send(text); } catch { /* gone */ } }
  }

  private closeAll(code: number, reason: string) {
    for (const ws of this.state.getWebSockets()) { try { ws.close(code, reason); } catch { /* gone */ } }
  }
}
