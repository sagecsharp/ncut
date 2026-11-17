import { describe, expect, it } from 'vitest';
import type { ImageClip, Keyframe } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import { evalKeys } from '../../lib/anim';
import { captureKeys, placeKeyCopy, placeKeys } from './keyClipboard';

const image = (duration: number, keyframes?: ImageClip['keyframes']): ImageClip => ({
  id: 'a', type: 'image', trackId: 'v', start: 0, duration, name: 'a', fadeIn: 0, fadeOut: 0, assetId: 'img1', transform: { ...DEFAULT_TRANSFORM }, ...(keyframes ? { keyframes } : {}),
});
const samples = (from: number, to: number, n = 200): number[] => Array.from({ length: n }, (_, i) => from + ((to - from) * (i + 0.5)) / n);

/** a custom curve over 4 s */
const curve = (): Keyframe[] => [
  { t: 0, v: 0, ease: 'bezier', out: { speed: 30, influence: 0.4 } },
  { t: 2, v: 80, ease: 'bezier', in: { speed: -10, influence: 0.3 }, out: { speed: 15, influence: 0.4 } },
  { t: 4, v: 50, ease: 'linear', in: { speed: 5, influence: 0.4 } },
];

describe('key clipboard keeps custom curves', () => {
  it('copy and paste keep handles', () => {
    const copied = captureKeys({ x: curve().map((k) => ({ ...k, t: k.t + 1 })) })!;
    expect(copied.x).toStrictEqual(curve());
    const placed = placeKeys(copied, image(10), 2).x!;
    expect(placed).toStrictEqual(curve().map((k) => ({ ...k, t: k.t + 2 })));
    const both = placeKeyCopy(copied, image(10), 2).keys.x!;
    expect(both).toStrictEqual(placed);
    // keys without handles stay bare
    const bare = captureKeys({ x: [{ t: 1, v: 0, ease: 'ease' }, { t: 2, v: 1, ease: 'linear' }] })!;
    expect(bare.x).toStrictEqual([{ t: 0, v: 0, ease: 'ease' }, { t: 1, v: 1, ease: 'linear' }]);
  });

  it('the end cut of a custom part is exact', () => {
    const all = curve();
    for (const copy of [placeKeys, (c: Parameters<typeof placeKeys>[0], clip: ImageClip, at: number) => placeKeyCopy(c, clip, at).keys]) {
      const out = copy({ x: curve() }, image(3), 0).x!;
      expect(out.map((k) => k.t)).toEqual([0, 2, 3]);
      expect(out[1]!.ease).toBe('bezier');
      expect(out[2]!.ease).toBe('linear');
      expect(out[2]!.out).toBeUndefined();
      expect(out[2]!.in).toBeDefined();
      for (const t of samples(0, 3)) expect(evalKeys(out, t)).toBeCloseTo(evalKeys(all, t), 6);
    }
    // a clip a little longer than the key before: the end key still sits on its end
    const near = placeKeys({ x: curve() }, image(3.0005), 0).x!;
    expect(near.map((k) => k.t)).toEqual([0, 2, 3.0005]);
  });

  it('the cut before 0 of a custom part is exact', () => {
    const clip = image(3);
    const out = placeKeyCopy({ x: curve() }, clip, -1).keys.x!;
    // keys at -1, 1 and 3 on the clip: key 0 is the cut, then the 1 and the 3
    expect(out.map((k) => k.t)).toEqual([0, 1, 3]);
    expect(out[0]!.ease).toBe('bezier');
    expect(out[0]!.out).toBeDefined();
    expect(out[0]!.in).toBeUndefined();
    expect(out[1]!.in).toBeDefined();
    const all = curve().map((k) => ({ ...k, t: k.t - 1 }));
    for (const t of samples(0, 3)) expect(evalKeys(out, t)).toBeCloseTo(evalKeys(all, t), 6);
  });

  it('one custom part over the whole clip is cut at both ends', () => {
    const long: Keyframe[] = [
      { t: 0, v: 0, ease: 'bezier', out: { speed: 30, influence: 0.4 } },
      { t: 10, v: 90, ease: 'linear', in: { speed: -5, influence: 0.35 } },
    ];
    const clip = image(3);
    const out = placeKeyCopy({ x: long }, clip, -2).keys.x!;
    expect(out.map((k) => k.t)).toEqual([0, 3]);
    expect(out[0]!.ease).toBe('bezier');
    expect(out[0]!.out).toBeDefined();
    expect(out[1]!.in).toBeDefined();
    const all = long.map((k) => ({ ...k, t: k.t - 2 }));
    for (const t of samples(0, 3)) expect(evalKeys(out, t)).toBeCloseTo(evalKeys(all, t), 6);
  });
});
