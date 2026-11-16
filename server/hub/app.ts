/**
 * Flovart Hub HTTP layer: router, CORS, auth middleware and handlers, ported
 * from backend/cmd/server/main.go + backend/handler + backend/middleware.
 *
 * A pure `(Request, env) → Response` function so the Pages Function stays a
 * one-liner and tests can inject an in-memory D1 and fake storage.
 *
 * Routes (prefix /api/v1, same as Go):
 *   GET  /healthz                     (also /api/healthz)
 *   POST /auth/register   POST /auth/login   GET /auth/me (auth)
 *   GET  /prompts   GET /prompts/by-slug/:slug   GET /prompts/:id   GET /prompts/:id/download
 *   POST /prompts (auth)   PUT /prompts/:id (auth)   DELETE /prompts/:id (auth)   POST /prompts/:id/like (auth)
 *   POST /uploads/presign (auth)   POST /uploads/confirm (auth)
 * Responses: { code, data, msg } (code 0 on success, = HTTP status on failure).
 */
import { asAppError } from './apperr';
import { verifyJwt } from './crypto';
import { PromptRepository, UserRepository, userJson, type Query } from './repository';
import { AuthService, PromptService, UploadService, type CreateInput, type UploadStorage } from './services';
import { storageFromEnv } from './storage';
import type { D1Database, HubEnv } from './types';

export const HUB_API_PREFIX = '/api/v1';
/** Single JSON request body cap (Go maxRequestBody); uploads go straight to R2. */
export const HUB_MAX_REQUEST_BODY = 4 << 20;

// ---------- responses ----------

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

export const ok = (data: unknown) => json(200, { code: 0, data, msg: 'ok' });
export const fail = (status: number, msg: string) => json(status, { code: status, data: null, msg });

function failErr(err: unknown, request: Request, path: string): Response {
  const e = asAppError(err);
  if (e) return fail(e.status, e.message);
  console.error(`hub internal error: ${request.method} ${path}:`, err);
  return fail(500, '服务器内部错误');
}

class BindError extends Error {}

// ---------- JSON binding (gin ShouldBindJSON semantics) ----------

type FieldKind = 'string' | 'int' | 'stringArray' | 'items';

/**
 * Reads a JSON object body and type-checks the listed fields like encoding/json:
 * a present field of the wrong type fails the bind (→ 400 入参格式错误); null
 * leaves the zero value; unknown fields are ignored; empty/oversized/invalid body fails.
 */
async function bindJson(request: Request, spec: Record<string, FieldKind>): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > HUB_MAX_REQUEST_BODY) throw new BindError('body too large');
  const buf = await request.arrayBuffer();
  if (buf.byteLength > HUB_MAX_REQUEST_BODY) throw new BindError('body too large');
  if (buf.byteLength === 0) throw new BindError('empty body');
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(buf));
  } catch {
    throw new BindError('invalid json');
  }
  if (raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new BindError('not an object');
  const obj = raw as Record<string, unknown>;
  const isInt = (v: unknown) => typeof v === 'number' && Number.isInteger(v);
  const isStr = (v: unknown) => typeof v === 'string';
  for (const [field, kind] of Object.entries(spec)) {
    const v = obj[field];
    if (v === undefined || v === null) continue;
    let good = true;
    if (kind === 'string') good = isStr(v);
    else if (kind === 'int') good = isInt(v);
    else if (kind === 'stringArray') good = Array.isArray(v) && v.every((x) => x === null || isStr(x));
    else if (kind === 'items') {
      good = Array.isArray(v) && v.every((it) => it === null || (typeof it === 'object' && !Array.isArray(it)
        && ['id', 'packId', 'name', 'prompt'].every((k) => (it as Record<string, unknown>)[k] == null || isStr((it as Record<string, unknown>)[k]))
        && ((it as Record<string, unknown>).sort == null || isInt((it as Record<string, unknown>).sort))));
    }
    if (!good) throw new BindError(`bad field ${field}`);
  }
  return obj;
}

const s = (v: unknown) => (typeof v === 'string' ? v : '');

// ---------- CORS (middleware/cors.go) ----------

const CORS_METHODS = 'GET, POST, PUT, DELETE, OPTIONS';
const CORS_HEADERS = 'Content-Type, Authorization';

export function isLoopbackOrigin(origin: string): boolean {
  let u: URL;
  try {
    u = new URL(origin.toLowerCase());
  } catch {
    return false;
  }
  if (!u.host) return false;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (u.protocol === 'tauri:') return host === 'localhost';
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === 'tauri.localhost';
}

export function corsHeaders(allowRaw: string | undefined, origin: string | null): Headers {
  const allow = (allowRaw ?? '*').trim().toLowerCase();
  const h = new Headers();
  const echo = () => {
    h.set('Access-Control-Allow-Origin', origin!);
    h.set('Access-Control-Allow-Methods', CORS_METHODS);
    h.set('Access-Control-Allow-Headers', CORS_HEADERS);
    h.set('Access-Control-Allow-Credentials', 'true');
  };
  if (allow === '' || allow === 'off') return h;
  if (allow === '*') {
    h.set('Access-Control-Allow-Origin', '*');
    h.set('Access-Control-Allow-Methods', CORS_METHODS);
    h.set('Access-Control-Allow-Headers', CORS_HEADERS);
    return h;
  }
  h.append('Vary', 'Origin');
  if (allow === 'loopback') {
    if (origin && isLoopbackOrigin(origin)) echo();
    return h;
  }
  const whitelist = new Set(allow.split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean));
  if (origin && whitelist.has(origin.toLowerCase())) echo();
  return h;
}

// ---------- auth middleware (middleware/auth.go) ----------

export interface SessionReader {
  sessionState(id: string): Promise<{ status: string; tokenVersion: number }>;
}

export interface AuthContext {
  userId: string;
  role: string;
}

function extractToken(request: Request): string {
  const auth = (request.headers.get('authorization') ?? '').trim();
  const prefix = 'bearer ';
  if (auth.length > prefix.length && auth.slice(0, prefix.length).toLowerCase() === prefix) return auth.slice(prefix.length).trim();
  return '';
}

/** Returns the auth context, or the error Response to send. */
export async function authenticate(request: Request, secret: string, reader: SessionReader | null): Promise<AuthContext | Response> {
  const token = extractToken(request);
  if (!token) return fail(401, '未登录');
  const claims = await verifyJwt(token, secret);
  const aud = claims ? (Array.isArray(claims.aud) ? claims.aud : typeof claims.aud === 'string' ? [claims.aud] : []) : [];
  if (!claims || typeof claims.sub !== 'string' || claims.sub === '' || aud.length === 0 || !aud[0]) {
    return fail(401, '登录已过期');
  }
  if (reader) {
    let state: { status: string; tokenVersion: number };
    try {
      state = await reader.sessionState(claims.sub);
    } catch (err) {
      // a database outage must not look like "logged out" to the client
      console.error('hub auth: session state lookup failed:', err);
      return fail(503, '服务暂不可用，请稍后重试');
    }
    if (state.status !== 'active' || state.tokenVersion !== Number(claims.ver)) return fail(401, '登录已失效');
  }
  return { userId: claims.sub, role: String(aud[0]) };
}

// ---------- query parsing (handler/prompt_handler.go List) ----------

/** strconv.Atoi with errors → 0 (Go atoi helper). */
function atoi(v: string | null): number {
  if (!v || !/^[+-]?\d+$/.test(v)) return 0;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : 0;
}

export function parseListQuery(params: URLSearchParams): Query {
  const q: Query = {
    keyword: (params.get('keyword') ?? '').trim(),
    mode: params.get('mode') ?? '',
    authorId: params.get('authorId') ?? '',
    sort: params.get('sort') ?? '',
    page: atoi(params.get('page')),
    size: atoi(params.get('size')),
  };
  // gin QueryArray: every ?tags= value, not comma-split
  const tags = params.getAll('tags');
  if (tags.length > 0) q.tags = tags;
  return q;
}

// ---------- app ----------

export interface HubOverrides {
  /** Inject storage (tests); undefined → built from env; null → not configured. */
  storage?: UploadStorage | null;
}

function requireDb(env: HubEnv): D1Database {
  if (!env.HUB_DB) throw new Error('HUB_DB (D1) binding is not configured');
  return env.HUB_DB;
}

async function healthz(env: HubEnv): Promise<Response> {
  try {
    await requireDb(env).prepare('SELECT 1').first();
    return json(200, { ok: true });
  } catch {
    return json(503, { ok: false });
  }
}

async function route(request: Request, env: HubEnv, path: string, overrides: HubOverrides): Promise<Response> {
  const method = request.method.toUpperCase();
  if (path === '/healthz' && (method === 'GET' || method === 'HEAD')) return healthz(env);
  if (path === '/' && method === 'GET') return json(200, { service: 'flovart/hub', status: 'ok', api: HUB_API_PREFIX });

  const db = () => requireDb(env);
  const users = () => new UserRepository(db());
  const secret = () => {
    if (!env.JWT_SECRET) throw new Error('JWT_SECRET secret is not configured');
    return env.JWT_SECRET;
  };
  const authSvc = () => new AuthService(users(), secret(), atoi(env.JWT_EXP_HOURS ?? '') || 168);
  const promptSvc = () => new PromptService(new PromptRepository(db()));
  const requireAuth = () => authenticate(request, secret(), users());
  const bad = () => fail(400, '入参格式错误');

  const seg = path.split('/').filter(Boolean).map((p) => {
    try { return decodeURIComponent(p); } catch { return p; }
  });

  // ----- /auth -----
  if (seg[0] === 'auth' && seg.length === 2) {
    if (seg[1] === 'register' && method === 'POST') {
      let body: Record<string, unknown>;
      try { body = await bindJson(request, { username: 'string', email: 'string', password: 'string' }); } catch { return bad(); }
      const { user, token } = await authSvc().register(s(body.username), s(body.email), s(body.password));
      return ok({ user: userJson(user), token });
    }
    if (seg[1] === 'login' && method === 'POST') {
      let body: Record<string, unknown>;
      try { body = await bindJson(request, { identifier: 'string', password: 'string' }); } catch { return bad(); }
      const { user, token } = await authSvc().login(s(body.identifier), s(body.password));
      return ok({ user: userJson(user), token });
    }
    if (seg[1] === 'me' && method === 'GET') {
      const auth = await requireAuth();
      if (auth instanceof Response) return auth;
      const user = await authSvc().getUserById(auth.userId);
      if (!user) return fail(401, '用户不存在');
      return ok({ userId: user.id, username: user.username, email: user.email, role: user.role });
    }
  }

  // ----- /prompts -----
  if (seg[0] === 'prompts') {
    if (seg.length === 1) {
      if (method === 'GET') {
        return ok(await promptSvc().list(parseListQuery(new URL(request.url).searchParams)));
      }
      if (method === 'POST') {
        const auth = await requireAuth();
        if (auth instanceof Response) return auth;
        let body: Record<string, unknown>;
        try { body = await bindJson(request, PACK_SPEC); } catch { return bad(); }
        return ok(await promptSvc().create(auth.userId, packInput(body)));
      }
    }
    if (seg.length === 3 && seg[1] === 'by-slug' && method === 'GET') {
      const pack = await promptSvc().getBySlug(seg[2]);
      return pack ? ok(pack) : fail(404, '未找到');
    }
    if (seg.length === 2) {
      const id = seg[1];
      if (method === 'GET') {
        const pack = await promptSvc().get(id);
        return pack ? ok(pack) : fail(404, '未找到');
      }
      if (method === 'PUT') {
        const auth = await requireAuth();
        if (auth instanceof Response) return auth;
        let body: Record<string, unknown>;
        try { body = await bindJson(request, PACK_SPEC); } catch { return bad(); }
        return ok(await promptSvc().update(auth.userId, id, packInput(body)));
      }
      if (method === 'DELETE') {
        const auth = await requireAuth();
        if (auth instanceof Response) return auth;
        await promptSvc().delete(auth.userId, id);
        return ok({ deleted: id });
      }
    }
    if (seg.length === 3 && seg[2] === 'download' && method === 'GET') {
      const id = seg[1];
      const svc = promptSvc();
      const pack = await svc.get(id);
      if (!pack) return fail(404, '未找到');
      try {
        await svc.incrementDownload(id);
        pack.downloadCount++;
      } catch (err) {
        // counting failure must not break the download itself, but leave a trace
        console.error(`hub: increment download ${id}:`, err);
      }
      return ok(pack);
    }
    if (seg.length === 3 && seg[2] === 'like' && method === 'POST') {
      const auth = await requireAuth();
      if (auth instanceof Response) return auth;
      return ok({ liked: await promptSvc().toggleLike(auth.userId, seg[1]) });
    }
  }

  // ----- /uploads -----
  if (seg[0] === 'uploads' && seg.length === 2 && method === 'POST' && (seg[1] === 'presign' || seg[1] === 'confirm')) {
    const auth = await requireAuth();
    if (auth instanceof Response) return auth;
    const storage = overrides.storage !== undefined ? overrides.storage : storageFromEnv(env);
    const svc = new UploadService(storage);
    if (seg[1] === 'presign') {
      let body: Record<string, unknown>;
      try { body = await bindJson(request, { filename: 'string', contentType: 'string', purpose: 'string', sizeBytes: 'int' }); } catch { return bad(); }
      if (!s(body.filename) || !s(body.contentType)) return fail(400, 'filename 与 contentType 必填');
      return ok(await svc.presign(auth.userId, {
        filename: s(body.filename), contentType: s(body.contentType), purpose: s(body.purpose),
        sizeBytes: typeof body.sizeBytes === 'number' ? body.sizeBytes : 0,
      }));
    }
    let body: Record<string, unknown>;
    try { body = await bindJson(request, { key: 'string' }); } catch { return fail(400, 'key 必填'); }
    const key = s(body.key);
    if (!key) return fail(400, 'key 必填');
    return ok({ key, url: await svc.confirm(auth.userId, key) });
  }

  return fail(404, '接口不存在');
}

const PACK_SPEC: Record<string, FieldKind> = {
  slug: 'string', title: 'string', description: 'string', mode: 'string', tags: 'stringArray', items: 'items',
};

function packInput(body: Record<string, unknown>): CreateInput {
  return {
    slug: s(body.slug), title: s(body.title), description: s(body.description), mode: s(body.mode),
    tags: Array.isArray(body.tags) ? body.tags.map((t) => (typeof t === 'string' ? t : '')) : [],
    items: Array.isArray(body.items)
      ? body.items.map((it) => {
        const o = (it ?? {}) as Record<string, unknown>;
        return { name: s(o.name), prompt: s(o.prompt) };
      })
      : [],
  };
}

/**
 * Entry point. `path` is the route below /api/v1 (derived from the URL when omitted).
 * CORS headers are added to every response, and OPTIONS short-circuits with 204.
 */
export async function handleHubRequest(request: Request, env: HubEnv, overrides: HubOverrides = {}, pathOverride?: string): Promise<Response> {
  const url = new URL(request.url);
  let path = pathOverride ?? url.pathname;
  if (pathOverride === undefined) {
    if (path === HUB_API_PREFIX || path.startsWith(`${HUB_API_PREFIX}/`)) path = path.slice(HUB_API_PREFIX.length);
    else if (path === '/api/healthz') path = '/healthz';
  }
  if (path === '') path = '/';
  if (path.length > 1 && path.endsWith('/')) path = path.replace(/\/+$/, '');

  const cors = corsHeaders(env.CORS_ALLOW, request.headers.get('origin'));
  let response: Response;
  if (request.method.toUpperCase() === 'OPTIONS') {
    response = new Response(null, { status: 204 });
  } else {
    try {
      response = await route(request, env, path, overrides);
    } catch (err) {
      response = failErr(err, request, path);
    }
  }
  cors.forEach((value, key) => {
    if (key.toLowerCase() === 'vary') response.headers.append('Vary', value);
    else response.headers.set(key, value);
  });
  return response;
}
