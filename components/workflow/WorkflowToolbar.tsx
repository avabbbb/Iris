import { AnimatePresence, motion } from 'motion/react';
import { Bot, Camera, FileDown, FileText, Focus, GitCommitVertical, Grid2X2, Hand, History, ImageDown, Keyboard, LayoutTemplate, Magnet, Map, MousePointer2, Plus, Redo2, RotateCcw, Send, SlidersHorizontal, StickyNote, Trash2, Undo2, Video, Image, Music2, Workflow, Spline, ZoomIn, ZoomOut } from 'lucide-react';
import { Tooltip } from 'antd';
import type React from 'react';
import { useMemo, useRef, useState } from 'react';
import { ResponsivePopover } from '../ResponsivePopover';
import { useWorkflowSharedMedia, type WorkflowSharedMedia } from './WorkflowConfigPanel';
import { StudioMediaBrowser } from '../studio/StudioMediaBrowser';
import { useStudioHubStore } from '../../stores/useStudioHubStore';
import { useWorkflowStore } from './store';
import type { WorkflowNodeType } from './types';
import { useWorkspaceStore } from '../../stores/useWorkspaceStore';

export type WorkflowTool = 'select' | 'pan';
type ToolbarPopover = 'add' | 'library' | 'history' | 'tools' | 'shortcuts' | 'zoom';

const Tip: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <Tooltip placement="top" title={title} mouseEnterDelay={0.4} mouseLeaveDelay={0}>{children}</Tooltip>
);

const ADD_OPTIONS: Array<{ type: WorkflowNodeType; icon: typeof StickyNote }> = [
  { type: 'image', icon: Image },
  { type: 'video', icon: Video },
  { type: 'text', icon: StickyNote },
  { type: 'script', icon: FileText },
  { type: 'audio', icon: Music2 },
];

const TOOLBAR_COPY = {
  en: {
    canvasControls: 'Canvas controls', assetManagement: 'Asset management', autoArrange: 'Arrange nodes', minimap: 'Minimap',
    showEdges: 'Show connections', hideEdges: 'Hide connections', snap: 'Snap to grid', zoomReset: 'Reset zoom',
    zoomIn: 'Zoom in', zoomOut: 'Zoom out', fit: 'Fit view', resetZoom: 'Reset zoom to 100%',
    workflowToolbar: 'Workflow toolbar', addNode: 'Add node', tools: 'Tools', toolbox: 'Canvas tools',
    generationHistory: 'Generation history', undo: 'Undo', redo: 'Redo', history: 'History', historyActions: 'History actions',
    shortcuts: 'Keyboard shortcuts', shortcutsTitle: 'Canvas shortcuts', addNodes: 'Add nodes', pan: 'Pan canvas', duplicate: 'Duplicate',
    delete: 'Delete node', arrange: 'Arrange canvas', selectTool: 'Switch to pan tool', panTool: 'Switch to select tool',
    agentOpen: 'Open Agent', agentClose: 'Close Agent',
    wheelPan: 'Wheel: pan', wheelZoom: 'Wheel: zoom',
    addOption: (type: WorkflowNodeType) => ({ image: 'Image', video: 'Video', text: 'Note', script: 'Script', audio: 'Audio', config: 'Generation settings' }[type] || type),
    zoomPercent: (value: number) => `${value}%`,
    revision: (value: number) => `rev ${value}`, revisionHint: 'Open the Timeline: every change by you or an Agent, with focus and restore.', openTimeline: 'Timeline',
    rerunStale: (count: number) => `Rerun ${count} stale`, rerunStaleHint: 'Runs only out-of-date nodes, upstream first. Up-to-date results are reused.',
    sendToHost: (host: string) => `Send to ${host}`, sendHint: 'Adds a send request. Confirm it in the host panel to add the result to the Media Pool. Your timeline is not changed.',
    sendStatus: { requested: 'Waiting for host panel', imported: 'In Media Pool', rejected: 'Host rejected', unknown: 'Check the Media Pool' } as Record<string, string>,
    exportPng: 'Export PNG', exportPdf: 'Export PDF', selectionSuffix: ' (selection)', saveSnapshot: 'Save', snapshotName: 'Snapshot name (optional)',
    snapshots: 'Snapshots', restoreSnapshot: 'Restore this snapshot. You can undo it.', deleteSnapshot: 'Delete snapshot', noSnapshots: 'No snapshots yet.',
    snapshotNodes: (count: number) => count + ' nodes',
    autoDerive: 'Auto-derive new videos', autoFirstFrame: 'Auto first frame', autoLastFrame: 'Auto last frame', autoAvSplit: 'Auto split audio/video',
  },
  zho: {
    canvasControls: '画布控制', assetManagement: '资产管理', autoArrange: '一键整理节点', minimap: '小地图',
    showEdges: '显示连线', hideEdges: '隐藏连线', snap: '对齐磁吸', zoomReset: '重置缩放',
    zoomIn: '放大', zoomOut: '缩小', fit: '适应视图', resetZoom: '重置缩放',
    workflowToolbar: '工作流工具栏', addNode: '添加节点', tools: '工具箱', toolbox: '画布工具箱',
    generationHistory: '历史生成', undo: '撤销', redo: '重做', history: '历史', historyActions: '历史操作',
    shortcuts: '快捷键', shortcutsTitle: '画布快捷键', addNodes: '添加节点', pan: '平移画布', duplicate: '创建副本',
    delete: '删除节点', arrange: '整理画布', selectTool: '切换为平移工具', panTool: '切换为选择工具',
    agentOpen: '打开 Agent', agentClose: '收起 Agent',
    wheelPan: '滚轮：平移', wheelZoom: '滚轮：缩放',
    addOption: (type: WorkflowNodeType) => ({ image: '图片', video: '视频', text: '备注', script: '脚本', audio: '音频', config: '配置' }[type] || type),
    zoomPercent: (value: number) => `${value}%`,
    revision: (value: number) => `rev ${value}`, revisionHint: '打开 Timeline：你和 Agent 的每次修改，可定位、可恢复。', openTimeline: 'Timeline',
    rerunStale: (count: number) => `重跑 ${count} 个过期节点`, rerunStaleHint: '只运行过期的节点，上游先跑；未过期的结果直接复用。',
    sendToHost: (host: string) => `发送到 ${host}`, sendHint: '登记一个发送请求，在宿主面板确认后加入 Media Pool；不会改动你的时间线。',
    sendStatus: { requested: '等待宿主面板确认', imported: '已在 Media Pool', rejected: '宿主拒绝了导入', unknown: '请检查 Media Pool' } as Record<string, string>,
    exportPng: '导出 PNG', exportPdf: '导出 PDF', selectionSuffix: '（所选）', saveSnapshot: '保存', snapshotName: '快照名称（可选）',
    snapshots: '快照', restoreSnapshot: '恢复此快照，可撤销。', deleteSnapshot: '删除快照', noSnapshots: '还没有快照。',
    snapshotNodes: (count: number) => count + ' 个节点',
    autoDerive: '新视频自动派生', autoFirstFrame: '自动截首帧', autoLastFrame: '自动截尾帧', autoAvSplit: '自动音视频分离',
  },
} as const;

export function WorkflowToolbar({
  tool,
  canUndo,
  canRedo,
  onToolChange,
  onAddNode,
  onAddSharedMedia,
  activeProjectId,
  onOpenAssets,
  onUndo,
  onRedo,
  onFit,
  onToggleGrid,
  onOpenAgent,
  wheelMode,
  setWheelMode,
  minimapOpen,
  onToggleMinimap,
  snapEnabled,
  onToggleSnap,
  edgesVisible,
  onToggleEdges,
  onAutoLayout,
  zoomLevel,
  onZoomIn,
  onZoomOut,
  onZoomReset,
  revision,
  lastChange,
  staleCount = 0,
  onRerunStale,
  hostSend,
  agentOpen,
  onExportCanvas,
  exportSelection = false,
  snapshots,
  onSaveSnapshot,
  onRestoreSnapshot,
  onDeleteSnapshot,
  autoMediaDerive,
  onToggleAutoMediaDerive,
  onOpenTemplates,
}: {
  tool: WorkflowTool;
  canUndo: boolean;
  canRedo: boolean;
  onToolChange: (tool: WorkflowTool) => void;
  onAddNode: (type: WorkflowNodeType) => void;
  onAddSharedMedia: (media: WorkflowSharedMedia) => void;
  // 历史生成弹层的画布筛选默认跟随当前画布。
  activeProjectId?: string;
  onOpenAssets?: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onFit: () => void;
  onToggleGrid: () => void;
  onOpenAgent?: () => void;
  agentOpen?: boolean;
  wheelMode?: 'pan' | 'zoom';
  setWheelMode?: (mode: 'pan' | 'zoom') => void;
  minimapOpen?: boolean;
  onToggleMinimap?: () => void;
  snapEnabled?: boolean;
  onToggleSnap?: () => void;
  edgesVisible?: boolean;
  onToggleEdges?: () => void;
  onAutoLayout?: () => void;
  zoomLevel?: number;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  onZoomReset?: () => void;
  /** 当前草稿 revision（draftVersion）；人和 Agent 的每次成功 mutation 都会推进它。 */
  revision?: number;
  /** 最近一次修改的一句话摘要（Timeline 同款），显示在 rev 按钮的提示里。 */
  lastChange?: string;
  /** 当前需要重跑的节点数（派生）；大于 0 时显示“只重跑过期节点”。 */
  staleCount?: number;
  onRerunStale?: () => void;
  /** 选中结果可发送回宿主时出现；已登记过时显示状态而不是按钮。 */
  hostSend?: { host: string; onSend: () => void; status?: 'requested' | 'imported' | 'rejected' | 'unknown' };
  /** 导出画布：有选区时只导出选区。 */
  onExportCanvas?: (format: 'png' | 'pdf') => void;
  exportSelection?: boolean;
  /** 命名快照列表（旧→新）与操作。 */
  snapshots?: Array<{ id: string; name: string; createdAt: string; nodeCount: number }>;
  onSaveSnapshot?: (name: string) => void;
  onRestoreSnapshot?: (id: string) => void;
  onDeleteSnapshot?: (id: string) => void;
  /** 新视频（上传/生成完成）自动截帧、音视频分离；默认全部关闭。 */
  autoMediaDerive?: { firstFrame: boolean; lastFrame: boolean; avSplit: boolean };
  onToggleAutoMediaDerive?: (key: 'firstFrame' | 'lastFrame' | 'avSplit') => void;
  /** 打开 Tapflow 工作流模板库（内置蓝图 + 自定义模板保存/导入/复用）。 */
  onOpenTemplates?: () => void;
}) {
  const sharedMedia = useWorkflowSharedMedia();
  const language = useWorkspaceStore(state => state.language);
  const copy = TOOLBAR_COPY[language];
  const workflowProjects = useWorkflowStore(state => state.projects);
  const historyProjects = useMemo(() => workflowProjects.map(project => ({ id: project.id, title: project.title })), [workflowProjects]);
  const [openPopover, setOpenPopover] = useState<ToolbarPopover | null>(null);
  const [snapshotName, setSnapshotName] = useState('');
  const snapshotTime = (iso: string) => {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(language === 'zho' ? 'zh-CN' : 'en-US', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  };
  const popoverTriggerRef = useRef<HTMLElement | null>(null);
  const popoverAnchorRef = useRef<HTMLElement | null>(null);
  const addOpen = openPopover === 'add';
  const libraryOpen = openPopover === 'library';
  const toolsOpen = openPopover === 'tools';
  const zoomOpen = openPopover === 'zoom';
  const togglePopover = (name: ToolbarPopover, trigger: HTMLElement) => {
    if (openPopover === name) { setOpenPopover(null); return; }
    popoverTriggerRef.current = trigger;
    popoverAnchorRef.current = trigger;
    setOpenPopover(name);
  };
  const closePopover = (restoreFocus = false) => {
    setOpenPopover(null);
    if (restoreFocus) requestAnimationFrame(() => popoverTriggerRef.current?.focus());
  };
  const btn = (active = false) => `isl-icon-btn workflow-toolbar__button${active ? ' isl-icon-btn--active' : ''}`;
  const activePopover = openPopover === 'add' ? (
    <ResponsivePopover anchorRef={popoverAnchorRef} preferredSide="up" width={174} role="menu" ariaLabel={copy.addNodes} className="workflow-toolbar__add-menu-content" onRequestClose={() => setOpenPopover(null)}>
      {ADD_OPTIONS.map(option => { const Icon = option.icon; return <motion.button key={option.type} type="button" role="menuitem" className="workflow-toolbar__add-item" onClick={() => { onAddNode(option.type); closePopover(true); }} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }}><span className="workflow-toolbar__add-item-icon"><Icon size={16} /></span><span>{copy.addOption(option.type)}</span></motion.button>; })}
    </ResponsivePopover>
  ) : openPopover === 'tools' ? (
    <ResponsivePopover anchorRef={popoverAnchorRef} preferredSide="up" width={196} role="menu" ariaLabel={copy.toolbox} className="workflow-toolbar__compact-menu" onRequestClose={() => setOpenPopover(null)}>
      <button type="button" role="menuitem" onClick={() => { onFit(); closePopover(true); }}><Focus size={15} />{copy.fit}</button>
      {onAutoLayout && <button type="button" role="menuitem" onClick={() => { onAutoLayout(); closePopover(true); }}><Workflow size={15} />{copy.autoArrange}</button>}
      {onToggleMinimap && <button type="button" role="menuitemcheckbox" aria-checked={Boolean(minimapOpen)} onClick={() => { onToggleMinimap(); closePopover(true); }}><Map size={15} />{copy.minimap}{minimapOpen ? ' ✓' : ''}</button>}
      {onToggleEdges && <button type="button" role="menuitem" onClick={() => { onToggleEdges(); closePopover(true); }}><Spline size={15} />{edgesVisible === false ? copy.showEdges : copy.hideEdges}</button>}
      {onToggleSnap && <button type="button" role="menuitemcheckbox" aria-checked={Boolean(snapEnabled)} onClick={() => { onToggleSnap(); closePopover(true); }}><Magnet size={15} />{copy.snap}{snapEnabled ? ' ✓' : ''}</button>}
      <button type="button" role="menuitem" onClick={() => { onToggleGrid(); closePopover(true); }}><Grid2X2 size={15} />{language === 'en' ? 'Toggle grid' : '切换网格'}</button>
      {setWheelMode && wheelMode && <button type="button" role="menuitem" onClick={() => { setWheelMode(wheelMode === 'pan' ? 'zoom' : 'pan'); closePopover(true); }}>{wheelMode === 'pan' ? <MousePointer2 size={15} /> : <ZoomIn size={15} />}{wheelMode === 'pan' ? copy.wheelPan : copy.wheelZoom}</button>}
      {staleCount > 0 && onRerunStale && (
        <button type="button" role="menuitem" data-testid="workflow-rerun-stale" onClick={() => { onRerunStale(); closePopover(true); }}><RotateCcw size={15} />{copy.rerunStale(staleCount)}</button>
      )}
      {onExportCanvas && <button type="button" role="menuitem" data-testid="workflow-export-png" onClick={() => { onExportCanvas('png'); closePopover(true); }}><ImageDown size={15} />{copy.exportPng}{exportSelection ? copy.selectionSuffix : ''}</button>}
      {onExportCanvas && <button type="button" role="menuitem" data-testid="workflow-export-pdf" onClick={() => { onExportCanvas('pdf'); closePopover(true); }}><FileDown size={15} />{copy.exportPdf}{exportSelection ? copy.selectionSuffix : ''}</button>}
      {autoMediaDerive && onToggleAutoMediaDerive && <>
        <div className="workflow-toolbar__menu-divider" role="separator" aria-label={copy.autoDerive} title={copy.autoDerive} />
        <button type="button" role="menuitemcheckbox" data-testid="workflow-auto-first-frame" aria-checked={autoMediaDerive.firstFrame} onClick={() => onToggleAutoMediaDerive('firstFrame')}><Camera size={15} />{copy.autoFirstFrame}{autoMediaDerive.firstFrame ? ' ✓' : ''}</button>
        <button type="button" role="menuitemcheckbox" data-testid="workflow-auto-last-frame" aria-checked={autoMediaDerive.lastFrame} onClick={() => onToggleAutoMediaDerive('lastFrame')}><Camera size={15} />{copy.autoLastFrame}{autoMediaDerive.lastFrame ? ' ✓' : ''}</button>
        <button type="button" role="menuitemcheckbox" data-testid="workflow-auto-av-split" aria-checked={autoMediaDerive.avSplit} onClick={() => onToggleAutoMediaDerive('avSplit')}><Workflow size={15} />{copy.autoAvSplit}{autoMediaDerive.avSplit ? ' ✓' : ''}</button>
        <div className="workflow-toolbar__menu-divider" role="separator" />
      </>}
      <button type="button" role="menuitem" onClick={() => setOpenPopover('shortcuts')}><Keyboard size={15} />{copy.shortcuts}</button>
    </ResponsivePopover>
  ) : openPopover === 'zoom' ? (
    <ResponsivePopover anchorRef={popoverAnchorRef} preferredSide="up" width={174} role="menu" ariaLabel={copy.canvasControls} className="workflow-toolbar__compact-menu" onRequestClose={() => setOpenPopover(null)}>
      <button type="button" role="menuitem" onClick={() => { onZoomIn?.(); closePopover(true); }}><ZoomIn size={15} />{copy.zoomIn}</button>
      <button type="button" role="menuitem" onClick={() => { onZoomOut?.(); closePopover(true); }}><ZoomOut size={15} />{copy.zoomOut}</button>
      <button type="button" role="menuitem" onClick={() => { onFit(); closePopover(true); }}><Focus size={15} />{copy.fit}</button>
      <button type="button" role="menuitem" onClick={() => { onZoomReset?.(); closePopover(true); }}><span>100%</span>{copy.resetZoom}</button>
    </ResponsivePopover>
  ) : openPopover === 'history' ? (
    <ResponsivePopover anchorRef={popoverAnchorRef} preferredSide="up" width={onSaveSnapshot ? 264 : 174} role="menu" ariaLabel={copy.historyActions} className="workflow-toolbar__compact-menu" onRequestClose={() => setOpenPopover(null)}>
      <button type="button" role="menuitem" disabled={!canUndo} onClick={() => { onUndo(); closePopover(true); }}><Undo2 size={15} />{copy.undo}</button>
      <button type="button" role="menuitem" disabled={!canRedo} onClick={() => { onRedo(); closePopover(true); }}><Redo2 size={15} />{copy.redo}</button>
      <button type="button" role="menuitem" data-testid="workflow-open-timeline" onClick={() => { closePopover(); useStudioHubStore.getState().openHub('timeline', activeProjectId || null); }}><GitCommitVertical size={15} />{copy.openTimeline}{typeof revision === 'number' && revision > 0 ? ` · ${copy.revision(revision)}` : ''}</button>
      {onSaveSnapshot && (
        <>
          <div className="workflow-toolbar__menu-divider" role="separator" />
          <form className="workflow-toolbar__snapshot-form" data-testid="workflow-snapshot-form" onSubmit={event => { event.preventDefault(); onSaveSnapshot(snapshotName); setSnapshotName(''); }}>
            <input value={snapshotName} maxLength={60} placeholder={copy.snapshotName} aria-label={copy.snapshotName} onChange={event => setSnapshotName(event.target.value)} onKeyDown={event => event.stopPropagation()} />
            <button type="submit"><Camera size={14} />{copy.saveSnapshot}</button>
          </form>
          <div className="workflow-toolbar__snapshot-list" role="group" aria-label={copy.snapshots}>
            {snapshots?.length ? [...snapshots].reverse().map(snapshot => (
              <div key={snapshot.id} className="workflow-toolbar__snapshot-row">
                <button type="button" role="menuitem" title={copy.restoreSnapshot} onClick={() => { onRestoreSnapshot?.(snapshot.id); closePopover(true); }}>
                  <History size={14} />
                  <span className="workflow-toolbar__snapshot-name">{snapshot.name}</span>
                  <span className="workflow-toolbar__snapshot-meta">{copy.snapshotNodes(snapshot.nodeCount)} · {snapshotTime(snapshot.createdAt)}</span>
                </button>
                {onDeleteSnapshot && <button type="button" className="workflow-toolbar__snapshot-delete" aria-label={copy.deleteSnapshot} title={copy.deleteSnapshot} onClick={() => onDeleteSnapshot(snapshot.id)}><Trash2 size={13} /></button>}
              </div>
            )) : <p className="workflow-toolbar__snapshot-empty">{copy.noSnapshots}</p>}
          </div>
        </>
      )}
    </ResponsivePopover>
  ) : openPopover === 'shortcuts' ? (
    <ResponsivePopover anchorRef={popoverAnchorRef} preferredSide="up" width={240} role="dialog" ariaLabel={copy.shortcutsTitle} className="workflow-toolbar__shortcut-card" onRequestClose={() => setOpenPopover(null)}>
      <strong>{copy.shortcutsTitle}</strong><span><kbd>Double click</kbd> {copy.addNodes.toLowerCase()}</span><span><kbd>Space</kbd> {copy.pan.toLowerCase()}</span><span><kbd>Ctrl D</kbd> {copy.duplicate}</span><span><kbd>Ctrl Z</kbd> {copy.undo}</span><span><kbd>Delete</kbd> {copy.delete}</span><span><kbd>Alt Shift F</kbd> {copy.arrange}</span>
    </ResponsivePopover>
  ) : openPopover === 'library' ? (
    <ResponsivePopover anchorRef={popoverAnchorRef} preferredSide="up" width={360} role="dialog" ariaLabel={copy.generationHistory} className="workflow-toolbar__history-browser" dataTestId="workflow-toolbar-history" onRequestClose={() => setOpenPopover(null)}>
      <StudioMediaBrowser mode="history" items={sharedMedia} language={language} projects={historyProjects} activeProjectId={activeProjectId} onInsert={media => { onAddSharedMedia(media); closePopover(true); }} onExpand={() => { closePopover(true); useStudioHubStore.getState().openHub('history', activeProjectId || null); }} />
    </ResponsivePopover>
  ) : null;
  return (
    <div className="workflow-toolbar-layer">
    <div className="workflow-toolbar theme-aware" role="toolbar" aria-label={copy.workflowToolbar}>
      {typeof revision === 'number' && revision > 0 && (
        <Tip title={lastChange ? `${lastChange} · ${copy.revisionHint}` : copy.revisionHint}><button type="button" className="workflow-canvas-controls__revision" data-testid="workflow-revision" aria-label={`${copy.revision(revision)}. ${copy.revisionHint}`} onClick={() => { closePopover(); useStudioHubStore.getState().openHub('timeline', activeProjectId || null); }}>{copy.revision(revision)}</button></Tip>
      )}
      {hostSend && (
        hostSend.status
          ? <span className="workflow-canvas-controls__send-status" role="status" data-testid="workflow-host-send-status">{copy.sendStatus[hostSend.status]}</span>
          : <Tip title={copy.sendHint}><button type="button" className="workflow-canvas-controls__action workflow-canvas-controls__action--primary" data-testid="workflow-host-send" onClick={hostSend.onSend}><Send size={14} aria-hidden="true" />{copy.sendToHost(hostSend.host)}</button></Tip>
      )}

      <div className="workflow-toolbar__add-wrap">
        <Tip title={copy.addNode}><button type="button" className="isl-icon-btn workflow-toolbar__add-btn" aria-label={copy.addNode} aria-expanded={addOpen} onClick={event => togglePopover('add', event.currentTarget)}><motion.span animate={{ rotate: addOpen ? 45 : 0 }} transition={{ type: 'spring', stiffness: 400, damping: 22 }}><Plus size={20} /></motion.span></button></Tip>
      </div>
      <Tip title={tool === 'select' ? copy.selectTool : copy.panTool}>
        <button type="button" className={btn()} aria-label={tool === 'select' ? copy.selectTool : copy.panTool} onClick={() => onToolChange(tool === 'select' ? 'pan' : 'select')}>
          <AnimatePresence mode="wait" initial={false}>
            {tool === 'select'
              ? <motion.span key="select" initial={{ opacity: 0, rotate: -90 }} animate={{ opacity: 1, rotate: 0 }} exit={{ opacity: 0, rotate: 90 }} transition={{ type: 'spring', stiffness: 400, damping: 25 }}><Focus size={18} /></motion.span>
              : <motion.span key="pan" initial={{ opacity: 0, rotate: -90 }} animate={{ opacity: 1, rotate: 0 }} exit={{ opacity: 0, rotate: 90 }} transition={{ type: 'spring', stiffness: 400, damping: 25 }}><Hand size={18} /></motion.span>}
          </AnimatePresence>
        </button>
      </Tip>
      <div className="workflow-toolbar__popover-wrap">
        <Tip title={copy.tools}><button type="button" className={btn(toolsOpen)} aria-label={copy.tools} aria-expanded={toolsOpen} onClick={event => togglePopover('tools', event.currentTarget)}><SlidersHorizontal size={18} /></button></Tip>
      </div>
      {onOpenTemplates && <Tip title={language === 'en' ? 'Workflow blueprint templates' : '工作流模板库'}><button type="button" className={btn()} data-testid="workflow-toolbar-templates" aria-label={language === 'en' ? 'Workflow blueprint templates' : '工作流模板库'} onClick={() => { closePopover(); onOpenTemplates(); }}><LayoutTemplate size={17} /></button></Tip>}
      <Tip title={copy.generationHistory}><button type="button" className={btn(libraryOpen)} aria-label={copy.generationHistory} aria-expanded={libraryOpen} onClick={event => togglePopover('library', event.currentTarget)}><History size={18} /></button></Tip>
      <Tip title={copy.undo}><button type="button" className={`${btn()} workflow-toolbar__history-direct`} aria-label={copy.undo} disabled={!canUndo} onClick={onUndo}><Undo2 size={17} /></button></Tip>
      <Tip title={copy.redo}><button type="button" className={`${btn()} workflow-toolbar__history-direct`} aria-label={copy.redo} disabled={!canRedo} onClick={onRedo}><Redo2 size={17} /></button></Tip>
      <div className="workflow-toolbar__zoom-wrap">
        <button type="button" className="workflow-canvas-controls__zoom" aria-label={copy.zoomReset} aria-expanded={zoomOpen} onClick={event => togglePopover('zoom', event.currentTarget)}>{copy.zoomPercent(Math.round((zoomLevel ?? 1) * 100))}</button>
      </div>
      {onOpenAgent && <Tip title={agentOpen ? copy.agentClose : copy.agentOpen}><button type="button" className={btn(Boolean(agentOpen))} aria-label={agentOpen ? copy.agentClose : copy.agentOpen} aria-pressed={Boolean(agentOpen)} onClick={() => { closePopover(); onOpenAgent(); }}><Bot size={18} /></button></Tip>}
    </div>
    {activePopover}
    </div>
  );
}
