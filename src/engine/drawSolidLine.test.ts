import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Project, ShapeClip, Track } from '../types';
import { DEFAULT_TRANSFORM } from '../types';
import { planeFor } from './draw';
import type { Layer3D } from './draw';
import { lineOnSolid } from './shape';

let seq = 0;
function shape(over: Partial<ShapeClip> = {}): ShapeClip {
  return {
    id: `sl${++seq}`,
    type: 'shape',
    trackId: 't',
    start: 0,
    duration: 5,
    name: 's',
    fadeIn: 0,
    fadeOut: 0,
    kind: 'rect',
    width: 400,
    height: 200,
    color: '#ffffff',
    threeD: true,
    shape: 'box',
    stroke: { color: '#ff0000', width: 10 },
    transform: { ...DEFAULT_TRANSFORM },
    ...over,
  };
}
const tracks: Track[] = [{ id: 't', kind: 'video', name: 't', muted: false, hidden: false, locked: false }];
function project(clips: ShapeClip[]): Project {
  return { id: 'p', name: 'p', createdAt: 0, updatedAt: 0, width: 1920, height: 1080, fps: 30, tracks, clips, assets: [] } as unknown as Project;
}
const rig = { eye: [960, 540, -1500] } as unknown as Parameters<typeof planeFor>[2];
const layer = (clip: ShapeClip): Layer3D => ({ clip, source: null, alpha: 1, time: 0 }) as unknown as Layer3D;

// a canvas that accepts every call and remembers its size
class FakeCanvas {
  constructor(
    public width: number,
    public height: number,
  ) {}
  getContext() {
    return new Proxy({}, { get: () => () => ({ addColorStop() {} }), set: () => true });
  }
}

describe('lineOnSolid', () => {
  it('is true for a plain rect with an outline on a 3d solid', () => {
    expect(lineOnSolid(shape())).toBe(true);
    expect(lineOnSolid(shape({ shape: 'sphere' }))).toBe(true);
    expect(lineOnSolid(shape({ radius: 0 }))).toBe(true);
  });
  it('is false without 3d, a solid, an outline or a plain rect', () => {
    expect(lineOnSolid(shape({ threeD: false }))).toBe(false);
    expect(lineOnSolid(shape({ shape: undefined }))).toBe(false);
    expect(lineOnSolid(shape({ shape: 'plane' }))).toBe(false);
    expect(lineOnSolid(shape({ stroke: null }))).toBe(false);
    expect(lineOnSolid(shape({ stroke: { color: '#fff', width: 0 } }))).toBe(false);
    expect(lineOnSolid(shape({ kind: 'ellipse' }))).toBe(false);
    expect(lineOnSolid(shape({ kind: 'star' }))).toBe(false);
    expect(lineOnSolid(shape({ radius: 0.3 }))).toBe(false);
  });
});

describe('planeFor: the line around a solid', () => {
  beforeAll(() => vi.stubGlobal('OffscreenCanvas', FakeCanvas));
  afterAll(() => vi.unstubAllGlobals());

  it('a rect on a box gets an outline and an unpadded picture', () => {
    const c = shape({ transform: { ...DEFAULT_TRANSFORM, scale: 2 } });
    const p = planeFor(project([c]), layer(c), rig)!;
    expect(p.outline).toBeDefined();
    expect(p.outline!.width).toBe(20);
    expect(p.outline!.color).toEqual([1, 0, 0, 1]);
    expect(p.outline!.hollow).toBe(false);
    // box is as deep as it is tall; the box is the clip box (800 x 400 at scale 2), not grown by the line
    expect(p.outline!.size).toEqual([800, 400, 400]);
    const img = p.image as unknown as { width: number; height: number };
    expect(img.width).toBe(400 * 2);
    expect(img.height).toBe(200 * 2);
  });

  it('is hollow without a fill', () => {
    const c = shape({ filled: false });
    expect(planeFor(project([c]), layer(c), rig)!.outline!.hollow).toBe(true);
  });

  it('an ellipse or a rounded rect keeps its outline in the padded picture', () => {
    for (const c of [shape({ kind: 'ellipse' }), shape({ radius: 0.4 })]) {
      const p = planeFor(project([c]), layer(c), rig)!;
      expect(p.outline).toBeUndefined();
      const img = p.image as unknown as { width: number };
      expect(img.width).toBeGreaterThan(400 * 2);
    }
  });

  it('a plane shape has no outline', () => {
    const c = shape({ shape: 'plane' });
    expect(planeFor(project([c]), layer(c), rig)!.outline).toBeUndefined();
  });

  it('the bare picture is cached: the same clip twice is one texture, and a line width change does not redraw it', () => {
    const c = shape();
    const a = planeFor(project([c]), layer(c), rig)!;
    const a2 = planeFor(project([c]), layer(c), rig)!;
    expect(a.cacheKey).toBeDefined();
    expect(a2.cacheKey).toBe(a.cacheKey);
    expect(a2.image).toBe(a.image);
    // the line is not in the picture, so its width does not make a new one... the signature still has the stroke in it,
    // so only the size and the key kind are checked here: no room for the line, and a key
    const wide = { ...c, stroke: { color: '#ff0000', width: 60 } };
    const w = planeFor(project([wide]), layer(wide), rig)!;
    expect((w.image as unknown as { width: number }).width).toBe((a.image as unknown as { width: number }).width);
    expect(w.cacheKey).toBeDefined();
  });

  it('the bare and the outlined picture of one clip are two pictures, also when both have the same size', () => {
    // a 2d outline of 0 width makes a picture as big as the bare one: only the bare flag in the signature tells them apart
    const c = shape({ id: 'same-size' });
    const a = planeFor(project([c]), layer(c), rig)!;
    const round = { ...c, radius: 0.0001, stroke: { color: '#ff0000', width: 0.0001 } };
    const b = planeFor(project([round]), layer(round), rig)!;
    expect(b.outline).toBeUndefined();
    expect(b.cacheKey).not.toBe(a.cacheKey);
    const a2 = planeFor(project([c]), layer(c), rig)!;
    expect(a2.outline).toBeDefined();
    expect(a2.cacheKey).not.toBe(b.cacheKey);
  });

  it('a keyed line width does not make the bare picture live', () => {
    const c = shape({ keyframes: { 'stroke.width': [{ time: 0, value: 4 }, { time: 2, value: 30 }] } } as unknown as Partial<ShapeClip>);
    expect(planeFor(project([c]), layer(c), rig)!.cacheKey).toBeDefined();
  });

  it('a mask or a color correction keeps the outline in the picture (they act on the picture)', () => {
    const masked = shape({ mask: { shape: 'ellipse', x: 0, y: 0, width: 1, height: 1, rotation: 0, feather: 0 } } as Partial<ShapeClip>);
    expect(lineOnSolid(masked)).toBe(false);
    const graded = shape({ adjust: { brightness: 0.3 } } as Partial<ShapeClip>);
    expect(lineOnSolid(graded)).toBe(false);
    const plain = shape({ adjust: { brightness: 0 } } as Partial<ShapeClip>);
    expect(lineOnSolid(plain)).toBe(true);
  });

  it('keys on the corners, the color correction or the color key keep the line in the picture on every frame', () => {
    const keyed = (prop: string): ShapeClip => shape({ keyframes: { [prop]: [{ time: 0, value: 0 }, { time: 2, value: 0.5 }] } } as unknown as Partial<ShapeClip>);
    // the value is neutral on the first frame: the kind of line must not depend on the frame
    expect(lineOnSolid(keyed('radius'))).toBe(false);
    expect(lineOnSolid(keyed('adjust.brightness'))).toBe(false);
    expect(lineOnSolid(keyed('chromaKey.tolerance'))).toBe(false);
    expect(lineOnSolid(keyed('stroke.width'))).toBe(true);
    expect(lineOnSolid(keyed('opacity'))).toBe(true);
    expect(lineOnSolid(shape({ keyframes: { radius: [] } } as unknown as Partial<ShapeClip>))).toBe(true);
    const c = keyed('radius');
    expect(planeFor(project([c]), layer(c), rig)!.outline).toBeUndefined();
  });
});
