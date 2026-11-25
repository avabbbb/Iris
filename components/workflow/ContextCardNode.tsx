// plugin:context-card 的节点外观：标题行、定稿正文（约 6 行，超出渐隐）、来源缩略条与缺失 / 更新提示、
// 尾行「定稿时间 · 版本 · 来源数」+「继续讨论」和显式「编辑 → 保存新版本」。
// 悬停卡片时高亮来源节点（选中高亮由 WorkflowNode 负责）；不画 Context 连线，也不显示连线手柄。
import { useLayoutEffect, useRef, useState } from 'react';
import { ImageOff, MessageSquare, Pencil, Pin, RefreshCw } from 'lucide-react';
import { installWorkflowNodePlugin, workflowNodePluginRegistry, type NodePluginRenderProps, type WorkflowNodePluginDefinition } from './nodePluginSdk';
import { CONTEXT_CARD_PLUGIN_ID, CONTEXT_CARD_TYPE, contextCardSourceStates, saveContextCardEdit } from './contextCard';
import { setContextCardHighlight } from './contextCardHighlight';
import { requestWorkflowAgentDrawer } from './agentDrawerRequest';
import { pushAgentDiscussion } from '../../stores/useAgentGroupInboxStore';
import { AgentMediaTiles } from '../agent/AgentMediaTiles';
import type { AgentMessageReference } from '../agent/agentMessageRefs';
import type { WorkflowNode } from './types';

function stop(event: { stopPropagation(): void }) {
  event.stopPropagation();
}

/** 卡片底部的来源摘要：「3 个来源 · 1 个不可用 · 1 个来源已更新」。 */
export function contextCardSourceSummary(node: Pick<WorkflowNode, 'metadata'>, nodes: readonly WorkflowNode[]): { count: number; hints: string[] } {
  const { sources, missing, updated } = contextCardSourceStates(node, nodes);
  return {
    count: sources.length,
    hints: [missing ? `${missing} 个不可用` : '', updated ? `${updated} 个来源已更新` : ''].filter(Boolean),
  };
}

/** 定稿时间：本地时区 MM-DD HH:mm。 */
export function formatContextCardTime(iso: string | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 正文超出卡片时才加底部渐隐。 */
function useOverflow(deps: unknown[]) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [overflow, setOverflow] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setOverflow(element.scrollHeight - element.clientHeight > 2);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, deps);
  return { ref, overflow };
}

export function ContextCardSurface({ node, context }: NodePluginRenderProps) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(node.title);
  const [body, setBody] = useState(node.metadata.content || '');
  const [error, setError] = useState('');
  const content = node.metadata.content || '';
  const { ref: bodyRef, overflow } = useOverflow([content, node.height, editing]);
  const nodes = context.getNodes();
  const { sources, missing, updated } = contextCardSourceStates(node, nodes);
  const sourceIds = sources.filter(source => source.kind === 'node' && source.state !== 'missing').map(source => source.id);
  const hoverKey = node.id + ':hover';
  const version = (node.metadata.contextCard?.history?.length || 0) + 1;
  const committedAt = formatContextCardTime(node.metadata.contextCard?.committedAt);
  const tiles: AgentMessageReference[] = sources.map(source => ({ kind: source.kind, id: source.id, label: source.label, ...(source.fingerprintAtCommit ? { fingerprint: source.fingerprintAtCommit } : {}) }));

  const startEdit = () => {
    setTitle(node.title);
    setBody(content);
    setError('');
    setEditing(true);
  };
  const save = async () => {
    const result = await saveContextCardEdit({ projectId: context.projectId, nodeId: node.id, title, body });
    if (result.ok === false) setError(result.error);
    else setEditing(false);
  };
  const continueDiscussion = () => {
    pushAgentDiscussion({ projectId: context.projectId, cardNodeId: node.id });
    requestWorkflowAgentDrawer();
  };

  if (editing) {
    return <div className="workflow-node__plugin-card context-card is-editing" data-testid="context-card-editor" data-workflow-overlay onPointerDown={stop} onKeyDown={stop}>
      <input className="context-card__field context-card__field--title" aria-label="卡片标题" value={title} maxLength={80} onChange={event => setTitle(event.target.value)} />
      <textarea className="context-card__field context-card__field--body" aria-label="卡片正文" value={body} onChange={event => setBody(event.target.value)} />
      {error && <span className="context-card__error" role="alert">{error}</span>}
      <div className="context-card__edit-actions">
        <button type="button" className="context-card__btn is-ghost" onClick={() => setEditing(false)}>取消</button>
        <button type="button" className="isl-go context-card__save" disabled={!title.trim() || !body.trim()} onClick={() => void save()}>保存新版本</button>
      </div>
    </div>;
  }

  const sourceTitle = sources.map(source => source.label + (source.state === 'missing' ? '（不可用）' : source.state === 'updated' ? '（来源已更新）' : '')).join('\n');
  return <div
    className="workflow-node__plugin-card context-card"
    data-testid="context-card"
    data-source-state={missing ? 'missing' : updated ? 'updated' : 'ok'}
    onPointerEnter={() => setContextCardHighlight(hoverKey, sourceIds)}
    onPointerLeave={() => setContextCardHighlight(hoverKey, null)}
  >
    <div className="context-card__head">
      <Pin className="context-card__pin" size={13} aria-hidden="true" />
      <strong className="context-card__title" title={node.title}>{node.title}</strong>
    </div>
    <p ref={bodyRef} className="context-card__body" data-overflow={overflow ? '' : undefined}>{content}</p>
    {(tiles.length > 0) && <div className="context-card__sources">
      <AgentMediaTiles refs={tiles} nodes={nodes} max={6} compact testId="context-card-sources" />
      {missing > 0 && <span className="context-card__hint" data-state="missing"><ImageOff size={11} aria-hidden="true" />{missing} 个不可用</span>}
      {updated > 0 && <span className="context-card__hint" data-state="updated"><RefreshCw size={11} aria-hidden="true" />{updated} 个来源已更新</span>}
    </div>}
    <div className="context-card__foot">
      <span className="context-card__meta">
        {committedAt && <span>定稿 {committedAt}</span>}
        <span>v{version}</span>
        <span data-testid="context-card-source-count" title={sourceTitle}>{sources.length} 个来源</span>
      </span>
      <span className="context-card__actions" data-workflow-overlay onPointerDown={stop}>
        <button type="button" className="context-card__btn" onClick={continueDiscussion}><MessageSquare size={12} aria-hidden="true" />继续讨论</button>
        <button type="button" className="context-card__btn is-icon" aria-label="编辑卡片" title="编辑卡片" onClick={startEdit}><Pencil size={12} aria-hidden="true" /></button>
      </span>
    </div>
  </div>;
}

export const contextCardPlugin: WorkflowNodePluginDefinition = {
  pluginId: CONTEXT_CARD_PLUGIN_ID,
  type: CONTEXT_CARD_TYPE,
  version: '1.0.0',
  title: 'Context Card',
  description: '用户 Commit 的创作结论；作为上下文阅读，不参与执行连线。',
  // 卡片是结论文本，可作为文本资源被读取；不声明输入：Context 关系不走 Workflow 连线。
  outputs: node => {
    const text = (node.metadata.content || '').trim();
    return text ? [{ resourceId: `${node.id}:output:0`, title: node.title, kind: 'text', locator: { kind: 'inline-text', text } }] : [];
  },
  render: props => <ContextCardSurface {...props} />,
};

export function installContextCardPlugin() {
  const existing = workflowNodePluginRegistry.list().find(item => item.pluginId === CONTEXT_CARD_PLUGIN_ID);
  return existing ?? installWorkflowNodePlugin(contextCardPlugin);
}

installContextCardPlugin();
