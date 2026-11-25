// 线上 Iris 标签页一侧的 Iris Link：保存用户批准过的 CLI 配对，向中继（/api/link/ws?role=tab）建立 WebSocket，
// 把收到的 link 命令交给 handleAgentLinkCommand（同一个处理器也服务本机 loopback），结果回帧。
// 同一个浏览器里多个 Iris 标签页时，用 Web Locks 选出一个执行标签页；它关掉后锁自动转给下一个标签页。
// 标签页只保存中继签发的「标签页令牌」，从不把模型 Key 或画布内容交给中继（命令结果只回给发起的 CLI）。
import { useSyncExternalStore } from 'react';
import {
  LINK_CLOSE,
  LINK_ERROR,
  LINK_FRAME,
  LINK_MAX_FRAME_BYTES,
  LINK_WS_BEARER_PREFIX,
  LINK_WS_SUBPROTOCOL,
  normalizeLinkScopes,
  utf8Length,
} from '../../tools/iris/link/protocol.js';
import { useWorkflowStore } from '../../components/workflow/store';
import { handleAgentLinkCommand } from './agentLinkCommands';

export const LINK_PAIRINGS_KEY = 'iris.link.pairings.v1';

export interface StoredLinkPairing {
  roomId: string;
  tabToken: string;
  clientName: string;
  scopes: string[];
  /** 中继所在的 origin（批准时页面的 origin）。 */
  baseUrl: string;
  linkedAt: string;
}

export type LinkConnectionStatus = 'idle' | 'connecting' | 'online' | 'standby' | 'offline' | 'revoked';

export interface LinkHostState {
  pairings: Array<Omit<StoredLinkPairing, 'tabToken'> & { status: LinkConnectionStatus; lastCommandAt?: string }>;
}

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>;
type SocketLike = Pick<WebSocket, 'send' | 'close' | 'addEventListener' | 'readyState'>;

export interface WebLinkHostOptions {
  storage?: Storage | null;
  WebSocketImpl?: new (url: string, protocols?: string[]) => SocketLike;
  locks?: { request(name: string, options: { mode: 'exclusive' }, callback: () => Promise<void>): Promise<unknown> } | null;
  fetchImpl?: typeof fetch;
  handle?: typeof handleAgentLinkCommand;
  /** 重连退避上限（毫秒）。 */
  maxBackoffMs?: number;
}

function defaultStorage(): Storage | null {
  try { return typeof window !== 'undefined' ? window.localStorage : null; } catch { return null; }
}

export function readLinkPairings(storage: Storage | null = defaultStorage()): StoredLinkPairing[] {
  if (!storage) return [];
  try {
    const parsed = JSON.parse(storage.getItem(LINK_PAIRINGS_KEY) || '[]');
    return Array.isArray(parsed)
      ? parsed.filter((item): item is StoredLinkPairing => Boolean(item && typeof item.roomId === 'string' && typeof item.tabToken === 'string' && typeof item.baseUrl === 'string'))
        .map(item => ({ ...item, scopes: normalizeLinkScopes(item.scopes) }))
      : [];
  } catch {
    return [];
  }
}

function writeLinkPairings(pairings: StoredLinkPairing[], storage: Storage | null = defaultStorage()) {
  if (!storage) return;
  try {
    if (pairings.length) storage.setItem(LINK_PAIRINGS_KEY, JSON.stringify(pairings));
    else storage.removeItem(LINK_PAIRINGS_KEY);
  } catch { /* storage full / blocked */ }
}

export function saveLinkPairing(pairing: StoredLinkPairing, storage: Storage | null = defaultStorage()) {
  const rest = readLinkPairings(storage).filter(item => item.roomId !== pairing.roomId);
  writeLinkPairings([...rest, pairing], storage);
}

export function removeLinkPairing(roomId: string, storage: Storage | null = defaultStorage()) {
  writeLinkPairings(readLinkPairings(storage).filter(item => item.roomId !== roomId), storage);
}

/* ── 配对页用的 HTTP 接口 ── */

async function linkJson(fetchImpl: typeof fetch, url: string, init?: RequestInit) {
  const response = await fetchImpl(url, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers || {}) }, credentials: 'omit' });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.ok === false) {
    const error = body?.error || {};
    throw Object.assign(new Error(error.message || `HTTP ${response.status}`), { code: error.code || 'LINK_HTTP_' + response.status });
  }
  return body;
}

export interface LinkPairingInfo {
  code: string;
  clientName: string;
  clientAgent: string;
  source: { ip: string; country: string | null; city: string | null };
  requestedScopes: string[];
  mode: 'open' | 'device';
  requestedAt: string;
  expiresAt: string;
}

export function fetchLinkPairingInfo(code: string, options: { baseUrl?: string; fetchImpl?: typeof fetch } = {}): Promise<LinkPairingInfo> {
  const base = options.baseUrl || window.location.origin;
  return linkJson(options.fetchImpl || fetch, base + '/api/link/pair/info?code=' + encodeURIComponent(code));
}

/** 批准 / 拒绝配对；批准时保存标签页令牌，并让执行宿主立即连上。 */
export async function decideLinkPairing(code: string, approve: boolean, scopes: string[], options: { baseUrl?: string; fetchImpl?: typeof fetch; storage?: Storage | null } = {}) {
  const base = options.baseUrl || window.location.origin;
  const body = await linkJson(options.fetchImpl || fetch, base + '/api/link/pair/decide', {
    method: 'POST',
    body: JSON.stringify({ code, approve, scopes, tabLabel: typeof document !== 'undefined' ? document.title.slice(0, 80) : '' }),
  });
  if (!approve || !body.approved) return { approved: false as const };
  const pairing: StoredLinkPairing = { roomId: body.roomId, tabToken: body.tabToken, clientName: body.clientName, scopes: normalizeLinkScopes(body.scopes), baseUrl: base, linkedAt: new Date().toISOString() };
  saveLinkPairing(pairing, options.storage === undefined ? defaultStorage() : options.storage);
  activeHost?.sync();
  return { approved: true as const, pairing: { ...pairing, tabToken: undefined } };
}

/** 页面上断开某个 CLI：服务端撤销 + 删本地记录。 */
export async function revokeLinkPairing(roomId: string, options: { fetchImpl?: typeof fetch; storage?: Storage | null } = {}) {
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  const pairing = readLinkPairings(storage).find(item => item.roomId === roomId);
  if (!pairing) return { revoked: false };
  let serverRevoked = false;
  try {
    await linkJson(options.fetchImpl || fetch, pairing.baseUrl + '/api/link/revoke', { method: 'POST', headers: { authorization: 'Bearer ' + pairing.tabToken }, body: '{}' });
    serverRevoked = true;
  } catch (error) {
    // 已经被 CLI 撤销 / 过期：本地照删。
    serverRevoked = ['UNAUTHORIZED', 'REVOKED'].includes(String((error as { code?: string }).code));
  }
  removeLinkPairing(roomId, storage);
  activeHost?.sync();
  return { revoked: true, serverRevoked };
}

/* ── 执行宿主 ── */

interface Connection {
  pairing: StoredLinkPairing;
  socket: SocketLike | null;
  status: LinkConnectionStatus;
  stopped: boolean;
  attempt: number;
  timer?: ReturnType<typeof setTimeout>;
  releaseLock?: () => void;
  lastCommandAt?: string;
}

export class WebLinkHost {
  private readonly connections = new Map<string, Connection>();
  private readonly listeners = new Set<() => void>();
  private snapshot: LinkHostState = { pairings: [] };
  private readonly storage: Storage | null;
  private readonly handle: typeof handleAgentLinkCommand;
  private onStorage = (event: StorageEvent) => { if (event.key === LINK_PAIRINGS_KEY) this.sync(); };

  constructor(private readonly options: WebLinkHostOptions = {}) {
    this.storage = options.storage === undefined ? defaultStorage() : options.storage;
    this.handle = options.handle || handleAgentLinkCommand;
  }

  start() {
    if (typeof window !== 'undefined') window.addEventListener('storage', this.onStorage);
    this.sync();
  }

  stop() {
    if (typeof window !== 'undefined') window.removeEventListener('storage', this.onStorage);
    for (const connection of this.connections.values()) this.stopConnection(connection);
    this.connections.clear();
    this.emit();
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): LinkHostState {
    return this.snapshot;
  }

  private emit() {
    this.snapshot = {
      pairings: readLinkPairings(this.storage).map(({ tabToken: _token, ...pairing }) => {
        const connection = this.connections.get(pairing.roomId);
        return { ...pairing, status: connection?.status ?? 'idle', ...(connection?.lastCommandAt ? { lastCommandAt: connection.lastCommandAt } : {}) };
      }),
    };
    for (const listener of this.listeners) listener();
  }

  /** 按存储里的配对增删连接（其它标签页批准 / 撤销后通过 storage 事件同步）。 */
  sync() {
    const pairings = readLinkPairings(this.storage);
    const ids = new Set(pairings.map(item => item.roomId));
    for (const [roomId, connection] of this.connections) {
      if (!ids.has(roomId)) { this.stopConnection(connection); this.connections.delete(roomId); }
    }
    for (const pairing of pairings) {
      if (this.connections.has(pairing.roomId)) continue;
      const connection: Connection = { pairing, socket: null, status: 'idle', stopped: false, attempt: 0 };
      this.connections.set(pairing.roomId, connection);
      this.acquire(connection);
    }
    this.emit();
  }

  private acquire(connection: Connection) {
    const locks = this.options.locks === undefined
      ? (typeof navigator !== 'undefined' && (navigator as Navigator & { locks?: WebLinkHostOptions['locks'] }).locks) || null
      : this.options.locks;
    if (!locks) { this.open(connection); return; }
    connection.status = 'standby';
    void locks.request('iris-link:' + connection.pairing.roomId, { mode: 'exclusive' }, () => new Promise<void>(release => {
      if (connection.stopped) { release(); return; }
      connection.releaseLock = release;
      this.open(connection);
    })).catch(() => undefined);
  }

  private stopConnection(connection: Connection) {
    connection.stopped = true;
    if (connection.timer) clearTimeout(connection.timer);
    try { connection.socket?.close(1000, 'stopped'); } catch { /* ignore */ }
    connection.socket = null;
    connection.releaseLock?.();
    connection.releaseLock = undefined;
  }

  private open(connection: Connection) {
    if (connection.stopped) return;
    const Impl = this.options.WebSocketImpl || (typeof WebSocket !== 'undefined' ? WebSocket : null);
    if (!Impl) { connection.status = 'offline'; this.emit(); return; }
    connection.status = 'connecting';
    this.emit();
    const url = connection.pairing.baseUrl.replace(/^http/, 'ws') + '/api/link/ws?role=tab';
    let socket: SocketLike;
    try {
      socket = new Impl(url, [LINK_WS_SUBPROTOCOL, LINK_WS_BEARER_PREFIX + connection.pairing.tabToken]);
    } catch {
      this.scheduleReconnect(connection);
      return;
    }
    connection.socket = socket;
    socket.addEventListener('open', () => {
      connection.attempt = 0;
      connection.status = 'online';
      this.emit();
      const state = useWorkflowStore.getState();
      const project = state.projects.find(item => item.id === state.activeProjectId);
      this.send(connection, { t: LINK_FRAME.HELLO, tab: { title: project?.title || (typeof document !== 'undefined' ? document.title : ''), projectId: project?.id ?? null } });
    });
    socket.addEventListener('message', event => void this.onMessage(connection, (event as MessageEvent).data));
    socket.addEventListener('close', event => {
      if (connection.socket !== socket) return;
      connection.socket = null;
      const code = (event as CloseEvent).code;
      if (code === LINK_CLOSE.REVOKED) {
        connection.status = 'revoked';
        connection.stopped = true;
        connection.releaseLock?.();
        removeLinkPairing(connection.pairing.roomId, this.storage);
        this.connections.delete(connection.pairing.roomId);
        this.emit();
        return;
      }
      if (code === LINK_CLOSE.REPLACED) {
        // 另一台设备 / 浏览器接管了这个配对：这里不再抢。
        connection.status = 'standby';
        connection.stopped = true;
        connection.releaseLock?.();
        this.emit();
        return;
      }
      this.scheduleReconnect(connection);
    });
  }

  private scheduleReconnect(connection: Connection) {
    if (connection.stopped) return;
    connection.status = 'offline';
    this.emit();
    const delay = Math.min(this.options.maxBackoffMs ?? 30_000, 500 * 2 ** connection.attempt++);
    connection.timer = setTimeout(() => this.open(connection), delay);
  }

  private send(connection: Connection, frame: unknown) {
    try { connection.socket?.send(JSON.stringify(frame)); } catch { /* reconnect will follow */ }
  }

  private async onMessage(connection: Connection, data: unknown) {
    if (typeof data !== 'string') return;
    let frame: { t?: string; id?: string; cmd?: string; args?: unknown; idem?: string; code?: string; grant?: { scopes?: string[]; clientName?: string } };
    try { frame = JSON.parse(data); } catch { return; }
    if (frame.t === LINK_FRAME.SYSTEM && frame.code === LINK_ERROR.REVOKED) {
      removeLinkPairing(connection.pairing.roomId, this.storage);
      return;
    }
    if (frame.t !== LINK_FRAME.REQUEST || typeof frame.id !== 'string' || typeof frame.cmd !== 'string') return;
    connection.lastCommandAt = new Date().toISOString();
    this.emit();
    // 范围取「标签页自己保存的授予」与「中继附带的授予」的交集：任何一边少给都按少的算。
    const relayScopes = new Set(normalizeLinkScopes(frame.grant?.scopes));
    const scopes = connection.pairing.scopes.filter(scope => relayScopes.has(scope));
    const result = await this.handle(frame.cmd, frame.args, { scopes, ...(frame.idem ? { idempotencyKey: frame.idem } : {}), source: 'web', clientName: connection.pairing.clientName });
    let text = JSON.stringify({ t: LINK_FRAME.RESPONSE, id: frame.id, ...result });
    if (utf8Length(text) > LINK_MAX_FRAME_BYTES) {
      text = JSON.stringify({ t: LINK_FRAME.RESPONSE, id: frame.id, ok: false, error: { code: LINK_ERROR.FRAME_TOO_LARGE, message: `结果超过 ${LINK_MAX_FRAME_BYTES} 字节；缩小查询范围（例如 summary=true、afterSeq）。` } });
    }
    try { connection.socket?.send(text); } catch { /* CLI 会超时并按幂等键重试 */ }
  }
}

let activeHost: WebLinkHost | null = null;

/** App 启动时调用一次（只在网页端；桌面端走本机 loopback）。 */
export function startWebLinkHost(options: WebLinkHostOptions = {}): WebLinkHost {
  if (activeHost) return activeHost;
  activeHost = new WebLinkHost(options);
  activeHost.start();
  return activeHost;
}

export function stopWebLinkHost() {
  activeHost?.stop();
  activeHost = null;
}

const EMPTY: LinkHostState = { pairings: [] };
export function useWebLinkHostState(): LinkHostState {
  return useSyncExternalStore(
    listener => activeHost?.subscribe(listener) ?? (() => undefined),
    () => activeHost?.getSnapshot() ?? EMPTY,
    () => EMPTY,
  );
}
