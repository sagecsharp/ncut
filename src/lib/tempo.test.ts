import { describe, expect, it } from 'vitest';
import { BPM_MAX, BPM_MIN, clipGrid, gridLines, nearestLine, parseBeatOffset, parseBpm, scaleBpm, settleBpm, shiftGrid, showBpm, tapBpm, timelineBpm } from './tempo';

describe('parseBpm / parseBeatOffset', () => {
  it('keeps a tempo inside the range, to two decimals', () => {
    expect(parseBpm(120)).toBe(120);
    expect(parseBpm(127.456)).toBe(127.456);
    expect(parseBpm(127.456789)).toBe(127.4568);
    expect(showBpm(127.456789)).toBe('127.46');
    expect(showBpm(120)).toBe('120');
    expect(parseBpm(BPM_MIN)).toBe(BPM_MIN);
    expect(parseBpm(BPM_MAX)).toBe(BPM_MAX);
  });

  it('anything else is no tempo', () => {
    for (const bad of [0, -5, 19.99, 400.01, NaN, Infinity, null, undefined, '120', {}]) expect(parseBpm(bad)).toBeNull();
  });

  it('offset: finite to the millisecond, else 0', () => {
    expect(parseBeatOffset(0.12345)).toBe(0.123);
    expect(parseBeatOffset(-0.5)).toBe(-0.5);
    expect(parseBeatOffset(1e9)).toBe(86400);
    for (const bad of [NaN, Infinity, null, undefined, '1']) expect(parseBeatOffset(bad)).toBe(0);
  });

  it('half and double time stay inside the range', () => {
    expect(scaleBpm(120, 0.5)).toBe(60);
    expect(scaleBpm(120, 2)).toBe(240);
    expect(scaleBpm(30, 0.5)).toBeNull();
    expect(scaleBpm(250, 2)).toBeNull();
  });
});

describe('settleBpm', () => {
  it('a result the detector cannot tell from a whole number is that number', () => {
    // 30 s at 50 peaks a second resolves about 0.12 bpm at 120
    expect(settleBpm(120.03, 30, 50)).toBe(120);
    expect(settleBpm(119.9, 30, 50)).toBe(120);
    expect(settleBpm(120.3, 30, 50)).toBe(120.3);
  });

  it('a long sound is trusted more', () => {
    expect(settleBpm(120.1, 240, 50)).toBe(120.1);
    expect(settleBpm(120.015, 240, 50)).toBe(120);
    expect(settleBpm(93.5, 240, 50)).toBe(93.5);
  });

  it('never more than 0.15 off, never out of range', () => {
    expect(settleBpm(120.2, 2, 50)).toBe(120.2);
    expect(settleBpm(120.14, 2, 50)).toBe(120);
    expect(settleBpm(19.9, 30, 50)).toBeNull();
    expect(settleBpm(NaN, 30, 50)).toBeNull();
    expect(settleBpm(120.01, 0, 0)).toBe(120);
  });
});

describe('clipGrid', () => {
  it('no tempo, no grid', () => {
    expect(clipGrid({ start: 0, trimStart: 0, speed: 1 })).toBeNull();
    expect(clipGrid({ start: 0, trimStart: 0, speed: 1, bpm: null })).toBeNull();
    expect(clipGrid({ start: 0, trimStart: 0, speed: 1, bpm: 5 })).toBeNull();
  });

  it('follows the start, the trim and the offset', () => {
    expect(clipGrid({ start: 0, trimStart: 0, speed: 1, bpm: 120 })).toEqual({ origin: 0, step: 0.5 });
    // the beat at source second 0.2 plays 0.2 s after the clip starts
    expect(clipGrid({ start: 10, trimStart: 0, speed: 1, bpm: 120, beatOffset: 0.2 })).toEqual({ origin: 10.2, step: 0.5 });
    // trimmed 1 s in: that beat is now 0.8 s before the clip starts, the grid runs on from there
    const g = clipGrid({ start: 10, trimStart: 1, speed: 1, bpm: 120, beatOffset: 0.2 })!;
    expect(g.origin).toBeCloseTo(9.2, 9);
    expect(gridLines(g, 10, 11).map((l) => +l.time.toFixed(6))).toEqual([10.2, 10.7]);
  });

  it('a faster clip has its beats closer', () => {
    const g = clipGrid({ start: 4, trimStart: 2, speed: 2, bpm: 100, beatOffset: 3 })!;
    expect(g.step).toBeCloseTo(0.3, 9);
    expect(g.origin).toBeCloseTo(4.5, 9);
    expect(timelineBpm({ start: 4, trimStart: 2, speed: 2, bpm: 100 })).toBe(200);
    expect(timelineBpm({ start: 0, trimStart: 0, speed: 1 })).toBeNull();
  });

  it('survives a broken speed or start', () => {
    expect(clipGrid({ start: NaN, trimStart: NaN, speed: 0, bpm: 60 })).toEqual({ origin: 0, step: 1 });
  });

  it('shiftGrid sees the grid from a clip', () => {
    expect(shiftGrid({ origin: 10.2, step: 0.5 }, 9)).toEqual({ origin: 10.2 - 9, step: 0.5 });
  });
});

describe('nearestLine / gridLines', () => {
  const g = { origin: 1, step: 0.5 };

  it('the nearest beat, also before the origin', () => {
    expect(nearestLine(g, 1.2)).toBe(1);
    expect(nearestLine(g, 1.3)).toBe(1.5);
    expect(nearestLine(g, 0.1)).toBe(0);
    expect(nearestLine(g, -0.8)).toBe(-1);
  });

  it('half and quarter beats', () => {
    expect(nearestLine(g, 1.3, 2)).toBe(1.25);
    expect(nearestLine(g, 1.3, 4)).toBeCloseTo(1.25, 9);
    expect(nearestLine(g, 1.33, 4)).toBeCloseTo(1.375, 9);
    // a broken division counts as whole beats
    expect(nearestLine(g, 1.3, 0)).toBe(1.5);
  });

  it('lists the beats of a range with their number', () => {
    expect(gridLines(g, 0, 2)).toEqual([
      { time: 0, index: -2 },
      { time: 0.5, index: -1 },
      { time: 1, index: 0 },
      { time: 1.5, index: 1 },
      { time: 2, index: 2 },
    ]);
    expect(gridLines(g, 1.01, 1.49)).toEqual([]);
  });

  it('stops at max and on bad input', () => {
    expect(gridLines(g, 0, 1000, 10).length).toBe(10);
    expect(gridLines({ origin: 0, step: 0 }, 0, 10)).toEqual([]);
    expect(gridLines({ origin: 0, step: NaN }, 0, 10)).toEqual([]);
    expect(gridLines(g, 5, 4)).toEqual([]);
  });
});

describe('tapBpm', () => {
  it('needs three taps', () => {
    expect(tapBpm([])).toBeNull();
    expect(tapBpm([0])).toBeNull();
    expect(tapBpm([0, 500])).toBeNull();
    expect(tapBpm([0, 500, 1000])).toBe(120);
  });

  it('averages uneven taps to a whole number', () => {
    expect(tapBpm([0, 490, 1010, 1500, 1995])).toBe(120);
    expect(tapBpm([0, 666, 1333, 2000])).toBe(90);
  });

  it('a long pause starts a new run', () => {
    expect(tapBpm([0, 500, 1000, 9000, 9400])).toBeNull();
    expect(tapBpm([0, 500, 1000, 9000, 9400, 9800])).toBe(150);
  });

  it('only the last taps count', () => {
    const slow = [0, 1000, 2000, 3000];
    const fast = Array.from({ length: 9 }, (_, i) => 3000 + (i + 1) * 500);
    expect(tapBpm([...slow, ...fast])).toBe(120);
  });

  it('out of range or the same moment twice is nothing', () => {
    expect(tapBpm([0, 50, 100])).toBeNull();
    expect(tapBpm([0, 0, 0])).toBeNull();
  });
});
