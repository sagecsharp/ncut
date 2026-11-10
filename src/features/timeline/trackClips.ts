import type { Clip } from '../../types';

/**
 * clips grouped by track with structural sharing: the array for a track keeps its identity as long
 * as that track's clips did not change. lets a lane subscribe with a plain selector and re-render
 * only when its own clips change, even while another track is being edited.
 */
const EMPTY: Clip[] = [];
let lastClips: Clip[] | null = null;
let lastIndex = new Map<string, Clip[]>();

function clipsByTrack(clips: Clip[]): Map<string, Clip[]> {
  if (clips === lastClips) return lastIndex;
  const next = new Map<string, Clip[]>();
  for (const c of clips) {
    const arr = next.get(c.trackId);
    if (arr) arr.push(c);
    else next.set(c.trackId, [c]);
  }
  for (const [id, arr] of next) {
    const prev = lastIndex.get(id);
    if (prev && prev.length === arr.length && prev.every((c, i) => c === arr[i])) next.set(id, prev);
  }
  lastClips = clips;
  lastIndex = next;
  return next;
}

/** stable-reference selector helper */
export function selectTrackClips(clips: Clip[] | undefined, trackId: string): Clip[] {
  if (!clips) return EMPTY;
  return clipsByTrack(clips).get(trackId) ?? EMPTY;
}
