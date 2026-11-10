import { describe, expect, it } from 'vitest';
import type { Clip, Project, Track, VisualClip } from '../../types';
import { effectHomeTrack, effectsOnClip, newTargetedEffect, overlapsInTime } from './clipEffects';
import { effectTargetOptions } from './parentOptions';

const track = (id: string, kind: 'video' | 'audio' = 'video', locked = false): Track => ({ id, kind, name: id, muted: false, hidden: false, locked });
const mk = (id: string, trackId: string, start: number, duration: number, extra: Record<string, unknown>): Clip =>
  ({ id, trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, ...extra }) as Clip;

describe('effectsOnClip', () => {
  it('lists the effects that point at the clip, earliest first', () => {
    const clips = [
      mk('e2', 'fx', 5, 1, { type: 'effect', target: 'v' }),
      mk('e1', 'fx', 1, 1, { type: 'effect', target: 'v' }),
      mk('e3', 'fx', 1, 1, { type: 'effect', target: 'other' }),
      mk('e4', 'fx', 1, 1, { type: 'effect', target: null }),
      mk('v', 't', 0, 10, { type: 'image', assetId: 'a' }),
    ];
    expect(effectsOnClip(clips, 'v').map((c) => c.id)).toEqual(['e1', 'e2']);
  });
});

describe('newTargetedEffect', () => {
  it('copies start and duration and points at the clip', () => {
    const v = mk('v', 't', 2, 3.5, { type: 'image', assetId: 'a' }) as VisualClip;
    const e = newTargetedEffect('blur', 'blur', v, 'fx');
    expect(e).toMatchObject({ type: 'effect', effect: 'blur', name: 'blur', start: 2, duration: 3.5, target: 'v', trackId: 'fx', amount: 1 });
  });
});

describe('effectHomeTrack', () => {
  const v = mk('v', 't2', 0, 4, { type: 'image', assetId: 'a' });
  const base = (tracks: Track[], clips: Clip[]) => ({ tracks, clips }) as Pick<Project, 'tracks' | 'clips'>;
  it('uses a free effects track right above', () => {
    expect(effectHomeTrack(base([track('fx'), track('t2')], [v]), v)).toBe('fx');
  });
  it('skips tracks with other clips, locked tracks and tracks without room', () => {
    const other = mk('o', 't1', 0, 1, { type: 'image', assetId: 'a' });
    expect(effectHomeTrack(base([track('t1'), track('t2')], [v, other]), v)).toBeNull();
    expect(effectHomeTrack(base([track('fx', 'video', true), track('t2')], [v]), v)).toBeNull();
    const busy = mk('e', 'fx', 1, 1, { type: 'effect' });
    expect(effectHomeTrack(base([track('fx'), track('t2')], [v, busy]), v)).toBeNull();
  });
  it('never uses a track below', () => {
    expect(effectHomeTrack(base([track('t2'), track('fx')], [v]), v)).toBeNull();
  });
});

describe('overlapsInTime', () => {
  it('touching is not overlapping', () => {
    expect(overlapsInTime({ start: 0, duration: 2 }, { start: 2, duration: 1 })).toBe(false);
    expect(overlapsInTime({ start: 0, duration: 2 }, { start: 1.5, duration: 1 })).toBe(true);
  });
});

describe('effectTargetOptions', () => {
  it('lists visual clips only, the ones that overlap first, never the effect itself', () => {
    const clips = [
      mk('far', 't', 20, 2, { type: 'image', assetId: 'a', name: 'far' }),
      mk('near', 't', 0, 2, { type: 'text', text: 'near' }),
      mk('cam', 't', 0, 2, { type: 'camera' }),
      mk('aud', 'a', 0, 2, { type: 'audio' }),
      mk('fx', 'f', 0, 2, { type: 'effect' }),
    ];
    const opts = effectTargetOptions({ clips }, 'fx');
    expect(opts.map((o) => [o.id, o.overlaps])).toEqual([
      ['near', true],
      ['far', false],
    ]);
  });
});
