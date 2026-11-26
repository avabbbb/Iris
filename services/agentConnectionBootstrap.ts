import { setBrowserWorkflowBinding } from './browserWorkflowBinding';
import type { ManagedAgentConnection } from './managedAgentConnection';
import { useAgentConnectionStore, type AgentConnectionStatus } from '../stores/useAgentConnectionStore';
import { agentLinkIssue, agentLinkIssueMessage, diagnoseAgentLink, type AgentLinkIssue } from './agentLinkIssue';

const AGENT_URL_PARAM = 'agentUrl';
const AGENT_TOKEN_PARAM = 'agentToken';
const BOOTSTRAP_TOKEN_PARAM = 'bootstrapToken';
const AUTO_ACTIVATE_PARAM = 'activateBrowserWriter';
const SESSION_URL_KEY = 'iris.agent.bootstrap.url';
const SESSION_TOKEN_KEY = 'iris.agent.bootstrap.token';
const SESSION_EXPIRES_KEY = 'iris.agent.bootstrap.expires';
const SESSION_AUTO_ACTIVATE_KEY = 'iris.agent.bootstrap.activate';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

type BootstrapLocation = Pick<Location, 'href' | 'search' | 'hash' | 'pathname'>;
type BootstrapHistory = Pick<History, 'replaceState'>;
type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export type AgentBootstrapState = 'skipped' | 'connecting' | 'ready' | 'offline' | 'auth_failed';

export interface AgentBootstrapResult {
  state: AgentBootstrapState;
  connection?: ManagedAgentConnection;
  error?: string;
}

export interface AgentConnectionBootstrapOptions {
  location?: BootstrapLocation;
  history?: BootstrapHistory;
  sessionStorage?: StorageLike;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retryDelayMs?: number;
  maxAttempts?: number;
  /** Classifies a failed link; injectable for tests. */
  diagnose?: typeof diagnoseAgentLink;
}

const BOOTSTRAP_EXCHANGE_TIMEOUT_MS = 8000;

let inFlight: Promise<AgentBootstrapResult> | null = null;
/** Bumped by every run; a run that is no longer the latest must not touch the store or binding. */
let generation = 0;
/**
 * 内存暂存尚未成功换票的一次性 bootstrap 参数（不写入 localStorage / sessionStorage）。
 * 线上 HTTPS 页面首次请求本机 Agent 可能触发浏览器“允许访问本地网络”权限框导致首次换票超时；
 * URL 参数在首轮已被擦除，保留在内存里可让用户放行权限后点击「重新连接」继续完成换票。
 */
let pendingBootstrap: { url: string; bootstrapToken: string; autoActivate: boolean } | null = null;

function browserLocation(): BootstrapLocation | null {
  return typeof window === 'undefined' ? null : window.location;
}

function browserHistory(): BootstrapHistory | null {
  return typeof window === 'undefined' ? null : window.history;
}

function sessionStore(): StorageLike | null {
  try { return typeof window === 'undefined' ? null : window.sessionStorage; }
  catch { return null; }
}

function parseHashParams(hash: string) {
  const queryIndex = String(hash || '').indexOf('?');
  return queryIndex < 0 ? new URLSearchParams() : new URLSearchParams(String(hash).slice(queryIndex + 1));
}

function readConnectionParams(location: BootstrapLocation) {
  const search = new URLSearchParams(location.search || '');
  const hash = parseHashParams(location.hash || '');
  return {
    url: search.get(AGENT_URL_PARAM) || hash.get(AGENT_URL_PARAM) || '',
    token: search.get(AGENT_TOKEN_PARAM) || hash.get(AGENT_TOKEN_PARAM) || '',
    bootstrapToken: search.get(BOOTSTRAP_TOKEN_PARAM) || hash.get(BOOTSTRAP_TOKEN_PARAM) || '',
    autoActivate: search.get(AUTO_ACTIVATE_PARAM) === '1' || hash.get(AUTO_ACTIVATE_PARAM) === '1',
    fromUrl: search.has(AGENT_URL_PARAM) || search.has(AGENT_TOKEN_PARAM) || search.has(BOOTSTRAP_TOKEN_PARAM) || search.has(AUTO_ACTIVATE_PARAM)
      || hash.has(AGENT_URL_PARAM) || hash.has(AGENT_TOKEN_PARAM) || hash.has(BOOTSTRAP_TOKEN_PARAM) || hash.has(AUTO_ACTIVATE_PARAM),
  };
}

function readSessionConnection(storage: StorageLike | null) {
  if (!storage) return { url: '', token: '' };
  try {
    const expiresAt = Number(storage.getItem(SESSION_EXPIRES_KEY) || 0);
    if (expiresAt && expiresAt <= Date.now()) {
      storage.removeItem(SESSION_URL_KEY);
      storage.removeItem(SESSION_TOKEN_KEY);
      storage.removeItem(SESSION_EXPIRES_KEY);
      return { url: '', token: '' };
    }
    return { url: storage.getItem(SESSION_URL_KEY) || '', token: storage.getItem(SESSION_TOKEN_KEY) || '' };
  } catch {
    return { url: '', token: '' };
  }
}

function normalizeUrl(value: string) {
  let url;
  try { url = new URL(value); }
  catch { throw new Error('Iris Agent 地址无效。'); }
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error('Iris Agent 只能使用本机 loopback HTTP 地址。');
  }
  return url.origin;
}

function normalizeConnection(url: string, token: string): ManagedAgentConnection {
  const normalizedUrl = normalizeUrl(url.trim());
  if (!token.trim()) throw new Error('Iris Agent bootstrap 缺少连接 Token。');
  return { state: 'ready', url: normalizedUrl, token: token.trim(), managed: false };
}

function scrubConnectionParams(location: BootstrapLocation, history: BootstrapHistory | null) {
  if (!history) return;
  try {
    const url = new URL(location.href);
    url.searchParams.delete(AGENT_URL_PARAM);
    url.searchParams.delete(AGENT_TOKEN_PARAM);
    url.searchParams.delete(BOOTSTRAP_TOKEN_PARAM);
    url.searchParams.delete(AUTO_ACTIVATE_PARAM);
    const hashQueryIndex = url.hash.indexOf('?');
    if (hashQueryIndex >= 0) {
      const route = url.hash.slice(0, hashQueryIndex);
      const params = new URLSearchParams(url.hash.slice(hashQueryIndex + 1));
      params.delete(AGENT_URL_PARAM);
      params.delete(AGENT_TOKEN_PARAM);
      params.delete(BOOTSTRAP_TOKEN_PARAM);
      params.delete(AUTO_ACTIVATE_PARAM);
      url.hash = params.size ? `${route}?${params}` : route;
    }
    history.replaceState(null, typeof document === 'undefined' ? '' : document.title, `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // A restricted embedded browser may reject history changes; connection still works.
  }
}

function saveSessionConnection(storage: StorageLike | null, connection: ManagedAgentConnection) {
  if (!storage) return;
  try {
    storage.setItem(SESSION_URL_KEY, connection.url);
    storage.setItem(SESSION_TOKEN_KEY, connection.token);
  } catch {
    // Private browsing/storage restrictions should not block the current connection.
  }
}

function saveSessionExpiry(storage: StorageLike | null, expiresAt?: number) {
  if (!storage) return;
  try {
    if (Number.isFinite(expiresAt)) storage.setItem(SESSION_EXPIRES_KEY, String(expiresAt));
    else storage.removeItem(SESSION_EXPIRES_KEY);
  } catch { /* storage is best effort */ }
}

function clearSessionConnection(storage: StorageLike | null) {
  if (!storage) return;
  try {
    storage.removeItem(SESSION_URL_KEY);
    storage.removeItem(SESSION_TOKEN_KEY);
    storage.removeItem(SESSION_EXPIRES_KEY);
  } catch { /* storage is best effort */ }
}

function saveAutoActivation(storage: StorageLike | null, enabled: boolean) {
  if (!storage) return;
  try {
    if (enabled) storage.setItem(SESSION_AUTO_ACTIVATE_KEY, '1');
    else storage.removeItem(SESSION_AUTO_ACTIVATE_KEY);
  } catch { /* storage is best effort */ }
}

async function requestJson(url: URL, options: AgentConnectionBootstrapOptions, token?: string, headers: Record<string, string> = {}, method = 'GET') {
  const fetchImpl = options.fetchImpl || fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 1200);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      method,
      headers: { ...(token ? { 'x-flovart-agent-token': token } : {}), ...headers },
    });
    const body = await response.json().catch(() => ({}));
    return { response, body };
  } catch (cause) {
    if (controller.signal.aborted) throw new Error('连接本机 Iris Agent 超时。');
    throw cause;
  } finally {
    clearTimeout(timer);
  }
}

async function exchangeBootstrapCredential(url: string, bootstrapToken: string, options: AgentConnectionBootstrapOptions) {
  if (!url) throw new Error('缺少 Iris Agent 地址，无法完成 bootstrap。');
  const result = await requestJson(
    new URL('/bootstrap/exchange', url),
    options,
    undefined,
    { 'x-flovart-bootstrap-token': bootstrapToken },
    'POST',
  );
  if (!result.response.ok || typeof result.body?.sessionToken !== 'string' || !result.body.sessionToken) {
    const error = new Error(String(result.body?.error?.message || result.body?.error || `Browser bootstrap 返回 HTTP ${result.response.status}。`));
    (error as Error & { code?: string }).code = result.body?.error?.code || 'AUTH_FAILED';
    (error as Error & { httpStatus?: number }).httpStatus = result.response.status;
    throw error;
  }
  return { token: result.body.sessionToken, expiresAt: Number(result.body.expiresAt) || undefined };
}

/**
 * The first `/hosts` call after an Agent restart still pays a real host
 * scan (~1s for a PATH-only probe, several seconds with `--version`), but
 * the endpoint now caches discovery for a short TTL so the bootstrap retry
 * loop and later callers hit a warm cache instead of rescanning every time.
 * The budget stays wider than `/health`'s so a cold first scan still fits;
 * `/health` keeps the short budget so a genuinely absent Agent fails fast.
 */
const HOSTS_PROBE_TIMEOUT_MS = 8000;

async function authenticate(connection: ManagedAgentConnection, options: AgentConnectionBootstrapOptions) {
  const health = await requestJson(new URL('/health', connection.url), options);
  if (!health.response.ok) throw new Error(`Agent health 返回 HTTP ${health.response.status}。`);
  const hostsOptions = { ...options, timeoutMs: Math.max(Number(options.timeoutMs) || 0, HOSTS_PROBE_TIMEOUT_MS) };
  const hosts = await requestJson(new URL('/hosts?includeVersion=false', connection.url), hostsOptions, connection.token);
  if (hosts.response.status === 401 || /invalid token/i.test(String(hosts.body?.error || ''))) {
    const error = new Error('Iris Agent Token 无效。');
    (error as Error & { code?: string }).code = 'AUTH_FAILED';
    throw error;
  }
  if (!hosts.response.ok || hosts.body?.ok === false) {
    throw new Error(`Agent Host 返回 HTTP ${hosts.response.status}。`);
  }
}

function setStoreStatus(status: AgentConnectionStatus, patch: Parameters<ReturnType<typeof useAgentConnectionStore.getState>['setStatus']>[1] = {}) {
  useAgentConnectionStore.getState().setStatus(status, patch);
}

async function classifyFailure(options: AgentConnectionBootstrapOptions, url: string | null, token: string | null, fallback: AgentLinkIssue['kind']): Promise<AgentLinkIssue> {
  try {
    const issue = await (options.diagnose || diagnoseAgentLink)({ url, token, fetchImpl: options.fetchImpl, timeoutMs: Math.max(options.timeoutMs || 0, 1500) });
    return issue || agentLinkIssue(fallback, url);
  } catch {
    return agentLinkIssue(fallback, url);
  }
}

async function runBootstrap(options: AgentConnectionBootstrapOptions, runId: number): Promise<AgentBootstrapResult> {
  const isCurrent = () => runId === generation;
  const location = options.location || browserLocation();
  if (!location) return { state: 'skipped' };
  const storage = options.sessionStorage || sessionStore();
  const params = readConnectionParams(location);
  const history = options.history || browserHistory();
  if (params.fromUrl) scrubConnectionParams(location, history);
  const session = readSessionConnection(storage);
  if (params.bootstrapToken && params.url) {
    pendingBootstrap = { url: params.url, bootstrapToken: params.bootstrapToken, autoActivate: params.autoActivate };
  }
  const reusablePending = !params.fromUrl && !session.token && pendingBootstrap ? pendingBootstrap : null;
  const url = params.url || session.url || reusablePending?.url || '';
  const token = params.token || session.token;
  const bootstrapToken = params.bootstrapToken || reusablePending?.bootstrapToken || '';
  const autoActivate = params.fromUrl ? params.autoActivate : Boolean(reusablePending?.autoActivate);
  if (!url && !token && !bootstrapToken) {
    // Nothing handed over: say so (with the next step) instead of a bare "offline".
    const state = useAgentConnectionStore.getState();
    if (isCurrent() && state.status === 'offline' && !state.issue) setStoreStatus('offline', { issue: agentLinkIssue('not_configured', null) });
    return { state: 'skipped' };
  }

  setStoreStatus('connecting', { url: url || null, error: null, issue: null });
  let connection: ManagedAgentConnection;
  let sessionExpiresAt: number | undefined;
  const maxAttempts = Math.max(1, options.maxAttempts || 8);
  try {
    let exchanged: { token: string; expiresAt: number | undefined };
    if (bootstrapToken) {
      const exchangeOptions = { ...options, timeoutMs: options.timeoutMs ?? BOOTSTRAP_EXCHANGE_TIMEOUT_MS };
      const maxExchangeAttempts = Math.min(maxAttempts, 3);
      let exchangeResult: { token: string; expiresAt: number | undefined } | null = null;
      let exchangeError: unknown = null;
      for (let attempt = 0; attempt < maxExchangeAttempts; attempt += 1) {
        if (!isCurrent()) return { state: 'offline', error: 'superseded' };
        try {
          exchangeResult = await exchangeBootstrapCredential(url, bootstrapToken, exchangeOptions);
          pendingBootstrap = null;
          break;
        } catch (cause) {
          exchangeError = cause;
          const httpStatus = (cause as Error & { httpStatus?: number })?.httpStatus;
          if (typeof httpStatus === 'number') {
            // 服务端已明确拒绝（401 / 403）：一次性凭证已作废，立即清除且不重试。
            pendingBootstrap = null;
            throw cause;
          }
          if (attempt + 1 < maxExchangeAttempts) {
            await new Promise(resolve => setTimeout(resolve, options.retryDelayMs || 350));
          }
        }
      }
      if (!exchangeResult) throw exchangeError;
      exchanged = exchangeResult;
    } else {
      exchanged = { token, expiresAt: undefined };
    }
    sessionExpiresAt = exchanged.expiresAt;
    connection = normalizeConnection(url, exchanged.token);
  } catch (cause) {
    if (!isCurrent()) return { state: 'offline', error: 'superseded' };
    const httpStatus = (cause as Error & { httpStatus?: number })?.httpStatus;
    const rejected = typeof httpStatus === 'number';
    // No HTTP answer at all means the Agent is down / unreachable — that is
    // "offline", not an expired credential. Only a real rejection is auth.
    if (bootstrapToken && !rejected) {
      const issue = await classifyFailure(options, url || null, null, 'unreachable');
      if (!isCurrent()) return { state: 'offline', error: 'superseded' };
      const error = agentLinkIssueMessage(issue);
      setStoreStatus('offline', { url: url || null, error, issue });
      return { state: 'offline', error };
    }
    pendingBootstrap = null;
    clearSessionConnection(storage);
    saveAutoActivation(storage, false);
    setBrowserWorkflowBinding(null);
    const message = cause instanceof Error ? cause.message : String(cause);
    const issue = agentLinkIssue(rejected && httpStatus === 403 ? 'cors' : rejected ? 'auth' : 'not_configured', url || null, rejected ? `HTTP ${httpStatus}` : undefined);
    setStoreStatus('auth_failed', { url: null, clientId: null, projectId: null, revision: null, error: message, issue });
    return { state: 'auth_failed', error: message };
  }

  // Remember the credential before probing: if the Agent is still starting
  // and every attempt fails, "Reconnect" (or a reload) can retry with it
  // instead of the page silently losing the launcher hand-off it scrubbed from the URL.
  saveSessionConnection(storage, connection);
  saveSessionExpiry(storage, sessionExpiresAt);

  let lastError = 'Iris Agent 暂时不可用。';
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (!isCurrent()) return { state: 'offline', connection, error: 'superseded' };
    try {
      await authenticate(connection, options);
      if (!isCurrent()) return { state: 'offline', connection, error: 'superseded' };
      saveAutoActivation(storage, autoActivate);
      setBrowserWorkflowBinding(connection);
      return { state: 'ready', connection };
    } catch (cause) {
      lastError = cause instanceof Error ? cause.message : String(cause);
      if ((cause as Error & { code?: string })?.code === 'AUTH_FAILED') {
        if (!isCurrent()) return { state: 'offline', connection, error: 'superseded' };
        clearSessionConnection(storage);
        saveAutoActivation(storage, false);
        setBrowserWorkflowBinding(null);
        const issue = agentLinkIssue('auth', connection.url, 'HTTP 401');
        setStoreStatus('auth_failed', { url: connection.url, clientId: null, projectId: null, revision: null, error: lastError, issue });
        return { state: 'auth_failed', connection, error: lastError };
      }
      if (attempt + 1 < maxAttempts) await new Promise(resolve => setTimeout(resolve, options.retryDelayMs || 350));
    }
  }
  const issue = await classifyFailure(options, connection.url, connection.token, 'unreachable');
  if (!isCurrent()) return { state: 'offline', connection, error: 'superseded' };
  setStoreStatus('offline', { url: connection.url, error: agentLinkIssueMessage(issue), issue });
  return { state: 'offline', connection, error: lastError };
}

/**
 * Implicit calls (app start) share one in-flight run. A call that carries its
 * own credential (`location` — the DSH embed's fresh one-time token) or
 * `force` (user pressed Reconnect) always starts a new run and supersedes the
 * older one; otherwise a stale session retry would swallow the fresh token and
 * the page would end on "credential expired" even though a valid one arrived.
 */
export function bootstrapLocalAgentConnection(options: AgentConnectionBootstrapOptions & { force?: boolean } = {}) {
  if (inFlight && !options.location && !options.force) return inFlight;
  const runId = ++generation;
  const run = runBootstrap(options, runId).finally(() => { if (inFlight === run) inFlight = null; });
  inFlight = run;
  return run;
}

/** True while a bootstrap run owns the link status (it will set ready / offline / auth_failed itself). */
export function isAgentBootstrapInFlight() {
  return inFlight !== null;
}

export function resetAgentConnectionBootstrapForTests() {
  inFlight = null;
  generation = 0;
  pendingBootstrap = null;
}

export function consumeBrowserWriterAutoActivation(storage: StorageLike | null = sessionStore()) {
  if (!storage) return false;
  try {
    const enabled = storage.getItem(SESSION_AUTO_ACTIVATE_KEY) === '1';
    storage.removeItem(SESSION_AUTO_ACTIVATE_KEY);
    return enabled;
  } catch {
    return false;
  }
}

export const agentBootstrapStorageKeys = Object.freeze({
  url: SESSION_URL_KEY,
  token: SESSION_TOKEN_KEY,
  expiresAt: SESSION_EXPIRES_KEY,
  autoActivate: SESSION_AUTO_ACTIVATE_KEY,
});
