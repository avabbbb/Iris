// @vitest-environment node
// Iris CLI 的 link 命令：argv 分流、login web / logout（假中继）、agent.* 命令在假标签页 transport 上的行为、agent.e2e 报告。
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { linkCommandFromArgv, runAgentLinkCommand, E2E_SCENARIOS } from '../tools/iris/link/agent-commands.js';
import { runLinkCli } from '../tools/iris/link/cli-link.js';
import { readLink, writeLink } from '../tools/iris/link/link-store.js';
import { resolveLinkTransport } from '../tools/iris/link/transports.js';
import { LinkClientError } from '../tools/iris/link/web-link-client.js';
import { expectOwnerOnlyFile } from './helpers/fileMode';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'iris-link-cli-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/**
 * 假标签页：按 prompt 里的 [e2e:*] 标记模拟一轮（与 mock 模型同一套剧本），轨迹按 trace 调用逐步放出；
 * 审批卡住直到 approve / deny，cancel 立即结束。
 */
function fakeTab(options: { scopes?: string[]; model?: string } = {}) {
  let seq = 0;
  const runs = new Map<string, any>();
  const calls: Array<{ cmd: string; args: any; idempotencyKey?: string }> = [];
  const idem = new Map<string, unknown>();
  let sessionSeq = 0;
  const script = (prompt: string) => {
    const marker = /\[e2e:([\w-]+)\]/.exec(prompt)?.[1] || 'answer';
    const tool = (name: string, status: string, error?: string) => [{ type: 'tool.start', tool: name, toolCallId: 'c-' + name }, { type: 'tool.end', tool: name, toolCallId: 'c-' + name, status, ms: 5, ...(error ? { error } : {}) }];
    switch (marker) {
      case 'tool': return [{ type: 'thinking', summary: '看看画布。' }, ...tool('iris_workflow_inspect', 'success'), { type: 'text', excerpt: '画布上有 2 个节点。' }];
      case 'tool-error': return [...tool('iris_workflow_focus_nodes', 'error', 'NOT_FOUND'), { type: 'text', excerpt: '节点不存在。' }];
      case 'approval': return [{ type: 'tool.start', tool: 'iris_note_write', toolCallId: 'c-note' }, { type: 'approval', paid: false }, { type: 'tool.end', tool: 'iris_note_write', toolCallId: 'c-note', status: 'success' }, { type: 'text', excerpt: '写好了。' }];
      case 'cancel': return [{ type: 'thinking', summary: '很长的思考……' }, { type: 'hang' }];
      default: return [{ type: 'text', excerpt: marker === 'answer' ? 'Iris 是画布。' : marker.toUpperCase() }];
    }
  };
  const push = (run: any, event: any) => { run.events.push({ seq: ++run.seq, at: 'now', ...event }); };
  const advance = (run: any) => {
    if (run.phase === 'queued') { run.phase = 'running'; push(run, { type: 'phase', phase: 'running' }); return; }
    if (['done', 'cancelled'].includes(run.phase) || run.approval) return;
    const step = run.script.shift();
    if (!step) { run.phase = 'done'; push(run, { type: 'phase', phase: 'done' }); push(run, { type: 'done', phase: 'done', sessionId: run.sessionId }); return; }
    if (step.type === 'hang') { run.script.unshift(step); return; }
    if (step.type === 'approval') {
      run.approval = { approvalId: run.runId + '-a1', summary: '写备注', paid: step.paid, cliApprovable: !step.paid };
      run.phase = 'awaitingApproval';
      push(run, { type: 'approval.pending', ...run.approval });
      push(run, { type: 'phase', phase: 'awaitingApproval' });
      return;
    }
    push(run, step);
  };
  const transport = {
    kind: 'web' as const,
    scopes: options.scopes || ['agent.read', 'agent.run', 'agent.approve'],
    calls,
    async describe() { return { transport: 'web', url: 'https://iris.test' }; },
    close() {},
    async request(cmd: string, args: any = {}, requestOptions: any = {}) {
      calls.push({ cmd, args, idempotencyKey: requestOptions.idempotencyKey });
      const key = requestOptions.idempotencyKey ? cmd + ':' + requestOptions.idempotencyKey : null;
      if (key && idem.has(key)) return idem.get(key);
      let result: any;
      if (cmd === 'link.status') result = { agent: { ready: true, model: { id: options.model || 'mock-chat', provider: 'openai' } } };
      else if (cmd === 'agent.send') {
        const runId = 'run-' + ++seq;
        const run = { runId, phase: 'queued', seq: 0, events: [] as any[], script: script(args.prompt), sessionId: 'sess-' + ++sessionSeq, approval: null as any };
        push(run, { type: 'phase', phase: 'queued' });
        runs.set(runId, run);
        result = { runId, phase: 'queued' };
      } else if (cmd === 'agent.trace') {
        const run = runs.get(args.runId);
        if (!run) throw new LinkClientError('UNKNOWN_RUN', 'no run');
        advance(run);
        result = { runId: run.runId, phase: run.phase, seq: run.seq, done: ['done', 'cancelled'].includes(run.phase), sessionId: run.sessionId, events: run.events.filter((event: any) => event.seq > (args.afterSeq || 0)), ...(run.approval ? { approval: run.approval, code: 'APPROVAL_PENDING' } : {}) };
      } else if (cmd === 'agent.approve' || cmd === 'agent.deny') {
        const run = runs.get(args.runId);
        if (cmd === 'agent.approve' && !run.approval.cliApprovable) throw new LinkClientError('APPROVAL_REQUIRES_USER', '付费只能在页面批准');
        const approved = cmd === 'agent.approve';
        push(run, { type: 'approval.resolved', approvalId: run.approval.approvalId, approved, by: 'cli' });
        if (!approved) run.script = run.script.map((step: any) => (step.type === 'tool.end' ? { ...step, status: 'denied' } : step));
        run.approval = null;
        run.phase = 'running';
        push(run, { type: 'phase', phase: 'running' });
        result = { runId: run.runId, decision: approved ? 'approved' : 'denied' };
      } else if (cmd === 'agent.cancel') {
        const run = runs.get(args.runId);
        run.phase = 'cancelled';
        push(run, { type: 'phase', phase: 'cancelled' });
        push(run, { type: 'done', phase: 'cancelled', sessionId: run.sessionId });
        result = { runId: run.runId, cancelled: true };
      } else if (cmd === 'agent.tools.invoke') result = { mode: args.execute ? 'execute' : 'dry-run', tool: args.tool, args: args.args };
      else result = { cmd };
      if (key) idem.set(key, result);
      return result;
    },
  };
  return transport;
}

describe('argv routing', () => {
  it('maps the spaced and dotted forms; bare `iris agent` stays the Agent server', () => {
    expect(linkCommandFromArgv(['login', 'web', '--open'])).toEqual({ command: 'login.web', rest: ['--open'] });
    expect(linkCommandFromArgv(['logout'])).toEqual({ command: 'logout', rest: [] });
    expect(linkCommandFromArgv(['link', 'status', '--json'])).toEqual({ command: 'link.status', rest: ['--json'] });
    expect(linkCommandFromArgv(['agent', 'send', '--prompt', 'x'])).toEqual({ command: 'agent.send', rest: ['--prompt', 'x'] });
    expect(linkCommandFromArgv(['agent', 'tools', 'invoke', '--tool', 't'])).toEqual({ command: 'agent.tools.invoke', rest: ['--tool', 't'] });
    expect(linkCommandFromArgv(['agent.trace', '--run', 'r'])).toEqual({ command: 'agent.trace', rest: ['--run', 'r'] });
    expect(linkCommandFromArgv(['agent'])).toBeNull();
    expect(linkCommandFromArgv(['agent', '--port', '1'])).toBeNull();
    expect(linkCommandFromArgv(['workflow.inspect'])).toBeNull();
  });
});

describe('agent link commands over a transport', () => {
  it('agent.send needs an idempotency key; --follow streams the trace as NDJSON lines', async () => {
    const transport = fakeTab();
    await expect(runAgentLinkCommand('agent.send', { prompt: 'hi', _: [] }, { transport })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    const lines: any[] = [];
    const result = await runAgentLinkCommand('agent.send', { prompt: '[e2e:tool] go', idempotencyKey: 'k1', follow: true, _: [] }, { transport, print: line => lines.push(line) });
    expect(result).toMatchObject({ runId: 'run-1', phase: 'done', done: true, sessionId: 'sess-1' });
    expect(lines.every(line => line.command === 'agent.trace' && line.runId === 'run-1')).toBe(true);
    expect(lines.map(line => line.event.type)).toEqual(['phase', 'phase', 'thinking', 'tool.start', 'tool.end', 'text', 'phase', 'done']);
    expect(transport.calls.find(call => call.cmd === 'agent.send')?.idempotencyKey).toBe('k1');
  });

  it('passes the tab refusal through when the CLI tries to approve a paid step', async () => {
    const transport = fakeTab();
    transport.request = (orig => async (cmd: string, args: any, opts: any) => {
      if (cmd === 'agent.approve') throw new LinkClientError('APPROVAL_REQUIRES_USER', '这一步会产生费用，只能由你在 Iris 页面上批准');
      return orig.call(transport, cmd, args, opts);
    })(transport.request);
    await expect(runAgentLinkCommand('agent.approve', { run: 'r', idempotencyKey: 'a' }, { transport })).rejects.toMatchObject({ code: 'APPROVAL_REQUIRES_USER' });
  });

  it('tools.invoke parses --args-json and defaults to dry-run', async () => {
    const transport = fakeTab();
    const dry = await runAgentLinkCommand('agent.tools.invoke', { tool: 'iris_workflow_inspect', argsJson: '{"summary":true}' }, { transport });
    expect(dry).toEqual({ mode: 'dry-run', tool: 'iris_workflow_inspect', args: { summary: true } });
    await expect(runAgentLinkCommand('agent.tools.invoke', { tool: 'x', argsJson: '{bad' }, { transport })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('agent.e2e runs every scenario and writes a Mock-labelled JSON + Markdown report', async () => {
    const transport = fakeTab();
    const out = join(dir, 'report');
    const result = await runAgentLinkCommand('agent.e2e', { out }, { transport });
    expect(result.summary).toEqual({ total: E2E_SCENARIOS.length, passed: E2E_SCENARIOS.length });
    expect(result.label).toBe('Mock');
    const report = JSON.parse(readFileSync(result.files.json, 'utf8'));
    expect(report).toMatchObject({ schema: 'iris.agent-e2e-report/1', mock: true, label: 'Mock', target: 'web', model: { id: 'mock-chat' } });
    expect(report.scenarios.map((item: any) => item.id)).toEqual(['answer', 'tool', 'tool-error', 'approval', 'parallel', 'cancel']);
    const approval = report.scenarios.find((item: any) => item.id === 'approval');
    expect(approval.checks.every((item: any) => item.ok)).toBe(true);
    const md = readFileSync(result.files.markdown, 'utf8');
    expect(md).toContain('# Iris Agent harness e2e — Mock');
    expect(md).toContain('approval.pending');
    expect(result.files.json).toMatch(/\.mock\.json$/);
  });

  it('agent.e2e without agent.approve only denies, and refuses a real model unless allowed', async () => {
    const limited = fakeTab({ scopes: ['agent.read', 'agent.run'] });
    const result = await runAgentLinkCommand('agent.e2e', { out: join(dir, 'r2'), only: 'approval' }, { transport: limited });
    expect(result.summary).toEqual({ total: 1, passed: 1 });
    expect(limited.calls.some(call => call.cmd === 'agent.approve')).toBe(false);
    expect(limited.calls.some(call => call.cmd === 'agent.deny')).toBe(true);
    await expect(runAgentLinkCommand('agent.e2e', { out: join(dir, 'r3') }, { transport: fakeTab({ model: 'deepseek-chat' }) })).rejects.toMatchObject({ code: 'REAL_MODEL_REFUSED' });
  });
});

describe('login web / logout against a fake relay', () => {
  function relay() {
    const log: Array<{ url: string; body: any; headers: any }> = [];
    let polls = 0;
    const fetchImpl = async (url: string, init: any = {}) => {
      const body = init.body ? JSON.parse(init.body) : null;
      log.push({ url, body, headers: init.headers });
      const respond = (status: number, json: unknown) => new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
      if (url.endsWith('/api/link/pair/start')) return respond(200, { ok: true, code: 'ABCD-2345', pollToken: 'ilk_p_' + 'a'.repeat(32) + '_' + 'p'.repeat(40), verificationUrl: 'https://iris.test/link', verificationUrlComplete: 'https://iris.test/link?code=ABCD-2345', expiresIn: 600, interval: 1 });
      if (url.endsWith('/api/link/pair/poll')) {
        polls += 1;
        if (polls < 2) return respond(202, { ok: false, error: { code: 'PAIR_PENDING' } });
        return respond(200, { ok: true, roomId: 'a'.repeat(32), accessToken: 'ilk_a_' + 'a'.repeat(32) + '_' + 'x'.repeat(40), refreshToken: 'ilk_r_' + 'a'.repeat(32) + '_' + 'y'.repeat(40), accessExpiresAt: new Date(Date.now() + 900_000).toISOString(), refreshExpiresAt: new Date(Date.now() + 86_400_000).toISOString(), scopes: ['agent.read', 'agent.run'], clientName: 'box' });
      }
      if (url.endsWith('/api/link/revoke')) return respond(200, { ok: true, revoked: true });
      return respond(404, { ok: false });
    };
    return { fetchImpl: fetchImpl as unknown as typeof fetch, log };
  }

  it('device flow prints the code, waits for the page, stores ~/.iris/link.json with 0600', async () => {
    const { fetchImpl, log } = relay();
    const file = join(dir, 'home', 'link.json');
    const lines: string[] = [];
    const progress: string[] = [];
    const opened: string[] = [];
    const code = await runLinkCli('login.web', ['--device', '--url', 'https://iris.test', '--name', 'box'], { fetchImpl, storeOptions: { file }, stdout: line => lines.push(line), progress: line => progress.push(line), pollIntervalMs: 1, openUrl: url => opened.push(url) });
    expect(code).toBe(0);
    expect(opened).toEqual([]);
    expect(progress.join('\n')).toContain('ABCD-2345');
    expect(JSON.parse(lines[0])).toMatchObject({ event: 'pairing', data: { code: 'ABCD-2345', mode: 'device' } });
    const final = JSON.parse(lines.at(-1)!);
    expect(final).toMatchObject({ ok: true, command: 'login.web', data: { linked: true, baseUrl: 'https://iris.test', scopes: ['agent.read', 'agent.run'] } });
    expect(final.data.accessToken).toMatch(/…$/);
    expectOwnerOnlyFile(file);
    expect(readLink({ file })).toMatchObject({ version: 1, roomId: 'a'.repeat(32), clientName: 'box' });
    expect(log[0].body).toMatchObject({ clientName: 'box', mode: 'device', scopes: ['agent.read', 'agent.run'] });
  });

  it('--open opens the confirm page; http is refused except loopback', async () => {
    const { fetchImpl } = relay();
    const opened: string[] = [];
    await runLinkCli('login.web', ['--open', '--url', 'https://iris.test'], { fetchImpl, storeOptions: { file: join(dir, 'l.json') }, stdout: () => undefined, progress: () => undefined, pollIntervalMs: 1, openUrl: url => opened.push(url) });
    expect(opened).toEqual(['https://iris.test/link?code=ABCD-2345']);
    const lines: string[] = [];
    const code = await runLinkCli('login.web', ['--url', 'http://iris.example'], { fetchImpl, storeOptions: { file: join(dir, 'l2.json') }, stdout: line => lines.push(line), progress: () => undefined });
    expect(code).toBe(1);
    expect(JSON.parse(lines[0]).error.code).toBe('INVALID_ARGUMENT');
  });

  it('logout revokes on the relay with the refresh token and deletes the file', async () => {
    const { fetchImpl, log } = relay();
    const file = join(dir, 'link.json');
    writeLink({ baseUrl: 'https://iris.test', roomId: 'a'.repeat(32), clientName: 'box', scopes: ['agent.read'], accessToken: 'ilk_a_x', accessExpiresAt: new Date().toISOString(), refreshToken: 'ilk_r_' + 'a'.repeat(32) + '_' + 'y'.repeat(40), refreshExpiresAt: new Date().toISOString() }, { file });
    const lines: string[] = [];
    const code = await runLinkCli('logout', [], { fetchImpl, storeOptions: { file }, stdout: line => lines.push(line), progress: () => undefined });
    expect(code).toBe(0);
    expect(JSON.parse(lines[0]).data).toMatchObject({ linked: false, serverRevoked: true, removedLocal: true });
    expect(log[0].headers.authorization).toBe('Bearer ilk_r_' + 'a'.repeat(32) + '_' + 'y'.repeat(40));
    expect(existsSync(file)).toBe(false);
  });
});

describe('--target auto', () => {
  it('prefers a ready local Iris, falls back to the web link, else NOT_LINKED', async () => {
    const file = join(dir, 'link.json');
    await expect(resolveLinkTransport('auto', { probeLocal: async () => false, web: { storeOptions: { file } } })).rejects.toMatchObject({ code: 'NOT_LINKED' });
    expect((await resolveLinkTransport('auto', { probeLocal: async () => true, local: { workspace: {} } })).kind).toBe('local');
    writeLink({ baseUrl: 'https://iris.test', roomId: 'r', clientName: 'c', scopes: ['agent.read'], accessToken: 'a', accessExpiresAt: new Date().toISOString(), refreshToken: 'r', refreshExpiresAt: new Date().toISOString() }, { file });
    const web = await resolveLinkTransport('auto', { probeLocal: async () => false, web: { storeOptions: { file } } });
    expect(web.kind).toBe('web');
    expect(web.scopes).toEqual(['agent.read']);
    await expect(resolveLinkTransport('bogus')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('local transport forwards to the workspace adapter and unwraps { ok, data }', async () => {
    const seen: any[] = [];
    const workspace = { execute: async (cmd: string, args: any, source: string, opts: any) => { seen.push({ cmd, args, source, opts }); return cmd === 'agent.deny' ? { ok: false, error: { code: 'NO_PENDING_APPROVAL', message: 'none' } } : { ok: true, data: { echoed: cmd } }; }, status: async () => ({ state: 'ready' }), config: { url: 'http://127.0.0.1:37521' } };
    const local = await resolveLinkTransport('local', { local: { workspace } });
    expect(await local.request('agent.sessions', {})).toEqual({ echoed: 'agent.sessions' });
    await expect(local.request('agent.cancel', { runId: 'r' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(local.request('agent.deny', { runId: 'r' }, { idempotencyKey: 'k' })).rejects.toMatchObject({ code: 'NO_PENDING_APPROVAL' });
    expect(seen[0]).toMatchObject({ cmd: 'agent.sessions', source: 'cli' });
    expect(seen[1].opts).toEqual({ idempotencyKey: 'k' });
  });
});
