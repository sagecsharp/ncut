import { describe, expect, it } from 'vitest';
import { createEffectClip, createShapeClip, createTextClip } from '../../lib/factory';
import type { Clip, ClipGrade, Track } from '../../types';
import { captureGrade, planGradeOnOff, planPasteGrade, planResetGrade } from './gradePlan';

const track = (id: string, locked = false): Track => ({ id, kind: 'video', name: id, muted: false, hidden: false, locked });
const tracks = [track('t1'), track('t2', true)];
const graded = (id: string, grade: ClipGrade = { liftY: 0.2 }, trackId = 't1'): Clip => createTextClip(trackId, 0, { id, grade });
const key = (t: number, v: number) => ({ t, v, ease: 'linear' as const });

describe('grade plans', () => {
  it('on / off: any shown turns all off, else all on', () => {
    const a = graded('a');
    const b = graded('b', { gainR: 0.3, off: true });
    const some = planGradeOnOff([a, b], tracks, ['a', 'b']);
    expect(some.on).toBe(false);
    expect(some.edits.map((e) => e.id)).toEqual(['a', 'b']);
    for (const e of some.edits) {
      expect(e.grade?.off).toBe(true);
      expect(e.clearKeys).toEqual([]);
    }
    expect(some.edits[1]!.grade).toEqual({ gainR: 0.3, off: true });
    const none = planGradeOnOff([graded('a', { liftY: 0.2, off: true }), b], tracks, ['a', 'b']);
    expect(none.on).toBe(true);
    for (const e of none.edits) expect(e.grade && 'off' in e.grade).toBe(false);
    expect(none.edits[0]!.grade).toEqual({ liftY: 0.2 });
  });

  it('on / off skips locked, ungraded and non grade clips', () => {
    const clips: Clip[] = [
      graded('a'),
      graded('locked', { liftY: 0.2 }, 't2'),
      createShapeClip('t1', 0, { id: 'plain' }),
      createEffectClip('blur', 'blur', 't1', 0, { id: 'blur' }),
      createEffectClip('grade', 'grade', 't1', 0, { id: 'ge', grade: { gammaB: -0.2 } }),
    ];
    const plan = planGradeOnOff(clips, tracks, ['a', 'locked', 'plain', 'blur', 'ge', 'ghost']);
    expect(plan.edits.map((e) => e.id)).toEqual(['a', 'ge']);
    expect(planGradeOnOff(clips, tracks, ['locked', 'plain'])).toEqual({ edits: [], on: true });
  });

  it('reset skips locked clips and clips that cannot grade', () => {
    const clips: Clip[] = [
      graded('a'),
      graded('locked', { liftY: 0.2 }, 't2'),
      createShapeClip('t1', 0, { id: 'plain' }),
      createEffectClip('blur', 'blur', 't1', 0, { id: 'blur' }),
    ];
    expect(planResetGrade(clips, tracks, ['a', 'locked', 'plain', 'blur'])).toEqual([{ id: 'a', grade: null, clearKeys: [] }]);
  });

  it('paste skips locked clips and clips that cannot grade', () => {
    const clips: Clip[] = [
      createShapeClip('t1', 0, { id: 'plain' }),
      graded('locked', { liftY: 0.2 }, 't2'),
      createEffectClip('blur', 'blur', 't1', 0, { id: 'blur' }),
      createEffectClip('grade', 'grade', 't1', 0, { id: 'ge' }),
    ];
    const grade: ClipGrade = { gainY: 0.1, curves: { y: [[0, 0], [0.5, 0.6], [1, 1]] } };
    const edits = planPasteGrade(clips, tracks, ['plain', 'locked', 'blur', 'ge'], grade);
    expect(edits.map((e) => e.id)).toEqual(['plain', 'ge']);
    expect(edits[0]!.grade).toEqual(grade);
    expect(edits[0]!.grade).not.toBe(grade);
    expect(edits[0]!.grade!.curves!.y).not.toBe(grade.curves!.y);
  });

  it('paste lists the keyed grade props to clear', () => {
    const c = createTextClip('t1', 0, { id: 'k', keyframes: { 'grade.liftR': [key(0, 0), key(1, 0.2)], 'grade.gainY': [], 'transform.x': [key(0, 1)] } });
    const edits = planPasteGrade([c], tracks, ['k'], { liftY: 0.1 });
    expect(edits[0]!.clearKeys).toEqual(['grade.liftR']);
  });

  it('captureGrade resolves the keys at the time, clamped into the clip', () => {
    const c = createTextClip('t1', 2, {
      id: 'k',
      duration: 4,
      grade: { gammaY: 0.1 },
      keyframes: { 'grade.liftR': [key(-2, -0.2), key(0, 0), key(4, 0.4), key(8, 0.8)] },
    });
    expect(captureGrade(c, 4).liftR).toBeCloseTo(0.2, 4);
    expect(captureGrade(c, 4).gammaY).toBe(0.1);
    expect(captureGrade(c, 100).liftR).toBeCloseTo(0.4, 4);
    expect(captureGrade(c, -5).liftR).toBeUndefined();
  });

  it('reset takes the lut, copy carries it', () => {
    const onlyLut = graded('a', { lut: { media: 'm1', mix: 0.5, last: true } });
    const withLut = graded('b', { liftY: 0.2, lut: { media: 'm1' } });
    // a lut only grade counts as a grade: reset takes it (null)
    expect(planResetGrade([onlyLut, withLut], tracks, ['a', 'b'])).toEqual([
      { id: 'a', grade: null, clearKeys: [] },
      { id: 'b', grade: null, clearKeys: [] },
    ]);
    // copy carries it
    expect(captureGrade(onlyLut, 0)).toEqual({ lut: { media: 'm1', mix: 0.5, last: true } });
    expect(captureGrade(withLut, 0)).toEqual({ liftY: 0.2, lut: { media: 'm1' } });
    // a lut at mix 0 is still a grade for the switch
    const zero = graded('c', { lut: { media: 'm1', mix: 0 } });
    expect(planGradeOnOff([zero], tracks, ['c']).edits).toHaveLength(1);
    // paste puts the copied lut on
    const [e] = planPasteGrade([graded('d', {})], tracks, ['d'], captureGrade(withLut, 0));
    expect(e!.grade).toEqual({ liftY: 0.2, lut: { media: 'm1' } });
  });

  it('captureGrade drops off and deep copies', () => {
    const grade: ClipGrade = { liftY: 0.3, off: true, curves: { y: [[0, 0], [0.5, 0.7], [1, 1]] } };
    const c = graded('a', grade);
    const got = captureGrade(c, 0);
    expect('off' in got).toBe(false);
    expect(got.liftY).toBe(0.3);
    expect(got.curves!.y).toEqual([[0, 0], [0.5, 0.7], [1, 1]]);
    expect(got.curves!.y).not.toBe(grade.curves!.y);
    expect(captureGrade(createShapeClip('t1', 0), 0)).toEqual({});
  });
});
