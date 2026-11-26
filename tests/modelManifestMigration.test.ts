import { describe, expect, it } from 'vitest';
import type { ProductModelMode, UserApiKey } from '../types';
import { mergeSuggestedProductRouteMappings } from '../services/aiServiceSetup';
import {
  PRODUCT_MODEL_CATALOG,
  getEffectiveProductModelCapabilities,
  getEffectiveReferenceLimits,
  getProductModel,
  getResolvableImageModes,
  getResolvableVideoModes,
  resolveProductModelRoute,
} from '../services/productModelCatalog';
import { migrateEffectiveMappingsToManifests, serviceIdForKey } from '../services/modelManifestMigration';
import { modelPriceKnown, modelSpecForMode, parseServiceManifest, type ServiceManifest } from '../tools/iris/contracts/service-manifest.js';
import { assertNoVaultSecrets } from '../tools/iris/contracts/vault/layout.js';

const NOW = '2026-11-27T00:00:00.000Z';
const base = { key: 'sk-test-secret-value-should-never-leak-000000', createdAt: 1, updatedAt: 1 };

const openaiKey: UserApiKey = {
  ...base, id: 'key-openai', provider: 'openai', name: 'OpenAI 主账号', capabilities: ['image', 'text'],
  baseUrl: 'https://api.openai.com/v1',
  models: [{ id: 'gpt-image-2', name: 'gpt-image-2' }, { id: 'gpt-5', name: 'gpt-5' }],
  pricingRules: [
    { id: 'r1', productModelId: 'flovart:gpt-image-2', unit: 'image', rate: 0.3, currency: 'CNY', resolution: '2K', source: 'manual' },
    { id: 'r2', unit: 'input_token', rate: 1, currency: 'USD', source: 'manual' },
  ],
  routeMappings: [{ target: { kind: 'runtime-capability', capability: 'agent-text' }, routeId: 'gpt-5', order: 0 }],
};
const googleKey: UserApiKey = {
  ...base, id: 'key-google', provider: 'google', capabilities: ['image', 'video'],
  models: [{ id: 'gemini-3.1-flash-image-preview', name: 'nb2' }, { id: 'veo-3.1-generate-preview', name: 'veo' }],
};
const arkKey = (id: string, order: number, status?: UserApiKey['status']): UserApiKey => ({
  ...base, id, provider: 'volcengine', capabilities: ['video'], status,
  models: [{ id: 'doubao-seedance-2-0-260128', name: 'Seedance 2.0' }],
  routeMappings: [{ target: { kind: 'product-mode', productModelId: 'flovart:seedance-2', mode: 'text-to-video' }, routeId: 'doubao-seedance-2-0-260128', order }],
});
const rhVideoKey = (id: string, modes: Array<'text-to-video' | 'image-to-video'>): UserApiKey => ({
  ...base, id, provider: 'runningHub', capabilities: ['video'], models: [],
  pricingRules: [{ id: `p-${id}`, routeId: 'rhart-video-v3.1-fast/image-to-video', unit: 'video_second', rate: 0.5, currency: 'CNY', source: 'manual' }],
  routeMappings: modes.map(mode => ({ target: { kind: 'product-mode' as const, productModelId: 'flovart:veo-3.1', mode }, routeId: `rhart-video-v3.1-fast/${mode}`, order: 0 })),
});
const rhImageKey: UserApiKey = {
  ...base, id: 'rh-key', provider: 'runningHub', capabilities: ['image', 'video'], baseUrl: 'https://www.runninghub.cn/openapi/v2',
  models: [{ id: 'seedream-v5-flash/text-to-image', name: 'seedream-v5-flash-文生图' }],
};

const UNITS = { image: ['image', 'request'], video: ['video_second', 'request'] } as const;

/** 行为等价：迁移前（今天的有效映射）与迁移后（用户声明）对每个产品模型、每个模式给出同一线路、同一能力、同一计价规则。 */
function expectEquivalent(keys: UserApiKey[], manifests: ServiceManifest[]) {
  const effective = keys.map(mergeSuggestedProductRouteMappings);
  const declared = new Map(manifests.flatMap(manifest => manifest.models.map(model => [model.id, { manifest, model }] as const)));
  let checked = 0;
  for (const product of PRODUCT_MODEL_CATALOG) {
    const before = product.capability === 'video' ? getResolvableVideoModes(product.id, effective) : getResolvableImageModes(product.id, effective);
    const owners = [...declared.values()].filter(({ model }) => model.id === product.id || model.id.startsWith(`${product.id}~`));
    const after = owners.flatMap(({ model }) => model.modes as ProductModelMode[]);
    expect(new Set(after), product.id).toEqual(new Set(before));
    for (const mode of before) {
      const route = resolveProductModelRoute(product.id, mode, effective)!;
      const owner = owners.find(({ model }) => model.modes.includes(mode))!;
      const spec = modelSpecForMode(owner.model, mode);
      expect(owner.manifest.id, `${product.id} ${mode}`).toBe(serviceIdForKey(route.key.id));
      expect(spec.upstreamId, `${product.id} ${mode}`).toBe(route.routeId);
      const context = { provider: route.key.provider, routeId: route.routeId };
      const caps = getEffectiveProductModelCapabilities(product.id, mode, context)!;
      const limits = getEffectiveReferenceLimits(product.id, mode, context);
      expect(spec.params, `${product.id} ${mode} params`).toEqual({
        aspectRatios: caps.aspectRatios, resolutions: caps.resolutions, qualities: caps.qualities, counts: caps.counts, durations: caps.durations,
        audio: caps.audioControl, seed: caps.supportsSeed, webSearch: caps.supportsWebSearch, realPersonCheck: caps.supportsRealPersonCheck,
      });
      expect([spec.inputs.maxImageRefs, spec.inputs.maxVideoRefs, spec.inputs.maxAudioRefs], `${product.id} ${mode} refs`).toEqual([limits.image, limits.video, limits.audio]);
      expect(spec.inputs.referenceVideoLimits).toEqual(caps.referenceVideoLimits);
      expect(spec.inputs.referenceVideoPixelRange).toEqual(caps.referenceVideoPixelRange);
      // 计价作用域与 usageMonitor 一致：产品 > 线路 > Key 通用
      const supported = (route.key.pricingRules || []).filter(rule => (UNITS[product.capability] as readonly string[]).includes(rule.unit));
      const productRules = supported.filter(rule => rule.productModelId === product.id);
      const routeRules = supported.filter(rule => rule.routeId === route.routeId);
      const scoped = productRules.length ? productRules : routeRules.length ? routeRules : supported.filter(rule => !rule.productModelId && !rule.routeId);
      const declaredRules = owner.model.pricing.basis === 'declared' ? owner.model.pricing.rules.filter(rule => !rule.mode || rule.mode === mode) : [];
      expect(declaredRules.map(rule => [rule.unit, rule.rate, rule.currency, rule.resolution, rule.quality]), `${product.id} ${mode} pricing`)
        .toEqual(scoped.map(rule => [rule.unit, rule.rate, rule.currency, rule.resolution, rule.quality]));
      checked += 1;
    }
  }
  return checked;
}

describe('one-time migration: effective route mappings → user iris.service/1 declarations', () => {
  it('OpenAI / Google / Ark / RunningHub keys: same routes, capabilities and prices before and after', () => {
    const keys = [openaiKey, googleKey, arkKey('ark-main', 0), rhVideoKey('rh-video', ['text-to-video', 'image-to-video']), rhImageKey];
    const { manifests, report } = migrateEffectiveMappingsToManifests(keys, NOW);
    expect(expectEquivalent(keys, manifests)).toBeGreaterThanOrEqual(8);
    expect(report.unresolved).toEqual([]);
    expect(report.splitAcrossServices).toEqual([]);
    expect(report.runtimeCapabilityMappings).toBe(1);
    const ids = manifests.flatMap(manifest => manifest.models.map(model => model.id));
    expect(ids).toEqual(expect.arrayContaining(['flovart:gpt-image-2', 'flovart:gemini-3.1-flash-image', 'flovart:veo-3.1', 'flovart:seedance-2', 'flovart:seedream-5-flash']));
    // 没被任何 Key 映射的内置模型不生成
    expect(ids).not.toContain('flovart:kling-video-3');
    expect(ids).not.toContain('flovart:midjourney-v8-1');
  });

  it('keeps old ids, marks the source as migration, copies declared prices and leaves unknown prices unknown', () => {
    const { manifests } = migrateEffectiveMappingsToManifests([openaiKey, googleKey], NOW);
    const openai = manifests.find(manifest => manifest.id === 'key-openai')!;
    expect(openai).toMatchObject({
      name: 'OpenAI 主账号', protocol: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', secretRef: 'key-openai', status: 'active',
      createdBy: { kind: 'migration', fromVersion: 'route-mappings-v1' }, protocolOptions: { legacyProvider: 'openai', legacyKeyId: 'key-openai' },
    });
    const gpt = openai.models.find(model => model.id === 'flovart:gpt-image-2')!;
    expect(gpt).toMatchObject({ upstreamId: 'gpt-image-2', provenance: { prefilledFrom: 'migration', confirmed: true } });
    expect(gpt.pricing).toEqual({ basis: 'declared', rules: [{ unit: 'image', rate: 0.3, currency: 'CNY', resolution: '2K' }] });
    const google = manifests.find(manifest => manifest.id === 'key-google')!;
    expect(google.protocol).toBe('gemini');
    for (const model of google.models) expect(modelPriceKnown(model), model.id).toBe(false);
  });

  it('never copies a key into the manifests, and every manifest re-parses', () => {
    const { manifests } = migrateEffectiveMappingsToManifests([openaiKey, googleKey, arkKey('ark-main', 0), rhImageKey], NOW);
    for (const manifest of manifests) {
      expect(JSON.stringify(manifest)).not.toContain(base.key);
      expect(() => assertNoVaultSecrets(manifest)).not.toThrow();
      expect(parseServiceManifest(JSON.parse(JSON.stringify(manifest))).issues).toEqual([]);
    }
  });

  it('per-mode routes on one service become upstreamIdByMode and route-specific prices stay with their mode', () => {
    const keys = [rhVideoKey('rh-video', ['text-to-video', 'image-to-video'])];
    const { manifests } = migrateEffectiveMappingsToManifests(keys, NOW);
    const veo = manifests[0].models.find(model => model.id === 'flovart:veo-3.1')!;
    expect(veo.upstreamId).toBe('rhart-video-v3.1-fast/text-to-video');
    expect(veo.upstreamIdByMode).toEqual({ 'image-to-video': 'rhart-video-v3.1-fast/image-to-video' });
    expect(veo.pricing).toEqual({ basis: 'declared', rules: [{ unit: 'video_second', rate: 0.5, currency: 'CNY', mode: 'image-to-video' }] });
    expectEquivalent(keys, manifests);
  });

  it('reports a primary that is down today (fallback needed confirmation) instead of hiding it', () => {
    const keys = [arkKey('ark-primary', 0, 'error'), arkKey('ark-backup', 10)];
    const { manifests, report } = migrateEffectiveMappingsToManifests(keys, NOW);
    expectEquivalent(keys, manifests);
    expect(report.primaryUnavailable).toEqual([expect.objectContaining({ modelId: 'flovart:seedance-2', mode: 'text-to-video', primaryServiceId: 'ark-primary', usedServiceId: 'ark-backup' })]);
  });

  it('modes served by two different keys: primary keeps the old id, the other mode moves to a derived id and is reported', () => {
    const keys = [rhVideoKey('rh-a', ['text-to-video']), rhVideoKey('rh-b', ['image-to-video'])];
    const { manifests, report } = migrateEffectiveMappingsToManifests(keys, NOW);
    expectEquivalent(keys, manifests);
    expect(report.splitAcrossServices).toEqual([{ modelId: 'flovart:veo-3.1', primaryServiceId: 'rh-a', serviceId: 'rh-b', derivedModelId: 'flovart:veo-3.1~rh-b', modes: ['image-to-video'] }]);
    expect(manifests.find(manifest => manifest.id === 'rh-a')!.models.map(model => model.id)).toEqual(['flovart:veo-3.1']);
  });

  it('reports mappings that do not resolve today and generates nothing for them', () => {
    const stale: UserApiKey = {
      ...base, id: 'key stale/1', provider: 'openai', capabilities: ['image'], models: [{ id: 'gpt-image-2', name: 'x' }],
      routeMappings: [
        { target: { kind: 'product-mode', productModelId: 'flovart:removed-model', mode: 'text-to-image' }, routeId: 'x', order: 0 },
        { target: { kind: 'product-mode', productModelId: 'flovart:imagen-4', mode: 'image-to-image' }, routeId: 'imagen-4.0-generate-001', order: 0 },
      ],
    };
    const { manifests, report } = migrateEffectiveMappingsToManifests([stale], NOW);
    expect(report.unresolved).toEqual(expect.arrayContaining([
      { modelId: 'flovart:removed-model', mode: null, reason: 'unknown-model' },
      { modelId: 'flovart:imagen-4', mode: 'image-to-image', reason: 'route-cannot-serve-mode' },
    ]));
    // 不安全的 Key id 被编码成合法服务 id；保险库仍按旧 id 找
    expect(manifests[0].id).toMatch(/^svc_key_stale_1_[a-z0-9]+$/);
    expect(manifests[0].protocolOptions).toMatchObject({ legacyKeyId: 'key stale/1' });
    expectEquivalent([stale], manifests);
  });

  it('is a pure function: same input, same output; inputs untouched', () => {
    const keys = [openaiKey, googleKey];
    const snapshot = JSON.stringify(keys);
    expect(migrateEffectiveMappingsToManifests(keys, NOW)).toEqual(migrateEffectiveMappingsToManifests(keys, NOW));
    expect(JSON.stringify(keys)).toBe(snapshot);
    expect(getProductModel('flovart:gpt-image-2')).toBeDefined();
  });
});
