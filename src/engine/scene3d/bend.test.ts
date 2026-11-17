import { describe, expect, it } from 'vitest';
import type { Clip, ClipBend, Project } from '../../types';
import {
  BEND_GLSL,
  BEND_STEPS,
  bendBounds,
  bendInWorld,
  bendLocal,
  bendNormal,
  bendOutline,
  bendSinc,
  bentVertex,
  hasBend,
  isBent,
  parseBend,
  planeBend,
  sameBend,
  usesBend,
  withLift,
} from './bend';
import { LIT_VS } from './renderer';

type P3 = [number, number, number];
const pt = (): P3 => [0, 0, 0];
const must = (b: ReturnType<typeof planeBend>) => {
  expect(b).not.toBeNull();
  return b!;
};

describe('planeBend', () => {
  it('planeBend is null when flat, missing or not finite', () => {
    expect(planeBend(null, 1000, 1000)).toBeNull();
    expect(planeBend(undefined, 1000, 1000)).toBeNull();
    expect(planeBend({ angle: 0 }, 1000, 1000)).toBeNull();
    expect(planeBend({ angle: 0.005 }, 1000, 1000)).toBeNull();
    expect(planeBend({ angle: Number.NaN }, 1000, 1000)).toBeNull();
    expect(planeBend({ angle: 90 }, 0, 1000)).toBeNull();
    expect(planeBend({ angle: 90 }, 1000, Number.NaN)).toBeNull();
    expect(planeBend({ angle: 90 }, 1000, 1000, 0, 0)).toBeNull();
    expect(planeBend({ angle: 0.01 }, 1000, 1000)).not.toBeNull();
    // a broken span or center falls back to the clip's own length and the middle
    const b = must(planeBend({ angle: 90, span: Number.NaN, center: Number.NaN }, 1000, 1000));
    expect(b.k).toBeCloseTo(Math.PI / 2 / 1000, 12);
    expect(b.c).toBe(0);
  });

  it('arc length is kept along the bent edge', () => {
    const b = must(planeBend({ angle: 120 }, 1000, 1000));
    const n = 2000;
    let len = 0;
    let prev = bendLocal(b, -0.5, 0, pt()).slice() as P3;
    for (let i = 1; i <= n; i++) {
      const cur = bendLocal(b, i / n - 0.5, 0, pt());
      // x is a share of the 1000 px box, z is px
      len += Math.hypot((cur[0] - prev[0]) * 1000, cur[2] - prev[2]);
      prev = cur.slice() as P3;
    }
    expect(len).toBeCloseTo(1000, 1);
  });

  it('center 0 keeps the middle in place, center -0.5 keeps the left edge in place', () => {
    const mid = must(planeBend({ angle: 90 }, 1000, 1000));
    const m = bendLocal(mid, 0, 0.2, pt());
    expect(m[0]).toBeCloseTo(0, 9);
    expect(m[1]).toBeCloseTo(0.2, 9);
    expect(m[2]).toBeCloseTo(0, 9);
    const left = must(planeBend({ angle: 90, center: -0.5 }, 1000, 1000));
    expect(left.c).toBe(-500);
    const l = bendLocal(left, -0.5, 0.1, pt());
    expect(l[0]).toBeCloseTo(-0.5, 9);
    expect(l[2]).toBeCloseTo(0, 9);
    // the other end has moved
    const r = bendLocal(left, 0.5, 0, pt());
    expect(r[2]).toBeLessThan(-100);
  });

  it('+ angle brings the edges toward the viewer, - pushes them away', () => {
    // world z points away from the viewer: toward the viewer is z < 0
    const plus = must(planeBend({ angle: 90 }, 1000, 1000));
    const minus = must(planeBend({ angle: -90 }, 1000, 1000));
    expect(bendLocal(plus, 0.5, 0, pt())[2]).toBeLessThan(0);
    expect(bendLocal(plus, -0.5, 0, pt())[2]).toBeLessThan(0);
    expect(bendLocal(minus, 0.5, 0, pt())[2]).toBeGreaterThan(0);
    expect(bendLocal(minus, -0.5, 0, pt())[2]).toBeGreaterThan(0);
    // along height the top and bottom come round
    const tall = must(planeBend({ angle: 90, along: 'height' }, 800, 800));
    expect(tall.axis).toBe(1);
    const e = bendLocal(tall, 0.1, 0.5, pt());
    expect(e[0]).toBeCloseTo(0.1, 9);
    expect(e[2]).toBeLessThan(0);
  });

  it('360 over its own length closes a tube', () => {
    const b = must(planeBend({ angle: 360 }, 1000, 1000));
    const l = bendLocal(b, -0.5, 0, pt());
    const r = bendLocal(b, 0.5, 0, pt());
    expect(l[0] * 1000).toBeCloseTo(r[0] * 1000, 6);
    expect(l[2]).toBeCloseTo(r[2], 6);
    // the circle has the diameter of the length over pi
    expect(l[2]).toBeCloseTo(-1000 / Math.PI, 6);
  });

  it('curvature is clamped to one full turn of the own length', () => {
    // 360 degrees over a span half as long would roll the clip twice
    const b = must(planeBend({ angle: 360, span: 500 }, 1000, 1000));
    expect(b.k).toBeCloseTo((2 * Math.PI) / 1000, 12);
    const n = must(planeBend({ angle: -360, span: 500 }, 1000, 1000));
    expect(n.k).toBeCloseTo(-(2 * Math.PI) / 1000, 12);
    // an angle over 360 is cut to 360 first
    expect(must(planeBend({ angle: 900 }, 1000, 1000)).k).toBeCloseTo((2 * Math.PI) / 1000, 12);
    // a span longer than the clip bends it less
    expect(must(planeBend({ angle: 90, span: 4000 }, 1000, 1000)).k).toBeCloseTo(Math.PI / 2 / 4000, 12);
  });

  it('a crop window maps through s and o onto the same surface', () => {
    const full = must(planeBend({ angle: 150, center: -0.2 }, 1000, 1000));
    // the left half of the full box is drawn
    const half = must(planeBend({ angle: 150, center: -0.2 }, 1000, 1000, 0, 0.5));
    expect(half.s).toBe(500);
    expect(half.o).toBe(-250);
    for (const x of [-0.5, -0.2, 0, 0.3, 0.5]) {
      const a = bendLocal(half, x, 0.1, pt());
      const px = x * 500 - 250;
      const f = bendLocal(full, px / 1000, 0.1, pt());
      // along in px of the full box
      expect(a[0] * 500 + half.o).toBeCloseTo(f[0] * 1000, 6);
      expect(a[2]).toBeCloseTo(f[2], 6);
    }
    // a window in the middle
    const mid = must(planeBend({ angle: 150 }, 1000, 1000, 0.25, 0.5));
    expect(mid.o).toBeCloseTo(0, 9);
    expect(mid.s).toBe(500);
  });

  it('the sinc form matches sin(t) / k for tiny and big angles', () => {
    for (const angle of [0.011, 0.5, 5, 90, 270, -180, -360]) {
      const b = must(planeBend({ angle, center: 0.1 }, 1000, 1000));
      for (const x of [-0.5, -0.31, 0.05, 0.1, 0.42]) {
        const out = bendLocal(b, x, 0, pt());
        const d = x * b.s + b.o - b.c;
        const t = b.k * d;
        const along = b.c + Math.sin(t) / b.k;
        const z = -(1 - Math.cos(t)) / b.k;
        expect(out[0] * b.s + b.o).toBeCloseTo(along, 6);
        expect(out[2]).toBeCloseTo(z, 6);
      }
    }
    for (const x of [0, 1e-9, 0.05, 0.0999, 0.1, 0.5, 3, -2]) {
      expect(bendSinc(x)).toBeCloseTo(x === 0 ? 1 : Math.sin(x) / x, 9);
    }
    expect(bendSinc(0)).toBe(1);
  });

  it('bendBounds holds every strip column', () => {
    for (const bend of [{ angle: 200, center: 0.3 }, { angle: -90 }, { angle: 300, along: 'height' as const, center: -0.4 }]) {
      const b = must(planeBend(bend, 900, 900));
      const box = bendBounds(b, new Float32Array(6));
      for (let i = 0; i <= BEND_STEPS; i++) {
        const u = i / BEND_STEPS - 0.5;
        const p = b.axis === 1 ? bendLocal(b, 0, u, pt()) : bendLocal(b, u, 0, pt());
        const a = b.axis === 1 ? p[1] : p[0];
        const lo = b.axis === 1 ? box[2]! : box[0]!;
        const hi = b.axis === 1 ? box[3]! : box[1]!;
        expect(a).toBeGreaterThanOrEqual(lo - 1e-6);
        expect(a).toBeLessThanOrEqual(hi + 1e-6);
        expect(p[2]).toBeGreaterThanOrEqual(box[4]! - 1e-4);
        expect(p[2]).toBeLessThanOrEqual(box[5]! + 1e-4);
      }
      // the other axis keeps the unit mesh
      if (b.axis === 1) expect([box[0], box[1]]).toEqual([-0.5, 0.5]);
      else expect([box[2], box[3]]).toEqual([-0.5, 0.5]);
      // planeBend filled its own box the same way
      expect(Array.from(b.box)).toEqual(Array.from(box));
    }
  });

  it('withLift moves the surface along its inner normal', () => {
    const b = must(planeBend({ angle: 120 }, 1000, 1000));
    const l = withLift(b, 20);
    expect(l.lift).toBe(20);
    expect(b.lift).toBe(0);
    expect(l.box).not.toBe(b.box);
    for (const x of [-0.5, -0.2, 0, 0.35]) {
      const a = bendLocal(b, x, 0, pt());
      const c = bendLocal(l, x, 0, pt());
      const dAlong = (c[0] - a[0]) * b.s;
      const dz = c[2] - a[2];
      expect(Math.hypot(dAlong, dz)).toBeCloseTo(20, 6);
      // the step is square to the surface: its tangent is (cos t, -sin t)
      const t = b.k * (x * b.s + b.o - b.c);
      expect(dAlong * Math.cos(t) + dz * -Math.sin(t)).toBeCloseTo(0, 6);
      // and it points away from the viewer for a plus bend at the middle (into the tube)
      if (x === 0) expect(dz).toBeGreaterThan(0);
    }
  });
});

describe('bendNormal', () => {
  it('points to the viewer in the middle and swings with the surface', () => {
    const b = must(planeBend({ angle: 90 }, 1000, 1000));
    const m = bendNormal(b, 0, 0, pt());
    expect(m[0]).toBeCloseTo(0, 9);
    expect(m[2]).toBe(-1);
    const e = bendNormal(b, 0.5, 0, pt());
    expect(e[0]).toBeLessThan(0);
    const tall = must(planeBend({ angle: 90, along: 'height' }, 1000, 1000));
    const t = bendNormal(tall, 0, 0.5, pt());
    expect(t[0]).toBe(0);
    expect(t[1]).toBeLessThan(0);
  });
});

describe('bendOutline', () => {
  it('bendOutline gives edge a forward and edge b back', () => {
    const b = must(planeBend({ angle: 90 }, 1000, 1000));
    const n = 4;
    const o = bendOutline(b, n);
    expect(o).toHaveLength(2 * (n + 1) * 3);
    const at = (i: number) => [o[i * 3]!, o[i * 3 + 1]!, o[i * 3 + 2]!] as P3;
    // edge a: y = -0.5, u from -0.5 to 0.5
    for (let i = 0; i <= n; i++) expect(at(i)[1]).toBeCloseTo(-0.5, 9);
    expect(at(0)[0]).toBeLessThan(at(n)[0]);
    // edge b: y = +0.5, u from 0.5 back to -0.5
    for (let i = n + 1; i <= 2 * n + 1; i++) expect(at(i)[1]).toBeCloseTo(0.5, 9);
    expect(at(n + 1)[0]).toBeGreaterThan(at(2 * n + 1)[0]);
    // the polygon closes: edge b starts where edge a ended (same u)
    expect(at(n + 1)[0]).toBeCloseTo(at(n)[0], 9);
    expect(at(2 * n + 1)[0]).toBeCloseTo(at(0)[0], 9);
    // the ends of a plus bend are in front of the middle
    expect(at(0)[2]).toBeLessThan(at(2)[2]);
    // along height the first edge is the left one
    const tall = must(planeBend({ angle: 90, along: 'height' }, 1000, 1000));
    const t = bendOutline(tall, n);
    for (let i = 0; i <= n; i++) expect(t[i * 3]).toBeCloseTo(-0.5, 9);
    for (let i = n + 1; i <= 2 * n + 1; i++) expect(t[i * 3]).toBeCloseTo(0.5, 9);
    expect(t[1]).toBeLessThan(t[n * 3 + 1]!);
  });
});

const image = (over: Partial<Clip> = {}): Clip =>
  ({ id: 'a', type: 'image', trackId: 't', start: 0, duration: 1, name: 'a', fadeIn: 0, fadeOut: 0, assetId: 'x', transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, ...over }) as Clip;

describe('hasBend and usesBend', () => {
  it('hasBend sees keys and a static angle, not a solid; usesBend caches per clips array', () => {
    expect(hasBend({})).toBe(false);
    expect(hasBend({ bend: { angle: 0 } })).toBe(false);
    expect(hasBend({ bend: { angle: 0.005 } })).toBe(false);
    expect(hasBend({ bend: { angle: 20 } })).toBe(true);
    expect(hasBend({ keyframes: { 'bend.angle': [{ t: 0, v: 0, ease: 'linear' }] } })).toBe(true);
    expect(hasBend({ keyframes: { 'bend.angle': [] } })).toBe(false);
    expect(hasBend({ keyframes: { opacity: [{ t: 0, v: 1, ease: 'linear' }] } })).toBe(false);
    // a solid ignores it, a plane and an unknown shape do not
    expect(hasBend({ bend: { angle: 20 }, threeD: true, shape: 'box' })).toBe(false);
    expect(hasBend({ keyframes: { 'bend.angle': [{ t: 0, v: 0, ease: 'linear' }] }, threeD: true, shape: 'sphere' })).toBe(false);
    expect(hasBend({ bend: { angle: 20 }, threeD: true, shape: 'plane' })).toBe(true);
    expect(hasBend({ bend: { angle: 20 }, threeD: true, shape: 'nope' })).toBe(true);
    // isBent reads a resolved clip
    expect(isBent({ bend: { angle: 20 } })).toBe(true);
    expect(isBent({ bend: { angle: 0 } })).toBe(false);
    expect(isBent({ bend: { angle: 20 }, threeD: true, shape: 'box' })).toBe(false);
    expect(isBent({ bend: null })).toBe(false);

    const clips: Clip[] = [image({ id: 'a' })];
    const project = { clips } as unknown as Project;
    expect(usesBend(project)).toBe(false);
    // the same array and length: the answer is cached, even when a clip changed in place
    clips[0] = image({ id: 'a', bend: { angle: 30 } });
    expect(usesBend(project)).toBe(false);
    // a new array is a new answer
    expect(usesBend({ clips: [...clips] } as unknown as Project)).toBe(true);
    // a longer array too
    const more: Clip[] = [image({ id: 'a' })];
    const p2 = { clips: more } as unknown as Project;
    expect(usesBend(p2)).toBe(false);
    more.push(image({ id: 'b', keyframes: { 'bend.angle': [{ t: 0, v: 0, ease: 'linear' }] } }));
    expect(usesBend(p2)).toBe(true);
    // an effect clip never counts
    expect(usesBend({ clips: [{ id: 'e', type: 'effect', bend: { angle: 50 } }] } as unknown as Project)).toBe(false);
  });
});

describe('parseBend', () => {
  it('parseBend clamps, drops width and a zero center, refuses junk', () => {
    expect(parseBend(null)).toBeNull();
    expect(parseBend(undefined)).toBeNull();
    expect(parseBend('90')).toBeNull();
    expect(parseBend(90)).toBeNull();
    expect(parseBend({ angle: 400 })).toEqual({ angle: 360 });
    expect(parseBend({ angle: -400 })).toEqual({ angle: -360 });
    expect(parseBend({ angle: '90' })).toEqual({ angle: 0 });
    expect(parseBend({ angle: Number.NaN })).toEqual({ angle: 0 });
    expect(parseBend({ angle: 90, along: 'width' })).toEqual({ angle: 90 });
    expect(parseBend({ angle: 90, along: 'sideways' })).toEqual({ angle: 90 });
    expect(parseBend({ angle: 90, along: 'height' })).toEqual({ angle: 90, along: 'height' });
    expect(parseBend({ angle: 90, center: 0 })).toEqual({ angle: 90 });
    expect(parseBend({ angle: 90, center: -3 })).toEqual({ angle: 90, center: -1 });
    expect(parseBend({ angle: 90, center: Number.POSITIVE_INFINITY })).toEqual({ angle: 90 });
    expect(parseBend({ angle: 90, span: 0 })).toEqual({ angle: 90 });
    expect(parseBend({ angle: 90, span: -5 })).toEqual({ angle: 90 });
    expect(parseBend({ angle: 90, span: 0.2 })).toEqual({ angle: 90, span: 1 });
    expect(parseBend({ angle: 90, span: 1e9 })).toEqual({ angle: 90, span: 100000 });
    expect(parseBend({ angle: 90, span: 800, center: 0.25, along: 'height', extra: 1 })).toEqual({ angle: 90, span: 800, center: 0.25, along: 'height' });
  });
});

describe('sameBend', () => {
  it('compares the drawn bend and ignores the lift', () => {
    const a = must(planeBend({ angle: 90 }, 1000, 1000));
    expect(sameBend(a, must(planeBend({ angle: 90 }, 1000, 1000)))).toBe(true);
    expect(sameBend(a, withLift(a, 5))).toBe(true);
    expect(sameBend(a, must(planeBend({ angle: 91 }, 1000, 1000)))).toBe(false);
    expect(sameBend(a, null)).toBe(false);
    expect(sameBend(null, undefined)).toBe(true);
  });
});

describe('bendInWorld', () => {
  it('bendInWorld scales the span only', () => {
    const b: ClipBend = { angle: 90, center: 0.2, span: 800, along: 'height' };
    expect(bendInWorld(b, 2)).toEqual({ angle: 90, center: 0.2, span: 1600, along: 'height' });
    expect(b.span).toBe(800);
    expect(bendInWorld(b, 1)).toBe(b);
    expect(bendInWorld(b, 0)).toBe(b);
    expect(bendInWorld(b, Number.NaN)).toBe(b);
    const noSpan: ClipBend = { angle: 90 };
    expect(bendInWorld(noSpan, 3)).toBe(noSpan);
    expect(bendInWorld(null, 3)).toBeNull();
    expect(bendInWorld(undefined, 3)).toBeUndefined();
  });
});

describe('bentVertex', () => {
  it('bentVertex puts the chunk in, replaces both positions and the normal, and throws on a missing anchor', () => {
    const vs = bentVertex(LIT_VS);
    expect(vs).toContain(BEND_GLSL);
    expect(vs.split('bendPos(a_pos, bn)')).toHaveLength(2);
    // both reads of the position and the eye test use the bent one
    expect(vs.split('vec4(bp, 1.0)')).toHaveLength(4);
    expect(vs.split('vec4(a_pos, 1.0)')).toHaveLength(1);
    expect(vs).toContain('* bn *');
    expect(vs).not.toContain('* a_normal *');
    expect(vs).toContain('u_eye - (u_model * vec4(bp, 1.0)).xyz');
    // the chunk sits before main, the first lines of main make the bent point
    expect(vs.indexOf('uniform vec4 u_bend;')).toBeLessThan(vs.indexOf('void main() {'));
    expect(vs.indexOf('vec3 bp = bendPos')).toBeGreaterThan(vs.indexOf('void main() {'));
    expect(() => bentVertex(LIT_VS.replace('void main() {\n', 'void main2() {\n'))).toThrow(/anchors/);
    expect(() => bentVertex(LIT_VS.replace('* a_normal *', '* a_nrm *'))).toThrow(/anchors/);
    expect(() => bentVertex(LIT_VS.replace('gl_Position = u_mvp * vec4(a_pos, 1.0);', 'gl_Position = u_mvp * vec4(a_pos, 1.0); vec4 q = vec4(a_pos, 1.0);'))).toThrow(/anchors/);
    expect(() => bentVertex(LIT_VS.replace('n = len > 0.0 ? n / len', 'n = len > 1.0 ? n / len'))).toThrow(/anchors/);
  });
});
