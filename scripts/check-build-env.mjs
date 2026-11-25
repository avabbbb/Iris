// 生产构建环境变量检查（审计 C7 / C1，G5 + G5b）。
// 06d1647 之前：网页端认哪些扩展 ID 只来自 VITE_IRIS_EXTENSION_IDS；生产构建没设它，
// 于是 ID 列表为空，线上画布把已安装的扩展显示成「未配置」、永远配不上对。构建没有任何报错。
// 06d1647 修复后，旁加载 ID 写成常量 IRIS_SIDELOAD_EXTENSION_ID，又成了 manifest.key 的第二份副本。
//
// 规则（生产构建时由 vite.config.ts 调用，任何一条命中构建即失败；也可单独运行）：
//   B1 生效的扩展 ID 为空（VITE_IRIS_EXTENSION_IDS / 旧名回退 ∪ 源码里的旁加载 ID）
//   B2 VITE_IRIS_EXTENSION_IDS（或旧名）里有不是 32 位 a–p 的条目——运行时会被静默丢掉
//   B3 IRIS_SIDELOAD_EXTENSION_ID 与 extension/manifest.json 的 key 推导出的 ID 不一致
//   B4 环境里有 vite-env.d.ts 没声明的 VITE_IRIS_* / VITE_FLOVART_* 变量（多半是拼错，构建会静默忽略）
//
// 用法：node scripts/check-build-env.mjs [--root <dir>]   （读当前进程环境）
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXTENSION_ID_PATTERN = /^[a-p]{32}$/;

/** Chrome / Edge：扩展 ID = sha256(DER 公钥) 前 128 bit，每个十六进制位映射到 a–p。 */
export function extensionIdFromManifestKey(key) {
  const hex = createHash('sha256').update(Buffer.from(String(key), 'base64')).digest('hex').slice(0, 32);
  return [...hex].map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

export function readManifestKey(root) {
  const file = join(root, 'extension', 'manifest.json');
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8')).key ?? null;
}

/** services/extensionBridge.ts 里导出的旁加载 ID 常量（没有则为 null）。 */
export function readSideloadIdFromSource(root) {
  const file = join(root, 'services', 'extensionBridge.ts');
  if (!existsSync(file)) return null;
  const match = /export\s+const\s+IRIS_SIDELOAD_EXTENSION_ID\s*=\s*['"]([^'"]*)['"]/.exec(readFileSync(file, 'utf8'));
  return match ? match[1] : null;
}

/** vite-env.d.ts 里 ImportMetaEnv 声明的 VITE_* 名字。 */
export function declaredViteEnv(root) {
  const file = join(root, 'vite-env.d.ts');
  if (!existsSync(file)) return new Set();
  return new Set([...readFileSync(file, 'utf8').matchAll(/readonly\s+(VITE_[A-Z0-9_]+)\??\s*:/g)].map(m => m[1]));
}

export function checkBuildEnv({ env = process.env, root = process.cwd() } = {}) {
  const findings = [];
  const add = (rule, message) => findings.push({ rule, message });

  const rawIds = env.VITE_IRIS_EXTENSION_IDS || env.VITE_FLOVART_EXTENSION_IDS || '';
  const entries = String(rawIds).split(',').map(item => item.trim()).filter(Boolean);
  const invalid = entries.filter(item => !EXTENSION_ID_PATTERN.test(item));
  if (invalid.length) {
    add('B2', `VITE_IRIS_EXTENSION_IDS 里有无效的扩展 ID：${invalid.join(', ')}。扩展 ID 是 32 位 a–p，`
      + '运行时 parseExtensionIds 会静默丢掉它们，线上画布就认不出这个扩展。修法：改成商店后台显示的 32 位 ID，逗号分隔。');
  }

  const sideloadId = readSideloadIdFromSource(root);
  const effective = new Set([...entries.filter(item => EXTENSION_ID_PATTERN.test(item)), ...(sideloadId && EXTENSION_ID_PATTERN.test(sideloadId) ? [sideloadId] : [])]);
  if (effective.size === 0) {
    add('B1', '生产构建的扩展 ID 为空：网页画布会把已安装的扩展显示成「未配置」，无法配对（06d1647 之前的线上状态）。'
      + '修法：设置 VITE_IRIS_EXTENSION_IDS（商店 ID，逗号分隔），并保留 services/extensionBridge.ts 里'
      + '由 extension/manifest.json 的 key 推导出的 IRIS_SIDELOAD_EXTENSION_ID。');
  }

  const key = readManifestKey(root);
  if (key && sideloadId !== null) {
    const derived = extensionIdFromManifestKey(key);
    if (derived !== sideloadId) {
      add('B3', `services/extensionBridge.ts 的 IRIS_SIDELOAD_EXTENSION_ID（${sideloadId}）与 extension/manifest.json 的 key 推导出的 ID（${derived}）不一致。`
        + '改了 manifest key 就必须同步这个常量，否则旁加载的扩展连不上网页。修法：把常量改成推导值。');
    }
  }

  const declared = declaredViteEnv(root);
  const unknown = Object.keys(env).filter(name => /^VITE_(?:IRIS|FLOVART)_/.test(name) && !declared.has(name));
  if (unknown.length) {
    add('B4', `环境里有 vite-env.d.ts 没声明的变量：${unknown.join(', ')}。代码只读声明过的名字，这些会被静默忽略（多半是拼错）。`
      + '修法：改成已声明的名字，或在 vite-env.d.ts 的 ImportMetaEnv 里声明并在代码里使用。');
  }
  return findings;
}

export function formatFindings(findings) {
  return findings.map(f => `${f.rule} ${f.message}`).join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--root');
  const root = resolve(i >= 0 ? args[i + 1] : process.cwd());
  const findings = checkBuildEnv({ env: process.env, root });
  if (findings.length) {
    console.error(`${formatFindings(findings)}\n\nBuild env check failed: ${findings.length} finding(s).`);
    process.exit(1);
  }
  console.log('Build env check OK.');
}
