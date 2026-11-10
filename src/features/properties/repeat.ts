import type { Clip, Keyframe, Keyframes, Transform, VisualClip } from '../../types';

/** most clips a repeat makes in all (the original included) */
export const MAX_REPEAT = 32;
/** the limits the scale field of a transform uses (the store clamps to the same) */
export const REPEAT_SCALE_MIN = 0.01;
export const REPEAT_SCALE_MAX = 100;

export interface RepeatOptions {
  /** clips in all, the original included. 2 .. MAX_REPEAT */
  count: number;
  /** canvas px each copy is further than the one before */
  dx: number;
  dy: number;
  /** px each copy is further away (3d clips only) */
  dz: number;
  /** degrees per copy for a flat clip (transform.rotation) */
  rotation: number;
  /** degrees per copy for a 3d clip: tilt, turn and roll (roll is transform.rotation) */
  rotX: number;
  rotY: number;
  rotZ: number;
  /** factor per copy, multiplied: 0.9 = every copy is 90 % of the one before */
  scale: number;
  /** factor per copy, multiplied, the result is kept in 0 .. 1 */
  opacity: number;
  /** seconds each copy starts later than the one before (>= 0). the copy keeps its length. */
  delay: number;
}

export const DEFAULT_REPEAT: RepeatOptions = {
  count: 5,
  dx: 0,
  dy: 0,
  dz: 0,
  rotation: 0,
  rotX: 0,
  rotY: 0,
  rotZ: 0,
  scale: 1,
  opacity: 1,
  delay: 0,
};

export interface RepeatEntry {
  /** 1 .. count - 1 (the original is 0) */
  index: number;
  /** seconds after the original's start */
  offset: number;
  /** the static transform values that differ from the original (keyed properties are not in here) */
  transform: Partial<Transform>;
  /** the keyed properties that differ: the complete key list, every key shifted */
  keyframes: Keyframes;
}

export interface RepeatPreset {
  id: string;
  label: string;
  title: string;
  /** only for a 3d clip */
  needs3d: boolean;
  values: Partial<RepeatOptions>;
}

export const repeatPresets: RepeatPreset[] = [
  { id: 'echo', label: 'echo', title: 'echo: a few fading copies that follow a moment later', needs3d: false, values: { count: 6, opacity: 0.7, delay: 0.08 } },
  { id: 'stairs', label: 'stairs', title: 'stairs: copies climbing up to the right', needs3d: false, values: { count: 8, dx: 60, dy: -60 } },
  { id: 'tunnel', label: 'tunnel', title: 'tunnel: copies going away into the depth (3d clips only)', needs3d: true, values: { count: 12, dz: 400 } },
];

const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const clampTo = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** the count as a whole number in 1 .. MAX_REPEAT (anything that is not a number counts as 1) */
export function repeatCount(count: unknown): number {
  return clampTo(Math.floor(num(count, 1)), 1, MAX_REPEAT);
}

/** true when the copies are far enough apart in time to share one track */
export function repeatFitsOneTrack(clip: Pick<Clip, 'duration'>, delay: number): boolean {
  const d = Math.max(0, num(delay, 0));
  return d > 0 && d >= clip.duration - 1e-9;
}

interface Rule {
  prop: keyof Transform;
  step: number;
  mode: 'add' | 'mul';
  lo?: number;
  hi?: number;
}

function rulesFor(clip: VisualClip, o: RepeatOptions): Rule[] {
  const rules: Rule[] = [];
  const add = (prop: keyof Transform, step: number) => {
    if (step !== 0) rules.push({ prop, step, mode: 'add' });
  };
  add('x', num(o.dx, 0));
  add('y', num(o.dy, 0));
  if (clip.threeD) {
    add('z', num(o.dz, 0));
    add('rotX', num(o.rotX, 0));
    add('rotY', num(o.rotY, 0));
    add('rotation', num(o.rotZ, 0));
  } else {
    add('rotation', num(o.rotation, 0));
  }
  const s = num(o.scale, 1);
  if (s !== 1) rules.push({ prop: 'scale', step: Math.max(0, s), mode: 'mul', lo: REPEAT_SCALE_MIN, hi: REPEAT_SCALE_MAX });
  const a = num(o.opacity, 1);
  if (a !== 1) rules.push({ prop: 'opacity', step: Math.max(0, a), mode: 'mul', lo: 0, hi: 1 });
  return rules;
}

function stepValue(v: number, r: Rule, k: number): number {
  const out = r.mode === 'add' ? v + r.step * k : v * Math.pow(r.step, k);
  const safe = Number.isFinite(out) ? out : v;
  return r.lo !== undefined && r.hi !== undefined ? clampTo(safe, r.lo, r.hi) : safe;
}

/**
 * what each copy changes against the original. one entry per copy (index 1 .. count - 1), so count 1 (or
 * a count that is not a number) gives no entries. steps add up (copy k = original + k * step), factors
 * multiply (copy k = original * factor^k). a property with keyframes gets the step into every key, so
 * the copy moves like the original, shifted. the result never holds NaN or Infinity.
 */
export function repeatPlan(clip: VisualClip, opts: Partial<RepeatOptions>): RepeatEntry[] {
  const o: RepeatOptions = { ...DEFAULT_REPEAT, ...opts };
  const total = repeatCount(o.count);
  const delay = Math.max(0, num(o.delay, 0));
  const rules = rulesFor(clip, o);
  const tr = clip.transform as unknown as Record<string, number | undefined>;
  const out: RepeatEntry[] = [];
  for (let k = 1; k < total; k++) {
    const transform: Record<string, number> = {};
    const keyframes: Keyframes = {};
    for (const r of rules) {
      const keys = clip.keyframes?.[r.prop];
      if (keys && keys.length > 0) {
        keyframes[r.prop] = keys.map((key): Keyframe => ({ ...key, v: stepValue(key.v, r, k) }));
      } else {
        transform[r.prop] = stepValue(tr[r.prop] ?? (r.prop === 'scale' || r.prop === 'opacity' ? 1 : 0), r, k);
      }
    }
    out.push({ index: k, offset: delay * k, transform: transform as Partial<Transform>, keyframes });
  }
  return out;
}

/** a copy of the clip (same id: the caller gives it a new one) with one plan entry applied */
export function applyRepeatEntry<T extends VisualClip>(clip: T, entry: RepeatEntry): T {
  const copy = structuredClone(clip);
  copy.start = clip.start + entry.offset;
  copy.transform = { ...copy.transform, ...entry.transform };
  if (Object.keys(entry.keyframes).length > 0) copy.keyframes = { ...(copy.keyframes ?? {}), ...structuredClone(entry.keyframes) };
  return copy;
}
