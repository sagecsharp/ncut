import { describe, expect, it } from 'vitest';
import { OUTLINE_KINDS, area2, isOutlineShape, outlineFor, triangulate } from './outline2d';
import type { OutlineKind } from './outline2d';

const COUNTS: Record<OutlineKind, number> = { prism: 3, hexagon: 6, star: 10, heart: 0 };

function triArea2(p: Float64Array, a: number, b: number, c: number): number {
  return (p[b * 2]! - p[a * 2]!) * (p[c * 2 + 1]! - p[a * 2 + 1]!) - (p[b * 2 + 1]! - p[a * 2 + 1]!) * (p[c * 2]! - p[a * 2]!);
}

/** the polygon contains the point (even-odd) */
function contains(p: Float64Array, x: number, y: number): boolean {
  const n = p.length / 2;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = p[i * 2]!;
    const yi = p[i * 2 + 1]!;
    const xj = p[j * 2]!;
    const yj = p[j * 2 + 1]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

describe('outlines', () => {
  for (const kind of OUTLINE_KINDS) {
    describe(kind, () => {
      const o = outlineFor(kind);
      const n = o.points.length / 2;

      it('has the right number of points', () => {
        if (COUNTS[kind] > 0) expect(n).toBe(COUNTS[kind]);
        else expect(n).toBeGreaterThan(16);
        expect(o.uvs.length).toBe(n * 2);
      });
      it('fills the unit square exactly and has no NaN', () => {
        let x0 = Infinity;
        let x1 = -Infinity;
        let y0 = Infinity;
        let y1 = -Infinity;
        for (let i = 0; i < n; i++) {
          const x = o.points[i * 2]!;
          const y = o.points[i * 2 + 1]!;
          expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
          x0 = Math.min(x0, x);
          x1 = Math.max(x1, x);
          y0 = Math.min(y0, y);
          y1 = Math.max(y1, y);
        }
        expect([x0, x1, y0, y1].map((v) => Math.round(v * 1e6) / 1e6)).toEqual([-0.5, 0.5, -0.5, 0.5]);
      });
      it('has uvs inside 0..1 that are the bounding box mapped', () => {
        for (let i = 0; i < n; i++) {
          expect(o.uvs[i * 2]!).toBeGreaterThanOrEqual(0);
          expect(o.uvs[i * 2]!).toBeLessThanOrEqual(1);
          expect(o.uvs[i * 2 + 1]!).toBeGreaterThanOrEqual(0);
          expect(o.uvs[i * 2 + 1]!).toBeLessThanOrEqual(1);
          expect(o.uvs[i * 2]!).toBeCloseTo(o.points[i * 2]! + 0.5, 5);
          expect(o.uvs[i * 2 + 1]!).toBeCloseTo(o.points[i * 2 + 1]! + 0.5, 5);
        }
      });
      it('has positive area winding', () => {
        expect(area2(o.points)).toBeGreaterThan(0);
      });
      it('triangles all have positive area and cover the polygon exactly', () => {
        expect(o.triangles.length % 3).toBe(0);
        let sum = 0;
        for (let t = 0; t < o.triangles.length; t += 3) {
          const a = triArea2(o.points, o.triangles[t]!, o.triangles[t + 1]!, o.triangles[t + 2]!);
          expect(a).toBeGreaterThan(1e-10);
          sum += a;
        }
        expect(sum).toBeCloseTo(area2(o.points), 9);
      });
      it('no triangle leaves the outline', () => {
        for (let t = 0; t < o.triangles.length; t += 3) {
          const a = o.triangles[t]!;
          const b = o.triangles[t + 1]!;
          const c = o.triangles[t + 2]!;
          // the centroid and the middles of the three edges (shrunk toward the centroid) lie inside
          const gx = (o.points[a * 2]! + o.points[b * 2]! + o.points[c * 2]!) / 3;
          const gy = (o.points[a * 2 + 1]! + o.points[b * 2 + 1]! + o.points[c * 2 + 1]!) / 3;
          expect(contains(o.points, gx, gy)).toBe(true);
          for (const [p, q] of [[a, b], [b, c], [c, a]] as const) {
            const mx = (o.points[p * 2]! + o.points[q * 2]!) / 2;
            const my = (o.points[p * 2 + 1]! + o.points[q * 2 + 1]!) / 2;
            expect(contains(o.points, mx + (gx - mx) * 0.01, my + (gy - my) * 0.01)).toBe(true);
          }
        }
      });
      it('is built once', () => {
        expect(outlineFor(kind)).toBe(o);
        expect(outlineFor(kind).points).toBe(o.points);
      });
    });
  }

  it('has one point up: the star and the prism top is the highest point, in the middle', () => {
    for (const kind of ['prism', 'star', 'hexagon'] as const) {
      const o = outlineFor(kind);
      let top = 0;
      for (let i = 0; i < o.points.length / 2; i++) if (o.points[i * 2 + 1]! < o.points[top * 2 + 1]! - 1e-9) top = i;
      expect(o.points[top * 2]!).toBeCloseTo(0, 6);
      expect(o.points[top * 2 + 1]!).toBeCloseTo(-0.5, 6);
    }
  });

  it('heart: a notch at the top middle and the tip at the bottom middle, symmetric', () => {
    const o = outlineFor('heart');
    const n = o.points.length / 2;
    let bottom = 0;
    for (let i = 0; i < n; i++) if (o.points[i * 2 + 1]! > o.points[bottom * 2 + 1]!) bottom = i;
    expect(o.points[bottom * 2]!).toBeCloseTo(0, 6);
    // the middle column is inside only from the notch down: the top of the box at x = 0 is outside
    expect(contains(o.points, 0, -0.49)).toBe(false);
    expect(contains(o.points, 0, 0)).toBe(true);
    expect(contains(o.points, -0.3, -0.3)).toBe(contains(o.points, 0.3, -0.3));
  });

  it('heart curve steps follow the segments, other outlines ignore them', () => {
    expect(outlineFor('heart', 12).points.length).toBeLessThan(outlineFor('heart', 96).points.length);
    expect(outlineFor('star', 12)).toBe(outlineFor('star', 96));
  });

  it('triangulate handles a concave polygon and drops collinear points', () => {
    // an L shape (positive area in x right, y down) with a collinear point on one edge
    const l = [0, 0, 1, 0, 2, 0, 2, 1, 1, 1, 1, 2, 0, 2];
    const t = triangulate(l);
    let sum = 0;
    for (let i = 0; i < t.length; i += 3) {
      const a = (l[t[i + 1]! * 2]! - l[t[i]! * 2]!) * (l[t[i + 2]! * 2 + 1]! - l[t[i]! * 2 + 1]!) - (l[t[i + 1]! * 2 + 1]! - l[t[i]! * 2 + 1]!) * (l[t[i + 2]! * 2]! - l[t[i]! * 2]!);
      expect(a).toBeGreaterThan(0);
      sum += a;
    }
    expect(sum / 2).toBeCloseTo(3, 9);
  });

  it('knows which shapes are outlines', () => {
    expect(isOutlineShape('star')).toBe(true);
    expect(isOutlineShape('capsule')).toBe(false);
    expect(isOutlineShape('box')).toBe(false);
  });
});
