// 模型上下文窗口 / 输出上限：从模型对象读取（contextWindow 可选），没有时用默认 128K；
// 服务商报「maximum context length is N tokens」一类错误时学习真实窗口，记在本机，
// 之后自动压缩阈值与请求的 max_tokens 都按学到的值计算。
// 思路参考 yetone/magpie（MIT，Copyright (c) 2026 yetone）的「上下文窗口不写死」，按本仓库需要自写。

/** 没有任何窗口数据时的默认上下文窗口。 */
export const DEFAULT_CONTEXT_WINDOW = 128_000;
/** 请求的默认 max_tokens（以前写死在内核里）。 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;
/** 下调 max_tokens 的下限：再低模型连一次工具调用都写不完。 */
export const MIN_MAX_OUTPUT_TOKENS = 1_024;
/** 学到的上限保存 30 天（服务商换窗口的情况很少，过期后重新学习）。 */
const LEARNED_TTL_MS = 30 * 24 * 3_600_000;
const STORAGE_KEY = 'flovart.agent.modelLimits.v1';

export interface LearnedModelLimits {
  /** 服务商报出的真实上下文窗口（token）。 */
  contextWindow?: number;
  /** 服务商报出的输出上限（max_tokens / completion tokens）。 */
  maxOutputTokens?: number;
  learnedAt: number;
}

export interface ParsedContextLimit {
  contextWindow?: number;
  /** 报错里给出的本次输入 token 数（messages 部分）。 */
  inputTokens?: number;
  maxOutputTokens?: number;
}

const positive = (value: unknown): number | undefined => {
  const number = typeof value === 'string' ? Number(value.replace(/[,_\s]/g, '')) : Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
};

const NUM = '(\\d[\\d,_]*)';

/** 窗口：按出现频率排列的服务商文案。第一个捕获组是窗口大小。 */
const WINDOW_PATTERNS: readonly RegExp[] = [
  new RegExp(`maximum context length is ${NUM}`, 'i'), // OpenAI / vLLM / DeepSeek / OpenRouter
  new RegExp(`context length of (?:only )?${NUM}`, 'i'),
  new RegExp(`context window (?:of|is|size is) ${NUM}`, 'i'),
  new RegExp(`maximum prompt length is ${NUM}`, 'i'),
  new RegExp(`exceeds the (?:limit|maximum) of ${NUM} tokens?`, 'i'),
  new RegExp(`context (?:size|length) (?:limit )?(?:is|of) ${NUM}`, 'i'),
  new RegExp(`n_ctx(?:_slot)?\\s*[=:]\\s*${NUM}`, 'i'), // llama.cpp
  new RegExp(`range of input length should be \\[\\s*1\\s*,\\s*${NUM}\\s*\\]`, 'i'), // 通义千问（输入上限）
  new RegExp(`(?:上下文|context)[^\\d]{0,12}(?:最大|上限|长度)[^\\d]{0,8}${NUM}`, 'i'),
];

/** Anthropic：prompt is too long: 210000 tokens > 200000 maximum。 */
const ANTHROPIC_TOO_LONG = new RegExp(`prompt is too long:\\s*${NUM}\\s*tokens?\\s*>\\s*${NUM}`, 'i');
/** OpenAI：you requested 140000 tokens (123616 in the messages, 16384 in the completion)。 */
const REQUESTED_SPLIT = new RegExp(`${NUM} in the messages`, 'i');
const OUTPUT_PATTERNS: readonly RegExp[] = [
  new RegExp(`supports at most ${NUM} completion tokens`, 'i'),
  new RegExp(`max_tokens[^\\d]{0,40}(?:less than or equal to|<=|at most|must be <=|maximum (?:value )?(?:is|of))\\s*\`?${NUM}`, 'i'),
  new RegExp(`maximum (?:output|completion) tokens? (?:is|of) ${NUM}`, 'i'),
  new RegExp(`max_tokens.{0,20}(?:range|should be in) \\[\\s*1\\s*,\\s*${NUM}\\s*\\]`, 'i'),
];

/** 从服务商报错里读出真实窗口 / 输入 / 输出上限；读不出数字时返回 null。 */
export function parseContextLimitFromError(errorText: string | undefined | null): ParsedContextLimit | null {
  const text = String(errorText || '');
  if (!text) return null;
  const out: ParsedContextLimit = {};
  const anthropic = ANTHROPIC_TOO_LONG.exec(text);
  if (anthropic) {
    out.inputTokens = positive(anthropic[1]);
    out.contextWindow = positive(anthropic[2]);
  }
  if (!out.contextWindow) {
    for (const pattern of WINDOW_PATTERNS) {
      const match = pattern.exec(text);
      const value = positive(match?.[1]);
      // 1000 以下多半是别的数字（HTTP 码、字段位置），不当窗口。
      if (value && value >= 1_000) { out.contextWindow = value; break; }
    }
  }
  const split = REQUESTED_SPLIT.exec(text);
  if (split) out.inputTokens = positive(split[1]);
  for (const pattern of OUTPUT_PATTERNS) {
    const value = positive(pattern.exec(text)?.[1]);
    if (value) { out.maxOutputTokens = value; break; }
  }
  return out.contextWindow || out.maxOutputTokens ? out : null;
}

// ---------------------------------------------------------------------------
// 本机记忆（按 baseUrl + 模型）
// ---------------------------------------------------------------------------

const memoryCache = new Map<string, LearnedModelLimits>();
let storageLoaded = false;

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function loadStorage(): void {
  if (storageLoaded) return;
  storageLoaded = true;
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) as Record<string, LearnedModelLimits> : {};
    for (const [key, value] of Object.entries(parsed || {})) if (value && typeof value === 'object') memoryCache.set(key, value);
  } catch {
    // 损坏的记录直接忽略，重新学习。
  }
}

function saveStorage(): void {
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(memoryCache)));
  } catch {
    // 无痕模式 / 配额满：只保留内存里的记录。
  }
}

export const modelLimitsKey = (route: { baseUrl?: string; model: string }) => `${String(route.baseUrl || '').replace(/\/+$/, '')}\u0000${route.model}`;

/** 学到的上限（过期的视为没有）。 */
export function learnedModelLimits(route: { baseUrl?: string; model: string }, now = Date.now()): LearnedModelLimits | null {
  loadStorage();
  const key = modelLimitsKey(route);
  const value = memoryCache.get(key);
  if (!value) return null;
  if (now - Number(value.learnedAt || 0) > LEARNED_TTL_MS) {
    memoryCache.delete(key);
    saveStorage();
    return null;
  }
  return value;
}

/** 记下报错里学到的上限：窗口只往小里改（同一模型报出的更小值更可信）。返回合并后的记录。 */
export function rememberModelLimits(route: { baseUrl?: string; model: string }, parsed: ParsedContextLimit, now = Date.now()): LearnedModelLimits {
  const current = learnedModelLimits(route, now);
  const next: LearnedModelLimits = { ...(current || {}), learnedAt: now };
  if (parsed.contextWindow) next.contextWindow = current?.contextWindow ? Math.min(current.contextWindow, parsed.contextWindow) : parsed.contextWindow;
  if (parsed.maxOutputTokens) next.maxOutputTokens = current?.maxOutputTokens ? Math.min(current.maxOutputTokens, parsed.maxOutputTokens) : parsed.maxOutputTokens;
  memoryCache.set(modelLimitsKey(route), next);
  saveStorage();
  return next;
}

/** 测试用：清空记忆。 */
export function resetLearnedModelLimits(): void {
  memoryCache.clear();
  storageLoaded = true;
  try { storage()?.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// 解析有效窗口与 max_tokens
// ---------------------------------------------------------------------------

/** 模型对象上可选的 contextWindow（模型列表接口返回的 context_length / context_window 归一后的字段）。 */
export function modelContextWindow(model: unknown): number | undefined {
  if (!model || typeof model !== 'object') return undefined;
  const record = model as { contextWindow?: unknown };
  return positive(record.contextWindow);
}

/**
 * 有效上下文窗口：学到的真实窗口 > 模型对象的 contextWindow > 默认 128K；
 * 学到的值比声明的大时仍取较小者（宁可早压缩，不要溢出）。
 */
export function resolveContextWindow(input: { declared?: number; learned?: number | null; fallback?: number } = {}): number {
  const declared = positive(input.declared);
  const learned = positive(input.learned ?? undefined);
  if (declared && learned) return Math.min(declared, learned);
  return learned ?? declared ?? input.fallback ?? DEFAULT_CONTEXT_WINDOW;
}

/**
 * 请求的 max_tokens：默认 16384；学到输出上限时不超过它；窗口较小（或学到的窗口）时不超过窗口的 1/4，
 * 给输入留出空间。报错里给出输入 token 数时，再保证 输入 + 输出 不超过窗口。
 */
export function resolveMaxOutputTokens(input: { contextWindow?: number; learnedMaxOutput?: number | null; inputTokens?: number; fallback?: number } = {}): number {
  let value = input.fallback ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const learned = positive(input.learnedMaxOutput ?? undefined);
  if (learned) value = Math.min(value, learned);
  const window = positive(input.contextWindow);
  if (window) {
    value = Math.min(value, Math.floor(window / 4));
    const inputTokens = positive(input.inputTokens);
    if (inputTokens && inputTokens < window) value = Math.min(value, window - inputTokens - 256);
  }
  return Math.max(MIN_MAX_OUTPUT_TOKENS, Math.floor(value));
}
