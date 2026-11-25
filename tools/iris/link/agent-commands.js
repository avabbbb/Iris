// Agent harness / tools 的 CLI 命令（link.status、agent.sessions、agent.send、agent.trace、agent.approve/deny、
// agent.cancel、agent.tools.list/invoke、agent.e2e）。传输无关：local / web 两种 transport 都给 request(cmd, args, opts)。
// 执行全部发生在标签页里；这里只组织请求、跟随轨迹、打印 NDJSON。
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { LINK_ERROR } from './protocol.js';
import { LinkClientError } from './web-link-client.js';

/** 与 COMMAND_REGISTRY 同一风格的说明（summary / args / availability），给 --help 与 command.list 用。 */
export const LINK_CLI_COMMANDS = Object.freeze({
  'login.web': { summary: 'Pair this CLI with Iris open in your browser (iris.avabbbb.com by default). --open opens the confirm page; --device prints a code for sandboxes without a browser.', args: { url: 'string?', open: 'boolean?', device: 'boolean?', name: 'string?', scopes: 'string?' }, availability: 'available' },
  logout: { summary: 'Revoke the web link on the relay and delete ~/.iris/link.json.', args: {}, availability: 'available' },
  'link.status': { summary: 'Show which Iris the CLI drives (local loopback or web link), whether the tab is online, the model id it uses (never the key) and the granted scopes.', args: { target: 'local|web|auto?' }, availability: 'available' },
  'agent.sessions': { summary: 'List the built-in Agent sessions of the active project and the runs started over the link.', args: { target: 'local|web|auto?' }, availability: 'available' },
  'agent.send': { summary: 'Start an Agent turn in the tab (new session, or --session <id>); --canvas lands it as a canvas session card. Returns runId; --follow streams the trace.', args: { prompt: 'string', session: 'string?', canvas: 'boolean?', follow: 'boolean?', idempotencyKey: 'string', target: 'local|web|auto?' }, availability: 'available' },
  'agent.trace': { summary: 'Print a run trace (thinking summary, tools, Skill, Memory, Context, Budget, Artifact, approvals) as NDJSON; --follow streams until the run ends. Only what the provider actually returned.', args: { run: 'string', follow: 'boolean?', afterSeq: 'number?', target: 'local|web|auto?' }, availability: 'available' },
  'agent.approve': { summary: 'Approve the pending non-paid tool confirmation of a run (needs the agent.approve scope). Paid or destructive steps can only be approved on the page.', args: { run: 'string', approvalId: 'string?', idempotencyKey: 'string', target: 'local|web|auto?' }, availability: 'available' },
  'agent.deny': { summary: 'Deny the pending confirmation of a run (denying never spends money).', args: { run: 'string', approvalId: 'string?', idempotencyKey: 'string', target: 'local|web|auto?' }, availability: 'available' },
  'agent.cancel': { summary: 'Stop a run; its pending approvals are denied. Other sessions keep running.', args: { run: 'string', idempotencyKey: 'string', target: 'local|web|auto?' }, availability: 'available' },
  'agent.tools.list': { summary: 'List the built-in Agent tools with their tier and how the current Tool Policy resolves them (allow / prompt / deny).', args: { target: 'local|web|auto?' }, availability: 'available' },
  'agent.tools.invoke': { summary: 'Check a tool call against the schema and Tool Policy (dry-run, default). --execute runs it in the tab through the same policy, approvals and budget (needs the tools.invoke scope).', args: { tool: 'string', argsJson: 'string?', execute: 'boolean?', idempotencyKey: 'string?', target: 'local|web|auto?' }, availability: 'available' },
  'agent.e2e': { summary: 'Run the scripted harness scenarios (answer, tool, tool failure, approval, two parallel sessions, cancel) against the tab and write a trace report (JSON + Markdown). Refuses a real model unless --allow-real-model.', args: { out: 'string?', only: 'string?', allowRealModel: 'boolean?', timeoutMs: 'number?', target: 'local|web|auto?' }, availability: 'available' },
});

export const LINK_CLI_COMMAND_NAMES = new Set(Object.keys(LINK_CLI_COMMANDS));

/** `iris agent sessions` / `iris agent tools list` / `iris link status` 的空格写法 → 点分命令名。 */
export function linkCommandFromArgv(argv) {
  const [first, second, third] = argv;
  if (!first) return null;
  if (LINK_CLI_COMMAND_NAMES.has(first)) return { command: first, rest: argv.slice(1) };
  if (first === 'login' && second === 'web') return { command: 'login.web', rest: argv.slice(2) };
  if (first === 'link' && second === 'status') return { command: 'link.status', rest: argv.slice(2) };
  if (first === 'agent' && second === 'tools' && (third === 'list' || third === 'invoke')) return { command: 'agent.tools.' + third, rest: argv.slice(3) };
  if (first === 'agent' && second && LINK_CLI_COMMAND_NAMES.has('agent.' + second)) return { command: 'agent.' + second, rest: argv.slice(2) };
  return null;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const TERMINAL = new Set(['done', 'error', 'cancelled', 'interrupted']);

function opt(args, name) {
  const kebab = name.replace(/([A-Z])/g, '-$1').toLowerCase();
  return args[name] ?? args[kebab];
}
function flag(args, name) {
  const value = opt(args, name);
  return value === true || value === 'true';
}
function requireOpt(args, name, hint) {
  const value = opt(args, name);
  if (value === undefined || value === true || String(value).trim() === '') {
    throw new LinkClientError(LINK_ERROR.INVALID_ARGUMENT, `缺少 --${name.replace(/([A-Z])/g, '-$1').toLowerCase()}${hint ? '：' + hint : ''}`);
  }
  return String(value);
}

/**
 * 跟随一个 run 的轨迹：长轮询 agent.trace（waitMs），每个事件回调一次，直到 run 结束。
 * 断线（标签页刷新 / 令牌过期）时按 afterSeq 续上，不重复也不丢事件。
 */
export async function followRunTrace(transport, runId, options = {}) {
  let afterSeq = Number(options.afterSeq) || 0;
  const deadline = Date.now() + (options.timeoutMs ?? 30 * 60_000);
  const waitMs = options.waitMs ?? 15_000;
  let last = null;
  while (Date.now() < deadline) {
    if (options.signal?.aborted) break;
    let view;
    try {
      view = await transport.request('agent.trace', { runId, afterSeq, waitMs }, { timeoutMs: waitMs + 30_000 });
    } catch (error) {
      // 限速 / 标签页短暂超时：退避后按同一个 afterSeq 续上，不丢事件。
      if (error?.code === LINK_ERROR.RATE_LIMITED || error?.code === LINK_ERROR.TAB_TIMEOUT) { await sleep(options.backoffMs ?? 1_000); continue; }
      throw error;
    }
    last = view;
    for (const event of view.events || []) {
      afterSeq = Math.max(afterSeq, Number(event.seq) || afterSeq);
      await options.onEvent?.(event, view);
    }
    if (view.done || TERMINAL.has(view.phase)) return view;
    if (!(view.events || []).length && waitMs === 0) await sleep(options.pollMs ?? 500);
  }
  throw new LinkClientError('TRACE_TIMEOUT', `run ${runId} 在超时前没有结束。`, { retryable: true, details: { lastPhase: last?.phase ?? null, afterSeq } });
}

export async function runAgentLinkCommand(command, args, context) {
  const { transport } = context;
  const print = context.print || (() => {});
  switch (command) {
    case 'link.status': {
      const [where, tab] = await Promise.all([
        transport.describe().catch(error => ({ transport: transport.kind, error: error?.toJSON?.() ?? { message: String(error?.message || error) } })),
        transport.request('link.status', {}).catch(error => ({ error: error?.toJSON?.() ?? { code: error?.code, message: String(error?.message || error) } })),
      ]);
      return { target: transport.kind, scopes: transport.scopes, ...where, tab };
    }
    case 'agent.sessions':
      return transport.request('agent.sessions', {});
    case 'agent.send': {
      const prompt = String(opt(args, 'prompt') ?? args._?.join(' ') ?? '').trim();
      if (!prompt) throw new LinkClientError(LINK_ERROR.INVALID_ARGUMENT, 'agent.send 需要 --prompt "..."（或把文本放在命令后面）。');
      const idempotencyKey = requireOpt(args, 'idempotencyKey', '同一个键重试不会重复发起回合（例如 --idempotency-key $(uuidgen)）');
      const session = opt(args, 'session');
      const started = await transport.request('agent.send', {
        prompt,
        ...(typeof session === 'string' && session ? { sessionId: session } : {}),
        ...(flag(args, 'canvas') ? { canvas: true } : {}),
      }, { idempotencyKey });
      if (!flag(args, 'follow')) return started;
      const final = await followRunTrace(transport, started.runId, { onEvent: event => print({ ok: true, command: 'agent.trace', runId: started.runId, event }) });
      return { ...started, phase: final.phase, done: true, sessionId: final.sessionId ?? started.sessionId, ...(final.reply ? { reply: final.reply } : {}) };
    }
    case 'agent.trace': {
      const runId = requireOpt(args, 'run', 'agent.send 返回的 runId');
      const afterSeq = Number(opt(args, 'afterSeq')) || 0;
      if (!flag(args, 'follow')) return transport.request('agent.trace', { runId, afterSeq });
      const final = await followRunTrace(transport, runId, { afterSeq, onEvent: event => print({ ok: true, command: 'agent.trace', runId, event }) });
      return { runId, phase: final.phase, done: true, seq: final.seq, sessionId: final.sessionId ?? null, ...(final.reply ? { reply: final.reply } : {}) };
    }
    case 'agent.approve':
    case 'agent.deny': {
      const runId = requireOpt(args, 'run');
      const idempotencyKey = requireOpt(args, 'idempotencyKey');
      const approvalId = opt(args, 'approvalId');
      return transport.request(command, { runId, ...(typeof approvalId === 'string' ? { approvalId } : {}) }, { idempotencyKey });
    }
    case 'agent.cancel': {
      const runId = requireOpt(args, 'run');
      return transport.request('agent.cancel', { runId }, { idempotencyKey: requireOpt(args, 'idempotencyKey') });
    }
    case 'agent.tools.list':
      return transport.request('agent.tools.list', {});
    case 'agent.tools.invoke': {
      const tool = requireOpt(args, 'tool', '例如 iris_workflow_inspect');
      let toolArgs = {};
      const raw = opt(args, 'argsJson');
      if (raw !== undefined) {
        try { toolArgs = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (error) {
          throw new LinkClientError(LINK_ERROR.INVALID_ARGUMENT, `--args-json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const execute = flag(args, 'execute');
      const idempotencyKey = opt(args, 'idempotencyKey');
      const started = await transport.request('agent.tools.invoke', { tool, args: toolArgs, execute }, {
        ...(typeof idempotencyKey === 'string' ? { idempotencyKey } : {}),
      });
      // --execute：标签页立即返回 runId（审批可能要等用户），这里跟随轨迹直到工具结束；--no-follow 只拿 runId。
      if (!execute || !started?.runId || flag(args, 'noFollow') || args.follow === false) return started;
      let doneEvent = null;
      const final = await followRunTrace(transport, started.runId, {
        onEvent: event => {
          if (event.type === 'done') doneEvent = event;
          print({ ok: true, command: 'agent.trace', runId: started.runId, event });
        },
      });
      return { ...started, phase: final.phase, done: true, ...(doneEvent?.result !== undefined ? { result: doneEvent.result } : {}), ...(final.error ? { error: final.error } : {}) };
    }
    case 'agent.e2e':
      return runAgentE2e(transport, args, context);
    default:
      throw new LinkClientError(LINK_ERROR.UNKNOWN_COMMAND, `未知命令：${command}`);
  }
}

/* ── agent.e2e：脚本化场景 ── */

/**
 * 场景提示词带 [e2e:*] 标记：mock 模型据此走固定脚本；真实模型也能按自然语言照做（但默认拒绝真实模型，避免花钱）。
 * expect 只断言真实发生的事：事件来自标签页里 provider 的真实返回，不在 CLI 端补造。
 */
export const E2E_SCENARIOS = Object.freeze([
  { id: 'answer', title: '普通回答', prompt: '[e2e:answer] 用一句话介绍 Iris，不要调用任何工具。' },
  { id: 'tool', title: '调工具', prompt: '[e2e:tool] 调用 iris_workflow_inspect（summary=true）看看画布上有哪些节点，然后用一句话总结。' },
  { id: 'tool-error', title: '工具失败', prompt: '[e2e:tool-error] 用 iris_workflow_focus_nodes 定位节点 e2e-missing-node（它不存在），然后说明结果。' },
  { id: 'approval', title: '审批', prompt: '[e2e:approval] 用 iris_note_write 在画布上写一条备注「e2e 审批测试」，然后告诉我写好了。' },
  { id: 'parallel', title: '两会话并行', prompts: ['[e2e:parallel-a] 慢慢想一想，然后回答：A。', '[e2e:parallel-b] 慢慢想一想，然后回答：B。'] },
  { id: 'cancel', title: '取消', prompt: '[e2e:cancel] 详细地、一步一步地思考很长时间后再回答。' },
]);

function check(name, ok, detail) {
  return { name, ok: Boolean(ok), ...(detail !== undefined ? { detail } : {}) };
}

async function runScenario(transport, scenario, options) {
  const startedAt = Date.now();
  const key = () => 'e2e-' + scenario.id + '-' + randomUUID();
  const runs = [];
  const traces = new Map();
  const follow = async (runId, hooks = {}) => {
    const events = [];
    traces.set(runId, events);
    const final = await followRunTrace(transport, runId, {
      timeoutMs: options.timeoutMs,
      waitMs: 5_000,
      onEvent: async event => {
        events.push(event);
        options.onEvent?.(scenario.id, runId, event);
        await hooks.onEvent?.(event);
      },
    });
    return { final, events };
  };
  const send = async (prompt, extra = {}) => {
    const started = await transport.request('agent.send', { prompt, ...extra }, { idempotencyKey: key() });
    runs.push(started.runId);
    return started;
  };
  const checks = [];
  const types = events => events.map(event => event.type);
  try {
    if (scenario.id === 'parallel') {
      const [a, b] = await Promise.all(scenario.prompts.map(prompt => send(prompt)));
      const running = new Set();
      let overlap = false;
      const onEvent = runId => event => {
        if (event.type === 'phase' && (event.phase === 'running' || event.phase === 'awaitingApproval')) running.add(runId);
        if (event.type === 'phase' && TERMINAL.has(event.phase)) { if (running.size === 2) overlap = true; running.delete(runId); }
        if (running.size === 2) overlap = true;
      };
      const [ra, rb] = await Promise.all([follow(a.runId, { onEvent: onEvent(a.runId) }), follow(b.runId, { onEvent: onEvent(b.runId) })]);
      checks.push(check('两轮都完成', ra.final.phase === 'done' && rb.final.phase === 'done', `${ra.final.phase} / ${rb.final.phase}`));
      checks.push(check('两个不同的会话', Boolean(ra.final.sessionId) && ra.final.sessionId !== rb.final.sessionId, `${ra.final.sessionId} / ${rb.final.sessionId}`));
      checks.push(check('同时在跑（运行区间重叠）', overlap));
    } else if (scenario.id === 'cancel') {
      const started = await send(scenario.prompt);
      let cancelled = false;
      const { final, events } = await follow(started.runId, {
        onEvent: async event => {
          if (cancelled) return;
          if (event.type === 'thinking' || event.type === 'text' || (event.type === 'phase' && event.phase === 'running')) {
            cancelled = true;
            await transport.request('agent.cancel', { runId: started.runId }, { idempotencyKey: key() });
          }
        },
      });
      checks.push(check('已发出取消', cancelled));
      checks.push(check('run 以 cancelled 结束', final.phase === 'cancelled', final.phase));
      checks.push(check('取消后没有新的工具开始', !events.slice(events.findIndex(event => event.type === 'phase' && event.phase === 'cancelled') + 1).some(event => event.type === 'tool.start')));
    } else if (scenario.id === 'approval') {
      const started = await send(scenario.prompt);
      const decisions = [];
      const { final, events } = await follow(started.runId, {
        onEvent: async event => {
          if (event.type !== 'approval.pending') return;
          const canApprove = event.cliApprovable && transport.scopes.includes('agent.approve');
          try {
            await transport.request(canApprove ? 'agent.approve' : 'agent.deny', { runId: started.runId, approvalId: event.approvalId }, { idempotencyKey: key() });
            decisions.push({ approvalId: event.approvalId, decision: canApprove ? 'approved' : 'denied', paid: event.paid });
          } catch (error) {
            decisions.push({ approvalId: event.approvalId, decision: 'error', code: error?.code });
          }
        },
      });
      const pending = events.filter(event => event.type === 'approval.pending');
      checks.push(check('出现审批（APPROVAL_PENDING）', pending.length > 0, pending.map(event => event.summary).join(' | ') || undefined));
      checks.push(check('CLI 处理了审批', decisions.length > 0 && decisions.every(item => item.decision !== 'error'), JSON.stringify(decisions)));
      checks.push(check('审批结果回到轨迹', events.some(event => event.type === 'approval.resolved')));
      checks.push(check('run 结束', TERMINAL.has(final.phase), final.phase));
      if (decisions.some(item => item.decision === 'approved')) checks.push(check('批准后工具成功', events.some(event => event.type === 'tool.end' && event.status === 'success' && /note/.test(String(event.tool)))));
      if (!transport.scopes.includes('agent.approve')) checks.push(check('没有 agent.approve 时 CLI 只能拒绝', decisions.every(item => item.decision === 'denied')));
    } else {
      const started = await send(scenario.prompt);
      const { final, events } = await follow(started.runId);
      checks.push(check('run 完成', final.phase === 'done', final.phase));
      checks.push(check('有回复正文', events.some(event => event.type === 'text' && event.excerpt), undefined));
      if (scenario.id === 'answer') checks.push(check('没有调用工具', !types(events).includes('tool.start')));
      if (scenario.id === 'tool') checks.push(check('工具调用成功', events.some(event => event.type === 'tool.end' && event.status === 'success')));
      if (scenario.id === 'tool-error') checks.push(check('工具失败被记录', events.some(event => event.type === 'tool.end' && event.status === 'error' && event.error)));
    }
  } catch (error) {
    checks.push(check('场景没有异常', false, error?.code ? `${error.code}: ${error.message}` : String(error?.message || error)));
  }
  return {
    id: scenario.id,
    title: scenario.title,
    ok: checks.length > 0 && checks.every(item => item.ok),
    runIds: runs,
    durationMs: Date.now() - startedAt,
    checks,
    traces: Object.fromEntries(traces),
  };
}

function renderMarkdown(report) {
  const label = report.mock ? 'Mock' : 'Real model';
  const lines = [
    `# Iris Agent harness e2e — ${label}`,
    '',
    `- 生成时间：${report.generatedAt}`,
    `- 传输：${report.target}${report.url ? `（${report.url}）` : ''}`,
    `- 模型：${report.model ? `${report.model.provider || '?'} / ${report.model.id}` : '未知'}${report.mock ? '（Mock，不产生费用）' : ''}`,
    `- 授予的范围：${report.scopes.join(', ') || '无'}`,
    `- 结果：${report.summary.passed}/${report.summary.total} 通过`,
    '',
    '| 场景 | 结果 | 用时 | 检查 |',
    '| --- | --- | --- | --- |',
    ...report.scenarios.map(item => `| ${item.title} (\`${item.id}\`) | ${item.ok ? '✅' : '❌'} | ${(item.durationMs / 1000).toFixed(1)}s | ${item.checks.map(c => `${c.ok ? '✓' : '✗'} ${c.name}`).join('<br>')} |`),
    '',
  ];
  for (const item of report.scenarios) {
    lines.push(`## ${item.title}（${item.id}）`, '');
    for (const c of item.checks) lines.push(`- ${c.ok ? '✓' : '✗'} ${c.name}${c.detail ? ` — ${String(c.detail).slice(0, 300)}` : ''}`);
    for (const [runId, events] of Object.entries(item.traces)) {
      lines.push('', `**run ${runId}**`, '', '```');
      for (const event of events) lines.push(`#${event.seq} ${event.type} ${traceLine(event)}`.trimEnd());
      lines.push('```');
    }
    lines.push('');
  }
  return lines.join('\n');
}

export function traceLine(event) {
  switch (event.type) {
    case 'phase': return event.phase;
    case 'thinking': return `“${event.summary || ''}”${event.ms ? ` ${Math.round(event.ms / 100) / 10}s` : ''}`;
    case 'tool.start': return `${event.tool}${event.target ? ' → ' + event.target : ''}`;
    case 'tool.end': return `${event.tool} ${event.status}${event.ms !== undefined ? ` ${event.ms}ms` : ''}${event.error ? ' — ' + event.error : ''}`;
    case 'skill': return event.id;
    case 'memory': return `${event.count} 条 ${(event.titles || []).join(' / ')}`;
    case 'context': return (event.items || []).map(item => item.label).join(', ');
    case 'budget': return `${event.tokens ? `in ${event.tokens.input} / out ${event.tokens.output}` : 'tokens 未上报'} · 付费 ${event.paidRuns}`;
    case 'artifact': return `${event.label} (${event.nodeId})`;
    case 'approval.pending': return `${event.approvalId} ${event.paid ? '[付费]' : ''}${event.blocked ? '[受阻]' : ''}${event.cliApprovable ? '[CLI 可批]' : '[需页面批准]'} ${event.summary || ''}`;
    case 'approval.resolved': return `${event.approvalId} ${event.approved ? 'approved' : 'denied'}${event.by ? ' by ' + event.by : ''}`;
    case 'text': return `“${String(event.excerpt || '').slice(0, 120)}”`;
    case 'error': return event.message || '';
    case 'done': return `${event.phase}${event.sessionId ? ' session=' + event.sessionId : ''}`;
    default: return '';
  }
}

export async function runAgentE2e(transport, args, context = {}) {
  const status = await transport.request('link.status', {});
  const model = status?.agent?.model || null;
  const mock = Boolean(model && /mock/i.test(`${model.id} ${model.provider || ''} ${model.baseUrl || ''}`));
  if (!status?.agent?.ready) {
    throw new LinkClientError(LINK_ERROR.AGENT_PANEL_CLOSED, status?.agent?.hint || 'Iris 标签页里的内置 Agent 没有就绪：打开画布右侧的 Agent 对话面板，并配好文本模型。');
  }
  if (!mock && !flag(args, 'allowRealModel')) {
    throw new LinkClientError('REAL_MODEL_REFUSED', `标签页用的是真实模型（${model ? model.id : '未知'}），agent.e2e 会发起 7 轮对话并可能产生费用。确认要跑请加 --allow-real-model。`);
  }
  const only = String(opt(args, 'only') || '').split(',').map(item => item.trim()).filter(Boolean);
  const scenarios = only.length ? E2E_SCENARIOS.filter(item => only.includes(item.id)) : E2E_SCENARIOS;
  const timeoutMs = Number(opt(args, 'timeoutMs')) || 180_000;
  const results = [];
  for (const scenario of scenarios) {
    context.progress?.(`e2e ${scenario.id}…`);
    const result = await runScenario(transport, scenario, { timeoutMs, onEvent: context.onE2eEvent });
    context.progress?.(`e2e ${scenario.id} ${result.ok ? 'ok' : 'FAILED'}`);
    results.push(result);
  }
  const where = await transport.describe().catch(() => ({}));
  const report = {
    schema: 'iris.agent-e2e-report/1',
    generatedAt: new Date().toISOString(),
    mock,
    label: mock ? 'Mock' : 'Real model',
    target: transport.kind,
    url: where.url || null,
    model,
    scopes: [...(transport.scopes || [])],
    summary: { total: results.length, passed: results.filter(item => item.ok).length },
    scenarios: results,
  };
  const outDir = resolve(String(opt(args, 'out') || `iris-e2e-${report.generatedAt.replace(/[:.]/g, '-')}`));
  mkdirSync(outDir, { recursive: true });
  const jsonFile = join(outDir, mock ? 'agent-e2e-report.mock.json' : 'agent-e2e-report.json');
  const mdFile = join(outDir, mock ? 'agent-e2e-report.mock.md' : 'agent-e2e-report.md');
  writeFileSync(jsonFile, JSON.stringify(report, null, 2) + '\n');
  writeFileSync(mdFile, renderMarkdown(report) + '\n');
  return { ok: report.summary.passed === report.summary.total, label: report.label, summary: report.summary, files: { json: jsonFile, markdown: mdFile }, scenarios: results.map(item => ({ id: item.id, ok: item.ok, runIds: item.runIds })) };
}
