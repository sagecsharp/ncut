import { describe, expect, it } from 'vitest';
import type { LutTable } from '../lib/cube';
import { lutColor } from '../engine/gradeLut';
import { LUT_STRIP_H, LUT_STRIP_HUE_ROWS, LUT_STRIP_W, lutStrip, stripColor } from './lutStrip';

const table = (size3: number, f: (r: number, g: number, b: number) => [number, number, number]): LutTable => {
  const data3 = new Float32Array(size3 * size3 * size3 * 3);
  for (let b = 0; b < size3; b++)
    for (let g = 0; g < size3; g++)
      for (let r = 0; r < size3; r++) {
        const o = f(r / (size3 - 1), g / (size3 - 1), b / (size3 - 1));
        data3.set(o, ((b * size3 + g) * size3 + r) * 3);
      }
  return { key: 't', title: '', size3, data3, min3: [0, 0, 0], max3: [1, 1, 1], size1: 0, data1: new Float32Array(0), min1: [0, 0, 0], max1: [1, 1, 1], identity: false };
};

const at = (px: Uint8ClampedArray, x: number, y: number) => {
  const i = (y * LUT_STRIP_W + x) * 4;
  return [px[i]!, px[i + 1]!, px[i + 2]!, px[i + 3]!];
};

describe('lutStrip', () => {
  it('hue sweep over a gray ramp', () => {
    const px = lutStrip(null);
    expect(px.length).toBe(LUT_STRIP_W * LUT_STRIP_H * 4);
    expect(LUT_STRIP_HUE_ROWS).toBe(24);
    // the top is saturated: the lowest channel is 0, the highest is 0.9
    for (let x = 0; x < LUT_STRIP_W; x += 7) {
      const [r, g, b] = at(px, x, 3);
      expect(Math.min(r!, g!, b!)).toBe(0);
      expect(Math.max(r!, g!, b!)).toBe(Math.round(0.9 * 255));
    }
    // the bottom is gray, black to white
    expect(at(px, 0, 30)).toEqual([0, 0, 0, 255]);
    expect(at(px, 63, 30)).toEqual([255, 255, 255, 255]);
    for (let x = 0; x < LUT_STRIP_W; x++) {
      const [r, g, b] = at(px, x, 35);
      expect(r).toBe(g);
      expect(g).toBe(b);
    }
    for (let i = 3; i < px.length; i += 4) expect(px[i]).toBe(255);
  });

  it('identity gives the strip back', () => {
    const id = lutStrip(table(2, (r, g, b) => [r, g, b]));
    const plain = lutStrip(null);
    for (let i = 0; i < plain.length; i++) expect(Math.abs(id[i]! - plain[i]!)).toBeLessThanOrEqual(1);
  });

  it('each pixel is lutColor of the strip color', () => {
    const t = table(2, (r, g, b) => [b, g, r]);
    const px = lutStrip(t);
    for (let y = 0; y < LUT_STRIP_H; y += 5) {
      for (let x = 0; x < LUT_STRIP_W; x += 6) {
        const want = lutColor(stripColor(x, y), { table: t, mix: 1, last: false, tv: false });
        const got = at(px, x, y);
        expect(got[0]).toBe(Math.round(255 * want[0]));
        expect(got[1]).toBe(Math.round(255 * want[1]));
        expect(got[2]).toBe(Math.round(255 * want[2]));
      }
    }
  });
});
