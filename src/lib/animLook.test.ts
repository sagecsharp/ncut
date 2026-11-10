import { describe, expect, it } from 'vitest';
import type { Clip, Keyframe, ShapeClip, TextClip, VideoClip, ImageClip } from '../types';
import { DEFAULT_TRANSFORM } from '../types';
import { createShapeClip, createTextClip } from './factory';
import {
  animProps,
  animatesPicture,
  baseValue,
  canKey,
  isSeedable,
  rawClipOf,
  resolveClip,
  valueAt,
  withBaseValue,
  withKeyAt,
  withValueAt,
  withoutKeyAt,
} from './anim';

const base = { trackId: 't', start: 2, duration: 10, name: 'c', fadeIn: 0, fadeOut: 0 };
const video = (o: Partial<VideoClip> = {}): VideoClip => ({
  ...base,
  id: 'v',
  type: 'video',
  assetId: 'a',
  trimStart: 0,
  speed: 1,
  volume: 1,
  muted: false,
  transform: { ...DEFAULT_TRANSFORM },
  ...o,
});
const image = (o: Partial<ImageClip> = {}): ImageClip => ({ ...base, id: 'i', type: 'image', assetId: 'a', transform: { ...DEFAULT_TRANSFORM }, ...o });
const text = (o: Partial<TextClip> = {}): TextClip => createTextClip('t', 2, { duration: 10, ...o });
const shape = (o: Partial<ShapeClip> = {}): ShapeClip => createShapeClip('t', 2, { duration: 10, ...o });
const k = (t: number, v: number, ease: Keyframe['ease'] = 'linear'): Keyframe => ({ t, v, ease });

/** one row per look property: the clip it is on, a clip that has its parent object, the neutral base, a value in range, the range */
interface Row {
  prop: string;
  on: 'video' | 'image' | 'text' | 'shape';
  /** the clip with its parent object (undefined = the property has no parent object) */
  withParent?: Partial<Clip>;
  /** the clip without the parent: 'neutral' = the neutral value is there, 'none' = not animatable */
  missing: 'neutral' | 'none' | 'n/a';
  neutral?: number;
  to: number;
  range: [number, number];
}

const MASK = { shape: 'rect', x: 0.1, y: 0.2, width: 0.5, height: 0.6, rotation: 10, feather: 0.1, invert: false } as const;
const KEY = { color: '#00d000', tolerance: 0.3, softness: 0.2, spill: 0.1 };
const ROWS: Row[] = [];
for (const on of ['video', 'image', 'text', 'shape'] as const) {
  ROWS.push({ prop: 'radius', on, missing: 'n/a', neutral: 0, to: 0.8, range: [0, 1] });
  for (const e of ['left', 'top', 'right', 'bottom']) ROWS.push({ prop: 'crop.' + e, on, missing: 'neutral', neutral: 0, to: 0.4, range: [0, 0.95] });
  for (const [a, lo, hi] of [['brightness', -1, 1], ['contrast', -1, 1], ['saturation', -1, 1], ['temperature', -1, 1], ['hue', -180, 180]] as const) {
    ROWS.push({ prop: 'adjust.' + a, on, missing: 'neutral', neutral: 0, to: 0.5, range: [lo, hi] });
  }
  for (const a of ['tolerance', 'softness', 'spill']) ROWS.push({ prop: 'chromaKey.' + a, on, withParent: { chromaKey: KEY } as Partial<Clip>, missing: 'none', to: 0.7, range: [0, 1] });
  for (const [a, lo, hi] of [['x', -1, 1], ['y', -1, 1], ['width', 0, 2], ['height', 0, 2], ['rotation', -180, 180], ['feather', 0, 1]] as const) {
    ROWS.push({ prop: 'mask.' + a, on, withParent: { mask: MASK } as Partial<Clip>, missing: 'none', to: 0.5, range: [lo, hi] });
  }
  ROWS.push({ prop: 'mask.radius', on, withParent: { mask: MASK } as Partial<Clip>, missing: 'none', neutral: 0, to: 0.5, range: [0, 1] });
  ROWS.push({ prop: 'shapeDepth', on, missing: 'n/a', to: 300, range: [1, 10000] });
}
const TXT = { color: '#000', width: 0.08 };
const textRows: Row[] = [
  { prop: 'fontSize', on: 'text', missing: 'n/a', neutral: 80, to: 120, range: [4, 1000] },
  { prop: 'letterSpacing', on: 'text', missing: 'n/a', neutral: 0, to: 0.5, range: [-0.5, 2] },
  { prop: 'lineHeight', on: 'text', missing: 'n/a', neutral: 1.25, to: 2, range: [0.5, 3] },
  { prop: 'stroke.width', on: 'text', withParent: { stroke: TXT }, missing: 'none', to: 0.2, range: [0.01, 0.5] },
  { prop: 'stroke2.width', on: 'text', withParent: { stroke2: TXT }, missing: 'none', to: 0.2, range: [0.01, 0.5] },
  ...(['opacity', 'blur', 'distance'] as const).map((a): Row => ({ prop: 'shadow.' + a, on: 'text', withParent: { shadow: { color: '#000', opacity: 0.6, blur: 0.1, distance: 0.08, angle: 45 } }, missing: 'none', to: 0.5, range: [0, 1] })),
  { prop: 'shadow.angle', on: 'text', withParent: { shadow: { color: '#000', opacity: 0.6, blur: 0.1, distance: 0.08, angle: 45 } }, missing: 'none', to: 90, range: [-360, 360] },
  { prop: 'extrude.depth', on: 'text', withParent: { extrude: { depth: 0.2, angle: 135, color: '#555' } }, missing: 'none', to: 0.5, range: [0.01, 1] },
  { prop: 'extrude.angle', on: 'text', withParent: { extrude: { depth: 0.2, angle: 135, color: '#555' } }, missing: 'none', to: 90, range: [0, 360] },
  { prop: 'gradient.angle', on: 'text', withParent: { gradient: { from: '#fff', to: '#000', angle: 0 } }, missing: 'none', to: 90, range: [-360, 360] },
  { prop: 'curve', on: 'text', missing: 'n/a', neutral: 0, to: 90, range: [-360, 360] },
  { prop: 'wrapWidth', on: 'text', missing: 'n/a', neutral: 0, to: 400, range: [0, 20000] },
  { prop: 'backgroundRadius', on: 'text', missing: 'n/a', neutral: 0, to: 0.5, range: [0, 1] },
  { prop: 'backgroundPadding', on: 'text', missing: 'n/a', neutral: 0.3, to: 0.6, range: [0, 2] },
];
const shapeRows: Row[] = [
  { prop: 'width', on: 'shape', missing: 'n/a', to: 600, range: [1, 20000] },
  { prop: 'height', on: 'shape', missing: 'n/a', to: 600, range: [1, 20000] },
  { prop: 'points', on: 'shape', missing: 'n/a', neutral: 6, to: 9, range: [3, 12] },
  { prop: 'inner', on: 'shape', missing: 'n/a', neutral: 0.45, to: 0.8, range: [0.1, 0.95] },
  { prop: 'gradientAngle', on: 'shape', missing: 'n/a', neutral: 90, to: 180, range: [-360, 360] },
  { prop: 'stroke.width', on: 'shape', withParent: { stroke: { color: '#fff', width: 4 } }, missing: 'none', to: 10, range: [0.5, 500] },
];
const ALL = [...ROWS, ...textRows, ...shapeRows];

function make(row: Row, parent: boolean): Clip {
  const o = (parent ? row.withParent : undefined) ?? {};
  switch (row.on) {
    case 'video':
      return video(o as Partial<VideoClip>);
    case 'image':
      return image(o as Partial<ImageClip>);
    case 'text':
      return text(o as Partial<TextClip>);
    case 'shape':
      return shape(o as Partial<ShapeClip>);
  }
}

describe('look table: every property', () => {
  it('lists every row in animProps of its clip type, once, with a label', () => {
    for (const on of ['video', 'image', 'text', 'shape'] as const) {
      const names = animProps(make({ prop: '', on, missing: 'n/a', to: 0, range: [0, 0] }, false)).map((p) => p.prop);
      expect(new Set(names).size).toBe(names.length);
      for (const r of ALL.filter((x) => x.on === on)) expect(names, `${on} ${r.prop}`).toContain(r.prop);
    }
  });

  it('the old properties keep their place and the audio / effect / camera lists are untouched', () => {
    const v = animProps(video()).map((p) => p.prop);
    expect(v.slice(0, 9)).toEqual(['x', 'y', 'scale', 'rotation', 'opacity', 'z', 'rotX', 'rotY', 'volume']);
    expect(animProps(shape()).map((p) => p.prop).slice(0, 10)).toEqual(['x', 'y', 'scale', 'rotation', 'opacity', 'z', 'rotX', 'rotY', 'drawStart', 'drawEnd']);
    for (const p of animProps(text())) expect(p.label.length).toBeGreaterThan(0);
  });

  for (const row of ALL) {
    const name = `${row.on} ${row.prop}`;
    it(`${name}: range, base value, write, key between two keys`, () => {
      const c = make(row, true);
      const info = animProps(c).find((p) => p.prop === row.prop)!;
      expect(info.min, 'min').toBe(row.range[0]);
      expect(info.max, 'max').toBe(row.range[1]);
      // base value: a property with a neutral value reads it, one that is stored reads that
      const b = baseValue(c, row.prop);
      if (row.neutral !== undefined) expect(b).toBe(row.neutral === 80 ? (c as TextClip).fontSize : row.neutral);
      else if (row.prop === 'width' || row.prop === 'height') expect(b).toBe((c as ShapeClip)[row.prop as 'width']);
      else if (row.prop === 'shapeDepth') expect(b).toBeUndefined();
      else expect(b).toBeDefined();
      // write
      const w = withBaseValue(c, row.prop, row.to);
      expect(baseValue(w, row.prop)).toBe(row.to);
      expect(w).not.toBe(c);
      // the clip it was made from is not touched
      expect(baseValue(c, row.prop)).toBe(b);
      // two keys: the value half way (clip start is 2, so timeline 3 is local 1)
      const keyed = { ...c, keyframes: { [row.prop]: [k(0, row.range[0]), k(2, row.range[0] + (row.to - row.range[0]))] } } as Clip;
      const mid = row.range[0] + (row.to - row.range[0]) / 2;
      const expected = row.prop === 'points' ? Math.round(mid) : mid;
      expect(valueAt(keyed, row.prop, 3)).toBeCloseTo(expected, 9);
      const r = resolveClip(keyed, 3);
      expect(baseValue(r, row.prop)).toBeCloseTo(expected, 9);
      // outside the keys the ends hold
      expect(baseValue(resolveClip(keyed, 0), row.prop)).toBe(row.range[0]);
      expect(baseValue(resolveClip(keyed, 99), row.prop)).toBeCloseTo(row.to, 9);
    });

    if (row.missing === 'neutral') {
      it(`${name}: no parent object = the neutral value is the base, writing makes the object`, () => {
        const c = make(row, false);
        expect(baseValue(c, row.prop)).toBe(0);
        expect(canKey(c, row.prop)).toBe(true);
        const w = withBaseValue(c, row.prop, row.to);
        const parent = row.prop.split('.')[0] as 'crop';
        expect((w as VideoClip)[parent]).toBeDefined();
        expect(baseValue(w, row.prop)).toBe(row.to);
        // the other values of the new object are neutral
        for (const [key, v] of Object.entries((w as VideoClip)[parent] as unknown as Record<string, number>)) if (parent + '.' + key !== row.prop) expect(v).toBe(0);
        // a keyed value creates the object in the resolved copy only, the stored clip keeps none
        const keyed = { ...c, keyframes: { [row.prop]: [k(0, 0), k(2, row.to)] } } as Clip;
        const r = resolveClip(keyed, 4);
        expect(baseValue(r, row.prop)).toBe(row.to);
        expect((keyed as VideoClip)[parent]).toBeUndefined();
      });
    }
    if (row.missing === 'none') {
      it(`${name}: no parent object = not animatable until the feature is on`, () => {
        const c = make(row, false);
        expect(baseValue(c, row.prop)).toBeUndefined();
        expect(canKey(c, row.prop)).toBe(false);
        expect(withBaseValue(c, row.prop, row.to)).toBe(c);
        expect(withKeyAt(c, row.prop, 3, row.to)).toBeDefined();
        // keys that are there (the feature was turned off) are left alone by the resolver: same clip back
        const keyed = { ...c, keyframes: { [row.prop]: [k(0, 0), k(2, row.to)] } } as Clip;
        const r = resolveClip(keyed, 4);
        expect(baseValue(r, row.prop)).toBeUndefined();
        expect(r).toBe(keyed);
      });
    }
  }
});

describe('look table: rules', () => {
  it('points are whole numbers when resolved and when read', () => {
    const c = shape({ kind: 'star', keyframes: { points: [k(0, 3), k(2, 8)] } });
    // local 1 = 5.5 -> 6
    expect(resolveClip(c, 3).points).toBe(6);
    expect(valueAt(c, 'points', 3)).toBe(6);
    expect(Number.isInteger(resolveClip(c, 3.3).points)).toBe(true);
    expect(withBaseValue(shape(), 'points', 7.6).points).toBe(8);
  });

  it('points default to 5 for a star and 6 for any other figure', () => {
    expect(baseValue(shape({ kind: 'star' }), 'points')).toBe(5);
    expect(baseValue(shape({ kind: 'polygon' }), 'points')).toBe(6);
    expect(baseValue(shape({ kind: 'star', points: 7 }), 'points')).toBe(7);
  });

  it('shapeDepth has no neutral number but may be written (seeded)', () => {
    const c = video();
    expect(baseValue(c, 'shapeDepth')).toBeUndefined();
    expect(isSeedable(c, 'shapeDepth')).toBe(true);
    expect(isSeedable(c, 'radius')).toBe(false);
    expect(baseValue(withBaseValue(c, 'shapeDepth', 250), 'shapeDepth')).toBe(250);
  });

  it('a shape does not have the text properties and the other way round', () => {
    expect(baseValue(shape(), 'fontSize')).toBeUndefined();
    expect(baseValue(text(), 'points')).toBeUndefined();
    expect(baseValue(text(), 'width')).toBeUndefined();
    expect(baseValue(video(), 'fontSize')).toBeUndefined();
    expect(withBaseValue(video(), 'width', 5)).toBeDefined();
    expect(baseValue(withBaseValue(video(), 'width', 5), 'width')).toBeUndefined();
  });

  it('shape and text stroke width are two different properties of two clip types', () => {
    const s = shape({ stroke: { color: '#fff', width: 4 } });
    const t = text({ stroke: { color: '#000', width: 0.1 } });
    expect(baseValue(s, 'stroke.width')).toBe(4);
    expect(baseValue(t, 'stroke.width')).toBe(0.1);
    expect(animProps(s).find((p) => p.prop === 'stroke.width')!.max).toBe(500);
    expect(animProps(t).find((p) => p.prop === 'stroke.width')!.max).toBe(0.5);
  });

  it('audio, effect and camera clips have none of them', () => {
    expect(canKey(video(), 'crop.left')).toBe(true);
    expect(baseValue({ ...video(), type: 'audio' } as unknown as Clip, 'crop.left')).toBeUndefined();
  });

  it('withValueAt writes the static value, or a key when the property is keyed', () => {
    const c = video();
    expect(baseValue(withValueAt(c, 'crop.left', 3, 0.2), 'crop.left')).toBe(0.2);
    expect(withValueAt(c, 'crop.left', 3, 0.2).keyframes).toBeUndefined();
    const keyed = video({ keyframes: { 'crop.left': [k(0, 0), k(4, 0.4)] } });
    const w = withValueAt(keyed, 'crop.left', 4, 0.1);
    expect(w.keyframes!['crop.left']!.map((x) => [x.t, x.v])).toEqual([[0, 0], [2, 0.1], [4, 0.4]]);
    expect(w.crop).toBeUndefined();
  });

  it('removing the last key keeps the value it had', () => {
    const c = video({ keyframes: { 'adjust.brightness': [k(1, 0.3)] } });
    const w = withoutKeyAt(c, 'adjust.brightness', 3, 1e-3);
    expect(w.keyframes).toBeUndefined();
    expect(baseValue(w, 'adjust.brightness')).toBe(0.3);
  });
});

describe('resolveClip with look keys', () => {
  it('returns the very same clip without keys, and with an empty key list', () => {
    const c = video({ crop: { left: 0.1, top: 0, right: 0, bottom: 0 } });
    expect(resolveClip(c, 4)).toBe(c);
    const empty = { ...c, keyframes: { 'crop.left': [] } };
    expect(resolveClip(empty, 4)).toBe(empty);
  });

  it('copies the clip once and each touched object once, and leaves the stored clip and the other objects alone', () => {
    const crop = { left: 0.1, top: 0.1, right: 0, bottom: 0 };
    const mask = { ...MASK };
    const c = video({
      crop,
      mask,
      keyframes: { 'crop.left': [k(0, 0), k(2, 0.5)], 'crop.top': [k(0, 0), k(2, 0.5)], 'mask.width': [k(0, 0), k(2, 1)] },
    });
    const r = resolveClip(c, 3);
    expect(r).not.toBe(c);
    expect(r.crop).not.toBe(crop);
    expect(r.crop).toEqual({ left: 0.25, top: 0.25, right: 0, bottom: 0 });
    expect(r.mask).not.toBe(mask);
    expect(r.mask!.width).toBe(0.5);
    expect(r.mask!.x).toBe(MASK.x);
    // nothing that is not keyed is copied
    expect(r.transform).toBe(c.transform);
    expect(r.keyframes).toBe(c.keyframes);
    // the stored clip is untouched
    expect(crop).toEqual({ left: 0.1, top: 0.1, right: 0, bottom: 0 });
    expect(mask.width).toBe(MASK.width);
  });

  it('a keyed transform and a keyed look share the one copy of the clip', () => {
    const c = video({ keyframes: { x: [k(0, 0), k(2, 10)], radius: [k(0, 0), k(2, 1)] } });
    const r = resolveClip(c, 3);
    expect(r.transform.x).toBe(5);
    expect(r.radius).toBe(0.5);
  });

  it('matches writing the values one at a time with withBaseValue', () => {
    const c = shape({
      stroke: { color: '#fff', width: 4 },
      keyframes: { width: [k(0, 100), k(2, 300)], 'stroke.width': [k(0, 1), k(2, 9)], 'crop.right': [k(0, 0), k(2, 0.4)], points: [k(0, 3), k(2, 7)] },
    });
    let want: Clip = c;
    for (const prop of Object.keys(c.keyframes!)) want = withBaseValue(want, prop, valueAt(c, prop, 3)!);
    expect(resolveClip(c, 3)).toEqual(want);
  });

  it('a keyed text style leaves the text caches behind, a keyed transform or crop does not', () => {
    const t = text({ keyframes: { x: [k(0, 0), k(2, 10)], 'crop.left': [k(0, 0), k(2, 0.5)] } });
    expect(rawClipOf(resolveClip(t, 3))).toBe(t);
    const s = text({ keyframes: { fontSize: [k(0, 40), k(2, 80)] } });
    const r = resolveClip(s, 3);
    expect(rawClipOf(r)).toBe(r);
    expect(r.fontSize).toBe(60);
  });
});

describe('animatesPicture', () => {
  it('is true for color, key, mask, text style and shape figure keys, not for crop, radius, thickness or the transform', () => {
    expect(animatesPicture(video())).toBe(false);
    expect(animatesPicture(video({ keyframes: { x: [k(0, 0)] } }))).toBe(false);
    expect(animatesPicture(video({ keyframes: { 'crop.left': [k(0, 0)], radius: [k(0, 0)], shapeDepth: [k(0, 50)] } }))).toBe(false);
    expect(animatesPicture(video({ keyframes: { 'adjust.hue': [k(0, 0)] } }))).toBe(true);
    expect(animatesPicture(video({ keyframes: { 'adjust.hue': [] } }))).toBe(false);
    expect(animatesPicture(video({ mask: { ...MASK }, keyframes: { 'mask.x': [k(0, 0)] } }))).toBe(true);
    expect(animatesPicture(text({ keyframes: { fontSize: [k(0, 50)] } }))).toBe(true);
    expect(animatesPicture(shape({ keyframes: { width: [k(0, 50)] } }))).toBe(true);
  });
});
