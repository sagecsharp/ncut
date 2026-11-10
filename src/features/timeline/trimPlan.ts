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
 * the clips cut by moving `edge` to `time`: the selected clips, or with nothing selected every clip under the
 * playhead. the playhead has to be inside the clip (a trim here only cuts, it never grows a clip), clips on
 * locked tracks stay as they are. an effect that follows a trimmed clip is left out, it is trimmed with its
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
  const steps: TrimStep[] = [];
  for (const c of clips) {
    if (picked.size > 0 && !picked.has(c.id)) continue;
    if (locked.has(c.trackId)) continue;
    const end = clipEnd(c);
    if (time <= c.start + EPS || time >= end - EPS) continue;
    const to = edge === 'start' ? Math.min(time, end - MIN_CLIP_DURATION) : Math.max(time, c.start + MIN_CLIP_DURATION);
    const changes = edge === 'start' ? to > c.start + EPS : to < end - EPS;
    if (changes) steps.push({ id: c.id, time: to });
  }
  const followers = new Set(findFollowers(clips, tracks, steps.map((s) => s.id)).map((e) => e.id));
  return steps.filter((s) => !followers.has(s.id));
}
