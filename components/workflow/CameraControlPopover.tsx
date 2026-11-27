import { Camera, RotateCcw, Sparkles, Video, X } from 'lucide-react';
import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { CAMERA_MOVEMENTS } from './constants';
import {
  CAMERA_ANGLE_PRESETS,
  CINE_APERTURES,
  CINE_CAMERAS,
  CINE_FOCAL_LENGTHS,
  CINE_LENSES,
  DEFAULT_CAMERA_RIG_3D,
  clampCameraRig3D,
  compileCameraPromptFragment,
  describeCameraRig3D,
  type CameraRig3D,
} from './cameraControl';
import type { CameraParams } from './types';

export interface CameraControlValue {
  camera?: CameraParams;
  cameraMovement?: string;
  rig3d?: CameraRig3D;
}

export function CameraControlPopover({
  value,
  mode,
  language = 'zho',
  onChange,
  onApplyToPrompt,
  onSpawnMultiAngle,
  onClose,
}: {
  value: CameraControlValue;
  mode: 'image' | 'video';
  language?: 'en' | 'zho';
  onChange: (next: CameraControlValue) => void;
  onApplyToPrompt: (fragment: string, next: CameraControlValue) => void;
  onSpawnMultiAngle?: (fragment: string, next: CameraControlValue) => void;
  onClose: () => void;
}) {
  const en = language === 'en';
  const L = (zh: string, enText: string) => (en ? enText : zh);
  const [camera, setCamera] = useState<CameraParams>(() => ({ ...(value.camera || {}) }));
  const [cameraMovement, setCameraMovement] = useState<string>(value.cameraMovement || '');
  const [rig3d, setRig3d] = useState<CameraRig3D>(() => clampCameraRig3D(value.rig3d || DEFAULT_CAMERA_RIG_3D));
  const [tab, setTab] = useState<'cube' | 'lens' | 'motion'>('cube');
  const dragRef = useRef<{ x: number; y: number; yaw: number; pitch: number } | null>(null);

  const emit = (nextCam: CameraParams, nextMove: string, nextRig: CameraRig3D) => {
    const cleanCam: CameraParams = {};
    if (nextCam.camera) cleanCam.camera = nextCam.camera;
    if (nextCam.lens) cleanCam.lens = nextCam.lens;
    if (nextCam.focalLength) cleanCam.focalLength = nextCam.focalLength;
    if (nextCam.aperture) cleanCam.aperture = nextCam.aperture;
    const payload: CameraControlValue = {
      camera: Object.keys(cleanCam).length ? cleanCam : undefined,
      cameraMovement: nextMove || undefined,
      rig3d: nextRig,
    };
    onChange(payload);
    return payload;
  };

  const updateRig = (patch: Partial<CameraRig3D>, clearPreset = true) => {
    const next = clampCameraRig3D({
      ...rig3d,
      ...patch,
      presetId: clearPreset ? undefined : patch.presetId ?? rig3d.presetId,
    });
    setRig3d(next);
    emit(camera, cameraMovement, next);
  };

  const updateCamera = (patch: Partial<CameraParams>) => {
    const next = { ...camera, ...patch };
    setCamera(next);
    emit(next, cameraMovement, rig3d);
  };

  const updateMovement = (move: string) => {
    const next = cameraMovement === move ? '' : move;
    setCameraMovement(next);
    emit(camera, next, rig3d);
  };

  const resetAll = () => {
    setCamera({});
    setCameraMovement('');
    setRig3d(DEFAULT_CAMERA_RIG_3D);
    emit({}, '', DEFAULT_CAMERA_RIG_3D);
  };

  const onCubePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { x: event.clientX, y: event.clientY, yaw: rig3d.yaw, pitch: rig3d.pitch };
  };

  const onCubePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    event.stopPropagation();
    const dx = event.clientX - dragRef.current.x;
    const dy = event.clientY - dragRef.current.y;
    updateRig({
      yaw: dragRef.current.yaw + dx * 0.9,
      pitch: dragRef.current.pitch - dy * 0.7,
    });
  };

  const onCubePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    event.stopPropagation();
    dragRef.current = null;
  };

  const currentValue: CameraControlValue = {
    camera: Object.values(camera).some(Boolean) ? camera : undefined,
    cameraMovement: cameraMovement || undefined,
    rig3d,
  };
  const compiled = compileCameraPromptFragment(currentValue);
  const cubeScale = Math.max(0.65, Math.min(1.45, 1 / Math.max(0.55, rig3d.zoom)));

  return (
    <div
      className="wf-camera-popover flv-glass flv-glass--thick"
      role="dialog"
      aria-label={L('摄影机与 3D 视角控制', 'Cine Camera & 3D Multi-Angle')}
      data-testid="workflow-camera-popover"
      data-workflow-overlay
      onPointerDown={event => event.stopPropagation()}
      onWheel={event => event.stopPropagation()}
    >
      <div className="wf-camera-popover__head">
        <span className="wf-camera-popover__title">
          <Camera size={14} />
          <strong>{L('摄影机 · 3D 视角', 'Cine Camera & 3D Angle')}</strong>
        </span>
        <div className="wf-camera-popover__tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'cube'} className={tab === 'cube' ? 'is-active' : undefined} onClick={() => setTab('cube')}>{L('3D 视角', '3D Angle')}</button>
          <button type="button" role="tab" aria-selected={tab === 'lens'} className={tab === 'lens' ? 'is-active' : undefined} onClick={() => setTab('lens')}>{L('机身与镜头', 'Cine Lens')}</button>
          <button type="button" role="tab" aria-selected={tab === 'motion'} className={tab === 'motion' ? 'is-active' : undefined} onClick={() => setTab('motion')}>{L('运镜', 'Motion')}</button>
        </div>
        <div className="wf-camera-popover__head-actions">
          <button type="button" className="wf-camera-popover__icon-btn" title={L('重置参数', 'Reset')} aria-label={L('重置参数', 'Reset')} onClick={resetAll}><RotateCcw size={13} /></button>
          <button type="button" className="wf-camera-popover__icon-btn" title={L('关闭', 'Close')} aria-label={L('关闭', 'Close')} onClick={onClose}><X size={14} /></button>
        </div>
      </div>

      {tab === 'cube' && (
        <div className="wf-camera-popover__body">
          <div className="wf-camera-cube-stage">
            <div
              className="wf-camera-cube-viewport"
              data-testid="camera-3d-cube"
              title={L('拖拽旋转 3D 机位', 'Drag to orbit 3D camera angle')}
              onPointerDown={onCubePointerDown}
              onPointerMove={onCubePointerMove}
              onPointerUp={onCubePointerUp}
              onPointerCancel={onCubePointerUp}
            >
              <div
                className="wf-camera-cube"
                style={{
                  transform: `scale(${cubeScale.toFixed(2)}) rotateX(${-rig3d.pitch}deg) rotateY(${rig3d.yaw}deg) rotateZ(${rig3d.roll}deg)`,
                }}
              >
                <div className="wf-camera-cube__face wf-camera-cube__face--front">{L('正', 'F')}</div>
                <div className="wf-camera-cube__face wf-camera-cube__face--back">{L('背', 'B')}</div>
                <div className="wf-camera-cube__face wf-camera-cube__face--right">{L('右', 'R')}</div>
                <div className="wf-camera-cube__face wf-camera-cube__face--left">{L('左', 'L')}</div>
                <div className="wf-camera-cube__face wf-camera-cube__face--top">{L('顶', 'T')}</div>
                <div className="wf-camera-cube__face wf-camera-cube__face--bottom">{L('底', 'D')}</div>
              </div>
            </div>
            <div className="wf-camera-sliders">
              <label>
                <span>{L('水平环绕', 'Yaw')} <b>{rig3d.yaw}°</b></span>
                <input type="range" min={-180} max={180} value={rig3d.yaw} onChange={e => updateRig({ yaw: Number(e.target.value) })} />
              </label>
              <label>
                <span>{L('俯仰机位', 'Pitch')} <b>{rig3d.pitch}°</b></span>
                <input type="range" min={-60} max={80} value={rig3d.pitch} onChange={e => updateRig({ pitch: Number(e.target.value) })} />
              </label>
              <label>
                <span>{L('荷兰倾斜', 'Roll')} <b>{rig3d.roll}°</b></span>
                <input type="range" min={-45} max={45} value={rig3d.roll} onChange={e => updateRig({ roll: Number(e.target.value) })} />
              </label>
              <label>
                <span>{L('景别距离', 'Distance')} <b>{rig3d.zoom.toFixed(2)}x</b></span>
                <input type="range" min={0.5} max={2.0} step={0.05} value={rig3d.zoom} onChange={e => updateRig({ zoom: Number(e.target.value) })} />
              </label>
            </div>
          </div>

          <div className="wf-camera-presets">
            {CAMERA_ANGLE_PRESETS.map(preset => (
              <button
                key={preset.id}
                type="button"
                className={`wf-camera-chip${rig3d.presetId === preset.id ? ' is-active' : ''}`}
                onClick={() => updateRig({ yaw: preset.yaw, pitch: preset.pitch, roll: preset.roll, zoom: preset.zoom, presetId: preset.id }, false)}
              >
                {en ? preset.labelEn : preset.label}
              </button>
            ))}
          </div>
          <p className="wf-camera-angle-readout">{describeCameraRig3D(rig3d, language)}</p>
        </div>
      )}

      {tab === 'lens' && (
        <div className="wf-camera-popover__body wf-camera-lens-grid">
          <section>
            <span className="wf-camera-section-label">{L('电影摄影机身', 'Cinema Body')}</span>
            <div className="wf-camera-option-grid">
              {CINE_CAMERAS.map(item => {
                const active = camera.camera === item.label || camera.camera === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`wf-camera-card${active ? ' is-active' : ''}`}
                    onClick={() => updateCamera({ camera: active ? undefined : item.label })}
                  >
                    <strong>{item.label}</strong>
                    <span>{en ? item.taglineEn : item.tagline}</span>
                  </button>
                );
              })}
            </div>
          </section>

          <section>
            <span className="wf-camera-section-label">{L('电影定焦 / 变形镜头', 'Cinema Lens')}</span>
            <div className="wf-camera-option-grid">
              {CINE_LENSES.map(item => {
                const active = camera.lens === item.label || camera.lens === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`wf-camera-card${active ? ' is-active' : ''}`}
                    onClick={() => updateCamera({ lens: active ? undefined : item.label })}
                  >
                    <strong>{item.label}</strong>
                    <span>{en ? item.taglineEn : item.tagline}</span>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="wf-camera-inline-row">
            <div>
              <span className="wf-camera-section-label">{L('焦段', 'Focal Length')}</span>
              <div className="wf-camera-presets">
                {CINE_FOCAL_LENGTHS.map(focal => (
                  <button
                    key={focal}
                    type="button"
                    className={`wf-camera-chip${camera.focalLength === focal ? ' is-active' : ''}`}
                    onClick={() => updateCamera({ focalLength: camera.focalLength === focal ? undefined : focal })}
                  >
                    {focal}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <span className="wf-camera-section-label">{L('光圈 / 景深', 'Aperture')}</span>
              <div className="wf-camera-presets">
                {CINE_APERTURES.map(ap => (
                  <button
                    key={ap}
                    type="button"
                    className={`wf-camera-chip${camera.aperture === ap ? ' is-active' : ''}`}
                    onClick={() => updateCamera({ aperture: camera.aperture === ap ? undefined : ap })}
                  >
                    {ap}
                  </button>
                ))}
              </div>
            </div>
          </section>
        </div>
      )}

      {tab === 'motion' && (
        <div className="wf-camera-popover__body">
          <span className="wf-camera-section-label">
            <Video size={12} /> {mode === 'video' ? L('视频运镜控制', 'Video Camera Movement') : L('动态镜头感提示', 'Dynamic Camera Feel')}
          </span>
          <div className="wf-camera-presets">
            {CAMERA_MOVEMENTS.map(move => {
              const active = cameraMovement === move.promptKeyword;
              return (
                <button
                  key={move.id}
                  type="button"
                  className={`wf-camera-chip${active ? ' is-active' : ''}`}
                  title={move.description}
                  onClick={() => updateMovement(move.promptKeyword)}
                >
                  {en ? move.promptKeyword : move.name}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="wf-camera-popover__footer">
        <code className="wf-camera-compiled" title={compiled || L('未设置额外机位参数', 'No camera tokens selected')}>
          {compiled || L('拖拽 3D 立方体或选择机身镜头即可生成专业光学参数', 'Orbit cube or choose lens to build optical tokens')}
        </code>
        <div className="wf-camera-footer-btns">
          {onSpawnMultiAngle && (
            <button
              type="button"
              className="wf-camera-btn"
              data-testid="camera-spawn-angle-node"
              disabled={!compiled}
              onClick={() => { onSpawnMultiAngle(compiled, currentValue); onClose(); }}
            >
              <Sparkles size={13} />
              {L('派生新视角节点', 'Spawn Angle Node')}
            </button>
          )}
          <button
            type="button"
            className="wf-camera-btn wf-camera-btn--primary"
            data-testid="camera-apply-prompt"
            onClick={() => { onApplyToPrompt(compiled, currentValue); onClose(); }}
          >
            {L('写入提示词', 'Apply to Prompt')}
          </button>
        </div>
      </div>
    </div>
  );
}
