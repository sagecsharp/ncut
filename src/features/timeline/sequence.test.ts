import { describe, expect, it } from 'vitest';
import { markersInside, orderForRow, planFit, planRow } from './sequence';
import type { SeqClip } from './sequence';

const MIN = 0.05;
const still = (id: string, start: number, duration: number): SeqClip => ({ id, start, duration, maxDuration: Infinity });
const media = (id: string, start: number, duration: number, maxDuration: number): SeqClip => ({ id, start, duration, maxDuration });

describe('orderForRow', () => {
  it('sorts by start then by layer', () => {
    const o = orderForRow([
      { id: 'a', start: 2, layer: 0 },
      { id: 'b', start: 1, layer: 2 },
      { id: 'c', start: 1, layer: 0 },
    ]);
    expect(o.map((x) => x.id)).toEqual(['c', 'b', 'a']);
  });
});

describe('planRow', () => {
  it('lays clips end to end from the earliest start', () => {
    const p = planRow([still('a', 3, 2), still('b', 4, 1), still('c', 10, 0.5)]);
    expect(p).toEqual([
      { id: 'a', start: 3, duration: 2 },
      { id: 'b', start: 5, duration: 1 },
      { id: 'c', start: 6, duration: 0.5 },
    ]);
  });
  it('is empty for no clips', () => {
    expect(planRow([])).toEqual([]);
  });
});

describe('planFit', () => {
  it('fits clips to every marker', () => {
    const r = planFit([still('a', 0, 5), still('b', 1, 5)], [0, 1, 2, 3], 1, MIN);
    expect(r.places).toEqual([
      { id: 'a', start: 0, duration: 1 },
      { id: 'b', start: 1, duration: 1 },
    ]);
    expect(r.short).toBe(0);
    expect(r.onMarkers).toBe(2);
  });
  it('with no markers the clips just follow end to end', () => {
    const r = planFit([still('a', 2, 1), still('b', 4, 3)], [], 1, MIN);
    expect(r.places).toEqual([
      { id: 'a', start: 2, duration: 1 },
      { id: 'b', start: 3, duration: 3 },
    ]);
    expect(r.onMarkers).toBe(0);
  });
  it('starts on the first marker at or after the earliest clip', () => {
    const r = planFit([still('a', 1.5, 1)], [0, 1, 2, 3], 1, MIN);
    expect(r.places[0]).toEqual({ id: 'a', start: 2, duration: 1 });
    const at = planFit([still('a', 1, 1)], [0, 1, 2], 1, MIN);
    expect(at.places[0]).toEqual({ id: 'a', start: 1, duration: 1 });
  });
  it('the rest keep their length when the markers run out', () => {
    const r = planFit([still('a', 0, 4), still('b', 0, 4), still('c', 0, 2), still('d', 0, 1)], [0, 1, 2], 1, MIN);
    expect(r.places).toEqual([
      { id: 'a', start: 0, duration: 1 },
      { id: 'b', start: 1, duration: 1 },
      // starts on the last marker, no marker to end on: keeps its length
      { id: 'c', start: 2, duration: 2 },
      { id: 'd', start: 4, duration: 1 },
    ]);
  });
  it('no markers after the clips: all follow', () => {
    const r = planFit([still('a', 5, 1), still('b', 5, 2)], [0, 1], 1, MIN);
    expect(r.places).toEqual([
      { id: 'a', start: 5, duration: 1 },
      { id: 'b', start: 6, duration: 2 },
    ]);
    expect(r.onMarkers).toBe(0);
  });
  it('skips to the next marker when the gap is shorter than the minimum', () => {
    const r = planFit([still('a', 0, 5), still('b', 0, 5)], [0, 0.01, 1, 2], 1, MIN);
    expect(r.places).toEqual([
      { id: 'a', start: 0, duration: 1 },
      { id: 'b', start: 1, duration: 1 },
    ]);
    const s = planFit([still('a', 0, 5), still('b', 0, 5)], [0, 1, 1.02, 3], 1, MIN);
    expect(s.places[0]).toEqual({ id: 'a', start: 0, duration: 1 });
    expect(s.places[1]).toEqual({ id: 'b', start: 1, duration: 2 });
  });
  it('spans 2 and 4 markers', () => {
    const marks = [0, 1, 2, 3, 4, 5, 6, 7, 8];
    const two = planFit([still('a', 0, 9), still('b', 0, 9)], marks, 2, MIN);
    expect(two.places).toEqual([
      { id: 'a', start: 0, duration: 2 },
      { id: 'b', start: 2, duration: 2 },
    ]);
    const four = planFit([still('a', 0, 9), still('b', 0, 9), still('c', 0, 9)], marks, 4, MIN);
    expect(four.places).toEqual([
      { id: 'a', start: 0, duration: 4 },
      { id: 'b', start: 4, duration: 4 },
      { id: 'c', start: 8, duration: 9 },
    ]);
  });
  it('a clip shorter than its beat keeps its length and the next one still starts on its marker', () => {
    const r = planFit([media('a', 0, 0.5, 0.5), media('b', 0, 3, 3)], [0, 1, 2, 3], 1, MIN);
    expect(r.places).toEqual([
      { id: 'a', start: 0, duration: 0.5 },
      { id: 'b', start: 1, duration: 1 },
    ]);
    expect(r.short).toBe(1);
  });
  it('a clip with more source than the beat is trimmed, one with enough source is stretched to it', () => {
    const r = planFit([media('a', 0, 4, 10), media('b', 0, 0.5, 3)], [0, 2, 4], 1, MIN);
    expect(r.places[0]).toEqual({ id: 'a', start: 0, duration: 2 });
    expect(r.places[1]).toEqual({ id: 'b', start: 2, duration: 2 });
    expect(r.short).toBe(0);
  });
  it('one marker only: the clip starts on it and keeps its length', () => {
    const r = planFit([still('a', 0, 2)], [1], 1, MIN);
    expect(r.places).toEqual([{ id: 'a', start: 1, duration: 2 }]);
  });
  it('ignores duplicate and unsorted markers', () => {
    const r = planFit([still('a', 0, 5), still('b', 0, 5)], [2, 0, 1, 1, 0], 1, MIN);
    expect(r.places).toEqual([
      { id: 'a', start: 0, duration: 1 },
      { id: 'b', start: 1, duration: 1 },
    ]);
  });
  it('never overlaps', () => {
    const clips = [still('a', 0, 1), media('b', 0, 1, 0.3), still('c', 0, 7), still('d', 0, 2)];
    const r = planFit(clips, [0, 0.5, 0.52, 1.7, 3, 3.01, 4], 1, MIN);
    for (let i = 1; i < r.places.length; i++) {
      const prev = r.places[i - 1]!;
      expect(r.places[i]!.start).toBeGreaterThanOrEqual(prev.start + prev.duration - 1e-9);
    }
  });
});

describe('markersInside', () => {
  it('keeps the markers away from the edges', () => {
    expect(markersInside([0, 1, 2, 3, 4], 1, 3, 0.05)).toEqual([2]);
    expect(markersInside([1.02, 2, 2.98], 1, 3, 0.05)).toEqual([2]);
  });
  it('sorts and dedupes', () => {
    expect(markersInside([3, 2, 2, 1.5], 0, 10, 0.05)).toEqual([1.5, 2, 3]);
  });
});
