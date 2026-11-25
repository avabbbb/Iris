import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IrisAgentPanel } from '../components/agent/IrisAgentPanel';
import { createWorkflowNode } from '../components/workflow/constants';
import { flushWorkflowPersistence, useWorkflowStore } from '../components/workflow/store';
import { workflowStorage } from '../components/workflow/storage';
import { createWorkflowNodePluginContext } from '../components/workflow/nodePluginSdk';
import { AgentSessionCardSurface } from '../components/workflow/AgentSessionCardNode';
import { WorkflowCreateMenu } from '../components/workflow/WorkflowCreateMenu';
import {
  AGENT_SESSION_CARD_SIZE,
  AGENT_SESSION_TYPE,
  agentSessionExcerpt,
  agentSessionReferencesFromNodes,
  agentSessionTurnReferences,
  bindAgentSessionCard,
  createAgentSessionCard,
  findFreeSpot,
  rectsOverlap,
  selectionBounds,
} from '../components/workflow/agentSessionCard';
import { consumeWorkflowAgentDrawerRequest } from '../components/workflow/agentDrawerRequest';
import { pushCanvasAgentSend, useCanvasAgentStore } from '../stores/useCanvasAgentStore';
import { buildTurnContextDraft } from '../services/turnContext';
import { dispatchWorkflowCommand } from '../services/workflowDispatcher';
import { getManagedAgentConnection } from '../services/managedAgentConnection';
import type * as BrowserAgentKernelModule from '../services/browserAgentKernel';
import type { WorkflowNode, WorkflowProject } from '../components/workflow/types';

const PROJECT = 'project-agent-canvas';
const SESSION = 'session-canvas-1';

const kernel = vi.hoisted(() => ({
  sent: [] as Array<{ text: string; turnContext?: unknown }>,
  replied: false,
  newSession: vi.fn(async () => undefined as unknown),
  openSessionById: vi.fn(async (_id: string) => undefined as unknown),
}));

vi.mock('../services/managedAgentConnection', () => ({ getManagedAgentConnection: vi.fn() }));

vi.mock('../services/browserAgentKernel', async importOriginal => {
  const actual = await importOriginal<typeof BrowserAgentKernelModule>();
  class StubKernel {
    constructor(options: { projectId: string }) {
      const base: Record<string, unknown> = {
        openSession: async () => undefined,
        snapshot: async () => ({
          sessionId: SESSION,
          projectId: options.projectId,
          running: false,
          messages: kernel.replied ? [
            { id: 'entry-u1', role: 'user', text: kernel.sent[0]?.text || '' },
            { id: 'entry-a1', role: 'assistant', text: '## 方向\n主角保留**红色外套**，开场用中景。\n第二行\n第三行\n第四行' },
          ] : [],
        }),
        subscribe: () => () => undefined,
        close: async () => undefined,
        send: async (text: string, _images: unknown, _skill: unknown, turnContext?: unknown) => {
          kernel.sent.push({ text, turnContext });
          kernel.replied = true;
        },
        steer: () => true,
        cancel: () => undefined,
        listSessions: async () => (kernel.replied ? [{ id: SESSION, title: '方向', updatedAt: 'Tue 2026-11-24 8:00 AM HKT (UTC+08:00)' }] : []),
        openSessionById: kernel.openSessionById,
        newSession: kernel.newSession,
      };
      return new Proxy(base, { get: (target, prop) => (prop in target ? target[prop as string] : prop === 'then' ? undefined : async () => []) }) as unknown as StubKernel;
    }
  }
  return { ...actual, BrowserAgentKernel: StubKernel };
});

const key = {
  id: 'key-canvas', provider: 'openai', key: 'sk-test', status: 'ok',
  routeMappings: [{ routeId: 'hark', order: 0, target: { kind: 'runtime-capability', capability: 'agent-text' } }],
  createdAt: 1, updatedAt: 1,
} as never;

function sourceNodes(): WorkflowNode[] {
  return [
    { ...createWorkflowNode('img-1', 'image', { x: 0, y: 0 }, { storageKey: 'media/img-1', prompt: '红色外套' }), title: '主角定妆', width: 260, height: 170 },
    { ...createWorkflowNode('img-2', 'image', { x: 0, y: 220 }, { storageKey: 'media/img-2', prompt: '街景' }), title: '街景', width: 260, height: 170 },
    { ...createWorkflowNode('note-1', 'text', { x: 340, y: 0 }, { content: '暖色、低饱和' }), title: '色调备注', width: 260, height: 120 },
  ];
}

function projectFixture(nodes = sourceNodes()): WorkflowProject {
  return {
    id: PROJECT, title: 'Canvas Agent', nodes, connections: [], selectedNodeIds: [], viewport: { x: 0, y: 0, k: 1 }, backgroundMode: 'dots',
    agentSessions: [], activeAgentSessionId: null, draftChangeSets: [], draftRedoStack: [], draftVersion: 1, workflowMutationReceipts: [],
    createdAt: 'Tue 2026-11-24 8:00 AM HKT (UTC+08:00)', updatedAt: 'Tue 2026-11-24 8:00 AM HKT (UTC+08:00)',
  };
}

const project = () => useWorkflowStore.getState().projects.find(item => item.id === PROJECT)!;
const cards = () => project().nodes.filter(node => node.type === AGENT_SESSION_TYPE);
const point = (x: number, y: number) => ({ x, y, width: 0, height: 0 });
const positions = (nodes: readonly WorkflowNode[]) => Object.fromEntries(nodes.map(node => [node.id, { ...node.position }]));
const rectOf = (node: WorkflowNode) => ({ x: node.position.x, y: node.position.y, width: node.width, height: node.height });

function renderCard(nodeId: string) {
  const node = project().nodes.find(item => item.id === nodeId)!;
  const context = createWorkflowNodePluginContext({ project: project(), node, pluginId: 'iris.agent-session', applyOps: () => true });
  return render(<AgentSessionCardSurface node={context.node} context={context} />);
}

describe('Agent embedded in the canvas: plugin:agent-session', () => {
  beforeEach(async () => {
    await flushWorkflowPersistence();
    await workflowStorage.clear();
    useWorkflowStore.setState({ hydrated: true, projects: [projectFixture()], activeProjectId: PROJECT });
    useCanvasAgentStore.setState({ requests: [], live: {}, focusCardId: null });
    kernel.sent = [];
    kernel.replied = false;
    kernel.newSession.mockClear();
    kernel.openSessionById.mockClear();
    consumeWorkflowAgentDrawerRequest();
  });
  afterEach(async () => {
    await flushWorkflowPersistence();
    await workflowStorage.clear();
  });

  it('ask: the card lands at the double-click point and binding writes only the sessionId', async () => {
    const result = await createAgentSessionCard({ projectId: PROJECT, requestId: 'ask-1', origin: 'ask', anchor: point(900, 600), prompt: '给开场定个造型方向' });
    expect(result).toMatchObject({ ok: true, status: 'created' });
    const card = cards()[0];
    expect(card.position).toEqual({ x: 900, y: 600 });
    expect(card.title).toBe('给开场定个造型方向');
    expect(card.metadata.agentSession).toMatchObject({ schemaVersion: 1, host: 'iris', origin: 'ask', references: [] });
    expect(card.metadata.agentSession?.sessionId).toBeUndefined();

    await bindAgentSessionCard({ projectId: PROJECT, nodeId: card.id, sessionId: SESSION, prompt: '给开场定个造型方向' });
    const bound = cards()[0];
    expect(bound.metadata.agentSession?.sessionId).toBe(SESSION);
    // 卡片是投影：不存回复正文 / 消息列表，只有 sessionId、绑定素材和（之后的）摘录。
    expect(bound.metadata.content).toBeUndefined();
    expect(Object.keys(bound.metadata.agentSession || {}).sort()).toEqual(['createdAt', 'host', 'origin', 'references', 'schemaVersion', 'sessionId']);
  });

  it('double-click menu: 问 Agent is the first item, focused on open, Enter sends the text', () => {
    const onAskAgent = vi.fn();
    const onCreate = vi.fn();
    render(<WorkflowCreateMenu state={{ world: { x: 900, y: 600 }, anchor: { x: 10, y: 10 } }} onCreate={onCreate} onClose={vi.fn()} onAskAgent={onAskAgent} />);
    const input = screen.getByRole('textbox', { name: '问 Agent' });
    expect(document.activeElement).toBe(input);
    const menu = screen.getByRole('menu');
    expect(menu.firstElementChild?.querySelector('textarea')).toBe(input);
    // 打字不触发菜单的首字母跳转 / 创建节点。
    fireEvent.change(input, { target: { value: '开场用什么镜头？' } });
    fireEvent.keyDown(input, { key: 'v' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onAskAgent).toHaveBeenCalledWith('开场用什么镜头？');
    expect(onCreate).not.toHaveBeenCalled();
    // Shift+Enter 换行，不发送。
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(onAskAgent).toHaveBeenCalledTimes(1);
  });

  it('near placement: never overlaps and never moves an existing node; falls back to the right when the area is full', async () => {
    const before = positions(project().nodes);
    // 双击点正好落在已有节点上：就近换到空位。
    const onTop = await createAgentSessionCard({ projectId: PROJECT, requestId: 'ask-on-top', origin: 'ask', anchor: point(10, 10) });
    expect(onTop.ok).toBe(true);
    // 选区旁：放在选区右侧空位，也不压住选区。
    const selection = project().nodes.filter(node => node.id === 'img-1' || node.id === 'img-2');
    const discuss = await createAgentSessionCard({ projectId: PROJECT, requestId: 'discuss-1', origin: 'discuss', anchor: selectionBounds(selection)!, references: agentSessionReferencesFromNodes(selection) });
    expect(discuss.ok).toBe(true);
    const all = project().nodes;
    expect(positions(all.filter(node => before[node.id]))).toEqual(before);
    for (const card of cards()) {
      for (const other of all.filter(node => node.id !== card.id)) expect(rectsOverlap(rectOf(card), rectOf(other))).toBe(false);
    }
    const discussCard = all.find(node => discuss.ok && node.id === discuss.nodeId)!;
    // 就近：卡片不在选区左侧 / 上方，且离选区外接矩形不超过一张卡片的距离。
    const bounds = selectionBounds(selection)!;
    expect(discussCard.position.x).toBeGreaterThanOrEqual(bounds.x);
    expect(discussCard.position.y).toBeGreaterThanOrEqual(bounds.y);
    const gapX = Math.max(0, discussCard.position.x - (bounds.x + bounds.width));
    const gapY = Math.max(0, discussCard.position.y - (bounds.y + bounds.height));
    // P1b 卡片变高（284）：「就近」放宽到 1.5 张卡的长边。
    expect(Math.hypot(gapX, gapY)).toBeLessThanOrEqual(Math.max(AGENT_SESSION_CARD_SIZE.width, AGENT_SESSION_CARD_SIZE.height) * 1.5);

    // 搜索范围内全被占满：退到所有内容右侧，仍不重叠。
    const wall: WorkflowNode[] = [];
    for (let column = 0; column < 6; column += 1) for (let row = 0; row < 6; row += 1) wall.push({ ...createWorkflowNode(`w-${column}-${row}`, 'image', { x: column * 300, y: row * 220 }), width: 300, height: 220 });
    const spot = findFreeSpot(wall, point(600, 400), AGENT_SESSION_CARD_SIZE, { radius: 200 });
    expect(spot.fallback).toBe(true);
    expect(wall.some(node => rectsOverlap({ ...spot, ...AGENT_SESSION_CARD_SIZE }, rectOf(node)))).toBe(false);
  });

  it('repeat clicks do not create duplicate cards', async () => {
    const selection = project().nodes.filter(node => node.id !== 'note-1');
    const references = agentSessionReferencesFromNodes(selection);
    const anchor = selectionBounds(selection)!;
    const [a, b] = await Promise.all([
      createAgentSessionCard({ projectId: PROJECT, requestId: 'click-a', origin: 'discuss', anchor, references }),
      createAgentSessionCard({ projectId: PROJECT, requestId: 'click-b', origin: 'discuss', anchor, references }),
    ]);
    const third = await createAgentSessionCard({ projectId: PROJECT, requestId: 'click-c', origin: 'discuss', anchor, references: [...references].reverse() });
    expect(cards()).toHaveLength(1);
    expect(a.ok && b.ok && third.ok && a.nodeId === b.nodeId && b.nodeId === third.nodeId).toBe(true);
    expect(third).toMatchObject({ status: 'existing' });
    // 同一个手势 id（双击回车按住）只建一张。
    await Promise.all([
      createAgentSessionCard({ projectId: PROJECT, requestId: 'ask-same', origin: 'ask', anchor: point(1200, 900) }),
      createAgentSessionCard({ projectId: PROJECT, requestId: 'ask-same', origin: 'ask', anchor: point(1200, 900) }),
    ]);
    expect(cards()).toHaveLength(2);
    // 连点发送：同一张卡片只排一个请求。
    const cardId = a.ok ? a.nodeId : '';
    expect(pushCanvasAgentSend({ projectId: PROJECT, cardNodeId: cardId, text: '比较一下', references })).toBe(true);
    expect(pushCanvasAgentSend({ projectId: PROJECT, cardNodeId: cardId, text: '比较一下', references })).toBe(false);
    expect(useCanvasAgentStore.getState().requests).toHaveLength(1);
    // 已经发出过的讨论卡不再复用：同一选区再讨论会开新卡。
    await bindAgentSessionCard({ projectId: PROJECT, nodeId: cardId, sessionId: 'session-x' });
    await createAgentSessionCard({ projectId: PROJECT, requestId: 'click-d', origin: 'discuss', anchor, references });
    expect(cards()).toHaveLength(3);
  });

  it('discuss: selected materials become chips and this turn\'s structured references', async () => {
    const selection = project().nodes.filter(node => node.id === 'img-1' || node.id === 'note-1');
    const result = await createAgentSessionCard({ projectId: PROJECT, requestId: 'discuss-chips', origin: 'discuss', anchor: selectionBounds(selection)!, references: agentSessionReferencesFromNodes(selection) });
    if (result.ok === false) throw new Error(result.error);
    const card = project().nodes.find(node => node.id === result.nodeId)!;
    expect(card.title).toBe('讨论 2 个素材');
    renderCard(card.id);
    const chips = screen.getByTestId('agent-session-card-chips');
    expect(chips).toHaveTextContent('主角定妆');
    expect(chips).toHaveTextContent('色调备注');
    const refs = agentSessionTurnReferences(card.metadata.agentSession!, project().nodes);
    expect(refs).toEqual([
      { id: 'img-1', type: 'node', label: '主角定妆', mediaType: 'image' },
      { id: 'note-1', type: 'node', label: '色调备注', mediaType: 'text' },
    ]);
    const draft = buildTurnContextDraft({ projectId: PROJECT, projectRevision: 1, references: refs, nodes: project().nodes });
    expect(draft?.sources.map(source => [source.kind, source.id])).toEqual([['node', 'img-1'], ['node', 'note-1']]);

    // 卡片里的发送：排队请求带着同一组引用；流式时只显示进度点和前三行。
    fireEvent.change(screen.getByTestId('agent-session-card-input'), { target: { value: '这两份能放一起吗' } });
    fireEvent.keyDown(screen.getByTestId('agent-session-card-input'), { key: 'Enter' });
    const request = useCanvasAgentStore.getState().requests[0];
    expect(request).toMatchObject({ kind: 'send', cardNodeId: card.id, text: '这两份能放一起吗', references: card.metadata.agentSession!.references });
    act(() => useCanvasAgentStore.getState().setLive(card.id, { phase: 'running', preview: '第一行\n第二行\n第三行\n第四行不显示', prompt: '这两份能放一起吗' }));
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByTestId('agent-session-card-turn')).toHaveTextContent('第三行');
    expect(screen.getByTestId('agent-session-card-turn')).not.toHaveTextContent('第四行不显示');

    // 点卡片头部：请求 Drawer + 切到这个会话。
    fireEvent.click(screen.getByTestId('agent-session-card-title'));
    expect(consumeWorkflowAgentDrawerRequest()).toBe(true);
    expect(useCanvasAgentStore.getState().requests.some(item => item.kind === 'open' && item.cardNodeId === card.id)).toBe(true);
  });

  it('the drawer runs a canvas send in the same runtime: binds the session, records turn_context sources and an excerpt', async () => {
    vi.mocked(getManagedAgentConnection).mockResolvedValue(null as never);
    const selection = project().nodes.filter(node => node.id === 'img-1' || node.id === 'img-2');
    const created = await createAgentSessionCard({ projectId: PROJECT, requestId: 'panel-1', origin: 'discuss', anchor: selectionBounds(selection)!, references: agentSessionReferencesFromNodes(selection) });
    if (created.ok === false) throw new Error(created.error);
    render(<IrisAgentPanel project={project()} onActivityChange={vi.fn()} onOpenSettings={vi.fn()} userApiKeys={[key]} onFocusNode={vi.fn()} />);
    act(() => { pushCanvasAgentSend({ projectId: PROJECT, cardNodeId: created.nodeId, text: '比较这两张，给开场定方向', references: project().nodes.find(node => node.id === created.nodeId)!.metadata.agentSession!.references }); });
    await waitFor(() => expect(kernel.sent).toHaveLength(1));
    expect(kernel.newSession).toHaveBeenCalledTimes(1);
    const turnContext = kernel.sent[0].turnContext as { sources: Array<{ id: string; kind: string }> };
    expect(turnContext.sources.map(source => source.id)).toEqual(['img-1', 'img-2']);
    expect(kernel.sent[0].text).toContain('比较这两张，给开场定方向');
    // 默认不把整张画布交给模型：没有绑定的节点不出现在这一轮里。
    expect(kernel.sent[0].text).not.toContain('note-1');
    await waitFor(() => expect(project().nodes.find(node => node.id === created.nodeId)!.metadata.agentSession?.lastTurn?.entryId).toBe('entry-a1'));
    const meta = project().nodes.find(node => node.id === created.nodeId)!.metadata.agentSession!;
    expect(meta.sessionId).toBe(SESSION);
    expect(meta.lastTurn).toMatchObject({ status: 'done', excerpt: agentSessionExcerpt('## 方向\n主角保留**红色外套**，开场用中景。\n第二行\n第三行\n第四行') });
    expect(meta.lastTurn?.excerpt.startsWith('方向\n主角保留红色外套')).toBe(true);
    expect(useCanvasAgentStore.getState().live[created.nodeId]?.phase).toBe('done');
    expect(project().nodes.find(node => node.id === created.nodeId)!.title).toBe('比较这两张，给开场定方向');
  });

  it('without a text model the card says so instead of spinning', async () => {
    vi.mocked(getManagedAgentConnection).mockResolvedValue(null as never);
    const created = await createAgentSessionCard({ projectId: PROJECT, requestId: 'nomodel', origin: 'ask', anchor: point(900, 900) });
    if (created.ok === false) throw new Error(created.error);
    render(<IrisAgentPanel project={project()} onActivityChange={vi.fn()} onOpenSettings={vi.fn()} userApiKeys={[]} onFocusNode={vi.fn()} />);
    act(() => { pushCanvasAgentSend({ projectId: PROJECT, cardNodeId: created.nodeId, text: '在吗', references: [] }); });
    await waitFor(() => expect(useCanvasAgentStore.getState().live[created.nodeId]).toMatchObject({ phase: 'error', errorKind: 'no-model' }));
    expect(kernel.sent).toHaveLength(0);
    expect(cards()).toHaveLength(1);
  });

  it('agents and CLIs cannot rewrite, connect or delete a session card', async () => {
    const created = await createAgentSessionCard({ projectId: PROJECT, requestId: 'ro', origin: 'ask', anchor: point(900, 900) });
    if (created.ok === false) throw new Error(created.error);
    const denied = await dispatchWorkflowCommand({
      id: 'agent-rewrite', command: 'workflow.apply', source: 'agent', idempotencyKey: 'agent-rewrite',
      args: { projectId: PROJECT, expectedRevision: project().draftVersion || 1, mutationId: 'agent-rewrite', operations: [{ type: 'update_node', id: created.nodeId, patch: { title: '被改写' } }] },
    });
    expect(denied.error?.code).toBe('AGENT_SESSION_READ_ONLY');
    const connect = await dispatchWorkflowCommand({
      id: 'agent-connect', command: 'workflow.apply', source: 'agent', idempotencyKey: 'agent-connect',
      args: { projectId: PROJECT, expectedRevision: project().draftVersion || 1, mutationId: 'agent-connect', operations: [{ type: 'connect_nodes', fromNodeId: created.nodeId, toNodeId: 'img-1' }] },
    });
    expect(connect.error?.code).toBe('AGENT_SESSION_READ_ONLY');
    const remove = await dispatchWorkflowCommand({
      id: 'agent-delete', command: 'workflow.apply', source: 'agent', idempotencyKey: 'agent-delete',
      args: { projectId: PROJECT, expectedRevision: project().draftVersion || 1, mutationId: 'agent-delete', operations: [{ type: 'delete_nodes', ids: [created.nodeId] }] },
    });
    // 外部 Agent 的删除先走确认（requiresWorkflowConfirmation）；无论确认结果如何，会话卡都不会被 Agent 删掉。
    expect(remove.ok === false || (remove.result as { status?: string } | undefined)?.status !== 'applied').toBe(true);
    expect(cards()).toHaveLength(1);
    expect(cards()[0].title).toBe('问 Agent');
  });
});
