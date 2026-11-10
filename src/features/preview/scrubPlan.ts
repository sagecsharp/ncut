/**
 * pure decisions of the scrub feed (scrubFeed.ts): a decoder that keeps going while the playhead is dragged
 * forward through a video, so a drag does not pay a seek from the key frame for every picture.
 */

/**
 * how far ahead of its last frame (seconds) the feed decodes on when it does not know where the key frames are.
 * decoding on costs every frame in between, starting again costs the frames from the key frame before the
 * wanted time: with key frames a second or two apart the two meet at about a second.
 */
export const FORWARD_MAX = 1;

/**
 * a new start is only worth it when it skips at least this much decoding (seconds between the frame the feed holds
 * and the key frame before the wanted time): the start itself costs about as much as a few frames
 */
export const KEY_GAIN = 0.25;

/** times closer than this are the same time (frame times come from two demuxers) */
const SAME = 1e-4;

/** the length used for a frame that carries none */
const NO_LENGTH = 1 / 60;

/** how far `at` is from the frame that starts at `start` and lasts `length` seconds: 0 inside it */
export function frameDistance(start: number, length: number, at: number): number {
  const len = length > 0 ? length : NO_LENGTH;
  if (at < start - SAME) return start - at;
  if (at >= start + len - SAME) return at - (start + len) + SAME;
  return 0;
}

/**
 * how long the frame the feed holds stands for, as a video element shows it: until the next frame starts.
 * `next`: start of the frame after it when that one is decoded already, `last`: it is the last frame of the file
 * (it then stands for every later time). without either the length the file gives.
 */
export function heldLength(start: number, length: number, next: number | null, last: boolean): number {
  if (last) return Number.POSITIVE_INFINITY;
  if (next !== null && next > start) return next - start;
  return length;
}

/** more new starts than this for one wanted time: the file has no frame for it the feed can find, it gives up */
export const MAX_STARTS = 2;

/** has the frame that starts at `start` begun at the time `at`? (the same rounding as frameDistance) */
export function startsBy(start: number, at: number): boolean {
  return at >= start - SAME;
}

export type FeedStep = 'have' | 'pull' | 'restart' | 'idle';

/**
 * what the feed does next for the wanted time.
 * `cur`: the frame it holds, `open`: its decoder is running and can give the frame after `cur`,
 * `backward`: the wanted time moved back with the last move, `key`: start of the key frame at or before the wanted
 * time (null: not known).
 * - have: the frame it holds is the wanted one
 * - pull: the wanted frame is ahead and decoding on gets there as cheaply as a new start: no key frame between the
 *   held frame and the wanted one (a new start would decode the same frames again), or one so close that the start
 *   saves nothing
 * - idle: the playhead moves backwards. every picture would be a new start at a key frame, which is what the video
 *   element does anyway: the feed stays out of it
 * - restart: start decoding at the key frame before the wanted time
 */
export function feedStep(
  cur: { start: number; length: number } | null,
  open: boolean,
  target: number,
  backward: boolean,
  key: number | null = null,
): FeedStep {
  if (cur && frameDistance(cur.start, cur.length, target) === 0) return 'have';
  if (cur && open && target > cur.start) {
    if (key !== null ? key <= cur.start + KEY_GAIN : frameDistance(cur.start, cur.length, target) <= FORWARD_MAX) return 'pull';
  }
  if (backward) return 'idle';
  return 'restart';
}

/**
 * is the feed's frame the better picture for the wanted time than the frame the video element shows?
 * only when it is really nearer: the element wins every tie, so a resting playhead always shows the element.
 * `shown`: start time of the frame the element shows (requestVideoFrameCallback's mediaTime)
 */
export function feedIsNearer(cur: { start: number; length: number }, shown: number, target: number): boolean {
  if (!Number.isFinite(shown) || !Number.isFinite(target)) return false;
  const mine = frameDistance(cur.start, cur.length, target);
  const theirs = frameDistance(shown, cur.length, target);
  return mine + SAME < theirs;
}

/** which way the wanted time moved: true back, false forward, `before` when it did not move */
export function movedBack(last: number | null, next: number, before: boolean): boolean {
  if (last === null) return false;
  if (next < last - SAME) return true;
  if (next > last + SAME) return false;
  return before;
}
