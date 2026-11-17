/** the crossfade box in a lane. pure: where it sits, what it draws, the spans of a lane */
import type { FadeShape, Project } from '../../types';
import { crossfadeSpan, shapeIn } from '../../lib/audioCross';
import type { CrossfadeSpan } from '../../lib/audioCross';
import { CLIP_INSET } from './layout';

export interface BoxGeo {
  /** lane px */
  x: number;
  width: number;
  /** lane px of the edit */
  editX: number;
  /** the asked part that does not fit, lane px */
  ghosts: { x: number; width: number }[];
  /** nothing plays: a thin mark on the edit */
  notch: boolean;
  grips: boolean;
}

/** the height of the transition band (TransitionMarker's BAND_H, repeated: the box sits right under it) */
const BAND_H = 14;
const MIN_H = 8;
const MIN_W = 8;
const NOTCH_W = 7;
/** the ends and the middle drag from this width on */
const GRIP_MIN_W = 14;
const POINTS = 16;

const NONE: readonly CrossfadeSpan[] = Object.freeze([]);

/** the box rows in a lane of laneH px: from 1 px under the transition band to the lane's inset, at least 8 px */
export function boxRows(laneH: number): { top: number; h: number } {
  const band = CLIP_INSET + Math.round((laneH - CLIP_INSET * 2 - BAND_H) / 2);
  const top = band + BAND_H + 1;
  const h = laneH - CLIP_INSET - top;
  return h < MIN_H ? { top: laneH - CLIP_INSET - MIN_H, h: MIN_H } : { top, h };
}

export function boxGeo(span: CrossfadeSpan, zoom: number, _laneH: number): BoxGeo {
  const editX = span.edit * zoom;
  const ghosts: { x: number; width: number }[] = [];
  const gb = (span.wantBefore - span.before) * zoom;
  const ga = (span.wantAfter - span.after) * zoom;
  if (gb >= 1 - 1e-6) ghosts.push({ x: (span.start - (span.wantBefore - span.before)) * zoom, width: gb });
  if (ga >= 1 - 1e-6) ghosts.push({ x: span.end * zoom, width: ga });
  if (!span.plays) return { x: editX - NOTCH_W / 2, width: NOTCH_W, editX, ghosts, notch: true, grips: false };
  const width = Math.max(MIN_W, (span.end - span.start) * zoom);
  return { x: span.start * zoom, width, editX, ghosts, notch: false, grips: width >= GRIP_MIN_W - 1e-6 };
}

const fix = (n: number): number => Math.round(n * 100) / 100;

/** the two curves over the whole box as polyline points: out (falling) and in (rising), the sound's own math */
export function shapePoints(shape: FadeShape, w: number, h: number, _editFrac: number): { out: string; in: string } {
  const out: string[] = [];
  const rise: string[] = [];
  for (let i = 0; i <= POINTS; i++) {
    const u = i / POINTS;
    const x = fix(u * w);
    out.push(`${x},${fix((1 - shapeIn(shape, 1 - u)) * h)}`);
    rise.push(`${x},${fix((1 - shapeIn(shape, u)) * h)}`);
  }
  return { out: out.join(' '), in: rise.join(' ') };
}

const SPAN_KEYS: readonly (keyof CrossfadeSpan)[] = [
  'start', 'end', 'edit', 'shape', 'fromId', 'toId', 'trackId', 'before', 'after', 'wantBefore', 'wantAfter', 'roomBefore', 'roomAfter',
  'shortBefore', 'shortAfter', 'withTransition', 'plays',
];

const sameSpans = (a: readonly CrossfadeSpan[], b: readonly CrossfadeSpan[]): boolean =>
  a.length === b.length && a.every((s, i) => SPAN_KEYS.every((k) => s[k] === b[i]![k]));

/** per project: the spans of every track, built in one pass */
const byProject = new WeakMap<Project, Map<string, CrossfadeSpan[]>>();
/** per track: the last answer, kept while the next one is equal by value (a selector that gets a fresh array every time loops) */
const lastOf = new Map<string, readonly CrossfadeSpan[]>();

function build(p: Project): Map<string, CrossfadeSpan[]> {
  const hit = byProject.get(p);
  if (hit) return hit;
  const map = new Map<string, CrossfadeSpan[]>();
  for (const c of p.clips) {
    if ((c.type !== 'video' && c.type !== 'audio') || !c.crossfade) continue;
    const s = crossfadeSpan(p, c);
    if (!s) continue;
    const list = map.get(s.trackId);
    if (list) list.push(s);
    else map.set(s.trackId, [s]);
  }
  for (const list of map.values()) list.sort((a, b) => a.edit - b.edit);
  byProject.set(p, map);
  return map;
}

/** the crossfade spans of a lane. one shared empty array when there are none, else the same array while its values are the same */
export function laneCrossfades(p: Project | null, trackId: string): readonly CrossfadeSpan[] {
  if (!p) return NONE;
  const list = build(p).get(trackId);
  if (!list) {
    lastOf.delete(trackId);
    return NONE;
  }
  const last = lastOf.get(trackId);
  if (last && sameSpans(last, list)) return last;
  lastOf.set(trackId, list);
  return list;
}
