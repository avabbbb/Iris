import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { buildBrowserAgentRequestBody, createBrowserAgentStream, toOpenAIMessages } from '../services/browserAgentKernel';
import {
  classifyDeepSeekExtensionRejection,
  DEEPSEEK_EXT_COMPAT_KEY,
  DEEPSEEK_EXT_COMPAT_TTL_MS,
  DEEPSEEK_REFUSAL_MESSAGE,
  DeepSeekSessionTitler,
  DEFAULT_DEEPSEEK_EXTENSION_SETTINGS,
  getDeepSeekExtensionCompat,
  isDeepSeekOfficialRoute,
  loadDeepSeekExtensionSettings,
  markDeepSeekExtensionCompat,
  planDeepSeekExtensions,
  saveDeepSeekExtensionSettings,
  SESSION_TITLE_ENTRY,
  sessionTitleFromEntries,
  type DeepSeekExtensionSettings,
} from '../services/deepseekExtensions';

const route = { provider: 'deepseek', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-test' };
const gateway = { provider: 'openai_compatible', model: 'deepseek-flash', baseUrl: 'https://gw.example/v1', apiKey: 'k' };
const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }], timestamp: 0 } as unknown as AgentMessage);
const fnTool = (name: string) => ({ name, description: name, parameters: { type: 'object', properties: {} } });
const tools = [fnTool('flovart_web_search'), fnTool('workflow_inspect')];
const ALL_ON: DeepSeekExtensionSettings = { title: true, webSearch: true, safetyCheck: true };

const CONFLICT = '{"error":{"message":"tools: other tools cannot be used together with `deepseek_web_search`, `deepseek_read_url`, `safety_check` or `title` yet","type":"invalid_request_error"}}';

function sse(chunks: unknown[]): Response {
  const body = chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

const SERVER_TOOL_CALLS = [{
  index: 0,
  reasoning_content: '',
  calls: [{
    index: 0,
    id: 'srvtoolu_s_00_abc',
    type: 'deepseek_web_search',
    kind: 'search',
    action: { type: 'search', queries: ['DeepSeek V4.1'] },
    status: 'completed',
    sources: [{ type: 'url', url: 'https://example.com/news', title: 'News' }],
  }],
}];

async function runStream(fetchMock: ReturnType<typeof vi.fn>, options: { hooks?: Parameters<typeof createBrowserAgentStream>[1]; messages?: AgentMessage[]; withTools?: boolean } = {}) {
  vi.stubGlobal('fetch', fetchMock);
  const stream = await createBrowserAgentStream({ ...route, timeouts: { retryBaseMs: 1 } }, options.hooks)(
    {} as never,
    { systemPrompt: 'SYS', messages: options.messages ?? [user('明天北京会下雨吗？')], tools: options.withTools === false ? [] : tools } as never,
    {} as never,
  );
  for await (const _event of stream) { /* drain */ }
  return stream.result();
}

const sentBody = (fetchMock: ReturnType<typeof vi.fn>, call = 0) => JSON.parse(String((fetchMock.mock.calls[call][1] as RequestInit).body)) as Record<string, unknown>;

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe('deepseek extension settings', () => {
  it('defaults to title on, web search and safety check off, and persists changes', () => {
    expect(loadDeepSeekExtensionSettings()).toEqual(DEFAULT_DEEPSEEK_EXTENSION_SETTINGS);
    expect(DEFAULT_DEEPSEEK_EXTENSION_SETTINGS).toEqual({ title: true, webSearch: false, safetyCheck: false });
    saveDeepSeekExtensionSettings({ safetyCheck: true });
    expect(loadDeepSeekExtensionSettings()).toEqual({ title: true, webSearch: false, safetyCheck: true });
  });

  it('only treats api.deepseek.com as the DeepSeek route', () => {
    expect(isDeepSeekOfficialRoute(route)).toBe(true);
    expect(isDeepSeekOfficialRoute({ baseUrl: 'https://api.deepseek.com/v1' })).toBe(true);
    expect(isDeepSeekOfficialRoute(gateway)).toBe(false);
    expect(isDeepSeekOfficialRoute({ baseUrl: 'https://api.deepseek.com.evil.example' })).toBe(false);
    expect(planDeepSeekExtensions(gateway, ALL_ON, { hasFunctionTools: true, wantTitle: true })).toMatchObject({ title: false, webSearch: false, safetyCheck: false });
  });
});

describe('deepseek extension request fields', () => {
  it('puts title / safety_check at the top level and swaps flovart_web_search for deepseek_web_search', () => {
    const plan = planDeepSeekExtensions(route, ALL_ON, { hasFunctionTools: true, wantTitle: true });
    const body = buildBrowserAgentRequestBody(route, { systemPrompt: 'SYS', messages: [user('hi')], tools }, 'off', { deepseek: plan });
    expect(body.title).toEqual({ enabled: true });
    expect(body.safety_check).toEqual({ level: 'high' });
    const declared = body.tools as Array<Record<string, any>>;
    expect(declared).toContainEqual({ type: 'deepseek_web_search' });
    expect(declared.some(tool => tool.function?.name === 'flovart_web_search')).toBe(false);
    expect(declared.some(tool => tool.function?.name === 'workflow_inspect')).toBe(true);
  });

  it('keeps flovart_web_search and sends no extension fields when the switches are off', () => {
    const plan = planDeepSeekExtensions(route, { title: false, webSearch: false, safetyCheck: false }, { hasFunctionTools: true, wantTitle: true });
    const body = buildBrowserAgentRequestBody(route, { messages: [user('hi')], tools }, 'off', { deepseek: plan });
    expect(body).not.toHaveProperty('title');
    expect(body).not.toHaveProperty('safety_check');
    expect((body.tools as Array<Record<string, any>>).map(tool => tool.function?.name)).toContain('flovart_web_search');
  });

  it('only asks for a title while the session has none', () => {
    expect(planDeepSeekExtensions(route, ALL_ON, { hasFunctionTools: false, wantTitle: false }).title).toBe(false);
  });
});

describe('deepseek stream extension output', () => {
  it('sends title on the request, reads delta.title from the last chunk and keeps server_tool_calls for the next round', async () => {
    saveDeepSeekExtensionSettings({ webSearch: true });
    const onTitle = vi.fn();
    const fetchMock = vi.fn(async () => sse([
      { choices: [{ delta: { content: '北京明天' } }] },
      { choices: [{ delta: { content: '多云。', title: '北京明日天气', server_tool_calls: SERVER_TOOL_CALLS, annotations: [{ type: 'url_citation', url_citation: { url: 'https://example.com/news' } }] }, finish_reason: 'stop' }] },
    ]));
    const message = await runStream(fetchMock, { hooks: { wantTitle: () => true, onTitle } });
    const body = sentBody(fetchMock);
    expect(body.title).toEqual({ enabled: true });
    expect(body.tools).toContainEqual({ type: 'deepseek_web_search' });
    expect(onTitle).toHaveBeenCalledWith('北京明日天气');
    expect((message as any).deepseek.serverToolCalls).toEqual(SERVER_TOOL_CALLS);

    // 下一轮：assistant 原样带回 server_tool_calls（只对官方线路）
    const next = toOpenAIMessages([user('明天北京会下雨吗？'), message as AgentMessage, user('那后天呢？')], { serverToolCalls: true });
    expect(next[1]).toMatchObject({ role: 'assistant', server_tool_calls: SERVER_TOOL_CALLS });
    const viaGateway = buildBrowserAgentRequestBody(gateway, { messages: [user('a'), message as AgentMessage, user('b')] });
    expect((viaGateway.messages as Array<Record<string, unknown>>)[1]).not.toHaveProperty('server_tool_calls');
  });

  it('degrades on the coexistence 400: retries once without extensions and remembers it for provider+model', async () => {
    saveDeepSeekExtensionSettings({ webSearch: true, safetyCheck: true });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(CONFLICT, { status: 400 }))
      .mockResolvedValueOnce(sse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]));
    const message = await runStream(fetchMock, { hooks: { wantTitle: () => true } });
    expect(message.stopReason).toBe('stop');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = sentBody(fetchMock, 0);
    const retry = sentBody(fetchMock, 1);
    expect(first.title).toEqual({ enabled: true });
    expect(retry).not.toHaveProperty('title');
    expect(retry).not.toHaveProperty('safety_check');
    // 联网降级回 flovart_web_search
    expect((retry.tools as Array<Record<string, any>>).some(tool => tool.function?.name === 'flovart_web_search')).toBe(true);
    expect((retry.tools as Array<Record<string, any>>).some(tool => tool.type === 'deepseek_web_search')).toBe(false);
    expect(getDeepSeekExtensionCompat(route)?.mode).toBe('exclusive');
    expect(JSON.parse(localStorage.getItem(DEEPSEEK_EXT_COMPAT_KEY) || '{}')).toHaveProperty(['deepseek\u0000deepseek-flash']);

    // 记住之后：带 function 工具的请求直接不带扩展，只发一次
    const second = vi.fn(async () => sse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]));
    await runStream(second, { hooks: { wantTitle: () => true } });
    expect(second).toHaveBeenCalledTimes(1);
    expect(sentBody(second)).not.toHaveProperty('title');
    // 没有 function 工具的请求仍可带扩展
    const plain = planDeepSeekExtensions(route, ALL_ON, { hasFunctionTools: false, wantTitle: true });
    expect(plain).toMatchObject({ title: true, safetyCheck: true, webSearch: true });
  });

  it('forgets the coexistence verdict after 24h', () => {
    const now = 1_000_000;
    markDeepSeekExtensionCompat(route, 'exclusive', CONFLICT, { now });
    expect(getDeepSeekExtensionCompat(route, now + DEEPSEEK_EXT_COMPAT_TTL_MS - 1)?.mode).toBe('exclusive');
    expect(getDeepSeekExtensionCompat(route, now + DEEPSEEK_EXT_COMPAT_TTL_MS)).toBeNull();
    expect(getDeepSeekExtensionCompat({ provider: 'deepseek', model: 'other' }, now)).toBeNull();
  });

  it('classifies extension rejections without catching unrelated 400s', () => {
    expect(classifyDeepSeekExtensionRejection(400, CONFLICT)).toBe('exclusive');
    expect(classifyDeepSeekExtensionRejection(400, '{"error":{"message":"Unrecognized request argument supplied: safety_check"}}')).toBe('unsupported');
    expect(classifyDeepSeekExtensionRejection(400, '{"error":{"message":"This model\'s maximum context length is 131072 tokens"}}')).toBeNull();
    expect(classifyDeepSeekExtensionRejection(400, 'Content Exists Risk')).toBeNull();
    expect(classifyDeepSeekExtensionRejection(500, CONFLICT)).toBeNull();
  });

  it('replaces a content_filter reply with the refusal copy and keeps it out of the next round', async () => {
    saveDeepSeekExtensionSettings({ safetyCheck: true });
    const fetchMock = vi.fn(async () => sse([
      { choices: [{ delta: { reasoning_content: '想一想' } }] },
      { choices: [{ delta: { content: '已经流出的半句' } }] },
      { choices: [{ delta: { content: '' }, finish_reason: 'content_filter' }] },
    ]));
    const question = user('不该回答的问题');
    const message = await runStream(fetchMock, { withTools: false, messages: [question] });
    expect(sentBody(fetchMock).safety_check).toEqual({ level: 'high' });
    expect(message.content).toEqual([{ type: 'text', text: DEEPSEEK_REFUSAL_MESSAGE }]);
    expect((message as any).deepseek.refusal).toBe(true);

    const next = toOpenAIMessages([user('第一问'), { role: 'assistant', content: [{ type: 'text', text: '第一答' }], stopReason: 'stop', timestamp: 1 } as never, question, message as AgentMessage, user('换个话题')]);
    expect(next.map(item => item.role)).toEqual(['user', 'assistant', 'user']);
    expect(JSON.stringify(next)).not.toContain('不该回答的问题');
    expect(JSON.stringify(next)).not.toContain(DEEPSEEK_REFUSAL_MESSAGE);
  });

  it('treats delta.refusal on the last chunk as a refusal too', async () => {
    const fetchMock = vi.fn(async () => sse([
      { choices: [{ delta: { content: '', refusal: 'The following images were blocked by content moderation: messages.1.content.0' }, finish_reason: 'stop' }] },
    ]));
    const message = await runStream(fetchMock, { withTools: false });
    expect(message.content).toEqual([{ type: 'text', text: DEEPSEEK_REFUSAL_MESSAGE }]);
  });

  it('shows 400 Content Exists Risk as a refusal instead of an error', async () => {
    const fetchMock = vi.fn(async () => new Response('{"error":{"message":"Content Exists Risk","type":"invalid_request_error"}}', { status: 400 }));
    const message = await runStream(fetchMock, { withTools: false });
    expect(message.stopReason).toBe('stop');
    expect(message.content).toEqual([{ type: 'text', text: DEEPSEEK_REFUSAL_MESSAGE }]);
  });

  it('does not add extension fields on other routes', async () => {
    saveDeepSeekExtensionSettings({ webSearch: true, safetyCheck: true });
    const fetchMock = vi.fn(async () => sse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]));
    vi.stubGlobal('fetch', fetchMock);
    const stream = await createBrowserAgentStream({ ...gateway, timeouts: { retryBaseMs: 1 } }, { wantTitle: () => true })({} as never, { messages: [user('hi')], tools } as never, {} as never);
    for await (const _event of stream) { /* drain */ }
    const body = sentBody(fetchMock);
    expect(body).not.toHaveProperty('title');
    expect(body).not.toHaveProperty('safety_check');
    expect(JSON.stringify(body.tools)).not.toContain('deepseek_web_search');
  });
});

describe('deepseek session title', () => {
  const settings = () => ({ ...DEFAULT_DEEPSEEK_EXTENSION_SETTINGS });
  const turn = [user('帮我做一组赛博朋克海报'), { role: 'assistant', content: [{ type: 'text', text: '好的，已经创建 4 个节点。' }], stopReason: 'stop', timestamp: 1 }];

  it('stops asking once a title arrived inline', async () => {
    const save = vi.fn();
    const fetchMock = vi.fn();
    const titler = new DeepSeekSessionTitler({ route, save, settings, fetchImpl: fetchMock as never });
    titler.reset([]);
    const hooks = titler.hooks();
    expect(hooks.wantTitle!()).toBe(true);
    hooks.onTitle!('赛博朋克海报');
    await Promise.resolve();
    expect(save).toHaveBeenCalledWith({ title: '赛博朋克海报', source: 'deepseek' });
    expect(hooks.wantTitle!()).toBe(false);
    await titler.afterTurn(turn);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to one tool-free title request after the tool loop when the inline title was suppressed', async () => {
    markDeepSeekExtensionCompat(route, 'exclusive', CONFLICT);
    const save = vi.fn();
    const fetchMock = vi.fn(async () => new Response('\n\n' + JSON.stringify({ choices: [{ message: { role: 'assistant', content: '赛博朋克海报', title: '赛博朋克海报组' }, finish_reason: 'stop' }] }), { status: 200 }));
    const titler = new DeepSeekSessionTitler({ route, save, settings, fetchImpl: fetchMock as never });
    titler.reset([]);
    await titler.afterTurn(turn);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body).not.toHaveProperty('tools');
    expect(body.stream).toBe(false);
    expect(body.title).toEqual({ enabled: true });
    expect(save).toHaveBeenCalledWith({ title: '赛博朋克海报组', source: 'fallback' });
    // 只补发一次
    await titler.afterTurn(turn);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the first-message title when the fallback request fails', async () => {
    const save = vi.fn();
    const fetchMock = vi.fn(async () => new Response('busy', { status: 503 }));
    const titler = new DeepSeekSessionTitler({ route, save, settings, fetchImpl: fetchMock as never });
    titler.reset([]);
    await titler.afterTurn(turn);
    expect(save).not.toHaveBeenCalled();
  });

  it('does nothing when the title switch is off or the route is not DeepSeek', async () => {
    const fetchMock = vi.fn();
    const off = new DeepSeekSessionTitler({ route, save: vi.fn(), settings: () => ({ ...DEFAULT_DEEPSEEK_EXTENSION_SETTINGS, title: false }), fetchImpl: fetchMock as never });
    off.reset([]);
    expect(off.hooks().wantTitle!()).toBe(false);
    await off.afterTurn(turn);
    const other = new DeepSeekSessionTitler({ route: gateway, save: vi.fn(), settings, fetchImpl: fetchMock as never });
    other.reset([]);
    await other.afterTurn(turn);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('restores a saved title from session entries', () => {
    const entries = [{ type: 'message' }, { type: 'custom', customType: SESSION_TITLE_ENTRY, data: { title: '旧标题', source: 'deepseek' } }];
    expect(sessionTitleFromEntries(entries)).toBe('旧标题');
    const titler = new DeepSeekSessionTitler({ route, save: vi.fn(), settings });
    titler.reset(entries);
    expect(titler.hooks().wantTitle!()).toBe(false);
  });
});

describe('deepseek title through the browser kernel', () => {
  it('stores delta.title as the session title shown in the history list', async () => {
    const localforage = (await import('localforage')).default;
    const { BrowserAgentKernel } = await import('../services/browserAgentKernel');
    await localforage.removeItem('flovart.agent.sessions.project-dstitle');
    const fetchMock = vi.fn(async () => sse([
      { choices: [{ delta: { content: '好的。' } }] },
      { choices: [{ delta: { title: '赛博朋克海报' }, finish_reason: 'stop' }] },
    ]));
    vi.stubGlobal('fetch', fetchMock);
    const kernel = new BrowserAgentKernel({ projectId: 'project-dstitle', route, tools: [], confirm: async () => true, memory: null });
    const events: Array<{ type: string; title?: unknown }> = [];
    kernel.subscribe(event => { events.push(event as never); });
    await kernel.openSession();
    await kernel.send('帮我做一组赛博朋克风格的海报，四张');
    await kernel.titleSettled();
    await vi.waitFor(async () => expect((await kernel.listSessions())[0].title).toBe('赛博朋克海报'));
    expect(events.some(event => event.type === 'session_title' && event.title === '赛博朋克海报')).toBe(true);
    const body = sentBody(fetchMock);
    expect(body.title).toEqual({ enabled: true });
    // 已有标题：不补发标题请求
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await kernel.close();
    await localforage.removeItem('flovart.agent.sessions.project-dstitle');
  });
});
