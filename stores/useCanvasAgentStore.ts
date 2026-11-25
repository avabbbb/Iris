import { create } from 'zustand';
import type { AgentHarnessIdentity, AgentSessionApproval, AgentSessionTrace } from '../components/workflow/agentSessionTrace';

/**
 * 画布会话卡 ↔ 对话面板（IrisAgentPanel）之间的收件箱与实时投影，只在内存里。
 * 运行时与会话只有面板那一份：卡片把「发送 / 打开」请求放进 requests，面板取走后用自己的内核执行；
 * 面板把绑定会话的实时状态（进度、前几行）写进 live，卡片只读。持久的只有节点上的 sessionId 与摘录。
 */
export interface CanvasAgentReference {
  kind: 'node' | 'asset';
  id: string;
  label: string;
}

export type CanvasAgentRequest =
  | { id: string; kind: 'send'; projectId: string; cardNodeId: string; text: string; references: CanvasAgentReference[] }
  | { id: string; kind: 'open'; projectId: string; cardNodeId: string };

export type CanvasAgentLivePhase = 'queued' | 'running' | 'done' | 'error';

export interface CanvasAgentLive {
  phase: CanvasAgentLivePhase;
  /** 流式回复的前几行（纯文本）。 */
  preview: string;
  /** 正在进行的工具（只显示名字，不单独成卡）。 */
  tool?: string;
  /** 这一轮的问题（发出后立即显示，不等持久化）。 */
  prompt?: string;
  error?: string;
  /** 错误的类别：没有模型 / 外部 Agent / 其他。卡片据此给出下一步。 */
  errorKind?: 'no-model' | 'external' | 'failed';
  /** 运行轨迹：从面板的显示消息归约（agentSessionTrace），只在内存里。 */
  trace?: AgentSessionTrace;
  /** 这一轮正在等用户批准：卡片上直接给批准 / 拒绝。 */
  approval?: AgentSessionApproval;
  /** 本页里完成的这一轮的标识（entryId 或完成时间）：与 seen 比较得出「未读」。 */
  completedKey?: string;
  /** 这一轮在画布后台运行时里跑（canvasSessionRunners）：面板忙时卡片的请求不再排在面板后面。 */
  background?: boolean;
  /** 用户在卡片上停止了这一轮。 */
  stopped?: boolean;
  updatedAt: number;
}

/** 卡片「批准 / 拒绝」交给面板：面板注册处理函数，按确认 id 对上当前确认后走 Drawer 同一入口。 */
export type CanvasAgentApprovalHandler = (input: { cardNodeId: string; approvalId: string; approved: boolean }) => boolean;
/** 卡片「停止」交给面板：后台运行的卡片取消它自己的运行时，面板主运行时那一轮走面板的停止。 */
export type CanvasAgentStopHandler = (cardNodeId: string) => boolean;

interface CanvasAgentState {
  requests: CanvasAgentRequest[];
  live: Record<string, CanvasAgentLive>;
  push: (request: CanvasAgentRequest) => void;
  take: (id: string) => CanvasAgentRequest | null;
  setLive: (cardNodeId: string, live: Omit<CanvasAgentLive, 'updatedAt'> | null) => void;
  /** 双击「问 Agent」/「与 Agent 讨论」刚建的卡片：挂载时把光标放进输入框一次。 */
  focusCardId: string | null;
  requestFocus: (cardNodeId: string | null) => void;
  /** 面板当前的运行环境身份（所有内置会话卡共用同一个面板运行时）。 */
  harness: AgentHarnessIdentity | null;
  setHarness: (harness: AgentHarnessIdentity | null) => void;
  /** 每张卡片在 Drawer 里看过的那一轮（completedKey）。只在内存里：刷新后旧的一轮都算已查看。 */
  seen: Record<string, string>;
  markSeen: (cardNodeId: string, key: string) => void;
  /** Drawer（对话页）当前是否可见：可见且正显示这个会话时，完成即已读。 */
  drawerOpen: boolean;
  setDrawerOpen: (open: boolean) => void;
  approvalHandler: CanvasAgentApprovalHandler | null;
  setApprovalHandler: (handler: CanvasAgentApprovalHandler | null) => void;
  stopHandler: CanvasAgentStopHandler | null;
  setStopHandler: (handler: CanvasAgentStopHandler | null) => void;
}

export const useCanvasAgentStore = create<CanvasAgentState>((set, get) => ({
  requests: [],
  live: {},
  focusCardId: null,
  harness: null,
  seen: {},
  drawerOpen: false,
  approvalHandler: null,
  stopHandler: null,
  setStopHandler: handler => set({ stopHandler: handler }),
  setHarness: harness => set(state => (sameHarness(state.harness, harness) ? state : { harness })),
  markSeen: (cardNodeId, key) => set(state => (state.seen[cardNodeId] === key ? state : { seen: { ...state.seen, [cardNodeId]: key } })),
  setDrawerOpen: open => set(state => (state.drawerOpen === open ? state : { drawerOpen: open })),
  setApprovalHandler: handler => set({ approvalHandler: handler }),
  push: request => set(state => {
    // 同一张卡片同一时刻只留一个待发送请求（连点发送不会发两遍）。
    if (request.kind === 'send' && state.requests.some(item => item.kind === 'send' && item.cardNodeId === request.cardNodeId)) return state;
    return { requests: [...state.requests.filter(item => !(item.kind === 'open' && item.cardNodeId === request.cardNodeId && request.kind === 'open')), request] };
  }),
  take: id => {
    const request = get().requests.find(item => item.id === id) || null;
    if (request) set(state => ({ requests: state.requests.filter(item => item.id !== id) }));
    return request;
  },
  setLive: (cardNodeId, live) => set(state => {
    const next = { ...state.live };
    if (live) next[cardNodeId] = { ...live, updatedAt: Date.now() };
    else delete next[cardNodeId];
    return { live: next };
  }),
  requestFocus: cardNodeId => set({ focusCardId: cardNodeId }),
}));

function sameHarness(a: AgentHarnessIdentity | null, b: AgentHarnessIdentity | null) {
  return a === b || Boolean(a && b && a.title === b.title && a.env === b.env && a.name === b.name);
}

let requestSeq = 0;
export function canvasAgentRequestId(): string {
  requestSeq += 1;
  return 'cag-' + Date.now().toString(36) + '-' + requestSeq.toString(36);
}

/** 卡片「发送」：卡片先显示排队中，面板空闲后取走并在这个会话里发出。 */
export function pushCanvasAgentSend(input: { projectId: string; cardNodeId: string; text: string; references: CanvasAgentReference[] }) {
  const text = input.text.trim();
  if (!text) return false;
  const state = useCanvasAgentStore.getState();
  if (state.requests.some(item => item.kind === 'send' && item.cardNodeId === input.cardNodeId)) return false;
  const live = state.live[input.cardNodeId];
  if (live && (live.phase === 'queued' || live.phase === 'running')) return false;
  state.push({ id: canvasAgentRequestId(), kind: 'send', projectId: input.projectId, cardNodeId: input.cardNodeId, text, references: input.references });
  state.setLive(input.cardNodeId, { phase: 'queued', preview: '', prompt: text });
  return true;
}

/** 卡片「展开」：让面板切到这张卡片的会话（打开 Drawer 由调用方 requestWorkflowAgentDrawer 负责）。 */
export function pushCanvasAgentOpen(input: { projectId: string; cardNodeId: string }) {
  useCanvasAgentStore.getState().push({ id: canvasAgentRequestId(), kind: 'open', projectId: input.projectId, cardNodeId: input.cardNodeId });
}

/** 卡片上的「批准 / 拒绝」：交给面板的确认队列（与 Drawer 确认卡同一入口，不绕过预算门）。面板不在时返回 false。 */
export function decideCanvasAgentApproval(input: { cardNodeId: string; approvalId: string; approved: boolean }): boolean {
  const handler = useCanvasAgentStore.getState().approvalHandler;
  return handler ? handler(input) : false;
}

/** 卡片上的「停止」：只停这一张卡片的这一轮。面板不在时返回 false。 */
export function stopCanvasAgentRun(cardNodeId: string): boolean {
  const handler = useCanvasAgentStore.getState().stopHandler;
  return handler ? handler(cardNodeId) : false;
}
