import { valueAt } from '../../lib/anim';
import { clamp } from '../../lib/time';
import { useEditor } from '../../store/editorStore';
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
