import { describe, expect, it } from 'vitest';
import { deltaText, multiValue, sharedShown } from './multiEdit';

describe('multiEdit', () => {
  it('add moves every start by the same amount in stored units', () => {
    // opacity shows percent (scale 100): 50% -> 70% adds 0.2 to every clip
    const starts = [0.2, 0.5, 1];
    const out = starts.map((s) => multiValue('add', s, 50, 70, 100));
    out.forEach((v, i) => expect(v - starts[i]!).toBeCloseTo(0.2, 9));
    // position has scale 1
    expect(multiValue('add', -200, 0, 50, 1)).toBe(-150);
  });
  it('times scales every start by the same factor', () => {
    expect(multiValue('times', 0.5, 100, 120, 100)).toBeCloseTo(0.6, 9);
    expect(multiValue('times', 1, 100, 120, 100)).toBeCloseTo(1.2, 9);
    expect(multiValue('times', 2, 100, 50, 100)).toBeCloseTo(1, 9);
  });
  it('times from 0 falls back to add', () => {
    expect(multiValue('times', 1, 0, 50, 100)).toBeCloseTo(1.5, 9);
    expect(multiValue('times', 1, -10, 10, 100)).toBeCloseTo(1.2, 9);
  });
  it('back to the start gives the start values', () => {
    expect(multiValue('add', 12.5, 40, 40, 100)).toBe(12.5);
    expect(multiValue('times', 0.7, 100, 100, 100)).toBe(0.7);
  });
  it('sharedShown: the same shown text is shared, a different one is mixed, none is mixed', () => {
    expect(sharedShown([50, 50, 50], 0)).toBe(50);
    expect(sharedShown([50, 50.0004], 0)).toBe(50);
    expect(sharedShown([50, 51], 0)).toBeNull();
    expect(sharedShown([1.5, 1.52], 1)).toBeNull();
    expect(sharedShown([], 0)).toBeNull();
  });
  it('deltaText signs and units', () => {
    expect(deltaText('add', 0, 12, 0, 'px')).toBe('+12 px');
    expect(deltaText('add', 10, 5.5, 1, 'deg')).toBe('-4.5 deg');
    expect(deltaText('add', 40, 40, 0, '%')).toBe('+0%');
    expect(deltaText('times', 100, 125, 0, '%')).toBe('x1.25');
    expect(deltaText('times', 100, 100, 0, '%')).toBe('x1');
  });
});
