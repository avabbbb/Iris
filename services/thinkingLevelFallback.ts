// 思考强度的最后兜底：既没有服务商 /models 字段、pi-ai 注册表里也查不到时，按模型 id 规则猜档位。
// 规则按「先具体后宽泛」排列，第一条命中即用。档位与 pi-ai 注册表（0.82）和各家文档保持一致，
// 只覆盖常见系列；拿不准的模型落到 DEFAULT_RULE（沿用旧版的 off…high 五档，不比以前少）。
import type { ModelThinkingLevel } from '../types';

export interface ThinkingRule {
  pattern: RegExp;
  levels: ModelThinkingLevel[];
  /** toggle：只能开 / 关，没有强度。 */
  mode?: 'effort' | 'toggle';
  mandatory?: boolean;
}

const BUDGET: ModelThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high'];
const OFF: ModelThinkingLevel[] = ['off'];

export const THINKING_LEVEL_RULES: readonly ThinkingRule[] = [
  // Anthropic：Opus 4.7 起支持 xhigh + max；Opus/Sonnet 4.6 支持 max；3.7 / 4.x 是预算型；更早不支持。
  { pattern: /claude-(?:opus|sonnet|mythos|fable)-(?:[5-9]|4[-.](?:[7-9]|\d{2}))/, levels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] },
  { pattern: /claude-(?:opus|sonnet)-4[-.]6/, levels: ['off', 'minimal', 'low', 'medium', 'high', 'max'] },
  { pattern: /claude-(?:3[-.]7|(?:opus|sonnet|haiku)-4|haiku-[5-9])/, levels: BUDGET },
  { pattern: /claude-/, levels: OFF },
  // OpenAI：gpt-5.6 起有 max；5.2 起有 xhigh；5.1 支持 none；gpt-5 / o 系列必须思考。
  { pattern: /gpt-5[-.](?:[6-9]|\d{2})(?!\d)(?!.*chat)/, levels: ['off', 'low', 'medium', 'high', 'xhigh', 'max'] },
  { pattern: /gpt-5[-.][2-5](?!\d).*-pro/, levels: ['medium', 'high', 'xhigh'], mandatory: true },
  { pattern: /gpt-5[-.][2-5](?!\d)(?!.*chat)/, levels: ['off', 'low', 'medium', 'high', 'xhigh'] },
  { pattern: /gpt-5[-.]1(?!\d)(?!.*chat)/, levels: ['off', 'low', 'medium', 'high'] },
  { pattern: /gpt-5[-.]\d.*chat|gpt-5-chat/, levels: OFF },
  { pattern: /gpt-5(?![-.]\d)/, levels: ['minimal', 'low', 'medium', 'high'], mandatory: true },
  { pattern: /(?:^|\/)o[134](?:-mini|-pro)?(?:$|-)/, levels: ['low', 'medium', 'high'], mandatory: true },
  { pattern: /gpt-oss/, levels: ['low', 'medium', 'high'], mandatory: true },
  { pattern: /gpt-[34]|chatgpt-4o/, levels: OFF },
  // Google：Gemini 3 Pro 只有 low/high 且必须思考；Flash 有 minimal…high；2.5 Pro 必须思考。
  { pattern: /gemini-3(?:[-.]\d+)?-pro/, levels: ['low', 'high'], mandatory: true },
  { pattern: /gemini-3/, levels: ['minimal', 'low', 'medium', 'high'], mandatory: true },
  { pattern: /gemini-2[-.]5-pro/, levels: ['minimal', 'low', 'medium', 'high'], mandatory: true },
  { pattern: /gemini-2[-.]5/, levels: BUDGET },
  { pattern: /gemini-/, levels: OFF },
  // DeepSeek：V4 只有 high / max；reasoner / R1 永远思考；chat（V3）不思考。
  { pattern: /deepseek-v4/, levels: ['off', 'high', 'max'] },
  { pattern: /deepseek-(?:reasoner|r1)/, levels: ['high'], mode: 'toggle', mandatory: true },
  { pattern: /deepseek-(?:chat|v3)/, levels: ['off', 'high'], mode: 'toggle' },
  // Kimi：k2-thinking / k2.5 起可调；早期 k2 不思考。
  { pattern: /kimi-k2[-.](?:[5-9]|thinking)|kimi-k2-thinking|kimi-k[3-9]/, levels: BUDGET },
  { pattern: /kimi-/, levels: OFF },
  // Qwen（DashScope 兼容模式）：qwen3 / qwq 只是 enable_thinking 开关。
  { pattern: /qwq|qwen3(?!.*instruct)|qwen-(?:plus|max|flash|turbo)/, levels: ['off', 'high'], mode: 'toggle' },
  // xAI：grok-3-mini 只有 low/high；grok-4 必须思考、不可调。
  { pattern: /grok-3-mini/, levels: ['low', 'high'], mandatory: true },
  { pattern: /grok-4(?!.*non-reasoning)/, levels: ['high'], mode: 'toggle', mandatory: true },
  // 智谱 GLM 4.5+、MiniMax M2：开关型。
  { pattern: /glm-(?:4[-.][5-9]|[5-9])/, levels: ['off', 'high'], mode: 'toggle' },
  { pattern: /minimax-m[1-9]/, levels: ['high'], mode: 'toggle', mandatory: true },
  // 火山方舟豆包 seed / thinking：开关型。
  { pattern: /doubao-(?:seed|.*thinking)/, levels: ['off', 'high'], mode: 'toggle' },
];

/** 什么都不知道的模型：沿用旧版五档（off…high），不比以前少；真不支持时由报错学习纠正。 */
export const DEFAULT_THINKING_RULE: ThinkingRule = { pattern: /.*/, levels: BUDGET };

/** 只用 id 判断；id 先小写，去掉多余空白。返回 null 表示没有任何规则命中（调用方用 DEFAULT_THINKING_RULE）。 */
export function matchThinkingRule(modelId: string): ThinkingRule | null {
  const id = String(modelId || '').trim().toLowerCase();
  if (!id) return null;
  return THINKING_LEVEL_RULES.find(rule => rule.pattern.test(id)) ?? null;
}
