

export type GenerationMode = 'text' | 'image' | 'video' | 'keyframe';

/** 图片滤镜/调色参数 */
export interface ImageFilters {
  brightness: number;   // 0�?00, default 100
  contrast: number;     // 0�?00, default 100
  saturate: number;     // 0�?00, default 100
  hueRotate: number;    // 0�?60, default 0
  blur: number;         // 0�?0,  default 0
  opacity: number;      // 0�?00, default 100
  grayscale: number;    // 0�?00, default 0
  sepia: number;        // 0�?00, default 0
  temperature: number;  // -100�?00, default 0 (暖色/冷色)
  sharpen: number;      // 0�?00, default 0
}

export const DEFAULT_IMAGE_FILTERS: ImageFilters = {
  brightness: 100,
  contrast: 100,
  saturate: 100,
  hueRotate: 0,
  blur: 0,
  opacity: 100,
  grayscale: 0,
  sepia: 0,
  temperature: 0,
  sharpen: 0,
};

export interface UserEffect {
  id: string;
  name: string;
  value: string;
}

// Asset Library
//
// 资产模型：文件夹 + 标签双轴
// - 文件夹（AssetFolder）支持无限嵌套树（parentId 串联），parentId 为 null 表示根级
// - 一个 AssetItem 可同时归属多个文件夹（folderIds: string[]），类似 Eagle 的 Add To Folders
// - 标签（tags: string[]）是跨文件夹横切组织维度，支持任意字符串
// - 迁移自旧版 character/scene/prop 三桶结构时，旧 category 名作为标签兜底语义

export interface AssetFolder {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: number;
}

export interface AssetItem {
  id: string;
  name?: string;
  folderIds: string[];      // 所属文件夹 id 列表，空数组表示"未分类"
  tags: string[];           // 跨文件夹横切标签
  dataUrl: string;          // base64 或 blob URL
  mimeType: string;        // image/png, image/jpeg, video/mp4...
  width: number;
  height: number;
  createdAt: number;
  source?: 'local' | 'extension' | 'generation' | 'recipe' | 'market';
  sourceUrl?: string;
  prompt?: string;
  provider?: string;
  model?: string;
  generationParams?: Record<string, unknown>;
}

export interface AssetLibrary {
  folders: AssetFolder[];   // 扁平文件夹数组，靠 parentId 串成树
  items: AssetItem[];        // 扁平素材列表
}

export interface GenerationHistoryItem {
  id: string;
  name?: string;
  dataUrl: string;        // 图片 base64 或视频缩略图 base64
  mimeType: string;
  width: number;
  height: number;
  prompt: string;
  createdAt: number;
  /** 生成类型：image | video，默�?image */
  mediaType?: 'image' | 'video';
  provider?: string;
  model?: string;
  generationParams?: Record<string, unknown>;
  /** 生成时所属画布（工作空间）id；旧记录无此字段，归入「未归属」。 */
  projectId?: string;
  /** 谁发起的生成：画布上的你 / 内置 Agent / 外部 Agent（CLI、DSH、宿主）。旧记录无此字段。 */
  origin?: 'user' | 'agent' | 'external-agent';
}

export interface GenerationRecipe {
  prompt: string;
  provider?: string;
  model?: string;
  generationParams?: Record<string, unknown>;
}

export interface RecipePackage {
  version: 1;
  asset: {
    name?: string;
    folderIds: string[];   // 安装时归入哪些文件夹，空数组表示"未分类"
    tags: string[];        // 附带标签
    dataUrl: string;
    mimeType: string;
    width: number;
    height: number;
  };
  recipe: GenerationRecipe;
  createdAt: number;
}

// API Key & Model Preferences
export type ThemeMode = 'light' | 'dark' | 'system';
export type WorkspaceView = 'workflow' | 'agent';
export type CanvasView = 'spatial' | 'agent' | 'reverse';
export type AIProvider = 'openai' | 'anthropic' | 'google' | 'qwen' | 'deepseek' | 'xai' | 'siliconflow' | 'keling' | 'flux' | 'midjourney' | 'runningHub' | 'minimax' | 'volcengine' | 'openrouter' | 'openai_compatible' | 'custom';
export type AICapability = 'text' | 'image' | 'video' | 'agent';

/** 模型条目（用于结构化展示�?*/
export interface ModelItem {
  id: string;
  name: string;
  /** 模型自身的输出能力；由 Provider 模型列表返回或用户配置，避免再次从名称猜测。 */
  capability?: AICapability;
  /** 思考强度档位（从低到高，'off' 即 none）；来自服务商 /models 返回，没有时留空，由注册表 / 规则表补齐。 */
  thinkingLevels?: ModelThinkingLevel[];
  /** 档位数据来源：api = 服务商模型列表字段。 */
  thinkingSource?: 'api';
  /** effort = 可选强度；toggle = 只有开 / 关（发 thinking.type=enabled / reasoning.enabled）。 */
  thinkingMode?: 'effort' | 'toggle';
  /** 服务商声明必须思考（不能关）。 */
  thinkingMandatory?: boolean;
  /** 服务商声明的默认档位。 */
  defaultThinkingLevel?: ModelThinkingLevel;
  /** 上下文窗口（tokens），来自 /models 的 context_length / context_window 等字段。 */
  contextWindow?: number;
  /** 单次最大输出 tokens。 */
  maxOutputTokens?: number;
}

/** 统一的思考强度档位，按强度升序：off(none) < minimal < low < medium < high < xhigh < max。 */
export type ModelThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type ProductModelMode =
  | 'text-to-image'
  | 'image-to-image'
  | 'text-to-video'
  | 'image-to-video'
  | 'reference-to-video'
  | 'first-last-frame'
  | 'video-extension';

export type RuntimeRouteCapability =
  | 'prompt-enhancement'
  | 'script-breakdown'
  | 'agent-text'
  | 'image-understanding';

export type RouteMappingTarget =
  | { kind: 'product-mode'; productModelId: string; mode: ProductModelMode }
  | { kind: 'runtime-capability'; capability: RuntimeRouteCapability };

export interface RouteMappingBinding {
  target: RouteMappingTarget;
  routeId: string;
  order: number;
}

export type ApiPricingUnit = 'request' | 'image' | 'video_second' | 'input_token' | 'output_token';

export interface ApiPricingRule {
  id: string;
  productModelId?: string;
  routeId?: string;
  unit: ApiPricingUnit;
  rate: number;
  currency: 'USD' | 'CNY';
  resolution?: string;
  quality?: string;
  source: 'official' | 'manual';
}

export interface ApiBudgetPolicy {
  enabled: boolean;
  monthlyLimit: number;
  warningPercent: number;
  hardStop: boolean;
  currency: 'USD' | 'CNY';
}

export interface UserApiKey {
  id: string;
  provider: AIProvider;
  capabilities: AICapability[];
  key: string;
  baseUrl?: string;
  name?: string;
  isDefault?: boolean;
  status?: 'unknown' | 'ok' | 'error';
  /** 用户为这�?Key 自定义的可调用模型列�?*/
  customModels?: string[];
  /** 这些自定义模型中用户设定的默认模�?*/
  defaultModel?: string;
  /** 结构化模型列表（可选，优先�?customModels 展示�?*/
  models?: ModelItem[];
  /** Provider 特有的额外配置（�?Google Veo �?projectId�?*/
  extraConfig?: Record<string, string>;
  /** 统一模型映射中心确认后的目标到 Provider Route 绑定。 */
  routeMappings?: RouteMappingBinding[];
  /** 该 Key / 模型线路的计价规则。 */
  pricingRules?: ApiPricingRule[];
  /** 该 Key 的月度预算策略。 */
  budgetPolicy?: ApiBudgetPolicy;
  /**
   * 流式 usage 策略：默认 passive（只读流中自带的 usage，不改请求）；
   * request 时在 OpenAI 兼容流式请求里加 `stream_options.include_usage`，若网关 400 拒绝则去掉该字段重试一次。
   */
  streamUsage?: 'passive' | 'request';
  /**
   * 由 Desktop Production Runtime 托管的安全凭证（明文 Key 只存在系统 Keyring）。
   * 设置页「桌面 Runtime 凭证 → 一键导入」会创建这种条目；浏览器直连生成对它无效，
   * 媒体生成会经 `runtime_execute` 的 generate.image / generate.video 路由到 Runtime 执行。
   */
  runtimeManaged?: { credentialId?: string };
  createdAt: number;
  updatedAt: number;
}

// Agent / Workflow
// Multi-Agent Chat System
export type AgentRoleId = 'creative_director' | 'prompt_engineer' | 'style_master' | 'compositor' | 'quality_reviewer' | string;

export interface AgentRole {
    id: AgentRoleId;
    name: string;
    emoji: string;
    color: string;
    systemPrompt: string;
    description: string;
}

export interface AgentConfig {
    id: string;
    roleId: AgentRoleId;
    enabled: boolean;
    provider?: AIProvider;
    model?: string;
}

export interface AgentMessage {
    id: string;
    agentId: string;
    agentName: string;
    agentEmoji: string;
    agentColor: string;
    role: 'user' | 'agent' | 'system';
    content: string;
    timestamp: number;
    isGenerating?: boolean;
    imageUrl?: string;
}

export interface AgentBudget {
    maxCost: number;
    currentCost: number;
    maxRounds: number;
}

export interface AgentSession {
    id: string;
    task: string;
    agents: AgentConfig[];
    messages: AgentMessage[];
    status: 'idle' | 'discussing' | 'generating' | 'completed' | 'error' | 'stopped';
    currentRound: number;
    budget: AgentBudget;
    finalPrompt?: string;
}
export type PromptEnhanceMode = 'smart' | 'style' | 'precise' | 'translate';

export interface PromptEnhanceRequest {
  prompt: string;
  mode: PromptEnhanceMode;
  stylePreset?: string;
}

export interface PromptEnhanceResult {
  enhancedPrompt: string;
  negativePrompt: string;
  suggestions: string[];
  notes?: string;
}

export interface CharacterLockProfile {
  id: string;
  name: string;
  anchorNodeId: string;
  referenceImage: string; // dataURL
  descriptor: string;
  createdAt: number;
  isActive: boolean;
}

export interface ChatAttachment {
  id: string;
  name: string;
  href: string;
  mimeType: string;
  source: 'workflow' | 'upload';
}
