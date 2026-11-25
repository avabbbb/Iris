import { Eye, EyeOff, Folder, FolderOpen, GripVertical, Image, Layers, Maximize2, Music, PanelLeftClose, Pencil, SlidersHorizontal, Sparkles, Type, Video, X } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import type { WorkflowNode, WorkflowProject } from './types';
import { AssetLibraryBrowser } from '../studio/AssetLibraryBrowser';
import { LocalFolderBrowser } from './LocalFolderBrowser';
import { useStudioHubStore } from '../../stores/useStudioHubStore';
import { STUDIO_HUB_COPY } from '../studio/studioHubCopy';
import type { LocalFolderEntry } from '../../services/localFolderSource';
import type { AssetItem, AssetLibrary } from '../../types';
import { useWorkflowMediaUrl } from './media';

export interface WorkflowSidebarProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  outerGap: number;
  project: WorkflowProject | null;
  onProjectChange: (patch: Partial<WorkflowProject>) => void;
  // 资产 tab 数据
  language: 'en' | 'zho';
  assetLibrary: AssetLibrary;
  onInsertAsset?: (item: AssetItem) => void;
  onRenameAsset: (id: string, name: string) => void;
  onRemoveAsset: (id: string) => void;
  onUpdateAssetTags?: (id: string, tags: string[]) => void;
  onRemoveAssetFromFolder?: (itemId: string, folderId: string) => void;
  onBatchRemoveAssets?: (ids: string[]) => void;
  onBatchAddAssetsToFolder?: (ids: string[], folderId: string) => void;
  onBatchAddAssetTags?: (ids: string[], tags: string[]) => void;
  onReverseAsset?: (item: AssetItem) => void;
  onCreateFolder: (parentId: string | null, name: string) => void;
  onRenameFolder: (id: string, name: string) => void;
  onRemoveFolder: (id: string, deleteItems: boolean) => void;
  /** 本地文件夹直读：只把用户选中的条目放进画布。 */
  onInsertLocalFolderEntries?: (entries: LocalFolderEntry[]) => void | Promise<void>;
  tabRequest?: { tab: SidebarTab; nonce: number };
  /** 图层点击后让画布聚焦到该节点（select+reveal 一体，避免选中画布外节点不可见）。 */
  onFocusNode?: (nodeId: string) => void;
  /**
   * Docked = 常驻侧栏参与 flex 布局、画布为之让位，也不再有点外部自动收起；
   * 默认（false）维持旧的 transient 浮层行为（窄视口下仍然覆盖画布）。
   */
  docked?: boolean;
}

type SidebarTab = 'layers' | 'assets' | 'localFolder';

const nodeIcon = (node: WorkflowNode) => {
  if (node.type === 'image') return <Image size={14} />;
  if (node.type === 'video') return <Video size={14} />;
  if (node.type === 'audio') return <Music size={14} />;
  if (node.type === 'config') return <SlidersHorizontal size={14} />;
  if (node.type === 'plugin:agent-session') return <Sparkles size={14} />;
  return <Type size={14} />;
};

export const WorkflowSidebar: React.FC<WorkflowSidebarProps> = ({
  open,
  onOpenChange,
  outerGap,
  project,
  onProjectChange,
  language,
  assetLibrary,
  onInsertAsset,
  onRenameAsset,
  onRemoveAsset,
  onUpdateAssetTags,
  onRemoveAssetFromFolder,
  onBatchRemoveAssets,
  onBatchAddAssetsToFolder,
  onBatchAddAssetTags,
  onReverseAsset,
  onCreateFolder,
  onRenameFolder,
  onRemoveFolder,
  onInsertLocalFolderEntries,
  tabRequest,
  onFocusNode,
  docked = false,
}) => {
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [tab, setTab] = useState<SidebarTab>('layers');
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (tabRequest) setTab(tabRequest.tab);
  }, [tabRequest]);

  // 点外部收起：仅 transient 浮层模式需要；docked 常驻侧栏不自动收起。
  useEffect(() => {
    if (!open || docked) return;
    const onClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (panelRef.current && !panelRef.current.contains(target) && triggerRef.current && !triggerRef.current.contains(target)) {
        onOpenChange(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [docked, open, onOpenChange]);

  const patchNode = (id: string, patch: Partial<WorkflowNode>) => {
    if (!project) return;
    onProjectChange({
      nodes: project.nodes.map(node => node.id === id ? { ...node, ...patch } : node),
      updatedAt: new Date().toISOString(),
    });
  };

  type LayerDropZone = 'above' | 'below';
  const [dropHint, setDropHint] = useState<{ id: string; zone: LayerDropZone } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  // 行高为 0（如测试环境无布局）时沿用旧行为：放到目标上方（数组中目标之后）。
  const dropZoneOf = (event: React.DragEvent<HTMLElement>): LayerDropZone => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.height) return 'above';
    return (event.clientY - rect.top) / rect.height < 0.5 ? 'above' : 'below';
  };

  const reorder = (targetId: string, zone: LayerDropZone = 'above') => {
    const sourceId = draggedId;
    setDraggedId(null);
    setDropHint(null);
    if (!project || !sourceId || sourceId === targetId) return;
    const nodes = [...project.nodes];
    const from = nodes.findIndex(node => node.id === sourceId);
    if (from < 0) return;
    const [moved] = nodes.splice(from, 1);
    const target = nodes.findIndex(node => node.id === targetId);
    if (target < 0) return;
    // 列表倒序展示：视觉“上方”= 数组中更靠后（更高层级）。
    nodes.splice(zone === 'above' ? target + 1 : target, 0, moved);
    if (nodes.every((node, index) => node === project.nodes[index])) return;
    onProjectChange({ nodes, updatedAt: new Date().toISOString() });
  };

  const commitRename = (id: string, value: string) => {
    setEditingId(null);
    const title = value.trim();
    const node = project?.nodes.find(item => item.id === id);
    if (!node || !title || title === node.title) return;
    patchNode(id, { title });
  };

  return (
    <>
      {/* 左侧触发按钮：折叠态，让出浮动顶栏 */}
      <button
        ref={triggerRef}
        type="button"
        className="isl-icon-btn theme-aware absolute z-40 h-10 w-10"
        style={{ left: outerGap, top: `calc(var(--topbar-h, 0px) + ${outerGap}px)`, opacity: open ? 0 : 1, pointerEvents: open ? 'none' : 'auto' }}
        onClick={() => onOpenChange(true)}
        title="打开图层与资产"
        aria-label="打开图层与资产"
      >
        <PanelLeftClose size={18} className="rotate-180" />
      </button>

      {/* 弹出浮层 / 常驻侧栏 */}
      {open && (
        <aside
          ref={panelRef}
          data-docked={docked ? 'true' : undefined}
          className={`workflow-sidebar theme-aware flv-glass ${docked ? 'relative self-stretch' : 'absolute'} z-40 flex min-w-0 flex-col overflow-hidden`}
          style={docked ? {
            // In-flow dock，但视觉与右侧 Agent 面板一致：内缩 8px 的悬浮玻璃圆角卡
            // （样式见 styles/glass.css .workflow-sidebar[data-docked]）。
            flex: '0 0 auto',
            width: `clamp(200px, 19vw, 300px)`,
          } : {
            // 顶栏浮在画布上，浮层从顶栏下沿开始（--topbar-h 由 AppShell 量出）
            top: `calc(var(--topbar-h, 0px) + ${outerGap}px)`,
            left: outerGap,
            bottom: outerGap,
            width: `clamp(200px, 19vw, 300px)`,
          }}
        >
          {/* tab 切换 */}
          <div className="wf-sidebar-tabs flex min-w-0 shrink-0 items-center gap-1 px-3 pt-3 pb-2">
            <button
              type="button"
              data-testid="sidebar-tab-layers" data-active={tab === 'layers' ? 'true' : undefined} title={language === 'zho' ? '图层' : 'Layers'} aria-label={language === 'zho' ? '图层' : 'Layers'}
              onClick={() => setTab('layers')}
              className="wf-sidebar-tab flex min-w-0 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-1.5 py-1.5 text-[11px] font-bold transition"
              style={{
                background: tab === 'layers' ? 'var(--isl-surface-2)' : 'transparent',
                color: tab === 'layers' ? 'var(--isl-ink)' : 'var(--isl-ink-soft)',
              }}
            >
              <Layers size={13} />
              <span className="wf-sidebar-tab__label">{language === 'zho' ? '图层' : 'Layers'}</span>
              {Boolean(project?.nodes.length) && <span className="text-[10px] tabular-nums opacity-70">{project?.nodes.length}</span>}
            </button>
            <button
              type="button"
              data-testid="sidebar-tab-assets" data-active={tab === 'assets' ? 'true' : undefined} title={language === 'zho' ? '资产' : 'Assets'} aria-label={language === 'zho' ? '资产' : 'Assets'}
              onClick={() => setTab('assets')}
              className="wf-sidebar-tab flex min-w-0 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-1.5 py-1.5 text-[11px] font-bold transition"
              style={{
                background: tab === 'assets' ? 'var(--isl-surface-2)' : 'transparent',
                color: tab === 'assets' ? 'var(--isl-ink)' : 'var(--isl-ink-soft)',
              }}
            >
              <Folder size={13} />
              <span className="wf-sidebar-tab__label">{language === 'zho' ? '资产' : 'Assets'}</span>
            </button>
            <button
              type="button"
              data-testid="sidebar-tab-local-folder" data-active={tab === 'localFolder' ? 'true' : undefined} title={language === 'zho' ? '本地' : 'Local'} aria-label={language === 'zho' ? '本地' : 'Local'}
              onClick={() => setTab('localFolder')}
              className="wf-sidebar-tab flex min-w-0 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-1.5 py-1.5 text-[11px] font-bold transition"
              style={{
                background: tab === 'localFolder' ? 'var(--isl-surface-2)' : 'transparent',
                color: tab === 'localFolder' ? 'var(--isl-ink)' : 'var(--isl-ink-soft)',
              }}
            >
              <FolderOpen size={13} />
              <span className="wf-sidebar-tab__label">{language === 'zho' ? '本地' : 'Local'}</span>
            </button>
            <button type="button" className="isl-icon-btn h-8 w-8 shrink-0" onClick={() => onOpenChange(false)} title={language === 'zho' ? '收起' : 'Close'} aria-label={language === 'zho' ? '收起' : 'Close'}>
              <X size={16} />
            </button>
          </div>

          <div className="flex min-h-0 flex-1 flex-col">
            {tab === 'layers' ? (
              <div className="min-h-0 flex-1 overflow-auto px-2 pb-2 pt-1">
        {project && !project.nodes.length && <p className="px-2 py-6 text-center text-xs" style={{ color: 'var(--isl-ink-soft)' }}>{language === 'zho' ? '还没有节点。双击画布空白处添加。' : 'No nodes yet. Double-click the canvas to add one.'}</p>}
                {[...(project?.nodes || [])].reverse().map(node => {
                  const selected = Boolean(project?.selectedNodeIds.includes(node.id));
                  return (
                    <div
                      key={node.id}
                      draggable={editingId !== node.id}
                      data-drop={dropHint && dropHint.id === node.id ? dropHint.zone : undefined}
                      data-off={node.isVisible === false ? 'true' : undefined}
                      onDragStart={event => { event.dataTransfer.setData('text/plain', node.id); event.dataTransfer.effectAllowed = 'move'; setDraggedId(node.id); }}
                      onDragOver={event => {
                        event.preventDefault();
                        if (!draggedId || draggedId === node.id) return;
                        const zone = dropZoneOf(event);
                        setDropHint(hint => hint?.id === node.id && hint.zone === zone ? hint : { id: node.id, zone });
                      }}
                      onDragLeave={() => setDropHint(hint => hint?.id === node.id ? null : hint)}
                      onDrop={event => { event.preventDefault(); reorder(node.id, dropZoneOf(event)); }}
                      onDragEnd={() => { setDraggedId(null); setDropHint(null); }}
                      onDoubleClick={event => {
                        event.stopPropagation();
                        if (!project) return;
                        if (onFocusNode) onFocusNode(node.id);
                        else onProjectChange({ selectedNodeIds: [node.id] });
                      }}
                      onClick={() => {
                        if (!project) return;
                        onProjectChange({ selectedNodeIds: [node.id] });
                      }}
                      className={`workflow-layer-card group mb-0.5 flex h-11 items-center gap-2 rounded-lg pl-1 pr-1.5 text-xs transition-colors duration-150 ${selected ? 'workflow-layer-card--selected' : ''}`}
                      style={{ color: 'var(--isl-ink)' }}
                      title={node.title}
                    >
                      <span className="workflow-layer-card__handle shrink-0 cursor-grab" style={{ color: 'var(--isl-ink-soft)' }}>
                        <GripVertical size={13} />
                      </span>
                      <LayerThumb node={node} />
                      {editingId === node.id ? (
                        <input
                          className="workflow-layer-card__input min-w-0 flex-1"
                          autoFocus
                          defaultValue={node.title}
                          aria-label={language === 'zho' ? '重命名图层' : 'Rename layer'}
                          onClick={event => event.stopPropagation()}
                          onDoubleClick={event => event.stopPropagation()}
                          onFocus={event => event.currentTarget.select()}
                          onBlur={event => { if (event.currentTarget.dataset.cancel === 'true') setEditingId(null); else commitRename(node.id, event.currentTarget.value); }}
                          onKeyDown={event => {
                            event.stopPropagation();
                            if (event.key === 'Enter') event.currentTarget.blur();
                            if (event.key === 'Escape') { event.currentTarget.dataset.cancel = 'true'; event.currentTarget.blur(); }
                          }}
                        />
                      ) : (
                        <span className="workflow-layer-card__name min-w-0 flex-1 truncate">{node.title}</span>
                      )}
                      <button
                        type="button"
                        className="workflow-layer-card__action shrink-0 rounded p-0.5 transition-opacity"
                        onClick={event => { event.stopPropagation(); patchNode(node.id, { isVisible: node.isVisible === false }); }}
                        title={node.isVisible === false ? (language === 'zho' ? '显示' : 'Show') : (language === 'zho' ? '隐藏' : 'Hide')}
                      >
                        {node.isVisible === false ? <EyeOff size={13} /> : <Eye size={13} />}
                      </button>
                      <button
                        type="button"
                        className="workflow-layer-card__action shrink-0 rounded p-0.5 transition-opacity"
                        onClick={event => { event.stopPropagation(); setEditingId(node.id); }}
                        onDoubleClick={event => event.stopPropagation()}
                        title={language === 'zho' ? '重命名' : 'Rename'}
                        aria-label={language === 'zho' ? '重命名图层' : 'Rename layer'}
                      >
                        <Pencil size={13} />
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : tab === 'assets' ? (
              <div className="min-h-0 flex-1">
                <AssetLibraryBrowser
                  compact
                  library={assetLibrary}
                  language={language}
                  onInsert={onInsertAsset}
                  onRenameAsset={onRenameAsset}
                  onRemoveAsset={onRemoveAsset}
                  onUpdateAssetTags={onUpdateAssetTags}
                  onRemoveAssetFromFolder={onRemoveAssetFromFolder}
                  onBatchRemoveAssets={onBatchRemoveAssets}
                  onBatchAddAssetsToFolder={onBatchAddAssetsToFolder}
                  onBatchAddAssetTags={onBatchAddAssetTags}
                  onReversePrompt={onReverseAsset}
                  onCreateFolder={onCreateFolder}
                  onRenameFolder={onRenameFolder}
                  onRemoveFolder={onRemoveFolder}
                />
              </div>
            ) : (
              <div className="min-h-0 flex-1 overflow-auto">
                <div className="flex justify-end px-2 pt-1">
                  <button type="button" className="isl-icon-btn flex h-7 items-center gap-1 px-2 text-[11px]" title={STUDIO_HUB_COPY[language].openLarge} onClick={() => useStudioHubStore.getState().openHub('library')}>
                    <Maximize2 size={12} aria-hidden="true" /><span>{STUDIO_HUB_COPY[language].expand}</span>
                  </button>
                </div>
                <LocalFolderBrowser language={language} onInsert={entries => onInsertLocalFolderEntries?.(entries)} />
              </div>
            )}
          </div>
        </aside>
      )}
    </>
  );
};

/** 图层缩略图：图片/视频显示真实画面，其余类型显示类型图标。 */
function LayerThumb({ node }: { node: WorkflowNode }) {
  const { url } = useWorkflowMediaUrl(node.metadata.storageKey, node.metadata.href);
  if (node.type === 'image' && url) return <img className="workflow-layer-card__thumb" src={url} alt="" draggable={false} />;
  if (node.type === 'video' && url) return <video className="workflow-layer-card__thumb" src={`${url}#t=0.1`} muted playsInline preload="metadata" />;
  return <span className="workflow-layer-card__thumb workflow-layer-card__thumb--icon">{nodeIcon(node)}</span>;
}
