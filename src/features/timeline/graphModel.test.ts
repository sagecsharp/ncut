import { describe, expect, it } from 'vitest';
import type { Clip, Easing, ImageClip, KeyHandle, Keyframe, Project } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import { createProject } from '../../lib/factory';
import { evalKeys } from '../../lib/anim';
import { INFLUENCE_MIN, SPEED_MAX, speedAt } from '../../lib/keyBezier';
import type { KeyRef } from '../../store/ui';
import { buildGraphLines, fitWindows, handleFromPointer, hitGraph, keysInGraphBox, lineColor, lineValue, niceTicks, valueSnap, vOf, yOf } from './graphModel';
import type { GraphHitIndex, GraphLine, GraphViewport } from './graphModel';
import { keyedValues } from './keyLanesModel';
import { laneId } from './keySelection';

const k = (t: number, v: number, ease: Easing = 'linear', extra: { in?: KeyHandle; out?: KeyHandle } = {}): Keyframe => ({ t, v, ease, ...extra });
const image = (id: string, trackId: string, start: number, duration: number, keyframes: ImageClip['keyframes']): ImageClip => ({
  id, type: 'image', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'img1', transform: { ...DEFAULT_TRANSFORM }, keyframes,
});
function make(clips: (v: string, a: string) => Clip[], lockAudio = false): Project {
  const p = createProject('graph', undefined, 30);
  const v = p.tracks[0]!.id;
  const a = p.tracks[1]!.id;
  return { ...p, tracks: p.tracks.map((t) => (lockAudio && t.kind === 'audio' ? { ...t, locked: true } : t)), clips: clips(v, a) };
}
/** the one line of a prop of a clip */
function lineOf(clip: Clip, prop: string): GraphLine {
  const p = make((v) => [{ ...clip, trackId: v }]);
  return buildGraphLines(p, p.clips, new Set()).find((l) => l.prop === prop)!;
}
const vp: GraphViewport = { zoom: 100, scrollLeft: 0, width: 800, height: 100 };

describe('graphModel', () => {
  it('lines follow keyedValues, skip hidden and locked', () => {
    const p = make((v, a) => [
      image('a', v, 0, 4, { opacity: [k(0, 1), k(1, 0)], y: [k(0, 0), k(1, 5)], x: [k(0, 0), k(1, 5)] }),
      image('b', a, 0, 4, { x: [k(0, 0), k(1, 5)] }),
    ], true);
    const [a, b] = p.clips as ImageClip[];
    const lines = buildGraphLines(p, [a!, b!], new Set());
    expect(lines.map((l) => l.prop)).toEqual(keyedValues(a!).map((d) => d.prop));
    expect(lines.every((l) => l.clipId === 'a')).toBe(true);
    expect(lines.map((l) => l.id)).toEqual(lines.map((l) => laneId('a', l.prop)));
    const op = lines.find((l) => l.prop === 'opacity')!;
    expect(op.group).toBe('%|100');
    expect(op.limits).toEqual({ min: 0, max: 1 });
    expect(op.range).toEqual({ lo: 0, hi: 1 });
    expect(op.clipName).toBe('a');
    expect(op.keys).toBe(a!.keyframes!.opacity);
    expect(op.start).toBe(0);
    expect(op.duration).toBe(4);
    const hid = buildGraphLines(p, [a!, b!], new Set([laneId('a', 'y')]));
    expect(hid.map((l) => l.prop)).toEqual(lines.map((l) => l.prop).filter((x) => x !== 'y'));
    // a track that is gone shows nothing
    expect(buildGraphLines({ ...p, tracks: [] }, [a!], new Set())).toEqual([]);
  });

  it('colors by prop, dashes by clip', () => {
    const img = { type: 'image' } as Clip;
    const cam = { type: 'camera' } as Clip;
    for (const prop of ['x', 'scaleX', 'rotX']) expect(lineColor(img, prop, 0)).toBe('--graph-red');
    for (const prop of ['y', 'scaleY', 'rotY']) expect(lineColor(img, prop, 0)).toBe('--graph-green');
    for (const prop of ['z', 'scaleZ', 'rotation']) expect(lineColor(img, prop, 0)).toBe('--graph-blue');
    expect(lineColor(cam, 'tilt', 0)).toBe('--graph-red');
    expect(lineColor(cam, 'pan', 0)).toBe('--graph-green');
    expect(lineColor(cam, 'roll', 0)).toBe('--graph-blue');
    expect(lineColor(img, 'pan', 0)).toBe('--graph-violet');
    expect(lineColor(img, 'scale', 0)).toBe('--graph-amber');
    expect(lineColor(img, 'opacity', 0)).toBe('--graph-gray');
    expect(lineColor(img, 'volume', 0)).toBe('--graph-cyan');
    expect([0, 1, 2, 3, 4, 5].map((i) => lineColor(img, 'p.size', i))).toEqual(['--graph-orange', '--graph-pink', '--graph-teal', '--graph-lime', '--graph-orange', '--graph-pink']);
    const p = make((v) => [0, 1, 2, 3, 4].map((i) => image('c' + i, v, 0, 4, { x: [k(0, 0), k(1, 5)], 'adjust.brightness': [k(0, 0), k(1, 5)] })));
    const lines = buildGraphLines(p, p.clips, new Set());
    expect(lines.filter((l) => l.prop === 'x').map((l) => l.dash)).toEqual([[], [6, 3], [2, 3], [8, 3, 2, 3], []]);
    // an unnamed value takes its color by its place in keyedValues, a hidden line keeps its place
    const spare = ['--graph-orange', '--graph-pink', '--graph-teal', '--graph-lime'];
    const at = keyedValues(p.clips[0]!).findIndex((d) => d.prop === 'adjust.brightness');
    expect(at).toBeGreaterThan(0);
    expect(lines.find((l) => l.clipId === 'c0' && l.prop === 'adjust.brightness')!.color).toBe(spare[at % 4]);
    const hid = buildGraphLines(p, p.clips, new Set([laneId('c0', 'x')]));
    expect(hid.find((l) => l.clipId === 'c0')!.color).toBe(spare[at % 4]);
  });

  it('lineValue matches evalKeys and speedAt', () => {
    const keys = [k(0, 0, 'bezier', { out: { speed: 200, influence: 0.4 } }), k(2, 100, 'ease', { in: { speed: -30, influence: 0.3 } }), k(3, 40, 'back')];
    const line = lineOf(image('a', 't', 0, 4, { x: keys }), 'x');
    for (const t of [-1, 0, 0.3, 1, 2, 2.5, 3, 3.5]) {
      expect(lineValue(line, 'value', t)).toBe(evalKeys(keys, t, line.clip, 'x'));
      expect(lineValue(line, 'speed', t)).toBe(speedAt(keys, t, line.range));
    }
    // whole numbers round
    const whole = { ...line, int: true };
    expect(lineValue(whole, 'value', 0.37)).toBe(Math.round(evalKeys(keys, 0.37, line.clip, 'x')));
    expect(lineValue(whole, 'speed', 0.37)).toBe(speedAt(keys, 0.37, line.range));
  });

  it('fitWindows holds keys and overshoot, pads 8 %', () => {
    const lin = lineOf(image('a', 't', 0, 4, { x: [k(0, 0), k(2, 100)] }), 'x');
    const w = fitWindows([lin], 'value')['px|1']!;
    expect(w.lo).toBeCloseTo(-8, 9);
    expect(w.hi).toBeCloseTo(108, 9);
    // a range of the timeline cuts the line
    const cut = fitWindows([lin], 'value', 0, 1)['px|1']!;
    expect(cut.lo).toBeCloseTo(-4, 9);
    expect(cut.hi).toBeCloseTo(54, 9);
    // a clip that starts later: timeline seconds
    const late = lineOf(image('a', 't', 10, 4, { x: [k(0, 0), k(2, 100)] }), 'x');
    const lateCut = fitWindows([late], 'value', 10, 11)['px|1']!;
    expect(lateCut.hi).toBeCloseTo(54, 9);
    expect(fitWindows([late], 'value', 0, 5)).toEqual({});
    expect(fitWindows([late], 'value', 20, 30)).toEqual({});
    // the back ease overshoots its last key
    const keys = [k(0, 0, 'back'), k(2, 100)];
    const back = lineOf(image('a', 't', 0, 4, { x: keys }), 'x');
    let lo = Infinity;
    let hi = -Infinity;
    for (let j = 0; j <= 32; j++) {
      const v = evalKeys(keys, (2 * j) / 32, back.clip, 'x');
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    expect(hi).toBeGreaterThan(100);
    const bw = fitWindows([back], 'value')['px|1']!;
    expect(bw.lo).toBeCloseTo(lo - 0.08 * (hi - lo), 9);
    expect(bw.hi).toBeCloseTo(hi + 0.08 * (hi - lo), 9);
    // two unit groups give two windows, shown units (opacity is a percent)
    const both = lineOf(image('a', 't', 0, 4, { x: [k(0, 0), k(2, 100)], opacity: [k(0, 0), k(2, 1)] }), 'opacity');
    const two = fitWindows([lin, both], 'value');
    expect(Object.keys(two).sort()).toEqual(['%|100', 'px|1']);
    expect(two['%|100']!.hi).toBeCloseTo(108, 9);
    // a line no time of the range touches adds nothing
    expect(fitWindows([], 'value')).toEqual({});
  });

  it('custom extremes from the roots', () => {
    // an s shape that runs past both key values
    const keys = [k(0, 0, 'bezier', { out: { speed: 400, influence: 0.5 } }), k(1, 10, 'linear', { in: { speed: 400, influence: 0.5 } })];
    const line = lineOf(image('a', 't', 0, 2, { x: keys }), 'x');
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i <= 20000; i++) {
      const v = evalKeys(keys, i / 20000, line.clip, 'x');
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    expect(hi).toBeGreaterThan(10);
    expect(lo).toBeLessThan(0);
    const w = fitWindows([line], 'value')['px|1']!;
    expect(w.hi).toBeCloseTo(hi + 0.08 * (hi - lo), 3);
    expect(w.lo).toBeCloseTo(lo - 0.08 * (hi - lo), 3);
    // a value with a range is clamped like the line: opacity never shows under 0
    const op = [k(0, 1, 'bezier', { out: { speed: -5, influence: 1 / 3 } }), k(2, 0)];
    const clamped = lineOf(image('a', 't', 0, 2, { opacity: op }), 'opacity');
    const cw = fitWindows([clamped], 'value')['%|100']!;
    expect(cw.lo).toBeCloseTo(-8, 9);
    expect(cw.hi).toBeCloseTo(108, 9);
  });

  it('speed windows hold 0', () => {
    const line = lineOf(image('a', 't', 0, 4, { x: [k(0, 20), k(2, 120)] }), 'x');
    const w = fitWindows([line], 'speed')['px|1']!;
    expect(w.lo).toBeCloseTo(-4, 9);
    expect(w.hi).toBeCloseTo(54, 9);
    // opacity speeds are per second, shown in percent
    const op = lineOf(image('a', 't', 0, 4, { opacity: [k(0, 0), k(1, 1)] }), 'opacity');
    const ow = fitWindows([op], 'speed')['%|100']!;
    expect(ow.lo).toBeCloseTo(-8, 9);
    expect(ow.hi).toBeCloseTo(108, 9);
  });

  it('a flat line gets five steps a side', () => {
    const line = lineOf(image('a', 't', 0, 4, { x: [k(0, 7), k(1, 7)] }), 'x');
    expect(fitWindows([line], 'value')).toEqual({ 'px|1': { lo: 2, hi: 12 } });
    // the largest step of the group
    const big = { ...line, id: 'other', feel: { ...line.feel, step: 3 } };
    expect(fitWindows([line, big], 'value')).toEqual({ 'px|1': { lo: -8, hi: 22 } });
    // a still line has no speed
    expect(fitWindows([line], 'speed')).toEqual({ 'px|1': { lo: -5, hi: 5 } });
  });

  it('yOf and vOf round trip', () => {
    const w = { lo: -10, hi: 30 };
    expect(yOf(30, w, 200)).toBe(0);
    expect(yOf(-10, w, 200)).toBe(200);
    for (const v of [-10, 0, 7.5, 30]) expect(vOf(yOf(v, w, 200), w, 200)).toBeCloseTo(v, 9);
    expect(yOf(5, { lo: 5, hi: 5 }, 120)).toBe(60);
    expect(vOf(33, { lo: 5, hi: 5 }, 120)).toBe(5);
  });

  it('niceTicks steps and gaps', () => {
    expect(niceTicks({ lo: 0, hi: 100 }, 280)).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    expect(niceTicks({ lo: 0, hi: 1 }, 100)).toEqual([0, 0.5, 1]);
    expect(niceTicks({ lo: 0.1, hi: 0.4 }, 280)).toEqual([0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4]);
    expect(niceTicks({ lo: -35, hi: 62 }, 300)).toEqual([-30, -20, -10, 0, 10, 20, 30, 40, 50, 60]);
    for (const [w, h, gap] of [[{ lo: 0, hi: 7 }, 260, 28], [{ lo: -1234, hi: 98765 }, 900, 40], [{ lo: 0, hi: 0.003 }, 150, 28]] as const) {
      const t = niceTicks(w, h, gap);
      expect(t.length).toBeGreaterThan(1);
      for (let i = 1; i < t.length; i++) expect(((t[i]! - t[i - 1]!) / (w.hi - w.lo)) * h).toBeGreaterThanOrEqual(gap * (1 - 1e-9));
      expect(t.every((v) => v >= w.lo && v <= w.hi)).toBe(true);
    }
    // no zero from below
    expect(Object.is(niceTicks({ lo: -0.00001, hi: 5 }, 100).find((v) => v === 0), 0)).toBe(true);
    expect(niceTicks({ lo: 3, hi: 3 }, 100)).toEqual([]);
    expect(niceTicks({ lo: 0, hi: 1 }, 0)).toEqual([]);
  });

  it('valueSnap within 6 px only', () => {
    const line = lineOf(image('a', 't', 0, 4, { x: [k(0, 0), k(1, 100), k(9, 50)] }), 'x');
    // keys 0 and 100, and 0 again as the zero line. the key at 9 s is outside
    expect(valueSnap(99, line, 0, 0.5, true)).toEqual({ v: 100, hit: 100 });
    expect(valueSnap(97, line, 0, 0.5, true)).toEqual({ v: 100, hit: 100 });
    expect(valueSnap(96.9, line, 0, 0.5, true)).toEqual({ v: 96.9, hit: null });
    expect(valueSnap(3, line, 1, 0.5, true)).toEqual({ v: 0, hit: 0 });
    expect(valueSnap(49, line, 0, 0.5, true)).toEqual({ v: 49, hit: null });
    // the key that is dragged is skipped
    expect(valueSnap(99, line, 1, 0.5, true)).toEqual({ v: 99, hit: null });
    expect(valueSnap(99, line, 0, 0.5, false)).toEqual({ v: 99, hit: null });
    expect(valueSnap(99, line, 0, 0, true)).toEqual({ v: 99, hit: null });
    // the rest value, stored: opacity rests at 100 % = 1
    const op = lineOf(image('a', 't', 0, 4, { opacity: [k(0, 0.2), k(1, 0.6)] }), 'opacity');
    expect(valueSnap(0.99, op, 0, 0.01, true)).toEqual({ v: 1, hit: 1 });
    expect(valueSnap(0.9, op, 0, 0.01, true)).toEqual({ v: 0.9, hit: null });
  });

  it('handleFromPointer both sides, behind the key', () => {
    const keys = [k(0, 0), k(1, 10), k(2, 20)];
    const last: KeyHandle = { speed: 7, influence: 0.4 };
    expect(handleFromPointer(keys, 1, 'out', 1.5, 15, 'value', last)).toEqual({ speed: 10, influence: 0.5 });
    expect(handleFromPointer(keys, 1, 'in', 0.5, 5, 'value', last)).toEqual({ speed: 10, influence: 0.5 });
    expect(handleFromPointer(keys, 1, 'out', 1.25, 30, 'value', last)).toEqual({ speed: 80, influence: 0.25 });
    // behind the key: the least reach, the speed it had
    expect(handleFromPointer(keys, 1, 'out', 0.9, 4, 'value', last)).toEqual({ speed: 7, influence: INFLUENCE_MIN });
    expect(handleFromPointer(keys, 1, 'in', 1.2, 4, 'value', last)).toEqual({ speed: 7, influence: INFLUENCE_MIN });
    // past the neighbour: 1
    expect(handleFromPointer(keys, 1, 'out', 5, 10, 'value', last).influence).toBe(1);
    // no neighbour, or no number
    expect(handleFromPointer(keys, 2, 'out', 3, 20, 'value', last)).toBe(last);
    expect(handleFromPointer(keys, 0, 'in', -1, 0, 'value', last)).toBe(last);
    expect(handleFromPointer(keys, 1, 'out', NaN, 5, 'value', last)).toBe(last);
    expect(handleFromPointer(keys, 1, 'out', 1.5, Infinity, 'speed', last)).toBe(last);
    // a huge speed is clamped
    expect(handleFromPointer(keys, 1, 'out', 1.5, 1e12, 'value', last).speed).toBe(SPEED_MAX);
    // the speed graph: v is the speed
    expect(handleFromPointer(keys, 1, 'out', 1.25, 33, 'speed', last)).toEqual({ speed: 33, influence: 0.25 });
    expect(handleFromPointer(keys, 1, 'in', 0.75, -33, 'speed', last)).toEqual({ speed: -33, influence: 0.25 });
  });

  it('hitGraph prefers a handle over a key over a line', () => {
    const ref: KeyRef = { clipId: 'a', prop: 'x', t: 1 };
    const index: GraphHitIndex = {
      kx: Float32Array.of(100), ky: Float32Array.of(50), kref: [ref], kn: 1,
      hx: Float32Array.of(100), hy: Float32Array.of(55.5), href: [{ ref, side: 'out' }], hn: 1,
    };
    const line = lineOf(image('a', 't', 1, 4, { x: [k(0, 0), k(2, 100)] }), 'x');
    const windows = { 'px|1': { lo: 0, hi: 100 } };
    // the handle is 5.5 px away and the key 0: the handle wins
    expect(hitGraph(index, [line], windows, 'value', vp, 100, 50)).toEqual({ kind: 'handle', ref, side: 'out' });
    expect(hitGraph({ ...index, hn: 0 }, [line], windows, 'value', vp, 100, 50)).toEqual({ kind: 'key', ref });
    expect(hitGraph({ ...index, hn: 0 }, [line], windows, 'value', vp, 100, 56.5)).toEqual({ kind: 'empty' });
    const bare = { ...index, hn: 0, kn: 0 };
    // x = 200 is clip time 1: the line is at 50
    expect(hitGraph(bare, [line], windows, 'value', vp, 200, 53)).toEqual({ kind: 'line', line: line.id, t: 1 });
    expect(hitGraph(bare, [line], windows, 'value', vp, 200, 55.5)).toEqual({ kind: 'empty' });
    // outside the clip's span, or in a window that is not there
    expect(hitGraph(bare, [line], windows, 'value', vp, 50, 50)).toEqual({ kind: 'empty' });
    expect(hitGraph(bare, [line], windows, 'value', vp, 700, 50)).toEqual({ kind: 'empty' });
    expect(hitGraph(bare, [line], {}, 'value', vp, 200, 50)).toEqual({ kind: 'empty' });
    // scrolled: the same time is 100 px further left
    expect(hitGraph(bare, [line], windows, 'value', { ...vp, scrollLeft: 100 }, 100, 50)).toEqual({ kind: 'line', line: line.id, t: 1 });
    // the speed graph: 50 per second, the window sits where the speed is
    expect(hitGraph(bare, [line], { 'px|1': { lo: 0, hi: 100 } }, 'speed', vp, 200, 50)).toEqual({ kind: 'line', line: line.id, t: 1 });
  });

  it('keysInGraphBox takes inside keys only', () => {
    const line = lineOf(image('a', 't', 0, 4, { x: [k(-0.5, 10), k(1, 20), k(2, 30), k(5, 40)] }), 'x');
    const windows = { 'px|1': { lo: 0, hi: 100 } };
    // the keys at -0.5 s and 5 s are outside the clip: never picked, whatever the box
    const all = keysInGraphBox([line], windows, 'value', vp, { x0: 600, x1: -100, y0: 100, y1: 0 });
    expect(all).toEqual([{ clipId: 'a', prop: 'x', t: 1 }, { clipId: 'a', prop: 'x', t: 2 }]);
    expect(keysInGraphBox([line], windows, 'value', vp, { x0: 150, x1: 250, y0: 0, y1: 100 })).toEqual([{ clipId: 'a', prop: 'x', t: 2 }]);
    // t = 1 is at y 80, t = 2 at y 70
    expect(keysInGraphBox([line], windows, 'value', vp, { x0: 0, x1: 300, y0: 75, y1: 85 })).toEqual([{ clipId: 'a', prop: 'x', t: 1 }]);
    expect(keysInGraphBox([line], windows, 'value', vp, { x0: 0, x1: 300, y0: 0, y1: 10 })).toEqual([]);
    expect(keysInGraphBox([line], {}, 'value', vp, { x0: 0, x1: 300, y0: 0, y1: 100 })).toEqual([]);
    // the speed graph: a key sits at its speed (10 per second on the first part)
    const speed = { 'px|1': { lo: 0, hi: 20 } };
    const sp = keysInGraphBox([line], speed, 'speed', { ...vp, height: 100 }, { x0: 90, x1: 110, y0: 49, y1: 51 });
    expect(sp).toEqual([{ clipId: 'a', prop: 'x', t: 1 }]);
  });
});
