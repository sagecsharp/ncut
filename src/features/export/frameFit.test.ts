import { describe, expect, it } from 'vitest';
import { placeFrame } from './frameFit';
import type { FitMode } from './frameFit';
import { outputSize } from './exporter';

describe('placeFrame', () => {
  it('the project shape is drawn direct at every scale', () => {
    const sizes: Array<[number, number]> = [[1920, 1080], [1280, 720], [1080, 1920], [1000, 1000], [1366, 768]];
    for (const [w, h] of sizes) {
      for (const scale of [1, 0.75, 0.5]) {
        const out = outputSize({ width: w, height: h }, scale);
        for (const fit of ['fit', 'fill'] as FitMode[]) {
          expect(placeFrame(w, h, out.width, out.height, fit).direct).toBe(true);
        }
      }
    }
  });

  it('a pixel of rounding stays direct', () => {
    expect(placeFrame(1920, 1080, 1920, 1088, 'fit').direct).toBe(true);
    expect(placeFrame(1920, 1080, 1920, 1088, 'fill').direct).toBe(true);
  });

  it('fit puts the whole picture in with bars', () => {
    expect(placeFrame(1920, 1080, 1080, 1920, 'fit')).toEqual({ direct: false, drawWidth: 1080, drawHeight: 608, x: 0, y: 656 });
    expect(placeFrame(1080, 1920, 1920, 1080, 'fit')).toEqual({ direct: false, drawWidth: 608, drawHeight: 1080, x: 656, y: 0 });
  });

  it('fill covers the output and cuts the edges', () => {
    expect(placeFrame(1920, 1080, 1080, 1920, 'fill')).toEqual({ direct: false, drawWidth: 3413, drawHeight: 1920, x: -1166, y: 0 });
  });
});
