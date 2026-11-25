import { FAN_SPRING, fanPose } from '../ui/ImageFan';
import { BATCH_GRID_GAP, BATCH_STACK_SPRING, batchCellCloseTransition, batchCellOpenTransition, batchCellStackedPose } from './batchStackMotion';
import { workflowFitOnOpen } from './templates';
import { pickVideoFile, promptUndecodableVideo } from '../../services/undecodableVideoPrompt';
import { anchorApprovalPatch, deriveAnchorCodes } from '../../services/anchorApproval';
import { deriveWorkflowLayerPreview } from './layerPreview';
import { nanoid } from 'nanoid';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { TOOLBAR_OBSTACLE_SELECTOR, clampCenterIntoBand, visibleBand } from './toolbarVisibleBand';
import type { RefObject } from 'react';
import type { LassoPoint } from './lasso';
import type { DragEvent as ReactDragEvent, PointerEvent as ReactPointerEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Check, Download, History, Maximize2, Minimize2, Plus, Star, Undo2 } from 'lucide-react';
import { saveMediaUrl } from '../../services/desktopNetwork';
import type { AssetLibrary, PromptEnhanceMode, PromptEnhanceResult, UserApiKey } from '../../types';
import type { RouteFallbackResolution } from '../../services/routeMapping';
import { STUDIO_MEDIA_BATCH_DRAG_TYPE, STUDIO_MEDIA_DRAG_TYPE } from '../studio/StudioMediaBrowser';
import { useStudioHubStore } from '../../stores/useStudioHubStore';
import { mediaKindOf } from '../studio/assetLibraryShared';
import type { AssetSuggestion } from '../MentionList';
import type { MentionData } from '../MediaMentionExtension';
import { createWorkflowNode, scriptNodeHeight, WORKFLOW_NODE_SPECS } from './constants';
import { buildScriptMaterializeOps } from './scriptMaterialize';
import { inheritGenerationConfig } from '../../services/generationInheritance';
import { extractVideoFrame } from '../../services/videoFrameExtractor';
import { buildPreferenceEvent, recordPreferenceEvent } from '../../services/preferenceEvents';
import { applyWorkflowMutation, redoWorkflowDraftChangeSet, undoWorkflowDraftChangeSet, workflowDocumentOperationsFromFrames } from './draftAuthority';
import {
  discardWorkflowMediaRecord,
  ensureWorkflowVideoPoster,
  fitWorkflowMediaSize,
  generateWorkflowVideoPreview,
  ingestWorkflowMedia,
  loadWorkflowMediaBlob,
  workflowBlobToDataUrl,
  pruneWorkflowMedia,
  registerWorkflowMediaTransientReferences,
  releaseWorkflowMediaRecord,
  unregisterWorkflowMediaTransientReferences,
  useWorkflowMediaUrl,
  workflowMediaType,
  type WorkflowMediaRecord,
} from './media';
import { summarizeWorkflowOps, topoSort, validateWorkflowConnection } from './ops';
import { buildWorkflowPromptPasteOps } from './promptPaste';
import { WorkflowConnections } from './WorkflowConnections';
import { WorkflowContextMenu, type WorkflowContextMenuState } from './WorkflowContextMenu';
import { alignNodes, arrangeNodePositions, arrangementOrder, arrowNudge, distributeNodes, duplicateNodes, offsetNodes, sequencedFileNames } from './arrange';
import { pushAgentGroup } from '../../stores/useAgentGroupInboxStore';
import { buildTextAssetPrompt, canGenerateTextAssets, textAssetSpec } from './textAssets';
import { WorkflowCreateMenu, type WorkflowCreateMenuState } from './WorkflowCreateMenu';
import type { WorkflowSharedMedia } from './WorkflowConfigPanel';
import { WorkflowStoryboardView, WorkflowViewSwitch } from './WorkflowStoryboardView';
import { buildProductionBible, buildStoryboardView } from './productionBible';
import { WorkflowMiniMap } from './WorkflowMiniMap';
import { WorkflowQuickToggles } from './WorkflowQuickToggles';
import { WorkflowNode } from './WorkflowNode';
import { workflowNodePluginContextFromProject } from './nodePluginSdk';
import { isContextCardNode, saveContextCardEdit } from './contextCard';
import { agentSessionReferencesFromNodes, createAgentSessionCard, isAgentSessionNode, selectionBounds } from './agentSessionCard';
import { canvasAgentRequestId, pushCanvasAgentSend, useCanvasAgentStore } from '../../stores/useCanvasAgentStore';
import { MediaPreviewModal } from './MediaPreviewModal';
import { WorkflowAlternatesDock, workflowAlternatesExtent } from './WorkflowAlternatesDock';
import { WorkflowAlternatesStack } from './WorkflowAlternatesStack';
import { alternateAsNode, isAlternateMediaType, nodeAlternates, primaryVariantId, removeAlternates, splitAlternates, usesAlternateStack } from './batchAlternates';
import { WorkflowNodePromptBar, type WorkflowModelOptions } from './WorkflowNodePromptBar';
import type { PromptIntent } from './promptIntent';
import { WorkflowNodeToolbar, type WorkflowImageToolHandlers, type WorkflowVideoToolHandlers, type WorkflowAudioToolHandlers, type WorkflowAvSplitAudio } from './WorkflowNodeToolbar';
import { WorkflowImageToolDialogs, type WorkflowImageToolConfirmation, type WorkflowImageToolState } from './WorkflowImageToolDialogs';
import { WorkflowVideoToolDialogs, type WorkflowVideoToolConfirmation, type WorkflowVideoToolState } from './WorkflowVideoToolDialogs';
import { WorkflowAudioToolDialogs, type WorkflowAudioToolConfirmation, type WorkflowAudioToolState } from './WorkflowAudioToolDialogs';
import { ScriptNodeEditor } from './ScriptNodeEditor';
import { SlashMenu } from './SlashMenu';
import { buildShortcutApplyOps, type SlashShortcut } from './slashShortcuts';
import { copyWorkflowSelection, pasteWorkflowClip } from './canvasClipboard';
import { buildGroupCreateOps, buildUngroupOps, enclosingGroupId, fitGroupFrames, groupMemberIds, groupRunOrder, isGroupFrame } from './canvasGroups';
import { WorkflowToolbar, type WorkflowTool } from './WorkflowToolbar';
import { deriveWorkflowRunStates, planWorkflowStaleRerun } from './runState';
import { deriveWorkflowPresence } from './presence';
import { buildWorkflowHostSendPatch, listWorkflowHostClips, workflowHostSendEligibility } from './hostLink';
import { WorkflowHostStrip } from './WorkflowHostStrip';
import { selectWorkflowOperationTake } from './operations';
import { useWorkspaceStore } from '../../stores/useWorkspaceStore';
import { useReverseStore } from '../../stores/useReverseStore';
import { useProductionProjectionAdapter } from './useProductionProjectionAdapter';
import { composeImageGrid } from './gridComposer';
import { LIGHTING_PRESETS, buildRelightPrompt } from './LightingPresets';
import { isWorkflowGenerationActive } from '../../services/workflowGeneration';
import type { WorkflowConnection, WorkflowDocumentOperation, WorkflowNode as WorkflowNodeData, WorkflowNodeType, WorkflowPoint, WorkflowProject, WorkflowSnapshot, WorkflowViewport, ScriptShot } from './types';
import {
  runWorkflowCropOperation,
  runWorkflowImageEditOperation,
  runWorkflowOutpaintOperation,
  runWorkflowMoveObjectOperation,
  runWorkflowLayerOperation,
  runWorkflowRemoveBackgroundOperation,
  runWorkflowRotateOperation,
  runWorkflowVectorizeOperation,
  runWorkflowSplitGridOperation,
  runWorkflowSplitLayersOperation,
  runWorkflowUpscaleOperation,
  type WorkflowImageToolOutcome,
  type WorkflowImageOperationRuntime,
} from '../../services/workflowImageOperations';
import {
  runWorkflowVideoAvSplitOperation,
  runWorkflowVideoExtractFrameOperation,
  runWorkflowVideoMergeOperation,
  runWorkflowVideoTrimOperation,
} from '../../services/workflowVideoOperations';
import { loadAutoMediaDeriveSettings, planAutoMediaDerivations, saveAutoMediaDeriveSettings, type AutoMediaDeriveSettings } from '../../services/autoMediaDerive';
import { runWorkflowAudioPitchOperation, runWorkflowAudioSpeedOperation, runWorkflowAudioStemSplitOperation, runWorkflowAudioTrimOperation } from '../../services/workflowAudioOperations';
import { exportMediaArchive } from '../../utils/batchMediaExport';
import { exportWorkflowCanvas, pickWorkflowExportNodes, type WorkflowCanvasExportFormat } from './canvasExport';
import { addWorkflowSnapshot, createWorkflowSnapshot, removeWorkflowSnapshot, workflowSnapshotFrame } from './snapshots';
import { actorFromDraftActor, describeChangeSet, timelineSentence } from './timeline';
import { useToolSession } from './useToolSession';
import { computeAutoLayout } from './layoutAlgorithm';
import { usePromptHistoryStore } from '../../stores/usePromptHistoryStore';
import { useClipboardStore, type ClipItem } from '../../stores/useClipboardStore';
import { displayError } from '../../services/displayError';

type Frame = Pick<WorkflowProject, 'nodes' | 'connections'>;
type SelectionBox = { start: WorkflowPoint; current: WorkflowPoint; additive: boolean; initialIds: string[] };
/** 拖拽过程中的预览状态：只改本地渲染，松手后才写回项目存储。 */
type InteractionPreview =
  | { kind: 'node'; positions: Map<string, WorkflowPoint> }
  | { kind: 'resize'; id: string; width: number; height: number };
type Interaction = { pointerId: number } & (
  | { type: 'node'; start: WorkflowPoint; positions: Map<string, WorkflowPoint>; frame: Frame; moved: boolean; batchId?: string; preview?: Map<string, WorkflowPoint> }
  | { type: 'resize'; id: string; start: WorkflowPoint; width: number; height: number; frame: Frame; moved: boolean; preview?: { width: number; height: number } }
  | { type: 'pan'; start: WorkflowPoint; viewport: WorkflowViewport }
  | { type: 'selection'; box: SelectionBox }
  | { type: 'connection'; originId: string; direction: 'out' | 'in' });
type ConnectionDropTarget = { nodeId: string | null; isNearNode: boolean; reason?: string };

const NODE_ACTION_TARGET = 'button,textarea,input,select,[contenteditable="true"],[role="dialog"],[data-workflow-overlay],.workflow-toolbar';
const BLOCKED_TARGET = `${NODE_ACTION_TARGET},video,audio`;
const EDITABLE_TARGET = 'textarea,input,select,video,audio,[contenteditable="true"]';
const SPACE_BLOCKED_TARGET = `${EDITABLE_TARGET},[role="menu"],[role="dialog"]`;
// Delete/Backspace 只在画布本身生效：对话框、菜单里的按键不能删掉背后的节点。
const DELETE_BLOCKED_TARGET = `${SPACE_BLOCKED_TARGET},[role="alertdialog"],[aria-modal="true"]`;
const CONNECTION_NODE_PADDING = 24;
const CONNECTION_HANDLE_RADIUS = 18;
/** 视口裁剪留出的世界坐标边距，避免节点刚滑出屏幕就被卸载。 */
const VIEWPORT_CULL_MARGIN = 480;
function sameIds(a: string[], b: string[]) {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

function useElementSize<T extends HTMLElement>(ref: RefObject<T | null>) {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => {
      const next = { width: element.clientWidth, height: element.clientHeight };
      setSize(previous => previous && previous.width === next.width && previous.height === next.height ? previous : next);
    };
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return size;
}

function workflowDropFiles(dataTransfer: DataTransfer) {
  const files = Array.from(dataTransfer.files || []);
  if (files.length) return files;
  return Array.from(dataTransfer.items || [])
    .filter(item => item.kind === 'file')
    .map(item => item.getAsFile())
    .filter((file): file is File => Boolean(file));
}

function isWorkflowSharedMedia(value: unknown): value is WorkflowSharedMedia {
  if (typeof value !== 'object' || value === null) return false;
  const media = value as Partial<WorkflowSharedMedia>;
  // `local-folder:` hrefs can carry audio; the shared-media type field is only
  // a hint — the non-http path resolves the real MIME from the File it loads.
  return typeof media.id === 'string' && media.id.length > 0
    && typeof media.href === 'string' && media.href.length > 0
    && ['image', 'video', 'audio'].includes(String(media.type));
}

/** 多选拖拽：同一 DataTransfer 同时带单条（兼容旧路径）和整组。 */
function workflowDropSharedMediaBatch(dataTransfer: DataTransfer): WorkflowSharedMedia[] {
  try {
    const raw = dataTransfer.getData(STUDIO_MEDIA_BATCH_DRAG_TYPE);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isWorkflowSharedMedia) : [];
  } catch {
    return [];
  }
}

function workflowDropSharedMedia(dataTransfer: DataTransfer): WorkflowSharedMedia | null {
  try {
    const raw = dataTransfer.getData(STUDIO_MEDIA_DRAG_TYPE);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isWorkflowSharedMedia(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function WorkflowVideoPreview({ node, className }: { node: WorkflowNodeData; className?: string }) {
  const poster = useWorkflowMediaUrl(node.metadata.posterStorageKey, node.metadata.poster);
  return poster.url
    ? <img src={poster.url} alt={`${node.title} 视频封面`} className={className} draggable={false} loading="lazy" data-workflow-media-preview />
    : <div className={`${className || ''} workflow-video-placeholder`} role="img" aria-label={`${node.title} 视频预览`} data-testid="workflow-video-placeholder" data-workflow-media-preview>视频预览</div>;
}

function WorkflowBatchStackLayer({ node, slot }: { node?: WorkflowNodeData; slot: number }) {
  const media = useWorkflowMediaUrl(
    !node || node.type === 'video' ? undefined : node.metadata.storageKey,
    !node || node.type === 'video' ? undefined : node.metadata.href,
  );
  return (
    <motion.div className="workflow-batch-stack__layer" style={{ zIndex: 1 + (1 - slot) }} variants={{ rest: fanPose(slot, false), hover: fanPose(slot, true) }} transition={FAN_SPRING}>
      {media.url && <img src={media.url} alt="" draggable={false} />}
    </motion.div>
  );
}

function WorkflowBatchStack({ head, others = [], count, historyOpen = false, onPointerDown, onExpand }: {
  head: WorkflowNodeData;
  others?: WorkflowNodeData[];
  count: number;
  historyOpen?: boolean;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onExpand: () => void;
}) {
  const media = useWorkflowMediaUrl(
    head.type === 'video' ? undefined : head.metadata.storageKey,
    head.type === 'video' ? undefined : head.metadata.href,
  );
  const unit = head.type === 'video' ? '个' : '张';
  // 斜叠：另外两张结果左右斜出在主图之后，悬停时散开（与 ImageFan 同一套姿态和弹簧，DESIGN.md §9.5）。
  return (
    <motion.div
      className="workflow-batch-stack"
      style={{ x: head.position.x, y: head.position.y, width: head.width, height: head.height }}
      variants={{ rest: { opacity: 1, scale: 1 }, hover: { opacity: 1, scale: 1.012 } }}
      initial={{ opacity: 0, scale: 0.94 }}
      animate="rest"
      whileHover="hover"
      exit={{ opacity: 0, transition: { duration: 0.12 } }}
      transition={BATCH_STACK_SPRING}
      onPointerDown={onPointerDown}
      onDoubleClick={event => { event.stopPropagation(); onExpand(); }}
    >
      <WorkflowBatchStackLayer node={others[0]} slot={0} />
      <WorkflowBatchStackLayer node={others[1]} slot={1} />
      {head.type === 'video'
        ? <WorkflowVideoPreview node={head} className="workflow-batch-stack__preview" />
        : media.url && <img src={media.url} alt={head.title} className="workflow-batch-stack__preview" draggable={false} />}
      <div className="workflow-batch-stack__title"><span>{head.title}</span></div>
      <button type="button" className={'workflow-batch-stack__expand' + (historyOpen ? ' is-active' : '')} data-workflow-overlay title={count > 4 ? '生成历史' : '展开全部结果'} aria-pressed={count > 4 ? historyOpen : undefined} onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); onExpand(); }} aria-label={count > 4 ? '查看生成历史（' + count + ' 个结果）' : '展开 ' + count + ' 个结果'}>
        {count > 4 ? <History size={12} /> : <Maximize2 size={12} />}<span>{count + unit}</span>
      </button>
    </motion.div>
  );
}

function WorkflowBatchCell({ node, index, count, column, row, cellWidth, cellHeight, primary, onCollapse, onSetPrimary, onPointerDown, language }: {
  node: WorkflowNodeData;
  index: number;
  count: number;
  column: number;
  row: number;
  cellWidth: number;
  cellHeight: number;
  primary: boolean;
  onCollapse: () => void;
  onSetPrimary: (nodeId: string) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  language?: 'en' | 'zho';
}) {
  const en = language === 'en';
  const preview = useWorkflowMediaUrl(
    node.type === 'video' ? undefined : node.metadata.storageKey,
    node.type === 'video' ? undefined : node.metadata.href,
  );
  const download = useWorkflowMediaUrl(node.metadata.storageKey, node.metadata.href);
  const left = column * (cellWidth + BATCH_GRID_GAP);
  const top = row * (cellHeight + BATCH_GRID_GAP);
  // 展开时从叠放位置（主图所在格）弹出到网格位；收起时反向飞回叠放位置（与首图节点上的备选叠放共用，batchStackMotion.ts）。
  const stacked = batchCellStackedPose(index, left, top);
  return (
    <motion.div
      className={'workflow-batch-cell' + (primary ? ' is-primary' : '')}
      data-testid="workflow-batch-cell"
      style={{ left, top, width: cellWidth, height: cellHeight, zIndex: count - index }}
      initial={stacked}
      animate={{ x: 0, y: 0, scale: 1, opacity: 1, transition: batchCellOpenTransition(index) }}
      exit={{ ...stacked, transition: batchCellCloseTransition(index, count) }}
      onPointerDown={onPointerDown}
    >
      {node.type === 'video'
        ? <WorkflowVideoPreview node={node} className="workflow-batch-cell__media" />
        : preview.url && <img src={preview.url} alt={node.title} className="workflow-batch-cell__media" draggable={false} />}
      {primary && <span className="workflow-batch-cell__badge"><Check size={11} />{en ? 'Primary' : '主图'}</span>}
      <div className="workflow-batch-cell__actions" data-workflow-overlay onPointerDown={event => event.stopPropagation()}>
        <button type="button" title={en ? 'Download' : '下载'} aria-label={en ? 'Download result ' + (index + 1) : '下载第 ' + (index + 1) + ' 个结果'} disabled={!download.url} onClick={event => { event.stopPropagation(); if (!download.url) return; void saveMediaUrl(download.url, node.metadata.name || node.title || node.id).catch(error => console.warn('[Workflow] Batch item download failed.', error)); }}><Download size={12} />{en ? 'Download' : '下载'}</button>
        {primary
          ? <button type="button" title={en ? 'Collapse results' : '收起结果'} aria-label={en ? 'Collapse results' : '收起结果'} onClick={event => { event.stopPropagation(); onCollapse(); }}><Minimize2 size={12} />{en ? 'Collapse' : '收起'}</button>
          : <button type="button" title={en ? 'Set as primary' : '设为主图'} onClick={event => { event.stopPropagation(); onSetPrimary(node.id); }}><Star size={12} />{en ? 'Set as primary' : '设为主图'}</button>}
      </div>
    </motion.div>
  );
}

// LibTV 式展开：以主图为左上角铺成网格（≤4 两列，更多三列），每格带 下载 / 设为主图，主图格带 收起。
function WorkflowBatchGallery({ group, onCollapse, onSetPrimary, onPointerDown, language }: {
  group: WorkflowNodeData[];
  onCollapse: () => void;
  onSetPrimary: (nodeId: string) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  language?: 'en' | 'zho';
}) {
  const root = group.find(node => node.batchIndex === 0) || group[0];
  const primaryId = root.metadata.primaryImageId || root.id;
  const head = group.find(node => node.id === primaryId) || root;
  const ordered = [head, ...group.filter(node => node.id !== head.id)];
  const columns = ordered.length <= 4 ? 2 : 3;
  const rows = Math.ceil(ordered.length / columns);
  const cellWidth = head.width;
  const cellHeight = head.height;
  return (
    <motion.div
      className="workflow-batch-gallery"
      data-testid="workflow-batch-gallery"
      style={{ x: head.position.x, y: head.position.y, width: columns * cellWidth + (columns - 1) * BATCH_GRID_GAP, height: rows * cellHeight + (rows - 1) * BATCH_GRID_GAP }}
      initial={{ opacity: 1 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 1 }}
      onPointerDown={onPointerDown}
    >
      {ordered.map((node, index) => (
        <WorkflowBatchCell
          key={node.id}
          node={node}
          index={index}
          count={ordered.length}
          column={index % columns}
          row={Math.floor(index / columns)}
          cellWidth={cellWidth}
          cellHeight={cellHeight}
          primary={node.id === primaryId}
          onCollapse={onCollapse}
          onSetPrimary={onSetPrimary}
          onPointerDown={onPointerDown}
          language={language}
        />
      ))}
    </motion.div>
  );
}

function WorkflowBatchHistoryThumb({ node, index, primary, onSelect }: { node: WorkflowNodeData; index: number; primary: boolean; onSelect: () => void }) {
  const preview = useWorkflowMediaUrl(
    node.type === 'video' ? undefined : node.metadata.storageKey,
    node.type === 'video' ? undefined : node.metadata.href,
  );
  return (
    <motion.button
      type="button"
      className={'workflow-batch-history__thumb' + (primary ? ' is-primary' : '')}
      title={primary ? '当前主图' : '设为主图'}
      aria-label={'第 ' + (index + 1) + ' 个结果' + (primary ? '（主图）' : '，设为主图')}
      aria-pressed={primary}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0, transition: { delay: Math.min(index, 12) * 0.02 } }}
      onClick={onSelect}
    >
      {node.type === 'video' ? <WorkflowVideoPreview node={node} /> : preview.url && <img src={preview.url} alt={node.title} draggable={false} loading="lazy" />}
      {primary && <span className="workflow-batch-history__mark"><Check size={11} /></span>}
    </motion.button>
  );
}

// LibTV 式生成历史：超过 4 个结果不铺网格，叠放主图保留在原位，右侧弹出可滚动的三列缩略图面板，点缩略图切换主图。
function WorkflowBatchHistory({ head, group, onClose, onSetPrimary }: {
  head: WorkflowNodeData;
  group: WorkflowNodeData[];
  onClose: () => void;
  onSetPrimary: (nodeId: string) => void;
}) {
  return (
    <motion.div
      className="workflow-batch-history"
      data-testid="workflow-batch-history"
      data-workflow-overlay
      role="dialog"
      aria-label={'生成历史，共 ' + group.length + ' 个结果'}
      style={{ left: head.position.x + head.width + 16, top: head.position.y, height: Math.max(head.height, 360) }}
      initial={{ opacity: 0, x: -20, scale: 0.97 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: -20, scale: 0.97, transition: { duration: 0.14 } }}
      transition={{ type: 'spring', stiffness: 420, damping: 34 }}
      onPointerDown={event => event.stopPropagation()}
      onWheel={event => event.stopPropagation()}
    >
      <div className="workflow-batch-history__header">
        <span className="workflow-batch-history__title">生成历史<span className="workflow-batch-history__count">{group.length}</span></span>
        <button type="button" title="收起生成历史" aria-label="收起生成历史" onClick={onClose}><Minimize2 size={13} /></button>
      </div>
      <div className="workflow-batch-history__grid isl-scrollbar">
        {group.map((node, index) => (
          <WorkflowBatchHistoryThumb key={node.id} node={node} index={index} primary={node.id === head.id} onSelect={() => { if (node.id !== head.id) onSetPrimary(node.id); }} />
        ))}
      </div>
    </motion.div>
  );
}

/** Prompt Bar 的目标：图片 / 视频节点，以及带生成记录的结果节点（含音频处理结果，可改参数重跑）。 */
function workflowPromptBarTarget(node: WorkflowNodeData): boolean {
  return node.type === 'image' || node.type === 'video' || node.type === 'operation' || Boolean(node.metadata.operation);
}

export function InfiniteWorkflow({
  project,
  updateProject,
  onRunNode,
  onStopNode,
  onSaveWorkflowMedia,
  onReversePrompt,
  imageTools,
  onOpenAgent,
  t = key => key,
  theme = 'light',
  language = 'zho',
  userApiKeys = [],
  confirmRouteFallback,
  dynamicModelOptions = { text: [], image: [], video: [] },
  onOpenSettings,
  onEnhancePrompt,
  isEnhancingPrompt,
  agentOpen,
  assetLibrary,
  focusNodeRequest,
  onOpenAssets,
  onNotify,
}: {
  project: WorkflowProject;
  updateProject: (patch: Partial<WorkflowProject>) => void;
  onRunNode: (nodeId: string, promptIntent?: PromptIntent) => void;
  onStopNode?: (nodeId: string) => void;
  onSaveWorkflowMedia?: (nodeId: string) => void;
  onReversePrompt?: (imageHref: string, mimeType: string, width?: number, height?: number) => Promise<string>;
  imageTools?: WorkflowImageToolHandlers;
  onOpenAgent?: () => void;
  agentOpen?: boolean;
  t?: (key: string, ...args: any[]) => string;
  theme?: 'light' | 'dark';
  language?: 'en' | 'zho';
  userApiKeys?: UserApiKey[];
  confirmRouteFallback?: (resolution: RouteFallbackResolution) => boolean | Promise<boolean>;
  dynamicModelOptions?: WorkflowModelOptions;
  onOpenSettings?: () => void;
  onEnhancePrompt?: (payload: { prompt: string; mode: PromptEnhanceMode; stylePreset?: string }) => Promise<PromptEnhanceResult>;
  isEnhancingPrompt?: boolean;
  assetLibrary?: AssetLibrary;
  focusNodeRequest?: { nodeId: string; nonce: number };
  onOpenAssets?: () => void;
  /** Surface a transient status toast (e.g. "已删除节点 — Ctrl+Z 撤销"). */
  onNotify?: (message: string, level?: 'info' | 'success' | 'warning' | 'error') => void;
}) {
  useProductionProjectionAdapter(project.id);
  const rootRef = useRef<HTMLDivElement>(null);
  const rootSize = useElementSize(rootRef);
  const worldRef = useRef<HTMLDivElement>(null);
  const projectRef = useRef(project);
  const viewportRef = useRef(project.viewport);
  const selectedIdsRef = useRef(project.selectedNodeIds || []);
  const interactionRef = useRef<Interaction | null>(null);
  const pendingMoveRef = useRef<{ clientX: number; clientY: number; pointerId: number } | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const focusAnimRef = useRef<number | null>(null);
  const spacePressedRef = useRef(false);
  const createMenuOpenerRef = useRef<HTMLElement | null>(null);
  // 画布剪贴板放在 useClipboardStore（切项目不清空、跨项目可粘贴）；这里只留一个引用方便同步读取。
  const clipboardRef = useRef<WorkflowNodeData[]>(useClipboardStore.getState().workflowClip?.nodes || []);
  const mountedRef = useRef(true);
  const mousePosRef = useRef({ x: 0, y: 0 });
  const replaceSequenceRef = useRef(new Map<string, number>());
  const promptIntentRef = useRef<PromptIntent | null>(null);
  const mediaReferenceOwnerRef = useRef(`workflow-editor-${nanoid()}`);
  const [tool, setTool] = useState<WorkflowTool>('select');
  const [wheelMode, setWheelMode] = useState<'pan' | 'zoom'>('pan');
  const [minimapOpen, setMinimapOpen] = useState(false);
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [edgesVisible, setEdgesVisible] = useState(true);
  const snapEnabledRef = useRef(true);
  snapEnabledRef.current = snapEnabled;
  const [snapGuides, setSnapGuides] = useState<{ x?: number[]; y?: number[] } | null>(null);
  const [layoutToast, setLayoutToast] = useState<{ prev: WorkflowNodeData[]; deadline: number } | null>(null);
  const [clipboardVersion, setClipboardVersion] = useState(0);
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>(project.selectedNodeIds || []);
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
  const [selectionBox, setSelectionBox] = useState<SelectionBox | null>(null);
  const [connectionDrag, setConnectionDrag] = useState<{ sourceId: string; point: WorkflowPoint; targetId: string | null; direction: 'out' | 'in'; local: WorkflowPoint } | null>(null);
  const [keyboardConnectionSourceId, setKeyboardConnectionSourceId] = useState<string | null>(null);
  const [createMenu, setCreateMenu] = useState<WorkflowCreateMenuState | null>(null);
  const [contextMenu, setContextMenu] = useState<WorkflowContextMenuState | null>(null);
  const [renameSignal, setRenameSignal] = useState<{ nodeId: string; nonce: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [focusBadge, setFocusBadge] = useState(false);
  const [overlayHidden, setOverlayHidden] = useState(false);
  // 拿起 / 放下：真正进入拖拽时标记被拖节点，松手清空，节点据此做抬起与落地动画。
  const [liftedNodeIds, setLiftedNodeIds] = useState<Set<string> | null>(null);
  const [promptFocusSignal, setPromptFocusSignal] = useState(0);
  const { tool: imageTool, busy: imageToolBusy, error: imageToolError, active: imageToolActive, controls: imageControls } = useToolSession<WorkflowImageToolState, Frame>();
  const [lassoNodeId, setLassoNodeId] = useState<string | null>(null);
  const [layerLassoPoints, setLayerLassoPoints] = useState<LassoPoint[] | undefined>(undefined);
  const { tool: videoTool, busy: videoToolBusy, error: videoToolError, active: videoToolActive, controls: videoControls } = useToolSession<WorkflowVideoToolState, Frame>();
  const { tool: audioTool, busy: audioToolBusy, error: audioToolError, active: audioToolActive, controls: audioControls } = useToolSession<WorkflowAudioToolState, Frame>();
  const [storyboardNodeIds, setStoryboardNodeIds] = useState<string[] | null>(null);
  const [expandedBatches, setExpandedBatches] = useState<Set<string>>(new Set());
  const [scriptEditorNodeId, setScriptEditorNodeId] = useState<string | null>(null);
  const [slashMenu, setSlashMenu] = useState<{ x: number; y: number } | null>(null);
  const [previewNode, setPreviewNode] = useState<WorkflowNodeData | null>(null);
  // 多结果画廊：ownerId = 首图节点；ids 给出时只对比这些备选（首图总在第一张）。条目每次从最新数据派生。
  const [galleryPreview, setGalleryPreview] = useState<{ ownerId: string; ids: string[] | null; index: number } | null>(null);
  const [collapsedAlternateDocks, setCollapsedAlternateDocks] = useState<Set<string>>(() => new Set());
  // 少量多结果的斜叠卡片默认收起；展开的首图节点 ID（纯界面状态，不入历史）。
  const [expandedAlternateStacks, setExpandedAlternateStacks] = useState<Set<string>>(() => new Set());
  const [activeMedia, setActiveMedia] = useState<{ projectId: string; nodeId: string } | null>(null);
  const [interactionPreview, setInteractionPreview] = useState<InteractionPreview | null>(null);
  const slashMenuRef = useRef<{ x: number; y: number } | null>(null);
  slashMenuRef.current = slashMenu;
  const toggleBatch = useCallback((batchId: string) => {
    setActiveMedia(null);
    setExpandedBatches(prev => {
      const next = new Set(prev);
      if (next.has(batchId)) next.delete(batchId); else next.add(batchId);
      return next;
    });
  }, []);

  // 拖拽/缩放只产生本地预览副本，存储与历史在松手时一次性提交（见 finishInteraction）。
  const displayNodes = useMemo(() => {
    if (!interactionPreview) return project.nodes;
    // 拖动 / 缩放成员时分组框实时跟着伸缩（松手提交时 draftAuthority 用同一个函数落盘）。
    if (interactionPreview.kind === 'node') {
      const { positions } = interactionPreview;
      const moved = project.nodes.map(node => {
        const position = positions.get(node.id);
        return position ? { ...node, position } : node;
      });
      return fitGroupFrames(moved, positions.keys());
    }
    const { id, width, height } = interactionPreview;
    return fitGroupFrames(project.nodes.map(node => node.id === id ? { ...node, width, height } : node), [id]);
  }, [interactionPreview, project.nodes]);

  projectRef.current = project;
  viewportRef.current = project.viewport;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (focusAnimRef.current !== null) window.cancelAnimationFrame(focusAnimRef.current);
      unregisterWorkflowMediaTransientReferences(mediaReferenceOwnerRef.current);
      void pruneWorkflowMedia();
    };
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => { mousePosRef.current = { x: e.clientX, y: e.clientY }; };
    window.addEventListener('mousemove', onMove);
    return () => window.removeEventListener('mousemove', onMove);
  }, []);

  useEffect(() => {
    registerWorkflowMediaTransientReferences(mediaReferenceOwnerRef.current, [
      project.nodes,
      ...(project.draftChangeSets || []).flatMap(changeSet => changeSet.nodeChanges.flatMap(change => [
        change.before ? [change.before] : [],
        change.after ? [change.after] : [],
      ])),
      clipboardRef.current,
    ]);
    void pruneWorkflowMedia();
  }, [clipboardVersion, project.draftChangeSets, project.nodes]);

  const patchProject = useCallback((patch: Partial<WorkflowProject>) => {
    const previousNodes = projectRef.current.nodes;
    projectRef.current = { ...projectRef.current, ...patch };
    if (patch.nodes) {
      registerWorkflowMediaTransientReferences(mediaReferenceOwnerRef.current, [
        previousNodes,
        projectRef.current.nodes,
      ]);
    }
    if (patch.viewport) viewportRef.current = patch.viewport;
    updateProject(patch);
  }, [updateProject]);

  const selectNodes = useCallback((ids: string[]) => {
    if (sameIds(selectedIdsRef.current, ids) && sameIds(projectRef.current.selectedNodeIds || [], ids)) return;
    selectedIdsRef.current = ids;
    setSelectedNodeIds(ids);
    patchProject({ selectedNodeIds: ids });
  }, [patchProject]);

  const closeCreateMenu = useCallback(() => {
    setCreateMenu(null);
    const opener = createMenuOpenerRef.current || rootRef.current;
    createMenuOpenerRef.current = null;
    opener?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (animationFrameRef.current !== null) window.cancelAnimationFrame(animationFrameRef.current);
    animationFrameRef.current = null;
    if (focusAnimRef.current !== null) window.cancelAnimationFrame(focusAnimRef.current);
    focusAnimRef.current = null;
    pendingMoveRef.current = null;
    setSelectedConnectionId(null);
    setSelectionBox(null);
    setConnectionDrag(null);
    setCreateMenu(null);
    // 切换项目即结束所有工具会话；旧事务的异步收尾不再持有会话，不会改动新会话。
    imageControls.reset();
    videoControls.reset();
    audioControls.reset();
    setActiveMedia(null);
    // 剪贴板不随项目切换清空（P1-6）：媒体按 durable artifact 引用，跨项目粘贴仍可用。
    replaceSequenceRef.current.clear();
    createMenuOpenerRef.current = null;
    interactionRef.current = null;
    setInteractionPreview(null);
  }, [audioControls, imageControls, project.id, videoControls]);

  useEffect(() => {
    const ids = project.selectedNodeIds || [];
    if (sameIds(selectedIdsRef.current, ids)) return;
    selectedIdsRef.current = ids;
    setSelectedNodeIds(ids);
  }, [project.id, project.selectedNodeIds]);

  useEffect(() => {
    if (!activeMedia) return;
    const activeNode = project.nodes.find(node => node.id === activeMedia.nodeId);
    if (activeMedia.projectId !== project.id
      || activeNode?.type !== 'video'
      || activeNode.isVisible === false
      || !(activeNode.metadata.storageKey || activeNode.metadata.href || activeNode.metadata.artifactRef?.taskId)) {
      setActiveMedia(null);
    }
  }, [activeMedia, project.id, project.nodes]);

  useEffect(() => {
    if (imageTool || videoTool || audioTool || previewNode || galleryPreview) setActiveMedia(null);
  }, [audioTool, galleryPreview, imageTool, previewNode, videoTool]);

  const currentFrame = useCallback((): Frame => ({
    nodes: projectRef.current.nodes,
    connections: projectRef.current.connections,
  }), []);

  const currentSnapshot = useCallback((): WorkflowSnapshot => ({
    projectId: projectRef.current.id,
    title: projectRef.current.title,
    nodes: projectRef.current.nodes,
    connections: projectRef.current.connections,
    selectedNodeIds: selectedIdsRef.current,
    viewport: viewportRef.current,
  }), []);

  const applyDraftProject = useCallback((next: WorkflowProject) => {
    patchProject({
      nodes: next.nodes,
      connections: next.connections,
      selectedNodeIds: next.selectedNodeIds,
      draftVersion: next.draftVersion,
      draftChangeSets: next.draftChangeSets,
      draftRedoStack: next.draftRedoStack,
      workflowMutationReceipts: next.workflowMutationReceipts,
    });
    selectedIdsRef.current = next.selectedNodeIds;
    setSelectedNodeIds(next.selectedNodeIds);
  }, [patchProject]);

  const pushHistory = useCallback((frame: Frame, nextFrame: Frame = currentFrame(), intent = '编辑画布') => {
    const current = projectRef.current;
    const recorded = applyWorkflowMutation({ ...current, nodes: frame.nodes, connections: frame.connections }, {
      projectId: current.id,
      expectedRevision: current.draftVersion || 1,
      mutationId: nanoid(),
      source: 'ui',
      intent,
      ops: workflowDocumentOperationsFromFrames(frame, nextFrame),
    });
    if (recorded.ok === false) return false;
    applyDraftProject(recorded.project);
    return true;
  }, [applyDraftProject, currentFrame]);

  const commitFrame = useCallback((nodes: WorkflowNodeData[], connections: WorkflowConnection[]) => {
    pushHistory(currentFrame(), { nodes, connections });
  }, [currentFrame, pushHistory]);

  // 导出：有选区只导出选区，否则导出全部可见节点。
  const exportCanvas = useCallback(async (format: WorkflowCanvasExportFormat) => {
    const nodes = pickWorkflowExportNodes(projectRef.current.nodes, selectedIdsRef.current);
    if (!nodes.length) {
      setNotice('画布中没有可导出的内容');
      return;
    }
    try {
      const saved = await exportWorkflowCanvas(nodes, format, 'Iris-' + projectRef.current.title);
      if (mountedRef.current) setNotice(saved ? '已导出 ' + format.toUpperCase() : '已取消导出。');
    } catch (error) {
      if (mountedRef.current) setNotice(displayError(error, '画布导出失败'));
    }
  }, []);

  // 快照：保存/删除只改项目字段；恢复走 pushHistory，与普通编辑一样可撤销。
  const saveSnapshot = useCallback((name: string) => {
    const current = projectRef.current;
    if (!current.nodes.length) {
      setNotice('画布为空，无需保存快照');
      return;
    }
    const snapshot = createWorkflowSnapshot({ nodes: current.nodes, connections: current.connections, viewport: viewportRef.current }, name);
    patchProject({ snapshots: addWorkflowSnapshot(current.snapshots, snapshot) });
    setNotice('已保存快照“' + snapshot.name + '”');
  }, [patchProject]);

  const restoreSnapshot = useCallback((id: string) => {
    const snapshot = projectRef.current.snapshots?.find(item => item.id === id);
    if (!snapshot) return;
    setNotice(pushHistory(currentFrame(), workflowSnapshotFrame(snapshot), '恢复快照')
      ? '已恢复快照“' + snapshot.name + '”，可撤销'
      : '快照恢复失败：画布已更新，请重试');
  }, [currentFrame, pushHistory]);

  const deleteSnapshot = useCallback((id: string) => {
    patchProject({ snapshots: removeWorkflowSnapshot(projectRef.current.snapshots, id) });
  }, [patchProject]);

  // 方向键连续微调只记一条撤销：按住期间只预览，松开方向键、按下其它键或窗口失焦时合并提交。
  // 提交被修订冲突拒绝时回退预览，保持可见工作流与草稿历史一致。
  const nudgeBaseRef = useRef<Frame | null>(null);
  const flushNudge = useCallback(() => {
    const base = nudgeBaseRef.current;
    if (!base) return;
    nudgeBaseRef.current = null;
    if (!pushHistory(base, currentFrame(), '移动节点')) patchProject({ nodes: base.nodes });
  }, [currentFrame, patchProject, pushHistory]);
  // 键盘监听会随依赖重新绑定，不能在其 cleanup 里提交；只在卸载时补交未完成的微调。
  const flushNudgeRef = useRef(flushNudge);
  flushNudgeRef.current = flushNudge;
  useEffect(() => () => flushNudgeRef.current(), []);

  // 视频封面只是派生缓存：补齐后直接写回 metadata，不产生撤销记录，也不推进草稿版本。
  const applyVideoPoster = useCallback((nodeId: string, posterStorageKey: string) => {
    const current = projectRef.current.nodes;
    const nodes = current.map(node => node.id === nodeId
      ? { ...node, metadata: { ...node.metadata, posterStorageKey } }
      : node);
    if (nodes.every((node, index) => node === current[index])) {
      releaseWorkflowMediaRecord(posterStorageKey);
      return;
    }
    patchProject({ nodes });
    releaseWorkflowMediaRecord(posterStorageKey);
  }, [patchProject]);

  // 封面请求由画布持有：节点被裁剪/卸载不会取消生成，也不会遗留无人引用的缓存。
  const posterRequestsRef = useRef(new Set<string>());
  const requestVideoPoster = useCallback((nodeId: string) => {
    if (posterRequestsRef.current.has(nodeId)) return;
    const node = projectRef.current.nodes.find(item => item.id === nodeId);
    if (!node || node.type !== 'video' || node.metadata.posterStorageKey || node.metadata.poster) return;
    if (!(node.metadata.storageKey || node.metadata.href || node.metadata.artifactRef?.taskId)) return;
    posterRequestsRef.current.add(nodeId);
    void ensureWorkflowVideoPoster({
      storageKey: node.metadata.storageKey,
      href: node.metadata.href,
      artifactRef: node.metadata.artifactRef,
    }).then(posterStorageKey => {
      if (!posterStorageKey) return;
      const target = projectRef.current.nodes.find(item => item.id === nodeId);
      if (!target || target.metadata.posterStorageKey || target.metadata.poster) {
        void discardWorkflowMediaRecord(posterStorageKey);
        return;
      }
      applyVideoPoster(nodeId, posterStorageKey);
    }).catch(() => undefined).finally(() => {
      posterRequestsRef.current.delete(nodeId);
    });
  }, [applyVideoPoster]);

  const autoLayout = useCallback(() => {
    const nodes = projectRef.current.nodes;
    if (!nodes.length) return;
    const positions = computeAutoLayout(nodes, projectRef.current.connections);
    if (!positions.size) return;
    const prev = nodes.map(node => ({ ...node, position: { ...node.position } }));
    const next = nodes.map(node => {
      const p = positions.get(node.id);
      if (!p) return node;
      // 缺尺寸的老数据一并写回类型默认值，保证渲染高度与布局一致（避免内容撑高导致重叠）。
      const spec = WORKFLOW_NODE_SPECS[node.type];
      return {
        ...node,
        position: { x: p.x, y: p.y },
        ...(node.width ? {} : { width: spec?.width || 320 }),
        ...(node.height ? {} : { height: spec?.height || 200 }),
      };
    });
    commitFrame(next, projectRef.current.connections);
    setLayoutToast({ prev, deadline: Date.now() + 6000 });
  }, [commitFrame]);

  const restoreLayout = useCallback(() => {
    // 副作用移出 setState updater（updater 必须是纯函数）：先读当前 toast、提交还原、再清空。
    if (!layoutToast) return;
    commitFrame(layoutToast.prev, projectRef.current.connections);
    setLayoutToast(null);
  }, [commitFrame, layoutToast]);

  useEffect(() => {
    if (!layoutToast) return;
    const remaining = layoutToast.deadline - Date.now();
    if (remaining <= 0) { setLayoutToast(null); return; }
    const timer = window.setTimeout(() => setLayoutToast(null), remaining);
    return () => window.clearTimeout(timer);
  }, [layoutToast]);

  const imageToolRuntime = useMemo<WorkflowImageOperationRuntime>(() => ({
    userApiKeys,
    confirmRouteFallback,
    getProject: () => projectRef.current,
    onProjectChange: next => {
      if (next.id !== projectRef.current.id) return;
      const current = projectRef.current;
      const result = applyWorkflowMutation(current, {
        projectId: current.id,
        expectedRevision: current.draftVersion || 1,
        mutationId: nanoid(),
        source: 'ui',
        intent: '提交 Workflow Operation 状态',
        ops: workflowDocumentOperationsFromFrames(
          { nodes: current.nodes, connections: current.connections },
          { nodes: next.nodes, connections: next.connections },
        ),
      });
      if (result.ok === false) throw new Error(result.error.message);
      applyDraftProject({ ...result.project, selectedNodeIds: next.selectedNodeIds });
    },
  }), [applyDraftProject, confirmRouteFallback, userApiKeys]);

  const openImageTool = useCallback((kind: WorkflowImageToolState['kind'], nodeId: string) => {
    if (imageControls.isLocked()) {
      setNotice('请先完成或关闭当前图片工具');
      return;
    }
    if (projectRef.current.nodes.find(node => node.id === nodeId)?.metadata.status === 'loading') return;
    const transaction = { id: nanoid(), projectId: projectRef.current.id, nodeId, frame: currentFrame() };
    if (kind !== 'remove-background') {
      imageControls.open({ kind, nodeId }, transaction);
      return;
    }
    imageControls.begin(transaction);
    void runWorkflowRemoveBackgroundOperation(transaction.projectId, nodeId, imageToolRuntime).then(result => {
      if (!imageControls.owns(transaction)) return;
      if (result.status === 'committed' && result.project.id === transaction.projectId && projectRef.current.id === transaction.projectId && result.project.nodes.some(node => node.id === transaction.nodeId)) {
        pushHistory(transaction.frame);
        setNotice('背景移除完成');
      }
    }).catch(error => {
      if (imageControls.owns(transaction)) setNotice(displayError(error, '背景移除失败'));
    }).finally(() => { imageControls.settle(transaction); });
  }, [currentFrame, imageControls, imageToolRuntime, pushHistory]);

  const builtInImageTools = useMemo<WorkflowImageToolHandlers>(() => ({
    crop: id => openImageTool('crop', id), filter: id => openImageTool('filter', id), upscale: id => openImageTool('upscale', id),
    removeBackground: id => openImageTool('remove-background', id), outpaint: id => openImageTool('outpaint', id), mask: id => openImageTool('mask', id), splitLayers: id => openImageTool('split', id),
    rotate: id => openImageTool('rotate', id), splitGrid: id => openImageTool('splitGrid', id), vectorize: id => openImageTool('vectorize', id),
    layer: id => {
      const target = projectRef.current.nodes.find(node => node.id === id);
      // 有媒体的图片节点先在节点内圈选，再进入参数弹窗；其余情况直接弹窗。
      if (target?.type === 'image' && (target.metadata.storageKey || target.metadata.href) && target.metadata.status !== 'loading' && !imageControls.isLocked()) {
        setLayerLassoPoints(undefined);
        setLassoNodeId(id);
        return;
      }
      openImageTool('layer', id);
    },
    storyboard: ids => { setStoryboardNodeIds(ids); openImageTool('storyboard', ids[0]); },
  }), [imageControls, openImageTool]);

  const toolHints = useMemo(() => {
    const keys = userApiKeys || [];
    const usable = keys.filter(key => key.status !== 'error');
    const hasVisionRoute = usable.some(key => key.capabilities?.includes('text'));
    const hasImageToolEndpoint = usable.some(key => key.capabilities?.includes('image') && Boolean(key.baseUrl));
    return {
      ...(hasVisionRoute ? {} : { 'reverse-prompt': '需要配置支持图片理解的文本模型' }),
      ...(hasImageToolEndpoint ? {} : { split: '需要配置支持 /split-layers 语义分层的图像工具端点' }),
    } satisfies Partial<Record<'reverse-prompt' | 'split', string>>;
  }, [userApiKeys]);

  const openVideoTool = useCallback((kind: WorkflowVideoToolState['kind'], nodeId: string, nodeIds?: string[]) => {
    if (videoControls.isLocked()) {
      setNotice('请先完成或关闭当前视频工具');
      return;
    }
    const target = projectRef.current.nodes.find(node => node.id === nodeId);
    // 打开前校验目标是有媒体的 video 节点：无媒体时对话框渲染 null，videoTool 置位后
    // 将没有任何 UI 能关闭它，所有工具入口被永久锁死。
    if (!target || target.type !== 'video' || !(target.metadata.storageKey || target.metadata.href || target.metadata.artifactRef?.taskId)) {
      setNotice('目标视频节点缺少媒体，无法使用视频工具');
      return;
    }
    if (target.metadata.status === 'loading') return;
    const transaction = { id: nanoid(), projectId: projectRef.current.id, nodeId, frame: currentFrame() };
    videoControls.open({ kind, nodeId, ...(nodeIds ? { nodeIds } : {}) }, transaction);
  }, [currentFrame, videoControls]);

  const handleExtractFrame = useCallback(async (id: string, position: 'first' | 'current' | 'last', currentTimeSec?: number) => {
    const node = projectRef.current.nodes.find(item => item.id === id);
    if (!node || node.type !== 'video') return;
    const transaction = { id: nanoid(), projectId: projectRef.current.id, nodeId: id, frame: currentFrame() };
    if (!videoControls.begin(transaction)) return;
    try {
      const result = await runWorkflowVideoExtractFrameOperation(transaction.projectId, id, position, imageToolRuntime, currentTimeSec);
      if (!videoControls.owns(transaction)) return;
      if (result.status === 'committed' && projectRef.current.id === transaction.projectId) {
        pushHistory(transaction.frame);
        setNotice(position === 'first' ? '首帧已通过 Operation 导出' : position === 'last' ? '尾帧已通过 Operation 导出' : '当前帧已通过 Operation 导出');
      }
    } catch (error) {
      if (videoControls.owns(transaction)) setNotice(displayError(error, '帧导出失败'));
    } finally {
      videoControls.settle(transaction);
    }
  }, [currentFrame, imageToolRuntime, pushHistory, videoControls]);

  // 工具栏「分离音视频 / 人声提取 / 背景音提取」直接执行：输出无声视频 + 音频节点，媒体写入本地存储。
  const handleAvSplit = useCallback(async (id: string, audio: WorkflowAvSplitAudio = 'full') => {
    const node = projectRef.current.nodes.find(item => item.id === id);
    if (!node || node.type !== 'video' || node.metadata.status === 'loading') return;
    const transaction = { id: nanoid(), projectId: projectRef.current.id, nodeId: id, frame: currentFrame() };
    if (!videoControls.begin(transaction)) return;
    const what = audio === 'vocals' ? '人声' : audio === 'background' ? '背景音' : '音频';
    setNotice(audio === 'full' ? '正在分离音视频…' : '正在提取' + what + '…');
    try {
      const result = await runWorkflowVideoAvSplitOperation(transaction.projectId, id, imageToolRuntime, audio);
      if (!videoControls.owns(transaction)) return;
      if (result.status === 'committed' && projectRef.current.id === transaction.projectId) {
        pushHistory(transaction.frame);
        setNotice('已创建无声视频与' + what + '节点，素材已保存');
      }
    } catch (error) {
      if (videoControls.owns(transaction)) setNotice(displayError(error, audio === 'full' ? '音视频分离失败' : what + '提取失败'));
    } finally {
      videoControls.settle(transaction);
    }
  }, [currentFrame, imageToolRuntime, pushHistory, videoControls]);

  // 节点内剪辑（P1-5）：剪辑条直接嵌在视频节点里，不再弹 TrimDialog；产物仍是 video.trim@1 的新版本。
  const [inlineTrim, setInlineTrim] = useState<{ projectId: string; nodeId: string } | null>(null);
  const [inlineTrimBusy, setInlineTrimBusy] = useState(false);
  const openInlineTrim = useCallback((nodeId: string) => {
    if (videoControls.isLocked()) { setNotice('请先完成或关闭当前视频工具'); return; }
    const target = projectRef.current.nodes.find(node => node.id === nodeId);
    if (!target || target.type !== 'video' || !(target.metadata.storageKey || target.metadata.href || target.metadata.artifactRef?.taskId)) {
      setNotice('目标视频节点缺少媒体，无法使用视频工具');
      return;
    }
    if (target.metadata.status === 'loading' || target.isLocked) return;
    setInlineTrim({ projectId: projectRef.current.id, nodeId });
  }, [videoControls]);
  const confirmInlineTrim = useCallback(async (nodeId: string, startSec: number, endSec: number) => {
    const transaction = { id: nanoid(), projectId: projectRef.current.id, nodeId, frame: currentFrame() };
    if (!videoControls.begin(transaction)) return;
    setInlineTrimBusy(true);
    setNotice('正在剪辑…');
    try {
      const result = await runWorkflowVideoTrimOperation(transaction.projectId, nodeId, { startSec, endSec }, imageToolRuntime);
      if (!videoControls.owns(transaction)) return;
      if (result.status === 'committed' && projectRef.current.id === transaction.projectId) {
        pushHistory(transaction.frame);
        setNotice('视频剪辑完成，已生成新版本');
        setInlineTrim(null);
      } else if (result.status === 'stale') {
        setInlineTrim(null);
      }
    } catch (error) {
      if (videoControls.owns(transaction)) setNotice(displayError(error, '视频剪辑失败'));
    } finally {
      setInlineTrimBusy(false);
      videoControls.settle(transaction);
    }
  }, [currentFrame, imageToolRuntime, pushHistory, videoControls]);

  const builtInVideoTools = useMemo<WorkflowVideoToolHandlers>(() => ({
    trim: id => openInlineTrim(id),
    avSplit: (id, audio) => { void handleAvSplit(id, audio); },
    // merge 需要携带完整选中 id 列表，确认时回传真实选中集而非全库视频。
    merge: ids => { if (ids.length > 0) openVideoTool('merge', ids[0], ids); },
    extractFrame: handleExtractFrame,
    extractFrameAt: id => openVideoTool('extract-frame', id),
  }), [openVideoTool, openInlineTrim, handleExtractFrame, handleAvSplit]);

  // 自动派生（默认关闭）：视频节点新进入成功状态时，按设置串行执行截帧 / 音视频分离 Operation。
  const [autoMediaDerive, setAutoMediaDerive] = useState<AutoMediaDeriveSettings>(() => loadAutoMediaDeriveSettings());
  const autoDerivePrevRef = useRef<{ projectId: string; nodes: typeof project.nodes } | null>(null);
  const autoDeriveHandledRef = useRef(new Set<string>());
  const autoDeriveQueueRef = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    const previous = autoDerivePrevRef.current;
    const previousNodes = previous && previous.projectId === project.id ? previous.nodes : undefined;
    autoDerivePrevRef.current = { projectId: project.id, nodes: project.nodes };
    const tasks = planAutoMediaDerivations(previousNodes, project.nodes, autoMediaDerive, autoDeriveHandledRef.current);
    if (tasks.length === 0) return;
    tasks.forEach(task => autoDeriveHandledRef.current.add(task.nodeId));
    const projectId = project.id;
    for (const task of tasks) {
      autoDeriveQueueRef.current = autoDeriveQueueRef.current.then(async () => {
        if (projectRef.current.id !== projectId || !projectRef.current.nodes.some(node => node.id === task.nodeId)) return;
        const frame = currentFrame();
        try {
          const result = task.kind === 'av-split'
            ? await runWorkflowVideoAvSplitOperation(projectId, task.nodeId, imageToolRuntime)
            : await runWorkflowVideoExtractFrameOperation(projectId, task.nodeId, task.kind === 'first-frame' ? 'first' : 'last', imageToolRuntime);
          if (result.status === 'committed' && projectRef.current.id === projectId) pushHistory(frame);
        } catch (error) {
          // 项目已切换时不再为旧项目的自动派生弹出提示。
          if (projectRef.current.id === projectId) setNotice(displayError(error, task.kind === 'av-split' ? '自动音视频分离失败' : '自动截帧失败'));
        }
      });
    }
  }, [project.id, project.nodes, autoMediaDerive, currentFrame, imageToolRuntime, pushHistory]);

  const activeVideoToolNode = videoTool ? project.nodes.find(node => node.id === videoTool.nodeId) || null : null;
  const activeVideoToolMedia = useWorkflowMediaUrl(activeVideoToolNode?.metadata.storageKey, activeVideoToolNode?.metadata.href, activeVideoToolNode?.metadata.artifactRef);

  const closeVideoTool = useCallback(() => {
    const transaction = videoControls.current();
    if (!videoTool || !transaction || videoControls.isBusy()) return;
    videoControls.close(transaction);
  }, [videoControls, videoTool]);

  const confirmVideoTool = useCallback(async (confirmation: WorkflowVideoToolConfirmation) => {
    const transaction = videoControls.current();
    if (!videoTool || !transaction || videoControls.isBusy()) return;
    const node = projectRef.current.nodes.find(item => item.id === videoTool.nodeId);
    if (!node) return;
    videoControls.start(transaction);
    try {
      let result: WorkflowImageToolOutcome | null = null;
      let successNotice = '';
      if (confirmation.kind === 'trim') {
        result = await runWorkflowVideoTrimOperation(transaction.projectId, node.id, {
          startSec: confirmation.startSec,
          endSec: confirmation.endSec,
        }, imageToolRuntime);
        successNotice = '视频剪辑完成';
      } else if (confirmation.kind === 'av-split') {
        result = await runWorkflowVideoAvSplitOperation(transaction.projectId, node.id, imageToolRuntime);
        successNotice = '已创建无声视频与音频节点，素材已保存';
      } else if (confirmation.kind === 'extract-frame') {
        result = await runWorkflowVideoExtractFrameOperation(transaction.projectId, node.id, confirmation.position, imageToolRuntime, confirmation.currentTimeSec);
        successNotice = '已提取 ' + (confirmation.currentTimeSec != null ? confirmation.currentTimeSec.toFixed(1) + 's' : confirmation.position === 'last' ? '尾帧' : '首帧');
      } else if (confirmation.kind === 'merge') {
        // 只拼接确认时回传的真实选中集；空列表视为无效选择（不再回退为全库视频）。
        const selectedNodes = projectRef.current.nodes.filter(n => n.type === 'video' && confirmation.nodeIds.includes(n.id));
        if (selectedNodes.length < 2) { videoControls.fail(transaction, '至少需要选择 2 个视频节点'); return; }
        result = await runWorkflowVideoMergeOperation(transaction.projectId, selectedNodes.map(item => item.id), imageToolRuntime);
        successNotice = '视频拼接完成';
      }
      if (!videoControls.owns(transaction)) return;
      if (result?.status === 'committed' && result.project.id === transaction.projectId && projectRef.current.id === transaction.projectId) {
        pushHistory(transaction.frame);
        setNotice(successNotice);
        videoControls.close(transaction);
      } else if (result?.status === 'stale') {
        videoControls.close(transaction);
      }
    } catch (error) {
      videoControls.fail(transaction, displayError(error, '视频处理失败'));
    } finally {
      videoControls.settle(transaction);
    }
  }, [imageToolRuntime, pushHistory, videoControls, videoTool]);

  const openAudioTool = useCallback((kind: WorkflowAudioToolState['kind'], nodeId: string) => {
    if (audioControls.isLocked()) {
      setNotice('请先完成或关闭当前音频工具');
      return;
    }
    if (projectRef.current.nodes.find(node => node.id === nodeId)?.metadata.status === 'loading') return;
    const transaction = { id: nanoid(), projectId: projectRef.current.id, nodeId, frame: currentFrame() };
    audioControls.open({ kind, nodeId }, transaction);
  }, [audioControls, currentFrame]);

  const builtInAudioTools = useMemo<WorkflowAudioToolHandlers>(() => ({
    trim: id => openAudioTool('trim', id),
    speed: id => openAudioTool('speed', id),
    pitch: id => openAudioTool('pitch', id),
    stemSplit: id => openAudioTool('stem-split', id),
  }), [openAudioTool]);

  const activeAudioToolNode = audioTool ? project.nodes.find(node => node.id === audioTool.nodeId) || null : null;
  const activeAudioToolMedia = useWorkflowMediaUrl(activeAudioToolNode?.metadata.storageKey, activeAudioToolNode?.metadata.href);

  const closeAudioTool = useCallback(() => {
    const transaction = audioControls.current();
    if (!audioTool || !transaction || audioControls.isBusy()) return;
    audioControls.close(transaction);
  }, [audioControls, audioTool]);

  const confirmAudioTool = useCallback(async (confirmation: WorkflowAudioToolConfirmation) => {
    const transaction = audioControls.current();
    if (!audioTool || !transaction || audioControls.isBusy()) return;
    const node = projectRef.current.nodes.find(item => item.id === audioTool.nodeId);
    if (!node) return;
    audioControls.start(transaction);
    try {
      let result: WorkflowImageToolOutcome;
      let successNotice: string;
      if (confirmation.kind === 'trim') {
        result = await runWorkflowAudioTrimOperation(transaction.projectId, node.id, {
          startSec: confirmation.startSec,
          endSec: confirmation.endSec,
        }, imageToolRuntime);
        successNotice = '音频截取完成';
      } else if (confirmation.kind === 'speed') {
        result = await runWorkflowAudioSpeedOperation(transaction.projectId, node.id, confirmation.speed, imageToolRuntime);
        successNotice = '音频变速完成 (' + confirmation.speed.toFixed(2) + 'x)';
      } else if (confirmation.kind === 'pitch') {
        result = await runWorkflowAudioPitchOperation(transaction.projectId, node.id, confirmation.semitones, imageToolRuntime);
        successNotice = '音频变调完成 (' + (confirmation.semitones > 0 ? '+' : '') + confirmation.semitones + ' 半音)';
      } else {
        result = await runWorkflowAudioStemSplitOperation(transaction.projectId, node.id, imageToolRuntime);
        successNotice = '人声/伴奏分离完成';
      }
      if (!audioControls.owns(transaction)) return;
      if (result.status === 'committed' && result.project.id === transaction.projectId && projectRef.current.id === transaction.projectId) {
        pushHistory(transaction.frame);
        setNotice(successNotice);
        audioControls.close(transaction);
      } else if (result.status === 'stale') {
        audioControls.close(transaction);
      }
    } catch (error) {
      audioControls.fail(transaction, displayError(error, '音频处理失败'));
    } finally {
      audioControls.settle(transaction);
    }
  }, [audioControls, audioTool, imageToolRuntime, pushHistory]);

  const activeImageToolNode = imageTool ? project.nodes.find(node => node.id === imageTool.nodeId) || null : null;
  const activeImageToolMedia = useWorkflowMediaUrl(activeImageToolNode?.metadata.storageKey, activeImageToolNode?.metadata.href);

  const previewImageFilters = useCallback((filters: NonNullable<WorkflowNodeData['metadata']['filters']>) => {
    if (!imageTool || imageTool.kind !== 'filter') return;
    const transaction = imageControls.current();
    if (!transaction || transaction.projectId !== projectRef.current.id || transaction.nodeId !== imageTool.nodeId) return;
    patchProject({ nodes: projectRef.current.nodes.map(node => node.id === imageTool.nodeId ? { ...node, metadata: { ...node.metadata, filters } } : node) });
  }, [imageControls, imageTool, patchProject]);

  const closeImageTool = useCallback(() => {
    const transaction = imageControls.current();
    if (!imageTool || !transaction || imageControls.isBusy() || transaction.projectId !== projectRef.current.id || transaction.nodeId !== imageTool.nodeId) return;
    if (imageTool.kind === 'filter') {
      const original = transaction.frame.nodes.find(node => node.id === imageTool.nodeId);
      if (original && projectRef.current.nodes.some(node => node.id === imageTool.nodeId)) {
        patchProject({ nodes: projectRef.current.nodes.map(node => node.id === imageTool.nodeId ? { ...node, metadata: { ...node.metadata, filters: original.metadata.filters } } : node) });
      }
    }
    imageControls.close(transaction);
  }, [imageControls, imageTool, patchProject]);

  const confirmImageTool = useCallback(async (confirmation: WorkflowImageToolConfirmation) => {
    const transaction = imageControls.current();
    if (!imageTool || !transaction || imageControls.isBusy() || transaction.projectId !== projectRef.current.id || transaction.nodeId !== imageTool.nodeId) return;
    const node = projectRef.current.nodes.find(item => item.id === imageTool.nodeId);
    if (!node) return;
    imageControls.start(transaction);
    try {
      if (confirmation.kind === 'filter') {
        if (!imageControls.owns(transaction) || !projectRef.current.nodes.some(item => item.id === node.id)) return;
        patchProject({ nodes: projectRef.current.nodes.map(item => item.id === node.id ? { ...item, metadata: { ...item.metadata, filters: confirmation.filters } } : item) });
        pushHistory(transaction.frame);
        imageControls.close(transaction);
        return;
      }
      if (confirmation.kind === 'crop') {
        // 裁剪走显式 Operation：源图片 → Operation → 结果图片，不再原地覆盖源媒体。
        const result = await runWorkflowCropOperation(transaction.projectId, node.id, confirmation.crop, imageToolRuntime);
        if (!imageControls.owns(transaction)) return;
        if (result.status === 'committed' && result.project.id === transaction.projectId && result.project.nodes.some(item => item.id === transaction.nodeId)) {
          pushHistory(transaction.frame);
          setNotice('图片裁剪完成');
          imageControls.close(transaction);
        }
        else if (result?.status === 'stale') imageControls.close(transaction);
        return;
      }
      if (confirmation.kind === 'vectorize') {
        const result = await runWorkflowVectorizeOperation(transaction.projectId, node.id, confirmation.preset, imageToolRuntime);
        if (!imageControls.owns(transaction)) return;
        if (result.status === 'committed') { pushHistory(transaction.frame); setNotice('矢量化完成'); }
        imageControls.close(transaction);
        return;
      }
      if (confirmation.kind === 'rotate') {
        const result = await runWorkflowRotateOperation(transaction.projectId, node.id, confirmation.action, imageToolRuntime);
        if (!imageControls.owns(transaction)) return;
        if (result.status === 'committed') { pushHistory(transaction.frame); setNotice('旋转镜像完成'); }
        imageControls.close(transaction);
        return;
      }
      if (confirmation.kind === 'splitGrid') {
        const result = await runWorkflowSplitGridOperation(transaction.projectId, node.id, { rows: confirmation.rows, cols: confirmation.cols }, imageToolRuntime);
        if (!imageControls.owns(transaction)) return;
        if (result.status === 'committed') { pushHistory(transaction.frame); setNotice('宫格切分完成 (' + confirmation.rows * confirmation.cols + ' 张)'); }
        imageControls.close(transaction);
        return;
      }
      if (confirmation.kind === 'annotate') {
        const result = await runWorkflowImageEditOperation(transaction.projectId, node.id, '根据标注修改图片', 'annotate', { href: confirmation.annotatedDataUrl, mimeType: 'image/png' }, imageToolRuntime);
        if (!imageControls.owns(transaction)) return;
        if (result?.status === 'committed') { pushHistory(transaction.frame); imageControls.close(transaction); }
        else if (result?.status === 'stale') imageControls.close(transaction);
        return;
      }
      if (confirmation.kind === 'relight') {
        const preset = LIGHTING_PRESETS.find(p => p.id === confirmation.preset)!;
        const prompt = buildRelightPrompt(preset, confirmation.intensity, confirmation.color, confirmation.smart);
        const result = await runWorkflowImageEditOperation(transaction.projectId, node.id, prompt, 'relight', undefined, imageToolRuntime);
        if (!imageControls.owns(transaction)) return;
        if (result?.status === 'committed') { pushHistory(transaction.frame); imageControls.close(transaction); }
        else if (result?.status === 'stale') imageControls.close(transaction);
        return;
      }
      if (confirmation.kind === 'layer') {
        const result = await runWorkflowLayerOperation(transaction.projectId, node.id, {
          prompt: confirmation.prompt, style: confirmation.style, count: confirmation.count,
          mask: confirmation.maskDataUrl ? { href: confirmation.maskDataUrl, mimeType: 'image/png' } : undefined,
        }, imageToolRuntime);
        if (!imageControls.owns(transaction)) return;
        if (result?.status === 'committed') { pushHistory(transaction.frame); setNotice('叠加层已生成 ' + confirmation.count + ' 个候选'); imageControls.close(transaction); }
        else if (result?.status === 'stale') imageControls.close(transaction);
        return;
      }
      if (confirmation.kind === 'storyboard') {
        const ids = storyboardNodeIds || [];
        const sourceNodes = projectRef.current.nodes.filter(n => ids.includes(n.id) && n.type === 'image');
        if (sourceNodes.length < 2) { imageControls.fail(transaction, '至少需要 2 张图片'); return; }
        const sources = sourceNodes.map(n => ({ storageKey: n.metadata.storageKey, href: n.metadata.href }));
        const labels = confirmation.showIndex ? sourceNodes.map((_, i) => '#' + (i + 1)) : undefined;
        const composedBlob = await composeImageGrid(sources, { cols: confirmation.cols, labels });
        const record = await ingestWorkflowMedia(new File([composedBlob], 'storyboard.png', { type: 'image/png' }));
        if (!imageControls.owns(transaction)) { await discardWorkflowMediaRecord(record.storageKey); return; }
        const lastNode = sourceNodes[sourceNodes.length - 1];
        const size = fitWorkflowMediaSize('image', record.naturalWidth || 1024, record.naturalHeight || 768);
        pushHistory(transaction.frame, {
          nodes: [...projectRef.current.nodes, { ...createWorkflowNode(nanoid(), 'image', { x: lastNode.position.x + lastNode.width + 40, y: lastNode.position.y }, { ...record, name: 'storyboard.png', status: 'success' }), ...size }],
          connections: projectRef.current.connections,
        }, '创建分镜组拼图');
        releaseWorkflowMediaRecord(record.storageKey);
        setNotice('分镜组拼接完成');
        setStoryboardNodeIds(null);
        imageControls.close(transaction);
        return;
      }
      let result: WorkflowImageToolOutcome | null = null;
      if (confirmation.kind === 'upscale') result = await runWorkflowUpscaleOperation(transaction.projectId, node.id, { targetLongEdge: confirmation.targetLongEdge, algorithm: confirmation.algorithm }, imageToolRuntime);
      if (confirmation.kind === 'split') result = await runWorkflowSplitLayersOperation(transaction.projectId, node.id, imageToolRuntime);
      if (confirmation.kind === 'move') result = await runWorkflowMoveObjectOperation(transaction.projectId, node.id, { points: confirmation.points, dx: confirmation.dx, dy: confirmation.dy, prompt: confirmation.prompt }, imageToolRuntime);
      if (confirmation.kind === 'outpaint') result = await runWorkflowOutpaintOperation(transaction.projectId, node.id, { direction: confirmation.direction, amount: confirmation.amount, prompt: confirmation.prompt }, imageToolRuntime);
      if (confirmation.kind === 'restyle') result = await runWorkflowImageEditOperation(transaction.projectId, node.id, confirmation.prompt, 'edit', undefined, imageToolRuntime);
      if (confirmation.kind === 'mask') result = await runWorkflowImageEditOperation(transaction.projectId, node.id, confirmation.prompt, 'mask', { href: confirmation.maskDataUrl, mimeType: 'image/png' }, imageToolRuntime);
      if (!imageControls.owns(transaction)) return;
      if (result?.status === 'committed' && result.project.id === transaction.projectId && projectRef.current.id === transaction.projectId && result.project.nodes.some(item => item.id === transaction.nodeId)) {
        pushHistory(transaction.frame);
        if (confirmation.kind === 'upscale') setNotice('高清放大完成');
        imageControls.close(transaction);
      } else if (result?.status === 'stale') {
        imageControls.close(transaction);
      }
    } catch (error) {
      imageControls.fail(transaction, displayError(error, '图片处理失败'));
    } finally {
      imageControls.settle(transaction);
    }
  }, [imageControls, imageTool, imageToolRuntime, patchProject, pushHistory, storyboardNodeIds]);

  const applyOps = useCallback((ops: WorkflowDocumentOperation[]) => {
    // 自动命名：未自定义标题的新节点按「类型 + 序号」命名，避免画布上全是「图片」「视频」
    const snapshot = projectRef.current;
    const renamedOps = ops.map(op => {
      if (op.type !== 'add_node') return op;
      const specTitle = WORKFLOW_NODE_SPECS[op.node.type]?.title || op.node.title || op.node.type;
      if (op.node.title !== specTitle) return op;
      const count = snapshot.nodes.filter(node => node.type === op.node.type).length + 1;
      return { ...op, node: { ...op.node, title: `${specTitle} ${count}` } };
    });
    const result = applyWorkflowMutation(projectRef.current, {
      projectId: projectRef.current.id,
      expectedRevision: projectRef.current.draftVersion || 1,
      mutationId: nanoid(),
      source: 'ui',
      intent: summarizeWorkflowOps(renamedOps) || '编辑画布',
      ops: renamedOps,
    });
    if (result.ok === false) {
      setNotice(result.error.message);
      return false;
    }
    applyDraftProject(result.project);
    setNotice(null);
    return true;
  }, [applyDraftProject]);

  // 无 Key 时的生成入口：先给配置引导，而不是让运行失败后再报错。“仍然运行”保留 Runtime-only 路由。
  const [noKeyRunNodeId, setNoKeyRunNodeId] = useState<string | null>(null);
  const hasAnyAiService = userApiKeys.some(key => Boolean(key.key || key.baseUrl));
  const runNodeWithKeyGuide = useCallback((nodeId: string) => {
    if (!hasAnyAiService) { setNoKeyRunNodeId(nodeId); return; }
    onRunNode(nodeId);
  }, [hasAnyAiService, onRunNode]);

  // Slash/分镜/整组等批量入口的 runNode 串行队列（按 projectId）：逐个发起，避免同一
  // 批次内多个 run 的 prepare 写回互相覆盖。onRunNode 契约返回 void；若适配器实际
  // 返回 thenable 则等它落定，否则让出一个宏任务再放行下一个。
  // 执行器返回的 thenable 永不落定时不能永久堵住队列：超时后放行后续节点，该节点自身仍可继续运行。
  const RUN_NODE_QUEUE_TIMEOUT_MS = 900_000;
  const runNodeQueueRef = useRef(new Map<string, Promise<unknown>>());
  const enqueueRunNode = useCallback((nodeId: string) => {
    const projectId = projectRef.current.id;
    const queue = runNodeQueueRef.current;
    const previous = queue.get(projectId) ?? Promise.resolve();
    const next = previous.then(async () => {
      const result = onRunNode(nodeId) as unknown;
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        let timer = 0;
        const deadline = new Promise<void>(resolve => { timer = window.setTimeout(resolve, RUN_NODE_QUEUE_TIMEOUT_MS); });
        try {
          await Promise.race([Promise.resolve(result).then(() => undefined), deadline]);
        } finally {
          window.clearTimeout(timer);
        }
      } else {
        await new Promise<void>(resolve => window.setTimeout(resolve, 0));
      }
    });
    queue.set(projectId, next.catch(() => undefined));
  }, [onRunNode]);

  const assetFolders = useMemo(() => assetLibrary?.folders || [], [assetLibrary]);
  const assetSuggestions = useMemo<AssetSuggestion[]>(() => (assetLibrary?.items || []).map(item => ({
    id: item.id,
    name: item.name || '未命名',
    folderIds: item.folderIds,
    tags: item.tags,
    thumbnail: item.dataUrl,
    elementType: mediaKindOf(item.mimeType) as 'image' | 'video',
  })), [assetLibrary]);

  const handleResolvePastedMentions = useCallback((mentions: MentionData[], targetNodeId: string): Array<MentionData | null> => {
    const snapshot = currentSnapshot();
    const result = buildWorkflowPromptPasteOps({
      targetNodeId,
      snapshot,
      assets: assetLibrary?.items || [],
      mentions,
      createId: nanoid,
    });
    if (result.ops.length > 0 && !applyOps(result.ops)) return mentions.map(() => null);
    selectNodes([targetNodeId]);
    return result.resolvedMentions as Array<MentionData | null>;
  }, [applyOps, assetLibrary, currentSnapshot, selectNodes]);

  const handleSelectAsset = useCallback((assetId: string, fromNodeId: string): string | undefined => {
    const snapshot = currentSnapshot();
    const targetNode = snapshot.nodes.find(n => n.id === fromNodeId);
    if (!targetNode) return undefined;
    const asset = assetLibrary?.items.find(a => a.id === assetId);
    if (!asset) return undefined;

    const upstreamConn = snapshot.connections.filter(c => c.toNodeId === fromNodeId);
    for (const conn of upstreamConn) {
      const upstreamNode = snapshot.nodes.find(n => n.id === conn.fromNodeId);
      if (upstreamNode?.metadata.assetId === assetId && upstreamNode.metadata.sourceType === 'assetLibrary') {
        return upstreamNode.id;
      }
    }

    const nodeId = nanoid();
    const gapY = 120;
    const newNodeY = targetNode.position.y - 240 - gapY;
    const newNodeX = targetNode.position.x + (targetNode.width - 340) / 2;

    const mediaType = asset.mimeType.startsWith('video/') ? 'video' : 'image';
    const newNode = createWorkflowNode(nodeId, mediaType, { x: newNodeX, y: newNodeY }, {
      sourceType: 'assetLibrary',
      assetId,
      href: `asset-library:${assetId}`,
      name: asset.name || '素材引用',
      mimeType: asset.mimeType,
      naturalWidth: asset.width,
      naturalHeight: asset.height,
      status: 'success',
    });

    const ops: WorkflowDocumentOperation[] = [
      { type: 'add_node', node: newNode },
      { type: 'connect_nodes', fromNodeId: nodeId, toNodeId: fromNodeId },
    ];

    const success = applyOps(ops);
    return success ? nodeId : undefined;
  }, [applyOps, assetLibrary, currentSnapshot]);

  const handleSelectWorkflowReference = useCallback((nodeId: string, targetNodeId: string): string | undefined => {
    const snapshot = currentSnapshot();
    const target = snapshot.nodes.find(node => node.id === targetNodeId);
    const source = snapshot.nodes.find(node => node.id === nodeId);
    if (!target || !source || source.id === target.id || !['image', 'video', 'audio'].includes(source.type)) return undefined;
    const alreadyConnected = snapshot.connections.some(connection => connection.fromNodeId === nodeId && connection.toNodeId === targetNodeId);
    const ops: WorkflowDocumentOperation[] = [];
    if (!alreadyConnected) ops.push({ type: 'connect_nodes', fromNodeId: nodeId, toNodeId: targetNodeId });
    return applyOps(ops) ? nodeId : undefined;
  }, [applyOps, currentSnapshot]);

  const handleReorderReferences = useCallback((targetNodeId: string, nextIds: string[]) => {
    const snapshot = currentSnapshot();
    const inputConnections = snapshot.connections.filter(connection => connection.toNodeId === targetNodeId);
    const inputById = new Map(inputConnections.map(connection => [connection.fromNodeId, connection]));
    const ordered = nextIds.map(id => inputById.get(id)).filter((connection): connection is NonNullable<typeof connection> => Boolean(connection));
    const orderedIds = new Set(ordered.map(connection => connection.id));
    const remaining = inputConnections.filter(connection => !orderedIds.has(connection.id));
    const others = snapshot.connections.filter(connection => connection.toNodeId !== targetNodeId);
    // 连接顺序即引用顺序；其他连接保持原位，目标节点输入按 nextIds 重排
    return applyOps([{ type: 'reorder_connections', ids: [...others, ...ordered, ...remaining].map(connection => connection.id) }]);
  }, [applyOps, currentSnapshot]);

  const handleAddReferenceFiles = useCallback(async (files: File[], targetNodeId: string) => {
    const expectedProjectId = projectRef.current.id;
    const records: WorkflowMediaRecord[] = [];
    try {
      for (const file of files.filter(file => file.type.startsWith('image/'))) records.push(await ingestWorkflowMedia(file));
      if (!records.length) throw new Error('请选择图片文件');
      if (!mountedRef.current || projectRef.current.id !== expectedProjectId) throw new Error('工作流已切换，请重新上传');
      const snapshot = currentSnapshot();
      const target = snapshot.nodes.find(node => node.id === targetNodeId);
      if (!target) throw new Error('当前生成节点已不存在');
      const nodes = records.map((record, index) => {
        const { type, ...metadata } = record;
        const size = fitWorkflowMediaSize(type, record.naturalWidth, record.naturalHeight);
        const x = target.position.x + target.width / 2 + (index - (records.length - 1) / 2) * (size.width + 24) - size.width / 2;
        return { ...createWorkflowNode(nanoid(), type, { x, y: target.position.y - size.height - 100 }, { ...metadata, status: 'success' }), ...size, freeResize: false };
      });
      const ops: WorkflowDocumentOperation[] = nodes.map(node => ({ type: 'add_node', node }));
      nodes.forEach(node => ops.push({ type: 'connect_nodes', fromNodeId: node.id, toNodeId: targetNodeId }));
      if (!applyOps(ops)) throw new Error('参考图节点连接失败');
      records.forEach(record => releaseWorkflowMediaRecord(record.storageKey));
    } catch (error) {
      await Promise.all(records.map(record => discardWorkflowMediaRecord(record.storageKey)));
      setNotice(displayError(error, '参考图上传失败'));
    }
  }, [applyOps, currentSnapshot]);

  const handleScriptBatchGenerate = useCallback((scriptNodeId: string, mode: 'image' | 'video') => {
    const snapshot = currentSnapshot();
    const scriptNode = snapshot.nodes.find(n => n.id === scriptNodeId);
    if (!scriptNode || scriptNode.type !== 'script') return;
    if (!scriptNode.metadata.scriptBreakdown?.shots.length) return;
    // 与 Agent 的 workflow.script.materialize 同一个纯函数：每行一个生成节点，提示词写进 Prompt Bar，
    // 锚点成 @chip + 连线，节点挂 shot 元数据，脚本行回链。用户在编辑器里点了批量生成，所以建好后直接入队运行。
    let plan: ReturnType<typeof buildScriptMaterializeOps>;
    try {
      plan = buildScriptMaterializeOps(scriptNode, { kind: mode, nodes: snapshot.nodes, connections: snapshot.connections, createId: nanoid });
    } catch (error) {
      setNotice(displayError(error, '分镜生成失败'));
      return;
    }
    if (!plan.created.length) return;
    if (plan.diagnostics.length) setNotice(plan.diagnostics.map(item => item.message).join('；'));
    const newNodeIds = plan.created.map(item => item.nodeId);
    if (applyOps(plan.operations)) {
      newNodeIds.forEach(id => enqueueRunNode(id));
      selectNodes(newNodeIds);
    }
  }, [applyOps, currentSnapshot, enqueueRunNode, selectNodes]);

  const screenToWorkflow = useCallback((clientX: number, clientY: number): WorkflowPoint => {
    const rect = rootRef.current?.getBoundingClientRect();
    const viewport = viewportRef.current;
    return {
      x: (clientX - (rect?.left || 0) - viewport.x) / viewport.k,
      y: (clientY - (rect?.top || 0) - viewport.y) / viewport.k,
    };
  }, []);

  const worldToScreen = useCallback((world: WorkflowPoint): WorkflowPoint => {
    const viewport = viewportRef.current;
    return { x: world.x * viewport.k + viewport.x, y: world.y * viewport.k + viewport.y };
  }, []);

  const viewportCenter = useCallback(() => {
    const rect = rootRef.current?.getBoundingClientRect();
    const availableWidth = Math.max(360, rect?.width || 1000);
    return screenToWorkflow((rect?.left || 0) + availableWidth / 2, (rect?.top || 0) + (rect?.height || 700) / 2);
  }, [screenToWorkflow]);

  // 聚焦到一块世界坐标区域（单节点=其包围盒，多选=选区包围盒），
  // 与 focusNodeRequest 共用同一套 drawer-inset 感知动画。
  const focusBounds = useCallback((minX: number, minY: number, maxX: number, maxY: number) => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    const availableWidth = Math.max(360, rect.width);
    const padding = 120;
    const targetK = Math.min(1.5, Math.max(0.12, Math.min((availableWidth - padding) / Math.max(1, maxX - minX), (rect.height - padding) / Math.max(1, maxY - minY))));
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const targetX = availableWidth / 2 - centerX * targetK;
    const targetY = rect.height / 2 - centerY * targetK;
    const start = { ...viewportRef.current };
    const dx = targetX - start.x;
    const dy = targetY - start.y;
    const dk = targetK - start.k;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(dk) < 0.01) { setFocusBadge(true); return; }
    if (focusAnimRef.current !== null) window.cancelAnimationFrame(focusAnimRef.current);
    setFocusBadge(false);
    const duration = 420;
    const startTime = window.performance.now();
    const easeInOutCubic = (t: number) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    const tick = (now: number) => {
      const elapsed = now - startTime;
      const t = Math.min(1, elapsed / duration);
      const e = easeInOutCubic(t);
      patchProject({ viewport: { x: start.x + dx * e, y: start.y + dy * e, k: start.k + dk * e } });
      if (t < 1) {
        focusAnimRef.current = window.requestAnimationFrame(tick);
      } else {
        focusAnimRef.current = null;
        setFocusBadge(true);
      }
    };
    focusAnimRef.current = window.requestAnimationFrame(tick);
  }, [patchProject]);

  const focusNode = useCallback((id: string) => {
    const node = projectRef.current.nodes.find(n => n.id === id);
    if (!node) return;
    focusBounds(node.position.x, node.position.y, node.position.x + node.width, node.position.y + node.height);
  }, [focusBounds]);

  /** Premiere/AE 式 Frame Selection（F）：把当前选中节点缩放平移到可视区域中央。 */
  const frameSelection = useCallback(() => {
    const nodes = selectedIdsRef.current
      .map(id => projectRef.current.nodes.find(node => node.id === id))
      .filter((node): node is WorkflowNodeData => Boolean(node && node.isVisible !== false));
    if (!nodes.length) return;
    focusBounds(
      Math.min(...nodes.map(node => node.position.x)),
      Math.min(...nodes.map(node => node.position.y)),
      Math.max(...nodes.map(node => node.position.x + node.width)),
      Math.max(...nodes.map(node => node.position.y + node.height)),
    );
  }, [focusBounds]);

  // rev 按钮提示：最近一次修改的一句话（和 Timeline 同一个摘要函数）。
  const lastChangeSummary = useMemo(() => {
    const last = [...(project.draftChangeSets || [])].reverse().find(changeSet => changeSet.status !== 'failed');
    if (!last) return undefined;
    const lang = language === 'en' ? 'en' : 'zho';
    return timelineSentence(actorFromDraftActor(last.actor), describeChangeSet(last, lang).text, lang);
  }, [language, project.draftChangeSets]);

  // 故事板（P2）：镜头表来自制作圣经，只在项目里有 shot 元数据时露出入口。
  // 故事板第二视图（P1-4）：同一份 workflow 推导，不另建 store。
  const [workflowView, setWorkflowView] = useState<'workflow' | 'storyboard'>('workflow');
  const storyboardView = useMemo(() => buildStoryboardView(project), [project]);
  const [storyboardMergeBusy, setStoryboardMergeBusy] = useState(false);
  const mergeStoryboard = useCallback(async (sourceNodeIds: string[]) => {
    if (sourceNodeIds.length < 2) return;
    const transaction = { id: nanoid(), projectId: projectRef.current.id, nodeId: sourceNodeIds[0], frame: currentFrame() };
    if (!videoControls.begin(transaction)) { setNotice('请先完成或关闭当前视频工具'); return; }
    setStoryboardMergeBusy(true);
    setNotice('正在按镜号拼接成片…');
    try {
      const result = await runWorkflowVideoMergeOperation(transaction.projectId, sourceNodeIds, imageToolRuntime);
      if (!videoControls.owns(transaction)) return;
      if (result.status === 'committed' && projectRef.current.id === transaction.projectId) {
        pushHistory(transaction.frame);
        setNotice('成片拼接完成');
      }
    } catch (error) {
      if (videoControls.owns(transaction)) setNotice(displayError(error, '成片拼接失败'));
    } finally {
      setStoryboardMergeBusy(false);
      videoControls.settle(transaction);
    }
  }, [currentFrame, imageToolRuntime, pushHistory, videoControls]);
  const productionBible = useMemo(() => buildProductionBible(project), [project]);

  // focusNodeRequest 是一次性事件：按 nonce 只处理一次。否则 focusNode/selectNodes
  // 随视口或选中变化重建时，旧请求会重放：动画每帧重启、视口被拉回、选中被抢回。
  const handledFocusNonceRef = useRef<number | null>(null);
  useEffect(() => {
    if (!focusNodeRequest || handledFocusNonceRef.current === focusNodeRequest.nonce) return;
    handledFocusNonceRef.current = focusNodeRequest.nonce;
    const node = projectRef.current.nodes.find(item => item.id === focusNodeRequest.nodeId);
    if (!node) return;
    selectNodes([node.id]);
    focusNode(node.id);
  }, [focusNode, focusNodeRequest, selectNodes]);

  // 刷新/重载后节点 metadata 里会残留 status:'loading'，但内存中的生成请求
  // 已不存在 —— 这类"僵尸 loading"永远不会自己结束，也会挡住编辑。
  const interruptedMessage = language === 'zho' ? '生成已中断，点「重试」重新运行' : 'Generation interrupted — press Retry to run again';
  const markInterrupted = useCallback((nodeIds: string[]) => {
    const ops = nodeIds.flatMap(nodeId => {
      const node = projectRef.current.nodes.find(item => item.id === nodeId);
      if (!node || node.metadata.status !== 'loading') return [];
      return [{
        type: 'update_node' as const,
        id: nodeId,
        metadata: {
          ...node.metadata,
          status: 'error' as const,
          error: interruptedMessage,
          progress: undefined,
          generationRequestId: undefined,
          generationStartedAt: undefined,
          generationMessage: undefined,
          generationTransfer: undefined,
        },
      }];
    });
    if (ops.length) applyOps(ops);
    return ops.length;
  }, [applyOps, interruptedMessage]);
  useEffect(() => {
    // A node left in "loading" with no live request in this session (the tab was
    // reloaded or closed mid-run) will never finish by itself. Turn it straight
    // into a retryable error so it is never locked. Only a video with a provider
    // task id gets a short grace period, because App may resume that task.
    const loading = projectRef.current.nodes.filter(node => node.metadata.status === 'loading' && !isWorkflowGenerationActive(project.id, node.id));
    if (!loading.length) return;
    const resumable = (node: WorkflowNodeData) => node.metadata.config?.mode === 'video' && Boolean(node.metadata.generationProviderTaskId);
    const immediate = loading.filter(node => !resumable(node)).map(node => node.id);
    let count = markInterrupted(immediate);
    const waiting = loading.filter(resumable).map(node => node.id);
    const notify = (n: number) => {
      if (n) onNotify?.(language === 'zho' ? `${n} 个生成任务已中断，可以直接重试` : `${n} generation task${n > 1 ? 's were' : ' was'} interrupted — retry any time`, 'warning');
    };
    if (!waiting.length) { notify(count); return; }
    const timer = window.setTimeout(() => {
      if (!mountedRef.current) return;
      count += markInterrupted(waiting.filter(nodeId => !isWorkflowGenerationActive(project.id, nodeId)));
      notify(count);
    }, 6000);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  const stopNode = useCallback((nodeId: string) => {
    if (!isWorkflowGenerationActive(project.id, nodeId) && markInterrupted([nodeId])) return;
    onStopNode?.(nodeId);
  }, [markInterrupted, onStopNode, project.id]);

  const handleSlashCommand = useCallback((command: SlashShortcut, explicitTargetId?: string, text?: string) => {
    setSlashMenu(null);
    const snapshot = currentSnapshot();
    // 目标：显式给定（Prompt Bar 内 `/`）> 选中的第一个图片节点；宫格原地出一张图，非宫格右侧新建一个节点。
    const targetId = explicitTargetId || selectedIdsRef.current.find(id => snapshot.nodes.find(n => n.id === id)?.type === 'image');
    const center = viewportCenter();
    let applied: ReturnType<typeof buildShortcutApplyOps>;
    try {
      applied = buildShortcutApplyOps({
        shortcut: command,
        nodes: snapshot.nodes,
        connections: snapshot.connections,
        targetId,
        ...(text !== undefined && text.trim() ? { text } : {}),
        position: { x: center.x - 170, y: center.y - 120 },
        mutationId: 'slash-' + nanoid(),
        keys: userApiKeys,
        place: () => ({ x: center.x - 170, y: center.y - 120 }),
      });
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    const success = applyOps(applied.plan.operations);
    if (success) {
      enqueueRunNode(applied.nodeId);
      selectNodes([applied.nodeId]);
    }
  }, [applyOps, currentSnapshot, enqueueRunNode, selectNodes, userApiKeys, viewportCenter]);

  // 媒体入库阶段/进度与取消句柄：只用于显示，不进项目数据与撤销栈。
  const [ingestStages, setIngestStages] = useState<Record<string, { stage: 'probe' | 'download' | 'transcode' | 'store'; progress?: number }>>({});
  const ingestAbortRef = useRef(new Map<string, AbortController>());
  // 浏览器解不了且预览代理失败的视频：弹窗让用户换文件或复制本机转码命令。replaceMedia 定义在后面，经 ref 调用。
  const replaceMediaRef = useRef<((node: WorkflowNodeData, file: File) => Promise<void>) | undefined>(undefined);
  const offerUndecodableVideoFix = useCallback(async (nodeId: string, fileName: string) => {
    if (await promptUndecodableVideo(fileName) !== 'replace') return;
    const next = await pickVideoFile();
    const node = projectRef.current.nodes.find(item => item.id === nodeId);
    if (next && node && !node.isLocked) await replaceMediaRef.current?.(node, next);
  }, []);

  // 浏览器解不了的视频：原文件已落到节点上可直接使用，预览代理在后台转码，完成后不进撤销栈地写回。
  // 进度沿用 ingestStages，但节点不处于 uploading，只显示角标不挡操作；取消只停预览，不动节点。
  const buildVideoPreviewInBackground = useCallback(async (nodeId: string, storageKey: string, file: File) => {
    const controller = new AbortController();
    ingestAbortRef.current.set(nodeId, controller);
    let lastStageKey = '';
    try {
      const result = await generateWorkflowVideoPreview(storageKey, file, {
        signal: controller.signal,
        onStage: stage => {
          const key = stage.stage + ('progress' in stage ? Math.round(stage.progress / 0.01) : '');
          if (key === lastStageKey) return;
          lastStageKey = key;
          setIngestStages(current => ({ ...current, [nodeId]: stage }));
        },
      });
      if (mountedRef.current && projectRef.current.nodes.some(item => item.id === nodeId && item.metadata.storageKey === storageKey)) {
        patchProject({ nodes: projectRef.current.nodes.map(item => item.id === nodeId ? { ...item, metadata: { ...item.metadata, ...result } } : item) });
      }
      // 写回后由项目引用接管；节点已删除或已换素材时交给 prune 回收。
      releaseWorkflowMediaRecord(storageKey);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      if (mountedRef.current && projectRef.current.nodes.some(item => item.id === nodeId && item.metadata.storageKey === storageKey)) {
        void offerUndecodableVideoFix(nodeId, file.name);
      }
    } finally {
      if (ingestAbortRef.current.get(nodeId) === controller) {
        ingestAbortRef.current.delete(nodeId);
        setIngestStages(({ [nodeId]: _done, ...rest }) => rest);
      }
    }
  }, [offerUndecodableVideoFix, patchProject]);

  const addMediaAt = useCallback(async (file: File, center: WorkflowPoint, expectedProjectId = projectRef.current.id) => {
    let type: WorkflowMediaRecord['type'];
    try {
      type = workflowMediaType(file);
    } catch (error) {
      setNotice(displayError(error, '媒体文件导入失败'));
      return;
    }
    // 入库可能要做解码探测、首次下载 ~31MB ffmpeg core 并转码，耗时数秒到数十秒：
    // 先放「导入中」占位节点，避免拖入后画布毫无反应；完成后原地替换，失败则移除并提示。
    const nodeId = nanoid();
    const placeholderSize = fitWorkflowMediaSize(type);
    const placeholder = {
      ...createWorkflowNode(nodeId, type, { x: center.x - placeholderSize.width / 2, y: center.y - placeholderSize.height / 2 }, { name: file.name, uploading: true, uploadBytes: file.size }),
      ...placeholderSize,
      freeResize: false,
    };
    if (!applyOps([{ type: 'add_node', node: placeholder }])) return;
    let record: WorkflowMediaRecord | undefined;
    let backgroundPreview = false;
    try {
      const controller = new AbortController();
      ingestAbortRef.current.set(nodeId, controller);
      // 进度回调很密：只在阶段或整数百分比变化时刷新，避免整张画布高频重渲染。
      let lastStageKey = '';
      record = await ingestWorkflowMedia(file, undefined, {
        signal: controller.signal,
        deferPreview: true,
        onStage: stage => {
          const key = stage.stage + ('progress' in stage ? Math.round(stage.progress / 0.01) : '');
          if (key === lastStageKey) return;
          lastStageKey = key;
          setIngestStages(current => ({ ...current, [nodeId]: stage }));
        },
      });
      const currentNode = projectRef.current.nodes.find(item => item.id === nodeId);
      if (!mountedRef.current || projectRef.current.id !== expectedProjectId || !currentNode) {
        await discardWorkflowMediaRecord(record.storageKey);
        return;
      }
      const { type: _type, warning, pendingPreview, ...metadata } = record;
      const size = fitWorkflowMediaSize(type, record.naturalWidth, record.naturalHeight);
      const nodeCenter = { x: currentNode.position.x + currentNode.width / 2, y: currentNode.position.y + currentNode.height / 2 };
      commitFrame(projectRef.current.nodes.map(item => item.id === nodeId ? {
        ...item,
        ...size,
        position: { x: nodeCenter.x - size.width / 2, y: nodeCenter.y - size.height / 2 },
        metadata: { ...item.metadata, ...metadata, error: undefined, uploading: false },
      } : item), projectRef.current.connections);
      releaseWorkflowMediaRecord(record.storageKey);
      // 浏览器解不了的视频：节点已可用，预览代理后台生成；其它降级只提示。
      if (pendingPreview) {
        backgroundPreview = true;
        void buildVideoPreviewInBackground(nodeId, record.storageKey, file);
      } else if (warning) setNotice(warning);
    } catch (error) {
      if (record) await discardWorkflowMediaRecord(record.storageKey);
      if (!mountedRef.current || projectRef.current.id !== expectedProjectId) return;
      if (projectRef.current.nodes.some(item => item.id === nodeId)) applyOps([{ type: 'delete_nodes', ids: [nodeId] }]);
      // 用户主动取消：静默移除占位。
      if (!(error instanceof DOMException && error.name === 'AbortError')) setNotice(displayError(error, '媒体文件导入失败'));
    } finally {
      // 已转交后台预览时，取消句柄与进度归后台任务所有。
      if (!backgroundPreview) {
        ingestAbortRef.current.delete(nodeId);
        setIngestStages(({ [nodeId]: _done, ...rest }) => rest);
      }
    }
  }, [applyOps, buildVideoPreviewInBackground, commitFrame]);

  const addSharedMediaAt = useCallback(async (media: WorkflowSharedMedia, center: WorkflowPoint) => {
    if (/^https?:\/\//i.test(media.href)) {
      const size = fitWorkflowMediaSize(media.type, media.width, media.height);
      const node = {
        ...createWorkflowNode(nanoid(), media.type, { x: center.x - size.width / 2, y: center.y - size.height / 2 }, {
          href: media.href,
          mimeType: media.mimeType,
          name: media.name,
          naturalWidth: media.width,
          naturalHeight: media.height,
          status: 'success',
        }),
        ...size,
        freeResize: false,
        title: media.name,
      };
      applyOps([{ type: 'add_node', node }]);
      return;
    }
    const expectedProjectId = projectRef.current.id;
    try {
      const blob = await loadWorkflowMediaBlob(undefined, media.href);
      if (!mountedRef.current || projectRef.current.id !== expectedProjectId) return;
      await addMediaAt(new File([blob], media.name, { type: blob.type || media.mimeType }), center, expectedProjectId);
    } catch (error) {
      if (mountedRef.current && projectRef.current.id === expectedProjectId) setNotice(displayError(error, '共享素材导入失败'));
    }
  }, [addMediaAt, applyOps]);

  const dropMedia = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (event.dataTransfer?.types?.includes('Files')) {
      const dropTarget = event.target instanceof Element
        ? event.target.closest('.workflow-node--image, .workflow-node--video, .workflow-node--audio')
        : null;
      // A single file dropped on a media node replaces that node's media (handled by the node).
      // Several files always become new nodes so none of them is silently discarded.
      if (dropTarget && (event.dataTransfer.files?.length || 0) <= 1) return;
    }
    event.stopPropagation();
    const point = Number.isFinite(event.clientX) && Number.isFinite(event.clientY)
      ? screenToWorkflow(event.clientX, event.clientY)
      : viewportCenter();
    const batch = workflowDropSharedMediaBatch(event.dataTransfer);
    if (batch.length > 1) {
      // 多选拖入：逐条落节点；串行等待前一条持久化，避免并发写覆盖项目快照。
      const expectedProjectId = projectRef.current.id;
      void (async () => {
        for (let index = 0; index < batch.length; index += 1) {
          if (!mountedRef.current || projectRef.current.id !== expectedProjectId) return;
          const column = index % 4;
          const row = Math.floor(index / 4);
          await addSharedMediaAt(batch[index], { x: point.x + column * 380, y: point.y + row * 300 });
        }
      })();
      return;
    }
    const sharedMedia = batch[0] ?? workflowDropSharedMedia(event.dataTransfer);
    if (sharedMedia) {
      void addSharedMediaAt(sharedMedia, point);
      return;
    }
    const files = workflowDropFiles(event.dataTransfer);
    const mediaFiles = files.filter(item => {
      try { workflowMediaType(item); return true; } catch { return false; }
    });
    if (!mediaFiles.length) {
      if (files.length) setNotice('仅支持图片、视频或音频文件');
      return;
    }
    const skipped = files.length - mediaFiles.length;
    const expectedProjectId = projectRef.current.id;
    void (async () => {
      // Sequential on purpose: each addMediaAt persists its node before the next starts,
      // so concurrent uploads cannot overwrite one another's project snapshot.
      for (let index = 0; index < mediaFiles.length; index += 1) {
        if (!mountedRef.current || projectRef.current.id !== expectedProjectId) return;
        const column = index % 4;
        const row = Math.floor(index / 4);
        await addMediaAt(mediaFiles[index], { x: point.x + column * 380, y: point.y + row * 300 }, expectedProjectId);
      }
      if (skipped > 0 && mountedRef.current) setNotice('已导入 ' + mediaFiles.length + ' 个媒体文件，跳过 ' + skipped + ' 个不支持的文件');
    })();
  }, [addMediaAt, addSharedMediaAt, screenToWorkflow, viewportCenter]);

  const localPoint = useCallback((clientX: number, clientY: number): WorkflowPoint => {
    const rect = rootRef.current?.getBoundingClientRect();
    return { x: clientX - (rect?.left || 0), y: clientY - (rect?.top || 0) };
  }, []);

  const openCreateMenu = useCallback((clientX: number, clientY: number, sourceId?: string, targetId?: string) => {
    const rect = rootRef.current?.getBoundingClientRect();
    const local = localPoint(clientX, clientY);
    if ((!sourceId && !targetId) || !createMenuOpenerRef.current) createMenuOpenerRef.current = rootRef.current;
    setCreateMenu({
      world: screenToWorkflow(clientX, clientY),
      anchor: {
        x: Math.max(8, Math.min(local.x, (rect?.width || 1000) - 296)),
        y: Math.max(8, Math.min(local.y, (rect?.height || 700) - 360)),
      },
      sourceId,
      targetId,
    });
    setContextMenu(null);
  }, [localPoint, screenToWorkflow]);

  const getConnectionDropTarget = useCallback((clientX: number, clientY: number, originId: string, direction: 'out' | 'in'): ConnectionDropTarget => {
    const world = screenToWorkflow(clientX, clientY);
    const scale = Math.max(viewportRef.current.k, 0.05);
    const padding = CONNECTION_NODE_PADDING / scale;
    const handleRadius = CONNECTION_HANDLE_RADIUS / scale;
    let bestId: string | null = null;
    let bestPriority = Number.POSITIVE_INFINITY;
    let isNearNode = false;
    let reason: string | undefined;
    const snapshot = currentSnapshot();

    [...projectRef.current.nodes].reverse().forEach(node => {
      const anchorX = node.position.x;
      const anchorY = node.position.y + node.height / 2;
      const dx = world.x - anchorX;
      const dy = world.y - anchorY;
      const hitsHandle = dx * dx + dy * dy <= handleRadius * handleRadius;
      const hitsInside = world.x >= node.position.x && world.x <= node.position.x + node.width && world.y >= node.position.y && world.y <= node.position.y + node.height;
      const hitsExpanded = world.x >= node.position.x - padding && world.x <= node.position.x + node.width + padding && world.y >= node.position.y - padding && world.y <= node.position.y + node.height + padding;
      if (!hitsHandle && !hitsInside && !hitsExpanded) return;
      isNearNode = true;
      const validation = direction === 'in'
        ? validateWorkflowConnection(snapshot, node.id, originId)
        : validateWorkflowConnection(snapshot, originId, node.id);
      if (validation.ok === false) {
        reason ||= validation.reason;
        return;
      }
      const priority = hitsHandle ? 0 : hitsInside ? 1 : 2;
      if (priority < bestPriority) {
        bestId = node.id;
        bestPriority = priority;
      }
    });
    return { nodeId: bestId, isNearNode, reason };
  }, [currentSnapshot, screenToWorkflow]);

  const updateInteraction = useCallback((clientX: number, clientY: number, pointerId: number) => {
    const interaction = interactionRef.current;
    if (!interaction || interaction.pointerId !== pointerId) return;
    if (interaction.type === 'node') {
      const point = screenToWorkflow(clientX, clientY);
      let dx = point.x - interaction.start.x;
      let dy = point.y - interaction.start.y;
      interaction.moved = dx !== 0 || dy !== 0;
      // Hide the selection overlay only once this press has turned into a real
      // drag — a click without movement keeps the toolbar visible.
      if (interaction.moved) setOverlayHidden(true);
      if (interaction.moved) setLiftedNodeIds(current => current ?? new Set(interaction.positions.keys()));
      let snapGuidesState: { x?: number[]; y?: number[] } | null = null;
      if (snapEnabledRef.current && interaction.positions.size > 0) {
        const SNAP_THRESHOLD = 8;
        const draggedIds = new Set(interaction.positions.keys());
        const firstEntry = [...interaction.positions.entries()][0];
        const draggedNode = interaction.frame.nodes.find(n => n.id === firstEntry[0]);
        if (draggedNode) {
          const px = firstEntry[1].x + dx;
          const py = firstEntry[1].y + dy;
          const cx = px + draggedNode.width / 2;
          const cy = py + draggedNode.height / 2;
          const dragXLines = [px, px + draggedNode.width, cx];
          const dragYLines = [py, py + draggedNode.height, cy];
          let snapDx: number | null = null;
          let snapDy: number | null = null;
          let minDx = SNAP_THRESHOLD;
          let minDy = SNAP_THRESHOLD;
          const guideXs: number[] = [];
          const guideYs: number[] = [];
          for (const other of interaction.frame.nodes) {
            if (draggedIds.has(other.id)) continue;
            const ox = other.position.x;
            const oy = other.position.y;
            const ocx = ox + other.width / 2;
            const ocy = oy + other.height / 2;
            const otherXLines = [ox, ox + other.width, ocx];
            const otherYLines = [oy, oy + other.height, ocy];
            for (let i = 0; i < dragXLines.length; i++) {
              for (let j = 0; j < otherXLines.length; j++) {
                const dist = Math.abs(dragXLines[i] - otherXLines[j]);
                if (dist < minDx) { minDx = dist; snapDx = otherXLines[j] - dragXLines[i]; guideXs.length = 0; guideXs.push(otherXLines[j]); }
                else if (dist < SNAP_THRESHOLD * 0.5 && snapDx !== null) { guideXs.push(otherXLines[j]); }
              }
            }
            for (let i = 0; i < dragYLines.length; i++) {
              for (let j = 0; j < otherYLines.length; j++) {
                const dist = Math.abs(dragYLines[i] - otherYLines[j]);
                if (dist < minDy) { minDy = dist; snapDy = otherYLines[j] - dragYLines[i]; guideYs.length = 0; guideYs.push(otherYLines[j]); }
                else if (dist < SNAP_THRESHOLD * 0.5 && snapDy !== null) { guideYs.push(otherYLines[j]); }
              }
            }
          }
          const guides: { x?: number[]; y?: number[] } = {};
          if (snapDx !== null) { dx += snapDx; guides.x = guideXs; }
          if (snapDy !== null) { dy += snapDy; guides.y = guideYs; }
          if (guides.x || guides.y) snapGuidesState = guides;
        }
      }
      setSnapGuides(snapGuidesState);
      const positions = new Map<string, WorkflowPoint>();
      interaction.frame.nodes.forEach(node => {
        const start = interaction.positions.get(node.id);
        if (start) positions.set(node.id, { x: start.x + dx, y: start.y + dy });
      });
      interaction.preview = positions;
      setInteractionPreview({ kind: 'node', positions });
      return;
    }
    if (interaction.type === 'resize') {
      const point = screenToWorkflow(clientX, clientY);
      const dx = point.x - interaction.start.x;
      const dy = point.y - interaction.start.y;
      let width = Math.max(180, interaction.width + dx);
      let height = Math.max(100, interaction.height + dy);
      const resizingNode = interaction.frame.nodes.find(node => node.id === interaction.id);
      if (resizingNode && (resizingNode.type === 'image' || resizingNode.type === 'video') && resizingNode.freeResize !== true) {
        const ratio = (resizingNode.metadata.naturalWidth || interaction.width) / (resizingNode.metadata.naturalHeight || interaction.height);
        height = width / ratio;
        if (height < 100) {
          height = 100;
          width = height * ratio;
        }
        width = Math.round(width);
        height = Math.round(height);
      }
      if (resizingNode?.type === 'audio') height = 120;
      interaction.moved = width !== interaction.width || height !== interaction.height;
      interaction.preview = { width, height };
      setInteractionPreview({ kind: 'resize', id: interaction.id, width, height });
      return;
    }
    if (interaction.type === 'pan') {
      const point = localPoint(clientX, clientY);
      patchProject({ viewport: {
        ...interaction.viewport,
        x: interaction.viewport.x + point.x - interaction.start.x,
        y: interaction.viewport.y + point.y - interaction.start.y,
      } });
      return;
    }
    if (interaction.type === 'selection') {
      const current = screenToWorkflow(clientX, clientY);
      interaction.box = { ...interaction.box, current };
      const left = Math.min(interaction.box.start.x, current.x);
      const right = Math.max(interaction.box.start.x, current.x);
      const top = Math.min(interaction.box.start.y, current.y);
      const bottom = Math.max(interaction.box.start.y, current.y);
      const ids = projectRef.current.nodes
        .filter(node => node.position.x < right && node.position.x + node.width > left && node.position.y < bottom && node.position.y + node.height > top)
        .map(node => node.id);
      selectNodes(interaction.box.additive ? Array.from(new Set([...interaction.box.initialIds, ...ids])) : ids);
      setSelectionBox(interaction.box);
      return;
    }
    const dropTarget = getConnectionDropTarget(clientX, clientY, interaction.originId, interaction.direction);
    setConnectionDrag({ sourceId: interaction.originId, point: screenToWorkflow(clientX, clientY), targetId: dropTarget.nodeId, direction: interaction.direction, local: localPoint(clientX, clientY) });
  }, [getConnectionDropTarget, localPoint, patchProject, screenToWorkflow, selectNodes]);

  const scheduleInteractionMove = useCallback((clientX: number, clientY: number, pointerId: number) => {
    if (interactionRef.current?.pointerId !== pointerId) return;
    pendingMoveRef.current = { clientX, clientY, pointerId };
    if (animationFrameRef.current !== null) return;
    animationFrameRef.current = window.requestAnimationFrame(() => {
      animationFrameRef.current = null;
      const pending = pendingMoveRef.current;
      pendingMoveRef.current = null;
      if (pending) updateInteraction(pending.clientX, pending.clientY, pending.pointerId);
    });
  }, [updateInteraction]);

  const flushPendingMove = useCallback(() => {
    if (animationFrameRef.current !== null) window.cancelAnimationFrame(animationFrameRef.current);
    animationFrameRef.current = null;
    const pending = pendingMoveRef.current;
    pendingMoveRef.current = null;
    if (pending) updateInteraction(pending.clientX, pending.clientY, pending.pointerId);
  }, [updateInteraction]);

  const finishInteraction = useCallback((clientX: number, clientY: number, pointerId: number) => {
    const interaction = interactionRef.current;
    if (!interaction || interaction.pointerId !== pointerId) return;
    flushPendingMove();
    updateInteraction(clientX, clientY, pointerId);
    interactionRef.current = null;
    setOverlayHidden(false);
    setLiftedNodeIds(null);
    setSnapGuides(null);
    if (interaction.type === 'node' || interaction.type === 'resize') {
      setInteractionPreview(null);
      const frame = interaction.frame;
      const previewPositions = interaction.type === 'node' ? interaction.preview : undefined;
      const previewSize = interaction.type === 'resize' ? interaction.preview : undefined;
      const resizedId = interaction.type === 'resize' ? interaction.id : undefined;
      if (!interaction.moved || (!previewPositions && !previewSize)) return;
      // 拖拽期间只渲染预览；松手时把最终位置/尺寸作为单次变更写入历史与存储。
      const nextNodes = previewSize
        ? frame.nodes.map(node => node.id === resizedId ? { ...node, width: previewSize.width, height: previewSize.height } : node)
        : frame.nodes.map(node => {
          const position = previewPositions?.get(node.id);
          return position ? { ...node, position } : node;
        });
      pushHistory(frame, { nodes: nextNodes, connections: frame.connections });
      return;
    }
    if (interaction.type === 'selection') {
      setSelectionBox(null);
      return;
    }
    if (interaction.type !== 'connection') return;

    const dropTarget = getConnectionDropTarget(clientX, clientY, interaction.originId, interaction.direction);
    setConnectionDrag(null);
    if (dropTarget.nodeId) {
      createMenuOpenerRef.current = null;
      if (interaction.direction === 'in') {
        applyOps([{ type: 'connect_nodes', fromNodeId: dropTarget.nodeId, toNodeId: interaction.originId }]);
      } else {
        applyOps([{ type: 'connect_nodes', fromNodeId: interaction.originId, toNodeId: dropTarget.nodeId }]);
      }
    } else if (dropTarget.isNearNode) {
      createMenuOpenerRef.current = null;
      setNotice(dropTarget.reason || '无法连接到该节点');
    } else if (interaction.direction === 'in') {
      openCreateMenu(clientX, clientY, undefined, interaction.originId);
    } else {
      openCreateMenu(clientX, clientY, interaction.originId, undefined);
    }
  }, [applyOps, flushPendingMove, getConnectionDropTarget, openCreateMenu, pushHistory, updateInteraction]);

  const cancelInteraction = useCallback((pointerId?: number) => {
    const interaction = interactionRef.current;
    if (pointerId !== undefined && interaction?.pointerId !== pointerId) return;
    if (animationFrameRef.current !== null) window.cancelAnimationFrame(animationFrameRef.current);
    animationFrameRef.current = null;
    pendingMoveRef.current = null;
    interactionRef.current = null;
    setOverlayHidden(false);
    setLiftedNodeIds(null);
    // 拖拽期间的改动只存在于预览状态，取消时直接丢弃，无需写回存储。
    setInteractionPreview(null);
    if (interaction?.type === 'pan') patchProject({ viewport: interaction.viewport });
    if (interaction?.type === 'selection') selectNodes(interaction.box.initialIds);
    if (interaction?.type === 'connection') createMenuOpenerRef.current = null;
    setSelectionBox(null);
    setConnectionDrag(null);
    setSnapGuides(null);
    spacePressedRef.current = false;
  }, [patchProject, selectNodes]);

  useEffect(() => {
    const move = (event: PointerEvent) => scheduleInteractionMove(event.clientX, event.clientY, event.pointerId);
    const up = (event: PointerEvent) => finishInteraction(event.clientX, event.clientY, event.pointerId);
    const cancel = (event: PointerEvent) => cancelInteraction(event.pointerId);
    const blur = () => cancelInteraction();
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('blur', blur);
      if (animationFrameRef.current !== null) window.cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
      pendingMoveRef.current = null;
    };
  }, [cancelInteraction, finishInteraction, scheduleInteractionMove]);

  const undo = useCallback(() => {
    const result = undoWorkflowDraftChangeSet(projectRef.current);
    if (result.ok === false) return;
    applyDraftProject(result.project);
  }, [applyDraftProject]);

  const redo = useCallback(() => {
    const result = redoWorkflowDraftChangeSet(projectRef.current);
    if (result.ok === false) return;
    applyDraftProject(result.project);
  }, [applyDraftProject]);

  const syncToSharedClipboard = useCallback((nodes: WorkflowNodeData[]) => {
    const mediaNodes = nodes.filter(node => (node.type === 'image' || node.type === 'video') && (node.metadata.storageKey || node.metadata.href));
    if (mediaNodes.length === 0) return;
    void (async () => {
      const items: ClipItem[] = [];
      for (const node of mediaNodes) {
        try {
          const blob = await loadWorkflowMediaBlob(node.metadata.storageKey, node.metadata.href);
          items.push({
            id: nanoid(),
            kind: node.type as 'image' | 'video',
            blob,
            mimeType: node.metadata.mimeType || (node.type === 'image' ? 'image/png' : 'video/mp4'),
            name: node.metadata.name || node.title || `workflow-${node.type}`,
            naturalWidth: node.metadata.naturalWidth,
            naturalHeight: node.metadata.naturalHeight,
            sourceView: 'workflow',
          });
        } catch { /* skip unreadable */ }
      }
      if (items.length === 0) return;
      useClipboardStore.getState().setItems(items);
      const firstImage = items.find(item => item.kind === 'image');
      if (firstImage && navigator.clipboard?.write) {
        try {
          const ci = new ClipboardItem({ [firstImage.mimeType]: firstImage.blob });
          await navigator.clipboard.write([ci]);
        } catch { /* ignore */ }
      }
    })();
  }, []);

  const copyNodesToClipboard = useCallback((ids: readonly string[]) => {
    const current = projectRef.current;
    const clip = copyWorkflowSelection({ projectId: current.id, nodes: current.nodes, connections: current.connections, ids });
    useClipboardStore.getState().setWorkflowClip(clip);
    clipboardRef.current = clip?.nodes || [];
    setClipboardVersion(version => version + 1);
    if (clip) syncToSharedClipboard(clip.nodes.filter(node => ids.includes(node.id)));
  }, [syncToSharedClipboard]);

  const copySelection = useCallback(() => {
    copyNodesToClipboard(selectedIdsRef.current);
  }, [copyNodesToClipboard]);

  // 分组（P1-1）：分组框 = subgraph(groupKind 'group') + 成员 parentId；不再复用 batchId。
  const groupSelection = useCallback((ids: readonly string[]) => {
    const current = projectRef.current;
    const editable = ids.filter(id => !current.nodes.find(node => node.id === id)?.isLocked);
    if (editable.length < 2) return;
    try {
      const plan = buildGroupCreateOps(current.nodes, editable, { groupId: 'group-' + nanoid() });
      if (applyOps(plan.ops)) selectNodes([plan.groupId]);
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause));
    }
  }, [applyOps, selectNodes]);

  const ungroupSelection = useCallback((ids: readonly string[]) => {
    const current = projectRef.current;
    const frames = ids.filter(id => isGroupFrame(current.nodes.find(node => node.id === id)));
    const ops: WorkflowDocumentOperation[] = frames.flatMap(id => buildUngroupOps(current.nodes, id));
    // 旧的 batchId 分组（分镜 / 批量命令建的）仍按原方式解散。
    const legacy = ids.filter(id => !frames.includes(id) && current.nodes.find(node => node.id === id)?.batchId);
    if (legacy.length) ops.push({ type: 'ungroup_nodes', ids: legacy });
    if (ops.length) applyOps(ops);
  }, [applyOps]);
  // 快捷键 A：有选区 = 与 Agent 讨论；没有 = 在视口中心打开「问 Agent」。在 keydown effect 里经 ref 调用（定义在后面）。
  const agentShortcutRef = useRef<() => void>(() => undefined);
  const groupSelectionRef = useRef(groupSelection);
  groupSelectionRef.current = groupSelection;
  const ungroupSelectionRef = useRef(ungroupSelection);
  ungroupSelectionRef.current = ungroupSelection;

  const pasteSelection = useCallback(async () => {
    const expectedProjectId = projectRef.current.id;
    const workflowClip = useClipboardStore.getState().workflowClip;
    if (workflowClip && workflowClip.nodes.length > 0) {
      // 同项目：原位偏移 32；跨项目：放到鼠标位置（不在画布内则视口中心）。连线、分组、@chip 一并重映射 id。
      const sameProject = workflowClip.sourceProjectId === expectedProjectId;
      let anchor: { x: number; y: number } | undefined;
      if (!sameProject) {
        const rect = rootRef.current?.getBoundingClientRect();
        const mouse = mousePosRef.current;
        const inBounds = rect && mouse.x >= rect.left && mouse.x <= rect.right && mouse.y >= rect.top && mouse.y <= rect.bottom;
        anchor = inBounds ? screenToWorkflow(mouse.x, mouse.y) : viewportCenter();
      }
      const pasted = pasteWorkflowClip(workflowClip, { createId: nanoid, ...(anchor ? { anchor } : {}) });
      commitFrame([...projectRef.current.nodes, ...pasted.nodes], [...projectRef.current.connections, ...pasted.connections]);
      selectNodes(pasted.nodes.filter(node => !node.parentId).map(node => node.id));
      return;
    }
    const clipItems = useClipboardStore.getState().items;
    if (clipItems.length > 0) {
      const rect = rootRef.current?.getBoundingClientRect();
      const mouse = mousePosRef.current;
      const inBounds = rect && mouse.x >= rect.left && mouse.x <= rect.right && mouse.y >= rect.top && mouse.y <= rect.bottom;
      const basePoint = inBounds ? screenToWorkflow(mouse.x, mouse.y) : viewportCenter();
      for (let i = 0; i < clipItems.length; i++) {
        const item = clipItems[i];
        const offset = i * 32;
        const file = new File([item.blob], item.name, { type: item.mimeType });
        await addMediaAt(file, { x: basePoint.x + offset, y: basePoint.y + offset }, expectedProjectId);
      }
      return;
    }
    try {
      const clipboard = navigator.clipboard;
      const items = clipboard?.read ? await clipboard.read() : [];
      if (!mountedRef.current || projectRef.current.id !== expectedProjectId) return;
      for (const item of items) {
        const imageType = item.types.find(type => type.startsWith('image/'));
        if (imageType) {
          const blob = await item.getType(imageType);
          await addMediaAt(new File([blob], `clipboard.${imageType.split('/')[1] || 'png'}`, { type: imageType }), viewportCenter(), expectedProjectId);
          return;
        }
        if (item.types.includes('text/plain')) {
          const blob = await item.getType('text/plain');
          const text = typeof blob.text === 'function'
            ? await blob.text()
            : await new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result || ''));
                reader.onerror = () => reject(reader.error || new Error('无法读取剪贴板文本'));
                reader.readAsText(blob);
              });
          if (text) {
            const center = viewportCenter();
            const node = createWorkflowNode(nanoid(), 'text', { x: center.x - 170, y: center.y - 110 }, { content: text });
            applyOps([{ type: 'add_node', node }]);
          }
          return;
        }
      }
      const text = clipboard?.readText ? await clipboard.readText() : '';
      if (text && mountedRef.current && projectRef.current.id === expectedProjectId) {
        const center = viewportCenter();
        applyOps([{ type: 'add_node', node: createWorkflowNode(nanoid(), 'text', { x: center.x - 170, y: center.y - 110 }, { content: text }) }]);
      }
    } catch (error) {
      if (mountedRef.current && projectRef.current.id === expectedProjectId) setNotice(displayError(error, '无法读取剪贴板内容'));
    }
  }, [addMediaAt, applyOps, commitFrame, screenToWorkflow, selectNodes, viewportCenter]);
  const deleteSelection = useCallback(() => {
    if (selectedConnectionId) {
      commitFrame(projectRef.current.nodes, projectRef.current.connections.filter(connection => connection.id !== selectedConnectionId));
      setSelectedConnectionId(null);
      return;
    }
    const selected = selectedIdsRef.current;
    // 删除子画布框时连同其子节点一起删除（同一次 apply，Ctrl+Z 整体恢复）。
    const removedSubgraphs = new Set(projectRef.current.nodes.filter(node => node.type === 'subgraph' && !node.isLocked && selected.includes(node.id)).map(node => node.id));
    const deletableIds = projectRef.current.nodes
      .filter(node => !node.isLocked && (selected.includes(node.id) || Boolean(node.parentId && removedSubgraphs.has(node.parentId))))
      .map(node => node.id);
    if (!deletableIds.length) return;
    applyOps([{ type: 'delete_nodes', ids: deletableIds }]);
    // UX-HEU-10: surface the destructive action so the user has a recovery path.
    // Ctrl+Z still restores the nodes — the toast advertises that affordance.
    onNotify?.(language === 'zho' ? `已删除 ${deletableIds.length} 个节点 — Ctrl+Z 撤销` : `Deleted ${deletableIds.length} node${deletableIds.length > 1 ? 's' : ''} — Ctrl+Z to undo`, 'info');
  }, [applyOps, commitFrame, language, onNotify, selectedConnectionId]);
  // 双击子画布：切到 Cut（内部视图 'reverse'）并选中对应逆向工程。
  const openSubgraphInReverse = useCallback((node: WorkflowNodeData) => {
    const reverseProjectId = node.metadata.reverseProjectId;
    if (!reverseProjectId) return;
    const reverse = useReverseStore.getState();
    const target = reverse.projects.find(item => item.id === reverseProjectId);
    if (!target) {
      onNotify?.(language === 'zho' ? '对应的逆向工程已不存在' : 'The linked reverse-breakdown project no longer exists', 'warning');
      return;
    }
    reverse.setTab(target.direction);
    reverse.setActive(target.direction, target.id);
    useWorkspaceStore.getState().setCanvasView('reverse');
  }, [language, onNotify]);
  const duplicateSelection = useCallback(() => {
    const result = duplicateNodes(projectRef.current.nodes, selectedIdsRef.current);
    if (!result) return;
    commitFrame(result.nodes, projectRef.current.connections);
    selectNodes(result.ids);
  }, [commitFrame, selectNodes]);


  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (nudgeBaseRef.current && !event.key.startsWith('Arrow')) flushNudge();
      const target = event.target instanceof Element ? event.target : null;
      // The non-modal confirm owns its own keys; Delete/Esc there must not act on the canvas selection.
      if (target?.closest('.iris-confirm')) return;
      if (event.code === 'Space') {
        if (target?.closest(SPACE_BLOCKED_TARGET)) return;
        event.preventDefault();
        spacePressedRef.current = true;
        return;
      }
      if (event.key === 'Escape') { setActiveMedia(null); setKeyboardConnectionSourceId(null); }
      // UX-HEU-02: Delete/Backspace must work whenever a node is selected, even
      // if focus happens to sit on a toolbar button — buttons consume
      // Space/Enter but never Delete. Only editable targets (textarea/input/
      // contenteditable/video/audio) may swallow the keystroke, because there
      // Delete means "erase a character", not "erase the node".
      const isDeleteKey = event.key === 'Delete' || event.key === 'Backspace';
      if (isDeleteKey) {
        if (target?.closest(DELETE_BLOCKED_TARGET)) return;
        event.preventDefault();
        deleteSelection();
        return;
      }
      if (target?.closest(BLOCKED_TARGET)) return;
      const modifier = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (modifier && key === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); return; }
      if (modifier && key === 'y') { event.preventDefault(); redo(); return; }
      if (modifier && key === 'c') { event.preventDefault(); copySelection(); return; }
      if (modifier && key === 'v') { event.preventDefault(); void pasteSelection(); return; }
      if (modifier && key === 'a') { event.preventDefault(); selectNodes(projectRef.current.nodes.filter(node => node.isVisible !== false).map(node => node.id)); return; }
      if (modifier && key === 'd') { event.preventDefault(); duplicateSelection(); return; }
      const nudge = !modifier && selectedIdsRef.current.length ? arrowNudge(event.key, event.shiftKey) : null;
      if (nudge) {
        event.preventDefault();
        const next = offsetNodes(projectRef.current.nodes, selectedIdsRef.current, nudge[0], nudge[1]);
        if (!next) return;
        if (!nudgeBaseRef.current) nudgeBaseRef.current = currentFrame();
        patchProject({ nodes: next });
        return;
      }
      if (modifier && key === 'g') {
        event.preventDefault();
        // Ctrl+G 建分组框（与批次 / 备选无关）；Ctrl+Shift+G 解散选中的分组。
        if (event.shiftKey) ungroupSelectionRef.current(selectedIdsRef.current);
        else groupSelectionRef.current(selectedIdsRef.current);
        return;
      }
      // F — Frame Selection（Premiere/AE 约定）：无修饰键时把选中节点居中缩放。
      // Alt+Shift+F — 自动整理（快捷键卡片已公布）；用 event.code 兼容 macOS Option 组合字符。
      if (!modifier && event.altKey && event.shiftKey && event.code === 'KeyF') { event.preventDefault(); autoLayout(); return; }
      if (!modifier && !event.altKey && key === 'f') { event.preventDefault(); frameSelection(); return; }
      if (!modifier && !event.altKey && !event.shiftKey && key === 'a' && !event.repeat) { event.preventDefault(); agentShortcutRef.current(); return; }
      if (event.key === '/' && !modifier && !slashMenuRef.current) {
        event.preventDefault();
        const rect = rootRef.current?.getBoundingClientRect();
        setSlashMenu({ x: (rect?.width || 1000) / 2 - 160, y: (rect?.height || 700) / 2 - 200 });
        return;
      }
      if (event.key === 'Escape') {
        if (slashMenuRef.current) { setSlashMenu(null); return; }
        closeCreateMenu();
        setContextMenu(null);
        cancelInteraction();
      }
    };
    const keyup = (event: KeyboardEvent) => {
      if (event.code === 'Space') spacePressedRef.current = false;
      if (event.key.startsWith('Arrow')) flushNudge();
    };
    window.addEventListener('keydown', keydown);
    window.addEventListener('keyup', keyup);
    window.addEventListener('blur', flushNudge);
    return () => {
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('keyup', keyup);
      window.removeEventListener('blur', flushNudge);
    };
  }, [applyOps, autoLayout, cancelInteraction, closeCreateMenu, copySelection, currentFrame, deleteSelection, duplicateSelection, flushNudge, frameSelection, pasteSelection, patchProject, redo, selectNodes, undo]);

  const addNode = useCallback((type: WorkflowNodeType, metadata: WorkflowNodeData['metadata'] = {}) => {
    const center = viewportCenter();
    // UX-PRO-03: dropping every new node at the exact same point means the
    // newest hides whatever was added before it. Cascade the spawn position
    // diagonally whenever the proposed slot is already occupied so each node
    // is visible and grabbable without manual untangling.
    let x = center.x - 170;
    let y = center.y - 110;
    for (let i = 0; i < 12; i += 1) {
      const occupied = projectRef.current.nodes.some(node =>
        node.isVisible !== false && Math.abs(node.position.x - x) < 30 && Math.abs(node.position.y - y) < 30);
      if (!occupied) break;
      x += 40;
      y += 40;
    }
    applyOps([{ type: 'add_node', node: createWorkflowNode(nanoid(), type, { x, y }, metadata) }]);
  }, [applyOps, viewportCenter]);

  // 标注为示例的画布：浏览与编辑不需要 Key，运行时走同一配置引导。
  const openSampleCanvas = useCallback(() => {
    const zh = language === 'zho';
    const center = viewportCenter();
    const script = createWorkflowNode(nanoid(), 'text', { x: center.x - 640, y: center.y - 120 }, {
      content: zh
        ? '【示例】三镜头产品短片。浏览、编辑、连线都不需要 Key；运行镜头前需先在设置中配置自己的 AI 服务。'
        : '[Sample] A three-shot product clip. Browsing, editing and connecting need no key; running a shot needs your own AI service in Settings.',
    });
    script.title = zh ? '示例 · 脚本' : 'Sample · Script';
    const prompts = zh
      ? ['产品全景，镜头缓慢推进，柔光', '产品特写，侧光扫过材质', '产品落幅，镜头拉远，留白放标题']
      : ['Product wide shot, slow push-in, soft light', 'Product close-up, side light across the surface', 'End card, pull back, space for a title'];
    const shots = prompts.map((prompt, index) => {
      const node = createWorkflowNode(nanoid(), 'video', { x: center.x - 160 + index * 420, y: center.y - 120 }, { prompt });
      node.title = zh ? '示例 · 镜头 ' + (index + 1) : 'Sample · Shot ' + (index + 1);
      return node;
    });
    const ops: WorkflowDocumentOperation[] = [
      { type: 'add_node', node: script },
      ...shots.map(node => ({ type: 'add_node' as const, node })),
    ];
    if (applyOps(ops)) {
      setNotice(zh ? '已打开示例画布：浏览和编辑不需要 Key，运行生成前需要先配置 AI 服务。' : 'Sample canvas opened. Browsing and editing need no key; running needs an AI service.');
    }
  }, [applyOps, language, viewportCenter]);

  const replaceMedia = useCallback(async (node: WorkflowNodeData, file: File) => {
    if (node.isLocked) return;
    // 换素材：正在后台生成的旧预览作废。
    ingestAbortRef.current.get(node.id)?.abort();
    setActiveMedia(current => current?.nodeId === node.id ? null : current);
    const expectedProjectId = projectRef.current.id;
    const sequence = (replaceSequenceRef.current.get(node.id) || 0) + 1;
    replaceSequenceRef.current.set(node.id, sequence);
    let record: WorkflowMediaRecord | undefined;
    try {
      if (workflowMediaType(file) !== node.type) throw new Error(`请选择${node.type === 'image' ? '图片' : node.type === 'video' ? '视频' : '音频'}文件`);
      commitFrame(projectRef.current.nodes.map(item => item.id === node.id
        ? { ...item, metadata: { ...item.metadata, uploading: true, uploadBytes: file.size } }
        : item), projectRef.current.connections);
      record = await ingestWorkflowMedia(file, undefined, { deferPreview: true });
      const currentNode = projectRef.current.nodes.find(item => item.id === node.id);
      if (!mountedRef.current
        || projectRef.current.id !== expectedProjectId
        || replaceSequenceRef.current.get(node.id) !== sequence
        || !currentNode) {
        await discardWorkflowMediaRecord(record.storageKey);
        return;
      }
      const { type: _type, warning, pendingPreview, ...metadata } = record;
      const size = fitWorkflowMediaSize(currentNode.type as WorkflowMediaRecord['type'], record.naturalWidth, record.naturalHeight);
      const center = { x: currentNode.position.x + currentNode.width / 2, y: currentNode.position.y + currentNode.height / 2 };
      const updated = projectRef.current.nodes.map(item => item.id === node.id ? {
        ...item,
        ...size,
        position: { x: center.x - size.width / 2, y: center.y - size.height / 2 },
        metadata: { ...item.metadata, previewStorageKey: undefined, ...metadata, href: undefined, error: undefined, uploading: false },
      } : item);
      commitFrame(updated, projectRef.current.connections);
      releaseWorkflowMediaRecord(record.storageKey);
      if (pendingPreview) {
        setNotice(null);
        void buildVideoPreviewInBackground(node.id, record.storageKey, file);
      } else {
        setNotice(warning ?? null);
      }
    } catch (error) {
      if (record) await discardWorkflowMediaRecord(record.storageKey);
      if (mountedRef.current
        && projectRef.current.id === expectedProjectId
        && replaceSequenceRef.current.get(node.id) === sequence) {
        commitFrame(projectRef.current.nodes.map(item => item.id === node.id
          ? { ...item, metadata: { ...item.metadata, uploading: false } }
          : item), projectRef.current.connections);
        setNotice(displayError(error, '媒体文件替换失败'));
      }
    }
  }, [buildVideoPreviewInBackground, commitFrame]);
  useEffect(() => { replaceMediaRef.current = replaceMedia; }, [replaceMedia]);

  const addSharedMedia = useCallback(async (media: WorkflowSharedMedia) => {
    await addSharedMediaAt(media, viewportCenter());
  }, [addSharedMediaAt, viewportCenter]);
  // 放大的 History 窗口「插入画布」走这里，和工具栏历史面板同一条路径。
  useEffect(() => useStudioHubStore.getState().register('insertHistory', media => { void addSharedMedia(media); }), [addSharedMedia]);
  // Timeline「定位节点」：只处理当前画布；选中这些节点并框到视口中央（同 F 键）。
  useEffect(() => useStudioHubStore.getState().register('focusNodes', (targetProjectId, nodeIds) => {
    if (targetProjectId !== projectRef.current.id) return false;
    const ids = nodeIds.filter(id => projectRef.current.nodes.some(node => node.id === id && node.isVisible !== false));
    if (!ids.length) return false;
    selectNodes(ids);
    window.requestAnimationFrame(() => frameSelection());
    return true;
  }), [frameSelection, selectNodes]);

  const removeMedia = useCallback((node: WorkflowNodeData) => {
    if (node.isLocked) return;
    const {
      storageKey: _storageKey,
      posterStorageKey: _posterStorageKey,
      previewStorageKey: _previewStorageKey,
      name: _name,
      mimeType: _mimeType,
      bytes: _bytes,
      naturalWidth: _naturalWidth,
      naturalHeight: _naturalHeight,
      durationMs: _durationMs,
      href: _href,
      artifactRef: _artifactRef,
      poster: _poster,
      error: _error,
      ...metadata
    } = node.metadata;
    setActiveMedia(current => current?.nodeId === node.id ? null : current);
    commitFrame(projectRef.current.nodes.map(item => item.id === node.id
      ? { ...item, metadata: { ...metadata, status: 'idle' as const } }
      : item), projectRef.current.connections);
  }, [commitFrame]);

  const createFromMenu = useCallback((type: WorkflowNodeType) => {
    if (!createMenu) return;
    const node = createWorkflowNode(nanoid(), type, createMenu.world);
    let success: boolean;
    if (createMenu.sourceId) {
      success = applyOps([{ type: 'create_connected_node', fromNodeId: createMenu.sourceId, node }]);
    } else if (createMenu.targetId) {
      success = applyOps([
        { type: 'add_node', node },
        { type: 'connect_nodes', fromNodeId: node.id, toNodeId: createMenu.targetId },
      ]);
    } else {
      success = applyOps([{ type: 'add_node', node }]);
    }
    if (success) closeCreateMenu();
  }, [applyOps, closeCreateMenu, createMenu]);

  /**
   * 「问 Agent」：在双击位置（或快捷键时的视口中心）放一张会话卡；有文字就直接交给面板在新会话里发送。
   * 卡片只放进空位（不挪任何节点）；附近放不下时放到内容右侧并把视角移过去。
   */
  const askAgentAt = useCallback(async (world: WorkflowPoint, text: string) => {
    const projectId = projectRef.current.id;
    const result = await createAgentSessionCard({ projectId, requestId: canvasAgentRequestId(), origin: 'ask', anchor: { x: world.x - 20, y: world.y - 16, width: 0, height: 0 }, prompt: text });
    if (result.ok === false) { setNotice(result.error); return; }
    closeCreateMenu();
    // 不选中新卡片：选区工具条会盖住画布顶部；光标 / 进度已经在卡片上。
    selectNodes([]);
    if (text.trim()) pushCanvasAgentSend({ projectId, cardNodeId: result.nodeId, text, references: [] });
    else useCanvasAgentStore.getState().requestFocus(result.nodeId);
    if (result.ok && 'fallback' in result && result.fallback) { setNotice('附近没有空位，会话卡放在了画布右侧'); focusNode(result.nodeId); }
  }, [closeCreateMenu, focusNode, selectNodes]);

  /** 「与 Agent 讨论」：选区旁的空位放一张会话卡，选中素材绑定为引用；同一选区还没发出的卡片只定位不新建。 */
  const discussWithAgent = useCallback(async (ids: string[]) => {
    const members = projectRef.current.nodes.filter(node => ids.includes(node.id) && !isAgentSessionNode(node) && node.isVisible !== false);
    const bounds = selectionBounds(members);
    if (!members.length || !bounds) { setNotice('先选中要讨论的素材'); return; }
    const references = agentSessionReferencesFromNodes(arrangementOrder(members, ids));
    const result = await createAgentSessionCard({ projectId: projectRef.current.id, requestId: canvasAgentRequestId(), origin: 'discuss', anchor: bounds, references });
    if (result.ok === false) { setNotice(result.error); return; }
    selectNodes([]);
    useCanvasAgentStore.getState().requestFocus(result.nodeId);
    if ('fallback' in result && result.fallback) { setNotice('选区附近没有空位，会话卡放在了画布右侧'); focusNode(result.nodeId); }
  }, [focusNode, selectNodes]);

  // 按钮触发的视角变化（适配 / 放大缩小 / 重置）走一个欠阻尼弹簧，带一点点回弹；滚轮和捏合仍然即时跟手。
  // 和 focusBounds 一样逐帧 patchProject，叠加层（工具条、提示栏、网格）按 viewport 计算，所以始终对齐。
  const animateViewport = useCallback((target: { x: number; y: number; k: number }) => {
    if (focusAnimRef.current !== null) window.cancelAnimationFrame(focusAnimRef.current);
    const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const start = { ...viewportRef.current };
    if (reduce || (Math.abs(target.x - start.x) < 1 && Math.abs(target.y - start.y) < 1 && Math.abs(target.k - start.k) < 0.005)) {
      focusAnimRef.current = null;
      patchProject({ viewport: target });
      return;
    }
    // 弹簧：ζ≈0.82、ω≈20rad/s，约 380ms 收敛，过冲 <1.5%
    const zeta = 0.82;
    const omega = 20;
    const wd = omega * Math.sqrt(1 - zeta * zeta);
    const spring = (t: number) => 1 - Math.exp(-zeta * omega * t) * (Math.cos(wd * t) + (zeta * omega / wd) * Math.sin(wd * t));
    const startTime = window.performance.now();
    const tick = (now: number) => {
      const t = (now - startTime) / 1000;
      const e = t >= 0.6 ? 1 : spring(t);
      patchProject({ viewport: { x: start.x + (target.x - start.x) * e, y: start.y + (target.y - start.y) * e, k: start.k + (target.k - start.k) * e } });
      focusAnimRef.current = e === 1 ? null : window.requestAnimationFrame(tick);
    };
    focusAnimRef.current = window.requestAnimationFrame(tick);
  }, [patchProject]);

  const fitView = useCallback(() => {
    setFocusBadge(false);
    const rect = rootRef.current?.getBoundingClientRect();
    const nodes = projectRef.current.nodes.filter(node => node.isVisible !== false);
    if (!rect || nodes.length === 0) return;
    const availableWidth = Math.max(360, rect.width);
    const minX = Math.min(...nodes.map(node => node.position.x));
    const minY = Math.min(...nodes.map(node => node.position.y));
    const maxX = Math.max(...nodes.map(node => node.position.x + node.width));
    const maxY = Math.max(...nodes.map(node => node.position.y + node.height));
    const k = Math.min(1.5, Math.max(0.12, Math.min((availableWidth - 160) / Math.max(1, maxX - minX), (rect.height - 160) / Math.max(1, maxY - minY))));
    animateViewport({ x: availableWidth / 2 - ((minX + maxX) / 2) * k, y: rect.height / 2 - ((minY + maxY) / 2) * k, k });
  }, [animateViewport]);

  const zoomBy = useCallback((factor: number) => {
    setFocusBadge(false);
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    const vp = viewportRef.current;
    const k = Math.min(2.5, Math.max(0.12, vp.k * factor));
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    animateViewport({ x: cx - ((cx - vp.x) / vp.k) * k, y: cy - ((cy - vp.y) / vp.k) * k, k });
  }, [animateViewport]);
  const zoomIn = useCallback(() => zoomBy(1.2), [zoomBy]);
  const zoomOut = useCallback(() => zoomBy(1 / 1.2), [zoomBy]);
  const zoomReset = useCallback(() => {
    setFocusBadge(false);
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    animateViewport({ x: rect.width / 2, y: rect.height / 2, k: 1 });
  }, [animateViewport]);

  const startPan = (clientX: number, clientY: number, pointerId: number) => {
    closeCreateMenu();
    setContextMenu(null);
    setSelectedConnectionId(null);
    setConnectionDrag(null);
    setFocusBadge(false);
    interactionRef.current = {
      type: 'pan',
      pointerId,
      start: localPoint(clientX, clientY),
      viewport: { ...viewportRef.current },
    };
  };

  // 子画布框被拖动时，其未锁定的子节点（parentId 指向框）跟随；已在拖动集合中的不重复加入。折叠框的子节点同样跟随。
  const subgraphDragChildren = (nodes: WorkflowNodeData[], ids: readonly string[]) => {
    const dragged = new Set(ids);
    const frames = new Set(nodes.filter(item => item.type === 'subgraph' && dragged.has(item.id)).map(item => item.id));
    return nodes.filter(item => !item.isLocked && !dragged.has(item.id) && Boolean(item.parentId && frames.has(item.parentId)));
  };

  const startBatchDrag = (event: ReactPointerEvent<HTMLDivElement>, batchId: string, batchNodes: WorkflowNodeData[]) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    if (tool === 'pan' || spacePressedRef.current) {
      startPan(event.clientX, event.clientY, event.pointerId);
      setOverlayHidden(true);
      return;
    }
    setContextMenu(null);
    closeCreateMenu();
    setSelectedConnectionId(null);
    // 分组标签既是拖动手柄也是选中入口：选中整组后节点工具栏提供组操作。
    selectNodes(batchNodes.map(item => item.id));
    const frame = currentFrame();
    // 与单选拖动一致：分组含子画布框时子节点跟随，松手时单次写入历史。
    const children = subgraphDragChildren(frame.nodes, batchNodes.map(item => item.id));
    interactionRef.current = {
      type: 'node',
      pointerId: event.pointerId,
      start: screenToWorkflow(event.clientX, event.clientY),
      positions: new Map([...batchNodes, ...children].map(item => [item.id, { ...item.position }])),
      frame,
      moved: false,
      batchId,
    };
    setOverlayHidden(true);
  };

  const startNodeDrag = (event: ReactPointerEvent<HTMLDivElement>, node: WorkflowNodeData) => {
    if (event.button !== 0) return;
    if (focusAnimRef.current !== null) { window.cancelAnimationFrame(focusAnimRef.current); focusAnimRef.current = null; }
    if (tool === 'pan' || spacePressedRef.current) {
      event.stopPropagation();
      event.preventDefault();
      startPan(event.clientX, event.clientY, event.pointerId);
      setOverlayHidden(true);
      return;
    }
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest(NODE_ACTION_TARGET)) return;
    event.stopPropagation();
    setContextMenu(null);
    closeCreateMenu();
    setSelectedConnectionId(null);
    const modifier = event.shiftKey || event.ctrlKey || event.metaKey;
    let ids = selectedIdsRef.current;
    // 组框整组选中是为了组级操作；此时直接拖组内某个节点，应该是“拖这个节点”，
    // 不能让整组跟着移动。要移动整组，拖组框空白处或左上角标签。
    if (!modifier && ids.length > 1 && node.batchId
      && ids.every(id => projectRef.current.nodes.find(item => item.id === id)?.batchId === node.batchId)) {
      ids = [node.id];
    }
    if (modifier) ids = ids.includes(node.id) ? ids.filter(id => id !== node.id) : [...ids, node.id];
    else if (!ids.includes(node.id)) ids = [node.id];
    if (activeMedia && (ids.length !== 1 || ids[0] !== activeMedia.nodeId)) setActiveMedia(null);
    selectNodes(ids);
    if (!ids.includes(node.id) || node.isLocked) return;
    // Only native media CONTROLS should capture the pointer (an active
    // <video controls>/<audio> scrubber genuinely consumes a drag). Passive
    // media surfaces — an image <img>, a video poster/preview, a placeholder —
    // must move the node on drag, matching every editor's grab-the-frame model.
    // Previously [data-workflow-media-preview] was also excluded, which made
    // the whole media body undraggable: dropped/inserted media nodes could be
    // selected but never moved.
    if (target?.closest('video[controls],audio[controls]')) {
      setOverlayHidden(false);
    setLiftedNodeIds(null);
      return;
    }
    const frame = currentFrame();
    // 拖动子画布框时子节点跟随：同一次移动、松手时单次写入。
    const movingIds = new Set([...ids, ...subgraphDragChildren(frame.nodes, ids).map(item => item.id)]);
    interactionRef.current = {
      type: 'node',
      pointerId: event.pointerId,
      start: screenToWorkflow(event.clientX, event.clientY),
      positions: new Map(frame.nodes.filter(item => movingIds.has(item.id)).map(item => [item.id, { ...item.position }])),
      frame,
      moved: false,
    };
    // Don't hide the overlay yet: a plain press selects the node, and the
    // toolbar must stay up for a click. We only hide it once the pointer
    // actually moves into a drag — see updateInteraction's `moved` flip.
  };

  const isTrueBackground = (target: EventTarget | null) => {
    if (!(target instanceof Element) || target.closest(BLOCKED_TARGET)) return false;
    if (target.closest('[data-workflow-node-id],[data-workflow-connection-id]')) return false;
    return target === rootRef.current || target === worldRef.current || Boolean(target.closest('.workflow-world'));
  };

  const onSurfacePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!isTrueBackground(event.target)) return;
    if (focusAnimRef.current !== null) { window.cancelAnimationFrame(focusAnimRef.current); focusAnimRef.current = null; }
    setContextMenu(null);
    closeCreateMenu();
    setSlashMenu(null);
    setNotice(null);
    setSelectedConnectionId(null);
    if (event.button === 0 && tool === 'select' && !spacePressedRef.current) {
      event.preventDefault();
      const point = screenToWorkflow(event.clientX, event.clientY);
      const additive = event.shiftKey || event.ctrlKey || event.metaKey;
      const box = { start: point, current: point, additive, initialIds: [...selectedIdsRef.current] };
      interactionRef.current = { type: 'selection', pointerId: event.pointerId, box };
      setOverlayHidden(true);
      setSelectionBox(box);
      if (!additive) selectNodes([]);
      return;
    }
    if (event.button === 0 || event.button === 1) {
      event.preventDefault();
      startPan(event.clientX, event.clientY, event.pointerId);
      setOverlayHidden(true);
      if (!event.shiftKey && !event.ctrlKey && !event.metaKey) selectNodes([]);
    }
  };

  const selectionStyle = selectionBox ? {
    left: Math.min(selectionBox.start.x, selectionBox.current.x),
    top: Math.min(selectionBox.start.y, selectionBox.current.y),
    width: Math.abs(selectionBox.current.x - selectionBox.start.x),
    height: Math.abs(selectionBox.current.y - selectionBox.start.y),
  } : undefined;
  const selectedNodes = useMemo(() => new Set(selectedNodeIds), [selectedNodeIds]);
  // 派生运行状态（stale 等）：纯计算，不写回项目。
  const anchorCodes = useMemo(() => deriveAnchorCodes(project.nodes), [project.nodes]);
  const runStates = useMemo(() => deriveWorkflowRunStates({ nodes: project.nodes, connections: project.connections }), [project.nodes, project.connections]);
  const stalePlan = useMemo(() => planWorkflowStaleRerun({ nodes: project.nodes, connections: project.connections }, runStates), [project.nodes, project.connections, runStates]);
  const presenceByNode = useMemo(() => deriveWorkflowPresence({ nodes: project.nodes, draftChangeSets: project.draftChangeSets }), [project.nodes, project.draftChangeSets]);
  const hostClips = useMemo(() => listWorkflowHostClips({ nodes: project.nodes, connections: project.connections }), [project.nodes, project.connections]);
  const selectedHostSend = useMemo(() => {
    if (selectedNodeIds.length !== 1) return undefined;
    const node = project.nodes.find(item => item.id === selectedNodeIds[0]);
    if (!node) return undefined;
    if (node.metadata.hostSend) return { nodeId: node.id, host: node.metadata.hostSend.host, status: node.metadata.hostSend.status };
    const eligibility = workflowHostSendEligibility({ nodes: project.nodes, connections: project.connections }, node.id);
    return eligibility.ok ? { nodeId: node.id, host: eligibility.source.host, status: undefined } : undefined;
  }, [project.nodes, project.connections, selectedNodeIds]);
  const selectedNodeData = displayNodes.filter(node => node.isVisible !== false && selectedNodes.has(node.id));
  agentShortcutRef.current = () => {
    const ids = selectedIdsRef.current.filter(id => !isAgentSessionNode(projectRef.current.nodes.find(node => node.id === id)));
    if (ids.length) { void discussWithAgent(ids); return; }
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    openCreateMenu(rect.left + rect.width / 2 - 160, rect.top + rect.height / 2 - 140);
  };
  // 节点 PromptBar 放大编辑：记住放大的是哪个节点；切换或取消选中即复位。
  const singleSelectedId = selectedNodeData.length === 1 ? selectedNodeData[0].id : null;
  const [expandedPromptNodeId, setExpandedPromptNodeId] = useState<string | null>(null);
  useEffect(() => {
    setExpandedPromptNodeId(current => (current && current !== singleSelectedId ? null : current));
  }, [singleSelectedId]);
  const promptExpanded = singleSelectedId !== null && expandedPromptNodeId === singleSelectedId;
  /** prefix 缺省：按工作流顺序导出原名；给出 prefix：按排列（阅读）顺序导出 prefix_01、prefix_02… */
  const exportSelectedMedia = async (nodes: WorkflowNodeData[], prefix?: string) => {
    const sequenced = prefix !== undefined;
    const ordered = sequenced ? arrangementOrder(nodes, nodes.map(node => node.id)) : nodes;
    const media = ordered.filter(node => node.type === 'image' || node.type === 'video' || node.type === 'audio');
    const names = sequenced ? sequencedFileNames(prefix, media.length) : [];
    const archiveName = sequenced ? names[0]?.replace(/_\d+$/, '') || 'iris' : `Iris-Workflow-${project.title}`;
    try {
      const count = await exportMediaArchive(media.map((node, index) => ({
        id: node.id,
        // 顺序下载时用序号作坐标，保证归档顺序与排列顺序一致。
        x: sequenced ? index : node.position.x,
        y: sequenced ? 0 : node.position.y,
        name: sequenced ? names[index] : node.metadata.name || node.title,
        mimeType: node.metadata.mimeType,
        loadBlob: () => loadWorkflowMediaBlob(node.metadata.storageKey, node.metadata.href),
      })), archiveName, project.title);
      setNotice(count ? (sequenced ? `已按排列顺序导出 ${count} 个文件（${names[0]} 起）。` : `已按工作流顺序导出 ${count} 个媒体文件。`) : '已取消导出。');
    } catch (error) {
      setNotice(displayError(error, '批量导出失败。'));
    }
  };
  // ── 多结果备选：设为首图 / 删除 / 拆成独立节点。都是单次 applyOps（一步撤销），节点 ID 与连线不动。──
  const promoteNodeAlternate = (ownerId: string, alternateId: string) => {
    const owner = projectRef.current.nodes.find(node => node.id === ownerId);
    const alternate = nodeAlternates(owner).find(item => item.id === alternateId);
    if (!owner || !alternate || owner.isLocked) return false;
    // 与 Agent 同一条操作（set_batch_primary 指向备选 ID = 交换媒体）。
    const preference = buildPreferenceEvent(owner, alternateId, { projectId: projectRef.current.id });
    const ok = applyOps([{ type: 'set_batch_primary', batchId: alternate.batchId || owner.id, nodeId: alternateId }]);
    // 用户的选择是 L4 偏好信号（eval/eval.md §6）：只记 ID、提示词与模型，不记媒体本体。
    if (ok && preference) void recordPreferenceEvent(preference);
    return ok;
  };
  const removeNodeAlternates = (ownerId: string, ids: string[]) => {
    const owner = projectRef.current.nodes.find(node => node.id === ownerId);
    if (!owner || owner.isLocked || !ids.length) return;
    const next = removeAlternates(owner, ids);
    if (applyOps([{ type: 'update_node', id: owner.id, metadata: next.metadata, replaceMetadata: true }])) {
      setNotice(language === 'en' ? `Deleted ${ids.length} alternate(s). Undo with Ctrl+Z.` : `已删除 ${ids.length} 个备选，可 Ctrl+Z 撤销。`);
    }
  };
  const splitNodeAlternates = (ownerId: string, ids: string[]) => {
    const snapshot = projectRef.current;
    const owner = snapshot.nodes.find(node => node.id === ownerId);
    if (!owner || owner.isLocked || !ids.length) return;
    const { primary, nodes: created } = splitAlternates(owner, ids, new Set(snapshot.nodes.map(node => node.id)), nanoid);
    if (!created.length) return;
    const ok = applyOps([
      { type: 'update_node', id: owner.id, metadata: primary.metadata, replaceMetadata: true },
      ...created.map(node => ({ type: 'add_node' as const, node })),
    ]);
    if (ok) selectNodes(created.map(node => node.id));
  };
  const galleryOwner = galleryPreview ? project.nodes.find(node => node.id === galleryPreview.ownerId) || null : null;
  const galleryState = useMemo(() => {
    if (!galleryPreview || !galleryOwner) return null;
    const alternates = nodeAlternates(galleryOwner).filter(item => !galleryPreview.ids || galleryPreview.ids.includes(item.id));
    // 首图条目用它那份媒体的稳定 ID（节点 ID 可能已作为换下去的备选 ID 出现在列表里）。
    const primaryItem = { ...galleryOwner, id: primaryVariantId(galleryOwner) };
    const items = [primaryItem, ...alternates.map(item => alternateAsNode(galleryOwner, item))];
    return {
      items,
      index: Math.min(galleryPreview.index, items.length - 1),
      primaryId: primaryItem.id,
      onIndexChange: (index: number) => setGalleryPreview(current => (current ? { ...current, index } : current)),
      onPromote: galleryOwner.isLocked ? undefined : (item: WorkflowNodeData) => {
        const outgoingId = primaryVariantId(galleryOwner);
        if (!promoteNodeAlternate(galleryOwner.id, item.id)) return;
        // 换上来的那份现在是首图（第 1 张）；换下去的那份接替它在对比列表里的位置。
        setGalleryPreview(current => (current ? { ...current, index: 0, ids: current.ids ? current.ids.map(id => (id === item.id ? outgoingId : id)) : null } : current));
      },
    };
  }, [galleryOwner, galleryPreview]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    // 首图节点被删 / 失去全部备选：关闭画廊。
    if (galleryPreview && (!galleryOwner || !nodeAlternates(galleryOwner).length)) setGalleryPreview(null);
  }, [galleryOwner, galleryPreview]);
  const overlayBounds = selectedNodeData.length ? selectedNodeData.reduce((bounds, node) => {
    // 节点挂着备选（下方网格 / 展开的叠放网格）时，PromptBar 放在它们下面，不压住缩略图。
    const extent = workflowAlternatesExtent(node, { gridCollapsed: collapsedAlternateDocks.has(node.id), stackExpanded: expandedAlternateStacks.has(node.id) });
    return {
      left: Math.min(bounds.left, node.position.x),
      top: Math.min(bounds.top, node.position.y),
      right: Math.max(bounds.right, node.position.x + node.width + extent.right),
      bottom: Math.max(bounds.bottom, node.position.y + node.height + extent.bottom),
    };
  }, { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity }) : null;
  // The workflow root already reflects the space left by docked panels. Keep
  // overlay geometry local to that measured container instead of subtracting
  // the drawer a second time in JavaScript.
  const workflowWidth = Math.max(360, rootSize?.width || 1000);
  const overlayCenter = overlayBounds ? project.viewport.x + ((overlayBounds.left + overlayBounds.right) / 2) * project.viewport.k : 0;
  const toolbarLeft = Math.max(8, Math.min(overlayCenter, workflowWidth - 8));
  // 选中节点属于已画框的分组时，工具条要浮在分组框表头之上，不压住「分组 N 个节点」标签（框顶 = 组内最高节点 - 20 - 44，见 groupFrames）。
  const selectedGroupTop = selectedNodeData.reduce((top, node) => {
    if (!node.batchId || !(node.batchGroupSource === 'manual' || expandedBatches.has(node.batchId))) return top;
    const members = project.nodes.filter(member => member.batchId === node.batchId);
    if (members.length < 2) return top;
    return Math.min(top, ...members.map(member => member.position.y - 64));
  }, Infinity);
  const overlayTop = overlayBounds ? Math.min(overlayBounds.top, selectedGroupTop) : 0;
  const toolbarTop = overlayBounds ? Math.max(8, project.viewport.y + overlayTop * project.viewport.k - Math.max(72, 56 + 28 * project.viewport.k) + (overlayTop < overlayBounds.top ? 24 : 0)) : 0;
  // 工具条避开悬浮的图层栏 / Agent 面板（见 toolbarVisibleBand.ts）：每次渲染后量一次，面板开合 / 拖宽时再量。
  const toolbarOverlayRef = useRef<HTMLDivElement>(null);
  const placeToolbar = useCallback(() => {
    const el = toolbarOverlayRef.current;
    const root = rootRef.current;
    if (!el || !root) return;
    const rootRect = root.getBoundingClientRect();
    const width = el.offsetWidth;
    const base = Number(el.dataset.baseLeft || 0);
    const rowTop = rootRect.top + el.offsetTop;
    const obstacles = Array.from(document.querySelectorAll(TOOLBAR_OBSTACLE_SELECTOR))
      .map(node => node.getBoundingClientRect());
    const band = visibleBand(rootRect, obstacles, rowTop, rowTop + el.offsetHeight);
    const center = clampCenterIntoBand(rootRect.left + base, width, band) - rootRect.left;
    el.style.left = `${center}px`;
  }, []);
  useLayoutEffect(() => {
    const el = toolbarOverlayRef.current;
    if (!el) return;
    el.dataset.baseLeft = String(toolbarLeft);
    placeToolbar();
  });
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => placeToolbar());
    const watch = () => document.querySelectorAll(TOOLBAR_OBSTACLE_SELECTOR).forEach(node => observer.observe(node));
    watch();
    if (rootRef.current) observer.observe(rootRef.current);
    const mutation = new MutationObserver(() => { watch(); placeToolbar(); });
    mutation.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-open', 'data-docked'] });
    window.addEventListener('resize', placeToolbar);
    return () => { observer.disconnect(); mutation.disconnect(); window.removeEventListener('resize', placeToolbar); };
  }, [placeToolbar]);
  const promptWorkflowWidth = workflowWidth;
  // The prompt bar belongs to the node but reads as a wide, landscape composer:
  // about 2x the node's on-screen width, 680-960px, clamped to the workflow area.
  const overlayScreenWidth = overlayBounds ? (overlayBounds.right - overlayBounds.left) * project.viewport.k : 0;
  const compactPromptWidth = Math.min(promptWorkflowWidth - 16, Math.max(680, Math.min(960, overlayScreenWidth * 2)));
  // 放大态（LibTV 式）：居中的大编辑框，宽 ≤960px（不比紧凑态窄），避开底部 dock。
  const promptWidth = promptExpanded ? Math.max(360, Math.min(promptWorkflowWidth - 32, 960)) : compactPromptWidth;
  const promptLeft = promptExpanded
    ? Math.max(8, (promptWorkflowWidth - promptWidth) / 2)
    : Math.max(8, Math.min(overlayCenter - promptWidth / 2, promptWorkflowWidth - promptWidth - 8));
  const configLeft = Math.max(8, Math.min(overlayCenter - 210, workflowWidth - 428));
  const promptRootHeight = rootSize?.height || 700;
  const promptBelowTop = overlayBounds ? project.viewport.y + overlayBounds.bottom * project.viewport.k + 12 : 0;
  // 下方放不下时翻到节点工具条上方，并用 bottom 锚定：提示词框实际多高都只向上长，底部参数栏不会再钻到工具条下面。
  const promptAbove = !promptExpanded && overlayBounds !== null && promptBelowTop + 220 > promptRootHeight - 60;
  const promptTop = promptExpanded ? Math.max(8, (promptRootHeight - 60 - 520) / 2) : overlayBounds ? promptBelowTop : 0;
  const promptBottom = promptRootHeight - toolbarTop + 8;
  const gridSize = 24 * project.viewport.k;
  // 画布视图下顶栏是透明浮层，但两侧停靠面板让出的顶栏下方那条（面板 margin-top）不在画布里，
  // 会露出外层实底。把画布当前的底色 + 网格（含平移偏移）同步给 .studio-layout 当背景，让那两条与画布无缝。
  const rootSizeKey = rootSize ? `${rootSize.width}x${rootSize.height}` : '';
  useLayoutEffect(() => {
    const root = rootRef.current;
    const host = root?.closest<HTMLElement>('.studio-layout');
    if (!root || !host) return;
    const style = getComputedStyle(root);
    const r = root.getBoundingClientRect();
    const h = host.getBoundingClientRect();
    const ox = r.left - h.left + (project.viewport.x % gridSize);
    const oy = r.top - h.top + (project.viewport.y % gridSize);
    host.style.setProperty('--wf-band-color', style.backgroundColor);
    host.style.setProperty('--wf-band-image', style.backgroundImage);
    host.style.setProperty('--wf-band-size', `${gridSize}px ${gridSize}px`);
    host.style.setProperty('--wf-band-pos', `${ox}px ${oy}px`);
  }, [project.viewport.x, project.viewport.y, gridSize, project.backgroundMode, theme, rootSizeKey]);
  useEffect(() => () => {
    const host = rootRef.current?.closest<HTMLElement>('.studio-layout');
    if (!host) return;
    for (const name of ['--wf-band-color', '--wf-band-image', '--wf-band-size', '--wf-band-pos']) host.style.removeProperty(name);
  }, []);

  const batchGroups = useMemo(() => {
    const groups = new Map<string, WorkflowNodeData[]>();
    for (const node of displayNodes) {
      if (node.batchId && node.isVisible !== false) {
        const group = groups.get(node.batchId) || [];
        group.push(node);
        groups.set(node.batchId, group);
      }
    }
    return groups;
  }, [displayNodes]);

  const hiddenByBatch = useMemo(() => {
    const hidden = new Set<string>();
    for (const [batchId, group] of batchGroups) {
      if (group.length > 1 && !group.some(node => node.batchGroupSource === 'manual')) {
        for (const node of group) hidden.add(node.id);
      }
    }
    return hidden;
  }, [batchGroups, expandedBatches]);

  const collapsedBatches = useMemo(() => {
    const result: { batchId: string; head: WorkflowNodeData; count: number }[] = [];
    for (const [batchId, group] of batchGroups) {
      if (group.length > 1 && !group.some(node => node.batchGroupSource === 'manual') && (!expandedBatches.has(batchId) || group.length > 4)) {
        const root = group.find(n => n.batchIndex === 0) || group[0];
        const primaryId = root?.metadata.primaryImageId;
        const head = (primaryId && group.find(n => n.id === primaryId)) || root;
        result.push({ batchId, head, count: group.length });
      }
    }
    return result;
  }, [batchGroups, expandedBatches]);

  const collapsedBatchHeadIds = useMemo(() => new Set(collapsedBatches.map(({ head }) => head.id)), [collapsedBatches]);

  const expandedBatchGalleries = useMemo(() => [...batchGroups].flatMap(([batchId, group]) => (
    group.length > 1 && group.length <= 4 && expandedBatches.has(batchId) && !group.some(node => node.batchGroupSource === 'manual')
      ? [{ batchId, group: [...group].sort((left, right) => (left.batchIndex ?? 0) - (right.batchIndex ?? 0)) }]
      : []
  )), [batchGroups, expandedBatches]);

  // 超过 4 个结果的自动批次：展开时保留叠放主图，在右侧弹出生成历史面板。
  const historyBatches = useMemo(() => collapsedBatches.flatMap(({ batchId, head, count }) => (
    count > 4 && expandedBatches.has(batchId)
      ? [{ batchId, head, group: [...(batchGroups.get(batchId) || [])].sort((left, right) => (left.batchIndex ?? 0) - (right.batchIndex ?? 0)) }]
      : []
  )), [batchGroups, collapsedBatches, expandedBatches]);

  // LibTV 式分组框：手动分组常驻展开并画框，展开中的自动批次也画框；框体不拦截指针，只有标签可拖动整组。
  const groupFrames = useMemo(() => [...batchGroups].flatMap(([batchId, group]) => {
    if (group.length < 2 || group.some(node => hiddenByBatch.has(node.id))) return [];
    const manual = group.some(node => node.batchGroupSource === 'manual');
    if (!manual && !expandedBatches.has(batchId)) return [];
    const hues = [150, 8, 210, 38, 280];
    const pad = 20;
    const left = Math.min(...group.map(node => node.position.x)) - pad;
    // 节点标题浮在节点框上方约 20px；给分组标签留出独立表头，避免压住标题。
    const top = Math.min(...group.map(node => node.position.y)) - pad - 44;
    const right = Math.max(...group.map(node => node.position.x + node.width)) + pad;
    const bottom = Math.max(...group.map(node => node.position.y + node.height)) + pad;
    let hash = 0;
    for (const char of batchId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return [{ batchId, group, manual, hue: hues[hash % hues.length], box: { left, top, width: right - left, height: bottom - top } }];
  }), [batchGroups, expandedBatches, hiddenByBatch]);

  // 折叠的子画布隐藏其子节点（及相关连线）；文档仍是扁平 nodes，只影响渲染。
  const subgraphChildren = useMemo(() => {
    const subgraphs = new Map(displayNodes.filter(node => node.type === 'subgraph').map(node => [node.id, node]));
    const counts = new Map<string, number>();
    const hidden = new Set<string>();
    for (const node of displayNodes) {
      const parent = node.parentId ? subgraphs.get(node.parentId) : undefined;
      if (!parent) continue;
      counts.set(parent.id, (counts.get(parent.id) || 0) + 1);
      if (parent.metadata.collapsed) hidden.add(node.id);
    }
    return { counts, hidden };
  }, [displayNodes]);
  const hiddenBySubgraph = subgraphChildren.hidden;

  // 视口裁剪：只挂载视口附近的节点 DOM；连线额外保留与可见节点相邻的一端，避免边线断裂。
  // 首帧尚未测量到容器尺寸时不裁剪，避免挂载瞬间丢节点（也兼容无布局的测试环境）。
  const cullingEnabled = Boolean(rootSize && rootSize.width > 0 && rootSize.height > 0);
  // 模板/示例画布首次打开时适配视图；否则窄窗口只看到第一个节点，其余被裁剪。
  useEffect(() => {
    if (!cullingEnabled || !workflowFitOnOpen.delete(project.id)) return;
    fitView();
  }, [cullingEnabled, fitView, project.id]);
  const visibleWorldRect = useMemo(() => {
    const k = project.viewport.k || 1;
    const left = -project.viewport.x / k;
    const top = -project.viewport.y / k;
    const width = Math.max(320, rootSize?.width || 1200);
    const height = Math.max(240, rootSize?.height || 800);
    return {
      left: left - VIEWPORT_CULL_MARGIN,
      top: top - VIEWPORT_CULL_MARGIN,
      right: left + width / k + VIEWPORT_CULL_MARGIN,
      bottom: top + height / k + VIEWPORT_CULL_MARGIN,
    };
  }, [project.viewport.k, project.viewport.x, project.viewport.y, rootSize?.height, rootSize?.width]);

  const renderNodes = useMemo(() => {
    const visible = displayNodes.filter(node => {
      if (node.isVisible === false || hiddenByBatch.has(node.id) || hiddenBySubgraph.has(node.id)) return false;
      if (!cullingEnabled) return true;
      if (selectedNodes.has(node.id)) return true;
      if (interactionPreview?.kind === 'node' && interactionPreview.positions.has(node.id)) return true;
      // 备选（下方网格 / 展开的叠放网格）是节点的子元素：把它们占的范围算进可见判断，节点本体出屏时备选不跟着消失。
      const extent = workflowAlternatesExtent(node, { gridCollapsed: collapsedAlternateDocks.has(node.id), stackExpanded: expandedAlternateStacks.has(node.id) });
      const width = (node.width || 320) + extent.right;
      const height = (node.height || 200) + extent.bottom;
      return node.position.x < visibleWorldRect.right && node.position.x + width > visibleWorldRect.left
        && node.position.y < visibleWorldRect.bottom && node.position.y + height > visibleWorldRect.top;
    });
    // 子画布框先渲染（位于子节点下层）；折叠时只保留标题条高度。
    const frames = visible.filter(node => node.type === 'subgraph').map(node => (node.metadata.collapsed ? { ...node, height: 72 } : node));
    return [...frames, ...visible.filter(node => node.type !== 'subgraph')];
  }, [collapsedAlternateDocks, cullingEnabled, displayNodes, expandedAlternateStacks, hiddenByBatch, hiddenBySubgraph, interactionPreview, selectedNodes, visibleWorldRect]);

  const connectionNodes = useMemo(() => {
    const visibleIds = new Set(renderNodes.map(node => node.id));
    const needed = new Set(visibleIds);
    for (const connection of project.connections) {
      if (visibleIds.has(connection.fromNodeId)) needed.add(connection.toNodeId);
      if (visibleIds.has(connection.toNodeId)) needed.add(connection.fromNodeId);
    }
    return displayNodes.filter(node => needed.has(node.id));
  }, [displayNodes, project.connections, renderNodes]);

  const { pendingInsert: wfPendingInsert, consumeInsert: wfConsumeInsert } = usePromptHistoryStore();
  useEffect(() => {
    if (!wfPendingInsert) return;
    const target = selectedNodeData.length === 1 && workflowPromptBarTarget(selectedNodeData[0]) ? selectedNodeData[0] : null;
    if (target) {
      applyOps([{ type: 'update_node', id: target.id, metadata: { prompt: wfPendingInsert.text, richTextDocument: undefined } }]);
      setPromptFocusSignal(value => value + 1);
    }
    wfConsumeInsert();
  }, [wfPendingInsert, wfConsumeInsert, selectedNodeData, applyOps]);

  // Native wheel listener with passive:false so Ctrl+scroll zooms the workflow surface instead of the browser.
  // React's synthetic onWheel is passive on the root and silently ignores preventDefault.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    // 每帧最多写一次视口：触控板一帧内可触发多次 wheel，逐次 patchProject 会导致整画布重复渲染。
    let frame: number | null = null;
    let pending: { zoom: boolean; dx: number; dy: number; clientX: number; clientY: number } | null = null;
    const flush = () => {
      frame = null;
      const next = pending;
      pending = null;
      if (!next) return;
      const viewport = viewportRef.current;
      if (next.zoom) {
        const rect = root.getBoundingClientRect();
        const world = screenToWorkflow(next.clientX, next.clientY);
        const k = Math.min(3, Math.max(0.12, viewport.k * Math.exp(-next.dy * 0.0015)));
        patchProject({ viewport: {
          x: next.clientX - (rect?.left || 0) - world.x * k,
          y: next.clientY - (rect?.top || 0) - world.y * k,
          k,
        } });
      } else {
        patchProject({ viewport: { ...viewport, x: viewport.x - next.dx, y: viewport.y - next.dy } });
      }
    };
    const onWheel = (event: WheelEvent) => {
      if (event.target instanceof Element && event.target.closest(BLOCKED_TARGET)) return;
      event.preventDefault();
      if (focusAnimRef.current !== null) { window.cancelAnimationFrame(focusAnimRef.current); focusAnimRef.current = null; }
      setFocusBadge(false);
      const zoom = event.ctrlKey || wheelMode === 'zoom';
      if (pending && pending.zoom !== zoom) {
        if (frame !== null) window.cancelAnimationFrame(frame);
        flush();
      }
      if (pending) {
        pending.dx += event.deltaX;
        pending.dy += event.deltaY;
        pending.clientX = event.clientX;
        pending.clientY = event.clientY;
      } else {
        pending = { zoom, dx: event.deltaX, dy: event.deltaY, clientX: event.clientX, clientY: event.clientY };
      }
      if (frame === null) frame = window.requestAnimationFrame(flush);
    };
    root.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      root.removeEventListener('wheel', onWheel);
      // 重新绑定或卸载时只丢弃未提交的一帧滚动，不在 cleanup 里写项目。
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = null;
      pending = null;
    };
  }, [wheelMode, patchProject, screenToWorkflow]);

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      data-testid="workflow-editor"
      className={`workflow-editor workflow-editor--${tool} workflow-bg--${project.backgroundMode}`}
      style={project.backgroundMode === 'none' ? { backgroundImage: 'none' } : {
        backgroundSize: `${gridSize}px ${gridSize}px`,
        backgroundPosition: `${project.viewport.x % gridSize}px ${project.viewport.y % gridSize}px`,
      }}
      onPointerDown={onSurfacePointerDown}
      onDragEnterCapture={event => event.preventDefault()}
      onDragOverCapture={event => {
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      }}
      onDropCapture={dropMedia}
      onDoubleClick={event => {
        if (tool === 'pan' || !isTrueBackground(event.target)) return;
        event.preventDefault();
        openCreateMenu(event.clientX, event.clientY);
      }}
      onContextMenu={event => {
        event.preventDefault();
        if (tool === 'pan' || !isTrueBackground(event.target)) return;
        setSelectedConnectionId(null);
        closeCreateMenu();
        setContextMenu({ type: 'pane', x: event.clientX, y: event.clientY });
      }}
    >
      {(productionBible.shots.length > 0 || productionBible.anchors.length > 0 || workflowView === 'storyboard') && (
        <WorkflowViewSwitch value={workflowView} onChange={setWorkflowView} language={language} shotCount={productionBible.shots.length} />
      )}
      {workflowView === 'storyboard' && (
        <WorkflowStoryboardView
          view={storyboardView}
          language={language}
          mergeBusy={storyboardMergeBusy}
          onOpenNode={id => { setWorkflowView('workflow'); selectNodes([id]); focusNode(id); setPromptFocusSignal(value => value + 1); }}
          onReference={ids => {
            const members = projectRef.current.nodes.filter(item => ids.includes(item.id));
            if (!members.length) return;
            pushAgentGroup({
              nodeIds: ids.filter(id => members.some(item => item.id === id)),
              label: members.length === 1 ? members[0].title : (language === 'en' ? 'Storyboard · ' + members.length + ' shots' : '故事板 · ' + members.length + ' 个镜头'),
            });
          }}
          onMerge={ids => { void mergeStoryboard(ids); }}
        />
      )}
      <WorkflowToolbar
        tool={tool}
        revision={project.draftVersion}
        lastChange={lastChangeSummary}
        staleCount={stalePlan.length}
        onRerunStale={() => planWorkflowStaleRerun({ nodes: projectRef.current.nodes, connections: projectRef.current.connections })
          .filter(id => !projectRef.current.nodes.find(node => node.id === id)?.isLocked)
          .forEach(id => enqueueRunNode(id))}
        hostSend={selectedHostSend ? {
          host: selectedHostSend.host === 'resolve' ? 'Resolve' : selectedHostSend.host,
          status: selectedHostSend.status,
          onSend: () => {
            const current = projectRef.current;
            const patch = buildWorkflowHostSendPatch(current, selectedHostSend.nodeId, { requestId: nanoid(), now: new Date().toISOString() });
            if (patch) applyOps([{ type: 'update_node', id: selectedHostSend.nodeId, metadata: patch }]);
          },
        } : undefined}
        canUndo={Boolean(project.draftChangeSets?.some(changeSet => changeSet.status === 'completed' || changeSet.status === 'partial'))}
        canRedo={Boolean(project.draftRedoStack?.length)}
        onToolChange={setTool}
        onAddNode={addNode}
        onAddSharedMedia={media => { void addSharedMedia(media); }}
        activeProjectId={project.id}
        onOpenAssets={onOpenAssets}
        onUndo={undo}
        onRedo={redo}
        onFit={fitView}
        onToggleGrid={() => patchProject({ backgroundMode: projectRef.current.backgroundMode === 'none' ? 'dots' : projectRef.current.backgroundMode === 'dots' ? 'lines' : 'none' })}
        onOpenAgent={onOpenAgent}
        agentOpen={agentOpen}
        wheelMode={wheelMode}
        setWheelMode={setWheelMode}
        minimapOpen={minimapOpen}
        onToggleMinimap={() => setMinimapOpen(open => !open)}
        snapEnabled={snapEnabled}
        onToggleSnap={() => setSnapEnabled(snap => !snap)}
        edgesVisible={edgesVisible}
        onToggleEdges={() => setEdgesVisible(v => !v)}
        onAutoLayout={autoLayout}
        autoMediaDerive={autoMediaDerive}
        onToggleAutoMediaDerive={key => setAutoMediaDerive(current => {
          const next = { ...current, [key]: !current[key] };
          saveAutoMediaDeriveSettings(next);
          return next;
        })}
        zoomLevel={project.viewport.k}
        onZoomIn={zoomIn}
        onZoomOut={zoomOut}
        onZoomReset={zoomReset}
        onExportCanvas={format => { void exportCanvas(format); }}
        exportSelection={selectedNodeIds.length > 0}
        snapshots={project.snapshots?.map(snapshot => ({ id: snapshot.id, name: snapshot.name, createdAt: snapshot.createdAt, nodeCount: snapshot.nodes.length }))}
        onSaveSnapshot={saveSnapshot}
        onRestoreSnapshot={restoreSnapshot}
        onDeleteSnapshot={deleteSnapshot}
      />
      {project.nodes.length === 0 && (
        // The empty canvas is its own guide: one sentence and the two most common starts.
        <div className="workflow-canvas-empty" data-workflow-overlay onPointerDown={event => event.stopPropagation()}>
          <strong>{language === 'zho' ? '从一个节点开始' : 'Start with a node'}</strong>
          <span>{language === 'zho' ? '双击空白处可以添加任意节点，也可以把图片或视频直接拖进来。' : 'Double-click anywhere to add a node, or drop an image or video here.'}</span>
          <div className="workflow-canvas-empty__actions">
            <button type="button" className="is-primary" onClick={() => addNode('image')}>{language === 'zho' ? '图片节点' : 'Image node'}</button>
            <button type="button" onClick={() => addNode('video')}>{language === 'zho' ? '视频节点' : 'Video node'}</button>
          </div>
          <button type="button" className="workflow-canvas-empty__sample" data-testid="workflow-open-sample" onClick={openSampleCanvas}>{language === 'zho' ? '或打开示例画布，无需 Key' : 'Or open the sample canvas — no key needed'}</button>
        </div>
      )}
      <div ref={worldRef} className="workflow-world" style={{ transform: `translate(${project.viewport.x}px, ${project.viewport.y}px) scale(${project.viewport.k})` }}>
        {groupFrames.map(({ batchId, group, manual, box }) => (
          <div key={`group-frame-${batchId}`} className="workflow-group-frame" data-workflow-group-frame={batchId} data-source={manual ? 'manual' : 'auto'} onPointerDown={event => { if (event.target === event.currentTarget) startBatchDrag(event, batchId, group); }} style={{ left: box.left, top: box.top, width: box.width, height: box.height }}>
            <div className="workflow-group-frame__label" data-workflow-overlay onPointerDown={event => startBatchDrag(event, batchId, group)} title={language === 'zho' ? '拖动以移动整组' : 'Drag to move the group'}>
              {language === 'zho' ? `分组 ${group.length} 个节点` : `Group · ${group.length} nodes`}
            </div>
          </div>
        ))}
        <WorkflowConnections
          nodes={connectionNodes}
          connections={edgesVisible === false ? [] : project.connections.filter(connection => {
            const from = project.nodes.find(node => node.id === connection.fromNodeId);
            const to = project.nodes.find(node => node.id === connection.toNodeId);
            // 折叠批次以封面节点（叠放卡片所在位置）代表整组：封面的连线照常显示，其余成员的连线隐藏。
            const batchHidden = (id: string) => hiddenByBatch.has(id) && !collapsedBatchHeadIds.has(id);
            return from?.isVisible !== false && to?.isVisible !== false && !batchHidden(connection.fromNodeId) && !batchHidden(connection.toNodeId)
              && !hiddenBySubgraph.has(connection.fromNodeId) && !hiddenBySubgraph.has(connection.toNodeId);
          })}
          selectedId={selectedConnectionId}
          active={connectionDrag}
          onSelect={id => { setSelectedConnectionId(id); selectNodes([]); setContextMenu(null); }}
          onContextMenu={(event, id) => {
            setSelectedConnectionId(id);
            selectNodes([]);
            setContextMenu({ type: 'connection', id, x: event.clientX, y: event.clientY });
          }}
        />
        {snapGuides && (
          <svg className="workflow-snap-guides" aria-hidden width={10000} height={10000} style={{ position: 'absolute', left: -5000, top: -5000, pointerEvents: 'none', overflow: 'visible' }}>
            {snapGuides.x?.map((x, i) => (
              <line key={`vx${i}`} x1={x + 5000} y1={0} x2={x + 5000} y2={10000} stroke="#3b82f6" strokeWidth={1 / project.viewport.k} strokeDasharray={`${4 / project.viewport.k} ${4 / project.viewport.k}`} />
            ))}
            {snapGuides.y?.map((y, i) => (
              <line key={`hy${i}`} x1={0} y1={y + 5000} x2={10000} y2={y + 5000} stroke="#3b82f6" strokeWidth={1 / project.viewport.k} strokeDasharray={`${4 / project.viewport.k} ${4 / project.viewport.k}`} />
            ))}
          </svg>
        )}
        <AnimatePresence>
        {collapsedBatches.map(({ batchId, head, count }) => (
          <WorkflowBatchStack
            key={'batch-stack-' + batchId}
            head={head}
            others={(batchGroups.get(batchId) || []).filter(n => n.id !== head.id && n.type !== 'video').slice(0, 2)}
            count={count}
            historyOpen={expandedBatches.has(batchId)}
            onPointerDown={event => { const group = batchGroups.get(batchId) || []; if (group.length) startBatchDrag(event, batchId, group); }}
            onExpand={() => toggleBatch(batchId)}
          />
        ))}
        {expandedBatchGalleries.map(({ batchId, group }) => (
          <WorkflowBatchGallery
            key={'batch-gallery-' + batchId}
            group={group}
            language={language}
            onCollapse={() => toggleBatch(batchId)}
            onSetPrimary={nodeId => applyOps([{ type: 'set_batch_primary', batchId, nodeId }])}
            onPointerDown={event => startBatchDrag(event, batchId, group)}
          />
        ))}
        {historyBatches.map(({ batchId, head, group }) => (
          <WorkflowBatchHistory
            key={'batch-history-' + batchId}
            head={head}
            group={group}
            onClose={() => toggleBatch(batchId)}
            onSetPrimary={nodeId => applyOps([{ type: 'set_batch_primary', batchId, nodeId }])}
          />
        ))}
        {renderNodes.map(node => {
          const batch = node.batchId ? batchGroups.get(node.batchId) : undefined;
          const batchRoot = batch?.find(item => item.batchIndex === 0) || batch?.[0];
          const primaryId = batchRoot?.metadata.primaryImageId || batchRoot?.id;
          const expandedBatch = Boolean(node.batchId && batch && batch.length > 1 && expandedBatches.has(node.batchId));
          return <WorkflowNode
            key={node.id}
            node={node}
            language={language}
            selected={selectedNodes.has(node.id)}
            lifted={Boolean(liftedNodeIds?.has(node.id))}
            mediaActive={activeMedia?.projectId === project.id && activeMedia.nodeId === node.id}
            uploadStage={ingestStages[node.id]}
            onCancelUpload={ingestAbortRef.current.has(node.id) ? () => ingestAbortRef.current.get(node.id)?.abort() : undefined}
            onActivateMedia={node.type === 'video' && (node.metadata.storageKey || node.metadata.href || node.metadata.artifactRef?.taskId)
              ? () => {
                // 幂等：onMouseOver 每次划过都会触发；同一节点直接复用原引用，避免不必要的新对象引发全量重渲染。
                setActiveMedia(current => current?.projectId === project.id && current.nodeId === node.id
                  ? current
                  : { projectId: project.id, nodeId: node.id });
              }
              : undefined}
            onDeactivateMedia={() => setActiveMedia(active => active?.projectId === project.id && active.nodeId === node.id ? null : active)}
            onExtractFrame={node.type === 'video' ? (position, currentTimeSec) => void handleExtractFrame(node.id, position, currentTimeSec) : undefined}
            onAudioTool={node.type === 'audio' ? kind => openAudioTool(kind, node.id) : undefined}
            onPointerDown={event => startNodeDrag(event, node)}
            onConnectStart={event => {
              if (event.button !== 0) return;
              if (tool === 'pan' || spacePressedRef.current || node.isLocked) return;
              event.preventDefault();
              event.stopPropagation();
              closeCreateMenu();
              setContextMenu(null);
              setSelectedConnectionId(null);
              createMenuOpenerRef.current = event.currentTarget;
              interactionRef.current = { type: 'connection', pointerId: event.pointerId, originId: node.id, direction: 'out' };
              setConnectionDrag({ sourceId: node.id, point: screenToWorkflow(event.clientX, event.clientY), targetId: null, direction: 'out', local: localPoint(event.clientX, event.clientY) });
            }}
            onConnectStartTarget={event => {
              if (event.button !== 0) return;
              if (tool === 'pan' || spacePressedRef.current || node.isLocked) return;
              event.preventDefault();
              event.stopPropagation();
              closeCreateMenu();
              setContextMenu(null);
              setSelectedConnectionId(null);
              createMenuOpenerRef.current = event.currentTarget;
              interactionRef.current = { type: 'connection', pointerId: event.pointerId, originId: node.id, direction: 'in' };
              setConnectionDrag({ sourceId: node.id, point: screenToWorkflow(event.clientX, event.clientY), targetId: null, direction: 'in', local: localPoint(event.clientX, event.clientY) });
            }}
            onResizeStart={event => {
              if (event.button !== 0) return;
              if (tool === 'pan' || spacePressedRef.current || node.isLocked) return;
              event.preventDefault();
              event.stopPropagation();
              const frame = currentFrame();
              interactionRef.current = { type: 'resize', pointerId: event.pointerId, id: node.id, start: screenToWorkflow(event.clientX, event.clientY), width: node.width, height: node.height, frame, moved: false };
              setOverlayHidden(true);
            }}
            onChangeText={content => { if (!node.isLocked) applyOps([{ type: 'update_node', id: node.id, metadata: { content } }]); }}
            onChangeMetadata={metadata => { if (!node.isLocked) applyOps([{ type: 'update_node', id: node.id, metadata }]); }}
            onRun={() => { if (!node.isLocked) runNodeWithKeyGuide(node.id); }}
            onStop={() => stopNode(node.id)}
            runState={runStates.get(node.id)}
            layerPreview={deriveWorkflowLayerPreview(node, project.nodes)}
            lassoActive={lassoNodeId === node.id}
            onLassoDone={lassoNodeId === node.id ? points => {
              setLassoNodeId(null);
              if (!points) return;
              setLayerLassoPoints(points.length >= 3 ? points : undefined);
              openImageTool('layer', node.id);
            } : undefined}
            presence={presenceByNode.get(node.id)}
            onSelectTake={node.metadata.operation ? takeId => {
              const current = projectRef.current.nodes.find(item => item.id === node.id);
              if (!current || current.isLocked) return;
              const next = selectWorkflowOperationTake(current, takeId);
              if (next !== current) applyOps([{ type: 'update_node', id: node.id, metadata: next.metadata, replaceMetadata: true }]);
            } : undefined}
            onReplaceMedia={file => { if (!node.isLocked) void replaceMedia(node, file); }}
            onRemoveMedia={() => { if (!node.isLocked) removeMedia(node); }}
            onContextMenu={event => {
              setSelectedConnectionId(null);
              if (!selectedIdsRef.current.includes(node.id)) selectNodes([node.id]);
              setContextMenu({ type: 'node', id: node.id, x: event.clientX, y: event.clientY });
            }}
            onKeyboardContextMenu={event => {
              event.preventDefault();
              const rect = event.currentTarget.getBoundingClientRect();
              setSelectedConnectionId(null);
              selectNodes([node.id]);
              setContextMenu({ type: 'node', id: node.id, x: rect.left + Math.min(24, rect.width / 2), y: rect.top + Math.min(24, rect.height / 2) });
            }}
            onKeyboardSelect={() => { selectNodes([node.id]); focusNode(node.id); }}
            onKeyboardConnectStart={() => {
              if (node.isLocked) return;
              setKeyboardConnectionSourceId(current => {
                const next = current === node.id ? null : node.id;
                setNotice(next
                  ? language === 'en' ? `Source selected: ${node.title}. Focus a target node and activate its connection handle.` : `已选择“${node.title}”作为连接起点。请聚焦目标节点并激活连接按钮。`
                  : null);
                return next;
              });
              selectNodes([node.id]);
            }}
            onKeyboardConnectTarget={() => {
              if (!keyboardConnectionSourceId) {
                setNotice(language === 'en' ? 'Choose a source node first.' : '请先选择连接起点。');
                return;
              }
              if (keyboardConnectionSourceId === node.id) return;
              const connected = applyOps([{ type: 'connect_nodes', fromNodeId: keyboardConnectionSourceId, toNodeId: node.id }]);
              setKeyboardConnectionSourceId(null);
              setNotice(connected
                ? language === 'en' ? `Connected to ${node.title}.` : `已连接到“${node.title}”。`
                : language === 'en' ? 'Could not connect these nodes.' : '无法连接这两个节点。');
            }}
            onKeyboardResize={(widthDelta, heightDelta) => {
              if (node.isLocked) return;
              applyOps([{ type: 'update_node', id: node.id, patch: { width: Math.max(160, node.width + widthDelta), height: Math.max(100, node.height + heightDelta) } }]);
            }}
            batchCount={expandedBatch ? batch?.length : undefined}
            isBatchPrimary={expandedBatch ? node.id === primaryId : undefined}
            onCollapseBatch={expandedBatch ? () => toggleBatch(node.batchId!) : undefined}
            onSetBatchPrimary={expandedBatch && node.id !== primaryId ? () => applyOps([{ type: 'set_batch_primary', batchId: node.batchId!, nodeId: node.id }]) : undefined}
            onDoubleClick={node.type === 'script' ? () => setScriptEditorNodeId(node.id) : node.type === 'subgraph' ? () => openSubgraphInReverse(node) : undefined}
            subgraphChildCount={node.type === 'subgraph' ? subgraphChildren.counts.get(node.id) || 0 : undefined}
            onToggleCollapse={node.type === 'subgraph' && !node.isLocked ? () => applyOps([{ type: 'update_node', id: node.id, metadata: { collapsed: !node.metadata.collapsed } }]) : undefined}
            onPreviewMedia={target => { if (nodeAlternates(target).length) setGalleryPreview({ ownerId: target.id, ids: null, index: 0 }); else setPreviewNode(target); }}
            alternatesDock={isAlternateMediaType(node.type) && nodeAlternates(node).length ? (usesAlternateStack(node) ? (
              <WorkflowAlternatesStack
                node={node}
                language={language}
                expanded={expandedAlternateStacks.has(node.id)}
                onToggleExpanded={() => setExpandedAlternateStacks(current => { const next = new Set(current); if (next.has(node.id)) next.delete(node.id); else next.add(node.id); return next; })}
                onPreview={index => setGalleryPreview({ ownerId: node.id, ids: null, index })}
                onPromote={alternateId => promoteNodeAlternate(node.id, alternateId)}
              />
            ) : (
              <WorkflowAlternatesDock
                node={node}
                language={language}
                collapsed={collapsedAlternateDocks.has(node.id)}
                onToggleCollapsed={() => setCollapsedAlternateDocks(current => { const next = new Set(current); if (next.has(node.id)) next.delete(node.id); else next.add(node.id); return next; })}
                onPreview={(index, ids) => setGalleryPreview({ ownerId: node.id, ids: ids || null, index })}
                onPromote={alternateId => promoteNodeAlternate(node.id, alternateId)}
                onRemove={ids => removeNodeAlternates(node.id, ids)}
                onSplit={ids => splitNodeAlternates(node.id, ids)}
                onExport={ids => { const owner = projectRef.current.nodes.find(item => item.id === node.id); if (owner) void exportSelectedMedia(nodeAlternates(owner).filter(item => ids.includes(item.id)).map(item => alternateAsNode(owner, item))); }}
              />
            )) : undefined}
            onNeedPoster={() => requestVideoPoster(node.id)}
            onChangeTitle={title => {
              if (node.isLocked) return;
              // Context Card 的标题是定稿的一部分：改名也作为显式的新版本保存（旧版本进 history）。
              if (isContextCardNode(node)) { void saveContextCardEdit({ projectId: projectRef.current.id, nodeId: node.id, title, body: node.metadata.content || '' }); return; }
              applyOps([{ type: 'update_node', id: node.id, patch: { title } }]);
            }}
            anchorCode={anchorCodes.get(node.id)}
            trimEditing={inlineTrim?.projectId === project.id && inlineTrim.nodeId === node.id}
            trimBusy={inlineTrimBusy}
            onTrimConfirm={(startSec, endSec) => { void confirmInlineTrim(node.id, startSec, endSec); }}
            onTrimCancel={() => { if (!inlineTrimBusy) setInlineTrim(null); }}
            onToggleAnchorApproval={node.anchor ? () => {
              if (node.isLocked) return;
              const patch = anchorApprovalPatch(node, new Date(), projectRef.current.nodes);
              if (patch) applyOps([{ type: 'update_node', id: node.id, patch }]);
            } : undefined}
            renameSignal={renameSignal?.nodeId === node.id ? renameSignal.nonce : undefined}
            onFocusNode={() => focusNode(node.id)}
            pluginContext={workflowNodePluginContextFromProject({
              project: projectRef.current,
              node,
              applyOps: ops => node.isLocked ? false : applyOps(ops),
            })}
          />;
        })}
        </AnimatePresence>
        {selectionStyle && <div className="workflow-selection-box" style={selectionStyle} />}
      </div>
      {!overlayHidden && overlayBounds && selectedNodeData.length > 0 && selectedNodeData.every(node => !node.isLocked) && <>
        <div ref={toolbarOverlayRef} data-workflow-overlay style={{ position: 'absolute', zIndex: 70, left: toolbarLeft, top: toolbarTop, transform: 'translateX(-50%)' }}>
          <WorkflowNodeToolbar
            nodes={selectedNodeData}
            language={language}
            onCopy={ids => copyNodesToClipboard(ids)}
            onDelete={ids => applyOps([{ type: 'delete_nodes', ids }])}
            onExport={nodes => { void exportSelectedMedia(nodes); }}
            onRun={id => runNodeWithKeyGuide(id)}
            onStop={stopNode}
            onPromptFocus={() => setPromptFocusSignal(value => value + 1)}
            onFrameSelection={frameSelection}
            onSaveMedia={onSaveWorkflowMedia}
            onGroup={ids => groupSelection(ids)}
            onUngroup={ids => ungroupSelection(ids)}
            onArrange={(ids, layout, gap) => {
              const next = arrangeNodePositions(projectRef.current.nodes, ids, { layout, gap });
              if (!next) { setNotice('至少需要两个未锁定的节点，或已经是该排列'); return; }
              // update_node 走 applyOps，可撤销；锁定节点不在 next 中。
              applyOps(Object.entries(next).map(([id, position]) => ({ type: 'update_node' as const, id, patch: { position } })));
            }}
            onSequencedExport={(ids, prefix) => { void exportSelectedMedia(projectRef.current.nodes.filter(item => ids.includes(item.id)), prefix); }}
            onDiscussWithAgent={ids => { void discussWithAgent(ids); }}
            onAddToAgent={ids => {
              const members = projectRef.current.nodes.filter(item => ids.includes(item.id));
              const batchId = members.find(item => item.batchId)?.batchId;
              pushAgentGroup({ nodeIds: arrangementOrder(members, ids).map(item => item.id), label: members.length === 1 ? members[0].title : `分组 · ${members.length} 个节点`, batchId });
              setNotice('已添加到 Agent，可在侧边面板保存为 Skill');
            }}
            onGenerateAsset={(id, kind) => {
              const source = projectRef.current.nodes.find(item => item.id === id);
              if (!source || source.isLocked || !canGenerateTextAssets(source)) return;
              const spec = textAssetSpec(kind);
              // 备注不参与连线生成：派生节点把备注原文写进自己的 prompt，之后各自独立可改。
              const derived = projectRef.current.nodes.filter(item => item.metadata.assetSourceNoteId === id).length;
              const node = {
                ...createWorkflowNode(nanoid(), 'image', { x: source.position.x + source.width + 96, y: source.position.y + derived * 280 }, {
                  prompt: buildTextAssetPrompt(kind, source.metadata.content || ''),
                  status: 'idle',
                  config: { mode: 'image', aspectRatio: spec.aspectRatio },
                  origin: 'user' as const,
                  assetSourceNoteId: id,
                }),
                title: spec.title,
              };
              if (!applyOps([{ type: 'add_node', node }])) return;
              setNotice(`已创建「${spec.title}」节点：备注内容已写入提示词，选好模型后在节点上运行`);
            }}
            onMergeNotePrompt={id => {
              const note = projectRef.current.nodes.find(item => item.id === id);
              if (!note || note.type !== 'text' || note.isLocked) return;
              const content = note.metadata.content?.trim();
              if (!content) { setNotice('备注为空，没有可并入的内容'); return; }
              const updates = (note.metadata.noteMergeTargetIds || []).flatMap(targetId => {
                const target = projectRef.current.nodes.find(item => item.id === targetId);
                if (!target || target.isLocked) return [];
                const existing = target.metadata.prompt?.trim() || '';
                if (existing.includes(content)) return [];
                return [{ type: 'update_node' as const, id: targetId, metadata: { prompt: existing ? `${existing}\n\n${content}` : content } }];
              });
              if (!updates.length) { setNotice('目标节点不存在、已锁定，或提示词已包含该备注'); return; }
              applyOps([...updates, { type: 'update_node', id, metadata: { noteMergeTargetIds: [] } }]);
              setNotice(`已把备注并入 ${updates.length} 个节点的提示词`);
            }}
            toolHints={toolHints}
            onExecuteGroup={ids => topoSort(projectRef.current.nodes, projectRef.current.connections, ids).forEach(id => enqueueRunNode(id))}
            onReversePrompt={onReversePrompt ? (id, mediaUrl) => {
              const node = projectRef.current.nodes.find(item => item.id === id);
              if (!node || node.isLocked) return;
              setNotice('正在反推 Prompt…');
              void (async () => {
                let href = mediaUrl;
                let mimeType = node.metadata.mimeType || 'image/png';
                let width = node.metadata.naturalWidth;
                let height = node.metadata.naturalHeight;
                if (node.type === 'video') {
                  const poster = await loadWorkflowMediaBlob(node.metadata.posterStorageKey, node.metadata.poster);
                  const frame = poster
                    ? { blob: poster, width: node.metadata.naturalWidth || 0, height: node.metadata.naturalHeight || 0 }
                    : await (async () => {
                      const video = await loadWorkflowMediaBlob(node.metadata.storageKey, node.metadata.href, node.metadata.artifactRef);
                      if (!video) throw new Error('视频媒体不存在，无法反推');
                      return extractVideoFrame(video, 'first');
                    })();
                  href = await workflowBlobToDataUrl(frame.blob);
                  mimeType = frame.blob.type || 'image/png';
                  width = frame.width || width;
                  height = frame.height || height;
                }
                return onReversePrompt(href, mimeType, width, height);
              })()
                .then(prompt => {
                  if (!prompt) { setNotice('反推没有返回可用 Prompt，请检查视觉模型配置'); return; }
                  if (projectRef.current.nodes.find(item => item.id === id)?.isLocked) return;
                  // update_node 是浅合并：只传 prompt，避免 await 期间过期的 node.metadata 整体覆盖最新状态。
                  applyOps([{ type: 'update_node', id, metadata: { prompt } }]);
                  setPromptFocusSignal(value => value + 1);
                  setNotice('反推完成，Prompt 已写入节点');
                })
                .catch(error => setNotice(displayError(error, '反推 Prompt 失败')));
            } : undefined}
            imageTools={{ ...builtInImageTools, ...imageTools }}
            imageToolBusy={imageToolActive}
            videoTools={builtInVideoTools}
            videoToolBusy={videoToolActive}
            audioTools={builtInAudioTools}
            audioToolBusy={audioToolActive}
            onReplaceMedia={(id, file) => { const node = projectRef.current.nodes.find(item => item.id === id); if (node) void replaceMedia(node, file); }}
            onPreviewMedia={(id) => { const target = projectRef.current.nodes.find(n => n.id === id); if (target) setPreviewNode(target); }}
            onToggleFreeResize={id => { const node = projectRef.current.nodes.find(item => item.id === id); if (node) applyOps([{ type: 'update_node', id, patch: { freeResize: !node.freeResize } }]); }}
            onLayer={position => {
              const selected = projectRef.current.nodes.filter(node => selectedNodes.has(node.id));
              const remaining = projectRef.current.nodes.filter(node => !selectedNodes.has(node.id));
              commitFrame(position === 'front' ? [...remaining, ...selected] : [...selected, ...remaining], projectRef.current.connections);
            }}
            onAlign={alignment => {
              const next = alignNodes(projectRef.current.nodes, selectedIdsRef.current, alignment);
              if (next) commitFrame(next, projectRef.current.connections);
            }}
            onDistribute={direction => {
              const next = distributeNodes(projectRef.current.nodes, selectedIdsRef.current, direction);
              if (next) commitFrame(next, projectRef.current.connections);
            }}
          />
        </div>
        {selectedNodeData.length === 1 && workflowPromptBarTarget(selectedNodeData[0]) && <div data-workflow-overlay style={{ position: 'absolute', zIndex: promptExpanded ? 90 : 69, left: promptLeft, ...(promptAbove ? { bottom: promptBottom } : { top: promptTop }) }}>
      <WorkflowNodePromptBar width={promptWidth} expanded={promptExpanded} onToggleExpanded={() => { const id = selectedNodeData[0].id; setExpandedPromptNodeId(current => (current === id ? null : id)); }} node={selectedNodeData[0]} nodes={project.nodes} connections={project.connections} t={t} theme={theme} language={language} userApiKeys={userApiKeys} dynamicModelOptions={dynamicModelOptions} onOpenSettings={onOpenSettings} onEnhancePrompt={onEnhancePrompt} isEnhancingPrompt={isEnhancingPrompt} onChange={metadata => applyOps([{ type: 'update_node', id: selectedNodeData[0].id, metadata }])} onPromptIntent={intent => { promptIntentRef.current = intent; }} onRun={() => { const intent = promptIntentRef.current?.targetNodeId === selectedNodeData[0].id ? promptIntentRef.current : undefined; promptIntentRef.current = null; onRunNode(selectedNodeData[0].id, intent || undefined); }} onStop={onStopNode ? () => onStopNode(selectedNodeData[0].id) : undefined} focusSignal={promptFocusSignal} onDisconnectReference={fromNodeId => { const targetId = selectedNodeData[0].id; const conn = project.connections.find(c => c.toNodeId === targetId && c.fromNodeId === fromNodeId); if (!conn) return; applyOps([{ type: 'delete_connections', ids: [conn.id] }]); }} onReorderReference={nextIds => handleReorderReferences(selectedNodeData[0].id, nextIds)} assetFolders={assetFolders} assetItems={assetSuggestions} assetLibrary={assetLibrary} onSelectWorkflowReference={selectedNodeData[0] ? (nodeId => handleSelectWorkflowReference(nodeId, selectedNodeData[0].id)) : undefined} onAddReferenceFiles={selectedNodeData[0] ? (files => handleAddReferenceFiles(files, selectedNodeData[0].id)) : undefined} onSelectAsset={selectedNodeData[0] ? (assetId => handleSelectAsset(assetId, selectedNodeData[0].id)) : undefined} onResolvePastedMentions={mentions => handleResolvePastedMentions(mentions, selectedNodeData[0].id)} onPasteUnresolvedMentions={labels => setNotice('未能唯一匹配引用：' + labels.map(label => '@' + label).join('、') + '，已保留为普通文字。')} onSlashShortcut={(shortcut, remaining) => handleSlashCommand(shortcut, selectedNodeData[0].id, remaining)} />
        </div>}
      </>}
      <WorkflowHostStrip clips={hostClips} language={language} onFocusClip={focusNode} />
      <WorkflowQuickToggles
        language={language}
        minimapOpen={minimapOpen}
        onToggleMinimap={() => setMinimapOpen(open => !open)}
        snapEnabled={snapEnabled}
        onToggleSnap={() => setSnapEnabled(snap => !snap)}
        edgesVisible={edgesVisible}
        onToggleEdges={() => setEdgesVisible(v => !v)}
        gridOn={(project.backgroundMode || 'dots') !== 'none'}
        onToggleGrid={() => patchProject({ backgroundMode: projectRef.current.backgroundMode === 'none' ? 'dots' : projectRef.current.backgroundMode === 'dots' ? 'lines' : 'none' })}
      />
      {minimapOpen && <WorkflowMiniMap nodes={displayNodes.filter(node => node.isVisible !== false)} viewport={project.viewport} onCenter={(x, y) => {
        setFocusBadge(false);
        const rect = rootRef.current?.getBoundingClientRect();
        patchProject({ viewport: { ...viewportRef.current, x: (rect?.width || 1000) / 2 - x * viewportRef.current.k, y: (rect?.height || 700) / 2 - y * viewportRef.current.k } });
      }} />}
      {notice && <div role="status" aria-live="polite" data-workflow-overlay style={{ position: 'absolute', zIndex: 80, right: 14, top: 58, maxWidth: 320, padding: '7px 10px', border: '1px solid var(--wf-border)', borderRadius: 7, color: 'var(--wf-text)', background: 'var(--wf-panel)', fontSize: 12 }}>{notice}</div>}
      {noKeyRunNodeId && <div role="alertdialog" aria-label={language === 'zho' ? '配置 AI 服务' : 'Set up an AI service'} data-testid="workflow-no-key-guide" data-workflow-overlay onPointerDown={event => event.stopPropagation()} style={{ position: 'absolute', zIndex: 95, right: 14, top: 58, maxWidth: 340, padding: '12px 14px', border: '1px solid var(--wf-border)', borderRadius: 8, color: 'var(--wf-text)', background: 'var(--wf-panel)', fontSize: 12, display: 'grid', gap: 8 }}>
        <strong>{language === 'zho' ? '还没有配置 AI 服务' : 'No AI service set up yet'}</strong>
        <span>{language === 'zho' ? '生成需要你自己的 AI 服务 Key 或 Base URL。Key 只保存在本机浏览器，生成时直接发给你选择的服务。' : 'Generating needs your own AI service key or Base URL. The key stays in this browser and goes only to the service you choose.'}</span>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <button type="button" onClick={() => setNoKeyRunNodeId(null)}>{language === 'zho' ? '取消' : 'Cancel'}</button>
          <button type="button" data-testid="workflow-no-key-run-anyway" onClick={() => { const id = noKeyRunNodeId; setNoKeyRunNodeId(null); onRunNode(id); }}>{language === 'zho' ? '仍然运行' : 'Run anyway'}</button>
          {onOpenSettings && <button type="button" data-testid="workflow-no-key-open-settings" onClick={() => { setNoKeyRunNodeId(null); onOpenSettings(); }}>{language === 'zho' ? '配置 AI 服务' : 'Set up AI service'}</button>}
        </div>
      </div>}
      <AnimatePresence>
        {focusBadge && (
          <motion.button
            type="button"
            data-workflow-overlay
            aria-label="还原缩放"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            transition={{ type: 'spring', stiffness: 420, damping: 30, mass: 0.7 }}
            onPointerDown={event => event.stopPropagation()}
            onClick={() => fitView()}
            style={{ position: 'absolute', zIndex: 70, bottom: 72, left: '50%', translate: '-50% 0', display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 11px', border: '1px solid var(--isl-border, var(--wf-border))', borderRadius: 999, color: 'var(--wf-text-soft, var(--wf-text))', background: 'var(--isl-card, var(--wf-panel))', boxShadow: 'var(--isl-shadow)', backdropFilter: 'blur(16px)', fontSize: 12, whiteSpace: 'nowrap', cursor: 'pointer' }}
          >
            <Maximize2 size={13} strokeWidth={2} />
            还原缩放
          </motion.button>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {layoutToast && (
          <motion.div
            data-workflow-overlay
            role="status"
            aria-live="polite"
            initial={{ opacity: 0, y: 14, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 14, scale: 0.96 }}
            transition={{ type: 'spring', stiffness: 420, damping: 30, mass: 0.7 }}
            onPointerDown={event => event.stopPropagation()}
            style={{ position: 'absolute', zIndex: 80, bottom: 14, right: 14, display: 'inline-flex', alignItems: 'center', gap: 8, padding: '6px 10px 6px 12px', borderRadius: 999, border: '1px solid var(--wf-border)', color: 'var(--wf-text)', background: 'var(--wf-panel)', fontSize: 12, boxShadow: 'var(--isl-shadow-sm, 0 4px 14px rgba(0,0,0,0.08))' }}
          >
            <span>已整理节点</span>
            <button type="button" onClick={restoreLayout} aria-label="还原整理" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 9px', borderRadius: 999, border: '1px solid var(--wf-border)', background: 'transparent', color: 'var(--wf-text)', fontSize: 11, cursor: 'pointer' }}>
              <Undo2 size={12} strokeWidth={2.4} />还原
            </button>
            <button type="button" onClick={() => setLayoutToast(null)} aria-label="保留整理结果" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 9px', borderRadius: 999, border: 'none', background: 'var(--wf-accent, #2563eb)', color: '#fff', fontSize: 11, cursor: 'pointer' }}>
              <Check size={12} strokeWidth={2.6} />保留
            </button>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {connectionDrag && (
          <motion.div
            className="workflow-connection-bubble"
            initial={{ opacity: 0, scale: 0.4 }}
            animate={{ opacity: 1, scale: 1, x: connectionDrag.local.x, y: connectionDrag.local.y }}
            exit={{ opacity: 0, scale: 0.4 }}
            transition={{ type: 'spring', stiffness: 600, damping: 32, mass: 0.6 }}
            data-direction={connectionDrag.direction}
          >
            <Plus size={16} strokeWidth={2.4} />
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {createMenu && <WorkflowCreateMenu state={createMenu} onCreate={createFromMenu} onClose={closeCreateMenu} onAskAgent={createMenu.sourceId || createMenu.targetId ? undefined : text => { void askAgentAt(createMenu.world, text); }} language={language} />}
      </AnimatePresence>
      {contextMenu && (() => {
          const ctxNode = contextMenu.type === 'node' ? projectRef.current.nodes.find(n => n.id === contextMenu.id) : null;
          const ctxGroupId = contextMenu.type === 'node' ? enclosingGroupId(projectRef.current.nodes, contextMenu.id) : undefined;
          const batch = ctxNode?.batchId ? batchGroups.get(ctxNode.batchId) : null;
          const canSetPrimary = Boolean(ctxNode && ctxNode.type === 'image' && batch && batch.length > 1 && ctxNode.id !== (batch.find(n => n.batchIndex === 0)?.metadata.primaryImageId));
          return (
        <WorkflowContextMenu
          state={contextMenu}
          language={language}
          onClose={() => setContextMenu(null)}
          count={contextMenu.type === 'node' ? Math.max(1, selectedIdsRef.current.length) : 1}
          onAddNode={() => { setContextMenu(null); openCreateMenu(contextMenu.x, contextMenu.y); }}
          onPaste={() => { setContextMenu(null); void pasteSelection(); }}
          onSelectAll={() => { setContextMenu(null); selectNodes(projectRef.current.nodes.filter(node => node.isVisible !== false).map(node => node.id)); }}
          onFitView={() => { setContextMenu(null); fitView(); }}
          onSetPrimary={canSetPrimary ? (() => {
            if (!ctxNode?.batchId) return;
            applyOps([{ type: 'set_batch_primary', batchId: ctxNode.batchId, nodeId: ctxNode.id }]);
            setContextMenu(null);
          }) : undefined}
          onRunGroup={ctxGroupId ? (() => {
            const order = groupRunOrder(projectRef.current.nodes, projectRef.current.connections, ctxGroupId);
            setContextMenu(null);
            if (!order.length) { setNotice('组内没有可执行的生成节点（需要写了提示词的图片 / 视频节点）'); return; }
            order.forEach(id => enqueueRunNode(id));
            setNotice('整组执行：按依赖顺序排队 ' + order.length + ' 个节点');
          }) : undefined}
          onDownloadGroup={ctxGroupId && onSaveWorkflowMedia ? (() => {
            const media = groupMemberIds(projectRef.current.nodes, ctxGroupId)
              .map(id => projectRef.current.nodes.find(node => node.id === id))
              .filter((node): node is WorkflowNodeData => Boolean(node && ['image', 'video', 'audio'].includes(node.type) && (node.metadata.storageKey || node.metadata.href || node.metadata.artifactRef?.taskId)));
            setContextMenu(null);
            if (!media.length) { setNotice('组内没有可下载的媒体'); return; }
            media.forEach(node => onSaveWorkflowMedia(node.id));
          }) : undefined}
          onCopy={() => { copySelection(); setContextMenu(null); }}
          onDuplicate={ctxNode && !ctxNode.isLocked ? (() => { duplicateSelection(); setContextMenu(null); }) : undefined}
          onSaveMedia={contextMenu.type === 'node' && ctxNode && ['image', 'video', 'audio'].includes(ctxNode.type) && (ctxNode.metadata.storageKey || ctxNode.metadata.href || ctxNode.metadata.artifactRef?.taskId) && onSaveWorkflowMedia ? (() => { onSaveWorkflowMedia(ctxNode.id); setContextMenu(null); }) : undefined}
          onSendToCut={contextMenu.type === 'node' && ctxNode && (ctxNode.type === 'image' || ctxNode.type === 'video') && (ctxNode.metadata.storageKey || ctxNode.metadata.href || ctxNode.metadata.artifactRef?.taskId) ? (() => {
            const nodeId = ctxNode.id;
            const projectId = projectRef.current.id;
            setContextMenu(null);
            void import('../../services/cut/runtime')
              .then(runtime => runtime.sendCanvasNodeToCut(projectId, nodeId))
              .then(() => setNotice(language === 'zho' ? '已送进 Cut 时间线末尾' : 'Added to the end of the Cut timeline'))
              .catch(error => setNotice((language === 'zho' ? '送进 Cut 失败：' : 'Could not send to Cut: ') + (error instanceof Error ? error.message : String(error))));
          }) : undefined}
          onRun={() => { if (contextMenu.type === 'node' && !projectRef.current.nodes.find(node => node.id === contextMenu.id)?.isLocked) runNodeWithKeyGuide(contextMenu.id); setContextMenu(null); }}
          onRename={contextMenu.type === 'node' && ctxNode && !ctxNode.isLocked ? (() => { setRenameSignal({ nodeId: ctxNode.id, nonce: Date.now() }); setContextMenu(null); }) : undefined}
          onDelete={() => { if (contextMenu.type !== 'pane') deleteSelection(); setContextMenu(null); }}
        />
          );
        })()}
      <WorkflowImageToolDialogs
        tool={imageTool}
        node={activeImageToolNode}
        mediaUrl={activeImageToolMedia.url || ''}
        layerPoints={imageTool?.kind === 'layer' ? layerLassoPoints : undefined}
        busy={imageToolBusy}
        error={imageToolError || activeImageToolMedia.error}
        onClose={closeImageTool}
        onPreview={previewImageFilters}
        onConfirm={confirmation => { void confirmImageTool(confirmation); }}
      />
      <WorkflowVideoToolDialogs
        tool={videoTool}
        node={activeVideoToolNode}
        mediaUrl={activeVideoToolMedia.url || ''}
        busy={videoToolBusy}
        error={videoToolError || activeVideoToolMedia.error}
        onClose={closeVideoTool}
        onConfirm={confirmation => { void confirmVideoTool(confirmation); }}
      />
      <WorkflowAudioToolDialogs
        tool={audioTool}
        node={activeAudioToolNode}
        mediaUrl={activeAudioToolMedia.url || ''}
        busy={audioToolBusy}
        error={audioToolError || activeAudioToolMedia.error}
        onClose={closeAudioTool}
        onConfirm={confirmation => { void confirmAudioTool(confirmation); }}
      />
      {slashMenu && (
        <div data-workflow-overlay style={{ position: 'absolute', zIndex: 90, left: slashMenu.x, top: slashMenu.y }}>
          <SlashMenu onSelect={handleSlashCommand} onClose={() => setSlashMenu(null)} />
        </div>
      )}
      {scriptEditorNodeId && (() => {
        const scriptNode = projectRef.current.nodes.find(node => node.id === scriptEditorNodeId);
        if (!scriptNode) return null;
        return (
          <ScriptNodeEditor
            node={scriptNode}
            onChange={metadata => {
              const height = scriptNodeHeight(metadata.scriptBreakdown?.shots?.length ?? 0);
              applyOps([{ type: 'update_node', id: scriptNode.id, metadata, ...(height !== scriptNode.height ? { patch: { height } } : {}) }]);
            }}
            onClose={() => setScriptEditorNodeId(null)}
            userApiKeys={userApiKeys}
            confirmRouteFallback={confirmRouteFallback}
            onOpenSettings={onOpenSettings}
            onBatchGenerate={mode => handleScriptBatchGenerate(scriptNode.id, mode)}
          />
        );
      })()}
      <MediaPreviewModal
        node={previewNode}
        gallery={galleryState}
        onClose={() => { setPreviewNode(null); setGalleryPreview(null); }}
        language={language}
      />
    </div>
  );
}
