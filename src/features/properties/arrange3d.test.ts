import { describe, expect, it } from 'vitest';
import { ARRANGE_SLIDERS, arrange, arrangeTargets, wrapDegrees } from './arrange3d';
import type { ArrangeKind } from './arrange3d';
import type { Clip, Project } from '../../types';

const KINDS: ArrangeKind[] = ['ring', 'row', 'stack', 'fan', 'grid', 'spiral', 'sphere', 'scatter', 'wave', 'stairs'];
const flat = { x: 0, y: 0, z: 0, rotY: 0, rotation: 0 };

describe('arrange', () => {
  it('gives one pose per clip, none for zero', () => {
    for (const k of KINDS) {
      expect(arrange(k, 0)).toEqual([]);
      for (const n of [1, 2, 5, 9]) expect(arrange(k, n)).toHaveLength(n);
    }
  });
  it('a single clip is centered and flat', () => {
    for (const k of KINDS) expect(arrange(k, 1)).toEqual([flat]);
  });
  it('ring: first clip in front, evenly spaced, facing outward', () => {
    const p = arrange('ring', 4, { radius: 100 });
    expect(p[0]).toEqual(flat);
    expect(p[1]).toMatchObject({ x: 100, z: 100, rotY: 90 });
    expect(p[2]).toMatchObject({ x: 0, z: 200, rotY: 180 });
    expect(p[3]).toMatchObject({ x: -100, z: 100, rotY: -90 });
  });
  it('ring: inward turns every clip half a turn', () => {
    const out = arrange('ring', 4, { radius: 100 });
    const inn = arrange('ring', 4, { radius: 100, outward: false });
    expect(inn[0]!.rotY).toBe(180);
    expect(inn[1]!.rotY).toBe(-90);
    expect(inn[2]!.rotY).toBe(0);
    for (let i = 0; i < 4; i++) expect(inn[i]!.x).toBe(out[i]!.x);
  });
  it('ring: every clip is the radius away from the middle and the x are symmetric', () => {
    const p = arrange('ring', 7, { radius: 250 });
    for (const q of p) expect(Math.hypot(q.x, q.z - 250)).toBeCloseTo(250, 1);
    expect(p.reduce((s, q) => s + q.x, 0)).toBeCloseTo(0, 1);
  });
  it('row: equal gaps, centered', () => {
    const p = arrange('row', 4, { gap: 20, itemW: 100 });
    expect(p.map((q) => q.x)).toEqual([-180, -60, 60, 180]);
    expect(p[1]!.x - p[0]!.x).toBe(120);
    expect(p.every((q) => q.y === 0 && q.z === 0)).toBe(true);
  });
  it('stack: z steps by the slider, offsets are centered', () => {
    const p = arrange('stack', 3, { depthGap: 50 });
    expect(p.map((q) => q.z)).toEqual([0, 50, 100]);
    expect(p[0]!.x + p[2]!.x).toBe(0);
    expect(p[1]!.x).toBe(0);
  });
  it('fan: symmetric, spread is the angle from first to last', () => {
    const p = arrange('fan', 5, { spread: 80 });
    expect(p[0]!.rotation).toBe(-40);
    expect(p[4]!.rotation).toBe(40);
    expect(p[2]).toMatchObject({ x: 0, y: 0, rotation: 0 });
    expect(p[0]!.x).toBeCloseTo(-p[4]!.x, 1);
    expect(p[0]!.y).toBeCloseTo(p[4]!.y, 1);
    expect(p[0]!.y).toBeGreaterThan(0); // the ends dip below the middle
  });
  it('grid: columns = ceil(sqrt(n)), centered, gap between cells', () => {
    const p = arrange('grid', 4, { gap: 10, itemW: 90, itemH: 40 });
    expect(p.map((q) => [q.x, q.y])).toEqual([[-50, -25], [50, -25], [-50, 25], [50, 25]]);
    const q = arrange('grid', 5, { gap: 0, itemW: 100, itemH: 100 });
    // 3 columns, 2 rows; the last row of 2 is centered
    expect(q.slice(0, 3).map((c) => c.x)).toEqual([-100, 0, 100]);
    expect(q.slice(3).map((c) => c.x)).toEqual([-50, 50]);
  });
  it('spiral: climbs and recedes with every clip', () => {
    const p = arrange('spiral', 6, { radius: 300 });
    for (let i = 1; i < 6; i++) expect(p[i]!.y).toBeLessThan(p[i - 1]!.y);
    expect(p[5]!.z).toBeGreaterThan(p[1]!.z);
    expect(p[0]!.rotY).toBe(0);
  });
  it('every layout has a slider', () => {
    for (const k of KINDS) expect(ARRANGE_SLIDERS[k].max).toBeGreaterThan(ARRANGE_SLIDERS[k].min);
  });
});

describe('new layouts', () => {
  const NEW: ArrangeKind[] = ['sphere', 'scatter', 'wave', 'stairs'];
  it('no NaN for any count, and the same input gives the same poses', () => {
    for (const k of NEW) {
      for (const n of [1, 2, 3, 7, 40, 200]) {
        const a = arrange(k, n, { itemW: 100, itemH: 80 });
        expect(a).toEqual(arrange(k, n, { itemW: 100, itemH: 80 }));
        for (const q of a) for (const v of Object.values(q)) expect(Number.isFinite(v)).toBe(true);
      }
    }
  });
  it('sphere: every clip is the radius from the middle and faces outward', () => {
    const p = arrange('sphere', 30, { radius: 300 });
    for (const q of p) {
      expect(Math.hypot(q.x, q.y, q.z - 300)).toBeCloseTo(300, 0);
      // the front face points along (sin rotY cos rotX, -sin rotX, -cos rotY cos rotX)
      const rx = (q.rotX! * Math.PI) / 180;
      const ry = (q.rotY * Math.PI) / 180;
      const f = [Math.sin(ry) * Math.cos(rx), -Math.sin(rx), -Math.cos(ry) * Math.cos(rx)];
      expect(f[0]! * q.x + f[1]! * q.y + f[2]! * (q.z - 300)).toBeCloseTo(300, 0);
    }
    expect(Math.min(...p.map((q) => q.y))).toBeLessThan(0);
    expect(Math.max(...p.map((q) => q.y))).toBeGreaterThan(0);
  });
  it('sphere: spread evenly, the first clip is at the top front', () => {
    const p = arrange('sphere', 4, { radius: 100 });
    expect(p[0]!.x).toBeCloseTo(0, 1);
    expect(p[0]!.y).toBeLessThan(0);
  });
  it('scatter: the seed changes it, stays inside the box and never behind the canvas plane', () => {
    const a = arrange('scatter', 20, { seed: 1, radius: 400 });
    const b = arrange('scatter', 20, { seed: 2, radius: 400 });
    expect(a).not.toEqual(b);
    for (const q of [...a, ...b]) {
      expect(q.z).toBeGreaterThanOrEqual(0);
      expect(Math.abs(q.x)).toBeLessThanOrEqual(600);
      expect(Math.abs(q.y)).toBeLessThanOrEqual(320);
      expect(q.z).toBeLessThanOrEqual(600);
    }
  });
  it('wave: a row whose y and z follow a sine, centered', () => {
    const p = arrange('wave', 5, { gap: 10, itemW: 90, amplitude: 100 });
    expect(p.map((q) => q.x)).toEqual([-200, -100, 0, 100, 200]);
    expect(p[2]).toMatchObject({ y: 0, z: 0 });
    expect(p.some((q) => q.y !== 0)).toBe(true);
    expect(p.every((q) => q.z >= 0)).toBe(true);
    expect(arrange('wave', 5, { amplitude: 0 }).every((q) => q.y === 0 && q.z === 0)).toBe(true);
  });
  it('stairs: each clip a step up and back', () => {
    const p = arrange('stairs', 4, { step: 100 });
    for (let i = 1; i < 4; i++) {
      expect(p[i]!.z - p[i - 1]!.z).toBe(100);
      expect(p[i]!.y).toBeLessThan(p[i - 1]!.y);
    }
    expect(p[0]!.y + p[3]!.y).toBe(0);
  });
});

describe('wrapDegrees', () => {
  it('keeps angles in (-180, 180]', () => {
    expect(wrapDegrees(270)).toBe(-90);
    expect(wrapDegrees(-180)).toBe(180);
    expect(wrapDegrees(540)).toBe(180);
  });
});

const clip = (id: string, trackId: string, start: number, extra: object = {}) =>
  ({ id, type: 'shape', trackId, start, duration: 1, ...extra }) as unknown as Clip;

describe('arrangeTargets', () => {
  const project = {
    tracks: [{ id: 't1', locked: false }, { id: 't2', locked: false }, { id: 't3', locked: true }],
    clips: [
      clip('a', 't2', 0),
      clip('b', 't1', 5),
      clip('c', 't1', 1),
      clip('d', 't1', 2, { parent: 'a' }),
      clip('e', 't3', 0),
      { id: 'au', type: 'audio', trackId: 't1', start: 0, duration: 1 } as unknown as Clip,
    ],
  } as unknown as Pick<Project, 'clips' | 'tracks'>;
  it('orders by track (top first) then start, and leaves attached and locked clips out', () => {
    const r = arrangeTargets(project, ['a', 'b', 'c', 'd', 'e', 'au']);
    expect(r.clips.map((c) => c.id)).toEqual(['c', 'b', 'a']);
    expect(r.skipped).toBe(2);
  });
});
