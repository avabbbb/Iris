import { useSyncExternalStore } from 'react';
import type { ModelThinkingLevel } from '../../types';
import { agentThinkingVersion, availableThinkingLevels, subscribeAgentThinking } from '../../services/agentThinking';
import {
  subscribeThinkingRegistry,
  thinkingRegistryVersion,
  type ModelThinkingInput,
  type ResolvedModelThinking,
  type ThinkingLevelSource,
} from '../../services/modelThinkingLevels';

type Lang = 'en' | 'zho';
const ui = (language: Lang, zho: string, en: string) => (language === 'en' ? en : zho);

export const THINKING_LEVEL_LABEL: Record<ModelThinkingLevel, [string, string]> = {
  off: ['不思考', 'Off'],
  minimal: ['极简', 'Minimal'],
  low: ['低', 'Low'],
  medium: ['中', 'Medium'],
  high: ['高', 'High'],
  xhigh: ['超高', 'X-High'],
  max: ['最大', 'Max'],
};

const SOURCE_LABEL: Record<ThinkingLevelSource, [string, string]> = {
  api: ['服务商模型列表', 'provider model list'],
  learned: ['接口报错（1 小时内）', 'provider error (last hour)'],
  registry: ['内置模型注册表', 'built-in registry'],
  rules: ['模型 id 规则', 'model id rules'],
  default: ['默认', 'default'],
};

/** 档位文字：开关型模型的「开」显示为「开启」。 */
export function thinkingLevelText(level: ModelThinkingLevel, language: Lang, mode: ResolvedModelThinking['mode'] = 'effort'): string {
  if (mode === 'toggle' && level !== 'off') return ui(language, '开启', 'On');
  const [zho, en] = THINKING_LEVEL_LABEL[level];
  return ui(language, zho, en);
}

/** 订阅档位数据变化（报错学习 / 注册表加载完成），返回该模型当前可用档位。 */
export function useModelThinking(model: string | ModelThinkingInput): ResolvedModelThinking {
  useSyncExternalStore(subscribeAgentThinking, agentThinkingVersion, agentThinkingVersion);
  useSyncExternalStore(subscribeThinkingRegistry, thinkingRegistryVersion, thinkingRegistryVersion);
  return availableThinkingLevels(model);
}

export function thinkingSourceText(source: ThinkingLevelSource, language: Lang): string {
  const [zho, en] = SOURCE_LABEL[source];
  return ui(language, zho, en);
}

/** 模型行上的小标签：列出该模型可用的思考档位（不含「不思考」）。 */
export function ThinkingLevelBadge({ model, language = 'zho' }: { model: string | ModelThinkingInput; language?: Lang }) {
  const thinking = useModelThinking(model);
  const on = thinking.levels.filter(level => level !== 'off');
  const text = on.length === 0
    ? ui(language, '不思考', 'No thinking')
    : thinking.mode === 'toggle'
      ? ui(language, thinking.mandatory ? '始终思考' : '思考开关', thinking.mandatory ? 'Always thinks' : 'Thinking on/off')
      : on.map(level => thinkingLevelText(level, language)).join('/');
  const title = `${ui(language, '思考强度', 'Thinking effort')}：${thinking.levels.map(level => thinkingLevelText(level, language, thinking.mode)).join(' · ')}（${ui(language, '来源', 'source')}：${thinkingSourceText(thinking.source, language)}）`;
  return (
    <span
      className={`thinking-level-badge shrink-0 whitespace-nowrap rounded-full border border-[var(--isl-border)] px-1.5 py-px text-[9px] leading-[14px] ${on.length ? 'text-[var(--isl-ink-soft)]' : 'text-[var(--isl-ink-ghost)] opacity-70'}`}
      style={{ flex: 'none' }}
      title={title}
      data-thinking-levels={thinking.levels.join(',')}
      data-thinking-source={thinking.source}
    >
      {text}
    </span>
  );
}
