/**
 * 联网模型拉取服务
 * 通过 API Key 调用各 Provider 的接口获取可用模型列表。
 * 优先支持：Google Gemini、DeepSeek、OpenAI 及兼容接口。
 */

import localforage from 'localforage';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import type { AIProvider, AICapability, ModelThinkingLevel } from '../types';
import { normalizeThinkingLevelName, sortThinkingLevels, type ModelCapabilityFields } from './modelThinkingLevels';
import { getOpenAICompatibleBaseUrlCandidates, normalizeProviderBaseUrl } from './baseUrl';
import { isLikelyRunningHubModelEndpoint, normalizeRunningHubModelEndpoint, rhProbeApiKey, BUILTIN_RUNNINGHUB_MODELS, stripRunningHubVersionName } from './runningHubService';
import {
    hasDynamicRoutesForSite,
    listDynamicRouteSchemas,
    refreshRunningHubDocRoutes,
    registerInferredRunningHubRoutes,
    runningHubDocSite,
} from './runningHubDynamicRoutes';

export interface FetchedModel {
    id: string;
    name: string;
    capability: AICapability;
    description?: string;
    inputModalities?: string[];
    outputModalities?: string[];
    supportedParameters?: string[];
    /** 以下字段来自服务商模型列表（见 readModelCapabilityFields），随 ModelItem 持久化。 */
    thinkingLevels?: ModelThinkingLevel[];
    thinkingSource?: 'api';
    thinkingMode?: 'effort' | 'toggle';
    thinkingMandatory?: boolean;
    defaultThinkingLevel?: ModelThinkingLevel;
    contextWindow?: number;
    maxOutputTokens?: number;
}

export type { ModelCapabilityFields } from './modelThinkingLevels';

function positiveInt(...values: unknown[]): number | undefined {
    for (const value of values) {
        const n = typeof value === 'string' ? Number(value) : value;
        if (typeof n === 'number' && Number.isFinite(n) && n > 0) return Math.floor(n);
    }
    return undefined;
}

/** 档位来源可能是字符串数组、{ effort | value | level | name } 数组，或 { low: { supported: true } } 这类对象。 */
function readLevelList(raw: unknown): ModelThinkingLevel[] {
    if (Array.isArray(raw)) {
        return sortThinkingLevels(raw.map(item => (item && typeof item === 'object')
            ? (item as any).effort ?? (item as any).value ?? (item as any).level ?? (item as any).name ?? (item as any).id
            : item));
    }
    if (raw && typeof raw === 'object') {
        const entries = Object.entries(raw as Record<string, unknown>)
            .filter(([key, value]) => normalizeThinkingLevelName(key) && key !== 'default'
                && (value === true || (value && typeof value === 'object' && (value as any).supported !== false)));
        return sortThinkingLevels(entries.map(([key]) => key));
    }
    return [];
}

/**
 * 从服务商 /models 条目读思考档位与上下文大小（各家字段不同，见下）。读不到的字段不出现。
 * - OpenRouter：reasoning.supported_efforts / reasoning.mandatory，supported_parameters 含 reasoning / reasoning_effort；
 *   context_length、top_provider.context_length / max_completion_tokens。
 * - Anthropic：capabilities.effort（{ low: { supported } … } 或数组）、capabilities.thinking.supported；max_input_tokens / max_tokens。
 * - Google：thinking（布尔）、inputTokenLimit / outputTokenLimit。
 * - 通用：supported_reasoning_levels（字符串或 { effort } 数组）、reasoning_efforts / supported_reasoning_efforts、
 *   context_window、max_output_tokens。
 * - Kimi：supports_thinking_type（开关型）、think_efforts（档位）与 think_efforts.default_effort。
 */
export function readModelCapabilityFields(raw: any): ModelCapabilityFields {
    if (!raw || typeof raw !== 'object') return {};
    const out: ModelCapabilityFields = {};
    const reasoning = raw.reasoning && typeof raw.reasoning === 'object' ? raw.reasoning : undefined;
    const caps = raw.capabilities && typeof raw.capabilities === 'object' ? raw.capabilities : undefined;
    const thinkEfforts = raw.think_efforts && typeof raw.think_efforts === 'object' ? raw.think_efforts : undefined;
    const params: string[] | undefined = Array.isArray(raw.supported_parameters) ? raw.supported_parameters : undefined;

    let levels: ModelThinkingLevel[] = [];
    let supported: boolean | undefined;
    let mandatory: boolean | undefined;
    let toggle = false;
    let defaultLevel: ModelThinkingLevel | undefined;

    // 1. 显式档位列表（按可信度依次尝试）
    const levelSources: unknown[] = [
        reasoning?.supported_efforts,
        reasoning?.efforts,
        raw.supported_reasoning_levels,
        raw.supported_reasoning_efforts,
        raw.reasoning_efforts,
        caps?.effort?.levels,
        caps?.effort,
        caps?.reasoning_effort,
        thinkEfforts?.supported_efforts ?? thinkEfforts?.efforts ?? thinkEfforts?.levels,
        thinkEfforts && !Array.isArray(thinkEfforts) ? Object.fromEntries(Object.entries(thinkEfforts).filter(([key]) => !/default/i.test(key))) : undefined,
    ];
    for (const source of levelSources) {
        if (source && typeof source === 'object' && !Array.isArray(source) && (source as any).supported === false) { supported = false; continue; }
        const list = readLevelList(source);
        if (list.length) { levels = list; supported = true; break; }
    }

    // 2. 布尔 / 开关型
    if (typeof reasoning?.mandatory === 'boolean') mandatory = reasoning.mandatory;
    if (typeof raw.always_thinks === 'boolean' && raw.always_thinks) mandatory = true;
    if (typeof caps?.thinking?.supported === 'boolean' && supported === undefined) supported = caps.thinking.supported;
    if (typeof caps?.thinking === 'boolean' && supported === undefined) supported = caps.thinking;
    if (typeof raw.thinking === 'boolean' && supported === undefined) supported = raw.thinking;
    const kimiType = raw.supports_thinking_type;
    if (kimiType !== undefined && kimiType !== null && kimiType !== false) {
        const types = (Array.isArray(kimiType) ? kimiType : [kimiType]).map(item => String(item).toLowerCase());
        if (!types.some(item => /^(false|none|disabled?|unsupported)$/.test(item))) {
            supported = true;
            if (!levels.length) toggle = true;
            if (types.length && types.every(item => /^(enabled|always|forced|true)$/.test(item)) && Array.isArray(kimiType)) mandatory = true;
        } else if (supported === undefined) {
            supported = false;
        }
    }
    if (params && supported === undefined) {
        if (params.some(p => /^(reasoning|reasoning_effort|include_reasoning|thinking)$/.test(p))) supported = true;
        else supported = false;
    }
    if (reasoning && supported === undefined && Object.keys(reasoning).length) supported = true;

    const defaultRaw = thinkEfforts?.default_effort ?? reasoning?.default_effort ?? raw.default_reasoning_level ?? raw.default_reasoning_effort ?? caps?.effort?.default;
    const parsedDefault = normalizeThinkingLevelName(defaultRaw);
    if (parsedDefault) defaultLevel = parsedDefault;

    if (levels.length) {
        // 声明了不必须思考，档位里却没有 none：补上 off，用户可以关。
        if (mandatory === false && !levels.includes('off')) levels = ['off', ...levels];
        if (mandatory === undefined && levels.includes('off')) mandatory = false;
        out.thinkingLevels = levels;
        out.thinkingSource = 'api';
        out.thinkingMode = 'effort';
    } else if (supported === false) {
        out.thinkingLevels = ['off'];
        out.thinkingSource = 'api';
    } else if (supported === true && toggle) {
        out.thinkingLevels = mandatory ? ['high'] : ['off', 'high'];
        out.thinkingSource = 'api';
        out.thinkingMode = 'toggle';
    }
    // supported === true 但没给档位（如 Google thinking: true）：只记必须与否，档位交给注册表 / 规则表。
    if (mandatory !== undefined && (out.thinkingLevels?.length || supported)) out.thinkingMandatory = mandatory;
    if (defaultLevel) out.defaultThinkingLevel = defaultLevel;

    const contextWindow = positiveInt(raw.context_length, raw.context_window, raw.contextWindow, raw.max_context_length,
        raw.max_input_tokens, raw.inputTokenLimit, raw.top_provider?.context_length);
    const maxOutputTokens = positiveInt(raw.max_output_tokens, raw.max_completion_tokens, raw.top_provider?.max_completion_tokens,
        raw.outputTokenLimit, raw.max_tokens, raw.maxTokens);
    if (contextWindow) out.contextWindow = contextWindow;
    if (maxOutputTokens) out.maxOutputTokens = maxOutputTokens;
    return out;
}

export { fetchedModelToItem, refreshModelCapabilityFields } from './modelThinkingLevels';

export interface FetchModelsResult {
    ok: boolean;
    models: FetchedModel[];
    error?: string;
    modelDiscovery?: 'available' | 'unavailable';
    endpointFlavor?: 'google' | 'openai-compatible' | 'openrouter-compatible';
    capabilitySummary?: AICapability[];
    effectiveBaseUrl?: string;
    /** network：请求没能到达服务（断网、CORS 拦截、超时）。此时不能判定 Key 无效。 */
    reason?: 'network';
}

/** 连不上服务时的统一说明：明确 Key 没有被判定为无效。 */
export const CANNOT_CONNECT_MESSAGE = '无法连接到服务（网络不可用、被跨域 CORS 拦截或超时），未能判定 API Key 是否有效。';

/** fetch 层面的失败（TypeError: Failed to fetch / NetworkError / Load failed、超时、中止）而非服务端拒绝。 */
export function isNetworkFailure(error: unknown): boolean {
    if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
        return error.name === 'TimeoutError' || error.name === 'AbortError' || error.name === 'NetworkError';
    }
    const message = error instanceof Error ? error.message : String(error ?? '');
    // 只认浏览器/Node fetch 的网络错误文案（Chrome / Firefox / Safari / undici），不把代码里的普通 TypeError 当成断网。
    return /failed to fetch|fetch failed|networkerror|network error|load failed|cors|err_connection|econnrefused|enotfound|etimedout|socket hang up/i.test(message);
}

export const MODEL_DISCOVERY_TIMEOUT_MS = 10_000;

function createModelDiscoveryTimeoutError() {
    return new DOMException('模型列表请求超时', 'TimeoutError');
}

/**
 * 模型发现请求：截止时间同时覆盖「等响应头」和「读响应体」。
 * 只在 fetch 返回后清计时器会让响应头先到、响应体卡住的接口无限挂起（GitHub #43）。
 * 返回的 Response 已经把响应体完整读进内存，调用方照常 .text() 不会再阻塞。
 */
async function fetchWithModelDiscoveryTimeout(input: string, init: RequestInit = {}): Promise<Response> {
    const controller = new AbortController();
    let rejectOnTimeout: (reason: unknown) => void = () => {};
    const deadline = new Promise<never>((_, reject) => { rejectOnTimeout = reject; });
    const timeout = setTimeout(() => {
        const error = createModelDiscoveryTimeoutError();
        controller.abort(error);
        rejectOnTimeout(error);
    }, MODEL_DISCOVERY_TIMEOUT_MS);
    // 防止截止 Promise 在正常完成后被判为未处理的 rejection
    deadline.catch(() => {});
    try {
        const response = await Promise.race([fetch(input, { ...init, signal: controller.signal }), deadline]);
        const body = await Promise.race([response.text(), deadline]);
        const headers = new Headers();
        const contentType = response.headers?.get?.('Content-Type');
        if (contentType) headers.set('Content-Type', contentType);
        const nullBodyStatus = response.status === 204 || response.status === 205 || response.status === 304;
        return new Response(nullBodyStatus ? null : body, {
            status: response.status >= 200 && response.status <= 599 ? response.status : 500,
            statusText: response.statusText,
            headers,
        });
    } finally {
        clearTimeout(timeout);
    }
}

// ── Capability 推断规则 ─────────────────────────────
function stripProviderPrefix(modelId: string): string {
    const normalized = modelId.toLowerCase();
    const parts = normalized.split('/');
    return parts.length > 1 ? parts.slice(1).join('/') : normalized;
}

function inferCapability(modelId: string, model?: any): AICapability {
    const categoryText = `${model?.categoryName || ''} ${model?.sourceTypeName || ''}`.toLowerCase();
    if (/video/.test(categoryText)) return 'video';
    if (/image/.test(categoryText)) return 'image';

    const outputModalities = model?.architecture?.output_modalities || model?.output_modalities || [];
    if (Array.isArray(outputModalities)) {
        if (outputModalities.includes('video')) return 'video';
        if (outputModalities.includes('image')) return 'image';
    }

    const id = stripProviderPrefix(modelId);
    if (id.includes('seedance')) return 'video';
    if (/^(veo|video|wan|seedance|vidu|pika|runway|higgsfield|luma|kling|keling|sora|sdols|hailuo|qwen-video|liveportrait|videoretalk|emo|gemini-omni|happyhorse|ltx|pixverse|skyreels)/.test(id)) return 'video';
    if (/(^|[-_/])(text|image|reference|start|end|multimodal)?-?to-video|video-edit|edit-video|motion-control|video-extend/.test(id)) return 'video';
    if (/^(imagen|image-generation|dall-e|gpt-image|stable-diffusion|sdxl|flux|midjourney|recraft|ideogram|qwen-image|seededit|seedream|nano-banana|jimeng|doubao-image|omni-image|grok-image|rhart-image|f-|z-image|xai\/rhart|xai\/grok-imagine-image)/.test(id)) return 'image';
    if (/(^|[-_/])(text|image)-to-image|image-edit|edit-channel|edit-official|\/edit(?:-|$)/.test(id)) return 'image';
    if (/image/.test(id) && /gemini/.test(id)) return 'image';
    return 'text';
}

function summarizeCapabilities(models: FetchedModel[]): AICapability[] {
    return Array.from(new Set(models.map(model => model.capability)));
}

function detectEndpointFlavor(baseUrl: string, rawModels: any[]): 'openai-compatible' | 'openrouter-compatible' {
    if (/openrouter/i.test(baseUrl)) return 'openrouter-compatible';
    if (rawModels.some(model => model?.architecture?.output_modalities || model?.supported_parameters)) {
        return 'openrouter-compatible';
    }
    return 'openai-compatible';
}

function truncateResponseSnippet(text: string, maxLength = 200) {
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (normalized.length <= maxLength) return normalized;
    return `${normalized.slice(0, maxLength)}...`;
}

function looksLikeHtmlResponse(text: string) {
    return /^\s*<(?:!doctype|html|head|body)\b/i.test(text);
}

const RUNNINGHUB_DOCS_MODEL_URLS = {
    cn: 'https://www.runninghub.cn/page-api',
    ai: 'https://www.runninghub.ai/page-api',
} as const;

/**
 * 模型目录页跟随用户配置的站点：国内站（runninghub.cn）与国际站（runninghub.ai）的模型列表不同，
 * 不能用国际站的列表去配国内站的 Key。无法判断站点时（自定义代理等）按默认 Base URL 走国内站。
 */
export function runningHubDocsModelUrl(baseUrl?: string): string {
    const raw = String(baseUrl || '').trim();
    let host = '';
    try {
        host = new URL(raw).hostname.toLowerCase();
    } catch {
        host = raw.toLowerCase();
    }
    if (/(^|\.)runninghub\.ai$/.test(host) || /(^|[/.])runninghub\.ai([/:]|$)/.test(host)) return RUNNINGHUB_DOCS_MODEL_URLS.ai;
    return RUNNINGHUB_DOCS_MODEL_URLS.cn;
}

function runningHubModelToFetchedModel(id: string, model?: any): FetchedModel {
    return {
        id,
        name: id,
        capability: inferCapability(id, model),
        description: model?.description?.slice?.(0, 160) || 'RunningHub 标准模型',
    };
}

function derefNuxtValue(data: unknown[], value: unknown): unknown {
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < data.length) {
        return data[value];
    }
    return value;
}

function nuxtString(data: unknown[], value: unknown): string {
    const resolved = derefNuxtValue(data, value);
    return typeof resolved === 'string' ? resolved : '';
}

function parseRunningHubPageModels(html: string): FetchedModel[] {
    const match = html.match(/<script[^>]+id=["']__NUXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
    if (!match) return [];
    let data: unknown[];
    try {
        data = JSON.parse(match[1]);
    } catch {
        return [];
    }
    if (!Array.isArray(data)) return [];

    const models: FetchedModel[] = [];
    for (const raw of data) {
        if (!raw || Array.isArray(raw) || typeof raw !== 'object') continue;
        const item = raw as Record<string, unknown>;
        if (!('name' in item) || !('categoryName' in item)) continue;
        const rawName = nuxtString(data, item.name);
        const id = normalizeRunningHubModelEndpoint(rawName);
        if (!rawName || /\[Deprecated\]|Please use/i.test(rawName) || !isLikelyRunningHubModelEndpoint(id)) continue;
        const categoryName = nuxtString(data, item.categoryName);
        const sourceTypeName = nuxtString(data, item.sourceTypeName);
        const description = nuxtString(data, item.description);
        const capability = inferCapability(id, { categoryName, sourceTypeName });
        if (capability !== 'image' && capability !== 'video') continue;
        models.push(runningHubModelToFetchedModel(id, { categoryName, sourceTypeName, description }));
    }
    return models;
}

function mergeModelLists(...lists: FetchedModel[][]): FetchedModel[] {
    const merged = new Map<string, FetchedModel>();
    for (const list of lists) {
        for (const model of list) {
            if (!merged.has(model.id)) merged.set(model.id, model);
        }
    }
    return Array.from(merged.values()).sort((a, b) => {
        if (a.capability !== b.capability) return a.capability === 'image' ? -1 : 1;
        return a.id.localeCompare(b.id);
    });
}

async function readJsonResponse<T>(response: Response, requestLabel: string): Promise<T> {
    const text = await response.text().catch(() => '');
    if (!text) return {} as T;

    if (looksLikeHtmlResponse(text)) {
        throw new Error(`${requestLabel} 返回了 HTML 页面，请检查 Base URL 是否指向 API 接口而不是网站首页。`);
    }

    try {
        return JSON.parse(text) as T;
    } catch {
        const contentType = response.headers.get('Content-Type') || 'unknown';
        throw new Error(`${requestLabel} 返回了非 JSON 响应 (${contentType})：${truncateResponseSnippet(text)}`);
    }
}

async function readErrorMessage(response: Response, requestLabel: string): Promise<string> {
    const text = await response.text().catch(() => '');
    if (!text) return `${requestLabel}: HTTP ${response.status}`;

    if (looksLikeHtmlResponse(text)) {
        return `${requestLabel}: 返回了 HTML 页面，请检查 Base URL 是否指向 API 接口而不是网站首页。`;
    }

    try {
        const json = JSON.parse(text);
        const detail = json?.error?.message || json?.message || json?.detail;
        if (detail) return String(detail);
    } catch {
        // Fall back to plain text below.
    }

    return `${requestLabel}: ${truncateResponseSnippet(text)}`;
}

// ── Google Gemini ──────────────────────────────────
async function fetchGoogleModels(apiKey: string, baseUrl?: string): Promise<FetchModelsResult> {
    try {
        const base = normalizeProviderBaseUrl('google', baseUrl || 'https://generativelanguage.googleapis.com/v1beta');
        const url = `${base}/models`;
        const res = await fetchWithModelDiscoveryTimeout(url, {
            headers: { 'x-goog-api-key': apiKey },
        });
        if (!res.ok) {
            return { ok: false, models: [], error: await readErrorMessage(res, 'Google 模型列表拉取失败') };
        }
        const data = await readJsonResponse<any>(res, 'Google 模型列表响应');
        const models: FetchedModel[] = (data.models || [])
            .filter((m: any) => {
                const name: string = m.name || '';
                // 只保留有实用能力的模型，排除 embedding/AQA 等
                return !(/embed|aqa|retrieval|attribution/i.test(name));
            })
            .map((m: any) => {
                const id = (m.name || '').replace(/^models\//, '');
                const methods: string[] = m.supportedGenerationMethods || [];
                let capability: AICapability = 'text';
                if (methods.includes('generateImages') || /imagen/i.test(id)) {
                    capability = 'image';
                } else if (/veo/i.test(id)) {
                    capability = 'video';
                } else if (/image/i.test(id) && /gemini/i.test(id)) {
                    capability = 'image';
                }
                return {
                    id,
                    name: m.displayName || id,
                    capability,
                    description: m.description?.slice(0, 120),
                    ...(capability === 'text' ? readModelCapabilityFields(m) : {}),
                };
            });
        return { ok: true, models, modelDiscovery: 'available', endpointFlavor: 'google', capabilitySummary: summarizeCapabilities(models), effectiveBaseUrl: base };
    } catch (err) {
        if (isNetworkFailure(err)) return { ok: false, models: [], error: CANNOT_CONNECT_MESSAGE, reason: 'network' };
        return { ok: false, models: [], error: err instanceof Error ? err.message : '网络错误' };
    }
}

function parseErrorText(response: Response, responseText: string, requestLabel: string) {
    if (!responseText) return `${requestLabel}: HTTP ${response.status}`;

    if (looksLikeHtmlResponse(responseText)) {
        return `${requestLabel}: 返回了 HTML 页面，请检查 Base URL 是否指向 API 接口而不是网站首页。`;
    }

    try {
        const json = JSON.parse(responseText);
        const detail = json?.error?.message || json?.message || json?.detail;
        if (detail) return String(detail);
    } catch {
        // Fall back to plain text below.
    }

    return `${requestLabel}: ${truncateResponseSnippet(responseText)}`;
}

function shouldRetryWithAnotherBaseUrl(status: number, responseText: string) {
    if (looksLikeHtmlResponse(responseText)) return true;
    if (status === 404 && /invalid url|you may need|get \/v1\/models/i.test(responseText)) return true;
    return false;
}

// ── OpenAI / 兼容接口（DeepSeek、SiliconFlow、Qwen 等）──
async function fetchOpenAICompatibleModels(
    apiKey: string,
    baseUrl: string,
    provider: AIProvider
): Promise<FetchModelsResult> {
    const candidates = getOpenAICompatibleBaseUrlCandidates(provider, baseUrl);
    let lastError = '网络错误';
    let modelListUnavailable = false;
    // 只有所有候选地址都连不上时才报 network；任一候选给出 HTTP 响应，以那个响应为准。
    let networkFailed = false;
    let reachedServer = false;

    for (const candidateBaseUrl of candidates) {
        try {
            const url = `${candidateBaseUrl}/models`;
            const res = await fetchWithModelDiscoveryTimeout(url, {
                headers: { Authorization: `Bearer ${apiKey}` },
            });
            const text = await res.text().catch(() => '');
            reachedServer = true;

            if (!res.ok) {
                lastError = parseErrorText(res, text, '模型列表拉取失败');
                if ((res.status === 404 || res.status === 405) && !looksLikeHtmlResponse(text)) {
                    modelListUnavailable = true;
                }
                if (shouldRetryWithAnotherBaseUrl(res.status, text)) {
                    continue;
                }
                if (modelListUnavailable && (res.status === 404 || res.status === 405)) continue;
                return { ok: false, models: [], error: lastError };
            }

            if (looksLikeHtmlResponse(text)) {
                lastError = '模型列表响应返回了 HTML 页面，请检查 Base URL 是否指向 API 接口而不是网站首页。';
                continue;
            }

            const data = text ? JSON.parse(text) : {};
            const rawModels: any[] = data.data || data.models || [];
            const endpointFlavor = provider === 'openrouter' ? 'openrouter-compatible' : detectEndpointFlavor(candidateBaseUrl, rawModels);
            const models: FetchedModel[] = rawModels
                .filter((m: any) => {
                    const id: string = m.id || m.name || '';
                    return !(/embed|whisper|tts|moderation|babbage|davinci-002/i.test(id));
                })
                .map((m: any) => {
                    const id = m.id || m.name || '';
                    return {
                        id,
                        name: m.name || id,
                        capability: inferCapability(id, m),
                        description: m.description?.slice?.(0, 160),
                        inputModalities: m.architecture?.input_modalities,
                        outputModalities: m.architecture?.output_modalities,
                        supportedParameters: m.supported_parameters,
                        ...readModelCapabilityFields(m),
                    };
                });
            return {
                ok: true,
                models,
                modelDiscovery: 'available',
                endpointFlavor,
                capabilitySummary: summarizeCapabilities(models),
                effectiveBaseUrl: candidateBaseUrl,
            };
        } catch (err) {
            if (err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
                return { ok: false, models: [], error: '连接超时，请检查服务地址后重试；未能判定 API Key 是否有效。', reason: 'network' };
            }
            if (isNetworkFailure(err)) {
                networkFailed = true;
                lastError = CANNOT_CONNECT_MESSAGE;
                continue;
            }
            lastError = err instanceof Error ? err.message : '网络错误';
        }
    }

    if (modelListUnavailable) {
        return {
            ok: true,
            models: [],
            modelDiscovery: 'unavailable',
            endpointFlavor: provider === 'openrouter' ? 'openrouter-compatible' : 'openai-compatible',
            error: '未检测到模型列表，可手动填写模型 ID。',
            effectiveBaseUrl: candidates[0],
        };
    }

    if (networkFailed && !reachedServer) return { ok: false, models: [], error: CANNOT_CONNECT_MESSAGE, reason: 'network' };
    return { ok: false, models: [], error: lastError };
}

// ── RunningHub 标准模型 ─────────────────────────────
async function fetchRunningHubModels(apiKey: string, baseUrl?: string, options?: { forceDocs?: boolean }): Promise<FetchModelsResult> {
    const effectiveBaseUrl = normalizeProviderBaseUrl('runningHub', baseUrl || 'https://www.runninghub.cn/openapi/v2');
    const probe = await rhProbeApiKey(apiKey, effectiveBaseUrl);
    if (probe === 'unreachable') {
        return { ok: false, models: [], error: CANNOT_CONNECT_MESSAGE, reason: 'network' };
    }
    if (probe === 'invalid') {
        return { ok: false, models: [], error: 'RunningHub API Key 无效或权限不足' };
    }

    // 官方文档（llms.txt + api-NNN.md 的 OpenAPI schema）是 RunningHub 模型与线路能力的唯一来源：
    // 解析结果按站点缓存 24h；文档较多时首次解析可能较慢，超出等待预算后在后台继续，完成后通知订阅者。
    let pageModels: FetchedModel[] = [];
    try {
        const response = await fetchWithModelDiscoveryTimeout(runningHubDocsModelUrl(effectiveBaseUrl));
        if (response.ok) {
            pageModels = parseRunningHubPageModels(await response.text());
        }
    } catch (error) {
        // Public page fetch can fail behind strict networks; the user can still add model IDs manually.
        console.warn('[ModelFetcher] RunningHub 文档页模型列表拉取失败。', error);
    }
    const docsRefresh = refreshRunningHubDocRoutes({ baseUrl: effectiveBaseUrl, force: options?.forceDocs })
        .catch(error => { console.warn('[ModelFetcher] RunningHub 官方文档解析失败。', error); return null; });
    let waitTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([docsRefresh, new Promise(resolve => { waitTimer = setTimeout(resolve, RUNNINGHUB_DOCS_WAIT_MS); })]);
    if (waitTimer) clearTimeout(waitTimer);

    const models = runningHubModelList(effectiveBaseUrl, pageModels);
    return {
        ok: true,
        models,
        capabilitySummary: summarizeCapabilities(models),
        effectiveBaseUrl,
    };
}

/** 「获取模型」最多等待官方文档解析这么久；其余在后台完成（结果写入动态线路注册表并通知订阅者）。 */
const RUNNINGHUB_DOCS_WAIT_MS = 8_000;

/**
 * RunningHub 模型列表 = 官方文档解析出的线路（按站点）∪ page-api 列表。
 * 只有文档一条都拿不到时才回落到内置模型表（离线兜底）；无文档的 endpoint 登记为推断线路（仅展示、不核验）。
 */
export function runningHubModelList(baseUrl: string | undefined, extraModels: FetchedModel[] = []): FetchedModel[] {
    const site = runningHubDocSite(baseUrl);
    const docModels: FetchedModel[] = listDynamicRouteSchemas(site).map(schema => ({
        id: schema.routeId,
        name: schema.title || schema.routeId,
        capability: schema.capability,
        description: schema.description?.slice(0, 160) || 'RunningHub 标准模型',
    }));
    const fallbackModels: FetchedModel[] = hasDynamicRoutesForSite(site) ? [] : BUILTIN_RUNNINGHUB_MODELS.map(item => ({
        id: item.id,
        name: stripRunningHubVersionName(item.description) || item.id,
        capability: item.capability,
        description: item.description,
    }));
    const docIds = new Set(docModels.map(model => model.id));
    const others = mergeModelLists(fallbackModels, extraModels).filter(model => !docIds.has(model.id));
    registerInferredRunningHubRoutes(others.map(model => ({ id: model.id, categoryName: model.capability === 'video' ? 'image-to-video' : '' })));
    // 展示去重（仅非文档条目）：同能力 + 同去版本名只保留一条，官方更新版本时列表不膨胀。
    const uniqueOthers: FetchedModel[] = [];
    const seen = new Set<string>();
    for (const model of others) {
        const key = `${model.capability}|${stripRunningHubVersionName(model.name || model.id).toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        uniqueOthers.push({ ...model, name: stripRunningHubVersionName(model.name || model.id) || model.id });
    }
    return mergeModelLists(docModels, uniqueOthers);
}

// ── Provider 默认 Base URL ──────────────────────────
const PROVIDER_BASE_URLS: Partial<Record<AIProvider, string>> = {
    openai: 'https://api.openai.com/v1',
    openrouter: 'https://openrouter.ai/api/v1',
    deepseek: 'https://api.deepseek.com',
    siliconflow: 'https://api.siliconflow.cn/v1',
    qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    minimax: 'https://api.minimax.chat/v1',
    volcengine: 'https://ark.cn-beijing.volces.com/api/v3',
    runningHub: 'https://www.runninghub.cn/openapi/v2',
};

// ── 主入口 ──────────────────────────────────────────
export async function fetchModelsForProvider(
    provider: AIProvider,
    apiKey: string,
    baseUrl?: string,
    options?: { forceDocs?: boolean },
): Promise<FetchModelsResult> {
    if (provider === 'google') {
        return fetchGoogleModels(apiKey, baseUrl);
    }

    if (provider === 'runningHub') {
        return fetchRunningHubModels(apiKey, baseUrl, options);
    }

    // OpenAI 兼容类
    if (['openai', 'openrouter', 'deepseek', 'siliconflow', 'qwen', 'minimax', 'volcengine', 'openai_compatible', 'custom'].includes(provider)) {
        const url = baseUrl || PROVIDER_BASE_URLS[provider];
        if (!url) {
            return { ok: false, models: [], error: '未指定 Base URL' };
        }
        return fetchOpenAICompatibleModels(apiKey, url, provider);
    }

    // 其他 Provider 无法联网拉取，返回空（使用内置列表）
    return { ok: true, models: [] };
}

// ── 免费 Key 申请链接 ───────────────────────────────
export const FREE_KEY_LINKS: { provider: AIProvider; label: string; url: string; description: string }[] = [
    {
        provider: 'google',
        label: 'Google AI Studio',
        url: 'https://aistudio.google.com/apikey',
        description: '免费额度：每分钟 15 次请求，支持 Gemini 和 Imagen 模型',
    },
    {
        provider: 'deepseek',
        label: 'DeepSeek 开放平台',
        url: 'https://platform.deepseek.com/api_keys',
        description: '注册即送 500 万 Tokens，DeepSeek-V3 和 DeepSeek-R1',
    },
    {
        provider: 'volcengine',
        label: '火山引擎 (豆包)',
        url: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
        description: '注册赠送免费额度，支持豆包大模型',
    },
    {
        provider: 'minimax',
        label: 'MiniMax',
        url: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
        description: '注册即送额度，支持文本、图片和视频生成',
    },
];

// ── 模型缓存 ──────────────────────────────────────
const MODEL_CACHE_TTL = 60 * 60 * 1000; // 1 小时
// 缓存 key 带版本：模型目录/展示逻辑变更时 bump，强制旧缓存失效重拉
// V4：模型条目带上思考档位 / 上下文窗口字段。
const CACHE_KEY_PREFIX = 'modelCacheV4.';
const modelCacheStorage = localforage.createInstance({ name: 'iris', storeName: 'provider_model_cache' });

interface CachedModels {
    models: FetchedModel[];
    fetchedAt: number;
    endpointFlavor?: string;
}

async function getCachedModels(cacheIdentity: string): Promise<CachedModels | null> {
    try {
        const cached = await modelCacheStorage.getItem<CachedModels>(`${CACHE_KEY_PREFIX}${cacheIdentity}`);
        if (!cached) return null;
        if (Date.now() - cached.fetchedAt > MODEL_CACHE_TTL) return null;
        return cached;
    } catch {
        return null;
    }
}

async function setCachedModels(cacheIdentity: string, models: FetchedModel[], endpointFlavor?: string) {
    try {
        const entry: CachedModels = { models, fetchedAt: Date.now(), endpointFlavor };
        await modelCacheStorage.setItem(`${CACHE_KEY_PREFIX}${cacheIdentity}`, entry);
    } catch { /* storage full — silent */ }
}

function modelCacheIdentity(provider: AIProvider, apiKey: string, baseUrl?: string): string {
    const keyHash = bytesToHex(sha256(utf8ToBytes(apiKey))).slice(0, 32);
    const endpoint = baseUrl?.trim()
        ? normalizeProviderBaseUrl(provider, baseUrl)
        : 'default';
    const endpointHash = bytesToHex(sha256(utf8ToBytes(endpoint))).slice(0, 16);
    return `${provider}.${keyHash}.${endpointHash}`;
}

/**
 * 带缓存的模型拉取。TTL 内直接返回缓存，过期后自动重新拉取。
 */
export async function fetchModelsWithCache(
    provider: AIProvider,
    apiKey: string,
    baseUrl?: string,
    forceRefresh = false,
): Promise<FetchModelsResult> {
    const cacheKey = modelCacheIdentity(provider, apiKey, baseUrl);
    if (!forceRefresh) {
        const cached = await getCachedModels(cacheKey);
        if (cached) {
            let models = cached.models;
            if (provider === 'runningHub') {
                // 缓存命中也在后台按 TTL 刷新官方文档解析；列表以当前已解析的文档线路为准。
                void refreshRunningHubDocRoutes({ baseUrl }).catch(() => undefined);
                const docIds = new Set(listDynamicRouteSchemas(runningHubDocSite(baseUrl)).map(schema => schema.routeId));
                models = runningHubModelList(baseUrl, models.filter(model => !docIds.has(model.id)));
            }
            return {
                ok: true,
                models,
                endpointFlavor: cached.endpointFlavor as FetchModelsResult['endpointFlavor'],
                capabilitySummary: summarizeCapabilities(models),
            };
        }
    }
    // 显式「获取模型」（forceRefresh）同时强制重新解析 RunningHub 官方文档。
    const result = await fetchModelsForProvider(provider, apiKey, baseUrl, provider === 'runningHub' && forceRefresh ? { forceDocs: true } : undefined);
    if (result.ok && result.models.length > 0) {
        await setCachedModels(cacheKey, result.models, result.endpointFlavor);
    }
    return result;
}

/**
 * 批量刷新所有 API Key 对应的模型列表。
 * 返回每个 Key 的拉取结果，供 useApiKeys 合并到 userApiKeys 状态。
 */
export async function refreshAllProviderModels(
    keys: { id: string; provider: AIProvider; key: string; baseUrl?: string }[],
    forceRefresh = false,
): Promise<Map<string, FetchedModel[]>> {
    const results = new Map<string, FetchedModel[]>();
    const tasks = keys.map(async (k) => {
        try {
            const result = await fetchModelsWithCache(k.provider, k.key, k.baseUrl, forceRefresh);
            if (result.ok && result.models.length > 0) {
                results.set(k.id, result.models);
            }
        } catch { /* individual key failure doesn't block others */ }
    });
    await Promise.allSettled(tasks);
    return results;
}
