/**
 * the flat outlines behind the extruded 3d shapes (prism, hexagon, star, heart), as pure data.
 * every outline is traced by the same code as the 2d shape clip (engine/shape.ts shapePath), so a 2d
 * star / heart and the 3d one have the same curve and the same orientation (one point up, y down).
 * the points are then stretched so their bounding box is exactly the unit square (-0.5..0.5): the
 * clip's width and height are the size of the outline, and uv = the bounding box mapped to 0..1, so a
 * picture is cut out by the outline without being distorted.
 */
import { shapePath } from '../shape';
import type { ShapeClip } from '../../types';

export type OutlineKind = 'prism' | 'hexagon' | 'star' | 'heart';

export const OUTLINE_KINDS: readonly OutlineKind[] = ['prism', 'hexagon', 'star', 'heart'];

export interface Outline {
  /** x, y per point, y down. positive shoelace area in x, y. no repeated first point. */
  points: Float64Array;
  /** u, v per point: the bounding box mapped to 0..1 (u = x + 0.5, v = y + 0.5) */
  uvs: Float32Array;
  /** triangles as point indices, every one with positive area in x, y (same winding as the polygon) */
  triangles: Uint16Array;
}

/** default number of curve steps (the heart is the only outline with curves) */
export const OUTLINE_SEGMENTS = 48;

type PathCtx = Parameters<typeof shapePath>[0];

/** the 2d clip fields that draw each outline (see shapePath) */
const CLIP_OF: Record<OutlineKind, Partial<ShapeClip>> = {
  prism: { kind: 'triangle' },
  hexagon: { kind: 'polygon', points: 6 },
  star: { kind: 'star', points: 5 },
  heart: { kind: 'heart' },
};

/** run shapePath on a stand-in that records the traced outline as a polygon (curves are sampled) */
function tracePath(kind: OutlineKind, curveSteps: number): number[] {
  const out: number[] = [];
  let cx = 0;
  let cy = 0;
  const rec = {
    beginPath() {
      out.length = 0;
    },
    moveTo(x: number, y: number) {
      out.push(x, y);
      cx = x;
      cy = y;
    },
    lineTo(x: number, y: number) {
      out.push(x, y);
      cx = x;
      cy = y;
    },
    bezierCurveTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number) {
      for (let i = 1; i <= curveSteps; i++) {
        const t = i / curveSteps;
        const s = 1 - t;
        out.push(
          s * s * s * cx + 3 * s * s * t * x1 + 3 * s * t * t * x2 + t * t * t * x,
          s * s * s * cy + 3 * s * s * t * y1 + 3 * s * t * t * y2 + t * t * t * y,
        );
      }
      cx = x;
      cy = y;
    },
    closePath() {},
  };
  shapePath(rec as unknown as PathCtx, { ...CLIP_OF[kind] } as ShapeClip, 1, 1);
  return out;
}

/** twice the signed shoelace area of a polygon given as x, y pairs */
export function area2(p: ArrayLike<number>): number {
  const n = p.length / 2;
  let a = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += p[i * 2]! * p[j * 2 + 1]! - p[j * 2]! * p[i * 2 + 1]!;
  }
  return a;
}

/**
 * ear clipping of a simple polygon (no holes). the polygon must have positive area2 (the builder
 * guarantees it); every triangle comes out with positive area and the same winding. collinear points
 * are dropped without a triangle.
 */
export function triangulate(p: ArrayLike<number>): Uint16Array {
  const n = p.length / 2;
  const out: number[] = [];
  const rest: number[] = [];
  for (let i = 0; i < n; i++) rest.push(i);
  const cross = (a: number, b: number, c: number): number =>
    (p[b * 2]! - p[a * 2]!) * (p[c * 2 + 1]! - p[a * 2 + 1]!) - (p[b * 2 + 1]! - p[a * 2 + 1]!) * (p[c * 2]! - p[a * 2]!);
  const inside = (a: number, b: number, c: number, q: number): boolean => {
    const eps = -1e-12;
    return cross(a, b, q) >= eps && cross(b, c, q) >= eps && cross(c, a, q) >= eps;
  };
  let guard = n * n + 8;
  while (rest.length > 3 && guard-- > 0) {
    const m = rest.length;
    let ear = -1;
    let widest = -Infinity;
    let widestAt = 0;
    for (let k = 0; k < m; k++) {
      const a = rest[(k + m - 1) % m]!;
      const b = rest[k]!;
      const c = rest[(k + 1) % m]!;
      const cr = cross(a, b, c);
      if (cr > widest) {
        widest = cr;
        widestAt = k;
      }
      if (cr <= 1e-12) continue;
      let blocked = false;
      for (let j = 0; j < m && !blocked; j++) {
        const q = rest[j]!;
        if (q !== a && q !== b && q !== c && inside(a, b, c, q)) blocked = true;
      }
      if (!blocked) {
        ear = k;
        break;
      }
    }
    if (ear < 0) {
      // no clean ear (collinear run or numeric trouble): drop a collinear point, else cut the sharpest corner
      const flat = rest.findIndex((_, k) => Math.abs(cross(rest[(k + m - 1) % m]!, rest[k]!, rest[(k + 1) % m]!)) <= 1e-12);
      if (flat >= 0) {
        rest.splice(flat, 1);
        continue;
      }
      ear = widestAt;
    }
    const a = rest[(ear + rest.length - 1) % rest.length]!;
    const b = rest[ear]!;
    const c = rest[(ear + 1) % rest.length]!;
    if (cross(a, b, c) > 1e-12) out.push(a, b, c);
    rest.splice(ear, 1);
  }
  if (rest.length === 3 && cross(rest[0]!, rest[1]!, rest[2]!) > 1e-12) out.push(rest[0]!, rest[1]!, rest[2]!);
  return Uint16Array.from(out);
}

function build(kind: OutlineKind, segments: number): Outline {
  const steps = Math.max(4, Math.min(30, Math.round(segments / 6)));
  const raw = tracePath(kind, steps);
  // drop repeated points (where two curves meet, a closing point equal to the first one)
  const pts: number[] = [];
  for (let i = 0; i < raw.length; i += 2) {
    const x = raw[i]!;
    const y = raw[i + 1]!;
    const n = pts.length;
    if (n >= 2 && Math.hypot(x - pts[n - 2]!, y - pts[n - 1]!) < 1e-9) continue;
    pts.push(x, y);
  }
  while (pts.length > 4 && Math.hypot(pts[0]! - pts[pts.length - 2]!, pts[1]! - pts[pts.length - 1]!) < 1e-9) pts.length -= 2;
  // stretch the bounding box to the unit square
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    x0 = Math.min(x0, pts[i]!);
    x1 = Math.max(x1, pts[i]!);
    y0 = Math.min(y0, pts[i + 1]!);
    y1 = Math.max(y1, pts[i + 1]!);
  }
  const sx = x1 - x0 > 1e-9 ? 1 / (x1 - x0) : 1;
  const sy = y1 - y0 > 1e-9 ? 1 / (y1 - y0) : 1;
  for (let i = 0; i < pts.length; i += 2) {
    pts[i] = (pts[i]! - x0) * sx - 0.5;
    pts[i + 1] = (pts[i + 1]! - y0) * sy - 0.5;
  }
  // positive area, so every triangle and the front face share one winding
  if (area2(pts) < 0) {
    const flipped: number[] = [];
    for (let i = pts.length / 2 - 1; i >= 0; i--) flipped.push(pts[i * 2]!, pts[i * 2 + 1]!);
    pts.splice(0, pts.length, ...flipped);
  }
  const points = Float64Array.from(pts);
  const uvs = new Float32Array(points.length);
  for (let i = 0; i < points.length; i++) uvs[i] = Math.min(1, Math.max(0, points[i]! + 0.5));
  return { points, uvs, triangles: triangulate(points) };
}

const cache = new Map<string, Outline>();

/** the outline of a shape, built once per kind (+ curve steps for the heart); callers must not change the arrays */
export function outlineFor(kind: OutlineKind, segments = OUTLINE_SEGMENTS): Outline {
  const seg = kind === 'heart' ? Math.max(3, Math.min(180, Math.round(segments))) : 0;
  const key = `${kind}:${seg}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const o = build(kind, seg || OUTLINE_SEGMENTS);
  cache.set(key, o);
  return o;
}

/** true for the shapes that are an outline pushed back along z */
export function isOutlineShape(shape: string): shape is OutlineKind {
  return (OUTLINE_KINDS as readonly string[]).includes(shape);
}
