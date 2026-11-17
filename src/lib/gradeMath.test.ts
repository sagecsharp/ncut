import { describe, expect, it } from 'vitest';
import type { GradePoint } from '../types';
import {
  CB_DIV,
  CR_DIV,
  HUE_RED,
  HUE_SWATCHES,
  KB,
  KG,
  KR,
  PUCK_K,
  TAU,
  cbcrOf,
  curveSampler,
  hueColor,
  hueOf,
  lumaOf,
  puckOf,
  rgbFromPuck,
  steffen,
} from './gradeMath';
import type { Rgb3 } from './gradeMath';

const near = (a: number, b: number, d = 4) => expect(a).toBeCloseTo(b, d);

describe('hue and chroma', () => {
  it('HUE_RED is about 102.906 degrees', () => {
    near((HUE_RED * 180) / Math.PI, 102.906, 2);
    near(TAU, 6.283185, 5);
  });

  it('luma and chroma are rec 709', () => {
    near(lumaOf(1, 1, 1), 1);
    near(KR + KG + KB, 1);
    expect(cbcrOf(0.5, 0.5, 0.5)[0]).toBeCloseTo(0, 9);
    near(cbcrOf(0, 0, 1)[0], (1 - KB) / CB_DIV);
    near(cbcrOf(1, 0, 0)[1], (1 - KR) / CR_DIV);
  });

  it('hueOf puts the six colors in order', () => {
    near(hueOf(1, 0, 0), 0);
    near(hueOf(1, 1, 0), 0.1996, 3);
    near(hueOf(0, 1, 0), 0.3522, 3);
    near(hueOf(0, 1, 1), 0.5);
    near(hueOf(0, 0, 1), 0.6996, 3);
    near(hueOf(1, 0, 1), 0.8522, 3);
    expect(hueOf(0.4, 0.4, 0.4)).toBe(-1);
    expect(HUE_SWATCHES.map((s) => s.name)).toEqual(['red', 'yellow', 'green', 'cyan', 'blue', 'magenta']);
    near(HUE_SWATCHES[1]!.h, 0.1996);
  });

  it('hueColor 0 is red and 0.5 is cyan', () => {
    const red = hueColor(0);
    const cyan = hueColor(0.5);
    [1, 0, 0].forEach((v, i) => near(red[i]!, v));
    [0, 1, 1].forEach((v, i) => near(cyan[i]!, v));
    for (const h of [0.1, 0.3, 0.77]) for (const v of hueColor(h)) expect(v).toBeGreaterThanOrEqual(-1e-9);
  });
});

describe('pucks', () => {
  it('a puck round trips', () => {
    const rgb: Rgb3 = [0.3, 0.2, 0.25];
    const p = puckOf(rgb);
    expect(p.beyond).toBe(false);
    const back = rgbFromPuck(p.x, p.y, lumaOf(...rgb));
    back.forEach((v, i) => near(v, rgb[i]!, 3));
  });

  it('red sits up and left', () => {
    const p = puckOf([1, 0, 0]);
    expect(p.x).toBeLessThan(0);
    expect(p.y).toBeGreaterThan(0);
    expect(p.beyond).toBe(true);
  });

  it('rgbFromPuck keeps the luma part', () => {
    const c = rgbFromPuck(0.4, -0.3, 0.1);
    near(lumaOf(...c), 0.1, 3);
    expect(rgbFromPuck(0, 0, 0.2)).toEqual([0.2, 0.2, 0.2]);
  });

  it('the rim clamps and beyond says so', () => {
    const p = puckOf([1, 0, 0]);
    near(Math.hypot(p.x, p.y), 1);
    const c = rgbFromPuck(p.x * 3, p.y * 3, 0);
    near(c[0], 0.384, 3);
    near(c[1], -0.104, 3);
    near(c[2], -0.104, 3);
    expect(rgbFromPuck(0, 0, 5)).toEqual([1, 1, 1]);
    near(PUCK_K, 0.25);
  });
});

describe('steffen', () => {
  const xs = [0, 0.2, 0.5, 0.6, 1];
  const ys = [0, 0.1, 0.7, 0.75, 1];

  it('goes through every point', () => {
    const f = steffen(xs, ys);
    xs.forEach((x, i) => near(f(x), ys[i]!, 9));
  });

  it('is monotone in and out', () => {
    const f = steffen(xs, ys);
    let prev = f(0);
    for (let i = 1; i <= 200; i++) {
      const v = f(i / 200);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = v;
    }
  });

  it('never passes a local extreme', () => {
    const px = [0, 0.25, 0.5, 0.75, 1];
    const py = [0.2, 0.9, 0.3, 0.8, 0.5];
    const f = steffen(px, py);
    for (let i = 0; i <= 400; i++) {
      const v = f(i / 400);
      expect(v).toBeLessThanOrEqual(0.9 + 1e-9);
      expect(v).toBeGreaterThanOrEqual(0.2 - 1e-9);
    }
    // between the 0.9 peak and the 0.3 dip it stays inside
    for (let i = 100; i <= 200; i++) {
      const v = f(i / 400);
      expect(v).toBeLessThanOrEqual(0.9 + 1e-9);
      expect(v).toBeGreaterThanOrEqual(0.3 - 1e-9);
    }
  });

  it('two points give a line', () => {
    const f = steffen([0.2, 0.8], [0.1, 0.7]);
    near(f(0.5), 0.4, 9);
    near(f(0), 0.1, 9);
    near(f(1), 0.7, 9);
  });

  it('collinear points give that exact line', () => {
    const f = steffen([0, 0.3, 0.4, 1], [0, 0.3, 0.4, 1]);
    for (let i = 0; i <= 50; i++) near(f(i / 50), i / 50, 12);
  });
});

describe('curveSampler', () => {
  it('curveSampler defaults', () => {
    expect(curveSampler('y', undefined)(0.3)).toBe(0.3);
    expect(curveSampler('r', null)(2)).toBe(1);
    expect(curveSampler('b', [[0, 0], [1, 1]])(-1)).toBe(0);
    expect(curveSampler('hueSat', null)(0.3)).toBe(0.5);
    expect(curveSampler('hueHue', [])(0.3)).toBe(0.5);
    expect(curveSampler('lumaSat', undefined)(0.9)).toBe(0.5);
    expect(curveSampler('hueSat', [[0.4, 0.8]])(0.9)).toBe(0.8);
    expect(curveSampler('y', [[0.5, 0.7]])(0.1)).toBeGreaterThan(0);
  });

  it('curveSampler is flat past the ends', () => {
    const lum = curveSampler('lumaSat', [[0.2, 0.9], [0.6, 0.3]]);
    near(lum(0), 0.9, 9);
    near(lum(1), 0.3, 9);
    near(lum(0.2), 0.9, 9);
    const tone = curveSampler('y', [[0, 0.1], [0.5, 0.6], [1, 0.9]]);
    near(tone(-2), 0.1, 9);
    near(tone(3), 0.9, 9);
    near(tone(0.5), 0.6, 9);
  });

  it('hue lists are continuous across 0 and 1', () => {
    const pts: GradePoint[] = [[0.1, 0.9], [0.5, 0.2], [0.8, 0.7]];
    const f = curveSampler('hueSat', pts);
    near(f(0.1), 0.9, 9);
    near(f(0.5), 0.2, 9);
    near(f(0.999999), f(0), 4);
    near(f(1.3), f(0.3), 9);
    for (let i = 0; i <= 100; i++) {
      const v = f(i / 100);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});
