import { statSync } from 'node:fs';
import { agentConfigPath, inspectLocalAgent, probeWebUi, readLocalAgentConnection } from './local-agent.js';
import { readWebDiscovery, webDiscoveryPath } from './web-discovery.js';
import { IrisRuntimeClient } from './runtime-client.js';

const DEFAULT_FRONTEND_URLS = Object.freeze([
  'http://127.0.0.1:37522',
  'http://127.0.0.1:11451',
]);

function frontendCandidates(env = process.env) {
  const explicit = String(env.IRIS_WEB_URL || '').trim();
  if (explicit) return [explicit];
  const configured = String(env.IRIS_WEBUI_PORTS || '').split(',').map(value => value.trim()).filter(Boolean);
  const discovered = readWebDiscovery(env)?.url;
  return [...new Set([...(discovered ? [discovered] : []), ...(configured.length ? configured : DEFAULT_FRONTEND_URLS)])];
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function frontendProbeTimeoutMs(url) {
  try {
    return LOOPBACK_HOSTS.has(new URL(url).hostname) ? 800 : 3000;
  } catch {
    return 800;
  }
}

async function probeFrontend(url, fetchImpl = globalThis.fetch) {
  return Boolean(await probeWebUi(url, { fetchImpl, timeoutMs: frontendProbeTimeoutMs(url) }).catch(() => null));
}

export async function getLocalStatus(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const frontendUrl = (typeof fetchImpl === 'function'
    ? (await firstReachable(frontendCandidates(options.env || process.env), fetchImpl))
    : null);
  const runtimeStatus = await readRuntimeStatus(options);

  let agent;
  let connection = null;
  try {
    connection = readLocalAgentConnection({ env: options.env || process.env, configPath: options.configPath });
    agent = await inspectLocalAgent(connection, { fetchImpl, timeoutMs: options.timeoutMs || 800 });
  } catch (cause) {
    agent = { state: 'auth_failed', connection: null, health: null, protocol: null, error: cause instanceof Error ? cause.message : String(cause) };
  }

  const health = agent.health || {};
  const browserConnected = agent.state === 'ready' && Number(health.clients || 0) > 0 && Boolean(health.hasWorkflow);
  const desktopReady = Boolean(runtimeStatus && browserConnected);
  const status = {
    ready: Boolean((agent.state === 'ready' && browserConnected) || desktopReady),
    runtime: runtimeStatus
      ? { status: 'ready', surface: 'desktop-runtime', version: runtimeStatus.runtimeVersion }
      : { status: 'offline', surface: 'desktop-runtime' },
    frontend: { status: frontendUrl || runtimeStatus ? 'ready' : 'offline', url: frontendUrl },
    agent: { status: agent.state, url: agent.connection?.url || null },
    browser: {
      connected: browserConnected,
      clientId: health.clientId || null,
      projectId: health.activeProjectId || null,
      revision: numericOrNull(health.revision),
      clients: Number(health.clients || 0),
      hasWorkflow: Boolean(health.hasWorkflow),
      activeHostWriter: health.activeHostWriter || null,
    },
    browserConnected,
    clientId: health.clientId || null,
    projectId: health.activeProjectId || null,
    revision: numericOrNull(health.revision),
    activeHostWriter: health.activeHostWriter || null,
  };
  if (agent.error) status.agent.error = agent.error;
  status.diagnostics = buildStatusDiagnostics({
    env: options.env || process.env,
    configPath: options.configPath,
    connection,
    agentState: agent.state,
    agentError: agent.error,
    health,
    frontendUrl,
    statFile: options.statFile,
  });
  return status;
}

/** 脱敏：只留末 4 位。 */
export function maskSecret(value) {
  const text = String(value || '');
  if (!text) return null;
  return text.length <= 8 ? '****' : '****' + text.slice(-4);
}

function defaultStatFile(path) {
  try {
    const stat = statSync(path);
    return { exists: true, modifiedAt: stat.mtime.toISOString(), bytes: stat.size };
  } catch {
    return { exists: false };
  }
}

/**
 * status 增强（libtv-docs-study D.4-3）：回答"为什么突然报 WORKSPACE_UNAVAILABLE"。
 * 给出绑定的项目 / writer、凭据来源（脱敏）、本机状态文件的修改时间，以及按顺序排查出的第一个原因。
 */
export function buildStatusDiagnostics({ env = process.env, configPath, connection, agentState, agentError, health = {}, frontendUrl, statFile = defaultStatFile } = {}) {
  const agentConfig = configPath || agentConfigPath(env);
  const credentialSource = configPath
    ? 'option:configPath'
    : env.IRIS_AGENT_CONFIG ? 'env:IRIS_AGENT_CONFIG'
      : env.IRIS_AGENT_HOME ? 'env:IRIS_AGENT_HOME'
        : 'default:~/.iris/agent.json';
  const agentFile = { name: 'agent.json', path: agentConfig, ...statFile(agentConfig) };
  const webFilePath = webDiscoveryPath(env);
  const webFile = { name: 'web.json', path: webFilePath, ...statFile(webFilePath) };
  const writer = health.activeHostWriter || null;
  const binding = {
    projectId: health.activeProjectId || null,
    clientId: health.clientId || null,
    revision: numericOrNull(health.revision),
    writer: writer ? {
      agentIdentity: writer.agentIdentity || null,
      ...(writer.hostSessionId ? { hostSessionId: writer.hostSessionId } : {}),
      ...(writer.projectId ? { projectId: writer.projectId } : {}),
    } : null,
  };
  let reason = null;
  if (!agentFile.exists) reason = { code: 'AGENT_CONFIG_MISSING', message: '找不到本机 Agent 配置 ' + agentConfig + '：先运行 iris ensure 启动本地 Agent，或用 IRIS_AGENT_CONFIG 指向正确的文件。' };
  else if (agentState === 'auth_failed') reason = { code: 'AGENT_AUTH_FAILED', message: 'Agent 配置存在但无法认证（' + (agentError || 'token 无效') + '）：配置可能在 ' + (agentFile.modifiedAt || '最近') + ' 被重写，重启 CLI 宿主或重新 ensure。' };
  else if (agentState !== 'ready') reason = { code: 'AGENT_OFFLINE', message: '本机 Agent 未就绪（' + (agentState || 'unknown') + '）：运行 iris ensure。' };
  else if (!Number(health.clients || 0)) reason = { code: 'BROWSER_NOT_CONNECTED', message: '没有打开的 Iris 页面连到 Agent：在浏览器或桌面端打开 Iris' + (frontendUrl ? '（' + frontendUrl + '）' : '') + '。' };
  else if (!health.hasWorkflow) reason = { code: 'NO_ACTIVE_WORKFLOW', message: 'Iris 页面已连接，但没有激活的 Workflow 项目：在画布里打开一个项目。' };
  return {
    credential: {
      source: credentialSource,
      configPath: agentConfig,
      token: maskSecret(connection?.token),
      agentUrl: connection?.url || null,
    },
    binding,
    stateFiles: [agentFile, webFile],
    workspaceUnavailableReason: reason,
  };
}

async function readRuntimeStatus(options) {
  try {
    const client = options.runtimeClient || new IrisRuntimeClient({
      discoveryPath: options.runtimeDiscoveryPath,
      timeoutMs: options.timeoutMs || 800,
    });
    return await client.status();
  } catch {
    return null;
  }
}

async function firstReachable(candidates, fetchImpl) {
  for (const candidate of candidates) {
    try {
      const url = new URL(candidate);
      if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) continue;
      if (await probeFrontend(url.toString(), fetchImpl)) return url.origin;
    } catch { /* ignore invalid local configuration */ }
  }
  return null;
}

function numericOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export { DEFAULT_FRONTEND_URLS, frontendCandidates };
