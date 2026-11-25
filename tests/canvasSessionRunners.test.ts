import { describe, expect, it } from 'vitest';
import { CanvasSessionRunners, reduceRunnerEvent, settleRunnerMessages, type CanvasRunnerRuntime, type CanvasRunnerState, type CanvasSessionRunnerDeps } from '../components/agent/canvasSessionRunners';
import { createSpendMandate, type AgentConfirmRequest, type AgentSpendMandate } from '../services/agentSpendMandate';
import type { AgentConfirmVerdict } from '../services/runApproval';
import { applyWorkflowMutation } from '../components/workflow/draftAuthority';
import { createWorkflowProject } from '../components/workflow/store';
import { reduceAgentSessionTrace, deriveAgentSessionStatus, currentTurnMessages } from '../components/workflow/agentSessionTrace';
import type { WorkflowProject } from '../components/workflow/types';

type Emit = (event: { type: string; [key: string]: unknown }) => void;
type Confirm = (summary: string, request?: AgentConfirmRequest) => Promise<AgentConfirmVerdict>;
type Script = (io: { emit: Emit; confirm: Confirm; signal: { cancelled: boolean } }) => Promise<void>;

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(check: () => boolean, label = 'condition') {
  for (let index = 0; index < 200; index += 1) {
    if (check()) return;
    await tick();
  }
  throw new Error('timed out waiting for ' + label);
}

/** 假运行时：每张卡一个脚本；会话 id 按卡片分配，cancel 让脚本里的 await 立刻结束。 */
function harness(scripts: Record<string, Script>, extra: Partial<CanvasSessionRunnerDeps> = {}) {
  const changes: CanvasRunnerState[] = [];
  const opened: Array<{ session: { id: string } | 'new' }> = [];
  const closed: string[] = [];
  let sessionSeq = 0;
  let current: string | null = null;
  const runners: CanvasSessionRunners = new CanvasSessionRunners({
    projectId: 'p1',
    language: 'zho',
    connect: async ({ session, confirm }) => {
      opened.push({ session });
      const sessionId = session === 'new' ? 'sess-new-' + ++sessionSeq : session.id;
      const listeners = new Set<Emit>();
      const signal = { cancelled: false };
      let cancelWake: (() => void) | null = null;
      const runtime: CanvasRunnerRuntime = {
        subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
        send: async text => {
          const card = runners.list().find(state => state.sessionId === sessionId || (state.phase === 'running' && state.request.text === text))?.request.cardNodeId || current || '';
          const script = scripts[card];
          const emit: Emit = event => listeners.forEach(listener => listener(event));
          const cancelled = new Promise<void>(resolve => { cancelWake = resolve; });
          await Promise.race([script ? script({ emit, confirm, signal }) : Promise.resolve(), cancelled]);
        },
        cancel: () => { signal.cancelled = true; cancelWake?.(); },
        snapshot: async () => ({ sessionId, messages: [] }),
        close: async () => { closed.push(sessionId); },
      };
      return runtime;
    },
    onChange: state => changes.push(state),
    ...extra,
  });
  return { runners, changes, opened, closed, setCurrent: (card: string) => { current = card; } };
}

const textReply = (text: string): Script => async ({ emit }) => {
  emit({ type: 'message_start' });
  emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: text } });
};

const generation = (tasks = 1): AgentConfirmRequest => ({
  kind: 'generation',
  command: 'workflow.node.run',
  gates: Array.from({ length: tasks }, () => ({ serviceLabel: 's', modelLabel: 'm', mediaType: 'image' as const, taskCount: 1, estimatedCost: { amount: 0.1, currency: 'USD' as const } })),
});

describe('canvas session runners — event reduction', () => {
  it('turns kernel events into display messages with the same shape the panel uses', () => {
    let cursor = { streamId: 'stream-runner-0', seq: 0 };
    let messages: ReturnType<typeof reduceRunnerEvent>['messages'] = [{ id: 'u', role: 'user', text: '做一张海报' }];
    const step = (event: { type: string; [key: string]: unknown }, now: number) => {
      const next = reduceRunnerEvent(messages, cursor, event, { now, language: 'zho', toolLabel: name => (name === 'iris_workflow_apply' ? '修改画布' : undefined) });
      messages = next.messages;
      cursor = next.cursor;
    };
    step({ type: 'message_start' }, 1000);
    step({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: '先看素材。' } }, 1000);
    step({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'iris_workflow_apply', args: { operations: [] } }, 3000);
    step({ type: 'tool_execution_end', toolCallId: 'c1', toolName: 'iris_workflow_apply', result: { content: [{ type: 'text', text: '{"nodeId":"n1"}' }] }, isError: false }, 3400);
    step({ type: 'message_start' }, 3500);
    step({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '好了' } }, 3600);
    expect(messages.map(item => item.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(messages[1]).toMatchObject({ thinking: '先看素材。', thinkingDone: true, thinkingMs: 2000 });
    expect(messages[2]).toMatchObject({ id: 'tool-c1', toolCallId: 'c1', title: '修改画布', status: 'success', startedAt: 3000, endedAt: 3400, text: '{"nodeId":"n1"}' });
    expect(messages[3]).toMatchObject({ text: '好了' });
    // 同一份消息直接喂给卡片轨迹归约（Context / Budget / Artifact 三处共用）。
    const trace = reduceAgentSessionTrace(currentTurnMessages(messages).after, { running: false, nodes: [{ id: 'n1', title: '海报', type: 'image' }] });
    expect(trace.steps).toHaveLength(1);
    expect(trace.artifacts).toEqual([{ nodeId: 'n1', label: '海报', type: 'image', toolCallId: 'c1' }]);
  });

  it('stopping marks unfinished tools as not run and freezes thinking', () => {
    const settled = settleRunnerMessages([
      { id: 'a', role: 'assistant', text: '', thinking: 'x', thinkingStartedAt: 100 },
      { id: 'tool-1', role: 'tool', text: '', status: 'pending', startedAt: 200 },
    ], 900, 'cancelled');
    expect(settled[0]).toMatchObject({ thinkingDone: true, thinkingMs: 800 });
    expect(settled[1]).toMatchObject({ status: 'denied', endedAt: 900 });
  });
});

describe('canvas session runners — scheduling, approvals, cancel, restore, conflicts', () => {
  it('B finishes while A waits for approval (approvals are per session, the queue is not blocked)', async () => {
    let approvedA: AgentConfirmVerdict | undefined;
    const { runners } = harness({
      A: async ({ emit, confirm }) => {
        emit({ type: 'tool_execution_start', toolCallId: 'a1', toolName: 'iris_workflow_apply', args: {} });
        approvedA = await confirm('修改画布', { kind: 'other', command: 'workflow.apply' });
        emit({ type: 'tool_execution_end', toolCallId: 'a1', toolName: 'iris_workflow_apply', result: { content: [] }, isError: false });
      },
      B: textReply('B 完成'),
    });
    runners.enqueue({ id: 'ra', cardNodeId: 'A', text: 'A 的问题' });
    runners.enqueue({ id: 'rb', cardNodeId: 'B', text: 'B 的问题' });
    await until(() => runners.get('A')?.phase === 'awaitingApproval', 'A awaiting approval');
    await until(() => runners.get('B')?.phase === 'done', 'B done');
    expect(runners.get('A')?.phase).toBe('awaitingApproval');
    expect(runners.get('B')?.messages.at(-1)).toMatchObject({ role: 'assistant', text: 'B 完成' });
    // 卡片只能批准当前那一项：错 id 无效。
    expect(runners.decide('A', 'nope', true)).toBe(false);
    expect(runners.decide('A', runners.get('A')!.approval!.id, true)).toBe(true);
    await until(() => runners.get('A')?.phase === 'done', 'A done');
    expect(approvedA).toBe(true);
  });

  it('cancelling A leaves B untouched; A\'s pending approval is rejected and its session released', async () => {
    let verdictA: AgentConfirmVerdict | undefined;
    let releaseB: () => void = () => undefined;
    const { runners, closed } = harness({
      A: async ({ confirm }) => { verdictA = await confirm('付费生成', generation()); },
      B: async ({ emit }) => {
        await new Promise<void>(resolve => { releaseB = resolve; });
        emit({ type: 'message_start' });
        emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'B ok' } });
      },
    });
    runners.enqueue({ id: 'ra', cardNodeId: 'A', sessionId: 'sa', text: 'A' });
    runners.enqueue({ id: 'rb', cardNodeId: 'B', sessionId: 'sb', text: 'B' });
    await until(() => runners.get('A')?.phase === 'awaitingApproval');
    expect(runners.cancel('A')).toBe(true);
    await until(() => runners.get('A')?.phase === 'cancelled', 'A cancelled');
    expect(verdictA).toBe(false);
    expect(closed).toContain('sa');
    expect(runners.get('B')?.phase).toBe('running');
    releaseB();
    await until(() => runners.get('B')?.phase === 'done', 'B done');
    expect(runners.get('B')?.messages.at(-1)).toMatchObject({ text: 'B ok' });
  });

  it('runs at most two at once, one turn per session, and a blocked head does not hold the queue', async () => {
    const gates: Record<string, () => void> = {};
    const hold = (card: string): Script => async () => { await new Promise<void>(resolve => { gates[card] = resolve; }); };
    let panelBusy = 'sx';
    const { runners } = harness({ A: hold('A'), B: hold('B'), C: hold('C'), D: hold('D') }, { isSessionBusy: id => id === panelBusy });
    // C 的会话正被面板主运行时占着：排在前面也不能挡住 D。
    runners.enqueue({ id: 'r1', cardNodeId: 'A', sessionId: 'sa', text: 'A' });
    runners.enqueue({ id: 'r2', cardNodeId: 'C', sessionId: 'sx', text: 'C' });
    runners.enqueue({ id: 'r3', cardNodeId: 'B', sessionId: 'sb', text: 'B' });
    runners.enqueue({ id: 'r4', cardNodeId: 'D', sessionId: 'sd', text: 'D' });
    await until(() => runners.runningCount() === 2);
    expect(runners.get('A')?.phase).toBe('running');
    expect(runners.get('B')?.phase).toBe('running');
    expect(runners.get('C')?.phase).toBe('queued');
    expect(runners.get('D')?.phase).toBe('queued');
    // 同一张卡在跑时不能再排一轮。
    expect(runners.enqueue({ id: 'r5', cardNodeId: 'A', sessionId: 'sa', text: 'again' })).toBe(false);
    await until(() => Boolean(gates.A));
    gates.A();
    // A 结束：C 仍被面板占着 → 跳过，D 先跑。
    await until(() => runners.get('D')?.phase === 'running', 'D running');
    expect(runners.get('C')?.phase).toBe('queued');
    panelBusy = '';
    await until(() => Boolean(gates.B));
    gates.B();
    await until(() => runners.get('C')?.phase === 'running', 'C running after panel freed the session');
  });

  it('shares the paid-run mandate with the panel: within the limit it auto-approves and the usage is visible to both', async () => {
    let shared: AgentSpendMandate | null = createSpendMandate({ maxTasks: 2 });
    const verdicts: AgentConfirmVerdict[] = [];
    const { runners } = harness({
      A: async ({ confirm }) => { verdicts.push(await confirm('', generation(2))); },
      B: async ({ confirm }) => { verdicts.push(await confirm('', generation(1))); },
    }, { mandate: { get: () => shared, set: next => { shared = next; }, enabled: () => true } });
    runners.enqueue({ id: 'ra', cardNodeId: 'A', sessionId: 'sa', text: 'A' });
    await until(() => runners.get('A')?.phase === 'done');
    expect(verdicts).toEqual([true]);
    expect(shared?.usedTasks).toBe(2);
    // 上限用完：B 的付费生成回到这个会话自己的卡片审批。
    runners.enqueue({ id: 'rb', cardNodeId: 'B', sessionId: 'sb', text: 'B' });
    await until(() => runners.get('B')?.phase === 'awaitingApproval');
    expect(runners.get('A')?.phase).toBe('done');
    runners.decide('B', runners.get('B')!.approval!.id, false);
    await until(() => runners.get('B')?.phase === 'done');
    expect(verdicts).toEqual([true, false]);
  });

  it('a blocked batch cannot be approved from the card', async () => {
    const blockedRequest: AgentConfirmRequest = { ...generation(), gates: [{ ...generation().gates![0], blockers: ['没有线路'] } as never] };
    const { runners } = harness({ A: async ({ confirm }) => { await confirm('', blockedRequest); } });
    runners.enqueue({ id: 'ra', cardNodeId: 'A', sessionId: 'sa', text: 'A' });
    await until(() => runners.get('A')?.phase === 'awaitingApproval');
    const approval = runners.get('A')!.approval!;
    expect(approval.blocked).toBe(true);
    expect(runners.decide('A', approval.id, true)).toBe(false);
    expect(runners.decide('A', approval.id, false)).toBe(true);
  });

  it('restores after a page refresh: queued turns re-run, half-finished ones are marked interrupted', async () => {
    const store = new Map<string, string>();
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); }, removeItem: (key: string) => { store.delete(key); } };
    const never: Script = () => new Promise(() => undefined);
    const first = harness({ A: never, B: async ({ confirm }) => { await confirm('x', { kind: 'other', command: 'workflow.apply' }); }, C: never }, { storage });
    first.runners.enqueue({ id: 'ra', cardNodeId: 'A', sessionId: 'sa', text: 'A' });
    first.runners.enqueue({ id: 'rb', cardNodeId: 'B', sessionId: 'sb', text: 'B' });
    first.runners.enqueue({ id: 'rc', cardNodeId: 'C', sessionId: 'sc', text: 'C' });
    await until(() => first.runners.get('B')?.phase === 'awaitingApproval');
    expect(JSON.parse(store.get('iris.canvasRunners.v1:p1')!).map((item: { phase: string }) => item.phase)).toEqual(['running', 'awaitingApproval', 'queued']);
    // 「刷新」：旧实例连同内存一起没了，新实例只看存储。
    const second = harness({ C: textReply('C 恢复后完成') }, { storage });
    const restored = second.runners.restore();
    expect(restored.map(item => item.request.cardNodeId)).toEqual(['A', 'B', 'C']);
    expect(second.runners.get('A')).toMatchObject({ phase: 'interrupted', sessionId: 'sa' });
    expect(second.runners.get('B')?.phase).toBe('interrupted');
    await until(() => second.runners.get('C')?.phase === 'done', 'C re-ran');
    expect(second.opened).toEqual([{ session: { id: 'sc' } }]);
    expect(store.has('iris.canvasRunners.v1:p1')).toBe(false);
  });

  it('two sessions writing the same node: the second write gets REVISION_CONFLICT and its card shows the conflict', async () => {
    let project: WorkflowProject = createWorkflowProject('冲突');
    const seeded = applyWorkflowMutation(project, { projectId: project.id, expectedRevision: project.draftVersion || 1, mutationId: 'seed', source: 'ui', ops: [{ type: 'add_node', node: { id: 'shared', type: 'text', title: '共享节点', position: { x: 0, y: 0 } } as never }] });
    if (!seeded.ok) throw new Error('seed failed');
    project = seeded.project;
    const base = project.draftVersion || 1;
    let readsDone = 0;
    // 两个会话都在同一版本读到节点，然后各自写它（真实的 Draft Authority 乐观锁）。
    const writer = (card: string, title: string): Script => async ({ emit }) => {
      readsDone += 1;
      await until(() => readsDone >= 2);
      if (card === 'B') await until(() => (project.draftVersion || 1) > base);
      emit({ type: 'tool_execution_start', toolCallId: card + '-w', toolName: 'iris_workflow_apply', args: { operations: [{ type: 'update_node', id: 'shared' }] } });
      const result = applyWorkflowMutation(project, { projectId: project.id, expectedRevision: base, mutationId: card + '-m', source: 'agent' as never, ops: [{ type: 'update_node', id: 'shared', patch: { title } } as never] });
      if (result.ok) project = result.project;
      const text = result.ok === false ? result.error.code + ': ' + result.error.message : JSON.stringify({ nodeId: 'shared' });
      emit({ type: 'tool_execution_end', toolCallId: card + '-w', toolName: 'iris_workflow_apply', result: { content: [{ type: 'text', text }] }, isError: !result.ok });
    };
    const { runners } = harness({ A: writer('A', 'A 改的'), B: writer('B', 'B 改的') });
    runners.enqueue({ id: 'ra', cardNodeId: 'A', sessionId: 'sa', text: 'A' });
    runners.enqueue({ id: 'rb', cardNodeId: 'B', sessionId: 'sb', text: 'B' });
    await until(() => runners.get('A')?.phase === 'done' && runners.get('B')?.phase === 'done');
    expect(project.nodes.find(node => node.id === 'shared')?.title).toBe('A 改的');
    const traceA = reduceAgentSessionTrace(currentTurnMessages(runners.get('A')!.messages).after, { running: false, nodes: project.nodes });
    const traceB = reduceAgentSessionTrace(currentTurnMessages(runners.get('B')!.messages).after, { running: false, nodes: project.nodes });
    expect(traceA.conflicts).toBe(0);
    expect(traceB.conflicts).toBe(1);
    expect(traceB.steps[0]).toMatchObject({ status: 'error', conflict: true });
    expect(traceB.steps[0].error).toMatch(/^REVISION_CONFLICT/);
    expect(deriveAgentSessionStatus({ phase: 'done', conflicts: traceB.conflicts })).toBe('conflict');
  });
});
