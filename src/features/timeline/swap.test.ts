import { describe, expect, it } from 'vitest';
import type { Clip, MediaAsset, Track } from '../../types';
import { SWAP_MENU_LIMIT, swapCandidates, swapTarget, swappableKind } from './swap';

const asset = (id: string, kind: MediaAsset['kind'], createdAt: number) => ({ id, kind, name: id, createdAt }) as unknown as MediaAsset;
const clip = (id: string, type: string, trackId: string, start: number, duration: number, assetId?: string) =>
  ({ id, type, trackId, start, duration, assetId }) as unknown as Clip;
const track = (id: string, locked = false) => ({ id, kind: 'video', locked }) as unknown as Track;

describe('swap candidates', () => {
  const assets = [asset('a', 'video', 1), asset('b', 'image', 2), asset('c', 'video', 3), asset('d', 'video', 3), asset('e', 'video', 0)];
  it('lists other assets of the same kind, newest first', () => {
    expect(swapCandidates(assets, clip('x', 'video', 't', 0, 1, 'a')).map((a) => a.id)).toEqual(['d', 'c', 'e']);
  });
  it('is empty for clips without media', () => {
    expect(swapCandidates(assets, clip('x', 'text', 't', 0, 1))).toEqual([]);
    expect(swappableKind(clip('x', 'camera', 't', 0, 1))).toBeNull();
  });
  it('caps the list', () => {
    const many = Array.from({ length: 20 }, (_, i) => asset('v' + i, 'video', i));
    expect(swapCandidates(many, clip('x', 'video', 't', 0, 1, 'none'))).toHaveLength(SWAP_MENU_LIMIT);
    expect(swapCandidates(many, clip('x', 'video', 't', 0, 1, 'none'))[0]!.id).toBe('v19');
  });
});

describe('swap candidates of a sound clip', () => {
  const withSound = (id: string, kind: MediaAsset['kind'], createdAt: number, hasAudio: boolean) => ({ id, kind, name: id, createdAt, hasAudio }) as unknown as MediaAsset;
  const assets = [withSound('av', 'video', 1, true), withSound('song', 'audio', 2, true), withSound('talk', 'video', 3, true), withSound('mute', 'video', 4, false), withSound('pic', 'image', 5, false)];
  it('a sound clip lists videos with sound', () => {
    // the sound clip plays the video 'av': audio files and videos with sound, newest first, never the silent one
    expect(swapCandidates(assets, clip('x', 'audio', 't', 0, 1, 'av')).map((a) => a.id)).toEqual(['talk', 'song']);
  });
  it('an audio clip of an audio file lists audio only', () => {
    expect(swapCandidates(assets, clip('x', 'audio', 't', 0, 1, 'song')).map((a) => a.id)).toEqual([]);
  });
  it('a video clip still lists videos only', () => {
    expect(swapCandidates(assets, clip('x', 'video', 't', 0, 1, 'av')).map((a) => a.id)).toEqual(['mute', 'talk']);
  });
});

describe('swap target', () => {
  const project = {
    tracks: [track('t1'), track('t2', true)],
    clips: [clip('a', 'video', 't1', 0, 4, 'v1'), clip('b', 'image', 't1', 4, 2, 'i1'), clip('c', 'video', 't2', 0, 4, 'v1')],
  };
  it('picks the same kind clip under the pointer', () => {
    expect(swapTarget(project, 't1', 1, { id: 'v2', kind: 'video' })?.id).toBe('a');
    expect(swapTarget(project, 't1', 5, { id: 'i2', kind: 'image' })?.id).toBe('b');
  });
  it('ignores other kinds, the same asset, locked tracks and empty spots', () => {
    expect(swapTarget(project, 't1', 5, { id: 'v2', kind: 'video' })).toBeNull();
    expect(swapTarget(project, 't1', 1, { id: 'v1', kind: 'video' })).toBeNull();
    expect(swapTarget(project, 't2', 1, { id: 'v2', kind: 'video' })).toBeNull();
    expect(swapTarget(project, 't1', 9, { id: 'v2', kind: 'video' })).toBeNull();
    expect(swapTarget(project, undefined, 1, { id: 'v2', kind: 'video' })).toBeNull();
  });
});
