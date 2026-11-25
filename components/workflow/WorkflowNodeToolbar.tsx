import { AlignCenter, AlignLeft, AlignRight, ArrowDownToLine, ArrowUpToLine, AudioLines, ChevronsDown, ChevronsUp, Copy, CornerDownRight, Crop, Download, Eraser, Expand, FilePenLine, Frame, Grid2x2, Group, Layers, Layers3, Library, Maximize2, MessageSquareText, Play, RefreshCw, RotateCw, ScanLine, ScanText, Scissors, SlidersHorizontal, Square, Trash2, Ungroup, ZoomIn, Gauge, PenTool } from 'lucide-react';
import { AlignHorizontalSpaceAround, AlignVerticalSpaceAround, Bot, Box, Camera, Focus, LayoutGrid, Mic, Mountain, Music, Sparkles, StretchHorizontal, StretchVertical, Space, UserRound } from 'lucide-react';
import { sequencedFileNames, type WorkflowAlignment, type WorkflowArrangeLayout, type WorkflowDistributeAxis } from './arrange';
import { useRef, useState } from 'react';
import { MessageSquarePlus, MoreHorizontal } from 'lucide-react';
import { saveMediaUrl } from '../../services/desktopNetwork';
import { WorkflowToolbarActions, WorkflowToolbarMenu, WorkflowToolbarShell, type WorkflowToolbarAction } from './WorkflowToolbarPrimitives';
import { useWorkflowMediaUrl } from './media';
import { WORKFLOW_NODE_TOOL_LABELS } from './nodeToolCatalog';
import type { WorkflowNode } from './types';
import { WORKFLOW_TEXT_ASSET_KINDS, canGenerateTextAssets, type WorkflowTextAssetKind } from './textAssets';


type Alignment = WorkflowAlignment;

export interface WorkflowImageToolHandlers {
  crop?: (id: string) => void;
  filter?: (id: string) => void;
  upscale?: (id: string) => void;
  removeBackground?: (id: string) => void;
  outpaint?: (id: string) => void;
  mask?: (id: string) => void;
  splitLayers?: (id: string) => void;
  rotate?: (id: string) => void;
  splitGrid?: (id: string) => void;
  vectorize?: (id: string) => void;
  layer?: (id: string) => void;
  storyboard?: (ids: string[]) => void;
}

export type WorkflowAvSplitAudio = 'full' | 'vocals' | 'background';

export interface WorkflowVideoToolHandlers {
  trim?: (id: string) => void;
  avSplit?: (id: string, audio?: WorkflowAvSplitAudio) => void;
  merge?: (ids: string[]) => void;
  extractFrame?: (id: string, position: 'first' | 'current' | 'last', currentTimeSec?: number) => void;
  extractFrameAt?: (id: string) => void;
}

export interface WorkflowAudioToolHandlers {
  trim?: (id: string) => void;
  speed?: (id: string) => void;
  pitch?: (id: string) => void;
  stemSplit?: (id: string) => void;
}

// LibTV 式：常用媒体工具直接带文字露出，其余收进「更多」。
const PRIMARY_KEYS = new Set(['discuss-agent', 'stop', 'run', 'copy', 'group', 'execute-group', 'ungroup', 'add-to-agent', 'export-selection', 'delete', 'upscale', 'remove-background', 'split', 'reverse-prompt', 'video-trim', 'video-merge']);
const ARRANGE_GAPS = [0, 16, 24, 48, 96] as const;
// LibTV 式：下载 / 放大预览放在工具条最右侧，只显示图标。
const ICON_KEYS = new Set(['download', 'preview']);
const TEXT_ASSET_ICONS: Record<WorkflowTextAssetKind, typeof Box> = { character: UserRound, scene: Mountain, prop: Box };
const TOOL_LABELS_EN: Record<string, string> = {
  crop: 'Crop', upscale: 'Upscale', 'remove-background': 'Remove background', 'split-layers': 'Split layers', rotate: 'Rotate / flip',
  'split-grid': 'Split grid', 'video-trim': 'Trim video', 'video-merge': 'Merge videos', 'audio-trim': 'Trim audio', 'audio-speed': 'Audio speed', 'audio-stem-split': 'Split stems',
};

export function WorkflowNodeToolbar({ nodes, onCopy, onDelete, onExport, onRun, onStop, onPromptFocus, onSaveMedia, onReversePrompt, onReplaceMedia, onToggleFreeResize, onAlign, onDistribute, onLayer, onGroup, onUngroup, onExecuteGroup, onArrange, onSequencedExport, onDiscussWithAgent, onAddToAgent, onGenerateAsset, onMergeNotePrompt, toolHints, onPreviewMedia, onFrameSelection, imageTools, imageToolBusy = false, videoTools, videoToolBusy = false, audioTools, audioToolBusy = false, language = 'zho' }: {
  nodes: WorkflowNode[];
  onCopy: (ids: string[]) => void;
  onDelete: (ids: string[]) => void;
  onExport?: (nodes: WorkflowNode[]) => void;
  onRun?: (id: string) => void;
  onStop?: (id: string) => void;
  onPromptFocus?: (id: string) => void;
  onSaveMedia?: (id: string) => void;
  onReversePrompt?: (id: string, mediaUrl: string) => void;
  onReplaceMedia?: (id: string, file: File) => void;
  onToggleFreeResize?: (id: string) => void;
  onAlign?: (alignment: Alignment) => void;
  onDistribute?: (direction: WorkflowDistributeAxis) => void;
  onLayer?: (position: 'front' | 'back') => void;
  onGroup?: (ids: string[]) => void;
  onUngroup?: (ids: string[]) => void;
  onExecuteGroup?: (ids: string[]) => void;
  /** 打组排列：网格 / 一行 / 一列，按阅读顺序，锁定节点不动。 */
  onArrange?: (ids: string[], layout: WorkflowArrangeLayout, gap: number) => void;
  /** 按排列顺序批量下载，文件名 prefix_01、prefix_02… */
  onSequencedExport?: (ids: string[], prefix: string) => void;
  /** 选区旁放一张 Agent 会话卡，选中素材绑定为这一轮的引用。 */
  onDiscussWithAgent?: (ids: string[]) => void;
  onAddToAgent?: (ids: string[]) => void;
  /** 文本节点「生成资产」：派生一个连好线的图片生成节点（不自动运行）。 */
  onGenerateAsset?: (id: string, kind: WorkflowTextAssetKind) => void;
  /** 旧文本提示词节点迁移后，把备注内容一次性并入下游节点 prompt。 */
  onMergeNotePrompt?: (id: string) => void;
  /** Readiness reasons keyed by toolbar action; disabled actions expose the hint. */
  toolHints?: Partial<Record<'reverse-prompt' | 'split' | 'upscale' | 'remove-background' | 'splitGrid' | 'outpaint' | 'mask' | 'vectorize' | 'annotate' | 'relight' | 'restyle' | 'move-object' | 'layer', string>>;
  onPreviewMedia?: (id: string) => void;
  /** 聚焦选中节点（Frame Selection，快捷键 F）。 */
  onFrameSelection?: () => void;
  // 设计元素：多选形状做布尔运算；画板按自动布局排列内部节点。
  imageTools?: WorkflowImageToolHandlers;
  imageToolBusy?: boolean;
  videoTools?: WorkflowVideoToolHandlers;
  videoToolBusy?: boolean;
  audioTools?: WorkflowAudioToolHandlers;
  audioToolBusy?: boolean;
  language?: 'en' | 'zho';
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [arrangeGap, setArrangeGap] = useState<number>(24);
  const [namingOpen, setNamingOpen] = useState(false);
  const [namePrefix, setNamePrefix] = useState('');
  // Hook 必须在任何提前 return 之前无条件调用；nodes 为空时入参为 undefined。
  const node = nodes.length === 1 ? nodes[0] : null;
  const media = node && (node.type === 'image' || node.type === 'video' || node.type === 'audio') ? node : null;
  const mediaUrl = useWorkflowMediaUrl(media?.metadata.storageKey, media?.metadata.href, media?.metadata.artifactRef).url;
  // 有媒体来源就显示媒体工具；mediaUrl 仍在解析（大文件/远端）时置灰，避免工具栏只剩「复制节点」。
  const hasMediaSource = Boolean(media && (media.metadata.storageKey || media.metadata.href || media.metadata.artifactRef?.taskId));
  const mediaPending = hasMediaSource && !mediaUrl;
  if (!nodes.length) return null;
  const ids = nodes.map(node => node.id);
  const selectedMedia = nodes.filter(item => item.type === 'image' || item.type === 'video' || item.type === 'audio');
  const advancedToolBusy = imageToolBusy || node?.metadata.status === 'loading';
  const en = language === 'en';
  const L = (zh: string, enText: string) => (en ? enText : zh);
  const toolLabel = (key: keyof typeof WORKFLOW_NODE_TOOL_LABELS) => (en ? TOOL_LABELS_EN[key] || WORKFLOW_NODE_TOOL_LABELS[key] : WORKFLOW_NODE_TOOL_LABELS[key]);
  const actions: Array<WorkflowToolbarAction | null | false | undefined> = [
    onFrameSelection && { key: 'frame-selection', label: L('聚焦选中 (F)', 'Frame selection (F)'), icon: <Focus size={18} />, onClick: () => onFrameSelection() },
    onDiscussWithAgent && nodes.some(item => item.type !== 'plugin:agent-session') && { key: 'discuss-agent', label: L('与 Agent 讨论', 'Discuss with Agent'), icon: <MessageSquarePlus size={18} />, onClick: () => onDiscussWithAgent(ids) },
    { key: 'copy', label: L('复制节点', 'Copy node'), icon: <Copy size={18} />, onClick: () => onCopy(ids) },
    nodes.length > 1 && onGroup && { key: 'group', label: L('打组 (Ctrl+G)', 'Group (Ctrl+G)'), icon: <Group size={18} />, onClick: () => onGroup(ids) },
    nodes.length > 1 && onExecuteGroup && { key: 'execute-group', label: L('整组执行', 'Run group'), icon: <Play size={18} />, onClick: () => onExecuteGroup(ids) },
    onUngroup && nodes.some(n => (nodes.length > 1 && n.batchId) || (n.type === 'subgraph' && n.metadata.groupKind === 'group')) && { key: 'ungroup', label: L('取消打组', 'Ungroup'), icon: <Ungroup size={18} />, onClick: () => onUngroup(ids) },
    nodes.length > 1 && selectedMedia.length > 0 && onExport && { key: 'export-selection', label: L('批量导出所选媒体', 'Export selected media'), icon: <Download size={18} />, onClick: () => onExport(nodes) },
    (nodes.length > 1 || Boolean(node)) && onAddToAgent && nodes.some(item => item.type !== 'plugin:agent-session') && { key: 'add-to-agent', label: nodes.length > 1 ? L('添加到 Agent', 'Add to Agent') : L('加入 Agent 上下文', 'Add to Agent context'), icon: <Bot size={18} />, onClick: () => onAddToAgent(ids) },
    nodes.length > 1 && onArrange && { key: 'arrange-grid', label: L('网格排列', 'Arrange in grid'), icon: <LayoutGrid size={18} />, onClick: () => onArrange(ids, 'grid', arrangeGap) },
    nodes.length > 1 && onArrange && { key: 'arrange-row', label: L('横向排成一行', 'Arrange in a row'), icon: <StretchVertical size={18} />, onClick: () => onArrange(ids, 'row', arrangeGap) },
    nodes.length > 1 && onArrange && { key: 'arrange-column', label: L('纵向排成一列', 'Arrange in a column'), icon: <StretchHorizontal size={18} />, onClick: () => onArrange(ids, 'column', arrangeGap) },
    nodes.length > 1 && onArrange && { key: 'arrange-gap', label: L('排列间距 ', 'Arrange gap ') + arrangeGap + 'px', icon: <Space size={18} />, onClick: () => setArrangeGap(gap => ARRANGE_GAPS[(ARRANGE_GAPS.indexOf(gap as typeof ARRANGE_GAPS[number]) + 1) % ARRANGE_GAPS.length]) },
    nodes.length > 1 && selectedMedia.length > 0 && onSequencedExport && { key: 'sequenced-export', label: L('按顺序批量下载…', 'Download in order…'), icon: <Download size={18} />, active: namingOpen, onClick: () => setNamingOpen(open => !open) },
    onLayer && { key: 'front', label: L('移到最前', 'Bring to front'), icon: <ChevronsUp size={18} />, onClick: () => onLayer('front') },
    onLayer && { key: 'back', label: L('移到最后', 'Send to back'), icon: <ChevronsDown size={18} />, onClick: () => onLayer('back') },
    node && onPromptFocus && node.type !== 'audio' && node.type !== 'script' && { key: 'prompt', label: L('编辑提示词', 'Edit prompt'), icon: <MessageSquareText size={18} />, onClick: () => onPromptFocus(node.id) },
    media && hasMediaSource && { key: 'download', label: L('下载媒体', 'Download media'), icon: <Download size={18} />, group: 'output', disabled: !mediaUrl, onClick: () => { if (mediaUrl) void saveMediaUrl(mediaUrl, media.metadata.name || media.id).catch(error => console.warn('[Workflow] Media download failed.', error)); } },
    media?.type === 'image' && onSaveMedia && { key: 'save', label: L('保存到素材库', 'Save to media library'), icon: <Library size={18} />, group: 'output', onClick: () => onSaveMedia(media.id) },
    media && hasMediaSource && onPreviewMedia && { key: 'preview', label: L('放大预览', 'Preview'), icon: <Maximize2 size={18} />, group: 'output', disabled: !mediaUrl, onClick: () => onPreviewMedia(media.id) },
    (media?.type === 'image' || media?.type === 'video') && mediaUrl && onReversePrompt && { key: 'reverse-prompt', label: L('反推提示词', 'Reverse prompt'), icon: <ScanText size={18} />, group: 'ai', disabled: advancedToolBusy || Boolean(toolHints?.['reverse-prompt']), hint: toolHints?.['reverse-prompt'], onClick: () => onReversePrompt(media.id, mediaUrl) },
    media && onReplaceMedia && { key: 'replace', label: L('替换媒体', 'Replace media'), icon: <FilePenLine size={18} />, group: 'output', onClick: () => inputRef.current?.click() },
    node?.type === 'image' && mediaUrl && imageTools?.crop && { key: 'crop', label: toolLabel('crop'), icon: <Crop size={18} />, group: 'local', disabled: advancedToolBusy, onClick: () => imageTools.crop?.(node.id) },
    node?.type === 'image' && mediaUrl && imageTools?.filter && { key: 'filter', label: L('图片滤镜', 'Filters'), icon: <SlidersHorizontal size={18} />, group: 'local', disabled: advancedToolBusy, onClick: () => imageTools.filter?.(node.id) },
    node?.type === 'image' && mediaUrl && imageTools?.upscale && { key: 'upscale', label: toolLabel('upscale'), icon: <ZoomIn size={18} />, group: 'ai', disabled: advancedToolBusy || Boolean(toolHints?.upscale), hint: toolHints?.upscale, onClick: () => imageTools.upscale?.(node.id) },
    node?.type === 'image' && mediaUrl && imageTools?.removeBackground && { key: 'remove-background', label: toolLabel('remove-background'), icon: <Eraser size={18} />, group: 'ai', disabled: advancedToolBusy || Boolean(toolHints?.['remove-background']), hint: toolHints?.['remove-background'], onClick: () => imageTools.removeBackground?.(node.id) },
    node?.type === 'image' && mediaUrl && imageTools?.outpaint && { key: 'outpaint', label: L('扩展画面', 'Outpaint'), icon: <Expand size={18} />, group: 'ai', disabled: advancedToolBusy || Boolean(toolHints?.outpaint), hint: toolHints?.outpaint, onClick: () => imageTools.outpaint?.(node.id) },
    node?.type === 'image' && mediaUrl && imageTools?.mask && { key: 'mask', label: L('编辑蒙版', 'Edit mask'), icon: <ScanLine size={18} />, group: 'ai', disabled: advancedToolBusy || Boolean(toolHints?.mask), hint: toolHints?.mask, onClick: () => imageTools.mask?.(node.id) },
    node?.type === 'image' && mediaUrl && imageTools?.splitLayers && { key: 'split', label: toolLabel('split-layers'), icon: <Layers3 size={18} />, group: 'ai', disabled: advancedToolBusy || Boolean(toolHints?.split), hint: toolHints?.split, onClick: () => imageTools.splitLayers?.(node.id) },
    node?.type === 'image' && mediaUrl && imageTools?.rotate && { key: 'rotate', label: toolLabel('rotate'), icon: <RotateCw size={18} />, group: 'local', disabled: advancedToolBusy, onClick: () => imageTools.rotate?.(node.id) },
    node?.type === 'image' && mediaUrl && imageTools?.vectorize && { key: 'vectorize', label: L('矢量化', 'Vectorize'), icon: <PenTool size={18} />, group: 'local', disabled: advancedToolBusy, onClick: () => imageTools.vectorize?.(node.id) },
    node?.type === 'image' && mediaUrl && imageTools?.splitGrid && { key: 'splitGrid', label: toolLabel('split-grid'), icon: <Grid2x2 size={18} />, group: 'output', disabled: advancedToolBusy || Boolean(toolHints?.splitGrid), hint: toolHints?.splitGrid, onClick: () => imageTools.splitGrid?.(node.id) },
    node?.type === 'image' && mediaUrl && imageTools?.layer && { key: 'layer', label: L('叠加层', 'Overlay layer'), icon: <Layers size={18} />, group: 'ai', disabled: advancedToolBusy || Boolean(toolHints?.layer), hint: toolHints?.layer, onClick: () => imageTools.layer?.(node.id) },
    node?.type === 'text' && (node.metadata.noteMergeTargetIds?.length || 0) > 0 && onMergeNotePrompt && { key: 'merge-note-prompt', label: L('并入下游提示词', 'Merge into downstream prompt'), icon: <CornerDownRight size={18} />, onClick: () => onMergeNotePrompt(node.id) },
    selectedMedia.length > 1 && selectedMedia.every(n => n.type === 'image') && imageTools?.storyboard && { key: 'storyboard', label: L('分镜组拼接', 'Storyboard sheet'), icon: <Frame size={18} />, disabled: advancedToolBusy, onClick: () => imageTools.storyboard?.(ids) },
    node?.type === 'video' && videoTools?.trim && { key: 'video-trim', label: hasMediaSource ? toolLabel('video-trim') : toolLabel('video-trim') + L('（请先上传视频）', ' (upload a video first)'), icon: <Scissors size={18} />, disabled: videoToolBusy || mediaPending || !hasMediaSource, onClick: () => videoTools.trim?.(node.id) },
    selectedMedia.length > 1 && selectedMedia.every(n => n.type === 'video') && videoTools?.merge && { key: 'video-merge', label: toolLabel('video-merge'), icon: <Frame size={18} />, disabled: videoToolBusy, onClick: () => videoTools.merge?.(ids) },
    node?.type === 'audio' && mediaUrl && audioTools?.trim && { key: 'audio-trim', label: toolLabel('audio-trim'), icon: <Scissors size={18} />, disabled: audioToolBusy, onClick: () => audioTools.trim?.(node.id) },
    node?.type === 'audio' && mediaUrl && audioTools?.speed && { key: 'audio-speed', label: toolLabel('audio-speed'), icon: <Gauge size={18} />, disabled: audioToolBusy, onClick: () => audioTools.speed?.(node.id) },
    node?.type === 'audio' && mediaUrl && audioTools?.pitch && { key: 'audio-pitch', label: L('变调', 'Pitch'), icon: <Music size={18} />, disabled: audioToolBusy, onClick: () => audioTools.pitch?.(node.id) },
    node?.type === 'audio' && mediaUrl && audioTools?.stemSplit && { key: 'audio-stem-split', label: toolLabel('audio-stem-split'), icon: <AudioLines size={18} />, disabled: audioToolBusy, onClick: () => audioTools.stemSplit?.(node.id) },
    node && (node.type === 'image' || node.type === 'video') && onToggleFreeResize && { key: 'resize', label: L('切换自由缩放', 'Toggle free resize'), icon: <Expand size={18} />, active: Boolean(node.freeResize), onClick: () => onToggleFreeResize(node.id) },
    // Generate lives in the prompt bar. The toolbar only carries the state
    // change you need right now: Stop while running, Retry after a failure.
    node && node.type !== 'audio' && node.type !== 'script' && node.metadata.status === 'loading' && onStop
      ? { key: 'stop', label: L('停止节点', 'Stop node'), icon: <Square size={17} />, onClick: () => onStop(node.id) }
      : node && node.type !== 'audio' && node.type !== 'script' && node.metadata.status === 'error' && onRun && { key: 'run', label: L('重试节点', 'Retry node'), icon: <RefreshCw size={18} />, onClick: () => onRun(node.id) },
    { key: 'delete', label: L('删除节点', 'Delete node'), icon: <Trash2 size={18} />, danger: true, onClick: () => onDelete(ids) },
  ];
  // LibTV 式：分离音视频与截帧各自收成一个下拉。空视频节点或媒体还在加载时置灰，而不是整组消失。
  const videoNode = node?.type === 'video' ? node : null;
  const videoBusy = videoToolBusy || mediaPending || !hasMediaSource || videoNode?.metadata.status === 'loading';
  const avSplitActions: WorkflowToolbarAction[] = videoNode && videoTools?.avSplit ? [
    { key: 'video-av-split', label: L('分离音视频', 'Split audio & video'), icon: <AudioLines size={16} />, disabled: videoBusy, onClick: () => videoTools.avSplit?.(videoNode.id, 'full') },
    { key: 'video-vocals', label: L('人声提取', 'Extract vocals'), icon: <Mic size={16} />, disabled: videoBusy, onClick: () => videoTools.avSplit?.(videoNode.id, 'vocals') },
    { key: 'video-background', label: L('背景音提取', 'Extract background audio'), icon: <Music size={16} />, disabled: videoBusy, onClick: () => videoTools.avSplit?.(videoNode.id, 'background') },
  ] : [];
  const frameActions: WorkflowToolbarAction[] = (videoNode ? [
    videoTools?.extractFrame && { key: 'video-frame-first', label: L('截取首帧', 'First frame'), icon: <ArrowUpToLine size={16} />, disabled: videoBusy, onClick: () => videoTools.extractFrame?.(videoNode.id, 'first') },
    videoTools?.extractFrame && { key: 'video-frame-last', label: L('截取尾帧', 'Last frame'), icon: <ArrowDownToLine size={16} />, disabled: videoBusy, onClick: () => videoTools.extractFrame?.(videoNode.id, 'last') },
    videoTools?.extractFrameAt && { key: 'video-frame-at', label: L('截取指定帧…', 'Frame at time…'), icon: <Frame size={16} />, disabled: videoBusy, onClick: () => videoTools.extractFrameAt?.(videoNode.id) },
  ] as Array<WorkflowToolbarAction | false | undefined> : []).filter((action): action is WorkflowToolbarAction => Boolean(action));
  const textNode = node?.type === 'text' ? node : null;
  const textAssetReady = canGenerateTextAssets(textNode);
  const assetActions: WorkflowToolbarAction[] = textNode && onGenerateAsset ? WORKFLOW_TEXT_ASSET_KINDS.map(kind => {
    const Icon = TEXT_ASSET_ICONS[kind.id];
    return { key: 'text-asset-' + kind.id, label: kind.label, icon: <Icon size={16} />, disabled: !textAssetReady, onClick: () => onGenerateAsset(textNode.id, kind.id) };
  }) : [];
  const alignActions: WorkflowToolbarAction[] = nodes.length > 1 && onAlign ? [
    { key: 'left', label: L('左对齐节点', 'Align left'), icon: <AlignLeft size={16} />, onClick: () => onAlign('left') },
    { key: 'horizontal-center', label: L('水平居中节点', 'Align horizontal centers'), icon: <AlignCenter size={16} />, onClick: () => onAlign('horizontal-center') },
    { key: 'right', label: L('右对齐节点', 'Align right'), icon: <AlignRight size={16} />, onClick: () => onAlign('right') },
    { key: 'top', label: L('顶部对齐节点', 'Align top'), icon: <ArrowUpToLine size={16} />, onClick: () => onAlign('top') },
    { key: 'vertical-center', label: L('垂直居中节点', 'Align vertical centers'), icon: <AlignCenter size={16} />, onClick: () => onAlign('vertical-center') },
    { key: 'bottom', label: L('底部对齐节点', 'Align bottom'), icon: <ArrowDownToLine size={16} />, onClick: () => onAlign('bottom') },
    ...(nodes.length > 2 && onDistribute ? [
      { key: 'distribute-horizontal', label: L('水平等距分布', 'Distribute horizontally'), icon: <AlignHorizontalSpaceAround size={16} />, onClick: () => onDistribute('horizontal') },
      { key: 'distribute-vertical', label: L('垂直等距分布', 'Distribute vertically'), icon: <AlignVerticalSpaceAround size={16} />, onClick: () => onDistribute('vertical') },
    ] : []),
  ] : [];
  // A handful of always-visible actions; everything else sits, labelled, behind "更多".
  const present = actions.filter((action): action is WorkflowToolbarAction => Boolean(action));
  const primary = present.filter(action => PRIMARY_KEYS.has(action.key));
  const iconOnly = present.filter(action => ICON_KEYS.has(action.key));
  const overflow = [...present.filter(action => !PRIMARY_KEYS.has(action.key) && !ICON_KEYS.has(action.key)), ...alignActions];
  return (
    <WorkflowToolbarShell testId="workflow-node-toolbar">
      {media && onReplaceMedia && <>
        <input ref={inputRef} hidden type="file" accept={`${media.type}/*`} onChange={event => { const file = event.target.files?.[0]; if (file) onReplaceMedia(media.id, file); event.target.value = ''; }} />
      </>}
      {assetActions.length > 0 && <WorkflowToolbarMenu variant="labelled" label={L('生成资产', 'Generate asset')} icon={<Sparkles size={16} />} actions={assetActions} disabled={!textAssetReady} />}
      <WorkflowToolbarActions showLabels actions={primary.filter(action => action.key !== 'delete')} />
      {avSplitActions.length > 0 && <WorkflowToolbarMenu variant="labelled" label={L('分离音视频', 'Split audio & video')} icon={<AudioLines size={16} />} actions={avSplitActions} disabled={videoBusy} />}
      {overflow.length > 0 && <WorkflowToolbarMenu label={L('更多', 'More')} icon={<MoreHorizontal size={18} />} actions={overflow} />}
      {frameActions.length > 0 && <WorkflowToolbarMenu variant="icon-chevron" label={L('视频截帧', 'Extract frame')} icon={<Camera size={16} />} actions={frameActions} />}
      <WorkflowToolbarActions actions={[...iconOnly, ...primary.filter(action => action.key === 'delete')]} />
      {namingOpen && onSequencedExport && selectedMedia.length > 0 && (
        <form
          className="workflow-group-naming flv-glass flv-glass--thick"
          aria-label={L('批量下载命名', 'Batch download naming')}
          style={{ position: 'absolute', top: 'calc(100% + 8px)', left: '50%', transform: 'translateX(-50%)', display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 12, color: 'var(--isl-ink)', whiteSpace: 'nowrap', zIndex: 2 }}
          onSubmit={event => { event.preventDefault(); onSequencedExport(ids, namePrefix); setNamingOpen(false); }}
        >
          <input aria-label={L('文件名前缀', 'File name prefix')} autoFocus value={namePrefix} placeholder="iris" onChange={event => setNamePrefix(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') setNamingOpen(false); event.stopPropagation(); }} style={{ width: 140 }} />
          <small>{sequencedFileNames(namePrefix, selectedMedia.length)[0]} … {L('共 ' + selectedMedia.length + ' 个', selectedMedia.length + ' total')}</small>
          <button type="submit">{L('下载', 'Download')}</button>
        </form>
      )}
    </WorkflowToolbarShell>
  );
}
