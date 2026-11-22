// 音频波形：解码时边走边取峰值（每秒固定个数的 max |sample|），不保留整段 PCM；
// 时间线按片段的入点、跨度和像素宽度从峰值数组里重采样。
// 思路参考 OpenReel Video 的时间线波形（MIT），这里只取「流式峰值 + 按视窗重采样」，不搬它的组件。

/** 每秒峰值个数：100 足够在最大缩放下画出清晰的波形，1 小时素材约 1.4 MB。 */
export const CUT_PEAKS_PER_SECOND = 100;

export interface CutWaveform {
  /** 每个元素是一段（1 / peaksPerSecond 秒）里所有声道的最大绝对值，0–1。 */
  peaks: Float32Array;
  peaksPerSecond: number;
  /** 峰值覆盖的素材时长（秒）。 */
  duration: number;
}

/** 流式累加：按解码块的时间戳把样本落到对应的峰值格里，块可以乱序或有缺口。 */
export class CutPeakAccumulator {
  private peaks: Float32Array;
  private end = 0;

  constructor(readonly peaksPerSecond = CUT_PEAKS_PER_SECOND, expectedDuration = 0) {
    this.peaks = new Float32Array(Math.max(1, Math.ceil(expectedDuration * peaksPerSecond)));
  }

  private ensure(length: number) {
    if (length <= this.peaks.length) return;
    const next = new Float32Array(Math.max(length, this.peaks.length * 2));
    next.set(this.peaks);
    this.peaks = next;
  }

  push(timestamp: number, sampleRate: number, channels: ArrayLike<number>[]) {
    if (!channels.length || !(sampleRate > 0)) return;
    const frames = channels[0].length;
    const samplesPerPeak = sampleRate / this.peaksPerSecond;
    // 块的结束时间是开区间：最后一个样本所在的格。
    const last = Math.max(0, Math.ceil((timestamp + frames / sampleRate) * this.peaksPerSecond - 1e-9) - 1);
    this.ensure(last + 1);
    const offset = timestamp * sampleRate;
    for (let index = 0; index < frames; index += 1) {
      const bin = Math.floor((offset + index) / samplesPerPeak);
      if (bin < 0) continue;
      let value = 0;
      for (const channel of channels) {
        const sample = Math.abs(channel[index]);
        if (sample > value) value = sample;
      }
      if (value > this.peaks[bin]) this.peaks[bin] = value > 1 ? 1 : value;
    }
    if (last + 1 > this.end) this.end = Math.min(this.peaks.length, last + 1);
  }

  result(): CutWaveform {
    const peaks = this.peaks.slice(0, Math.max(1, this.end));
    return { peaks, peaksPerSecond: this.peaksPerSecond, duration: peaks.length / this.peaksPerSecond };
  }
}

/**
 * 取素材 [from, to) 秒的波形，重采样成 bins 个值（每格取最大值，保证短促的峰不会被跳过）。
 * 超出素材的部分为 0。
 */
export function sliceWaveform(waveform: CutWaveform, from: number, to: number, bins: number): Float32Array {
  const count = Math.max(0, Math.floor(bins));
  const out = new Float32Array(count);
  if (!count || !(to > from)) return out;
  const { peaks, peaksPerSecond } = waveform;
  const step = (to - from) / count;
  for (let bin = 0; bin < count; bin += 1) {
    const start = Math.floor((from + bin * step) * peaksPerSecond);
    const end = Math.max(start + 1, Math.ceil((from + (bin + 1) * step) * peaksPerSecond));
    let value = 0;
    for (let index = Math.max(0, start); index < Math.min(peaks.length, end); index += 1) {
      if (peaks[index] > value) value = peaks[index];
    }
    out[bin] = value;
  }
  return out;
}

/** 画成上下对称的竖条；volume 按片段音量缩放（上限 1，超过 100% 的音量画满）。 */
export function drawWaveform(
  ctx: Pick<CanvasRenderingContext2D, 'clearRect' | 'fillRect'> & { fillStyle: string | CanvasGradient | CanvasPattern },
  values: Float32Array,
  width: number,
  height: number,
  options: { color?: string; volume?: number } = {},
) {
  ctx.clearRect(0, 0, width, height);
  if (!values.length) return;
  ctx.fillStyle = options.color ?? 'rgba(255, 255, 255, 0.55)';
  const gain = Math.max(0, options.volume ?? 1);
  const barWidth = width / values.length;
  const middle = height / 2;
  for (let index = 0; index < values.length; index += 1) {
    const amplitude = Math.min(1, values[index] * gain);
    const bar = Math.max(1, amplitude * height * 0.9);
    ctx.fillRect(index * barWidth, middle - bar / 2, Math.max(1, barWidth - 0.5), bar);
  }
}
