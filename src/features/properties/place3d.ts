/**
 * 3d placement helpers: pure math. world space = canvas pixels, x right, y down, +z away from the viewer.
 * a clip's frame is translate * turn(rotY) * tilt(rotX) * spin(rotation) * uniform scale, under its parent's
 * frame (or the canvas center). same conventions as engine/parent.ts. matrices are column-major.
 */
import { DEFAULT_FOV, homeDistance } from '../../engine/scene3d/camera';
import { DEG, cross, dot, normalize, rotateAround } from '../../engine/scene3d/math';
import type { Vec3 } from '../../engine/scene3d/math';
import { stretchX, stretchY, stretchZ } from '../../types';

type M = Float64Array;

/** the axes of a camera in world space (a CameraRig fits) */
export interface ViewAxes {
  eye: Vec3;
  right: Vec3;
  down: Vec3;
  forward: Vec3;
}

/** the numbers stored in a clip transform that place it */
export interface PoseValues {
  x: number;
  y: number;
  z: number;
  rotX: number;
  rotY: number;
  rotation: number;
  scale: number;
}

/** how much of the frame a framed clip fills */
export const FRAME_FILL = 0.8;

/* ---------- matrices ---------- */

function ident(): M {
  const m = new Float64Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}
function mul(a: ArrayLike<number>, b: ArrayLike<number>): M {
  const o = new Float64Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r]! * b[c * 4]! + a[4 + r]! * b[c * 4 + 1]! + a[8 + r]! * b[c * 4 + 2]! + a[12 + r]! * b[c * 4 + 3]!;
    }
  }
  return o;
}
function tr(x: number, y: number, z: number): M {
  const m = ident();
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
}
function rotXm(rad: number): M {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const m = ident();
  m[5] = c;
  m[6] = s;
  m[9] = -s;
  m[10] = c;
  return m;
}
function rotYm(rad: number): M {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const m = ident();
  m[0] = c;
  m[2] = -s;
  m[8] = s;
  m[10] = c;
  return m;
}
function rotZm(rad: number): M {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const m = ident();
  m[0] = c;
  m[1] = s;
  m[4] = -s;
  m[5] = c;
  return m;
}

/** inverse of a rigid motion with a uniform scale (what every clip frame is), or null when degenerate */
function inverseSimilarity(m: ArrayLike<number>): M | null {
  const s2 = m[0]! * m[0]! + m[1]! * m[1]! + m[2]! * m[2]!;
  if (!(s2 > 1e-18) || !Number.isFinite(s2)) return null;
  const o = new Float64Array(16);
  // transpose of the 3x3 part, divided by s^2
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) o[c * 4 + r] = m[r * 4 + c]! / s2;
  for (let r = 0; r < 3; r++) o[12 + r] = -(o[r]! * m[12]! + o[4 + r]! * m[13]! + o[8 + r]! * m[14]!);
  o[15] = 1;
  return o;
}

/** uniform scale of a frame matrix */
export function frameScale(m: ArrayLike<number> | null): number {
  return m ? Math.hypot(m[0]!, m[1]!, m[2]!) : 1;
}

/** local matrix of a pose: translate * turn * tilt * spin * scale. a flat clip stays in the canvas plane. */
function localMatrix(p: PoseValues, threeD: boolean): M {
  let m = tr(p.x, p.y, threeD ? p.z : 0);
  if (threeD) {
    if (p.rotY) m = mul(m, rotYm(-p.rotY * DEG));
    if (p.rotX) m = mul(m, rotXm(-p.rotX * DEG));
  }
  if (p.rotation) m = mul(m, rotZm(p.rotation * DEG));
  if (p.scale !== 1) {
    const s = ident();
    s[0] = s[5] = s[10] = p.scale;
    m = mul(m, s);
  }
  return m;
}

function baseOf(parent: ArrayLike<number> | null, w: number, h: number): ArrayLike<number> {
  return parent ?? tr(w / 2, h / 2, 0);
}

/** world frame of a clip pose under a parent frame (null = the canvas center) */
export function frameMatrix(parent: ArrayLike<number> | null, w: number, h: number, pose: PoseValues, threeD: boolean): M {
  return mul(baseOf(parent, w, h), localMatrix(pose, threeD));
}

/** Euler angles of clip rotation order (turn, tilt, spin) from the unit axes of a frame */
export function eulerOfAxes(right: Vec3, down: Vec3, normal: Vec3): { rotX: number; rotY: number; rotation: number } {
  // R = Ry(a) * Rx(b) * Rz(c), columns right / down / normal
  const sb = Math.max(-1, Math.min(1, -normal[1]));
  const b = Math.asin(sb);
  let a: number;
  let c: number;
  if (Math.abs(sb) > 1 - 1e-9) {
    c = 0;
    a = Math.atan2(-right[2], right[0]);
  } else {
    a = Math.atan2(normal[0], normal[2]);
    c = Math.atan2(right[1], down[1]);
  }
  return { rotX: -b / DEG, rotY: -a / DEG, rotation: c / DEG };
}

/**
 * the world axes of a pose with its tilt set to `rotX`, as if it had no parent: the wanted orientation of
 * "lay flat" / "stand up" in the world. turn and spin of the pose are kept.
 */
export function tiltedAxes(pose: PoseValues, rotX: number): { right: Vec3; down: Vec3; normal: Vec3 } {
  const m = localMatrix({ ...pose, x: 0, y: 0, z: 0, rotX, scale: 1 }, true);
  const a = axesOf(m);
  return { right: a.right, down: a.down, normal: a.normal };
}

/** the world matrix of a placement: center, the three unit axes of the clip and a uniform scale */
export function worldMatrix(center: Vec3, right: Vec3, down: Vec3, normal: Vec3, scale: number): M {
  const m = ident();
  for (let i = 0; i < 3; i++) {
    m[i] = right[i]! * scale;
    m[4 + i] = down[i]! * scale;
    m[8 + i] = normal[i]! * scale;
    m[12 + i] = center[i]!;
  }
  return m;
}

/** the unit axes (right, down, normal) of a frame matrix */
export function axesOf(m: ArrayLike<number>): { right: Vec3; down: Vec3; normal: Vec3; center: Vec3 } {
  return {
    right: normalize([m[0]!, m[1]!, m[2]!]),
    down: normalize([m[4]!, m[5]!, m[6]!]),
    normal: normalize([m[8]!, m[9]!, m[10]!]),
    center: [m[12]!, m[13]!, m[14]!],
  };
}

/**
 * the pose values a clip needs under `parent` (null = canvas center) to sit at a world matrix.
 * null when the parent cannot be inverted.
 */
export function poseFromWorld(parent: ArrayLike<number> | null, w: number, h: number, world: ArrayLike<number>): PoseValues | null {
  const inv = inverseSimilarity(baseOf(parent, w, h));
  if (!inv) return null;
  const l = mul(inv, world);
  const s = Math.hypot(l[0]!, l[1]!, l[2]!);
  if (!(s > 1e-9) || !Number.isFinite(s)) return null;
  const right: Vec3 = [l[0]! / s, l[1]! / s, l[2]! / s];
  const down: Vec3 = [l[4]! / s, l[5]! / s, l[6]! / s];
  const normal: Vec3 = [l[8]! / s, l[9]! / s, l[10]! / s];
  const e = eulerOfAxes(right, down, normal);
  return { x: l[12]!, y: l[13]!, z: l[14]!, rotX: e.rotX, rotY: e.rotY, rotation: e.rotation, scale: s };
}

/* ---------- put in front of the camera ---------- */

/** distance from the camera where a flat clip appears at its 2d size */
export function flatDistance(fov: number, projectHeight: number): number {
  const f = Math.min(170, Math.max(1, fov || DEFAULT_FOV));
  return projectHeight / 2 / Math.tan((f * DEG) / 2);
}

/** depth of a world point along the camera's forward axis */
export function depthIn(view: ViewAxes, p: Vec3): number {
  return dot([p[0] - view.eye[0], p[1] - view.eye[1], p[2] - view.eye[2]], view.forward);
}

/** a point in the camera's view: `depth` ahead of the eye, offset along right / down / forward */
export function pointInView(view: ViewAxes, depth: number, ox = 0, oy = 0, oz = 0): Vec3 {
  const d = depth + oz;
  return [
    view.eye[0] + view.forward[0] * d + view.right[0] * ox + view.down[0] * oy,
    view.eye[1] + view.forward[1] * d + view.right[1] * ox + view.down[1] * oy,
    view.eye[2] + view.forward[2] * d + view.right[2] * ox + view.down[2] * oy,
  ];
}

export interface FrontItem {
  /** world center of the clip now */
  center: Vec3;
  /** the clip is 3d already: keep its distance from the camera (when it is in front) instead of the flat distance */
  keepDepth: boolean;
}

/** nearest depth a kept distance may have; closer or behind the camera falls back to the flat distance */
const MIN_KEEP_DEPTH = 1;

/**
 * new world centers so the clips sit centered in the camera's view. the group keeps its offsets (read in the
 * home axes, applied in the camera's), its middle lands at the mean of the clips' distances.
 */
export function placeInFront(view: ViewAxes, items: readonly FrontItem[], flatDist: number): Vec3[] {
  const n = items.length;
  if (n === 0) return [];
  let depth = 0;
  const mid: Vec3 = [0, 0, 0];
  for (const it of items) {
    const d = depthIn(view, it.center);
    depth += it.keepDepth && d > MIN_KEEP_DEPTH ? d : flatDist;
    for (let i = 0; i < 3; i++) mid[i] = mid[i]! + it.center[i]! / n;
  }
  depth /= n;
  return items.map((it) =>
    pointInView(view, depth, it.center[0] - mid[0], it.center[1] - mid[1], it.center[2] - mid[2]),
  );
}

/* ---------- frame with the camera ---------- */

export interface CameraValues {
  x: number;
  y: number;
  z: number;
  pan: number;
  tilt: number;
  roll: number;
}

/** pan, tilt and roll (degrees) of a camera whose axes are given, in the order cameraRig applies them */
export function cameraAngles(right: Vec3, down: Vec3, forward: Vec3): { pan: number; tilt: number; roll: number } {
  void right;
  const pan = Math.atan2(forward[0], forward[2]);
  const tilt = Math.atan2(-forward[1], Math.hypot(forward[0], forward[2]));
  // the axes the camera has with this pan and tilt and no roll
  const r0 = rotateAround([1, 0, 0], [0, 1, 0], pan);
  const f0 = rotateAround([0, 0, 1], [0, 1, 0], pan);
  const d0 = rotateAround([0, 1, 0], r0, tilt);
  const f1 = rotateAround(f0, r0, tilt);
  const roll = Math.atan2(dot(cross(f1, d0), down), dot(d0, down));
  return { pan: pan / DEG, tilt: tilt / DEG, roll: roll / DEG };
}

/** distance at which a w x h box fills `fill` of the frame (the limiting side wins) */
export function fitDistance(w: number, h: number, fov: number, aspect: number, fill = FRAME_FILL): number {
  const f = Math.min(170, Math.max(1, fov || DEFAULT_FOV));
  const t = Math.tan((f * DEG) / 2);
  const f2 = Math.max(0.01, fill);
  return Math.max(h / (2 * t * f2), w / (2 * t * aspect * f2));
}

/**
 * the camera that sees a box straight on from its front side. center / axes are the box's world frame
 * (the viewer sits on the -normal side, looking along +normal, upright along `down`), w x h its world size.
 */
export function frameCamera(
  center: Vec3,
  right: Vec3,
  down: Vec3,
  normal: Vec3,
  w: number,
  h: number,
  fov: number,
  projectWidth: number,
  projectHeight: number,
  fill = FRAME_FILL,
): CameraValues {
  const d = fitDistance(w, h, fov, projectWidth / projectHeight, fill);
  const eye: Vec3 = [center[0] - normal[0] * d, center[1] - normal[1] * d, center[2] - normal[2] * d];
  const a = cameraAngles(right, down, normal);
  return {
    x: eye[0] - projectWidth / 2,
    y: eye[1] - projectHeight / 2,
    z: eye[2] + homeDistance(projectHeight),
    pan: a.pan,
    tilt: a.tilt,
    roll: a.roll,
  };
}

/* ---------- floor ---------- */

/** world y of the floor line: the bottom of the frame */
export function floorY(projectHeight: number): number {
  return projectHeight;
}

/**
 * how far a w x h clip reaches up and down from its center in the world (its vertical extent, total).
 * a solid has a thickness along the clip's normal: pass `depth` and `normal` to count it too.
 */
export function verticalExtent(w: number, h: number, right: Vec3, down: Vec3, depth = 0, normal?: Vec3, round = false): number {
  const thick = depth > 0 && normal ? Math.abs(depth * normal[1]) : 0;
  // a ball reaches as far as its radii along the three axes combine (an ellipsoid), not as far as the box around it
  if (round) return Math.hypot(w * right[1], h * down[1], thick);
  return Math.abs(w * right[1]) + Math.abs(h * down[1]) + thick;
}

/** world y of a clip's center so its lowest edge rests on the floor line */
export function floorCenterY(projectHeight: number, w: number, h: number, right: Vec3, down: Vec3, depth = 0, normal?: Vec3, round = false): number {
  return floorY(projectHeight) - verticalExtent(w, h, right, down, depth, normal, round) / 2;
}

export const normalizeVec = normalize;

/**
 * thickness of a 3d solid in the world: shapeDepth x scale x the depth stretch. while no thickness is set the solid is
 * as deep as it is wide (a box: tall) at scale 100% and no stretch, so the depth stretch comes on top of the side's own
 * stretch. size is the world size of the box (stretch and parents in it), extra the scale the parents add.
 */
export function solidDepthOf(
  c: {
    threeD?: boolean;
    shape?: string;
    shapeDepth?: number;
    transform: { scale: number; scaleX?: number; scaleY?: number; scaleZ?: number };
  },
  size: { w: number; h: number },
  extra: number,
): number {
  const shape = c.shape ?? 'plane';
  if (!c.threeD || shape === 'plane') return 0;
  const sz = stretchZ(c.transform);
  if (c.shapeDepth !== undefined && c.shapeDepth > 0 && shape !== 'sphere') return c.shapeDepth * c.transform.scale * sz * extra;
  return shape === 'box' ? (size.h / stretchY(c.transform)) * sz : (size.w / stretchX(c.transform)) * sz;
}
