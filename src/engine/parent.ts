/**
 * parenting geometry (Spatial.parent). which clip is attached to which is in lib/links.ts; this
 * file answers where a clip ends up.
 *
 * rules:
 * - a parent is evaluated at the same timeline time as the child. a time outside the parent's range
 *   counts as the parent's nearest edge, so a child never jumps when its parent ends.
 * - the parent's pose is its transform after keyframes and motions (engine/clipAnim) and after its
 *   own parents.
 * - 2d: the child's x / y are offsets in the parent's frame (they turn and scale with the parent),
 *   rotation adds, scale multiplies. opacity is NOT inherited.
 * - 3d: the same in space: the child's position / rotX / rotY / rotation / scale are relative to the
 *   parent's (a 2d parent counts as lying in the canvas plane). a 2d child of a 3d parent only
 *   follows x / y / rotation / scale.
 * - a camera parent (3d children only): the child is fixed to the camera like a hud. its transform
 *   is where it would sit seen from the home camera. 2d children ignore a camera parent.
 * - lookAt is applied last, in the world.
 */
import { resolveClip } from '../lib/anim';
import { MAX_PARENT_DEPTH, parentOf } from '../lib/links';
import { clipEnd } from '../lib/timelineOps';
import type { CameraClip, Clip, Project, Transform, VisualClip } from '../types';
import { isCameraClip, isVisualClip } from '../types';
import { applyClipMotion, hasClipMotion } from './clipAnim';
import { cameraFromClip, cameraRig, cameraWorldMatrix, homeEye } from './scene3d/camera';
import { DEG, type Mat4, type Vec3 } from './scene3d/math';

/* ---------- small double precision matrices (column-major, like scene3d/math) ---------- */

type M = Float64Array;

function ident(): M {
  const m = new Float64Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

function mulD(a: ArrayLike<number>, b: ArrayLike<number>): M {
  const o = new Float64Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r]! * b[c * 4]! + a[4 + r]! * b[c * 4 + 1]! + a[8 + r]! * b[c * 4 + 2]! + a[12 + r]! * b[c * 4 + 3]!;
    }
  }
  return o;
}

function trD(x: number, y: number, z: number): M {
  const m = ident();
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
}

function rotXD(rad: number): M {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const m = ident();
  m[5] = c;
  m[6] = s;
  m[9] = -s;
  m[10] = c;
  return m;
}
function rotYD(rad: number): M {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const m = ident();
  m[0] = c;
  m[2] = -s;
  m[8] = s;
  m[10] = c;
  return m;
}
function rotZD(rad: number): M {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const m = ident();
  m[0] = c;
  m[1] = s;
  m[4] = -s;
  m[5] = c;
  return m;
}

/** inverse of a 4x4 matrix, or null when it is singular */
export function invertMatrix(m: ArrayLike<number>): Float64Array | null {
  const a = m;
  const inv = new Float64Array(16);
  inv[0] = a[5]! * a[10]! * a[15]! - a[5]! * a[11]! * a[14]! - a[9]! * a[6]! * a[15]! + a[9]! * a[7]! * a[14]! + a[13]! * a[6]! * a[11]! - a[13]! * a[7]! * a[10]!;
  inv[4] = -a[4]! * a[10]! * a[15]! + a[4]! * a[11]! * a[14]! + a[8]! * a[6]! * a[15]! - a[8]! * a[7]! * a[14]! - a[12]! * a[6]! * a[11]! + a[12]! * a[7]! * a[10]!;
  inv[8] = a[4]! * a[9]! * a[15]! - a[4]! * a[11]! * a[13]! - a[8]! * a[5]! * a[15]! + a[8]! * a[7]! * a[13]! + a[12]! * a[5]! * a[11]! - a[12]! * a[7]! * a[9]!;
  inv[12] = -a[4]! * a[9]! * a[14]! + a[4]! * a[10]! * a[13]! + a[8]! * a[5]! * a[14]! - a[8]! * a[6]! * a[13]! - a[12]! * a[5]! * a[10]! + a[12]! * a[6]! * a[9]!;
  inv[1] = -a[1]! * a[10]! * a[15]! + a[1]! * a[11]! * a[14]! + a[9]! * a[2]! * a[15]! - a[9]! * a[3]! * a[14]! - a[13]! * a[2]! * a[11]! + a[13]! * a[3]! * a[10]!;
  inv[5] = a[0]! * a[10]! * a[15]! - a[0]! * a[11]! * a[14]! - a[8]! * a[2]! * a[15]! + a[8]! * a[3]! * a[14]! + a[12]! * a[2]! * a[11]! - a[12]! * a[3]! * a[10]!;
  inv[9] = -a[0]! * a[9]! * a[15]! + a[0]! * a[11]! * a[13]! + a[8]! * a[1]! * a[15]! - a[8]! * a[3]! * a[13]! - a[12]! * a[1]! * a[11]! + a[12]! * a[3]! * a[9]!;
  inv[13] = a[0]! * a[9]! * a[14]! - a[0]! * a[10]! * a[13]! - a[8]! * a[1]! * a[14]! + a[8]! * a[2]! * a[13]! + a[12]! * a[1]! * a[10]! - a[12]! * a[2]! * a[9]!;
  inv[2] = a[1]! * a[6]! * a[15]! - a[1]! * a[7]! * a[14]! - a[5]! * a[2]! * a[15]! + a[5]! * a[3]! * a[14]! + a[13]! * a[2]! * a[7]! - a[13]! * a[3]! * a[6]!;
  inv[6] = -a[0]! * a[6]! * a[15]! + a[0]! * a[7]! * a[14]! + a[4]! * a[2]! * a[15]! - a[4]! * a[3]! * a[14]! - a[12]! * a[2]! * a[7]! + a[12]! * a[3]! * a[6]!;
  inv[10] = a[0]! * a[5]! * a[15]! - a[0]! * a[7]! * a[13]! - a[4]! * a[1]! * a[15]! + a[4]! * a[3]! * a[13]! + a[12]! * a[1]! * a[7]! - a[12]! * a[3]! * a[5]!;
  inv[14] = -a[0]! * a[5]! * a[14]! + a[0]! * a[6]! * a[13]! + a[4]! * a[1]! * a[14]! - a[4]! * a[2]! * a[13]! - a[12]! * a[1]! * a[6]! + a[12]! * a[2]! * a[5]!;
  inv[3] = -a[1]! * a[6]! * a[11]! + a[1]! * a[7]! * a[10]! + a[5]! * a[2]! * a[11]! - a[5]! * a[3]! * a[10]! - a[9]! * a[2]! * a[7]! + a[9]! * a[3]! * a[6]!;
  inv[7] = a[0]! * a[6]! * a[11]! - a[0]! * a[7]! * a[10]! - a[4]! * a[2]! * a[11]! + a[4]! * a[3]! * a[10]! + a[8]! * a[2]! * a[7]! - a[8]! * a[3]! * a[6]!;
  inv[11] = -a[0]! * a[5]! * a[11]! + a[0]! * a[7]! * a[9]! + a[4]! * a[1]! * a[11]! - a[4]! * a[3]! * a[9]! - a[8]! * a[1]! * a[7]! + a[8]! * a[3]! * a[5]!;
  inv[15] = a[0]! * a[5]! * a[10]! - a[0]! * a[6]! * a[9]! - a[4]! * a[1]! * a[10]! + a[4]! * a[2]! * a[9]! + a[8]! * a[1]! * a[6]! - a[8]! * a[2]! * a[5]!;
  const det = a[0]! * inv[0]! + a[1]! * inv[4]! + a[2]! * inv[8]! + a[3]! * inv[12]!;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-18) return null;
  const k = 1 / det;
  for (let i = 0; i < 16; i++) inv[i] = inv[i]! * k;
  return inv;
}

/* ---------- poses ---------- */

/** a time clamped into a clip's own range (just inside the end) */
function clampTime(c: Pick<Clip, 'start' | 'duration'>, t: number): number {
  return Math.min(Math.max(t, c.start), Math.max(c.start, clipEnd(c) - 1e-4));
}

/** the clip with keyframes and motions applied at a time */
function ownPose(project: Project, clip: VisualClip, time: number): VisualClip {
  const r = resolveClip(clip, time);
  return hasClipMotion(clip) ? applyClipMotion(r, time, project) : r;
}

interface PoseEntry {
  t2d: Map<string, Transform>;
  frame: Map<string, M>;
}

/**
 * poses of the last few times, so many children of one parent share the parent's chain. the store replaces
 * the clips array on every edit, so its identity (plus the length, for in place pushes) is the cache key.
 */
const MAX_TIMES = 48;
let cacheClips: readonly Clip[] | null = null;
let cacheN = -1;
let cacheW = 0;
let cacheH = 0;
const byTime = new Map<number, PoseEntry>();

function entryFor(project: Project, time: number): PoseEntry {
  if (project.clips !== cacheClips || project.clips.length !== cacheN || project.width !== cacheW || project.height !== cacheH) {
    cacheClips = project.clips;
    cacheN = project.clips.length;
    cacheW = project.width;
    cacheH = project.height;
    byTime.clear();
  }
  let e = byTime.get(time);
  if (!e) {
    if (byTime.size >= MAX_TIMES) byTime.clear();
    e = { t2d: new Map(), frame: new Map() };
    byTime.set(time, e);
  }
  return e;
}

/* ---------- 2d ---------- */

function compose2d(p: Transform, c: Transform): Transform {
  const rad = p.rotation * DEG;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return {
    ...c,
    x: p.x + p.scale * (c.x * cos - c.y * sin),
    y: p.y + p.scale * (c.x * sin + c.y * cos),
    rotation: p.rotation + c.rotation,
    scale: p.scale * c.scale,
  };
}

/** world 2d pose of a stored clip at exactly `t` (cached) */
function world2d(project: Project, c: VisualClip, t: number, depth: number): Transform {
  const e = entryFor(project, t);
  const hit = e.t2d.get(c.id);
  if (hit) return hit;
  const own = ownPose(project, c, t).transform;
  let out = own;
  if (depth < MAX_PARENT_DEPTH) {
    const p = parentOf(project, c);
    if (p && isVisualClip(p)) out = compose2d(world2d(project, p, clampTime(p, t), depth + 1), own);
  }
  e.t2d.set(c.id, out);
  return out;
}

/**
 * like worldTransform, for a clip whose keyframes and motions are already applied (the renderer's
 * resolved clip). returns clip.transform itself, without allocating, when there is no parent.
 */
export function worldTransformOf(project: Project, clip: VisualClip, time: number): Transform {
  if (!clip.parent) return clip.transform;
  const p = parentOf(project, clip);
  if (!p || !isVisualClip(p)) return clip.transform;
  return compose2d(world2d(project, p, clampTime(p, time), 1), clip.transform);
}

/**
 * the clip's transform in the world (canvas) frame at a timeline time: keyframes, motions and every
 * parent applied. without a parent this is the clip's own animated transform.
 */
export function worldTransform(project: Project, clip: VisualClip, time: number): Transform {
  return worldTransformOf(project, ownPose(project, clip, time), time);
}

/**
 * turn a movement in the world frame (canvas pixels) into the change of clip.transform.x / y that
 * produces it, for dragging a child in the preview.
 */
export function worldDeltaToLocal(project: Project, clip: VisualClip, time: number, dx: number, dy: number): { x: number; y: number } {
  const p = clip.parent ? parentOf(project, clip) : null;
  if (!p || !isVisualClip(p)) return { x: dx, y: dy };
  const w = world2d(project, p, clampTime(p, time), 1);
  const rad = -w.rotation * DEG;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const s = Math.abs(w.scale) < 1e-9 ? 1 : w.scale;
  return { x: (dx * cos - dy * sin) / s, y: (dx * sin + dy * cos) / s };
}

/* ---------- 3d ---------- */

/**
 * the matrix that carries the camera's view of the world from the home camera to the camera clip:
 * cameraWorld * inverse(homeCameraWorld). a point placed as seen from the home camera, multiplied by
 * it, sits at the same place on screen when seen from the camera clip.
 */
export function cameraDeltaMatrix(project: Project, cam: CameraClip, time: number): Float64Array {
  const rig = cameraRig(cameraFromClip(cam, time, project), project.width, project.height);
  const he = homeEye(project.width, project.height);
  // the home camera has no rotation: its inverse world matrix is a translation by -eye
  return mulD(cameraWorldMatrix(rig), trD(-he[0], -he[1], -he[2]));
}

/** local pose matrix (no size): translate * turn * tilt * spin * scale. a 2d clip stays in the canvas plane. */
function localMatrix(t: Transform, threeD: boolean): M {
  let m = trD(t.x, t.y, threeD ? (t.z ?? 0) : 0);
  if (threeD) {
    if (t.rotY) m = mulD(m, rotYD(-t.rotY * DEG));
    if (t.rotX) m = mulD(m, rotXD(-t.rotX * DEG));
  }
  if (t.rotation) m = mulD(m, rotZD(t.rotation * DEG));
  if (t.scale !== 1) {
    const s = ident();
    s[0] = s[5] = s[10] = t.scale;
    m = mulD(m, s);
  }
  return m;
}

/** frame of a clip (no size) at exactly `t`: canvas center, then every parent, then the clip. cached. */
function frameOf(project: Project, c: VisualClip | CameraClip, t: number, depth: number): M {
  const e = entryFor(project, t);
  const hit = e.frame.get(c.id);
  if (hit) return hit;
  let out: M;
  if (isCameraClip(c)) {
    out = mulD(cameraDeltaMatrix(project, c, t), trD(project.width / 2, project.height / 2, 0));
  } else {
    let base: M | null = null;
    if (depth < MAX_PARENT_DEPTH) {
      const p = parentOf(project, c);
      if (p && (isVisualClip(p) || isCameraClip(p))) base = frameOf(project, p, clampTime(p, t), depth + 1);
    }
    const own = ownPose(project, c, t);
    out = mulD(base ?? trD(project.width / 2, project.height / 2, 0), localMatrix(own.transform, !!own.threeD));
  }
  e.frame.set(c.id, out);
  return out;
}

/**
 * the model matrix of the clip's parent WITHOUT the parent's own size: canvas center * every parent's
 * (translate * turn * tilt * spin * uniform scale). a child's local model (translate by its own
 * x / y / z, then its rotations and size) multiplies onto it. null when the clip has no parent.
 * a 2d parent lies in the canvas plane (z 0, no tilt / turn). a camera parent gives the camera's
 * motion away from the home camera, so the child keeps its place on screen.
 */
export function parentModelMatrix(project: Project, clip: VisualClip, time: number): Mat4 | null {
  const p = clip.parent ? parentOf(project, clip) : null;
  if (!p) return null;
  return Float32Array.from(frameOf(project, p as VisualClip | CameraClip, clampTime(p, time), 1));
}

/**
 * the world point a clip with lookAt 'clip' faces at a time (Spatial.lookTarget): the target's center after
 * keyframes, motions and parents (a 2d target lies in the canvas plane at z 0), or a camera clip's eye. the
 * target's time is clamped into its own range. null = no turn: not lookAt 'clip', no / unknown / own target,
 * or a target that is not a visual or camera clip.
 * positions never depend on any clip's own look turn, so two clips looking at each other need no recursion
 * (a child of a clip that looks somewhere counts from that parent's un-turned frame).
 */
export function clipLookPoint(project: Project, clip: VisualClip, time: number): Vec3 | null {
  if (clip.lookAt !== 'clip' || !clip.lookTarget || clip.lookTarget === clip.id) return null;
  const t = project.clips.find((c) => c.id === clip.lookTarget);
  if (!t || !(isVisualClip(t) || isCameraClip(t))) return null;
  const tt = clampTime(t, time);
  if (isCameraClip(t)) return cameraRig(cameraFromClip(t, tt, project), project.width, project.height).eye;
  const f = frameOf(project, t, tt, 0);
  return [f[12]!, f[13]!, f[14]!];
}

/** the center of a visual clip in the world at a time, after keyframes, motions and parents (a 2d clip lies at z 0) */
export function worldCenterOf(project: Project, clip: VisualClip, time: number): Vec3 {
  const f = frameOf(project, clip, time, 0);
  return [f[12]!, f[13]!, f[14]!];
}

/** the Euler angles (degrees) of clipModelMatrix's rotation order from a pure rotation matrix (column-major, 3x3 part used) */
function eulerOf(r: ArrayLike<number>): { rotX: number; rotY: number; rotation: number } {
  // R = Ry(a) * Rx(b) * Rz(c); r[col * 4 + row]
  const r12 = r[8 + 1]!;
  const sb = Math.max(-1, Math.min(1, -r12));
  const b = Math.asin(sb);
  let a: number;
  let c: number;
  if (Math.abs(sb) > 1 - 1e-9) {
    c = 0;
    a = Math.atan2(-r[2]!, r[0]!);
  } else {
    a = Math.atan2(r[8]!, r[10]!);
    c = Math.atan2(r[1]!, r[5]!);
  }
  return { rotX: -b / DEG, rotY: -a / DEG, rotation: c / DEG };
}

/**
 * the static transform the clip needs under a new parent (or none) so it stays where it is in the
 * world at `time`. used when attaching / detaching with "keep position".
 */
export function reparentTransform(project: Project, clip: VisualClip, parentId: string | null, time: number): Transform {
  let np: Clip | null = null;
  if (parentId) {
    np = project.clips.find((c) => c.id === parentId) ?? null;
    if (!np || np.id === clip.id || !(isVisualClip(np) || isCameraClip(np))) return clip.transform;
    // a loop is refused by the store; here it just means nothing sensible to compute
    for (const a of ancestors(project, np)) if (a.id === clip.id) return clip.transform;
  }
  const own = ownPose(project, clip, time);
  if (!own.threeD) {
    const w = worldTransformOf(project, own, time);
    let pw: Transform | null = null;
    if (np && isVisualClip(np)) pw = world2d(project, np, clampTime(np, time), 1);
    if (!pw) return { ...clip.transform, x: w.x, y: w.y, scale: w.scale, rotation: w.rotation };
    const rad = -pw.rotation * DEG;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const ps = Math.abs(pw.scale) < 1e-9 ? 1 : pw.scale;
    const dx = w.x - pw.x;
    const dy = w.y - pw.y;
    return {
      ...clip.transform,
      x: (dx * cos - dy * sin) / ps,
      y: (dx * sin + dy * cos) / ps,
      scale: w.scale / ps,
      rotation: w.rotation - pw.rotation,
    };
  }
  // 3d: world frame of the clip, then expressed in the new parent's frame
  const world = frameOf(project, clip, time, 0);
  const base = np ? frameOf(project, np as VisualClip | CameraClip, clampTime(np, time), 1) : trD(project.width / 2, project.height / 2, 0);
  const inv = invertMatrix(base);
  if (!inv) return clip.transform;
  const l = mulD(inv, world);
  const s = Math.hypot(l[0]!, l[1]!, l[2]!);
  if (!(s > 1e-9)) return clip.transform;
  const rot = new Float64Array(16);
  for (let i = 0; i < 3; i++) {
    rot[i] = l[i]! / s;
    rot[4 + i] = l[4 + i]! / s;
    rot[8 + i] = l[8 + i]! / s;
  }
  const e = eulerOf(rot);
  return { ...clip.transform, x: l[12]!, y: l[13]!, z: l[14]!, rotX: e.rotX, rotY: e.rotY, rotation: e.rotation, scale: s };
}

function ancestors(project: Project, c: Clip): Clip[] {
  const out: Clip[] = [];
  let cur: Clip | null = isVisualClip(c) ? parentOf(project, c) : null;
  while (cur && out.length < MAX_PARENT_DEPTH && !out.includes(cur)) {
    out.push(cur);
    cur = isVisualClip(cur) ? parentOf(project, cur) : null;
  }
  return out;
}
