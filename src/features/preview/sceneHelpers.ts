/**
 * pure math of the scene view's helpers: the focus plane of a camera (frustum cross-sections at the focus
 * distance), the floor grid and world axis lines that follow the orbit distance, axis lock keys for the move
 * tool and the text of the live readouts. no dom, tested in node.
 */
import type { Vec3 } from '../../engine/scene3d/math';

/* ---------- focus plane ---------- */

/** the part of a camera rig the cross-section needs */
export interface RigAxes {
  eye: Vec3;
  right: Vec3;
  down: Vec3;
  forward: Vec3;
  tanHalf: number;
  aspect: number;
}

/** the 4 world corners (tl, tr, br, bl) of the camera's view pyramid cut at `distance` along its forward axis */
export function sectionCorners(rig: RigAxes, distance: number): [Vec3, Vec3, Vec3, Vec3] {
  const hx = rig.tanHalf * rig.aspect * distance;
  const hy = rig.tanHalf * distance;
  const cx = rig.eye[0] + rig.forward[0] * distance;
  const cy = rig.eye[1] + rig.forward[1] * distance;
  const cz = rig.eye[2] + rig.forward[2] * distance;
  const at = (sx: number, sy: number): Vec3 => [
    cx + rig.right[0] * sx * hx + rig.down[0] * sy * hy,
    cy + rig.right[1] * sx * hx + rig.down[1] * sy * hy,
    cz + rig.right[2] * sx * hx + rig.down[2] * sy * hy,
  ];
  return [at(-1, -1), at(1, -1), at(1, 1), at(-1, 1)];
}

export interface FocusPlane {
  distance: number;
  kind: 'focus' | 'near' | 'far';
}

/**
 * the rectangles to draw for a focus: the sharp distance, and when the sharp zone has a size the two edges of it.
 * `range` is a HALF depth (focus.ts: dz = |depth - distance| - range), so the edges sit at distance +- range.
 * the near edge is held at `minDistance` or more (it can never be behind the lens).
 */
export function focusPlanes(focus: { distance: number; range: number }, minDistance = 1): FocusPlane[] {
  const planes: FocusPlane[] = [{ distance: focus.distance, kind: 'focus' }];
  if (focus.range > 0) {
    planes.push({ distance: Math.max(minDistance, focus.distance - focus.range), kind: 'near' });
    planes.push({ distance: focus.distance + focus.range, kind: 'far' });
  }
  return planes;
}

/** new focus distance for a drag along the view axis: start value plus the pointer's travel, rounded and kept in range */
export function focusFromDrag(d0: number, t0: number, t1: number, min: number, max: number): number {
  const v = Math.round(d0 + (t1 - t0));
  return Math.min(max, Math.max(min, Number.isFinite(v) ? v : d0));
}

/* ---------- floor grid and world axes ---------- */

/** a "nice" step (1, 2 or 5 times a power of ten) that is at least `raw` */
export function niceStep(raw: number): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p;
  const k = m <= 1 + 1e-9 ? 1 : m <= 2 + 1e-9 ? 2 : m <= 5 + 1e-9 ? 5 : 10;
  return k * p;
}

/** grid spacing for an orbit distance: about five cells between the target and the eye */
export function floorGridStep(orbitDistance: number): number {
  return niceStep(orbitDistance / 5);
}

/** grid lines on each side of the center, per direction (the whole grid never has more than 2 * (2N + 1) + 2 segments) */
export const GRID_HALF_LINES = 12;

/**
 * the part of a world segment that is at least `nearDist` in front of the eye along `forward`, or null when none of
 * it is. writes into `out` (6 numbers: ax ay az bx by bz) and returns it.
 */
export function clipSegmentNear(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  eye: Vec3,
  forward: Vec3,
  nearDist: number,
  out: number[] = [0, 0, 0, 0, 0, 0],
): number[] | null {
  const da = (ax - eye[0]) * forward[0] + (ay - eye[1]) * forward[1] + (az - eye[2]) * forward[2];
  const db = (bx - eye[0]) * forward[0] + (by - eye[1]) * forward[1] + (bz - eye[2]) * forward[2];
  if (da < nearDist && db < nearDist) return null;
  let x1 = ax;
  let y1 = ay;
  let z1 = az;
  let x2 = bx;
  let y2 = by;
  let z2 = bz;
  if (da < nearDist) {
    const t = (nearDist - da) / (db - da);
    x1 = ax + (bx - ax) * t;
    y1 = ay + (by - ay) * t;
    z1 = az + (bz - az) * t;
  } else if (db < nearDist) {
    const t = (nearDist - db) / (da - db);
    x2 = bx + (ax - bx) * t;
    y2 = by + (ay - by) * t;
    z2 = bz + (az - bz) * t;
  }
  out[0] = x1;
  out[1] = y1;
  out[2] = z1;
  out[3] = x2;
  out[4] = y2;
  out[5] = z2;
  return out;
}

export interface FloorGrid {
  step: number;
  /** flat segments (ax ay az bx by bz ...) of the grid lines, already cut at the near plane */
  lines: number[];
  /** the world x line (z = 0, toward the right) and the world z line (x = 0, away), or null when behind the view */
  axisX: number[] | null;
  axisZ: number[] | null;
}

export interface FloorGridInput {
  eye: Vec3;
  forward: Vec3;
  /** the orbit target on the floor: the grid is centered under it */
  targetX: number;
  targetZ: number;
  orbitDistance: number;
  /** world y of the floor */
  floorY: number;
  /** nearest drawn depth along the view direction */
  near: number;
}

/** the floor grid and the world axis lines for a view. at most 2 * (2 * GRID_HALF_LINES + 1) + 2 segments. */
export function floorGrid(v: FloorGridInput): FloorGrid {
  const step = floorGridStep(v.orbitDistance);
  const n = GRID_HALF_LINES;
  const cx = Math.round(v.targetX / step) * step;
  const cz = Math.round(v.targetZ / step) * step;
  const x0 = cx - n * step;
  const x1 = cx + n * step;
  const z0 = cz - n * step;
  const z1 = cz + n * step;
  const y = v.floorY;
  const lines: number[] = [];
  const tmp = [0, 0, 0, 0, 0, 0];
  const push = (ax: number, az: number, bx: number, bz: number) => {
    const s = clipSegmentNear(ax, y, az, bx, y, bz, v.eye, v.forward, v.near, tmp);
    if (s) lines.push(s[0]!, s[1]!, s[2]!, s[3]!, s[4]!, s[5]!);
  };
  const eps = step * 1e-6;
  for (let i = 0; i <= 2 * n; i++) {
    const x = x0 + i * step;
    const z = z0 + i * step;
    // the lines through the origin are the axis lines, drawn stronger on their own
    if (Math.abs(x) > eps) push(x, z0, x, z1);
    if (Math.abs(z) > eps) push(x0, z, x1, z);
  }
  const ax = clipSegmentNear(Math.min(x0, 0), y, 0, Math.max(x1, 0), y, 0, v.eye, v.forward, v.near);
  const az = clipSegmentNear(0, y, Math.min(z0, 0), 0, y, Math.max(z1, 0), v.eye, v.forward, v.near);
  return { step, lines, axisX: ax, axisZ: az };
}

/* ---------- axis lock ---------- */

export type AxisLock = 0 | 1 | 2 | null;

/** the axis a key locks to: x y z (any case) -> 0 1 2, anything else null */
export function lockForKey(key: string): AxisLock {
  const k = key.length === 1 ? key.toLowerCase() : '';
  return k === 'x' ? 0 : k === 'y' ? 1 : k === 'z' ? 2 : null;
}

/** pressing the key of the current lock releases it, another axis key switches to that axis */
export function nextLock(cur: AxisLock, pressed: 0 | 1 | 2): AxisLock {
  return cur === pressed ? null : pressed;
}

/** a movement with only the locked axis kept (no lock = unchanged) */
export function lockDelta(d: Vec3, lock: AxisLock): Vec3 {
  if (lock === null) return [d[0], d[1], d[2]];
  const out: Vec3 = [0, 0, 0];
  out[lock] = d[lock];
  return out;
}

/* ---------- readouts ---------- */

const AXIS_LETTERS = ['x', 'y', 'z'] as const;

/** "+240", "-12.5", "0": a signed number with at most 2 decimals */
export function signed(n: number): string {
  const r = Math.round(n * 100) / 100;
  if (r === 0 || !Number.isFinite(r)) return '0';
  return `${r > 0 ? '+' : ''}${r}`;
}

/** a move: "x +240" when one axis moves or is locked, otherwise every axis that moved ("x +240 y -30") */
export function moveReadout(d: Vec3, lock: AxisLock): string {
  if (lock !== null) return `${AXIS_LETTERS[lock]} ${signed(d[lock])}`;
  const parts: string[] = [];
  for (let i = 0; i < 3; i++) if (Math.abs(d[i]!) >= 0.005) parts.push(`${AXIS_LETTERS[i]} ${signed(d[i]!)}`);
  return parts.length > 0 ? parts.join(' ') : 'x 0';
}

/** a turn: "tilt +15deg" (the change since the grab) */
export function rotateReadout(label: string, delta: number): string {
  return `${label} ${signed(delta)}deg`;
}

/** a scale: "scale 1.25x" (the factor since the grab) */
export function scaleReadout(factor: number): string {
  const f = Number.isFinite(factor) ? Math.round(factor * 100) / 100 : 1;
  return `scale ${f}x`;
}

/* ---------- remembered grid switch ---------- */

export function parseGridOn(v: unknown): boolean {
  return v !== '0' && v !== false;
}
