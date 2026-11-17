import { describe, expect, it } from 'vitest';
import type { Clip, EffectClip, ImageClip, Keyframe, ShapeClip, TextClip, VideoClip } from '../types';
import { DEFAULT_TRANSFORM } from '../types';
import { animProps, animatesPicture, baseValue, resolveClip, valueAt, withBaseValue, withKeyAt, withValueAt } from './anim';
import { createShapeClip, createTextClip } from './factory';
import { GRADE_EFFECT, GRADE_KEYS, GRADE_LABEL, GRADE_PROPS } from './gradeData';

const base = { trackId: 't', start: 2, duration: 10, name: 'c', fadeIn: 0, fadeOut: 0 };
const video = (o: Partial<VideoClip> = {}): VideoClip => ({
  ...base,
  id: 'v',
  type: 'video',
  assetId: 'a',
  trimStart: 0,
  speed: 1,
  volume: 1,
  muted: false,
  transform: { ...DEFAULT_TRANSFORM },
  ...o,
});
const image = (o: Partial<ImageClip> = {}): ImageClip => ({ ...base, id: 'i', type: 'image', assetId: 'a', transform: { ...DEFAULT_TRANSFORM }, ...o });
const text = (o: Partial<TextClip> = {}): TextClip => createTextClip('t', 2, { duration: 10, ...o });
const shape = (o: Partial<ShapeClip> = {}): ShapeClip => createShapeClip('t', 2, { duration: 10, ...o });
const effect = (id: string, o: Partial<EffectClip> = {}): EffectClip => ({ ...base, id: 'e', type: 'effect', effect: id, amount: 1, params: {}, seed: 0, ...o });
const k = (t: number, v: number, ease: Keyframe['ease'] = 'linear'): Keyframe => ({ t, v, ease });
const names = (c: Clip) => animProps(c).map((p) => p.prop);

describe('grade rows', () => {
  it('every picture clip lists the 16 wheel numbers, in order', () => {
    for (const c of [video(), image(), text(), shape()]) {
      const got = names(c).filter((p) => p.startsWith('grade.'));
      expect(got).toEqual(GRADE_PROPS);
    }
  });
  it('a grade effect lists amount and the 16', () => {
    expect(names(effect(GRADE_EFFECT))).toEqual(['amount', ...GRADE_PROPS]);
  });
  it('another effect lists amount only', () => {
    expect(names(effect('shake'))).toEqual(['amount']);
    expect(names(effect('blur'))).toEqual(['amount']);
  });
  it('audio and camera have no grade', () => {
    const audio: Clip = { ...base, id: 'a', type: 'audio', assetId: 'a', trimStart: 0, speed: 1, volume: 1, muted: false };
    expect(names(audio).some((p) => p.startsWith('grade.'))).toBe(false);
  });
  it('the rows are -1..1 with the grade labels', () => {
    const rows = animProps(video()).filter((p) => p.prop.startsWith('grade.'));
    expect(rows).toHaveLength(16);
    rows.forEach((r, i) => {
      expect(r.min).toBe(-1);
      expect(r.max).toBe(1);
      expect(r.label).toBe(GRADE_LABEL[GRADE_KEYS[i]!]);
    });
    expect(animProps(effect(GRADE_EFFECT)).find((p) => p.prop === 'grade.gainY')).toEqual({ prop: 'grade.gainY', label: 'gain level', min: -1, max: 1 });
  });
});

describe('grade values', () => {
  it('a missing grade or key reads 0', () => {
    expect(baseValue(video(), 'grade.liftR')).toBe(0);
    expect(baseValue(video({ grade: null }), 'grade.gainY')).toBe(0);
    expect(baseValue(video({ grade: { liftG: 0.4 } }), 'grade.liftR')).toBe(0);
    expect(baseValue(video({ grade: { liftG: 0.4 } }), 'grade.liftG')).toBe(0.4);
    expect(baseValue(effect(GRADE_EFFECT), 'grade.offsetB')).toBe(0);
    expect(baseValue(effect(GRADE_EFFECT, { grade: { offsetB: -0.3 } }), 'grade.offsetB')).toBe(-0.3);
  });
  it('another effect has no grade property', () => {
    expect(baseValue(effect('shake'), 'grade.liftR')).toBeUndefined();
    expect(withBaseValue(effect('shake'), 'grade.liftR', 0.5)).toEqual(effect('shake'));
  });
  it('withBaseValue makes { liftR: v } and keeps the rest', () => {
    const w = withBaseValue(video(), 'grade.liftR', 0.25);
    expect(w.grade).toEqual({ liftR: 0.25 });
    const x = withBaseValue(video({ grade: { gainY: 0.1, curves: { y: [[0, 0], [1, 0.9]] } } }), 'grade.liftB', -0.5);
    expect(x.grade).toEqual({ gainY: 0.1, liftB: -0.5, curves: { y: [[0, 0], [1, 0.9]] } });
    const e = withBaseValue(effect(GRADE_EFFECT), 'grade.gammaY', 0.2);
    expect(e.grade).toEqual({ gammaY: 0.2 });
    // the old clip is untouched
    expect(video().grade).toBeUndefined();
  });
  it('withBaseValue works on every picture clip', () => {
    for (const c of [image(), text(), shape()]) expect(withBaseValue(c, 'grade.gainR', 0.5).grade).toEqual({ gainR: 0.5 });
  });
  it('valueAt and withValueAt follow the keys', () => {
    const c = video({ keyframes: { 'grade.liftY': [k(0, 0), k(10, 1)] } });
    expect(valueAt(c, 'grade.liftY', 7)).toBeCloseTo(0.5, 9);
    expect(valueAt(video(), 'grade.liftY', 7)).toBe(0);
    expect(withValueAt(c, 'grade.liftY', 7, 0.8).keyframes!['grade.liftY']!).toHaveLength(3);
    expect(withKeyAt(effect(GRADE_EFFECT, { grade: { liftY: 0.3 } }), 'grade.liftY', 3).keyframes!['grade.liftY']).toEqual([{ t: 1, v: 0.3, ease: 'ease' }]);
  });
});

describe('resolveClip with grade keys', () => {
  const curves = { y: [[0, 0], [0.5, 0.6], [1, 1]] as [number, number][] };
  it('a video leaves the stored grade alone and keeps the curves object', () => {
    const stored = { gainY: 0.1, curves };
    const c = video({ grade: stored, keyframes: { 'grade.liftR': [k(0, 0), k(10, 1)], 'grade.gainY': [k(0, 0), k(10, -1)] } });
    const r = resolveClip(c, 7);
    expect(r).not.toBe(c);
    expect(r.grade).not.toBe(stored);
    expect(r.grade!.liftR).toBeCloseTo(0.5, 9);
    expect(r.grade!.gainY).toBeCloseTo(-0.5, 9);
    expect(r.grade!.curves).toBe(curves);
    expect(stored).toEqual({ gainY: 0.1, curves });
    expect(c.grade).toBe(stored);
  });
  it('one copy of the grade for several keys', () => {
    const c = video({ keyframes: { 'grade.liftR': [k(0, 0.1)], 'grade.liftG': [k(0, 0.2)], 'grade.liftB': [k(0, 0.3)] } });
    const r = resolveClip(c, 5);
    expect(r.grade).toEqual({ liftR: 0.1, liftG: 0.2, liftB: 0.3 });
  });
  it('equals withBaseValue key by key', () => {
    const c = video({ grade: { offsetY: 0.2 }, keyframes: { 'grade.gammaR': [k(0, -1), k(10, 1)], 'grade.offsetB': [k(0, 0.4)] } });
    let w: Clip = c;
    for (const p of ['grade.gammaR', 'grade.offsetB']) w = withBaseValue(w, p, valueAt(c, p, 6)!);
    expect(resolveClip(c, 6).grade).toEqual((w as VideoClip).grade);
  });
  it('a grade effect leaves the stored grade alone and keeps the curves object', () => {
    const stored = { liftY: 0.1, curves };
    const c = effect(GRADE_EFFECT, { grade: stored, keyframes: { 'grade.gainB': [k(0, 0), k(10, 0.8)], amount: [k(0, 1)] } });
    const r = resolveClip(c, 7);
    expect(r.grade).not.toBe(stored);
    expect(r.grade!.gainB).toBeCloseTo(0.4, 9);
    expect(r.grade!.liftY).toBe(0.1);
    expect(r.grade!.curves).toBe(curves);
    expect(stored).toEqual({ liftY: 0.1, curves });
  });
  it('a grade key on another effect is left alone', () => {
    const c = effect('shake', { keyframes: { 'grade.gainB': [k(0, 0.5)] } });
    expect(resolveClip(c, 3)).toBe(c);
  });
  it('a grade effect without a stored grade gets one', () => {
    const r = resolveClip(effect(GRADE_EFFECT, { keyframes: { 'grade.liftR': [k(0, 0.5)] } }), 3);
    expect(r.grade).toEqual({ liftR: 0.5 });
  });
});

describe('animatesPicture', () => {
  it('a keyed wheel number changes the picture', () => {
    expect(animatesPicture(video({ keyframes: { 'grade.liftR': [k(0, 0.1)] } }))).toBe(true);
    expect(animatesPicture(text({ keyframes: { 'grade.gainY': [k(0, 0.1)] } }))).toBe(true);
    expect(animatesPicture(video({ keyframes: { 'grade.liftR': [] } }))).toBe(false);
    expect(animatesPicture(video({ keyframes: { x: [k(0, 0)] } }))).toBe(false);
  });
});
