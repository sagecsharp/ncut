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
 *   hull   everything within half the line width of the solid, rounded (the solid grown by a ball), plain triangles
 *   core   the solid, pulled in by half the line width only where its surface is curved (indexed triangles)
 *   strips a band of half the line width on both faces of every hard edge, lying on the faces
 * on screen the line is what the hull covers and the core does not (the silhouette, half the width on each side of it),
 * plus the strips (the hard edges inside the silhouette). h below is half the width.
 *
 * the mesh is scaled by `sx, sy, sz` inside the model matrix (clip width, height, thickness in canvas pixels), so the
 * work is done in that scaled space, where `width` is a real length, and the result is divided back into unit space.
 *
 * how the pieces are made:
 *   1. topology, once per shape: the mesh is welded (uv seams, cap rings and pole vertices become one vertex), its
 *      winding is made consistent and outward, an edge is hard when it has not exactly two triangles or the two
 *      triangles differ by more than 35 degrees, and around a vertex the triangles linked by soft edges form a smoothing
 *      group. a group is flat when all its triangles at the vertex share one normal (half a degree), else curved. this
 *      is classified in unit space, so stretching a clip never changes which edges are hard or which groups are flat.
 *   2. the hull is the union of three kinds of triangles, all in scaled space:
 *        faces  every triangle of the solid with each corner pushed out along the normal of its group at that vertex:
 *               h along the face normal for a flat group, along the averaged normal by min(q, 1.5 h) for a curved one,
 *               where q = h / max(smallest cosine between the group normal and a face of the group, 0.25)
 *        tubes  a tube of radius h (12 sides, no caps) round every hard edge. at a bend (a vertex with exactly two hard
 *               edges that turn by 25 degrees or less: the rim of a cylinder, the curved part of a heart outline) both
 *               tubes are made longer by h * tan(turn / 2), which closes the wedge between them without a ball
 *        balls  a ball of radius h (an octahedron cut twice, 128 triangles) at every vertex with hard edges that is not
 *               a bend (box corners, star tips), and at every vertex of a curved group whose q is more than 1.15 h
 *               (the tip of a cone)
 *      so the silhouette line is h wide on the outside with round joins, like the flat outline. the triangles overlap
 *      and have any winding: the renderer paints every pixel once through the stencil.
 *   3. the core is the solid itself, moved only at vertices with curved groups: the pull solves N . d = q over those
 *      groups (one group: N q, two: a 2x2 system, more: least squares, at most 4 h). a flat group at the vertex never
 *      lets the pull poke out through its face (the rim of a cone base stays on the base). the pull is scaled by k, which
 *      keeps the core from turning inside out on thin solids (measured against the longest pull). a solid with only flat
 *      faces has the solid itself as core: the inner half of its line is made by the strips.
 *   4. the strips lie on the faces next to every hard edge, plus a small join triangle at each vertex where a group has
 *      two hard edges (the inward corners of a star would otherwise show a notch).
 */
import { shapeMesh, knownShape } from './meshes';
import type { Shape3D } from '../../types';

export interface SolidOutline {
  /** triangles (3 indices each) into `core`: the mesh of the shape with vertices at the same place welded */
  indices: Uint16Array;
  /** x, y, z per vertex, plain triangles (3 vertices each, no index, any winding, overlaps allowed), unit space: everything within half the line width of the solid */
  hull: Float32Array;
  /** x, y, z per welded vertex, unit space: the solid, pulled in by half the line width where its surface is curved */
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
/** a group is flat when all its faces at the vertex are within about half a degree of each other */
const FLAT_COS = Math.cos((0.5 * Math.PI) / 180);
/** a vertex with two hard edges is a bend when the line turns by at most this angle there */
const BEND_COS = Math.cos((25 * Math.PI) / 180);
/** a curved group puts a ball on its vertex when its reach is more than this many half widths (a cone tip) */
const BALL_Q = 1.15;
/** a curved group pushes its faces out by at most this many half widths */
const PUSH_MAX = 1.5;
const TUBE_SIDES = 12;

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
  /** 1 when the group of a csr slot is flat */
  slotFlat: Uint8Array;
  /** the csr slot of triangle t at its corner k, at t * 3 + k */
  cornerSlot: Int32Array;
  /** unit space normal per triangle */
  un: Float64Array;
  /** the hard edges, a, b per edge, each once */
  hardEdges: Int32Array;
  /** how many hard edges touch each vertex, and the first two of their far ends */
  hardDeg: Uint8Array;
  hardNb: Int32Array;
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
  const hardEdges: number[] = [];
  for (const [key, l] of edges) {
    let hard = l.length !== 2;
    if (!hard) {
      const p = l[0]! * 3, q = l[1]! * 3;
      hard = un[p]! * un[q]! + un[p + 1]! * un[q + 1]! + un[p + 2]! * un[q + 2]! < HARD_COS;
    }
    if (!hard) continue;
    hardSet.add(key);
    const a = Math.floor(key / nv), b = key - a * nv;
    hardEdges.push(a, b);
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
  const cornerSlot = new Int32Array(nt * 3);
  for (let t = 0; t < nt; t++) {
    for (let k = 0; k < 3; k++) {
      const slot = fill[tris[t * 3 + k]!]!++;
      vTri[slot] = t;
      cornerSlot[t * 3 + k] = slot;
    }
  }
  const hardDeg = new Uint8Array(nv);
  const hardNb = new Int32Array(nv * 2).fill(-1);
  for (let i = 0; i < hardEdges.length; i += 2) {
    const a = hardEdges[i]!, b = hardEdges[i + 1]!;
    if (hardDeg[a]! < 2) hardNb[a * 2 + hardDeg[a]!] = b;
    if (hardDeg[b]! < 2) hardNb[b * 2 + hardDeg[b]!] = a;
    if (hardDeg[a]! < 255) hardDeg[a]!++;
    if (hardDeg[b]! < 255) hardDeg[b]!++;
  }

  // smoothing groups: triangles at a vertex linked through soft edges at that vertex
  const slotGroup = new Int32Array(nt * 3);
  const slotFlat = new Uint8Array(nt * 3);
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
    // flat group: every face of it has the normal of its first face
    const first = new Int32Array(ids.size).fill(-1);
    const flat = new Uint8Array(ids.size).fill(1);
    for (let i = 0; i < n; i++) {
      const g = slotGroup[s0 + i]!, t = vTri[s0 + i]!;
      if (first[g]! < 0) {
        first[g] = t;
        continue;
      }
      const f = first[g]! * 3;
      if (un[f]! * un[t * 3]! + un[f + 1]! * un[t * 3 + 1]! + un[f + 2]! * un[t * 3 + 2]! < FLAT_COS) flat[g] = 0;
    }
    for (let i = 0; i < n; i++) slotFlat[s0 + i] = flat[slotGroup[s0 + i]!]!;
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
    nv, nt, pos, tris, vStart, vTri, slotGroup, slotFlat, cornerSlot, un, vGroups, maxGroups,
    hardEdges: Int32Array.from(hardEdges), hardDeg, hardNb,
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
  /** the core's offset of every vertex (the core is the vertex minus k times this), scaled space */
  d: Float64Array;
  dmax: number;
  /** how far each corner of each triangle is pushed out for the hull, per csr slot (only when asked for), scaled space */
  push: Float64Array | null;
  /** 1 at a vertex whose curved group reaches further than a ball is worth (the tip of a cone) */
  tip: Uint8Array;
}

/**
 * the scaled space geometry, the core offset of every vertex and (with `wantPush`) the hull push of every corner, for a
 * half width h. only curved groups move the core; flat groups only keep it from poking out through their faces.
 */
function computeOffsets(tp: Topology, sx: number, sy: number, sz: number, h: number, wantPush: boolean): Offsets {
  const { nv, nt, pos, tris, vStart, vTri, slotGroup, slotFlat, vGroups, maxGroups } = tp;
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
  const push = wantPush ? new Float64Array(nt * 9) : null;
  const tip = new Uint8Array(nv);
  const limit = 4 * h;
  const gn = new Float64Array(maxGroups * 3);
  const gu = new Float64Array(maxGroups * 3);
  const gmin = new Float64Array(maxGroups);
  const gq = new Float64Array(maxGroups);
  const gflat = new Uint8Array(maxGroups);
  // the curved groups of one vertex: normals and reaches
  const cn = new Float64Array(maxGroups * 3);
  const cq = new Float64Array(maxGroups);
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
      gflat[slotGroup[s]!] = slotFlat[s]!;
    }
    // normalize the group normals; a group with no direction is dropped
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
    }
    for (let s = s0; s < s1; s++) {
      const i = slotGroup[s]!, t = vTri[s]!;
      if (gmin[i] !== gmin[i]) continue;
      const dot = gn[i * 3]! * tnu[t * 3]! + gn[i * 3 + 1]! * tnu[t * 3 + 1]! + gn[i * 3 + 2]! * tnu[t * 3 + 2]!;
      if (dot < gmin[i]!) gmin[i] = dot;
    }
    // the reach of every valid group, the hull push of every corner, the curved groups for the core
    let c = 0;
    for (let i = 0; i < g; i++) {
      if (gmin[i] !== gmin[i]) continue;
      gq[i] = h / Math.max(gmin[i]!, 0.25);
      if (gflat[i]) continue;
      cn[c * 3] = gn[i * 3]!;
      cn[c * 3 + 1] = gn[i * 3 + 1]!;
      cn[c * 3 + 2] = gn[i * 3 + 2]!;
      cq[c] = gq[i]!;
      c++;
      if (gq[i]! > BALL_Q * h) tip[v] = 1;
    }
    if (push) {
      for (let s = s0; s < s1; s++) {
        const i = slotGroup[s]!;
        if (gmin[i] !== gmin[i]) continue;
        const r = gflat[i] ? h : Math.min(gq[i]!, PUSH_MAX * h);
        push[s * 3] = gn[i * 3]! * r;
        push[s * 3 + 1] = gn[i * 3 + 1]! * r;
        push[s * 3 + 2] = gn[i * 3 + 2]! * r;
      }
    }
    if (c === 0) continue;
    let dx = 0, dy = 0, dz = 0, ok = false;
    if (c === 1) {
      dx = cn[0]! * cq[0]!; dy = cn[1]! * cq[0]!; dz = cn[2]! * cq[0]!;
      ok = true;
    } else if (c === 2) {
      const cc = cn[0]! * cn[3]! + cn[1]! * cn[4]! + cn[2]! * cn[5]!;
      const det = 1 - cc * cc;
      if (det > 1e-4) {
        const a = (cq[0]! - cc * cq[1]!) / det, b = (cq[1]! - cc * cq[0]!) / det;
        dx = a * cn[0]! + b * cn[3]!; dy = a * cn[1]! + b * cn[4]!; dz = a * cn[2]! + b * cn[5]!;
        ok = true;
      }
    } else {
      // normal equations (for exactly three groups this is the plain 3x3 solve)
      let m00 = 0, m01 = 0, m02 = 0, m11 = 0, m12 = 0, m22 = 0, r0 = 0, r1 = 0, r2 = 0;
      for (let i = 0; i < c; i++) {
        const x = cn[i * 3]!, y = cn[i * 3 + 1]!, z = cn[i * 3 + 2]!, q = cq[i]!;
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
        ax += cn[i * 3]!; ay += cn[i * 3 + 1]!; az += cn[i * 3 + 2]!;
        if (cq[i]! > qm) qm = cq[i]!;
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
    }
    // the pull (-d) must not point out through a flat face of the vertex: take that part away
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < g; i++) {
        if (!gflat[i] || gmin[i] !== gmin[i]) continue;
        const dot = dx * gn[i * 3]! + dy * gn[i * 3 + 1]! + dz * gn[i * 3 + 2]!;
        if (dot < 0) {
          dx -= dot * gn[i * 3]!; dy -= dot * gn[i * 3 + 1]!; dz -= dot * gn[i * 3 + 2]!;
        }
      }
    }
    len = Math.hypot(dx, dy, dz);
    d[v * 3] = dx;
    d[v * 3 + 1] = dy;
    d[v * 3 + 2] = dz;
    if (len > dmax) dmax = len;
  }
  return { ps, tnu, d, dmax, push, tip };
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
  const { ps, d } = computeOffsets(tp, rx, ry, rz, 1, false);
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

/** the unit ball: an octahedron cut twice (8 -> 32 -> 128 triangles), 9 numbers per triangle, built on first use */
let ballCache: Float32Array | null = null;
const BALL_TRIS = 128;

function unitBall(): Float32Array {
  if (ballCache) return ballCache;
  let tris: number[][] = [];
  const ax = [[1, 0, 0], [-1, 0, 0]], ay = [[0, 1, 0], [0, -1, 0]], az = [[0, 0, 1], [0, 0, -1]];
  for (const x of ax) {
    for (const y of ay) {
      for (const z of az) {
        // wound outward when x * y * z is positive, else the other way: any winding is fine here
        tris.push([...x, ...y, ...z]);
      }
    }
  }
  const mid = (p: number[], i: number, j: number): number[] => {
    const m = [(p[i]! + p[j]!) / 2, (p[i + 1]! + p[j + 1]!) / 2, (p[i + 2]! + p[j + 2]!) / 2];
    const l = Math.hypot(m[0]!, m[1]!, m[2]!);
    return [m[0]! / l, m[1]! / l, m[2]! / l];
  };
  for (let pass = 0; pass < 2; pass++) {
    const next: number[][] = [];
    for (const p of tris) {
      const ab = mid(p, 0, 3), bc = mid(p, 3, 6), ca = mid(p, 6, 0);
      const a = p.slice(0, 3), b = p.slice(3, 6), c = p.slice(6, 9);
      next.push([...a, ...ab, ...ca], [...ab, ...b, ...bc], [...ca, ...bc, ...c], [...ab, ...bc, ...ca]);
    }
    tris = next;
  }
  const out = new Float32Array(BALL_TRIS * 9);
  for (let t = 0; t < tris.length; t++) for (let i = 0; i < 9; i++) out[t * 9 + i] = tris[t]![i]!;
  ballCache = out;
  return out;
}

/** the hull: pushed faces, tubes round the hard edges and balls on the vertices (see the header) */
function buildHull(tp: Topology, o: Offsets, sx: number, sy: number, sz: number, h: number): Float32Array {
  const { nv, nt, tris, cornerSlot, hardEdges, hardDeg, hardNb } = tp;
  const ps = o.ps, push = o.push!;

  // bends: the extra length of the two tubes there, -1 for a vertex that is not a bend
  const ext = new Float64Array(nv).fill(-1);
  const balls: number[] = [];
  for (let v = 0; v < nv; v++) {
    const deg = hardDeg[v]!;
    if (deg === 2) {
      const n1 = hardNb[v * 2]!, n2 = hardNb[v * 2 + 1]!;
      const e1x = sub(ps, n1, v, 0), e1y = sub(ps, n1, v, 1), e1z = sub(ps, n1, v, 2);
      const e2x = sub(ps, n2, v, 0), e2y = sub(ps, n2, v, 1), e2z = sub(ps, n2, v, 2);
      const l = Math.hypot(e1x, e1y, e1z) * Math.hypot(e2x, e2y, e2z);
      if (l > 1e-18) {
        // the line goes straight when the two edges point away from each other
        const cos = -(e1x * e2x + e1y * e2y + e1z * e2z) / l;
        if (cos >= BEND_COS) ext[v] = h * Math.tan(Math.acos(Math.min(1, cos)) / 2);
      }
    }
    if ((deg > 0 && ext[v]! < 0) || o.tip[v]) balls.push(v);
  }
  let tubes = 0;
  for (let i = 0; i < hardEdges.length; i += 2) {
    if (Math.hypot(sub(ps, hardEdges[i + 1]!, hardEdges[i]!, 0), sub(ps, hardEdges[i + 1]!, hardEdges[i]!, 1), sub(ps, hardEdges[i + 1]!, hardEdges[i]!, 2)) > 1e-12) tubes++;
  }

  const hull = new Float32Array((nt + tubes * TUBE_SIDES * 2 + balls.length * BALL_TRIS) * 9);
  let n = 0;
  const put = (x: number, y: number, z: number): void => {
    hull[n++] = x / sx;
    hull[n++] = y / sy;
    hull[n++] = z / sz;
  };

  // faces
  for (let t = 0; t < nt; t++) {
    for (let k = 0; k < 3; k++) {
      const v = tris[t * 3 + k]!, s = cornerSlot[t * 3 + k]! * 3;
      put(ps[v * 3]! + push[s]!, ps[v * 3 + 1]! + push[s + 1]!, ps[v * 3 + 2]! + push[s + 2]!);
    }
  }

  // tubes
  const ring = new Float64Array(TUBE_SIDES * 2);
  for (let k = 0; k < TUBE_SIDES; k++) {
    ring[k * 2] = Math.cos((k / TUBE_SIDES) * Math.PI * 2);
    ring[k * 2 + 1] = Math.sin((k / TUBE_SIDES) * Math.PI * 2);
  }
  for (let i = 0; i < hardEdges.length; i += 2) {
    const a = hardEdges[i]!, b = hardEdges[i + 1]!;
    let ux = sub(ps, b, a, 0), uy = sub(ps, b, a, 1), uz = sub(ps, b, a, 2);
    const len = Math.hypot(ux, uy, uz);
    if (!(len > 1e-12)) continue;
    ux /= len; uy /= len; uz /= len;
    const ea = Math.max(ext[a]!, 0), eb = Math.max(ext[b]!, 0);
    const a0x = ps[a * 3]! - ux * ea, a0y = ps[a * 3 + 1]! - uy * ea, a0z = ps[a * 3 + 2]! - uz * ea;
    const b0x = ps[b * 3]! + ux * eb, b0y = ps[b * 3 + 1]! + uy * eb, b0z = ps[b * 3 + 2]! + uz * eb;
    // two directions across the tube: u x (the axis it is least along)
    const ax = Math.abs(ux), ay = Math.abs(uy), az = Math.abs(uz);
    let hx = 0, hy = 0, hz = 0;
    if (ax <= ay && ax <= az) hx = 1;
    else if (ay <= az) hy = 1;
    else hz = 1;
    let px = uy * hz - uz * hy, py = uz * hx - ux * hz, pz = ux * hy - uy * hx;
    const pl = Math.hypot(px, py, pz);
    px = (px / pl) * h; py = (py / pl) * h; pz = (pz / pl) * h;
    const qx = uy * pz - uz * py, qy = uz * px - ux * pz, qz = ux * py - uy * px;
    const at = (k: number, end: number): void => {
      const c = ring[(k % TUBE_SIDES) * 2]!, s = ring[(k % TUBE_SIDES) * 2 + 1]!;
      const ox = px * c + qx * s, oy = py * c + qy * s, oz = pz * c + qz * s;
      if (end === 0) put(a0x + ox, a0y + oy, a0z + oz);
      else put(b0x + ox, b0y + oy, b0z + oz);
    };
    for (let k = 0; k < TUBE_SIDES; k++) {
      at(k, 0); at(k + 1, 0); at(k + 1, 1);
      at(k, 0); at(k + 1, 1); at(k, 1);
    }
  }

  // balls
  const ball = unitBall();
  for (const v of balls) {
    const cx = ps[v * 3]!, cy = ps[v * 3 + 1]!, cz = ps[v * 3 + 2]!;
    for (let i = 0; i < BALL_TRIS * 9; i += 3) put(cx + ball[i]! * h, cy + ball[i + 1]! * h, cz + ball[i + 2]! * h);
  }
  return hull;
}

function build(tp: Topology, shape: Shape3D, sx: number, sy: number, sz: number, width: number): SolidOutline {
  const h = width / 2;
  const o = computeOffsets(tp, sx, sy, sz, h, true);
  const { nv } = tp;
  // the core is pulled in by k * d: k keeps it from crossing the far side of a thin solid
  const m = Math.max(sx, sy, sz);
  const ratio = (s: number): number => Math.max(Math.round((s / m) * 1000) / 1000, MIN_SIZE);
  const T = thicknessOf(tp, shape, ratio(sx), ratio(sy), ratio(sz)) * m;
  const k = o.dmax > 0 && isFinite(T) ? Math.min(1, (0.45 * T) / o.dmax) : 1;
  const hull = buildHull(tp, o, sx, sy, sz, h);
  const core = new Float32Array(nv * 3);
  const s = [sx, sy, sz];
  for (let v = 0; v < nv; v++) {
    for (let a = 0; a < 3; a++) core[v * 3 + a] = (o.ps[v * 3 + a]! - o.d[v * 3 + a]! * k) / s[a]!;
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
