/* the pure side of the grade wheels and the grade curves: the drag maths, the texts, the key plan, the point list rules. */
import type { ClipGrade, GradeCurves, GradePoint, Keyframes } from '../../types';
import { GRADE_EPS, GRADE_WHEELS, MAX_CURVE_POINTS, MIN_POINT_GAP, isCurveNeutral, isHueKind, isToneKind } from '../../lib/gradeData';
import type { CurveKind, GradeKey, GradeWheelName } from '../../lib/gradeData';
import { HUE_RED, TAU, curveSampler, hueColor, lumaOf, puckOf, rgbFromPuck } from '../../lib/gradeMath';
import type { Rgb3 } from '../../lib/gradeMath';
import type { FeelEntry } from './fieldFeel';

export type WheelId = GradeWheelName;

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const round4 = (v: number): number => Math.round(v * 1e4) / 1e4;
const fract = (x: number): number => x - Math.floor(x);
const copyPoint = (p: GradePoint): GradePoint => [p[0], p[1]];

/* ---------- wheels ---------- */

/** a press on a wheel: where the dot was (x0, y0, the face is -1..1, y up) and where the pointer was */
export interface WheelGrab {
  wheel: WheelId;
  rgb: Rgb3;
  x0: number;
  y0: number;
  px: number;
  py: number;
  fine: boolean;
}

/** the dot of rgb is where the drag starts (a dot past the rim starts on the rim) */
export function grabWheel(wheel: WheelId, rgb: Rgb3, px: number, py: number, fine: boolean): WheelGrab {
  const { x, y } = puckOf(rgb);
  return { wheel, rgb: [rgb[0], rgb[1], rgb[2]], x0: x, y0: y, px, py, fine };
}

/**
 * the color of the dot after the pointer moved to (px, py): relative to the press, a radius of pointer is the whole face
 * (a tenth of it when fine). hueSteps turns the angle to 15 degree steps. the luma part of the grab stays.
 */
export function dragWheel(g: WheelGrab, px: number, py: number, radiusPx: number, hueSteps: boolean): Rgb3 {
  const dx = px - g.px;
  const dy = py - g.py;
  if (dx === 0 && dy === 0) return [g.rgb[0], g.rgb[1], g.rgb[2]];
  const k = (g.fine ? 0.1 : 1) / Math.max(1, radiusPx);
  let x = g.x0 + dx * k;
  let y = g.y0 - dy * k;
  let len = Math.hypot(x, y);
  if (len > 1) {
    x /= len;
    y /= len;
    len = 1;
  }
  if (hueSteps && len > 0) {
    const step = Math.PI / 12;
    const a = Math.round(Math.atan2(y, x) / step) * step;
    x = Math.cos(a) * len;
    y = Math.sin(a) * len;
  }
  return rgbFromPuck(x, y, lumaOf(g.rgb[0], g.rgb[1], g.rgb[2]));
}

/** an arrow key moves the dot a hundredth of the face (a tenth when big), up is +y. the luma part stays */
export function nudgeWheel(rgb: Rgb3, key: string, big: boolean): Rgb3 {
  const step = big ? 0.1 : 0.01;
  const { x, y } = puckOf(rgb);
  let nx = x;
  let ny = y;
  if (key === 'ArrowLeft') nx -= step;
  else if (key === 'ArrowRight') nx += step;
  else if (key === 'ArrowUp') ny += step;
  else if (key === 'ArrowDown') ny -= step;
  else return [rgb[0], rgb[1], rgb[2]];
  return rgbFromPuck(nx, ny, lumaOf(rgb[0], rgb[1], rgb[2]));
}

/** a stored number as a hundred times, one decimal, a plus above 0 */
function hundreds(v: number): string {
  const n = Math.round(v * 1000) / 10;
  if (n === 0) return '0.0';
  return `${n > 0 ? '+' : ''}${n.toFixed(1)}`;
}

/** 'r +2.1 g -0.8 b -1.3', or 'no change' */
export function wheelText(rgb: Rgb3): string {
  const t = rgb.map(hundreds);
  if (t.every((s) => s === '0.0')) return 'no change';
  return `r ${t[0]} g ${t[1]} b ${t[2]}`;
}

/** 'lift: red +2.1, green -0.8, blue -1.3, level 0.0' */
export function wheelAria(wheel: WheelId, rgb: Rgb3, level: number): string {
  return `${wheel}: red ${hundreds(rgb[0])}, green ${hundreds(rgb[1])}, blue ${hundreds(rgb[2])}, level ${hundreds(level)}`;
}

const wheelProps = (wheel: WheelId): string[] => [`grade.${wheel}R`, `grade.${wheel}G`, `grade.${wheel}B`];

/** the keys of a wheel's r g b: none, some (keyed, but not all three at the playhead) or full (all three here). local is clip time */
export function wheelKeyState(kf: Keyframes | undefined, wheel: WheelId, local: number, tol: number): 'none' | 'half' | 'full' {
  let any = false;
  let here = 0;
  for (const prop of wheelProps(wheel)) {
    const keys = kf?.[prop];
    if (!keys || keys.length === 0) continue;
    any = true;
    if (keys.some((k) => Math.abs(k.t - local) <= tol)) here++;
  }
  if (here === 3) return 'full';
  return any ? 'half' : 'none';
}

/** the diamond: all three keyed here: take the three off, else add the ones that are missing here */
export function wheelKeyPlan(kf: Keyframes | undefined, wheel: WheelId, local: number, tol: number): { add: string[]; remove: string[] } {
  const props = wheelProps(wheel);
  if (wheelKeyState(kf, wheel, local, tol) === 'full') return { add: [], remove: props };
  return { add: props.filter((p) => !(kf?.[p] ?? []).some((k) => Math.abs(k.t - local) <= tol)), remove: [] };
}

const hueCss = (h: number): string => {
  const c = hueColor(h);
  return `rgb(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)})`;
};

/** the hue ring of a wheel: red sits where the vectorscope puts it, the hues run clockwise */
export function wheelRingCss(): string {
  const from = (90 - (HUE_RED * 360) / TAU).toFixed(1);
  const stops: string[] = [];
  for (let i = 0; i <= 12; i++) stops.push(`${hueCss(fract(-i / 12))} ${i * 30}deg`);
  return `conic-gradient(from ${from}deg, ${stops.join(', ')})`;
}

/** the hues in order, left to right, for the strip under the hue tabs */
export function hueStripCss(): string {
  const stops: string[] = [];
  for (let i = 0; i <= 12; i++) stops.push(`${hueCss(i / 12)} ${((i / 12) * 100).toFixed(1)}%`);
  return `linear-gradient(to right, ${stops.join(', ')})`;
}

/* ---------- the point lists ---------- */

/** the stored list of a kind as a copy. a tone list is the two corners when nothing is stored, the others are empty */
export function pointsOf(grade: ClipGrade | null | undefined, kind: CurveKind): GradePoint[] {
  const list = grade?.curves?.[kind];
  if (Array.isArray(list) && list.length > 0) return list.map(copyPoint);
  return isToneKind(kind) ? [[0, 0], [1, 1]] : [];
}

/** a point in the box, y up: out of 0..1 into pixels */
export function toPx(p: GradePoint, w: number, h: number): { x: number; y: number } {
  return { x: p[0] * w, y: (1 - p[1]) * h };
}

/** pixels in the box into 0..1, y up */
export function fromPx(x: number, y: number, w: number, h: number): GradePoint {
  return [clamp01(w > 0 ? x / w : 0), clamp01(h > 0 ? 1 - y / h : 0)];
}

/** the point under the pixel (the nearest within r), -1 for none */
export function hitPoint(pts: readonly GradePoint[], px: number, py: number, w: number, h: number, r = 8): number {
  let best = -1;
  let bestD = r;
  for (let i = 0; i < pts.length; i++) {
    const q = toPx(pts[i]!, w, h);
    const d = Math.hypot(q.x - px, q.y - py);
    if (d <= bestD) {
      best = i;
      bestD = d;
    }
  }
  return best;
}

/** the x distance of two points of a list (a hue list wraps) */
function gapOf(kind: CurveKind, a: number, b: number): number {
  const d = Math.abs(a - b);
  return isHueKind(kind) ? Math.min(d, 1 - d) : d;
}

const hasRoom = (kind: CurveKind, pts: readonly GradePoint[], x: number): boolean => pts.every((p) => gapOf(kind, p[0], x) >= MIN_POINT_GAP - 1e-9);

/** the list with one more point, and where it sits in it */
function put(pts: readonly GradePoint[], p: GradePoint): { pts: GradePoint[]; sel: number } {
  const next = [...pts.map(copyPoint), p].sort((a, b) => a[0] - b[0]);
  return { pts: next, sel: next.indexOf(p) };
}

/**
 * a point at x, on the line as it is. a hue list also gets a quiet point a twelfth to each side, luma vs sat an eighth
 * (where there is room), so the point alone does not pull the line. null at 16 points or when x is too close to one
 */
export function addPoint(kind: CurveKind, pts: readonly GradePoint[], x: number): { pts: GradePoint[]; sel: number } | null {
  if (pts.length >= MAX_CURVE_POINTS) return null;
  const hue = isHueKind(kind);
  const px = hue ? round4(fract(x)) : round4(clamp01(x));
  if (!hasRoom(kind, pts, px)) return null;
  const line = curveSampler(kind, pts);
  const main: GradePoint = [px, round4(line(px))];
  let list: GradePoint[] = [...pts.map(copyPoint), main];
  const side = hue ? 1 / 12 : kind === 'lumaSat' ? 0.125 : 0;
  if (side > 0) {
    for (const dir of [-1, 1]) {
      let nx = px + dir * side;
      if (hue) nx = fract(nx);
      else if (nx < 0 || nx > 1) continue;
      nx = round4(nx);
      if (list.length >= MAX_CURVE_POINTS || !hasRoom(kind, list, nx)) continue;
      list.push([nx, round4(line(nx))]);
    }
  }
  list = list.sort((a, b) => a[0] - b[0]);
  return { pts: list, sel: list.indexOf(main) };
}

/** a point halfway to the next one, on the line (after the last point of a hue list: halfway round). null when there is no room */
export function insertAfter(kind: CurveKind, pts: readonly GradePoint[], i: number): { pts: GradePoint[]; sel: number } | null {
  const n = pts.length;
  if (n >= MAX_CURVE_POINTS || i < 0 || i >= n) return null;
  const hue = isHueKind(kind);
  let next: number;
  if (i + 1 < n) next = pts[i + 1]![0];
  else if (hue) next = pts[0]![0] + 1;
  else return null;
  let x = (pts[i]![0] + next) / 2;
  if (hue) x = fract(x);
  x = round4(x);
  if (!hasRoom(kind, pts, x)) return null;
  return put(pts, [x, round4(curveSampler(kind, pts)(x))]);
}

/**
 * point i to (x, y): y stays 0..1, x between the neighbours with the gap kept. a tone list keeps the x of its two ends,
 * a hue list keeps its first point at 0 or more and its last at 0.99 or less, and the gap across the wrap
 */
export function movePoint(kind: CurveKind, pts: readonly GradePoint[], i: number, x: number, y: number): GradePoint[] {
  const out = pts.map(copyPoint);
  if (i < 0 || i >= out.length) return out;
  const last = out.length - 1;
  const ny = round4(clamp01(y));
  if (isToneKind(kind) && (i === 0 || i === last)) {
    out[i] = [out[i]![0], ny];
    return out;
  }
  // a hue list wraps: the first point stays a gap away from the last one across the wrap, or the last one is dropped
  const lo = i > 0 ? out[i - 1]![0] + MIN_POINT_GAP : isHueKind(kind) && last > 0 ? Math.max(0, out[last]![0] - 1 + MIN_POINT_GAP) : 0;
  const hi = i < last ? out[i + 1]![0] - MIN_POINT_GAP : isHueKind(kind) ? 0.99 : 1;
  out[i] = [round4(Math.max(lo, Math.min(hi, x))), ny];
  return out;
}

/** a point taken off. the end of a tone list goes back to its corner instead */
export function removePoint(kind: CurveKind, pts: readonly GradePoint[], i: number): GradePoint[] {
  const out = pts.map(copyPoint);
  if (i < 0 || i >= out.length) return out;
  if (isToneKind(kind)) {
    if (i === 0) {
      out[0] = [0, 0];
      return out;
    }
    if (i === out.length - 1) {
      out[i] = [1, 1];
      return out;
    }
  }
  out.splice(i, 1);
  return out;
}

/** an arrow key: x by a 255th (a 360th on a hue), y by a 255th, ten times that when big */
export function nudgePoint(kind: CurveKind, pts: readonly GradePoint[], i: number, key: string, big: boolean): GradePoint[] {
  const p = pts[i];
  if (!p) return pts.map(copyPoint);
  const k = big ? 10 : 1;
  const sx = (isHueKind(kind) ? 1 / 360 : 1 / 255) * k;
  const sy = (1 / 255) * k;
  let dx = 0;
  let dy = 0;
  if (key === 'ArrowLeft') dx = -sx;
  else if (key === 'ArrowRight') dx = sx;
  else if (key === 'ArrowUp') dy = sy;
  else if (key === 'ArrowDown') dy = -sy;
  else return pts.map(copyPoint);
  return movePoint(kind, pts, i, p[0] + dx, p[1] + dy);
}

/** the point before (dir -1) or after (dir 1), wrapping round. -1 for an empty list */
export function stepPoint(pts: readonly GradePoint[], i: number, dir: -1 | 1): number {
  const n = pts.length;
  if (n === 0) return -1;
  if (i < 0 || i >= n) return dir > 0 ? 0 : n - 1;
  return (((i + dir) % n) + n) % n;
}

/* ---------- the point fields ---------- */

export interface PointField {
  label: string;
  title: string;
  feel: FeelEntry;
  /** stored 0..1 into the shown number */
  toShown(v: number): number;
  /** the shown number into stored 0..1 */
  fromShown(v: number): number;
}

const rounder = (k: number) => (v: number): number => Math.round(v * k);
const levelEntry: FeelEntry = { unit: '', min: 0, max: 255, soft: [0, 255], step: 1, precision: 0 };
const hueEntry: FeelEntry = { unit: 'deg', min: 0, max: 360, soft: [0, 360], step: 1, precision: 0 };
const satEntry: FeelEntry = { unit: '%', min: 0, max: 200, soft: [0, 200], step: 1, precision: 0, rest: 100 };
const shiftEntry: FeelEntry = { unit: 'deg', min: -180, max: 180, soft: [-180, 180], step: 1, precision: 0, rest: 0 };

const levelField = (label: string, title: string): PointField => ({ label, title, feel: levelEntry, toShown: rounder(255), fromShown: (v) => v / 255 });
const hueField: PointField = { label: 'hue', title: 'the hue of the picked point (0 to 360 degrees, from red toward yellow)', feel: hueEntry, toShown: rounder(360), fromShown: (v) => v / 360 };
const satField: PointField = { label: 'sat', title: 'the saturation at the picked point (100 keeps it, 0 is gray, 200 doubles it)', feel: satEntry, toShown: rounder(200), fromShown: (v) => v / 200 };
const shiftField: PointField = { label: 'shift', title: 'how far the picked hue turns (-180 to 180 degrees)', feel: shiftEntry, toShown: (v) => Math.round((v - 0.5) * 360), fromShown: (v) => v / 360 + 0.5 };

/** the two number boxes of the picked point: [x, y] */
export function pointFields(kind: CurveKind): readonly [PointField, PointField] {
  switch (kind) {
    case 'hueSat':
      return [hueField, satField];
    case 'hueHue':
      return [hueField, shiftField];
    case 'lumaSat':
      return [levelField('luma', 'the luma of the picked point (0 to 255)'), satField];
    default:
      return [levelField('in', 'the level that goes in at the picked point (0 to 255)'), levelField('out', 'the level that comes out at the picked point (0 to 255)')];
  }
}

/* ---------- the grade as a whole ---------- */

/** the whole grade with one list of the curves replaced (null takes that list off) */
export function curvesPatch(grade: ClipGrade | null | undefined, kind: CurveKind, pts: GradePoint[] | null): ClipGrade {
  const out: ClipGrade = { ...(grade ?? {}) };
  const curves: GradeCurves = { ...(out.curves ?? {}) };
  if (pts) curves[kind] = pts.map(copyPoint);
  else delete curves[kind];
  if (Object.keys(curves).length > 0) out.curves = curves;
  else delete out.curves;
  return out;
}

/** a path through the line of a list, n steps over a box of w x h, y up */
export function curvePath(kind: CurveKind, pts: readonly GradePoint[], w: number, h: number, n = 64): string {
  const line = curveSampler(kind, pts);
  const parts: string[] = [];
  for (let i = 0; i <= n; i++) {
    const x = i / n;
    parts.push(`${i === 0 ? 'M' : 'L'}${(x * w).toFixed(1)} ${((1 - line(x)) * h).toFixed(1)}`);
  }
  return parts.join(' ');
}

/** the names of the seven tabs, in order */
export const CURVE_TABS: readonly { kind: CurveKind; label: string }[] = [
  { kind: 'y', label: 'luma' },
  { kind: 'r', label: 'red' },
  { kind: 'g', label: 'green' },
  { kind: 'b', label: 'blue' },
  { kind: 'hueSat', label: 'hue vs sat' },
  { kind: 'hueHue', label: 'hue vs hue' },
  { kind: 'lumaSat', label: 'luma vs sat' },
];

/** 'lift, luma curves', 'lift, gain, 2 curves' or 'nothing set yet'. a lut is named in its place: 'lut film, lift' (first) or 'lift, lut film' (last). name null = the lut is gone from the media */
export function gradeSummary(values: Readonly<Record<GradeKey, number>>, curves: GradeCurves | null | undefined, lut?: { name: string | null; last: boolean } | null): string {
  const parts: string[] = [];
  const lutText = lut ? (lut.name === null ? 'missing lut' : `lut ${lut.name}`) : '';
  if (lut && !lut.last) parts.push(lutText);
  for (const wheel of GRADE_WHEELS) {
    const set = (['R', 'G', 'B', 'Y'] as const).some((p) => Math.abs(values[`${wheel}${p}` as GradeKey] ?? 0) >= GRADE_EPS);
    if (set) parts.push(wheel);
  }
  const lists = CURVE_TABS.filter((t) => !isCurveNeutral(t.kind, curves?.[t.kind]));
  if (lists.length === 1) parts.push(`${lists[0]!.label} curves`);
  else if (lists.length > 1) parts.push(`${lists.length} curves`);
  if (lut?.last) parts.push(lutText);
  return parts.length > 0 ? parts.join(', ') : 'nothing set yet';
}
