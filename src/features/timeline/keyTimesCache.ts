import { keyTimes } from '../../lib/anim';
import type { Keyframes } from '../../types';

const cache = new WeakMap<Keyframes, { duration: number; times: number[] }>();
const NONE: number[] = [];

/** the visible key times of a clip (inside 0..duration), computed once per keyframes object */
export function clipKeyTimes(kf: Keyframes | undefined, duration: number): number[] {
  if (!kf) return NONE;
  const hit = cache.get(kf);
  if (hit && hit.duration === duration) return hit.times;
  const times = keyTimes(kf, undefined, duration);
  cache.set(kf, { duration, times });
  return times;
}

/** clip-local time of the key within `tol` of `local`, or NaN. cheap when the playhead is nowhere near the clip. */
export function keyAt(kf: Keyframes | undefined, duration: number, local: number, tol: number): number {
  if (!kf || local < -tol || local > duration + tol) return NaN;
  for (const t of clipKeyTimes(kf, duration)) if (Math.abs(t - local) <= tol) return t;
  return NaN;
}
