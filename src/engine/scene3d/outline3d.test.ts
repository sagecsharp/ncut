import { describe, expect, it } from 'vitest';
import { SHAPES_3D } from '../../types';
import { solidOutline } from './outline3d';

/** x, y, z of vertex i of a unit space array, in the scaled space */
function at(a: Float32Array, i: number, s: number[]): number[] {
  return [a[i * 3]! * s[0]!, a[i * 3 + 1]! * s[1]!, a[i * 3 + 2]! * s[2]!];
}

function volume(pos: Float32Array, idx: Uint16Array, s: number[]): number {
  let v = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const p0 = at(pos, idx[t]!, s), p1 = at(pos, idx[t + 1]!, s), p2 = at(pos, idx[t + 2]!, s);
    const u = [p1[0]! - p0[0]!, p1[1]! - p0[1]!, p1[2]! - p0[2]!];
    const w = [p2[0]! - p0[0]!, p2[1]! - p0[1]!, p2[2]! - p0[2]!];
    v += p0[0]! * (u[1]! * w[2]! - u[2]! * w[1]!) + p0[1]! * (u[2]! * w[0]! - u[0]! * w[2]!) + p0[2]! * (u[0]! * w[1]! - u[1]! * w[0]!);
  }
  return v / 6;
}

function allFinite(a: Float32Array): boolean {
  for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i]!)) return false;
  return true;
}

/** (min, max) of one axis, scaled */
function range(a: Float32Array, axis: number, scale: number): [number, number] {
  let lo = Infinity, hi = -Infinity;
  for (let i = axis; i < a.length; i += 3) {
    lo = Math.min(lo, a[i]! * scale);
    hi = Math.max(hi, a[i]! * scale);
  }
  return [lo, hi];
}

describe('solidOutline basics', () => {
  it('gives empty arrays for the plane, unknown ids and no width', () => {
    for (const id of ['plane', 'nonsense', undefined]) {
      const o = solidOutline(id, 100, 100, 100, 10);
      expect(o.indices.length + o.hull.length + o.core.length + o.strips.length).toBe(0);
    }
    expect(solidOutline('box', 100, 100, 100, 0).hull.length).toBe(0);
    expect(solidOutline('box', 100, 100, 100, -3).hull.length).toBe(0);
    expect(solidOutline('box', 100, 100, 100, NaN).hull.length).toBe(0);
  });

  it('returns the same object for the same call', () => {
    expect(solidOutline('sphere', 120, 80, 60, 6)).toBe(solidOutline('sphere', 120, 80, 60, 6));
  });

  it('survives bad sizes', () => {
    for (const s of [0, -5, NaN, Infinity]) {
      const o = solidOutline('box', s, 100, s, 10);
      expect(allFinite(o.hull) && allFinite(o.core) && allFinite(o.strips)).toBe(true);
    }
  });
});

describe('box', () => {
  const S = [100, 100, 100];
  const o = solidOutline('box', 100, 100, 100, 10);

  it('has 8 welded vertices and 12 triangles', () => {
    expect(o.hull.length / 3).toBe(8);
    expect(o.core.length / 3).toBe(8);
    expect(o.indices.length / 3).toBe(12);
  });

  it('pushes the corners to +-55 and pulls them to +-45', () => {
    for (let i = 0; i < 8; i++) {
      for (const c of at(o.hull, i, S)) expect(Math.abs(c)).toBeCloseTo(55, 3);
      for (const c of at(o.core, i, S)) expect(Math.abs(c)).toBeCloseTo(45, 3);
    }
  });

  it('has strips on the 12 hard edges, lying on the surface, 5 wide', () => {
    // 12 edges x 2 faces x 2 triangles, plus a join triangle in each of the 8 x 3 face corners
    expect(o.strips.length / 9).toBe(12 * 2 * 2 + 24);
    let inner = 0;
    for (let i = 0; i < o.strips.length / 3; i++) {
      const p = at(o.strips, i, S);
      expect(Math.max(...p.map(Math.abs))).toBeCloseTo(50, 3);
      for (const c of p) {
        const a = Math.abs(c);
        expect(a <= 50 + 1e-3).toBe(true);
        if (a < 49) {
          expect(a).toBeCloseTo(45, 3);
          inner++;
        }
      }
    }
    expect(inner).toBeGreaterThan(0);
  });

  it('does not stretch the line with the box', () => {
    const b = solidOutline('box', 200, 100, 50, 10);
    const [x0, x1] = range(b.hull, 0, 200);
    const [y0, y1] = range(b.hull, 1, 100);
    const [z0, z1] = range(b.hull, 2, 50);
    expect([x0, x1]).toEqual([expect.closeTo(-105, 3), expect.closeTo(105, 3)]);
    expect([y0, y1]).toEqual([expect.closeTo(-55, 3), expect.closeTo(55, 3)]);
    expect([z0, z1]).toEqual([expect.closeTo(-30, 3), expect.closeTo(30, 3)]);
  });
});

describe('round shapes', () => {
  it('sphere: no strips, hull 55 and core 45 from the center', () => {
    const S = [100, 100, 100];
    const o = solidOutline('sphere', 100, 100, 100, 10);
    expect(o.strips.length).toBe(0);
    for (let i = 0; i < o.hull.length / 3; i++) {
      expect(Math.hypot(...at(o.hull, i, S))).toBeGreaterThan(54.9);
      expect(Math.hypot(...at(o.hull, i, S))).toBeLessThan(55.4);
      expect(Math.hypot(...at(o.core, i, S))).toBeGreaterThan(44.6);
      expect(Math.hypot(...at(o.core, i, S))).toBeLessThan(45.1);
    }
  });

  it('sphere stretched: 5 out along x and y', () => {
    const o = solidOutline('sphere', 200, 100, 100, 10);
    const [, x1] = range(o.hull, 0, 200);
    const [y0, y1] = range(o.hull, 1, 100);
    expect(x1).toBeGreaterThan(104.9);
    expect(x1).toBeLessThan(105.6);
    expect(y1).toBeGreaterThan(54.9);
    expect(y1).toBeLessThan(55.6);
    expect(y0).toBeLessThan(-54.9);
  });

  it('cylinder: hard rims, the hull rim is 5 out radially and along the axis', () => {
    const S = [100, 100, 100];
    const o = solidOutline('cylinder', 100, 100, 100, 10);
    expect(o.strips.length).toBeGreaterThan(0);
    let found = 0;
    for (let i = 0; i < o.hull.length / 3; i++) {
      const m = at(o.hull, i, S);
      const r = Math.hypot(m[0]!, m[2]!);
      if (Math.abs(Math.abs(m[1]!) - 55) < 0.2 && r > 54.5) {
        expect(r).toBeLessThan(55.5);
        found++;
      }
    }
    expect(found).toBeGreaterThan(40);
  });

  it('cone: the tip goes up by more than the half width, at most 4 times it', () => {
    const S = [100, 100, 100];
    const o = solidOutline('cone', 100, 100, 100, 10);
    const [y0] = range(o.hull, 1, 100);
    // the tip is at y = -50
    expect(-50 - y0).toBeGreaterThan(5);
    expect(-50 - y0).toBeLessThanOrEqual(20);
    expect(o.strips.length).toBeGreaterThan(0);
    expect(S.length).toBe(3);
  });

  it('torus: no strips, finite, a thinner core and a thicker hull', () => {
    const S = [100, 100, 100];
    const o = solidOutline('torus', 100, 100, 100, 10);
    expect(o.strips.length).toBe(0);
    expect(allFinite(o.hull) && allFinite(o.core)).toBe(true);
    const tube = (a: Float32Array): number => range(a, 2, S[2]!)[1];
    const solid = solidOutline('torus', 100, 100, 100, 1e-6);
    expect(tube(o.hull)).toBeGreaterThan(tube(solid.hull) + 3);
    expect(tube(o.core)).toBeLessThan(tube(solid.core) - 3);
  });
});

describe('extruded shapes', () => {
  it('star has strips on the front face and on the walls', () => {
    const S = [100, 100, 100];
    const o = solidOutline('star', 100, 100, 100, 10);
    expect(allFinite(o.strips)).toBe(true);
    let front = 0, wall = 0;
    for (let i = 0; i < o.strips.length / 3; i++) {
      const z = at(o.strips, i, S)[2]!;
      if (Math.abs(z + 50) < 1e-3) front++;
      if (Math.abs(z + 45) < 1e-3) wall++;
    }
    expect(front).toBeGreaterThan(0);
    expect(wall).toBeGreaterThan(0);
  });
});

describe('every solid', () => {
  const edgesConsistent = (idx: Uint16Array): boolean => {
    const dir = new Map<string, number>();
    for (let t = 0; t < idx.length; t += 3) {
      for (let k = 0; k < 3; k++) {
        const key = `${idx[t + k]}>${idx[t + (k + 1) % 3]}`;
        dir.set(key, (dir.get(key) ?? 0) + 1);
      }
    }
    for (const [key, n] of dir) {
      const [a, b] = key.split('>');
      if (n !== 1 || dir.get(`${b}>${a}`) !== 1) return false;
    }
    return true;
  };

  for (const shape of SHAPES_3D) {
    if (shape === 'plane') continue;
    for (const S of [[400, 400, 400], [400, 100, 30]]) {
      for (const width of [2, 12, 200]) {
        it(`${shape} ${S.join('x')} width ${width}`, () => {
          const o = solidOutline(shape, S[0]!, S[1]!, S[2]!, width);
          expect(o.hull.length).toBeGreaterThan(0);
          expect(allFinite(o.hull) && allFinite(o.core) && allFinite(o.strips)).toBe(true);
          expect(o.indices.length % 3).toBe(0);
          expect(o.strips.length % 9).toBe(0);
          const nv = o.hull.length / 3;
          expect(o.core.length).toBe(o.hull.length);
          for (const i of o.indices) expect(i).toBeLessThan(nv);
          expect(edgesConsistent(o.indices)).toBe(true);
          const solid = solidOutline(shape, S[0]!, S[1]!, S[2]!, 1e-6);
          const v0 = volume(solid.hull, o.indices, S);
          expect(v0).toBeGreaterThan(0);
          expect(volume(o.hull, o.indices, S)).toBeGreaterThan(v0);
          expect(volume(o.core, o.indices, S)).toBeLessThanOrEqual(v0);
          // no hull vertex is further than 4 h from the vertex of the solid
          for (let i = 0; i < nv; i++) {
            const a = at(o.hull, i, S), b = at(solid.hull, i, S);
            expect(Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!)).toBeLessThanOrEqual(2 * width + 1e-3);
          }
        });
      }
    }
  }
});
