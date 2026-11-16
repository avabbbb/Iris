// DeepSeek 官方线路（api.deepseek.com）的服务端扩展：会话标题 title、联网搜索 deepseek_web_search、
// 安全审核 safety_check。字段名与位置按官方文档（Chat Completions）：
//   - https://api-docs.deepseek.com/guides/build_a_chatbot      （被忽略的参数、合规要求）
//   - https://api-docs.deepseek.com/guides/web_tools            （tools 声明、server_tool_calls 回传、错误表）
//   - https://api-docs.deepseek.com/guides/conversation_title   （title 只在首个请求开、delta.title）
//   - https://api-docs.deepseek.com/guides/safety               （content_filter / delta.refusal、400 Content Exists Risk）
//
// 拒答轮次不回传的规则参照 DeepSeek chat-demo 的 services/chat/reply.ts（isUsableReply / settleReply）重写：
//   chat-demo — MIT License, Copyright (c) 2026 DeepSeek
//   Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
//   associated documentation files (the "Software"), to deal in the Software without restriction, including
//   without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
//   copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the
//   following conditions: The above copyright notice and this permission notice shall be included in all
//   copies or substantial portions of the Software.
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
//   LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO
//   EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
//   IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
//   USE OR OTHER DEALINGS IN THE SOFTWARE.
//
// 文档没写清「扩展能否与 function 工具同时声明」（错误表有一条 other tools cannot be used together with …），
// 所以这里做成运行时自适应：先按开关带字段，服务端 400 时按 provider+model 记住（24h）并去掉扩展重试，
// 之后标题改为工具循环结束后单独发一次无工具的短请求，联网回到 flovart_web_search。

import type { AgentMessage } from '@earendil-works/pi-agent-core';

// ---------------------------------------------------------------------------
// 设置：三个开关，本机保存（localStorage），只对 DeepSeek 官方线路生效
// ---------------------------------------------------------------------------

export interface DeepSeekExtensionSettings {
  /** 服务端会话标题 title:{enabled:true}，默认开。 */
  title: boolean;
  /** 服务端联网 deepseek_web_search，默认关；开启时替换本轮的 flovart_web_search（二选一）。 */
  webSearch: boolean;
  /** 安全审核 safety_check:{level:'high'}，默认关；面向公众的应用官方要求开启。 */
  safetyCheck: boolean;
}

export const DEFAULT_DEEPSEEK_EXTENSION_SETTINGS: DeepSeekExtensionSettings = Object.freeze({
  title: true,
  webSearch: false,
  safetyCheck: false,
});

export const DEEPSEEK_EXT_SETTINGS_KEY = 'flovart.deepseek.extensions.v1';
export const DEEPSEEK_EXT_COMPAT_KEY = 'flovart.deepseek.extCompat.v1';
const SETTINGS_EVENT = 'flovart:deepseek-extensions';

/** 「扩展与 function 工具不能共存 / 该模型不支持扩展」记忆的有效期。 */
export const DEEPSEEK_EXT_COMPAT_TTL_MS = 24 * 60 * 60 * 1000;

/** 安全审核拒答时统一显示的文案（与 chat-demo 的 replyRefused 一致）。 */
export const DEEPSEEK_REFUSAL_MESSAGE = '你好，这个问题我暂时无法回答，让我们换个话题再聊聊吧。';

/** 会话里保存服务端标题的自定义 entry（不进模型上下文）。 */
export const SESSION_TITLE_ENTRY = 'flovart.session_title';

/** 联网搜索开启时被替换掉的本地工具名（与 agentWebSearch.WEB_SEARCH_TOOL_NAME 一致）。 */
const LOCAL_WEB_SEARCH_TOOL = 'flovart_web_search';

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function readJson<T>(key: string): T | null {
  const raw = storage()?.getItem(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function loadDeepSeekExtensionSettings(): DeepSeekExtensionSettings {
  const saved = readJson<Partial<DeepSeekExtensionSettings>>(DEEPSEEK_EXT_SETTINGS_KEY) || {};
  return {
    title: typeof saved.title === 'boolean' ? saved.title : DEFAULT_DEEPSEEK_EXTENSION_SETTINGS.title,
    webSearch: typeof saved.webSearch === 'boolean' ? saved.webSearch : DEFAULT_DEEPSEEK_EXTENSION_SETTINGS.webSearch,
    safetyCheck: typeof saved.safetyCheck === 'boolean' ? saved.safetyCheck : DEFAULT_DEEPSEEK_EXTENSION_SETTINGS.safetyCheck,
  };
}

export function saveDeepSeekExtensionSettings(patch: Partial<DeepSeekExtensionSettings>): DeepSeekExtensionSettings {
  const next = { ...loadDeepSeekExtensionSettings(), ...patch };
  try {
    storage()?.setItem(DEEPSEEK_EXT_SETTINGS_KEY, JSON.stringify(next));
  } catch {
    // 存储满或被禁用：本次会话内仍按 next 返回。
  }
  notify();
  return next;
}

function notify() {
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new Event(SETTINGS_EVENT));
  }
}

/** 设置或兼容记忆变化时回调（本页修改 + 其它标签页的 storage 事件）。 */
export function subscribeDeepSeekExtensions(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.key === DEEPSEEK_EXT_SETTINGS_KEY || event.key === DEEPSEEK_EXT_COMPAT_KEY) listener();
  };
  window.addEventListener(SETTINGS_EVENT, listener);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(SETTINGS_EVENT, listener);
    window.removeEventListener('storage', onStorage);
  };
}

// ---------------------------------------------------------------------------
// 线路识别
// ---------------------------------------------------------------------------

/** 只认 DeepSeek 官方 API（api.deepseek.com）；第三方转发 DeepSeek 模型的网关不带这些扩展字段。 */
export function isDeepSeekOfficialRoute(route: { baseUrl?: string } | null | undefined): boolean {
  const raw = String(route?.baseUrl || '').trim();
  if (!raw) return false;
  try {
    return new URL(raw).hostname.toLowerCase() === 'api.deepseek.com';
  } catch {
    return /^(?:https?:\/\/)?api\.deepseek\.com(?:[/:]|$)/i.test(raw);
  }
}

// ---------------------------------------------------------------------------
// 兼容记忆：按 provider + model 持久化，带过期
// ---------------------------------------------------------------------------

/**
 * exclusive：服务端说扩展不能和其它工具（Flovart 的 function 工具）一起声明；没有 function 工具的请求仍可用。
 * unsupported：该模型直接拒收扩展字段（例如旧模型名不认识 title / safety_check）。
 */
export type DeepSeekExtensionCompatMode = 'exclusive' | 'unsupported';

export interface DeepSeekExtensionCompatRecord {
  provider: string;
  model: string;
  mode: DeepSeekExtensionCompatMode;
  /** 记录时间与过期时间（ms）。 */
  at: number;
  until: number;
  /** 服务端原文（截断），设置里展示。 */
  message?: string;
}

type RouteId = { provider?: string; model?: string };

const compatId = (route: RouteId) => `${String(route.provider || '')}\u0000${String(route.model || '')}`;

function readCompat(): Record<string, DeepSeekExtensionCompatRecord> {
  const saved = readJson<Record<string, DeepSeekExtensionCompatRecord>>(DEEPSEEK_EXT_COMPAT_KEY);
  return saved && typeof saved === 'object' ? saved : {};
}

function writeCompat(records: Record<string, DeepSeekExtensionCompatRecord>) {
  try {
    storage()?.setItem(DEEPSEEK_EXT_COMPAT_KEY, JSON.stringify(records));
  } catch {
    // 忽略：记不住时下次请求会再 400 一次并再次降级。
  }
  notify();
}

export function getDeepSeekExtensionCompat(route: RouteId, now = Date.now()): DeepSeekExtensionCompatRecord | null {
  const record = readCompat()[compatId(route)];
  if (!record || typeof record.until !== 'number' || record.until <= now) return null;
  return record;
}

export function markDeepSeekExtensionCompat(
  route: RouteId,
  mode: DeepSeekExtensionCompatMode,
  message = '',
  options: { now?: number; ttlMs?: number } = {},
): DeepSeekExtensionCompatRecord {
  const now = options.now ?? Date.now();
  const record: DeepSeekExtensionCompatRecord = {
    provider: String(route.provider || ''),
    model: String(route.model || ''),
    mode,
    at: now,
    until: now + (options.ttlMs ?? DEEPSEEK_EXT_COMPAT_TTL_MS),
    ...(message ? { message: message.slice(0, 300) } : {}),
  };
  const records = readCompat();
  // 顺手清掉过期项，避免无限增长。
  for (const [key, value] of Object.entries(records)) if (!value || value.until <= now) delete records[key];
  records[compatId(route)] = record;
  writeCompat(records);
  return record;
}

/** 清除记忆（不给 route 时全部清除）：设置里的「重新探测」。 */
export function clearDeepSeekExtensionCompat(route?: RouteId): void {
  if (!route) { writeCompat({}); return; }
  const records = readCompat();
  delete records[compatId(route)];
  writeCompat(records);
}

export function listDeepSeekExtensionCompat(now = Date.now()): DeepSeekExtensionCompatRecord[] {
  return Object.values(readCompat()).filter(record => record && record.until > now);
}

/**
 * 400 响应是不是在拒绝扩展字段：
 * - exclusive：`tools: other tools cannot be used together with deepseek_web_search, deepseek_read_url, safety_check or title yet`
 * - unsupported：正文点名 title / safety_check / deepseek_web_search 且说不认识、不支持。
 * 其它 400（上下文超长、Content Exists Risk、参数错误）不算。
 */
export function classifyDeepSeekExtensionRejection(status: number, body: string): DeepSeekExtensionCompatMode | null {
  if (status !== 400 && status !== 422) return null;
  const text = String(body || '');
  if (/other tools cannot be used together with/i.test(text)) return 'exclusive';
  if (/cannot be used together/i.test(text) && /deepseek_web_search|deepseek_read_url|safety_check|\btitle\b/i.test(text)) return 'exclusive';
  if (/deepseek_web_search|deepseek_read_url|safety_check|[`'"]title[`'"]|\btitle\b/i.test(text)
    && /unknown|unrecognized|unsupported|not support|not allowed|not permitted|extra (?:inputs|fields)|invalid (?:field|parameter|tool)|does not support/i.test(text)) {
    return 'unsupported';
  }
  return null;
}

/** 输入未通过内容审核：`400 Content Exists Risk`（安全审核文档「What Is Reviewed」）。 */
export function isDeepSeekContentRiskRejection(status: number, body: string): boolean {
  return status === 400 && /content exists risk/i.test(String(body || ''));
}

// ---------------------------------------------------------------------------
// 请求：按开关与兼容记忆决定本次带哪些字段
// ---------------------------------------------------------------------------

export interface DeepSeekExtensionPlan {
  title: boolean;
  webSearch: boolean;
  safetyCheck: boolean;
  /** 因兼容记忆被去掉的开关（用于降级：标题补发、联网回到 flovart_web_search、设置里提示）。 */
  suppressed: DeepSeekExtensionCompatMode | null;
}

export const NO_DEEPSEEK_EXTENSIONS: DeepSeekExtensionPlan = Object.freeze({ title: false, webSearch: false, safetyCheck: false, suppressed: null });

export function planDeepSeekExtensions(
  route: RouteId & { baseUrl?: string },
  settings: DeepSeekExtensionSettings,
  context: { hasFunctionTools: boolean; wantTitle: boolean; now?: number },
): DeepSeekExtensionPlan {
  if (!isDeepSeekOfficialRoute(route)) return NO_DEEPSEEK_EXTENSIONS;
  const wanted = {
    title: Boolean(settings.title && context.wantTitle),
    webSearch: Boolean(settings.webSearch),
    safetyCheck: Boolean(settings.safetyCheck),
  };
  const compat = getDeepSeekExtensionCompat(route, context.now);
  const blocked = compat && (compat.mode === 'unsupported' || (compat.mode === 'exclusive' && context.hasFunctionTools));
  if (blocked) return { title: false, webSearch: false, safetyCheck: false, suppressed: wanted.title || wanted.webSearch || wanted.safetyCheck ? compat!.mode : null };
  return { ...wanted, suppressed: null };
}

export function hasDeepSeekExtensions(plan: DeepSeekExtensionPlan): boolean {
  return plan.title || plan.webSearch || plan.safetyCheck;
}

/**
 * 把计划写进 /chat/completions 请求体（返回新对象，不改入参）：
 * - 联网：tools 里去掉 function 工具 flovart_web_search，追加 `{"type":"deepseek_web_search"}`（二选一，避免重复）
 * - 安全审核：顶层 `"safety_check": {"level": "high"}`
 * - 标题：顶层 `"title": {"enabled": true}`
 * 开启任一扩展后 temperature 等参数由服务端决定（文档「Ignored Parameters」），这里不删，服务端会忽略。
 */
export function applyDeepSeekExtensions(body: Record<string, unknown>, plan: DeepSeekExtensionPlan): Record<string, unknown> {
  if (!hasDeepSeekExtensions(plan)) return body;
  const next: Record<string, unknown> = { ...body };
  if (plan.webSearch) {
    const tools = (Array.isArray(body.tools) ? body.tools as Array<Record<string, unknown>> : [])
      .filter(tool => !(tool?.type === 'function' && (tool.function as { name?: string } | undefined)?.name === LOCAL_WEB_SEARCH_TOOL));
    next.tools = [...tools, { type: 'deepseek_web_search' }];
  }
  if (plan.safetyCheck) next.safety_check = { level: 'high' };
  if (plan.title) next.title = { enabled: true };
  return next;
}

// ---------------------------------------------------------------------------
// 响应：流里的扩展输出（都在最后一个 chunk 的 delta 里）
// ---------------------------------------------------------------------------

/** 存在助手消息上的扩展数据（随会话持久化）。 */
export interface DeepSeekMessageExtension {
  /** 安全审核拒答：显示统一文案，且这一轮不进入下一轮上下文。 */
  refusal?: boolean;
  /** delta.refusal 的说明（例如被拦截的图片），只用于排查，不展示原文。 */
  refusalDetail?: string;
  /** message.server_tool_calls：多轮时必须原样回传（读链接的页面在 signature 里）。 */
  serverToolCalls?: unknown[];
  /** message.annotations（url_citation）；回传时会被忽略，留作展示。 */
  annotations?: unknown[];
}

export type DeepSeekAwareMessage = { deepseek?: DeepSeekMessageExtension };

export function readDeepSeekExtension(message: unknown): DeepSeekMessageExtension | undefined {
  const value = (message as DeepSeekAwareMessage | null | undefined)?.deepseek;
  return value && typeof value === 'object' ? value : undefined;
}

export class DeepSeekStreamCollector {
  title = '';
  serverToolCalls: unknown[] | null = null;
  annotations: unknown[] | null = null;
  refusalDetail = '';
  contentFilter = false;

  /** 喂一个 SSE chunk（或非流式响应体）。 */
  feed(json: unknown): void {
    const choice = (json as { choices?: Array<Record<string, unknown>> } | null)?.choices?.[0];
    if (!choice) return;
    for (const source of [choice.delta, choice.message] as Array<Record<string, unknown> | undefined>) {
      if (!source || typeof source !== 'object') continue;
      if (typeof source.title === 'string' && source.title.trim()) this.title = source.title.trim();
      if (Array.isArray(source.server_tool_calls)) this.serverToolCalls = source.server_tool_calls;
      if (Array.isArray(source.annotations)) this.annotations = source.annotations;
      if (typeof source.refusal === 'string' && source.refusal.trim()) this.refusalDetail = source.refusal.trim();
    }
    if (choice.finish_reason === 'content_filter') this.contentFilter = true;
  }

  get refused(): boolean {
    return this.contentFilter || Boolean(this.refusalDetail);
  }
}

/** 拒答消息：丢掉已下发的思考、正文与工具调用（文档：已流出的文字不能撤回，客户端替换成拒答文案）。 */
export function toRefusalMessage<T extends { content: unknown }>(message: T, detail = '', serverToolCalls?: unknown[] | null): T & DeepSeekAwareMessage {
  return {
    ...message,
    content: [{ type: 'text', text: DEEPSEEK_REFUSAL_MESSAGE }],
    stopReason: 'stop',
    deepseek: {
      refusal: true,
      ...(detail ? { refusalDetail: detail.slice(0, 500) } : {}),
      ...(serverToolCalls?.length ? { serverToolCalls } : {}),
    },
  } as T & DeepSeekAwareMessage;
}

/** 流结束时把扩展输出挂到最终助手消息上。 */
export function finalizeDeepSeekMessage<T extends { content: unknown }>(message: T, collector: DeepSeekStreamCollector): T & DeepSeekAwareMessage {
  if (collector.refused) return toRefusalMessage(message, collector.refusalDetail, collector.serverToolCalls);
  if (!collector.serverToolCalls?.length && !collector.annotations?.length) return message;
  return {
    ...message,
    deepseek: {
      ...(collector.serverToolCalls?.length ? { serverToolCalls: collector.serverToolCalls } : {}),
      ...(collector.annotations?.length ? { annotations: collector.annotations } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// 回传：server_tool_calls 原样带回；拒答轮次不进入上下文
// ---------------------------------------------------------------------------

/** assistant 消息回传时附加的字段（只对 DeepSeek 官方线路）。 */
export function serverToolCallsEcho(message: unknown): Record<string, unknown> {
  const calls = readDeepSeekExtension(message)?.serverToolCalls;
  return Array.isArray(calls) && calls.length ? { server_tool_calls: calls } : {};
}

export function isRefusedMessage(message: unknown): boolean {
  return (message as { role?: string } | null)?.role === 'assistant' && Boolean(readDeepSeekExtension(message)?.refusal);
}

/**
 * 去掉被安全审核拒答的轮次：拒答的助手消息不回传；它紧跟在一条用户消息后面（没有工具循环）时，
 * 这条提问也不回传，否则每轮都会带着被拦的输入再触发一次审核（参照 chat-demo 只回传「提问 + 有回答」成对的轮次）。
 */
export function dropRefusedRounds(messages: AgentMessage[]): AgentMessage[] {
  if (!messages.some(isRefusedMessage)) return messages;
  const out: AgentMessage[] = [];
  for (const message of messages) {
    if (isRefusedMessage(message)) {
      const previous = out[out.length - 1] as { role?: string } | undefined;
      if (previous?.role === 'user') out.pop();
      continue;
    }
    out.push(message);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 会话标题
// ---------------------------------------------------------------------------

export interface SessionTitleRecord {
  title: string;
  source: 'deepseek' | 'fallback';
}

/** 会话里最近一次保存的服务端标题；没有时返回空串，由 deriveTitle 取首条用户消息。 */
export function sessionTitleFromEntries(entries: readonly unknown[]): string {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as { type?: string; customType?: string; data?: { title?: unknown } } | undefined;
    if (entry?.type === 'custom' && entry.customType === SESSION_TITLE_ENTRY) {
      const title = typeof entry.data?.title === 'string' ? entry.data.title.trim() : '';
      if (title) return title;
    }
  }
  return '';
}

export function cleanTitle(raw: string): string {
  return String(raw || '')
    .replace(/^[\s"'“”‘’「」『』《》#*`]+|[\s"'“”‘’「」『』《》#*`。．.!！]+$/g, '')
    .split(/\r?\n/)[0]
    .trim()
    .slice(0, 40);
}

const TITLE_PROMPT = '为下面这段对话起一个简短的标题（不超过 16 个字，与用户使用的语言一致）。只输出标题本身，不要引号、标点和解释。';

/**
 * 降级标题：工具循环结束后单独发一次无工具、非流式的短请求。
 * 能用 title 字段时带 `title:{enabled:true}` 并优先取 message.title，否则取模型按提示写的正文；失败返回 null（调用方保留 deriveTitle）。
 */
export async function requestDeepSeekTitle(
  route: { baseUrl: string; apiKey: string; model: string },
  conversation: { user: string; assistant?: string },
  options: { useTitleField: boolean; signal?: AbortSignal; fetchImpl?: typeof fetch } = { useTitleField: true },
): Promise<string | null> {
  const user = String(conversation.user || '').trim().slice(0, 2000);
  if (!user) return null;
  const doFetch = options.fetchImpl ?? fetch;
  const messages = [
    { role: 'system', content: TITLE_PROMPT },
    { role: 'user', content: conversation.assistant ? `用户：${user}\n\n助手：${String(conversation.assistant).slice(0, 1000)}` : user },
  ];
  const attempt = async (minimal: boolean) => {
    const body: Record<string, unknown> = {
      model: route.model,
      messages,
      stream: false,
      max_tokens: 64,
      ...(minimal ? {} : { thinking: { type: 'disabled' } }),
      ...(options.useTitleField && !minimal ? { title: { enabled: true } } : {}),
    };
    return doFetch(`${route.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${route.apiKey}` },
      body: JSON.stringify(body),
      signal: options.signal,
    });
  };
  try {
    let response = await attempt(false);
    // 不认 thinking / title 字段：去掉后再试一次，只让模型按提示写标题。
    if (!response.ok && (response.status === 400 || response.status === 422)) response = await attempt(true);
    if (!response.ok) return null;
    const json = JSON.parse((await response.text()).trim() || '{}') as { error?: unknown; choices?: Array<{ message?: { title?: unknown; content?: unknown }; finish_reason?: string }> };
    if (json.error) return null;
    const choice = json.choices?.[0];
    if (!choice || choice.finish_reason === 'content_filter') return null;
    const fromField = typeof choice.message?.title === 'string' ? cleanTitle(choice.message.title) : '';
    if (fromField) return fromField;
    const fromContent = typeof choice.message?.content === 'string' ? cleanTitle(choice.message.content) : '';
    return fromContent || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 内核接入：会话标题的状态机（首轮内联 title → 降级补发 → deriveTitle）
// ---------------------------------------------------------------------------

/** 内核给流式请求的 DeepSeek 扩展接入点；不传时只按本机设置带联网 / 安全审核，不请求标题。 */
export interface DeepSeekStreamHooks {
  settings?: () => DeepSeekExtensionSettings;
  /** 本次请求要不要带 title（会话还没有标题时）。 */
  wantTitle?: () => boolean;
  onTitle?: (title: string) => void;
}

/** 一个会话最多几次请求内联带 title（工具循环的中间请求可能不返回标题，文档说标题最多多等 5 秒）。 */
const MAX_INLINE_TITLE_REQUESTS = 3;

function firstText(message: unknown): string {
  const content = (message as { content?: unknown } | null)?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(block => (block as { type?: string; text?: string })?.type === 'text' ? String((block as { text?: string }).text || '') : '').join(' ').trim();
}

export class DeepSeekSessionTitler {
  private title = '';
  private inlineRequests = 0;
  private fallbackTried = false;
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly options: {
    route: { provider?: string; model: string; baseUrl: string; apiKey: string };
    save: (record: SessionTitleRecord) => Promise<void> | void;
    settings?: () => DeepSeekExtensionSettings;
    fetchImpl?: typeof fetch;
  }) {}

  private settings() {
    return (this.options.settings ?? loadDeepSeekExtensionSettings)();
  }

  private enabled() {
    return isDeepSeekOfficialRoute(this.options.route) && this.settings().title;
  }

  /** 打开 / 切换会话时从 entry 恢复（已有标题就不再请求）。 */
  reset(entries: readonly unknown[]): void {
    this.title = sessionTitleFromEntries(entries);
    this.inlineRequests = 0;
    this.fallbackTried = false;
  }

  hooks(): DeepSeekStreamHooks {
    return {
      settings: () => this.settings(),
      wantTitle: () => {
        if (this.title || !this.enabled() || this.inlineRequests >= MAX_INLINE_TITLE_REQUESTS) return false;
        this.inlineRequests += 1;
        return true;
      },
      onTitle: title => { void this.accept(title, 'deepseek'); },
    };
  }

  private async accept(raw: string, source: SessionTitleRecord['source']): Promise<void> {
    const title = cleanTitle(raw);
    if (!title || this.title) return;
    this.title = title;
    await this.options.save({ title, source });
  }

  /**
   * 一轮（含工具循环）结束后：还没有标题时补发一次无工具短请求（只做一次）。
   * 拒答的轮次不补发；补发失败保留 deriveTitle 的首条消息标题。
   */
  afterTurn(messages: readonly unknown[]): Promise<void> {
    if (this.title || this.fallbackTried || !this.enabled()) return this.pending;
    const last = [...messages].reverse().find(message => (message as { role?: string })?.role === 'assistant');
    if (!last || isRefusedMessage(last) || (last as { stopReason?: string }).stopReason === 'aborted') return this.pending;
    const user = messages.find(message => (message as { role?: string })?.role === 'user');
    const userText = firstText(user);
    if (!userText) return this.pending;
    this.fallbackTried = true;
    const compat = getDeepSeekExtensionCompat(this.options.route);
    this.pending = requestDeepSeekTitle(this.options.route, { user: userText, assistant: firstText(last) }, {
      useTitleField: compat?.mode !== 'unsupported',
      fetchImpl: this.options.fetchImpl,
    }).then(title => (title ? this.accept(title, 'fallback') : undefined)).catch(() => undefined);
    return this.pending;
  }

  /** 测试与关闭用：等补发的标题请求结束。 */
  settled(): Promise<void> {
    return this.pending;
  }

  get currentTitle(): string {
    return this.title;
  }
}
