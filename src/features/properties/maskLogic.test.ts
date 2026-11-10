import { describe, expect, it } from 'vitest';
import { DEFAULT_MASK } from '../../engine/mask';
import { MASK_SHAPES } from '../../types';
import { MASK_SHAPE_LABELS, maskFields, maskUiValue, newMask, setMaskShape, setMaskValue } from './maskLogic';

describe('mask ui mapping', () => {
  it('labels every shape once', () => {
    expect(MASK_SHAPE_LABELS.map(([s]) => s).sort()).toEqual([...MASK_SHAPES].sort());
  });
  it('maps percents to fractions and back', () => {
    const m = setMaskValue(newMask(), 'width', 150);
    expect(m.width).toBe(1.5);
    expect(maskUiValue(m, 'width')).toBe(150);
    expect(setMaskValue(m, 'x', -50).x).toBe(-0.5);
    expect(setMaskValue(m, 'feather', 25).feather).toBe(0.25);
  });
  it('keeps degrees as they are', () => {
    const m = setMaskValue(newMask(), 'rotation', 45.5);
    expect(m.rotation).toBe(45.5);
    expect(maskUiValue(m, 'rotation')).toBe(45.5);
  });
  it('clamps to the ui range and ignores junk', () => {
    expect(setMaskValue(newMask(), 'width', 999).width).toBe(2);
    expect(setMaskValue(newMask(), 'x', -999).x).toBe(-1);
    expect(setMaskValue(newMask(), 'rotation', 400).rotation).toBe(180);
    expect(setMaskValue(newMask(), 'feather', Number.NaN).feather).toBe(0);
  });
  it('stores radius only above 0', () => {
    const m = setMaskValue({ ...newMask(), shape: 'rect' }, 'radius', 30);
    expect(m.radius).toBe(0.3);
    expect('radius' in setMaskValue(m, 'radius', 0)).toBe(false);
    expect(maskUiValue(newMask(), 'radius')).toBe(0);
  });
  it('does not touch the input or the default', () => {
    const before = { ...DEFAULT_MASK };
    const m = newMask();
    setMaskValue(m, 'width', 10);
    expect(m).toEqual(before);
    expect(newMask()).not.toBe(DEFAULT_MASK);
  });
  it('drops the radius when leaving the box', () => {
    const rect = { ...newMask(), shape: 'rect' as const, radius: 0.4 };
    expect(setMaskShape(rect, 'rect').radius).toBe(0.4);
    const star = setMaskShape(rect, 'star');
    expect(star.shape).toBe('star');
    expect('radius' in star).toBe(false);
  });
  it('knows which controls a shape uses', () => {
    expect(maskFields('split')).toEqual({ width: false, height: false, radius: false });
    expect(maskFields('band')).toEqual({ width: false, height: true, radius: false });
    expect(maskFields('rect').radius).toBe(true);
    expect(maskFields('heart')).toEqual({ width: true, height: true, radius: false });
  });
});
