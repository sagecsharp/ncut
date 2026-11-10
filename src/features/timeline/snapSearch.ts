/**
 * snapTime (lib/timelineOps) for the drag loops: the same answer, found with a binary search when the
 * point list is sorted. lib/timelineOps.snapTime keeps the linear scan; snapSearch.test.ts compares both.
 *
 * the linear scan returns the LAST point (in list order) among those at the smallest distance that is
 * <= threshold. in a sorted list that is the nearest point on the right when both sides are equally far.
 */
import { snapTime } from '../../lib/timelineOps';

const sortedCache = new WeakMap<readonly number[], boolean>();

/** is the list ascending and free of NaN. checked once per list (a drag builds its list once and does not change it) */
function isSorted(points: readonly number[]): boolean {
  let ok = sortedCache.get(points);
  if (ok === undefined) {
    ok = true;
    for (let i = 0; i < points.length; i++) {
      const v = points[i]!;
      if (Number.isNaN(v) || (i > 0 && v < points[i - 1]!)) {
        ok = false;
        break;
      }
    }
    sortedCache.set(points, ok);
  }
  return ok;
}

export function snapTimeFast(t: number, points: readonly number[], threshold: number): { time: number; hit: number | null } {
  // small lists, or a list that is not sorted: the plain scan
  if (points.length < 16 || !isSorted(points)) return snapTime(t, points, threshold);
  // first index whose point is >= t
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid]! < t) lo = mid + 1;
    else hi = mid;
  }
  let best: number | null = null;
  let bestDist = threshold;
  // the nearest point on each side. left first, so that on a tie the right one (later in the list) wins
  if (lo > 0) {
    const p = points[lo - 1]!;
    const d = Math.abs(p - t);
    if (d <= bestDist) {
      bestDist = d;
      best = p;
    }
  }
  if (lo < points.length) {
    // equal points: the scan keeps the last of them (only matters for -0 / 0)
    while (lo + 1 < points.length && points[lo + 1]! === points[lo]!) lo++;
    const p = points[lo]!;
    const d = Math.abs(p - t);
    if (d <= bestDist) {
      bestDist = d;
      best = p;
    }
  }
  return best === null ? { time: t, hit: null } : { time: best, hit: best };
}
