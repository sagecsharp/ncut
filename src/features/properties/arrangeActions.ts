import { getClipBox } from '../../engine/draw';
import { valueAt } from '../../lib/anim';
import { clamp } from '../../lib/time';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import type { LookAt, Project, VisualClip } from '../../types';
import { isVisualClip } from '../../types';
import { arrange, arrangeTargets } from './arrange3d';
import type { ArrangeKind, ArrangeOpts } from './arrange3d';

/** the playhead held inside a clip (what the transform fields and keyframes use) */
function timeIn(clip: VisualClip): number {
  return clamp(usePlayback.getState().time, clip.start, clip.start + clip.duration);
}

/** 3d visual clips among these on unlocked tracks */
function threeDClips(project: Pick<Project, 'clips' | 'tracks'>, ids: readonly string[]): VisualClip[] {
  const locked = new Set(project.tracks.filter((t) => t.locked).map((t) => t.id));
  return project.clips.filter((c): c is VisualClip => ids.includes(c.id) && isVisualClip(c) && !!c.threeD && !locked.has(c.trackId));
}

/**
 * lay the selected clips out in 3d. clips that are flat become 3d, then x / y / z / rotY / rotation are
 * written at the playhead through setClipValue (a keyframed property gets a key, the others a static value).
 * history = true records ONE undo step; false is for a slider drag whose step was already pushed.
 * returns how many clips were laid out.
 */
export function arrangeSelection(ids: readonly string[], kind: ArrangeKind, opts: ArrangeOpts, history: boolean): number {
  const st = useEditor.getState();
  const p = st.project;
  if (!p) return 0;
  const { clips } = arrangeTargets(p, ids);
  if (clips.length === 0) return 0;
  // one pitch for everybody: the biggest clip box
  let itemW = 0;
  let itemH = 0;
  for (const c of clips) {
    const b = getClipBox(p, c);
    itemW = Math.max(itemW, b.width);
    itemH = Math.max(itemH, b.height);
  }
  const poses = arrange(kind, clips.length, { ...opts, itemW: Math.round(itemW), itemH: Math.round(itemH) });
  if (history) st.pushHistory();
  const skip = { skipHistory: true };
  clips.forEach((c, i) => {
    const pose = poses[i]!;
    if (!c.threeD) st.updateClip(c.id, { threeD: true }, skip);
    const t = timeIn(c);
    st.setClipValue(c.id, 'x', t, pose.x, skip);
    st.setClipValue(c.id, 'y', t, pose.y, skip);
    st.setClipValue(c.id, 'z', t, pose.z, skip);
    st.setClipValue(c.id, 'rotY', t, pose.rotY, skip);
    st.setClipValue(c.id, 'rotation', t, pose.rotation, skip);
  });
  return clips.length;
}

/** lookAt on every selected 3d clip, one undo step */
export function setLookAll(ids: readonly string[], mode: LookAt): number {
  const st = useEditor.getState();
  const p = st.project;
  if (!p) return 0;
  const clips = threeDClips(p, ids).filter((c) => (c.lookAt ?? 'none') !== mode);
  if (clips.length === 0) return 0;
  st.pushHistory();
  for (const c of clips) st.updateClip(c.id, { lookAt: mode }, { skipHistory: true });
  return clips.length;
}

/** back to flat 2d: threeD false and z / tilt / turn at 0, one undo step */
export function flattenSelection(ids: readonly string[]): number {
  const st = useEditor.getState();
  const p = st.project;
  if (!p) return 0;
  const clips = threeDClips(p, ids);
  if (clips.length === 0) return 0;
  st.pushHistory();
  const skip = { skipHistory: true };
  for (const c of clips) {
    const t = timeIn(c);
    for (const prop of ['z', 'rotX', 'rotY'] as const) {
      const now = valueAt(c, prop, t) ?? c.transform[prop] ?? 0;
      if (now !== 0) st.setClipValue(c.id, prop, t, 0, skip);
    }
    st.updateClip(c.id, { threeD: false }, skip);
  }
  return clips.length;
}
