import { describe, expect, it } from 'vitest';
import { FOG_GAP, FOG_MAX, defaultFog, setFogAmount, setFogFar, setFogNear } from './fogLogic';

describe('fog logic', () => {
  it('starts with the background color', () => {
    expect(defaultFog('#112233')).toEqual({ color: '#112233', near: 1158, far: 4632, amount: 1 });
    expect(defaultFog('#112233', 720).near).toBe(772);
    expect(defaultFog('#AABBCCDD').color).toBe('#aabbcc');
  });
  it('falls back to black for other colors', () => {
    expect(defaultFog('red').color).toBe('#000000');
    expect(defaultFog('').color).toBe('#000000');
  });
  it('pushes far past near', () => {
    const f = setFogNear(defaultFog('#000000'), 6000);
    expect(f.near).toBe(6000);
    expect(f.far).toBe(6000 + FOG_GAP);
  });
  it('keeps far where it is when near stays below', () => {
    expect(setFogNear(defaultFog('#000000'), 100).far).toBe(4632);
  });
  it('never lets far reach near', () => {
    const f = setFogFar(defaultFog('#000000'), 100);
    expect(f.far).toBe(1158 + FOG_GAP);
    expect(setFogFar(f, 1e9).far).toBe(FOG_MAX);
  });
  it('clamps near and ignores junk', () => {
    expect(setFogNear(defaultFog('#000000'), -5).near).toBe(0);
    expect(setFogNear(defaultFog('#000000'), Number.NaN).near).toBe(0);
    expect(setFogNear(defaultFog('#000000'), 1e9).near).toBe(FOG_MAX - FOG_GAP);
  });
  it('maps strength percent to a fraction', () => {
    expect(setFogAmount(defaultFog('#000000'), 40).amount).toBe(0.4);
    expect(setFogAmount(defaultFog('#000000'), 400).amount).toBe(1);
    expect(setFogAmount(defaultFog('#000000'), -4).amount).toBe(0);
  });
  it('does not change the input', () => {
    const f = defaultFog('#000000');
    setFogNear(f, 9000);
    expect(f.near).toBe(500);
  });
});
