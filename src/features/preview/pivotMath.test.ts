import { describe, expect, it } from 'vitest';
import { getClipBox } from '../../engine/draw';
import { PIVOT_SPOTS, pictureBox } from '../../engine/pivot';
import { cameraAt, cameraRig } from '../../engine/scene3d/camera';
import type { Vec3 } from '../../engine/scene3d/math';
import { clipModelMatrix, planeCorners } from '../../engine/scene3d/model';
import { createProject, createShapeClip } from '../../lib/factory';
import type { Project, ShapeClip, Transform } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import { type PivotSnap, clipSpots, fractionOnPlane, nearestSnap, pivotFollow, pivotSnaps } from './pivotMath';
import { edgeResize } from './overlayMath';

const tf = (o: Partial<Transform> = {}): Transform => ({ ...DEFAULT_TRANSFORM, ...o });

function setup(o: Partial<ShapeClip>): { p: Project; clip: ShapeClip; eye: Vec3 } {
  const p = createProject();
  const clip = { ...createShapeClip(p.tracks[0]!.id, 0, { duration: 10, width: 200, height: 100 }), id: 'a', ...o };
  p.clips = [clip];
  return { p, clip, eye: cameraRig(cameraAt(p, 1), p.width, p.height).eye };
}

describe('clipSpots', () => {
  it('clipSpots of a 2d clip are the corners and edge middles of its picture box, its pivot is the position', () => {
    const { p, clip, eye } = setup({ pivot: { x: -0.5, y: 0 }, transform: tf({ x: 100, y: 50 }) });
    const cx = p.width / 2 + 100;
    const cy = p.height / 2 + 50;
    const s = clipSpots(p, clip, 1, eye);
    expect(s.pivot).toEqual([cx, cy, 0]);
    // the picture runs from the pivot to the right
    expect(s.spots).toHaveLength(9);
    PIVOT_SPOTS.forEach((sp, i) => {
      expect(s.spots[i]![0]).toBeCloseTo(cx + 100 + sp.x * 200, 9);
      expect(s.spots[i]![1]).toBeCloseTo(cy + sp.y * 100, 9);
      expect(s.spots[i]![2]).toBe(0);
    });
    // turned a quarter: the picture hangs off the pivot along the turned axis
    const r = setup({ pivot: { x: -0.5, y: 0 }, transform: tf({ rotation: 90 }) });
    const m = clipSpots(r.p, r.clip, 1, r.eye);
    expect(m.spots[4]![0]).toBeCloseTo(r.p.width / 2, 6);
    expect(m.spots[4]![1]).toBeCloseTo(r.p.height / 2 + 100, 6);
    // no pivot: the position is the middle
    const n = setup({});
    const np = clipSpots(n.p, n.clip, 1, n.eye);
    expect(np.pivot).toEqual(np.spots[4]);
  });

  it("clipSpots of a 3d clip are the model's points", () => {
    const { p, clip, eye } = setup({ threeD: true, pivot: { x: 0.5, y: -0.25 }, transform: tf({ x: 30, y: -20, z: 120, rotX: 25, rotY: -35, rotation: 15 }) });
    const box = getClipBox(p, clip);
    const model = clipModelMatrix(box, clip.transform, undefined, eye);
    const c = planeCorners(model);
    const s = clipSpots(p, clip, 1, eye);
    [0, 2, 8, 6].forEach((idx, k) => {
      for (let i = 0; i < 3; i++) expect(s.spots[idx]![i]).toBeCloseTo(c[k]![i]!, 3);
    });
    // the position is the frame's translation
    expect(s.pivot[0]).toBeCloseTo(p.width / 2 + 30, 3);
    expect(s.pivot[1]).toBeCloseTo(p.height / 2 - 20, 3);
    expect(s.pivot[2]).toBeCloseTo(120, 3);
  });
});

describe('fractionOnPlane', () => {
  it('fractionOnPlane gives exact spot fractions for rays through the spots', () => {
    const flat = setup({ pivot: { x: 0.3, y: -0.2 }, transform: tf({ rotation: 20, x: 40 }) });
    const fs = clipSpots(flat.p, flat.clip, 1, flat.eye).spots;
    PIVOT_SPOTS.forEach((sp, i) => {
      const f = fractionOnPlane(fs, [fs[i]![0], fs[i]![1], -1], [0, 0, 1])!;
      expect(f[0]).toBeCloseTo(sp.x, 9);
      expect(f[1]).toBeCloseTo(sp.y, 9);
    });
    const tilt = setup({ threeD: true, pivot: { x: -0.5, y: 0.5 }, transform: tf({ rotX: 30, rotY: 40, z: 200 }) });
    const ts = clipSpots(tilt.p, tilt.clip, 1, tilt.eye).spots;
    PIVOT_SPOTS.forEach((sp, i) => {
      const d: Vec3 = [ts[i]![0] - tilt.eye[0], ts[i]![1] - tilt.eye[1], ts[i]![2] - tilt.eye[2]];
      const f = fractionOnPlane(ts, tilt.eye, d)!;
      expect(f[0]).toBeCloseTo(sp.x, 6);
      expect(f[1]).toBeCloseTo(sp.y, 6);
    });
    // a point between the middle and the right edge
    const mid: Vec3 = [(fs[4]![0] + fs[5]![0]) / 2, (fs[4]![1] + fs[5]![1]) / 2, 0];
    const h = fractionOnPlane(fs, [mid[0], mid[1], -1], [0, 0, 1])!;
    expect(h[0]).toBeCloseTo(0.25, 9);
    expect(h[1]).toBeCloseTo(0, 9);
  });

  it('fractionOnPlane is null for a plane seen edge on', () => {
    const { p, clip, eye } = setup({ threeD: true, transform: tf({ rotY: 90 }) });
    const s = clipSpots(p, clip, 1, eye).spots;
    expect(fractionOnPlane(s, [s[4]![0], s[4]![1], -1], [0, 0, 1])).toBeNull();
  });
});

describe('nearestSnap', () => {
  it('nearestSnap picks the nearest inside the radius and nothing outside', () => {
    const snaps: PivotSnap[] = [
      { x: 10, y: 10, label: 'a' },
      { x: 14, y: 10, label: 'b' },
      { x: 100, y: 100, label: 'c' },
    ];
    expect(nearestSnap(snaps, 13, 10, 8)?.label).toBe('b');
    expect(nearestSnap(snaps, 11, 10, 8)?.label).toBe('a');
    expect(nearestSnap(snaps, 50, 50, 8)).toBeNull();
    expect(nearestSnap(snaps, 100, 108, 8)?.label).toBe('c');
    expect(nearestSnap(snaps, 100, 109, 8)).toBeNull();
    expect(nearestSnap([], 0, 0, 8)).toBeNull();
  });
});

describe('pivotSnaps', () => {
  const flat = (p: Vec3) => ({ x: p[0], y: p[1], ok: true });

  it('pivotSnaps labels: own spots, pivot of and middle of other clips, at most 16 other clips', () => {
    const p = createProject();
    const track = p.tracks[0]!.id;
    const mk = (id: string, name: string, o: Partial<ShapeClip> = {}): ShapeClip => ({ ...createShapeClip(track, 0, { duration: 10, width: 100, height: 100 }), id, name, ...o });
    const a = mk('a', 'a');
    const b = mk('b', 'box', { transform: tf({ x: 300 }) });
    const c = mk('c', 'arm', { pivot: { x: -0.5, y: 0 }, transform: tf({ x: -300 }) });
    p.clips = [a, b, c];
    const eye = cameraRig(cameraAt(p, 1), p.width, p.height).eye;
    const snaps = pivotSnaps(p, a, 1, eye, flat);
    const own = snaps.filter((s) => s.spot);
    expect(own.map((s) => s.label)).toEqual(PIVOT_SPOTS.map((sp) => sp.label));
    expect(own[0]!.spot).toEqual([-0.5, -0.5]);
    // a clip without a pivot: its position is its middle, said once
    const labels = snaps.map((s) => s.label);
    expect(labels.filter((l) => l === 'middle of box')).toHaveLength(1);
    expect(labels).not.toContain('pivot of box');
    expect(labels).toContain('top left of box');
    expect(labels).toContain('bottom right of arm');
    // a clip with a pivot: its position and its middle
    expect(labels).toContain('pivot of arm');
    expect(labels).toContain('middle of arm');
    const arm = snaps.find((s) => s.label === 'pivot of arm')!;
    expect(arm.x).toBeCloseTo(p.width / 2 - 300, 6);
    expect(arm.spot).toBeUndefined();
    expect(snaps).toHaveLength(9 + 9 + 10);
    // a point behind the camera is left out
    const some = pivotSnaps(p, a, 1, eye, (q) => ({ x: q[0], y: q[1], ok: q[0] < p.width / 2 + 100 }));
    expect(some.some((s) => s.label.endsWith('of box'))).toBe(false);
    // a clip without a name says its type
    const named = pivotSnaps({ ...p, clips: [a, mk('d', '')] }, a, 1, eye, flat);
    expect(named.some((s) => s.label === 'middle of shape')).toBe(true);
    // at most 16 other clips, the nearest ones
    const many = Array.from({ length: 20 }, (_, i) => mk(`m${i}`, `m${i}`, { transform: tf({ x: 20 * (i + 1) }) }));
    const big = { ...p, clips: [a, ...many] };
    const bs = pivotSnaps(big, a, 1, eye, flat);
    const names = new Set(bs.filter((s) => !s.spot).map((s) => s.label.split(' of ')[1]));
    expect(names.size).toBe(16);
    expect(names.has('m0')).toBe(true);
    expect(names.has('m15')).toBe(true);
    expect(names.has('m16')).toBe(false);
    expect(bs).toHaveLength(9 + 16 * 9);
  });
});

describe('pivotFollow', () => {
  it('pivotFollow keeps the opposite edge of a rotated pivoted box', () => {
    const { p, clip } = setup({ pivot: { x: 0.3, y: -0.2 }, transform: tf({ rotation: 30, x: 40, y: -15 }) });
    const box = getClipBox(p, clip);
    const pic = pictureBox(box);
    const start = { cx: pic.cx, cy: pic.cy, rotation: box.rotation, bw: box.width, bh: box.height, scale: clip.transform.scale };
    const rad = (30 * Math.PI) / 180;
    const farMid = (b: { cx: number; cy: number; width: number }, sign: number): [number, number] => [b.cx + sign * (b.width / 2) * Math.cos(rad), b.cy + sign * (b.width / 2) * Math.sin(rad)];
    for (const edge of ['r', 'l'] as const) {
      const r = edgeResize(start, edge, pic.cx + 120, pic.cy + 70, 4);
      const w1 = r.width! * clip.transform.scale;
      const d = pivotFollow(box.rotation, 0.3, -0.2, box.width, box.height, w1, box.height, r.dx, r.dy);
      const moved: ShapeClip = { ...clip, width: r.width!, transform: { ...clip.transform, x: clip.transform.x + d.dx, y: clip.transform.y + d.dy } };
      const nb = getClipBox(p, moved);
      const npic = pictureBox(nb);
      // the far edge is the opposite one: left when the right edge is dragged
      const sign = edge === 'r' ? -1 : 1;
      const before = farMid(pic, sign);
      const after = farMid(npic, sign);
      expect(after[0]).toBeCloseTo(before[0], 6);
      expect(after[1]).toBeCloseTo(before[1], 6);
      expect(npic.width).toBeCloseTo(w1, 6);
    }
    // a height change: the top edge stays when the bottom edge is dragged
    const rb = edgeResize(start, 'b', pic.cx, pic.cy + 90, 4);
    const h1 = rb.height! * clip.transform.scale;
    const db = pivotFollow(box.rotation, 0.3, -0.2, box.width, box.height, box.width, h1, rb.dx, rb.dy);
    const nb = pictureBox(getClipBox(p, { ...clip, height: rb.height!, transform: { ...clip.transform, x: clip.transform.x + db.dx, y: clip.transform.y + db.dy } }));
    const top = (b: { cx: number; cy: number; height: number }): [number, number] => [b.cx + (b.height / 2) * Math.sin(rad), b.cy - (b.height / 2) * Math.cos(rad)];
    expect(top(nb)[0]).toBeCloseTo(top(pic)[0], 6);
    expect(top(nb)[1]).toBeCloseTo(top(pic)[1], 6);
    // without a pivot the numbers are the edge's own
    const none = pivotFollow(30, 0, 0, 200, 100, 260, 100, 12, -3);
    expect(none).toEqual({ dx: 12, dy: -3 });
  });
});
