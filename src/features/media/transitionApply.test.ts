import { describe, expect, it } from 'vitest';
import { DEFAULT_TRANSITION_DURATION } from '../../engine/transitions/registry';
import { transitionFor } from './transitionApply';

describe('transitionFor', () => {
  it('keeps the length of an existing transition', () => {
    expect(transitionFor('fade', { id: 'wipe', duration: 1.7 })).toEqual({ id: 'fade', duration: 1.7 });
  });
  it('uses the default length otherwise', () => {
    expect(transitionFor('fade', null).duration).toBe(DEFAULT_TRANSITION_DURATION);
    expect(transitionFor('fade', undefined).duration).toBe(DEFAULT_TRANSITION_DURATION);
  });
});
