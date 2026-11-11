/**
 * the line around a 3d solid (box, sphere, star ...), as pure data (no gl).
 *
 * a shape clip's outline used to be painted into the flat picture and wrapped round the solid with it: a dot at the
 * poles of a sphere, a square in the middle of a star. on a solid the line belongs to the solid instead: it is centered
 * on the silhouette and on every hard edge (the edges of a box, the rims of a cylinder, the front and back outline of a
 * star), like the 2d line is centered on the edge of the flat figure.
 *
 * the renderer draws it from three pieces, all in the unit space of the mesh (x, y, z in -0.5..0.5 plus the room the
 * line needs), so the plane's own model matrix places them:
 *   hull   the solid pushed out by half the line width
 *   core   the solid pulled in by half the line width
 *   strips a band of half the line width on both faces of every hard edge, lying on the faces
 * on screen the line is what the hull covers and the core does not (the silhouette, half the width on each side of it),
 * plus the strips (the hard edges inside the silhouette).
 *
 * the mesh is scaled by `sx, sy, sz` inside the model matrix (clip width, height, thickness in canvas pixels), so the
 * work is done in that scaled space, where `width` is a real length, and the result is divided back into unit space.
 *
 * how the pieces are made:
 *   1. topology, once per shape: the mesh is welded (uv seams, cap rings and pole vertices become one vertex), its
 *      winding is made consistent and outward, an edge is hard when it has not exactly two triangles or the two
 *      triangles differ by more than 35 degrees, and around a vertex the triangles linked by soft edges form a smoothing
 *      group. this is classified in unit space, so stretching a clip never changes which edges are hard.
 *   2. per call, in scaled space: every group of a vertex gets a normal and a reach, so each of its faces moves out by
 *      at least half the width; the offset of the vertex solves that for all its groups (a box corner moves out by half
 *      the width on every axis, a cone tip moves up further than half the width). hull = vertex + offset, core =
 *      vertex - offset * k, where k keeps the core from turning inside out on thin solids (it is measured against the
 *      longest offset, not the width, because a corner offset is longer than the width).
 *   3. the strips lie on the faces next to every hard edge, plus a small join triangle at each vertex where a group has
 *      two hard edges (the inward corners of a star would otherwise show a notch).
 */
import { shapeMesh, knownShape } from './meshes';
import type { Shape3D } from '../../types';

export interface SolidOutline {
  /** triangles (3 indices each) into `hull` and `core`: the mesh of the shape with vertices at the same place welded */
  indices: Uint16Array;
  /** x, y, z per welded vertex, unit space: the solid pushed out by half the line width */
  hull: Float32Array;
  /** x, y, z per welded vertex, unit space: the solid pulled in by half the line width */
  core: Float32Array;
  /** x, y, z per vertex, plain triangles (3 vertices each, no index), unit space: the bands along the hard edges */
  strips: Float32Array;
}

const EMPTY: SolidOutline = { indices: new Uint16Array(0), hull: new Float32Array(0), core: new Float32Array(0), strips: new Float32Array(0) };

/** edges whose faces meet at more than this angle are hard */
const HARD_COS = Math.cos((35 * Math.PI) / 180);
/** unit space welding grid */
const WELD = 1e5;
/** smallest size the scaled space is allowed to collapse to */
const MIN_SIZE = 1e-3;
const CACHE_LIMIT = 24;

interface Topology {
  nv: number;
  nt: number;
  /** welded positions, unit space */
  pos: Float64Array;
  /** consistently wound, outward */
  tris: Uint16Array;
  /** csr: the triangles touching each vertex */
  vStart: Int32Array;
  vTri: Int32Array;
  /** smoothing group (local to the vertex) of each csr slot, and how many groups a vertex has */
  slotGroup: Int32Array;
  vGroups: Int32Array;
  maxGroups: number;
  /** a, b, c (third vertex), triangle: one entry per triangle next to a hard edge */
  hard: Int32Array;
  /** vertex, then (triangle, other vertex, third vertex) twice: the join triangles */
  joins: Int32Array;
}

const topoCache = new Map<string, Topology | null>();

function sub(a: ArrayLike<number>, i: number, j: number, k: number): number {
  return a[i * 3 + k]! - a[j * 3 + k]!;
}

function buildTopology(shape: Shape3D): Topology | null {
  const mesh = shapeMesh(shape);
  const np = mesh.positions.length / 3;
  if (np === 0 || mesh.indices.length === 0) return null;
  // weld
  const keyMap = new Map<string, number>();
  const remap = new Int32Array(np);
  const wp: number[] = [];
  for (let i = 0; i < np; i++) {
    const x = mesh.positions[i * 3]!, y = mesh.positions[i * 3 + 1]!, z = mesh.positions[i * 3 + 2]!;
    const key = `${Math.round(x * WELD)},${Math.round(y * WELD)},${Math.round(z * WELD)}`;
    let id = keyMap.get(key);
    if (id === undefined) {
      id = wp.length / 3;
      keyMap.set(key, id);
      wp.push(x, y, z);
    }
    remap[i] = id;
  }
  const nv = wp.length / 3;
  const pos = Float64Array.from(wp);
  const tl: number[] = [];
  for (let t = 0; t + 2 < mesh.indices.length; t += 3) {
    const a = remap[mesh.indices[t]!]!, b = remap[mesh.indices[t + 1]!]!, c = remap[mesh.indices[t + 2]!]!;
    if (a === b || b === c || a === c) continue;
    const ux = sub(pos, b, a, 0), uy = sub(pos, b, a, 1), uz = sub(pos, b, a, 2);
    const vx = sub(pos, c, a, 0), vy = sub(pos, c, a, 1), vz = sub(pos, c, a, 2);
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    if (cx * cx + cy * cy + cz * cz < 1e-20) continue;
    tl.push(a, b, c);
  }
  const nt = tl.length / 3;
  if (nt === 0) return null;
  const tris = Uint16Array.from(tl);

  // edges: unordered key -> triangles
  const edgeKey = (a: number, b: number): number => (a < b ? a * nv + b : b * nv + a);
  const edges = new Map<number, number[]>();
  for (let t = 0; t < nt; t++) {
    for (let k = 0; k < 3; k++) {
      const key = edgeKey(tris[t * 3 + k]!, tris[t * 3 + (k + 1) % 3]!);
      const l = edges.get(key);
      if (l) l.push(t);
      else edges.set(key, [t]);
    }
  }

  // consistent winding: flood fill over shared edges, then every component outward by its signed volume
  const hasDir = (t: number, a: number, b: number): boolean => {
    for (let k = 0; k < 3; k++) if (tris[t * 3 + k] === a && tris[t * 3 + (k + 1) % 3] === b) return true;
    return false;
  };
  const flip = (t: number): void => {
    const tmp = tris[t * 3 + 1]!;
    tris[t * 3 + 1] = tris[t * 3 + 2]!;
    tris[t * 3 + 2] = tmp;
  };
  const seen = new Uint8Array(nt);
  for (let start = 0; start < nt; start++) {
    if (seen[start]) continue;
    const comp = [start];
    seen[start] = 1;
    for (let qi = 0; qi < comp.length; qi++) {
      const t = comp[qi]!;
      for (let k = 0; k < 3; k++) {
        const a = tris[t * 3 + k]!, b = tris[t * 3 + (k + 1) % 3]!;
        const l = edges.get(edgeKey(a, b))!;
        if (l.length !== 2) continue;
        const u = l[0] === t ? l[1]! : l[0]!;
        if (seen[u]) continue;
        if (hasDir(u, a, b)) flip(u);
        seen[u] = 1;
        comp.push(u);
      }
    }
    let vol = 0;
    for (const t of comp) {
      const a = tris[t * 3]!, b = tris[t * 3 + 1]!, c = tris[t * 3 + 2]!;
      const ux = sub(pos, b, a, 0), uy = sub(pos, b, a, 1), uz = sub(pos, b, a, 2);
      const vx = sub(pos, c, a, 0), vy = sub(pos, c, a, 1), vz = sub(pos, c, a, 2);
      vol += pos[a * 3]! * (uy * vz - uz * vy) + pos[a * 3 + 1]! * (uz * vx - ux * vz) + pos[a * 3 + 2]! * (ux * vy - uy * vx);
    }
    if (vol < 0) for (const t of comp) flip(t);
  }

  // unit space normals, hard edges
  const un = new Float64Array(nt * 3);
  for (let t = 0; t < nt; t++) {
    const a = tris[t * 3]!, b = tris[t * 3 + 1]!, c = tris[t * 3 + 2]!;
    const ux = sub(pos, b, a, 0), uy = sub(pos, b, a, 1), uz = sub(pos, b, a, 2);
    const vx = sub(pos, c, a, 0), vy = sub(pos, c, a, 1), vz = sub(pos, c, a, 2);
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    const len = Math.hypot(cx, cy, cz) || 1;
    un[t * 3] = cx / len;
    un[t * 3 + 1] = cy / len;
    un[t * 3 + 2] = cz / len;
  }
  const hardSet = new Set<number>();
  const hardList: number[] = [];
  for (const [key, l] of edges) {
    let hard = l.length !== 2;
    if (!hard) {
      const p = l[0]! * 3, q = l[1]! * 3;
      hard = un[p]! * un[q]! + un[p + 1]! * un[q + 1]! + un[p + 2]! * un[q + 2]! < HARD_COS;
    }
    if (!hard) continue;
    hardSet.add(key);
    const a = Math.floor(key / nv), b = key - a * nv;
    for (const t of l) {
      let c = -1;
      for (let k = 0; k < 3; k++) {
        const v = tris[t * 3 + k]!;
        if (v !== a && v !== b) c = v;
      }
      hardList.push(a, b, c, t);
    }
  }

  // vertex -> triangles (csr)
  const vStart = new Int32Array(nv + 1);
  for (let i = 0; i < nt * 3; i++) vStart[tris[i]! + 1]!++;
  for (let v = 0; v < nv; v++) vStart[v + 1]! += vStart[v]!;
  const vTri = new Int32Array(nt * 3);
  const fill = vStart.slice(0, nv);
  for (let t = 0; t < nt; t++) for (let k = 0; k < 3; k++) vTri[fill[tris[t * 3 + k]!]!++] = t;

  // smoothing groups: triangles at a vertex linked through soft edges at that vertex
  const slotGroup = new Int32Array(nt * 3);
  const vGroups = new Int32Array(nv);
  let maxGroups = 1;
  const joins: number[] = [];
  const parent: number[] = [];
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  for (let v = 0; v < nv; v++) {
    const s0 = vStart[v]!, s1 = vStart[v + 1]!, n = s1 - s0;
    parent.length = n;
    for (let i = 0; i < n; i++) parent[i] = i;
    for (let i = 0; i < n; i++) {
      const t = vTri[s0 + i]!;
      for (let k = 0; k < 3; k++) {
        const w = tris[t * 3 + k]!;
        if (w === v) continue;
        const key = edgeKey(v, w);
        if (hardSet.has(key)) continue;
        const l = edges.get(key)!;
        const u = l[0] === t ? l[1]! : l[0]!;
        for (let j = 0; j < n; j++) {
          if (vTri[s0 + j] === u) {
            parent[find(i)] = find(j);
            break;
          }
        }
      }
    }
    const ids = new Map<number, number>();
    for (let i = 0; i < n; i++) {
      const r = find(i);
      let g = ids.get(r);
      if (g === undefined) {
        g = ids.size;
        ids.set(r, g);
      }
      slotGroup[s0 + i] = g;
    }
    vGroups[v] = ids.size;
    if (ids.size > maxGroups) maxGroups = ids.size;
    // join triangles: a group with two hard edges at this vertex
    for (let g = 0; g < ids.size; g++) {
      const found: number[] = [];
      for (let i = 0; i < n && found.length < 6; i++) {
        if (slotGroup[s0 + i] !== g) continue;
        const t = vTri[s0 + i]!;
        for (let k = 0; k < 3; k++) {
          const w = tris[t * 3 + k]!;
          if (w === v || !hardSet.has(edgeKey(v, w))) continue;
          let c = -1;
          for (let m = 0; m < 3; m++) {
            const x = tris[t * 3 + m]!;
            if (x !== v && x !== w) c = x;
          }
          if (found.length < 6) found.push(t, w, c);
        }
      }
      if (found.length >= 6) joins.push(v, found[0]!, found[1]!, found[2]!, found[3]!, found[4]!, found[5]!);
    }
  }
  return {
    nv, nt, pos, tris, vStart, vTri, slotGroup, vGroups, maxGroups,
    hard: Int32Array.from(hardList), joins: Int32Array.from(joins),
  };
}

function topologyOf(shape: Shape3D): Topology | null {
  let t = topoCache.get(shape);
  if (t === undefined) {
    t = buildTopology(shape);
    topoCache.set(shape, t);
  }
  return t;
}

interface Offsets {
  /** scaled space vertex positions */
  ps: Float64Array;
  /** per triangle unit normal, scaled space */
  tnu: Float64Array;
  /** offset of every vertex, scaled space */
  d: Float64Array;
  dmax: number;
}

/** the scaled space geometry and the offset of every vertex for a half width h */
function computeOffsets(tp: Topology, sx: number, sy: number, sz: number, h: number): Offsets {
  const { nv, nt, pos, tris, vStart, vTri, slotGroup, vGroups, maxGroups } = tp;
  const ps = new Float64Array(nv * 3);
  for (let v = 0; v < nv; v++) {
    ps[v * 3] = pos[v * 3]! * sx;
    ps[v * 3 + 1] = pos[v * 3 + 1]! * sy;
    ps[v * 3 + 2] = pos[v * 3 + 2]! * sz;
  }
  const tnu = new Float64Array(nt * 3);
  const tnr = new Float64Array(nt * 3);
  for (let t = 0; t < nt; t++) {
    const a = tris[t * 3]!, b = tris[t * 3 + 1]!, c = tris[t * 3 + 2]!;
    const ux = sub(ps, b, a, 0), uy = sub(ps, b, a, 1), uz = sub(ps, b, a, 2);
    const vx = sub(ps, c, a, 0), vy = sub(ps, c, a, 1), vz = sub(ps, c, a, 2);
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    tnr[t * 3] = cx;
    tnr[t * 3 + 1] = cy;
    tnr[t * 3 + 2] = cz;
    const len = Math.hypot(cx, cy, cz);
    if (len > 0) {
      tnu[t * 3] = cx / len;
      tnu[t * 3 + 1] = cy / len;
      tnu[t * 3 + 2] = cz / len;
    }
  }
  const d = new Float64Array(nv * 3);
  const limit = 4 * h;
  const gn = new Float64Array(maxGroups * 3);
  const gu = new Float64Array(maxGroups * 3);
  const gmin = new Float64Array(maxGroups);
  const gq = new Float64Array(maxGroups);
  let dmax = 0;
  for (let v = 0; v < nv; v++) {
    const g = vGroups[v]!;
    gn.fill(0, 0, g * 3);
    gu.fill(0, 0, g * 3);
    gmin.fill(Infinity, 0, g);
    const s0 = vStart[v]!, s1 = vStart[v + 1]!;
    for (let s = s0; s < s1; s++) {
      const t = vTri[s]!, k = slotGroup[s]! * 3;
      gn[k]! += tnr[t * 3]!;
      gn[k + 1]! += tnr[t * 3 + 1]!;
      gn[k + 2]! += tnr[t * 3 + 2]!;
      gu[k]! += tnu[t * 3]!;
      gu[k + 1]! += tnu[t * 3 + 1]!;
      gu[k + 2]! += tnu[t * 3 + 2]!;
    }
    // normalize the group normals; a group with no direction is dropped
    let m = 0;
    for (let i = 0; i < g; i++) {
      let x = gn[i * 3]!, y = gn[i * 3 + 1]!, z = gn[i * 3 + 2]!;
      let len = Math.hypot(x, y, z);
      if (!(len > 1e-18)) {
        x = gu[i * 3]!; y = gu[i * 3 + 1]!; z = gu[i * 3 + 2]!;
        len = Math.hypot(x, y, z);
      }
      if (!(len > 1e-18)) {
        gmin[i] = NaN;
        continue;
      }
      gn[i * 3] = x / len;
      gn[i * 3 + 1] = y / len;
      gn[i * 3 + 2] = z / len;
      m++;
    }
    if (m === 0) continue;
    for (let s = s0; s < s1; s++) {
      const i = slotGroup[s]!, t = vTri[s]!;
      if (gmin[i] !== gmin[i]) continue;
      const dot = gn[i * 3]! * tnu[t * 3]! + gn[i * 3 + 1]! * tnu[t * 3 + 1]! + gn[i * 3 + 2]! * tnu[t * 3 + 2]!;
      if (dot < gmin[i]!) gmin[i] = dot;
    }
    // pack the valid groups
    let c = 0;
    for (let i = 0; i < g; i++) {
      if (gmin[i] !== gmin[i]) continue;
      gn[c * 3] = gn[i * 3]!;
      gn[c * 3 + 1] = gn[i * 3 + 1]!;
      gn[c * 3 + 2] = gn[i * 3 + 2]!;
      gq[c] = h / Math.max(gmin[i]!, 0.25);
      c++;
    }
    let dx = 0, dy = 0, dz = 0, ok = false;
    if (c === 1) {
      dx = gn[0]! * gq[0]!; dy = gn[1]! * gq[0]!; dz = gn[2]! * gq[0]!;
      ok = true;
    } else if (c === 2) {
      const cc = gn[0]! * gn[3]! + gn[1]! * gn[4]! + gn[2]! * gn[5]!;
      const det = 1 - cc * cc;
      if (det > 1e-4) {
        const a = (gq[0]! - cc * gq[1]!) / det, b = (gq[1]! - cc * gq[0]!) / det;
        dx = a * gn[0]! + b * gn[3]!; dy = a * gn[1]! + b * gn[4]!; dz = a * gn[2]! + b * gn[5]!;
        ok = true;
      }
    } else if (c >= 3) {
      // normal equations (for exactly three groups this is the plain 3x3 solve)
      let m00 = 0, m01 = 0, m02 = 0, m11 = 0, m12 = 0, m22 = 0, r0 = 0, r1 = 0, r2 = 0;
      for (let i = 0; i < c; i++) {
        const x = gn[i * 3]!, y = gn[i * 3 + 1]!, z = gn[i * 3 + 2]!, q = gq[i]!;
        m00 += x * x; m01 += x * y; m02 += x * z; m11 += y * y; m12 += y * z; m22 += z * z;
        r0 += x * q; r1 += y * q; r2 += z * q;
      }
      const c00 = m11 * m22 - m12 * m12, c01 = m02 * m12 - m01 * m22, c02 = m01 * m12 - m02 * m11;
      const det = m00 * c00 + m01 * c01 + m02 * c02;
      if (Math.abs(det) > 1e-3 * c * c * c / 27) {
        const c11 = m00 * m22 - m02 * m02, c12 = m01 * m02 - m00 * m12, c22 = m00 * m11 - m01 * m01;
        dx = (c00 * r0 + c01 * r1 + c02 * r2) / det;
        dy = (c01 * r0 + c11 * r1 + c12 * r2) / det;
        dz = (c02 * r0 + c12 * r1 + c22 * r2) / det;
        ok = true;
      }
    }
    if (!ok) {
      // singular: the average direction, far enough for the farthest face
      let ax = 0, ay = 0, az = 0, qm = 0;
      for (let i = 0; i < c; i++) {
        ax += gn[i * 3]!; ay += gn[i * 3 + 1]!; az += gn[i * 3 + 2]!;
        if (gq[i]! > qm) qm = gq[i]!;
      }
      const len = Math.hypot(ax, ay, az);
      if (len > 1e-12) {
        dx = (ax / len) * qm; dy = (ay / len) * qm; dz = (az / len) * qm;
      }
    }
    let len = Math.hypot(dx, dy, dz);
    if (!isFinite(len)) {
      dx = dy = dz = 0;
      len = 0;
    }
    if (len > limit) {
      const f = limit / len;
      dx *= f; dy *= f; dz *= f;
      len = limit;
    }
    d[v * 3] = dx;
    d[v * 3 + 1] = dy;
    d[v * 3 + 2] = dz;
    if (len > dmax) dmax = len;
  }
  return { ps, tnu, d, dmax };
}

const thicknessCache = new Map<string, number>();

/**
 * how far a ray going inward from a (spread) sample of vertices travels before it hits the solid again, at the
 * proportions rx : ry : rz (largest side 1). linear in a uniform scale, so it is cached per shape and ratio.
 */
function thicknessOf(tp: Topology, shape: Shape3D, rx: number, ry: number, rz: number): number {
  const key = `${shape}|${rx}|${ry}|${rz}`;
  const hit = thicknessCache.get(key);
  if (hit !== undefined) return hit;
  // the direction of an offset does not depend on the width, so any h will do
  const { ps, d } = computeOffsets(tp, rx, ry, rz, 1);
  const { nv, nt, tris } = tp;
  const step = Math.max(1, Math.floor(nv / 64));
  let best = Infinity;
  for (let v = 0; v < nv; v += step) {
    const len = Math.hypot(d[v * 3]!, d[v * 3 + 1]!, d[v * 3 + 2]!);
    if (!(len > 1e-9)) continue;
    const ox = ps[v * 3]!, oy = ps[v * 3 + 1]!, oz = ps[v * 3 + 2]!;
    const dx = -d[v * 3]! / len, dy = -d[v * 3 + 1]! / len, dz = -d[v * 3 + 2]! / len;
    for (let t = 0; t < nt; t++) {
      const a = tris[t * 3]!, b = tris[t * 3 + 1]!, c = tris[t * 3 + 2]!;
      if (a === v || b === v || c === v) continue;
      const e1x = sub(ps, b, a, 0), e1y = sub(ps, b, a, 1), e1z = sub(ps, b, a, 2);
      const e2x = sub(ps, c, a, 0), e2y = sub(ps, c, a, 1), e2z = sub(ps, c, a, 2);
      // moller trumbore, both sides of the triangle
      const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (Math.abs(det) < 1e-14) continue;
      const inv = 1 / det;
      const tx = ox - ps[a * 3]!, ty = oy - ps[a * 3 + 1]!, tz = oz - ps[a * 3 + 2]!;
      const u = (tx * px + ty * py + tz * pz) * inv;
      if (u < 0 || u > 1) continue;
      const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
      const w = (dx * qx + dy * qy + dz * qz) * inv;
      if (w < 0 || u + w > 1) continue;
      const dist = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (dist > 1e-9 && dist < best) best = dist;
    }
  }
  thicknessCache.set(key, best);
  return best;
}

const resultCache = new Map<string, SolidOutline>();

/**
 * the outline pieces of `shape` scaled by sx, sy, sz, for a line `width` wide (in the scaled space).
 * 'plane' and unknown ids give empty arrays. cached, callers must not change the arrays.
 */
export function solidOutline(shape: Shape3D | string | undefined, sx: number, sy: number, sz: number, width: number): SolidOutline {
  const id = knownShape(shape);
  if (id === 'plane' || !(width > 0) || !isFinite(width)) return EMPTY;
  const cx = isFinite(sx) && sx > MIN_SIZE ? sx : MIN_SIZE;
  const cy = isFinite(sy) && sy > MIN_SIZE ? sy : MIN_SIZE;
  const cz = isFinite(sz) && sz > MIN_SIZE ? sz : MIN_SIZE;
  const key = `${id}|${cx}|${cy}|${cz}|${width}`;
  const hit = resultCache.get(key);
  if (hit) {
    // keep the most recently used at the end
    resultCache.delete(key);
    resultCache.set(key, hit);
    return hit;
  }
  const tp = topologyOf(id);
  const out = tp ? build(tp, id, cx, cy, cz, width) : EMPTY;
  resultCache.set(key, out);
  if (resultCache.size > CACHE_LIMIT) resultCache.delete(resultCache.keys().next().value as string);
  return out;
}

const dirScratch = new Float64Array(3);

/** the band on triangle t next to the edge a-w: its direction (in the face, away from the edge) goes to dirScratch, the reach is returned */
function bandOf(o: Offsets, t: number, a: number, w: number, c: number, h: number): number {
  const { ps, tnu } = o;
  const ex = sub(ps, w, a, 0), ey = sub(ps, w, a, 1), ez = sub(ps, w, a, 2);
  const nx = tnu[t * 3]!, ny = tnu[t * 3 + 1]!, nz = tnu[t * 3 + 2]!;
  let tx = ny * ez - nz * ey, ty = nz * ex - nx * ez, tz = nx * ey - ny * ex;
  const len = Math.hypot(tx, ty, tz);
  if (!(len > 1e-18)) {
    dirScratch[0] = dirScratch[1] = dirScratch[2] = 0;
    return 0;
  }
  tx /= len; ty /= len; tz /= len;
  let dot = tx * sub(ps, c, a, 0) + ty * sub(ps, c, a, 1) + tz * sub(ps, c, a, 2);
  if (dot < 0) {
    tx = -tx; ty = -ty; tz = -tz;
    dot = -dot;
  }
  dirScratch[0] = tx;
  dirScratch[1] = ty;
  dirScratch[2] = tz;
  return Math.min(h, dot);
}

function build(tp: Topology, shape: Shape3D, sx: number, sy: number, sz: number, width: number): SolidOutline {
  const h = width / 2;
  const o = computeOffsets(tp, sx, sy, sz, h);
  const { nv } = tp;
  // the core is pulled in by k * d: k keeps it from crossing the far side of a thin solid
  const m = Math.max(sx, sy, sz);
  const ratio = (s: number): number => Math.max(Math.round((s / m) * 1000) / 1000, MIN_SIZE);
  const T = thicknessOf(tp, shape, ratio(sx), ratio(sy), ratio(sz)) * m;
  const k = o.dmax > 0 && isFinite(T) ? Math.min(1, (0.45 * T) / o.dmax) : 1;
  const hull = new Float32Array(nv * 3);
  const core = new Float32Array(nv * 3);
  const s = [sx, sy, sz];
  for (let v = 0; v < nv; v++) {
    for (let a = 0; a < 3; a++) {
      const p = o.ps[v * 3 + a]!, dd = o.d[v * 3 + a]!;
      hull[v * 3 + a] = (p + dd) / s[a]!;
      core[v * 3 + a] = (p - dd * k) / s[a]!;
    }
  }
  const strips = new Float32Array((tp.hard.length / 4) * 18 + (tp.joins.length / 7) * 9);
  let n = 0;
  const put = (x: number, y: number, z: number): void => {
    strips[n++] = x / sx;
    strips[n++] = y / sy;
    strips[n++] = z / sz;
  };
  const ps = o.ps;
  for (let i = 0; i < tp.hard.length; i += 4) {
    const a = tp.hard[i]!, b = tp.hard[i + 1]!, c = tp.hard[i + 2]!, t = tp.hard[i + 3]!;
    const r = bandOf(o, t, a, b, c, h);
    const ox = dirScratch[0]! * r, oy = dirScratch[1]! * r, oz = dirScratch[2]! * r;
    const ax = ps[a * 3]!, ay = ps[a * 3 + 1]!, az = ps[a * 3 + 2]!;
    const bx = ps[b * 3]!, by = ps[b * 3 + 1]!, bz = ps[b * 3 + 2]!;
    put(ax, ay, az); put(bx, by, bz); put(bx + ox, by + oy, bz + oz);
    put(ax, ay, az); put(bx + ox, by + oy, bz + oz); put(ax + ox, ay + oy, az + oz);
  }
  for (let i = 0; i < tp.joins.length; i += 7) {
    const a = tp.joins[i]!;
    const ax = ps[a * 3]!, ay = ps[a * 3 + 1]!, az = ps[a * 3 + 2]!;
    const r1 = bandOf(o, tp.joins[i + 1]!, a, tp.joins[i + 2]!, tp.joins[i + 3]!, h);
    const x1 = ax + dirScratch[0]! * r1, y1 = ay + dirScratch[1]! * r1, z1 = az + dirScratch[2]! * r1;
    const r2 = bandOf(o, tp.joins[i + 4]!, a, tp.joins[i + 5]!, tp.joins[i + 6]!, h);
    const x2 = ax + dirScratch[0]! * r2, y2 = ay + dirScratch[1]! * r2, z2 = az + dirScratch[2]! * r2;
    put(ax, ay, az); put(x1, y1, z1); put(x2, y2, z2);
  }
  return { indices: tp.tris, hull, core, strips };
}
