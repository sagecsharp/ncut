import { describe, expect, it } from 'vitest';
import { createEffectClip, createShapeClip, createTextClip } from '../../lib/factory';
import type { Clip, ClipGrade, MediaAsset, Track } from '../../types';
import { keepKnownLut, lutPatch, lutSizeText, planLutOff, planLutOn } from './lutPlan';

const track = (id: string, locked = false): Track => ({ id, kind: 'video', name: id, muted: false, hidden: false, locked });
const tracks = [track('t1'), track('t2', true)];
const text = (id: string, grade?: ClipGrade, trackId = 't1'): Clip => createTextClip(trackId, 0, { id, grade });
const media = (id: string, kind: MediaAsset['kind'] = 'lut'): MediaAsset => ({ id, name: id, kind, mime: 'text/plain', size: 1, duration: 0, width: 0, height: 0, hasAudio: false, createdAt: 0 });
const key = (t: number, v: number) => ({ t, v, ease: 'linear' as const });

describe('lut plans', () => {
  it('planLutOn puts the lut on unlocked clips that can grade', () => {
    const clips: Clip[] = [
      text('a'),
      text('b', { liftY: 0.2 }),
      text('l', undefined, 't2'),
      createEffectClip('blur', 'blur', 't1', 0, { id: 'fx' }),
      createEffectClip('grade', 'grade', 't1', 0, { id: 'gfx' }),
      createShapeClip('t1', 0, { id: 'u' }),
    ];
    const plan = planLutOn(clips, tracks, ['a', 'b', 'l', 'fx', 'gfx', 'zz'], 'm1');
    expect(plan.map((e) => e.id)).toEqual(['a', 'b', 'gfx']);
    expect(plan[0]!.grade).toEqual({ lut: { media: 'm1' } });
    expect(plan[1]!.grade).toEqual({ liftY: 0.2, lut: { media: 'm1' } });
    for (const e of plan) expect(e.clearKeys).toEqual([]);
    expect(planLutOn(clips, tracks, ['l'], 'm1')).toEqual([]);
  });

  it('a new lut keeps mix and order, tv goes', () => {
    const a = text('a', { gainR: 0.1, lut: { media: 'old', mix: 0.4, last: true, tv: true } });
    const [e] = planLutOn([a], tracks, ['a'], 'new');
    expect(e!.grade).toEqual({ gainR: 0.1, lut: { media: 'new', mix: 0.4, last: true } });
    expect(Object.keys(e!.grade!.lut!)).toEqual(['media', 'mix', 'last']);
  });

  it('the same lut again keeps made for', () => {
    const a = text('a', { gainR: 0.1, lut: { media: 'same', mix: 0.4, tv: true } });
    const [e] = planLutOn([a], tracks, ['a'], 'same');
    expect(e!.grade).toEqual({ gainR: 0.1, lut: { media: 'same', mix: 0.4, tv: true } });
  });

  it('planLutOff turns a lut only grade into none', () => {
    const only = text('a', { lut: { media: 'm1' } });
    const more = text('b', { liftY: 0.2, lut: { media: 'm1', mix: 0.5 } });
    const none = text('c', { liftY: 0.2 });
    const lockedOne = text('l', { lut: { media: 'm1' } }, 't2');
    const plan = planLutOff([only, more, none, lockedOne], tracks, ['a', 'b', 'c', 'l']);
    expect(plan.map((e) => e.id)).toEqual(['a', 'b']);
    expect(plan[0]!.grade).toBeNull();
    expect(plan[1]!.grade).toEqual({ liftY: 0.2 });
    // keys on the wheels: {} drops the grade and keeps them (null would wipe them)
    const keyed = createTextClip('t1', 0, { id: 'k', grade: { lut: { media: 'm1' } }, keyframes: { 'grade.liftY': [key(0, 0), key(1, 0.3)] } });
    expect(planLutOff([keyed], tracks, ['k'])[0]!.grade).toEqual({});
  });

  it('lutPatch clamps and drops false flags', () => {
    const g: ClipGrade = { gainR: 0.1, lut: { media: 'm1', mix: 0.5, last: true, tv: true } };
    expect(lutPatch(g, { mix: 3 }).lut).toEqual({ media: 'm1', last: true, tv: true });
    expect(lutPatch(g, { mix: -2 }).lut).toEqual({ media: 'm1', mix: 0, last: true, tv: true });
    expect(lutPatch(g, { mix: 0.123456 }).lut!.mix).toBe(0.1235);
    expect(lutPatch(g, { last: false }).lut).toEqual({ media: 'm1', mix: 0.5, tv: true });
    expect(lutPatch(g, { tv: false }).lut).toEqual({ media: 'm1', mix: 0.5, last: true });
    expect(lutPatch(g, { last: false, tv: false }).lut).toEqual({ media: 'm1', mix: 0.5 });
    expect(lutPatch(g, { mix: 0.2 }).gainR).toBe(0.1);
    // no lut and no media: as it was
    expect(lutPatch(g, {}).lut).toEqual(g.lut);
    const bare: ClipGrade = { liftY: 0.2 };
    expect(lutPatch(bare, { mix: 0.3 })).toBe(bare);
    expect(lutPatch(null, { last: true })).toEqual({});
    expect(lutPatch(bare, { media: 'm2' })).toEqual({ liftY: 0.2, lut: { media: 'm2' } });
  });

  it('keepKnownLut keeps only luts of this project', () => {
    const g: ClipGrade = { liftY: 0.2, lut: { media: 'm1', mix: 0.5 } };
    expect(keepKnownLut(g, [media('m1')])).toBe(g);
    const gone = keepKnownLut(g, [media('m2')]);
    expect(gone).toEqual({ liftY: 0.2 });
    expect(gone).not.toBe(g);
    expect(g.lut).toBeDefined();
    // a media of another kind is no lut
    expect(keepKnownLut(g, [media('m1', 'image')])).toEqual({ liftY: 0.2 });
    const plain: ClipGrade = { gainR: 0.1 };
    expect(keepKnownLut(plain, [])).toBe(plain);
  });

  it('lutSizeText', () => {
    expect(lutSizeText(undefined)).toBe('');
    expect(lutSizeText({ size3: 33, size1: 0 })).toBe('3d, 33 points');
    expect(lutSizeText({ size3: 0, size1: 4096 })).toBe('1d, 4096 points');
    expect(lutSizeText({ size3: 33, size1: 1024 })).toBe('1d and 3d, 33 points');
    expect(lutSizeText({ size3: 17, size1: 0, title: 'film' })).toBe('3d, 17 points · film');
    expect(lutSizeText({ size3: 0, size1: 0 })).toBe('');
  });
});
