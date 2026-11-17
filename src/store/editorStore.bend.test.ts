import { beforeEach, describe, expect, it } from 'vitest';
import type { Clip, ImageClip, Keyframe, Project } from '../types';
import { DEFAULT_TRANSFORM } from '../types';
import { createProject } from '../lib/factory';
import { useEditor } from './editorStore';

const ed = () => useEditor.getState();
const proj = (): Project => ed().project!;
const clipOf = (id: string) => proj().clips.find((c) => c.id === id) as ImageClip;
const k = (t: number, v: number): Keyframe => ({ t, v, ease: 'linear' });

let seq = 0;
function mkImage(trackId: string, start: number, over: Partial<ImageClip> = {}): ImageClip {
  return {
    id: `bi${++seq}`,
    type: 'image',
    trackId,
    start,
    duration: 4,
    name: 'i',
    fadeIn: 0,
    fadeOut: 0,
    assetId: 'img',
    transform: { ...DEFAULT_TRANSFORM },
    ...over,
  };
}

const ASSETS = [{ id: 'img', name: 'img', kind: 'image' as const, mime: 'image/png', size: 1, duration: 0, width: 100, height: 100, hasAudio: false, createdAt: 0 }];

function open(make: (v: string) => Clip[], lockFirstTrack = false): { v: string; ids: string[] } {
  useEditor.setState({ clipboard: [] });
  const p = createProject('rolls');
  const v = p.tracks[0]!.id;
  const clips = make(v);
  const tracks = lockFirstTrack ? p.tracks.map((t, i) => (i === 0 ? { ...t, locked: true } : t)) : p.tracks;
  ed().openProject({ ...p, tracks, assets: [...ASSETS], clips });
  return { v, ids: clips.map((c) => c.id) };
}

beforeEach(() => {
  useEditor.setState({ project: null, selection: [], past: [], future: [], clipboard: [] });
});

describe('setBends', () => {
  it('setBends writes several clips in one undo step', () => {
    const { ids } = open((v) => [mkImage(v, 0), mkImage(v, 4)]);
    const [a, b] = ids as [string, string];
    ed().setBends([
      { id: a, bend: { angle: 90, center: -0.5, span: 800 } },
      { id: b, bend: { angle: 90, center: 0.5, span: 800, along: 'height' } },
    ]);
    expect(clipOf(a).bend).toEqual({ angle: 90, center: -0.5, span: 800 });
    expect(clipOf(b).bend).toEqual({ angle: 90, center: 0.5, span: 800, along: 'height' });
    expect(ed().past).toHaveLength(1);
    ed().undo();
    expect('bend' in clipOf(a)).toBe(false);
    expect('bend' in clipOf(b)).toBe(false);
  });
  it('setBends with keys null removes the bend.angle keys', () => {
    const { ids } = open((v) => [mkImage(v, 0, { bend: { angle: 10 }, keyframes: { 'bend.angle': [k(0, 0), k(1, 90)], opacity: [k(0, 1), k(1, 0)] } })]);
    const a = ids[0]!;
    ed().setBends([{ id: a, bend: { angle: 10 }, keys: null }]);
    expect(clipOf(a).keyframes).toEqual({ opacity: [k(0, 1), k(1, 0)] });
    ed().setBends([{ id: a, bend: null }]);
    expect('bend' in clipOf(a)).toBe(false);
  });
  it('setBends keys: undefined keeps them, a list is sorted and cleaned', () => {
    const { ids } = open((v) => [mkImage(v, 0, { bend: { angle: 10 }, keyframes: { 'bend.angle': [k(0, 0), k(1, 90)] } })]);
    const a = ids[0]!;
    ed().setBends([{ id: a, bend: { angle: 20 } }]);
    expect(clipOf(a).keyframes!['bend.angle']).toHaveLength(2);
    ed().setBends([{ id: a, bend: { angle: 20 }, keys: [k(2, 500), k(1, 5), k(Number.NaN, 1)] }]);
    expect(clipOf(a).keyframes!['bend.angle']!.map((q) => [q.t, q.v])).toEqual([
      [1, 5],
      [2, 360],
    ]);
    ed().setBends([{ id: a, bend: { angle: 20 }, keys: [] }]);
    expect(clipOf(a).keyframes).toBeUndefined();
  });
});

describe('updateClip bend', () => {
  it('updateClip bend null deletes the field and its keys', () => {
    const { ids } = open((v) => [mkImage(v, 0, { bend: { angle: 10 }, keyframes: { 'bend.angle': [k(0, 0), k(1, 90)] } })]);
    const a = ids[0]!;
    ed().updateClip(a, { bend: null });
    expect('bend' in clipOf(a)).toBe(false);
    expect(clipOf(a).keyframes).toBeUndefined();
    expect(ed().past).toHaveLength(1);
  });
  it('updateClip cleans a bend', () => {
    const { ids } = open((v) => [mkImage(v, 0)]);
    const a = ids[0]!;
    ed().updateClip(a, { bend: { angle: 999, along: 'width', center: 0, span: 5e6 } as never });
    expect(clipOf(a).bend).toEqual({ angle: 360, span: 100000 });
    ed().updateClip(a, { bend: { angle: Number.NaN, center: 4, along: 'height' } as never });
    expect(clipOf(a).bend).toEqual({ angle: 0, center: 1, along: 'height' });
  });
  it('an equal bend is no change and no undo step', () => {
    const { ids } = open((v) => [mkImage(v, 0)]);
    const a = ids[0]!;
    ed().updateClip(a, { bend: { angle: 45 } });
    const steps = ed().past.length;
    const before = proj();
    ed().updateClip(a, { bend: { angle: 45, along: 'width' } as never });
    ed().setBends([{ id: a, bend: { angle: 45 } }]);
    expect(proj()).toBe(before);
    expect(ed().past).toHaveLength(steps);
    ed().updateClip(a, { bend: null });
    const after = proj();
    ed().updateClip(a, { bend: null });
    ed().setBends([{ id: a, bend: null }]);
    expect(proj()).toBe(after);
    expect(ed().past).toHaveLength(steps + 1);
  });
  it('a clip on a locked track is skipped', () => {
    const { ids } = open((v) => [mkImage(v, 0)], true);
    const a = ids[0]!;
    const before = proj();
    ed().updateClip(a, { bend: { angle: 45 } });
    ed().setBends([{ id: a, bend: { angle: 45 } }]);
    expect(proj()).toBe(before);
  });
});

describe('old projects', () => {
  it('an old project without bend saves the same json', () => {
    const { ids } = open((v) => [mkImage(v, 0), mkImage(v, 4)]);
    const before = JSON.stringify(proj());
    ed().updateClip(ids[0]!, { bend: null });
    ed().updateClip(ids[0]!, { pivot: null });
    ed().setBends([{ id: ids[1]!, bend: null, keys: null }]);
    expect(JSON.stringify(proj())).toBe(before);
    expect(before).not.toContain('bend');
    expect(before).not.toContain('pivot');
  });
});
