import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AudioClip, Clip, Crossfade, MediaAsset, Project, Track, VideoClip } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import { createProject } from '../../lib/factory';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { useUi } from '../../store/ui';
import { SHORTCUTS } from '../shell/shortcuts';
import { paletteActions } from '../shell/paletteActions';
import {
  clearCrossfadePick,
  crossfadeMenuNow,
  crossfadeNow,
  crossfadeTracksNow,
  crossfadeWithTransitionNow,
  fadeShapeNow,
  nudgeCrossfade,
  pickCrossfade,
  pickedCrossfade,
  removePickedCrossfade,
  setCrossfadeNow,
  setCrossfades,
  useCrossfadeMenu,
} from './crossfadeActions';
import { CROSS_TEXT } from './crossfadeText';
import { interaction } from './view';

const ed = () => useEditor.getState();
const proj = (): Project => ed().project!;
const lastToast = (): string => useUi.getState().toasts.at(-1)?.message ?? '';
const row = (id: string) => SHORTCUTS.find((s) => s.id === id)!;
const cfOf = (id: string): Crossfade | undefined => {
  const c = proj().clips.find((x) => x.id === id) as AudioClip | undefined;
  return c?.crossfade ?? undefined;
};
const f = (n: number): number => n / 30;

const track = (id: string, kind: 'video' | 'audio', over: Partial<Track> = {}): Track => ({ id, kind, name: id, muted: false, hidden: false, locked: false, ...over });
const asset = (id: string, kind: MediaAsset['kind'], hasAudio: boolean, duration = 60): MediaAsset => ({ id, name: id, kind, mime: '', size: 1, duration, width: 100, height: 100, hasAudio, createdAt: 0 });
const audio = (id: string, start: number, duration: number, over: Partial<AudioClip> = {}): AudioClip => ({
  id, type: 'audio', trackId: 'a1', start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'song', trimStart: 10, speed: 1, volume: 1, muted: false, ...over,
});
const video = (id: string, start: number, duration: number, over: Partial<VideoClip> = {}): VideoClip => ({
  id, type: 'video', trackId: 'v1', start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'av', trimStart: 10, speed: 1, volume: 1, muted: false, transform: { ...DEFAULT_TRANSFORM }, ...over,
});
const three = (over: { b?: Partial<AudioClip>; c?: Partial<AudioClip> } = {}): Clip[] => [audio('a', 0, 4, { trimStart: 10 }), audio('b', 4, 4, { trimStart: 30, ...over.b }), audio('c', 8, 4, { trimStart: 50, ...over.c })];

function open(clips: Clip[], tracks: Track[] = [track('v1', 'video'), track('a1', 'audio')]): void {
  ed().openProject({ ...createProject('cross'), assets: [asset('song', 'audio', true), asset('av', 'video', true)], tracks, clips });
  useEditor.setState({ past: [], future: [], selection: [] });
}

/** one undo step: it changes the project, undo takes all of it back, redo puts it again */
function oneStep(run: () => void): void {
  const before = proj();
  run();
  const after = proj();
  expect(ed().past.length).toBe(1);
  expect(after).not.toEqual(before);
  ed().undo();
  expect(proj()).toEqual(before);
  ed().redo();
  expect(proj()).toEqual(after);
  useEditor.setState({ past: [], future: [] });
}

beforeEach(() => {
  useEditor.setState({ project: null, selection: [], past: [], future: [], clipboard: [] });
  useUi.setState({ toasts: [], crossfadePick: null, trimEdge: null });
  useCrossfadeMenu.setState({ menu: null });
  usePlayback.setState({ time: 0 });
  interaction.gestureActive = false;
});
afterEach(() => {
  interaction.gestureActive = false;
});

describe('crossfade actions', () => {
  it('one undo step each', () => {
    open(three());
    ed().select(['a', 'b', 'c'], 'replace');
    oneStep(() => crossfadeNow());
    expect(cfOf('b')).toBeDefined();
    expect(cfOf('c')).toBeDefined();
    expect(lastToast()).toBe('2 crossfades added');
    // again: they go
    oneStep(() => crossfadeNow());
    expect(cfOf('b')).toBeUndefined();
    expect(lastToast()).toBe('2 crossfades removed');
    // one edit says what it did
    ed().select(['a'], 'replace');
    oneStep(() => crossfadeNow());
    expect(lastToast()).toBe('crossfade added: 4f before and 4f after the edit, equal power');
    useEditor.setState({ past: [], future: [] });
    // the track
    oneStep(() => crossfadeTracksNow(['a1'], 'add'));
    oneStep(() => crossfadeTracksNow(['a1'], 'remove'));
    expect(cfOf('b')).toBeUndefined();
    // a crossfade of one clip, with no opts: its own step
    oneStep(() => expect(setCrossfadeNow('b', { length: 0.5 })).toBeCloseTo(16 / 30, 5));
    oneStep(() => setCrossfadeNow('b', { shape: 'linear' }));
    expect(cfOf('b')?.shape).toBe('linear');
    oneStep(() => setCrossfadeNow('b', { remove: true }));
    expect(lastToast()).toBe('crossfade removed');
    // fade shapes
    oneStep(() => fadeShapeNow(['a', 'b'], 'smooth'));
    expect(lastToast()).toBe('fade shape set to smooth on 2 clips');
    oneStep(() => fadeShapeNow(null, 'linear'));
    // a pick: remove and nudge
    setCrossfadeNow('b', { length: 0.5 });
    useEditor.setState({ past: [], future: [] });
    pickCrossfade('b');
    expect(pickedCrossfade()).toBe('b');
    oneStep(() => expect(nudgeCrossfade(1)).toBe(true));
    oneStep(() => expect(removePickedCrossfade()).toBe(true));
  });

  it('a transition switch is one step', () => {
    open([video('x', 0, 4), video('y', 4, 4, { trimStart: 30, transition: { id: 'fade', duration: 1 } })]);
    oneStep(() => crossfadeWithTransitionNow('y', true));
    expect(cfOf('y')).toMatchObject({ before: 0.5, after: 0.5, withTransition: true });
    oneStep(() => crossfadeWithTransitionNow('y', false));
    expect(cfOf('y')).toEqual({ before: 0.5, after: 0.5 });
    // a clip without a transition says so
    crossfadeWithTransitionNow('x', true);
    expect(lastToast()).toBe(CROSS_TEXT.crossNoTransition);
  });

  it('a reason toasts and pushes nothing', () => {
    open(three());
    crossfadeNow();
    expect(lastToast()).toBe(CROSS_TEXT.crossNoEditHere);
    expect(ed().past.length).toBe(0);
    ed().select(['b'], 'replace');
    crossfadeTracksNow(null, 'remove');
    expect(lastToast()).toBe(CROSS_TEXT.crossNoneTrack);
    useUi.setState({ toasts: [] });
    ed().clearSelection();
    crossfadeTracksNow(null, 'add');
    expect(lastToast()).toBe('select a clip first');
    expect(ed().past.length).toBe(0);
    // a setCrossfadeNow that cannot do it: null, and a toast
    expect(setCrossfadeNow('a', { length: 0.5 })).toBeNull();
    expect(lastToast()).toBe(CROSS_TEXT.crossNoEdit);
    // with opts nothing toasts
    useUi.setState({ toasts: [] });
    expect(setCrossfadeNow('a', { length: 0.5 }, { skipHistory: true })).toBeNull();
    expect(useUi.getState().toasts).toHaveLength(0);
  });

  it('ctrl+a then delete deletes clips', () => {
    open(three({ b: { crossfade: { before: f(4), after: f(4) } } }));
    pickCrossfade('b');
    expect(pickedCrossfade()).toBe('b');
    row('select-all').run();
    // the selection is another array now: the pick does not count
    expect(pickedCrossfade()).toBeNull();
    row('delete').run();
    expect(proj().clips).toHaveLength(0);
  });

  it('delete with a pick keeps clips', () => {
    open(three({ b: { crossfade: { before: f(4), after: f(4) } } }));
    pickCrossfade('b');
    row('delete').run();
    expect(proj().clips).toHaveLength(3);
    expect(cfOf('b')).toBeUndefined();
    expect(ed().past.length).toBe(1);
    expect(lastToast()).toBe('crossfade removed');
    // the crossfade is gone: delete is a plain delete again
    expect(pickedCrossfade()).toBeNull();
    row('delete').run();
    expect(proj().clips.map((c) => c.id)).toEqual(['a', 'c']);
    // ripple delete takes the same way
    open(three({ b: { crossfade: { before: f(4), after: f(4) } } }));
    pickCrossfade('b');
    row('ripple-delete').run();
    expect(proj().clips).toHaveLength(3);
  });

  it('esc drops the pick first', () => {
    open(three({ b: { crossfade: { before: f(4), after: f(4) } } }));
    pickCrossfade('b');
    row('deselect').run();
    expect(useUi.getState().crossfadePick).toBeNull();
    expect(ed().selection).toEqual(['b']);
    row('deselect').run();
    expect(ed().selection).toEqual([]);
    // clearCrossfadePick says whether it counted
    pickCrossfade('b');
    expect(clearCrossfadePick()).toBe(true);
    expect(clearCrossfadePick()).toBe(false);
  });

  it('comma and period nudge the pick', () => {
    open(three({ b: { crossfade: { before: f(4), after: f(4) } } }));
    pickCrossfade('b');
    row('edge-next').run();
    expect(cfOf('b')!.before).toBeCloseTo(f(5), 6);
    expect(cfOf('b')!.after).toBeCloseTo(f(5), 6);
    row('edge-prev').run();
    row('edge-prev').run();
    expect(cfOf('b')!.before).toBeCloseTo(f(3), 6);
    // shift: ten frames
    row('key-next').run();
    expect(cfOf('b')!.before).toBeCloseTo(f(13), 6);
    row('key-prev').run();
    row('key-prev').run();
    row('key-prev').run();
    // the floor is a frame, and it says so
    expect(cfOf('b')!.before).toBeCloseTo(f(1), 6);
    expect(lastToast()).toBe('one frame is the shortest crossfade: delete removes it');
    // no pick: the playhead moves instead
    useUi.getState().setCrossfadePick(null);
    const before = cfOf('b');
    usePlayback.setState({ time: 5 });
    row('edge-next').run();
    expect(cfOf('b')).toEqual(before);
    expect(usePlayback.getState().time).toBe(8);
  });

  it('the menu opens under the pick', () => {
    open(three({ b: { crossfade: { before: f(4), after: f(4) } } }));
    expect(crossfadeMenuNow()).toBe(false);
    pickCrossfade('b');
    expect(crossfadeMenuNow()).toBe(true);
    expect(useCrossfadeMenu.getState().menu).toEqual({ clipId: 'b', at: null, focusFirst: true });
    useCrossfadeMenu.getState().close();
    expect(useCrossfadeMenu.getState().menu).toBeNull();
    row('clip-menu').run();
    expect(useCrossfadeMenu.getState().menu?.clipId).toBe('b');
  });

  it('a locked clip keeps the selection and gets no pick', () => {
    open(three({ b: { crossfade: { before: f(4), after: f(4) } } }), [track('v1', 'video'), track('a1', 'audio', { locked: true })]);
    useEditor.setState({ selection: ['zz'] });
    const sel = ed().selection;
    pickCrossfade('b');
    expect(useUi.getState().crossfadePick).toBeNull();
    expect(ed().selection).toBe(sel);
    // locked: delete, nudge and the menu leave it alone
    expect(removePickedCrossfade()).toBe(false);
    crossfadeNow();
    expect(cfOf('b')).toBeDefined();
  });

  it('nothing during a gesture', () => {
    open(three({ b: { crossfade: { before: f(4), after: f(4) } } }));
    ed().select(['a', 'b', 'c'], 'replace');
    pickCrossfade('b');
    const before = proj();
    interaction.gestureActive = true;
    crossfadeNow();
    crossfadeTracksNow(['a1'], 'add');
    fadeShapeNow(['a'], 'smooth');
    expect(setCrossfadeNow('b', { length: 1 })).toBeNull();
    // a pick that counts still owns the key: it does nothing, delete does not reach the clips
    expect(removePickedCrossfade()).toBe(true);
    expect(nudgeCrossfade(1)).toBe(true);
    expect(proj()).toBe(before);
    expect(ed().past.length).toBe(0);
    expect(useUi.getState().toasts).toHaveLength(0);
    interaction.gestureActive = false;
    crossfadeNow();
    expect(proj()).not.toBe(before);
  });

  it('the key row crossfades, again removes', () => {
    open(three());
    ed().select(['b'], 'replace');
    row('crossfade').run();
    expect(cfOf('b')).toBeDefined();
    expect(cfOf('c')).toBeDefined();
    row('crossfade').run();
    expect(cfOf('b')).toBeUndefined();
    // the palette rows
    const act = (id: string) => paletteActions().find((a) => a.id === id)!;
    act('crossfade-track').run();
    expect(cfOf('c')).toBeDefined();
    act('crossfade-track-off').run();
    expect(cfOf('c')).toBeUndefined();
    act('fade-shape-power').run();
    expect((proj().clips.find((c) => c.id === 'b') as AudioClip).fadeInShape).toBe('power');
    act('fade-shape-linear').run();
    expect((proj().clips.find((c) => c.id === 'b') as AudioClip).fadeInShape).toBeUndefined();
  });

  it('setCrossfades in the caller step', () => {
    open(three());
    const before = proj();
    ed().pushHistory();
    const r = setCrossfades({ ids: ['b'], at: 'start', change: { length: 0.5 } }, { skipHistory: true });
    expect(typeof r).toBe('object');
    expect(r).toMatchObject({ removed: [], skipped: [] });
    const set = (r as { set: { clip: string; edit: number; before: number; after: number; shape: string; short?: string }[] }).set;
    expect(set).toHaveLength(1);
    expect(set[0]).toMatchObject({ clip: 'b', edit: 4, shape: 'power' });
    expect(set[0]!.before).toBeCloseTo(f(8), 5);
    expect(set[0]!.short).toBeUndefined();
    // its own history: none, so the caller's step is the only one
    expect(ed().past.length).toBe(1);
    ed().undo();
    expect(proj()).toEqual(before);
    ed().redo();
    expect(cfOf('b')).toBeDefined();
    useEditor.setState({ past: [], future: [] });

    // ids with at: the end of a clip is the edit of the clip after it
    open(three());
    ed().pushHistory();
    const e = setCrossfades({ ids: ['a'], at: 'end', change: {} }, { skipHistory: true });
    expect((e as { set: { clip: string }[] }).set.map((x) => x.clip)).toEqual(['b']);
    // both ends of b: its own start and its end
    const both = setCrossfades({ ids: ['b'], change: { place: 'start', length: 0.25 } }, { skipHistory: true });
    const b = both as { set: { clip: string; before: number; after: number }[] };
    expect(b.set.map((x) => x.clip)).toEqual(['b', 'c']);
    expect(b.set[0]!.before).toBe(0);
    expect(b.set[0]!.after).toBeCloseTo(f(8), 5);
    // nothing to do: a string, and it changed nothing
    const none = setCrossfades({ ids: ['a'], at: 'start', change: {} }, { skipHistory: true });
    expect(none).toBe(CROSS_TEXT.crossNoEdit);
    // a track, a one take edit left alone
    open([audio('a', 0, 4, { trimStart: 10 }), audio('b', 4, 4, { trimStart: 14 }), audio('c', 8, 4, { trimStart: 50 })]);
    ed().pushHistory();
    const t = setCrossfades({ track: 'a1', change: {} }, { skipHistory: true }) as { set: { clip: string }[]; skipped: { id: string; why: string }[] };
    expect(t.set.map((x) => x.clip)).toEqual(['c']);
    expect(t.skipped).toEqual([{ id: 'b', why: CROSS_TEXT.crossOneTake }]);
    // a remove on the track, waiting ones too
    const rm = setCrossfades({ track: 'a1', change: { remove: true } }, { skipHistory: true }) as { removed: string[] };
    expect(rm.removed).toEqual(['c']);
    // short: no media before the edit
    open(three({ b: { trimStart: 0 } }));
    ed().pushHistory();
    const sh = setCrossfades({ ids: ['b'], at: 'start', change: {} }, { skipHistory: true }) as { set: { short?: string; before: number }[] };
    expect(sh.set[0]).toMatchObject({ before: 0, short: 'media' });
    // a locked track
    open(three(), [track('v1', 'video'), track('a1', 'audio', { locked: true })]);
    expect(setCrossfades({ ids: ['b'], at: 'start', change: {} }, { skipHistory: true })).toBe('the track is locked');
    expect(setCrossfades({ track: 'a1', change: {} }, { skipHistory: true })).toBe('the track is locked');
  });
});
