/**
 * dragging one edge with several clips selected trims every selected clip by the same amount. pure planning:
 * which clips take part and where each edge is asked to go. the store clamps every clip by its own limits
 * (neighbours, source length, minimum length), so a clip that cannot go that far stops while the others go on.
 */
import type { Clip, Track } from '../../types';
import { clipEnd } from '../../lib/timelineOps';
import { findFollowers } from './effectFollow';
import type { TrimStep } from './trimPlan';

/**
 * the clips a drag of `edge` trims, the grabbed one first, each with the edge it had in `clips` (the project at
 * the start of the drag) plus `delta`. clips on locked tracks stay out, and so does an effect that follows a
 * selected clip: it is trimmed through that clip (followTrim), never twice. a selection without the grabbed
 * clip is treated as just that clip (a press on an edge selects it anyway).
 */
export function planGroupTrim(
  clips: readonly Clip[],
  tracks: readonly Track[],
  selection: readonly string[],
  grabbed: string,
  edge: 'start' | 'end',
  delta: number,
): TrimStep[] {
  const locked = new Set(tracks.filter((t) => t.locked).map((t) => t.id));
  const picked = new Set(selection.includes(grabbed) ? selection : [grabbed]);
  const open = clips.filter((c) => picked.has(c.id) && !locked.has(c.trackId));
  const followers = new Set(findFollowers(clips, tracks, open.map((c) => c.id)).map((e) => e.id));
  const steps: TrimStep[] = [];
  for (const c of open) {
    if (followers.has(c.id)) continue;
    steps.push({ id: c.id, time: (edge === 'start' ? c.start : clipEnd(c)) + delta });
  }
  // the grabbed clip leads (it is the one under the pointer)
  steps.sort((a, b) => (a.id === grabbed ? -1 : b.id === grabbed ? 1 : 0));
  return steps;
}
