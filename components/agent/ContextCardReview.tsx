// 「钉到画布」的审查步骤：可改标题与正文、看见（并可移除）来源，明确点主按钮「钉到画布」（Commit）才创建 Context Card。
// 版式：头 / 可滚动正文 / 常驻尾栏，尾栏在 600–900px 高的抽屉里始终可见。
import { useLayoutEffect, useRef, useState } from 'react';
import { Pin } from 'lucide-react';
import { AgentMediaTiles } from './AgentMediaTiles';
import type { AgentMessageReference } from './agentMessageRefs';
import type { WorkflowNode } from '../workflow/types';
import { AgentCardHead, AgentCardShell } from './AgentCardShell';

export interface ContextCardReviewDraft {
  messageId: string;
  title: string;
  body: string;
  sources: AgentMessageReference[];
}

/** 默认标题：回复第一行去掉 Markdown 标记，最多 24 字。 */
export function defaultContextCardTitle(text: string): string {
  const line = String(text || '').split('\n').map(item => item.replace(/^[#>*\-\d.\s`]+/, '').replace(/[*_`]/g, '').trim()).find(Boolean) || '创作结论';
  return line.length > 24 ? line.slice(0, 24) + '…' : line;
}

export function ContextCardReview({ draft, nodes, language = 'zho', busy, error, onCommit, onCancel }: {
  draft: ContextCardReviewDraft;
  nodes?: readonly WorkflowNode[];
  language?: 'en' | 'zho';
  busy?: boolean;
  error?: string;
  onCommit: (result: { title: string; body: string; sources: AgentMessageReference[] }) => void;
  onCancel: () => void;
}) {
  const en = language === 'en';
  const [title, setTitle] = useState(draft.title);
  const [body, setBody] = useState(draft.body);
  const [sources, setSources] = useState(draft.sources);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const canCommit = Boolean(title.trim() && body.trim()) && !busy;
  // 正文随内容长高（最多约 8 行，之后在框内滚动）。
  useLayoutEffect(() => {
    const element = bodyRef.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = element.scrollHeight + 2 + 'px';
  }, [body]);
  const pinLabel = en ? 'Pin to canvas' : '钉到画布';
  return (
    <AgentCardShell className="agent-context-card-review" role="dialog" aria-label={pinLabel} data-testid="context-card-review">
      <AgentCardHead icon={<Pin />} accent="approve" label={pinLabel} onClose={onCancel} closeLabel={en ? 'Cancel' : '取消'} />
      <div className="agent-context-card-review__body">
        <input
          className="agent-context-card-review__title"
          aria-label={en ? 'Title' : '标题'}
          placeholder={en ? 'Card title' : '卡片标题'}
          value={title}
          maxLength={80}
          onChange={event => setTitle(event.target.value)}
        />
        <textarea
          ref={bodyRef}
          className="agent-context-card-review__text"
          aria-label={en ? 'Conclusion' : '结论'}
          placeholder={en ? 'The conclusion to keep' : '要留在画布上的结论'}
          value={body}
          rows={3}
          onChange={event => setBody(event.target.value)}
        />
        <div className="agent-context-card-review__sources">
          <span className="agent-context-card-review__label">{sources.length ? (en ? `Sources · ${sources.length}` : `来源 · ${sources.length}`) : (en ? 'No sources' : '没有来源')}</span>
          <AgentMediaTiles refs={sources} nodes={nodes} language={language} onRemove={ref => setSources(list => list.filter(item => !(item.kind === ref.kind && item.id === ref.id && item.label === ref.label)))} testId="context-card-review-sources" />
        </div>
        {error && <p role="alert" className="agent-context-card-review__error">{error}</p>}
      </div>
      <footer className="agent-context-card-review__foot">
        <span className="agent-context-card-review__hint">{en ? 'Final once pinned; later chat won\'t change it' : '钉上后定稿，后续聊天不会改动它'}</span>
        <button type="button" className="agent-context-card-review__cancel" onClick={onCancel}>{en ? 'Cancel' : '取消'}</button>
        <button type="button" className="isl-go agent-context-card-review__commit" data-testid="context-card-review-commit" disabled={!canCommit} onClick={() => onCommit({ title, body, sources })}>{pinLabel}</button>
      </footer>
    </AgentCardShell>
  );
}
