import { describe, expect, it } from 'vitest';
import { frameFileName, movableClipsAt, nudgeDelta } from './nudge';
import type { Project } from '../../types';

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

describe('movableClipsAt', () => {
  const clip = (id: string, trackId: string, start: number, duration: number, type = 'shape') => ({ id, trackId, start, duration, type });
  const project = {
    tracks: [
      { id: 'a', kind: 'video', locked: false, hidden: false },
      { id: 'b', kind: 'video', locked: true, hidden: false },
      { id: 'c', kind: 'video', locked: false, hidden: true },
    ],
    clips: [clip('on', 'a', 0, 5), clip('later', 'a', 10, 5), clip('locked', 'b', 0, 5), clip('hidden', 'c', 0, 5), clip('cam', 'a', 5, 5, 'camera')],
  } as unknown as Project;
  const all = ['on', 'later', 'locked', 'hidden', 'cam'];

  it('only returns clips that are on screen at the time', () => {
    expect(movableClipsAt(project, all, 2).map((c) => c.id)).toEqual(['on']);
    expect(movableClipsAt(project, all, 12).map((c) => c.id)).toEqual(['later']);
  });
  it('is half open and ignores unselected clips', () => {
    expect(movableClipsAt(project, ['on'], 5)).toEqual([]);
    expect(movableClipsAt(project, [], 2)).toEqual([]);
  });
});
