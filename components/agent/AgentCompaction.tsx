import { useEffect, useState } from 'react';
import { AgentWorkingOrb } from './AgentWorkingOrb';

/** 正在进行 / 刚结束的一次上下文压缩（面板按内核 compaction_start / compaction_end 事件维护）。 */
export interface AgentCompactionLive {
  phase: 'running' | 'done' | 'error';
  reason: 'threshold' | 'overflow' | 'manual' | 'midturn';
  startedAt: number;
  tokensBefore?: number;
  error?: string;
}

type Lang = 'en' | 'zho';

export function compactionTokensLabel(tokens: number | undefined, language: Lang) {
  if (!tokens || tokens <= 0) return '';
  const k = Math.max(1, Math.round(tokens / 1000));
  return language === 'en' ? `~${k}K tokens` : `约 ${k}K tokens`;
}

function liveTitle(live: AgentCompactionLive, language: Lang) {
  const en = language === 'en';
  if (live.phase === 'done') return en ? 'Context compacted' : '上下文已压缩';
  if (live.phase === 'error') return en ? 'Compaction failed' : '压缩失败';
  if (live.reason === 'overflow') return en ? 'Over the limit, compacting context' : '超出上限，正在压缩上下文';
  return en ? 'Compacting context' : '正在压缩上下文';
}

function Elapsed({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  return <>{seconds}s</>;
}

/**
 * 对话末尾的实时压缩状态：和模型运行时同一个奶蛙工作胶囊（AgentWorkingOrb），只换文案与尾部用时；
 * 完成 / 失败时换一次文案（胶囊自带换场动画），随后收起；历史里不留分隔条。
 */
export function AgentCompactionLiveCard({ live, language }: { live: AgentCompactionLive; language: Lang }) {
  const tokens = live.phase === 'done' ? compactionTokensLabel(live.tokensBefore, language) : '';
  const label = live.phase === 'error' && live.error ? `${liveTitle(live, language)}：${live.error}` : liveTitle(live, language);
  return (
    <div className="workflow-agent__working agent-compaction--live" data-phase={live.phase} data-testid="agent-compaction-live">
      <AgentWorkingOrb
        state={live.phase === 'running' ? 'shaping' : 'breathing'}
        label={label}
        meta={live.phase === 'running' ? <Elapsed startedAt={live.startedAt} /> : tokens || undefined}
      />
    </div>
  );
}
