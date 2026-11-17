/**
 * keyframe diamonds along the bottom edge of a clip. geometry shared by the canvas that draws them
 * (KeyMarks.tsx) and the gesture that hit-tests them (gestures.ts).
 */
import type { Easing } from '../../types';
import { cssVar } from './view';

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

/* ---------- the shaped diamonds of the keyframe panel ---------- */

export type KeyHalf = 'point' | 'round' | 'square';

/** the right half says how the value leaves the key (its own ease), the left how it arrives (the ease of the key before) */
function rightHalf(ease: Easing): KeyHalf {
  switch (ease) {
    case 'linear':
    case 'ease-out':
    case 'back':
    case 'bounce':
    case 'elastic':
      return 'point';
    case 'hold':
      return 'square';
    default:
      return 'round';
  }
}

function leftHalf(ease: Easing): KeyHalf {
  switch (ease) {
    case 'linear':
    case 'ease-in':
    case 'bounce':
      return 'point';
    case 'hold':
      return 'square';
    default:
      return 'round';
  }
}

/** the shape of a key. null: there is no key on that side (the first key copies its right half to the left, the last its left to the right) */
export function keyShape(prevEase: Easing | null, ease: Easing | null): { left: KeyHalf; right: KeyHalf } {
  if (prevEase === null && ease === null) return { left: 'point', right: 'point' };
  if (prevEase === null) {
    const r = rightHalf(ease!);
    return { left: r, right: r };
  }
  if (ease === null) {
    const l = leftHalf(prevEase);
    return { left: l, right: l };
  }
  return { left: leftHalf(prevEase), right: rightHalf(ease) };
}

/** index of the time whose x is nearest the x `at` within px, or -1. binary search: x must grow with t. a tie takes the earlier index */
export function hitKeyAt(times: ArrayLike<number>, x: (t: number) => number, at: number, px: number): number {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (x(times[mid]!) < at) lo = mid + 1;
    else hi = mid;
  }
  let best = -1;
  let bestD = px;
  if (lo > 0) {
    const d = Math.abs(x(times[lo - 1]!) - at);
    if (d <= bestD) {
      bestD = d;
      best = lo - 1;
    }
  }
  if (lo < times.length) {
    const d = Math.abs(x(times[lo]!) - at);
    if (best < 0 ? d <= bestD : d < bestD) best = lo;
  }
  return best;
}

/** one half of the diamond as a closed path: dir -1 the left half, 1 the right half */
function halfPath(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, half: KeyHalf, dir: -1 | 1): void {
  ctx.beginPath();
  if (half === 'point') {
    ctx.moveTo(x, y - r);
    ctx.lineTo(x + dir * r, y);
    ctx.lineTo(x, y + r);
  } else if (half === 'round') {
    const q = r * 0.85;
    ctx.moveTo(x, y - q);
    ctx.arc(x, y, q, -Math.PI / 2, Math.PI / 2, dir === -1);
  } else {
    const q = r * 0.8;
    ctx.moveTo(x, y - q);
    ctx.lineTo(x + dir * q, y - q);
    ctx.lineTo(x + dir * q, y + q);
    ctx.lineTo(x, y + q);
  }
  ctx.closePath();
}

/** a key: two halves. filled with the accent, hollow with a 1 px outline */
export function drawKeyShape(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, shape: { left: KeyHalf; right: KeyHalf }, filled: boolean): void {
  if (filled) ctx.fillStyle = cssVar('--accent');
  else {
    ctx.strokeStyle = cssVar('--text-dim');
    ctx.lineWidth = 1;
  }
  halfPath(ctx, x, y, r, shape.left, -1);
  if (filled) ctx.fill();
  else ctx.stroke();
  halfPath(ctx, x, y, r, shape.right, 1);
  if (filled) ctx.fill();
  else ctx.stroke();
}
