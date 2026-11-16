import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import {
  availableThinkingLevels,
  buildReasoningParams,
  LEARNED_LEVELS_TTL_MS,
  parseSupportedThinkingValues,
  resolveRequestThinkingLevel,
  thinkingLevelAfterRejection,
  clearReasoningUnsupported,
  effectiveAgentThinkingLevel,
  isReasoningRejection,
  isReasoningUnsupported,
  markReasoningUnsupported,
  normalizeThinkingLevel,
  readAgentThinkingLevel,
  subscribeAgentThinking,
  writeAgentThinkingLevel,
} from '../services/agentThinking';
import { buildBrowserAgentRequestBody, createBrowserAgentStream } from '../services/browserAgentKernel';

function memoryStorage() {
  const data = new Map<string, string>();
  return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
}

const userMessage = { role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 0 } as unknown as AgentMessage;

describe('agent thinking settings', () => {
  it('remembers a level per model and uses the last choice as the global default', () => {
    const storage = memoryStorage();
    expect(readAgentThinkingLevel('m1', storage)).toBe('off');
    writeAgentThinkingLevel('m1', 'high', storage);
    expect(readAgentThinkingLevel('m1', storage)).toBe('high');
    expect(readAgentThinkingLevel('m2', storage)).toBe('high');
    writeAgentThinkingLevel('m2', 'low', storage);
    expect(readAgentThinkingLevel('m1', storage)).toBe('high');
    expect(readAgentThinkingLevel('m2', storage)).toBe('low');
    expect(readAgentThinkingLevel('m3', storage)).toBe('low');
    writeAgentThinkingLevel('m1', 'bogus' as never, storage);
    expect(readAgentThinkingLevel('m1', storage)).toBe('high');
  });

  it('forces off for models that rejected the parameter until cleared, and notifies subscribers', () => {
    const storage = memoryStorage();
    const listener = vi.fn();
    const off = subscribeAgentThinking(listener);
    writeAgentThinkingLevel('m1', 'medium', storage);
    markReasoningUnsupported('m1', storage);
    expect(isReasoningUnsupported('m1', storage)).toBe(true);
    expect(effectiveAgentThinkingLevel('m1', storage)).toBe('off');
    expect(readAgentThinkingLevel('m1', storage)).toBe('medium');
    clearReasoningUnsupported('m1', storage);
    expect(effectiveAgentThinkingLevel('m1', storage)).toBe('medium');
    expect(listener).toHaveBeenCalledTimes(3);
    off();
  });

  it('survives corrupt storage', () => {
    const storage = memoryStorage();
    storage.setItem('flovart.agent.thinking', '{not json');
    expect(readAgentThinkingLevel('m', storage)).toBe('off');
    expect(normalizeThinkingLevel('xhigh')).toBe('xhigh');
    expect(normalizeThinkingLevel('max')).toBe('max');
    expect(normalizeThinkingLevel('none')).toBe('off');
    expect(normalizeThinkingLevel(undefined)).toBe('off');
  });
});

describe('reasoning request body', () => {
  it('omits every reasoning field when thinking is off', () => {
    const body = buildBrowserAgentRequestBody({ provider: 'openai', model: 'gpt-5', baseUrl: 'https://api.openai.com/v1' }, { messages: [userMessage] }, 'off');
    expect(body).not.toHaveProperty('reasoning_effort');
    expect(body).not.toHaveProperty('reasoning');
    expect(body).not.toHaveProperty('thinking');
    expect(body).toMatchObject({ model: 'gpt-5', stream: true, temperature: 0.2, max_tokens: 16384 });
  });

  it('sends reasoning_effort for OpenAI-compatible routes, keeping minimal only where it is accepted', () => {
    expect(buildBrowserAgentRequestBody({ provider: 'openai', model: 'gpt-5', baseUrl: '' }, { messages: [userMessage] }, 'minimal')).toMatchObject({ reasoning_effort: 'minimal' });
    expect(buildBrowserAgentRequestBody({ provider: 'deepseek', model: 'r', baseUrl: '' }, { messages: [userMessage] }, 'minimal')).toMatchObject({ reasoning_effort: 'low' });
    expect(buildBrowserAgentRequestBody({ provider: 'openai_compatible', model: 'x', baseUrl: 'https://gw.example/v1' }, { messages: [userMessage] }, 'high')).toMatchObject({ reasoning_effort: 'high', temperature: 0.2 });
  });

  it('maps OpenRouter, Anthropic and Qwen compatible endpoints to their own shapes', () => {
    expect(buildReasoningParams('medium', { provider: 'openrouter' }).params).toEqual({ reasoning: { effort: 'medium' } });
    expect(buildReasoningParams('low', { provider: 'openai_compatible', baseUrl: 'https://openrouter.ai/api/v1' }).params).toEqual({ reasoning: { effort: 'low' } });
    const anthropic = buildReasoningParams('high', { provider: 'openai_compatible', baseUrl: 'https://api.anthropic.com/v1' });
    expect(anthropic).toEqual({ params: { thinking: { type: 'enabled', budget_tokens: 12288 } }, dropTemperature: true });
    expect(buildBrowserAgentRequestBody({ provider: 'openai_compatible', model: 'claude', baseUrl: 'https://api.anthropic.com/v1' }, { messages: [userMessage] }, 'high')).not.toHaveProperty('temperature');
    expect(buildReasoningParams('low', { provider: 'qwen' }).params).toEqual({ enable_thinking: true, thinking_budget: 2048 });
  });

  it('recognises provider rejections of the reasoning parameter only', () => {
    expect(isReasoningRejection(400, '{"error":{"message":"Unsupported parameter: \'reasoning_effort\' is not supported with this model."}}')).toBe(true);
    expect(isReasoningRejection(422, 'extra inputs are not permitted: thinking')).toBe(true);
    expect(isReasoningRejection(400, 'Unsupported value: temperature')).toBe(false);
    expect(isReasoningRejection(500, 'reasoning_effort unsupported')).toBe(false);
  });
});

function sse(chunks: unknown[]): Response {
  const body = chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

async function runStream(model: string, reasoning?: string) {
  const stream = await createBrowserAgentStream({ provider: 'openai_compatible', model, baseUrl: 'https://gw.example/v1', apiKey: 'k' })(
    {} as never,
    { messages: [userMessage], tools: [] } as never,
    { reasoning } as never,
  );
  const events: Array<{ type: string }> = [];
  for await (const event of stream) events.push(event as { type: string });
  return { events, message: await stream.result() };
}

describe('browser agent stream with thinking', () => {
  beforeEach(() => localStorage.removeItem('flovart.agent.thinking'));
  afterEach(() => vi.unstubAllGlobals());

  it('posts reasoning_effort and surfaces reasoning_content as a thinking block', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return sse([
        { choices: [{ delta: { reasoning_content: '先看' } }] },
        { choices: [{ delta: { reasoning_content: '画布' } }] },
        { choices: [{ delta: { content: '好的' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ]);
    }));
    const { events, message } = await runStream('think-1', 'medium');
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ reasoning_effort: 'medium' });
    expect(events.map(event => event.type)).toEqual(['start', 'thinking_start', 'thinking_delta', 'thinking_delta', 'thinking_end', 'text_delta', 'done']);
    expect(message.content).toEqual([{ type: 'thinking', thinking: '先看画布' }, { type: 'text', text: '好的' }]);
  });

  it('also accepts delta.reasoning and sends nothing when thinking is off', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return sse([{ choices: [{ delta: { reasoning: 'hmm' } }] }, { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]);
    }));
    const { message } = await runStream('think-2');
    expect(bodies[0]).not.toHaveProperty('reasoning_effort');
    expect(message.content[0]).toEqual({ type: 'thinking', thinking: 'hmm' });
  });

  it('retries once without the parameter on a reasoning 400 and remembers the model does not support it', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      if ('reasoning_effort' in body) {
        return new Response(JSON.stringify({ error: { message: "Unsupported parameter: 'reasoning_effort'" } }), { status: 400 });
      }
      return sse([{ choices: [{ delta: { content: 'fine' }, finish_reason: 'stop' }] }]);
    }));
    const { message } = await runStream('plain-model', 'high');
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({ reasoning_effort: 'high' });
    expect(bodies[1]).not.toHaveProperty('reasoning_effort');
    expect(message.stopReason).toBe('stop');
    expect(message.content).toEqual([{ type: 'text', text: 'fine' }]);
    expect(isReasoningUnsupported('plain-model')).toBe(true);

    // 记住之后直接不发参数。
    bodies.length = 0;
    await runStream('plain-model', 'high');
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toHaveProperty('reasoning_effort');
  });

  it('does not retry on unrelated 400s', async () => {
    const fetchMock = vi.fn(async () => new Response('bad messages', { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);
    const { message } = await runStream('m-err', 'low');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(message.stopReason).toBe('error');
    expect(isReasoningUnsupported('m-err')).toBe(false);
  });
});

describe('dynamic thinking levels per model', () => {
  beforeEach(() => localStorage.removeItem('flovart.agent.thinking'));
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('clamps the requested level to the nearest supported one, ties going up', () => {
    const storage = memoryStorage();
    const model = { id: 'gw-model', thinkingLevels: ['off', 'low', 'high'] as const, thinkingSource: 'api' as const };
    expect(resolveRequestThinkingLevel({ ...model, thinkingLevels: [...model.thinkingLevels] }, 'medium', storage)).toBe('high');
    expect(resolveRequestThinkingLevel({ ...model, thinkingLevels: [...model.thinkingLevels] }, 'minimal', storage)).toBe('low');
    expect(resolveRequestThinkingLevel({ ...model, thinkingLevels: [...model.thinkingLevels] }, 'max', storage)).toBe('high');
    expect(resolveRequestThinkingLevel({ ...model, thinkingLevels: [...model.thinkingLevels] }, 'off', storage)).toBe('off');
    expect(resolveRequestThinkingLevel({ id: 'v4', thinkingLevels: ['off', 'high', 'max'] }, 'xhigh', storage)).toBe('max');
  });

  it('sends xhigh / max as-is and uses the toggle shape for on/off models', () => {
    expect(buildReasoningParams('xhigh', { provider: 'openai' }).params).toEqual({ reasoning_effort: 'xhigh' });
    expect(buildReasoningParams('max', { provider: 'openrouter' }).params).toEqual({ reasoning: { effort: 'max' } });
    expect(buildReasoningParams('max', { provider: 'anthropic' })).toEqual({ params: { thinking: { type: 'adaptive' }, output_config: { effort: 'max' } }, dropTemperature: true });
    expect(buildReasoningParams('high', { provider: 'openai_compatible', baseUrl: 'https://api.moonshot.cn/v1' }, { mode: 'toggle' }).params).toEqual({ thinking: { type: 'enabled' } });
    expect(buildReasoningParams('high', { provider: 'openrouter' }, { mode: 'toggle' }).params).toEqual({ reasoning: { enabled: true } });
    expect(buildReasoningParams('high', { provider: 'qwen' }, { mode: 'toggle' }).params).toEqual({ enable_thinking: true });
    const body = buildBrowserAgentRequestBody(
      { provider: 'openai_compatible', model: 'deepseek-v4-pro', baseUrl: 'https://api.deepseek.com', modelInfo: { id: 'deepseek-v4-pro', thinkingLevels: ['off', 'high', 'max'], thinkingSource: 'api' } },
      { messages: [userMessage] },
      'max',
    );
    expect(body).toMatchObject({ reasoning_effort: 'max' });
  });

  it('parses "Supported values are ..." and remembers them for one hour', () => {
    const storage = memoryStorage();
    const body = '{"error":{"message":"Unsupported value: \'reasoning_effort\' does not support \'minimal\' with this model. Supported values are: \'low\', \'medium\', and \'high\'."}}';
    expect(parseSupportedThinkingValues(body)).toEqual(['low', 'medium', 'high']);
    expect(parseSupportedThinkingValues('Invalid reasoning effort. Supported values are none, low, high, xhigh')).toEqual(['off', 'low', 'high', 'xhigh']);
    expect(parseSupportedThinkingValues('bad request')).toBeNull();

    const now = Date.now();
    expect(thinkingLevelAfterRejection('gw-x', 'minimal', 400, body, storage)).toBe('low');
    expect(availableThinkingLevels('gw-x', storage, now + 1000)).toMatchObject({ levels: ['low', 'medium', 'high'], source: 'learned' });
    expect(availableThinkingLevels('gw-x', storage, now + LEARNED_LEVELS_TTL_MS + 5000).source).not.toBe('learned');
    // 当前档已在支持列表里：不再重试。
    expect(thinkingLevelAfterRejection('gw-x', 'low', 400, body, storage)).toBeNull();
  });

  it('retries the stream with the nearest supported level and keeps it for the next turn', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      if (body.reasoning_effort === 'max') {
        return new Response(JSON.stringify({ error: { message: "Invalid value for 'reasoning_effort': Supported values are 'low', 'medium', 'high' and 'xhigh'." } }), { status: 400 });
      }
      return sse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]);
    }));
    const { message } = await runStream('gpt-5.6-sol', 'max');
    expect(bodies.map(body => body.reasoning_effort)).toEqual(['max', 'xhigh']);
    expect(message.stopReason).toBe('stop');
    expect(isReasoningUnsupported('gpt-5.6-sol')).toBe(false);

    bodies.length = 0;
    await runStream('gpt-5.6-sol', 'max');
    expect(bodies.map(body => body.reasoning_effort)).toEqual(['xhigh']);
  });
});
