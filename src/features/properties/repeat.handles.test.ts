import { describe, expect, it } from 'vitest';
import { evalKeys, valueAt } from '../../lib/anim';
import type { ImageClip, Keyframe, TextClip } from '../../types';
import { repeatPlan } from './repeat';
import { pieceOffset } from './textSplit';
import type { PieceBase } from './textSplit';

const curve = (): Keyframe[] => [
  { t: 0, v: 2, ease: 'bezier', out: { speed: 6, influence: 0.4 } },
  { t: 1, v: 4, ease: 'linear', in: { speed: -2, influence: 0.3 } },
];

function clip(keyframes: ImageClip['keyframes']): ImageClip {
  return {
    id: 'a',
    type: 'image',
    assetId: 'x',
    trackId: 't',
    start: 2,
    duration: 3,
    name: 'pic',
    fadeIn: 0,
    fadeOut: 0,
    transform: { x: 10, y: 20, scale: 1, rotation: 5, opacity: 1 },
    keyframes,
  };
}

describe('repeat keeps custom curves', () => {
  it('mul scales speeds by step^k', () => {
    const plan = repeatPlan(clip({ scale: curve() }), { count: 4, scale: 1.5 });
    expect(plan).toHaveLength(3);
    plan.forEach((entry, i) => {
      const k = i + 1;
      const f = Math.pow(1.5, k);
      const keys = entry.keyframes.scale!;
      expect(keys.map((q) => q.v)).toEqual([2 * f, 4 * f]);
      expect(keys[0]!.out!.speed).toBeCloseTo(6 * f, 9);
      expect(keys[0]!.out!.influence).toBe(0.4);
      expect(keys[1]!.in!.speed).toBeCloseTo(-2 * f, 9);
      // the whole curve is the original one times the factor
      for (const t of [0.1, 0.4, 0.8]) expect(evalKeys(keys, t)).toBeCloseTo(evalKeys(curve(), t) * f, 9);
    });
  });

  it('add keeps them', () => {
    const plan = repeatPlan(clip({ x: curve() }), { count: 3, dx: 30 });
    plan.forEach((entry, i) => {
      const keys = entry.keyframes.x!;
      expect(keys.map((q) => q.v)).toEqual([2 + 30 * (i + 1), 4 + 30 * (i + 1)]);
      expect(keys[0]!.out).toEqual({ speed: 6, influence: 0.4 });
      expect(keys[1]!.in).toEqual({ speed: -2, influence: 0.3 });
    });
    // keys without handles stay bare
    const bare = repeatPlan(clip({ x: [{ t: 0, v: 1, ease: 'ease' }, { t: 1, v: 2, ease: 'ease' }] }), { count: 2, dx: 5 });
    expect(bare[0]!.keyframes.x).toStrictEqual([{ t: 0, v: 6, ease: 'ease' }, { t: 1, v: 7, ease: 'ease' }]);
  });

  it('a split piece reads a custom scale like valueAt', () => {
    // the custom part dips under the smallest scale a clip can have: the clip shows 0.01 there, so does a piece
    const dip: Keyframe[] = [
      { t: 0, v: 1, ease: 'bezier', out: { speed: -10, influence: 0.5 } },
      { t: 1, v: 0.5, ease: 'linear', in: { speed: 0, influence: 0.3 } },
    ];
    const text = {
      id: 't', type: 'text', trackId: 'v', start: 2, duration: 3, name: 't', fadeIn: 0, fadeOut: 0,
      transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, keyframes: { scale: dip },
    } as unknown as TextClip;
    const piece = { cx: 100, cy: 0 };
    let dipped = 0;
    for (const t of [2.1, 2.3, 2.5, 2.7, 2.9]) {
      const s = valueAt(text, 'scale', t)!;
      expect(pieceOffset(text as unknown as PieceBase, piece, t).dx).toBeCloseTo(100 * s, 9);
      if (s === 0.01) dipped++;
    }
    expect(dipped).toBeGreaterThan(0);
    // a bare base without a type has no range to clamp to and reads the keys as they are
    const bare: PieceBase = { transform: text.transform, start: 2, keyframes: { scale: dip } };
    expect(pieceOffset(bare, piece, 2.5).dx).toBeCloseTo(100 * evalKeys(dip, 0.5), 9);
  });
});
