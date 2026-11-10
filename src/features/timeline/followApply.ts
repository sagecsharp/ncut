/**
 * the store side of "effects follow their clip" for changes that are made with a store call instead of a drag:
 * after the clip got its new span, the effects that were put on it (same start and duration before) get it too.
 */
import { useEditor } from '../../store/editorStore';
import type { ActionOpts } from '../../store/editorStore';
import { isVisualClip } from '../../types';
import type { Project } from '../../types';
import { followerTargets } from './followMoves';

/** the project at the start of the live edit that is going on (null: none marked) */
let gestureBase: Project | null = null;
let gestureArmed = false;

/** call when a scrub / typing interaction starts (next to beginEdit). the first change after it takes the snapshot. */
export function markFollowGesture(): void {
  gestureArmed = true;
  gestureBase = null;
}

/**
 * the project to plan followers from for a live change: the one from before the first change of the gesture
 * (so a follower that was blocked at one tick can rejoin), `current` when no gesture was marked.
 * call it BEFORE applying the change.
 */
export function followBase(current: Project | null | undefined): Project | null | undefined {
  if (gestureArmed) {
    gestureArmed = false;
    gestureBase = current ?? null;
  }
  return gestureBase ?? current;
}

/**
 * `before` is the project before the clip `id` was changed. call it right after the change, with the same
 * opts (so everything lands in one undo step). an effect whose track has no room stays where it is.
 */
export function applyFollowerSpans(before: Project | null | undefined, id: string, opts?: ActionOpts): void {
  const now = () => useEditor.getState().project;
  const clip = now()?.clips.find((c) => c.id === id);
  if (!before || !clip || !isVisualClip(clip)) return;
  for (const r of followerTargets(before.clips, before.tracks, id, { start: clip.start, duration: clip.duration })) {
    const cur = now()?.clips.find((c) => c.id === r.id);
    if (!cur) continue;
    if (Math.abs(cur.start - r.start) > 1e-6) useEditor.getState().trimClip(r.id, 'start', r.start, opts);
    const moved = now()?.clips.find((c) => c.id === r.id);
    if (moved && Math.abs(moved.start + moved.duration - (r.start + r.duration)) > 1e-6) {
      useEditor.getState().trimClip(r.id, 'end', r.start + r.duration, opts);
    }
  }
}
