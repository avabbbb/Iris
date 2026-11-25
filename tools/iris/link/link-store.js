// ~/.iris/link.json：CLI 与线上 Iris 标签页的配对凭证（短期访问令牌 + 轮换 refresh）。
// 文件权限 0600、目录 0700；只存中继签发的令牌，不存模型 Key（模型 Key 永远留在用户浏览器里）。
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const LINK_FILE_VERSION = 1;

/** 与 local-agent.js 的 agentConfigPath 同一套目录约定：IRIS_LINK_FILE > IRIS_AGENT_HOME > ~/.iris。 */
export function linkFilePath(env = process.env) {
  if (env.IRIS_LINK_FILE) return resolve(env.IRIS_LINK_FILE);
  const dir = env.IRIS_AGENT_HOME ? resolve(env.IRIS_AGENT_HOME) : join(homedir(), '.iris');
  return join(dir, 'link.json');
}

export function readLink(options = {}) {
  const file = options.file || linkFilePath(options.env);
  if (!existsSync(file)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw Object.assign(new Error('~/.iris/link.json 无法读取；运行 iris logout 后重新 iris login web。'), { code: 'LINK_FILE_INVALID' });
  }
  if (!parsed || parsed.version !== LINK_FILE_VERSION || !parsed.baseUrl || !parsed.refreshToken) {
    throw Object.assign(new Error('~/.iris/link.json 格式不对；运行 iris logout 后重新 iris login web。'), { code: 'LINK_FILE_INVALID' });
  }
  return parsed;
}

/** 原子写入：先写临时文件（0600）再改名，避免中途崩溃留下半个令牌文件。 */
export function writeLink(record, options = {}) {
  const file = options.file || linkFilePath(options.env);
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const payload = JSON.stringify({ version: LINK_FILE_VERSION, ...record }, null, 2) + '\n';
  const tmp = file + '.' + process.pid + '.tmp';
  writeFileSync(tmp, payload, { mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch { /* Windows: ACL 由用户目录继承 */ }
  renameSync(tmp, file);
  try { chmodSync(file, 0o600); } catch { /* Windows */ }
  return file;
}

export function deleteLink(options = {}) {
  const file = options.file || linkFilePath(options.env);
  if (!existsSync(file)) return false;
  rmSync(file, { force: true });
  return true;
}

/** 给 status 输出用：令牌只露前缀。 */
export function redactLink(record) {
  if (!record) return null;
  const mask = value => (typeof value === 'string' && value.length > 18 ? value.slice(0, 14) + '…' : value ? '…' : null);
  return {
    baseUrl: record.baseUrl,
    roomId: record.roomId,
    clientName: record.clientName,
    scopes: record.scopes || [],
    linkedAt: record.linkedAt || null,
    accessExpiresAt: record.accessExpiresAt || null,
    refreshExpiresAt: record.refreshExpiresAt || null,
    accessToken: mask(record.accessToken),
    refreshToken: mask(record.refreshToken),
  };
}
