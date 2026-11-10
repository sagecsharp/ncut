/**
 * pure planning for the sequence tools: lay clips end to end, fit them to the markers, find the
 * markers a clip can be cut at. no store, no dom, so it is unit tested.
 */

/** a clip as the planner sees it */
export interface SeqClip {
  id: string;
  start: number;
  duration: number;
  /** the longest this clip can be (Infinity for stills, text, shapes) */
  maxDuration: number;
}

/** where a clip goes */
export interface SeqPlace {
  id: string;
  start: number;
  duration: number;
}

export interface FitPlan {
  places: SeqPlace[];
  /** clips whose source is shorter than their beat (they kept their length) */
  short: number;
  /** clips that start on a marker */
  onMarkers: number;
}

const EPS = 1e-6;

/** order for a row: by start, ties by layer (smaller = higher on screen) */
export function orderForRow<T extends { start: number; layer: number }>(clips: readonly T[]): T[] {
  return [...clips].sort((a, b) => a.start - b.start || a.layer - b.layer);
}

/** the clips (already in order) end to end, starting where the earliest one starts. lengths are kept. */
export function planRow(clips: readonly SeqClip[]): SeqPlace[] {
  if (clips.length === 0) return [];
  let cursor = Math.min(...clips.map((c) => c.start));
  return clips.map((c) => {
    const p = { id: c.id, start: cursor, duration: c.duration };
    cursor += c.duration;
    return p;
  });
}

/** sorted, unique, finite marker times */
function cleanTimes(times: readonly number[]): number[] {
  const out = [...times].filter((t) => Number.isFinite(t) && t >= 0).sort((a, b) => a - b);
  return out.filter((t, i) => i === 0 || t - out[i - 1]! > EPS);
}

/**
 * clip i starts on a marker and ends on the marker `span` markers later (its length becomes the gap).
 * the first marker is the first one at or after the earliest start. a gap shorter than `minDuration`
 * reaches on to the next marker. a clip whose source is shorter than the gap keeps its length (the
 * next one still starts on its marker). when the markers run out the rest keep their length and follow
 * end to end. clips are in order already.
 */
export function planFit(clips: readonly SeqClip[], markerTimes: readonly number[], span: number, minDuration: number): FitPlan {
  const places: SeqPlace[] = [];
  if (clips.length === 0) return { places, short: 0, onMarkers: 0 };
  const m = cleanTimes(markerTimes);
  const base = Math.min(...clips.map((c) => c.start));
  const step = Math.max(1, Math.round(span));
  let idx = 0;
  while (idx < m.length && m[idx]! < base - EPS) idx++;
  let cursor = base;
  let short = 0;
  let onMarkers = 0;
  for (const c of clips) {
    if (idx >= m.length) {
      places.push({ id: c.id, start: cursor, duration: c.duration });
      cursor += c.duration;
      continue;
    }
    const start = m[idx]!;
    onMarkers++;
    let j = idx + step;
    while (j < m.length && m[j]! - start < minDuration - EPS) j++;
    if (j >= m.length) {
      // no marker left to end on: keep the length, nothing follows a marker any more
      places.push({ id: c.id, start, duration: c.duration });
      cursor = start + c.duration;
      idx = m.length;
      continue;
    }
    const gap = m[j]! - start;
    if (c.maxDuration + EPS < gap) {
      short++;
      places.push({ id: c.id, start, duration: c.duration });
    } else {
      places.push({ id: c.id, start, duration: gap });
    }
    cursor = start + gap;
    idx = j;
  }
  return { places, short, onMarkers };
}

/** the marker times strictly inside a clip, `margin` away from both edges, sorted and unique */
export function markersInside(markerTimes: readonly number[], start: number, end: number, margin: number): number[] {
  return cleanTimes(markerTimes).filter((t) => t > start + margin && t < end - margin);
}
