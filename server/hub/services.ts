/**
 * Business logic ported from backend/service (auth, prompt, upload).
 * Validation rules and error messages are kept verbatim from the Go code.
 */
import { AppError, appErr } from './apperr';
import { hashPassword, isUUID, PBKDF2_ITERATIONS, signJwt, verifyPassword } from './crypto';
import {
  isDuplicateKeyError, PromptRepository, RepoNotFoundError, RepoNotOwnerError, UserRepository,
  type PageResult, type PromptPack, type Query, type UserRow,
} from './repository';

// ======================= auth =======================

export function accountCanAuthenticate(status: string): boolean {
  const s = status.trim().toLowerCase();
  return s === '' || s === 'active';
}

// Go limits (bcrypt only hashed the first 72 bytes). Kept for API compatibility even though PBKDF2 has no such cap.
const MIN_PASSWORD_LEN = 6;
const MAX_PASSWORD_LEN = 72;
const byteLen = (s: string) => new TextEncoder().encode(s).length;

const USERNAME_RE = /^[A-Za-z0-9_]{3,32}$/;
// Go RE2 \s = [\t\n\f\r ]; spelled out so JS's wider \s does not change what is accepted.
const EMAIL_RE = /^[^\t\n\f\r @]+@[^\t\n\f\r @]+\.[^\t\n\f\r @]+$/;
export const validUsername = (v: string) => USERNAME_RE.test(v);
export const validEmail = (v: string) => EMAIL_RE.test(v);

const errInvalidCredentials = () => appErr.unauthorized('账号或密码错误');

/**
 * Hash checked when the account does not exist, so response time does not reveal
 * which accounts exist. Precomputed (password "flovart-dummy-password") rather than
 * hashed at startup, so a fresh isolate never pays for two PBKDF2 runs in one
 * request. Its iteration count must equal PBKDF2_ITERATIONS (asserted in tests).
 */
export const DUMMY_PASSWORD_HASH = 'pbkdf2_sha256$30000$olVKbuXIsWcO28OcuodkdA==$oQJBpM2SF2bADnEnkuEAzMEvLe4wuFMB9ua+8wK+exA=';

export class AuthService {
  readonly expHours: number;
  constructor(private readonly users: UserRepository, private readonly jwtSecret: string, expHours?: number) {
    this.expHours = expHours && expHours > 0 ? expHours : 168;
  }

  async register(usernameRaw: string, emailRaw: string, password: string): Promise<{ user: UserRow; token: string }> {
    const username = usernameRaw.trim();
    const email = emailRaw.trim().toLowerCase();
    if (!validUsername(username)) throw appErr.badRequest('用户名只能含字母数字下划线，3-32 位');
    if (!validEmail(email)) throw appErr.badRequest('邮箱格式不正确');
    if (byteLen(password) < MIN_PASSWORD_LEN) throw appErr.badRequest('密码至少 6 位');
    if (byteLen(password) > MAX_PASSWORD_LEN) throw appErr.badRequest('密码不能超过 72 字节');
    if (await this.users.findByUsername(username)) throw appErr.badRequest('用户名已存在');
    if (await this.users.findByEmail(email)) throw appErr.badRequest('邮箱已注册');
    const hash = await hashPassword(password);
    let user: UserRow;
    try {
      user = await this.users.create({ username, email, password: hash, role: 'user', status: 'active', tokenVersion: 1 });
    } catch (err) {
      // concurrent registration of the same name/email: unique index is the backstop
      if (isDuplicateKeyError(err)) throw appErr.badRequest('用户名或邮箱已存在');
      throw err;
    }
    return { user, token: await this.issueToken(user) };
  }

  async login(identifierRaw: string, password: string): Promise<{ user: UserRow; token: string }> {
    const identifier = identifierRaw.trim();
    // emails are stored lowercase at registration
    const user = validEmail(identifier)
      ? await this.users.findByEmail(identifier.toLowerCase())
      : await this.users.findByUsername(identifier);
    if (!user) {
      await verifyPassword(password, DUMMY_PASSWORD_HASH);
      throw errInvalidCredentials();
    }
    // check the password before revealing account status
    const check = await verifyPassword(password, user.password);
    if (!check.ok) throw errInvalidCredentials();
    if (!accountCanAuthenticate(user.status)) throw appErr.forbidden('账号已停用，请联系平台管理员');
    if (check.needsRehash) {
      // PBKDF2_ITERATIONS was raised since this hash was made: upgrade it now (best effort).
      try { await this.users.updatePassword(user.id, await hashPassword(password, PBKDF2_ITERATIONS)); } catch (err) {
        console.warn('hub: password rehash failed', err);
      }
    }
    return { user, token: await this.issueToken(user) };
  }

  async issueToken(user: UserRow, nowSec = Math.floor(Date.now() / 1000)): Promise<string> {
    return signJwt({ ver: user.tokenVersion, sub: user.id, aud: [user.role], exp: nowSec + this.expHours * 3600, iat: nowSec }, this.jwtSecret);
  }

  getUserById(id: string) { return this.users.findById(id); }
}

// ======================= prompts =======================

export interface CreateInput {
  slug?: string;
  title?: string;
  description?: string;
  mode?: string;
  tags?: string[] | null;
  items?: Array<{ id?: string; packId?: string; name?: string; prompt?: string; sort?: number }> | null;
}

export interface NormalizedInput {
  slug: string;
  title: string;
  description: string;
  mode: string;
  tags: string[];
  items: Array<{ name: string; prompt: string; sort: number }>;
}

const MAX_SLUG_LEN = 80;
const MAX_TITLE_LEN = 120;
const MAX_DESCRIPTION_LEN = 1000;
const MAX_ITEM_NAME_LEN = 120;
const MAX_ITEM_PROMPT_LEN = 20000;
const MAX_ITEMS = 200;
const MAX_TAGS = 20;
const MAX_TAG_LEN = 32;

/** utf8.RuneCountInString */
const runeLen = (s: string) => [...s].length;
const SLUG_FORBIDDEN = /[/?#%\\ \t\r\n]/;

/** Go normalizeInput; slug is only checked on create (it cannot change on update). */
export function normalizeInput(raw: CreateInput, checkSlug: boolean): NormalizedInput {
  const slug = (raw.slug ?? '').trim();
  const title = (raw.title ?? '').trim();
  const description = (raw.description ?? '').trim();
  if (checkSlug) {
    if (slug === '') throw appErr.badRequest('slug 不能为空');
    if (runeLen(slug) > MAX_SLUG_LEN || SLUG_FORBIDDEN.test(slug)) {
      throw appErr.badRequest('slug 不能超过 80 个字符，且不能包含空白或 / ? # % \\');
    }
  }
  if (title === '') throw appErr.badRequest('标题不能为空');
  if (runeLen(title) > MAX_TITLE_LEN) throw appErr.badRequest('标题不能超过 120 个字符');
  if (runeLen(description) > MAX_DESCRIPTION_LEN) throw appErr.badRequest('描述不能超过 1000 个字符');
  const mode = raw.mode === 'image' || raw.mode === 'video' || raw.mode === 'text' ? raw.mode : 'image';
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const t0 of raw.tags ?? []) {
    const t = String(t0).trim();
    if (t === '' || seen.has(t)) continue;
    if (runeLen(t) > MAX_TAG_LEN) throw appErr.badRequest('单个标签不能超过 32 个字符');
    seen.add(t);
    tags.push(t);
  }
  if (tags.length > MAX_TAGS) throw appErr.badRequest('标签不能超过 20 个');
  const rawItems = raw.items ?? [];
  if (rawItems.length === 0) throw appErr.badRequest('至少包含一条提示词');
  if (rawItems.length > MAX_ITEMS) throw appErr.badRequest('单个提示词包最多 200 条提示词');
  const items = rawItems.map((it, i) => {
    const name = (it?.name ?? '').trim();
    const prompt = (it?.prompt ?? '').trim();
    if (name === '' || prompt === '') throw appErr.badRequest('提示词条目名称和内容不能为空');
    if (runeLen(name) > MAX_ITEM_NAME_LEN || runeLen(prompt) > MAX_ITEM_PROMPT_LEN) {
      throw appErr.badRequest('提示词条目名称不能超过 120 字、内容不能超过 20000 字');
    }
    // only content fields survive: client-sent id / packId are dropped
    return { name, prompt, sort: i };
  });
  return { slug, title, description, mode, tags, items };
}

function mapRepoErr(err: unknown): unknown {
  if (err instanceof RepoNotFoundError) return appErr.notFound('未找到提示词包');
  if (err instanceof RepoNotOwnerError) return appErr.forbidden('无权修改他人提示词包');
  return err;
}

export class PromptService {
  constructor(private readonly packs: PromptRepository) {}

  async create(authorId: string, raw: CreateInput): Promise<PromptPack> {
    const input = normalizeInput(raw, true);
    if (await this.packs.findBySlug(input.slug)) throw appErr.conflict('slug 已存在');
    try {
      return await this.packs.create({ ...input, authorId });
    } catch (err) {
      if (isDuplicateKeyError(err)) throw appErr.conflict('slug 已存在');
      throw err;
    }
  }

  async list(q: Query): Promise<PageResult<PromptPack>> {
    if (q.authorId && !isUUID(q.authorId)) throw appErr.badRequest('authorId 格式不正确');
    return this.packs.list(q);
  }

  get(id: string) { return this.packs.findById(id); }
  getBySlug(slug: string) { return this.packs.findBySlug(slug); }
  incrementDownload(id: string) { return this.packs.incrementDownload(id); }

  async toggleLike(userId: string, packId: string): Promise<boolean> {
    try { return await this.packs.toggleLike(userId, packId); } catch (err) { throw mapRepoErr(err); }
  }

  async update(authorId: string, id: string, raw: CreateInput): Promise<PromptPack> {
    const input = normalizeInput(raw, false);
    try {
      await this.packs.updateOwned(id, authorId, input);
    } catch (err) {
      throw mapRepoErr(err);
    }
    const pack = await this.packs.findById(id);
    if (!pack) throw appErr.notFound('未找到提示词包');
    return pack;
  }

  async delete(authorId: string, id: string): Promise<void> {
    try { await this.packs.deleteOwned(id, authorId); } catch (err) { throw mapRepoErr(err); }
  }
}

// ======================= uploads =======================

export interface UploadStorage {
  presignPut(key: string, contentType: string, ttlSec: number): Promise<string>;
  publicUrl(key: string): string;
  head(key: string): Promise<{ size: number; contentType: string } | null>;
  delete(key: string): Promise<void>;
}

export interface PresignInput {
  filename: string;
  contentType: string;
  purpose: string;
  sizeBytes: number;
}

export interface PresignResult {
  key: string;
  putUrl: string;
  publicUrl: string;
  expiresAt: number;
}

/** MIME allowlist (blocks text/html etc. stored XSS); extension derives from MIME, never from the filename. */
export const UPLOAD_EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/mp4': '.m4a',
  'application/pdf': '.pdf',
};
const isAllowedType = (ct: string) => Object.prototype.hasOwnProperty.call(UPLOAD_EXTENSIONS, ct);

const MB = 1 << 20;
export function uploadSizeLimit(contentType: string): number {
  if (contentType.startsWith('image/')) return 20 * MB;
  if (contentType.startsWith('video/')) return 500 * MB;
  if (contentType.startsWith('audio/')) return 100 * MB;
  return 50 * MB;
}

const UPLOAD_KEY_RE = /^uploads\/([a-z_]+)\/([0-9a-f-]{36})\/\d{4}\/\d{2}\/\d{2}\/[0-9a-f-]{36}\.[a-z0-9]{2,5}$/;
export const PRESIGN_TTL_SEC = 15 * 60;

export function normalizeContentType(ct: string): string {
  const i = ct.indexOf(';');
  return (i >= 0 ? ct.slice(0, i) : ct).trim().toLowerCase();
}

export function sanitizePurpose(p: string): string {
  const v = p.trim().toLowerCase();
  return v === 'prompt_cover' || v === 'workflow_showcase' || v === 'avatar' || v === 'workflow_media' ? v : 'misc';
}

export function buildUploadKey(purpose: string, uploaderId: string, now: Date, id: string, ext: string): string {
  const y = String(now.getUTCFullYear()).padStart(4, '0');
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `uploads/${purpose}/${uploaderId.toLowerCase()}/${y}/${m}/${d}/${id}${ext}`;
}

/** Returns the uploader id embedded in a well-formed key, or null. */
export function uploadKeyOwner(key: string): string | null {
  const m = UPLOAD_KEY_RE.exec(key);
  return m ? m[2] : null;
}

export class UploadService {
  constructor(private readonly storage: UploadStorage | null) {}

  private ready(): UploadStorage {
    if (!this.storage) throw appErr.new(503, '存储未配置');
    return this.storage;
  }

  async presign(uploaderId: string, input: PresignInput, now = new Date()): Promise<PresignResult> {
    const storage = this.ready();
    const contentType = normalizeContentType(input.contentType);
    if (!isAllowedType(contentType)) throw appErr.badRequest(`不支持的文件类型：${input.contentType}`);
    if (input.sizeBytes < 0) throw appErr.badRequest('文件大小不合法');
    const limit = uploadSizeLimit(contentType);
    if (input.sizeBytes > limit) throw appErr.badRequest(`文件大小超过上限（${limit / MB}MB）`);
    const key = buildUploadKey(sanitizePurpose(input.purpose), uploaderId, now, crypto.randomUUID(), UPLOAD_EXTENSIONS[contentType]);
    let putUrl: string;
    try {
      putUrl = await storage.presignPut(key, contentType, PRESIGN_TTL_SEC);
    } catch (err) {
      throw new Error(`presign put: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { key, putUrl, publicUrl: storage.publicUrl(key), expiresAt: Math.floor(now.getTime() / 1000) + PRESIGN_TTL_SEC };
  }

  /** Key must belong to the caller, exist, have an allowed type and be within the size limit. */
  async confirm(uploaderId: string, key: string): Promise<string> {
    const storage = this.ready();
    const owner = uploadKeyOwner(key);
    if (!owner) throw appErr.badRequest('key 格式不正确');
    if (owner !== uploaderId.toLowerCase()) throw appErr.forbidden('无权确认该上传');
    let head: { size: number; contentType: string } | null;
    try {
      head = await storage.head(key);
    } catch {
      head = null;
    }
    if (!head) throw appErr.notFound('对象不存在或尚未上传完成');
    const contentType = normalizeContentType(head.contentType);
    if (!isAllowedType(contentType)) {
      await storage.delete(key).catch(() => {});
      throw appErr.badRequest('文件类型不合法，已拒绝');
    }
    if (head.size > uploadSizeLimit(contentType)) {
      await storage.delete(key).catch(() => {}); // best effort
      throw appErr.badRequest('文件大小超过上限，已拒绝');
    }
    return storage.publicUrl(key);
  }
}

export { AppError };
