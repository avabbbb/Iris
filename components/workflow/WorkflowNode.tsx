import { localizeWorkflowNodeTitle } from './constants';
import { TextNodeBody } from './TextNodeBody';
import { ArrowLeftRight, AudioLines, Bot, Camera, Check, ChevronsDown, Clapperboard, FileText, Gauge, Image as ImageIcon, Lock, Music2, Pause, Pencil, Pin, Play, Plus, RefreshCw, Scissors, Sparkles, Star, Upload, Video, Volume2, VolumeX, X } from 'lucide-react';
import { summarizeCameraControl } from './cameraControl';
import { WorkflowNodeLasso } from './WorkflowNodeLasso';
import type { LassoPoint } from './lasso';
import { Component, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { useMenuKeyboard } from '../../hooks/useListboxKeyboard';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { WorkflowGenerationLoader } from './WorkflowGenerationLoader';
import { getWorkflowOperationCapability } from './operationRegistry';
import { buildCssFilter } from '../ImageFilterPanel';
import { isGeneratedWorkflowMedia, useWorkflowMediaUrl } from './media';
import { parseLocalFolderHref, requestLocalFolderPermission } from '../../services/localFolderSource';
import { getWorkflowNodePlugin, type WorkflowNodePluginContext, type WorkflowNodePluginDefinition } from './nodePluginSdk';
import './ContextCardNode';
import './AgentSessionCardNode';
import { isContextCardNode } from './contextCard';
import { isAgentSessionNode } from './agentSessionCard';
import { setContextCardHighlight, useIsContextCardSource } from './contextCardHighlight';
import type { WorkflowNode as WorkflowNodeData } from './types';
import { listWorkflowOperationVersions } from './operations';
import type { WorkflowNodeRunInfo, WorkflowStaleReason } from './runState';
import type { WorkflowNodePresence } from './presence';
import type { WorkflowLayerPreview } from './layerPreview';
import { WorkflowLayerCandidates } from './WorkflowLayerCandidates';
import { WorkflowVideoTrimBar } from './WorkflowVideoTrimBar';

function WorkflowPluginSurface({ plugin, pluginContext }: { plugin: WorkflowNodePluginDefinition; pluginContext: WorkflowNodePluginContext }) {
  return <>
    <div className="workflow-node__plugin-render">{plugin.render({ node: pluginContext.node, context: pluginContext })}</div>
    {plugin.panel && <div className="workflow-node__plugin-panel">{plugin.panel({ node: pluginContext.node, context: pluginContext })}</div>}
    {plugin.toolbar && <div className="workflow-node__plugin-toolbar" data-workflow-overlay>{plugin.toolbar({ node: pluginContext.node, context: pluginContext })}</div>}
  </>;
}

class WorkflowPluginErrorBoundary extends Component<{ children: ReactNode; pluginTitle: string }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return <div className="workflow-node__empty" data-testid="workflow-plugin-error" role="status">
        <FileText size={26} />
        <span>{this.props.pluginTitle}暂时不可用</span>
      </div>;
    }
    return this.props.children;
  }
}

// 子画布框：标题由节点标题栏显示（= 逆向工程名），框体只显示子节点数与折叠开关。
function SubgraphFrameSurface({ node, childCount, onToggleCollapse, language }: { node: WorkflowNodeData; childCount: number; onToggleCollapse?: () => void; language: 'en' | 'zho' }) {
  const collapsed = node.metadata.collapsed === true;
  const en = language === 'en';
  const isGroup = node.metadata.groupKind === 'group';
  const toggleLabel = isGroup
    ? (collapsed ? (en ? 'Expand group' : '展开分组') : (en ? 'Collapse group' : '折叠分组'))
    : (collapsed ? (en ? 'Expand subgraph' : '展开子画布') : (en ? 'Collapse subgraph' : '折叠子画布'));
  // 分组框没有对应的逆向工程：不显示"双击在 Cut 中打开"，改成右键菜单提示。
  const hint = isGroup ? (en ? 'Right-click: run group / download all' : '右键：整组执行 / 下载全部') : (en ? 'Double-click to open in Cut' : '双击在 Cut 中打开');
  return <div className="workflow-subgraph" data-testid="workflow-subgraph-frame" data-group-kind={isGroup ? 'group' : undefined} data-collapsed={collapsed ? 'true' : 'false'}>
    <div className="workflow-subgraph-header">
      <Clapperboard size={14} />
      <span className="workflow-subgraph-count">{en ? childCount + ' nodes' : childCount + ' 个节点'}</span>
      {!collapsed && <span className="workflow-subgraph-hint" title={hint}>{hint}</span>}
      {onToggleCollapse && <button
        type="button"
        className="workflow-subgraph-toggle"
        data-workflow-overlay
        aria-label={toggleLabel}
        title={toggleLabel}
        onPointerDown={event => event.stopPropagation()}
        onDoubleClick={event => event.stopPropagation()}
        onClick={event => { event.stopPropagation(); onToggleCollapse(); }}
      ><ChevronsDown size={13} style={{ transform: collapsed ? 'rotate(-90deg)' : undefined }} /></button>}
    </div>
  </div>;
}

// 设计类节点已下线：旧项目里的设计节点仅显示占位，数据原样保留。
function DesignNodeSurface({ language }: { node: WorkflowNodeData; language?: 'en' | 'zho' }) {
  return <div className="workflow-node__empty" data-testid="workflow-design-node"><ImageIcon size={26} /><span>{language === 'en' ? 'Design node (removed)' : '设计节点（已下线）'}</span></div>;
}

// 连接点吸附（360°）：光标进入节点左右两侧的吸附区后，+ 圆点以该边上离光标最近的点为锚，
// 朝光标方向偏移（半径封顶），可出框并上下左右任意方向跟随。直接写吸附区上的 CSS 变量，不触发 React 重渲染。
// 几何常量须与 styles/workflow.css 中 .workflow-handle-zone 保持一致。
const handleMagnetRadius = 56;
const handleZoneOuter = 72;
const handleZonePadY = 40;
const handleHalf = 11;

function trackWorkflowHandle(event: ReactPointerEvent<HTMLDivElement>, side: 'in' | 'out') {
  const zone = event.currentTarget;
  const rect = zone.getBoundingClientRect();
  const width = zone.offsetWidth;
  const ratio = width > 0 && rect.width > 0 ? rect.width / width : 1;
  const localX = (event.clientX - rect.left) / ratio;
  const localY = (event.clientY - rect.top) / ratio;
  const nodeBottom = zone.offsetHeight - handleZonePadY;
  const edgeX = side === 'in' ? handleZoneOuter : width - handleZoneOuter;
  const anchorY = Math.min(Math.max(handleZonePadY + handleHalf, nodeBottom - handleHalf), Math.max(handleZonePadY + handleHalf, localY));
  const dx = localX - edgeX;
  const dy = localY - anchorY;
  const distance = Math.hypot(dx, dy);
  const shrink = distance > handleMagnetRadius ? distance / handleMagnetRadius : 1;
  zone.style.setProperty('--wf-handle-x', edgeX + dx / shrink + 'px');
  zone.style.setProperty('--wf-handle-y', anchorY + dy / shrink + 'px');
}

function resetWorkflowHandle(event: ReactPointerEvent<HTMLDivElement>) {
  event.currentTarget.style.removeProperty('--wf-handle-x');
  event.currentTarget.style.removeProperty('--wf-handle-y');
}

/** 节点退出动画：有限时长（DESIGN §14.2 退出 120–160ms），不继承加载态的无限循环。 */
export const WORKFLOW_NODE_EXIT = { scale: 0.85, opacity: 0, transition: { duration: 0.14, ease: [0.4, 0, 1, 1] as const } };

export function WorkflowNode({
  node,
  selected,
  lifted = false,
  mediaActive,
  onPointerDown,
  onConnectStart,
  onConnectStartTarget,
  onResizeStart,
  onChangeText,
  onChangeMetadata,
  onRun,
  onStop,
  onContextMenu,
  onKeyboardContextMenu,
  onKeyboardSelect,
  onKeyboardConnectStart,
  onKeyboardConnectTarget,
  onKeyboardResize,
  language = 'zho',
  onReplaceMedia,
  onActivateMedia,
  onDeactivateMedia,
  onExtractFrame,
  onCollapseBatch,
  batchCount,
  isBatchPrimary,
  onSetBatchPrimary,
  onDoubleClick,
  onPreviewMedia,
  onChangeTitle,
  onToggleAnchorApproval,
  anchorCode,
  trimEditing,
  trimBusy,
  onTrimConfirm,
  onTrimCancel,
  onFocusNode,
  renameSignal,
  onNeedPoster,
  pluginContext,
  runState,
  onSelectTake,
  presence,
  layerPreview,
  lassoActive,
  onLassoDone,
  subgraphChildCount,
  onToggleCollapse,
  uploadStage,
  onCancelUpload,
  onAudioTool,
  alternatesDock,
}: {
  node: WorkflowNodeData;
  selected: boolean;
  /** 正被拖拽：抬起（放大、微倾、加深投影），松手后弹簧落地。 */
  lifted?: boolean;
  mediaActive?: boolean;
  /** 节点内剪辑（替代 TrimDialog）：为 true 时视频强制展开并显示内嵌裁剪条。 */
  trimEditing?: boolean;
  trimBusy?: boolean;
  onTrimConfirm?: (startSec: number, endSec: number) => void;
  onTrimCancel?: () => void;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onConnectStart: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onConnectStartTarget?: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onResizeStart: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onChangeText: (value: string) => void;
  onChangeMetadata: (metadata: WorkflowNodeData['metadata']) => void;
  onRun: () => void;
  onStop?: () => void;
  onContextMenu: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onKeyboardContextMenu?: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  onKeyboardSelect?: () => void;
  onKeyboardConnectStart?: () => void;
  onKeyboardConnectTarget?: () => void;
  onKeyboardResize?: (widthDelta: number, heightDelta: number) => void;
  language?: 'en' | 'zho';
  onReplaceMedia: (file: File) => void;
  onRemoveMedia: () => void;
  onActivateMedia?: () => void;
  onDeactivateMedia?: () => void;
  onExtractFrame?: (position: 'first' | 'current' | 'last', currentTimeSec?: number) => void;
  onCollapseBatch?: () => void;
  batchCount?: number;
  isBatchPrimary?: boolean;
  onSetBatchPrimary?: () => void;
  /** 多结果的备选条 / 网格：挂在节点盒子下方，随节点移动、选中、裁剪（画布构造，节点只负责放置）。 */
  alternatesDock?: ReactNode;
  onDoubleClick?: () => void;
  onPreviewMedia?: (node: WorkflowNodeData) => void;
  onChangeTitle?: (title: string) => void;
  /** 锚点节点：批准/取消批准（画布用 update_node 写入，可撤销）。 */
  onToggleAnchorApproval?: () => void;
  /** 锚点短编号（A01/S01/P01/T01），显示在标题前，可在 Prompt/Agent 里直接引用。 */
  anchorCode?: string;
  onFocusNode?: () => void;
  renameSignal?: number;
  /** 视频缺少封面时通知画布按需补齐（由画布持有请求，避免节点卸载后遗留缓存）。 */
  onNeedPoster?: () => void;
  /** 仅 subgraph：子节点数。 */
  subgraphChildCount?: number;
  /** 仅 subgraph：切换折叠（画布用 update_node 写入）。 */
  onToggleCollapse?: () => void;
  pluginContext?: WorkflowNodePluginContext;
  /** 派生运行状态（deriveWorkflowRunStates）；只用于显示，不改变节点数据。 */
  runState?: WorkflowNodeRunInfo;
  /** 明确选择 Operation 的某个版本（Take）。 */
  onSelectTake?: (takeId: string) => void;
  /** 最近一次改动来自 Agent / CLI / 面板时的在场标记（deriveWorkflowPresence）。 */
  presence?: WorkflowNodePresence;
  /** 叠加层 Operation 当前 Take 的源图与候选（deriveWorkflowLayerPreview）；只用于显示。 */
  layerPreview?: WorkflowLayerPreview;
  /** 节点内套索模式（叠加层）；仅对已有媒体的图片节点生效。 */
  lassoActive?: boolean;
  /** null 取消；[] 整图；否则为原图像素坐标的闭合路径。 */
  onLassoDone?: (points: LassoPoint[] | null) => void;
  // 媒体入库阶段与进度（画布持有，仅显示）。
  uploadStage?: { stage: 'probe' | 'download' | 'transcode' | 'store'; progress?: number };
  // 取消入库：终止转码并移除占位节点。
  onCancelUpload?: () => void;
  /** 音频节点内联工具条：截取 / 变速 / 变调 / 人声分离。 */
  onAudioTool?: (kind: 'trim' | 'speed' | 'pitch' | 'stem-split') => void;
}) {
  const status = node.metadata.status || 'idle';
  const mediaInput = useRef<HTMLInputElement>(null);
  const needPosterRef = useRef(onNeedPoster);
  needPosterRef.current = onNeedPoster;
  const videoActive = node.type === 'video' && (Boolean(mediaActive) || Boolean(trimEditing));
  const resolveSourceMedia = node.type !== 'video' || videoActive;
  const media = useWorkflowMediaUrl(
    resolveSourceMedia ? (node.type === 'video' && node.metadata.previewStorageKey) || node.metadata.storageKey : undefined,
    resolveSourceMedia ? node.metadata.href : undefined,
    resolveSourceMedia ? node.metadata.artifactRef : undefined,
    { generated: isGeneratedWorkflowMedia(node.metadata) },
  );
  const posterMedia = useWorkflowMediaUrl(
    node.type === 'video' ? node.metadata.posterStorageKey : undefined,
    node.type === 'video' ? node.metadata.poster : undefined,
  );
  const videoRef = useRef<HTMLVideoElement>(null);
  const videoLeaveTimer = useRef<number | undefined>(undefined);
  const [videoPlaying, setVideoPlaying] = useState(false);
  const [videoDecodeError, setVideoDecodeError] = useState<string | null>(null);
  const videoDecodeMessage = language === 'en'
    ? 'This browser cannot decode the video (often H.265/HEVC). Convert it to H.264 MP4 and upload again.'
    : '浏览器无法解码该视频（常见于 H.265/HEVC 编码），请转码为 H.264 MP4 后重新上传';
  const [videoCurrentTime, setVideoCurrentTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState(() => (node.metadata.durationMs || 0) / 1000);
  const [videoVolume, setVideoVolume] = useState(.5);
  const [volumeOpen, setVolumeOpen] = useState(false);
  const [frameMenuOpen, setFrameMenuOpen] = useState(false);
  const frameMenuKeys = useMenuKeyboard({ open: frameMenuOpen, onClose: () => setFrameMenuOpen(false) });
  useEffect(() => () => window.clearTimeout(videoLeaveTimer.current), []);
  useEffect(() => {
    if (!videoActive) {
      setVideoPlaying(false);
      setVideoCurrentTime(0);
      setVolumeOpen(false);
      setFrameMenuOpen(false);
    }
  }, [videoActive]);
  useEffect(() => {
    if (videoRef.current) videoRef.current.volume = videoVolume;
  }, [videoActive, videoVolume]);
  useEffect(() => {
    setVideoDecodeError(null);
  }, [media.url]);
  const isMedia = node.type === 'image' || node.type === 'video' || node.type === 'audio';
  const hasMediaReference = Boolean(node.metadata.storageKey || node.metadata.href || node.metadata.artifactRef?.taskId);
  const posterSourceKey = node.type === 'video' ? `${node.metadata.storageKey || ''}|${node.metadata.href || ''}|${node.metadata.artifactRef?.taskId || ''}` : '';
  // 视频默认展示封面：缺失时通知画布按需补齐，避免画布上出现空白占位。
  useEffect(() => {
    if (node.type !== 'video' || !posterSourceKey) return;
    if (node.metadata.posterStorageKey || node.metadata.poster) return;
    needPosterRef.current?.();
  }, [node.metadata.poster, node.metadata.posterStorageKey, node.type, posterSourceKey]);
  const uploading = Boolean(node.metadata.uploading);
  const uploadBytes = node.metadata.uploadBytes || 0;
  const uploadPercent = uploadStage?.progress !== undefined ? Math.round(uploadStage.progress / 0.01) + '%' : '';
  const uploadLabel = !uploadStage ? (language === 'en' ? 'Importing' : '导入中')
    : uploadStage.stage === 'probe' ? (language === 'en' ? 'Checking format' : '检测格式')
    : uploadStage.stage === 'download' ? (language === 'en' ? 'Downloading converter' : '下载转码组件')
    : uploadStage.stage === 'transcode' ? (language === 'en' ? 'Converting' : '转码中')
    : (language === 'en' ? 'Saving' : '保存中');
  // 本地入库不是网络上传：没有百分比时只标明文件大小。
  const uploadDetail = uploadPercent || (language === 'en' ? 'File ' : '文件 ') + formatBytes(uploadBytes);
  // 后台生成画布预览期间：原文件浏览器解不了，挂 <video> 只会黑屏，改为带进度的占位；节点本身仍可连线、生成。
  const previewProgress = uploadStage?.progress;
  const previewPlaceholder = node.type === 'video' && !uploading && uploadStage ? (
    <div className="workflow-video-preparing" role="img" aria-label={language === 'en' ? 'Preparing canvas preview' : '正在生成画布预览'} data-testid="workflow-video-preparing" data-workflow-media-preview>
      <span className="workflow-video-preparing-icon"><Video size={18} /></span>
      <strong>{language === 'en' ? 'Preparing canvas preview' : '正在生成画布预览'}</strong>
      <span className={'workflow-video-preparing-bar' + (previewProgress === undefined ? ' is-indeterminate' : '')}>
        <i style={previewProgress === undefined ? undefined : { width: Math.max(2, Math.round(previewProgress / 0.01)) + '%' }} />
      </span>
      <span className="workflow-video-preparing-meta">{uploadLabel}{uploadPercent ? ' · ' + uploadPercent : ''}</span>
      <span className="workflow-video-preparing-hint">{language === 'en' ? 'Node is ready · generation uses the original file' : '节点可正常使用 · 生成时用原文件'}</span>
    </div>
  ) : null;
  const [isDropTarget, setDropTarget] = useState(false);
  const reduceMotion = useReducedMotion();
  // 生成加载态（WorkflowGenerationLoader）：loading 显示网格 + 进度线；loading → success 时网格原地淡出露出结果，约 1.1s 后整层淡出。
  const [bootPrevStatus, setBootPrevStatus] = useState(status);
  const [bootDoneHold, setBootDoneHold] = useState(false);
  if (bootPrevStatus !== status) {
    setBootPrevStatus(status);
    setBootDoneHold(bootPrevStatus === 'loading' && status === 'success');
  }
  useEffect(() => {
    if (!bootDoneHold) return;
    const timer = window.setTimeout(() => setBootDoneHold(false), reduceMotion ? 600 : 1100);
    return () => window.clearTimeout(timer);
  }, [bootDoneHold, reduceMotion]);
  const [isEditingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(node.title);
  const plugin = getWorkflowNodePlugin(node.type);
  // Context Card：选中时高亮它的来源节点（Context 关系默认不画连线）；这个节点是某张卡片的来源时自己亮起。
  const contextSource = useIsContextCardSource(node.id);
  // Context Card 是结论，不是 Workflow 步骤：不显示连线手柄（「+」/ 输出端口），标题画在卡片内部。
  // Agent 会话卡同理：它是 Session 的投影，不是 Workflow 步骤；选中时高亮它绑定的素材。
  const isAgentSession = isAgentSessionNode(node);
  const isContextCard = isContextCardNode(node) || isAgentSession;
  const cardSourceKey = isContextCard && selected ? ((isAgentSession ? node.metadata.agentSession?.references : node.metadata.contextCard?.sources) || []).filter(source => source.kind === 'node').map(source => source.id).join('\u0000') : '';
  useEffect(() => {
    if (!cardSourceKey) return;
    const key = node.id + ':selected';
    setContextCardHighlight(key, cardSourceKey.split('\u0000'));
    return () => setContextCardHighlight(key, null);
  }, [cardSourceKey, node.id]);
  useEffect(() => {
    if (isEditingTitle) setTitleDraft(node.title);
  }, [isEditingTitle, node.title]);
  const lastRenameSignalRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (renameSignal === undefined || renameSignal === lastRenameSignalRef.current) return;
    lastRenameSignalRef.current = renameSignal;
    if (!isEditingTitle) setEditingTitle(true);
  }, [renameSignal, isEditingTitle]);
  const titleIcon = node.type === 'image' ? ImageIcon : node.type === 'video' ? Video : node.type === 'audio' ? Music2 : node.type === 'script' ? Clapperboard : node.type === 'operation' ? Sparkles : FileText;
  const TitleIcon = titleIcon;
  const commitTitle = () => {
    const next = titleDraft.trim();
    if (next && next !== node.title && onChangeTitle) onChangeTitle(next);
    setEditingTitle(false);
  };
  const accept = isMedia ? `${node.type}/*` : undefined;
  const mediaError = isMedia ? (media.error || node.metadata.error) : null;
  const regrantFolderId = isMedia && media.errorCode === 'PERMISSION' && node.metadata.href
    ? parseLocalFolderHref(node.metadata.href)?.folderId
    : undefined;
  const regrantAction = regrantFolderId ? (
    <button
      type="button"
      className="workflow-node__regrant"
      data-workflow-overlay
      onPointerDown={event => event.stopPropagation()}
      onClick={event => { event.stopPropagation(); void requestLocalFolderPermission(regrantFolderId); }}
    >
      {language === 'en' ? 'Reconnect folder' : '重新连接文件夹'}
    </button>
  ) : null;
  const mediaDimensions = isMedia && node.metadata.naturalWidth && node.metadata.naturalHeight
    ? `${node.metadata.naturalWidth} × ${node.metadata.naturalHeight}`
    : '';
  const mediaDetails = isMedia ? [
    node.metadata.durationMs && !(node.type === 'video' && videoActive) ? formatDuration(node.metadata.durationMs) : '',
    node.metadata.bytes ? formatBytes(node.metadata.bytes) : '',
  ].filter(Boolean).join(' · ') : '';
  const toggleVideo = async () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) await video.play().catch(() => undefined);
    else video.pause();
  };
  const updateVolume = (value: number) => {
    const next = Math.max(0, Math.min(1, value));
    setVideoVolume(next);
    if (videoRef.current) videoRef.current.volume = next;
  };
  const keepVideoLoaded = () => {
    window.clearTimeout(videoLeaveTimer.current);
    onActivateMedia?.();
  };
  const releaseVideo = () => {
    window.clearTimeout(videoLeaveTimer.current);
    videoLeaveTimer.current = window.setTimeout(() => onDeactivateMedia?.(), 520);
  };
  const mediaActions = isMedia && (
    <div className="workflow-node__media-actions" data-workflow-overlay onPointerDown={event => event.stopPropagation()}>
      <button
        type="button"
        className="workflow-node__media-swap"
        aria-label="替换素材"
        title={(language === 'en' ? 'Replace media' : '替换素材')}
        onClick={event => { event.stopPropagation(); mediaInput.current?.click(); }}
      >
        <ArrowLeftRight size={13} />
      </button>
      <input ref={mediaInput} hidden type="file" accept={accept} onChange={event => { const file = event.target.files?.[0]; if (file) onReplaceMedia(file); event.currentTarget.value = ''; }} />
    </div>
  );
  const cameraBadge = (node.type === 'image' || node.type === 'video')
    ? summarizeCameraControl({ camera: node.metadata.config?.camera, cameraMovement: node.metadata.config?.cameraMovement, rig3d: node.metadata.cameraRig }, language)
    : '';
  const liftMotion = !reduceMotion && lifted;
  return (
    <motion.div
      data-workflow-node-id={node.id}
      data-lifted={lifted ? 'true' : undefined}
      data-locked={node.isLocked ? 'true' : undefined}
      data-pinned={node.metadata.pinned ? 'true' : undefined}
      data-color-tag={node.metadata.colorTag || undefined}
      className={`workflow-node workflow-node--${node.type}${selected ? ' is-selected' : ''}${node.isLocked ? ' is-locked' : ''}${isDropTarget ? ' is-drop-target' : ''}${lifted ? ' is-lifted' : ''}${contextSource ? ' is-context-source' : ''}${isContextCard ? ' is-context-card' : ''}${isAgentSession ? ' is-agent-session' : ''}`}
      role="group"
      aria-label={language === 'en' ? `${node.title} workflow node` : `${node.title} 工作流节点`}
      tabIndex={0}
      style={{ x: node.position.x, y: node.position.y, width: node.width, height: node.height }}
      initial={{ scale: 0.85, opacity: 0 }}
      animate={{ scale: liftMotion ? 1.04 : 1, rotate: liftMotion ? -1.5 : 0, opacity: 1 }}
      // 退出必须有自己的短而有限的过渡，不沿用 transition.scale 的弹簧：AnimatePresence 等不到退出结束时，
      // 透明的旧节点会留在原位拦截点击（“拖走 4 张批次，原位留下一张点不中的”）。
      exit={WORKFLOW_NODE_EXIT}
      transition={{
        scale: liftMotion
          ? { type: 'spring', stiffness: 520, damping: 26, mass: 0.6 }
          // 落地：阻尼偏低，略压过 1 再回弹，像纸片放回桌面。生成中不再整节点呼吸缩放（DESIGN / 01 §19.6）。
          : { type: 'spring', stiffness: 460, damping: 15, mass: 0.7 },
        rotate: { type: 'spring', stiffness: 380, damping: 18 },
        opacity: { duration: 0.2 },
        default: { type: 'spring', stiffness: 400, damping: 22 },
      }}
      onPointerDown={onPointerDown}
      onDoubleClick={event => {
        if (plugin && pluginContext) { event.stopPropagation(); plugin.onDoubleClick?.(pluginContext); return; }
        if (node.type === 'script') { event.stopPropagation(); onDoubleClick?.(); return; }
        if (node.type === 'subgraph') { event.stopPropagation(); onDoubleClick?.(); return; }
        event.stopPropagation();
        if (isMedia && !hasMediaReference) { mediaInput.current?.click(); return; }
        onFocusNode?.();
      }}
      onContextMenu={event => { event.preventDefault(); event.stopPropagation(); onContextMenu(event); }}
      onKeyDown={event => {
        if (event.target !== event.currentTarget) return;
        if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
          event.preventDefault();
          onKeyboardContextMenu?.(event);
        } else if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onKeyboardSelect?.();
        }
      }}
      onMouseOver={node.type === 'video' && hasMediaReference ? keepVideoLoaded : undefined}
      onMouseOut={node.type === 'video' && hasMediaReference ? event => {
        const related = event.relatedTarget as Node | null;
        if (related && event.currentTarget.contains(related)) return;
        releaseVideo();
      } : undefined}
      onDragOver={event => { if (isMedia && event.dataTransfer?.types?.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setDropTarget(true); } }}
      onDragLeave={event => { if (!isMedia) return; const related = event.relatedTarget as Node | null; if (related && (event.currentTarget as HTMLElement).contains(related)) return; setDropTarget(false); }}
      onDrop={event => { if (!isMedia) return; setDropTarget(false); if ((event.dataTransfer.files?.length || 0) > 1) return; event.preventDefault(); event.stopPropagation(); const file = event.dataTransfer.files?.[0]; if (file) onReplaceMedia(file); }}
    >
      {!isContextCard && <>
      <div className="workflow-handle-zone workflow-handle-zone--target" data-workflow-target={node.id} onPointerMove={event => trackWorkflowHandle(event, 'in')} onPointerLeave={resetWorkflowHandle} onPointerDown={event => { if (event.target === event.currentTarget) onConnectStartTarget?.(event as unknown as ReactPointerEvent<HTMLButtonElement>); }}>
      <button type="button" className="workflow-handle workflow-handle--target" aria-label={language === 'en' ? `Connect to ${node.title}` : `连接到${node.title}`} title={language === 'en' ? 'Activate to complete a keyboard connection' : '激活以完成键盘连接'} data-workflow-target={node.id} onPointerDown={onConnectStartTarget} onClick={event => { if (event.detail === 0) onKeyboardConnectTarget?.(); }}>
        <span className="workflow-handle__plus" aria-hidden="true"><Plus size={12} strokeWidth={2.5} /></span>
      </button>
      </div>
      <div className="workflow-handle-zone workflow-handle-zone--source" onPointerMove={event => trackWorkflowHandle(event, 'out')} onPointerLeave={resetWorkflowHandle} onPointerDown={event => { if (event.target === event.currentTarget) onConnectStart(event as unknown as ReactPointerEvent<HTMLButtonElement>); }}>
      <button type="button" className="workflow-handle workflow-handle--source" aria-label={language === 'en' ? `Connect from ${node.title}` : `从${node.title}连接`} title={language === 'en' ? 'Activate, then choose a target node' : '激活后选择目标节点'} onPointerDown={onConnectStart} onClick={event => { if (event.detail === 0) onKeyboardConnectStart?.(); }}>
        <span className="workflow-handle__plus" aria-hidden="true"><Plus size={12} strokeWidth={2.5} /></span>
      </button>
      </div>
      </>}
      {status === 'error' && <span className="workflow-node__error-badge" title={node.metadata.error}>!</span>}
      {runState?.state === 'stale' && <WorkflowStaleBadge reason={runState.reason} language={language} />}
      {presence && <WorkflowPresenceChip presence={presence} language={language} />}
      {node.metadata.hostSend && <WorkflowHostSendChip status={node.metadata.hostSend.status} host={node.metadata.hostSend.host} language={language} />}
      {batchCount && batchCount > 1 && (
        <div className="workflow-node__batch-actions" data-workflow-overlay>
          {onCollapseBatch && <button type="button" title={(language === 'en' ? 'Collapse results' : '收起结果')} onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); onCollapseBatch(); }}><ChevronsDown size={13} />{batchCount}{language === 'en' ? '' : '张'}</button>}
          {isBatchPrimary ? <span><Check size={12} />{(language === 'en' ? 'Primary' : '主图')}</span> : onSetBatchPrimary && <button type="button" title={(language === 'en' ? 'Set as primary' : '设为主图')} onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); onSetBatchPrimary(); }}><Star size={12} />{(language === 'en' ? 'Set as primary' : '设为主图')}</button>}
        </div>
      )}
      {isContextCard ? null : isEditingTitle && onChangeTitle ? (
        <div className="workflow-node__title is-editing" data-workflow-overlay>
          <TitleIcon size={12} />
          <input
            value={titleDraft}
            autoFocus
            data-workflow-overlay
            onChange={event => setTitleDraft(event.target.value)}
            onPointerDown={event => event.stopPropagation()}
            onKeyDown={(event: ReactKeyboardEvent<HTMLInputElement>) => {
              if (event.key === 'Enter') { event.preventDefault(); commitTitle(); }
              else if (event.key === 'Escape') { event.preventDefault(); setEditingTitle(false); }
            }}
            onBlur={commitTitle}
            onClick={event => event.stopPropagation()}
          />
        </div>
      ) : (
        <div
          className="workflow-node__title"
          onDoubleClick={event => {
            event.stopPropagation();
            // 子画布：双击标题文字重命名；标题条其余区域双击回到逆向。
            if (node.type === 'subgraph' && !(event.target instanceof Element && event.target.closest('.workflow-node__title-text,.workflow-node__title-edit-icon'))) { onDoubleClick?.(); return; }
            if (onChangeTitle) setEditingTitle(true);
          }}
          title={onChangeTitle ? (language === 'en' ? 'Double-click to rename' : '双击重命名') : undefined}
        >
          <TitleIcon size={12} />
          {node.metadata.pinned && <span className="workflow-node__status-pill workflow-node__status-pill--pin" data-testid="workflow-node-pinned" title={language === 'en' ? 'Pinned' : '已钉选'}><Pin size={9} /></span>}
          {node.isLocked && <span className="workflow-node__status-pill workflow-node__status-pill--lock" data-testid="workflow-node-locked" title={language === 'en' ? 'Locked (right-click to unlock)' : '已锁定（右键可解锁）'}><Lock size={9} /></span>}
          {anchorCode && <span className="workflow-node__anchor-code" data-testid="anchor-code" title={language === 'en' ? 'Anchor code: reference it as @' + anchorCode : '锚点编号：可用 @' + anchorCode + ' 引用'}>{anchorCode}</span>}
          <span className="workflow-node__title-text">{localizeWorkflowNodeTitle(node.title, language)}</span>
          <Pencil className="workflow-node__title-edit-icon" size={11} />
          {cameraBadge && <span className="workflow-node__status-pill workflow-node__status-pill--camera" data-testid="workflow-node-camera-badge" title={cameraBadge}><Camera size={9} />{cameraBadge}</span>}
          {mediaDimensions && <span className="workflow-node__title-meta">{mediaDimensions}</span>}
          {node.anchor && (
            <button
              type="button"
              className={`workflow-node__anchor-chip${node.anchor.approved ? ' is-approved' : ''}`}
              data-testid="anchor-approval-toggle"
              data-workflow-overlay
              aria-pressed={node.anchor.approved}
              disabled={!onToggleAnchorApproval}
              title={node.anchor.approved
                ? (language === 'en' ? 'Revoke approval: downstream shots stop using this anchor' : '取消批准：下游镜头将不再使用该锚点')
                : (language === 'en' ? 'Approve: shots will reference this anchor' : '批准：镜头生成时自动引用该锚点')}
              onPointerDown={event => event.stopPropagation()}
              onDoubleClick={event => event.stopPropagation()}
              onClick={event => { event.stopPropagation(); onToggleAnchorApproval?.(); }}
            >
              {node.anchor.approved && <Check size={11} />}
              {node.anchor.approved
                ? (language === 'en' ? 'Approved' : '已批准')
                : (language === 'en' ? 'Approve' : '批准锚点')}
            </button>
          )}
        </div>
      )}
      <div className="workflow-node__body">
        {plugin
          ? pluginContext
            ? <WorkflowPluginErrorBoundary key={`${plugin.pluginId}:${plugin.version}`} pluginTitle={plugin.title}>
                <WorkflowPluginSurface plugin={plugin} pluginContext={pluginContext} />
              </WorkflowPluginErrorBoundary>
            : <div className="workflow-node__empty"><FileText size={26} /><span>插件未启用</span></div>
          : <>
        {isMedia && (media.url || hasMediaReference) && <div className="workflow-node__drag-handle" data-workflow-drag-handle />}
        {node.type === 'image' && (media.url
          ? <><img src={media.url} alt={node.title} draggable={false} data-workflow-media-preview style={{ filter: buildCssFilter(node.metadata.filters) }} />{lassoActive && onLassoDone ? <WorkflowNodeLasso width={node.metadata.naturalWidth} height={node.metadata.naturalHeight} language={language} onDone={onLassoDone} /> : mediaActions}</>
          : <div className="workflow-node__empty"><ImageIcon size={30} /><span>{mediaError || (language === 'en' ? 'Drop an image here' : '拖入图片')}</span>{regrantAction || <button type="button" className="workflow-node__empty-cta" onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); mediaInput.current?.click(); }}><Upload size={12} />{language === 'en' ? 'Upload' : '上传'}</button>}<span className="workflow-node__empty-hint">{language === 'en' ? 'or describe it in the prompt bar' : '或在下方输入框描述生成'}</span>{mediaActions}</div>)}
        {node.type === 'video' && (hasMediaReference
          ? previewPlaceholder
            ? <>{previewPlaceholder}{mediaActions}</>
            : videoActive
            ? media.url && !videoDecodeError
              ? <>
                <video
                  ref={videoRef}
                  className="workflow-node__video"
                  src={media.url}
                  poster={posterMedia.url || undefined}
                  preload="metadata"
                  playsInline
                  crossOrigin="anonymous"
                  onLoadedMetadata={event => {
                    event.currentTarget.volume = videoVolume;
                    setVideoDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0);
                    // 不支持的视频编码在 Chrome 里只解出音轨：videoWidth 为 0，画面永远黑屏。
                    if (event.currentTarget.videoWidth === 0) setVideoDecodeError(videoDecodeMessage);
                  }}
                  onError={() => setVideoDecodeError(videoDecodeMessage)}
                  onDurationChange={event => setVideoDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)}
                  onTimeUpdate={event => setVideoCurrentTime(event.currentTarget.currentTime)}
                  onPlay={() => setVideoPlaying(true)}
                  onPause={() => setVideoPlaying(false)}
                  onEnded={() => setVideoPlaying(false)}
                  onClick={event => { event.stopPropagation(); void toggleVideo(); }}
                />
                {trimEditing && onTrimConfirm && onTrimCancel ? (
                  <WorkflowVideoTrimBar
                    videoRef={videoRef}
                    durationSec={videoDuration}
                    currentTimeSec={videoCurrentTime}
                    busy={trimBusy}
                    language={language === 'en' ? 'en' : 'zh'}
                    onConfirm={onTrimConfirm}
                    onCancel={onTrimCancel}
                  />
                ) : <div className="workflow-node__video-controls" data-workflow-overlay onPointerDown={event => event.stopPropagation()}>
                  <button type="button" aria-label={videoPlaying ? '暂停视频' : '播放视频'} onClick={() => void toggleVideo()}>
                    {videoPlaying ? <Pause size={13} fill="currentColor" /> : <Play size={13} fill="currentColor" />}
                  </button>
                  <time>{formatVideoTime(videoCurrentTime)}</time>
                  <input
                    type="range"
                    aria-label="视频进度"
                    min={0}
                    max={Math.max(videoDuration, 0.01)}
                    step="0.01"
                    value={Math.min(videoCurrentTime, Math.max(videoDuration, 0.01))}
                    style={{ '--workflow-video-progress': `${videoDuration > 0 ? (videoCurrentTime / videoDuration) * 100 : 0}%` } as CSSProperties}
                    onChange={event => {
                      const next = Number(event.target.value);
                      if (videoRef.current) videoRef.current.currentTime = next;
                      setVideoCurrentTime(next);
                    }}
                  />
                  <time>{formatVideoTime(videoDuration)}</time>
                  <div className="workflow-node__video-volume">
                    <button type="button" aria-label={videoVolume > 0 ? '静音视频' : '取消静音'} aria-expanded={volumeOpen} onClick={() => setVolumeOpen(open => !open)}>
                      {videoVolume > 0 ? <Volume2 size={14} /> : <VolumeX size={14} />}
                    </button>
                    {volumeOpen && <div className="workflow-node__video-volume-popover">
                      <input type="range" className="workflow-node__video-volume-slider" aria-label="视频音量" min={0} max={1} step={.01} value={videoVolume} onChange={event => updateVolume(Number(event.target.value))} />
                      <span>{Math.round(videoVolume * 100)}</span>
                    </div>}
                  </div>
                  {onExtractFrame && <div className="workflow-node__video-frame">
                    <button type="button" aria-label="视频截帧" aria-expanded={frameMenuOpen} onClick={() => setFrameMenuOpen(open => !open)}><Camera size={14} /></button>
                    {frameMenuOpen && <div className="workflow-node__video-frame-menu" role="menu" aria-label="视频截帧" {...frameMenuKeys}>
                      {([['first', '截取首帧'], ['last', '截取尾帧'], ['current', '截取当前帧']] as const).map(([position, label]) => <button key={position} type="button" role="menuitem" onClick={() => { onExtractFrame(position, position === 'current' ? videoCurrentTime : undefined); setFrameMenuOpen(false); }}>{label}</button>)}
                    </div>}
                  </div>}
                </div>}
                {mediaActions}
              </>
              : <div className="workflow-node__empty"><Video size={26} /><span>{videoDecodeError || mediaError || '正在加载视频'}</span>{regrantAction}{mediaActions}</div>
            : <>{posterMedia.url
              ? <img src={posterMedia.url} alt={`${node.title}${language === 'en' ? ' video poster' : ' 视频封面'}`} draggable={false} loading="lazy" data-workflow-media-preview />
              : <div className="workflow-node__empty workflow-video-placeholder" role="img" aria-label={`${node.title}${language === 'en' ? ' video preview' : ' 视频预览'}`} data-testid="workflow-video-placeholder" data-workflow-media-preview><Video size={26} /><span>{(language === 'en' ? 'Video preview' : '视频预览')}</span></div>}
              {onActivateMedia && <button type="button" className="workflow-node__video-activate" aria-label={(language === 'en' ? 'Load video player' : '加载视频播放器')} title={(language === 'en' ? 'Load video player' : '加载视频播放器')} data-workflow-overlay onPointerDown={event => event.stopPropagation()} onClick={onActivateMedia}><Play size={18} fill="currentColor" /></button>}
              {mediaActions}</>
          : <div className="workflow-node__empty"><Video size={30} /><span>{mediaError || (language === 'en' ? 'Drop a video here' : '拖入视频')}</span>{regrantAction || <button type="button" className="workflow-node__empty-cta" onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); mediaInput.current?.click(); }}><Upload size={12} />{language === 'en' ? 'Upload' : '上传'}</button>}<span className="workflow-node__empty-hint">{language === 'en' ? 'or describe it in the prompt bar' : '或在下方输入框描述生成'}</span>{mediaActions}</div>)}
        {node.type === 'audio' && (media.url
          ? <AudioNodeCard node={node} src={media.url} language={language} onTool={onAudioTool} />
          : <div className="workflow-node__empty"><Music2 size={26} /><span>{mediaError || (language === 'en' ? 'Audio node' : '音频节点')}</span>{regrantAction}{mediaActions}</div>)}
        {node.type === 'text' && <TextNodeBody value={node.metadata.content || ''} onChange={onChangeText} language={language} />}
        {node.type === 'script' && <ScriptNodeCard node={node} />}
        {/* 旧版 operation 节点只在撤销历史 / 外部导入残留时出现，下次加载迁移为直连结果节点。 */}
        {node.type === 'operation' && <OperationNodeCard node={node} onRun={onRun} onStop={onStop} onSelectTake={onSelectTake} language={language} layerPreview={layerPreview} />}
        {node.type === 'design' && <DesignNodeSurface node={node} language={language} />}
        {node.type === 'subgraph' && <SubgraphFrameSurface node={node} childCount={subgraphChildCount ?? 0} onToggleCollapse={onToggleCollapse} language={language} />}
          </>}
        {mediaDetails && <span className="workflow-node__media-details">{mediaDetails}</span>}
        {node.type !== 'operation' && node.metadata.operation && <div className="workflow-node__versions"><OperationVersionStrip node={node} onSelectTake={onSelectTake} language={language === 'en' ? 'en' : 'zho'} /></div>}
        <AnimatePresence initial={false}>
          {(status === 'loading' || (bootDoneHold && status === 'success')) && <WorkflowGenerationLoader key="generation-active" node={node} mode={status === 'loading' ? 'running' : 'done'} language={language} />}
          {status === 'error' && node.metadata.error && <WorkflowGenerationLoader key="generation-error" node={node} mode="error" language={language} onRetry={onRun} />}
        </AnimatePresence>
        {uploading && (
          <motion.div
            className="flv-generation-glass workflow-node__generation-glass"
            initial={{ opacity: 0 }}
            animate={{ opacity: [0.82, 1, 0.82] }}
            transition={{ duration: 2.2, repeat: Infinity, ease: 'easeInOut' }}
          >
            <motion.div
              className="workflow-node__shimmer"
              initial={{ x: '-120%' }}
              animate={{ x: '120%' }}
              transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut', repeatDelay: 0.5 }}
            />
            <span className="flv-generation-glass__status">{uploadLabel}<b>{uploadDetail}</b></span>
            {onCancelUpload && (
              <button
                type="button"
                data-workflow-overlay
                style={{ pointerEvents: 'auto', position: 'relative', marginLeft: 8, padding: '2px 10px', fontSize: 12, borderRadius: 6, border: '1px solid currentColor', background: 'transparent', color: 'inherit', cursor: 'pointer' }}
                onPointerDown={event => event.stopPropagation()}
                onClick={event => { event.stopPropagation(); onCancelUpload(); }}
              >
                {language === 'en' ? 'Cancel' : '取消'}
              </button>
            )}
          </motion.div>
        )}
      </div>
      <button type="button" className="workflow-resize" aria-label={language === 'en' ? `Resize ${node.title}` : `调整${node.title}大小`} title={language === 'en' ? 'Use arrow keys to resize' : '使用方向键调整大小'} onPointerDown={onResizeStart} onKeyDown={event => {
        const step = event.shiftKey ? 64 : 16;
        const deltas = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] } as const;
        const delta = deltas[event.key as keyof typeof deltas];
        if (!delta) return;
        event.preventDefault();
        event.stopPropagation();
        onKeyboardResize?.(delta[0], delta[1]);
      }} />
      {alternatesDock}
    </motion.div>
  );
}

const RUN_STATE_COPY = {
  en: {
    stale: 'Changed',
    reasons: { 'recipe-edited': 'Settings changed since this result. Run again to update.', 'upstream-stale': 'An upstream node is out of date.', 'upstream-newer': 'An upstream result is newer than this one.' },
    versions: 'Versions', newer: 'New version ready. Your selection is kept.', selectVersion: (label: string) => `Select ${label}`, inPlace: 'Earlier results were replaced in place',
  },
  zho: {
    stale: '已变更',
    reasons: { 'recipe-edited': '这个结果之后配置已修改，重新运行即可更新。', 'upstream-stale': '上游节点已过期。', 'upstream-newer': '上游结果比这个结果更新。' },
    versions: '版本', newer: '新版本已到，你的选择保持不变。', selectVersion: (label: string) => `选择 ${label}`, inPlace: '早期结果已原位覆盖',
  },
} as const;

const PRESENCE_COPY = {
  en: { actors: { agent: 'Agent', cli: 'CLI', operator: 'Host panel' }, edited: (actor: string, intent: string, revision: number) => `${actor} changed this at rev ${revision}${intent ? `: ${intent}` : ''}` },
  zho: { actors: { agent: 'Agent', cli: 'CLI', operator: '宿主面板' }, edited: (actor: string, intent: string, revision: number) => `${actor} 在 rev ${revision} 修改了这里${intent ? `：${intent}` : ''}` },
} as const;

function WorkflowPresenceChip({ presence, language }: { presence: WorkflowNodePresence; language: 'en' | 'zho' }) {
  const copy = PRESENCE_COPY[language];
  const actor = copy.actors[presence.actor];
  const title = copy.edited(actor, presence.intent, presence.revision);
  return <span className={`workflow-node__presence workflow-node__presence--${presence.actor}`} data-testid="workflow-node-presence" title={title} aria-label={title}><Bot size={10} aria-hidden="true" />{actor}</span>;
}

const HOST_SEND_COPY = {
  en: { requested: (host: string) => `Sent to ${host} · awaiting confirm`, imported: () => 'In Media Pool', rejected: () => 'Host rejected', unknown: () => 'Check Media Pool' },
  zho: { requested: (host: string) => `已发往 ${host} · 待确认`, imported: () => '已在 Media Pool', rejected: () => '宿主拒绝', unknown: () => '请检查 Media Pool' },
} as const;

function WorkflowHostSendChip({ status, host, language }: { status: 'requested' | 'imported' | 'rejected' | 'unknown'; host: string; language: 'en' | 'zho' }) {
  const label = HOST_SEND_COPY[language][status](host === 'resolve' ? 'Resolve' : host);
  return <span className={`workflow-node__host-send workflow-node__host-send--${status}`} data-testid="workflow-node-host-send" role="status">{label}</span>;
}

function WorkflowStaleBadge({ reason, language }: { reason?: WorkflowStaleReason; language: 'en' | 'zho' }) {
  const copy = RUN_STATE_COPY[language];
  const title = reason ? copy.reasons[reason] : copy.stale;
  return <span className="workflow-node__stale-badge" data-testid="workflow-node-stale" role="status" title={title} aria-label={`${copy.stale}: ${title}`}><RefreshCw size={10} aria-hidden="true" />{copy.stale}</span>;
}

function OperationVersionStrip({ node, onSelectTake, language }: { node: WorkflowNodeData; onSelectTake?: (takeId: string) => void; language: 'en' | 'zho' }) {
  const versions = listWorkflowOperationVersions(node);
  if (versions.length < 2) return null;
  const copy = RUN_STATE_COPY[language];
  const newerWaiting = versions.some(version => version.latest && !version.selected);
  return (
    <div className="workflow-operation-card__versions" data-testid="workflow-operation-versions" data-workflow-overlay role="group" aria-label={copy.versions}>
      {versions.map(version => (
        <button
          key={version.takeId}
          type="button"
          className={version.selected ? 'is-selected' : undefined}
          aria-pressed={version.selected}
          disabled={!version.selectable || !onSelectTake}
          title={version.selectable ? copy.selectVersion(version.label) : copy.inPlace}
          onPointerDown={event => event.stopPropagation()}
          onClick={event => { event.stopPropagation(); if (version.selectable) onSelectTake?.(version.takeId); }}
        >{version.label}</button>
      ))}
      {newerWaiting && <span className="workflow-operation-card__newer" role="status">{copy.newer}</span>}
    </div>
  );
}

function OperationNodeCard({ node, onRun, onStop, onSelectTake, language = 'zho', layerPreview }: { node: WorkflowNodeData; onRun: () => void; onStop?: () => void; onSelectTake?: (takeId: string) => void; language?: 'en' | 'zho'; layerPreview?: WorkflowLayerPreview }) {
  // 单张生成：结果媒体原位写在 operation 节点 metadata 上（storageKey/href），显示结果图。
  // Hook 必须无条件调用（提前 return 会改变 Hook 数量），operation 判断放在其后。
  const resultMedia = useWorkflowMediaUrl(node.metadata.storageKey, node.metadata.href);
  const operation = node.metadata.operation;
  if (!operation) return <div className="workflow-operation-card"><span>Operation 配方缺失</span></div>;
  const latestTake = operation.takes.at(-1);
  const parameterLabel = getWorkflowOperationCapability(operation.capabilityId).summarizeParameters(operation.recipe.parameters);
  const statusLabel = latestTake?.status === 'outdated_recipe' ? '旧配方结果'
    : latestTake?.status === 'canceled' ? '已停止'
    : latestTake?.status === 'error' ? '执行失败'
      : latestTake?.status === 'success' ? '已完成'
        : latestTake?.status === 'running' ? '执行中' : '待执行';
  if (resultMedia.url) {
    return (
      <div className="workflow-operation-card workflow-operation-card--result" data-testid="workflow-operation-card">
        {node.metadata.mimeType?.startsWith('video/')
          ? <video src={resultMedia.url} muted playsInline loop style={{ width: '100%', maxHeight: 260, objectFit: 'contain' }} data-workflow-media-preview />
          : <img src={resultMedia.url} alt={`${node.title} 生成结果`} draggable={false} loading="lazy" data-workflow-media-preview style={{ width: '100%', maxHeight: 260, objectFit: 'contain' }} />}
        <div className="workflow-operation-card__row"><strong>{parameterLabel}</strong><span>{statusLabel}</span></div>
        <OperationVersionStrip node={node} onSelectTake={onSelectTake} language={language} />
      <div className="workflow-operation-card__footer">
          <span>{operation.recipe.inputBindings?.length ?? 0} 输入 · {operation.takes.length} Take</span>
          {node.metadata.status === 'loading' && onStop
            ? <button type="button" data-workflow-overlay onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); onStop(); }}>{language === 'en' ? 'Stop' : '停止'}</button>
            : <button type="button" data-workflow-overlay onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); onRun(); }} disabled={node.metadata.status === 'loading'}>
                <Play size={11} fill="currentColor" />{latestTake?.status === 'error' ? '重试' : '运行'}
              </button>}
        </div>
      </div>
    );
  }
  return (
    <div className="workflow-operation-card" data-testid="workflow-operation-card">
      <div className="workflow-operation-card__row"><strong>{parameterLabel}</strong><span>{statusLabel}</span></div>
      {layerPreview?.candidates.length
        ? <WorkflowLayerCandidates key={layerPreview.takeId} preview={layerPreview} language={language} />
        : <p title={operation.recipe.promptDocument.text}>{operation.recipe.promptDocument.text || '无文本 Prompt · 参数型操作'}</p>}
      <OperationVersionStrip node={node} onSelectTake={onSelectTake} language={language} />
      <div className="workflow-operation-card__footer">
        <span>{operation.recipe.inputBindings?.length ?? 0} 输入 · {operation.takes.length} Take</span>
        {node.metadata.status === 'loading' && onStop
          ? <button type="button" data-workflow-overlay onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); onStop(); }}>{language === 'en' ? 'Stop' : '停止'}</button>
          : <button type="button" data-workflow-overlay onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); onRun(); }} disabled={node.metadata.status === 'loading'}>
              <Play size={11} fill="currentColor" />{latestTake?.status === 'error' ? '重试' : '运行'}
            </button>}
      </div>
    </div>
  );
}

function formatDuration(durationMs: number) {
  const seconds = Math.max(0, Math.round(durationMs / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function formatVideoTime(seconds: number) {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const minutes = Math.floor(safeSeconds / 60);
  return `${minutes}:${String(safeSeconds % 60).padStart(2, '0')}`;
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatShotSeconds(seconds: number) {
  return Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(1)}s`;
}

/** LibTV 式音频卡：内联工具条 + 波形 + 原生播放器。 */
function AudioNodeCard({ node, src, language, onTool }: {
  node: WorkflowNodeData;
  src: string;
  language: 'en' | 'zho';
  onTool?: (kind: 'trim' | 'speed' | 'pitch' | 'stem-split') => void;
}) {
  const zh = language === 'zho';
  const duration = node.metadata.durationMs ? `${Math.floor(node.metadata.durationMs / 60000)}:${String(Math.floor((node.metadata.durationMs % 60000) / 1000)).padStart(2, '0')}` : '';
  const actions: Array<{ kind: 'trim' | 'speed' | 'pitch' | 'stem-split'; label: string; icon: ReactNode }> = [
    { kind: 'trim', label: zh ? '截取' : 'Trim', icon: <Scissors size={13} /> },
    { kind: 'speed', label: zh ? '变速' : 'Speed', icon: <Gauge size={13} /> },
    { kind: 'pitch', label: zh ? '变调' : 'Pitch', icon: <Music2 size={13} /> },
    { kind: 'stem-split', label: zh ? '人声分离' : 'Stems', icon: <AudioLines size={13} /> },
  ];
  return (
    <div className="workflow-audio-card" data-workflow-overlay onPointerDown={event => event.stopPropagation()}>
      <div className="workflow-audio-card__tools">
        {actions.map(action => (
          <button key={action.kind} type="button" disabled={!onTool} onClick={() => onTool?.(action.kind)} title={action.label}>
            {action.icon}<span>{action.label}</span>
          </button>
        ))}
      </div>
      <div className="workflow-audio-card__wave" aria-hidden="true">
        {Array.from({ length: 42 }, (_, index) => <span key={index} style={{ height: `${18 + ((index * 37 + 19) % 64)}%` }} />)}
      </div>
      <audio src={src} controls preload="metadata" />
      <div className="workflow-audio-card__footer">
        <span className="workflow-audio-card__name">{node.metadata.name || node.title}</span>
        {duration && <span>{duration}</span>}
      </div>
    </div>
  );
}

function ScriptNodeCard({ node }: { node: WorkflowNodeData }) {
  const breakdown = node.metadata.scriptBreakdown;
  const shots = breakdown?.shots || [];
  const assetCount = breakdown?.assets?.length || 0;
  const completedShots = shots.filter(shot => shot.status === 'success').length;
  const totalSeconds = shots.reduce((sum, shot) => sum + (shot.durationSec || 0), 0);
  return (
    <div className="workflow-node__script-card">
      <div className="workflow-node__script-header">
        <Clapperboard size={16} />
        <span>{breakdown?.sourceText || shots.length ? '分镜表' : '空脚本'}</span>
        {shots.length > 0 && (
          <span className="workflow-node__script-stats">
            <span>{shots.length} 镜</span>
            {totalSeconds > 0 && <span>{formatShotSeconds(totalSeconds)}</span>}
            <span>{assetCount} 资产</span>
            <span>{completedShots}/{shots.length} 完成</span>
          </span>
        )}
      </div>
      {shots.length > 0 ? (
        <div className="workflow-node__script-table-wrap" onWheel={event => event.stopPropagation()}>
          <table className="workflow-node__script-table">
            <thead>
              <tr><th>镜号</th><th>时长</th><th>场景</th><th>画面描述</th><th>运镜</th><th>台词 / 音效</th></tr>
            </thead>
            <tbody>
              {shots.map(shot => (
                <tr key={shot.id} className={shot.status ? `is-${shot.status}` : undefined}>
                  <td className="is-index">{String(shot.index + 1).padStart(2, '0')}</td>
                  <td>{shot.durationSec ? formatShotSeconds(shot.durationSec) : '—'}</td>
                  <td>{shot.scene || '—'}</td>
                  <td className="is-desc">{shot.action || shot.imagePrompt || shot.imagePromptOverride || shot.videoPrompt || shot.videoPromptOverride || '—'}</td>
                  <td>{shot.camera || '—'}</td>
                  <td>{[shot.dialogue, shot.sfx].filter(Boolean).join(' / ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="workflow-node__script-empty">
          <FileText size={22} />
          <span>双击打开编辑器拆解剧本</span>
        </div>
      )}
    </div>
  );
}
