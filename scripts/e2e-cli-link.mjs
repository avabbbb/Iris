// Iris Link 端到端（Mock）：wrangler dev（中继 Durable Object）+ vite dev（网页版，VITE_IRIS_MOCK=1）+ 本地假模型 + Playwright。
// 流程：iris login web --open → 页面确认配对 → link status → agent send/trace → 审批（非付费 CLI 批准、付费只能拒绝）
//       → --canvas 会话卡 → cancel → tools list/invoke → agent e2e 报告 → 关标签页 TAB_OFFLINE → logout。
// 只用 mock 模型，不调真实模型、不花钱。用法：node scripts/e2e-cli-link.mjs <outDir>
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const OUT = resolve(process.argv[2] || join(ROOT, '.tmp', 'cli-link-e2e'));
const VITE_PORT = Number(process.env.E2E_VITE_PORT || 37530);
const RELAY_PORT = Number(process.env.E2E_RELAY_PORT || 8799);
const MOCK_PORT = Number(process.env.E2E_MOCK_PORT || 5299);
const BASE = `http://127.0.0.1:${VITE_PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}/v1`;
const STATE = join(OUT, '.state');
rmSync(STATE, { recursive: true, force: true });
mkdirSync(STATE, { recursive: true });

const children = [];
const steps = [];
const shots = [];
const logs = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));

function startChild(name, cmd, args, env = {}) {
  const child = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  child.on('exit', code => logs.push(`${name} exited ${code}`));
  children.push({ name, child, output: () => output });
  return child;
}

async function waitHttp(url, timeoutMs, init) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const res = await fetch(url, init); if (res.status < 500) return res; } catch { /* not yet */ }
    await sleep(500);
  }
  throw new Error('timed out waiting for ' + url);
}

const CLI_ENV = { IRIS_LINK_FILE: join(STATE, 'link.json'), IRIS_AGENT_HOME: join(STATE, 'iris-home'), NO_COLOR: '1' };

/** 跑一次 CLI，收集 stdout 的 NDJSON 行。 */
function cli(args, { onLine, timeoutMs = 240_000 } = {}) {
  return new Promise(resolveCli => {
    const child = spawn(process.execPath, ['tools/iris/cli.js', ...args], { cwd: ROOT, env: { ...process.env, ...CLI_ENV }, stdio: ['ignore', 'pipe', 'pipe'] });
    let buffer = '';
    let stderr = '';
    const lines = [];
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const raw = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!raw) continue;
        let line;
        try { line = JSON.parse(raw); } catch { line = { raw }; }
        lines.push(line);
        onLine?.(line);
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('exit', code => { clearTimeout(timer); resolveCli({ code, lines, final: lines[lines.length - 1] || null, stderr }); });
  });
}

function record(name, result, extra = {}) {
  const file = join(OUT, `cli-${String(steps.length + 1).padStart(2, '0')}-${name}.ndjson`);
  writeFileSync(file, result.lines.map(line => JSON.stringify(line)).join('\n') + '\n' + (result.stderr ? `# stderr\n${result.stderr.split('\n').map(l => '# ' + l).join('\n')}\n` : ''));
  steps.push({ name, exitCode: result.code, ok: result.final?.ok ?? false, file, ...extra });
  return result;
}

function expect(condition, message) {
  if (!condition) throw new Error('E2E assertion failed: ' + message);
}

const KEY = {
  id: 'mock-key', provider: 'openai', key: 'sk-mock-not-real', baseUrl: MOCK, name: 'Mock（e2e）', isDefault: true, status: 'ok',
  capabilities: ['text', 'agent'],
  models: [{ id: 'mock-chat', name: 'mock-chat' }],
  routeMappings: [{ routeId: 'mock-chat', order: 0, target: { kind: 'runtime-capability', capability: 'agent-text' } }],
  createdAt: 1, updatedAt: 1,
};

async function seed(page) {
  await page.evaluate(async ({ key }) => {
    localStorage.setItem('themeMode.v1', 'dark');
    // 「每次都问」：写画布要审批，才有真实的审批回合。
    localStorage.setItem('iris.agent.approvalMode', 'always-ask');
    const kv = await import('/utils/keyVault.ts');
    await kv.saveKeysEncrypted([key]);
    const { useWorkflowStore, flushWorkflowPersistence } = await import('/components/workflow/store.ts');
    const { createWorkflowNode } = await import('/components/workflow/constants.ts');
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 200;
    const g = canvas.getContext('2d'); const grad = g.createLinearGradient(0, 0, 320, 200); grad.addColorStop(0, '#b83a2f'); grad.addColorStop(1, '#3a1410'); g.fillStyle = grad; g.fillRect(0, 0, 320, 200);
    g.fillStyle = '#fff'; g.font = '600 28px sans-serif'; g.fillText('主角定妆', 20, 50);
    const nodes = [
      { ...createWorkflowNode('img-hero', 'image', { x: 80, y: 80 }, { href: canvas.toDataURL('image/png'), mimeType: 'image/png', prompt: '主角，红色外套', naturalWidth: 320, naturalHeight: 200, status: 'success' }), title: '主角定妆', width: 280, height: 175 },
      { ...createWorkflowNode('note-tone', 'text', { x: 80, y: 300 }, { content: '色调：暖，低饱和。' }), title: '色调备注', width: 280, height: 120 },
    ];
    const state = useWorkflowStore.getState();
    for (const project of state.projects) state.deleteProjects([project.id]);
    const id = useWorkflowStore.getState().createProject('CLI Link e2e', { nodes, connections: [] });
    useWorkflowStore.getState().setActiveProject(id);
    useWorkflowStore.getState().updateProject(id, { viewport: { x: 0, y: 0, k: 1 } });
    await flushWorkflowPersistence();
  }, { key: KEY });
}

async function waitHost(page, timeoutMs = 120_000) {
  await page.waitForFunction(async () => {
    const mod = await import('/services/link/agentLinkHost.ts');
    return mod.agentLinkHostProjects().length > 0;
  }, null, { timeout: timeoutMs, polling: 500 });
}

/** 把视角移到某个节点（会话卡放在已有内容右侧的空位，可能在视口外）。 */
async function focusNode(page, nodeId) {
  await page.evaluate(async id => {
    const { useWorkflowStore } = await import('/components/workflow/store.ts');
    const state = useWorkflowStore.getState();
    const project = state.projects.find(item => item.id === state.activeProjectId);
    const node = project?.nodes.find(item => item.id === id);
    if (!project || !node) return;
    const k = 0.85;
    state.updateProject(project.id, { viewport: { x: Math.round(560 - (node.position.x + (node.width || 340) / 2) * k), y: Math.round(380 - (node.position.y + (node.height || 284) / 2) * k), k } });
  }, nodeId);
  await page.waitForTimeout(500);
}

async function shot(page, name) {
  const file = join(OUT, `mock-${String(shots.length + 1).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file });
  shots.push(file);
  return file;
}

async function traceUntil(runId, predicate, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let afterSeq = 0;
  const events = [];
  while (Date.now() < deadline) {
    const res = await cli(['agent', 'trace', '--run', runId, '--after-seq', String(afterSeq)]);
    const view = res.final?.data;
    for (const event of view?.events || []) { events.push(event); afterSeq = Math.max(afterSeq, event.seq); }
    if (predicate(view, events)) return { view, events };
    await sleep(400);
  }
  throw new Error('trace wait timed out for ' + runId);
}

const key = name => `e2e-${name}-${Date.now()}`;

async function main() {
  mkdirSync(OUT, { recursive: true });
  // 中继：用 wrangler dev 跑真实的 worker/index.ts + Durable Object（本地 workerd）。
  const relayConfig = join(STATE, 'wrangler.e2e.jsonc');
  writeFileSync(relayConfig, JSON.stringify({
    name: 'iris-link-e2e',
    main: join(ROOT, 'worker/index.ts'),
    compatibility_date: '2026-07-01',
    compatibility_flags: ['nodejs_compat'],
    durable_objects: { bindings: [{ name: 'IRIS_LINK', class_name: 'IrisLinkRelay' }] },
    migrations: [{ tag: 'v1-iris-link', new_sqlite_classes: ['IrisLinkRelay'] }],
    vars: { LINK_ALLOWED_ORIGINS: BASE, LINK_PUBLIC_URL: BASE },
  }, null, 2));
  startChild('mock-llm', process.execPath, ['scripts/e2e-cli-link-mock-llm.mjs', String(MOCK_PORT)]);
  startChild('relay', join(ROOT, 'node_modules/.bin/wrangler'), ['dev', '--config', relayConfig, '--port', String(RELAY_PORT), '--ip', '127.0.0.1', '--persist-to', join(STATE, 'relay')], { CI: '1', WRANGLER_SEND_METRICS: 'false' });
  startChild('vite', join(ROOT, 'node_modules/.bin/vite'), ['--port', String(VITE_PORT), '--strictPort'], { IRIS_WEB_PORT: String(VITE_PORT), IRIS_LINK_DEV_RELAY: `http://127.0.0.1:${RELAY_PORT}`, VITE_IRIS_MOCK: '1' });
  await waitHttp(`http://127.0.0.1:${MOCK_PORT}/v1/models`, 30_000);
  await waitHttp(`http://127.0.0.1:${RELAY_PORT}/api/link/nope`, 90_000);
  await waitHttp(BASE + '/', 120_000);

  const browser = await chromium.launch({ args: ['--no-proxy-server'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on('pageerror', error => logs.push('pageerror: ' + error.message));
  page.on('console', message => { if (message.type() === 'error') logs.push('console: ' + message.text().slice(0, 300)); });
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 600_000 });
  // 冷启动：vite 首次编译整张模块图可能要几分钟；新浏览器配置没有项目时不一定有画布，先等应用能 import 模块再播种。
  await page.waitForFunction(async () => { try { await import('/components/workflow/store.ts'); return true; } catch { return false; } }, null, { timeout: 900_000, polling: 2000 });
  await page.waitForTimeout(2500);
  await seed(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-workflow-node-id="img-hero"]', { timeout: 600_000 });
  await waitHost(page);

  // 1. 配对：CLI 发起，页面确认。
  let pairing = null;
  const login = cli(['login', 'web', '--open', '--url', BASE, '--name', 'e2e-sandbox', '--scopes', 'agent.read,agent.run,agent.approve,tools.invoke'], {
    onLine: line => { if (line.event === 'pairing') pairing = line.data; },
  });
  const pairDeadline = Date.now() + 30_000;
  while (!pairing && Date.now() < pairDeadline) await sleep(200);
  expect(pairing, 'pairing code printed');
  await page.goto(pairing.verificationUrlComplete, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="iris-link-client"]', { timeout: 120_000 });
  await page.check('[data-testid="iris-link-scope-agent.approve"]');
  await page.check('[data-testid="iris-link-scope-tools.invoke"]');
  await shot(page, 'pair-dialog');
  await page.check('[data-testid="iris-link-code-confirm"]');
  await page.click('[data-testid="iris-link-allow"]');
  await page.waitForSelector('[data-testid="iris-link-linked"]', { timeout: 30_000 });
  await shot(page, 'paired');
  const loginResult = record('login-web', await login, { code: pairing.code });
  expect(loginResult.final?.ok, 'login web succeeded');
  await page.click('[data-testid="iris-link-linked"] button');
  await page.waitForSelector('[data-workflow-node-id="img-hero"]', { timeout: 120_000 });
  await waitHost(page);

  // 2. link status：标签页在线、模型是 mock、没有 Key。
  let status;
  for (let i = 0; i < 40; i += 1) {
    status = await cli(['link', 'status', '--target', 'web']);
    if (status.final?.data?.tab?.agent?.ready) break;
    await sleep(500);
  }
  record('link-status', status);
  expect(status.final?.data?.tab?.agent?.model?.id === 'mock-chat', 'tab reports mock model');
  expect(!JSON.stringify(status.lines).includes('sk-mock'), 'no key leaves the tab');

  // 3. 普通回答，--follow 流式轨迹。
  const answer = record('agent-send-answer-follow', await cli(['agent', 'send', '--prompt', '[e2e:answer] 用一句话介绍 Iris', '--follow', '--idempotency-key', key('answer'), '--target', 'web']));
  expect(answer.final?.data?.phase === 'done', 'answer done');

  // 4. 非付费审批：CLI 看到 APPROVAL_PENDING，页面托盘也显示，CLI 批准（已授予 agent.approve）。
  const approvalSend = record('agent-send-approval', await cli(['agent', 'send', '--prompt', '[e2e:approval] 写一条备注', '--idempotency-key', key('approval'), '--target', 'web']));
  const approvalRun = approvalSend.final.data.runId;
  const pendingNote = await traceUntil(approvalRun, view => view?.code === 'APPROVAL_PENDING');
  await page.waitForSelector('[data-testid="iris-link-approval"]', { timeout: 15_000 });
  await shot(page, 'approval-pending-tray');
  const approve = record('agent-approve', await cli(['agent', 'approve', '--run', approvalRun, '--idempotency-key', key('approve'), '--target', 'web']));
  expect(approve.final?.ok, 'cli approved non-paid step');
  const noteTrace = record('agent-trace-approval-follow', await cli(['agent', 'trace', '--run', approvalRun, '--follow', '--target', 'web']));
  expect(noteTrace.final?.data?.phase === 'done', 'approval run done');
  steps[steps.length - 1].approval = pendingNote.view.approval;

  // 5. 付费审批：CLI 批准被拒（APPROVAL_REQUIRES_USER），只能拒绝。
  const paidSend = record('agent-send-paid', await cli(['agent', 'send', '--prompt', '[e2e:paid] 重新生成主角定妆', '--idempotency-key', key('paid'), '--target', 'web']));
  const paidRun = paidSend.final.data.runId;
  const paidPending = await traceUntil(paidRun, view => view?.code === 'APPROVAL_PENDING');
  await page.waitForSelector('[data-testid="iris-link-approval"]', { timeout: 15_000 });
  await shot(page, 'paid-approval-tray');
  const paidApprove = record('agent-approve-paid-refused', await cli(['agent', 'approve', '--run', paidRun, '--idempotency-key', key('paid-approve'), '--target', 'web']));
  expect(paidApprove.final?.error?.code === 'APPROVAL_REQUIRES_USER', 'paid approval refused for the CLI');
  record('agent-deny-paid', await cli(['agent', 'deny', '--run', paidRun, '--idempotency-key', key('paid-deny'), '--target', 'web']));
  const paidDone = record('agent-trace-paid-follow', await cli(['agent', 'trace', '--run', paidRun, '--follow', '--target', 'web']));
  expect(['done', 'error'].includes(paidDone.final?.data?.phase), 'paid run ended');
  steps[steps.length - 1].approval = paidPending.view.approval;

  // 6. --canvas：回合落成画布会话卡。
  const canvasRun = record('agent-send-canvas-follow', await cli(['agent', 'send', '--prompt', '[e2e:canvas] 看看画布', '--canvas', '--follow', '--idempotency-key', key('canvas'), '--target', 'web']));
  expect(canvasRun.final?.data?.cardNodeId, 'canvas card created');
  await page.waitForSelector('[data-testid="agent-session-card"]', { timeout: 15_000 });
  await focusNode(page, canvasRun.final.data.cardNodeId);
  await sleep(600);
  await shot(page, 'canvas-session-card');

  // 7. 取消：画布卡上的长思考，CLI 取消。
  const cancelSend = record('agent-send-cancel', await cli(['agent', 'send', '--prompt', '[e2e:cancel] 很长的思考', '--canvas', '--idempotency-key', key('cancel'), '--target', 'web']));
  const cancelRun = cancelSend.final.data.runId;
  await traceUntil(cancelRun, (_view, events) => events.some(event => event.type === 'thinking'));
  await focusNode(page, cancelSend.final.data.cardNodeId);
  await shot(page, 'cancel-running-card');
  record('agent-cancel', await cli(['agent', 'cancel', '--run', cancelRun, '--idempotency-key', key('cancel-stop'), '--target', 'web']));
  const cancelled = record('agent-trace-cancel-follow', await cli(['agent', 'trace', '--run', cancelRun, '--follow', '--target', 'web']));
  expect(cancelled.final?.data?.phase === 'cancelled', 'cancel run cancelled');
  await sleep(600);
  await shot(page, 'cancelled-card');

  // 8. 会话、工具。
  record('agent-sessions', await cli(['agent', 'sessions', '--target', 'web']));
  const tools = record('agent-tools-list', await cli(['agent', 'tools', 'list', '--target', 'web']));
  expect((tools.final?.data?.tools || []).length > 5, 'tools listed');
  const dry = record('agent-tools-invoke-dry-run', await cli(['agent', 'tools', 'invoke', '--tool', 'iris_workflow_node_run', '--args-json', '{"nodeId":"img-hero"}', '--target', 'web']));
  expect(dry.final?.data?.mode === 'dry-run' && dry.final?.data?.paid === true, 'dry-run flags paid tool');
  const exec = record('agent-tools-invoke-execute', await cli(['agent', 'tools', 'invoke', '--tool', 'iris_workflow_inspect', '--args-json', '{"summary":true}', '--execute', '--idempotency-key', key('inspect'), '--target', 'web']));
  expect(exec.final?.data?.phase === 'done', 'read tool executed');

  // 9. 脚本化场景报告。
  const e2e = record('agent-e2e', await cli(['agent', 'e2e', '--out', OUT, '--target', 'web'], { timeoutMs: 600_000 }));
  await shot(page, 'after-e2e');

  // 10. 关标签页：CLI 收到 TAB_OFFLINE。
  await page.close();
  await sleep(1500);
  const offline = record('agent-sessions-tab-closed', await cli(['agent', 'sessions', '--target', 'web']));
  expect(offline.final?.error?.code === 'TAB_OFFLINE', 'TAB_OFFLINE after the tab closed');

  // 11. logout：服务端撤销 + 删本地文件。
  const logout = record('logout', await cli(['logout']));
  expect(logout.final?.data?.serverRevoked === true, 'logout revoked on the relay');
  const after = record('link-status-after-logout', await cli(['link', 'status', '--target', 'web']));
  expect(after.final?.error?.code === 'NOT_LINKED', 'no link after logout');

  await browser.close();
  return { e2eOk: e2e.final?.ok === true, e2eSummary: e2e.final?.data?.summary ?? e2e.final?.error };
}

let outcome = null;
let failure = null;
try {
  outcome = await main();
} catch (error) {
  failure = error instanceof Error ? error.stack || error.message : String(error);
} finally {
  const mockLog = await fetch(`http://127.0.0.1:${MOCK_PORT}/log`).then(res => res.json()).catch(() => null);
  for (const { child } of children) { try { child.kill('SIGTERM'); } catch { /* gone */ } }
  const summary = {
    label: 'Mock',
    note: '端到端只用本地 mock 模型（scripts/e2e-cli-link-mock-llm.mjs），没有调用任何真实模型，也没有产生费用。',
    generatedAt: new Date().toISOString(),
    ok: !failure && Boolean(outcome?.e2eOk),
    failure,
    agentE2e: outcome?.e2eSummary ?? null,
    steps,
    screenshots: shots,
    mockModelRequests: mockLog,
    logs: logs.slice(-80),
    processOutput: Object.fromEntries(children.map(item => [item.name, item.output().slice(-4000)])),
  };
  writeFileSync(join(OUT, 'e2e-cli-link.mock.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify({ ok: summary.ok, failure: failure ? failure.split('\n')[0] : null, steps: steps.length, screenshots: shots.length, agentE2e: summary.agentE2e }));
  process.exit(summary.ok ? 0 : 1);
}
