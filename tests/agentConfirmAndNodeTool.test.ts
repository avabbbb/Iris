import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkflowNode } from '../components/workflow/constants';
import { createWorkflowProject, useWorkflowStore } from '../components/workflow/store';
import { confirmGrantKey, confirmScopesFor, describeAgentConfirmation } from '../components/agent/agentConfirmCopy';
import { agentToolLabel, displayUserTurnText } from '../components/agent/agentTurnText';
import { ASK_TOOL_NAME, createBrowserAgentTools, NODE_TOOL_TOOL_NAMES } from '../services/browserAgentKernel';
import { setWorkflowNodeToolRunner } from '../services/workflowDispatcher';
import { sessionGrantKey } from '../services/agentToolPolicy';

const video = createWorkflowNode('video-1', 'video', { x: 0, y: 0 }, { storageKey: 'video-key', mimeType: 'video/mp4', name: 'dragon.mp4' });
video.title = '视频 1';

describe('Agent confirmation copy', () => {
  it('describes a canvas tool in plain words with node titles instead of IDs', () => {
    const copy = describeAgentConfirmation(
      { kind: 'other', command: 'workflow.node.tool', args: { nodeId: 'video-1', tool: 'video-extract-frame', position: 'current', currentTimeSec: 10 } },
      [video], 'zho', 'workflow.node.tool：video-1',
    );
    expect(copy.title).toBe('导出视频帧「视频 1」');
    expect(copy.detail).toBe('当前帧 10.0s');
    expect(JSON.stringify(copy)).not.toContain('video-1');
  });

  it('never shows raw command text as the sentence', () => {
    expect(describeAgentConfirmation(undefined, [], 'zho', 'workflow.node.create：abc').title).toBe('执行一个画布操作');
    expect(describeAgentConfirmation({ kind: 'other', command: 'workflow.node.create', tier: 'write' }, [], 'en').title).toBe('Edit the canvas');
  });

  it('offers a session grant only for mode-raised prompts, never for safety overrides', () => {
    expect(confirmScopesFor({ kind: 'destructive', command: 'workflow.node.delete' })).toEqual(['once']);
    expect(confirmScopesFor({ kind: 'generation', command: 'workflow.node.run' }, { offerMandate: true })).toEqual(['once', 'session']);
    expect(confirmScopesFor({ kind: 'generation', command: 'workflow.node.run' })).toEqual(['once']);
    // 付费节点工具是安全覆盖：逐次确认。
    expect(confirmScopesFor({ kind: 'other', command: 'workflow.node.tool', args: { tool: 'upscale' }, tier: 'exec', reason: '可能产生费用', grantable: false })).toEqual(['once']);
    expect(confirmScopesFor({ kind: 'other', command: 'workflow.node.tool', args: { tool: 'video-extract-frame' }, tier: 'write', grantable: true })).toEqual(['once', 'session']);
    expect(confirmGrantKey({ kind: 'destructive', command: 'workflow.node.delete' })).toBeNull();
    expect(confirmGrantKey({ kind: 'other', command: 'workflow.apply', tier: 'write', grantable: false })).toBeNull();
    expect(confirmGrantKey({ kind: 'other', command: 'workflow.node.tool', args: { tool: 'video-trim' }, tier: 'write', grantable: true })).toBe(sessionGrantKey('workflow.node.tool', 'write'));
  });
});

describe('Cut approval through the built-in Agent guard', () => {
  it('asks once per delete and never touches Cut when the user declines', async () => {
    const confirm = vi.fn(async (_summary: string, _request?: unknown) => false);
    const tools = createBrowserAgentTools({ projectId: 'p', confirm, activeChangeSetId: 'turn', getApproval: () => ({ mode: 'yolo' }) });
    const edit = tools.find(item => item.name === 'iris_cut_edit')!;
    await expect(edit.execute('call', { operations: [{ op: 'delete_clips', clipIds: ['c1'] }] } as never, undefined as never)).rejects.toThrow();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][1]).toMatchObject({ kind: 'destructive', command: 'iris_cut_edit', grantable: false });
    const subtitles = tools.find(item => item.name === 'iris_cut_subtitles')!;
    await expect(subtitles.execute('call', { action: 'replace_all', cues: [] } as never, undefined as never)).rejects.toThrow();
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it('refuses Cut writes in a read-only delegated turn without asking', async () => {
    const confirm = vi.fn(async () => true);
    const tools = createBrowserAgentTools({ projectId: 'p', confirm, activeChangeSetId: 'turn', getApproval: () => ({ mode: 'always-ask', headless: true, maxTier: 'read', userPolicy: { iris_cut_edit: 'allow' } }) });
    const edit = tools.find(item => item.name === 'iris_cut_edit')!;
    await expect(edit.execute('call', { operations: [{ op: 'move_clip', clipId: 'c1', start: 2 }] } as never, undefined as never)).rejects.toThrow('权限上限');
    expect(confirm).not.toHaveBeenCalled();
  });

  it('describes Cut deletes in plain words', () => {
    expect(describeAgentConfirmation({ kind: 'destructive', command: 'iris_cut_edit', args: { operations: [{ op: 'delete_clips', clipIds: ['a', 'b'] }, { op: 'remove_track', trackId: 't' }] } }, [], 'zho').title).toBe('在 Cut 里删除 2 个片段、1 条轨道');
    expect(describeAgentConfirmation({ kind: 'destructive', command: 'iris_cut_subtitles', args: { action: 'replace_all', cues: [{}, {}] } }, [], 'zho')).toEqual({ title: '替换 Cut 里的全部字幕', detail: '新字幕 2 条' });
  });
});

describe('Agent transcript text', () => {
  it('hides model-only context such as node IDs from the user bubble', () => {
    const stored = '[创作模式: 视频创作]\n抽第十秒的帧\n\n引用上下文：\n- @视频 1（工作流节点 nodeId=Aj1Rv7vsBZ9CPa5icN-Li）\n\n已附带画面：\nAj1Rv7vsBZ9CPa5icN-Li：视频「视频 1」首/中/尾帧';
    expect(displayUserTurnText(stored)).toBe('抽第十秒的帧\n\n引用：@视频 1');
    expect(agentToolLabel('iris_workflow_inspect', 'zho')).toBe('读取画布');
    expect(agentToolLabel('plugin_tool', 'zho')).toBe('plugin_tool');
  });
});

describe('built-in Agent ask tool', () => {
  it('exposes iris_ask and returns the submitted form data', async () => {
    const ask = vi.fn(async () => ({ ok: true as const, data: { style: 'fresh' } }));
    const tools = createBrowserAgentTools({ projectId: 'p', confirm: vi.fn(async () => true), ask, activeChangeSetId: 'turn' });
    const tool = tools.find(item => item.name === ASK_TOOL_NAME)!;
    expect(tool).toBeDefined();
    const result = await tool.execute('call', { html: '<form><input name="style"></form>' } as never, undefined as never);
    expect(ask).toHaveBeenCalledWith({ html: '<form><input name="style"></form>' });
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({ ok: true, data: { style: 'fresh' } });
  });

  it('turns a cancelled ask into a tool error', async () => {
    const tools = createBrowserAgentTools({ projectId: 'p', confirm: vi.fn(async () => true), ask: vi.fn(async () => ({ ok: false as const, cancelled: true as const })), activeChangeSetId: 'turn' });
    const tool = tools.find(item => item.name === ASK_TOOL_NAME)!;
    await expect(tool.execute('call', { html: '<form><input name="x"></form>' } as never, undefined as never)).rejects.toThrow(/取消/);
  });
});

describe('built-in Agent canvas tools', () => {
  afterEach(() => setWorkflowNodeToolRunner(undefined));

  it('exposes every registry node tool to the built-in Agent and extracts a frame at a given second', async () => {
    const project = { ...createWorkflowProject('抽帧'), id: 'project-frame', nodes: [video] };
    useWorkflowStore.setState({ projects: [project], activeProjectId: project.id });
    const runner = vi.fn(async () => {
      const frame = createWorkflowNode('frame-1', 'image', { x: 400, y: 0 }, { storageKey: 'frame-key', mimeType: 'image/png' });
      const next = { ...useWorkflowStore.getState().projects[0], nodes: [video, frame] };
      useWorkflowStore.getState().updateProject(project.id, { nodes: next.nodes });
      return { status: 'committed', project: next };
    });
    setWorkflowNodeToolRunner(runner);
    const tools = createBrowserAgentTools({ projectId: project.id, confirm: vi.fn(async () => true), activeChangeSetId: 'turn-1' });
    const tool = tools.find(item => item.name === NODE_TOOL_TOOL_NAMES.video)!;
    expect(tool).toBeDefined();
    // 工具按媒体拆分：每个工具的说明只列本类工具（来自同一份说明书）。
    expect(tool.description).toContain('video-extract-frame');
    expect(tool.description).not.toContain('audio-stem-split');
    expect(tools.find(item => item.name === NODE_TOOL_TOOL_NAMES.audio)!.description).toContain('audio-stem-split');
    expect(tools.some(item => item.name === 'iris_workflow_node_tool')).toBe(false);

    const result = await tool.execute('call-1', { nodeId: 'video-1', tool: 'video-extract-frame', position: 'current', currentTimeSec: 10 } as never, undefined as never);
    expect(runner).toHaveBeenCalledWith(project.id, 'video-1', 'video-extract-frame', { position: 'current', currentTimeSec: 10 }, { basis: 'free', tool: 'video-extract-frame' });
    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({ committed: true, outputNodeIds: ['frame-1'] });
  });

  it('routes tool calls through the approval resolver: mode prompts are grantable, headless prompts fail closed', async () => {
    const project = { ...createWorkflowProject('审批'), id: 'project-approval', nodes: [video] };
    useWorkflowStore.setState({ projects: [project], activeProjectId: project.id });
    const confirm = vi.fn(async (_summary: string, _request?: unknown) => false);
    const operations = [{ type: 'update_node', id: 'video-1', patch: { title: '新标题' } }];
    const ask = createBrowserAgentTools({ projectId: project.id, confirm, activeChangeSetId: 't', getApproval: () => ({ mode: 'always-ask' }) })
      .find(item => item.label === 'workflow.apply')!;
    await expect(ask.execute('c1', { operations } as never, undefined as never)).rejects.toThrow('用户拒绝');
    expect(confirm).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ command: 'workflow.apply', tool: 'workflow.apply', tier: 'write', grantable: true }));

    confirm.mockClear();
    const headless = createBrowserAgentTools({ projectId: project.id, confirm, activeChangeSetId: 't', getApproval: () => ({ mode: 'always-ask', headless: true }) })
      .find(item => item.label === 'workflow.apply')!;
    await expect(headless.execute('c2', { operations } as never, undefined as never)).rejects.toThrow('无人值守');
    expect(confirm).not.toHaveBeenCalled();

    const denied = createBrowserAgentTools({ projectId: project.id, confirm, activeChangeSetId: 't', getApproval: () => ({ mode: 'yolo', userPolicy: { 'workflow.apply': 'deny' } }) })
      .find(item => item.label === 'workflow.apply')!;
    await expect(denied.execute('c3', { operations } as never, undefined as never)).rejects.toThrow('禁止');
    expect(confirm).not.toHaveBeenCalled();
  });
});
