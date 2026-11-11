/**
 * the unit meshes of the 3d shapes, as pure functions (no gl): x, y, z in -0.5..0.5, uv in 0..1.
 * world axes: x right, y down, z away from the viewer, so y = -0.5 is the top and z = -0.5 the side that
 * faces the viewer. the picture reads the right way round from outside on every face.
 * built once per shape + segment count and cached; the renderer uploads them as they are.
 * the caller scales the unit box to the clip (width, height and its depth rule).
 */
import { SHAPES_3D } from '../../types';
import type { Shape3D } from '../../types';
import { isOutlineShape, outlineFor } from './outline2d';
import type { OutlineKind } from './outline2d';

export interface MeshArrays {
  /** x, y, z per vertex */
  positions: Float32Array;
  /** u, v per vertex */
  uvs: Float32Array;
  indices: Uint16Array;
  /**
   * the index range of each side, in the order and with the names of faceNames(shape) (faces.ts). the ranges follow
   * each other and cover every index once. a plane has none (and a mesh with no sides is drawn in one go).
   */
  groups: MeshGroup[];
}

export interface MeshGroup {
  name: string;
  /** first index in `indices` */
  start: number;
  /** number of indices */
  count: number;
}

/** default number of segments around a round shape */
export const DEFAULT_SEGMENTS = 48;
/** a torus tube is round with this share of the ring radius */
export const TORUS_TUBE = 0.3;

const TAU = Math.PI * 2;

/** growing lists while building; typed once at the end */
class Builder {
  pos: number[] = [];
  uv: number[] = [];
  idx: number[] = [];
  groups: MeshGroup[] = [];
  /** the indices that follow belong to the side `name` */
  side(name: string): void {
    this.groups.push({ name, start: this.idx.length, count: 0 });
  }
  get count(): number {
    return this.pos.length / 3;
  }
  vert(x: number, y: number, z: number, u: number, v: number): number {
    this.pos.push(x, y, z);
    this.uv.push(u, v);
    return this.count - 1;
  }
  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }
  quad(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, b, c, a, c, d);
  }
  done(): MeshArrays {
    for (let i = 0; i < this.groups.length; i++) {
      const g = this.groups[i]!;
      g.count = (i + 1 < this.groups.length ? this.groups[i + 1]!.start : this.idx.length) - g.start;
    }
    return { positions: new Float32Array(this.pos), uvs: new Float32Array(this.uv), indices: new Uint16Array(this.idx), groups: this.groups };
  }
}

/** a flat disc at height y, the picture seen from above (top) or below (bottom) */
function cap(b: Builder, y: number, top: boolean, seg: number): void {
  const center = b.vert(0, y, 0, 0.5, 0.5);
  for (let i = 0; i <= seg; i++) {
    const a = (TAU * i) / seg;
    const x = 0.5 * Math.cos(a);
    const z = 0.5 * Math.sin(a);
    b.vert(x, y, z, x + 0.5, top ? 0.5 - z : z + 0.5);
  }
  for (let i = 0; i < seg; i++) b.tri(center, center + 1 + i, center + 2 + i);
}

function plane(): MeshArrays {
  const b = new Builder();
  b.vert(-0.5, -0.5, 0, 0, 0);
  b.vert(0.5, -0.5, 0, 1, 0);
  b.vert(0.5, 0.5, 0, 1, 1);
  b.vert(-0.5, 0.5, 0, 0, 1);
  b.quad(0, 1, 2, 3);
  return b.done();
}

function box(): MeshArrays {
  const b = new Builder();
  // each face: origin (its top left corner seen from outside), the step along u, the step along v
  const faces: [string, number[], number[], number[]][] = [
    ['front', [-0.5, -0.5, -0.5], [1, 0, 0], [0, 1, 0]], // faces the viewer
    ['back', [0.5, -0.5, 0.5], [-1, 0, 0], [0, 1, 0]],
    ['right', [0.5, -0.5, -0.5], [0, 0, 1], [0, 1, 0]],
    ['left', [-0.5, -0.5, 0.5], [0, 0, -1], [0, 1, 0]],
    ['top', [-0.5, -0.5, 0.5], [1, 0, 0], [0, 0, -1]], // y = -0.5
    ['bottom', [-0.5, 0.5, -0.5], [1, 0, 0], [0, 0, 1]],
  ];
  for (const [name, o, u, v] of faces) {
    b.side(name);
    const base = b.count;
    for (const [fu, fv] of [[0, 0], [1, 0], [1, 1], [0, 1]] as const) {
      b.vert(o[0]! + u[0]! * fu + v[0]! * fv, o[1]! + u[1]! * fu + v[1]! * fv, o[2]! + u[2]! * fu + v[2]! * fv, fu, fv);
    }
    b.quad(base, base + 1, base + 2, base + 3);
  }
  return b.done();
}

function sphere(seg: number): MeshArrays {
  const rings = Math.max(2, Math.round(seg / 2));
  const b = new Builder();
  b.side('surface');
  for (let j = 0; j <= rings; j++) {
    const v = j / rings;
    const r = 0.5 * Math.sin(Math.PI * v);
    const y = -0.5 * Math.cos(Math.PI * v);
    for (let i = 0; i <= seg; i++) {
      const u = i / seg;
      const a = TAU * (u - 0.5);
      // u = 0.5 faces the viewer, u grows to the right
      b.vert(r * Math.sin(a), y, -r * Math.cos(a), u, v);
    }
  }
  for (let j = 0; j < rings; j++) {
    for (let i = 0; i < seg; i++) {
      const p = j * (seg + 1) + i;
      b.idx.push(p, p + 1, p + seg + 2, p, p + seg + 2, p + seg + 1);
    }
  }
  return b.done();
}

function cylinder(seg: number): MeshArrays {
  const b = new Builder();
  b.side('side');
  for (let j = 0; j <= 1; j++) {
    for (let i = 0; i <= seg; i++) {
      const u = i / seg;
      const a = TAU * (u - 0.5);
      b.vert(0.5 * Math.sin(a), j - 0.5, -0.5 * Math.cos(a), u, j);
    }
  }
  for (let i = 0; i < seg; i++) b.idx.push(i, i + 1, i + seg + 2, i, i + seg + 2, i + seg + 1);
  b.side('top');
  cap(b, -0.5, true, seg);
  b.side('bottom');
  cap(b, 0.5, false, seg);
  return b.done();
}

/** apex up. u runs around the side (0.5 faces the viewer), v from the tip (0) to the base (1). */
function cone(seg: number): MeshArrays {
  const b = new Builder();
  b.side('side');
  const ring = b.count;
  for (let i = 0; i <= seg; i++) {
    const u = i / seg;
    const a = TAU * (u - 0.5);
    b.vert(0.5 * Math.sin(a), 0.5, -0.5 * Math.cos(a), u, 1);
  }
  // one tip vertex per segment, its u in the middle of the segment, so no triangle is degenerate
  for (let i = 0; i < seg; i++) {
    const tip = b.vert(0, -0.5, 0, (i + 0.5) / seg, 0);
    b.tri(tip, ring + i + 1, ring + i);
  }
  b.side('bottom');
  cap(b, 0.5, false, seg);
  return b.done();
}

/**
 * apex up, square base. every one of the four sides shows the whole picture (upright, base at the
 * bottom, tip at the top edge's middle): that reads better than a picture wrapped round four slopes.
 */
function pyramid(): MeshArrays {
  const b = new Builder();
  // base corners of each side seen from outside, left to right (same order as the box faces)
  const sides: [string, number, number, number, number][] = [
    ['front', -0.5, -0.5, 0.5, -0.5], // faces the viewer: x -0.5 -> 0.5 at z = -0.5
    ['right', 0.5, -0.5, 0.5, 0.5],
    ['back', 0.5, 0.5, -0.5, 0.5],
    ['left', -0.5, 0.5, -0.5, -0.5],
  ];
  for (const [name, x0, z0, x1, z1] of sides) {
    b.side(name);
    const t = b.vert(0, -0.5, 0, 0.5, 0);
    const l = b.vert(x0, 0.5, z0, 0, 1);
    const r = b.vert(x1, 0.5, z1, 1, 1);
    b.tri(t, r, l);
  }
  // base: the picture seen from below, like the box bottom
  b.side('bottom');
  const base = b.count;
  for (const [fu, fv] of [[0, 0], [1, 0], [1, 1], [0, 1]] as const) b.vert(-0.5 + fu, 0.5, -0.5 + fv, fu, fv);
  b.quad(base, base + 1, base + 2, base + 3);
  return b.done();
}

/**
 * a ring lying with its hole facing the viewer (axis = z). the outer edge touches +-0.5 in x and y,
 * so the ring radius is 0.5 / (1 + TORUS_TUBE) and the tube radius TORUS_TUBE of that (z reaches only
 * +-0.115 of the box). u runs around the ring from the top, clockwise on screen; v around the tube,
 * 0.5 = the crest that faces the viewer.
 */
function torus(seg: number): MeshArrays {
  const around = Math.max(3, seg);
  const tube = Math.max(3, Math.round(seg / 2));
  const R = 0.5 / (1 + TORUS_TUBE);
  const r = R * TORUS_TUBE;
  const b = new Builder();
  b.side('surface');
  for (let j = 0; j <= tube; j++) {
    const v = j / tube;
    const psi = TAU * v;
    const rho = R - r * Math.sin(psi);
    const z = r * Math.cos(psi);
    for (let i = 0; i <= around; i++) {
      const u = i / around;
      const th = TAU * u - Math.PI / 2;
      b.vert(rho * Math.cos(th), rho * Math.sin(th), z, u, v);
    }
  }
  for (let j = 0; j < tube; j++) {
    for (let i = 0; i < around; i++) {
      const p = j * (around + 1) + i;
      b.idx.push(p, p + 1, p + around + 2, p, p + around + 2, p + around + 1);
    }
  }
  return b.done();
}

/** share of the total height of one half-sphere end of the capsule (it is round on a clip twice as tall as wide) */
export const CAPSULE_CAP = 0.25;

/**
 * a tube along y with half-sphere ends. u runs around it (0.5 faces the viewer) like on the cylinder, v runs
 * from the top pole to the bottom pole: the ends take the first and last CAPSULE_CAP of v, so the picture
 * continues over the caps.
 */
function capsule(seg: number): MeshArrays {
  const rings = Math.max(2, Math.round(seg / 4));
  const b = new Builder();
  b.side('surface');
  const rows: [number, number, number][] = []; // radius, y, v
  for (let k = 0; k <= rings; k++) {
    const phi = (Math.PI / 2) * (k / rings);
    rows.push([0.5 * Math.sin(phi), -0.5 + CAPSULE_CAP * (1 - Math.cos(phi)), (CAPSULE_CAP * k) / rings]);
  }
  for (let k = 0; k <= rings; k++) {
    const phi = Math.PI / 2 + (Math.PI / 2) * (k / rings);
    rows.push([0.5 * Math.sin(phi), 0.5 - CAPSULE_CAP * (1 + Math.cos(phi)), 1 - CAPSULE_CAP + (CAPSULE_CAP * k) / rings]);
  }
  for (const [r, y, v] of rows) {
    for (let i = 0; i <= seg; i++) {
      const u = i / seg;
      const a = TAU * (u - 0.5);
      b.vert(r * Math.sin(a), y, -r * Math.cos(a), u, v);
    }
  }
  for (let j = 0; j < rows.length - 1; j++) {
    for (let i = 0; i < seg; i++) {
      const p = j * (seg + 1) + i;
      b.idx.push(p, p + 1, p + seg + 2, p, p + seg + 2, p + seg + 1);
    }
  }
  return b.done();
}

/**
 * an outline (see outline2d) pushed back along z: the front face at z = -0.5 shows the picture cut out by
 * the outline (uv = the outline's bounding box), the back face at z = +0.5 shows it mirrored left to right,
 * like the box back. the side wall goes all around and samples the picture where the outline is, on both
 * rings, so the picture's own colour at the edge is stretched across the thickness (no seam, no extra uv).
 * front triangles have positive area in x, y like the box front; the back is wound the other way.
 */
function extruded(kind: OutlineKind, seg: number): MeshArrays {
  const o = outlineFor(kind, seg);
  const n = o.points.length / 2;
  const b = new Builder();
  for (let i = 0; i < n; i++) b.vert(o.points[i * 2]!, o.points[i * 2 + 1]!, -0.5, o.uvs[i * 2]!, o.uvs[i * 2 + 1]!);
  for (let i = 0; i < n; i++) b.vert(o.points[i * 2]!, o.points[i * 2 + 1]!, 0.5, o.uvs[i * 2]!, o.uvs[i * 2 + 1]!);
  for (let i = 0; i < n; i++) b.vert(o.points[i * 2]!, o.points[i * 2 + 1]!, 0.5, 1 - o.uvs[i * 2]!, o.uvs[i * 2 + 1]!);
  b.side('front');
  for (let t = 0; t < o.triangles.length; t += 3) b.tri(o.triangles[t]!, o.triangles[t + 1]!, o.triangles[t + 2]!);
  b.side('back');
  for (let t = 0; t < o.triangles.length; t += 3) b.tri(2 * n + o.triangles[t]!, 2 * n + o.triangles[t + 2]!, 2 * n + o.triangles[t + 1]!);
  b.side('side');
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    // same handedness as the box faces (their normals point away from the viewer's side), culling is off anyway
    b.quad(i, n + i, n + j, j);
  }
  return b.done();
}

/** a shape id the renderer knows, else 'plane' (old projects, future ids) */
export function knownShape(shape: string | undefined): Shape3D {
  return shape !== undefined && (SHAPES_3D as string[]).includes(shape) ? (shape as Shape3D) : 'plane';
}

const cache = new Map<string, MeshArrays>();

/**
 * the mesh of a shape; unknown ids give the plane. cached per shape + segment count, so callers must not
 * change the arrays. `segments` only matters for round shapes.
 */
export function shapeMesh(shape: string | undefined, segments = DEFAULT_SEGMENTS): MeshArrays {
  const s = knownShape(shape);
  const seg = Math.max(3, Math.min(180, Math.round(segments)));
  const fixed = s === 'plane' || s === 'box' || s === 'pyramid' || s === 'prism' || s === 'hexagon' || s === 'star';
  const key = `${s}:${fixed ? 0 : seg}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const mesh = isOutlineShape(s) ? extruded(s, seg) : s === 'capsule' ? capsule(seg) :
    s === 'box' ? box() : s === 'sphere' ? sphere(seg) : s === 'cylinder' ? cylinder(seg) : s === 'cone' ? cone(seg) : s === 'pyramid' ? pyramid() : s === 'torus' ? torus(seg) : plane();
  cache.set(key, mesh);
  return mesh;
}

/** x, y, z, u, v per vertex in one array (what the renderer uploads) */
export function interleave(m: MeshArrays): Float32Array {
  const n = m.positions.length / 3;
  const out = new Float32Array(n * 5);
  for (let i = 0; i < n; i++) {
    out[i * 5] = m.positions[i * 3]!;
    out[i * 5 + 1] = m.positions[i * 3 + 1]!;
    out[i * 5 + 2] = m.positions[i * 3 + 2]!;
    out[i * 5 + 3] = m.uvs[i * 2]!;
    out[i * 5 + 4] = m.uvs[i * 2 + 1]!;
  }
  return out;
}
