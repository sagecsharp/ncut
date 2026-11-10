/**
 * which clips a frame needs under a temporal effect (motion blur, echo, frame blend, strobe). pure, so it is tested.
 */
import type { Project, VisualClip } from '../../types';
import { neededClipsAt, temporalReach } from '../../engine/draw';

const EPS = 1e-6;

/**
 * every video / image clip on a visible video track that is on screen at some moment of [t - back, t + ahead].
 * an over-approximation (a few extra feeds stay open), which is what the exporter wants. one pass over the clips.
 */
export function clipsInReach(project: Project, t: number, reach: { back: number; ahead: number } | null): VisualClip[] {
  const out: VisualClip[] = [];
  if (!reach) return out;
  const lo = t - reach.back;
  const hi = t + reach.ahead;
  for (const clip of project.clips) {
    if (clip.type !== 'video' && clip.type !== 'image') continue;
    if (clip.start > hi + EPS || clip.start + clip.duration <= lo + EPS) continue;
    const track = project.tracks.find((tr) => tr.id === clip.trackId);
    if (!track || track.kind !== 'video' || track.hidden) continue;
    out.push(clip);
  }
  return out;
}

/**
 * the clips whose picture frame t can show: the ones on screen, the ones a transition holds, and under a temporal
 * effect also every clip on screen anywhere in its reach plus what the transitions hold at both ends of it.
 */
export function neededForFrame(project: Project, t: number): VisualClip[] {
  const out = neededClipsAt(project, t);
  const reach = temporalReach(project, t);
  if (!reach) return out;
  const add = (list: readonly VisualClip[]) => {
    for (const c of list) if (!out.includes(c)) out.push(c);
  };
  add(clipsInReach(project, t, reach));
  add(neededClipsAt(project, Math.max(0, t - reach.back)));
  add(neededClipsAt(project, t + reach.ahead));
  return out;
}
