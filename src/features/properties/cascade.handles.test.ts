import { describe, expect, it } from 'vitest';
import { evalKeys } from '../../lib/anim';
import type { Keyframe, TextClip } from '../../types';
import { flyPlan } from './cascade';
import type { FlyOpts } from './cascade';

const base: FlyOpts = { kind: 'rise', direction: 'in', amount: 1, duration: 0.5, seed: 3, width: 1920, height: 1080 };
const samples = (from: number, to: number, n = 200): number[] => Array.from({ length: n }, (_, i) => from + ((to - from) * (i + 0.5)) / n);

function text(keys: Keyframe[]): TextClip {
  return {
    id: 'a',
    trackId: 't0',
    start: 2,
    duration: 3,
    name: 'a',
    fadeIn: 0,
    fadeOut: 0,
    type: 'text',
    transform: { x: 0, y: 10, scale: 1, rotation: 0, opacity: 1 },
    keyframes: { y: keys },
  } as unknown as TextClip;
}

/** a custom curve over the whole clip */
const curve = (): Keyframe[] => [
  { t: 0, v: 0, ease: 'bezier', out: { speed: 20, influence: 0.4 } },
  { t: 2, v: 80, ease: 'bezier', in: { speed: -10, influence: 0.3 }, out: { speed: 15, influence: 0.4 } },
  { t: 3, v: 50, ease: 'linear', in: { speed: 5, influence: 0.4 } },
];

describe('fly keeps custom curves', () => {
  it('a fly onto a custom curve keeps the curve after the seam', () => {
    const y = flyPlan(text(curve()), 0, 1, base).y!;
    expect(y.map((k) => k.t)).toEqual([0, 0.5, 2, 3]);
    expect(y[0]!.ease).toBe('ease-out');
    // the rest key at the seam goes on along the old curve
    expect(y[1]!.ease).toBe('bezier');
    expect(y[1]!.out).toBeDefined();
    expect(y[1]!.v).toBeCloseTo(evalKeys(curve(), 0.5), 9);
    for (const t of samples(0.5, 3)) expect(evalKeys(y, t)).toBeCloseTo(evalKeys(curve(), t), 6);
  });

  it('a fly out keeps the curve before the seam', () => {
    const y = flyPlan(text(curve()), 0, 1, { ...base, direction: 'out' }).y!;
    expect(y.map((k) => k.t)).toEqual([0, 2, 2.5, 3]);
    expect(y[2]!.ease).toBe('ease-in');
    expect(y[2]!.in).toBeDefined();
    expect(y[2]!.v).toBeCloseTo(evalKeys(curve(), 2.5), 9);
    for (const t of samples(0, 2.5)) expect(evalKeys(y, t)).toBeCloseTo(evalKeys(curve(), t), 7);
  });

  it('a seam on a custom key keeps its handle', () => {
    const on: Keyframe[] = [
      { t: 0, v: 0, ease: 'bezier', out: { speed: 20, influence: 0.4 } },
      { t: 0.5, v: 30, ease: 'bezier', in: { speed: 12, influence: 0.3 }, out: { speed: -8, influence: 0.45 } },
      { t: 3, v: 50, ease: 'linear', in: { speed: 5, influence: 0.4 } },
    ];
    const into = flyPlan(text(on), 0, 1, base).y!;
    expect(into[1]).toStrictEqual({ t: 0.5, v: 30, ease: 'bezier', out: { speed: -8, influence: 0.45 } });
    for (const t of samples(0.5, 3)) expect(evalKeys(into, t)).toBeCloseTo(evalKeys(on, t), 9);
    const late: Keyframe[] = [
      { t: 0, v: 0, ease: 'bezier', out: { speed: 20, influence: 0.4 } },
      { t: 2.5, v: 30, ease: 'bezier', in: { speed: 12, influence: 0.3 }, out: { speed: -8, influence: 0.45 } },
      { t: 3, v: 50, ease: 'linear', in: { speed: 5, influence: 0.4 } },
    ];
    const out = flyPlan(text(late), 0, 1, { ...base, direction: 'out' }).y!;
    const rest = out.find((k) => k.t === 2.5)!;
    expect(rest.in).toEqual({ speed: 12, influence: 0.3 });
    expect(rest.ease).toBe('ease-in');
    for (const t of samples(0, 2.5)) expect(evalKeys(out, t)).toBeCloseTo(evalKeys(late, t), 9);
  });
});
