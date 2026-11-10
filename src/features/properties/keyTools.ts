/**
 * keyframe tools. pure functions over a Keyframes record (see lib/anim.ts: key times are CLIP-LOCAL
 * seconds, `ease` on a key describes the segment AFTER it). nothing here mutates its input, results are
 * sorted by time and no two keys of one property are closer than MIN_GAP.
 */
import type { Easing, Keyframe, Keyframes } from '../../types';

/** two keys of one property are never closer than this (seconds) */
export const MIN_GAP = 0.001;
const GAP_TOL = 1e-9;
/** wiggle never makes more keys than this */
export const MAX_WIGGLE_KEYS = 240;
const MAX_REPEAT = 64;
/** most keys one property may have after a repeat */
export const MAX_KEYS_PER_PROP = 240;

/** the ease that plays the same curve backwards (exact for linear / smooth / in / out, best effort for the rest) */
export function mirrorEase(e: Easing): Easing {
  if (e === 'ease-in') return 'ease-out';
  if (e === 'ease-out') return 'ease-in';
  return e;
}

/** sort by time and merge keys closer than MIN_GAP (the later one wins) */
export function normalizeKeys(keys: readonly Keyframe[]): Keyframe[] {
  const sorted = keys.map((k) => ({ ...k })).sort((a, b) => a.t - b.t);
  const out: Keyframe[] = [];
  for (const k of sorted) {
    const prev = out[out.length - 1];
    if (prev && k.t - prev.t < MIN_GAP - GAP_TOL) out[out.length - 1] = k;
    else out.push(k);
  }
  return out;
}

function mapProps(kf: Keyframes, fn: (keys: Keyframe[], prop: string) => Keyframe[]): Keyframes {
  const out: Keyframes = {};
  for (const prop of Object.keys(kf)) {
    const keys = kf[prop]!;
    if (keys.length === 0) continue;
    const next = normalizeKeys(fn(keys, prop));
    if (next.length > 0) out[prop] = next;
  }
  return out;
}

/** first and last key time over every property, or null when there are no keys */
export function keySpan(kf: Keyframes): { lo: number; hi: number } | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const prop of Object.keys(kf)) {
    for (const k of kf[prop]!) {
      if (k.t < lo) lo = k.t;
      if (k.t > hi) hi = k.t;
    }
  }
  return lo <= hi ? { lo, hi } : null;
}

/**
 * play the animation backwards inside its own time span. with `duration` (the clip's length) and keys that lie
 * outside the clip (a split half keeps the keys of the part that was cut away), the mirror is the clip itself:
 * what is visible plays backwards, not what was cut off.
 */
export function reverseKeys(kf: Keyframes, duration?: number): Keyframes {
  if (!keySpan(kf)) return {};
  // decided per property: one stray key far outside the clip must not move the animations that lie inside it
  const isOut = (keys: readonly Keyframe[]) =>
    duration !== undefined && duration > 0 && keys.length > 0 && (keys[0]!.t < -GAP_TOL || keys[keys.length - 1]!.t > duration + GAP_TOL);
  const inside: Keyframes = {};
  for (const prop of Object.keys(kf)) if (!isOut(kf[prop]!)) inside[prop] = kf[prop]!;
  const span = keySpan(inside);
  return mapProps(kf, (keys) => {
    const sum = isOut(keys) || !span ? (duration ?? 0) : span.lo + span.hi;
    const n = keys.length;
    const out: Keyframe[] = [];
    for (let i = n - 1; i >= 0; i--) {
      const k = keys[i]!;
      // the reversed key i starts the segment that used to END at it: the one the key before it described
      const seg = i > 0 ? keys[i - 1]!.ease : k.ease;
      out.push({ t: sum - k.t, v: k.v, ease: mirrorEase(seg) });
    }
    return out;
  });
}

/** scale all key times so the first key sits at `from` and the last at `to` */
export function fitKeys(kf: Keyframes, from: number, to: number): Keyframes {
  const span = keySpan(kf);
  if (!span) return {};
  const len = span.hi - span.lo;
  const target = Math.max(to, from);
  const scale = len > 0 ? (target - from) / len : 0;
  return mapProps(kf, (keys) => keys.map((k) => ({ ...k, t: from + (k.t - span.lo) * scale })));
}

/** move every key by dt, the block as a whole stops at min / max */
export function shiftKeys(kf: Keyframes, dt: number, min: number, max: number): Keyframes {
  const span = keySpan(kf);
  if (!span) return {};
  const d = Math.max(min - span.lo, Math.min(dt, max - span.hi));
  return mapProps(kf, (keys) => keys.map((k) => ({ ...k, t: k.t + d })));
}

/**
 * repeat the pattern between the first and last key `times` times inside the same span (so it plays
 * faster). pingPong plays every second pass backwards. without it the value jumps back at each seam
 * within MIN_GAP instead of gliding back.
 */
export function repeatKeys(kf: Keyframes, times: number, pingPong: boolean): Keyframes {
  const span = keySpan(kf);
  if (!span) return {};
  const n = Math.min(MAX_REPEAT, Math.floor(times));
  if (!(n >= 2) || span.hi - span.lo < MIN_GAP) return mapProps(kf, (keys) => keys);
  const { lo, hi } = span;
  const len = hi - lo;
  return mapProps(kf, (keys) => {
    // one key is a value, not a pattern; and a property never grows past the cap (it stays as it is)
    if (keys.length < 2 || (keys.length + 1) * n > MAX_KEYS_PER_PROP) return keys;
    const out: Keyframe[] = [];
    for (let pass = 0; pass < n; pass++) {
      const flip = pingPong && pass % 2 === 1;
      const cur: Keyframe[] = [];
      for (let j = 0; j < keys.length; j++) {
        const i = flip ? keys.length - 1 - j : j;
        const k = keys[i]!;
        const local = flip ? hi - k.t : k.t - lo;
        const ease = flip ? mirrorEase(i > 0 ? keys[i - 1]!.ease : k.ease) : k.ease;
        cur.push({ t: lo + (pass * len + local) / n, v: k.v, ease });
      }
      if (!pingPong && pass < n - 1) {
        // jump back at the seam: park the last value until 1 ms before the next pass starts
        const nextStart = lo + ((pass + 1) * len + (keys[0]!.t - lo)) / n;
        const last = cur[cur.length - 1]!;
        if (Math.abs(last.v - keys[0]!.v) > 1e-12) {
          const park = nextStart - MIN_GAP;
          if (park - last.t >= MIN_GAP - GAP_TOL) cur.push({ t: park, v: last.v, ease: 'linear' });
          else last.t = Math.max(park, cur.length > 1 ? cur[cur.length - 2]!.t + MIN_GAP : park);
        }
      }
      // a jump made by an earlier repeat (two keys 1 ms apart) must stay a jump: squeezing it would merge the
      // two keys and lose the peak. the earlier key of such a pair steps back to keep the gap.
      for (let j = cur.length - 1; j >= 1; j--) {
        const b = cur[j]!;
        const a = cur[j - 1]!;
        if (b.t - a.t < MIN_GAP - GAP_TOL) a.t = b.t - MIN_GAP;
      }
      out.push(...cur);
    }
    out.sort((a, b) => a.t - b.t);
    return out;
  });
}

/** true when repeating would push a property past the key cap (repeatKeys then leaves that property alone) */
export function repeatTooBig(kf: Keyframes, times: number): boolean {
  const n = Math.min(MAX_REPEAT, Math.floor(times));
  return Object.values(kf).some((keys) => keys.length >= 2 && (keys.length + 1) * n > MAX_KEYS_PER_PROP);
}

export interface WiggleOptions {
  /** how far the value strays from base, in the unit of the property */
  amount: number;
  /** keys per second */
  perSecond: number;
  from: number;
  to: number;
  seed: number;
}

/** small deterministic hash of (seed, index) -> 0 .. 1 */
export function hash01(seed: number, index: number): number {
  let h = (Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul((index + 1) | 0, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

/** keys for ONE property: a seeded random walk around base that starts and ends at rest */
export function wiggleKeys(base: number, opts: WiggleOptions): Keyframe[] {
  const { amount, from, to, seed } = opts;
  const perSecond = Math.min(1000, Math.max(0.01, opts.perSecond));
  const len = to - from;
  if (!(len >= MIN_GAP)) return [{ t: from, v: base, ease: 'ease' }];
  const count = Math.max(1, Math.min(MAX_WIGGLE_KEYS - 1, Math.round(len * perSecond)));
  const step = len / count;
  const out: Keyframe[] = [];
  let prev = 0;
  for (let i = 0; i <= count; i++) {
    let r = 0;
    if (i > 0 && i < count) {
      // a walk: each step leans on the one before, so it drifts instead of jittering
      r = Math.max(-1, Math.min(1, prev * 0.35 + (hash01(seed, i) * 2 - 1) * 0.65 * 1.4));
    }
    prev = r;
    out.push({ t: i === count ? to : from + i * step, v: base + amount * r, ease: 'ease' });
  }
  return out;
}
