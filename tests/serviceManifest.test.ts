import { describe, expect, it } from 'vitest';
import {
  SERVICE_MANIFEST_SCHEMA,
  isModelEffective,
  modelPriceKnown,
  parseServiceManifest,
  upstreamIdForMode,
} from '../tools/iris/contracts/service-manifest.js';

const base = () => ({
  schema: SERVICE_MANIFEST_SCHEMA,
  id: 'svc_openai_main',
  name: '我的 OpenAI 兼容',
  protocol: 'openai-compatible',
  baseUrl: 'https://api.example.com/v1',
  secretRef: 'svc_openai_main',
  status: 'active',
  createdBy: { kind: 'user' },
  updatedAt: '2026-11-27T00:00:00.000Z',
  models: [{
    id: 'flovart:gpt-image-2',
    upstreamId: 'gpt-image-2',
    displayName: 'GPT Image 2',
    nodeTypes: ['image'],
    modes: ['text-to-image', 'image-to-image'],
    inputs: { maxImageRefs: 16 },
    params: { aspectRatios: ['1:1', '16:9'], resolutions: ['1K', '2K'], counts: [1, 2] },
    pricing: { basis: 'declared', rules: [{ unit: 'image', rate: 0.3, currency: 'CNY', resolution: '2K' }] },
  }],
});

const issuesOf = (input: unknown) => parseServiceManifest(input).issues;
const expectIssue = (input: unknown, pattern: RegExp) => {
  const issues = issuesOf(input);
  expect(issues.length, JSON.stringify(input)).toBeGreaterThan(0);
  expect(issues.map(issue => `${issue.path}: ${issue.message}`).join('\n')).toMatch(pattern);
};

describe('iris.service/1 manifest', () => {
  it('accepts a declared service and fills safe defaults', () => {
    const { manifest, issues } = parseServiceManifest(base());
    expect(issues).toEqual([]);
    const model = manifest!.models[0];
    expect(model.inputs).toEqual({ maxImageRefs: 16, maxVideoRefs: 0, maxAudioRefs: 0 });
    expect(model.params).toMatchObject({ qualities: [], durations: [], audio: 'none', seed: false, webSearch: false });
    expect(modelPriceKnown(model)).toBe(true);
    expect(isModelEffective(manifest!, model)).toBe(true);
  });

  it('defaults price to unknown — unknown price is never "known" (always needs approval)', () => {
    const input = base();
    delete (input.models[0] as Record<string, unknown>).pricing;
    const { manifest, issues } = parseServiceManifest(input);
    expect(issues).toEqual([]);
    expect(manifest!.models[0].pricing).toEqual({ basis: 'unknown' });
    expect(modelPriceKnown(manifest!.models[0])).toBe(false);
    expectIssue({ ...base(), models: [{ ...base().models[0], pricing: { basis: 'declared', rules: [] } }] }, /pricing/);
    expectIssue({ ...base(), models: [{ ...base().models[0], pricing: { basis: 'unknown', rules: [{ unit: 'image', rate: 1, currency: 'USD' }] } }] }, /pricing/);
  });

  it('prefilled-but-unconfirmed models and non-active services are not effective', () => {
    const input = base();
    (input.models[0] as Record<string, unknown>).provenance = { prefilledFrom: 'upstream-models-endpoint', confirmed: false };
    const { manifest, issues } = parseServiceManifest(input);
    expect(issues).toEqual([]);
    expect(isModelEffective(manifest!, manifest!.models[0])).toBe(false);
    expect(isModelEffective({ status: 'pending-user-confirm' }, { provenance: { confirmed: true } })).toBe(false);
    expect(isModelEffective({ status: 'active' }, {})).toBe(true);
  });

  it('never accepts a key or any other secret in the manifest', () => {
    expectIssue({ ...base(), apiKey: 'sk-abc' }, /apiKey/);
    expectIssue({ ...base(), protocolOptions: { token: 'abc' } }, /秘密/);
    expectIssue({ ...base(), notes: 'key is sk-abcdefghijklmnopqrstuvwxyz0123' }, /秘密/);
    expect(issuesOf({ ...base(), secretRef: 'svc_openai_main' })).toEqual([]);
  });

  it('keeps executable content out: no command templates in protocolOptions, no nested objects', () => {
    expectIssue({ ...base(), protocolOptions: { command: 'rm -rf /' } }, /可执行配置/);
    expectIssue({ ...base(), models: [{ ...base().models[0], protocolOptions: { argv: ['codex', 'exec'] } }] }, /可执行配置/);
    expectIssue({ ...base(), protocolOptions: { nested: { command: 'x' } } }, /protocolOptions/);
  });

  it('local-agent services: no baseUrl / key, must name host devices and a local driverRef', () => {
    const local = {
      ...base(),
      id: 'local-gpt-image',
      protocol: 'local-agent',
      baseUrl: undefined,
      secretRef: undefined,
      hostDeviceIds: ['dev_studio_pc'],
      models: [{ ...base().models[0], id: 'local-gpt-image/default', protocolOptions: { driverRef: 'codex-imagegen' }, pricing: { basis: 'unknown' } }],
    };
    expect(issuesOf(local)).toEqual([]);
    expectIssue({ ...local, hostDeviceIds: [] }, /hostDeviceIds/);
    expectIssue({ ...local, models: [{ ...local.models[0], protocolOptions: {} }] }, /driverRef/);
    expectIssue({ ...local, baseUrl: 'http://127.0.0.1:1' }, /baseUrl/);
    expectIssue({ ...base(), hostDeviceIds: ['dev_1'] }, /只有 local-agent/);
  });

  it('cross-checks modes against node types, reference limits and per-mode upstream ids', () => {
    const model = base().models[0];
    expectIssue({ ...base(), models: [{ ...model, modes: ['text-to-video'] }] }, /需要节点类型 video/);
    expectIssue({ ...base(), models: [{ ...model, modes: [] }] }, /至少要声明一个模式/);
    expectIssue({ ...base(), models: [{ ...model, inputs: { maxImageRefs: 0 } }] }, /image-to-image 却不接收任何参考/);
    expectIssue({ ...base(), models: [{ ...model, modes: ['text-to-image', 'text-to-image'] }] }, /模式 重复/);
    expectIssue({ ...base(), models: [{ ...model, nodeTypes: [] }] }, /nodeTypes/);
    expectIssue({ ...base(), models: [model, { ...model }] }, /模型 id 重复/);
    expectIssue({ ...base(), models: [{ ...model, fallbacks: [model.id] }] }, /备选模型不能是自己/);
    expectIssue({ ...base(), models: [{ ...model, upstreamIdByMode: { 'text-to-video': 'x' } }] }, /不在 modes 里/);
    expectIssue({ ...base(), models: [{ ...model, nodeTypes: ['text'] }] }, /模式 text-to-image 需要节点类型 image/);
    // 文本模型不需要模式
    expect(issuesOf({ ...base(), models: [{ id: 'm_text', upstreamId: 'gpt-5', displayName: 'GPT-5', nodeTypes: ['text'] }] })).toEqual([]);
    const routed = { ...model, upstreamIdByMode: { 'image-to-image': 'rh/edit' } };
    expect(upstreamIdForMode(routed, 'image-to-image')).toBe('rh/edit');
    expect(upstreamIdForMode(routed, 'text-to-image')).toBe('gpt-image-2');
  });

  it('is strict about shape: unknown fields, wrong schema tag, unsafe ids and non-http urls are rejected', () => {
    expectIssue({ ...base(), schema: 'iris.service/2' }, /schema/);
    expectIssue({ ...base(), surprise: true }, /surprise|Unrecognized/i);
    expectIssue({ ...base(), id: '../evil' }, /id/);
    expectIssue({ ...base(), id: 'flovart:x' }, /id/);
    expectIssue({ ...base(), baseUrl: 'file:///etc/passwd' }, /baseUrl/);
    expectIssue({ ...base(), protocol: 'made-up' }, /protocol/);
    expectIssue({ ...base(), createdBy: { kind: 'agent' } }, /createdBy/);
    expectIssue({ ...base(), models: [{ ...base().models[0], params: { durations: [0] } }] }, /时长/);
  });
});
