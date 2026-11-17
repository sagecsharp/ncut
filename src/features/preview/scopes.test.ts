import { describe, expect, it } from 'vitest';
import {
  binScopes,
  channelMeans,
  chromaOf,
  lumaLevels,
  lumaOf,
  lumaStats,
  sameKey,
  sampleSize,
  scopeDelay,
  scopeInterval,
  SKIN_DIR,
  subsample,
  vectorTargets,
  type BinWants,
} from './scopes';

const ALL: BinWants = { wave: true, parade: true, vector: true };
const sum = (a: Uint32Array): number => a.reduce((s, v) => s + v, 0);
const rgba = (...px: [number, number, number][]): Uint8ClampedArray => new Uint8ClampedArray(px.flatMap(([r, g, b]) => [r, g, b, 255]));
const binOf = (v: Uint32Array): { col: number; row: number } => {
  const i = v.findIndex((n) => n > 0);
  return { col: i % 256, row: Math.floor(i / 256) };
};

describe('lumaOf', () => {
  it('lumaOf of red, green, blue, white, black', () => {
    expect([lumaOf(255, 0, 0), lumaOf(0, 255, 0), lumaOf(0, 0, 255), lumaOf(255, 255, 255), lumaOf(0, 0, 0)]).toEqual([54, 182, 18, 255, 0]);
  });
});

describe('chromaOf', () => {
  it('chromaOf of a gray is exactly 0, 0', () => {
    for (let v = 0; v < 256; v++) {
      const c = chromaOf(v, v, v);
      expect(c.cb).toBe(0);
      expect(c.cr).toBe(0);
    }
  });
  it('chromaOf of the 100% targets', () => {
    const at = (r: number, g: number, b: number, cb: number, cr: number) => {
      const c = chromaOf(r, g, b);
      expect(Math.abs(c.cb - cb)).toBeLessThan(1e-3);
      expect(Math.abs(c.cr - cr)).toBeLessThan(1e-3);
    };
    at(255, 0, 0, -0.1146, 0.5);
    at(0, 255, 0, -0.3854, -0.4542);
    at(0, 0, 255, 0.5, -0.0458);
    at(255, 255, 0, -0.5, 0.0458);
    at(0, 255, 255, 0.1146, -0.5);
    at(255, 0, 255, 0.3854, 0.4542);
  });
});

describe('binScopes', () => {
  it('binScopes waveform, parade and histogram sums', () => {
    // 3 x 2: the top row red, green, blue, the bottom row white, black, gray
    const data = rgba([255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255], [0, 0, 0], [128, 128, 128]);
    const b = binScopes(data, 3, 2, 1, ALL);
    expect(b.pixels).toBe(6);
    expect(b.wave.length).toBe(3 * 256);
    expect(b.parade.length).toBe(3 * 3 * 256);
    expect(sum(b.wave)).toBe(6);
    for (let x = 0; x < 3; x++) expect(sum(b.wave.subarray(x * 256, x * 256 + 256))).toBe(2);
    // column 0 holds red (luma 54) and white (255)
    expect(b.wave[54]).toBe(1);
    expect(b.wave[255]).toBe(1);
    for (let p = 0; p < 3; p++) expect(sum(b.parade.subarray(p * 3 * 256, (p + 1) * 3 * 256))).toBe(6);
    // r plane, column 0: red and white at 255
    expect(b.parade[255]).toBe(2);
    expect(sum(b.hist.subarray(0, 256))).toBe(6);
    expect(sum(b.hist.subarray(768, 1024))).toBe(6);
    expect(b.hist[255]).toBe(2);
    expect(b.hist[768 + 255]).toBe(1);
  });
  it('vector bins of red, green and blue', () => {
    expect(binOf(binScopes(rgba([255, 0, 0]), 1, 1, 1, ALL).vector)).toEqual({ col: 103, row: 21 });
    expect(binOf(binScopes(rgba([0, 255, 0]), 1, 1, 1, ALL).vector)).toEqual({ col: 45, row: 224 });
    expect(binOf(binScopes(rgba([0, 0, 255]), 1, 1, 1, ALL).vector)).toEqual({ col: 234, row: 137 });
  });
  it('every gray in bin 128, 128', () => {
    for (let v = 0; v < 256; v++) {
      const b = binScopes(rgba([v, v, v]), 1, 1, 1, ALL);
      expect(binOf(b.vector)).toEqual({ col: 128, row: 128 });
      expect(sum(b.vector)).toBe(1);
    }
  });
  it('zoom 2 drops red', () => {
    expect(sum(binScopes(rgba([255, 0, 0]), 1, 1, 2, ALL).vector)).toBe(0);
    expect(sum(binScopes(rgba([128, 120, 128]), 1, 1, 2, ALL).vector)).toBe(1);
  });
  it('reuses the buffers', () => {
    const data = rgba([10, 20, 30], [40, 50, 60]);
    const first = binScopes(data, 2, 1, 1, ALL);
    const again = binScopes(data, 2, 1, 1, ALL, first);
    expect(again.wave).toBe(first.wave);
    expect(again.parade).toBe(first.parade);
    expect(again.vector).toBe(first.vector);
    expect(again.hist).toBe(first.hist);
    // zeroed first: the counts are not doubled
    expect(sum(again.hist.subarray(768, 1024))).toBe(2);
    expect(sum(again.wave)).toBe(2);
  });
  it('skips unwanted planes', () => {
    const b = binScopes(rgba([1, 2, 3]), 1, 1, 1, { wave: false, parade: false, vector: false });
    expect(b.wave.length).toBe(0);
    expect(b.parade.length).toBe(0);
    expect(b.vector.length).toBe(0);
    expect(b.hist.length).toBe(1024);
    expect(sum(b.hist.subarray(0, 256))).toBe(1);
  });
  it('throws on short data', () => {
    expect(() => binScopes(new Uint8ClampedArray(7), 1, 2, 1, ALL)).toThrow();
    expect(() => binScopes(new Uint8ClampedArray(4), 0, 1, 1, ALL)).toThrow();
  });
});

describe('targets', () => {
  it('vectorTargets at 75%', () => {
    const t = vectorTargets(0.75);
    expect(t.map((x) => x.id)).toEqual(['r', 'mg', 'b', 'cy', 'g', 'yl']);
    expect(t[0]!.cb).toBeCloseTo(-0.1146 * 0.75, 3);
    expect(t[0]!.cr).toBeCloseTo(0.5 * 0.75, 3);
    expect(t[4]!.cr).toBeCloseTo(-0.4542 * 0.75, 3);
  });
  it('the skin line', () => {
    expect(SKIN_DIR.cb).toBeCloseTo(-0.545, 3);
    expect(SKIN_DIR.cr).toBeCloseTo(0.839, 3);
  });
});

describe('stats', () => {
  it('lumaStats, null for no pixels', () => {
    expect(lumaStats(new Uint32Array(1024), 0)).toBeNull();
    const s = lumaStats(binScopes(rgba([0, 0, 0], [255, 255, 255]), 2, 1, 1, ALL).hist, 2)!;
    expect(s.min).toBe(0);
    expect(s.max).toBe(100);
    expect(s.mean).toBeCloseTo(50, 6);
    expect(s.black).toBe(0.5);
    expect(s.white).toBe(0.5);
    expect(s.pixels).toBe(2);
  });
  it('channelMeans', () => {
    expect(channelMeans(new Uint32Array(1024), 0)).toBeNull();
    const m = channelMeans(binScopes(rgba([255, 0, 0], [255, 0, 255]), 2, 1, 1, ALL).hist, 2)!;
    expect(m.r).toBeCloseTo(100, 6);
    expect(m.g).toBe(0);
    expect(m.b).toBeCloseTo(50, 6);
  });
  it('lumaLevels', () => {
    const data = rgba([10, 20, 30], [200, 100, 50], [0, 0, 0]);
    expect(Array.from(lumaLevels(data, 3))).toEqual(Array.from(binScopes(data, 3, 1, 1, ALL).hist));
    const out = new Uint32Array(1024);
    expect(lumaLevels(data, 3, out)).toBe(out);
    expect(sum(lumaLevels(data, 3, out).subarray(768))).toBe(3);
  });
});

describe('sampling', () => {
  it('sampleSize never grows', () => {
    expect(sampleSize(1920, 1080, 384)).toEqual({ w: 384, h: 216 });
    expect(sampleSize(1080, 1920, 384)).toEqual({ w: 216, h: 384 });
    expect(sampleSize(100, 50, 384)).toEqual({ w: 100, h: 50 });
    expect(sampleSize(4000, 1, 384)).toEqual({ w: 384, h: 1 });
  });
  it('subsample picks real pixels', () => {
    const w = 8,
      h = 6;
    const px: [number, number, number][] = [];
    for (let i = 0; i < w * h; i++) px.push([i * 5, i, 255 - i]);
    const data = rgba(...px);
    const s = subsample(data, w, h, 4);
    expect(s).toMatchObject({ w: 4, h: 3 });
    const seen = new Set(px.map((p) => p.join(',')));
    for (let i = 0; i < s.w * s.h; i++) expect(seen.has(`${s.data[i * 4]},${s.data[i * 4 + 1]},${s.data[i * 4 + 2]}`)).toBe(true);
    // the first target pixel takes source (floor(0.5 * 2), floor(0.5 * 2)) = (1, 1)
    expect(Array.from(s.data.subarray(0, 3))).toEqual(px[1 * w + 1]);
    // small enough: the input itself
    expect(subsample(data, w, h, 100).data).toBe(data);
  });
  it('sameKey', () => {
    const o = {};
    expect(sameKey([o, 1, 'a'], [o, 1, 'a'])).toBe(true);
    expect(sameKey([o, 1], [{}, 1])).toBe(false);
    expect(sameKey([1], [1, 2])).toBe(false);
  });
});

describe('pace', () => {
  it('scopeInterval', () => {
    expect(scopeInterval(false, 0)).toBe(0);
    expect(scopeInterval(true, 0)).toBe(83);
    expect(scopeInterval(false, 5)).toBe(60);
    expect(scopeInterval(true, 10)).toBe(120);
    expect(scopeInterval(true, 100)).toBe(250);
    expect(scopeInterval(true, NaN)).toBe(83);
    expect(scopeInterval(false, -3)).toBe(0);
  });
  it('scopeDelay', () => {
    expect(scopeDelay(1000, 990, false, 0)).toBe(0);
    expect(scopeDelay(1030, 1000, true, 0)).toBe(53);
    expect(scopeDelay(1200, 1000, true, 0)).toBe(0);
    // a clock that went back never waits longer than the interval
    expect(scopeDelay(0, 1000, true, 0)).toBe(83);
    expect(scopeDelay(1000, 1000, true, 5)).toBe(83);
    expect(scopeDelay(1000, 1000, true, 10)).toBe(120);
  });
});
