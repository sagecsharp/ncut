import { getClipBox } from '../../engine/draw';
import { resolveCounter } from '../../engine/counter';
import { resolveClip } from '../../lib/anim';
import { clamp } from '../../lib/time';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { useUi } from '../../store/ui';
import type { Project, VisualClip } from '../../types';
import { alignableClips } from './alignActions';
import { planSplit } from './splitLayout';
import type { SplitKind, SplitSource } from './splitLayout';

/**
 * the clips a split screen takes, in the order they get their cells: top layer first, the bottom layer
 * first for picture in picture (the picture that fills the frame has to lie under the small ones).
 */
export function splitOrder(project: Pick<Project, 'clips' | 'tracks'>, ids: readonly string[], kind: SplitKind): VisualClip[] {
  const layer = new Map(project.tracks.map((t, i) => [t.id, i]));
  const clips = alignableClips(project, ids)
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (layer.get(a.c.trackId) ?? 0) - (layer.get(b.c.trackId) ?? 0) || a.c.start - b.c.start || a.i - b.i)
    .map((e) => e.c);
  return kind === 'pip' ? clips.reverse() : clips;
}

/**
 * put the selected flat clips into the cells of a split screen: position and size through the same path as
 * the transform fields (so a keyframed clip gets a key at the playhead), the crop of pictures on the clip.
 * one undo step.
 */
export function splitScreen(ids: readonly string[], kind: SplitKind, gap = 0): void {
  const st = useEditor.getState();
  const p = st.project;
  if (!p) return;
  const clips = splitOrder(p, ids, kind);
  if (clips.length === 0) {
    useUi.getState().toast('nothing to lay out: 3d, attached and locked clips are left out');
    return;
  }
  const timeOf = (c: VisualClip) => clamp(usePlayback.getState().time, c.start, c.start + c.duration);
  const sources: SplitSource[] = clips.map((c) => {
    const t = timeOf(c);
    const shown = resolveClip(c, t);
    const box = getClipBox(p, shown.type === 'text' ? resolveCounter(shown, t) : shown);
    const s = shown.transform.scale || 1;
    return { id: c.id, width: box.width / s, height: box.height / s, media: c.type === 'video' || c.type === 'image' };
  });
  const plan = planSplit(kind, sources, p.width, p.height, gap);
  if (plan.length === 0) return;
  st.pushHistory();
  const skip = { skipHistory: true };
  for (const w of plan) {
    const clip = clips.find((c) => c.id === w.id)!;
    const t = timeOf(clip);
    st.setClipValue(w.id, 'x', t, w.x, skip);
    st.setClipValue(w.id, 'y', t, w.y, skip);
    st.setClipValue(w.id, 'scale', t, w.scale, skip);
    if (clip.type === 'video' || clip.type === 'image') st.updateClip(w.id, { crop: w.crop }, skip);
  }
  if (plan.length < clips.length) useUi.getState().toast(`${plan.length} clips laid out, the rest stay where they are`);
}
