import { beforeEach, describe, expect, it } from 'vitest';
import type { Clip, EffectClip, MediaAsset, Project, VideoClip } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import { createProject } from '../../lib/factory';
import { useEditor } from '../../store/editorStore';
import { planGroupTrim } from './groupTrim';

const ed = () => useEditor.getState();
const proj = (): Project => ed().project!;
const clipOf = (id: string): Clip => proj().clips.find((c) => c.id === id)!;
const end = (id: string): number => clipOf(id).start + clipOf(id).duration;

const asset = (id: string, duration: number): MediaAsset => ({
  id, name: id, kind: 'video', mime: 'video/x', size: 1, duration, width: 100, height: 100, hasAudio: false, createdAt: 0,
});
const video = (trackId: string, id: string, start: number, duration: number, assetId = 'long'): VideoClip => ({
  id, type: 'video', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId, trimStart: 0, speed: 1, volume: 1, muted: false, transform: { ...DEFAULT_TRANSFORM },
});
const fx = (trackId: string, id: string, target: string | null, start: number, duration: number): EffectClip => ({
  id, type: 'effect', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, effect: 'shake', params: {}, amount: 1, seed: 1, target,
});

/** returns the ids of the tracks (the new project has its own, two more video tracks are added) */
function open(make: (t: string[]) => Clip[]): string[] {
  ed().openProject({ ...createProject('gt'), assets: [asset('long', 100), asset('short', 6)], clips: [] });
  for (let i = 0; i < 2; i++) ed().addTrack('video');
  const ids = proj().tracks.map((t) => t.id);
  useEditor.setState({ project: { ...proj(), clips: make(ids) }, past: [], future: [] });
  return ids;
}

/** what the drag does on every step: plan from the start state, apply through the store */
function drag(base: Project, selection: string[], grabbed: string, edge: 'start' | 'end', delta: number): void {
  for (const s of planGroupTrim(base.clips, base.tracks, selection, grabbed, edge, delta)) ed().trimClip(s.id, edge, s.time, { skipHistory: true });
}

beforeEach(() => {
  useEditor.setState({ project: null, past: [], future: [], selection: [] });
});

describe('planGroupTrim', () => {
  it('asks every selected clip for its own edge plus the delta, the grabbed one first', () => {
    open((t) => [video(t[0]!, 'a', 0, 4), video(t[1]!, 'b', 2, 5), video(t[1]!, 'c', 20, 2)]);
    const p = proj();
    expect(planGroupTrim(p.clips, p.tracks, ['a', 'b'], 'b', 'end', 1.5)).toEqual([
      { id: 'b', time: 8.5 },
      { id: 'a', time: 5.5 },
    ]);
    expect(planGroupTrim(p.clips, p.tracks, ['a', 'b'], 'a', 'start', -0.5)).toEqual([
      { id: 'a', time: -0.5 },
      { id: 'b', time: 1.5 },
    ]);
  });

  it('a selection without the grabbed clip is just that clip', () => {
    open((t) => [video(t[0]!, 'a', 0, 4), video(t[1]!, 'b', 2, 5)]);
    const p = proj();
    expect(planGroupTrim(p.clips, p.tracks, ['a'], 'b', 'end', 1)).toEqual([{ id: 'b', time: 8 }]);
  });

  it('keeps clips on locked tracks out', () => {
    const t = open((t) => [video(t[0]!, 'a', 0, 4), video(t[1]!, 'b', 2, 5)]);
    ed().updateTrack(t[1]!, { locked: true }, { skipHistory: true });
    const p = proj();
    expect(planGroupTrim(p.clips, p.tracks, ['a', 'b'], 'a', 'end', 1)).toEqual([{ id: 'a', time: 5 }]);
  });

  it('leaves an effect that follows a selected clip to that clip', () => {
    open((t) => [video(t[0]!, 'a', 0, 4), fx(t[1]!, 'e', 'a', 0, 4), fx(t[1]!, 'free', null, 10, 2)]);
    const p = proj();
    expect(planGroupTrim(p.clips, p.tracks, ['a', 'e', 'free'], 'a', 'end', 1).map((s) => s.id)).toEqual(['a', 'free']);
  });

  it('delta 0 asks every clip for the edge it has and changes nothing', () => {
    open((t) => [video(t[0]!, 'a', 1, 4), video(t[1]!, 'b', 2, 5)]);
    const p = proj();
    expect(planGroupTrim(p.clips, p.tracks, ['a', 'b'], 'a', 'start', 0)).toEqual([
      { id: 'a', time: 1 },
      { id: 'b', time: 2 },
    ]);
    drag(p, ['a', 'b'], 'a', 'start', 0);
    expect(proj()).toBe(p);
  });
});

describe('group trim with the store', () => {
  it('extends and shortens clips on two tracks by the same amount', () => {
    open((t) => [video(t[0]!, 'a', 0, 4), video(t[1]!, 'b', 2, 5)]);
    drag(proj(), ['a', 'b'], 'a', 'end', 2);
    expect([end('a'), end('b')]).toEqual([6, 9]);
    drag(proj(), ['a', 'b'], 'b', 'start', 1);
    expect([clipOf('a').start, clipOf('b').start]).toEqual([1, 3]);
  });

  it('two neighbours on one track: the left one cannot grow into the right one, the right one can', () => {
    open((t) => [video(t[0]!, 'a', 0, 4), video(t[0]!, 'b', 4, 4)]);
    drag(proj(), ['a', 'b'], 'b', 'end', 3);
    expect(end('a')).toBe(4);
    expect(end('b')).toBe(11);
  });

  it('a clip that hits its source length stops while another keeps growing', () => {
    open((t) => [video(t[0]!, 'a', 0, 4, 'short'), video(t[1]!, 'b', 0, 4)]);
    drag(proj(), ['a', 'b'], 'b', 'end', 5);
    expect(end('a')).toBe(6);
    expect(end('b')).toBe(9);
  });

  it('leaves a clip on a locked track alone', () => {
    const t = open((t) => [video(t[0]!, 'a', 0, 4), video(t[1]!, 'b', 0, 4)]);
    ed().updateTrack(t[1]!, { locked: true }, { skipHistory: true });
    drag(proj(), ['a', 'b'], 'a', 'end', 2);
    expect([end('a'), end('b')]).toEqual([6, 4]);
  });

  it('dragging out and back gives the start state', () => {
    open((t) => [video(t[0]!, 'a', 1, 4), video(t[1]!, 'b', 2, 5)]);
    const base = proj();
    const before = base.clips.map((c) => ({ id: c.id, start: c.start, duration: c.duration }));
    drag(base, ['a', 'b'], 'a', 'start', 0.7);
    drag(base, ['a', 'b'], 'a', 'start', -0.4);
    drag(base, ['a', 'b'], 'a', 'start', 0);
    expect(proj().clips.map((c) => ({ id: c.id, start: c.start, duration: c.duration }))).toEqual(before);
  });
});
