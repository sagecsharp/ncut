/**
 * pure math of the scene view's rotate / scale tools: the three rotation rings of a clip, hit testing them in
 * screen space and turning a pointer angle into a property value. no dom, tested in node.
 */
import type { ClipBox } from '../../engine/draw';
import { DEG, type Mat4, type Vec3, cross, dot, mul, normalize, rotationX, rotationY, transformPoint } from '../../engine/scene3d/math';
import { clipModelMatrix } from '../../engine/scene3d/model';
import type { LookAt, Transform } from '../../types';

export type SceneTool = 'move' | 'rotate' | 'scale';

/** the clip properties the three rings edit, in ring order: tilt (around x), turn (around y), roll (around z) */
export type RingProp = 'rotX' | 'rotY' | 'rotation';
export const RING_PROPS: readonly RingProp[] = ['rotX', 'rotY', 'rotation'];
export const RING_LABELS = ['tilt', 'turn', 'roll'] as const;
export const RING_STEPS = 48;

function dir(m: Float32Array, x: number, y: number, z: number): Vec3 {
  const a = transformPoint(m, x, y, z);
  const o = transformPoint(m, 0, 0, 0);
  return normalize([a[0] - o[0], a[1] - o[1], a[2] - o[2]]);
}

/**
 * world axes the three rings turn around. rotation is applied turn first, then tilt inside it, then roll inside
 * both (see clipModelMatrix), so like a gimbal each ring follows the ones outside it: turn is the world y axis (or
 * the billboard's), tilt the x axis after the turn, roll the plane's normal.
 * for a clip attached to a parent pass the parent's matrix (engine/parent parentModelMatrix) and the clip's own
 * x / y / z: the rings then sit in the parent's frame, like the renderer places the clip.
 */
export function ringAxes(box: ClipBox, t: Partial<Transform>, lookAt: LookAt | undefined, eye: Vec3, parent?: Mat4 | null): [Vec3, Vec3, Vec3] {
  const base = clipModelMatrix(
    { cx: box.cx, cy: box.cy, width: 1, height: 1, rotation: 0 },
    { x: parent ? (t.x ?? 0) : 0, y: parent ? (t.y ?? 0) : 0, scale: 1, rotation: 0, opacity: 1, z: t.z ?? 0 },
    lookAt,
    eye,
    parent,
  );
  const withY = mul(base, rotationY(-(t.rotY ?? 0) * DEG));
  const withX = mul(withY, rotationX(-(t.rotX ?? 0) * DEG));
  return [dir(withY, 1, 0, 0), dir(base, 0, 1, 0), dir(withX, 0, 0, 1)];
}

/** two unit vectors perpendicular to a unit axis (and to each other) */
export function perpendicular(axis: Vec3): [Vec3, Vec3] {
  const helper: Vec3 = Math.abs(axis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = normalize(cross(axis, helper));
  const v = normalize(cross(axis, u));
  return [u, v];
}

/** a closed circle (steps + 1 points, first = last) around a center in the plane perpendicular to the axis */
export function ringPoints(center: Vec3, axis: Vec3, radius: number, steps = RING_STEPS): Vec3[] {
  const [u, v] = perpendicular(axis);
  const out: Vec3[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = ((i % steps) / steps) * Math.PI * 2;
    const c = Math.cos(a) * radius;
    const s = Math.sin(a) * radius;
    out.push([center[0] + u[0] * c + v[0] * s, center[1] + u[1] * c + v[1] * s, center[2] + u[2] * c + v[2] * s]);
  }
  return out;
}

function segDist2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 1e-9 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  const ex = px - (ax + dx * t);
  const ey = py - (ay + dy * t);
  return ex * ex + ey * ey;
}

/**
 * the polyline (flat x y x y ... arrays, null = not shown) closest to a point, within maxDist. the nearest wins when
 * rings cross, so every ring can be grabbed even where they overlap.
 */
export function nearestPolyline(polys: ReadonlyArray<ArrayLike<number> | null>, x: number, y: number, maxDist: number): { index: number; dist: number } | null {
  let best: { index: number; dist: number } | null = null;
  let bestD2 = maxDist * maxDist;
  for (let k = 0; k < polys.length; k++) {
    const p = polys[k];
    if (!p || p.length < 4) continue;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const d2 = segDist2(x, y, p[i]!, p[i + 1]!, p[i + 2]!, p[i + 3]!);
      if (d2 <= bestD2) {
        bestD2 = d2;
        best = { index: k, dist: Math.sqrt(d2) };
      }
    }
  }
  return best;
}

/**
 * how a property changes per degree the pointer circles clockwise on screen. a right handed turn about an axis that
 * points away from the viewer (axis . forward > 0) looks clockwise; roll adds that turn, tilt and turn subtract it
 * (their properties are stored with the opposite sign, see clipModelMatrix).
 */
export function ringValueSign(prop: RingProp, axis: Vec3, forward: Vec3): 1 | -1 {
  const facing = dot(axis, forward) >= 0 ? 1 : -1;
  return (prop === 'rotation' ? facing : -facing) as 1 | -1;
}

/** new scale for a drag: the ratio of the pointer's distance from the center now and at the grab */
export function scaleFromDrag(s0: number, d0: number, d: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, (s0 * d) / Math.max(1e-6, d0)));
}

/* ---------- stretch per axis ---------- */

export type ScaleProp = 'scale' | 'scaleX' | 'scaleY' | 'scaleZ';
/** the property of the stretch along the clip's own x, y and z axis */
export const STRETCH_PROPS: readonly ['scaleX', 'scaleY', 'scaleZ'] = ['scaleX', 'scaleY', 'scaleZ'];

/** the projected axis handles are hidden when the axis points (nearly) at the viewer: its length on screen, css px */
export const MIN_STRETCH_HANDLE_PX = 14;

/**
 * depth means something only for a 3d solid (a shape other than the plane) and for 3d text with a side (extrude):
 * scaleZ does nothing on a flat plane, so its handle and the z key are left out there
 */
export function hasDepth(c: { type: string; threeD?: boolean; shape?: string; extrude?: { depth: number } | null }): boolean {
  if (!c.threeD) return false;
  if (c.shape && c.shape !== 'plane') return true;
  return c.type === 'text' && !!c.extrude && c.extrude.depth > 0;
}

/**
 * the clip's OWN x, y and z axes in the world (unit vectors): the plane's right, down and normal after turn, tilt and
 * roll, so a handle along one of them follows what the stretch of that axis does. for a clip attached to a parent pass the
 * parent's matrix and the clip's own x / y / z (like ringAxes). `box.rotation` is the roll.
 */
export function ownAxes(box: ClipBox, t: Partial<Transform>, lookAt: LookAt | undefined, eye: Vec3, parent?: Mat4 | null): [Vec3, Vec3, Vec3] {
  const m = clipModelMatrix(
    { cx: box.cx, cy: box.cy, width: 1, height: 1, rotation: box.rotation },
    { x: parent ? (t.x ?? 0) : 0, y: parent ? (t.y ?? 0) : 0, scale: 1, rotation: 0, opacity: 1, z: t.z ?? 0, rotX: t.rotX ?? 0, rotY: t.rotY ?? 0 },
    lookAt,
    eye,
    parent,
  );
  return [dir(m, 1, 0, 0), dir(m, 0, 1, 0), dir(m, 0, 0, 1)];
}

/**
 * how far the pointer is from the center along the screen direction of an axis handle (css px, signed: the far side of
 * the center is negative). the handle's direction is (tx - cx, ty - cy).
 */
export function axisPull(cx: number, cy: number, tx: number, ty: number, px: number, py: number): number {
  const dx = tx - cx;
  const dy = ty - cy;
  const l = Math.hypot(dx, dy);
  if (l < 1e-6) return 0;
  return ((px - cx) * dx + (py - cy) * dy) / l;
}

/**
 * the value a scale drag writes: the grab value times the typed factor, or times the ratio of the pointer's distance from
 * the center now and at the grab. clamped to min..max and rounded to 3 decimals.
 */
export function scaledValue(v0: number, d0: number, d: number, typed: number | null, min: number, max: number): number {
  const v = typed !== null && typed > 0 ? Math.min(max, Math.max(min, v0 * typed)) : scaleFromDrag(v0, d0, d, min, max);
  return Math.round(v * 1000) / 1000;
}

/**
 * the stretch props an alt + s puts back to 1: the ones that are not 1 now, or that are keyed (a keyed one is set at
 * this time too, so the playhead shows 1). nothing is written for a clip that was never stretched.
 */
export function stretchesToClear(t: { scaleX?: number; scaleY?: number; scaleZ?: number }, keyed: Readonly<Record<string, ReadonlyArray<unknown> | undefined>> | undefined): Array<'scaleX' | 'scaleY' | 'scaleZ'> {
  return STRETCH_PROPS.filter((p) => (t[p] !== undefined && t[p] !== 1) || (keyed?.[p]?.length ?? 0) > 0);
}
