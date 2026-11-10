/**
 * cascade: pure planning for "one clip after the other" on a selection (what splitting a text into
 * letters or repeating a clip leaves behind). the order the clips run in, the new starts, and the keys
 * that make a clip fly in or out. no store, no dom, so it is unit tested.
 */
import { animProps, baseValue, evalKeys, valueAt } from '../../lib/anim';
import type { Clip, Easing, Keyframe, Keyframes, VisualClip } from '../../types';
import { isTimedClip } from '../../types';
import { hash01, MIN_GAP } from './keyTools';

export type CascadeOrder = 'layer' | 'left' | 'right' | 'top' | 'center' | 'edges' | 'random';

export const CASCADE_ORDERS: { id: CascadeOrder; label: string; title: string }[] = [
  { id: 'layer', label: 'bottom layer first', title: 'the lowest track first, clips of one track by their start' },
  { id: 'left', label: 'left to right', title: 'by position on the canvas, the left one first' },
  { id: 'right', label: 'right to left', title: 'by position on the canvas, the right one first' },
  { id: 'top', label: 'top to bottom', title: 'by position on the canvas, the top one first' },
  { id: 'center', label: 'middle outwards', title: 'from the middle of the selection outwards' },
  { id: 'edges', label: 'outside in', title: 'from the outside of the selection towards the middle' },
  { id: 'random', label: 'random', title: 'a random order (the same every time you run it again)' },
];

const EPS = 1e-6;

/** a number from a string, stable (fnv-1a) */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/* ---------- order ---------- */

/**
 * the order a cascade runs in. `tracks` gives the layer: tracks[0] is the top row, so the last track is
 * the bottom layer and runs first. x / y are read in the middle of the clip (keys included), where a clip that flies in or out rests. ties keep the
 * layer order (bottom first, then by start).
 */
export function orderClips<T extends Clip>(clips: readonly T[], order: CascadeOrder, seed: number, tracks: readonly { id: string }[]): T[] {
  const layer = new Map(tracks.map((t, i) => [t.id, i]));
  const layerCmp = (a: T, b: T) => (layer.get(b.trackId) ?? 0) - (layer.get(a.trackId) ?? 0) || a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const base = [...clips].sort(layerCmp);
  if (order === 'layer' || base.length < 2) return base;
  // the middle of the clip: where it rests. its start (or end) may be the far end of a fly in / out
  const mid = (c: T) => c.start + c.duration / 2;
  const pos = new Map(base.map((c) => [c.id, { x: valueAt(c, 'x', mid(c)) ?? 0, y: valueAt(c, 'y', mid(c)) ?? 0 }]));
  const key = new Map<string, number>();
  if (order === 'left') for (const c of base) key.set(c.id, pos.get(c.id)!.x);
  else if (order === 'right') for (const c of base) key.set(c.id, -pos.get(c.id)!.x);
  else if (order === 'top') for (const c of base) key.set(c.id, pos.get(c.id)!.y);
  else if (order === 'random') for (const c of base) key.set(c.id, hash01(seed, hashString(c.id)));
  else {
    // the middle of the selection = the middle of the box around the positions
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const p of pos.values()) {
      x0 = Math.min(x0, p.x);
      x1 = Math.max(x1, p.x);
      y0 = Math.min(y0, p.y);
      y1 = Math.max(y1, p.y);
    }
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const sign = order === 'center' ? 1 : -1;
    for (const c of base) {
      const p = pos.get(c.id)!;
      key.set(c.id, sign * Math.hypot(p.x - cx, p.y - cy));
    }
  }
  // Array.prototype.sort is stable: equal keys keep the layer order of `base`
  return base.sort((a, b) => {
    const d = key.get(a.id)! - key.get(b.id)!;
    return Math.abs(d) < EPS ? 0 : d;
  });
}

/* ---------- stagger ---------- */

export type StaggerMode = 'move' | 'trim';

export interface StaggerPlace {
  id: string;
  start: number;
  duration: number;
  /** video / audio in 'trim' mode: the new source offset (the head that is cut off is skipped in the source) */
  trimStart?: number;
}

export interface StaggerLeftOut {
  id: string;
  reason: 'short';
}

export interface StaggerPlan {
  /** in the order of the cascade */
  places: StaggerPlace[];
  /** clips that would get too short in 'trim' mode */
  left: StaggerLeftOut[];
  /** ids in the order the cascade ran in */
  order: string[];
}

export interface StaggerOpts {
  mode: StaggerMode;
  seed?: number;
  tracks: readonly { id: string }[];
}

/**
 * new timeline starts. the first clip in the order keeps its start and every next one starts `stepFrames`
 * later than the one before. step 0 puts all clips at the earliest start ("line up"). 'move' keeps every
 * length. 'trim' keeps every end: the head is cut instead, so a clip never starts earlier than it did and a
 * clip that would get shorter than 2 frames is left out (and reported). places only list clips that change.
 */
export function staggerPlan(clips: readonly Clip[], order: CascadeOrder, stepFrames: number, fps: number, opts: StaggerOpts): StaggerPlan {
  const ordered = orderClips(clips, order, opts.seed ?? 1, opts.tracks);
  const plan: StaggerPlan = { places: [], left: [], order: ordered.map((c) => c.id) };
  if (ordered.length === 0) return plan;
  const rate = fps > 0 ? fps : 30;
  const step = Math.max(0, Math.round(Number.isFinite(stepFrames) ? stepFrames : 0));
  const earliest = Math.min(...ordered.map((c) => c.start));
  const first = ordered[0]!.start;
  const minLen = 2 / rate;
  ordered.forEach((c, i) => {
    const target = step === 0 ? earliest : first + (i * step) / rate;
    if (opts.mode === 'move') {
      if (Math.abs(target - c.start) > EPS) plan.places.push({ id: c.id, start: target, duration: c.duration });
      return;
    }
    const end = c.start + c.duration;
    // only the head can be cut: a clip never starts earlier than it did
    const start = Math.max(target, c.start);
    if (start - c.start <= EPS) return;
    if (end - start < minLen - EPS) {
      plan.left.push({ id: c.id, reason: 'short' });
      return;
    }
    const place: StaggerPlace = { id: c.id, start, duration: end - start };
    if (isTimedClip(c)) place.trimStart = Math.max(0, c.trimStart + (start - c.start) * c.speed);
    plan.places.push(place);
  });
  return plan;
}

/* ---------- fly ---------- */

export type FlyKind = 'scatter' | 'rise' | 'fall' | 'left' | 'right' | 'zoom' | 'spin' | 'depth';
export type FlyDirection = 'in' | 'out';

export const FLY_KINDS: { id: FlyKind; label: string; title: string }[] = [
  { id: 'scatter', label: 'scatter', title: 'from a random place, with a random turn' },
  { id: 'rise', label: 'rise', title: 'from below' },
  { id: 'fall', label: 'fall', title: 'from above' },
  { id: 'left', label: 'from left', title: 'from the left' },
  { id: 'right', label: 'from right', title: 'from the right' },
  { id: 'zoom', label: 'zoom', title: 'grows from nothing' },
  { id: 'spin', label: 'spin', title: 'a full turn' },
  { id: 'depth', label: 'depth', title: 'from far behind (3d clips; flat clips zoom)' },
];

export interface FlyOpts {
  kind: FlyKind;
  direction: FlyDirection;
  /** 0..1 */
  amount: number;
  /** seconds, clamped to the clip's length */
  duration: number;
  seed: number;
  /** project size in pixels: the distances scale with it */
  width: number;
  height: number;
}

/** how far a full strength fly starts, as a share of the project size */
const REACH = 0.6;
/** the depth of a full strength 'depth' fly, as a share of the longer side */
const DEPTH_REACH = 2;

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

/** the key list with the span [lo, hi] replaced by `fresh` (same rule as paste: keys outside stay) */
function mergeSpan(old: readonly Keyframe[] | undefined, fresh: Keyframe[], lo: number, hi: number): Keyframe[] {
  const keep = (old ?? []).filter((k) => k.t < lo - MIN_GAP || k.t > hi + MIN_GAP);
  return [...keep, ...fresh].sort((a, b) => a.t - b.t);
}

/** the ease of the segment that lies on `t` in a key list (the key at or before it) */
function easeAt(keys: readonly Keyframe[] | undefined, t: number): Easing {
  if (!keys || keys.length === 0) return 'ease';
  let e: Easing = keys[0]!.ease;
  for (const k of keys) if (k.t <= t + EPS) e = k.ease;
  return e;
}

/**
 * keys that make one clip fly in (or out). returns the new key list of every property that is touched
 * (properties that are not listed keep what they have). 'in' writes keys at local 0 and `duration`, 'out'
 * at `length - duration` and `length`. the pose at the far end of the span is what the clip has there
 * (its keys, or its static value) so a property that already moves around the span stays continuous.
 * `index` / `count` are the place of the clip in the cascade (not needed by the current kinds).
 */
export function flyPlan(clip: Clip, index: number, count: number, opts: FlyOpts): Keyframes {
  void index;
  void count;
  const props = animProps(clip);
  const can = new Map(props.map((p) => [p.prop, p]));
  // only visual clips fly
  if (!can.has('opacity')) return {};
  const len = clip.duration;
  const d = Math.min(Math.max(opts.duration, 0), len);
  if (!(d >= 2 * MIN_GAP)) return {};
  const amount = clamp01(opts.amount);
  const incoming = opts.direction === 'in';
  const lo = incoming ? 0 : len - d;
  const hi = incoming ? d : len;
  // the time the clip is at rest (the far end from the fly)
  const seam = incoming ? hi : lo;
  const seamEase = (prop: string) => easeAt(clip.keyframes?.[prop], seam);
  const rest = (prop: string): number => {
    const keys = clip.keyframes?.[prop];
    if (keys && keys.length > 0) return evalKeys(keys, seam);
    return baseValue(clip, prop) ?? 0;
  };
  const kind: FlyKind = opts.kind === 'depth' && !(clip as VisualClip).threeD ? 'zoom' : opts.kind;
  const seed = hashString(clip.id) ^ (opts.seed | 0);
  const rx = hash01(seed, 1) * 2 - 1;
  const ry = hash01(seed, 2) * 2 - 1;
  const rr = hash01(seed, 3) * 2 - 1;
  const w = Math.max(1, opts.width);
  const h = Math.max(1, opts.height);

  // property -> value of the clip when it is away (the far pose)
  const away = new Map<string, number>();
  const set = (prop: string, v: number) => {
    const info = can.get(prop);
    if (!info) return;
    let x = v;
    if (info.min !== undefined) x = Math.max(info.min, x);
    if (info.max !== undefined) x = Math.min(info.max, x);
    away.set(prop, x);
  };
  switch (kind) {
    case 'scatter': {
      // never too close to the middle: a scatter that starts where it ends is no scatter
      const sx = Math.abs(rx) < 0.25 ? (rx < 0 ? -0.25 : 0.25) : rx;
      const sy = Math.abs(ry) < 0.25 ? (ry < 0 ? -0.25 : 0.25) : ry;
      set('x', rest('x') + sx * amount * w * REACH);
      set('y', rest('y') + sy * amount * h * REACH);
      set('rotation', rest('rotation') + rr * amount * 270);
      break;
    }
    case 'rise':
      set('y', rest('y') + amount * h * REACH);
      break;
    case 'fall':
      set('y', rest('y') - amount * h * REACH);
      break;
    case 'left':
      set('x', rest('x') - amount * w * REACH);
      break;
    case 'right':
      set('x', rest('x') + amount * w * REACH);
      break;
    case 'zoom':
      // 0.01 is the smallest scale a clip can have: that is "from nothing"
      set('scale', rest('scale') * (1 - amount));
      break;
    case 'spin':
      set('rotation', rest('rotation') - amount * 360);
      break;
    case 'depth':
      set('z', rest('z') + amount * Math.max(w, h) * DEPTH_REACH);
      break;
  }
  set('opacity', 0);

  const out: Keyframes = {};
  const ease: Easing = incoming ? 'ease-out' : 'ease-in';
  for (const [prop, far] of away) {
    const r = rest(prop);
    // a property that does not move (scale of a clip that is already tiny ...) is left alone
    if (Math.abs(far - r) < 1e-9) continue;
    const fresh: Keyframe[] = incoming
      ? [
          { t: lo, v: far, ease },
          { t: hi, v: r, ease: seamEase(prop) },
        ]
      : [
          { t: lo, v: r, ease },
          { t: hi, v: far, ease: 'ease' },
        ];
    out[prop] = mergeSpan(clip.keyframes?.[prop], fresh, lo, hi);
  }
  return out;
}
