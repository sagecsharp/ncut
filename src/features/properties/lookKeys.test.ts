import { beforeEach, describe, expect, it } from 'vitest';
import { createProject, createShapeClip, createTextClip } from '../../lib/factory';
import { animProps, baseValue, shiftKeyframes, valueAt } from '../../lib/anim';
import { useEditor } from '../../store/editorStore';
import type { Clip, Keyframe, Keyframes, VideoClip } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import { fitKeysToBeats, loopKeysOnBeats, snapKeysToGrid } from './beatKeys';
import { placeKeys } from './keyClipboard';
import { fitKeys, repeatKeys, reverseKeys } from './keyTools';
import { DEFAULT_GRADIENT_ANGLE, DEFAULT_POLYGON_POINTS, DEFAULT_STAR_INNER, DEFAULT_STAR_POINTS } from './shapeLogic';
import { wiggleProps } from './keyActions';

const k = (t: number, v: number): Keyframe => ({ t, v, ease: 'linear' });
const look: Keyframes = { 'crop.left': [k(0, 0), k(4, 0.4)], 'adjust.hue': [k(1, 0), k(3, 90)], radius: [k(0, 0), k(2, 1)] };
const tv = (keys: Keyframe[] | undefined) => (keys ?? []).map((q) => [+q.t.toFixed(6), +q.v.toFixed(6)]);

const video = (o: Partial<VideoClip> = {}): VideoClip => ({
  id: 'v',
  type: 'video',
  trackId: 't',
  start: 0,
  duration: 6,
  name: 'v',
  fadeIn: 0,
  fadeOut: 0,
  assetId: 'a',
  trimStart: 0,
  speed: 1,
  volume: 1,
  muted: false,
  transform: { ...DEFAULT_TRANSFORM },
  ...o,
});

describe('the table agrees with the shape inspector defaults', () => {
  it('points, inner radius and gradient angle', () => {
    expect(baseValue(createShapeClip('t', 0, { kind: 'star' }), 'points')).toBe(DEFAULT_STAR_POINTS);
    expect(baseValue(createShapeClip('t', 0, { kind: 'polygon' }), 'points')).toBe(DEFAULT_POLYGON_POINTS);
    expect(baseValue(createShapeClip('t', 0, {}), 'inner')).toBe(DEFAULT_STAR_INNER);
    expect(baseValue(createShapeClip('t', 0, {}), 'gradientAngle')).toBe(DEFAULT_GRADIENT_ANGLE);
  });
});

describe('the key tools work on look properties like on any other', () => {
  it('reverse mirrors every list on its own', () => {
    const r = reverseKeys(look, 4);
    expect(tv(r['crop.left'])).toEqual([[0, 0.4], [4, 0]]);
    expect(Object.keys(r).sort()).toEqual(Object.keys(look).sort());
    // another list is not part of the span of this one: they share one span, each keeps its own values
    expect(r['adjust.hue']!.map((q) => q.v)).toEqual([90, 0]);
  });
  it('fit, repeat and shift keep the property names', () => {
    expect(Object.keys(fitKeys(look, 0, 2)).sort()).toEqual(Object.keys(look).sort());
    const rep = repeatKeys(look, 2, false);
    expect(Object.keys(rep).sort()).toEqual(Object.keys(look).sort());
    expect(rep['crop.left']!.length).toBeGreaterThan(look['crop.left']!.length);
    expect(Object.keys(shiftKeyframes(look, 1)!).sort()).toEqual(Object.keys(look).sort());
  });
  it('on the beat: snap, fit and loop keep the property names', () => {
    const grid = { origin: 0, step: 0.5 };
    expect(Object.keys(snapKeysToGrid(look, grid, 1, 6).keys).sort()).toEqual(Object.keys(look).sort());
    const fit = fitKeysToBeats(look, grid, 4, 6);
    expect(typeof fit).toBe('object');
    expect(Object.keys((fit as { keys: Keyframes }).keys).sort()).toEqual(Object.keys(look).sort());
    const loop = loopKeysOnBeats({ 'crop.left': look['crop.left']! }, grid, 2, 6, false);
    expect(typeof loop).toBe('object');
  });
  it('wiggle still offers the transform only for visual clips', () => {
    expect(wiggleProps(video()).map((w) => w.prop)).toEqual(['x', 'y', 'rotation', 'scale', 'scaleX', 'scaleY']);
  });
});

describe('copy / paste of keys', () => {
  it('look keys land on another visual clip that has the property', () => {
    const placed = placeKeys(look, video(), 0);
    expect(Object.keys(placed).sort()).toEqual(Object.keys(look).sort());
  });
  it('text and shape properties only land where they exist', () => {
    const copied: Keyframes = { fontSize: [k(0, 40), k(2, 80)], 'crop.left': [k(0, 0), k(2, 0.2)], points: [k(0, 3)] };
    expect(Object.keys(placeKeys(copied, createTextClip('t', 0, { duration: 6 }), 0)).sort()).toEqual(['crop.left', 'fontSize']);
    expect(Object.keys(placeKeys(copied, createShapeClip('t', 0, { duration: 6 }), 0)).sort()).toEqual(['crop.left', 'points']);
    expect(Object.keys(placeKeys(copied, video(), 0))).toEqual(['crop.left']);
  });
  it('every property of the table can be pasted back where it came from', () => {
    for (const clip of [video(), createTextClip('t', 0, { duration: 6 }), createShapeClip('t', 0, { duration: 6 })] as Clip[]) {
      const all: Keyframes = {};
      for (const p of animProps(clip)) all[p.prop] = [k(0, p.min ?? 0), k(2, p.max ?? 1)];
      expect(Object.keys(placeKeys(all, clip, 0)).sort()).toEqual(Object.keys(all).sort());
    }
  });
});

describe('split keeps look motion in place', () => {
  beforeEach(() => {
    useEditor.setState({ project: null, selection: [], past: [], future: [], clipboard: [] });
  });
  it('both halves show the same value at the same timeline time', () => {
    const p = createProject('s', undefined, 30);
    const c = video({ trackId: p.tracks[0]!.id, duration: 8, keyframes: { 'crop.left': [k(0, 0), k(8, 0.8)], radius: [k(0, 0), k(8, 1)] } });
    useEditor.getState().openProject({
      ...p,
      assets: [{ id: 'a', name: 'a', kind: 'video', mime: 'video/mp4', size: 1, duration: 10, width: 1920, height: 1080, hasAudio: true, createdAt: 0 }],
      clips: [c],
    });
    const [rightId] = useEditor.getState().splitClips(3, [c.id]);
    const clips = useEditor.getState().project!.clips;
    const left = clips.find((x) => x.id === c.id)!;
    const right = clips.find((x) => x.id === rightId)!;
    for (const prop of ['crop.left', 'radius']) {
      for (const t of [0, 1.5, 2.9]) expect(valueAt(left, prop, t), `left ${prop} ${t}`).toBeCloseTo(valueAt(c, prop, t)!, 9);
      for (const t of [3, 5, 7.9]) expect(valueAt(right, prop, t), `right ${prop} ${t}`).toBeCloseTo(valueAt(c, prop, t)!, 9);
    }
  });
});
