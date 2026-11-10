import { describe, expect, it } from 'vitest';
import { DEFAULT_TRANSITION_DURATION, MAX_TRANSITION_DURATION, MIN_TRANSITION_DURATION } from '../../engine/transitions/registry';
import { clampToCut, cutLimit, parseLastTransition, transitionFor } from './transitionApply';

describe('transitionFor', () => {
  it('keeps the length of an existing transition', () => {
    expect(transitionFor('fade', { id: 'wipe', duration: 1.7 })).toEqual({ id: 'fade', duration: 1.7 });
  });
  it('uses the default length otherwise', () => {
    expect(transitionFor('fade', null).duration).toBe(DEFAULT_TRANSITION_DURATION);
    expect(transitionFor('fade', undefined).duration).toBe(DEFAULT_TRANSITION_DURATION);
  });
});

describe('cut limits', () => {
  const clip = (duration: number) => ({ duration }) as never;
  it('limit is the shorter clip, and the clip alone without a neighbour', () => {
    expect(cutLimit(clip(3), clip(2))).toBe(2);
    expect(cutLimit(clip(3), null)).toBe(3);
    expect(cutLimit(clip(99), clip(99))).toBe(MAX_TRANSITION_DURATION);
  });
  it('clampToCut stays inside the range and the limit', () => {
    expect(clampToCut(9)).toBe(MAX_TRANSITION_DURATION);
    expect(clampToCut(0.01)).toBe(MIN_TRANSITION_DURATION);
    expect(clampToCut(2, 0.7)).toBe(0.7);
  });
  it('transitionFor clamps when given a limit', () => {
    expect(transitionFor('fade', { id: 'x', duration: 3 }, 1).duration).toBe(1);
  });
  it('parseLastTransition falls back on garbage', () => {
    expect(parseLastTransition(null)).toEqual({ id: 'cross-fade', duration: DEFAULT_TRANSITION_DURATION });
    expect(parseLastTransition('nope').id).toBe('cross-fade');
    expect(parseLastTransition('{"id":"wipe-left","duration":1.5}')).toEqual({ id: 'wipe-left', duration: 1.5 });
    expect(parseLastTransition('{"id":"gone","duration":99}')).toEqual({ id: 'cross-fade', duration: MAX_TRANSITION_DURATION });
  });
});
