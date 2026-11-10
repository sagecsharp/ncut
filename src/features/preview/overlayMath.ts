/** geometry helpers shared by the output overlay and the scene overlay. pure, no dom. */
import { getClipBox } from '../../engine/draw';
import { type Camera3D, type CameraRig, cameraAt, cameraRig, projectPoint } from '../../engine/scene3d/camera';
import { type Vec3, cross, dot, sub } from '../../engine/scene3d/math';
import { clipModelMatrix, planeCorners } from '../../engine/scene3d/model';
import { resolveClip } from '../../lib/anim';
import type { Project, VisualClip } from '../../types';

let rigProject: Project | null = null;
let rigTime = NaN;
let rigValue: CameraRig | null = null;

/** the project camera's rig at a time (cached for the same project + time, so many boxes share one) */
export function projectRig(project: Project, time: number): CameraRig {
  if (rigValue && rigProject === project && rigTime === time) return rigValue;
  const cam: Camera3D = cameraAt(project, time);
  rigValue = cameraRig(cam, project.width, project.height);
  rigProject = project;
  rigTime = time;
  return rigValue;
}

export interface Quad {
  /** projected corners tl, tr, br, bl in canvas pixels (x0 y0 x1 y1 ...) */
  p: [number, number, number, number, number, number, number, number];
  /** false when any corner is behind the camera */
  visible: boolean;
  /** distance of the plane center along the camera forward axis */
  depth: number;
  /** world corners */
  world: [Vec3, Vec3, Vec3, Vec3];
  cx: number;
  cy: number;
}

/** the projected outline of a (keyframe resolved) 3d clip through a camera rig */
export function clipQuad(project: Project, raw: VisualClip, time: number, rig: CameraRig, out?: Quad): Quad {
  const clip = resolveClip(raw, time);
  const box = getClipBox(project, clip);
  const model = clipModelMatrix(box, clip.transform, clip.lookAt, rig.eye);
  const world = planeCorners(model);
  const q: Quad = out ?? { p: [0, 0, 0, 0, 0, 0, 0, 0], visible: true, depth: 0, world, cx: 0, cy: 0 };
  q.world = world;
  q.visible = true;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < 4; i++) {
    const w = world[i]!;
    const r = projectPoint(rig, w[0], w[1], w[2], project.width, project.height);
    if (!r.visible) q.visible = false;
    q.p[i * 2] = r.x;
    q.p[i * 2 + 1] = r.y;
    sx += r.x;
    sy += r.y;
  }
  q.cx = sx / 4;
  q.cy = sy / 4;
  const c = projectPoint(rig, box.cx, box.cy, clip.transform.z ?? 0, project.width, project.height);
  q.depth = c.depth;
  return q;
}

/** point inside a convex quad given as 8 numbers, either winding */
export function pointInQuad(p: ArrayLike<number>, x: number, y: number): boolean {
  let pos = false;
  let neg = false;
  for (let i = 0; i < 4; i++) {
    const ax = p[i * 2]!;
    const ay = p[i * 2 + 1]!;
    const bx = p[((i + 1) % 4) * 2]!;
    const by = p[((i + 1) % 4) * 2 + 1]!;
    const c = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    if (c > 0) pos = true;
    else if (c < 0) neg = true;
    if (pos && neg) return false;
  }
  return true;
}

/** distance from a point to a segment (2d) */
export function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 1e-9 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

/** distance along a ray to a world quad, or null when it misses */
export function rayQuad(origin: Vec3, dir: Vec3, world: readonly [Vec3, Vec3, Vec3, Vec3]): number | null {
  const c0 = world[0];
  const u = sub(world[1], c0);
  const v = sub(world[3], c0);
  const n = cross(u, v);
  const denom = dot(dir, n);
  if (Math.abs(denom) < 1e-12) return null;
  const t = dot(sub(c0, origin), n) / denom;
  if (t <= 0) return null;
  const hit: Vec3 = [origin[0] + dir[0] * t - c0[0], origin[1] + dir[1] * t - c0[1], origin[2] + dir[2] * t - c0[2]];
  const s = dot(hit, u) / dot(u, u);
  const r = dot(hit, v) / dot(v, v);
  return s >= 0 && s <= 1 && r >= 0 && r <= 1 ? t : null;
}

/**
 * parameter t on the line (c + t * a) that is closest to the ray (o + s * d). a and d are unit vectors.
 * null when the two are nearly parallel.
 */
export function closestOnAxis(o: Vec3, d: Vec3, c: Vec3, a: Vec3): number | null {
  const w = sub(o, c);
  const b = dot(d, a);
  const dw = dot(d, w);
  const aw = dot(a, w);
  const den = 1 - b * b;
  if (den < 1e-5) return null;
  return (aw - b * dw) / den;
}
