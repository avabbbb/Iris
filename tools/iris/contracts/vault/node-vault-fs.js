// VaultFs 的 Node 后端（CLI / 本机 Agent 服务）。契约见 ./vault-fs.js。
// - create：open(..., 'wx')，内核保证「不存在才创建」，并发两个创建者只有一个成功。
// - replace：同目录写临时文件后 rename，读者要么看到旧文件、要么看到新文件。
// - 所有路径先经 normalizeVaultPath，再确认解析结果仍在 Vault 根之内。

import { mkdir, open, readFile, readdir, rename, rm, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { normalizeVaultPath } from './layout.js';
import { VaultFsError } from './vault-fs.js';

/** @param {string} root */
export function createNodeVaultBackend(root) {
  const base = path.resolve(root);
  const resolve = (relative) => {
    const normalized = normalizeVaultPath(relative);
    const absolute = path.resolve(base, ...normalized.split('/'));
    if (absolute !== base && !absolute.startsWith(base + path.sep)) {
      throw new VaultFsError('VAULT_PATH_ESCAPE', `路径越出 Vault 根：${relative}`, { path: relative });
    }
    return absolute;
  };

  return {
    kind: 'node',
    root: base,
    async readBytes(relative) {
      try {
        return new Uint8Array(await readFile(resolve(relative)));
      } catch (error) {
        if (/** @type {any} */ (error)?.code === 'ENOENT') return null;
        if (/** @type {any} */ (error)?.code === 'EISDIR') throw new VaultFsError('VAULT_IS_DIRECTORY', `是目录：${relative}`, { path: relative });
        throw error;
      }
    },
    async writeBytes(relative, bytes, { mode }) {
      const target = resolve(relative);
      await mkdir(path.dirname(target), { recursive: true });
      if (mode === 'create') {
        let handle;
        try {
          handle = await open(target, 'wx');
        } catch (error) {
          if (/** @type {any} */ (error)?.code === 'EEXIST') throw new VaultFsError('VAULT_EXISTS', `已存在：${relative}`, { path: relative });
          throw error;
        }
        try {
          await handle.writeFile(bytes);
          await handle.sync();
        } catch (error) {
          await handle.close().catch(() => {});
          await unlink(target).catch(() => {});
          throw error;
        }
        await handle.close();
        return;
      }
      const temp = path.join(path.dirname(target), `.${path.basename(target)}.${randomBytes(6).toString('hex')}.tmp`);
      const handle = await open(temp, 'wx');
      try {
        await handle.writeFile(bytes);
        await handle.sync();
        await handle.close();
        await rename(temp, target);
      } catch (error) {
        await handle.close().catch(() => {});
        await rm(temp, { force: true }).catch(() => {});
        throw error;
      }
    },
    async list(relative) {
      const dir = relative ? resolve(relative) : base;
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        return entries
          .filter(entry => !(entry.isFile() && entry.name.startsWith('.') && entry.name.endsWith('.tmp')))
          .map(entry => ({ name: entry.name, kind: entry.isDirectory() ? 'directory' : 'file' }))
          .sort((a, b) => a.name.localeCompare(b.name));
      } catch (error) {
        if (/** @type {any} */ (error)?.code === 'ENOENT') return [];
        throw error;
      }
    },
    async remove(relative) {
      try {
        await unlink(resolve(relative));
        return true;
      } catch (error) {
        if (/** @type {any} */ (error)?.code === 'ENOENT') return false;
        throw error;
      }
    },
  };
}
