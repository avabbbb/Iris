import { z } from 'zod';
import type {
  WorkflowNodeType,
  WorkflowOperationCapabilityId,
  WorkflowOperationInputBinding,
  WorkflowOperationInputRole,
  WorkflowOperationMediaType,
  WorkflowOperationOutputRole,
} from './types';

export type WorkflowOperationExecutorKind = 'provider-generation' | 'local-transform' | 'provider-image-tool';
export type WorkflowOperationConfirmationClass = 'none' | 'paid-operation-subgraph';
export type WorkflowOperationNodeToolName =
  | 'crop'
  | 'upscale'
  | 'remove-background'
  | 'split-layers'
  | 'edit'
  | 'rotate'
  | 'vectorize'
  | 'split-grid'
  | 'layer'
  | 'video-trim'
  | 'video-av-split'
  | 'video-merge'
  | 'video-extract-frame'
  | 'audio-trim'
  | 'audio-speed'
  | 'audio-pitch'
  | 'audio-stem-split';

export interface WorkflowOperationInputRoleSpec {
  role: WorkflowOperationInputRole;
  nodeTypes: readonly WorkflowNodeType[];
  min: number;
  max?: number;
}

export type WorkflowOperationParameterControl =
  | { key: string; kind: 'number'; label: string; min?: number; max?: number; step?: number; scale?: number; suffix?: string }
  | { key: string; kind: 'select'; label: string; options: readonly { label: string; value: string }[] };

export interface WorkflowOperationCapability {
  id: WorkflowOperationCapabilityId;
  label: string;
  mediaType: WorkflowOperationMediaType;
  inputRoles: readonly WorkflowOperationInputRoleSpec[];
  outputRoles: readonly { role: WorkflowOperationOutputRole; nodeType: WorkflowOperationMediaType; min: number; max?: number }[];
  executor: WorkflowOperationExecutorKind;
  confirmation: WorkflowOperationConfirmationClass;
  workflow: true;
  table: boolean;
  uiKey: string;
  nodeTool?: WorkflowOperationNodeToolName;
  agentUsage?: string;
  parameters: z.ZodType<Record<string, unknown>>;
  nodeToolArguments?: z.ZodType<Record<string, unknown>>;
  parameterControls?: readonly WorkflowOperationParameterControl[];
  promptRequired?: boolean;
  summarizeParameters: (parameters: Record<string, unknown>) => string;
}

export type WorkflowOperationUiLanguage = 'en' | 'zho';

// 英文显示文案。中文标签仍是注册表里的唯一源，这里只按 id / key / value 翻译，缺词时回落中文。
const OPERATION_LABELS_EN: Readonly<Record<string, string>> = {
  'image.generate@1': 'Image generation', 'image.crop@1': 'Crop image', 'image.upscale@1': 'Upscale',
  'image.remove-background@1': 'Remove background', 'image.split-layers@1': 'Split layers', 'image.edit@1': 'Edit image',
  'image.rotate@1': 'Rotate / flip', 'image.vectorize@1': 'Vectorize', 'image.split-grid@1': 'Split grid',
  'image.layer@1': 'Overlay layer', 'video.trim@1': 'Trim video', 'video.av-split@1': 'Split audio and video',
  'video.merge@1': 'Merge videos', 'video.extract-frame@1': 'Extract frame', 'audio.trim@1': 'Trim audio',
  'audio.speed@1': 'Audio speed', 'audio.pitch@1': 'Audio pitch', 'audio.stem-split@1': 'Split vocals / accompaniment',
};
const PARAMETER_LABELS_EN: Readonly<Record<string, string>> = {
  x: 'Left', y: 'Top', width: 'Width', height: 'Height', targetLongEdge: 'Long edge', algorithm: 'Algorithm',
  action: 'Action', preset: 'Style', rows: 'Rows', cols: 'Columns', style: 'Style', count: 'Candidates',
  startSec: 'Start', endSec: 'End', position: 'Position', speed: 'Speed', semitones: 'Semitones',
};
const OPTION_LABELS_EN: Readonly<Record<string, string>> = {
  high: 'High quality', bilinear: 'Smooth', nearest: 'Pixel',
  'rotate-90': 'Rotate 90° CW', 'rotate-180': 'Rotate 180°', 'rotate-270': 'Rotate 90° CCW', 'flip-h': 'Flip horizontal', 'flip-v': 'Flip vertical',
  detailed: 'Detailed', poster: 'Poster', line: 'Line art',
  doodle: 'Doodle', glow: 'Glow', title: 'Title', sticker: 'Sticker',
  first: 'First frame', current: 'Current frame', last: 'Last frame',
};
const SUFFIX_EN: Readonly<Record<string, string>> = { '秒': 's', '半音': 'st' };

export function localizeOperationLabel(capability: Pick<WorkflowOperationCapability, 'id' | 'label'>, language?: WorkflowOperationUiLanguage): string {
  return language === 'en' ? OPERATION_LABELS_EN[capability.id] || capability.label : capability.label;
}

export function localizeParameterControl(control: WorkflowOperationParameterControl, language?: WorkflowOperationUiLanguage): WorkflowOperationParameterControl {
  if (language !== 'en') return control;
  const label = PARAMETER_LABELS_EN[control.key] || control.label;
  if (control.kind === 'select') return { ...control, label, options: control.options.map(option => ({ ...option, label: OPTION_LABELS_EN[option.value] || option.label })) };
  return { ...control, label, suffix: control.suffix && (SUFFIX_EN[control.suffix] || control.suffix) };
}

const generateParameters = z.object({
  submode: z.enum(['text-to-image', 'image-to-image']).optional(),
  aspectRatio: z.string().min(1).optional(),
  preserveReferenceAspectRatio: z.boolean().optional(),
  resolution: z.string().min(1).optional(),
  quality: z.string().min(1).optional(),
  count: z.number().int().min(1).max(4).default(1),
  enhancePrompt: z.boolean().optional(),
  webSearch: z.boolean().optional(),
  realPersonCheck: z.boolean().optional(),
});

const cropParameters = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().positive().max(1),
  height: z.number().positive().max(1),
}).refine(value => value.x + value.width <= 1 && value.y + value.height <= 1, '裁剪范围不能超出图片');

const avSplitParameters = z.object({
  audio: z.enum(['full', 'vocals', 'background']).default('full'),
});

const upscaleParameters = z.object({
  targetLongEdge: z.number().int().min(512).max(8192),
  algorithm: z.enum(['high', 'bilinear', 'nearest']).default('high'),
});

const imageEditParameters = z.object({
  variant: z.enum(['edit', 'outpaint', 'mask', 'annotate', 'relight']).default('edit'),
});

const imageEditToolArguments = z.object({
  prompt: z.string().trim().min(1),
  maskNodeId: z.string().min(1).optional(),
  maskHref: z.string().min(1).optional(),
  maskMimeType: z.string().min(1).optional(),
});

const imageRotateParameters = z.object({
  action: z.enum(['rotate-90', 'rotate-180', 'rotate-270', 'flip-h', 'flip-v']).default('rotate-90'),
});

const imageSplitGridParameters = z.object({
  rows: z.number().int().min(1).max(6).default(2),
  cols: z.number().int().min(1).max(6).default(2),
});

export const WORKFLOW_LAYER_STYLES = ['doodle', 'glow', 'title', 'sticker'] as const;
export type WorkflowLayerStyle = typeof WORKFLOW_LAYER_STYLES[number];
export const WORKFLOW_LAYER_STYLE_LABELS: Readonly<Record<WorkflowLayerStyle, string>> = {
  doodle: '涂鸦', glow: '光晕', title: '标题', sticker: '贴纸',
};

const imageLayerParameters = z.object({
  style: z.enum(WORKFLOW_LAYER_STYLES).default('doodle'),
  count: z.number().int().min(1).max(4).default(4),
});

const videoTrimParameters = z.object({
  startSec: z.number().min(0),
  endSec: z.number().positive(),
}).refine(value => value.endSec > value.startSec, '视频结束时间必须晚于开始时间');

const noParameters = z.object({});

const imageVectorizeParameters = z.object({
  preset: z.enum(['detailed', 'poster', 'line']).default('detailed'),
});

const videoMergeToolArguments = z.object({
  sourceNodeIds: z.array(z.string().min(1)).min(2),
}).refine(value => new Set(value.sourceNodeIds).size === value.sourceNodeIds.length, '视频拼接来源不能重复');

const videoExtractFrameParameters = z.object({
  position: z.enum(['first', 'current', 'last']).default('first'),
  currentTimeSec: z.number().min(0).optional(),
});

const audioTrimParameters = z.object({
  startSec: z.number().min(0),
  endSec: z.number().positive(),
}).refine(value => value.endSec > value.startSec, '音频结束时间必须晚于开始时间');

const audioSpeedParameters = z.object({ speed: z.number().min(.25).max(4) });
const audioPitchParameters = z.object({ semitones: z.number().min(-12).max(12).refine(value => value !== 0, '变调半音数不能为 0') });

export const WORKFLOW_OPERATION_CAPABILITIES: Readonly<Record<WorkflowOperationCapabilityId, WorkflowOperationCapability>> = {
  'image.generate@1': {
    id: 'image.generate@1', label: '图片生成',
    mediaType: 'image',
    inputRoles: [
      { role: 'reference_image', nodeTypes: ['image'], min: 0 },
    ],
    outputRoles: [{ role: 'result_image', nodeType: 'image', min: 1, max: 4 }],
    executor: 'provider-generation', confirmation: 'paid-operation-subgraph', workflow: true, table: false,
    uiKey: 'image-generate',
    parameters: generateParameters,
    promptRequired: true,
    summarizeParameters: parameters => `${parameters.aspectRatio || '自适应'} · ×${parameters.count || 1}`,
  },
  'image.crop@1': {
    id: 'image.crop@1', label: '裁剪图片',
    mediaType: 'image',
    inputRoles: [{ role: 'source_image', nodeTypes: ['image'], min: 1, max: 1 }],
    outputRoles: [{ role: 'result_image', nodeType: 'image', min: 1, max: 1 }],
    executor: 'local-transform', confirmation: 'none', workflow: true, table: true,
    uiKey: 'image-crop', nodeTool: 'crop', agentUsage: 'crop 使用归一化 x/y/width/height（范围 0-1 且不得越界）',
    parameters: cropParameters,
    parameterControls: [
      { key: 'x', kind: 'number', label: '左侧', min: 0, max: 100, step: 1, scale: 100, suffix: '%' },
      { key: 'y', kind: 'number', label: '顶部', min: 0, max: 100, step: 1, scale: 100, suffix: '%' },
      { key: 'width', kind: 'number', label: '宽度', min: 1, max: 100, step: 1, scale: 100, suffix: '%' },
      { key: 'height', kind: 'number', label: '高度', min: 1, max: 100, step: 1, scale: 100, suffix: '%' },
    ],
    summarizeParameters: parameters => `${Math.round(Number(parameters.width || 0) * 100)}% × ${Math.round(Number(parameters.height || 0) * 100)}%`,
  },
  'image.upscale@1': {
    id: 'image.upscale@1', label: '高清放大',
    mediaType: 'image',
    inputRoles: [{ role: 'source_image', nodeTypes: ['image'], min: 1, max: 1 }],
    outputRoles: [{ role: 'result_image', nodeType: 'image', min: 1, max: 1 }],
    executor: 'provider-image-tool', confirmation: 'paid-operation-subgraph', workflow: true, table: true,
    uiKey: 'image-upscale', nodeTool: 'upscale', agentUsage: 'upscale 使用 targetLongEdge（512-8192）和 algorithm（high/bilinear/nearest）',
    parameters: upscaleParameters,
    parameterControls: [
      { key: 'targetLongEdge', kind: 'number', label: '长边', min: 512, max: 8192, step: 256, suffix: 'px' },
      { key: 'algorithm', kind: 'select', label: '算法', options: [
        { label: '高清', value: 'high' },
        { label: '平滑', value: 'bilinear' },
        { label: '像素', value: 'nearest' },
      ] },
    ],
    summarizeParameters: parameters => `${parameters.targetLongEdge || '-'}px · ${parameters.algorithm || '-'}`,
  },
  'image.remove-background@1': {
    id: 'image.remove-background@1', label: '移除背景', mediaType: 'image',
    inputRoles: [{ role: 'source_image', nodeTypes: ['image'], min: 1, max: 1 }],
    outputRoles: [{ role: 'result_image', nodeType: 'image', min: 1, max: 1 }],
    executor: 'provider-image-tool', confirmation: 'paid-operation-subgraph', workflow: true, table: true,
    uiKey: 'image-remove-background', nodeTool: 'remove-background', agentUsage: 'remove-background 无额外参数',
    parameters: noParameters,
    summarizeParameters: () => '透明背景',
  },
  'image.split-layers@1': {
    id: 'image.split-layers@1', label: '拆分图层', mediaType: 'image',
    inputRoles: [{ role: 'source_image', nodeTypes: ['image'], min: 1, max: 1 }],
    outputRoles: [{ role: 'result_image', nodeType: 'image', min: 1 }],
    executor: 'provider-image-tool', confirmation: 'paid-operation-subgraph', workflow: true, table: true,
    uiKey: 'image-split-layers', nodeTool: 'split-layers', agentUsage: 'split-layers 无额外参数，可返回多个图层',
    parameters: noParameters,
    summarizeParameters: () => '多图层输出',
  },
  'image.edit@1': {
    id: 'image.edit@1', label: '图片编辑', mediaType: 'image',
    inputRoles: [
      { role: 'source_image', nodeTypes: ['image'], min: 1, max: 1 },
      { role: 'mask_image', nodeTypes: ['image'], min: 0, max: 1 },
    ],
    outputRoles: [{ role: 'result_image', nodeType: 'image', min: 1, max: 1 }],
    executor: 'provider-image-tool', confirmation: 'paid-operation-subgraph', workflow: true, table: true,
    uiKey: 'image-edit', nodeTool: 'edit', agentUsage: 'edit 必须提供 prompt，可选 maskNodeId 或 maskHref/maskMimeType',
    parameters: imageEditParameters,
    nodeToolArguments: imageEditToolArguments,
    promptRequired: true,
    summarizeParameters: parameters => ({ edit: '描述编辑', outpaint: '扩展画面', mask: '蒙版编辑', annotate: '标注编辑', relight: '重新打光' }[String(parameters.variant)] || '描述编辑'),
  },
  'image.rotate@1': {
    id: 'image.rotate@1', label: '旋转镜像', mediaType: 'image',
    inputRoles: [{ role: 'source_image', nodeTypes: ['image'], min: 1, max: 1 }],
    outputRoles: [{ role: 'result_image', nodeType: 'image', min: 1, max: 1 }],
    executor: 'local-transform', confirmation: 'none', workflow: true, table: true,
    uiKey: 'image-rotate', nodeTool: 'rotate', agentUsage: 'rotate 使用 action（rotate-90/rotate-180/rotate-270/flip-h/flip-v）',
    parameters: imageRotateParameters,
    parameterControls: [{ key: 'action', kind: 'select', label: '动作', options: [
      { label: '顺时针 90°', value: 'rotate-90' }, { label: '旋转 180°', value: 'rotate-180' },
      { label: '逆时针 90°', value: 'rotate-270' }, { label: '水平镜像', value: 'flip-h' }, { label: '垂直镜像', value: 'flip-v' },
    ] }],
    summarizeParameters: parameters => ({ 'rotate-90': '顺时针 90°', 'rotate-180': '旋转 180°', 'rotate-270': '逆时针 90°', 'flip-h': '水平镜像', 'flip-v': '垂直镜像' }[String(parameters.action)] || '顺时针 90°'),
  },
  'image.vectorize@1': {
    id: 'image.vectorize@1', label: '矢量化', mediaType: 'image',
    inputRoles: [{ role: 'source_image', nodeTypes: ['image'], min: 1, max: 1 }],
    outputRoles: [{ role: 'result_image', nodeType: 'image', min: 1, max: 1 }],
    executor: 'local-transform', confirmation: 'none', workflow: true, table: true,
    uiKey: 'image-vectorize', nodeTool: 'vectorize', agentUsage: 'vectorize 使用 preset（detailed/poster/line），输出 SVG 图片',
    parameters: imageVectorizeParameters,
    parameterControls: [{ key: 'preset', kind: 'select', label: '风格', options: [
      { label: '细节', value: 'detailed' }, { label: '色块', value: 'poster' }, { label: '线稿', value: 'line' },
    ] }],
    summarizeParameters: parameters => ({ detailed: '细节', poster: '色块', line: '线稿' }[String(parameters.preset)] || '细节') + ' · SVG',
  },
  'image.split-grid@1': {
    id: 'image.split-grid@1', label: '宫格切分', mediaType: 'image',
    inputRoles: [{ role: 'source_image', nodeTypes: ['image'], min: 1, max: 1 }],
    outputRoles: [{ role: 'result_image', nodeType: 'image', min: 1, max: 36 }],
    executor: 'local-transform', confirmation: 'none', workflow: true, table: true,
    uiKey: 'image-split-grid', nodeTool: 'split-grid', agentUsage: 'split-grid 使用 rows/cols（1-6）',
    parameters: imageSplitGridParameters,
    parameterControls: [
      { key: 'rows', kind: 'number', label: '行', min: 1, max: 6, step: 1 },
      { key: 'cols', kind: 'number', label: '列', min: 1, max: 6, step: 1 },
    ],
    summarizeParameters: parameters => `${parameters.rows || 2} × ${parameters.cols || 2}`,
  },
  'image.layer@1': {
    id: 'image.layer@1', label: '叠加层', mediaType: 'image',
    inputRoles: [
      { role: 'source_image', nodeTypes: ['image'], min: 1, max: 1 },
      { role: 'mask_image', nodeTypes: ['image'], min: 0, max: 1 },
    ],
    outputRoles: [{ role: 'result_image', nodeType: 'image', min: 1, max: 4 }],
    executor: 'provider-image-tool', confirmation: 'paid-operation-subgraph', workflow: true, table: false,
    uiKey: 'image-layer', nodeTool: 'layer',
    agentUsage: 'layer 必须提供 prompt，可选 style（doodle/glow/title/sticker）、count（1-4，默认 4）与 maskNodeId 或 maskHref/maskMimeType；输出与原图同尺寸的透明叠加层候选，不改原图',
    parameters: imageLayerParameters,
    nodeToolArguments: imageEditToolArguments,
    parameterControls: [
      { key: 'style', kind: 'select', label: '风格', options: WORKFLOW_LAYER_STYLES.map(value => ({ label: WORKFLOW_LAYER_STYLE_LABELS[value], value })) },
      { key: 'count', kind: 'number', label: '候选', min: 1, max: 4, step: 1 },
    ],
    promptRequired: true,
    summarizeParameters: parameters => (WORKFLOW_LAYER_STYLE_LABELS[parameters.style as WorkflowLayerStyle] || WORKFLOW_LAYER_STYLE_LABELS.doodle) + ' · ×' + (parameters.count || 4),
  },
  'video.trim@1': {
    id: 'video.trim@1', label: '视频剪辑', mediaType: 'video',
    inputRoles: [{ role: 'source_video', nodeTypes: ['video'], min: 1, max: 1 }],
    outputRoles: [{ role: 'result_video', nodeType: 'video', min: 1, max: 1 }],
    executor: 'local-transform', confirmation: 'none', workflow: true, table: true,
    uiKey: 'video-trim', nodeTool: 'video-trim', agentUsage: 'video-trim 使用 startSec/endSec，且 endSec 必须晚于 startSec',
    parameters: videoTrimParameters,
    parameterControls: [
      { key: 'startSec', kind: 'number', label: '开始', min: 0, step: .1, suffix: '秒' },
      { key: 'endSec', kind: 'number', label: '结束', min: .1, step: .1, suffix: '秒' },
    ],
    summarizeParameters: parameters => `${Number(parameters.startSec || 0).toFixed(1)}s → ${Number(parameters.endSec || 0).toFixed(1)}s`,
  },
  'video.av-split@1': {
    id: 'video.av-split@1', label: '音视频分离', mediaType: 'video',
    inputRoles: [{ role: 'source_video', nodeTypes: ['video'], min: 1, max: 1 }],
    outputRoles: [
      { role: 'result_video', nodeType: 'video', min: 1, max: 1 },
      { role: 'result_audio', nodeType: 'audio', min: 1, max: 1 },
    ],
    executor: 'local-transform', confirmation: 'none', workflow: true, table: true,
    uiKey: 'video-av-split', nodeTool: 'video-av-split', agentUsage: 'video-av-split 可选 audio：full（默认，完整音轨）/ vocals（人声）/ background（背景音）；输出无声视频与一条音频',
    parameters: avSplitParameters,
    summarizeParameters: parameters => parameters.audio === 'vocals' ? '无声视频 + 人声' : parameters.audio === 'background' ? '无声视频 + 背景音' : '无声视频 + 音频',
  },
  'video.merge@1': {
    id: 'video.merge@1', label: '视频拼接', mediaType: 'video',
    inputRoles: [{ role: 'source_video', nodeTypes: ['video'], min: 2 }],
    outputRoles: [{ role: 'result_video', nodeType: 'video', min: 1, max: 1 }],
    executor: 'local-transform', confirmation: 'none', workflow: true, table: true,
    uiKey: 'video-merge', nodeTool: 'video-merge', agentUsage: 'video-merge 使用有序 sourceNodeIds（至少 2 个且不得重复）',
    parameters: noParameters,
    nodeToolArguments: videoMergeToolArguments,
    summarizeParameters: () => '按输入顺序拼接',
  },
  'video.extract-frame@1': {
    id: 'video.extract-frame@1', label: '导出视频帧', mediaType: 'video',
    inputRoles: [{ role: 'source_video', nodeTypes: ['video'], min: 1, max: 1 }],
    outputRoles: [{ role: 'result_image', nodeType: 'image', min: 1, max: 1 }],
    executor: 'local-transform', confirmation: 'none', workflow: true, table: true,
    uiKey: 'video-extract-frame', nodeTool: 'video-extract-frame', agentUsage: 'video-extract-frame 使用 position（first/current/last），current 可传 currentTimeSec',
    parameters: videoExtractFrameParameters,
    parameterControls: [{ key: 'position', kind: 'select', label: '位置', options: [
      { label: '首帧', value: 'first' },
      { label: '当前帧', value: 'current' },
      { label: '尾帧', value: 'last' },
    ] }],
    summarizeParameters: parameters => parameters.position === 'last' ? '尾帧' : parameters.position === 'current' ? `当前帧 ${Number(parameters.currentTimeSec || 0).toFixed(1)}s` : '首帧',
  },
  'audio.trim@1': {
    id: 'audio.trim@1', label: '音频截取', mediaType: 'audio',
    inputRoles: [{ role: 'source_audio', nodeTypes: ['audio'], min: 1, max: 1 }],
    outputRoles: [{ role: 'result_audio', nodeType: 'audio', min: 1, max: 1 }],
    executor: 'local-transform', confirmation: 'none', workflow: true, table: true,
    uiKey: 'audio-trim', nodeTool: 'audio-trim', agentUsage: 'audio-trim 使用 startSec/endSec，且 endSec 必须晚于 startSec',
    parameters: audioTrimParameters,
    parameterControls: [
      { key: 'startSec', kind: 'number', label: '开始', min: 0, step: .1, suffix: '秒' },
      { key: 'endSec', kind: 'number', label: '结束', min: .1, step: .1, suffix: '秒' },
    ],
    summarizeParameters: parameters => `${Number(parameters.startSec || 0).toFixed(1)}s → ${Number(parameters.endSec || 0).toFixed(1)}s`,
  },
  'audio.speed@1': {
    id: 'audio.speed@1', label: '音频变速', mediaType: 'audio',
    inputRoles: [{ role: 'source_audio', nodeTypes: ['audio'], min: 1, max: 1 }],
    outputRoles: [{ role: 'result_audio', nodeType: 'audio', min: 1, max: 1 }],
    executor: 'local-transform', confirmation: 'none', workflow: true, table: true,
    uiKey: 'audio-speed', nodeTool: 'audio-speed', agentUsage: 'audio-speed 使用 speed（0.25-4）',
    parameters: audioSpeedParameters,
    parameterControls: [{ key: 'speed', kind: 'number', label: '速度', min: .25, max: 4, step: .05, suffix: '×' }],
    summarizeParameters: parameters => `${Number(parameters.speed || 1).toFixed(2)}×`,
  },
  'audio.pitch@1': {
    id: 'audio.pitch@1', label: '音频变调', mediaType: 'audio',
    inputRoles: [{ role: 'source_audio', nodeTypes: ['audio'], min: 1, max: 1 }],
    outputRoles: [{ role: 'result_audio', nodeType: 'audio', min: 1, max: 1 }],
    executor: 'local-transform', confirmation: 'none', workflow: true, table: true,
    uiKey: 'audio-pitch', nodeTool: 'audio-pitch', agentUsage: 'audio-pitch 使用 semitones（-12 到 12，且不能为 0）',
    parameters: audioPitchParameters,
    parameterControls: [{ key: 'semitones', kind: 'number', label: '半音', min: -12, max: 12, step: 1, suffix: '半音' }],
    summarizeParameters: parameters => `${Number(parameters.semitones || 0) > 0 ? '+' : ''}${Number(parameters.semitones || 0)} 半音`,
  },
  'audio.stem-split@1': {
    id: 'audio.stem-split@1', label: '人声/伴奏分离', mediaType: 'audio',
    inputRoles: [{ role: 'source_audio', nodeTypes: ['audio'], min: 1, max: 1 }],
    outputRoles: [
      { role: 'result_audio', nodeType: 'audio', min: 2, max: 2 },
    ],
    executor: 'local-transform', confirmation: 'none', workflow: true, table: true,
    uiKey: 'audio-stem-split', nodeTool: 'audio-stem-split', agentUsage: 'audio-stem-split 无额外参数，输出人声与伴奏两条音轨',
    parameters: noParameters,
    summarizeParameters: () => '人声 + 伴奏',
  },
};

export const WORKFLOW_OPERATION_CAPABILITY_IDS = Object.keys(WORKFLOW_OPERATION_CAPABILITIES) as WorkflowOperationCapabilityId[];
export const WORKFLOW_OPERATION_NODE_TOOLS = WORKFLOW_OPERATION_CAPABILITY_IDS
  .map(id => WORKFLOW_OPERATION_CAPABILITIES[id].nodeTool)
  .filter((tool): tool is WorkflowOperationNodeToolName => Boolean(tool));

export function getWorkflowOperationCapability(id: WorkflowOperationCapabilityId): WorkflowOperationCapability {
  return WORKFLOW_OPERATION_CAPABILITIES[id];
}

export function getWorkflowOperationCapabilityByNodeTool(tool: string): WorkflowOperationCapability | undefined {
  return WORKFLOW_OPERATION_CAPABILITY_IDS
    .map(id => WORKFLOW_OPERATION_CAPABILITIES[id])
    .find(capability => capability.nodeTool === tool);
}

export function getWorkflowOperationInputRoleForNodeType(
  id: WorkflowOperationCapabilityId,
  nodeType: WorkflowNodeType,
): WorkflowOperationInputRole | null {
  return getWorkflowOperationCapability(id).inputRoles.find(input => input.nodeTypes.includes(nodeType))?.role || null;
}

export function validateWorkflowOperationInputBindings(
  id: WorkflowOperationCapabilityId,
  bindings: readonly WorkflowOperationInputBinding[],
  options: { requireMinimum?: boolean } = {},
): void {
  const capability = getWorkflowOperationCapability(id);
  const counts = new Map<WorkflowOperationInputRole, number>();
  const ids = new Set<string>();
  const sources = new Set<string>();
  const orders = new Set<number>();
  bindings.forEach(binding => {
    const spec = capability.inputRoles.find(input => input.role === binding.role);
    if (!spec) throw new Error(`${capability.label}不允许输入角色 ${binding.role}`);
    if (!Number.isInteger(binding.order) || binding.order < 0) throw new Error('Operation 输入顺序必须是非负整数');
    if (ids.has(binding.id)) throw new Error(`Operation 输入 Binding ID 重复：${binding.id}`);
    if (sources.has(binding.sourceNodeId)) throw new Error(`Operation 输入来源重复：${binding.sourceNodeId}`);
    if (orders.has(binding.order)) throw new Error(`Operation 输入顺序重复：${binding.order}`);
    ids.add(binding.id);
    sources.add(binding.sourceNodeId);
    orders.add(binding.order);
    counts.set(binding.role, (counts.get(binding.role) || 0) + 1);
  });
  capability.inputRoles.forEach(spec => {
    const count = counts.get(spec.role) || 0;
    if (spec.max !== undefined && count > spec.max) throw new Error(`${capability.label}最多允许 ${spec.max} 个 ${spec.role} 输入`);
    if (options.requireMinimum && count < spec.min) throw new Error(`${capability.label}至少需要 ${spec.min} 个 ${spec.role} 输入`);
  });
}

export function validateWorkflowOperationOutputs(
  id: WorkflowOperationCapabilityId,
  outputs: readonly { role: WorkflowOperationOutputRole; nodeType: WorkflowOperationMediaType }[],
): void {
  const capability = getWorkflowOperationCapability(id);
  const counts = new Map<WorkflowOperationOutputRole, number>();
  outputs.forEach(output => {
    const spec = capability.outputRoles.find(item => item.role === output.role);
    if (!spec || spec.nodeType !== output.nodeType) throw new Error(`${capability.label}不允许输出 ${output.role}/${output.nodeType}`);
    counts.set(output.role, (counts.get(output.role) || 0) + 1);
  });
  capability.outputRoles.forEach(spec => {
    const count = counts.get(spec.role) || 0;
    if (count < spec.min) throw new Error(`${capability.label}至少需要 ${spec.min} 个 ${spec.role} 输出`);
    if (spec.max !== undefined && count > spec.max) throw new Error(`${capability.label}最多允许 ${spec.max} 个 ${spec.role} 输出`);
  });
}

export function parseWorkflowOperationParameters(id: WorkflowOperationCapabilityId, value: unknown): Record<string, unknown> {
  return getWorkflowOperationCapability(id).parameters.parse(value);
}

export function parseWorkflowOperationNodeToolArguments(id: WorkflowOperationCapabilityId, value: unknown): Record<string, unknown> {
  const capability = getWorkflowOperationCapability(id);
  return (capability.nodeToolArguments || capability.parameters).parse(value);
}
