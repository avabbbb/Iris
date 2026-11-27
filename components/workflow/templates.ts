import { nanoid } from 'nanoid';
import { createWorkflowNode } from './constants';
import type { WorkflowConnection, WorkflowNode } from './types';

export type WorkflowTemplateId =
  | 'text-to-image'
  | 'reference-edit'
  | 'storyboard-video'
  | 'product-scene'
  | 'character-turnaround'
  | 'multi-angle-studio'
  | 'commercial-three-shot'
  | 'video-extend-retake'
  | 'relight-portrait'
  | 'music-beat-edit';

type Localized = { zho: string; eng: string };

export interface WorkflowTemplate {
  id: WorkflowTemplateId;
  category?: string;
  featuredOnStart?: boolean;
  title: Localized;
  description: Localized;
  samplePrompt: Localized;
  keywords: readonly string[];
}

export interface WorkflowTemplateSeed {
  templateId: WorkflowTemplateId;
  title: string;
  nodes: WorkflowNode[];
  connections: WorkflowConnection[];
}

export const WORKFLOW_TEMPLATES: readonly WorkflowTemplate[] = [
  {
    id: 'text-to-image',
    category: '基础',
    featuredOnStart: true,
    title: { zho: '一句话出图', eng: 'Text to image' },
    description: { zho: '提示词 → 图片', eng: 'Prompt → image' },
    samplePrompt: { zho: '雨夜霓虹街头的赛博朋克猫，电影感海报', eng: 'A cyberpunk cat on a rainy neon street, cinematic poster' },
    keywords: [],
  },
  {
    id: 'reference-edit',
    category: '修图',
    featuredOnStart: true,
    title: { zho: '参考图改图', eng: 'Edit a reference' },
    description: { zho: '参考图 → 改图结果', eng: 'Reference → edited image' },
    samplePrompt: { zho: '保持人物不变，换成秋天的公园背景', eng: 'Keep the subject, switch to an autumn park background' },
    keywords: ['参考', '改图', '换背景', '修改', '这张图', 'reference', 'edit', 'restyle'],
  },
  {
    id: 'storyboard-video',
    category: '影视',
    featuredOnStart: true,
    title: { zho: '故事到视频', eng: 'Story to video' },
    description: { zho: '故事 → 关键帧 → 视频', eng: 'Story → keyframe → video' },
    samplePrompt: { zho: '清晨的海边，一个女孩追着风筝奔跑', eng: 'A girl chasing a kite on the beach at dawn' },
    keywords: ['视频', '分镜', '镜头', '短片', '动画', 'video', 'storyboard', 'shot', 'clip', 'animate'],
  },
  {
    id: 'product-scene',
    category: '电商',
    featuredOnStart: true,
    title: { zho: '产品换场景', eng: 'Product in scene' },
    description: { zho: '产品图 → 场景图 → 展示视频', eng: 'Product → scene → showcase video' },
    samplePrompt: { zho: '放在大理石台面上，柔和晨光，高级感', eng: 'On a marble counter, soft morning light, premium feel' },
    keywords: ['产品', '商品', '电商', '主图', '包装', 'product', 'packshot', 'ecommerce'],
  },
  {
    id: 'character-turnaround',
    category: '一致性',
    title: { zho: '角色三视图与跨场景一致性', eng: 'Character Turnaround & Consistency' },
    description: { zho: '角色锚点 A01 → 三视图设定 → 剧情特写 → 表演视频', eng: 'Character anchor → 3-view turnaround → scene shot → performance clip' },
    samplePrompt: { zho: '银发机能风少女角色设定，高细节电影级光影', eng: 'Silver-haired techwear heroine character sheet, cinematic lighting' },
    keywords: ['角色', '三视图', '人物设定', '一致性', 'character', 'turnaround'],
  },
  {
    id: 'multi-angle-studio',
    category: '3D 视角',
    title: { zho: '多机位 3D 影视棚拍', eng: 'Multi-Angle 3D Camera Shoot' },
    description: { zho: '主机位定妆 → 低机位仰拍 → 特写镜头 → 环绕成片', eng: 'Hero frame → low-angle → close-up → orbiting video' },
    samplePrompt: { zho: '未来感概念跑车停在雨后霓虹隧道，ARRI ALEXA 35', eng: 'Futuristic concept car in rain-soaked neon tunnel, ARRI ALEXA 35' },
    keywords: ['多角度', '多机位', '3d', 'angle', 'orbit'],
  },
  {
    id: 'commercial-three-shot',
    category: '广告',
    title: { zho: '三镜头电影感商业广告', eng: '3-Shot Cinematic Commercial' },
    description: { zho: '建立全景 → 材质微距特写 → 品牌落幅镜头', eng: 'Establishing wide → macro detail → end-card hero shot' },
    samplePrompt: { zho: '手冲精品咖啡慢动作水花，暖调胶片质感', eng: 'Artisan pour-over coffee slow-motion bloom, warm 35mm film' },
    keywords: ['广告', '商业', '三镜头', 'commercial', 'tvc'],
  },
  {
    id: 'video-extend-retake',
    category: '视频精修',
    title: { zho: '视频延长与重拍流水线', eng: 'Video Extend & Retake Pipeline' },
    description: { zho: '原始镜头 → 尾帧衔接延长 → 换运镜重拍候选', eng: 'Source shot → seamless extension → alternate camera retake' },
    samplePrompt: { zho: '穿行在雨夜霓虹街巷的跟拍长镜头，平滑推进', eng: 'Continuous tracking shot through rainy neon alley, smooth push-in' },
    keywords: ['延长', '重拍', 'extend', 'retake'],
  },
  {
    id: 'relight-portrait',
    category: '打光',
    title: { zho: '人像布光与电影调色', eng: 'Portrait Relight & Cinema Look' },
    description: { zho: '原图输入 → 黄金逆光重打光 → 宽银幕电影质感', eng: 'Source portrait → golden rim relight → anamorphic cinema look' },
    samplePrompt: { zho: '伦勃朗侧光 + 暖金轮廓光，Cooke 变形镜头柔焦', eng: 'Rembrandt side light + golden rim light, Cooke Anamorphic bokeh' },
    keywords: ['打光', '补光', '人像', 'relight', 'portrait'],
  },
  {
    id: 'music-beat-edit',
    category: '音乐视觉',
    title: { zho: '节奏卡点 MV / 静止系 MAD', eng: 'Beat-Synced MV / Still-MAD Blueprint' },
    description: { zho: '主视觉关键帧 → 高潮冲击分镜 → 卡点动态视频', eng: 'Hero keyframe → climax flash frame → beat-synced motion clip' },
    samplePrompt: { zho: '二次元高燃赛博舞台瞬间，强对比光束与粒子', eng: 'High-energy anime cyber stage climax, dramatic light beams and particles' },
    keywords: ['mv', 'mad', '卡点', '音乐', 'beat'],
  },
];

const ORIGIN = { x: 80, y: 120 };
const GAP = 120;

function place(type: WorkflowNode['type'], after: WorkflowNode | null, title: string, metadata: WorkflowNode['metadata'] = {}): WorkflowNode {
  const position = after ? { x: after.position.x + after.width + GAP, y: ORIGIN.y } : { ...ORIGIN };
  return { ...createWorkflowNode(nanoid(), type, position, metadata), title };
}

function chain(nodes: WorkflowNode[]): WorkflowConnection[] {
  const result: WorkflowConnection[] = [];
  for (let index = 1; index < nodes.length; index += 1) {
    const from = nodes.at(index - 1) as WorkflowNode;
    const to = nodes.at(index) as WorkflowNode;
    result.push({ id: nanoid(), fromNodeId: from.id, toNodeId: to.id, kind: 'data', order: 0 });
  }
  return result;
}

// 没有 AI Key 时的一句话起步：按关键词挑模板，默认一句话出图。
export function matchWorkflowTemplate(prompt: string): WorkflowTemplateId {
  const text = prompt.toLowerCase();
  const order: WorkflowTemplateId[] = ['product-scene', 'storyboard-video', 'reference-edit'];
  for (const id of order) {
    const template = WORKFLOW_TEMPLATES.find(item => item.id === id);
    if (template && template.keywords.some(keyword => text.includes(keyword))) return id;
  }
  return 'text-to-image';
}

// 只搭节点和连线，不自动运行；生成仍由用户在节点上确认。
export function buildWorkflowTemplate(id: WorkflowTemplateId, prompt: string, language: string): WorkflowTemplateSeed {
  const zh = language === 'zho';
  const template = WORKFLOW_TEMPLATES.find(item => item.id === id) || (WORKFLOW_TEMPLATES.at(0) as WorkflowTemplate);
  const text = prompt.trim() || (zh ? template.samplePrompt.zho : template.samplePrompt.eng);
  const title = text.length > 24 ? text.slice(0, 24) + '…' : text;
  let nodes: WorkflowNode[];
  if (template.id === 'reference-edit') {
    const reference = place('image', null, zh ? '参考图（拖入或上传）' : 'Reference (drop or upload)');
    const result = place('image', reference, zh ? '改图结果' : 'Edited image', { prompt: text, config: { mode: 'image', preserveReferenceAspectRatio: true } });
    nodes = [reference, result];
  } else if (template.id === 'storyboard-video') {
    const story = place('text', null, zh ? '故事备注' : 'Story note', { content: text });
    const keyframe = place('image', story, zh ? '关键帧' : 'Keyframe', { prompt: text, config: { mode: 'image', aspectRatio: '16:9' } });
    const video = place('video', keyframe, zh ? '视频' : 'Video', { prompt: text, config: { mode: 'video', aspectRatio: '16:9', durationSec: 5 } });
    nodes = [story, keyframe, video];
  } else if (template.id === 'product-scene') {
    const product = place('image', null, zh ? '产品图（拖入或上传）' : 'Product (drop or upload)');
    const scene = place('image', product, zh ? '场景图' : 'Scene', { prompt: zh ? '保持产品外观不变，' + text : 'Keep the product unchanged. ' + text, config: { mode: 'image', preserveReferenceAspectRatio: true } });
    const showcase = place('video', scene, zh ? '展示视频' : 'Showcase video', { prompt: zh ? '产品展示镜头，缓慢环绕，' + text : 'Slow orbit product showcase. ' + text, config: { mode: 'video', durationSec: 5 } });
    nodes = [product, scene, showcase];
  } else if (template.id === 'character-turnaround') {
    const anchor = {
      ...place('image', null, zh ? '角色锚点 · 主设定' : 'Character Anchor · Hero', { prompt: text, colorTag: 'mint', pinned: true, config: { mode: 'image', aspectRatio: '3:4' } }),
      anchor: { kind: 'character' as const, approved: false },
    };
    const sheet = place('image', anchor, zh ? '角色三视图（正面/侧面/背面）' : '3-View Turnaround Sheet', { prompt: zh ? '基于参考角色生成标准三视图（正面、左侧面、背面），纯色背景，服装与五官完全一致' : 'Generate front, side, and back turnaround sheet preserving exact character identity and outfit', config: { mode: 'image', aspectRatio: '16:9' } });
    const sceneShot = place('image', sheet, zh ? '剧情中景镜头' : 'Scene Medium Shot', { prompt: zh ? '保持角色外貌完全一致，置于雨夜电影感街道中景，ARRI ALEXA 35 50mm f/1.8' : 'Place the exact character in a rainy cinematic street medium shot, ARRI ALEXA 35 50mm f/1.8', config: { mode: 'image', aspectRatio: '16:9', camera: { camera: 'ARRI ALEXA 35', focalLength: '50mm', aperture: 'f/1.8' } } });
    const perf = place('video', sceneShot, zh ? '角色表演视频' : 'Character Performance Video', { prompt: zh ? '角色自然转身看向镜头，发丝微动，缓慢推镜' : 'Character turns gently toward camera, subtle hair motion, slow push-in', config: { mode: 'video', aspectRatio: '16:9', durationSec: 5, draftMode: true, resolution: '480p', draftPreviousResolution: '1080p', cameraMovement: 'camera push in' } });
    nodes = [anchor, sheet, sceneShot, perf];
  } else if (template.id === 'multi-angle-studio') {
    const hero = place('image', null, zh ? '主机位 · 正面定妆' : 'Hero · Front View', { prompt: text, colorTag: 'sky', cameraRig: { yaw: 0, pitch: 0, roll: 0, zoom: 1, presetId: 'front' }, config: { mode: 'image', aspectRatio: '16:9', camera: { camera: 'ARRI ALEXA 35', lens: 'ARRI Signature Prime', focalLength: '35mm', aperture: 'f/2.0' } } });
    const lowAngle = place('image', hero, zh ? '低机位仰拍视角' : 'Low-Angle Hero View', { prompt: zh ? `${text} [Camera: dramatic low-angle hero shot looking up, 24mm focal length]` : `${text} [Camera: dramatic low-angle hero shot looking up, 24mm focal length]`, cameraRig: { yaw: -15, pitch: -32, roll: 0, zoom: 0.9, presetId: 'low-angle' }, config: { mode: 'image', aspectRatio: '16:9', camera: { focalLength: '24mm' } } });
    const closeup = place('image', lowAngle, zh ? '细节特写机位' : 'Tight Close-Up View', { prompt: zh ? `${text} [Camera: tight close-up framing, 85mm focal length, f/1.4, shallow depth of field]` : `${text} [Camera: tight close-up framing, 85mm focal length, f/1.4, shallow depth of field]`, cameraRig: { yaw: 24, pitch: 5, roll: 0, zoom: 0.58, presetId: 'closeup' }, config: { mode: 'image', aspectRatio: '16:9', camera: { focalLength: '85mm', aperture: 'f/1.4' } } });
    const orbit = place('video', closeup, zh ? '环绕成片镜头' : 'Orbit Showcase Video', { prompt: zh ? '平滑 180° 环绕运镜展示主体质感与光影' : 'Smooth 180-degree orbital camera move showcasing surface texture and lighting', config: { mode: 'video', aspectRatio: '16:9', durationSec: 5, cameraMovement: 'camera orbit' } });
    nodes = [hero, lowAngle, closeup, orbit];
  } else if (template.id === 'commercial-three-shot') {
    const s1 = { ...place('video', null, zh ? '镜头 01 · 建立全景' : 'Shot 01 · Establishing', { prompt: zh ? `${text}，全景建立镜头，缓慢推进，柔和晨光` : `${text}, wide establishing shot, slow push-in, soft morning light`, colorTag: 'amber', config: { mode: 'video', aspectRatio: '16:9', durationSec: 5, draftMode: true, resolution: '480p', draftPreviousResolution: '1080p', cameraMovement: 'camera push in' } }), shot: { index: 1, durationSec: 5, camera: 'push in' } };
    const s2 = { ...place('video', s1, zh ? '镜头 02 · 微距材质特写' : 'Shot 02 · Macro Detail', { prompt: zh ? `${text}，微距特写材质与高光纹理，浅景深` : `${text}, probe macro close-up texture and highlights, shallow DOF`, colorTag: 'amber', config: { mode: 'video', aspectRatio: '16:9', durationSec: 5, draftMode: true, resolution: '480p', draftPreviousResolution: '1080p', camera: { lens: 'Laowa 24mm Probe', aperture: 'f/2.0' } } }), shot: { index: 2, durationSec: 5, camera: 'macro' } };
    const s3 = { ...place('video', s2, zh ? '镜头 03 · 品牌落幅' : 'Shot 03 · Hero End Card', { prompt: zh ? `${text}，镜头缓慢拉远，构图留白便于叠加品牌标题` : `${text}, slow pull-back reveal with clean negative space for title card`, colorTag: 'amber', config: { mode: 'video', aspectRatio: '16:9', durationSec: 5, draftMode: true, resolution: '480p', draftPreviousResolution: '1080p', cameraMovement: 'camera pull out' } }), shot: { index: 3, durationSec: 5, camera: 'pull out' } };
    nodes = [s1, s2, s3];
  } else if (template.id === 'video-extend-retake') {
    const base = place('video', null, zh ? '原始视频镜头' : 'Source Video Clip', { prompt: text, colorTag: 'violet', config: { mode: 'video', aspectRatio: '16:9', durationSec: 5 } });
    const extended = place('video', base, zh ? '延长镜头（续写后续）' : 'Extended Continuation', { prompt: zh ? `${text}，无缝承接尾帧动作继续推进` : `${text}, seamless continuation from last frame`, config: { mode: 'video', aspectRatio: '16:9', durationSec: 5, submode: 'video-extension' } });
    const retake = place('video', extended, zh ? '重拍候选（换运镜）' : 'Retake · Alternate Camera', { prompt: zh ? `${text}，保持画面风格，改用低角度跟随运镜重演` : `${text}, maintain scene look, retake with low-angle tracking shot`, config: { mode: 'video', aspectRatio: '16:9', durationSec: 5, draftMode: true, resolution: '480p', draftPreviousResolution: '1080p', cameraMovement: 'tracking shot' } });
    nodes = [base, extended, retake];
  } else if (template.id === 'relight-portrait') {
    const src = place('image', null, zh ? '原始人像（上传或生成）' : 'Source Portrait', { prompt: text, colorTag: 'rose', config: { mode: 'image', aspectRatio: '3:4' } });
    const relit = place('image', src, zh ? '黄金时刻重打光' : 'Golden Rim Relight', { prompt: zh ? '保持人物五官和服饰完全不变，重打伦勃朗主光 + 暖金色发丝轮廓光，背景柔和虚化' : 'Preserve subject identity strictly, relight with Rembrandt key light and warm golden rim light', config: { mode: 'image', preserveReferenceAspectRatio: true, camera: { lens: 'Cooke Anamorphic/i SF', aperture: 'f/1.4' } } });
    const grade = place('image', relit, zh ? '电影胶片成片' : 'Cinema Film Finish', { prompt: zh ? '柯达 Vision3 500T 电影胶片调色，微细胶片颗粒，高级皮肤质感' : 'Kodak Vision3 500T cinema color grade, subtle film grain, editorial finish', config: { mode: 'image', preserveReferenceAspectRatio: true, camera: { camera: 'Kodak Vision3 500T' } } });
    nodes = [src, relit, grade];
  } else if (template.id === 'music-beat-edit') {
    const key1 = place('image', null, zh ? '主视觉 · 静止关键帧' : 'Key Visual · Still 01', { prompt: text, colorTag: 'violet', config: { mode: 'image', aspectRatio: '16:9' } });
    const key2 = place('image', key1, zh ? '高潮冲击 · 闪切帧' : 'Climax Flash · Still 02', { prompt: zh ? `${text}，极致动态仰角冲击构图，强对比光束与飞散粒子` : `${text}, dramatic impact low-angle flash cut, strong light shafts and particles`, cameraRig: { yaw: 18, pitch: -28, roll: 14, zoom: 0.72 }, config: { mode: 'image', aspectRatio: '16:9' } });
    const clip = place('video', key2, zh ? '节奏卡点动态片段' : 'Beat-Synced Motion Clip', { prompt: zh ? '强烈鼓点推进，瞬间变焦冲击与光效闪烁' : 'Punchy beat-synced zoom push with light flare impact', config: { mode: 'video', aspectRatio: '16:9', durationSec: 5, cameraMovement: 'zoom in' } });
    nodes = [key1, key2, clip];
  } else {
    const image = place('image', null, zh ? '图片' : 'Image', { prompt: text, config: { mode: 'image', aspectRatio: '1:1' } });
    nodes = [image];
  }
  return { templateId: template.id, title, nodes, connections: template.id === 'storyboard-video' ? chain(nodes.slice(1)) : chain(nodes) };
}

// 示例画布：明确标注为示例，浏览和编辑不需要 Key；运行时仍走计划卡与配置引导。
export function buildSampleCanvasSeed(language: string): Omit<WorkflowTemplateSeed, 'templateId'> {
  const zh = language === 'zho';
  const script = place('text', null, zh ? '示例 · 脚本' : 'Sample · Script', {
    content: zh
      ? '【示例】三镜头产品短片。浏览、编辑、连线都不需要 Key；运行镜头前需先在设置中配置自己的 AI 服务。'
      : '[Sample] A three-shot product clip. Browsing, editing and connecting need no key; running a shot needs your own AI service in Settings.',
  });
  const prompts = zh
    ? ['产品全景，镜头缓慢推进，柔光', '产品特写，侧光扫过材质', '产品落幅，镜头拉远，留白放标题']
    : ['Product wide shot, slow push-in, soft light', 'Product close-up, side light across the surface', 'End card, pull back, space for a title'];
  const shots: WorkflowNode[] = [];
  prompts.forEach((prompt, index) => {
    const shot = place('video', shots.at(-1) || script, (zh ? '示例 · 镜头 ' : 'Sample · Shot ') + (index + 1), { prompt, config: { mode: 'video', aspectRatio: '16:9', durationSec: 5 } });
    shots.push(shot);
  });
  const connections: WorkflowConnection[] = [];
  return { title: zh ? '示例 · 三镜头产品短片' : 'Sample · Three-shot product clip', nodes: [script, ...shots], connections };
}

// 由模板或示例新建、尚未适配视图的画布 id；画布首次测量到尺寸时适配一次后移除。
export const workflowFitOnOpen = new Set<string>();
