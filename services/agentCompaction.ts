// 内置 Agent 的上下文压缩：触发阈值、上下文溢出识别与一次压缩。
// 压缩本身用 pi-agent-core 自带的 prepareCompaction / compact（摘要提示词、切点、拆分轮次都由它负责），
// 这里只提供阈值、token 估算、溢出 / 拒答区分，以及把浏览器流式线路包成 compact() 需要的 completeSimple。
// 阈值与溢出文案的取法参考 oh-my-pi（MIT，© Mario Zechner / Can Bölük / Stencil Labs）：
//   packages/agent/src/compaction/compaction.ts（effectiveReserveTokens / resolveBudgetReserveTokens / resolveThresholdTokens）
//   packages/ai/src/error/flags.ts（CONTEXT_OVERFLOW_EVIDENCE_PATTERNS、429 否决、isContextOverflow）
// 按本仓库需要自写与删减，没有逐字复制。
import { compact, estimateTokens as piEstimateTokens, prepareCompaction } from '@earendil-works/pi-agent-core';
import type { AgentMessage, Session, StreamFn } from '@earendil-works/pi-agent-core';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { DEFAULT_CONTEXT_WINDOW } from './agentContextLimits';

/** 模型没有 contextWindow、也没学到真实窗口时，浏览器内核按 128K 估算。 */
export const BROWSER_AGENT_CONTEXT_WINDOW = DEFAULT_CONTEXT_WINDOW;
/** 自动压缩的默认阈值：上下文窗口的 80%（同时不超过「窗口 − 预留」）。 */
export const DEFAULT_COMPACTION_THRESHOLD_RATIO = 0.8;
/** 手动 /compact 至少保留最近几轮原文（一轮 = 一条用户消息及其后的回复与工具调用）。 */
export const DEFAULT_KEEP_RECENT_TURNS = 2;
/** oh-my-pi / pi 的默认预留：摘要提示词 + 输出。 */
export const DEFAULT_RESERVE_TOKENS = 16_384;
/** 压缩后保留的最近上下文（oh-my-pi 默认 20000）。 */
export const DEFAULT_KEEP_RECENT_TOKENS = 20_000;
/** 溢出后重试：保留更少的最近上下文，确保这次能塞进窗口。 */
export const OVERFLOW_KEEP_RECENT_TOKENS = 8_000;

export interface AgentCompactionSettings {
  enabled: boolean;
  /** 显式预留；缺省按 oh-my-pi：max(15% 窗口, 16384)，小窗口退回 15%。 */
  reserveTokens?: number;
  /** 百分比阈值（1-99）；缺省或 <=0 用默认 80%（且不超过窗口减预留）。 */
  thresholdPercent?: number;
  keepRecentTokens: number;
}

export const DEFAULT_AGENT_COMPACTION_SETTINGS: AgentCompactionSettings = {
  enabled: true,
  thresholdPercent: -1,
  keepRecentTokens: DEFAULT_KEEP_RECENT_TOKENS,
};

/** 预留：max(15% 窗口, reserveTokens 或默认 16384)。 */
export function effectiveReserveTokens(contextWindow: number, settings: AgentCompactionSettings): number {
  return Math.max(Math.floor(contextWindow * 0.15), settings.reserveTokens ?? DEFAULT_RESERVE_TOKENS);
}

/** 默认预留在小窗口里不可能成立时，退回 15% 的比例预留（与 oh-my-pi 同一规则）。 */
export function budgetReserveTokens(contextWindow: number, settings: AgentCompactionSettings): number {
  const reserve = effectiveReserveTokens(contextWindow, settings);
  const proportional = Math.max(1, Math.floor(contextWindow * 0.15));
  const defaulted = settings.reserveTokens === undefined;
  if ((defaulted && reserve >= contextWindow - proportional) || reserve >= contextWindow) return proportional;
  return reserve;
}

/**
 * 触发压缩的 token 数：显式百分比优先；否则取 min(窗口 × 80%, 窗口 − 预留)，
 * 大窗口按 80% 留出摘要与输出空间，小窗口由预留兜底（预留不足时退回 15% 比例预留）。
 */
export function compactionThresholdTokens(contextWindow: number, settings: AgentCompactionSettings = DEFAULT_AGENT_COMPACTION_SETTINGS): number {
  const percent = settings.thresholdPercent;
  if (typeof percent === 'number' && Number.isFinite(percent) && percent > 0) {
    return Math.floor(contextWindow * (Math.min(99, Math.max(1, percent)) / 100));
  }
  const reserved = contextWindow - budgetReserveTokens(contextWindow, settings);
  const ratio = Math.floor(contextWindow * DEFAULT_COMPACTION_THRESHOLD_RATIO);
  return Math.max(0, Math.min(contextWindow - 1, ratio, reserved));
}

export function shouldCompactContext(contextTokens: number, contextWindow: number, settings: AgentCompactionSettings = DEFAULT_AGENT_COMPACTION_SETTINGS): boolean {
  if (!settings.enabled || contextWindow <= 0) return false;
  return contextTokens > compactionThresholdTokens(contextWindow, settings);
}

// ---------------------------------------------------------------------------
// token 估算：中文按约 0.7 token / 字，其余 4 字符 / token，图片约 1200 token。
// ---------------------------------------------------------------------------

const IMAGE_TOKENS = 1_200;
const CJK = /[\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/g;

export function estimateTextTokens(text: string): number {
  const value = String(text || '');
  if (!value) return 0;
  const cjk = value.match(CJK)?.length ?? 0;
  return Math.ceil(cjk * 0.7 + (value.length - cjk) / 4);
}

function contentTokens(content: unknown): number {
  if (typeof content === 'string') return estimateTextTokens(content);
  if (!Array.isArray(content)) return 0;
  let tokens = 0;
  for (const block of content as Array<Record<string, unknown>>) {
    if (block?.type === 'text') tokens += estimateTextTokens(String(block.text || ''));
    else if (block?.type === 'image') tokens += IMAGE_TOKENS;
    else if (block?.type === 'thinking') tokens += estimateTextTokens(String(block.thinking || ''));
    else if (block?.type === 'toolCall') tokens += estimateTextTokens(String(block.name || '') + JSON.stringify(block.arguments ?? {}));
  }
  return tokens;
}

export function estimateMessageTokens(message: AgentMessage): number {
  const record = message as unknown as Record<string, unknown>;
  if (record.role === 'compactionSummary' || record.role === 'branchSummary') return estimateTextTokens(String(record.summary || ''));
  return contentTokens(record.content);
}

function usageTokens(message: AgentMessage): number {
  const record = message as unknown as { role?: string; stopReason?: string; usage?: { totalTokens?: number; input?: number; output?: number; cacheRead?: number; cacheWrite?: number } };
  if (record.role !== 'assistant' || record.stopReason === 'error' || record.stopReason === 'aborted' || !record.usage) return 0;
  const usage = record.usage;
  return usage.totalTokens || (usage.input || 0) + (usage.output || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0);
}

/**
 * 下一次请求大约要多少 token：有服务端 usage 时用「最后一次 usage + 之后新增消息估算」，
 * 但只信最近一次压缩之后产生的 usage（保留尾部里的旧 usage 反映的是压缩前的大上下文，信了会反复压缩）。
 * 没有可信 usage 时全部按字符估算，并加上系统提示词与工具定义。
 */
export function estimateRequestTokens(input: {
  messages: readonly AgentMessage[];
  systemPrompt?: string;
  toolsJson?: string;
  pendingText?: string;
  pendingImages?: number;
}): number {
  const messages = input.messages;
  // 压缩摘要之后的保留尾部仍带着压缩前的 usage：只信时间晚于最近一次压缩的 usage。
  let compactedAt = -Infinity;
  for (const message of messages) {
    const record = message as { role?: string; timestamp?: number };
    if (record.role === 'compactionSummary') compactedAt = Math.max(compactedAt, Number(record.timestamp) || 0);
  }
  let usageIndex = -1;
  let usage = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (compactedAt > -Infinity && !(Number((messages[index] as { timestamp?: number }).timestamp) > compactedAt)) continue;
    const tokens = usageTokens(messages[index]);
    if (tokens > 0) { usageIndex = index; usage = tokens; break; }
  }
  const pending = estimateTextTokens(input.pendingText || '') + (input.pendingImages || 0) * IMAGE_TOKENS;
  if (usageIndex >= 0) {
    let trailing = 0;
    for (let index = usageIndex + 1; index < messages.length; index += 1) trailing += estimateMessageTokens(messages[index]);
    return usage + trailing + pending;
  }
  let total = estimateTextTokens(input.systemPrompt || '') + estimateTextTokens(input.toolsJson || '');
  for (const message of messages) total += estimateMessageTokens(message);
  return total + pending;
}

// ---------------------------------------------------------------------------
// 请求失败分类：上下文溢出才压缩重试；拒答 / 限流 / 其它错误不压缩。
// ---------------------------------------------------------------------------

const CONTEXT_OVERFLOW_PATTERNS: readonly RegExp[] = [
  /prompt is too long/i,
  /input is too long for requested model/i,
  /exceeds the context window/i,
  /input token count.*exceeds the maximum/i,
  /maximum prompt length is \d+/i,
  /reduce the length of the messages/i,
  /maximum context length is \d+/i,
  /exceeds the available context size/i,
  /requested tokens?.*exceed.*context (window|length|size)/i,
  /context (window|length|size).*(exceeded|overflow|too small)/i,
  /(prompt|input).*(too long|too large).*(context|n_ctx)/i,
  /greater than the context length/i,
  /context window exceeds limit/i,
  /exceeded model token limit/i,
  /context[_ ]length[_ ]exceeded/i,
  /model_context_window_exceeded/i,
  /too many tokens/i,
  /token limit exceeded/i,
  /exceeds the limit of \d+ tokens?\b/i,
  /range of input length should be/i, // 通义千问
  /(上下文|context).{0,12}(超出|超过|过长|溢出|长度限制)/,
  /(超出|超过).{0,12}(最大|上限).{0,12}(上下文|token|长度)/i,
];

const REFUSAL_PATTERNS: readonly RegExp[] = [
  /content[_ ]?filter/i,
  /content (management )?polic(y|ies)/i,
  /safety (system|filter|policy)/i,
  /data_inspection_failed/i,
  /inappropriate content/i,
  /responsible ai/i,
  /moderation/i,
  /(敏感|违规|不安全|审核未通过|内容安全|拒绝回答)/,
];

const RATE_LIMIT = /\b429\b|rate.?limit|too many requests|quota|insufficient[_ ]?(balance|quota)|余额不足|限流/i;

export type AgentRequestFailure = 'context_overflow' | 'refusal' | 'rate_limit' | 'other';

/**
 * 把一次失败的模型请求归类。溢出要有明确证据（服务商的上下文 / token 超限文案）；
 * 429 / 额度类文案即使提到 tokens 也是限流，不当溢出（与 oh-my-pi 的 429 否决一致）；
 * 拒答（内容审核）单独归类，绝不触发压缩重试。
 */
export function classifyAgentRequestFailure(errorMessage: string | undefined | null): AgentRequestFailure {
  const text = String(errorMessage || '');
  if (!text) return 'other';
  const status = /HTTP\s*(\d{3})/i.exec(text)?.[1];
  if (status === '429' || RATE_LIMIT.test(text)) return 'rate_limit';
  if (CONTEXT_OVERFLOW_PATTERNS.some(pattern => pattern.test(text))) return 'context_overflow';
  if (REFUSAL_PATTERNS.some(pattern => pattern.test(text))) return 'refusal';
  return 'other';
}

/** 一条助手消息是不是「上下文溢出」导致的失败。 */
export function isContextOverflowMessage(message: AgentMessage | undefined | null): boolean {
  const record = message as { role?: string; stopReason?: string; errorMessage?: string } | undefined | null;
  return record?.role === 'assistant' && record.stopReason === 'error' && classifyAgentRequestFailure(record.errorMessage) === 'context_overflow';
}

// ---------------------------------------------------------------------------
// 执行一次压缩（pi-agent-core 内置）
// ---------------------------------------------------------------------------

/** 摘要要求：中文、保留 Flovart 关键事实。 */
export const COMPACTION_INSTRUCTIONS = '用中文撰写摘要。必须保留：用户的创作目标与已确认的约束（时长、画幅、风格、语言）；'
  + '画布上已创建 / 已确认的节点 id、锚点编号（A01/S01…）与生成结果状态；已读取的技能名称及其关键规则；未完成的待办与下一步。';

/** 手动 /compact 的聚焦说明拼进摘要要求（pi 的 compact() 会以「Additional focus: …」接在摘要提示词后）。 */
export function buildCompactionInstructions(focus?: string | null): string {
  const value = String(focus || '').replace(/\s+/g, ' ').trim().slice(0, 1_000);
  return value
    ? `${COMPACTION_INSTRUCTIONS}\n用户对这次压缩的要求（优先满足，相关细节尽量原样保留）：${value}`
    : COMPACTION_INSTRUCTIONS;
}

/**
 * 解析 /compact [聚焦说明]：不是 /compact 命令时返回 null。
 * `/compact`、`/compact 保留接口设计的讨论`、`/compact\n多行说明` 都认；`/compactx` 不认。
 */
export function parseCompactCommand(input: string): { focus: string } | null {
  const match = /^\s*\/compact(?:\s+([\s\S]*))?$/i.exec(String(input || ''));
  if (!match) return null;
  return { focus: String(match[1] || '').trim() };
}

/** 压缩记录里 Flovart 附加的字段（放在 compaction entry 的 details 里，随会话持久化）。 */
export interface FlovartCompactionDetails {
  /** 压缩前下一次请求的估算（与 tokensAfter 同一口径：含系统提示词与工具定义）。 */
  tokensBefore?: number;
  tokensAfter?: number;
  focus?: string;
  reason?: 'threshold' | 'overflow' | 'manual' | 'midturn';
}

export interface CompactionOutcome {
  tokensBefore: number;
  /** 压缩后下一次请求的估算 token（摘要 + 保留原文 + 系统提示词 / 工具定义开销）。 */
  tokensAfter: number;
  summaryChars: number;
  firstKeptEntryId: string;
}

type BranchEntries = Awaited<ReturnType<Session['getBranch']>>;

function entryMessage(entry: BranchEntries[number]): AgentMessage | undefined {
  return entry.type === 'message' && 'message' in entry ? (entry as { message?: AgentMessage }).message : undefined;
}

/**
 * 保留最近 N 轮原文需要的 token 预算：从最近一次压缩之后的消息里，自后向前数到第 N 条用户消息，
 * 把这段的估算 token 作为保留预算。最多保留「轮数 − 1」轮（总得有东西可压），上限 cap（避免一轮超长时什么都压不掉）。
 */
export function keepRecentTokensForTurns(entries: BranchEntries, turns: number, cap: number): number {
  if (turns <= 0) return 0;
  // 上一次压缩保留的原文（firstKeptEntryId 起）仍在上下文里，从那里开始数。
  let start = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index].type !== 'compaction') continue;
    const keptId = (entries[index] as { firstKeptEntryId?: string }).firstKeptEntryId;
    const kept = keptId ? entries.findIndex(entry => entry.id === keptId) : -1;
    start = kept >= 0 ? kept : index + 1;
    break;
  }
  // 至少要留一轮给摘要：只有 k 轮时最多保留 k − 1 轮原文。
  const userTurns = entries.slice(start).filter(entry => (entryMessage(entry) as { role?: string } | undefined)?.role === 'user').length;
  const keep = Math.min(turns, userTurns - 1);
  if (keep <= 0) return 0;
  let tokens = 0;
  let seen = 0;
  for (let index = entries.length - 1; index >= start; index -= 1) {
    const message = entryMessage(entries[index]);
    if (!message) continue;
    // 用 pi 自己的估算：findCutPoint 按同一口径累计，预算恰好等于这几轮时切点正好落在第 N 条用户消息上。
    tokens += piEstimateTokens(message);
    if ((message as { role?: string }).role === 'user') {
      seen += 1;
      if (seen >= keep) break;
    }
  }
  return Math.min(cap, tokens);
}

/** 最后一条助手消息到末尾（当前这一步的工具调用 + 结果）的 pi 估算 token。 */
export function currentStepTokens(entries: BranchEntries): number {
  let tokens = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const message = entryMessage(entries[index]);
    if (!message) continue;
    tokens += piEstimateTokens(message);
    const role = (message as { role?: string }).role;
    if (role === 'assistant' || role === 'user') break;
  }
  return tokens;
}

/** 压缩后的估算：摘要 + 保留的原文（firstKeptEntryId 起）+ 固定开销。 */
function estimateTokensAfter(entries: BranchEntries, summary: string, firstKeptEntryId: string | undefined, overheadTokens: number): number {
  let kept = 0;
  const index = firstKeptEntryId ? entries.findIndex(entry => entry.id === firstKeptEntryId) : -1;
  if (index >= 0) {
    for (const entry of entries.slice(index)) {
      const message = entryMessage(entry);
      if (message) kept += estimateMessageTokens(message);
    }
  }
  return estimateTextTokens(summary) + kept + Math.max(0, overheadTokens);
}

/** 把 StreamFn 包成 compact() 需要的 models.completeSimple（只用到这一个方法）。 */
export function completeSimpleViaStream(streamFn: StreamFn) {
  return {
    completeSimple: async (model: unknown, context: unknown, options: unknown): Promise<AssistantMessage> => {
      const stream = await (streamFn as unknown as (m: unknown, c: unknown, o: unknown) => unknown)(model, context, options);
      const message = await (stream as { result(): Promise<AssistantMessage> }).result();
      // compact() 拆分轮次时会合并两次摘要的 usage（含 cost）；浏览器线路的 usage 没有 cost，这里补齐。
      const usage = (message.usage || {}) as Partial<AssistantMessage['usage']>;
      return {
        ...message,
        usage: {
          input: usage.input ?? 0,
          output: usage.output ?? 0,
          cacheRead: usage.cacheRead ?? 0,
          cacheWrite: usage.cacheWrite ?? 0,
          totalTokens: usage.totalTokens ?? 0,
          cost: usage.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        } as AssistantMessage['usage'],
      };
    },
  };
}

/**
 * 对会话当前分支做一次压缩并写入 compaction entry。没有可压缩的历史（太短）时返回 null。
 * 失败抛错，调用方决定是否继续原请求。
 */
export async function compactSession(input: {
  session: Session;
  streamFn: StreamFn;
  model: unknown;
  keepRecentTokens?: number;
  /**
   * 回合中途压缩：保留当前这一步（最后一条助手消息及其工具结果）原文。pi 的切点不能落在工具结果上，
   * 工具结果本身超过保留预算时会退回「什么都不压」，所以预算至少要盖住这一步。
   */
  keepCurrentStep?: boolean;
  /** 保留最近几轮原文（按这几轮的估算 token 作为保留预算，不超过 keepRecentCap）。 */
  keepRecentTurns?: number;
  /** 保留最近几轮时的 token 上限（调用方按窗口给出），缺省 60000。 */
  keepRecentCap?: number;
  signal?: AbortSignal;
  instructions?: string;
  /** 手动 /compact 的聚焦说明；会拼进 instructions，并记进压缩记录。 */
  focus?: string;
  reason?: FlovartCompactionDetails['reason'];
  /** 系统提示词 + 工具定义的估算 token，用于算压缩后大约多少 token。 */
  overheadTokens?: number;
  /** 调用方按同一口径估算的压缩前 token（含开销、优先用服务端 usage）；缺省用 pi 的估算。 */
  estimateBefore?: number;
  /** 确认有可压缩的历史、即将调用模型生成摘要时回调（用于面板显示「正在压缩」）。 */
  onStart?: () => void;
}): Promise<CompactionOutcome | null> {
  const entries = await input.session.getBranch();
  const baseKeep = input.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS;
  // 指定了保留轮数：按这几轮的实际大小保留（只有一轮可保留时退回 keepRecentTokens）。
  const turnsBudget = input.keepRecentTurns ? keepRecentTokensForTurns(entries, input.keepRecentTurns, input.keepRecentCap ?? 60_000) : 0;
  let keepRecentTokens = turnsBudget > 0 ? turnsBudget : baseKeep;
  if (input.keepCurrentStep) keepRecentTokens = Math.max(keepRecentTokens, currentStepTokens(entries));
  const prepared = prepareCompaction(entries, {
    enabled: true,
    reserveTokens: DEFAULT_RESERVE_TOKENS,
    keepRecentTokens,
  });
  if (prepared.ok === false) throw new Error((prepared as { error: Error }).error.message);
  const preparation = prepared.value;
  if (!preparation || (preparation.messagesToSummarize.length === 0 && preparation.turnPrefixMessages.length === 0)) return null;
  input.onStart?.();
  const result = await compact(
    preparation,
    completeSimpleViaStream(input.streamFn) as never,
    input.model as never,
    input.instructions ?? buildCompactionInstructions(input.focus),
    input.signal,
  );
  if (result.ok === false) throw new Error(`上下文压缩失败：${(result as { error: Error }).error.message}`);
  const value = result.value;
  if (!value.summary.trim()) throw new Error('上下文压缩失败：模型没有返回摘要。');
  // 不写 retainedTail：带 retainedTail 的压缩会让 getBranch 停在压缩点，下一次压缩时保留尾部既不在旧摘要里也不在新输入里。
  // 只记 firstKeptEntryId，保留的消息仍是普通 entry，再次压缩时会被正确纳入摘要。
  const tokensAfter = estimateTokensAfter(entries, value.summary, value.firstKeptEntryId, input.overheadTokens ?? 0);
  const focus = String(input.focus || '').trim();
  const tokensBefore = input.estimateBefore && input.estimateBefore > 0 ? input.estimateBefore : value.tokensBefore;
  const flovart: FlovartCompactionDetails = { tokensBefore, tokensAfter, ...(focus ? { focus } : {}), ...(input.reason ? { reason: input.reason } : {}) };
  const details = { ...((value.details as object | undefined) || {}), flovart };
  await input.session.appendCompaction(value.summary, value.firstKeptEntryId, value.tokensBefore, details, false, value.usage);
  return { tokensBefore, tokensAfter, summaryChars: value.summary.length, firstKeptEntryId: value.firstKeptEntryId || '' };
}
