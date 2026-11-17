import { beforeEach, describe, expect, it } from 'vitest';
import type { Clip, ImageClip, MediaAsset, Project, VideoClip } from '../types';
import { DEFAULT_TRANSFORM } from '../types';
import { createProject } from '../lib/factory';
import type { TrimOp } from './editorStore';
import { moveClipsIn, runTrimOps, setClipSpeedIn, slipClipIn, trimClipIn, useEditor } from './editorStore';

const ed = () => useEditor.getState();
const proj = (): Project => ed().project!;
const clipIn = (p: Project, id: string) => p.clips.find((c) => c.id === id) as VideoClip;
const clipOf = (id: string) => clipIn(proj(), id);

const asset = (id: string, duration: number): MediaAsset => ({ id, name: id, kind: 'video', mime: 'video/mp4', size: 1, duration, width: 1920, height: 1080, hasAudio: true, createdAt: 0 });
const imageAsset: MediaAsset = { id: 'img', name: 'img', kind: 'image', mime: 'image/png', size: 1, duration: 0, width: 100, height: 100, hasAudio: false, createdAt: 0 };

function mkVideo(id: string, trackId: string, start: number, duration: number, over: Partial<VideoClip> = {}): VideoClip {
  return { id, type: 'video', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'va', trimStart: 0, speed: 1, volume: 1, muted: false, transform: { ...DEFAULT_TRANSFORM }, ...over };
}
function mkImage(id: string, trackId: string, start: number, duration: number): ImageClip {
  return { id, type: 'image', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'img', transform: { ...DEFAULT_TRANSFORM } };
}

/** a track with A [0, 4), B [4, 8) and C [10, 12) over a 20 s file (unknown = a file of length 0) */
function open(opts: { unknown?: boolean; lock?: boolean } = {}): { v: string; a: string; b: string; c: string } {
  const p = createProject('trim');
  const v = p.tracks[0]!.id;
  const tracks = opts.lock ? p.tracks.map((t, i) => (i === 0 ? { ...t, locked: true } : t)) : p.tracks;
  const clips: Clip[] = [mkVideo('a', v, 0, 4, { trimStart: 2 }), mkVideo('b', v, 4, 4, { trimStart: 6 }), mkVideo('c', v, 10, 2), mkImage('i', v, 14, 2)];
  ed().openProject({ ...p, tracks, assets: [asset('va', opts.unknown ? 0 : 20), imageAsset], clips });
  return { v, a: 'a', b: 'b', c: 'c' };
}

beforeEach(() => {
  useEditor.setState({ project: null, selection: [], past: [], future: [], clipboard: [] });
});

describe('the trim cores', () => {
  it('the cores equal the actions and answer null on no change or refusal', () => {
    const { v } = open();
    const p = proj();
    const viaCore = trimClipIn(p, 'a', 'end', 3)!;
    expect(viaCore).not.toBeNull();
    ed().trimClip('a', 'end', 3);
    expect(proj()).toEqual(viaCore);
    ed().openProject(p);
    const moved = moveClipsIn(p, [{ id: 'c', trackId: v, start: 12 }])!;
    expect(ed().moveClips([{ id: 'c', trackId: v, start: 12 }])).toBe(true);
    expect(proj()).toEqual(moved);
    ed().openProject(p);
    const fast = setClipSpeedIn(p, 'c', 2)!;
    ed().setClipSpeed('c', 2);
    expect(proj()).toEqual(fast);
    ed().openProject(p);
    const slipped = slipClipIn(p, 'a', 3)!;
    expect(ed().slipClip('a', 3)).toBe(true);
    expect(proj()).toEqual(slipped);
    ed().openProject(p);
    expect(ed().slipClip('a', 0)).toBe(false);
    // no change
    expect(trimClipIn(p, 'a', 'end', 4)).toBeNull();
    expect(setClipSpeedIn(p, 'a', 1)).toBeNull();
    expect(moveClipsIn(p, [{ id: 'a', trackId: v, start: 0 }])).toBeNull();
    expect(moveClipsIn(p, [])).toBeNull();
    // refusal: onto a neighbour, a negative start, a gone clip
    expect(moveClipsIn(p, [{ id: 'a', trackId: v, start: 2 }])).toBeNull();
    expect(moveClipsIn(p, [{ id: 'a', trackId: v, start: -1 }])).toBeNull();
    expect(trimClipIn(p, 'gone', 'end', 3)).toBeNull();
    expect(ed().moveClips([{ id: 'a', trackId: v, start: 2 }])).toBe(false);
  });

  it('slipClipIn changes only trimStart, clamped at 0 and the media end', () => {
    open();
    const p = proj();
    const before = clipIn(p, 'a');
    const next = slipClipIn(p, 'a', 3)!;
    const after = clipIn(next, 'a');
    expect(after.trimStart).toBe(5);
    expect({ ...after, trimStart: before.trimStart }).toEqual(before);
    expect(clipIn(slipClipIn(p, 'a', -10)!, 'a').trimStart).toBe(0);
    // a is 4 s long over a 20 s file: the last start is 16
    expect(clipIn(slipClipIn(p, 'a', 100)!, 'a').trimStart).toBe(16);
    expect(slipClipIn(p, 'a', 0)).toBeNull();
    expect(slipClipIn(p, 'a', Number.NaN)).toBeNull();
    // at the limit already: nothing to do
    expect(slipClipIn(next, 'a', -3.0000000001)).not.toBeNull();
    expect(slipClipIn(slipClipIn(p, 'a', 100)!, 'a', 5)).toBeNull();
  });

  it('slipClipIn refuses pictures and locked tracks and has no upper limit for an unknown length', () => {
    open();
    expect(slipClipIn(proj(), 'i', 1)).toBeNull();
    expect(slipClipIn(proj(), 'gone', 1)).toBeNull();
    open({ lock: true });
    expect(slipClipIn(proj(), 'a', 1)).toBeNull();
    open({ unknown: true });
    expect(clipIn(slipClipIn(proj(), 'a', 500)!, 'a').trimStart).toBe(502);
  });
});

describe('runTrimOps', () => {
  it('runTrimOps runs shrink, move, grow where the reverse order fails', () => {
    const { v } = open();
    const p = proj();
    // shrink a, then close up b
    const shrink: TrimOp[] = [
      { kind: 'trim', id: 'a', edge: 'end', time: 2 },
      { kind: 'move', moves: [{ id: 'b', trackId: v, start: 2 }] },
    ];
    const s = runTrimOps(p, shrink)!;
    expect(s).not.toBeNull();
    expect(clipIn(s, 'a').duration).toBe(2);
    expect(clipIn(s, 'b').start).toBe(2);
    expect(runTrimOps(p, [shrink[1]!, shrink[0]!])).toBeNull();
    // grow a: b has to leave first
    const grow: TrimOp[] = [
      { kind: 'move', moves: [{ id: 'b', trackId: v, start: 6 }] },
      { kind: 'trim', id: 'a', edge: 'end', time: 6 },
    ];
    const g = runTrimOps(p, grow)!;
    expect(clipIn(g, 'a').duration).toBe(6);
    expect(clipIn(g, 'b').start).toBe(6);
    expect(runTrimOps(p, [grow[1]!, grow[0]!])).toBeNull();
  });

  it('runTrimOps runs a slide shaped plan of a shrink, a move and a grow', () => {
    const p = createProject('slide');
    const v = p.tracks[0]!.id;
    ed().openProject({ ...p, assets: [asset('va', 20)], clips: [mkVideo('l', v, 0, 4), mkVideo('m', v, 4, 4, { trimStart: 4 }), mkVideo('r', v, 8, 4, { trimStart: 8 })] });
    const q = proj();
    const plan: TrimOp[] = [
      { kind: 'trim', id: 'r', edge: 'start', time: 9 },
      { kind: 'move', moves: [{ id: 'm', trackId: v, start: 5 }] },
      { kind: 'trim', id: 'l', edge: 'end', time: 5 },
    ];
    const out = runTrimOps(q, plan)!;
    expect(out).not.toBeNull();
    expect(clipIn(out, 'r').start).toBe(9);
    expect(clipIn(out, 'm').start).toBe(5);
    expect(clipIn(out, 'l').duration).toBe(5);
    expect(runTrimOps(q, [...plan].reverse())).toBeNull();
  });

  it('runTrimOps skips done ops and answers null when an op is refused or falls short', () => {
    const { v } = open();
    const p = proj();
    // everything already holds: the same project comes back
    const done: TrimOp[] = [
      { kind: 'trim', id: 'a', edge: 'end', time: 4 },
      { kind: 'trim', id: 'b', edge: 'start', time: 4 },
      { kind: 'move', moves: [{ id: 'c', trackId: v, start: 10 }] },
      { kind: 'speed', id: 'c', speed: 1 },
      { kind: 'slip', id: 'a', trimStart: 2 },
    ];
    expect(runTrimOps(p, done)).toBe(p);
    expect(runTrimOps(p, [])).toBe(p);
    // a gone clip, a picture asked to slip or change speed
    expect(runTrimOps(p, [{ kind: 'trim', id: 'gone', edge: 'end', time: 3 }])).toBeNull();
    expect(runTrimOps(p, [{ kind: 'slip', id: 'i', trimStart: 1 }])).toBeNull();
    expect(runTrimOps(p, [{ kind: 'speed', id: 'i', speed: 2 }])).toBeNull();
    // refused: an overlap
    expect(runTrimOps(p, [{ kind: 'move', moves: [{ id: 'a', trackId: v, start: 2 }] }])).toBeNull();
    // falls short: c may grow to 10 + 10 s at most (20 s file, trimStart 0), and b is in the way of a
    expect(runTrimOps(p, [{ kind: 'trim', id: 'c', edge: 'end', time: 40 }])).toBeNull();
    expect(runTrimOps(p, [{ kind: 'trim', id: 'a', edge: 'end', time: 6 }])).toBeNull();
    // a speed that the next clip stops from landing
    expect(runTrimOps(p, [{ kind: 'speed', id: 'a', speed: 0.5 }])).toBeNull();
    // slip past the media end falls short
    expect(runTrimOps(p, [{ kind: 'slip', id: 'a', trimStart: 99 }])).toBeNull();
    // and it does work when there is room
    const ok = runTrimOps(p, [{ kind: 'speed', id: 'c', speed: 2 }, { kind: 'slip', id: 'a', trimStart: 5 }])!;
    expect(clipIn(ok, 'c').speed).toBe(2);
    expect(clipIn(ok, 'c').duration).toBe(1);
    expect(clipIn(ok, 'a').trimStart).toBe(5);
  });
});

describe('applyTrimPlan', () => {
  const ripple = (v: string): TrimOp[] => [
    { kind: 'trim', id: 'a', edge: 'end', time: 2 },
    { kind: 'move', moves: [{ id: 'b', trackId: v, start: 2 }] },
  ];

  it('applyTrimPlan is one undo step', () => {
    const { v } = open();
    const json = JSON.stringify(proj());
    expect(ed().applyTrimPlan(ripple(v))).toBe(true);
    expect(clipOf('a').duration).toBe(2);
    expect(clipOf('b').start).toBe(2);
    expect(ed().past).toHaveLength(1);
    ed().undo();
    expect(JSON.stringify(proj())).toBe(json);
  });

  it('applyTrimPlan with from keeps the current assets and markers', () => {
    const { v } = open();
    const from = proj().clips;
    ed().applyTrimPlan([{ kind: 'trim', id: 'a', edge: 'end', time: 3 }]);
    ed().addMarker(5, 'mark');
    ed().renameAsset('va', 'renamed');
    ed().applyTrimPlan(ripple(v), { from });
    // the plan ran on the old clips: a is 2 s long, not 3 s
    expect(clipOf('a').duration).toBe(2);
    expect(clipOf('b').start).toBe(2);
    expect(proj().markers).toHaveLength(1);
    expect(proj().assets.find((a) => a.id === 'va')!.name).toBe('renamed');
  });

  it('a refused plan changes nothing and answers false', () => {
    const { v } = open();
    const before = proj();
    expect(ed().applyTrimPlan([{ kind: 'move', moves: [{ id: 'a', trackId: v, start: 2 }] }])).toBe(false);
    expect(proj()).toBe(before);
    expect(ed().past).toHaveLength(0);
    expect(ed().applyTrimPlan([{ kind: 'trim', id: 'a', edge: 'end', time: 6 }])).toBe(false);
    expect(proj()).toBe(before);
    // nothing to do is not a refusal
    expect(ed().applyTrimPlan([])).toBe(true);
    expect(ed().past).toHaveLength(0);
    ed().closeProject();
    expect(ed().applyTrimPlan(ripple(v))).toBe(false);
  });

  it('pushHistory then skipHistory applies make one step', () => {
    const { v } = open();
    const json = JSON.stringify(proj());
    const from = proj().clips;
    ed().pushHistory();
    expect(ed().applyTrimPlan(ripple(v), { skipHistory: true, from })).toBe(true);
    expect(ed().past).toHaveLength(1);
    // a drag replans from the clips of its first move
    expect(ed().applyTrimPlan([{ kind: 'trim', id: 'a', edge: 'end', time: 3 }], { skipHistory: true, from })).toBe(true);
    expect(ed().past).toHaveLength(1);
    expect(clipOf('a').duration).toBe(3);
    expect(clipOf('b').start).toBe(4);
    ed().undo();
    expect(JSON.stringify(proj())).toBe(json);
    expect(ed().past).toHaveLength(0);
  });

  it('a rollback after a drag puts the press project back', () => {
    const { v } = open();
    const json = JSON.stringify(proj());
    ed().pushHistory();
    ed().applyTrimPlan(ripple(v), { skipHistory: true });
    ed().rollback();
    expect(JSON.stringify(proj())).toBe(json);
    expect(ed().past).toHaveLength(0);
  });
});
