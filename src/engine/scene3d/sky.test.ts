import { describe, expect, it } from 'vitest';
import { createProject } from '../../lib/factory';
import type { MediaAsset, SceneSky } from '../../types';
import { DEFAULT_CAMERA, cameraRig } from './camera';
import {
  SKY_BLUR_LEVELS,
  SKY_FACE_MAX,
  SKY_LAYOUTS,
  type SkyPicture,
  cubeFace,
  faceDirection,
  guessFaces,
  isPanorama,
  layoutOf,
  nameTokens,
  remapSky,
  skyAssetIds,
  skyBlur,
  skyBrightness,
  skyCandidates,
  skyChannelCap,
  skyDirAt,
  skyDrawFor,
  skyFaceSize,
  skyKey,
  skyRay,
  skySideOf,
  skyStemOf,
  skyTurn,
  skyUsable,
  skyUses,
  turnSample,
  turnedSource,
  validSky,
  withSkyValues,
  wrapDeg,
} from './sky';

const img = (id: string, name: string, w: number, h: number): MediaAsset => ({ id, name, kind: 'image', mime: 'image/png', size: 1, duration: 0, width: w, height: h, hasAudio: false, createdAt: 0 });
const vid = (id: string, name: string, w: number, h: number): MediaAsset => ({ ...img(id, name, w, h), kind: 'video', mime: 'video/mp4' });
const light = { sky: '#8090a0', horizon: '#808080', ground: '#404040', sun: 0, sunColor: '#fff4e0', sunTurn: -35, sunHeight: 45 };
const skyOf = (over: Partial<SceneSky> = {}): SceneSky => ({ asset: 'a1', turn: 0, brightness: 1, blur: 0, light, ...over });
const home = () => cameraRig(DEFAULT_CAMERA, 1920, 1080);

describe('layoutOf', () => {
  it('tells the four shapes and nothing else', () => {
    expect(layoutOf(1024, 768)).toBe('cross');
    expect(layoutOf(768, 1024)).toBe('tallcross');
    expect(layoutOf(6144, 1024)).toBe('strip');
    expect(layoutOf(1024, 6144)).toBe('column');
    expect(layoutOf(2048, 1024)).toBeNull();
    expect(layoutOf(1025, 768)).toBe('cross');
    expect(layoutOf(0, 0)).toBeNull();
  });
});

describe('isPanorama', () => {
  it('is true for 2:1 only', () => {
    expect(isPanorama(2048, 1024)).toBe(true);
    expect(isPanorama(2040, 1024)).toBe(true);
    expect(isPanorama(1024, 768)).toBe(false);
    expect(isPanorama(1024, 1024)).toBe(false);
    expect(isPanorama(0, 0)).toBe(false);
  });
});

describe('the layout cells', () => {
  it('are inside their grid and all different', () => {
    for (const l of Object.values(SKY_LAYOUTS)) {
      expect(l.cells.length).toBe(6);
      expect(l.turns.length).toBe(6);
      const seen = new Set<string>();
      for (const [c, r] of l.cells) {
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThan(l.cols);
        expect(r).toBeGreaterThanOrEqual(0);
        expect(r).toBeLessThan(l.rows);
        seen.add(`${c},${r}`);
      }
      expect(seen.size).toBe(6);
    }
  });
});

describe('cube math', () => {
  it('the sides next to each other in the picture meet at their edges', () => {
    const n = 16;
    for (const name of ['cross', 'tallcross'] as const) {
      const l = SKY_LAYOUTS[name];
      // direction at each pixel of each cell, through the turn of the cell
      const dirs = new Map<string, number[]>();
      for (let side = 0; side < 6; side++) {
        const [cc, cr] = l.cells[side]!;
        for (let y = 0; y < n; y++) {
          for (let x = 0; x < n; x++) {
            const [sx, sy] = turnedSource(n, l.turns[side]!, x, y);
            const d = faceDirection(side, (x + 0.5) / n, (y + 0.5) / n);
            const len = Math.hypot(d[0], d[1], d[2]);
            dirs.set(`${cc * n + sx},${cr * n + sy}`, [d[0] / len, d[1] / len, d[2] / len]);
          }
        }
      }
      const near = (a: string, b: string) => {
        const p = dirs.get(a)!;
        const q = dirs.get(b)!;
        expect(Math.hypot(p[0]! - q[0]!, p[1]! - q[1]!, p[2]! - q[2]!), `${name} ${a} ${b}`).toBeLessThan(0.3);
      };
      let seams = 0;
      for (const [c, r] of l.cells) {
        const right = l.cells.some(([c2, r2]) => c2 === c + 1 && r2 === r);
        const below = l.cells.some(([c2, r2]) => c2 === c && r2 === r + 1);
        for (let i = 0; i < n; i++) {
          if (right) near(`${c * n + n - 1},${r * n + i}`, `${(c + 1) * n},${r * n + i}`);
          if (below) near(`${c * n + i},${r * n + n - 1}`, `${c * n + i},${(r + 1) * n}`);
        }
        if (right) seams++;
        if (below) seams++;
      }
      expect(seams).toBe(5);
    }
  });

  it('every way of looking keeps the picture upright and not mirrored', () => {
    const h = home();
    type V = [number, number, number];
    const hand = (right: V, down: V, forward: V) => ({ right, down, forward, tanHalf: h.tanHalf, aspect: h.aspect });
    const cases: [string, ReturnType<typeof hand>, number][] = [
      ['pan 90', cameraRig({ ...DEFAULT_CAMERA, pan: 90 }, 1920, 1080), 0],
      ['pan -90', cameraRig({ ...DEFAULT_CAMERA, pan: -90 }, 1920, 1080), 1],
      ['pan 180', cameraRig({ ...DEFAULT_CAMERA, pan: 180 }, 1920, 1080), 5],
      ['tilt up', hand([1, 0, 0], [0, 0, 1], [0, -1, 0]), 2],
      ['tilt down', hand([1, 0, 0], [0, 0, -1], [0, 1, 0]), 3],
    ];
    for (const [name, rig, face] of cases) {
      const ray = skyRay(rig, 0);
      const c = skyDirAt(ray, 0, 0);
      expect(cubeFace(c[0], c[1], c[2]).face, name).toBe(face);
      const left = skyDirAt(ray, -0.5, 0);
      const a = cubeFace(left[0], left[1], left[2]);
      expect(a.face, name).toBe(face);
      expect(a.s, name).toBeLessThan(0.5);
      const up = skyDirAt(ray, 0, 0.5);
      const b = cubeFace(up[0], up[1], up[2]);
      expect(b.face, name).toBe(face);
      expect(b.t, name).toBeLessThan(0.5);
    }
  });

  it('cubeFace and faceDirection undo each other', () => {
    for (let face = 0; face < 6; face++) {
      for (let i = 0; i < 5; i++) {
        for (let j = 0; j < 5; j++) {
          const s = 0.05 + (0.9 * i) / 4;
          const t = 0.05 + (0.9 * j) / 4;
          const d = faceDirection(face, s, t);
          const r = cubeFace(d[0], d[1], d[2]);
          expect(r.face).toBe(face);
          expect(Math.abs(r.s - s)).toBeLessThan(1e-9);
          expect(Math.abs(r.t - t)).toBeLessThan(1e-9);
        }
      }
    }
  });

  it('the axes land on their sides', () => {
    const axes: [number, number, number][] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    axes.forEach(([x, y, z], i) => {
      const r = cubeFace(x, y, z);
      expect(r.face).toBe(i);
      expect(r.s).toBeCloseTo(0.5, 9);
      expect(r.t).toBeCloseTo(0.5, 9);
    });
  });

  it('the home camera sees the front upright and not mirrored', () => {
    const ray = skyRay(home(), 0);
    const c = skyDirAt(ray, 0, 0);
    const mid = cubeFace(c[0], c[1], c[2]);
    expect(mid.face).toBe(4);
    expect(mid.s).toBeCloseTo(0.5, 6);
    expect(mid.t).toBeCloseTo(0.5, 6);
    const tl = skyDirAt(ray, -1, 1);
    const a = cubeFace(tl[0], tl[1], tl[2]);
    expect(a.face).toBe(4);
    expect(a.s).toBeLessThan(0.5);
    expect(a.t).toBeLessThan(0.5);
    const r = skyDirAt(ray, 1, 0);
    expect(cubeFace(r[0], r[1], r[2]).s).toBeGreaterThan(0.5);
  });

  it('a pan of 90 shows the right side', () => {
    const ray = skyRay(cameraRig({ ...DEFAULT_CAMERA, pan: 90 }, 1920, 1080), 0);
    const c = skyDirAt(ray, 0, 0);
    expect(cubeFace(c[0], c[1], c[2]).face).toBe(0);
  });

  it('looking up shows the top with the front at its bottom edge', () => {
    const h = home();
    const rig = { right: [1, 0, 0] as [number, number, number], down: [0, 0, 1] as [number, number, number], forward: [0, -1, 0] as [number, number, number], tanHalf: h.tanHalf, aspect: h.aspect };
    const ray = skyRay(rig, 0);
    const c = skyDirAt(ray, 0, 0);
    expect(cubeFace(c[0], c[1], c[2]).face).toBe(2);
    const low = skyDirAt(ray, 0, -1);
    const r = cubeFace(low[0], low[1], low[2]);
    expect(r.face).toBe(2);
    expect(r.t).toBeGreaterThan(0.5);
  });

  it('turn 90 shows the right side ahead of the home camera, -90 the left', () => {
    const c90 = skyDirAt(skyRay(home(), 90), 0, 0);
    expect(cubeFace(c90[0], c90[1], c90[2]).face).toBe(0);
    const c270 = skyDirAt(skyRay(home(), -90), 0, 0);
    expect(cubeFace(c270[0], c270[1], c270[2]).face).toBe(1);
  });

  it('turnedSource turns clockwise', () => {
    // where the old top left (0, 0) of a 3 x 3 picture lands
    const where = (k: number) => {
      for (let y = 0; y < 3; y++) {
        for (let x = 0; x < 3; x++) {
          const [sx, sy] = turnedSource(3, k, x, y);
          if (sx === 0 && sy === 0) return [x, y];
        }
      }
      return null;
    };
    expect(where(1)).toEqual([2, 0]);
    expect(where(2)).toEqual([2, 2]);
    expect(where(3)).toEqual([0, 2]);
    expect(where(4)).toEqual(where(0));
    expect(where(-4)).toEqual(where(0));
    expect(where(0)).toEqual([0, 0]);
  });

  it('turnSample of a 2x2 picture', () => {
    // pixels a b / c d, one red value each
    const p = new Uint8ClampedArray([10, 0, 0, 255, 20, 0, 0, 255, 30, 0, 0, 255, 40, 0, 0, 255]);
    const reds = (a: Uint8ClampedArray) => [a[0], a[4], a[8], a[12]];
    expect(reds(turnSample(p, 2, 0))).toEqual([10, 20, 30, 40]);
    expect(reds(turnSample(p, 2, 1))).toEqual([30, 10, 40, 20]);
    expect(reds(turnSample(p, 2, 2))).toEqual([40, 30, 20, 10]);
    expect(reds(turnSample(p, 2, 3))).toEqual([20, 40, 10, 30]);
    expect(turnSample(p, 2, 0)).not.toBe(p);
  });
});

describe('sizes', () => {
  it('skyFaceSize is the source, at most 2048, at most twice the height, at least 16', () => {
    expect(skyFaceSize(1024, 1080)).toBe(1024);
    expect(skyFaceSize(4096, 4320)).toBe(SKY_FACE_MAX);
    expect(skyFaceSize(2048, 540)).toBe(1080);
    expect(skyFaceSize(4, 1080)).toBe(16);
    expect(skyFaceSize(0, 540)).toBe(1080);
    expect(skyFaceSize(1024, NaN)).toBe(1024);
  });

  it('skyChannelCap is 512 for the inset and 2048 else', () => {
    expect(skyChannelCap('inset')).toBe(512);
    expect(skyChannelCap('main')).toBe(2048);
    expect(skyChannelCap('export')).toBe(2048);
  });
});

describe('ids and usability', () => {
  it('validSky wants one asset or six faces, not both', () => {
    expect(validSky(skyOf())).toBe(true);
    expect(validSky(skyOf({ asset: undefined, faces: ['a', 'b', 'c', 'd', 'e', 'f'] }))).toBe(true);
    expect(validSky(skyOf({ faces: ['a', 'b', 'c', 'd', 'e', 'f'] }))).toBe(false);
    expect(validSky(skyOf({ asset: undefined }))).toBe(false);
    expect(validSky(skyOf({ asset: '' }))).toBe(false);
    expect(validSky(skyOf({ asset: undefined, faces: ['a', 'b', 'c', 'd', 'e'] }))).toBe(false);
    expect(validSky(skyOf({ asset: undefined, faces: ['a', 'b', 'c', 'd', 'e', ''] }))).toBe(false);
    expect(validSky(null)).toBe(false);
    expect(validSky([])).toBe(false);
    expect(validSky('x')).toBe(false);
  });

  it('skyAssetIds, skyUses and remapSky follow the ids', () => {
    const six = skyOf({ asset: undefined, faces: ['a', 'b', 'c', 'd', 'e', 'f'] });
    expect(skyAssetIds(skyOf())).toEqual(['a1']);
    expect(skyAssetIds(six)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(skyAssetIds(null)).toEqual([]);
    expect(skyAssetIds(skyOf({ asset: '' }))).toEqual([]);
    expect(skyUses(six, 'c')).toBe(true);
    expect(skyUses(six, 'z')).toBe(false);
    expect(skyUses(undefined, 'a1')).toBe(false);
    const map = new Map([['a1', 'n1'], ['b', 'nb']]);
    expect(remapSky(skyOf(), map).asset).toBe('n1');
    expect(remapSky(six, map).faces).toEqual(['a', 'nb', 'c', 'd', 'e', 'f']);
    expect(remapSky(skyOf(), new Map()).asset).toBe('a1');
  });

  it('skyKey changes with the pictures and the turns, not with turn, brightness or blur', () => {
    const six = skyOf({ asset: undefined, faces: ['a', 'b', 'c', 'd', 'e', 'f'] });
    expect(skyKey(skyOf())).toBe(skyKey(skyOf({ turn: 40, brightness: 0.5, blur: 0.3 })));
    expect(skyKey(skyOf())).not.toBe(skyKey(skyOf({ asset: 'a2' })));
    expect(skyKey(six)).not.toBe(skyKey({ ...six, turns: [0, 0, 1, 0, 0, 0] }));
    expect(skyKey(six)).toBe(skyKey({ ...six, turns: [0, 0, 0, 0, 0, 0], turn: 9 }));
    expect(skyKey(six)).not.toBe(skyKey({ ...six, faces: ['b', 'a', 'c', 'd', 'e', 'f'] }));
    expect(skyKey(skyOf({ asset: '' }))).toBe('');
  });

  it('skyUsable is false for a missing picture, a video, a 2:1 picture and a broken sky, true for a good one', () => {
    const p = createProject('t');
    p.assets = [img('a1', 'sky', 1024, 768)];
    p.sky = skyOf();
    expect(skyUsable(p)).toBe(true);
    expect(skyUsable({ ...p, assets: [] })).toBe(false);
    expect(skyUsable({ ...p, assets: [vid('a1', 'sky', 1024, 768)] })).toBe(false);
    expect(skyUsable({ ...p, assets: [img('a1', 'pano', 2048, 1024)] })).toBe(false);
    expect(skyUsable({ ...p, sky: skyOf({ asset: '' }) })).toBe(false);
    expect(skyUsable({ ...p, sky: null })).toBe(false);
    expect(skyUsable({ ...p, sky: undefined })).toBe(false);
    // six pictures take any shape
    const six = { ...p, assets: ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => img(id, id, 512, 512)), sky: skyOf({ asset: undefined, faces: ['a', 'b', 'c', 'd', 'e', 'f'] }) };
    expect(skyUsable(six)).toBe(true);
    // a different media list is looked at again
    expect(skyUsable({ ...six, assets: six.assets.slice(1) })).toBe(false);
  });
});

describe('readers', () => {
  it('the readers fall back to turn 0, brightness 1, blur 0 and clamp', () => {
    const bad = { light } as unknown as SceneSky;
    expect(skyTurn(bad)).toBe(0);
    expect(skyBrightness(bad)).toBe(1);
    expect(skyBlur(bad)).toBe(0);
    expect(skyBrightness(skyOf({ brightness: 5 }))).toBe(2);
    expect(skyBrightness(skyOf({ brightness: -1 }))).toBe(0);
    expect(skyBlur(skyOf({ blur: 3 }))).toBe(1);
    expect(skyBlur(skyOf({ blur: -3 }))).toBe(0);
    expect(skyTurn(skyOf({ turn: 190 }))).toBe(-170);
  });

  it('wrapDeg wraps in 0.1 steps', () => {
    expect(wrapDeg(0)).toBe(0);
    expect(wrapDeg(180)).toBe(180);
    expect(wrapDeg(-180)).toBe(-180);
    expect(wrapDeg(190)).toBe(-170);
    expect(wrapDeg(-190)).toBe(170);
    expect(wrapDeg(360)).toBe(0);
    expect(wrapDeg(725.04)).toBe(5);
    expect(wrapDeg(12.34)).toBe(12.3);
    expect(wrapDeg(NaN)).toBe(0);
    expect(wrapDeg(Infinity)).toBe(0);
    expect(Object.is(wrapDeg(-0.01), 0)).toBe(true);
  });

  it('withSkyValues clamps and gives the same object when nothing changes', () => {
    const s = skyOf({ turn: 10, brightness: 1, blur: 0.5 });
    expect(withSkyValues(s, {})).toBe(s);
    expect(withSkyValues(s, { turn: 10, brightness: 1, blur: 0.5 })).toBe(s);
    expect(withSkyValues(s, { turn: NaN, brightness: 'x', blur: null })).toBe(s);
    const n = withSkyValues(s, { turn: 370, brightness: 9, blur: -1 });
    expect(n).not.toBe(s);
    expect(n.turn).toBe(10);
    expect(n.brightness).toBe(2);
    expect(n.blur).toBe(0);
    expect(s.brightness).toBe(1);
    expect(withSkyValues(s, { blur: 0.123456 }).blur).toBe(0.1235);
    expect(withSkyValues(s, { turn: 200 }).turn).toBe(-160);
  });
});

describe('names', () => {
  it('skySideOf reads the usual names', () => {
    const side = (n: string) => skySideOf(n)?.side ?? null;
    expect(side('px.png')).toBe(0);
    expect(side('sky_negx.jpg')).toBe(1);
    expect(side('PositiveY.png')).toBe(2);
    expect(side('Sky_NegativeY.png')).toBe(3);
    expect(side('skybox_ft.tga')).toBe(4);
    expect(skySideOf('skybox_ft.tga')!.word).toBe(true);
    expect(side('Back.jpg')).toBe(5);
    expect(skySideOf('Back.jpg')!.word).toBe(true);
    expect(side('sky_right2.png')).toBe(0);
    expect(side('up.jpg')).toBe(2);
    expect(side('dn.png')).toBe(3);
    expect(side('pos_z.png')).toBe(4);
    expect(side('sky+x.png')).toBe(0);
    expect(side('sky-x.png')).toBe(1);
    expect(skySideOf('px.png')!.word).toBe(false);
    expect(skySideOf('photo.png')).toBeNull();
    expect(skySideOf('background.png')).toBeNull();
    expect(nameTokens('SkyBox_01.png')).toEqual(['sky', 'box']);
  });

  it('skyStemOf drops the side words', () => {
    expect(skyStemOf('sky_px.png')).toBe('sky');
    expect(skyStemOf('sky_negative_x.png')).toBe('sky');
    expect(skyStemOf('mountains_right.jpg')).toBe('mountains');
    expect(skyStemOf('right_mountains.jpg')).toBe('mountains');
    expect(skyStemOf('photo.png')).toBe('photo');
  });

  const six = (names: string[]) => names.map((name, i) => ({ id: `i${i}`, name }));

  it('guessFaces puts six named pictures in side order', () => {
    const g = guessFaces(six(['s_nz.png', 's_px.png', 's_py.png', 's_nx.png', 's_pz.png', 's_ny.png']))!;
    expect(g.faces).toEqual(['i1', 'i3', 'i2', 'i5', 'i4', 'i0']);
    expect(g.words).toBe(false);
    const w = guessFaces(six(['back.jpg', 'front.jpg', 'left.jpg', 'right.jpg', 'top.jpg', 'bottom.jpg']))!;
    expect(w.faces).toEqual(['i3', 'i2', 'i4', 'i5', 'i1', 'i0']);
    expect(w.words).toBe(true);
  });

  it('guessFaces refuses five, two fronts and unnamed ones, and reads 0..5 and 1..6 as side order', () => {
    expect(guessFaces(six(['a_px', 'a_nx', 'a_py', 'a_ny', 'a_pz']))).toBeNull();
    expect(guessFaces(six(['a_px', 'a_nx', 'a_py', 'a_ny', 'a_pz', 'a_front']))).toBeNull();
    expect(guessFaces(six(['one', 'two', 'three', 'four', 'five', 'six']))).toBeNull();
    const zero = guessFaces(six(['s_3.png', 's_0.png', 's_1.png', 's_2.png', 's_5.png', 's_4.png']))!;
    expect(zero.faces).toEqual(['i1', 'i2', 'i3', 'i0', 'i5', 'i4']);
    expect(zero.words).toBe(true);
    const one = guessFaces(six(['s_1.png', 's_2.png', 's_3.png', 's_4.png', 's_5.png', 's_6.png']))!;
    expect(one.faces).toEqual(['i0', 'i1', 'i2', 'i3', 'i4', 'i5']);
    expect(guessFaces(six(['s_1.png', 's_2.png', 's_3.png', 's_4.png', 's_5.png', 's_7.png']))).toBeNull();
  });

  it('skyCandidates finds a named set of six, a strip and a named cross, and skips a 4:3 photo, mixed sizes and videos', () => {
    const set = ['px', 'nx', 'py', 'ny', 'pz', 'nz'].map((s) => img(`s_${s}`, `day_${s}.png`, 512, 512));
    const assets = [...set, img('strip', 'wide.png', 3072, 512), img('cross', 'my_skybox.png', 1024, 768), img('photo', 'holiday.jpg', 1024, 768)];
    expect(skyCandidates(assets)).toEqual([['s_px', 's_nx', 's_py', 's_ny', 's_pz', 's_nz'], ['strip'], ['cross']]);
    // one side of another size breaks the set
    expect(skyCandidates([...set.slice(0, 5), img('s_nz', 'day_nz.png', 256, 256)])).toEqual([]);
    // an svg is no sky (createImageBitmap cannot read it)
    expect(skyCandidates([{ ...img('s', 'wide.svg', 3072, 512), mime: 'image/svg+xml' }])).toEqual([]);
    // a video is no side
    expect(skyCandidates([...set.slice(0, 5), vid('s_nz', 'day_nz.mp4', 512, 512)])).toEqual([]);
  });
});

describe('skyDrawFor', () => {
  const pic: SkyPicture = { key: 'k', size: 64, faces: [], close() {} };
  const project = (sky: SceneSky | null, assets: MediaAsset[]) => {
    const p = createProject('t');
    p.assets = assets;
    p.sky = sky;
    return p;
  };
  const good = [img('a1', 'sky', 1024, 768)];

  it('needs a usable sky and a picture', () => {
    const rig = home();
    const of = () => pic;
    expect(skyDrawFor(project(skyOf(), good), of, 'main', rig)).not.toBeNull();
    expect(skyDrawFor(project(null, good), of, 'main', rig)).toBeNull();
    expect(skyDrawFor(project(skyOf(), good), undefined, 'main', rig)).toBeNull();
    expect(skyDrawFor(project(skyOf(), []), of, 'main', rig)).toBeNull();
    expect(skyDrawFor(project(skyOf(), good), () => null, 'main', rig)).toBeNull();
  });

  it('turns brightness, blur and the channel into gain, bias and maxFace', () => {
    const rig = home();
    const p = project(skyOf({ turn: 30, brightness: 1.5, blur: 0.5 }), good);
    const d = skyDrawFor(p, () => pic, 'main', rig)!;
    expect(d.pic).toBe(pic);
    expect(d.gain).toBe(1.5);
    expect(d.bias).toBeCloseTo(0.5 * SKY_BLUR_LEVELS, 9);
    expect(d.maxFace).toBe(2048);
    expect(Array.from(d.ray)).toEqual(Array.from(skyRay(rig, 30)));
    expect(skyDrawFor(p, () => pic, 'inset', rig)!.maxFace).toBe(512);
  });
});
