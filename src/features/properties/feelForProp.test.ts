import { describe, expect, it } from 'vitest';
import type { Clip } from '../../types';
import { EFFECTS } from '../../engine/effects/registry';
import { GRADE_EFFECT } from '../../lib/gradeData';
import { FEEL, effectFeel, feelCtx, feelOf, resolveFeel } from './fieldFeel';
import type { FeelEntry, FeelKey } from './fieldFeel';
import { feelForProp } from './feelForProp';

const of = (type: string, over: Record<string, unknown> = {}): Clip => ({ id: 'c', type, trackId: 't', start: 0, duration: 4, name: 'c', ...over }) as unknown as Clip;
const KEYS = Object.keys(FEEL) as FeelKey[];

describe('feelForProp', () => {
  it('every anim row is found', () => {
    let rows = 0;
    for (const key of KEYS) {
      const a = (FEEL[key] as FeelEntry).anim;
      if (!a) continue;
      for (const type of a.types) {
        rows++;
        expect(feelForProp(a.prop, of(type)), `${type} ${a.prop}`).toEqual(feelOf(key, feelCtx(1920, 1080)));
      }
    }
    expect(rows).toBeGreaterThan(100);
  });

  it('camera z and pan differ', () => {
    const cam = of('camera');
    const img = of('image');
    expect(feelForProp('z', cam)).toEqual(feelOf('cameraZ', feelCtx(1920, 1080)));
    expect(feelForProp('z', img)).toEqual(feelOf('z', feelCtx(1920, 1080)));
    expect(feelForProp('z', cam).soft).not.toEqual(feelForProp('z', img).soft);
    // the camera pan turns in degrees, a sound pan runs from left to right
    expect(feelForProp('pan', cam).unit).toBe('deg');
    expect(feelForProp('pan', of('video')).unit).toBe('');
    expect(feelForProp('pan', of('video')).scale).toBe(100);
    expect(feelForProp('pan', of('audio'))).toEqual(feelOf('soundPan', feelCtx(1920, 1080)));
  });

  it('grade on a grade effect', () => {
    const grade = of('effect', { effect: GRADE_EFFECT, params: {}, amount: 1 });
    const f = feelForProp('grade.liftR', grade);
    expect(f).toEqual(feelOf('gradeLiftR', feelCtx(1920, 1080)));
    expect(f.scale).toBe(100);
    expect(f.step).toBe(0.1);
    expect(feelForProp('grade.gainY', grade)).toEqual(feelOf('gradeGainY', feelCtx(1920, 1080)));
    // the amount of an effect is its own row
    expect(feelForProp('amount', grade)).toEqual(feelOf('effectAmount', feelCtx(1920, 1080)));
    // another effect has no grade values: the plain fallback
    const other = of('effect', { effect: 'not-grade', params: {}, amount: 1 });
    expect(feelForProp('grade.liftR', other)).toEqual(resolveFeel({ unit: '', soft: null, step: 0.01 }, feelCtx(1920, 1080)));
  });

  it('effect params use their def', () => {
    const def = EFFECTS.find((e) => e.params.length > 0)!;
    const clip = of('effect', { effect: def.id, params: {}, amount: 1 });
    for (const param of def.params) {
      expect(feelForProp(`p.${param.key}`, clip), param.key).toEqual(resolveFeel(effectFeel(param), feelCtx(1920, 1080)));
    }
    const first = def.params[0]!;
    const f = feelForProp(`p.${first.key}`, clip);
    expect(f.min).toBe(first.min);
    expect(f.max).toBe(first.max);
    expect(f.step).toBe(first.step);
    expect(f.rest).toBe(first.default);
  });

  it('other values fall back', () => {
    const plain = resolveFeel({ unit: '', soft: null, step: 0.01 }, feelCtx(1920, 1080));
    expect(feelForProp('nope', of('image'))).toEqual(plain);
    // an effect param key that is not there, and a p. value of a clip that is no effect
    const def = EFFECTS.find((e) => e.params.length > 0)!;
    expect(feelForProp('p.nope', of('effect', { effect: def.id, params: {}, amount: 1 }))).toEqual(plain);
    expect(feelForProp(`p.${def.params[0]!.key}`, of('image'))).toEqual(plain);
    // an effect that is gone
    expect(feelForProp('p.size', of('effect', { effect: 'gone', params: {}, amount: 1 }))).toEqual(plain);
    // a row of another clip type is not taken: text size on an image
    expect(feelForProp('fontSize', of('image'))).toEqual(plain);
    expect(feelForProp('fontSize', of('text')).unit).toBe('px');
  });

  it('the ctx moves the soft range', () => {
    const small = feelCtx(1000, 500);
    expect(feelForProp('x', of('image')).soft).toEqual([-960, 960]);
    expect(feelForProp('x', of('image'), small).soft).toEqual([-500, 500]);
    expect(feelForProp('y', of('video'), small).soft).toEqual([-250, 250]);
    expect(feelForProp('z', of('camera'), small)).toEqual(feelOf('cameraZ', small));
    expect(feelForProp('z', of('camera'), small).soft).not.toEqual(feelForProp('z', of('camera')).soft);
    // hard limits and steps do not move
    expect(feelForProp('opacity', of('image'), small).max).toBe(100);
    expect(feelForProp('opacity', of('image'), small).step).toBe(1);
  });
});
