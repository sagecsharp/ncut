/** the words of crossfades. pure: reasons.ts spreads CROSS_TEXT, so a text lives once */
import type { FadeShape } from '../../types';
import { SHAPE_NAME } from '../../lib/audioCross';
import type { CrossShort } from '../../lib/audioCross';
import { formatAmount } from '../../lib/time';
import type { TimeDisplay } from '../../lib/time';

export const CROSS_TEXT = {
  crossNoEdit: 'no edit between two clips with sound at the selected clips',
  crossNoEditHere: 'no edit between two clips with sound at the playhead: select a clip or go to an edit first',
  crossNoSound: 'a crossfade needs sound on both sides of the edit',
  crossApart: 'the sound of this video is a clip of its own: crossfade it on its audio track',
  crossNoMedia: 'no media past the edit: trim a clip on either side shorter to make room',
  crossNoEditTrack: 'no edit between two clips with sound on this track',
  crossAllHave: 'every edit on this track has a crossfade',
  crossNoneTrack: 'no crossfade on this track',
  crossNoTransition: 'this clip has no transition',
  crossOneTake: 'the same take runs on there',
} as const;

/** a crossfade that has no clip to fade with yet. not in CROSS_TEXT: reasons.ts spreads that one */
export const CROSS_WAITS = 'a crossfade waits here for a clip with sound that touches this edge';

/** why a side is shorter than asked. the media before the edit is the clip after's, the media after it the clip before's */
export function crossShortText(side: 'before' | 'after', why: CrossShort | 'shortest', fromName: string, toName: string): string {
  if (why === 'media') return side === 'before' ? `"${toName}" has no media before its first frame` : `"${fromName}" has no media after its last frame`;
  if (why === 'half') return `a crossfade reaches at most to the middle of "${side === 'before' ? fromName : toName}"`;
  if (why === 'longest') return 'each side of a crossfade is at most 10s';
  return 'one frame is the shortest crossfade: delete removes it';
}

/** a length as the time display shows it, without a sign */
export function crossLengthText(seconds: number, fps: number, mode: TimeDisplay): string {
  return formatAmount(Math.round(seconds * fps), fps, mode).replace(/^[+-]/, '');
}

export function crossAddedText(before: string, after: string, shape: FadeShape): string {
  return `crossfade added: ${before} before and ${after} after the edit, ${SHAPE_NAME[shape]}`;
}

export function crossAddedManyText(n: number, shorter: number, oneTake: number): string {
  let t = `${n} crossfades added`;
  if (shorter > 0) t += `, ${shorter} shorter: no media past the edit`;
  if (oneTake > 0) t += `, ${oneTake} left alone: the same take runs on there`;
  return t;
}

export function crossRemovedText(n: number): string {
  return n === 1 ? 'crossfade removed' : `${n} crossfades removed`;
}

export function fadeShapeText(shape: FadeShape, n: number): string {
  return `fade shape set to ${SHAPE_NAME[shape]} on ${n} ${n === 1 ? 'clip' : 'clips'}`;
}
