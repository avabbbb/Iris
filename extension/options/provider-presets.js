// 与网页画布「设置 → AI 服务」同一份 Provider 列表（components/SettingsPanel.tsx 的 PROVIDER_PRESETS / providerBaseUrl，
// services/aiGateway.ts 的 PROVIDER_LABELS）。纯数据，tests/extensionOptionsPage.test.ts 逐项对拍。

// 画布「添加 AI 服务」弹窗里的内置协议入口（「自定义配置」依赖适配脚本，只能在画布里建，这里只展示）。
export const PROVIDER_PRESETS = [
  { id: 'custom', provider: 'custom', label: 'OpenAI compatible', baseUrl: '', capabilities: ['text', 'image'] },
  { id: 'google-visual', provider: 'google', label: 'Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', capabilities: ['image', 'video'], defaultModel: 'gemini-3.1-flash-image' },
  { id: 'seedance-2', provider: 'volcengine', label: 'Volcengine Seedance', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', capabilities: ['video'] },
  { id: 'runninghub', provider: 'runningHub', label: 'RunningHub', baseUrl: 'https://www.runninghub.cn/openapi/v2', capabilities: ['image', 'video'], defaultModel: 'seedream-v5-flash/text-to-image' },
];

export const PROVIDER_LABELS = {
  google: 'Google Gemini',
  openai: 'OpenAI',
  anthropic: 'Anthropic Claude',
  qwen: 'Qwen 通义千问',
  deepseek: 'DeepSeek 深度求索',
  siliconflow: 'SiliconFlow 硅基流动',
  keling: 'Keling 可灵',
  flux: 'Flux (BFL)',
  midjourney: 'Midjourney',
  runningHub: 'RunningHub',
  minimax: 'MiniMax',
  volcengine: '火山引擎 (豆包)',
  openrouter: 'OpenRouter',
  openai_compatible: 'OpenAI Compatible',
  xai: 'xAI Grok',
  custom: '自定义',
};

export const PROVIDER_BASE_URLS = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta',
  xai: 'https://api.x.ai/v1',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  deepseek: 'https://api.deepseek.com',
  siliconflow: 'https://api.siliconflow.cn/v1',
  keling: 'https://api.klingai.com/v1',
  flux: 'https://api.bfl.ml/v1',
  midjourney: 'https://api.midjourney.com/v1',
  runningHub: 'https://www.runninghub.cn/openapi/v2',
  minimax: 'https://api.minimax.chat/v1',
  volcengine: 'https://ark.cn-beijing.volces.com/api/v3',
  openrouter: 'https://openrouter.ai/api/v1',
  openai_compatible: '',
  custom: '',
};

export const CAPABILITIES = ['text', 'image', 'video', 'agent'];

export function providerLabel(provider) {
  const preset = PROVIDER_PRESETS.find(item => item.provider === provider);
  return preset?.label || PROVIDER_LABELS[provider] || provider;
}
