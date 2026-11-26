// 一次性迁移：老用户「今天生效的模型映射」→ 他们自己的 iris.service/1 声明（file-over-app 计划 F3）。
//
// 2026-11-27 用户决定：不内置任何模型映射；老用户现有的有效映射一次性迁成用户自己的声明，保留旧 id。
// 「今天生效」= 每把 Key 已存的 routeMappings ∪ 自动建议（与 hooks/useApiKeys 的 mergeSuggestedProductRouteMappings
// 同一合并），再按提交时同一套规则解析（resolveRouteMapping + getRouted*Modes，即 getResolvable*Modes 的口径）。
//
// 每个能解析的 (产品模型, 模式) → (Key, routeId) 生成到这把 Key 对应的服务下：
// - 模型 id = 旧产品 id（老节点的 config.modelId 不用改写）；按模式的 routeId 写 upstreamIdByMode；
// - 参数 / 参考上限 = 今天该线路下的有效能力（getEffectiveProductModelCapabilities / getEffectiveReferenceLimits），
//   模式之间不同的字段写进 modeOverrides；
// - 价格 = 今天计价会用到的 Key 计价规则（按 usageMonitor 的作用域：产品 > 线路 > Key 通用）；查不到 → unknown；
// - createdBy = migration，provenance.confirmed = true（用户今天就在用）。
// 同一模型的模式被多把 Key 分别承载、主线路不可用今天会「确认后切备用」等情况进迁移报告，不静默处理。
// 映射不到任何 Key 的内置模型不生成（用户没在用）；文本能力映射（润色 / Agent 文本等）是用户偏好，本迁移不动。
//
// 这是纯函数：不读写存储，不接入任何现有路径；接入（写 Vault config/services/、切换读取方）在后续步骤。
import type { ApiPricingRule, ProductModelMode, RouteMappingTarget, UserApiKey } from '../types';
import {
  SERVICE_MANIFEST_SCHEMA,
  parseServiceManifest,
  type ModelDeclaration,
  type ServiceManifest,
} from '../tools/iris/contracts/service-manifest.js';
import { mergeSuggestedProductRouteMappings } from './aiServiceSetup';
import {
  getEffectiveProductModelCapabilities,
  getEffectiveReferenceLimits,
  getProductModel,
  getRoutedImageModes,
  getRoutedVideoModes,
  type ProductModelCapability,
} from './productModelCatalog';
import { resolveRouteMapping } from './routeMapping';
import { protocolForLegacyProvider } from './legacyProviderProtocol';
import { assertVaultSegment } from '../tools/iris/contracts/vault/layout.js';

export const MAPPING_MIGRATION_VERSION = 'route-mappings-v1';

export type ModeRoute = { mode: ProductModelMode; keyId: string; routeId: string };

export type MappingMigrationReport = {
  /** 生成的模型声明：模型 id、所在服务、承载的模式。 */
  migrated: Array<{ modelId: string; serviceId: string; modes: ProductModelMode[] }>;
  /** 同一模型的部分模式今天由另一把 Key 承载：这些模式在新声明里落到派生 id 的模型下，老节点切到这些模式时需要重选模型。 */
  splitAcrossServices: Array<{ modelId: string; primaryServiceId: string; serviceId: string; derivedModelId: string; modes: ProductModelMode[] }>;
  /** 今天的首选线路不可用、提交时会弹「确认后切到备用」：迁移按今天实际会用的线路生成，原首选记在这里。 */
  primaryUnavailable: Array<{ modelId: string; mode: ProductModelMode; primaryServiceId: string; primaryRouteId: string; usedServiceId: string }>;
  /** 有映射但今天解析不出可用线路（Key 出错、线路不承载该模式、产品已不存在）：不生成声明。 */
  unresolved: Array<{ modelId: string; mode: ProductModelMode | null; reason: 'unknown-model' | 'no-available-route' | 'route-cannot-serve-mode' }>;
  /** 没动的文本能力映射条数（它们是用户对文本模型的选择，不是内置映射）。 */
  runtimeCapabilityMappings: number;
};

export type MappingMigrationResult = { manifests: ServiceManifest[]; report: MappingMigrationReport };

const MODE_ORDER: ProductModelMode[] = ['text-to-image', 'image-to-image', 'text-to-video', 'image-to-video', 'reference-to-video', 'first-last-frame', 'video-extension'];
const UNITS_BY_TYPE: Record<'image' | 'video', ApiPricingRule['unit'][]> = { image: ['image', 'request'], video: ['video_second', 'request'] };

/** Key id → 服务 id：能直接当文件名就原样用（secretRef 也指它），否则编码成安全段。 */
export function serviceIdForKey(keyId: string): string {
  try {
    return assertVaultSegment('serviceId', keyId);
  } catch {
    const safe = keyId.replace(/[^A-Za-z0-9_.@~-]/g, '_').replace(/^[^A-Za-z0-9]+/, '').slice(0, 100) || 'key';
    let hash = 0;
    for (const char of keyId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return `svc_${safe}_${hash.toString(36)}`;
  }
}

function routedModes(productModelId: string, capability: 'image' | 'video', key: UserApiKey, routeId: string) {
  return capability === 'video'
    ? getRoutedVideoModes(productModelId, key.provider, routeId)
    : getRoutedImageModes(productModelId, key.provider, routeId);
}

/** 与 utils/usageMonitor.ts pricingRulesFor 同一作用域：产品规则 > 线路规则 > Key 通用规则（不含分辨率 / 质量筛选，它们原样保留在规则里）。 */
function scopedPricingRules(key: UserApiKey, productModelId: string, routeId: string, type: 'image' | 'video'): ApiPricingRule[] {
  const supported = (key.pricingRules || []).filter(rule => UNITS_BY_TYPE[type].includes(rule.unit));
  const productRules = supported.filter(rule => rule.productModelId === productModelId);
  const routeRules = supported.filter(rule => rule.routeId === routeId);
  return productRules.length ? productRules : routeRules.length ? routeRules : supported.filter(rule => !rule.productModelId && !rule.routeId);
}

type Spec = { params: ModelDeclaration['params']; inputs: ModelDeclaration['inputs'] };

function effectiveSpec(productModelId: string, mode: ProductModelMode, key: UserApiKey, routeId: string): Spec {
  const caps = getEffectiveProductModelCapabilities(productModelId, mode, { provider: key.provider, routeId }) as ProductModelCapability;
  const limits = getEffectiveReferenceLimits(productModelId, mode, { provider: key.provider, routeId });
  return {
    params: {
      aspectRatios: [...caps.aspectRatios],
      resolutions: [...caps.resolutions],
      qualities: [...caps.qualities],
      counts: [...caps.counts],
      durations: [...caps.durations],
      audio: caps.audioControl,
      seed: caps.supportsSeed,
      webSearch: caps.supportsWebSearch,
      realPersonCheck: caps.supportsRealPersonCheck,
    },
    inputs: {
      maxImageRefs: limits.image,
      maxVideoRefs: limits.video,
      maxAudioRefs: limits.audio,
      ...(caps.referenceVideoLimits ? { referenceVideoLimits: { ...caps.referenceVideoLimits } } : {}),
      ...(caps.referenceVideoPixelRange ? { referenceVideoPixelRange: { ...caps.referenceVideoPixelRange } } : {}),
    },
  };
}

function isHttpUrl(value?: string): value is string {
  if (!value) return false;
  try { const url = new URL(value); return url.protocol === 'https:' || url.protocol === 'http:'; } catch { return false; }
}

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

function buildDeclaration(
  id: string,
  productModelId: string,
  displaySuffix: string,
  routes: ModeRoute[],
  key: UserApiKey,
): ModelDeclaration {
  const product = getProductModel(productModelId)!;
  const capability = product.capability;
  const specs = routes.map(route => ({ route, spec: effectiveSpec(productModelId, route.mode, key, route.routeId) }));
  // 模型级取首个模式的有效能力；其余模式只把不同的字段写进 modeOverrides。
  const base = specs[0].spec;
  // 模型级参考上限取各模式的最大值（声明校验要求「图生图 / 参考生视频」等模式能收到参考），每个模式的真实上限在 modeOverrides。
  const modelInputs = { ...base.inputs };
  for (const field of ['maxImageRefs', 'maxVideoRefs', 'maxAudioRefs'] as const) {
    modelInputs[field] = Math.max(...specs.map(({ spec }) => spec.inputs[field]));
  }
  const modeOverrides: NonNullable<ModelDeclaration['modeOverrides']> = {};
  for (const { route, spec } of specs) {
    const params = Object.fromEntries(Object.entries(spec.params).filter(([field, value]) => !same(value, base.params[field as keyof Spec['params']])));
    const inputs = Object.fromEntries(Object.entries(spec.inputs).filter(([field, value]) => !same(value, modelInputs[field as keyof Spec['inputs']])));
    if (Object.keys(params).length || Object.keys(inputs).length) {
      modeOverrides[route.mode] = { ...(Object.keys(params).length ? { params } : {}), ...(Object.keys(inputs).length ? { inputs } : {}) };
    }
  }
  const upstreamId = routes[0].routeId;
  const upstreamIdByMode = Object.fromEntries(routes.filter(route => route.routeId !== upstreamId).map(route => [route.mode, route.routeId]));
  // 价格：每个模式按今天的计价作用域取规则；各模式相同则不标模式，否则每条规则标上它所属的模式。
  const perMode = routes.map(route => ({ mode: route.mode, rules: scopedPricingRules(key, productModelId, route.routeId, capability) }));
  const toRule = (rule: ApiPricingRule, mode?: ProductModelMode) => ({
    unit: rule.unit,
    rate: rule.rate,
    currency: rule.currency,
    ...(rule.resolution ? { resolution: rule.resolution } : {}),
    ...(rule.quality ? { quality: rule.quality } : {}),
    ...(mode ? { mode } : {}),
  });
  const uniform = perMode.every(entry => same(entry.rules, perMode[0].rules));
  const rules = uniform
    ? perMode[0].rules.map(rule => toRule(rule))
    : perMode.flatMap(entry => entry.rules.map(rule => toRule(rule, entry.mode)));
  return {
    id,
    upstreamId,
    ...(Object.keys(upstreamIdByMode).length ? { upstreamIdByMode } : {}),
    displayName: `${product.name}${displaySuffix}`,
    vendor: product.company,
    description: product.description,
    nodeTypes: [capability],
    modes: routes.map(route => route.mode),
    inputs: modelInputs,
    params: base.params,
    ...(Object.keys(modeOverrides).length ? { modeOverrides } : {}),
    pricing: rules.length ? { basis: 'declared', rules } : { basis: 'unknown' },
    provenance: { prefilledFrom: 'migration', confirmed: true },
  } as ModelDeclaration;
}

/**
 * 计算迁移结果（纯函数）。now 作为 updatedAt，便于测试固定。
 */
export function migrateEffectiveMappingsToManifests(keys: UserApiKey[], now: string): MappingMigrationResult {
  const effectiveKeys = keys.map(mergeSuggestedProductRouteMappings);
  const keyById = new Map(effectiveKeys.map(key => [key.id, key]));
  const report: MappingMigrationReport = { migrated: [], splitAcrossServices: [], primaryUnavailable: [], unresolved: [], runtimeCapabilityMappings: 0 };

  const targets = new Map<string, Set<ProductModelMode>>();
  for (const key of effectiveKeys) {
    for (const mapping of key.routeMappings || []) {
      if (mapping.target.kind !== 'product-mode') { report.runtimeCapabilityMappings += 1; continue; }
      const modes = targets.get(mapping.target.productModelId) || new Set<ProductModelMode>();
      modes.add(mapping.target.mode);
      targets.set(mapping.target.productModelId, modes);
    }
  }

  const modelsByService = new Map<string, ModelDeclaration[]>();
  const push = (serviceId: string, model: ModelDeclaration) => modelsByService.set(serviceId, [...(modelsByService.get(serviceId) || []), model]);

  for (const [productModelId, mappedModes] of targets) {
    const product = getProductModel(productModelId);
    if (!product || product.id !== productModelId) {
      report.unresolved.push({ modelId: productModelId, mode: null, reason: 'unknown-model' });
      continue;
    }
    const resolved: ModeRoute[] = [];
    for (const mode of product.capabilities.modes) {
      if (!mappedModes.has(mode)) continue;
      const target: RouteMappingTarget = { kind: 'product-mode', productModelId, mode };
      const resolution = resolveRouteMapping(target, effectiveKeys);
      if (!resolution) { report.unresolved.push({ modelId: productModelId, mode, reason: 'no-available-route' }); continue; }
      if (!routedModes(productModelId, product.capability, resolution.key, resolution.routeId).includes(mode)) {
        report.unresolved.push({ modelId: productModelId, mode, reason: 'route-cannot-serve-mode' });
        continue;
      }
      if (resolution.status === 'confirmation-required') {
        report.primaryUnavailable.push({
          modelId: productModelId,
          mode,
          primaryServiceId: serviceIdForKey(resolution.unavailablePrimary.key.id),
          primaryRouteId: resolution.unavailablePrimary.routeId,
          usedServiceId: serviceIdForKey(resolution.key.id),
        });
      }
      resolved.push({ mode, keyId: resolution.key.id, routeId: resolution.routeId });
    }
    for (const mode of mappedModes) {
      if (!product.capabilities.modes.includes(mode)) report.unresolved.push({ modelId: productModelId, mode, reason: 'route-cannot-serve-mode' });
    }
    if (!resolved.length) continue;

    // 主服务 = 承载模式最多的 Key（并列取承载第一个模式的那把）；其他 Key 承载的模式落到派生 id 的模型下并报告。
    const byKey = new Map<string, ModeRoute[]>();
    for (const route of resolved) byKey.set(route.keyId, [...(byKey.get(route.keyId) || []), route]);
    const ordered = [...byKey].sort((left, right) => right[1].length - left[1].length
      || MODE_ORDER.indexOf(left[1][0].mode) - MODE_ORDER.indexOf(right[1][0].mode));
    const [primaryKeyId, primaryRoutes] = ordered[0];
    const primaryServiceId = serviceIdForKey(primaryKeyId);
    push(primaryServiceId, buildDeclaration(productModelId, productModelId, '', primaryRoutes, keyById.get(primaryKeyId)!));
    report.migrated.push({ modelId: productModelId, serviceId: primaryServiceId, modes: primaryRoutes.map(route => route.mode) });
    for (const [keyId, routes] of ordered.slice(1)) {
      const serviceId = serviceIdForKey(keyId);
      const key = keyById.get(keyId)!;
      const derivedModelId = `${productModelId}~${serviceId}`;
      push(serviceId, buildDeclaration(derivedModelId, productModelId, `（${key.name || key.provider}）`, routes, key));
      report.migrated.push({ modelId: derivedModelId, serviceId, modes: routes.map(route => route.mode) });
      report.splitAcrossServices.push({ modelId: productModelId, primaryServiceId, serviceId, derivedModelId, modes: routes.map(route => route.mode) });
    }
  }

  const manifests: ServiceManifest[] = [];
  for (const key of effectiveKeys) {
    const serviceId = serviceIdForKey(key.id);
    const models = modelsByService.get(serviceId);
    if (!models?.length) continue;
    const raw = {
      schema: SERVICE_MANIFEST_SCHEMA,
      id: serviceId,
      name: (key.name || key.provider).slice(0, 80),
      protocol: protocolForLegacyProvider(key.provider),
      ...(isHttpUrl(key.baseUrl) ? { baseUrl: key.baseUrl } : {}),
      secretRef: serviceId,
      status: key.status === 'error' ? 'disabled' : 'active',
      createdBy: { kind: 'migration', fromVersion: MAPPING_MIGRATION_VERSION },
      ...(key.streamUsage ? { streamUsage: key.streamUsage } : {}),
      ...(key.budgetPolicy ? { budget: { ...key.budgetPolicy } } : {}),
      // legacyKeyId：保险库条目仍按旧 Key id 存（secretRef 在 id 需要编码时与它不同）；legacyProvider：F2 前适配器仍按它分流。
      protocolOptions: { legacyProvider: key.provider, legacyKeyId: key.id, ...(key.baseUrl && !isHttpUrl(key.baseUrl) ? { legacyBaseUrl: key.baseUrl } : {}) },
      updatedAt: now,
      models,
    };
    const { manifest, issues } = parseServiceManifest(raw);
    // 迁移产物不合法 = 迁移器的 bug：抛错中止，原数据不动（调用方保留旧映射）。
    if (!manifest) throw new Error(`迁移生成的服务清单 ${serviceId} 不合法：${issues.map(issue => `${issue.path}: ${issue.message}`).join('; ')}`);
    manifests.push(manifest);
  }
  return { manifests, report };
}
