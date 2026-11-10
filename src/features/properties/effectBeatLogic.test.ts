import { describe, expect, it } from 'vitest';
import { getEffect } from '../../engine/effects/registry';
import { DEFAULT_BEAT, EVERY_OPTIONS, FOLLOW_OFF, FOLLOW_UNDER, changedBeat, everyOptions, followPatch, followValue, lockTitle, lockedParam } from './effectBeatLogic';

describe('followValue / followPatch', () => {
  it('off, the sound under it, or a clip that still has a tempo', () => {
    expect(followValue(null, ['a'])).toBe(FOLLOW_OFF);
    expect(followValue(undefined, [])).toBe(FOLLOW_OFF);
    expect(followValue({ source: null }, ['a'])).toBe(FOLLOW_UNDER);
    expect(followValue({ source: 'a' }, ['a', 'b'])).toBe('a');
    // the clip lost its tempo or is gone: it follows the sound under it
    expect(followValue({ source: 'gone' }, ['a'])).toBe(FOLLOW_UNDER);
  });

  it('picking off removes the link, picking a source keeps the other settings', () => {
    expect(followPatch(DEFAULT_BEAT, FOLLOW_OFF)).toBeNull();
    const cur = { source: null, every: 4, pulse: 0.9, lock: true };
    expect(followPatch(cur, 'a')).toEqual({ ...cur, source: 'a' });
    expect(followPatch({ ...cur, source: 'a' }, FOLLOW_UNDER)).toEqual(cur);
    expect(followPatch(null, FOLLOW_UNDER)).toEqual(DEFAULT_BEAT);
  });

  it('a link that is turned on starts with a pulse, so something happens', () => {
    expect(DEFAULT_BEAT.pulse).toBeGreaterThan(0);
    expect(DEFAULT_BEAT.lock).toBe(false);
  });
});

describe('changedBeat / everyOptions', () => {
  it('changes one value', () => {
    expect(changedBeat({ source: 'a', every: 2, pulse: 0.5, lock: false }, { lock: true })).toEqual({ source: 'a', every: 2, pulse: 0.5, lock: true });
    expect(changedBeat(null, { pulse: 1 })).toEqual({ ...DEFAULT_BEAT, pulse: 1 });
  });

  it('the list has every cycle length of the brief and shows a stored odd one', () => {
    expect(EVERY_OPTIONS.map((o) => o[0])).toEqual(['0.25', '0.5', '1', '2', '4', '8', '16']);
    expect(everyOptions(4)).toBe(EVERY_OPTIONS);
    const odd = everyOptions(3);
    expect(odd.map((o) => o[0])).toEqual(['0.25', '0.5', '1', '2', '3', '4', '8', '16']);
  });
});

describe('lock', () => {
  it('only effects with sync get a title, and it names the param', () => {
    expect(lockTitle(getEffect('flash')!)).toContain('rate');
    expect(lockTitle(getEffect('swirl')!)).toContain('speed');
    expect(lockTitle(getEffect('blur')!)).toBeNull();
  });

  it('the param is taken over only with the lock on, a sync def and a tempo', () => {
    const flash = getEffect('flash');
    expect(lockedParam(flash, { lock: true }, true)).toBe('rate');
    expect(lockedParam(flash, { lock: true }, false)).toBeNull();
    expect(lockedParam(flash, { lock: false }, true)).toBeNull();
    expect(lockedParam(flash, null, true)).toBeNull();
    expect(lockedParam(getEffect('blur'), { lock: true }, true)).toBeNull();
    expect(lockedParam(undefined, { lock: true }, true)).toBeNull();
  });
});
