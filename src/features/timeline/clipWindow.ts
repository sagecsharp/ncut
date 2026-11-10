/**
 * pure part of the lane virtualization: which clips of a lane have to be mounted for a scroll window.
 * a lane with few clips mounts all of them. a bigger one mounts the clips that touch the window (the
 * viewport plus about one viewport on each side, snapped to buckets so react only re-renders when the
 * window crosses a bucket) plus the pinned ones (selected clips). the result keeps the lane order, so
 * the paint order of overlapping clips does not change.
 */

/** the window moves in steps of this many px */
export const WINDOW_BUCKET = 400;
/** the margin on each side of the viewport is at least this many px */
export const WINDOW_MIN_MARGIN = 600;
/** a lane with fewer clips than this mounts all of them */
export const WINDOW_MIN_CLIPS = 60;

/** margin on each side of the viewport: about one viewport width, at least WINDOW_MIN_MARGIN px */
export function windowMargin(viewW: number): number {
  return Math.max(WINDOW_MIN_MARGIN, viewW);
}

/** px extent a clip of `start` / `duration` (seconds) takes in a lane at `zoom` (the box is never thinner than 2 px) */
export function clipExtent(start: number, duration: number, zoom: number): { x0: number; x1: number } {
  const x0 = start * zoom;
  return { x0, x1: x0 + Math.max(2, duration * zoom) };
}

/**
 * the window as a string that only changes when a bucket border is crossed. '' means "mount everything"
 * (small lane). `count` is the number of clips of the lane.
 */
export function windowKey(scrollLeft: number, viewW: number, count: number): string {
  if (count < WINDOW_MIN_CLIPS) return '';
  const m = windowMargin(viewW);
  const lo = Math.floor((scrollLeft - m) / WINDOW_BUCKET);
  const hi = Math.floor((scrollLeft + viewW + m) / WINDOW_BUCKET);
  return `${lo}:${hi}`;
}

/** px bounds of a windowKey (the whole buckets it names), or null for ''. always contains [scroll - margin, scroll + width + margin] */
export function windowBounds(key: string): { start: number; end: number } | null {
  if (key === '') return null;
  const at = key.indexOf(':');
  const lo = Number(key.slice(0, at));
  const hi = Number(key.slice(at + 1));
  return { start: lo * WINDOW_BUCKET, end: (hi + 1) * WINDOW_BUCKET };
}

export interface LaneItem {
  /** seconds */
  start: number;
  /** seconds */
  duration: number;
}

export interface LaneIndex {
  count: number;
  /** item indexes (lane order) sorted by start, ties by index */
  order: Int32Array;
  /** start of order[k] in seconds */
  starts: Float64Array;
  /** max over j <= k of the end (start + duration) of order[j], seconds. never decreases */
  maxEnds: Float64Array;
  items: readonly LaneItem[];
}

export function buildLaneIndex(items: readonly LaneItem[]): LaneIndex {
  const n = items.length;
  const order = Int32Array.from({ length: n }, (_, i) => i).sort((a, b) => items[a]!.start - items[b]!.start || a - b);
  const starts = new Float64Array(n);
  const maxEnds = new Float64Array(n);
  let run = -Infinity;
  for (let k = 0; k < n; k++) {
    const it = items[order[k]!]!;
    starts[k] = it.start;
    run = Math.max(run, it.start + it.duration);
    maxEnds[k] = run;
  }
  return { count: n, order, starts, maxEnds, items };
}

/**
 * mask (1 = mount) of the items whose box touches [winStart, winEnd] px at `zoom`, plus every item
 * for which `pinned(i)` is true. the two binary searches narrow the candidates, then each candidate
 * is tested exactly, so overlapping and very long clips are handled.
 */
export function windowMask(index: LaneIndex, zoom: number, winStart: number, winEnd: number, pinned?: (i: number) => boolean): Uint8Array {
  const { count, order, starts, maxEnds, items } = index;
  const mask = new Uint8Array(count);
  if (count > 0 && zoom > 0) {
    // first k whose running max end could reach winStart (+2 px for the minimum box width, +1 px for rounding)
    let lo = 0;
    let hi = count;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (maxEnds[mid]! * zoom + 3 >= winStart) hi = mid;
      else lo = mid + 1;
    }
    const first = lo;
    // first k that starts after winEnd: nothing from there on can touch the window
    lo = first;
    hi = count;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid]! * zoom > winEnd) hi = mid;
      else lo = mid + 1;
    }
    for (let k = first; k < lo; k++) {
      const i = order[k]!;
      const it = items[i]!;
      const { x0, x1 } = clipExtent(it.start, it.duration, zoom);
      if (x1 >= winStart && x0 <= winEnd) mask[i] = 1;
    }
  } else if (count > 0) {
    // no usable zoom: mount everything rather than hide clips
    mask.fill(1);
  }
  if (pinned) for (let i = 0; i < count; i++) if (pinned(i)) mask[i] = 1;
  return mask;
}

/** does a band of `start`..`end` seconds (a transition, drawn at least 6 px wide) touch the window */
export function spanInWindow(start: number, end: number, zoom: number, winStart: number, winEnd: number): boolean {
  const x0 = start * zoom;
  const x1 = x0 + Math.max(6, (end - start) * zoom);
  return x1 >= winStart && x0 <= winEnd;
}

/** has a clip (seconds) come within the window + margin of the viewport: the bar for asking for its filmstrip / waveform */
export function clipNearView(start: number, duration: number, zoom: number, scrollLeft: number, viewW: number): boolean {
  const { x0, x1 } = clipExtent(start, duration, zoom);
  const m = windowMargin(viewW);
  return x1 >= scrollLeft - m && x0 <= scrollLeft + viewW + m;
}
