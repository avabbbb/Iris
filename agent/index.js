import '../tools/iris/legacy-bootstrap.js';
import http from 'node:http';
import fs from 'node:fs';
import { BootstrapCredentialError, BootstrapCredentialStore } from './bootstrap-credentials.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_AGENT_PORT, loadAgentConfig } from './config.js';
import { persistAgentConfig } from './persist-config.js';
import { IrisAgentService } from './iris.js';
import { createIrisAgentTools, createIrisPipelineTools } from './tools.js';
import { SkillRegistry, BUNDLED_SKILL_IDS } from './skill-registry.js';
import { WorkflowAgentSession, WorkflowAgentSessionError } from './session.js';
import { prepareAgentHostProjection } from './host-projection.js';
import { importIrisModule, importIrisPipelineModule } from './iris-modules.js';
import { ReceiptError, ReceiptStore } from './receipts.js';
import { createFileTaskStore } from './task-store.js';
import { AgentCredentialStore, CredentialError } from './credentials.js';

const { discoverAgentHosts } = await importIrisModule('host-discovery');
const { getAgentIdentity } = await importIrisModule('host-registry');
const { getCanonicalRegistry } = await importIrisModule('registry');
const { AGENT_PUBLIC_COMMAND_SET } = await importIrisModule('agent-surface');
const { readWebDiscovery } = await importIrisModule('web-discovery');

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT_ROOT = path.resolve(process.env.IRIS_PROJECT_DIR || REPOSITORY_ROOT);
const WORKSPACE_ONLY = process.env.IRIS_WORKSPACE_ONLY === '1';

const json = (response, status, body) => {
  // SSE 等流式端点可能已经写出响应头：二次 writeHead 会抛 ERR_HTTP_HEADERS_SENT
  // 并击穿进程，此时只能降级为补写一行 SSE error 事件后收尾。
  if (response.headersSent || response.writableEnded) {
    try {
      if (!response.writableEnded && !response.destroyed) {
        response.write(`event: error\ndata: ${JSON.stringify(body)}\n\n`);
        response.end();
      }
    } catch { /* connection already closed */ }
    return;
  }
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body, (key, value) => key === 'stack' || key === 'cause' ? undefined : value));
};

const MAX_BODY_BYTES = 36 * 1024 * 1024;

const readBody = request => new Promise((resolve, reject) => {
  // 用 Buffer 数组收集、end 时统一解码，避免字符串累加切断跨 chunk 的多字节 UTF-8 字符。
  const chunks = [];
  let bytes = 0;
  let failed = false;
  request.on('data', chunk => {
    if (failed) return;
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) {
      failed = true;
      reject(new Error('request body too large'));
      return;
    }
    chunks.push(chunk);
  });
  request.on('end', () => {
    if (failed) return;
    try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
    catch (error) { reject(error); }
  });
  request.on('error', reject);
});

const requestToken = request => String(request.headers['x-flovart-agent-token'] || '');
// 持久 token 只接受 header 通道，避免长期凭证经 URL query 泄漏到日志/历史；
// 短期一次性 session token 保留 query 通道（EventSource 无法自定义 header）。
const validPersistentToken = (request, token) => Boolean(token) && requestToken(request) === token;

const validToken = (request, url, token, credentials) => (
  validPersistentToken(request, token)
  || credentials.isSessionToken(url.searchParams.get('token'))
  || credentials.isSessionToken(requestToken(request))
);

function isLoopbackOrigin(origin) {
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' && new Set(['127.0.0.1', 'localhost', '[::1]']).has(url.hostname);
  } catch {
    return false;
  }
}

// 可发起 bootstrap 交换的浏览器来源：本机 loopback HTTP，或受信的 https 线上站（默认官方站，
// 可用 IRIS_TRUSTED_WEB_HOSTS 逗号分隔追加主机名，须与启动器一致）。bootstrap token 一次性、120s 过期，
// 只由本机启动器签发；持久 token 从不离开启动器。
// flovart.avabbbb.com：2026-11-20 更名过渡期仍受信（旧站继续可用），迁移完成后删除。
const DEFAULT_TRUSTED_WEB_HOSTS = ['iris.avabbbb.com', 'flovart.avabbbb.com'];

function isTrustedWebOrigin(origin) {
  let url;
  try { url = new URL(origin); } catch { return false; }
  if (url.protocol !== 'https:' || url.port) return false;
  const extra = String(process.env.IRIS_TRUSTED_WEB_HOSTS || '').split(',').map(item => item.trim().toLowerCase()).filter(Boolean);
  return [...DEFAULT_TRUSTED_WEB_HOSTS, ...extra].includes(url.hostname.toLowerCase());
}

// DSH Desktop serves its app from the dsh-app:// custom scheme. The embedded
// Iris page exchanges there, and no website can claim that scheme, so it is
// an app origin rather than a web origin. Local CLI/processes can already send
// loopback origins; this adds no browser-reachable path.
function isDshDesktopOrigin(origin) {
  try {
    const url = new URL(origin);
    return url.protocol === 'dsh-app:' && url.hostname === 'app';
  } catch {
    return false;
  }
}

function isBootstrapOrigin(origin) {
  return isLoopbackOrigin(origin) || isTrustedWebOrigin(origin) || isDshDesktopOrigin(origin);
}

const MAX_AUTHORIZED_ORIGINS = 8;

// 已授权来源列表；兼容旧版单值 config.origin。
function authorizedOrigins(config) {
  const list = Array.isArray(config.origins) ? config.origins.filter(item => typeof item === 'string' && item) : [];
  if (config.origin && !list.includes(config.origin)) list.push(config.origin);
  return list;
}

// 本机开发站与线上站可同时连接，不再互相抢占单一 origin 绑定。
function rememberOrigin(config, origin) {
  const list = authorizedOrigins(config).filter(item => item !== origin);
  config.origins = [origin, ...list].slice(0, MAX_AUTHORIZED_ORIGINS);
  config.origin = origin;
  persistAgentConfig(config, 'authorized origin');
}

function originTokenAllowed(request, url, config, credentials) {
  return authorizedOrigins(config).includes(request.headers.origin)
    || credentials.isSessionToken(url.searchParams.get('token'))
    || credentials.isSessionToken(requestToken(request));
}

function setCors(request, response, url, config, credentials) {
  const origin = request.headers.origin;
  // 无 Origin 的本机 CLI/脚本调用没有 CORS 语义，不再无条件回写 ACAO。
  if (!origin) return true;
  response.setHeader('Vary', 'Origin');
  const applyCorsHeaders = () => {
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Access-Control-Allow-Headers', 'content-type,x-flovart-agent-token,x-flovart-bootstrap-token');
    response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    response.setHeader('Access-Control-Allow-Private-Network', 'true');
  };
  // 预检响应体不会被页面脚本读取，数据面判定在随后的实际请求上执行；
  // 首次绑定 origin 的 bootstrap 流程依赖预检可达。
  if (request.method === 'OPTIONS') {
    applyCorsHeaders();
    return true;
  }
  if (url.pathname === '/bootstrap/exchange') {
    const allowed = isBootstrapOrigin(origin);
    if (allowed) applyCorsHeaders();
    return allowed;
  }
  if (url.pathname === '/bootstrap/issue') return false;
  // /health、/config 是无鉴权就绪探针：保持跨源可读（浏览器首连依赖），
  // 未授权来源的响应字段已在路由层收敛为最小就绪信号。
  if (url.pathname === '/health' || url.pathname === '/config') {
    applyCorsHeaders();
    return true;
  }
  // 其余端点先完成 origin/token 判定，仅判定通过时才回写 ACAO。
  // 持久 token 或有效 session token 通过时把来源记入已授权列表（不替换其它来源）。
  const tokenOk = validPersistentToken(request, config.token)
    || credentials.isSessionToken(url.searchParams.get('token'))
    || credentials.isSessionToken(requestToken(request));
  if (tokenOk && !authorizedOrigins(config).includes(origin)) rememberOrigin(config, origin);
  const allowed = originTokenAllowed(request, url, config, credentials);
  if (allowed) applyCorsHeaders();
  return allowed;
}

export function startHttpServer() {
  const config = loadAgentConfig(true);
  const requestedPort = process.env.IRIS_AGENT_PORT === '0'
    ? 0
    : Number(process.env.IRIS_AGENT_PORT) || Number(new URL(config.url).port) || DEFAULT_AGENT_PORT;
  const bootstrapCredentials = new BootstrapCredentialStore();
  // webUrl 惰性解析：WebUI 往往晚于 Agent 启动；IRIS_WEB_URL 可显式覆盖。
  const session = new WorkflowAgentSession({
    isKnownAgentIdentity: id => Boolean(getAgentIdentity(id)),
    taskStore: createFileTaskStore(),
    webUrl: () => process.env.IRIS_WEB_URL || readWebDiscovery()?.url || null,
  });
  const receiptStore = new ReceiptStore();
  // 让会话内的复合命令（如 workflow.batch.pick）能写 decision 回执。
  session.receiptStore = receiptStore;
  const credentialStore = new AgentCredentialStore();
  // /crew/protocol 仍是对外 readiness 握手（local-agent.js inspectLocalAgent
  // 与 CLI bootstrap/status 路径依赖）。Crew/Director 业务面已移除，这里只保留
  // 协议版本与 Registry Hash 的自报能力。
  const canonicalRegistry = getCanonicalRegistry();
  const protocolDescriptor = () => ({
    protocolVersion: canonicalRegistry.protocolVersion,
    registryHash: canonicalRegistry.registryHash,
    capabilities: ['command', 'events'],
    limits: { maxPayloadBytes: 1024 * 1024, eventRetention: 10000 },
  });
  const skillRegistry = new SkillRegistry({ repoRoot: PROJECT_ROOT });
  const iris = WORKSPACE_ONLY ? null : new IrisAgentService({
    tools: [
      ...createIrisAgentTools((...args) => session.callCommand(...args)),
      ...createIrisPipelineTools((...args) => session.callCommand(...args)),
    ],
  });

  const activeSse = new Set();
  const trackSse = response => {
    activeSse.add(response);
    response.on('close', () => activeSse.delete(response));
  };

  const server = http.createServer(async (request, response) => {
    let url;
    try {
      // 鉴权热路径纳入 try/catch：URL 解析、CORS/origin 判定、bootstrap 与
      // token 校验的异常只影响当前请求，不再击穿进程。
      url = new URL(request.url || '/', config.url);
      bootstrapCredentials.expire();
      if (!setCors(request, response, url, config, bootstrapCredentials)) return json(response, 403, { ok: false, error: 'origin not allowed' });
      if (request.method === 'OPTIONS') return json(response, 200, { ok: true });
      if (url.pathname === '/health') {
        const health = session.health();
        // 带 Origin 但未通过 origin/token 判定的调用（任意网站的脚本）只拿就绪信号；
        // 本机 CLI/脚本（无 Origin）与已授权来源仍拿全量状态。
        if (request.headers.origin && !originTokenAllowed(request, url, config, bootstrapCredentials)) {
          return json(response, 200, { ok: true, serviceMode: WORKSPACE_ONLY ? 'workspace-only' : 'agent', hasWorkflow: Boolean(health.hasWorkflow) });
        }
        return json(response, 200, { ...health, serviceMode: WORKSPACE_ONLY ? 'workspace-only' : 'agent' });
      }
      if (url.pathname === '/config') {
        if (request.headers.origin && !originTokenAllowed(request, url, config, bootstrapCredentials)) {
          return json(response, 200, { ok: true });
        }
        return json(response, 200, { ok: true, url: config.url, hasToken: true, originBound: Boolean(config.origin) });
      }
      if (request.method === 'POST' && url.pathname === '/bootstrap/issue') {
        if (request.headers.origin || !validPersistentToken(request, config.token)) {
          return json(response, 401, { ok: false, error: { code: 'BOOTSTRAP_ISSUE_UNAUTHORIZED', message: '只能由本机启动器签发 Browser bootstrap credential。' } });
        }
        return json(response, 200, { ok: true, ...bootstrapCredentials.issue() });
      }
      if (request.method === 'POST' && url.pathname === '/bootstrap/exchange') {
        try {
          const exchanged = bootstrapCredentials.exchange(request.headers['x-flovart-bootstrap-token']);
          return json(response, 200, { ok: true, ...exchanged });
        } catch (error) {
          const known = error instanceof BootstrapCredentialError ? error : new BootstrapCredentialError('BOOTSTRAP_INVALID', 'Browser bootstrap credential 无效。');
          return json(response, 401, { ok: false, error: known.toJSON() });
        }
      }
      if (!validToken(request, url, config.token, bootstrapCredentials)) return json(response, 401, { ok: false, error: 'invalid token' });
    } catch (error) {
      return json(response, 500, { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Agent 服务处理失败，请重试。' } });
    }

    try {
      if (request.method === 'GET' && url.pathname === '/events') {
        try {
          session.openEvents(url, response);
        } catch {
          // openEvents 已写出 SSE 头时，json() 内部会降级为单行 error 事件收尾，
          // 避免对已发送响应二次 writeHead。
          json(response, 500, { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Agent 服务处理失败，请重试。' } });
          return;
        }
        trackSse(response);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/hosts') {
        return json(response, 200, {
          ...discoverAgentHosts({
            refresh: url.searchParams.get('refresh') === 'true',
            includeVersion: url.searchParams.get('includeVersion') !== 'false',
          }),
          activeHostWriter: session.hostWriterState(),
        });
      }
      if (request.method === 'POST' && url.pathname === '/hosts/prepare') {
        const body = await readBody(request);
        const result = prepareAgentHostProjection({
          agentIdentity: body.agentIdentity || body.host,
          projectDir: PROJECT_ROOT,
        });
        const status = result.ok ? 200 : result.error?.code === 'HOST_UNAVAILABLE' ? 409 : 400;
        return json(response, status, result);
      }
      if (request.method === 'POST' && url.pathname === '/host/activate') {
        const body = await readBody(request);
        const agentIdentity = String(body.agentIdentity || body.host || '').trim().toLowerCase();
        const host = discoverAgentHosts({ includeVersion: false }).agents.find(item => item.id === agentIdentity);
        if (!host?.available && host?.status !== 'manual-import') {
          return json(response, 409, { ok: false, error: { code: 'HOST_UNAVAILABLE', message: `${agentIdentity || '该 Agent Host'} 当前未在本机就绪。` } });
        }
        return json(response, 200, { ok: true, ...session.activateAgentHost({
          agentIdentity,
          hostSessionId: body.hostSessionId || body['host-session-id'],
          projectId: body.projectId || body['project-id'],
        }) });
      }
      if (request.method === 'GET' && url.pathname === '/workspace/lease') {
        return json(response, 200, { ok: true, leases: session.workspaceLeaseState() });
      }
      if (url.pathname === '/credentials' || url.pathname.startsWith('/credentials/')) {
        // Agent-side keyring vault: secrets go in, only masked metadata comes out.
        try {
          if (request.method === 'GET' && url.pathname === '/credentials') {
            const status = await credentialStore.status();
            const credentials = await credentialStore.list(url.searchParams.get('provider') || undefined);
            return json(response, 200, { ok: true, ...status, credentials });
          }
          if (request.method === 'POST' && url.pathname === '/credentials/set') {
            return json(response, 200, { ok: true, credential: await credentialStore.set(await readBody(request)) });
          }
          if (request.method === 'POST' && url.pathname === '/credentials/delete') {
            return json(response, 200, { ok: true, removed: await credentialStore.delete(await readBody(request)) });
          }
          if (request.method === 'POST' && url.pathname === '/credentials/report-sync') {
            return json(response, 200, { ok: true, sync: credentialStore.reportSync(await readBody(request)) });
          }
        } catch (error) {
          if (error instanceof CredentialError) {
            return json(response, error.code === 'INVALID_INPUT' ? 400 : 503, { ok: false, error: error.toJSON() });
          }
          throw error;
        }
      }
      // Agent 视频流水线用户审批：只给 Iris 界面用，不登记为任何 Agent 工具。模型只能发起审批请求（CONFIRMATION_REQUIRED），不能批准。
      if (url.pathname === '/pipeline/approvals' || url.pathname.startsWith('/pipeline/approvals/')) {
        const { getPipeline } = await importIrisPipelineModule('index');
        const pipeline = getPipeline();
        try {
          if (request.method === 'GET' && url.pathname === '/pipeline/approvals') {
            return json(response, 200, { ok: true, approvals: pipeline.listApprovals(url.searchParams.get('runId') ? { runId: url.searchParams.get('runId') } : {}) });
          }
          const decision = /^\/pipeline\/approvals\/(apr_[0-9a-f-]{36})\/(grant|deny)$/.exec(url.pathname);
          if (request.method === 'POST' && decision) {
            // 批准只接受已授权的 Iris 页面来源（浏览器带 Origin）；无 Origin 的本机脚本 / CLI 不能替用户批准。
            if (decision[2] === 'grant' && !authorizedOrigins(config).includes(request.headers.origin)) {
              return json(response, 403, { ok: false, error: { code: 'APPROVAL_ORIGIN_REQUIRED', message: '只能在 Iris 界面批准' } });
            }
            const approval = decision[2] === 'grant' ? pipeline.grantApproval(decision[1]) : pipeline.denyApproval(decision[1]);
            return json(response, 200, { ok: true, approval });
          }
          return json(response, 404, { ok: false, error: 'not found' });
        } catch (error) {
          const code = error?.code || 'PIPELINE_ERROR';
          return json(response, code === 'APPROVAL_NOT_FOUND' ? 404 : 500, { ok: false, error: { code, message: error?.message || String(error) } });
        }
      }
      // Agent 视频流水线：抽屉“运行日志”按 run 分组读取 trace；只读，写操作仍只走命令边界。
      if (request.method === 'GET' && url.pathname.startsWith('/pipeline/')) {
        const { getPipeline } = await importIrisPipelineModule('index');
        const pipeline = getPipeline();
        try {
          if (url.pathname === '/pipeline/runs') {
            return json(response, 200, { ok: true, runs: pipeline.listRuns({ projectId: url.searchParams.get('projectId') || undefined, limit: url.searchParams.get('limit') }) });
          }
          const runMatch = /^\/pipeline\/runs\/([A-Za-z0-9_-]{1,80})$/.exec(url.pathname);
          if (runMatch) return json(response, 200, { ok: true, trace: pipeline.trace(runMatch[1], Number(url.searchParams.get('since')) || 0) });
          const artifactMatch = /^\/pipeline\/artifacts\/([A-Za-z0-9_:-]{1,120})$/.exec(url.pathname);
          if (artifactMatch) {
            const file = pipeline.artifactFile(artifactMatch[1]);
            response.writeHead(200, { 'content-type': file.mime, 'content-length': file.bytes, 'cache-control': 'private, max-age=31536000, immutable' });
            return fs.createReadStream(file.path).pipe(response);
          }
          return json(response, 404, { ok: false, error: 'not found' });
        } catch (error) {
          const code = error?.code || 'PIPELINE_ERROR';
          return json(response, code === 'RUN_NOT_FOUND' || code === 'ARTIFACT_NOT_FOUND' ? 404 : 500, { ok: false, error: { code, message: error?.message || String(error) } });
        }
      }
      if (request.method === 'GET' && url.pathname === '/activity') {
        return json(response, 200, {
          ok: true,
          activity: session.activityLog(url.searchParams.get('limit')),
          clients: session.clientsView(),
          activeHostWriter: session.hostWriterState(),
          leases: session.workspaceLeaseState(),
          serverTime: new Date().toISOString(),
        });
      }
      if (url.pathname === '/receipts' && (request.method === 'GET' || request.method === 'POST')) {
        // Project-level shared context: read-only receipts any Agent can add and read.
        try {
          if (request.method === 'GET') {
            const projectId = url.searchParams.get('projectId') || session.snapshot?.id || '';
            const receipts = projectId ? await receiptStore.list(projectId, url.searchParams.get('limit')) : [];
            return json(response, 200, { ok: true, projectId: projectId || null, receipts });
          }
          const body = await readBody(request);
          const items = Array.isArray(body.receipts) ? body.receipts : [body];
          const fallbackProjectId = session.snapshot?.id || null;
          const agentIdentity = body.agentIdentity || session.hostWriterState()?.agentIdentity || null;
          const result = await receiptStore.appendMany(
            items.map(item => ({ ...item, projectId: item?.projectId || fallbackProjectId })),
            { agentIdentity },
          );
          result.added.forEach(receipt => session.emit('receipt', receipt));
          return json(response, 200, { ok: true, added: result.added.length, skipped: result.skipped, receipts: result.added });
        } catch (error) {
          if (error instanceof ReceiptError) return json(response, 400, { ok: false, error: { code: error.code, message: error.message } });
          throw error;
        }
      }
      if (request.method === 'POST' && url.pathname === '/workspace/lease/acquire') {
        const body = await readBody(request);
        return json(response, 200, { ok: true, lease: session.acquireWorkspaceLease(body) });
      }
      if (request.method === 'POST' && url.pathname === '/workspace/lease/validate') {
        const body = await readBody(request);
        return json(response, 200, { ok: true, lease: session.validateWorkspaceLease(body) });
      }
      if (request.method === 'POST' && url.pathname === '/workspace/lease/renew') {
        const body = await readBody(request);
        return json(response, 200, { ok: true, lease: session.renewWorkspaceLease(body.leaseId) });
      }
      if (request.method === 'POST' && url.pathname === '/workspace/lease/release') {
        const body = await readBody(request);
        return json(response, 200, { ok: true, released: session.releaseWorkspaceLease(body.leaseId) });
      }
      if (request.method === 'POST' && url.pathname === '/workspace/lease/expire') {
        return json(response, 200, { ok: true, leases: session.expireWorkspaceLeases() });
      }
      if (request.method === 'POST' && url.pathname === '/workflow/state') {
        session.updateSnapshot(await readBody(request), url.searchParams.get('clientId') || undefined);
        return json(response, 200, { ok: true });
      }
      if (request.method === 'POST' && url.pathname === '/workflow/activate') {
        const body = await readBody(request);
        return json(response, 200, { ok: true, activeWriter: session.activateClient({
          clientId: body.clientId || url.searchParams.get('clientId'),
          projectId: body.projectId || url.searchParams.get('projectId'),
        }) });
      }
      if (request.method === 'POST' && url.pathname === '/workflow/result') {
        session.resolveResult(await readBody(request));
        return json(response, 200, { ok: true });
      }
      if (request.method === 'GET' && url.pathname === '/crew/protocol') {
        return json(response, 200, { ok: true, ...protocolDescriptor() });
      }
      if (request.method === 'GET' && url.pathname === '/api/skills') {
        return json(response, 200, { ok: true, skills: await skillRegistry.scan() });
      }
      if (request.method === 'GET' && /^\/api\/skills\/[^/]+\/file$/.test(url.pathname)) {
        // 内置 Agent 的 iris_skill_read：只读 SKILL.md 与 references/、commands/ 下的文件，越界路径 400。
        const id = decodeURIComponent(url.pathname.split('/').at(-2));
        try {
          const file = await skillRegistry.readFile(id, url.searchParams.get('path') || 'SKILL.md');
          return json(response, 200, { ok: true, file });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const notFound = /不在本机注册表|里没有文件/.test(message);
          return json(response, notFound ? 404 : 400, { ok: false, error: { message } });
        }
      }
      if (request.method === 'GET' && /^\/api\/skills\/[^/]+$/.test(url.pathname)) {
        const id = decodeURIComponent(url.pathname.split('/').at(-1));
        let manifest;
        try {
          manifest = await skillRegistry.manifest(id);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const notFound = /不在本机注册表|无效的 Skill id/.test(message);
          return json(response, notFound ? 404 : 400, { ok: false, error: { message } });
        }
        return json(response, 200, { ok: true, manifest });
      }
      if (request.method === 'POST' && url.pathname === '/api/skills/install') {
        const body = await readBody(request);
        const id = String(body.id || '');
        const hubUrl = String(body.hubUrl || '');
        let hub;
        try {
          hub = new URL(hubUrl);
        } catch {
          return json(response, 400, { ok: false, error: { message: 'Skill Hub 地址无效。' } });
        }
        const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
        const loopbackHttp = hub.protocol === 'http:' && loopbackHosts.has(hub.hostname);
        if (hub.protocol !== 'https:' && !loopbackHttp) {
          return json(response, 400, { ok: false, error: { message: 'Skill Hub 只允许 https 或本机 loopback http。' } });
        }
        let packageResponse;
        try {
          // 下载加 30s 超时，避免失联/恶意的 Skill Hub 挂住请求。
          packageResponse = await fetch(new URL(`/api/skills/${encodeURIComponent(id)}/package.json`, hub.origin), { signal: AbortSignal.timeout(30_000) });
        } catch {
          return json(response, 502, { ok: false, error: { message: `无法从 Skill Hub 下载 ${id}。` } });
        }
        if (!packageResponse.ok) {
          return json(response, 502, { ok: false, error: { message: `Skill Hub 返回 HTTP ${packageResponse.status}。` } });
        }
        let packageBuffer;
        try {
          packageBuffer = await packageResponse.arrayBuffer();
        } catch {
          return json(response, 502, { ok: false, error: { message: `无法从 Skill Hub 下载 ${id}。` } });
        }
        if (packageBuffer.byteLength > 8 * 1024 * 1024) {
          return json(response, 400, { ok: false, error: { message: 'Skill 包超过 8MB 大小上限。' } });
        }
        let pkg = null;
        try {
          pkg = JSON.parse(Buffer.from(packageBuffer).toString('utf8'));
        } catch { /* 解析失败走下方统一的 400 分支 */ }
        if (!pkg || typeof pkg !== 'object' || String(pkg.id) !== id) {
          return json(response, 400, { ok: false, error: { message: 'Skill 包格式无效。' } });
        }
        try {
          const skill = await skillRegistry.installPackage({
            id,
            version: typeof pkg.version === 'string' ? pkg.version : undefined,
            files: Array.isArray(pkg.files) ? pkg.files : [],
          });
          return json(response, 200, { ok: true, skill });
        } catch (error) {
          return json(response, 400, { ok: false, error: { message: error instanceof Error ? error.message : String(error) } });
        }
      }
      if (request.method === 'POST' && url.pathname === '/api/skills/draft') {
        // 画布（当前或历史工程）→ Production Skill：浏览器送来脱敏后的节点与连线，
        // 回执从本机回执库取；验收通过且 install=true 才入库，失败只回验收结果。
        const body = await readBody(request);
        const { buildSkillDraft, evaluateSkillDraft } = await importIrisModule('skill-draft');
        const id = String(body.id || '');
        const projectId = String(body.projectId || body.project?.id || '');
        let draft;
        try {
          const receipts = projectId ? await receiptStore.list(projectId, 200) : [];
          draft = buildSkillDraft({
            id,
            name: body.name,
            description: body.description,
            projectId,
            project: body.project && typeof body.project === 'object' ? body.project : {},
            receipts,
            nodeIds: Array.isArray(body.nodeIds) ? body.nodeIds.map(String) : [],
          });
        } catch (error) {
          return json(response, 400, { ok: false, error: { message: error instanceof Error ? error.message : String(error) } });
        }
        const evaluation = evaluateSkillDraft(draft.files, id);
        const summary = { id, handle: draft.handle, files: Object.keys(draft.files), skillMd: draft.files['SKILL.md'] };
        if (!body.install || !evaluation.ok) return json(response, 200, { ok: true, draft: summary, evaluation, installed: false });
        try {
          const skill = await skillRegistry.installPackage({ id, files: Object.entries(draft.files).map(([entryPath, content]) => ({ path: entryPath, content })) });
          return json(response, 200, { ok: true, draft: summary, evaluation, installed: true, skill });
        } catch (error) {
          return json(response, 400, { ok: false, error: { message: error instanceof Error ? error.message : String(error) }, evaluation });
        }
      }
      if (request.method === 'POST' && url.pathname === '/api/skills/uninstall') {
        const body = await readBody(request);
        try {
          await skillRegistry.uninstall(String(body.id || ''));
          return json(response, 200, { ok: true });
        } catch (error) {
          return json(response, 400, { ok: false, error: { message: error instanceof Error ? error.message : String(error) } });
        }
      }
      if (request.method === 'POST' && url.pathname === '/api/tools') {
        const body = await readBody(request);
        // Gate the forwarder on the same stable Agent surface the CLI/MCP
        // projections enforce — without this, any local caller could drive a
        // non-public canonical command (e.g. granular workflow.* / provider.*)
        // through the loopback endpoint, bypassing the operation gateway.
        // Exception: the trusted local launcher/CLI (no Origin header + valid
        // persistent token, the same test /bootstrap/issue uses) may call the
        // full canonical command set; browser/web origins and session tokens
        // stay restricted to the public surface.
        const command = String(body.command || '');
        const trustedLocalCli = !request.headers.origin && validPersistentToken(request, config.token);
        if (!trustedLocalCli && !AGENT_PUBLIC_COMMAND_SET.has(command)) {
          return json(response, 400, { ok: false, error: { code: 'UNKNOWN_COMMAND', message: 'Operation is not part of the stable Agent surface: ' + command } });
        }
        const result = await session.callCommand(body.command, body.args || {}, body.source || 'agent', body.idempotencyKey, undefined, body.caller);
        return json(response, 200, { ok: true, result });
      }
      if (iris && request.method === 'GET' && (url.pathname === '/agent/iris/session' || url.pathname === '/agent/flovart/session')) {
        const projectId = url.searchParams.get('projectId') || 'default';
        return json(response, 200, { ok: true, ...(await iris.snapshot(projectId)) });
      }
      if (iris && request.method === 'POST' && (url.pathname === '/agent/iris/turn' || url.pathname === '/agent/flovart/turn')) {
        const body = await readBody(request);
        const projectId = String(body.projectId || 'default');
        response.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Accel-Buffering': 'no',
        });
        trackSse(response);
        const emit = (event, data) => {
          if (response.destroyed || request.aborted) return;
          try {
            response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
          } catch (error) {
            if (error?.code === 'EPIPE' || error?.code === 'ERR_STREAM_DESTROYED') return;
            console.error('[iris-agent] SSE write failed:', error);
          }
        };
        // 每轮一个 turnId（客户端给或服务端生成）：事件只转发本轮的，取消可精确到排队中的这一轮。
        // 先订阅再入队，回合一开始的事件不会漏。非法 turnId 由 send 拒绝并作为 error 事件返回。
        const turnId = body.turnId === undefined || body.turnId === null || body.turnId === '' ? crypto.randomUUID() : String(body.turnId);
        if (iris.turnState(turnId)) {
          // 同一 turnId 已在排队或执行：不再订阅，否则会收到那一轮的流。
          emit('error', { message: `回合 ${turnId} 已在排队或执行`, code: 'TURN_ID_IN_USE', turnId });
          response.end();
          return;
        }
        const unsubscribe = await iris.subscribeTurn(projectId, turnId, event => {
          const update = event.type === 'message_update' ? event.assistantMessageEvent : undefined;
          if (update?.type === 'text_delta') emit('text-delta', { delta: update.delta });
          if (update?.type === 'thinking_delta') emit('thinking-delta', { delta: update.delta });
          if (event.type === 'agent_start') emit('status', { running: true, turnId });
          if (event.type === 'tool_execution_start') emit('tool-start', {
            id: event.toolCallId,
            name: event.toolName,
            args: event.args,
          });
          if (event.type === 'tool_execution_update') emit('tool-update', {
            id: event.toolCallId,
            name: event.toolName,
            partial: event.partialResult,
          });
          if (event.type === 'tool_execution_end') emit('tool-end', {
            id: event.toolCallId,
            name: event.toolName,
            result: event.result,
            isError: event.isError,
          });
        });
        const run = iris.send(projectId, String(body.prompt || ''), [], body.skillAttachment, { turnId });
        // 客户端在排队阶段就断开：这一轮没人收流，直接出队，不再启动。执行中的回合仍由显式 cancel 停止。
        response.on('close', () => {
          if (!response.writableFinished && iris.turnState(turnId) === 'queued') void iris.cancel(projectId, turnId);
        });
        if (iris.turnState(turnId)) emit('turn', { turnId, state: iris.turnState(turnId) });
        try {
          const snapshot = await run;
          emit('snapshot', { ...snapshot, turnId });
        } catch (error) {
          emit('error', { message: error instanceof Error ? error.message : String(error), ...(error?.code ? { code: error.code } : {}), turnId });
        } finally {
          unsubscribe();
          response.end();
        }
        return;
      }
      if (iris && request.method === 'POST' && (url.pathname === '/agent/iris/cancel' || url.pathname === '/agent/flovart/cancel')) {
        const body = await readBody(request);
        const outcome = await iris.cancel(String(body.projectId || 'default'), body.turnId);
        return json(response, 200, { ok: true, ...outcome });
      }
      return json(response, 404, { ok: false, error: 'not found' });
    } catch (error) {
      if (error instanceof WorkflowAgentSessionError) {
        const status = ['AGENT_WRITER_INACTIVE', 'AGENT_HOST_REQUIRED', 'AGENT_HOST_SESSION_MISMATCH', 'AGENT_PROJECT_INACTIVE', 'LEASE_EXPIRED', 'LEASE_TARGET_CHANGED', 'REVISION_CONFLICT'].includes(error.code)
          ? 409
          : error.code === 'WORKSPACE_UNAVAILABLE' ? 503
            : error.code === 'COMMAND_TIMEOUT' ? 504
              : error.code === 'CANCELLED' ? 499
                : 400;
        return json(response, status, { ok: false, error: error.toJSON() });
      }
      return json(response, 500, { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Agent 服务处理失败，请重试。' } });
    }
  });

  const listen = port => {
    server.once('error', error => {
      if (error?.code === 'EADDRINUSE' && port !== 0 && process.env.IRIS_AGENT_PORT !== '0') {
        listen(0);
        return;
      }
      console.error(`[iris-agent] unable to listen on localhost:${port}: ${error?.message || error}`);
      process.exitCode = 1;
    });
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      config.url = `http://127.0.0.1:${actualPort}`;
      if (!persistAgentConfig(config, 'listen url')) console.warn('[iris-agent] agent.json does not record ' + config.url + '; clients reading it may use a stale URL.');
      console.log(WORKSPACE_ONLY ? 'Iris Workspace Operator' : 'Iris Agent');
      console.log(`Local URL: ${config.url}`);
    });
  };
  listen(requestedPort);
  const close = () => {
    if (iris) void iris.close();
    for (const res of activeSse) {
      try { res.end(); } catch { /* SSE connection already closed */ }
    }
    activeSse.clear();
    server.close();
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  return server;
}

startHttpServer();
