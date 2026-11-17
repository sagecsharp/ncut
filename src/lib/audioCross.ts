/**
 * sound crossfades and fade shapes. pure. the data rules, the shape math, the spans, rooms and the gain rule.
 * never imports lib/mix.ts: mix.ts imports this file.
 */
import type { AudioClip, Clip, Crossfade, FadeShape, MediaAsset, Project, VideoClip } from '../types';
import { isFadeShape, MAX_CROSSFADE_SIDE } from '../types';
import { isAnimated, keyTimes, valueAt } from './anim';
import { hasSoundApart } from './soundPair';
import { CUT_EPS, transitionSpan } from './transitions';
import { clipEnd } from './timelineOps';

export const SHAPE_STEPS = 32, PLAY_MIN = 1e-3;
export const SHAPE_NAME: Record<FadeShape, string> = { power: 'equal power', linear: 'linear', smooth: 'smooth' };
export type CrossShort = 'media' | 'half' | 'longest';
export interface CrossSpan { start: number; end: number; edit: number; shape: FadeShape }
export interface ClipSound { head: number; tail: number; xin: CrossSpan | null; xout: CrossSpan | null; inShape: FadeShape; outShape: FadeShape }
export interface CrossfadeSpan extends CrossSpan {
  fromId: string; toId: string; trackId: string;
  before: number; after: number; wantBefore: number; wantAfter: number; roomBefore: number; roomAfter: number;
  shortBefore: CrossShort | null; shortAfter: CrossShort | null; withTransition: boolean; plays: boolean;
}
export const EMPTY_SOUNDS: ReadonlyMap<string, ClipSound> = new Map();

/** 0..1 -> 0..1 rising: exactly 0 at or below 0 (NaN too), exactly 1 at or above 1. missing = linear */
export function shapeIn(shape: FadeShape | null | undefined, u: number): number {
  if (!(u > 0)) return 0;
  if (u >= 1) return 1;
  if (shape === 'power') return Math.sin((u * Math.PI) / 2);
  if (shape === 'smooth') return 0.5 - 0.5 * Math.cos(u * Math.PI);
  return u;
}

/** a stored shape, or the fallback for a missing or unknown one */
export function readShape(v: unknown, fallback: FadeShape): FadeShape {
  return isFadeShape(v) ? v : fallback;
}

/** a fade shape to store: only 'power' and 'smooth' (linear is the old fade, no field), else null */
export function cleanFadeShape(v: unknown): 'power' | 'smooth' | null {
  return v === 'power' || v === 'smooth' ? v : null;
}

const side = (x: unknown): number => {
  const n = typeof x === 'number' && Number.isFinite(x) ? Math.min(MAX_CROSSFADE_SIDE, Math.max(0, x)) : 0;
  return Math.round(n * 1e6) / 1e6;
};

/** a crossfade to store: sides 0..10 s rounded to 1e-6, a sum under 0.001 is none, a shape only for linear and smooth, withTransition only as true */
export function cleanCrossfade(v: unknown): Crossfade | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const before = side(o.before);
  const after = side(o.after);
  if (before + after < 0.001) return null;
  const out: Crossfade = { before, after };
  if (o.shape === 'linear' || o.shape === 'smooth') out.shape = o.shape;
  if (o.withTransition === true) out.withTransition = true;
  return out;
}

/** both missing, or equal before, after, shape (missing = 'power') and withTransition */
export function sameCrossfade(a: Crossfade | null | undefined, b: Crossfade | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.before === b.before && a.after === b.after && (a.shape ?? 'power') === (b.shape ?? 'power') && !!a.withTransition === !!b.withTransition;
}

/* ---------- spans, rooms and the gain rule ---------- */

const GAIN_STEP = 0.01, KEY_SNAP = 0.0005;
type SoundClip = VideoClip | AudioClip;
const isSoundType = (c: Clip): c is SoundClip => c.type === 'video' || c.type === 'audio';

interface TrackIndex { byStart: SoundClip[]; byEnd: SoundClip[] }
interface SoundBase { assets: Map<string, MediaAsset>; byId: Map<string, SoundClip>; tracks: Map<string, TrackIndex> }
const baseCache = new WeakMap<Project, SoundBase>();

function baseOf(p: Project): SoundBase {
  const hit = baseCache.get(p);
  if (hit) return hit;
  const assets = new Map<string, MediaAsset>();
  for (const a of p.assets) assets.set(a.id, a);
  const byId = new Map<string, SoundClip>();
  const tracks = new Map<string, TrackIndex>();
  for (const c of p.clips) {
    if (!isSoundType(c)) continue;
    byId.set(c.id, c);
    const t = tracks.get(c.trackId);
    if (t) t.byStart.push(c);
    else tracks.set(c.trackId, { byStart: [c], byEnd: [] });
  }
  for (const t of tracks.values()) {
    t.byEnd = t.byStart.slice().sort((a, b) => clipEnd(a) - clipEnd(b));
    t.byStart.sort((a, b) => a.start - b.start);
  }
  const base = { assets, byId, tracks };
  baseCache.set(p, base);
  return base;
}

/** the clip of the sorted list whose key is within CUT_EPS of at, the nearest when two are. never the clip skip */
function near(list: SoundClip[], key: (c: SoundClip) => number, at: number, skip: string): SoundClip | null {
  let lo = 0, hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (key(list[mid]) < at - CUT_EPS) lo = mid + 1;
    else hi = mid;
  }
  let best: SoundClip | null = null, bestD = Infinity;
  for (let i = lo; i < list.length; i++) {
    const k = key(list[i]);
    if (k > at + CUT_EPS) break;
    const d = Math.abs(k - at);
    if (list[i].id !== skip && d < bestD) { best = list[i]; bestD = d; }
  }
  return best;
}

/** the clip with sound that ends where c starts, on its track */
export function soundBefore(p: Project, c: Clip): VideoClip | AudioClip | null {
  const t = baseOf(p).tracks.get(c.trackId);
  return t ? near(t.byEnd, clipEnd, c.start, c.id) : null;
}

/** the clip with sound that starts where c ends, on its track */
export function soundAfter(p: Project, c: Clip): VideoClip | AudioClip | null {
  const t = baseOf(p).tracks.get(c.trackId);
  return t ? near(t.byStart, (x) => x.start, clipEnd(c), c.id) : null;
}

/** an audio clip, or a video clip not apart whose media has audio */
export function hasSound(p: Project, c: Clip): boolean {
  if (c.type !== 'audio' && c.type !== 'video') return false;
  const asset = baseOf(p).assets.get(c.assetId);
  return !!asset?.hasAudio && (c.type === 'audio' || !hasSoundApart(p.clips, c.id));
}

/** timeline seconds of media before the clip's first frame */
export function headRoom(c: VideoClip | AudioClip): number {
  return Math.max(0, c.trimStart) / c.speed;
}

/** timeline seconds of media after the clip's last frame */
export function tailRoom(p: Project, c: VideoClip | AudioClip): number {
  const dur = baseOf(p).assets.get(c.assetId)?.duration;
  if (typeof dur !== 'number' || !Number.isFinite(dur) || !(dur > 0)) return 0;
  return Math.max(0, dur - (Math.max(0, c.trimStart) + c.duration * c.speed)) / c.speed;
}

// media first: when the media room is at most both other limits it is the reason, else half the clip, else the longest side
const why = (media: number, half: number): CrossShort => (media <= Math.min(half, MAX_CROSSFADE_SIDE) ? 'media' : half <= MAX_CROSSFADE_SIDE ? 'half' : 'longest');

export function crossfadeRoom(p: Project, toId: string): { fromId: string; before: number; after: number; whyBefore: CrossShort; whyAfter: CrossShort } | null {
  const to = baseOf(p).byId.get(toId);
  if (!to) return null;
  const from = soundBefore(p, to);
  if (!from || !hasSound(p, to) || !hasSound(p, from)) return null;
  const mediaB = headRoom(to), mediaA = tailRoom(p, from);
  const halfB = from.duration / 2, halfA = to.duration / 2;
  return {
    fromId: from.id,
    before: Math.min(MAX_CROSSFADE_SIDE, mediaB, halfB), after: Math.min(MAX_CROSSFADE_SIDE, mediaA, halfA),
    whyBefore: why(mediaB, halfB), whyAfter: why(mediaA, halfA),
  };
}

const spanCache = new WeakMap<Project, Map<string, { clip: Clip; span: CrossfadeSpan | null }>>();

export function crossfadeSpan(p: Project, to: Clip): CrossfadeSpan | null {
  let per = spanCache.get(p);
  if (!per) {
    per = new Map();
    spanCache.set(p, per);
  }
  const hit = per.get(to.id);
  // the clip object is checked too: a caller may pass an edited copy of a clip of the project
  if (hit && hit.clip === to) return hit.span;
  const span = computeSpan(p, to);
  per.set(to.id, { clip: to, span });
  return span;
}

function computeSpan(p: Project, to: Clip): CrossfadeSpan | null {
  if (to.type !== 'video' && to.type !== 'audio') return null;
  const want = cleanCrossfade(to.crossfade);
  const room = want ? crossfadeRoom(p, to.id) : null;
  if (!want || !room) return null;
  let wb = want.before, wa = want.after;
  if (want.withTransition && to.type === 'video') {
    const ts = transitionSpan(p, to);
    if (ts && ts.from) { wb = to.start - ts.start; wa = ts.end - to.start; }
  }
  const before = Math.min(wb, room.before), after = Math.min(wa, room.after), edit = to.start;
  return {
    start: edit - before, end: edit + after, edit, shape: readShape(want.shape, 'power'),
    fromId: room.fromId, toId: to.id, trackId: to.trackId, before, after, wantBefore: wb, wantAfter: wa,
    roomBefore: room.before, roomAfter: room.after,
    shortBefore: wb > room.before + 1e-6 ? room.whyBefore : null, shortAfter: wa > room.after + 1e-6 ? room.whyAfter : null,
    withTransition: !!want.withTransition, plays: before + after >= PLAY_MIN,
  };
}

const soundCache = new WeakMap<Project, ReadonlyMap<string, ClipSound>>();

/** the clips in a playing crossfade or with a shaped fade. one shared empty map for every other project */
export function soundIndex(p: Project): ReadonlyMap<string, ClipSound> {
  const hit = soundCache.get(p);
  if (hit) return hit;
  let any = false;
  for (const c of p.clips) {
    if (c.type !== 'video' && c.type !== 'audio') continue;
    if (c.crossfade || cleanFadeShape(c.fadeInShape) || cleanFadeShape(c.fadeOutShape)) { any = true; break; }
  }
  const out = any ? buildSounds(p) : EMPTY_SOUNDS;
  soundCache.set(p, out);
  return out;
}

function buildSounds(p: Project): ReadonlyMap<string, ClipSound> {
  const base = baseOf(p);
  const map = new Map<string, ClipSound>();
  const entry = (c: SoundClip): ClipSound => {
    let s = map.get(c.id);
    if (!s) {
      s = { head: 0, tail: 0, xin: null, xout: null, inShape: readShape(c.fadeInShape, 'linear'), outShape: readShape(c.fadeOutShape, 'linear') };
      map.set(c.id, s);
    }
    return s;
  };
  for (const c of base.byId.values()) {
    if (c.crossfade) {
      const span = crossfadeSpan(p, c);
      const from = span && span.plays ? base.byId.get(span.fromId) : undefined;
      if (span && from) {
        const a = entry(c), b = entry(from);
        a.head = span.before;
        a.xin = span;
        b.tail = span.after;
        b.xout = span;
      }
    }
    const shaped = (c.fadeIn > 0 && !!cleanFadeShape(c.fadeInShape)) || (c.fadeOut > 0 && !!cleanFadeShape(c.fadeOutShape));
    if (shaped && hasSound(p, c)) entry(c);
  }
  return map.size > 0 ? map : EMPTY_SOUNDS;
}

/** volume x own fades x crossfades. 0 outside [start - head, end + tail]. volume read at the time held inside the clip */
export function soundGainAt(c: VideoClip | AudioClip, s: ClipSound, time: number): number {
  if (time < c.start - s.head || time > c.start + c.duration + s.tail) return 0;
  const vt = Math.min(c.start + c.duration, Math.max(c.start, time));
  const vol = Math.max(0, valueAt(c, 'volume', vt) ?? c.volume);
  return vol * soundFade(c, s, time) * crossWeight(s, time);
}

export function soundFade(c: VideoClip | AudioClip, s: ClipSound, t: number): number {
  const local = t - c.start;
  let f = 1;
  if (!s.xin && c.fadeIn > 0 && local < c.fadeIn) f = Math.min(f, shapeIn(s.inShape, Math.max(0, local / c.fadeIn)));
  const toEnd = c.duration - local;
  if (!s.xout && c.fadeOut > 0 && toEnd < c.fadeOut) f = Math.min(f, shapeIn(s.outShape, Math.max(0, toEnd / c.fadeOut)));
  return f;
}

export function crossWeight(s: ClipSound, t: number): number {
  let w = 1;
  const a = s.xin, b = s.xout;
  if (a) w *= t <= a.start ? 0 : t >= a.end ? 1 : shapeIn(a.shape, (t - a.start) / (a.end - a.start));
  if (b) w *= t >= b.end ? 0 : t <= b.start ? 1 : shapeIn(b.shape, (b.end - t) / (b.end - b.start));
  return w;
}

/** the gain points of a clip with a ClipSound, local to start - head, for the export */
export function soundGainPoints(c: VideoClip | AudioClip, s: ClipSound): Array<[number, number]> {
  const h = s.head, d = c.duration, D = h + d + s.tail, t0 = c.start - h;
  const times = new Set<number>([0, D, h, h + d]);
  const add = (t: number): void => { if (t > 0 && t < D) times.add(t); };
  const seg = (a: number, b: number, shape: FadeShape): void => {
    add(a);
    add(b);
    if (shape !== 'linear') for (let i = 1; i < SHAPE_STEPS; i++) add(a + ((b - a) * i) / SHAPE_STEPS);
  };
  if (!s.xin && c.fadeIn > 0) seg(h, h + Math.min(c.fadeIn, d), s.inShape);
  if (!s.xout && c.fadeOut > 0) seg(h + Math.max(0, d - c.fadeOut), h + d, s.outShape);
  if (!s.xin && !s.xout && c.fadeIn > 0 && c.fadeOut > 0 && c.fadeIn + c.fadeOut > d) add(h + (d * c.fadeIn) / (c.fadeIn + c.fadeOut));
  if (s.xin) seg(s.xin.start - t0, s.xin.end - t0, s.xin.shape);
  if (s.xout) seg(s.xout.start - t0, s.xout.end - t0, s.xout.shape);
  if (isAnimated(c, 'volume')) {
    for (const k of keyTimes(c.keyframes, 'volume')) {
      if (k <= 0 || k >= d) continue;
      add(h + k);
      add(h + Math.max(0, k - KEY_SNAP));
      add(h + Math.min(d, k + KEY_SNAP));
    }
    const n = Math.ceil(d / GAIN_STEP);
    for (let i = 1; i < n; i++) add(h + (d * i) / n);
  }
  return [...times].sort((a, b) => a - b).map((t) => [t, soundGainAt(c, s, t0 + t)] as [number, number]);
}
