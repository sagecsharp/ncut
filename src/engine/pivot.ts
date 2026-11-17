/**
 * a clip's pivot (Spatial.pivot): the point it rotates and scales around, as fractions of its own box from its middle.
 * the pivot is the clip's position: transform x / y / z say where it is and attached clips count from it, so
 * engine/parent.ts never sees it. only the picture hangs off it: getClipBox gives px / py, pictureBox moves a flat box
 * to its middle, clipModelMatrix adds T(-px, -py, 0) after the spin. pure.
 */
import type { Pivot, Transform } from '../types';
import type { ClipBox } from './draw';
import { DEG, type Vec3 } from './scene3d/math';

/** each axis of a pivot stays inside -PIVOT_MAX..PIVOT_MAX (box sides from the middle) */
export const PIVOT_MAX = 10;

export interface PivotSpot {
  /** the mcp name */
  id: string;
  /** the ui name */
  label: string;
  x: number;
  y: number;
}

/** the nine spots of a box in reading order, top left first */
export const PIVOT_SPOTS: readonly PivotSpot[] = [
  { id: 'top-left', label: 'top left', x: -0.5, y: -0.5 },
  { id: 'top', label: 'top', x: 0, y: -0.5 },
  { id: 'top-right', label: 'top right', x: 0.5, y: -0.5 },
  { id: 'left', label: 'left', x: -0.5, y: 0 },
  { id: 'middle', label: 'middle', x: 0, y: 0 },
  { id: 'right', label: 'right', x: 0.5, y: 0 },
  { id: 'bottom-left', label: 'bottom left', x: -0.5, y: 0.5 },
  { id: 'bottom', label: 'bottom', x: 0, y: 0.5 },
  { id: 'bottom-right', label: 'bottom right', x: 0.5, y: 0.5 },
];

/** spot indices in the order "where they meet" prefers when two pairs are equally near: edge middles, corners, middle */
export const MEET_ORDER: readonly number[] = [3, 5, 1, 7, 0, 2, 6, 8, 4];

const round4 = (n: number): number => {
  const r = Math.round(n * 1e4) / 1e4;
  return r === 0 ? 0 : r;
};

/** one axis of a stored pivot: a finite number inside the range, anything else 0 */
export function pivotFraction(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  return v < -PIVOT_MAX ? -PIVOT_MAX : v > PIVOT_MAX ? PIVOT_MAX : v;
}

/** a pivot as it is stored: both axes cleaned and rounded to 4 decimals. null for the middle or anything that is not an object */
export function normalizePivot(v: unknown): Pivot | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as { x?: unknown; y?: unknown };
  const x = round4(pivotFraction(o.x));
  const y = round4(pivotFraction(o.y));
  return x === 0 && y === 0 ? null : { x, y };
}

/** the pivot fractions of a clip, 0 0 when it has none */
export function pivotOf(clip: { pivot?: Pivot | null }): { x: number; y: number } {
  const p = clip.pivot;
  return p ? { x: pivotFraction(p.x), y: pivotFraction(p.y) } : { x: 0, y: 0 };
}

/** two stored pivots that mean the same point (missing, null and 0 0 are all the middle) */
export function samePivot(a: unknown, b: unknown): boolean {
  const na = normalizePivot(a);
  const nb = normalizePivot(b);
  if (!na || !nb) return na === nb;
  return na.x === nb.x && na.y === nb.y;
}

/** the spot a pivot sits on exactly: the middle for none, null for a point of its own */
export function spotOf(p: unknown): PivotSpot | null {
  const n = normalizePivot(p);
  const x = n?.x ?? 0;
  const y = n?.y ?? 0;
  return PIVOT_SPOTS.find((s) => s.x === x && s.y === y) ?? null;
}

/** the rectangle the picture of a flat clip fills: the box moved from its pivot to its middle. the same object without a pivot */
export function pictureBox(box: ClipBox): ClipBox {
  const px = box.px ?? 0;
  const py = box.py ?? 0;
  if (px === 0 && py === 0) return box;
  const a = box.rotation * DEG;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { cx: box.cx - (px * c - py * s), cy: box.cy - (px * s + py * c), width: box.width, height: box.height, rotation: box.rotation };
}

/** a row-major 3x3 in float64 (the model matrices are float32, which would blur the exact keep place) */
type Rot3 = readonly [number, number, number, number, number, number, number, number, number];

const mul3 = (a: Rot3, b: Rot3): Rot3 => {
  const o: number[] = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o.push(a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!);
  return o as unknown as Rot3;
};

/** the turn of a clip's own axes as clipModelMatrix applies it: turn (rotY) * tilt (rotX) * spin, in float64. tilt and turn only for a 3d clip */
function ownTurn(t: Transform, threeD: boolean): Rot3 {
  const a = (t.rotation || 0) * DEG;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const spin: Rot3 = [c, -s, 0, s, c, 0, 0, 0, 1];
  if (!threeD || (!t.rotX && !t.rotY)) return spin;
  const ay = -(t.rotY ?? 0) * DEG;
  const ax = -(t.rotX ?? 0) * DEG;
  const cy = Math.cos(ay);
  const sy = Math.sin(ay);
  const cx = Math.cos(ax);
  const sx = Math.sin(ax);
  const turn: Rot3 = [cy, 0, sy, 0, 1, 0, -sy, 0, cy];
  const tilt: Rot3 = [1, 0, 0, 0, cx, -sx, 0, sx, cx];
  return mul3(mul3(turn, tilt), spin);
}

/**
 * the step from a clip's picture middle to its pivot, in its parent's frame units (or canvas px without a parent):
 * the clip's own turn applied to (px, py, 0). z is 0 for a 2d clip.
 */
export function pivotOffset(t: Transform, threeD: boolean, px: number, py: number): Vec3 {
  if (px === 0 && py === 0) return [0, 0, 0];
  const m = ownTurn(t, threeD);
  return [m[0] * px + m[1] * py, m[3] * px + m[4] * py, m[6] * px + m[7] * py];
}

/** a step given in the parent's frame turned back into the clip's own axes (the inverse of the turn of pivotOffset) */
export function unturn(t: Transform, threeD: boolean, v: Vec3): Vec3 {
  const m = ownTurn(t, threeD);
  // a pure rotation: the inverse is the transpose (row-major, m[row * 3 + col])
  return [
    m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
    m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
    m[2] * v[0] + m[5] * v[1] + m[8] * v[2],
  ];
}
