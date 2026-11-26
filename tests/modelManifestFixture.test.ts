import { describe, expect, it } from 'vitest';
import { PRODUCT_MODEL_CATALOG, getProductModel, getProductModels } from '../services/productModelCatalog';
import {
  BUILTIN_MODEL_IDS,
  builtinLegacyProvider,
  builtinModelDeclaration,
  builtinModelManifests,
  modelManifestFixture,
} from './helpers/modelManifestFixture';

// 冻结副本 ↔ 现行内置目录逐字段对拍。内置目录删除（计划 F6）时这个测试随之删除，
// 冻结副本成为旧 id 的唯一声明来源；在那之前，目录改了能力而副本没跟上 → 这里失败。
describe('modelManifestFixture', () => {
  it('declares exactly the built-in catalog models, in catalog order', () => {
    expect(BUILTIN_MODEL_IDS).toEqual(PRODUCT_MODEL_CATALOG.map(model => model.id));
    expect(BUILTIN_MODEL_IDS).toHaveLength(19);
    expect(new Set([...getProductModels('image'), ...getProductModels('video')].map(model => model.id))).toEqual(new Set(BUILTIN_MODEL_IDS));
  });

  it.each(PRODUCT_MODEL_CATALOG.map(model => model.id))('%s: frozen declaration equals the live catalog capability', id => {
    const live = getProductModel(id)!;
    const declared = builtinModelDeclaration(id) as Record<string, any>;
    expect(builtinLegacyProvider(id)).toBe(live.provider);
    expect(declared).toMatchObject({
      id: live.id,
      displayName: live.name,
      vendor: live.company,
      nodeTypes: [live.capability],
      modes: live.capabilities.modes,
      pricing: { basis: 'unknown' },
    });
    expect([...live.officialModelIds, ...live.aliases, live.id.replace(/^flovart:/, '')]).toContain(declared.upstreamId);
    expect(declared.inputs).toEqual({
      maxImageRefs: live.capabilities.maxImageReferences,
      maxVideoRefs: live.capabilities.maxVideoReferences,
      maxAudioRefs: live.capabilities.maxAudioReferences,
      ...(live.capabilities.referenceVideoLimits ? { referenceVideoLimits: live.capabilities.referenceVideoLimits } : {}),
      ...(live.capabilities.referenceVideoPixelRange ? { referenceVideoPixelRange: live.capabilities.referenceVideoPixelRange } : {}),
    });
    expect(declared.params).toEqual({
      aspectRatios: live.capabilities.aspectRatios,
      resolutions: live.capabilities.resolutions,
      qualities: live.capabilities.qualities,
      counts: live.capabilities.counts,
      durations: live.capabilities.durations,
      audio: live.capabilities.audioControl,
      seed: live.capabilities.supportsSeed,
      webSearch: live.capabilities.supportsWebSearch,
      realPersonCheck: live.capabilities.supportsRealPersonCheck,
    });
  });

  it('every built-in model is a valid iris.service/1 declaration, grouped by protocol', () => {
    const manifests = builtinModelManifests();
    expect(manifests.flatMap(manifest => manifest.models.map(model => model.id)).sort()).toEqual([...BUILTIN_MODEL_IDS].sort());
    const byId = new Map(manifests.flatMap(manifest => manifest.models.map(model => [model.id, manifest] as const)));
    expect(byId.get('flovart:gpt-image-2')?.protocol).toBe('openai-compatible');
    expect(byId.get('flovart:seedance-2')?.protocol).toBe('volcengine-ark');
    expect(byId.get('flovart:veo-3.1')?.protocol).toBe('gemini');
    expect(byId.get('flovart:grok-imagine-video')?.protocol).toBe('xai');
  });

  it('builds custom manifests from ids or partial declarations and rejects invalid fixtures', () => {
    const manifest = modelManifestFixture({
      id: 'svc_rh',
      protocol: 'runningHub',
      models: [{ id: 'flovart:seedance-2', upstreamId: 'seedance-v2/text-to-video', pricing: { basis: 'declared', rules: [{ unit: 'video_second', rate: 1, currency: 'CNY' }] } }],
    });
    expect(manifest.models[0]).toMatchObject({ id: 'flovart:seedance-2', upstreamId: 'seedance-v2/text-to-video', modes: getProductModel('flovart:seedance-2')!.capabilities.modes });
    expect(() => modelManifestFixture({ models: [{ id: 'flovart:gpt-image-2', modes: ['text-to-video'] }] })).toThrow(/夹具清单不合法/);
    expect(() => builtinModelDeclaration('flovart:nope')).toThrow(/没有内置模型/);
  });
});
