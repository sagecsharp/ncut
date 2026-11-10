/**
 * keyframe diamonds along the bottom edge of a clip. geometry shared by the canvas that draws them
 * (KeyMarks.tsx) and the gesture that hit-tests them (gestures.ts).
 */

/** height of the diamond strip at the bottom of the clip box, css px */
export const KEY_STRIP_H = 11;
/** diamonds closer than this (css px) are drawn as one */
export const KEY_MERGE_PX = 3;
/** pointer distance from a diamond centre that counts as a press on it */
export const KEY_HIT_PX = 5;
/** keep a diamond fully inside the clip box */
const KEY_INSET = 5;

/** x of a diamond (clip-local px) for a clip-local time, kept inside the box */
export function keyX(t: number, zoom: number, clipW: number): number {
  const x = t * zoom;
  const hi = Math.max(KEY_INSET, clipW - KEY_INSET);
  return Math.min(hi, Math.max(KEY_INSET, x));
}

/** groups of key times (clip-local, sorted) that fall within KEY_MERGE_PX of the group's first */
export function mergeKeys(times: readonly number[], zoom: number, clipW: number): number[][] {
  const groups: number[][] = [];
  let firstX = -Infinity;
  for (const t of times) {
    const x = keyX(t, zoom, clipW);
    const last = groups[groups.length - 1];
    if (last && x - firstX < KEY_MERGE_PX) {
      last.push(t);
    } else {
      groups.push([t]);
      firstX = x;
    }
  }
  return groups;
}

/** the key time under a press at clip-local (x, y), or null. the closest key wins. */
export function hitKey(times: readonly number[], zoom: number, clipW: number, clipH: number, x: number, y: number): number | null {
  if (y < clipH - KEY_STRIP_H - 1) return null;
  let best: number | null = null;
  let bestD = KEY_HIT_PX + 0.001;
  for (const t of times) {
    const d = Math.abs(keyX(t, zoom, clipW) - x);
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  }
  return best;
}
