// Iris Link 在标签页一侧：link 命令处理器（agentLinkCommands）+ 回合记录（agentLinkRuns）+ 中继宿主（webLinkHost）+ 本机 loopback 分流。
// 运行时用假的后台运行时（与 canvasSessionRunners.test 同一种），审批 / 取消 / 并行都走真实的 CanvasSessionRunners。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CanvasSessionRunners, type CanvasRunnerRuntime } from '../components/agent/canvasSessionRunners';
import { createWorkflowProject, useWorkflowStore } from '../components/workflow/store';
import type { AgentConfirmRequest } from '../services/agentSpendMandate';
import type { AgentConfirmVerdict } from '../services/runApproval';
import { notifyAgentLinkRunner, registerAgentLinkHost, resetAgentLinkHostsForTests, type AgentLinkPanelHost } from '../services/link/agentLinkHost';
import { resetAgentLinkRunsForTests, agentLinkRunManager } from '../services/link/agentLinkRuns';
import { decideLinkApprovalFromPage, handleAgentLinkCommand, LOCAL_LINK_SCOPES } from '../services/link/agentLinkCommands';
import { LINK_PAIRINGS_KEY, WebLinkHost, readLinkPairings } from '../services/link/webLinkHost';
import { LINK_CLOSE, LINK_MAX_FRAME_BYTES } from '../tools/iris/link/protocol.js';

type Emit = (event: { type: string; [key: string]: unknown }) => void;
type Confirm = (summary: string, request?: AgentConfirmRequest) => Promise<AgentConfirmVerdict>;
type Script = (io: { emit: Emit; confirm: Confirm; signal: { cancelled: boolean } }) => Promise<void>;

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(check: () => boolean | Promise<boolean>, label = 'condition') {
  for (let index = 0; index < 400; index += 1) {
    if (await check()) return;
    await tick();
  }
  throw new Error('timed out waiting for ' + label);
}

const READ = ['agent.read'];
const RUN = ['agent.read', 'agent.run'];
const APPROVE = ['agent.read', 'agent.run', 'agent.approve'];
const ctx = (scopes: readonly string[], idempotencyKey?: string) => ({ scopes, source: 'web' as const, clientName: 'test-cli', ...(idempotencyKey ? { idempotencyKey } : {}) });

const thinkThenAnswer = (thinking: string, text: string): Script => async ({ emit }) => {
  emit({ type: 'message_start' });
  emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: thinking } });
  emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: text } });
};

const toolCall = (name: string, args: unknown, result: { text: string; isError?: boolean }): Script => async ({ emit }) => {
  emit({ type: 'message_start' });
  emit({ type: 'tool_execution_start', toolCallId: 'c-' + name, toolName: name, args });
  emit({ type: 'tool_execution_end', toolCallId: 'c-' + name, toolName: name, result: { content: [{ type: 'text', text: result.text }] }, isError: Boolean(result.isError) });
  emit({ type: 'message_start' });
  emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: result.isError ? '工具失败了' : '看过了' } });
};

/** 假面板宿主：prompt 文本里的 [key] 选脚本；会话按回合新建。 */
function installHost(scripts: Record<string, Script>, options: { paidMandate?: boolean } = {}) {
  const project = { ...createWorkflowProject('Link 测试'), id: 'p-link' };
  useWorkflowStore.setState({ projects: [project], activeProjectId: project.id } as never);
  let sessionSeq = 0;
  const sessions: Array<{ id: string; title: string; updatedAt: string }> = [{ id: 'sess-old', title: '旧会话', updatedAt: new Date(0).toISOString() }];
  const opened: string[] = [];
  const connectBackground: AgentLinkPanelHost['connectBackground'] = async ({ session, confirm }) => {
    const sessionId = session === 'new' ? 'sess-' + ++sessionSeq : session.id;
    opened.push(sessionId);
    if (!sessions.some(item => item.id === sessionId)) sessions.push({ id: sessionId, title: sessionId, updatedAt: new Date().toISOString() });
    const listeners = new Set<Emit>();
    const signal = { cancelled: false };
    let wake: (() => void) | null = null;
    const runtime: CanvasRunnerRuntime = {
      subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
      send: async text => {
        const key = /\[([\w-]+)\]/.exec(text)?.[1] || '';
        const script = scripts[key];
        const emit: Emit = event => listeners.forEach(listener => listener(event));
        const cancelled = new Promise<void>(resolve => { wake = resolve; });
        await Promise.race([script ? script({ emit, confirm, signal }) : Promise.resolve(), cancelled]);
      },
      cancel: () => { signal.cancelled = true; wake?.(); },
      snapshot: async () => ({ sessionId, messages: [] }),
      close: async () => undefined,
    };
    return runtime;
  };
  const canvasRunners = new CanvasSessionRunners({ projectId: project.id, connect: connectBackground, onChange: state => notifyAgentLinkRunner(project.id, state), onFinished: state => notifyAgentLinkRunner(project.id, state), storage: null });
  const host: AgentLinkPanelHost = {
    projectId: project.id,
    language: 'zho',
    connectBackground,
    listSessions: async () => sessions,
    canvasRunners,
    mandate: { get: () => null, set: () => undefined, enabled: () => Boolean(options.paidMandate) },
    approval: () => ({ mode: 'always-ask' }),
    isSessionBusy: () => false,
    model: () => ({ id: 'mock-chat', provider: 'openai' }),
  };
  const unregister = registerAgentLinkHost(host);
  return { project, host, opened, sessions, unregister };
}

async function call(command: string, args: Record<string, unknown>, scopes: readonly string[] = APPROVE, key?: string) {
  const result = await handleAgentLinkCommand(command, args, ctx(scopes, key));
  return result as { ok: boolean; data?: any; error?: any };
}

async function traceAll(runId: string) {
  const view = await call('agent.trace', { runId, afterSeq: 0 });
  return view.data as { phase: string; done: boolean; events: Array<{ type: string; [key: string]: any }>; approval?: any; code?: string };
}

beforeEach(() => {
  resetAgentLinkHostsForTests();
  resetAgentLinkRunsForTests();
});
afterEach(() => {
  resetAgentLinkHostsForTests();
  resetAgentLinkRunsForTests();
});

describe('Iris Link commands in the tab', () => {
  it('link.status reports the model id and readiness, never the key', async () => {
    useWorkflowStore.setState({ projects: [{ ...createWorkflowProject('无面板'), id: 'p0' }], activeProjectId: 'p0' } as never);
    const closed = await call('link.status', {}, READ);
    expect(closed.data.agent).toMatchObject({ ready: false });
    installHost({});
    const status = await call('link.status', {}, READ);
    expect(status.data).toMatchObject({ agent: { ready: true, model: { id: 'mock-chat', provider: 'openai' }, approvalMode: 'always-ask' }, grant: { scopes: READ } });
    expect(JSON.stringify(status.data)).not.toMatch(/apiKey|sk-|baseUrl/);
  });

  it('agent.send runs a turn and the trace carries real thinking, tools and the reply; same key = same run', async () => {
    installHost({ answer: thinkThenAnswer('先想一想开场。', 'Iris 是一个画布。'), tool: toolCall('iris_workflow_inspect', { summary: true }, { text: '{"nodes":[]}' }) });
    const missingKey = await call('agent.send', { prompt: '[answer] hi' }, RUN);
    expect(missingKey.error.code).toBe('INVALID_ARGUMENT');
    const sent = await call('agent.send', { prompt: '[answer] hi' }, RUN, 'k-1');
    expect(sent.ok).toBe(true);
    const again = await call('agent.send', { prompt: '[answer] hi' }, RUN, 'k-1');
    expect(again.data.runId).toBe(sent.data.runId);
    await until(async () => (await traceAll(sent.data.runId)).done, 'answer done');
    const trace = await traceAll(sent.data.runId);
    expect(trace.phase).toBe('done');
    const types = trace.events.map(event => event.type);
    expect(types[0]).toBe('phase');
    expect(types).toContain('thinking');
    expect(trace.events.find(event => event.type === 'thinking')?.summary).toBe('先想一想开场。');
    expect(trace.events.find(event => event.type === 'text')?.excerpt).toBe('Iris 是一个画布。');
    expect(types[types.length - 1]).toBe('done');
    expect(trace.events.find(event => event.type === 'done')).toMatchObject({ phase: 'done', sessionId: 'sess-1' });
    // seq 单调、afterSeq 只回新的。
    const seqs = trace.events.map(event => event.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    const tail = await call('agent.trace', { runId: sent.data.runId, afterSeq: seqs[seqs.length - 2] });
    expect(tail.data.events).toHaveLength(1);

    const tool = await call('agent.send', { prompt: '[tool] look' }, RUN, 'k-2');
    await until(async () => (await traceAll(tool.data.runId)).done, 'tool done');
    const toolTrace = await traceAll(tool.data.runId);
    expect(toolTrace.events.filter(event => event.type.startsWith('tool.')).map(event => [event.type, event.tool, event.status])).toEqual([
      ['tool.start', 'iris_workflow_inspect', undefined],
      ['tool.end', 'iris_workflow_inspect', 'success'],
    ]);
    // 没有 reasoning 的回合不编造思考摘要。
    expect(toolTrace.events.some(event => event.type === 'thinking')).toBe(false);
  });

  it('records a failing tool with its error', async () => {
    installHost({ bad: toolCall('iris_workflow_focus_nodes', { nodeIds: ['missing'] }, { text: 'NOT_FOUND: 节点不存在', isError: true }) });
    const sent = await call('agent.send', { prompt: '[bad] go' }, RUN, 'k-bad');
    await until(async () => (await traceAll(sent.data.runId)).done, 'bad done');
    const end = (await traceAll(sent.data.runId)).events.find(event => event.type === 'tool.end');
    expect(end).toMatchObject({ tool: 'iris_workflow_focus_nodes', status: 'error' });
    expect(end?.error).toContain('NOT_FOUND');
  });

  it('non-paid confirmations: APPROVAL_PENDING in the trace, CLI approves only with the agent.approve scope', async () => {
    let verdict: AgentConfirmVerdict | undefined;
    installHost({
      note: async ({ emit, confirm }) => {
        emit({ type: 'message_start' });
        emit({ type: 'tool_execution_start', toolCallId: 'c-note', toolName: 'iris_note_write', args: { text: 'x' } });
        verdict = await confirm('写一条备注', { kind: 'other', command: 'workflow.note.write', tier: 'write', tool: 'workflow.note.write' });
        emit({ type: 'tool_execution_end', toolCallId: 'c-note', toolName: 'iris_note_write', result: { content: [{ type: 'text', text: '{"nodeId":"n1"}' }] }, isError: verdict !== true });
      },
    });
    const sent = await call('agent.send', { prompt: '[note] write' }, RUN, 'k-note');
    await until(async () => (await traceAll(sent.data.runId)).phase === 'awaitingApproval', 'awaiting approval');
    const waiting = await traceAll(sent.data.runId);
    expect(waiting.code).toBe('APPROVAL_PENDING');
    const pending = waiting.events.find(event => event.type === 'approval.pending')!;
    expect(pending).toMatchObject({ paid: false, destructive: false, cliApprovable: true, tier: 'write' });
    const noScope = await call('agent.approve', { runId: sent.data.runId, approvalId: pending.approvalId }, RUN, 'a-1');
    expect(noScope.error.code).toBe('SCOPE_DENIED');
    const approved = await call('agent.approve', { runId: sent.data.runId, approvalId: pending.approvalId }, APPROVE, 'a-2');
    expect(approved.data).toMatchObject({ decision: 'approved' });
    await until(async () => (await traceAll(sent.data.runId)).done, 'note done');
    expect(verdict).toBe(true);
    const resolved = (await traceAll(sent.data.runId)).events.find(event => event.type === 'approval.resolved');
    expect(resolved).toMatchObject({ approvalId: pending.approvalId, approved: true, by: 'cli' });
  });

  it('paid confirmations can never be approved from the CLI; deny works; the page can approve', async () => {
    const verdicts: AgentConfirmVerdict[] = [];
    const paid: AgentConfirmRequest = { kind: 'generation', command: 'workflow.node.run', gates: [{ serviceLabel: 's', modelLabel: 'm', mediaType: 'image', taskCount: 1 } as never] };
    installHost({ paid: async ({ confirm }) => { verdicts.push(await confirm('生成 1 张图', paid)); verdicts.push(await confirm('再生成 1 张', paid)); } });
    const sent = await call('agent.send', { prompt: '[paid] go' }, APPROVE, 'k-paid');
    await until(async () => Boolean((await traceAll(sent.data.runId)).approval), 'paid approval');
    const first = (await traceAll(sent.data.runId)).approval;
    expect(first).toMatchObject({ paid: true, cliApprovable: false });
    const refused = await call('agent.approve', { runId: sent.data.runId }, APPROVE, 'p-1');
    expect(refused.error.code).toBe('APPROVAL_REQUIRES_USER');
    const denied = await call('agent.deny', { runId: sent.data.runId }, RUN, 'p-2');
    expect(denied.data.decision).toBe('denied');
    await until(async () => (await traceAll(sent.data.runId)).approval?.approvalId !== first.approvalId && Boolean((await traceAll(sent.data.runId)).approval), 'second approval');
    const second = (await traceAll(sent.data.runId)).approval;
    // 页面托盘上用户本人批准。
    expect(agentLinkRunManager('p-link').pendingTrayApprovals().map(item => item.approval.approvalId)).toEqual([second.approvalId]);
    expect(decideLinkApprovalFromPage(sent.data.runId, second.approvalId, true)).toBe(true);
    await until(async () => (await traceAll(sent.data.runId)).done, 'paid done');
    expect(verdicts).toEqual([false, true]);
    const resolved = (await traceAll(sent.data.runId)).events.filter(event => event.type === 'approval.resolved');
    expect(resolved.map(event => [event.approved, event.by])).toEqual([[false, 'cli'], [true, 'page']]);
  });

  it('agent.cancel stops only that run; two sessions run in parallel', async () => {
    const release: Array<() => void> = [];
    const slow: Script = async ({ emit }) => {
      emit({ type: 'message_start' });
      emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: '慢慢想。' } });
      await new Promise<void>(resolve => release.push(resolve));
      emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '好了' } });
    };
    installHost({ a: slow, b: slow, long: slow });
    const a = await call('agent.send', { prompt: '[a] A' }, RUN, 'k-a');
    const b = await call('agent.send', { prompt: '[b] B' }, RUN, 'k-b');
    await until(async () => (await traceAll(a.data.runId)).phase === 'running' && (await traceAll(b.data.runId)).phase === 'running', 'both running');
    const cancelled = await call('agent.cancel', { runId: a.data.runId }, RUN, 'c-a');
    expect(cancelled.data.cancelled).toBe(true);
    await until(async () => (await traceAll(a.data.runId)).done, 'a cancelled');
    expect((await traceAll(a.data.runId)).phase).toBe('cancelled');
    expect((await traceAll(b.data.runId)).phase).toBe('running');
    release.forEach(resolve => resolve());
    await until(async () => (await traceAll(b.data.runId)).done, 'b done');
    expect((await traceAll(b.data.runId)).phase).toBe('done');
    const sessions = await call('agent.sessions', {}, READ);
    expect(sessions.data.runs.map((run: any) => run.phase).sort()).toEqual(['cancelled', 'done']);
    const doneEvents = [a, b].map(async item => (await traceAll(item.data.runId)).events.find(event => event.type === 'done')?.sessionId);
    const [sa, sb] = await Promise.all(doneEvents);
    expect(sa).not.toBe(sb);
  });

  it('long-poll trace waits for new events instead of spinning', async () => {
    let go: () => void = () => undefined;
    installHost({ wait: async ({ emit }) => { await new Promise<void>(resolve => { go = resolve; }); emit({ type: 'message_start' }); emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'x' } }); } });
    const sent = await call('agent.send', { prompt: '[wait] go' }, RUN, 'k-w');
    await until(async () => (await traceAll(sent.data.runId)).phase === 'running', 'running');
    const seq = (await traceAll(sent.data.runId)).events.at(-1)!.seq;
    const pending = call('agent.trace', { runId: sent.data.runId, afterSeq: seq, waitMs: 5000 });
    let settled = false;
    void pending.then(() => { settled = true; });
    await tick();
    expect(settled).toBe(false);
    go();
    const view = await pending;
    expect(view.data.events.length).toBeGreaterThan(0);
  });

  it('the tab re-checks scopes and needs the Agent panel', async () => {
    useWorkflowStore.setState({ projects: [{ ...createWorkflowProject('x'), id: 'p0' }], activeProjectId: 'p0' } as never);
    expect((await call('agent.send', { prompt: 'x' }, READ, 'k')).error.code).toBe('SCOPE_DENIED');
    expect((await call('agent.send', { prompt: 'x' }, RUN, 'k')).error.code).toBe('AGENT_PANEL_CLOSED');
    expect((await call('workflow.apply', {}, LOCAL_LINK_SCOPES)).error.code).toBe('UNKNOWN_COMMAND');
    expect((await call('agent.trace', { runId: 'nope' }, READ)).error.code).toBe('UNKNOWN_RUN');
  });

  it('tools.list shows tier + Tool Policy; tools.invoke is a dry-run policy check unless --execute with tools.invoke', async () => {
    installHost({});
    const list = await call('agent.tools.list', {}, READ);
    const byName = Object.fromEntries(list.data.tools.map((tool: any) => [tool.name, tool]));
    expect(byName.iris_workflow_inspect).toMatchObject({ command: 'workflow.inspect', tier: 'read', policy: 'allow' });
    expect(byName.iris_workflow_node_run).toMatchObject({ command: 'workflow.node.run', tier: 'exec', hardGate: 'spend', policy: 'prompt' });
    const dry = await call('agent.tools.invoke', { tool: 'iris_workflow_node_run', args: { nodeId: 'n1' } }, READ);
    expect(dry.data).toMatchObject({ mode: 'dry-run', paid: true, policy: 'prompt', valid: true });
    const invalid = await call('agent.tools.invoke', { tool: 'iris_workflow_node_run', args: { nodeId: 3 } }, READ);
    expect(invalid.data.valid).toBe(false);
    const noScope = await call('agent.tools.invoke', { tool: 'iris_workflow_inspect', args: {}, execute: true }, RUN, 'i-1');
    expect(noScope.error.code).toBe('SCOPE_DENIED');
    const noKey = await call('agent.tools.invoke', { tool: 'iris_workflow_inspect', args: {}, execute: true }, LOCAL_LINK_SCOPES);
    expect(noKey.error.code).toBe('INVALID_ARGUMENT');
  });

  it('workflow.read works with closed Agent panel and empty workspace; provider.status never leaks raw keys', async () => {
    const { setWorkflowUserApiKeysProvider } = await import('../services/workflowDispatcher');
    setWorkflowUserApiKeysProvider(() => [{ id: 'k1', provider: 'openai', capabilities: ['text'], name: 'Primary', key: 'sk-super-secret-value-9999' } as never]);
    useWorkflowStore.setState({ projects: [], activeProjectId: null } as never);
    try {
      const list = await call('workflow.read', { command: 'workflow.project.list' }, READ);
      expect(list.ok).toBe(true);
      expect(list.data).toMatchObject({ ok: true, result: [] });

      const providers = await call('workflow.read', { command: 'provider.status' }, READ);
      expect(providers.ok).toBe(true);
      expect(providers.data).toMatchObject({ ok: true, ready: true, providers: ['openai'] });
      expect(JSON.stringify(providers.data)).not.toContain('sk-super-secret');

      const denied = await call('workflow.read', { command: 'workflow.apply', args: {} }, READ);
      expect(denied.ok).toBe(false);
      expect(denied.error.code).toBe('SCOPE_DENIED');
    } finally {
      setWorkflowUserApiKeysProvider(undefined);
    }
  });

  it('media.upload verifies SHA-256 and media.download chunks script CSV without S3/R2', async () => {
    const { resetLinkMediaTransfersForTests, encodeBase64, sha256Hex } = await import('../services/link/mediaTransfer');
    resetLinkMediaTransfersForTests();
    const project = { ...createWorkflowProject('媒体直传测试'), id: 'p-media' };
    project.nodes.push({
      id: 'script-1',
      type: 'script',
      title: '分镜脚本',
      position: { x: 0, y: 0 },
      width: 320,
      height: 240,
      metadata: {
        scriptBreakdown: {
          shots: [{ index: 1, durationSec: 5, scene: '雨夜', action: '转身', camera: '推进' }],
        },
      },
    } as never);
    useWorkflowStore.setState({ projects: [project], activeProjectId: project.id } as never);

    // 1. 下载分片导出 CSV（无需 S3/R2）
    const dlStart = await call('media.download.start', { nodeIds: ['script-1'] }, READ);
    expect(dlStart.ok).toBe(true);
    expect(dlStart.data).toMatchObject({ fileName: '分镜脚本.csv', mimeType: 'text/csv', totalChunks: 1 });
    const dlChunk = await call('media.download.chunk', { downloadId: dlStart.data.downloadId, index: 0, release: true }, READ);
    expect(dlChunk.ok).toBe(true);
    expect(dlChunk.data.done).toBe(true);

    // 2. 上传分片 SHA-256 校验失败会被拒绝
    const rawBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const wrongSha = '0'.repeat(64);
    const upStart = await call('media.upload.start', { fileName: 'a.png', mimeType: 'image/png', bytes: rawBytes.length, sha256: wrongSha }, LOCAL_LINK_SCOPES, 'u-start');
    expect(upStart.ok).toBe(true);
    const upChunk = await call('media.upload.chunk', { uploadId: upStart.data.uploadId, index: 0, dataBase64: encodeBase64(rawBytes) }, LOCAL_LINK_SCOPES);
    expect(upChunk.ok).toBe(true);
    const upFinish = await call('media.upload.finish', { uploadId: upStart.data.uploadId }, LOCAL_LINK_SCOPES, 'u-finish');
    expect(upFinish.ok).toBe(false);
    expect(upFinish.error.code).toBe('CHECKSUM_MISMATCH');
    expect(await sha256Hex(rawBytes)).toHaveLength(64);
  });
});

describe('web link host (tab ↔ relay WebSocket)', () => {
  class FakeSocket {
    static last: FakeSocket | null = null;
    readyState = 1;
    sent: string[] = [];
    listeners: Record<string, Array<(event: any) => void>> = {};
    constructor(readonly url: string, readonly protocols: string[]) { FakeSocket.last = this; }
    send(text: string) { this.sent.push(text); }
    close() { this.emit('close', { code: 1000 }); }
    addEventListener(type: string, listener: (event: any) => void) { (this.listeners[type] ||= []).push(listener); }
    emit(type: string, event: any) { for (const listener of this.listeners[type] || []) listener(event); }
  }

  function storage() {
    const map = new Map<string, string>();
    return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => void map.set(key, value), removeItem: (key: string) => void map.delete(key) };
  }

  it('connects with the tab token in the subprotocol, serves requests with the scope intersection, drops on revoke', async () => {
    const store = storage();
    store.setItem(LINK_PAIRINGS_KEY, JSON.stringify([{ roomId: 'r'.repeat(32), tabToken: 'ilk_t_' + 'r'.repeat(32) + '_' + 's'.repeat(40), clientName: 'cli', scopes: ['agent.read', 'agent.run'], baseUrl: 'https://iris.test', linkedAt: 'now' }]));
    const handle = vi.fn(async (command: string, _args: unknown, context: { scopes: readonly string[] }) => ({ ok: true as const, data: { command, scopes: context.scopes } }));
    const host = new WebLinkHost({ storage: store, WebSocketImpl: FakeSocket as never, locks: null, handle: handle as never });
    host.start();
    const socket = FakeSocket.last!;
    expect(socket.url).toBe('wss://iris.test/api/link/ws?role=tab');
    expect(socket.protocols).toEqual(['iris-link.v1', 'bearer.ilk_t_' + 'r'.repeat(32) + '_' + 's'.repeat(40)]);
    socket.emit('open', {});
    expect(JSON.parse(socket.sent[0])).toMatchObject({ t: 'hello' });
    expect(host.getSnapshot().pairings[0]).toMatchObject({ status: 'online', clientName: 'cli' });
    expect(JSON.stringify(host.getSnapshot())).not.toContain('ilk_t_');
    // 中继附带了 agent.approve，但标签页自己的记录没有：取交集。
    socket.emit('message', { data: JSON.stringify({ t: 'req', id: 's1:1', cmd: 'agent.sessions', args: {}, grant: { scopes: ['agent.read', 'agent.approve'] } }) });
    await until(() => socket.sent.length > 1, 'response');
    expect(JSON.parse(socket.sent[1])).toEqual({ t: 'res', id: 's1:1', ok: true, data: { command: 'agent.sessions', scopes: ['agent.read'] } });
    // 超大的结果改成 FRAME_TOO_LARGE，而不是让中继拒收。
    handle.mockResolvedValueOnce({ ok: true, data: { blob: 'x'.repeat(LINK_MAX_FRAME_BYTES) } } as never);
    socket.emit('message', { data: JSON.stringify({ t: 'req', id: 's1:2', cmd: 'agent.sessions', args: {}, grant: { scopes: ['agent.read'] } }) });
    await until(() => socket.sent.length > 2, 'big response');
    expect(JSON.parse(socket.sent[2]).error.code).toBe('FRAME_TOO_LARGE');
    socket.emit('close', { code: LINK_CLOSE.REVOKED });
    expect(readLinkPairings(store)).toEqual([]);
    host.stop();
  });
});

describe('local loopback: the existing bridge routes link commands to the same handler', () => {
  it('answers link.status through WorkflowAgentBridge tool_call with local scopes', async () => {
    installHost({});
    const { WorkflowAgentBridge } = await import('../services/workflowAgentBridge');
    const bridge = new WorkflowAgentBridge({ url: 'http://127.0.0.1:1', token: 't' });
    const post = vi.spyOn(bridge as never as { post: (...args: unknown[]) => Promise<unknown> }, 'post').mockResolvedValue({ ok: true });
    await (bridge as never as { handleToolCall: (payload: unknown) => Promise<void> }).handleToolCall({ requestId: 'r1', envelope: { id: 'e1', command: 'link.status', args: {}, source: 'cli' } });
    const [, body] = post.mock.calls[0] as [string, { result: { ok: boolean; data: any } }];
    expect(body.result.ok).toBe(true);
    expect(body.result.data).toMatchObject({ source: 'local', grant: { scopes: [...LOCAL_LINK_SCOPES] }, agent: { ready: true } });
  });
});
