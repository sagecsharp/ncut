import { useEditor } from '../../store/editorStore';
import type { ActionOpts } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { type AttachPlan, attachPlan } from './attachPlan';

/** write attach plans (store only, no ui): parent and kept transform of each clip, with the given opts */
export function applyAttachPlan(plans: readonly AttachPlan[], opts: ActionOpts): void {
  const st = useEditor.getState();
  for (const plan of plans) {
    st.updateClip(plan.id, plan.patch, opts);
    if (plan.transform) st.updateTransform(plan.id, plan.transform, opts);
  }
}

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
  const plans = attachPlan(p, ids, parentId, usePlayback.getState().time);
  if (plans.length === 0) return 0;
  st.pushHistory();
  applyAttachPlan(plans, { skipHistory: true });
  return plans.length;
}
