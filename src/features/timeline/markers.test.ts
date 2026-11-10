import { describe, expect, it } from 'vitest';
import type { Marker } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import type { Clip } from '../../types';
import {
  FLAG_H,
  MAX_FLAG_W,
  flagLabel,
  flagWidth,
  hitMarker,
  lowerBound,
  markerTimes,
  timelineSnapPoints,
  visibleMarkerRange,
} from './markers';
import { rangeOf, zoomForRange } from './zoomMath';

const mk = (id: string, time: number, name = ''): Marker => ({ id, time, name });
const list = [mk('a', 1), mk('b', 5, 'intro'), mk('c', 10), mk('d', 50, 'end')];

describe('flag geometry', () => {
  it('cuts long names and keeps short ones', () => {
    expect(flagLabel('  hi ')).toBe('hi');
    expect(flagLabel('x'.repeat(40)).length).toBe(16);
    expect(flagLabel('x'.repeat(40)).endsWith('\u2026')).toBe(true);
  });
  it('unnamed markers get a bare flag, named ones grow with the label', () => {
    expect(flagWidth('')).toBeLessThan(flagWidth('a'));
    expect(flagWidth('abc')).toBeLessThan(flagWidth('abcdef'));
    expect(flagWidth('x'.repeat(100))).toBe(MAX_FLAG_W);
  });
});

describe('culling', () => {
  it('lowerBound finds the first marker at or after a time', () => {
    expect(lowerBound(list, 0)).toBe(0);
    expect(lowerBound(list, 5)).toBe(1);
    expect(lowerBound(list, 5.1)).toBe(2);
    expect(lowerBound(list, 99)).toBe(4);
  });
  it('returns only markers that can touch the viewport', () => {
    // zoom 10 px/s, view shows 40s..60s -> x 400..600
    const r = visibleMarkerRange(list, 10, 400, 200);
    expect(list.slice(r.from, r.to).map((m) => m.id)).toEqual(['d']);
  });
  it('keeps a marker whose flag still reaches into the view from the left', () => {
    const r = visibleMarkerRange(list, 10, 510, 100); // pole at x 500, flag runs to ~526
    expect(list.slice(r.from, r.to).map((m) => m.id)).toContain('d');
  });
  it('is empty for no markers', () => {
    expect(visibleMarkerRange([], 10, 0, 100)).toEqual({ from: 0, to: 0 });
  });
});

describe('hit testing', () => {
  it('hits the pole anywhere along the ruler', () => {
    expect(hitMarker(list, 10, 10, 20)?.id).toBe('a');
    expect(hitMarker(list, 10, 12, 20)?.id).toBe('a');
    expect(hitMarker(list, 10, 16, 20)).toBeNull();
  });
  it('hits the flag only in the flag zone', () => {
    // marker b at x 50, named: flag spans right of the pole
    expect(hitMarker(list, 10, 50 + 20, FLAG_H - 1)?.id).toBe('b');
    expect(hitMarker(list, 10, 50 + 20, FLAG_H + 5)).toBeNull();
  });
  it('misses empty space', () => {
    expect(hitMarker(list, 10, 300, 5)).toBeNull();
  });
  it('the later marker wins when flags overlap', () => {
    const close = [mk('p', 1, 'aaaaaa'), mk('q', 1.1, 'bbbbbb')];
    expect(hitMarker(close, 10, 10 + 8, 5)?.id).toBe('q');
  });
});

describe('snap points', () => {
  const clip = {
    id: 'c1',
    type: 'image',
    trackId: 't',
    start: 2,
    duration: 3,
    name: 'i',
    fadeIn: 0,
    fadeOut: 0,
    assetId: 'a',
    transform: { ...DEFAULT_TRANSFORM },
  } as Clip;
  it('merges markers with clip edges, sorted and unique', () => {
    const pts = timelineSnapPoints({ clips: [clip], markers: [mk('m', 5), mk('n', 7)] }, [], [3]);
    expect(pts).toEqual([0, 2, 3, 5, 7]);
  });
  it('skips the marker being dragged and ignored clips', () => {
    const pts = timelineSnapPoints({ clips: [clip], markers: [mk('m', 5), mk('n', 7)] }, ['c1'], [], 'm');
    expect(pts).toEqual([0, 7]);
  });
  it('works without markers', () => {
    expect(timelineSnapPoints({ clips: [clip] })).toEqual([0, 2, 5]);
    expect(markerTimes(undefined)).toEqual([]);
  });
});

describe('zoom math', () => {
  it('fits a range with padding', () => {
    expect(zoomForRange(0, 10, 548)).toBeCloseTo(50);
  });
  it('widens tiny ranges', () => {
    expect(zoomForRange(3, 3, 548)).toBeCloseTo(1000);
  });
  it('rangeOf spans all items', () => {
    expect(rangeOf([])).toBeNull();
    expect(rangeOf([{ start: 4, duration: 2 }, { start: 1, duration: 1 }])).toEqual({ start: 1, end: 6 });
  });
});
