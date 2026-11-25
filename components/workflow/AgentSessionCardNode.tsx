// plugin:agent-session 的节点外观（docs/design/01-interaction.md §12.0，DESIGN.md §0）：
// 标题行（奶蛙状态 + 标题 + 状态字；点击 / 「展开」= 打开 Drawer 并切到这个会话）、身份行（Agent · 模型 · 思考档位 · 运行环境）、
// 运行轨迹（思考行 + 工具时间线 / 审批行 / 完成后的一行统计，悬停或选中展开）、摘录、上下文 Chip（素材 + Skill + 记忆）、可折叠输入框。
// 卡片只读会话的投影：实时状态来自面板写入的 useCanvasAgentStore.live，持久摘要来自 metadata.agentSession.lastTurn。
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { ArrowUp, BookOpen, Box, Brain, Check, FileText, Image as ImageIcon, Maximize2, MessageSquarePlus, Music2, ShieldAlert, Square, Video, Wrench, X } from 'lucide-react';
import { installWorkflowNodePlugin, workflowNodePluginRegistry, type NodePluginRenderProps, type WorkflowNodePluginDefinition } from './nodePluginSdk';
import { AGENT_SESSION_CARD_SIZE, AGENT_SESSION_PLUGIN_ID, AGENT_SESSION_TYPE, agentSessionPreviewLines, ensureAgentSessionCardHeight } from './agentSessionCard';
import { dispatchWorkflowCommand } from '../../services/workflowDispatcher';
import { setContextCardHighlight } from './contextCardHighlight';
import { requestWorkflowAgentDrawer, type WorkflowAgentDrawerTarget } from './agentDrawerRequest';
import { decideCanvasAgentApproval, pushCanvasAgentOpen, pushCanvasAgentSend, stopCanvasAgentRun, useCanvasAgentStore } from '../../stores/useCanvasAgentStore';
import {
  agentSessionStatusLabel,
  deriveAgentSessionStatus,
  formatTraceSeconds,
  traceBudgetLine,
  traceCurrentStep,
  traceSummaryLine,
  visibleTraceSteps,
  type AgentSessionApproval,
  type AgentSessionTrace,
  type AgentTraceArtifact,
  type AgentTraceStep,
} from './agentSessionTrace';
import { NaiwaThinking } from '../brand/NaiwaThinking';
import type { WorkflowAgentSessionReference, WorkflowNode } from './types';

function stop(event: { stopPropagation(): void }) {
  event.stopPropagation();
}

function chipIcon(ref: WorkflowAgentSessionReference, nodes: readonly WorkflowNode[]) {
  if (ref.kind === 'asset') return <ImageIcon size={11} aria-hidden="true" />;
  const type = nodes.find(node => node.id === ref.id)?.type;
  if (type === 'image') return <ImageIcon size={11} aria-hidden="true" />;
  if (type === 'video') return <Video size={11} aria-hidden="true" />;
  if (type === 'audio') return <Music2 size={11} aria-hidden="true" />;
  if (type === 'text' || type === 'script') return <FileText size={11} aria-hidden="true" />;
  return <Box size={11} aria-hidden="true" />;
}

/** 打开 Drawer 并切到这张卡片的会话（复用 agentDrawerRequest）；target 带上 entryId / toolCallId 时 Drawer 滚到那条消息或工具调用。 */
export function openAgentSessionInDrawer(projectId: string, cardNodeId: string, target?: WorkflowAgentDrawerTarget) {
  pushCanvasAgentOpen({ projectId, cardNodeId });
  requestWorkflowAgentDrawer(target);
}

/** 点产物：用命令面的 workflow.focus.nodes 把视口移到那个节点（与 Agent 的 iris_workflow_focus_nodes 同一入口）。 */
export function focusAgentArtifact(projectId: string, nodeId: string) {
  const width = typeof window !== 'undefined' ? window.innerWidth : 1200;
  const height = typeof window !== 'undefined' ? window.innerHeight : 800;
  return dispatchWorkflowCommand({
    id: 'agent-artifact-focus:' + nodeId + ':' + Date.now(),
    command: 'workflow.focus.nodes',
    source: 'ui',
    args: { projectId, nodeIds: [nodeId], width, height },
  });
}

/** 悬停展开里的 Context / Artifact / Budget：三项都来自同一份轨迹归约。没有内容的项不显示。 */
function TraceFacts({ trace, onArtifact }: { trace: AgentSessionTrace; onArtifact: (artifact: AgentTraceArtifact) => void }) {
  const budget = traceBudgetLine(trace);
  if (!trace.context.length && !trace.artifacts.length && !budget) return null;
  return <dl className="agent-session-card__facts" data-testid="agent-session-card-facts">
    {trace.context.length > 0 && <div className="agent-session-card__fact" data-kind="context">
      <dt>Context</dt>
      <dd title={trace.context.map(item => item.label).join('、')}>{trace.context.map(item => item.label).join('、')}</dd>
    </div>}
    {trace.artifacts.length > 0 && <div className="agent-session-card__fact" data-kind="artifact">
      <dt>Artifact</dt>
      <dd>{trace.artifacts.map(artifact => <button key={artifact.nodeId} type="button" className="agent-session-card__artifact" data-testid="agent-session-card-artifact" data-node-id={artifact.nodeId} data-workflow-overlay title={'在画布上定位：' + artifact.label} onPointerDown={stop} onClick={() => onArtifact(artifact)}>{artifact.label}</button>)}</dd>
    </div>}
    {budget && <div className="agent-session-card__fact" data-kind="budget">
      <dt>Budget</dt>
      <dd>{budget}</dd>
    </div>}
  </dl>;
}

/** 运行中的计时：自己每秒走表，不让整张画布跟着重渲染。 */
function useTicker(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

const STEP_STATUS: Record<AgentTraceStep['status'], string> = { running: '运行中', success: '成功', error: '失败', denied: '已拒绝', waiting: '等待' };

function StepIcon({ step }: { step: AgentTraceStep }) {
  if (step.status === 'running') return <span className="agent-session-card__step-spin" aria-hidden="true"><i /><i /><i /></span>;
  if (step.status === 'error' || step.status === 'denied') return <X size={11} strokeWidth={2.5} aria-hidden="true" />;
  if (step.kind === 'skill') return <BookOpen size={11} aria-hidden="true" />;
  if (step.kind === 'memory') return <Brain size={11} aria-hidden="true" />;
  if (step.status === 'success') return <Check size={11} strokeWidth={2.5} aria-hidden="true" />;
  return <Wrench size={11} aria-hidden="true" />;
}

function TraceStepRow({ step, now, onOpen }: { step: AgentTraceStep; now: number; onOpen: (step: AgentTraceStep) => void }) {
  const ms = step.ms ?? (step.status === 'running' && step.startedAt !== undefined ? Math.max(0, now - step.startedAt) : undefined);
  const title = [step.label + (step.target ? ' · ' + step.target : ''), STEP_STATUS[step.status] + (ms !== undefined ? ' · ' + formatTraceSeconds(ms) : ''), step.error || ''].filter(Boolean).join('\n');
  return <li>
    <button
      type="button"
      className="agent-session-card__step"
      data-status={step.status}
      data-kind={step.kind}
      data-conflict={step.conflict ? '' : undefined}
      data-testid="agent-session-card-step"
      data-tool-call-id={step.toolCallId}
      data-workflow-overlay
      title={title + '\n在对话面板中查看'}
      onPointerDown={stop}
      onClick={() => onOpen(step)}
    >
      <span className="agent-session-card__step-icon"><StepIcon step={step} /></span>
      <span className="agent-session-card__step-name">{step.label}</span>
      {step.target && <span className="agent-session-card__step-target">{step.target}</span>}
      <span className="agent-session-card__step-state">{STEP_STATUS[step.status]}</span>
      <span className="agent-session-card__step-time">{ms !== undefined ? formatTraceSeconds(ms) : ''}</span>
    </button>
  </li>;
}

function TraceTimeline({ trace, now, max, onOpen, testId }: { trace: AgentSessionTrace; now: number; max?: number; onOpen: (step: AgentTraceStep) => void; testId?: string }) {
  const { shown, hidden } = max ? visibleTraceSteps(trace.steps, max) : { shown: trace.steps, hidden: 0 };
  if (!shown.length) return null;
  return <ol className="agent-session-card__timeline" data-testid={testId}>
    {hidden > 0 && <li className="agent-session-card__more-steps" aria-label={`还有 ${hidden} 次工具调用`}>+{hidden}</li>}
    {shown.map(step => <TraceStepRow key={step.id} step={step} now={now} onOpen={onOpen} />)}
  </ol>;
}

function ApprovalRow({ approval, onDecide, onOpen }: { approval: AgentSessionApproval; onDecide: (approved: boolean) => void; onOpen: () => void }) {
  const meta = [approval.tool, approval.reason, approval.cost].filter(Boolean).join(' · ');
  return <div className="agent-session-card__approval" role="group" aria-label="等待授权" data-testid="agent-session-card-approval" data-blocked={approval.blocked ? '' : undefined} data-workflow-overlay onPointerDown={stop} onDoubleClick={stop}>
    <p className="agent-session-card__approval-title" title={approval.title}><ShieldAlert size={12} aria-hidden="true" /><span>{approval.title}</span></p>
    {meta && <p className="agent-session-card__approval-meta" title={meta}>{meta}</p>}
    {approval.blocked && <p className="agent-session-card__approval-meta is-blocked">预算门挡住了这一批，去对话面板看明细。</p>}
    <div className="agent-session-card__approval-actions">
      {approval.queued ? <span className="agent-session-card__approval-queue">还有 {approval.queued} 项</span> : null}
      {approval.ask
        ? <button type="button" className="agent-session-card__btn" onClick={onOpen}>去回答</button>
        : <>
            <button type="button" className="agent-session-card__btn" data-testid="agent-session-card-deny" onClick={() => onDecide(false)}>拒绝</button>
            {approval.blocked
              ? <button type="button" className="agent-session-card__btn" onClick={onOpen}>查看</button>
              : <button type="button" className="agent-session-card__btn is-primary" data-testid="agent-session-card-approve" onClick={() => onDecide(true)}>{approval.plan ? '批准并生成' : '批准'}</button>}
          </>}
    </div>
  </div>;
}

export function AgentSessionCardSurface({ node, context }: NodePluginRenderProps) {
  const meta = node.metadata.agentSession;
  const live = useCanvasAgentStore(state => state.live[node.id]);
  const focusCardId = useCanvasAgentStore(state => state.focusCardId);
  const harness = useCanvasAgentStore(state => state.harness);
  const seenKey = useCanvasAgentStore(state => state.seen[node.id]);
  const nodes = context.getNodes();
  const references = meta?.references || [];
  const lastTurn = meta?.lastTurn;
  const empty = !lastTurn && !live;
  const [composerOpen, setComposerOpen] = useState(empty);
  const [draft, setDraft] = useState('');
  const [traceOpen, setTraceOpen] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const pointerStart = useRef<{ x: number; y: number } | null>(null);
  const busy = live?.phase === 'queued' || live?.phase === 'running';
  const trace = live?.trace;
  const approval = live?.approval;
  const now = useTicker(Boolean(busy && trace && (trace.thinking.active || trace.steps.some(step => step.status === 'running'))));
  const hoverKey = node.id + ':hover';
  const liveRefIds = references.filter(ref => ref.kind === 'node' && nodes.some(item => item.id === ref.id)).map(ref => ref.id);
  const status = deriveAgentSessionStatus({
    phase: live?.phase,
    approvalPending: Boolean(approval),
    lastTurnStatus: lastTurn?.status,
    conflicts: trace?.conflicts,
    // 用户自己停下的一轮不算「未读」。
    completedKey: live?.stopped ? undefined : live?.completedKey,
    seenKey,
  });

  // 刚由「问 Agent」/「与 Agent 讨论」建的卡片：光标直接落在输入框里（只一次）。
  useEffect(() => {
    if (focusCardId !== node.id) return;
    setComposerOpen(true);
    useCanvasAgentStore.getState().requestFocus(null);
    window.requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
  }, [focusCardId, node.id]);
  useEffect(() => () => setContextCardHighlight(hoverKey, null), [hoverKey]);
  // P1 的旧卡（196 / 226 高）放不下轨迹：挂载时增高到当前最小高度（一张卡一次）。
  const tooShort = node.height < AGENT_SESSION_CARD_SIZE.height;
  useEffect(() => {
    if (tooShort) void ensureAgentSessionCardHeight({ projectId: context.projectId, nodeId: node.id });
  }, [tooShort, context.projectId, node.id]);
  // 一轮开始（无论从卡片、双击菜单还是 Drawer 发出）就收起输入框，把位置让给进度和回复。
  useEffect(() => {
    if (live?.phase === 'queued' || live?.phase === 'running') setComposerOpen(false);
  }, [live?.phase]);

  const send = () => {
    const text = draft.trim();
    if (!text || busy) return;
    if (pushCanvasAgentSend({ projectId: context.projectId, cardNodeId: node.id, text, references })) {
      setDraft('');
      setComposerOpen(false);
    }
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    event.stopPropagation();
    if (event.key === 'Escape') { setComposerOpen(false); return; }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  };
  const onHeadPointerDown = (event: ReactPointerEvent) => { pointerStart.current = { x: event.clientX, y: event.clientY }; };
  const onHeadClick = (event: ReactMouseEvent) => {
    const start = pointerStart.current;
    pointerStart.current = null;
    // 拖动卡片后松手不算点击。
    if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) return;
    openAgentSessionInDrawer(context.projectId, node.id);
  };
  const open = (target?: WorkflowAgentDrawerTarget) => openAgentSessionInDrawer(context.projectId, node.id, target);
  const openStep = (step: AgentTraceStep) => open(step.toolCallId ? { toolCallId: step.toolCallId } : step.entryId ? { entryId: step.entryId } : undefined);
  const decide = (approved: boolean) => {
    if (!approval) return;
    // 面板不在（或这项确认已过期）：打开 Drawer，让用户在原确认卡上决定。
    if (!decideCanvasAgentApproval({ cardNodeId: node.id, approvalId: approval.id, approved })) open();
  };

  const stopped = Boolean(live?.stopped && live.phase === 'done');
  const statusText = live?.phase === 'queued' ? '排队中' : stopped ? '已停止' : agentSessionStatusLabel(status);
  const stopRun = () => { stopCanvasAgentRun(node.id); };

  const rawPrompt = busy || live?.phase === 'error' ? live?.prompt : lastTurn?.prompt;
  // 第一轮的问题就是标题：不重复显示。
  const prompt = rawPrompt && !node.title.replace(/…$/, '').startsWith(rawPrompt.trim().slice(0, 23)) ? rawPrompt : '';
  const preview = busy ? agentSessionPreviewLines(live?.preview || '', trace?.steps.length ? 2 : 3) : lastTurn?.excerpt || (live?.phase === 'done' ? agentSessionPreviewLines(live.preview, 6) : '');
  const shownChips = references.slice(0, 3);
  const skills = trace?.skills || [];
  const memory = trace?.memory;
  const summary = trace && !busy ? traceSummaryLine(trace) : '';
  const thinking = trace?.thinking;
  const thinkingMs = thinking ? thinking.ms + (thinking.active && thinking.startedAt !== undefined ? Math.max(0, now - thinking.startedAt) : 0) : 0;
  const showIdentity = Boolean(harness) && meta?.host !== 'external';
  // 「当前步骤」：运行中的工具、在想下一步，或在等模型回复（只用真实状态，不编造）。
  const currentStep = busy && !approval && trace && live?.phase === 'running' ? traceCurrentStep(trace) : '';
  const chipCount = shownChips.length + skills.length + (memory?.count ? 1 : 0);

  return <div
    className="workflow-node__plugin-card agent-session-card"
    data-testid="agent-session-card"
    data-phase={live?.phase || (lastTurn ? lastTurn.status : 'empty')}
    data-status={status}
    data-trace-open={traceOpen ? '' : undefined}
    onPointerEnter={() => setContextCardHighlight(hoverKey, liveRefIds)}
    onPointerLeave={() => setContextCardHighlight(hoverKey, null)}
  >
    <div className="agent-session-card__head">
      <span className="agent-session-card__orb" data-status={status} data-testid="agent-session-card-orb" title={statusText || '已查看'}><NaiwaThinking size={20} bubble={false} /></span>
      <button type="button" className="agent-session-card__title" title={node.title + ' · 在对话面板中打开'} data-testid="agent-session-card-title" onPointerDown={onHeadPointerDown} onClick={onHeadClick}>{node.title}</button>
      {statusText && <span className="agent-session-card__status" data-status={stopped ? 'stopped' : status} data-testid="agent-session-card-status">{statusText}</span>}
      {busy && <button type="button" className="agent-session-card__icon agent-session-card__stop" aria-label="停止这一轮" title={live?.background ? '停止这一轮（只停这张卡片，其它会话不受影响）' : '停止这一轮'} data-workflow-overlay data-testid="agent-session-card-stop" onPointerDown={stop} onClick={stopRun}><Square size={10} fill="currentColor" aria-hidden="true" /></button>}
      <button type="button" className="agent-session-card__icon agent-session-card__reveal" aria-label="在对话面板中展开" title="在对话面板中展开" data-workflow-overlay data-testid="agent-session-card-expand" onPointerDown={stop} onClick={() => open()}><Maximize2 size={12} aria-hidden="true" /></button>
    </div>
    {showIdentity && harness && <div className="agent-session-card__identity" title={harness.title} data-testid="agent-session-card-identity">
      <span className="agent-session-card__identity-text">{[harness.name, harness.model, harness.thinking ? '思考 ' + harness.thinking : ''].filter(Boolean).join(' · ')}</span>
      <span className="agent-session-card__badge" data-runtime={harness.runtime} data-testid="agent-session-card-runtime">{harness.env}</span>
      {harness.scope && <span className="agent-session-card__badge is-scope">{harness.scope}</span>}
    </div>}
    <div className="agent-session-card__turn" data-testid="agent-session-card-turn">
      {prompt && <p className="agent-session-card__prompt" title={prompt}>{prompt}</p>}
      {approval && <ApprovalRow approval={approval} onDecide={decide} onOpen={() => open()} />}
      {currentStep && <p className="agent-session-card__current" data-testid="agent-session-card-current" title={currentStep}><span className="agent-session-card__current-dot" aria-hidden="true" />{currentStep}</p>}
      {busy && !approval && thinking?.present && <button type="button" className="agent-session-card__thinking" data-active={thinking.active ? '' : undefined} data-testid="agent-session-card-thinking" data-workflow-overlay onPointerDown={stop} onClick={() => open(thinking.messageId && !thinking.messageId.startsWith('stream-') ? { entryId: thinking.messageId } : undefined)} title={thinking.summary || undefined}>
        <span className="agent-session-card__thinking-head">{thinking.active ? '思考中' : '思考'} · {formatTraceSeconds(thinkingMs)}</span>
        {thinking.summary && <span className="agent-session-card__thinking-text">{thinking.summary}</span>}
      </button>}
      {busy && !approval && trace && <TraceTimeline trace={trace} now={now} max={3} onOpen={openStep} testId="agent-session-card-timeline" />}
      {busy && !trace?.steps.length && !thinking?.present && !currentStep && <span className="agent-session-card__progress" role="status" aria-label={statusText}><i /><i /><i /></span>}
      {live?.phase === 'error'
        ? <p className="agent-session-card__error" role="alert">{live.error}{live.errorKind && <button type="button" className="agent-session-card__link" data-workflow-overlay onPointerDown={stop} onClick={() => open()}>{live.errorKind === 'no-model' ? '去设置模型' : '在对话面板继续'}</button>}</p>
        : preview && !approval
          ? <p className="agent-session-card__excerpt" data-streaming={busy ? '' : undefined}>{preview}</p>
          : empty && <p className="agent-session-card__hint">{references.length ? '问点什么，绑定的素材会一起发给 Agent。' : '问点什么；只发送你写的内容和绑定的素材。'}</p>}
      {summary && trace && <div className="agent-session-card__trace" onPointerEnter={() => setTraceOpen(true)} onPointerLeave={() => setTraceOpen(false)}>
        <button type="button" className="agent-session-card__summary" data-testid="agent-session-card-summary" data-workflow-overlay onPointerDown={stop} onClick={() => setTraceOpen(value => !value)} onFocus={() => setTraceOpen(true)} aria-expanded={traceOpen}>{summary}</button>
        <div className="agent-session-card__trace-pop" data-testid="agent-session-card-trace">
          {thinking?.present && <button type="button" className="agent-session-card__thinking" data-workflow-overlay onPointerDown={stop} onClick={() => open(thinking.messageId && !thinking.messageId.startsWith('stream-') ? { entryId: thinking.messageId } : undefined)} title={thinking.summary || undefined}>
            <span className="agent-session-card__thinking-head">思考{thinking.ms ? ' · ' + formatTraceSeconds(thinking.ms) : ''}</span>
            {thinking.summary && <span className="agent-session-card__thinking-text">{thinking.summary}</span>}
          </button>}
          <TraceTimeline trace={trace} now={now} onOpen={openStep} />
          <TraceFacts trace={trace} onArtifact={artifact => { void focusAgentArtifact(context.projectId, artifact.nodeId); }} />
        </div>
      </div>}
    </div>
    {chipCount > 0 && <div className="agent-session-card__chips" data-testid="agent-session-card-chips">
      {shownChips.map(ref => {
        const missing = ref.kind === 'node' && !nodes.some(item => item.id === ref.id);
        return <span key={ref.kind + ref.id} className="agent-session-card__chip" data-missing={missing ? '' : undefined} title={missing ? ref.label + '（不可用）' : ref.label}>{chipIcon(ref, nodes)}<span>{ref.label}</span></span>;
      })}
      {references.length > shownChips.length && <span className="agent-session-card__chip is-more">+{references.length - shownChips.length}</span>}
      {skills.map(skill => <button type="button" key={'skill:' + skill.id} className="agent-session-card__chip is-skill" data-testid="agent-session-card-skill" data-workflow-overlay title={'本轮加载的 Skill：' + skill.id} onPointerDown={stop} onClick={() => open(skill.toolCallId ? { toolCallId: skill.toolCallId } : undefined)}><BookOpen size={11} aria-hidden="true" /><span>Skill: {skill.label}</span></button>)}
      {memory && memory.count > 0 && <button type="button" className="agent-session-card__chip is-memory" data-testid="agent-session-card-memory" data-workflow-overlay title={['本轮命中的项目记忆：', ...memory.titles.map(title => '· ' + title)].join('\n')} onPointerDown={stop} onClick={() => open(memory.toolCallId ? { toolCallId: memory.toolCallId } : undefined)}><Brain size={11} aria-hidden="true" /><span>记忆 {memory.count} 条</span></button>}
    </div>}
    {composerOpen
      ? <div className="agent-session-card__composer" data-workflow-overlay onPointerDown={stop} onDoubleClick={stop}>
          <textarea
            ref={inputRef}
            className="agent-session-card__input"
            aria-label="问 Agent"
            data-testid="agent-session-card-input"
            rows={2}
            value={draft}
            placeholder={busy ? '这一轮结束后再继续…' : lastTurn ? '继续问…' : '问 Agent…'}
            onChange={event => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
          />
          <button type="button" className="isl-go agent-session-card__send" aria-label="发送" title="发送（Enter）" data-testid="agent-session-card-send" disabled={!draft.trim() || busy} onClick={send}><ArrowUp size={14} aria-hidden="true" /></button>
        </div>
      : <button type="button" className="agent-session-card__more agent-session-card__reveal" data-workflow-overlay data-testid="agent-session-card-continue" onPointerDown={stop} onClick={() => { setComposerOpen(true); window.requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true })); }}><MessageSquarePlus size={12} aria-hidden="true" />继续问</button>}
  </div>;
}

export const agentSessionPlugin: WorkflowNodePluginDefinition = {
  pluginId: AGENT_SESSION_PLUGIN_ID,
  type: AGENT_SESSION_TYPE,
  version: '1.0.0',
  title: 'Agent 会话',
  description: '画布上的 Agent 会话投影：完整对话在 Drawer。',
  // 会话卡不参与 Workflow 执行：没有输入，也不作为文本资源输出（避免摘录被当成定稿结论）。
  outputs: () => [],
  render: props => <AgentSessionCardSurface {...props} />,
  onDoubleClick: context => openAgentSessionInDrawer(context.projectId, context.node.id),
};

export function installAgentSessionPlugin() {
  const existing = workflowNodePluginRegistry.list().find(item => item.pluginId === AGENT_SESSION_PLUGIN_ID);
  return existing ?? installWorkflowNodePlugin(agentSessionPlugin);
}

installAgentSessionPlugin();
