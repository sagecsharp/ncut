import { describe, expect, it } from 'vitest';
import { frameFileName, nudgeDelta } from './nudge';

describe('nudgeDelta', () => {
  it('moves 1 px, or 10 with shift', () => {
    expect(nudgeDelta('ArrowLeft', false)).toEqual([-1, 0]);
    expect(nudgeDelta('ArrowRight', true)).toEqual([10, 0]);
    expect(nudgeDelta('ArrowUp', false)).toEqual([0, -1]);
    expect(nudgeDelta('ArrowDown', true)).toEqual([0, 10]);
  });
  it('ignores other keys', () => {
    expect(nudgeDelta('a', false)).toBeNull();
    expect(nudgeDelta('Enter', true)).toBeNull();
  });
});

describe('frameFileName', () => {
  it('has no colons and ends in png', () => {
    const n = frameFileName('my: movie?', 61.5, 30);
    expect(n).toBe('my movie-01-01-15.png');
    expect(n).not.toContain(':');
  });
  it('falls back to a name for an empty project name', () => {
    expect(frameFileName('', 0, 24)).toBe('ncut-00-00-00.png');
  });
});
