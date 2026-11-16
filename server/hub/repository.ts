/**
 * D1 repositories, ported from backend/repository (gorm → prepared SQL).
 *
 * Postgres transactions + SELECT … FOR UPDATE have no D1 equivalent across
 * awaits; instead every multi-row write goes through db.batch(), which D1 runs
 * as one atomic transaction, and D1 serialises writes per database. Where the
 * Go code relied on row locks to keep counters right (ToggleLike), the batch
 * recomputes the counter from the source rows so it can never drift.
 */
import { isUUID } from './crypto';
import type { D1Database, D1PreparedStatement } from './types';

// ---------- models (JSON shape = Go model json tags) ----------

export interface UserRow {
  id: string;
  username: string;
  email: string;
  password: string;
  bio: string;
  avatarUrl: string;
  role: string;
  status: string;
  tokenVersion: number;
  createdAt: string;
  updatedAt: string;
}

/** model.User JSON (password `json:"-"`, token_version `json:"-"`). */
export interface UserJson {
  id: string;
  username: string;
  email: string;
  bio: string;
  avatarUrl: string;
  role: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface PromptItem {
  id: string;
  packId: string;
  name: string;
  prompt: string;
  sort: number;
}

export interface PromptPack {
  id: string;
  slug: string;
  title: string;
  description: string;
  authorId: string;
  author?: UserJson;
  mode: string;
  tags: string[];
  items: PromptItem[];
  likeCount: number;
  downloadCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface PageResult<T> {
  list: T[];
  total: number;
  page: number;
  size: number;
}

/** model.Query */
export interface Query {
  keyword?: string;
  tags?: string[];
  authorId?: string;
  mode?: string;
  sort?: string; // latest | popular | downloads
  page?: number;
  size?: number;
}

export const MAX_PAGE_SIZE = 50;
export const MAX_PAGE = 1000;

/** model.Query.Normalize */
export function normalizeQuery(q: Query): Required<Pick<Query, 'page' | 'size' | 'sort'>> & Query {
  let page = q.page ?? 0;
  let size = q.size ?? 0;
  if (page <= 0) page = 1;
  if (size <= 0) size = 20;
  if (size > MAX_PAGE_SIZE) size = MAX_PAGE_SIZE;
  if (page > MAX_PAGE) page = MAX_PAGE;
  const sort = q.sort ? q.sort : 'latest';
  return { ...q, page, size, sort };
}

export class RepoNotFoundError extends Error {
  constructor() { super('prompt pack not found'); this.name = 'RepoNotFoundError'; }
}
export class RepoNotOwnerError extends Error {
  constructor() { super('prompt pack not owned by user'); this.name = 'RepoNotOwnerError'; }
}

/** True for a UNIQUE constraint violation (gorm.ErrDuplicatedKey). */
export function isDuplicateKeyError(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}

/** Go escapeLike: make LIKE wildcards literal (used with ESCAPE '\'). */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

const nowIso = () => new Date().toISOString();
/** Go zero time.Time as JSON; used for fields gorm leaves unselected on preloaded authors. */
const ZERO_TIME = '0001-01-01T00:00:00Z';

// ---------- row mapping ----------

type Row = Record<string, unknown>;
const str = (v: unknown) => (v == null ? '' : String(v));
const num = (v: unknown) => (v == null ? 0 : Number(v));

function mapUser(r: Row): UserRow {
  return {
    id: str(r.id), username: str(r.username), email: str(r.email), password: str(r.password),
    bio: str(r.bio), avatarUrl: str(r.avatar_url), role: str(r.role), status: str(r.status),
    tokenVersion: num(r.token_version), createdAt: str(r.created_at), updatedAt: str(r.updated_at),
  };
}

export function userJson(u: UserRow): UserJson {
  return {
    id: u.id, username: u.username, email: u.email, bio: u.bio, avatarUrl: u.avatarUrl,
    role: u.role, status: u.status, createdAt: u.createdAt, updatedAt: u.updatedAt,
  };
}

/**
 * Go preloads the author with Select("id","username","avatar_url","bio") so
 * private fields come out as zero values; we emit the same keys with the same
 * zero values so the JSON shape matches, and never read email/status.
 */
function publicAuthor(r: Row): UserJson {
  return {
    id: str(r.id), username: str(r.username), email: '', bio: str(r.bio), avatarUrl: str(r.avatar_url),
    role: '', status: '', createdAt: ZERO_TIME, updatedAt: ZERO_TIME,
  };
}

function parseTags(v: unknown): string[] {
  try {
    const arr = JSON.parse(str(v) || '[]');
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch {
    return [];
  }
}

function mapPack(r: Row): PromptPack {
  return {
    id: str(r.id), slug: str(r.slug), title: str(r.title), description: str(r.description),
    authorId: str(r.author_id), mode: str(r.mode), tags: parseTags(r.tags), items: [],
    likeCount: num(r.like_count), downloadCount: num(r.download_count),
    createdAt: str(r.created_at), updatedAt: str(r.updated_at),
  };
}

function mapItem(r: Row): PromptItem {
  return { id: str(r.id), packId: str(r.pack_id), name: str(r.name), prompt: str(r.prompt), sort: num(r.sort) };
}

// ---------- users ----------

export class UserRepository {
  constructor(private readonly db: D1Database) {}

  async create(input: { username: string; email: string; password: string; role?: string; status?: string; tokenVersion?: number }): Promise<UserRow> {
    const now = nowIso();
    const user: UserRow = {
      id: crypto.randomUUID(), username: input.username, email: input.email, password: input.password,
      bio: '', avatarUrl: '', role: input.role ?? 'user', status: input.status ?? 'active',
      tokenVersion: input.tokenVersion ?? 1, createdAt: now, updatedAt: now,
    };
    await this.db.prepare(
      `INSERT INTO users (id, username, email, password, bio, avatar_url, role, status, token_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(user.id, user.username, user.email, user.password, user.bio, user.avatarUrl, user.role, user.status,
      user.tokenVersion, user.createdAt, user.updatedAt).run();
    return user;
  }

  private async findOne(column: 'username' | 'email' | 'id', value: string): Promise<UserRow | null> {
    const row = await this.db.prepare(`SELECT * FROM users WHERE ${column} = ? LIMIT 1`).bind(value).first<Row>();
    return row ? mapUser(row) : null;
  }

  findByUsername(username: string) { return this.findOne('username', username); }
  findByEmail(email: string) { return this.findOne('email', email); }
  findById(id: string) {
    if (!isUUID(id)) return Promise.resolve(null);
    return this.findOne('id', id.toLowerCase());
  }

  async updatePassword(id: string, hash: string): Promise<void> {
    await this.db.prepare('UPDATE users SET password = ?, updated_at = ? WHERE id = ?').bind(hash, nowIso(), id).run();
  }

  /** Only the two columns the auth middleware needs; empty status when the user is gone. */
  async sessionState(id: string): Promise<{ status: string; tokenVersion: number }> {
    if (!isUUID(id)) return { status: '', tokenVersion: 0 };
    const row = await this.db.prepare('SELECT status, token_version FROM users WHERE id = ? LIMIT 1')
      .bind(id.toLowerCase()).first<Row>();
    if (!row) return { status: '', tokenVersion: 0 };
    return { status: str(row.status), tokenVersion: num(row.token_version) };
  }
}

// ---------- prompt packs ----------

export interface PackInput {
  slug: string;
  title: string;
  description: string;
  authorId: string;
  mode: string;
  tags: string[];
  items: Array<Pick<PromptItem, 'name' | 'prompt' | 'sort'>>;
}

export class PromptRepository {
  constructor(private readonly db: D1Database) {}

  private insertItems(packId: string, items: PackInput['items']): { stmts: D1PreparedStatement[]; rows: PromptItem[] } {
    const rows = items.map((it) => ({ id: crypto.randomUUID(), packId, name: it.name, prompt: it.prompt, sort: it.sort }));
    // One statement per row: D1 caps bound parameters at 100 per statement.
    const stmts = rows.map((r) => this.db.prepare('INSERT INTO prompt_items (id, pack_id, name, prompt, sort) VALUES (?, ?, ?, ?, ?)')
      .bind(r.id, r.packId, r.name, r.prompt, r.sort));
    return { stmts, rows };
  }

  /** Pack + items in one atomic batch; author is not written (Go: Omit(clause.Associations)). */
  async create(input: PackInput): Promise<PromptPack> {
    const now = nowIso();
    const pack: PromptPack = {
      id: crypto.randomUUID(), slug: input.slug, title: input.title, description: input.description,
      authorId: input.authorId, mode: input.mode, tags: input.tags, items: [], likeCount: 0, downloadCount: 0,
      createdAt: now, updatedAt: now,
    };
    const { stmts, rows } = this.insertItems(pack.id, input.items);
    await this.db.batch([
      this.db.prepare(
        `INSERT INTO prompt_packs (id, slug, title, description, author_id, mode, tags, like_count, download_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
      ).bind(pack.id, pack.slug, pack.title, pack.description, pack.authorId, pack.mode, JSON.stringify(pack.tags), now, now),
      ...stmts,
    ]);
    pack.items = rows;
    return pack;
  }

  /** Batch-load public authors and ordered items for packs (two IN queries, no N+1). */
  private async hydrate(packs: PromptPack[]): Promise<PromptPack[]> {
    if (packs.length === 0) return packs;
    const packIds = packs.map((p) => p.id);
    const authorIds = [...new Set(packs.map((p) => p.authorId))];
    const ph = (n: number) => Array.from({ length: n }, () => '?').join(', ');
    const [authors, items] = await this.db.batch<Row>([
      this.db.prepare(`SELECT id, username, avatar_url, bio FROM users WHERE id IN (${ph(authorIds.length)})`).bind(...authorIds),
      this.db.prepare(`SELECT * FROM prompt_items WHERE pack_id IN (${ph(packIds.length)}) ORDER BY sort ASC, id ASC`).bind(...packIds),
    ]);
    const authorById = new Map(authors.results.map((r) => [str(r.id), publicAuthor(r)]));
    const itemsByPack = new Map<string, PromptItem[]>();
    for (const r of items.results) {
      const it = mapItem(r);
      const list = itemsByPack.get(it.packId);
      if (list) list.push(it); else itemsByPack.set(it.packId, [it]);
    }
    for (const p of packs) {
      const a = authorById.get(p.authorId);
      if (a) p.author = a;
      p.items = itemsByPack.get(p.id) ?? [];
    }
    return packs;
  }

  private async findOne(column: 'id' | 'slug', value: string): Promise<PromptPack | null> {
    const row = await this.db.prepare(`SELECT * FROM prompt_packs WHERE ${column} = ? LIMIT 1`).bind(value).first<Row>();
    if (!row) return null;
    const [pack] = await this.hydrate([mapPack(row)]);
    return pack;
  }

  findById(id: string) {
    if (!isUUID(id)) return Promise.resolve(null);
    return this.findOne('id', id.toLowerCase());
  }

  findBySlug(slug: string) { return this.findOne('slug', slug); }

  /**
   * Paged list. Mirrors repository.List filter by filter:
   *  - keyword: (title ILIKE %kw% OR description ILIKE %kw%), wildcards escaped.
   *    SQLite LIKE is case-insensitive for ASCII only (Postgres ILIKE is Unicode-aware);
   *    CJK has no case, so this only differs for non-ASCII cased letters.
   *  - authorId: author_id = ? (lowercased; Postgres uuid compare is case-insensitive)
   *  - mode: mode = ?
   *  - tags: tags && ARRAY[...] (overlap) → EXISTS over json_each(tags)
   *  - total via COUNT(*); list only queried when total > 0
   *  - sort: popular → like_count DESC, downloads → download_count DESC; then created_at DESC, id DESC
   *  - OFFSET (page-1)*size LIMIT size after Normalize()
   */
  async list(query: Query): Promise<PageResult<PromptPack>> {
    const q = normalizeQuery(query);
    const where: string[] = [];
    const args: unknown[] = [];
    if (q.keyword) {
      const kw = `%${escapeLike(q.keyword)}%`;
      where.push(`(title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')`);
      args.push(kw, kw);
    }
    if (q.authorId) {
      where.push('author_id = ?');
      args.push(q.authorId.toLowerCase());
    }
    if (q.mode) {
      where.push('mode = ?');
      args.push(q.mode);
    }
    if (q.tags && q.tags.length > 0) {
      // Bound-parameter cap is 100 per statement; tag filters beyond that are not meaningful anyway.
      const tags = q.tags.slice(0, 50);
      where.push(`EXISTS (SELECT 1 FROM json_each(prompt_packs.tags) WHERE json_each.value IN (${tags.map(() => '?').join(', ')}))`);
      args.push(...tags);
    }
    const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';
    const countRow = await this.db.prepare(`SELECT COUNT(*) AS n FROM prompt_packs${whereSql}`).bind(...args).first<Row>();
    const total = num(countRow?.n);
    let list: PromptPack[] = [];
    if (total > 0) {
      let order = '';
      if (q.sort === 'popular') order = 'like_count DESC, ';
      else if (q.sort === 'downloads') order = 'download_count DESC, ';
      // secondary order keeps paging stable
      order += 'created_at DESC, id DESC';
      const res = await this.db.prepare(`SELECT * FROM prompt_packs${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`)
        .bind(...args, q.size, (q.page - 1) * q.size).all<Row>();
      list = await this.hydrate(res.results.map(mapPack));
    }
    return { list, total, page: q.page, size: q.size };
  }

  /** Go lockOwned (without the row lock — see file header). */
  private async checkOwned(id: string, authorId: string): Promise<string> {
    if (!isUUID(id)) throw new RepoNotFoundError();
    const lid = id.toLowerCase();
    const row = await this.db.prepare('SELECT author_id FROM prompt_packs WHERE id = ? LIMIT 1').bind(lid).first<Row>();
    if (!row) throw new RepoNotFoundError();
    if (str(row.author_id) !== authorId) throw new RepoNotOwnerError();
    return lid;
  }

  /** Update fields and replace all items atomically (old items are deleted, client item ids ignored). */
  async updateOwned(id: string, authorId: string, fields: Pick<PackInput, 'title' | 'description' | 'mode' | 'tags' | 'items'>): Promise<void> {
    const lid = await this.checkOwned(id, authorId);
    const { stmts } = this.insertItems(lid, fields.items);
    await this.db.batch([
      this.db.prepare('UPDATE prompt_packs SET title = ?, description = ?, mode = ?, tags = ?, updated_at = ? WHERE id = ? AND author_id = ?')
        .bind(fields.title, fields.description, fields.mode, JSON.stringify(fields.tags), nowIso(), lid, authorId),
      this.db.prepare('DELETE FROM prompt_items WHERE pack_id = ?').bind(lid),
      ...stmts,
    ]);
  }

  /** Delete likes, items and the pack in one batch (FK order). */
  async deleteOwned(id: string, authorId: string): Promise<void> {
    const lid = await this.checkOwned(id, authorId);
    await this.db.batch([
      this.db.prepare('DELETE FROM prompt_likes WHERE pack_id = ?').bind(lid),
      this.db.prepare('DELETE FROM prompt_items WHERE pack_id = ?').bind(lid),
      this.db.prepare('DELETE FROM prompt_packs WHERE id = ? AND author_id = ?').bind(lid, authorId),
    ]);
  }

  async incrementDownload(id: string): Promise<void> {
    await this.db.prepare('UPDATE prompt_packs SET download_count = download_count + 1 WHERE id = ?').bind(id.toLowerCase()).run();
  }

  /**
   * Toggle a like. Each step is one atomic batch that also recomputes
   * like_count from prompt_likes, so concurrent double-clicks can neither
   * hit a primary-key conflict (INSERT OR IGNORE) nor make the counter drift.
   */
  async toggleLike(userId: string, packId: string): Promise<boolean> {
    if (!isUUID(packId)) throw new RepoNotFoundError();
    const pid = packId.toLowerCase();
    const exists = await this.db.prepare('SELECT 1 AS x FROM prompt_packs WHERE id = ? LIMIT 1').bind(pid).first<Row>();
    if (!exists) throw new RepoNotFoundError();
    const recount = () => this.db.prepare(
      'UPDATE prompt_packs SET like_count = (SELECT COUNT(*) FROM prompt_likes WHERE pack_id = ?) WHERE id = ?',
    ).bind(pid, pid);
    const [del] = await this.db.batch([
      this.db.prepare('DELETE FROM prompt_likes WHERE user_id = ? AND pack_id = ?').bind(userId, pid),
      recount(),
    ]);
    if ((del.meta.changes ?? 0) > 0) return false;
    await this.db.batch([
      this.db.prepare('INSERT OR IGNORE INTO prompt_likes (user_id, pack_id, created_at) VALUES (?, ?, ?)').bind(userId, pid, nowIso()),
      recount(),
    ]);
    return true;
  }
}
