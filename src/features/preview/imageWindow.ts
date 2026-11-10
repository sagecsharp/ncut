/** which image assets the preview must keep decoded around a time. pure, so it is tested without a dom. */
import type { Project } from '../../types';

export interface Hold {
  before: number;
  after: number;
}

/**
 * assets of image clips that are on screen, about to be, or just were. a clip in a transition keeps showing its
 * frozen edge frame outside its own range (`holds`, from transitionHolds), so its window grows by the hold: closing
 * the bitmap mid-transition would flash the picture away.
 */
export function neededImageAssets(
  project: Project,
  time: number,
  holds: ReadonlyMap<string, Hold>,
  lookahead: number,
  linger: number,
  out: Set<string> = new Set(),
): Set<string> {
  out.clear();
  for (const clip of project.clips) {
    if (clip.type !== 'image') continue;
    const hold = holds.get(clip.id);
    const lo = clip.start - lookahead - (hold?.before ?? 0);
    const hi = clip.start + clip.duration + linger + (hold?.after ?? 0);
    if (time >= lo && time < hi) out.add(clip.assetId);
  }
  return out;
}
