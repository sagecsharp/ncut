import { describe, expect, it } from 'vitest';
import type { Clip, Easing, Keyframe, Keyframes, Transform } from '../types';
import { DEFAULT_TRANSFORM } from '../types';
import { evalKeys, noteRawClip, rawClipOf, resolveClip, withBaseValue } from './anim';

/** resolveClip as it was before it made one copy: one clone of the clip (and of transform / params) per keyed property */
function legacyResolveClip<T extends Clip>(clip: T, time: number): T {
  const kf = clip.keyframes;
  if (!kf) return clip;
  let out: T = clip;
  const local = time - clip.start;
  for (const prop in kf) {
    const keys = kf[prop]!;
    if (keys.length === 0) continue;
    out = withBaseValue(out, prop, evalKeys(keys, local));
  }
  return out;
}

let seed = 987654321;
const rnd = (): number => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
function pick<X>(list: readonly X[]): X {
  return list[Math.floor(rnd() * list.length)]!;
}
const EASES: Easing[] = ['linear', 'ease', 'ease-in', 'ease-out', 'back', 'bounce', 'elastic', 'hold'];

function keys(): Keyframe[] {
  const n = Math.floor(rnd() * 4);
  const out: Keyframe[] = [];
  for (let i = 0; i < n; i++) out.push({ t: i * 2 + rnd(), v: (rnd() - 0.5) * 400, ease: pick(EASES) });
  return out;
}

const VISUAL = ['x', 'y', 'scale', 'rotation', 'opacity', 'z', 'rotX', 'rotY'];
const CAMERA = ['x', 'y', 'z', 'pan', 'tilt', 'roll', 'fov', 'focusDistance', 'focusStrength'];
// every property name the animation code knows plus names that mean nothing for some kinds of clip
const ALL = [...new Set([...VISUAL, ...CAMERA, 'volume', 'drawStart', 'drawEnd', 'amount', 'p.strength', 'p.other', 'p.', 'p.__proto__', 'nothing'])];

function keyframes(props: readonly string[], density: number): Keyframes | undefined {
  if (rnd() < 0.1) return undefined;
  const kf: Keyframes = {};
  for (const p of props) if (rnd() < density) kf[p] = keys();
  return kf;
}

function transform(): Transform {
  const t: Transform = { ...DEFAULT_TRANSFORM, x: rnd() * 100, y: rnd() * 100, scale: 0.5 + rnd(), rotation: rnd() * 90, opacity: rnd() };
  // 3d fields missing or present
  if (rnd() < 0.5) {
    t.z = rnd() * 10;
    t.rotX = rnd() * 10;
    t.rotY = rnd() * 10;
  }
  return t;
}

function randomClip(): Clip {
  const common = { id: 'c', trackId: 't', start: rnd() * 3, duration: 10, name: 'c', fadeIn: 0, fadeOut: 0 };
  const kind = pick(['video', 'image', 'text', 'shape', 'audio', 'effect', 'camera'] as const);
  const kf = keyframes(ALL, 0.5);
  const maybe = kf ? { keyframes: kf } : {};
  switch (kind) {
    case 'video':
      return { ...common, ...maybe, type: 'video', assetId: 'a', trimStart: 0, speed: 1, volume: rnd(), muted: false, transform: transform() } as Clip;
    case 'image':
      return { ...common, ...maybe, type: 'image', assetId: 'a', transform: transform() } as Clip;
    case 'text':
      return { ...common, ...maybe, type: 'text', text: 'hi', fontFamily: 'x', fontSize: 80, fontWeight: 400, italic: false, color: '#fff', background: null, align: 'center', transform: transform() } as Clip;
    case 'shape':
      return { ...common, ...maybe, type: 'shape', kind: 'rect', width: 100, height: 50, color: '#fff', transform: transform(), ...(rnd() < 0.5 ? { drawStart: rnd(), drawEnd: rnd() } : {}) } as Clip;
    case 'audio':
      return { ...common, ...maybe, type: 'audio', assetId: 'a', trimStart: 0, speed: 1, volume: rnd(), muted: false } as Clip;
    case 'effect':
      return { ...common, ...maybe, type: 'effect', effect: 'shake', amount: rnd(), params: { strength: 4, other: 2 }, seed: 1 } as Clip;
    case 'camera':
      return { ...common, ...maybe, type: 'camera', x: 1, y: 2, z: 3, pan: 4, tilt: 5, roll: 6, fov: 50, ...(rnd() < 0.5 ? { focusStrength: rnd() } : {}) } as Clip;
  }
}

function deepFreeze<O>(o: O): O {
  if (o && typeof o === 'object') {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

const lin = (t: number, v: number): Keyframe => ({ t, v, ease: 'linear' });

describe('resolveClip makes one copy and gives what the one-copy-per-property version gave', () => {
  it('is deeply equal for random clips of every kind with every property keyed, and never writes into its input', () => {
    let changed = 0;
    let same = 0;
    for (let n = 0; n < 4000; n++) {
      const clip = deepFreeze(randomClip());
      const time = clip.start + (rnd() - 0.2) * 12;
      const want = legacyResolveClip(clip, time);
      const got = resolveClip(clip, time);
      expect(got).toEqual(want);
      // identity: the same object exactly when the old version returned the input itself
      expect(got === clip).toBe(want === clip);
      if (got === clip) same++;
      else changed++;
    }
    // the generator really covers both outcomes
    expect(changed).toBeGreaterThan(1000);
    expect(same).toBeGreaterThan(100);
  });
  it('a param called __proto__ stays an own key like in an object literal', () => {
    const clip = deepFreeze({ id: 'c', trackId: 't', start: 0, duration: 5, name: 'c', fadeIn: 0, fadeOut: 0, type: 'effect', effect: 'shake', amount: 1, params: { a: 1 }, seed: 1, keyframes: { 'p.__proto__': [lin(0, 3)], 'p.a': [lin(0, 2)] } } as Clip);
    const got = resolveClip(clip, 1) as unknown as { params: Record<string, number> };
    const want = legacyResolveClip(clip, 1) as unknown as { params: Record<string, number> };
    expect(Object.keys(got.params)).toEqual(Object.keys(want.params));
    expect(Object.getOwnPropertyDescriptor(got.params, '__proto__')?.value).toBe(3);
    expect(got).toEqual(want);
  });
  it('keys that mean nothing for the kind of clip return the clip itself', () => {
    const clip = { id: 'c', trackId: 't', start: 0, duration: 5, name: 'c', fadeIn: 0, fadeOut: 0, type: 'image', assetId: 'a', transform: { ...DEFAULT_TRANSFORM }, keyframes: { volume: [lin(0, 1)], 'p.x': [lin(0, 1)] } } as Clip;
    expect(resolveClip(clip, 1)).toBe(clip);
  });
  it('an empty key list counts as not keyed', () => {
    const clip = { id: 'c', trackId: 't', start: 0, duration: 5, name: 'c', fadeIn: 0, fadeOut: 0, type: 'image', assetId: 'a', transform: { ...DEFAULT_TRANSFORM }, keyframes: { x: [] } } as Clip;
    expect(resolveClip(clip, 1)).toBe(clip);
  });
  it('several keyed transform fields give one new clip and one new transform, the stored ones stay as they were', () => {
    const t = { ...DEFAULT_TRANSFORM };
    const clip = deepFreeze({
      id: 'c',
      trackId: 't',
      start: 0,
      duration: 5,
      name: 'c',
      fadeIn: 0,
      fadeOut: 0,
      type: 'image',
      assetId: 'a',
      transform: t,
      keyframes: { x: [lin(0, 0), lin(2, 100)], y: [lin(0, 0), lin(2, 50)], opacity: [lin(0, 0), lin(2, 1)] },
    } as Clip);
    const r = resolveClip(clip, 1) as unknown as { transform: typeof t };
    expect(r).not.toBe(clip);
    expect(r.transform).not.toBe(t);
    expect(r.transform).toMatchObject({ x: 50, y: 25, opacity: 0.5 });
    expect(t.x).toBe(DEFAULT_TRANSFORM.x);
  });
});

describe('rawClipOf', () => {
  const text = (over: Record<string, unknown> = {}): Clip =>
    ({ id: 't', trackId: 't', start: 0, duration: 5, name: 't', fadeIn: 0, fadeOut: 0, type: 'text', text: 'hi', fontFamily: 'x', fontSize: 80, fontWeight: 400, italic: false, color: '#fff', background: null, align: 'center', transform: { ...DEFAULT_TRANSFORM }, ...over }) as Clip;
  it('a keyframed text copy points back at the stored clip, a copy of another kind does not', () => {
    const raw = text({ keyframes: { x: [lin(0, 0), lin(2, 100)] } });
    const copy = resolveClip(raw, 1);
    expect(copy).not.toBe(raw);
    expect(rawClipOf(copy)).toBe(raw);
    expect(rawClipOf(raw)).toBe(raw);
    const img = { ...(text() as object), type: 'image', keyframes: { x: [lin(0, 0), lin(2, 100)] } } as unknown as Clip;
    const imgCopy = resolveClip(img, 1);
    expect(rawClipOf(imgCopy)).toBe(imgCopy);
  });
  it('a copy of a copy points at the first stored clip', () => {
    const raw = text();
    const a = { ...raw, transform: { ...DEFAULT_TRANSFORM, x: 5 } };
    noteRawClip(a, raw);
    const b = { ...a, transform: { ...DEFAULT_TRANSFORM, x: 6 } };
    noteRawClip(b, a);
    expect(rawClipOf(b)).toBe(raw);
  });
});
