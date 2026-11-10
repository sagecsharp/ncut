/** pure zoom helpers for the timeline toolbar */

export const FIT_PAD = 24;

/**
 * zoom (px per second) that makes the time range [start, end] fill a viewport `width` px wide with
 * FIT_PAD px on each side. a range shorter than `minSpan` seconds is widened to it.
 */
export function zoomForRange(start: number, end: number, width: number, minSpan = 0.5): number {
  const span = Math.max(minSpan, end - start);
  return Math.max(1e-6, (width - FIT_PAD * 2) / span);
}

/** the time range covered by items, or null when there are none */
export function rangeOf(items: readonly { start: number; duration: number }[]): { start: number; end: number } | null {
  if (items.length === 0) return null;
  let start = Infinity;
  let end = -Infinity;
  for (const c of items) {
    if (c.start < start) start = c.start;
    if (c.start + c.duration > end) end = c.start + c.duration;
  }
  return { start, end };
}
