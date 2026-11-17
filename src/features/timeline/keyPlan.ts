import { scaleHandleTimes, withNamedEase } from '../../lib/keyBezier';
import { hasSoundApart } from '../../lib/soundPair';
import type { KeyRef } from '../../store/ui';
import type { KeyframesWrite } from '../../store/editorStore';
import type { Clip, Easing, Keyframe, Keyframes, Project } from '../../types';
import type { KeyClip, KeyCopy, KeyCopyItem } from '../properties/keyClipboard';
import { placeKeyCopy } from '../properties/keyClipboard';
import { MAX_KEYS_PER_PROP, MIN_GAP } from '../properties/keyTools';
import { KEY_REF_EPS, refIndex } from './keySelection';

export type KeyStopKind = 'start' | 'end' | 'inTheWay' | 'locked' | 'valueMin' | 'valueMax' | 'noHandles';
export interface KeyStop { kind: KeyStopKind; clipId: string; prop?: string; t?: number }
// writes: one per clip with selected keys, also when nothing moves. sel: after the plan.
// stop: why it stopped short (clamp) or was refused (refuse). amount: seconds, factor or keys changed
export interface KeyPlan { writes: KeyframesWrite[]; sel: KeyRef[]; stop: KeyStop | null; amount: number }
export interface KeyPastePlan extends KeyPlan { pasted: number; clips: number; leftOut: string[]; outside: boolean; capped: boolean }
export const EMPTY_PLAN: KeyPlan = { writes: [], sel: [], stop: null, amount: 0 };

/** the selected keys of one clip: value name to the indexes of its picked keys */
export interface KeyLane { clip: Clip; props: Map<string, Set<number>> }

const inside = (t: number, duration: number) => t >= -KEY_REF_EPS && t <= duration + KEY_REF_EPS;

/** live refs by clip, first seen order. a missing clip, a locked track and a gone key are dropped */
export function resolveKeySel(p: Project, sel: readonly KeyRef[]): Map<string, KeyLane> {
  const clips = new Map(p.clips.map((c) => [c.id, c]));
  const locked = new Set(p.tracks.filter((t) => t.locked).map((t) => t.id));
  const out = new Map<string, KeyLane>();
  for (const r of sel) {
    const clip = clips.get(r.clipId);
    if (!clip || locked.has(clip.trackId)) continue;
    const i = refIndex(clip, r);
    if (i === -1) continue;
    let lane = out.get(clip.id);
    if (!lane) out.set(clip.id, (lane = { clip, props: new Map() }));
    let set = lane.props.get(r.prop);
    if (!set) lane.props.set(r.prop, (set = new Set()));
    set.add(i);
  }
  return out;
}

/** how far the selected keys can go back (lo) and forward (hi), and the clip whose key sets each bound */
function range(lanes: ReadonlyMap<string, KeyLane>): { lo: number; hi: number; loClip: string; hiClip: string } {
  let lo = -Infinity;
  let hi = Infinity;
  let loClip = '';
  let hiClip = '';
  for (const { clip, props } of lanes.values()) {
    for (const [prop, picked] of props) {
      const keys = clip.keyframes![prop]!;
      for (const i of picked) {
        const t = keys[i]!.t;
        if (-t > lo) {
          lo = -t;
          loClip = clip.id;
        }
        if (clip.duration - t < hi) {
          hi = clip.duration - t;
          hiClip = clip.id;
        }
      }
    }
  }
  // a key a hair outside its clip (a split leaves one) never turns the range around, and + 0 turns -0 into 0
  return { lo: Math.min(0, lo) + 0, hi: Math.max(0, hi) + 0, loClip, hiClip };
}

// a drag plans on every move with the same project and selection: resolve once (projects are immutable)
const lanesMemo = new WeakMap<readonly KeyRef[], { p: Project; lanes: Map<string, KeyLane> }>();
function resolveMemo(p: Project, sel: readonly KeyRef[]): Map<string, KeyLane> {
  const hit = lanesMemo.get(sel);
  if (hit && hit.p === p) return hit.lanes;
  const lanes = resolveKeySel(p, sel);
  lanesMemo.set(sel, { p, lanes });
  return lanes;
}

/** how far the selected keys can move: lo (<= 0) back and hi (>= 0) forward, in seconds */
export function keyMoveRange(p: Project, sel: readonly KeyRef[]): { lo: number; hi: number } {
  const lanes = resolveKeySel(p, sel);
  if (lanes.size === 0) return { lo: 0, hi: 0 };
  const { lo, hi } = range(lanes);
  return { lo, hi };
}

/** the first inside key of a sorted list strictly within tol of t (binary search). outside keys are carried, never in the way */
function nearestInside(stay: readonly Keyframe[], t: number, duration: number, tol: number): Keyframe | null {
  let lo = 0;
  let hi = stay.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (stay[mid]!.t <= t - tol) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo; i < stay.length && stay[i]!.t < t + tol; i++) if (inside(stay[i]!.t, duration)) return stay[i]!;
  return null;
}

/**
 * writes the selected keys at the times `next` gives them. only the selected keys move: a key that stays is never
 * replaced, a moved key landing within half a frame of one is refused. every key is built by spread, so its ease and
 * handles ride along
 */
function build(p: Project, sel: readonly KeyRef[], lanes: ReadonlyMap<string, KeyLane>, next: (k: Keyframe, clip: Clip) => Keyframe, stop: KeyStop | null, amount: number): KeyPlan {
  const tol = 0.5 / p.fps;
  const writes: KeyframesWrite[] = [];
  const out: KeyRef[] = [];
  for (const { clip, props } of lanes.values()) {
    const kf: Keyframes = { ...clip.keyframes };
    for (const [prop, picked] of props) {
      const keys = clip.keyframes![prop]!;
      const stay = keys.filter((_, i) => !picked.has(i));
      const moved: Keyframe[] = [];
      for (let i = 0; i < keys.length; i++) {
        if (!picked.has(i)) continue;
        const m = next(keys[i]!, clip);
        moved.push(m);
        // a key that does not move cannot be in the way of anything
        if (Math.abs(m.t - keys[i]!.t) < 1e-9) continue;
        const hit = nearestInside(stay, m.t, clip.duration, tol);
        if (hit) return { ...EMPTY_PLAN, sel: [...sel], stop: { kind: 'inTheWay', clipId: clip.id, prop, t: clip.start + hit.t }, amount };
      }
      kf[prop] = [...stay, ...moved].sort((a, b) => a.t - b.t);
      for (const m of moved) out.push({ clipId: clip.id, prop, t: m.t });
    }
    writes.push({ id: clip.id, keyframes: kf });
  }
  return { writes, sel: out, stop, amount };
}

/** moves the selected keys by dt seconds. 'clamp' stops the block at the edge, 'refuse' gives the stop and no write */
export function planKeyMove(p: Project, sel: readonly KeyRef[], dt: number, fit: 'clamp' | 'refuse' = 'clamp'): KeyPlan {
  const lanes = resolveMemo(p, sel);
  if (lanes.size === 0) return EMPTY_PLAN;
  if (!Number.isFinite(dt)) return { ...EMPTY_PLAN, sel: [...sel] };
  const { lo, hi, loClip, hiClip } = range(lanes);
  let d = dt;
  let stop: KeyStop | null = null;
  if (d < lo - 1e-9) {
    stop = { kind: 'start', clipId: loClip };
    d = lo;
  }
  if (d > hi + 1e-9) {
    stop = { kind: 'end', clipId: hiClip };
    d = hi;
  }
  if (stop && fit === 'refuse') return { ...EMPTY_PLAN, sel: [...sel], stop };
  return build(p, sel, lanes, (k, clip) => ({ ...k, t: Math.min(clip.duration, Math.max(0, k.t + d)) }), stop, d);
}

/** stretches the selected keys around a timeline time. s is a factor from 0.01 to 100, narrowed so no key leaves its clip. amount is the s used */
export function planKeyScale(p: Project, sel: readonly KeyRef[], pivot: number, s: number, fit: 'clamp' | 'refuse' = 'clamp'): KeyPlan {
  const lanes = resolveMemo(p, sel);
  if (lanes.size === 0) return EMPTY_PLAN;
  if (!Number.isFinite(s) || !Number.isFinite(pivot)) return { ...EMPTY_PLAN, sel: [...sel] };
  const firstClip = lanes.values().next().value!.clip.id;
  let lo = 0.01;
  let hi = 100;
  let loClip = firstClip;
  let hiClip = firstClip;
  const narrowLo = (v: number, id: string) => {
    if (v > lo) {
      lo = v;
      loClip = id;
    }
  };
  const narrowHi = (v: number, id: string) => {
    if (v < hi) {
      hi = v;
      hiClip = id;
    }
  };
  for (const { clip, props } of lanes.values()) {
    const c = pivot - clip.start;
    for (const [prop, picked] of props) {
      const keys = clip.keyframes![prop]!;
      let prev = -1;
      for (const i of [...picked].sort((x, y) => x - y)) {
        // 0 <= c + a s <= duration. a key on the pivot stays put
        const a = clip.start + keys[i]!.t - pivot;
        if (a > 1e-12) {
          narrowLo(-c / a, clip.id);
          narrowHi((clip.duration - c) / a, clip.id);
        } else if (a < -1e-12) {
          narrowLo((clip.duration - c) / a, clip.id);
          narrowHi(-c / a, clip.id);
        }
        // selected neighbours stay MIN_GAP apart
        if (prev >= 0) {
          const g = keys[i]!.t - keys[prev]!.t;
          if (g > 0) narrowLo(MIN_GAP / g, clip.id);
        }
        prev = i;
      }
    }
  }
  let f = s;
  let stop: KeyStop | null = null;
  if (lo > hi) {
    f = 1;
    stop = { kind: 'end', clipId: hiClip };
  } else {
    if (f < lo - 1e-9) {
      stop = { kind: 'start', clipId: loClip };
      f = lo;
    }
    if (f > hi + 1e-9) {
      stop = { kind: 'end', clipId: hiClip };
      f = hi;
    }
  }
  if (stop && fit === 'refuse') return { ...EMPTY_PLAN, sel: [...sel], stop };
  const to = (k: Keyframe, clip: Clip): number => Math.min(clip.duration, Math.max(0, (clip.start + k.t - pivot) * f + pivot - clip.start));
  return build(p, sel, lanes, (k, clip) => ({ ...scaleHandleTimes(k, f), t: to(k, clip) }), stop, f);
}

/** moves the selected keys by whole frames. a move that does not fit is refused, never clamped */
export function planKeyNudge(p: Project, sel: readonly KeyRef[], frames: number): KeyPlan {
  return planKeyMove(p, sel, frames / p.fps, 'refuse');
}

/** deletes the selected keys. outside keys are carried. a value with no inside key left is dropped */
export function planKeyDelete(p: Project, sel: readonly KeyRef[]): KeyPlan {
  const lanes = resolveKeySel(p, sel);
  if (lanes.size === 0) return EMPTY_PLAN;
  const writes: KeyframesWrite[] = [];
  let amount = 0;
  for (const { clip, props } of lanes.values()) {
    const kf: Keyframes = { ...clip.keyframes };
    for (const [prop, picked] of props) {
      const keys = clip.keyframes![prop]!;
      const rest = keys.filter((_, i) => !picked.has(i));
      amount += keys.length - rest.length;
      if (rest.some((k) => inside(k.t, clip.duration))) kf[prop] = rest;
      else delete kf[prop];
    }
    writes.push({ id: clip.id, keyframes: kf });
  }
  return { writes, sel: [], stop: null, amount };
}

/** sets a named ease on the selected keys. amount counts the keys whose ease changed */
export function planKeyEase(p: Project, sel: readonly KeyRef[], ease: Easing): KeyPlan {
  const lanes = resolveKeySel(p, sel);
  if (lanes.size === 0) return EMPTY_PLAN;
  const writes: KeyframesWrite[] = [];
  let amount = 0;
  for (const { clip, props } of lanes.values()) {
    const kf: Keyframes = { ...clip.keyframes };
    for (const [prop, picked] of props) {
      let keys = clip.keyframes![prop]!;
      for (const i of [...picked].sort((a, b) => a - b)) {
        if (keys[i]!.ease !== ease) {
          keys = withNamedEase(keys, i, ease);
          amount++;
        }
      }
      kf[prop] = keys;
    }
    writes.push({ id: clip.id, keyframes: kf });
  }
  return { writes, sel: [...sel], stop: null, amount };
}

/** the picture's own volume and pan are not keyed while its sound is a clip of its own */
const SOUND_PROPS: ReadonlySet<string> = new Set(['volume', 'pan']);

/**
 * pastes a key copy at the playhead. every copied clip among the targets: each goes onto its own clip. else one
 * copied clip goes onto every target, else the copied clips go onto the targets in order. the pasted keys replace
 * what lay in their own time span, the rest stays. a value over 240 keys keeps its first 240
 */
export function planKeyPaste(p: Project, copy: KeyCopy, targets: readonly string[], playhead: number): KeyPastePlan {
  const none: KeyPastePlan = { ...EMPTY_PLAN, sel: [], pasted: 0, clips: 0, leftOut: [], outside: false, capped: false };
  const byId = new Map(p.clips.map((c) => [c.id, c]));
  const list: Clip[] = [];
  for (const id of targets) {
    const c = byId.get(id);
    if (c && !list.includes(c)) list.push(c);
  }
  if (!list.some((c) => playhead >= c.start - 1e-6 && playhead <= c.start + c.duration + 1e-6)) return { ...none, outside: true };
  const pairs: { item: KeyCopyItem; clip: Clip }[] = [];
  const ids = new Set(list.map((c) => c.id));
  if (copy.items.length > 0 && copy.items.every((it) => ids.has(it.clipId))) {
    for (const item of copy.items) pairs.push({ item, clip: byId.get(item.clipId)! });
  } else if (copy.items.length === 1) {
    for (const clip of list) pairs.push({ item: copy.items[0]!, clip });
  } else {
    for (let i = 0; i < Math.min(copy.items.length, list.length); i++) pairs.push({ item: copy.items[i]!, clip: list[i]! });
  }
  const locked = new Set(p.tracks.filter((t) => t.locked).map((t) => t.id));
  const live = pairs.filter((x) => !locked.has(x.clip.trackId));
  if (pairs.length > 0 && live.length === 0) return { ...none, stop: { kind: 'locked', clipId: pairs[0]!.clip.id } };
  const writes: KeyframesWrite[] = [];
  const sel: KeyRef[] = [];
  const leftOut: string[] = [];
  const noteLeft = (prop: string) => {
    if (!leftOut.includes(prop)) leftOut.push(prop);
  };
  let pasted = 0;
  let capped = false;
  for (const { item, clip } of live) {
    let keys: KeyClip = item.keys;
    const soundApart = clip.type === 'video' && hasSoundApart(p.clips, clip.id);
    if (soundApart) {
      keys = {};
      for (const prop of Object.keys(item.keys)) if (!SOUND_PROPS.has(prop)) keys[prop] = item.keys[prop]!;
    }
    const placed = placeKeyCopy(keys, clip, playhead - clip.start);
    // the left out values in the order they were copied
    for (const prop of Object.keys(item.keys)) if ((soundApart && SOUND_PROPS.has(prop)) || placed.leftOut.includes(prop)) noteLeft(prop);
    const kf: Keyframes = { ...clip.keyframes };
    let any = false;
    for (const prop of Object.keys(placed.keys)) {
      const fresh = placed.keys[prop]!;
      if (fresh.length === 0) continue;
      const lo = fresh[0]!.t;
      const hi = fresh[fresh.length - 1]!.t;
      const old = (clip.keyframes?.[prop] ?? []).filter((k) => k.t < lo - 1e-6 || k.t > hi + 1e-6);
      let merged = [...old, ...fresh].sort((a, b) => a.t - b.t);
      if (merged.length > MAX_KEYS_PER_PROP) {
        merged = merged.slice(0, MAX_KEYS_PER_PROP);
        capped = true;
      }
      const mine = new Set<Keyframe>(fresh);
      for (const k of merged) {
        if (!mine.has(k)) continue;
        pasted++;
        any = true;
        sel.push({ clipId: clip.id, prop, t: k.t });
      }
      kf[prop] = merged;
    }
    if (any) writes.push({ id: clip.id, keyframes: kf });
  }
  return { writes, sel, stop: null, amount: pasted, pasted, clips: writes.length, leftOut, outside: false, capped };
}
