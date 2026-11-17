/**
 * where the scopes strip sits (right of the picture or below it) and how its cells lay out. pure maths.
 * the strip sits where it leaves the bigger fitted picture, worked out with the default sizes so a drag never flips it.
 */
import { BELOW_HEIGHT_DEFAULT, SIDE_WIDTH_DEFAULT } from './scopesState';

export type ScopesPlace = 'side' | 'below';
export const STAGE_PAD = 12,
  SIDE_MIN = 200,
  BELOW_MIN = 140,
  SWITCH_GAIN = 1.05;

/** the area of the biggest project shaped rect in w x h, 0 when anything is <= 0 */
export function fitArea(w: number, h: number, projW: number, projH: number): number {
  if (!(w > 0) || !(h > 0) || !(projW > 0) || !(projH > 0)) return 0;
  const k = Math.min(w / projW, h / projH);
  return projW * k * (projH * k);
}

/** a stored size clamped to [min(SIDE_MIN or BELOW_MIN, half), half of the body side] */
export function scopesSize(place: ScopesPlace, stored: number, bodyW: number, bodyH: number): number {
  const half = Math.max(0, Math.floor((place === 'side' ? bodyW : bodyH) / 2));
  const lo = Math.min(place === 'side' ? SIDE_MIN : BELOW_MIN, half);
  const v = Number.isFinite(stored) ? stored : place === 'side' ? SIDE_WIDTH_DEFAULT : BELOW_HEIGHT_DEFAULT;
  return Math.max(lo, Math.min(half, v));
}

/** side or below, whichever leaves the bigger picture; it stays unless the other is 5% bigger */
export function placeScopes(bodyW: number, bodyH: number, projW: number, projH: number, current?: ScopesPlace): ScopesPlace {
  const sw = scopesSize('side', SIDE_WIDTH_DEFAULT, bodyW, bodyH);
  const bh = scopesSize('below', BELOW_HEIGHT_DEFAULT, bodyW, bodyH);
  const side = fitArea(bodyW - sw - 2 * STAGE_PAD, bodyH - 2 * STAGE_PAD, projW, projH);
  const below = fitArea(bodyW - 2 * STAGE_PAD, bodyH - bh - 2 * STAGE_PAD, projW, projH);
  if (current === 'side' && below <= side * SWITCH_GAIN) return 'side';
  if (current === 'below' && side <= below * SWITCH_GAIN) return 'below';
  return below > side ? 'below' : 'side';
}

/** columns and rows for n cells in w x h: the columns that make the cells biggest (ties keep fewer columns) */
export function cellGrid(n: number, w: number, h: number): { cols: number; rows: number } {
  const count = Math.max(1, Math.floor(n));
  let best = { cols: 1, rows: count };
  let bestSize = -Infinity;
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols);
    const size = Math.min(w / cols, h / rows);
    if (size > bestSize + 1e-9) {
      bestSize = size;
      best = { cols, rows };
    }
  }
  return best;
}
