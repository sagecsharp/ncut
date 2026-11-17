/** the numbers behind the source view's scrub bar: peaks, positions, grips. pure */
import { cleanRange, inOutSpan, lastFrameStart } from '../../lib/inOut';
import type { AnyRange } from '../../lib/inOut';
import { frameIndexAt, frameStart } from '../../lib/marks';
import { clamp } from '../../lib/time';

/** one peak per pixel column: the biggest peak of the slice of time the column covers (0 past the data) */
export function peakColumns(peaks: ArrayLike<number>, peaksPerSecond: number, duration: number, width: number): Float32Array {
  const n = Math.max(0, Math.floor(width));
  const out = new Float32Array(n);
  if (n === 0 || !(duration > 0) || !(peaksPerSecond > 0)) return out;
  for (let x = 0; x < n; x++) {
    const i0 = Math.floor((x / n) * duration * peaksPerSecond);
    const i1 = Math.max(i0 + 1, Math.ceil(((x + 1) / n) * duration * peaksPerSecond));
    if (i0 >= peaks.length) continue;
    const end = Math.min(i1, peaks.length);
    let peak = 0;
    for (let i = Math.max(0, i0); i < end; i++) {
      const v = peaks[i]!;
      if (v > peak) peak = v;
    }
    out[x] = peak;
  }
  return out;
}

/** the x of a time on the bar, clamped to the bar */
export function xAtTime(t: number, width: number, duration: number): number {
  if (!(duration > 0) || !(width > 0)) return 0;
  return clamp((t / duration) * width, 0, width);
}

/** the time of an x on the bar: the start of the frame there, never past the last frame */
export function timeAtX(x: number, width: number, duration: number, fps: number): number {
  if (!(duration > 0) || !(width > 0)) return 0;
  const t = clamp(x / width, 0, 1) * duration;
  return clamp(frameStart(frameIndexAt(t, fps), fps), 0, lastFrameStart(0, duration, fps));
}

/** the nearest frame boundary of an x on the bar (a mark may sit on the end of the last frame) */
export function gripTime(x: number, width: number, duration: number, fps: number): number {
  if (!(duration > 0) || !(width > 0)) return 0;
  const t = clamp(x / width, 0, 1) * duration;
  return clamp(Math.round(t * fps) / fps, 0, duration);
}

/** the marked part as a box on the bar. null without a part */
export function markRect(m: AnyRange, duration: number, width: number): { x: number; w: number } | null {
  const span = inOutSpan(m, duration);
  if (!span) return null;
  const x = xAtTime(span.start, width, duration);
  return { x, w: xAtTime(span.end, width, duration) - x };
}

/** which grip a pointer is on: the nearer set mark within slop px, in on a tie. null: none */
export function markHit(x: number, m: AnyRange, duration: number, width: number, slop = 6): 'in' | 'out' | null {
  const c = cleanRange(m);
  if (!c) return null;
  const dIn = c.in === undefined ? Infinity : Math.abs(x - xAtTime(c.in, width, duration));
  const dOut = c.out === undefined ? Infinity : Math.abs(x - xAtTime(c.out, width, duration));
  if (dIn > slop && dOut > slop) return null;
  return dIn <= dOut ? 'in' : 'out';
}

/** one 1 px column per peak, centered in a strip of height h at y0. the fill style is the caller's */
export function drawPeaks(ctx: CanvasRenderingContext2D, cols: ArrayLike<number>, y0: number, h: number): void {
  const mid = y0 + h / 2;
  const half = Math.max(0, h / 2 - 1);
  for (let x = 0; x < cols.length; x++) {
    const hh = Math.max(0.5, Math.min(1, cols[x]!) * half);
    ctx.fillRect(x, mid - hh, 1, hh * 2);
  }
}
