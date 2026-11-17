import { beforeEach, describe, expect, it } from 'vitest';
import type { Clip, ImageClip, Keyframe, Project } from '../types';
import { DEFAULT_TRANSFORM } from '../types';
import { createProject } from '../lib/factory';
import { useEditor } from './editorStore';

const ed = () => useEditor.getState();
const proj = (): Project => ed().project!;
const clipOf = (id: string): ImageClip => proj().clips.find((c) => c.id === id) as ImageClip;
const k = (t: number, v: number): Keyframe => ({ t, v, ease: 'linear' });

let seq = 0;
function mkImage(trackId: string, start: number, duration: number, over: Partial<ImageClip> = {}): ImageClip {
  return {
    id: `cv${++seq}`,
    type: 'image',
    trackId,
    start,
    duration,
    name: 'i',
    fadeIn: 0,
    fadeOut: 0,
    assetId: 'img',
    transform: { ...DEFAULT_TRANSFORM },
    ...over,
  };
}

const ASSETS = [{ id: 'img', name: 'img', kind: 'image' as const, mime: 'image/png', size: 1, duration: 0, width: 100, height: 100, hasAudio: false, createdAt: 0 }];

function open(make: (v: string, v2: string) => Clip[]): { v: string; v2: string; ids: string[] } {
  useEditor.setState({ clipboard: [] });
  const p = createProject('cv');
  const v = p.tracks[0]!.id;
  const v2 = p.tracks[1]!.id;
  const clips = make(v, v2);
  ed().openProject({ ...p, assets: [...ASSETS], clips });
  return { v, v2, ids: clips.map((c) => c.id) };
}

beforeEach(() => {
  useEditor.setState({ project: null, selection: [], past: [], future: [], clipboard: [] });
});

describe('setClipValues', () => {
  it('setClipValues writes three clips in one undo step', () => {
    const { ids } = open((v) => [mkImage(v, 0, 2), mkImage(v, 2, 2), mkImage(v, 4, 2)]);
    ed().setClipValues(
      ids.map((id, i) => ({ id, prop: 'x', time: i * 2, value: 10 * (i + 1) })),
    );
    expect(ids.map((id) => clipOf(id).transform.x)).toEqual([10, 20, 30]);
    expect(ed().past).toHaveLength(1);
    ed().undo();
    expect(ids.map((id) => clipOf(id).transform.x)).toEqual([0, 0, 0]);
  });
  it('setClipValues notifies the store once', () => {
    const { ids } = open((v) => [mkImage(v, 0, 2), mkImage(v, 2, 2), mkImage(v, 4, 2)]);
    let calls = 0;
    const off = useEditor.subscribe(() => {
      calls += 1;
    });
    ed().setClipValues(ids.map((id, i) => ({ id, prop: 'y', time: i * 2, value: 5 })));
    off();
    expect(calls).toBe(1);
  });
  it('a keyed prop gets a key at the edit time, clamped into the clip', () => {
    const { ids } = open((v) => [mkImage(v, 5, 4, { keyframes: { x: [k(0, 0), k(4, 40)] } })]);
    ed().setClipValues([{ id: ids[0]!, prop: 'x', time: 6, value: 77 }]);
    expect(clipOf(ids[0]!).keyframes!.x!.map((q) => [q.t, q.v])).toEqual([
      [0, 0],
      [1, 77],
      [4, 40],
    ]);
    // a time past the end lands on the last moment of the clip
    ed().setClipValues([{ id: ids[0]!, prop: 'x', time: 99, value: 55 }]);
    expect(clipOf(ids[0]!).keyframes!.x!.map((q) => [q.t, q.v])).toEqual([
      [0, 0],
      [1, 77],
      [4, 55],
    ]);
    expect(clipOf(ids[0]!).transform.x).toBe(0);
  });
  it('a static prop gets its base value', () => {
    const { ids } = open((v) => [mkImage(v, 0, 4)]);
    ed().setClipValues([{ id: ids[0]!, prop: 'opacity', time: 1, value: 0.4 }]);
    expect(clipOf(ids[0]!).transform.opacity).toBe(0.4);
    expect(clipOf(ids[0]!).keyframes).toBeUndefined();
  });
  it('a clip on a locked track is skipped, the others change', () => {
    const { ids, v2 } = open((v, v2) => [mkImage(v, 0, 2), mkImage(v2, 0, 2)]);
    ed().updateTrack(v2, { locked: true });
    ed().setClipValues(ids.map((id) => ({ id, prop: 'x', time: 0, value: 50 })));
    expect(clipOf(ids[0]!).transform.x).toBe(50);
    expect(clipOf(ids[1]!).transform.x).toBe(0);
  });
  it('values are clamped per clip like setClipValue', () => {
    const { ids } = open((v) => [mkImage(v, 0, 2), mkImage(v, 2, 2)]);
    ed().setClipValues([{ id: ids[0]!, prop: 'scale', time: 0, value: 200 }]);
    ed().setClipValue(ids[1]!, 'scale', 2, 200);
    expect(clipOf(ids[0]!).transform.scale).toBe(100);
    expect(clipOf(ids[0]!).transform.scale).toBe(clipOf(ids[1]!).transform.scale);
  });
  it('a list that changes nothing leaves past as it was', () => {
    const { ids } = open((v) => [mkImage(v, 0, 2)]);
    const before = proj();
    ed().setClipValues([
      { id: ids[0]!, prop: 'x', time: 0, value: 0 },
      { id: 'missing', prop: 'x', time: 0, value: 5 },
      { id: ids[0]!, prop: 'nope', time: 0, value: 5 },
      { id: ids[0]!, prop: 'x', time: 0, value: Number.NaN },
    ]);
    expect(ed().past).toHaveLength(0);
    expect(proj()).toBe(before);
  });
  it('setClipValue behaves as before', () => {
    const { ids } = open((v) => [mkImage(v, 5, 10, { keyframes: { x: [k(0, 0), k(10, 100)] } }), mkImage(v, 20, 2)]);
    ed().setClipValue(ids[0]!, 'x', 10, 777);
    expect(clipOf(ids[0]!).keyframes!.x!.map((q) => [q.t, q.v])).toEqual([
      [0, 0],
      [5, 777],
      [10, 100],
    ]);
    // the time is used as given, no clamp (setClipValues clamps it)
    ed().setClipValue(ids[0]!, 'x', 5 + 10 + 5, 55);
    expect(clipOf(ids[0]!).keyframes!.x!.map((q) => q.t)).toEqual([0, 5, 10, 15]);
    expect(clipOf(ids[0]!).keyframes!.x![3]!.v).toBe(55);
    ed().setClipValue(ids[1]!, 'x', 99, 12);
    expect(clipOf(ids[1]!).transform.x).toBe(12);
    const n = ed().past.length;
    ed().setClipValue(ids[1]!, 'x', 99, 12);
    expect(ed().past).toHaveLength(n);
    ed().setClipValue('missing', 'x', 0, 1);
    expect(ed().past).toHaveLength(n);
  });
});
