import { describe, expect, it } from 'vitest';
import { SHAPE_KINDS } from '../../types';
import { SHAPES_3D } from '../../types';
import { SHAPE_PRESETS, fitPreview, solidOf, solidSilhouette } from './shapePresets';

const byId = (id: string) => SHAPE_PRESETS.find((p) => p.id === id)!;

describe('shape presets', () => {
  it('has unique ids and labels', () => {
    expect(new Set(SHAPE_PRESETS.map((p) => p.id)).size).toBe(SHAPE_PRESETS.length);
    expect(new Set(SHAPE_PRESETS.map((p) => p.label)).size).toBe(SHAPE_PRESETS.length);
  });
  it('names the clip after the label and uses real kinds', () => {
    for (const p of SHAPE_PRESETS) {
      const b = p.build(1920, 1080);
      expect(b.name).toBe(p.label);
      expect(SHAPE_KINDS).toContain(b.kind);
      expect(b.width).toBeGreaterThan(0);
      expect(b.height).toBeGreaterThan(0);
    }
  });
  it('makes a circle with equal sides and a hexagon from a polygon', () => {
    const c = byId('circle').build(1920, 1080);
    expect(c.kind).toBe('ellipse');
    expect(c.width).toBe(c.height);
    const h = byId('hexagon').build(1920, 1080);
    expect(h).toMatchObject({ kind: 'polygon', points: 6 });
  });
  it('rounds the rounded rectangle by 0.25 and outlines the outline card', () => {
    expect(byId('rounded').build(1, 1).radius).toBe(0.25);
    const o = byId('outline').build(1, 1);
    expect(o.filled).toBe(false);
    expect(o.stroke?.width).toBeGreaterThan(0);
  });
  it('makes the line a wide thin bar', () => {
    const l = byId('line').build(1, 1);
    expect(l.kind).toBe('line');
    expect(l.width).toBe(600);
    expect(l.height).toBe(12);
  });
  it('sizes the backgrounds from the canvas passed at use time', () => {
    const g = byId('background').build(1080, 1920);
    expect(g).toMatchObject({ kind: 'rect', width: 1080, height: 1920 });
    expect(g.color).toBeTruthy();
    expect(g.color2).toBeTruthy();
    expect(g.color).not.toBe(g.color2);
    const s = byId('solid-background').build(1280, 720);
    expect(s).toMatchObject({ width: 1280, height: 720 });
    expect(s.color2).toBeUndefined();
  });
  it('never returns a zero sized background', () => {
    expect(byId('background').build(0, 0)).toMatchObject({ width: 1, height: 1 });
  });
});

describe('draw on cards', () => {
  it('draws the circle on as an outline only', () => {
    const c = byId('drawn-circle').build(1920, 1080);
    expect(c).toMatchObject({ kind: 'ellipse', filled: false });
    expect(c.stroke?.width).toBeGreaterThan(0);
    expect(c.keyframes!.drawEnd!.map((k) => [k.t, k.v])).toEqual([[0, 0], [1, 1]]);
  });
  it('draws the underline and the arrow on, from nothing to whole', () => {
    for (const [id, kind] of [['drawn-underline', 'line'], ['drawn-arrow', 'arrow']] as const) {
      const b = byId(id).build(1, 1);
      expect(b.kind).toBe(kind);
      const keys = b.keyframes!.drawEnd!;
      expect(keys[0]).toMatchObject({ t: 0, v: 0 });
      expect(keys[keys.length - 1]).toMatchObject({ v: 1 });
    }
  });
  it('gives every build its own keys', () => {
    expect(byId('drawn-circle').build(1, 1).keyframes).not.toBe(byId('drawn-circle').build(1, 1).keyframes);
  });
});

describe('fitPreview', () => {
  it('keeps the ratio inside the box', () => {
    const b = fitPreview(600, 300, 96, 40);
    expect(b.w / b.h).toBeCloseTo(2);
    expect(b.w).toBeLessThanOrEqual(96);
    expect(b.h).toBeLessThanOrEqual(40);
  });
  it('keeps thin shapes visible', () => {
    expect(fitPreview(600, 12, 96, 40).h).toBeGreaterThanOrEqual(3);
  });
  it('survives zero sizes', () => {
    const b = fitPreview(0, 0, 96, 40);
    expect(Number.isFinite(b.w) && Number.isFinite(b.h)).toBe(true);
  });
});

describe('3d solid presets', () => {
  it('make 3d clips on the new shapes with plain names', () => {
    const want: [string, string][] = [['cone', 'cone'], ['pyramid', 'pyramid'], ['ring', 'torus']];
    for (const [id, shape] of want) {
      const b = byId(id).build(1920, 1080);
      expect(b).toMatchObject({ name: id, threeD: true, shape });
      expect(SHAPES_3D).toContain(b.shape);
      expect(solidOf(byId(id))).toBe(shape);
    }
  });
  it('the five outline and tube solids have a size, a thickness and keep the figure undistorted', () => {
    const want: [string, string][] = [['capsule', 'capsule'], ['prism', 'prism'], ['hexagon-3d', 'hexagon'], ['star-3d', 'star'], ['heart-3d', 'heart']];
    for (const [id, shape] of want) {
      const b = byId(id).build(1920, 1080);
      expect(b).toMatchObject({ threeD: true, shape, kind: 'rect' });
      expect(b.width).toBeGreaterThan(0);
      expect(b.height).toBeGreaterThan(0);
      expect(b.shapeDepth).toBeGreaterThan(0);
      expect(solidOf(byId(id))).toBe(shape);
      expect(b.transform!.rotY).not.toBe(0);
    }
    // a regular hexagon is 0.866 as wide as tall, an equilateral prism triangle 1.155 as wide as tall
    const hex = byId('hexagon-3d').build(1, 1);
    expect(hex.width! / hex.height!).toBeCloseTo(0.866, 1);
    const pr = byId('prism').build(1, 1);
    expect(pr.width! / pr.height!).toBeCloseTo(1.155, 1);
  });
  it('card ids stay unique', () => {
    const ids = SHAPE_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('keep a full transform with a little tilt', () => {
    const tr = byId('cone').build(1, 1).transform!;
    expect(tr).toMatchObject({ x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 });
    expect(tr.rotX).not.toBe(0);
    expect(tr.rotY).not.toBe(0);
  });
  it('leave the flat cards flat', () => {
    for (const id of ['rectangle', 'circle', 'background']) expect(solidOf(byId(id))).toBeNull();
  });
  it('have a silhouette for every 3d shape that stays inside the unit box', () => {
    for (const shape of SHAPES_3D) {
      const parts = solidSilhouette(shape);
      expect(parts.length).toBeGreaterThan(0);
      for (const p of parts) {
        const pts = p.kind === 'poly' ? p.pts.flat() : [p.cx - p.rx, p.cx + p.rx, p.cy - p.ry, p.cy + p.ry];
        for (const v of pts) expect(Math.abs(v)).toBeLessThanOrEqual(0.5);
      }
    }
    expect(solidSilhouette('torus').some((p) => p.kind === 'ellipse' && p.hole)).toBe(true);
  });
});
