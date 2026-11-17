import type { AudioClip, VideoClip } from '../../types';
import type { ClipSound } from '../../lib/audioCross';

/** the pool key of a video clip's sound twin. '~' never appears in a clip id */
export const twinKey = (clipId: string): string => `${clipId}~sound`;
/** muted does not count: a mute only changes gains, the twin must be there on unmute */
export const needsTwin = (c: VideoClip | AudioClip, s: ClipSound): boolean => c.type === 'video' && (s.head > 0 || s.tail > 0);
/** s null: the clip's own range, the old test exactly */
export function soundActive(c: VideoClip | AudioClip, s: ClipSound | null, time: number): boolean {
  return s ? time >= c.start - s.head && time < c.start + c.duration + s.tail : time >= c.start && time < c.start + c.duration;
}
export function soundInWindow(c: VideoClip | AudioClip, s: ClipSound, time: number, before: number, after: number): boolean {
  return !(time < c.start - s.head - before || time >= c.start + c.duration + s.tail + after);
}
