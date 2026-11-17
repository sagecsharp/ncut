import { beforeEach, describe, expect, it } from 'vitest';
import type { AudioClip, Clip, ClipMatte, Project, VideoClip } from '../types';
import { DEFAULT_TRANSFORM } from '../types';
import { createProject, createTrack } from '../lib/factory';
import { useEditor } from './editorStore';

const ed = () => useEditor.getState();
const proj = (): Project => ed().project!;
const clipOf = (id: string): Clip => proj().clips.find((c) => c.id === id)!;
const matteOf = (id: string): ClipMatte | null | undefined => (clipOf(id) as VideoClip).matte;

function mkVideo(id: string, trackId: string, start: number, duration: number, over: Partial<VideoClip> = {}): VideoClip {
  return { id, type: 'video', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'va', trimStart: 0, speed: 1, volume: 1, muted: false, transform: { ...DEFAULT_TRANSFORM }, ...over };
}

let tm = '';
let tu = '';
let tx = '';
beforeEach(() => {
  useEditor.setState({ project: null, selection: [], past: [], future: [], clipboard: [] });
  const p = createProject('matte');
  const a = p.tracks.find((t) => t.kind === 'audio')!;
  const m = createTrack('video', 'm');
  const u = createTrack('video', 'u');
  const x = createTrack('video', 'x');
  tm = m.id;
  tu = u.id;
  tx = x.id;
  const video = { id: 'va', name: 'clip', kind: 'video' as const, mime: 'video/mp4', size: 1, duration: 20, width: 1920, height: 1080, hasAudio: true, createdAt: 0 };
  const sound: AudioClip = { id: 'snd', type: 'audio', trackId: a.id, start: 0, duration: 10, name: 'snd', fadeIn: 0, fadeOut: 0, assetId: 'va', trimStart: 0, speed: 1, volume: 1, muted: false };
  ed().openProject({
    ...p,
    tracks: [m, u, x, ...p.tracks],
    assets: [video],
    clips: [mkVideo('m', m.id, 0, 10), mkVideo('u', u.id, 0, 10), mkVideo('x', x.id, 0, 10), sound],
  });
});

describe('matte in the store', () => {
  it('set, mode and remove are one undo step each', () => {
    ed().updateClip('u', { matte: { clip: 'm' } as ClipMatte });
    expect(matteOf('u')).toEqual({ clip: 'm', mode: 'alpha' });
    expect(ed().past).toHaveLength(1);
    // a partial one lies over the current
    ed().updateClip('u', { matte: { mode: 'luma' } as ClipMatte });
    expect(matteOf('u')).toEqual({ clip: 'm', mode: 'luma' });
    expect(ed().past).toHaveLength(2);
    // the same again is no step
    ed().updateClip('u', { matte: { clip: 'm', mode: 'luma' } });
    expect(ed().past).toHaveLength(2);
    ed().updateClip('u', { matte: null });
    expect(ed().past).toHaveLength(3);
    ed().undo();
    expect(matteOf('u')).toEqual({ clip: 'm', mode: 'luma' });
    ed().undo();
    expect(matteOf('u')).toEqual({ clip: 'm', mode: 'alpha' });
    ed().undo();
    expect('matte' in clipOf('u')).toBe(false);
  });

  it('null leaves no key', () => {
    const p = proj();
    ed().updateClip('u', { matte: null });
    expect(proj()).toBe(p);
    expect(ed().past).toHaveLength(0);
    ed().updateClip('u', { matte: { clip: 'm', mode: 'luma-inv' } });
    ed().updateClip('u', { matte: null });
    expect('matte' in clipOf('u')).toBe(false);
    // a bad mode on its own is refused
    ed().updateClip('u', { matte: { clip: 'm', mode: 'nope' as never } });
    expect('matte' in clipOf('u')).toBe(false);
  });

  it('refuses itself, a non picture and a chain', () => {
    ed().updateClip('u', { matte: { clip: 'u', mode: 'alpha' } });
    expect('matte' in clipOf('u')).toBe(false);
    // a sound is not a picture
    ed().updateClip('u', { matte: { clip: 'snd', mode: 'alpha' } });
    expect('matte' in clipOf('u')).toBe(false);
    ed().updateClip('snd', { matte: { clip: 'm', mode: 'alpha' } } as never);
    expect('matte' in clipOf('snd')).toBe(false);
    // a clip that is not there
    ed().updateClip('u', { matte: { clip: 'gone', mode: 'alpha' } });
    expect('matte' in clipOf('u')).toBe(false);
    expect(ed().past).toHaveLength(0);
    // a chain: a matte clip has no matte of its own, a matted clip is nobody's matte
    ed().updateClip('u', { matte: { clip: 'm', mode: 'alpha' } });
    ed().updateClip('m', { matte: { clip: 'x', mode: 'alpha' } });
    expect('matte' in clipOf('m')).toBe(false);
    ed().updateClip('x', { matte: { clip: 'u', mode: 'alpha' } });
    expect('matte' in clipOf('x')).toBe(false);
    expect(ed().past).toHaveLength(1);
  });

  it('a matte clip is cut only when the clips it cuts over the cut can be cut', () => {
    ed().updateClip('u', { matte: { clip: 'm', mode: 'alpha' } });
    ed().updateTrack(tu, { locked: true });
    const before = proj();
    // the matted clip is on a locked track and reaches over the cut: the matte clip stays whole
    expect(ed().splitClips(5, ['m'])).toEqual([]);
    expect(proj()).toBe(before);
    // unlocked: the matted clip is cut along with it
    ed().updateTrack(tu, { locked: false });
    expect(ed().splitClips(5, ['m'])).toHaveLength(2);
    expect(proj().clips.filter((c) => c.start === 5 && c.type === 'video')).toHaveLength(2);
  });

  it('a matte clip is cut when the locked clip that uses it does not reach over the cut', () => {
    ed().deleteClips(['u']);
    const lockedTrack = createTrack('video', 'locked');
    useEditor.setState({ project: { ...proj(), tracks: [...proj().tracks, { ...lockedTrack, locked: true }], clips: [...proj().clips, mkVideo('late', lockedTrack.id, 7, 2, { matte: { clip: 'm', mode: 'alpha' } })] } });
    expect(ed().splitClips(5, ['m'])).toHaveLength(1);
    // the clip on the locked track follows the right half by itself
    const rightM = proj().clips.find((c) => c.trackId === tm && c.start === 5)!;
    expect(matteOf('late')!.clip).toBe(rightM.id);
  });

  it('right halves name right halves', () => {
    ed().updateClip('u', { matte: { clip: 'm', mode: 'luma' } });
    const made = ed().splitClips(5, ['m']);
    const rightM = made.find((id) => clipOf(id).trackId === tm)!;
    const rightU = made.find((id) => clipOf(id).trackId === tu)!;
    expect(matteOf(rightU)).toEqual({ clip: rightM, mode: 'luma' });
    // the left half still names the left half
    expect(matteOf('u')).toEqual({ clip: 'm', mode: 'luma' });
    expect(clipOf('u').duration).toBe(5);
  });

  it('a matted clip cut alone keeps its matte on both halves', () => {
    ed().updateClip('u', { matte: { clip: 'm', mode: 'alpha' } });
    const made = ed().splitClips(5, ['u']);
    expect(made).toHaveLength(1);
    expect(matteOf('u')).toEqual({ clip: 'm', mode: 'alpha' });
    expect(matteOf(made[0]!)).toEqual({ clip: 'm', mode: 'alpha' });
    // the matte clip is whole
    expect(proj().clips.filter((c) => c.trackId === tm)).toHaveLength(1);
  });

  it('clips before the cut keep the left half, after it the right', () => {
    // two clips use the matte clip: one ends before the cut, one starts after it
    const early = mkVideo('early', tx, 0, 3, { matte: { clip: 'm', mode: 'alpha' } });
    const late = mkVideo('late', tx, 7, 2, { matte: { clip: 'm', mode: 'alpha' } });
    useEditor.setState({ project: { ...proj(), clips: [...proj().clips.filter((c) => c.id !== 'x'), early, late] } });
    const made = ed().splitClips(5, ['m']);
    const rightM = made[0]!;
    expect(clipOf(rightM).trackId).toBe(tm);
    expect(matteOf('early')!.clip).toBe('m');
    expect(matteOf('late')!.clip).toBe(rightM);
    // neither of them was cut
    expect(proj().clips.filter((c) => c.id === 'early' || c.id === 'late')).toHaveLength(2);
  });

  it('deleting the matte clip takes the matte off, undo brings it back', () => {
    ed().updateClip('u', { matte: { clip: 'm', mode: 'luma' } });
    ed().deleteClips(['m']);
    expect(proj().clips.some((c) => c.id === 'm')).toBe(false);
    expect('matte' in clipOf('u')).toBe(false);
    ed().undo();
    expect(proj().clips.some((c) => c.id === 'm')).toBe(true);
    expect(matteOf('u')).toEqual({ clip: 'm', mode: 'luma' });
  });

  it('a copy alone names the original, copied together the copy', () => {
    ed().updateClip('u', { matte: { clip: 'm', mode: 'alpha' } });
    ed().select(['u']);
    ed().copySelection();
    const alone = ed().paste(20);
    expect(alone).toHaveLength(1);
    expect(matteOf(alone[0]!)).toEqual({ clip: 'm', mode: 'alpha' });
    ed().select(['m', 'u']);
    ed().copySelection();
    const both = ed().paste(40);
    expect(both).toHaveLength(2);
    const copyM = both.find((id) => clipOf(id).trackId === tm)!;
    const copyU = both.find((id) => clipOf(id).trackId === tu)!;
    expect(matteOf(copyU)).toEqual({ clip: copyM, mode: 'alpha' });
    // the originals are untouched
    expect(matteOf('u')).toEqual({ clip: 'm', mode: 'alpha' });
  });

  it('a duplicate alone names the original, duplicated together the copy', () => {
    ed().updateClip('u', { matte: { clip: 'm', mode: 'alpha' } });
    const alone = ed().duplicateClips(['u']);
    expect(alone).toHaveLength(1);
    expect(matteOf(alone[0]!)).toEqual({ clip: 'm', mode: 'alpha' });
    const both = ed().duplicateClips(['m', 'u']);
    expect(both).toHaveLength(2);
    const copyM = both.find((id) => clipOf(id).trackId === tm)!;
    const copyU = both.find((id) => clipOf(id).trackId === tu)!;
    expect(matteOf(copyU)).toEqual({ clip: copyM, mode: 'alpha' });
    expect(matteOf('u')).toEqual({ clip: 'm', mode: 'alpha' });
  });
});
