import { describe, expect, it } from 'vitest';
import { SHAPE_KINDS } from '../../types';
import { SHAPE_PRESETS, fitPreview } from './shapePresets';

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
