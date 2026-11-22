// Mediabunny（WebCodecs）实现：解码流、缩略图、离线混音、MP4 编码。
// 只被 CutEditor 引用 → 只在 Cut 编辑器 chunk 里，打开 Cut 才下载。
// 内存：Input 只持有 Blob 引用（按需切片读取，不整读进 JS 堆）；每条解码流用小 canvas 池；
// 缩略图是小尺寸 ImageBitmap，LRU 上限；dispose() 关掉所有 Input / 流 / 位图。
import {
  ALL_FORMATS,
  AudioBufferSink,
  AudioBufferSource,
  BlobSource,
  BufferTarget,
  CanvasSink,
  CanvasSource,
  Conversion,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  QUALITY_LOW,
  canEncodeAudio,
  canEncodeVideo,
  type InputAudioTrack,
  type InputVideoTrack,
  type VideoCodec,
  type WrappedCanvas,
} from 'mediabunny';
import { audioSegments, type CutEncoder, type CutFrameStream, type CutRenderBackend, type Drawable } from './render';
import type { CutClip, CutProject, CutSource, CutSourceKind } from './timeline';
import { deleteProxyFile, readProxyFile, writeProxyFile } from './proxyStore';
import { CUT_PEAKS_PER_SECOND, CutPeakAccumulator, type CutWaveform } from './waveform';
import { createCutExportTarget, type CutExportTarget } from './exportTarget';

export interface CutProbe { duration: number; width?: number; height?: number; hasAudio: boolean }

const THUMB_W = 96;
const THUMB_H = 54;
const THUMB_LIMIT = 160;
const IMAGE_MAX = 1920;

/** 顺序解码流：小池子 CanvasSink + 一个迭代器；回退或向前大跳时重开迭代器。 */
class SinkFrameStream implements CutFrameStream {
  private iterator: AsyncGenerator<WrappedCanvas, void, unknown> | null = null;
  private current: WrappedCanvas | null = null;
  private pending: WrappedCanvas | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(private sink: CanvasSink, private end: number) {}

  frameAt(sourceTime: number): Promise<Drawable | null> {
    const run = this.queue.then(() => this.advance(sourceTime));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async restart(sourceTime: number) {
    await this.iterator?.return(undefined);
    this.iterator = this.sink.canvases(sourceTime, this.end + 0.05);
    this.current = null;
    this.pending = null;
  }

  private async advance(t: number): Promise<Drawable | null> {
    if (this.closed) return null;
    const cur = this.current;
    if (!this.iterator || (cur && t < cur.timestamp - 1e-3) || (cur && t > cur.timestamp + 1.5)) await this.restart(t);
    while (this.iterator) {
      if (!this.pending) {
        const next = await this.iterator.next();
        if (next.done) break;
        this.pending = next.value as WrappedCanvas;
      }
      if (this.pending.timestamp <= t + 1e-4 || !this.current) {
        this.current = this.pending;
        this.pending = null;
        if (this.current.timestamp + this.current.duration > t + 1e-4) break;
      } else break;
    }
    return (this.current?.canvas as Drawable | undefined) ?? null;
  }

  close() {
    this.closed = true;
    void this.iterator?.return(undefined);
    this.iterator = null;
    this.current = null;
    this.pending = null;
  }
}

export interface CutProxyJob { height: number; progress: number; abort: AbortController }

export class CutMediaEngine implements CutRenderBackend {
  /** 代理状态变化（生成进度 / 完成 / 删除）。 */
  onProxyChange?: () => void;
  private proxies = new Map<string, { height: number; blob: Blob }>();
  private proxyJobs = new Map<string, CutProxyJob>();
  private blobs = new Map<string, Blob>();
  private inputs = new Map<string, Input>();
  private videoTracks = new Map<string, Promise<InputVideoTrack | null>>();
  private audioTracks = new Map<string, Promise<InputAudioTrack | null>>();
  private images = new Map<string, Promise<ImageBitmap | null>>();
  private thumbs = new Map<string, Promise<ImageBitmap | null>>();
  private waveforms = new Map<string, Promise<CutWaveform | null>>();
  private streams = new Set<SinkFrameStream>();
  private disposed = false;

  has(sourceId: string) { return this.blobs.has(sourceId); }

  setBlob(sourceId: string, blob: Blob) {
    this.dropSource(sourceId);
    this.blobs.set(sourceId, blob);
  }

  private input(sourceId: string): Input | null {
    const existing = this.inputs.get(sourceId);
    if (existing) return existing;
    const blob = this.blobs.get(sourceId);
    if (!blob || this.disposed) return null;
    const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
    this.inputs.set(sourceId, input);
    return input;
  }

  private videoTrack(sourceId: string) {
    if (!this.videoTracks.has(sourceId)) this.videoTracks.set(sourceId, (this.input(sourceId)?.getPrimaryVideoTrack() ?? Promise.resolve(null)).catch(() => null));
    return this.videoTracks.get(sourceId)!;
  }

  private audioTrack(sourceId: string) {
    if (!this.audioTracks.has(sourceId)) this.audioTracks.set(sourceId, (this.input(sourceId)?.getPrimaryAudioTrack() ?? Promise.resolve(null)).catch(() => null));
    return this.audioTracks.get(sourceId)!;
  }

  /** 读元数据：时长 / 尺寸 / 是否有声。只读容器头，不解码。 */
  async probe(sourceId: string, kind: CutSourceKind): Promise<CutProbe> {
    const blob = this.blobs.get(sourceId);
    if (!blob) throw new Error('media not loaded');
    if (kind === 'image') {
      const bitmap = await createImageBitmap(blob);
      const probe = { duration: 0, width: bitmap.width, height: bitmap.height, hasAudio: false };
      bitmap.close();
      return probe;
    }
    const input = this.input(sourceId);
    if (!input) throw new Error('media not loaded');
    const duration = await input.computeDuration();
    const video = kind === 'video' ? await this.videoTrack(sourceId) : null;
    const audio = await this.audioTrack(sourceId);
    const hasAudio = !!audio && await audio.canDecode().catch(() => false);
    if (kind === 'video' && (!video || !(await video.canDecode()))) throw new Error('This video codec cannot be decoded in this browser.');
    return { duration, width: video?.displayWidth, height: video?.displayHeight, hasAudio };
  }

  openVideoStream(clip: CutClip, size: { width: number; height: number }, options: { preferProxy?: boolean } = {}): CutFrameStream | null {
    if (!clip.sourceId || this.disposed) return null;
    // 预览优先用代理（低分辨率，解码便宜）；导出永远走原片。
    const sourceId = options.preferProxy && this.proxies.has(clip.sourceId) ? this.proxyKey(clip.sourceId) : clip.sourceId;
    let inner: SinkFrameStream | null = null;
    let closed = false;
    const ready = this.videoTrack(sourceId).then(track => {
      if (!track || closed) return null;
      // 输出画布按合成尺寸 contain 缩放：预览时是小画布，导出时是成片尺寸；池子 3 张循环复用。
      const sink = new CanvasSink(track, { width: size.width, height: size.height, fit: 'contain', poolSize: 3 });
      inner = new SinkFrameStream(sink, clip.in + clip.duration * (clip.speed ?? 1));
      this.streams.add(inner);
      return inner;
    });
    return {
      frameAt: async (t: number) => (await ready)?.frameAt(t) ?? null,
      close: () => {
        closed = true;
        if (inner) { inner.close(); this.streams.delete(inner); }
        else void ready.then(stream => { if (stream) { stream.close(); this.streams.delete(stream); } });
      },
    };
  }

  getImage(sourceId: string): Promise<Drawable | null> {
    if (!this.images.has(sourceId)) {
      const blob = this.blobs.get(sourceId);
      this.images.set(sourceId, blob ? (async () => {
        const probe = await createImageBitmap(blob);
        const scale = Math.min(1, IMAGE_MAX / Math.max(probe.width, probe.height));
        if (scale >= 1) return probe;
        probe.close();
        return createImageBitmap(blob, { resizeWidth: Math.round(probe.width * scale), resizeHeight: Math.round(probe.height * scale), resizeQuality: 'high' });
      })().catch(() => null) : Promise.resolve(null));
    }
    return this.images.get(sourceId)! as Promise<Drawable | null>;
  }

  /** 96×54 的小缩略图（LRU 缓存）。视频按 0.5 秒取整对齐，避免拖动时缓存爆炸。 */
  thumbnail(sourceId: string, kind: CutSourceKind, time = 0): Promise<ImageBitmap | null> {
    const key = `${sourceId}@${kind === 'video' ? Math.round(time * 2) / 2 : 0}`;
    const hit = this.thumbs.get(key);
    if (hit) {
      this.thumbs.delete(key);
      this.thumbs.set(key, hit);
      return hit;
    }
    const job = (async () => {
      const blob = this.blobs.get(sourceId);
      if (!blob || kind === 'audio') return null;
      if (kind === 'image') return createImageBitmap(blob, { resizeWidth: THUMB_W, resizeHeight: THUMB_H, resizeQuality: 'low' });
      const track = await this.videoTrack(sourceId);
      if (!track) return null;
      const sink = new CanvasSink(track, { width: THUMB_W, height: THUMB_H, fit: 'cover', poolSize: 1 });
      const frame = await sink.getCanvas(Math.max(0, time));
      return frame ? createImageBitmap(frame.canvas) : null;
    })().catch(() => null);
    this.thumbs.set(key, job);
    while (this.thumbs.size > THUMB_LIMIT) {
      const oldest = this.thumbs.keys().next().value as string;
      void this.thumbs.get(oldest)?.then(bitmap => bitmap?.close());
      this.thumbs.delete(oldest);
    }
    return job;
  }

  async mixAudio(project: CutProject, from: number, to: number, sampleRate: number): Promise<AudioBuffer> {
    const length = Math.max(1, Math.round((to - from) * sampleRate));
    const ctx = new OfflineAudioContext(2, length, sampleRate);
    for (const segment of audioSegments(project, from, to)) {
      const sourceId = segment.clip.sourceId;
      if (!sourceId) continue;
      const track = await this.audioTrack(sourceId);
      if (!track) continue;
      const gain = ctx.createGain();
      gain.gain.value = segment.clip.volume;
      gain.connect(ctx.destination);
      const sink = new AudioBufferSink(track);
      for await (const wrapped of sink.buffers(segment.sourceStart, segment.sourceEnd)) {
        const node = ctx.createBufferSource();
        node.buffer = wrapped.buffer;
        node.connect(gain);
        // 变速 = 改播放速率（不保音高）；时间线上的偏移按速度换算。
        if (segment.speed !== 1) node.playbackRate.value = segment.speed;
        const skip = Math.max(0, segment.sourceStart - wrapped.timestamp);
        const when = segment.offset + Math.max(0, wrapped.timestamp - segment.sourceStart) / segment.speed;
        const play = Math.min(wrapped.duration - skip, segment.sourceEnd - (wrapped.timestamp + skip));
        if (play > 0) node.start(when, skip, play);
      }
    }
    return ctx.startRendering();
  }

  /**
   * 素材的音频波形（峰值）。整段解码一次、边解码边取峰值，不保留 PCM；结果按素材缓存，换素材或释放引擎时丢弃。
   * 没有音轨或解码失败返回 null。
   */
  waveform(sourceId: string): Promise<CutWaveform | null> {
    const cached = this.waveforms.get(sourceId);
    if (cached) return cached;
    const job: Promise<CutWaveform | null> = (async () => {
      const track = await this.audioTrack(sourceId);
      if (!track || this.disposed) return null;
      const duration = await track.computeDuration().catch(() => 0);
      const accumulator = new CutPeakAccumulator(CUT_PEAKS_PER_SECOND, duration);
      const sink = new AudioBufferSink(track);
      for await (const wrapped of sink.buffers()) {
        if (this.disposed || this.waveforms.get(sourceId) !== job) return null;
        const { buffer } = wrapped;
        const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index));
        accumulator.push(wrapped.timestamp, buffer.sampleRate, channels);
      }
      return accumulator.result();
    })().catch(() => null);
    this.waveforms.set(sourceId, job);
    return job;
  }

  private proxyKey(sourceId: string) { return `${sourceId}#proxy`; }

  proxyInfo(sourceId: string): { status: 'none' | 'generating' | 'ready'; height?: number; progress?: number } {
    const job = this.proxyJobs.get(sourceId);
    if (job) return { status: 'generating', height: job.height, progress: job.progress };
    const proxy = this.proxies.get(sourceId);
    return proxy ? { status: 'ready', height: proxy.height } : { status: 'none' };
  }

  private attachProxy(sourceId: string, height: number, blob: Blob) {
    const key = this.proxyKey(sourceId);
    this.dropSource(key);
    this.blobs.set(key, blob);
    this.proxies.set(sourceId, { height, blob });
  }

  /** 素材记录里登记过代理时，从 OPFS / IndexedDB 取回（磁盘支持的 File，不占 JS 堆）。 */
  async restoreProxy(source: CutSource) {
    if (source.kind !== 'video' || !source.proxy?.height || this.proxies.has(source.id)) return false;
    const blob = await readProxyFile(source.id, source.proxy.height);
    if (!blob || this.disposed) return false;
    this.attachProxy(source.id, source.proxy.height, blob);
    this.onProxyChange?.();
    return true;
  }

  /** 后台转一份低分辨率代理（只有画面，预览用；声音仍读原片）。 */
  async createProxy(sourceId: string, height: number, onProgress?: (progress: number) => void): Promise<boolean> {
    const input = this.input(sourceId);
    if (!input) throw new Error('media not loaded');
    this.proxyJobs.get(sourceId)?.abort.abort();
    const job: CutProxyJob = { height, progress: 0, abort: new AbortController() };
    this.proxyJobs.set(sourceId, job);
    this.onProxyChange?.();
    try {
      const track = await this.videoTrack(sourceId);
      if (!track) throw new Error('no video track');
      const codec: VideoCodec = await canEncodeVideo('avc', { width: Math.round(height * 16 / 9), height }) ? 'avc' : 'vp9';
      const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
      const conversion = await Conversion.init({
        input,
        output,
        video: { height: Math.min(height, track.displayHeight || height), fit: 'contain', codec, bitrate: QUALITY_LOW, keyFrameInterval: 1, forceTranscode: true },
        audio: { discard: true },
      });
      if (!conversion.isValid) throw new Error('This video cannot be converted to a proxy.');
      conversion.onProgress = progress => { job.progress = progress; onProgress?.(progress); this.onProxyChange?.(); };
      const abort = () => { void conversion.cancel(); };
      job.abort.signal.addEventListener('abort', abort, { once: true });
      await conversion.execute();
      const buffer = output.target.buffer;
      if (!buffer || job.abort.signal.aborted || this.disposed) return false;
      const stored = await writeProxyFile(sourceId, height, new Blob([buffer], { type: 'video/mp4' }));
      this.attachProxy(sourceId, height, stored);
      return true;
    } finally {
      if (this.proxyJobs.get(sourceId) === job) this.proxyJobs.delete(sourceId);
      this.onProxyChange?.();
    }
  }

  cancelProxy(sourceId: string) { this.proxyJobs.get(sourceId)?.abort.abort(); }

  async deleteProxy(sourceId: string, height?: number) {
    this.cancelProxy(sourceId);
    const proxy = this.proxies.get(sourceId);
    this.proxies.delete(sourceId);
    this.dropSource(this.proxyKey(sourceId));
    this.blobs.delete(this.proxyKey(sourceId));
    await deleteProxyFile(sourceId, height ?? proxy?.height).catch(() => undefined);
    this.onProxyChange?.();
  }

  get openStreams() { return this.streams.size; }

  private dropSource(sourceId: string) {
    this.inputs.get(sourceId)?.dispose();
    this.inputs.delete(sourceId);
    this.videoTracks.delete(sourceId);
    this.audioTracks.delete(sourceId);
    this.waveforms.delete(sourceId);
    void this.images.get(sourceId)?.then(bitmap => bitmap?.close());
    this.images.delete(sourceId);
    for (const key of [...this.thumbs.keys()]) {
      if (key.startsWith(`${sourceId}@`)) { void this.thumbs.get(key)?.then(bitmap => bitmap?.close()); this.thumbs.delete(key); }
    }
  }

  /** 关闭所有解码器、Input、位图；释放 Blob 引用。 */
  dispose() {
    this.disposed = true;
    for (const job of this.proxyJobs.values()) job.abort.abort();
    this.proxyJobs.clear();
    this.proxies.clear();
    for (const stream of this.streams) stream.close();
    this.streams.clear();
    for (const id of [...this.blobs.keys()]) this.dropSource(id);
    this.blobs.clear();
  }
}

// ── 编码 ───────────────────────────────────────────────────────────────

export interface CutEncoderInfo {
  videoCodec: VideoCodec;
  audioCodec: 'aac' | null;
  audioPolyfill: boolean;
  /** 成片写在哪：opfs = 流式写进磁盘临时文件；memory = 退回内存缓冲（浏览器不支持 OPFS 可写流）。start() 之后才确定。 */
  storage?: 'opfs' | 'memory';
}

export class MediabunnyMp4Encoder implements CutEncoder {
  readonly sampleRate = 48000;
  private output: Output<Mp4OutputFormat> | null = null;
  private sink: CutExportTarget | null = null;
  private videoSource: CanvasSource | null = null;
  private audioSource: AudioBufferSource | null = null;

  private constructor(readonly canvas: OffscreenCanvas, readonly hasAudio: boolean, readonly info: CutEncoderInfo, private fps: number) {}

  static async create(project: Pick<CutProject, 'width' | 'height' | 'fps'>, withAudio: boolean): Promise<MediabunnyMp4Encoder> {
    // H.264 要求偶数尺寸。
    const width = project.width - (project.width % 2);
    const height = project.height - (project.height % 2);
    let videoCodec: VideoCodec | null = null;
    for (const codec of ['avc', 'vp9'] as const) {
      if (await canEncodeVideo(codec, { width, height, bitrate: QUALITY_HIGH })) { videoCodec = codec; break; }
    }
    if (!videoCodec) throw new Error('This browser cannot encode H.264 video with WebCodecs.');
    let audioPolyfill = false;
    if (withAudio && !(await canEncodeAudio('aac', { numberOfChannels: 2, sampleRate: 48000 }))) {
      // 没有原生 AAC 编码器（如 Linux 上的 Chromium）时按需加载 WASM AAC 编码器（独立 chunk）。
      const { registerAacEncoder } = await import('@mediabunny/aac-encoder');
      registerAacEncoder();
      audioPolyfill = true;
    }
    const encoder = new MediabunnyMp4Encoder(new OffscreenCanvas(width, height), withAudio, { videoCodec, audioCodec: withAudio ? 'aac' : null, audioPolyfill }, project.fps);
    return encoder;
  }

  async start() {
    // fastStart: false 让 moov 写在文件尾，muxer 不必把整段媒体留在内存里，才能流式落盘。
    this.sink = await createCutExportTarget();
    this.info.storage = this.sink.kind;
    this.output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target: this.sink.target });
    this.videoSource = new CanvasSource(this.canvas, { codec: this.info.videoCodec, bitrate: QUALITY_HIGH, keyFrameInterval: 2 });
    this.output.addVideoTrack(this.videoSource, { frameRate: this.fps });
    if (this.hasAudio) {
      this.audioSource = new AudioBufferSource({ codec: 'aac', bitrate: 128_000 });
      this.output.addAudioTrack(this.audioSource);
    }
    await this.output.start();
  }

  async addVideoFrame(timestamp: number, duration: number) {
    await this.videoSource!.add(timestamp, duration);
  }

  async addAudio(buffer: AudioBuffer) {
    await this.audioSource?.add(buffer);
  }

  async finalize(): Promise<Blob> {
    const output = this.output!;
    await output.finalize();
    this.output = null;
    return this.sink!.finish();
  }

  async cancel() {
    try {
      if (this.output && this.output.state !== 'finalized' && this.output.state !== 'canceled') await this.output.cancel();
    } finally {
      this.output = null;
      await this.sink?.discard();
    }
  }
}
