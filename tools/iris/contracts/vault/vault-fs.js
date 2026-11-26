// VaultFs 端口：iris.vault/1 布局之上唯一的读写入口（设计目标阶段 A1）。
//
// 分两层：
//   VaultFsBackend —— 只会「按相对路径读 / 写 / 列 / 删字节」的最小后端，每种存储一个实现：
//                     内存（本文件，测试与 OPFS 之前的兜底）、Node（./node-vault-fs.js，CLI / 本机 Agent）、
//                     FSA / OPFS（浏览器，后续 commit）。后端不懂布局，也不做秘密检查。
//   createVaultFs  —— 包一层布局规则：只允许写布局里的路径；按路径类别强制写入语义
//                     （immutable / create-only 只创建、mutable 原子替换、append 追加）；JSON 写入前做秘密扫描；
//                     blob 按内容寻址并校验 sha256。所有调用方都应经这一层，不直接碰后端。
//
// 后端契约（同一套测试跑每个实现，见 tests/vaultFs.test.ts）：
//   readBytes(path)                    → Uint8Array | null（不存在）
//   writeBytes(path, bytes, {mode})    → mode 'create'：已存在时抛 code='VAULT_EXISTS'，不得覆盖；
//                                        mode 'replace'：整文件原子替换（读者要么看到旧的、要么看到新的）
//   list(dir)                          → [{ name, kind: 'file' | 'directory' }]，目录不存在返回 []
//   remove(path)                       → boolean（是否删到了）

import { assertNoVaultSecrets, classifyVaultPath, isSha256, normalizeVaultPath, vaultPaths } from './layout.js';

export class VaultFsError extends Error {
  /** @param {string} code @param {string} message @param {Record<string, unknown>} [detail] */
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'VaultFsError';
    this.code = code;
    this.detail = detail;
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** @param {Uint8Array} left @param {Uint8Array} right */
function sameBytes(left, right) {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

/** @param {Uint8Array} bytes */
export async function sha256Hex(bytes) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** 稳定序列化：键排序、2 空格缩进、末尾换行（LF），同一内容永远得到同一字节，create-only 才能判断「同 id 同内容」。 */
export function stableJson(value) {
  const sort = (node) => {
    if (Array.isArray(node)) return node.map(sort);
    if (!node || typeof node !== 'object') return node;
    return Object.fromEntries(Object.keys(node).sort().map(key => [key, sort(node[key])]));
  };
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

/** 内存后端：测试用，也是契约的参考实现。 */
export function createMemoryVaultBackend() {
  /** @type {Map<string, Uint8Array>} */
  const files = new Map();
  return {
    kind: 'memory',
    async readBytes(path) {
      const bytes = files.get(normalizeVaultPath(path));
      return bytes ? bytes.slice() : null;
    },
    async writeBytes(path, bytes, { mode }) {
      const key = normalizeVaultPath(path);
      if (mode === 'create' && files.has(key)) throw new VaultFsError('VAULT_EXISTS', `已存在：${key}`, { path: key });
      for (const existing of files.keys()) {
        if (existing.startsWith(`${key}/`)) throw new VaultFsError('VAULT_IS_DIRECTORY', `是目录：${key}`, { path: key });
      }
      files.set(key, bytes.slice());
    },
    async list(dir) {
      const prefix = dir ? `${normalizeVaultPath(dir)}/` : '';
      const entries = new Map();
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash < 0) entries.set(rest, 'file');
        else if (!entries.has(rest.slice(0, slash))) entries.set(rest.slice(0, slash), 'directory');
      }
      return [...entries].map(([name, kind]) => ({ name, kind })).sort((a, b) => a.name.localeCompare(b.name));
    },
    async remove(path) {
      return files.delete(normalizeVaultPath(path));
    },
  };
}

/**
 * @param {{ readBytes: Function, writeBytes: Function, list: Function, remove: Function }} backend
 */
export function createVaultFs(backend) {
  const describe = (path, expectedKinds) => {
    const info = classifyVaultPath(path);
    if (!info) throw new VaultFsError('VAULT_PATH_OUTSIDE_LAYOUT', `不在 iris.vault/1 布局里的路径：${path}`, { path });
    if (expectedKinds && !expectedKinds.includes(info.kind)) {
      throw new VaultFsError('VAULT_WRONG_KIND', `${path} 是 ${info.kind}，这里只接受 ${expectedKinds.join(' / ')}`, { path, kind: info.kind });
    }
    return info;
  };

  /**
   * 按路径类别写字节。返回 'created' | 'replaced' | 'unchanged'（只创建类已存在且字节相同）。
   * @param {string} path @param {Uint8Array} bytes
   */
  async function writeByKind(path, bytes, info) {
    if (info.write === 'mutable') {
      const existed = (await backend.readBytes(path)) !== null;
      await backend.writeBytes(path, bytes, { mode: 'replace' });
      return existed ? 'replaced' : 'created';
    }
    if (info.write === 'append') throw new VaultFsError('VAULT_APPEND_ONLY', `${path} 只能追加（appendJsonLine）`, { path });
    try {
      await backend.writeBytes(path, bytes, { mode: 'create' });
      return 'created';
    } catch (error) {
      if (/** @type {any} */ (error)?.code !== 'VAULT_EXISTS') throw error;
      const existing = await backend.readBytes(path);
      if (existing && sameBytes(existing, bytes)) return 'unchanged';
      throw new VaultFsError('VAULT_IMMUTABLE_CONFLICT', `${path} 已存在且内容不同；${info.write} 文件不能改写`, { path, kind: info.kind });
    }
  }

  return {
    backend,
    async readJson(path) {
      describe(path);
      const bytes = await backend.readBytes(path);
      if (!bytes) return null;
      try {
        return JSON.parse(decoder.decode(bytes));
      } catch (error) {
        throw new VaultFsError('VAULT_JSON_INVALID', `${path} 不是合法 JSON`, { path, cause: String(error) });
      }
    },
    async writeJson(path, value) {
      const info = describe(path);
      if (info.kind === 'blob' || info.kind === 'journal-segment' || info.kind === 'timeline') {
        throw new VaultFsError('VAULT_WRONG_KIND', `${path} 不是 JSON 文档`, { path, kind: info.kind });
      }
      assertNoVaultSecrets(value, path);
      return writeByKind(path, encoder.encode(stableJson(value)), info);
    },
    /** 追加一行 JSON（单写者文件：未封口的日志段、timeline）。 */
    async appendJsonLine(path, value) {
      describe(path, ['journal-segment', 'timeline']);
      assertNoVaultSecrets(value, path);
      const line = encoder.encode(`${JSON.stringify(value)}\n`);
      const existing = await backend.readBytes(path);
      const next = new Uint8Array((existing?.byteLength || 0) + line.byteLength);
      if (existing) next.set(existing, 0);
      next.set(line, existing?.byteLength || 0);
      await backend.writeBytes(path, next, { mode: existing ? 'replace' : 'create' });
      return existing ? 'appended' : 'created';
    },
    async readJsonLines(path) {
      describe(path, ['journal-segment', 'timeline']);
      const bytes = await backend.readBytes(path);
      if (!bytes) return [];
      return decoder.decode(bytes).split('\n').filter(Boolean).map((line, index) => {
        try { return JSON.parse(line); } catch {
          throw new VaultFsError('VAULT_JSONL_INVALID', `${path} 第 ${index + 1} 行不是合法 JSON`, { path, line: index + 1 });
        }
      });
    },
    /** 内容寻址写 blob：返回 sha256；同内容重复写是幂等的。expectedSha256 给出时必须一致。 */
    async writeBlob(bytes, expectedSha256) {
      const sha256 = await sha256Hex(bytes);
      if (expectedSha256 !== undefined && (!isSha256(expectedSha256) || expectedSha256 !== sha256)) {
        throw new VaultFsError('VAULT_HASH_MISMATCH', `blob 内容的 sha256 与声明不一致`, { expected: expectedSha256, actual: sha256 });
      }
      const path = vaultPaths.blob(sha256);
      const status = await writeByKind(path, bytes, describe(path, ['blob']));
      return { sha256, path, status };
    },
    async readBlob(sha256) {
      const path = vaultPaths.blob(sha256);
      const bytes = await backend.readBytes(path);
      if (!bytes) return null;
      if ((await sha256Hex(bytes)) !== sha256) throw new VaultFsError('VAULT_BLOB_CORRUPT', `blob 内容与文件名的 sha256 不一致：${path}`, { path });
      return bytes;
    },
    async list(dir) {
      return backend.list(dir ? normalizeVaultPath(dir) : '');
    },
    async exists(path) {
      describe(path);
      return (await backend.readBytes(path)) !== null;
    },
    /** 只允许删可变文件与租约；不可变 / 只创建的文件只能经 GC 移进回收站（后续 commit）。 */
    async remove(path) {
      const info = describe(path);
      if (info.write !== 'mutable') throw new VaultFsError('VAULT_REMOVE_REFUSED', `${path}（${info.kind}）不能直接删除`, { path, kind: info.kind });
      return backend.remove(path);
    },
  };
}
