/**
 * keyframe animation. pure functions, no store, no dom.
 *
 * a clip may carry `keyframes`: for each animated property a list of keys sorted by time.
 * key times are CLIP-LOCAL seconds (0 = the clip's start on the timeline), so moving a clip moves its
 * animation with it. a property without keys simply uses the static value stored on the clip.
 *
 * property names (see ANIM_PROPS for labels and ranges):
 *   visual clips (video, image, text): x y scale rotation opacity z rotX rotY
 *   video / audio clips:               volume
 *   effect clips:                      amount, and p.<key> for every effect param
 *   camera clips:                      x y z pan tilt roll fov
 */
import type { Clip, Easing, Keyframe, Keyframes } from '../types';

export type { Easing, Keyframe, Keyframes };

export const EASINGS: { id: Easing; label: string }[] = [
  { id: 'linear', label: 'linear' },
  { id: 'ease', label: 'smooth' },
  { id: 'ease-in', label: 'ease in' },
  { id: 'ease-out', label: 'ease out' },
  { id: 'back', label: 'overshoot' },
  { id: 'bounce', label: 'bounce' },
  { id: 'elastic', label: 'elastic' },
  { id: 'hold', label: 'hold' },
];

/** two keys closer than this are the same key */
export const KEY_EPS = 1e-4;

export function applyEasing(ease: Easing, u: number): number {
  if (u <= 0) return 0;
  if (u >= 1) return ease === 'hold' ? 0 : 1;
  switch (ease) {
    case 'linear':
      return u;
    case 'ease':
      return u * u * (3 - 2 * u);
    case 'ease-in':
      return u * u * u;
    case 'ease-out': {
      const k = 1 - u;
      return 1 - k * k * k;
    }
    case 'hold':
      return 0;
    case 'back': {
      const c1 = 1.70158;
      const c3 = c1 + 1;
      const k = u - 1;
      return 1 + c3 * k * k * k + c1 * k * k;
    }
    case 'bounce': {
      const n1 = 7.5625;
      const d1 = 2.75;
      let x = u;
      if (x < 1 / d1) return n1 * x * x;
      if (x < 2 / d1) return n1 * (x -= 1.5 / d1) * x + 0.75;
      if (x < 2.5 / d1) return n1 * (x -= 2.25 / d1) * x + 0.9375;
      return n1 * (x -= 2.625 / d1) * x + 0.984375;
    }
    case 'elastic': {
      const c4 = (2 * Math.PI) / 3;
      return Math.pow(2, -10 * u) * Math.sin((u * 10 - 0.75) * c4) + 1;
    }
  }
}

/** value of a key list at a clip-local time. the list must be sorted and non-empty. */
export function evalKeys(keys: readonly Keyframe[], t: number): number {
  const n = keys.length;
  const first = keys[0]!;
  if (n === 1 || t <= first.t) return first.v;
  const last = keys[n - 1]!;
  if (t >= last.t) return last.v;
  // binary search for the segment [lo, lo + 1] containing t
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (keys[mid]!.t <= t) lo = mid;
    else hi = mid;
  }
  const a = keys[lo]!;
  const b = keys[hi]!;
  const span = b.t - a.t;
  if (span <= KEY_EPS) return b.v;
  return a.v + (b.v - a.v) * applyEasing(a.ease, (t - a.t) / span);
}

/** index of the key at time t (within tolerance), or -1 */
export function keyIndexAt(keys: readonly Keyframe[], t: number, tolerance = KEY_EPS): number {
  for (let i = 0; i < keys.length; i++) if (Math.abs(keys[i]!.t - t) <= tolerance) return i;
  return -1;
}

/** new sorted list with a key set at t (replaces a key already there, keeping its easing unless given) */
export function withKey(keys: readonly Keyframe[], t: number, v: number, ease?: Easing): Keyframe[] {
  const at = keyIndexAt(keys, t);
  if (at >= 0) {
    const next = keys.slice();
    next[at] = { t: keys[at]!.t, v, ease: ease ?? keys[at]!.ease };
    return next;
  }
  // a new key inherits the easing of the key before it so inserting in the middle keeps the feel
  let prev: Keyframe | undefined;
  for (const k of keys) if (k.t < t) prev = k;
  const next = [...keys, { t, v, ease: ease ?? prev?.ease ?? 'ease' }];
  next.sort((a, b) => a.t - b.t);
  return next;
}

export function withoutKey(keys: readonly Keyframe[], t: number, tolerance = KEY_EPS): Keyframe[] {
  const at = keyIndexAt(keys, t, tolerance);
  if (at < 0) return keys as Keyframe[];
  return keys.filter((_, i) => i !== at);
}

/** shift every key by dt (used when the clip's start moves but the animation should stay in place) */
export function shiftKeyframes(kf: Keyframes | undefined, dt: number): Keyframes | undefined {
  if (!kf || dt === 0) return kf;
  const out: Keyframes = {};
  for (const [prop, keys] of Object.entries(kf)) out[prop] = keys.map((k) => ({ ...k, t: k.t + dt }));
  return out;
}

/** every distinct key time of a clip (clip-local), sorted. for timeline markers and prev/next jumps. */
export function keyTimes(kf: Keyframes | undefined, prop?: string): number[] {
  if (!kf) return [];
  const times: number[] = [];
  for (const [p, keys] of Object.entries(kf)) {
    if (prop !== undefined && p !== prop) continue;
    for (const k of keys) times.push(k.t);
  }
  times.sort((a, b) => a - b);
  const out: number[] = [];
  for (const t of times) if (out.length === 0 || t - out[out.length - 1]! > KEY_EPS) out.push(t);
  return out;
}

/* ---------- properties ---------- */

export interface AnimPropInfo {
  prop: string;
  label: string;
  /** soft range for sliders / clamping. undefined = unbounded */
  min?: number;
  max?: number;
  unit?: string;
}

const VISUAL_PROPS: AnimPropInfo[] = [
  { prop: 'x', label: 'x', unit: 'px' },
  { prop: 'y', label: 'y', unit: 'px' },
  { prop: 'scale', label: 'scale', min: 0.01, max: 100 },
  { prop: 'rotation', label: 'rotation', unit: 'deg' },
  { prop: 'opacity', label: 'opacity', min: 0, max: 1 },
  { prop: 'z', label: 'z', unit: 'px' },
  { prop: 'rotX', label: 'tilt', unit: 'deg' },
  { prop: 'rotY', label: 'turn', unit: 'deg' },
];
const VOLUME_PROP: AnimPropInfo = { prop: 'volume', label: 'volume', min: 0, max: 2 };
const CAMERA_PROPS: AnimPropInfo[] = [
  { prop: 'x', label: 'x', unit: 'px' },
  { prop: 'y', label: 'y', unit: 'px' },
  { prop: 'z', label: 'z', unit: 'px' },
  { prop: 'pan', label: 'pan', unit: 'deg' },
  { prop: 'tilt', label: 'tilt', unit: 'deg' },
  { prop: 'roll', label: 'roll', unit: 'deg' },
  { prop: 'fov', label: 'field of view', min: 5, max: 150, unit: 'deg' },
];

const TRANSFORM_KEYS = new Set(['x', 'y', 'scale', 'rotation', 'opacity', 'z', 'rotX', 'rotY']);
const CAMERA_KEYS = new Set(['x', 'y', 'z', 'pan', 'tilt', 'roll', 'fov']);

/** the built-in animatable properties of a clip (effect params are added by the caller from the effect def) */
export function animProps(clip: Clip): AnimPropInfo[] {
  switch (clip.type) {
    case 'video':
      return [...VISUAL_PROPS, VOLUME_PROP];
    case 'image':
    case 'text':
    case 'shape':
      return VISUAL_PROPS;
    case 'audio':
      return [VOLUME_PROP];
    case 'effect':
      return [{ prop: 'amount', label: 'amount', min: 0, max: 1 }];
    case 'camera':
      return CAMERA_PROPS;
  }
}

/** the static (not animated) value of a property, or undefined when the clip has no such property */
export function baseValue(clip: Clip, prop: string): number | undefined {
  switch (clip.type) {
    case 'video':
    case 'image':
    case 'text':
    case 'shape':
      if (TRANSFORM_KEYS.has(prop)) return (clip.transform as unknown as Record<string, number | undefined>)[prop] ?? 0;
      if (prop === 'volume' && clip.type === 'video') return clip.volume;
      return undefined;
    case 'audio':
      return prop === 'volume' ? clip.volume : undefined;
    case 'effect':
      if (prop === 'amount') return clip.amount;
      if (prop.startsWith('p.')) return clip.params[prop.slice(2)];
      return undefined;
    case 'camera':
      return CAMERA_KEYS.has(prop) ? (clip as unknown as Record<string, number>)[prop] : undefined;
  }
}

/** copy of the clip with the static value of a property replaced. unknown properties return the clip unchanged. */
export function withBaseValue<T extends Clip>(clip: T, prop: string, v: number): T {
  switch (clip.type) {
    case 'video':
    case 'image':
    case 'text':
    case 'shape':
      if (TRANSFORM_KEYS.has(prop)) return { ...clip, transform: { ...clip.transform, [prop]: v } };
      if (prop === 'volume' && clip.type === 'video') return { ...clip, volume: v };
      return clip;
    case 'audio':
      return prop === 'volume' ? { ...clip, volume: v } : clip;
    case 'effect':
      if (prop === 'amount') return { ...clip, amount: v };
      if (prop.startsWith('p.')) return { ...clip, params: { ...clip.params, [prop.slice(2)]: v } };
      return clip;
    case 'camera':
      return CAMERA_KEYS.has(prop) ? { ...clip, [prop]: v } : clip;
  }
}

export function isAnimated(clip: Clip, prop: string): boolean {
  const keys = clip.keyframes?.[prop];
  return !!keys && keys.length > 0;
}

export function hasKeyframes(clip: Clip): boolean {
  const kf = clip.keyframes;
  if (!kf) return false;
  for (const k in kf) if (kf[k]!.length > 0) return true;
  return false;
}

/** value of a property at a TIMELINE time: the animated value when it has keys, else the static one */
export function valueAt(clip: Clip, prop: string, time: number): number | undefined {
  const keys = clip.keyframes?.[prop];
  if (keys && keys.length > 0) return evalKeys(keys, time - clip.start);
  return baseValue(clip, prop);
}

/**
 * the clip as it is at a TIMELINE time: every animated property baked into its normal field.
 * returns the same object when the clip has no keyframes (the common case, no allocation).
 */
export function resolveClip<T extends Clip>(clip: T, time: number): T {
  const kf = clip.keyframes;
  if (!kf) return clip;
  let out: T = clip;
  const local = time - clip.start;
  for (const prop in kf) {
    const keys = kf[prop]!;
    if (keys.length === 0) continue;
    out = withBaseValue(out, prop, evalKeys(keys, local));
  }
  return out;
}

/**
 * set a property at a timeline time the way an editor expects: when the property is animated the
 * value goes into a key at that time (created if needed), otherwise into the static field.
 */
export function withValueAt<T extends Clip>(clip: T, prop: string, time: number, v: number): T {
  const keys = clip.keyframes?.[prop];
  if (keys && keys.length > 0) {
    return { ...clip, keyframes: { ...clip.keyframes, [prop]: withKey(keys, time - clip.start, v) } };
  }
  return withBaseValue(clip, prop, v);
}

/** add (or update) a key holding the property's current value at a timeline time */
export function withKeyAt<T extends Clip>(clip: T, prop: string, time: number, v?: number, ease?: Easing): T {
  const value = v ?? valueAt(clip, prop, time);
  if (value === undefined) return clip;
  const keys = clip.keyframes?.[prop] ?? [];
  return { ...clip, keyframes: { ...clip.keyframes, [prop]: withKey(keys, time - clip.start, value, ease) } };
}

/**
 * remove the key at a timeline time. when the last key goes the property becomes static again and
 * keeps the value it had.
 */
export function withoutKeyAt<T extends Clip>(clip: T, prop: string, time: number, tolerance = KEY_EPS): T {
  const keys = clip.keyframes?.[prop];
  if (!keys || keys.length === 0) return clip;
  const next = withoutKey(keys, time - clip.start, tolerance);
  if (next === keys) return clip;
  const kf: Keyframes = { ...clip.keyframes };
  if (next.length > 0) {
    kf[prop] = next;
    return { ...clip, keyframes: kf };
  }
  const held = evalKeys(keys, time - clip.start);
  delete kf[prop];
  const cleared = { ...clip, keyframes: Object.keys(kf).length > 0 ? kf : undefined } as T;
  return withBaseValue(cleared, prop, held);
}

/** drop all keys of one property (or of every property). values freeze at what they are at `time`. */
export function withoutKeys<T extends Clip>(clip: T, time: number, prop?: string): T {
  const kf = clip.keyframes;
  if (!kf) return clip;
  let out = clip;
  const rest: Keyframes = {};
  for (const [p, keys] of Object.entries(kf)) {
    if (prop !== undefined && p !== prop) {
      rest[p] = keys;
      continue;
    }
    if (keys.length > 0) out = withBaseValue(out, p, evalKeys(keys, time - clip.start));
  }
  return { ...out, keyframes: Object.keys(rest).length > 0 ? rest : undefined };
}
