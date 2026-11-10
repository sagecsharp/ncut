/** helpers for clips that are attached to a parent (Spatial.parent): the overlays work at the world pose. pure, no dom. */
import { parentModelMatrix, worldDeltaToLocal, worldTransform } from '../../engine/parent';
import type { Vec3 } from '../../engine/scene3d/math';
import { resolveClip } from '../../lib/anim';
import { parentChain } from '../../lib/links';
import type { Project, VisualClip } from '../../types';

/** true when the clip is attached to something (a parent id is set; the engine ignores unknown ids on its own) */
export function isAttached(clip: VisualClip): boolean {
  return !!clip.parent;
}

/**
 * the clip as the renderer draws it at a time: keyframes baked, and for an attached clip the transform replaced by
 * its pose in the world. the result is only for measuring (boxes, outlines), never for writing back to the store.
 */
export function worldClip<T extends VisualClip>(project: Project, raw: T, time: number): T {
  const resolved = resolveClip(raw, time);
  if (!raw.parent) return resolved;
  return { ...resolved, transform: worldTransform(project, raw, time) };
}

/** a world movement (canvas px) as the change of the clip's own x / y. same numbers for a clip without a parent. */
export function localDelta(project: Project, raw: VisualClip, time: number, dx: number, dy: number): { x: number; y: number } {
  if (!raw.parent) return { x: dx, y: dy };
  return worldDeltaToLocal(project, raw, time, dx, dy);
}

/**
 * the clips of a drag that really need to be written: a clip whose parent (or grandparent...) is dragged too
 * rides along with it, so moving it as well would move it twice.
 */
export function withoutRidingChildren<T extends VisualClip>(project: Project, clips: readonly T[]): T[] {
  const ids = new Set(clips.map((c) => c.id));
  return clips.filter((c) => !c.parent || !parentChain(project, c).some((p) => ids.has(p.id)));
}

/**
 * a movement in the world turned into the movement in a frame given by a column-major 4x4 matrix: the inverse of its
 * linear (3x3) part times the vector. null when the matrix cannot be inverted (a parent scaled to nothing).
 */
export function worldVectorToFrame(m: ArrayLike<number>, d: Vec3): Vec3 | null {
  // columns of the 3x3 part
  const a = m[0]!, b = m[1]!, c = m[2]!;
  const e = m[4]!, f = m[5]!, g = m[6]!;
  const h = m[8]!, i = m[9]!, j = m[10]!;
  const det = a * (f * j - g * i) - e * (b * j - c * i) + h * (b * g - c * f);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const k = 1 / det;
  // inverse rows applied to d (the matrix is [col0 col1 col2], so M = [[a e h] [b f i] [c g j]])
  const x = ((f * j - g * i) * d[0] + (h * g - e * j) * d[1] + (e * i - h * f) * d[2]) * k;
  const y = ((c * i - b * j) * d[0] + (a * j - c * h) * d[1] + (b * h - a * i) * d[2]) * k;
  const z = ((b * g - c * f) * d[0] + (c * e - a * g) * d[1] + (a * f - b * e) * d[2]) * k;
  return [x, y, z];
}

/**
 * a movement in the world (canvas px, x y z) as the change of the clip's own x / y / z, for a real 3d clip that is
 * attached to something: the offsets live in the parent's frame, which moves, turns around any axis and scales.
 * exact for any parent pose. a clip without a parent gets the vector back.
 */
export function localDelta3(project: Project, raw: VisualClip, time: number, d: Vec3): Vec3 {
  if (!raw.parent) return d;
  const parent = parentModelMatrix(project, raw, time);
  if (!parent) return d;
  return worldVectorToFrame(parent, d) ?? d;
}
