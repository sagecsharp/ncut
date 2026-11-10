import { describe, expect, it } from 'vitest';
import type { CameraClip, Project, TextClip, VideoClip } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import { createCameraClip, createProject, createTrack } from '../../lib/factory';
import {
  DEFAULT_CAMERA,
  DEFAULT_FOV,
  cameraAt,
  cameraClipAt,
  cameraFromClip,
  cameraRig,
  frustumCorners,
  homeDistance,
  projectPoint,
  rayPlane,
  screenRay,
  uses3dAt,
  type Camera3D,
} from './camera';
import { DEG, length, type Vec3 } from './math';

const SIZES: [number, number][] = [
  [1920, 1080],
  [1080, 1920],
  [1080, 1080],
  [1440, 1080],
];
const cam = (o: Partial<Camera3D> = {}): Camera3D => ({ ...DEFAULT_CAMERA, ...o });
const proj = (c: Camera3D, W: number, H: number, x: number, y: number, z: number) => projectPoint(cameraRig(c, W, H), x, y, z, W, H);
// float32 matrices: 1 decimal of a pixel is plenty
const near = (a: number, b: number, digits = 1) => expect(a).toBeCloseTo(b, digits);

describe('home camera', () => {
  it('default camera values', () => {
    expect(DEFAULT_CAMERA).toEqual({ x: 0, y: 0, z: 0, pan: 0, tilt: 0, roll: 0, fov: DEFAULT_FOV });
    expect(DEFAULT_FOV).toBe(50);
  });
  it('sits at the center of the canvas, looking at +z', () => {
    const rig = cameraRig(DEFAULT_CAMERA, 1920, 1080);
    near(rig.eye[0], 960);
    near(rig.eye[1], 540);
    expect(rig.eye[2]).toBeLessThan(0);
    near(rig.eye[2], -homeDistance(1080), 6);
    expect(rig.right).toEqual([1, 0, 0]);
    expect(rig.down).toEqual([0, 1, 0]);
    expect(rig.forward).toEqual([0, 0, 1]);
  });
  it('homeDistance makes the canvas height fill a 50 degree view', () => {
    for (const h of [540, 1080, 1920]) {
      expect(Math.tan((DEFAULT_FOV * DEG) / 2) * homeDistance(h)).toBeCloseTo(h / 2, 6);
    }
  });
  it('rig axes are unit length and orthogonal for any pose', () => {
    const rig = cameraRig(cam({ pan: 25, tilt: -15, roll: 40 }), 1920, 1080);
    for (const a of [rig.right, rig.down, rig.forward]) expect(length(a)).toBeCloseTo(1, 6);
    expect(rig.right[0] * rig.down[0] + rig.right[1] * rig.down[1] + rig.right[2] * rig.down[2]).toBeCloseTo(0, 6);
    expect(rig.right[0] * rig.forward[0] + rig.right[1] * rig.forward[1] + rig.right[2] * rig.forward[2]).toBeCloseTo(0, 6);
    expect(rig.down[0] * rig.forward[0] + rig.down[1] * rig.forward[1] + rig.down[2] * rig.forward[2]).toBeCloseTo(0, 6);
  });
  it('rig reports aspect and tanHalf', () => {
    const rig = cameraRig(DEFAULT_CAMERA, 1920, 1080);
    expect(rig.aspect).toBeCloseTo(16 / 9, 9);
    expect(rig.tanHalf).toBeCloseTo(Math.tan(25 * DEG), 9);
    expect(rig.near).toBeGreaterThan(0);
    expect(rig.far).toBeGreaterThan(rig.near);
  });
  it('maps canvas corners at z = 0 exactly onto the frame corners (flat 3d equals 2d)', () => {
    for (const [W, H] of SIZES) {
      const rig = cameraRig(DEFAULT_CAMERA, W, H);
      const corners: [number, number, number, number][] = [
        [0, 0, 0, 0],
        [W, 0, W, 0],
        [W, H, W, H],
        [0, H, 0, H],
      ];
      for (const [x, y, ex, ey] of corners) {
        const p = projectPoint(rig, x, y, 0, W, H);
        expect(p.visible, `${W}x${H}`).toBe(true);
        near(p.x, ex);
        near(p.y, ey);
      }
    }
  });
  it('maps every point of the canvas plane onto itself', () => {
    for (const [W, H] of SIZES) {
      const rig = cameraRig(DEFAULT_CAMERA, W, H);
      for (const [fx, fy] of [
        [0.5, 0.5],
        [0.25, 0.75],
        [0.9, 0.1],
        [0.1, 0.4],
      ] as const) {
        const p = projectPoint(rig, W * fx, H * fy, 0, W, H);
        near(p.x, W * fx);
        near(p.y, H * fy);
      }
    }
  });
  it('the center of the canvas stays at the center at any z', () => {
    for (const z of [-300, 0, 500, 5000]) {
      const p = proj(DEFAULT_CAMERA, 1920, 1080, 960, 540, z);
      near(p.x, 960);
      near(p.y, 540);
    }
  });
  it('depth of the canvas plane is the home distance', () => {
    const p = proj(DEFAULT_CAMERA, 1920, 1080, 100, 100, 0);
    expect(p.depth).toBeCloseTo(homeDistance(1080), 2);
  });
});

describe('perspective', () => {
  it('points with larger z project closer to the center', () => {
    for (const [W, H] of SIZES) {
      let prev = Infinity;
      for (const z of [0, 200, 500, 1500]) {
        const p = proj(DEFAULT_CAMERA, W, H, W, H, z);
        const d = Math.hypot(p.x - W / 2, p.y - H / 2);
        expect(d, `${W}x${H} z=${z}`).toBeLessThan(prev);
        prev = d;
      }
    }
  });
  it('points with negative z (toward the viewer) project farther from the center', () => {
    const a = proj(DEFAULT_CAMERA, 1920, 1080, 1920, 1080, 0);
    const b = proj(DEFAULT_CAMERA, 1920, 1080, 1920, 1080, -300);
    expect(Math.hypot(b.x - 960, b.y - 540)).toBeGreaterThan(Math.hypot(a.x - 960, a.y - 540));
  });
  it('size shrinks like d0 / (d0 + z)', () => {
    const W = 1920;
    const H = 1080;
    const d0 = homeDistance(H);
    const p = proj(DEFAULT_CAMERA, W, H, W, 540, d0); // twice the distance
    near(p.x, W / 2 + (W / 2) / 2);
  });
  it('depth grows with z', () => {
    const a = proj(DEFAULT_CAMERA, 1920, 1080, 0, 0, 0);
    const b = proj(DEFAULT_CAMERA, 1920, 1080, 0, 0, 400);
    expect(b.depth - a.depth).toBeCloseTo(400, 2);
  });
  it('is not visible behind the camera and at the eye plane', () => {
    const d0 = homeDistance(1080);
    expect(proj(DEFAULT_CAMERA, 1920, 1080, 960, 540, -d0 - 100).visible).toBe(false);
    expect(proj(DEFAULT_CAMERA, 1920, 1080, 960, 540, -d0).visible).toBe(false);
    expect(proj(DEFAULT_CAMERA, 1920, 1080, 960, 540, -d0 + 50).visible).toBe(true);
  });
  it('a camera moved forward past a plane no longer sees it', () => {
    const d0 = homeDistance(1080);
    const p = proj(cam({ z: d0 + 10 }), 1920, 1080, 960, 540, 0);
    expect(p.visible).toBe(false);
  });
});

describe('camera offsets move the picture the right way', () => {
  const W = 1920;
  const H = 1080;
  const c0 = proj(DEFAULT_CAMERA, W, H, W / 2 + 200, H / 2 + 100, 0);
  it('x + moves the camera right, the picture left', () => {
    const p = proj(cam({ x: 100 }), W, H, W / 2 + 200, H / 2 + 100, 0);
    expect(p.x).toBeLessThan(c0.x);
    near(p.x, c0.x - 100);
    near(p.y, c0.y);
  });
  it('y + moves the camera down, the picture up', () => {
    const p = proj(cam({ y: 100 }), W, H, W / 2 + 200, H / 2 + 100, 0);
    expect(p.y).toBeLessThan(c0.y);
    near(p.y, c0.y - 100);
    near(p.x, c0.x);
  });
  it('z + moves the camera forward: things get bigger', () => {
    const p = proj(cam({ z: 500 }), W, H, W / 2 + 200, H / 2 + 100, 0);
    expect(p.x - W / 2).toBeGreaterThan(c0.x - W / 2);
    expect(p.y - H / 2).toBeGreaterThan(c0.y - H / 2);
    expect(p.depth).toBeCloseTo(c0.depth - 500, 2);
  });
  it('z - moves it back: things get smaller', () => {
    const p = proj(cam({ z: -500 }), W, H, W / 2 + 200, H / 2 + 100, 0);
    expect(p.x - W / 2).toBeLessThan(c0.x - W / 2);
  });
  it('x and y offsets are in project pixels at the canvas plane', () => {
    const p = proj(cam({ x: -250, y: 75 }), W, H, W / 2, H / 2, 0);
    near(p.x, W / 2 + 250);
    near(p.y, H / 2 - 75);
  });
});

describe('camera rotation', () => {
  const W = 1920;
  const H = 1080;
  it('pan + looks right: the center of the scene moves LEFT on screen', () => {
    const p = proj(cam({ pan: 10 }), W, H, W / 2, H / 2, 0);
    expect(p.x).toBeLessThan(W / 2);
    near(p.y, H / 2);
  });
  it('pan - looks left: the center moves right', () => {
    expect(proj(cam({ pan: -10 }), W, H, W / 2, H / 2, 0).x).toBeGreaterThan(W / 2);
  });
  it('pan moves the picture more for a bigger angle', () => {
    expect(proj(cam({ pan: 20 }), W, H, W / 2, H / 2, 0).x).toBeLessThan(proj(cam({ pan: 10 }), W, H, W / 2, H / 2, 0).x);
  });
  it('pan forward axis turns toward +x', () => {
    const rig = cameraRig(cam({ pan: 30 }), W, H);
    expect(rig.forward[0]).toBeCloseTo(Math.sin(30 * DEG), 6);
    expect(rig.forward[2]).toBeCloseTo(Math.cos(30 * DEG), 6);
  });
  it('tilt + looks up: the center of the scene moves DOWN on screen', () => {
    const p = proj(cam({ tilt: 10 }), W, H, W / 2, H / 2, 0);
    expect(p.y).toBeGreaterThan(H / 2);
    near(p.x, W / 2);
  });
  it('tilt forward axis points up (negative y)', () => {
    expect(cameraRig(cam({ tilt: 20 }), W, H).forward[1]).toBeLessThan(0);
    expect(cameraRig(cam({ tilt: -20 }), W, H).forward[1]).toBeGreaterThan(0);
  });
  it('roll + turns the camera clockwise: a point right of center moves UP', () => {
    const p = proj(cam({ roll: 20 }), W, H, W / 2 + 300, H / 2, 0);
    expect(p.y).toBeLessThan(H / 2);
    // distance from the center is kept by a pure roll
    expect(Math.hypot(p.x - W / 2, p.y - H / 2)).toBeCloseTo(300, 0);
  });
  it('roll 180 mirrors the picture through the center', () => {
    const p = proj(cam({ roll: 180 }), W, H, W / 2 + 300, H / 2 + 100, 0);
    near(p.x, W / 2 - 300);
    near(p.y, H / 2 - 100);
  });
  it('the view axis of a pan 0 tilt 0 roll 360 camera is the home camera', () => {
    const p = proj(cam({ roll: 360 }), W, H, 100, 200, 0);
    near(p.x, 100);
    near(p.y, 200);
  });
  it('smaller fov zooms in', () => {
    const wide = proj(cam({ fov: 80 }), W, H, W, H, 0);
    const home = proj(cam({ fov: 50 }), W, H, W, H, 0);
    const tele = proj(cam({ fov: 25 }), W, H, W, H, 0);
    const d = (p: { x: number; y: number }) => Math.hypot(p.x - W / 2, p.y - H / 2);
    expect(d(tele)).toBeGreaterThan(d(home));
    expect(d(home)).toBeGreaterThan(d(wide));
  });
  it('a bigger fov shows more: the canvas corner moves inward', () => {
    const p = proj(cam({ fov: 100 }), W, H, W, H, 0);
    expect(p.x).toBeLessThan(W);
    expect(p.y).toBeLessThan(H);
  });
  it('fov is clamped to a sane range', () => {
    const rig0 = cameraRig(cam({ fov: 0 }), W, H);
    expect(rig0.tanHalf).toBeCloseTo(Math.tan(25 * DEG), 6); // 0 = falls back to the default
    expect(cameraRig(cam({ fov: 400 }), W, H).tanHalf).toBeCloseTo(Math.tan(85 * DEG), 6);
    expect(cameraRig(cam({ fov: 0.1 }), W, H).tanHalf).toBeCloseTo(Math.tan(0.5 * DEG), 6);
  });
});

describe('screenRay + rayPlane round trip', () => {
  const planeAt0: [Vec3, Vec3] = [[0, 0, 0], [0, 0, 1]];
  const poses: Camera3D[] = [
    DEFAULT_CAMERA,
    cam({ x: 120, y: -80, z: 200 }),
    cam({ pan: 15, tilt: -10 }),
    cam({ pan: -20, tilt: 12, roll: 8, fov: 70, x: 40, z: -100 }),
  ];
  for (const [W, H] of SIZES.slice(0, 3)) {
    it(`pixel -> ray -> z=0 plane -> pixel at ${W}x${H}`, () => {
      for (const c of poses) {
        const rig = cameraRig(c, W, H);
        for (const [px, py] of [
          [W / 2, H / 2],
          [0, 0],
          [W, H],
          [W * 0.2, H * 0.8],
          [W * 0.75, H * 0.3],
        ] as const) {
          const ray = screenRay(rig, px, py, W, H);
          const hit = rayPlane(ray.origin, ray.dir, planeAt0[0], planeAt0[1]);
          expect(hit, JSON.stringify(c)).not.toBeNull();
          expect(hit![2]).toBeCloseTo(0, 3);
          const back = projectPoint(rig, hit![0], hit![1], hit![2], W, H);
          near(back.x, px);
          near(back.y, py);
        }
      }
    });
  }
  it('the home camera hits the canvas corners with the frame corners', () => {
    const W = 1920;
    const H = 1080;
    const rig = cameraRig(DEFAULT_CAMERA, W, H);
    const hit = rayPlane(...Object.values(screenRay(rig, 0, 0, W, H)) as [Vec3, Vec3], [0, 0, 0], [0, 0, 1])!;
    near(hit[0], 0);
    near(hit[1], 0);
    const hit2 = rayPlane(...Object.values(screenRay(rig, W, H, W, H)) as [Vec3, Vec3], [0, 0, 0], [0, 0, 1])!;
    near(hit2[0], W);
    near(hit2[1], H);
  });
  it('the ray starts at the eye and has unit length', () => {
    const rig = cameraRig(cam({ pan: 10 }), 1920, 1080);
    const r = screenRay(rig, 100, 200, 1920, 1080);
    expect(r.origin).toBe(rig.eye);
    expect(length(r.dir)).toBeCloseTo(1, 9);
  });
  it('the center pixel looks along the forward axis', () => {
    const rig = cameraRig(cam({ pan: 33, tilt: 11, roll: 5 }), 1920, 1080);
    const r = screenRay(rig, 960, 540, 1920, 1080);
    for (let i = 0; i < 3; i++) expect(r.dir[i]).toBeCloseTo(rig.forward[i]!, 6);
  });
  it('rayPlane is null for a parallel ray', () => {
    expect(rayPlane([0, 0, -5], [1, 0, 0], [0, 0, 0], [0, 0, 1])).toBeNull();
  });
  it('rayPlane is null when the plane is behind the origin', () => {
    expect(rayPlane([0, 0, 5], [0, 0, 1], [0, 0, 0], [0, 0, 1])).toBeNull();
    expect(rayPlane([0, 0, 0], [0, 0, 1], [0, 0, 0], [0, 0, 1])).toBeNull();
  });
  it('rayPlane works with other planes and normals', () => {
    const hit = rayPlane([0, 0, 0], [0, 0, 1], [0, 0, 7], [0, 0, -1])!;
    expect(hit).toEqual([0, 0, 7]);
    const hit2 = rayPlane([0, 0, 0], [1, 0, 0], [3, 9, 9], [1, 0, 0])!;
    expect(hit2).toEqual([3, 0, 0]);
  });
});

describe('frustumCorners', () => {
  it('at the home distance the corners are the canvas corners', () => {
    for (const [W, H] of SIZES) {
      const rig = cameraRig(DEFAULT_CAMERA, W, H);
      const c = frustumCorners(rig, homeDistance(H));
      const want: Vec3[] = [
        [0, 0, 0],
        [W, 0, 0],
        [W, H, 0],
        [0, H, 0],
      ];
      for (let i = 0; i < 4; i++) for (let a = 0; a < 3; a++) expect(c[i]![a]).toBeCloseTo(want[i]![a]!, 3);
    }
  });
  it('corners scale with the distance and stay centered on the axis', () => {
    const rig = cameraRig(DEFAULT_CAMERA, 1920, 1080);
    const near2 = frustumCorners(rig, homeDistance(1080) * 2);
    // twice as far = twice as wide: width 3840
    expect(near2[1][0] - near2[0][0]).toBeCloseTo(3840, 2);
    expect(near2[2][1] - near2[1][1]).toBeCloseTo(2160, 2);
    expect(near2[0][2]).toBeCloseTo(homeDistance(1080), 2);
  });
  it('corner order is tl, tr, br, bl', () => {
    const c = frustumCorners(cameraRig(DEFAULT_CAMERA, 1920, 1080), 1000);
    expect(c[0][0]).toBeLessThan(c[1][0]);
    expect(c[0][1]).toBeLessThan(c[3][1]);
    expect(c[2][0]).toBeGreaterThan(c[3][0]);
    expect(c[2][1]).toBeGreaterThan(c[1][1]);
  });
  it('the corners project onto the frame corners for a moved camera too', () => {
    const W = 1920;
    const H = 1080;
    const rig = cameraRig(cam({ pan: 20, tilt: 10, roll: 5, x: 50 }), W, H);
    const c = frustumCorners(rig, 800);
    const want = [
      [0, 0],
      [W, 0],
      [W, H],
      [0, H],
    ];
    for (let i = 0; i < 4; i++) {
      const p = projectPoint(rig, c[i]![0], c[i]![1], c[i]![2], W, H);
      near(p.x, want[i]![0]!);
      near(p.y, want[i]![1]!);
    }
  });
});

/* ---------- camera clips in a project ---------- */

function twoTracks(): { p: Project; top: string; low: string } {
  const p = createProject('t');
  const low = p.tracks[0]!.id;
  const topTrack = createTrack('video', 'video 2');
  p.tracks = [topTrack, ...p.tracks];
  return { p, top: topTrack.id, low };
}
const cc = (trackId: string, start: number, duration: number, o: Partial<CameraClip> = {}) => createCameraClip(trackId, start, { duration, ...o });

describe('cameraClipAt / cameraAt', () => {
  it('no camera clip: null and the default camera', () => {
    const { p } = twoTracks();
    expect(cameraClipAt(p, 1)).toBeNull();
    expect(cameraAt(p, 1)).toBe(DEFAULT_CAMERA);
  });
  it('picks the clip covering the time (start inclusive, end exclusive)', () => {
    const { p, low } = twoTracks();
    const c = cc(low, 2, 3, { pan: 10 });
    p.clips = [c];
    expect(cameraClipAt(p, 1.9)).toBeNull();
    expect(cameraClipAt(p, 2)).toBe(c);
    expect(cameraClipAt(p, 4.99)).toBe(c);
    expect(cameraClipAt(p, 5)).toBeNull();
    expect(cameraAt(p, 3).pan).toBe(10);
    expect(cameraAt(p, 6)).toBe(DEFAULT_CAMERA);
  });
  it('the clip on the highest visible track wins', () => {
    const { p, top, low } = twoTracks();
    const a = cc(low, 0, 10, { pan: 1 });
    const b = cc(top, 0, 10, { pan: 2 });
    p.clips = [a, b];
    expect(cameraClipAt(p, 5)).toBe(b);
    expect(cameraAt(p, 5).pan).toBe(2);
  });
  it('the order of project.clips does not matter', () => {
    const { p, top, low } = twoTracks();
    const a = cc(low, 0, 10, { pan: 1 });
    const b = cc(top, 0, 10, { pan: 2 });
    p.clips = [b, a];
    expect(cameraClipAt(p, 5)).toBe(b);
  });
  it('ignores camera clips on hidden tracks', () => {
    const { p, top, low } = twoTracks();
    p.tracks = p.tracks.map((t) => (t.id === top ? { ...t, hidden: true } : t));
    const a = cc(low, 0, 10, { pan: 1 });
    const b = cc(top, 0, 10, { pan: 2 });
    p.clips = [a, b];
    expect(cameraClipAt(p, 5)).toBe(a);
  });
  it('falls back to a lower track when the top one has no clip at that time', () => {
    const { p, top, low } = twoTracks();
    const a = cc(low, 0, 10, { pan: 1 });
    const b = cc(top, 4, 2, { pan: 2 });
    p.clips = [a, b];
    expect(cameraClipAt(p, 1)).toBe(a);
    expect(cameraClipAt(p, 5)).toBe(b);
    expect(cameraClipAt(p, 7)).toBe(a);
  });
  it('ignores other clip types', () => {
    const { p, low } = twoTracks();
    const v: VideoClip = {
      id: 'v',
      type: 'video',
      trackId: low,
      start: 0,
      duration: 10,
      name: 'v',
      fadeIn: 0,
      fadeOut: 0,
      assetId: 'a',
      trimStart: 0,
      speed: 1,
      volume: 1,
      muted: false,
      transform: { ...DEFAULT_TRANSFORM },
      threeD: true,
    };
    p.clips = [v];
    expect(cameraClipAt(p, 1)).toBeNull();
  });
});

describe('cameraFromClip', () => {
  it('reads the static values', () => {
    const c = cc('t', 0, 5, { x: 1, y: 2, z: 3, pan: 4, tilt: 5, roll: 6, fov: 70 });
    expect(cameraFromClip(c, 1)).toEqual({ x: 1, y: 2, z: 3, pan: 4, tilt: 5, roll: 6, fov: 70 });
  });
  it('honours keyframes in clip-local time', () => {
    const c = cc('t', 10, 4, {
      keyframes: {
        pan: [
          { t: 0, v: 0, ease: 'linear' },
          { t: 4, v: 40, ease: 'linear' },
        ],
        fov: [{ t: 0, v: 90, ease: 'linear' }],
      },
    });
    expect(cameraFromClip(c, 10).pan).toBe(0);
    expect(cameraFromClip(c, 12).pan).toBeCloseTo(20, 9);
    expect(cameraFromClip(c, 14).pan).toBe(40);
    expect(cameraFromClip(c, 12).fov).toBe(90);
    expect(cameraFromClip(c, 12).tilt).toBe(0);
  });
  it('cameraAt applies keyframes through the project', () => {
    const { p, low } = twoTracks();
    p.clips = [
      cc(low, 2, 4, {
        keyframes: {
          z: [
            { t: 0, v: 0, ease: 'linear' },
            { t: 4, v: 400, ease: 'linear' },
          ],
        },
      }),
    ];
    expect(cameraAt(p, 4).z).toBeCloseTo(200, 9);
  });
});

describe('uses3dAt', () => {
  const text3d = (trackId: string, start: number, duration: number, threeD: boolean): TextClip => ({
    id: `t${start}${threeD}`,
    type: 'text',
    trackId,
    start,
    duration,
    name: 't',
    fadeIn: 0,
    fadeOut: 0,
    text: 'x',
    fontFamily: 'Kode Mono',
    fontSize: 50,
    fontWeight: 400,
    italic: false,
    color: '#fff',
    background: null,
    align: 'center',
    transform: { ...DEFAULT_TRANSFORM },
    threeD,
  });
  it('false for an empty project and for flat clips', () => {
    const { p, low } = twoTracks();
    expect(uses3dAt(p, 0)).toBe(false);
    p.clips = [text3d(low, 0, 5, false)];
    expect(uses3dAt(p, 1)).toBe(false);
  });
  it('true for a 3d clip while it is active only', () => {
    const { p, low } = twoTracks();
    p.clips = [text3d(low, 2, 3, true)];
    expect(uses3dAt(p, 1)).toBe(false);
    expect(uses3dAt(p, 2)).toBe(true);
    expect(uses3dAt(p, 4.9)).toBe(true);
    expect(uses3dAt(p, 5)).toBe(false);
  });
  it('true for a camera clip', () => {
    const { p, low } = twoTracks();
    p.clips = [cc(low, 0, 2)];
    expect(uses3dAt(p, 1)).toBe(true);
    expect(uses3dAt(p, 3)).toBe(false);
  });
});
