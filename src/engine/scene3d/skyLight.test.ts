import { describe, expect, it } from 'vitest';
import { DEFAULT_SUN } from './light';
import { SKY_SAMPLE } from './sky';
import { measureSkyLight } from './skyLight';

const N = SKY_SAMPLE;

/** one face of SKY_SAMPLE x SKY_SAMPLE rgba, alpha 255. fn gets s, t in 0..1 (texel centers) */
function face(fn: (x: number, y: number) => [number, number, number]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(N * N * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const [r, g, b] = fn((x + 0.5) / N, (y + 0.5) / N);
      const o = (y * N + x) * 4;
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = 255;
    }
  }
  return out;
}
const flat = (c: [number, number, number]) => face(() => c);
const GREY: [number, number, number] = [0x20, 0x20, 0x20];
const WHITE: [number, number, number] = [255, 255, 255];
const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];

/** six dark faces with a white 3 x 3 spot on one face around (s, t) */
function withSpot(at: number, s: number, t: number): Uint8ClampedArray[] {
  return [0, 1, 2, 3, 4, 5].map((f) =>
    face((u, v) => (f === at && Math.abs(u - s) <= 1.5 / N + 1e-9 && Math.abs(v - t) <= 1.5 / N + 1e-9 ? WHITE : GREY)),
  );
}

describe('measureSkyLight', () => {
  it('a flat grey sky gives grey sky, horizon and ground and no sun', () => {
    const l = measureSkyLight([0, 1, 2, 3, 4, 5].map(() => flat([0x80, 0x80, 0x80])), N);
    expect(l.sky).toBe('#808080');
    expect(l.horizon).toBe('#808080');
    expect(l.ground).toBe('#808080');
    expect(l.sun).toBe(0);
    expect(l.sunColor).toBe(DEFAULT_SUN.sunColor);
    expect(l.sunTurn).toBe(DEFAULT_SUN.sunTurn);
    expect(l.sunHeight).toBe(DEFAULT_SUN.sunHeight);
  });

  it('a blue top and a brown bottom lean the sky blue and the ground brown', () => {
    const blue: [number, number, number] = [0x30, 0x60, 0xff];
    const brown: [number, number, number] = [0x60, 0x40, 0x20];
    const wall = () => face((_s, t) => (t < 0.5 ? blue : brown));
    const l = measureSkyLight([wall(), wall(), flat(blue), flat(brown), wall(), wall()], N);
    const sky = rgb(l.sky);
    const ground = rgb(l.ground);
    const horizon = rgb(l.horizon);
    expect(sky[2]).toBeGreaterThan(sky[0]);
    expect(ground[0]).toBeGreaterThan(ground[2]);
    for (let c = 0; c < 3; c++) {
      expect(horizon[c]).toBeGreaterThanOrEqual(Math.min(sky[c]!, ground[c]!));
      expect(horizon[c]).toBeLessThanOrEqual(Math.max(sky[c]!, ground[c]!));
    }
  });

  it('a bright spot on the right above the horizon is a sun at turn 90', () => {
    const l = measureSkyLight(withSpot(0, 0.5, 0.3), N);
    expect(l.sun).toBeGreaterThan(0);
    expect(Math.abs(l.sunTurn - 90)).toBeLessThan(10);
    expect(l.sunHeight).toBeGreaterThan(5);
    expect(l.sunHeight).toBeLessThan(45);
    expect(l.sunColor).toBe('#ffffff');
  });

  it('a bright spot in front is a sun at turn 180', () => {
    const l = measureSkyLight(withSpot(4, 0.5, 0.3), N);
    expect(l.sun).toBeGreaterThan(0);
    expect(Math.abs(l.sunTurn)).toBeGreaterThanOrEqual(170);
  });

  it('a bright spot below the horizon is no sun', () => {
    const l = measureSkyLight(withSpot(3, 0.5, 0.5), N);
    expect(l.sun).toBe(0);
  });

  it('a bright spot below the horizon on a wall is no sun', () => {
    expect(measureSkyLight(withSpot(0, 0.5, 0.7), N).sun).toBe(0);
    expect(measureSkyLight(withSpot(4, 0.2, 0.8), N).sun).toBe(0);
  });

  it('a black sky gives black and no sun, every number finite', () => {
    const l = measureSkyLight([0, 1, 2, 3, 4, 5].map(() => flat([0, 0, 0])), N);
    expect(l.sky).toBe('#000000');
    expect(l.horizon).toBe('#000000');
    expect(l.ground).toBe('#000000');
    expect(l.sun).toBe(0);
    for (const v of [l.sun, l.sunTurn, l.sunHeight]) expect(Number.isFinite(v)).toBe(true);
  });
});
