import { describe, expect, it } from 'vitest';
import { SHAPES_3D } from '../../types';
import { faceNames } from './faces';
import { outlineFor } from './outline2d';
import { CAPSULE_CAP, DEFAULT_SEGMENTS, TORUS_TUBE, interleave, knownShape, shapeMesh } from './meshes';

describe('shape meshes', () => {
  for (const shape of SHAPES_3D) {
    describe(shape, () => {
      const m = shapeMesh(shape);
      const n = m.positions.length / 3;
      it('has consistent array sizes', () => {
        expect(n).toBeGreaterThanOrEqual(3);
        expect(m.uvs.length).toBe(n * 2);
        expect(m.indices.length % 3).toBe(0);
        expect(m.indices.length).toBeGreaterThanOrEqual(3);
        expect(n).toBeLessThanOrEqual(65535);
      });
      it('every index is in range', () => {
        for (const i of m.indices) {
          expect(i).toBeGreaterThanOrEqual(0);
          expect(i).toBeLessThan(n);
        }
      });
      it('stays inside the unit box and uv 0..1, no NaN', () => {
        for (const v of m.positions) {
          expect(Number.isFinite(v)).toBe(true);
          expect(Math.abs(v)).toBeLessThanOrEqual(0.5 + 1e-6);
        }
        for (const v of m.uvs) {
          expect(Number.isFinite(v)).toBe(true);
          expect(v).toBeGreaterThanOrEqual(-1e-6);
          expect(v).toBeLessThanOrEqual(1 + 1e-6);
        }
      });
      it('has no zero-area triangles', () => {
        const p = (i: number) => [m.positions[i * 3]!, m.positions[i * 3 + 1]!, m.positions[i * 3 + 2]!];
        let bad = 0;
        for (let t = 0; t < m.indices.length; t += 3) {
          const pa = p(m.indices[t]!);
          const pb = p(m.indices[t + 1]!);
          const pc = p(m.indices[t + 2]!);
          const u = [pb[0]! - pa[0]!, pb[1]! - pa[1]!, pb[2]! - pa[2]!];
          const v = [pc[0]! - pa[0]!, pc[1]! - pa[1]!, pc[2]! - pa[2]!];
          const area = Math.hypot(u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!);
          if (!(area > 1e-9)) bad++;
        }
        // the sphere and capsule poles legitimately collapse one triangle per segment
        expect(bad).toBeLessThanOrEqual(shape === 'sphere' || shape === 'capsule' ? 2 * DEFAULT_SEGMENTS : 0);
      });
      it('is built once per shape and segment count', () => {
        expect(shapeMesh(shape)).toBe(m);
        expect(shapeMesh(shape, DEFAULT_SEGMENTS)).toBe(m);
      });
    });
  }

  it('counts of the old shapes are unchanged', () => {
    expect(shapeMesh('plane').indices.length).toBe(6);
    expect(shapeMesh('box').positions.length / 3).toBe(24);
    expect(shapeMesh('box').indices.length).toBe(36);
    expect(shapeMesh('sphere').positions.length / 3).toBe(25 * 49);
    expect(shapeMesh('sphere').indices.length).toBe(24 * 48 * 6);
    expect(shapeMesh('cylinder').positions.length / 3).toBe(2 * 49 + 2 * 50);
    expect(shapeMesh('cylinder').indices.length).toBe(48 * 6 + 2 * 48 * 3);
  });

  it('cone: tip up, base down, counts follow the segments', () => {
    const seg = 12;
    const m = shapeMesh('cone', seg);
    // ring seg+1, tips seg, cap center + seg+1
    expect(m.positions.length / 3).toBe(seg + 1 + seg + 1 + seg + 1);
    expect(m.indices.length).toBe(seg * 3 + seg * 3);
    let top = Infinity;
    let bottom = -Infinity;
    for (let i = 1; i < m.positions.length; i += 3) {
      top = Math.min(top, m.positions[i]!);
      bottom = Math.max(bottom, m.positions[i]!);
    }
    expect(top).toBe(-0.5);
    expect(bottom).toBe(0.5);
  });

  it('pyramid: four sides and a base', () => {
    const m = shapeMesh('pyramid');
    expect(m.positions.length / 3).toBe(4 * 3 + 4);
    expect(m.indices.length).toBe(4 * 3 + 6);
    // every side has the apex at the top middle
    for (let s = 0; s < 4; s++) {
      const i = s * 3;
      expect([m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2]]).toEqual([0, -0.5, 0]);
    }
  });

  it('torus: axis along z, outer edge touches the box in x and y, tube radius 0.3 of the ring', () => {
    const m = shapeMesh('torus');
    let maxX = 0;
    let maxY = 0;
    let maxZ = 0;
    for (let i = 0; i < m.positions.length; i += 3) {
      maxX = Math.max(maxX, Math.abs(m.positions[i]!));
      maxY = Math.max(maxY, Math.abs(m.positions[i + 1]!));
      maxZ = Math.max(maxZ, Math.abs(m.positions[i + 2]!));
    }
    expect(maxX).toBeCloseTo(0.5, 5);
    expect(maxY).toBeCloseTo(0.5, 5);
    const ring = 0.5 / (1 + TORUS_TUBE);
    expect(maxZ).toBeCloseTo(ring * TORUS_TUBE, 5);
    // the hole is open: nothing closer to the axis than ring - tube
    for (let i = 0; i < m.positions.length; i += 3) {
      expect(Math.hypot(m.positions[i]!, m.positions[i + 1]!)).toBeGreaterThanOrEqual(ring * (1 - TORUS_TUBE) - 1e-6);
    }
  });

  it('capsule: a tube along y with round ends, the picture wraps like on the cylinder', () => {
    const seg = 16;
    const m = shapeMesh('capsule', seg);
    let top = Infinity;
    let bottom = -Infinity;
    let maxR = 0;
    for (let i = 0; i < m.positions.length; i += 3) {
      top = Math.min(top, m.positions[i + 1]!);
      bottom = Math.max(bottom, m.positions[i + 1]!);
      maxR = Math.max(maxR, Math.hypot(m.positions[i]!, m.positions[i + 2]!));
    }
    expect(top).toBeCloseTo(-0.5, 6);
    expect(bottom).toBeCloseTo(0.5, 6);
    expect(maxR).toBeCloseTo(0.5, 6);
    // the straight part: rows at the cap seams are at y = -0.5 + cap and 0.5 - cap, v = cap and 1 - cap
    const rows = 2 * (Math.round(seg / 4) + 1);
    expect(m.positions.length / 3).toBe(rows * (seg + 1));
    const seam = (Math.round(seg / 4) + 1) * (seg + 1) - 1; // last vertex of the top cap's equator row
    expect(m.positions[seam * 3 + 1]).toBeCloseTo(-0.5 + CAPSULE_CAP, 6);
    expect(m.uvs[seam * 2 + 1]).toBeCloseTo(CAPSULE_CAP, 6);
    // u = 0.5 faces the viewer (z negative) like the cylinder
    const mid = (Math.round(seg / 4) + 1) * (seg + 1) - 1 - seg / 2;
    expect(m.uvs[mid * 2]).toBeCloseTo(0.5, 6);
    expect(m.positions[mid * 3 + 2]).toBeCloseTo(-0.5, 6);
    // segments change the mesh
    expect(shapeMesh('capsule', 8)).not.toBe(shapeMesh('capsule', 32));
  });

  for (const kind of ['prism', 'hexagon', 'star', 'heart'] as const) {
    it(`${kind}: front face toward the viewer, mirrored back face, a side wall all around`, () => {
      const o = outlineFor(kind);
      const n = o.points.length / 2;
      const m = shapeMesh(kind);
      expect(m.positions.length / 3).toBe(3 * n);
      expect(m.indices.length).toBe(o.triangles.length * 2 + n * 6);
      for (let i = 0; i < n; i++) {
        // front ring
        expect(m.positions[i * 3 + 2]).toBe(-0.5);
        expect(m.uvs[i * 2]).toBeCloseTo(o.points[i * 2]! + 0.5, 5);
        // wall back ring has the same picture position
        expect(m.positions[(n + i) * 3 + 2]).toBe(0.5);
        expect(m.uvs[(n + i) * 2]).toBe(m.uvs[i * 2]);
        // back face: same place, mirrored u
        expect(m.positions[(2 * n + i) * 3 + 2]).toBe(0.5);
        expect(m.uvs[(2 * n + i) * 2]).toBeCloseTo(1 - m.uvs[i * 2]!, 6);
        expect(m.uvs[(2 * n + i) * 2 + 1]).toBe(m.uvs[i * 2 + 1]);
      }
      // front triangles have positive area in x, y like the box front; back ones are the other way
      const ar = (a: number, b: number, c: number) =>
        (m.positions[b * 3]! - m.positions[a * 3]!) * (m.positions[c * 3 + 1]! - m.positions[a * 3 + 1]!) -
        (m.positions[b * 3 + 1]! - m.positions[a * 3 + 1]!) * (m.positions[c * 3]! - m.positions[a * 3]!);
      // the front triangles come first, then the back ones (one index range per side, see groups)
      const half = o.triangles.length;
      for (let t = 0; t < half; t += 3) {
        expect(ar(m.indices[t]!, m.indices[t + 1]!, m.indices[t + 2]!)).toBeGreaterThan(0);
        expect(ar(m.indices[half + t]!, m.indices[half + t + 1]!, m.indices[half + t + 2]!)).toBeLessThan(0);
      }
    });
  }

  it('the outline shapes ignore the segment count (except the heart curve)', () => {
    expect(shapeMesh('star', 6)).toBe(shapeMesh('star', 90));
    expect(shapeMesh('hexagon', 6)).toBe(shapeMesh('hexagon', 90));
    expect(shapeMesh('prism', 6)).toBe(shapeMesh('prism', 90));
    expect(shapeMesh('heart', 12)).not.toBe(shapeMesh('heart', 96));
  });

  it('unknown ids fall back to the plane', () => {
    expect(knownShape('teapot')).toBe('plane');
    expect(knownShape(undefined)).toBe('plane');
    expect(knownShape('torus')).toBe('torus');
    expect(shapeMesh('teapot')).toBe(shapeMesh('plane'));
    expect(shapeMesh(undefined)).toBe(shapeMesh('plane'));
  });

  it('interleaves x y z u v', () => {
    const v = interleave(shapeMesh('plane'));
    expect(v.length).toBe(20);
    expect(Array.from(v.slice(5, 10))).toEqual([0.5, -0.5, 0, 1, 0]);
  });

  it('segment counts are clamped and cached separately', () => {
    expect(shapeMesh('cone', 6)).not.toBe(shapeMesh('cone', 24));
    expect(shapeMesh('torus', 1).positions.length).toBeGreaterThan(0);
  });

  describe('groups (one index range per side)', () => {
    for (const shape of SHAPES_3D) {
      it(`${shape}: the ranges follow each other, cover every index once, names equal faceNames`, () => {
        const m = shapeMesh(shape);
        expect(m.groups.map((g) => g.name)).toEqual([...faceNames(shape)]);
        let at = 0;
        for (const g of m.groups) {
          expect(g.start).toBe(at);
          expect(g.count).toBeGreaterThan(0);
          expect(g.count % 3).toBe(0);
          at += g.count;
        }
        if (m.groups.length > 0) expect(at).toBe(m.indices.length);
      });
    }

    /** the middle of the triangles of one group */
    const center = (shape: string, name: string): [number, number, number] => {
      const m = shapeMesh(shape);
      const g = m.groups.find((x) => x.name === name)!;
      const c: [number, number, number] = [0, 0, 0];
      for (let i = g.start; i < g.start + g.count; i++) for (let k = 0; k < 3; k++) c[k]! += m.positions[m.indices[i]! * 3 + k]! / g.count;
      return c;
    };

    it('box sides are where their names say', () => {
      expect(center('box', 'front')[2]).toBeCloseTo(-0.5, 6);
      expect(center('box', 'back')[2]).toBeCloseTo(0.5, 6);
      expect(center('box', 'right')[0]).toBeCloseTo(0.5, 6);
      expect(center('box', 'left')[0]).toBeCloseTo(-0.5, 6);
      expect(center('box', 'top')[1]).toBeCloseTo(-0.5, 6);
      expect(center('box', 'bottom')[1]).toBeCloseTo(0.5, 6);
    });

    it('cylinder and cone: the caps are the ends, the side is round', () => {
      expect(center('cylinder', 'top')[1]).toBeCloseTo(-0.5, 6);
      expect(center('cylinder', 'bottom')[1]).toBeCloseTo(0.5, 6);
      expect(center('cone', 'bottom')[1]).toBeCloseTo(0.5, 6);
      // the side of a cone reaches the tip (y = -0.5), a cap does not
      const m = shapeMesh('cone');
      const side = m.groups.find((g) => g.name === 'side')!;
      let low = 0;
      for (let i = side.start; i < side.start + side.count; i++) low = Math.min(low, m.positions[m.indices[i]! * 3 + 1]!);
      expect(low).toBeCloseTo(-0.5, 6);
    });

    it('pyramid: front faces the viewer, then right, back, left, base at the bottom', () => {
      expect(center('pyramid', 'front')[2]).toBeLessThan(-0.1);
      expect(center('pyramid', 'right')[0]).toBeGreaterThan(0.1);
      expect(center('pyramid', 'back')[2]).toBeGreaterThan(0.1);
      expect(center('pyramid', 'left')[0]).toBeLessThan(-0.1);
      expect(center('pyramid', 'bottom')[1]).toBeCloseTo(0.5, 6);
    });

    it('extruded shapes: front at z = -0.5, back at z = 0.5, the wall between', () => {
      for (const kind of ['prism', 'hexagon', 'star', 'heart'] as const) {
        const m = shapeMesh(kind);
        const z = (name: string): number[] => {
          const g = m.groups.find((x) => x.name === name)!;
          const out = new Set<number>();
          for (let i = g.start; i < g.start + g.count; i++) out.add(m.positions[m.indices[i]! * 3 + 2]!);
          return [...out].sort();
        };
        expect(z('front')).toEqual([-0.5]);
        expect(z('back')).toEqual([0.5]);
        expect(z('side')).toEqual([-0.5, 0.5]);
      }
    });

    it('a plane has no groups', () => {
      expect(shapeMesh('plane').groups).toEqual([]);
    });
  });
});
