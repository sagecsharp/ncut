import { beforeEach, describe, expect, it } from 'vitest';
import type { Clip, EffectClip, ImageClip, Project } from '../types';
import { DEFAULT_TRANSFORM, MIN_CLIP_DURATION } from '../types';
import { DEFAULT_EFFECT_DURATION, createProject } from '../lib/factory';
import { useEditor } from './editorStore';

const ed = () => useEditor.getState();
const proj = (): Project => ed().project!;
const clipOf = (id: string): Clip => proj().clips.find((c) => c.id === id)!;
const fxOf = (id: string): EffectClip => clipOf(id) as EffectClip;

let seq = 0;
function mkImage(trackId: string, start: number, duration: number): ImageClip {
  return {
    id: `mi${++seq}`,
    type: 'image',
    trackId,
    start,
    duration,
    name: 'i',
    fadeIn: 0,
    fadeOut: 0,
    assetId: 'img',
    transform: { ...DEFAULT_TRANSFORM },
  };
}

function fresh(): { v: string; a: string } {
  useEditor.setState({ clipboard: [] });
  const p = createProject('test');
  ed().openProject({
    ...p,
    assets: [
      { id: 'img', name: 'img', kind: 'image', mime: 'image/png', size: 1, duration: 0, width: 1920, height: 1080, hasAudio: false, createdAt: 0 },
    ],
  });
  return { v: p.tracks[0]!.id, a: p.tracks[1]!.id };
}

/** put a plain clip straight into the project, without history */
function put(...clips: Clip[]): void {
  useEditor.setState({ project: { ...proj(), clips: [...proj().clips, ...clips] } });
}

/** an effect clip with distinctive params / amount / seed */
function mkFx(trackId: string, start = 0, duration = 4): string {
  const id = ed().addEffect('shake', { trackId, start, duration })!;
  ed().setEffectParam(id, 'strength', 77);
  ed().setEffectParam(id, 'speed', 5);
  ed().updateClip(id, { amount: 0.6, seed: 321 });
  return id;
}

function expectSame(c: Clip, ref: EffectClip): void {
  expect(c.type).toBe('effect');
  const e = c as EffectClip;
  expect(e.effect).toBe(ref.effect);
  expect(e.params).toEqual(ref.params);
  expect(e.amount).toBe(ref.amount);
  expect(e.seed).toBe(ref.seed);
}

beforeEach(() => {
  fresh();
});

describe('addEffect', () => {
  it('returns null for an unknown effect and records nothing', () => {
    expect(ed().addEffect('does-not-exist')).toBeNull();
    expect(ed().addEffect('')).toBeNull();
    expect(proj().clips).toHaveLength(0);
    expect(proj().tracks).toHaveLength(2);
    expect(ed().past).toHaveLength(0);
    expect(ed().selection).toEqual([]);
  });

  it('does nothing without a project', () => {
    ed().closeProject();
    expect(ed().addEffect('shake')).toBeNull();
  });

  it('puts the clip on the top video track by default', () => {
    const top = proj().tracks[0]!.id;
    const id = ed().addEffect('shake')!;
    const c = fxOf(id);
    expect(c.type).toBe('effect');
    expect(c.effect).toBe('shake');
    expect(c.name).toBe('shake');
    expect(c.trackId).toBe(top);
    expect(c.start).toBe(0);
    expect(c.duration).toBe(DEFAULT_EFFECT_DURATION);
    expect(c.amount).toBe(1);
    expect(c.params).toEqual({});
    expect(proj().tracks).toHaveLength(2);
  });

  it('uses the start option on the top track when it is free', () => {
    const top = proj().tracks[0]!.id;
    put(mkImage(top, 0, 2));
    const id = ed().addEffect('shake', { start: 5 })!;
    expect(fxOf(id).trackId).toBe(top);
    expect(fxOf(id).start).toBe(5);
    expect(proj().tracks).toHaveLength(2);
  });

  it('makes a new video track at index 0 when the top track is busy', () => {
    const oldTop = proj().tracks[0]!.id;
    put(mkImage(oldTop, 0, 5));
    const id = ed().addEffect('shake', { start: 1 })!;
    expect(proj().tracks).toHaveLength(3);
    expect(proj().tracks[0]!.kind).toBe('video');
    expect(proj().tracks[0]!.id).not.toBe(oldTop);
    expect(proj().tracks[1]!.id).toBe(oldTop);
    expect(fxOf(id).trackId).toBe(proj().tracks[0]!.id);
    expect(fxOf(id).start).toBe(1);
    // audio track stays last
    expect(proj().tracks[2]!.kind).toBe('audio');
  });

  it('makes a new track when the top track is locked', () => {
    const top = proj().tracks[0]!.id;
    ed().updateTrack(top, { locked: true });
    const id = ed().addEffect('shake')!;
    expect(proj().tracks).toHaveLength(3);
    expect(fxOf(id).trackId).not.toBe(top);
    expect(proj().tracks[0]!.id).toBe(fxOf(id).trackId);
  });

  it('uses an explicit track at the nearest free spot', () => {
    ed().addTrack('video');
    const [t0, t1] = proj().tracks.filter((t) => t.kind === 'video');
    expect(t1).toBeDefined();
    const first = ed().addEffect('shake', { trackId: t1!.id, start: 0, duration: 3 })!;
    expect(fxOf(first).trackId).toBe(t1!.id);
    expect(fxOf(first).start).toBe(0);
    // overlaps the first clip at 2, so it lands right after it
    const second = ed().addEffect('shake', { trackId: t1!.id, start: 2, duration: 3 })!;
    expect(fxOf(second).trackId).toBe(t1!.id);
    expect(fxOf(second).start).toBe(3);
    // explicit start on a free track is kept
    const third = ed().addEffect('shake', { trackId: t0!.id, start: 9, duration: 1 })!;
    expect(fxOf(third).trackId).toBe(t0!.id);
    expect(fxOf(third).start).toBe(9);
  });

  it('falls back when the track id is an audio track', () => {
    const a = proj().tracks[1]!.id;
    const id = ed().addEffect('shake', { trackId: a, start: 1 })!;
    const track = proj().tracks.find((t) => t.id === fxOf(id).trackId)!;
    expect(track.kind).toBe('video');
    expect(fxOf(id).start).toBe(1);
  });

  it('falls back when the track id is locked', () => {
    const top = proj().tracks[0]!.id;
    useEditor.setState({ project: { ...proj(), tracks: proj().tracks.map((t) => (t.id === top ? { ...t, locked: true } : t)) } });
    const id = ed().addEffect('shake', { trackId: top, start: 0 })!;
    expect(fxOf(id).trackId).not.toBe(top);
    expect(proj().tracks.find((t) => t.id === fxOf(id).trackId)!.locked).toBe(false);
  });

  it('falls back when the track id does not exist', () => {
    const id = ed().addEffect('shake', { trackId: 'nope' })!;
    expect(proj().tracks.find((t) => t.id === fxOf(id).trackId)!.kind).toBe('video');
  });

  it('respects the duration option and the minimum', () => {
    const a = ed().addEffect('shake', { duration: 7.5 })!;
    expect(fxOf(a).duration).toBe(7.5);
    const b = ed().addEffect('shake', { duration: 0, start: 20 })!;
    expect(fxOf(b).duration).toBe(MIN_CLIP_DURATION);
    const c = ed().addEffect('shake', { duration: -3, start: 30 })!;
    expect(fxOf(c).duration).toBe(MIN_CLIP_DURATION);
  });

  it('clamps a negative start to 0', () => {
    const id = ed().addEffect('shake', { start: -4 })!;
    expect(fxOf(id).start).toBe(0);
  });

  it('selects the new clip', () => {
    const a = ed().addEffect('shake')!;
    expect(ed().selection).toEqual([a]);
    const b = ed().addEffect('shake', { start: 10 })!;
    expect(ed().selection).toEqual([b]);
  });

  it('is one undo step that also removes the track it created', () => {
    const oldTop = proj().tracks[0]!.id;
    put(mkImage(oldTop, 0, 5));
    const before = proj().tracks.map((t) => t.id);
    const pastBefore = ed().past.length;
    const id = ed().addEffect('shake', { start: 1 })!;
    expect(ed().past).toHaveLength(pastBefore + 1);
    expect(proj().tracks).toHaveLength(before.length + 1);
    ed().undo();
    expect(proj().clips.find((c) => c.id === id)).toBeUndefined();
    expect(proj().tracks.map((t) => t.id)).toEqual(before);
    expect(ed().selection).toEqual([]);
    ed().redo();
    expect(proj().clips.find((c) => c.id === id)).toBeDefined();
    expect(proj().tracks).toHaveLength(before.length + 1);
  });

  it('undo removes the clip when no track was created', () => {
    const id = ed().addEffect('shake')!;
    expect(proj().clips).toHaveLength(1);
    ed().undo();
    expect(proj().clips.find((c) => c.id === id)).toBeUndefined();
    expect(proj().tracks).toHaveLength(2);
  });

  it('skipHistory records no step', () => {
    ed().addEffect('shake', { skipHistory: true });
    expect(ed().past).toHaveLength(0);
    expect(proj().clips).toHaveLength(1);
  });
});

describe('setEffectParam', () => {
  it('sets a value and records one undo step', () => {
    const id = ed().addEffect('shake')!;
    const past = ed().past.length;
    ed().setEffectParam(id, 'strength', 55);
    expect(fxOf(id).params.strength).toBe(55);
    expect(ed().past).toHaveLength(past + 1);
    ed().undo();
    expect(fxOf(id).params.strength).toBeUndefined();
  });

  it('keeps other params', () => {
    const id = ed().addEffect('shake')!;
    ed().setEffectParam(id, 'strength', 55);
    ed().setEffectParam(id, 'speed', 20);
    expect(fxOf(id).params).toEqual({ strength: 55, speed: 20 });
  });

  it('clamps to the param range', () => {
    const id = ed().addEffect('shake')!;
    ed().setEffectParam(id, 'strength', 5000);
    expect(fxOf(id).params.strength).toBe(100);
    ed().setEffectParam(id, 'strength', -5000);
    expect(fxOf(id).params.strength).toBe(0);
    ed().setEffectParam(id, 'speed', 0);
    expect(fxOf(id).params.speed).toBe(1);
    ed().setEffectParam(id, 'speed', 99);
    expect(fxOf(id).params.speed).toBe(30);
  });

  it('ignores an unknown key', () => {
    const id = ed().addEffect('shake')!;
    const before = proj();
    const past = ed().past.length;
    ed().setEffectParam(id, 'nope', 3);
    expect(proj()).toBe(before);
    expect(ed().past).toHaveLength(past);
  });

  it('ignores NaN and infinity', () => {
    const id = ed().addEffect('shake')!;
    const before = proj();
    const past = ed().past.length;
    ed().setEffectParam(id, 'strength', NaN);
    ed().setEffectParam(id, 'strength', Infinity);
    ed().setEffectParam(id, 'strength', -Infinity);
    expect(proj()).toBe(before);
    expect(ed().past).toHaveLength(past);
  });

  it('ignores clips that are not effect clips and missing clips', () => {
    const top = proj().tracks[0]!.id;
    const img = mkImage(top, 10, 2);
    put(img);
    const before = proj();
    ed().setEffectParam(img.id, 'strength', 3);
    ed().setEffectParam('missing', 'strength', 3);
    expect(proj()).toBe(before);
    expect(clipOf(img.id)).toEqual(img);
  });

  it('ignores clips on a locked track', () => {
    const id = ed().addEffect('shake')!;
    const trackId = fxOf(id).trackId;
    useEditor.setState({ project: { ...proj(), tracks: proj().tracks.map((t) => (t.id === trackId ? { ...t, locked: true } : t)) } });
    const before = proj();
    ed().setEffectParam(id, 'strength', 10);
    expect(proj()).toBe(before);
  });

  it('is a no-op without history when the value is unchanged', () => {
    const id = ed().addEffect('shake')!;
    // default value (strength 30) is already what the clip uses
    const past = ed().past.length;
    const before = proj();
    ed().setEffectParam(id, 'strength', 30);
    expect(proj()).toBe(before);
    expect(ed().past).toHaveLength(past);
    ed().setEffectParam(id, 'strength', 60);
    expect(ed().past).toHaveLength(past + 1);
    ed().setEffectParam(id, 'strength', 60);
    expect(ed().past).toHaveLength(past + 1);
    // a value that clamps to the current one is also unchanged
    ed().setEffectParam(id, 'strength', 60.0);
    expect(ed().past).toHaveLength(past + 1);
  });

  it('a clamped value equal to the current one is a no-op', () => {
    const id = ed().addEffect('shake')!;
    ed().setEffectParam(id, 'strength', 100);
    const past = ed().past.length;
    ed().setEffectParam(id, 'strength', 400);
    expect(ed().past).toHaveLength(past);
  });

  it('skipHistory changes the value without an undo step', () => {
    const id = ed().addEffect('shake')!;
    const past = ed().past.length;
    ed().setEffectParam(id, 'strength', 12, { skipHistory: true });
    expect(fxOf(id).params.strength).toBe(12);
    expect(ed().past).toHaveLength(past);
  });
});

describe('updateClip on an effect clip', () => {
  it('clamps amount to 0..1', () => {
    const id = ed().addEffect('shake')!;
    ed().updateClip(id, { amount: 5 });
    expect(fxOf(id).amount).toBe(1);
    ed().updateClip(id, { amount: -2 });
    expect(fxOf(id).amount).toBe(0);
    ed().updateClip(id, { amount: 0.25 });
    expect(fxOf(id).amount).toBe(0.25);
  });

  it('cannot change type, start, duration, trackId or id', () => {
    const id = ed().addEffect('shake', { start: 2, duration: 3 })!;
    const before = fxOf(id);
    const past = ed().past.length;
    ed().updateClip(id, { type: 'video', start: 9, duration: 9, trackId: 'x', id: 'y' } as never);
    expect(fxOf(id)).toBe(before);
    expect(ed().past).toHaveLength(past);
  });

  it('can change effect, params and seed', () => {
    const id = ed().addEffect('shake')!;
    ed().updateClip(id, { params: { strength: 10, speed: 3 }, seed: 99 });
    expect(fxOf(id).params).toEqual({ strength: 10, speed: 3 });
    expect(fxOf(id).seed).toBe(99);
    ed().updateClip(id, { effect: 'other-effect' });
    expect(fxOf(id).effect).toBe('other-effect');
  });

  it('ignores fields an effect clip does not have', () => {
    const id = ed().addEffect('shake')!;
    const before = fxOf(id);
    ed().updateClip(id, { volume: 0.5, text: 'hi', transform: { ...DEFAULT_TRANSFORM, x: 5 } });
    expect(fxOf(id)).toBe(before);
    expect('volume' in fxOf(id)).toBe(false);
    expect('transform' in fxOf(id)).toBe(false);
  });

  it('clamps fades to the duration', () => {
    const id = ed().addEffect('shake', { duration: 2 })!;
    ed().updateClip(id, { fadeIn: 10, fadeOut: -1 });
    expect(fxOf(id).fadeIn).toBe(2);
    expect(fxOf(id).fadeOut).toBe(0);
  });

  it('records no history when nothing changes', () => {
    const id = ed().addEffect('shake')!;
    const past = ed().past.length;
    ed().updateClip(id, { amount: 1, seed: fxOf(id).seed });
    expect(ed().past).toHaveLength(past);
  });
});

describe('effect clips in timeline operations', () => {
  it('split keeps effect, params, amount and seed on both halves', () => {
    const id = mkFx(proj().tracks[0]!.id, 0, 4);
    const ref = fxOf(id);
    const created = ed().splitClips(1.5, [id]);
    expect(created).toHaveLength(1);
    const left = fxOf(id);
    const right = fxOf(created[0]!);
    expectSame(left, ref);
    expectSame(right, ref);
    expect(left.start).toBe(0);
    expect(left.duration).toBeCloseTo(1.5, 9);
    expect(right.start).toBeCloseTo(1.5, 9);
    expect(right.duration).toBeCloseTo(2.5, 9);
    expect(right.trackId).toBe(left.trackId);
    expect(right.id).not.toBe(left.id);
    expect('trimStart' in right).toBe(false);
  });

  it('split outside the clip does nothing', () => {
    const id = mkFx(proj().tracks[0]!.id, 2, 2);
    expect(ed().splitClips(1, [id])).toEqual([]);
    expect(ed().splitClips(4, [id])).toEqual([]);
    expect(proj().clips).toHaveLength(1);
  });

  it('duplicate makes an independent copy right after', () => {
    const id = mkFx(proj().tracks[0]!.id, 0, 4);
    const ref = fxOf(id);
    const created = ed().duplicateClips([id]);
    expect(created).toHaveLength(1);
    const copy = fxOf(created[0]!);
    expectSame(copy, ref);
    expect(copy.id).not.toBe(id);
    expect(copy.trackId).toBe(ref.trackId);
    expect(copy.start).toBe(4);
    expect(copy.duration).toBe(4);
    expect(copy.params).not.toBe(ref.params);
    expect(ed().selection).toEqual([copy.id]);
  });

  it('copy and paste keep the effect data', () => {
    const id = mkFx(proj().tracks[0]!.id, 0, 4);
    const ref = fxOf(id);
    ed().select([id]);
    ed().copySelection();
    const pasted = ed().paste(10);
    expect(pasted).toHaveLength(1);
    const p = fxOf(pasted[0]!);
    expectSame(p, ref);
    expect(p.start).toBe(10);
    expect(p.duration).toBe(4);
    expect(p.id).not.toBe(id);
    expect(proj().tracks.find((t) => t.id === p.trackId)!.kind).toBe('video');
  });

  it('paste onto a busy range moves the effect to a track with room', () => {
    const id = mkFx(proj().tracks[0]!.id, 0, 4);
    const ref = fxOf(id);
    ed().select([id]);
    ed().copySelection();
    const pasted = ed().paste(1);
    const p = fxOf(pasted[0]!);
    expectSame(p, ref);
    expect(p.start).toBe(1);
    expect(p.trackId).not.toBe(ref.trackId);
    expect(proj().tracks.find((t) => t.id === p.trackId)!.kind).toBe('video');
  });

  it('cut and paste keep the effect data', () => {
    const id = mkFx(proj().tracks[0]!.id, 0, 4);
    const ref = fxOf(id);
    ed().select([id]);
    ed().cutSelection();
    expect(proj().clips).toHaveLength(0);
    const pasted = ed().paste(2);
    expectSame(fxOf(pasted[0]!), ref);
  });

  it('move keeps the effect data (same track and across video tracks)', () => {
    const top = proj().tracks[0]!.id;
    const id = mkFx(top, 0, 4);
    const ref = fxOf(id);
    expect(ed().moveClips([{ id, trackId: top, start: 5 }])).toBe(true);
    expect(fxOf(id).start).toBe(5);
    expectSame(fxOf(id), ref);
    const other = ed().addTrack('video');
    expect(ed().moveClips([{ id, trackId: other, start: 1 }])).toBe(true);
    expect(fxOf(id).trackId).toBe(other);
    expectSame(fxOf(id), ref);
  });

  it('move refuses an audio track', () => {
    const top = proj().tracks[0]!.id;
    const audioTrack = proj().tracks.find((t) => t.kind === 'audio')!.id;
    const id = mkFx(top, 0, 4);
    const before = proj();
    const past = ed().past.length;
    expect(ed().moveClips([{ id, trackId: audioTrack, start: 0 }])).toBe(false);
    expect(proj()).toBe(before);
    expect(ed().past).toHaveLength(past);
  });

  it('move refuses an overlap with another clip', () => {
    const top = proj().tracks[0]!.id;
    const a = mkFx(top, 0, 4);
    mkFx(top, 6, 4);
    expect(ed().moveClips([{ id: a, trackId: top, start: 5 }])).toBe(false);
    expect(fxOf(a).start).toBe(0);
  });

  it('trim keeps the effect data and never adds source fields', () => {
    const top = proj().tracks[0]!.id;
    const id = mkFx(top, 2, 4);
    const ref = fxOf(id);
    ed().trimClip(id, 'start', 3);
    expect(fxOf(id).start).toBe(3);
    expect(fxOf(id).duration).toBe(3);
    ed().trimClip(id, 'end', 5);
    expect(fxOf(id).start).toBe(3);
    expect(fxOf(id).duration).toBe(2);
    expectSame(fxOf(id), ref);
    expect('trimStart' in fxOf(id)).toBe(false);
    expect('speed' in fxOf(id)).toBe(false);
  });

  it('trim end can grow an effect clip (no source limit)', () => {
    const id = mkFx(proj().tracks[0]!.id, 0, 2);
    ed().trimClip(id, 'end', 60);
    expect(fxOf(id).duration).toBe(60);
  });

  it('trim keeps at least the minimum duration', () => {
    const id = mkFx(proj().tracks[0]!.id, 0, 2);
    ed().trimClip(id, 'end', 0);
    expect(fxOf(id).duration).toBeCloseTo(MIN_CLIP_DURATION, 9);
    ed().trimClip(id, 'start', 10);
    expect(fxOf(id).duration).toBeCloseTo(MIN_CLIP_DURATION, 9);
  });

  it('ripple delete closes the gap and keeps the later effect data', () => {
    const top = proj().tracks[0]!.id;
    const a = mkFx(top, 0, 3);
    const b = mkFx(top, 3, 3);
    ed().updateClip(b, { seed: 555, amount: 0.3 });
    const ref = fxOf(b);
    ed().deleteClips([a], { ripple: true });
    expect(proj().clips.find((c) => c.id === a)).toBeUndefined();
    expect(fxOf(b).start).toBe(0);
    expect(fxOf(b).duration).toBe(3);
    expectSame(fxOf(b), ref);
  });

  it('plain delete leaves the gap', () => {
    const top = proj().tracks[0]!.id;
    const a = mkFx(top, 0, 3);
    const b = mkFx(top, 3, 3);
    ed().deleteClips([a]);
    expect(fxOf(b).start).toBe(3);
  });

  it('delete on a locked track does nothing', () => {
    const id = mkFx(proj().tracks[0]!.id, 0, 3);
    const trackId = fxOf(id).trackId;
    useEditor.setState({ project: { ...proj(), tracks: proj().tracks.map((t) => (t.id === trackId ? { ...t, locked: true } : t)) } });
    ed().deleteClips([id]);
    expect(proj().clips).toHaveLength(1);
  });
});
