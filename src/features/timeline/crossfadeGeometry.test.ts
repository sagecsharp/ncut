import { describe, expect, it } from 'vitest';
import type { AudioClip, Clip, MediaAsset, Project } from '../../types';
import { createProject } from '../../lib/factory';
import type { CrossfadeSpan } from '../../lib/audioCross';
import { boxGeo, boxRows, laneCrossfades, shapePoints } from './crossfadeGeometry';
import { CLIP_INSET } from './layout';

/** a span by hand: sides in seconds around the edit */
function span(over: Partial<CrossfadeSpan> = {}): CrossfadeSpan {
  const before = over.before ?? 0.1, after = over.after ?? 0.1, edit = over.edit ?? 4;
  return {
    start: edit - before, end: edit + after, edit, shape: 'power', fromId: 'a', toId: 'b', trackId: 'a1', before, after,
    wantBefore: before, wantAfter: after, roomBefore: 2, roomAfter: 2, shortBefore: null, shortAfter: null, withTransition: false, plays: true, ...over,
  };
}

const points = (s: string): [number, number][] => s.split(' ').map((p) => p.split(',').map(Number) as [number, number]);

describe('crossfade geometry', () => {
  it('boxRows on 28 to 240 px', () => {
    expect(boxRows(56)).toEqual({ top: 36, h: 17 });
    expect(boxRows(48)).toEqual({ top: 32, h: 13 });
    expect(boxRows(36)).toEqual({ top: 25, h: 8 });
    expect(boxRows(28)).toEqual({ top: 17, h: 8 });
    for (let laneH = 28; laneH <= 240; laneH++) {
      const { top, h } = boxRows(laneH);
      expect(h, `h at ${laneH}`).toBeGreaterThanOrEqual(8);
      // the bottom is the lane's inset, always
      expect(top + h, `bottom at ${laneH}`).toBe(laneH - CLIP_INSET);
      // under the transition band (1 px under it) unless the box is the least it can be
      const band = CLIP_INSET + Math.round((laneH - CLIP_INSET * 2 - 14) / 2);
      if (h > 8) expect(top).toBe(band + 15);
      else expect(top).toBeLessThanOrEqual(band + 15);
    }
  });

  it('boxGeo', () => {
    const g = boxGeo(span(), 100, 56);
    expect(g.x).toBeCloseTo(390, 6);
    expect(g.width).toBeCloseTo(20, 6);
    expect(g.editX).toBeCloseTo(400, 6);
    expect(g.ghosts).toEqual([]);
    expect(g.notch).toBe(false);
    expect(g.grips).toBe(true);
    // never under 8 px wide
    const thin = boxGeo(span({ before: 0.01, after: 0.01 }), 100, 56);
    expect(thin.width).toBe(8);
    expect(thin.x).toBeCloseTo(399, 6);
    // starts at the edit
    const start = boxGeo(span({ before: 0, after: 0.2 }), 100, 56);
    expect(start.x).toBeCloseTo(400, 6);
    expect(start.width).toBeCloseTo(20, 6);
  });

  it('ghosts', () => {
    // asked 0.3 before the edit, 0.1 plays: a hatched part to the left of the box
    const g = boxGeo(span({ wantBefore: 0.3 }), 100, 56);
    expect(g.ghosts).toHaveLength(1);
    expect(g.ghosts[0]!.x).toBeCloseTo(370, 6);
    expect(g.ghosts[0]!.width).toBeCloseTo(20, 6);
    // and after the edit, right of the box
    const a = boxGeo(span({ wantAfter: 0.25 }), 100, 56);
    expect(a.ghosts).toHaveLength(1);
    expect(a.ghosts[0]!.x).toBeCloseTo(410, 6);
    expect(a.ghosts[0]!.width).toBeCloseTo(15, 6);
    // both
    expect(boxGeo(span({ wantBefore: 0.3, wantAfter: 0.25 }), 100, 56).ghosts).toHaveLength(2);
    // under 1 px: none
    expect(boxGeo(span({ wantBefore: 0.1005 }), 100, 56).ghosts).toEqual([]);
    expect(boxGeo(span({ wantAfter: 0.1099 }), 100, 56).ghosts).toEqual([]);
  });

  it('notch', () => {
    // nothing plays: a 7 px mark on the edit, no grips
    const n = boxGeo(span({ before: 0, after: 0, plays: false, wantBefore: 0.1, wantAfter: 0.1 }), 100, 56);
    expect(n.notch).toBe(true);
    expect(n.width).toBe(7);
    expect(n.x).toBeCloseTo(396.5, 6);
    expect(n.editX).toBeCloseTo(400, 6);
    expect(n.grips).toBe(false);
    // what was asked still shows
    expect(n.ghosts).toHaveLength(2);
  });

  it('grips from 14 px', () => {
    // 0.139 s at 100 px per second is 13.9 px
    expect(boxGeo(span({ before: 0.0695, after: 0.0695 }), 100, 56).grips).toBe(false);
    expect(boxGeo(span({ before: 0.07, after: 0.07 }), 100, 56).grips).toBe(true);
    expect(boxGeo(span({ before: 0.1, after: 0.1 }), 40, 56).grips).toBe(false);
    expect(boxGeo(span({ before: 0.1, after: 0.1 }), 70, 56).grips).toBe(true);
  });

  it('shapePoints', () => {
    for (const shape of ['power', 'linear', 'smooth'] as const) {
      const s = shapePoints(shape, 40, 20, 0.5);
      const out = points(s.out), rise = points(s.in);
      expect(out).toHaveLength(17);
      expect(rise).toHaveLength(17);
      // x runs over the whole box, out falls and in rises
      expect(out[0]![0]).toBe(0);
      expect(out[16]![0]).toBe(40);
      expect(out[0]![1]).toBe(0);
      expect(out[16]![1]).toBe(20);
      expect(rise[0]![1]).toBe(20);
      expect(rise[16]![1]).toBe(0);
    }
    // the middle: equal power is 0.707 there, linear and smooth a half
    const mid = (shape: 'power' | 'linear' | 'smooth') => points(shapePoints(shape, 40, 20, 0.5).out)[8]![1];
    expect(mid('power')).toBeCloseTo(20 * (1 - Math.SQRT1_2), 1);
    expect(mid('linear')).toBe(10);
    expect(mid('smooth')).toBe(10);
    // in is the mirror of out
    const s = shapePoints('power', 40, 20, 0.5);
    expect(points(s.in)[4]![1]).toBe(points(s.out)[12]![1]);
  });

  it('laneCrossfades keeps stable arrays', () => {
    const assets: MediaAsset[] = [{ id: 'song', name: 'song', kind: 'audio', mime: '', size: 1, duration: 60, width: 0, height: 0, hasAudio: true, createdAt: 0 }];
    const au = (id: string, start: number, trimStart: number, over: Partial<AudioClip> = {}): AudioClip => ({
      id, type: 'audio', trackId: 'a1', start, duration: 4, name: id, fadeIn: 0, fadeOut: 0, assetId: 'song', trimStart, speed: 1, volume: 1, muted: false, ...over,
    });
    const make = (clips: Clip[]): Project => ({ ...createProject('lane'), assets, clips });
    const p = make([au('a', 0, 10), au('b', 4, 30, { crossfade: { before: 0.1, after: 0.1 } }), au('c', 8, 50)]);
    const one = laneCrossfades(p, 'a1');
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({ fromId: 'a', toId: 'b', before: 0.1, after: 0.1, plays: true });
    // the same project: the same array
    expect(laneCrossfades(p, 'a1')).toBe(one);
    // another project object with the same values: the same array (a selector must not loop)
    const copy = make(p.clips.map((c) => ({ ...c })));
    expect(copy).not.toBe(p);
    expect(laneCrossfades(copy, 'a1')).toBe(one);
    // a changed value: a new array
    const changed = make(p.clips.map((c) => (c.id === 'b' ? ({ ...c, crossfade: { before: 0.2, after: 0.1 } } as Clip) : c)));
    const next = laneCrossfades(changed, 'a1');
    expect(next).not.toBe(one);
    expect(next[0]!.before).toBe(0.2);
    expect(laneCrossfades(make(changed.clips.map((c) => ({ ...c }))), 'a1')).toBe(next);
    // no crossfade, no project, another track: one shared empty array
    const none = laneCrossfades(make([au('a', 0, 10), au('b', 4, 30)]), 'a1');
    expect(none).toHaveLength(0);
    expect(laneCrossfades(null, 'a1')).toBe(none);
    expect(laneCrossfades(p, 'v1')).toBe(none);
    // a crossfade that waits has no span
    expect(laneCrossfades(make([au('w', 0, 10, { crossfade: { before: 0.1, after: 0.1 } })]), 'a1')).toBe(none);
  });
});
