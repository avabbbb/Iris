import { describe, expect, it } from 'vitest';
import {
  VAULT_FORMAT,
  assertNoVaultSecrets,
  classifyVaultPath,
  findVaultSecrets,
  formatJournalSeq,
  normalizeVaultPath,
  parseVaultManifest,
  vaultPaths,
} from '../tools/iris/contracts/vault/layout.js';

const SHA = 'ab'.repeat(32);

describe('iris.vault/1 layout', () => {
  it('builds every path from validated ids and classifies it back with its write mode', () => {
    const cases: Array<[string, string, string]> = [
      [vaultPaths.manifest(), 'vault-manifest', 'create-only'],
      [vaultPaths.device('dev-1'), 'device', 'mutable'],
      [vaultPaths.lease('p1', 'w1'), 'lease', 'mutable'],
      [vaultPaths.trash('2026-11-27', 'projects/p1/snapshot.json'), 'trash', 'immutable'],
      [vaultPaths.service('svc_openai'), 'service', 'mutable'],
      [vaultPaths.preferences(), 'preferences', 'mutable'],
      [vaultPaths.project('p1'), 'project', 'mutable'],
      [vaultPaths.snapshot('p1'), 'snapshot', 'mutable'],
      [vaultPaths.journalSegment('p1', 'w1', 7), 'journal-segment', 'append'],
      [vaultPaths.inbox('p1', 'm-1'), 'inbox', 'create-only'],
      [vaultPaths.receipt('p1', 'm-1'), 'receipt', 'create-only'],
      [vaultPaths.conflict('p1', 'c-1'), 'conflict', 'create-only'],
      [vaultPaths.timeline('p1'), 'timeline', 'append'],
      [vaultPaths.blob(SHA), 'blob', 'immutable'],
      [vaultPaths.artifact('art_1'), 'artifact', 'create-only'],
    ];
    for (const [path, kind, write] of cases) {
      expect(classifyVaultPath(path), path).toMatchObject({ kind, write });
    }
    expect(vaultPaths.journalSegment('p1', 'w1', 7)).toBe('projects/p1/journal/w1/00000007.jsonl');
    expect(classifyVaultPath(vaultPaths.journalSegment('p1', 'w1', 7))).toMatchObject({ projectId: 'p1', writerId: 'w1', seq: 7 });
    expect(vaultPaths.blob(SHA)).toBe(`assets/blobs/sha256/ab/ab/${SHA}`);
  });

  it('marks leases and trash as device-local, never synced; agent sessions have no path in v1', () => {
    expect(classifyVaultPath(vaultPaths.lease('p1', 'w1'))?.synced).toBe(false);
    expect(classifyVaultPath(vaultPaths.trash('2026-11-27', 'assets/artifacts/a.json'))?.synced).toBe(false);
    expect(classifyVaultPath('projects/p1/agent/sessions/s1.jsonl')).toBeNull();
    expect(classifyVaultPath('projects/p1/agent/memory.jsonl')).toBeNull();
  });

  it('rejects traversal, absolute paths, Windows-illegal ids and paths outside the layout', () => {
    for (const bad of ['../etc/passwd', '/abs/x', 'C:/x', 'projects//p1/project.json', 'projects/./p1/project.json']) {
      expect(() => normalizeVaultPath(bad), bad).toThrow();
      expect(classifyVaultPath(bad), bad).toBeNull();
    }
    for (const badId of ['..', '.hidden', 'a/b', 'a\\b', 'flovart:gpt-image-2', 'con', 'NUL.txt', 'trailing.', '', 'x'.repeat(129)]) {
      expect(() => vaultPaths.project(badId), badId).toThrow(/非法的 projectId/);
    }
    expect(classifyVaultPath('notes/readme.md')).toBeNull();
    expect(classifyVaultPath('projects/p1/journal/w1/7.jsonl')).toBeNull();
    // blob 目录前缀必须与 sha256 一致
    expect(classifyVaultPath(`assets/blobs/sha256/cd/ef/${SHA}`)).toBeNull();
    expect(() => vaultPaths.blob('ABC')).toThrow();
    expect(() => formatJournalSeq(-1)).toThrow();
    expect(() => formatJournalSeq(1.5)).toThrow();
    expect(() => vaultPaths.trash('2026-11-27', '.iris/vault.json')).toThrow();
  });

  it('parses vault.json strictly and refuses vaults that need a newer reader', () => {
    const good = { format: VAULT_FORMAT, vaultId: 'v_1', createdAt: '2026-11-27T00:00:00.000Z', minReaderVersion: 1 };
    expect(parseVaultManifest(good)).toEqual({ ok: true, value: good });
    expect(parseVaultManifest({ ...good, minReaderVersion: 2 })).toMatchObject({ ok: false });
    expect(parseVaultManifest({ ...good, format: 'iris.vault/2' })).toMatchObject({ ok: false });
    expect(parseVaultManifest({ ...good, extra: 1 })).toMatchObject({ ok: false, issues: ['未知字段：extra'] });
    expect(parseVaultManifest([])).toMatchObject({ ok: false });
  });
});

describe('vault secret scan', () => {
  it('rejects secret field names and secret-looking values anywhere in the tree', () => {
    const findings = findVaultSecrets({
      name: 'svc',
      apiKey: 'whatever',
      nested: [{ 'api-key': 'x' }, { headers: { Authorization: 'Bearer abc' } }],
      s3: { secretAccessKey: 'y', accessKeyId: 'z', sessionToken: 't' },
      note: 'leaked sk-abcdefghijklmnopqrstuvwxyz012345 here',
      gh: 'ghp_abcdefghijklmnopqrstuvwxyz0123',
      pem: '-----BEGIN PRIVATE KEY-----',
      aws: 'AKIAABCDEFGHIJKLMNOP',
    });
    expect(findings.map(item => item.path).sort()).toEqual([
      'apiKey', 'aws', 'gh', 'nested[0].api-key', 'nested[1].headers.Authorization', 'note', 'pem',
      's3.accessKeyId', 's3.secretAccessKey', 's3.sessionToken',
    ].sort());
    expect(() => assertNoVaultSecrets({ password: 'p' }, 'config/services/x.json')).toThrow(/拒绝把秘密写进 Vault（config\/services\/x\.json）：password/);
  });

  it('does not flag look-alike fields that are not secrets', () => {
    expect(findVaultSecrets({
      secretRef: 'svc_openai',
      maxOutputTokens: 4096,
      storageKey: 'media/1',
      routeId: 'rh/seedance',
      pricing: { rules: [{ unit: 'input_token', rate: 1 }] },
      tokenizer: 'cl100k',
      emptyToken: { token: '' },
      prompt: 'a skeleton key on a table',
    })).toEqual([]);
  });
});
