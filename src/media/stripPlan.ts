/**
 * which frame of a video stands for a slot of a filmstrip.
 *
 * a strip of n pictures cuts the file into n equal slots and used to show the frame in the middle of each. to
 * get that frame the decoder has to run from the key frame before it, on average half a key frame distance of
 * frames for one picture (30 to 60 frames of 4k for a phone clip). a key frame costs one decode. so when a key
 * frame lies inside the slot it is shown instead: still a frame of that slot's own time span, and the strip says
 * at which time each picture really was taken, so the timeline draws it where it belongs. slots without a key
 * frame (a strip finer than the key frame distance) keep the exact middle frame.
 */

/**
 * the time to decode for a slot around `center` that reaches `half` to each side: [center - half, center + half).
 * `before` is the time of the key frame at or before the center, `after` of the next one (null = there is none).
 * the one nearer to the center wins when both are inside, the earlier one on a tie.
 */
export function pickSlotTime(center: number, half: number, before: number | null, after: number | null): number {
  if (!(half > 0) || !Number.isFinite(center)) return center;
  const lo = center - half;
  const hi = center + half;
  let best: number | null = null;
  if (before !== null && Number.isFinite(before) && before >= lo && before <= center) best = before;
  if (after !== null && Number.isFinite(after) && after > center && after < hi) {
    if (best === null || after - center < center - best) best = after;
  }
  return best ?? center;
}

/**
 * the frame for a poster picture: the key frame at or before the wanted time, unless that is the very start of
 * the file while the wanted time is later (a first frame is often black or a fade in).
 */
export function pickPosterTime(wanted: number, first: number, keyBefore: number | null): number {
  if (keyBefore === null || !Number.isFinite(keyBefore)) return wanted;
  if (keyBefore > wanted) return wanted;
  if (keyBefore <= first + 1e-6 && wanted > first + 1e-6) return wanted;
  return keyBefore;
}
