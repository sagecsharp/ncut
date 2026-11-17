import { PIVOT_SPOTS, type PivotSpot, normalizePivot, pivotOf } from '../../engine/pivot';
import { type ActionOpts, useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { useUi } from '../../store/ui';
import { isVisualClip } from '../../types';
import type { Keyframes, Pivot, Project } from '../../types';
import { liveOpts } from './edit';
import { type PivotPlan, meetSpot, pivotPlan } from './pivotPlan';

const toast = (msg: string, kind?: 'info' | 'error') => useUi.getState().toast(msg, kind);

const NO_PLACE = 'a clip attached to it is on a locked track, unlock it to move the pivot';

/** add d to x / y / z of one clip: every key of a keyed property, the plain value of the others. a d of exactly 0 writes nothing */
function shiftClip(id: string, d: readonly [number, number, number], opts: ActionOpts): void {
  const st = useEditor.getState();
  const clip = st.project?.clips.find((c) => c.id === id);
  if (!clip || !isVisualClip(clip)) return;
  const props = ['x', 'y', 'z'] as const;
  let kf: Keyframes | null = null;
  const plain: Record<string, number> = {};
  props.forEach((prop, i) => {
    const v = d[i]!;
    if (v === 0) return;
    const keys = clip.keyframes?.[prop];
    if (keys && keys.length > 0) {
      kf = { ...(kf ?? clip.keyframes ?? {}), [prop]: keys.map((k) => ({ ...k, v: k.v + v })) };
    } else {
      plain[prop] = ((clip.transform as unknown as Record<string, number | undefined>)[prop] ?? 0) + v;
    }
  });
  if (kf) st.setClipKeyframes(id, kf, opts);
  if (Object.keys(plain).length > 0) st.updateTransform(id, plain, opts);
}

/** write a pivot plan (store only, no ui): the pivot, the clip's x / y / z (or every key of them), each child's. unrounded */
export function applyPivotPlan(id: string, plan: PivotPlan, opts: ActionOpts): void {
  const st = useEditor.getState();
  st.updateClip(id, { pivot: plan.pivot }, opts);
  shiftClip(id, plan.dt, opts);
  for (const c of plan.children) shiftClip(c.id, c.dv, opts);
}

const trackLocked = (p: Project, id: string): boolean => {
  const c = p.clips.find((x) => x.id === id);
  return !!c && !!p.tracks.find((t) => t.id === c.trackId)?.locked;
};

/**
 * give one clip a pivot (null = the middle), kept in place at the playhead. one undo step: live = part of a field or
 * drag gesture (beginEdit + liveOpts), otherwise its own step. returns false when nothing was written.
 */
export function setPivot(id: string, next: Pivot | null, opts?: { live?: boolean }): boolean {
  const st = useEditor.getState();
  const p = st.project;
  if (!p) return false;
  const clip = p.clips.find((c) => c.id === id);
  if (!clip || !isVisualClip(clip) || trackLocked(p, id)) return false;
  const plan = pivotPlan(p, id, next, usePlayback.getState().time);
  if (!plan) return false;
  if (plan.locked.length > 0) {
    // a live gesture calls this every frame: toast once while it shows
    if (!opts?.live || !useUi.getState().toasts.some((x) => x.message === NO_PLACE)) toast(NO_PLACE);
    return false;
  }
  if (opts?.live) {
    applyPivotPlan(id, plan, liveOpts());
  } else {
    st.pushHistory();
    applyPivotPlan(id, plan, { skipHistory: true });
  }
  return true;
}

/** one axis of the pivot from a slider (fraction), the other axis as stored now. live */
export function setPivotAxis(id: string, axis: 'x' | 'y', value: number): void {
  const clip = useEditor.getState().project?.clips.find((c) => c.id === id);
  if (!clip || !isVisualClip(clip)) return;
  const now = pivotOf(clip);
  setPivot(id, normalizePivot({ x: axis === 'x' ? value : now.x, y: axis === 'y' ? value : now.y }), { live: true });
}

/** the same spot for every selected picture clip, each kept in place, one undo step. returns how many changed */
export function setPivotMany(ids: readonly string[], spot: PivotSpot): number {
  const st = useEditor.getState();
  if (!st.project) return 0;
  const time = usePlayback.getState().time;
  const next = normalizePivot({ x: spot.x, y: spot.y });
  let changed = 0;
  let left = 0;
  let onLocked = 0;
  let pushed = false;
  for (const id of ids) {
    // a fresh plan from the project as it is now: a child moved by the plan of its parent is planned after it
    const p = useEditor.getState().project;
    if (!p) break;
    const clip = p.clips.find((c) => c.id === id);
    if (!clip || !isVisualClip(clip)) continue;
    if (trackLocked(p, id)) {
      onLocked++;
      continue;
    }
    const plan = pivotPlan(p, id, next, time);
    if (!plan) continue;
    if (plan.locked.length > 0) {
      left++;
      continue;
    }
    if (!pushed) {
      st.pushHistory();
      pushed = true;
    }
    applyPivotPlan(id, plan, { skipHistory: true });
    changed++;
  }
  if (left > 0) toast(left === 1 ? '1 clip was left out: a clip attached to it is on a locked track' : `${left} clips were left out: a clip attached to it is on a locked track`);
  if (onLocked > 0) toast(onLocked === 1 ? '1 clip is on a locked track' : `${onLocked} clips are on a locked track`);
  return changed;
}

/** the pivot on the spot where the clip meets the clip it is attached to (meetSpot), kept in place */
export function pivotWhereTheyMeet(id: string): boolean {
  const p = useEditor.getState().project;
  if (!p) return false;
  const spot = meetSpot(p, id, usePlayback.getState().time);
  if (!spot) {
    toast('it is not attached to a picture clip');
    return false;
  }
  if (trackLocked(p, id)) {
    toast('this track is locked', 'info');
    return false;
  }
  const clip = p.clips.find((c) => c.id === id);
  const now = clip && isVisualClip(clip) ? pivotOf(clip) : { x: 0, y: 0 };
  if (now.x === spot.x && now.y === spot.y) {
    toast('the pivot is already where they meet');
    return false;
  }
  return setPivot(id, spot === PIVOT_SPOTS[4] ? null : { x: spot.x, y: spot.y });
}

/** why the move pivot mode cannot start for this selection, null when it can */
export function pivotModeBlocker(project: Project | null, selection: readonly string[]): string | null {
  const text = 'select one picture clip to move its pivot';
  if (!project || selection.length !== 1) return text;
  const clip = project.clips.find((c) => c.id === selection[0]);
  if (!clip || !isVisualClip(clip)) return text;
  if (trackLocked(project, clip.id)) return 'this track is locked';
  return null;
}
