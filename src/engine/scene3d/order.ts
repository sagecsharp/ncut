/**
 * the order 3d planes are painted in: back to front, so see-through pixels (soft edges, shadows,
 * fades) blend over what is behind them.
 *
 * sorting by distance alone is wrong for the most common case: flat layers stacked in one plane
 * (a title over a video, both at z = 0). once the camera turns, the title's center can be farther
 * away than the video's center although the title is the upper layer. so pairs are compared by
 * geometry first:
 *   - in the same plane: the lower layer goes first (like 2d)
 *   - one wholly behind the other's plane (seen from the eye): the one behind goes first
 *   - cutting through each other: by view depth (the depth buffer sorts out the solid pixels)
 */
import type { Shape3D } from '../../types';
import type { Mat4, Vec3 } from './math';
import { mulInto } from './math';
import { knownShape } from './meshes';

export interface OrderItem {
  model: Mat4;
  shape?: Shape3D;
  /** a bent plane: its bounds in unit mesh space (bend.ts PlaneBend.box). null / missing = flat */
  bend?: { box: ArrayLike<number> } | null;
}

interface Info {
  index: number;
  /** distance along the view direction (clip space w of the center) */
  depth: number;
  flat: boolean;
  /** a bent plane: judged by its bent box, never the reference plane */
  bent: boolean;
  center: Vec3;
  normal: Vec3;
  /** the box corners (4 for a plane, 8 for a solid): the first `cornerCount` of the list are the live ones */
  corners: Vec3[];
  cornerCount: number;
  /** tolerance for "in the same plane", world units */
  eps: number;
}

/** the corners of the unit shapes, in the order the sides are tested in */
const FLAT_PTS: readonly Vec3[] = [
  [-0.5, -0.5, 0],
  [0.5, -0.5, 0],
  [0.5, 0.5, 0],
  [-0.5, 0.5, 0],
];
/** the corner signs of a bent plane's box: below the middle reads the min of the box, above it the max */
const BENT_PTS: readonly Vec3[] = [
  [-1, -1, -1],
  [1, -1, -1],
  [1, 1, -1],
  [-1, 1, -1],
  [-1, -1, 1],
  [1, -1, 1],
  [1, 1, 1],
  [-1, 1, 1],
];
const SOLID_PTS: readonly Vec3[] = [
  [-0.5, -0.5, -0.5],
  [0.5, -0.5, -0.5],
  [0.5, 0.5, -0.5],
  [-0.5, 0.5, -0.5],
  [-0.5, -0.5, 0.5],
  [0.5, -0.5, 0.5],
  [0.5, 0.5, 0.5],
  [-0.5, 0.5, 0.5],
];

/**
 * the Info records are reused from call to call (a 3d depth text has dozens of planes: one record with its center / normal /
 * corner arrays per plane per frame was most of the allocations of a frame). they are only read inside paintOrder, which
 * hands out plain indices: no caller ever holds one.
 */
const pool: Info[] = [];
const work: Info[] = [];
/** the view-projection x model product whose last column's w is the depth */
const product = new Float32Array(16);

function newInfo(): Info {
  const corners: Vec3[] = [];
  for (let i = 0; i < 8; i++) corners.push([0, 0, 0]);
  return { index: 0, depth: 0, flat: false, bent: false, center: [0, 0, 0], normal: [0, 0, 1], corners, cornerCount: 0, eps: 0.5 };
}

function info(item: OrderItem, index: number, viewProj: Mat4, out: Info): Info {
  const m = item.model;
  // transformPoint(m, 0, 0, 0): the same expressions, written into the record
  out.center[0] = m[0]! * 0 + m[4]! * 0 + m[8]! * 0 + m[12]!;
  out.center[1] = m[1]! * 0 + m[5]! * 0 + m[9]! * 0 + m[13]!;
  out.center[2] = m[2]! * 0 + m[6]! * 0 + m[10]! * 0 + m[14]!;
  // transformPoint(mul(viewProj, m), 0, 0, 0)[3]
  const p = mulInto(product, viewProj, m);
  let depth = p[3]! * 0 + p[7]! * 0 + p[11]! * 0 + p[15]!;
  // every solid (box, sphere, cylinder, cone, pyramid, torus) is judged by its unit box; unknown ids draw as a plane
  const plane = knownShape(item.shape) === 'plane';
  const bb = plane && item.bend ? item.bend.box : null;
  const flat = plane && !bb;
  const normal = out.normal;
  normal[0] = 0;
  normal[1] = 0;
  normal[2] = 1;
  let eps = 0.5;
  const pts = bb ? BENT_PTS : flat ? FLAT_PTS : SOLID_PTS;
  const corners = out.corners;
  for (let k = 0; k < pts.length; k++) {
    const q = pts[k]!;
    const c = corners[k]!;
    // a bent plane: the 8 corners of its bent box (x0 x1 y0 y1 z0 z1), else the unit corners
    const x = bb ? bb[q[0] > 0 ? 1 : 0]! : q[0];
    const y = bb ? bb[q[1] > 0 ? 3 : 2]! : q[1];
    const z = bb ? bb[q[2] > 0 ? 5 : 4]! : q[2];
    c[0] = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
    c[1] = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
    c[2] = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
  }
  if (flat) {
    const a = corners[0]!;
    const b = corners[1]!;
    const d = corners[3]!;
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = d[0] - a[0];
    const vy = d[1] - a[1];
    const vz = d[2] - a[2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len > 1e-9) {
      normal[0] = nx / len;
      normal[1] = ny / len;
      normal[2] = nz / len;
    }
    // a thousandth of the plane's size, never less than a hundredth of a pixel
    eps = Math.max(0.01, Math.max(Math.hypot(ux, uy, uz), Math.hypot(vx, vy, vz)) * 1e-3);
  }
  if (bb) {
    // the middle of the bent box: the center and the depth of a bent plane
    const mx = (bb[0]! + bb[1]!) / 2;
    const my = (bb[2]! + bb[3]!) / 2;
    const mz = (bb[4]! + bb[5]!) / 2;
    out.center[0] = m[0]! * mx + m[4]! * my + m[8]! * mz + m[12]!;
    out.center[1] = m[1]! * mx + m[5]! * my + m[9]! * mz + m[13]!;
    out.center[2] = m[2]! * mx + m[6]! * my + m[10]! * mz + m[14]!;
    depth = p[3]! * mx + p[7]! * my + p[11]! * mz + p[15]!;
    eps = Math.max(0.01, Math.max(Math.hypot(m[0]!, m[1]!, m[2]!), Math.hypot(m[4]!, m[5]!, m[6]!)) * 1e-3);
  }
  out.index = index;
  out.depth = depth;
  out.flat = flat;
  out.bent = !!bb;
  out.cornerCount = pts.length;
  out.eps = eps;
  return out;
}

/**
 * where `other` lies relative to the plane of `ref`, seen from the eye:
 * 0 = in the same plane, 1 = wholly in front (nearer the eye), -1 = wholly behind, null = across it.
 */
function side(ref: Info, other: Info, eye: Vec3): 0 | 1 | -1 | null {
  const n = ref.normal;
  const c = ref.center;
  const eyeSide = (eye[0] - c[0]) * n[0] + (eye[1] - c[1]) * n[1] + (eye[2] - c[2]) * n[2];
  const eps = Math.max(ref.eps, other.eps);
  let front = 0;
  let back = 0;
  for (let k = 0; k < other.cornerCount; k++) {
    const p = other.corners[k]!;
    const s = (p[0] - c[0]) * n[0] + (p[1] - c[1]) * n[1] + (p[2] - c[2]) * n[2];
    if (Math.abs(s) <= eps) continue;
    if (s > 0 === eyeSide > 0) front++;
    else back++;
  }
  if (front === 0 && back === 0) return 0;
  // an eye that sits in the plane cannot tell front from back
  if (Math.abs(eyeSide) <= eps) return null;
  if (back === 0) return 1;
  if (front === 0) return -1;
  return null;
}

/** negative = a is painted before b */
function compare(a: Info, b: Info, eye: Vec3): number {
  if (a.flat) {
    const s = side(a, b, eye);
    if (s === 0 && (b.flat || b.bent)) return a.index - b.index;
    if (s === 1) return -1;
    if (s === -1) return 1;
  }
  if (b.flat) {
    const s = side(b, a, eye);
    // a bent card in the plane of a flat one keeps layer order, whichever way round they are compared
    if (s === 0 && a.bent) return a.index - b.index;
    if (s === 1) return 1;
    if (s === -1) return -1;
  }
  // far first
  const d = b.depth - a.depth;
  return Math.abs(d) > 1e-6 ? d : a.index - b.index;
}

/**
 * indices of `items` in painting order (first = painted first = farthest back).
 * `items` are in layer order: a higher index is a higher layer.
 */
export function paintOrder(items: OrderItem[], viewProj: Mat4, eye: Vec3): number[] {
  const infos = work;
  infos.length = items.length;
  for (let i = 0; i < items.length; i++) infos[i] = info(items[i]!, i, viewProj, (pool[i] ??= newInfo()));
  // start far to near, then settle pairs by geometry. the pair rule is not always transitive
  // (three planes can overlap in a ring), so this is an insertion sort: stable and always ends.
  infos.sort((a, b) => b.depth - a.depth || a.index - b.index);
  for (let i = 1; i < infos.length; i++) {
    const cur = infos[i]!;
    let j = i - 1;
    while (j >= 0 && compare(infos[j]!, cur, eye) > 0) {
      infos[j + 1] = infos[j]!;
      j--;
    }
    infos[j + 1] = cur;
  }
  return infos.map((x) => x.index);
}
