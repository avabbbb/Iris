#!/usr/bin/env node
// 跨平台可移植性检查（审计 C2）。Agent 的沙箱是 Linux，CI 只在 windows-latest 上跑，
// 下面这些写法在 Linux 上能过、在 Windows / macOS 上才挂，所以在 push 之前就拦住。
//
// 规则（每条错误信息都直接给出修法和对应的历史 commit）：
//   P1 测试里断言 POSIX 权限位（`.mode & 0o777`）却没有 win32 守卫 —— 77ba337 tests/linkCli.test.ts:205
//   P2 Miniflare 只给 scriptPath 不给 modulesRoot —— 77ba337 tests/linkRelay.test.ts（模块名带 `..`，workerd 拒绝启动）
//   P3 换行：索引里有 CRLF，或文本文件签出时不是 eol=lf —— 4c2c321（*.sql / *.rs 在 Windows 签出成 CRLF，逐字节比较失败）
//
// 用法：node scripts/check-portability.mjs [--root <dir>] [--json]
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const args = process.argv.slice(2);
const rootIndex = args.indexOf('--root');
const root = resolve(rootIndex >= 0 ? args[rootIndex + 1] : process.cwd());
const asJson = args.includes('--json');

const git = (gitArgs, input) => execFileSync('git', gitArgs, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, input });
const tracked = git(['ls-files', '-z']).split('\0').filter(Boolean);
const findings = [];
const add = (rule, file, line, message) => findings.push({ rule, file, line, message });

const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
// 共享 helper 自己就是守卫实现。
const P1_ALLOW = new Set(['tests/helpers/fileMode.ts']);

for (const file of tracked) {
  if (!SOURCE.test(file) || file.startsWith('third_party/') || file.includes('node_modules/')) continue;
  let text;
  try { text = readFileSync(join(root, file), 'utf8'); } catch { continue; }
  const lines = text.split(/\r?\n/);

  // P1：只查测试文件（生产代码里写 0o600 是正确的意图，断言权限位才是平台相关的）。
  const isTest = file.startsWith('tests/') || /\.test\.[cm]?[jt]sx?$/.test(file);
  if (isTest && !P1_ALLOW.has(file)) {
    lines.forEach((line, i) => {
      if (!/\.mode\s*\)?\s*&\s*0o?777/.test(line)) return;
      const context = lines.slice(Math.max(0, i - 3), i + 1).join('\n');
      if (/win32|skipIf|runIf/.test(context)) return;
      add('P1', file, i + 1, '测试断言 POSIX 权限位，Windows 上 chmod 只能切只读位，stat 永远是 0o666。'
        + '修法：用 tests/helpers/fileMode.ts 的 expectOwnerOnlyFile(file)（POSIX 仍严格要求 0600），'
        + "或加 `if (process.platform !== 'win32')` 守卫；不要放宽 POSIX 上的断言。（77ba337 linkCli.test.ts:205）");
    });
  }

  // P2：new Miniflare({ … scriptPath … }) 必须同时给 modulesRoot。
  const re = /new\s+Miniflare\s*\(/g;
  let m;
  while ((m = re.exec(text))) {
    let depth = 0, end = m.index + m[0].length - 1;
    for (let j = end; j < text.length; j += 1) {
      if (text[j] === '(') depth += 1;
      else if (text[j] === ')') { depth -= 1; if (depth === 0) { end = j; break; } }
    }
    const call = text.slice(m.index, end + 1);
    if (/\bscriptPath\s*:/.test(call) && !/\bmodulesRoot\s*:/.test(call)) {
      const line = text.slice(0, m.index).split('\n').length;
      add('P2', file, line, 'Miniflare 只给了 scriptPath：模块名按 path.relative(cwd, scriptPath) 计算，'
        + '脚本在系统临时目录时会带 `..`（或跨盘符的绝对路径），Windows 上 workerd 报 "can\'t use \\"..\\" to break out of starting directory"。'
        + '修法：同时设 modulesRoot 为脚本所在目录（或改用 modules: [{ type, path, contents }]）。（77ba337 linkRelay.test.ts）');
    }
  }
}

// P3a：索引里不能有 CRLF。
for (const row of git(['ls-files', '--eol', '-z']).split('\0').filter(Boolean)) {
  const match = /^i\/(\S+)\s+w\/\S*\s+attr\/[^\t]*\t(.+)$/.exec(row);
  if (match && (match[1] === 'crlf' || match[1] === 'mixed')) {
    add('P3', match[2], 0, `索引里是 ${match[1]} 换行。修法：转成 LF（.editorconfig 规定 LF），git add --renormalize .`);
  }
}

// P3b：git 视为文本的文件，签出时必须是 eol=lf（否则 Windows 的 core.autocrlf 会改成 CRLF）。
const attrRows = git(['check-attr', '-z', '--stdin', 'text', 'eol', 'binary'], tracked.join('\0')).split('\0');
const attrs = new Map();
for (let i = 0; i + 2 < attrRows.length; i += 3) {
  const [file, attr, value] = attrRows.slice(i, i + 3);
  if (!attrs.has(file)) attrs.set(file, {});
  attrs.get(file)[attr] = value;
}
const textInIndex = new Set();
for (const row of git(['ls-files', '--eol', '-z']).split('\0').filter(Boolean)) {
  const match = /^i\/(\S+)\s+w\/\S*\s+attr\/[^\t]*\t(.+)$/.exec(row);
  if (match && match[1] !== '-text' && match[1] !== 'none') textInIndex.add(match[2]);
}
const missingByExt = new Map();
for (const file of tracked) {
  const a = attrs.get(file) || {};
  if (a.binary === 'set' || a.text === 'unset' || !textInIndex.has(file)) continue;
  if (a.eol !== 'lf') {
    const base = file.split('/').pop();
    const m = /^[^.].*\.([^.]+)$/.exec(base);
    const ext = m ? `*.${m[1]}` : base;
    if (!missingByExt.has(ext)) missingByExt.set(ext, []);
    missingByExt.get(ext).push(file);
  }
}
for (const [ext, files] of missingByExt) {
  add('P3', files[0], 0, `${files.length} 个文本文件（${ext}，如 ${files.slice(0, 3).join(', ')}）在 Windows 签出时不是 LF，`
    + '逐字节比较 / 哈希 / 迁移校验会在 Windows 上失败。修法：.gitattributes 给它们 eol=lf（或 `* text=auto eol=lf`）。（4c2c321 *.sql / *.rs）');
}

if (asJson) {
  process.stdout.write(`${JSON.stringify({ ok: findings.length === 0, findings }, null, 2)}\n`);
} else if (findings.length) {
  for (const f of findings) console.error(`${f.rule} ${f.file}${f.line ? `:${f.line}` : ''}\n    ${f.message}`);
  console.error(`\nPortability check failed: ${findings.length} finding(s).`);
} else {
  console.log(`Portability check OK: ${tracked.length} tracked files.`);
}
process.exit(findings.length ? 1 : 0);
