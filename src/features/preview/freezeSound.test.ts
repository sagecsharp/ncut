import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioClip, Clip, ImageClip, MediaAsset, Project, Track, VideoClip } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import { createProject } from '../../lib/factory';
import { mateOf, syncLabel } from '../../lib/soundPair';
import { useEditor } from '../../store/editorStore';
import { FREEZE_DURATION, placeFreeze } from './freezeFrame';

// freezeFrame.ts reaches the importer and the video element: node tests only call placeFreeze
vi.mock('../../media/importer', () => ({ deleteAsset: vi.fn(), importFiles: vi.fn() }));

const ed = () => useEditor.getState();
const proj = (): Project => ed().project!;

const track = (id: string, kind: 'video' | 'audio', over: Partial<Track> = {}): Track => ({ id, kind, name: id, muted: false, hidden: false, locked: false, ...over });
const asset = (id: string, kind: MediaAsset['kind'], hasAudio: boolean): MediaAsset => ({ id, name: id, kind, mime: '', size: 1, duration: 60, width: 100, height: 100, hasAudio, createdAt: 0 });
const video = (id: string, start: number, duration: number, over: Partial<VideoClip> = {}): VideoClip => ({
  id, type: 'video', trackId: 'v1', start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'av', trimStart: 0, speed: 1, volume: 1, muted: false, transform: { ...DEFAULT_TRANSFORM }, ...over,
});
const audio = (id: string, start: number, duration: number, over: Partial<AudioClip> = {}): AudioClip => ({
  id, type: 'audio', trackId: 'a1', start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'av', trimStart: 0, speed: 1, volume: 1, muted: false, ...over,
});

function open(clips: Clip[], tracks?: Track[]): void {
  ed().openProject({
    ...createProject('freeze'),
    assets: [asset('av', 'video', true), asset('song', 'audio', true), asset('still', 'image', false)],
    tracks: tracks ?? [track('v1', 'video'), track('a1', 'audio')],
    clips,
  });
  useEditor.setState({ past: [], future: [], selection: [] });
}

const pair = (): Clip[] => [video('v', 0, 4, { group: 'g', muted: true }), audio('s', 0, 4, { group: 'g' })];

beforeEach(() => {
  useEditor.setState({ project: null, selection: [], past: [], future: [], clipboard: [] });
});

describe('freeze on a pair', () => {
  it('a freeze keeps the pair in sync with the same sound gap', () => {
    open([...pair(), audio('later', 6, 1, { assetId: 'song' })]);
    const before = proj();
    const id = placeFreeze('v', 2, 'still');
    expect(id).not.toBeNull();
    // one undo step
    expect(ed().past.length).toBe(1);
    const still = proj().clips.find((c) => c.id === id) as ImageClip;
    expect(still).toMatchObject({ type: 'image', start: 2, duration: FREEZE_DURATION });
    // the picture: 0..2, the still 2..4, the rest 4..6
    const pics = proj().clips.filter((c) => c.type === 'video').sort((a, b) => a.start - b.start);
    expect(pics.map((c) => [c.start, c.duration])).toEqual([[0, 2], [4, 2]]);
    // the sound has the same gap
    const sounds = proj().clips.filter((c) => c.type === 'audio' && c.assetId === 'av').sort((a, b) => a.start - b.start) as AudioClip[];
    expect(sounds.map((c) => [c.start, c.duration])).toEqual([[0, 2], [4, 2]]);
    expect(sounds[1]!.trimStart).toBeCloseTo(2);
    // every half still has its mate and is in sync
    for (const p of pics) {
      expect(mateOf(proj().clips, p.id)?.type).toBe('audio');
      expect(syncLabel(proj().clips, p.id, 30)).toBeNull();
    }
    for (const s of sounds) expect(syncLabel(proj().clips, s.id, 30)).toBeNull();
    expect(pics[0]!.group).not.toBe(pics[1]!.group);
    // the other clip on the sound track moved with the gap
    expect((proj().clips.find((c) => c.id === 'later') as AudioClip).start).toBe(6 + FREEZE_DURATION);
    ed().undo();
    expect(proj()).toEqual(before);
    ed().redo();
    expect(proj().clips.find((c) => c.id === id)).toBeTruthy();
  });

  it('at the edge of the clip nothing is cut and the sound shifts', () => {
    open([video('v', 2, 4, { group: 'g', muted: true }), audio('s', 2, 4, { group: 'g' })]);
    // the freeze at the very start: the still goes before the clip, picture and sound both move right
    const id = placeFreeze('v', 2, 'still');
    expect(id).not.toBeNull();
    expect(proj().clips.find((c) => c.id === 'v')!.start).toBe(2 + FREEZE_DURATION);
    expect(proj().clips.find((c) => c.id === 's')!.start).toBe(2 + FREEZE_DURATION);
    expect(syncLabel(proj().clips, 's', 30)).toBeNull();
  });

  it('a sound track a clip crosses is left out, the badge shows it', () => {
    open([...pair(), audio('wide', 1, 3, { assetId: 'song', trackId: 'a2' })], [track('v1', 'video'), track('a1', 'audio'), track('a2', 'audio')]);
    // the crossing clip is on a2: the sound on a1 is not touched by it
    expect(placeFreeze('v', 2, 'still')).not.toBeNull();
    expect(proj().clips.find((c) => c.id === 'wide')!.start).toBe(1);
    // a clip across the freeze on the sound's own track: the sound is left as today
    open([video('v', 0, 4, { group: 'g', muted: true }), audio('s', 0, 1, { group: 'g' }), audio('long', 1, 4, { assetId: 'song' })]);
    expect(placeFreeze('v', 2, 'still')).not.toBeNull();
    expect(proj().clips.find((c) => c.id === 'long')!.start).toBe(1);
    expect(ed().past.length).toBe(1);
  });

  it('a refused cut changes nothing', () => {
    open(pair(), [track('v1', 'video', { locked: true }), track('a1', 'audio')]);
    const before = proj();
    expect(placeFreeze('v', 2, 'still')).toBeNull();
    expect(proj()).toEqual(before);
    expect(placeFreeze('gone', 2, 'still')).toBeNull();
    expect(ed().past.length).toBe(0);
  });

  it('a plain video freezes as before', () => {
    open([video('v', 0, 4), video('w', 5, 1)]);
    const id = placeFreeze('v', 2, 'still');
    expect(id).not.toBeNull();
    expect(proj().clips.find((c) => c.id === 'w')!.start).toBe(5 + FREEZE_DURATION);
    expect(ed().past.length).toBe(1);
  });
});
