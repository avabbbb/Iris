// /compact [聚焦说明]、按模型窗口算阈值、回合中途压缩、从「maximum context length」报错学习窗口并下调 max_tokens。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import localforage from 'localforage';
import { Type } from 'typebox';
import {
  buildCompactionInstructions,
  COMPACTION_INSTRUCTIONS,
  compactionThresholdTokens,
  parseCompactCommand,
} from '../services/agentCompaction';
import {
  DEFAULT_CONTEXT_WINDOW,
  learnedModelLimits,
  modelContextWindow,
  parseContextLimitFromError,
  rememberModelLimits,
  resetLearnedModelLimits,
  resolveContextWindow,
  resolveMaxOutputTokens,
} from '../services/agentContextLimits';
import { BrowserAgentKernel, resolveBrowserAgentTextRoute, routeContextWindow } from '../services/browserAgentKernel';
import { agentSlashCommands, insertSlashCommand, matchSlashCommands } from '../components/agent/agentSlashCommands';
import { compactionK, compactionTokensLine } from '../components/agent/AgentCompactionCard';
import type { AgentSkillCatalog } from '../services/agentSkills';
import type { UserApiKey } from '../types';

describe('/compact command parsing', () => {
  it('accepts /compact with an optional focus and rejects look-alikes', () => {
    expect(parseCompactCommand('/compact')).toEqual({ focus: '' });
    expect(parseCompactCommand('  /compact   保留接口设计的讨论 ')).toEqual({ focus: '保留接口设计的讨论' });
    expect(parseCompactCommand('/COMPACT keep the API notes\nand the todo list')).toEqual({ focus: 'keep the API notes\nand the todo list' });
    expect(parseCompactCommand('/compactx')).toBeNull();
    expect(parseCompactCommand('请 /compact')).toBeNull();
    expect(parseCompactCommand('compact')).toBeNull();
  });

  it('appends the focus to the summary instructions', () => {
    expect(buildCompactionInstructions()).toBe(COMPACTION_INSTRUCTIONS);
    expect(buildCompactionInstructions('   ')).toBe(COMPACTION_INSTRUCTIONS);
    const focused = buildCompactionInstructions('保留接口设计的讨论\n和  待办');
    expect(focused.startsWith(COMPACTION_INSTRUCTIONS)).toBe(true);
    expect(focused).toContain('保留接口设计的讨论 和 待办');
  });
});

describe('slash command menu', () => {
  it('lists /compact only for the built-in agent and filters by prefix', () => {
    expect(agentSlashCommands('zho', { builtin: false })).toEqual([]);
    const commands = agentSlashCommands('zho', { builtin: true });
    expect(commands.map(command => command.name)).toEqual(['compact']);
    expect(commands[0].args).toBe('[聚焦说明]');
    expect(agentSlashCommands('en', { builtin: true })[0].args).toBe('[focus]');
    expect(matchSlashCommands(commands, '')).toHaveLength(1);
    expect(matchSlashCommands(commands, 'comp')).toHaveLength(1);
    expect(matchSlashCommands(commands, 'skill')).toHaveLength(0);
    expect(matchSlashCommands(commands, undefined)).toHaveLength(0);
  });

  it('writes the chosen command back into the composer', () => {
    expect(insertSlashCommand('/co', { name: 'compact' })).toBe('/compact ');
    expect(insertSlashCommand('/', { name: 'compact' })).toBe('/compact ');
    expect(insertSlashCommand('', { name: 'compact' })).toBe('/compact ');
  });

  it('formats the compaction card token line', () => {
    expect(compactionK(0)).toBe(0);
    expect(compactionK(300)).toBe(1);
    expect(compactionTokensLine({ tokensBefore: 120_400, tokensAfter: 18_200 }, 'zho')).toBe('约 120K → 18K tokens');
    expect(compactionTokensLine({ tokensBefore: 120_400 }, 'en')).toBe('About 120K tokens summarized');
  });
});

describe('context window and max_tokens', () => {
  beforeEach(() => resetLearnedModelLimits());

  it('reads the optional contextWindow from the model object, defaulting to 128K', () => {
    expect(modelContextWindow({ id: 'm', contextWindow: 200_000 })).toBe(200_000);
    expect(modelContextWindow({ id: 'm' })).toBeUndefined();
    expect(modelContextWindow(null)).toBeUndefined();
    expect(resolveContextWindow()).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(resolveContextWindow({ declared: 200_000 })).toBe(200_000);
    expect(resolveContextWindow({ declared: 200_000, learned: 64_000 })).toBe(64_000);
    // 阈值约窗口的 80%
    expect(compactionThresholdTokens(resolveContextWindow({ declared: 200_000 }))).toBe(160_000);
    expect(compactionThresholdTokens(resolveContextWindow())).toBe(102_400);
  });

  it('puts the model item contextWindow on the resolved route', () => {
    const key = {
      id: 'k1', provider: 'openai_compatible', key: 'sk', baseUrl: 'https://gw.example/v1', capabilities: ['text'], status: 'ok',
      defaultModel: 'big', models: [{ id: 'big', name: 'Big', capability: 'text', contextWindow: 256_000 }],
      createdAt: 0, updatedAt: 0,
    } as unknown as UserApiKey;
    const route = resolveBrowserAgentTextRoute([key])!;
    expect(route.contextWindow).toBe(256_000);
    expect(routeContextWindow(route)).toBe(256_000);
    const plain = resolveBrowserAgentTextRoute([{ ...key, models: [{ id: 'big', name: 'Big', capability: 'text' }] } as unknown as UserApiKey])!;
    expect(plain.contextWindow).toBeUndefined();
    expect(routeContextWindow(plain)).toBe(128_000);
  });

  it.each([
    ["This model's maximum context length is 32768 tokens. However, you requested 40000 tokens (20000 in the messages, 20000 in the completion).", { contextWindow: 32_768, inputTokens: 20_000 }],
    ['prompt is too long: 210000 tokens > 200000 maximum', { contextWindow: 200_000, inputTokens: 210_000 }],
    ['Range of input length should be [1, 129024]', { contextWindow: 129_024 }],
    ['max_tokens is too large: 16384. This model supports at most 8192 completion tokens, whereas you provided 16384.', { maxOutputTokens: 8_192 }],
    ['the request exceeds the available context size, try increasing it (n_ctx: 8192)', { contextWindow: 8_192 }],
  ])('parses limits from %s', (text, expected) => {
    expect(parseContextLimitFromError(text)).toMatchObject(expected);
  });

  it('ignores errors without numbers', () => {
    expect(parseContextLimitFromError('context_length_exceeded')).toBeNull();
    expect(parseContextLimitFromError('HTTP 400 bad request')).toBeNull();
  });

  it('lowers max_tokens from the learned window and remembers it per model', () => {
    expect(resolveMaxOutputTokens()).toBe(16_384);
    expect(resolveMaxOutputTokens({ contextWindow: 128_000 })).toBe(16_384);
    expect(resolveMaxOutputTokens({ contextWindow: 32_768 })).toBe(8_192);
    expect(resolveMaxOutputTokens({ contextWindow: 32_768, inputTokens: 28_000 })).toBe(4_512);
    expect(resolveMaxOutputTokens({ learnedMaxOutput: 4_096 })).toBe(4_096);
    expect(resolveMaxOutputTokens({ contextWindow: 2_000 })).toBe(1_024);
    const route = { baseUrl: 'https://gw.example/v1/', model: 'm' };
    rememberModelLimits(route, { contextWindow: 64_000 });
    rememberModelLimits(route, { contextWindow: 100_000 });
    expect(learnedModelLimits({ baseUrl: 'https://gw.example/v1', model: 'm' })?.contextWindow).toBe(64_000);
    expect(learnedModelLimits({ baseUrl: 'https://gw.example/v1', model: 'other' })).toBeNull();
    expect(learnedModelLimits(route, Date.now() + 31 * 24 * 3_600_000)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 内核：/compact、回合中途压缩、溢出学习
// ---------------------------------------------------------------------------

const PROJECT = 'project-compact-cmd';
const route = { provider: 'openai_compatible', model: 'm', baseUrl: 'https://gw.example/v1', apiKey: 'k' };
type Body = { messages: Array<{ role: string; content: unknown }>; max_tokens?: number };

function sse(chunks: unknown[]): Response {
  const body = chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}
const reply = (text: string) => sse([{ choices: [{ delta: { content: text } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]);
const toolCall = (name: string, args: Record<string, unknown>) => sse([
  { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-' + Math.random().toString(36).slice(2), function: { name, arguments: JSON.stringify(args) } }] } }] },
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
]);
const isSummaryRequest = (body: Body) => JSON.stringify(body.messages[0]?.content ?? '').includes('context summarization assistant');
const catalog: AgentSkillCatalog = { list: () => [], read: async () => null };
type Snapshot = Awaited<ReturnType<BrowserAgentKernel['snapshot']>>;

describe('browser agent kernel: compaction', () => {
  let kernel: BrowserAgentKernel | undefined;
  beforeEach(async () => { resetLearnedModelLimits(); await localforage.removeItem(`flovart.agent.sessions.${PROJECT}`); });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await kernel?.close();
    kernel = undefined;
    await localforage.removeItem(`flovart.agent.sessions.${PROJECT}`);
    resetLearnedModelLimits();
  });

  const make = (options: Partial<ConstructorParameters<typeof BrowserAgentKernel>[0]> = {}) => new BrowserAgentKernel({
    projectId: PROJECT, route, tools: [], confirm: async () => true, systemPrompt: 'SYS', getThinkingLevel: () => 'off',
    skillCatalog: catalog, memory: null, ...options,
  });

  it('/compact focus reaches the summary prompt, recent turns stay verbatim, snapshot carries the card data', async () => {
    const summaryPrompts: string[] = [];
    const turnBodies: Body[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Body;
      if (isSummaryRequest(body)) { summaryPrompts.push(JSON.stringify(body.messages)); return reply('## 摘要\n接口设计：REST + 分页。'); }
      turnBodies.push(body);
      return reply('收到');
    }));
    kernel = make();
    await kernel.openSession();
    await kernel.send('第一轮：讨论接口设计 ' + 'a'.repeat(16_000));
    await kernel.send('第二轮：画布配色 ' + 'b'.repeat(6_000));
    await kernel.send('第三轮：最新的分镜要求 ' + 'c'.repeat(2_000));
    const events: Array<Record<string, unknown>> = [];
    kernel.subscribe(event => { if (event.type.startsWith('compaction')) events.push(event); });

    const result = await kernel.compactContext('保留接口设计的讨论');
    expect(result.compacted).toBe(true);
    expect(result.tokensBefore).toBeGreaterThan(result.tokensAfter!);
    expect(summaryPrompts.length).toBeGreaterThanOrEqual(1);
    expect(summaryPrompts.join('\n')).toContain('Additional focus');
    expect(summaryPrompts.join('\n')).toContain('保留接口设计的讨论');
    expect(events.map(event => `${event.type}:${event.reason}`)).toEqual(['compaction_start:manual', 'compaction_end:manual']);
    expect(events[1]).toMatchObject({ compacted: true, focus: '保留接口设计的讨论' });

    const snapshot = await kernel.snapshot();
    const card = snapshot.messages.find(message => message.compaction);
    expect(card?.role).toBe('system');
    expect(card?.compaction).toMatchObject({ focus: '保留接口设计的讨论', reason: 'manual' });
    expect(card!.compaction!.tokensBefore).toBeGreaterThan(card!.compaction!.tokensAfter!);
    expect(card?.text).toContain('已压缩上下文');

    await kernel.send('继续');
    const next = JSON.stringify(turnBodies.at(-1)!.messages);
    expect(next).toContain('## 摘要');
    expect(next).not.toContain('a'.repeat(16_000)); // 早期轮次进了摘要
    expect(next).toContain('c'.repeat(2_000)); // 最近几轮原文保留
    expect(next).toContain('b'.repeat(6_000));
  });

  it('manual compaction refuses while a turn is running', async () => {
    let release: () => void = () => undefined;
    vi.stubGlobal('fetch', vi.fn(async () => {
      await new Promise<void>(resolve => { release = resolve; });
      return reply('ok');
    }));
    kernel = make();
    await kernel.openSession();
    const pending = kernel.send('慢');
    await vi.waitFor(() => expect(kernel!.running).toBe(true));
    await expect(kernel.compactContext()).rejects.toThrow('正在运行');
    release();
    await pending;
  });

  it('auto-compaction threshold follows the route contextWindow (80%)', async () => {
    kernel = make({ route: { ...route, contextWindow: 200_000 } });
    expect(kernel.contextWindow).toBe(200_000);
    expect(kernel.compactionThreshold).toBe(160_000);
    const fallback = make();
    expect(fallback.contextWindow).toBe(128_000);
    expect(fallback.compactionThreshold).toBe(102_400);
    await fallback.close();
  });

  it('compacts mid-turn between tool steps when the estimate passes the threshold, then continues', async () => {
    const kinds: string[] = [];
    const turnBodies: Body[] = [];
    let step = 0;
    const big = {
      name: 'big_read',
      label: 'big_read',
      description: 'Returns a large blob',
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: 'text', text: 'x'.repeat(36_000) }], details: {} }),
    };
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Body;
      if (isSummaryRequest(body)) { kinds.push('summary'); return reply('## 摘要\n前情：长文 a'); }
      kinds.push('turn');
      turnBodies.push(body);
      step += 1;
      if (step === 1) return reply('ok');
      if (step === 2) return toolCall('big_read', {});
      return reply('读完了');
    }));
    kernel = make({ tools: [big as never], contextWindow: 30_000, compaction: { keepRecentTokens: 1_000 } });
    await kernel.openSession();
    await kernel.send('一 ' + 'a'.repeat(20_000));
    const events: string[] = [];
    kernel.subscribe(event => { if (event.type.startsWith('compaction')) events.push(`${event.type}:${String(event.reason)}`); });
    const snapshot = await kernel.send('读一下大文件') as Snapshot;
    expect(kinds[0]).toBe('turn');
    expect(kinds[1]).toBe('turn'); // 第二轮第一步：工具调用
    expect(kinds.at(-1)).toBe('turn'); // 压缩后继续同一轮
    expect(kinds.slice(2, -1).every(kind => kind === 'summary')).toBe(true);
    expect(kinds.slice(2, -1).length).toBeGreaterThanOrEqual(1);
    expect(events).toEqual(['compaction_start:midturn', 'compaction_end:midturn']);
    const last = JSON.stringify(turnBodies.at(-1)!.messages);
    expect(last).toContain('## 摘要');
    expect(last).not.toContain('a'.repeat(20_000));
    expect(last).toContain('x'.repeat(36_000)); // 当前这一步的工具结果原样保留
    expect(snapshot.messages.at(-1)).toMatchObject({ role: 'assistant', text: '读完了' });
    expect(snapshot.messages.some(message => message.compaction?.reason === 'midturn')).toBe(true);
  });

  it('learns the real window from "maximum context length" errors, lowers max_tokens and retries once', async () => {
    const bodies: Body[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Body;
      bodies.push(body);
      if (bodies.length === 1) {
        return new Response(JSON.stringify({ error: { message: "This model's maximum context length is 32768 tokens. However, you requested 36384 tokens (20000 in the messages, 16384 in the completion). Please reduce the length of the messages or completion." } }), { status: 400 });
      }
      return reply('好');
    }));
    kernel = make();
    await kernel.openSession();
    expect(kernel.contextWindow).toBe(128_000);
    const snapshot = await kernel.send('你好') as Snapshot;
    expect(bodies).toHaveLength(2);
    expect(bodies[0].max_tokens).toBe(16_384);
    expect(bodies[1].max_tokens).toBe(8_192);
    expect(snapshot.messages.at(-1)).toMatchObject({ role: 'assistant', text: '好' });
    expect(kernel.contextWindow).toBe(32_768);
    expect(kernel.compactionThreshold).toBe(32_768 - 16_384);
    // 记住之后：下一轮直接用下调后的 max_tokens，不再先撞一次。
    await kernel.send('再来');
    expect(bodies).toHaveLength(3);
    expect(bodies[2].max_tokens).toBe(8_192);
  });

  it('does not retry the request when the input alone exceeds the learned window (compaction handles it)', async () => {
    const kinds: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Body;
      if (isSummaryRequest(body)) { kinds.push('summary'); return reply('## 摘要'); }
      kinds.push('turn');
      return new Response(JSON.stringify({ error: { message: "This model's maximum context length is 8192 tokens. However, you requested 30000 tokens (13616 in the messages, 16384 in the completion)." } }), { status: 400 });
    }));
    kernel = make();
    await kernel.openSession();
    await kernel.send('一条');
    expect(kinds).toEqual(['turn']); // 只有一条消息，没有可压缩的历史；输入本身超窗，不做无用的 max_tokens 重试
    expect(kernel.contextWindow).toBe(8_192);
  });
});
