/**
 * cascade: pure planning for "one clip after the other" on a selection (what splitting a text into
 * letters or repeating a clip leaves behind). the order the clips run in, the new starts, and the keys
 * that make a clip fly in or out. no store, no dom, so it is unit tested.
 */
import { animProps, baseValue, evalKeys, valueAt } from '../../lib/anim';
import type { Clip, Easing, Keyframe, Keyframes, VisualClip } from '../../types';
import { MIN_CLIP_DURATION, isTimedClip, isVisualClip } from '../../types';
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
export function orderClips<T extends Clip>(
  clips: readonly T[],
  order: CascadeOrder,
  seed: number,
  tracks: readonly { id: string }[],
  /** where a clip is on the canvas (attached clips: in the world, not under their parent). default: its own x / y */
  where?: (clip: T, time: number) => { x: number; y: number } | null | undefined,
): T[] {
  const layer = new Map(tracks.map((t, i) => [t.id, i]));
  const layerCmp = (a: T, b: T) => (layer.get(b.trackId) ?? 0) - (layer.get(a.trackId) ?? 0) || a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const base = [...clips].sort(layerCmp);
  if (order === 'layer' || base.length < 2) return base;
  // the middle of the clip: where it rests. its start (or end) may be the far end of a fly in / out
  const mid = (c: T) => c.start + c.duration / 2;
  // only clips that are somewhere on the canvas take part in the position orders. a sound (or an effect, a camera)
  // has no place: it goes first, in layer order, and does not pull the middle of the selection toward 0, 0
  const placed = order === 'random' ? base : base.filter((c) => isVisualClip(c));
  const pos = new Map(placed.map((c) => [c.id, where?.(c, mid(c)) ?? { x: valueAt(c, 'x', mid(c)) ?? 0, y: valueAt(c, 'y', mid(c)) ?? 0 }]));
  const key = new Map<string, number>();
  if (order === 'left') for (const c of placed) key.set(c.id, pos.get(c.id)!.x);
  else if (order === 'right') for (const c of placed) key.set(c.id, -pos.get(c.id)!.x);
  else if (order === 'top') for (const c of placed) key.set(c.id, pos.get(c.id)!.y);
  else if (order === 'random') for (const c of placed) key.set(c.id, hash01(seed, hashString(c.id)));
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
    for (const c of placed) {
      const p = pos.get(c.id)!;
      key.set(c.id, sign * Math.hypot(p.x - cx, p.y - cy));
    }
  }
  // Array.prototype.sort is stable: equal keys keep the layer order of `base`
  return base.sort((a, b) => {
    const ka = key.get(a.id);
    const kb = key.get(b.id);
    if (ka === undefined || kb === undefined) return ka === kb ? 0 : ka === undefined ? -1 : 1;
    const d = ka - kb;
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
  where?: (clip: Clip, time: number) => { x: number; y: number } | null | undefined;
}

/**
 * the sound of a video: an audio clip grouped with a video clip that has the same start (the lengths may
 * differ: a picture whose tail was trimmed still has its sound). it is no member of the cascade, it goes where
 * its picture goes. follower id -> its picture. texts, shapes, effects and cameras never get a sound (music
 * grouped with letters stays a member of its own); one lone still grouped with a sound does (a picture with a
 * voice over). when a group has several videos at that start, an audio
 * goes to the one with the same asset (an extracted audio keeps the asset of its video), then the same
 * trimStart and speed, and two audios of different assets never share a picture while another is free.
 */
export function soundOf(clips: readonly Clip[]): Map<string, Clip> {
  const lead = new Map<string, Clip>();
  // picture id -> assets of the audios that already follow it
  const claims = new Map<string, string[]>();
  const claim = (pic: Clip, audio: Clip) => {
    lead.set(audio.id, pic);
    const list = claims.get(pic.id) ?? [];
    list.push(audio.type === 'audio' ? audio.assetId : '');
    claims.set(pic.id, list);
  };
  const sameCut = (pic: Clip, audio: Clip) => isTimedClip(pic) && audio.type === 'audio' && Math.abs(pic.trimStart - audio.trimStart) < EPS && Math.abs(pic.speed - audio.speed) < EPS;
  const pending: { audio: Clip; cands: Clip[] }[] = [];
  // first the audios that have a picture of their own asset
  for (const c of clips) {
    if (c.type !== 'audio' || !c.group) continue;
    const mates = clips.filter((o) => o.type !== 'audio' && o.group === c.group && Math.abs(o.start - c.start) < EPS);
    let cands: Clip[] = mates.filter((o) => o.type === 'video');
    if (cands.length === 0 && mates.length === 1 && mates[0]!.type === 'image') cands = mates;
    if (cands.length === 0) continue;
    const own = cands.filter((o) => 'assetId' in o && o.assetId === c.assetId);
    if (own.length === 0) {
      pending.push({ audio: c, cands });
      continue;
    }
    let best = own[0]!;
    let bestKey = Infinity;
    own.forEach((o, i) => {
      const key = (sameCut(o, c) ? 0 : 1e6) + (claims.get(o.id)?.length ?? 0) * 1e3 + i;
      if (key < bestKey) {
        bestKey = key;
        best = o;
      }
    });
    claim(best, c);
  }
  // the rest: the first picture that has no sound of another asset yet (else the first one)
  for (const { audio, cands } of pending) {
    const asset = audio.type === 'audio' ? audio.assetId : '';
    const free = cands.find((o) => (claims.get(o.id) ?? []).every((a) => a === asset)) ?? cands[0]!;
    claim(free, audio);
  }
  return lead;
}

/**
 * new timeline starts. the first clip in the order keeps its start and every next one starts `stepFrames`
 * later than the one before. step 0 puts all clips at the earliest start ("line up"). 'move' keeps every
 * length. 'trim' keeps every end: the head is cut instead, so a clip never starts earlier than it did and a
 * clip that would get shorter than 2 frames is left out (and reported). "line up" in 'trim' mode cuts every
 * head to the LATEST start (the only place all of them can reach). places only list clips that change.
 * the sound of a video (see soundOf) is placed with its picture.
 */
export function staggerPlan(clips: readonly Clip[], order: CascadeOrder, stepFrames: number, fps: number, opts: StaggerOpts): StaggerPlan {
  const lead = soundOf(clips);
  const leaders = orderClips(
    clips.filter((c) => !lead.has(c.id)),
    order,
    opts.seed ?? 1,
    opts.tracks,
    opts.where,
  );
  // every picture is followed by its sound, at the same place in the cascade
  const ordered: { clip: Clip; slot: number }[] = [];
  leaders.forEach((c, slot) => {
    ordered.push({ clip: c, slot });
    for (const f of clips) if (lead.get(f.id) === c) ordered.push({ clip: f, slot });
  });
  const plan: StaggerPlan = { places: [], left: [], order: ordered.map((o) => o.clip.id) };
  if (ordered.length === 0) return plan;
  const rate = fps > 0 ? fps : 30;
  const step = Math.max(0, Math.round(Number.isFinite(stepFrames) ? stepFrames : 0));
  const starts = ordered.map((o) => o.clip.start);
  const lineUp = opts.mode === 'trim' ? Math.max(...starts) : Math.min(...starts);
  const first = ordered[0]!.clip.start;
  // the store never makes a clip shorter than this either
  const minLen = Math.max(2 / rate, MIN_CLIP_DURATION);
  if (opts.mode === 'move') {
    for (const { clip: c, slot: i } of ordered) {
      const target = step === 0 ? lineUp : first + (i * step) / rate;
      if (Math.abs(target - c.start) > EPS) plan.places.push({ id: c.id, start: target, duration: c.duration });
    }
    return plan;
  }
  // 'trim': a picture and its sound are cut by the same amount or not at all (one that would get too short
  // keeps the pair where it is, and every clip of the pair is counted as left out)
  const slots = new Map<number, { clip: Clip; slot: number }[]>();
  for (const o of ordered) {
    const list = slots.get(o.slot) ?? [];
    list.push(o);
    slots.set(o.slot, list);
  }
  for (const members of slots.values()) {
    const target = step === 0 ? lineUp : first + (members[0]!.slot * step) / rate;
    const places: StaggerPlace[] = [];
    let tooShort = false;
    for (const { clip: c } of members) {
      const end = c.start + c.duration;
      // only the head can be cut: a clip never starts earlier than it did
      const start = Math.max(target, c.start);
      if (start - c.start <= EPS) continue;
      if (end - start < minLen - EPS) {
        tooShort = true;
        continue;
      }
      const place: StaggerPlace = { id: c.id, start, duration: end - start };
      if (isTimedClip(c)) place.trimStart = Math.max(0, c.trimStart + (start - c.start) * c.speed);
      places.push(place);
    }
    if (tooShort) for (const { clip: c } of members) plan.left.push({ id: c.id, reason: 'short' });
    else plan.places.push(...places);
  }
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

/** the properties a fly may write */
const FLY_PROPS = ['x', 'y', 'z', 'rotation', 'scale', 'opacity'];

/** two fly spans count as one fly when their ends differ by less than this (seconds) */
const SPAN_TOL = 0.01;
/** a fly is never longer than max(half the clip, this): longer motions are the user's own animation */
const FLY_SPAN_CAP = 3;

interface Span {
  a: number;
  b: number;
}

/**
 * the shape one key list has after a fly on this side: the first key at 0 (or before it) easing out (in), or the
 * last key at the end (or behind it) with an ease in key before it (out). returns the span of the two keys, or null.
 */
function flyShape(keys: readonly Keyframe[] | undefined, incoming: boolean, len: number): Span | null {
  if (!keys || keys.length < 2) return null;
  if (incoming) {
    const k0 = keys[0]!;
    const k1 = keys[1]!;
    // a head trim or a split leaves the far key before the clip starts: the same fly while its rest key is inside
    return k0.t <= EPS && k1.t > EPS && k0.ease === 'ease-out' ? { a: k0.t, b: k1.t } : null;
  }
  const k0 = keys[keys.length - 2]!;
  const k1 = keys[keys.length - 1]!;
  // a tail trim or a split leaves the far key behind the end
  return k1.t >= len - EPS && k0.t < len - EPS && k0.ease === 'ease-in' ? { a: k0.t, b: k1.t } : null;
}

/**
 * the span of an earlier fly on this side. every fly writes opacity, so only an opacity track with the fly
 * shape (and a short span) counts: a user animation that merely looks like one on x or y is not a fly.
 */
function flyOf(clip: Clip, incoming: boolean, len: number): Span | null {
  const sp = flyShape(clip.keyframes?.opacity, incoming, len);
  return sp && sp.b - sp.a <= Math.max(len / 2, FLY_SPAN_CAP) + EPS ? sp : null;
}

/** the span of the fly on one property: its keys have the fly shape AND the same span as the fly (`ref`) */
function propFly(keys: readonly Keyframe[] | undefined, incoming: boolean, len: number, ref: Span | null): Span | null {
  if (!ref) return null;
  const sp = flyShape(keys, incoming, len);
  return sp && Math.abs(sp.a - ref.a) <= SPAN_TOL && Math.abs(sp.b - ref.b) <= SPAN_TOL ? sp : null;
}

/** the ease of the segment that lies on `t` in a key list (the key at or before it) */
function easeAt(keys: readonly Keyframe[] | undefined, t: number): Easing {
  if (!keys || keys.length === 0) return 'ease';
  let e: Easing = keys[0]!.ease;
  for (const k of keys) if (k.t <= t + EPS) e = k.ease;
  return e;
}

export interface FlyResult {
  /** the new key list of every property that is touched (the others keep what they have) */
  keys: Keyframes;
  /** properties of `keys` that end up with fewer than 2 keys: they are no animation any more. the value is their rest value */
  unkeyed: { prop: string; value: number }[];
}

/**
 * keys that make one clip fly in (or out). returns the new key list of every property that is touched
 * (properties that are not listed keep what they have). 'in' writes keys at local 0 and `duration`, 'out'
 * at `length - duration` and `length`. the pose at the far end of the span is what the clip has there
 * (its keys, or its static value) so a property that already moves around the span stays continuous.
 * a fly that is already there on the same side is replaced, not stacked: its keys go (also on properties the
 * new kind does not use, a scatter followed by a rise only rises) and the rest pose is read behind it.
 * an earlier fly is only recognised when the opacity track AND the property have its shape with the same
 * span, so a slide the user keyed by hand is kept. a fly on the other side that touches or overlaps the new
 * one gives the rest pose (from its own inner key); when both cannot fit each gets at most half the clip.
 * `index` / `count` are the place of the clip in the cascade (not needed by the current kinds).
 */
export function flyPlan(clip: Clip, index: number, count: number, opts: FlyOpts): Keyframes {
  return flyPlanFull(clip, index, count, opts).keys;
}

/** flyPlan with the properties that stop being animated (see FlyResult.unkeyed) */
export function flyPlanFull(clip: Clip, index: number, count: number, opts: FlyOpts): FlyResult {
  void index;
  void count;
  const none: FlyResult = { keys: {}, unkeyed: [] };
  const props = animProps(clip);
  const can = new Map(props.map((p) => [p.prop, p]));
  // only visual clips fly
  if (!can.has('opacity')) return none;
  const len = clip.duration;
  let d = Math.min(Math.max(opts.duration, 0), len);
  if (!(d >= 2 * MIN_GAP)) return none;
  const amount = clamp01(opts.amount);
  const incoming = opts.direction === 'in';

  // an earlier fly on this side (replaced) and one on the other side (kept, may touch this one)
  const same = flyOf(clip, incoming, len);
  const other = flyOf(clip, !incoming, len);
  // the other fly touches this one when its inner key is inside or at the edge of the new span
  // (also when the fly that is replaced reached it: the two share their rest key)
  const shared = !!other && !!same && (incoming ? Math.abs(same.b - other.a) <= MIN_GAP : Math.abs(same.a - other.b) <= MIN_GAP);
  const touches = !!other && (shared || (incoming ? other.a <= d + MIN_GAP : other.b >= len - d - MIN_GAP));
  const overlaps = !!other && (incoming ? other.a < d - MIN_GAP : other.b > len - d + MIN_GAP);
  const half = len / 2;
  // keys of the other fly that move to the middle of the clip so both flies fit
  const retimed = new Map<string, Keyframe[]>();
  if (overlaps && other) {
    d = Math.min(d, half);
    if (!(d >= 2 * MIN_GAP)) return none;
    for (const prop of FLY_PROPS) {
      const keys = clip.keyframes?.[prop];
      if (!keys || !propFly(keys, !incoming, len, other)) continue;
      const at = incoming ? keys.length - 2 : 1;
      const inner = keys[at]!;
      // keys between the old and the new place of the inner key would end up inside that fly: they go, like in any rewritten span
      const between = (k: Keyframe) => (incoming ? k.t >= half - MIN_GAP && k.t < inner.t : k.t > inner.t && k.t <= half + MIN_GAP);
      retimed.set(
        prop,
        keys.filter((k) => k === inner || !between(k)).map((k) => (k === inner ? { ...k, t: half } : k)),
      );
    }
  }
  const lo = incoming ? 0 : len - d;
  const hi = incoming ? d : len;
  const keysOf = (prop: string): readonly Keyframe[] | undefined => retimed.get(prop) ?? clip.keyframes?.[prop];
  // the earlier fly of this side on a property
  const oldOf = (prop: string): Span | null => propFly(clip.keyframes?.[prop], incoming, len, same);
  // the span that is rewritten on a property: the new fly, widened to an earlier fly on this side
  const zone = (prop: string): Span => {
    const old = oldOf(prop);
    const z = old ? { a: Math.min(lo, old.a), b: Math.max(hi, old.b) } : { a: lo, b: hi };
    // never into a fly of the other side: its inner key (the rest key the two may share) stays where it is,
    // so a shorter fly here does not make the other one longer
    const o = other && !overlaps ? propFly(clip.keyframes?.[prop], !incoming, len, other) : null;
    if (o) {
      if (incoming) z.b = Math.min(z.b, Math.max(hi, o.a - 2 * MIN_GAP));
      else z.a = Math.max(z.a, Math.min(lo, o.b + 2 * MIN_GAP));
    }
    return z;
  };
  // the time the clip is at rest (the far end from the fly, behind an earlier fly)
  const seamOf = (prop: string): number => (incoming ? zone(prop).b : zone(prop).a);
  const seamEase = (prop: string) => easeAt(keysOf(prop), seamOf(prop));
  const rest = (prop: string): number => {
    const keys = clip.keyframes?.[prop];
    if (touches && other && keys) {
      // next to a fly of the other side: its own rest key (at its inner end) is the rest pose, never its far pose
      const o = propFly(keys, !incoming, len, other);
      if (o) return evalKeys(keys, incoming ? o.a : o.b);
    }
    if (keys && keys.length > 0) return evalKeys(keys, seamOf(prop));
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
  const unkeyed: { prop: string; value: number }[] = [];
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
    const z = zone(prop);
    out[prop] = mergeSpan(keysOf(prop), fresh, z.a, z.b);
  }
  // what an earlier fly of another kind left on this side goes: its far key is removed, the rest key stays
  // (only on properties that carry that fly: same shape, same span)
  for (const prop of FLY_PROPS) {
    if (prop in out || !oldOf(prop)) continue;
    const keys = keysOf(prop)!;
    const left = incoming ? keys.slice(1) : keys.slice(0, -1);
    out[prop] = left;
    if (left.length < 2) unkeyed.push({ prop, value: left[0]!.v });
  }
  // keys of the other fly that moved to the middle, on properties this fly did not write
  for (const [prop, list] of retimed) if (!(prop in out)) out[prop] = list;
  return { keys: out, unkeyed };
}
