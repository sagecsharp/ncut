import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createProject, createTextClip } from '../lib/factory';
import type { ImageClip, Project, VideoClip } from '../types';
import { DEFAULT_TRANSFORM } from '../types';
import { planeFor } from './draw';
import type { DrawSource, Layer3D } from './draw';
import { DEFAULT_CAMERA, cameraRig } from './scene3d/camera';

let seq = 0;
const video = (trackId: string, over: Partial<VideoClip> = {}): VideoClip => ({
  id: `lv${++seq}`, type: 'video', trackId, start: 0, duration: 10, name: 'v', fadeIn: 0, fadeOut: 0, assetId: 'vid', trimStart: 0, speed: 1, volume: 1, muted: false, transform: { ...DEFAULT_TRANSFORM }, ...over,
});
const image = (trackId: string, over: Partial<ImageClip> = {}): ImageClip => ({
  id: `li${++seq}`, type: 'image', trackId, start: 0, duration: 10, name: 'i', fadeIn: 0, fadeOut: 0, assetId: 'img', transform: { ...DEFAULT_TRANSFORM }, ...over,
});
const src = (w: number, h: number): DrawSource => ({ image: { width: w, height: h } as unknown as CanvasImageSource, width: w, height: h });
const rig = () => cameraRig(DEFAULT_CAMERA, 1280, 720);

function projectWith(make: (trackId: string) => ImageClip | VideoClip): { p: Project; clip: ImageClip | VideoClip } {
  const p = createProject();
  const t = p.tracks.find((x) => x.kind === 'video')!;
  const clip = make(t.id);
  p.clips.push(clip);
  return { p, clip };
}
const planeOf = (p: Project, layer: Layer3D) => planeFor(p, layer, rig(), 'default')!;

describe('planeFor sets lit', () => {
  const litOf = (lit: number | undefined, shape?: 'box') => {
    const { p, clip } = projectWith((t) => image(t, { threeD: true, shape, lit }));
    return planeOf(p, { clip, source: src(640, 360), alpha: 1, time: 1 });
  };
  it('lit 0.6 gives 0.6, lit 3 gives 1', () => {
    expect(litOf(0.6).lit).toBe(0.6);
    expect(litOf(3).lit).toBe(1);
  });
  it('lit 0, missing, negative or nan gives none', () => {
    for (const v of [0, undefined, -1, NaN]) expect(litOf(v).lit).toBeUndefined();
  });
  it('a box keeps its lit', () => {
    expect(litOf(0.5, 'box').lit).toBe(0.5);
  });
});

describe('planeFor sets serial', () => {
  it('a 3d video clip with a source and a layer serial gives the serial', () => {
    const { p, clip } = projectWith((t) => video(t, { threeD: true }));
    expect(planeOf(p, { clip, source: src(640, 360), alpha: 1, time: 1, serial: 7 }).serial).toBe(7);
  });
  it('a clip with a texture key (an image) gives none', () => {
    const { p, clip } = projectWith((t) => image(t, { threeD: true }));
    expect(planeOf(p, { clip, source: src(640, 360), alpha: 1, time: 1, serial: 7 }).serial).toBeUndefined();
  });
  it('a layer without a serial gives none', () => {
    const { p, clip } = projectWith((t) => video(t, { threeD: true }));
    expect(planeOf(p, { clip, source: src(640, 360), alpha: 1, time: 1 }).serial).toBeUndefined();
  });
});

describe('planeFor: the side planes of a 3d depth text copy lit', () => {
  class FakeCanvas {
    width: number;
    height: number;
    constructor(w: number, h: number) {
      this.width = w;
      this.height = h;
    }
    getContext() {
      const target: Record<string, unknown> = {
        font: '',
        getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
        measureText: (s: string) => ({ width: Array.from(s).length * 10 }),
      };
      return new Proxy(target, {
        get: (tg, k: string) => (k in tg ? tg[k] : () => undefined),
        set: (tg, k: string, v) => {
          tg[k] = v;
          return true;
        },
        has: (tg, k: string) => k in tg,
      });
    }
  }
  beforeAll(() => {
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
  });
  afterAll(() => vi.unstubAllGlobals());

  const eyeRig = { eye: [960, 540, -1500] } as unknown as Parameters<typeof planeFor>[2];
  const build = (lit: number | undefined) => {
    const p = createProject();
    const t = p.tracks.find((x) => x.kind === 'video')!;
    const c = createTextClip(t.id, 0, { threeD: true, fontFamily: 'Depth A', fontSize: 40, duration: 5, extrude: { depth: 0.5, angle: 45, color: '#ff0000' }, lit } as never);
    p.clips.push(c);
    const sides: NonNullable<ReturnType<typeof planeFor>>[] = [];
    const face = planeFor(p, { clip: c, source: null, alpha: 1, time: 1 }, eyeRig, 'default', sides)!;
    return { c, p, face, sides };
  };

  it('lit 0.6 gives every side plane lit 0.6, and lit 0 again clears it', () => {
    const a = build(0.6);
    expect(a.face.lit).toBe(0.6);
    expect(a.sides.length).toBeGreaterThan(0);
    for (const s of a.sides) expect(s.lit).toBe(0.6);
    // the same clip again with lit 0: the cached planes must not keep the old lit
    (a.c as { lit?: number }).lit = 0;
    const sides: NonNullable<ReturnType<typeof planeFor>>[] = [];
    planeFor(a.p, { clip: a.c, source: null, alpha: 1, time: 1 }, eyeRig, 'default', sides);
    expect(sides.length).toBeGreaterThan(0);
    for (const s of sides) expect(s.lit).toBeUndefined();
  });
});
