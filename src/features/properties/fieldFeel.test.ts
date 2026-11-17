import { describe, expect, it } from 'vitest';
import type { Clip, ClipType } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import { animProps } from '../../lib/anim';
import { createShapeClip, createTextClip } from '../../lib/factory';
import { EFFECTS } from '../../engine/effects/registry';
import { decimalsOf } from '../../components/ui/sliderMath';
import { ARRANGE_DEFAULTS, ARRANGE_EXTRA_SLIDERS, ARRANGE_SLIDERS } from './arrange3d';
import { FEEL, arrangeFeel, effectFeel, feelCtx, feelOf, resolveFeel, wiggleFeel, type FeelEntry, type FeelKey } from './fieldFeel';

const SIZES: [number, number][] = [
  [640, 360],
  [1920, 1080],
  [1080, 1920],
  [3840, 2160],
];
const KEYS = Object.keys(FEEL) as FeelKey[];
const entry = (k: FeelKey): FeelEntry => FEEL[k];

const base = { trackId: 't', start: 0, duration: 10, name: 'c', fadeIn: 0, fadeOut: 0 };
/** one clip of each type: animProps only looks at the type */
const CLIPS: Record<ClipType, Clip> = {
  video: { ...base, id: 'v', type: 'video', assetId: 'a', trimStart: 0, speed: 1, volume: 1, muted: false, transform: { ...DEFAULT_TRANSFORM } },
  image: { ...base, id: 'i', type: 'image', assetId: 'a', transform: { ...DEFAULT_TRANSFORM } },
  text: createTextClip('t', 0, { duration: 10 }),
  shape: createShapeClip('t', 0, { duration: 10 }),
  audio: { ...base, id: 'a', type: 'audio', assetId: 'a', trimStart: 0, speed: 1, volume: 1, muted: false },
  effect: { ...base, id: 'e', type: 'effect' } as unknown as Clip,
  camera: { ...base, id: 'c', type: 'camera' } as unknown as Clip,
};

describe('fieldFeel table', () => {
  it('every animated prop of every clip type has exactly one entry', () => {
    for (const type of Object.keys(CLIPS) as ClipType[]) {
      for (const info of animProps(CLIPS[type])) {
        const hits = KEYS.filter((k) => {
          const a = entry(k).anim;
          return !!a && a.prop === info.prop && a.types.includes(type);
        });
        expect(hits, `${type} ${info.prop}`).toHaveLength(1);
      }
    }
  });

  it('an entry hard range is the anim.ts range times its scale', () => {
    for (const k of KEYS) {
      const a = entry(k).anim;
      if (!a) continue;
      const scale = entry(k).scale ?? 1;
      for (const type of a.types) {
        const info = animProps(CLIPS[type]).find((p) => p.prop === a.prop);
        expect(info, `${k} on ${type}`).toBeDefined();
        const f = resolveFeel(entry(k), feelCtx(1920, 1080));
        if (info!.min === undefined) expect(f.min, `${k} min`).toBe(-Infinity);
        else expect(f.min, `${k} min`).toBeCloseTo(info!.min * scale, 9);
        if (info!.max === undefined) expect(f.max, `${k} max`).toBe(Infinity);
        else expect(f.max, `${k} max`).toBeCloseTo(info!.max * scale, 9);
      }
    }
    // the bend angle rides the same rule
    expect(feelOf('bendAngle', feelCtx(1920, 1080))).toMatchObject({ min: -360, max: 360, scale: 1 });
  });

  it('every face lies inside its hard range', () => {
    for (const [W, H] of SIZES) {
      for (const k of KEYS) {
        const f = feelOf(k, feelCtx(W, H));
        if (!f.soft) continue;
        expect(f.soft[0], `${k} ${W}x${H}`).toBeGreaterThanOrEqual(f.min);
        expect(f.soft[1], `${k} ${W}x${H}`).toBeLessThanOrEqual(f.max);
        expect(f.soft[1], `${k} ${W}x${H}`).toBeGreaterThan(f.soft[0]);
      }
    }
  });

  it('every rest value lies inside its hard range', () => {
    for (const [W, H] of SIZES) {
      for (const k of KEYS) {
        const f = feelOf(k, feelCtx(W, H));
        if (f.rest === null) continue;
        expect(f.rest, `${k} ${W}x${H}`).toBeGreaterThanOrEqual(f.min);
        expect(f.rest, `${k} ${W}x${H}`).toBeLessThanOrEqual(f.max);
      }
    }
  });

  it('snap is at least the step and a whole multiple of it', () => {
    for (const k of KEYS) {
      const f = feelOf(k, feelCtx(1920, 1080));
      expect(f.snap, k).toBeGreaterThanOrEqual(f.step - 1e-9);
      const r = f.snap / f.step;
      expect(Math.abs(r - Math.round(r)), k).toBeLessThan(1e-6);
    }
  });

  it('precision is enough to show the step', () => {
    for (const k of KEYS) {
      const f = feelOf(k, feelCtx(1920, 1080));
      expect(f.precision, k).toBeGreaterThanOrEqual(decimalsOf(f.step));
    }
  });

  it('pos x follows the canvas', () => {
    const wide = feelOf('x', feelCtx(1920, 1080));
    expect(wide.soft).toEqual([-960, 960]);
    const narrow = feelOf('x', feelCtx(1080, 1920));
    expect(narrow.soft).toEqual([-540, 540]);
    expect(feelOf('y', feelCtx(1080, 1920)).soft).toEqual([-960, 960]);
  });

  it('home based values use the home distance', () => {
    const c = feelCtx(1920, 1080);
    expect(c.home).toBe(1158);
    expect(feelOf('focusDistance', c).rest).toBe(1158);
    expect(feelOf('fogNear', c).rest).toBe(1158);
    expect(feelOf('fogFar', c).rest).toBe(4 * 1158);
    expect(feelOf('z', c).soft).toEqual([-0.75 * 1158, 3 * 1158]);
  });

  it('the bend and pivot entries', () => {
    const c = feelCtx(1920, 1080);
    expect(feelOf('bendAngle', c)).toMatchObject({ unit: 'deg', min: -360, max: 360, soft: [-180, 180], step: 1, snap: 15, rest: 0, scale: 1 });
    expect(feelOf('bendCenter', c)).toMatchObject({ unit: '%', min: -100, max: 100, soft: [-100, 100], snap: 10, rest: 0, scale: 1 });
    expect(feelOf('bendMiddle', c)).toMatchObject({ unit: '%', min: -50, max: 50, soft: [-50, 50], snap: 10, rest: 0, scale: 1 });
    for (const k of ['pivotX', 'pivotY'] as const) {
      expect(feelOf(k, c)).toMatchObject({ unit: '%', min: -1000, max: 1000, soft: [-50, 50], snap: 10, rest: 0, scale: 1 });
      expect(entry(k).anim).toBeUndefined();
    }
    expect(Object.keys(FEEL)).not.toContain('pivotDepth');
  });

  it('an override wins, null included', () => {
    const c = feelCtx(1920, 1080);
    expect(feelOf('fade', c, { max: 4, soft: [0, 4] })).toMatchObject({ max: 4, soft: [0, 4] });
    expect(feelOf('speed', c, { rest: null }).rest).toBeNull();
    expect(feelOf('speed', c, { soft: null }).soft).toBeNull();
    expect(feelOf('counterValue', c, { precision: 3 }).precision).toBe(3);
  });

  it('every effect param gets a valid feel', () => {
    let seen = 0;
    for (const def of EFFECTS) {
      for (const p of def.params) {
        if (p.options) continue;
        seen++;
        const e = effectFeel(p);
        expect(effectFeel(p)).toBe(e);
        const f = resolveFeel(e, feelCtx(1920, 1080));
        expect(f.min).toBe(p.min);
        expect(f.max).toBe(p.max);
        expect(f.soft).toEqual([p.min, p.max]);
        expect(f.step).toBe(p.step);
        expect(f.rest).toBe(p.default);
        expect(p.default).toBeGreaterThanOrEqual(p.min);
        expect(p.default).toBeLessThanOrEqual(p.max);
        const r = f.snap / f.step;
        expect(Math.abs(r - Math.round(r))).toBeLessThan(1e-6);
        expect(f.snap).toBeGreaterThanOrEqual(f.step);
        if (f.snap !== f.step) expect(f.snap).toBeLessThanOrEqual((p.max - p.min) / 2);
      }
    }
    expect(seen).toBeGreaterThan(20);
  });

  it('arrange sliders keep their ranges and rest on ARRANGE_DEFAULTS', () => {
    const all = [...Object.values(ARRANGE_SLIDERS), ...Object.values(ARRANGE_EXTRA_SLIDERS)];
    expect(all.length).toBeGreaterThan(10);
    for (const s of all) {
      const f = resolveFeel(arrangeFeel(s), feelCtx(1920, 1080));
      expect(f.min).toBe(s.min);
      expect(f.max).toBe(s.max);
      expect(f.soft).toEqual([s.min, s.max]);
      expect(f.step).toBe(s.step);
      expect(f.rest).toBe(ARRANGE_DEFAULTS[s.key]);
      expect(f.unit).toBe(s.suffix);
    }
  });

  it('wiggleFeel steps by a tenth of the default, rounded down to a power of ten', () => {
    expect(wiggleFeel(0.1).step).toBe(0.01);
    expect(wiggleFeel(20).step).toBe(1);
    expect(wiggleFeel(5).step).toBe(0.1);
    expect(wiggleFeel(99.6).step).toBe(1);
    expect(wiggleFeel(0).step).toBe(1);
    const f = resolveFeel(wiggleFeel(20), feelCtx(1920, 1080));
    expect(f).toMatchObject({ min: 0, soft: [0, 80], rest: 20 });
  });
});
