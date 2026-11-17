/**
 * the picture of a lut card: a hue sweep over a gray ramp, run through the lut. pure: no dom, no store.
 */
import { lutColor } from '../engine/gradeLut';
import type { LutBind } from '../engine/gradeLut';
import type { LutTable } from '../lib/cube';
import type { Rgb3 } from '../lib/gradeMath';

export const LUT_STRIP_W = 64;
export const LUT_STRIP_H = 36;
/** the top two thirds are the hue sweep, the rest the gray ramp */
export const LUT_STRIP_HUE_ROWS = 24;

/** the color of a strip pixel before any lut: rows 0 to 23 hsv (hue x / 64 turns, saturation 1, value 0.9), the rest gray x / 63 */
export function stripColor(x: number, y: number): Rgb3 {
  if (y >= LUT_STRIP_HUE_ROWS) {
    const g = x / (LUT_STRIP_W - 1);
    return [g, g, g];
  }
  const h = (x / LUT_STRIP_W) * 6;
  const v = 0.9;
  const f = h - Math.floor(h);
  const q = v * (1 - f);
  const t = v * f;
  switch (Math.floor(h) % 6) {
    case 0: return [v, t, 0];
    case 1: return [q, v, 0];
    case 2: return [0, v, t];
    case 3: return [0, q, v];
    case 4: return [t, 0, v];
    default: return [v, 0, q];
  }
}

/** rgba, from the top row, of the strip through a table (null = the strip itself) */
export function lutStrip(table: LutTable | null): Uint8ClampedArray<ArrayBuffer> {
  const px = new Uint8ClampedArray(LUT_STRIP_W * LUT_STRIP_H * 4);
  const bind: LutBind | null = table ? { table, mix: 1, last: false, tv: false } : null;
  for (let y = 0; y < LUT_STRIP_H; y++) {
    for (let x = 0; x < LUT_STRIP_W; x++) {
      const c = stripColor(x, y);
      const o = bind ? lutColor(c, bind) : c;
      const i = (y * LUT_STRIP_W + x) * 4;
      px[i] = Math.round(Math.min(1, Math.max(0, o[0])) * 255);
      px[i + 1] = Math.round(Math.min(1, Math.max(0, o[1])) * 255);
      px[i + 2] = Math.round(Math.min(1, Math.max(0, o[2])) * 255);
      px[i + 3] = 255;
    }
  }
  return px;
}
