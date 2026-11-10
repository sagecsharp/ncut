import { valueAt } from '../../lib/anim';
import { clamp } from '../../lib/time';
import { useEditor } from '../../store/editorStore';
import type { ClipPatch } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';

/**
 * set several animatable values at the playhead as ONE undo step. animated properties get a key at the
 * playhead, the others change their static value. does nothing (no empty undo step) when nothing changes.
 */
export function setValuesNow(id: string, values: Record<string, number>): void {
  const st = useEditor.getState();
  const clip = st.project?.clips.find((c) => c.id === id);
  if (!clip) return;
  const t = clamp(usePlayback.getState().time, clip.start, clip.start + clip.duration);
  const changed = Object.entries(values).filter(([prop, v]) => valueAt(clip, prop, t) !== v);
  if (changed.length === 0) return;
  st.pushHistory();
  for (const [prop, v] of changed) st.setClipValue(id, prop, t, v, { skipHistory: true });
}

/**
 * a reset button for a group of look values (reset crop, reset color): the keys of those values go away (each value
 * freezes where it is, then the patch resets it) and the patch is applied, all as ONE undo step.
 */
export function resetWithKeys(id: string, props: readonly string[], patch: Record<string, unknown>): void {
  const st = useEditor.getState();
  const clip = st.project?.clips.find((c) => c.id === id);
  if (!clip) return;
  const t = clamp(usePlayback.getState().time, clip.start, clip.start + clip.duration);
  st.pushHistory();
  for (const prop of props) if (clip.keyframes?.[prop]?.length) st.clearKeyframes(id, t, prop, { skipHistory: true });
  st.updateClip(id, patch as ClipPatch, { skipHistory: true });
}
