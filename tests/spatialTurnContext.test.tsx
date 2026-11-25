import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import localforage from 'localforage';
import { BrowserAgentKernel } from '../services/browserAgentKernel';
import { createWorkflowNode } from '../components/workflow/constants';
import type { WorkflowNode } from '../components/workflow/types';
import {
  TURN_CONTEXT_ENTRY,
  buildTurnContextDraft,
  nodeContentFingerprint,
  sentNodeMedia,
  sourceState,
  turnContextReferences,
  type TurnContextRecord,
} from '../services/turnContext';
import { userTurnReferences } from '../components/agent/agentMessageRefs';
import { AgentMediaTiles } from '../components/agent/AgentMediaTiles';

const PROJECT = 'project-spatial-p0';
const route = { provider: 'openai_compatible', model: 'm', baseUrl: 'https://gw.example/v1', apiKey: 'k' };

function reply(text: string): Response {
  const body = [{ choices: [{ delta: { content: text } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]
    .map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

type UserSnapshotMessage = { id: string; role: string; text: string; turnContext?: TurnContextRecord };
type Snapshot = { sessionId: string; messages: UserSnapshotMessage[] };

const make = () => new BrowserAgentKernel({ projectId: PROJECT, route, tools: [], confirm: async () => true, systemPrompt: 'SYS', getThinkingLevel: () => 'off', memory: null });

function threeNodes(): WorkflowNode[] {
  const image = { ...createWorkflowNode('img-1', 'image', { x: 0, y: 0 }, { storageKey: 'media/img-1', prompt: '红色外套' }), title: '主角定妆' };
  const video = { ...createWorkflowNode('vid-1', 'video', { x: 400, y: 0 }, { storageKey: 'media/vid-1', durationMs: 5000 }), title: '开场镜头' };
  const text = { ...createWorkflowNode('note-1', 'text', { x: 800, y: 0 }, { content: '色调：暖' }), title: '备注' };
  return [image, video, text];
}

describe('Spatial Context P0: structured turn context', () => {
  let kernel: BrowserAgentKernel | undefined;
  beforeEach(async () => { await localforage.removeItem(`iris.agent.sessions.${PROJECT}`); });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await kernel?.close();
    kernel = undefined;
    await localforage.removeItem(`iris.agent.sessions.${PROJECT}`);
  });

  it('content fingerprint ignores position, size and title but follows media / prompt / model changes', () => {
    const [image] = threeNodes();
    const base = nodeContentFingerprint(image);
    expect(nodeContentFingerprint({ ...image, position: { x: 999, y: -40 }, width: 10, height: 10, title: '改名' } as WorkflowNode)).toBe(base);
    expect(nodeContentFingerprint({ ...image, metadata: { ...image.metadata, status: 'loading', progress: 40 } })).toBe(base);
    expect(nodeContentFingerprint({ ...image, metadata: { ...image.metadata, prompt: '蓝色外套' } })).not.toBe(base);
    expect(nodeContentFingerprint({ ...image, metadata: { ...image.metadata, storageKey: 'media/img-1-v2' } })).not.toBe(base);
    expect(nodeContentFingerprint({ ...image, metadata: { ...image.metadata, config: { modelId: 'other' } as never } })).not.toBe(base);
  });

  it('records which media actually reached the model (attachments first, 6-image cap)', () => {
    const sent = sentNodeMedia([
      { nodeId: 'img-1', imageCount: 1, kind: 'image' },
      { nodeId: 'vid-1', imageCount: 1, kind: 'video-grid', frames: [0, 2.5, 5] },
      { nodeId: 'note-1', imageCount: 0, note: 'text 节点没有可查看的画面' },
    ], 5, 6);
    expect(sent['img-1']).toMatchObject({ sent: true, imageCount: 1, kind: 'image' });
    expect(sent['vid-1']).toMatchObject({ sent: false, imageCount: 0 });
    expect(sent['vid-1'].note).toContain('6 张上限');
    expect(sent['note-1']).toMatchObject({ sent: false, note: 'text 节点没有可查看的画面' });
  });

  it('acceptance 1: three sources sent, then reload — structured references stay exact and keyed by real ids', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply('收到三份素材')));
    const nodes = threeNodes();
    const draft = buildTurnContextDraft({
      projectId: PROJECT,
      projectRevision: 7,
      references: nodes.map(node => ({ id: node.id, type: 'node' as const, label: node.title })),
      nodes,
      media: sentNodeMedia([
        { nodeId: 'img-1', imageCount: 1, kind: 'image' },
        { nodeId: 'vid-1', imageCount: 1, kind: 'video-grid', frames: [0, 2.5, 5] },
        { nodeId: 'note-1', imageCount: 0, note: 'text 节点没有可查看的画面' },
      ], 0, 6),
    })!;
    kernel = make();
    await kernel.openSession();
    // 发送文本里故意不带「引用上下文」：结构化记录不能依赖文本解析。
    await kernel.send('比较这三份素材', [], undefined, draft);
    const live = await kernel.snapshot() as unknown as Snapshot;
    await kernel.close();

    kernel = make();
    const reopened = await kernel.openSession() as unknown as Snapshot;
    expect(reopened.sessionId).toBe(live.sessionId);
    const user = reopened.messages.find(message => message.role === 'user')!;
    expect(userTurnReferences(user.text)).toEqual([]);
    const record = user.turnContext!;
    expect(record).toMatchObject({ schemaVersion: 1, sessionId: live.sessionId, messageId: user.id, projectId: PROJECT, projectRevisionAtSend: 7, origin: 'composer' });
    expect(record.sources.map(source => [source.kind, source.id, source.label, source.contentFingerprint])).toEqual(
      nodes.map(node => ['node', node.id, node.title, nodeContentFingerprint(node)]),
    );
    expect(record.sources.map(source => source.media.sent)).toEqual([true, true, false]);
    expect(record.sources[1].media).toMatchObject({ kind: 'video-grid', frames: [0, 2.5, 5] });
    expect(turnContextReferences(record).map(ref => ref.id)).toEqual(['img-1', 'vid-1', 'note-1']);
    // 只追加的 custom entry：就在用户消息之后，不进模型上下文。
    const entries = await (kernel as unknown as { session: { getStorage(): { getEntries(): Promise<Array<{ id: string; type: string; customType?: string }>> } } }).session.getStorage().getEntries();
    const userIndex = entries.findIndex(entry => entry.id === user.id);
    expect(entries[userIndex + 1]).toMatchObject({ type: 'custom', customType: TURN_CONTEXT_ENTRY });
  });

  it('group-inbox references freeze the group into the record; branches re-key the record to the new ids', async () => {
    const bodies: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => { bodies.push(String(init.body)); return reply('好的'); }));
    const nodes = threeNodes().slice(0, 2);
    const draft = buildTurnContextDraft({
      projectId: PROJECT,
      projectRevision: 3,
      references: nodes.map(node => ({ id: node.id, type: 'node' as const, label: node.title, group: { label: '分组 · 2 个节点', batchId: 'b-1' } })),
      nodes,
    })!;
    expect(draft.origin).toBe('group');
    expect(draft.group).toEqual({ label: '分组 · 2 个节点', batchId: 'b-1', nodeIds: ['img-1', 'vid-1'] });
    kernel = make();
    await kernel.openSession();
    await kernel.send('看看这一组', [], undefined, draft);
    expect(bodies.join('')).not.toContain(TURN_CONTEXT_ENTRY);
    const first = await kernel.snapshot() as unknown as Snapshot;
    const assistant = first.messages.find(message => message.role === 'assistant')!;
    const branched = await kernel.branchSession(first.sessionId, assistant.id) as unknown as Snapshot;
    expect(branched.sessionId).not.toBe(first.sessionId);
    const user = branched.messages.find(message => message.role === 'user')!;
    expect(user.turnContext).toMatchObject({ sessionId: branched.sessionId, messageId: user.id, origin: 'group', group: { nodeIds: ['img-1', 'vid-1'] } });
  });

  it('history tiles show 不可用 for deleted sources and 来源已更新 only when content changed', () => {
    const nodes = threeNodes();
    const refs = nodes.map(node => ({ id: node.id, kind: 'node' as const, label: node.title, fingerprint: nodeContentFingerprint(node) }));
    const moved = nodes.map(node => (node.id === 'img-1' ? { ...node, position: { x: 500, y: 500 }, width: 120 } : node));
    const { rerender, container } = render(<AgentMediaTiles refs={refs} nodes={moved} />);
    expect(screen.queryByText('来源已更新')).toBeNull();
    expect(screen.queryByText('不可用')).toBeNull();
    const changed = moved.filter(node => node.id !== 'note-1').map(node => (node.id === 'vid-1' ? { ...node, metadata: { ...node.metadata, storageKey: 'media/vid-1-v2' } } : node));
    rerender(<AgentMediaTiles refs={refs} nodes={changed} />);
    expect(screen.getByText('来源已更新')).toBeInTheDocument();
    expect(screen.getByText('不可用')).toBeInTheDocument();
    expect(container.querySelector('[data-state="updated"]')).not.toBeNull();
    expect(sourceState({ kind: 'node', id: 'img-1', fingerprint: refs[0].fingerprint }, moved)).toBe('ok');
  });
});
