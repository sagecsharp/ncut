/**
 * drop a new clip inbetween clips: when the spot under the pointer is taken or too small, the clips of that
 * track after the insert point move right by the missing room instead of the drop jumping to a far free spot.
 * pure planning, the drop applies it in one undo step.
 */
import type { Clip, Project } from '../../types';
import { clipEnd } from '../../lib/timelineOps';
import type { ClipMove } from '../../store/editorStore';
import { planInsertGap } from './gapInsert';
import { withFollowerMoves } from './followMoves';

const EPS = 1e-6;

export interface DropPlan {
  /** where the new clip starts */
  start: number;
  /** how far every later clip of the track moves right (0 = nothing moves) */
  shift: number;
  /** the moves for that, effects that follow a moved clip included */
  moves: ClipMove[];
  /** the drop opens a hole (inside a clip, or no room before the next one) */
  insert: boolean;
}

/** null when the track is unknown or locked (the caller falls back to the nearest free spot) */
export function planDropInsert(
  project: Pick<Project, 'clips' | 'tracks'>,
  trackId: string,
  time: number,
  duration: number,
): DropPlan | null {
  const track = project.tracks.find((t) => t.id === trackId);
  if (!track || track.locked || !(duration > 0)) return null;
  const at = Math.max(0, time);
  const clips = project.clips.filter((c) => c.trackId === trackId).sort((a, b) => a.start - b.start);
  let point = at;
  let under: Clip | undefined;
  for (const c of clips) {
    if (at >= c.start - EPS && at < clipEnd(c) - EPS) {
      under = c;
      break;
    }
  }
  // inside a clip: the nearer edge, the middle goes to the end
  if (under) point = at - under.start < under.duration / 2 ? under.start : clipEnd(under);
  const next = clips.find((c) => c.start >= point - EPS);
  const shift = next ? Math.max(0, point + duration - next.start) : 0;
  const insert = under !== undefined || shift > EPS;
  if (shift <= EPS) return { start: point, shift: 0, moves: [], insert };
  const planned = planInsertGap(project.clips, project.tracks, point, shift, trackId);
  // an effect follows its clip: it goes with a clip that moves and stays with one that does not
  const moves = withFollowerMoves(project.clips, project.tracks, planned, true);
  return { start: point, shift, moves, insert };
}
