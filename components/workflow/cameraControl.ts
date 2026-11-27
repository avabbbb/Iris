// TapNow-parity Cine Camera, Lens Combo & Interactive 3D Multi-Angle Rig.
// Pure data + prompt compiler: keeps node metadata provider-neutral and compiles
// cinema body, lens, focal length, aperture, camera movement, and 3D spherical
// viewpoint (yaw / pitch / roll / zoom) into deterministic English/Chinese tokens.

export interface CameraRig3D {
  /** Horizontal orbit around subject in degrees (-180..180, 0 = front). */
  yaw: number;
  /** Vertical elevation in degrees (-60..80, 0 = eye-level, positive = high-angle). */
  pitch: number;
  /** Dutch roll tilt in degrees (-45..45, 0 = level horizon). */
  roll: number;
  /** Framing distance multiplier (0.5 = extreme close-up .. 2.0 = wide/far, 1.0 = medium). */
  zoom: number;
  /** Optional quick preset identifier. */
  presetId?: string;
}

export interface CineCameraSpec {
  id: string;
  label: string;
  tagline: string;
  taglineEn: string;
  promptToken: string;
}

export interface CineLensSpec {
  id: string;
  label: string;
  tagline: string;
  taglineEn: string;
  promptToken: string;
}

export interface CameraAnglePreset {
  id: string;
  label: string;
  labelEn: string;
  yaw: number;
  pitch: number;
  roll: number;
  zoom: number;
  promptToken: string;
}

export const DEFAULT_CAMERA_RIG_3D: CameraRig3D = {
  yaw: 0,
  pitch: 0,
  roll: 0,
  zoom: 1,
  presetId: 'front',
};

export const CINE_CAMERAS: readonly CineCameraSpec[] = [
  { id: 'arri-alexa-35', label: 'ARRI ALEXA 35', tagline: '电影胶片宽容度 · 肤色自然', taglineEn: '17-stop cinema DR, natural skin', promptToken: 'shot on ARRI ALEXA 35' },
  { id: 'arri-alexa-65', label: 'ARRI ALEXA 65', tagline: '65mm 大画幅史诗景深', taglineEn: '65mm large-format epic depth', promptToken: 'shot on ARRI ALEXA 65 large format' },
  { id: 'sony-venice-2', label: 'Sony Venice 2', tagline: '8K 全画幅夜景纯净低噪', taglineEn: '8K full-frame, clean low-light', promptToken: 'shot on Sony Venice 2 8K' },
  { id: 'red-v-raptor', label: 'RED V-RAPTOR 8K', tagline: '锐利高动态商业质感', taglineEn: 'crisp commercial 8K VV look', promptToken: 'shot on RED V-RAPTOR 8K VV' },
  { id: 'panavision-dxl2', label: 'Panavision DXL2', tagline: '好莱坞大片温润色彩', taglineEn: 'Hollywood warm color science', promptToken: 'shot on Panavision Millennium DXL2' },
  { id: 'imax-70mm', label: 'IMAX 70mm Film', tagline: '真实胶片颗粒 · 宏大尺度', taglineEn: 'authentic 70mm film scale & grain', promptToken: 'shot on IMAX 70mm film, fine film grain' },
  { id: 'leica-m11', label: 'Leica M11', tagline: '德系人文街拍微反差', taglineEn: 'editorial rangefinder micro-contrast', promptToken: 'shot on Leica M11' },
  { id: 'kodak-vision3', label: 'Kodak Vision3 500T', tagline: '钨丝灯电影胶片色泽', taglineEn: 'tungsten 35mm cinema film stock', promptToken: 'shot on Kodak Vision3 500T 35mm film' },
];

export const CINE_LENSES: readonly CineLensSpec[] = [
  { id: 'arri-signature-prime', label: 'ARRI Signature Prime', tagline: '柔顺焦外 · 现代电影标杆', taglineEn: 'creamy bokeh, modern cinema prime', promptToken: 'ARRI Signature Prime lens' },
  { id: 'cooke-anamorphic', label: 'Cooke Anamorphic/i SF', tagline: '变形宽银幕 · 经典蓝色拉丝光斑', taglineEn: 'anamorphic oval bokeh & subtle flare', promptToken: 'Cooke Anamorphic/i SF lens, oval bokeh, subtle cinema flare' },
  { id: 'panavision-primo', label: 'Panavision Primo 70', tagline: '浓郁立体感 · 古典锐度', taglineEn: 'classic dimensional cinema rendering', promptToken: 'Panavision Primo 70 cinema lens' },
  { id: 'zeiss-master-prime', label: 'Zeiss Master Prime', tagline: '极致解析力 · 零呼吸效应', taglineEn: 'clinical sharpness, zero distortion', promptToken: 'Zeiss Master Prime lens' },
  { id: 'helios-44-2', label: 'Helios 44-2', tagline: '苏联老镜 · 标志性旋涡焦外', taglineEn: 'vintage swirly bokeh character', promptToken: 'vintage Helios 44-2 lens, swirly bokeh' },
  { id: 'laowa-probe-macro', label: 'Laowa 24mm Probe', tagline: '微距穿梭 · 产品细节特写', taglineEn: 'extreme probe macro perspective', promptToken: 'Laowa 24mm probe macro lens' },
  { id: 'tilt-shift-45', label: 'Tilt-Shift 45mm', tagline: '移轴微缩 · 建筑校正透视', taglineEn: 'selective tilt-shift focal plane', promptToken: '45mm tilt-shift lens, selective focus plane' },
];

export const CINE_FOCAL_LENGTHS = ['14mm', '24mm', '35mm', '50mm', '85mm', '135mm', '200mm'] as const;
export const CINE_APERTURES = ['f/1.2', 'f/1.4', 'f/2.0', 'f/2.8', 'f/4', 'f/5.6', 'f/8', 'f/16'] as const;

export const CAMERA_ANGLE_PRESETS: readonly CameraAnglePreset[] = [
  { id: 'front', label: '正面平视', labelEn: 'Front Eye-Level', yaw: 0, pitch: 0, roll: 0, zoom: 1.0, promptToken: 'front eye-level view' },
  { id: 'three-quarter-left', label: '左前 3/4', labelEn: '3/4 Front Left', yaw: -38, pitch: 8, roll: 0, zoom: 1.0, promptToken: 'three-quarter front-left angle' },
  { id: 'three-quarter-right', label: '右前 3/4', labelEn: '3/4 Front Right', yaw: 38, pitch: 8, roll: 0, zoom: 1.0, promptToken: 'three-quarter front-right angle' },
  { id: 'profile-left', label: '左侧面', labelEn: 'Left Profile', yaw: -90, pitch: 0, roll: 0, zoom: 1.0, promptToken: 'left side profile view' },
  { id: 'profile-right', label: '右侧面', labelEn: 'Right Profile', yaw: 90, pitch: 0, roll: 0, zoom: 1.0, promptToken: 'right side profile view' },
  { id: 'back', label: '背影视角', labelEn: 'Back View', yaw: 180, pitch: 5, roll: 0, zoom: 1.05, promptToken: 'rear back view looking over shoulder' },
  { id: 'low-angle', label: '低机位仰拍', labelEn: 'Low-Angle Hero', yaw: -15, pitch: -32, roll: 0, zoom: 0.9, promptToken: 'dramatic low-angle hero shot looking up' },
  { id: 'high-angle', label: '高机位俯拍', labelEn: 'High-Angle', yaw: 18, pitch: 38, roll: 0, zoom: 1.15, promptToken: 'high-angle shot looking down' },
  { id: 'top-down', label: '顶视鸟瞰', labelEn: "Top-Down Bird's Eye", yaw: 0, pitch: 78, roll: 0, zoom: 1.35, promptToken: "top-down bird's-eye overhead shot" },
  { id: 'dutch', label: '荷兰倾斜角', labelEn: 'Dutch Tilt', yaw: 22, pitch: -10, roll: 18, zoom: 0.95, promptToken: 'tilted Dutch angle composition' },
  { id: 'closeup', label: '近景特写', labelEn: 'Tight Close-Up', yaw: 0, pitch: 0, roll: 0, zoom: 0.58, promptToken: 'tight close-up framing' },
  { id: 'wide', label: '大广角远景', labelEn: 'Wide Establishing', yaw: 0, pitch: 6, roll: 0, zoom: 1.75, promptToken: 'wide establishing shot' },
];

export function clampCameraRig3D(rig: Partial<CameraRig3D> | undefined): CameraRig3D {
  const yawRaw = Number.isFinite(rig?.yaw) ? Number(rig!.yaw) : 0;
  // Wrap yaw into [-180, 180]
  const yaw = ((((yawRaw + 180) % 360) + 360) % 360) - 180;
  const pitch = Math.max(-60, Math.min(80, Number.isFinite(rig?.pitch) ? Number(rig!.pitch) : 0));
  const roll = Math.max(-45, Math.min(45, Number.isFinite(rig?.roll) ? Number(rig!.roll) : 0));
  const zoom = Math.max(0.5, Math.min(2.0, Number.isFinite(rig?.zoom) ? Number(rig!.zoom) : 1));
  return {
    yaw: Math.round(yaw),
    pitch: Math.round(pitch),
    roll: Math.round(roll),
    zoom: Math.round(zoom * 100) / 100,
    ...(rig?.presetId ? { presetId: rig.presetId } : {}),
  };
}

export function describeCameraRig3D(rig: CameraRig3D, language: 'en' | 'zho' = 'en'): string {
  const clamped = clampCameraRig3D(rig);
  if (clamped.presetId) {
    const preset = CAMERA_ANGLE_PRESETS.find(item => item.id === clamped.presetId);
    if (
      preset
      && Math.abs(preset.yaw - clamped.yaw) <= 4
      && Math.abs(preset.pitch - clamped.pitch) <= 4
      && Math.abs(preset.roll - clamped.roll) <= 3
      && Math.abs(preset.zoom - clamped.zoom) <= 0.08
    ) {
      return language === 'en' ? preset.promptToken : preset.label;
    }
  }
  const parts: string[] = [];
  const absYaw = Math.abs(clamped.yaw);
  if (absYaw <= 18) parts.push(language === 'en' ? 'front view' : '正面视角');
  else if (absYaw >= 155) parts.push(language === 'en' ? 'rear back view' : '背面视角');
  else if (absYaw >= 70 && absYaw <= 110) parts.push(language === 'en' ? (clamped.yaw < 0 ? 'left side profile' : 'right side profile') : (clamped.yaw < 0 ? '左侧面视角' : '右侧面视角'));
  else if (absYaw < 70) parts.push(language === 'en' ? (clamped.yaw < 0 ? 'front-left 3/4 angle' : 'front-right 3/4 angle') : (clamped.yaw < 0 ? '左前 3/4 视角' : '右前 3/4 视角'));
  else parts.push(language === 'en' ? (clamped.yaw < 0 ? 'rear-left 3/4 angle' : 'rear-right 3/4 angle') : (clamped.yaw < 0 ? '左后 3/4 视角' : '右后 3/4 视角'));

  if (clamped.pitch >= 65) parts.push(language === 'en' ? "top-down bird's-eye view" : '顶视鸟瞰');
  else if (clamped.pitch >= 22) parts.push(language === 'en' ? `high-angle (${clamped.pitch}°)` : `高机位俯拍 ${clamped.pitch}°`);
  else if (clamped.pitch <= -18) parts.push(language === 'en' ? `low-angle looking up (${Math.abs(clamped.pitch)}°)` : `低机位仰拍 ${Math.abs(clamped.pitch)}°`);

  if (Math.abs(clamped.roll) >= 8) {
    parts.push(language === 'en' ? `Dutch tilt (${clamped.roll}°)` : `荷兰角倾斜 ${clamped.roll}°`);
  }

  if (clamped.zoom <= 0.68) parts.push(language === 'en' ? 'close-up framing' : '近景特写');
  else if (clamped.zoom >= 1.5) parts.push(language === 'en' ? 'wide establishing distance' : '远景大广角');

  return parts.join(', ');
}

export interface CameraPromptCompileInput {
  camera?: {
    camera?: string;
    lens?: string;
    focalLength?: string;
    aperture?: string;
  };
  cameraMovement?: string;
  rig3d?: CameraRig3D;
}

/**
 * Compile structured Cine Camera + Lens + Movement + 3D Angle into a clean,
 * model-friendly cinematic prompt suffix (provider-neutral, no model lock-in).
 */
export function compileCameraPromptFragment(input: CameraPromptCompileInput): string {
  const tokens: string[] = [];
  if (input.rig3d) {
    const isDefault = input.rig3d.yaw === 0 && input.rig3d.pitch === 0 && input.rig3d.roll === 0 && Math.abs(input.rig3d.zoom - 1) < 0.05 && (!input.rig3d.presetId || input.rig3d.presetId === 'front');
    if (!isDefault) tokens.push(describeCameraRig3D(input.rig3d, 'en'));
  }
  if (input.camera?.camera) {
    const match = CINE_CAMERAS.find(item => item.id === input.camera!.camera || item.label === input.camera!.camera);
    tokens.push(match ? match.promptToken : `shot on ${input.camera.camera}`);
  }
  if (input.camera?.lens) {
    const match = CINE_LENSES.find(item => item.id === input.camera!.lens || item.label === input.camera!.lens);
    tokens.push(match ? match.promptToken : `${input.camera.lens} lens`);
  }
  if (input.camera?.focalLength) tokens.push(`${input.camera.focalLength} focal length`);
  if (input.camera?.aperture) {
    const fVal = Number.parseFloat(input.camera.aperture.replace(/^f\//i, ''));
    const dof = Number.isFinite(fVal) && fVal <= 2.2 ? 'shallow depth of field' : Number.isFinite(fVal) && fVal >= 8 ? 'deep focus' : '';
    tokens.push(dof ? `${input.camera.aperture}, ${dof}` : input.camera.aperture);
  }
  if (input.cameraMovement) tokens.push(input.cameraMovement);
  return tokens.filter(Boolean).join(', ');
}

/** Short badge summary displayed on workflow node header when Cine Rig is active. */
export function summarizeCameraControl(input: CameraPromptCompileInput, language: 'en' | 'zho' = 'zho'): string {
  const bits: string[] = [];
  if (input.camera?.camera) {
    const match = CINE_CAMERAS.find(item => item.id === input.camera!.camera || item.label === input.camera!.camera);
    bits.push(match ? match.label : input.camera.camera);
  }
  if (input.camera?.focalLength) bits.push(input.camera.focalLength);
  if (input.camera?.aperture) bits.push(input.camera.aperture);
  if (input.rig3d) {
    const nonZero = Math.abs(input.rig3d.yaw) > 2 || Math.abs(input.rig3d.pitch) > 2 || Math.abs(input.rig3d.roll) > 2 || Math.abs(input.rig3d.zoom - 1) > 0.08;
    if (nonZero) {
      bits.push(language === 'en' ? `3D ${input.rig3d.yaw}°/${input.rig3d.pitch}°` : `3D视角 ${input.rig3d.yaw}°/${input.rig3d.pitch}°`);
    }
  }
  if (input.cameraMovement) bits.push(input.cameraMovement);
  return bits.join(' · ');
}

const CAMERA_TAG_PATTERN = /\s*\[Camera:[^\]]*\]\s*$/i;

/** Merge compiled camera fragment into an existing prompt idempotently via `[Camera: ...]` suffix. */
export function applyCameraFragmentToPrompt(prompt: string, fragment: string): string {
  const base = prompt.replace(CAMERA_TAG_PATTERN, '').trimEnd();
  const clean = fragment.trim();
  if (!clean) return base;
  return base ? `${base} [Camera: ${clean}]` : `[Camera: ${clean}]`;
}
