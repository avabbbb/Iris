// iris.service/1 —— 用户声明的 AI 服务与模型清单（file-over-app 计划 F1）。
//
// 2026-11-27 用户决定：Iris 不内置任何模型映射。每个模型由用户或替用户操作的 Agent 在添加服务时声明：
// 显示名、节点类型、模式、参数、参考上限、价格。这份清单就是声明本身，存在 Vault 的
// config/services/<serviceId>.json，**永远不含 Key**（Key 在本机保险库，用 secretRef 关联）。
//
// 代码里保留的只有「词表」（节点类型、模式、协议）——每个模式对应节点上不同的输入槽与协议序列化，
// 每个协议对应一个请求适配器；**哪个模型支持哪个模式、多少参考、什么价格，全部来自声明**。
//
// - 上游自己返回的能力（OpenRouter /models、RunningHub 官方文档）可以预填，但 provenance.confirmed=false，
//   在用户确认前不生效（isModelEffective）。
// - pricing.basis='unknown'（默认）= 价格未知：每次都要用户审批，金额型预算不能放行（modelPriceKnown）。
// - local-agent 服务只有声明（driverRef + hostDeviceIds），可执行的命令模板只在本机 ~/.iris，
//   所以 protocolOptions 不接受 command / argv / env 之类的键，也不接受嵌套对象。
//
// 浏览器与 CLI（随 @flovart/cli 的 contracts/ 发布）共用本文件。

import { z } from 'zod';
import { assertVaultSegment, findVaultSecrets } from './vault/layout.js';

export const SERVICE_MANIFEST_SCHEMA = 'iris.service/1';

/** 节点类型词表。 */
export const MODEL_NODE_TYPES = /** @type {const} */ (['text', 'image', 'video', 'audio']);

/** 模式词表（沿用 ProductModelMode；新增模式要同时实现节点输入槽与协议序列化）。 */
export const MODEL_MODES = /** @type {const} */ ([
  'text-to-image',
  'image-to-image',
  'text-to-video',
  'image-to-video',
  'reference-to-video',
  'first-last-frame',
  'video-extension',
]);
const IMAGE_MODES = new Set(['text-to-image', 'image-to-image']);

/** 协议词表 = 代码里已有的请求适配器（线协议知识，不是模型映射）。 */
export const SERVICE_PROTOCOLS = /** @type {const} */ ([
  'openai-compatible',
  'openrouter',
  'anthropic',
  'gemini',
  'volcengine-ark',
  'xai',
  'runningHub',
  'keling',
  'minimax',
  'flux',
  'midjourney',
  'user-script',
  'local-agent',
]);

export const PRICING_UNITS = /** @type {const} */ (['request', 'image', 'video_second', 'input_token', 'output_token']);

/** protocolOptions 里禁止出现的键：同步目录里不能有可执行内容（设计 §8.4）。 */
const FORBIDDEN_OPTION_KEYS = new Set(['command', 'argv', 'args', 'exec', 'executable', 'shell', 'env', 'cwd', 'script', 'bin', 'binary', 'path']);

const segmentId = (kind) => z.string().refine(value => {
  try { assertVaultSegment(kind, value); return true; } catch { return false; }
}, { message: `${kind} 只能用字母、数字与 _ . @ ~ -，不能以 . 开头` });

const httpUrl = z.string().max(2048).refine(value => {
  try { const url = new URL(value); return url.protocol === 'https:' || url.protocol === 'http:'; } catch { return false; }
}, { message: '必须是 http(s) URL' });

const isoTime = z.string().refine(value => !Number.isNaN(Date.parse(value)), { message: '必须是 ISO 时间' });

const optionValue = z.union([z.string().max(2048), z.number(), z.boolean(), z.null(), z.array(z.union([z.string().max(512), z.number()])).max(200)]);
const protocolOptions = z.record(z.string().max(64), optionValue).superRefine((options, ctx) => {
  for (const key of Object.keys(options)) {
    if (FORBIDDEN_OPTION_KEYS.has(key.toLowerCase())) {
      ctx.addIssue({ code: 'custom', path: [key], message: `protocolOptions 不能含可执行配置「${key}」：命令模板只存在本机 ~/.iris，不进 Vault` });
    }
  }
});

const uniqueArray = (item, label) => z.array(item).superRefine((values, ctx) => {
  const seen = new Set();
  values.forEach((value, index) => {
    const key = JSON.stringify(value);
    if (seen.has(key)) ctx.addIssue({ code: 'custom', path: [index], message: `${label} 重复：${value}` });
    seen.add(key);
  });
});

const refCount = z.number().int().min(0).max(100);
const referenceVideoLimits = z.strictObject({
  minDurationSec: z.number().positive().optional(),
  maxDurationSec: z.number().positive().optional(),
  maxTotalDurationSec: z.number().positive().optional(),
  maxBytes: z.number().int().positive().optional(),
  minAspectRatio: z.number().positive().optional(),
  maxAspectRatio: z.number().positive().optional(),
});

const pixelRange = z.strictObject({ min: z.number().int().positive(), max: z.number().int().positive() })
  .refine(range => range.min <= range.max, { message: 'min 不能大于 max' });
const inputFields = {
  maxImageRefs: refCount,
  maxVideoRefs: refCount,
  maxAudioRefs: refCount,
  referenceVideoLimits: referenceVideoLimits.optional(),
  referenceVideoPixelRange: pixelRange.optional(),
};
const modelInputs = z.strictObject({
  ...inputFields,
  maxImageRefs: refCount.default(0),
  maxVideoRefs: refCount.default(0),
  maxAudioRefs: refCount.default(0),
});

const paramFields = {
  aspectRatios: uniqueArray(z.string().min(1).max(16), '比例'),
  resolutions: uniqueArray(z.string().min(1).max(16), '分辨率'),
  qualities: uniqueArray(z.string().min(1).max(16), '质量'),
  counts: uniqueArray(z.number().int().min(1).max(16), '数量'),
  // -1 = 由模型自动决定时长（Seedance 的「自动」档）
  durations: uniqueArray(z.number().refine(value => value === -1 || value > 0, { message: '时长必须 > 0 或为 -1（自动）' }), '时长'),
  audio: z.enum(['none', 'optional', 'always']),
  seed: z.boolean(),
  webSearch: z.boolean(),
  realPersonCheck: z.boolean(),
};
const modelParams = z.strictObject({
  aspectRatios: paramFields.aspectRatios.default([]),
  resolutions: paramFields.resolutions.default([]),
  qualities: paramFields.qualities.default([]),
  counts: paramFields.counts.default([]),
  durations: paramFields.durations.default([]),
  audio: paramFields.audio.default('none'),
  seed: paramFields.seed.default(false),
  webSearch: paramFields.webSearch.default(false),
  realPersonCheck: paramFields.realPersonCheck.default(false),
});

/**
 * 按模式覆盖：同一个模型的不同模式可能走不同上游线路（RunningHub 的文生 / 图生是两条线路），
 * 参数选项与参考上限也随之不同。这里只写与模型级不同的字段，未写的沿用模型级（modelSpecForMode）。
 */
const modeOverride = z.strictObject({
  params: z.strictObject(Object.fromEntries(Object.entries(paramFields).map(([key, schema]) => [key, schema.optional()]))).optional(),
  inputs: z.strictObject(Object.fromEntries(Object.entries(inputFields).map(([key, schema]) => [key, schema.optional()]))).optional(),
});

const pricingRule = z.strictObject({
  unit: z.enum(PRICING_UNITS),
  rate: z.number().min(0).max(1_000_000),
  currency: z.enum(['USD', 'CNY']),
  resolution: z.string().max(16).optional(),
  quality: z.string().max(16).optional(),
  mode: z.enum(MODEL_MODES).optional(),
});
const pricing = z.discriminatedUnion('basis', [
  z.strictObject({ basis: z.literal('unknown') }),
  z.strictObject({ basis: z.literal('declared'), rules: z.array(pricingRule).min(1).max(200) }),
]);

const modelId = z.string().min(1).max(200).regex(/^\S+$/, { message: '模型 id 不能含空白' });

const modelDeclaration = z.strictObject({
  id: modelId,
  upstreamId: z.string().min(1).max(300),
  upstreamIdByMode: z.partialRecord(z.enum(MODEL_MODES), z.string().min(1).max(300)).optional(),
  modeOverrides: z.partialRecord(z.enum(MODEL_MODES), modeOverride).optional(),
  displayName: z.string().trim().min(1).max(120),
  vendor: z.string().max(80).optional(),
  description: z.string().max(1000).optional(),
  nodeTypes: uniqueArray(z.enum(MODEL_NODE_TYPES), '节点类型').min(1),
  modes: uniqueArray(z.enum(MODEL_MODES), '模式').default([]),
  inputs: modelInputs.default({ maxImageRefs: 0, maxVideoRefs: 0, maxAudioRefs: 0 }),
  params: modelParams.default({ aspectRatios: [], resolutions: [], qualities: [], counts: [], durations: [], audio: 'none', seed: false, webSearch: false, realPersonCheck: false }),
  protocolOptions: protocolOptions.optional(),
  pricing: pricing.default({ basis: 'unknown' }),
  fallbacks: uniqueArray(modelId, '备选模型').max(20).optional(),
  verified: z.strictObject({
    at: isoTime,
    by: z.enum(['test-call', 'user']),
    result: z.enum(['ok', 'failed']),
    modes: z.array(z.enum(MODEL_MODES)).optional(),
  }).optional(),
  provenance: z.strictObject({
    prefilledFrom: z.enum(['upstream-models-endpoint', 'runningHub-docs', 'migration', 'user', 'agent']).optional(),
    confirmed: z.boolean(),
  }).optional(),
}).superRefine((model, ctx) => {
  for (const [index, mode] of model.modes.entries()) {
    const needs = IMAGE_MODES.has(mode) ? 'image' : 'video';
    if (!model.nodeTypes.includes(needs)) ctx.addIssue({ code: 'custom', path: ['modes', index], message: `模式 ${mode} 需要节点类型 ${needs}` });
  }
  if ((model.nodeTypes.includes('image') || model.nodeTypes.includes('video')) && model.modes.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['modes'], message: '图像 / 视频模型至少要声明一个模式' });
  }
  const refsFor = { 'image-to-image': ['maxImageRefs'], 'image-to-video': ['maxImageRefs'], 'video-extension': ['maxVideoRefs'], 'reference-to-video': ['maxImageRefs', 'maxVideoRefs', 'maxAudioRefs'] };
  for (const [mode, fields] of Object.entries(refsFor)) {
    if (model.modes.includes(/** @type {any} */ (mode)) && fields.every(field => model.inputs[field] === 0)) {
      ctx.addIssue({ code: 'custom', path: ['inputs'], message: `声明了 ${mode} 却不接收任何参考（${fields.join(' / ')} 全是 0）` });
    }
  }
  for (const mode of Object.keys(model.upstreamIdByMode || {})) {
    if (!model.modes.includes(/** @type {any} */ (mode))) ctx.addIssue({ code: 'custom', path: ['upstreamIdByMode', mode], message: `upstreamIdByMode 的 ${mode} 不在 modes 里` });
  }
  for (const mode of Object.keys(model.modeOverrides || {})) {
    if (!model.modes.includes(/** @type {any} */ (mode))) ctx.addIssue({ code: 'custom', path: ['modeOverrides', mode], message: `modeOverrides 的 ${mode} 不在 modes 里` });
  }
  if (model.fallbacks?.includes(model.id)) ctx.addIssue({ code: 'custom', path: ['fallbacks'], message: '备选模型不能是自己' });
});

const createdBy = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('user') }),
  z.strictObject({ kind: z.literal('agent'), name: z.string().min(1).max(80) }),
  z.strictObject({ kind: z.literal('migration'), fromVersion: z.string().min(1).max(40) }),
]);

export const serviceManifestSchema = z.strictObject({
  schema: z.literal(SERVICE_MANIFEST_SCHEMA),
  id: segmentId('serviceId'),
  name: z.string().trim().min(1).max(80),
  protocol: z.enum(SERVICE_PROTOCOLS),
  baseUrl: httpUrl.optional(),
  secretRef: segmentId('secretRef').optional(),
  notes: z.string().max(2000).optional(),
  website: httpUrl.optional(),
  status: z.enum(['active', 'pending-user-confirm', 'disabled']),
  createdBy,
  hostDeviceIds: uniqueArray(segmentId('deviceId'), '设备').max(32).optional(),
  streamUsage: z.enum(['passive', 'request']).optional(),
  budget: z.strictObject({
    enabled: z.boolean(),
    monthlyLimit: z.number().min(0),
    warningPercent: z.number().min(0).max(100),
    hardStop: z.boolean(),
    currency: z.enum(['USD', 'CNY']),
  }).optional(),
  protocolOptions: protocolOptions.optional(),
  updatedAt: isoTime,
  models: z.array(modelDeclaration).max(1000),
}).superRefine((service, ctx) => {
  const ids = new Map();
  service.models.forEach((model, index) => {
    if (ids.has(model.id)) ctx.addIssue({ code: 'custom', path: ['models', index, 'id'], message: `模型 id 重复：${model.id}` });
    ids.set(model.id, index);
  });
  if (service.protocol === 'local-agent') {
    if (service.baseUrl) ctx.addIssue({ code: 'custom', path: ['baseUrl'], message: 'local-agent 服务没有请求地址' });
    if (service.secretRef) ctx.addIssue({ code: 'custom', path: ['secretRef'], message: 'local-agent 服务没有 Key' });
    if (!service.hostDeviceIds?.length) ctx.addIssue({ code: 'custom', path: ['hostDeviceIds'], message: 'local-agent 服务必须声明在哪台设备上可用' });
    service.models.forEach((model, index) => {
      if (typeof model.protocolOptions?.driverRef !== 'string' || !model.protocolOptions.driverRef) {
        ctx.addIssue({ code: 'custom', path: ['models', index, 'protocolOptions', 'driverRef'], message: 'local-agent 模型必须引用本机驱动 driverRef' });
      }
    });
  } else if (service.hostDeviceIds?.length) {
    ctx.addIssue({ code: 'custom', path: ['hostDeviceIds'], message: '只有 local-agent 服务声明 hostDeviceIds' });
  }
  for (const finding of findVaultSecrets(service)) {
    ctx.addIssue({ code: 'custom', path: finding.path.split(/[.[\]]/).filter(Boolean), message: `清单里不能有秘密（${finding.reason}）；Key 只放本机保险库，用 secretRef 关联` });
  }
});

/** @typedef {import('zod').infer<typeof serviceManifestSchema>} ServiceManifest */
/** @typedef {ServiceManifest['models'][number]} ModelDeclaration */
/** @typedef {typeof MODEL_MODES[number]} ModelMode */

/**
 * 解析并校验一份 iris.service/1 清单。不抛错：合法时 manifest 为解析结果、issues 为空；
 * 不合法时 manifest 为 null、issues 列出每个问题（path 用 . 连接）。
 * （仓库 tsconfig 不开 strict，布尔判别联合收窄不可靠，所以不用 { ok } 联合。）
 * @param {unknown} input
 * @returns {{ manifest: ServiceManifest | null, issues: Array<{ path: string, message: string }> }}
 */
export function parseServiceManifest(input) {
  const result = serviceManifestSchema.safeParse(input);
  if (result.success) return { manifest: result.data, issues: [] };
  return {
    manifest: null,
    issues: result.error.issues.map(issue => ({ path: issue.path.map(String).join('.') || '$', message: issue.message })),
  };
}

/**
 * 声明是否生效：服务启用中，且模型不是「未确认的预填」。
 * @param {Pick<ServiceManifest, 'status'>} service @param {Pick<ModelDeclaration, 'provenance'>} model
 */
export function isModelEffective(service, model) {
  return service.status === 'active' && model.provenance?.confirmed !== false;
}

/**
 * 价格是否已由用户声明。false = 价格未知：每次调用都要用户审批，金额型预算不能放行。
 * @param {Pick<ModelDeclaration, 'pricing'>} model
 */
export function modelPriceKnown(model) {
  return model.pricing?.basis === 'declared' && model.pricing.rules.length > 0;
}

/**
 * 某个模式实际发给上游的模型名 / 线路 id。
 * @param {Pick<ModelDeclaration, 'upstreamId' | 'upstreamIdByMode'>} model @param {ModelMode} mode
 */
export function upstreamIdForMode(model, mode) {
  return model.upstreamIdByMode?.[mode] || model.upstreamId;
}

/**
 * 某个模式下实际生效的上游 id、参数与参考上限（模型级 + modeOverrides 合并）。
 * @param {ModelDeclaration} model @param {ModelMode} mode
 */
export function modelSpecForMode(model, mode) {
  const override = model.modeOverrides?.[mode];
  return {
    upstreamId: upstreamIdForMode(model, mode),
    params: { ...model.params, ...(override?.params || {}) },
    inputs: { ...model.inputs, ...(override?.inputs || {}) },
  };
}
