// @vitest-environment node
// Ports of backend/middleware/auth_test.go (TestAuth, TestCORS, TestIsLoopbackOrigin)
// plus end-to-end route tests of the Pages Function app (server/hub/app.ts).
import { describe, expect, it } from 'vitest';
import { authenticate, corsHeaders, handleHubRequest, isLoopbackOrigin, parseListQuery, type SessionReader } from '../server/hub/app';
import { base64UrlEncode, signJwt, verifyJwt } from '../server/hub/crypto';
import { R2Storage } from '../server/hub/storage';
import type { UploadStorage } from '../server/hub/services';
import type { HubEnv } from '../server/hub/types';
import { createTestD1 } from './fixtures/hubD1';

const TEST_SECRET = 'test-secret-test-secret-test-secret';
const SUB = '11111111-1111-1111-1111-111111111111';
const BASE = 'https://flovart.example';

const sign = (ver: number, expSec: number, secret = TEST_SECRET) => {
  const now = Math.floor(Date.now() / 1000);
  return signJwt({ ver, sub: SUB, aud: ['user'], exp: now + expSec }, secret);
};

const reader = (status: string, tokenVersion: number, err?: Error): SessionReader => ({
  sessionState: async () => {
    if (err) throw err;
    return { status, tokenVersion };
  },
});

async function authStatus(r: SessionReader, header: string): Promise<number> {
  const req = new Request(`${BASE}/api/v1/auth/me`, { headers: header ? { authorization: header } : {} });
  const res = await authenticate(req, TEST_SECRET, r);
  return res instanceof Response ? res.status : 200;
}

describe('auth middleware (TestAuth)', () => {
  it('covers the same cases as the Go table test', async () => {
    const ok = reader('active', 1);
    const cases: Array<[string, SessionReader, string, number]> = [
      ['missing', ok, '', 401],
      ['valid', ok, `Bearer ${await sign(1, 3600)}`, 200],
      ['lowercase scheme', ok, `bearer ${await sign(1, 3600)}`, 200],
      ['expired', ok, `Bearer ${await sign(1, -3600)}`, 401],
      ['version bumped', reader('active', 2), `Bearer ${await sign(1, 3600)}`, 401],
      ['suspended', reader('suspended', 1), `Bearer ${await sign(1, 3600)}`, 401],
      ['user gone', reader('', 0), `Bearer ${await sign(1, 3600)}`, 401],
      ['db down is not logout', reader('', 0, new Error('db down')), `Bearer ${await sign(1, 3600)}`, 503],
      ['garbage', ok, 'Bearer abc.def.ghi', 401],
      ['wrong secret', ok, `Bearer ${await sign(1, 3600, 'another-secret-another-secret-xx')}`, 401],
    ];
    for (const [name, r, header, want] of cases) expect(await authStatus(r, header), name).toBe(want);
  });

  it('rejects alg=none / non-HS256 tokens and accepts a string aud', async () => {
    const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ sub: SUB, aud: ['user'], ver: 1 })));
    const none = `${base64UrlEncode(new TextEncoder().encode('{"alg":"none","typ":"JWT"}'))}.${payload}.`;
    expect(await verifyJwt(none, TEST_SECRET)).toBeNull();
    const strAud = await signJwt({ ver: 1, sub: SUB, aud: 'user' }, TEST_SECRET);
    expect(await authStatus(reader('active', 1), `Bearer ${strAud}`)).toBe(200);
    const noAud = await signJwt({ ver: 1, sub: SUB, aud: [] }, TEST_SECRET);
    expect(await authStatus(reader('active', 1), `Bearer ${noAud}`)).toBe(401);
  });
});

describe('CORS (TestCORS / TestIsLoopbackOrigin)', () => {
  it('matches the Go modes', async () => {
    let h = corsHeaders('*', 'https://evil.example');
    expect(h.get('Access-Control-Allow-Origin')).toBe('*');
    expect(h.get('Access-Control-Allow-Credentials')).toBeNull();
    h = corsHeaders('https://a.example, https://b.example', 'https://b.example');
    expect(h.get('Access-Control-Allow-Origin')).toBe('https://b.example');
    expect(h.get('Vary')).toBe('Origin');
    expect(corsHeaders('https://a.example', 'https://evil.example').get('Access-Control-Allow-Origin')).toBeNull();
    expect(corsHeaders('off', 'http://localhost:5173').get('Access-Control-Allow-Origin')).toBeNull();
    const res = await handleHubRequest(new Request(`${BASE}/api/v1/prompts`, { method: 'OPTIONS', headers: { origin: 'http://localhost:5173' } }),
      { CORS_ALLOW: 'loopback' });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
  });

  it('isLoopbackOrigin', () => {
    const table: Record<string, boolean> = {
      'http://localhost:3000': true, 'http://127.0.0.1': true, 'tauri://localhost': true, 'http://tauri.localhost': true,
      'http://localhost.evil.com': false, 'https://example.com': false, 'file://localhost': false, '': false, 'http://[::1]:8080': true,
    };
    for (const [o, want] of Object.entries(table)) expect(isLoopbackOrigin(o), o).toBe(want);
  });
});

describe('list query parsing (prompt_handler.go List)', () => {
  it('trims keyword, keeps repeated tags, atoi semantics', () => {
    const q = parseListQuery(new URLSearchParams('keyword=%20rain%20&tags=a&tags=b,c&page=2&size=x&sort=popular&mode=video&authorId=abc'));
    expect(q).toEqual({ keyword: 'rain', tags: ['a', 'b,c'], page: 2, size: 0, sort: 'popular', mode: 'video', authorId: 'abc' });
    expect(parseListQuery(new URLSearchParams('')).tags).toBeUndefined();
  });
});

// ---------- end-to-end through handleHubRequest ----------

function makeApp(storage?: UploadStorage | null) {
  const db = createTestD1();
  const env: HubEnv = { HUB_DB: db, JWT_SECRET: TEST_SECRET };
  const call = async (method: string, path: string, body?: unknown, token?: string, rawBody?: string) => {
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined || rawBody !== undefined) headers['content-type'] = 'application/json';
    const res = await handleHubRequest(new Request(`${BASE}${path}`, {
      method, headers, body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
    }), env, storage === undefined ? {} : { storage });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers };
  };
  return { db, env, call };
}

describe('hub routes', () => {
  it('healthz on both paths, and 503 when D1 is down', async () => {
    const { db, call } = makeApp();
    expect(await call('GET', '/api/v1/healthz')).toMatchObject({ status: 200, json: { ok: true } });
    expect(await call('GET', '/api/healthz')).toMatchObject({ status: 200, json: { ok: true } });
    db.setBroken(true);
    expect(await call('GET', '/api/v1/healthz')).toMatchObject({ status: 503, json: { ok: false } });
  });

  it('register → login → me, with the Go response shapes', async () => {
    const { call } = makeApp();
    const reg = await call('POST', '/api/v1/auth/register', { username: 'carol', email: 'Carol@x.io', password: 'pw123456' });
    expect(reg.status).toBe(200);
    expect(reg.json.code).toBe(0);
    expect(reg.json.msg).toBe('ok');
    expect(Object.keys(reg.json.data.user).sort()).toEqual(['avatarUrl', 'bio', 'createdAt', 'email', 'id', 'role', 'status', 'updatedAt', 'username']);
    expect(reg.json.data.user).toMatchObject({ username: 'carol', email: 'carol@x.io', role: 'user', status: 'active' });
    const login = await call('POST', '/api/v1/auth/login', { identifier: 'carol', password: 'pw123456' });
    expect(login.status).toBe(200);
    const me = await call('GET', '/api/v1/auth/me', undefined, login.json.data.token);
    expect(me.json).toEqual({ code: 0, msg: 'ok', data: { userId: reg.json.data.user.id, username: 'carol', email: 'carol@x.io', role: 'user' } });
    expect(await call('GET', '/api/v1/auth/me')).toMatchObject({ status: 401, json: { code: 401, data: null, msg: '未登录' } });
    expect(await call('POST', '/api/v1/auth/login', { identifier: 'carol', password: 'nope' }))
      .toMatchObject({ status: 401, json: { code: 401, msg: '账号或密码错误' } });
  });

  it('bind errors are 400 入参格式错误 like gin ShouldBindJSON', async () => {
    const { call } = makeApp();
    for (const raw of ['', '{bad', '[1]', '{"username":1,"email":"a@b.c","password":"pw123456"}']) {
      expect(await call('POST', '/api/v1/auth/register', undefined, undefined, raw || ' '.slice(1)), raw)
        .toMatchObject({ status: 400, json: { msg: '入参格式错误' } });
    }
    const big = JSON.stringify({ username: 'x'.repeat(5 << 20) });
    expect((await call('POST', '/api/v1/auth/register', undefined, undefined, big)).status).toBe(400);
  });

  it('prompt CRUD, like, download, list and 404s', async () => {
    const { call } = makeApp();
    const a = (await call('POST', '/api/v1/auth/register', { username: 'alice', email: 'a@x.io', password: 'pw123456' })).json.data;
    const b = (await call('POST', '/api/v1/auth/register', { username: 'bob', email: 'b@x.io', password: 'pw123456' })).json.data;
    expect((await call('POST', '/api/v1/prompts', { slug: 's', title: 't', items: [{ name: 'n', prompt: 'p' }] })).status).toBe(401);
    const created = await call('POST', '/api/v1/prompts', {
      slug: '夜雨', title: ' Rain ', tags: ['night'], mode: 'video',
      items: [{ id: 'evil', packId: 'evil', name: 'a', prompt: 'pa', sort: 7 }, { name: 'b', prompt: 'pb' }],
    }, a.token);
    expect(created.status).toBe(200);
    const pack = created.json.data;
    expect(pack).toMatchObject({ slug: '夜雨', title: 'Rain', mode: 'video', tags: ['night'], likeCount: 0, downloadCount: 0, authorId: a.user.id });
    expect(pack.items.map((i: { sort: number; packId: string }) => [i.sort, i.packId === pack.id])).toEqual([[0, true], [1, true]]);
    expect(Object.keys(pack)).toEqual(['id', 'slug', 'title', 'description', 'authorId', 'mode', 'tags', 'items', 'likeCount', 'downloadCount', 'createdAt', 'updatedAt']);
    expect(await call('POST', '/api/v1/prompts', { slug: '夜雨', title: 't', items: [{ name: 'n', prompt: 'p' }] }, a.token))
      .toMatchObject({ status: 409, json: { code: 409, msg: 'slug 已存在' } });
    expect((await call('POST', '/api/v1/prompts', { slug: 'x', title: 't', items: [{ name: 'n', prompt: 'p', sort: 1.5 }] }, a.token)).status).toBe(400);

    const bySlug = await call('GET', `/api/v1/prompts/by-slug/${encodeURIComponent('夜雨')}`);
    expect(bySlug.json.data.id).toBe(pack.id);
    expect(bySlug.json.data.author).toMatchObject({ id: a.user.id, username: 'alice', email: '' });
    expect((await call('GET', `/api/v1/prompts/${pack.id}`)).json.data.items).toHaveLength(2);
    expect(await call('GET', '/api/v1/prompts/not-a-uuid')).toMatchObject({ status: 404, json: { msg: '未找到' } });
    expect((await call('GET', '/api/v1/prompts/by-slug/none')).status).toBe(404);

    const dl = await call('GET', `/api/v1/prompts/${pack.id}/download`);
    expect(dl.json.data.downloadCount).toBe(1);
    expect((await call('GET', `/api/v1/prompts/${pack.id}`)).json.data.downloadCount).toBe(1);

    expect((await call('POST', `/api/v1/prompts/${pack.id}/like`, undefined, b.token)).json.data).toEqual({ liked: true });
    expect((await call('GET', `/api/v1/prompts/${pack.id}`)).json.data.likeCount).toBe(1);
    expect((await call('POST', `/api/v1/prompts/${pack.id}/like`, undefined, b.token)).json.data).toEqual({ liked: false });
    expect(await call('POST', '/api/v1/prompts/00000000-0000-0000-0000-000000000000/like', undefined, b.token))
      .toMatchObject({ status: 404, json: { msg: '未找到提示词包' } });

    const list = await call('GET', '/api/v1/prompts?tags=night&size=5');
    expect(list.json.data).toMatchObject({ total: 1, page: 1, size: 5 });
    expect((await call('GET', '/api/v1/prompts?authorId=bad')).json).toMatchObject({ code: 400, msg: 'authorId 格式不正确' });
    expect((await call('GET', `/api/v1/prompts/?authorId=${b.user.id}`)).json.data.total).toBe(0);

    expect(await call('PUT', `/api/v1/prompts/${pack.id}`, { title: 'x', items: [{ name: 'n', prompt: 'p' }] }, b.token))
      .toMatchObject({ status: 403, json: { msg: '无权修改他人提示词包' } });
    const upd = await call('PUT', `/api/v1/prompts/${pack.id}`, { title: 'New', items: [{ name: 'only', prompt: 'one' }] }, a.token);
    expect(upd.json.data).toMatchObject({ title: 'New', slug: '夜雨' });
    expect(upd.json.data.items).toHaveLength(1);
    expect((await call('DELETE', `/api/v1/prompts/${pack.id}`, undefined, a.token)).json.data).toEqual({ deleted: pack.id });
    expect((await call('DELETE', `/api/v1/prompts/${pack.id}`, undefined, a.token)).status).toBe(404);

    expect(await call('GET', '/api/v1/nope')).toMatchObject({ status: 404, json: { code: 404, data: null, msg: '接口不存在' } });
    expect((await call('PATCH', '/api/v1/prompts')).status).toBe(404);
  });

  it('a token is rejected once the account is suspended or the version bumps', async () => {
    const { db, call } = makeApp();
    const reg = (await call('POST', '/api/v1/auth/register', { username: 'zed', email: 'z@x.io', password: 'pw123456' })).json.data;
    db.raw.prepare('UPDATE users SET token_version = 2 WHERE id = ?').run(reg.user.id);
    expect(await call('GET', '/api/v1/auth/me', undefined, reg.token)).toMatchObject({ status: 401, json: { msg: '登录已失效' } });
  });

  it('uploads: 503 when storage is not configured, presign/confirm with injected storage', async () => {
    const unconfigured = makeApp(null);
    const t0 = (await unconfigured.call('POST', '/api/v1/auth/register', { username: 'up0', email: 'u0@x.io', password: 'pw123456' })).json.data.token;
    expect(await unconfigured.call('POST', '/api/v1/uploads/presign', { filename: 'a.png', contentType: 'image/png' }, t0))
      .toMatchObject({ status: 503, json: { msg: '存储未配置' } });

    const heads = new Map<string, { size: number; contentType: string }>();
    const storage: UploadStorage = {
      presignPut: async (key) => `https://signed.example/${key}`,
      publicUrl: (key) => `https://cdn.example/${key}`,
      head: async (key) => heads.get(key) ?? null,
      delete: async (key) => { heads.delete(key); },
    };
    const { call } = makeApp(storage);
    expect((await call('POST', '/api/v1/uploads/presign', { filename: 'a.png', contentType: 'image/png' })).status).toBe(401);
    const t = (await call('POST', '/api/v1/auth/register', { username: 'uploader', email: 'u@x.io', password: 'pw123456' })).json.data.token;
    expect(await call('POST', '/api/v1/uploads/presign', { filename: '', contentType: 'image/png' }, t))
      .toMatchObject({ status: 400, json: { msg: 'filename 与 contentType 必填' } });
    const pre = (await call('POST', '/api/v1/uploads/presign', { filename: 'a.png', contentType: 'image/png', purpose: 'avatar', sizeBytes: 3 }, t)).json.data;
    expect(Object.keys(pre).sort()).toEqual(['expiresAt', 'key', 'publicUrl', 'putUrl']);
    expect(await call('POST', '/api/v1/uploads/confirm', { key: pre.key }, t)).toMatchObject({ status: 404 });
    heads.set(pre.key, { size: 3, contentType: 'image/png' });
    expect((await call('POST', '/api/v1/uploads/confirm', { key: pre.key }, t)).json.data).toEqual({ key: pre.key, url: `https://cdn.example/${pre.key}` });
    expect(await call('POST', '/api/v1/uploads/confirm', {}, t)).toMatchObject({ status: 400, json: { msg: 'key 必填' } });
  });

  it('internal errors are 500 with the generic message and no details', async () => {
    const { env } = makeApp();
    const res = await handleHubRequest(new Request(`${BASE}/api/v1/prompts`), { ...env, HUB_DB: undefined });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ code: 500, data: null, msg: '服务器内部错误' });
  });
});

describe('R2Storage presign (aws4fetch)', () => {
  it('produces a path-style SigV4 query-signed PUT URL with content-type signed', async () => {
    const storage = new R2Storage({
      accountId: 'acc123', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret', bucket: 'flovart-hub-uploads',
      publicBase: 'https://assets.example.com/', binding: { head: async () => null, delete: async () => {} },
    });
    const url = new URL(await storage.presignPut('uploads/avatar/u/2026/01/02/x.png', 'image/png', 900));
    expect(url.origin).toBe('https://acc123.r2.cloudflarestorage.com');
    expect(url.pathname).toBe('/flovart-hub-uploads/uploads/avatar/u/2026/01/02/x.png');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(url.searchParams.get('X-Amz-Credential')).toMatch(/^AKIDEXAMPLE\/\d{8}\/auto\/s3\/aws4_request$/);
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-type;host');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(storage.publicUrl('k/1.png')).toBe('https://assets.example.com/k/1.png');
  });
});
