// P1b 卡片补充：当前步骤行、停止按钮、悬停展开里的 Context / Artifact / Budget、点产物定位节点、旧卡自动增高。
import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createWorkflowNode } from '../components/workflow/constants';
import { flushWorkflowPersistence, useWorkflowStore } from '../components/workflow/store';
import { workflowStorage } from '../components/workflow/storage';
import { createWorkflowNodePluginContext } from '../components/workflow/nodePluginSdk';
import { AgentSessionCardSurface } from '../components/workflow/AgentSessionCardNode';
import { AGENT_SESSION_CARD_SIZE, createAgentSessionCard } from '../components/workflow/agentSessionCard';
import { reduceAgentSessionTrace, traceCurrentStep } from '../components/workflow/agentSessionTrace';
import { useCanvasAgentStore } from '../stores/useCanvasAgentStore';
import type { WorkflowAgentDisplayMessage } from '../components/workflow/WorkflowAgentMessages';
import type { WorkflowProject } from '../components/workflow/types';

const PROJECT = 'project-card-facts';

function projectFixture(): WorkflowProject {
  return {
    id: PROJECT, title: 'Facts', nodes: [
      { ...createWorkflowNode('img-1', 'image', { x: 0, y: 0 }, { storageKey: 'media/img-1', prompt: '红色外套' }), title: '主角定妆', width: 260, height: 170 },
      { ...createWorkflowNode('note-out', 'text', { x: 2000, y: 1400 }, { content: '开场镜头' }), title: '开场镜头', width: 260, height: 120 },
    ], connections: [], selectedNodeIds: [], viewport: { x: 0, y: 0, k: 1 }, backgroundMode: 'dots',
    agentSessions: [], activeAgentSessionId: null, draftChangeSets: [], draftRedoStack: [], draftVersion: 1, workflowMutationReceipts: [],
    createdAt: '2026-11-25', updatedAt: '2026-11-25',
  };
}
const project = () => useWorkflowStore.getState().projects.find(item => item.id === PROJECT)!;

function renderCard(nodeId: string) {
  const node = project().nodes.find(item => item.id === nodeId)!;
  const context = createWorkflowNodePluginContext({ project: project(), node, pluginId: 'iris.agent-session', applyOps: () => true });
  return render(<AgentSessionCardSurface node={context.node} context={context} />);
}

const turn: WorkflowAgentDisplayMessage[] = [
  { id: 'tool-w', role: 'tool', toolName: 'iris_note_write', title: '写备注', args: { title: '开场镜头' }, detail: { content: [{ type: 'text', text: '{"noteId":"note-out"}' }] }, status: 'success', text: '{"noteId":"note-out"}', startedAt: 1000, endedAt: 1300 },
  { id: 'entry-a', role: 'assistant', text: '好了', usage: { input: 1200, output: 340 } },
];

describe('session card facts (P1b)', () => {
  beforeEach(async () => {
    await flushWorkflowPersistence();
    await workflowStorage.clear();
    useWorkflowStore.setState({ hydrated: true, projects: [projectFixture()], activeProjectId: PROJECT });
    useCanvasAgentStore.setState({ requests: [], live: {}, focusCardId: null, seen: {}, drawerOpen: false, harness: null, approvalHandler: null, stopHandler: null });
  });
  afterEach(async () => {
    await flushWorkflowPersistence();
    await workflowStorage.clear();
  });

  it('running: shows the current step line and a stop button that goes to the panel\'s stop handler', async () => {
    const created = await createAgentSessionCard({ projectId: PROJECT, requestId: 'facts-run', origin: 'ask', anchor: { x: 900, y: 600, width: 0, height: 0 } });
    if (created.ok === false) throw new Error(created.error);
    const trace = reduceAgentSessionTrace([{ id: 'tool-v', role: 'tool', toolName: 'iris_workflow_media_view', title: '查看画面', args: { nodeId: 'img-1' }, status: 'pending', text: '', startedAt: Date.now() }], { running: true, nodes: project().nodes });
    expect(traceCurrentStep(trace)).toBe('正在查看画面 · 主角定妆');
    const finished = { ...trace, steps: trace.steps.map(step => ({ ...step, status: 'success' as const })) };
    expect(traceCurrentStep({ ...finished, thinking: { ...finished.thinking, present: true, active: true } })).toBe('已完成 1 步 · 在想下一步');
    expect(traceCurrentStep(finished)).toBe('已完成 1 步 · 等模型回复');
    expect(traceCurrentStep({ ...finished, steps: [], thinking: { ...finished.thinking, present: true, active: true } })).toBe('在想怎么做');
    const stop = vi.fn(() => true);
    useCanvasAgentStore.setState({ stopHandler: stop });
    useCanvasAgentStore.getState().setLive(created.nodeId, { phase: 'running', preview: '', prompt: '开场', trace, background: true });
    const view = renderCard(created.nodeId);
    expect(within(view.container).getByTestId('agent-session-card-current').textContent).toBe('正在查看画面 · 主角定妆');
    fireEvent.click(within(view.container).getByTestId('agent-session-card-stop'));
    expect(stop).toHaveBeenCalledWith(created.nodeId);
    // 停止后：「已停止」，不算未读。
    useCanvasAgentStore.getState().setLive(created.nodeId, { phase: 'done', preview: '', prompt: '开场', trace: reduceAgentSessionTrace([], { running: false }), stopped: true, completedKey: 'x' });
    await waitFor(() => expect(within(view.container).getByTestId('agent-session-card-status').textContent).toBe('已停止'));
    expect(within(view.container).getByTestId('agent-session-card').getAttribute('data-status')).toBe('seen');
    expect(within(view.container).queryByTestId('agent-session-card-stop')).toBeNull();
  });

  it('done: hover shows Context / Artifact / Budget, and clicking an artifact focuses that node via workflow.focus.nodes', async () => {
    const created = await createAgentSessionCard({ projectId: PROJECT, requestId: 'facts-done', origin: 'discuss', references: [{ kind: 'node', id: 'img-1', label: '主角定妆' }], anchor: { x: 900, y: 600, width: 0, height: 0 } } as never);
    if (created.ok === false) throw new Error(created.error);
    const trace = reduceAgentSessionTrace(turn, { running: false, nodes: project().nodes, prompt: { references: [{ id: 'img-1', kind: 'node', label: '主角定妆' }] } });
    expect(trace.context).toEqual([{ kind: 'node', id: 'img-1', label: '主角定妆' }]);
    expect(trace.artifacts.map(item => item.nodeId)).toEqual(['note-out']);
    useCanvasAgentStore.getState().setLive(created.nodeId, { phase: 'done', preview: '好了', prompt: '开场', trace, completedKey: 'entry-a' });
    const view = renderCard(created.nodeId);
    expect(within(view.container).getByTestId('agent-session-card-summary').textContent).toContain('1.5k tokens');
    const facts = within(view.container).getByTestId('agent-session-card-facts');
    expect(facts.textContent).toContain('Context主角定妆');
    expect(facts.textContent).toContain('Budget1.5k tokens');
    const before = project().viewport;
    fireEvent.click(within(facts).getByTestId('agent-session-card-artifact'));
    await waitFor(() => expect(project().viewport).not.toEqual(before));
    // 视口中心落在产物节点上（2000+130, 1400+60）。
    const vp = project().viewport;
    expect(Math.round((window.innerWidth / 2 - vp.x) / vp.k)).toBe(2130);
    expect(Math.round((window.innerHeight / 2 - vp.y) / vp.k)).toBe(1460);
  });

  it('an old P1 card (196 high) grows to the current minimum height when it mounts', async () => {
    const created = await createAgentSessionCard({ projectId: PROJECT, requestId: 'facts-old', origin: 'ask', anchor: { x: 900, y: 600, width: 0, height: 0 } });
    if (created.ok === false) throw new Error(created.error);
    useWorkflowStore.getState().updateProject(PROJECT, { nodes: project().nodes.map(node => (node.id === created.nodeId ? { ...node, height: 196 } : node)) });
    renderCard(created.nodeId);
    await waitFor(() => expect(project().nodes.find(node => node.id === created.nodeId)?.height).toBe(AGENT_SESSION_CARD_SIZE.height));
  });
});
