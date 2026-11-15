import { describe, expect, it } from 'vitest';
import { SKY_SAMPLE, faceDirection, turnSample } from './sky';
import { fitNote, fitSides, seamError } from './skyFit';

const N = SKY_SAMPLE;

/** a smooth color of the direction: neighbors across an edge match */
function seamless(): Uint8ClampedArray[] {
  return [0, 1, 2, 3, 4, 5].map((f) => {
    const out = new Uint8ClampedArray(N * N * 4);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const d = faceDirection(f, (x + 0.5) / N, (y + 0.5) / N);
        const len = Math.hypot(d[0], d[1], d[2]);
        const o = (y * N + x) * 4;
        for (let c = 0; c < 3; c++) out[o + c] = Math.round(127.5 + (120 * d[c]!) / len);
        out[o + 3] = 255;
      }
    }
    return out;
  });
}

describe('seam fit', () => {
  it('a seamless cube has a small seam error and needs no fit', () => {
    const faces = seamless();
    expect(seamError(faces, N)).toBeLessThan(6);
    const fit = fitSides(faces, N);
    expect(fit.swap).toBe(false);
    expect(fit.top).toBe(0);
    expect(fit.bottom).toBe(0);
  });

  it('left and right swapped are swapped back', () => {
    const good = seamless();
    const bad = [good[1]!, good[0]!, ...good.slice(2)];
    expect(seamError(bad, N)).toBeGreaterThan(10);
    const fit = fitSides(bad, N);
    expect(fit.swap).toBe(true);
    const fixed = [bad[1]!, bad[0]!, ...bad.slice(2)];
    expect(seamError(fixed, N)).toBeLessThan(6);
    expect(fit.after).toBeLessThan(6);
  });

  it('a turned top is turned back', () => {
    const good = seamless();
    const bad = [...good];
    bad[2] = turnSample(good[2]!, N, 3);
    const fit = fitSides(bad, N);
    expect(fit.top).toBe(1);
    expect(fit.bottom).toBe(0);
    expect(fit.swap).toBe(false);
  });

  it('a turned bottom is turned back', () => {
    const good = seamless();
    const bad = [...good];
    bad[3] = turnSample(good[3]!, N, 1);
    const fit = fitSides(bad, N);
    expect(fit.bottom).toBe(3);
    expect(fit.top).toBe(0);
    expect(fit.swap).toBe(false);
  });

  it('flat colored sides are left as named', () => {
    const colors = [
      [200, 30, 30],
      [30, 200, 30],
      [30, 30, 200],
      [200, 200, 30],
      [30, 200, 200],
      [200, 30, 200],
    ];
    const faces = colors.map((c) => {
      const out = new Uint8ClampedArray(N * N * 4);
      for (let i = 0; i < N * N; i++) out.set([c[0]!, c[1]!, c[2]!, 255], i * 4);
      return out;
    });
    const fit = fitSides(faces, N);
    expect(fit.swap).toBe(false);
    expect(fit.top).toBe(0);
    expect(fit.bottom).toBe(0);
    expect(Math.abs(fit.after - fit.before)).toBeLessThan(1e-6);
  });

  it('fitNote says what changed, null for nothing', () => {
    expect(fitNote({ swap: false, top: 0, bottom: 0, before: 20, after: 20 })).toBeNull();
    expect(fitNote({ swap: true, top: 1, bottom: 0, before: 40, after: 5 })).toBe('swapped left and right, turned the top 90 deg');
    expect(fitNote({ swap: false, top: 0, bottom: 2, before: 40, after: 5 })).toBe('turned the bottom 180 deg');
  });
});
