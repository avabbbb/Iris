// capture.ui：本机 Playwright 打开用户给的本地页面，按步骤截图 / 录屏（docs/design/16-agent-video-pipeline.md C5）。
// 只允许 localhost / 回环地址，或授权文件夹内的 file:// 页面；不访问公网。
// 边界不止校验入口 URL：浏览器里的每个请求（子资源、跳转、重定向、弹窗、WebSocket）都走同一条规则，
// 越界的子资源直接拦掉，越界的导航 / 真实发出的越界响应让整次采集失败。Chromium 默认开沙箱。
import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CapabilityError, ffmpegBin, runTool } from './media.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export const CAPTURE_LIMITS = Object.freeze({ maxSteps: 40, maxWaitMs: 15000, maxScreenshots: 12, maxVideoMs: 120000, maxViewportEdge: 4096 });
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
// 页面内部的空白页 / 内联资源 / 浏览器自己的错误页，不出本机。
const INTERNAL_PROTOCOLS = new Set(['about:', 'data:', 'blob:']);
const ACTIONS = new Set(['goto', 'click', 'fill', 'press', 'hover', 'scroll', 'wait', 'waitFor', 'screenshot']);

const invalid = message => Object.assign(new Error(message), { code: 'INVALID_ARGUMENT' });

export function allowedRoots() {
  return (process.env.IRIS_PIPELINE_ALLOWED_ROOTS || '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean).map(root => resolve(root));
}

/** 解析符号链接后的真实路径；文件不存在时逐级向上找到存在的祖先再拼回去，防止用链接跳出授权文件夹。 */
function realPath(path) {
  try { return realpathSync.native(path); } catch {
    const parent = dirname(path);
    if (parent === path) return path;
    return join(realPath(parent), path.slice(parent.length).replace(/^[\\/]+/, ''));
  }
}

function insideRoots(path, roots) {
  const real = realPath(path);
  return roots.some(root => {
    const base = realPath(root);
    return real === base || real.startsWith(base.endsWith(sep) ? base : base + sep);
  });
}

const notAuthorized = (message, details) => Object.assign(new Error(message), { code: 'PATH_NOT_AUTHORIZED', ...(details ? { details } : {}) });

/**
 * 浏览器里的一个请求能不能放行（入口、子资源、跳转、重定向、WebSocket 共用）。
 * 回环 http(s) / ws(s)、授权文件夹内的 file://、about: / data: / blob:。返回 { ok, reason }。
 */
export function captureRequestAllowed(raw, roots = allowedRoots()) {
  let url;
  try { url = new URL(String(raw || '')); } catch { return { ok: false, reason: `不是合法 URL：${raw}` }; }
  if (INTERNAL_PROTOCOLS.has(url.protocol)) return { ok: true };
  if (['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
    return LOOPBACK_HOSTS.has(url.hostname) ? { ok: true } : { ok: false, reason: `只允许本机地址（localhost / 127.0.0.1），拒绝 ${url.hostname}` };
  }
  if (url.protocol === 'file:') {
    let path;
    try { path = resolve(fileURLToPath(url)); } catch { return { ok: false, reason: `不是合法的本地文件地址：${raw}` }; }
    return roots.length && insideRoots(path, roots) ? { ok: true } : { ok: false, reason: `${path} 不在授权文件夹内` };
  }
  return { ok: false, reason: `不支持 ${url.protocol} 协议` };
}

/** 只放行回环地址与授权文件夹内的本地文件；返回规范化后的 URL 字符串。 */
export function assertCaptureUrl(raw, roots = allowedRoots()) {
  let url;
  try { url = new URL(String(raw || '')); } catch { throw invalid(`不是合法 URL：${raw}`); }
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    if (!LOOPBACK_HOSTS.has(url.hostname)) {
      throw notAuthorized(`capture.ui 只打开本机页面（localhost / 127.0.0.1），拒绝 ${url.hostname}`);
    }
    return url.toString();
  }
  if (url.protocol === 'file:') {
    const path = resolve(fileURLToPath(url));
    if (!roots.length || !insideRoots(path, roots)) throw notAuthorized(`${path} 不在授权文件夹内`, { allowedRoots: roots });
    if (!existsSync(path)) throw Object.assign(new Error(`文件不存在：${path}`), { code: 'ASSET_MISSING' });
    return url.toString();
  }
  throw invalid(`capture.ui 不支持 ${url.protocol} 协议`);
}

/** Chromium 沙箱：默认开启；只有显式设置 IRIS_CAPTURE_NO_SANDBOX=1（例如 root 身份的容器）才关闭。 */
export function captureSandboxEnabled(env = process.env) {
  return !/^(1|true|yes)$/i.test(String(env.IRIS_CAPTURE_NO_SANDBOX || ''));
}

/** 启动参数：除 localhost 外的主机名一律解析失败（纵深防御；IP 字面量由请求拦截兜底）。 */
export const CAPTURE_BROWSER_ARGS = Object.freeze([
  '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-sync',
  '--no-first-run',
  '--disable-extensions',
]);

/**
 * 在浏览器上下文里装上访问边界：越界请求一律拦截；越界的导航、绕过拦截真正拿到的响应记为违规，
 * 由 violation() 取出，采集在下一步之前失败。
 */
export async function guardCaptureContext(context, roots = allowedRoots()) {
  const violations = [];
  const note = (url, reason, kind) => { if (violations.length < 20) violations.push({ url: String(url).slice(0, 300), reason, kind }); };
  const internalPage = url => /^chrome-error:/.test(String(url));
  await context.route(() => true, route => {
    const request = route.request();
    const verdict = captureRequestAllowed(request.url(), roots);
    if (verdict.ok) return route.continue();
    if (request.isNavigationRequest()) note(request.url(), verdict.reason, 'navigation');
    return route.abort('blockedbyclient');
  });
  if (typeof context.routeWebSocket === 'function') {
    await context.routeWebSocket(() => true, ws => {
      const verdict = captureRequestAllowed(ws.url(), roots);
      if (verdict.ok) ws.connectToServer();
      else { note(ws.url(), verdict.reason, 'websocket'); ws.close({ code: 1008, reason: 'blocked by capture boundary' }); }
    });
  }
  // 重定向等不经过拦截的情况：只要越界的响应真的回来了，就判违规。
  context.on('response', response => {
    const verdict = captureRequestAllowed(response.url(), roots);
    if (!verdict.ok) note(response.url(), verdict.reason, 'response');
  });
  const watchPage = page => {
    page.on('framenavigated', frame => {
      const url = frame.url();
      if (internalPage(url)) return;
      const verdict = captureRequestAllowed(url, roots);
      if (!verdict.ok) note(url, verdict.reason, 'navigation');
    });
  };
  context.on('page', watchPage);
  for (const page of context.pages?.() || []) watchPage(page);
  return {
    violations,
    assertClean() {
      if (!violations.length) return;
      const first = violations[0];
      throw notAuthorized(`页面试图访问授权范围以外的地址（${first.url}）：${first.reason}`, { violations: violations.slice(0, 5) });
    },
  };
}

async function launchCaptureBrowser(chromium, executablePath) {
  const sandbox = captureSandboxEnabled();
  try {
    return await chromium.launch({ executablePath, headless: true, chromiumSandbox: sandbox, args: [...CAPTURE_BROWSER_ARGS] });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (sandbox && /sandbox/i.test(message)) {
      throw new CapabilityError('capture.ui', 'Chromium 沙箱无法启动（常见于以 root 身份运行或容器里缺少 user namespace）',
        '以普通用户运行；确实只能在受控环境里关闭沙箱时，设置 IRIS_CAPTURE_NO_SANDBOX=1');
    }
    throw error;
  }
}

/** 校验并规范化 steps / viewport / mode；纯函数，便于单测。 */
export function normalizeCaptureArgs(args, roots = allowedRoots()) {
  const url = assertCaptureUrl(args.url, roots);
  const mode = args.mode || 'screenshot';
  if (mode !== 'screenshot' && mode !== 'video') throw invalid('mode 只能是 screenshot 或 video');
  const viewport = { width: 1280, height: 800, ...(args.viewport || {}) };
  for (const key of ['width', 'height']) {
    const value = viewport[key];
    if (!Number.isInteger(value) || value < 200 || value > CAPTURE_LIMITS.maxViewportEdge) throw invalid(`viewport.${key} 需要 200–${CAPTURE_LIMITS.maxViewportEdge} 的整数`);
  }
  const deviceScaleFactor = viewport.deviceScaleFactor === undefined ? 1 : Number(viewport.deviceScaleFactor);
  if (!(deviceScaleFactor >= 1 && deviceScaleFactor <= 3)) throw invalid('viewport.deviceScaleFactor 需要 1–3');
  const steps = Array.isArray(args.steps) ? args.steps : [];
  if (steps.length > CAPTURE_LIMITS.maxSteps) throw invalid(`steps 最多 ${CAPTURE_LIMITS.maxSteps} 步`);
  const normalized = steps.map((step, index) => {
    const label = `steps[${index}]`;
    if (!step || !ACTIONS.has(step.action)) throw invalid(`${label}: action 需要是 ${[...ACTIONS].join(' / ')}`);
    if (['click', 'fill', 'hover', 'waitFor'].includes(step.action) && !step.selector) throw invalid(`${label}: ${step.action} 需要 selector`);
    if (step.action === 'fill' && typeof step.value !== 'string') throw invalid(`${label}: fill 需要 value`);
    if (step.action === 'press' && !step.key) throw invalid(`${label}: press 需要 key`);
    if (step.action === 'goto') return { ...step, url: assertCaptureUrl(step.url, roots) };
    if (step.action === 'wait') {
      const ms = Number(step.ms);
      if (!(ms >= 0 && ms <= CAPTURE_LIMITS.maxWaitMs)) throw invalid(`${label}: wait.ms 需要 0–${CAPTURE_LIMITS.maxWaitMs}`);
      return { action: 'wait', ms };
    }
    if (step.action === 'scroll') return { action: 'scroll', x: Number(step.x) || 0, y: Number(step.y) || 0 };
    return step;
  });
  const shots = normalized.filter(step => step.action === 'screenshot').length;
  if (shots > CAPTURE_LIMITS.maxScreenshots) throw invalid(`一次最多 ${CAPTURE_LIMITS.maxScreenshots} 张截图`);
  // 截图模式没写 screenshot 步骤时，在最后补一张。
  if (mode === 'screenshot' && shots === 0) normalized.push({ action: 'screenshot' });
  return { url, mode, viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor, steps: normalized };
}

function remotionHeadlessShell() {
  const base = join(REPO_ROOT, 'node_modules', '.remotion', 'chrome-headless-shell');
  if (!existsSync(base)) return null;
  for (const platform of readdirSync(base)) {
    const platformDir = join(base, platform);
    if (!existsSync(platformDir) || platform === 'VERSION') continue;
    for (const folder of readdirSync(platformDir)) {
      for (const name of ['headless_shell', 'headless_shell.exe', 'chrome-headless-shell', 'chrome-headless-shell.exe']) {
        const candidate = join(platformDir, folder, name);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

/** 浏览器来源：IRIS_CAPTURE_BROWSER → Playwright 自带 Chromium → Remotion 已下载的 headless shell。 */
export async function resolveCaptureBrowser() {
  const require = createRequire(join(REPO_ROOT, 'package.json'));
  let playwright;
  try {
    playwright = await import(require.resolve('playwright'));
  } catch {
    throw new CapabilityError('capture.ui', '本机缺少 playwright', '在仓库根目录运行 npm install');
  }
  const chromium = playwright.chromium || playwright.default?.chromium;
  const candidates = [process.env.IRIS_CAPTURE_BROWSER, (() => { try { return chromium.executablePath(); } catch { return null; } })(), remotionHeadlessShell()];
  const executablePath = candidates.find(path => path && existsSync(path));
  if (!executablePath) {
    throw new CapabilityError('capture.ui', '找不到可用的 Chromium', '运行 npx playwright install chromium，或设置 IRIS_CAPTURE_BROWSER');
  }
  return { chromium, executablePath };
}

/**
 * 录屏：用 CDP Page.startScreencast 收帧（不依赖 Playwright 自带的 ffmpeg），帧带时间戳，
 * 再用本机 ffmpeg 的 concat 按真实间隔拼成恒定 30fps 的 H.264 MP4。
 */
async function startScreencast(context, page, plan, scratchPath) {
  const cdp = await context.newCDPSession(page);
  const frames = [];
  const dir = dirname(scratchPath('frames/.keep'));
  mkdirSync(dir, { recursive: true });
  cdp.on('Page.screencastFrame', event => {
    const path = join(dir, `f${String(frames.length).padStart(5, '0')}.jpg`);
    writeFileSync(path, Buffer.from(event.data, 'base64'));
    frames.push({ path, at: event.metadata?.timestamp ?? Date.now() / 1000 });
    void cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
  });
  const width = plan.viewport.width * plan.deviceScaleFactor;
  const height = plan.viewport.height * plan.deviceScaleFactor;
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 90, maxWidth: width, maxHeight: height, everyNthFrame: 1 });
  return {
    async stop(signal) {
      const endedAt = Date.now() / 1000;
      await cdp.send('Page.stopScreencast').catch(() => {});
      if (!frames.length) throw Object.assign(new Error('录屏没有收到任何画面'), { code: 'CAPTURE_EMPTY' });
      const lines = [];
      frames.forEach((frame, index) => {
        const next = frames[index + 1]?.at ?? Math.max(endedAt, frame.at + 0.1);
        lines.push(`file '${frame.path.replace(/'/g, "'\\''")}'`, `duration ${Math.max(0.001, next - frame.at).toFixed(3)}`);
      });
      lines.push(`file '${frames.at(-1).path.replace(/'/g, "'\\''")}'`);
      const list = join(dir, 'frames.txt');
      writeFileSync(list, lines.join('\n') + '\n');
      const mp4 = scratchPath('capture-recording.mp4');
      await runTool(ffmpegBin(), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list,
        '-vf', 'fps=30,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-movflags', '+faststart', mp4],
      { capability: 'ffmpeg', signal });
      return mp4;
    },
  };
}

/**
 * 执行一次采集。scratchPath(name) 给出临时输出路径。返回 [{ path, kind: 'screenshot'|'recording', label }]。
 */
export async function runCapture(plan, { scratchPath, signal, roots = allowedRoots(), resolveBrowser = resolveCaptureBrowser }) {
  const { chromium, executablePath } = await resolveBrowser();
  const browser = await launchCaptureBrowser(chromium, executablePath);
  const outputs = [];
  const abort = () => { void browser.close().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  const started = Date.now();
  try {
    const context = await browser.newContext({
      viewport: plan.viewport,
      deviceScaleFactor: plan.deviceScaleFactor,
      // Service Worker 的请求不经过 context.route，直接禁用；也不接受下载、不授予任何权限。
      serviceWorkers: 'block',
      acceptDownloads: false,
      permissions: [],
    });
    const boundary = await guardCaptureContext(context, roots);
    const page = await context.newPage();
    page.setDefaultTimeout(CAPTURE_LIMITS.maxWaitMs);
    await page.goto(plan.url, { waitUntil: 'load' });
    boundary.assertClean();
    const recorder = plan.mode === 'video' ? await startScreencast(context, page, plan, scratchPath) : null;
    let shot = 0;
    for (const step of plan.steps) {
      signal?.throwIfAborted();
      if (recorder && Date.now() - started > CAPTURE_LIMITS.maxVideoMs) throw invalid(`录屏超过 ${CAPTURE_LIMITS.maxVideoMs / 1000} 秒上限`);
      if (step.action === 'goto') await page.goto(step.url, { waitUntil: 'load' });
      else if (step.action === 'click') await page.click(step.selector);
      else if (step.action === 'fill') await page.fill(step.selector, step.value);
      else if (step.action === 'press') await page.keyboard.press(step.key);
      else if (step.action === 'hover') await page.hover(step.selector);
      else if (step.action === 'scroll') await page.mouse.wheel(step.x, step.y);
      else if (step.action === 'wait') await page.waitForTimeout(step.ms);
      else if (step.action === 'waitFor') await page.waitForSelector(step.selector, { state: 'visible' });
      else if (step.action === 'screenshot') {
        shot += 1;
        const path = scratchPath(`capture-${String(shot).padStart(2, '0')}.png`);
        const target = step.selector ? page.locator(step.selector).first() : page;
        await target.screenshot({ path, ...(step.selector ? {} : { fullPage: Boolean(step.fullPage) }) });
        outputs.push({ path, kind: 'screenshot', label: step.name || `shot-${shot}` });
      }
      boundary.assertClean();
    }
    if (recorder) outputs.push({ path: await recorder.stop(signal), kind: 'recording', label: 'recording' });
    await context.close();
    return outputs;
  } finally {
    signal?.removeEventListener('abort', abort);
    await browser.close().catch(() => {});
  }
}
