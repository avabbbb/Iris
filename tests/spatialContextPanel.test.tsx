import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { IrisAgentPanel } from '../components/agent/IrisAgentPanel';
import { createWorkflowNode } from '../components/workflow/constants';
import { useWorkflowStore } from '../components/workflow/store';
import { CONTEXT_CARD_TYPE, contextCardNodeId } from '../components/workflow/contextCard';
import { pushAgentDiscussion } from '../stores/useAgentGroupInboxStore';
import { nodeContentFingerprint } from '../services/turnContext';
import { getManagedAgentConnection } from '../services/managedAgentConnection';
import type * as BrowserAgentKernelModule from '../services/browserAgentKernel';
import type { WorkflowNode, WorkflowProject } from '../components/workflow/types';

const PROJECT = 'project-spatial-panel';
const SESSION = 'session-ctx';

const nodes: WorkflowNode[] = [
  { ...createWorkflowNode('img-1', 'image', { x: 0, y: 0 }, { storageKey: 'media/img-1', prompt: '红色外套' }), title: '主角定妆' },
  { ...createWorkflowNode('vid-1', 'video', { x: 400, y: 0 }, { storageKey: 'media/vid-1' }), title: '开场镜头' },
  { ...createWorkflowNode('aud-1', 'audio', { x: 800, y: 0 }, { storageKey: 'media/aud-1' }), title: '配乐' },
];

const spies = vi.hoisted(() => ({
  listSessions: vi.fn(async () => [] as Array<{ id: string; title: string; updatedAt: string }>),
  openSessionById: vi.fn(async (_id: string) => undefined as unknown),
  newSession: vi.fn(async () => undefined as unknown),
  fingerprints: {} as Record<string, string>,
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
          messages: [
            {
              id: 'u1', role: 'user', text: '比较这三份素材',
              turnContext: {
                schemaVersion: 1, sessionId: SESSION, messageId: 'u1', projectId: options.projectId, projectRevisionAtSend: 1, sentAt: '2026-11-24T00:00:00.000Z', origin: 'composer',
                sources: [
                  { kind: 'node', id: 'img-1', label: '主角定妆', contentFingerprint: spies.fingerprints['img-1'], media: { sent: true, imageCount: 1, kind: 'image' } },
                  // 发送后内容被改过：历史里显示「来源已更新」。
                  { kind: 'node', id: 'vid-1', label: '开场镜头', contentFingerprint: 'stale-fingerprint', media: { sent: true, imageCount: 1, kind: 'video-grid', frames: [0, 2, 4] } },
                  { kind: 'node', id: 'aud-1', label: '配乐', contentFingerprint: spies.fingerprints['aud-1'], media: { sent: false, imageCount: 0, note: 'audio 节点没有可查看的画面' } },
                ],
              },
            },
            { id: 'a1', role: 'assistant', text: '## 结论\n主角用红色外套，开场中景。' },
          ],
        }),
        subscribe: () => () => undefined,
        close: async () => undefined,
        send: async () => undefined,
        steer: () => true,
        cancel: () => undefined,
        listSessions: spies.listSessions,
        openSessionById: spies.openSessionById,
        newSession: spies.newSession,
      };
      return new Proxy(base, { get: (target, prop) => (prop in target ? target[prop as string] : prop === 'then' ? undefined : async () => []) }) as unknown as StubKernel;
    }
  }
  return { ...actual, BrowserAgentKernel: StubKernel };
});

const key = {
  id: 'key-spatial', provider: 'openai', key: 'sk-test', status: 'ok',
  routeMappings: [{ routeId: 'hark', order: 0, target: { kind: 'runtime-capability', capability: 'agent-text' } }],
  createdAt: 1, updatedAt: 1,
} as never;

function projectFixture(): WorkflowProject {
  return {
    id: PROJECT, title: 'Spatial', nodes, connections: [], selectedNodeIds: [], viewport: { x: 0, y: 0, k: 1 }, backgroundMode: 'dots',
    agentSessions: [], activeAgentSessionId: null, draftChangeSets: [], draftRedoStack: [], draftVersion: 1, workflowMutationReceipts: [],
    createdAt: '2026-11-24T00:00:00.000Z', updatedAt: '2026-11-24T00:00:00.000Z',
  };
}

const storeProject = () => useWorkflowStore.getState().projects.find(item => item.id === PROJECT)!;

describe('Spatial Context in the Agent drawer', () => {
  beforeEach(() => {
    spies.fingerprints = Object.fromEntries(nodes.map(node => [node.id, nodeContentFingerprint(node)]));
    spies.listSessions.mockReset().mockResolvedValue([]);
    spies.openSessionById.mockReset().mockResolvedValue(undefined);
    spies.newSession.mockReset().mockResolvedValue(undefined);
    vi.mocked(getManagedAgentConnection).mockResolvedValue(null as never);
    useWorkflowStore.setState({ hydrated: true, projects: [projectFixture()], activeProjectId: PROJECT });
  });

  it('shows structured sources from the record, pins a reply through review + Commit, and a repeat Commit only focuses', async () => {
    const onFocusNode = vi.fn();
    render(<IrisAgentPanel project={projectFixture()} onActivityChange={vi.fn()} onOpenSettings={vi.fn()} userApiKeys={[key]} onFocusNode={onFocusNode} />);
    const tiles = await screen.findByTestId('agent-message-refs');
    expect(within(tiles).getAllByRole('button')).toHaveLength(3);
    expect(within(tiles).getByText('来源已更新')).toBeInTheDocument();

    fireEvent.click(await screen.findByRole('button', { name: '钉到画布' }));
    const review = screen.getByTestId('context-card-review');
    expect(within(review).getByDisplayValue('结论')).toBeInTheDocument();
    expect(within(within(review).getByTestId('context-card-review-sources')).getAllByRole('button', { name: /^定位/ })).toHaveLength(3);
    // 审查期间画布上还没有卡片：必须明确点主按钮「钉到画布」（Commit）。
    expect(storeProject().nodes.some(node => node.type === CONTEXT_CARD_TYPE)).toBe(false);
    fireEvent.click(within(review).getByRole('button', { name: '钉到画布' }));
    const cardId = contextCardNodeId({ host: 'iris', sessionId: SESSION, messageId: 'a1' });
    await waitFor(() => expect(onFocusNode).toHaveBeenCalledWith(cardId));
    expect(screen.queryByTestId('context-card-review')).not.toBeInTheDocument();
    const card = storeProject().nodes.find(node => node.id === cardId)!;
    expect(card).toMatchObject({ type: CONTEXT_CARD_TYPE, title: '结论', metadata: { content: '## 结论\n主角用红色外套，开场中景。' } });
    expect(card.metadata.contextCard?.sources.map(source => source.id)).toEqual(['img-1', 'vid-1', 'aud-1']);

    fireEvent.click(screen.getByRole('button', { name: '钉到画布' }));
    fireEvent.click(within(screen.getByTestId('context-card-review')).getByRole('button', { name: '钉到画布' }));
    await waitFor(() => expect(onFocusNode).toHaveBeenCalledTimes(2));
    expect(onFocusNode).toHaveBeenLastCalledWith(cardId);
    expect(storeProject().nodes.filter(node => node.type === CONTEXT_CARD_TYPE)).toHaveLength(1);
  });

  it('继续讨论 opens the original session when it still exists, else seeds a new session with the card and valid sources', async () => {
    render(<IrisAgentPanel project={projectFixture()} onActivityChange={vi.fn()} onOpenSettings={vi.fn()} userApiKeys={[key]} onFocusNode={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: '钉到画布' }));
    fireEvent.click(within(screen.getByTestId('context-card-review')).getByRole('button', { name: '钉到画布' }));
    const cardId = contextCardNodeId({ host: 'iris', sessionId: SESSION, messageId: 'a1' });
    await waitFor(() => expect(storeProject().nodes.some(node => node.id === cardId)).toBe(true));

    spies.listSessions.mockResolvedValue([{ id: SESSION, title: '比较', updatedAt: '2026-11-24T00:00:00.000Z' }]);
    act(() => pushAgentDiscussion({ projectId: PROJECT, cardNodeId: cardId }));
    await waitFor(() => expect(spies.openSessionById).toHaveBeenCalledWith(SESSION));
    expect(spies.newSession).not.toHaveBeenCalled();

    // 会话已删除 + 一个来源被删：新会话，卡片定稿作为引用，只带仍有效的来源。
    spies.listSessions.mockResolvedValue([]);
    useWorkflowStore.getState().updateProject(PROJECT, { nodes: storeProject().nodes.filter(node => node.id !== 'aud-1') });
    act(() => pushAgentDiscussion({ projectId: PROJECT, cardNodeId: cardId }));
    await waitFor(() => expect(spies.newSession).toHaveBeenCalledTimes(1));
    const bar = await screen.findByTestId('agent-quote-bar');
    expect(bar).toHaveTextContent('主角用红色外套');
    await waitFor(() => expect(screen.getByRole('button', { name: '移除引用 主角定妆' })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: '移除引用 开场镜头' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '移除引用 配乐' })).not.toBeInTheDocument();
  });
});
