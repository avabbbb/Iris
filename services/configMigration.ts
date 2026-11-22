import type { UserApiKey } from '../types';
import type { UserScriptProviderDefinition } from './userScriptProviderAdapter';
import { listStoredUserScriptProviders, parseUserScriptDefinition } from './userScriptAuthoring';

/**
 * 配置迁移包：API Key 配置 + Provider 适配脚本。
 *
 * Key 是明文还是 `***` 由导出入口决定；脚本定义不含凭据。导入时脚本先落盘，
 * 这样 Key 上的 `extraConfig.providerScriptId` 在新设备能直接解析。
 * 兼容旧版裸数组导出（只有 Key，没有脚本）。
 */
export const CONFIG_BUNDLE_KIND = 'iris-config';
export const CONFIG_BUNDLE_VERSION = 1;
/** 改名前 Flovart 导出的迁移包。 */
export const LEGACY_CONFIG_BUNDLE_KINDS = ['flovart-config'] as const;

export interface ConfigBundleV1 {
  kind: typeof CONFIG_BUNDLE_KIND;
  schemaVersion: 1;
  exportedAt: string;
  apiKeys: ConfigApiKey[];
  providerScripts: UserScriptProviderDefinition[];
}

export type ConfigApiKey = Pick<
  UserApiKey,
  'provider' | 'name' | 'key' | 'baseUrl' | 'capabilities' | 'customModels' | 'defaultModel'
  | 'models' | 'extraConfig' | 'routeMappings' | 'pricingRules' | 'budgetPolicy' | 'streamUsage'
>;

export interface ParsedConfigBundle {
  apiKeys: unknown[];
  providerScripts: UserScriptProviderDefinition[];
  /** 旧版导出：顶层就是 Key 数组。 */
  legacy: boolean;
  invalidScripts: number;
  /** 文件里的 Key 全是 `***`（由“导出配置”而非“带 Key 导出”生成）。 */
  noSecrets: boolean;
}

export function buildConfigBundle(
  apiKeys: readonly UserApiKey[],
  includeSecrets: boolean,
  now: Date = new Date(),
): ConfigBundleV1 {
  return {
    kind: CONFIG_BUNDLE_KIND,
    schemaVersion: CONFIG_BUNDLE_VERSION,
    exportedAt: now.toISOString(),
    apiKeys: apiKeys.map(key => ({
      provider: key.provider,
      name: key.name,
      key: includeSecrets ? key.key : '***',
      baseUrl: key.baseUrl,
      capabilities: key.capabilities,
      customModels: key.customModels,
      defaultModel: key.defaultModel,
      models: key.models,
      extraConfig: key.extraConfig,
      routeMappings: key.routeMappings,
      pricingRules: key.pricingRules,
      budgetPolicy: key.budgetPolicy,
      streamUsage: key.streamUsage,
    })),
    providerScripts: listStoredUserScriptProviders(),
  };
}

function keyHasNoSecret(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const key = (value as { key?: unknown }).key;
  return typeof key !== 'string' || key === '***' || key.trim() === '';
}

export function parseConfigBundle(text: string): ParsedConfigBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('迁移文件不是合法 JSON。');
  }

  // 旧版：顶层就是 Key 数组；没有脚本，也能继续导入。
  if (Array.isArray(parsed)) {
    return {
      apiKeys: parsed,
      providerScripts: [],
      legacy: true,
      invalidScripts: 0,
      noSecrets: parsed.length > 0 && parsed.every(keyHasNoSecret),
    };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('不是 Iris 配置迁移文件。');
  }
  const bundle = parsed as { kind?: unknown; schemaVersion?: unknown; apiKeys?: unknown; providerScripts?: unknown };
  const kindOk = bundle.kind === CONFIG_BUNDLE_KIND
    || (LEGACY_CONFIG_BUNDLE_KINDS as readonly unknown[]).includes(bundle.kind);
  if (!kindOk || bundle.schemaVersion !== CONFIG_BUNDLE_VERSION) {
    throw new Error('不是 Iris 配置迁移文件。');
  }
  const apiKeys = Array.isArray(bundle.apiKeys) ? bundle.apiKeys : [];
  const rawScripts = Array.isArray(bundle.providerScripts) ? bundle.providerScripts : [];
  const providerScripts: UserScriptProviderDefinition[] = [];
  let invalidScripts = 0;
  for (const raw of rawScripts) {
    try {
      providerScripts.push(parseUserScriptDefinition(JSON.stringify(raw)));
    } catch {
      invalidScripts += 1;
    }
  }
  return {
    apiKeys,
    providerScripts,
    legacy: false,
    invalidScripts,
    noSecrets: apiKeys.length > 0 && apiKeys.every(keyHasNoSecret),
  };
}
