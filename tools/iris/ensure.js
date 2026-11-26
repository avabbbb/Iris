import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getLocalStatus } from './local-status.js';
import { toLocalLinkPublicStatus } from './public-status.js';
import { probeWebLinkStatus } from './link/web-workspace.js';

function cliPath() {
  try { return fileURLToPath(new URL('./cli.js', import.meta.url)); }
  catch { return join(process.cwd(), 'tools', 'iris', 'cli.js'); }
}

function parseJsonOutput(output) {
  const text = String(output || '');
  let depth = 0;
  let start = -1;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') { quoted = true; continue; }
    if (character === '{') { if (depth === 0) start = index; depth += 1; continue; }
    if (character !== '}') continue;
    depth -= 1;
    if (depth === 0 && start >= 0) {
      try { return JSON.parse(text.slice(start, index + 1)); } catch { start = -1; }
    }
  }
  return null;
}

function isSourceCheckout(dir) {
  return Boolean(dir) && existsSync(join(dir, 'agent', 'index.js')) && existsSync(join(dir, 'vite.config.ts'));
}

/** 本 CLI 所在的源码仓库（tools/iris/ensure.js → 仓库根）；npm 安装的 toolkit 没有 agent/ 与 vite.config.ts。 */
function cliSourceDir() {
  // 不写 new URL('../../', import.meta.url)：Vite 会把这种写法当静态资源改写。
  try { return join(dirname(fileURLToPath(import.meta.url)), '..', '..'); }
  catch { return null; }
}

/**
 * 选择源码目录：当前目录是源码仓库时用当前目录；否则（在别的目录跑 `node <repo>/tools/iris/cli.js ensure`）
 * 回退到 CLI 自身所在的仓库。旧实现只看 cwd，离开仓库目录就落到 toolkit 模式，前端已在跑也起不来 Agent。
 */
function resolveSourceDir(cwd, sourceDir = cliSourceDir()) {
  if (isSourceCheckout(cwd)) return cwd;
  if (isSourceCheckout(sourceDir)) return sourceDir;
  return null;
}

function frontendPort(status) {
  const url = status?.frontend?.status === 'ready' ? status.frontend.url : null;
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(parsed.hostname)) return null;
    return parsed.port || null;
  } catch {
    return null;
  }
}

function startArguments(cwd, open, options = {}) {
  const sourceDir = options.sourceDir === undefined ? resolveSourceDir(cwd) : options.sourceDir;
  const source = Boolean(sourceDir) || Boolean(options.web || options.source);
  // 前端已在跑：把它的端口交给 start，start 复用这个 WebUI、只补起 Agent，而不是另起一个前端。
  const port = source ? frontendPort(options.status) : null;
  return ['start', ...(source ? ['--source', '--web'] : []), ...(port ? [`--web-port=${port}`] : []), '--json', ...(open ? ['--open'] : ['--no-open'])];
}

function runStart(args, { cwd = process.cwd(), env = process.env, spawnImpl = spawn } = {}) {
  return new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    const child = spawnImpl(process.execPath, [cliPath(), ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child.stdout?.on('data', chunk => { stdout += String(chunk); });
    child.stderr?.on('data', chunk => { stderr += String(chunk); });
    child.once('error', error => resolve({ code: -1, stdout, stderr: `${stderr}${error instanceof Error ? error.message : String(error)}` }));
    child.once('close', code => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function ensureResponse(status, fallbackError) {
  const publicStatus = toLocalLinkPublicStatus(status);
  const response = {
    ok: publicStatus.state === 'ready',
    state: publicStatus.state,
    frontend: status.frontend?.status === 'ready' ? 'ready' : 'offline',
    agent: status.agent?.status === 'ready' ? 'ready' : publicStatus.state === 'needs_login' ? 'needs_login' : publicStatus.state === 'needs_setup' ? 'needs_setup' : 'offline',
    browser: status.browserConnected ? 'ready' : 'offline',
    projectId: status.projectId || null,
    revision: status.revision ?? null,
  };
  if (!response.ok) response.error = { code: publicStatus.state === 'needs_login' ? 'HOST_NEEDS_LOGIN' : publicStatus.state === 'needs_setup' ? 'HOST_NEEDS_SETUP' : 'LINK_OFFLINE', message: fallbackError || publicStatus.message, action: publicStatus.action };
  return response;
}

function isRemoteHttpsUrl(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    return parsed.protocol === 'https:' && !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(parsed.hostname);
  } catch {
    return false;
  }
}

export async function ensureIris({ open = true, web = false, source = false, url, cwd = process.cwd(), env = process.env, statusReader = getLocalStatus, webLinkReader = probeWebLinkStatus, startRunner = runStart, sourceDir } = {}) {
  let status = await statusReader({ env });
  if (status.ready && !isRemoteHttpsUrl(url)) return ensureResponse(status);

  // 已配对线上 Iris Link 时直接复用，不再强行拉起本地 Vite。
  const webLink = typeof webLinkReader === 'function'
    ? await webLinkReader({ env, ...(isRemoteHttpsUrl(url) ? { baseUrl: url } : {}) }).catch(() => null)
    : null;
  if (webLink?.tabOnline) {
    return {
      ok: true,
      state: 'ready',
      mode: 'web-link',
      frontend: 'ready',
      agent: 'ready',
      browser: 'ready',
      projectId: webLink.tab?.projectId || null,
      revision: null,
      url: webLink.url,
    };
  }
  if (isRemoteHttpsUrl(url)) {
    if (webLink?.linked) {
      return {
        ok: false,
        state: 'offline',
        mode: 'web-link',
        frontend: 'offline',
        agent: 'ready',
        browser: 'offline',
        projectId: null,
        revision: null,
        url: webLink.url || url,
        error: {
          code: 'TAB_OFFLINE',
          message: `已配对线上 Iris（${webLink.url || url}），但浏览器标签页未打开。请在浏览器打开 ${url} 后重试。`,
          action: 'open',
        },
      };
    }
    return {
      ok: false,
      state: 'needs_login',
      mode: 'web-link',
      frontend: 'offline',
      agent: 'needs_login',
      browser: 'offline',
      projectId: null,
      revision: null,
      url,
      error: {
        code: 'HOST_NEEDS_LOGIN',
        message: `尚未配对线上 Iris（${url}）。运行：npm run iris:cli -- login web --open --url ${url} --scopes agent.read,agent.run,tools.invoke`,
        action: 'login',
      },
    };
  }

  if (!startRunner) return ensureResponse(status);
  const projectDir = sourceDir === undefined ? resolveSourceDir(cwd) : sourceDir;
  // start 在源码仓库里执行，它的 resolveProjectDir 才会指向这个仓库。
  const started = await startRunner(startArguments(cwd, open, { sourceDir: projectDir, web, source, status }), { cwd: projectDir || cwd, env });
  status = await statusReader({ env });
  if (status.ready) return ensureResponse(status);
  const startResult = parseJsonOutput(started.stdout);
  const startError = startResult?.error?.message || startResult?.agent?.error || startResult?.frontend?.error || (started.code !== 0 ? 'Iris 本地服务未能就绪。' : undefined);
  return ensureResponse(status, startError);
}

export { ensureResponse, parseJsonOutput, resolveSourceDir, startArguments };
