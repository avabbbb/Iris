// CLI 侧的 Iris Link 客户端：配对（浏览器确认 / 设备码）、令牌刷新与撤销、WebSocket 请求-响应。
// 任何机器（包括没有模型 Key 的沙箱）都能用它驱动用户浏览器里已打开的 Iris：命令在标签页里执行，Key 不离开浏览器。
import { randomUUID } from 'node:crypto';
import { hostname, platform } from 'node:os';
import {
  DEFAULT_LINK_WEB_URL,
  LINK_CLOSE,
  LINK_DEFAULT_SCOPES,
  LINK_ERROR,
  LINK_FRAME,
  LINK_PAIR_POLL_INTERVAL_MS,
  LINK_WS_BEARER_PREFIX,
  LINK_WS_SUBPROTOCOL,
  normalizeLinkScopes,
} from './protocol.js';
import { readLink, writeLink } from './link-store.js';

export class LinkClientError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'LinkClientError';
    this.code = code;
    this.retryable = Boolean(options.retryable);
    this.details = options.details ?? null;
  }

  toJSON() {
    return { code: this.code, message: this.message, retryable: this.retryable, details: this.details };
  }
}

export function normalizeLinkBaseUrl(value) {
  let url;
  try {
    url = new URL(String(value || DEFAULT_LINK_WEB_URL));
  } catch {
    throw new LinkClientError(LINK_ERROR.INVALID_ARGUMENT, `--url 不是合法地址：${value}`);
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  // 线上必须 HTTPS；只有本机开发（wrangler dev / vite）允许 http。
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new LinkClientError(LINK_ERROR.INVALID_ARGUMENT, 'Iris Link 只能连 https 地址（本机开发可用 http://127.0.0.1）。');
  }
  return url.origin;
}

export function defaultClientName() {
  let host = 'unknown-host';
  try { host = hostname(); } catch { /* sandbox */ }
  return `iris-cli@${host}`.slice(0, 80);
}

function clientAgent() {
  return `iris-cli node/${process.versions.node} ${platform()}`;
}

async function postJson(fetchImpl, url, body, headers = {}) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': clientAgent(), ...headers },
      body: JSON.stringify(body || {}),
    });
  } catch (cause) {
    throw new LinkClientError('LINK_UNREACHABLE', `连不上 Iris Link 中继：${cause instanceof Error ? cause.message : String(cause)}`, { retryable: true });
  }
  const json = await response.json().catch(() => ({}));
  return { status: response.status, body: json };
}

function errorFrom(body, fallbackCode, fallbackMessage) {
  const error = body?.error || {};
  return new LinkClientError(error.code || fallbackCode, error.message || fallbackMessage, { retryable: Boolean(error.retryable) });
}

/** 发起配对：中继返回配对码、配对页地址和只给本 CLI 的轮询令牌。 */
export async function startPairing(options = {}) {
  const baseUrl = normalizeLinkBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const scopes = normalizeLinkScopes(options.scopes);
  const { status, body } = await postJson(fetchImpl, baseUrl + '/api/link/pair/start', {
    clientName: options.clientName || defaultClientName(),
    clientAgent: clientAgent(),
    scopes: scopes.length ? scopes : [...LINK_DEFAULT_SCOPES],
    mode: options.mode === 'device' ? 'device' : 'open',
  });
  if (status !== 200 || !body?.ok) throw errorFrom(body, 'PAIR_START_FAILED', `配对发起失败（HTTP ${status}）。`);
  return { ...body, baseUrl };
}

/** 轮询直到用户在页面上确认 / 拒绝 / 过期。onPending 每轮回调一次（打进度）。 */
export async function pollPairing(pairing, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const intervalMs = options.intervalMs ?? Math.max(1, Number(pairing.interval) || LINK_PAIR_POLL_INTERVAL_MS / 1000) * 1000;
  const deadline = Date.now() + (options.timeoutMs ?? (Number(pairing.expiresIn) || 600) * 1000);
  const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  while (Date.now() <= deadline) {
    const { status, body } = await postJson(fetchImpl, pairing.baseUrl + '/api/link/pair/poll', { pollToken: pairing.pollToken });
    if (status === 200 && body?.ok) return body;
    if (status === 202) {
      options.onPending?.();
      await sleep(intervalMs);
      continue;
    }
    throw errorFrom(body, LINK_ERROR.PAIR_EXPIRED, `配对失败（HTTP ${status}）。`);
  }
  throw new LinkClientError(LINK_ERROR.PAIR_EXPIRED, '配对码已过期：10 分钟内没有在 Iris 页面上确认。重新运行 iris login web。');
}

export function linkRecordFromTokens(baseUrl, tokens, extra = {}) {
  return {
    baseUrl,
    roomId: tokens.roomId,
    clientName: tokens.clientName,
    scopes: tokens.scopes || [],
    accessToken: tokens.accessToken,
    accessExpiresAt: tokens.accessExpiresAt,
    refreshToken: tokens.refreshToken,
    refreshExpiresAt: tokens.refreshExpiresAt,
    linkedAt: extra.linkedAt || new Date().toISOString(),
  };
}

/**
 * 一次 CLI 调用里的 web link 连接。令牌快过期时先 refresh（refresh 轮换后立即落盘），
 * 然后开一条 WebSocket；请求按 id 对应响应，标签页离线时立即失败（TAB_OFFLINE）。
 */
export class WebLinkClient {
  constructor(options = {}) {
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.WebSocketImpl = options.WebSocketImpl || globalThis.WebSocket;
    this.storeOptions = options.storeOptions || {};
    this.record = options.record || readLink(this.storeOptions);
    if (!this.record) throw new LinkClientError(LINK_ERROR.NOT_LINKED, '还没有连接线上 Iris。先运行 iris login web --open（沙箱里用 --device）。');
    if (options.baseUrl && normalizeLinkBaseUrl(options.baseUrl) !== this.record.baseUrl) {
      throw new LinkClientError(LINK_ERROR.NOT_LINKED, `~/.iris/link.json 连接的是 ${this.record.baseUrl}，不是 ${options.baseUrl}；重新 iris login web --url ${options.baseUrl}。`);
    }
    this.socket = null;
    this.pending = new Map();
    this.tabOnline = null;
    this.systemListeners = new Set();
    this.eventListeners = new Set();
    this.closedByUs = false;
  }

  get baseUrl() { return this.record.baseUrl; }
  get scopes() { return this.record.scopes || []; }

  persist() {
    writeLink(this.record, this.storeOptions);
  }

  async refresh() {
    const { status, body } = await postJson(this.fetchImpl, this.baseUrl + '/api/link/token/refresh', { refreshToken: this.record.refreshToken });
    if (status !== 200 || !body?.ok) throw errorFrom(body, LINK_ERROR.REVOKED, '连接已撤销或过期，请重新运行 iris login web。');
    this.record = { ...this.record, ...linkRecordFromTokens(this.baseUrl, body, { linkedAt: this.record.linkedAt }) };
    this.persist();
    return this.record;
  }

  async ensureAccess(skewMs = 60_000) {
    const expires = Date.parse(this.record.accessExpiresAt || '') || 0;
    if (!this.record.accessToken || expires - skewMs <= Date.now()) await this.refresh();
    return this.record.accessToken;
  }

  async status() {
    await this.ensureAccess();
    const response = await this.fetchImpl(this.baseUrl + '/api/link/status', { headers: { authorization: 'Bearer ' + this.record.accessToken, 'user-agent': clientAgent() } })
      .catch(cause => { throw new LinkClientError('LINK_UNREACHABLE', `连不上 Iris Link 中继：${cause instanceof Error ? cause.message : String(cause)}`, { retryable: true }); });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body?.ok) throw errorFrom(body, LINK_ERROR.UNAUTHORIZED, `状态查询失败（HTTP ${response.status}）。`);
    return body;
  }

  /** 服务端撤销（refresh 令牌即使访问令牌过期也能撤销）。 */
  async revoke() {
    const { status, body } = await postJson(this.fetchImpl, this.baseUrl + '/api/link/revoke', {}, { authorization: 'Bearer ' + this.record.refreshToken });
    if (status !== 200 || !body?.ok) throw errorFrom(body, LINK_ERROR.UNAUTHORIZED, `撤销失败（HTTP ${status}）。`);
    return body;
  }

  onSystem(listener) { this.systemListeners.add(listener); return () => this.systemListeners.delete(listener); }
  onEvent(listener) { this.eventListeners.add(listener); return () => this.eventListeners.delete(listener); }

  async connect(options = {}) {
    if (this.socket) return this;
    if (typeof this.WebSocketImpl !== 'function') throw new LinkClientError('LINK_UNSUPPORTED', '当前 Node 没有 WebSocket（需要 Node 22+）。');
    await this.ensureAccess();
    const wsUrl = this.baseUrl.replace(/^http/, 'ws') + '/api/link/ws?role=cli';
    const socket = new this.WebSocketImpl(wsUrl, [LINK_WS_SUBPROTOCOL, LINK_WS_BEARER_PREFIX + this.record.accessToken]);
    this.socket = socket;
    const timeoutMs = options.timeoutMs ?? 15_000;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new LinkClientError('LINK_UNREACHABLE', 'Iris Link 中继连接超时。', { retryable: true })); try { socket.close(); } catch { /* ignore */ } }, timeoutMs);
      let settled = false;
      const settle = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); fn(value); };
      socket.addEventListener('message', event => {
        const frame = this.parse(event.data);
        if (!frame) return;
        if (frame.t === LINK_FRAME.SYSTEM && (frame.code === 'TAB_ONLINE' || frame.code === LINK_ERROR.TAB_OFFLINE)) settle(resolve);
        this.handleFrame(frame);
      });
      socket.addEventListener('error', () => settle(reject, new LinkClientError('LINK_UNREACHABLE', 'Iris Link 中继拒绝了连接（令牌可能已撤销）。', { retryable: true })));
      socket.addEventListener('close', event => {
        settle(reject, this.closeError(event.code));
        this.handleClose(event.code);
      });
    });
    return this;
  }

  parse(data) {
    try { return JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf8')); } catch { return null; }
  }

  closeError(code) {
    if (code === LINK_CLOSE.REVOKED) return new LinkClientError(LINK_ERROR.REVOKED, '连接已被撤销（可能在 Iris 页面上断开了）。重新运行 iris login web。');
    if (code === LINK_CLOSE.TOKEN_EXPIRED) return new LinkClientError(LINK_ERROR.TOKEN_EXPIRED, '访问令牌过期。', { retryable: true });
    return new LinkClientError('LINK_CLOSED', `Iris Link 连接断开（${code}）。`, { retryable: true });
  }

  handleFrame(frame) {
    if (frame.t === LINK_FRAME.SYSTEM) {
      if (frame.code === 'TAB_ONLINE') this.tabOnline = true;
      if (frame.code === LINK_ERROR.TAB_OFFLINE) {
        this.tabOnline = false;
        // 标签页关掉：在途请求立即失败，不干等超时。
        for (const [id, entry] of this.pending) {
          this.pending.delete(id);
          entry.reject(new LinkClientError(LINK_ERROR.TAB_OFFLINE, 'Iris 标签页已关闭或断开；重新打开 Iris 后重试（写操作沿用同一个 --idempotency-key）。', { retryable: true }));
        }
      }
      for (const listener of this.systemListeners) listener(frame);
      return;
    }
    if (frame.t === LINK_FRAME.EVENT) {
      for (const listener of this.eventListeners) listener(frame);
      return;
    }
    if (frame.t === LINK_FRAME.RESPONSE && typeof frame.id === 'string') {
      const entry = this.pending.get(frame.id);
      if (!entry) return;
      this.pending.delete(frame.id);
      if (frame.ok) entry.resolve(frame.data ?? null);
      else entry.reject(new LinkClientError(frame.error?.code || 'LINK_COMMAND_FAILED', frame.error?.message || '标签页执行失败。', { retryable: Boolean(frame.error?.retryable), details: frame.error?.details ?? null }));
    }
  }

  handleClose(code) {
    this.socket = null;
    const error = this.closedByUs ? new LinkClientError('LINK_CLOSED', '连接已关闭。') : this.closeError(code);
    for (const [id, entry] of this.pending) { this.pending.delete(id); entry.reject(error); }
  }

  async request(cmd, args = {}, options = {}) {
    if (!this.socket) await this.connect();
    if (this.tabOnline === false && !options.allowOffline) {
      throw new LinkClientError(LINK_ERROR.TAB_OFFLINE, 'Iris 标签页没有打开（或已断开）。在浏览器里打开 Iris 后重试。', { retryable: true });
    }
    const id = randomUUID().replace(/-/g, '').slice(0, 24);
    const timeoutMs = options.timeoutMs ?? 60_000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new LinkClientError(LINK_ERROR.TAB_TIMEOUT, `标签页 ${Math.round(timeoutMs / 1000)}s 内没有回应；它可能仍在执行。重试写操作请沿用同一个 --idempotency-key。`, { retryable: true }));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      try {
        this.socket.send(JSON.stringify({ t: LINK_FRAME.REQUEST, id, cmd, args, ...(options.idempotencyKey ? { idem: String(options.idempotencyKey) } : {}) }));
      } catch (cause) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new LinkClientError('LINK_CLOSED', `发送失败：${cause instanceof Error ? cause.message : String(cause)}`, { retryable: true }));
      }
    });
  }

  close() {
    this.closedByUs = true;
    try { this.socket?.close(1000, 'done'); } catch { /* ignore */ }
    this.socket = null;
  }
}

/** 新配对完成后写入 link.json。 */
export function saveLinkTokens(baseUrl, tokens, storeOptions = {}) {
  const record = linkRecordFromTokens(baseUrl, tokens);
  const file = writeLink(record, storeOptions);
  return { record, file };
}
