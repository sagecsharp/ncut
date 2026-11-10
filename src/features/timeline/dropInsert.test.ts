import { describe, expect, it } from 'vitest';
import type { Clip, Track } from '../../types';
import { planDropInsert } from './dropInsert';

const track = (id: string, locked = false) => ({ id, kind: 'video', locked }) as unknown as Track;
const clip = (id: string, trackId: string, start: number, duration = 2) => ({ id, type: 'video', trackId, start, duration }) as unknown as Clip;
const fx = (id: string, trackId: string, target: string, start: number, duration = 2) =>
  ({ id, type: 'effect', trackId, start, duration, target }) as unknown as Clip;
const tracks = [track('a'), track('b'), track('l', true)];
const P = (clips: Clip[]) => ({ clips, tracks });

describe('drop inbetween', () => {
  it('free space that fits: nothing moves', () => {
    const r = planDropInsert(P([clip('1', 'a', 0), clip('2', 'a', 10)]), 'a', 4, 3);
    expect(r).toEqual({ start: 4, shift: 0, moves: [], insert: false });
  });
  it('inside a clip, left half goes to its start', () => {
    const r = planDropInsert(P([clip('1', 'a', 0), clip('2', 'a', 2)]), 'a', 2.5, 1)!;
    expect(r.start).toBe(2);
    expect(r.shift).toBe(1);
    expect(r.moves).toEqual([{ id: '2', trackId: 'a', start: 3 }]);
    expect(r.insert).toBe(true);
  });
  it('inside a clip, right half goes to its end', () => {
    const r = planDropInsert(P([clip('1', 'a', 0), clip('2', 'a', 2), clip('3', 'a', 4)]), 'a', 3.5, 1)!;
    expect(r.start).toBe(4);
    expect(r.moves).toEqual([{ id: '3', trackId: 'a', start: 5 }]);
  });
  it('between two touching clips', () => {
    const r = planDropInsert(P([clip('1', 'a', 0), clip('2', 'a', 2)]), 'a', 2, 1.5)!;
    expect(r.start).toBe(2);
    expect(r.shift).toBe(1.5);
  });
  it('a free gap that is too small: the shift is the overflow, spacing stays', () => {
    const r = planDropInsert(P([clip('1', 'a', 0), clip('2', 'a', 3), clip('3', 'a', 7)]), 'a', 2, 2)!;
    expect(r.start).toBe(2);
    expect(r.shift).toBe(1);
    expect(r.moves).toEqual([
      { id: '2', trackId: 'a', start: 4 },
      { id: '3', trackId: 'a', start: 8 },
    ]);
  });
  it('other tracks stay', () => {
    const r = planDropInsert(P([clip('1', 'a', 0), clip('2', 'b', 2)]), 'a', 0.2, 1)!;
    expect(r.moves.map((m) => m.id)).toEqual(['1']);
  });
  it('an effect on a moved clip moves with it', () => {
    const r = planDropInsert(P([clip('1', 'a', 0), clip('2', 'a', 2), fx('e', 'b', '2', 2)]), 'a', 2, 1)!;
    expect(r.moves).toContainEqual({ id: 'e', trackId: 'b', start: 3 });
  });
  it('effect clips on an effect track are moved like others', () => {
    const r = planDropInsert(P([fx('e1', 'b', 'x', 0), fx('e2', 'b', 'x', 2)]), 'b', 2.2, 1)!;
    expect(r.start).toBe(2);
    expect(r.moves).toEqual([{ id: 'e2', trackId: 'b', start: 3 }]);
  });
  it('locked or unknown track gives nothing', () => {
    expect(planDropInsert(P([clip('1', 'l', 0)]), 'l', 0, 1)).toBeNull();
    expect(planDropInsert(P([]), 'zz', 0, 1)).toBeNull();
  });
  it('time 0 on a clip that starts there', () => {
    const r = planDropInsert(P([clip('1', 'a', 0)]), 'a', 0, 1)!;
    expect(r.start).toBe(0);
    expect(r.moves).toEqual([{ id: '1', trackId: 'a', start: 1 }]);
  });
  it('after the last clip: nothing to move', () => {
    const r = planDropInsert(P([clip('1', 'a', 0)]), 'a', 1.5, 3)!;
    expect(r).toEqual({ start: 2, shift: 0, moves: [], insert: true });
  });
});
