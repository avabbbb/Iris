// iris.vault/1 —— Iris Vault 文件夹布局契约（file over app，设计目标阶段 A1）。
//
// 一份用户选的文件夹就是 Iris 的记忆 / 真相；网页（FSA / OPFS）、本地部署、CLI 都按这份布局读写。
// 这里只定义「路径长什么样、每类文件怎么写、哪些内容不许进 Vault」，不做 I/O（I/O 见 ./vault-fs.js）。
// 浏览器代码与 CLI（Node ESM，随 @flovart/cli 的 contracts/ 发布）共用本文件，所以保持纯 JS、无 DOM / fs 依赖。
//
// 布局（相对 Vault 根）：
//   .iris/vault.json                                  {format, vaultId, createdAt, minReaderVersion}
//   .iris/devices/<deviceId>.json                     设备名、最近在线（不含秘密）
//   .iris/leases/<projectId>/<writerId>.json          应用者心跳；只用于减少冲突，正确性不依赖它
//   .iris/trash/<yyyy-mm-dd>/<原相对路径>              GC 先移到这里，保留 30 天
//   config/services/<serviceId>.json                  iris.service/1 清单（不含 Key）
//   config/preferences.json                           非秘密偏好
//   projects/<projectId>/project.json                 {id,title,createdAt,formatVersion}
//   projects/<projectId>/snapshot.json                派生缓存（可从日志重建）
//   projects/<projectId>/journal/<writerId>/<seq:08>.jsonl   追加日志段；封口后不可变
//   projects/<projectId>/inbox/<mutationId>.json      待应用的命令信封（只创建）
//   projects/<projectId>/receipts/<mutationId>.json   应用结果（只创建）
//   projects/<projectId>/conflicts/<conflictId>.json  节点级冲突记录（只创建）
//   projects/<projectId>/timeline.jsonl               生成结果事件（单写者 = 应用者）
//   assets/blobs/sha256/<ab>/<cd>/<sha256>            内容寻址、不可变
//   assets/artifacts/<artifactId>.json                Artifact 持久形态（只创建）
//
// 写入语义（决定 VaultFs 的 create / replace，以及 S3 的 If-None-Match / If-Match）：
//   immutable    —— 内容寻址或已封口：只创建，已存在且内容相同视为成功
//   create-only  —— 以稳定 id 命名的一次性记录：只创建，已存在即幂等（同 id 不得换内容）
//   mutable      —— 可变文件：整文件原子替换（S3 上 If-Match CAS）
//   append       —— 追加文件（timeline.jsonl / 未封口日志段）：单写者
//
// Agent 会话 / 记忆（agent/）按 2026-11-27 用户决定**不进同步**，本版布局不定义其路径（阶段 G 另议）。

export const VAULT_FORMAT = 'iris.vault/1';
export const VAULT_READER_VERSION = 1;
export const JOURNAL_SEQ_WIDTH = 8;
export const JOURNAL_SEGMENT_MAX_LINES = 500;
export const LEASE_TTL_MS = 30_000;
export const TRASH_RETENTION_DAYS = 30;
export const SNAPSHOT_WARN_BYTES = 5 * 1024 * 1024;

/** id 段：文件 / 目录名里的一段。只允许跨平台安全字符，不允许 `.` 开头、路径分隔符、`..`、Windows 保留名。 */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.@~-]{0,127}$/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const SHA256 = /^[a-f0-9]{64}$/;

export class VaultPathError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'VaultPathError';
    this.code = 'VAULT_PATH_INVALID';
    this.detail = detail;
  }
}

/** @param {string} kind @param {unknown} value @returns {string} */
export function assertVaultSegment(kind, value) {
  // ':' 在 Windows 文件名里非法：带 ':' 的 id（如模型 id flovart:gpt-image-2）不能直接当文件名。
  if (typeof value !== 'string' || !SEGMENT.test(value) || value.endsWith('.') || WINDOWS_RESERVED.test(value)) {
    throw new VaultPathError(`非法的 ${kind}：${JSON.stringify(value)}`, { kind, value });
  }
  return value;
}

/** @param {unknown} value */
export function isSha256(value) {
  return typeof value === 'string' && SHA256.test(value);
}

/** @param {number} seq */
export function formatJournalSeq(seq) {
  if (!Number.isSafeInteger(seq) || seq < 0 || seq >= 10 ** JOURNAL_SEQ_WIDTH) {
    throw new VaultPathError(`非法的日志段序号：${seq}`, { kind: 'seq', value: seq });
  }
  return String(seq).padStart(JOURNAL_SEQ_WIDTH, '0');
}

const project = (projectId) => `projects/${assertVaultSegment('projectId', projectId)}`;

/** 只拼路径、只校验 id；所有 Vault 路径都应从这里来，不要手写字符串。 */
export const vaultPaths = Object.freeze({
  manifest: () => '.iris/vault.json',
  device: (deviceId) => `.iris/devices/${assertVaultSegment('deviceId', deviceId)}.json`,
  lease: (projectId, writerId) => `.iris/leases/${assertVaultSegment('projectId', projectId)}/${assertVaultSegment('writerId', writerId)}.json`,
  trash: (day, relativePath) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new VaultPathError(`非法的回收站日期：${day}`, { kind: 'day', value: day });
    const inner = normalizeVaultPath(relativePath);
    if (inner.startsWith('.iris/')) throw new VaultPathError('不能把 .iris/ 下的文件移进回收站', { kind: 'trash', value: relativePath });
    return `.iris/trash/${day}/${inner}`;
  },
  service: (serviceId) => `config/services/${assertVaultSegment('serviceId', serviceId)}.json`,
  preferences: () => 'config/preferences.json',
  project: (projectId) => `${project(projectId)}/project.json`,
  snapshot: (projectId) => `${project(projectId)}/snapshot.json`,
  journalDir: (projectId, writerId) => `${project(projectId)}/journal/${assertVaultSegment('writerId', writerId)}`,
  journalSegment: (projectId, writerId, seq) => `${project(projectId)}/journal/${assertVaultSegment('writerId', writerId)}/${formatJournalSeq(seq)}.jsonl`,
  inbox: (projectId, mutationId) => `${project(projectId)}/inbox/${assertVaultSegment('mutationId', mutationId)}.json`,
  receipt: (projectId, mutationId) => `${project(projectId)}/receipts/${assertVaultSegment('mutationId', mutationId)}.json`,
  conflict: (projectId, conflictId) => `${project(projectId)}/conflicts/${assertVaultSegment('conflictId', conflictId)}.json`,
  timeline: (projectId) => `${project(projectId)}/timeline.jsonl`,
  blob: (sha256) => {
    if (!isSha256(sha256)) throw new VaultPathError(`非法的 sha256：${sha256}`, { kind: 'sha256', value: sha256 });
    return `assets/blobs/sha256/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;
  },
  artifact: (artifactId) => `assets/artifacts/${assertVaultSegment('artifactId', artifactId)}.json`,
});

/**
 * 规范化一个 Vault 相对路径：统一 `/`，拒绝绝对路径、盘符、`..`、空段与 `.` 段。
 * @param {unknown} input
 * @returns {string}
 */
export function normalizeVaultPath(input) {
  if (typeof input !== 'string' || !input) throw new VaultPathError('Vault 路径不能为空', { value: input });
  const path = input.replace(/\\/g, '/');
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) throw new VaultPathError(`Vault 路径必须是相对路径：${input}`, { value: input });
  const parts = path.split('/');
  if (parts.some(part => part === '' || part === '.' || part === '..')) {
    throw new VaultPathError(`Vault 路径含空段、. 或 ..：${input}`, { value: input });
  }
  return parts.join('/');
}

/**
 * @typedef {'vault-manifest'|'device'|'lease'|'trash'|'service'|'preferences'|'project'|'snapshot'|'journal-segment'|'inbox'|'receipt'|'conflict'|'timeline'|'blob'|'artifact'} VaultFileKind
 * @typedef {'immutable'|'create-only'|'mutable'|'append'} VaultWriteMode
 * @typedef {{ kind: VaultFileKind, write: VaultWriteMode, synced: boolean, projectId?: string, writerId?: string, seq?: number, id?: string }} VaultPathInfo
 */

const SEGMENT_SRC = '[A-Za-z0-9][A-Za-z0-9_.@~-]{0,127}';
/** @type {Array<[RegExp, (m: RegExpMatchArray) => VaultPathInfo]>} */
const CLASSIFIERS = [
  [/^\.iris\/vault\.json$/, () => ({ kind: 'vault-manifest', write: 'create-only', synced: true })],
  [new RegExp(`^\\.iris/devices/(${SEGMENT_SRC})\\.json$`), m => ({ kind: 'device', write: 'mutable', synced: true, id: m[1] })],
  [new RegExp(`^\\.iris/leases/(${SEGMENT_SRC})/(${SEGMENT_SRC})\\.json$`), m => ({ kind: 'lease', write: 'mutable', synced: false, projectId: m[1], writerId: m[2] })],
  [/^\.iris\/trash\/\d{4}-\d{2}-\d{2}\/.+$/, () => ({ kind: 'trash', write: 'immutable', synced: false })],
  [new RegExp(`^config/services/(${SEGMENT_SRC})\\.json$`), m => ({ kind: 'service', write: 'mutable', synced: true, id: m[1] })],
  [/^config\/preferences\.json$/, () => ({ kind: 'preferences', write: 'mutable', synced: true })],
  [new RegExp(`^projects/(${SEGMENT_SRC})/project\\.json$`), m => ({ kind: 'project', write: 'mutable', synced: true, projectId: m[1] })],
  [new RegExp(`^projects/(${SEGMENT_SRC})/snapshot\\.json$`), m => ({ kind: 'snapshot', write: 'mutable', synced: true, projectId: m[1] })],
  [new RegExp(`^projects/(${SEGMENT_SRC})/journal/(${SEGMENT_SRC})/(\\d{${JOURNAL_SEQ_WIDTH}})\\.jsonl$`), m => ({ kind: 'journal-segment', write: 'append', synced: true, projectId: m[1], writerId: m[2], seq: Number(m[3]) })],
  [new RegExp(`^projects/(${SEGMENT_SRC})/inbox/(${SEGMENT_SRC})\\.json$`), m => ({ kind: 'inbox', write: 'create-only', synced: true, projectId: m[1], id: m[2] })],
  [new RegExp(`^projects/(${SEGMENT_SRC})/receipts/(${SEGMENT_SRC})\\.json$`), m => ({ kind: 'receipt', write: 'create-only', synced: true, projectId: m[1], id: m[2] })],
  [new RegExp(`^projects/(${SEGMENT_SRC})/conflicts/(${SEGMENT_SRC})\\.json$`), m => ({ kind: 'conflict', write: 'create-only', synced: true, projectId: m[1], id: m[2] })],
  [new RegExp(`^projects/(${SEGMENT_SRC})/timeline\\.jsonl$`), m => ({ kind: 'timeline', write: 'append', synced: true, projectId: m[1] })],
  [/^assets\/blobs\/sha256\/([a-f0-9]{2})\/([a-f0-9]{2})\/([a-f0-9]{64})$/, m => ({ kind: 'blob', write: 'immutable', synced: true, id: m[3] })],
  [new RegExp(`^assets/artifacts/(${SEGMENT_SRC})\\.json$`), m => ({ kind: 'artifact', write: 'create-only', synced: true, id: m[1] })],
];

/**
 * 把 Vault 相对路径归类；不在布局里的路径返回 null（写入器应拒绝写它们）。
 * blob 路径还要求前两级目录与 sha256 前缀一致。
 * @param {string} input
 * @returns {VaultPathInfo | null}
 */
export function classifyVaultPath(input) {
  let path;
  try { path = normalizeVaultPath(input); } catch { return null; }
  for (const [pattern, describe] of CLASSIFIERS) {
    const match = path.match(pattern);
    if (!match) continue;
    if (pattern.source.startsWith('^assets\\/blobs') && (match[1] !== match[3].slice(0, 2) || match[2] !== match[3].slice(2, 4))) return null;
    return describe(match);
  }
  return null;
}

/**
 * vault.json 的校验（不依赖 zod，CLI 与浏览器共用）。
 * @param {unknown} value
 * @returns {{ ok: true, value: { format: string, vaultId: string, createdAt: string, minReaderVersion: number } } | { ok: false, issues: string[] }}
 */
export function parseVaultManifest(value) {
  const issues = [];
  const record = value && typeof value === 'object' && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : null;
  if (!record) return { ok: false, issues: ['vault.json 必须是对象'] };
  if (record.format !== VAULT_FORMAT) issues.push(`format 必须是 ${VAULT_FORMAT}`);
  try { assertVaultSegment('vaultId', record.vaultId); } catch { issues.push('vaultId 非法'); }
  if (typeof record.createdAt !== 'string' || Number.isNaN(Date.parse(record.createdAt))) issues.push('createdAt 必须是 ISO 时间');
  if (!Number.isSafeInteger(record.minReaderVersion) || /** @type {number} */ (record.minReaderVersion) < 1) issues.push('minReaderVersion 必须是正整数');
  else if (/** @type {number} */ (record.minReaderVersion) > VAULT_READER_VERSION) issues.push(`此 Vault 需要更新的 Iris（minReaderVersion ${record.minReaderVersion} > ${VAULT_READER_VERSION}）`);
  const known = new Set(['format', 'vaultId', 'createdAt', 'minReaderVersion', 'migratedFrom']);
  for (const key of Object.keys(record)) if (!known.has(key)) issues.push(`未知字段：${key}`);
  const secrets = findVaultSecrets(record);
  for (const finding of secrets) issues.push(`秘密不得进入 Vault：${finding.path}（${finding.reason}）`);
  if (issues.length) return { ok: false, issues };
  return { ok: true, value: /** @type {any} */ ({ ...record }) };
}

// ── 秘密扫描 ─────────────────────────────────────────────────────────────────
// Vault 会被同步到 S3、被外部 Agent 读取：任何秘密都不得写进去（AGENTS §5）。
// 键名规则：规范化（小写、去掉 - _ 空格）后**整名**命中才算，避免误伤 maxOutputTokens、storageKey 这类字段；
// `secretRef` 是保险库条目 id（不是秘密本身），显式放行。
// 值规则：与 scripts/release-secret-audit.mjs 的检测器同一组（改一处要同步另一处）。

const SECRET_KEY_NAMES = new Set([
  'apikey', 'xapikey', 'apisecret', 'secret', 'secretkey', 'clientsecret', 'secretaccesskey', 'accesskeyid', 'accesskey',
  'token', 'accesstoken', 'refreshtoken', 'idtoken', 'authtoken', 'bearertoken', 'sessiontoken', 'bootstraptoken', 'pairingtoken',
  'password', 'passwd', 'passphrase', 'authorization', 'privatekey', 'cookie', 'credential', 'credentials',
]);
const ALLOWED_KEY_NAMES = new Set(['secretref']);
const SECRET_VALUE_DETECTORS = [
  { id: 'private-key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { id: 'github-token', pattern: /\b(?:ghp|gho|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { id: 'cloud-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'openai-style-key', pattern: /\bsk-[A-Za-z0-9_-]{24,}\b/ },
  { id: 'literal-bearer', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/i },
];

const normalizeKeyName = (key) => key.toLowerCase().replace(/[-_\s]/g, '');

/** @param {string} key */
export function isSecretFieldName(key) {
  const name = normalizeKeyName(key);
  return !ALLOWED_KEY_NAMES.has(name) && SECRET_KEY_NAMES.has(name);
}

/**
 * 深度扫描一个将要写进 Vault 的 JSON 值，返回所有疑似秘密的位置。
 * @param {unknown} value
 * @returns {Array<{ path: string, reason: string }>}
 */
export function findVaultSecrets(value) {
  /** @type {Array<{ path: string, reason: string }>} */
  const findings = [];
  const seen = new WeakSet();
  const visit = (node, path) => {
    if (typeof node === 'string') {
      for (const detector of SECRET_VALUE_DETECTORS) {
        if (detector.pattern.test(node)) { findings.push({ path: path || '$', reason: `value:${detector.id}` }); break; }
      }
      return;
    }
    if (!node || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) { node.forEach((item, index) => visit(item, `${path}[${index}]`)); return; }
    for (const [key, child] of Object.entries(node)) {
      const childPath = path ? `${path}.${key}` : key;
      if (isSecretFieldName(key) && child !== undefined && child !== null && child !== '') {
        findings.push({ path: childPath, reason: 'field-name' });
        continue;
      }
      visit(child, childPath);
    }
  };
  visit(value, '');
  return findings;
}

export class VaultSecretError extends Error {
  /** @param {Array<{ path: string, reason: string }>} findings @param {string} [target] */
  constructor(findings, target) {
    super(`拒绝把秘密写进 Vault${target ? `（${target}）` : ''}：${findings.map(item => item.path).join(', ')}`);
    this.name = 'VaultSecretError';
    this.code = 'VAULT_SECRET_REJECTED';
    this.findings = findings;
  }
}

/** @param {unknown} value @param {string} [target] */
export function assertNoVaultSecrets(value, target) {
  const findings = findVaultSecrets(value);
  if (findings.length) throw new VaultSecretError(findings, target);
}
