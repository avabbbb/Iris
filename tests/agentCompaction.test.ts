import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import {
  BROWSER_AGENT_CONTEXT_WINDOW,
  budgetReserveTokens,
  classifyAgentRequestFailure,
  compactionThresholdTokens,
  estimateRequestTokens,
  estimateTextTokens,
  isContextOverflowMessage,
  shouldCompactContext,
} from '../services/agentCompaction';
import { AGENT_CONTEXT_OVERFLOW_MESSAGE } from '../services/browserAgentKernel';

const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }], timestamp: 1 }) as AgentMessage;
const assistant = (text: string, totalTokens = 0, stopReason = 'stop') => ({
  role: 'assistant', content: [{ type: 'text', text }], stopReason, timestamp: 2,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens },
}) as unknown as AgentMessage;

describe('compaction thresholds (modeled on oh-my-pi)', () => {
  it('triggers at 80% of the window, never past window - max(15% window, 16384)', () => {
    expect(budgetReserveTokens(128_000, { enabled: true, keepRecentTokens: 20_000 })).toBe(19_200);
    expect(compactionThresholdTokens(128_000)).toBe(102_400);
    expect(compactionThresholdTokens(200_000)).toBe(160_000);
    expect(compactionThresholdTokens(32_000)).toBe(32_000 - 16_384);
    expect(shouldCompactContext(102_400, 128_000)).toBe(false);
    expect(shouldCompactContext(102_401, 128_000)).toBe(true);
  });

  it('falls back to the proportional reserve on tiny windows and honours percentages', () => {
    expect(compactionThresholdTokens(16_000)).toBe(12_800);
    expect(compactionThresholdTokens(8_000)).toBe(6_400);
    expect(compactionThresholdTokens(100_000, { enabled: true, keepRecentTokens: 1, thresholdPercent: 50 })).toBe(50_000);
    expect(shouldCompactContext(10_000_000, 128_000, { enabled: false, keepRecentTokens: 1 })).toBe(false);
  });
});

describe('request token estimate', () => {
  it('counts CJK denser than latin text', () => {
    expect(estimateTextTokens('abcd'.repeat(10))).toBe(10);
    expect(estimateTextTokens('中文'.repeat(10))).toBe(14);
  });

  it('uses the latest provider usage plus trailing messages', () => {
    const tokens = estimateRequestTokens({ messages: [user('hi'), assistant('ok', 50_000), user('x'.repeat(400))], systemPrompt: 'S'.repeat(4000), pendingText: 'y'.repeat(40) });
    expect(tokens).toBe(50_000 + 100 + 10);
  });

  it('ignores usage recorded before the latest compaction summary (no re-compaction loop)', () => {
    const messages = [
      { role: 'compactionSummary', summary: 's'.repeat(400), tokensBefore: 120_000, timestamp: 3 } as unknown as AgentMessage,
      assistant('kept from before', 115_000),
      user('next'),
    ];
    const tokens = estimateRequestTokens({ messages, systemPrompt: 'S'.repeat(400), pendingImages: 1 });
    expect(tokens).toBeLessThan(2_000);
    expect(shouldCompactContext(tokens, BROWSER_AGENT_CONTEXT_WINDOW)).toBe(false);
  });

  it('ignores usage of failed or aborted replies', () => {
    expect(estimateRequestTokens({ messages: [assistant('', 999_999, 'error'), user('abcd')] })).toBe(1);
  });
});

describe('context overflow vs refusal', () => {
  it.each([
    "模型请求失败（HTTP 400）：{\"error\":{\"message\":\"This model's maximum context length is 131072 tokens. However, you requested 140000 tokens\"}}",
    '模型请求失败（HTTP 400）：{"error":{"code":"context_length_exceeded"}}',
    'prompt is too long: 210000 tokens > 200000 maximum',
    'Range of input length should be [1, 129024]',
    '请求失败：输入超过模型最大上下文长度',
    AGENT_CONTEXT_OVERFLOW_MESSAGE,
  ])('classifies %s as context overflow', text => {
    expect(classifyAgentRequestFailure(text)).toBe('context_overflow');
  });

  it.each([
    ['模型请求失败（HTTP 400）：{"error":{"code":"content_filter","message":"The response was filtered due to the prompt triggering content management policy"}}', 'refusal'],
    ['模型请求失败（HTTP 400）：data_inspection_failed: Input data may contain inappropriate content.', 'refusal'],
    ['输出内容涉及敏感信息，已拒绝回答', 'refusal'],
    ['模型请求失败（HTTP 429）：Too many tokens per minute, please slow down', 'rate_limit'],
    ['Rate limit reached: tokens per min (TPM) exceeded', 'rate_limit'],
    ['模型请求失败（HTTP 401）：invalid api key', 'other'],
    ['', 'other'],
  ])('does not treat %s as overflow', (text, expected) => {
    expect(classifyAgentRequestFailure(text)).toBe(expected);
  });

  it('only error-stopped assistant messages count', () => {
    const failed = { role: 'assistant', content: [], stopReason: 'error', errorMessage: AGENT_CONTEXT_OVERFLOW_MESSAGE } as unknown as AgentMessage;
    expect(isContextOverflowMessage(failed)).toBe(true);
    expect(isContextOverflowMessage({ ...failed, stopReason: 'stop' } as AgentMessage)).toBe(false);
    expect(isContextOverflowMessage({ ...failed, errorMessage: 'content_filter' } as AgentMessage)).toBe(false);
    expect(isContextOverflowMessage(user('context length exceeded'))).toBe(false);
  });
});
