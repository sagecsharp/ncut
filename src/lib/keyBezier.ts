/**
 * custom eases: keyframes with in / out handles. pure functions, imports types only.
 *
 * a handle is { speed, influence }: speed = stored units per second of timeline time right at the key, influence = how far
 * the handle reaches toward the neighbour key as a share of the time between them. a part between two keys whose first key
 * has ease 'bezier' is one cubic: x (time share) from the two influences, y (value) from the two speeds.
 * every named ease has a cubic twin (twinHandles), so the first handle drag never jumps.
 * the time solve is newton then bisection in plain arithmetic: page, exporter and workers agree to the bit.
 */
import type { Easing, KeyHandle, Keyframe } from '../types';

export const INFLUENCE_MIN = 0.001;
export const INFLUENCE_EASY = 1 / 3;
export const SPEED_MAX = 1e9;
export const TWIN_EPS = 1e-9;
/** two keys closer than this are one key. its own constant: this file imports no value */
export const SPAN_EPS = 1e-4;
/** the speed of the back ease at its first key: its cubic has f'(0) = 3 c3 - 2 c1 */
export const BACK_OUT = 3 * 2.70158 - 2 * 1.70158;

export type HandleSide = 'in' | 'out';
export type EaseKind = 'easy' | 'into' | 'outOf';
export interface ValueRange { lo: number; hi: number }
type Handled = { in?: KeyHandle; out?: KeyHandle };

const ok = (h: KeyHandle | undefined): h is KeyHandle => !!h && Number.isFinite(h.speed) && Number.isFinite(h.influence);
const inf = (x: number): number => (x < INFLUENCE_MIN ? INFLUENCE_MIN : x > 1 ? 1 : x);
const spd = (x: number): number => (x < -SPEED_MAX ? -SPEED_MAX : x > SPEED_MAX ? SPEED_MAX : x);

/** a key with these sides, fields in stored order: t, v, ease, in, out */
const put = (k: Keyframe, i: KeyHandle | undefined, o: KeyHandle | undefined): Keyframe => ({
  t: k.t,
  v: k.v,
  ease: k.ease,
  ...(i ? { in: i } : null),
  ...(o ? { out: o } : null),
});

/** a handle that is safe to store: not finite is missing, speed and influence clamped. the same object when it is clean */
export function cleanHandle(h: unknown): KeyHandle | undefined {
  if (!h || typeof h !== 'object') return undefined;
  const x = h as KeyHandle;
  if (!ok(x)) return undefined;
  if (x.influence >= INFLUENCE_MIN && x.influence <= 1 && Math.abs(x.speed) <= SPEED_MAX && Object.keys(x).length === 2) return x;
  return { speed: spd(x.speed), influence: inf(x.influence) };
}

/** the eases a handle can edit: the part keeps its shape in a cubic twin */
export function hasHandles(ease: Easing): boolean {
  return ease === 'linear' || ease === 'ease' || ease === 'ease-in' || ease === 'ease-out' || ease === 'back' || ease === 'bezier';
}

/** the handles of the cubic that draws this ease on the part a -> b (a.ease for a named ease). influence 1/3 both sides */
export function twinHandles(ease: Easing, a: Keyframe, b: Keyframe): { out: KeyHandle; in: KeyHandle } {
  const span = b.t - a.t;
  const m = span > 0 ? (b.v - a.v) / span : 0;
  const h = (speed: number): KeyHandle => ({ speed, influence: INFLUENCE_EASY });
  switch (ease) {
    case 'linear':
      return { out: h(m), in: h(m) };
    case 'ease':
      return { out: h(0), in: h(0) };
    case 'ease-in':
      return { out: h(0), in: h(3 * m) };
    case 'ease-out':
      return { out: h(3 * m), in: h(0) };
    case 'back':
      return { out: h(BACK_OUT * m), in: h(0) };
    case 'bounce':
    case 'elastic':
      return { out: h(3 * m), in: h(0) };
    case 'hold':
      return { out: h(0), in: h(0) };
    default:
      return { out: cleanHandle(a.out) ?? h(m), in: cleanHandle(b.in) ?? h(m) };
  }
}

/** the handles a part shows: null for hold, bounce and elastic (their twin is not their shape) */
export function partHandles(a: Keyframe, b: Keyframe): { out: KeyHandle; in: KeyHandle } | null {
  if (a.ease === 'hold' || a.ease === 'bounce' || a.ease === 'elastic') return null;
  return twinHandles(a.ease, a, b);
}

/** the share s of the cubic whose x is u, x(s) with control x 0, x1, x2, 1. never falls: newton, then bisection */
export function solveBezierX(x1: number, x2: number, u: number): number {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  let s = u;
  for (let n = 0; n < 8; n++) {
    const x = ((ax * s + bx) * s + cx) * s - u;
    if (Math.abs(x) < 1e-9) return s;
    const d = (3 * ax * s + 2 * bx) * s + cx;
    if (Math.abs(d) < 1e-6) break;
    s -= x / d;
    if (s < 0 || s > 1) break;
  }
  let lo = 0, hi = 1;
  s = u;
  for (let n = 0; n < 50; n++) {
    const x = ((ax * s + bx) * s + cx) * s;
    if (Math.abs(x - u) < 1e-12) return s;
    if (x < u) lo = s; else hi = s;
    s = (lo + hi) / 2;
  }
  return s;
}

/** the value of the custom part a -> b at time t, clamped to [lo, hi] widened by both key values */
export function bezierValue(a: Keyframe, b: Keyframe, t: number, lo = -Infinity, hi = Infinity): number {
  const span = b.t - a.t, chord = (b.v - a.v) / span;
  const o = ok(a.out) ? a.out : undefined, i = ok(b.in) ? b.in : undefined;
  const io = o ? inf(o.influence) : INFLUENCE_EASY, ii = i ? inf(i.influence) : INFLUENCE_EASY;
  const so = o ? spd(o.speed) : chord, si = i ? spd(i.speed) : chord;
  const y1 = a.v + so * io * span, y2 = b.v - si * ii * span;
  const s = solveBezierX(io, 1 - ii, (t - a.t) / span), k = 1 - s;
  const v = k * k * k * a.v + 3 * k * k * s * y1 + 3 * k * s * s * y2 + s * s * s * b.v;
  const l = Math.min(lo, a.v, b.v), h = Math.max(hi, a.v, b.v);
  return v < l ? l : v > h ? h : v;
}

/** the speed (units per second) of the custom part a -> b at time t */
export function bezierSpeed(a: Keyframe, b: Keyframe, t: number): number {
  const span = b.t - a.t, chord = (b.v - a.v) / span;
  const o = ok(a.out) ? a.out : undefined, i = ok(b.in) ? b.in : undefined;
  const io = o ? inf(o.influence) : INFLUENCE_EASY, ii = i ? inf(i.influence) : INFLUENCE_EASY;
  const so = o ? spd(o.speed) : chord, si = i ? spd(i.speed) : chord;
  const x1 = io, x2 = 1 - ii;
  const y1 = a.v + so * io * span, y2 = b.v - si * ii * span;
  const s = solveBezierX(x1, x2, (t - a.t) / span);
  const xs = (q: number): number => {
    const k = 1 - q;
    return 3 * k * k * q * x1 + 3 * k * q * q * x2 + q * q * q;
  };
  const ys = (q: number): number => {
    const k = 1 - q;
    return k * k * k * a.v + 3 * k * k * q * y1 + 3 * k * q * q * y2 + q * q * q * b.v;
  };
  const k = 1 - s;
  const dx = 3 * (k * k * x1 + 2 * k * s * (x2 - x1) + s * s * (1 - x2));
  const dv = 3 * (k * k * (y1 - a.v) + 2 * k * s * (y2 - y1) + s * s * (b.v - y2));
  if (dx >= 1e-9) return dv / (span * dx);
  // the cubic stands still in time here: the mean of the two sides
  const h = 1e-6;
  const s0 = Math.max(0, s - h), s1 = Math.min(1, s + h);
  const quot = (q0: number, q1: number): number => {
    const d = xs(q1) - xs(q0);
    return d > 0 ? (ys(q1) - ys(q0)) / (span * d) : 0;
  };
  if (s0 === s) return quot(s, s1);
  if (s1 === s) return quot(s0, s);
  return (quot(s0, s) + quot(s, s1)) / 2;
}

/** the slope of a named ease at u (0..1), the derivative of applyEasing */
export function easeSlope(ease: Easing, u: number): number {
  switch (ease) {
    case 'linear':
      return 1;
    case 'ease':
      return 6 * u * (1 - u);
    case 'ease-in':
      return 3 * u * u;
    case 'ease-out':
      return 3 * (1 - u) * (1 - u);
    case 'back': {
      const c1 = 1.70158;
      const c3 = c1 + 1;
      const k = u - 1;
      return 3 * c3 * k * k + 2 * c1 * k;
    }
    case 'bounce': {
      const n1 = 7.5625;
      const d1 = 2.75;
      const c = u < 1 / d1 ? 0 : u < 2 / d1 ? 1.5 / d1 : u < 2.5 / d1 ? 2.25 / d1 : 2.625 / d1;
      return 2 * n1 * (u - c);
    }
    case 'elastic': {
      const c4 = (2 * Math.PI) / 3;
      const q = (10 * u - 0.75) * c4;
      return Math.pow(2, -10 * u) * (-10 * Math.LN2 * Math.sin(q) + 10 * c4 * Math.cos(q));
    }
    case 'hold':
      return 0;
    default:
      return 1;
  }
}

/** the speed of the part a -> b at time t, units per second */
export function partSpeed(a: Keyframe, b: Keyframe, t: number): number {
  if (a.ease === 'bezier') return bezierSpeed(a, b, t);
  const span = b.t - a.t;
  return ((b.v - a.v) / span) * easeSlope(a.ease, (t - a.t) / span);
}

/** the speed of a key list at time t. 0 under two keys, outside the keys, on a part of no length, and (with a range) where a custom part is clamped */
export function speedAt(keys: readonly Keyframe[], t: number, range?: ValueRange): number {
  const n = keys.length;
  if (n < 2 || t < keys[0]!.t || t > keys[n - 1]!.t) return 0;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (keys[mid]!.t <= t) lo = mid;
    else hi = mid;
  }
  const a = keys[lo]!, b = keys[hi]!;
  if (b.t - a.t <= SPAN_EPS) return 0;
  if (range && a.ease === 'bezier') {
    const raw = bezierValue(a, b, t);
    if (raw < Math.min(range.lo, a.v, b.v) || raw > Math.max(range.hi, a.v, b.v)) return 0;
  }
  return partSpeed(a, b, t);
}

/** the keys with the part from keys[i] to keys[i + 1] turned into its custom twin. the input when it already is (or i is the last key) */
export function toBezier(keys: readonly Keyframe[], i: number): Keyframe[] {
  const n = keys.length;
  if (i < 0 || i >= n - 1 || keys[i]!.ease === 'bezier') return keys as Keyframe[];
  const a = keys[i]!, b = keys[i + 1]!;
  const tw = twinHandles(a.ease, a, b);
  const next = keys.slice();
  next[i] = put({ ...a, ease: 'bezier' }, a.in, tw.out);
  next[i + 1] = put(b, tw.in, b.out);
  return next;
}

/** the keys cut at time t inside a custom part, both halves tracing the old cubic. null unless t is well inside a 'bezier' part */
export function splitBezierAt(keys: readonly Keyframe[], t: number): Keyframe[] | null {
  let j = -1;
  for (let q = 0; q < keys.length - 1; q++) if (keys[q]!.t < t && t < keys[q + 1]!.t) { j = q; break; }
  if (j < 0) return null;
  const a = keys[j]!, b = keys[j + 1]!;
  if (a.ease !== 'bezier' || !(a.t + SPAN_EPS < t && t < b.t - SPAN_EPS)) return null;
  const span = b.t - a.t, chord = (b.v - a.v) / span;
  const o = ok(a.out) ? a.out : undefined, i = ok(b.in) ? b.in : undefined;
  const io = o ? inf(o.influence) : INFLUENCE_EASY, ii = i ? inf(i.influence) : INFLUENCE_EASY;
  const so = o ? spd(o.speed) : chord, si = i ? spd(i.speed) : chord;
  const u = (t - a.t) / span;
  const s = solveBezierX(io, 1 - ii, u);
  type P = { x: number; v: number };
  const lerp = (p: P, q: P): P => ({ x: p.x + (q.x - p.x) * s, v: p.v + (q.v - p.v) * s });
  const p0: P = { x: 0, v: a.v }, p1: P = { x: io, v: a.v + so * io * span };
  const p2: P = { x: 1 - ii, v: b.v - si * ii * span }, p3: P = { x: 1, v: b.v };
  const q1 = lerp(p0, p1), m = lerp(p1, p2), r2 = lerp(p2, p3);
  const q2 = lerp(q1, m), r1 = lerp(m, r2), q3 = lerp(q2, r1);
  const w = r1.x - q2.x < 1e-12 ? bezierSpeed(a, b, t) : (r1.v - q2.v) / ((r1.x - q2.x) * span);
  const out: KeyHandle = { speed: so, influence: inf(q1.x / u) };
  const mid: Keyframe = {
    t,
    v: q3.v,
    ease: 'bezier',
    in: { speed: w, influence: inf((u - q2.x) / u) },
    out: { speed: w, influence: inf((r1.x - u) / (1 - u)) },
  };
  const bIn: KeyHandle = { speed: si, influence: inf((1 - r2.x) / (1 - u)) };
  const next = keys.slice();
  next[j] = put(a, a.in, out);
  next[j + 1] = put(b, bIn, b.out);
  next.splice(j + 1, 0, mid);
  return next;
}

/** the stored form: out only on a 'bezier' key with a next key, in only after one, clean handles, no `in: undefined`. the same array when clean */
export function tidyHandles(keys: Keyframe[]): Keyframe[] {
  const n = keys.length;
  let out: Keyframe[] | null = null;
  for (let i = 0; i < n; i++) {
    const k = keys[i]!;
    const wantOut = k.ease === 'bezier' && i < n - 1 ? cleanHandle(k.out) : undefined;
    const wantIn = i > 0 && keys[i - 1]!.ease === 'bezier' ? cleanHandle(k.in) : undefined;
    const clean = (wantIn ? k.in === wantIn : !('in' in k)) && (wantOut ? k.out === wantOut : !('out' in k));
    if (clean) continue;
    out ??= keys.slice();
    out[i] = put(k, wantIn, wantOut);
  }
  return out ?? keys;
}

/** set the handles of key i (null takes one off). a named part turns into its custom twin first. a side that does not exist is left */
export function withHandles(keys: readonly Keyframe[], i: number, patch: { in?: KeyHandle | null; out?: KeyHandle | null }): Keyframe[] {
  const n = keys.length;
  let next = keys.slice();
  if (patch.out !== undefined && i >= 0 && i < n - 1) {
    next = toBezier(next, i).slice();
    const h = patch.out === null ? undefined : cleanHandle(patch.out);
    next[i] = put(next[i]!, next[i]!.in, h);
  }
  if (patch.in !== undefined && i > 0 && i < n) {
    next = toBezier(next, i - 1).slice();
    const h = patch.in === null ? undefined : cleanHandle(patch.in);
    next[i] = put(next[i]!, h, next[i]!.out);
  }
  return tidyHandles(next);
}

/** key i with this ease. 'bezier' is its custom twin (the last key: the ease only); a named ease drops the handles it had */
export function withNamedEase(keys: readonly Keyframe[], i: number, ease: Easing): Keyframe[] {
  const n = keys.length;
  if (i < 0 || i >= n) return keys.slice();
  if (ease === 'bezier' && i < n - 1) return tidyHandles(toBezier(keys, i).slice());
  const next = keys.slice();
  next[i] = { ...next[i]!, ease };
  return tidyHandles(next);
}

const COLLAPSE: readonly Easing[] = ['ease', 'linear', 'ease-in', 'ease-out', 'back'];

/** custom parts whose handles equal the twin of a named ease get the name back */
export function collapseKeys(keys: readonly Keyframe[], parts?: readonly number[]): Keyframe[] {
  const n = keys.length;
  const next = keys.slice();
  const list = parts ?? keys.map((_, i) => i);
  for (const j of list) {
    if (j < 0 || j >= n - 1) continue;
    const a = next[j]!, b = next[j + 1]!;
    if (a.ease !== 'bezier') continue;
    const span = b.t - a.t;
    if (!(span > 0)) continue;
    const m = (b.v - a.v) / span;
    const eo = cleanHandle(a.out) ?? { speed: m, influence: INFLUENCE_EASY };
    const ei = cleanHandle(b.in) ?? { speed: m, influence: INFLUENCE_EASY };
    const tol = TWIN_EPS * Math.max(1, Math.abs(m));
    for (const e of COLLAPSE) {
      const tw = twinHandles(e, a, b);
      if (
        Math.abs(eo.speed - tw.out.speed) <= tol && Math.abs(ei.speed - tw.in.speed) <= tol &&
        Math.abs(eo.influence - INFLUENCE_EASY) <= TWIN_EPS && Math.abs(ei.influence - INFLUENCE_EASY) <= TWIN_EPS
      ) {
        next[j] = { ...a, ease: e };
        break;
      }
    }
  }
  return tidyHandles(next);
}

/** ease the picked keys: easy = both sides, into = the side arriving, outOf = the side leaving. speed 0, influence 1/3.
 *  a side whose part is 'hold' is kept; holds counts the picked keys that have one */
export function easeKeys(keys: readonly Keyframe[], picked: readonly number[], kind: EaseKind): { keys: Keyframe[]; holds: number } {
  const n = keys.length;
  const idx = [...new Set(picked)].filter((i) => i >= 0 && i < n).sort((x, y) => x - y);
  const parts = new Set<number>();
  const ins: number[] = [], outs: number[] = [];
  let holds = 0;
  for (const i of idx) {
    let kept = false;
    if (i > 0 && (kind === 'easy' || kind === 'into')) {
      if (keys[i - 1]!.ease === 'hold') kept = true;
      else { ins.push(i); parts.add(i - 1); }
    }
    if (i < n - 1 && (kind === 'easy' || kind === 'outOf')) {
      if (keys[i]!.ease === 'hold') kept = true;
      else { outs.push(i); parts.add(i); }
    }
    if (kept) holds++;
  }
  let next = keys.slice();
  for (const j of [...parts].sort((x, y) => x - y)) next = toBezier(next, j).slice();
  const flat: KeyHandle = { speed: 0, influence: INFLUENCE_EASY };
  for (const i of ins) next[i] = put(next[i]!, flat, next[i]!.out);
  for (const i of outs) next[i] = put(next[i]!, next[i]!.in, flat);
  return { keys: collapseKeys(next, [...parts]), holds };
}

/** key i is joined: both sides have handles and the speeds in and out are equal */
export function isJoined(keys: readonly Keyframe[], i: number): boolean {
  if (!(i > 0 && i < keys.length - 1)) return false;
  const left = partHandles(keys[i - 1]!, keys[i]!), right = partHandles(keys[i]!, keys[i + 1]!);
  if (!left || !right) return false;
  const a = left.in.speed, b = right.out.speed;
  return Math.abs(a - b) <= TWIN_EPS * Math.max(1, Math.abs(a), Math.abs(b));
}

/** speeds divided by s (a key list stretched s times in time). the same object without handles or with a bad s */
export function scaleHandleTimes<T extends Handled>(k: T, s: number): T {
  if (!(s > 0) || !Number.isFinite(s) || (!k.in && !k.out)) return k;
  const r = { ...k };
  if (k.in) r.in = { speed: k.in.speed / s, influence: k.in.influence };
  if (k.out) r.out = { speed: k.out.speed / s, influence: k.out.influence };
  return r;
}

/** speeds times r (the values scaled r times). the same object without handles or with a bad r */
export function scaleHandleValues<T extends Handled>(k: T, r: number): T {
  if (!Number.isFinite(r) || (!k.in && !k.out)) return k;
  const o = { ...k };
  if (k.in) o.in = { speed: k.in.speed * r, influence: k.in.influence };
  if (k.out) o.out = { speed: k.out.speed * r, influence: k.out.influence };
  return o;
}

/** the key played backwards: in becomes the mirror of out and out of in */
export function mirrorHandles<T extends Handled>(k: T): T {
  if (!k.in && !k.out) return k;
  const r = { ...k };
  delete r.in;
  delete r.out;
  if (k.out) r.in = { speed: 0 - k.out.speed, influence: k.out.influence };
  if (k.in) r.out = { speed: 0 - k.in.speed, influence: k.in.influence };
  return r;
}

/** only the handles of a key, to spread into a new key: `{ t, v, ease, ...handlesOf(k) }` */
export function handlesOf(k: Handled): Handled {
  return { ...(k.in ? { in: k.in } : null), ...(k.out ? { out: k.out } : null) };
}

/** two keys at one time: the earlier one's in, the later one's v, ease and out */
export function mergeSameTime(earlier: Keyframe, later: Keyframe): Keyframe {
  return put(later, earlier.in, later.out);
}

export function sameHandle(a: KeyHandle | undefined, b: KeyHandle | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.speed === b.speed && a.influence === b.influence;
}

export function sameHandles(a: Handled, b: Handled): boolean {
  return sameHandle(a.in, b.in) && sameHandle(a.out, b.out);
}
