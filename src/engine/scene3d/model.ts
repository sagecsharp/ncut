/** where a 3d clip's plane sits in the world. */
import type { LookAt, Project, Transform, VisualClip } from '../../types';
import type { ClipBox } from '../draw';
import { clipLookPoint, parentModelMatrix } from '../parent';
import { DEG, type Mat4, type Vec3, basis, cross, mul, normalize, rotationX, rotationY, rotationZ, scaling, sub, translation, transformPoint } from './math';

/**
 * model matrix of a clip plane: unit quad -> world.
 *   center = (box.cx, box.cy, transform.z)
 *   rotation = [look at camera] * turn (rotY) * tilt (rotX) * spin (rotation, in the plane)
 * user facing signs: turn > 0 faces the plane to the right (its right edge moves away),
 * tilt > 0 leans the top edge away, rotation > 0 spins clockwise.
 * with lookAt the plane first faces the camera, and turn / tilt / spin are applied on top of that.
 * lookAt 'clip' faces `lookPoint` (clipLookPoint) the same way as 'camera' faces the eye: the "eye" is just
 * the point to look at. without a point (or when it is the plane's own center) there is no turn.
 */
export function clipModelMatrix(box: ClipBox, transform: Transform, lookAt: LookAt | undefined, eye: Vec3, parent?: Mat4 | null, lookPoint?: Vec3 | null): Mat4 {
  // with a parent (engine/parent parentModelMatrix) x / y / z are offsets in the parent's frame and box.cx / cy are not used.
  // the parent's rotation and uniform scale come with the matrix; lookAt replaces the rotation but keeps the scale.
  const frame = parent ? mul(parent, translation(transform.x, transform.y, transform.z ?? 0)) : null;
  const center: Vec3 = frame ? [frame[12]!, frame[13]!, frame[14]!] : [box.cx, box.cy, transform.z ?? 0];
  // the point the plane turns to face
  const aim: Vec3 | null = lookAt === 'camera' || lookAt === 'cameraY' ? eye : lookAt === 'clip' && lookPoint ? lookPoint : null;
  const same = !!aim && lookAt === 'clip' && aim[0] === center[0] && aim[1] === center[1] && aim[2] === center[2];
  const turn = !!aim && !same;
  let m = frame && !turn ? frame : translation(center[0], center[1], center[2]);
  if (turn && aim) {
    // local +z points away from the viewer, so it follows the line from the eye to the plane
    let f = sub(center, aim);
    if (lookAt === 'cameraY') f = [f[0], 0, f[2]];
    f = normalize(f);
    if (f[0] === 0 && f[1] === 0 && f[2] === 0) f = [0, 0, 1];
    let r = normalize(cross([0, 1, 0], f));
    if (r[0] === 0 && r[1] === 0 && r[2] === 0) r = [1, 0, 0];
    const d = cross(f, r);
    m = mul(m, basis(r, d, f));
    if (parent) {
      const k = Math.hypot(parent[0]!, parent[1]!, parent[2]!);
      if (k !== 1 && k > 0) m = mul(m, scaling(k, k, k));
    }
  }
  const rotY = transform.rotY ?? 0;
  const rotX = transform.rotX ?? 0;
  if (rotY) m = mul(m, rotationY(-rotY * DEG));
  if (rotX) m = mul(m, rotationX(-rotX * DEG));
  if (box.rotation) m = mul(m, rotationZ(box.rotation * DEG));
  return mul(m, scaling(box.width, box.height, 1));
}

/** the 4 world corners of a clip plane: top left, top right, bottom right, bottom left */
export function planeCorners(model: Mat4): [Vec3, Vec3, Vec3, Vec3] {
  const at = (x: number, y: number): Vec3 => {
    const p = transformPoint(model, x, y, 0);
    return [p[0], p[1], p[2]];
  };
  return [at(-0.5, -0.5), at(0.5, -0.5), at(0.5, 0.5), at(-0.5, 0.5)];
}

/**
 * clipModelMatrix for a clip as it is drawn at a time: follows clip.parent. `clip` has its keyframes
 * applied (like the layer the renderer draws), `box` is getClipBox of it.
 */
export function clipWorldModel(project: Project, clip: VisualClip, time: number, box: ClipBox, eye: Vec3): Mat4 {
  return clipModelMatrix(box, clip.transform, clip.lookAt, eye, clip.parent ? parentModelMatrix(project, clip, time) : null, clipLookPoint(project, clip, time));
}
