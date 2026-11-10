/**
 * the 3d camera. with every value at its default the camera sits straight in front of the canvas at
 * exactly the distance where the z = 0 plane fills the frame, so a 3d clip at z = 0 with no 3d
 * rotation looks the same as a 2d clip. everything is an offset from that home pose.
 */
import { resolveClip, valueAt } from '../../lib/anim';
import { applyClipMotion } from '../clipAnim';
import { worldCenterOf } from '../parent';
import { clipEnd } from '../../lib/timelineOps';
import type { CameraClip, Project } from '../../types';
import { isVisualClip } from '../../types';
import { DEG, type Mat4, type Vec3, add, cross, dot, mul, normalize, rotateAround, scale, transformPoint } from './math';

export interface Camera3D {
  /** position offset from the home pose in project pixels. +x right, +y down, +z forward (toward the canvas) */
  x: number;
  y: number;
  z: number;
  /** degrees. pan: + looks right. tilt: + looks up. roll: + turns the camera clockwise. */
  pan: number;
  tilt: number;
  roll: number;
  /** vertical field of view in degrees. smaller = zoomed in. */
  fov: number;
}

export const DEFAULT_FOV = 50;
export const DEFAULT_CAMERA: Camera3D = { x: 0, y: 0, z: 0, pan: 0, tilt: 0, roll: 0, fov: DEFAULT_FOV };

/** distance from the home camera to the canvas plane */
export function homeDistance(projectHeight: number): number {
  return projectHeight / 2 / Math.tan((DEFAULT_FOV * DEG) / 2);
}

export interface CameraRig {
  eye: Vec3;
  /** unit axes of the camera in world space */
  right: Vec3;
  down: Vec3;
  forward: Vec3;
  view: Mat4;
  proj: Mat4;
  viewProj: Mat4;
  /** tan(fov / 2) */
  tanHalf: number;
  aspect: number;
  near: number;
  far: number;
}

export function cameraRig(cam: Camera3D, projectWidth: number, projectHeight: number): CameraRig {
  const d0 = homeDistance(projectHeight);
  const eye: Vec3 = [projectWidth / 2 + cam.x, projectHeight / 2 + cam.y, -d0 + cam.z];
  let right: Vec3 = [1, 0, 0];
  let down: Vec3 = [0, 1, 0];
  let forward: Vec3 = [0, 0, 1];
  // pan around the world down axis, then tilt around the camera's right, then roll around its forward
  if (cam.pan) {
    right = rotateAround(right, [0, 1, 0], cam.pan * DEG);
    forward = rotateAround(forward, [0, 1, 0], cam.pan * DEG);
  }
  if (cam.tilt) {
    down = rotateAround(down, right, cam.tilt * DEG);
    forward = rotateAround(forward, right, cam.tilt * DEG);
  }
  if (cam.roll) {
    right = rotateAround(right, forward, cam.roll * DEG);
    down = rotateAround(down, forward, cam.roll * DEG);
  }

  const view = new Float32Array(16);
  view[0] = right[0];
  view[4] = right[1];
  view[8] = right[2];
  view[12] = -dot(right, eye);
  view[1] = down[0];
  view[5] = down[1];
  view[9] = down[2];
  view[13] = -dot(down, eye);
  view[2] = forward[0];
  view[6] = forward[1];
  view[10] = forward[2];
  view[14] = -dot(forward, eye);
  view[15] = 1;

  const fov = Math.min(170, Math.max(1, cam.fov || DEFAULT_FOV));
  const tanHalf = Math.tan((fov * DEG) / 2);
  const aspect = projectWidth / projectHeight;
  const near = Math.max(1, d0 * 0.01);
  const far = d0 * 200;
  // camera space is x right, y down, z forward. clip space wants y up and w = depth.
  const proj = new Float32Array(16);
  proj[0] = 1 / (tanHalf * aspect);
  proj[5] = -1 / tanHalf;
  proj[10] = (far + near) / (far - near);
  proj[11] = 1;
  proj[14] = (-2 * far * near) / (far - near);

  return { eye, right, down, forward, view, proj, viewProj: mul(proj, view), tanHalf, aspect, near, far };
}

/**
 * the camera's pose as a matrix (camera space -> world, rigid): columns are right, down, forward, eye.
 * double precision, the inverse of rig.view. used to attach clips to the camera (engine/parent).
 */
export function cameraWorldMatrix(rig: CameraRig): Float64Array {
  const m = new Float64Array(16);
  m.set([...rig.right, 0, ...rig.down, 0, ...rig.forward, 0, ...rig.eye, 1]);
  return m;
}

/** where the home camera (the default camera with no camera clip) sits for a project size */
export function homeEye(projectWidth: number, projectHeight: number): Vec3 {
  return [projectWidth / 2, projectHeight / 2, -homeDistance(projectHeight)];
}

/** how many camera targets are being worked out inside each other right now (see cameraTargetCenter) */
let aiming = 0;

/** the world center of the camera clip's target at a time, or null (no / unknown / self / non visual target) */
export function cameraTargetCenter(project: Project, clip: CameraClip, time: number): Vec3 | null {
  const id = clip.target;
  if (!id || id === clip.id) return null;
  const tc = project.clips.find((c) => c.id === id);
  if (!tc || !isVisualClip(tc)) return null;
  // not visible at that time is fine: use the nearest moment inside the target clip
  const t = Math.min(Math.max(time, tc.start), Math.max(tc.start, clipEnd(tc) - 1e-4));
  // a target attached to something is where its parents put it. a parent can be a camera, whose pose can
  // depend on a target again (even this one): past a few levels fall back to the target's own values.
  if (tc.parent && aiming < 3) {
    aiming++;
    try {
      return worldCenterOf(project, tc, t);
    } finally {
      aiming--;
    }
  }
  const v = applyClipMotion(resolveClip(tc, t), t, project);
  return [project.width / 2 + v.transform.x, project.height / 2 + v.transform.y, v.threeD ? (v.transform.z ?? 0) : 0];
}

/**
 * camera values of a camera clip at a time (keyframes applied). pass the project to honor
 * clip.target: the camera then aims at the target's center and the clip's own pan / tilt are offsets on top.
 */
export function cameraFromClip(clip: CameraClip, time: number, project?: Project): Camera3D {
  const v = (prop: string, fallback: number) => valueAt(clip, prop, time) ?? fallback;
  const cam: Camera3D = {
    x: v('x', 0),
    y: v('y', 0),
    z: v('z', 0),
    pan: v('pan', 0),
    tilt: v('tilt', 0),
    roll: v('roll', 0),
    fov: v('fov', DEFAULT_FOV),
  };
  if (project && clip.target) {
    const c = cameraTargetCenter(project, clip, time);
    if (c) {
      const dx = c[0] - (project.width / 2 + cam.x);
      const dy = c[1] - (project.height / 2 + cam.y);
      const dz = c[2] - (-homeDistance(project.height) + cam.z);
      cam.pan += Math.atan2(dx, dz) / DEG;
      cam.tilt += Math.atan2(-dy, Math.hypot(dx, dz)) / DEG;
    }
  }
  return cam;
}

/** the camera clip in charge at a time: the one on the highest visible track. null = the home camera. */
export function cameraClipAt(project: Project, time: number): CameraClip | null {
  for (const track of project.tracks) {
    if (track.kind !== 'video' || track.hidden) continue;
    for (const clip of project.clips) {
      if (clip.type !== 'camera' || clip.trackId !== track.id) continue;
      if (time >= clip.start - 1e-6 && time < clipEnd(clip) - 1e-6) return clip;
    }
  }
  return null;
}

export function cameraAt(project: Project, time: number): Camera3D {
  const clip = cameraClipAt(project, time);
  return clip ? cameraFromClip(clip, time, project) : DEFAULT_CAMERA;
}

/** true when any visible clip is 3d or a camera clip exists at the time */
export function uses3dAt(project: Project, time: number): boolean {
  for (const clip of project.clips) {
    if (time < clip.start - 1e-6 || time >= clipEnd(clip) - 1e-6) continue;
    if (clip.type === 'camera') return true;
    if (isVisualClip(clip) && clip.threeD) return true;
  }
  return false;
}

/**
 * world point -> canvas pixels (project units). `visible` is false behind the camera.
 * depth is the distance along the camera's forward axis.
 */
export function projectPoint(
  rig: CameraRig,
  x: number,
  y: number,
  z: number,
  projectWidth: number,
  projectHeight: number,
): { x: number; y: number; depth: number; visible: boolean } {
  const c = transformPoint(rig.viewProj, x, y, z);
  const w = c[3];
  if (w <= 1e-6) return { x: 0, y: 0, depth: w, visible: false };
  return {
    x: ((c[0] / w) * 0.5 + 0.5) * projectWidth,
    y: (1 - ((c[1] / w) * 0.5 + 0.5)) * projectHeight,
    depth: w,
    visible: true,
  };
}

/** the ray through a canvas pixel (project units): origin = the eye, dir = unit vector into the scene */
export function screenRay(
  rig: CameraRig,
  px: number,
  py: number,
  projectWidth: number,
  projectHeight: number,
): { origin: Vec3; dir: Vec3 } {
  const nx = (px / projectWidth) * 2 - 1;
  const ny = (py / projectHeight) * 2 - 1;
  const dir = normalize(
    add(add(scale(rig.right, nx * rig.tanHalf * rig.aspect), scale(rig.down, ny * rig.tanHalf)), rig.forward),
  );
  return { origin: rig.eye, dir };
}

/** where a ray hits the plane through `point` with unit `normal`, or null when parallel / behind */
export function rayPlane(origin: Vec3, dir: Vec3, point: Vec3, normal: Vec3): Vec3 | null {
  const denom = dot(dir, normal);
  if (Math.abs(denom) < 1e-9) return null;
  const t = dot([point[0] - origin[0], point[1] - origin[1], point[2] - origin[2]], normal) / denom;
  if (t <= 0) return null;
  return add(origin, scale(dir, t));
}

/** the 4 world corners (tl, tr, br, bl) of what the camera sees at a distance along its forward axis */
export function frustumCorners(rig: CameraRig, distance: number): [Vec3, Vec3, Vec3, Vec3] {
  const hx = rig.tanHalf * rig.aspect * distance;
  const hy = rig.tanHalf * distance;
  const c = add(rig.eye, scale(rig.forward, distance));
  const at = (sx: number, sy: number): Vec3 => add(add(c, scale(rig.right, sx * hx)), scale(rig.down, sy * hy));
  return [at(-1, -1), at(1, -1), at(1, 1), at(-1, 1)];
}

export { cross };
