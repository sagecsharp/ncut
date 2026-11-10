import { describe, expect, it } from 'vitest';
import { setAdjustValue, setBlurStyle, setBlurValue } from './colorLogic';

describe('setAdjustValue', () => {
  it('creates an adjust from the first change', () => {
    expect(setAdjustValue(null, 'brightness', 0.3)).toEqual({ brightness: 0.3, contrast: 0, saturation: 0, hue: 0, temperature: 0 });
  });
  it('returns null when all values are back to zero', () => {
    const a = setAdjustValue(null, 'hue', 40);
    expect(setAdjustValue(a, 'hue', 0)).toBeNull();
  });
  it('keeps the others', () => {
    const a = setAdjustValue(setAdjustValue(null, 'contrast', 0.5), 'hue', 20);
    expect(a?.contrast).toBe(0.5);
    expect(a?.hue).toBe(20);
  });
  it('clamps, hue to 180 and the rest to 1', () => {
    expect(setAdjustValue(null, 'hue', 500)?.hue).toBe(180);
    expect(setAdjustValue(null, 'saturation', -5)?.saturation).toBe(-1);
    expect(setAdjustValue(null, 'temperature', Number.NaN)).toBeNull();
  });
});

describe('setBlurValue', () => {
  it('clamps shutter and samples', () => {
    expect(setBlurValue(null, 'shutter', 9).shutter).toBe(2);
    expect(setBlurValue(null, 'samples', 1).samples).toBe(2);
    expect(setBlurValue({ shutter: 1, samples: 8 }, 'samples', 12.6).samples).toBe(13);
  });
  it('starts from the defaults', () => {
    expect(setBlurValue(null, 'shutter', 1)).toEqual({ shutter: 1, samples: 8 });
  });
});

describe('setBlurStyle', () => {
  it('stores a kind and keeps the numbers', () => {
    expect(setBlurStyle({ shutter: 1, samples: 12 }, 'trail')).toEqual({ shutter: 1, samples: 12, style: 'trail' });
    expect(setBlurStyle(null, 'ghost')).toEqual({ shutter: 0.5, samples: 8, style: 'ghost' });
  });
  it('smooth removes the field', () => {
    const next = setBlurStyle({ shutter: 1, samples: 12, style: 'ghost' }, 'even');
    expect(next).toEqual({ shutter: 1, samples: 12 });
    expect('style' in next).toBe(false);
  });
  it('slider changes keep the kind', () => {
    expect(setBlurValue({ shutter: 1, samples: 12, style: 'trail' }, 'samples', 20)).toEqual({ shutter: 1, samples: 20, style: 'trail' });
  });
});
