/** where a 3d clip's plane sits in the world. */
import type { LookAt, Transform } from '../../types';
import type { ClipBox } from '../draw';
import { DEG, type Mat4, type Vec3, basis, cross, mul, normalize, rotationX, rotationY, rotationZ, scaling, sub, translation, transformPoint } from './math';

/**
 * model matrix of a clip plane: unit quad -> world.
 *   center = (box.cx, box.cy, transform.z)
 *   rotation = [look at camera] * turn (rotY) * tilt (rotX) * spin (rotation, in the plane)
 * user facing signs: turn > 0 faces the plane to the right (its right edge moves away),
 * tilt > 0 leans the top edge away, rotation > 0 spins clockwise.
 * with lookAt the plane first faces the camera, and turn / tilt / spin are applied on top of that.
 */
export function clipModelMatrix(box: ClipBox, transform: Transform, lookAt: LookAt | undefined, eye: Vec3): Mat4 {
  const center: Vec3 = [box.cx, box.cy, transform.z ?? 0];
  let m = translation(center[0], center[1], center[2]);
  if (lookAt === 'camera' || lookAt === 'cameraY') {
    // local +z points away from the viewer, so it follows the line from the eye to the plane
    let f = sub(center, eye);
    if (lookAt === 'cameraY') f = [f[0], 0, f[2]];
    f = normalize(f);
    if (f[0] === 0 && f[1] === 0 && f[2] === 0) f = [0, 0, 1];
    let r = normalize(cross([0, 1, 0], f));
    if (r[0] === 0 && r[1] === 0 && r[2] === 0) r = [1, 0, 0];
    const d = cross(f, r);
    m = mul(m, basis(r, d, f));
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
