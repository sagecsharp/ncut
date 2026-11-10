import { describe, expect, it } from 'vitest';
import type { Clip, Track } from '../../types';
import { planInsertGap } from './gapInsert';

const track = (id: string, locked = false) => ({ id, kind: 'video', locked }) as unknown as Track;
const clip = (id: string, trackId: string, start: number, duration = 1) => ({ id, type: 'video', trackId, start, duration }) as unknown as Clip;

describe('insert gap', () => {
  const tracks = [track('a'), track('b'), track('c', true)];
  const clips = [clip('1', 'a', 0, 5), clip('2', 'a', 5), clip('3', 'b', 6), clip('4', 'c', 8), clip('5', 'b', 2)];
  it('pushes clips that start at or after the time, on unlocked tracks', () => {
    expect(planInsertGap(clips, tracks, 5)).toEqual([
      { id: '2', trackId: 'a', start: 6 },
      { id: '3', trackId: 'b', start: 7 },
    ]);
  });
  it('leaves a clip that spans the time alone', () => {
    expect(planInsertGap(clips, tracks, 3).map((x) => x.id)).toEqual(['2', '3']);
  });
  it('can be limited to one track and to another size', () => {
    expect(planInsertGap(clips, tracks, 0, 2, 'b')).toEqual([
      { id: '3', trackId: 'b', start: 8 },
      { id: '5', trackId: 'b', start: 4 },
    ]);
  });
  it('does nothing for a locked track, a bad size or nothing after', () => {
    expect(planInsertGap(clips, tracks, 0, 1, 'c')).toEqual([]);
    expect(planInsertGap(clips, tracks, 0, 0)).toEqual([]);
    expect(planInsertGap(clips, tracks, 100)).toEqual([]);
  });
});
