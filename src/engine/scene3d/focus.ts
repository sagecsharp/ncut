/**
 * depth of field for the 3d camera: pure math, no webgl. the shader in renderer.ts repeats `focusBlur`
 * (keep them in step): blur = u_focus.w * dz / (dz + u_focus.z) with dz = max(|depth - distance| - range, 0).
 *
 * the blur radius is a SHARE OF THE FRAME HEIGHT, so a half-size preview is as soft as the export.
 * depth = distance from the camera along its view direction (project pixels).
 */
import type { Vec3 } from './math';

export interface FocusRig {
  /** the sharp distance (project pixels, along the view direction) */
  distance: number;
  /** 0..1, > 0 (a rig with no strength is null instead) */
  strength: number;
  /** depth around `distance` that stays sharp (project pixels) */
  range: number;
}

/** the widest blur radius (strength 1, far out of focus) as a share of the frame height */
export const MAX_BLUR = 0.04;
/** how fast the blur grows: half way to the cap at this share of the focus distance outside the sharp zone */
export const BLUR_REACH = 0.35;

const clamp01 = (v: number): number => (v > 0 ? (v < 1 ? v : 1) : 0);

/** the focus of a camera from its raw values, or null when depth of field is off */
export function makeFocus(strength: number | undefined, distance: number, range: number | undefined): FocusRig | null {
  const s = clamp01(Number.isFinite(strength) ? (strength as number) : 0);
  if (!(s > 0)) return null;
  return {
    distance: Math.max(1, Number.isFinite(distance) ? distance : 1),
    strength: s,
    range: Math.max(0, Number.isFinite(range) ? (range as number) : 0),
  };
}

/** distance the blur curve is scaled by (the shader gets it as a uniform) */
export function blurReach(f: FocusRig): number {
  return Math.max(1, f.distance) * BLUR_REACH;
}

/**
 * blur radius (share of the frame height) of something `depth` away from the camera.
 * 0 inside the sharp zone, grows with the distance from it, never above strength * MAX_BLUR.
 */
export function focusBlur(depth: number, f: FocusRig | null): number {
  if (!f) return 0;
  const dz = Math.max(0, Math.abs(depth - f.distance) - f.range);
  if (dz <= 0) return 0;
  return f.strength * MAX_BLUR * (dz / (dz + blurReach(f)));
}

/** the blur radius in pixels of a frame that is `frameHeight` pixels high */
export function focusBlurPixels(depth: number, f: FocusRig | null, frameHeight: number): number {
  return focusBlur(depth, f) * frameHeight;
}

/**
 * focus distance that puts a point (the target's center) in focus: how far it is from the eye along the view
 * direction. null when it is not in front of the camera.
 */
export function focusDistanceForPoint(eye: Vec3, forward: Vec3, point: Vec3): number | null {
  const d = (point[0] - eye[0]) * forward[0] + (point[1] - eye[1]) * forward[1] + (point[2] - eye[2]) * forward[2];
  return d > 1e-6 ? d : null;
}

/**
 * can anything of a bounding sphere be out of focus? (center `depth`, radius `radius`, both project pixels).
 * false = the whole sphere sits inside the sharp zone, so the shader can skip the blur for that mesh.
 */
export function sphereNeedsBlur(depth: number, radius: number, f: FocusRig | null): boolean {
  if (!f) return false;
  return Math.abs(depth - f.distance) + Math.max(0, radius) > f.range;
}

/** bounding sphere of the unit shape (-0.5..0.5 on each axis) under a column-major model matrix */
export function modelSphere(model: ArrayLike<number>): { center: Vec3; radius: number } {
  const len = (o: number) => Math.hypot(model[o]!, model[o + 1]!, model[o + 2]!);
  const r = 0.5 * Math.sqrt(3) * Math.max(len(0), len(4), len(8));
  return { center: [model[12]!, model[13]!, model[14]!], radius: r };
}

/**
 * can this mesh (unit shape under `model`, seen through `viewProj`) be out of focus? same as sphereNeedsBlur
 * on its bounding sphere, but without allocating: it runs for every mesh of every frame while depth of field is on.
 */
export function meshNeedsBlur(model: ArrayLike<number>, viewProj: ArrayLike<number>, f: FocusRig | null): boolean {
  if (!f) return false;
  const cx = model[12]!;
  const cy = model[13]!;
  const cz = model[14]!;
  const depth = viewProj[3]! * cx + viewProj[7]! * cy + viewProj[11]! * cz + viewProj[15]!;
  const sx = Math.hypot(model[0]!, model[1]!, model[2]!);
  const sy = Math.hypot(model[4]!, model[5]!, model[6]!);
  const sz = Math.hypot(model[8]!, model[9]!, model[10]!);
  return sphereNeedsBlur(depth, 0.5 * Math.sqrt(3) * Math.max(sx, sy, sz), f);
}

/** depth (distance along the view direction) of a world point from a view-projection matrix: its clip w */
export function depthOf(viewProj: ArrayLike<number>, p: Vec3): number {
  return viewProj[3]! * p[0] + viewProj[7]! * p[1] + viewProj[11]! * p[2] + viewProj[15]!;
}

/* ---------- camera -> renderer hand-over ---------- */

/**
 * draw.ts hands the renderer the rig's viewProj matrix; the focus rides along on that very array
 * (cameraRig binds it, renderScene looks it up) so no other file has to pass it.
 */
const bound = new WeakMap<object, FocusRig>();

export function bindFocus(key: object, f: FocusRig | null): void {
  if (f) bound.set(key, f);
}

export function boundFocus(key: object): FocusRig | null {
  return bound.get(key) ?? null;
}
