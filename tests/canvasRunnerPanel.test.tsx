// 排队修复（面板级）：Drawer / 面板这一轮在等审批时，另一张会话卡的发送不再被挡住——交给后台运行时跑完；
// 卡片上的停止只停那张卡；后台会话被认领时面板不能同时打开它（Session Authority）。
import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IrisAgentPanel } from '../components/agent/IrisAgentPanel';
import { createWorkflowNode } from '../components/workflow/constants';
import { flushWorkflowPersistence, useWorkflowStore } from '../components/workflow/store';
import { workflowStorage } from '../components/workflow/storage';
import { createAgentSessionCard } from '../components/workflow/agentSessionCard';
import { decideCanvasAgentApproval, pushCanvasAgentSend, stopCanvasAgentRun, useCanvasAgentStore } from '../stores/useCanvasAgentStore';
import { getManagedAgentConnection } from '../services/managedAgentConnection';
import { browserAgentSessionClaimed } from '../services/browserAgentRuntime';
import type * as BrowserAgentKernelModule from '../services/browserAgentKernel';
import type { WorkflowProject } from '../components/workflow/types';

const PROJECT = 'project-canvas-runners';

const stub = vi.hoisted(() => ({
  instances: 0,
  sessionSeq: 0,
  /** 卡片 B 的后台轮次：等这个放行（用来测停止）。 */
  holdB: false,
  sessions: new Map<string, Array<Record<string, unknown>>>(),
}));

vi.mock('../services/managedAgentConnection', () => ({ getManagedAgentConnection: vi.fn() }));

vi.mock('../services/browserAgentKernel', async importOriginal => {
  const actual = await importOriginal<typeof BrowserAgentKernelModule>();
  class StubKernel {
    constructor(options: { projectId: string; confirm: (summary: string, request?: unknown) => Promise<unknown> }) {
      stub.instances += 1;
      const listeners = new Set<(event: Record<string, unknown>) => void>();
      const emit = (event: Record<string, unknown>) => listeners.forEach(listener => listener(event));
      let sessionId = 'main-' + stub.instances;
      let cancelled: (() => void) | null = null;
      const messages = () => stub.sessions.get(sessionId) || [];
      const base: Record<string, unknown> = {
        openSession: async () => undefined,
        snapshot: async () => ({ sessionId, projectId: options.projectId, running: false, messages: messages() }),
        subscribe: (listener: (event: Record<string, unknown>) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
        close: async () => undefined,
        send: async (text: string) => {
          const log = [...messages(), { id: sessionId + '-u' + messages().length, role: 'user', text }];
          stub.sessions.set(sessionId, log);
          const stop = new Promise<void>(resolve => { cancelled = resolve; });
          emit({ type: 'message_start' });
          if (text.includes('写备注')) {
            emit({ type: 'tool_execution_start', toolCallId: 'note-' + sessionId, toolName: 'iris_note_write', args: { title: '开场镜头' } });
            const verdict = await Promise.race([options.confirm('写备注「开场镜头」', { kind: 'other', command: 'workflow.note.write', tool: 'iris_note_write', tier: 'write', grantable: true }), stop.then(() => false)]);
            emit({ type: 'tool_execution_end', toolCallId: 'note-' + sessionId, toolName: 'iris_note_write', result: { content: [{ type: 'text', text: verdict ? '已写入备注' : '用户拒绝了该操作' }] }, isError: !verdict });
          }
          if (text.includes('慢') && stub.holdB) { emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: '想很久。' } }); await stop; return; }
          emit({ type: 'message_start' });
          emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '回复：' + text.split('\n')[0] } });
          stub.sessions.set(sessionId, [...(stub.sessions.get(sessionId) || []), { id: sessionId + '-a' + log.length, role: 'assistant', text: '回复：' + text.split('\n')[0] }]);
        },
        cancel: () => { cancelled?.(); },
        steer: () => false,
        listSessions: async () => [...stub.sessions.keys()].map(id => ({ id, title: id, updatedAt: '2026-11-25' })),
        openSessionById: async (id: string) => { sessionId = id; },
        newSession: async () => { sessionId = 'sess-' + ++stub.sessionSeq; },
      };
      return new Proxy(base, { get: (target, prop) => (prop in target ? target[prop as string] : prop === 'then' ? undefined : async () => []) }) as unknown as StubKernel;
    }
  }
  return { ...actual, BrowserAgentKernel: StubKernel };
});

const key = {
  id: 'key-runners', provider: 'openai', key: 'sk-test', status: 'ok',
  models: [{ id: 'mock-chat', name: 'mock-chat' }],
  routeMappings: [{ routeId: 'mock-chat', order: 0, target: { kind: 'runtime-capability', capability: 'agent-text' } }],
  createdAt: 1, updatedAt: 1,
} as never;

function projectFixture(): WorkflowProject {
  return {
    id: PROJECT, title: 'Runners', nodes: [
      { ...createWorkflowNode('note-1', 'text', { x: 0, y: 220 }, { content: '暖色、低饱和' }), title: '色调备注', width: 260, height: 120 },
    ], connections: [], selectedNodeIds: [], viewport: { x: 0, y: 0, k: 1 }, backgroundMode: 'dots',
    agentSessions: [], activeAgentSessionId: null, draftChangeSets: [], draftRedoStack: [], draftVersion: 1, workflowMutationReceipts: [],
    createdAt: '2026-11-25', updatedAt: '2026-11-25',
  };
}
const project = () => useWorkflowStore.getState().projects.find(item => item.id === PROJECT)!;
const live = (id: string) => useCanvasAgentStore.getState().live[id];

async function card(requestId: string, y: number) {
  const created = await createAgentSessionCard({ projectId: PROJECT, requestId, origin: 'ask', anchor: { x: 900, y, width: 0, height: 0 } });
  if (created.ok === false) throw new Error(created.error);
  return created.nodeId;
}

describe('canvas session runners in the panel (queue fix)', () => {
  beforeEach(async () => {
    await flushWorkflowPersistence();
    await workflowStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('iris.agent.approvalMode', 'always-ask');
    useWorkflowStore.setState({ hydrated: true, projects: [projectFixture()], activeProjectId: PROJECT });
    useCanvasAgentStore.setState({ requests: [], live: {}, focusCardId: null, seen: {}, drawerOpen: false, harness: null, approvalHandler: null, stopHandler: null });
    stub.instances = 0;
    stub.sessionSeq = 0;
    stub.holdB = false;
    stub.sessions.clear();
    vi.mocked(getManagedAgentConnection).mockResolvedValue(null as never);
  });
  afterEach(async () => {
    localStorage.removeItem('iris.agent.approvalMode');
    await flushWorkflowPersistence();
    await workflowStorage.clear();
  });

  it('while card A waits for approval in the panel, card B runs in a background runtime and finishes', async () => {
    const a = await card('runner-a', 600);
    const b = await card('runner-b', 1000);
    render(<IrisAgentPanel project={project()} onActivityChange={vi.fn()} onOpenSettings={vi.fn()} userApiKeys={[key]} onFocusNode={vi.fn()} />);
    act(() => { pushCanvasAgentSend({ projectId: PROJECT, cardNodeId: a, text: 'A 写备注', references: [] }); });
    await waitFor(() => expect(live(a)?.approval).toBeTruthy());
    expect(live(a)?.background).toBeUndefined();

    act(() => { pushCanvasAgentSend({ projectId: PROJECT, cardNodeId: b, text: 'B 简单问题', references: [] }); });
    await waitFor(() => expect(live(b)?.phase).toBe('done'));
    expect(live(b)).toMatchObject({ background: true, preview: '回复：B 简单问题' });
    // A 仍在等它自己的审批，没被 B 打扰。
    expect(live(a)?.approval).toBeTruthy();
    expect(useCanvasAgentStore.getState().requests).toEqual([]);
    // B 的会话 id 写进了卡片，后台运行时结束后释放了认领。
    await waitFor(() => expect(project().nodes.find(node => node.id === b)?.metadata.agentSession?.sessionId).toMatch(/^sess-/));
    const sessionB = project().nodes.find(node => node.id === b)!.metadata.agentSession!.sessionId!;
    expect(browserAgentSessionClaimed(PROJECT, sessionB)).toBe(false);
    await waitFor(() => expect(project().nodes.find(node => node.id === b)?.metadata.agentSession?.lastTurn?.excerpt).toContain('回复：B'));

    act(() => { expect(decideCanvasAgentApproval({ cardNodeId: a, approvalId: live(a)!.approval!.id, approved: true })).toBe(true); });
    await waitFor(() => expect(live(a)?.phase).toBe('done'));
  });

  it('card B can wait for its own approval in the background while A also waits; stopping B leaves A pending', async () => {
    const a = await card('runner-a2', 600);
    const b = await card('runner-b2', 1000);
    render(<IrisAgentPanel project={project()} onActivityChange={vi.fn()} onOpenSettings={vi.fn()} userApiKeys={[key]} onFocusNode={vi.fn()} />);
    act(() => { pushCanvasAgentSend({ projectId: PROJECT, cardNodeId: a, text: 'A 写备注', references: [] }); });
    await waitFor(() => expect(live(a)?.approval).toBeTruthy());
    act(() => { pushCanvasAgentSend({ projectId: PROJECT, cardNodeId: b, text: 'B 也写备注', references: [] }); });
    await waitFor(() => expect(live(b)?.approval).toBeTruthy());
    expect(live(b)?.approval?.id).not.toBe(live(a)?.approval?.id);
    expect(live(b)?.background).toBe(true);
    // B 的审批在 B 自己的队列里：批 B 不会动 A。
    act(() => { expect(stopCanvasAgentRun(b)).toBe(true); });
    await waitFor(() => expect(live(b)).toMatchObject({ phase: 'done', stopped: true }));
    expect(live(a)?.approval).toBeTruthy();
    expect(live(a)?.phase).toBe('running');
  });

  it('stopping a card whose turn runs in the panel runtime ends it as stopped (not stuck on running)', async () => {
    stub.holdB = true;
    const c = await card('runner-c', 600);
    render(<IrisAgentPanel project={project()} onActivityChange={vi.fn()} onOpenSettings={vi.fn()} userApiKeys={[key]} onFocusNode={vi.fn()} />);
    act(() => { pushCanvasAgentSend({ projectId: PROJECT, cardNodeId: c, text: '慢慢想', references: [] }); });
    await waitFor(() => expect(live(c)?.phase).toBe('running'));
    expect(live(c)?.background).toBeUndefined();
    act(() => { expect(stopCanvasAgentRun(c)).toBe(true); });
    await waitFor(() => expect(live(c)).toMatchObject({ phase: 'done', stopped: true }));
  });
});
