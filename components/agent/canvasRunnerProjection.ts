// 卡片投影的共用部分：面板主运行时那一轮与画布后台运行（canvasSessionRunners）都用这里把
// 「确认请求 + 轨迹」变成卡片审批行，把后台运行状态变成卡片的 live 投影。与 Drawer 确认卡同一份文案（describeAgentConfirmation）。
import type { AgentConfirmRequest } from '../../services/agentSpendMandate';
import type { WorkflowNode } from '../workflow/types';
import type { CanvasAgentLive } from '../../stores/useCanvasAgentStore';
import { currentTurnMessages, reduceAgentSessionTrace, type AgentSessionApproval, type AgentSessionTrace } from '../workflow/agentSessionTrace';
import { describeAgentConfirmation } from './agentConfirmCopy';
import { agentToolLabel } from './agentTurnText';
import { isRunPlanRequest } from './agentRunPlan';
import type { CanvasRunnerState } from './canvasSessionRunners';

type Lang = 'en' | 'zho';

/** 一项待批准的确认 → 卡片审批行。普通工具的询问标题写「工具 · 目标」，付费 / 删除仍用确认卡那句人话。 */
export function cardApprovalFrom(input: {
  id: string;
  request?: AgentConfirmRequest;
  summary?: string;
  blocked?: boolean;
  queued?: number;
  trace: AgentSessionTrace;
  nodes: readonly WorkflowNode[];
  language: Lang;
}): AgentSessionApproval {
  const { request, trace, language: lang } = input;
  const copy = describeAgentConfirmation(request, input.nodes, lang, input.summary);
  const waitingStep = [...trace.steps].reverse().find(step => step.status === 'running');
  const cost = request?.kind === 'generation' ? copy.detail : undefined;
  const toolTitle = request?.kind === 'other' && waitingStep ? waitingStep.label + (waitingStep.target ? ' · ' + waitingStep.target : '') : '';
  return {
    id: input.id,
    title: toolTitle || copy.title,
    ...(toolTitle ? {} : waitingStep ? { tool: waitingStep.label } : request ? { tool: agentToolLabel(request.tool || request.command, lang) || request.command } : {}),
    ...(request?.reason ? { reason: request.reason } : toolTitle ? { reason: copy.title } : !cost && copy.detail ? { reason: copy.detail } : {}),
    ...(cost ? { cost } : {}),
    ...(input.blocked ? { blocked: true } : {}),
    ...(isRunPlanRequest(request) ? { plan: true } : {}),
    ...(input.queued ? { queued: input.queued } : {}),
  };
}

/** 后台运行状态 → 卡片 live 投影（phase / 摘录 / 轨迹 / 审批 / 停止标记）。 */
export function runnerLive(state: CanvasRunnerState, options: { nodes: readonly WorkflowNode[]; language: Lang }): Omit<CanvasAgentLive, 'updatedAt'> {
  const { prompt: userMessage, after } = currentTurnMessages(state.messages);
  const running = state.phase === 'running' || state.phase === 'awaitingApproval';
  const trace = reduceAgentSessionTrace(after, { running, nodes: options.nodes, language: options.language, ...(userMessage ? { prompt: userMessage } : {}) });
  const assistant = [...after].reverse().find(item => item.role === 'assistant' && item.text);
  const base = { prompt: state.request.text, preview: assistant?.text || '', trace, background: true as const };
  if (state.phase === 'queued') return { ...base, phase: 'queued' };
  if (running) {
    const approval = state.approval
      ? cardApprovalFrom({ id: state.approval.id, ...(state.approval.request ? { request: state.approval.request } : {}), summary: state.approval.summary, blocked: state.approval.blocked, queued: state.queuedApprovals, trace, nodes: options.nodes, language: options.language })
      : undefined;
    const tool = state.approval ? (options.language === 'zho' ? '等待你确认' : 'awaiting approval') : [...after].reverse().find(item => item.role === 'tool' && item.status === 'pending')?.title;
    return { ...base, phase: 'running', ...(approval ? { approval } : {}), ...(tool ? { tool } : {}) };
  }
  const completedKey = (assistant && !assistant.id.startsWith('stream-') ? assistant.id : '') || state.request.id;
  if (state.phase === 'cancelled') return { ...base, phase: 'done', stopped: true, completedKey };
  if (state.phase === 'error' || state.phase === 'interrupted') {
    return { ...base, phase: 'error', error: state.error || after.find(item => item.role === 'error')?.text || '', errorKind: 'failed', completedKey };
  }
  return { ...base, phase: 'done', completedKey };
}
