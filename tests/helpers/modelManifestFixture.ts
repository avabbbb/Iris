// 测试夹具：用 iris.service/1 **声明**模型（file-over-app 计划 F1）。
//
// Iris 不再内置模型映射后，测试不能再假设 `flovart:gpt-image-2` 之类的 id「天生存在」：
// 需要它的测试用这里的夹具把它声明出来（id 不变，老测试只改导入）。能力数据来自
// tests/fixtures/builtinModelDeclarations.v1.json —— 2026-11-27 内置目录的冻结副本；
// 在内置目录删除之前，tests/modelManifestFixture.test.ts 逐字段对拍它与现行目录，防止漂移。
import frozen from '../fixtures/builtinModelDeclarations.v1.json';
import type { AIProvider } from '../../types';
import {
  SERVICE_MANIFEST_SCHEMA,
  parseServiceManifest,
  type ModelDeclaration,
  type ServiceManifest,
} from '../../tools/iris/contracts/service-manifest.js';
import { protocolForLegacyProvider, type ServiceProtocol } from '../../services/legacyProviderProtocol';

type FrozenEntry = { legacyProvider: AIProvider; declaration: Record<string, unknown> & { id: string } };
const FROZEN = (frozen as unknown as { models: FrozenEntry[] }).models;
const BY_ID = new Map(FROZEN.map(entry => [entry.declaration.id, entry]));

/** 冻结副本里的全部旧内置模型 id（19 个，顺序同旧目录）。 */
export const BUILTIN_MODEL_IDS: readonly string[] = FROZEN.map(entry => entry.declaration.id);

/** 旧内置模型的默认 Provider（只用于夹具按协议分组）。 */
export function builtinLegacyProvider(id: string): AIProvider {
  const entry = BY_ID.get(id);
  if (!entry) throw new Error(`冻结副本里没有内置模型 ${id}`);
  return entry.legacyProvider;
}

/** 一条旧内置模型的声明（深拷贝，可覆盖任意字段，如 upstreamId / pricing）。 */
export function builtinModelDeclaration(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> & { id: string } {
  const entry = BY_ID.get(id);
  if (!entry) throw new Error(`冻结副本里没有内置模型 ${id}`);
  return { ...structuredClone(entry.declaration), ...overrides };
}

export type ModelManifestFixtureInput = {
  id?: string;
  name?: string;
  protocol?: ServiceProtocol;
  baseUrl?: string;
  status?: ServiceManifest['status'];
  createdBy?: ServiceManifest['createdBy'];
  hostDeviceIds?: string[];
  protocolOptions?: Record<string, string | number | boolean | null>;
  /** 旧内置 id（取冻结声明）或完整 / 部分声明对象（带 id 时以冻结声明为底）。 */
  models: Array<string | (Record<string, unknown> & { id: string })>;
};

/** 构造并**校验**一份服务清单；声明不合法时直接抛错（夹具本身不能是坏数据）。 */
export function modelManifestFixture(input: ModelManifestFixtureInput): ServiceManifest {
  const id = input.id ?? 'svc_fixture';
  const protocol = input.protocol ?? 'openai-compatible';
  const models = input.models.map(model => {
    if (typeof model === 'string') return builtinModelDeclaration(model);
    return BY_ID.has(model.id) ? builtinModelDeclaration(model.id, model) : model;
  });
  const raw = {
    schema: SERVICE_MANIFEST_SCHEMA,
    id,
    name: input.name ?? id,
    protocol,
    ...(protocol === 'local-agent' ? {} : { baseUrl: input.baseUrl ?? 'https://api.example.test/v1', secretRef: id }),
    status: input.status ?? 'active',
    createdBy: input.createdBy ?? { kind: 'user' },
    ...(input.hostDeviceIds ? { hostDeviceIds: input.hostDeviceIds } : {}),
    ...(input.protocolOptions ? { protocolOptions: input.protocolOptions } : {}),
    updatedAt: '2026-11-27T00:00:00.000Z',
    models,
  };
  const { manifest, issues } = parseServiceManifest(raw);
  if (!manifest) throw new Error(`夹具清单不合法：\n${issues.map(issue => `${issue.path}: ${issue.message}`).join('\n')}`);
  return manifest;
}

/** 把全部旧内置模型按默认 Provider 的协议分组声明成若干服务（每个协议一个服务）。 */
export function builtinModelManifests(): ServiceManifest[] {
  const groups = new Map<AIProvider, string[]>();
  for (const id of BUILTIN_MODEL_IDS) {
    const provider = builtinLegacyProvider(id);
    groups.set(provider, [...(groups.get(provider) || []), id]);
  }
  return [...groups].map(([provider, ids]) => modelManifestFixture({
    id: `svc_fixture_${provider}`,
    name: `fixture ${provider}`,
    protocol: protocolForLegacyProvider(provider),
    protocolOptions: { legacyProvider: provider },
    models: ids,
  }));
}

export type { ModelDeclaration, ServiceManifest };
