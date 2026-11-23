// Agent 思考强度（reasoning effort）：全局默认 + 按模型记住的选择 + 不支持该参数的模型名单，存 localStorage。
// 请求体映射只针对 /chat/completions（agent-text 线路都是 OpenAI 兼容协议，见 agentTextRoutes.isAgentTextKey）：
// - 多数服务：reasoning_effort（minimal 只发给明确接受它的 OpenAI / OpenRouter，其余降为 low）；
// - OpenRouter：reasoning: { effort }；
// - Anthropic 的 OpenAI 兼容端点：thinking: { type: 'enabled', budget_tokens }；
// - Google Gemini 的 OpenAI 兼容端点：reasoning_effort（官方兼容层支持 low/medium/high）；
// - Qwen（DashScope 兼容模式）：enable_thinking + thinking_budget。
// 原生 Anthropic Messages / Google generateContent 格式不在 Agent 线路上，所以没有 thinkingConfig 分支。
//
// 档位统一为 off(none) < minimal < low < medium < high < xhigh < max，可用档位按模型动态决定
// （services/modelThinkingLevels.ts：API 字段 → pi-ai 注册表 → 规则表），发送前就近夹到模型支持的档位；
// xhigh / max 原样发给各家接口，不再压成 high。报错里给出「Supported values」时记住 1 小时并用最近档重试。

import type { ModelThinkingLevel } from '../types';
import {
  clampThinkingLevel,
  resolveModelThinking,
  sortThinkingLevels,
  THINKING_LEVEL_ORDER,
  type ModelThinkingInput,
  type ResolvedModelThinking,
} from './modelThinkingLevels';

export type AgentThinkingLevel = ModelThinkingLevel;
export const AGENT_THINKING_LEVELS: readonly AgentThinkingLevel[] = THINKING_LEVEL_ORDER;
export const DEFAULT_AGENT_THINKING_LEVEL: AgentThinkingLevel = 'off';

/** Anthropic（预算型）/ Qwen 这类按 token 预算的服务：预算必须小于请求的 max_tokens（16384）。 */
export const THINKING_BUDGET_TOKENS: Record<Exclude<AgentThinkingLevel, 'off'>, number> = {
  minimal: 1024,
  low: 2048,
  medium: 6144,
  high: 12288,
  xhigh: 14336,
  max: 15360,
};

/** 报错里学到的支持档位有效期。 */
export const LEARNED_LEVELS_TTL_MS = 60 * 60 * 1000;

const STORAGE_KEY = 'iris.agent.thinking';

interface ThinkingState {
  default: AgentThinkingLevel;
  models: Record<string, AgentThinkingLevel>;
  unsupported: Record<string, true>;
  /** 报错「Supported values are …」学到的档位，带学习时间，过期即忽略。 */
  learned: Record<string, { levels: AgentThinkingLevel[]; at: number }>;
}

type RWStorage = Pick<Storage, 'getItem' | 'setItem'>;
const defaultStorage = (): RWStorage | undefined => {
  try { return globalThis.localStorage; } catch { return undefined; }
};

export function isAgentThinkingLevel(value: unknown): value is AgentThinkingLevel {
  return AGENT_THINKING_LEVELS.includes(value as AgentThinkingLevel);
}

function emptyState(): ThinkingState {
  return { default: DEFAULT_AGENT_THINKING_LEVEL, models: {}, unsupported: {}, learned: {} };
}

function readState(storage: RWStorage | undefined): ThinkingState {
  try {
    const parsed = JSON.parse(storage?.getItem(STORAGE_KEY) || 'null') as Partial<ThinkingState> | null;
    if (!parsed || typeof parsed !== 'object') return emptyState();
    const models: Record<string, AgentThinkingLevel> = {};
    for (const [model, level] of Object.entries(parsed.models || {})) if (isAgentThinkingLevel(level)) models[model] = level;
    const unsupported: Record<string, true> = {};
    for (const [model, flag] of Object.entries(parsed.unsupported || {})) if (flag === true) unsupported[model] = true;
    const learned: ThinkingState['learned'] = {};
    for (const [model, entry] of Object.entries(parsed.learned || {})) {
      const levels = sortThinkingLevels(Array.isArray(entry?.levels) ? entry.levels : []);
      if (levels.length && typeof entry?.at === 'number') learned[model] = { levels, at: entry.at };
    }
    return { default: isAgentThinkingLevel(parsed.default) ? parsed.default : DEFAULT_AGENT_THINKING_LEVEL, models, unsupported, learned };
  } catch {
    return emptyState();
  }
}

const listeners = new Set<() => void>();
let version = 0;

function writeState(state: ThinkingState, storage: RWStorage | undefined): void {
  try { storage?.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* 存储不可用时只影响本次 */ }
  version += 1;
  for (const listener of listeners) listener();
}

/** 供 useSyncExternalStore 订阅：任何设置变化都会通知。 */
export function subscribeAgentThinking(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export const agentThinkingVersion = () => version;

/** 用户为该模型选的强度：按模型记住的优先，其次全局默认。 */
export function readAgentThinkingLevel(model: string, storage: RWStorage | undefined = defaultStorage()): AgentThinkingLevel {
  const state = readState(storage);
  return state.models[model] ?? state.default;
}

/** 实际发送的强度：已知不支持思考参数的模型一律 off。 */
export function effectiveAgentThinkingLevel(model: string, storage: RWStorage | undefined = defaultStorage()): AgentThinkingLevel {
  return isReasoningUnsupported(model, storage) ? 'off' : readAgentThinkingLevel(model, storage);
}

/** 选择即记住：写入该模型，并作为新的全局默认（其他没选过的模型跟随）。 */
export function writeAgentThinkingLevel(model: string, level: AgentThinkingLevel, storage: RWStorage | undefined = defaultStorage()): void {
  if (!isAgentThinkingLevel(level)) return;
  const state = readState(storage);
  if (model) state.models[model] = level;
  state.default = level;
  writeState(state, storage);
}

export function isReasoningUnsupported(model: string, storage: RWStorage | undefined = defaultStorage()): boolean {
  return Boolean(model && readState(storage).unsupported[model]);
}

export function markReasoningUnsupported(model: string, storage: RWStorage | undefined = defaultStorage()): void {
  if (!model) return;
  const state = readState(storage);
  if (state.unsupported[model]) return;
  state.unsupported[model] = true;
  writeState(state, storage);
}

/** 让用户重试：清掉「不支持」标记。 */
export function clearReasoningUnsupported(model: string, storage: RWStorage | undefined = defaultStorage()): void {
  const state = readState(storage);
  if (!state.unsupported[model]) return;
  delete state.unsupported[model];
  writeState(state, storage);
}

/** pi-agent-core / 存储里来的档位：认得的原样保留（含 xhigh / max），'none' 视为 off，其余 off。 */
export function normalizeThinkingLevel(value: unknown): AgentThinkingLevel {
  if (isAgentThinkingLevel(value)) return value;
  if (value === 'none') return 'off';
  return 'off';
}

// ── 按模型的可用档位 ────────────────────────────────────

function freshLearned(model: string, storage: RWStorage | undefined, now = Date.now()): AgentThinkingLevel[] | null {
  if (!model) return null;
  const entry = readState(storage).learned[model];
  if (!entry || now - entry.at > LEARNED_LEVELS_TTL_MS) return null;
  return entry.levels;
}

/** 模型当前可用档位：报错学到的（1 小时内）优先，其次 API 字段 → 注册表 → 规则表。 */
export function availableThinkingLevels(
  model: string | ModelThinkingInput,
  storage: RWStorage | undefined = defaultStorage(),
  now = Date.now(),
): ResolvedModelThinking {
  const resolved = resolveModelThinking(model);
  const id = typeof model === 'string' ? model : model.id;
  const learned = freshLearned(id, storage, now);
  if (!learned) return resolved;
  return { ...resolved, levels: learned, source: 'learned', mandatory: !learned.includes('off') };
}

/** 记住报错里给出的支持档位（1 小时后失效，重新按模型数据走）。 */
export function learnSupportedThinkingLevels(model: string, levels: readonly AgentThinkingLevel[], storage: RWStorage | undefined = defaultStorage(), now = Date.now()): void {
  const sorted = sortThinkingLevels(levels);
  if (!model || !sorted.length) return;
  const state = readState(storage);
  state.learned[model] = { levels: sorted, at: now };
  writeState(state, storage);
}

/** 从「Supported values are: 'low', 'medium', and 'high'.」一类报错里解析档位；没有返回 null。 */
export function parseSupportedThinkingValues(body: string): AgentThinkingLevel[] | null {
  const text = String(body || '').replace(/\\"/g, '"');
  const match = text.match(/supported values (?:are|is|include)\s*:?\s*([^\n]{1,300})/i)
    || text.match(/(?:must be one of|expected one of|allowed values(?: are)?|valid values(?: are)?|one of the following)\s*:?\s*([^\n]{1,300})/i);
  if (!match) return null;
  const tokens = match[1].match(/[A-Za-z][A-Za-z_-]*/g) || [];
  const levels = sortThinkingLevels(tokens.filter(token => !/^(and|or|the|values?|are|is)$/i.test(token)));
  return levels.length ? levels : null;
}

/** 用户选的档位就近夹到该模型可用档位（平局往高）；off 始终是 off（不发参数，由模型自己决定）。 */
export function resolveRequestThinkingLevel(
  model: string | ModelThinkingInput,
  requested: AgentThinkingLevel,
  storage: RWStorage | undefined = defaultStorage(),
): AgentThinkingLevel {
  if (requested === 'off') return 'off';
  const id = typeof model === 'string' ? model : model.id;
  if (isReasoningUnsupported(id, storage)) return 'off';
  const { levels } = availableThinkingLevels(model, storage);
  const clamped = clampThinkingLevel(requested, levels);
  return clamped;
}

/**
 * 请求被拒后下一次用什么档位：
 * - 正文给出 Supported values：记住 1 小时，就近夹到其中一档；与当前相同就不再重试（返回 null）；
 * - 只是说不支持思考参数：记为不支持，返回 off；
 * - 与思考无关的错误：null。
 */
export function thinkingLevelAfterRejection(
  model: string,
  level: AgentThinkingLevel,
  status: number,
  body: string,
  storage: RWStorage | undefined = defaultStorage(),
): AgentThinkingLevel | null {
  if (level === 'off' || (status !== 400 && status !== 422)) return null;
  const supported = /reasoning|thinking|effort/i.test(body) ? parseSupportedThinkingValues(body) : null;
  if (supported) {
    learnSupportedThinkingLevels(model, supported, storage);
    const next = clampThinkingLevel(level, supported);
    return next === level ? null : next;
  }
  if (isReasoningRejection(status, body)) {
    markReasoningUnsupported(model, storage);
    return 'off';
  }
  return null;
}

export type ReasoningBodyFormat = 'openai' | 'openrouter' | 'anthropic' | 'qwen';

export function reasoningFormatFor(provider: string, baseUrl = ''): ReasoningBodyFormat {
  const url = baseUrl.toLowerCase();
  if (provider === 'openrouter' || url.includes('openrouter.ai')) return 'openrouter';
  if (provider === 'anthropic' || url.includes('api.anthropic.com')) return 'anthropic';
  if (provider === 'qwen' || url.includes('dashscope')) return 'qwen';
  return 'openai';
}

/** 请求体映射需要的模型信息（可选）：开关型 / 支持的档位。缺省按旧版行为。 */
export type ReasoningModelHints = Partial<Pick<ResolvedModelThinking, 'mode' | 'levels' | 'source'>>;

/**
 * 思考强度 → 请求体字段。off 时返回空对象（完全不发送思考参数）。
 * - 开关型模型：thinking.type=enabled（OpenRouter 为 reasoning.enabled，Qwen 为 enable_thinking）；
 * - xhigh / max 原样发送（OpenAI reasoning_effort / OpenRouter reasoning.effort）；
 * - Anthropic：支持 xhigh / max 的新模型走 adaptive thinking + output_config.effort（这些模型拒绝 budget_tokens），
 *   其余按 budget_tokens；开启 thinking 时不允许自定义 temperature，调用方据 dropTemperature 去掉它。
 */
export function buildReasoningParams(
  level: AgentThinkingLevel,
  route: { provider: string; baseUrl?: string },
  hints: ReasoningModelHints = {},
): { params: Record<string, unknown>; dropTemperature: boolean } {
  if (level === 'off') return { params: {}, dropTemperature: false };
  const format = reasoningFormatFor(route.provider, route.baseUrl);
  if (hints.mode === 'toggle') {
    switch (format) {
      case 'openrouter': return { params: { reasoning: { enabled: true } }, dropTemperature: false };
      case 'anthropic': return { params: { thinking: { type: 'enabled', budget_tokens: THINKING_BUDGET_TOKENS.high } }, dropTemperature: true };
      case 'qwen': return { params: { enable_thinking: true }, dropTemperature: false };
      default: return { params: { thinking: { type: 'enabled' } }, dropTemperature: false };
    }
  }
  // 模型档位已知时 minimal 已在上游夹好，原样发；未知时沿用旧规则：minimal 只发给 OpenAI / OpenRouter。
  const knownLevels = hints.source && hints.source !== 'default' ? hints.levels : undefined;
  const acceptsMinimal = Boolean(knownLevels?.includes('minimal')) || route.provider === 'openai' || format === 'openrouter';
  const effort = level === 'minimal' && !acceptsMinimal ? 'low' : level;
  switch (format) {
    case 'openrouter':
      return { params: { reasoning: { effort } }, dropTemperature: false };
    case 'anthropic': {
      const adaptive = level === 'xhigh' || level === 'max' || Boolean(knownLevels?.some(item => item === 'xhigh' || item === 'max'));
      if (adaptive) {
        return { params: { thinking: { type: 'adaptive' }, output_config: { effort: effort === 'minimal' ? 'low' : effort } }, dropTemperature: true };
      }
      return { params: { thinking: { type: 'enabled', budget_tokens: THINKING_BUDGET_TOKENS[level] } }, dropTemperature: true };
    }
    case 'qwen':
      return { params: { enable_thinking: true, thinking_budget: THINKING_BUDGET_TOKENS[level] }, dropTemperature: false };
    default:
      return { params: { reasoning_effort: effort }, dropTemperature: false };
  }
}

/** HTTP 400/422 且错误正文提到 reasoning/thinking 参数：判定为该模型不支持思考参数。 */
export function isReasoningRejection(status: number, body: string): boolean {
  if (status !== 400 && status !== 422) return false;
  return /reasoning|thinking/i.test(body)
    && /unsupported|not support|unknown|unrecognized|invalid|not allowed|extra (?:inputs|fields)|does not support|not permitted/i.test(body);
}
