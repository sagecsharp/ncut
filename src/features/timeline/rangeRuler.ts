/**
 * pure math of the in / out brackets on the ruler: the live range while dragging, hit testing, the shade, the drag time
 * and the edge scroll speed. no dom, no react, so it is unit tested.
 */
import type { InOutRange } from '../../types';
import { cleanRange } from '../../lib/inOut';
import type { Span } from '../../lib/inOut';
import { snapToFrame } from '../../lib/time';
import { snapTime } from '../../lib/timelineOps';
import type { RangeDrag } from './rangeDrag';

/** px around a bracket that still count as a hit */
export const RANGE_HIT_PX = 5;

/** the stored range with the dragged mark at its live time. null when nothing is left */
export function liveRange(stored: InOutRange | undefined, drag: RangeDrag | null): InOutRange | null {
  const base = cleanRange(stored);
  if (!drag) return base;
  return cleanRange({ ...(base ?? {}), [drag.which]: drag.time });
}

/** the set mark within RANGE_HIT_PX of lane x. both in reach: the in when x is left of their middle */
export function hitRangeHandle(r: InOutRange | null, zoom: number, x: number): 'in' | 'out' | null {
  if (!r || zoom <= 0) return null;
  const nearIn = r.in !== undefined && Math.abs(x - r.in * zoom) <= RANGE_HIT_PX;
  const nearOut = r.out !== undefined && Math.abs(x - r.out * zoom) <= RANGE_HIT_PX;
  if (nearIn && nearOut) return x < ((r.in! + r.out!) / 2) * zoom ? 'in' : 'out';
  return nearIn ? 'in' : nearOut ? 'out' : null;
}

/** the part of the timeline the ruler shade covers */
export function shadeSpan(r: InOutRange | null, duration: number): Span | null {
  if (!r) return null;
  if (r.in !== undefined && r.out !== undefined) return { start: r.in, end: r.out };
  if (r.in !== undefined) return { start: r.in, end: Math.max(duration, r.in) };
  if (r.out !== undefined) return { start: 0, end: r.out };
  return null;
}

/** where a dragged mark lands: on a snap point or a frame, a frame away from the other mark at least */
export function dragTime(
  which: 'in' | 'out',
  raw: number,
  r: InOutRange | null,
  fps: number,
  points: readonly number[],
  snapPx: number,
  zoom: number,
  snapping: boolean,
): { time: number; snapped: boolean } {
  let t = snapToFrame(raw, fps);
  let hit = false;
  if (snapping && zoom > 0) {
    const s = snapTime(raw, points, snapPx / zoom);
    if (s.hit !== null) {
      t = s.hit;
      hit = true;
    }
  }
  const c = cleanRange(r);
  const frame = 1 / fps;
  let time: number;
  if (which === 'in') {
    time = c?.out !== undefined ? Math.min(t, c.out - frame) : t;
    time = Math.max(0, time);
  } else {
    time = c?.in !== undefined ? Math.max(t, c.in + frame) : t;
    time = Math.max(time, frame);
  }
  return { time, snapped: hit && time === t };
}

const EDGE = 36;
const EDGE_MAX_SPEED = 22;

/** px per frame to scroll while a drag sits near an edge of the lane view (the gestures.ts numbers). 0 between */
export function edgeSpeed(xv: number, viewWidth: number): number {
  if (xv < EDGE) return -Math.ceil((Math.min(EDGE, EDGE - xv) / EDGE) * EDGE_MAX_SPEED);
  if (xv > viewWidth - EDGE) return Math.ceil((Math.min(EDGE, xv - (viewWidth - EDGE)) / EDGE) * EDGE_MAX_SPEED);
  return 0;
}
