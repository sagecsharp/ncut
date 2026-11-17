import { describe, expect, it } from 'vitest';
import type { Track } from '../../types';
import { dropLabel, reorderTarget } from './trackOrder';

const tracks: Pick<Track, 'id' | 'kind'>[] = [
  { id: 'v1', kind: 'video' },
  { id: 'v2', kind: 'video' },
  { id: 'v3', kind: 'video' },
  { id: 'a1', kind: 'audio' },
  { id: 'a2', kind: 'audio' },
];
const heights = [56, 28, 96, 48, 72];
const tops: number[] = [];
heights.reduce((y, h) => (tops.push(y), y + h), 14);
const layout = { tops, heights };
const total = 14 + heights.reduce((a, b) => a + b, 0);

describe('track order', () => {
  it('stays inside its kind', () => {
    for (let from = 0; from < tracks.length; from++) {
      for (let y = -20; y < total + 20; y += 3) {
        const t = reorderTarget(tracks, layout, from, y);
        if (!t) continue;
        const kind = tracks[from]!.kind;
        expect(tracks[t.to]!.kind).toBe(kind);
        expect(tracks.find((x) => x.id === t.anchorId)!.kind).toBe(kind);
        expect(t.anchorId).not.toBe(tracks[from]!.id);
      }
    }
  });

  it('null at its own place', () => {
    // v1 with the pointer on its own row: nothing above its middle but nobody else is above it either
    expect(reorderTarget(tracks, layout, 0, tops[0]! + 10)).toBeNull();
    // a kind of one
    const one = [{ id: 'v1', kind: 'video' as const }, { id: 'a1', kind: 'audio' as const }];
    expect(reorderTarget(one, { tops: [14, 70], heights: [56, 48] }, 0, 500)).toBeNull();
    expect(reorderTarget(one, { tops: [14, 70], heights: [56, 48] }, 1, 0)).toBeNull();
  });

  it('to matches a real splice', () => {
    for (let from = 0; from < tracks.length; from++) {
      for (let y = -20; y < total + 20; y += 2) {
        const t = reorderTarget(tracks, layout, from, y);
        if (!t) continue;
        const next = [...tracks];
        const [me] = next.splice(from, 1);
        next.splice(t.to, 0, me!);
        const i = next.findIndex((x) => x.id === me!.id);
        const mate = t.side === 'above' ? next[i + 1] : next[i - 1];
        expect(mate?.id).toBe(t.anchorId);
      }
    }
  });

  it('dropLabel words', () => {
    expect(dropLabel('video', 'above', 'video 2')).toBe('on top of video 2');
    expect(dropLabel('video', 'below', 'video 1')).toBe('under video 1');
    expect(dropLabel('audio', 'above', 'music')).toBe('above music');
    expect(dropLabel('audio', 'below', 'audio 1')).toBe('below audio 1');
  });
});
