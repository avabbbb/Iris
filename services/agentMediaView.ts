// Agent 读画布媒体：把图片/视频节点转成模型可看的图片块。
// 图片缩到长边 ≤ 1024px（JPEG）；视频默认拼成一张带时间码的帧网格（可分页），也可以按首/中/尾或秒数逐帧附图；
// 单次最多 6 张，控制上下文与费用。
import type { ImageContent } from '@earendil-works/pi-ai';
import type { WorkflowNode } from '../components/workflow/types';
import { loadWorkflowMediaBlob, workflowBlobToDataUrl } from '../components/workflow/media';
import { extractVideoFrame, extractVideoFramesAt } from './videoFrameExtractor';
import {
  COMPARE_MAX_PANELS,
  FRAME_GRID_DEFAULT_COUNT,
  FRAME_SIGNATURE_SIZE,
  describeFrameGrid,
  describeSceneCuts,
  detectSceneCuts,
  frameSignatureFromRgba,
  planCompareLayout,
  describeMediaSize,
  frameGridLabel,
  normalizeFrameTimes,
  planFrameGridLayout,
  planFrameGridTimes,
  type FrameGridLayout,
} from './agentFrameGrid';

export const AGENT_MEDIA_MAX_EDGE = 1024;
export const AGENT_MEDIA_MAX_IMAGES = 6;

export type AgentVideoFrame = 'first' | 'middle' | 'last';
export const AGENT_VIDEO_FRAMES: readonly AgentVideoFrame[] = ['first', 'middle', 'last'];
const FRAME_LABEL: Record<AgentVideoFrame, string> = { first: '首', middle: '中', last: '尾' };

/** grid：多帧拼成一张带时间码的网格（默认）；frames：每帧单独一张图。 */
export type AgentVideoLayout = 'grid' | 'frames';

export interface AgentVideoGridOptions {
  count?: number;
  start?: number;
  end?: number;
  page?: number;
}

export interface AgentMediaView {
  images: ImageContent[];
  // 每个节点一行：附带了什么、或为什么没有附带，按顺序对应 images。
  notes: string[];
  /** 逐节点的结构化送达记录（按 nodes 顺序；images 里该节点占 imageCount 张）。Spatial Context P0 据此记录实际送进模型的画面。 */
  sources?: AgentNodeMediaSource[];
}

export interface AgentNodeMediaSource {
  nodeId: string;
  imageCount: number;
  kind?: 'image' | 'video-grid' | 'video-frames';
  frames?: Array<number | string>;
  note?: string;
}

export async function loadAgentNodeMedia(
  nodes: readonly WorkflowNode[],
  options: {
    frames?: readonly AgentVideoFrame[];
    times?: readonly number[];
    maxImages?: number;
    layout?: AgentVideoLayout;
    grid?: AgentVideoGridOptions;
    /** true：把这些节点（图片原图 / 视频帧网格）并排拼成一张对比图，例如参考图 vs 产物。 */
    compare?: boolean;
  } = {},
): Promise<AgentMediaView> {
  if (options.compare) return loadAgentMediaComparison(nodes, { times: options.times, grid: options.grid });
  const maxImages = options.maxImages ?? AGENT_MEDIA_MAX_IMAGES;
  const frames = options.frames?.length ? options.frames : AGENT_VIDEO_FRAMES;
  // 只给了 frames（首/中/尾）且没指定 layout 时沿用逐帧附图；其余情况默认帧网格。
  const layout: AgentVideoLayout = options.layout ?? (options.frames?.length && !options.times?.length ? 'frames' : 'grid');
  // 调用方给了秒数就按秒切帧（任意时间点），否则仍按首/中/尾。
  const times = (options.times || []).filter(time => Number.isFinite(time) && time >= 0);
  const images: ImageContent[] = [];
  const notes: string[] = [];
  const sources: AgentNodeMediaSource[] = [];
  for (const node of nodes) {
    if (images.length >= maxImages) {
      notes.push(node.id + '：已达 ' + maxImages + ' 张上限，未附带');
      sources.push({ nodeId: node.id, imageCount: 0, note: '已达 ' + maxImages + ' 张上限，未附带' });
      continue;
    }
    if (node.type !== 'image' && node.type !== 'video') {
      notes.push(node.id + '：' + node.type + ' 节点没有可查看的画面');
      sources.push({ nodeId: node.id, imageCount: 0, note: node.type + ' 节点没有可查看的画面' });
      continue;
    }
    try {
      const { storageKey, href, artifactRef } = node.metadata;
      const blob = await loadWorkflowMediaBlob(storageKey, href, artifactRef);
      if (node.type === 'image') {
        const sized = await toSizedImageContent(blob);
        images.push(sized.image);
        sources.push({ nodeId: node.id, imageCount: 1, kind: 'image' });
        const size = describeMediaSize(sized.width, sized.height);
        notes.push(node.id + '：图片「' + node.title + '」' + (size ? '（' + size + '）' : ''));
        continue;
      }
      if (layout === 'grid') {
        const grid = await loadVideoFrameGrid(blob, { times, grid: options.grid });
        images.push(grid.image);
        sources.push({ nodeId: node.id, imageCount: 1, kind: 'video-grid', frames: [...grid.times] });
        notes.push(describeFrameGrid({ nodeId: node.id, title: node.title, duration: grid.duration, times: grid.times, layout: grid.layout, page: grid.page, totalPages: grid.totalPages, width: grid.width, height: grid.height })
          + '\n  ' + describeSceneCuts(grid.duration, grid.times, grid.cuts));
        continue;
      }
      if (times.length) {
        const taken: string[] = [];
        for (const time of times) {
          if (images.length >= maxImages) break;
          const extracted = await extractVideoFrame(blob, 'current', time);
          images.push(await toImageContent(extracted.blob));
          taken.push(time + 's');
        }
        sources.push({ nodeId: node.id, imageCount: taken.length, kind: 'video-frames', frames: times.slice(0, taken.length) });
        notes.push(node.id + '：视频「' + node.title + '」帧 ' + taken.join('/'));
        continue;
      }
      const taken: string[] = [];
      for (const frame of frames) {
        if (images.length >= maxImages) break;
        const extracted = await extractVideoFrame(blob, frame);
        images.push(await toImageContent(extracted.blob));
        taken.push(FRAME_LABEL[frame]);
      }
      sources.push({ nodeId: node.id, imageCount: taken.length, kind: 'video-frames', frames: [...taken] });
      notes.push(node.id + '：视频「' + node.title + '」' + taken.join('/') + '帧');
    } catch (error) {
      notes.push(node.id + '：读取失败（' + (error instanceof Error ? error.message : String(error)) + '）');
      sources.push({ nodeId: node.id, imageCount: 0, note: '读取失败' });
    }
  }
  return { images, notes, sources };
}

export async function toImageContent(blob: Blob): Promise<ImageContent> {
  return (await toSizedImageContent(blob)).image;
}

/** 同 toImageContent，另外带回原图实测宽高（缩放前）。 */
async function toSizedImageContent(blob: Blob): Promise<{ image: ImageContent; width: number; height: number }> {
  const bitmap = await createImageBitmap(blob);
  const width = bitmap.width;
  const height = bitmap.height;
  try {
    // 长边超过 AGENT_MEDIA_MAX_EDGE 时等比缩小，不放大。
    const divisor = Math.max(1, Math.max(bitmap.width, bitmap.height) / AGENT_MEDIA_MAX_EDGE);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width / divisor));
    canvas.height = Math.max(1, Math.round(bitmap.height / divisor));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('图像处理上下文初始化失败');
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const { promise, resolve } = Promise.withResolvers<Blob | null>();
    canvas.toBlob(resolve, 'image/jpeg', 0.85);
    const jpeg = await promise;
    if (!jpeg) throw new Error('画面编码失败');
    const dataUrl = await workflowBlobToDataUrl(jpeg);
    return { image: { type: 'image', data: dataUrl.slice(dataUrl.indexOf(',') + 1), mimeType: 'image/jpeg' }, width, height };
  } finally {
    bitmap.close();
  }
}

/** 一次加载视频，取帧拼成网格并在每格左上角标 #序号 时间码。 */
async function loadVideoFrameGrid(
  blob: Blob,
  options: { times: readonly number[]; grid?: AgentVideoGridOptions },
): Promise<{ image: ImageContent; canvas: HTMLCanvasElement; duration: number; times: number[]; cuts: ReturnType<typeof detectSceneCuts>; layout: FrameGridLayout; page: number; totalPages: number; width: number; height: number }> {
  const signatures: Array<number[] | undefined> = [];
  const probe = document.createElement('canvas');
  probe.width = FRAME_SIGNATURE_SIZE;
  probe.height = FRAME_SIGNATURE_SIZE;
  const probeContext = probe.getContext('2d', { willReadFrequently: true } as CanvasRenderingContext2DSettings);
  let sourceWidth = 0;
  let sourceHeight = 0;
  let canvas: HTMLCanvasElement | null = null;
  let ctx: CanvasRenderingContext2D | null = null;
  let layout: FrameGridLayout | null = null;
  let page = 1;
  let totalPages = 1;
  const result = await extractVideoFramesAt(
    blob,
    (duration, size) => {
      sourceWidth = size.width;
      sourceHeight = size.height;
      let times: number[];
      if (options.times.length) {
        times = normalizeFrameTimes(options.times, duration);
      } else {
        const plan = planFrameGridTimes({ duration, count: options.grid?.count ?? FRAME_GRID_DEFAULT_COUNT, start: options.grid?.start, end: options.grid?.end, page: options.grid?.page });
        times = plan.times;
        page = plan.page;
        totalPages = plan.totalPages;
      }
      layout = planFrameGridLayout({ count: times.length, frameWidth: size.width, frameHeight: size.height });
      canvas = document.createElement('canvas');
      canvas.width = layout.width;
      canvas.height = layout.height;
      ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('图像处理上下文初始化失败');
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, layout.width, layout.height);
      return times;
    },
    (video, time, index) => {
      const cell = layout!.cells[index];
      const context = ctx!;
      context.drawImage(video, cell.x, cell.y, cell.width, cell.height);
      // 8×8 灰度签名：相邻采样帧突变 = 切镜候选（粗略时间线）。读不了像素（跨域等）时跳过。
      if (probeContext) {
        try {
          probeContext.drawImage(video, 0, 0, FRAME_SIGNATURE_SIZE, FRAME_SIGNATURE_SIZE);
          signatures[index] = frameSignatureFromRgba(probeContext.getImageData(0, 0, FRAME_SIGNATURE_SIZE, FRAME_SIGNATURE_SIZE).data);
        } catch {
          signatures[index] = undefined;
        }
      }
      const label = frameGridLabel(index, time);
      const fontSize = layout!.fontSize;
      context.font = 'bold ' + fontSize + 'px sans-serif';
      const padding = Math.round(fontSize * 0.35);
      const textWidth = context.measureText(label).width;
      context.fillStyle = 'rgba(0,0,0,0.65)';
      context.fillRect(cell.x, cell.y, textWidth + padding * 2, fontSize + padding * 2);
      context.fillStyle = '#fff';
      context.textBaseline = 'top';
      context.fillText(label, cell.x + padding, cell.y + padding);
    },
  );
  if (!canvas || !layout) throw new Error('视频没有可截取的帧');
  const jpeg = await canvasToJpeg(canvas);
  const dataUrl = await workflowBlobToDataUrl(jpeg);
  return {
    image: { type: 'image', data: dataUrl.slice(dataUrl.indexOf(',') + 1), mimeType: 'image/jpeg' },
    canvas,
    duration: result.duration,
    times: result.times,
    cuts: detectSceneCuts(result.times, signatures),
    layout,
    page,
    totalPages,
    width: sourceWidth,
    height: sourceHeight,
  };
}

async function canvasToJpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  const { promise, resolve } = Promise.withResolvers<Blob | null>();
  canvas.toBlob(resolve, 'image/jpeg', 0.85);
  const jpeg = await promise;
  if (!jpeg) throw new Error('画面编码失败');
  return jpeg;
}

/**
 * 并排对比（P2-H）：每个节点一格——图片用原图，视频用带时间码的帧网格——缩到同一高度横排成一张图，
 * 每格上方标「#序号 节点名」。用来对照参考素材检查产物的风格、角色、构图是否一致。最多 COMPARE_MAX_PANELS 个节点。
 */
export async function loadAgentMediaComparison(
  nodes: readonly WorkflowNode[],
  options: { times?: readonly number[]; grid?: AgentVideoGridOptions } = {},
): Promise<AgentMediaView> {
  const notes: string[] = [];
  const panels: Array<{ source: CanvasImageSource; width: number; height: number; label: string; close?: () => void }> = [];
  const times = (options.times || []).filter(time => Number.isFinite(time) && time >= 0);
  for (const node of nodes) {
    if (panels.length >= COMPARE_MAX_PANELS) {
      notes.push(node.id + '：对比最多 ' + COMPARE_MAX_PANELS + ' 个节点，未加入');
      continue;
    }
    if (node.type !== 'image' && node.type !== 'video') {
      notes.push(node.id + '：' + node.type + ' 节点没有可对比的画面');
      continue;
    }
    try {
      const { storageKey, href, artifactRef } = node.metadata;
      const blob = await loadWorkflowMediaBlob(storageKey, href, artifactRef);
      const label = '#' + (panels.length + 1) + ' ' + (node.title || node.id);
      if (node.type === 'image') {
        const bitmap = await createImageBitmap(blob);
        panels.push({ source: bitmap, width: bitmap.width, height: bitmap.height, label, close: () => bitmap.close() });
        notes.push(label + '（' + node.id + '）：图片' + (describeMediaSize(bitmap.width, bitmap.height) ? '，' + describeMediaSize(bitmap.width, bitmap.height) : ''));
      } else {
        const grid = await loadVideoFrameGrid(blob, { times, grid: options.grid });
        panels.push({ source: grid.canvas, width: grid.canvas.width, height: grid.canvas.height, label });
        notes.push(label + '（' + node.id + '）：' + describeFrameGrid({ nodeId: node.id, title: node.title, duration: grid.duration, times: grid.times, layout: grid.layout, width: grid.width, height: grid.height })
          + '；' + describeSceneCuts(grid.duration, grid.times, grid.cuts));
      }
    } catch (error) {
      notes.push(node.id + '：读取失败（' + (error instanceof Error ? error.message : String(error)) + '）');
    }
  }
  if (!panels.length) return { images: [], notes };
  try {
    const layout = planCompareLayout(panels);
    const canvas = document.createElement('canvas');
    canvas.width = layout.width;
    canvas.height = layout.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('图像处理上下文初始化失败');
    context.fillStyle = '#111';
    context.fillRect(0, 0, layout.width, layout.height);
    context.font = 'bold ' + Math.round(layout.labelHeight * 0.6) + 'px sans-serif';
    context.textBaseline = 'middle';
    panels.forEach((panel, index) => {
      const cell = layout.panels[index];
      context.drawImage(panel.source, cell.x, cell.y, cell.width, cell.height);
      context.fillStyle = '#fff';
      context.fillText(panel.label, cell.x + 6, layout.labelHeight / 2, Math.max(10, cell.width - 12));
    });
    const jpeg = await canvasToJpeg(canvas);
    const dataUrl = await workflowBlobToDataUrl(jpeg);
    return {
      images: [{ type: 'image', data: dataUrl.slice(dataUrl.indexOf(',') + 1), mimeType: 'image/jpeg' }],
      notes: ['并排对比图：' + panels.length + ' 格，左→右依次为 ' + panels.map(panel => panel.label).join('、') + '，每格缩到同一高度', ...notes],
    };
  } finally {
    panels.forEach(panel => panel.close?.());
  }
}
