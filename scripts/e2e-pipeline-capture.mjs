#!/usr/bin/env node
// capture.ui 端到端：本机起一个 localhost 页面，经 pipeline 命令边界截图 + 录屏，
// 检查确认门、公网拒绝、授权文件夹 file://、页面内越界（点链接跳公网、302 到公网、外链子资源）、产物进 run 且 trace 有对应 Step。
// Linux 以 root 身份或容器里没有 user namespace 时 Chromium 沙箱起不来，需显式 IRIS_CAPTURE_NO_SANDBOX=1。
// 需要本机 Chromium（Playwright 自带、IRIS_CAPTURE_BROWSER，或 Remotion 已下载的 headless shell）。
import { createServer } from 'node:http';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(ROOT, '.tmp', 'pipeline-capture');
rmSync(outDir, { recursive: true, force: true });
const authorized = join(outDir, 'authorized-folder');
mkdirSync(authorized, { recursive: true });
process.env.IRIS_PIPELINE_HOME = join(outDir, 'runtime');
process.env.IRIS_PIPELINE_ALLOWED_ROOTS = authorized;

const page = `<!doctype html><meta charset="utf-8"><title>Demo</title>
<style>body{margin:0;font:32px "Noto Sans CJK SC",system-ui,sans-serif;background:#101418;color:#f4f4f5;display:grid;place-items:center;height:100vh}
button{font:inherit;padding:16px 32px;border-radius:14px;border:0;background:#4f8cff;color:#fff}#done{display:none;color:#5be3a8}</style>
<main><h1 id="title">截图进去</h1><button id="go" onclick="setTimeout(()=>{document.getElementById('title').textContent='宣传片出来';document.getElementById('done').style.display='block'},300)">生成</button><p id="done">已完成 ✓</p></main>`;
writeFileSync(join(authorized, 'demo.html'), page);
const escapePage = '<!doctype html><meta charset="utf-8"><a id="out" href="http://example.com/">外链</a>';
const subresourcePage = '<!doctype html><meta charset="utf-8"><img src="http://example.com/pixel.png"><h1>外链图片被拦，页面照常截图</h1>';
const server = createServer((request, response) => {
  if (request.url === '/redirect') { response.writeHead(302, { location: 'http://example.com/' }); response.end(); return; }
  const body = request.url === '/escape' ? escapePage : request.url === '/subresource' ? subresourcePage : page;
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(body);
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const base = `http://localhost:${server.address().port}/`;

const { Pipeline } = await import(pathToFileURL(join(ROOT, 'tools/iris/pipeline/index.js')).href);
const pipeline = new Pipeline({ home: process.env.IRIS_PIPELINE_HOME });
const agent = { caller: 'codex' };
// MCP / 外部 Agent 填的 confirmed 不生效：拿到 approvalId → 模拟用户在 UI 批准 → 同参数同 mutationId 重试。
const approved = async (command, args, context) => {
  const first = await pipeline.execute(command, args, context);
  if (first.error?.code !== 'CONFIRMATION_REQUIRED') return first;
  pipeline.grantApproval(first.error.details.approval.approvalId);
  return pipeline.execute(command, args, context);
};
const checks = [];
const check = (name, condition, details) => {
  if (!condition) throw new Error(`断言失败：${name}\n${JSON.stringify(details, null, 2)}`);
  checks.push(name);
  console.log(`  ✓ ${name}`);
};
try {
  const start = await approved('pipeline.run.start', { projectId: 'proj-capture', brief: { keyLine: '截图进去，宣传片出来', aspect: '16:9' }, budget: { maxTasks: 3, maxRounds: 2 }, budgetConfirmed: true }, { ...agent, mutationId: 'start' });
  check('run 创建', start.ok, start);
  const runId = start.result.runId;
  const steps = [
    { action: 'screenshot', name: 'before' },
    { action: 'click', selector: '#go' },
    { action: 'waitFor', selector: '#done' },
    { action: 'screenshot', name: 'after' },
  ];
  const unconfirmed = await pipeline.execute('capture.ui', { runId, url: base, steps }, { ...agent, mutationId: 'cap-0' });
  check('未确认不启动浏览器', unconfirmed.error?.code === 'CONFIRMATION_REQUIRED', unconfirmed);
  const remote = await pipeline.execute('capture.ui', { runId, url: 'https://example.com/', confirmed: true }, { ...agent, mutationId: 'cap-remote' });
  check('拒绝公网地址', remote.error?.code === 'PATH_NOT_AUTHORIZED', remote);
  const outside = await pipeline.execute('capture.ui', { runId, url: pathToFileURL('/etc/hosts').href, confirmed: true }, { ...agent, mutationId: 'cap-outside' });
  check('拒绝授权文件夹以外的 file://', outside.error?.code === 'PATH_NOT_AUTHORIZED', outside);

  const shots = await approved('capture.ui', { runId, url: base, steps, viewport: { width: 1280, height: 720 }, confirmed: true }, { ...agent, mutationId: 'cap-1' });
  check('localhost 截图成功', shots.ok, shots);
  const images = shots.result.artifacts;
  check('按步骤得到两张截图', images.length === 2 && images.every(item => item.captureKind === 'screenshot'), images);
  check('截图尺寸等于 viewport', images.every(item => item.media?.video?.width === 1280 && item.media?.video?.height === 720), images.map(item => item.media));
  check('前后两张画面不同（点击真的生效）', images[0].sha256 !== images[1].sha256);
  const replay = await pipeline.execute('capture.ui', { runId, url: base, steps, viewport: { width: 1280, height: 720 }, confirmed: true }, { ...agent, mutationId: 'cap-1' });
  check('同一 mutationId 重放不重复采集', replay.ok && replay.step?.seq === shots.step?.seq, { replay: replay.step, first: shots.step });

  const fileShot = await approved('capture.ui', { runId, url: pathToFileURL(join(authorized, 'demo.html')).href, confirmed: true }, { ...agent, mutationId: 'cap-file' });
  check('授权文件夹内的 file:// 可以截图（未写 screenshot 步骤时自动补一张）', fileShot.ok && fileShot.result.artifacts.length === 1, fileShot);

  const video = await approved('capture.ui', { runId, url: base, mode: 'video', viewport: { width: 1280, height: 720 }, steps: [{ action: 'wait', ms: 600 }, { action: 'click', selector: '#go' }, { action: 'waitFor', selector: '#done' }, { action: 'wait', ms: 800 }], confirmed: true }, { ...agent, mutationId: 'cap-video' });
  check('录屏成功并转成 MP4', video.ok && video.result.artifacts[0]?.captureKind === 'recording' && /\.mp4$/.test(video.result.artifacts[0].path), video);
  check('录屏有时长', (video.result.artifacts[0].media?.durationMs || 0) > 1000, video.result.artifacts[0].media);

  const clickOut = await approved('capture.ui', { runId, url: `${base}escape`, steps: [{ action: 'click', selector: '#out' }, { action: 'wait', ms: 300 }, { action: 'screenshot' }], confirmed: true }, { ...agent, mutationId: 'cap-escape' });
  check('页面里点链接跳公网：整次采集失败', clickOut.error?.code === 'PATH_NOT_AUTHORIZED', clickOut);
  const redirect = await approved('capture.ui', { runId, url: `${base}redirect`, confirmed: true }, { ...agent, mutationId: 'cap-redirect' });
  check('本机地址 302 到公网：整次采集失败', !redirect.ok, redirect);
  const subresource = await approved('capture.ui', { runId, url: `${base}subresource`, confirmed: true }, { ...agent, mutationId: 'cap-sub' });
  check('外链子资源被拦但页面照常截图', subresource.ok && subresource.result.artifacts.length === 1, subresource);

  const trace = pipeline.trace(runId);
  const captureSteps = trace.steps.filter(step => step.tool === 'capture.ui');
  check('trace 里记下 capture.ui Step（含失败与确认门）', captureSteps.length === 9 && captureSteps.every(step => step.caller === 'codex'), captureSteps.map(step => [step.status, step.error?.code]));
  const listed = await pipeline.execute('asset.list', { runId, kind: 'capture' }, agent);
  check('采集产物可按 kind=capture 列出', listed.ok && listed.result.artifacts.length === 5, listed.result);
  console.log(`\n${checks.length} checks passed. Screenshots: ${images.map(item => item.path).join(', ')}`);
} finally {
  pipeline.close();
  server.close();
}
