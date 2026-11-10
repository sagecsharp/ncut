/**
 * the store side of "effects follow their clip" for changes that are made with a store call instead of a drag:
 * after the clip got its new span, the effects that were put on it (same start and duration before) get it too.
 */
import { useEditor } from '../../store/editorStore';
import type { ActionOpts } from '../../store/editorStore';
import { isVisualClip } from '../../types';
import type { Project } from '../../types';
import { followerSpans } from './followMoves';

/**
 * `before` is the project before the clip `id` was changed. call it right after the change, with the same
 * opts (so everything lands in one undo step). an effect whose track has no room stays where it is.
 */
export function applyFollowerSpans(before: Project | null | undefined, id: string, opts?: ActionOpts): void {
  const now = () => useEditor.getState().project;
  const clip = now()?.clips.find((c) => c.id === id);
  if (!before || !clip || !isVisualClip(clip)) return;
  for (const r of followerSpans(before.clips, before.tracks, id, { start: clip.start, duration: clip.duration })) {
    const cur = now()?.clips.find((c) => c.id === r.id);
    if (!cur) continue;
    if (Math.abs(cur.start - r.start) > 1e-6) useEditor.getState().trimClip(r.id, 'start', r.start, opts);
    const moved = now()?.clips.find((c) => c.id === r.id);
    if (moved && Math.abs(moved.start + moved.duration - (r.start + r.duration)) > 1e-6) {
      useEditor.getState().trimClip(r.id, 'end', r.start + r.duration, opts);
    }
  }
}
