import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createProject, createTextClip } from '../lib/factory';
import type { ImageClip, Project, VisualClip } from '../types';
import { DEFAULT_TRANSFORM } from '../types';
import { bentFlatClip, getClipBox, planeFor } from './draw';
import type { DrawSource, Layer3D } from './draw';
import { DEFAULT_CAMERA, cameraRig } from './scene3d/camera';

let seq = 0;
const image = (trackId: string, over: Partial<ImageClip> = {}): ImageClip => ({
  id: `bi${++seq}`, type: 'image', trackId, start: 0, duration: 10, name: 'i', fadeIn: 0, fadeOut: 0, assetId: 'img', transform: { ...DEFAULT_TRANSFORM }, ...over,
});
const src = (w: number, h: number): DrawSource => ({ image: { width: w, height: h } as unknown as CanvasImageSource, width: w, height: h });
const rig = () => cameraRig(DEFAULT_CAMERA, 1280, 720);
const DEG = Math.PI / 180;

function projectWith(make: (trackId: string) => ImageClip): { p: Project; clip: ImageClip } {
  const p = createProject();
  const t = p.tracks.find((x) => x.kind === 'video')!;
  const clip = make(t.id);
  p.clips.push(clip);
  return { p, clip };
}
const layerOf = (clip: VisualClip): Layer3D => ({ clip, source: src(640, 360), alpha: 1, time: 1 });
const planeOf = (p: Project, clip: VisualClip) => planeFor(p, layerOf(clip), rig(), 'default')!;

describe('planeFor: bend', () => {
  it('planeFor: a flat or missing bend gives no bend', () => {
    for (const bend of [undefined, null, { angle: 0 }, { angle: 0.001 }]) {
      const { p, clip } = projectWith((t) => image(t, { threeD: true, bend }));
      expect(planeOf(p, clip).bend).toBeUndefined();
    }
  });

  it('planeFor: a bent image plane gets k, c, s and o from its box', () => {
    const { p, clip } = projectWith((t) => image(t, { threeD: true, bend: { angle: 90, center: 0.25 } }));
    const box = getClipBox(p, clip, { width: 640, height: 360 });
    const b = planeOf(p, clip).bend!;
    expect(b).toBeDefined();
    expect(b.k).toBeCloseTo((90 * DEG) / box.width, 9);
    expect(b.c).toBeCloseTo(0.25 * box.width, 6);
    expect(b.s).toBeCloseTo(box.width, 6);
    expect(b.o).toBeCloseTo(0, 6);
    expect(b.axis).toBe(0);
  });

  it('planeFor: a cropped bent plane keeps the curvature of the whole clip', () => {
    const { p, clip } = projectWith((t) => image(t, { threeD: true, bend: { angle: 90 }, crop: { left: 0.25, right: 0, top: 0, bottom: 0 } }));
    const box = getClipBox(p, clip, { width: 640, height: 360 });
    const b = planeOf(p, clip).bend!;
    expect(b.k).toBeCloseTo((90 * DEG) / box.width, 9);
    expect(b.s).toBeCloseTo(box.width * 0.75, 6);
    expect(b.o).toBeCloseTo(box.width * 0.125, 6);
  });

  it('planeFor: a bend along the height reads the height and the vertical crop', () => {
    const { p, clip } = projectWith((t) => image(t, { threeD: true, bend: { angle: -60, along: 'height' }, crop: { left: 0, right: 0, top: 0.5, bottom: 0 } }));
    const box = getClipBox(p, clip, { width: 640, height: 360 });
    const b = planeOf(p, clip).bend!;
    expect(b.axis).toBe(1);
    expect(b.k).toBeCloseTo((-60 * DEG) / box.height, 9);
    expect(b.s).toBeCloseTo(box.height * 0.5, 6);
    expect(b.o).toBeCloseTo(box.height * 0.25, 6);
  });

  it('planeFor: a solid ignores the bend', () => {
    const { p, clip } = projectWith((t) => image(t, { threeD: true, shape: 'box', bend: { angle: 90 } }));
    expect(planeOf(p, clip).bend).toBeUndefined();
  });
});

describe('planeFor: bend on a text', () => {
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
  const build = (over: Record<string, unknown>) => {
    const p = createProject();
    const t = p.tracks.find((x) => x.kind === 'video')!;
    const c = createTextClip(t.id, 0, { threeD: true, fontFamily: 'Bend A', fontSize: 40, duration: 5, ...over } as never);
    p.clips.push(c);
    const sides: NonNullable<ReturnType<typeof planeFor>>[] = [];
    const face = planeFor(p, { clip: c, source: null, alpha: 1, time: 1 }, eyeRig, 'default', sides)!;
    return { c, p, face, sides };
  };

  it('planeFor: a text bends over its own length, not its texture room', () => {
    const a = build({ bend: { angle: 90 }, shadow: { color: '#000000', blur: 20, x: 30, y: 30 } });
    const box = getClipBox(a.p, a.c);
    const b = a.face.bend!;
    expect(b).toBeDefined();
    // k follows the own width. the mesh is longer (the room around the text), and still centred
    expect(b.k).toBeCloseTo((90 * DEG) / box.width, 9);
    expect(b.s).toBeGreaterThan(box.width);
    expect(b.o).toBeCloseTo(0, 6);
  });

  it('planeFor: the side planes of a bent depth text keep the face model and get the lift', () => {
    const a = build({ bend: { angle: 90 }, extrude: { depth: 0.5, angle: 45, color: '#ff0000' } });
    expect(a.face.bend).toBeDefined();
    expect(a.sides.length).toBeGreaterThan(0);
    for (const s of a.sides) {
      expect(Array.from(s.model)).toEqual(Array.from(a.face.model));
      expect(s.bend).toBeDefined();
      expect(s.bend!.k).toBe(a.face.bend!.k);
      expect(s.bend!.lift).toBeGreaterThan(0);
    }
    // a flat face builds the copies as before: shifted along the model, no bend
    const flat = build({ bend: { angle: 0 }, extrude: { depth: 0.5, angle: 45, color: '#ff0000' } });
    for (const s of flat.sides) {
      expect(s.bend).toBeUndefined();
      expect(Array.from(s.model)).not.toEqual(Array.from(flat.face.model));
    }
  });
});

describe('bentFlatClip', () => {
  it('bentFlatClip drops z, tilt and turn and scales the span by a 2d parent', () => {
    const p = createProject();
    const t = p.tracks.find((x) => x.kind === 'video')!;
    const parent = image(t.id, { transform: { ...DEFAULT_TRANSFORM, scale: 2 } });
    const kid = image(t.id, {
      parent: parent.id,
      lookAt: 'camera' as never,
      shape: 'box',
      lit: 0.5,
      threeD: true,
      transform: { ...DEFAULT_TRANSFORM, z: 40, rotX: 20, rotY: 30 },
      bend: { angle: 90, span: 100, center: 0.5 },
    });
    p.clips.push(parent, kid);
    const out = bentFlatClip(p, kid, 1) as ImageClip;
    expect(out.transform.z).toBe(0);
    expect(out.transform.rotX).toBe(0);
    expect(out.transform.rotY).toBe(0);
    expect(out.transform.scale).toBe(2);
    expect(out.parent).toBeUndefined();
    expect(out.lookAt).toBeUndefined();
    expect(out.shape).toBeUndefined();
    expect(out.lit).toBeUndefined();
    expect(out.bend).toEqual({ angle: 90, span: 200, center: 0.5 });
    // the stored clip is untouched
    expect(kid.bend!.span).toBe(100);
  });

  it('bentFlatClip keeps threeD off so a 2d text keeps its flat extrude', () => {
    const p = createProject();
    const t = p.tracks.find((x) => x.kind === 'video')!;
    const c = createTextClip(t.id, 0, { extrude: { depth: 0.5, angle: 45, color: '#ff0000' }, bend: { angle: 45 } } as never);
    p.clips.push(c);
    const out = bentFlatClip(p, c, 1);
    expect(out.threeD).toBeFalsy();
    expect((out as { extrude?: unknown }).extrude).toEqual((c as { extrude?: unknown }).extrude);
  });

  it('bentFlatClip keeps the pivot', () => {
    const p = createProject();
    const t = p.tracks.find((x) => x.kind === 'video')!;
    const c = image(t.id, { pivot: { x: -0.5, y: 0.25 }, bend: { angle: 60 } });
    p.clips.push(c);
    const out = bentFlatClip(p, c, 1);
    expect(out.pivot).toEqual({ x: -0.5, y: 0.25 });
  });
});
