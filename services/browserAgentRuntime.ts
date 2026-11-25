// 内置 Browser Agent 的运行时句柄：把 kernel 从 React 面板里抽出来，
// 让同一页面的其它服务（命令面 / 委派回合）能在项目维度拿到它。
// 面板仍是生命周期所有者：卸载时 close，行为与抽取前一致。
import type { TurnContextDraft } from './turnContext';
import type { ImageContent } from '@earendil-works/pi-ai';
import type { WorkflowNode } from '../components/workflow/types';
import type { AgentConfirmRequest } from './agentSpendMandate';
import type { AgentConfirmVerdict } from './runApproval';
import type { AgentSearchCredential } from './agentWebSearch';
import type { ApprovalContext, ApprovalMode } from './agentToolPolicy';
import type { ProductionSkillAttachment } from './productionSkillCatalog';
import type { AgentThinkingLevel } from './agentThinking';
import {
  BrowserAgentKernel,
  createBrowserAgentTools,
  type AgentAskRequest,
  type AgentAskResult,
  type BrowserAgentTextRoute,
} from './browserAgentKernel';
import { MergedSkillCatalog } from './agentSkillCatalog';
import { createLocalSkillRegistry } from './localSkillRegistry';

export interface BrowserAgentRuntimeDeps {
  projectId: string;
  route: BrowserAgentTextRoute;
  confirm: (summary: string, request?: AgentConfirmRequest) => Promise<AgentConfirmVerdict>;
  ask?: (request: AgentAskRequest) => Promise<AgentAskResult>;
  systemPrompt: string;
  getNodes?: () => readonly WorkflowNode[];
  /** 面板当前的审批上下文（模式、用户按工具策略、会话授权）。 */
  getApproval?: () => ApprovalContext;
  webSearch?: AgentSearchCredential;
  getDraftVersion?: () => number | undefined;
  /** 当前思考强度；缺省由内核读本机为该模型保存的设置。 */
  getThinkingLevel?: () => AgentThinkingLevel;
  /** 模型上下文窗口；缺省读 route.contextWindow（模型对象的可选字段），再没有按 128K。 */
  contextWindow?: number;
}

/** 只依赖运行时实际用到的内核方法，测试可注入替身。 */
export interface RuntimeKernel {
  openSession(): Promise<unknown>;
  close(): Promise<void>;
  subscribe(listener: RuntimeListener): () => void;
  snapshot(): Promise<unknown>;
  send(text: string, images?: ImageContent[], skillAttachment?: ProductionSkillAttachment | null, turnContext?: TurnContextDraft | null): Promise<unknown>;
  cancel(): void;
  /** 运行中插话；没在跑时返回 false。旧替身可不实现。 */
  steer?(text: string, images?: ImageContent[], id?: string, turnContext?: TurnContextDraft | null): boolean;
  /** 撤回尚未到步骤边界的插话。旧替身可不实现。 */
  withdrawSteer?(id: string): boolean;
  /** 取走这一轮结束时仍未送达的插话 id。旧替身可不实现。 */
  takePendingSteers?(): string[];
  listSessions(): Promise<Array<{ id: string; title: string; updatedAt: string }>>;
  /** fresh：不复用最近的空会话（后台运行时要独占的新会话）。 */
  newSession(options?: { fresh?: boolean }): Promise<unknown>;
  openSessionById(sessionId: string): Promise<unknown>;
  deleteSession(sessionId: string): Promise<void>;
  branchSession(fromSessionId: string, upto: string | readonly string[]): Promise<unknown>;
  /** 手动压缩上下文（可带 /compact 的聚焦说明）；旧替身可不实现。 */
  compactContext?(focus?: string): Promise<CompactContextResult>;
}

export interface CompactContextResult {
  compacted: boolean;
  tokensBefore?: number;
  tokensAfter?: number;
}

export type DelegatedTurnPolicy = 'read-only' | 'workspace-write';

export interface DelegatedTurnRequest {
  prompt: string;
  /** 指定则切到该会话再跑；省略则留在当前会话。 */
  sessionId?: string;
  policy?: DelegatedTurnPolicy;
  /** 幂等键：同一个键只跑一轮，重复调用返回同一结果。 */
  mutationId: string;
  caller?: string;
}

export interface DelegatedTurnResult {
  sessionId: string;
  text: string;
  toolCalls: Array<{ name: string; status: 'success' | 'error' }>;
  draftVersion?: number;
  /** 返回给编排者的文本被截断过（只回摘要，不回整段 transcript）。 */
  truncated?: boolean;
}

type RuntimeEvent = { type: string; [key: string]: unknown };
type RuntimeListener = (event: RuntimeEvent) => void;

/** 委派回合的错误码给命令面直接转成结构化错误。 */
export class AgentRuntimeError extends Error {
  constructor(readonly code: 'AGENT_BUSY' | 'AGENT_TURN_FAILED' | 'AGENT_RUNTIME_CLOSED' | 'BAD_REQUEST', message: string) {
    super(message);
    this.name = 'AgentRuntimeError';
  }
}

const MAX_SUMMARY_CHARACTERS = 6_000;
const TURN_LEDGER_LIMIT = 16;

const runtimes = new Map<string, BrowserAgentRuntime>();

/**
 * 会话归属（Session Authority）：同一个内置会话同一时刻只能由一个运行时打开写入。
 * 画布会话卡在面板忙时另起的「后台运行时」认领它跑的会话；面板主运行时切到被认领的会话会被拒绝（SESSION_BUSY），
 * 等后台这一轮结束、运行时关闭后自动释放。不同会话互不影响。
 */
const sessionClaims = new Map<string, BrowserAgentRuntime>();
const claimKey = (projectId: string, sessionId: string) => projectId + '\u0000' + sessionId;

/** 该会话正被另一个运行时认领（后台运行中）。 */
export function browserAgentSessionClaimed(projectId: string, sessionId: string, except?: BrowserAgentRuntime): boolean {
  const owner = sessionClaims.get(claimKey(projectId, sessionId));
  return Boolean(owner && owner !== except && !owner.isClosed);
}

interface SnapshotMessage {
  role?: string;
  text?: string;
  toolName?: string;
  isError?: boolean;
}

interface RuntimeSnapshot {
  sessionId?: string;
  running?: boolean;
  messages?: SnapshotMessage[];
}

/**
 * 委派回合的审批上下文：无人值守（headless），与面板走同一个解析器。
 * - 默认 read-only → always-ask：只有 read 自动放行，write / exec 解析为 prompt 后被拒绝；
 * - workspace-write → write：read + write 放行，exec（付费、删除等）被拒绝。
 * 用户的按工具策略照旧生效（deny 绝对；allow 只能在 maxTier 以内放行），会话授权不生效。
 * 与 OMP 子代理用 yolo 不同：这里的委派方是外部 Agent，授权边界是调用方声明的 policy，不能升级。
 */
export function delegatedPolicyFor(policy?: DelegatedTurnPolicy, base?: ApprovalContext): ApprovalContext {
  const mode: ApprovalMode = policy === 'workspace-write' ? 'write' : 'always-ask';
  return {
    mode,
    ...(base?.userPolicy ? { userPolicy: base.userPolicy } : {}),
    headless: true,
    // 用户的按工具 allow 不能把委派回合升级到声明的 policy 之上。
    maxTier: policy === 'workspace-write' ? 'write' : 'read',
  };
}

export class BrowserAgentRuntime {
  private readonly listeners = new Set<RuntimeListener>();
  private readonly turnInFlight = new Map<string, Promise<DelegatedTurnResult>>();
  private readonly turnResults = new Map<string, DelegatedTurnResult>();
  private detach: (() => void) | undefined;
  private closed = false;
  private delegated = false;

  private constructor(
    readonly projectId: string,
    private readonly kernel: RuntimeKernel,
    private readonly policyState: { override: DelegatedTurnPolicy | 'default' | null },
    private readonly getDraftVersion?: () => number | undefined,
  ) {}

  /** 创建并打开会话，注册到项目维度；同一项目后连的实例覆盖注册。 */
  static async connect(
    deps: BrowserAgentRuntimeDeps,
    /**
     * register=false：不登记为项目的活动运行时（画布后台运行时用，委派回合与命令面仍只找面板主运行时）。
     * session：后台运行时打开指定会话（认领它）或新建一个会话（认领新会话）。
     */
    options: { kernel?: RuntimeKernel; register?: boolean; session?: { id: string } | 'new' } = {},
  ): Promise<BrowserAgentRuntime> {
    const policyState = { override: null as DelegatedTurnPolicy | 'default' | null };
    // 技能：打包的 .agents/skills 立即可用；有本机 Agent 服务时再补上它注册表里安装的技能（失败忽略）。
    const skillCatalog = new MergedSkillCatalog();
    if (!options.kernel) {
      void createLocalSkillRegistry()
        .then(registry => (registry?.readSkillFile ? skillCatalog.attachRemote({
          listLocalSkills: () => registry.listLocalSkills(),
          readSkillFile: (id, path) => registry.readSkillFile!(id, path),
        }) : undefined))
        .catch(() => undefined);
    }
    const kernel = options.kernel ?? new BrowserAgentKernel({
      projectId: deps.projectId,
      route: deps.route,
      tools: createBrowserAgentTools({
        projectId: deps.projectId,
        confirm: deps.confirm,
        ask: deps.ask,
        activeChangeSetId: '',
        getNodes: deps.getNodes,
        // 委派回合进行时强制套用无人值守的受限上下文，不跟随面板模式（只沿用用户的按工具策略）。
        getApproval: () => (policyState.override
          ? delegatedPolicyFor(policyState.override === 'default' ? undefined : policyState.override, deps.getApproval?.())
          : deps.getApproval?.() ?? { mode: 'always-ask' }),
        webSearch: deps.webSearch,
      }),
      confirm: deps.confirm,
      systemPrompt: deps.systemPrompt,
      skillCatalog,
      ...(deps.getThinkingLevel ? { getThinkingLevel: deps.getThinkingLevel } : {}),
      ...(deps.contextWindow ? { contextWindow: deps.contextWindow } : {}),
    });
    await kernel.openSession();
    const runtime = new BrowserAgentRuntime(deps.projectId, kernel, policyState, deps.getDraftVersion);
    runtime.detach = kernel.subscribe(event => {
      for (const listener of runtime.listeners) listener(event);
    });
    if (options.session) {
      if (options.session === 'new') await kernel.newSession({ fresh: true });
      else {
        if (browserAgentSessionClaimed(deps.projectId, options.session.id, runtime)) {
          await kernel.close();
          throw new AgentRuntimeError('AGENT_BUSY', '这个会话正在另一处运行。');
        }
        await kernel.openSessionById(options.session.id);
      }
      const sessionId = String((await kernel.snapshot() as RuntimeSnapshot).sessionId || '');
      if (sessionId) runtime.claim(sessionId);
    }
    if (options.register !== false) runtimes.set(deps.projectId, runtime);
    return runtime;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  subscribe(listener: RuntimeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  snapshot(): Promise<unknown> {
    return this.kernel.snapshot();
  }

  send(text: string, images?: ImageContent[], skillAttachment?: ProductionSkillAttachment | null, turnContext?: TurnContextDraft | null): Promise<unknown> {
    return turnContext ? this.kernel.send(text, images, skillAttachment, turnContext) : this.kernel.send(text, images, skillAttachment);
  }

  cancel(): void {
    this.kernel.cancel();
  }

  /** 运行中把新消息作为插话注入当前这一轮（下一个步骤边界生效）；没在跑或不支持时返回 false。 */
  steer(text: string, images?: ImageContent[], id?: string, turnContext?: TurnContextDraft | null): boolean {
    return (turnContext ? this.kernel.steer?.(text, images, id, turnContext) : this.kernel.steer?.(text, images, id)) ?? false;
  }

  withdrawSteer(id: string): boolean {
    return this.kernel.withdrawSteer?.(id) ?? false;
  }

  takePendingSteers(): string[] {
    return this.kernel.takePendingSteers?.() ?? [];
  }

  listSessions(): Promise<Array<{ id: string; title: string; updatedAt: string }>> {
    return this.kernel.listSessions();
  }

  newSession(): Promise<unknown> {
    return this.kernel.newSession();
  }

  openSessionById(sessionId: string): Promise<unknown> {
    // Session Authority：后台运行时正在跑的会话不能同时被另一个运行时打开写入。
    if (browserAgentSessionClaimed(this.projectId, sessionId, this)) {
      return Promise.reject(new AgentRuntimeError('AGENT_BUSY', '这个会话正在画布上运行，这一轮结束后再打开。'));
    }
    return this.kernel.openSessionById(sessionId);
  }

  private claimed: string | null = null;
  /** 认领一个会话（后台运行时）；关闭时释放。 */
  claim(sessionId: string): void {
    if (this.claimed) sessionClaims.delete(claimKey(this.projectId, this.claimed));
    this.claimed = sessionId;
    sessionClaims.set(claimKey(this.projectId, sessionId), this);
  }

  deleteSession(sessionId: string): Promise<void> {
    return this.kernel.deleteSession(sessionId);
  }

  branchSession(fromSessionId: string, upto: string | readonly string[]): Promise<unknown> {
    return this.kernel.branchSession(fromSessionId, upto);
  }

  /** 手动压缩当前会话的上下文（/compact [聚焦说明]，或会话菜单「压缩上下文」）。 */
  async compactContext(focus?: string): Promise<CompactContextResult> {
    if (!this.kernel.compactContext) throw new AgentRuntimeError('BAD_REQUEST', '当前 Agent 不支持手动压缩上下文。');
    const value = String(focus || '').trim();
    return value ? this.kernel.compactContext(value) : this.kernel.compactContext();
  }

  /**
   * 外部 Agent 委派的一轮：默认只读、只回摘要、同一 mutationId 幂等、一次只跑一轮。
   * 调用方负责先确认（命令面在 write 委派时问用户）。
   */
  runDelegatedTurn(request: DelegatedTurnRequest): Promise<DelegatedTurnResult> {
    const mutationId = String(request.mutationId || '').trim();
    if (!mutationId) return Promise.reject(new AgentRuntimeError('BAD_REQUEST', 'agent.turn 需要 mutationId。'));
    if (!String(request.prompt || '').trim()) return Promise.reject(new AgentRuntimeError('BAD_REQUEST', 'agent.turn 需要 prompt。'));
    const cached = this.turnResults.get(mutationId);
    if (cached) return Promise.resolve(cached);
    const pending = this.turnInFlight.get(mutationId);
    if (pending) return pending;
    if (this.delegated) return Promise.reject(new AgentRuntimeError('AGENT_BUSY', '内置 Agent 正在执行委派回合，请稍后再试。'));
    // 同步占位：两次并发调用不能都走到 performDelegatedTurn 的异步检查。
    this.delegated = true;

    const promise = this.performDelegatedTurn({ ...request, mutationId })
      .then(result => {
        this.turnResults.set(mutationId, result);
        while (this.turnResults.size > TURN_LEDGER_LIMIT) {
          const oldest = this.turnResults.keys().next().value;
          if (oldest === undefined) break;
          this.turnResults.delete(oldest);
        }
        return result;
      })
      .finally(() => {
        this.delegated = false;
        this.turnInFlight.delete(mutationId);
      });
    this.turnInFlight.set(mutationId, promise);
    return promise;
  }

  private async performDelegatedTurn(request: DelegatedTurnRequest): Promise<DelegatedTurnResult> {
    if (this.closed) throw new AgentRuntimeError('AGENT_RUNTIME_CLOSED', '内置 Agent 已关闭，请重新打开画布后再试。');
    const before = await this.kernel.snapshot() as RuntimeSnapshot;
    if (before.running) throw new AgentRuntimeError('AGENT_BUSY', '内置 Agent 正在处理上一条消息，请稍后再试。');
    if (request.sessionId && request.sessionId !== before.sessionId) {
      await this.kernel.openSessionById(request.sessionId);
    }
    const baseline = ((await this.kernel.snapshot() as RuntimeSnapshot).messages || []).length;
    this.policyState.override = request.policy ?? 'default';
    try {
      await this.kernel.send(request.prompt);
    } catch (cause) {
      throw new AgentRuntimeError('AGENT_TURN_FAILED', cause instanceof Error ? cause.message : String(cause));
    } finally {
      this.policyState.override = null;
    }
    const after = await this.kernel.snapshot() as RuntimeSnapshot;
    const messages = (after.messages || []).slice(baseline);
    const text = messages
      .filter(message => message.role === 'assistant' && message.text)
      .map(message => message.text as string)
      .join('\n\n')
      .trim();
    const toolCalls = messages
      .filter(message => message.role === 'tool')
      .map(message => ({ name: message.toolName || 'tool', status: message.isError ? 'error' as const : 'success' as const }));
    const truncated = text.length > MAX_SUMMARY_CHARACTERS;
    return {
      sessionId: String(after.sessionId || before.sessionId || ''),
      text: truncated ? `${text.slice(0, MAX_SUMMARY_CHARACTERS)}…` : text,
      toolCalls,
      ...(truncated ? { truncated } : {}),
      ...(this.getDraftVersion?.() === undefined ? {} : { draftVersion: this.getDraftVersion!() }),
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.detach?.();
    this.detach = undefined;
    this.listeners.clear();
    this.turnInFlight.clear();
    this.turnResults.clear();
    await this.kernel.close();
    if (this.claimed && sessionClaims.get(claimKey(this.projectId, this.claimed)) === this) sessionClaims.delete(claimKey(this.projectId, this.claimed));
    this.claimed = null;
    if (runtimes.get(this.projectId) === this) runtimes.delete(this.projectId);
  }
}

/** 当前页面里该项目的活动运行时；没有或已关闭时返回 null。 */
export function getBrowserAgentRuntime(projectId: string): BrowserAgentRuntime | null {
  const runtime = runtimes.get(projectId);
  return runtime && !runtime.isClosed ? runtime : null;
}
