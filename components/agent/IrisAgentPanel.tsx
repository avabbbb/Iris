import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { AtSign, BookMarked, Box, Check, ChevronDown, ChevronLeft, Copy, GitBranch, Hand, Image as ImageIcon, KeyRound, LayoutGrid, Minimize2, Plus, Quote, RotateCw, Send, Square, Trash2, Video, X, Zap } from 'lucide-react';
import { useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import { AGENT_ATTACHMENT_MAX, composerAttachmentsToImages, createComposerAttachment, mergeComposerAttachments, releaseComposerAttachment, type AgentComposerAttachment } from '../../services/agentComposerAttachments';
import { getManagedAgentConnection } from '../../services/managedAgentConnection';
import { isTauri } from '@tauri-apps/api/core';
import {
  ManagedIrisAgentClient,
  type IrisAgentSnapshot,
  type IrisAgentTurnEvent,
} from '../../services/managedIrisAgent';
import { setAgentGateKeysProvider, WorkflowAgentBridge } from '../../services/workflowAgentBridge';
import { notifyAgentLinkDecision, notifyAgentLinkRunner, registerAgentLinkHost } from '../../services/link/agentLinkHost';
import { WorkflowAgentMessages, type WorkflowAgentDisplayMessage } from '../workflow/WorkflowAgentMessages';
import type { AgentCompactionLive } from './AgentCompaction';
import type { WorkflowNode, WorkflowProject } from '../workflow/types';
import { useWorkflowStore } from '../workflow/store';
import { insertLocalImagesIntoProject } from '../workflow/WorkflowWorkspace';
import type { AgentPanelStatus } from './agentWorkspaceStore';
import { consumeSpendMandate, createSpendMandate, defaultMandateTasks, describeMandateDenial, evaluateSpendMandate, planBlocked, spendDemand, type AgentConfirmRequest, type AgentSpendMandate } from '../../services/agentSpendMandate';
import { ProductionSkillDeck } from './ProductionSkillDeck';
import {
  createProductionSkillAttachment,
  createSkillAttachment,
  getBundledProductionSkill,
  type ProductionSkillAttachment,
} from '../../services/productionSkillCatalog';
import { canvasSkillDraftPayload, canvasSkillId, createLocalSkillRegistry } from '../../services/localSkillRegistry';
import { consumePendingProductionSkill } from '../../stores/useProductionSkillComposerStore';
import { BROWSER_DEFAULT_SYSTEM_PROMPT, resolveBrowserAgentTextRoute, type AgentAskRequest, type AgentAskResult } from '../../services/browserAgentKernel';
import { BrowserAgentRuntime } from '../../services/browserAgentRuntime';
import { loadAgentNodeMedia } from '../../services/agentMediaView';
import { formatReceiptContext } from '../../services/agentReceipts';
import { useAgentReceiptStore } from '../../stores/useAgentReceiptStore';
import { useAgentMemoryStore } from '../../stores/useAgentMemoryStore';
import { displayError as toDisplayError } from '../../services/displayError';
import { agentSetupMessage, classifyAgentSetupError, type AgentSetupBlocker } from '../../services/runtimeHealth';
import { useWorkspaceStore } from '../../stores/useWorkspaceStore';
import { translations } from '../../utils/translations';
import type { AssetLibrary, UserApiKey } from '../../types';
import { AgentEmptyState, CreationModeMenuSection, CreationModeTag, type AgentModelSelection, type AgentQuickAction } from './AgentComposerExtras';
import { AgentModelPicker } from './AgentModelPicker';
import { isComposingEvent, useMenuKeyboard } from '../../hooks/useListboxKeyboard';
import { applyAgentTurnPreamble, recipeFromNodes, skillFromRecipe, type AgentCreationMode } from '../../services/canvasSkillRecipe';
import { useAgentGroupInboxStore, type AgentGroupPayload } from '../../stores/useAgentGroupInboxStore';
import { useUserSkillsStore } from '../../stores/useUserSkillsStore';
import { isUserSkillAttachment, skillSystemContext } from '../../services/userSkillContext';
import { AgentReferenceChip } from './AgentReferenceChip';
import { ContextCardReview, defaultContextCardTitle, type ContextCardReviewDraft } from './ContextCardReview';
import { commitContextCard, planContinueDiscussion, type ContextCardSourceMessage } from '../workflow/contextCard';
import { agentSessionTurnReferences, bindAgentSessionCard, isAgentSessionNode, recordAgentSessionTurn } from '../workflow/agentSessionCard';
import { useCanvasAgentStore, type CanvasAgentApprovalHandler, type CanvasAgentStopHandler } from '../../stores/useCanvasAgentStore';
import { agentHarnessIdentity, currentTurnMessages, reduceAgentSessionTrace, resolveCardApprovalDecision, type AgentSessionApproval } from '../workflow/agentSessionTrace';
import { CanvasSessionRunners, defaultRunnerStorage, type CanvasRunnerRequest, type CanvasRunnerState, type CanvasSessionRunnerDeps } from './canvasSessionRunners';
import { cardApprovalFrom, runnerLive } from './canvasRunnerProjection';
import { consumeWorkflowAgentDrawerTarget, subscribeWorkflowAgentDrawer } from '../workflow/agentDrawerRequest';
import { agentThinkingVersion, availableThinkingLevels, effectiveAgentThinkingLevel, subscribeAgentThinking } from '../../services/agentThinking';
import { thinkingLevelText } from './ThinkingLevelBadge';
import type { AgentMessageReference } from './agentMessageRefs';
import { copyToClipboard, transcriptMarkdown } from './agentTranscript';
import { resolveSearchCredential } from '../../services/agentWebSearch';
import { readApprovalMode, readUserToolPolicy, resolveToolApproval, sessionGrantKey, toolApprovalFor, writeApprovalMode, writeUserToolPolicy, type ApprovalContext, type ApprovalMode, type ToolPolicy } from '../../services/agentToolPolicy';
import { AgentHeaderLeadingContext } from './agentHeaderSlot';
import { DrawerChromeCollapse, DrawerChromeTabs } from '../studio/drawerChrome';
import { AgentConfirmCard } from './AgentConfirmCard';
import { ReferencePreview } from './AgentReferencePreview';
import { matchesReference, nextHighlight } from './pickerNavigation';
import { AgentAskCard } from './AgentAskCard';
import '../../styles/agentComposer.css';
import { parseAgentAskHtml, type AgentAskForm } from './agentAskForm';
import { confirmGrantKey, confirmScopesFor, type AgentConfirmScope } from './agentConfirmCopy';
import { displayUserTurnText, agentToolLabel, userAttachmentThumbs, withoutAttachmentLine } from './agentTurnText';
import { applyThinkingDelta, applyTextDelta, carryLiveState, finishThinking } from './agentStreamMessages';
import { agentWorkingMeta, agentWorkingPhase } from './agentWorkingPhase';
import { AgentMediaTiles } from './AgentMediaTiles';
import { referenceLineLabels, userTurnReferences } from './agentMessageRefs';
import type { ImageContent } from '@earendil-works/pi-ai';
import { buildTurnContextDraft, sentNodeMedia, turnContextReferences, type NodeMediaSent, type TurnContextDraft, type TurnContextRecord } from '../../services/turnContext';
import { abortedNoticeText, isAbortMessage } from './agentAbort';
import { AgentInputQueueTray } from './AgentInputQueueTray';
import { draftHasContent, draftIsEmpty, draftPreview, mergeDrafts, moveToFront, popLastQueued, promoteToSteer, queuedCount, removeInput, requeueSteers, routeRunningSubmit, shiftQueued, trayOrder, type ComposerDraft, type PendingInput, type RunningSubmitKey } from './agentInputQueue';
import { AgentRunPlanCard } from './AgentRunPlanCard';
import { isRunPlanRequest, runPlanApproved, runPlanNodeIds, type RunPlanDecision } from './agentRunPlan';
import { clearRunPlans, readRunPlans, saveRunPlan } from './agentRunPlanStore';
import { readConfirmVerdict, runPlanDenialNote, type AgentConfirmVerdict } from '../../services/runApproval';
import { AgentScrollToLatest, AgentTurnTimeline, activeMessageScroller, messageScrollers, smoothScrollTo } from './AgentConversationNav';
import { isAwayFromBottom, nextStickToBottom, splitConversationTurns } from './agentConversationNavModel';
import { quotePreview, withQuote } from './agentQuote';
import { agentSlashCommands, insertSlashCommand, type AgentSlashCommand } from './agentSlashCommands';
import { parseCompactCommand } from '../../services/agentCompaction';
import { activityAfterConfirmation, advanceConfirmation, agentLayerReducer, blockerAfterCredentialSignal, closedLayers, enqueueConfirmation, needsCredential, rejectAllConfirmations, useAgentTurn, type ConfirmationQueue } from './agentPanelState';

interface IrisAgentPanelProps {
  project: WorkflowProject;
  onActivityChange: (status: AgentPanelStatus) => void;
  onOpenSettings: () => void;
  assetLibrary?: AssetLibrary;
  onFocusNode?: (nodeId: string) => void;
  /** 浏览器内置 PI 内核的 agent-text 线路来源（OpenAI 兼容 Key 的模型映射） */
  userApiKeys?: UserApiKey[];
  /** 模型选择器里新增 Key / 切换 agent-text 模型，直接写入全局 AI 服务设置 */
  onAddApiKey?: (payload: Omit<UserApiKey, 'id' | 'createdAt' | 'updatedAt'>) => void;
  onUpdateApiKey?: (id: string, patch: Partial<Omit<UserApiKey, 'id' | 'createdAt'>>) => void;
  /** 就绪且空闲时输入框的占位文案（Iris 故事版用「开始你的创作，或者 @ 引用…」）；缺省为抽屉文案。 */
  composerPlaceholder?: string;
}

interface AgentReference {
  id: string;
  type: 'node' | 'asset';
  label: string;
  mediaType?: string;
  /** 来自画布「添加到 Agent」分组：发送时冻结进本轮来源记录。 */
  group?: { label: string; batchId?: string };
}

function isAgentTextConfigurationError(error?: string) {
  const message = String(error || '').toLowerCase();
  return message.includes('no agent-text route')
    || message.includes('no configured agent-text credential');
}

function agentMessageText(error: string, language: 'en' | 'zho') {
  return isAgentTextConfigurationError(error) ? translations[language].agentPanel.textRouteRequired : toDisplayError(error);
}

function localizedAgentSetupMessage(kind: AgentSetupBlocker, cause: unknown, language: 'en' | 'zho') {
  if (kind === 'credential') return translations[language].agentPanel.setupCredential;
  if (kind === 'offline') return translations[language].agentPanel.setupOffline;
  return agentSetupMessage(kind, cause);
}

function formatSessionTime(value: string, language: 'en' | 'zho') {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return '';
  const delta = Date.now() - time;
  if (language === 'en') {
    if (delta < 60_000) return 'Just now';
    if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} min ago`;
    if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} hr ago`;
  } else {
    if (delta < 60_000) return '刚刚';
    if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
    if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  }
  return new Date(time).toLocaleDateString(language === 'en' ? 'en-US' : 'zh-CN', { month: 'numeric', day: 'numeric' });
}

function snapshotNeedsConfiguration(snapshot: IrisAgentSnapshot) {
  const latestAssistant = [...snapshot.messages].reverse().find(message => message.role === 'assistant');
  return isAgentTextConfigurationError(latestAssistant?.error);
}

/** 这一轮是否失败：只看最新一条助手消息，且用户停止不算失败（历史里的旧错误不能让之后每轮都标红）。 */
function latestTurnFailed(snapshot: { messages: Array<{ role: string; error?: string }> }) {
  const latest = [...snapshot.messages].reverse().find(message => message.role === 'assistant');
  return Boolean(latest?.error && !isAbortMessage(latest.error));
}

/** 自动压缩发生在一轮开头：只把快照里新出现的分隔条插到现有消息里（不打断本轮的流式消息）。 */
function mergeCompactionDivider(items: WorkflowAgentDisplayMessage[], fromSnapshot: WorkflowAgentDisplayMessage[]) {
  const known = new Set(items.map(item => item.id));
  const fresh = fromSnapshot.filter(item => item.compaction && !known.has(item.id));
  if (!fresh.length) return items;
  // 放在最后一条用户消息之前（压缩发生在发送这一条之前），没有就放末尾。
  let at = items.length;
  for (let index = items.length - 1; index >= 0; index -= 1) if (items[index].role === 'user') { at = index; break; }
  return [...items.slice(0, at), ...fresh, ...items.slice(at)];
}

function displayMessages(snapshot: {
  messages: Array<{ id: string; role: string; text: string; thinking?: string; toolName?: string; toolCallId?: string; isError?: boolean; timestamp?: number; error?: string; images?: Array<{ mimeType: string; data: string }>; compaction?: { tokensBefore: number }; turnContext?: TurnContextRecord; usage?: { input: number; output: number; reasoning?: number } }>;
  boundProductionSkill?: ProductionSkillAttachment | null;
}, language: 'en' | 'zho'): WorkflowAgentDisplayMessage[] {
  return snapshot.messages.map(message => {
    const thumbs = message.role === 'user' && !message.error ? userAttachmentThumbs(message.text, message.images) : [];
    return {
    id: message.id,
    // 用户停止显示为中性的「已中止」，不进红色错误卡。
    role: (message.error ? (isAbortMessage(message.error) ? 'system' : 'error') : message.role) as WorkflowAgentDisplayMessage['role'],
    text: message.error ? (isAbortMessage(message.error) ? abortedNoticeText(language) : agentMessageText(message.error, language)) : message.role === 'user' ? (thumbs.length ? withoutAttachmentLine(displayUserTurnText(message.text)) : displayUserTurnText(message.text)) : message.text,
    // 快照里的思考都已结束：收起显示（thinkingDone）。
    ...(message.role === 'assistant' && !message.error && message.thinking ? { thinking: message.thinking, thinkingDone: true } : {}),
    title: message.role === 'tool' ? agentToolLabel(message.toolName, language) : undefined,
    status: message.role === 'tool' ? message.isError ? 'error' : 'success' : undefined,
    createdAt: message.timestamp ? new Date(message.timestamp).toISOString() : undefined,
    ...(message.role === 'tool' ? { toolName: message.toolName, toolCallId: message.toolCallId } : {}),
    // 结构化来源记录优先（P0）；旧会话没有记录时才从文本里的「引用上下文」解析。
    ...(message.role === 'user' ? (message.turnContext?.sources.length ? { references: turnContextReferences(message.turnContext) } : userReferences(message.text)) : {}),
    ...(thumbs.length ? { attachments: thumbs } : {}),
    ...(message.compaction ? { compaction: message.compaction } : {}),
    ...(message.role === 'assistant' && message.usage ? { usage: message.usage } : {}),
  };
  });
}

/** 用户消息里的画布引用：优先读带 nodeId 的「引用上下文」，旧消息只剩「引用：@…」时按名字。 */
function userReferences(storedText: string): Pick<WorkflowAgentDisplayMessage, 'references'> {
  const withIds = userTurnReferences(storedText);
  if (withIds.length) return { references: withIds };
  const labels = referenceLineLabels(displayUserTurnText(storedText));
  return labels.length ? { references: labels.map(label => ({ kind: 'node' as const, label })) } : {};
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || 'Iris Agent 运行失败');
}

function toolResultText(result: unknown, language: 'en' | 'zho') {
  const content = (result as { content?: Array<{ type?: string; text?: string }> })?.content;
  return content?.filter(item => item.type === 'text').map(item => item.text).filter(Boolean).join('\n') || (language === 'en' ? 'Workflow operation completed.' : 'Workflow 操作已完成');
}

export function IrisAgentPanel({ project, onActivityChange, onOpenSettings, assetLibrary, onFocusNode, userApiKeys = [], onAddApiKey, onUpdateApiKey, composerPlaceholder }: IrisAgentPanelProps) {
  const client = useRef<ManagedIrisAgentClient | undefined>(undefined);
  const kernelRef = useRef<BrowserAgentRuntime | undefined>(undefined);
  const unsubscribeRef = useRef<(() => void) | undefined>(undefined);
  const unregisterLinkRef = useRef<(() => void) | undefined>(undefined);
const userApiKeysRef = useRef(userApiKeys);
  userApiKeysRef.current = userApiKeys;
  // 内核只在 route 变化时重建：无 Key 打开面板后再导入 Key/切模型，必须重新解析 route，否则一直停在 credential 阻塞。
  const searchCredential = useMemo(() => resolveSearchCredential(userApiKeys), [userApiKeys]);
  const browserRouteSignature = useMemo(() => {
    const route = resolveBrowserAgentTextRoute(userApiKeys);
    const search = resolveSearchCredential(userApiKeys);
    // 搜索凭证也决定工具集：换 Key 时必须重建内核，否则 iris_web_search 不会出现。
    const searchSignature = search ? search.baseUrl + '\u0000' + search.key : '';
    return route ? [route.provider, route.baseUrl, route.model, route.apiKey, route.streamUsage ?? '', searchSignature].join('\u0000') : '';
  }, [userApiKeys]);
  const workspaceBridge = useRef<WorkflowAgentBridge | undefined>(undefined);
  const abort = useRef<AbortController | undefined>(undefined);
  // 托管 Agent 当前回合的 id：停止只取消这一轮。
  const managedTurnId = useRef<string | undefined>(undefined);
  type PendingConfirmation = { id?: string; summary: string; resolve: (verdict: AgentConfirmVerdict) => void; request?: AgentConfirmRequest; offerMandate?: boolean; blocked?: boolean; turnIndex?: number };
  // 生成计划卡：用户做出选择后仍留在这一轮里，按画布节点实时显示「生成中 n/N → 已完成」。
  type TrackedRunPlan = { id: string; request: AgentConfirmRequest; decision: RunPlanDecision; decidedAt: number; turnIndex: number };
  type PendingAsk = { id: string; form: AgentAskForm; resolve: (result: AgentAskResult) => void };
  const composer = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  // 跟随到底部：贴近底部（或刚发送）时，新消息和流式增量自动滚到底；用户上翻阅读历史时不打扰。
  const stickToBottom = useRef(true);
  const skillAttachmentDirty = useRef(false);
  const activity = useRef(onActivityChange);
  // 审批模式（OMP approval mode）：always-ask / write（默认）/ yolo，存本机；旧的 manual/auto 自动迁移。
  const [initialMode] = useState<ApprovalMode>(() => readApprovalMode());
  const modeRef = useRef<ApprovalMode>(initialMode);
  const confirmationRef = useRef<ConfirmationQueue<PendingConfirmation>>({ current: undefined, waiting: [] });
  const [queuedConfirmations, setQueuedConfirmations] = useState(0);
  const askRef = useRef<PendingAsk | undefined>(undefined);
  // 自动模式付费授权：第一次生成时确认上限，之后上限内的生成自动批准。
  const mandateRef = useRef<AgentSpendMandate | null>(null);
  // 画布会话卡的后台运行（canvasSessionRunners）：面板忙时卡片请求不再排在面板后面。
  const runnersRef = useRef<CanvasSessionRunners | null>(null);
  // 这一轮是用户停下的（面板或卡片上的停止）：卡片显示「已停止」而不是出错 / 未读。
  const turnStoppedRef = useRef(false);
  const prepareCanvasRunRef = useRef<(request: CanvasRunnerRequest) => Promise<{ text: string; images?: ImageContent[]; turnContext?: TurnContextDraft | null }>>(async request => ({ text: request.text }));
  const projectRunnerRef = useRef<(state: CanvasRunnerState) => void>(() => undefined);
  const finishRunnerRef = useRef<(state: CanvasRunnerState) => void>(() => undefined);
  // 会话授权：「本会话总是允许此工具」覆盖同一工具、同一 tier 的后续调用；切换会话或项目时清空。
  const sessionGrantsRef = useRef(new Set<string>());
  // 按工具的用户策略（allow | deny | prompt），存本机，每种模式都生效，但绕不过工具自身的 deny 与安全覆盖。
  const [userToolPolicy, setUserToolPolicy] = useState<Record<string, ToolPolicy>>(() => readUserToolPolicy());
  const userToolPolicyRef = useRef(userToolPolicy);
  userToolPolicyRef.current = userToolPolicy;
  const approvalContext = useRef((): ApprovalContext => ({
    mode: modeRef.current,
    userPolicy: userToolPolicyRef.current,
    isGranted: (tool, tier) => sessionGrantsRef.current.has(sessionGrantKey(tool, tier)),
  })).current;
  // 内核工具（media_view）在会话期间读取最新画布节点。
  const projectRef = useRef(project);
  projectRef.current = project;
  const assetLibraryRef = useRef(assetLibrary);
  assetLibraryRef.current = assetLibrary;
  const [messages, setMessages] = useState<WorkflowAgentDisplayMessage[]>([]);
  // 计划卡挂在发起它的那一轮末尾：确认弹出时记下当前是第几轮。
  const userTurnCountRef = useRef(0);
  userTurnCountRef.current = messages.filter(message => message.role === 'user').length;
  const [prompt, setPrompt] = useState('');
  const [skillAttachment, setSkillAttachment] = useState<ProductionSkillAttachment>();
  const [status, setStatus] = useState<'connecting' | 'ready' | 'error'>('connecting');
  const [workspaceStatus, setWorkspaceStatus] = useState<'connecting' | 'ready' | 'error'>('connecting');
  // 一轮对话的显式状态：idle | sending | awaitingConfirmation | stopping；sending 只是派生值。
  const { turn, turnRef, dispatchTurn } = useAgentTurn();
  const sending = turn.phase !== 'idle';
  // 内核只在空闲时换线路：运行中改 Key / 切模型不能销毁内核（那会 abort 正在跑的一轮，
  // 会话里留下 "signal is aborted without reason"），等这一轮结束再重建。
  const [kernelRouteSignature, setKernelRouteSignature] = useState(browserRouteSignature);
  useEffect(() => {
    if (!sending) setKernelRouteSignature(browserRouteSignature);
  }, [browserRouteSignature, sending]);
  const [turnStartedAt, setTurnStartedAt] = useState<number>();
  const [confirmation, setConfirmation] = useState<PendingConfirmation>();
  const [pendingAsk, setPendingAsk] = useState<PendingAsk>();
  const [mandate, setMandate] = useState<AgentSpendMandate | null>(null);
  const [mandateTasks, setMandateTasks] = useState(10);
  const [mode, setMode] = useState<ApprovalMode>(initialMode);
  const hasMessages = messages.length > 0;
  // 「回到最新消息」：离底超过 1/3 屏时显示。跟随底部只在用户没往上翻时生效，流式输出不会把人拉回底部。
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  useLayoutEffect(() => {
    const scrollers = messageScrollers(messagesRef.current);
    const lastTop = new WeakMap<HTMLElement, number>();
    const onScroll = (event: Event) => {
      const el = event.currentTarget as HTMLElement;
      if (el !== activeMessageScroller(messagesRef.current)) return;
      const metrics = { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
      stickToBottom.current = nextStickToBottom(stickToBottom.current, metrics, lastTop.get(el) ?? el.scrollTop);
      lastTop.set(el, el.scrollTop);
      setAwayFromBottom(isAwayFromBottom(metrics));
    };
    scrollers.forEach(el => el.addEventListener('scroll', onScroll, { passive: true }));
    return () => scrollers.forEach(el => el.removeEventListener('scroll', onScroll));
  }, [hasMessages]);
  const [trackedPlans, setTrackedPlans] = useState<TrackedRunPlan[]>([]);
  const trackedPlansRef = useRef<TrackedRunPlan[]>([]);
  trackedPlansRef.current = trackedPlans;
  useLayoutEffect(() => {
    if (!stickToBottom.current) {
      const el = activeMessageScroller(messagesRef.current);
      if (el) setAwayFromBottom(isAwayFromBottom({ scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }));
      return;
    }
    for (const el of messageScrollers(messagesRef.current)) el.scrollTop = el.scrollHeight;
    setAwayFromBottom(false);
  }, [messages, sending, confirmation, trackedPlans]);
  const scrollToLatest = () => {
    stickToBottom.current = true;
    setAwayFromBottom(false);
    const el = activeMessageScroller(messagesRef.current);
    if (el) smoothScrollTo(el, el.scrollHeight);
  };
  // 引用回复：输入框上方的引用条；发送时以 Markdown 引用块拼进这条用户消息。
  const [quote, setQuote] = useState<{ messageId: string; text: string } | null>(null);
  // 面板内所有浮层共用一个 openLayer：同一时刻只开一个，Escape/外部点击统一关闭。
  const [layers, dispatchLayer] = useReducer(agentLayerReducer, closedLayers);
  const { layer: openLayer, slashQuery } = layers;
  const modeOpen = openLayer === 'mode';
  const sessionsOpen = openLayer === 'sessions';
  const mentionOpen = openLayer === 'mention';
  const attachmentOpen = openLayer === 'attachment';
  const modelPickerOpen = openLayer === 'modelPicker';
  // 历史对话菜单：打开即聚焦，↑/↓ 在条目间移动，首字母跳转，Esc 关闭。
  const sessionMenuKeys = useMenuKeyboard({ open: sessionsOpen, onClose: () => dispatchLayer({ type: 'close', layer: 'sessions' }) });
  // 「+」菜单（引用 / 创作模式）：↑/↓ 在条目间移动，Esc 关闭。
  const attachmentMenuKeys = useMenuKeyboard({ open: attachmentOpen, onClose: () => dispatchLayer({ type: 'close', layer: 'attachment' }) });
  const skillOpen = openLayer === 'skill';
  const [references, setReferences] = useState<AgentReference[]>([]);
  // 对话框本地附件（粘贴截图 / 拖入视频）：只在当轮对话里作为图片内容发送，不写画布。
  const [attachments, setAttachments] = useState<AgentComposerAttachment[]>([]);
  // 复制反馈：按钮短暂显示「已复制」。
  const [copiedNotice, setCopiedNotice] = useState<string | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attachmentsRef = useRef<AgentComposerAttachment[]>([]);
  attachmentsRef.current = attachments;
  const [attachDragActive, setAttachDragActive] = useState(false);
  const attachDragDepth = useRef(0);
  const [mentionQuery, setMentionQuery] = useState('');
  const [creationMode, setCreationMode] = useState<AgentCreationMode>('all');
  const [preferredModel, setPreferredModel] = useState<AgentModelSelection | null>(null);
  // ProductionSkillDeck 注册的键盘处理：返回 true 表示该按键已被 Skill 列表消费。
  const skillNav = useRef<((key: string) => boolean) | null>(null);
  const [groupBanner, setGroupBanner] = useState<(AgentGroupPayload & { saved?: boolean; installed?: boolean; evaluationNote?: string }) | null>(null);
  const presentConfirmation = (next: PendingConfirmation) => {
    const pending = next.id ? next : { ...next, id: crypto.randomUUID() };
    // 并行工具调用的确认排队逐张出，不顶替（顶替会把前一张静默判成拒绝）。
    const shown = enqueueConfirmation(confirmationRef.current, pending);
    setQueuedConfirmations(confirmationRef.current.waiting.length);
    if (!shown) return;
    setConfirmation(pending);
    dispatchTurn({ type: 'confirmRequested' });
    activity.current('waiting');
  };
  const settleConfirmation = (pending: PendingConfirmation, approved: AgentConfirmVerdict) => {
    if (confirmationRef.current.current !== pending) return;
    const nextActivity = activityAfterConfirmation(turnRef.current.phase);
    pending.resolve(approved);
    // 刚授予的本会话授权覆盖排队里的同类调用：直接放行，不再弹同一张卡。
    const following = advanceConfirmation(confirmationRef.current, item => {
      const key = confirmGrantKey(item.request);
      return Boolean(key && !item.blocked && confirmScopesFor(item.request).includes('session') && sessionGrantsRef.current.has(key));
    });
    setQueuedConfirmations(confirmationRef.current.waiting.length);
    setConfirmation(following);
    if (following) return;
    dispatchTurn({ type: 'confirmResolved' });
    if (nextActivity) activity.current(nextActivity);
  };
  const rejectConfirmations = () => {
    rejectAllConfirmations(confirmationRef.current);
    setQueuedConfirmations(0);
    setConfirmation(undefined);
  };
  const presentAsk = (request: AgentAskRequest): Promise<AgentAskResult> => {
    // 结构化提问已在内核里校验成表单；旧的 html 契约仍按受控字段解析。
    const parsed = request.form ? { ok: true as const, form: request.form } : parseAgentAskHtml(request.html || '');
    if ('error' in parsed) return Promise.resolve({ ok: false, error: parsed.error });
    askRef.current?.resolve({ ok: false, error: '新的提问替换了本次提问。' });
    return new Promise(resolve => {
      const pending = { id: crypto.randomUUID(), form: parsed.form, resolve };
      askRef.current = pending;
      setPendingAsk(pending);
      dispatchTurn({ type: 'confirmRequested' });
      activity.current('waiting');
    });
  };
  const settleAsk = (pending: PendingAsk, result: AgentAskResult) => {
    if (askRef.current?.id !== pending.id) return;
    const nextActivity = activityAfterConfirmation(turnRef.current.phase);
    askRef.current = undefined;
    pending.resolve(result);
    setPendingAsk(undefined);
    dispatchTurn({ type: 'confirmResolved' });
    if (nextActivity) activity.current(nextActivity);
  };
  const decideConfirmation = (pending: PendingConfirmation, approved: boolean, scope: AgentConfirmScope) => {
    if (approved && scope !== 'once') {
      const request = pending.request;
      if (pending.offerMandate && request?.kind === 'generation') {
        // 本次对话的付费授权仍走任务上限：上限内自动批准，超出再问。
        const granted = consumeSpendMandate(createSpendMandate({ maxTasks: Math.max(mandateTasks, spendDemand(request.gates).tasks) }), request);
        mandateRef.current = granted;
        setMandate(granted);
      } else {
        const key = confirmGrantKey(request);
        if (key && scope === 'session') sessionGrantsRef.current.add(key);
      }
    }
    settleConfirmation(pending, approved);
  };
  /** 生成计划卡的三个选择：仍是同一个确认请求；只有「创建并自动生成」批准，另两个带说明拒绝。 */
  const decideRunPlan = (pending: PendingConfirmation, decision: RunPlanDecision, options: { session: boolean }) => {
    const request = pending.request;
    if (request) {
      const tracked: TrackedRunPlan = { id: pending.id || crypto.randomUUID(), request, decision, decidedAt: Date.now(), turnIndex: pending.turnIndex ?? 0 };
      setTrackedPlans(current => [...current.filter(item => item.id !== tracked.id), tracked]);
      // 计划卡随会话保存：切换会话、刷新后回到这段对话仍挂在原来那一轮。
      saveRunPlan(projectRef.current.id, activeSessionIdRef.current, tracked);
    }
    if (runPlanApproved(decision)) {
      decideConfirmation(pending, true, options.session ? 'session' : 'once');
      return;
    }
    settleConfirmation(pending, { approved: false, note: runPlanDenialNote(decision === 'manual' ? 'manual' : 'adjust', runPlanNodeIds(request).length) });
    if (decision === 'adjust') focusComposer();
  };
  const askConfirmation = useRef((summary: string, request?: AgentConfirmRequest): Promise<AgentConfirmVerdict> => {
    // 停止中的轮次不再弹确认卡：直接拒绝，让内核尽快收尾。
    if (turnRef.current.phase === 'stopping') return Promise.resolve(false);
    const current = mandateRef.current;
    // 付费授权只在 write / yolo 模式生效；手动确认模式逐次询问。
    if (modeRef.current !== 'always-ask' && current && request && evaluateSpendMandate(current, request).allow) {
      const next = consumeSpendMandate(current, request);
      mandateRef.current = next;
      setMandate(next);
      return Promise.resolve(true);
    }
    const grantKey = confirmGrantKey(request);
    if (grantKey && !planBlocked(request) && confirmScopesFor(request).includes('session') && sessionGrantsRef.current.has(grantKey)) {
      return Promise.resolve(true);
    }
    return new Promise<AgentConfirmVerdict>(resolve => {
      const offerMandate = modeRef.current !== 'always-ask' && request?.kind === 'generation' && (request.gates?.length ?? 0) > 0 && !planBlocked(request);
      if (offerMandate) setMandateTasks(defaultMandateTasks(request));
      // 有计划时由 GenerationPlanCard 展示，文本摘要只给 CLI/无宿主。
      presentConfirmation({ summary: request?.gates?.length ? '' : summary, resolve, request, offerMandate, blocked: planBlocked(request), turnIndex: Math.max(0, userTurnCountRef.current - 1) });
    });
  }).current;
  // 只认批准 / 拒绝的入口（托管 Agent 的可逆写入确认）用这个；bridge 的生成确认直接拿带说明的结果。
  const askConfirmationBoolean = useRef((summary: string, request?: AgentConfirmRequest): Promise<boolean> =>
    askConfirmation(summary, request).then(verdict => readConfirmVerdict(verdict).approved)).current;
  useEffect(() => {
    setAgentGateKeysProvider(() => userApiKeysRef.current);
    return () => setAgentGateKeysProvider(null);
  }, []);
  const [replaceTarget, setReplaceTarget] = useState<AgentReference | null>(null);
  const [sessionList, setSessionList] = useState<Array<{ id: string; title: string; updatedAt: string }>>([]);
  // 会话菜单里切换「历史对话 / 项目记忆」两种列表；项目记忆与内置 Agent 共用同一个 store。
  const [sessionMenuView, setSessionMenuView] = useState<'sessions' | 'memory'>('sessions');
  const memoryEntries = useAgentMemoryStore(state => state.byProject[project.id]);
  useEffect(() => { void useAgentMemoryStore.getState().load(project.id).catch(() => undefined); }, [project.id]);
  const [activeSessionId, setActiveSessionId] = useState('');
  const activeSessionIdRef = useRef('');
  activeSessionIdRef.current = activeSessionId;
  useEffect(() => { sessionGrantsRef.current.clear(); }, [activeSessionId]);
  // 换会话 / 项目：引用条不跟过来（会话 id 第一次落定时不算换）；计划卡换成那段会话自己保存的。
  const previousSessionId = useRef('');
  useEffect(() => {
    const previous = previousSessionId.current;
    if (previous && previous !== activeSessionId) setQuote(null);
    previousSessionId.current = activeSessionId;
    if (!activeSessionId) { setTrackedPlans([]); return; }
    // 会话 id 第一次落定前已选择的卡（例如新会话的第一轮）归到这段会话，不丢。
    if (!previous) trackedPlansRef.current.forEach(plan => saveRunPlan(project.id, activeSessionId, plan));
    setTrackedPlans(readRunPlans(project.id, activeSessionId));
  }, [activeSessionId, project.id]);
  useEffect(() => { setQuote(null); }, [project.id]);
  // Lane15 first-run UX: setupBlocker classifies a cold-open/send failure via
  // the executor taxonomy (runtimeHealth) instead of raw strings, so the panel
  // can render a real next step ('Add API key') instead of a jargon dead end.
  const [setupBlocker, setSetupBlocker] = useState<AgentSetupBlocker | null>(null);
  const needsConfiguration = needsCredential(setupBlocker);
  const language = useWorkspaceStore(s => s.language);
  // 确认卡按节点标题描述操作：读画布的实时节点，Agent 刚建的节点也能叫出名字。
  const liveNodes = useWorkflowStore(s => s.projects.find(item => item.id === project.id)?.nodes) || project.nodes;
  const languageRef = useRef(language);
  languageRef.current = language;
  const t = useCallback((key: string, ...args: Array<number | string>): string => {
    const dict = translations[language] || translations.en;
    const value = key.split('.').reduce<unknown>((current, part) => {
      if (!current || typeof current !== 'object' || !(part in current)) return undefined;
      return (current as Record<string, unknown>)[part];
    }, dict as unknown);
    if (typeof value === 'function') return String(value(...args));
    return value === undefined ? key : String(value);
  }, [language]);

  const untitledAsset = t('agentPanel.referenceUntitledAsset');
  const referenceGroups = useMemo(() => {
    // @ 后实时筛选：名称子串（忽略空格）或类型词（图片 / 视频 / image…），见 pickerNavigation。
    const matches = (item: { label: string; mediaType?: string }) => matchesReference(item, mentionQuery);
    return {
      // 图片/视频节点排在前面，方便 @ 引用画面素材。
      nodes: project.nodes
        .filter(node => node.isVisible !== false)
        .map(node => ({ id: node.id, type: 'node' as const, label: node.title || '未命名节点', mediaType: node.type }))
        .filter(matches)
        .sort((a, b) => Number(a.mediaType !== 'image' && a.mediaType !== 'video') - Number(b.mediaType !== 'image' && b.mediaType !== 'video'))
        .slice(0, 60),
      assets: (assetLibrary?.items || [])
        .map(item => ({ id: item.id, type: 'asset' as const, label: item.name || untitledAsset, mediaType: item.mimeType }))
        .filter(matches)
        .slice(0, 60),
    };
  }, [assetLibrary?.items, mentionQuery, project.nodes, untitledAsset]);
  const mentionItems = useMemo<AgentReference[]>(() => [...referenceGroups.nodes, ...referenceGroups.assets], [referenceGroups]);
  const [mentionHighlight, setMentionHighlight] = useState(-1);
  const mentionListId = useId();
  const mentionOptionId = (reference: AgentReference) => `${mentionListId}-${reference.type}-${reference.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  // 打开或改变筛选时默认高亮第一项（Enter 直接选中最可能的那个）。
  useEffect(() => { setMentionHighlight(mentionItems.length ? 0 : -1); }, [mentionQuery, openLayer, mentionItems.length]);
  const highlightedReference = mentionHighlight >= 0 ? mentionItems[mentionHighlight] : undefined;

  useEffect(() => { activity.current = onActivityChange; }, [onActivityChange]);

  // UX-AGT-02: every popover in the agent panel (生成模式 menu, 历史对话 list,
  // @ picker, Skill picker) must dismiss on Escape and on outside click — the
  // standard transient-layer contract. While open they cover the composer
  // textarea, so leaving them pinned is a real blocker.
  useEffect(() => {
    if (openLayer === null) return;
    const closeAll = () => dispatchLayer({ type: 'closeAll' });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeAll();
    };
    const onPointer = (event: PointerEvent) => {
      const root = rootRef.current;
      if (!root) return;
      const target = event.target as Node | null;
      if (target && root.contains(target)) {
        // Click inside the panel — only dismiss if it landed outside the
        // popover/menu itself so clicks on menu items still register.
        const el = target as Element;
        if (el.closest?.('.agent-mode-menu, .agent-session-menu, .agent-mention-menu, .agent-reference-picker, .agent-attachment-menu, .agent-skill-picker, .studio-hub-layer, [aria-expanded="true"]')) return;
      }
      closeAll();
    };
    document.addEventListener('keydown', onKey);
    // pointerdown (not mousedown): the canvas uses React synthetic pointer
    // events that may preventDefault the mousedown that would follow, so a
    // mousedown listener can be flaky here — pointerdown is the reliable one.
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [openLayer]);
  useEffect(() => {
    // 与下方主连接 effect 相同的 active 防护：异步 settle 后组件可能已卸载/切换项目
    let active = true;
    skillAttachmentDirty.current = false;
    setSkillAttachment(undefined);
    setReferences([]);
    dispatchLayer({ type: 'close', layer: 'mention' });
    const pending = consumePendingProductionSkill(project.id);
    if (!pending) return () => { active = false; };
    setPrompt(pending.prompt);
    const showError = (message: string) => {
      if (!active) return;
      skillAttachmentDirty.current = false;
      setMessages(items => [...items, { id: crypto.randomUUID(), role: 'error', text: message }]);
    };
    const bundled = getBundledProductionSkill(pending.skillId);
    if (bundled && bundled.version === pending.skillVersion) {
      skillAttachmentDirty.current = true;
      void createProductionSkillAttachment(bundled)
        .then(attachment => {
          if (active) setSkillAttachment(attachment);
        })
        .catch(error => showError(errorMessage(error)));
      return () => { active = false; };
    }
    void (async () => {
      try {
        const registry = await createLocalSkillRegistry();
        if (!active) return;
        if (!registry) throw new Error('本机 Skill 需要桌面端 Managed Agent 连接。');
        const manifest = await registry.getSkillManifest(pending.skillId);
        if (!active) return;
        if (manifest.version !== pending.skillVersion) {
          throw new Error(`制作 Skill 版本不匹配：${pending.skillId}@${pending.skillVersion}`);
        }
        skillAttachmentDirty.current = true;
        setSkillAttachment(createSkillAttachment({
          id: manifest.id,
          version: manifest.version,
          contentHash: manifest.contentHash,
          displayName: manifest.displayName,
          trustTier: manifest.trustTier,
        }));
      } catch (error) {
        showError(errorMessage(error));
      }
    })();
    return () => { active = false; };
  }, [project.id]);
  useEffect(() => {
    let active = true;
    client.current = undefined;
    kernelRef.current = undefined;
    setConfirmation(undefined);
    askRef.current?.resolve({ ok: false, cancelled: true });
    askRef.current = undefined;
    setPendingAsk(undefined);
    mandateRef.current = null;
    sessionGrantsRef.current.clear();
    setMandate(null);
    setStatus('connecting');
    setSetupBlocker(null);

    const startBrowserKernel = async () => {
      const route = resolveBrowserAgentTextRoute(userApiKeysRef.current);
      if (!route) {
        if (!active) return;
        setStatus('ready');
        setWorkspaceStatus('ready');
        setSetupBlocker('credential');
        setMessages([{ id: 'agent-text-config', role: 'error', text: translations[language].agentPanel.textRouteRequired }]);
        activity.current('error');
        return;
      }
      const confirm = askConfirmation;
      // Shared project receipts are read-only reference text, never merged memory.
      const receiptContext = formatReceiptContext(useAgentReceiptStore.getState().byProject[project.id] || []);
      const kernel = await BrowserAgentRuntime.connect({
        projectId: project.id,
        route,
        confirm,
        ask: presentAsk,
        systemPrompt: BROWSER_DEFAULT_SYSTEM_PROMPT + receiptContext,
        getNodes: () => projectRef.current.nodes,
        webSearch: searchCredential ?? undefined,
        getApproval: approvalContext,
        getDraftVersion: () => projectRef.current.draftVersion,
      });
      if (!active) { await kernel.close(); return; }
      kernelRef.current = kernel;
      // 画布会话卡的后台运行：面板忙时卡片请求交给这里（同一条线路、同一套工具策略 / 付费授权，不登记为项目活动运行时）。
      // 后台运行时工厂：画布会话卡与 Iris Link（CLI 发起的回合）共用这一份（同一条线路、系统提示、Tool Policy）。
      const connectBackground: CanvasSessionRunnerDeps['connect'] = ({ session, confirm: runnerConfirm, ask }) => BrowserAgentRuntime.connect({
        projectId: project.id,
        route,
        confirm: runnerConfirm,
        ask,
        systemPrompt: BROWSER_DEFAULT_SYSTEM_PROMPT + receiptContext,
        getNodes: () => projectRef.current.nodes,
        webSearch: searchCredential ?? undefined,
        // 每个会话单独审批：沿用审批模式与按工具策略，但不继承面板会话的「本会话总是允许」。
        getApproval: () => ({ mode: modeRef.current, userPolicy: userToolPolicyRef.current }),
        getDraftVersion: () => projectRef.current.draftVersion,
      }, { register: false, session });
      const runnerMandate = {
        get: () => mandateRef.current,
        set: (next: AgentSpendMandate) => { mandateRef.current = next; setMandate(next); },
        enabled: () => modeRef.current !== 'always-ask',
      };
      const isSessionBusy = (sessionId: string) => turnRef.current.phase !== 'idle' && activeSessionIdRef.current === sessionId;
      const runners = new CanvasSessionRunners({
        projectId: project.id,
        language: language === 'zho' ? 'zho' : 'en',
        connect: connectBackground,
        prepare: request => prepareCanvasRunRef.current(request),
        toDisplay: snap => displayMessages(snap as IrisAgentSnapshot, languageRef.current),
        mandate: runnerMandate,
        isSessionBusy,
        onChange: state => { projectRunnerRef.current(state); notifyAgentLinkRunner(project.id, state); },
        onSession: async (cardNodeId, sessionId, request) => {
          const bound = await bindAgentSessionCard({ projectId: project.id, nodeId: cardNodeId, sessionId, prompt: request.text });
          if (bound.ok === false) throw new Error(bound.error);
        },
        onFinished: state => { finishRunnerRef.current(state); notifyAgentLinkRunner(project.id, state); },
        storage: defaultRunnerStorage(),
        toolLabel: name => agentToolLabel(name, languageRef.current === 'zho' ? 'zho' : 'en'),
        toolResultText: result => toolResultText(result, languageRef.current),
      });
      runnersRef.current = runners;
      runners.restore();
      // Iris Link：把这些现成能力登记给 CLI 命令（本机 loopback 或线上中继进来的）；Key 只在 connectBackground 里使用。
      unregisterLinkRef.current?.();
      unregisterLinkRef.current = registerAgentLinkHost({
        projectId: project.id,
        language: languageRef.current === 'zho' ? 'zho' : 'en',
        connectBackground,
        prepare: request => prepareCanvasRunRef.current(request),
        toDisplay: snap => displayMessages(snap as IrisAgentSnapshot, languageRef.current),
        listSessions: () => kernel.listSessions(),
        canvasRunners: runners,
        mandate: runnerMandate,
        approval: () => ({ mode: modeRef.current, userPolicy: userToolPolicyRef.current }),
        isSessionBusy,
        model: () => ({ id: route.model, provider: route.provider }),
        toolLabel: name => agentToolLabel(name, languageRef.current === 'zho' ? 'zho' : 'en'),
        toolResultText: result => toolResultText(result, languageRef.current),
      });
      const snapshot = await kernel.snapshot() as IrisAgentSnapshot;
      const unsubscribe = kernel.subscribe(event => {
        if (!active) return;
        mapKernelEvent(event);
      });
      unsubscribeRef.current = unsubscribe;
      setMessages(displayMessages(snapshot, language));
      if (snapshot.boundProductionSkill) setSkillAttachment(snapshot.boundProductionSkill);
      setStatus('ready');
      setWorkspaceStatus('ready');
      setSetupBlocker(null);
      activity.current(snapshot.messages.length ? 'done' : 'idle');
      void refreshSessions();
    };

    void getManagedAgentConnection()
      .then(async connection => {
        // 网页端没有桌面 Runtime：托管 Agent 的文本出口（/v1/agent-text/stream）不可用。
        // 有可用的浏览器文本线路时，对话走浏览器内核，Key 直连；桌面端仍走托管 Agent。
        if (!connection || (!isTauri() && resolveBrowserAgentTextRoute(userApiKeysRef.current))) return startBrowserKernel();
        const next = new ManagedIrisAgentClient(connection);
        const snapshot = await next.session(project.id);
        if (!active) return;
        client.current = next;
        if (typeof EventSource === 'function') {
          const bridge = new WorkflowAgentBridge({
            url: connection.url,
            token: connection.token,
            // 计划卡的「创建后手动生成 / 调整后再创建」带说明回给托管 Agent（DEFERRED_BY_USER），不是笼统的拒绝。
            confirm: askConfirmation,
            // 托管 Agent 的可逆写入走同一个审批解析器；删除 / 付费由 bridge 的高风险确认单独处理。
            confirmWrite: (summary, request) => {
              if (!request) return askConfirmationBoolean(summary, request);
              const tool = request.tool || request.command;
              const resolution = resolveToolApproval({ ...approvalContext(), tool, decision: toolApprovalFor(request.command, { ...(request.args || {}) }) });
              if (resolution.action === 'allow') return true;
              if (resolution.action === 'deny') return false;
              return askConfirmationBoolean(summary, { ...request, tool, tier: resolution.tier, grantable: resolution.grantable, ...(resolution.reason ? { reason: resolution.reason } : {}) });
            },
            onStatus: nextStatus => {
              if (!active) return;
              setWorkspaceStatus(nextStatus === 'connected' ? 'ready' : nextStatus === 'error' ? 'error' : 'connecting');
            },
          });
          workspaceBridge.current = bridge;
          bridge.connect();
          await bridge.pushSnapshot(project);
        }
        setMessages(displayMessages(snapshot, language));
        if (!skillAttachmentDirty.current) setSkillAttachment(snapshot.boundProductionSkill);
        if (snapshot.productionSkillBindingError) {
          setMessages(items => [...items, { id: 'skill-binding-error', role: 'error', text: snapshot.productionSkillBindingError! }]);
        }
        setStatus('ready');
        // 旧会话里残留的「No agent-text route」错误不能在已有可用线路后继续拦截；真缺线路时发送会再报错并重新拦截。
        const configurationNeeded = !browserRouteSignature && snapshotNeedsConfiguration(snapshot);
        setSetupBlocker(configurationNeeded ? 'credential' : null);
        activity.current(configurationNeeded ? 'error' : snapshot.messages.length ? 'done' : 'idle');
      })
      .catch(error => {
        if (!active) return;
        // Cold-open failure: classify via the executor/host taxonomy so the
        // panel can offer a real next step instead of a jargon dead end.
        // 网页端没有可用的文本模型时，托管 Agent 也只能转发给桌面 Runtime：真正缺的是文本模型 Key，
        // 不是「协作方离线」（只配了图片 / 视频服务时以前会误报需要 Codex / Claude / OpenCode）。
        if (!isTauri() && !resolveBrowserAgentTextRoute(userApiKeysRef.current)) {
          setStatus('ready');
          setWorkspaceStatus('ready');
          setSetupBlocker('credential');
          setMessages([{ id: 'agent-text-config', role: 'error', text: translations[language].agentPanel.textRouteRequired }]);
          activity.current('error');
          return;
        }
        const blocker = classifyAgentSetupError(error);
        setStatus('error');
        setWorkspaceStatus('error');
        setSetupBlocker(blocker === 'unknown' ? 'offline' : blocker);
        setMessages([{ id: 'connection-error', role: 'error', text: localizedAgentSetupMessage(blocker === 'unknown' ? 'offline' : blocker, error, language) }]);
        activity.current('error');
      });
    return () => {
      active = false;
      abort.current?.abort();
      rejectConfirmations();
      workspaceBridge.current?.disconnect();
      workspaceBridge.current = undefined;
      unsubscribeRef.current?.();
      unsubscribeRef.current = undefined;
      unregisterLinkRef.current?.();
      unregisterLinkRef.current = undefined;
      void runnersRef.current?.dispose();
      runnersRef.current = null;
      void kernelRef.current?.close();
      kernelRef.current = undefined;
    };
  }, [project.id, kernelRouteSignature]);

  useEffect(() => {
    if (workspaceBridge.current) void workspaceBridge.current.pushSnapshot(project).catch(() => setWorkspaceStatus('error'));
  }, [project]);

  const handleEventRef = useRef<(event: IrisAgentTurnEvent, assistantId: string) => void>(() => undefined);
  // 一条助手消息对应一个流式气泡：message_start 时换新 id，同一消息的 text_delta 共用。
  const streamIdRef = useRef('stream-' + crypto.randomUUID());
  // 回复正文正在流式输出（可能就是最终回复）：此时 Enter 排队而不插话（codex #12569 的竞态）。
  const answerStreamingRef = useRef(false);
  // 插话被模型循环取走（内核 steer_delivered）时由面板处理：移出托盘、在对话里补上这条用户消息。
  const steerDeliveredRef = useRef<(id: string) => void>(() => undefined);
  // 上下文压缩：实时卡状态（running → done/error 停一下再收起，换成快照里的分隔条）。
  const [compaction, setCompaction] = useState<AgentCompactionLive | null>(null);
  const compactionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (compactionTimer.current) clearTimeout(compactionTimer.current); }, []);
  // 内置 PI 内核事件（pi-agent-core）→ 面板事件流（与 Managed Agent 的 SSE 事件同构）
  const mapKernelEvent = useCallback((event: { type: string; [key: string]: unknown }) => {
    if (event.type === 'message_start') {
      streamIdRef.current = 'stream-' + crypto.randomUUID();
      answerStreamingRef.current = false;
      return;
    }
    if (event.type === 'steer_delivered') {
      steerDeliveredRef.current(String(event.steerId || ''));
      return;
    }
    if (event.type === 'compaction_start') {
      if (compactionTimer.current) clearTimeout(compactionTimer.current);
      const reason = (event.reason === 'overflow' || event.reason === 'manual' || event.reason === 'midturn' ? event.reason : 'threshold') as AgentCompactionLive['reason'];
      setCompaction({ phase: 'running', reason, startedAt: Date.now() });
      return;
    }
    if (event.type === 'compaction_end') {
      const failed = Boolean(event.error);
      setCompaction(live => live ? {
        ...live,
        phase: failed ? 'error' : 'done',
        tokensBefore: Number(event.tokensBefore || 0) || undefined,
        error: failed ? String(event.error) : undefined,
      } : live);
      // 成功：刷新快照让分隔条就位；实时卡停留一拍（看清「已折成摘要」）后收起。
      const kernel = kernelRef.current;
      if (!failed && event.compacted && kernel) void kernel.snapshot().then(snapshot => {
        setMessages(items => mergeCompactionDivider(items, displayMessages(snapshot as IrisAgentSnapshot, languageRef.current)));
      });
      if (compactionTimer.current) clearTimeout(compactionTimer.current);
      compactionTimer.current = setTimeout(() => setCompaction(null), failed ? 3200 : 1500);
      return;
    }
    if (event.type === 'message_update') {
      const update = (event as { assistantMessageEvent?: { type: string; delta?: string } }).assistantMessageEvent;
      if (update?.type === 'text_delta' && update.delta) {
        handleEventRef.current({ type: 'text-delta', delta: update.delta }, streamIdRef.current);
      } else if (update?.type === 'thinking_delta' && update.delta) {
        handleEventRef.current({ type: 'thinking-delta', delta: update.delta }, streamIdRef.current);
      }
      return;
    }
    if (event.type === 'agent_start') {
      activity.current('running');
      return;
    }
    if (event.type === 'tool_execution_start') {
      handleEventRef.current({
        type: 'tool-start',
        id: String(event.toolCallId || ''),
        name: String(event.toolName || ''),
        args: event.args,
      }, `tool-${event.toolCallId || ''}`);
      return;
    }
    if (event.type === 'tool_execution_update') {
      handleEventRef.current({
        type: 'tool-update',
        id: String(event.toolCallId || ''),
        name: String(event.toolName || ''),
        partial: event.partialResult,
      }, 'tool-' + String(event.toolCallId || ''));
      return;
    }
    if (event.type === 'tool_execution_end') {
      handleEventRef.current({
        type: 'tool-end',
        id: String(event.toolCallId || ''),
        name: String(event.toolName || ''),
        result: event.result,
        isError: Boolean(event.isError),
      }, `tool-${event.toolCallId || ''}`);
      return;
    }
    if (event.type === 'session_switched') {
      const kernel = kernelRef.current;
      if (kernel) void kernel.snapshot().then(snapshot => {
        setMessages(displayMessages(snapshot as IrisAgentSnapshot, languageRef.current));
      });
      return;
    }
  }, []);

  const refreshSessions = useCallback(async () => {
    const kernel = kernelRef.current;
    if (!kernel) return;
    try {
      setSessionList(await kernel.listSessions());
      const snapshot = await kernel.snapshot();
      setActiveSessionId(String((snapshot as { sessionId?: string }).sessionId || ''));
    } catch { /* 会话列表读取失败时保持现状 */ }
  }, []);

  const handleNewConversation = async () => {
    const kernel = kernelRef.current;
    if (!kernel) return;
    try {
      await kernel.newSession();
      await refreshSessions();
      dispatchLayer({ type: 'close', layer: 'sessions' });
    } catch (error) {
      setMessages(items => [...items, { id: crypto.randomUUID(), role: 'error', text: errorMessage(error) }]);
    }
  };

  const handleOpenSession = async (sessionId: string) => {
    const kernel = kernelRef.current;
    if (!kernel || sending) return;
    try {
      abort.current?.abort();
      await kernel.openSessionById(sessionId);
      await refreshSessions();
      dispatchLayer({ type: 'close', layer: 'sessions' });
    } catch (error) {
      setMessages(items => [...items, { id: crypto.randomUUID(), role: 'error', text: errorMessage(error) }]);
    }
  };

  /**
   * 手动压缩：/compact [聚焦说明] 或会话菜单「压缩上下文」。只对浏览器内置内核可用，运行中不压缩。
   * 聚焦说明拼进摘要要求；最近几轮保留原文；过程由末尾的奶蛙压缩胶囊表示（compaction_start / compaction_end）。
   */
  const handleCompactContext = async (focus?: string) => {
    const kernel = kernelRef.current;
    dispatchLayer({ type: 'close', layer: 'sessions' });
    if (!kernel) {
      setMessages(items => [...items, { id: crypto.randomUUID(), role: 'system', text: t('agentPanel.compactUnsupported') }]);
      return;
    }
    if (sending || turnRef.current.phase !== 'idle') {
      setMessages(items => [...items, { id: crypto.randomUUID(), role: 'system', text: t('agentPanel.compactBusy') }]);
      return;
    }
    stickToBottom.current = true;
    try {
      const result = await kernel.compactContext(focus);
      const snapshot = await kernel.snapshot();
      setMessages(displayMessages(snapshot as IrisAgentSnapshot, languageRef.current));
      if (!result.compacted) flashCopied(t('agentPanel.compactNotNeeded'));
    } catch (error) {
      setMessages(items => [...items, { id: crypto.randomUUID(), role: 'error', text: errorMessage(error) }]);
    }
  };

  const openMemoryView = () => {
    setSessionMenuView('memory');
    void useAgentMemoryStore.getState().load(project.id);
  };

  const handleDeleteSession = async (sessionId: string) => {
    const kernel = kernelRef.current;
    if (!kernel) return;
    try {
      await kernel.deleteSession(sessionId);
      clearRunPlans(project.id, sessionId);
      await refreshSessions();
    } catch (error) {
      setMessages(items => [...items, { id: crypto.randomUUID(), role: 'error', text: errorMessage(error) }]);
    }
  };

  const flashCopied = (label: string) => {
    setCopiedNotice(label);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopiedNotice(null), 1600);
  };

  const copyConversation = async () => {
    const text = transcriptMarkdown(transcriptMessages, { language, title: activeSessionTitle });
    if (await copyToClipboard(text)) flashCopied(language === 'zho' ? '已复制对话' : 'Transcript copied');
  };

  const copyMessage = async (message: WorkflowAgentDisplayMessage) => {
    const text = transcriptMarkdown([message], { language });
    if (await copyToClipboard(text)) flashCopied(language === 'zho' ? '已复制' : 'Copied');
  };

  /** 从某条助手消息处分出新会话：复制到该消息为止，原会话不变。 */
  const branchFromMessage = async (message: WorkflowAgentDisplayMessage) => {
    const kernel = kernelRef.current;
    if (!kernel || sending) return;
    // 点击的消息可能只存在于 UI（流式临时 id），也可能已被压缩；从它开始向前找第一个仍存在的分支点。
    const index = transcriptMessages.indexOf(message);
    const candidates = transcriptMessages
      .slice(0, index < 0 ? transcriptMessages.length : index + 1)
      .map(item => item.id)
      .filter(id => id && !id.startsWith('stream-') && !id.startsWith('tool-'))
      .reverse();
    try {
      await kernel.branchSession(activeSessionId, candidates.length ? candidates : [message.id]);
      await refreshSessions();
      flashCopied(language === 'zho' ? '已创建分支' : 'Branch created');
    } catch (error) {
      setMessages(items => [...items, { id: crypto.randomUUID(), role: 'error', text: errorMessage(error) }]);
    }
  };

  // 「钉到画布」：审查步骤（可改标题 / 正文、看见来源 Chip），明确 Commit 才写画布。
  const [pinDraft, setPinDraft] = useState<(ContextCardReviewDraft & { sourceMessage: ContextCardSourceMessage }) | null>(null);
  const [pinBusy, setPinBusy] = useState(false);
  const [pinError, setPinError] = useState('');
  const openPinReview = (message: WorkflowAgentDisplayMessage) => {
    const index = transcriptMessages.indexOf(message);
    // 来源 = 这条回复所回答的那条用户消息的显式来源（结构化记录优先），不自动增添其他来源。
    const user = [...transcriptMessages.slice(0, index < 0 ? transcriptMessages.length : index)].reverse().find(item => item.role === 'user');
    const sources: AgentMessageReference[] = (user?.references || []).filter(ref => ref.id);
    const persistedId = message.id && !message.id.startsWith('stream-') ? message.id : undefined;
    setPinError('');
    setPinDraft({
      messageId: message.id,
      title: defaultContextCardTitle(message.text),
      body: message.text,
      sources,
      sourceMessage: kernelRef.current
        ? { host: 'iris', ...(activeSessionId ? { sessionId: activeSessionId } : {}), ...(persistedId ? { messageId: persistedId } : {}) }
        : { host: 'external', ...(persistedId ? { messageId: persistedId } : {}) },
    });
  };
  const commitPin = async (result: { title: string; body: string; sources: AgentMessageReference[] }) => {
    if (!pinDraft) return;
    setPinBusy(true);
    setPinError('');
    try {
      const committed = await commitContextCard({
        projectId: project.id,
        title: result.title,
        body: result.body,
        sourceMessage: pinDraft.sourceMessage,
        sources: result.sources.filter(ref => ref.id).map(ref => ({ kind: ref.kind, id: ref.id!, label: ref.label })),
        assets: assetLibraryRef.current?.items,
      });
      if (committed.ok === false) { setPinError(committed.error); return; }
      setPinDraft(null);
      onFocusNode?.(committed.nodeId);
      flashCopied(committed.status === 'existing' ? (language === 'zho' ? '卡片已在画布上' : 'Card already on canvas') : (language === 'zho' ? '已钉到画布' : 'Pinned to canvas'));
    } finally {
      setPinBusy(false);
    }
  };

  // 「继续讨论」：原内置会话还在就打开并定位到那条消息；否则开新会话，以卡片定稿 + 仍有效的来源作为输入框种子（不自动发送）。
  const [jumpToMessage, setJumpToMessage] = useState<string | null>(null);
  const pendingDiscussion = useAgentGroupInboxStore(state => state.pendingDiscussion);
  useEffect(() => {
    if (!pendingDiscussion || pendingDiscussion.projectId !== project.id || status === 'connecting' || sending) return;
    const payload = useAgentGroupInboxStore.getState().consumeDiscussion();
    if (!payload) return;
    // 卡片刚由画布写入：以 Workflow store 为准（面板的 project prop 可能还没刷新）。
    const liveNodes = useWorkflowStore.getState().projects.find(item => item.id === payload.projectId)?.nodes || projectRef.current.nodes;
    const card = liveNodes.find(node => node.id === payload.cardNodeId);
    if (!card) return;
    void (async () => {
      const kernel = kernelRef.current;
      try {
        const sessions = kernel ? await kernel.listSessions() : [];
        const plan = planContinueDiscussion(card, { sessionExists: id => sessions.some(item => item.id === id), nodes: liveNodes, assets: assetLibraryRef.current?.items });
        if (plan.mode === 'open' && kernel) {
          await kernel.openSessionById(plan.sessionId);
          setMessages(displayMessages(await kernel.snapshot() as IrisAgentSnapshot, languageRef.current));
          await refreshSessions();
          if (plan.messageId) { stickToBottom.current = false; setJumpToMessage(plan.messageId); }
          return;
        }
        if (plan.mode === 'new') {
          if (kernel) {
            await kernel.newSession();
            setMessages(displayMessages(await kernel.snapshot() as IrisAgentSnapshot, languageRef.current));
            await refreshSessions();
          }
          setPrompt('');
          setQuote({ messageId: '', text: (plan.title ? plan.title + '\n\n' : '') + plan.body });
          setReferences(plan.references.map(ref => ({ id: ref.id, type: ref.kind, label: ref.label, mediaType: ref.kind === 'node' ? liveNodes.find(node => node.id === ref.id)?.type : assetLibraryRef.current?.items.find(item => item.id === ref.id)?.mimeType })));
          focusComposer();
        }
      } catch (error) {
        setMessages(items => [...items, { id: crypto.randomUUID(), role: 'error', text: errorMessage(error) }]);
      }
    })();
  }, [pendingDiscussion, project.id, status, sending]);
  useEffect(() => {
    if (!jumpToMessage) return;
    // 「toolcall:<id>」= 工具调用（卡片轨迹行），其余是消息 entry id。
    const selector = jumpToMessage.startsWith('toolcall:')
      ? `[data-tool-call-id="${CSS.escape(jumpToMessage.slice(9))}"]`
      : `[data-message-id="${CSS.escape(jumpToMessage)}"]`;
    const target = messagesRef.current?.querySelector<HTMLElement>(selector);
    if (!target) return;
    target.scrollIntoView?.({ block: 'center' });
    target.setAttribute('data-jump-target', '');
    const timer = window.setTimeout(() => target.removeAttribute('data-jump-target'), 1600);
    setJumpToMessage(null);
    return () => window.clearTimeout(timer);
  }, [jumpToMessage, messages]);

  useEffect(() => () => { if (copiedTimer.current) clearTimeout(copiedTimer.current); }, []);

  useEffect(() => { handleEventRef.current = handleEvent; });

  const handleEvent = (event: IrisAgentTurnEvent, assistantId: string) => {
    if (event.type === 'text-delta') {
      answerStreamingRef.current = true;
      setSetupBlocker(current => blockerAfterCredentialSignal(current, false));
      const now = Date.now();
      setMessages(items => applyTextDelta(items, assistantId, event.delta, now));
    } else if (event.type === 'thinking-delta') {
      const now = Date.now();
      setMessages(items => applyThinkingDelta(items, assistantId, event.delta, now));
    } else if (event.type === 'snapshot') {
      setSetupBlocker(current => blockerAfterCredentialSignal(current, snapshotNeedsConfiguration(event.snapshot)));
      const next = displayMessages(event.snapshot, language);
      setMessages(items => carryLiveState(items, next));
      skillAttachmentDirty.current = false;
      setSkillAttachment(event.snapshot.boundProductionSkill);
    } else if (event.type === 'tool-start') {
      answerStreamingRef.current = false;
      const needsApproval = /production_(?:approve|run)|task_cancel/.test(event.name);
      const productionTool = /production_|workflow_projection|provider_status|task_get/.test(event.name);
      const now = Date.now();
      // 转去调工具 = 这一段思考结束：定格用时并收起。
      setMessages(items => [...items.map(item => finishThinking(item, now)), {
        id: `tool-${event.id}`,
        role: 'tool',
        toolName: event.name,
        args: event.args,
        startedAt: now,
        title: agentToolLabel(event.name, language === 'zho' ? 'zho' : 'en'),
        text: needsApproval ? translations[language].agentPanel.toolWaitingApproval : productionTool ? translations[language].agentPanel.toolPreparingPlan : translations[language].agentPanel.toolUpdatingDraft,
        detail: event.args,
        status: 'pending',
      }]);
    } else if (event.type === 'tool-end') {
      const endedAt = Date.now();
      setMessages(items => items.map(item => item.id === `tool-${event.id}` ? {
        ...item,
        text: toolResultText(event.result, language),
        detail: event.result,
        endedAt,
        status: event.isError ? 'error' : 'success',
      } : item));
    } else if (event.type === 'tool-update') {
      setMessages(items => items.map(item => item.id === 'tool-' + event.id ? { ...item, detail: event.partial } : item));
    } else if (event.type === 'error' && isAbortMessage(event.message)) {
      setMessages(items => [...items, { id: crypto.randomUUID(), role: 'system', text: abortedNoticeText(language) }]);
    } else if (event.type === 'error') {
      // Mid-turn errors are usually transient; only a credential wall earns the
      // guided-action card — everything else stays a plain message.
      const blocker = classifyAgentSetupError(event.message);
      if (blocker === 'credential' || isAgentTextConfigurationError(event.message)) setSetupBlocker('credential');
      setMessages(items => [...items, { id: crypto.randomUUID(), role: 'error', text: agentMessageText(event.message, language) }]);
    }
  };

  const addAttachmentFiles = (files: FileList | File[] | null | undefined) => {
    if (!files) return;
    const incoming = Array.from(files).map(file => createComposerAttachment(file)).filter((item): item is AgentComposerAttachment => Boolean(item));
    if (!incoming.length) return;
    const { kept, rejected } = mergeComposerAttachments(attachmentsRef.current, incoming, AGENT_ATTACHMENT_MAX);
    rejected.forEach(releaseComposerAttachment);
    attachmentsRef.current = kept;
    setAttachments(kept);
    focusComposer();
  };

  // 拖进输入框的图片：先像拖到画布一样建成图片节点，再作为 @节点 引用加入本轮；
  // Agent 按节点 id 使用它（看图走 media_view，纯文本模型也能把它连成参考）。视频与放画布失败的图片仍作为本轮附件。
  const dropComposerFiles = async (files: File[]) => {
    const images = files.filter(file => file.type.startsWith('image/'));
    const others = files.filter(file => !file.type.startsWith('image/'));
    if (others.length) addAttachmentFiles(others);
    if (!images.length) return;
    const placed = await insertLocalImagesIntoProject(project.id, images);
    if (!placed.ok || !placed.nodes?.length) {
      addAttachmentFiles(images);
      return;
    }
    placed.nodes.forEach(node => addReference({ id: node.id, type: 'node', label: node.title, mediaType: 'image' }));
  };

  const removeAttachment = (attachment: AgentComposerAttachment) => {
    releaseComposerAttachment(attachment);
    const next = attachmentsRef.current.filter(item => item !== attachment);
    attachmentsRef.current = next;
    setAttachments(next);
  };

  // 卸载时释放剩余附件的 object URL，避免内存泄漏。
  useEffect(() => () => {
    attachmentsRef.current.forEach(releaseComposerAttachment);
    attachmentsRef.current = [];
  }, []);

  // 运行中发出的消息（照 openai/codex）：Enter 插话（steer，下一个工具 / 结果边界注入当前这一轮），
  // Tab 排队（这一轮空闲后按先后自动发送）；两者在送达前都显示在输入框上方的「待发送」托盘里。
  type OutgoingTurn = {
    id: string;
    requestText: string;
    displayText: string;
    references: AgentReference[];
    attachments: AgentComposerAttachment[];
    messageReferences: Array<{ id: string; kind: AgentReference['type']; label: string }>;
    displayAttachments: Array<{ id: string; name: string; previewUrl: string }>;
  };
  type QueueDraft = ComposerDraft<AgentReference, AgentComposerAttachment>;
  /** 待发送的一条：原始草稿（取回编辑 / 停止退回用）；插话还带着已解析好的请求（送达时显示）。 */
  type QueuedInput = PendingInput<AgentReference, AgentComposerAttachment> & { outgoing?: OutgoingTurn };

  // 每个会话一份待发送队列，只在内存里（刷新即丢）。
  const [inputQueues, setInputQueues] = useState<Record<string, QueuedInput[]>>({});
  const inputQueuesRef = useRef<Record<string, QueuedInput[]>>({});
  const [inputQueueCollapsed, setInputQueueCollapsed] = useState(false);
  const conversationKey = activeSessionId || project.id;
  const conversationKeyRef = useRef(conversationKey);
  conversationKeyRef.current = conversationKey;
  const turnConversationKey = useRef(conversationKey);
  const pendingInputs = inputQueues[conversationKey] || [];
  const updateInputQueue = (key: string, update: (items: QueuedInput[]) => QueuedInput[]) => {
    const next = { ...inputQueuesRef.current, [key]: update(inputQueuesRef.current[key] || []) };
    inputQueuesRef.current = next;
    setInputQueues(next);
  };

  const composerDraft = (): QueueDraft => ({ text: prompt.trim(), quote: quote?.text ?? null, references: [...references], attachments: attachmentsRef.current });
  const clearComposer = () => {
    setPrompt('');
    setQuote(null);
    setReferences([]);
    attachmentsRef.current = [];
    setAttachments([]);
    dispatchLayer({ type: 'close', layer: 'mention' });
  };
  /** 把草稿放回输入框（停止退回 / 取回编辑）。 */
  const fillComposer = (draft: QueueDraft) => {
    setPrompt(draft.text);
    setQuote(draft.quote ? { messageId: '', text: draft.quote } : null);
    setReferences(draft.references);
    attachmentsRef.current = draft.attachments;
    setAttachments(draft.attachments);
    focusComposer();
  };
  // 带媒体（附件、@图片节点）需要异步取画面，不能插话，只能排队。
  const draftHasMedia = (draft: QueueDraft) => draft.attachments.length > 0 || draft.references.some(reference => reference.type === 'node');

  /** 连接未就绪 / 缺凭证：给出引导并返回 true（不发送）。 */
  const connectionBlocked = () => {
    if (client.current || kernelRef.current) return false;
    // Agents-offline / credential wall: never dump '仅桌面端可用'. When the
    // missing piece is an agent-text route the blocker is credential (a key
    // fixes it); otherwise the managed host is simply not running (offline).
    const missingTextRoute = !isTauri() && !browserRouteSignature;
    const blocker: AgentSetupBlocker = needsConfiguration || missingTextRoute ? 'credential' : 'offline';
    setSetupBlocker(blocker);
    setMessages(items => [...items, { id: crypto.randomUUID(), role: 'error', text: missingTextRoute ? translations[language].agentPanel.textRouteRequired : localizedAgentSetupMessage(blocker, undefined, language) }]);
    return true;
  };

  /** 草稿 → 一轮请求。排队的消息到出队时才解析（创作模式、偏好模型取那一刻的值）。 */
  const buildOutgoing = (draft: QueueDraft, id: string = crypto.randomUUID()): OutgoingTurn => {
    // 引用回复：引文以 Markdown 引用块放在正文前，进入模型上下文，气泡里显示为引用块。
    const text = withQuote(draft.text, draft.quote ?? undefined);
    const draftReferences = draft.references;
    const referenceContext = draftReferences.length ? `引用上下文：\n${draftReferences.map(reference => `- @${reference.label}（${reference.type === 'node' ? `工作流节点 nodeId=${reference.id}` : `我的素材 assetId=${reference.id}`}）`).join('\n')}` : '';
    const turnAttachments = draft.attachments;
    const attachmentContext = turnAttachments.length
      ? `本轮附带的本地媒体（画面已作为图片内容一并发给你）：\n${turnAttachments.map(item => `- ${item.kind === 'image' ? '图片' : '视频'}「${item.name}」`).join('\n')}`
      : '';
    const requestText = applyAgentTurnPreamble([text, referenceContext, attachmentContext].filter(Boolean).join('\n\n'), {
      creationMode,
      preferredModel: preferredModel ? { capability: preferredModel.capability, name: preferredModel.name } : null,
    });
    const displayText = [
      text,
      draftReferences.length ? `引用：${draftReferences.map(reference => `@${reference.label}`).join('、')}` : '',
      // 图片附件直接显示缩略图；视频暂无封面，仍列名字（快照回来后换成首帧封面）。
      turnAttachments.some(item => item.kind === 'video') ? `附件：${turnAttachments.filter(item => item.kind === 'video').map(item => item.name).join('、')}` : '',
    ].filter(Boolean).join('\n\n');
    // 气泡用独立的 object URL：附件本身的 URL 发送后就会被释放。
    const displayAttachments = turnAttachments.filter(item => item.kind === 'image').map(item => ({ id: item.id, name: item.name, previewUrl: URL.createObjectURL(item.file) }));
    return {
      id,
      requestText,
      displayText,
      references: [...draftReferences],
      attachments: turnAttachments,
      messageReferences: draftReferences.map(reference => ({ id: reference.id, kind: reference.type, label: reference.label })),
      displayAttachments,
    };
  };

  /** 一轮要带给模型的画面：本地附件优先，@引用的图片 / 视频节点随后补位（最多 6 张）。发送与插话共用。 */
  const loadTurnMedia = async (references: QueueDraft['references'], attachments: QueueDraft['attachments']) => {
    const referencedNodes = references.flatMap(reference => {
      if (reference.type !== 'node') return [];
      const node = projectRef.current.nodes.find(item => item.id === reference.id);
      return node ? [node] : [];
    });
    const nodeMedia = referencedNodes.length > 0 ? await loadAgentNodeMedia(referencedNodes) : { images: [], notes: [] };
    const attachmentMedia = attachments.length ? await composerAttachmentsToImages(attachments) : { images: [], notes: [] };
    return {
      images: [...attachmentMedia.images, ...nodeMedia.images].slice(0, 6),
      notes: [...attachmentMedia.notes, ...nodeMedia.notes],
      // 本地附件排在前面，节点画面从其后计数；超过 6 张的部分没有送达。
      nodeSent: sentNodeMedia('sources' in nodeMedia ? nodeMedia.sources : undefined, attachmentMedia.images.length, 6),
    };
  };

  /** Spatial Context P0：本轮显式来源（发送那一刻冻结），内核在用户消息落盘后按真实 id 写入会话。 */
  const turnContextFor = (references: QueueDraft['references'], nodeSent?: NodeMediaSent): TurnContextDraft | null => buildTurnContextDraft({
    projectId: projectRef.current.id,
    projectRevision: projectRef.current.draftVersion || 1,
    references,
    nodes: projectRef.current.nodes,
    assets: assetLibraryRef.current?.items,
    media: nodeSent,
  });

  // 正在准备画面、还没交给内核的插话；期间被删掉的不再送出。
  const steerPreparing = useRef(new Set<string>());

  /**
   * 把一条草稿作为插话交给内核（在下一个步骤边界送达）。带 @节点 / 附件时先读出画面再插话，
   * 和正常发送一样把画面随消息带上。内核不接受（这一轮已结束 / 托管 Agent）返回 null。
   */
  const steerDraft = async (draft: QueueDraft, outgoing: OutgoingTurn, key: string): Promise<boolean> => {
    const id = outgoing.id;
    if (!kernelRef.current) return false;
    if (!draftHasMedia(draft)) return kernelRef.current.steer(outgoing.requestText, [], id, turnContextFor(draft.references));
    steerPreparing.current.add(id);
    try {
      const media = await loadTurnMedia(draft.references, draft.attachments);
      // 读画面期间被删掉，或这一轮已结束、它被退回排队（甚至已作为下一轮发出）：不再插话，免得发两次。
      if (!steerPreparing.current.has(id)) return false;
      const current = (inputQueuesRef.current[key] || []).find(entry => entry.id === id);
      if (!current || current.kind !== 'steer') return false;
      const text = media.notes.length > 0 ? outgoing.requestText + '\n\n已附带画面：\n' + media.notes.join('\n') : outgoing.requestText;
      return Boolean(kernelRef.current?.steer(text, media.images, id, turnContextFor(draft.references, media.nodeSent)));
    } catch {
      return false;
    } finally {
      steerPreparing.current.delete(id);
    }
  };

  /** 插话没被接受：退回排队（排在排队消息最前），这一轮结束后第一个发出。 */
  const demoteSteer = (key: string, id: string) => {
    updateInputQueue(key, list => requeueSteers(list, [id]));
  };

  /** 运行中提交：按 Enter / Tab 与当前状态决定插话还是排队，放进托盘。 */
  const enqueueWhileRunning = (draft: QueueDraft, key: RunningSubmitKey) => {
    const id = crypto.randomUUID();
    const queueKey = conversationKeyRef.current;
    const kind = routeRunningSubmit({ key, answerStreaming: answerStreamingRef.current, steerable: Boolean(kernelRef.current) });
    // 插话的气泡内容先备好：送达事件（steer_delivered）可能紧跟着就到。
    const outgoing = kind === 'steer' ? buildOutgoing(draft, id) : undefined;
    updateInputQueue(queueKey, items => [...items, { id, kind, draft, ...(outgoing ? { outgoing } : {}) }]);
    setInputQueueCollapsed(false);
    if (!outgoing) return;
    const accepted = steerDraft(draft, outgoing, queueKey);
    void accepted.then(ok => { if (!ok) demoteSteer(queueKey, id); });
  };

  /** 斜杠菜单里选中命令：run=true（输入已是完整的 /compact）直接执行，否则写进输入框等用户补聚焦说明。 */
  const handleSlashCommand = (command: AgentSlashCommand, options: { run: boolean }) => {
    dispatchLayer({ type: 'clearSlash' });
    dispatchLayer({ type: 'close', layer: 'skill' });
    if (command.id !== 'compact') return;
    if (options.run) {
      setPrompt('');
      void handleCompactContext();
      return;
    }
    setPrompt(current => insertSlashCommand(current, command));
    focusComposer();
  };

  const send = async (key: RunningSubmitKey = 'enter') => {
    const draft = composerDraft();
    if (draftIsEmpty(draft)) return;
    // /compact [聚焦说明]：不发给模型，走手动压缩（omp 风格）。带引用 / 附件时按普通消息处理。
    const compactCommand = !draft.quote && !draft.references.length && !draft.attachments.length ? parseCompactCommand(draft.text) : null;
    if (compactCommand) {
      setPrompt('');
      dispatchLayer({ type: 'closeAll' });
      await handleCompactContext(compactCommand.focus);
      return;
    }
    // 连接中不发送（按钮本就禁用）；不再在发送时强行把连接状态改成 ready。
    if (status === 'connecting') return;
    const phase = turnRef.current.phase;
    if (phase === 'stopping') return;
    if (connectionBlocked()) return;
    // 单个节点的「已加入上下文」提示随这一轮发出而结束；分组提示保留（还能保存为 Skill）。
    setGroupBanner(current => (current && current.nodeIds.length <= 1 ? null : current));
    clearComposer();
    if (phase !== 'idle') {
      enqueueWhileRunning(draft, key);
      return;
    }
    await dispatchOutgoing(buildOutgoing(draft));
  };

  /** 空闲时发出一轮：显示用户消息并开跑。不碰输入框。 */
  const dispatchOutgoing = async (outgoing: OutgoingTurn) => {
    stickToBottom.current = true;
    setMessages(items => [...items, { id: outgoing.id, role: 'user', text: outgoing.displayText, ...(outgoing.messageReferences.length ? { references: outgoing.messageReferences } : {}), ...(outgoing.displayAttachments.length ? { attachments: outgoing.displayAttachments } : {}) }]);
    await runTurn(outgoing);
  };


  // 插话被模型循环取走：移出托盘，在对话里补上这条用户消息（落在它真正进入上下文的位置）。
  steerDeliveredRef.current = (id: string) => {
    answerStreamingRef.current = false;
    for (const [key, items] of Object.entries(inputQueuesRef.current)) {
      const item = items.find(entry => entry.id === id);
      if (!item) continue;
      updateInputQueue(key, list => removeInput(list, id));
      item.draft.attachments.forEach(releaseComposerAttachment);
      const outgoing = item.outgoing;
      if (outgoing) {
        stickToBottom.current = true;
        setMessages(list => list.some(entry => entry.id === outgoing.id) ? list : [...list, { id: outgoing.id, role: 'user', text: outgoing.displayText, ...(outgoing.messageReferences.length ? { references: outgoing.messageReferences } : {}), ...(outgoing.displayAttachments.length ? { attachments: outgoing.displayAttachments } : {}) }]);
      }
      return;
    }
  };

  /** 这一轮空闲后：取排队的第一条发出（一次一条，下一条等它结束）。只发当前打开的会话的队列。 */
  const drainInputQueue = (key: string) => {
    if (key !== conversationKeyRef.current) return;
    const { next, rest } = shiftQueued(inputQueuesRef.current[key] || []);
    if (!next) return;
    updateInputQueue(key, () => rest);
    void dispatchOutgoing(buildOutgoing(next.draft, next.id));
  };

  /** 托盘 ↑：排队的一条立即发送。运行中能插话就转成插话；不能（托管 Agent / 带媒体）就挪到队首；空闲时直接发。 */
  const sendPendingNow = (id: string) => {
    const key = conversationKeyRef.current;
    const item = (inputQueuesRef.current[key] || []).find(entry => entry.id === id);
    if (!item || item.kind !== 'queued') return;
    const phase = turnRef.current.phase;
    if (phase === 'stopping' || status === 'connecting') return;
    if (phase === 'idle') {
      if (connectionBlocked()) return;
      updateInputQueue(key, list => removeInput(list, id));
      void dispatchOutgoing(buildOutgoing(item.draft, item.id));
      return;
    }
    if (kernelRef.current) {
      // 先在托盘里变成插话（行上显示「下一步工具结束后送达」），带画面的读完画面再交给内核。
      const outgoing = buildOutgoing(item.draft, item.id);
      updateInputQueue(key, list => promoteToSteer(list, id).map(entry => (entry.id === id ? { ...entry, outgoing } : entry)));
      void steerDraft(item.draft, outgoing, key).then(ok => {
        if (ok) return;
        // 这一轮刚好结束了：已经空闲就直接发，否则排到队首。
        demoteSteer(key, id);
        if (turnRef.current.phase === 'idle') drainInputQueue(key);
        else flashCopied(t('agentPanel.inputQueueSendNext'));
      });
      return;
    }
    updateInputQueue(key, list => moveToFront(list, id));
    flashCopied(t('agentPanel.inputQueueSendNext'));
  };

  /** 托盘 🗑：删除一条。插话只能在到达步骤边界前撤回；已被取走的撤不回（马上会出现在对话里）。 */
  const deletePendingInput = (id: string) => {
    const key = conversationKeyRef.current;
    const item = (inputQueuesRef.current[key] || []).find(entry => entry.id === id);
    if (!item) return;
    if (item.kind === 'steer' && !steerPreparing.current.delete(id) && !kernelRef.current?.withdrawSteer(id)) return;
    item.draft.attachments.forEach(releaseComposerAttachment);
    updateInputQueue(key, list => removeInput(list, id));
    focusComposer();
  };

  /** Alt+↑ / Shift+←：把最后一条排队消息取回输入框编辑（接在正在写的内容前面）。 */
  const popQueuedToComposer = () => {
    const key = conversationKeyRef.current;
    const { item, rest } = popLastQueued(inputQueuesRef.current[key] || []);
    if (!item) return false;
    updateInputQueue(key, () => rest);
    fillComposer(mergeDrafts([item.draft], composerDraft()));
    return true;
  };

  // 卸载时释放队列里附件的 object URL。
  useEffect(() => () => {
    Object.values(inputQueuesRef.current).flat().forEach(item => item.draft.attachments.forEach(releaseComposerAttachment));
  }, []);

  const runTurn = async (outgoing: OutgoingTurn) => {
    turnStoppedRef.current = false;
    const { requestText, attachments: turnAttachments, references: turnReferences } = outgoing;
    const assistantId = `stream-${crypto.randomUUID()}`;
    const turnKey = conversationKeyRef.current;
    turnConversationKey.current = turnKey;
    answerStreamingRef.current = false;
    // 排队的消息可能被上一轮结束时的快照刷掉：重新补上这条用户消息。
    setMessages(items => items.some(item => item.id === outgoing.id) ? items : [...items, { id: outgoing.id, role: 'user', text: outgoing.displayText, ...(outgoing.messageReferences.length ? { references: outgoing.messageReferences } : {}), ...(outgoing.displayAttachments.length ? { attachments: outgoing.displayAttachments } : {}) }]);
    const { turnId } = dispatchTurn({ type: 'send' });
    setTurnStartedAt(Date.now());
    setSetupBlocker(null);
    activity.current('running');
    // 每轮一个新的 AbortController：停止只作用于这一轮，不复用已 abort 的控制器。
    const controller = new AbortController();
    abort.current = controller;
    let failed = false;
    try {
      if (kernelRef.current) {
        // 浏览器内置 PI 内核：事件已通过 subscribe 实时推送，这里只需等待完成并同步 snapshot
        // @引用的图片/视频节点自动附带画面（图片 ≤1024px，视频首/中/尾帧，最多 6 张）。
        const media = await loadTurnMedia(turnReferences, turnAttachments);
        turnAttachments.forEach(releaseComposerAttachment);
        const kernelText = media.notes.length > 0 ? requestText + '\n\n已附带画面：\n' + media.notes.join('\n') : requestText;
        const turnContext = turnContextFor(turnReferences, media.nodeSent);
        if (turnContext) await kernelRef.current.send(kernelText, media.images, skillAttachment, turnContext);
        else await kernelRef.current.send(kernelText, media.images, skillAttachment);
        const snapshot = await kernelRef.current.snapshot() as IrisAgentSnapshot;
        if (latestTurnFailed(snapshot)) failed = true;
        handleEvent({ type: 'snapshot', snapshot: snapshot as IrisAgentSnapshot }, assistantId);
      } else {
        turnAttachments.forEach(releaseComposerAttachment);
        // 托管 Agent 的 /turn 只收文本，无法随消息带图片；明确告知而不是假装看过画面。
        const mediaText = turnAttachments.length
          ? requestText + '\n\n注意：本轮附带的本地媒体（' + turnAttachments.map(item => item.name).join('、') + '）无法通过当前托管通道传给 Agent，请先让用户上传到画布或改用内置 Agent。'
          : requestText;
        // 我的 Skill 只存在浏览器里，本机 Agent 的包注册表解析不到：把指令随本轮文本带过去，不绑定包。
        const userSkill = isUserSkillAttachment(skillAttachment);
        const managedText = userSkill && skillAttachment ? skillSystemContext(skillAttachment) + '\n\n' + mediaText : mediaText;
        const remoteTurnId = crypto.randomUUID();
        managedTurnId.current = remoteTurnId;
        try {
          await client.current!.turn(project.id, managedText, event => {
            if ((event.type === 'error' && !isAbortMessage(event.message)) || (event.type === 'snapshot' && latestTurnFailed(event.snapshot))) failed = true;
            handleEvent(event, assistantId);
          }, controller.signal, userSkill ? undefined : skillAttachment, remoteTurnId);
        } finally {
          if (managedTurnId.current === remoteTurnId) managedTurnId.current = undefined;
        }
      }
      activity.current(failed ? 'error' : 'done');
    } catch (error) {
      if (controller.signal.aborted || isAbortMessage(errorMessage(error))) {
        setMessages(items => [...items, { id: crypto.randomUUID(), role: 'system', text: abortedNoticeText(language) }]);
      } else {
        const message = errorMessage(error);
        const blocker = classifyAgentSetupError(error);
        if (blocker === 'credential' || isAgentTextConfigurationError(message)) setSetupBlocker('credential');
        setMessages(items => [...items, { id: crypto.randomUUID(), role: 'error', text: agentMessageText(message, language) }]);
        activity.current('error');
      }
    } finally {
      if (abort.current === controller) abort.current = undefined;
      dispatchTurn({ type: 'settled', turnId });
      // 会话标题由内核在 persist 时从首条用户消息派生；回合结束后主动刷新，
      // 否则标题要等用户点开会话菜单才更新。
      void refreshSessions();
      answerStreamingRef.current = false;
      // 这一轮结束时还没被取走的插话（这一轮在步骤边界之前就结束 / 出错了）：从内核取回，
      // 转成排在最前的排队消息，作为下一轮重新提交。停止时托盘已经清空、内容退回了输入框。
      kernelRef.current?.takePendingSteers?.();
      updateInputQueue(turnKey, items => requeueSteers(items));
      drainInputQueue(turnKey);
    }
  };

  // 停止：本轮进入 stopping；发送 promise 结束或取消请求结束，先到者把输入框收回 idle，停止按钮不会卡住。
  const stop = () => {
    const { phase, turnId } = turnRef.current;
    if (phase !== 'sending' && phase !== 'awaitingConfirmation') return;
    turnStoppedRef.current = true;
    dispatchTurn({ type: 'stop' });
    // 停止就是结束这一轮：插话与排队都退回输入框（排在正在写的内容前面），一条也不发；内核的插话缓冲在 cancel 里清空。
    const stopKey = turnConversationKey.current;
    const pending = trayOrder(inputQueuesRef.current[stopKey] || []);
    if (pending.length) {
      updateInputQueue(stopKey, () => []);
      fillComposer(mergeDrafts(pending.map(item => item.draft), composerDraft()));
    }
    rejectConfirmations();
    askRef.current?.resolve({ ok: false, cancelled: true });
    askRef.current = undefined;
    setPendingAsk(undefined);
    abort.current?.abort();
    activity.current('idle');
    const cancelled = kernelRef.current ? kernelRef.current.cancel() : client.current?.cancel(project.id, managedTurnId.current);
    void Promise.resolve(cancelled).catch(() => undefined).finally(() => dispatchTurn({ type: 'settled', turnId }));
  };

  const updatePrompt = (value: string) => {
    setPrompt(value);
    const match = value.match(/@([^@\s]*)$/);
    setMentionQuery(match?.[1] || '');
    const slash = match ? null : value.match(/(?:^|\s)\/([^\s/]*)$/);
    dispatchLayer({ type: 'promptChanged', mention: match ? match[1] : null, slash: slash ? slash[1] : null });
    setReplaceTarget(null);
  };

  const addReference = (reference: AgentReference) => {
    if (replaceTarget) {
      // 替换模式：用新引用顶替目标 chip（保持原位置与类型）
      setReferences(current => current.map(item => item === replaceTarget ? { ...reference } : item));
      setReplaceTarget(null);
    } else {
      setReferences(current => current.some(item => item.id === reference.id && item.type === reference.type) ? current : [...current, reference]);
    }
    setPrompt(current => current.replace(/@([^@\s]*)$/, ''));
    dispatchLayer({ type: 'close', layer: 'mention' });
    setMentionQuery('');
    window.requestAnimationFrame(() => textarea.current?.focus());
  };

  const openReferencePicker = (type?: AgentReference['type']) => {
    setMentionQuery('');
    dispatchLayer({ type: 'open', layer: 'mention' });
    if (type === 'asset') setPrompt(current => current.replace(/@([^@\s]*)$/, ''));
    window.requestAnimationFrame(() => textarea.current?.focus());
  };

  const startReplace = (reference: AgentReference) => {
    setReplaceTarget(reference);
    openReferencePicker(reference.type);
  };

  const referenceIcon = (reference: AgentReference) => reference.type === 'asset'
    ? reference.mediaType?.startsWith('video/') ? <Video size={13} /> : <ImageIcon size={13} />
    : reference.mediaType === 'video' ? <Video size={13} /> : reference.mediaType === 'image' ? <ImageIcon size={13} /> : <Box size={13} />;


  // 画布「添加到 Agent」：分组节点变成引用 chip，并可保存为可复用的 Skill。
  const pendingGroup = useAgentGroupInboxStore(state => state.pendingGroup);
  useEffect(() => {
    if (!pendingGroup) return;
    const payload = useAgentGroupInboxStore.getState().consume();
    if (!payload) return;
    const byId = new Map(project.nodes.map(node => [node.id, node]));
    const groupRefs = payload.nodeIds.flatMap(id => {
      const node = byId.get(id);
      return node ? [{ id: node.id, type: 'node' as const, label: node.title || '未命名节点', mediaType: node.type, group: { label: payload.label, ...(payload.batchId ? { batchId: payload.batchId } : {}) } }] : [];
    });
    setReferences(current => [...current, ...groupRefs.filter(ref => !current.some(item => item.type === 'node' && item.id === ref.id))]);
    setGroupBanner({ ...payload, nodeIds: groupRefs.map(ref => ref.id) });
  }, [pendingGroup, project.nodes]);

  // ── 画布 Agent 会话卡（plugin:agent-session）：卡片只是这个面板会话的投影 ──
  // 卡片把「发送 / 打开」放进 useCanvasAgentStore.requests；这里用同一个内核与会话执行（不另起运行时），
  // 并把绑定会话的实时进度写回 live，一轮结束只把 entryId + 摘录记到节点上。
  const canvasRequests = useCanvasAgentStore(state => state.requests);
  const canvasBusyRef = useRef(false);
  // 刚由画布发起的一轮：会话 id 写进节点前（或托管 Agent 没有会话 id）也能找到对应卡片。
  const canvasTurnRef = useRef<{ cardId: string; sessionId: string } | null>(null);
  // 本面板里跑过一轮的卡片：只为这些卡片记录摘要（单纯打开旧会话不写画布）。
  const canvasTurnCards = useRef(new Set<string>());
  const canvasRecorded = useRef(new Set<string>());
  const boundCardId = useMemo(() => {
    const viaTurn = canvasTurnRef.current && canvasTurnRef.current.sessionId === activeSessionId ? canvasTurnRef.current.cardId : null;
    if (viaTurn && liveNodes.some(node => node.id === viaTurn)) return viaTurn;
    if (!activeSessionId) return null;
    return liveNodes.find(node => isAgentSessionNode(node) && node.metadata.agentSession?.sessionId === activeSessionId)?.id ?? null;
  }, [liveNodes, activeSessionId]);
  useEffect(() => {
    if (status === 'connecting') return;
    const store = useCanvasAgentStore.getState();
    const nodes = useWorkflowStore.getState().projects.find(item => item.id === project.id)?.nodes || projectRef.current.nodes;
    const runners = runnersRef.current;
    // 逐个看队列：能当场处理的（打开当前会话、交给后台运行）立刻处理；暂时不能的跳过，不挡后面的请求（排队修复）。
    let request: (typeof canvasRequests)[number] | undefined;
    let card: WorkflowNode | undefined;
    let meta: NonNullable<WorkflowNode['metadata']['agentSession']> | undefined;
    for (const candidate of canvasRequests) {
      if (candidate.projectId !== project.id) continue;
      const candidateCard = nodes.find(node => node.id === candidate.cardNodeId);
      const candidateMeta = candidateCard?.metadata.agentSession;
      if (!candidateCard || !candidateMeta) { store.take(candidate.id); continue; }
      // 「展开」：卡片的会话正在跑时它本来就是当前会话，直接放行。
      if (candidate.kind === 'open' && (!candidateMeta.sessionId || candidateMeta.sessionId === activeSessionIdRef.current)) { store.take(candidate.id); continue; }
      // 会话正在画布后台运行（Session Authority 认领中）：这一轮结束前不能在 Drawer 里打开写入。
      if (candidate.kind === 'open' && candidateMeta.sessionId && runners?.isRunningSession(candidateMeta.sessionId)) {
        store.take(candidate.id);
        flashCopied(language === 'zho' ? '这个会话正在画布上运行，结束后可在这里查看完整记录' : 'This conversation is running on the canvas; open it here when it finishes');
        continue;
      }
      // 卡片的会话就是面板正在跑的这个会话：等面板这一轮结束再在面板里接着跑（同一会话不能两个运行时同时写）；跳过，不挡后面的请求。
      if (candidate.kind === 'send' && (sending || canvasBusyRef.current) && candidateMeta.sessionId && candidateMeta.sessionId === activeSessionIdRef.current && !runners?.isActive(candidateCard.id)) continue;
      // 面板忙（正在跑 / 等审批）或这张卡已经在后台跑：发送交给后台运行时，不排在面板后面干等。
      if (candidate.kind === 'send' && runners && (sending || canvasBusyRef.current || runners.isActive(candidateCard.id))) {
        store.take(candidate.id);
        const liveNow = useWorkflowStore.getState().projects.find(item => item.id === project.id)?.nodes || nodes;
        canvasTurnCards.current.delete(candidateCard.id);
        runners.enqueue({
          id: candidate.id,
          cardNodeId: candidateCard.id,
          ...(candidateMeta.sessionId ? { sessionId: candidateMeta.sessionId } : {}),
          text: candidate.text,
          references: agentSessionTurnReferences(candidateMeta, liveNow),
        });
        continue;
      }
      if (sending || canvasBusyRef.current) continue;
      if (!request) { request = candidate; card = candidateCard; meta = candidateMeta; }
    }
    if (!request || !card || !meta) return;
    store.take(request.id);
    canvasBusyRef.current = true;
    const target = { request, card, meta };
    void (async () => {
      const { request, card, meta } = target;
      const kernel = kernelRef.current;
      try {
        if (request.kind === 'open') {
          if (!kernel || !meta.sessionId) return;
          const sessions = await kernel.listSessions();
          if (!sessions.some(item => item.id === meta.sessionId)) { flashCopied(language === 'zho' ? '这张卡片的会话已删除' : 'This card\'s conversation was deleted'); return; }
          await kernel.openSessionById(meta.sessionId);
          setMessages(displayMessages(await kernel.snapshot() as IrisAgentSnapshot, languageRef.current));
          await refreshSessions();
          return;
        }
        if (!kernel && !client.current) {
          // 没有可用模型 / 本机 Agent 离线：面板里给出原有的引导，卡片上给一句话和去处。
          connectionBlocked();
          const missingModel = !isTauri() && !browserRouteSignature;
          store.setLive(card.id, {
            phase: 'error',
            preview: '',
            prompt: request.text,
            error: missingModel ? (language === 'zho' ? '还没有可用的文本模型。' : 'No text model is configured yet.') : (language === 'zho' ? 'Agent 暂时连不上。' : 'Agent is not reachable.'),
            errorKind: missingModel ? 'no-model' : 'failed',
          });
          return;
        }
        let sessionId = '';
        if (kernel) {
          const sessions = await kernel.listSessions();
          if (meta.sessionId && sessions.some(item => item.id === meta.sessionId)) {
            if (activeSessionIdRef.current !== meta.sessionId) await kernel.openSessionById(meta.sessionId);
          } else {
            await kernel.newSession();
          }
          const snapshot = await kernel.snapshot() as IrisAgentSnapshot;
          sessionId = String((snapshot as { sessionId?: string }).sessionId || '');
          setMessages(displayMessages(snapshot, languageRef.current));
          setActiveSessionId(sessionId);
          if (sessionId) {
            const bound = await bindAgentSessionCard({ projectId: project.id, nodeId: card.id, sessionId, prompt: request.text });
            if (bound.ok === false) throw new Error(bound.error);
          }
        }
        canvasTurnRef.current = { cardId: card.id, sessionId };
        canvasTurnCards.current.add(card.id);
        store.setLive(card.id, { phase: 'running', preview: '', prompt: request.text });
        const liveNow = useWorkflowStore.getState().projects.find(item => item.id === project.id)?.nodes || nodes;
        await dispatchOutgoing(buildOutgoing({ text: request.text, quote: null, references: agentSessionTurnReferences(meta, liveNow), attachments: [] }));
      } catch (error) {
        store.setLive(card.id, { phase: 'error', preview: '', prompt: request.kind === 'send' ? request.text : undefined, error: errorMessage(error), errorKind: 'failed' });
      } finally {
        canvasBusyRef.current = false;
        // 处理完一个后让 effect 再看一眼队列（同一 tick 里到达的请求）。
        useCanvasAgentStore.setState(state => ({ requests: [...state.requests] }));
      }
    })();
  }, [canvasRequests, project.id, status, sending]);
  // 把绑定会话的这一轮投影到卡片：进度 + 前几行 + 运行轨迹（思考 / 工具 / Skill / 记忆）+ 审批；结束后记 entryId + 摘录（同一 entryId 只写一次）。
  // 轨迹只从面板已有的显示消息与确认队列归约（agentSessionTrace），不另建存储。
  const drawerOpen = useCanvasAgentStore(state => state.drawerOpen);
  useEffect(() => {
    const cardId = boundCardId;
    if (!cardId) return;
    const { prompt: userMessage, after } = currentTurnMessages(messages);
    if (!userMessage) return;
    const prompt = String(userMessage.text || '').split(/\n\n引用：|\n\n附件：/)[0];
    const assistant = [...after].reverse().find(item => item.role === 'assistant' && item.text);
    const failure = after.find(item => item.role === 'error');
    const store = useCanvasAgentStore.getState();
    const lang = language === 'zho' ? 'zho' : 'en';
    const trace = reduceAgentSessionTrace(after, { running: sending, nodes: liveNodes, language: lang, prompt: userMessage });
    if (sending) {
      // 在 Drawer 里继续这个会话也算：这一轮结束后同样更新卡片摘要。
      canvasTurnCards.current.add(cardId);
      let approval: AgentSessionApproval | undefined;
      if (turn.phase === 'awaitingConfirmation' && confirmation) {
        // 普通工具的询问（按审批模式 / tier）：标题用「工具 · 目标」；付费 / 删除仍用确认卡的那句人话（与后台运行共用 cardApprovalFrom）。
        approval = cardApprovalFrom({
          id: confirmation.id || '',
          ...(confirmation.request ? { request: confirmation.request } : {}),
          summary: confirmation.summary,
          blocked: confirmation.blocked,
          queued: queuedConfirmations,
          trace,
          nodes: liveNodes,
          language: lang,
        });
      } else if (turn.phase === 'awaitingConfirmation' && pendingAsk) {
        approval = { id: pendingAsk.id, title: lang === 'en' ? 'The agent has a question for you' : 'Agent 在问你问题', ask: true };
      }
      const tool = turn.phase === 'awaitingConfirmation'
        ? (language === 'zho' ? '等待你确认' : 'awaiting approval')
        : [...after].reverse().find(item => item.role === 'tool' && item.status === 'pending')?.title;
      store.setLive(cardId, { phase: 'running', preview: assistant?.text || '', prompt, trace, ...(approval ? { approval } : {}), ...(tool ? { tool } : {}) });
      return;
    }
    if (!canvasTurnCards.current.has(cardId)) return;
    const previous = store.live[cardId];
    const traceKey = (value: unknown) => JSON.stringify(value ?? null);
    if (failure) {
      const completedKey = failure.id;
      if (previous?.phase !== 'error' || traceKey(previous.trace) !== traceKey(trace)) store.setLive(cardId, { phase: 'error', preview: '', prompt, error: failure.text, errorKind: setupBlocker === 'credential' ? 'no-model' : 'failed', trace, completedKey });
      if (drawerOpen) store.markSeen(cardId, completedKey);
      return;
    }
    // 用户停下了这一轮（面板或卡片上的停止）：面板会补一条「已停止」系统消息。
    const aborted = turnStoppedRef.current || after.some(item => item.role === 'system' && item.text === abortedNoticeText(language));
    if (!assistant) {
      // 这一轮结束了但没有正文（停在思考 / 工具中途，或模型只调了工具）：卡片不能一直挂着「运行中」。
      if (previous?.phase === 'running' || previous?.phase === 'queued') store.setLive(cardId, { phase: 'done', preview: '', prompt, trace, completedKey: userMessage.id, ...(aborted ? { stopped: true } : {}) });
      return;
    }
    const entryId = assistant.id && !assistant.id.startsWith('stream-') ? assistant.id : undefined;
    const completedKey = previous?.completedKey && previous.phase === 'done' && !entryId ? previous.completedKey : (entryId || assistant.id);
    if (previous?.phase !== 'done' || previous.preview !== assistant.text || traceKey(previous.trace) !== traceKey(trace) || previous.completedKey !== completedKey || Boolean(previous.stopped) !== aborted) {
      store.setLive(cardId, { phase: 'done', preview: assistant.text, prompt, trace, completedKey, ...(aborted ? { stopped: true } : {}) });
    }
    // Drawer 正显示这个会话：完成即已读。
    if (drawerOpen) store.markSeen(cardId, completedKey);
    const recordKey = cardId + ':' + (entryId || assistant.id) + ':' + assistant.text.length;
    if (canvasRecorded.current.has(recordKey)) return;
    canvasRecorded.current.add(recordKey);
    void recordAgentSessionTurn({ projectId: project.id, nodeId: cardId, turn: { ...(entryId ? { entryId } : {}), prompt, reply: assistant.text, status: 'done', at: new Date().toISOString() } });
  }, [boundCardId, messages, sending, turn.phase, project.id, setupBlocker, language, confirmation, pendingAsk, queuedConfirmations, liveNodes, drawerOpen]);

  // 卡片上的「批准 / 拒绝」：按确认 id 对上当前确认，走与 Drawer 确认卡同一个入口（decideConfirmation / decideRunPlan → runApproval 的 verdict）。
  // 预算门挡住的批次不能从卡片批准；卡片只给「仅这一次」，会话授权 / 付费授权仍在 Drawer 里给。
  const canvasApprovalRef = useRef<CanvasAgentApprovalHandler>(() => false);
  canvasApprovalRef.current = ({ cardNodeId, approvalId, approved }) => {
    // 后台运行的卡片：审批在它自己的会话队列里（A 等审批不挡 B）。
    // 先告诉 Iris Link 是谁、批还是拒（decide 会同步推进运行状态，轨迹里要记下这次决定）。
    if (runnersRef.current?.get(cardNodeId)?.approval?.id === approvalId) notifyAgentLinkDecision(project.id, { cardNodeId, approvalId, approved });
    if (runnersRef.current?.decide(cardNodeId, approvalId, approved)) return true;
    const pending = confirmationRef.current.current;
    if (!pending) {
      const ask = askRef.current;
      if (ask && ask.id === approvalId && !approved) { settleAsk(ask, { ok: false, cancelled: true }); return true; }
      return false;
    }
    const decision = resolveCardApprovalDecision({ pendingId: pending.id, approvalId, approved, plan: isRunPlanRequest(pending.request), blocked: pending.blocked });
    if (decision.kind === 'ignored') return false;
    if (decision.kind === 'plan') decideRunPlan(pending, decision.decision, { session: false });
    else decideConfirmation(pending, decision.approved, decision.scope);
    return true;
  };
  useEffect(() => {
    const handler: CanvasAgentApprovalHandler = input => canvasApprovalRef.current(input);
    useCanvasAgentStore.getState().setApprovalHandler(handler);
    return () => { if (useCanvasAgentStore.getState().approvalHandler === handler) useCanvasAgentStore.getState().setApprovalHandler(null); };
  }, []);

  // 卡片上的「停止」：后台运行的卡片只取消它自己的运行时；面板主运行时那一轮（卡片绑定的就是当前会话）走面板的停止。
  const canvasStopRef = useRef<CanvasAgentStopHandler>(() => false);
  canvasStopRef.current = cardNodeId => {
    if (runnersRef.current?.cancel(cardNodeId)) return true;
    if (boundCardId === cardNodeId && sending) { stop(); return true; }
    return false;
  };
  useEffect(() => {
    const handler: CanvasAgentStopHandler = cardNodeId => canvasStopRef.current(cardNodeId);
    useCanvasAgentStore.getState().setStopHandler(handler);
    return () => { if (useCanvasAgentStore.getState().stopHandler === handler) useCanvasAgentStore.getState().setStopHandler(null); };
  }, []);
  // 后台运行 → 卡片投影；结束时把摘录记到节点（与面板那一轮同一个 recordAgentSessionTurn）。
  projectRunnerRef.current = state => {
    const nodes = useWorkflowStore.getState().projects.find(item => item.id === project.id)?.nodes || projectRef.current.nodes;
    useCanvasAgentStore.getState().setLive(state.request.cardNodeId, runnerLive(state, { nodes, language: languageRef.current === 'zho' ? 'zho' : 'en' }));
  };
  finishRunnerRef.current = state => {
    if (state.phase !== 'done') return;
    const reply = [...state.messages].reverse().find(item => item.role === 'assistant' && item.text);
    if (!reply) return;
    const entryId = reply.id.startsWith('stream-') ? undefined : reply.id;
    void recordAgentSessionTurn({ projectId: project.id, nodeId: state.request.cardNodeId, turn: { ...(entryId ? { entryId } : {}), prompt: state.request.text, reply: reply.text, status: 'done', at: new Date().toISOString() } });
    // 刚结束的会话若正是 Drawer 里列表的一项：刷新标题。
    void refreshSessions();
  };
  // 后台轮次要发给内核的文本 / 画面 / turn context：与面板发送同一口径（引用上下文 + @引用画面 + turnContextFor）。
  prepareCanvasRunRef.current = async request => {
    const references = request.references || [];
    const outgoing = buildOutgoing({ text: request.text, quote: null, references, attachments: [] }, request.id);
    const media = await loadTurnMedia(references, []);
    const text = media.notes.length > 0 ? outgoing.requestText + '\n\n已附带画面：\n' + media.notes.join('\n') : outgoing.requestText;
    return { text, images: media.images, turnContext: turnContextFor(references, media.nodeSent) };
  };
  // 面板这一轮结束（会话空出来）：让排在后台队列里、等这个会话的请求重新调度。
  useEffect(() => { if (!sending) runnersRef.current?.pump(); }, [sending]);

  // 卡片轨迹行 → Drawer 定位：agentDrawerRequest 带上 entryId / toolCallId，面板取走后滚到对应消息或工具卡。
  useEffect(() => {
    const take = () => {
      const target = consumeWorkflowAgentDrawerTarget();
      if (!target) return;
      stickToBottom.current = false;
      setJumpToMessage(target.toolCallId ? 'toolcall:' + target.toolCallId : target.entryId || null);
    };
    take();
    return subscribeWorkflowAgentDrawer(take);
  }, []);

  // 头部身份行：当前运行时（浏览器内核 / 本机 Tauri runtime / 外部 harness）· 模型 · 思考档位。所有内置会话卡共用这一份。
  const thinkingVersion = useSyncExternalStore(subscribeAgentThinking, agentThinkingVersion, agentThinkingVersion);
  useEffect(() => {
    const store = useCanvasAgentStore.getState();
    if (status !== 'ready') return;
    const lang = language === 'zho' ? 'zho' : 'en';
    const route = resolveBrowserAgentTextRoute(userApiKeys);
    if (kernelRef.current && route) {
      const level = effectiveAgentThinkingLevel(route.model);
      const mode = availableThinkingLevels(route.modelInfo ?? route.model).mode;
      store.setHarness(agentHarnessIdentity({ runtime: 'browser', model: route.model, thinkingLabel: thinkingLevelText(level, lang, mode), language: lang }));
    } else if (client.current) {
      store.setHarness(agentHarnessIdentity({ runtime: isTauri() ? 'tauri' : 'external', ...(workspaceBridge.current ? { scope: lang === 'en' ? 'workspace-lease · this project' : 'workspace-lease · 当前项目' } : {}), language: lang }));
    } else {
      store.setHarness(null);
    }
  }, [status, kernelRouteSignature, userApiKeys, language, thinkingVersion]);

  const saveGroupAsSkill = async () => {
    if (!groupBanner) return;
    try {
      const recipe = recipeFromNodes(project, groupBanner.nodeIds);
      const skill = skillFromRecipe(recipe, { name: groupBanner.label, slug: groupBanner.label, description: language === 'zho' ? `画布分组「${groupBanner.label}」的操作流程（${recipe.steps.length} 步）` : `Canvas group "${groupBanner.label}" (${recipe.steps.length} steps)` });
      await useUserSkillsStore.getState().save(skill);
      setGroupBanner(current => (current ? { ...current, saved: true } : current));
      // 有本地 Agent 服务时同时编译成标准 Skill 包（带验收），外部 Agent 与 Skill Hub 都能用；没有服务时只留「我的」配方。
      const registry = await createLocalSkillRegistry().catch(() => null);
      if (registry?.draftFromCanvas) {
        const result = await registry.draftFromCanvas({
          id: canvasSkillId(),
          name: groupBanner.label,
          description: skill.description,
          install: true,
          ...canvasSkillDraftPayload(project, groupBanner.nodeIds),
        }).catch(error => ({ installed: false, evaluation: { ok: false, checks: [{ id: 'request', ok: false, message: errorMessage(error) }] } }));
        const failed = result.evaluation.checks.find(check => !check.ok);
        setGroupBanner(current => (current ? { ...current, installed: result.installed, evaluationNote: failed?.message } : current));
      }
    } catch (error) {
      setMessages(items => [...items, { id: crypto.randomUUID(), role: 'error', text: errorMessage(error) }]);
    }
  };

  const focusComposer = () => window.requestAnimationFrame(() => textarea.current?.focus());
  // 斜杠命令只在输入框以「/」开头时出现（/compact 只认开头），且只对浏览器内置内核可用。
  const slashCommands = /^\s*\/[^\s/]*$/.test(prompt) ? agentSlashCommands(language === 'en' ? 'en' : 'zho', { builtin: Boolean(kernelRef.current) }) : [];
  const runQuickAction = (action: Exclude<AgentQuickAction, 'adapt'>) => {
    const zho = language === 'zho';
    if (action === 'perceive') {
      setPrompt(zho ? '请读取当前画布（优先看已引用和已选节点），总结现状，并给出接下来的创作步骤建议。' : 'Read the current canvas (referenced and selected nodes first), summarize it, and propose the next creative steps.');
    } else if (action === 'preset') {
      setCreationMode('storyboard');
      setPrompt(zho ? '从爆款预设开始原创剧本：先给我 3 个当下热门的短片题材方向（每个含一句话梗概和看点），我选定后再展开分镜。' : 'Start an original script from a hit preset: give me 3 trending short-film directions (one-line logline and hook each); I will pick one before you break it into shots.');
    } else {
      const mediaRefs = project.nodes
        .filter(node => node.isVisible !== false && (node.type === 'image' || node.type === 'video'))
        .slice(0, 12)
        .map(node => ({ id: node.id, type: 'node' as const, label: node.title || '未命名节点', mediaType: node.type }));
      setReferences(current => (current.length ? current : mediaRefs));
      setPrompt(zho ? '请批量优化引用的图片/视频节点的提示词：保持原意，补全主体、镜头、光影、风格，并直接更新到对应节点。' : 'Optimize the prompts of the referenced image/video nodes: keep the intent, add subject, camera, lighting and style, and update each node directly.');
    }
    focusComposer();
  };
  const activeSessionTitle = sessionList.find(session => session.id === activeSessionId)?.title || t('agentPanel.newChat');
  const headerLeading = useContext(AgentHeaderLeadingContext);
  const conversationEmpty = !messages.some(message => message.role === 'user' || message.role === 'assistant' || message.role === 'tool');
  const setupGate = Boolean(setupBlocker);
  // 复制与渲染用同一份可见消息：设置引导卡里的重复错误不导出。
  const transcriptMessages = setupGate ? messages.filter(message => message.id !== 'agent-text-config') : messages;
  const uiLanguage: 'en' | 'zho' = language === 'zho' ? 'zho' : 'en';
  const conversationTurns = useMemo(() => splitConversationTurns(transcriptMessages), [transcriptMessages]);
  // 待选择的生成计划卡：有对应的轮次就挂在那一轮末尾；没有（例如外部 Agent 直接发起）就放回确认卡的位置，绝不让它不显示。
  const pendingPlan = confirmation && isRunPlanRequest(confirmation.request) ? confirmation : undefined;
  const pendingPlanInline = Boolean(pendingPlan && (pendingPlan.turnIndex ?? 0) < conversationTurns.length);
  const pendingPlanCard = pendingPlan?.request ? <AgentRunPlanCard
    key={pendingPlan.id}
    request={pendingPlan.request}
    nodes={liveNodes}
    language={uiLanguage}
    blocked={pendingPlan.blocked}
    offerMandate={pendingPlan.offerMandate}
    planMandateNote={describeMandateDenial(mandate, pendingPlan.request)}
    mandateTasks={mandateTasks}
    onMandateTasksChange={setMandateTasks}
    onDecide={(decision, options) => decideRunPlan(pendingPlan, decision, options)}
    onFocusNode={onFocusNode}
  /> : null;
  // 每轮末尾：这一轮已选择过的计划卡（按时间），再加正在等待选择的那张。
  const renderTurnPlans = (turnIndex: number) => {
    const done = trackedPlans.filter(plan => plan.turnIndex === turnIndex);
    const pendingHere = pendingPlanInline && (pendingPlan?.turnIndex ?? 0) === turnIndex;
    if (!done.length && !pendingHere) return null;
    return <>
      {done.map(plan => <AgentRunPlanCard
        key={plan.id}
        request={plan.request}
        nodes={liveNodes}
        language={uiLanguage}
        decision={plan.decision}
        decidedAt={plan.decidedAt}
        onFocusNode={onFocusNode}
      />)}
      {pendingHere && pendingPlanCard}
    </>;
  };
  return (
    <div ref={rootRef} className="workflow-agent is-embedded agent-conversation">
      <header className="workflow-agent__utility agent-conversation__header">
        {headerLeading}
        <button
          type="button"
          className="agent-header-title"
          aria-label={t('agentPanel.history')}
          aria-expanded={sessionsOpen}
          title={t('agentPanel.history')}
          onClick={() => { dispatchLayer({ type: 'toggle', layer: 'sessions' }); setSessionMenuView('sessions'); if (!sessionsOpen) void refreshSessions(); }}
        ><span>{activeSessionTitle}</span><ChevronDown size={13} /></button>
        {sessionsOpen && (
          <div className="agent-session-menu agent-header-menu is-left" role="menu" aria-label={t('agentPanel.history')} {...sessionMenuKeys}>
            {sessionMenuView === 'memory' ? (
              <>
                <button type="button" role="menuitem" onClick={() => setSessionMenuView('sessions')}><ChevronLeft size={14} /><span><strong>{t('agentPanel.backToHistory')}</strong><small>{t('agentPanel.projectMemoryHint', memoryEntries?.length || 0)}</small></span></button>
                <div className="agent-session-menu__list" aria-label={t('agentPanel.projectMemory')}>
                  {!memoryEntries?.length && <p className="agent-session-menu__empty">{t('agentPanel.memoryEmpty')}</p>}
                  {(memoryEntries || []).map(entry => (
                    <div key={entry.id} className="agent-session-menu__item">
                      <button type="button" title={entry.text} onClick={() => undefined}>
                        <strong>{entry.text}</strong>
                        <small>{formatSessionTime(new Date(entry.updatedAt).toISOString(), language)}{entry.tags?.length ? ' · ' + entry.tags.join('、') : ''}</small>
                      </button>
                      <button type="button" aria-label={`${t('agentPanel.deleteMemory')} ${entry.text}`} title={t('agentPanel.deleteMemory')} onClick={() => void useAgentMemoryStore.getState().remove(project.id, entry.id)}><Trash2 size={12} /></button>
                    </div>
                  ))}
                </div>
              </>
            ) : (<>
            <button type="button" role="menuitem" onClick={() => void handleNewConversation()}><Plus size={14} /><span><strong>{t('agentPanel.newChat')}</strong><small>{t('agentPanel.newChatHint')}</small></span></button>
            {kernelRef.current && <button type="button" role="menuitem" disabled={sending} onClick={() => void handleCompactContext()}><Minimize2 size={14} /><span><strong>{t('agentPanel.compactContext')}</strong><small>{t('agentPanel.compactContextHint')}</small></span></button>}
            {kernelRef.current && <button type="button" role="menuitem" onClick={openMemoryView}><BookMarked size={14} /><span><strong>{t('agentPanel.projectMemory')}</strong><small>{t('agentPanel.projectMemoryHint', memoryEntries?.length || 0)}</small></span></button>}
            <div className="agent-session-menu__list">
              {sessionList.length === 0 && <p className="agent-session-menu__empty">{t('agentPanel.noHistory')}</p>}
              {sessionList.map(session => (
                <div key={session.id} className={`agent-session-menu__item${session.id === activeSessionId ? ' is-active' : ''}`}>
                  <button type="button" role="menuitem" onClick={() => void handleOpenSession(session.id)}>
                    <strong>{session.title || t('agentPanel.newChat')}</strong>
                    <small>{formatSessionTime(session.updatedAt, language)}</small>
                  </button>
                  <button type="button" aria-label={`删除对话 ${session.title}`} onClick={() => void handleDeleteSession(session.id)}><Trash2 size={12} /></button>
                </div>
              ))}
            </div>
            </>)}
          </div>
        )}
        <DrawerChromeTabs />
        {copiedNotice && <span className="agent-header-notice" role="status">{copiedNotice}</span>}
        <span className="agent-header-actions">
          <button
            type="button"
            className="agent-new-chat-btn is-icon"
            aria-label={language === 'zho' ? '复制整个对话' : 'Copy conversation'}
            title={language === 'zho' ? '复制整个对话（Markdown）' : 'Copy conversation as Markdown'}
            disabled={transcriptMessages.length === 0}
            onClick={() => void copyConversation()}
          ><Copy size={15} /></button>
          <button type="button" className="agent-new-chat-btn is-icon" aria-label={t('agentPanel.newChat')} title={t('agentPanel.newChat')} onClick={() => void handleNewConversation()}><Plus size={15} /></button>
          <DrawerChromeCollapse />
        </span>
      </header>
      <section className="workflow-agent__body">
        {/* When setup is the blocker, the setup card is the one thing to read: drop the duplicate red config error and the browse/skill decks under it. */}
        <div className="agent-conversation__viewport">
        <div ref={messagesRef} className="agent-conversation__messages"><WorkflowAgentMessages
          messages={transcriptMessages}
          running={sending}
          working={sending ? agentWorkingPhase({
            turnPhase: turn.phase,
            awaitingAsk: Boolean(pendingAsk),
            awaitingConfirmation: Boolean(confirmation),
            messages: transcriptMessages,
            language: language === 'zho' ? 'zho' : 'en',
          }) : undefined}
          turnStartedAt={sending ? turnStartedAt : undefined}
          nodes={project.nodes}
          onOpenReference={reference => { if (reference.kind === 'node' && reference.id) onFocusNode?.(reference.id); }}
          language={language}
          onCopyMessage={copyMessage}
          onBranchMessage={kernelRef.current ? branchFromMessage : undefined}
          branchDisabled={sending}
          onQuoteMessage={message => { setQuote({ messageId: message.id, text: message.text }); focusComposer(); }}
          onPinMessage={openPinReview}
          pinDisabled={sending}
          renderTurnFooter={renderTurnPlans}
          compaction={compaction}
        /></div>
        <AgentTurnTimeline rootRef={messagesRef} turns={conversationTurns} language={uiLanguage} onJump={() => { stickToBottom.current = false; }} />
        <AgentScrollToLatest visible={awayFromBottom && hasMessages} language={uiLanguage} onClick={scrollToLatest} />
        </div>
        {setupBlocker && (
          <div role="alert" data-testid="agent-setup-card" className="agent-card-on-shell mx-3 mb-2 rounded-2xl px-3.5 py-3">
            <p style={{ margin: 0, fontSize: 12, lineHeight: 1.7, color: 'var(--isl-ink-soft)' }}>{localizedAgentSetupMessage(setupBlocker, undefined, language)}</p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
              <button type="button" onClick={onOpenSettings} className="isl-chip flex items-center gap-1 px-3 py-1.5 text-xs font-semibold" style={{ color: 'var(--isl-mint-deep)' }}><KeyRound size={13} />{t('agentPanel.addApiKey')} →</button>
            </div>
          </div>
        )}
        {!setupGate && conversationEmpty && <AgentEmptyState
          language={language}
          onAction={runQuickAction}
          onStoryText={text => { setPrompt(`${language === 'zho' ? '请把以下故事改编为分镜脚本：' : 'Adapt the following story into a shot-by-shot script:'}\n${text}`); setCreationMode('storyboard'); focusComposer(); }}
        />}
        {groupBanner && <div className="agent-group-tiles" role="status">
          <div className="agent-group-tiles__head">
            <LayoutGrid size={14} />
            <span>{groupBanner.nodeIds.length === 1
              ? (language === 'zho' ? '已加入上下文' : 'Added to context')
              : (language === 'zho' ? `已添加分组「${groupBanner.label}」（${groupBanner.nodeIds.length} 个节点）` : `Added group "${groupBanner.label}" (${groupBanner.nodeIds.length} nodes)`)}</span>
            {groupBanner.nodeIds.length <= 1 ? null : groupBanner.saved
              ? <small title={groupBanner.evaluationNote}>{groupBanner.installed
                ? (language === 'zho' ? '已保存，并装入本机 Skill 注册表' : 'Saved and installed as a local Skill')
                : groupBanner.evaluationNote
                  ? (language === 'zho' ? `已保存到「我的」；未装入注册表：${groupBanner.evaluationNote}` : `Saved to My Skills; not installed: ${groupBanner.evaluationNote}`)
                  : (language === 'zho' ? '已保存到「我的」Skill' : 'Saved to My Skills')}</small>
              : <button type="button" onClick={() => void saveGroupAsSkill()}>{language === 'zho' ? '保存为 Skill' : 'Save as Skill'}</button>}
            <button type="button" aria-label={language === 'zho' ? '关闭' : 'Dismiss'} onClick={() => setGroupBanner(null)}><X size={12} /></button>
          </div>
          <AgentMediaTiles
            refs={groupBanner.nodeIds.map(id => ({ id, kind: 'node' as const, label: project.nodes.find(node => node.id === id)?.title || id }))}
            nodes={project.nodes}
            max={8}
            language={language === 'zho' ? 'zho' : 'en'}
            onOpen={reference => { if (reference.id) onFocusNode?.(reference.id); }}
            onRemove={reference => {
              setReferences(current => current.filter(item => !(item.type === 'node' && item.id === reference.id)));
              setGroupBanner(current => {
                if (!current) return current;
                const nodeIds = current.nodeIds.filter(id => id !== reference.id);
                return nodeIds.length ? { ...current, nodeIds } : null;
              });
            }}
          />
        </div>}
        {pinDraft && <ContextCardReview
          key={pinDraft.messageId}
          draft={pinDraft}
          nodes={project.nodes}
          language={language === 'zho' ? 'zho' : 'en'}
          busy={pinBusy}
          error={pinError}
          onCommit={result => void commitPin(result)}
          onCancel={() => setPinDraft(null)}
        />}
        {pendingAsk && <AgentAskCard
          key={pendingAsk.id}
          form={pendingAsk.form}
          language={language === 'zho' ? 'zho' : 'en'}
          onSubmit={data => settleAsk(pendingAsk, { ok: true, data })}
          onCancel={() => settleAsk(pendingAsk, { ok: false, cancelled: true })}
        />}
        {pendingPlan && !pendingPlanInline && pendingPlanCard}
        {confirmation && !isRunPlanRequest(confirmation.request) && <AgentConfirmCard
          key={confirmation.id}
          summary={confirmation.summary}
          request={confirmation.request}
          offerMandate={confirmation.offerMandate}
          blocked={confirmation.blocked}
          nodes={liveNodes}
          language={language === 'zho' ? 'zho' : 'en'}
          planMandateNote={confirmation.request ? describeMandateDenial(mandate, confirmation.request) : undefined}
          mandateTasks={mandateTasks}
          onMandateTasksChange={setMandateTasks}
          queued={queuedConfirmations}
          onDecide={(approved, scope) => decideConfirmation(confirmation, approved, scope)}
        />}
        <AgentInputQueueTray
          items={trayOrder(pendingInputs).map(item => ({ id: item.id, kind: item.kind, text: draftPreview(item.draft) }))}
          collapsed={inputQueueCollapsed}
          onToggle={() => setInputQueueCollapsed(value => !value)}
          onSendNow={sendPendingNow}
          onRemove={deletePendingInput}
          copy={{
            title: t('agentPanel.inputQueueTitle', pendingInputs.length),
            collapse: t('agentPanel.inputQueueCollapse'),
            expand: t('agentPanel.inputQueueExpand'),
            steerMeta: t('agentPanel.inputQueueSteerMeta'),
            sendNow: t('agentPanel.inputQueueSendNow'),
            remove: t('agentPanel.inputQueueRemove'),
            editHint: t('agentPanel.inputQueueEditHint'),
          }}
        />
        <div
          ref={composer}
          className="workflow-agent__composer agent-composer"
          data-testid="agent-composer"
          onDragEnter={event => {
            if (!Array.from(event.dataTransfer.items).some(item => item.kind === 'file' && (item.type.startsWith('image/') || item.type.startsWith('video/')))) return;
            event.preventDefault();
            attachDragDepth.current += 1;
            setAttachDragActive(true);
          }}
          onDragOver={event => {
            if (!Array.from(event.dataTransfer.items).some(item => item.kind === 'file' && (item.type.startsWith('image/') || item.type.startsWith('video/')))) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
          }}
          onDragLeave={event => {
            if (!Array.from(event.dataTransfer.items).some(item => item.kind === 'file' && (item.type.startsWith('image/') || item.type.startsWith('video/')))) return;
            event.preventDefault();
            attachDragDepth.current = Math.max(0, attachDragDepth.current - 1);
            if (attachDragDepth.current === 0) setAttachDragActive(false);
          }}
          onDrop={event => {
            event.preventDefault();
            attachDragDepth.current = 0;
            setAttachDragActive(false);
            void dropComposerFiles(Array.from(event.dataTransfer.files));
          }}
        >
          {quote && <div className="agent-quote-bar" role="group" aria-label={t('agentPanel.quoteReply')} data-testid="agent-quote-bar">
            <div className="agent-quote-bar__head"><Quote size={12} aria-hidden="true" /><strong>{t('agentPanel.quoteReply')}</strong></div>
            <p className="agent-quote-bar__text" title={quote.text}>&gt; {quotePreview(quote.text)}</p>
            <button type="button" className="agent-quote-bar__close" aria-label={t('agentPanel.quoteCancel')} title={t('agentPanel.quoteCancel')} onClick={() => { setQuote(null); focusComposer(); }}><X size={12} /></button>
          </div>}
          {attachDragActive && <div className="agent-composer__drop" aria-hidden="true"><span>{language === 'zho' ? '松手加入本轮对话' : 'Release to attach'}</span></div>}
          <ProductionSkillDeck
            attachment={skillAttachment}
            onChange={value => {
              skillAttachmentDirty.current = true;
              setSkillAttachment(value);
              if (value && slashQuery !== null) setPrompt(current => current.replace(/(^|\s)\/[^\s/]*$/, '$1'));
              dispatchLayer({ type: 'clearSlash' });
              if (value) focusComposer();
            }}
            dropTargetRef={composer}
            open={skillOpen}
            onOpenChange={next => dispatchLayer(next ? { type: 'open', layer: 'skill' } : { type: 'close', layer: 'skill' })}
            searchQuery={slashQuery ?? undefined}
            keyboardRef={skillNav}
            commands={slashCommands}
            onCommand={handleSlashCommand}
          />
          {mentionOpen && <div className="agent-reference-picker flv-frost" id={mentionListId} role="listbox" aria-label={t('agentPanel.referencePicker')}>
            <div className="agent-reference-picker__search"><AtSign size={14} /><span>{replaceTarget ? t('agentPanel.referenceReplace', replaceTarget.label) : mentionQuery ? t('agentPanel.referenceSearch', mentionQuery) : t('agentPanel.referencePrompt')}</span></div>
            <div className="agent-reference-picker__list">
              {mentionItems.length ? (
                <>
                  <ReferenceGroup label={t('agentPanel.referenceGroupNodes')} items={referenceGroups.nodes} onSelect={addReference} icon={referenceIcon} empty={t('agentPanel.referenceNoNodes')} highlighted={highlightedReference} optionId={mentionOptionId} onHover={reference => setMentionHighlight(mentionItems.indexOf(reference))} />
                  <ReferenceGroup label={t('agentPanel.referenceGroupAssets')} items={referenceGroups.assets} onSelect={addReference} icon={referenceIcon} empty={assetLibrary?.items.length ? t('agentPanel.referenceNoAssets') : t('agentPanel.referenceAssetsEmpty')} highlighted={highlightedReference} optionId={mentionOptionId} onHover={reference => setMentionHighlight(mentionItems.indexOf(reference))} />
                </>
              ) : (
                <p className="agent-reference-picker__empty" role="status">{mentionQuery ? t('agentPanel.referenceNoMatch', mentionQuery) : t('agentPanel.referenceNothing')}</p>
              )}
            </div>
            {highlightedReference && <ReferencePreview language={language} reference={highlightedReference} nodes={project.nodes} assets={assetLibrary?.items || []} />}
          </div>}
          {preferredModel && <div className="agent-reference-chips" aria-label={language === 'zho' ? '创作设置' : 'Creation settings'}>
            {preferredModel && <span className="agent-setting-chip">{preferredModel.capability === 'video' ? <Video size={11} /> : <ImageIcon size={11} />}{preferredModel.name}<button type="button" aria-label={language === 'zho' ? `移除模型 ${preferredModel.name}` : `Remove model ${preferredModel.name}`} onClick={() => setPreferredModel(null)}><X size={11} /></button></span>}
          </div>}
          {references.length > 0 && <div className="agent-reference-chips" aria-label="已引用内容">{references.map(reference => <AgentReferenceChip
            key={reference.type + ':' + reference.id}
            node={reference.type === 'node' ? project.nodes.find(item => item.id === reference.id) : undefined}
            icon={referenceIcon(reference)}
            label={reference.label}
            targetLabel={reference.type === 'node' ? '定位节点 ' + reference.label : '已引用资产 ' + reference.label}
            onTarget={() => { if (reference.type === 'node') onFocusNode?.(reference.id); }}
            onReplace={() => startReplace(reference)}
            onRemove={() => setReferences(current => current.filter(item => item !== reference))}
          />)}</div>}
          <textarea
            ref={textarea}
            value={prompt}
            aria-controls={mentionOpen ? mentionListId : undefined}
            aria-activedescendant={mentionOpen && highlightedReference ? mentionOptionId(highlightedReference) : undefined}
            onChange={event => updatePrompt(event.target.value)}
            onKeyDown={event => {
              // 输入法组字中的 Enter / 方向键 / Esc 属于输入法：不发送、不移动列表高亮。
              if (isComposingEvent(event)) return;
              if (event.key === 'Escape' && skillOpen) { event.preventDefault(); dispatchLayer({ type: 'close', layer: 'skill' }); return; }
              if (skillOpen && !event.nativeEvent.isComposing && skillNav.current?.(event.key)) { event.preventDefault(); return; }
              if (event.key === 'Escape' && mentionOpen) { event.preventDefault(); dispatchLayer({ type: 'close', layer: 'mention' }); setReplaceTarget(null); return; }
              if (mentionOpen && !event.nativeEvent.isComposing) {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault();
                  setMentionHighlight(index => nextHighlight(index, mentionItems.length, event.key === 'ArrowDown' ? 1 : -1));
                  return;
                }
                if ((event.key === 'Enter' || event.key === 'Tab') && highlightedReference) {
                  event.preventDefault();
                  addReference(highlightedReference);
                  return;
                }
              }
              if (event.key === 'Backspace' && !prompt && references.length) { event.preventDefault(); setReferences(current => current.slice(0, -1)); return; }
              // Alt+↑ / Shift+←（光标在开头时）：取回最后一条排队消息编辑。
              if (queuedCount(pendingInputs) > 0 && ((event.altKey && event.key === 'ArrowUp')
                || (event.shiftKey && !event.altKey && event.key === 'ArrowLeft' && event.currentTarget.selectionStart === 0 && event.currentTarget.selectionEnd === 0))) {
                event.preventDefault();
                popQueuedToComposer();
                return;
              }
              // 运行中 Tab = 排队（输入框为空时不拦，保留 Tab 移动焦点）。
              if (event.key === 'Tab' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && sending && turn.phase !== 'stopping' && draftHasContent(composerDraft())) {
                event.preventDefault();
                void send('tab');
                return;
              }
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void send('enter');
              }
            }}
            placeholder={needsConfiguration ? t('agentPanel.composerNeedConfig') : status === 'ready' ? (sending ? t('agentPanel.inputQueueRunningHint') : composerPlaceholder || t('agentPanel.composerPlaceholder')) : t('agentPanel.composerOffline')}
            aria-label={t('agentPanel.composerAria')}
            onPaste={event => {
              const files = Array.from(event.clipboardData?.files || []);
              if (!files.length) return;
              // 有文件时阻止默认，避免把图片当成 HTML 文本塞进输入框；纯文本粘贴不受影响。
              event.preventDefault();
              addAttachmentFiles(files);
            }}
            disabled={status === 'connecting'}
          />
          <ComposerAttachmentTray
            attachments={attachments}
            label={language === 'zho' ? '本轮附件' : 'Attachments'}
            removeLabel={language === 'zho' ? '移除附件' : 'Remove attachment'}
            kindLabel={kind => (kind === 'image' ? '图片' : '视频')}
            onRemove={removeAttachment}
          />
          <div className="agent-composer__controls">
            <div className="agent-composer__tools">
              <div className="agent-attachment-control">
                <button type="button" aria-label={t('agentPanel.addAttachment')} aria-expanded={attachmentOpen} onClick={() => dispatchLayer({ type: 'toggle', layer: 'attachment' })}><Plus size={17} /></button>
                {attachmentOpen && <div className="agent-attachment-menu" role="menu" aria-label={t('agentPanel.addAttachment')} {...attachmentMenuKeys}>
                  <button type="button" role="menuitem" onClick={() => openReferencePicker('node')}><Box size={15} /><span><strong>{t('agentPanel.referenceNodes')}</strong><small>{t('agentPanel.referenceNodesHint')}</small></span></button>
                  <button type="button" role="menuitem" onClick={() => openReferencePicker('asset')}><ImageIcon size={15} /><span><strong>{t('agentPanel.referenceAssets')}</strong><small>{t('agentPanel.referenceAssetCount', assetLibrary?.items.length || 0)}</small></span></button>
                  <div role="separator" className="agent-attachment-menu__sep" />
                  <CreationModeMenuSection value={creationMode} onChange={mode => { setCreationMode(mode); dispatchLayer({ type: 'close', layer: 'attachment' }); focusComposer(); }} language={language} />
                </div>}
              </div>
              <AgentModelPicker userApiKeys={userApiKeys} onAddApiKey={onAddApiKey} onUpdateApiKey={onUpdateApiKey} open={modelPickerOpen} onOpenChange={open => dispatchLayer(open ? { type: 'open', layer: 'modelPicker' } : { type: 'close', layer: 'modelPicker' })} language={language} />
              <div className="agent-mode-control agent-approval-control">
                {/* 只留图标：当前模式与说明在 tooltip 和读屏名里。 */}
                <button type="button" className="agent-approval-trigger" aria-label={`${t('agentPanel.approvalMode')}：${t(APPROVAL_MODE_COPY[mode].label)}`} title={`${t(APPROVAL_MODE_COPY[mode].label)} · ${t(APPROVAL_MODE_COPY[mode].hint)}`} aria-expanded={modeOpen} onClick={() => dispatchLayer({ type: 'toggle', layer: 'mode' })}>{(() => { const Icon = APPROVAL_MODE_COPY[mode].icon; return <Icon size={15} aria-hidden="true" />; })()}</button>
                {modeOpen && <div className="agent-mode-menu" role="menu" aria-label={t('agentPanel.approvalMode')}>
                  {APPROVAL_MODE_ORDER.map(item => {
                    const copy = APPROVAL_MODE_COPY[item];
                    const Icon = copy.icon;
                    return <button key={item} type="button" role="menuitem" aria-pressed={mode === item} onClick={() => {
                      modeRef.current = item;
                      // 手动确认模式不使用付费授权；切过去时撤销已有授权。
                      if (item === 'always-ask') { mandateRef.current = null; setMandate(null); }
                      writeApprovalMode(item);
                      setMode(item);
                      dispatchLayer({ type: 'close', layer: 'mode' });
                    }}><Icon size={17} /><span><strong>{t(copy.label)}</strong><small>{t(copy.hint)}</small></span>{mode === item && <Check size={15} />}</button>;
                  })}
                  <details className="agent-mode-menu__policies">
                    <summary style={{ padding: '6px 12px', fontSize: 11, cursor: 'pointer', color: 'var(--isl-ink-soft)' }}>{t('agentPanel.toolPolicies')}{Object.keys(userToolPolicy).length ? ` · ${Object.keys(userToolPolicy).length}` : ''}</summary>
                    {POLICY_TOOLS.map(tool => <label key={tool.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '3px 12px', fontSize: 11 }}>
                      <span>{language === 'zho' ? tool.zho : tool.en}</span>
                      <select aria-label={language === 'zho' ? tool.zho : tool.en} value={userToolPolicy[tool.key] || ''} onChange={event => {
                        const value = event.target.value as ToolPolicy | '';
                        const next = { ...userToolPolicyRef.current };
                        if (value) next[tool.key] = value; else delete next[tool.key];
                        userToolPolicyRef.current = next;
                        writeUserToolPolicy(next);
                        setUserToolPolicy(next);
                      }}>
                        <option value="">{t('agentPanel.toolPolicyDefault')}</option>
                        <option value="allow">{t('agentPanel.toolPolicyAllow')}</option>
                        <option value="prompt">{t('agentPanel.toolPolicyPrompt')}</option>
                        <option value="deny">{t('agentPanel.toolPolicyDeny')}</option>
                      </select>
                    </label>)}
                    {Object.keys(userToolPolicy).length > 0 && <button type="button" role="menuitem" onClick={() => { userToolPolicyRef.current = {}; writeUserToolPolicy({}); setUserToolPolicy({}); }}><X size={17} /><span><strong>{t('agentPanel.resetToolPolicies')}</strong></span></button>}
                  </details>
                  <p style={{ margin: 0, padding: '6px 12px 8px', fontSize: 10, lineHeight: 1.6, color: 'var(--isl-ink-ghost)' }}>{t('agentPanel.approvalHardGates')}</p>
                </div>}
              </div>
              <CreationModeTag value={creationMode} onReset={() => setCreationMode('all')} language={language} />
            </div>
            {sending
              ? <span className="agent-composer__running">
                  {/* 运行中也能发：插话进当前这一轮或排在它之后；停止是独立按钮。「运行中」状态只在消息流的思考指示里显示。 */}
                  {(prompt.trim() || references.length > 0 || attachments.length > 0) && turn.phase !== 'stopping'
                    ? <button type="button" className="agent-composer__send agent-composer__send--queue" aria-label={t('agentPanel.inputQueueSendRunning')} title={t('agentPanel.inputQueueSendRunningTitle')} onClick={() => void send('enter')}><Send size={15} /></button>
                    : null}
                  <span className="agent-composer__stop">
                    <span className="agent-composer__send-ring" aria-hidden="true" />
                    <button type="button" className="agent-composer__send agent-composer__send--stop" aria-label="停止" onClick={stop}><Square size={13} /></button>
                  </span>
                </span>
              : <button type="button" className="agent-composer__send" aria-label="发送" onClick={() => void send()} disabled={status !== 'ready' || (!prompt.trim() && references.length === 0 && attachments.length === 0)}><Send size={16} /></button>}
          </div>
        </div>
      </section>
    </div>
  );
}

const APPROVAL_MODE_ORDER: readonly ApprovalMode[] = ['always-ask', 'write', 'yolo'];
const APPROVAL_MODE_COPY: Record<ApprovalMode, { label: string; hint: string; icon: typeof Hand }> = {
  'always-ask': { label: 'agentPanel.approvalAlwaysAsk', hint: 'agentPanel.approvalAlwaysAskHint', icon: Hand },
  write: { label: 'agentPanel.approvalWrite', hint: 'agentPanel.approvalWriteHint', icon: RotateCw },
  yolo: { label: 'agentPanel.approvalYolo', hint: 'agentPanel.approvalYoloHint', icon: Zap },
};
/** 可设置按工具策略的工具：键与审批层的工具名一致（命令名或内置工具名）。 */
const POLICY_TOOLS: ReadonlyArray<{ key: string; zho: string; en: string }> = [
  { key: 'workflow.apply', zho: '修改画布', en: 'Edit canvas' },
  { key: 'workflow.node.run', zho: '运行生成', en: 'Run generation' },
  { key: 'workflow.image.tool', zho: '图片工具', en: 'Image tools' },
  { key: 'workflow.video.tool', zho: '视频工具', en: 'Video tools' },
  { key: 'workflow.audio.tool', zho: '音频工具', en: 'Audio tools' },
  { key: 'iris_web_search', zho: '联网搜索', en: 'Web search' },
  { key: 'iris_grep', zho: '本地文件搜索', en: 'Local file search' },
];

/** 输入框附件托盘：大圆角方块，1-2 张两列、3 张起三列；进出带错落缩放，托盘高度随内容平滑伸缩。纯展示，不改附件逻辑。 */
function ComposerAttachmentTray({ attachments, label, removeLabel, kindLabel, onRemove }: {
  attachments: AgentComposerAttachment[];
  label: string;
  removeLabel: string;
  kindLabel: (kind: AgentComposerAttachment['kind']) => string;
  onRemove: (attachment: AgentComposerAttachment) => void;
}) {
  const reduce = useReducedMotion();
  const grid = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | 'auto'>('auto');
  useLayoutEffect(() => {
    const node = grid.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const measure = () => setHeight(node.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [attachments.length > 0]);
  const ease = [0.22, 1, 0.36, 1] as const;
  const spring = reduce ? { duration: 0 } : { type: 'spring' as const, stiffness: 520, damping: 38, mass: 0.8 };
  const columns = attachments.length <= 2 ? 2 : 3;
  return (
    <AnimatePresence initial={false}>
      {attachments.length > 0 && <motion.div
        key="tray"
        className="workflow-agent__attachments"
        aria-label={label}
        initial={{ height: 0, opacity: 0 }}
        animate={{ height, opacity: 1 }}
        exit={{ height: 0, opacity: 0 }}
        transition={reduce ? { duration: 0 } : { height: { duration: 0.28, ease }, opacity: { duration: 0.18 } }}
      >
        <div ref={grid} className="workflow-agent__attachments-grid" data-columns={columns}>
          <AnimatePresence mode="popLayout" initial>
            {attachments.map((item, index) => <motion.div
              key={item.id}
              layout={!reduce}
              className="workflow-agent__attachment"
              title={`${item.name} · ${kindLabel(item.kind)}`}
              initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.9, y: 6 }}
              animate={{ opacity: 1, scale: 1, y: 0, transition: reduce ? { duration: 0 } : { ...spring, delay: Math.min(index, 5) * 0.045 } }}
              exit={reduce ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, scale: 0.88, transition: { duration: 0.16, ease } }}
              transition={spring}
            >
              {item.kind === 'image'
                ? <img src={item.previewUrl} alt={item.name} draggable={false} />
                : <video src={item.previewUrl} muted playsInline preload="metadata" />}
              <button type="button" aria-label={`${removeLabel} ${item.name}`} onClick={() => onRemove(item)}><X size={11} strokeWidth={2.4} /></button>
            </motion.div>)}
          </AnimatePresence>
        </div>
      </motion.div>}
    </AnimatePresence>
  );
}

function ReferenceGroup({ label, items, onSelect, icon, empty, highlighted, optionId, onHover }: {
  label: string;
  items: AgentReference[];
  onSelect: (reference: AgentReference) => void;
  icon: (reference: AgentReference) => React.ReactNode;
  empty: string;
  highlighted?: AgentReference;
  optionId: (reference: AgentReference) => string;
  onHover: (reference: AgentReference) => void;
}) {
  return <section className="agent-reference-group"><strong>{label}</strong>{items.length
    ? items.map(item => {
      const active = item === highlighted;
      return (
        <button
          type="button"
          role="option"
          id={optionId(item)}
          aria-selected={active}
          className={active ? 'is-highlighted' : undefined}
          key={item.type + ':' + item.id}
          // 不抢输入框焦点：鼠标按下时阻止默认聚焦，点击照常选中。
          onMouseDown={event => event.preventDefault()}
          onMouseEnter={() => onHover(item)}
          onClick={() => onSelect(item)}
          ref={active ? element => element?.scrollIntoView?.({ block: 'nearest' }) : undefined}
        >{icon(item)}<span>{item.label}</span><small>{item.type === 'node' ? item.mediaType : item.mediaType?.replace(/^\w+\//, '')}</small></button>
      );
    })
    : <p>{empty}</p>}</section>;
}

