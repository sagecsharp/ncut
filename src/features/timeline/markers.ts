/**
 * pure marker math for the timeline: flag geometry, culling to the visible range, hit testing and
 * the snap point list. no dom, no react, so it is unit tested.
 */
import type { Marker, Project } from '../../types';
import { collectSnapPoints } from '../../lib/timelineOps';

/** flag height in the ruler (px) */
export const FLAG_H = 13;
/** horizontal padding inside a flag */
export const FLAG_PAD = 4;
/** advance of one character of the 10px mono ruler font (px). flags are drawn and hit with this same estimate */
export const CHAR_W = 6;
/** longest label drawn on a flag, longer names are cut with an ellipsis character */
export const MAX_LABEL = 16;
/** extra px around the pole that still counts as a hit */
export const POLE_SLOP = 3;
/** width of the bare flag when the marker has no name */
export const BARE_W = 8;

/** the text drawn on a flag ('' for an unnamed marker) */
export function flagLabel(name: string): string {
  const t = name.trim();
  if (t.length <= MAX_LABEL) return t;
  return `${t.slice(0, MAX_LABEL - 1)}\u2026`;
}

/** width of a flag in px (pole excluded) */
export function flagWidth(name: string): number {
  const label = flagLabel(name);
  return label ? label.length * CHAR_W + FLAG_PAD * 2 : BARE_W;
}

export const MAX_FLAG_W = MAX_LABEL * CHAR_W + FLAG_PAD * 2;

/** index of the first marker with time >= t (markers are sorted by time) */
export function lowerBound(markers: readonly Marker[], t: number): number {
  let lo = 0;
  let hi = markers.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (markers[mid]!.time < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * half open index range [from, to) of the markers whose flag can touch the viewport
 * [scrollLeft, scrollLeft + width] at `zoom` px per second.
 */
export function visibleMarkerRange(
  markers: readonly Marker[],
  zoom: number,
  scrollLeft: number,
  width: number,
): { from: number; to: number } {
  if (markers.length === 0 || zoom <= 0) return { from: 0, to: 0 };
  // a flag extends to the right of its pole, so markers up to MAX_FLAG_W px left of the view can show
  const t0 = (scrollLeft - MAX_FLAG_W - POLE_SLOP) / zoom;
  const t1 = (scrollLeft + width + POLE_SLOP) / zoom;
  const from = lowerBound(markers, t0);
  let to = from;
  while (to < markers.length && markers[to]!.time <= t1) to++;
  return { from, to };
}

/**
 * the marker under a point in the ruler. x is in lane space (px from the start of the timeline),
 * y is px from the top of the ruler. the flag zone is the top FLAG_H px, the pole is hit anywhere.
 * later markers are drawn on top, so they win.
 */
export function hitMarker(markers: readonly Marker[], zoom: number, x: number, y: number): Marker | null {
  if (markers.length === 0 || zoom <= 0) return null;
  const { from, to } = visibleMarkerRange(markers, zoom, x, 0);
  for (let i = to - 1; i >= from; i--) {
    const m = markers[i]!;
    const mx = m.time * zoom;
    if (Math.abs(x - mx) <= POLE_SLOP) return m;
    if (y >= 0 && y <= FLAG_H && x >= mx && x <= mx + flagWidth(m.name)) return m;
  }
  return null;
}

/** all marker times, optionally skipping one (the marker being dragged) */
export function markerTimes(markers: readonly Marker[] | undefined, skipId?: string): number[] {
  if (!markers) return [];
  const out: number[] = [];
  for (const m of markers) if (m.id !== skipId) out.push(m.time);
  return out;
}

/**
 * snap times for clip moves, trims and scrubbing: clip edges, 0, the extras (playhead) and every
 * marker. sorted and unique.
 */
export function timelineSnapPoints(
  project: Pick<Project, 'clips' | 'markers'>,
  ignoreIds: readonly string[] = [],
  extra: readonly number[] = [],
  skipMarkerId?: string,
): number[] {
  return collectSnapPoints(project, ignoreIds, [...extra, ...markerTimes(project.markers, skipMarkerId)]);
}
