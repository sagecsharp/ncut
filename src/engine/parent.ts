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
import type { Project, Transform, VisualClip } from '../types';

/**
 * the clip's transform in the world (canvas) frame at a timeline time: keyframes, motions and every
 * parent applied. without a parent this is the clip's own animated transform.
 */
export function worldTransform(project: Project, clip: VisualClip, time: number): Transform {
  void project;
  void time;
  return clip.transform;
}

/**
 * turn a movement in the world frame (canvas pixels) into the change of clip.transform.x / y that
 * produces it, for dragging a child in the preview.
 */
export function worldDeltaToLocal(project: Project, clip: VisualClip, time: number, dx: number, dy: number): { x: number; y: number } {
  void project;
  void clip;
  void time;
  return { x: dx, y: dy };
}

/**
 * the static transform the clip needs under a new parent (or none) so it stays where it is in the
 * world at `time`. used when attaching / detaching with "keep position".
 */
export function reparentTransform(project: Project, clip: VisualClip, parentId: string | null, time: number): Transform {
  void project;
  void parentId;
  void time;
  return clip.transform;
}
