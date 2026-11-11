import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createProject, createShapeClip, createTextClip } from '../lib/factory';
import { baseValue, resolveClip } from '../lib/anim';
import type { ImageClip, Project, ShapeClip, TextClip, Transform, VisualClip } from '../types';
import { DEFAULT_TRANSFORM } from '../types';
import { getClipBox, getClipBoxWorld, padAxes, planeFor, samePose } from './draw';
import type { Layer3D } from './draw';
import { drawText, measureText } from './text';
import { depthPixels } from './textDepth';
import { reparentTransform, worldTransform } from './parent';

vi.mock('../lib/fonts', () => ({ ensureFont: vi.fn(async () => true), fontsVersion: () => 0 }));

const tf = (o: Partial<Transform> = {}): Transform => ({ ...DEFAULT_TRANSFORM, ...o });

// every character is 10 wide
class FakeCanvas {
  constructor(
    public width: number,
    public height: number,
  ) {}
  getContext() {
    return new Proxy({ measureText: (s: string) => ({ width: Array.from(s).length * 10 }), font: '' } as Record<string, unknown>, {
      get: (t, k: string) => (k in t ? t[k] : () => ({ addColorStop() {} })),
      set: (t, k: string, v) => ((t[k] = v), true),
    });
  }
}
beforeAll(() => vi.stubGlobal('OffscreenCanvas', FakeCanvas));
afterAll(() => vi.unstubAllGlobals());

function scene(clips: VisualClip[]): Project {
  const p = createProject();
  p.clips = clips;
  return p;
}
const shapeOf = (p: Project, over: Partial<ShapeClip> = {}): ShapeClip => ({ ...createShapeClip(p.tracks[0]!.id, 0, { duration: 10 }), width: 400, height: 200, stroke: null, ...over });
const rig = { eye: [960, 540, -1500] } as unknown as Parameters<typeof planeFor>[2];
const layer = (clip: VisualClip): Layer3D => ({ clip, source: null, alpha: 1, time: 0 }) as unknown as Layer3D;

describe('getClipBox with a stretch', () => {
  it('shape: width and height are stretched on top of scale', () => {
    const p = createProject();
    const c = shapeOf(p, { transform: tf({ scale: 2, scaleX: 1.5, scaleY: 0.5 }) });
    const b = getClipBox(p, c);
    expect(b.width).toBeCloseTo(400 * 2 * 1.5);
    expect(b.height).toBeCloseTo(200 * 2 * 0.5);
  });
  it('a missing stretch changes nothing, scaleZ never changes the box', () => {
    const p = createProject();
    const b = getClipBox(p, shapeOf(p, { transform: tf({ scale: 2, scaleZ: 9 }) }));
    expect(b.width).toBe(800);
    expect(b.height).toBe(400);
  });
  it('media: the box is the contained size, stretched', () => {
    const p = createProject();
    const img: ImageClip = { id: 'i', type: 'image', trackId: p.tracks[0]!.id, start: 0, duration: 1, name: 'i', fadeIn: 0, fadeOut: 0, assetId: 'a', transform: tf({ scaleX: 2 }) };
    const plain = getClipBox(p, { ...img, transform: tf() }, { width: 100, height: 100 });
    const wide = getClipBox(p, img, { width: 100, height: 100 });
    expect(wide.width).toBeCloseTo(plain.width * 2);
    expect(wide.height).toBeCloseTo(plain.height);
  });
  it('text: the box is the measured box, stretched', () => {
    const p = createProject();
    const c = createTextClip(p.tracks[0]!.id, 0, { text: 'abc', transform: tf({ scale: 2, scaleX: 3, scaleY: 0.5 }) });
    const m = measureText(c);
    const b = getClipBox(p, c);
    expect(b.width).toBeCloseTo(m.width * 6);
    expect(b.height).toBeCloseTo(m.height * 1);
  });
  it('a child under a stretched parent gets none of it, only its own', () => {
    const p = createProject();
    const par = { ...shapeOf(p, { transform: tf({ scale: 2, scaleX: 3, scaleY: 4, scaleZ: 5 }) }), id: 'par' };
    const kid = { ...shapeOf(p, { transform: tf({ scale: 0.5, scaleX: 2 }), parent: 'par' }), id: 'kid' };
    const q = scene([par, kid]);
    const w = worldTransform(q, kid, 1);
    expect(w.scale).toBeCloseTo(1);
    expect(w.scaleX).toBe(2);
    expect(w.scaleY).toBeUndefined();
    expect(w.scaleZ).toBeUndefined();
    const b = getClipBoxWorld(q, kid, 1);
    expect(b.width).toBeCloseTo(400 * 1 * 2);
    expect(b.height).toBeCloseTo(200);
  });
  it('reparenting keeps the clip own stretch', () => {
    const p = createProject();
    const par = { ...shapeOf(p, { transform: tf({ scale: 2, scaleX: 3 }) }), id: 'par' };
    const kid = { ...shapeOf(p, { transform: tf({ scaleX: 2, scaleZ: 1.5 }) }), id: 'kid' };
    const q = scene([par, kid]);
    const out = reparentTransform(q, kid, 'par', 1);
    expect(out.scaleX).toBe(2);
    expect(out.scaleZ).toBe(1.5);
    expect(out.scale).toBeCloseTo(0.5);
  });
});

describe('drawText with a stretch', () => {
  it('scales the context by scale x stretch on each axis', () => {
    const scales: number[][] = [];
    const ctx = new Proxy({} as Record<string, unknown>, {
      get: (t, k: string) => (k === 'scale' ? (a: number, b: number) => scales.push([a, b]) : k in t ? t[k] : () => ({ addColorStop() {} })),
      set: (t, k: string, v) => ((t[k] = v), true),
    }) as unknown as CanvasRenderingContext2D;
    const c = createTextClip('t', 0, { text: 'hi', transform: tf({ scale: 2, scaleX: 1.5, scaleY: 0.5 }) });
    drawText(ctx, c);
    expect(scales[0]).toEqual([3, 1]);
  });
});

describe('the room around a text / shape picture', () => {
  it('text: per axis, margin x scale x stretch', () => {
    const t = createTextClip('t', 0, { text: 'hi', transform: tf({ scale: 2, scaleX: 3, scaleY: 0.5 }) });
    expect(padAxes(t, 10)).toEqual({ x: 60, y: 10 });
  });
  it('shape: margin x scale on both axes, the stretch is not in it', () => {
    const p = createProject();
    const s = shapeOf(p, { transform: tf({ scale: 2, scaleX: 3, scaleY: 0.5 }) });
    expect(padAxes(s, 10)).toEqual({ x: 20, y: 20 });
  });
  it('a 3d text plane is the stretched box plus the stretched room, so the picture lines up', () => {
    const p = createProject();
    const c = createTextClip(p.tracks[0]!.id, 0, { text: 'hi', threeD: true, transform: tf({ scale: 1, scaleX: 2, scaleY: 3 }) });
    const flat = createTextClip(p.tracks[0]!.id, 0, { text: 'hi', threeD: true, transform: tf() });
    const a = planeFor(scene([c]), layer(c), rig)!;
    const b = planeFor(scene([flat]), layer(flat), rig)!;
    expect(a.model[0]!).toBeCloseTo(b.model[0]! * 2, 3);
    expect(a.model[5]!).toBeCloseTo(b.model[5]! * 3, 3);
  });
  it('a 3d shape plane keeps the room around the figure even: the outline is not stretched', () => {
    const p = createProject();
    const c = shapeOf(p, { threeD: true, stroke: { color: '#ffffff', width: 20 }, kind: 'ellipse', transform: tf({ scaleX: 2 }) });
    const a = planeFor(scene([c]), layer(c), rig)!;
    const margin = 11;
    expect(a.model[0]!).toBeCloseTo(400 * 2 + margin * 2, 3);
    expect(a.model[5]!).toBeCloseTo(200 + margin * 2, 3);
    const img = a.image as unknown as { width: number; height: number };
    expect(img.width).toBeGreaterThan(img.height * 1.5);
  });
});

describe('the depth of a solid', () => {
  const depthOf = (over: Partial<Transform>, extra: Partial<ShapeClip> = {}) => {
    const p = createProject();
    const c = shapeOf(p, { threeD: true, shape: 'box', ...extra, transform: tf(over) });
    const plane = planeFor(scene([c]), layer(c), rig)!;
    return Math.hypot(plane.model[8]!, plane.model[9]!, plane.model[10]!);
  };
  it('scaleZ multiplies the depth', () => {
    expect(depthOf({ scaleZ: 3 })).toBeCloseTo(depthOf({}) * 3);
    expect(depthOf({ scaleZ: 2 }, { shapeDepth: 50 })).toBeCloseTo(100);
  });
  it('stretching x or y alone never changes the depth', () => {
    const base = depthOf({});
    expect(depthOf({ scaleX: 3 })).toBeCloseTo(base);
    expect(depthOf({ scaleY: 3 })).toBeCloseTo(base);
    expect(depthOf({ scaleX: 3 }, { shape: 'cylinder' })).toBeCloseTo(depthOf({}, { shape: 'cylinder' }));
  });
  it('extruded text depth follows scaleZ', () => {
    const c = createTextClip('t', 0, { text: 'hi', threeD: true, fontSize: 100, extrude: { depth: 0.5, angle: 45, color: '#000000' } as never, transform: tf({ scale: 2 }) });
    const d = depthPixels(c);
    expect(d).toBeGreaterThan(0);
    expect(depthPixels({ ...c, transform: tf({ scale: 2, scaleZ: 3 }) } as TextClip)).toBeCloseTo(d * 3);
    expect(depthPixels({ ...c, transform: tf({ scale: 2, scaleX: 3 }) } as TextClip)).toBeCloseTo(d);
  });
});

describe('samePose, resolveClip, baseValue', () => {
  it('samePose sees a stretch', () => {
    expect(samePose(tf(), 1, tf({ scaleX: 1 }), 1)).toBe(true);
    expect(samePose(tf(), 1, tf({ scaleX: 2 }), 1)).toBe(false);
    expect(samePose(tf(), 1, tf({ scaleZ: 2 }), 1)).toBe(false);
  });
  it('baseValue reads 1 for a missing stretch and keys on scaleX resolve into the transform', () => {
    const p = createProject();
    const c = shapeOf(p, {
      keyframes: {
        scaleX: [
          { t: 0, v: 1, ease: 'linear' },
          { t: 2, v: 3, ease: 'linear' },
        ],
      },
    });
    expect(baseValue(c, 'scaleX')).toBe(1);
    expect(baseValue(c, 'scaleZ')).toBe(1);
    const r = resolveClip(c, 1);
    expect(r.transform.scaleX).toBeCloseTo(2);
    expect(getClipBox(p, r).width).toBeCloseTo(800);
  });
});
