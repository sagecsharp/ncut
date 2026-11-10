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
 *   element does anyway: the forward decoder stays out of it (scrubFeed.stepBack and its kept frames take over)
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
  // the element's frame is taken to be as long as the feed's. the last frame of the file never ends: that only
  // holds for the element when it shows that very frame, any other frame of it has an ordinary length
  const same = Math.abs(shown - cur.start) <= SAME;
  const theirs = frameDistance(shown, Number.isFinite(cur.length) || same ? cur.length : NO_LENGTH, target);
  return mine + SAME < theirs;
}

/* ---------- moving backwards: a stretch of frames behind the playhead, kept ready ---------- */

/** memory the kept frames of one clip may take (bytes, 4 per pixel) */
export const BACK_BYTES = 640e6;
/** backward moves in a row before the feed starts keeping frames: a drag that only wobbles is left alone */
export const BACK_AFTER = 3;
/** fills in a row that the playhead had already left when they were done: the drag is too fast, the feed stays out */
export const BACK_MISSES = 2;

/** fewer kept frames than this are not worth a fill (4k: the video element alone is as fast there) */
export const BACK_MIN_FRAMES = 24;

/** how many frames of this size are kept (half of them are one fill). 0: too big, no frames are kept */
export function backFrames(width: number, height: number): number {
  if (!(width > 0) || !(height > 0)) return 0;
  const fit = Math.floor(BACK_BYTES / (width * height * 4));
  return fit < BACK_MIN_FRAMES ? 0 : Math.min(48, fit);
}

/** a drag that needs a wider step than this is too fast for the kept frames */
export const BACK_STRIDE_MAX = 8;

/**
 * every how many frames one is kept, 0: the drag is too fast for the feed.
 * a drag that passes several frames per picture on screen does not need the ones in between, and the kept ones
 * then reach that much further back. and the `count` kept frames of one fill must last longer than the fill takes
 * (`fillMs`, from the last ones). `speed`: seconds of the file per ms
 */
export function backStride(speed: number, frameLength: number, fillMs = 0, count = 1): number {
  const len = frameLength > 0 ? frameLength : NO_LENGTH;
  const v = Math.abs(speed);
  const perPicture = (v * (1000 / 60)) / len;
  const keepUp = (Math.max(0, fillMs) * 1.25 * v) / (Math.max(1, count) * len);
  const stride = Math.max(1, Math.round(perPicture), Math.ceil(keepUp - 1e-9));
  if (!Number.isFinite(stride)) return 1;
  return stride > BACK_STRIDE_MAX ? 0 : stride;
}

/**
 * the stretch a fill decodes for a playhead that is at `target` now and moves back at `speed` (seconds per ms):
 * from the frame the playhead is in back to where it will be when the fill is done (`fillMs` from the last fill)
 * and `count` kept frames (one every `stride`) further.
 */
export function backStretch(
  target: number,
  speed: number,
  fillMs: number,
  count: number,
  stride: number,
  frameLength: number,
): { from: number; end: number } {
  const len = frameLength > 0 ? frameLength : NO_LENGTH;
  const span = count * stride * len;
  // never aim further than one stretch away: a guess that far is a guess
  const lead = Math.min(Math.abs(speed) * Math.max(0, fillMs), span);
  return { from: Math.max(0, target - lead - span), end: target + len };
}

/**
 * which of the kept frames (ascending, each standing for `duration` seconds from `timestamp`) is the picture for
 * `at`: -1 when none is
 */
export function coverIndex(frames: readonly { timestamp: number; duration: number }[], at: number): number {
  let lo = 0;
  let hi = frames.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (startsBy(frames[mid]!.timestamp, at)) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (found < 0) return -1;
  const f = frames[found]!;
  return frameDistance(f.timestamp, f.duration, at) === 0 ? found : -1;
}

/** which way the wanted time moved: true back, false forward, `before` when it did not move */
export function movedBack(last: number | null, next: number, before: boolean): boolean {
  if (last === null) return false;
  if (next < last - SAME) return true;
  if (next > last + SAME) return false;
  return before;
}
