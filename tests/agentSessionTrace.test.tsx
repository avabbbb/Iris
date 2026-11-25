// P1b：画布会话卡的运行轨迹（思考 / 工具 / Skill / 记忆）、状态优先级、卡片审批、点击行定位 Drawer、已读。
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IrisAgentPanel } from '../components/agent/IrisAgentPanel';
import { createWorkflowNode } from '../components/workflow/constants';
import { flushWorkflowPersistence, useWorkflowStore } from '../components/workflow/store';
import { workflowStorage } from '../components/workflow/storage';
import { createWorkflowNodePluginContext } from '../components/workflow/nodePluginSdk';
import { AgentSessionCardSurface } from '../components/workflow/AgentSessionCardNode';
import { createAgentSessionCard } from '../components/workflow/agentSessionCard';
import {
  agentHarnessIdentity,
  deriveAgentSessionStatus,
  lastThinkingSentence,
  memoryTitles,
  reduceAgentSessionTrace,
  resolveCardApprovalDecision,
  traceSummaryLine,
  visibleTraceSteps,
  type AgentSessionCardStatus,
} from '../components/workflow/agentSessionTrace';
import { consumeWorkflowAgentDrawerRequest, consumeWorkflowAgentDrawerTarget } from '../components/workflow/agentDrawerRequest';
import { pushCanvasAgentSend, useCanvasAgentStore } from '../stores/useCanvasAgentStore';
import { getManagedAgentConnection } from '../services/managedAgentConnection';
import { readConfirmVerdict, type AgentConfirmVerdict } from '../services/runApproval';
import type { AgentConfirmRequest } from '../services/agentSpendMandate';
import type * as BrowserAgentKernelModule from '../services/browserAgentKernel';
import type { WorkflowAgentDisplayMessage } from '../components/workflow/WorkflowAgentMessages';
import type { WorkflowProject } from '../components/workflow/types';

const PROJECT = 'project-agent-trace';
const SESSION = 'session-trace-1';
const NOTE_REQUEST: AgentConfirmRequest = { kind: 'other', command: 'workflow.note.write', tool: 'iris_note_write', tier: 'write', grantable: true, args: { title: '开场镜头' } };

const kernel = vi.hoisted(() => ({
  verdicts: [] as unknown[],
  replied: false,
  listener: null as null | ((event: Record<string, unknown>) => void),
  confirm: null as null | ((summary: string, request?: unknown) => Promise<unknown>),
  request: null as unknown,
}));

vi.mock('../services/managedAgentConnection', () => ({ getManagedAgentConnection: vi.fn() }));

vi.mock('../services/browserAgentKernel', async importOriginal => {
  const actual = await importOriginal<typeof BrowserAgentKernelModule>();
  class StubKernel {
    constructor(options: { projectId: string; confirm: (summary: string, request?: unknown) => Promise<unknown> }) {
      kernel.confirm = options.confirm;
      const emit = (event: Record<string, unknown>) => kernel.listener?.(event);
      const base: Record<string, unknown> = {
        openSession: async () => undefined,
        snapshot: async () => ({
          sessionId: SESSION,
          projectId: options.projectId,
          running: false,
          messages: kernel.replied ? [
            { id: 'entry-u1', role: 'user', text: '开场用什么镜头？' },
            { id: 'entry-a0', role: 'assistant', text: '', thinking: '先读 Skill。再查记忆。' },
            { id: 'entry-t1', role: 'tool', text: '# vox-director', toolName: 'iris_skill_read', toolCallId: 'c-skill' },
            { id: 'entry-t2', role: 'tool', text: '- [aaaa1111] 暖色、低饱和\n- [bbbb2222] 6 秒内交代人物和地点', toolName: 'iris_memory', toolCallId: 'c-mem' },
            { id: 'entry-t3', role: 'tool', text: '色调备注不是图片或视频节点', toolName: 'iris_workflow_media_view', toolCallId: 'c-view', isError: true },
            { id: 'entry-t4', role: 'tool', text: '已写入备注', toolName: 'iris_note_write', toolCallId: 'c-note' },
            { id: 'entry-a1', role: 'assistant', text: '## 开场镜头\n缓慢推进的中景。' },
          ] : [],
        }),
        subscribe: (listener: (event: Record<string, unknown>) => void) => { kernel.listener = listener; return () => { kernel.listener = null; }; },
        close: async () => undefined,
        send: async () => {
          emit({ type: 'agent_start' });
          emit({ type: 'message_start' });
          emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: '先读 Skill。再查记忆。' } });
          emit({ type: 'tool_execution_start', toolCallId: 'c-skill', toolName: 'iris_skill_read', args: { id: 'vox-director' } });
          emit({ type: 'tool_execution_end', toolCallId: 'c-skill', toolName: 'iris_skill_read', result: { content: [{ type: 'text', text: '# vox-director' }], details: { id: 'vox-director', file: 'SKILL.md' } }, isError: false });
          emit({ type: 'tool_execution_start', toolCallId: 'c-mem', toolName: 'iris_memory', args: { action: 'search', query: '开场' } });
          emit({ type: 'tool_execution_end', toolCallId: 'c-mem', toolName: 'iris_memory', result: { content: [{ type: 'text', text: '- [aaaa1111] 暖色、低饱和\n- [bbbb2222] 6 秒内交代人物和地点' }], details: { action: 'search', count: 2, total: 5 } }, isError: false });
          emit({ type: 'tool_execution_start', toolCallId: 'c-view', toolName: 'iris_workflow_media_view', args: { nodeId: 'note-1' } });
          emit({ type: 'tool_execution_end', toolCallId: 'c-view', toolName: 'iris_workflow_media_view', result: { content: [{ type: 'text', text: '色调备注不是图片或视频节点' }] }, isError: true });
          emit({ type: 'tool_execution_start', toolCallId: 'c-note', toolName: 'iris_note_write', args: { title: '开场镜头' } });
          // 修改画布：走面板的 confirm（与 Drawer 确认卡同一个确认队列）。
          const verdict = await kernel.confirm!('写备注「开场镜头」', kernel.request ?? NOTE_REQUEST);
          kernel.verdicts.push(verdict);
          emit({ type: 'tool_execution_end', toolCallId: 'c-note', toolName: 'iris_note_write', result: { content: [{ type: 'text', text: readConfirmVerdict(verdict as AgentConfirmVerdict).approved ? '已写入备注' : '用户拒绝了该操作' }] }, isError: !readConfirmVerdict(verdict as AgentConfirmVerdict).approved });
          emit({ type: 'message_start' });
          emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '## 开场镜头\n缓慢推进的中景。' } });
          kernel.replied = true;
        },
        steer: () => true,
        cancel: () => undefined,
        listSessions: async () => (kernel.replied ? [{ id: SESSION, title: '开场', updatedAt: '2026-11-24T08:00:00.000Z' }] : []),
        openSessionById: async () => undefined,
        newSession: async () => undefined,
      };
      return new Proxy(base, { get: (target, prop) => (prop in target ? target[prop as string] : prop === 'then' ? undefined : async () => []) }) as unknown as StubKernel;
    }
  }
  return { ...actual, BrowserAgentKernel: StubKernel };
});

const key = {
  id: 'key-trace', provider: 'openai', key: 'sk-test', status: 'ok',
  models: [{ id: 'mock-chat', name: 'mock-chat' }],
  routeMappings: [{ routeId: 'mock-chat', order: 0, target: { kind: 'runtime-capability', capability: 'agent-text' } }],
  createdAt: 1, updatedAt: 1,
} as never;

function projectFixture(): WorkflowProject {
  return {
    id: PROJECT, title: 'Trace', nodes: [
      { ...createWorkflowNode('img-1', 'image', { x: 0, y: 0 }, { storageKey: 'media/img-1', prompt: '红色外套' }), title: '主角定妆', width: 260, height: 170 },
      { ...createWorkflowNode('note-1', 'text', { x: 0, y: 220 }, { content: '暖色、低饱和' }), title: '色调备注', width: 260, height: 120 },
    ], connections: [], selectedNodeIds: [], viewport: { x: 0, y: 0, k: 1 }, backgroundMode: 'dots',
    agentSessions: [], activeAgentSessionId: null, draftChangeSets: [], draftRedoStack: [], draftVersion: 1, workflowMutationReceipts: [],
    createdAt: '2026-11-24T08:00:00.000Z', updatedAt: '2026-11-24T08:00:00.000Z',
  };
}

const project = () => useWorkflowStore.getState().projects.find(item => item.id === PROJECT)!;

function renderCard(nodeId: string) {
  const node = project().nodes.find(item => item.id === nodeId)!;
  const context = createWorkflowNodePluginContext({ project: project(), node, pluginId: 'iris.agent-session', applyOps: () => true });
  return render(<AgentSessionCardSurface node={context.node} context={context} />);
}

function turnMessages(): WorkflowAgentDisplayMessage[] {
  return [
    { id: 'stream-1', role: 'assistant', text: '', thinking: '用户想定开场。先读 Skill。', thinkingStartedAt: 1_000, thinkingDone: true, thinkingMs: 4_000 },
    { id: 'tool-c1', role: 'tool', toolName: 'iris_skill_read', title: '读取技能', args: { id: 'vox-director' }, detail: { content: [{ type: 'text', text: '# vox' }], details: { id: 'vox-director' } }, status: 'success', text: '', startedAt: 5_000, endedAt: 5_400 },
    { id: 'tool-c2', role: 'tool', toolName: 'iris_memory', title: '项目记忆', args: { action: 'search', query: '开场' }, detail: { content: [{ type: 'text', text: '- [aaaa1111] 暖色、低饱和（色调）\n- [bbbb2222] 6 秒内交代人物和地点\n- [cccc3333] 主角穿红色外套' }], details: { action: 'search', count: 3 } }, status: 'success', text: '', startedAt: 6_000, endedAt: 6_100 },
    { id: 'tool-c3', role: 'tool', toolName: 'iris_workflow_media_view', title: '查看画面', args: { nodeId: 'note-1' }, detail: { content: [{ type: 'text', text: '不是图片或视频节点' }] }, status: 'error', text: '', startedAt: 7_000, endedAt: 7_300 },
    { id: 'tool-c4', role: 'tool', toolName: 'iris_workflow_apply', title: '修改画布', args: { operations: [{ type: 'update_node', id: 'img-1' }] }, detail: { content: [{ type: 'text', text: 'REVISION_CONFLICT: 节点已被修改' }] }, status: 'error', text: '', startedAt: 8_000, endedAt: 8_200 },
    { id: 'tool-c5', role: 'tool', toolName: 'iris_note_write', title: '写备注', args: { title: '开场镜头' }, detail: { title: '开场镜头' }, status: 'pending', text: '', startedAt: 9_000 },
    { id: 'stream-2', role: 'assistant', text: '', thinking: '色调备注没有画面。按记忆来，把结论写成备注', thinkingStartedAt: 9_500 },
  ];
}

describe('agent session trace (P1b)', () => {
  beforeEach(async () => {
    await flushWorkflowPersistence();
    await workflowStorage.clear();
    localStorage.setItem('iris.agent.approvalMode', 'always-ask');
    useWorkflowStore.setState({ hydrated: true, projects: [projectFixture()], activeProjectId: PROJECT });
    useCanvasAgentStore.setState({ requests: [], live: {}, focusCardId: null, seen: {}, drawerOpen: false, harness: null, approvalHandler: null });
    kernel.verdicts = [];
    kernel.replied = false;
    kernel.request = null;
    consumeWorkflowAgentDrawerRequest();
    consumeWorkflowAgentDrawerTarget();
  });
  afterEach(async () => {
    localStorage.removeItem('iris.agent.approvalMode');
    await flushWorkflowPersistence();
    await workflowStorage.clear();
  });

  it('status priority follows Huabu: approval > error > conflict > running > unread > seen', () => {
    const cases: Array<[Parameters<typeof deriveAgentSessionStatus>[0], AgentSessionCardStatus]> = [
      [{ phase: 'running', approvalPending: true, conflicts: 2 }, 'approval'],
      [{ phase: 'error', conflicts: 1 }, 'error'],
      [{ lastTurnStatus: 'error' }, 'error'],
      [{ phase: 'running', conflicts: 1 }, 'conflict'],
      [{ phase: 'done', conflicts: 1, completedKey: 'e1' }, 'conflict'],
      [{ phase: 'queued' }, 'running'],
      [{ phase: 'running' }, 'running'],
      [{ phase: 'done', completedKey: 'e1' }, 'unread'],
      [{ phase: 'done', completedKey: 'e1', seenKey: 'e0' }, 'unread'],
      [{ phase: 'done', completedKey: 'e1', seenKey: 'e1' }, 'seen'],
      // 刷新前就完成的旧一轮（没有本页的 completedKey）不算未读。
      [{ lastTurnStatus: 'done' }, 'seen'],
      [{}, 'idle'],
    ];
    for (const [input, expected] of cases) expect([input, deriveAgentSessionStatus(input)]).toEqual([input, expected]);
  });

  it('reduces the turn\'s display messages into thinking, tool timeline, skills, memory and conflicts', () => {
    const nodes = project().nodes;
    const running = reduceAgentSessionTrace(turnMessages(), { running: true, nodes, now: 12_000 });
    expect(running.thinking).toMatchObject({ present: true, active: true, startedAt: 9_500, ms: 4_000, summary: '按记忆来，把结论写成备注' });
    expect(running.steps.map(step => [step.kind, step.label, step.target, step.status])).toEqual([
      ['skill', '读取技能', 'vox-director', 'success'],
      ['memory', '项目记忆', '「开场」', 'success'],
      ['tool', '查看画面', '色调备注', 'error'],
      ['tool', '修改画布', '主角定妆', 'error'],
      ['tool', '写备注', '开场镜头', 'running'],
    ]);
    expect(running.steps[0]).toMatchObject({ toolCallId: 'c1', ms: 400 });
    expect(running.steps[2].error).toBe('不是图片或视频节点');
    expect(running.skills).toEqual([{ id: 'vox-director', label: 'vox-director', toolCallId: 'c1' }]);
    expect(running.memory).toEqual({ count: 3, titles: ['暖色、低饱和', '6 秒内交代人物和地点', '主角穿红色外套'], toolCallId: 'c2' });
    expect(running.conflicts).toBe(1);
    expect(visibleTraceSteps(running.steps)).toMatchObject({ hidden: 2, shown: [{ id: 'tool-c3' }, { id: 'tool-c4' }, { id: 'tool-c5' }] });

    // 回合结束：思考不再计时，pending 工具不算运行中；一行统计。
    const done = reduceAgentSessionTrace(turnMessages().map(item => (item.id === 'stream-2' ? { ...item, thinkingDone: true, thinkingMs: 8_000 } : item)), { running: false, nodes });
    expect(done.thinking).toMatchObject({ active: false, ms: 12_000 });
    expect(done.steps[4].status).toBe('waiting');
    expect(traceSummaryLine(done)).toBe('思考 12s · 5 次工具 · 2 次失败 · 1 个 Skill · 记忆 3 条');
    // 快照恢复的思考没有用时：不写假的 0s。
    expect(traceSummaryLine(reduceAgentSessionTrace([{ id: 'e', role: 'assistant', text: 'ok', thinking: '想一想。' }], { running: false }))).toBe('思考');
    expect(lastThinkingSentence('第一句。第二句很长很长')).toBe('第二句很长很长');
    expect(lastThinkingSentence('')).toBe('');
    expect(memoryTitles('没有找到与「x」相关的记忆。')).toEqual([]);
  });

  it('identity line names agent, model, thinking level and runtime with the full detail on hover', () => {
    const browser = agentHarnessIdentity({ runtime: 'browser', model: 'mock-chat', thinkingLabel: '高' });
    expect(browser).toMatchObject({ name: '内置 Agent', model: 'mock-chat', thinking: '高', env: '浏览器内核' });
    expect(browser.title).toContain('不碰本机文件和命令');
    const external = agentHarnessIdentity({ runtime: 'external', hostId: 'claude-code', scope: 'workspace-lease · 当前项目' });
    expect(external).toMatchObject({ name: 'Claude Code', env: '外部 harness', scope: 'workspace-lease · 当前项目' });
  });

  it('card approval resolves the pending confirmation through the panel\'s runApproval verdict, never past the budget gate', async () => {
    expect(resolveCardApprovalDecision({ pendingId: 'a', approvalId: 'b', approved: true })).toEqual({ kind: 'ignored', reason: 'stale' });
    expect(resolveCardApprovalDecision({ pendingId: 'a', approvalId: 'a', approved: true, blocked: true })).toEqual({ kind: 'ignored', reason: 'blocked' });
    expect(resolveCardApprovalDecision({ pendingId: 'a', approvalId: 'a', approved: false, blocked: true })).toEqual({ kind: 'confirm', approved: false, scope: 'once' });
    expect(resolveCardApprovalDecision({ pendingId: 'a', approvalId: 'a', approved: true, plan: true })).toEqual({ kind: 'plan', decision: 'auto' });

    vi.mocked(getManagedAgentConnection).mockResolvedValue(null as never);
    const created = await createAgentSessionCard({ projectId: PROJECT, requestId: 'approve-1', origin: 'ask', anchor: { x: 900, y: 600, width: 0, height: 0 } });
    if (created.ok === false) throw new Error(created.error);
    render(<IrisAgentPanel project={project()} onActivityChange={vi.fn()} onOpenSettings={vi.fn()} userApiKeys={[key]} onFocusNode={vi.fn()} />);
    act(() => { pushCanvasAgentSend({ projectId: PROJECT, cardNodeId: created.nodeId, text: '开场用什么镜头？', references: [] }); });
    await waitFor(() => expect(useCanvasAgentStore.getState().live[created.nodeId]?.approval).toBeTruthy());
    const live = useCanvasAgentStore.getState().live[created.nodeId]!;
    expect(live.approval).toMatchObject({ title: '写备注 · 开场镜头', reason: '修改画布' });
    expect(live.trace?.steps.map(step => step.status)).toEqual(['success', 'success', 'error', 'running']);
    expect(live.trace?.skills.map(skill => skill.id)).toEqual(['vox-director']);
    expect(live.trace?.memory.count).toBe(2);
    expect(useCanvasAgentStore.getState().harness).toMatchObject({ name: '内置 Agent', model: 'mock-chat', env: '浏览器内核' });

    const card = renderCard(created.nodeId);
    const row = within(card.container).getByTestId('agent-session-card-approval');
    expect(within(card.container).getByTestId('agent-session-card-status').textContent).toBe('等待授权');
    expect(within(card.container).getByTestId('agent-session-card-orb').getAttribute('data-status')).toBe('approval');
    // 过期的确认 id 不起作用。
    expect(useCanvasAgentStore.getState().approvalHandler!({ cardNodeId: created.nodeId, approvalId: 'stale', approved: true })).toBe(false);
    fireEvent.click(within(row).getByTestId('agent-session-card-approve'));
    await waitFor(() => expect(kernel.verdicts).toHaveLength(1));
    expect(readConfirmVerdict(kernel.verdicts[0] as AgentConfirmVerdict)).toMatchObject({ approved: true });
    await waitFor(() => expect(useCanvasAgentStore.getState().live[created.nodeId]?.phase).toBe('done'));
    expect(useCanvasAgentStore.getState().live[created.nodeId]?.approval).toBeUndefined();
  });

  it('a blocked batch cannot be approved from the card; deny still goes through the same queue', async () => {
    kernel.request = { kind: 'generation', command: 'workflow.node.run', args: { nodeIds: ['img-1'] }, gates: [{ nodeId: 'img-1', taskCount: 1, blockers: ['没有可用的图片模型'] }] } as unknown as AgentConfirmRequest;
    vi.mocked(getManagedAgentConnection).mockResolvedValue(null as never);
    const created = await createAgentSessionCard({ projectId: PROJECT, requestId: 'blocked-1', origin: 'ask', anchor: { x: 900, y: 600, width: 0, height: 0 } });
    if (created.ok === false) throw new Error(created.error);
    render(<IrisAgentPanel project={project()} onActivityChange={vi.fn()} onOpenSettings={vi.fn()} userApiKeys={[key]} onFocusNode={vi.fn()} />);
    act(() => { pushCanvasAgentSend({ projectId: PROJECT, cardNodeId: created.nodeId, text: '开场用什么镜头？', references: [] }); });
    await waitFor(() => expect(useCanvasAgentStore.getState().live[created.nodeId]?.approval?.blocked).toBe(true));
    const approval = useCanvasAgentStore.getState().live[created.nodeId]!.approval!;
    expect(useCanvasAgentStore.getState().approvalHandler!({ cardNodeId: created.nodeId, approvalId: approval.id, approved: true })).toBe(false);
    const card = renderCard(created.nodeId);
    expect(within(card.container).queryByTestId('agent-session-card-approve')).toBeNull();
    fireEvent.click(within(card.container).getByTestId('agent-session-card-deny'));
    await waitFor(() => expect(kernel.verdicts).toHaveLength(1));
    expect(readConfirmVerdict(kernel.verdicts[0] as AgentConfirmVerdict).approved).toBe(false);
  });

  it('clicking a trace row opens the drawer with the toolCallId; the done card collapses into one stats line', async () => {
    const created = await createAgentSessionCard({ projectId: PROJECT, requestId: 'rows-1', origin: 'ask', anchor: { x: 900, y: 600, width: 0, height: 0 } });
    if (created.ok === false) throw new Error(created.error);
    const trace = reduceAgentSessionTrace(turnMessages(), { running: true, nodes: project().nodes, now: 12_000 });
    act(() => { useCanvasAgentStore.getState().setLive(created.nodeId, { phase: 'running', preview: '', prompt: '开场用什么镜头？', trace }); });
    const card = renderCard(created.nodeId);
    expect(within(card.container).getByTestId('agent-session-card-thinking').textContent).toContain('按记忆来，把结论写成备注');
    const rows = within(card.container).getAllByTestId('agent-session-card-step');
    expect(rows).toHaveLength(3);
    expect(within(card.container).getByText('+2')).toBeTruthy();
    expect(within(card.container).getByTestId('agent-session-card-skill').textContent).toBe('Skill: vox-director');
    expect(within(card.container).getByTestId('agent-session-card-memory').getAttribute('title')).toContain('暖色、低饱和');
    fireEvent.click(rows[0]);
    expect(consumeWorkflowAgentDrawerRequest()).toBe(true);
    expect(consumeWorkflowAgentDrawerTarget()).toEqual({ toolCallId: 'c3' });
    expect(useCanvasAgentStore.getState().requests.some(item => item.kind === 'open' && item.cardNodeId === created.nodeId)).toBe(true);

    const done = reduceAgentSessionTrace(turnMessages().filter(item => item.id !== 'tool-c4'), { running: false, nodes: project().nodes });
    act(() => { useCanvasAgentStore.getState().setLive(created.nodeId, { phase: 'done', preview: '缓慢推进的中景。', prompt: '开场用什么镜头？', trace: done, completedKey: 'entry-a1' }); });
    const summary = within(card.container).getByTestId('agent-session-card-summary');
    expect(summary.textContent).toBe('思考 4s · 4 次工具 · 1 次失败 · 1 个 Skill · 记忆 3 条');
    expect(within(card.container).getByTestId('agent-session-card-status').textContent).toBe('未读');
    fireEvent.pointerEnter(summary.parentElement!);
    expect(within(card.container).getByTestId('agent-session-card').hasAttribute('data-trace-open')).toBe(true);
    const expanded = within(within(card.container).getByTestId('agent-session-card-trace')).getAllByTestId('agent-session-card-step');
    expect(expanded).toHaveLength(4);
    fireEvent.click(expanded[1]);
    expect(consumeWorkflowAgentDrawerTarget()).toEqual({ toolCallId: 'c2' });
  });

  it('read state: a turn finished while the drawer shows it is already read; otherwise unread until opened', async () => {
    vi.mocked(getManagedAgentConnection).mockResolvedValue(null as never);
    localStorage.setItem('iris.agent.approvalMode', 'write');
    const created = await createAgentSessionCard({ projectId: PROJECT, requestId: 'read-1', origin: 'ask', anchor: { x: 900, y: 600, width: 0, height: 0 } });
    if (created.ok === false) throw new Error(created.error);
    const view = render(<IrisAgentPanel project={project()} onActivityChange={vi.fn()} onOpenSettings={vi.fn()} userApiKeys={[key]} onFocusNode={vi.fn()} />);
    act(() => { pushCanvasAgentSend({ projectId: PROJECT, cardNodeId: created.nodeId, text: '开场用什么镜头？', references: [] }); });
    // write 模式下写备注不需要确认，但 stub 仍然走 confirm：在这里直接批准（Drawer 确认卡）。
    await waitFor(() => expect(useCanvasAgentStore.getState().live[created.nodeId]?.approval).toBeTruthy());
    act(() => { useCanvasAgentStore.getState().approvalHandler!({ cardNodeId: created.nodeId, approvalId: useCanvasAgentStore.getState().live[created.nodeId]!.approval!.id, approved: true }); });
    await waitFor(() => expect(useCanvasAgentStore.getState().live[created.nodeId]?.phase).toBe('done'));
    const live = () => useCanvasAgentStore.getState().live[created.nodeId]!;
    expect(live().completedKey).toBeTruthy();
    const status = () => deriveAgentSessionStatus({ phase: live().phase, completedKey: live().completedKey, seenKey: useCanvasAgentStore.getState().seen[created.nodeId] });
    expect(status()).toBe('unread');
    // 在 Drawer 里打开这个会话（对话页可见）= 已读。
    act(() => { useCanvasAgentStore.getState().setDrawerOpen(true); });
    await waitFor(() => expect(status()).toBe('seen'));
    view.unmount();
  });
});
