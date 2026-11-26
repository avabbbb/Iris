import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { vaultPaths } from '../tools/iris/contracts/vault/layout.js';
import { createMemoryVaultBackend, createVaultFs, sha256Hex } from '../tools/iris/contracts/vault/vault-fs.js';
import { createNodeVaultBackend } from '../tools/iris/contracts/vault/node-vault-fs.js';

const roots: string[] = [];
afterAll(() => roots.forEach(root => rmSync(root, { recursive: true, force: true })));

const backends: Array<[string, () => ReturnType<typeof createMemoryVaultBackend> | ReturnType<typeof createNodeVaultBackend>]> = [
  ['memory', () => createMemoryVaultBackend()],
  ['node', () => {
    const root = mkdtempSync(join(tmpdir(), 'iris-vault-'));
    roots.push(root);
    return createNodeVaultBackend(root);
  }],
];

const bytes = (text: string) => new TextEncoder().encode(text);

// 同一套契约跑每个后端（FSA / OPFS 后端加入时也挂到这里）。
describe.each(backends)('VaultFs backend contract: %s', (_name, make) => {
  it('create refuses to overwrite; replace swaps atomically; missing reads are null', async () => {
    const backend = make();
    expect(await backend.readBytes('config/preferences.json')).toBeNull();
    await backend.writeBytes('a/b.json', bytes('1'), { mode: 'create' });
    await expect(backend.writeBytes('a/b.json', bytes('2'), { mode: 'create' })).rejects.toMatchObject({ code: 'VAULT_EXISTS' });
    expect(new TextDecoder().decode((await backend.readBytes('a/b.json'))!)).toBe('1');
    await backend.writeBytes('a/b.json', bytes('3'), { mode: 'replace' });
    expect(new TextDecoder().decode((await backend.readBytes('a/b.json'))!)).toBe('3');
  });

  it('only one of many concurrent creators of the same path wins', async () => {
    const backend = make();
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => backend.writeBytes('x/once.json', bytes(String(i)), { mode: 'create' })));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected').every(result => (result as PromiseRejectedResult).reason.code === 'VAULT_EXISTS')).toBe(true);
  });

  it('lists a directory one level deep and removes files', async () => {
    const backend = make();
    await backend.writeBytes('d/one.json', bytes('1'), { mode: 'create' });
    await backend.writeBytes('d/sub/two.json', bytes('2'), { mode: 'create' });
    await backend.writeBytes('d/one.json', bytes('1b'), { mode: 'replace' });
    expect(await backend.list('d')).toEqual([{ name: 'one.json', kind: 'file' }, { name: 'sub', kind: 'directory' }]);
    expect(await backend.list('missing')).toEqual([]);
    expect(await backend.remove('d/one.json')).toBe(true);
    expect(await backend.remove('d/one.json')).toBe(false);
  });

  it('rejects traversal before touching storage', async () => {
    const backend = make();
    await expect(backend.writeBytes('../escape.json', bytes('x'), { mode: 'replace' })).rejects.toThrow();
    await expect(backend.readBytes('/etc/passwd')).rejects.toThrow();
  });
});

describe.each(backends)('createVaultFs layout rules over %s', (_name, make) => {
  it('writes only paths in the layout, with the write mode of their kind', async () => {
    const vault = createVaultFs(make());
    await expect(vault.writeJson('notes/x.json', {})).rejects.toMatchObject({ code: 'VAULT_PATH_OUTSIDE_LAYOUT' });

    // mutable：替换
    expect(await vault.writeJson(vaultPaths.preferences(), { theme: 'dark' })).toBe('created');
    expect(await vault.writeJson(vaultPaths.preferences(), { theme: 'light' })).toBe('replaced');
    expect(await vault.readJson(vaultPaths.preferences())).toEqual({ theme: 'light' });

    // create-only：同 id 同内容幂等，同 id 不同内容拒绝（inbox 信封重投天然幂等）
    const envelope = { mutationId: 'm1', command: 'workflow.apply', args: { b: 1, a: 2 } };
    expect(await vault.writeJson(vaultPaths.inbox('p1', 'm1'), envelope)).toBe('created');
    expect(await vault.writeJson(vaultPaths.inbox('p1', 'm1'), { args: { a: 2, b: 1 }, command: 'workflow.apply', mutationId: 'm1' })).toBe('unchanged');
    await expect(vault.writeJson(vaultPaths.inbox('p1', 'm1'), { ...envelope, args: { a: 3 } })).rejects.toMatchObject({ code: 'VAULT_IMMUTABLE_CONFLICT' });

    // append：只能追加
    await expect(vault.writeJson(vaultPaths.journalSegment('p1', 'w1', 0), {})).rejects.toMatchObject({ code: 'VAULT_WRONG_KIND' });
    expect(await vault.appendJsonLine(vaultPaths.journalSegment('p1', 'w1', 0), { seq: 0 })).toBe('created');
    expect(await vault.appendJsonLine(vaultPaths.journalSegment('p1', 'w1', 0), { seq: 1 })).toBe('appended');
    expect(await vault.readJsonLines(vaultPaths.journalSegment('p1', 'w1', 0))).toEqual([{ seq: 0 }, { seq: 1 }]);

    // 不可变 / 只创建的文件不能直接删
    await expect(vault.remove(vaultPaths.inbox('p1', 'm1'))).rejects.toMatchObject({ code: 'VAULT_REMOVE_REFUSED' });
    expect(await vault.remove(vaultPaths.preferences())).toBe(true);
  });

  it('refuses to write secrets into any vault file', async () => {
    const vault = createVaultFs(make());
    await expect(vault.writeJson(vaultPaths.service('svc_1'), { schema: 'iris.service/1', apiKey: 'k' })).rejects.toMatchObject({ code: 'VAULT_SECRET_REJECTED' });
    await expect(vault.appendJsonLine(vaultPaths.timeline('p1'), { headers: { authorization: 'x' } })).rejects.toMatchObject({ code: 'VAULT_SECRET_REJECTED' });
    expect(await vault.exists(vaultPaths.service('svc_1'))).toBe(false);
    expect(await vault.writeJson(vaultPaths.service('svc_1'), { schema: 'iris.service/1', secretRef: 'svc_1' })).toBe('created');
  });

  it('stores blobs content-addressed, idempotently, and verifies hashes', async () => {
    const vault = createVaultFs(make());
    const data = bytes('png-bytes');
    const sha = await sha256Hex(data);
    expect(await vault.writeBlob(data)).toEqual({ sha256: sha, path: vaultPaths.blob(sha), status: 'created' });
    expect((await vault.writeBlob(data, sha)).status).toBe('unchanged');
    await expect(vault.writeBlob(bytes('other'), sha)).rejects.toMatchObject({ code: 'VAULT_HASH_MISMATCH' });
    expect(new TextDecoder().decode((await vault.readBlob(sha))!)).toBe('png-bytes');
    // 被篡改的 blob 读出时报错，不静默返回
    await vault.backend.writeBytes(vaultPaths.blob(sha), bytes('tampered'), { mode: 'replace' });
    await expect(vault.readBlob(sha)).rejects.toMatchObject({ code: 'VAULT_BLOB_CORRUPT' });
  });
});

describe('node backend specifics', () => {
  it('leaves no temp files behind after replace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'iris-vault-'));
    roots.push(root);
    const vault = createVaultFs(createNodeVaultBackend(root));
    for (let i = 0; i < 5; i += 1) await vault.writeJson(vaultPaths.snapshot('p1'), { revision: i });
    expect(readdirSync(join(root, 'projects', 'p1'))).toEqual(['snapshot.json']);
    expect(await vault.readJson(vaultPaths.snapshot('p1'))).toEqual({ revision: 4 });
  });
});
