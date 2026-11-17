import { beforeEach, describe, expect, it } from 'vitest';
import type { Clip, ImageClip, Keyframe, MediaAsset, Project } from '../types';
import { DEFAULT_TRANSFORM } from '../types';
import { createProject } from '../lib/factory';
import { useEditor } from './editorStore';

const ed = () => useEditor.getState();
const proj = (): Project => ed().project!;
const clipOf = (id: string): ImageClip => proj().clips.find((c) => c.id === id) as ImageClip;
const lin = (...pairs: [number, number][]): Keyframe[] => pairs.map(([t, v]) => ({ t, v, ease: 'linear' as const }));

const asset: MediaAsset = { id: 'img1', name: 'img1', kind: 'image', mime: 'image/png', size: 1, duration: 0, width: 100, height: 100, hasAudio: false, createdAt: 0 };
const image = (trackId: string, id: string, start: number, duration: number, over: Partial<ImageClip> = {}): ImageClip => ({
  id, type: 'image', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'img1', transform: { ...DEFAULT_TRANSFORM }, ...over,
});

/** a project with two video tracks and the clips make gives. history is empty */
function open(make: (tracks: string[]) => Clip[]): string[] {
  ed().openProject({ ...createProject('keylanes'), assets: [asset], clips: [] });
  ed().addTrack('video');
  const ids = proj().tracks.map((t) => t.id);
  useEditor.setState({ project: { ...proj(), clips: make(ids) }, past: [], future: [], selection: [] });
  return ids;
}

beforeEach(() => {
  useEditor.setState({ project: null, selection: [], past: [], future: [], clipboard: [] });
});

describe('setManyKeyframes', () => {
  it('many clips in one step', () => {
    open((t) => [image(t[0]!, 'a', 0, 4, { keyframes: { x: lin([0, 0], [1, 10]) } }), image(t[1]!, 'b', 2, 4, { keyframes: { y: lin([0, 0], [1, 10]) } }), image(t[0]!, 'c', 8, 2)]);
    const before = proj();
    const changed = ed().setManyKeyframes([
      { id: 'a', keyframes: { x: lin([0, 0], [2, 10]) } },
      { id: 'b', keyframes: { y: lin([1, 5], [2, 10]) } },
      { id: 'c', keyframes: { opacity: lin([0, 1], [1, 0]) } },
    ]);
    expect(changed).toBe(true);
    expect(ed().past).toHaveLength(1);
    expect(clipOf('a').keyframes!.x!.map((k) => k.t)).toEqual([0, 2]);
    expect(clipOf('b').keyframes!.y!.map((k) => k.t)).toEqual([1, 2]);
    expect(clipOf('c').keyframes!.opacity).toHaveLength(2);
    ed().undo();
    expect(proj().clips).toEqual(before.clips);
    ed().redo();
    expect(clipOf('a').keyframes!.x!.map((k) => k.t)).toEqual([0, 2]);
    // start, duration and track never change
    for (const id of ['a', 'b', 'c']) {
      const was = before.clips.find((c) => c.id === id)!;
      expect([clipOf(id).start, clipOf(id).duration, clipOf(id).trackId]).toEqual([was.start, was.duration, was.trackId]);
    }
  });

  it('skips locked, missing, unchanged', () => {
    const t = open((tr) => [image(tr[0]!, 'a', 0, 4, { keyframes: { x: lin([0, 0], [1, 10]) } }), image(tr[1]!, 'b', 0, 4, { keyframes: { x: lin([0, 0], [1, 10]) } }), image(tr[0]!, 'c', 8, 2)]);
    ed().updateTrack(t[1]!, { locked: true }, { skipHistory: true });
    const before = proj();
    const writes = [
      { id: 'b', keyframes: { x: lin([0, 0], [3, 10]) } },
      { id: 'zz', keyframes: { x: lin([0, 0]) } },
      { id: 'a', keyframes: { x: lin([0, 0], [1, 10]) } },
    ];
    expect(ed().setManyKeyframes(writes)).toBe(false);
    expect(proj()).toBe(before);
    // the good write still goes, the skipped ones stay as they were
    expect(ed().setManyKeyframes([...writes, { id: 'c', keyframes: { x: lin([0, 1]) } }])).toBe(true);
    expect(clipOf('b').keyframes!.x![1]!.t).toBe(1);
    expect(clipOf('a')).toBe(before.clips[0]);
    expect(clipOf('c').keyframes!.x).toHaveLength(1);
    expect(ed().past).toHaveLength(1);
  });

  it('no step for nothing', () => {
    open((t) => [image(t[0]!, 'a', 0, 4, { keyframes: { x: lin([0, 0], [1, 10]) } })]);
    const before = proj();
    expect(ed().setManyKeyframes([])).toBe(false);
    expect(ed().setManyKeyframes([{ id: 'a', keyframes: { x: lin([0, 0], [1, 10]) } }])).toBe(false);
    expect(ed().setManyKeyframes([{ id: 'gone', keyframes: {} }])).toBe(false);
    expect(proj()).toBe(before);
    expect(ed().past).toHaveLength(0);
  });

  it('a value losing all keys freezes at the clamped time', () => {
    open((t) => [image(t[0]!, 'a', 2, 4, { keyframes: { x: lin([0, 0], [4, 40]) } }), image(t[0]!, 'b', 10, 4, { keyframes: { x: lin([0, 0], [4, 40]) } }), image(t[0]!, 'c', 20, 4, { keyframes: { x: lin([0, 0], [4, 40]) } })]);
    // the time is a timeline time: 3 s is 1 s into a. b starts later (clamped to its start), c ends sooner (clamped to its end)
    ed().setManyKeyframes([{ id: 'a', keyframes: {} }, { id: 'b', keyframes: {} }], { time: 3 });
    expect(clipOf('a').transform.x).toBeCloseTo(10, 9);
    expect(clipOf('a').keyframes).toBeUndefined();
    expect(clipOf('b').transform.x).toBeCloseTo(0, 9);
    ed().setManyKeyframes([{ id: 'c', keyframes: {} }], { time: 100 });
    expect(clipOf('c').transform.x).toBeCloseTo(40, 9);
    // no time: the clip's start
    open((t) => [image(t[0]!, 'a', 2, 4, { keyframes: { x: lin([0, 7], [4, 40]) } })]);
    ed().setManyKeyframes([{ id: 'a', keyframes: {} }]);
    expect(clipOf('a').transform.x).toBeCloseTo(7, 9);
    // a value that keeps a key keeps no frozen value
    open((t) => [image(t[0]!, 'a', 2, 4, { keyframes: { x: lin([0, 7], [4, 40]) } })]);
    ed().setManyKeyframes([{ id: 'a', keyframes: { x: lin([1, 9]) } }], { time: 5 });
    expect(clipOf('a').transform.x).toBe(0);
  });

  it('skipHistory joins the pushHistory step', () => {
    open((t) => [image(t[0]!, 'a', 0, 8, { keyframes: { x: lin([0, 0], [4, 40]) } })]);
    const before = proj();
    ed().pushHistory();
    ed().setManyKeyframes([{ id: 'a', keyframes: { x: lin([0, 0], [3, 40]) } }], { skipHistory: true });
    ed().setManyKeyframes([{ id: 'a', keyframes: { x: lin([0, 0], [2, 40]) } }], { skipHistory: true });
    expect(ed().past).toHaveLength(1);
    expect(clipOf('a').keyframes!.x![1]!.t).toBe(2);
    ed().undo();
    expect(proj().clips).toEqual(before.clips);
    expect(ed().past).toHaveLength(0);
  });

  it('undo keeps the snapshot clips array', () => {
    open((t) => [image(t[0]!, 'a', 0, 8, { keyframes: { x: lin([0, 0], [4, 40]) } })]);
    const clips = proj().clips;
    ed().setManyKeyframes([{ id: 'a', keyframes: { x: lin([0, 0], [3, 40]) } }]);
    const after = proj().clips;
    expect(after).not.toBe(clips);
    ed().undo();
    expect(proj().clips).toBe(clips);
    ed().redo();
    expect(proj().clips).toBe(after);
  });
});
