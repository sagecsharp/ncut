import { reparentTransform } from '../../engine/parent';
import { clamp } from '../../lib/time';
import { useEditor } from '../../store/editorStore';
import type { ClipPatch } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { isCameraClip, isVisualClip } from '../../types';
import { hasAnimatedPose } from './parentOptions';

/**
 * attach visual clips to a parent (or detach with null) as ONE undo step. every clip keeps its place
 * on screen at the playhead: parent and the new transform are written together. clips with animated
 * x / y / scale / rotation keep their keys untouched (only the parent changes). a 2d clip attached to
 * a camera becomes 3d in the same step. returns how many clips changed.
 */
export function attachClips(ids: readonly string[], parentId: string | null): number {
  const st = useEditor.getState();
  const p = st.project;
  if (!p) return 0;
  const parent = parentId ? p.clips.find((c) => c.id === parentId) : null;
  if (parentId && !parent) return 0;
  const time = usePlayback.getState().time;
  const plans: { id: string; patch: ClipPatch; transform: ReturnType<typeof reparentTransform> | null }[] = [];
  for (const clip of p.clips) {
    if (!ids.includes(clip.id) || !isVisualClip(clip)) continue;
    if ((clip.parent ?? null) === parentId) continue;
    const patch: Record<string, unknown> = { parent: parentId };
    if (parent && isCameraClip(parent) && !clip.threeD) patch.threeD = true;
    // computed from the project as it is now, before anything is written
    const transform = hasAnimatedPose(clip) ? null : reparentTransform(p, clip, parentId, clamp(time, clip.start, clip.start + clip.duration));
    plans.push({ id: clip.id, patch: patch as ClipPatch, transform });
  }
  if (plans.length === 0) return 0;
  st.pushHistory();
  for (const plan of plans) {
    st.updateClip(plan.id, plan.patch, { skipHistory: true });
    if (plan.transform) st.updateTransform(plan.id, plan.transform, { skipHistory: true });
  }
  return plans.length;
}
