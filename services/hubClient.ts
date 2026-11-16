// Flovart Hub 后端 API 客户端
// Hub 服务（auth、prompts、uploads）的统一入口；服务端是 server/hub（Cloudflare Pages Functions + D1 + R2）

// Hub API 由 Cloudflare Pages Functions 提供（functions/api/v1，server/hub/），默认走同源 /api/v1。
// 覆盖：构建时设 VITE_HUB_BASE_URL（例如本地 `wrangler pages dev` 的 http://127.0.0.1:8788/api/v1，
// 或旧 Go 后端 http://localhost:11452/api/v1）。
export const SAME_ORIGIN_HUB_BASE = '/api/v1';
// 非 http(s) 来源（Tauri 的 tauri://localhost、file://）没有同源 Functions，只能用绝对地址；
// 桌面版应在构建时用 VITE_HUB_BASE_URL 指向线上站点，未配置时沿用旧的本机 Go 后端地址。
export const LEGACY_LOCAL_HUB_BASE = 'http://localhost:11452/api/v1';

function readEnvBase(key: string): string | null {
  // 仅在 web 环境可用；Tauri 也会注入 import.meta.env
  try {
    const v = (import.meta as { env?: Record<string, string | undefined> }).env?.[key];
    if (v && typeof v === 'string') return v.replace(/\/+$/, '');
  } catch {}
  return null;
}

export function resolveHubBaseUrl(override: string | null, protocol: string | undefined): string {
  if (override) return override.replace(/\/+$/, '');
  if (protocol === 'http:' || protocol === 'https:') return SAME_ORIGIN_HUB_BASE;
  return LEGACY_LOCAL_HUB_BASE;
}

export const HUB_BASE_URL = resolveHubBaseUrl(
  readEnvBase('VITE_HUB_BASE_URL'),
  typeof location !== 'undefined' ? location.protocol : undefined,
);

// Hub JWT 只保留当前浏览器会话；长期登录应由后端改为 HttpOnly Cookie。
const TOKEN_KEY = 'flovart.hub.token';

export function getToken(): string | null {
  try {
    const token = sessionStorage.getItem(TOKEN_KEY);
    if (token) return token;

    // 一次性收走旧版本写入 localStorage 的明文 token。
    const legacyToken = localStorage.getItem(TOKEN_KEY);
    if (legacyToken) sessionStorage.setItem(TOKEN_KEY, legacyToken);
    localStorage.removeItem(TOKEN_KEY);
    return legacyToken;
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {}
}

export interface ApiResponse<T> {
  code: number;
  data: T;
  msg: string;
}

export class ApiError extends Error {
  code: number;
  constructor(code: number, msg: string) {
    super(msg);
    this.code = code;
  }
}

function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function request<T>(
  base: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const url = path.startsWith('http') ? path : `${base}${path}`;
  const headers = new Headers(init.headers);
  for (const [k, v] of Object.entries(authHeaders())) headers.set(k, v);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('请求超时', 'TimeoutError')), 15_000);
  if (init.signal) {
    if (init.signal.aborted) controller.abort();
    else init.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  try {
    const res = await fetch(url, { ...init, signal: controller.signal, headers });
    const text = await res.text();
    let payload: ApiResponse<T> | null = null;
    try {
      payload = text ? (JSON.parse(text) as ApiResponse<T>) : null;
    } catch {
      throw new ApiError(res.status, `响应解析失败 (${res.status})`);
    }
    if (!res.ok || !payload || payload.code !== 0) {
      const msg = payload?.msg || `请求失败 (${res.status})`;
      throw new ApiError(payload?.code ?? res.status, msg);
    }
    return payload.data;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (controller.signal.aborted && !(init.signal?.aborted)) {
      throw new ApiError(-1, '请求超时（15s），请检查网络或稍后重试。');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export const api = {
  get: <T>(base: string, path: string) => request<T>(base, path, { method: 'GET' }),
  post: <T>(base: string, path: string, body?: unknown) =>
    request<T>(base, path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
  put: <T>(base: string, path: string, body?: unknown) =>
    request<T>(base, path, { method: 'PUT', body: body ? JSON.stringify(body) : undefined }),
  del: <T>(base: string, path: string) => request<T>(base, path, { method: 'DELETE' }),
};

// ===== Auth =====
export interface HubUser {
  id: string;
  username: string;
  email: string;
  bio?: string;
  avatarUrl?: string;
  role: 'user' | 'admin';
  status?: 'active' | 'suspended' | 'deleted';
}

export const authApi = {
  register: (body: { username: string; email: string; password: string }) =>
    api.post<{ user: HubUser; token: string }>(HUB_BASE_URL, '/auth/register', body),
  login: (body: { identifier: string; password: string }) =>
    api.post<{ user: HubUser; token: string }>(HUB_BASE_URL, '/auth/login', body),
  me: () => api.get<{ userId: string; username: string; email: string; role: string }>(HUB_BASE_URL, '/auth/me'),
};
