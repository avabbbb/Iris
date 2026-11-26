// CLI Skill command group + WebUI opener — the coding-agent-facing surface of
// the local Skill ecosystem. All commands are deterministic and print a
// machine-readable result object via the CLI wrapper.
import fs from 'node:fs/promises';
import { platform } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { readSkillPackageEntries, SkillRegistry } from './skill-registry.js';
import { parseProductionSkillManifest, safeSkillPackageName } from './skill-package.js';
import { buildSkillDraft, evaluateSkillDraft } from './skill-draft.js';
import {
  assertInstallableHubUrl,
  fetchHubSkillList,
  fetchHubSkillPackage,
  normalizeHubUrl,
  SkillHubError,
} from './skill-hub.js';
import { readWebDiscovery } from './web-discovery.js';
import { buildBrowserBootstrapUrl, inspectLocalAgent, issueBrowserBootstrapToken, probeWebUi, readLocalAgentConnection } from './local-agent.js';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

// 受信的 https 线上 WebUI 主机：web.open 仅对这些来源附带一次性 bootstrap token。
// 可用 IRIS_TRUSTED_WEB_HOSTS="a.example,b.example" 追加（仅 https、默认端口）；须与 Agent 侧一致。
// flovart.avabbbb.com：2026-11-20 更名过渡期仍受信（旧站继续可用），迁移完成后删除。
const DEFAULT_TRUSTED_WEB_HOSTS = ['iris.avabbbb.com', 'flovart.avabbbb.com'];

function isTrustedWebOrigin(origin) {
  let url;
  try { url = new URL(origin); } catch { return false; }
  if (url.protocol !== 'https:' || url.port) return false;
  const extra = String(process.env.IRIS_TRUSTED_WEB_HOSTS || '').split(',').map(item => item.trim().toLowerCase()).filter(Boolean);
  return [...DEFAULT_TRUSTED_WEB_HOSTS, ...extra].includes(url.hostname.toLowerCase());
}

// Default local WebUI endpoints, in probe order (dev Vite first, then toolkit web).
// Override with IRIS_WEBUI_PORTS="http://127.0.0.1:8080,http://127.0.0.1:9000".
const DEFAULT_WEBUI_CANDIDATES = [
  'http://127.0.0.1:37522',   // source-mode Vite dev server (vite.config.ts port)
  'http://127.0.0.1:11451',   // toolkit/cloud web service (dev-commands.js URLS.web)
];

function webuiCandidates() {
  const raw = String(process.env.IRIS_WEBUI_PORTS || '').trim();
  const discovered = readWebDiscovery()?.url;
  if (!raw) return [...new Set([...(discovered ? [discovered] : []), ...DEFAULT_WEBUI_CANDIDATES])];
  const candidates = raw.split(',').map(item => item.trim()).filter(Boolean);
  return candidates.length ? [...new Set([...(discovered ? [discovered] : []), ...candidates])] : DEFAULT_WEBUI_CANDIDATES;
}

const SKILL_COMMAND_NAMES = new Set([
  'skill.list',
  'skill.manifest',
  'skill.install',
  'skill.uninstall',
  'skill.hub.list',
  'skill.init',
  'skill.validate',
  'skill.draft',
  'receipts.list',
  'web.open',
]);

export { SKILL_COMMAND_NAMES };

function error(code, message) {
  return { ok: false, error: { code, message, retryable: false } };
}

function okResult(result) {
  return { ok: true, ...result };
}

function resolveProjectDir(raw) {
  return path.resolve(String(raw || process.cwd()));
}

function scaffoldSkillFiles(id, handle, displayName) {
  const manifest = [
    'schemaVersion: flovart.production-skill/1',
    'id: ' + id,
    'version: 0.1.0',
    'runtime:',
    '  minVersion: 0.3.0',
    'capabilities:',
    '  - image.generate',
    '  - video.generate',
    'permissions:',
    '  network: none',
    '  secrets: none',
    '  filesystem: package-readonly',
    'gates:',
    '  - id: approve-spec',
    '    type: spec',
    'license: MIT',
    'inputs:',
    '  - id: topic',
    '    label: ' + JSON.stringify('主题或 Brief'),
    '    kind: longtext',
    '    required: true',
    '    placeholder: ' + JSON.stringify('在这里填写主题或粘贴 Brief'),
    '',
  ].join('\n');
  const skill = [
    '---',
    'name: ' + handle,
    'description: ' + JSON.stringify(displayName + '：把主题编译成可审片的 Iris 制作计划'),
    '---',
    '',
    '# ' + displayName,
    '',
    '1. 读取 inputs（topic 等），先输出叙事节拍与视觉方案，等待用户确认（gate: approve-spec）。',
    '2. 确认后按镜头创建 Iris 节点；付费生成必须经过确认或自动模式的授权上限。',
    '3. 输出 ProductionSpec，供审片与复跑。',
    '',
  ].join('\n');
  const openai = [
    'interface:',
    '  display_name: ' + JSON.stringify(displayName),
    '  short_description: ' + JSON.stringify(displayName + ' 制作计划 Skill'),
    '  default_prompt: ' + JSON.stringify('Use $' + handle + ' to turn my topic into a Iris production plan.'),
    '',
  ].join('\n');
  return { 'flovart.skill.yaml': manifest, 'SKILL.md': skill, 'agents/openai.yaml': openai };
}

// Workspace Adapter 依赖懒加载：只有 receipts.list / skill.draft --from-project 需要连本地 Agent 服务。
async function defaultWorkspaceClient() {
  const { IrisWorkspaceClient } = await import('./workspace-client.js');
  return new IrisWorkspaceClient();
}

// 读取某个工程的共享回执（本地 Agent 服务 GET /receipts），供 skill.draft 沉淀步骤。
export async function listProjectReceipts(client, projectId, limit = 200) {
  const query = new URLSearchParams();
  if (projectId) query.set('projectId', String(projectId));
  query.set('limit', String(Math.max(1, Math.min(200, Number(limit) || 200))));
  const body = await client.request('/receipts?' + query.toString());
  return { projectId: body?.projectId || projectId || null, receipts: Array.isArray(body?.receipts) ? body.receipts : [] };
}

// 从可见 Workspace 读取任意工程（含历史画布）组成 skill.draft 快照：workflow.inspect + 回执。
export async function snapshotFromProject(client, projectId) {
  const raw = await client.execute('workflow.inspect', { projectId }, 'cli');
  // 浏览器 dispatcher 回包是 { ok, commandId, result }；兼容直接返回工程的实现。
  const project = raw && raw.result && Array.isArray(raw.result.nodes) ? raw.result : raw;
  if (!project || !Array.isArray(project.nodes)) throw new Error('workflow.inspect 没有返回工程节点：' + projectId);
  let receipts = [];
  try {
    receipts = (await listProjectReceipts(client, project.id || projectId)).receipts;
  } catch {
    receipts = []; // 回执是可选上下文；Agent 服务没有回执时只用画布子图。
  }
  return { projectId: project.id || projectId, project, receipts };
}

export async function runSkillCommand(command, args = {}, deps = {}) {
  const getWorkspace = async () => deps.workspace || await defaultWorkspaceClient();
  const projectDir = resolveProjectDir(args.projectDir ?? args['project-dir']);
  const id = String(args.id || args.skillId || args._?.[0] || '').trim();

  switch (command) {
    case 'skill.list': {
      const registry = new SkillRegistry({ repoRoot: projectDir });
      const skills = await registry.scan();
      const roots = [];
      for (const root of registry.roots) roots.push({ root, exists: await dirExists(root) });
      return okResult({
        command,
        projectDir,
        roots,
        skills,
      });
    }

    case 'skill.manifest': {
      if (!id) return error('INVALID_ARGUMENT', 'skill.manifest 需要 <id>（如 community.demo）。');
      const registry = new SkillRegistry({ repoRoot: projectDir });
      try {
        return okResult({ command, manifest: await registry.manifest(id) });
      } catch (cause) {
        return error('NOT_FOUND', cause instanceof Error ? cause.message : String(cause));
      }
    }

    case 'skill.install': {
      if (!id) return error('INVALID_ARGUMENT', 'skill.install 需要 <id>（如 community.demo）。');
      const registry = new SkillRegistry({ repoRoot: projectDir });
      const hubUrl = String(args.hubUrl ?? args['hub-url'] ?? '').trim();
      const fromDir = String(args.fromDir ?? args['from-dir'] ?? '').trim();
      if (!hubUrl && !fromDir) {
        return error('INVALID_ARGUMENT', 'skill.install 需要 --hub-url <url>（外站 Hub）或 --from-dir <dir>（本地目录）。');
      }
      try {
        let files;
        let version;
        if (fromDir) {
          const entries = await readSkillPackageEntries(path.resolve(fromDir));
          if (!entries.length) return error('PACKAGE_REJECTED', `本地目录没有可读的 Skill 包：${fromDir}`);
          files = entries;
        } else {
          const normalized = assertInstallableHubUrl(hubUrl);
          const pkg = await fetchHubSkillPackage(normalized, id);
          if (pkg.id !== id) return error('PACKAGE_REJECTED', 'Skill 包 id 与请求不一致。');
          version = pkg.version;
          files = pkg.files;
        }
        const skill = await registry.installPackage({ id, version: version ?? undefined, files });
        return okResult({ command, id, skill, installRoot: registry.installRoot });
      } catch (cause) {
        const known = ['INVALID_URL', 'UNREACHABLE', 'PACKAGE_REJECTED'].includes(cause?.code)
          ? cause.code
          : 'REJECTED';
        return error(known, cause instanceof Error ? cause.message : String(cause));
      }
    }

    case 'skill.uninstall': {
      if (!id) return error('INVALID_ARGUMENT', 'skill.uninstall 需要 <id>。');
      const registry = new SkillRegistry({ repoRoot: projectDir });
      try {
        await registry.uninstall(id);
        return okResult({ command, id, installRoot: registry.installRoot });
      } catch (cause) {
        return error('REJECTED', cause instanceof Error ? cause.message : String(cause));
      }
    }

    case 'skill.hub.list': {
      const hubUrl = String(args.hubUrl ?? args['hub-url'] ?? args._?.[0] ?? '').trim();
      if (!hubUrl) return error('INVALID_ARGUMENT', 'skill.hub.list 需要 Hub 地址（位置参数或 --hub-url）。');
      let normalized;
      try {
        normalized = normalizeHubUrl(hubUrl);
      } catch (cause) {
        return error('INVALID_URL', cause instanceof Error ? cause.message : String(cause));
      }
      try {
        const skills = await fetchHubSkillList(normalized);
        return okResult({ command, hubUrl: normalized, skills });
      } catch (cause) {
        return error(cause?.code || 'UNREACHABLE', cause instanceof Error ? cause.message : String(cause));
      }
    }

    case 'skill.init': {
      if (!id) return error('INVALID_ARGUMENT', 'skill.init 需要 <id>（如 community.my-skill）。');
      if (!safeSkillPackageName(id)) return error('INVALID_ARGUMENT', '无效的 Skill id：' + id);
      const handle = id.split('.').at(-1);
      const dir = path.resolve(String(args.dir || path.join(projectDir, '.agents', 'skills', handle)));
      if (await dirExists(dir)) return error('ALREADY_EXISTS', '目录已存在，拒绝覆盖：' + dir);
      const files = scaffoldSkillFiles(id, handle, String(args.name || handle));
      try {
        parseProductionSkillManifest(files['flovart.skill.yaml']);
      } catch (cause) {
        return error('REJECTED', cause instanceof Error ? cause.message : String(cause));
      }
      for (const [relative, content] of Object.entries(files)) {
        const target = path.join(dir, relative);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, content, 'utf8');
      }
      return okResult({ command, id, dir, files: Object.keys(files), next: ['skill.validate --from-dir ' + dir, 'skill.install ' + id + ' --from-dir ' + dir] });
    }

    // 画布 / 对话转 Skill：--from-project 直接读可见 Workspace 里的工程（含历史画布）与回执；
    // --from-snapshot 为离线快照 { projectId, project: workflow.inspect 的工程, receipts: receipts.list 的回执 }。
    // 默认只写草稿到 .agents/skill-drafts/<handle>；带 --install 且基础验收全部通过才入库。
    case 'skill.draft': {
      if (!id) return error('INVALID_ARGUMENT', 'skill.draft 需要 <id>（如 community.my-flow）。');
      const snapshotPath = String(args.fromSnapshot ?? args['from-snapshot'] ?? '').trim();
      const fromProject = String(args.fromProject ?? args['from-project'] ?? '').trim();
      if (!snapshotPath && !fromProject) return error('INVALID_ARGUMENT', 'skill.draft 需要 --from-project <projectId>（可先 workflow.project.list 选历史画布）或 --from-snapshot <json>。');
      if (snapshotPath && fromProject) return error('INVALID_ARGUMENT', '--from-project 与 --from-snapshot 只能二选一。');
      let snapshot;
      if (fromProject) {
        try {
          snapshot = await snapshotFromProject(await getWorkspace(), fromProject);
        } catch (cause) {
          return error(cause?.code || 'WORKSPACE_UNAVAILABLE', '无法读取工程 ' + fromProject + '：' + (cause instanceof Error ? cause.message : String(cause)));
        }
      } else {
        try {
          snapshot = JSON.parse(await fs.readFile(path.resolve(snapshotPath), 'utf8'));
        } catch (cause) {
          return error('INVALID_ARGUMENT', '无法读取快照：' + (cause instanceof Error ? cause.message : String(cause)));
        }
      }
      let draft;
      try {
        draft = buildSkillDraft({
          id,
          name: args.name,
          description: args.description,
          projectId: snapshot?.projectId || snapshot?.project?.id,
          project: snapshot?.project || snapshot,
          receipts: snapshot?.receipts,
          nodeIds: Array.isArray(args.nodeIds)
            ? args.nodeIds.map(String)
            : typeof args.nodes === 'string' ? args.nodes.split(',').map(item => item.trim()).filter(Boolean) : snapshot?.nodeIds,
        });
      } catch (cause) {
        return error('INVALID_ARGUMENT', cause instanceof Error ? cause.message : String(cause));
      }
      const evaluation = evaluateSkillDraft(draft.files, id);
      const dir = path.resolve(String(args.dir || path.join(projectDir, '.agents', 'skill-drafts', draft.handle)));
      if (await dirExists(dir)) return error('ALREADY_EXISTS', '草稿目录已存在，拒绝覆盖：' + dir);
      for (const [relative, content] of Object.entries(draft.files)) {
        const target = path.join(dir, relative);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, content, 'utf8');
      }
      const files = Object.keys(draft.files);
      if (!args.install) {
        return okResult({ command, id, dir, files, evaluation, next: evaluation.ok ? ['skill.install ' + id + ' --from-dir ' + dir] : [] });
      }
      if (!evaluation.ok) {
        return { ok: false, error: { code: 'EVALUATION_FAILED', message: '基础验收未通过，草稿未入库：' + dir, retryable: false }, dir, evaluation };
      }
      try {
        const registry = new SkillRegistry({ repoRoot: projectDir });
        const skill = await registry.installPackage({ id, files: Object.entries(draft.files).map(([entryPath, content]) => ({ path: entryPath, content })) });
        return okResult({ command, id, dir, files, evaluation, skill, installed: true });
      } catch (cause) {
        return error('REJECTED', cause instanceof Error ? cause.message : String(cause));
      }
    }

    case 'receipts.list': {
      const projectId = String(args.projectId ?? args['project-id'] ?? args._?.[0] ?? '').trim();
      try {
        const result = await listProjectReceipts(await getWorkspace(), projectId, args.limit);
        return okResult({ command, ...result });
      } catch (cause) {
        return error(cause?.code || 'WORKSPACE_UNAVAILABLE', cause instanceof Error ? cause.message : String(cause));
      }
    }

    case 'skill.validate': {
      const fromDir = String(args.fromDir ?? args['from-dir'] ?? args._?.[0] ?? '').trim();
      if (!fromDir) return error('INVALID_ARGUMENT', 'skill.validate 需要 --from-dir <dir>。');
      const dir = path.resolve(fromDir);
      try {
        const entries = await readSkillPackageEntries(dir);
        const manifestEntry = entries.find(entry => entry.path === 'flovart.skill.yaml');
        if (!manifestEntry) return error('PACKAGE_REJECTED', '缺少 flovart.skill.yaml：' + dir);
        const manifest = parseProductionSkillManifest(manifestEntry.content);
        const warnings = entries.some(entry => entry.path === 'SKILL.md') ? [] : ['缺少 SKILL.md：Agent 无法读取执行说明'];
        return okResult({ command, dir, manifest, fileCount: entries.length, warnings });
      } catch (cause) {
        return error('PACKAGE_REJECTED', cause instanceof Error ? cause.message : String(cause));
      }
    }

    case 'web.open': {
      const explicit = String(args.url ?? '').trim();
      try {
        const result = await openWebUiDetailed(explicit, { opener: args.opener });
        return okResult({
          command,
          opened: result.opened,
          method: 'native-opener',
          bootstrapped: result.bootstrapped,
          ...(result.bootstrapReason ? { bootstrapReason: result.bootstrapReason } : {}),
        });
      } catch (cause) {
        return error(cause?.code || 'NO_WEBUI', cause instanceof Error ? cause.message : String(cause));
      }
    }

    default:
      return error('UNKNOWN_COMMAND', `未知 Skill 命令：${command}`);
  }
}

const dirExists = async dir => {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
};

// ---- WebUI opener (native OS hand-off) ----

async function probeCandidate(candidate, timeoutMs = 600) {
  return Boolean(await probeWebUi(candidate, { timeoutMs }).catch(() => null));
}

function isLoopbackUrl(value) {
  try { return LOOPBACK_HOSTS.has(new URL(value).hostname); } catch { return false; }
}

const WEB_OPEN_AGENT_TIMEOUT_MS = 2000;

async function openVerifiedWebUi(target, verified = true, opener = openUrlNative) {
  let openTarget = target;
  let bootstrapped = false;
  let bootstrapReason = null;
  if (!verified) {
    bootstrapReason = 'unverified-origin';
  } else {
    try {
      const connection = readLocalAgentConnection();
      if (!connection) {
        bootstrapReason = 'agent-not-configured';
      } else {
        const inspected = await inspectLocalAgent(connection, { timeoutMs: WEB_OPEN_AGENT_TIMEOUT_MS });
        if (inspected.state !== 'ready') {
          bootstrapReason = 'agent-' + (inspected.state || 'offline');
        } else {
          const bootstrapToken = await issueBrowserBootstrapToken(connection, { timeoutMs: WEB_OPEN_AGENT_TIMEOUT_MS });
          openTarget = buildBrowserBootstrapUrl(target, { ...connection, bootstrapToken });
          bootstrapped = true;
        }
      }
    } catch (cause) {
      // A plain WebUI remains a valid fallback when the optional Browser Agent is offline,
      // but surface the reason (without any secrets) so callers know no bootstrap link was attached.
      bootstrapReason = cause?.code ? String(cause.code) : 'bootstrap-failed';
    }
  }
  opener(openTarget);
  return { opened: target, bootstrapped, ...(bootstrapReason ? { bootstrapReason } : {}) };
}

export async function openWebUiDetailed(explicitUrl = '', options = {}) {
  const opener = typeof options.opener === 'function' ? options.opener : openUrlNative;
  let target = explicitUrl.trim();
  if (target) {
    const url = new URL(target);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new SkillHubError('INVALID_URL', 'web.open 只接受 http(s) 地址。');
    }
    target = url.toString();
    // 本机 WebUI 需先探活；受信的 https 线上站直接附带一次性 bootstrap token，任意外部站点不附带。
    const verified = (isLoopbackUrl(target) && await probeCandidate(target)) || isTrustedWebOrigin(url.origin);
    return openVerifiedWebUi(target, verified, opener);
  }
  for (const candidate of webuiCandidates()) {
    if (await probeCandidate(candidate)) {
      return openVerifiedWebUi(candidate, true, opener);
    }
  }
  throw Object.assign(new Error('没有发现运行中的 Iris WebUI。请先运行 `iris start --source --web --open`；源码仓库可使用 `npm run iris:cli -- start --source --web --open`，不要单独运行 `npm run dev` 来建立 Agent 连接。'), { code: 'NO_WEBUI' });
}

export async function openWebUi(explicitUrl = '', options = {}) {
  return (await openWebUiDetailed(explicitUrl, options)).opened;
}

/** Open a URL with the OS default browser without shell-parsing bootstrap query strings. */
export function openUrlNative(url) {
  const { cmd, args } = buildNativeOpenCommand(url);
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', shell: false, windowsHide: true });
    child.on('error', () => { /* openers are best-effort */ });
    child.unref();
  } catch {
    // best-effort: opener failure surfaces as NO_WEBUI only when probing found nothing
  }
}

// rundll32 url.dll 会丢掉 & 之后的 bootstrapToken；PowerShell 单引号字面量原样传整条 URL。
export function buildNativeOpenCommand(url, os = platform()) {
  return os === 'win32'
    ? { cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', "Start-Process '" + url.replace(/'/g, "''") + "'"] }
    : { cmd: os === 'darwin' ? 'open' : 'xdg-open', args: [url] };
}
