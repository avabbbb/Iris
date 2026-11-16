import { Minimize2, RefreshCw, TriangleAlert } from 'lucide-react';
import { translations } from '../../utils/translations';

/** 面板上「已压缩」卡片的数据：来自快照里的压缩记录，或压缩进行中的实时事件。 */
export interface AgentCompactionInfo {
  tokensBefore: number;
  tokensAfter?: number;
  focus?: string;
  reason?: 'threshold' | 'overflow' | 'manual' | 'midturn';
  /** 正在生成摘要。 */
  pending?: boolean;
  /** 压缩失败的说明。 */
  error?: string;
}

/** token 数换成整数 K（不足 1K 显示 1K，避免出现「0K」）。 */
export function compactionK(tokens: number): number {
  return tokens > 0 ? Math.max(1, Math.round(tokens / 1000)) : 0;
}

/** 卡片上的 token 行：有前后两个数时显示「约 120K → 18K tokens」。 */
export function compactionTokensLine(info: Pick<AgentCompactionInfo, 'tokensBefore' | 'tokensAfter'>, language: 'en' | 'zho'): string {
  const copy = translations[language].agentPanel;
  const before = compactionK(info.tokensBefore);
  const after = compactionK(info.tokensAfter || 0);
  if (before && after) return copy.compactCardTokens(before, after);
  if (before) return copy.compactCardTokensBefore(before);
  return '';
}

export function AgentCompactionCard({ info, language }: { info: AgentCompactionInfo; language: 'en' | 'zho' }) {
  const copy = translations[language].agentPanel;
  const state = info.error ? 'error' : info.pending ? 'pending' : 'done';
  const title = info.error ? copy.compactCardFailed : info.pending ? copy.compactCardPending : copy.compactCardTitle;
  const reason = info.reason === 'threshold' ? copy.compactCardAuto
    : info.reason === 'midturn' ? copy.compactCardMidTurn
      : info.reason === 'overflow' ? copy.compactCardOverflow
        : '';
  const tokens = state === 'done' ? compactionTokensLine(info, language) : '';
  const ratio = state === 'done' && info.tokensBefore > 0 && info.tokensAfter
    ? Math.max(4, Math.min(100, Math.round((info.tokensAfter / info.tokensBefore) * 100)))
    : null;
  return (
    <div className={`agent-compaction-card is-${state}`} role="status" data-testid="agent-compaction-card">
      <span className="agent-compaction-card__icon" aria-hidden="true">
        {state === 'error' ? <TriangleAlert size={14} /> : state === 'pending' ? <RefreshCw size={14} className="is-spinning" /> : <Minimize2 size={14} />}
      </span>
      <div className="agent-compaction-card__body">
        <div className="agent-compaction-card__head">
          <strong>{title}</strong>
          {reason && <em>{reason}</em>}
          {tokens && <span className="agent-compaction-card__tokens">{tokens}</span>}
        </div>
        {ratio !== null && (
          <div className="agent-compaction-card__meter" aria-hidden="true"><i style={{ width: `${ratio}%` }} /></div>
        )}
        {info.focus && <p className="agent-compaction-card__focus"><b>{copy.compactCardFocus}</b>{info.focus}</p>}
        {state === 'error' ? <small>{info.error}</small> : state === 'done' ? <small>{copy.compactCardKept}</small> : null}
      </div>
    </div>
  );
}
