import { describe, expect, it } from 'vitest';
import { headToggles } from './headToggles';
import type { HeadState } from './headToggles';

const base: HeadState = { video: true, target: true, muted: false, solo: false, hidden: false, locked: false, syncOff: false };
const st = (p: Partial<HeadState>): HeadState => ({ ...base, ...p });

describe('head toggles', () => {
  it('full: every toggle in order', () => {
    expect(headToggles(base, false)).toEqual(['target', 'mute', 'solo', 'hide', 'lock', 'sync']);
    expect(headToggles(st({ target: false }), false)).toEqual(['mute', 'solo', 'hide', 'lock', 'sync']);
    expect(headToggles(st({ video: false }), false)).toEqual(['target', 'mute', 'solo', 'lock', 'sync']);
  });

  it('compact: three at most, lit first', () => {
    expect(headToggles(base, true)).toEqual(['target', 'mute', 'lock']);
    expect(headToggles(st({ video: false, target: false, syncOff: true }), true)).toEqual(['mute', 'lock', 'sync']);
    expect(headToggles(st({ muted: true, hidden: true, locked: true, syncOff: true }), true)).toEqual(['mute', 'hide', 'lock']);
  });

  it('room is a limit', () => {
    expect(headToggles(base, true, 1)).toEqual(['target']);
    expect(headToggles(st({ locked: true }), true, 1)).toEqual(['lock']);
    expect(headToggles(base, true, 0)).toEqual([]);
  });
});
