// Pure local browser Video Scene-Cut Detector (TapNow "Smart Split / 智能拆条" parity).
// Zero paid API, zero cloud upload: samples frames onto a tiny offscreen canvas,
// computes frame-to-frame luminance/RGB delta, and detects shot boundaries cleanly.

export interface SceneSplitSegment {
  index: number;
  startSec: number;
  endSec: number;
  durationSec: number;
  /** Peak transition delta at the start of this segment (0..1). */
  confidence: number;
}

export interface SceneDetectionOptions {
  /** Frame-difference threshold in [0.05..0.8]; lower = more sensitive. Default 0.28. */
  threshold?: number;
  /** Minimum shot length in seconds to suppress flash/flicker false cuts. Default 1.0. */
  minSegmentSec?: number;
  /** Maximum number of segments returned. Default 12. */
  maxSegments?: number;
}

export interface SampledFrameDelta {
  timeSec: number;
  delta: number;
}

/**
 * Compute normalized mean absolute RGB + luminance difference between two equal-length RGBA buffers.
 * Returns a value in [0, 1]. Pure function for deterministic testing.
 */
export function computeFrameDifference(prev: Uint8ClampedArray, next: Uint8ClampedArray): number {
  const len = Math.min(prev.length, next.length);
  if (len < 4) return 0;
  let sum = 0;
  let pixels = 0;
  for (let i = 0; i + 3 < len; i += 4) {
    const dr = Math.abs(prev[i] - next[i]);
    const dg = Math.abs(prev[i + 1] - next[i + 1]);
    const db = Math.abs(prev[i + 2] - next[i + 2]);
    // Weighted perceptual luminance + chroma delta normalized to [0, 1]
    sum += (dr * 0.299 + dg * 0.587 + db * 0.114) / 255;
    pixels += 1;
  }
  return pixels > 0 ? sum / pixels : 0;
}

/**
 * Pure cut-point detector over a sequence of `{ timeSec, delta }` samples.
 * Applies non-maximum suppression within `minSegmentSec` and returns contiguous clip ranges.
 */
export function detectSceneSegmentsFromDeltas(
  deltas: readonly SampledFrameDelta[],
  durationSec: number,
  options: SceneDetectionOptions = {},
): SceneSplitSegment[] {
  const total = Math.max(0, Number.isFinite(durationSec) ? durationSec : 0);
  if (total <= 0.1) return [];
  const threshold = Math.max(0.05, Math.min(0.85, options.threshold ?? 0.28));
  const minSegmentSec = Math.max(0.4, options.minSegmentSec ?? 1.0);
  const maxSegments = Math.max(2, Math.min(24, options.maxSegments ?? 12));

  // Collect candidate peaks above threshold
  const candidates = deltas
    .filter(sample => sample.timeSec >= minSegmentSec && sample.timeSec <= total - minSegmentSec && sample.delta >= threshold)
    .sort((a, b) => b.delta - a.delta);

  const accepted: SampledFrameDelta[] = [];
  for (const candidate of candidates) {
    if (accepted.length >= maxSegments - 1) break;
    const tooClose = accepted.some(existing => Math.abs(existing.timeSec - candidate.timeSec) < minSegmentSec);
    if (!tooClose) accepted.push(candidate);
  }
  accepted.sort((a, b) => a.timeSec - b.timeSec);

  const boundaries = [0, ...accepted.map(item => Math.round(item.timeSec * 100) / 100), Math.round(total * 100) / 100];
  const segments: SceneSplitSegment[] = [];
  for (let i = 0; i < boundaries.length - 1; i += 1) {
    const startSec = boundaries[i];
    const endSec = boundaries[i + 1];
    const dur = Math.round((endSec - startSec) * 100) / 100;
    if (dur < 0.2) continue;
    segments.push({
      index: segments.length + 1,
      startSec,
      endSec,
      durationSec: dur,
      confidence: i === 0 ? 1 : Math.round((accepted[i - 1]?.delta ?? threshold) * 100) / 100,
    });
  }
  return segments;
}

/**
 * Fallback equal-interval split when a video has only 1 continuous shot (no hard cuts).
 */
export function buildEvenSplitSegments(durationSec: number, count: number): SceneSplitSegment[] {
  const total = Math.max(0, Number.isFinite(durationSec) ? durationSec : 0);
  const parts = Math.max(2, Math.min(12, Math.round(count)));
  if (total < 0.5) return [];
  const step = total / parts;
  return Array.from({ length: parts }, (_, idx) => {
    const startSec = Math.round(idx * step * 100) / 100;
    const endSec = Math.round((idx === parts - 1 ? total : (idx + 1) * step) * 100) / 100;
    return {
      index: idx + 1,
      startSec,
      endSec,
      durationSec: Math.round((endSec - startSec) * 100) / 100,
      confidence: 1,
    };
  });
}

function seekVideoElement(video: HTMLVideoElement, timeSec: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSeeked = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error('Failed to seek video during scene analysis')); };
    const cleanup = () => {
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
    };
    video.addEventListener('seeked', onSeeked, { once: true });
    video.addEventListener('error', onError, { once: true });
    video.currentTime = Math.max(0, timeSec);
  });
}

/**
 * Analyze a video URL directly in the browser to detect shot cuts.
 * Samples up to ~48 thumbnails on a 64x36 canvas so analysis completes in ~1-3 seconds.
 */
export async function analyzeVideoSceneCuts(
  mediaUrl: string,
  options: SceneDetectionOptions & { onProgress?: (ratio: number) => void; signal?: AbortSignal } = {},
): Promise<{ durationSec: number; segments: SceneSplitSegment[]; deltas: SampledFrameDelta[] }> {
  if (typeof document === 'undefined') {
    throw new Error('Scene analysis requires a browser document');
  }
  const video = document.createElement('video');
  video.crossOrigin = 'anonymous';
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = mediaUrl;

  await new Promise<void>((resolve, reject) => {
    const onLoaded = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error('无法读取视频帧，请检查视频编码是否为 H.264 MP4')); };
    const cleanup = () => {
      video.removeEventListener('loadeddata', onLoaded);
      video.removeEventListener('error', onError);
    };
    video.addEventListener('loadeddata', onLoaded, { once: true });
    video.addEventListener('error', onError, { once: true });
  });

  const durationSec = Number.isFinite(video.duration) ? video.duration : 0;
  if (durationSec <= 0.2) return { durationSec, segments: [], deltas: [] };

  const sampleWidth = 64;
  const sampleHeight = 36;
  const canvas = document.createElement('canvas');
  canvas.width = sampleWidth;
  canvas.height = sampleHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return { durationSec, segments: buildEvenSplitSegments(durationSec, 2), deltas: [] };

  const stepSec = Math.max(0.25, Math.min(0.6, durationSec / 45));
  const sampleTimes: number[] = [];
  for (let t = 0; t < durationSec - 0.1; t += stepSec) sampleTimes.push(Math.round(t * 100) / 100);

  const deltas: SampledFrameDelta[] = [];
  let prevFrame: Uint8ClampedArray | null = null;
  for (let i = 0; i < sampleTimes.length; i += 1) {
    if (options.signal?.aborted) throw new Error('场景拆条已取消');
    const t = sampleTimes[i];
    await seekVideoElement(video, t);
    ctx.drawImage(video, 0, 0, sampleWidth, sampleHeight);
    const frame = ctx.getImageData(0, 0, sampleWidth, sampleHeight).data;
    if (prevFrame) {
      deltas.push({ timeSec: t, delta: computeFrameDifference(prevFrame, frame) });
    }
    prevFrame = new Uint8ClampedArray(frame);
    options.onProgress?.((i + 1) / sampleTimes.length);
  }

  video.removeAttribute('src');
  video.load();

  const segments = detectSceneSegmentsFromDeltas(deltas, durationSec, options);
  return { durationSec, segments, deltas };
}
