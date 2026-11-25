import { CANONICAL_COMMAND_REGISTRY } from './registry.js';

export const COMMAND_REGISTRY = CANONICAL_COMMAND_REGISTRY;

export const COMMANDS = Object.keys(COMMAND_REGISTRY);

export const COMMAND_ALIASES = {
  iris_agent_turn: 'agent.turn',
  iris_task_start: 'agent.task.start',
  iris_task_get: 'agent.task.get',
  iris_task_cancel: 'agent.task.cancel',
  iris_workflow_project_list: 'workflow.project.list',
  iris_workflow_project_create: 'workflow.project.create',
  iris_workflow_project_use: 'workflow.project.use',
  iris_workflow_project_delete: 'workflow.project.delete',
  iris_workflow_inspect: 'workflow.inspect',
  iris_workflow_selection_get: 'workflow.selection.get',
  iris_workflow_apply: 'workflow.apply',
  iris_workflow_node_create: 'workflow.node.create',
  iris_workflow_node_create_connected: 'workflow.node.create-connected',
  iris_workflow_node_update: 'workflow.node.update',
  iris_workflow_node_delete: 'workflow.node.delete',
  iris_workflow_node_move: 'workflow.node.move',
  iris_workflow_node_resize: 'workflow.node.resize',
  iris_workflow_node_tool: 'workflow.node.tool',
  iris_image_tool: 'workflow.image.tool',
  iris_video_tool: 'workflow.video.tool',
  iris_audio_tool: 'workflow.audio.tool',
  iris_workflow_connect: 'workflow.connect',
  iris_workflow_disconnect: 'workflow.disconnect',
  iris_workflow_select: 'workflow.select',
  iris_workflow_viewport_set: 'workflow.viewport.set',
  iris_workflow_focus_nodes: 'workflow.focus.nodes',
  iris_workflow_node_run: 'workflow.node.run',
  iris_workflow_node_stop: 'workflow.node.stop',
  iris_generate: 'workflow.generate',
  iris_workflow_generate: 'workflow.generate',
  iris_models_list: 'workflow.models.list',
  iris_shortcut_list: 'workflow.shortcut.list',
  iris_shortcut_apply: 'workflow.shortcut.apply',
  iris_group_create: 'workflow.group.create',
  iris_group_run: 'workflow.group.run',
  iris_workflow_search_nodes: 'workflow.nodes.search',
  iris_cost_estimate: 'workflow.cost.estimate',
  iris_estimate_cost: 'workflow.cost.estimate',
  iris_node_tool_list: 'workflow.node.tool.list',
  iris_workflow_node_tool_list: 'workflow.node.tool.list',
  iris_note_write: 'workflow.note.write',
  iris_media_import: 'workflow.media.import',
  iris_script_materialize: 'workflow.script.materialize',
  iris_export: 'workflow.export',
  iris_workflow_export: 'workflow.export',
  gen: 'generate.image',
  iris_generate_image: 'generate.image',
  iris_generate_video: 'generate.video',
  models: 'models.list',
  doctor: 'doctor',
  preferences: 'preferences.manage',
  prefs: 'preferences.manage',
  inspire: 'inspiration.search',
  enhance: 'prompt.enhance',
  plan: 'batch.plan',
};

function getCommandAliases(command) {
  return Object.entries(COMMAND_ALIASES)
    .filter(([, target]) => target === command)
    .map(([alias]) => alias);
}

export const QUICK_COMMANDS = [
  'status',
  'provider.status',
  'workflow.inspect',
  'workflow.selection.get',
  'workflow.project.list',
  'asset.list',
  'models.list',
  'doctor',
  'preferences.manage',
  'inspiration.search',
  'setup',
];

export const HELP_TEXT = [
  'Iris exposes deterministic tools for external agents through the legacy iris CLI.',
  'External Agents plan; this CLI executes explicit Iris Workflow operations.',
  '',
  'Bootstrap/admin:',
  'ensure [--no-open] [--web]                      Prepare the local Iris connection (reuses a running WebUI, starts the Agent)',
  'setup                                           Show local setup steps',
  'doctor                                          Diagnose local CLI readiness',
  'uninstall [--plan] [--json]                     Remove the installed Agent Toolkit and launcher shims',
  '',
  'Stable operations:',
  'status                                          Inspect local readiness',
  'workflow.inspect [--project-id <id>]            Inspect the active visible Workflow (--project-id must match it)',
  'workflow.selection.get [--project-id <id>]      Read the current Workflow selection',
  'workflow.apply --project-id <id> --operations-json <json> --idempotency-key <key>',
  'workflow.node.run --project-id <id> --node-id <id> --idempotency-key <key>',
  'workflow.node.run --project-id <id> --node-ids <id,id,...> --idempotency-key <key> [--wait-seconds <n> | --no-wait]',
  '',
  'Iris Link (drive Iris open in your browser; model keys never leave the browser):',
  'login web [--open | --device] [--url <https://iris.avabbbb.com>] [--scopes agent.read,agent.run,agent.approve,tools.invoke]',
  'logout                                          Revoke the web link on the relay and delete ~/.iris/link.json',
  'link status [--target local|web|auto]           Which Iris the CLI drives, tab online, granted scopes',
  'agent sessions | agent send --prompt <text> [--session <id>] [--canvas] [--follow] --idempotency-key <key>',
  'agent trace --run <runId> [--follow]            Thinking summary, tools, Skill, Memory, Context, Budget, Artifact (NDJSON)',
  'agent approve|deny|cancel --run <runId> --idempotency-key <key>   (CLI never approves paid/destructive steps)',
  'agent tools list | agent tools invoke --tool <name> [--args-json <json>] [--execute --idempotency-key <key>]',
  'agent e2e [--out <dir>] [--only answer,tool,...]  Scripted harness scenarios → trace report (JSON + Markdown)',
  '',
  'Compatibility commands remain callable and discoverable with command.list and command.schema.',
  'MCP is an optional projection; CLI + Skill is the default external-Agent path.',
].join('\n');

export const SETUP_TEXT = [
  'Iris Agent Toolkit setup (run from a source checkout):',
  '1. npm install',
  '2. npm run iris:cli -- start --source --web --open',
  '3. Enter provider credentials only in the local Iris Runtime/WebUI',
  '4. npm run iris:cli -- status --json',
  '5. npm run iris:cli -- workflow.inspect --json',
  '',
  'A published CLI package is still a release gate; the source checkout above is the verified path.',
  'Source contributors can use `npm run iris:cli -- start --source --all --open`.',
  'Never paste API keys into AI agent transcripts.',
].join('\n');

export function formatValue(value) {
  if (typeof value === 'string') return value;
  try {
    const json = JSON.stringify(value, null, 2);
    return json.length > 2200 ? `${json.slice(0, 2200)}\n...truncated` : json;
  } catch {
    return String(value);
  }
}

export function createLine(kind, content, meta) {
  return { kind, content, meta };
}

function secureId(prefix) {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID !== 'function') throw new Error('当前运行环境不支持安全随机标识。');
  return `${prefix}${cryptoApi.randomUUID()}`;
}

export function createIrisSession(initial = {}) {
  return {
    id: initial.id || secureId('iris-'),
    lastTool: initial.lastTool || '',
    isDark: !!initial.isDark,
  };
}

export function parseCliArgs(argv = []) {
  const result = { _: [] };
  const setOption = (key, value) => {
    if (key === 's' || key === 'set' || key === 'u' || key === 'update') {
      const existing = result[key];
      result[key] = existing === undefined ? [value] : Array.isArray(existing) ? [...existing, value] : [existing, value];
      return;
    }
    result[key] = value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith('-') && !token.startsWith('--') && token.length > 1) {
      const raw = token.slice(1);
      const eq = raw.indexOf('=');
      if (eq >= 0) {
        setOption(raw.slice(0, eq), raw.slice(eq + 1));
        continue;
      }

      const next = argv[index + 1];
      if (!next || next.startsWith('-')) {
        setOption(raw, true);
        continue;
      }

      setOption(raw, next);
      index += 1;
      continue;
    }

    if (!token.startsWith('--')) {
      result._.push(token);
      continue;
    }

    const raw = token.slice(2);
    const eq = raw.indexOf('=');
    if (eq >= 0) {
      setOption(raw.slice(0, eq), raw.slice(eq + 1));
      continue;
    }

    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      setOption(raw, true);
      continue;
    }

    setOption(raw, next);
    index += 1;
  }
  return result;
}

export function normalizeCommandName(name = '') {
  const trimmed = String(name).trim();
  if (COMMAND_REGISTRY[trimmed]) return trimmed;
  if (COMMAND_ALIASES[trimmed]) return COMMAND_ALIASES[trimmed];
  const dotted = trimmed.replace(/-/g, '.');
  if (COMMAND_REGISTRY[dotted]) return dotted;
  if (COMMAND_ALIASES[dotted]) return COMMAND_ALIASES[dotted];
  return dotted;
}

function findRegisteredCommand(name = '') {
  const direct = String(name || '').trim();
  if (COMMAND_REGISTRY[direct]) return direct;

  const normalized = normalizeCommandName(direct);
  if (COMMAND_REGISTRY[normalized]) return normalized;

  const equivalent = COMMANDS.find((command) => normalizeCommandName(command) === normalized);
  return equivalent || normalized;
}

function parseJsonOption(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function parseListOption(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  const parsed = parseJsonOption(value, null);
  if (Array.isArray(parsed)) return parsed;
  return value.split(',').map(item => item.trim()).filter(Boolean);
}

function normalizeWorkflowNodeToolArgs(args = {}) {
  const normalized = { ...args };
  const numberNames = ['targetLongEdge', 'rows', 'cols', 'startSec', 'endSec', 'currentTimeSec', 'speed', 'x', 'y', 'width', 'height'];
  for (const name of numberNames) {
    const alias = name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
    const value = args[name] ?? args[alias];
    if (value === undefined || value === null || value === '') continue;
    const numeric = Number(value);
    normalized[name] = Number.isFinite(numeric) ? numeric : value;
  }
  const sourceNodeIds = args.sourceNodeIds ?? args['source-node-ids'];
  if (sourceNodeIds !== undefined) normalized.sourceNodeIds = parseListOption(sourceNodeIds);
  for (const [name, alias] of [['maskNodeId', 'mask-node-id'], ['maskHref', 'mask-href'], ['maskMimeType', 'mask-mime-type']]) {
    if (normalized[name] === undefined && args[alias] !== undefined) normalized[name] = args[alias];
  }
  if (args.tool === 'rotate' && normalized.action === undefined && args.rotation !== undefined) normalized.action = args.rotation;
  return normalized;
}

// Agent 工具 v2 的命令按注册表类型标记解析 CLI 参数（--kebab-case → camelCase，数字/布尔/JSON）。
const REGISTRY_TYPED_WORKFLOW_COMMANDS = new Set(['workflow.generate', 'workflow.models.list', 'workflow.nodes.search', 'workflow.cost.estimate', 'workflow.node.tool.list', 'workflow.shortcut.list', 'workflow.shortcut.apply', 'workflow.group.create', 'workflow.group.run', 'workflow.note.write', 'workflow.media.import', 'workflow.script.materialize', 'workflow.export',
  'agent.task.start', 'agent.task.get', 'agent.task.cancel']);

function registryTypedArgs(command, args = {}) {
  const definition = COMMAND_REGISTRY[command];
  const output = {};
  for (const [name, descriptor] of Object.entries(definition?.args || {})) {
    const kebab = name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
    const raw = args[name] ?? args[kebab];
    if (raw === undefined) continue;
    const base = String(descriptor).replace(/\?$/, '');
    if (base === 'number') output[name] = typeof raw === 'number' ? raw : Number(raw);
    else if (base === 'boolean') output[name] = parseOptionalBoolean(raw) ?? raw;
    else if (base === 'array' || base === 'object') output[name] = parseJsonOption(raw, raw);
    else if (base === 'string[]') output[name] = parseListOption(raw);
    else output[name] = typeof raw === 'string' ? raw : raw;
  }
  return output;
}

function parseOptionalNumber(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function parseOptionalBoolean(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}

function updatePayloadFromArgs(args = {}) {
  const explicit = args.updates || parseJsonOption(args['updates-json'] || args.updatesJson, null);
  if (explicit && typeof explicit === 'object' && !Array.isArray(explicit)) return explicit;

  const blocked = new Set(['_', 'id', 'updates', 'updates-json', 'updatesJson', 'json']);
  const updates = {};
  for (const [key, value] of Object.entries(args)) {
    if (blocked.has(key) || value === undefined) continue;
    if (['x', 'y', 'width', 'height', 'fontSize', 'durationSec'].includes(key)) {
      const numeric = Number(value);
      if (Number.isFinite(numeric)) updates[key] = numeric;
      continue;
    }
    updates[key] = value;
  }
  return updates;
}

function coerceScalar(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (typeof value === 'string' && value.trim() !== '' && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value);
  if (typeof value === 'string' && /^[\[{]/.test(value.trim())) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

function pairsToObject(values) {
  const list = Array.isArray(values) ? values : values === undefined ? [] : [values];
  const output = {};
  for (const item of list) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      Object.assign(output, item);
      continue;
    }
    const text = String(item || '');
    const eq = text.indexOf('=');
    if (eq < 0) continue;
    output[text.slice(0, eq)] = coerceScalar(text.slice(eq + 1));
  }
  return output;
}

function commandSubcommand(args, fallback = 'list') {
  return String(args._?.[0] || args.subcommand || fallback).trim();
}

function argId(args, name = 'id') {
  return args.id || args.key || args.uuid || args[name] || args._?.[0];
}

function nodeIdArg(args) {
  return args.id || args.node || args.n || args['node-id'] || args.nodeId || args._?.[0];
}

function nodeTypeArg(args) {
  return args.type || args.t || 'image';
}

function nodeNameArg(args) {
  return args.name || args.n || args.label;
}

function buildNodeUpdates(args = {}) {
  return {
    set: {
      ...pairsToObject(args.s),
      ...pairsToObject(args.set),
      ...parseJsonOption(args['set-json'] || args.setJson, {}),
    },
    update: {
      ...pairsToObject(args.u),
      ...pairsToObject(args.update),
      ...parseJsonOption(args['update-json'] || args.updateJson, {}),
    },
  };
}

const IMAGE_SHORTCUTS = [
  {
    id: 'product-hero',
    label: 'product-hero',
    prompt: 'premium product hero image, clean commercial composition, controlled studio lighting, polished reflections, exact product identity, production-ready finish',
  },
  {
    id: 'character-board',
    label: 'character-board',
    prompt: 'character consistency reference board, same identity across poses, clear face, outfit, proportions, neutral background, production concept art',
  },
  {
    id: 'cinematic-keyframe',
    label: 'cinematic-keyframe',
    prompt: 'cinematic keyframe, clear subject action, motivated lighting, layered depth, stable composition, film still quality',
  },
  {
    id: 'scene-establishing',
    label: 'scene-establishing',
    prompt: 'wide establishing scene, readable layout, layered environment design, strong focal path, atmospheric depth, cinematic worldbuilding',
  },
];

function splitStoryboardScript(script, count) {
  const lines = String(script || '')
    .split(/\r?\n|[。！？.!?]/)
    .map((line) => line.trim())
    .filter(Boolean);
  const desired = Math.max(1, Math.min(Number(count || lines.length || 6), 24));
  if (lines.length >= desired) return lines.slice(0, desired);
  const base = lines.length ? lines : ['Storyboard shot'];
  return Array.from({ length: desired }, (_, index) => base[index % base.length]);
}

function required(value, name) {
  if (value === undefined || value === null || value === '') {
    throw new Error(`Missing required argument: --${name}`);
  }
  return value;
}

function mediaElementFromArgs(args, type) {
  const width = args.width ? Number(args.width) : undefined;
  const height = args.height ? Number(args.height) : undefined;
  return {
    id: args.id,
    type,
    href: required(args.href, 'href'),
    mimeType: args['mime-type'] || args.mimeType || (type === 'image' ? 'image/png' : 'video/mp4'),
    name: args.name || (type === 'image' ? 'Agent Image' : 'Agent Video'),
    x: args.x ? Number(args.x) : undefined,
    y: args.y ? Number(args.y) : undefined,
    width,
    height,
  };
}

async function loadAgentKit() {
  const isNodeRuntime = typeof process !== 'undefined' && !!process.versions?.node;
  if (!isNodeRuntime && typeof window !== 'undefined') {
    return {
      initCliHost: () => ({ ok: false, error: { code: 'UNSUPPORTED_RUNTIME', message: 'CLI host init is only available in the Node CLI runtime.' } }),
      searchInspiration: () => ({ ok: false, error: { code: 'UNSUPPORTED_RUNTIME', message: 'Inspiration search is only available in the Node CLI runtime.' } }),
      getInspiration: () => ({ ok: false, error: { code: 'UNSUPPORTED_RUNTIME', message: 'Inspiration lookup is only available in the Node CLI runtime.' } }),
      enhancePrompt: () => ({ ok: false, error: { code: 'UNSUPPORTED_RUNTIME', message: 'Prompt enhancement is only available in the Node CLI runtime.' } }),
      planBatchGeneration: () => ({ ok: false, error: { code: 'UNSUPPORTED_RUNTIME', message: 'Batch planning is only available in the Node CLI runtime.' } }),
      prepareMediaUpload: () => ({ ok: false, error: { code: 'UNSUPPORTED_RUNTIME', message: 'Local media upload is only available in the Node CLI runtime.' } }),
      manageAgentPreferences: () => ({ ok: false, error: { code: 'UNSUPPORTED_RUNTIME', message: 'Agent preferences are only available in the Node CLI runtime.' } }),
      listAgentModels: () => ({ ok: false, error: { code: 'UNSUPPORTED_RUNTIME', message: 'Agent model listing is only available in the Node CLI runtime.' } }),
      discoverAgentHosts: () => ({ ok: false, error: { code: 'UNSUPPORTED_RUNTIME', message: 'Local Agent discovery is only available in the Node CLI runtime.' } }),
      diagnoseAgentSetup: () => ({ ok: false, error: { code: 'UNSUPPORTED_RUNTIME', message: 'Agent setup diagnostics are only available in the Node CLI runtime.' } }),
    };
  }
  const specifier = './agent-kit.js';
  return await import(/* @vite-ignore */ specifier);
}

/** 与未知命令同一命名空间（如 skill.run → skill.*）下真实可用的命令，供错误提示列出。 */
export function commandsInSameNamespace(commandName) {
  const name = String(commandName || '').trim();
  const namespace = name.includes('.') ? name.slice(0, name.indexOf('.') + 1) : '';
  if (!namespace) return [];
  return COMMANDS.filter(item => item.startsWith(namespace)).sort();
}

/** `--no-wait` = 20s; `--wait-seconds <n>` (1–960). Only workflow.node.run honours it. */
export function workflowRunWaitMs(command, { waitSeconds, noWait } = {}) {
  if (command !== 'workflow.node.run') return 0;
  if (waitSeconds !== undefined && waitSeconds !== null && waitSeconds !== true && waitSeconds !== '') {
    const seconds = Number(waitSeconds);
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > 960) {
      throw new Error('--wait-seconds must be a number between 1 and 960');
    }
    return Math.round(seconds * 1000);
  }
  if (noWait === true || noWait === 'true') return 20_000;
  return 0;
}

export function unknownCommandMessage(commandName) {
  const name = String(commandName || '').trim();
  const available = commandsInSameNamespace(name);
  const namespace = name.includes('.') ? name.slice(0, name.indexOf('.')) : '';
  return available.length
    ? `Unknown Iris command: ${name}. Available ${namespace}.* commands: ${available.join(', ')}.`
    : `Unknown Iris command: ${name}. Run \`help\` or \`command.list\` to see available commands.`;
}

export async function executeIrisCommand(commandName, args = {}, runtime = {}) {
  const command = normalizeCommandName(commandName);

  if (command.startsWith('workflow.')) {
    if (!runtime.operation && !runtime.workflow?.dispatch) return { ok: false, error: { code: 'WORKFLOW_UNAVAILABLE', message: 'Workflow dispatcher unavailable.' } };
    const {
      agentIdentity,
      'agent-identity': legacyAgentIdentity,
      hostSessionId,
      'host-session-id': legacyHostSessionId,
      'wait-seconds': waitSecondsOption,
      waitSeconds: waitSecondsCamel,
      'no-wait': noWait,
      ...commandOptions
    } = args;
    const waitMs = workflowRunWaitMs(command, { waitSeconds: waitSecondsOption ?? waitSecondsCamel, noWait });
    const callerIdentity = agentIdentity || legacyAgentIdentity;
    const callerSession = hostSessionId || legacyHostSessionId;
    const workflowArgs = Object.fromEntries(Object.entries({
      ...commandOptions,
      projectId: commandOptions.projectId || commandOptions['project-id'],
      nodeId: commandOptions.nodeId || commandOptions['node-id'],
      // node.run 与 focus.nodes 统一接受 `--node-ids a,b`、JSON 数组或数组。
      nodeIds: (commandOptions.nodeIds ?? commandOptions['node-ids']) === undefined ? undefined : parseListOption(commandOptions.nodeIds ?? commandOptions['node-ids']),
      expectedRevision: commandOptions.expectedRevision ?? commandOptions['expected-revision'],
      mutationId: commandOptions.mutationId || commandOptions['mutation-id'],
      clientId: commandOptions.clientId || commandOptions['client-id'],
      workspaceMode: commandOptions.workspaceMode || commandOptions['workspace-mode'],
      fromNodeId: commandOptions.fromNodeId || commandOptions['from-node-id'],
      toNodeId: commandOptions.toNodeId || commandOptions['to-node-id'],
      connectionId: commandOptions.connectionId || commandOptions['connection-id'],
      idempotencyKey: commandOptions.idempotencyKey || commandOptions['idempotency-key'],
      metadata: parseJsonOption(commandOptions.metadata ?? commandOptions.metadataJson ?? commandOptions['metadata-json'], undefined),
      patch: parseJsonOption(commandOptions.patch ?? commandOptions.patchJson ?? commandOptions['patch-json'], undefined),
      operations: parseJsonOption(commandOptions.operations ?? commandOptions.operationsJson ?? commandOptions['operations-json'] ?? commandOptions.ops ?? commandOptions['ops-json'], undefined),
      ids: commandOptions.ids === undefined ? undefined : parseListOption(commandOptions.ids),
      ...(command === 'workflow.node.tool' || command === 'workflow.image.tool' || command === 'workflow.video.tool' || command === 'workflow.audio.tool' ? normalizeWorkflowNodeToolArgs(commandOptions) : {}),
      ...(REGISTRY_TYPED_WORKFLOW_COMMANDS.has(command) ? registryTypedArgs(command, commandOptions) : {}),
    }).filter(([, value]) => value !== undefined));
    const source = runtime.source || 'cli';
    const caller = runtime.caller || (callerIdentity ? {
      agentIdentity: String(callerIdentity),
      ...(callerSession ? { hostSessionId: String(callerSession) } : {}),
    } : undefined);
    if (runtime.operation) {
      try {
        return await runtime.operation(command, workflowArgs, {
          source,
          ...(workflowArgs.idempotencyKey ? { idempotencyKey: workflowArgs.idempotencyKey } : {}),
          ...(caller ? { caller } : {}),
          ...(waitMs ? { timeoutMs: waitMs } : {}),
        });
      } catch (error) {
        // --wait-seconds / --no-wait：到点还没结束不算失败。生成仍在画布里跑，
        // 用同一个 idempotencyKey 重发同一条命令会接上这次执行（浏览器端按 key 复用在途 / 已完成的结果），不会重复提交。
        if (waitMs && error?.code === 'WORKSPACE_TIMEOUT') {
          return {
            ok: true,
            status: 'running',
            command,
            idempotencyKey: workflowArgs.idempotencyKey || error.details?.idempotencyKey || null,
            waitedSeconds: Math.round(waitMs / 1000),
            next: 'Run the same command again with the same --idempotency-key to wait for and read the result; workflow.inspect shows node progress meanwhile.',
          };
        }
        throw error;
      }
    }
    return await runtime.workflow.dispatch({
      id: args.commandId || secureId('cli_'),
      command,
      args: workflowArgs,
      source,
      idempotencyKey: workflowArgs.idempotencyKey,
      ...(caller ? { caller } : {}),
    });
  }

  switch (command) {
    case 'help':
      return { ok: true, text: HELP_TEXT, commands: COMMANDS, registry: COMMAND_REGISTRY };
    case 'setup':
      return { ok: true, text: SETUP_TEXT };
    case 'init': {
      const { initCliHost } = await loadAgentKit();
      return initCliHost({
        target: args.target || args._?.[0] || 'project-skill',
        legacyHost: args.host,
        projectDir: args['project-dir'] || args.projectDir,
        dryRun: args['dry-run'] || args.dryRun,
      });
    }
    case 'doctor': {
      const { diagnoseAgentSetup } = await loadAgentKit();
      return diagnoseAgentSetup({
        projectDir: args['project-dir'] || args.projectDir,
      });
    }
    case 'command.list': {
      // agentTools：DSH 等只拿 CLI 输出的宿主据此注册与其他宿主同名同 Schema 的工具。
      const { getAgentToolSpecs } = await import('./agent-tools.js');
      return { ok: true, commands: COMMAND_REGISTRY, aliases: COMMAND_ALIASES, agentTools: getAgentToolSpecs('dsh') };
    }
    case 'command.schema': {
      const requested = args.command || args.name;
      if (!requested) return { ok: true, commands: COMMAND_REGISTRY, aliases: COMMAND_ALIASES };
      const commandKey = findRegisteredCommand(requested);
      const schema = COMMAND_REGISTRY[commandKey];
      return schema
        ? { ok: true, command: commandKey, schema: { ...schema, aliases: getCommandAliases(commandKey) } }
        : { ok: false, error: { code: 'UNKNOWN_COMMAND', message: unknownCommandMessage(requested), availableCommands: commandsInSameNamespace(requested) } };
    }
    case 'inspiration.search': {
      const { searchInspiration } = await loadAgentKit();
      return searchInspiration({ query: args.query || args._?.join(' '), category: args.category, limit: args.limit ? Number(args.limit) : undefined });
    }
    case 'inspiration.get': {
      const { getInspiration } = await loadAgentKit();
      return getInspiration({ id: required(args.id || args._?.[0], 'id') });
    }
    case 'prompt.enhance': {
      const { enhancePrompt } = await loadAgentKit();
      return enhancePrompt({
        prompt: required(args.prompt || args._?.join(' '), 'prompt'),
        style: args.style,
        aspectRatio: args['aspect-ratio'] || args.aspectRatio,
        mode: args.mode,
        styleNotes: args['style-notes'] || args.styleNotes,
      });
    }
    case 'batch.plan': {
      const { planBatchGeneration } = await loadAgentKit();
      return planBatchGeneration({
        prompt: required(args.prompt || args._?.join(' '), 'prompt'),
        count: args.count ? Number(args.count) : undefined,
        aspectRatio: args['aspect-ratio'] || args.aspectRatio,
      });
    }
    case 'preferences.manage': {
      const { manageAgentPreferences } = await loadAgentKit();
      return manageAgentPreferences({
        action: args.action || args._?.[0] || 'get',
        style: args.style,
        aspectRatio: args['aspect-ratio'] || args.aspectRatio,
        imageModel: args['image-model'] || args.imageModel,
        videoModel: args['video-model'] || args.videoModel,
        styleNotes: args['style-notes'] || args.styleNotes,
        prompt: args.prompt,
        title: args.title,
      });
    }
    case 'models.list': {
      const { listAgentModels } = await loadAgentKit();
      return listAgentModels({ purpose: args.purpose || args._?.[0] || 'all' });
    }
    case 'model':
    case 'model.search': {
      const { listAgentModels } = await loadAgentKit();
      const subcommand = command === 'model' ? commandSubcommand(args, 'list') : 'search';
      const requestedType = args.type || args.t || args.purpose || (subcommand === 'search' ? 'all' : args._?.[0]) || 'all';
      const query = String(args.query || args.q || (command === 'model.search' ? args._?.join(' ') : '') || '').toLowerCase();
      const listed = listAgentModels({ purpose: requestedType === 'text' ? 'all' : requestedType });
      const allModels = Object.entries(listed.models || {}).flatMap(([type, models]) => (models || []).map((model) => ({ ...model, type })));
      if (subcommand !== 'search' && subcommand !== 'list' && subcommand !== 'all' && subcommand !== 'image' && subcommand !== 'video') {
        const found = allModels.find((model) => model.id === subcommand);
        return found ? { ok: true, model: found } : { ok: false, error: { code: 'NOT_FOUND', message: `model not found: ${subcommand}` } };
      }
      const models = allModels.filter((model) => (!query || [model.id, model.label, model.type].join(' ').toLowerCase().includes(query)));
      return { ok: true, query, type: requestedType, models };
    }
    case 'runtime.status':
      return await runtime.runtime?.status?.() || {
        ok: false,
        error: {
          code: 'RUNTIME_UNAVAILABLE',
          message: 'Desktop Production Runtime is not connected.',
        },
      };
    case 'status':
      return await runtime.status?.() || {
        ok: true,
        runtime: runtime._version || 'unknown',
        providers: await runtime.provider?.status?.(),
      };
    case 'host.list': {
      const { discoverAgentHosts } = await loadAgentKit();
      return discoverAgentHosts({ refresh: args.refresh === true || args.refresh === 'true' });
    }
    case 'provider.status':
      return await runtime.provider?.status?.() || { ok: false, error: 'provider.status unavailable' };
    case 'provider.begin.setup':
    case 'provider.begin-setup':
      return await runtime.provider?.beginSetup?.({
        provider: args.provider || 'custom',
        purpose: args.purpose || 'both',
      });
    case 'provider.select.model':
    case 'provider.select-model':
      return await runtime.provider?.selectModel?.({
        imageModel: args['image-model'] || args.imageModel,
        videoModel: args['video-model'] || args.videoModel,
        textModel: args['text-model'] || args.textModel,
      });
    case 'provider.test':
      return await runtime.provider?.test?.({ purpose: args.purpose || 'both' });
    case 'asset.list':
      return await runtime.assets?.list?.();
    case 'generate.image':
      return await runtime.generate?.image?.({
        prompt: required(args.prompt, 'prompt'),
        projectId: args.projectId || args['project-id'],
        targetNodeId: args.targetNodeId || args['target-node-id'],
        aspectRatio: args['aspect-ratio'] || args.aspectRatio,
      });
    case 'generate.images.batch':
    case 'generate.images-batch': {
      const items = args.items || parseJsonOption(args.itemsJson, null);
      return await runtime.generate?.imagesBatch?.({
        items: required(items, 'items'),
        projectId: args.projectId || args['project-id'],
      });
    }
    case 'generate.video':
      return await runtime.generate?.video?.({
        prompt: required(args.prompt, 'prompt'),
        sourceImageIds: parseListOption(args['source-image-ids'] || args.sourceImageIds),
        sourceVideoIds: parseListOption(args['source-video-ids'] || args.sourceVideoIds),
        slots: args.slots || parseJsonOption(args.slotsJson || args['slots-json'], undefined),
        durationSec: parseOptionalNumber(args.durationSec ?? args['duration-sec'] ?? args.duration),
        aspectRatio: args['aspect-ratio'] || args.aspectRatio,
        resolution: args.resolution,
        generateAudio: parseOptionalBoolean(args.generateAudio ?? args['generate-audio']),
        watermark: parseOptionalBoolean(args.watermark),
        seed: parseOptionalNumber(args.seed),
      });
    case 'video.status':
      return await runtime.generate?.videoStatus?.({ jobId: required(args['job-id'] || args.jobId, 'job-id') });
    case 'export.project':
      return await runtime.export?.project?.({ format: args.format || 'json' });
    default:
      throw Object.assign(new Error(unknownCommandMessage(commandName)), { code: 'UNKNOWN_COMMAND', availableCommands: commandsInSameNamespace(commandName) });
  }
}

export function planIrisInput(rawInput, session = createIrisSession()) {
  const parts = String(rawInput || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  const command = parts[0];
  const args = parseCliArgs(parts.slice(1));
  session.lastTool = command;
  return {
    title: command,
    steps: [`Run deterministic Iris tool: ${command}`],
    run: async ({ runtime }) => executeIrisCommand(command, args, runtime),
  };
}
