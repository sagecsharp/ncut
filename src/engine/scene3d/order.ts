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
import { mul, transformPoint } from './math';

export interface OrderItem {
  model: Mat4;
  shape?: Shape3D;
}

interface Info {
  index: number;
  /** distance along the view direction (clip space w of the center) */
  depth: number;
  flat: boolean;
  center: Vec3;
  normal: Vec3;
  corners: Vec3[];
  /** tolerance for "in the same plane", world units */
  eps: number;
}

function info(item: OrderItem, index: number, viewProj: Mat4): Info {
  const m = item.model;
  const c = transformPoint(m, 0, 0, 0);
  const center: Vec3 = [c[0], c[1], c[2]];
  const depth = transformPoint(mul(viewProj, m), 0, 0, 0)[3];
  const flat = (item.shape ?? 'plane') === 'plane';
  const corners: Vec3[] = [];
  let normal: Vec3 = [0, 0, 1];
  let eps = 0.5;
  const pts = flat
    ? [
        [-0.5, -0.5, 0],
        [0.5, -0.5, 0],
        [0.5, 0.5, 0],
        [-0.5, 0.5, 0],
      ]
    : [
        [-0.5, -0.5, -0.5],
        [0.5, -0.5, -0.5],
        [0.5, 0.5, -0.5],
        [-0.5, 0.5, -0.5],
        [-0.5, -0.5, 0.5],
        [0.5, -0.5, 0.5],
        [0.5, 0.5, 0.5],
        [-0.5, 0.5, 0.5],
      ];
  for (const p of pts) {
    const w = transformPoint(m, p[0]!, p[1]!, p[2]!);
    corners.push([w[0], w[1], w[2]]);
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
    if (len > 1e-9) normal = [nx / len, ny / len, nz / len];
    // a thousandth of the plane's size, never less than a hundredth of a pixel
    eps = Math.max(0.01, Math.max(Math.hypot(ux, uy, uz), Math.hypot(vx, vy, vz)) * 1e-3);
  }
  return { index, depth, flat, center, normal, corners, eps };
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
  for (const p of other.corners) {
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
    if (s === 0 && b.flat) return a.index - b.index;
    if (s === 1) return -1;
    if (s === -1) return 1;
  }
  if (b.flat) {
    const s = side(b, a, eye);
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
  const infos = items.map((it, i) => info(it, i, viewProj));
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
