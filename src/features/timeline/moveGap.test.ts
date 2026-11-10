import { describe, expect, it } from 'vitest';
import type { Clip, Track } from '../../types';
import { gapForMove } from './moveGap';

const tr = (id: string, kind: 'video' | 'audio') => ({ id, kind }) as unknown as Track;
const tracks = [tr('v1', 'video'), tr('v2', 'video'), tr('a1', 'audio'), tr('a2', 'audio')];
const clip = (id: string, trackId: string) => ({ id, trackId }) as unknown as Clip;
const item = (id: string, type: 'text' | 'audio', trackId: string) => ({ id, type, trackId }) as const;
const clips = [clip('c1', 'v1'), clip('c2', 'v1'), clip('c3', 'v2'), clip('s1', 'a1')];

describe('gapForMove', () => {
  it('the good case', () => {
    expect(gapForMove(tracks, clips, [item('c1', 'text', 'v1')], 1, 30)).toBe(1);
    expect(gapForMove(tracks, clips, [item('c1', 'text', 'v1')], 2, -30)).toBe(2);
  });
  it('no gap under the pointer', () => {
    expect(gapForMove(tracks, clips, [item('c1', 'text', 'v1')], null, 30)).toBeNull();
  });
  it('too little vertical movement', () => {
    expect(gapForMove(tracks, clips, [item('c1', 'text', 'v1')], 1, 7)).toBeNull();
    expect(gapForMove(tracks, clips, [item('c1', 'text', 'v1')], 1, 8)).toBe(1);
  });
  it('items from two tracks', () => {
    expect(gapForMove(tracks, clips, [item('c1', 'text', 'v1'), item('c3', 'text', 'v2')], 2, 30)).toBeNull();
  });
  it('several items of one track: pointless only when they are the whole track', () => {
    expect(gapForMove(tracks, clips, [item('c1', 'text', 'v1'), item('c2', 'text', 'v1')], 1, 30)).toBeNull();
    const more = [...clips, clip('c4', 'v1')];
    expect(gapForMove(tracks, more, [item('c1', 'text', 'v1'), item('c2', 'text', 'v1')], 2, 30)).toBe(2);
  });
  it('wrong kind for the border', () => {
    expect(gapForMove(tracks, clips, [item('c1', 'text', 'v1')], 3, 30)).toBeNull();
    expect(gapForMove(tracks, clips, [item('s1', 'audio', 'a1')], 1, 30)).toBeNull();
    expect(gapForMove(tracks, clips, [item('s1', 'audio', 'a1')], 3, 30)).toBeNull();
    expect(gapForMove(tracks, [...clips, clip('s2', 'a1')], [item('s1', 'audio', 'a1')], 3, 30)).toBe(3);
  });
  it('pointless: all clips of the track at the border that touches it', () => {
    expect(gapForMove(tracks, clips, [item('c3', 'text', 'v2')], 1, 30)).toBeNull();
    expect(gapForMove(tracks, clips, [item('c3', 'text', 'v2')], 2, 30)).toBeNull();
    expect(gapForMove(tracks, clips, [item('c3', 'text', 'v2')], 3, 30)).toBeNull();
  });
  it('all clips of a track at a border away from it is fine', () => {
    const t3 = [tr('v1', 'video'), tr('v2', 'video'), tr('v3', 'video'), tr('a1', 'audio')];
    expect(gapForMove(t3, clips, [item('c3', 'text', 'v2')], 3, 30)).toBe(3);
    expect(gapForMove(t3, clips, [item('c3', 'text', 'v2')], 1, 30)).toBeNull();
  });
});
