/**
 * where a lut dropped on the timeline goes: the clip under the pointer that can carry a grade. pure, like effectTarget.ts.
 */
import type { Clip, Track } from '../../types';
import { canGrade } from '../../lib/gradeData';
import { clipEnd } from '../../lib/timelineOps';

/** the clip a lut dropped at `time` on `trackId` goes on, or null (no, unknown, locked or non video track, no clip that can grade there) */
export function lutDropTarget(project: { clips: readonly Clip[]; tracks: readonly Track[] }, trackId: string | undefined, time: number): Clip | null {
  if (!trackId) return null;
  const track = project.tracks.find((t) => t.id === trackId);
  if (!track || track.locked || track.kind !== 'video') return null;
  for (const c of project.clips) {
    if (c.trackId !== trackId || !canGrade(c)) continue;
    if (time >= c.start && time < clipEnd(c)) return c;
  }
  return null;
}

/** the words of the target ghost */
export function lutGhostLabel(clip: Clip): string {
  return clip.type === 'effect' ? 'lut on this grade' : 'lut on this clip';
}
