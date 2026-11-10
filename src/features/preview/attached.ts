/** helpers for clips that are attached to a parent (Spatial.parent): the overlays work at the world pose. pure, no dom. */
import { worldDeltaToLocal, worldTransform } from '../../engine/parent';
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
