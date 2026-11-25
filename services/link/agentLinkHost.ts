// Iris Link 在标签页里的「执行宿主」登记：Agent 面板（IrisAgentPanel）就绪后把它已有的能力登记到这里，
// link 命令（本机 loopback 或线上中继进来的）只通过这份登记驱动 Agent，不另建运行时、策略或审批：
// - connectBackground：与画布会话卡同一个后台运行时工厂（同一条线路、系统提示、Tool Policy、付费授权，Session Authority 认领会话）；
// - canvasRunners：面板自己的画布会话卡调度器（--canvas 时把回合交给它，卡片照常显示运行轨迹与审批）；
// - mandate / approval：面板共用的付费授权与审批上下文。
// 模型 Key 只在 connectBackground 里由面板使用，从不出现在这里的任何返回值中。
import type { CanvasRunnerRequest, CanvasRunnerRuntime, CanvasRunnerState, CanvasSessionRunners } from '../../components/agent/canvasSessionRunners';
import type { WorkflowAgentDisplayMessage } from '../../components/workflow/WorkflowAgentMessages';
import type { AgentConfirmRequest, AgentSpendMandate } from '../agentSpendMandate';
import type { AgentConfirmVerdict } from '../runApproval';
import type { AgentAskRequest, AgentAskResult } from '../browserAgentKernel';
import type { ApprovalContext } from '../agentToolPolicy';
import type { ImageContent } from '@earendil-works/pi-ai';
import type { TurnContextDraft } from '../turnContext';

export interface AgentLinkPanelHost {
  projectId: string;
  language: 'en' | 'zho';
  connectBackground(input: {
    session: { id: string } | 'new';
    confirm: (summary: string, request?: AgentConfirmRequest) => Promise<AgentConfirmVerdict>;
    ask: (request: AgentAskRequest) => Promise<AgentAskResult>;
  }): Promise<CanvasRunnerRuntime>;
  prepare?(request: CanvasRunnerRequest): Promise<{ text: string; images?: ImageContent[]; turnContext?: TurnContextDraft | null }>;
  toDisplay?(snapshot: unknown): WorkflowAgentDisplayMessage[];
  listSessions(): Promise<Array<{ id: string; title: string; updatedAt: string }>>;
  canvasRunners: Pick<CanvasSessionRunners, 'enqueue' | 'decide' | 'cancel' | 'get' | 'isRunningSession' | 'isActive'>;
  mandate: { get(): AgentSpendMandate | null; set(next: AgentSpendMandate): void; enabled(): boolean };
  /** 面板当前的审批上下文（模式 + 按工具策略 + 会话授权）。 */
  approval(): ApprovalContext;
  /** 面板主运行时正在这个会话上跑。 */
  isSessionBusy(sessionId: string): boolean;
  /** 当前文本线路的模型（只有 id 与 provider，没有 Key / baseUrl）。 */
  model(): { id: string; provider: string } | null;
  toolLabel?(name: string): string | undefined;
  toolResultText?(result: unknown): string;
}

type HostListener = (projectId: string, host: AgentLinkPanelHost | null) => void;
type RunnerListener = (projectId: string, state: CanvasRunnerState) => void;
type DecisionListener = (projectId: string, decision: { cardNodeId: string; approvalId: string; approved: boolean }) => void;

const hosts = new Map<string, AgentLinkPanelHost>();
const hostListeners = new Set<HostListener>();
const runnerListeners = new Set<RunnerListener>();
const decisionListeners = new Set<DecisionListener>();

/** 面板登记（返回注销函数）。同一项目后登记的覆盖前一个。 */
export function registerAgentLinkHost(host: AgentLinkPanelHost): () => void {
  hosts.set(host.projectId, host);
  for (const listener of hostListeners) listener(host.projectId, host);
  return () => {
    if (hosts.get(host.projectId) !== host) return;
    hosts.delete(host.projectId);
    for (const listener of hostListeners) listener(host.projectId, null);
  };
}

export function getAgentLinkHost(projectId: string | null | undefined): AgentLinkPanelHost | null {
  return projectId ? hosts.get(projectId) ?? null : null;
}

export function agentLinkHostProjects(): string[] {
  return [...hosts.keys()];
}

export function onAgentLinkHost(listener: HostListener): () => void {
  hostListeners.add(listener);
  return () => hostListeners.delete(listener);
}

/** 面板的画布会话卡调度器状态变化（面板 onChange 里转一份过来），link 据此记录 --canvas 回合的轨迹。 */
export function notifyAgentLinkRunner(projectId: string, state: CanvasRunnerState): void {
  for (const listener of runnerListeners) listener(projectId, state);
}
export function onAgentLinkRunner(listener: RunnerListener): () => void {
  runnerListeners.add(listener);
  return () => runnerListeners.delete(listener);
}

/** 卡片上的批准 / 拒绝（用户在页面上点的），让 link 轨迹记下是谁、批了还是拒了。 */
export function notifyAgentLinkDecision(projectId: string, decision: { cardNodeId: string; approvalId: string; approved: boolean }): void {
  for (const listener of decisionListeners) listener(projectId, decision);
}
export function onAgentLinkDecision(listener: DecisionListener): () => void {
  decisionListeners.add(listener);
  return () => decisionListeners.delete(listener);
}

/** 测试用。 */
export function resetAgentLinkHostsForTests(): void {
  hosts.clear();
  hostListeners.clear();
  runnerListeners.clear();
  decisionListeners.clear();
}
