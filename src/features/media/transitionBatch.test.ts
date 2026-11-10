import { describe, expect, it } from 'vitest';
import type { ImageClip, Project, Transition } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import { createProject } from '../../lib/factory';
import { MAX_TRANSITION_DURATION, MIN_TRANSITION_DURATION, TRANSITIONS } from '../../engine/transitions/registry';
import {
  calmPool,
  cutsOnTrack,
  planRemoveTransitions,
  planSameLength,
  planShuffle,
  planTrackTransitions,
  seededRandom,
  shuffleOrder,
} from './transitionBatch';

let n = 0;
function img(trackId: string, start: number, duration: number, transition?: Transition | null): ImageClip {
  return { id: `i${++n}`, type: 'image', trackId, start, duration, name: 'i', fadeIn: 0, fadeOut: 0, assetId: 'a', transform: { ...DEFAULT_TRANSFORM }, transition };
}
const tr = (duration: number, id = 'dissolve'): Transition => ({ id, duration });

function setup(): { p: Project; t: string } {
  const p = createProject('t');
  return { p, t: p.tracks.find((x) => x.kind === 'video')!.id };
}

describe('cutsOnTrack', () => {
  it('lists clips that touch the one before; gaps and the first clip are not cuts', () => {
    const { p, t } = setup();
    const [a, b, c, d] = [img(t, 0, 3), img(t, 3, 3), img(t, 7, 3), img(t, 10, 3)];
    p.clips = [d, b, a, c];
    expect(cutsOnTrack(p, t).map((x) => x.clip.id)).toEqual([b.id, d.id]);
  });
  it('limit is the shorter clip, never over the max', () => {
    const { p, t } = setup();
    p.clips = [img(t, 0, 2), img(t, 2, 40), img(t, 42, 40)];
    expect(cutsOnTrack(p, t).map((x) => x.limit)).toEqual([2, MAX_TRANSITION_DURATION]);
  });
  it('skips cuts too short for any transition', () => {
    const { p, t } = setup();
    p.clips = [img(t, 0, 3), img(t, 3, MIN_TRANSITION_DURATION / 2)];
    expect(cutsOnTrack(p, t)).toEqual([]);
  });
});

describe('planTrackTransitions', () => {
  it('adds on cuts without one, clamped to the cut', () => {
    const { p, t } = setup();
    const a = img(t, 0, 3);
    const b = img(t, 3, 0.5);
    const c = img(t, 3.5, 3, tr(1));
    p.clips = [a, b, c];
    const plan = planTrackTransitions(p, t, { id: 'wipe-left', duration: 2 }, false);
    expect(plan).toEqual([{ clipId: b.id, transition: { id: 'wipe-left', duration: 0.5 } }]);
  });
  it('replace also rewrites the ones that exist', () => {
    const { p, t } = setup();
    const a = img(t, 0, 3);
    const b = img(t, 3, 3, tr(1));
    p.clips = [a, b];
    expect(planTrackTransitions(p, t, { id: 'wipe-left', duration: 1 }, true)).toEqual([{ clipId: b.id, transition: { id: 'wipe-left', duration: 1 } }]);
  });
  it('does nothing on a locked track or when it is already the same', () => {
    const { p, t } = setup();
    p.clips = [img(t, 0, 3), img(t, 3, 3, tr(1, 'wipe-left'))];
    expect(planTrackTransitions(p, t, { id: 'wipe-left', duration: 1 }, true)).toEqual([]);
    p.tracks = p.tracks.map((x) => (x.id === t ? { ...x, locked: true } : x));
    p.clips = [img(t, 0, 3), img(t, 3, 3)];
    expect(planTrackTransitions(p, t, { id: 'wipe-left', duration: 1 }, false)).toEqual([]);
  });
});

describe('planRemoveTransitions', () => {
  it('clears every clip with a transition on the track only', () => {
    const { p, t } = setup();
    const a = img(t, 0, 3, tr(1));
    const b = img(t, 3, 3, tr(1));
    const c = img(t, 6, 3);
    const other = img('other', 0, 3, tr(1));
    p.clips = [a, b, c, other];
    expect(planRemoveTransitions(p, t)).toEqual([
      { clipId: a.id, transition: null },
      { clipId: b.id, transition: null },
    ]);
  });
});

describe('planSameLength', () => {
  it('copies the length to the others, clamped per cut (the next cut is limited by the short clip before it)', () => {
    const { p, t } = setup();
    const a = img(t, 0, 4);
    const b = img(t, 4, 4, tr(2));
    const c = img(t, 8, 1, tr(0.5, 'push-left'));
    const d = img(t, 9, 4, tr(2));
    p.clips = [a, b, c, d];
    const plan = planSameLength(p, t, b.id);
    expect(plan).toEqual([
      { clipId: c.id, transition: { id: 'push-left', duration: 1 } },
      { clipId: d.id, transition: { id: 'dissolve', duration: 1 } },
    ]);
  });
  it('nothing without a source transition', () => {
    const { p, t } = setup();
    const a = img(t, 0, 4);
    p.clips = [a];
    expect(planSameLength(p, t, a.id)).toEqual([]);
  });
});

describe('shuffle', () => {
  const pool = ['a', 'b', 'c', 'd'];
  it('is deterministic per seed and differs between seeds', () => {
    expect(shuffleOrder(pool, [undefined, undefined, undefined], 5)).toEqual(shuffleOrder(pool, [undefined, undefined, undefined], 5));
    const seen = new Set(Array.from({ length: 20 }, (_, s) => shuffleOrder(pool, Array(6).fill(undefined), s).join()));
    expect(seen.size).toBeGreaterThan(1);
  });
  it('never repeats the previous one, the current one or the one used last', () => {
    for (let seed = 0; seed < 200; seed++) {
      const currents = ['a', 'b', undefined, 'c', 'd', 'a'];
      const out = shuffleOrder(pool, currents, seed, 'b');
      expect(out[0]).not.toBe('b');
      out.forEach((id, i) => {
        if (i > 0) expect(id).not.toBe(out[i - 1]);
        expect(id).not.toBe(currents[i]);
      });
    }
  });
  it('copes with a pool of one and an empty pool', () => {
    expect(shuffleOrder(['a'], [undefined, undefined], 1)).toEqual(['a', 'a']);
    expect(shuffleOrder([], [undefined], 1)).toEqual([]);
  });
  it('seededRandom stays in [0,1)', () => {
    const r = seededRandom(9);
    for (let i = 0; i < 100; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
  it('plans only selected clips that start on a cut, in timeline order, within the cut', () => {
    const { p, t } = setup();
    const a = img(t, 0, 3);
    const b = img(t, 3, 0.4, tr(2));
    const c = img(t, 3.4, 3);
    p.clips = [a, b, c];
    const plan = planShuffle(p, [c.id, a.id, b.id], pool, 3);
    expect(plan.map((x) => x.clipId)).toEqual([b.id, c.id]);
    expect(plan[0]!.transition!.duration).toBe(0.4);
    expect(plan[0]!.transition!.id).not.toBe(plan[1]!.transition!.id);
  });
  it('calm pool is picked from the registry and is not empty', () => {
    const calm = calmPool(TRANSITIONS);
    expect(calm.length).toBeGreaterThan(5);
    expect(calm.every((d) => d.category !== 'stylize' && d.category !== '3d')).toBe(true);
  });
});
