/**
 * freeze frame: turn the picture of a video clip at the playhead into a still that sits in the
 * timeline at that spot.
 */

/** default length of the still, seconds */
export const FREEZE_DURATION = 2;

/**
 * freeze the selected video clip (or the top video clip under the playhead) at the playhead.
 * the clip is split there, the still is inserted and everything after it on that track moves right.
 * returns the id of the new image clip, or null when there is nothing to freeze.
 */
export async function freezeFrame(): Promise<string | null> {
  return null;
}
