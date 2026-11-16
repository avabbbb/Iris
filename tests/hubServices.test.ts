// @vitest-environment node
// Ports of backend/service/*_test.go: auth_service_test, auth_status_test, validation_test.
import { describe, expect, it } from 'vitest';
import { asAppError } from '../server/hub/apperr';
import { hashPassword, PBKDF2_ITERATIONS, verifyJwt, verifyPassword } from '../server/hub/crypto';
import { PromptRepository, UserRepository } from '../server/hub/repository';
import {
  accountCanAuthenticate, AuthService, DUMMY_PASSWORD_HASH, buildUploadKey, normalizeContentType, normalizeInput, PromptService,
  UPLOAD_EXTENSIONS, uploadKeyOwner, UploadService, type CreateInput, type UploadStorage,
} from '../server/hub/services';
import { createTestD1 } from './fixtures/hubD1';

const SECRET = 'secret-secret-secret-secret-secret';

async function statusOf(p: Promise<unknown>): Promise<number | null> {
  try {
    await p;
    return null;
  } catch (err) {
    const e = asAppError(err);
    if (!e) throw err;
    return e.status;
  }
}

describe('AuthService (TestAuthServiceIntegration)', () => {
  it('register / login / duplicate / suspended flows', async () => {
    const db = createTestD1();
    const svc = new AuthService(new UserRepository(db), SECRET, 1);

    const reg = await svc.register('carol', 'Carol@Example.com', 'pw123456');
    expect(reg.user.email).toBe('carol@example.com');
    expect(reg.user.password.startsWith(`pbkdf2_sha256$${PBKDF2_ITERATIONS}$`)).toBe(true);
    // email stored lowercase; login lowercases too
    const login = await svc.login('CAROL@example.com', 'pw123456');
    expect(login.token).toBeTruthy();
    const claims = await verifyJwt(login.token, SECRET);
    expect(claims).toMatchObject({ sub: reg.user.id, aud: ['user'], ver: 1 });
    expect(claims!.exp! - claims!.iat!).toBe(3600);

    expect(await statusOf(svc.login('carol', 'wrong'))).toBe(401);
    expect(await statusOf(svc.login('nobody', 'x'))).toBe(401);
    expect(await statusOf(svc.register('carol', 'c2@example.com', 'pw123456'))).toBe(400);
    expect(await statusOf(svc.register('carol2', 'carol@example.com', 'pw123456'))).toBe(400);
    expect(await statusOf(svc.register('dave', 'd@example.com', 'x'.repeat(73)))).toBe(400);
    expect(await statusOf(svc.register('dave', 'd@example.com', '12345'))).toBe(400);
    expect(await statusOf(svc.register('da', 'd@example.com', 'pw123456'))).toBe(400);
    expect(await statusOf(svc.register('dave', 'not-an-email', 'pw123456'))).toBe(400);
    // 72 bytes is the cap in bytes, not characters (24 × 3-byte CJK = 72 ok, 25 = 75 rejected)
    expect(await statusOf(svc.register('erin', 'e@example.com', '密'.repeat(25)))).toBe(400);
    expect(await statusOf(svc.register('erin', 'e@example.com', '密'.repeat(24)))).toBeNull();

    // suspended: only a correct password reveals the status
    db.raw.prepare("UPDATE users SET status = 'suspended' WHERE username = 'carol'").run();
    expect(await statusOf(svc.login('carol', 'wrong'))).toBe(401);
    expect(await statusOf(svc.login('carol', 'pw123456'))).toBe(403);
  });

  it('re-hashes a password stored with fewer iterations on login', async () => {
    const db = createTestD1();
    const users = new UserRepository(db);
    const old = await hashPassword('pw123456', 1000);
    const u = await users.create({ username: 'frank', email: 'f@x.io', password: old });
    await new AuthService(users, SECRET).login('frank', 'pw123456');
    const stored = (await users.findById(u.id))!.password;
    expect(stored).not.toBe(old);
    expect(stored.startsWith(`pbkdf2_sha256$${PBKDF2_ITERATIONS}$`)).toBe(true);
    expect((await verifyPassword('pw123456', stored)).ok).toBe(true);
  });
});

describe('timing-equalising dummy hash', () => {
  it('uses the current iteration count and verifies its documented password', async () => {
    expect(DUMMY_PASSWORD_HASH.split('$')[1]).toBe(String(PBKDF2_ITERATIONS));
    expect((await verifyPassword('flovart-dummy-password', DUMMY_PASSWORD_HASH)).ok).toBe(true);
  });
});

describe('PromptService (TestPromptServiceIntegration)', () => {
  it('duplicate slug 409, bad authorId 400, delete bad id 404, foreign edit 403', async () => {
    const db = createTestD1();
    const users = new UserRepository(db);
    const u = await users.create({ username: 'erin', email: 'e@x.io', password: 'h' });
    const other = await users.create({ username: 'gina', email: 'g@x.io', password: 'h' });
    const svc = new PromptService(new PromptRepository(db));
    const input: CreateInput = { slug: 'dup', title: 't', items: [{ name: 'n', prompt: 'p' }] };
    const pack = await svc.create(u.id, input);
    expect(pack).toMatchObject({ slug: 'dup', mode: 'image', tags: [], likeCount: 0, downloadCount: 0, authorId: u.id });
    expect(pack.author).toBeUndefined();
    expect(await statusOf(svc.create(u.id, input))).toBe(409);
    expect(await statusOf(svc.list({ authorId: 'bad' }))).toBe(400);
    expect(await statusOf(svc.delete(u.id, 'nope'))).toBe(404);
    expect(await statusOf(svc.update(other.id, pack.id, { title: 'x', items: [{ name: 'n', prompt: 'p' }] }))).toBe(403);
    expect(await statusOf(svc.toggleLike(u.id, 'nope'))).toBe(404);
    const updated = await svc.update(u.id, pack.id, { slug: 'ignored', title: 'T2', items: [{ name: 'n2', prompt: 'p2' }] });
    expect(updated).toMatchObject({ slug: 'dup', title: 'T2' });
    expect(updated.items.map((i) => i.name)).toEqual(['n2']);
  });
});

describe('accountCanAuthenticate (TestAccountCanAuthenticate)', () => {
  it('active / empty authenticate, others do not', () => {
    expect(accountCanAuthenticate('active')).toBe(true);
    expect(accountCanAuthenticate('')).toBe(true);
    expect(accountCanAuthenticate(' Active ')).toBe(true);
    expect(accountCanAuthenticate('suspended')).toBe(false);
    expect(accountCanAuthenticate('deleted')).toBe(false);
  });
});

describe('normalizeInput (validation_test.go)', () => {
  it('drops client item ids and normalises fields', () => {
    const out = normalizeInput({
      slug: ' s ', title: ' T ', mode: 'bogus', tags: [' a ', 'a', ''],
      items: [{ id: 'victim-item', packId: 'victim-pack', name: ' n ', prompt: ' p ', sort: 9 }],
    }, true);
    expect(out.items[0]).toEqual({ name: 'n', prompt: 'p', sort: 0 });
    expect(out).toMatchObject({ mode: 'image', tags: ['a'], slug: 's', title: 'T' });
  });

  it('enforces limits with 400s', () => {
    const item = [{ name: 'n', prompt: 'p' }];
    const bad: CreateInput[] = [
      { slug: '', title: 't', items: item },
      { slug: 'a/b', title: 't', items: item },
      { slug: 's', title: '长'.repeat(121), items: item },
      { slug: 's', title: 't' },
      { slug: 's', title: 't', items: [{ name: ' ', prompt: 'p' }] },
      { slug: 's', title: 't', items: Array.from({ length: 201 }, () => ({ name: 'n', prompt: 'p' })) },
      { slug: 's', title: 't', items: item, tags: Array.from({ length: 21 }, (_, i) => `t${i}`) },
      { slug: 's', title: 't', items: item, tags: ['x'.repeat(33)] },
      { slug: 's', title: 't', description: 'd'.repeat(1001), items: item },
    ];
    bad.forEach((input, i) => {
      let status: number | null = null;
      try { normalizeInput(input, true); } catch (err) { status = asAppError(err)?.status ?? -1; }
      expect(status, `case ${i}`).toBe(400);
    });
    expect(() => normalizeInput({ slug: '夜雨-镜头', title: '长'.repeat(120), items: item }, true)).not.toThrow();
    // update does not check the slug
    expect(() => normalizeInput({ slug: '', title: 't', items: item }, false)).not.toThrow();
  });
});

describe('upload keys (TestUploadKeyOwnership / TestNormalizeContentTypeAndExtensions)', () => {
  const uid = '8a7b2c3d-1111-2222-3333-444455556666';
  it('builds and parses owner keys, rejects malformed ones', () => {
    const key = buildUploadKey('avatar', uid.toUpperCase(), new Date(Date.UTC(2026, 0, 2)), '0f0e0d0c-aaaa-bbbb-cccc-ddddeeeeffff', UPLOAD_EXTENSIONS['image/png']);
    expect(key).toBe(`uploads/avatar/${uid}/2026/01/02/0f0e0d0c-aaaa-bbbb-cccc-ddddeeeeffff.png`);
    expect(uploadKeyOwner(key)).toBe(uid);
    for (const k of ['', 'uploads/x.png', `other/avatar/${uid}/2026/01/02/0f0e0d0c-aaaa-bbbb-cccc-ddddeeeeffff.png`,
      `uploads/avatar/${uid}/2026/01/02/../../secret.png`]) {
      expect(uploadKeyOwner(k), k).toBeNull();
    }
  });
  it('normalises content types; every allowed type has an extension', () => {
    expect(normalizeContentType(' Image/PNG; charset=binary ')).toBe('image/png');
    for (const ext of Object.values(UPLOAD_EXTENSIONS)) expect(ext).toMatch(/^\.[a-z0-9]{2,5}$/);
  });
});

describe('UploadService', () => {
  const uid = '8a7b2c3d-1111-2222-3333-444455556666';
  function fakeStorage(head: { size: number; contentType: string } | null) {
    const deleted: string[] = [];
    const storage: UploadStorage = {
      presignPut: async (key, ct, ttl) => `https://signed.example/${key}?ct=${ct}&ttl=${ttl}`,
      publicUrl: (key) => `https://cdn.example/${key}`,
      head: async () => head,
      delete: async (key) => { deleted.push(key); },
    };
    return { storage, deleted };
  }

  it('presign validates type and size and returns the Go result shape', async () => {
    const { storage } = fakeStorage(null);
    const svc = new UploadService(storage);
    const now = new Date(Date.UTC(2026, 10, 17, 1, 0, 0));
    const res = await svc.presign(uid, { filename: 'x.html', contentType: 'image/PNG', purpose: 'Avatar', sizeBytes: 10 }, now);
    expect(res.key).toMatch(new RegExp(`^uploads/avatar/${uid}/2026/11/17/[0-9a-f-]{36}\\.png$`));
    expect(res.putUrl).toContain('ttl=900');
    expect(res.publicUrl).toBe(`https://cdn.example/${res.key}`);
    expect(res.expiresAt).toBe(Math.floor(now.getTime() / 1000) + 900);
    expect((await svc.presign(uid, { filename: 'a', contentType: 'image/png', purpose: 'weird', sizeBytes: 0 })).key).toMatch(/^uploads\/misc\//);
    expect(await statusOf(svc.presign(uid, { filename: 'a', contentType: 'text/html', purpose: '', sizeBytes: 0 }))).toBe(400);
    expect(await statusOf(svc.presign(uid, { filename: 'a', contentType: 'image/png', purpose: '', sizeBytes: -1 }))).toBe(400);
    expect(await statusOf(svc.presign(uid, { filename: 'a', contentType: 'image/png', purpose: '', sizeBytes: 21 << 20 }))).toBe(400);
    expect(await statusOf(new UploadService(null).presign(uid, { filename: 'a', contentType: 'image/png', purpose: '', sizeBytes: 0 }))).toBe(503);
  });

  it('confirm checks ownership, existence, type and size', async () => {
    const key = `uploads/avatar/${uid}/2026/01/02/0f0e0d0c-aaaa-bbbb-cccc-ddddeeeeffff.png`;
    expect(await new UploadService(fakeStorage({ size: 10, contentType: 'image/png' }).storage).confirm(uid.toUpperCase(), key))
      .toBe(`https://cdn.example/${key}`);
    expect(await statusOf(new UploadService(fakeStorage(null).storage).confirm(uid, 'bad'))).toBe(400);
    expect(await statusOf(new UploadService(fakeStorage(null).storage).confirm('11111111-1111-1111-1111-111111111111', key))).toBe(403);
    expect(await statusOf(new UploadService(fakeStorage(null).storage).confirm(uid, key))).toBe(404);
    const html = fakeStorage({ size: 10, contentType: 'text/html' });
    expect(await statusOf(new UploadService(html.storage).confirm(uid, key))).toBe(400);
    expect(html.deleted).toEqual([key]);
    const big = fakeStorage({ size: 21 << 20, contentType: 'image/png' });
    expect(await statusOf(new UploadService(big.storage).confirm(uid, key))).toBe(400);
    expect(big.deleted).toEqual([key]);
  });
});
