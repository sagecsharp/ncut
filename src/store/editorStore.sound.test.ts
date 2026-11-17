import { beforeEach, describe, expect, it } from 'vitest';
import type { AudioClip, Clip, MediaAsset, Project, Track, VideoClip } from '../types';
import { DEFAULT_TRANSFORM } from '../types';
import { createProject } from '../lib/factory';
import { mateOf, syncLabel } from '../lib/soundPair';
import { useEditor } from './editorStore';

const ed = () => useEditor.getState();
const proj = (): Project => ed().project!;
const clipOf = <C extends Clip>(id: string): C => proj().clips.find((c) => c.id === id) as C;

const track = (id: string, kind: 'video' | 'audio', over: Partial<Track> = {}): Track => ({ id, kind, name: id, muted: false, hidden: false, locked: false, ...over });
const asset = (id: string, kind: MediaAsset['kind'], hasAudio: boolean, duration = 60): MediaAsset => ({ id, name: id, kind, mime: '', size: 1, duration, width: 100, height: 100, hasAudio, createdAt: 0 });
const video = (id: string, start: number, duration: number, over: Partial<VideoClip> = {}): VideoClip => ({
  id, type: 'video', trackId: 'v1', start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'av', trimStart: 0, speed: 1, volume: 1, muted: false, transform: { ...DEFAULT_TRANSFORM }, ...over,
});
const audio = (id: string, start: number, duration: number, over: Partial<AudioClip> = {}): AudioClip => ({
  id, type: 'audio', trackId: 'a1', start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'av', trimStart: 0, speed: 1, volume: 1, muted: false, ...over,
});

function open(clips: Clip[], tracks?: Track[]): void {
  ed().openProject({
    ...createProject('store'),
    assets: [asset('av', 'video', true), asset('other', 'video', true), asset('silent', 'video', false), asset('song', 'audio', true), asset('pic', 'image', false)],
    tracks: tracks ?? [track('v1', 'video'), track('a1', 'audio'), track('a2', 'audio')],
    clips,
  });
  useEditor.setState({ past: [], future: [], selection: [] });
}

beforeEach(() => {
  useEditor.setState({ project: null, selection: [], past: [], future: [], clipboard: [] });
});

describe('insertClips', () => {
  it('insertClips: place, ids, all or nothing', () => {
    open([video('v', 0, 4), audio('x', 10, 2, { assetId: 'song' })]);
    // each clip exactly where it says, right after the clip it names, else at the end
    expect(ed().insertClips([{ clip: audio('s', 0, 4, { trackId: 'a2' }), after: 'v' }, { clip: audio('t', 5, 1, { trackId: 'a2' }) }])).toBe(true);
    expect(proj().clips.map((c) => c.id)).toEqual(['v', 's', 'x', 't']);
    expect(clipOf('s')).toMatchObject({ trackId: 'a2', start: 0, duration: 4 });
    expect(ed().past.length).toBe(1);
    // an unknown clip to place after: at the end
    expect(ed().insertClips([{ clip: audio('u', 8, 1, { trackId: 'a2' }), after: 'nope' }])).toBe(true);
    expect(proj().clips.at(-1)!.id).toBe('u');
  });

  it('refuses all of it when one entry is wrong', () => {
    open([video('v', 0, 4), audio('x', 10, 2, { assetId: 'song' })]);
    const before = proj();
    const fine = { clip: audio('s', 0, 4, { trackId: 'a2' }) };
    const bad: Record<string, { clip: Clip }> = {
      track: { clip: audio('b1', 0, 1, { trackId: 'nope' }) },
      kind: { clip: audio('b2', 0, 1, { trackId: 'v1' }) },
      id: { clip: audio('x', 20, 1, { trackId: 'a2' }) },
      start: { clip: audio('b3', -1, 1, { trackId: 'a2' }) },
      short: { clip: audio('b4', 30, 0.01, { trackId: 'a2' }) },
      room: { clip: audio('b5', 9, 2, { trackId: 'a1' }) },
      same: { clip: audio('b6', 2, 1, { trackId: 'a2' }) },
    };
    for (const [why, entry] of Object.entries(bad)) {
      expect(ed().insertClips([fine, entry]), why).toBe(false);
      expect(proj(), why).toBe(before);
    }
    expect(ed().insertClips([])).toBe(false);
    expect(ed().past.length).toBe(0);
  });

  it('refuses a locked track', () => {
    open([video('v', 0, 4)], [track('v1', 'video'), track('a1', 'audio', { locked: true })]);
    expect(ed().insertClips([{ clip: audio('s', 0, 4) }])).toBe(false);
    expect(proj().clips).toHaveLength(1);
  });

  it('is one undo step and skips history when asked', () => {
    open([video('v', 0, 4)]);
    ed().insertClips([{ clip: audio('s', 0, 4) }], { skipHistory: true });
    expect(ed().past.length).toBe(0);
    ed().insertClips([{ clip: audio('t', 5, 1) }]);
    expect(ed().past.length).toBe(1);
    ed().undo();
    expect(proj().clips.map((c) => c.id)).toEqual(['v', 's']);
  });
});

describe('setClipGroup', () => {
  it('setClipGroup', () => {
    open([video('v', 0, 4), audio('s', 0, 4), audio('x', 6, 1, { assetId: 'song' })]);
    expect(ed().setClipGroup(['v', 's'], 'g')).toBe(true);
    expect(clipOf('v').group).toBe('g');
    expect(clipOf('s').group).toBe('g');
    expect(clipOf('x').group).toBeUndefined();
    // the same group: nothing changes and no step
    const before = proj();
    expect(ed().setClipGroup(['v', 's'], 'g')).toBe(false);
    expect(proj()).toBe(before);
    expect(ed().past.length).toBe(1);
    // null takes it off, the key goes
    expect(ed().setClipGroup(['s'], null)).toBe(true);
    expect('group' in clipOf('s')).toBe(false);
    expect(ed().setClipGroup(['s'], null)).toBe(false);
  });

  it('skips locked tracks', () => {
    open([video('v', 0, 4), audio('s', 0, 4)], [track('v1', 'video', { locked: true }), track('a1', 'audio'), track('a2', 'audio')]);
    expect(ed().setClipGroup(['v', 's'], 'g')).toBe(true);
    expect(clipOf('v').group).toBeUndefined();
    expect(clipOf('s').group).toBe('g');
    expect(ed().setClipGroup(['v'], 'h')).toBe(false);
  });
});

describe('splitClips', () => {
  const group = (): Clip[] => [video('v', 0, 4, { group: 'g' }), audio('s', 0, 4, { group: 'g' })];

  it('splitClips: both sides, one side, no pair', () => {
    // both cut: the right halves pair in a new group
    open(group());
    const made = ed().splitClips(2, ['v', 's']);
    expect(made).toHaveLength(2);
    const rights = proj().clips.filter((c) => c.start === 2);
    expect(rights).toHaveLength(2);
    expect(rights[0]!.group).toBeTruthy();
    expect(rights[0]!.group).toBe(rights[1]!.group);
    expect(rights[0]!.group).not.toBe('g');
    expect(clipOf('v').group).toBe('g');
    expect(syncLabel(proj().clips, rights[0]!.id, 30)).toBeNull();
    expect(mateOf(proj().clips, 'v')?.id).toBe('s');

    // one side cut alone while the other plays on over the cut: its right half stays in the old group (a j or l cut)
    open(group());
    const one = ed().splitClips(2, ['v']);
    expect(one).toHaveLength(1);
    expect(clipOf(one[0]!).group).toBe('g');
    expect(clipOf('s').group).toBe('g');
    expect(proj().clips.filter((c) => c.group === 'g')).toHaveLength(3);

    // the sound side alone: the same
    open(group());
    const snd = ed().splitClips(2, ['s']);
    expect(clipOf(snd[0]!).group).toBe('g');

    // no pair: a group of two plain clips splits in two groups as before
    open([video('a', 0, 4, { group: 'h' }), video('b', 0, 4, { group: 'h', trackId: 'v1', start: 5 })]);
    ed().splitClips(2, ['a']);
    const right = proj().clips.find((c) => c.start === 2)!;
    expect(right.group).toBeUndefined();
  });

  it('a cut at the end of the other side does not keep the group', () => {
    // the sound ends before the cut: nothing plays on over it, so the right half of the picture leaves the group
    open([video('v', 0, 4, { group: 'g' }), audio('s', 0, 1.5, { group: 'g' })]);
    const one = ed().splitClips(2, ['v']);
    expect(clipOf(one[0]!).group).toBeUndefined();
  });
});

describe('replaceClipAsset', () => {
  it('replaceClipAsset: sound clips follow', () => {
    open([video('v', 0, 4, { group: 'g', muted: true, name: 'av' }), audio('s', 0, 4, { group: 'g', trackId: 'a2', name: 'av', bpm: 120 })]);
    expect(ed().replaceClipAsset('v', 'other')).toBe(true);
    expect(clipOf<VideoClip>('v').assetId).toBe('other');
    expect(clipOf<AudioClip>('s')).toMatchObject({ assetId: 'other', name: 'other' });
    expect(clipOf<AudioClip>('s').bpm).toBeUndefined();
    expect(ed().past.length).toBe(1);
    expect(mateOf(proj().clips, 'v')?.id).toBe('s');
    ed().undo();
    expect(clipOf<AudioClip>('s').assetId).toBe('av');
  });

  it('swapping one shot leaves the sound of the next shot alone', () => {
    // an l cut: the first picture ends at 5, its sound at 6, the second picture takes over
    open([
      video('v', 0, 5, { group: 'g', muted: true }),
      video('p2', 5, 5, { group: 'g', muted: true, trimStart: 5 }),
      audio('s', 0, 6, { group: 'g', trackId: 'a1' }),
      audio('s2', 6, 4, { group: 'g', trackId: 'a1', trimStart: 6 }),
    ]);
    expect(mateOf(proj().clips, 'p2')?.id).toBe('s2');
    expect(ed().replaceClipAsset('v', 'other')).toBe(true);
    expect(clipOf<AudioClip>('s').assetId).toBe('other');
    expect(clipOf<AudioClip>('s2').assetId).toBe('av');
    expect(mateOf(proj().clips, 'p2')?.id).toBe('s2');
  });

  it('a silent video leaves the sound clips on the old media', () => {
    open([video('v', 0, 4, { group: 'g', muted: true }), audio('s', 0, 4, { group: 'g', trackId: 'a2' })]);
    expect(ed().replaceClipAsset('v', 'silent')).toBe(true);
    expect(clipOf<AudioClip>('s').assetId).toBe('av');
  });

  it('a locked sound clip stays on the old media', () => {
    open([video('v', 0, 4, { group: 'g' }), audio('s', 0, 4, { group: 'g', trackId: 'a2' })], [track('v1', 'video'), track('a1', 'audio'), track('a2', 'audio', { locked: true })]);
    expect(ed().replaceClipAsset('v', 'other')).toBe(true);
    expect(clipOf<AudioClip>('s').assetId).toBe('av');
    expect(clipOf<VideoClip>('v').assetId).toBe('other');
  });

  it('an audio clip takes only a video with sound', () => {
    open([audio('s', 0, 4, { trackId: 'a1' })]);
    expect(ed().replaceClipAsset('s', 'silent')).toBe(false);
    expect(ed().replaceClipAsset('s', 'pic')).toBe(false);
    expect(ed().replaceClipAsset('s', 'other')).toBe(true);
    expect(clipOf<AudioClip>('s').assetId).toBe('other');
    expect(ed().replaceClipAsset('s', 'song')).toBe(true);
    // a video still takes video only
    open([video('v', 0, 4)]);
    expect(ed().replaceClipAsset('v', 'song')).toBe(false);
  });
});

describe('copies', () => {
  it('duplicate and paste keep pairs in sync', () => {
    open(
      [video('v', 1, 4, { group: 'g', muted: true, trimStart: 2 }), audio('s', 1, 4, { group: 'g', trimStart: 2, trackId: 'a2' })],
      [track('v1', 'video'), track('a1', 'audio'), track('a2', 'audio')],
    );
    ed().select(['v', 's'], 'replace');
    const copies = ed().duplicateClips(['v', 's']);
    expect(copies).toHaveLength(2);
    const [cv, cs] = copies.map((id) => clipOf<Clip>(id)) as [VideoClip, AudioClip];
    expect(cv.group).toBeTruthy();
    expect(cv.group).toBe(cs.group);
    expect(cv.group).not.toBe('g');
    expect(mateOf(proj().clips, cv.id)?.id).toBe(cs.id);
    expect(syncLabel(proj().clips, cs.id, 30)).toBeNull();
    // a copy of both sides pastes as a pair too
    ed().select(['v', 's'], 'replace');
    ed().copySelection();
    ed().paste(20);
    const pasted = proj().clips.filter((c) => c.start >= 20 - 1e-9);
    expect(pasted).toHaveLength(2);
    expect(pasted[0]!.group).toBeTruthy();
    expect(pasted[0]!.group).toBe(pasted[1]!.group);
    expect(syncLabel(proj().clips, pasted[0]!.id, 30)).toBeNull();
  });

  it('one side alone is a lone clip', () => {
    open([video('v', 1, 4, { group: 'g', muted: true }), audio('s', 1, 4, { group: 'g', trackId: 'a2' })]);
    ed().select(['s'], 'replace');
    const copies = ed().duplicateClips(['s']);
    const c = clipOf<AudioClip>(copies[0]!);
    expect(mateOf(proj().clips, c.id)).toBeNull();
    expect(c.group).toBeUndefined();
  });
});
