import { Button, ConfigProvider, Input, InputNumber, Modal, Select, Slider, theme as antdTheme } from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useResolvedTheme } from '../../hooks/useResolvedTheme';
import type { WorkflowNode } from './types';
import { CAMERA_MOVEMENTS } from './constants';
import { probeVideoMetadata } from '../../services/videoTools';
import { isFFmpegSupported } from '../../services/ffmpegClient';
import { analyzeVideoSceneCuts, buildEvenSplitSegments, detectSceneSegmentsFromDeltas, type SampledFrameDelta, type SceneSplitSegment } from '../../services/videoSceneSplit';

export type WorkflowVideoToolKind = 'trim' | 'av-split' | 'merge' | 'extract-frame' | 'smart-split' | 'extend' | 'retake';
/** nodeIds：merge 工具持久保存的选中节点 id 列表，确认时原样回传。 */
export interface WorkflowVideoToolState { kind: WorkflowVideoToolKind; nodeId: string; nodeIds?: string[] }
export type WorkflowVideoToolConfirmation =
  | { kind: 'trim'; startSec: number; endSec: number }
  | { kind: 'av-split' }
  | { kind: 'merge'; nodeIds: string[] }
  | { kind: 'extract-frame'; position: 'first' | 'current' | 'last'; currentTimeSec?: number }
  | { kind: 'smart-split'; segments: Array<{ startSec: number; endSec: number }> }
  | { kind: 'extend'; direction: 'forward' | 'backward'; durationSec: number; prompt: string; cameraMovement?: string }
  | { kind: 'retake'; referenceFrame: 'first' | 'current' | 'last'; currentTimeSec?: number; prompt: string; cameraMovement?: string; draftMode?: boolean };

function WorkflowVideoToolDialogsBody({ tool, node, mediaUrl, busy, error, onClose, onConfirm }: {
  tool: WorkflowVideoToolState | null;
  node: WorkflowNode | null;
  mediaUrl: string;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: (payload: WorkflowVideoToolConfirmation) => void;
}) {
  if (!tool || !node || !mediaUrl) return null;
  const common = { open: true, mediaUrl, busy, error, onClose };
  if (tool.kind === 'trim') return <TrimDialog {...common} onConfirm={(startSec, endSec) => onConfirm({ kind: 'trim', startSec, endSec })} />;
  if (tool.kind === 'av-split') return <SimpleVideoDialog {...common} title="音视频分离" description="将视频的音频轨和视频轨分离，分别创建独立的音频节点和静音视频节点。" action="分离音视频" onConfirm={() => onConfirm({ kind: 'av-split' })} />;
  if (tool.kind === 'merge') return <SimpleVideoDialog {...common} title="视频拼接" description="将选中的多个视频片段按顺序拼接为一个视频。仅支持相同分辨率和帧率的片段。" action="拼接视频" onConfirm={() => onConfirm({ kind: 'merge', nodeIds: tool.nodeIds || [] })} />;
  if (tool.kind === 'extract-frame') return <ExtractFrameDialog {...common} onConfirm={(currentTimeSec) => onConfirm({ kind: 'extract-frame', position: 'current', currentTimeSec })} />;
  if (tool.kind === 'smart-split') return <SmartSplitDialog {...common} onConfirm={segments => onConfirm({ kind: 'smart-split', segments })} />;
  if (tool.kind === 'extend') return <ExtendVideoDialog {...common} basePrompt={node.metadata.prompt || ''} onConfirm={payload => onConfirm({ kind: 'extend', ...payload })} />;
  if (tool.kind === 'retake') return <RetakeVideoDialog {...common} basePrompt={node.metadata.prompt || ''} onConfirm={payload => onConfirm({ kind: 'retake', ...payload })} />;
  return null;
}

export function WorkflowVideoToolDialogs(props: {
  tool: WorkflowVideoToolState | null;
  node: WorkflowNode | null;
  mediaUrl: string;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: (payload: WorkflowVideoToolConfirmation) => void;
}) {
  const dark = useResolvedTheme() === 'dark';
  return (
    <ConfigProvider theme={{
      algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
      token: { colorPrimary: '#19c8b9', fontFamily: 'inherit' },
    }}>
      <WorkflowVideoToolDialogsBody {...props} />
    </ConfigProvider>
  );
}

type CommonProps = { open: boolean; mediaUrl: string; busy: boolean; error: string | null; onClose: () => void };
const modalProps = (props: CommonProps, width = 620) => ({ open: props.open, onCancel: props.busy ? undefined : props.onClose, footer: null, centered: true, width, destroyOnHidden: true, maskClosable: !props.busy });

function DialogError({ error }: { error: string | null }) {
  return error ? <div role="alert" className="workflow-image-tool__error">{error}</div> : null;
}

function timecode(frame: number, fps: number): string {
  const safeFps = Math.max(1, Math.round(fps));
  const totalSeconds = Math.max(0, Math.floor(frame / safeFps));
  const frames = Math.max(0, Math.round(frame)) % safeFps;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map(value => String(value).padStart(2, '0')).join(':') + ':' + String(frames).padStart(2, '0');
}

/** 以帧为主轴：拖动进度条时主动 seek 视频元素，画面必须跟着走，而不是只改数字。 */
function useVideoTimeline(mediaUrl: string) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [duration, setDuration] = useState(0);
  const [fps, setFpsState] = useState(30);
  const [fpsEstimated, setFpsEstimated] = useState(true);
  const [frame, setFrame] = useState(0);
  const [ready, setReady] = useState(false);
  const [metaFailed, setMetaFailed] = useState(false);
  const [playing, setPlaying] = useState(false);
  const totalFrames = Math.max(0, Math.round(duration * fps));
  const seek = useCallback((nextFrame: number) => {
    const clamped = Math.max(0, Math.min(totalFrames, Math.round(nextFrame)));
    const video = videoRef.current;
    if (video) {
      video.pause();
      const nextTime = clamped / Math.max(fps, .001);
      if (Math.abs(video.currentTime - nextTime) > 0.001) video.currentTime = nextTime;
    }
    setFrame(clamped);
  }, [fps, totalFrames]);
  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play().catch(() => undefined);
    else video.pause();
  }, []);
  const setFps = useCallback((nextFps: number) => {
    const safe = Math.max(1, Math.min(120, Number.isFinite(nextFps) ? nextFps : 30));
    const currentSeconds = frame / Math.max(fps, .001);
    setFpsState(safe);
    const nextFrame = Math.round(currentSeconds * safe);
    setFrame(nextFrame);
    const video = videoRef.current;
    if (video) video.currentTime = nextFrame / safe;
  }, [fps, frame]);
  useEffect(() => {
    let cancelled = false;
    setReady(false);
    setMetaFailed(false);
    setDuration(0);
    setFrame(0);
    void probeVideoMetadata(mediaUrl).then(meta => {
      if (cancelled) return;
      setDuration(meta.duration);
      setFpsState(meta.fps);
      setFpsEstimated(meta.fpsEstimated);
      setReady(meta.duration > 0);
      setMetaFailed(meta.duration <= 0);
    }).catch(() => {
      if (!cancelled) { setMetaFailed(true); setReady(false); }
    });
    return () => { cancelled = true; };
  }, [mediaUrl]);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const sync = () => { if (!video.paused) setFrame(Math.min(totalFrames, Math.round(video.currentTime * fps))); };
    const onPlay = () => setPlaying(true);
    const onPause = () => {
      setPlaying(false);
      setFrame(Math.min(totalFrames, Math.round(video.currentTime * fps)));
    };
    video.addEventListener('timeupdate', sync);
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    return () => {
      video.removeEventListener('timeupdate', sync);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
    };
  }, [fps, totalFrames]);
  return { videoRef, duration, fps, fpsEstimated, frame, totalFrames, ready, metaFailed, playing, seek, togglePlay, setFps };
}

function FFmpegStatus() {
  if (!isFFmpegSupported()) return <p className="workflow-image-tool__error">当前浏览器不支持 WebAssembly，无法使用视频工具。</p>;
  return null;
}

function TrimDialog(props: CommonProps & { onConfirm: (startSec: number, endSec: number) => void }) {
  const timeline = useVideoTimeline(props.mediaUrl);
  const { videoRef, duration, fps, fpsEstimated, frame, totalFrames, ready, metaFailed, playing, seek, togglePlay, setFps } = timeline;
  const [startFrame, setStartFrame] = useState(0);
  const [endFrame, setEndFrame] = useState(0);
  const [fallbackStart, setFallbackStart] = useState(0);
  const [fallbackEnd, setFallbackEnd] = useState(0);
  const initializedFor = useRef('');
  useEffect(() => {
    if (!ready || !totalFrames || initializedFor.current === props.mediaUrl) return;
    initializedFor.current = props.mediaUrl;
    setStartFrame(0);
    setEndFrame(totalFrames);
    seek(0);
  }, [ready, totalFrames, props.mediaUrl, seek]);
  const changeFps = (next: number | null) => {
    if (next === null) return;
    const previous = fps;
    const ratio = next / Math.max(previous, .001);
    setStartFrame(Math.max(0, Math.round(startFrame * ratio)));
    setEndFrame(Math.max(1, Math.round(endFrame * ratio)));
    setFps(next);
  };
  const fallback = metaFailed;
  return <Modal {...modalProps(props, 860)} title="视频剪辑">
    <div className="workflow-video-tool" data-workflow-overlay>
      <div className="workflow-video-preview" onClick={togglePlay}>
        <video ref={videoRef} src={props.mediaUrl} preload="auto" playsInline onClick={event => { event.stopPropagation(); togglePlay(); }} />
        <button type="button" className="workflow-video-play" onClick={event => { event.stopPropagation(); togglePlay(); }}>{playing ? '暂停' : '播放'}</button>
        <span className="workflow-video-timecode">{timecode(frame, fps)} / {timecode(totalFrames, fps)}</span>
      </div>
      <FFmpegStatus />
      {fallback ? <>
        <p className="workflow-image-tool__hint">无法读取视频时长，请手动输入开始和结束秒数。</p>
        <div className="workflow-video-fields">
          <label>开始时间（秒）<InputNumber min={0} step={0.1} value={fallbackStart} onChange={value => setFallbackStart(typeof value === 'number' ? value : 0)} /></label>
          <label>结束时间（秒）<InputNumber min={0} step={0.1} value={fallbackEnd} onChange={value => setFallbackEnd(typeof value === 'number' ? value : 0)} /></label>
        </div>
      </> : <>
        <div className="workflow-video-timeline">
          <div className="workflow-video-timeline__header"><span>入点 / 出点</span><span>{duration.toFixed(2)}s · {fpsEstimated ? '估算' : ''} {fps.toFixed(2)} fps</span></div>
          <Slider
            range
            min={0}
            max={Math.max(1, totalFrames)}
            value={[Math.min(startFrame, endFrame), Math.max(startFrame, endFrame)]}
            disabled={!ready}
            tooltip={{ formatter: value => timecode(Number(value), fps) }}
            onChange={value => {
              const [start, end] = Array.isArray(value) ? value : [value, value];
              setStartFrame(Math.min(start, Math.max(0, end - 1)));
              setEndFrame(Math.max(end, start + 1));
            }}
          />
          <Slider
            min={0}
            max={Math.max(1, totalFrames)}
            value={frame}
            disabled={!ready}
            tooltip={{ formatter: value => timecode(Number(value), fps) }}
            onChange={value => seek(Number(value))}
          />
          <div className="workflow-video-controls">
            <Button size="small" onClick={() => seek(frame - 1)} disabled={!ready}>−1 帧</Button>
            <Button size="small" onClick={() => seek(frame - Math.round(fps))} disabled={!ready}>−1 秒</Button>
            <Button size="small" onClick={togglePlay} disabled={!ready}>{playing ? '暂停' : '播放'}</Button>
            <Button size="small" onClick={() => seek(frame + Math.round(fps))} disabled={!ready}>+1 秒</Button>
            <Button size="small" onClick={() => seek(frame + 1)} disabled={!ready}>+1 帧</Button>
            <Button size="small" onClick={() => setStartFrame(Math.max(0, Math.min(frame, endFrame - 1)))} disabled={!ready}>设为入点</Button>
            <Button size="small" onClick={() => setEndFrame(Math.max(frame, startFrame + 1))} disabled={!ready}>设为出点</Button>
          </div>
        </div>
        <div className="workflow-video-fields">
          <label>入点帧<input type="number" min={0} max={Math.max(0, totalFrames - 1)} value={startFrame} disabled={!ready} onChange={event => setStartFrame(Math.max(0, Math.min(Number(event.target.value) || 0, endFrame - 1)))} /></label>
          <label>出点帧<input type="number" min={1} max={totalFrames} value={endFrame} disabled={!ready} onChange={event => setEndFrame(Math.max(startFrame + 1, Math.min(Number(event.target.value) || 0, totalFrames)))} /></label>
          <label>帧率<input type="number" min={1} max={120} step={0.01} value={Number(fps.toFixed(2))} disabled={!ready} onChange={event => changeFps(Number(event.target.value))} /></label>
        </div>
      </>}
      <p className="workflow-image-tool__hint">按帧重编码导出，切点落在目标帧；比无损 stream copy 慢，但不会出现关键帧错位。</p>
      <DialogError error={props.error} />
      <div className="workflow-video-actions">
        <Button type="primary" loading={props.busy} disabled={fallback ? fallbackStart >= fallbackEnd || !isFFmpegSupported() : startFrame >= endFrame || !ready || !isFFmpegSupported()} onClick={() => props.onConfirm(fallback ? fallbackStart : startFrame / fps, fallback ? fallbackEnd : endFrame / fps)}>裁取片段</Button>
      </div>
    </div>
  </Modal>;
}

function SimpleVideoDialog(props: CommonProps & { title: string; description: string; action: string; onConfirm: () => void }) {
  return <Modal {...modalProps(props)} title={props.title}>
    <div className="workflow-video-tool" data-workflow-overlay>
      <div className="workflow-video-preview"><video src={props.mediaUrl} controls playsInline /></div>
      <FFmpegStatus />
      <p className="workflow-image-tool__hint">{props.description}</p>
      <DialogError error={props.error} />
      <div className="workflow-video-actions">
        <Button type="primary" loading={props.busy} disabled={!isFFmpegSupported()} onClick={props.onConfirm}>{props.action}</Button>
      </div>
    </div>
  </Modal>;
}

function ExtractFrameDialog(props: CommonProps & { onConfirm: (currentTimeSec: number) => void }) {
  const timeline = useVideoTimeline(props.mediaUrl);
  const { videoRef, fps, fpsEstimated, frame, totalFrames, ready, metaFailed, playing, seek, togglePlay, setFps } = timeline;
  const [fallbackSec, setFallbackSec] = useState(0);
  const initializedFor = useRef('');
  useEffect(() => {
    if (!ready || !totalFrames || initializedFor.current === props.mediaUrl) return;
    initializedFor.current = props.mediaUrl;
    seek(Math.floor(totalFrames / 2));
  }, [ready, totalFrames, props.mediaUrl, seek]);
  return <Modal {...modalProps(props, 860)} title="提取指定帧">
    <div className="workflow-video-tool" data-workflow-overlay>
      <div className="workflow-video-preview" onClick={togglePlay}>
        <video ref={videoRef} src={props.mediaUrl} preload="auto" playsInline onClick={event => { event.stopPropagation(); togglePlay(); }} />
        <button type="button" className="workflow-video-play" onClick={event => { event.stopPropagation(); togglePlay(); }}>{playing ? '暂停' : '播放'}</button>
        <span className="workflow-video-timecode">第 {frame} 帧 · {timecode(frame, fps)}</span>
      </div>
      <FFmpegStatus />
      {metaFailed ? <div className="workflow-video-fields">
        <label>无法读取时长，手动输入时间点（秒）<InputNumber min={0} step={0.1} value={fallbackSec} onChange={value => setFallbackSec(typeof value === 'number' ? value : 0)} /></label>
      </div> : <>
        <div className="workflow-video-timeline">
          <div className="workflow-video-timeline__header"><span>拖动到目标帧，画面会同步跳转</span><span>{fpsEstimated ? '估算' : ''} {fps.toFixed(2)} fps</span></div>
          <Slider
            min={0}
            max={Math.max(1, totalFrames)}
            value={frame}
            disabled={!ready}
            tooltip={{ formatter: value => timecode(Number(value), fps) }}
            onChange={value => seek(Number(value))}
          />
          <div className="workflow-video-controls">
            <Button size="small" onClick={() => seek(frame - 1)} disabled={!ready}>−1 帧</Button>
            <Button size="small" onClick={() => seek(frame - Math.round(fps))} disabled={!ready}>−1 秒</Button>
            <Button size="small" onClick={togglePlay} disabled={!ready}>{playing ? '暂停' : '播放'}</Button>
            <Button size="small" onClick={() => seek(frame + Math.round(fps))} disabled={!ready}>+1 秒</Button>
            <Button size="small" onClick={() => seek(frame + 1)} disabled={!ready}>+1 帧</Button>
          </div>
        </div>
        <div className="workflow-video-fields">
          <label>目标帧<input type="number" min={0} max={Math.max(0, totalFrames)} value={frame} disabled={!ready} onChange={event => seek(Number(event.target.value) || 0)} /></label>
          <label>帧率<input type="number" min={1} max={120} step={0.01} value={Number(fps.toFixed(2))} disabled={!ready} onChange={event => { const next = Number(event.target.value); if (Number.isFinite(next)) setFps(next); }} /></label>
          <label>时间码<span className="workflow-video-timecode">{timecode(frame, fps)}</span></label>
        </div>
      </>}
      <DialogError error={props.error} />
      <div className="workflow-video-actions">
        <Button type="primary" loading={props.busy} disabled={!isFFmpegSupported() || (metaFailed ? fallbackSec < 0 : !ready)} onClick={() => props.onConfirm(metaFailed ? fallbackSec : frame / fps)}>提取此帧</Button>
      </div>
    </div>
  </Modal>;
}

function SmartSplitDialog(props: CommonProps & { onConfirm: (segments: Array<{ startSec: number; endSec: number }>) => void }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [analyzing, setAnalyzing] = useState(true);
  const [progress, setProgress] = useState(0);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const [durationSec, setDurationSec] = useState(0);
  const [deltas, setDeltas] = useState<SampledFrameDelta[]>([]);
  const [threshold, setThreshold] = useState(0.28);
  const [evenCount, setEvenCount] = useState(3);
  const [segments, setSegments] = useState<SceneSplitSegment[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    setAnalyzing(true);
    setAnalyzeError(null);
    setProgress(0);
    void analyzeVideoSceneCuts(props.mediaUrl, {
      threshold: 0.28,
      signal: controller.signal,
      onProgress: ratio => setProgress(Math.round(ratio * 100)),
    }).then(result => {
      if (controller.signal.aborted) return;
      setDurationSec(result.durationSec);
      setDeltas(result.deltas);
      setSegments(result.segments.length >= 2 ? result.segments : buildEvenSplitSegments(result.durationSec, 3));
      setAnalyzing(false);
    }).catch(err => {
      if (controller.signal.aborted) return;
      setAnalyzeError(err instanceof Error ? err.message : '智能拆条分析失败');
      setAnalyzing(false);
    });
    return () => controller.abort();
  }, [props.mediaUrl]);

  const recalcThreshold = (nextThreshold: number) => {
    setThreshold(nextThreshold);
    const detected = detectSceneSegmentsFromDeltas(deltas, durationSec, { threshold: nextThreshold });
    setSegments(detected);
  };

  const applyEvenSplit = () => {
    setSegments(buildEvenSplitSegments(durationSec, evenCount));
  };

  const jumpTo = (sec: number) => {
    if (videoRef.current) {
      videoRef.current.currentTime = sec;
      videoRef.current.pause();
    }
  };

  return <Modal {...modalProps(props, 760)} title="智能拆条（本地镜头切点识别）">
    <div className="workflow-video-tool" data-workflow-overlay>
      <div className="workflow-video-preview">
        <video ref={videoRef} src={props.mediaUrl} controls playsInline />
      </div>
      <FFmpegStatus />
      {analyzing ? (
        <p className="workflow-image-tool__hint">正在本地采样分析转场切点（不上传云端、不消耗额度）… {progress}%</p>
      ) : (
        <>
          <div className="workflow-video-fields">
            <label style={{ flex: 1 }}>
              切点灵敏度（阈值 {threshold.toFixed(2)}，越低越敏感）
              <Slider min={0.1} max={0.6} step={0.02} value={threshold} onChange={value => recalcThreshold(Number(value))} />
            </label>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6 }}>
              <label>等分片段数<InputNumber min={2} max={10} value={evenCount} onChange={value => setEvenCount(typeof value === 'number' ? value : 3)} /></label>
              <Button size="small" onClick={applyEvenSplit}>按等分切分</Button>
            </div>
          </div>
          <div className="wf-smart-split-list" role="list" aria-label="识别到的镜头片段">
            {segments.length ? segments.map(seg => (
              <div key={seg.index} className="wf-smart-split-item" role="listitem" onClick={() => jumpTo(seg.startSec)}>
                <span><strong>镜头 {seg.index}</strong> · {seg.startSec.toFixed(2)}s → {seg.endSec.toFixed(2)}s</span>
                <span>时长 {seg.durationSec.toFixed(2)}s</span>
              </div>
            )) : <p className="workflow-image-tool__hint">当前阈值未检测到明显切点，可调低灵敏度阈值或点击「按等分切分」。</p>}
          </div>
        </>
      )}
      <DialogError error={analyzeError || props.error} />
      <div className="workflow-video-actions">
        <Button type="primary" loading={props.busy} disabled={analyzing || segments.length < 2 || !isFFmpegSupported()} onClick={() => props.onConfirm(segments.map(s => ({ startSec: s.startSec, endSec: s.endSec })))}>
          拆分为 {segments.length} 个独立视频节点
        </Button>
      </div>
    </div>
  </Modal>;
}

function ExtendVideoDialog(props: CommonProps & { basePrompt: string; onConfirm: (payload: { direction: 'forward' | 'backward'; durationSec: number; prompt: string; cameraMovement?: string }) => void }) {
  const [direction, setDirection] = useState<'forward' | 'backward'>('forward');
  const [durationSec, setDurationSec] = useState(5);
  const [cameraMovement, setCameraMovement] = useState<string>('');
  const [prompt, setPrompt] = useState(() => props.basePrompt ? `${props.basePrompt}，平滑承接后续动作` : '自然承接上一镜头画面，延续动作与光影');

  return <Modal {...modalProps(props, 660)} title="延长镜头（派生衔接节点）">
    <div className="workflow-video-tool" data-workflow-overlay>
      <div className="workflow-video-preview"><video src={props.mediaUrl} controls playsInline /></div>
      <p className="workflow-image-tool__hint">非破坏性操作：自动截取原视频的尾帧（向后延长）或首帧（向前续写序幕），在画布上创建连好线的下游视频生成节点；不会自动扣费，确认后由你手动运行。</p>
      <div className="workflow-video-fields">
        <label>延长方向
          <Select value={direction} style={{ width: 160 }} onChange={value => setDirection(value)} options={[
            { value: 'forward', label: '向后延长（从尾帧续写）' },
            { value: 'backward', label: '向前延长（从首帧补序幕）' },
          ]} />
        </label>
        <label>目标时长（秒）<InputNumber min={3} max={15} value={durationSec} onChange={v => setDurationSec(typeof v === 'number' ? v : 5)} /></label>
        <label>运镜延续
          <Select allowClear placeholder="跟随原镜头" value={cameraMovement || undefined} style={{ width: 170 }} onChange={value => setCameraMovement(value || '')} options={CAMERA_MOVEMENTS.map(m => ({ value: m.promptKeyword, label: `${m.name} (${m.promptKeyword})` }))} />
        </label>
      </div>
      <Input.TextArea rows={3} value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="描述接下来的镜头变化与动作…" />
      <DialogError error={props.error} />
      <div className="workflow-video-actions">
        <Button type="primary" loading={props.busy} onClick={() => props.onConfirm({ direction, durationSec, prompt: prompt.trim(), cameraMovement: cameraMovement || undefined })}>
          创建延长镜头节点
        </Button>
      </div>
    </div>
  </Modal>;
}

function RetakeVideoDialog(props: CommonProps & { basePrompt: string; onConfirm: (payload: { referenceFrame: 'first' | 'current' | 'last'; currentTimeSec?: number; prompt: string; cameraMovement?: string; draftMode?: boolean }) => void }) {
  const timeline = useVideoTimeline(props.mediaUrl);
  const { videoRef, fps, frame, totalFrames, ready, seek, playing, togglePlay } = timeline;
  const [referenceFrame, setReferenceFrame] = useState<'first' | 'current' | 'last'>('first');
  const [cameraMovement, setCameraMovement] = useState<string>('');
  const [draftMode, setDraftMode] = useState(true);
  const [prompt, setPrompt] = useState(() => props.basePrompt || '保持主体与场景一致，重新演绎镜头构图与运镜');

  return <Modal {...modalProps(props, 760)} title="视频重拍（Retake · 非破坏性重演）">
    <div className="workflow-video-tool" data-workflow-overlay>
      <div className="workflow-video-preview" onClick={togglePlay}>
        <video ref={videoRef} src={props.mediaUrl} preload="auto" playsInline onClick={e => { e.stopPropagation(); togglePlay(); }} />
        <button type="button" className="workflow-video-play" onClick={e => { e.stopPropagation(); togglePlay(); }}>{playing ? '暂停' : '播放'}</button>
        <span className="workflow-video-timecode">第 {frame} 帧 · {timecode(frame, fps)}</span>
      </div>
      {ready && referenceFrame === 'current' && (
        <div className="workflow-video-timeline">
          <Slider min={0} max={Math.max(1, totalFrames)} value={frame} onChange={value => seek(Number(value))} />
        </div>
      )}
      <div className="workflow-video-fields">
        <label>重拍参考帧
          <Select value={referenceFrame} style={{ width: 160 }} onChange={v => setReferenceFrame(v)} options={[
            { value: 'first', label: '首帧（重拍整段）' },
            { value: 'current', label: '当前定位帧' },
            { value: 'last', label: '尾帧（反转重演）' },
          ]} />
        </label>
        <label>新运镜方向
          <Select allowClear placeholder="选择新运镜" value={cameraMovement || undefined} style={{ width: 180 }} onChange={v => setCameraMovement(v || '')} options={CAMERA_MOVEMENTS.map(m => ({ value: m.promptKeyword, label: `${m.name} (${m.promptKeyword})` }))} />
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 18 }}>
          <input type="checkbox" checked={draftMode} onChange={e => setDraftMode(e.target.checked)} />
          <span>先用 480p 草稿模式预演</span>
        </label>
      </div>
      <Input.TextArea rows={3} value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="描述重拍后的动作、视角或表演调整…" />
      <p className="workflow-image-tool__hint">将在原节点旁生成新的「重拍」视频节点并自动绑定参考帧，保留原视频完整历史，不自动计费。</p>
      <DialogError error={props.error} />
      <div className="workflow-video-actions">
        <Button type="primary" loading={props.busy} onClick={() => props.onConfirm({ referenceFrame, currentTimeSec: referenceFrame === 'current' ? frame / Math.max(fps, 1) : undefined, prompt: prompt.trim(), cameraMovement: cameraMovement || undefined, draftMode })}>
          创建重拍节点
        </Button>
      </div>
    </div>
  </Modal>;
}
