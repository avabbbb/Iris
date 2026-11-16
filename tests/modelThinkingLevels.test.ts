import { afterEach, describe, expect, it } from 'vitest';
import {
  clampThinkingLevel,
  fetchedModelToItem,
  loadThinkingRegistry,
  normalizeThinkingLevelName,
  refreshModelCapabilityFields,
  registryKeys,
  resolveModelThinking,
  setThinkingRegistryForTest,
  sortThinkingLevels,
} from '../services/modelThinkingLevels';
import { matchThinkingRule } from '../services/thinkingLevelFallback';
import { readModelCapabilityFields } from '../services/modelFetcher';

afterEach(() => setThinkingRegistryForTest(null));

describe('thinking level vocabulary', () => {
  it('normalises provider spellings and sorts none < … < max', () => {
    expect(normalizeThinkingLevelName('none')).toBe('off');
    expect(normalizeThinkingLevelName('X-High')).toBe('xhigh');
    expect(normalizeThinkingLevelName('maximum')).toBe('max');
    expect(normalizeThinkingLevelName('bogus')).toBeNull();
    expect(sortThinkingLevels(['max', 'low', 'none', 'high', 'low', 'xhigh', 'medium', 'minimal'])).toEqual(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('clamps to the nearest supported level and breaks ties upward', () => {
    expect(clampThinkingLevel('medium', ['low', 'high'])).toBe('high');
    expect(clampThinkingLevel('minimal', ['off', 'high', 'max'])).toBe('off');
    expect(clampThinkingLevel('medium', ['off', 'high', 'max'])).toBe('high');
    expect(clampThinkingLevel('xhigh', ['off', 'high', 'max'])).toBe('max');
    expect(clampThinkingLevel('max', ['low', 'medium', 'high'])).toBe('high');
    expect(clampThinkingLevel('off', ['low', 'high'])).toBe('low');
    expect(clampThinkingLevel('high', [])).toBe('high');
  });
});

describe('reading provider /models fields', () => {
  it('OpenRouter reasoning.supported_efforts / mandatory and context sizes', () => {
    expect(readModelCapabilityFields({
      id: 'anthropic/claude-opus-4.7',
      context_length: 1_000_000,
      top_provider: { max_completion_tokens: 128_000 },
      supported_parameters: ['reasoning', 'include_reasoning', 'tools'],
      reasoning: { supported_efforts: ['low', 'medium', 'high', 'xhigh', 'max'], mandatory: false },
    })).toEqual({
      thinkingLevels: ['off', 'low', 'medium', 'high', 'xhigh', 'max'],
      thinkingSource: 'api',
      thinkingMode: 'effort',
      thinkingMandatory: false,
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
    });
    expect(readModelCapabilityFields({ id: 'meta/llama', supported_parameters: ['tools', 'temperature'], context_length: 131072 }))
      .toEqual({ thinkingLevels: ['off'], thinkingSource: 'api', contextWindow: 131072 });
    expect(readModelCapabilityFields({ id: 'x', reasoning: { supported_efforts: ['low', 'high'], mandatory: true } }))
      .toMatchObject({ thinkingLevels: ['low', 'high'], thinkingMandatory: true });
  });

  it('Anthropic capabilities.effort, Google thinking, supported_reasoning_levels', () => {
    expect(readModelCapabilityFields({
      id: 'claude-opus-4-7',
      max_input_tokens: 1_000_000,
      max_tokens: 128_000,
      capabilities: { thinking: { supported: true }, effort: { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true }, xhigh: { supported: true }, max: { supported: true } } },
    })).toMatchObject({ thinkingLevels: ['low', 'medium', 'high', 'xhigh', 'max'], thinkingSource: 'api', contextWindow: 1_000_000, maxOutputTokens: 128_000 });
    // Google 只给布尔：记下「支持」，档位交给注册表 / 规则表。
    expect(readModelCapabilityFields({ name: 'models/gemini-3-pro', thinking: true, inputTokenLimit: 1048576, outputTokenLimit: 65536 }))
      .toEqual({ contextWindow: 1048576, maxOutputTokens: 65536 });
    expect(readModelCapabilityFields({ name: 'models/gemini-2.0-flash', thinking: false }))
      .toEqual({ thinkingLevels: ['off'], thinkingSource: 'api' });
    expect(readModelCapabilityFields({ id: 'codex', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' }], context_window: 272000, max_output_tokens: 128000 }))
      .toMatchObject({ thinkingLevels: ['low', 'medium', 'high', 'xhigh'], contextWindow: 272000, maxOutputTokens: 128000 });
  });

  it('Kimi supports_thinking_type (toggle) and think_efforts.default_effort', () => {
    expect(readModelCapabilityFields({ id: 'kimi-k2.6', supports_thinking_type: true, context_length: 262144 }))
      .toEqual({ thinkingLevels: ['off', 'high'], thinkingSource: 'api', thinkingMode: 'toggle', contextWindow: 262144 });
    expect(readModelCapabilityFields({ id: 'kimi-k3', supports_thinking_type: true, think_efforts: { efforts: ['low', 'medium', 'high'], default_effort: 'medium' } }))
      .toMatchObject({ thinkingLevels: ['low', 'medium', 'high'], thinkingMode: 'effort', defaultThinkingLevel: 'medium' });
  });

  it('persists the fields on ModelItem and refreshes them on re-fetch', () => {
    const item = fetchedModelToItem({ id: 'm', name: 'M', capability: 'text', thinkingLevels: ['off', 'high', 'max'], thinkingSource: 'api', contextWindow: 1_000_000 });
    expect(item).toEqual({ id: 'm', name: 'M', capability: 'text', thinkingLevels: ['off', 'high', 'max'], thinkingSource: 'api', contextWindow: 1_000_000 });
    const refreshed = refreshModelCapabilityFields({ ...item, name: 'My M' }, { id: 'm', thinkingLevels: ['off', 'low', 'high'], thinkingSource: 'api', maxOutputTokens: 8192 });
    expect(refreshed).toEqual({ id: 'm', name: 'My M', capability: 'text', thinkingLevels: ['off', 'low', 'high'], thinkingSource: 'api', maxOutputTokens: 8192 });
  });
});

describe('resolving levels: api → registry → rules', () => {
  it('prefers API data over the registry and the rules', () => {
    setThinkingRegistryForTest({ 'claude-opus-4-7': { levels: ['off', 'low'] } });
    expect(resolveModelThinking({ id: 'claude-opus-4-7', thinkingLevels: ['off', 'high', 'max'], thinkingSource: 'api' })).toMatchObject({ levels: ['off', 'high', 'max'], source: 'api', mandatory: false });
    expect(resolveModelThinking('claude-opus-4-7')).toMatchObject({ levels: ['off', 'low'], source: 'registry' });
    setThinkingRegistryForTest({});
    expect(resolveModelThinking('claude-opus-4-7')).toMatchObject({ levels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], source: 'rules' });
    expect(resolveModelThinking('totally-unknown')).toMatchObject({ levels: ['off', 'minimal', 'low', 'medium', 'high'], source: 'default' });
  });

  it('API-only toggle flag yields an on/off pair; mandatory hides off', () => {
    setThinkingRegistryForTest({});
    expect(resolveModelThinking({ id: 'gw-x', thinkingLevels: ['off', 'high'], thinkingMode: 'toggle', thinkingSource: 'api' })).toMatchObject({ mode: 'toggle', levels: ['off', 'high'] });
    expect(resolveModelThinking({ id: 'gw-y', thinkingLevels: ['low', 'high'], thinkingMandatory: true, thinkingSource: 'api' })).toMatchObject({ levels: ['low', 'high'], mandatory: true });
  });

  it('rule table covers the main families', () => {
    expect(matchThinkingRule('gpt-5.6-sol')?.levels).toContain('max');
    expect(matchThinkingRule('openai/gpt-5.2')?.levels).toEqual(['off', 'low', 'medium', 'high', 'xhigh']);
    expect(matchThinkingRule('deepseek-v4-pro')?.levels).toEqual(['off', 'high', 'max']);
    expect(matchThinkingRule('gemini-3-pro-preview')?.levels).toEqual(['low', 'high']);
    expect(matchThinkingRule('claude-sonnet-4-6')?.levels).toContain('max');
    expect(matchThinkingRule('claude-sonnet-4-5')?.levels).not.toContain('max');
    expect(matchThinkingRule('qwen3-max')?.mode).toBe('toggle');
    expect(matchThinkingRule('gpt-4o')?.levels).toEqual(['off']);
  });

  it('lazy-loads the pi-ai built-in registry (getSupportedThinkingLevels)', async () => {
    await loadThinkingRegistry();
    expect(resolveModelThinking('claude-opus-4-7')).toMatchObject({ source: 'registry', levels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], contextWindow: 1_000_000 });
    // OpenRouter 风格的 id（带前缀、点号版本）也能命中第一方条目。
    expect(resolveModelThinking('anthropic/claude-opus-4.7').source).toBe('registry');
    expect(resolveModelThinking('deepseek-v4-pro')).toMatchObject({ source: 'registry', levels: ['off', 'high', 'max'] });
    expect(registryKeys('Anthropic/Claude-Opus-4.5-20251101')).toEqual(expect.arrayContaining(['claude-opus-4-5']));
  });
});
