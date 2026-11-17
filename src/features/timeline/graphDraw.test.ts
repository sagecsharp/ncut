import { describe, expect, it } from 'vitest';
import type { Clip, Easing, Keyframe } from '../../types';
import { drawGraph, selKey } from './graphDraw';
import type { GraphFrame } from './graphDraw';
import type { GraphHitIndex, GraphLine } from './graphModel';

/** a context that only counts the calls it gets */
function recorder(): { ctx: CanvasRenderingContext2D; calls: Record<string, number> } {
  const calls: Record<string, number> = {};
  const ctx = new Proxy({} as Record<string, unknown>, {
    get: (_t, name) =>
      typeof name === 'string'
        ? () => {
            calls[name] = (calls[name] ?? 0) + 1;
          }
        : undefined,
    set: () => true,
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

const hitsOf = (): GraphHitIndex => ({ kx: new Float32Array(0), ky: new Float32Array(0), kref: [], kn: 99, hx: new Float32Array(0), hy: new Float32Array(0), href: [], hn: 99 });

const FEEL = { scale: 1, unit: '', min: -Infinity, max: Infinity, soft: null, step: 0.01, precision: 2, snap: 0.1, perPx: 0.0025, rest: null, origin: null };

function lineOf(keys: Keyframe[], over: Partial<GraphLine> = {}): GraphLine {
  return {
    id: 'c1\u0000x', clip: { id: 'c1', type: 'image' } as unknown as Clip, clipId: 'c1', prop: 'x', label: 'x', clipName: 'clip', color: '--graph-red', dash: [], group: 'g',
    feel: FEEL, int: false, range: undefined, limits: { min: -Infinity, max: Infinity }, keys, start: 0, duration: 1000, ...over,
  };
}

const lin = (n: number, ease: Easing = 'linear'): Keyframe[] => Array.from({ length: n }, (_, i) => ({ t: i, v: (i % 7) * 3, ease }));

function frameOf(lines: GraphLine[], over: Partial<GraphFrame> = {}): GraphFrame {
  return {
    lines, kind: 'value', windows: { g: { lo: -5, hi: 25 } }, vp: { zoom: 10, scrollLeft: 0, width: 100, height: 120 }, dpr: 1,
    active: null, hover: null, sel: new Set(), range: null, snapY: null, box: null, handlesOff: false, ...over,
  };
}

const css = (t: string): string => t;

describe('graphDraw', () => {
  it('only parts in view are walked', () => {
    const { ctx } = recorder();
    // 1000 keys one second apart, 10 px per second: the plot shows 10 s of them
    const line = lineOf(lin(1000));
    const hits = hitsOf();
    const { segments } = drawGraph(ctx, frameOf([line], { vp: { zoom: 10, scrollLeft: 3000, width: 100, height: 120 } }), css, hits);
    expect(segments).toBeGreaterThanOrEqual(9);
    expect(segments).toBeLessThanOrEqual(13);
    expect(hits.kn).toBeLessThanOrEqual(14);
    expect(hits.kn).toBeGreaterThanOrEqual(9);
  });

  it('one bezierCurveTo per in range part', () => {
    const { ctx, calls } = recorder();
    const keys: Keyframe[] = [
      { t: 0, v: 0, ease: 'linear' },
      { t: 1, v: 5, ease: 'ease' },
      { t: 2, v: 2, ease: 'ease-in' },
      { t: 3, v: 8, ease: 'bezier', out: { speed: 1, influence: 0.3 } },
      { t: 4, v: 4, ease: 'back', in: { speed: 1, influence: 0.3 } },
      { t: 5, v: 9, ease: 'ease-out' },
    ];
    const line = lineOf(keys, { range: { lo: 0, hi: 10 } });
    const { segments } = drawGraph(ctx, frameOf([line]), css, hitsOf());
    expect(segments).toBe(5);
    expect(calls.bezierCurveTo).toBe(5);
    // no range: a custom part is exact as well
    const free = recorder();
    drawGraph(free.ctx, frameOf([lineOf(keys)]), css, hitsOf());
    expect(free.calls.bezierCurveTo).toBe(5);
  });

  it('bounce, elastic, int and clamped parts are lineTo', () => {
    const wavy: Keyframe[] = [{ t: 0, v: 0, ease: 'bounce' }, { t: 3, v: 10, ease: 'elastic' }, { t: 6, v: 0, ease: 'linear' }, { t: 9, v: 5, ease: 'linear' }];
    for (const line of [lineOf(wavy.slice(0, 3)), lineOf(lin(6), { int: true })]) {
      const r = recorder();
      drawGraph(r.ctx, frameOf([line]), css, hitsOf());
      expect(r.calls.bezierCurveTo ?? 0).toBe(0);
      expect(r.calls.lineTo).toBeGreaterThan(10);
    }
    // a custom part whose control values leave the range is sampled
    const clamped: Keyframe[] = [{ t: 0, v: 0, ease: 'bezier', out: { speed: 50, influence: 0.5 } }, { t: 4, v: 1, ease: 'linear', in: { speed: 0, influence: 0.5 } }];
    const r = recorder();
    drawGraph(r.ctx, frameOf([lineOf(clamped, { range: { lo: 0, hi: 1 } })]), css, hitsOf());
    expect(r.calls.bezierCurveTo ?? 0).toBe(0);
    expect(r.calls.lineTo).toBeGreaterThan(10);
  });

  it('the speed graph samples, no bezierCurveTo', () => {
    const { ctx, calls } = recorder();
    const { segments } = drawGraph(ctx, frameOf([lineOf(lin(6, 'ease'))], { kind: 'speed' }), css, hitsOf());
    expect(segments).toBe(5);
    expect(calls.bezierCurveTo ?? 0).toBe(0);
    expect(calls.lineTo).toBeGreaterThan(20);
  });

  it('handles only on selected keys, at most 200', () => {
    const line = lineOf(lin(300), { duration: 300 });
    const wide = { zoom: 10, scrollLeft: 0, width: 3200, height: 120 };
    const pick = (idx: number[]) => new Set(idx.map((i) => selKey(line.id, i)));
    // nothing selected: keys, no handles
    const none = hitsOf();
    drawGraph(recorder().ctx, frameOf([line], { vp: wide }), css, none);
    expect(none.kn).toBe(300);
    expect(none.hn).toBe(0);
    // three inside keys: two sides each
    const three = hitsOf();
    drawGraph(recorder().ctx, frameOf([line], { vp: wide, sel: pick([10, 20, 30]) }), css, three);
    expect(three.hn).toBe(6);
    // every key selected: the first 200 keys get handles
    const all = hitsOf();
    drawGraph(recorder().ctx, frameOf([line], { vp: wide, sel: pick(Array.from({ length: 300 }, (_, i) => i)) }), css, all);
    expect(all.hn).toBeGreaterThan(0);
    expect(all.hn).toBeLessThanOrEqual(400);
    // handles off
    const off = hitsOf();
    drawGraph(recorder().ctx, frameOf([line], { vp: wide, sel: pick([10, 20, 30]), handlesOff: true }), css, off);
    expect(off.hn).toBe(0);
  });

  it('hits are filled in the same walk', () => {
    const line = lineOf(lin(20), { duration: 20 });
    const hits = hitsOf();
    drawGraph(recorder().ctx, frameOf([line], { vp: { zoom: 10, scrollLeft: 0, width: 400, height: 120 }, sel: new Set([selKey(line.id, 5)]) }), css, hits);
    // the counts start over each frame
    expect(hits.kn).toBe(20);
    expect(hits.kref.length).toBe(20);
    expect(hits.kref[5]).toMatchObject({ clipId: 'c1', prop: 'x', t: 5 });
    expect(hits.hn).toBe(2);
    expect(hits.href.length).toBe(2);
    expect(hits.href.map((h) => h.side).sort()).toEqual(['in', 'out']);
    expect(hits.href[0]!.ref.t).toBe(5);
    expect(hits.kx.length).toBeGreaterThanOrEqual(20);
  });
});
