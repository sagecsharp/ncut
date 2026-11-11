/**
 * keyframe animation. pure functions, no store, no dom.
 *
 * a clip may carry `keyframes`: for each animated property a list of keys sorted by time.
 * key times are CLIP-LOCAL seconds (0 = the clip's start on the timeline), so moving a clip moves its
 * animation with it. a property without keys simply uses the static value stored on the clip.
 *
 * every property has its OWN key list: a key on one property never adds, moves or removes a key of another.
 *
 * property names (animProps gives labels and ranges):
 *   visual clips (video, image, text, shape): x y scale scaleX scaleY scaleZ rotation opacity z rotX rotY
 *   video / audio clips:               volume
 *   effect clips:                      amount, and p.<key> for every effect param
 *   shape clips:                       drawStart drawEnd (draw on, 0..1)
 *   camera clips:                      x y z pan tilt roll fov focusDistance focusStrength
 *   the look of a visual clip is described by ONE table (LOOK_DEFS below), the same table answers animProps,
 *   baseValue, withBaseValue, valueAt, resolveClip and the store's clamping:
 *     every visual clip: radius, crop.left / top / right / bottom, adjust.brightness / contrast / saturation /
 *                        temperature / hue, chromaKey.tolerance / softness / spill, mask.x / y / width / height /
 *                        rotation / feather / radius, shapeDepth
 *     text:  fontSize letterSpacing lineHeight stroke.width stroke2.width shadow.opacity / blur / distance / angle
 *            extrude.depth / angle gradient.angle curve wrapWidth backgroundRadius backgroundPadding
 *     shape: width height points inner gradientAngle stroke.width
 *   a dotted name is a value inside an object of the clip (crop, adjust, mask ...). when that object is missing:
 *   - crop, adjust: the property is there with its neutral value (0) and writing it creates the object
 *   - mask, chromaKey, stroke, stroke2, shadow, extrude, gradient: the object being there changes what the clip is,
 *     so without it the property does not exist (baseValue is undefined, nothing can be keyed) until the user
 *     turns the feature on in the inspector
 *   - shapeDepth has no neutral number (missing = as deep as the clip is wide / tall, which needs the clip's box):
 *     its static value is undefined until written, the inspector seeds it from the thickness it shows.
 *   integer properties (points) are rounded wherever a value is read or written.
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
/**
 * the distinct key times (clip-local seconds), sorted. pass the clip's `duration` to leave out keys
 * that lie outside the clip: a trimmed or split clip keeps them so its motion stays unbroken, but
 * they are not something the user can see or jump to.
 */
export function keyTimes(kf: Keyframes | undefined, prop?: string, duration?: number): number[] {
  if (!kf) return [];
  const times: number[] = [];
  for (const [p, keys] of Object.entries(kf)) {
    if (prop !== undefined && p !== prop) continue;
    for (const k of keys) {
      if (duration !== undefined && (k.t < -KEY_EPS || k.t > duration + KEY_EPS)) continue;
      times.push(k.t);
    }
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
  /** whole numbers only (points): values are rounded when written and read */
  int?: boolean;
}

const VISUAL_PROPS: AnimPropInfo[] = [
  { prop: 'x', label: 'x', unit: 'px' },
  { prop: 'y', label: 'y', unit: 'px' },
  { prop: 'scale', label: 'scale', min: 0.01, max: 100 },
  { prop: 'scaleX', label: 'scale x', min: 0.01, max: 100 },
  { prop: 'scaleY', label: 'scale y', min: 0.01, max: 100 },
  { prop: 'scaleZ', label: 'scale z', min: 0.01, max: 100 },
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
  { prop: 'focusDistance', label: 'focus distance', min: 1, unit: 'px' },
  { prop: 'focusStrength', label: 'blur', min: 0, max: 1 },
];

/** draw on (types.ts ShapeClip.drawStart / drawEnd): shares of the outline's length */
const SHAPE_PROPS: AnimPropInfo[] = [
  ...VISUAL_PROPS,
  { prop: 'drawStart', label: 'draw from', min: 0, max: 1 },
  { prop: 'drawEnd', label: 'draw to', min: 0, max: 1 },
];
const DRAW_KEYS = new Set(['drawStart', 'drawEnd']);

const TRANSFORM_KEYS = new Set(['x', 'y', 'scale', 'scaleX', 'scaleY', 'scaleZ', 'rotation', 'opacity', 'z', 'rotX', 'rotY']);
/** transform values that are 1 when they are missing (every other one is 0) */
const TRANSFORM_ONES = new Set(['scaleX', 'scaleY', 'scaleZ']);
const CAMERA_KEYS = new Set(['x', 'y', 'z', 'pan', 'tilt', 'roll', 'fov', 'focusDistance', 'focusStrength']);

/* ---------- the look table: every other number of a visual clip ---------- */

type VisualType = 'video' | 'image' | 'text' | 'shape';
type ParentKey = 'crop' | 'adjust' | 'mask' | 'chromaKey' | 'stroke' | 'stroke2' | 'shadow' | 'extrude' | 'gradient';

interface LookDef extends AnimPropInfo {
  /** the object of the clip the value lives in. missing = a field of the clip itself */
  parent?: ParentKey;
  /** the field name (in the parent when there is one) */
  key: string;
  /** what a clip without the stored value has. missing = the neutral value of `create`, or none (see header) */
  neutral?: number | ((clip: Clip) => number);
  /** a missing parent is created like this (neutral values). missing = the parent must exist for the property to */
  create?: Readonly<Record<string, number>>;
  /** the value changes the picture the clip is drawn from (texture caches must not keep one picture for it) */
  pic?: boolean;
  /** a text style value: the text measuring / signature caches read it, so a resolved copy cannot share them */
  textStyle?: boolean;
  /** a clip without a stored value may be written (keyed) anyway */
  seed?: boolean;
}

const CROP0 = { left: 0, top: 0, right: 0, bottom: 0 } as const;
const ADJUST0 = { brightness: 0, contrast: 0, saturation: 0, hue: 0, temperature: 0 } as const;

const row = (parent: ParentKey | undefined, key: string, label: string, o: Partial<LookDef> = {}): LookDef => ({
  prop: parent ? `${parent}.${key}` : key,
  label,
  parent,
  key,
  ...o,
});

/** every visual clip. ranges are the ones the inspector fields have. */
const COMMON_DEFS: LookDef[] = [
  row(undefined, 'radius', 'corners', { min: 0, max: 1, neutral: 0 }),
  row('crop', 'left', 'crop left', { min: 0, max: 0.95, create: CROP0 }),
  row('crop', 'top', 'crop top', { min: 0, max: 0.95, create: CROP0 }),
  row('crop', 'right', 'crop right', { min: 0, max: 0.95, create: CROP0 }),
  row('crop', 'bottom', 'crop bottom', { min: 0, max: 0.95, create: CROP0 }),
  row('adjust', 'brightness', 'brightness', { min: -1, max: 1, create: ADJUST0, pic: true }),
  row('adjust', 'contrast', 'contrast', { min: -1, max: 1, create: ADJUST0, pic: true }),
  row('adjust', 'saturation', 'saturation', { min: -1, max: 1, create: ADJUST0, pic: true }),
  row('adjust', 'temperature', 'warmth', { min: -1, max: 1, create: ADJUST0, pic: true }),
  row('adjust', 'hue', 'hue', { min: -180, max: 180, unit: 'deg', create: ADJUST0, pic: true }),
  row('chromaKey', 'tolerance', 'key range', { min: 0, max: 1, pic: true }),
  row('chromaKey', 'softness', 'key soft edge', { min: 0, max: 1, pic: true }),
  row('chromaKey', 'spill', 'key clean edges', { min: 0, max: 1, pic: true }),
  row('mask', 'x', 'mask x', { min: -1, max: 1, pic: true }),
  row('mask', 'y', 'mask y', { min: -1, max: 1, pic: true }),
  row('mask', 'width', 'mask width', { min: 0, max: 2, pic: true }),
  row('mask', 'height', 'mask height', { min: 0, max: 2, pic: true }),
  row('mask', 'rotation', 'mask turn', { min: -180, max: 180, unit: 'deg', pic: true }),
  row('mask', 'feather', 'mask soft edge', { min: 0, max: 1, pic: true }),
  row('mask', 'radius', 'mask corners', { min: 0, max: 1, neutral: 0, pic: true }),
  row(undefined, 'shapeDepth', 'thickness', { min: 1, max: 10000, unit: 'px', seed: true }),
];

const TEXT_STYLE = { pic: true, textStyle: true } as const;
const TEXT_DEFS: LookDef[] = [
  row(undefined, 'fontSize', 'font size', { min: 4, max: 1000, unit: 'px', ...TEXT_STYLE }),
  row(undefined, 'letterSpacing', 'letter spacing', { min: -0.5, max: 2, neutral: 0, ...TEXT_STYLE }),
  row(undefined, 'lineHeight', 'line gap', { min: 0.5, max: 3, neutral: 1.25, ...TEXT_STYLE }),
  row('stroke', 'width', 'outline width', { min: 0.01, max: 0.5, ...TEXT_STYLE }),
  row('stroke2', 'width', '2nd outline width', { min: 0.01, max: 0.5, ...TEXT_STYLE }),
  row('shadow', 'opacity', 'shadow opacity', { min: 0, max: 1, ...TEXT_STYLE }),
  row('shadow', 'blur', 'shadow blur', { min: 0, max: 1, ...TEXT_STYLE }),
  row('shadow', 'distance', 'shadow distance', { min: 0, max: 1, ...TEXT_STYLE }),
  row('shadow', 'angle', 'shadow angle', { min: -360, max: 360, unit: 'deg', ...TEXT_STYLE }),
  row('extrude', 'depth', 'depth length', { min: 0.01, max: 1, ...TEXT_STYLE }),
  row('extrude', 'angle', 'depth angle', { min: 0, max: 360, unit: 'deg', ...TEXT_STYLE }),
  row('gradient', 'angle', 'gradient angle', { min: -360, max: 360, unit: 'deg', ...TEXT_STYLE }),
  row(undefined, 'curve', 'curve', { min: -360, max: 360, unit: 'deg', neutral: 0, ...TEXT_STYLE }),
  row(undefined, 'wrapWidth', 'wrap width', { min: 0, max: 20000, unit: 'px', neutral: 0, ...TEXT_STYLE }),
  row(undefined, 'backgroundRadius', 'box corners', { min: 0, max: 1, neutral: 0, ...TEXT_STYLE }),
  row(undefined, 'backgroundPadding', 'box padding', { min: 0, max: 2, neutral: 0.3, ...TEXT_STYLE }),
];

const SHAPE_DEFS: LookDef[] = [
  row(undefined, 'width', 'width', { min: 1, max: 20000, unit: 'px', pic: true }),
  row(undefined, 'height', 'height', { min: 1, max: 20000, unit: 'px', pic: true }),
  // missing = 6 corners, a star 5 points (shapeLogic.defaultPoints)
  row(undefined, 'points', 'points', { min: 3, max: 12, int: true, pic: true, neutral: (c) => (c.type === 'shape' && c.kind === 'star' ? 5 : 6) }),
  row(undefined, 'inner', 'inner radius', { min: 0.1, max: 0.95, neutral: 0.45, pic: true }),
  row(undefined, 'gradientAngle', 'gradient angle', { min: -360, max: 360, unit: 'deg', neutral: 90, pic: true }),
  row('stroke', 'width', 'outline width', { min: 0.5, max: 500, unit: 'px', pic: true }),
];

const LOOK_DEFS: Record<VisualType, readonly LookDef[]> = {
  video: COMMON_DEFS,
  image: COMMON_DEFS,
  text: [...COMMON_DEFS, ...TEXT_DEFS],
  shape: [...COMMON_DEFS, ...SHAPE_DEFS],
};

const LOOK_BY_PROP: Record<VisualType, ReadonlyMap<string, LookDef>> = {
  video: new Map(LOOK_DEFS.video.map((x) => [x.prop, x])),
  image: new Map(LOOK_DEFS.image.map((x) => [x.prop, x])),
  text: new Map(LOOK_DEFS.text.map((x) => [x.prop, x])),
  shape: new Map(LOOK_DEFS.shape.map((x) => [x.prop, x])),
};

/** the public part of a table row (what animProps hands out) */
function infoOf(x: LookDef): AnimPropInfo {
  const out: AnimPropInfo = { prop: x.prop, label: x.label };
  if (x.min !== undefined) out.min = x.min;
  if (x.max !== undefined) out.max = x.max;
  if (x.unit !== undefined) out.unit = x.unit;
  if (x.int) out.int = true;
  return out;
}

const LOOK_INFOS: Record<VisualType, AnimPropInfo[]> = {
  video: LOOK_DEFS.video.map(infoOf),
  image: LOOK_DEFS.image.map(infoOf),
  text: LOOK_DEFS.text.map(infoOf),
  shape: LOOK_DEFS.shape.map(infoOf),
};

const VIDEO_PROPS = [...VISUAL_PROPS, VOLUME_PROP, ...LOOK_INFOS.video];
const IMAGE_PROPS = [...VISUAL_PROPS, ...LOOK_INFOS.image];
const TEXT_PROPS = [...VISUAL_PROPS, ...LOOK_INFOS.text];
const SHAPE_ALL_PROPS = [...SHAPE_PROPS, ...LOOK_INFOS.shape];

function lookDef(clip: Clip, prop: string): LookDef | undefined {
  switch (clip.type) {
    case 'video':
    case 'image':
    case 'text':
    case 'shape':
      return LOOK_BY_PROP[clip.type].get(prop);
    default:
      return undefined;
  }
}

type Rec = Record<string, unknown>;

/** the property can be written on this clip: its parent object is there, or is made with neutral values */
function lookWritable(clip: Clip, x: LookDef): boolean {
  return !x.parent || !!x.create || !!(clip as unknown as Rec)[x.parent];
}

function lookRead(clip: Clip, x: LookDef): number | undefined {
  const c = clip as unknown as Rec;
  let stored: unknown;
  if (x.parent) {
    const o = c[x.parent] as Rec | null | undefined;
    if (!o && !x.create) return undefined;
    stored = o?.[x.key];
  } else stored = c[x.key];
  if (typeof stored === 'number') return stored;
  if (typeof x.neutral === 'function') return x.neutral(clip);
  return x.neutral ?? x.create?.[x.key];
}

function lookWrite<T extends Clip>(clip: T, x: LookDef, v: number): T {
  if (!lookWritable(clip, x)) return clip;
  const val = x.int ? Math.round(v) : v;
  if (!x.parent) return { ...clip, [x.key]: val };
  const o = (clip as unknown as Rec)[x.parent] as Rec | null | undefined;
  return { ...clip, [x.parent]: { ...(o ?? x.create), [x.key]: val } };
}

/** the built-in animatable properties of a clip (effect params are added by the caller from the effect def) */
export function animProps(clip: Clip): AnimPropInfo[] {
  switch (clip.type) {
    case 'video':
      return VIDEO_PROPS;
    case 'image':
      return IMAGE_PROPS;
    case 'text':
      return TEXT_PROPS;
    case 'shape':
      return SHAPE_ALL_PROPS;
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
      if (TRANSFORM_KEYS.has(prop)) return (clip.transform as unknown as Record<string, number | undefined>)[prop] ?? (TRANSFORM_ONES.has(prop) ? 1 : 0);
      if (prop === 'volume' && clip.type === 'video') return clip.volume;
      if (clip.type === 'shape' && DRAW_KEYS.has(prop)) return prop === 'drawStart' ? (clip.drawStart ?? 0) : (clip.drawEnd ?? 1);
      {
        const x = LOOK_BY_PROP[clip.type].get(prop);
        return x ? lookRead(clip, x) : undefined;
      }
    case 'audio':
      return prop === 'volume' ? clip.volume : undefined;
    case 'effect':
      if (prop === 'amount') return clip.amount;
      if (prop.startsWith('p.')) return clip.params[prop.slice(2)];
      return undefined;
    case 'camera':
      if (!CAMERA_KEYS.has(prop)) return undefined;
      // depth of field is off when missing. a missing focus distance stays undefined: it means "the home
      // distance", which depends on the project size (the inspector writes it down when blur is turned on).
      if (prop === 'focusStrength') return clip.focusStrength ?? 0;
      return (clip as unknown as Record<string, number | undefined>)[prop];
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
      if (clip.type === 'shape' && DRAW_KEYS.has(prop)) return { ...clip, [prop]: v };
      {
        const x = LOOK_BY_PROP[clip.type].get(prop);
        return x ? lookWrite(clip, x, v) : clip;
      }
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
  if (keys && keys.length > 0) {
    const v = evalKeys(keys, time - clip.start);
    return lookDef(clip, prop)?.int ? Math.round(v) : v;
  }
  return baseValue(clip, prop);
}

/** false for a look value whose object is missing and is not made on write (mask, outline ...): nothing to key yet */
export function canKey(clip: Clip, prop: string): boolean {
  const x = lookDef(clip, prop);
  return !x || lookWritable(clip, x);
}

/** true when a property with no stored value may be written anyway (shapeDepth: see the header) */
export function isSeedable(clip: Clip, prop: string): boolean {
  const x = lookDef(clip, prop);
  return !!x?.seed && lookWritable(clip, x);
}

/**
 * true when a key list of this clip changes the picture the clip is drawn from (color, key, mask, a text's style, a
 * shape's figure). a picture like that is new every frame: the engine must not file it under a texture key of its own.
 * crop, corner radius and thickness only move the geometry and do not count.
 */
export function animatesPicture(clip: Clip): boolean {
  const kf = clip.keyframes;
  if (!kf) return false;
  for (const prop in kf) {
    if (kf[prop]!.length === 0) continue;
    const x = lookDef(clip, prop);
    // keys of something that is switched off (no mask, no outline) do nothing until it is back
    if (x?.pic && lookWritable(clip, x)) return true;
  }
  return false;
}

/**
 * the clip as it is at a TIMELINE time: every animated property baked into its normal field.
 * returns the same object when the clip has no keyframes (the common case, no allocation), and also when none of its
 * keyed properties is one this kind of clip has. otherwise ONE copy of the clip (and one of its transform / params) with
 * every animated value written into it: the result is deeply equal to what writing the values one at a time with
 * withBaseValue gives, without cloning the whole clip once per keyed property.
 */
export function resolveClip<T extends Clip>(clip: T, time: number): T {
  const kf = clip.keyframes;
  if (!kf) return clip;
  let copy: Record<string, unknown> | null = null;
  let transform: Record<string, unknown> | null = null;
  let params: Record<string, unknown> | null = null;
  // one copy of each object (crop, adjust, mask ...) that a keyed look value is written into
  let nested: Record<string, Rec> | null = null;
  // a text style value was written: the copy no longer shares the stored clip's text caches (see rawClipOf)
  let styled = false;
  const local = time - clip.start;
  const own = (): Record<string, unknown> => (copy ??= { ...clip } as Record<string, unknown>);
  for (const prop in kf) {
    const keys = kf[prop]!;
    if (keys.length === 0) continue;
    // the same cases, in the same order, as withBaseValue
    switch (clip.type) {
      case 'video':
      case 'image':
      case 'text':
      case 'shape':
        if (TRANSFORM_KEYS.has(prop)) {
          transform ??= { ...clip.transform };
          transform[prop] = evalKeys(keys, local);
          own().transform = transform;
        } else if (prop === 'volume' && clip.type === 'video') own().volume = evalKeys(keys, local);
        else if (clip.type === 'shape' && DRAW_KEYS.has(prop)) own()[prop] = evalKeys(keys, local);
        else {
          const x = LOOK_BY_PROP[clip.type].get(prop);
          // a value in an object the clip does not have (and that is not made on write) is left alone, like withBaseValue
          if (x && lookWritable(clip, x)) {
            let v = evalKeys(keys, local);
            if (x.int) v = Math.round(v);
            if (x.textStyle) styled = true;
            if (!x.parent) own()[x.key] = v;
            else {
              nested ??= {};
              let o = nested[x.parent];
              if (!o) {
                o = nested[x.parent] = { ...((clip as unknown as Rec)[x.parent] as Rec | null | undefined ?? x.create) };
                own()[x.parent] = o;
              }
              o[x.key] = v;
            }
          }
        }
        break;
      case 'audio':
        if (prop === 'volume') own().volume = evalKeys(keys, local);
        break;
      case 'effect':
        if (prop === 'amount') own().amount = evalKeys(keys, local);
        else if (prop.startsWith('p.')) {
          params ??= { ...clip.params };
          // defineProperty: a param called __proto__ is an own key, as it is in an object literal
          Object.defineProperty(params, prop.slice(2), { value: evalKeys(keys, local), enumerable: true, writable: true, configurable: true });
          own().params = params;
        }
        break;
      case 'camera':
        if (CAMERA_KEYS.has(prop)) own()[prop] = evalKeys(keys, local);
        break;
    }
  }
  if (!copy) return clip;
  // text clips: the copy differs from the stored clip only in what is animated (transform, never text or style), so the
  // caches that are keyed by the stored clip (text measuring and signatures) can be read through it, see rawClipOf
  // (unless a text style value is keyed too: then the copy differs in what those caches read and stands on its own)
  if (clip.type === 'text' && !styled) rawOfCopy.set(copy, rawClipOf(clip));
  return copy as unknown as T;
}

/**
 * copy -> the clip it was made from, for text clips (resolveClip, applyClipMotion). the copy is a new object every frame
 * but has the same text, font and style as the stored clip: only the transform differs. text.ts reads its caches
 * (measureText, textSignature) through rawClipOf so a keyframed or moving text hits them.
 * what those caches read: text, uppercase, fontFamily, fontSize, fontWeight, italic, color, background, align,
 * letterSpacing, lineHeight, stroke, stroke2, shadow, backgroundRadius, backgroundPadding, gradient, curve, wrapWidth,
 * highlight, extrude, underline, strike, hollow, backgroundPerLine and digitRanges. none of them is written by
 * resolveClip unless a text style value is keyed (the TEXT_DEFS rows: fontSize, letterSpacing, stroke.width ...): then
 * resolveClip does not register the copy and every cache reads the copy itself (a new object each frame: the lookups
 * miss and measure again, the caches keyed by the measured values still hit, so it costs a signature per frame, not a
 * layout). what resolveClip always writes for a text is the transform, crop, adjust, mask and the like, which these caches
 * do not read. applyClipMotion writes the transform only.
 */
const rawOfCopy = new WeakMap<object, object>();

/** the stored clip a resolved text copy was made from, or the object itself when it is not one */
export function rawClipOf<T extends object>(clip: T): T {
  return (rawOfCopy.get(clip) as T | undefined) ?? clip;
}

/** say that `copy` (a text clip) is `raw` with only its transform changed */
export function noteRawClip(copy: object, raw: object): void {
  rawOfCopy.set(copy, rawClipOf(raw));
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
  // nothing to remove: hand back the same object so callers can tell
  if (prop !== undefined && !(prop in kf)) return clip;
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
