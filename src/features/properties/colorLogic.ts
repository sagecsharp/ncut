import { DEFAULT_ADJUST, isAdjustActive } from '../../engine/clipLook';
import type { ClipAdjust, ClipMotionBlur, MotionBlurStyle } from '../../types';

export type AdjustKey = keyof ClipAdjust;

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** the adjust after one value changed. null when everything is back to 0 (a clip without a look has none). */
export function setAdjustValue(adjust: ClipAdjust | null | undefined, key: AdjustKey, value: number): ClipAdjust | null {
  const max = key === 'hue' ? 180 : 1;
  const v = Number.isFinite(value) ? Math.min(max, Math.max(-max, value)) : 0;
  const next: ClipAdjust = { ...DEFAULT_ADJUST, ...adjust, [key]: round3(v) };
  return isAdjustActive(next) ? next : null;
}

export const DEFAULT_MOTION_BLUR: ClipMotionBlur = { shutter: 0.5, samples: 8 };

/** the motion blur after one value changed (shutter 0..2, samples 2..32 whole) */
export function setBlurValue(blur: ClipMotionBlur | null | undefined, key: keyof ClipMotionBlur, value: number): ClipMotionBlur {
  const base = blur ?? DEFAULT_MOTION_BLUR;
  if (!Number.isFinite(value)) return base;
  return key === 'shutter'
    ? { ...base, shutter: round3(Math.min(2, Math.max(0, value))) }
    : { ...base, samples: Math.round(Math.min(32, Math.max(2, value))) };
}

/** the motion blur with another kind. 'even' is the default, so it is stored as no style at all. */
export function setBlurStyle(blur: ClipMotionBlur | null | undefined, style: MotionBlurStyle): ClipMotionBlur {
  const { style: _old, ...rest } = blur ?? DEFAULT_MOTION_BLUR;
  void _old;
  return style === 'even' ? rest : { ...rest, style };
}
