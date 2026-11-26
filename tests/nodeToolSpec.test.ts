import { describe, expect, it, vi } from 'vitest';
import { createWorkflowDispatcher, withWorkflowHumanApproval, workflowCommandNeedsConfirmation, type WorkflowDispatcherDependencies } from '../services/workflowDispatcher';
import { createWorkflowExecutor } from '../services/workflowExecutor';
import { createWorkflowProject } from '../components/workflow/store';
import { createWorkflowNode } from '../components/workflow/constants';
import { WORKFLOW_NODE_TOOLS, isWorkflowNodeToolCommand, workflowNodeToolSpecs, workflowNodeToolIsPaid } from '../components/workflow/nodeToolCatalog';
import { resolveToolApproval, toolApprovalFor } from '../services/agentToolPolicy';
import { describeWorkflowNodeTools } from '../services/browserAgentKernel';
import { agentToolCommand, getAgentToolSpecs } from '../tools/iris/agent-tools.js';
import { AGENT_PUBLIC_COMMAND_SET } from '../tools/iris/agent-surface.js';
import type { WorkflowProject } from '../components/workflow/types';

const setup = () => {
  let projects: WorkflowProject[] = [createWorkflowProject('工具')];
  projects[0].nodes = [
    createWorkflowNode('img', 'image', { x: 0, y: 0 }, { href: 'https://cdn.example.com/a.png', storageKey: 'a', mimeType: 'image/png' }),
    createWorkflowNode('vid', 'video', { x: 400, y: 0 }, { href: 'https://cdn.example.com/a.mp4', storageKey: 'v', mimeType: 'video/mp4' }),
    createWorkflowNode('vid2', 'video', { x: 800, y: 0 }, { href: 'https://cdn.example.com/b.mp4', storageKey: 'v2', mimeType: 'video/mp4' }),
  ];
  const nodeToolRunner = vi.fn(async () => ({ status: 'committed' as const }));
  const dependencies: WorkflowDispatcherDependencies = {
    getState: () => ({ projects, activeProjectId: projects[0].id }),
    createProject: () => '', setActiveProject: () => {}, deleteProjects: () => {},
    updateProject: (id, patch) => { projects = projects.map(project => project.id === id ? { ...project, ...patch } : project); },
    executor: createWorkflowExecutor({ runNode: vi.fn() as never, stopNode: vi.fn() }, { createRunId: () => 'r' }),
    nodeToolRunner: nodeToolRunner as never,
    getUserApiKeys: () => [],
  };
  return { dispatch: createWorkflowDispatcher(dependencies), nodeToolRunner };
};

describe('node tool spec (schema discovery)', () => {
  it('describes every callable tool with input types, billing and a JSON schema', () => {
    const specs = workflowNodeToolSpecs();
    expect(specs.map(spec => spec.tool).sort()).toEqual([...WORKFLOW_NODE_TOOLS].sort());
    for (const spec of specs) {
      expect(spec.inputTypes.length).toBeGreaterThan(0);
      expect(['free', 'paid', 'llm']).toContain(spec.billing);
      expect(spec.parameters.type).toBe('object');
      expect(spec.output).toBeTruthy();
    }
    const upscale = specs.find(spec => spec.tool === 'upscale')!;
    expect(upscale).toMatchObject({ billing: 'paid', inputTypes: ['image'] });
    expect((upscale.parameters.properties as Record<string, { minimum?: number; maximum?: number }>).targetLongEdge).toMatchObject({ minimum: 512, maximum: 8192 });
    expect(specs.find(spec => spec.tool === 'video-trim')).toMatchObject({ billing: 'free', inputTypes: ['video'] });
  });

  it('treats outpaint and mask as paid like edit (they call the same image service)', () => {
    for (const tool of ['outpaint', 'mask', 'edit', 'upscale']) {
      expect(workflowNodeToolIsPaid(tool)).toBe(true);
      expect(workflowCommandNeedsConfirmation('workflow.node.tool', { nodeId: 'img', tool })).toBe(true);
      expect(toolApprovalFor('workflow.node.tool', { tool }).tier).toBe('exec');
    }
    for (const tool of ['crop', 'filter', 'video-trim', 'reverse-prompt']) {
      expect(workflowCommandNeedsConfirmation('workflow.node.tool', { nodeId: 'img', tool })).toBe(false);
      expect(toolApprovalFor('workflow.node.tool', { tool }).tier).toBe('write');
    }
  });

  it('builds the built-in Agent tool guide from the same spec', () => {
    const guide = describeWorkflowNodeTools();
    expect(guide).toContain('- outpaint：扩展画面（image，调用 AI 服务，会先请用户确认）');
    expect(guide).toContain('iris_node_tool_list');
  });
});

describe('workflow.node.tool.list', () => {
  it('lists all tools, the ones a node can use, or one tool', async () => {
    const { dispatch } = setup();
    const all = await dispatch({ id: 'a', command: 'workflow.node.tool.list', source: 'agent', args: {} });
    expect(all.confirmation).toBeUndefined();
    expect((all.result as { tools: unknown[] }).tools).toHaveLength(WORKFLOW_NODE_TOOLS.length);
    const forVideo = await dispatch({ id: 'b', command: 'workflow.node.tool.list', source: 'agent', args: { nodeId: 'vid' } });
    const videoTools = (forVideo.result as { nodeType: string; tools: { tool: string }[] });
    expect(videoTools.nodeType).toBe('video');
    expect(videoTools.tools.map(item => item.tool)).toContain('video-trim');
    expect(videoTools.tools.map(item => item.tool)).not.toContain('upscale');
    const one = await dispatch({ id: 'c', command: 'workflow.node.tool.list', source: 'agent', args: { tool: 'split-grid' } });
    expect((one.result as { tools: { tool: string }[] }).tools.map(item => item.tool)).toEqual(['split-grid']);
    expect((await dispatch({ id: 'd', command: 'workflow.node.tool.list', source: 'agent', args: { tool: 'nope' } })).error?.code).toBe('BAD_REQUEST');
    expect((await dispatch({ id: 'e', command: 'workflow.node.tool.list', source: 'agent', args: { nodeId: 'zz' } })).error?.code).toBe('NOT_FOUND');
  });

  it('is a public read tool on every host', () => {
    expect(AGENT_PUBLIC_COMMAND_SET.has('workflow.node.tool.list')).toBe(true);
    expect(agentToolCommand('iris_node_tool_list')).toBe('workflow.node.tool.list');
    expect(toolApprovalFor('workflow.node.tool.list', {})).toEqual({ tier: 'read' });
    for (const host of ['builtin', 'local', 'mcp', 'dsh']) {
      expect(getAgentToolSpecs(host).some((spec: { command: string }) => spec.command === 'workflow.node.tool.list')).toBe(true);
    }
  });
});

describe('workflow.node.tool pre-checks run before the approval card', () => {
  it('rejects a tool on the wrong node type with the tools that node can use', async () => {
    const { dispatch, nodeToolRunner } = setup();
    const result = await dispatch({ id: 'a', command: 'workflow.node.tool', source: 'agent', args: { nodeId: 'vid', tool: 'upscale', targetLongEdge: 2048 } });
    expect(result.confirmation).toBeUndefined();
    expect(result.error?.code).toBe('TOOL_NOT_APPLICABLE');
    expect((result.error?.details as { usableTools: string[] }).usableTools).toContain('video-extract-frame');
    expect(nodeToolRunner).not.toHaveBeenCalled();
  });

  it('rejects bad parameters with the schema, without asking first', async () => {
    const { dispatch } = setup();
    const bad = await dispatch({ id: 'a', command: 'workflow.node.tool', source: 'agent', args: { nodeId: 'img', tool: 'upscale', targetLongEdge: 99999 } });
    expect(bad.confirmation).toBeUndefined();
    expect(bad.error?.code).toBe('BAD_REQUEST');
    expect(bad.error?.message).toContain('targetLongEdge');
    expect((bad.error?.details as { parameters: unknown }).parameters).toBeTruthy();
    const trim = await dispatch({ id: 'b', command: 'workflow.node.tool', source: 'agent', args: { nodeId: 'vid', tool: 'video-trim', startSec: 5, endSec: 2 } });
    expect(trim.error?.code).toBe('BAD_REQUEST');
    const mask = await dispatch({ id: 'c', command: 'workflow.node.tool', source: 'agent', args: { nodeId: 'img', tool: 'mask', prompt: '换成蓝天' } });
    expect(mask.error?.code).toBe('BAD_REQUEST');
  });

  it('asks before a paid tool, then runs it with parsed arguments', async () => {
    const { dispatch, nodeToolRunner } = setup();
    const envelope = { id: 'a', command: 'workflow.node.tool', source: 'agent', args: { nodeId: 'img', tool: 'outpaint', direction: 'left', amount: 0.3 } } as const;
    const asked = await dispatch(envelope);
    expect(asked.confirmation?.required).toBe(true);
    expect(nodeToolRunner).not.toHaveBeenCalled();
    const ran = await dispatch(withWorkflowHumanApproval(envelope));
    expect(ran.ok, JSON.stringify(ran.error)).toBe(true);
    expect(nodeToolRunner).toHaveBeenCalledWith(expect.any(String), 'img', 'outpaint', { direction: 'left', amount: 0.3 }, { basis: 'human-approved', tool: 'outpaint' });
  });

  it('runs a free tool directly and checks every video-merge source', async () => {
    const { dispatch, nodeToolRunner } = setup();
    const merge = await dispatch({ id: 'a', command: 'workflow.node.tool', source: 'agent', args: { tool: 'video-merge', sourceNodeIds: ['vid', 'img'] } });
    expect(merge.error?.code).toBe('TOOL_NOT_APPLICABLE');
    const ok = await dispatch({ id: 'b', command: 'workflow.node.tool', source: 'agent', args: { tool: 'video-merge', sourceNodeIds: ['vid', 'vid2'] } });
    expect(ok.ok, JSON.stringify(ok.error)).toBe(true);
    expect(nodeToolRunner).toHaveBeenCalledWith(expect.any(String), 'vid', 'video-merge', { sourceNodeIds: ['vid', 'vid2'] }, { basis: 'free', tool: 'video-merge' });
  });
});

describe('image / video / audio tools (node_tool split by media)', () => {
  it('publishes three tools whose tool enum matches the spec families', () => {
    const families = { image: 'iris_image_tool', video: 'iris_video_tool', audio: 'iris_audio_tool' } as const;
    for (const [family, name] of Object.entries(families)) {
      const spec = getAgentToolSpecs('mcp').find((item: { name: string }) => item.name === name) as unknown as { inputSchema: { properties: Record<string, { enum?: string[] }> } };
      expect(spec, name).toBeDefined();
      expect([...spec.inputSchema.properties.tool.enum!].sort()).toEqual(workflowNodeToolSpecs().filter(item => item.inputTypes.includes(family)).map(item => item.tool).sort());
    }
    expect(getAgentToolSpecs('mcp').some((item: { name: string }) => item.name === 'iris_workflow_node_tool')).toBe(false);
    // 每个工具只带本类参数。
    const audio = getAgentToolSpecs('mcp').find((item: { name: string }) => item.name === 'iris_audio_tool') as unknown as { inputSchema: { properties: Record<string, unknown> } };
    expect(Object.keys(audio.inputSchema.properties)).not.toContain('targetLongEdge');
  });

  it('routes a family command to the same implementation and approval', async () => {
    const { dispatch, nodeToolRunner } = setup();
    const asked = await dispatch({ id: 'a', command: 'workflow.image.tool', source: 'agent', args: { nodeId: 'img', tool: 'upscale', targetLongEdge: 2048 } });
    expect(asked.confirmation?.required).toBe(true);
    expect(workflowCommandNeedsConfirmation('workflow.image.tool', { tool: 'mask' })).toBe(true);
    expect(toolApprovalFor('workflow.image.tool', { tool: 'outpaint' }).tier).toBe('exec');
    expect(toolApprovalFor('workflow.video.tool', { tool: 'video-trim' }).tier).toBe('write');
    const trim = await dispatch({ id: 'b', command: 'workflow.video.tool', source: 'agent', args: { nodeId: 'vid', tool: 'video-trim', startSec: 1, endSec: 3 } });
    expect(trim.ok, JSON.stringify(trim.error)).toBe(true);
    expect(nodeToolRunner).toHaveBeenCalledWith(expect.any(String), 'vid', 'video-trim', { startSec: 1, endSec: 3 }, { basis: 'free', tool: 'video-trim' });
  });

  it('points to the right family when a tool is called on the wrong one', async () => {
    const { dispatch, nodeToolRunner } = setup();
    const wrong = await dispatch({ id: 'a', command: 'workflow.audio.tool', source: 'agent', args: { nodeId: 'vid', tool: 'video-trim', startSec: 1, endSec: 3 } });
    expect(wrong.error?.code).toBe('BAD_REQUEST');
    expect(wrong.error?.message).toContain('iris_video_tool');
    expect(nodeToolRunner).not.toHaveBeenCalled();
  });

  it('keeps a saved node-tool policy for the split tools', () => {
    expect(isWorkflowNodeToolCommand('workflow.video.tool')).toBe(true);
    expect(resolveToolApproval({ tool: 'workflow.video.tool', decision: { tier: 'write' }, mode: 'yolo', userPolicy: { 'workflow.node.tool': 'deny' } } as never).action).toBe('deny');
  });
});
