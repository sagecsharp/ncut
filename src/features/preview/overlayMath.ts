/** geometry helpers shared by the output overlay and the scene overlay. pure, no dom. */
import { type ClipBox, getClipBox, normalizeCrop } from '../../engine/draw';
import { type Camera3D, type CameraRig, cameraAt, cameraRig, projectPoint } from '../../engine/scene3d/camera';
import { type Mat4, type Vec3, cross, dot, mul, scaling, sub, translation } from '../../engine/scene3d/math';
import { clipModelMatrix, clipWorldModel, planeCorners } from '../../engine/scene3d/model';
import { resolveClip } from '../../lib/anim';
import { worldClip } from './attached';
import { isVisualClip } from '../../types';
import type { Clip } from '../../types';
import { homeDistance } from '../../engine/scene3d/camera';
import type { Crop, Project, VisualClip } from '../../types';

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

/**
 * the model matrix of what stays visible of a cropped plane: the renderer (draw.ts planeFor) shrinks a plane to the
 * kept rectangle and offsets it inside the clip's local box so it stays in place under rotation. box / sphere /
 * cylinder wraps keep their full geometry (the crop only picks a window of the picture), so they are unchanged.
 */
export function keptPlaneModel(model: Mat4, crop: Crop | null | undefined, shape: string | undefined): Mat4 {
  if ((shape ?? 'plane') !== 'plane') return model;
  const c = normalizeCrop(crop);
  if (!c) return model;
  return mul(mul(model, translation((c.left - c.right) / 2, (c.top - c.bottom) / 2, 0)), scaling(1 - c.left - c.right, 1 - c.top - c.bottom, 1));
}

/** planes made by asScenePlane (a 2d clip lying on the canvas plane): they are not real 3d clips even though threeD is set */
const flatPlanes = new WeakSet<object>();

/**
 * true for a real 3d clip that is attached to something. the renderer places it with the parent's full matrix
 * (clipWorldModel: tilt, turn and z of the parent count), so the overlays do the same. a 2d clip, also one shown
 * flat in the scene view, only follows its parent's x / y / rotation / scale (worldClip).
 */
export function usesParentFrame(clip: VisualClip): boolean {
  return !!clip.parent && !!clip.threeD && !flatPlanes.has(clip);
}

/** the center of a real 3d clip in the world, through its parent chain (canvas px) */
export function worldCenter3d(project: Project, raw: VisualClip, time: number): Vec3 {
  const clip = resolveClip(raw, time);
  const m = clipWorldModel(project, clip, time, getClipBox(project, clip), [0, 0, 0]);
  return [m[12]!, m[13]!, m[14]!];
}

/** the projected outline of a (keyframe resolved) 3d clip through a camera rig */
export function clipQuad(project: Project, raw: VisualClip, time: number, rig: CameraRig, out?: Quad): Quad {
  // an attached clip is drawn at its pose in the world: outline and handles sit there too
  const framed = usesParentFrame(raw);
  const clip = framed ? resolveClip(raw, time) : worldClip(project, raw, time);
  const box = getClipBox(project, clip);
  const base = framed ? clipWorldModel(project, clip, time, box, rig.eye) : clipModelMatrix(box, clip.transform, clip.lookAt, rig.eye);
  const model = keptPlaneModel(base, clip.crop, clip.shape);
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
  const c = framed ? projectPoint(rig, base[12]!, base[13]!, base[14]!, project.width, project.height) : projectPoint(rig, box.cx, box.cy, clip.transform.z ?? 0, project.width, project.height);
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

/* ---------- crop ---------- */

const MIN_KEPT = 0.001;

/** true when any edge is really cut */
export function hasCrop(crop: Crop | null | undefined): crop is Crop {
  return !!crop && (crop.left > 0 || crop.top > 0 || crop.right > 0 || crop.bottom > 0);
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

/**
 * the kept rectangle of a clip box: crop fractions are cut from each edge of the clip's own box, so the
 * rest keeps its place (cropping never moves or stretches the picture). the result is rotated with the clip.
 */
export function keptBox(box: ClipBox, crop: Crop | null | undefined): ClipBox {
  if (!hasCrop(crop)) return box;
  const l = clamp01(crop.left);
  const t = clamp01(crop.top);
  let r = clamp01(crop.right);
  let b = clamp01(crop.bottom);
  // never cut everything away: the box would vanish and could not be grabbed
  if (l + r > 1 - MIN_KEPT) r = Math.max(0, 1 - MIN_KEPT - l);
  if (t + b > 1 - MIN_KEPT) b = Math.max(0, 1 - MIN_KEPT - t);
  const kw = box.width * (1 - l - r);
  const kh = box.height * (1 - t - b);
  // offset of the kept center from the box center, in the clip's own (unrotated) axes
  const ox = ((l - r) * box.width) / 2;
  const oy = ((t - b) * box.height) / 2;
  const rad = (box.rotation * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return { cx: box.cx + ox * c - oy * s, cy: box.cy + ox * s + oy * c, width: kw, height: kh, rotation: box.rotation };
}

/** half extents of the axis aligned bounds of a rotated box */
export function boxBounds(box: ClipBox): { hw: number; hh: number } {
  const rad = (box.rotation * Math.PI) / 180;
  const c = Math.abs(Math.cos(rad));
  const s = Math.abs(Math.sin(rad));
  return { hw: (box.width * c + box.height * s) / 2, hh: (box.width * s + box.height * c) / 2 };
}

/** point inside the rotated box, with every side at least `minSize` canvas px wide (thin lines stay grabbable) */
export function hitTestKept(box: ClipBox, px: number, py: number, minSize = 0): boolean {
  const rad = (-box.rotation * Math.PI) / 180;
  const dx = px - box.cx;
  const dy = py - box.cy;
  const lx = dx * Math.cos(rad) - dy * Math.sin(rad);
  const ly = dx * Math.sin(rad) + dy * Math.cos(rad);
  return Math.abs(lx) <= Math.max(box.width, minSize) / 2 && Math.abs(ly) <= Math.max(box.height, minSize) / 2;
}

/* ---------- snapping ---------- */

export interface Snap {
  /** how far to move so the edge / center lands on the target */
  adj: number;
  /** the target position on the canvas axis (where to draw the guide) */
  at: number;
}

/**
 * snap a span on one canvas axis: its center to the canvas center, its low edge to 0 and its high edge to
 * `size`. returns the closest candidate within `thr`, or null.
 */
export function snapAxis(center: number, half: number, size: number, thr: number): Snap | null {
  const cands: Array<[number, number]> = [
    [center, size / 2],
    [center - half, 0],
    [center + half, size],
  ];
  let best: Snap | null = null;
  for (const [value, target] of cands) {
    const d = target - value;
    if (Math.abs(d) <= thr && (!best || Math.abs(d) < Math.abs(best.adj))) best = { adj: d, at: target };
  }
  return best;
}

/* ---------- edge resize (shape clips) ---------- */

export type Edge = 'l' | 'r' | 't' | 'b';

export interface EdgeStart {
  /** box center, canvas px */
  cx: number;
  cy: number;
  /** degrees */
  rotation: number;
  /** box size at gesture start, canvas px (shape size x transform scale) */
  bw: number;
  bh: number;
  scale: number;
}

export interface EdgeResult {
  /** new shape width (set for l / r) or height (set for t / b), px at scale 1 */
  width?: number;
  height?: number;
  /** move the clip's transform x / y by this much (canvas px) so the opposite edge stays put */
  dx: number;
  dy: number;
}

/** drag one edge of a rotated box to the canvas point (px, py); the opposite edge stays fixed in canvas space */
export function edgeResize(s: EdgeStart, edge: Edge, px: number, py: number, minPx = 4): EdgeResult {
  const rad = (s.rotation * Math.PI) / 180;
  const c = Math.cos(rad);
  const sn = Math.sin(rad);
  // pointer in the clip's own axes
  const lx = (px - s.cx) * c + (py - s.cy) * sn;
  const ly = -(px - s.cx) * sn + (py - s.cy) * c;
  let shiftX = 0;
  let shiftY = 0;
  let width: number | undefined;
  let height: number | undefined;
  const sc = Math.max(1e-6, s.scale);
  if (edge === 'r' || edge === 'l') {
    const nb = Math.max(minPx, edge === 'r' ? lx + s.bw / 2 : s.bw / 2 - lx);
    shiftX = ((edge === 'r' ? 1 : -1) * (nb - s.bw)) / 2;
    width = nb / sc;
  } else {
    const nb = Math.max(minPx, edge === 'b' ? ly + s.bh / 2 : s.bh / 2 - ly);
    shiftY = ((edge === 'b' ? 1 : -1) * (nb - s.bh)) / 2;
    height = nb / sc;
  }
  return { width, height, dx: shiftX * c - shiftY * sn, dy: shiftX * sn + shiftY * c };
}

/* ---------- rotation drag ---------- */

/** shortest signed step from one angle to another, degrees, in (-180, 180]. crosses the atan2 branch cut cleanly. */
export function unwrapStep(prev: number, next: number): number {
  let d = (next - prev) % 360;
  if (d > 180) d -= 360;
  else if (d <= -180) d += 360;
  return d;
}

/**
 * the rotation a drag ends on: the start value plus the unwrapped pointer delta (never normalized, so a clip
 * that already turned twice stays at two turns). snaps to every 90 degrees within 3 (counted on the unwrapped value,
 * so 720 snaps to 720 and not to 0), shift snaps to 15 degree steps.
 */
export function rotateValue(r0: number, accumulated: number, shift: boolean): number {
  const raw = r0 + accumulated;
  if (shift) return Math.round(raw / 15) * 15;
  const nearest = Math.round(raw / 90) * 90;
  return Math.abs(raw - nearest) <= 3 ? nearest : raw;
}

/** a clip as the scene view shows it: a 2d clip lies flat on the canvas plane (z = 0, no tilt or turn) */
export function asScenePlane(clip: VisualClip): VisualClip {
  if (clip.threeD) return clip;
  const flat: VisualClip = { ...clip, threeD: true, lookAt: undefined, transform: { ...clip.transform, z: 0, rotX: 0, rotY: 0 } };
  flatPlanes.add(flat);
  return flat;
}

/**
 * the center of a clip in the scene world (canvas px, z): a picture at its world pose (a 2d one lies on the canvas
 * plane), a camera clip at its eye. null for clips that have no place (audio, effects). used for the line from an
 * attached clip to its parent.
 */
export function sceneCenter(project: Project, clip: Clip, time: number): Vec3 | null {
  if (clip.type === 'camera') {
    const r = resolveClip(clip, time);
    return [project.width / 2 + r.x, project.height / 2 + r.y, -homeDistance(project.height) + r.z];
  }
  if (!isVisualClip(clip)) return null;
  if (usesParentFrame(clip)) return worldCenter3d(project, clip, time);
  const w = worldClip(project, asScenePlane(clip), time);
  const box = getClipBox(project, w);
  return [box.cx, box.cy, w.transform.z ?? 0];
}
