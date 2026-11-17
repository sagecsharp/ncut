import { beforeEach, describe, expect, it } from 'vitest';
import type { AudioClip, Clip, MediaAsset, Project, TextClip, Track, VideoClip } from '../types';
import { DEFAULT_TRANSFORM } from '../types';
import { createProject } from '../lib/factory';
import { useEditor } from './editorStore';

const ed = () => useEditor.getState();
const proj = (): Project => ed().project!;
const clipOf = <C extends Clip>(id: string): C => proj().clips.find((c) => c.id === id) as C;
const has = (c: Clip, key: string): boolean => key in c;

const track = (id: string, kind: 'video' | 'audio', over: Partial<Track> = {}): Track => ({ id, kind, name: id, muted: false, hidden: false, locked: false, ...over });
const asset = (id: string, kind: MediaAsset['kind'], hasAudio: boolean, duration = 60): MediaAsset => ({ id, name: id, kind, mime: '', size: 1, duration, width: 100, height: 100, hasAudio, createdAt: 0 });
const video = (id: string, start: number, duration: number, over: Partial<VideoClip> = {}): VideoClip => ({
  id, type: 'video', trackId: 'v1', start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'av', trimStart: 5, speed: 1, volume: 1, muted: false, transform: { ...DEFAULT_TRANSFORM }, ...over,
});
const audio = (id: string, start: number, duration: number, over: Partial<AudioClip> = {}): AudioClip => ({
  id, type: 'audio', trackId: 'a1', start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'song', trimStart: 5, speed: 1, volume: 1, muted: false, ...over,
});
const text = (id: string, start: number, duration: number): TextClip => ({
  id, type: 'text', trackId: 'v1', start, duration, name: id, fadeIn: 0, fadeOut: 0, text: 'x', fontFamily: 'f', fontSize: 10, fontWeight: 400, italic: false, color: '#fff',
  background: null, align: 'center', transform: { ...DEFAULT_TRANSFORM },
});

function open(clips: Clip[], tracks?: Track[]): void {
  ed().openProject({
    ...createProject('store'),
    assets: [asset('av', 'video', true), asset('song', 'audio', true)],
    tracks: tracks ?? [track('v1', 'video'), track('a1', 'audio')],
    clips,
  });
  useEditor.setState({ past: [], future: [], selection: [] });
}
const X = { before: 0.25, after: 0.25 };

beforeEach(() => {
  useEditor.setState({ project: null, selection: [], past: [], future: [], clipboard: [] });
});

describe('the crossfade field in the store', () => {
  it('a crossfade is cleaned when stored', () => {
    open([video('a', 0, 4), video('b', 4, 4)]);
    ed().updateClip('b', { crossfade: { before: 15, after: -1, shape: 'power', withTransition: false } } as never);
    expect(clipOf<VideoClip>('b').crossfade).toEqual({ before: 10, after: 0 });
    ed().updateClip('b', { crossfade: { before: 0.1234567891, after: 0.5, shape: 'smooth', withTransition: true } } as never);
    expect(clipOf<VideoClip>('b').crossfade).toEqual({ before: 0.123457, after: 0.5, shape: 'smooth', withTransition: true });
    ed().updateClip('b', { crossfade: { before: 0.2, after: 0.2, shape: 'wobble' } } as never);
    expect(clipOf<VideoClip>('b').crossfade).toEqual({ before: 0.2, after: 0.2 });
    // an audio clip stores it too
    open([audio('x', 0, 4), audio('y', 4, 4)]);
    ed().updateClip('y', { crossfade: X });
    expect(clipOf<AudioClip>('y').crossfade).toEqual(X);
    // a clip type without sound has no such field
    open([video('a', 0, 4), text('t', 9, 2)]);
    ed().updateClip('t', { crossfade: X } as never);
    expect(has(clipOf('t'), 'crossfade')).toBe(false);
  });

  it('the same crossfade writes nothing', () => {
    open([video('a', 0, 4), video('b', 4, 4, { crossfade: X })]);
    const before = proj();
    ed().updateClip('b', { crossfade: { ...X } });
    // power is the missing shape: the same crossfade
    ed().updateClip('b', { crossfade: { ...X, shape: 'power' } } as never);
    // a value that cleans to what is stored
    ed().updateClip('b', { crossfade: { before: 0.2500000001, after: 0.25 } });
    expect(proj()).toBe(before);
    expect(ed().past.length).toBe(0);
    ed().updateClip('b', { crossfade: { ...X, after: 0.3 } });
    expect(ed().past.length).toBe(1);
  });

  it('null and 0 + 0 take it away', () => {
    open([video('a', 0, 4), video('b', 4, 4, { crossfade: X })]);
    ed().updateClip('b', { crossfade: null });
    expect(has(clipOf('b'), 'crossfade')).toBe(false);
    ed().updateClip('b', { crossfade: X });
    expect(has(clipOf('b'), 'crossfade')).toBe(true);
    ed().updateClip('b', { crossfade: { before: 0, after: 0 } });
    expect(has(clipOf('b'), 'crossfade')).toBe(false);
    ed().updateClip('b', { crossfade: X });
    ed().updateClip('b', { crossfade: { before: 0.0003, after: 0.0003 } });
    expect(has(clipOf('b'), 'crossfade')).toBe(false);
    ed().updateClip('b', { crossfade: X });
    ed().updateClip('b', { crossfade: 'junk' } as never);
    expect(has(clipOf('b'), 'crossfade')).toBe(false);
    // taking away what is not there writes nothing
    const before = proj();
    ed().updateClip('b', { crossfade: null });
    expect(proj()).toBe(before);
  });

  it('linear is no field, power and smooth stay', () => {
    open([video('a', 0, 4, { fadeIn: 1, fadeOut: 1 })]);
    const before = proj();
    ed().updateClip('a', { fadeInShape: 'linear', fadeOutShape: null } as never);
    expect(proj()).toBe(before);
    ed().updateClip('a', { fadeInShape: 'power', fadeOutShape: 'smooth' } as never);
    expect(clipOf<VideoClip>('a').fadeInShape).toBe('power');
    expect(clipOf<VideoClip>('a').fadeOutShape).toBe('smooth');
    ed().updateClip('a', { fadeInShape: 'linear' } as never);
    expect(has(clipOf('a'), 'fadeInShape')).toBe(false);
    expect(clipOf<VideoClip>('a').fadeOutShape).toBe('smooth');
    ed().updateClip('a', { fadeOutShape: null });
    expect(has(clipOf('a'), 'fadeOutShape')).toBe(false);
    ed().updateClip('a', { fadeInShape: 'wobble' } as never);
    expect(has(clipOf('a'), 'fadeInShape')).toBe(false);
    // the crossfade shape: linear and smooth are stored, power is the missing shape
    open([video('a', 0, 4), video('b', 4, 4, { crossfade: X })]);
    ed().updateClip('b', { crossfade: { ...X, shape: 'linear' } });
    expect(clipOf<VideoClip>('b').crossfade).toEqual({ ...X, shape: 'linear' });
    ed().updateClip('b', { crossfade: { ...X, shape: 'power' } } as never);
    expect(clipOf<VideoClip>('b').crossfade).toEqual(X);
  });

  it('a locked track refuses', () => {
    open([video('a', 0, 4), video('b', 4, 4, { crossfade: X, fadeIn: 1 })], [track('v1', 'video', { locked: true }), track('a1', 'audio')]);
    const before = proj();
    ed().updateClip('b', { crossfade: null });
    ed().updateClip('b', { crossfade: { before: 1, after: 1 } });
    ed().updateClip('b', { fadeInShape: 'power' });
    expect(proj()).toBe(before);
    expect(ed().past.length).toBe(0);
  });

  it('split: the left keeps the crossfade and fade in shape, the right the fade out shape', () => {
    open([video('a', 0, 4), video('b', 4, 8, { crossfade: X, fadeIn: 1, fadeOut: 1, fadeInShape: 'power', fadeOutShape: 'smooth' })]);
    const made = ed().splitClips(8, ['b']);
    expect(made.length).toBe(1);
    const left = clipOf<VideoClip>('b');
    const right = clipOf<VideoClip>(made[0]!);
    expect(left.duration).toBe(4);
    expect(left.crossfade).toEqual(X);
    expect(left.fadeInShape).toBe('power');
    expect(has(left, 'fadeOutShape')).toBe(false);
    expect(has(right, 'crossfade')).toBe(false);
    expect(has(right, 'fadeInShape')).toBe(false);
    expect(right.fadeOutShape).toBe('smooth');
    expect(right.start).toBe(8);
  });

  it('delete drops a crossfade nothing touches, ripple keeps it', () => {
    const clips = (): Clip[] => [video('x', 0, 2), video('a', 2, 2), video('b', 4, 4, { crossfade: X })];
    open(clips());
    ed().deleteClips(['a']);
    expect(proj().clips.map((c) => c.id)).toEqual(['x', 'b']);
    expect(has(clipOf('b'), 'crossfade')).toBe(false);
    // ripple: b slides left and touches x, the crossfade stays (it waits for the new neighbour)
    open(clips());
    ed().deleteClips(['a'], { ripple: true });
    expect(clipOf('b').start).toBe(2);
    expect(clipOf<VideoClip>('b').crossfade).toEqual(X);
    // deleting a clip with no crossfade leaves the others as they are
    open(clips());
    ed().deleteClips(['b']);
    expect(proj().clips.map((c) => c.id)).toEqual(['x', 'a']);
  });

  it('copy, paste and duplicate carry it', () => {
    open([video('a', 0, 4), video('b', 4, 4, { crossfade: { ...X, shape: 'smooth' }, fadeInShape: 'power', fadeIn: 1 })]);
    ed().select(['b']);
    ed().copySelection();
    const pasted = ed().paste(20);
    expect(pasted.length).toBe(1);
    expect(clipOf<VideoClip>(pasted[0]!).crossfade).toEqual({ ...X, shape: 'smooth' });
    expect(clipOf<VideoClip>(pasted[0]!).fadeInShape).toBe('power');
    // the copy is its own object
    expect(clipOf<VideoClip>(pasted[0]!).crossfade).not.toBe(clipOf<VideoClip>('b').crossfade);
    const copies = ed().duplicateClips(['b']);
    expect(copies.length).toBe(1);
    expect(clipOf<VideoClip>(copies[0]!).crossfade).toEqual({ ...X, shape: 'smooth' });
    expect(clipOf<VideoClip>(copies[0]!).fadeInShape).toBe('power');
  });

  it('an old project stays byte equal', () => {
    open([video('a', 0, 4, { fadeIn: 1 }), video('b', 4, 4), audio('x', 0, 8, { fadeOut: 1 })]);
    const before = JSON.stringify(proj());
    // clearing fields that are not there writes nothing
    ed().updateClip('b', { crossfade: null, fadeInShape: null, fadeOutShape: null } as never);
    ed().updateClip('x', { fadeInShape: 'linear', crossfade: { before: 0, after: 0 } } as never);
    expect(JSON.stringify(proj())).toBe(before);
    expect(ed().past.length).toBe(0);
    // ordinary edits add no new key
    ed().updateClip('a', { volume: 0.5 });
    const made = ed().splitClips(2, ['a', 'x']);
    expect(made.length).toBe(2);
    ed().deleteClips(['b']);
    const after = JSON.stringify(proj());
    expect(after).not.toContain('crossfade');
    expect(after).not.toContain('Shape');
  });
});
