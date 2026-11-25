#!/usr/bin/env node
import './legacy-bootstrap.js';
import { imagesBatchInvocations, legacyForward } from './legacy-forward.js';
import { COMMAND_REGISTRY, executeIrisCommand, formatValue, HELP_TEXT, normalizeCommandName, parseCliArgs, SETUP_TEXT } from './core.js';
import { createShadowRuntimeFacade } from './shadow-runtime.js';
import { readFile } from 'node:fs/promises';
import { defaultRuntimeActor, IrisRuntimeClient, RuntimeClientError } from './runtime-client.js';
import { RUNTIME_COMMANDS, RUNTIME_WRITE_COMMANDS } from './runtime-command-surface.js';
import { WORKSPACE_COMMANDS, WORKSPACE_WRITE_COMMANDS } from './workspace-command-surface.js';
import { RESEARCH_COMMANDS, RESEARCH_WRITE_COMMANDS } from './research-command-surface.js';
import { collectTopicResearch } from './topic-research.js';
import { PIPELINE_COMMANDS, PIPELINE_WRITE_COMMANDS } from './pipeline/commands.js';
import { runSkillCommand, SKILL_COMMAND_NAMES } from './skill-commands.js';
import { getLocalStatus } from './local-status.js';
import { ProviderVaultError, readVaultProviderStatus } from './provider-vault.js';
import { ensureIris } from './ensure.js';
import { AGENT_PUBLIC_COMMAND_SET } from './agent-surface.js';
import { createOperationGateway } from './operation-gateway.js';
import {
  createWorkspaceFacade,
  IrisWorkspaceClient,
  WorkspaceClientError,
} from './workspace-client.js';
import { AGENT_SESSION_CONTROL_COMMANDS } from './agent-surface.js';
import { applyStdinNodeIds, cliProgress, formatCliResponse, waitForAgentTask } from './cli-output.js';

const argv = process.argv.slice(2);

/** pipeline 命令的 CLI 参数：--args-json '<json>' 或 --file payload.json 给结构化参数，其余 --key value 按注册表类型转换。 */
async function pipelineCliArgs(command, args) {
  const definition = COMMAND_REGISTRY[command];
  const out = {};
  if (args.file) Object.assign(out, JSON.parse(await readFile(args.file, 'utf8')));
  if (args.argsJson || args['args-json']) Object.assign(out, JSON.parse(args.argsJson || args['args-json']));
  for (const [name, descriptor] of Object.entries(definition?.args || {})) {
    if (args[name] === undefined || out[name] !== undefined) continue;
    const type = String(descriptor).replace(/\?$/, '');
    const raw = args[name];
    if (type === 'number') out[name] = Number(raw);
    else if (type === 'boolean') out[name] = raw === true || raw === 'true';
    else if (['object', 'array', 'string[]'].includes(type)) out[name] = typeof raw === 'string' ? JSON.parse(raw) : raw;
    else out[name] = raw;
  }
  delete out.mutationId;
  return out;
}

function isResultOk(result) {
  return !(result && typeof result === 'object' && result.ok === false);
}

function printCliResponse(ok, commandName, data = null, error = null, extra = {}) {
  // NDJSON：一条结果一行；--pretty 时缩进给人读。进度只走 stderr（cliProgress）。
  console.log(formatCliResponse({ ok, command: commandName, data, error, ...extra }, { pretty: argv.includes('--pretty') }));
  if (!ok) process.exitCode = 1;
}

function normalizeAtomicAlias(rawCommand, parsedArgs) {
  return { command: rawCommand, args: parsedArgs };
}

const LOCAL_COMMANDS = new Set([
  'help', 'setup', 'init', 'doctor', 'host.list',
  'inspiration.search', 'inspiration.get',
  'prompt.enhance', 'batch.plan',
  'preferences.manage', 'models.list',
]);
const CLIENT_REGISTRY_COMMANDS = new Set(['command.list', 'command.schema']);

const FILE_STATE_COMMANDS = new Set([
  'asset.list',
]);

const RETIRED_COMMANDS = new Set([
  'provider.begin-setup', 'provider.select-model', 'provider.test',
]);

function runtimeInvocation(command, parsed) {
  const definition = COMMAND_REGISTRY[command];
  const commandArgs = {};
  for (const [name, type] of Object.entries(definition?.args || {})) {
    const kebab = name.replace(/([A-Z])/g, '-$1').toLowerCase();
    const raw = parsed[name] ?? parsed[kebab];
    if (raw === undefined) continue;
    const base = type.replace(/\?$/, '');
    if (base === 'number') commandArgs[name] = Number(raw);
    else if (base === 'boolean') commandArgs[name] = raw === true || String(raw).toLowerCase() === 'true';
    else if (['object', 'array', 'string[]'].includes(base) && typeof raw === 'string') {
      try {
        commandArgs[name] = JSON.parse(raw);
      } catch (error) {
        throw new RuntimeClientError(
          'INVALID_ARGUMENT',
          `--${kebab} must be valid JSON (${base}): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else commandArgs[name] = raw;
  }
  const idempotencyKey = parsed.idempotencyKey || parsed['idempotency-key'];
  if (RUNTIME_WRITE_COMMANDS.has(command) && !idempotencyKey) {
    throw new RuntimeClientError(
      'INVALID_ARGUMENT',
      `${command} requires --idempotency-key so retries cannot duplicate work.`,
    );
  }
  return { commandArgs, options: { ...(idempotencyKey ? { idempotencyKey } : {}) } };
}


const rawCommand = argv[0];

if (rawCommand === '--help' || rawCommand === '-h') {
  console.log(HELP_TEXT);
  process.exit(0);
}

if (rawCommand === 'tui' || rawCommand === 'ui' || rawCommand === 'interactive' || (!rawCommand && process.stdin.isTTY)) {
  const mod = await import('./tui.js');
  await mod.runTui(rawCommand ? argv.slice(1) : []);
  process.exit(0);
}

// Iris Link 与 Agent harness 命令（iris login web / logout / link status / agent sessions|send|trace|…）：
// 在 `agent`（启动本机 Agent 服务）分支之前分流，`iris agent` 不带子命令时行为不变。
const linkRoute = await (async () => {
  const { linkCommandFromArgv } = await import('./link/agent-commands.js');
  return linkCommandFromArgv(argv);
})();
if (linkRoute) {
  const { runLinkCli } = await import('./link/cli-link.js');
  process.exitCode = await runLinkCli(linkRoute.command, linkRoute.rest);
  // 等 stdout 刷完再退出（follow 会打很多行）。
  await new Promise(resolve => process.stdout.write('', resolve));
  process.exit(process.exitCode);
}

if (rawCommand === 'mcp' || rawCommand === 'mcp-server') {
  const mod = await import('./mcp-server.js');
  await mod.runMcpServer();
  process.exit(0);
}

if (['install', 'start', 'update', 'uninstall'].includes(rawCommand)) {
  const mod = await import('./dev-commands.js');
  await mod[rawCommand](argv.slice(1));
} else if (rawCommand === 'agent') {
  const managedAgentSpecifier = './managed-agent/index.js';
  await import(/* @vite-ignore */ managedAgentSpecifier).catch(() => import('../../agent/index.js'));
} else {
  const parsedArgs = parseCliArgs(argv.slice(1));
  const normalizedAtomic = normalizeAtomicAlias(rawCommand, parsedArgs);
  let command = normalizeCommandName(normalizedAtomic.command);
  let args = normalizedAtomic.args;
  let fileReadError = false;

  if (args.file) {
    try {
      const payload = JSON.parse(await readFile(args.file, 'utf8'));
      if (command === 'generate.images-batch' || command === 'generate.video') args.items = payload.items || payload;
      if (command === 'production.dry-run') args.spec = payload;
    } catch (error) {
      printCliResponse(false, command || 'unknown', null, { code: 'FILE_READ_ERROR', message: error instanceof Error ? error.message : String(error) });
      fileReadError = true;
      process.exitCode = 1;
    }
  }

  async function main() {
  if (fileReadError) return;
  // 管道：`--references -` / `--node-ids -` 从 stdin 读上游 NDJSON 里的 nodeId。
  try {
    args = await applyStdinNodeIds(command, args);
  } catch (error) {
    printCliResponse(false, command || 'unknown', null, { code: error?.code || 'INVALID_ARGUMENT', message: error instanceof Error ? error.message : String(error), retryable: false });
    return;
  }
  if (!command) {
    printCliResponse(true, 'help', { usage: 'iris  # opens TUI; or iris <command> --json', setup: SETUP_TEXT, commands: { tui: 'Open slash-command TUI', install: 'Download and verify the versioned Agent Toolkit', start: 'Launch local Runtime/WebUI services', update: 'Install and switch to the latest compatible Toolkit', source: 'Add --source for Vite/Go/Docker contributor services' } });
    return;
  }

  if ((args.help || args.h) && COMMAND_REGISTRY[command]) {
    const result = await executeIrisCommand('command.schema', { command }, {});
    const ok = isResultOk(result);
    if (args.json) printCliResponse(ok, command, ok ? result : null, ok ? null : result.error || null, { runtime: 'client-registry' });
    else {
      console.log(formatValue(result));
      if (!ok) process.exitCode = 1;
    }
    return;
  }

  const forwarded = legacyForward(command, args);
  if (forwarded) {
    command = forwarded.command;
    args = forwarded.args;
  }
  const routingCommand = command;

  if (routingCommand === 'generate.images-batch') {
    const runtime = new IrisRuntimeClient();
    try {
      const invocations = imagesBatchInvocations(args);
      const results = [];
      for (const invocation of invocations) {
        try {
          results.push({ ok: true, task: await runtime.execute('generate.image', invocation.commandArgs, defaultRuntimeActor('cli'), invocation.options) });
        } catch (error) {
          results.push({ ok: false, error: error instanceof RuntimeClientError ? error.toJSON() : { code: 'RUNTIME_UNAVAILABLE', message: error instanceof Error ? error.message : String(error) } });
        }
      }
      const ok = results.every(result => result.ok);
      printCliResponse(ok, command, { forwardedTo: 'generate.image', results }, ok ? null : { code: 'PARTIAL_FAILURE', message: '部分图片提交失败；用同一个 --idempotency-key 重试只补失败项。', retryable: true }, { runtime: 'production-runtime' });
    } catch (error) {
      printCliResponse(false, command, null, { code: 'INVALID_ARGUMENT', message: error instanceof Error ? error.message : String(error), retryable: false }, { runtime: 'production-runtime' });
    }
    return;
  }

  if (routingCommand === 'ensure') {
    const result = await ensureIris({ open: !(args.noOpen || args['no-open']), web: Boolean(args.web), source: Boolean(args.source) });
    printCliResponse(result.ok, command, result, result.ok ? null : result.error, { runtime: 'iris-link' });
    return;
  }

  // WorkBuddy's CLI connector lifecycle is local-ready semantics, not a second
  // account or OAuth flow. It never revokes Iris credentials shared by other
  // Hosts when WorkBuddy runs unAuth.
  if (routingCommand === 'workbuddy.status') {
    const result = await getLocalStatus();
    printCliResponse(true, command, { state: result.ready ? 'local-ready' : 'offline', status: result }, null, { runtime: 'workbuddy-connector' });
    return;
  }
  if (routingCommand === 'workbuddy.auth') {
    const result = await ensureIris({ open: false });
    printCliResponse(result.ok, command, { state: result.ok ? 'local-ready' : 'offline', ...result }, result.ok ? null : result.error, { runtime: 'workbuddy-connector' });
    return;
  }
  if (routingCommand === 'workbuddy.unAuth') {
    printCliResponse(true, command, {
      state: 'local-ready',
      message: 'Iris 本地服务不保存 WorkBuddy 账号；此次 unAuth 不会注销或影响其它 Host。',
    }, null, { runtime: 'workbuddy-connector' });
    return;
  }

  if (CLIENT_REGISTRY_COMMANDS.has(routingCommand)) {
    const result = await executeIrisCommand(command, args, {});
    const ok = isResultOk(result);
    if (args.json) printCliResponse(ok, command, ok ? result : null, ok ? null : result.error || null, { runtime: 'client-registry' });
    else {
      console.log(formatValue(result));
      if (!ok) process.exitCode = 1;
    }
    return;
  }

  // Agent 视频流水线：本机 pipeline 边界（tools/iris/pipeline/）。asset.list 不带 runId 时仍是旧的本地生成历史。
  if (PIPELINE_COMMANDS.has(routingCommand) && !(routingCommand === 'asset.list' && !args.runId)) {
    try {
      const pipelineArgs = await pipelineCliArgs(routingCommand, args);
      const mutationId = args.mutationId || args['mutation-id'] || args.idempotencyKey || args['idempotency-key'];
      if (PIPELINE_WRITE_COMMANDS.has(routingCommand) && !mutationId && !pipelineArgs.mutationId) {
        printCliResponse(false, command, null, {
          code: 'INVALID_ARGUMENT',
          message: `${routingCommand} requires --mutation-id so retries replay the same pipeline step.`,
          retryable: false,
        }, { runtime: 'pipeline' });
        return;
      }
      const { executePipelineCommand } = await import('./pipeline/index.js');
      const result = await executePipelineCommand(routingCommand, pipelineArgs, {
        caller: args.caller || 'cli',
        ...(mutationId ? { mutationId: String(mutationId) } : {}),
        confirmResubmit: args.confirmResubmit === true || args['confirm-resubmit'] === true,
        // CLI 是人在终端的入口：--confirmed / --budget-confirmed 直接生效。模型驱动的入口（内置 Agent、MCP）不设此项，需用户在 UI 批准。
        trustedConfirmation: true,
      });
      printCliResponse(result.ok, command, result.ok ? { ...result.result, ...(result.step ? { step: result.step } : {}) } : null, result.ok ? null : result.error, { runtime: 'pipeline' });
    } catch (error) {
      printCliResponse(false, command, null, {
        code: error?.code || 'PIPELINE_FAILED',
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
      }, { runtime: 'pipeline' });
    }
    return;
  }

  if (RUNTIME_COMMANDS.has(routingCommand)) {
    const runtime = new IrisRuntimeClient();
    try {
      const invocation = runtimeInvocation(routingCommand, args);
      let result;
      if (routingCommand === 'runtime.status') result = await runtime.status();
       else if (routingCommand === 'task.get') result = await runtime.getTask(invocation.commandArgs.taskId);
       else if (routingCommand === 'task.inspect') result = await runtime.getProductionTask(invocation.commandArgs.taskId);
       else if (routingCommand === 'task.resume') result = await runtime.resumeProductionTask(
         invocation.commandArgs.taskId,
         defaultRuntimeActor('cli'),
         invocation.options,
       );
      else if (routingCommand === 'task.list') result = await runtime.listTasks(invocation.commandArgs);
      else if (routingCommand === 'event.stream') result = await runtime.streamEvents(invocation.commandArgs);
      else {
        result = await runtime.execute(
          routingCommand,
          invocation.commandArgs,
          defaultRuntimeActor('cli'),
          invocation.options,
        );
      }
      if (args.json) printCliResponse(true, command, result, null, { runtime: 'production-runtime' });
      else console.log(formatValue(result));
    } catch (error) {
      const runtimeError = error instanceof RuntimeClientError
        ? error.toJSON()
        : { code: 'RUNTIME_UNAVAILABLE', message: error instanceof Error ? error.message : String(error), retryable: true };
      // Web mode has no desktop Runtime. The Agent vault mirrors the keys the
      // browser Settings synced, so it is the masked fallback for provider.status.
      if (routingCommand === 'provider.status' && runtimeError.code === 'RUNTIME_UNAVAILABLE') {
        try {
          const vault = await readVaultProviderStatus();
          printCliResponse(true, command, { ...vault, runtimeUnavailable: runtimeError }, null, { runtime: 'agent-vault' });
          return;
        } catch (vaultError) {
          runtimeError.details = {
            ...(runtimeError.details || {}),
            agentVault: vaultError instanceof ProviderVaultError
              ? vaultError.toJSON()
              : { code: 'AGENT_UNAVAILABLE', message: vaultError instanceof Error ? vaultError.message : String(vaultError), retryable: true },
          };
        }
      }
      printCliResponse(false, command, null, runtimeError, { runtime: 'production-runtime' });
    }
    return;
  }

  // 会话预算 / 暂停：可信本地 CLI（持久 token、无 Origin）直达 Agent 会话，不经公开面白名单。
  if (AGENT_SESSION_CONTROL_COMMANDS.includes(routingCommand)) {
    const sessionArgs = {
      ...(args.maxRuns ?? args['max-runs']) !== undefined ? { maxRuns: Number(args.maxRuns ?? args['max-runs']) } : {},
      ...(args.ttlMs ?? args['ttl-ms']) !== undefined ? { ttlMs: Number(args.ttlMs ?? args['ttl-ms']) } : {},
      ...typeof args.reason === 'string' ? { reason: args.reason } : {},
    };
    try {
      const workspace = new IrisWorkspaceClient();
      const result = await workspace.execute(routingCommand, sessionArgs, 'cli');
      const ok = isResultOk(result);
      printCliResponse(ok, command, ok ? result.result ?? result : null, ok ? null : result.error || null, { runtime: 'agent-session' });
    } catch (error) {
      const workspaceError = error instanceof WorkspaceClientError
        ? error.toJSON()
        : { code: 'WORKSPACE_UNAVAILABLE', message: error instanceof Error ? error.message : String(error), retryable: true };
      printCliResponse(false, command, null, workspaceError, { runtime: 'agent-session' });
    }
    return;
  }

  if (WORKSPACE_COMMANDS.has(routingCommand)) {
    const idempotencyKey = args.idempotencyKey || args['idempotency-key'];
    if (WORKSPACE_WRITE_COMMANDS.has(routingCommand) && !idempotencyKey) {
      printCliResponse(false, command, null, {
        code: 'INVALID_ARGUMENT',
        message: `${routingCommand} requires --idempotency-key so retries cannot duplicate visible Workflow changes.`,
        retryable: false,
      }, { runtime: 'workspace-adapter' });
      return;
    }
    try {
      const workspace = new IrisWorkspaceClient();
      const operation = createOperationGateway({ workspace });
      let result = routingCommand === 'workspace.status'
        ? await workspace.status()
        : AGENT_PUBLIC_COMMAND_SET.has(routingCommand)
          ? await executeIrisCommand(command, args, { operation, source: 'cli' })
          : await executeIrisCommand(command, args, createWorkspaceFacade(workspace));
      // agent.task.start --wait：stderr 输出任务事件，stdout 只输出最终一行结果。
      const taskId = result?.result?.taskId ?? result?.taskId;
      if (routingCommand === 'agent.task.start' && (args.wait === true || args.wait === 'true') && isResultOk(result) && taskId) {
        cliProgress('task ' + taskId + ' started (' + (args.command || '') + ')');
        result = await waitForAgentTask(taskId, (id, afterSeq) => executeIrisCommand('agent.task.get', { taskId: id, afterSeq }, { operation, source: 'cli' }));
        const view = result?.result ?? result;
        if (view && view.status && view.status !== 'succeeded') result = { ok: false, error: view.error || { code: 'TASK_' + String(view.status).toUpperCase(), message: '任务未成功：' + view.status }, data: view };
      }
      const ok = isResultOk(result);
      printCliResponse(ok, command, result, ok ? null : result.error || null, { runtime: 'workspace-adapter' });
    } catch (error) {
      const workspaceError = error instanceof WorkspaceClientError
        ? error.toJSON()
        : { code: 'WORKSPACE_UNAVAILABLE', message: error instanceof Error ? error.message : String(error), retryable: true };
      printCliResponse(false, command, null, workspaceError, { runtime: 'workspace-adapter' });
    }
    return;
  }


  if (RESEARCH_COMMANDS.has(routingCommand)) {
    const idempotencyKey = args.idempotencyKey || args['idempotency-key'];
    if (RESEARCH_WRITE_COMMANDS.has(routingCommand) && !idempotencyKey) {
      printCliResponse(false, command, null, {
        code: 'INVALID_ARGUMENT',
        message: `${routingCommand} requires --idempotency-key so retries replay the same research artifact.`,
        retryable: false,
      }, { runtime: 'research-adapter' });
      return;
    }
    try {
      const result = await collectTopicResearch(args, { idempotencyKey });
      const ok = result.state !== 'failed';
      printCliResponse(ok, command, ok ? result : null, ok ? null : {
        code: 'SOURCE_UNAVAILABLE',
        message: 'No usable topic evidence was collected from the requested sources.',
        retryable: true,
        details: result,
      }, { runtime: 'research-adapter' });
    } catch (error) {
      printCliResponse(false, command, null, {
        code: error?.code || 'RESEARCH_FAILED',
        message: error instanceof Error ? error.message : String(error),
        retryable: error?.code !== 'INVALID_ARGUMENT',
      }, { runtime: 'research-adapter' });
    }
    return;
  }

  if (SKILL_COMMAND_NAMES.has(routingCommand)) {
    try {
      const result = await runSkillCommand(routingCommand, args);
      const ok = Boolean(result && result.ok === true);
      printCliResponse(ok, command, ok ? result : null, ok ? null : result.error || null, { runtime: 'skill-registry' });
    } catch (error) {
      printCliResponse(false, command, null, {
        code: 'CLI_FATAL',
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
      }, { runtime: 'skill-registry' });
    }
    return;
  }

  if (LOCAL_COMMANDS.has(routingCommand)) {
    const result = await executeIrisCommand(command, args, {});
    const ok = isResultOk(result);
    if (args.json) printCliResponse(ok, command, result, ok ? null : result.error || null);
    else {
      console.log(formatValue(result.text || result));
      if (!ok) process.exitCode = 1;
    }
    return;
  }

  if (routingCommand === 'status') {
    const result = await getLocalStatus();
    printCliResponse(true, command, result, null, { runtime: 'local-system' });
    return;
  }

  if (FILE_STATE_COMMANDS.has(routingCommand)) {
    const runtime = createShadowRuntimeFacade();
    const result = await executeIrisCommand(command, args, runtime);
    printCliResponse(isResultOk(result), command, result, isResultOk(result) ? null : result.error || null, { runtime: 'file-state' });
    return;
  }

  if (RETIRED_COMMANDS.has(routingCommand)) {
    printCliResponse(false, command, null, {
      code: 'COMMAND_RETIRED',
      message: `${routingCommand} 已下线：浏览器 Bridge 文件队列已删除且前端不再消费。请使用生产 Runtime 命令（generate.image、generate.video、provider.status、task.list）或 Iris WebUI。`,
      retryable: false,
    }, { runtime: 'retired' });
    return;
  }

  const result = await executeIrisCommand(command, args, createShadowRuntimeFacade());
  printCliResponse(isResultOk(result), command, result, isResultOk(result) ? null : result.error || null, { runtime: 'file-state' });
  }

  main().catch(error => {
    printCliResponse(false, command || 'unknown', null, {
      code: error?.code === 'UNKNOWN_COMMAND' ? 'UNKNOWN_COMMAND' : 'CLI_FATAL',
      message: error instanceof Error ? error.message : String(error),
      ...(Array.isArray(error?.availableCommands) ? { availableCommands: error.availableCommands } : {}),
    });
    process.exitCode = 1;
  });
}
