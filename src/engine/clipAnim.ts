/**
 * ready-made motions for whole clips (types.ts ClipAnim: clip.motionIn / motionOut / motionLoop).
 * a motion never changes stored values: it is applied on top of the clip's transform (after
 * keyframes) at draw time, so preview and export always match.
 */
import type { VisualClip } from '../types';

export interface ClipMotionInfo {
  id: string;
  /** lowercase label for menus */
  name: string;
  /** true = only makes sense for 3d clips (menus hide it for 2d clips, a 2d clip ignores it) */
  threeD?: boolean;
}

/** entrances. the exits are the same moves played backwards (the clip leaves the way it would have come). */
export const CLIP_MOTIONS_IN: ClipMotionInfo[] = [
  { id: 'fade', name: 'fade' },
  { id: 'slide-left', name: 'slide from right' },
  { id: 'slide-right', name: 'slide from left' },
  { id: 'slide-up', name: 'slide from below' },
  { id: 'slide-down', name: 'slide from above' },
  { id: 'zoom-in', name: 'grow' },
  { id: 'zoom-out', name: 'shrink' },
  { id: 'pop', name: 'pop' },
  { id: 'spin', name: 'spin' },
  { id: 'drop', name: 'drop' },
  { id: 'swing', name: 'swing' },
  { id: 'flip', name: 'flip' },
];

export const CLIP_MOTIONS_OUT: ClipMotionInfo[] = CLIP_MOTIONS_IN;

export const CLIP_MOTIONS_LOOP: ClipMotionInfo[] = [
  { id: 'pulse', name: 'pulse' },
  { id: 'float', name: 'float' },
  { id: 'wobble', name: 'wobble' },
  { id: 'shake', name: 'shake' },
  { id: 'rotate', name: 'rotate' },
  { id: 'swing', name: 'swing' },
  { id: 'bounce', name: 'bounce' },
  { id: 'blink', name: 'blink' },
  { id: 'orbit', name: 'orbit' },
];

export const DEFAULT_CLIP_MOTION_IN = 0.5;
export const DEFAULT_CLIP_MOTION_OUT = 0.5;
export const DEFAULT_CLIP_MOTION_LOOP = 2;

/** true when the clip has any motion set */
export function hasClipMotion(clip: VisualClip): boolean {
  return !!(clip.motionIn || clip.motionOut || clip.motionLoop);
}

interface Pose {
  dx: number;
  dy: number;
  /** multiplies scale */
  s: number;
  /** degrees, added */
  rot: number;
  /** multiplies opacity */
  op: number;
  /** degrees, added (3d clips only) */
  rotY: number;
}

// one scratch pose: applyClipMotion is synchronous and not re-entrant
const POSE: Pose = { dx: 0, dy: 0, s: 1, rot: 0, op: 1, rotY: 0 };
const TAU = Math.PI * 2;

function resetPose(): Pose {
  POSE.dx = 0;
  POSE.dy = 0;
  POSE.s = 1;
  POSE.rot = 0;
  POSE.op = 1;
  POSE.rotY = 0;
  return POSE;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeOutCubic = (p: number) => 1 - Math.pow(1 - p, 3);
function easeOutBack(p: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
}
function easeOutBounce(p: number): number {
  const n = 7.5625;
  const d = 2.75;
  if (p < 1 / d) return n * p * p;
  if (p < 2 / d) return n * (p -= 1.5 / d) * p + 0.75;
  if (p < 2.5 / d) return n * (p -= 2.25 / d) * p + 0.9375;
  return n * (p -= 2.625 / d) * p + 0.984375;
}

/** deterministic noise in -1..1 from a number */
function hash(n: number): number {
  const v = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return (v - Math.floor(v)) * 2 - 1;
}

/**
 * entrance pose at progress p (0 = just starting, 1 = at rest). the exit plays the same pose
 * backwards. slides start fully outside the canvas (canvas size plus the larger canvas side).
 * 'flip': a 3d clip turns around its vertical axis (rotY from -90 to 0). a 2d clip has no
 * horizontal squash in the model, so it dips in scale (0.5 -> 1) while fading, which reads as a flip.
 */
function enter(id: string, p: number, W: number, H: number, threeD: boolean, o: Pose): void {
  const e = easeOutCubic(p);
  const far = Math.max(W, H);
  switch (id) {
    case 'fade':
      o.op *= p;
      break;
    case 'slide-left':
      o.dx += (W + far) * (1 - e);
      break;
    case 'slide-right':
      o.dx -= (W + far) * (1 - e);
      break;
    case 'slide-up':
      o.dy += (H + far) * (1 - e);
      break;
    case 'slide-down':
      o.dy -= (H + far) * (1 - e);
      break;
    case 'zoom-in':
      o.s *= 0.3 + 0.7 * e;
      o.op *= clamp01(p * 3);
      break;
    case 'zoom-out':
      o.s *= 1.8 - 0.8 * e;
      o.op *= clamp01(p * 3);
      break;
    case 'pop':
      o.s *= Math.max(0, easeOutBack(p));
      o.op *= clamp01(p * 4);
      break;
    case 'spin':
      o.rot -= 360 * (1 - e);
      o.op *= p;
      break;
    case 'drop':
      o.dy -= (H + far) * (1 - easeOutBounce(p));
      o.op *= clamp01(p * 6);
      break;
    case 'swing':
      o.rot += 70 * (1 - p) * Math.cos(p * 3 * Math.PI);
      o.op *= clamp01(p * 3);
      break;
    case 'flip':
      if (threeD) o.rotY -= 90 * (1 - e);
      else o.s *= 0.5 + 0.5 * e;
      o.op *= clamp01(p * 2);
      break;
  }
}

/** continuous motion at cycle phase ph (0..1) */
function loop(id: string, ph: number, W: number, H: number, o: Pose): void {
  const a = ph * TAU;
  switch (id) {
    case 'pulse':
      o.s *= 1 + 0.06 * Math.sin(a);
      break;
    case 'float':
      o.dy += 0.025 * H * Math.sin(a);
      break;
    case 'wobble':
      o.rot += 4 * Math.sin(a);
      break;
    case 'shake': {
      const step = Math.floor(ph * 12) % 12;
      o.dx += hash(step) * 0.01 * W;
      o.dy += hash(step + 17.5) * 0.01 * W;
      break;
    }
    case 'rotate':
      o.rot += 360 * ph;
      break;
    case 'swing':
      o.rot += 12 * Math.sin(a);
      break;
    case 'bounce':
      o.dy -= Math.abs(Math.sin(a / 2)) * 0.06 * H;
      break;
    case 'blink': {
      // on for the first half, off for the second, with 5% ramps on each edge
      const down = clamp01((ph - 0.45) / 0.05);
      const up = clamp01((ph - 0.95) / 0.05);
      o.op *= 1 - down + up;
      break;
    }
    case 'orbit': {
      const r = 0.04 * H;
      o.dx += r * Math.sin(a);
      o.dy -= r * Math.cos(a);
      break;
    }
  }
}

/**
 * the clip with its motions applied at a timeline time. pass the clip AFTER resolveClip (keyframes
 * baked in). returns the same object when no motion is active at that time.
 * `size` = the project canvas (slides travel relative to it).
 * motionIn plays during the first min(duration, length / 2) seconds, motionOut during the last
 * min(duration, length / 2) (the entrance backwards), motionLoop all the time with period = duration.
 * only the returned copy's transform changes. a time outside the clip counts as its nearest edge.
 */
export function applyClipMotion<T extends VisualClip>(clip: T, time: number, size: { width: number; height: number }): T {
  const mi = clip.motionIn;
  const mo = clip.motionOut;
  const ml = clip.motionLoop;
  if (!mi && !mo && !ml) return clip;
  const len = clip.duration;
  if (!(len > 0)) return clip;
  const local = Math.min(len, Math.max(0, time - clip.start));
  const W = size.width;
  const H = size.height;
  const threeD = !!clip.threeD;
  const half = len / 2;
  const o = resetPose();
  let active = false;

  if (mi && mi.duration > 0) {
    const d = Math.min(mi.duration, half);
    if (local < d) {
      enter(mi.id, local / d, W, H, threeD, o);
      active = true;
    }
  }
  if (mo && mo.duration > 0) {
    const d = Math.min(mo.duration, half);
    const left = len - local;
    if (left < d) {
      enter(mo.id, left / d, W, H, threeD, o);
      active = true;
    }
  }
  if (ml && ml.duration > 0) {
    const cycle = local / ml.duration;
    loop(ml.id, cycle - Math.floor(cycle), W, H, o);
    active = true;
  }
  if (!active) return clip;

  const t = clip.transform;
  const next = {
    ...t,
    x: t.x + o.dx,
    y: t.y + o.dy,
    scale: t.scale * o.s,
    rotation: t.rotation + o.rot,
    opacity: clamp01(t.opacity * o.op),
  };
  if (threeD && o.rotY) next.rotY = (t.rotY ?? 0) + o.rotY;
  return { ...clip, transform: next };
}
