import { describe, expect, it } from 'vitest';
import { probePixel, probePlace, probeShows, probeText } from './probe';

describe('probe', () => {
  it('probeText pads like the example', () => {
    expect(probeText(235, 120, 64)).toEqual(['rgb 235 120  64', 'hsl  20  81%  59%', 'luma  54.9 #eb7840']);
  });
  it('probeText of a gray', () => {
    expect(probeText(128, 128, 128)).toEqual(['rgb 128 128 128', 'hsl   0   0%  50%', 'luma  50.2 #808080']);
    expect(probeText(0, 0, 0)[2]).toBe('luma   0.0 #000000');
    expect(probeText(255, 255, 255)[2]).toBe('luma 100.0 #ffffff');
  });
  it('probePixel refuses outside', () => {
    const rect = { left: 100, top: 50, width: 200, height: 100 };
    expect(probePixel(100, 50, rect, 20, 10)).toEqual({ x: 0, y: 0 });
    expect(probePixel(299.9, 149.9, rect, 20, 10)).toEqual({ x: 19, y: 9 });
    expect(probePixel(300, 100, rect, 20, 10)).toBeNull();
    expect(probePixel(99, 100, rect, 20, 10)).toBeNull();
    expect(probePixel(150, 150, rect, 20, 10)).toBeNull();
    expect(probePixel(150, 100, { ...rect, width: 0 }, 20, 10)).toBeNull();
  });
  it('probePlace flips and stays inside', () => {
    expect(probePlace(10, 10, 100, 50, 500, 400)).toEqual({ x: 24, y: 24 });
    expect(probePlace(450, 10, 100, 50, 500, 400)).toEqual({ x: 336, y: 24 });
    expect(probePlace(10, 380, 100, 50, 500, 400)).toEqual({ x: 24, y: 316 });
    // a box bigger than the area sits at 0
    expect(probePlace(10, 10, 600, 500, 500, 400)).toEqual({ x: 0, y: 0 });
  });
  it('probeShows', () => {
    expect(probeShows(true, 0, 'output')).toBe(true);
    expect(probeShows(false, 0, 'output')).toBe(false);
    expect(probeShows(true, 1, 'output')).toBe(false);
    expect(probeShows(true, 0, 'scene')).toBe(false);
    expect(probeShows(true, 0, 'source')).toBe(false);
  });
});
