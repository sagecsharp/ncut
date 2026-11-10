/**
 * which part of the timeline an export renders. pure math, shared by the dialog (estimates) and the exporter.
 * times are absolute timeline seconds; the exported file always starts at 0.
 */
import type { Marker } from '../../types';

export interface TimeRange {
  start: number;
  end: number;
}

export type RangeMode = 'all' | 'markers' | 'custom';

const EPS = 1e-6;

/** the first and the last marker, or null with fewer than two markers (or when they share one time) */
export function markerRange(markers: readonly Marker[] | undefined): TimeRange | null {
  if (!markers || markers.length < 2) return null;
  let lo = Infinity;
  let hi = -Infinity;
  for (const m of markers) {
    lo = Math.min(lo, m.time);
    hi = Math.max(hi, m.time);
  }
  return hi - lo > EPS ? { start: lo, end: hi } : null;
}

/**
 * clamp a wanted range into [0, duration]. null = nothing left to render (empty, reversed or outside the project).
 * a missing range means the whole project.
 */
export function clampRange(range: TimeRange | undefined, duration: number): TimeRange | null {
  if (!(duration > 0)) return null;
  const start = Math.max(0, Math.min(duration, range ? range.start : 0));
  const end = Math.max(0, Math.min(duration, range ? range.end : duration));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end - start <= EPS) return null;
  return { start, end };
}

/** the range for a dialog choice. null = the choice does not give a usable range. */
export function resolveRange(
  mode: RangeMode,
  duration: number,
  markers: readonly Marker[] | undefined,
  custom: TimeRange,
): TimeRange | null {
  if (mode === 'markers') {
    const r = markerRange(markers);
    return r ? clampRange(r, duration) : null;
  }
  if (mode === 'custom') return clampRange(custom, duration);
  return clampRange(undefined, duration);
}

/** number of output frames for a length in seconds (never overshoots by a frame, at least 1) */
export function lengthFrames(length: number, fps: number): number {
  // float error in length * fps stays far below 1e-6 even for hours at 240 fps
  return Math.max(1, Math.ceil(length * fps - EPS));
}

export function rangeFrameCount(range: TimeRange, fps: number): number {
  return lengthFrames(range.end - range.start, fps);
}

/** timeline time of output frame i. one expression for every consumer, so decisions made from it agree bit for bit. */
export function frameTime(rangeStart: number, i: number, fps: number): number {
  return rangeStart + i / fps;
}
