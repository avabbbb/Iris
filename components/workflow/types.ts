import type { ImageFilters, ProductModelMode } from '../../types';
import type { DesignElement } from '../../services/design/designTypes';

/** `operation` 只为兼容旧数据保留（v6 起加载时迁移为直连结果节点），新代码不再创建。 */
export type BuiltinWorkflowNodeType = 'image' | 'text' | 'video' | 'audio' | 'config' | 'script' | 'operation' | 'design' | 'subgraph';
/** 外部 Node Plugin 可以使用稳定的自定义 type；内置交互仍只对 Builtin 类型做专门处理。 */
export type WorkflowNodeType = BuiltinWorkflowNodeType | (string & {});
export type WorkflowNodeStatus = 'idle' | 'loading' | 'success' | 'error';
export type WorkflowGenerationMode = 'text' | 'image' | 'video' | 'audio';
export type WorkflowBackgroundMode = 'dots' | 'lines' | 'none';
export type WorkflowBatchGroupSource = 'auto' | 'manual';
// 生成阶段的传输明细：上传/下载字节、轮询次数、已输出 token，仅用于节点进度展示。
export type GenerationTransfer = { phase: 'upload' | 'queue' | 'generate' | 'download'; loaded?: number; total?: number; polls?: number; tokens?: number };

export interface ScriptAsset {
  id: string;
  kind: 'character' | 'scene' | 'prop';
  name: string;
  description?: string;
  settingImageNodeId?: string;
}

export interface ScriptShot {
  id: string;
  index: number;
  emotion?: string;
  action?: string;
  dialogue?: string;
  sfx?: string;
  scene?: string;
  /** 景别：特写 / 近景 / 中景 / 全景 / 远景 …（LibTV rows.shotSize）。 */
  shotSize?: string;
  /** 光影与氛围（LibTV rows.lightingAndAtmosphere）。 */
  lighting?: string;
  /** 本镜头引用的锚点节点 id（角色/场景/道具/风格）；物化时以 @chip + 连线接到生成节点。 */
  characterRefs?: string[];
  /** 声音设计：音效、配乐提示（LibTV rows.audioEffects）。 */
  audio?: string;
  /** 物化为图片生成节点时写进其 Prompt Bar 的提示词（替代 imagePromptOverride）。 */
  imagePrompt?: string;
  /** 物化为视频生成节点时写进其 Prompt Bar 的提示词（替代 videoPromptOverride）。 */
  videoPrompt?: string;
  /** @deprecated 旧字段，只读迁移：用 scriptShotPrompt() 读取，写入用 imagePrompt。 */
  imagePromptOverride?: string;
  /** @deprecated 旧字段，只读迁移：用 scriptShotPrompt() 读取，写入用 videoPrompt。 */
  videoPromptOverride?: string;
  /** 分镜表：镜头时长（秒），由 Agent 或编辑器填写。 */
  durationSec?: number;
  /** 分镜表：运镜，如「推镜」「横移」「手持跟拍」。 */
  camera?: string;
  colorTag?: string;
  imageNodeId?: string;
  videoNodeId?: string;
  status?: WorkflowNodeStatus;
}

export interface ScriptBreakdown {
  assets: ScriptAsset[];
  shots: ScriptShot[];
  sourceText?: string;
  referenceVideoNodeId?: string;
  modelId?: string;
}

export interface WorkflowPoint {
  x: number;
  y: number;
}

export interface WorkflowViewport {
  x: number;
  y: number;
  k: number;
}

export interface WorkflowRichPromptDocument extends Record<string, unknown> {
  type: string;
}

export type WorkflowOperationCapabilityId =
  | 'image.generate@1'
  | 'image.crop@1'
  | 'image.upscale@1'
  | 'image.remove-background@1'
  | 'image.split-layers@1'
  | 'image.edit@1'
  | 'image.rotate@1'
  | 'image.vectorize@1'
  | 'image.split-grid@1'
  | 'image.layer@1'
  | 'video.trim@1'
  | 'video.av-split@1'
  | 'video.merge@1'
  | 'video.extract-frame@1'
  | 'audio.trim@1'
  | 'audio.speed@1'
  | 'audio.pitch@1'
  | 'audio.stem-split@1';
export type WorkflowOperationMediaType = 'image' | 'video' | 'audio';
export type WorkflowOperationInputRole = 'source_image' | 'reference_image' | 'mask_image' | 'source_video' | 'source_audio' | 'prompt_context';
export type WorkflowOperationOutputRole = 'result_image' | 'result_video' | 'result_audio';
export type WorkflowOperationTakeStatus = 'running' | 'success' | 'error' | 'canceled' | 'outdated_recipe';

export interface WorkflowOperationInputBinding {
  id: string;
  sourceNodeId: string;
  role: WorkflowOperationInputRole;
  order: number;
  objectVersion: number;
}

export interface WorkflowOperationPromptDocument {
  text: string;
  richTextDocument?: WorkflowRichPromptDocument;
}

export interface WorkflowOperationRecipe {
  capabilityId: WorkflowOperationCapabilityId;
  version: 1;
  promptDocument: WorkflowOperationPromptDocument;
  parameters: Record<string, unknown>;
  productModelId?: string;
  inputBindings: WorkflowOperationInputBinding[];
  /** 当前已计算的语义 Hash；编辑后置空，执行/授权前必须重新冻结。 */
  recipeHash: string | null;
  objectVersion: number;
  updatedAt: string;
}

export interface WorkflowExecutionPromptSnapshot {
  id: string;
  createdAt: string;
  compilerVersion: 'workflow-operation@1';
  renderedPrompt: string;
  richTextDocument?: WorkflowRichPromptDocument;
  parameters: Record<string, unknown>;
  productModelId?: string;
  inputBindings: WorkflowOperationInputBinding[];
  recipeHash: string;
  routeId?: string;
}

/** 原位写回 Operation 节点的单张结果在该 Take 上留存的媒体字段，用于切回旧版本。 */
export interface WorkflowOperationTakeMedia {
  storageKey: string;
  mimeType?: string;
  name?: string;
  bytes?: number;
  naturalWidth?: number;
  naturalHeight?: number;
  posterStorageKey?: string;
}

export interface WorkflowOperationTake {
  id: string;
  status: WorkflowOperationTakeStatus;
  recipeHash: string;
  createdAt: string;
  completedAt?: string;
  snapshot: WorkflowExecutionPromptSnapshot;
  outputNodeIds: string[];
  /** 仅原位结果：该 Take 的媒体（媒体 GC 会把它视为可达引用）。 */
  outputMedia?: WorkflowOperationTakeMedia;
  providerTaskId?: string;
  usageRecordId?: string;
  error?: string;
}

export interface WorkflowOperationRecord {
  capabilityId: WorkflowOperationCapabilityId;
  recipe: WorkflowOperationRecipe;
  takes: WorkflowOperationTake[];
  selectedTakeId?: string;
  /**
   * 选中来源：`explicit` = 人或 Agent 明确选择；缺省 / `auto` = 系统跟随最新成功结果。
   * 明确选择后，晚到的 Take 只追加为新版本，不再改变 selectedTakeId。
   */
  selectedTakeSource?: 'auto' | 'explicit';
}

export interface WorkflowProviderConfig {
  providerId?: string;
  modelId?: string;
}

export interface WorkflowArtifactRef {
  taskId: string;
  /** Runtime 逐步收敛到稳定 Artifact 身份时使用；taskId 暂作为读取适配器字段保留。 */
  artifactId?: string;
  outputIndex?: number;
  kind: Extract<WorkflowNodeType, 'image' | 'video' | 'audio'>;
  mimeType?: string;
  sha256?: string;
  byteSize?: number;
  durationSec?: number;
}

export type WorkflowResourceKind = 'text' | 'image' | 'video' | 'audio';
export type WorkflowResourceOrigin = 'node' | 'asset' | 'upload' | 'creative-host';
export type WorkflowResourceReferenceSource = 'edge' | 'mention' | 'manual';
export type WorkflowGenerationReferenceRole = 'first_frame' | 'last_frame' | 'reference' | 'character' | 'style' | 'mask' | 'source_video' | 'source_audio';

export type WorkflowResourceLocator =
  | { kind: 'asset'; assetId: string }
  | { kind: 'workflow-storage'; storageKey: string }
  | { kind: 'runtime-artifact'; artifactRef: WorkflowArtifactRef }
  /** Creative Host 的 opaque locator；执行层必须通过 Host adapter 物化，不能被 Provider 直接解释。 */
  | { kind: 'creative-host'; host: string; locator: Record<string, string | number> }
  | { kind: 'remote-url'; href: string }
  | { kind: 'legacy-href'; href: string }
  | { kind: 'inline-text'; text: string }
  | { kind: 'missing'; reason: string };

/** 节点声明给下游的资源；执行层只通过 locator 解析，不猜节点 metadata。 */
/**
 * 带区域的引用（焦点编辑 / 镜头聚焦）：x/y/w/h 为 0-1 归一化框；点选主体时另带 mask（与框同尺寸的蒙版图），
 * 框选只有框。提交给 Provider 前按区域裁剪（有 mask 时再叠蒙版），画布上不留中间节点。
 */
export interface WorkflowReferenceRegion {
  x: number;
  y: number;
  w: number;
  h: number;
  /** 与框同尺寸的 RGBA PNG：alpha=255 为主体、alpha=0 为排除（执行层按 alpha 做 destination-in）。 */
  mask?: { storageKey?: string; href?: string };
  /** 点选主体的提示（弹层重开时恢复点位用）；不参与身份键。 */
  pick?: WorkflowReferenceRegionPick;
}

/** 点选主体的提示：点 / 框都是相对原图的 0-1 坐标；label 1 = 包含，0 = 排除。 */
export interface WorkflowReferenceRegionPick {
  points: Array<{ x: number; y: number; label: 0 | 1 }>;
  box?: { x: number; y: number; w: number; h: number };
  /** 采用的候选蒙版序号（模型通常给 3 个）。 */
  candidate?: number;
  /** 产生蒙版的引擎标识，如 `slimsam-77-uniform`。 */
  engine?: string;
}

export interface WorkflowResource {
  resourceId: string;
  title: string;
  kind: WorkflowResourceKind;
  locator: WorkflowResourceLocator;
  mimeType?: string;
}

/**
 * 统一描述一个可被生成节点消费的资源来源。
 * URL、storageKey 和 artifactRef 属于解析后的执行载荷，不属于引用身份。
 */
export interface WorkflowResourceReference {
  id: string;
  resourceId: string;
  resourceOrigin: WorkflowResourceOrigin;
  sourceId: string;
  kind: WorkflowResourceKind;
  source: WorkflowResourceReferenceSource;
  role?: WorkflowGenerationReferenceRole;
  connectionId?: string;
}

export interface CameraParams {
  camera?: string;
  lens?: string;
  focalLength?: string;
  aperture?: string;
}

export interface WorkflowGenerationConfig extends WorkflowProviderConfig {
  mode: WorkflowGenerationMode;
  operationParameters?: Record<string, unknown>;
  submode?: ProductModelMode;
  aspectRatio?: string;
  /** 图生图 / 图生视频时，是否忽略用户在 PromptBar 中选择的比例，改用第一张参考图的原始宽高比。 */
  preserveReferenceAspectRatio?: boolean;
  resolution?: string;
  durationSec?: number;
  quality?: string;
  count?: number;
  generateAudio?: boolean;
  watermark?: boolean;
  enhancePrompt?: boolean;
  webSearch?: boolean;
  realPersonCheck?: boolean;
  audioVoice?: string;
  audioFormat?: string;
  audioSpeed?: string;
  audioInstructions?: string;
  camera?: CameraParams;
  styleId?: string;
  cameraMovement?: string;
  customMovement?: string;
  seedanceRefs?: SeedanceReferences;
}

export interface SeedanceReferences {
  imageRefs: string[];
  videoRefs: string[];
  audioRefs: string[];
}

export interface WorkflowNodeMetadata {
  /** Spatial Context Card（plugin:context-card）：用户 Commit 的创作结论；标题 / 正文就是节点 title / content。 */
  contextCard?: WorkflowContextCardMeta;
  /** 画布 Agent 会话卡（plugin:agent-session）：Session 的投影，只存 sessionId / entryId、绑定素材与一段摘录。 */
  agentSession?: WorkflowAgentSessionMeta;
  content?: string;
  prompt?: string;
  /** 旧文本提示词节点迁移后保留的下游目标；仅用于一次性“并入下游提示词”。 */
  noteMergeTargetIds?: string[];
  /** 由备注“生成资产”派生的图片节点回指源备注，便于重新生成时错位。 */
  assetSourceNoteId?: string;
  richTextDocument?: WorkflowRichPromptDocument;
  /** 节点来源类型。'assetLibrary' = 素材库引用节点；'localFolder' = 本地文件夹直读引用，保存原文件而非副本。 */
  sourceType?: 'assetLibrary' | 'localFolder';
  // 节点由谁创建：外部 Agent / CLI 新建为 'agent'，画布 UI 为 'user'；旧数据缺省视为 'user'。资产区据此分组。
  origin?: 'agent' | 'user';
  /** 当 sourceType='assetLibrary' 时，对应 AssetItem.id，用于按 storageKey 反查 dataUrl */
  assetId?: string;
  href?: string;
  browserImport?: {
    importId: string;
    artifactId: string;
    contentHash: string;
    sourceUrl?: string;
    sourcePageUrl?: string;
    sourceTitle?: string;
  };
  artifactRef?: WorkflowArtifactRef;
  /** Agent 视频流水线某个版本的渲染（只读来源标记）；画布按 run 把各版本收进一个批次。 */
  pipelineRender?: { runId: string; version: number; artifactId: string; preset: string };
  /** 由 Creative Host 注入的 provider-neutral 资源定位信息。 */
  resourceLocator?: WorkflowResourceLocator;
  hostSend?: WorkflowHostSendRequest;
  poster?: string;
  /** 本地视频首帧 JPEG 的独立持久化键；不得内嵌为项目 JSON 的 base64。 */
  posterStorageKey?: string;
  // 浏览器解不了原编码时生成的 H.264 低清预览代理键；只用于画布播放，生成参考与下载用 storageKey 原文件。
  previewStorageKey?: string;
  storageKey?: string;
  name?: string;
  mimeType?: string;
  bytes?: number;
  naturalWidth?: number;
  naturalHeight?: number;
  durationMs?: number;
  status?: WorkflowNodeStatus;
  error?: string;
  progress?: number;
  uploading?: boolean;
  uploadBytes?: number;
  config?: WorkflowGenerationConfig;
  generationRequestId?: string;
  generationHistoryId?: string;
  generationStartedAt?: number;
  generationProviderTaskId?: string;
  /** 供应商已生成完成但本地下载失败：重试时用 generationProviderTaskId 重新查询并下载，不重新提交。 */
  generationDownloadPending?: boolean;
  /** 仅供溯源：供应商返回的原始远端媒体 URL（如 RunningHub 24h 临时链接）。节点的实际媒体数据始终以 storageKey/href 本地存储为准，此字段不可用于重新拉取已过期内容。 */
  remoteUrl?: string;
  generationUsageRecordId?: string;
  generationEstimatedCost?: number;
  generationActualCost?: number;
  generationCurrency?: 'USD' | 'CNY';
  generationActualTokens?: number;
  generationBillableState?: 'estimated' | 'actual' | 'unknown' | 'not_billable' | 'refunded';
  generationMessage?: string;
  // 生成中的传输明细；与 progress 同生同灭，结束、失败、停止时一并清空。
  generationTransfer?: GenerationTransfer;
  filters?: Partial<ImageFilters>;
  scriptBreakdown?: ScriptBreakdown;
  /** 设计元素（画板/矩形/椭圆/文字/钢笔路径）；仅 design 节点使用。 */
  design?: DesignElement;
  /** 旧批次指针（已弃用）：只在迁移前的叠放批次里出现；新数据用 alternates + mediaVariantId。 */
  primaryImageId?: string;
  /**
   * 多结果的备选（DESIGN 01 §13.3）：同一节点多张 / 多条生成结果里，首图就是节点本身，其余存在这里，
   * 不是画布节点。“设为首图”在节点与备选之间交换媒体字段，节点 ID、连线、prompt、配方都不动。
   */
  alternates?: WorkflowMediaAlternate[];
  /** 节点当前展示的那份媒体的稳定 ID（被换下时作为备选 ID 保留）；缺省即节点 ID。 */
  mediaVariantId?: string;
  /** 显式 Workflow Operation 的唯一可编辑配方与不可变执行记录。 */
  /** 生成记录：能力、配方、takes 与选中。挂在结果节点（image / video / audio）上；旧版 operation 节点在 v6 迁移时挪过来。 */
  operation?: WorkflowOperationRecord;
  /** v6 迁移时保存的原 operation 节点与连线，供 revertWorkflowDirectOutputMigration 还原。 */
  legacyOperationNode?: import('./directOutputMigration').WorkflowLegacyOperationSnapshot;
  /** 媒体结果反向定位其来源 Operation 与 Take。 */
  sourceOperationNodeId?: string;
  operationTakeId?: string;
  operationOutputRole?: WorkflowOperationOutputRole;
  productionProjection?: {
    projectionId: string;
    projectionVersion: number;
    productionSessionId: string;
    specRevisionId: string;
    productionRunId: string;
    stageRunId?: string | null;
    stageKey?: string | null;
    capabilityId?: string | null;
  };
  /** 仅 subgraph 节点：对应的逆向工程 id。 */
  reverseProjectId?: string;
  /** 仅 subgraph 节点：'group' = 用户分组框（Ctrl+G / workflow.group.create），没有对应逆向工程；缺省为逆向子画布。 */
  groupKind?: 'group';
  /** 仅 subgraph 节点：是否折叠（折叠时隐藏子节点及其连线）。 */
  collapsed?: boolean;
  /** 仅 subgraph 节点：子节点的稳定 reverseKey 列表。 */
  childKeys?: string[];
  /** 子画布内节点与逆向工程对象的稳定对应 key：'script' | 'shot:<id>' | 'slot:<id>'。 */
  reverseKey?: string;
  /** Iris 故事版里的素材分类（文本：剧本 / 其他；图片：角色 / 场景 / 物品 / 其他；视频：视频片段 / 成片）。缺省按节点语义推断，见 components/reverse/irisStoryboard.ts。 */
  storyboardTag?: 'script' | 'character' | 'scene' | 'prop' | 'clip' | 'final' | 'other';
}

/** 节点上的一份备选媒体（图片或视频，可混合）。id 稳定：来自旧的叠放兄弟节点 ID 或生成时分配。 */
export interface WorkflowMediaAlternate {
  id: string;
  type: 'image' | 'video';
  title?: string;
  /** 作为独立节点时的画布尺寸（拆成独立节点 / 设为首图时用来保持比例）。 */
  width?: number;
  height?: number;
  /** 产生它的那一批（生成批次 / 流水线 run）；Agent 的 batch pick 按它找候选。 */
  batchId?: string;
  batchIndex?: number;
  createdAt?: number;
  /** 媒体字段 + 来源（prompt、config、take / pipelineRender 等）；不含嵌套 alternates。 */
  metadata: WorkflowNodeMetadata;
}

/** Canvas 登记的“发送到宿主”请求；宿主面板读取后经用户确认执行。 */
export type WorkflowHostSendStatus = 'requested' | 'imported' | 'rejected' | 'unknown';

export interface WorkflowHostSendRequest {
  requestId: string;
  host: string;
  /** 宿主项目身份（冻结），宿主面板导入前必须核对。 */
  hostProjectId?: string;
  sourceNodeId: string;
  sourceLocator: Record<string, string | number>;
  target: 'media-pool';
  status: WorkflowHostSendStatus;
  requestedAt: string;
  updatedAt?: string;
  message?: string;
}

export interface WorkflowContextCardSource {
  kind: 'node' | 'asset';
  id: string;
  label: string;
  /** Commit 那一刻的内容指纹（services/turnContext）；空字符串 = 当时无法计算。 */
  fingerprintAtCommit: string;
}

export interface WorkflowContextCardVersion {
  title: string;
  content: string;
  sources: WorkflowContextCardSource[];
  committedAt: string;
}

export interface WorkflowAgentSessionReference {
  kind: 'node' | 'asset';
  id: string;
  label: string;
}

export interface WorkflowAgentSessionTurn {
  /** 最新一轮助手回复的持久化 entry id（内置会话）；外部 Agent 没有时省略。 */
  entryId?: string;
  /** 这一轮用户问题的前一小段（不含引用上下文）。 */
  prompt: string;
  /** 回复摘录（≤ 280 字，纯文本）；完整正文从会话读。 */
  excerpt: string;
  status: 'done' | 'error';
  at: string;
}

export interface WorkflowAgentSessionMeta {
  schemaVersion: 1;
  host: 'iris' | 'external';
  /** 绑定的内置会话 id；还没发出第一轮时为空。 */
  sessionId?: string;
  /** 'ask' = 双击空白就地问；'discuss' = 选中素材讨论。 */
  origin: 'ask' | 'discuss';
  /** 绑定素材：每一轮都作为显式引用（iris.turn_context）发送。 */
  references: WorkflowAgentSessionReference[];
  lastTurn?: WorkflowAgentSessionTurn;
  createdAt: string;
}

export interface WorkflowContextCardMeta {
  schemaVersion: 1;
  sourceMessage: { host: 'iris' | 'external'; sessionId?: string; messageId?: string };
  sources: WorkflowContextCardSource[];
  committedAt: string;
  /** 用户显式重新保存时保留的旧版本（新在后）。 */
  history?: WorkflowContextCardVersion[];
}

export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  title: string;
  position: WorkflowPoint;
  width: number;
  height: number;
  freeResize?: boolean;
  isVisible?: boolean;
  isLocked?: boolean;
  objectVersion?: number;
  batchId?: string;
  batchIndex?: number;
  batchGroupSource?: WorkflowBatchGroupSource;
  /** 所属子画布（subgraph）节点 id；文档仍是扁平 nodes，缺省即顶层节点。 */
  parentId?: string;
  /** 结构化分镜（LibTV/Higgsfield 式镜头表）：可选，缺省即普通节点。 */
  shot?: WorkflowShotMeta;
  /** 角色/场景/产品/风格锚点；仅 approved 时作为下游一致性参考。 */
  anchor?: WorkflowAnchorMeta;
  metadata: WorkflowNodeMetadata;
}

export interface WorkflowShotMeta {
  /** 1 起的镜号，决定成片拼接顺序。 */
  index: number;
  durationSec?: number;
  scene?: string;
  camera?: string;
  dialogue?: string;
  shotSize?: string;
  lighting?: string;
  audio?: string;
  /** 显式指定的锚点节点；未指定时使用上游连线中的已批准锚点。 */
  anchorNodeIds?: string[];
  /** 由脚本节点物化而来时：来源脚本节点与分镜行 id（脚本行反向保存 imageNodeId/videoNodeId）。 */
  scriptNodeId?: string;
  scriptShotId?: string;
}

export type WorkflowAnchorKind = 'character' | 'scene' | 'product' | 'style';

export interface WorkflowAnchorMeta {
  kind: WorkflowAnchorKind;
  approved: boolean;
  approvedAt?: string;
  /** 批准时分配的短编号（角色 A01 / 场景 S01 / 产品道具 P01 / 风格 T01）；取消批准后保留，保证引用稳定。 */
  code?: string;
}

/** 节点输出契约：节点自己声明下游可消费的资源，不由 resolver 按 node.type 猜测。 */
export interface WorkflowNodeDefinition {
  type: string;
  output(node: WorkflowNode): WorkflowResource[];
}

export interface WorkflowConnection {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  kind?: 'data' | 'operation-input' | 'operation-output';
  role?: WorkflowOperationInputRole | WorkflowOperationOutputRole;
  order?: number;
  objectVersion?: number;
}

export interface WorkflowAgentMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool' | 'error';
  text: string;
  title?: string;
  detail?: unknown;
  status?: 'pending' | 'success' | 'error' | 'denied';
  createdAt: string;
}

export interface WorkflowAgentSession {
  id: string;
  title: string;
  messages: WorkflowAgentMessage[];
  createdAt: string;
  updatedAt: string;
}

/** 一条由 Agent/CLI/MCP 驱动的可撤销 Workflow Draft Action 记录（AI 原生画布过程可追溯）。 */
export interface WorkflowDraftLogEntry {
  id: string;
  at: string;
  source: 'ui' | 'cli' | 'agent' | 'operator';
  command: string;
  /** 人类可读的中文动作摘要（如「创建图片节点「关键帧·hook-wide」」）。 */
  summary: string;
  ok: boolean;
  message?: string;
  nodeIds?: string[];
  connectionIds?: string[];
}

export type WorkflowDraftActor = 'ui' | 'cli' | 'agent' | 'operator';
export type WorkflowDraftChangeSetStatus = 'completed' | 'partial' | 'failed' | 'undone';

export interface WorkflowDraftNodeChange {
  id: string;
  before?: WorkflowNode;
  after?: WorkflowNode;
}

export interface WorkflowDraftConnectionChange {
  id: string;
  before?: WorkflowConnection;
  after?: WorkflowConnection;
}

export interface WorkflowDraftChangeSet {
  id: string;
  at: string;
  actor: WorkflowDraftActor;
  intent: string;
  status: WorkflowDraftChangeSetStatus;
  baseDraftVersion: number;
  resultDraftVersion: number;
  nodeChanges: WorkflowDraftNodeChange[];
  connectionChanges: WorkflowDraftConnectionChange[];
  nodeOrderBefore?: string[];
  nodeOrderAfter?: string[];
  undoneAt?: string;
  undoneDraftVersion?: number;
  redoneAt?: string;
  redoneDraftVersion?: number;
}

export type WorkflowMutationSource = 'ui' | 'promptbar' | 'cli' | 'agent' | 'dsh';

export interface WorkflowMutationOperationResult {
  index: number;
  type: WorkflowDocumentOperation['type'];
  status: 'applied';
}

export interface WorkflowMutationReceipt {
  mutationId: string;
  projectId: string;
  requestHash: string;
  previousRevision: number;
  revision: number;
  applied: true;
  replayed: boolean;
  operationResults: WorkflowMutationOperationResult[];
  changeSetId: string;
  createdAt: string;
}

export interface WorkflowProject {
  id: string;
  title: string;
  nodes: WorkflowNode[];
  connections: WorkflowConnection[];
  selectedNodeIds: string[];
  viewport: WorkflowViewport;
  backgroundMode: WorkflowBackgroundMode;
  agentSessions: WorkflowAgentSession[];
  activeAgentSessionId: string | null;
  /** AI/CLI/MCP 驱动的草稿动作记录；设计师据此回溯并二次编辑。 */
  draftLog?: WorkflowDraftLogEntry[];
  draftChangeSets?: WorkflowDraftChangeSet[];
  draftRedoStack?: string[];
  draftVersion?: number;
  workflowMutationReceipts?: WorkflowMutationReceipt[];
  /** 用户命名的画布快照（本地保存，恢复时走可撤销的文档变更）。 */
  snapshots?: WorkflowNamedSnapshot[];
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowSnapshot {
  projectId: string;
  title: string;
  nodes: WorkflowNode[];
  connections: WorkflowConnection[];
  selectedNodeIds: string[];
  viewport: WorkflowViewport;
}

export interface WorkflowNamedSnapshot {
  id: string;
  name: string;
  createdAt: string;
  nodes: WorkflowNode[];
  connections: WorkflowConnection[];
  viewport?: WorkflowViewport;
}

export type WorkflowDocumentOperation =
  | { type: 'add_node'; node: WorkflowNode }
  | { type: 'create_connected_node'; fromNodeId: string; node: WorkflowNode }
  | { type: 'update_node'; id: string; patch?: Partial<Omit<WorkflowNode, 'id'>>; metadata?: WorkflowNodeMetadata; replaceMetadata?: boolean }
  | { type: 'delete_nodes'; ids: string[] }
  | { type: 'delete_connections'; ids?: string[]; all?: boolean }
  | { type: 'connect_nodes'; id?: string; fromNodeId: string; toNodeId: string; kind?: WorkflowConnection['kind']; role?: WorkflowConnection['role']; order?: number }
  | { type: 'move_nodes'; positions: Array<{ id: string; position: WorkflowPoint }> }
  | { type: 'reorder_nodes'; ids: string[] }
  | { type: 'reorder_connections'; ids: string[] }
  | { type: 'group_nodes'; ids: string[]; batchId: string; source?: WorkflowBatchGroupSource }
  | { type: 'ungroup_nodes'; ids: string[] }
  | { type: 'set_batch_primary'; batchId: string; nodeId: string };

export type WorkflowViewOperation =
  | { type: 'select_nodes'; ids: string[] }
  | { type: 'set_viewport'; viewport: WorkflowViewport }
  | { type: 'focus_node'; nodeId: string; viewport?: WorkflowViewport };

/** Compatibility union for callers that can submit either document or browser-local view operations. */
export type WorkflowOp = WorkflowDocumentOperation | WorkflowViewOperation;

export interface WorkflowMutationEnvelope {
  clientId?: string;
  projectId: string;
  expectedRevision: number;
  mutationId: string;
  source: WorkflowMutationSource;
  intent?: string;
  ops: WorkflowDocumentOperation[];
  expectedObjectVersions?: Record<string, number>;
}

export interface StylePreset {
  id: string;
  name: string;
  category: string;
  promptPrefix: string;
  previewUrl?: string;
  isCustom?: boolean;
}

export interface CameraMovement {
  id: string;
  name: string;
  description: string;
  promptKeyword: string;
  isCustom?: boolean;
}

