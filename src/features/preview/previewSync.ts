/**
 * pure decisions of the preview engine's seek / hold logic (no dom), so they can be tested.
 *
 * a "scrubbing" element is a video that the clock is running over but that cannot play at the current
 * rate (backwards, or a rate the element refuses): it stays paused and is seeked to the clock every tick.
 */

/** true when a running clock has to drive this element by seeking instead of playing it */
export function isScrubbing(playing: boolean, rate: number, playbackRate: number, isVideo: boolean): boolean {
  return isVideo && playing && rate !== 1 && playbackRate === 0;
}

/** true when an element that scrubbed on the last sync does not scrub now: its deferred seek target (`want`) is stale */
export function staleScrubTarget(wasScrub: boolean, scrubNow: boolean): boolean {
  return wasScrub && !scrubNow;
}

/**
 * does this video keep the last picture on screen (the hold) while it seeks / loads?
 * a scrubbing element never holds the canvas while seeking (the other layers must keep moving and the
 * latest landed frame is painted), but a not yet decoded element (readyState < 2) still has nothing to show.
 */
export function blocksPaint(o: {
  seeking: boolean;
  readyState: number;
  /** a new element that is still within its load grace period */
  loading: boolean;
  scrubbing: boolean;
  playing: boolean;
}): boolean {
  if (o.playing && o.scrubbing) return o.readyState < 2 && (o.seeking || o.loading);
  return o.seeking || (o.readyState < 2 && o.loading);
}

export interface SeekedAction {
  /** paint now (before any further seek is issued) */
  draw: boolean;
  /** issue the deferred seek next */
  seek: boolean;
  /** just ask for a redraw */
  invalidate: boolean;
}

/** what the seeked handler does, given the deferred target `want` (null: none) */
export function onSeekedAction(o: {
  playing: boolean;
  scrubbing: boolean;
  want: number | null;
  current: number;
}): SeekedAction {
  const { want } = o;
  if (want === null) return { draw: false, seek: false, invalidate: true };
  // paused: paint the landed frame; draw() issues the deferred seek itself afterwards
  if (!o.playing) return { draw: true, seek: false, invalidate: false };
  const far = Math.abs(o.current - want) > 0.01;
  // scrubbing under a running clock: paint the landed frame first, then chase the newer target
  if (o.scrubbing) return { draw: true, seek: far, invalidate: false };
  // normal playback: the clock draws, only chase the target
  if (far) return { draw: false, seek: true, invalidate: false };
  return { draw: false, seek: false, invalidate: true };
}
