import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { createWorkflowNode } from '../components/workflow/constants';
import { applyWorkflowDraftChangeSet } from '../components/workflow/draftAuthority';
import { InfiniteWorkflow } from '../components/workflow/InfiniteWorkflow';
import { WorkflowConfigPanel, WorkflowGenerationCapabilitiesProvider, type WorkflowSharedMedia } from '../components/workflow/WorkflowConfigPanel';
import { WorkflowMiniMap } from '../components/workflow/WorkflowMiniMap';
import { workflowMediaStorage } from '../components/workflow/storage';
import { STUDIO_MEDIA_BATCH_DRAG_TYPE } from '../components/studio/StudioMediaBrowser';
import type { WorkflowProject } from '../components/workflow/types';
import { getGenerationCapability } from '../services/generationCapabilities';
import { installWorkflowNodePlugin, uninstallWorkflowNodePlugin } from '../components/workflow/nodePluginSdk';
import { useClipboardStore } from '../stores/useClipboardStore';

const makeProject = (): WorkflowProject => ({
  id: 'project-1',
  title: 'Surface test',
  nodes: [
    createWorkflowNode('source', 'text', { x: 100, y: 100 }),
    createWorkflowNode('target', 'image', { x: 520, y: 120 }),
  ],
  connections: [],
  selectedNodeIds: [],
  viewport: { x: 0, y: 0, k: 1 },
  backgroundMode: 'dots',
  agentSessions: [],
  activeAgentSessionId: null,
  createdAt: '2026-06-18T00:00:00.000Z',
  updatedAt: '2026-06-18T00:00:00.000Z',
});

/** Notes are isolated, so connection tests need two media nodes. */
const connectionProject = (): WorkflowProject => ({
  ...makeProject(),
  nodes: [
    createWorkflowNode('source', 'image', { x: 100, y: 100 }, { href: 'data:image/png;base64,AA==', mimeType: 'image/png' }),
    createWorkflowNode('target', 'image', { x: 520, y: 120 }, { href: 'data:image/png;base64,BB==', mimeType: 'image/png' }),
  ],
});

function Harness({ initial = makeProject(), sharedMedia = [] }: { initial?: WorkflowProject; sharedMedia?: WorkflowSharedMedia[] }) {
  const [project, setProject] = useState(initial);
  return (
    <>
      <WorkflowGenerationCapabilitiesProvider sharedMedia={sharedMedia}>
        <InfiniteWorkflow
          project={project}
          updateProject={patch => setProject(current => ({ ...current, ...patch }))}
          onRunNode={() => undefined}
          onOpenAgent={() => undefined}
        />
      </WorkflowGenerationCapabilitiesProvider>
      <output data-testid="workflow-project-state" hidden>{JSON.stringify(project)}</output>
    </>
  );
}

const editor = () => screen.getByTestId('workflow-editor');
const node = (id: string) => editor().querySelector<HTMLElement>(`[data-workflow-node-id="${id}"]`)!;
const sourceHandle = () => node('source').querySelector<HTMLButtonElement>('.workflow-handle--source')!;
const resizeHandle = () => node('source').querySelector<HTMLButtonElement>('.workflow-resize')!;
const worldTransform = () => (editor().querySelector<HTMLElement>('.workflow-world')?.style.transform || '');
const projectState = (): WorkflowProject => JSON.parse(screen.getByTestId('workflow-project-state').textContent || '{}');
const projectNode = (id: string) => projectState().nodes.find(item => item.id === id)!;

describe('InfiniteWorkflow surface interactions', () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 1000,
      bottom: 700,
      width: 1000,
      height: 700,
      toJSON: () => ({}),
    });
  });

  afterEach(() => {
    // 画布剪贴板是跨项目的全局 store：每个用例后清空，避免串用例。
    useClipboardStore.getState().clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('keeps the workflow point under the cursor fixed while zooming', () => {
    render(<Harness />);

    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => frames.push(callback)));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const before = projectState().viewport;

    // 同一帧内的两次 wheel 合并为一次视口写入。
    fireEvent.wheel(editor(), { clientX: 400, clientY: 300, deltaY: -100, ctrlKey: true });
    fireEvent.wheel(editor(), { clientX: 400, clientY: 300, deltaY: -100, ctrlKey: true });
    expect(projectState().viewport).toEqual(before);
    expect(frames).toHaveLength(1);
    act(() => { frames.splice(0).forEach(callback => callback(16)); });

    const { x, y, k } = projectState().viewport;
    expect(k).toBeCloseTo(before.k * Math.exp(200 * 0.0015));
    expect((400 - x) / k).toBeCloseTo(400);
    expect((300 - y) / k).toBeCloseTo(300);
  });

  it('pans by middle-button dragging the true background', () => {
    render(<Harness />);

    fireEvent.pointerDown(editor(), { button: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(window, { clientX: 145, clientY: 128 });
    fireEvent.pointerUp(window, { clientX: 145, clientY: 128 });

    expect(worldTransform()).toContain('translate(45px, 28px)');
  });

  it('box-selects by plain left-dragging the true background', () => {
    render(<Harness />);
    const before = worldTransform();

    fireEvent.pointerDown(editor(), { button: 0, clientX: 20, clientY: 20 });
    fireEvent.pointerMove(window, { buttons: 1, clientX: 900, clientY: 500 });
    fireEvent.pointerUp(window, { clientX: 900, clientY: 500 });

    expect(worldTransform()).toBe(before);
    expect(node('source')).toHaveClass('is-selected');
    expect(node('target')).toHaveClass('is-selected');
  });

  it('supports modifier node selection and additive box selection', () => {
    render(<Harness />);

    fireEvent.pointerDown(node('source'), { button: 0, ctrlKey: true, clientX: 120, clientY: 120 });
    fireEvent.pointerUp(window, { clientX: 120, clientY: 120 });
    fireEvent.pointerDown(editor(), { button: 0, ctrlKey: true, shiftKey: true, clientX: 480, clientY: 80 });
    fireEvent.pointerMove(window, { buttons: 1, clientX: 900, clientY: 500 });
    fireEvent.pointerUp(window, { clientX: 900, clientY: 500 });

    expect(node('source')).toHaveClass('is-selected');
    expect(node('target')).toHaveClass('is-selected');
  });

  it('patches UI selection immediately and adopts later canonical selection', () => {
    let project = makeProject();
    const updateProject = vi.fn((patch: Partial<WorkflowProject>) => { project = { ...project, ...patch }; });
    const view = render(<InfiniteWorkflow project={project} updateProject={updateProject} onRunNode={() => undefined} onOpenAgent={() => undefined} />);

    fireEvent.pointerDown(node('source'), { button: 0, pointerId: 1, clientX: 120, clientY: 120 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 120, clientY: 120 });
    expect(updateProject).toHaveBeenCalledWith({ selectedNodeIds: ['source'] });

    updateProject.mockClear();
    project = { ...project, selectedNodeIds: ['target'] };
    view.rerender(<InfiniteWorkflow project={project} updateProject={updateProject} onRunNode={() => undefined} onOpenAgent={() => undefined} />);
    expect(node('source')).not.toHaveClass('is-selected');
    expect(node('target')).toHaveClass('is-selected');
    expect(screen.getByTestId('workflow-node-toolbar')).toBeInTheDocument();
    expect(screen.getByTestId('workflow-node-prompt-bar')).toBeInTheDocument();
    expect(updateProject).not.toHaveBeenCalled();
  });

  it('uses independent image and video prompts when batch-generating script shots', () => {
    const initial = makeProject();
    initial.nodes = [
      createWorkflowNode('script', 'script', { x: 100, y: 100 }, {
        scriptBreakdown: {
          assets: [],
          shots: [{
            id: 'shot-1',
            index: 0,
            scene: '雨夜街道',
            action: '人物向前奔跑',
            imagePromptOverride: 'still frame with neon reflections',
            videoPromptOverride: 'tracking shot, the runner accelerates through rain',
          }],
        },
      }),
    ];
    render(<Harness initial={initial} />);

    fireEvent.doubleClick(node('script'));
    fireEvent.click(screen.getByRole('button', { name: '批量生图' }));
    const imageNode = projectState().nodes.find(item => item.type === 'image')!;
    expect(imageNode.metadata.prompt).toBe('still frame with neon reflections');
    // 同一纯函数：提示词进 Prompt Bar 文档、挂 shot 元数据、脚本行回链并迁移旧 Override
    expect(imageNode.metadata.richTextDocument).toMatchObject({ type: 'doc' });
    expect(imageNode.shot).toMatchObject({ index: 1, scriptNodeId: 'script', scriptShotId: 'shot-1' });
    const migratedShot = projectState().nodes.find(item => item.id === 'script')!.metadata.scriptBreakdown!.shots[0];
    expect(migratedShot).toMatchObject({ imageNodeId: imageNode.id, imagePrompt: 'still frame with neon reflections' });

    fireEvent.click(screen.getByRole('button', { name: '批量生视频' }));
    expect(projectState().nodes.find(item => item.type === 'video')?.metadata.prompt).toBe('tracking shot, the runner accelerates through rain');
  }, 15_000);

  it('keeps node overlays in screen space and dismisses them with the background', () => {
    render(<Harness />);
    fireEvent.pointerDown(node('target'), { button: 0, pointerId: 1, clientX: 540, clientY: 140 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 540, clientY: 140 });
    const overlay = screen.getByTestId('workflow-node-toolbar').parentElement!;
    expect(overlay.style.transform).not.toContain('scale(');
    fireEvent.wheel(editor(), { clientX: 400, clientY: 300, deltaY: -200 });
    expect(screen.getByTestId('workflow-node-toolbar')).toBeInTheDocument();
    fireEvent.pointerDown(editor(), { button: 0, pointerId: 2, clientX: 20, clientY: 20 });
    fireEvent.pointerUp(window, { pointerId: 2, clientX: 20, clientY: 20 });
    expect(screen.queryByTestId('workflow-node-toolbar')).not.toBeInTheDocument();
  });

  it('mounts image and video overlays without a prompt attachment render loop', () => {
    const initial = makeProject();
    initial.nodes = [
      createWorkflowNode('image-media', 'image', { x: 100, y: 100 }, { href: 'data:image/png;base64,aW1hZ2U=' }),
      createWorkflowNode('video-media', 'video', { x: 520, y: 100 }, { href: 'data:video/mp4;base64,dmlkZW8=', poster: 'data:image/jpeg;base64,cG9zdGVy' }),
    ];
    render(<Harness initial={initial} />);

    fireEvent.pointerDown(node('image-media').querySelector('img')!, { button: 0, pointerId: 21, clientX: 140, clientY: 150 });
    expect(node('image-media')).toHaveClass('is-selected');
    fireEvent.pointerUp(window, { pointerId: 21, clientX: 140, clientY: 150 });
    expect(screen.getByTestId('workflow-node-toolbar')).toBeInTheDocument();
    expect(screen.getByTestId('workflow-node-prompt-bar')).toBeInTheDocument();

    expect(editor().querySelectorAll('video')).toHaveLength(0);
    fireEvent.pointerDown(node('video-media').querySelector('img')!, { button: 0, pointerId: 22, clientX: 560, clientY: 150 });
    expect(node('video-media')).toHaveClass('is-selected');
    expect(node('image-media')).not.toHaveClass('is-selected');
    expect(editor().querySelectorAll('video')).toHaveLength(0);
    // A held pointerdown on the poster arms a drag; release it before asserting
    // the overlay is back up (overlay only hides once the pointer moves).
    fireEvent.pointerUp(window, { pointerId: 22, clientX: 560, clientY: 150 });
    expect(screen.getByTestId('workflow-node-toolbar')).toBeInTheDocument();
    expect(screen.getByTestId('workflow-node-prompt-bar')).toBeInTheDocument();

    const videoFileInputClick = vi.spyOn(
      node('video-media').querySelector<HTMLInputElement>('input[type="file"]')!,
      'click',
    );
    fireEvent.doubleClick(node('video-media').querySelector('img')!);
    expect(videoFileInputClick).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '加载视频播放器' }));
    expect(editor().querySelectorAll('video')).toHaveLength(1);
    expect(editor().querySelector('video')).toHaveAttribute('preload', 'metadata');
    expect(screen.getByTestId('workflow-node-toolbar')).toBeInTheDocument();
    expect(screen.getByTestId('workflow-node-prompt-bar')).toBeInTheDocument();

    const progress = screen.getByRole('slider', { name: '视频进度' });
    progress.focus();
    fireEvent.keyDown(progress, { key: 'Escape' });
    expect(editor().querySelectorAll('video')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: '加载视频播放器' }));
    expect(editor().querySelectorAll('video')).toHaveLength(1);

    fireEvent.pointerDown(node('image-media').querySelector('img')!, { button: 0, pointerId: 23, clientX: 140, clientY: 150 });
    fireEvent.pointerUp(window, { pointerId: 23, clientX: 140, clientY: 150 });
    expect(editor().querySelectorAll('video')).toHaveLength(0);
  });

  it('contains a renderer failure to the plugin node instead of taking down the Canvas', () => {
    const pluginId = 'test.renderer-failure';
    installWorkflowNodePlugin({
      pluginId,
      type: 'plugin:renderer-failure',
      version: '1.0.0',
      title: '故障插件',
      outputs: () => [],
      render: () => { throw new Error('插件渲染失败'); },
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const initial = makeProject();
      initial.nodes = [createWorkflowNode('broken-plugin', 'plugin:renderer-failure', { x: 100, y: 100 })];
      render(<Harness initial={initial} />);

      expect(screen.getByTestId('workflow-editor')).toBeInTheDocument();
      expect(screen.getByTestId('workflow-plugin-error')).toHaveTextContent('故障插件暂时不可用');
      expect(node('broken-plugin')).toBeInTheDocument();
    } finally {
      errorSpy.mockRestore();
      uninstallWorkflowNodePlugin(pluginId);
    }
  });

  it('drags an image node by its media body', () => {
    const initial = makeProject();
    initial.nodes = [createWorkflowNode('image-media', 'image', { x: 100, y: 100 }, { href: 'data:image/png;base64,aW1hZ2U=' })];
    render(<Harness initial={initial} />);

    const image = node('image-media').querySelector<HTMLImageElement>('img')!;
    // A pointerdown on the media surface must begin a node drag, not just a
    // selection — the media body is the primary grab region, same as any
    // editor. Releasing after a move commits the new position.
    fireEvent.pointerDown(image, { button: 0, pointerId: 31, clientX: 140, clientY: 150 });
    fireEvent.pointerMove(window, { pointerId: 31, clientX: 300, clientY: 300 });
    fireEvent.pointerUp(window, { pointerId: 31, clientX: 300, clientY: 300 });

    expect(projectNode('image-media').position).toEqual({ x: 260, y: 250 });
    expect(node('image-media')).toHaveClass('is-selected');
    expect(screen.getByTestId('workflow-node-toolbar')).toBeInTheDocument();
  });

  it('keeps multiple selected video nodes on lightweight previews', () => {
    const initial = makeProject();
    initial.nodes = [
      createWorkflowNode('video-a', 'video', { x: 100, y: 100 }, { href: 'data:video/mp4;base64,YQ==', poster: 'data:image/jpeg;base64,YQ==' }),
      createWorkflowNode('video-b', 'video', { x: 520, y: 100 }, { href: 'data:video/mp4;base64,Yg==' }),
    ];
    initial.selectedNodeIds = ['video-a', 'video-b'];

    render(<Harness initial={initial} />);

    expect(node('video-a').querySelector('img')).toHaveAccessibleName('视频 视频封面');
    expect(node('video-a').querySelector('img')).toHaveAttribute('loading', 'lazy');
    expect(node('video-b').querySelector('[data-testid="workflow-video-placeholder"]')).toBeInTheDocument();
    expect(editor().querySelectorAll('video')).toHaveLength(0);
  });

  it('does not carry an active player into another project with the same node id', () => {
    const projectA = makeProject();
    projectA.nodes = [createWorkflowNode('shared-video', 'video', { x: 100, y: 100 }, {
      href: 'data:video/mp4;base64,YQ==',
      poster: 'data:image/jpeg;base64,YQ==',
    })];
    projectA.selectedNodeIds = ['shared-video'];
    const projectB = {
      ...makeProject(),
      id: 'project-2',
      nodes: [createWorkflowNode('shared-video', 'video', { x: 100, y: 100 }, {
        href: 'data:video/mp4;base64,Yg==',
        poster: 'data:image/jpeg;base64,Yg==',
      })],
      selectedNodeIds: ['shared-video'],
    };
    const view = render(<InfiniteWorkflow project={projectA} updateProject={() => undefined} onRunNode={() => undefined} onOpenAgent={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: '加载视频播放器' }));
    expect(editor().querySelectorAll('video')).toHaveLength(1);

    view.rerender(<InfiniteWorkflow project={projectB} updateProject={() => undefined} onRunNode={() => undefined} onOpenAgent={() => undefined} />);

    expect(editor().querySelectorAll('video')).toHaveLength(0);
  });

  it('drags a node inside a selected group without moving the group', () => {
    const initial = connectionProject();
    initial.nodes = initial.nodes.map(item => ({ ...item, batchId: 'group-1', batchGroupSource: 'manual' as const }));
    initial.selectedNodeIds = ['source', 'target'];
    render(<Harness initial={initial} />);

    fireEvent.pointerDown(node('source'), { button: 0, clientX: 120, clientY: 120 });
    fireEvent.pointerMove(window, { clientX: 220, clientY: 180 });
    fireEvent.pointerUp(window, { clientX: 220, clientY: 180 });

    expect(projectNode('source').position).toEqual({ x: 200, y: 160 });
    expect(projectNode('target').position).toEqual({ x: 520, y: 120 });
  });

  it('records a multi-move node drag as one undoable history entry', async () => {
    render(<Harness />);

    fireEvent.pointerDown(node('source'), { button: 0, clientX: 120, clientY: 120 });
    fireEvent.pointerMove(window, { clientX: 160, clientY: 150 });
    fireEvent.pointerMove(window, { clientX: 210, clientY: 180 });
    fireEvent.pointerUp(window, { clientX: 210, clientY: 180 });
    expect(projectNode('source').position).toEqual({ x: 190, y: 160 });

    fireEvent.click(screen.getByRole('button', { name: '撤销' }));
    await waitFor(() => expect(projectNode('source').position).toEqual({ x: 100, y: 100 }));
    expect(screen.getByRole('button', { name: '撤销' })).toBeDisabled();
  });

  it('uses the visible toolbar to undo and redo an Agent Draft ChangeSet', async () => {
    const initial = makeProject();
    const agentNode = createWorkflowNode('agent-outline', 'text', { x: 860, y: 120 }, { content: 'Agent 创建的大纲' });
    agentNode.title = 'Agent 大纲';
    const applied = applyWorkflowDraftChangeSet(initial, {
      actor: 'agent',
      intent: '创建 Agent 大纲',
      ops: [{ type: 'add_node', node: agentNode }],
    });
    if (applied.ok === false) throw new Error(applied.error.message);
    render(<Harness initial={applied.project} />);

    expect(node('agent-outline')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '撤销' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: '撤销' }));
    await waitFor(() => expect(editor().querySelector('[data-workflow-node-id="agent-outline"]')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: '重做' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: '重做' }));
    await waitFor(() => expect(node('agent-outline')).toBeInTheDocument());
  });

  it('records direct text editing in the shared Draft Authority', () => {
    render(<Harness />);

    // 空白备注不再常驻 textarea（否则拖不动节点）：单击进入编辑。
    expect(node('source').querySelector('textarea')).toBeNull();
    fireEvent.click(node('source').querySelector('.workflow-text-doc.is-empty')!);
    fireEvent.change(node('source').querySelector('textarea')!, { target: { value: '真人刚刚改过的旁白' } });

    expect(projectNode('source').metadata.content).toBe('真人刚刚改过的旁白');
    expect(projectNode('source').objectVersion).toBe(2);
    expect(projectState().draftVersion).toBe(2);
    expect(projectState().draftChangeSets).toHaveLength(1);
    expect(projectState().draftChangeSets?.[0].actor).toBe('ui');
  });

  it('keeps drag positions local and commits one revision when the pointer is released', () => {
    const frames = new Map<number, FrameRequestCallback>();
    let frameId = 0;
    const initial = makeProject();
    initial.connections = [{ id: 'connection-1', fromNodeId: 'source', toNodeId: 'target' }];
    render(<Harness initial={initial} />);
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      frames.set(++frameId, callback);
      return frameId;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => frames.delete(id)));

    const connectionPath = () => editor().querySelector<SVGPathElement>('[data-workflow-connection-id="connection-1"]')?.getAttribute('d') || '';
    const pathBefore = connectionPath();

    fireEvent.pointerDown(node('source'), { button: 0, pointerId: 7, clientX: 120, clientY: 120 });
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 160, clientY: 150 });
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 200, clientY: 180 });
    // 拖动期间不写项目存储，也不产生草稿变更集。
    expect(projectNode('source').position).toEqual({ x: 100, y: 100 });
    expect(projectState().draftChangeSets).toBeUndefined();
    expect(frames.size).toBe(1);

    // rAF 批处理只更新本地预览：渲染已跟随，但存储仍保持原值。
    act(() => frames.values().next().value?.(0));
    expect(projectNode('source').position).toEqual({ x: 100, y: 100 });
    expect(connectionPath()).not.toBe(pathBefore);

    // pointerup 先 flush 最新位置，再把最终结果作为单次变更写入项目与历史。
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 220, clientY: 190 });
    fireEvent.pointerUp(window, { pointerId: 7, clientX: 230, clientY: 200 });
    expect(projectNode('source').position).toEqual({ x: 210, y: 180 });
    expect(projectState().draftChangeSets).toHaveLength(1);
  });

  it('drags a note node from its empty body and from its document body', () => {
    render(<Harness />);

    const empty = node('source').querySelector('.workflow-text-doc.is-empty')!;
    fireEvent.pointerDown(empty, { button: 0, pointerId: 5, clientX: 120, clientY: 120 });
    fireEvent.pointerUp(window, { pointerId: 5, clientX: 150, clientY: 140 });
    expect(projectNode('source').position).toEqual({ x: 130, y: 120 });
    expect(projectState().selectedNodeIds).toEqual(['source']);
    expect(node('source').querySelector('textarea')).toBeNull();

    fireEvent.doubleClick(node('source').querySelector('.workflow-text-doc')!);
    fireEvent.change(node('source').querySelector('textarea')!, { target: { value: '# 标题\n正文' } });
    fireEvent.blur(node('source').querySelector('textarea')!);
    const doc = node('source').querySelector('.workflow-text-doc:not(.is-empty)')!;
    expect(doc).toBeTruthy();
    fireEvent.pointerDown(doc, { button: 0, pointerId: 6, clientX: 150, clientY: 140 });
    fireEvent.pointerUp(window, { pointerId: 6, clientX: 170, clientY: 150 });
    expect(projectNode('source').position).toEqual({ x: 150, y: 130 });
  });

  it('ignores move, up, and cancel events from a different pointer', () => {
    render(<Harness />);

    fireEvent.pointerDown(node('source'), { button: 0, pointerId: 3, clientX: 120, clientY: 120 });
    fireEvent.pointerMove(window, { pointerId: 4, clientX: 500, clientY: 500 });
    fireEvent.pointerUp(window, { pointerId: 4, clientX: 500, clientY: 500 });
    fireEvent.pointerCancel(window, { pointerId: 4 });
    fireEvent.pointerUp(window, { pointerId: 3, clientX: 140, clientY: 130 });

    expect(projectNode('source').position).toEqual({ x: 120, y: 110 });
  });

  it('pans from a node with the pan tool or Space without moving the node', () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole('button', { name: '切换为平移工具' }));
    fireEvent.pointerDown(node('source'), { button: 0, pointerId: 1, clientX: 120, clientY: 120 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 170, clientY: 150 });
    expect(worldTransform()).toContain('translate(50px, 30px)');
    expect(projectNode('source').position).toEqual({ x: 100, y: 100 });

    fireEvent.click(screen.getByRole('button', { name: '切换为选择工具' }));
    fireEvent.keyDown(window, { code: 'Space', key: ' ' });
    fireEvent.pointerDown(node('source'), { button: 0, pointerId: 2, clientX: 170, clientY: 150 });
    fireEvent.pointerUp(window, { pointerId: 2, clientX: 200, clientY: 170 });
    fireEvent.keyUp(window, { code: 'Space', key: ' ' });
    expect(worldTransform()).toContain('translate(80px, 50px)');
    expect(projectNode('source').position).toEqual({ x: 100, y: 100 });
  });

  it('pans from source and resize handles without connecting or resizing', () => {
    const initial = makeProject();
    initial.connections = [{ id: 'connection-1', fromNodeId: 'source', toNodeId: 'target' }];
    render(<Harness initial={initial} />);
    const connection = editor().querySelector<SVGPathElement>('[data-workflow-connection-id="connection-1"]')!;
    fireEvent.keyDown(connection, { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: '切换为平移工具' }));
    fireEvent.doubleClick(editor(), { clientX: 900, clientY: 600 });

    fireEvent.pointerDown(sourceHandle(), { button: 0, pointerId: 11, clientX: 440, clientY: 210 });
    fireEvent.pointerUp(window, { pointerId: 11, clientX: 480, clientY: 230 });
    expect(worldTransform()).toContain('translate(40px, 20px)');
    expect(screen.queryByRole('menu', { name: '新建节点' })).not.toBeInTheDocument();
    expect(editor().querySelector('.workflow-connection.is-selected')).not.toBeInTheDocument();
    expect(editor().querySelector('.workflow-connection.is-active')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '切换为选择工具' }));
    fireEvent.keyDown(window, { code: 'Space', key: ' ' });
    fireEvent.pointerDown(resizeHandle(), { button: 0, pointerId: 12, clientX: 440, clientY: 320 });
    fireEvent.pointerUp(window, { pointerId: 12, clientX: 470, clientY: 340 });
    fireEvent.keyUp(window, { code: 'Space', key: ' ' });
    expect(worldTransform()).toContain('translate(70px, 40px)');
    expect(node('source').style.width).toBe('340px');
    expect(node('source').style.height).toBe('220px');
  });

  it('records every actual node and resize delta while a click stays out of history', () => {
    render(<Harness />);

    fireEvent.pointerDown(node('source'), { button: 0, clientX: 120, clientY: 120 });
    fireEvent.pointerUp(window, { clientX: 120, clientY: 120 });
    expect(projectNode('source').position).toEqual({ x: 100, y: 100 });
    expect(screen.getByRole('button', { name: '撤销' })).toBeDisabled();

    fireEvent.pointerDown(node('source'), { button: 0, clientX: 120, clientY: 120 });
    fireEvent.pointerUp(window, { clientX: 121, clientY: 121 });
    expect(projectNode('source').position).toEqual({ x: 101, y: 101 });
    fireEvent.click(screen.getByRole('button', { name: '撤销' }));
    expect(projectNode('source').position).toEqual({ x: 100, y: 100 });

    const resize = node('source').querySelector<HTMLButtonElement>('.workflow-resize')!;
    fireEvent.pointerDown(resize, { button: 0, clientX: 440, clientY: 320 });
    fireEvent.pointerUp(window, { clientX: 441, clientY: 321 });
    expect(node('source').style.width).toBe('341px');
    fireEvent.click(screen.getByRole('button', { name: '撤销' }));
    expect(node('source').style.width).toBe('340px');
  });

  it('rolls back node, resize, and pan state when their gesture is cancelled', () => {
    render(<Harness />);

    fireEvent.pointerDown(node('source'), { button: 0, clientX: 120, clientY: 120 });
    fireEvent.pointerMove(window, { clientX: 170, clientY: 150 });
    fireEvent.pointerCancel(window);
    expect(projectNode('source').position).toEqual({ x: 100, y: 100 });

    const resize = node('source').querySelector<HTMLButtonElement>('.workflow-resize')!;
    fireEvent.pointerDown(resize, { button: 0, clientX: 440, clientY: 320 });
    fireEvent.pointerMove(window, { clientX: 500, clientY: 370 });
    fireEvent.blur(window);
    expect(node('source').style.width).toBe('340px');
    expect(node('source').style.height).toBe('220px');

    fireEvent.pointerDown(editor(), { button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(window, { clientX: 150, clientY: 130 });
    fireEvent.pointerCancel(window);
    expect(worldTransform()).toContain('translate(0px, 0px)');
    expect(screen.getByRole('button', { name: '撤销' })).toBeDisabled();

    fireEvent.pointerDown(node('source'), { button: 0, clientX: 120, clientY: 120 });
    fireEvent.pointerUp(window, { clientX: 120, clientY: 120 });
    fireEvent.pointerDown(editor(), { button: 0, ctrlKey: true, clientX: 480, clientY: 80 });
    fireEvent.pointerMove(window, { buttons: 1, clientX: 900, clientY: 500 });
    fireEvent.pointerCancel(window);
    expect(node('source')).toHaveClass('is-selected');
    expect(node('target')).not.toHaveClass('is-selected');

    fireEvent.pointerDown(sourceHandle(), { button: 0, clientX: 440, clientY: 210 });
    fireEvent.pointerMove(window, { clientX: 450, clientY: 520 });
    fireEvent.pointerCancel(window);
    expect(editor().querySelector('.workflow-connection.is-active')).not.toBeInTheDocument();
    expect(screen.queryByRole('menu', { name: '新建节点' })).not.toBeInTheDocument();
  });

  it('opens the node create menu only from a true background double-click', () => {
    render(<Harness />);

    fireEvent.doubleClick(node('source'), { clientX: 130, clientY: 130 });
    expect(screen.queryByRole('menu', { name: '新建节点' })).not.toBeInTheDocument();
    fireEvent.doubleClick(editor(), { clientX: 360, clientY: 260 });

    expect(screen.getByRole('menu', { name: '新建节点' })).toBeInTheDocument();
  });

  it('supports keyboard navigation in the create menu and renders audio nodes', async () => {
    render(<Harness />);

    fireEvent.doubleClick(editor(), { clientX: 360, clientY: 260 });
    const menu = screen.getByRole('menu', { name: '新建节点' });
    const items = screen.getAllByRole('menuitem');
    // 第一项是「问 Agent」输入框（打开即聚焦）；↓ 进入节点类型列表。
    const ask = screen.getByRole('textbox', { name: '问 Agent' });
    await waitFor(() => expect(ask).toHaveFocus());
    fireEvent.keyDown(ask, { key: 'ArrowDown' });
    expect(items[0]).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'End' });
    expect(items[items.length - 1]).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(items[0]).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(items[items.length - 1]).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'Home' });
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(items[4]).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'Enter' });
    expect(editor().querySelector('.workflow-node--audio')).toBeInTheDocument();
    expect(screen.getByText('音频节点')).toBeInTheDocument();

    fireEvent.doubleClick(editor(), { clientX: 900, clientY: 600 });
    fireEvent.keyDown(screen.getByRole('menu', { name: '新建节点' }), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu', { name: '新建节点' })).not.toBeInTheDocument(), { timeout: 5000 });
  });

  it('restores focus to the surface or source handle after closing the create menu', () => {
    render(<Harness initial={connectionProject()} />);
    expect(editor()).toHaveAttribute('tabindex', '-1');

    fireEvent.doubleClick(editor(), { clientX: 900, clientY: 600 });
    fireEvent.keyDown(screen.getByRole('menu', { name: '新建节点' }), { key: 'Escape' });
    expect(editor()).toHaveFocus();

    fireEvent.pointerDown(sourceHandle(), { button: 0, pointerId: 21, clientX: 440, clientY: 210 });
    fireEvent.pointerUp(window, { pointerId: 21, clientX: 450, clientY: 520 });
    fireEvent.click(screen.getByRole('menuitem', { name: /图片/ }));
    expect(sourceHandle()).toHaveFocus();

    fireEvent.pointerDown(sourceHandle(), { button: 0, pointerId: 22, clientX: 440, clientY: 210 });
    fireEvent.pointerUp(window, { pointerId: 22, clientX: 900, clientY: 650 });
    fireEvent.click(screen.getByRole('button', { name: '关闭新建节点' }));
    expect(sourceHandle()).toHaveFocus();
  });

  it('drags a node by its title bar (text nodes keep an editable body)', () => {
    render(<Harness />);
    const source = editor().querySelector<HTMLElement>('[data-workflow-node-id="source"]')!;
    const title = source.querySelector<HTMLElement>('.workflow-node__title')!;
    expect(projectNode('source').position).toEqual({ x: 100, y: 100 });

    fireEvent.pointerDown(title, { button: 0, pointerId: 7, clientX: 120, clientY: 80 });
    fireEvent.pointerMove(window, { buttons: 1, pointerId: 7, clientX: 220, clientY: 180 });
    fireEvent.pointerUp(window, { pointerId: 7, clientX: 220, clientY: 180 });

    expect(projectNode('source').position).toEqual({ x: 200, y: 200 });
  });

  it('opens the same create menu when a source connection is dropped on blank space and can cancel it', async () => {
    render(<Harness />);

    fireEvent.pointerDown(sourceHandle(), { button: 0, clientX: 440, clientY: 210 });
    fireEvent.pointerMove(window, { clientX: 450, clientY: 520 });
    fireEvent.pointerUp(window, { clientX: 450, clientY: 520 });

    expect(screen.getByRole('menu', { name: '新建节点' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '关闭新建节点' }));
    await waitFor(() => expect(screen.queryByRole('menu', { name: '新建节点' })).not.toBeInTheDocument());
  });

  it('connects to a legal existing node instead of opening the create menu', () => {
    render(<Harness initial={connectionProject()} />);

    fireEvent.pointerDown(sourceHandle(), { button: 0, clientX: 440, clientY: 210 });
    fireEvent.pointerMove(window, { clientX: 540, clientY: 180 });
    fireEvent.pointerUp(window, { clientX: 540, clientY: 180 });

    expect(editor().querySelectorAll('[data-workflow-connection-id]')).toHaveLength(1);
    expect(screen.queryByRole('menu', { name: '新建节点' })).not.toBeInTheDocument();
  });

  it('makes the wide connection hit path keyboard selectable', () => {
    const initial = connectionProject();
    initial.connections = [{ id: 'connection-1', fromNodeId: 'source', toNodeId: 'target' }];
    render(<Harness initial={initial} />);
    const path = editor().querySelector<SVGPathElement>('[data-workflow-connection-id="connection-1"]')!;

    expect(path).toHaveAttribute('tabindex', '0');
    expect(path).toHaveAccessibleName('选择连接：图片 到 图片');
    expect(screen.getByRole('group', { name: '工作流连接' })).not.toHaveAttribute('aria-hidden');
    fireEvent.keyDown(path, { key: ' ' });
    expect(editor().querySelector('.workflow-connection.is-selected')).toBeInTheDocument();
    fireEvent.pointerDown(node('source'), { button: 0, pointerId: 9, clientX: 120, clientY: 120 });
    fireEvent.pointerUp(window, { pointerId: 9, clientX: 120, clientY: 120 });
    fireEvent.keyDown(path, { key: 'Enter' });
    expect(editor().querySelector('.workflow-connection.is-selected')).toBeInTheDocument();
  });

  it('creates and connects a selected menu node atomically', () => {
    render(<Harness initial={connectionProject()} />);

    fireEvent.pointerDown(sourceHandle(), { button: 0, clientX: 440, clientY: 210 });
    fireEvent.pointerUp(window, { clientX: 450, clientY: 520 });
    fireEvent.click(screen.getByRole('menuitem', { name: /图片/ }));

    expect(editor().querySelectorAll('[data-workflow-node-id]')).toHaveLength(3);
    expect(editor().querySelectorAll('[data-workflow-connection-id]')).toHaveLength(1);
    expect(editor().querySelectorAll('[data-workflow-node-id].is-selected')).toHaveLength(1);
  });

  it('cancels an invalid nearby connection and exposes the rejection reason', () => {
    render(<Harness />);

    fireEvent.pointerDown(sourceHandle(), { button: 0, clientX: 440, clientY: 210 });
    fireEvent.pointerUp(window, { clientX: 120, clientY: 140 });

    expect(screen.getByRole('status')).toHaveTextContent('不能连接节点自身');
    expect(screen.queryByRole('menu', { name: '新建节点' })).not.toBeInTheDocument();
    expect(editor().querySelectorAll('[data-workflow-connection-id]')).toHaveLength(0);
  });

  it('deletes selected nodes from the keyboard and supports undo and redo', async () => {
    render(<Harness />);

    fireEvent.pointerDown(node('source'), { button: 0, clientX: 120, clientY: 120 });
    fireEvent.pointerUp(window, { clientX: 120, clientY: 120 });
    fireEvent.keyDown(window, { key: 'Delete' });
    expect(projectState().nodes.some(item => item.id === 'source')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: '撤销' }));
    await waitFor(() => expect(projectState().nodes.some(item => item.id === 'source')).toBe(true));
    await waitFor(() => expect(screen.getByRole('button', { name: '重做' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '重做' }));
    await waitFor(() => expect(projectState().nodes.some(item => item.id === 'source')).toBe(false));
  });

  it('maps a wide minimap node center and letterbox edge to content bounds', () => {
    const project = makeProject();
    const onCenter = vi.fn();
    render(<WorkflowMiniMap nodes={project.nodes} viewport={project.viewport} onCenter={onCenter} />);
    const minimap = screen.getByRole('button', { name: '工作流小地图' });
    vi.spyOn(minimap, 'getBoundingClientRect').mockReturnValue({
      x: 200,
      y: 100,
      left: 200,
      top: 100,
      right: 366,
      bottom: 212,
      width: 166,
      height: 112,
      toJSON: () => ({}),
    });
    const target = minimap.querySelector<HTMLElement>('.workflow-minimap__node--image')!;
    fireEvent.click(minimap, {
      clientX: 200 + parseFloat(target.style.left) + parseFloat(target.style.width) / 2,
      clientY: 100 + parseFloat(target.style.top) + parseFloat(target.style.height) / 2,
    });

    const [x, y] = onCenter.mock.calls[0];
    expect(x).toBeCloseTo(690);
    expect(y).toBeCloseTo(240);

    fireEvent.click(minimap, { clientX: 200 + 75, clientY: 100 });
    expect(onCenter.mock.calls[1][1]).toBeCloseTo(100);
  });

  it('centers tall minimap content and clamps horizontal letterbox clicks', () => {
    const nodes = [
      createWorkflowNode('top', 'text', { x: 50, y: 0 }),
      createWorkflowNode('bottom', 'image', { x: 50, y: 2000 }),
    ];
    const onCenter = vi.fn();
    render(<WorkflowMiniMap nodes={nodes} viewport={{ x: 0, y: 0, k: 1 }} onCenter={onCenter} />);
    const minimap = screen.getByRole('button', { name: '工作流小地图' });
    vi.spyOn(minimap, 'getBoundingClientRect').mockReturnValue({
      x: 200, y: 100, left: 200, top: 100, right: 366, bottom: 212, width: 166, height: 112, toJSON: () => ({}),
    });

    fireEvent.click(minimap, { clientX: 200, clientY: 148 });
    expect(onCenter.mock.calls[0][0]).toBeCloseTo(50);
  });

  it('defines audio as a valid but unsupported generation capability', () => {
    expect(getGenerationCapability([], 'audio')).toEqual({
      mode: 'audio',
      models: [],
      aspectRatios: [],
      resolutions: [],
      durations: [],
      supportsReferences: [],
    });
  });

  it('keeps audio mode visible in config while disabling unsupported generation', () => {
    const config = createWorkflowNode('audio-config', 'config', { x: 0, y: 0 }, { config: { mode: 'audio' } });
    const onRun = vi.fn();
    render(<WorkflowConfigPanel node={config} onChange={() => undefined} onRun={onRun} />);

    expect(screen.getAllByRole('combobox')[0]).toHaveValue('audio');
    expect(screen.getByText('音频生成暂未支持')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '暂不支持' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '暂不支持' }));
    expect(onRun).not.toHaveBeenCalled();
  });

  it('uses durable ingestion for a world-positioned file drop', async () => {
    class TestImage {
      naturalWidth = 1600;
      naturalHeight = 900;
      onload: null | (() => void) = null;
      onerror: null | (() => void) = null;
      set src(_value: string) { queueMicrotask(() => this.onload?.()); }
    }
    vi.stubGlobal('Image', TestImage);
    const persist = vi.spyOn(workflowMediaStorage, 'set');
    render(<Harness />);
    const file = new File(['image'], 'drop.png');

    fireEvent.dragOver(editor());
    fireEvent.drop(editor(), { clientX: 500, clientY: 350, dataTransfer: { files: [file] } });
    await waitFor(() => expect(editor().querySelectorAll('[data-workflow-node-id]')).toHaveLength(3));
    // Drops add an "uploading" placeholder first (6dd3b43); assert on the committed media node.
    await waitFor(() => expect(projectNode(projectState().selectedNodeIds[0]).metadata.uploading).toBe(false));
    const dropped = editor().querySelector<HTMLElement>('.workflow-node--image.is-selected')!;
    expect(projectNode(projectState().selectedNodeIds[0]).position).toEqual({ x: 290, y: 232 });
    expect(dropped.style.width).toBe('420px');
    expect(dropped.style.height).toBe('236px');

    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('imports every media file from a multi-file drop and reports skipped files', async () => {
    class TestImage {
      naturalWidth = 1600;
      naturalHeight = 900;
      onload: null | (() => void) = null;
      onerror: null | (() => void) = null;
      set src(_value: string) { queueMicrotask(() => this.onload?.()); }
    }
    vi.stubGlobal('Image', TestImage);
    const persist = vi.spyOn(workflowMediaStorage, 'set');
    render(<Harness />);
    const before = projectState().nodes.map(node => node.id);
    const files = [
      new File(['image-a'], 'a.png', { type: 'image/png' }),
      new File(['pdf'], 'notes.pdf', { type: 'application/pdf' }),
      new File(['image-b'], 'b.png', { type: 'image/png' }),
    ];

    fireEvent.dragOver(editor());
    fireEvent.drop(editor(), { clientX: 500, clientY: 350, dataTransfer: { files } });
    await waitFor(() => expect(editor().querySelectorAll('[data-workflow-node-id]')).toHaveLength(before.length + 2));
    expect(await screen.findByRole('status')).toHaveTextContent('已导入 2 个媒体文件，跳过 1 个不支持的文件');

    const added = projectState().nodes.filter(node => !before.includes(node.id));
    expect(added).toHaveLength(2);
    expect(added.every(node => node.type === 'image')).toBe(true);
    expect(added[1].position.x - added[0].position.x).toBe(380);
    expect(added[1].position.y).toBe(added[0].position.y);
    expect(persist).toHaveBeenCalledTimes(2);
  });

  it('drops a right-panel media card at the pointer instead of the viewport center', async () => {
    render(<Harness />);
    const media = {
      id: 'asset:hero',
      source: 'asset',
      sourceId: 'hero',
      name: '主图',
      href: 'https://example.com/hero.png',
      mimeType: 'image/png',
      type: 'image',
      width: 320,
      height: 180,
    };

    fireEvent.drop(editor(), {
      clientX: 500,
      clientY: 350,
      dataTransfer: {
        files: [],
        items: [],
        getData: (type: string) => type === 'application/x-flovart-studio-media' ? JSON.stringify(media) : '',
      },
    });

    await waitFor(() => expect(editor().querySelectorAll('[data-workflow-node-id]')).toHaveLength(3));
    const dropped = editor().querySelector<HTMLElement>('.workflow-node--image.is-selected')!;
    expect(projectNode(projectState().selectedNodeIds[0]).position).toEqual({ x: 290, y: 232 });
  });

  it('imports every item from a multi-select shared-media drop', async () => {
    render(<Harness />);
    const before = projectState().nodes.map(node => node.id);
    const items = ['a', 'b', 'c'].map(name => ({
      id: 'asset:' + name,
      source: 'asset' as const,
      sourceId: name,
      name,
      href: 'https://example.com/' + name + '.png',
      mimeType: 'image/png',
      type: 'image' as const,
      width: 320,
      height: 180,
    }));

    fireEvent.drop(editor(), {
      clientX: 500,
      clientY: 350,
      dataTransfer: {
        files: [],
        items: [],
        getData: (type: string) => type === STUDIO_MEDIA_BATCH_DRAG_TYPE ? JSON.stringify(items) : '',
      },
    });

    await waitFor(() => expect(editor().querySelectorAll('[data-workflow-node-id]')).toHaveLength(before.length + 3));
    const added = projectState().nodes.filter(node => !before.includes(node.id));
    expect(added.map(node => node.metadata.href)).toEqual(items.map(item => item.href));
    expect(added[1].position.x - added[0].position.x).toBe(380);
    expect(added[2].position.x - added[0].position.x).toBe(760);
  });

  it('discards an import that completes after switching projects', async () => {
    class TestImage {
      naturalWidth = 800;
      naturalHeight = 600;
      onload: null | (() => void) = null;
      onerror: null | (() => void) = null;
      set src(_value: string) { queueMicrotask(() => this.onload?.()); }
    }
    vi.stubGlobal('Image', TestImage);
    let finishWrite: (() => void) | undefined;
    vi.spyOn(workflowMediaStorage, 'set').mockImplementation(() => new Promise<void>(resolve => { finishWrite = resolve; }));
    const remove = vi.spyOn(workflowMediaStorage, 'remove');
    const updateA = vi.fn();
    const updateB = vi.fn();
    const projectA = makeProject();
    const projectB = { ...makeProject(), id: 'project-2', nodes: [] };
    const view = render(<InfiniteWorkflow project={projectA} updateProject={updateA} onRunNode={() => undefined} onOpenAgent={() => undefined} />);

    fireEvent.drop(editor(), { clientX: 500, clientY: 350, dataTransfer: { files: [new File(['image'], 'late.png', { type: 'image/png' })] } });
    await waitFor(() => expect(finishWrite).toBeTypeOf('function'));
    view.rerender(<InfiniteWorkflow project={projectB} updateProject={updateB} onRunNode={() => undefined} onOpenAgent={() => undefined} />);
    finishWrite?.();

    await waitFor(() => expect(remove).toHaveBeenCalled());
    // The "uploading" placeholder is written to project A at drop time by design; the late
    // ingest result (its storageKey) must never be committed to either project.
    expect(updateA.mock.calls.every(([next]) => !JSON.stringify(next).includes('storageKey'))).toBe(true);
    expect(updateB).not.toHaveBeenCalled();
    await waitFor(() => expect(editor().querySelectorAll('[data-workflow-node-id]')).toHaveLength(0));
  });

  it('rejects unsupported drops with the existing visible status notice', async () => {
    render(<Harness />);
    fireEvent.drop(editor(), {
      clientX: 500,
      clientY: 350,
      dataTransfer: { files: [new File(['pdf'], 'notes.pdf', { type: 'application/pdf' })] },
    });
    expect(await screen.findByRole('status')).toHaveTextContent('仅支持图片、视频或音频文件');
  });

  it('shows a recoverable shell for missing durable media', async () => {
    const initial = makeProject();
    initial.nodes[1] = { ...initial.nodes[1], metadata: { storageKey: 'missing-media', mimeType: 'image/png' } };
    render(<Harness initial={initial} />);

    expect(await screen.findByText('媒体文件不存在，请重新选择文件')).toBeInTheDocument();
    const swap = node('target').querySelector<HTMLButtonElement>('[aria-label="替换素材"]')!;
    expect(swap).toBeInTheDocument();
    expect(swap).not.toHaveAttribute('aria-haspopup');
  });

  it('replaces media without moving its center and preserves the old Blob for undo', async () => {
    const initial = makeProject();
    const oldBlob = new Blob(['old-image'], { type: 'image/png' });
    await workflowMediaStorage.set('old-media', oldBlob);
    initial.nodes[1] = {
      ...initial.nodes[1],
      metadata: { storageKey: 'old-media', mimeType: 'image/png', naturalWidth: 1600, naturalHeight: 900 },
    };
    initial.selectedNodeIds = ['target'];
    initial.connections = [{ id: 'media-connection', fromNodeId: 'source', toNodeId: 'target' }];
    class TestImage {
      naturalWidth = 800;
      naturalHeight = 600;
      onload: null | (() => void) = null;
      onerror: null | (() => void) = null;
      set src(_value: string) { queueMicrotask(() => this.onload?.()); }
    }
    vi.stubGlobal('Image', TestImage);
    render(<Harness initial={initial} />);

    await waitFor(() => expect(node('target').querySelector('img')).toBeInTheDocument());
    const input = node('target').querySelector<HTMLInputElement>('input[accept="image/*"]')!;
    fireEvent.change(input, { target: { files: [new File(['new-image'], 'replacement.png', { type: 'image/png' })] } });

    await waitFor(() => expect(projectNode('target').metadata.storageKey).not.toBe('old-media'));
    expect(projectNode('target').position).toEqual({ x: 480, y: 82.5 });
    expect(node('target').style.width).toBe('420px');
    expect(node('target').style.height).toBe('315px');
    expect(node('target')).toHaveClass('is-selected');
    expect(editor().querySelector('[data-workflow-connection-id="media-connection"]')).toBeInTheDocument();

    fireEvent.pointerDown(editor(), { button: 0, clientX: 20, clientY: 20 });
    fireEvent.pointerUp(window, { clientX: 20, clientY: 20 });
    fireEvent.click(screen.getByRole('button', { name: '撤销' }));
    await waitFor(() => expect(projectNode('target').metadata.storageKey).toBe('old-media'));
    const restoredBlob = await workflowMediaStorage.get('old-media');
    expect(restoredBlob).not.toBeNull();
    expect(editor().querySelector('[data-workflow-connection-id="media-connection"]')).toBeInTheDocument();
  });

  it('keeps only the latest concurrent replacement and uses the node center after movement', async () => {
    class TestImage {
      naturalWidth = 800;
      naturalHeight = 600;
      onload: null | (() => void) = null;
      onerror: null | (() => void) = null;
      set src(_value: string) { queueMicrotask(() => this.onload?.()); }
    }
    vi.stubGlobal('Image', TestImage);
    const writes: Array<{ resolve: () => void }> = [];
    vi.spyOn(workflowMediaStorage, 'set').mockImplementation(() => new Promise<void>(resolve => writes.push({ resolve })));
    const remove = vi.spyOn(workflowMediaStorage, 'remove');
    render(<Harness />);
    const input = node('target').querySelector<HTMLInputElement>('input[accept="image/*"]')!;

    fireEvent.change(input, { target: { files: [new File(['first'], 'first.png', { type: 'image/png' })] } });
    fireEvent.change(input, { target: { files: [new File(['second'], 'second.png', { type: 'image/png' })] } });
    await waitFor(() => expect(writes).toHaveLength(2));
    fireEvent.pointerDown(editor(), { button: 0, clientX: 20, clientY: 20 });
    fireEvent.pointerUp(window, { clientX: 20, clientY: 20 });
    fireEvent.pointerDown(node('target'), { button: 0, clientX: 540, clientY: 140 });
    fireEvent.pointerUp(window, { clientX: 640, clientY: 190 });

    writes[1].resolve();
    await waitFor(() => expect(screen.getByTestId('workflow-project-state')).toHaveTextContent('second.png'));
    expect(projectNode('target').position).toEqual({ x: 580, y: 132.5 });
    writes[0].resolve();
    await waitFor(() => expect(remove).toHaveBeenCalled());
    expect(screen.getByTestId('workflow-project-state')).not.toHaveTextContent('first.png');
    expect(screen.getByTestId('workflow-project-state')).toHaveTextContent('second.png');
  });

  it('persists data and blob history media without temporary hrefs in project JSON', async () => {
    class TestImage {
      naturalWidth = 800;
      naturalHeight = 600;
      onload: null | (() => void) = null;
      onerror: null | (() => void) = null;
      set src(_value: string) { queueMicrotask(() => this.onload?.()); }
    }
    vi.stubGlobal('Image', TestImage);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => new Blob(['shared'], { type: 'image/png' }) })));
    const sharedMedia: WorkflowSharedMedia[] = [
      { id: 'data', name: 'data.png', href: 'data:image/png;base64,c2hhcmVk', mimeType: 'image/png', type: 'image' },
      { id: 'blob', name: 'blob.png', href: 'blob:shared-media', mimeType: 'image/png', type: 'image' },
    ];
    render(<Harness sharedMedia={sharedMedia} />);

    fireEvent.click(screen.getByRole('button', { name: '历史生成' }));
    fireEvent.click(screen.getByRole('button', { name: 'data.png' }));
    await waitFor(() => expect(editor().querySelectorAll('[data-workflow-node-id]')).toHaveLength(3));
    fireEvent.click(screen.getByRole('button', { name: '历史生成' }));
    fireEvent.click(screen.getByRole('button', { name: 'blob.png' }));
    await waitFor(() => expect(editor().querySelectorAll('[data-workflow-node-id]')).toHaveLength(4));
    // Shared media now land as "uploading" placeholders first; both must commit a durable storageKey.
    await waitFor(() => expect((screen.getByTestId('workflow-project-state').textContent || '').split('"storageKey"').length - 1).toBe(2), { timeout: 5000 });

    const json = screen.getByTestId('workflow-project-state').textContent || '';
    expect(json).toContain('storageKey');
    expect(json).not.toContain('data:image');
    expect(json).not.toContain('blob:shared-media');
  });

  it('keeps the natural ratio while resizing image and video nodes by default', () => {
    const initial = makeProject();
    initial.nodes = [
      { ...createWorkflowNode('image-ratio', 'image', { x: 100, y: 100 }, { naturalWidth: 1600, naturalHeight: 900 }), width: 400, height: 225 },
      { ...createWorkflowNode('video-ratio', 'video', { x: 600, y: 100 }, { naturalWidth: 1080, naturalHeight: 1920 }), width: 180, height: 320 },
    ];
    render(<Harness initial={initial} />);

    const imageNode = node('image-ratio');
    fireEvent.pointerDown(imageNode.querySelector('.workflow-resize')!, { button: 0, clientX: 500, clientY: 325 });
    fireEvent.pointerUp(window, { clientX: 600, clientY: 425 });
    expect(Number.parseFloat(imageNode.style.width) / Number.parseFloat(imageNode.style.height)).toBeCloseTo(16 / 9, 2);

    const videoNode = node('video-ratio');
    fireEvent.pointerDown(videoNode.querySelector('.workflow-resize')!, { button: 0, clientX: 780, clientY: 420 });
    fireEvent.pointerUp(window, { clientX: 880, clientY: 520 });
    expect(Number.parseFloat(videoNode.style.width) / Number.parseFloat(videoNode.style.height)).toBeCloseTo(1080 / 1920, 2);
  });

  it('prefers the internal node clipboard, then imports external image and text clipboard items', async () => {
    class TestImage {
      naturalWidth = 800;
      naturalHeight = 600;
      onload: null | (() => void) = null;
      onerror: null | (() => void) = null;
      set src(_value: string) { queueMicrotask(() => this.onload?.()); }
    }
    vi.stubGlobal('Image', TestImage);
    const read = vi.fn();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { read } });
    render(<Harness />);

    fireEvent.pointerDown(node('source'), { button: 0, clientX: 120, clientY: 120 });
    fireEvent.pointerUp(window, { clientX: 120, clientY: 120 });
    fireEvent.keyDown(window, { key: 'c', ctrlKey: true });
    fireEvent.pointerDown(editor(), { button: 0, clientX: 20, clientY: 20 });
    fireEvent.pointerUp(window, { clientX: 20, clientY: 20 });
    fireEvent.keyDown(window, { key: 'v', ctrlKey: true });
    expect(read).not.toHaveBeenCalled();
    expect(editor().querySelectorAll('[data-workflow-node-id]')).toHaveLength(3);

    fireEvent.pointerDown(editor(), { button: 0, clientX: 20, clientY: 20 });
    fireEvent.pointerUp(window, { clientX: 20, clientY: 20 });
    fireEvent.keyDown(window, { key: 'c', ctrlKey: true });
    read.mockResolvedValueOnce([{ types: ['image/png'], getType: () => Promise.resolve(new Blob(['image'], { type: 'image/png' })) }]);
    fireEvent.keyDown(window, { key: 'v', ctrlKey: true });
    await waitFor(() => expect(editor().querySelectorAll('[data-workflow-node-id]')).toHaveLength(4));

    read.mockResolvedValueOnce([{ types: ['text/plain'], getType: () => Promise.resolve(new Blob(['剪贴板文本'], { type: 'text/plain' })) }]);
    fireEvent.keyDown(window, { key: 'v', ctrlKey: true });
    await waitFor(() => expect(screen.getByTestId('workflow-project-state')).toHaveTextContent('剪贴板文本'));
  });
});
