/**
 * pure math of the scene view's rotate / scale tools: the three rotation rings of a clip, hit testing them in
 * screen space and turning a pointer angle into a property value. no dom, tested in node.
 */
import type { ClipBox } from '../../engine/draw';
import { DEG, type Vec3, cross, dot, mul, normalize, rotationX, rotationY, transformPoint } from '../../engine/scene3d/math';
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
 */
export function ringAxes(box: ClipBox, t: Partial<Transform>, lookAt: LookAt | undefined, eye: Vec3): [Vec3, Vec3, Vec3] {
  const base = clipModelMatrix(
    { cx: box.cx, cy: box.cy, width: 1, height: 1, rotation: 0 },
    { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, z: t.z ?? 0 },
    lookAt,
    eye,
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
