import { KEY_EPS, evalKeys, keyIndexAt, withKey } from '../../lib/anim';
import { SPAN_EPS, collapseKeys, easeKeys, isJoined, partHandles, sameHandle, splitBezierAt, toBezier, withHandles } from '../../lib/keyBezier';
import type { EaseKind, HandleSide } from '../../lib/keyBezier';
import { propLimits } from '../../store/editorStore';
import type { KeyframesWrite } from '../../store/editorStore';
import type { KeyRef } from '../../store/ui';
import type { Clip, KeyHandle, Keyframe, Keyframes, Project } from '../../types';
import { MAX_KEYS_PER_PROP } from '../properties/keyTools';
import { laneId } from './keySelection';
import { EMPTY_PLAN, planKeyMove, resolveKeySel } from './keyPlan';
import type { KeyLane, KeyPlan, KeyStop } from './keyPlan';

const NO_LIMITS = { min: -Infinity, max: Infinity };
const limitsOf = (clip: Clip, prop: string): { min: number; max: number } => propLimits(clip, prop) ?? NO_LIMITS;
const sorted = (picked: ReadonlySet<number>): number[] => [...picked].sort((a, b) => a - b);

/** the plan of a selection that names no live key */
const none = (sel: readonly KeyRef[]): KeyPlan => ({ ...EMPTY_PLAN, sel: [...sel] });

/** the first lane's clip: where a stop with no better place is said */
const firstClip = (lanes: ReadonlyMap<string, KeyLane>): string => lanes.values().next().value!.clip.id;

interface MoveRoom { p: Project; upp: ReadonlyMap<string, number>; lanes: Map<string, KeyLane>; pxLo: number; pxHi: number; loStop: KeyStop | null; hiStop: KeyStop | null }
// a drag plans on every move with the same project, selection and scales: resolve the lanes and the room once
const roomMemo = new WeakMap<readonly KeyRef[], MoveRoom>();
function moveRoom(p: Project, sel: readonly KeyRef[], upp: ReadonlyMap<string, number>): MoveRoom {
  const hit = roomMemo.get(sel);
  if (hit && hit.p === p && hit.upp === upp) return hit;
  const lanes = resolveKeySel(p, sel);
  // the room in px the block has up (pxLo, <= 0) and down (pxHi, >= 0) before a key meets a limit. a key already outside never blocks
  let pxLo = -Infinity;
  let pxHi = Infinity;
  let loStop: KeyStop | null = null;
  let hiStop: KeyStop | null = null;
  for (const { clip, props } of lanes.values()) {
    for (const [prop, picked] of props) {
      const u = upp.get(laneId(clip.id, prop));
      if (!(u !== undefined && u > 0)) continue;
      const { min, max } = limitsOf(clip, prop);
      const keys = clip.keyframes![prop]!;
      for (const i of picked) {
        const k = keys[i]!;
        const lo = Math.min(0, (k.v - max) / u);
        const hi = Math.max(0, (k.v - min) / u);
        if (lo > pxLo) {
          pxLo = lo;
          loStop = { kind: 'valueMax', clipId: clip.id, prop, t: clip.start + k.t };
        }
        if (hi < pxHi) {
          pxHi = hi;
          hiStop = { kind: 'valueMin', clipId: clip.id, prop, t: clip.start + k.t };
        }
      }
    }
  }
  const room: MoveRoom = { p, upp, lanes, pxLo, pxHi, loStop, hiStop };
  roomMemo.set(sel, room);
  return room;
}

/** moves the selected keys in time and value. dyPx is a pointer move in px, upp maps a lane id to stored units per px */
export function planGraphMove(p: Project, sel: readonly KeyRef[], dt: number, dyPx: number, upp: ReadonlyMap<string, number>, fit: 'clamp' | 'refuse' = 'clamp'): KeyPlan {
  const { lanes, pxLo, pxHi, loStop, hiStop } = moveRoom(p, sel, upp);
  if (lanes.size === 0) return none(sel);
  let dy = Number.isFinite(dyPx) ? dyPx : 0;
  let valueStop: KeyStop | null = null;
  if (dy < pxLo) {
    valueStop = loStop;
    dy = pxLo;
  }
  if (dy > pxHi) {
    valueStop = hiStop;
    dy = pxHi;
  }
  // the time move on the base project (its lanes are memoized), then the new values on the moved keys
  let plan = planKeyMove(p, sel, dt, fit);
  if (dy !== 0) plan = withMovedValues(plan, upp, dy);
  if (plan.stop && (fit === 'refuse' || plan.stop.kind === 'inTheWay')) return plan;
  if (valueStop && fit === 'refuse') return { ...EMPTY_PLAN, sel: [...sel], stop: valueStop };
  return { ...plan, stop: plan.stop ?? valueStop };
}

/** the plan with the moved keys (the ones plan.sel names) at v - dy * u */
function withMovedValues(plan: KeyPlan, upp: ReadonlyMap<string, number>, dy: number): KeyPlan {
  if (plan.writes.length === 0) return plan;
  const moved = new Map<string, Set<number>>();
  for (const r of plan.sel) {
    const id = laneId(r.clipId, r.prop);
    let set = moved.get(id);
    if (!set) moved.set(id, (set = new Set()));
    set.add(r.t);
  }
  const writes = plan.writes.map((w) => {
    const kf: Keyframes = { ...w.keyframes };
    for (const prop of Object.keys(kf)) {
      const set = moved.get(laneId(w.id, prop));
      const u = upp.get(laneId(w.id, prop));
      if (!set || !(u !== undefined && u > 0)) continue;
      kf[prop] = kf[prop]!.map((k) => (set.has(k.t) ? { ...k, v: k.v - dy * u } : k));
    }
    return { ...w, keyframes: kf };
  });
  return { ...plan, writes };
}

/** sets the speed and / or influence of the handle on one side of the selected keys. alone: the other side of a joined key stays */
export function planHandleSet(p: Project, refs: readonly KeyRef[], side: HandleSide, change: { speed?: number; influence?: number }, alone: boolean): KeyPlan {
  const lanes = resolveKeySel(p, refs);
  if (lanes.size === 0) return none(refs);
  const other: HandleSide = side === 'out' ? 'in' : 'out';
  const writes: KeyframesWrite[] = [];
  let amount = 0;
  for (const { clip, props } of lanes.values()) {
    const kf: Keyframes = { ...clip.keyframes };
    let touched = false;
    for (const [prop, picked] of props) {
      let keys: readonly Keyframe[] = clip.keyframes![prop]!;
      const parts: number[] = [];
      for (const i of sorted(picked)) {
        const j = side === 'out' ? i : i - 1;
        if (j < 0 || j >= keys.length - 1 || keys[j + 1]!.t - keys[j]!.t <= SPAN_EPS) continue;
        const ph = partHandles(keys[j]!, keys[j + 1]!);
        if (!ph) continue;
        touched = true;
        const cur = ph[side];
        const next: KeyHandle = { speed: change.speed ?? cur.speed, influence: change.influence ?? cur.influence };
        const joined = isJoined(keys, i);
        const patch: { in?: KeyHandle; out?: KeyHandle } = { [side]: next };
        let changed = !sameHandle(cur, next);
        if (joined && !alone && change.speed !== undefined) {
          const oj = side === 'out' ? i - 1 : i;
          const oh = partHandles(keys[oj]!, keys[oj + 1]!)![other];
          const oNext: KeyHandle = { speed: change.speed, influence: oh.influence };
          patch[other] = oNext;
          parts.push(oj);
          if (!sameHandle(oh, oNext)) changed = true;
        }
        keys = withHandles(keys, i, patch);
        parts.push(j);
        if (changed) amount++;
      }
      kf[prop] = collapseKeys(keys, parts);
    }
    if (touched) writes.push({ id: clip.id, keyframes: kf });
  }
  if (writes.length === 0) return { ...none(refs), stop: { kind: 'noHandles', clipId: firstClip(lanes) } };
  return { writes, sel: [...refs], stop: null, amount };
}

/** easy ease, ease into or ease out of on the selected keys. holds counts keys next to a hold that were kept as they are */
export function planEase(p: Project, sel: readonly KeyRef[], kind: EaseKind): KeyPlan & { holds: number } {
  const lanes = resolveKeySel(p, sel);
  if (lanes.size === 0) return { ...none(sel), holds: 0 };
  const writes: KeyframesWrite[] = [];
  let amount = 0;
  let holds = 0;
  for (const { clip, props } of lanes.values()) {
    const kf: Keyframes = { ...clip.keyframes };
    for (const [prop, picked] of props) {
      const keys = clip.keyframes![prop]!;
      const idx = sorted(picked);
      const r = easeKeys(keys, idx, kind);
      holds += r.holds;
      for (const i of idx) {
        const into = (kind === 'easy' || kind === 'into') && i > 0 && keys[i - 1]!.ease !== 'hold';
        const outOf = (kind === 'easy' || kind === 'outOf') && i < keys.length - 1 && keys[i]!.ease !== 'hold';
        if (into || outOf) amount++;
      }
      kf[prop] = r.keys;
    }
    writes.push({ id: clip.id, keyframes: kf });
  }
  if (amount === 0) return { ...none(sel), holds };
  return { writes, sel: [...sel], stop: null, amount, holds };
}

/** joins the two handles of each selected key: both sides get the mean speed */
export function planJoin(p: Project, sel: readonly KeyRef[]): KeyPlan {
  const lanes = resolveKeySel(p, sel);
  if (lanes.size === 0) return none(sel);
  const writes: KeyframesWrite[] = [];
  let amount = 0;
  let handled = 0;
  for (const { clip, props } of lanes.values()) {
    const kf: Keyframes = { ...clip.keyframes };
    let touched = false;
    for (const [prop, picked] of props) {
      let keys: readonly Keyframe[] = clip.keyframes![prop]!;
      const parts: number[] = [];
      for (const i of sorted(picked)) {
        if (!(i > 0 && i < keys.length - 1)) continue;
        const a = keys[i - 1]!, b = keys[i]!, c = keys[i + 1]!;
        if (b.t - a.t <= SPAN_EPS || c.t - b.t <= SPAN_EPS) continue;
        const left = partHandles(a, b), right = partHandles(b, c);
        if (!left || !right) continue;
        handled++;
        if (isJoined(keys, i)) continue;
        const speed = (left.in.speed + right.out.speed) / 2;
        keys = withHandles(keys, i, { in: { speed, influence: left.in.influence }, out: { speed, influence: right.out.influence } });
        parts.push(i - 1, i);
        amount++;
        touched = true;
      }
      kf[prop] = collapseKeys(keys, parts);
    }
    if (touched) writes.push({ id: clip.id, keyframes: kf });
  }
  if (handled === 0) return { ...none(sel), stop: { kind: 'noHandles', clipId: firstClip(lanes) } };
  if (amount === 0) return none(sel);
  return { writes, sel: [...sel], stop: null, amount };
}

/** sets or adds to the value of the keys, inside the limits of their value */
export function planKeyValue(p: Project, refs: readonly KeyRef[], change: { set?: number; add?: number }): KeyPlan {
  const lanes = resolveKeySel(p, refs);
  if (lanes.size === 0) return none(refs);
  const by = change.set !== undefined ? change.set : change.add;
  if (by === undefined || !Number.isFinite(by)) return none(refs);
  const writes: KeyframesWrite[] = [];
  let amount = 0;
  for (const { clip, props } of lanes.values()) {
    const kf: Keyframes = { ...clip.keyframes };
    for (const [prop, picked] of props) {
      const { min, max } = limitsOf(clip, prop);
      kf[prop] = clip.keyframes![prop]!.map((k, i) => {
        if (!picked.has(i)) return k;
        const raw = change.set !== undefined ? by : k.v + by;
        const v = Math.min(max, Math.max(min, raw));
        if (v === k.v) return k;
        amount++;
        return { ...k, v };
      });
    }
    writes.push({ id: clip.id, keyframes: kf });
  }
  return { writes, sel: [...refs], stop: null, amount };
}

/** moves the values of the selected keys by whole steps. step maps a lane id to stored units per step. a key that would leave its limits refuses the whole step */
export function planValueStep(p: Project, sel: readonly KeyRef[], steps: number, step: ReadonlyMap<string, number>): KeyPlan {
  const lanes = resolveKeySel(p, sel);
  if (lanes.size === 0) return none(sel);
  if (!Number.isFinite(steps) || steps === 0) return none(sel);
  const writes: KeyframesWrite[] = [];
  let amount = 0;
  for (const { clip, props } of lanes.values()) {
    const kf: Keyframes = { ...clip.keyframes };
    let touched = false;
    for (const [prop, picked] of props) {
      const s = step.get(laneId(clip.id, prop));
      if (!(s !== undefined && s > 0)) continue;
      const { min, max } = limitsOf(clip, prop);
      const keys = clip.keyframes![prop]!;
      const next: Keyframe[] = keys.slice();
      for (const i of sorted(picked)) {
        const k = keys[i]!;
        let v = k.v + steps * s;
        if (steps > 0 && v > max + 1e-9 * Math.max(1, Math.abs(max))) return { ...none(sel), stop: { kind: 'valueMax', clipId: clip.id, prop, t: clip.start + k.t } };
        if (steps < 0 && v < min - 1e-9 * Math.max(1, Math.abs(min))) return { ...none(sel), stop: { kind: 'valueMin', clipId: clip.id, prop, t: clip.start + k.t } };
        v = Math.min(max, Math.max(min, v));
        next[i] = { ...k, v };
        amount++;
      }
      kf[prop] = next;
      touched = true;
    }
    if (touched) writes.push({ id: clip.id, keyframes: kf });
  }
  return { writes, sel: [...sel], stop: null, amount };
}

/** a new key on a line at a clip-local time. the line keeps its shape: a custom part is split exactly, a hold stays a hold */
export function planAddKey(p: Project, clipId: string, prop: string, t: number): KeyPlan {
  const clip = p.clips.find((c) => c.id === clipId);
  const keys = clip?.keyframes?.[prop];
  if (!clip || !keys || keys.length === 0 || !Number.isFinite(t)) return { ...EMPTY_PLAN, sel: [] };
  const stop = (kind: KeyStop['kind']): KeyPlan => ({ ...EMPTY_PLAN, sel: [], stop: { kind, clipId, prop } });
  if (p.tracks.some((tr) => tr.id === clip.trackId && tr.locked)) return stop('locked');
  if (t < 0) return stop('start');
  if (t > clip.duration || keys.length >= MAX_KEYS_PER_PROP) return stop('end');
  const pick = (k: Keyframe): KeyPlan => ({ ...EMPTY_PLAN, sel: [{ clipId, prop, t: k.t }] });
  const at = keyIndexAt(keys, t, KEY_EPS);
  if (at >= 0) return pick(keys[at]!);
  let j = -1;
  for (let i = 0; i < keys.length - 1; i++) {
    if (keys[i]!.t < t && t < keys[i + 1]!.t) {
      j = i;
      break;
    }
  }
  let next: Keyframe[];
  if (j >= 0 && keys[j]!.ease === 'hold') {
    next = withKey(keys, t, keys[j]!.v, 'hold');
  } else if (j >= 0 && partHandles(keys[j]!, keys[j + 1]!)) {
    const split = splitBezierAt(toBezier(keys, j), t);
    if (!split) {
      const near = keys.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a));
      return pick(near);
    }
    // the raw cut value can lie outside the limits of the value (the write clamps it): put it on the bound with flat handles, so the halves sit on the bound
    const mid = split[j + 1]!;
    const { min, max } = limitsOf(clip, prop);
    if (mid.v < min || mid.v > max) {
      split[j + 1] = { ...mid, v: Math.min(max, Math.max(min, mid.v)), in: mid.in && { ...mid.in, speed: 0 }, out: mid.out && { ...mid.out, speed: 0 } };
    }
    next = collapseKeys(split, [j, j + 1]);
  } else {
    next = withKey(keys, t, evalKeys(keys, t, clip, prop));
  }
  const kf: Keyframes = { ...clip.keyframes, [prop]: next };
  return { writes: [{ id: clipId, keyframes: kf }], sel: [{ clipId, prop, t }], stop: null, amount: 1 };
}
