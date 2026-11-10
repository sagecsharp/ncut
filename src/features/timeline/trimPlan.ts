/**
 * which clips a "trim to the playhead" cuts and where their new edge goes. pure, so it can be tested without the dom.
 * the store clamps again (neighbours, source length), this only decides what is worth trying.
 */
import type { Clip, Track } from '../../types';
import { MIN_CLIP_DURATION } from '../../types';
import { clipEnd } from '../../lib/timelineOps';
import { findFollowers } from './effectFollow';

const EPS = 1e-6;

export interface TrimStep {
  id: string;
  /** the new time of the edge */
  time: number;
}

/**
 * the clips trimmed by moving `edge` to `time`: the selected clips, or with nothing selected every clip under the
 * playhead. when the playhead is inside none of the selected clips, they grow to it instead where it is on the side
 * of that edge (the old [ and ] did that). clips on locked tracks stay as they are. an effect that follows a trimmed clip is left out, it is trimmed with its
 * target (applyFollowerSpans), so it is never cut twice. the edge stops one minimum length short of the other.
 */
export function planTrimToPlayhead(
  clips: readonly Clip[],
  tracks: readonly Track[],
  selection: readonly string[],
  time: number,
  edge: 'start' | 'end',
): TrimStep[] {
  const locked = new Set(tracks.filter((t) => t.locked).map((t) => t.id));
  const picked = new Set(selection);
  const collect = (grow: boolean): TrimStep[] => {
    const found: TrimStep[] = [];
    for (const c of clips) {
      if (picked.size > 0 && !picked.has(c.id)) continue;
      if (locked.has(c.trackId)) continue;
      const end = clipEnd(c);
      const inside = time > c.start + EPS && time < end - EPS;
      // growing: the playhead is past the edge on its own side. the edge never crosses the other end of the clip
      if (grow ? (edge === 'start' ? time >= c.start - EPS : time <= end + EPS) : !inside) continue;
      const to = edge === 'start' ? Math.min(time, end - MIN_CLIP_DURATION) : Math.max(time, c.start + MIN_CLIP_DURATION);
      if (Math.abs(to - (edge === 'start' ? c.start : end)) > EPS) found.push({ id: c.id, time: to });
    }
    return found;
  };
  let steps = collect(false);
  // nothing to cut: a selection grows to the playhead instead
  if (steps.length === 0 && picked.size > 0) steps = collect(true);
  const followers = new Set(findFollowers(clips, tracks, steps.map((s) => s.id)).map((e) => e.id));
  return steps.filter((s) => !followers.has(s.id));
}
