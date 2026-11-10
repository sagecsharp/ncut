import { describe, expect, it } from 'vitest';
import type { Clip, Project, Track } from '../../types';
import { buildLayerTree, canAttach, lookTargetName } from './layers';

const T = (id: string, extra: Partial<Track> = {}): Track => ({ id, kind: 'video', name: id, muted: false, hidden: false, locked: false, ...extra });
const shape = (id: string, trackId: string, start: number, extra: Record<string, unknown> = {}) =>
  ({
    id, trackId, start, duration: 4, name: id, fadeIn: 0, fadeOut: 0, type: 'shape', kind: 'rect',
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, ...extra,
  }) as unknown as Clip;
const audio = (id: string, trackId: string) =>
  ({ id, trackId, start: 0, duration: 4, name: id, fadeIn: 0, fadeOut: 0, type: 'audio', assetId: 'a', trimStart: 0, speed: 1, volume: 1, muted: false }) as unknown as Clip;
const camera = (id: string, trackId: string) =>
  ({ id, trackId, start: 0, duration: 4, name: id, fadeIn: 0, fadeOut: 0, type: 'camera', x: 0, y: 0, z: 0, pan: 0, tilt: 0, roll: 0, fov: 50 }) as unknown as Clip;
const effect = (id: string, trackId: string) =>
  ({ id, trackId, start: 0, duration: 4, name: id, fadeIn: 0, fadeOut: 0, type: 'effect', effect: 'x', amount: 1, params: {}, seed: 0 }) as unknown as Clip;
const proj = (tracks: Track[], clips: Clip[]) => ({ tracks, clips, assets: [] }) as unknown as Project;

describe('buildLayerTree', () => {
  it('orders by track then start and skips audio', () => {
    const p = proj([T('t1'), T('t2'), T('a', { kind: 'audio' })], [shape('b', 't2', 0), shape('a2', 't1', 2), shape('a1', 't1', 0), audio('au', 'a')]);
    expect(buildLayerTree(p, 3, 'all').map((n) => n.id)).toEqual(['a1', 'a2', 'b']);
  });
  it('now only lists clips under the time', () => {
    const p = proj([T('t1')], [shape('a', 't1', 0), shape('b', 't1', 4)]);
    expect(buildLayerTree(p, 1, 'now').map((n) => n.id)).toEqual(['a']);
    expect(buildLayerTree(p, 4, 'now').map((n) => n.id)).toEqual(['b']);
    expect(buildLayerTree(p, 9, 'now')).toEqual([]);
  });
  it('nests children under their parent', () => {
    const p = proj([T('t1'), T('t2')], [shape('p', 't1', 0), shape('c', 't2', 0, { parent: 'p' }), camera('cam', 't2')]);
    const n = buildLayerTree(p, 1, 'now');
    expect(n.map((x) => [x.id, x.depth])).toEqual([['p', 0], ['c', 1], ['cam', 0]]);
    expect(n[0]!.hasChildren).toBe(true);
    expect(n[1]!.attachedTo).toBeNull();
  });
  it('keeps a child at the root with attachedTo when the parent is not listed', () => {
    const p = proj([T('t1')], [shape('p', 't1', 0), shape('c', 't1', 4, { parent: 'p' })]);
    const n = buildLayerTree(p, 5, 'now');
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ id: 'c', depth: 0, attachedTo: 'p' });
  });
  it('does not hang on loops and still shows every clip', () => {
    const p = proj([T('t1')], [shape('a', 't1', 0, { parent: 'b' }), shape('b', 't1', 4, { parent: 'a' })]);
    expect(buildLayerTree(p, 0, 'all').map((n) => n.id).sort()).toEqual(['a', 'b']);
  });
  it('caps depth', () => {
    const clips: Clip[] = [shape('c0', 't1', 0)];
    for (let i = 1; i < 14; i++) clips.push(shape(`c${i}`, 't1', i * 5, { parent: `c${i - 1}` }));
    const n = buildLayerTree(proj([T('t1')], clips), 0, 'all');
    expect(n).toHaveLength(14);
    expect(Math.max(...n.map((x) => x.depth))).toBeLessThanOrEqual(8);
  });
  it('reports track flags, group, effect and 3d', () => {
    const p = proj([T('t1', { hidden: true, locked: true })], [shape('a', 't1', 0, { group: 'g', threeD: true }), effect('e', 't1')]);
    const n = buildLayerTree(p, 1, 'now');
    expect(n[0]).toMatchObject({ hidden: true, locked: true, group: 'g', threeD: true, type: 'shape' });
    expect(n[1]).toMatchObject({ type: 'effect', threeD: false, group: null });
  });
});

describe('layer row extras', () => {
  const mask = { shape: 'rect', x: 0, y: 0, width: 1, height: 1, rotation: 0, feather: 0, invert: false };
  it('marks the first row of each track only', () => {
    const p = proj([T('t1'), T('t2')], [shape('a', 't1', 0), shape('b', 't1', 4), shape('c', 't2', 0)]);
    const n = buildLayerTree(p, 0, 'all');
    expect(n.map((x) => [x.id, x.firstOfTrack])).toEqual([['a', true], ['b', false], ['c', true]]);
    expect(n.map((x) => x.trackId)).toEqual(['t1', 't1', 't2']);
  });
  it('flags masks, only when a mask is set', () => {
    const p = proj([T('t1')], [shape('a', 't1', 0, { mask }), shape('b', 't1', 4, { mask: null }), shape('c', 't1', 8)]);
    expect(buildLayerTree(p, 0, 'all').map((x) => x.masked)).toEqual([true, false, false]);
  });
  it('names the clip a clip looks at', () => {
    const p = proj([T('t1')], [shape('a', 't1', 0, { lookAt: 'clip', lookTarget: 'b' }), shape('b', 't1', 4, { name: 'the ball' })]);
    const n = buildLayerTree(p, 0, 'all');
    expect(n[0]!.looksAt).toBe('the ball');
    expect(n[1]!.looksAt).toBeNull();
  });
  it('ignores a look target that is missing, itself, not a picture, or not in clip mode', () => {
    const clips = [
      shape('a', 't1', 0, { lookAt: 'clip', lookTarget: 'nope' }),
      shape('b', 't1', 4, { lookAt: 'clip', lookTarget: 'b' }),
      shape('c', 't1', 8, { lookAt: 'clip', lookTarget: 'fx' }),
      shape('d', 't1', 12, { lookAt: 'camera', lookTarget: 'a' }),
      shape('e', 't1', 16, { lookAt: 'clip', lookTarget: null }),
      effect('fx', 't1'),
    ];
    const p = proj([T('t1')], clips);
    for (const c of clips.slice(0, 5)) expect(lookTargetName(p, c)).toBeNull();
  });
  it('lets everything but text be renamed', () => {
    const text = { ...shape('t', 't1', 0), type: 'text', text: 'hello' } as unknown as Clip;
    const p = proj([T('t1')], [text, shape('s', 't1', 4)]);
    expect(buildLayerTree(p, 0, 'all').map((x) => x.canRename)).toEqual([false, true]);
  });
});

describe('canAttach', () => {
  const p = proj([T('t1')], [shape('a', 't1', 0), shape('b', 't1', 4, { parent: 'a' }), camera('cam', 't1'), effect('fx', 't1'), audio('au', 't1')]);
  it('allows pictures and cameras as parents', () => {
    expect(canAttach(p, 'a', 'cam')).toBe(true);
    expect(canAttach(p, 'b', 'cam')).toBe(true);
  });
  it('refuses self, loops, effects, audio, unknown', () => {
    expect(canAttach(p, 'a', 'a')).toBe(false);
    expect(canAttach(p, 'a', 'b')).toBe(false);
    expect(canAttach(p, 'a', 'fx')).toBe(false);
    expect(canAttach(p, 'a', 'au')).toBe(false);
    expect(canAttach(p, 'a', 'nope')).toBe(false);
  });
  it('refuses a child that cannot carry a parent', () => {
    expect(canAttach(p, 'cam', 'a')).toBe(false);
    expect(canAttach(p, 'fx', 'a')).toBe(false);
  });
});
