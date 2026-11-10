import { describe, expect, it } from 'vitest';
import type { Shape3D } from '../../types';
import { DEFAULT_CAMERA, cameraRig } from './camera';
import { DEG, type Mat4, type Vec3, mul, mulInto, rotationX, rotationY, scaling, transformPoint, translation } from './math';
import { knownShape } from './meshes';
import { paintOrder } from './order';

/*
 * paintOrder as it was before its records were reused (one record, one corner list per plane per call), kept here to
 * check that the reused records give the very same order, and mulInto against mul.
 */
interface OrderItem {
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
  // every solid (box, sphere, cylinder, cone, pyramid, torus) is judged by its unit box; unknown ids draw as a plane
  const flat = knownShape(item.shape) === 'plane';
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
function legacyPaintOrder(items: OrderItem[], viewProj: Mat4, eye: Vec3): number[] {
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

const SHAPES: (Shape3D | undefined)[] = ['plane', 'plane', 'plane', 'box', 'sphere', 'cylinder', undefined];

let seed = 424242;
const rnd = (): number => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);

function randomItems(n: number): { model: Mat4; shape?: Shape3D }[] {
  const out: { model: Mat4; shape?: Shape3D }[] = [];
  for (let i = 0; i < n; i++) {
    // several planes share a depth (flat layers), some turn, some are solids
    const z = rnd() < 0.5 ? 0 : (rnd() - 0.5) * 800;
    let m = translation(960 + (rnd() - 0.5) * 1600, 540 + (rnd() - 0.5) * 900, z);
    if (rnd() < 0.5) m = mul(m, rotationY((rnd() - 0.5) * 120 * DEG));
    if (rnd() < 0.3) m = mul(m, rotationX((rnd() - 0.5) * 120 * DEG));
    m = mul(m, scaling(50 + rnd() * 1500, 50 + rnd() * 900, 1 + rnd() * 400));
    out.push({ model: m, shape: SHAPES[Math.floor(rnd() * SHAPES.length)] });
  }
  return out;
}

describe('paintOrder with reused records', () => {
  it('gives the order the old implementation gave, for random scenes, camera moves and scene sizes (the pool grows and shrinks)', () => {
    for (let n = 0; n < 400; n++) {
      const rig = cameraRig({ ...DEFAULT_CAMERA, pan: (rnd() - 0.5) * 80, tilt: (rnd() - 0.5) * 40, x: (rnd() - 0.5) * 600, z: (rnd() - 0.5) * 300 }, 1920, 1080);
      // sizes jump around: the pool has to cope with a smaller scene after a bigger one
      const count = [1, 2, 3, 7, 25, 60, 2, 12][n % 8]!;
      const items = randomItems(count);
      expect(paintOrder(items, rig.viewProj, rig.eye)).toEqual(legacyPaintOrder(items, rig.viewProj, rig.eye));
    }
  });
  it('an empty scene, and the same scene twice in a row', () => {
    const rig = cameraRig(DEFAULT_CAMERA, 1920, 1080);
    expect(paintOrder([], rig.viewProj, rig.eye)).toEqual([]);
    const items = randomItems(9);
    const a = paintOrder(items, rig.viewProj, rig.eye);
    expect(paintOrder(items, rig.viewProj, rig.eye)).toEqual(a);
    // the result is a list of its own, not a view into the reused records
    a.push(99);
    expect(paintOrder(items, rig.viewProj, rig.eye)).toHaveLength(9);
  });
  it('knows a shape the same way as before', () => {
    expect(knownShape(undefined)).toBe('plane');
  });
});

describe('mulInto', () => {
  it('writes exactly the numbers mul gives, also when the target held something else', () => {
    const target = new Float32Array(16).fill(7);
    for (let n = 0; n < 200; n++) {
      const a = new Float32Array(16).map(() => (rnd() - 0.5) * 1000);
      const b = new Float32Array(16).map(() => (rnd() - 0.5) * 1000);
      const want = mul(a, b);
      const got = mulInto(target, a, b);
      expect(got).toBe(target);
      expect(Array.from(got)).toEqual(Array.from(want));
    }
  });
  it('transformPoint of the product is what the depth is read from', () => {
    const a = translation(1, 2, 3);
    const b = scaling(2, 3, 4);
    const t = new Float32Array(16);
    mulInto(t, a, b);
    const p = transformPoint(mul(a, b), 0, 0, 0);
    expect(t[3]! * 0 + t[7]! * 0 + t[11]! * 0 + t[15]!).toBe(p[3]);
  });
});
