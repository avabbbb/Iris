// 工具调用的步骤卡，参考 Inspora「Sandbox Boot Sequence」（Jeet）的启动清单：
// 每个工具一行——待执行 = 点阵球（20px）/ 完成 = 实心勾 / 失败 = 实心叉，中文工具名 + 一句摘要，右侧等宽用时；
// 当前行带浅色底。连续多个调用叠成一张卡，头部是步骤数、真实状态与总用时。没有进度条：总步数事先未知，不画假进度。
// 原始数据（已脱敏）收在每行的「查看原始数据」里。
import { memo, useEffect, useMemo, useState } from 'react';
import { Check, ChevronRight, X } from 'lucide-react';
import type { WorkflowAgentDisplayMessage } from '../workflow/WorkflowAgentMessages';
import { AgentOrbIcon } from './AgentWorkingOrb';
import { agentWorkingPhase } from './agentWorkingPhase';
import { formatToolDuration, skillReadContent, summarizeToolCall, toolRawText, toolStepsHeadline } from './agentToolSummary';
import '../../styles/agentWorking.css';

type Lang = 'en' | 'zho';

function useTicker(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

function statusText(state: NonNullable<WorkflowAgentDisplayMessage['status']>, live: boolean, language: Lang) {
  const en = language === 'en';
  if (state === 'pending') return live ? (en ? 'Running' : '执行中') : (en ? 'Waiting' : '等待执行');
  if (state === 'success') return en ? 'Completed' : '执行完成';
  if (state === 'denied') return en ? 'Denied' : '已拒绝';
  return en ? 'Failed' : '执行失败';
}

export function AgentToolSteps({ tools, running, language = 'zho' }: { tools: WorkflowAgentDisplayMessage[]; running?: boolean; language?: Lang }) {
  const live = Boolean(running) && tools.some(tool => (tool.status || 'pending') === 'pending');
  const now = useTicker(live);
  const headline = toolStepsHeadline(tools.map(tool => tool.status), Boolean(running), language);
  const starts = tools.map(tool => tool.startedAt).filter((value): value is number => value !== undefined);
  const ends = tools.map(tool => tool.endedAt).filter((value): value is number => value !== undefined);
  const total = starts.length ? (live ? now : Math.max(...ends, ...starts)) - Math.min(...starts) : undefined;
  return (
    <section className="agent-steps" data-tone={headline.tone} data-testid="agent-tool-steps" aria-label={language === 'en' ? 'Tool calls' : '工具调用'}>
      {tools.length > 1 && (
        <header className="agent-steps__head">
          <span className="agent-steps__count">{headline.count}</span>
          <span className="agent-steps__state"><i aria-hidden="true" />{headline.state}</span>
          {total !== undefined && <span className="agent-steps__elapsed">{formatToolDuration(total)}</span>}
        </header>
      )}
      <ol className="agent-steps__list">
        {tools.map(tool => <ToolStep key={tool.id} tool={tool} running={running} now={(tool.status || 'pending') === 'pending' ? now : 0} language={language} single={tools.length === 1} />)}
      </ol>
    </section>
  );
}

const ToolStep = memo(function ToolStep({ tool, running, now, language, single }: { tool: WorkflowAgentDisplayMessage; running?: boolean; now: number; language: Lang; single: boolean }) {
  const state = tool.status || 'pending';
  const live = state === 'pending' && Boolean(running);
  const en = language === 'en';
  // tool-start 时 detail 就是参数；结束后才是结果。快照恢复的卡片只有结果文字（text）。
  const result = tool.detail === tool.args ? undefined : tool.detail ?? (state === 'pending' ? undefined : tool.text);
  const summary = useMemo(
    () => summarizeToolCall({ toolName: tool.toolName, args: tool.args, result, status: state, language }),
    [tool.toolName, tool.args, result, state, language],
  );
  const raw = useMemo(
    () => (tool.args !== undefined || tool.detail !== undefined ? toolRawText(tool.args, tool.detail === tool.args ? undefined : tool.detail, language) : ''),
    [tool.args, tool.detail, language],
  );
  // 技能读取：原文很长，「查看原始数据」会截断，单独给一个可展开的原文。
  const skillText = useMemo(() => (state === 'success' ? skillReadContent(tool.toolName, result) : ''), [tool.toolName, result, state]);
  const summaryText = summary.text || (state === 'pending' ? tool.text : '');
  const orb = live ? agentWorkingPhase({ turnPhase: 'sending', messages: [tool], language }).state : 'working';
  const elapsed = tool.startedAt === undefined ? undefined : (tool.endedAt ?? (live ? now : undefined)) ?? undefined;
  const time = elapsed === undefined || tool.startedAt === undefined ? '' : formatToolDuration(elapsed - tool.startedAt);
  const title = tool.title || (en ? 'Tool call' : '工具调用');

  return (
    <li
      className="agent-step"
      data-status={state}
      data-live={live ? '' : undefined}
      data-testid="agent-tool-card"
      // 画布会话卡的轨迹行据此定位到这次工具调用（实时卡 id 是 tool-<callId>，快照里另带 toolCallId）。
      data-message-id={tool.id}
      data-tool-call-id={tool.toolCallId || (tool.id.startsWith('tool-') ? tool.id.slice(5) : undefined)}
    >
      <div className="agent-step__row">
        <span className="agent-step__icon" aria-hidden="true">
          {live ? <AgentOrbIcon state={orb} size={20} />
            : state === 'success' ? <span className="agent-step__disc"><Check size={11} strokeWidth={3} /></span>
            : state === 'pending' ? <span className="agent-step__disc is-hollow" />
            : <span className="agent-step__disc is-error"><X size={11} strokeWidth={3} /></span>}
        </span>
        <span className="agent-step__main">
          <strong className="agent-step__name" title={tool.toolName && tool.toolName !== title ? tool.toolName : undefined}>{title}</strong>
          {summaryText && <span className="agent-step__summary" title={summaryText}>{summaryText}</span>}
        </span>
        {single && <span className="agent-step__chip">{statusText(state, live, language)}</span>}
        <span className="agent-step__time" aria-label={single ? undefined : statusText(state, live, language)}>
          {time || (live ? <span className="agent-step__dots" aria-hidden="true"><i /><i /><i /></span> : state === 'pending' ? '–' : '')}
        </span>
      </div>
      {summary.thumbnails.length > 0 && (
        <div className="agent-step__thumbs">
          {summary.thumbnails.map((thumb, index) => <img key={index} src={thumb.src} alt={thumb.alt} title={thumb.alt} loading="lazy" />)}
        </div>
      )}
      {skillText && (
        <details className="agent-step__raw" data-testid="agent-skill-content">
          <summary><ChevronRight size={12} aria-hidden="true" />{en ? 'View skill content' : '查看技能内容'}</summary>
          <pre>{skillText}</pre>
        </details>
      )}
      {raw && (
        <details className="agent-step__raw">
          <summary><ChevronRight size={12} aria-hidden="true" />{en ? 'View raw data' : '查看原始数据'}</summary>
          <pre>{raw}</pre>
        </details>
      )}
    </li>
  );
});
