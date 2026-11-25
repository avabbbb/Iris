import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import localforage from 'localforage';
import { createWorkflowNode } from '../components/workflow/constants';
import { flushWorkflowPersistence, useWorkflowStore } from '../components/workflow/store';
import { workflowStorage } from '../components/workflow/storage';
import { undoWorkflowDraftChangeSet } from '../components/workflow/draftAuthority';
import { createWorkflowNodePluginContext, getWorkflowNodePlugin } from '../components/workflow/nodePluginSdk';
import { ContextCardSurface } from '../components/workflow/ContextCardNode';
import {
  CONTEXT_CARD_TYPE,
  commitContextCard,
  contextCardNodeId,
  contextCardSourceStates,
  planContinueDiscussion,
  saveContextCardEdit,
} from '../components/workflow/contextCard';
import { useContextCardHighlightStore } from '../components/workflow/contextCardHighlight';
import { ContextCardReview } from '../components/agent/ContextCardReview';
import { dispatchWorkflowCommand } from '../services/workflowDispatcher';
import { BrowserAgentKernel } from '../services/browserAgentKernel';
import { BROWSER_DEFAULT_SYSTEM_PROMPT } from '../services/browserAgentKernel';
import type { WorkflowNode, WorkflowProject } from '../components/workflow/types';

const PROJECT = 'project-spatial-p1';
const route = { provider: 'openai_compatible', model: 'm', baseUrl: 'https://gw.example/v1', apiKey: 'k' };

function reply(text: string): Response {
  const body = [{ choices: [{ delta: { content: text } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]
    .map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function sourceNodes(): WorkflowNode[] {
  return [
    { ...createWorkflowNode('img-1', 'image', { x: 0, y: 0 }, { storageKey: 'media/img-1', prompt: '红色外套' }), title: '主角定妆' },
    { ...createWorkflowNode('vid-1', 'video', { x: 400, y: 0 }, { storageKey: 'media/vid-1' }), title: '开场镜头' },
    { ...createWorkflowNode('aud-1', 'audio', { x: 800, y: 0 }, { storageKey: 'media/aud-1' }), title: '配乐' },
  ];
}

function projectFixture(): WorkflowProject {
  return {
    id: PROJECT, title: 'Spatial', nodes: sourceNodes(), connections: [], selectedNodeIds: [], viewport: { x: 0, y: 0, k: 1 }, backgroundMode: 'dots',
    agentSessions: [], activeAgentSessionId: null, draftChangeSets: [], draftRedoStack: [], draftVersion: 1, workflowMutationReceipts: [],
    createdAt: '2026-11-24T00:00:00.000Z', updatedAt: '2026-11-24T00:00:00.000Z',
  };
}

const project = () => useWorkflowStore.getState().projects.find(item => item.id === PROJECT)!;
const message = { host: 'iris' as const, sessionId: 'session-a', messageId: 'entry-42' };
const sources = [
  { kind: 'node' as const, id: 'img-1', label: '主角定妆' },
  { kind: 'node' as const, id: 'vid-1', label: '开场镜头' },
  { kind: 'node' as const, id: 'aud-1', label: '配乐' },
];

function patchNode(id: string, update: (node: WorkflowNode) => WorkflowNode) {
  useWorkflowStore.getState().updateProject(PROJECT, { nodes: project().nodes.map(node => (node.id === id ? update(node) : node)) });
}

function renderCard(nodeId: string) {
  const node = project().nodes.find(item => item.id === nodeId)!;
  const context = createWorkflowNodePluginContext({ project: project(), node, pluginId: 'iris.context-card', applyOps: () => true });
  return render(<ContextCardSurface node={context.node} context={context} />);
}

describe('Spatial Context P1: Context Card', () => {
  beforeEach(async () => {
    await flushWorkflowPersistence();
    await workflowStorage.clear();
    useWorkflowStore.setState({ hydrated: true, projects: [projectFixture()], activeProjectId: PROJECT });
    useContextCardHighlightStore.setState({ byKey: {} });
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await flushWorkflowPersistence();
    await workflowStorage.clear();
  });

  it('acceptance 2: pin a reply, reload — the independent plugin:context-card node persists', async () => {
    const result = await commitContextCard({ projectId: PROJECT, title: '主角造型定稿', body: '红色外套 + 暖色调，开场用中景。', sourceMessage: message, sources, now: () => new Date('2026-11-24T02:00:00Z') });
    expect(result).toMatchObject({ ok: true, status: 'created', nodeId: contextCardNodeId(message), mutationId: 'context-card:iris:session-a:entry-42' });
    expect(getWorkflowNodePlugin(CONTEXT_CARD_TYPE)?.pluginId).toBe('iris.context-card');

    await flushWorkflowPersistence();
    useWorkflowStore.setState({ hydrated: false, projects: [], activeProjectId: null });
    await useWorkflowStore.persist.rehydrate();
    const card = project().nodes.find(node => node.id === contextCardNodeId(message))!;
    expect(card.type).toBe(CONTEXT_CARD_TYPE);
    expect(card.type).not.toBe('text');
    expect(card.title).toBe('主角造型定稿');
    expect(card.metadata.content).toBe('红色外套 + 暖色调，开场用中景。');
    expect(card.metadata.contextCard).toEqual({
      schemaVersion: 1,
      sourceMessage: message,
      sources: sources.map(source => ({ ...source, fingerprintAtCommit: expect.stringMatching(/^[0-9a-f]{16}$/) })),
      committedAt: '2026-11-24T02:00:00.000Z',
    });
    // 标题 / 正文只在节点的 title / content，不在 contextCard 里重复。
    expect(JSON.stringify(card.metadata.contextCard)).not.toContain('暖色调');
    // 没有默认的 Context 连线。
    expect(project().connections).toEqual([]);
    expect(project().workflowMutationReceipts?.map(receipt => receipt.mutationId)).toContain('context-card:iris:session-a:entry-42');

    // 撤销走同一 ChangeSet。
    const undone = undoWorkflowDraftChangeSet(project());
    expect(undone.ok).toBe(true);
    if (undone.ok) expect(undone.project.nodes.some(node => node.type === CONTEXT_CARD_TYPE)).toBe(false);
  });

  it('acceptance 3: changing a source content shows 来源已更新, moving it does not; hover highlights sources', async () => {
    await commitContextCard({ projectId: PROJECT, title: '结论', body: '正文', sourceMessage: message, sources });
    const cardId = contextCardNodeId(message);
    patchNode('img-1', node => ({ ...node, position: { x: 900, y: 900 }, width: 99, height: 99, title: '改名了' }));
    const first = renderCard(cardId);
    expect(screen.getByTestId('context-card-source-count')).toHaveTextContent('3 个来源');
    expect(screen.queryByText(/来源已更新/)).toBeNull();
    expect(contextCardSourceStates(project().nodes.find(node => node.id === cardId)!, project().nodes)).toMatchObject({ missing: 0, updated: 0 });
    fireEvent.pointerEnter(screen.getByTestId('context-card'));
    expect(Object.values(useContextCardHighlightStore.getState().byKey).flat().sort()).toEqual(['aud-1', 'img-1', 'vid-1']);
    fireEvent.pointerLeave(screen.getByTestId('context-card'));
    expect(useContextCardHighlightStore.getState().byKey).toEqual({});
    first.unmount();

    patchNode('img-1', node => ({ ...node, metadata: { ...node.metadata, prompt: '蓝色外套' } }));
    patchNode('aud-1', node => node);
    useWorkflowStore.getState().updateProject(PROJECT, { nodes: project().nodes.filter(node => node.id !== 'aud-1') });
    renderCard(cardId);
    expect(screen.getByText('1 个来源已更新')).toBeInTheDocument();
    expect(screen.getByText('1 个不可用')).toBeInTheDocument();
    expect(screen.getByTestId('context-card')).toHaveAttribute('data-source-state', 'missing');
  });

  it('acceptance 4 + 5: 继续讨论 opens the original session when it exists, otherwise seeds a new one; deleting the session leaves the card readable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply('建议：红色外套，暖色调。')));
    await localforage.removeItem(`iris.agent.sessions.${PROJECT}`);
    const kernel = new BrowserAgentKernel({ projectId: PROJECT, route, tools: [], confirm: async () => true, systemPrompt: 'SYS', getThinkingLevel: () => 'off', memory: null });
    try {
      await kernel.openSession();
      await kernel.send('看看主角造型');
      const snapshot = await kernel.snapshot();
      const assistant = snapshot.messages.find(item => item.role === 'assistant')!;
      const sourceMessage = { host: 'iris' as const, sessionId: snapshot.sessionId, messageId: assistant.id };
      const committed = await commitContextCard({ projectId: PROJECT, title: '造型', body: assistant.text, sourceMessage, sources });
      expect(committed.ok).toBe(true);
      const cardId = contextCardNodeId(sourceMessage);
      const card = () => project().nodes.find(node => node.id === cardId)!;
      const exists = async () => { const list = await kernel.listSessions(); return (id: string) => list.some(item => item.id === id); };

      expect(planContinueDiscussion(card(), { sessionExists: await exists(), nodes: project().nodes })).toEqual({ mode: 'open', sessionId: snapshot.sessionId, messageId: assistant.id });
      // 原会话可打开并定位到那条消息。
      await kernel.newSession();
      const reopened = await kernel.openSessionById(snapshot.sessionId) as { messages: Array<{ id: string }> };
      expect(reopened.messages.some(item => item.id === assistant.id)).toBe(true);

      // 删除会话：卡片仍在、可读；继续讨论改为新会话 + 卡片定稿 + 仍有效的来源。
      await kernel.deleteSession(snapshot.sessionId);
      useWorkflowStore.getState().updateProject(PROJECT, { nodes: project().nodes.filter(node => node.id !== 'vid-1') });
      expect(card().metadata.content).toBe('建议：红色外套，暖色调。');
      renderCard(cardId);
      expect(screen.getByText('建议：红色外套，暖色调。')).toBeInTheDocument();
      expect(screen.getByText('1 个不可用')).toBeInTheDocument();
      const plan = planContinueDiscussion(card(), { sessionExists: await exists(), nodes: project().nodes });
      expect(plan).toEqual({
        mode: 'new',
        title: '造型',
        body: '建议：红色外套，暖色调。',
        references: [{ kind: 'node', id: 'img-1', label: '主角定妆' }, { kind: 'node', id: 'aud-1', label: '配乐' }],
      });
      // 外部宿主的卡片从不假定 Session Fork。
      const external = { ...card(), metadata: { ...card().metadata, contextCard: { ...card().metadata.contextCard!, sourceMessage: { host: 'external' as const, sessionId: 'x', messageId: 'y' } } } };
      expect(planContinueDiscussion(external, { sessionExists: () => true, nodes: project().nodes }).mode).toBe('new');
    } finally {
      await kernel.close();
      await localforage.removeItem(`iris.agent.sessions.${PROJECT}`);
    }
  });

  it('acceptance 6: a repeated Commit focuses the existing card instead of duplicating it', async () => {
    const first = await commitContextCard({ projectId: PROJECT, title: '结论', body: '正文', sourceMessage: message, sources });
    const second = await commitContextCard({ projectId: PROJECT, title: '结论（再次）', body: '正文 2', sourceMessage: message, sources });
    expect(first).toMatchObject({ ok: true, status: 'created' });
    expect(second).toEqual({ ok: true, status: 'existing', nodeId: contextCardNodeId(message) });
    expect(project().nodes.filter(node => node.type === CONTEXT_CARD_TYPE)).toHaveLength(1);
    expect(project().nodes.find(node => node.type === CONTEXT_CARD_TYPE)!.title).toBe('结论');
    // 卡片被删除后再钉：重新创建，mutationId 加后缀，不撞幂等冲突。
    useWorkflowStore.getState().updateProject(PROJECT, { nodes: project().nodes.filter(node => node.type !== CONTEXT_CARD_TYPE) });
    const third = await commitContextCard({ projectId: PROJECT, title: '结论', body: '正文', sourceMessage: message, sources });
    expect(third).toMatchObject({ ok: true, status: 'created', mutationId: 'context-card:iris:session-a:entry-42:r1' });
    expect(project().nodes.filter(node => node.type === CONTEXT_CARD_TYPE)).toHaveLength(1);
  });

  it('explicit re-save keeps the previous version; Agent writes are read-only; system prompt stays static', async () => {
    await commitContextCard({ projectId: PROJECT, title: '结论', body: '正文 v1', sourceMessage: message, sources });
    const cardId = contextCardNodeId(message);
    const saved = await saveContextCardEdit({ projectId: PROJECT, nodeId: cardId, title: '结论 v2', body: '正文 v2' });
    expect(saved).toMatchObject({ ok: true, mutationId: `context-card-edit:${cardId}:v2` });
    const card = project().nodes.find(node => node.id === cardId)!;
    expect(card.title).toBe('结论 v2');
    expect(card.metadata.content).toBe('正文 v2');
    expect(card.metadata.contextCard?.history).toEqual([expect.objectContaining({ title: '结论', content: '正文 v1' })]);

    const denied = await dispatchWorkflowCommand({
      id: 'agent-rewrite', command: 'workflow.apply', source: 'agent', idempotencyKey: 'agent-rewrite',
      args: { projectId: PROJECT, expectedRevision: project().draftVersion || 1, mutationId: 'agent-rewrite', operations: [{ type: 'update_node', id: cardId, metadata: { content: '被改写' } }] },
    });
    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toBe('CONTEXT_CARD_READ_ONLY');
    const connect = await dispatchWorkflowCommand({
      id: 'agent-connect', command: 'workflow.apply', source: 'agent', idempotencyKey: 'agent-connect',
      args: { projectId: PROJECT, expectedRevision: project().draftVersion || 1, mutationId: 'agent-connect', operations: [{ type: 'connect_nodes', fromNodeId: cardId, toNodeId: 'img-1' }] },
    });
    expect(connect.error?.code).toBe('CONTEXT_CARD_READ_ONLY');
    const summary = await dispatchWorkflowCommand({ id: 'inspect', command: 'workflow.inspect', source: 'agent', args: { projectId: PROJECT, summary: true } });
    const nodes = (summary.result as { nodes: Array<{ id: string; contextCard?: unknown }> }).nodes;
    expect(nodes.find(node => node.id === cardId)?.contextCard).toEqual({ readOnly: true, sourceCount: 3 });
    expect(BROWSER_DEFAULT_SYSTEM_PROMPT).toContain('plugin:context-card');
  });

  it('review step: edit title / body, remove a source chip, explicit Commit', () => {
    const onCommit = vi.fn();
    render(<ContextCardReview
      draft={{ messageId: 'm1', title: '默认标题', body: '回复正文', sources: sources.map(source => ({ ...source })) }}
      nodes={sourceNodes()}
      onCommit={onCommit}
      onCancel={() => undefined}
    />);
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.change(screen.getByDisplayValue('默认标题'), { target: { value: '定稿标题' } });
    fireEvent.change(screen.getByDisplayValue('回复正文'), { target: { value: '定稿正文' } });
    fireEvent.click(screen.getByRole('button', { name: '移除引用 配乐' }));
    fireEvent.click(screen.getByRole('button', { name: '钉到画布' }));
    expect(onCommit).toHaveBeenCalledWith({ title: '定稿标题', body: '定稿正文', sources: sources.slice(0, 2) });
  });
});
