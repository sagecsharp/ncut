import { describe, expect, it } from 'vitest';
import type { Clip, EffectClip, ImageClip, Project } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import { createProject } from '../../lib/factory';
import { syncTrackIds } from '../../lib/trackTools';
import { cuttableAt, lockedTracksHit, planCloseUp, planRangeRemoval, splitOrigins, syncOffTracksHit, transitionsToDrop } from './rangeEdit';

const image = (trackId: string, id: string, start: number, duration: number, over: Partial<ImageClip> = {}): ImageClip => ({
  id, type: 'image', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'img1', transform: { ...DEFAULT_TRANSFORM }, ...over,
});

const T0 = 'first';
const T1 = 'second';

/** two video tracks, the second one locked when asked */
function proj(clips: Clip[], lock1 = false): Project {
  const p = createProject('range edit');
  const tracks = [{ ...p.tracks[0]!, id: T0 }, { ...p.tracks[0]!, id: T1, name: 'second', locked: lock1 }];
  return { ...p, tracks, clips };
}

const span = { start: 2, end: 4 };

describe('cuttableAt', () => {
  it('lists unlocked clips with room on both sides', () => {
    const p = proj([image(T0, 'a', 0, 5), image(T0, 'b', 5, 2), image(T1, 'c', 0, 5)], true);
    expect(cuttableAt(p, 2)).toEqual(['a']);
    expect(cuttableAt(p, 0.03)).toEqual([]);
    expect(cuttableAt(p, 4.97)).toEqual([]);
    expect(cuttableAt(p, 5)).toEqual([]);
    expect(cuttableAt(p, 5.5)).toEqual(['b']);
  });
});

describe('planRangeRemoval', () => {
  it('deletes what is inside', () => {
    const p = proj([image(T0, 'a', 2, 2), image(T1, 'b', 2.5, 1)]);
    expect(planRangeRemoval(p, span)).toEqual({ deletes: ['a', 'b'], trims: [], slivers: 0, blocked: null });
  });
  it('trims and counts slivers', () => {
    const p = proj([
      image(T0, 'a', 0, 4.02),
      image(T0, 'b', 4.02, 0.01),
      image(T1, 'c', 1, 1.5),
      image(T1, 'd', 1.99, 3),
    ]);
    const plan = planRangeRemoval(p, span);
    expect(plan.deletes).toEqual([]);
    expect(plan.trims).toEqual([
      { id: 'a', edge: 'end', time: 2 },
      { id: 'c', edge: 'end', time: 2 },
      { id: 'd', edge: 'start', time: 4 },
    ]);
    expect(plan.slivers).toBe(2);
    const gone = planRangeRemoval(proj([image(T0, 'a', 1.98, 2.04)]), span);
    expect(gone.deletes).toEqual(['a']);
    expect(gone.slivers).toBe(2);
  });
  it('blocks a clip it cannot split', () => {
    const p = proj([image(T0, 'a', 1, 5)]);
    expect(planRangeRemoval(p, span).blocked?.id).toBe('a');
    const two = proj([image(T1, 'z', 0, 6), image(T0, 'a', 1, 5)]);
    expect(planRangeRemoval(two, span).blocked?.id).toBe('a');
  });
  it('leaves locked tracks alone', () => {
    const p = proj([image(T1, 'x', 2, 2), image(T1, 'y', 0, 6)], true);
    expect(planRangeRemoval(p, span)).toEqual({ deletes: [], trims: [], slivers: 0, blocked: null });
  });
});

describe('planCloseUp', () => {
  it('moves every unlocked track by one amount', () => {
    const p = proj([image(T0, 'a', 4, 1), image(T0, 'b', 6, 1), image(T1, 'c', 5, 1), image(T0, 'd', 0, 2)]);
    const cu = planCloseUp(p, span);
    expect(cu.clash).toBeNull();
    expect(cu.moves.map((m) => [m.id, m.start]).sort()).toEqual([['a', 2], ['b', 4], ['c', 3]]);
  });
  it('leaves locked tracks where they are', () => {
    const p = proj([image(T1, 'c', 5, 1), image(T0, 'a', 5, 1)], true);
    expect(planCloseUp(p, span).moves.map((m) => m.id)).toEqual(['a']);
  });
  it('moves followers', () => {
    const fx = { id: 'fx', type: 'effect', trackId: T1, start: 5, duration: 1, name: 'fx', fadeIn: 0, fadeOut: 0, effect: 'blur', target: 'a', params: {} } as unknown as EffectClip;
    const p = proj([image(T0, 'a', 5, 1), fx]);
    const moves = planCloseUp(p, span).moves;
    expect(moves.find((m) => m.id === 'a')?.start).toBe(3);
    expect(moves.find((m) => m.id === 'fx')?.start).toBe(3);
  });
  it('finds a made up clash', () => {
    // a clip before the span that is not cut: the one after it would land on it
    const p = proj([image(T0, 'a', 0, 2.5), image(T0, 'b', 4, 1)]);
    const cu = planCloseUp(p, span);
    expect(cu.clash?.clip.id).toBe('b');
    expect(cu.clash?.other.id).toBe('a');
  });
});

describe('splitOrigins', () => {
  it('maps a new clip to the clip it was cut from', () => {
    const before = proj([image(T0, 'a', 0, 6), image(T1, 'b', 0, 6)]);
    const after = proj([image(T1, 'b', 0, 3), image(T1, 'b2', 3, 3), image(T0, 'a', 0, 3), image(T0, 'a2', 3, 3)]);
    const m = splitOrigins(before, after);
    expect([...m.entries()].sort()).toEqual([['a2', 'a'], ['b2', 'b']]);
  });
});

describe('transitionsToDrop', () => {
  const tr = { id: 'fade', duration: 0.5 } as unknown as ImageClip['transition'];
  it('keeps the same clip or its right half', () => {
    const before = proj([image(T0, 'a', 0, 6), image(T0, 'b', 6, 2, { transition: tr })]);
    const after = proj([image(T0, 'a', 0, 4), image(T0, 'a2', 4, 2), before.clips[1]!]);
    expect(transitionsToDrop(before, after, new Map([['a2', 'a']]))).toEqual([]);
    expect(transitionsToDrop(before, before, new Map())).toEqual([]);
    // without the lineage the right half is another clip
    expect(transitionsToDrop(before, after, new Map())).toEqual(['b']);
  });
  it('drops the rest (CUT_EPS)', () => {
    const before = proj([image(T0, 'a', 0, 6), image(T0, 'b', 6, 2, { transition: tr }), image(T0, 'c', 8, 2, { transition: tr })]);
    const [a, b, c] = before.clips as [ImageClip, ImageClip, ImageClip];
    expect(transitionsToDrop(before, proj([b, c]), new Map())).toEqual(['b']);
    expect(transitionsToDrop(before, proj([a, { ...b, start: 6.0005 }, c]), new Map())).toEqual([]);
    expect(transitionsToDrop(before, proj([a, { ...b, start: 6.01 }, { ...c, start: 8.01 }]), new Map())).toEqual(['b']);
    const fresh = proj([...before.clips, image(T0, 'n', 20, 1, { transition: tr })]);
    expect(transitionsToDrop(before, fresh, new Map())).toEqual([]);
  });
});

describe('lockedTracksHit', () => {
  it('counts locked tracks with a clip inside (extract: or after)', () => {
    const p = proj([image(T1, 'x', 5, 1), image(T0, 'a', 2, 1)], true);
    expect(lockedTracksHit(p, span, false)).toBe(0);
    expect(lockedTracksHit(p, span, true)).toBe(1);
    const q = proj([image(T1, 'x', 3, 5), image(T1, 'y', 9, 1)], true);
    expect(lockedTracksHit(q, span, false)).toBe(1);
    expect(lockedTracksHit(q, span, true)).toBe(1);
  });
});

describe('sync lock off', () => {
  const off = (clips: Clip[]): Project => {
    const p = proj(clips);
    return { ...p, tracks: p.tracks.map((t) => (t.id === T1 ? { ...t, syncLock: false } : t)) };
  };

  it('extract leaves sync lock off tracks alone', () => {
    const p = off([image(T0, 'a', 1, 4), image(T0, 'b', 5, 1), image(T1, 'c', 2.5, 1), image(T1, 'd', 5, 1)]);
    const open = syncTrackIds(p.tracks, new Set());
    expect(cuttableAt(p, 3, open)).toEqual(['a']);
    expect(cuttableAt(p, 3)).toEqual(['a', 'c']);
    const cut = off([image(T0, 'e', 2, 2), image(T1, 'c', 2.5, 1)]);
    expect(planRangeRemoval(cut, span, open).deletes).toEqual(['e']);
    expect(planRangeRemoval(cut, span).deletes).toEqual(['e', 'c']);
    expect(planCloseUp(p, span, open).moves.map((m) => m.id)).toEqual(['b']);
    expect(planCloseUp(p, span).moves.map((m) => m.id).sort()).toEqual(['b', 'd']);
  });

  it('a follower of a held target stays whole and in place', () => {
    const fxc = (id: string, target: string, start: number, duration: number): EffectClip => ({
      id, type: 'effect', trackId: T0, start, duration, name: id, fadeIn: 0, fadeOut: 0, effect: 'shake', params: {}, amount: 1, seed: 1, target,
    });
    const p = off([image(T0, 'a', 0, 2), image(T0, 'b', 4, 1), image(T1, 'r', 5, 2), fxc('e', 'r', 5, 2)]);
    const open = syncTrackIds(p.tracks, new Set());
    expect(planCloseUp(p, { start: 2, end: 3 }, open).moves.map((m) => m.id)).toEqual(['b']);
    expect(cuttableAt(p, 6, open)).toEqual([]);
    expect(planRangeRemoval(p, { start: 5, end: 6 }, open).deletes).toEqual([]);
  });

  it('syncOffTracksHit', () => {
    const p = off([image(T0, 'a', 0, 1), image(T1, 'c', 3, 1)]);
    expect(syncOffTracksHit(p, span)).toEqual([T1]);
    expect(syncOffTracksHit(off([image(T1, 'd', 0, 2)]), span)).toEqual([]);
    expect(syncOffTracksHit(off([image(T1, 'd', 6, 1)]), span)).toEqual([T1]);
    expect(syncOffTracksHit(proj([image(T1, 'd', 3, 1)]), span)).toEqual([]);
    const locked = { ...p, tracks: p.tracks.map((t) => (t.id === T1 ? { ...t, locked: true } : t)) };
    expect(syncOffTracksHit(locked, span)).toEqual([]);
  });
});
