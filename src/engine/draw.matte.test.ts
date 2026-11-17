import { describe, expect, it } from 'vitest';
import type { Clip, EffectClip, ImageClip, Project, Track, VideoClip } from '../types';
import { DEFAULT_TRANSFORM } from '../types';
import { frameFx, neededClipsAt, paintListAt, visibleClipsAt } from './draw';

let seq = 0;
function video(trackId: string, start: number, duration: number, over: Partial<VideoClip> = {}): VideoClip {
  return {
    id: `v${++seq}`,
    type: 'video',
    trackId,
    start,
    duration,
    name: 'v',
    fadeIn: 0,
    fadeOut: 0,
    assetId: 'vid',
    trimStart: 0,
    speed: 1,
    volume: 1,
    muted: false,
    transform: { ...DEFAULT_TRANSFORM },
    ...over,
  };
}
function image(trackId: string, start: number, duration: number, over: Partial<ImageClip> = {}): ImageClip {
  return {
    id: `i${++seq}`,
    type: 'image',
    trackId,
    start,
    duration,
    name: 'i',
    fadeIn: 0,
    fadeOut: 0,
    assetId: 'img',
    transform: { ...DEFAULT_TRANSFORM },
    ...over,
  };
}
function keyLayer(trackId: string, start: number, duration: number): EffectClip {
  return { id: `e${++seq}`, type: 'effect', trackId, start, duration, name: 'fx', fadeIn: 0, fadeOut: 0, effect: 'chroma-key', amount: 1, params: {}, seed: 7 };
}
function track(id: string, kind: 'video' | 'audio', hidden = false): Track {
  return { id, kind, name: id, muted: false, hidden, locked: false };
}
function project(clips: Project['clips'], tracks: Track[]): Project {
  return {
    id: 'p',
    name: 'p',
    createdAt: 0,
    updatedAt: 0,
    width: 1920,
    height: 1080,
    fps: 30,
    background: '#123456',
    assets: [
      { id: 'vid', name: 'vid', kind: 'video', mime: 'video/mp4', size: 1, duration: 10, width: 1000, height: 1000, hasAudio: true, createdAt: 0 },
      { id: 'img', name: 'img', kind: 'image', mime: 'image/png', size: 1, duration: 0, width: 0, height: 0, hasAudio: false, createdAt: 0 },
    ],
    tracks,
    clips,
  };
}
const ids = (list: readonly Clip[]) => list.map((c) => c.id);

describe('track mattes in the lists', () => {
  const tracks = [track('top', 'video'), track('bot', 'video')];

  it('visibleClipsAt and paintListAt skip a matte clip', () => {
    const m = video('top', 0, 5);
    const c = image('bot', 0, 5, { matte: { clip: m.id, mode: 'alpha' } });
    const p = project([m, c], tracks);
    expect(ids(visibleClipsAt(p, 1))).toEqual([c.id]);
    expect(ids(paintListAt(p, 1))).toEqual([c.id]);
  });

  it('neededClipsAt keeps a matte clip while it plays', () => {
    const m = video('top', 1, 2);
    const c = image('bot', 0, 5, { matte: { clip: m.id, mode: 'alpha' } });
    const p = project([m, c], tracks);
    expect(ids(neededClipsAt(p, 2))).toEqual([c.id, m.id]);
    expect(ids(neededClipsAt(p, 0.5))).toEqual([c.id]);
    expect(ids(neededClipsAt(p, 3))).toEqual([c.id]);
  });

  it('neededClipsAt keeps a matte clip at a held transition edge', () => {
    const before = image('bot', 0, 2);
    const c = image('bot', 2, 3, { matte: { clip: 'm', mode: 'alpha' }, transition: { id: 'fade', duration: 1 } });
    const m = video('top', 2, 3, { id: 'm' });
    const p = project([m, before, c], tracks);
    // the transition spans 1.5 to 2.5: the matted clip is held on its first frame, where the matte clip plays
    expect(ids(neededClipsAt(p, 1.7))).toContain('m');
    expect(ids(neededClipsAt(p, 1.0))).not.toContain('m');
  });

  it('a matte that does not count changes no list', () => {
    const hiddenTracks = [track('top', 'video'), track('gone', 'video', true), track('bot', 'video')];
    const hid = video('gone', 0, 5);
    const a = image('bot', 0, 5, { matte: { clip: hid.id, mode: 'alpha' } });
    const chained = video('top', 0, 5, { matte: { clip: a.id, mode: 'alpha' } });
    const plainA = { ...a } as ImageClip;
    delete plainA.matte;
    const plainChained = { ...chained } as VideoClip;
    delete plainChained.matte;
    const withM = project([chained, hid, a], hiddenTracks);
    const without = project([plainChained, hid, plainA], hiddenTracks);
    for (const t of [1, 4]) {
      expect(ids(visibleClipsAt(withM, t))).toEqual(ids(visibleClipsAt(without, t)));
      expect(ids(paintListAt(withM, t))).toEqual(ids(paintListAt(without, t)));
      expect(ids(neededClipsAt(withM, t))).toEqual(ids(neededClipsAt(without, t)));
    }
    // a matte clip with a matte of its own: neither counts
    const x = video('top', 0, 5);
    const y = image('bot', 0, 5, { matte: { clip: x.id, mode: 'alpha' } });
    const xm = { ...x, matte: { clip: y.id, mode: 'alpha' as const } } as VideoClip;
    const two = project([xm, y], tracks);
    expect(ids(visibleClipsAt(two, 1))).toEqual([y.id, xm.id]);
  });

  it('a key layer above a matte clip keys the matte clip', () => {
    const m = video('mid', 0, 5);
    const c = video('bot', 0, 5, { matte: { clip: m.id, mode: 'luma' } });
    const k = keyLayer('top', 0, 5);
    const p = project([k, m, c], [track('top', 'video'), track('mid', 'video'), track('bot', 'video')]);
    const f = frameFx(p, 1);
    expect([...f.bound!]).toEqual([m.id]);
  });
});
