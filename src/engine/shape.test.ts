import { describe, expect, it } from 'vitest';
import { createShapeClip } from '../lib/factory';
import type { ShapeClip } from '../types';
import { drawShape, shapeOutline, shapeSignature } from './shape';

const shape = (o: Partial<ShapeClip> = {}): ShapeClip => createShapeClip('t', 0, { width: 100, height: 60, ...o });

/** records the canvas calls drawShape makes */
function fakeCtx() {
  const log: string[] = [];
  const pts: number[] = [];
  const target: Record<string, unknown> = {};
  const ctx = new Proxy(target, {
    get(t, k: string) {
      if (k in t) return t[k];
      return (...a: number[]) => {
        log.push(k);
        if (k === 'moveTo' || k === 'lineTo') pts.push(a[0]!, a[1]!);
      };
    },
    set(t, k: string, v) {
      t[k] = v;
      log.push('set:' + k + '=' + String(v));
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, log, pts };
}

describe('shapeOutline', () => {
  it('measures a rect and an ellipse', () => {
    expect(shapeOutline(shape({ kind: 'rect' }), 100, 60).length).toBeCloseTo(320, 6);
    const e = shapeOutline(shape({ kind: 'ellipse' }), 100, 100);
    expect(e.length).toBeGreaterThan(Math.PI * 100 * 0.999);
    expect(e.length).toBeLessThan(Math.PI * 100 + 1e-6);
    expect(e.closed).toBe(true);
  });
  it('rounds the corners of a rect (shorter than the square one)', () => {
    const sq = shapeOutline(shape({ kind: 'rect' }), 100, 60, 0).length;
    const rd = shapeOutline(shape({ kind: 'rect' }), 100, 60, 0.5).length;
    expect(rd).toBeLessThan(sq);
    expect(rd).toBeGreaterThan(sq - 8 * 30);
  });
  it('a line and an arrow are their center line', () => {
    expect(shapeOutline(shape({ kind: 'line' }), 600, 12).length).toBe(600);
    expect(shapeOutline(shape({ kind: 'arrow' }), 600, 200).length).toBe(600);
  });
  it('traces a triangle, polygon, star and heart', () => {
    expect(shapeOutline(shape({ kind: 'triangle' }), 100, 100).length).toBeGreaterThan(0);
    expect(shapeOutline(shape({ kind: 'polygon', points: 4 }), 100, 100).length).toBeCloseTo(4 * Math.hypot(50, 50), 6);
    expect(shapeOutline(shape({ kind: 'star' }), 100, 100).length).toBeGreaterThan(0);
    expect(shapeOutline(shape({ kind: 'heart' }), 100, 100).length).toBeGreaterThan(200);
  });
});

describe('drawShape draw on', () => {
  const outlined = (o: Partial<ShapeClip> = {}) => shape({ kind: 'rect', filled: false, stroke: { color: '#fff', width: 4 }, ...o });

  it('draws exactly as before when everything is drawn', () => {
    const a = fakeCtx();
    const b = fakeCtx();
    drawShape(a.ctx, outlined(), 100, 60, 1);
    drawShape(b.ctx, outlined({ drawStart: 0, drawEnd: 1 }), 100, 60, 1);
    expect(b.log).toEqual(a.log);
    expect(a.log).toContain('rect');
    expect(a.log).toContain('stroke');
  });
  it('strokes a trimmed polyline with round caps', () => {
    const f = fakeCtx();
    drawShape(f.ctx, outlined({ drawEnd: 0.25 }), 100, 60, 2);
    expect(f.log).not.toContain('rect');
    expect(f.log).toContain('set:lineCap=round');
    expect(f.log).toContain('set:lineWidth=8');
    expect(f.log).toContain('stroke');
    expect(f.log[f.log.length - 1]).toBe('set:lineCap=butt');
    // a quarter of 320 = 80 along the top edge, which starts at its top left corner
    expect(f.pts).toEqual([-50, -30, 30, -30]);
  });
  it('draws nothing of the outline when the range is empty, the fill stays whole', () => {
    const f = fakeCtx();
    drawShape(f.ctx, shape({ kind: 'rect', stroke: { color: '#fff', width: 4 }, drawEnd: 0 }), 100, 60, 1);
    expect(f.log).toContain('fill');
    expect(f.log).not.toContain('stroke');
  });
  it('grows a line from its start', () => {
    const f = fakeCtx();
    drawShape(f.ctx, shape({ kind: 'line', drawEnd: 0.5 }), 600, 12, 1);
    expect(f.log).toContain('rect');
    expect(f.log).toContain('fill');
    const none = fakeCtx();
    drawShape(none.ctx, shape({ kind: 'line', drawEnd: 0 }), 600, 12, 1);
    expect(none.log).not.toContain('fill');
  });
  it('keeps the arrow head at the drawn end and draws nothing at 0', () => {
    const f = fakeCtx();
    drawShape(f.ctx, shape({ kind: 'arrow', drawEnd: 0.5 }), 600, 200, 1);
    // moveTo (start), 3 lineTo, then the tip: the 4th point is at -300 + 300 = 0
    expect(f.pts[0]).toBe(-300);
    expect(f.pts[6]).toBe(0);
    expect(f.pts[7]).toBe(0);
    const none = fakeCtx();
    drawShape(none.ctx, shape({ kind: 'arrow', drawEnd: 0 }), 600, 200, 1);
    expect(none.log).not.toContain('fill');
  });
});

describe('shapeSignature', () => {
  it('changes with the draw range', () => {
    const a = shapeSignature(shape());
    expect(shapeSignature(shape({ drawEnd: 0.5 }))).not.toBe(a);
    expect(shapeSignature(shape({ drawStart: 0.2 }))).not.toBe(a);
    expect(shapeSignature(shape({ drawStart: 0, drawEnd: 1 }))).toBe(a);
  });
});
