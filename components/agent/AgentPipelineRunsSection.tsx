import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Clapperboard, LayoutGrid, RefreshCw } from 'lucide-react';
import { getManagedAgentConnection } from '../../services/managedAgentConnection';
import {
  decidePipelineApproval,
  fetchPipelineApprovals,
  fetchPipelineArtifact,
  fetchPipelineRuns,
  fetchPipelineTrace,
  pickVersionRenders,
  type PipelineApproval,
  type PipelineRunSummary,
  type PipelineTrace,
} from '../../services/pipelineRuns';
import { useAgentConnectionStore } from '../../stores/useAgentConnectionStore';

type Lang = 'en' | 'zho';

const STATUS_LABELS: Record<string, [string, string, string]> = {
  active: ['进行中', 'Active', 'var(--isl-ink-soft)'],
  blocked: ['已阻塞', 'Blocked', 'var(--isl-coral-deep)'],
  passed: ['已通过', 'Passed', 'var(--isl-mint)'],
  archived: ['已归档', 'Archived', 'var(--isl-mint)'],
  stopped: ['已停止', 'Stopped', 'var(--isl-ink-ghost)'],
};

const VERDICT_LABELS: Record<string, [string, string]> = {
  pass: ['通过', 'pass'],
  revise: ['需修改', 'revise'],
  reject: ['驳回', 'reject'],
};

const STEP_STATUS_COLOR: Record<string, string> = {
  succeeded: 'var(--isl-mint)',
  failed: 'var(--isl-coral-deep)',
  running: 'var(--isl-ink-soft)',
  unknown_submit: '#e5a50a',
};

function dateTimeOf(ms: number) {
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function RunTrace({ trace, zh }: { trace: PipelineTrace; zh: boolean }) {
  return (
    <div className="flex flex-col gap-2 border-t px-3 py-2" style={{ borderColor: 'var(--isl-border)' }} data-testid="pipeline-run-trace">
      <div className="flex flex-wrap gap-1">
        {trace.versions.map(version => {
          const round = trace.rounds.filter(item => item.version === version.version).at(-1);
          return (
            <span key={version.version} className="rounded px-1.5 py-0.5" style={{ background: 'var(--isl-surface-2)' }}>
              v{version.version}
              {version.locked.length ? ` · ${zh ? '锁定' : 'locked'} ${version.locked.length}` : ''}
              {round ? ` · ${zh ? (VERDICT_LABELS[round.verdict]?.[0] ?? round.verdict) : (VERDICT_LABELS[round.verdict]?.[1] ?? round.verdict)}` : ''}
            </span>
          );
        })}
      </div>
      <ol className="flex max-h-[240px] flex-col overflow-y-auto">
        {trace.steps.map(step => (
          <li key={step.stepId} className="flex items-center gap-2 py-0.5">
            <span className="w-6 shrink-0 text-right tabular-nums" style={{ color: 'var(--isl-ink-ghost)' }}>{step.seq}</span>
            <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: STEP_STATUS_COLOR[step.status] || 'var(--isl-ink-ghost)' }} />
            <code className="truncate">{step.tool}</code>
            <span style={{ color: 'var(--isl-ink-soft)' }}>{step.caller}</span>
            {step.attempts > 1 ? <span style={{ color: 'var(--isl-ink-ghost)' }}>×{step.attempts}</span> : null}
            {step.error?.code ? <span className="truncate" style={{ color: 'var(--isl-coral-deep)' }} title={step.error.message}>{step.error.code}</span> : null}
          </li>
        ))}
      </ol>
      {trace.resumeFrom ? (
        <p style={{ color: '#e5a50a' }}>{zh ? `可从第 ${trace.resumeFrom.seq} 步（${trace.resumeFrom.tool}）继续` : `Resume from step ${trace.resumeFrom.seq} (${trace.resumeFrom.tool})`}</p>
      ) : null}
    </div>
  );
}

/**
 * 抽屉“运行日志”里的流水线 run 卡片：每个 run 一张卡，展开看 Step 与版本；
 * “放到画布”把各版本渲染收进一个批次（版本分组）。
 */
export function AgentPipelineRunsSection({ language = 'zho' }: { language?: Lang }) {
  const zh = language === 'zho';
  const status = useAgentConnectionStore(state => state.status);
  const [runs, setRuns] = useState<PipelineRunSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [traces, setTraces] = useState<Record<string, PipelineTrace>>({});
  const [placing, setPlacing] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [approvals, setApprovals] = useState<PipelineApproval[]>([]);
  const [deciding, setDeciding] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const connection = await getManagedAgentConnection();
      if (!connection) {
        setRuns([]);
        return;
      }
      const [nextRuns, nextApprovals] = await Promise.all([
        fetchPipelineRuns(connection),
        fetchPipelineApprovals(connection).catch(() => [] as PipelineApproval[]),
      ]);
      setRuns(nextRuns);
      setApprovals(nextApprovals);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, status]);

  const loadTrace = async (runId: string) => {
    const connection = await getManagedAgentConnection();
    if (!connection) throw new Error(zh ? '未连接本机 Agent' : 'Local agent not connected');
    const trace = await fetchPipelineTrace(connection, runId);
    setTraces(current => ({ ...current, [runId]: trace }));
    return { connection, trace };
  };

  const toggle = async (runId: string) => {
    if (open === runId) {
      setOpen(null);
      return;
    }
    setOpen(runId);
    try {
      await loadTrace(runId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  // 用户审批：Agent 只能发起（CONFIRMATION_REQUIRED + approvalId），批准后 Agent 用相同参数重试才会执行。
  const decide = async (approval: PipelineApproval, decision: 'grant' | 'deny') => {
    setDeciding(approval.id);
    try {
      const connection = await getManagedAgentConnection();
      if (!connection) throw new Error(zh ? '未连接本机 Agent' : 'Local agent not connected');
      await decidePipelineApproval(connection, approval.id, decision);
      setApprovals(current => current.filter(item => item.id !== approval.id));
      setNotice(decision === 'grant'
        ? (zh ? '已批准。让 Agent 用相同参数重试即可执行，批准只生效一次。' : 'Approved. The agent can retry with the same arguments; approval is single-use.')
        : (zh ? '已拒绝。' : 'Denied.'));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setDeciding(null);
    }
  };

  const placeOnCanvas = async (run: PipelineRunSummary) => {
    setPlacing(run.runId);
    setNotice(null);
    try {
      const { connection, trace } = await loadTrace(run.runId);
      const renders = pickVersionRenders(trace);
      if (!renders.length) {
        setNotice(zh ? '这个 run 还没有可放上画布的视频渲染。' : 'This run has no video render yet.');
        return;
      }
      const { insertPipelineVersionsIntoProject } = await import('../workflow/WorkflowWorkspace');
      const result = await insertPipelineVersionsIntoProject(run, renders, artifactId => fetchPipelineArtifact(connection, artifactId));
      if (!result.ok) setNotice(result.error || (zh ? '放到画布失败' : 'Could not place on canvas'));
      else if (!result.inserted) setNotice(zh ? '各版本已经在画布上。' : 'All versions are already on the canvas.');
      else setNotice(zh ? `已放入 ${result.inserted} 个版本，叠放在同一组，最新版本在最上面。` : `Placed ${result.inserted} version(s) in one stack, newest on top.`);
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPlacing(null);
    }
  };

  return (
    <div className="flex flex-col gap-2 text-xs" data-testid="agent-pipeline-runs">
      <div className="agent-section-head">
        <Clapperboard size={14} aria-hidden="true" />
        <strong>{zh ? '视频流水线' : 'Video pipeline'}</strong>
        <span className="agent-section-head__hint" title={zh ? '每个 run 一张卡，Step 由命令边界自动记录' : 'One card per run; steps are recorded at the command boundary'}>{zh ? '每个 run 一张卡，Step 由命令边界自动记录' : 'One card per run; steps are recorded at the command boundary'}</span>
        <button type="button" onClick={() => void refresh()} className="agent-copy-btn agent-section-head__action" disabled={loading} aria-label={zh ? '刷新流水线' : 'Refresh pipeline'} title={zh ? '刷新流水线' : 'Refresh pipeline'}>
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>
      {error ? <p style={{ color: 'var(--isl-coral-deep)' }}>{error}</p> : null}
      {notice ? <p data-testid="agent-pipeline-notice" style={{ color: 'var(--isl-ink-soft)' }}>{notice}</p> : null}
      {approvals.length ? (
        <ul className="flex flex-col gap-2" data-testid="pipeline-approvals">
          {approvals.map(approval => (
            <li key={approval.id} className="rounded-lg border px-3 py-2" style={{ borderColor: '#e5a50a' }} data-testid="pipeline-approval-card">
              <div className="flex items-center gap-2">
                <strong>{zh ? '待你批准' : 'Needs your approval'}</strong>
                <span style={{ color: 'var(--isl-ink-soft)' }}>{approval.command}</span>
                <span style={{ color: 'var(--isl-ink-ghost)' }}>{approval.caller}</span>
              </div>
              <p className="py-1" style={{ color: 'var(--isl-ink)' }}>{approval.summary}</p>
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => void decide(approval, 'grant')} disabled={deciding !== null} className="rounded border px-2 py-0.5" style={{ borderColor: 'var(--isl-border)', color: 'var(--isl-ink)' }}>
                  {zh ? '批准' : 'Approve'}
                </button>
                <button type="button" onClick={() => void decide(approval, 'deny')} disabled={deciding !== null} className="rounded border px-2 py-0.5" style={{ borderColor: 'var(--isl-border)', color: 'var(--isl-ink-soft)' }}>
                  {zh ? '拒绝' : 'Deny'}
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {runs.length === 0 ? (
        <p className="agent-section-empty">
          {zh ? '还没有流水线 run。Agent 调用 pipeline.run.start 后会出现在这里。' : 'No pipeline runs yet. They appear here after an agent calls pipeline.run.start.'}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {runs.map(run => {
            const label = STATUS_LABELS[run.status] || [run.status, run.status, 'var(--isl-ink-soft)'];
            const verdict = run.lastVerdict ? (VERDICT_LABELS[run.lastVerdict.verdict] || [run.lastVerdict.verdict, run.lastVerdict.verdict]) : null;
            return (
              <li key={run.runId} className="rounded-lg border" style={{ borderColor: 'var(--isl-border)' }} data-testid="pipeline-run-card">
                <div className="flex items-center gap-2 px-3 py-2">
                  <button type="button" onClick={() => void toggle(run.runId)} className="inline-flex min-w-0 flex-1 items-center gap-1 text-left" aria-expanded={open === run.runId}>
                    {open === run.runId ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    <strong className="truncate">{run.title || run.runId}</strong>
                  </button>
                  <span style={{ color: label[2] }}>{zh ? label[0] : label[1]}</span>
                  <span className="tabular-nums" style={{ color: 'var(--isl-ink-soft)' }}>v{run.headVersion}</span>
                  {verdict ? <span style={{ color: 'var(--isl-ink-soft)' }}>{zh ? `第 ${run.lastVerdict!.round} 轮 ${verdict[0]}` : `round ${run.lastVerdict!.round} ${verdict[1]}`}</span> : null}
                </div>
                <div className="flex items-center gap-2 px-3 pb-2" style={{ color: 'var(--isl-ink-ghost)' }}>
                  <span>{zh ? `${run.stepCount} 步` : `${run.stepCount} steps`}{run.failedSteps ? (zh ? `，失败 ${run.failedSteps}` : `, ${run.failedSteps} failed`) : ''}</span>
                  <span>{dateTimeOf(run.updatedAt)}</span>
                  <button type="button" onClick={() => void placeOnCanvas(run)} disabled={placing !== null || run.headVersion === 0} className="ml-auto inline-flex items-center gap-1 rounded border px-1.5 py-0.5" style={{ borderColor: 'var(--isl-border)', color: 'var(--isl-ink)' }}>
                    <LayoutGrid size={11} />
                    {placing === run.runId ? (zh ? '放置中…' : 'Placing…') : (zh ? '放到画布' : 'Place on canvas')}
                  </button>
                </div>
                {run.blocker?.message ? <p className="px-3 pb-2" style={{ color: 'var(--isl-coral-deep)' }}>{run.blocker.code ? `${run.blocker.code}: ` : ''}{run.blocker.message}</p> : null}
                {open === run.runId && traces[run.runId] ? <RunTrace trace={traces[run.runId]} zh={zh} /> : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
