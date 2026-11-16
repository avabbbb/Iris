// @vitest-environment node
// Port of backend/repository/prompt_repository_test.go (TestPromptRepositoryIntegration),
// run against the real D1 migrations on an in-memory SQLite (tests/fixtures/hubD1.ts).
import { beforeEach, describe, expect, it } from 'vitest';
import {
  escapeLike, normalizeQuery, PromptRepository, RepoNotFoundError, RepoNotOwnerError, UserRepository, type UserRow,
} from '../server/hub/repository';
import { createTestD1, type TestD1 } from './fixtures/hubD1';

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

describe('hub repositories (D1)', () => {
  let db: TestD1;
  let users: UserRepository;
  let repo: PromptRepository;
  let alice: UserRow;
  let bob: UserRow;

  const seedUser = (name: string) => users.create({ username: name, email: `${name}@x.io`, password: 'h', status: 'active', tokenVersion: 1 });
  const count = (sql: string, ...args: string[]) => Number((db.raw.prepare(sql).get(...args) as { n: number }).n);

  beforeEach(async () => {
    db = createTestD1();
    users = new UserRepository(db);
    repo = new PromptRepository(db);
    alice = await seedUser('alice');
    bob = await seedUser('bob');
  });

  async function seedPacks() {
    const pack = await repo.create({
      slug: 'rain', title: '100% rain_shot', description: '', authorId: alice.id, mode: 'video', tags: ['rain', 'night'],
      items: [{ name: 'a', prompt: 'pa', sort: 0 }, { name: 'b', prompt: 'pb', sort: 1 }],
    });
    const other = await repo.create({
      slug: 'sun', title: 'sunny', description: '', authorId: bob.id, mode: 'image', tags: [],
      items: [{ name: 'victim', prompt: 'keep me', sort: 0 }],
    });
    return { pack, other };
  }

  it('1. round-trips tags (JSON array column) and ordered items', async () => {
    const { pack } = await seedPacks();
    const got = await repo.findById(pack.id);
    expect(got).not.toBeNull();
    expect(got!.tags).toEqual(['rain', 'night']);
    expect(got!.items.map((i) => i.name)).toEqual(['a', 'b']);
    expect(got!.items[0].packId).toBe(pack.id);
    expect(await repo.findById(pack.id.toUpperCase())).not.toBeNull();
    expect((await repo.findBySlug('rain'))?.id).toBe(pack.id);
  });

  it('2. public queries never leak the author email', async () => {
    const { pack } = await seedPacks();
    const got = await repo.findById(pack.id);
    expect(JSON.stringify(got)).not.toContain('alice@x.io');
    expect(got!.author).toMatchObject({ id: alice.id, username: 'alice', email: '', role: '', status: '' });
  });

  it('3. a malformed UUID is "not found", not an error', async () => {
    expect(await repo.findById('not-a-uuid')).toBeNull();
    expect(await users.findById('not-a-uuid')).toBeNull();
  });

  it('4. list: tag overlap, literal wildcards in keyword, non-null items', async () => {
    const { pack } = await seedPacks();
    let res = await repo.list({ tags: ['night'] });
    expect(res.total).toBe(1);
    expect(res.list[0].id).toBe(pack.id);
    expect(res.list[0].items).toHaveLength(2);
    expect((await repo.list({ tags: ['nope', 'rain'] })).total).toBe(1);
    expect((await repo.list({ keyword: '%' })).total).toBe(1);
    expect((await repo.list({ keyword: '_' })).total).toBe(1);
    expect((await repo.list({ keyword: 'SUNNY' })).total).toBe(1); // ILIKE → case-insensitive (ASCII)
    expect((await repo.list({ mode: 'image' })).list.map((p) => p.slug)).toEqual(['sun']);
    expect((await repo.list({ authorId: alice.id.toUpperCase() })).total).toBe(1);
    res = await repo.list({});
    expect(res).toMatchObject({ total: 2, page: 1, size: 20 });
    expect(res.list.every((p) => Array.isArray(p.items))).toBe(true);
    const empty = await repo.list({ keyword: 'zzz' });
    expect(empty).toEqual({ list: [], total: 0, page: 1, size: 20 });
  });

  it('4b. list: sort orders, stable secondary order and paging', async () => {
    const { pack, other } = await seedPacks();
    db.raw.prepare('UPDATE prompt_packs SET like_count = 5, download_count = 0 WHERE id = ?').run(other.id);
    db.raw.prepare('UPDATE prompt_packs SET like_count = 1, download_count = 9 WHERE id = ?').run(pack.id);
    expect((await repo.list({ sort: 'popular' })).list.map((p) => p.slug)).toEqual(['sun', 'rain']);
    expect((await repo.list({ sort: 'downloads' })).list.map((p) => p.slug)).toEqual(['rain', 'sun']);
    // latest = created_at DESC, id DESC (both created in the same ms → id breaks the tie deterministically)
    const latest = (await repo.list({ sort: 'latest' })).list.map((p) => p.id);
    const sorted = [pack, other].sort((a, b) => (b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))).map((p) => p.id);
    expect(latest).toEqual(sorted);
    const p1 = await repo.list({ size: 1, page: 1 });
    const p2 = await repo.list({ size: 1, page: 2 });
    expect(p1.total).toBe(2);
    expect(p1.list[0].id).not.toBe(p2.list[0].id);
    expect((await repo.list({ size: 1, page: 3 })).list).toEqual([]);
  });

  it('5. update replaces items wholesale, rejects non-owners, leaves other packs alone', async () => {
    const { pack, other } = await seedPacks();
    await expect(repo.updateOwned(pack.id, bob.id, { title: 'x', description: '', mode: 'image', tags: [], items: [] }))
      .rejects.toBeInstanceOf(RepoNotOwnerError);
    await repo.updateOwned(pack.id, alice.id, { title: 'new', description: '', mode: 'image', tags: ['x'], items: [{ name: 'only', prompt: 'one', sort: 0 }] });
    const got = await repo.findById(pack.id);
    expect(got!.title).toBe('new');
    expect(got!.items.map((i) => i.name)).toEqual(['only']);
    expect(got!.tags).toEqual(['x']);
    const victim = await repo.findById(other.id);
    expect(victim!.items).toHaveLength(1);
    expect(victim!.items[0].prompt).toBe('keep me');
    await expect(repo.updateOwned('nope', alice.id, { title: 'x', description: '', mode: 'image', tags: [], items: [] }))
      .rejects.toBeInstanceOf(RepoNotFoundError);
  });

  it('6. concurrent like toggles keep like_count consistent', async () => {
    const { pack } = await seedPacks();
    await Promise.all(Array.from({ length: 8 }, () => repo.toggleLike(bob.id, pack.id)));
    const likes = count('SELECT COUNT(*) AS n FROM prompt_likes WHERE pack_id = ?', pack.id);
    expect((await repo.findById(pack.id))!.likeCount).toBe(likes);
    await expect(repo.toggleLike(bob.id, ZERO_UUID)).rejects.toBeInstanceOf(RepoNotFoundError);
    await expect(repo.toggleLike(bob.id, 'bad')).rejects.toBeInstanceOf(RepoNotFoundError);
    const liked = await repo.toggleLike(bob.id, pack.id);
    expect(liked).toBe(likes === 0);
    expect((await repo.findById(pack.id))!.likeCount).toBe(liked ? 1 : 0);
    expect(await repo.toggleLike(alice.id, pack.id)).toBe(true);
  });

  it('7. delete removes items and likes too, rejects non-owners, second delete is not found', async () => {
    const { pack } = await seedPacks();
    await repo.toggleLike(bob.id, pack.id);
    await expect(repo.deleteOwned(pack.id, bob.id)).rejects.toBeInstanceOf(RepoNotOwnerError);
    await repo.deleteOwned(pack.id, alice.id);
    expect(count('SELECT COUNT(*) AS n FROM prompt_items WHERE pack_id = ?', pack.id)).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM prompt_likes WHERE pack_id = ?', pack.id)).toBe(0);
    await expect(repo.deleteOwned(pack.id, alice.id)).rejects.toBeInstanceOf(RepoNotFoundError);
  });

  it('8. sessionState', async () => {
    expect(await users.sessionState(alice.id)).toEqual({ status: 'active', tokenVersion: 1 });
    expect(await users.sessionState(ZERO_UUID)).toEqual({ status: '', tokenVersion: 0 });
    expect(await users.sessionState('garbage')).toEqual({ status: '', tokenVersion: 0 });
  });

  it('create is atomic: a failing item insert leaves no pack behind', async () => {
    await expect(repo.create({
      slug: 'boom', title: 't', description: '', authorId: alice.id, mode: 'image', tags: [],
      // null prompt violates NOT NULL on the 2nd statement of the batch
      items: [{ name: 'a', prompt: null as unknown as string, sort: 0 }],
    })).rejects.toThrow();
    expect(await repo.findBySlug('boom')).toBeNull();
  });

  it('unique indexes back up the service-level duplicate checks', async () => {
    await expect(seedUser('alice')).rejects.toThrow(/UNIQUE constraint failed/);
    await seedPacks();
    await expect(repo.create({ slug: 'rain', title: 't', description: '', authorId: alice.id, mode: 'image', tags: [], items: [] }))
      .rejects.toThrow(/UNIQUE constraint failed/);
  });

  it('download counter increments', async () => {
    const { pack } = await seedPacks();
    await repo.incrementDownload(pack.id);
    await repo.incrementDownload(pack.id);
    expect((await repo.findById(pack.id))!.downloadCount).toBe(2);
  });
});

describe('query helpers', () => {
  it('normalizeQuery mirrors model.Query.Normalize', () => {
    expect(normalizeQuery({})).toMatchObject({ page: 1, size: 20, sort: 'latest' });
    expect(normalizeQuery({ page: -3, size: 0 })).toMatchObject({ page: 1, size: 20 });
    expect(normalizeQuery({ page: 5000, size: 999, sort: 'popular' })).toMatchObject({ page: 1000, size: 50, sort: 'popular' });
  });
  it('escapeLike escapes backslash, % and _', () => {
    expect(escapeLike('a\\b%c_d')).toBe('a\\\\b\\%c\\_d');
  });
});
