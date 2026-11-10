import { describe, expect, it } from 'vitest';
import { frameBlendSamples, strobeSamples } from './defs/pack2-motion';
import { EFFECTS, getEffect } from './registry';

const NEW_IDS = [
  'adjust',
  'black-and-white',
  'sepia',
  'invert',
  'posterize',
  'threshold',
  'chroma-key',
  'tint',
  'fade-film',
  'gaussian-blur',
  'tilt-shift',
  'lens-blur',
  'sharpen',
  'frame-blend',
  'strobe',
  'speed-lines',
  'fisheye',
  'tunnel',
  'stretch',
  'tile',
  'heat-haze',
  'halftone',
  'edges',
  'old-film',
  'scanlines',
  'dither',
  'bloom',
  'duotone',
  'night-vision',
  'thermal',
];

describe('effect pack 2 registry', () => {
  it('registers every new effect once', () => {
    for (const id of NEW_IDS) {
      expect(getEffect(id), id).toBeDefined();
      expect(EFFECTS.filter((e) => e.id === id)).toHaveLength(1);
    }
  });

  it('defaults sit inside every param range and choice defaults are whole numbers', () => {
    for (const id of NEW_IDS) {
      for (const p of getEffect(id)!.params) {
        expect(p.default).toBeGreaterThanOrEqual(p.min);
        expect(p.default).toBeLessThanOrEqual(p.max);
        if (p.options) expect(Number.isInteger(p.default)).toBe(true);
      }
    }
  });

  it('frame blend and strobe are temporal, the rest are plain shaders', () => {
    for (const id of NEW_IDS) {
      const temporal = id === 'frame-blend' || id === 'strobe';
      expect(typeof getEffect(id)!.temporal === 'function', id).toBe(temporal);
    }
  });

  it('chroma key says plainly that it cannot make pixels transparent', () => {
    const def = getEffect('chroma-key')!;
    expect(def.description).toContain('no transparency');
    expect(def.glsl).toContain('opaque');
  });
});

describe('frame blend samples', () => {
  const p = { frames: 4, spread: 1 };

  it('is empty at amount 0 and for a zero span', () => {
    expect(frameBlendSamples(p, 0, 30, 1)).toEqual([]);
    expect(frameBlendSamples(p, -1, 30, 1)).toEqual([]);
  });

  it('puts one sample per frame, evenly, centered on the current moment', () => {
    const s = frameBlendSamples(p, 1, 30, 1);
    expect(s).toHaveLength(4);
    const gap = 1 / 30;
    for (let i = 1; i < s.length; i++) expect(s[i]!.offset - s[i - 1]!.offset).toBeCloseTo(gap, 9);
    expect(s[0]!.offset + s[3]!.offset).toBeCloseTo(0, 9);
    expect(s[3]!.offset - s[0]!.offset).toBeCloseTo(3 / 30, 9);
  });

  it('weights the middle most and keeps every weight positive', () => {
    const s = frameBlendSamples({ frames: 8, spread: 1 }, 1, 24, 1);
    const w = s.map((x) => x.weight);
    expect(Math.min(...w)).toBeGreaterThan(0);
    expect(w[0]).toBeLessThan(w[3]!);
    expect(w[0]).toBeCloseTo(w[7]!, 9);
  });

  it('spread widens the span and the amount shrinks it', () => {
    const span = (x: ReturnType<typeof frameBlendSamples>) => x[x.length - 1]!.offset - x[0]!.offset;
    const base = span(frameBlendSamples(p, 1, 30, 1));
    expect(span(frameBlendSamples({ ...p, spread: 2 }, 1, 30, 1))).toBeCloseTo(base * 2, 9);
    expect(span(frameBlendSamples(p, 0.5, 30, 1))).toBeCloseTo(base * 0.5, 9);
  });

  it('uses fewer samples at low quality but covers the same span', () => {
    const hi = frameBlendSamples({ frames: 8, spread: 1 }, 1, 30, 1);
    const lo = frameBlendSamples({ frames: 8, spread: 1 }, 1, 30, 0.25);
    expect(lo.length).toBeLessThan(hi.length);
    expect(lo.length).toBeGreaterThanOrEqual(2);
    expect(lo[lo.length - 1]!.offset - lo[0]!.offset).toBeCloseTo(hi[hi.length - 1]!.offset - hi[0]!.offset, 9);
  });

  it('survives garbage params', () => {
    const s = frameBlendSamples({ frames: 999, spread: -5 }, 1, 0, 7);
    expect(s.length).toBeGreaterThanOrEqual(2);
    for (const x of s) {
      expect(Number.isFinite(x.offset)).toBe(true);
      expect(x.weight).toBeGreaterThan(0);
    }
    expect(frameBlendSamples({}, 1, NaN, 1).length).toBeGreaterThanOrEqual(0);
  });
});

describe('strobe samples', () => {
  const p = { hold: 4 };

  it('does nothing without the project time', () => {
    expect(strobeSamples(p, 1, 30, undefined)).toEqual([]);
    expect(strobeSamples(p, 1, 30, NaN)).toEqual([]);
  });

  it('holds the first frame of each group of frames', () => {
    // frames 0..3 -> frame 0, frames 4..7 -> frame 4
    for (let f = 0; f < 12; f++) {
      const s = strobeSamples(p, 1, 30, f / 30);
      const held = Math.floor(f / 4) * 4;
      if (held === f) {
        expect(s).toEqual([]);
      } else {
        expect(s).toHaveLength(2);
        expect(s[0]!.offset).toBeCloseTo((held - f) / 30, 9);
        expect(s[0]).toEqual(s[1]);
      }
    }
  });

  it('is not thrown off by float error in the time', () => {
    // 3 / 30 * 30 is 2.9999999999999996 in floating point: still frame 3
    const s = strobeSamples({ hold: 2 }, 1, 30, 3 / 30);
    expect(s[0]!.offset).toBeCloseTo(-1 / 30, 9);
  });

  it('scales the jump by the amount and is empty at 0', () => {
    const full = strobeSamples(p, 1, 30, 3 / 30)[0]!.offset;
    expect(strobeSamples(p, 0.5, 30, 3 / 30)[0]!.offset).toBeCloseTo(full * 0.5, 9);
    expect(strobeSamples(p, 0, 30, 3 / 30)).toEqual([]);
  });

  it('never looks forward in time and clamps the hold', () => {
    for (const hold of [-3, 0, 1, 2, 30, 500]) {
      for (let f = 0; f < 70; f++) {
        for (const x of strobeSamples({ hold }, 1, 24, f / 24)) {
          expect(x.offset).toBeLessThanOrEqual(0);
          expect(x.offset).toBeGreaterThanOrEqual(-29 / 24 - 1e-9);
        }
      }
    }
  });
});

describe('dither matrix', () => {
  it('the bit trick in the glsl gives every value 0..63 exactly once', () => {
    const src = getEffect('dither')!.glsl;
    const m = /int v = (.*);/.exec(src);
    expect(m).not.toBeNull();
    // glsl int expression -> js: same operators and precedence
    const fn = new Function('x', 'y', 'xy', `return ${m![1]!};`) as (x: number, y: number, xy: number) => number;
    const seen = new Set<number>();
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) seen.add(fn(x, y, x ^ y));
    expect(seen.size).toBe(64);
    expect(Math.min(...seen)).toBe(0);
    expect(Math.max(...seen)).toBe(63);
    // the well known corner of the 4x4 bayer matrix: 0 8 / 12 4
    expect([fn(0, 0, 0), fn(1, 0, 1), fn(0, 1, 1), fn(1, 1, 0)]).toEqual([0, 32, 48, 16]);
  });
});
