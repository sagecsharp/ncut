import { describe, expect, it } from 'vitest';
import type { AudioClip, CameraClip, Clip, Easing, EffectClip, ImageClip, Keyframe, ShapeClip, TextClip, VideoClip } from '../types';
import { DEFAULT_TRANSFORM } from '../types';
import { createShapeClip } from './factory';
import {
  EASINGS,
  KEY_EPS,
  animProps,
  applyEasing,
  baseValue,
  evalKeys,
  hasKeyframes,
  isAnimated,
  keyIndexAt,
  keyTimes,
  resolveClip,
  shiftKeyframes,
  valueAt,
  withBaseValue,
  withKey,
  withKeyAt,
  withValueAt,
  withoutKey,
  withoutKeyAt,
  withoutKeys,
} from './anim';

const base = { trackId: 't', start: 0, duration: 10, name: 'c', fadeIn: 0, fadeOut: 0 };
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
const image = (o: Partial<ImageClip> = {}): ImageClip => ({
  ...base,
  id: 'i',
  type: 'image',
  assetId: 'a',
  transform: { ...DEFAULT_TRANSFORM },
  ...o,
});
const text = (o: Partial<TextClip> = {}): TextClip => ({
  ...base,
  id: 'x',
  type: 'text',
  text: 'hi',
  fontFamily: 'Kode Mono',
  fontSize: 80,
  fontWeight: 400,
  italic: false,
  color: '#fff',
  background: null,
  align: 'center',
  transform: { ...DEFAULT_TRANSFORM },
  ...o,
});
const audio = (o: Partial<AudioClip> = {}): AudioClip => ({
  ...base,
  id: 'au',
  type: 'audio',
  assetId: 'a',
  trimStart: 0,
  speed: 1,
  volume: 0.5,
  muted: false,
  ...o,
});
const effect = (o: Partial<EffectClip> = {}): EffectClip => ({
  ...base,
  id: 'fx',
  type: 'effect',
  effect: 'shake',
  amount: 0.8,
  params: { strength: 40 },
  seed: 1,
  ...o,
});
const camera = (o: Partial<CameraClip> = {}): CameraClip => ({
  ...base,
  id: 'cam',
  type: 'camera',
  x: 1,
  y: 2,
  z: 3,
  pan: 4,
  tilt: 5,
  roll: 6,
  fov: 50,
  ...o,
});
const k = (t: number, v: number, ease: Easing = 'linear'): Keyframe => ({ t, v, ease });

describe('applyEasing', () => {
  const all = EASINGS.map((e) => e.id);
  it('lists every easing once', () => {
    expect(all).toHaveLength(8);
    expect(new Set(all).size).toBe(8);
  });
  it('clamps u at 0 for every easing', () => {
    for (const e of all) {
      expect(applyEasing(e, 0), e).toBe(0);
      expect(applyEasing(e, -1), e).toBe(0);
    }
  });
  it('reaches 1 at u = 1 for every easing but hold', () => {
    for (const e of all.filter((x) => x !== 'hold')) {
      expect(applyEasing(e, 1), e).toBe(1);
      expect(applyEasing(e, 5), e).toBe(1);
    }
  });
  it('hold stays at the start value for the whole segment', () => {
    for (const u of [0, 0.01, 0.5, 0.99, 1, 2]) expect(applyEasing('hold', u)).toBe(0);
  });
  it('linear is the identity', () => {
    for (const u of [0.1, 0.25, 0.5, 0.9]) expect(applyEasing('linear', u)).toBeCloseTo(u, 12);
  });
  it('ease (smoothstep) is 0.5 in the middle and symmetric', () => {
    expect(applyEasing('ease', 0.5)).toBeCloseTo(0.5, 12);
    expect(applyEasing('ease', 0.2) + applyEasing('ease', 0.8)).toBeCloseTo(1, 12);
    expect(applyEasing('ease', 0.25)).toBeLessThan(0.25);
  });
  it('ease-in starts slow and ease-out starts fast', () => {
    expect(applyEasing('ease-in', 0.5)).toBeCloseTo(0.125, 12);
    expect(applyEasing('ease-out', 0.5)).toBeCloseTo(0.875, 12);
    expect(applyEasing('ease-in', 0.3)).toBeLessThan(0.3);
    expect(applyEasing('ease-out', 0.3)).toBeGreaterThan(0.3);
  });
  it('monotonic easings never decrease', () => {
    for (const e of ['linear', 'ease', 'ease-in', 'ease-out'] as Easing[]) {
      let prev = 0;
      for (let i = 1; i <= 100; i++) {
        const v = applyEasing(e, i / 100);
        expect(v, `${e} ${i}`).toBeGreaterThanOrEqual(prev - 1e-12);
        prev = v;
      }
    }
  });
  it('back overshoots past 1 before settling', () => {
    let max = 0;
    for (let i = 1; i < 100; i++) max = Math.max(max, applyEasing('back', i / 100));
    expect(max).toBeGreaterThan(1.05);
  });
  it('elastic overshoots past 1 and swings around it', () => {
    let max = 0;
    let min = 2;
    for (let i = 1; i < 100; i++) {
      const v = applyEasing('elastic', i / 100);
      max = Math.max(max, v);
      min = Math.min(min, v);
    }
    expect(max).toBeGreaterThan(1);
    expect(min).toBeLessThan(1);
  });
  it('bounce stays inside 0..1', () => {
    for (let i = 0; i <= 200; i++) {
      const v = applyEasing('bounce', i / 200);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1 + 1e-12);
    }
  });
  it('bounce first reaches the end value at u = 1 / 2.75', () => {
    expect(applyEasing('bounce', 1 / 2.75 - 1e-9)).toBeCloseTo(1, 3);
  });
});

describe('evalKeys', () => {
  const keys = [k(1, 10, 'linear'), k(3, 30, 'linear'), k(7, 10, 'linear')];
  it('uses the first value before the first key', () => {
    expect(evalKeys(keys, -5)).toBe(10);
    expect(evalKeys(keys, 0)).toBe(10);
  });
  it('uses the last value after the last key', () => {
    expect(evalKeys(keys, 7)).toBe(10);
    expect(evalKeys(keys, 100)).toBe(10);
  });
  it('is exact on every key', () => {
    expect(evalKeys(keys, 1)).toBe(10);
    expect(evalKeys(keys, 3)).toBe(30);
    expect(evalKeys(keys, 7)).toBe(10);
  });
  it('interpolates between keys', () => {
    expect(evalKeys(keys, 2)).toBeCloseTo(20, 9);
    expect(evalKeys(keys, 5)).toBeCloseTo(20, 9);
    expect(evalKeys(keys, 6)).toBeCloseTo(15, 9);
  });
  it('a single key is a constant', () => {
    const one = [k(2, 7)];
    for (const t of [-1, 2, 9]) expect(evalKeys(one, t)).toBe(7);
  });
  it('uses the easing of the key that starts the segment', () => {
    const ks = [k(0, 0, 'ease-in'), k(2, 8, 'ease-out')];
    expect(evalKeys(ks, 1)).toBeCloseTo(8 * 0.125, 9);
    const ks2 = [k(0, 0, 'ease-out'), k(2, 8, 'ease-in')];
    expect(evalKeys(ks2, 1)).toBeCloseTo(8 * 0.875, 9);
  });
  it('hold keeps the start value until the next key, then jumps', () => {
    const ks = [k(0, 1, 'hold'), k(2, 5, 'hold'), k(4, 9, 'hold')];
    expect(evalKeys(ks, 1.999)).toBe(1);
    expect(evalKeys(ks, 2)).toBe(5);
    expect(evalKeys(ks, 3.5)).toBe(5);
    expect(evalKeys(ks, 4)).toBe(9);
  });
  it('works with decreasing values and negative values', () => {
    const ks = [k(0, 5), k(1, -5)];
    expect(evalKeys(ks, 0.5)).toBeCloseTo(0, 12);
    expect(evalKeys(ks, 0.25)).toBeCloseTo(2.5, 12);
  });
  it('finds the right segment in a long list (binary search)', () => {
    const many = Array.from({ length: 50 }, (_, i) => k(i, i * 2));
    for (let i = 0; i < 49; i++) expect(evalKeys(many, i + 0.5)).toBeCloseTo(i * 2 + 1, 9);
  });
  it('back easing overshoots the target between two keys', () => {
    const ks = [k(0, 0, 'back'), k(1, 100)];
    let max = 0;
    for (let i = 1; i < 100; i++) max = Math.max(max, evalKeys(ks, i / 100));
    expect(max).toBeGreaterThan(100);
  });
  it('does not mutate the keys', () => {
    const copy = JSON.parse(JSON.stringify(keys));
    evalKeys(keys, 2);
    expect(keys).toEqual(copy);
  });
});

describe('keyIndexAt', () => {
  const keys = [k(0, 0), k(1, 1), k(2, 2)];
  it('finds a key exactly', () => {
    expect(keyIndexAt(keys, 1)).toBe(1);
    expect(keyIndexAt(keys, 0)).toBe(0);
    expect(keyIndexAt(keys, 2)).toBe(2);
  });
  it('allows the default tolerance', () => {
    expect(keyIndexAt(keys, 1 + KEY_EPS / 2)).toBe(1);
    expect(keyIndexAt(keys, 1 - KEY_EPS / 2)).toBe(1);
  });
  it('rejects times outside the tolerance', () => {
    expect(keyIndexAt(keys, 1 + KEY_EPS * 10)).toBe(-1);
    expect(keyIndexAt(keys, 5)).toBe(-1);
  });
  it('takes a custom tolerance', () => {
    expect(keyIndexAt(keys, 1.02, 0.05)).toBe(1);
    expect(keyIndexAt(keys, 1.02, 0.01)).toBe(-1);
  });
  it('is -1 on an empty list', () => {
    expect(keyIndexAt([], 0)).toBe(-1);
  });
});

describe('withKey / withoutKey', () => {
  it('inserts keeping the list sorted', () => {
    let ks: Keyframe[] = [];
    for (const t of [3, 1, 2, 0.5, 10]) ks = withKey(ks, t, t * 10);
    expect(ks.map((x) => x.t)).toEqual([0.5, 1, 2, 3, 10]);
    expect(ks.map((x) => x.v)).toEqual([5, 10, 20, 30, 100]);
  });
  it('replaces the key at the same time instead of adding one', () => {
    const ks = withKey([k(1, 1, 'bounce'), k(2, 2)], 1, 99);
    expect(ks).toHaveLength(2);
    expect(ks[0]).toEqual({ t: 1, v: 99, ease: 'bounce' });
  });
  it('replacing with an explicit ease changes the ease', () => {
    const ks = withKey([k(1, 1, 'bounce')], 1, 5, 'hold');
    expect(ks[0]!.ease).toBe('hold');
  });
  it('a key inside the tolerance replaces too and keeps the old time', () => {
    const ks = withKey([k(1, 1)], 1 + KEY_EPS / 4, 7);
    expect(ks).toHaveLength(1);
    expect(ks[0]!.t).toBe(1);
    expect(ks[0]!.v).toBe(7);
  });
  it('a new key inherits the easing of the key before it', () => {
    const ks = withKey([k(0, 0, 'back'), k(4, 4, 'hold')], 2, 9);
    expect(ks[1]).toEqual({ t: 2, v: 9, ease: 'back' });
  });
  it('a new first key (nothing before it) defaults to ease', () => {
    expect(withKey([], 1, 1)[0]!.ease).toBe('ease');
    expect(withKey([k(5, 5, 'hold')], 1, 1)[0]!.ease).toBe('ease');
  });
  it('an explicit ease wins over the inherited one', () => {
    expect(withKey([k(0, 0, 'back')], 2, 2, 'elastic')[1]!.ease).toBe('elastic');
  });
  it('does not mutate the input', () => {
    const ks = [k(0, 0), k(2, 2)];
    const out = withKey(ks, 1, 1);
    expect(ks).toHaveLength(2);
    expect(out).not.toBe(ks);
    const out2 = withKey(ks, 2, 5);
    expect(ks[1]!.v).toBe(2);
    expect(out2[1]!.v).toBe(5);
  });
  it('withoutKey removes the key at the time', () => {
    const ks = [k(0, 0), k(1, 1), k(2, 2)];
    expect(withoutKey(ks, 1).map((x) => x.t)).toEqual([0, 2]);
    expect(ks).toHaveLength(3);
  });
  it('withoutKey returns the same list when nothing is there', () => {
    const ks = [k(0, 0), k(1, 1)];
    expect(withoutKey(ks, 0.5)).toBe(ks);
  });
  it('withoutKey takes a tolerance', () => {
    const ks = [k(0, 0), k(1, 1)];
    expect(withoutKey(ks, 1.03, 0.05)).toHaveLength(1);
    expect(withoutKey(ks, 1.03, 0.01)).toBe(ks);
  });
});

describe('shiftKeyframes', () => {
  it('moves every key of every property', () => {
    const out = shiftKeyframes({ x: [k(0, 1), k(2, 3)], y: [k(1, 5)] }, 1.5)!;
    expect(out.x!.map((a) => a.t)).toEqual([1.5, 3.5]);
    expect(out.y![0]!.t).toBe(2.5);
    expect(out.x![0]!.v).toBe(1);
  });
  it('supports negative shifts', () => {
    expect(shiftKeyframes({ x: [k(3, 1)] }, -2)!.x![0]!.t).toBe(1);
  });
  it('returns the same object for 0 and undefined', () => {
    const kf = { x: [k(0, 1)] };
    expect(shiftKeyframes(kf, 0)).toBe(kf);
    expect(shiftKeyframes(undefined, 5)).toBeUndefined();
  });
  it('does not mutate', () => {
    const kf = { x: [k(1, 1)] };
    shiftKeyframes(kf, 4);
    expect(kf.x[0]!.t).toBe(1);
  });
});

describe('keyTimes', () => {
  it('is empty without keyframes', () => {
    expect(keyTimes(undefined)).toEqual([]);
    expect(keyTimes({})).toEqual([]);
  });
  it('merges over props, sorted and de-duplicated', () => {
    const kf = { x: [k(2, 0), k(0, 0)], y: [k(1, 0), k(2, 5)], scale: [k(4, 1)] };
    expect(keyTimes(kf)).toEqual([0, 1, 2, 4]);
  });
  it('merges times closer than KEY_EPS', () => {
    expect(keyTimes({ x: [k(1, 0)], y: [k(1 + KEY_EPS / 2, 0)] })).toHaveLength(1);
  });
  it('can be limited to one prop', () => {
    const kf = { x: [k(0, 0), k(1, 0)], y: [k(2, 0)] };
    expect(keyTimes(kf, 'y')).toEqual([2]);
    expect(keyTimes(kf, 'nope')).toEqual([]);
  });
});

describe('animProps', () => {
  const names = (c: Clip) => animProps(c).map((p) => p.prop);
  // the look values come after these (animLook.test.ts has them)
  it('video: transform props + z/tilt/turn + volume', () => {
    expect(names(video()).slice(0, 9)).toEqual(['x', 'y', 'scale', 'rotation', 'opacity', 'z', 'rotX', 'rotY', 'volume']);
  });
  it('image and text: transform props, no volume', () => {
    expect(names(image()).slice(0, 8)).toEqual(['x', 'y', 'scale', 'rotation', 'opacity', 'z', 'rotX', 'rotY']);
    expect(names(text()).slice(0, 8)).toEqual(names(image()).slice(0, 8));
    expect(names(image())).not.toContain('volume');
  });
  it('audio: volume only', () => {
    expect(names(audio())).toEqual(['volume']);
  });
  it('effect: amount only (params come from the effect def)', () => {
    expect(names(effect())).toEqual(['amount']);
  });
  it('camera: xyz, pan, tilt, roll, fov, focus distance and blur', () => {
    expect(names(camera())).toEqual(['x', 'y', 'z', 'pan', 'tilt', 'roll', 'fov', 'focusDistance', 'focusStrength']);
  });
  it('has plain labels for the 3d fields', () => {
    const l = Object.fromEntries(animProps(video()).map((p) => [p.prop, p.label]));
    expect(l.rotX).toBe('tilt');
    expect(l.rotY).toBe('turn');
  });
  it('has the documented ranges', () => {
    const p = Object.fromEntries(animProps(video()).map((a) => [a.prop, a]));
    expect(p.opacity).toMatchObject({ min: 0, max: 1 });
    expect(p.scale!.min).toBeGreaterThan(0);
    expect(p.volume).toMatchObject({ min: 0, max: 2 });
    expect(p.x!.min).toBeUndefined();
    const fov = animProps(camera()).find((a) => a.prop === 'fov')!;
    expect(fov.min).toBeLessThan(50);
    expect(fov.max).toBeGreaterThan(50);
  });
  it('every prop has a label and is unique', () => {
    for (const c of [video(), image(), text(), audio(), effect(), camera()]) {
      const ns = names(c);
      expect(new Set(ns).size).toBe(ns.length);
      for (const p of animProps(c)) expect(p.label.length).toBeGreaterThan(0);
    }
  });
});

describe('baseValue / withBaseValue', () => {
  it('reads transform fields of visual clips', () => {
    const v = video({ transform: { x: 5, y: 6, scale: 2, rotation: 30, opacity: 0.5, z: 7, rotX: 8, rotY: 9 } });
    const got = ['x', 'y', 'scale', 'rotation', 'opacity', 'z', 'rotX', 'rotY'].map((p) => baseValue(v, p));
    expect(got).toEqual([5, 6, 2, 30, 0.5, 7, 8, 9]);
  });
  it('missing 3d fields read as 0', () => {
    const v = image();
    expect(baseValue(v, 'z')).toBe(0);
    expect(baseValue(v, 'rotX')).toBe(0);
    expect(baseValue(v, 'rotY')).toBe(0);
  });
  it('volume exists on video and audio only', () => {
    expect(baseValue(video({ volume: 0.7 }), 'volume')).toBe(0.7);
    expect(baseValue(audio(), 'volume')).toBe(0.5);
    expect(baseValue(image(), 'volume')).toBeUndefined();
    expect(baseValue(text(), 'volume')).toBeUndefined();
  });
  it('unknown props are undefined', () => {
    for (const c of [video(), image(), text(), audio(), effect(), camera()]) expect(baseValue(c, 'nope')).toBeUndefined();
    expect(baseValue(audio(), 'x')).toBeUndefined();
    expect(baseValue(camera(), 'scale')).toBeUndefined();
    expect(baseValue(effect(), 'x')).toBeUndefined();
  });
  it('effect: amount and p.<key>', () => {
    const e = effect();
    expect(baseValue(e, 'amount')).toBe(0.8);
    expect(baseValue(e, 'p.strength')).toBe(40);
    expect(baseValue(e, 'p.speed')).toBeUndefined();
  });
  it('camera fields', () => {
    const c = camera();
    expect(['x', 'y', 'z', 'pan', 'tilt', 'roll', 'fov'].map((p) => baseValue(c, p))).toEqual([1, 2, 3, 4, 5, 6, 50]);
  });
  it('camera focus: blur is 0 when missing, a missing distance stays unknown', () => {
    const c = camera();
    expect(baseValue(c, 'focusStrength')).toBe(0);
    expect(baseValue(c, 'focusDistance')).toBeUndefined();
    const f = camera({ focusStrength: 0.4, focusDistance: 900 });
    expect(baseValue(f, 'focusStrength')).toBe(0.4);
    expect(baseValue(f, 'focusDistance')).toBe(900);
  });
  it('camera focus: keyframes rack the focus and resolve into the clip', () => {
    const c = camera({ focusStrength: 1, focusDistance: 500, keyframes: { focusDistance: [k(0, 500), k(2, 1500)] } });
    expect(valueAt(c, 'focusDistance', c.start + 1)).toBe(1000);
    const r = resolveClip(c, c.start + 1);
    expect(r.focusDistance).toBe(1000);
    expect(r.focusStrength).toBe(1);
    expect(withBaseValue(camera(), 'focusStrength', 0.5).focusStrength).toBe(0.5);
    expect(withBaseValue(camera(), 'focusDistance', 700).focusDistance).toBe(700);
  });
  it('withBaseValue sets every kind without mutating', () => {
    const v = video();
    const v2 = withBaseValue(v, 'z', 55);
    expect(v2.transform.z).toBe(55);
    expect(v.transform.z).toBeUndefined();
    expect(withBaseValue(v, 'rotX', 12).transform.rotX).toBe(12);
    expect(withBaseValue(v, 'rotY', -12).transform.rotY).toBe(-12);
    expect(withBaseValue(v, 'opacity', 0.1).transform.opacity).toBe(0.1);
    expect(withBaseValue(v, 'volume', 1.5).volume).toBe(1.5);
    expect(withBaseValue(audio(), 'volume', 0.1).volume).toBe(0.1);
    expect(withBaseValue(effect(), 'amount', 0.2).amount).toBe(0.2);
    const e = effect();
    const e2 = withBaseValue(e, 'p.speed', 9);
    expect(e2.params).toEqual({ strength: 40, speed: 9 });
    expect(e.params).toEqual({ strength: 40 });
    expect(withBaseValue(camera(), 'fov', 70).fov).toBe(70);
    expect(withBaseValue(camera(), 'roll', -3).roll).toBe(-3);
  });
  it('withBaseValue returns the clip itself for unknown props', () => {
    const v = video();
    expect(withBaseValue(v, 'nope', 1)).toBe(v);
    const i = image();
    expect(withBaseValue(i, 'volume', 1)).toBe(i);
    const a = audio();
    expect(withBaseValue(a, 'x', 1)).toBe(a);
    const e = effect();
    expect(withBaseValue(e, 'x', 1)).toBe(e);
    const c = camera();
    expect(withBaseValue(c, 'scale', 1)).toBe(c);
  });
});

describe('isAnimated / hasKeyframes', () => {
  it('false without keyframes', () => {
    expect(isAnimated(video(), 'x')).toBe(false);
    expect(hasKeyframes(video())).toBe(false);
  });
  it('true when a prop has keys', () => {
    const v = video({ keyframes: { x: [k(0, 1)] } });
    expect(isAnimated(v, 'x')).toBe(true);
    expect(isAnimated(v, 'y')).toBe(false);
    expect(hasKeyframes(v)).toBe(true);
  });
  it('an empty list does not count', () => {
    const v = video({ keyframes: { x: [] } });
    expect(isAnimated(v, 'x')).toBe(false);
    expect(hasKeyframes(v)).toBe(false);
    expect(hasKeyframes(video({ keyframes: {} }))).toBe(false);
  });
});

describe('valueAt', () => {
  it('falls back to the static value', () => {
    expect(valueAt(video({ transform: { ...DEFAULT_TRANSFORM, x: 42 } }), 'x', 3)).toBe(42);
    expect(valueAt(video(), 'nope', 0)).toBeUndefined();
  });
  it('evaluates keys in clip-local time (clip.start offset)', () => {
    const v = video({ start: 5, keyframes: { x: [k(0, 0), k(2, 100)] } });
    expect(valueAt(v, 'x', 5)).toBe(0);
    expect(valueAt(v, 'x', 6)).toBeCloseTo(50, 9);
    expect(valueAt(v, 'x', 7)).toBe(100);
    expect(valueAt(v, 'x', 0)).toBe(0);
    expect(valueAt(v, 'x', 50)).toBe(100);
  });
  it('works for effect params and camera props', () => {
    const e = effect({ start: 2, keyframes: { 'p.strength': [k(0, 0), k(4, 80)] } });
    expect(valueAt(e, 'p.strength', 4)).toBeCloseTo(40, 9);
    const c = camera({ start: 1, keyframes: { fov: [k(0, 30), k(2, 70)] } });
    expect(valueAt(c, 'fov', 2)).toBeCloseTo(50, 9);
  });
});

describe('resolveClip', () => {
  it('returns the very same object without keyframes', () => {
    const v = video();
    expect(resolveClip(v, 3)).toBe(v);
  });
  it('returns the clip when all key lists are empty', () => {
    const v = video({ keyframes: { x: [] } });
    expect(resolveClip(v, 1)).toBe(v);
  });
  it('bakes transform fields', () => {
    const v = video({
      start: 2,
      keyframes: { x: [k(0, 0), k(4, 400)], opacity: [k(0, 1), k(4, 0)], z: [k(0, 0), k(4, 100)], rotY: [k(0, 0), k(4, 90)] },
    });
    const r = resolveClip(v, 4);
    expect(r.transform.x).toBeCloseTo(200, 9);
    expect(r.transform.opacity).toBeCloseTo(0.5, 9);
    expect(r.transform.z).toBeCloseTo(50, 9);
    expect(r.transform.rotY).toBeCloseTo(45, 9);
    expect(r.transform.scale).toBe(1);
  });
  it('bakes volume', () => {
    const v = video({ keyframes: { volume: [k(0, 0), k(2, 2)] } });
    expect(resolveClip(v, 1).volume).toBeCloseTo(1, 9);
    const a = audio({ keyframes: { volume: [k(0, 1), k(2, 0)] } });
    expect(resolveClip(a, 1).volume).toBeCloseTo(0.5, 9);
  });
  it('bakes amount and params', () => {
    const e = effect({ keyframes: { amount: [k(0, 0), k(2, 1)], 'p.speed': [k(0, 10), k(2, 20)] } });
    const r = resolveClip(e, 1);
    expect(r.amount).toBeCloseTo(0.5, 9);
    expect(r.params.speed).toBeCloseTo(15, 9);
    expect(r.params.strength).toBe(40);
  });
  it('bakes camera fields', () => {
    const c = camera({ keyframes: { pan: [k(0, 0), k(2, 20)], z: [k(0, 0), k(2, -200)] } });
    const r = resolveClip(c, 1);
    expect(r.pan).toBeCloseTo(10, 9);
    expect(r.z).toBeCloseTo(-100, 9);
    expect(r.tilt).toBe(5);
  });
  it('does not mutate the original', () => {
    const v = video({ keyframes: { x: [k(0, 0), k(2, 10)] } });
    const snap = JSON.stringify(v);
    const r = resolveClip(v, 1);
    expect(r).not.toBe(v);
    expect(JSON.stringify(v)).toBe(snap);
    expect(v.transform.x).toBe(0);
  });
  it('keeps the keyframes on the result', () => {
    const v = video({ keyframes: { x: [k(0, 0), k(2, 10)] } });
    expect(resolveClip(v, 1).keyframes).toBe(v.keyframes);
  });
  it('ignores keys for props the clip does not have', () => {
    const a = audio({ keyframes: { x: [k(0, 5)] } });
    expect(resolveClip(a, 0)).toEqual(a);
  });
});

describe('withValueAt', () => {
  it('writes the static value when the prop is not animated', () => {
    const v = video();
    const o = withValueAt(v, 'x', 3, 50);
    expect(o.transform.x).toBe(50);
    expect(o.keyframes).toBeUndefined();
  });
  it('writes a key at the clip-local time when animated', () => {
    const v = video({ start: 4, keyframes: { x: [k(0, 0), k(4, 40)] } });
    const o = withValueAt(v, 'x', 6, 99);
    expect(o.keyframes!.x!.map((a) => [a.t, a.v])).toEqual([
      [0, 0],
      [2, 99],
      [4, 40],
    ]);
    expect(o.transform.x).toBe(0);
  });
  it('replaces a key already at that time', () => {
    const v = video({ keyframes: { x: [k(0, 0), k(4, 40)] } });
    const o = withValueAt(v, 'x', 4, 1);
    expect(o.keyframes!.x).toHaveLength(2);
    expect(o.keyframes!.x![1]!.v).toBe(1);
  });
  it('only touches the given prop', () => {
    const v = video({ keyframes: { x: [k(0, 0)], y: [k(0, 5)] } });
    const o = withValueAt(v, 'x', 1, 9);
    expect(o.keyframes!.y).toBe(v.keyframes!.y);
  });
});

describe('withKeyAt', () => {
  it('captures the current value when none is given', () => {
    const v = video({ start: 1, transform: { ...DEFAULT_TRANSFORM, x: 30 } });
    const o = withKeyAt(v, 'x', 3);
    expect(o.keyframes!.x).toEqual([{ t: 2, v: 30, ease: 'ease' }]);
  });
  it('captures the animated value at that time', () => {
    const v = video({ keyframes: { x: [k(0, 0), k(2, 20)] } });
    const o = withKeyAt(v, 'x', 1);
    expect(o.keyframes!.x!.map((a) => [a.t, a.v])).toEqual([
      [0, 0],
      [1, 10],
      [2, 20],
    ]);
  });
  it('takes explicit value and ease', () => {
    const o = withKeyAt(video(), 'scale', 0, 3, 'bounce');
    expect(o.keyframes!.scale).toEqual([{ t: 0, v: 3, ease: 'bounce' }]);
  });
  it('returns the clip for unknown props', () => {
    const v = video();
    expect(withKeyAt(v, 'nope', 0)).toBe(v);
  });
  it('does not touch the static value', () => {
    const o = withKeyAt(video(), 'x', 0, 100);
    expect(o.transform.x).toBe(0);
  });
});

describe('withoutKeyAt', () => {
  it('removes a key and keeps the others', () => {
    const v = video({ keyframes: { x: [k(0, 0), k(2, 20), k(4, 40)] } });
    const o = withoutKeyAt(v, 'x', 2);
    expect(o.keyframes!.x!.map((a) => a.t)).toEqual([0, 4]);
  });
  it('removing the last key makes the prop static at the value it had', () => {
    const v = video({ keyframes: { x: [k(1, 77)] } });
    const o = withoutKeyAt(v, 'x', 1);
    expect(o.keyframes).toBeUndefined();
    expect(o.transform.x).toBe(77);
  });
  it('keeps other props animated when the last key of one goes', () => {
    const v = video({ keyframes: { x: [k(1, 77)], y: [k(0, 1)] } });
    const o = withoutKeyAt(v, 'x', 1);
    expect(Object.keys(o.keyframes!)).toEqual(['y']);
  });
  it('returns the same clip when there is no key at that time or prop', () => {
    const v = video({ keyframes: { x: [k(1, 77)] } });
    expect(withoutKeyAt(v, 'x', 3)).toBe(v);
    expect(withoutKeyAt(v, 'y', 1)).toBe(v);
    const p = video();
    expect(withoutKeyAt(p, 'x', 0)).toBe(p);
  });
  it('honours the tolerance', () => {
    const v = video({ keyframes: { x: [k(0, 0), k(1, 5)] } });
    expect(withoutKeyAt(v, 'x', 1.02, 0.05).keyframes!.x).toHaveLength(1);
    expect(withoutKeyAt(v, 'x', 1.02, 0.001)).toBe(v);
  });
  it('works for effect params', () => {
    const e = effect({ keyframes: { 'p.strength': [k(0, 12)] } });
    const o = withoutKeyAt(e, 'p.strength', 0);
    expect(o.params.strength).toBe(12);
    expect(o.keyframes).toBeUndefined();
  });
});

describe('withoutKeys', () => {
  it('without keyframes returns the clip', () => {
    const v = video();
    expect(withoutKeys(v, 0)).toBe(v);
  });
  it('drops every prop and freezes the values at that time', () => {
    const v = video({ keyframes: { x: [k(0, 0), k(2, 20)], opacity: [k(0, 1), k(2, 0)] } });
    const o = withoutKeys(v, 1);
    expect(o.keyframes).toBeUndefined();
    expect(o.transform.x).toBeCloseTo(10, 9);
    expect(o.transform.opacity).toBeCloseTo(0.5, 9);
  });
  it('one prop only, others stay animated', () => {
    const v = video({ start: 1, keyframes: { x: [k(0, 0), k(2, 20)], y: [k(0, 5), k(2, 7)] } });
    const o = withoutKeys(v, 2, 'x');
    expect(o.transform.x).toBeCloseTo(10, 9);
    expect(o.keyframes!.y).toBe(v.keyframes!.y);
    expect(o.keyframes!.x).toBeUndefined();
  });
  it('does not mutate', () => {
    const v = video({ keyframes: { x: [k(0, 0), k(2, 20)] } });
    const snap = JSON.stringify(v);
    withoutKeys(v, 1);
    expect(JSON.stringify(v)).toBe(snap);
  });
});

describe('shape draw on', () => {
  const sh = (o: Partial<ShapeClip> = {}) => createShapeClip('t', 2, { duration: 4, ...o });
  it('lists drawStart and drawEnd after the transform props', () => {
    const p = animProps(sh());
    expect(p.map((a) => a.prop).slice(0, 10)).toEqual(['x', 'y', 'scale', 'rotation', 'opacity', 'z', 'rotX', 'rotY', 'drawStart', 'drawEnd']);
    expect(p.find((a) => a.prop === 'drawEnd')).toMatchObject({ min: 0, max: 1 });
    expect(animProps(image()).some((a) => a.prop === 'drawEnd')).toBe(false);
  });
  it('reads missing values as the whole outline', () => {
    expect(baseValue(sh(), 'drawStart')).toBe(0);
    expect(baseValue(sh(), 'drawEnd')).toBe(1);
    expect(baseValue(sh({ drawEnd: 0.3 }), 'drawEnd')).toBe(0.3);
    expect(baseValue(image(), 'drawEnd')).toBeUndefined();
  });
  it('sets the static value', () => {
    expect(withBaseValue(sh(), 'drawEnd', 0.4).drawEnd).toBe(0.4);
    const i = image();
    expect(withBaseValue(i, 'drawEnd', 0.4)).toBe(i);
  });
  it('resolveClip writes the animated value onto the clip', () => {
    const c = sh({ keyframes: { drawEnd: [k(0, 0), k(1, 1)] } });
    expect(resolveClip(c, 2).drawEnd).toBe(0);
    expect(resolveClip(c, 2.5).drawEnd).toBeCloseTo(0.5, 9);
    expect(resolveClip(c, 4).drawEnd).toBe(1);
    expect(resolveClip(c, 2.5).drawStart).toBeUndefined();
  });
  it('keys and unkeys like any other prop', () => {
    const c = withKeyAt(sh(), 'drawEnd', 2, 0);
    expect(isAnimated(c, 'drawEnd')).toBe(true);
    expect(valueAt(c, 'drawEnd', 3)).toBe(0);
    const back = withoutKeyAt(c, 'drawEnd', 2);
    expect(isAnimated(back, 'drawEnd')).toBe(false);
    expect(back.drawEnd).toBe(0);
  });
});
