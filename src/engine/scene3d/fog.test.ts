import { describe, expect, it } from 'vitest';
import type { SceneFog } from '../../types';
import { fogFactor, fogOn, mixFog, parseFogColor, writeFogUniforms } from './fog';

const fog = (o: Partial<SceneFog> = {}): SceneFog => ({ color: '#808080', near: 100, far: 300, amount: 1, ...o });

describe('fogFactor', () => {
  it('ramps from near to far', () => {
    expect(fogFactor(100, fog())).toBe(0);
    expect(fogFactor(200, fog())).toBeCloseTo(0.5, 9);
    expect(fogFactor(300, fog())).toBe(1);
  });
  it('clamps outside the range', () => {
    expect(fogFactor(0, fog())).toBe(0);
    expect(fogFactor(-50, fog())).toBe(0);
    expect(fogFactor(1e6, fog())).toBe(1);
  });
  it('scales by amount', () => {
    expect(fogFactor(1e6, fog({ amount: 0.4 }))).toBeCloseTo(0.4, 9);
    expect(fogFactor(200, fog({ amount: 0.5 }))).toBeCloseTo(0.25, 9);
    expect(fogFactor(1e6, fog({ amount: 7 }))).toBe(1);
  });
  it('is off for null, amount 0 and far <= near', () => {
    expect(fogFactor(1e6, null)).toBe(0);
    expect(fogFactor(1e6, undefined)).toBe(0);
    expect(fogFactor(1e6, fog({ amount: 0 }))).toBe(0);
    expect(fogFactor(1e6, fog({ amount: -1 }))).toBe(0);
    expect(fogFactor(1e6, fog({ near: 300, far: 300 }))).toBe(0);
    expect(fogFactor(1e6, fog({ near: 400, far: 300 }))).toBe(0);
    expect(fogOn(null)).toBe(false);
    expect(fogOn(fog())).toBe(true);
  });
  it('never gives NaN', () => {
    expect(fogFactor(NaN, fog())).toBe(0);
  });
});

describe('mixFog', () => {
  it('mixes toward the fog color', () => {
    expect(mixFog([1, 0, 0.5], [0, 1, 0.5], 0)).toEqual([1, 0, 0.5]);
    expect(mixFog([1, 0, 0.5], [0, 1, 0.5], 1)).toEqual([0, 1, 0.5]);
    const h = mixFog([1, 0, 0], [0, 0, 1], 0.25);
    expect(h[0]).toBeCloseTo(0.75, 9);
    expect(h[2]).toBeCloseTo(0.25, 9);
  });
});

describe('parseFogColor', () => {
  it('reads hex colors', () => {
    expect(parseFogColor('#000000')).toEqual([0, 0, 0]);
    expect(parseFogColor('#ffffff')).toEqual([1, 1, 1]);
    expect(parseFogColor('#ff0000')).toEqual([1, 0, 0]);
    expect(parseFogColor('#f00')).toEqual([1, 0, 0]);
    expect(parseFogColor('#00FF0080')).toEqual([0, 1, 0]);
    expect(parseFogColor('#0f08')).toEqual([0, 1, 0]);
    expect(parseFogColor('#808080')[0]).toBeCloseTo(128 / 255, 9);
  });
  it('falls back to black', () => {
    expect(parseFogColor('red')).toEqual([0, 0, 0]);
    expect(parseFogColor('')).toEqual([0, 0, 0]);
    expect(parseFogColor('#12')).toEqual([0, 0, 0]);
  });
  it('is cached', () => {
    expect(parseFogColor('#123456')).toBe(parseFogColor('#123456'));
  });
});

describe('writeFogUniforms', () => {
  it('writes color, near, span and amount', () => {
    const out = new Float32Array(6);
    writeFogUniforms(fog({ color: '#ff0000', amount: 0.5 }), out);
    expect(Array.from(out)).toEqual([1, 0, 0, 100, 200, 0.5]);
  });
  it('zeroes the amount when off', () => {
    const out = new Float32Array([1, 1, 1, 1, 1, 1]);
    writeFogUniforms(null, out);
    expect(out[5]).toBe(0);
    out[5] = 1;
    writeFogUniforms(fog({ far: 50 }), out);
    expect(out[5]).toBe(0);
  });
});
