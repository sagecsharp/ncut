/** where a clip's transition sits on the timeline (types.ts Transition). pure, shared by the renderer and the ui. */
import type { Clip, Project, VisualClip } from '../types';
import { isVisualClip } from '../types';
import { clipEnd } from './timelineOps';

/** how close the end of one clip and the start of the next must be to count as a cut between them */
export const CUT_EPS = 1e-3;

/** the visual clip on the same track that ends right where `clip` starts, or null */
export function previousClipOnTrack(project: Project, clip: Clip): VisualClip | null {
  for (const other of project.clips) {
    if (other.id === clip.id || other.trackId !== clip.trackId || !isVisualClip(other)) continue;
    if (Math.abs(clipEnd(other) - clip.start) <= CUT_EPS) return other;
  }
  return null;
}

export interface TransitionSpan {
  /** timeline seconds */
  start: number;
  end: number;
  /** the outgoing clip, or null when the clip appears out of nothing */
  from: VisualClip | null;
  /** the incoming clip (the one that owns the transition) */
  to: VisualClip;
  id: string;
}

/**
 * the time range a clip's transition covers, or null when it has none.
 * with a clip before it the range is centered on the cut (half in each clip, never more than half of
 * either clip). without one the whole transition plays inside the clip's head.
 */
export function transitionSpan(project: Project, clip: Clip): TransitionSpan | null {
  if (!isVisualClip(clip) || !clip.transition || !(clip.transition.duration > 0)) return null;
  const from = previousClipOnTrack(project, clip);
  if (from) {
    const half = Math.min(clip.transition.duration / 2, clip.duration / 2, from.duration / 2);
    return { start: clip.start - half, end: clip.start + half, from, to: clip, id: clip.transition.id };
  }
  const len = Math.min(clip.transition.duration, clip.duration);
  return { start: clip.start, end: clip.start + len, from: null, to: clip, id: clip.transition.id };
}

/** every transition running at a time (at most one per track in practice) */
export function transitionsAt(project: Project, time: number): TransitionSpan[] {
  const out: TransitionSpan[] = [];
  for (const clip of project.clips) {
    if (!isVisualClip(clip) || !clip.transition) continue;
    const span = transitionSpan(project, clip);
    if (span && time >= span.start - 1e-6 && time < span.end - 1e-6) out.push(span);
  }
  return out;
}
