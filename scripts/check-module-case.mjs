#!/usr/bin/env node
// 模块名大小写碰撞检查（审计 C2 / G1）。
// Linux 区分大小写，Windows / macOS 默认不区分：`agentConversationNav.ts` 与 `AgentConversationNav.tsx`
// 在 Linux 上是两个模块，在 Windows / macOS 上 `import './agentConversationNav'` 会解析到另一个文件，
// 打包与 tsc 都会失败（e933c60 修复，Windows / macOS 构建红了 5 天）。
//
// 规则：
//   M1 任意两个被跟踪的路径只差大小写 —— 在不区分大小写的文件系统上根本签不出来
//   M2 同一目录下去掉扩展名后只差大小写的源码模块（.ts/.tsx/.js/.jsx/.mjs/.cjs/.mts/.cts）——
//      无扩展名 import 在不同平台解析到不同文件。（同名同大小写、只差扩展名的不算，如 tests/offlineShell.test.ts / .tsx）
//
// 用法：node scripts/check-module-case.mjs [--root <dir>] [--rev <git-rev>]
//   --rev 直接检查某个历史 commit 的文件树（不需要签出），用于证明护栏能抓到历史错误。
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const root = resolve(opt('--root') ?? process.cwd());
const rev = opt('--rev');

const files = (rev
  ? execFileSync('git', ['ls-tree', '-r', '-z', '--name-only', rev], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  : execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }))
  .split('\0').filter(Boolean);

const findings = [];
const group = (keyOf, list) => {
  const map = new Map();
  for (const item of list) {
    const key = keyOf(item);
    if (key === undefined) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
};

for (const paths of group(f => f.toLowerCase(), files).values()) {
  if (paths.length > 1) findings.push({ rule: 'M1', paths, message: '路径只差大小写，在 Windows / macOS 上无法同时签出。修法：改名其中一个。' });
}

const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const stem = f => f.replace(SOURCE, '');
for (const paths of group(f => (SOURCE.test(f) ? stem(f).toLowerCase() : undefined), files).values()) {
  const stems = new Set(paths.map(stem));
  if (stems.size > 1) {
    findings.push({
      rule: 'M2', paths,
      message: '去掉扩展名后只差大小写：无扩展名 import 在不区分大小写的文件系统上会解析到另一个文件。'
        + '修法：给其中一个换一个不同的名字（例如纯逻辑加 Model 后缀：agentConversationNav.ts → agentConversationNavModel.ts，e933c60）。',
    });
  }
}

if (findings.length) {
  for (const f of findings) console.error(`${f.rule} ${f.paths.join('  <->  ')}\n    ${f.message}`);
  console.error(`\nModule case check failed${rev ? ` at ${rev}` : ''}: ${findings.length} finding(s).`);
  process.exit(1);
}
console.log(`Module case check OK${rev ? ` at ${rev}` : ''}: ${files.length} files.`);
