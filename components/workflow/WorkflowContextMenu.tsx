import { BookmarkPlus, CheckSquare, Clapperboard, ClipboardPaste, Copy, CopyPlus, Download, LayoutTemplate, Library, ListOrdered, Lock, Maximize2, Pencil, Pin, Play, Plus, Star, Trash2, Unlock } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { handleMenuKeyDown } from '../../hooks/useListboxKeyboard';
import type { WorkflowAnchorKind, WorkflowNodeColorTag } from './types';

export type WorkflowContextMenuState =
  | { type: 'node'; id: string; x: number; y: number }
  | { type: 'connection'; id: string; x: number; y: number }
  | { type: 'pane'; x: number; y: number };

const COLOR_TAG_SWATCHES: ReadonlyArray<{ id: WorkflowNodeColorTag; color: string; zho: string; en: string }> = [
  { id: 'rose', color: '#e8615a', zho: '珊瑚红', en: 'Rose' },
  { id: 'amber', color: '#f5b91c', zho: '琥珀黄', en: 'Amber' },
  { id: 'mint', color: '#19c8b9', zho: '薄荷绿', en: 'Mint' },
  { id: 'sky', color: '#3b82f6', zho: '天青蓝', en: 'Sky' },
  { id: 'violet', color: '#8b5cf6', zho: '暮光紫', en: 'Violet' },
  { id: 'slate', color: '#64748b', zho: '石板灰', en: 'Slate' },
];

const ANCHOR_OPTIONS: ReadonlyArray<{ kind: WorkflowAnchorKind; zho: string; en: string }> = [
  { kind: 'character', zho: '角色 A', en: 'Char A' },
  { kind: 'scene', zho: '场景 S', en: 'Scene S' },
  { kind: 'product', zho: '道具 P', en: 'Prop P' },
  { kind: 'style', zho: '风格 T', en: 'Style T' },
];

export function WorkflowContextMenu({ state, language = 'zho', count = 1, isLocked = false, isPinned = false, colorTag, onCopy, onDuplicate, onSaveMedia, onDelete, onRun, onSetPrimary, onRunGroup, onDownloadGroup, onSendToCut, onRename, onToggleLock, onTogglePin, onSetColorTag, onPromoteAnchor, onSaveAsTemplate, onOpenTemplates, onPaste, onSelectAll, onAddNode, onFitView, onClose }: {
  state: WorkflowContextMenuState;
  language?: 'en' | 'zho';
  onCopy: () => void;
  onDuplicate?: () => void;
  onSaveMedia?: () => void;
  onDelete: () => void;
  onRun: () => void;
  onSetPrimary?: () => void;
  /** 节点在分组框里（或就是分组框）：按依赖顺序执行组内全部生成节点 */
  onRunGroup?: () => void;
  /** 节点在分组框里：下载组内全部媒体 */
  onDownloadGroup?: () => void;
  /** 图片 / 视频结果节点：追加到 Cut 时间线末尾（引用节点，不复制文件） */
  onSendToCut?: () => void;
  onRename?: () => void;
  isLocked?: boolean;
  isPinned?: boolean;
  colorTag?: WorkflowNodeColorTag;
  onToggleLock?: () => void;
  onTogglePin?: () => void;
  onSetColorTag?: (tag: WorkflowNodeColorTag | undefined) => void;
  onPromoteAnchor?: (kind: WorkflowAnchorKind) => void;
  onSaveAsTemplate?: () => void;
  onOpenTemplates?: () => void;
  count?: number;
  onPaste?: () => void;
  onSelectAll?: () => void;
  onAddNode?: () => void;
  onFitView?: () => void;
  onClose: () => void;
}) {
  const copy = language === 'zho'
    ? { node: '节点菜单', connection: '连接菜单', pane: '画布菜单', copy: '复制', duplicate: '创建副本', save: '保存到我的素材', run: '运行节点', primary: '设为主图', runGroup: '整组执行', downloadGroup: '下载全部', sendToCut: '送进 Cut', rename: '重命名', lock: '锁定节点', unlock: '解锁节点', pin: '钉选节点', unpin: '取消钉选', colorTag: '颜色标签', clearColor: '清除', anchor: '设为一致性锚点', saveTemplate: '保存为可复用模板', openTemplates: '插入工作流模板…', delete: '删除', paste: '粘贴', selectAll: '全选', addNode: '添加节点', fitView: '适应视图' }
    : { node: 'Node menu', connection: 'Connection menu', pane: 'Canvas menu', copy: 'Copy', duplicate: 'Duplicate', save: 'Save to media library', run: 'Run node', primary: 'Set as primary', runGroup: 'Run group', downloadGroup: 'Download all', sendToCut: 'Send to Cut', rename: 'Rename', lock: 'Lock node', unlock: 'Unlock node', pin: 'Pin node', unpin: 'Unpin node', colorTag: 'Color tag', clearColor: 'Clear', anchor: 'Set as Ground Truth Anchor', saveTemplate: 'Save selection as template', openTemplates: 'Insert workflow template…', delete: 'Delete', paste: 'Paste', selectAll: 'Select all', addNode: 'Add node', fitView: 'Fit view' };
  const menuRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const [position, setPosition] = useState({ left: state.x, top: state.y, maxHeight: 480, ready: false });

  useLayoutEffect(() => {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const menu = menuRef.current;
    if (!menu) return;

    const measure = () => {
      const rect = menu.getBoundingClientRect();
      const viewport = window.visualViewport;
      const width = viewport?.width || document.documentElement.clientWidth;
      const height = viewport?.height || document.documentElement.clientHeight;
      const leftInset = viewport?.offsetLeft || 0;
      const topInset = viewport?.offsetTop || 0;
      const edge = 8;
      const menuWidth = rect.width || Math.min(180, width - edge * 2);
      const menuHeight = rect.height || 160;
      const maxHeight = Math.max(96, height - edge * 2);
      const left = Math.max(leftInset + edge, Math.min(state.x, leftInset + width - menuWidth - edge));
      const top = Math.max(topInset + edge, Math.min(state.y, topInset + height - Math.min(menuHeight, maxHeight) - edge));
      setPosition({ left, top, maxHeight, ready: true });
    };

    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(menu);
    window.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('scroll', measure);
    menu.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
      window.visualViewport?.removeEventListener('resize', measure);
      window.visualViewport?.removeEventListener('scroll', measure);
      if (previousFocus.current?.isConnected) previousFocus.current.focus();
    };
  }, [state.x, state.y]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) onClose();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [onClose]);

  // ↑/↓ / Home / End 回绕移动、跳过禁用项、首字母跳转、Esc 关闭（hooks/useListboxKeyboard 的菜单规则）。
  const typeahead = useRef({ text: '', at: 0 });
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (menuRef.current) handleMenuKeyDown(menuRef.current, event, { onClose, typeahead: typeahead.current });
  };

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={copy[state.type]}
      data-workflow-overlay
      data-testid="workflow-context-menu"
      className="workflow-context-menu"
      style={{
        left: position.left,
        top: position.top,
        maxHeight: position.maxHeight,
        visibility: position.ready ? 'visible' : 'hidden',
        '--wf-border': 'var(--border-color)',
        '--wf-strong': 'var(--panel-strong)',
        '--wf-muted': 'var(--text-muted)',
        '--wf-text': 'var(--text-primary)',
      } as CSSProperties}
      onPointerDown={event => event.stopPropagation()}
      onDoubleClick={event => event.stopPropagation()}
      onKeyDown={handleKeyDown}
    >
      {state.type === 'node' && <button type="button" role="menuitem" onClick={onCopy}><Copy size={14} />{copy.copy}</button>}
      {state.type === 'node' && onDuplicate && <button type="button" role="menuitem" onClick={onDuplicate}><CopyPlus size={14} />{copy.duplicate}</button>}
      {state.type === 'node' && onSaveMedia && <button type="button" role="menuitem" onClick={onSaveMedia}><Library size={14} />{copy.save}</button>}
      {state.type === 'node' && onSendToCut && <button type="button" role="menuitem" onClick={onSendToCut} data-testid="wf-ctx-send-to-cut"><Clapperboard size={14} />{copy.sendToCut}</button>}
      {state.type === 'node' && <button type="button" role="menuitem" onClick={onRun}><Play size={14} />{copy.run}</button>}
      {state.type === 'node' && onRunGroup && <button type="button" role="menuitem" onClick={onRunGroup}><ListOrdered size={14} />{copy.runGroup}</button>}
      {state.type === 'node' && onDownloadGroup && <button type="button" role="menuitem" onClick={onDownloadGroup}><Download size={14} />{copy.downloadGroup}</button>}
      {state.type === 'node' && onSetPrimary && <button type="button" role="menuitem" onClick={onSetPrimary}><Star size={14} />{copy.primary}</button>}
      {state.type === 'node' && onRename && <button type="button" role="menuitem" onClick={onRename}><Pencil size={14} />{copy.rename}</button>}
      {state.type === 'node' && onTogglePin && <button type="button" role="menuitem" data-testid="wf-ctx-pin" onClick={onTogglePin}><Pin size={14} />{isPinned ? copy.unpin : copy.pin}</button>}
      {state.type === 'node' && onToggleLock && <button type="button" role="menuitem" data-testid="wf-ctx-lock" onClick={onToggleLock}>{isLocked ? <Unlock size={14} /> : <Lock size={14} />}{isLocked ? copy.unlock : copy.lock}</button>}
      {state.type === 'node' && onSaveAsTemplate && <button type="button" role="menuitem" data-testid="wf-ctx-save-template" onClick={onSaveAsTemplate}><BookmarkPlus size={14} />{copy.saveTemplate}</button>}
      {state.type === 'node' && onSetColorTag && (
        <div className="wf-ctx-color-group" role="group" aria-label={copy.colorTag}>
          <div className="wf-ctx-section-label">{copy.colorTag}</div>
          <div className="wf-ctx-color-row">
            {COLOR_TAG_SWATCHES.map(swatch => (
              <button
                key={swatch.id}
                type="button"
                className={`wf-ctx-color-dot${colorTag === swatch.id ? ' is-active' : ''}`}
                style={{ backgroundColor: swatch.color }}
                title={language === 'en' ? swatch.en : swatch.zho}
                aria-label={language === 'en' ? swatch.en : swatch.zho}
                onClick={() => onSetColorTag(colorTag === swatch.id ? undefined : swatch.id)}
              />
            ))}
            {colorTag && (
              <button type="button" className="wf-ctx-anchor-btn" onClick={() => onSetColorTag(undefined)}>{copy.clearColor}</button>
            )}
          </div>
        </div>
      )}
      {state.type === 'node' && onPromoteAnchor && (
        <div role="group" aria-label={copy.anchor}>
          <div className="wf-ctx-section-label">{copy.anchor}</div>
          <div className="wf-ctx-anchor-row">
            {ANCHOR_OPTIONS.map(option => (
              <button key={option.kind} type="button" className="wf-ctx-anchor-btn" data-testid={`wf-ctx-anchor-${option.kind}`} onClick={() => onPromoteAnchor(option.kind)}>
                {language === 'en' ? option.en : option.zho}
              </button>
            ))}
          </div>
        </div>
      )}
      {state.type === 'pane' && onAddNode && <button type="button" role="menuitem" onClick={onAddNode}><Plus size={14} />{copy.addNode}</button>}
      {state.type === 'pane' && onOpenTemplates && <button type="button" role="menuitem" data-testid="wf-ctx-open-templates" onClick={onOpenTemplates}><LayoutTemplate size={14} />{copy.openTemplates}</button>}
      {state.type === 'pane' && onPaste && <button type="button" role="menuitem" onClick={onPaste}><ClipboardPaste size={14} />{copy.paste}</button>}
      {state.type === 'pane' && onSelectAll && <button type="button" role="menuitem" onClick={onSelectAll}><CheckSquare size={14} />{copy.selectAll}</button>}
      {state.type === 'pane' && onFitView && <button type="button" role="menuitem" onClick={onFitView}><Maximize2 size={14} />{copy.fitView}</button>}
      {state.type !== 'pane' && <button type="button" role="menuitem" className="is-danger" onClick={onDelete}><Trash2 size={14} />{copy.delete}{count > 1 ? ' (' + count + ')' : ''}</button>}
    </div>,
    document.body,
  );
}
