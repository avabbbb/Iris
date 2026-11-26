import type { AIProvider } from '../types';
import type { SERVICE_PROTOCOLS } from '../tools/iris/contracts/service-manifest.js';

export type ServiceProtocol = typeof SERVICE_PROTOCOLS[number];

/**
 * 旧 `UserApiKey.provider` → iris.service/1 的 `protocol`（请求适配器）。只给一次性迁移与测试夹具用；
 * 迁移时原值另存为 `protocolOptions.legacyProvider`，适配器分流在 F2 之前仍按它走，行为不变。
 * Record 穷举 AIProvider：新增 Provider 时这里编译不过，必须决定它走哪个协议。
 */
const PROTOCOL_BY_PROVIDER: Record<AIProvider, ServiceProtocol> = {
  openai: 'openai-compatible',
  openai_compatible: 'openai-compatible',
  custom: 'openai-compatible',
  deepseek: 'openai-compatible',
  qwen: 'openai-compatible',
  siliconflow: 'openai-compatible',
  openrouter: 'openrouter',
  anthropic: 'anthropic',
  google: 'gemini',
  volcengine: 'volcengine-ark',
  xai: 'xai',
  runningHub: 'runningHub',
  keling: 'keling',
  minimax: 'minimax',
  flux: 'flux',
  midjourney: 'midjourney',
};

export function protocolForLegacyProvider(provider: AIProvider): ServiceProtocol {
  return PROTOCOL_BY_PROVIDER[provider];
}
