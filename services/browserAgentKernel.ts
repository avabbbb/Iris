import { readSseEvents } from './sse';
import { commitStreamUsage, createStreamUsageAccumulator, streamOutcome } from './streamUsage';
import { fetchStreamWithUsageOptIn, type StreamUsageMode } from './streamUsageOptIn';
// 浏览器内置 Iris Agent 内核：直接用 pi-agent-core 在 Web 端跑 Agent，
// 不依赖外部 Managed Agent 服务。会话持久化到 localforage，模型走 OpenAI 兼容
// agent-text 线路（与桌面 Runtime 的 agent-text.route.sync 同源配置），
// 工具走浏览器侧 workflowDispatcher 命令面。
import { Agent, convertToLlm, InMemorySessionStorage, toSession } from '@earendil-works/pi-agent-core';
import type { AgentMessage, AgentTool, Session, StreamFn } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import localforage from 'localforage';
import { Type } from 'typebox';
import { resolveAgentTextRoutes } from './agentTextRoutes';
import { createBrowserWorkflowContract } from './browserWorkflowContract';
import { WORKFLOW_NODE_TOOL_FAMILY_COMMANDS, workflowNodeToolSpecs, workflowNodeToolsOfFamily, type WorkflowNodeToolFamily } from '../components/workflow/nodeToolCatalog';
import { browserAgentTaskLayer, BROWSER_TASKABLE_COMMANDS } from './browserAgentTasks';
import { taskArgsHash } from '../agent/task-layer.js';
import { withWorkflowHumanApproval, workflowCommandNeedsConfirmation } from './workflowDispatcher';
import type { ProductionSkillAttachment } from './productionSkillCatalog';
import { isUserSkillAttachment, skillSystemContext } from './userSkillContext';
import { workflowConfirmRequest } from './workflowAgentBridge';
import type { AgentConfirmRequest } from './agentSpendMandate';
import { readConfirmVerdict, type AgentConfirmVerdict } from './runApproval';
import { AGENT_BROWSER_COMMANDS } from '../tools/iris/agent-surface.js';
import { agentToolInputSchema, getAgentToolSpecs } from '../tools/iris/agent-tools.js';
import { createLegacyTodoTool, LEGACY_TODO_TOOL_NAME } from '../agent/todo.js';
import type { ImageContent } from '@earendil-works/pi-ai';
import type { WorkflowNode } from '../components/workflow/types';
import { useWorkflowStore } from '../components/workflow/store';
import { resolveNodeOrAlternate } from '../components/workflow/batchAlternates';
import { loadAgentNodeMedia, type AgentVideoFrame, type AgentVideoLayout } from './agentMediaView';
import { createCutAgentTools, CUT_TOOL_DOCS } from './cut/agentTools';
import { buildAgentAskForm, type AgentAskForm, type AgentAskSpec } from '../components/agent/agentAskForm';
import { formatSearchSources, searchAgentWeb, WEB_SEARCH_TOOL_NAME, type AgentSearchCredential, type SearchRecency } from './agentWebSearch';
import { formatGrepMatches, grepLocalFolders, LOCAL_GREP_TOOL_NAME } from './agentLocalGrep';
import { resolveToolApproval, toolApprovalFor, type ApprovalContext } from './agentToolPolicy';
import type { UserApiKey } from '../types';
import { displayError } from './displayError';
import { reasoningEchoFor, requiresEmptyReasoningContent, type ReasoningEcho } from './agentReasoning';
import {
  buildSkillIndex,
  createSkillReadTool,
  formatSkillIndexPrompt,
  readSkillForAgent,
  resolveSkillEntry,
  SKILL_READ_ENTRY,
  SKILL_READ_TOOL_NAME,
  SkillReadLedger,
  type AgentSkillCatalog,
  type SkillReadRecord,
} from './agentSkills';
import { MergedSkillCatalog } from './agentSkillCatalog';
import { createMemoryTool, formatMemoryNudge, formatMemorySummary, looksLikeDecisionConfirmation, MEMORY_TOOL_NAME, type AgentMemoryBackend, type MemoryNudgeInput } from './agentProjectMemory';
import {
  BROWSER_AGENT_CONTEXT_WINDOW,
  classifyAgentRequestFailure,
  compactionThresholdTokens,
  compactSession,
  DEFAULT_AGENT_COMPACTION_SETTINGS,
  estimateRequestTokens,
  isContextOverflowMessage,
  OVERFLOW_KEEP_RECENT_TOKENS,
  shouldCompactContext,
  type AgentCompactionSettings,
} from './agentCompaction';
import { agentMemoryStoreBackend } from '../stores/useAgentMemoryStore';
import { buildReasoningParams, effectiveAgentThinkingLevel, isReasoningRejection, isReasoningUnsupported, markReasoningUnsupported, normalizeThinkingLevel, type AgentThinkingLevel } from './agentThinking';

// ---------------------------------------------------------------------------
// 会话持久化：localforage 存 InMemorySessionStorage 的 metadata + entries
// ---------------------------------------------------------------------------

interface LegacyPersistedSession {
  metadata: { id: string; createdAt: string; metadata?: Record<string, unknown> };
  entries: unknown[];
}

interface PersistedSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
  entries: unknown[];
}

// 旧版单会话存储 key（iris.agent.session.<projectId>），迁移后删除
const sessionKey = (projectId: string) => `iris.agent.session.${projectId}`;
// 每个项目保存一个会话列表（含历史对话），key 形如 iris.agent.sessions.<projectId>
const sessionsKey = (projectId: string) => `iris.agent.sessions.${projectId}`;

/** 从会话第一条用户消息派生标题，最多取 24 字。 */
function deriveTitle(entries: unknown[]): string {
  for (const entry of entries as Array<{ type?: string; message?: { role?: string; content?: Array<{ type?: string; text?: string }> } }>) {
    if (entry?.type === 'message' && entry.message?.role === 'user') {
      const raw = (entry.message.content || []).filter(block => block.type === 'text').map(block => block.text || '').join('\n\n');
      // 只取用户自己写的段落：引用 / 附件 / 画面这类系统附注不进标题。
      const text = raw.split(/\n{2,}/).map(part => part.trim())
        .filter(part => part && !/^(引用上下文：|本轮附带的本地媒体|已附带画面：|注意：本轮附带的本地媒体)/.test(part))
        .join(' ').trim();
      if (text) return text.slice(0, 24) || '新对话';
    }
  }
  return '新对话';
}

class BrowserSessionStore {
  constructor(private readonly projectId: string) {}

  async loadAll(): Promise<PersistedSession[]> {
    const saved = await localforage.getItem<PersistedSession[]>(sessionsKey(this.projectId));
    return Array.isArray(saved) ? saved : [];
  }

  async saveAll(sessions: PersistedSession[]): Promise<void> {
    await localforage.setItem(sessionsKey(this.projectId), sessions);
  }

  /** 迁移旧版单会话 key（iris.agent.session.<id>），只迁移一次。 */
  async migrateLegacy(): Promise<PersistedSession[]> {
    const legacy = await localforage.getItem<LegacyPersistedSession>(sessionKey(this.projectId));
    if (!legacy) return this.loadAll();
    const sessions = await this.loadAll();
    if (!sessions.some(item => item.id === legacy.metadata.id)) {
      sessions.unshift({
        id: legacy.metadata.id,
        title: deriveTitle(legacy.entries || []),
        createdAt: legacy.metadata.createdAt,
        updatedAt: legacy.metadata.createdAt,
        metadata: legacy.metadata.metadata,
        entries: legacy.entries || [],
      });
      await this.saveAll(sessions);
    }
    await localforage.removeItem(sessionKey(this.projectId));
    return sessions;
  }
}

class BrowserSessionRepo {
  constructor(private readonly projectId: string, private readonly store = new BrowserSessionStore(projectId)) {}

  async create(options: { id?: string; metadata?: Record<string, unknown> } = {}): Promise<Session> {
    const metadata = {
      id: options.id ?? crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      ...(options.metadata ? { metadata: options.metadata } : {}),
    };
    const storage = new InMemorySessionStorage({ metadata: metadata as never });
    const session = toSession(storage);
    await this.persist(session);
    return session;
  }

  async open(metadata: { id: string }): Promise<Session> {
    const sessions = await this.store.migrateLegacy();
    const saved = sessions.find(item => item.id === metadata.id);
    if (!saved) throw new Error(`Agent 会话不存在：${metadata.id}`);
    const storage = new InMemorySessionStorage({
      metadata: { id: saved.id, createdAt: saved.createdAt, metadata: saved.metadata } as never,
      entries: saved.entries as never[],
    });
    return toSession(storage);
  }

  async list(): Promise<Array<{ id: string; title: string; createdAt: string; updatedAt: string; metadata?: Record<string, unknown> }>> {
    const sessions = await this.store.migrateLegacy();
    return sessions.map(({ id, title, createdAt, updatedAt, metadata }) => ({ id, title, createdAt, updatedAt, metadata }));
  }

  async delete(sessionId?: string): Promise<void> {
    if (!sessionId) { await localforage.removeItem(sessionsKey(this.projectId)); return; }
    const sessions = await this.store.loadAll();
    await this.store.saveAll(sessions.filter(item => item.id !== sessionId));
  }

  async persist(session: Session): Promise<void> {
    const storage = session.getStorage();
    const metadata = await storage.getMetadata();
    const entries = (await storage.getEntries()) as unknown[];
    const sessions = await this.store.migrateLegacy();
    const now = new Date().toISOString();
    const next = sessions.filter(item => item.id !== metadata.id);
    // 自定义 metadata 存在 InMemorySessionStorage 构造参数里，getMetadata 只返回 id/createdAt；
    // 从既有列表找回该会话的自定义字段，找不到视为无。
    const existing = sessions.find(item => item.id === metadata.id);
    next.unshift({
      id: String(metadata.id || crypto.randomUUID()),
      title: deriveTitle(entries),
      createdAt: String(metadata.createdAt || now),
      updatedAt: now,
      metadata: existing?.metadata,
      entries,
    });
    await this.store.saveAll(next);
  }
}

// ---------------------------------------------------------------------------
// 模型线路：与 runtimeAgentTextRoutes 同源过滤，浏览器本地解析
// ---------------------------------------------------------------------------

export interface BrowserAgentTextRoute {
  provider: string;
  model: string;
  /** 来自 Key 的流式 usage opt-in；缺省 passive，不改请求。 */
  streamUsage?: StreamUsageMode;
  /** 覆盖流式卡住检测 / 重试参数（基准与测试用），缺省见 BROWSER_AGENT_STREAM_DEFAULTS。 */
  timeouts?: Partial<{ firstChunkMs: number; idleMs: number; retries: number; retryBaseMs: number }>;
  baseUrl: string;
  apiKey: string;
}

export function resolveBrowserAgentTextRoute(keys: UserApiKey[]): BrowserAgentTextRoute | null {
  // 显式 agent-text 映射优先；没有时回退到默认文本 Key 的默认模型（见 agentTextRoutes）。
  const first = resolveAgentTextRoutes(keys)[0];
  if (!first) return null;
  return {
    provider: first.key.provider,
    model: first.model,
    baseUrl: first.baseUrl,
    apiKey: first.key.key,
    ...(first.key.streamUsage === 'request' ? { streamUsage: 'request' as const } : {}),
  };
}

// ---------------------------------------------------------------------------
// OpenAI 兼容流式 StreamFn：SSE → AssistantMessageEventStream
// ---------------------------------------------------------------------------

const EMPTY_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };

function hasContent(message: AgentMessage): message is Extract<AgentMessage, { content: unknown }> {
  return 'content' in message;
}

function userImageBlocks(message: AgentMessage): { images?: Array<{ mimeType: string; data: string }> } {
  if (!hasContent(message) || typeof message.content === 'string') return {};
  const images = message.content
    .filter((block): block is ImageContent => block.type === 'image')
    .map(block => ({ mimeType: block.mimeType, data: block.data }));
  return images.length ? { images } : {};
}

function textBlocks(message: AgentMessage): string {
  if (!hasContent(message)) return '';
  if (typeof message.content === 'string') return message.content;
  return message.content
    .map(block => block.type === 'text' ? block.text : '')
    .filter(Boolean)
    .join('\n');
}

/** 助手消息里的思考内容（reasoning_content / reasoning），与正文分开展示。 */
function thinkingBlocks(message: AgentMessage): string {
  if (!hasContent(message) || typeof message.content === 'string') return '';
  return message.content
    .map(block => block.type === 'thinking' ? block.thinking : '')
    .filter(Boolean)
    .join('\n');
}

function imagePart(block: { data?: string; mimeType?: string }): Record<string, unknown> | null {
  const data = block.data;
  if (!data) return null;
  return { type: 'image_url', image_url: { url: data.startsWith('data:') ? data : 'data:' + (block.mimeType || 'image/png') + ';base64,' + data } };
}

/** 工具结果里的图片：OpenAI tool 消息只收文本，图片要放进紧随其后的 user 消息。 */
function toolResultImageParts(message: AgentMessage): Array<Record<string, unknown>> {
  if (message.role !== 'toolResult' || !hasContent(message) || typeof message.content === 'string') return [];
  const parts: Array<Record<string, unknown>> = [];
  for (const block of message.content) {
    if (block.type !== 'image') continue;
    const part = imagePart(block);
    if (part) parts.push(part);
  }
  return parts;
}

/** 下一轮请求里助手消息的思考怎么回传，见 agentReasoning.reasoningEchoFor。缺省不回传。 */
export interface OpenAIMessageOptions {
  reasoningEcho?: ReasoningEcho;
  /** DeepSeek：没有思考的 assistant 也补 reasoning_content: ''。 */
  emptyReasoningContent?: boolean;
}

function toOpenAIMessage(message: AgentMessage, options: OpenAIMessageOptions = {}): Record<string, unknown> {
  if (message.role === 'toolResult') {
    return {
      role: 'tool',
      tool_call_id: message.toolCallId,
      content: message.isError ? `错误：${textBlocks(message)}` : textBlocks(message),
    };
  }
  if (message.role === 'assistant') {
    const content: Array<Record<string, unknown>> = [];
    const echoed: string[] = [];
    const toolCalls: Array<Record<string, unknown>> = [];
    if (hasContent(message)) {
      for (const block of message.content) {
        if (block.type === 'thinking') {
          if (block.thinking) echoed.push(block.thinking);
        } else if (block.type === 'text') content.push({ type: 'text', text: block.text });
        else if (block.type === 'toolCall') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: { name: block.name, arguments: JSON.stringify(block.arguments ?? {}) },
          });
        }
      }
    }
    return {
      role: 'assistant',
      content: content.length > 0 ? content : '',
      ...(options.reasoningEcho === 'reasoning_content' && (echoed.length > 0 || options.emptyReasoningContent)
        ? { reasoning_content: echoed.join('\n') }
        : {}),
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    };
  }
  if (!hasContent(message)) return { role: 'user', content: '' };
  if (typeof message.content === 'string') return { role: 'user', content: message.content };
  const parts: Array<Record<string, unknown>> = [];
  for (const block of message.content) {
    switch (block.type) {
      case 'text':
        parts.push({ type: 'text', text: block.text });
        break;
      case 'image': {
        const part = imagePart(block);
        if (part) parts.push(part);
        break;
      }
      default:
        break;
    }
  }
  return { role: 'user', content: parts };
}

const ORPHAN_TOOL_RESULT = '已取消：本次工具调用未执行完成（用户停止或会话中断）。';

/**
 * OpenAI 兼容接口要求每个 assistant.tool_calls 都紧跟对应的 tool 消息。
 * 停止、拒绝确认或刷新中断后会话里会留下没有结果的 toolCall，下一轮请求会被整体拒绝；
 * 这里在发送前补齐合成结果，不改写已持久化的会话。
 */
export function toOpenAIMessages(messages: AgentMessage[], options: OpenAIMessageOptions = {}): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  let pending: string[] = [];
  // 本批工具结果里的图片：等对应 tool 消息全部补齐后作为一条 user 消息追加，不打断 tool_calls 配对。
  let pendingImages: Array<Record<string, unknown>> = [];
  const emitImages = () => {
    if (pendingImages.length === 0) return;
    out.push({ role: 'user', content: [{ type: 'text', text: '以上工具调用返回的画面：' }, ...pendingImages] });
    pendingImages = [];
  };
  const flush = () => {
    for (const id of pending) out.push({ role: 'tool', tool_call_id: id, content: ORPHAN_TOOL_RESULT });
    pending = [];
    emitImages();
  };
  for (const message of messages) {
    const converted = toOpenAIMessage(message, options);
    if (converted.role === 'tool') {
      const id = String(converted.tool_call_id || '');
      if (!pending.includes(id)) continue; // 没有对应 tool_call 的孤立结果同样会被拒绝，丢弃。
      pending = pending.filter(item => item !== id);
      out.push(converted);
      pendingImages.push(...toolResultImageParts(message));
      if (pending.length === 0) emitImages();
      continue;
    }
    flush();
    out.push(converted);
    const calls = converted.tool_calls as Array<{ id?: string }> | undefined;
    if (calls?.length) pending = calls.map(call => String(call.id || '')).filter(Boolean);
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------
// 纯文本模型：服务商明确拒收图片后记住该线路，之后的请求不再带图片内容（会话内有效）。
// ---------------------------------------------------------------------------

const TEXT_ONLY_ROUTES = new Set<string>();
const textOnlyKey = (route: Pick<BrowserAgentTextRoute, 'baseUrl' | 'model'>) => route.baseUrl + '\u0000' + route.model;
export const TEXT_ONLY_IMAGE_NOTE = '[图片未发送：当前文本模型不支持图片输入。需要看画面时请让用户换支持看图的模型；画布上的图片节点仍可按节点 id 引用、连线作为生成参考。]';

export function isRouteTextOnly(route: Pick<BrowserAgentTextRoute, 'baseUrl' | 'model'>): boolean {
  return TEXT_ONLY_ROUTES.has(textOnlyKey(route));
}

export function markRouteTextOnly(route: Pick<BrowserAgentTextRoute, 'baseUrl' | 'model'>, textOnly = true): void {
  if (textOnly) TEXT_ONLY_ROUTES.add(textOnlyKey(route));
  else TEXT_ONLY_ROUTES.delete(textOnlyKey(route));
}

/** HTTP 400/415/422 且正文说模型不收图片 / 文件 / 多模态输入。 */
export function isImageInputRejection(status: number, body: string): boolean {
  if (status !== 400 && status !== 415 && status !== 422) return false;
  return /image|vision|multimodal|multi-modal|file input|image_url/i.test(body)
    && /not support|unsupported|does not|doesn't|not allowed|invalid|cannot|can't|only (?:supports? )?text/i.test(body);
}

function hasImageParts(messages: Array<Record<string, unknown>>): boolean {
  return messages.some(message => Array.isArray(message.content) && (message.content as Array<{ type?: string }>).some(part => part?.type === 'image_url'));
}

/** 去掉 OpenAI 消息里的 image_url 片段，每条消息留一句说明。 */
export function stripImageParts(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return messages.map(message => {
    if (!Array.isArray(message.content)) return message;
    const parts = message.content as Array<{ type?: string }>;
    if (!parts.some(part => part?.type === 'image_url')) return message;
    return { ...message, content: [...parts.filter(part => part?.type !== 'image_url'), { type: 'text', text: TEXT_ONLY_IMAGE_NOTE }] };
  });
}

/**
 * /chat/completions 请求体。思考强度为 off 时不带任何思考参数；
 * 其余按服务映射（见 agentThinking.buildReasoningParams）。
 */
export function buildBrowserAgentRequestBody(
  route: Pick<BrowserAgentTextRoute, 'provider' | 'model' | 'baseUrl'>,
  context: { systemPrompt?: string; messages: AgentMessage[]; tools?: Array<{ name: string; description: string; parameters: unknown }> },
  thinkingLevel: AgentThinkingLevel = 'off',
  options: { textOnly?: boolean } = {},
): Record<string, unknown> {
  const reasoning = buildReasoningParams(thinkingLevel, route);
  const messages = toOpenAIMessages(context.messages, {
    reasoningEcho: reasoningEchoFor(route),
    emptyReasoningContent: requiresEmptyReasoningContent(route),
  });
  return {
    model: route.model,
    // DeepSeek / Kimi 的工具循环要求原样回传 reasoning_content，其它服务不回传。
    // 系统提示词固定在最前（稳定前缀，见 withSystemPrompt）。
    // 纯文本模型：图片内容换成一句说明，不再整轮 400。
    messages: withSystemPrompt(options.textOnly ? stripImageParts(messages) : messages, context.systemPrompt),
    ...(context.tools?.length ? {
      tools: context.tools.map(tool => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      })),
    } : {}),
    stream: true,
    // 工具选择与参数需要可复现，与 aiGateway 的 STABLE_TEXT_TEMPERATURE 保持一致；Anthropic 开启思考时不允许改 temperature。
    ...(reasoning.dropTemperature ? {} : { temperature: 0.2 }),
    max_tokens: 16384,
    ...reasoning.params,
  };
}

/** 流式卡住检测与瞬时失败重试的默认值；route.timeouts 可覆盖（基准与测试用）。 */
export const BROWSER_AGENT_STREAM_DEFAULTS = {
  /** 发出请求到第一个 SSE 事件（含思考增量）的最长等待。 */
  firstChunkMs: 90_000,
  /** 两个 SSE 事件之间的最长静默。 */
  idleMs: 60_000,
  /** 首个增量出现前，对网络错误 / 408 / 429 / 5xx / 卡住的额外重试次数。 */
  retries: 2,
  retryBaseMs: 600,
};

/** 用户主动停止时写进助手消息的文案；面板据此显示「已中止」而不是红色错误卡。 */
export const AGENT_ABORTED_MESSAGE = '已中止';
/** 服务商报上下文超限时写进助手消息的文案（classifyAgentRequestFailure 认得它，内核据此压缩后重试一次）。 */
export const AGENT_CONTEXT_OVERFLOW_MESSAGE = '对话上下文超出模型上限（context length exceeded）：可在会话菜单里「压缩上下文」后重试。';

class StreamStallError extends Error {
  constructor(readonly phase: 'first' | 'idle', readonly ms: number) {
    super(phase === 'first'
      ? `模型 ${Math.round(ms / 1000)} 秒内没有开始输出，已停止等待，可重试。`
      : `模型输出中断超过 ${Math.round(ms / 1000)} 秒，已停止等待，可重试。`);
    this.name = 'StreamStallError';
  }
}

class RetryableHttpError extends Error {
  constructor(readonly status: number, readonly body: string, readonly retryAfterMs?: number) {
    super(`模型请求失败（HTTP ${status}）：${body.slice(0, 200)}`);
    this.name = 'RetryableHttpError';
  }
}

function isTransient(error: unknown): boolean {
  if (error instanceof StreamStallError || error instanceof RetryableHttpError) return true;
  // fetch 的网络层失败（断连、DNS、TLS）在浏览器与 Node 中都是 TypeError。
  return error instanceof TypeError;
}

function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.min(5_000, Math.max(0, seconds * 1000));
  return undefined;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); return; }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(signal?.reason ?? new DOMException('Aborted', 'AbortError')); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 系统提示词作为第一条 system 消息：固定在请求最前面，之后是按时间追加的历史，
 * 使同一会话的每次请求共享同一前缀（DeepSeek / OpenAI 兼容服务的前缀缓存可以命中）。
 */
function withSystemPrompt(messages: Array<Record<string, unknown>>, systemPrompt: string | undefined) {
  const prompt = String(systemPrompt || '').trim();
  return prompt ? [{ role: 'system', content: prompt }, ...messages] : messages;
}

export function createBrowserAgentStream(route: BrowserAgentTextRoute): StreamFn {
  const limits = { ...BROWSER_AGENT_STREAM_DEFAULTS, ...(route.timeouts || {}) };
  return async (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    const startMessage: AssistantMessage = {
      role: 'assistant',
      content: [],
      api: 'openai-compatible',
      provider: route.provider,
      model: route.model,
      usage: EMPTY_USAGE as AssistantMessage['usage'],
      stopReason: 'stop',
      timestamp: Date.now(),
    };
    // pi-agent-core 把 state.thinkingLevel 作为 options.reasoning 传进来（off 时为 undefined）。
    const requested = normalizeThinkingLevel((options as { reasoning?: unknown } | undefined)?.reasoning);
    let thinkingLevel: AgentThinkingLevel = requested !== 'off' && isReasoningUnsupported(route.model) ? 'off' : requested;
    const userSignal = options?.signal;
    void (async () => {
      // 每次尝试一个新的 AbortController（不复用已 abort 的控制器）；用户停止通过 userSignal 级联。
      let attemptController: AbortController | undefined;
      const onUserAbort = () => attemptController?.abort(userSignal?.reason);
      userSignal?.addEventListener('abort', onUserAbort);
      // 一旦向面板推过任何增量就不再重试，避免同一条回复出现两遍。
      let emitted = false;
      let started = false;
      const usage = createStreamUsageAccumulator('openai');
      const usageMeta = { provider: String(route.provider), model: route.model, source: 'browser-agent' };
      try {
        for (let attempt = 0; ; attempt += 1) {
          if (userSignal?.aborted) throw userSignal.reason ?? new DOMException('Aborted', 'AbortError');
          attemptController = new AbortController();
          const controller = attemptController;
          let stallTimer: ReturnType<typeof setTimeout> | undefined;
          let stall: StreamStallError | undefined;
          const arm = (phase: 'first' | 'idle') => {
            clearTimeout(stallTimer);
            const ms = phase === 'first' ? limits.firstChunkMs : limits.idleMs;
            stallTimer = setTimeout(() => { stall = new StreamStallError(phase, ms); controller.abort(stall); }, ms);
          };
          try {
            arm('first');
            let sentImages = false;
            const request = (level: AgentThinkingLevel) => {
              const textOnly = isRouteTextOnly(route);
              const body = buildBrowserAgentRequestBody(route, context as never, level, { textOnly });
              sentImages = !textOnly && hasImageParts(body.messages as Array<Record<string, unknown>>);
              return fetchStreamWithUsageOptIn(`${route.baseUrl}/chat/completions`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${route.apiKey}`,
                },
                signal: controller.signal,
              }, body, route.streamUsage);
            };
            let response = await request(thinkingLevel);
            if (!response.ok && thinkingLevel !== 'off') {
              const body = await response.clone().text().catch(() => '');
              if (isReasoningRejection(response.status, body)) {
                // 该模型不接受思考参数：记住并去掉参数重试一次；选择器随后显示「不支持」。
                markReasoningUnsupported(route.model);
                thinkingLevel = 'off';
                response = await request('off');
              }
            }
            if (!response.ok && sentImages) {
              const body = await response.clone().text().catch(() => '');
              if (isImageInputRejection(response.status, body)) {
                // 纯文本模型收到图片：记住这条线路，去掉图片内容重试一次（Agent 改按画布节点 id 引用）。
                markRouteTextOnly(route);
                response = await request(thinkingLevel);
              }
            }
            if (!response.ok) {
              const body = await response.text().catch(() => '');
              if (response.status === 408 || response.status === 429 || response.status >= 500) {
                throw new RetryableHttpError(response.status, body, retryAfterMs(response.headers.get('retry-after')));
              }
              throw new Error(`模型请求失败（HTTP ${response.status}）：${body.slice(0, 200)}`);
            }
            if (!response.body) throw new Error('模型没有返回流');
            let text = '';
            let thinking = '';
            let thinkingOpen = false;
            const toolCalls: Array<{ index: number; id?: string; name?: string; arguments?: string }> = [];
            let finishReason = '';

            const invalidToolCalls: string[] = [];
            const partial = (strict = false) => {
              const content: AssistantMessage['content'] = [];
              if (thinking) content.push({ type: 'thinking', thinking });
              if (text) content.push({ type: 'text', text });
              for (const toolCall of toolCalls) {
                if (!toolCall.id || !toolCall.name) continue;
                let argumentsValue: Record<string, unknown> = {};
                try {
                  argumentsValue = toolCall.arguments ? JSON.parse(toolCall.arguments) : {};
                } catch {
                  // 流式中途参数未完整属正常；最终消息仍无法解析时拒绝执行，绝不以 {} 调用工具。
                  if (strict) {
                    invalidToolCalls.push(toolCall.name);
                    continue;
                  }
                }
                content.push({ type: 'toolCall', id: toolCall.id, name: toolCall.name, arguments: argumentsValue });
              }
              return { ...startMessage, content };
            };
            // pi-agent-core 只在收到 start 之后才转发 text_delta / thinking_delta（message_update）；
            // 不发 start，面板就收不到任何增量，只能等整段回复结束才一次性出现。
            const ensureStarted = () => {
              if (started) return;
              started = true;
              stream.push({ type: 'start', partial: partial() });
            };

            for await (const event of readSseEvents(response)) {
              arm('idle');
              const data = event.data.trim();
              if (!data || data === '[DONE]') continue;
              let json: { choices?: Array<{ delta?: Record<string, unknown>; finish_reason?: string | null }>; usage?: unknown };
              try { json = JSON.parse(data); } catch { continue; }
              usage.feed(json);
              const delta = json.choices?.[0]?.delta || {};
              // DeepSeek / Qwen / vLLM 用 reasoning_content，OpenRouter 等用 reasoning（字符串）。
              const reasoningDelta = typeof delta.reasoning_content === 'string' ? delta.reasoning_content
                : typeof delta.reasoning === 'string' ? delta.reasoning : '';
              if (reasoningDelta) {
                ensureStarted();
                emitted = true;
                if (!thinkingOpen && !thinking) {
                  thinkingOpen = true;
                  stream.push({ type: 'thinking_start', contentIndex: 0, partial: partial() });
                }
                thinking += reasoningDelta;
                stream.push({ type: 'thinking_delta', contentIndex: 0, delta: reasoningDelta, partial: partial() });
              }
              if (typeof delta.content === 'string' && delta.content) {
                ensureStarted();
                emitted = true;
                if (thinkingOpen) {
                  thinkingOpen = false;
                  stream.push({ type: 'thinking_end', contentIndex: 0, content: thinking, partial: partial() });
                }
                text += delta.content;
                stream.push({ type: 'text_delta', contentIndex: thinking ? 1 : 0, delta: delta.content, partial: partial() });
              }
              const toolCallsDelta = delta.tool_calls;
              if (Array.isArray(toolCallsDelta)) {
                emitted = true;
                for (const piece of toolCallsDelta as Array<Record<string, unknown>>) {
                  const index = Number(piece?.index ?? 0);
                  const current = toolCalls[index] || { index };
                  const fn = piece?.function as Record<string, unknown> | undefined;
                  if (typeof piece?.id === 'string') current.id = piece.id;
                  if (typeof fn?.name === 'string') current.name = fn.name;
                  if (typeof fn?.arguments === 'string') current.arguments = (current.arguments || '') + fn.arguments;
                  toolCalls[index] = current;
                }
              }
              if (json.choices?.[0]?.finish_reason) finishReason = json.choices[0].finish_reason;
            }
            clearTimeout(stallTimer);
            commitStreamUsage(usageMeta, usage, 'ok');
            if (thinkingOpen) {
              thinkingOpen = false;
              stream.push({ type: 'thinking_end', contentIndex: 0, content: thinking, partial: partial() });
            }
            const finalMessage = partial(true);
            if (invalidToolCalls.length) {
              const truncated = finishReason === 'length' ? '，输出被 max_tokens 截断' : '';
              throw new Error('模型返回的工具参数不完整或不是合法 JSON（' + invalidToolCalls.join('、') + truncated + '），未执行任何工具，画布未改动。');
            }
            const tokens = usage.result();
            const message: AssistantMessage = {
              ...finalMessage,
              ...(tokens ? { usage: {
                ...EMPTY_USAGE,
                input: Math.max(0, tokens.inputTokens - (tokens.cachedInputTokens ?? 0)),
                output: tokens.outputTokens,
                cacheRead: tokens.cachedInputTokens ?? 0,
                totalTokens: tokens.totalTokens,
              } as AssistantMessage['usage'] } : {}),
              stopReason: finishReason === 'tool_calls' ? 'toolUse' : finishReason === 'length' ? 'length' : 'stop',
              timestamp: Date.now(),
            };
            stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'length' | 'toolUse', message });
            stream.end(message);
            return;
          } catch (error) {
            clearTimeout(stallTimer);
            // 卡住检测触发的 abort 会让 fetch / reader 抛 AbortError，这里换回真正的原因。
            const cause = stall && !userSignal?.aborted ? stall : error;
            if (userSignal?.aborted || emitted || attempt >= limits.retries || !isTransient(cause)) {
              commitStreamUsage(usageMeta, usage, streamOutcome(cause, userSignal));
              throw cause;
            }
            const wait = cause instanceof RetryableHttpError && cause.retryAfterMs !== undefined
              ? cause.retryAfterMs
              : limits.retryBaseMs * 2 ** attempt;
            await sleep(wait, userSignal);
          }
        }
      } catch (error) {
        const aborted = Boolean(userSignal?.aborted);
        // 上下文溢出要在 displayError 之前识别：它会把 HTTP 400 统一翻成「参数不被接受」，丢掉溢出证据。
        const overflow = !aborted && classifyAgentRequestFailure(error instanceof Error ? error.message : String(error)) === 'context_overflow';
        const message: AssistantMessage = {
          ...startMessage,
          stopReason: aborted ? 'aborted' : 'error',
          // 用户停止不是错误：不把 "signal is aborted without reason" 这类底层文案写进会话。
          errorMessage: aborted ? AGENT_ABORTED_MESSAGE : overflow ? AGENT_CONTEXT_OVERFLOW_MESSAGE : displayError(error),
          timestamp: Date.now(),
        };
        stream.push({ type: 'error', reason: aborted ? 'aborted' : 'error', error: message });
        stream.end(message);
      } finally {
        userSignal?.removeEventListener('abort', onUserAbort);
      }
    })();
    return stream;
  };
}

// ---------------------------------------------------------------------------
// 工具：复用命令面（与本机 Agent / MCP / DSH 同源：tools/iris/agent-tools.js）
// ---------------------------------------------------------------------------

export interface AgentAskRequest {
  /** 兼容旧契约（omp ask）：一个 HTML <form>，控件必须带 name。 */
  html?: string;
  /** 结构化提问（推荐）：宿主直接渲染成受控表单。 */
  form?: AgentAskForm;
}

export type AgentAskResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: string }
  | { ok: false; cancelled: true };

/** 自动转后台的运行先等多久（期间完成就照常返回结果）。 */
export const BACKGROUND_INLINE_WAIT_MS = 20_000;
/** node.run 一次跑这么多个节点以上就转后台。 */
export const BACKGROUND_MIN_BATCH = 4;

/**
 * 哪些调用会跑好几分钟、应该走后台任务（P2-G）：视频生成（generate run=true 的视频节点、包含视频节点的 node.run）、
 * 整组运行、≥BACKGROUND_MIN_BATCH 个节点的批量运行。只写不跑的 generate、单张图片运行仍走同步路径。
 */
export function shouldRunInBackground(command: string, args: Record<string, unknown>, nodes: readonly WorkflowNode[]): boolean {
  if (!BROWSER_TASKABLE_COMMANDS.includes(command)) return false;
  const byId = new Map(nodes.map(node => [node.id, node]));
  if (command === 'workflow.group.run') return true;
  if (command === 'workflow.generate') {
    if (args.run !== true && args.run !== 'true') return false;
    if (args.dryRun === true || args['dry-run'] === true) return false;
    const target = typeof args.nodeId === 'string' ? byId.get(args.nodeId.trim()) : undefined;
    return args.type === 'video' || target?.type === 'video';
  }
  if (command === 'workflow.node.run') {
    const raw = args.nodeIds ?? args.nodeId;
    const ids = (Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? raw.split(',') : []).map(id => id.trim()).filter(Boolean);
    if (ids.length >= BACKGROUND_MIN_BATCH) return true;
    return ids.some(id => byId.get(id)?.type === 'video');
  }
  return false;
}

/** 命令失败时交给模型的说明：错误码 + 消息 + 结构化 details（截断），让模型据此修正，而不是只看到一句话。 */
function describeCommandError(command: string, result: { error?: { code?: string; message?: string; details?: Record<string, unknown> } }): string {
  const message = result.error?.message || `${command} 执行失败`;
  const code = result.error?.code;
  const details = result.error?.details;
  if (!code && !details) return message;
  let detailText = '';
  if (details && Object.keys(details).length) {
    try {
      detailText = JSON.stringify(details);
      if (detailText.length > 1500) detailText = detailText.slice(0, 1500) + '…';
    } catch {
      detailText = '';
    }
  }
  return message + (code ? '\n[' + code + ']' : '') + (detailText ? ' details=' + detailText : '');
}

export interface BrowserAgentToolDependencies {
  projectId: string;
  /** 高风险操作（删除、付费、Production 运行等）的用户确认；返回 false 表示拒绝 */
  confirm: (summary: string, request?: AgentConfirmRequest) => Promise<AgentConfirmVerdict>;
  /** 结构化提问；提供时注册 iris_ask（与 omp ask 的 HTML form 契约一致） */
  ask?: (request: AgentAskRequest) => Promise<AgentAskResult>;
  /** 当前 Agent 回合的幂等键（可逆写操作合并进同一 ChangeSet） */
  activeChangeSetId: string;
  /** 读取当前画布节点；提供时注册 iris_workflow_media_view，让 Agent 看图片/视频的真实画面 */
  getNodes?: () => readonly WorkflowNode[];
  /** DeepSeek 搜索凭证；提供时注册 iris_web_search */
  webSearch?: AgentSearchCredential;
  /**
   * 当前审批上下文（模式、用户按工具策略、会话授权、是否无人值守）。
   * 未提供时 fail closed：按 always-ask 处理、没有任何授权（与 OMP 一致）。
   */
  getApproval?: () => ApprovalContext;
  /** 自动转后台的运行先等多久再交回 taskId（测试用；缺省 BACKGROUND_INLINE_WAIT_MS）。 */
  backgroundInlineWaitMs?: number;
}

const FAIL_CLOSED_APPROVAL: ApprovalContext = { mode: 'always-ask' };

export function createBrowserAgentTools(dependencies: BrowserAgentToolDependencies): AgentTool[] {
  const workflowContract = createBrowserWorkflowContract();
  // 调用前先过审批层：deny 直接拒绝；prompt 时先问用户。命令面自己会带计划确认的（删除、付费），
  // 交给命令面问，避免同一次调用弹两张卡；无人值守回合里 prompt 已在解析时转为 deny。
  const guard = async (command: string, params: Record<string, unknown>) => {
    const context = dependencies.getApproval?.() ?? FAIL_CLOSED_APPROVAL;
    const decision = toolApprovalFor(command, params);
    const resolution = resolveToolApproval({ ...context, tool: command, decision });
    if (resolution.action === 'deny') throw new Error(resolution.reason);
    if (resolution.action === 'allow') return;
    if (workflowCommandNeedsConfirmation(command, params)) return;
    const approved = await dependencies.confirm(resolution.reason || command, {
      kind: resolution.hardGate === 'delete' ? 'destructive' : 'other',
      command,
      args: params,
      tier: resolution.tier,
      tool: command,
      grantable: resolution.grantable,
      ...(resolution.reason ? { reason: resolution.reason } : {}),
    });
    const verdict = readConfirmVerdict(approved);
    if (!verdict.approved) throw new Error(verdict.message);
  };
  // 命令面工具共用的一次调用：策略层 → 浏览器契约 → 需要时请用户确认后带批准重发。
  const runCommand = async (command: string, params: Record<string, unknown>) => {
    const envelope = {
      id: crypto.randomUUID(),
      command,
      args: {
        ...params,
        projectId: dependencies.projectId,
        workspaceMode: 'browser',
      },
      source: 'agent',
      idempotencyKey: dependencies.activeChangeSetId,
    } as const;
    await guard(command, params);
    let result = await workflowContract.dispatch(envelope);
    if (result.confirmation?.required) {
      // 命令面的确认都是安全覆盖（付费 / 删除）：只能逐次批准（付费可由付费授权覆盖），不提供会话授权。
      const decision = toolApprovalFor(command, params);
      const approved = await dependencies.confirm(result.confirmation.summary, {
        ...workflowConfirmRequest(envelope),
        tier: decision.tier,
        tool: command,
        grantable: false,
        ...(decision.reason ? { reason: decision.reason } : {}),
      });
      // 生成计划卡的「创建后手动生成 / 调整后再创建」带一句说明：Agent 据此不重试、不重复建节点。
      const verdict = readConfirmVerdict(approved);
      if (!verdict.approved) throw new Error(verdict.message);
      result = await workflowContract.dispatch(withWorkflowHumanApproval(envelope));
    }
    if (!result.ok) {
      throw new Error(describeCommandError(command, result));
    }
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result.result ?? { ok: true }) }],
      details: result,
    };
  };
  // 后台任务（iris_task_start / get / cancel）：与外部宿主同一份定义，命令清单收窄到浏览器能执行的。
  const tasks = browserAgentTaskLayer(dependencies.projectId, envelope => workflowContract.dispatch(envelope));
  /**
   * 启动一个后台任务：先在本回合完成审批（策略层 + 付费确认卡），批准后才进后台，立即返回任务视图。
   * iris_task_start 与自动转后台（P2-G）共用这一条路径。
   */
  const startTask = async (target: string, args: Record<string, unknown>): Promise<{ task: Record<string, unknown> } | { immediate: { content: Array<{ type: 'text'; text: string }>; details: unknown } }> => {
    const asResult = (value: unknown) => ({ immediate: { content: [{ type: 'text' as const, text: JSON.stringify(value) }], details: value } });
    if (!BROWSER_TASKABLE_COMMANDS.includes(target)) throw new Error('不能放到后台的命令：' + (target || '(空)') + '。可用：' + BROWSER_TASKABLE_COMMANDS.join('、'));
    // 同一回合里对同一命令、同一参数的重试重放同一个任务：不再弹卡，也不会重复提交生成。
    // 键用稳定的参数哈希（与键顺序无关），回合 ID 只用来限定重放范围；跨回合 / 刷新后的重复由台账按参数哈希拦截。
    const idempotencyKey = (dependencies.activeChangeSetId || 'turn') + ':' + target + ':' + taskArgsHash(target, args);
    const replay = await tasks.existing(idempotencyKey);
    if (replay) return asResult(replay);
    // 同参数任务还在跑（或刷新前已开始、提交状态未知）：不再提交。刷新前的那种要用户明确确认才重新提交。
    const duplicate = await tasks.inflight({ command: target, args });
    let resubmit = false;
    if (duplicate && !duplicate.resubmitRequiresConfirmation) return asResult(duplicate);
    if (duplicate) {
      const verdict = readConfirmVerdict(await dependencies.confirm('同样参数的任务在刷新页面前已经开始，可能已经提交给模型服务并扣费，当前无法确认结果。仍要重新提交一次吗？', {
        kind: 'other',
        command: target,
        args,
        tool: target,
        grantable: false,
        reason: '可能重复扣费',
      }));
      if (!verdict.approved) return asResult(duplicate);
      resubmit = true;
    }
    await guard(target, args);
    let approved = false;
    if (workflowCommandNeedsConfirmation(target, args)) {
      const envelope = { id: crypto.randomUUID(), command: target, args: { ...args, projectId: dependencies.projectId, workspaceMode: 'browser' }, source: 'agent' } as const;
      const probe = await workflowContract.dispatch(envelope);
      if (!probe.ok) throw new Error(describeCommandError(target, probe));
      if (probe.confirmation?.required) {
        const decision = toolApprovalFor(target, args);
        const verdict = readConfirmVerdict(await dependencies.confirm(probe.confirmation.summary, {
          ...workflowConfirmRequest(envelope),
          tier: decision.tier,
          tool: target,
          grantable: false,
          ...(decision.reason ? { reason: decision.reason } : {}),
        }));
        if (!verdict.approved) throw new Error(verdict.message);
        approved = true;
      } else {
        // 命令面没有要求确认就已经执行完了（不会发生在付费命令上）：直接交回结果，不再重复执行。
        return { immediate: { content: [{ type: 'text' as const, text: JSON.stringify({ done: true, status: 'succeeded', result: probe.result ?? { ok: true } }) }], details: probe } };
      }
    }
    return { task: await tasks.start({ command: target, args, idempotencyKey, approved, resubmit }) };
  };
  const projectNodes = (): readonly WorkflowNode[] => dependencies.getNodes?.()
    ?? useWorkflowStore.getState().projects.find(project => project.id === dependencies.projectId)?.nodes
    ?? [];
  const inlineWaitMs = dependencies.backgroundInlineWaitMs ?? BACKGROUND_INLINE_WAIT_MS;
  /**
   * P2-G：视频生成、整组运行、大批量运行可能要几分钟。这些调用即使模型直接用 node_run / generate(run=true)，
   * 也自动走后台任务（与 iris_task_start 同一审批、同一台账、刷新后可续）：先等 inlineWaitMs，
   * 期间完成就照常把结果交回（与同步调用相同）；还没完成就交回 taskId，不再把这一轮卡住几分钟。
   */
  const runInBackground = async (command: string, input: Record<string, unknown>) => {
    const started = await startTask(command, input);
    if ('immediate' in started) return started.immediate;
    const task = started.task;
    const taskId = String(task.taskId || '');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = await Promise.race([
      tasks.settled(taskId).then(() => true, () => true),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), inlineWaitMs); }),
    ]);
    if (timer) clearTimeout(timer);
    if (settled) {
      const view = await tasks.get({ taskId });
      if (view.status === 'succeeded') {
        const value = view.result ?? { ok: true };
        return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], details: { ok: true, result: value, taskId } };
      }
      const failure = view.error as { code?: string; message?: string; details?: unknown } | undefined;
      throw new Error((failure?.message || command + ' 执行失败') + (failure?.code ? '（' + failure.code + '）' : '') + '；taskId=' + taskId);
    }
    const promoted = {
      ...task,
      backgrounded: true,
      note: '这是可能要几分钟的付费运行，已自动转到后台（taskId=' + taskId + '）。先告诉用户已开始，之后用 iris_task_get 查进度，不要在同一轮里高频轮询，也不要重复提交。',
    };
    return { content: [{ type: 'text' as const, text: JSON.stringify(promoted) }], details: promoted };
  };
  // 工具名、说明与参数 Schema 全部来自统一 Agent 工具定义（与本机 Agent / MCP / DSH 同一份）；
  // projectId 由内置 Agent 注入，不让模型填。
  const commandTools: AgentTool[] = getAgentToolSpecs('builtin')
    .filter(spec => AGENT_BROWSER_COMMANDS.includes(spec.command))
    .map(spec => {
      const command = spec.command;
      const schema = agentToolInputSchema(spec, { omit: ['projectId'] }) as { properties: Record<string, Record<string, unknown>> } & Record<string, unknown>;
      let description = spec.description;
      const family = WORKFLOW_NODE_TOOL_FAMILY_COMMANDS[command];
      if (family) description += '先用 inspect 拿到节点 ID。可用工具：\n' + describeWorkflowNodeTools(family);
      return {
        name: spec.name,
        label: command,
        description,
        parameters: Type.Unsafe(schema),
        execute: async (_toolCallId, params, _signal) => {
          const input = { ...(params as Record<string, unknown>) };
          if (command === 'workflow.video.tool' && input.tool === 'video-merge' && !input.nodeId && Array.isArray(input.sourceNodeIds)) input.nodeId = input.sourceNodeIds[0];
          if (shouldRunInBackground(command, input, projectNodes())) return runInBackground(command, input);
          return runCommand(command, input);
        },
      };
    });
  const taskTools: AgentTool[] = getAgentToolSpecs('builtin')
    .filter(spec => spec.command.startsWith('agent.task.'))
    .map(spec => {
      const command = spec.command;
      const schema = agentToolInputSchema(spec) as { properties: Record<string, Record<string, unknown>> } & Record<string, unknown>;
      let description = spec.description;
      if (command === 'agent.task.start') {
        schema.properties.command = { ...schema.properties.command, enum: [...BROWSER_TASKABLE_COMMANDS] };
        description = '把可能超过 1 分钟的命令放到后台执行（批量 / 整组生成、视频、导出等），用户确认费用后立即返回 taskId，不必等生成结束；之后用 iris_task_get 查进度（同一轮或下一轮都可以），完成后读 result。可包装：'
          + BROWSER_TASKABLE_COMMANDS.join('、') + '。确认、付费授权与提交前检查与直接调用相同。任务写入本地台账，刷新页面后仍可 get / cancel；刷新前已开始、无法确认是否已提交的任务状态为 unknown_submit（可能已扣费），不要自动重跑，先让用户核对画布。';
      }
      return {
        name: spec.name,
        label: command,
        description,
        parameters: Type.Unsafe(schema),
        execute: async (_toolCallId, params) => {
          const input = params as Record<string, unknown>;
          let result: Record<string, unknown>;
          if (command === 'agent.task.start') {
            const target = String(input.command || '');
            const args = input.args && typeof input.args === 'object' && !Array.isArray(input.args) ? { ...(input.args as Record<string, unknown>) } : {};
            const started = await startTask(target, args);
            if ('immediate' in started) return started.immediate;
            result = started.task;
          } else if (command === 'agent.task.get') {
            result = await tasks.get({ taskId: String(input.taskId || ''), afterSeq: typeof input.afterSeq === 'number' ? input.afterSeq : undefined });
          } else {
            result = await tasks.cancel({ taskId: String(input.taskId || ''), ...(typeof input.reason === 'string' ? { reason: input.reason } : {}) });
          }
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], details: result };
        },
      } satisfies AgentTool;
    });
  const extraTools: AgentTool[] = [...taskTools];
  extraTools.push(createWebSearchTool(dependencies.webSearch, guard));
  extraTools.push(createLocalGrepTool(guard));
  if (dependencies.ask) extraTools.push(createAskTool(dependencies.ask));
  if (dependencies.getNodes) extraTools.push(createMediaViewTool(dependencies.getNodes));
  // Cut 视频剪辑页：读写时间线 / 字幕 / 代理 / 导出（实现懒加载，见 services/cut/agentTools.ts）。
  // 与命令面同一个审批层：读放行，写按模式，删除逐次确认，委派回合受 maxTier 限制。
  extraTools.push(...createCutAgentTools({ projectId: dependencies.projectId }).map(tool => ({
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      await guard(tool.name, (params ?? {}) as Record<string, unknown>);
      return tool.execute(toolCallId, params, signal, onUpdate);
    },
  } satisfies AgentTool)));
  return [...commandTools, ...extraTools];
}

function createWebSearchTool(credential: AgentSearchCredential | undefined, guard: (command: string, params: Record<string, unknown>) => Promise<void>): AgentTool {
  const recency = Type.Union([Type.Literal('day'), Type.Literal('week'), Type.Literal('month'), Type.Literal('year')]);
  return {
    name: WEB_SEARCH_TOOL_NAME,
    label: 'web.search',
    description: '联网搜索（Parallel 公共 MCP，免 Key；失败自动回退 DeepSeek）。返回标题、URL、日期与摘要。query 支持 site:、-site:、引号短语、after:/before:；recency 可选 day/week/month/year；limit 1-40，默认 10。用于查资料、竞品、风格与事实核对。',
    parameters: Type.Object({
      query: Type.String({ description: '搜索词，最长 128 字符' }),
      recency: Type.Optional(recency),
      limit: Type.Optional(Type.Number({ description: '结果条数 1-50' })),
    }),
    execute: async (_toolCallId, params, signal) => {
      const input = params as { query: string; recency?: SearchRecency; limit?: number };
      await guard(WEB_SEARCH_TOOL_NAME, input as unknown as Record<string, unknown>);
      const result = await searchAgentWeb({ query: input.query, recency: input.recency, limit: input.limit, signal, credential });
      return {
        content: [{ type: 'text', text: formatSearchSources(result.sources) }],
        details: { provider: result.provider, sources: result.sources },
      };
    },
  };
}

function createLocalGrepTool(guard: (command: string, params: Record<string, unknown>) => Promise<void>): AgentTool {
  return {
    name: LOCAL_GREP_TOOL_NAME,
    label: 'files.grep',
    description: '本地文件搜索（grep）：在用户连接过的本地文件夹里逐行匹配文本文件，返回 [文件夹/路径] 与 *行号|内容。pattern 是正则（非法时按字面量）；path 相对文件夹根目录，可以是子目录或单个文件，";" 分隔多个，可用文件夹名开头限定某一个文件夹，省略或 "." 搜索全部；case=false 忽略大小写；limit 默认 200。path 不存在会报 Path not found（不是“没有匹配”）；没有连接文件夹或权限失效会直接报错。只搜文本文件，单文件上限 512KB，30s 超时。',
    parameters: Type.Object({
      pattern: Type.String({ description: '正则或字面量搜索词' }),
      path: Type.Optional(Type.String({ description: '相对文件夹根目录的子目录或文件，例如 references/shots 或 notes.md；";" 分隔多个；省略表示全部' })),
      case: Type.Optional(Type.Boolean({ description: '是否区分大小写，默认 true' })),
      limit: Type.Optional(Type.Number({ description: '最多返回多少条匹配，默认 200' })),
    }),
    execute: async (_toolCallId, params, signal) => {
      const input = params as { pattern: string; path?: string; case?: boolean; limit?: number };
      await guard(LOCAL_GREP_TOOL_NAME, input as unknown as Record<string, unknown>);
      const result = await grepLocalFolders({
        pattern: input.pattern,
        path: input.path,
        caseSensitive: input.case,
        limit: input.limit,
        signal,
      });
      return {
        content: [{ type: 'text', text: formatGrepMatches(result) }],
        details: {
          matchCount: result.matches.length,
          scannedFiles: result.scannedFiles,
          truncated: result.truncated,
          skippedFolders: result.skippedFolders,
          staleFolders: result.staleFolders,
          missingPaths: result.missingPaths,
          // 范围不存在 / 没有可读文件夹是工具错误，不能和「搜过了没匹配」混在一起。
          ...(result.error ? { isError: true } : {}),
        },
      };
    },
  };
}

export const NODE_TOOL_TOOL_NAMES = Object.freeze({ image: 'iris_image_tool', video: 'iris_video_tool', audio: 'iris_audio_tool' });

/** 画布后处理工具清单，直接来自 Operation 注册表：以后新增的工具不需要再改 Agent。 */
export function describeWorkflowNodeTools(family?: WorkflowNodeToolFamily): string {
  // 与 workflow.node.tool.list 同一份说明书：适用节点、计费、用法。给 family 时只列这一类。
  const billing = { free: '本地处理，免费', paid: '调用 AI 服务，会先请用户确认', llm: '调用你配置的文本 / 视觉模型' } as const;
  return (family ? workflowNodeToolsOfFamily(family) : workflowNodeToolSpecs())
    .map(spec => `- ${spec.tool}：${spec.label}（${spec.inputTypes.join('/')}，${billing[spec.billing]}）${spec.usage ? '；' + spec.usage : ''}`)
    .join('\n') + '\n参数的完整 schema 用 iris_node_tool_list 查。';
}

export const ASK_TOOL_NAME = 'iris_ask';

/** omp ask 的浏览器版：模型给一个 <form>，宿主渲染并回传 JSON。 */
function createAskTool(ask: (request: AgentAskRequest) => Promise<AgentAskResult>): AgentTool {
  const option = Type.Object({
    value: Type.Optional(Type.String({ description: '回传值，缺省用 label' })),
    label: Type.String({ description: '选项标题，最好是一句完整方案，如「15 秒竖屏 9:16，分 3 段」' }),
    description: Type.Optional(Type.String({ description: '方案细节' })),
    recommended: Type.Optional(Type.Boolean({ description: '推荐项，默认选中' })),
  });
  const question = Type.Object({
    id: Type.String({ description: '回传 JSON 的键，字母/数字/下划线，如 duration' }),
    question: Type.String({ description: '中文问题' }),
    type: Type.Optional(Type.Union([Type.Literal('single'), Type.Literal('multi'), Type.Literal('text')], { description: 'single 单选（有 options 时默认）/ multi 多选 / text 自由输入' })),
    options: Type.Optional(Type.Array(option, { description: '最多 8 个；卡片自动带「其他」输入框，不用自己加' })),
    required: Type.Optional(Type.Boolean({ description: '默认 true' })),
    placeholder: Type.Optional(Type.String()),
    multiline: Type.Optional(Type.Boolean()),
  });
  return {
    name: ASK_TOOL_NAME,
    label: 'ask',
    description: '向用户提问并等待回答，返回 { ok, data: { <id>: 答案 } }（多选是数组）。'
      + '用 questions 结构化提问：每题一个 id + 中文 question；single/multi 给 options，选项尽量写成完整方案（时长+画幅+分段这类组合），用 recommended 标推荐项；'
      + '卡片自动提供「其他」输入框。开工前把会改变结果的关键信息一次问齐（同一张卡最多 12 题），不要分多轮追问。'
      + '不要询问 API Key、Token 等秘密。旧的 html 表单参数仍兼容，但不要再用。',
    parameters: Type.Object({
      title: Type.Optional(Type.String({ description: '卡片标题：为什么要问' })),
      context: Type.Optional(Type.Array(Type.String(), { description: '补充说明' })),
      questions: Type.Optional(Type.Array(question)),
      html: Type.Optional(Type.String({ description: '（兼容）one HTML <form> with named controls' })),
    }),
    execute: async (_toolCallId, params) => {
      const input = params as AgentAskSpec & { html?: string };
      let request: AgentAskRequest;
      if (Array.isArray(input.questions) && input.questions.length) {
        const built = buildAgentAskForm(input);
        if ('error' in built) throw new Error(built.error);
        request = { form: built.form };
      } else if (typeof input.html === 'string' && input.html.trim()) {
        request = { html: input.html };
      } else {
        throw new Error('ask 需要 questions（推荐）或 html 表单。');
      }
      const result = await ask(request);
      if (!result.ok && 'cancelled' in result) throw new Error('用户取消了提问。');
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        details: result,
      };
    },
  };
}

export const MEDIA_VIEW_TOOL_NAME = 'iris_workflow_media_view';

function createMediaViewTool(getNodes: () => readonly WorkflowNode[]): AgentTool {
  const frame = Type.Union([Type.Literal('first'), Type.Literal('middle'), Type.Literal('last')]);
  return {
    name: MEDIA_VIEW_TOOL_NAME,
    label: 'workflow.media.view',
    description: '查看图片/视频节点的真实画面：图片缩到长边 ≤1024px。视频默认拼成一张帧网格（每格左上角标 #序号 时间码，左上→右下按时间排列）：'
      + '均匀取 count 帧（默认 9，最多 16），可用 start/end 限定秒数窗口，窗口超过 30s 时分页，用 page 翻页；times 指定任意秒数时按这些秒数拼网格。'
      + '需要单帧大图时用 layout=frames（配合 frames: first/middle/last 或 times）。单次最多 6 张图。'
      + '视频说明里带时长与粗略时间线（采样帧之间的疑似切镜），规划成片时长时先看它。'
      + 'compare=true：把 nodeIds（最多 4 个，图片原图 / 视频帧网格）缩到同一高度并排拼成一张对比图，用来对照参考素材检查产物的风格、角色与构图。',
    parameters: Type.Object({
      nodeIds: Type.Array(Type.String()),
      frames: Type.Optional(Type.Array(frame)),
      times: Type.Optional(Type.Array(Type.Number(), { description: '视频抽帧的秒数列表，例如 [0, 6.5, 13]；给了 times 就忽略 frames。' })),
      layout: Type.Optional(Type.Union([Type.Literal('grid'), Type.Literal('frames')], { description: 'grid（默认）：拼成一张带时间码的帧网格；frames：每帧单独一张图' })),
      count: Type.Optional(Type.Number({ description: '帧网格每页帧数，默认 9，范围 1–16' })),
      start: Type.Optional(Type.Number({ description: '帧网格窗口起点（秒）' })),
      end: Type.Optional(Type.Number({ description: '帧网格窗口终点（秒）' })),
      page: Type.Optional(Type.Number({ description: '窗口超过 30s 时的页码，从 1 开始' })),
      compare: Type.Optional(Type.Boolean({ description: 'true 时把这些节点并排拼成一张对比图（例如参考图 vs 产物帧网格），最多 4 个' })),
    }),
    execute: async (_toolCallId, params) => {
      const { nodeIds, frames, times, layout, count, start, end, page, compare } = params as {
        nodeIds: string[]; frames?: AgentVideoFrame[]; times?: number[]; layout?: AgentVideoLayout;
        count?: number; start?: number; end?: number; page?: number; compare?: boolean;
      };
      const nodes = getNodes();
      const found: WorkflowNode[] = [];
      const missing: string[] = [];
      for (const id of nodeIds) {
        // 多结果的备选不在节点表里，按所属节点还原成临时节点再取画面。
        const resolved = resolveNodeOrAlternate(nodes, id);
        if (resolved) found.push(resolved.node);
        else missing.push(id + '：节点不存在');
      }
      const view = await loadAgentNodeMedia(found, { frames, times, layout, grid: { count, start, end, page }, compare: compare === true });
      const notes = [...view.notes, ...missing];
      const content: Array<{ type: 'text'; text: string } | ImageContent> = [{ type: 'text', text: notes.join('\n') || '没有可查看的画面' }, ...view.images];
      return { content, details: { nodeIds, imageCount: view.images.length } };
    },
  };
}

// ---------------------------------------------------------------------------
// 内核：复刻 agent/kernel.js 的生命周期，浏览器实现（持久化/流/工具）
// ---------------------------------------------------------------------------

export { BROWSER_DEFAULT_SYSTEM_PROMPT };
const BROWSER_DEFAULT_SYSTEM_PROMPT = `你是 Iris Agent，Iris 生成式 AI 图像/视频无限画布（Workflow）里的创作搭档：理解用户的创作目标，把它落成用户当前可见画布上的节点、连线与生成任务，并清楚说明画布还能做什么。

## 你能直接调用的工具
- iris_workflow_inspect：读取当前项目的节点、连线、配置与 revision。处理项目前先调用，不得猜测项目、节点或连接 ID。媒体地址在结果里会被脱敏为 [media]，这不代表节点没有内容。ledger=true 返回项目账本（锚点速查、镜头表、已生成资产索引）：多步任务中途、或觉得记不清已做了什么时先回读它，用锚点编号（A02/S01）指代锚点。结果里的 availableModels 列出图片 / 视频产品模型 id（configured=true 表示已配好线路）：metadata.config.modelId 只能用真实 id（如 flovart:seedream-5-flash），不要自己编，写错会被 apply 拒绝并列出可用 id。
- iris_workflow_selection_get：读取用户当前选中的节点。
- iris_generate：生成图片/视频的唯一入口。只建或复用一个生成节点，prompt 直接写进它的 Prompt Bar，references 同时变成 @chip 与连线（顺序即 chip 顺序），按引用自动选文生/图生/首尾帧/全能参考；run=true 时原位运行（扣费，会请用户确认），返回批次与每张产物。
- iris_shortcut_list / iris_shortcut_apply：Slash 快捷工具（九机位宫格、角色三视图、四格 / 25 格分镜、光影矫正、人像增强）。apply 永远只动一个节点、count=1：宫格类在已有参考的节点上原地出一张宫格图，目标只是一张图时右侧新建一个节点引用它；非宫格类右侧新建一个节点。单格需要时再 image.split-grid@1，不要自己建 N 个节点。
- iris_group_create / iris_group_run：分组框（与生成批次、备选无关）与整组执行（按依赖顺序、只确认一次费用）。
- iris_workflow_search_nodes：按关键字 / 类型 / 锚点编号（A 角色、S 场景、P 道具、T 风格，如 A02）/ 状态（empty/running/done/error）/ 镜号查节点，只返回精简结果并分页。画布大时先用它定位，再对少数节点 inspect；用户说“A02”“第 3 镜”“失败的视频”时用它解析成节点 id。
- iris_models_list：列出模型的真实能力（各生成方式是否已配置、参考上限、张数、比例、分辨率、时长，含 RunningHub 动态模型）。选/换模型前先调，不要猜 modelId 或逐个试。
- iris_cost_estimate：运行前预估（只读、不扣费）：nodeIds 或 groupId → 每个节点的模型、任务数、预估费用与合计，以及被提交前检查拦下的节点。多个节点或整组运行前先调用，把清单与合计告诉用户再请求运行；cost 为 null 就说费用未知（costHint 说明原因），只报 costTier 档位，不要自己估金额。
- iris_workflow_node_run：重跑已写好提示词的生成节点（nodeId 或 nodeIds 批量，一次确认费用），返回 batch 与 takes。
- iris_task_start / iris_task_get / iris_task_cancel：多个镜头、整组或视频生成可能要几分钟，用 iris_task_start 包装 workflow.node.run / workflow.group.run 等放到后台（确认费用后立即返回 taskId），先告诉用户已开始，再用 iris_task_get 查进度；不要在同一轮里高频轮询，用户问进度或下一轮再查。视频生成、整组运行、4 个以上节点的批量运行即使直接调用 node_run / generate(run=true) 也会自动转后台：结果里有 backgrounded:true 和 taskId 时按后台任务处理，不要重复提交。
- iris_workflow_node_stop：停止某个节点正在进行的生成。
- iris_media_import：把 http(s) 地址或素材库素材导入画布成为媒体节点，可直接接到生成节点作参考（加 @chip）。
- iris_script_materialize：把脚本节点的分镜行建成生成节点（kind=image|video，rows=1-5 / 1,3,6-9）。每行一个生成节点，行里的 imagePrompt/videoPrompt 写进 Prompt Bar，characterRefs 与 @ref:<id> 变成 @chip + 连线，脚本行回存节点 id。只建不跑：确认后把返回的 nodeIds 交给 iris_workflow_node_run 分批运行。
- iris_export：用户要"导出/下载/打包"时用。单个媒体节点导出原文件，多个节点或分组（groupId）打 ZIP，脚本节点导出分镜 CSV；会保存到用户本机，不改画布。
- iris_note_write：写给人看的备注（文本节点）。只在用户明确要求写备注时使用；备注不连线、不参与生成。
- iris_workflow_apply：结构化修改画布（移动、连线、分组、改标题、调整参考顺序 reorder_connections 等）。operations 只允许 add_node、create_connected_node、update_node、delete_nodes、delete_connections、connect_nodes、move_nodes、reorder_nodes、reorder_connections、group_nodes、ungroup_nodes、set_batch_primary。不要用它建文本节点。新节点可以不写 id（系统生成，结果的 affectedNodeIds 带回）。一次生成多张时，第 2–N 张是首图节点上的备选（inspect 里的 alternateIds），不是独立节点：media_view 可以直接看备选 id；要把它们拆成画布上的独立节点，用 ungroup_nodes（ids 给首图节点 id 拆全部，给备选 id 只拆这几张）；set_batch_primary 把某张备选设为首图。
- iris_image_tool / iris_video_tool / iris_audio_tool：在图片 / 视频 / 音频节点上执行后处理工具（裁剪、放大、去背景、扩图；剪辑、截帧、音视频分离、拼接；音频剪辑、变速、变调、分离），结果作为新节点写回画布。参数不确定时先用 iris_node_tool_list 查。
- iris_ask：需要用户在几个方案里做选择或补充关键信息时，用 questions 结构化提问（每题 id + question；single/multi 给 options，选项写成完整方案并用 recommended 标推荐；text 收自由输入；卡片自带「其他」输入框）。开工前把会改变结果的信息一次问齐（见 Skill 的「开工前问齐」清单），不要分多轮追问；不要用它询问 API Key、Token 等秘密，也不要在正文里堆长问题让用户再回一轮。
- iris_workflow_media_view：查看图片/视频节点的真实画面（nodeIds）。视频默认返回一张带时间码的帧网格（count 帧数、start/end 窗口、长视频用 page 翻页；times: [秒数] 指定时间点）；需要单帧大图用 layout=frames。inspect 里的 [media] 只是脱敏占位；需要判断构图、风格或检查生成结果时调用它。视频说明里有时长和粗略时间线（疑似切镜位置），规划成片时长前先看源片；compare=true 把参考图和产物（图片或帧网格）并排拼成一张，检查风格/角色是否贴合源素材时用它。用户 @引用的图片/视频会自动附带画面。用户粘贴的截图、拖入的视频会作为本轮图片内容直接附上。
- iris_web_search：联网搜索（Parallel 公共 MCP，免 Key，失败回退 DeepSeek）。需要外部资料、竞品信息、风格参考或事实核对时调用；结果给出来源 URL，引用时要带上。
- iris_grep：在用户连接过的本地文件夹里搜文本文件（正则）。用户说“我本地的素材/文档里有…”时先用它；只能搜已授权文件夹，读不到任意路径。
- iris_skill_read：读取技能（Skill）的完整说明（id，可选 file 读 references/、commands/ 下的文件，长文件用 offset 翻页）。任务与下方技能索引里的某个技能匹配时先读再做。
- iris_memory：项目记忆（add/list/search/delete，只属于当前项目）。用户说“记住…”、或确认了以后还要沿用的偏好 / 设定（风格、角色/产品设定、画幅、时长、选定的模型或费用档位）时，当轮就写入一句事实，不要等到最后；长任务进行中上下文会被压缩，没写进记忆的已确认事实会丢。不要写入密钥、Token、密码或一次性过程。
${CUT_TOOL_DOCS}
command.list/schema 属于 CLI discovery/debug，不是你的工具；不得访问 Shell、任意文件或 Provider Secret。

## 画布能力地图
节点类型：image、video、audio（媒体与生成节点）、text（备注，只给人看）、script（剧本/分镜表）、design、subgraph（逆向子画布框），插件可扩展自定义类型。没有 operation 中间节点：生成与后处理的结果直接是 image / video / audio 结果节点，输入节点直接连线到结果；能力、参数、模型与多次结果（takes）记在结果节点的 metadata.operation 上，对结果节点 iris_workflow_node_run 就是原位重跑这一步。
生成（你可以做）：一律用 iris_generate，一次调用完成“建/复用生成节点 → Prompt Bar 写提示词 → 参考 @引用 + 连线 → 可选运行”。不要先建提示词/文本/配置节点再连到生成节点。
- 图片：生成方式 text-to-image（文生图）或 image-to-image（图生图，有图片参考时自动选）；可设比例、分辨率、质量、张数 1/2/4（多张折叠成同一批次）。
- 视频：text-to-video、image-to-video（一张图）、first-last-frame（references 里给 first_frame + last_frame）、reference-to-video（多图/视频/音频参考）、video-extension（模型支持时）。
- 参考角色（references[].role）：first_frame、last_frame、reference、character、style、mask、source_video、source_audio。
- prompt 里用 @ref:<节点id> 或 @"节点名" 指代参考；引用到的没连线节点会自动连上（结果 autoLinked），名字重名会报 AMBIGUOUS_NODE_NAME 并列出候选；断开连线会同时清掉下游 Prompt Bar 的 chip（结果 prunedMentions）。
- 建与跑分开：多个镜头先用 iris_generate（不传 run）全部建好，再把这批 nodeIds 交给 iris_workflow_node_run（别名 iris_approve_run），用户一张审批卡确认一次，每个节点各跑一次。
- 运行会阻塞到终态再返回，不要轮询 inspect；终态只有 succeeded / failed / timeout / unknown_after_submit，timeout 先 inspect，unknown_after_submit 可能已计费，禁止重试。
- 模型或线路不支持某个生成方式、参考数量超限时会返回 MODE_UNSUPPORTED / REFERENCE_COUNT_OUT_OF_RANGE / REFERENCE_LIMIT 与 candidates（可直接用的模型+模式）：按 min/max/got 补删参考或换 candidates 里的组合，不要逐个盲试、不要假装成功。
- 当前没有音频生成和独立的文本生成工具；不要承诺。

媒体后处理工具（图片用 iris_image_tool、视频用 iris_video_tool、音频用 iris_audio_tool 直接执行，与节点工具条按钮同一实现；用户想自己点时，再说明在哪个节点上点哪个按钮）：
- 图片：裁剪、高清放大（长边 512-8192）、去背景、拆分图层、AI 编辑（编辑/扩图/局部重绘/标注/重打光，需提示词）、旋转/镜像、宫格切分（1-6 行列）、图层贴纸、矢量化（SVG）、滤镜、反推 Prompt（图片或视频首帧，结果写回该节点的 prompt）。
- 视频：视频剪辑（起止秒）、音视频分离（完整音轨/人声/背景音，输出无声视频 + 音频节点）、视频拼接（按顺序 ≥2 段）、截取首帧/尾帧/任意秒数的帧（position=current + currentTimeSec，输出图片节点，可直接作为下一段的 first_frame 做续镜）。只想看画面用 media_view，需要把帧留在画布上用 node_tool。
- 音频：音频剪辑、变速（0.25-4×）、人声/伴奏分离。
- 工具栏菜单可开启「新视频自动截首帧 / 尾帧 / 自动音视频分离」。
其中本地处理（裁剪、旋转、宫格、剪辑、分离、拼接、截帧、变速）不花费额度；放大、去背景、AI 编辑、扩图、局部重绘、拆图层、图层贴纸会调用模型服务。

其他工作台（只能引导用户操作）：
- Cut（顶部第二个 tab，原名「逆向」）：视频剪辑页（时间线、字幕、快捷键、代理、导出 MP4 回画布），用上面的 iris_cut_* 工具直接读写。其中「故事版 · 逆向」子页保留以前的逆向视频拆解，结果以 subgraph 子画布留在 Workflow 里；你可以读取子画布里的镜头节点继续加工，但不能改逆向工程本身。
- 逆向游戏美术素材：当前版本没有这个功能，不要承诺；可以用图生图、宫格切分、去背景、拆分图层组合出类似流程。
- 素材库、网络图片：用 iris_media_import 导入（url 或 assetId），可直接接到生成节点作参考；本地文件夹与历史仍由用户从侧栏插入画布，你再通过 inspect 按节点 ID 使用。
- 本地 Agent 连接：在 Agent 抽屉的「连接」里选择 Codex、WorkBuddy 等本机 Agent；外部 Agent 通过 Iris CLI/MCP 操作同一张画布，还能调用节点后处理工具。
- 第三方 API 接入：设置 → API Key 内置五种协议入口（OpenAI compatible、Gemini、火山 Seedance、RunningHub、自定义配置）。其他服务选「自定义配置」并绑定适配脚本（受限 JSON mapping：请求地址/鉴权/请求体/响应映射，不执行任意 JS）。用户需要时你可以按其接口文档起草脚本 JSON，由用户在「自定义配置」里粘贴保存；不得索取或回显密钥。

## 工作规则
默认只操作当前已绑定的可见 Browser Workflow；没有 Browser binding 时必须显式失败，不能切换到 Native、隐藏图或从 React/localforage 读取 Workflow 图，也不能自行解析 Provider。
生成只用 iris_generate（或对已写好提示词的节点用 iris_workflow_node_run），其余修改用 iris_workflow_apply 的结构化 operations，全部交给同一个 WorkflowExecutor；不得模拟鼠标、直接改 React state，或用 CLI、文件桥在后台另做一份结果。
文本节点是备注：绝不用它承载提示词、剧本、分镜或 prompt_context，也不要把它连到任何节点；用户明确要求写备注时才用 iris_note_write。改已有节点的提示词也用 iris_generate（不传 run、也不传 references），节点已有的参考、顺序与用途原样保留；结果 model.submode 与 references 和你预期不符、或有 warnings 时先修正，不要运行。多参考时给每个参考写 purpose（subject 主体 / style 风格 / background 背景…），不要只靠「图片1/图片2」的编号表达用途。
写操作使用稳定的 idempotencyKey；只有工具返回成功后，才能声称画布已变化。可逆修改直接落到用户可见的同一 Workflow 并合并为本轮 ChangeSet，每次修改后读取返回的 draftVersion/objectVersions 再继续：返回的 draftVersion 已是所有内部写入（含运行）之后的最终版本，直接作为下一次 expectedRevision。
费用：用户没指定模型时，先用 iris_models_list 的 costTier 给出一个省钱档（cheap）和一个质量档（premium/standard）的模型让用户选，说明差别；有 priceRange 时报真实单价。
删除、付费执行、Production 审批和运行会要求用户确认，不得绕过；普通可逆布局和节点编辑无需逐次确认。没有用户确认的 Production Mandate 时不得声称付费制作已经开始。

## 制作循环（每一步都落在可见 Workflow 上）
1. 澄清：缺少时长、画幅、风格、字幕语言或主体参考时，一次性列出缺口并给出建议默认值，等用户回答；信息足够时直接继续。
2. 锚点：用 iris_generate 建立角色/产品/场景锚点生成节点（如三视图、主视觉）并运行；请用户确认后用 update_node 写入 anchor: { kind, approved: true }；未确认前不要拆镜。
3. 拆镜：锚点确认后，每个镜头调用一次 iris_generate（type=image 或 video，不传 run）：镜头画面写进 prompt，锚点放进 references（已批准锚点有短编号 A01 角色 / S01 场景 / P01 道具 / T01 风格，nodeId、references、prompt 里的 @A01 都可直接用编号，重拍某镜用 nodeId=shot:N），只需要图片局部（人脸、产品细节）时给该参考加 region:{x,y,w,h}（0-1），运行前自动裁剪，不要建裁剪节点；镜号/时长/场景/机位/台词写进 shot: { index, durationSec, scene, camera, dialogue }。镜头先后用 shot.index 表示，不要用镜头之间的连线表示顺序，也不要建文本节点写分镜。
4. 批量生成：互不依赖的镜头节点用 iris_workflow_node_run 的 nodeIds 一次提交，由用户一次确认费用；有依赖的节点（如需要上一镜尾帧）等上游成功后再运行。多张结果在同一节点折叠成批次，返回的 takes 是全部产物。
5. 汇报：按节点标题说明成功与失败；失败只重跑失败节点，不整批重跑。需要后处理时，指明节点和对应工具按钮。
6. 失败处理：工具结果 ok:false 时读 error.code 决定改写提示词、重试或停下说明，预算不足或会话暂停时不得重试。
绑定 Production Skill 时，镜头语言、风格和节奏以 Skill 为准；与用户要求冲突时以用户为准并说明。
Web 模式下 Production Runtime 不可用，production 相关命令会失败并返回明确错误；此时改用 Workflow 节点工具完成可逆编排。`;

const PRODUCTION_SKILL_BINDING_ENTRY = 'flovart.production-skill-binding';

/** 分支切片：保留到指定 entry（含）为止；找不到返回 null。 */
export function entriesUpTo<T extends { id: string }>(entries: readonly T[], entryId: string): T[] | null {
  const index = branchEntryIndex(entries, [entryId]);
  return index < 0 ? null : entries.slice(0, index + 1);
}

/** 分支点定位：先按 entry id，再按消息 id；candidates 从最想用的开始。 */
export function branchEntryIndex(
  entries: readonly { id: string; message?: unknown }[],
  candidates: readonly string[],
): number {
  for (const candidate of candidates) {
    const direct = entries.findIndex(entry => entry.id === candidate);
    if (direct >= 0) return direct;
    const byMessage = entries.findIndex(entry => (entry.message as { id?: string } | undefined)?.id === candidate);
    if (byMessage >= 0) return byMessage;
  }
  return -1;
}

function snapshotMessage(entry: { type: string; id: string; message?: AgentMessage; customType?: string }): {
  id: string;
  role: string;
  text: string;
  thinking?: string;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  timestamp?: number;
  error?: string;
  aborted?: boolean;
  /** 上下文压缩分隔条：压缩前的 token 估算（0 表示未知）。 */
  compaction?: { tokensBefore: number };
  /** 用户消息附带的图片块（本地附件在前、节点画面在后），面板据「已附带画面」备注挑出本地附件做缩略图。 */
  images?: Array<{ mimeType: string; data: string }>;
} {
  const message = entry.message;
  if (message && message.role === 'toolResult') {
    return {
      id: entry.id,
      role: 'tool',
      text: textBlocks(message),
      toolName: (message as { toolName?: string }).toolName,
      toolCallId: (message as { toolCallId?: string }).toolCallId,
      isError: Boolean((message as { isError?: boolean }).isError),
      timestamp: (message as { timestamp?: number }).timestamp,
    };
  }
  const thinking = message?.role === 'assistant' ? thinkingBlocks(message) : '';
  return {
    id: entry.id,
    role: message?.role ?? 'message',
    text: message ? textBlocks(message) : '',
    ...(thinking ? { thinking } : {}),
    timestamp: message ? (message as { timestamp?: number }).timestamp : undefined,
    ...(message?.role === 'user' ? userImageBlocks(message) : {}),
    ...((message as { stopReason?: string } | undefined)?.stopReason === 'aborted'
      // 用户停止：统一显示「已中止」（旧会话里存的可能是 "signal is aborted without reason"）。
      ? { aborted: true, error: AGENT_ABORTED_MESSAGE }
      : { error: (message as { errorMessage?: string } | undefined)?.errorMessage }),
  };
}

/**
 * 会话的全部 entry（按写入顺序）。浏览器内核不用 moveTo 分叉，entry 天然是一条线；
 * 压缩后 getBranch() 只从保留点开始，面板历史、技能已读列表与分支都要用完整列表。
 */
async function allEntries(session: Session) {
  return (await session.getStorage().getEntries()) as Awaited<ReturnType<Session['getBranch']>>;
}

export interface BrowserAgentKernelOptions {
  projectId: string;
  route: BrowserAgentTextRoute;
  tools: AgentTool[];
  confirm: (summary: string) => Promise<AgentConfirmVerdict>;
  systemPrompt?: string;
  skillAttachment?: ProductionSkillAttachment | null;
  /** 当前思考强度；每轮发送前读取，缺省读本机为该模型保存的设置。 */
  getThinkingLevel?: () => AgentThinkingLevel;
  /** 技能来源；缺省为打包的 .agents/skills（运行时可再接本机注册表）。 */
  skillCatalog?: AgentSkillCatalog;
  /** 项目记忆；缺省用 useAgentMemoryStore（localforage），null 表示关闭。 */
  memory?: AgentMemoryBackend | null;
  /** 模型上下文窗口（token），缺省 128K。 */
  contextWindow?: number;
  /** 覆盖自动压缩设置（测试用）。 */
  compaction?: Partial<AgentCompactionSettings>;
}

/** 压缩前后在面板上显示的一条系统提示。 */
function compactionNotice(entry: { id: string; tokensBefore?: number; timestamp?: string }): ReturnType<typeof snapshotMessage> {
  const tokens = Number(entry.tokensBefore || 0);
  return {
    id: entry.id,
    role: 'system',
    text: tokens > 0 ? `已压缩上下文：约 ${Math.round(tokens / 1000)}K tokens 的早期对话整理成了摘要，技能已读记录与项目记忆保留。` : '已压缩上下文：早期对话整理成了摘要。',
    timestamp: entry.timestamp ? Date.parse(entry.timestamp) : undefined,
    compaction: { tokensBefore: tokens > 0 ? tokens : 0 },
  };
}

interface OverflowGuard {
  armed: boolean;
  hit: boolean;
}

export class BrowserAgentKernel {
  private repo: BrowserSessionRepo | null = null;
  private session: Session | null = null;
  private agent: Agent | null = null;
  private streamFn: StreamFn | null = null;
  private unsubscribe: (() => void) | null = null;
  private listeners = new Set<(event: { type: string; [key: string]: unknown }) => void>();
  private activeChangeSetId = '';
  private boundProductionSkill: ProductionSkillAttachment | null = null;
  private productionSkillBindingError: string | null = null;
  private systemPrompt: string;
  private readonly projectId: string;
  private readonly route: BrowserAgentTextRoute;
  private readonly tools: AgentTool[];
  private readonly confirm: (summary: string) => Promise<AgentConfirmVerdict>;
  private readonly initialSkillAttachment: ProductionSkillAttachment | null;
  private readonly getThinkingLevel: () => AgentThinkingLevel;
  private readonly skillCatalog: AgentSkillCatalog;
  private readonly skillLedger = new SkillReadLedger();
  /** 当前分支里的压缩次数；技能已读记录按它判断原文是否还在上下文里。 */
  private compactionEpoch = 0;
  private readonly memory: AgentMemoryBackend | null;
  private readonly contextWindow: number;
  private readonly compactionSettings: AgentCompactionSettings;
  private overflowGuard: OverflowGuard | null = null;
  private compactionController: AbortController | null = null;
  private compacting = false;
  /** 每次停止 +1：压缩（模型调用）期间用户点了停止，就不再接着发这一轮。 */
  private cancelEpoch = 0;
  /**
   * 插话缓冲：steer() 先放在这里，只在步骤边界（prepareNextTurn：工具结束 / 一次模型回复结束、下一次调用模型前）
   * 才交给 pi 的 steering 队列，所以送达前都能撤回。交出去之后按消息对象等 message_start，届时发 steer_delivered。
   */
  private steerBuffer: Array<{ id: string; message: AgentMessage }> = [];
  private steerInFlight = new Map<AgentMessage, string>();
  /** send() 进行中（含压缩、组装提示词、两次模型调用之间这些 isStreaming 为 false 的空档）：插话照收。 */
  private turnActive = false;
  /** 本轮的记忆提醒（P1-E）：确认决定 / 快压缩 / 刚压缩。每轮开始时重算。 */
  private memoryNudge: MemoryNudgeInput = {};

  constructor(options: BrowserAgentKernelOptions) {
    this.projectId = options.projectId;
    this.getThinkingLevel = options.getThinkingLevel ?? (() => effectiveAgentThinkingLevel(options.route.model));
    this.route = options.route;
    this.skillCatalog = options.skillCatalog ?? new MergedSkillCatalog();
    this.memory = options.memory === undefined ? agentMemoryStoreBackend : options.memory;
    this.contextWindow = options.contextWindow ?? BROWSER_AGENT_CONTEXT_WINDOW;
    this.compactionSettings = { ...DEFAULT_AGENT_COMPACTION_SETTINGS, ...(options.compaction || {}) };
    // 与 Node 内核一致：技能读取、项目记忆是内核自带工具（另有已移除任务清单的弃用无操作别名 flovart_todo），调用方已提供同名工具时不重复注册。
    const builtins: AgentTool[] = [];
    if (!options.tools.some(tool => tool.name === LEGACY_TODO_TOOL_NAME)) builtins.push(createLegacyTodoTool() as unknown as AgentTool);
    if (!options.tools.some(tool => tool.name === SKILL_READ_TOOL_NAME)) {
      builtins.push(createSkillReadTool({
        catalog: this.skillCatalog,
        ledger: this.skillLedger,
        getEpoch: () => this.compactionEpoch,
        onRead: record => this.recordSkillRead(record),
      }));
    }
    if (this.memory && !options.tools.some(tool => tool.name === MEMORY_TOOL_NAME)) {
      builtins.push(createMemoryTool({ projectId: this.projectId, backend: this.memory }));
    }
    this.tools = [...options.tools, ...builtins];
    this.confirm = options.confirm;
    this.initialSkillAttachment = options.skillAttachment ?? null;
    this.systemPrompt = options.systemPrompt ?? BROWSER_DEFAULT_SYSTEM_PROMPT;
  }

  subscribe(listener: (event: { type: string; [key: string]: unknown }) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: { type: string; [key: string]: unknown }) {
    for (const listener of this.listeners) void listener(event);
  }

  /** 技能读取写进会话（自定义 entry，不进模型上下文），所以压缩、刷新、切回会话后已读列表都在。 */
  private async recordSkillRead(record: SkillReadRecord): Promise<void> {
    if (!this.session) return;
    await this.session.appendCustomEntry(SKILL_READ_ENTRY, record);
    await this.repo?.persist(this.session);
  }

  /** 从会话分支恢复：绑定的强制技能、技能已读列表、压缩次数。 */
  private restoreSessionState(entries: ReadonlyArray<{ type: string; customType?: string; data?: unknown }>): void {
    this.boundProductionSkill = null;
    this.productionSkillBindingError = null;
    const persistedBinding = [...entries].reverse().find(entry => entry.type === 'custom' && entry.customType === PRODUCTION_SKILL_BINDING_ENTRY);
    if (persistedBinding?.data) {
      try {
        const data = persistedBinding.data as ProductionSkillAttachment;
        if (data?.id && data?.version && data?.contentHash) this.boundProductionSkill = data;
      } catch (error) {
        this.productionSkillBindingError = displayError(error, '技能绑定恢复失败。');
      }
    }
    this.skillLedger.restore(entries
      .filter(entry => entry.type === 'custom' && entry.customType === SKILL_READ_ENTRY && entry.data)
      .map(entry => entry.data as SkillReadRecord));
    this.compactionEpoch = entries.filter(entry => entry.type === 'compaction').length;
  }

  async openSession(): Promise<unknown> {
    if (this.session) return this.snapshot();
    this.repo = new BrowserSessionRepo(this.projectId);
    const sessions = await this.repo.list();
    // 打开最近更新的会话；全新项目才创建第一个会话
    const latest = sessions[0];
    this.session = latest
      ? await this.repo.open({ id: latest.id })
      : await this.repo.create({ metadata: { projectId: this.projectId, role: 'main' } });

    this.restoreSessionState(await allEntries(this.session));
    await this.buildAgent();
    return this.snapshot();
  }

  /** 系统提示词 = 基础提示词 + 技能索引（含强制技能与已读列表）+ 项目记忆摘要。每轮发送前重算。 */
  private async composeSystemPrompt(): Promise<string> {
    const entries = this.skillCatalog.list();
    const forced = this.boundProductionSkill
      ? (resolveSkillEntry(entries, this.boundProductionSkill.id)?.id || this.boundProductionSkill.displayName)
      : null;
    const skills = formatSkillIndexPrompt(buildSkillIndex(entries), { read: this.skillLedger.skillIds(), forced });
    let memory = '';
    if (this.memory) {
      try {
        memory = formatMemorySummary(await this.memory.list(this.projectId));
      } catch {
        memory = '';
      }
    }
    // 我的 Skill 只存在浏览器里、不在技能目录中，无法走 iris_skill_read：绑定时把指令直接拼进系统提示词。
    const bound = this.boundProductionSkill;
    const userSkill = bound && isUserSkillAttachment(bound) && !resolveSkillEntry(entries, bound.id) ? skillSystemContext(bound) : '';
    const nudge = this.memory ? formatMemoryNudge(this.memoryNudge) : '';
    return [this.systemPrompt, skills, userSkill, memory, nudge].filter(Boolean).join('\n\n');
  }

  /** 用当前 session + route 构建 PI Agent 实例；会话切换后复用。 */
  private async buildAgent(): Promise<void> {
    if (!this.session) throw new Error('Iris Agent session is not open');
    const context = await this.session.buildContext();
    const wrappedTools = this.tools.map(tool => tool.execute ? {
      ...tool,
      execute: (toolCallId: string, input: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate?: (partial: unknown) => void) => tool.execute(toolCallId, {
        ...input,
        ...(this.activeChangeSetId ? { changeSetId: this.activeChangeSetId } : {}),
      }, signal, onUpdate as never),
    } : tool);

    this.agent?.abort();
    this.unsubscribe?.();
    this.unsubscribe = null;
    const thinkingLevel = this.currentThinkingLevel();
    this.streamFn = createBrowserAgentStream(this.route);
    this.agent = new Agent({
      initialState: {
        thinkingLevel,
        // 绑定的强制技能不再塞进系统提示词（以前只截前 2000 字）：首轮以一次完整的 iris_skill_read 注入原文。
        systemPrompt: await this.composeSystemPrompt(),
        model: {
          id: this.route.model,
          name: this.route.model,
          api: 'openai-compatible',
          provider: this.route.provider,
          baseUrl: this.route.baseUrl,
          reasoning: thinkingLevel !== 'off',
          input: ['text', 'image'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: this.contextWindow,
          maxTokens: 16_384,
        } as never,
        tools: wrappedTools as never,
        messages: context.messages,
      },
      // 压缩摘要（compactionSummary）等扩展消息由 pi 的 convertToLlm 转成 user 消息。
      convertToLlm,
      streamFn: this.streamFn,
      beforeToolCall: async ({ toolCall }) => (
        this.tools.some(tool => tool.name === toolCall.name)
          ? undefined
          : { block: true, reason: `未注册的 Iris 工具：${toolCall.name}` }
      ),
      // 边界处一次送达全部插话（Codex 同样一次注入），不是一轮只取一条。
      steeringMode: 'all',
      prepareNextTurn: () => { this.flushSteers(); return undefined; },
      // 预期内失败由工具以 details.isError 标记，这里统一翻成 isError。
      afterToolCall: async ({ result }) => ((result as { details?: { isError?: boolean } } | undefined)?.details?.isError ? { isError: true } : undefined),
    });

    this.unsubscribe = this.agent.subscribe(async event => {
      if (event.type === 'message_end') {
        const message = (event as { message: AgentMessage }).message;
        // 上下文溢出：本轮第一次遇到时不落盘、不转发，send() 压缩后自动重试一次。
        const guard = this.overflowGuard;
        if (guard?.armed && !guard.hit && isContextOverflowMessage(message)) {
          guard.hit = true;
          return;
        }
        await this.session?.appendMessage(message);
        if (this.session) await this.repo?.persist(this.session);
      }
      this.emit(event as { type: string; [key: string]: unknown });
      if (event.type === 'message_start') {
        const steerId = this.steerInFlight.get((event as { message: AgentMessage }).message);
        if (steerId) {
          this.steerInFlight.delete((event as { message: AgentMessage }).message);
          this.emit({ type: 'steer_delivered', steerId });
        }
      }
    });
  }

  /** 步骤边界：把缓冲里的插话交给 pi，紧接着的 steering 轮询会把它们作为 user 消息注入。 */
  private flushSteers(): void {
    const agent = this.agent;
    if (!agent || this.steerBuffer.length === 0) return;
    for (const { id, message } of this.steerBuffer) {
      this.steerInFlight.set(message, id);
      agent.steer(message);
    }
    this.steerBuffer = [];
  }

  private currentThinkingLevel(): AgentThinkingLevel {
    try {
      return normalizeThinkingLevel(this.getThinkingLevel());
    } catch {
      return 'off';
    }
  }

  /** 每轮发送前同步思考强度：模型的 reasoning 标记与 Agent 的 thinkingLevel 一起切换。 */
  private syncThinkingLevel(): void {
    if (!this.agent) return;
    const level = this.currentThinkingLevel();
    this.agent.state.thinkingLevel = level;
    const current = this.agent.state.model as unknown as { reasoning?: boolean };
    if (Boolean(current.reasoning) !== (level !== 'off')) {
      this.agent.state.model = { ...(this.agent.state.model as object), reasoning: level !== 'off' } as never;
    }
  }

  async listSessions(): Promise<Array<{ id: string; title: string; updatedAt: string }>> {
    const repo = this.repo || new BrowserSessionRepo(this.projectId);
    const sessions = await repo.list();
    return sessions.map(({ id, title, updatedAt }) => ({ id, title, updatedAt }));
  }

  /** 开启一个全新会话并切换过去；旧会话保留在历史列表里。 */
  async newSession(): Promise<unknown> {
    if (!this.repo || !this.agent) await this.openSession();
    if (this.session) {
      const entries = await this.session.getBranch();
      // 空会话（没有任何消息）不重复进历史，直接复用
      if (!entries.some(entry => entry.type === 'message')) return this.snapshot();
    }
    this.agent?.abort();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.session = await this.repo!.create({ metadata: { projectId: this.projectId, role: 'main' } });
    this.restoreSessionState([]);
    await this.buildAgent();
    this.emit({ type: 'session_switched' });
    return this.snapshot();
  }

  /** 从某条消息处分出新会话：复制到该消息为止的全部内容，原会话保持不变。 */
  async branchSession(fromSessionId: string, upto: string | readonly string[]): Promise<unknown> {
    if (!this.repo) this.repo = new BrowserSessionRepo(this.projectId);
    const candidates = (typeof upto === 'string' ? [upto] : [...upto]).filter(Boolean);
    // 优先用内存里的当前会话：历史会话可能还没落盘，或消息已被压缩成摘要。
    const liveMetadata = this.session ? await this.session.getMetadata() : null;
    const live = liveMetadata?.id === fromSessionId ? this.session! : null;
    const sessions: Session[] = live ? [live] : [];
    if (!live) {
      try {
        sessions.push(await this.repo.open({ id: fromSessionId }));
      } catch {
        // 面板的 activeSessionId 可能滞后或为空；下面用当前活动会话兜底。
      }
      if (this.session) sessions.push(this.session);
    }
    if (!sessions.length) throw new Error('会话不存在：' + fromSessionId);
    let kept: Awaited<ReturnType<typeof this.session.getBranch>> | null = null;
    for (const source of sessions) {
      const entries = await allEntries(source);
      const index = branchEntryIndex(entries, candidates);
      if (index >= 0) {
        kept = entries.slice(0, index + 1);
        break;
      }
    }
    if (!kept) throw new Error('分支点不存在：' + (candidates[0] || ''));
    const branchPointId = kept[kept.length - 1].id;
    this.agent?.abort();
    this.unsubscribe?.();
    this.unsubscribe = null;
    const branch = await this.repo.create({
      metadata: { projectId: this.projectId, role: 'branch', branchedFrom: fromSessionId, branchPointId },
    });
    for (const entry of kept) {
      if (entry.type === 'message' && 'message' in entry && entry.message) await branch.appendMessage(entry.message);
      else if (entry.type === 'custom' && entry.customType === PRODUCTION_SKILL_BINDING_ENTRY && entry.data) {
        await branch.appendCustomEntry(entry.customType, entry.data);
      } else if (entry.type === 'custom' && entry.customType === SKILL_READ_ENTRY && entry.data) {
        // 分支复制的是完整原始消息（不含压缩），技能原文都在：压缩轮次归零。
        await branch.appendCustomEntry(entry.customType, { ...(entry.data as SkillReadRecord), epoch: 0 });
      }
    }
    this.session = branch;
    this.restoreSessionState(await allEntries(branch));
    await this.buildAgent();
    this.emit({ type: 'session_switched' });
    return this.snapshot();
  }

  /** 切换到历史列表中的指定会话。 */
  async openSessionById(sessionId: string): Promise<unknown> {
    if (!this.repo) await this.openSession();
    if (!this.repo) throw new Error('Iris Agent session store is unavailable');
    if (this.session) {
      const metadata = await this.session.getMetadata();
      if (metadata.id === sessionId) return this.snapshot();
    }
    this.agent?.abort();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.session = await this.repo.open({ id: sessionId });
    this.restoreSessionState(await allEntries(this.session));
    await this.buildAgent();
    this.emit({ type: 'session_switched' });
    return this.snapshot();
  }

  async deleteSession(sessionId: string): Promise<void> {
    if (!this.repo) this.repo = new BrowserSessionRepo(this.projectId);
    await this.repo.delete(sessionId);
    if (this.session) {
      const metadata = await this.session.getMetadata();
      if (metadata.id === sessionId) {
        // 删除的是当前会话：切到剩余最新的，或新建一个
        const remaining = (await this.repo.list())[0];
        if (remaining) await this.openSessionById(remaining.id);
        else await this.newSession();
      }
    }
  }

  cancel(): void {
    // 停止也丢掉排队中的插话：用户点停止就是要这一轮完全结束。
    this.agent?.clearAllQueues();
    this.steerBuffer = [];
    this.steerInFlight.clear();
    this.agent?.abort();
    this.compactionController?.abort();
    this.cancelEpoch += 1;
  }

  /** 当前是否有一轮在跑（面板据此决定新消息走插话还是新一轮）。 */
  get running(): boolean {
    return Boolean(this.agent?.state.isStreaming);
  }

  /**
   * 运行中插话（steering）：不打断当前这一轮，消息在下一个步骤边界（工具执行完、下一次调用模型前）
   * 注入对话；送达时发 `steer_delivered { steerId }`。没有在跑时返回 false，调用方改走 send。
   */
  steer(text: string, images: ImageContent[] = [], id: string = crypto.randomUUID()): boolean {
    if (!this.agent || !this.session || !(this.agent.state.isStreaming || this.turnActive)) return false;
    const prompt = String(text || '').trim();
    if (!prompt && images.length === 0) return false;
    this.steerBuffer.push({
      id,
      message: {
        role: 'user',
        content: [{ type: 'text', text: prompt }, ...images],
        timestamp: Date.now(),
      } as AgentMessage,
    });
    return true;
  }

  /** 撤回一条还没到步骤边界的插话；已经交给模型循环的撤不回，返回 false。 */
  withdrawSteer(id: string): boolean {
    const before = this.steerBuffer.length;
    this.steerBuffer = this.steerBuffer.filter(item => item.id !== id);
    return this.steerBuffer.length !== before;
  }

  /**
   * 这一轮结束后仍未送达的插话（这一轮在边界之前就结束 / 出错了）：从内核取走并返回 id，
   * 由面板作为下一轮重新提交，内核不再自行处理它们。
   */
  takePendingSteers(): string[] {
    const ids = [...this.steerBuffer.map(item => item.id), ...this.steerInFlight.values()];
    this.steerBuffer = [];
    if (this.steerInFlight.size) {
      this.steerInFlight.clear();
      this.agent?.clearSteeringQueue();
    }
    return ids;
  }

  // -------------------------------------------------------------------------
  // 上下文压缩
  // -------------------------------------------------------------------------

  /** 下一次请求的 token 估算（消息 + 系统提示词 + 工具定义 + 待发送内容）。 */
  estimateContextTokens(pending: { text?: string; images?: number } = {}): number {
    if (!this.agent) return 0;
    return estimateRequestTokens({
      messages: this.agent.state.messages,
      systemPrompt: this.agent.state.systemPrompt,
      toolsJson: JSON.stringify(this.tools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))),
      pendingText: pending.text,
      pendingImages: pending.images,
    });
  }

  /** 压缩一次并把 Agent 的消息换成压缩后的上下文；没有可压缩的历史返回 null。 */
  private async runCompaction(reason: 'threshold' | 'overflow' | 'manual'): Promise<{ tokensBefore: number } | null> {
    if (!this.session || !this.agent || !this.streamFn) return null;
    this.compacting = true;
    this.compactionController = new AbortController();
    let started = false;
    try {
      const outcome = await compactSession({
        onStart: () => { started = true; this.emit({ type: 'compaction_start', reason }); },
        session: this.session,
        streamFn: this.streamFn,
        model: this.agent.state.model,
        keepRecentTokens: reason === 'overflow' ? OVERFLOW_KEEP_RECENT_TOKENS : this.compactionSettings.keepRecentTokens,
        signal: this.compactionController.signal,
      });
      if (outcome) {
        this.compactionEpoch += 1;
        await this.repo?.persist(this.session);
        this.agent.state.messages = (await this.session.buildContext()).messages;
        // 压缩后系统提示词重算：项目记忆重新注入，并提醒以记忆 + 摘要为准（P1-E）。
        this.memoryNudge = { ...this.memoryNudge, nearCompaction: false, justCompacted: true };
        this.agent.state.systemPrompt = await this.composeSystemPrompt();
      }
      if (started) this.emit({ type: 'compaction_end', reason, compacted: Boolean(outcome), tokensBefore: outcome?.tokensBefore ?? 0 });
      return outcome ? { tokensBefore: outcome.tokensBefore } : null;
    } catch (error) {
      if (started) this.emit({ type: 'compaction_end', reason, compacted: false, error: displayError(error, '上下文压缩失败。') });
      throw error;
    } finally {
      this.compacting = false;
      this.compactionController = null;
    }
  }

  /** 手动「压缩上下文」：运行中不压缩；历史太短时返回 compacted=false。 */
  async compactContext(): Promise<{ compacted: boolean; tokensBefore?: number }> {
    if (!this.agent || !this.session) throw new Error('Iris Agent session is not open');
    if (this.agent.state.isStreaming || this.compacting) throw new Error('Agent 正在运行，请等这一轮结束后再压缩上下文。');
    const outcome = await this.runCompaction('manual');
    return outcome ? { compacted: true, tokensBefore: outcome.tokensBefore } : { compacted: false };
  }

  /** 发送前检查：估算超过阈值就先压缩；压缩失败不拦截发送（溢出时还有一次压缩重试）。 */
  private async compactIfNeeded(pending: { text: string; images: number }): Promise<void> {
    const tokens = this.estimateContextTokens(pending);
    if (!shouldCompactContext(tokens, this.contextWindow, this.compactionSettings)) return;
    try {
      await this.runCompaction('threshold');
    } catch {
      // 已通过 compaction_end 事件报告；继续发送。
    }
  }

  /** 绑定的强制技能：当前压缩轮次里还没完整读过 SKILL.md 时，生成一次完整读取（工具调用 + 结果）。 */
  private async forcedSkillMessages(): Promise<AgentMessage[]> {
    const bound = this.boundProductionSkill;
    if (!bound) return [];
    const entry = resolveSkillEntry(this.skillCatalog.list(), bound.id);
    if (!entry || this.skillLedger.hasFullRead(entry.id, this.compactionEpoch)) return [];
    const result = await readSkillForAgent({
      catalog: this.skillCatalog,
      ledger: this.skillLedger,
      epoch: this.compactionEpoch,
      id: entry.id,
      force: true,
      full: true,
    });
    if (!result.record) return [];
    await this.recordSkillRead(result.record);
    const toolCallId = 'skill-forced-' + crypto.randomUUID();
    const args = { id: entry.id, forced: true };
    const now = Date.now();
    const call = {
      role: 'assistant',
      content: [{ type: 'toolCall', id: toolCallId, name: SKILL_READ_TOOL_NAME, arguments: args }],
      api: 'openai-compatible',
      provider: this.route.provider,
      model: this.route.model,
      usage: EMPTY_USAGE,
      stopReason: 'toolUse',
      timestamp: now,
    } as unknown as AgentMessage;
    const toolResult = {
      role: 'toolResult',
      toolCallId,
      toolName: SKILL_READ_TOOL_NAME,
      content: [{ type: 'text', text: result.text }],
      details: result.details,
      isError: false,
      timestamp: now,
    } as unknown as AgentMessage;
    this.emit({ type: 'tool_execution_start', toolCallId, toolName: SKILL_READ_TOOL_NAME, args });
    this.emit({ type: 'tool_execution_end', toolCallId, toolName: SKILL_READ_TOOL_NAME, result: { content: [{ type: 'text', text: result.text }], details: result.details }, isError: false });
    return [call, toolResult];
  }

  /** 上下文溢出后的唯一一次自动恢复：压缩（保留更少的最近上下文）后从同一位置继续。 */
  private async recoverFromOverflow(agent: Agent): Promise<boolean> {
    const guard = this.overflowGuard;
    if (!guard?.hit || !this.session) return false;
    guard.armed = false;
    guard.hit = false;
    const cancelEpoch = this.cancelEpoch;
    let compacted = false;
    try {
      compacted = Boolean(await this.runCompaction('overflow'));
    } catch {
      compacted = false;
    }
    if (this.cancelEpoch !== cancelEpoch) return false; // 用户在压缩时停止了：不重试，也不补错误卡
    const messages = (await this.session.buildContext()).messages;
    const last = messages[messages.length - 1] as { role?: string } | undefined;
    if (!compacted || !last || last.role === 'assistant') {
      // 压缩不了：把这次溢出错误照常写进会话，让面板显示并提示手动压缩。
      const failed: AgentMessage = {
        role: 'assistant',
        content: [],
        api: 'openai-compatible',
        provider: this.route.provider,
        model: this.route.model,
        usage: EMPTY_USAGE,
        stopReason: 'error',
        errorMessage: AGENT_CONTEXT_OVERFLOW_MESSAGE,
        timestamp: Date.now(),
      } as unknown as AgentMessage;
      await this.session.appendMessage(failed);
      await this.repo?.persist(this.session);
      agent.state.messages = [...messages, failed];
      return false;
    }
    agent.state.messages = messages;
    await agent.continue();
    return true;
  }

  async send(text: string, images: ImageContent[] = [], skillAttachment?: ProductionSkillAttachment | null): Promise<unknown> {
    if (!this.agent || !this.session) throw new Error('Iris Agent session is not open');
    const prompt = String(text || '').trim();
    if (!prompt && images.length === 0) throw new Error('Iris Agent message is empty');
    this.activeChangeSetId = crypto.randomUUID();

    if (skillAttachment === null) {
      if (this.boundProductionSkill) {
        this.boundProductionSkill = null;
        this.productionSkillBindingError = null;
        await this.session.appendCustomEntry(PRODUCTION_SKILL_BINDING_ENTRY, null);
      }
    } else if (skillAttachment) {
      const changed = !this.boundProductionSkill
        || this.boundProductionSkill.id !== skillAttachment.id
        || this.boundProductionSkill.version !== skillAttachment.version
        || this.boundProductionSkill.contentHash !== skillAttachment.contentHash;
      this.boundProductionSkill = skillAttachment;
      this.productionSkillBindingError = null;
      if (changed) await this.session.appendCustomEntry(PRODUCTION_SKILL_BINDING_ENTRY, {
        id: skillAttachment.id,
        version: skillAttachment.version,
        contentHash: skillAttachment.contentHash,
        displayName: skillAttachment.displayName,
        trustTier: skillAttachment.trustTier,
      });
    }

    this.turnActive = true;
    try {
      return await this.runTurn(prompt, images);
    } finally {
      this.turnActive = false;
    }
  }

  private async runTurn(prompt: string, images: ImageContent[]): Promise<unknown> {
    if (!this.agent) throw new Error('Iris Agent session is not open');
    this.syncThinkingLevel();
    const agent = this.agent;
    // 记忆提醒：用户在确认决定、或上下文已过压缩阈值的 80%（下一两轮就会压缩）时，提醒先写项目记忆。
    const pendingTokens = this.estimateContextTokens({ text: prompt, images: images.length });
    this.memoryNudge = {
      confirmation: looksLikeDecisionConfirmation(prompt),
      nearCompaction: this.compactionSettings.enabled && pendingTokens > compactionThresholdTokens(this.contextWindow, this.compactionSettings) * 0.8,
    };
    agent.state.systemPrompt = await this.composeSystemPrompt();
    const cancelEpoch = this.cancelEpoch;
    const epochBefore = this.compactionEpoch;
    await this.compactIfNeeded({ text: prompt, images: images.length });
    if (this.compactionEpoch !== epochBefore) {
      // 刚压缩完：记忆已随系统提示词重新注入，提醒以它为准并补齐摘要里的已确认事实。
      this.memoryNudge = { ...this.memoryNudge, nearCompaction: false, justCompacted: true };
      agent.state.systemPrompt = await this.composeSystemPrompt();
    }
    // 压缩期间用户点了停止：这一轮不再发送（用户消息也不写入会话）。
    if (this.cancelEpoch !== cancelEpoch) throw new Error(AGENT_ABORTED_MESSAGE);
    const forced = await this.forcedSkillMessages();
    if (forced.length) agent.state.systemPrompt = await this.composeSystemPrompt();
    const userMessage = {
      role: 'user',
      content: [{ type: 'text', text: prompt }, ...images],
      timestamp: Date.now(),
    } as AgentMessage;
    this.overflowGuard = { armed: true, hit: false };
    try {
      // 强制技能的完整读取紧跟在用户消息之后：模型这一轮就能看到原文，面板显示一条「已读取 xxx 技能」。
      await agent.prompt(forced.length ? [userMessage, ...forced] : userMessage);
      await this.recoverFromOverflow(agent);
      // 最后一次轮询之后才到的插话（包括还在缓冲里、没赶上步骤边界的）：接着处理，不能丢。停止（abort）会清空队列。
      this.flushSteers();
      while (this.agent === agent && agent.hasQueuedMessages() && !agent.state.isStreaming) {
        const last = agent.state.messages[agent.state.messages.length - 1] as { stopReason?: string } | undefined;
        if (last?.stopReason === 'aborted') { agent.clearAllQueues(); break; }
        // 这一轮以模型请求失败结束：插话没到过步骤边界，不拿它再调一次模型（会把同一个失败再撞一遍），
        // 留在队列里由调用方 takePendingSteers() 取回、交还给用户。
        if (last?.stopReason === 'error') break;
        await agent.continue();
        await this.recoverFromOverflow(agent);
        this.flushSteers();
      }
    } finally {
      this.overflowGuard = null;
    }
    return this.snapshot();
  }

  async snapshot(): Promise<{
    sessionId: string;
    projectId: string;
    boundProductionSkill: ProductionSkillAttachment | null;
    productionSkillBindingError: string | null;
    messages: Array<ReturnType<typeof snapshotMessage>>;
    running: boolean;
  }> {
    if (!this.session) throw new Error('Iris Agent session is not open');
    const metadata = await this.session.getMetadata();
    const entries = await allEntries(this.session);
    return {
      sessionId: metadata.id,
      projectId: this.projectId,
      boundProductionSkill: this.boundProductionSkill,
      productionSkillBindingError: this.productionSkillBindingError,
      messages: entries
        .filter(entry => entry.type === 'message' || entry.type === 'compaction')
        .map(entry => (entry.type === 'compaction' ? compactionNotice(entry as { id: string; tokensBefore?: number; timestamp?: string }) : snapshotMessage(entry)))
        .filter(message => message.role !== 'assistant' || message.text || message.thinking || message.error),
      running: Boolean(this.agent?.state.isStreaming),
    };
  }

  async close(): Promise<void> {
    this.agent?.abort();
    this.compactionController?.abort();
    this.unsubscribe?.();
    this.agent = null;
    this.session = null;
    this.repo = null;
  }
}
