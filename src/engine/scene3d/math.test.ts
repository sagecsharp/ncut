import { describe, expect, it } from 'vitest';
import {
  DEG,
  add,
  basis,
  cross,
  dot,
  identity,
  length,
  mul,
  normalize,
  rotateAround,
  rotationX,
  rotationY,
  rotationZ,
  scale,
  scaling,
  sub,
  transformPoint,
  translation,
  type Mat4,
  type Vec3,
} from './math';

const P = 5;
function expectPoint(m: Mat4, p: Vec3, want: Vec3): void {
  const o = transformPoint(m, p[0], p[1], p[2]);
  expect(o[0]).toBeCloseTo(want[0], P);
  expect(o[1]).toBeCloseTo(want[1], P);
  expect(o[2]).toBeCloseTo(want[2], P);
  expect(o[3]).toBeCloseTo(1, P);
}
function expectVec(a: Vec3, b: Vec3): void {
  expect(a[0]).toBeCloseTo(b[0], P);
  expect(a[1]).toBeCloseTo(b[1], P);
  expect(a[2]).toBeCloseTo(b[2], P);
}
const rand = (): Mat4 => mul(translation(3, -4, 5), mul(rotationZ(0.7), mul(rotationX(0.3), scaling(2, 3, 4))));

describe('identity / mul', () => {
  it('identity has ones on the diagonal only', () => {
    const m = identity();
    for (let i = 0; i < 16; i++) expect(m[i]).toBe(i % 5 === 0 ? 1 : 0);
  });
  it('column-major float32 with 16 entries', () => {
    expect(identity()).toBeInstanceOf(Float32Array);
    expect(identity()).toHaveLength(16);
  });
  it('mul with identity changes nothing (both sides)', () => {
    const m = rand();
    const l = mul(identity(), m);
    const r = mul(m, identity());
    for (let i = 0; i < 16; i++) {
      expect(l[i]).toBeCloseTo(m[i]!, 5);
      expect(r[i]).toBeCloseTo(m[i]!, 5);
    }
  });
  it('mul(a, b) applies b first', () => {
    // scale by 2 first, then move by 10 -> (1,0,0) -> (12,0,0)
    expectPoint(mul(translation(10, 0, 0), scaling(2, 2, 2)), [1, 0, 0], [12, 0, 0]);
    // move by 10 first, then scale by 2 -> (1,0,0) -> (22,0,0)
    expectPoint(mul(scaling(2, 2, 2), translation(10, 0, 0)), [1, 0, 0], [22, 0, 0]);
  });
  it('mul is associative', () => {
    const a = rotationX(0.4);
    const b = translation(1, 2, 3);
    const c = rotationY(-1.1);
    const l = mul(mul(a, b), c);
    const r = mul(a, mul(b, c));
    for (let i = 0; i < 16; i++) expect(l[i]).toBeCloseTo(r[i]!, 5);
  });
  it('does not mutate its inputs', () => {
    const a = rotationX(0.4);
    const b = translation(1, 2, 3);
    const ac = Float32Array.from(a);
    const bc = Float32Array.from(b);
    mul(a, b);
    expect(a).toEqual(ac);
    expect(b).toEqual(bc);
  });
});

describe('translation / scaling', () => {
  it('translation moves points', () => {
    expectPoint(translation(1, 2, 3), [0, 0, 0], [1, 2, 3]);
    expectPoint(translation(-5, 0, 7), [5, 5, 5], [0, 5, 12]);
  });
  it('translation does not move directions via w (w stays 1)', () => {
    expect(transformPoint(translation(9, 9, 9), 1, 1, 1)[3]).toBe(1);
  });
  it('scaling scales per axis', () => {
    expectPoint(scaling(2, 3, 4), [1, 1, 1], [2, 3, 4]);
    expectPoint(scaling(-1, 1, 1), [3, 4, 5], [-3, 4, 5]);
  });
  it('scaling keeps the origin', () => {
    expectPoint(scaling(5, 5, 5), [0, 0, 0], [0, 0, 0]);
  });
});

describe('rotations (x right, y down, z away, right hand rule)', () => {
  it('rotationZ 90: right -> down, down -> left (clockwise on screen)', () => {
    const m = rotationZ(90 * DEG);
    expectPoint(m, [1, 0, 0], [0, 1, 0]);
    expectPoint(m, [0, 1, 0], [-1, 0, 0]);
    expectPoint(m, [-1, 0, 0], [0, -1, 0]);
    expectPoint(m, [0, 0, 5], [0, 0, 5]);
  });
  it('rotationZ 180 flips x and y', () => {
    expectPoint(rotationZ(Math.PI), [3, 4, 5], [-3, -4, 5]);
  });
  it('rotationZ 45 moves right toward down-right', () => {
    const o = transformPoint(rotationZ(45 * DEG), 1, 0, 0);
    expect(o[0]).toBeCloseTo(Math.SQRT1_2, P);
    expect(o[1]).toBeCloseTo(Math.SQRT1_2, P);
  });
  it('rotationX 90: down -> away, away -> up', () => {
    const m = rotationX(90 * DEG);
    expectPoint(m, [0, 1, 0], [0, 0, 1]);
    expectPoint(m, [0, 0, 1], [0, -1, 0]);
    expectPoint(m, [7, 0, 0], [7, 0, 0]);
  });
  it('rotationY 90: away -> right, right -> toward the viewer', () => {
    const m = rotationY(90 * DEG);
    expectPoint(m, [0, 0, 1], [1, 0, 0]);
    expectPoint(m, [1, 0, 0], [0, 0, -1]);
    expectPoint(m, [0, 3, 0], [0, 3, 0]);
  });
  it('rotationY: the left edge swings away for a positive angle (documented)', () => {
    const o = transformPoint(rotationY(30 * DEG), -1, 0, 0);
    expect(o[2]).toBeGreaterThan(0);
  });
  it('rotationX: positive angle sends the BOTTOM edge away (right hand rule with y down)', () => {
    // note: the header comment of math.ts says "the top edge leans away", the matrix does the opposite.
    // model.ts negates the angle, so the user facing sign (tilt > 0 = top away) is correct there.
    const bottom = transformPoint(rotationX(30 * DEG), 0, 1, 0);
    expect(bottom[2]).toBeGreaterThan(0);
  });
  it('every rotation keeps lengths and the origin', () => {
    for (const make of [rotationX, rotationY, rotationZ]) {
      const m = make(1.234);
      const o = transformPoint(m, 3, 4, 12);
      expect(Math.hypot(o[0], o[1], o[2])).toBeCloseTo(13, 4);
      expectPoint(m, [0, 0, 0], [0, 0, 0]);
    }
  });
  it('a rotation by 0 is the identity, by 360 too', () => {
    for (const make of [rotationX, rotationY, rotationZ]) {
      expectPoint(make(0), [1, 2, 3], [1, 2, 3]);
      expectPoint(make(2 * Math.PI), [1, 2, 3], [1, 2, 3]);
    }
  });
  it('opposite angles undo each other', () => {
    for (const make of [rotationX, rotationY, rotationZ]) {
      expectPoint(mul(make(0.8), make(-0.8)), [1, 2, 3], [1, 2, 3]);
    }
  });
  it('rotationZ matches rotateAround on the z axis, rotationX / rotationY too', () => {
    const v: Vec3 = [1, 2, 3];
    const a = 0.9;
    const cases: [Mat4, Vec3][] = [
      [rotationX(a), [1, 0, 0]],
      [rotationY(a), [0, 1, 0]],
      [rotationZ(a), [0, 0, 1]],
    ];
    for (const [m, axis] of cases) {
      const o = transformPoint(m, v[0], v[1], v[2]);
      expectVec([o[0], o[1], o[2]], rotateAround(v, axis, a));
    }
  });
});

describe('basis', () => {
  it('maps local axes to the given world axes', () => {
    const m = basis([0, 1, 0], [0, 0, 1], [1, 0, 0]);
    expectPoint(m, [1, 0, 0], [0, 1, 0]);
    expectPoint(m, [0, 1, 0], [0, 0, 1]);
    expectPoint(m, [0, 0, 1], [1, 0, 0]);
  });
  it('identity axes give the identity', () => {
    const m = basis([1, 0, 0], [0, 1, 0], [0, 0, 1]);
    for (let i = 0; i < 16; i++) expect(m[i]).toBe(identity()[i]);
  });
  it('has no translation', () => {
    const m = basis([0, 1, 0], [0, 0, 1], [1, 0, 0]);
    expect(m[12]).toBe(0);
    expect(m[13]).toBe(0);
    expect(m[14]).toBe(0);
  });
  it('combines with a translation the usual way', () => {
    const m = mul(translation(5, 5, 5), basis([0, 1, 0], [1, 0, 0], [0, 0, -1]));
    expectPoint(m, [1, 2, 3], [7, 6, 2]);
  });
});

describe('vector helpers', () => {
  it('add / sub / scale / dot / length', () => {
    expect(add([1, 2, 3], [4, 5, 6])).toEqual([5, 7, 9]);
    expect(sub([4, 5, 6], [1, 2, 3])).toEqual([3, 3, 3]);
    expect(scale([1, -2, 3], 2)).toEqual([2, -4, 6]);
    expect(dot([1, 2, 3], [4, 5, 6])).toBe(32);
    expect(length([3, 4, 12])).toBe(13);
  });
  it('cross follows the right hand rule: x cross y = z', () => {
    expect(cross([1, 0, 0], [0, 1, 0])).toEqual([0, 0, 1]);
    expect(cross([0, 1, 0], [0, 0, 1])).toEqual([1, 0, 0]);
    expect(cross([0, 0, 1], [1, 0, 0])).toEqual([0, 1, 0]);
    expect(cross([0, 1, 0], [1, 0, 0])).toEqual([0, 0, -1]);
  });
  it('cross of parallel vectors is zero and is perpendicular otherwise', () => {
    expect(cross([2, 0, 0], [5, 0, 0])).toEqual([0, 0, 0]);
    const c = cross([1, 2, 3], [-3, 1, 4]);
    expect(dot(c, [1, 2, 3])).toBeCloseTo(0, 9);
    expect(dot(c, [-3, 1, 4])).toBeCloseTo(0, 9);
  });
  it('normalize gives unit length', () => {
    expect(length(normalize([3, 4, 12]))).toBeCloseTo(1, 12);
    expectVec(normalize([0, 0, 9]), [0, 0, 1]);
    expectVec(normalize([-5, 0, 0]), [-1, 0, 0]);
  });
  it('normalize of a zero vector is zero, not NaN', () => {
    expect(normalize([0, 0, 0])).toEqual([0, 0, 0]);
  });
  it('normalize of a vanishing vector is zero', () => {
    expect(normalize([1e-12, 0, 0])).toEqual([0, 0, 0]);
  });
});

describe('rotateAround', () => {
  it('rotates x to y around z by 90 degrees', () => {
    expectVec(rotateAround([1, 0, 0], [0, 0, 1], 90 * DEG), [0, 1, 0]);
  });
  it('keeps a vector on the axis', () => {
    expectVec(rotateAround([0, 0, 5], [0, 0, 1], 1.3), [0, 0, 5]);
    expectVec(rotateAround([0, 2, 0], [0, 1, 0], -2), [0, 2, 0]);
  });
  it('rotates around an arbitrary unit axis, keeping length and axis angle', () => {
    const axis = normalize([1, 1, 1]);
    const v: Vec3 = [3, -1, 2];
    const o = rotateAround(v, axis, 1.1);
    expect(length(o)).toBeCloseTo(length(v), 9);
    expect(dot(o, axis)).toBeCloseTo(dot(v, axis), 9);
  });
  it('120 degrees around (1,1,1) cycles the axes', () => {
    expectVec(rotateAround([1, 0, 0], normalize([1, 1, 1]), (2 * Math.PI) / 3), [0, 1, 0]);
  });
  it('0 and 360 degrees change nothing; opposite angles undo', () => {
    const v: Vec3 = [1, 2, 3];
    expectVec(rotateAround(v, [0, 1, 0], 0), v);
    expectVec(rotateAround(v, [0, 1, 0], 2 * Math.PI), v);
    expectVec(rotateAround(rotateAround(v, [1, 0, 0], 0.7), [1, 0, 0], -0.7), v);
  });
  it('rotating around +y by 90 sends z to x (same as rotationY)', () => {
    expectVec(rotateAround([0, 0, 1], [0, 1, 0], 90 * DEG), [1, 0, 0]);
  });
  it('DEG converts degrees to radians', () => {
    expect(180 * DEG).toBeCloseTo(Math.PI, 12);
  });
});

describe('transformPoint', () => {
  it('returns x y z w with w = 1 for affine matrices', () => {
    const o = transformPoint(rand(), 1, 2, 3);
    expect(o).toHaveLength(4);
    expect(o[3]).toBeCloseTo(1, 6);
  });
  it('is the identity for identity', () => {
    expect(transformPoint(identity(), 1, 2, 3)).toEqual([1, 2, 3, 1]);
  });
});
