// 模型支持哪些思考强度档位。来源优先级（高 → 低）：
//   1. api：服务商 /models 返回的字段（modelFetcher 解析后随 ModelItem 持久化）；
//   2. registry：pi-ai 内置模型注册表（getSupportedThinkingLevels），首次用到时懒加载；
//   3. rules：services/thinkingLevelFallback.ts 的 id 规则表；
//   4. default：什么都不知道时的五档 off…high。
// 报错里学到的「Supported values」（1 小时有效）在 agentThinking 里叠加在这之上。
import type { ModelItem, ModelThinkingLevel } from '../types';
import { DEFAULT_THINKING_RULE, matchThinkingRule } from './thinkingLevelFallback';

/** 档位升序；'off' 就是 none。 */
export const THINKING_LEVEL_ORDER: readonly ModelThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export type ThinkingLevelSource = 'api' | 'learned' | 'registry' | 'rules' | 'default';

export interface ResolvedModelThinking {
  levels: ModelThinkingLevel[];
  source: ThinkingLevelSource;
  mode: 'effort' | 'toggle';
  mandatory: boolean;
  defaultLevel?: ModelThinkingLevel;
  contextWindow?: number;
  maxOutputTokens?: number;
}

export type ModelThinkingInput = Pick<ModelItem, 'id'> & Partial<Pick<ModelItem,
  'thinkingLevels' | 'thinkingSource' | 'thinkingMode' | 'thinkingMandatory' | 'defaultThinkingLevel' | 'contextWindow' | 'maxOutputTokens'>>;

export function isModelThinkingLevel(value: unknown): value is ModelThinkingLevel {
  return THINKING_LEVEL_ORDER.includes(value as ModelThinkingLevel);
}

export function thinkingLevelRank(level: ModelThinkingLevel): number {
  return THINKING_LEVEL_ORDER.indexOf(level);
}

/** 各家写法 → 统一档位：none/disabled → off，x-high/extra_high → xhigh，maximum → max；认不出返回 null。 */
export function normalizeThinkingLevelName(raw: unknown): ModelThinkingLevel | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (!value) return null;
  if (value === 'none' || value === 'off' || value === 'disabled' || value === 'disable') return 'off';
  if (value === 'minimal' || value === 'minimum' || value === 'min') return 'minimal';
  if (value === 'low') return 'low';
  if (value === 'medium' || value === 'med' || value === 'default') return 'medium';
  if (value === 'high') return 'high';
  if (value === 'xhigh' || value === 'extrahigh' || value === 'veryhigh') return 'xhigh';
  if (value === 'max' || value === 'maximum') return 'max';
  return null;
}

/** 去重、去掉认不出的、按档位升序。 */
export function sortThinkingLevels(levels: Iterable<unknown>): ModelThinkingLevel[] {
  const set = new Set<ModelThinkingLevel>();
  for (const item of levels) {
    const level = isModelThinkingLevel(item) ? item : normalizeThinkingLevelName(item);
    if (level) set.add(level);
  }
  return THINKING_LEVEL_ORDER.filter(level => set.has(level));
}

/** 服务商 /models 读出的能力字段（ModelItem 上同名可选字段）。 */
export type ModelCapabilityFields = Partial<Pick<ModelItem,
  'thinkingLevels' | 'thinkingSource' | 'thinkingMode' | 'thinkingMandatory' | 'defaultThinkingLevel' | 'contextWindow' | 'maxOutputTokens'>>;

/** FetchedModel → 持久化的 ModelItem：带上思考档位与上下文大小，重新拉模型时整体刷新。 */
export function fetchedModelToItem(model: Pick<ModelItem, 'id' | 'capability'> & { name?: string } & ModelCapabilityFields): ModelItem {
  const item: ModelItem = { id: model.id, name: model.name || model.id, capability: model.capability };
  if (model.thinkingLevels?.length) item.thinkingLevels = model.thinkingLevels;
  if (model.thinkingSource) item.thinkingSource = model.thinkingSource;
  if (model.thinkingMode) item.thinkingMode = model.thinkingMode;
  if (model.thinkingMandatory !== undefined) item.thinkingMandatory = model.thinkingMandatory;
  if (model.defaultThinkingLevel) item.defaultThinkingLevel = model.defaultThinkingLevel;
  if (model.contextWindow) item.contextWindow = model.contextWindow;
  if (model.maxOutputTokens) item.maxOutputTokens = model.maxOutputTokens;
  return item;
}

/** 拉取结果里的模型能力字段覆盖到已有条目上（同 id）；其余字段（名字、手动指定的能力）保留。 */
export function refreshModelCapabilityFields(existing: ModelItem, fetched: Pick<ModelItem, 'id'> & ModelCapabilityFields): ModelItem {
  const next: ModelItem = { ...existing };
  for (const field of ['thinkingLevels', 'thinkingSource', 'thinkingMode', 'thinkingMandatory', 'defaultThinkingLevel', 'contextWindow', 'maxOutputTokens'] as const) {
    delete next[field];
    if (fetched[field] !== undefined) (next as any)[field] = fetched[field];
  }
  return next;
}

// ── pi-ai 注册表（懒加载）───────────────────────────────

interface RegistryEntry { levels: ModelThinkingLevel[]; contextWindow?: number; maxTokens?: number }

let registry: Map<string, RegistryEntry> | null = null;
let registryPromise: Promise<void> | null = null;
const registryListeners = new Set<() => void>();
let registryVersion = 0;

/** 注册表加载完成时通知（选择器据此重渲染档位）。 */
export function subscribeThinkingRegistry(listener: () => void): () => void {
  registryListeners.add(listener);
  return () => { registryListeners.delete(listener); };
}
export const thinkingRegistryVersion = () => registryVersion;
export const isThinkingRegistryLoaded = () => registry !== null;

/** 注册表查找用的 id 变体：原样、去掉 provider 前缀、点号换横线、去掉日期后缀。 */
export function registryKeys(modelId: string): string[] {
  const id = String(modelId || '').trim().toLowerCase();
  if (!id) return [];
  const bare = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id;
  const variants = [id, bare, bare.replace(/\./g, '-'), bare.replace(/-\d{8}$/, ''), bare.replace(/\./g, '-').replace(/-\d{8}$/, '')];
  return [...new Set(variants.filter(Boolean))];
}

type PiModel = { id: string; reasoning?: boolean; contextWindow?: number; maxTokens?: number; thinkingLevelMap?: Record<string, unknown> };

/** 测试用：直接注入注册表数据（null 清空）。 */
export function setThinkingRegistryForTest(entries: Record<string, RegistryEntry> | null): void {
  registry = entries ? new Map(Object.entries(entries).map(([key, value]) => [key.toLowerCase(), value])) : null;
  registryPromise = null;
  registryVersion += 1;
  for (const listener of registryListeners) listener();
}

/**
 * 懒加载 pi-ai 内置模型表（各服务商一份 JSON，独立分包），用 getSupportedThinkingLevels 算出档位。
 * 第一方服务商先登记，OpenRouter 只补缺。失败时注册表留空，自动落到规则表。
 */
export function loadThinkingRegistry(): Promise<void> {
  if (registry) return Promise.resolve();
  if (registryPromise) return registryPromise;
  registryPromise = (async () => {
    const map = new Map<string, RegistryEntry>();
    try {
      const [{ getSupportedThinkingLevels }, ...catalogs] = await Promise.all([
        import('@earendil-works/pi-ai'),
        import('@earendil-works/pi-ai/providers/anthropic.models').then(m => m.ANTHROPIC_MODELS),
        import('@earendil-works/pi-ai/providers/openai.models').then(m => m.OPENAI_MODELS),
        import('@earendil-works/pi-ai/providers/google.models').then(m => m.GOOGLE_MODELS),
        import('@earendil-works/pi-ai/providers/deepseek.models').then(m => m.DEEPSEEK_MODELS),
        import('@earendil-works/pi-ai/providers/moonshotai.models').then(m => m.MOONSHOTAI_MODELS),
        import('@earendil-works/pi-ai/providers/xai.models').then(m => m.XAI_MODELS),
        import('@earendil-works/pi-ai/providers/zai.models').then(m => m.ZAI_MODELS),
        import('@earendil-works/pi-ai/providers/minimax.models').then(m => m.MINIMAX_MODELS),
        import('@earendil-works/pi-ai/providers/mistral.models').then(m => m.MISTRAL_MODELS),
        import('@earendil-works/pi-ai/providers/openrouter.models').then(m => m.OPENROUTER_MODELS),
      ]);
      for (const catalog of catalogs) {
        for (const model of Object.values(catalog as Record<string, PiModel>)) {
          const levels = sortThinkingLevels(getSupportedThinkingLevels(model as never));
          if (!levels.length) continue;
          const entry: RegistryEntry = { levels, contextWindow: model.contextWindow, maxTokens: model.maxTokens };
          for (const key of registryKeys(model.id)) if (!map.has(key)) map.set(key, entry);
        }
      }
    } catch (error) {
      console.warn('[modelThinkingLevels] pi-ai 模型注册表加载失败，改用规则表。', error);
    }
    registry = map;
    registryVersion += 1;
    for (const listener of registryListeners) listener();
  })();
  return registryPromise;
}

function lookupRegistry(modelId: string): RegistryEntry | null {
  if (!registry) {
    // 浏览器里首次查询时后台加载；加载完成后订阅者重渲染。
    if (typeof window !== 'undefined') void loadThinkingRegistry();
    return null;
  }
  for (const key of registryKeys(modelId)) {
    const hit = registry.get(key);
    if (hit) return hit;
  }
  return null;
}

// ── 合成 ─────────────────────────────────────────────

/** 模型可用档位（不含报错学习，那一层见 agentThinking.availableThinkingLevels）。 */
export function resolveModelThinking(model: string | ModelThinkingInput): ResolvedModelThinking {
  const info: ModelThinkingInput = typeof model === 'string' ? { id: model } : model;
  const apiLevels = sortThinkingLevels(info.thinkingLevels || []);
  const registryHit = lookupRegistry(info.id);
  const sizes = {
    contextWindow: info.contextWindow ?? registryHit?.contextWindow,
    maxOutputTokens: info.maxOutputTokens ?? registryHit?.maxTokens,
  };
  const clean = <T extends object>(value: T): T => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
  if (apiLevels.length) {
    const mandatory = info.thinkingMandatory ?? !apiLevels.includes('off');
    const levels = mandatory ? apiLevels.filter(level => level !== 'off') : apiLevels;
    return clean({
      levels: levels.length ? levels : apiLevels,
      source: 'api',
      mode: info.thinkingMode ?? 'effort',
      mandatory,
      defaultLevel: info.defaultThinkingLevel,
      ...sizes,
    });
  }
  if (registryHit) {
    return clean({ levels: registryHit.levels, source: 'registry', mode: 'effort', mandatory: !registryHit.levels.includes('off'), defaultLevel: info.defaultThinkingLevel, ...sizes });
  }
  const rule = matchThinkingRule(info.id);
  const picked = rule ?? DEFAULT_THINKING_RULE;
  // API 说了「支持思考 / 开关型」但没给档位：开关型按开 / 关两档。
  const mode = info.thinkingMode ?? picked.mode ?? 'effort';
  const levels = mode === 'toggle' && !rule ? ['off', 'high'] as ModelThinkingLevel[] : picked.levels;
  const mandatory = info.thinkingMandatory ?? picked.mandatory ?? !levels.includes('off');
  return clean({
    levels: mandatory ? (levels.filter(level => level !== 'off').length ? levels.filter(level => level !== 'off') : levels) : levels,
    source: rule ? 'rules' : 'default',
    mode,
    mandatory,
    defaultLevel: info.defaultThinkingLevel,
    ...sizes,
  });
}

/**
 * 就近夹到支持的档位：按档位序距离最近；距离相同取高的一档。
 * 列表为空时原样返回。
 */
export function clampThinkingLevel(level: ModelThinkingLevel, supported: readonly ModelThinkingLevel[]): ModelThinkingLevel {
  if (!supported.length || supported.includes(level)) return level;
  const rank = thinkingLevelRank(level);
  let best = supported[0];
  let bestDistance = Infinity;
  for (const candidate of supported) {
    const distance = Math.abs(thinkingLevelRank(candidate) - rank);
    if (distance < bestDistance || (distance === bestDistance && thinkingLevelRank(candidate) > thinkingLevelRank(best))) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}
