import { reparentTransform } from '../../engine/parent';
import { clamp } from '../../lib/time';
import type { ClipPatch } from '../../store/editorStore';
import { isCameraClip, isVisualClip } from '../../types';
import type { Project, Transform } from '../../types';
import { hasAnimatedPose } from './parentOptions';

export interface AttachPlan {
  id: string;
  /** { parent } and threeD: true for a 2d clip attached to a camera */
  patch: ClipPatch;
  /** the transform that keeps the clip where it is, null when its pose is keyed (the keys stay, only the parent changes) */
  transform: Transform | null;
}

/**
 * the writes that attach these visual clips to a parent (or detach them with null) so each keeps its place on screen at
 * `time` (clamped into each clip). a clip that already has that parent is left out. [] when the parent is unknown.
 */
export function attachPlan(project: Project, ids: readonly string[], parentId: string | null, time: number): AttachPlan[] {
  const parent = parentId ? project.clips.find((c) => c.id === parentId) : null;
  if (parentId && !parent) return [];
  const plans: AttachPlan[] = [];
  for (const clip of project.clips) {
    if (!ids.includes(clip.id) || !isVisualClip(clip)) continue;
    if ((clip.parent ?? null) === parentId) continue;
    const patch: Record<string, unknown> = { parent: parentId };
    if (parent && isCameraClip(parent) && !clip.threeD) patch.threeD = true;
    // computed from the project as it is now, before anything is written
    const transform = hasAnimatedPose(clip) ? null : reparentTransform(project, clip, parentId, clamp(time, clip.start, clip.start + clip.duration));
    plans.push({ id: clip.id, patch: patch as ClipPatch, transform });
  }
  return plans;
}
