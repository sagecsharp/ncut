import { describe, expect, it } from 'vitest';
import { SHAPES_3D } from '../../types';
import { DEFAULT_SEGMENTS, TORUS_TUBE, interleave, knownShape, shapeMesh } from './meshes';

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
        // the sphere poles legitimately collapse one triangle per segment (existing mesh, unchanged)
        expect(bad).toBeLessThanOrEqual(shape === 'sphere' ? 2 * DEFAULT_SEGMENTS : 0);
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

  it('unknown ids fall back to the plane', () => {
    expect(knownShape('hexagon')).toBe('plane');
    expect(knownShape(undefined)).toBe('plane');
    expect(knownShape('torus')).toBe('torus');
    expect(shapeMesh('hexagon')).toBe(shapeMesh('plane'));
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
});
