// 时间线：标尺 + 播放头 + 多轨道（视频 / 音频 / 文字 / 字幕）。拖动主体 = 移动（可跨轨道），拖两侧 = 修剪，
// 点标尺 = 定位；吸附（N 键开关）对齐播放头与其他片段边缘——吸附解析改编自 OpenCut classic timeline/snapping（MIT）。
// 字幕 / 文字片段双击即可在时间线上直接改字。
import { Captions, Film, Image as ImageIcon, Music, Trash2, Type, Volume2, VolumeX } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { cutStore, getCutProject } from '../../services/cut/cutStore';
import type { CutMediaEngine } from '../../services/cut/mediaEngine';
import { resolveSnap, type SnapPoint } from '../../services/cut/snapping';
import { drawWaveform, sliceWaveform, type CutWaveform } from '../../services/cut/waveform';
import { clipEnd, clipSpeed, findSource, projectDuration, updateClip, type CutClip, type CutProject, type CutTrack } from '../../services/cut/timeline';

type Lang = 'zho' | 'en';

export interface CutTimelineProps {
  language: Lang;
  project: CutProject;
  engine: CutMediaEngine | null;
  time: number;
  selection: string[];
  snapping: boolean;
  pxPerSecond: number;
  offline: ReadonlySet<string>;
  mediaRevision: number;
  onSelect: (clipIds: string[]) => void;
  onSeek: (t: number) => void;
  onMove: (clipId: string, trackId: string, start: number) => void;
  onTrim: (clipId: string, edge: 'start' | 'end', time: number) => void;
  onToggleMute: (trackId: string) => void;
  onRemoveTrack: (trackId: string) => void;
  /** 画布节点结果已更新的联动片段 id。 */
  stale?: ReadonlySet<string>;
  /** 点"有更新"：替换为画布节点的新版本。 */
  onUpdateClip?: (clipId: string) => void;
}

const HEAD_W = 92;

function formatTick(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function ClipThumbs({ engine, clip, project, width, revision }: { engine: CutMediaEngine | null; clip: CutClip; project: CutProject; width: number; revision: number }) {
  const source = findSource(project, clip.sourceId);
  const count = source && (source.kind === 'video' || source.kind === 'image') ? Math.max(1, Math.min(8, Math.floor(width / 96))) : 0;
  const span = clip.duration * clipSpeed(clip);
  const times = useMemo(() => Array.from({ length: count }, (_, index) => clip.in + (span * index) / count), [count, clip.in, span]);
  return (
    <div className="cut-clip__thumbs" aria-hidden>
      {times.map((time, index) => <Thumb key={index} engine={engine} sourceId={clip.sourceId!} kind={source!.kind} time={time} revision={revision} />)}
    </div>
  );
}

function Thumb({ engine, sourceId, kind, time, revision }: { engine: CutMediaEngine | null; sourceId: string; kind: 'video' | 'image' | 'audio'; time: number; revision: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let alive = true;
    if (!engine || !engine.has(sourceId)) return;
    void engine.thumbnail(sourceId, kind, time).then(bitmap => {
      const canvas = ref.current;
      if (!alive || !bitmap || !canvas) return;
      canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    });
    return () => { alive = false; };
  }, [engine, sourceId, kind, time, revision]);
  return <canvas ref={ref} width={96} height={54} className="cut-clip__thumb" />;
}

/**
 * 片段上的音频波形：音频片段画满，视频片段（有声）画在底部一条。按片段的入点、素材跨度和像素宽度重采样，
 * 改速度 / 修剪 / 缩放都会重画；音量改变按比例缩放竖条高度。
 */
function ClipWaveform({ engine, clip, width, revision, strip }: { engine: CutMediaEngine | null; clip: CutClip; width: number; revision: number; strip: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [waveform, setWaveform] = useState<CutWaveform | null>(null);
  const sourceId = clip.sourceId;
  useEffect(() => {
    let alive = true;
    setWaveform(null);
    if (!engine || !sourceId || !engine.has(sourceId)) return;
    void engine.waveform(sourceId).then(result => { if (alive) setWaveform(result); });
    return () => { alive = false; };
  }, [engine, sourceId, revision]);
  const pixels = Math.max(1, Math.min(4096, Math.round(width)));
  const span = clip.duration * clipSpeed(clip);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || !waveform) return;
    const ratio = Math.min(2, globalThis.devicePixelRatio || 1);
    canvas.width = Math.round(pixels * ratio);
    canvas.height = Math.round(canvas.clientHeight * ratio) || (strip ? 24 : 48);
    // 每 2 个 CSS 像素一根竖条。
    const values = sliceWaveform(waveform, clip.in, clip.in + span, Math.max(1, Math.floor(pixels / 2)));
    drawWaveform(ctx, values, canvas.width, canvas.height, { volume: clip.volume });
  }, [waveform, pixels, clip.in, span, clip.volume, strip]);
  if (!waveform) return null;
  return <canvas ref={ref} className={`cut-clip__wave${strip ? ' is-strip' : ''}`} aria-hidden data-testid="cut-clip-wave" />;
}

interface Drag {
  clipId: string;
  mode: 'move' | 'start' | 'end';
  pointerX: number;
  originStart: number;
  originEnd: number;
  trackId: string;
  dx: number;
  hoverTrackId: string;
  snapAt: number | null;
}

function InlineText({ clip, onDone }: { clip: CutClip; onDone: () => void }) {
  const [value, setValue] = useState(clip.text || '');
  const commit = () => {
    if (value !== (clip.text || '')) cutStore.getState().commit(updateClip(getCutProject(), clip.id, { text: value }), clip.kind === 'subtitle' ? 'edit subtitle' : 'edit text');
    onDone();
  };
  return (
    <input
      className="cut-clip__inline"
      autoFocus
      value={value}
      onPointerDown={event => event.stopPropagation()}
      onChange={event => setValue(event.target.value)}
      onBlur={commit}
      onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) commit(); else if (event.key === 'Escape') onDone(); event.stopPropagation(); }}
      data-testid="cut-clip-inline"
    />
  );
}

export function CutTimeline(props: CutTimelineProps) {
  const { language, project, engine, time, selection, snapping, pxPerSecond, offline, onSelect, onSeek, onMove, onTrim, mediaRevision, stale, onUpdateClip } = props;
  const zh = language === 'zho';
  const scrollRef = useRef<HTMLDivElement>(null);
  const [drag, setDragState] = useState<Drag | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const setDrag = useCallback((next: Drag | null) => { dragRef.current = next; setDragState(next); }, []);
  const duration = projectDuration(project);
  const span = Math.max(duration + 10, 30);
  const laneWidth = span * pxPerSecond;
  const tickStep = pxPerSecond >= 160 ? 0.5 : pxPerSecond >= 80 ? 1 : pxPerSecond >= 30 ? 2 : pxPerSecond >= 12 ? 5 : 10;
  const ticks = useMemo(() => Array.from({ length: Math.floor(span / tickStep) + 1 }, (_, index) => index * tickStep), [span, tickStep]);

  // 播放时让播放头保持在可视范围内。
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const x = HEAD_W + time * pxPerSecond;
    if (x < scroller.scrollLeft + HEAD_W || x > scroller.scrollLeft + scroller.clientWidth - 40) scroller.scrollLeft = Math.max(0, x - HEAD_W - 80);
  }, [time, pxPerSecond]);

  const timeFromClientX = useCallback((clientX: number) => {
    const scroller = scrollRef.current;
    if (!scroller) return 0;
    const rect = scroller.getBoundingClientRect();
    return Math.max(0, (clientX - rect.left - HEAD_W + scroller.scrollLeft) / pxPerSecond);
  }, [pxPerSecond]);

  const onRulerPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    onSeek(timeFromClientX(event.clientX));
    const move = (ev: PointerEvent) => onSeek(timeFromClientX(ev.clientX));
    const up = () => { target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', up); };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
  };

  const startDrag = (event: ReactPointerEvent, clip: CutClip, mode: Drag['mode']) => {
    event.stopPropagation();
    if (event.button !== 0 || editing === clip.id) return;
    if (event.shiftKey || event.metaKey || event.ctrlKey) {
      onSelect(selection.includes(clip.id) ? selection.filter(id => id !== clip.id) : [...selection, clip.id]);
      return;
    }
    if (!selection.includes(clip.id) || selection.length > 1) onSelect([clip.id]);
    (event.target as Element).setPointerCapture?.(event.pointerId);
    setDrag({ clipId: clip.id, mode, pointerX: event.clientX, originStart: clip.start, originEnd: clipEnd(clip), trackId: clip.trackId, dx: 0, hoverTrackId: clip.trackId, snapAt: null });
  };

  useEffect(() => {
    if (!drag) return;
    const points: SnapPoint[] = [{ time, type: 'playhead' }, { time: 0, type: 'element-start' }, ...project.clips.filter(clip => clip.id !== drag.clipId).flatMap(clip => [
      { time: clip.start, type: 'element-start' as const, elementId: clip.id }, { time: clipEnd(clip), type: 'element-end' as const, elementId: clip.id },
    ])];
    const threshold = 10 / pxPerSecond;
    const length = drag.originEnd - drag.originStart;
    // 移动时片段两端都参与吸附；修剪时只吸附被拖的那一端。
    const snapped = (current: Drag): { value: number; at: number | null } => {
      const delta = current.dx / pxPerSecond;
      if (current.mode === 'move') {
        const start = current.originStart + delta;
        if (!cutStore.getState().snapping) return { value: Math.max(0, start), at: null };
        const head = resolveSnap(start, points, threshold);
        const tail = resolveSnap(start + length, points, threshold);
        if (head.point && (!tail.point || head.distance <= tail.distance)) return { value: Math.max(0, head.time), at: head.time };
        if (tail.point) return { value: Math.max(0, tail.time - length), at: tail.time };
        return { value: Math.max(0, start), at: null };
      }
      const edge = (current.mode === 'start' ? current.originStart : current.originEnd) + delta;
      if (!cutStore.getState().snapping) return { value: Math.max(0, edge), at: null };
      const hit = resolveSnap(edge, points, threshold);
      return { value: Math.max(0, hit.time), at: hit.point ? hit.time : null };
    };
    const move = (event: PointerEvent) => {
      const lane = (document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null)?.closest<HTMLElement>('[data-cut-lane]');
      const current = dragRef.current;
      if (!current) return;
      const next = { ...current, dx: event.clientX - current.pointerX, hoverTrackId: current.mode === 'move' && lane?.dataset.cutLane ? lane.dataset.cutLane : current.hoverTrackId };
      setDrag({ ...next, snapAt: snapped(next).at });
    };
    const up = () => {
      const current = dragRef.current;
      setDrag(null);
      if (!current || (Math.abs(current.dx) < 1 && current.hoverTrackId === current.trackId)) return;
      const { value } = snapped(current);
      if (current.mode === 'move') onMove(current.clipId, current.hoverTrackId, value);
      else onTrim(current.clipId, current.mode, value);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    // 只在拖动开始 / 结束时重绑。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag?.clipId, drag?.mode]);

  const trackIcon = (track: CutTrack) => track.kind === 'video' ? <Film size={12} /> : track.kind === 'audio' ? <Music size={12} /> : track.kind === 'subtitle' ? <Captions size={12} /> : <Type size={12} />;

  return (
    <div className="cut-timeline" data-testid="cut-timeline">
      <div className="cut-timeline__scroll" ref={scrollRef}>
        <div className="cut-timeline__inner" style={{ width: laneWidth + HEAD_W }}>
          <div className="cut-ruler" onPointerDown={onRulerPointer} role="slider" aria-label={zh ? '时间标尺' : 'Time ruler'} aria-valuemin={0} aria-valuemax={duration} aria-valuenow={time}>
            <div className="cut-ruler__corner" />
            {ticks.map(tick => (
              <span key={tick} className="cut-ruler__tick" style={{ left: HEAD_W + tick * pxPerSecond }}>{Number.isInteger(tick) ? formatTick(tick) : ''}</span>
            ))}
          </div>
          {project.tracks.map(track => {
            const clips = project.clips.filter(clip => clip.trackId === track.id);
            const isHover = drag?.mode === 'move' && drag.hoverTrackId === track.id && drag.trackId !== track.id;
            return (
              <div key={track.id} className={`cut-track cut-track--${track.kind}${track.muted ? ' is-muted' : ''}`} data-track-kind={track.kind}>
                <div className="cut-track__head">
                  <span className="cut-track__name">{trackIcon(track)}{track.name}</span>
                  <span className="cut-track__tools">
                    {track.kind !== 'text' && track.kind !== 'subtitle' && (
                      <button type="button" className="iris-icon-btn is-small" aria-pressed={!!track.muted} title={track.muted ? (zh ? '取消静音' : 'Unmute') : (zh ? (track.kind === 'audio' ? '静音' : '隐藏') : (track.kind === 'audio' ? 'Mute' : 'Hide'))} onClick={() => props.onToggleMute(track.id)}>
                        {track.muted ? <VolumeX size={12} /> : <Volume2 size={12} />}
                      </button>
                    )}
                    <button type="button" className="iris-icon-btn is-small" title={zh ? '删除轨道' : 'Remove track'} onClick={() => props.onRemoveTrack(track.id)}><Trash2 size={12} /></button>
                  </span>
                </div>
                <div className={`cut-track__lane${isHover ? ' is-drop' : ''}`} data-cut-lane={track.id} onPointerDown={() => onSelect([])}>
                  {clips.map(clip => {
                    const source = findSource(project, clip.sourceId);
                    const dragging = drag?.clipId === clip.id ? drag : null;
                    let left = clip.start * pxPerSecond;
                    let width = clip.duration * pxPerSecond;
                    if (dragging?.mode === 'move') left += dragging.dx;
                    if (dragging?.mode === 'start') { left += dragging.dx; width -= dragging.dx; }
                    if (dragging?.mode === 'end') width += dragging.dx;
                    const label = clip.kind === 'text' || clip.kind === 'subtitle' ? (clip.text || (zh ? (clip.kind === 'subtitle' ? '（空字幕）' : '文字') : (clip.kind === 'subtitle' ? '(empty)' : 'Text'))) : source?.name || clip.kind;
                    const isOffline = !!clip.sourceId && offline.has(clip.sourceId);
                    const proxy = clip.kind === 'video' && clip.sourceId && engine ? engine.proxyInfo(clip.sourceId) : null;
                    const speed = clipSpeed(clip);
                    return (
                      <div
                        key={clip.id}
                        className={`cut-clip cut-clip--${clip.kind}${selection.includes(clip.id) ? ' is-selected' : ''}${dragging ? ' is-dragging' : ''}${isOffline ? ' is-offline' : ''}`}
                        style={{ left, width: Math.max(6, width) }}
                        data-testid="cut-clip"
                        data-clip-id={clip.id}
                        data-clip-kind={clip.kind}
                        title={isOffline ? (zh ? `${label}（素材未加载，请重新导入）` : `${label} (media offline, re-import)`) : label}
                        onPointerDown={event => startDrag(event, clip, 'move')}
                        onDoubleClick={() => { if (clip.kind === 'text' || clip.kind === 'subtitle') setEditing(clip.id); }}
                      >
                        {clip.sourceId && !isOffline && width > 40 && <ClipThumbs engine={engine} clip={clip} project={project} width={width} revision={mediaRevision} />}
                        {clip.sourceId && !isOffline && width > 12 && (clip.kind === 'audio' || (clip.kind === 'video' && source?.hasAudio)) && (
                          <ClipWaveform engine={engine} clip={clip} width={width} revision={mediaRevision} strip={clip.kind === 'video'} />
                        )}
                        {editing === clip.id ? <InlineText clip={clip} onDone={() => setEditing(null)} /> : (
                          <span className="cut-clip__label">
                            {clip.kind === 'video' ? <Film size={11} /> : clip.kind === 'image' ? <ImageIcon size={11} /> : clip.kind === 'audio' ? <Music size={11} /> : clip.kind === 'subtitle' ? <Captions size={11} /> : <Type size={11} />}
                            <span>{label}</span>
                            {speed !== 1 && <em>{speed}×</em>}
                            {clip.volume !== 1 && (clip.kind === 'video' || clip.kind === 'audio') && <em>{Math.round(clip.volume * 100)}%</em>}
                          </span>
                        )}
                        {proxy && proxy.status !== 'none' && (
                          <span className={`cut-clip__badge${proxy.status === 'generating' ? ' is-busy' : ''}`} data-testid="cut-proxy-badge">
                            {proxy.status === 'generating' ? `${zh ? '代理' : 'Proxy'} ${Math.round((proxy.progress ?? 0) * 100)}%` : `${zh ? '代理' : 'Proxy'} ${proxy.height}p`}
                          </span>
                        )}
                        {stale?.has(clip.id) && (
                          <button
                            type="button"
                            className="cut-clip__update"
                            data-testid="cut-clip-update"
                            title={zh ? '画布节点结果已更新，点击替换为新版本' : 'The canvas node has a new result, click to use it'}
                            onPointerDown={event => event.stopPropagation()}
                            onClick={event => { event.stopPropagation(); onUpdateClip?.(clip.id); }}
                          >{zh ? '有更新' : 'Update'}</button>
                        )}
                        {clip.keyframes?.map((frame, index) => <span key={index} className="cut-clip__kf" style={{ left: frame.time * pxPerSecond }} aria-hidden />)}
                        <span className="cut-clip__handle is-start" onPointerDown={event => startDrag(event, clip, 'start')} />
                        <span className="cut-clip__handle is-end" onPointerDown={event => startDrag(event, clip, 'end')} />
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
          {drag?.snapAt !== null && drag?.snapAt !== undefined && <div className="cut-snapline" style={{ left: HEAD_W + drag.snapAt * pxPerSecond }} aria-hidden />}
          <div className="cut-playhead" style={{ left: HEAD_W + time * pxPerSecond }} aria-hidden />
        </div>
      </div>
    </div>
  );
}
