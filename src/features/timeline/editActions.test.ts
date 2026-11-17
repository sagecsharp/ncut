import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioClip, Clip, ImageClip, MediaAsset, Project, Track, VideoClip } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import { createProject } from '../../lib/factory';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { useSource } from '../../store/source';
import { useUi } from '../../store/ui';
import { AUTO_TARGETS } from './editPlan';
import type { EditInput } from './editPlan';
import { EDIT_TEXT } from './editText';
import { editInputNow, editNow, runEdit, targetSelectedNow, targetsAutoNow } from './editActions';
import { currentTargets, resetEditTargets, setEditTarget } from './editTargets';
import { useSoundApart } from './soundSetting';

const ed = () => useEditor.getState();
const proj = (): Project => ed().project!;
const clipOf = (id: string): Clip => proj().clips.find((c) => c.id === id)!;
const toasts = (): string[] => useUi.getState().toasts.map((t) => t.message);
const track = (id: string, kind: 'video' | 'audio', over: Partial<Track> = {}): Track => ({ id, kind, name: id === 'v1' ? 'video 1' : id === 'a1' ? 'audio 1' : id, muted: false, hidden: false, locked: false, ...over });
const asset = (id: string, kind: MediaAsset['kind'], duration: number, hasAudio: boolean, over: Partial<MediaAsset> = {}): MediaAsset => ({
  id, name: id, kind, mime: kind + '/x', size: 1, duration, width: 100, height: 100, hasAudio, createdAt: 0, ...over,
});
const video = (id: string, trackId: string, start: number, duration: number, over: Partial<VideoClip> = {}): VideoClip => ({
  id, type: 'video', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'old', trimStart: 0, speed: 1, volume: 1, muted: false, transform: { ...DEFAULT_TRANSFORM }, ...over,
});
const audio = (id: string, trackId: string, start: number, duration: number, over: Partial<AudioClip> = {}): AudioClip => ({
  id, type: 'audio', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'old', trimStart: 0, speed: 1, volume: 1, muted: false, ...over,
});
const image = (id: string, trackId: string, start: number, duration: number, over: Partial<ImageClip> = {}): ImageClip => ({
  id, type: 'image', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'pic', transform: { ...DEFAULT_TRANSFORM }, ...over,
});

const TRACKS = [track('v2', 'video'), track('v1', 'video'), track('a1', 'audio'), track('a2', 'audio')];
const ASSETS = [
  asset('vid', 'video', 10, true, { marks: { in: 2, out: 6 } }),
  asset('old', 'video', 10, true),
  asset('silent', 'video', 10, false),
  asset('song', 'audio', 8, true),
  asset('pic', 'image', 0, false),
];

function open(clips: Clip[], over: Partial<Project> = {}, tracks: Track[] = TRACKS): void {
  ed().openProject({ ...createProject('edits'), tracks, assets: ASSETS, clips, ...over });
  useEditor.setState({ selection: [], past: [], future: [], clipboard: [] });
  usePlayback.setState({ time: 0, playing: false });
  useSource.setState({ assetId: 'vid', time: 0, playing: false });
}

const input = (over: Partial<EditInput> = {}): EditInput => ({ mode: 'insert', assetId: 'vid', playhead: 0, targets: AUTO_TARGETS, apart: false, selection: [], ...over });
const onTrack = (id: string): Clip[] => proj().clips.filter((c) => c.trackId === id).sort((a, b) => a.start - b.start);
const spans = (id: string): [number, number][] => onTrack(id).map((c) => [Math.round(c.start * 1e6) / 1e6, Math.round((c.start + c.duration) * 1e6) / 1e6]);

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  vi.stubGlobal('performance', { now: () => 0 });
  useEditor.setState({ project: null, selection: [], past: [], future: [], clipboard: [] });
  useUi.setState({ toasts: [], previewMode: 'output' });
  resetEditTargets();
  useSoundApart.setState({ apart: false });
  usePlayback.setState({ time: 0, playing: false });
  useSource.setState({ assetId: null, time: 0, playing: false });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('runEdit', () => {
  it('one undo step', () => {
    open([video('a', 'v1', 0, 6)]);
    const before = JSON.stringify(proj());
    const r = runEdit(input({ playhead: 3 }));
    expect(r.ok).toBe(true);
    expect(ed().past).toHaveLength(1);
    expect(proj().clips.length).toBeGreaterThan(1);
    ed().undo();
    expect(JSON.stringify(proj())).toBe(before);
    expect(ed().past).toHaveLength(0);
    // overwrite and replace too
    open([video('a', 'v1', 0, 6)]);
    runEdit(input({ mode: 'overwrite', playhead: 2 }));
    expect(ed().past).toHaveLength(1);
    open([video('a', 'v1', 0, 6, { trimStart: 1 })]);
    runEdit(input({ mode: 'replace', playhead: 2, sourceTime: 5 }));
    expect(ed().past).toHaveLength(1);
  });

  it('insert moves every unlocked track and splits across the edit point', () => {
    open([video('a', 'v1', 0, 6), audio('b', 'a1', 4, 2), video('c', 'v2', 5, 1), audio('d', 'a2', 0, 2)]);
    const r = runEdit(input({ playhead: 3 }));
    expect(r).toMatchObject({ ok: true, failed: null, mode: 'insert', start: 3, length: 4, from: 2, speed: 1, split: 1, moved: 3, removed: 0, lockedTracks: [] });
    // a is cut at 3, its right half moves 4 later, the new clip sits between
    expect(spans('v1')).toEqual([[0, 3], [3, 7], [7, 10]]);
    expect(spans('a1')).toEqual([[8, 10]]);
    expect(spans('v2')).toEqual([[9, 10]]);
    expect(spans('a2')).toEqual([[0, 2]]);
    const made = onTrack('v1')[1] as VideoClip;
    expect(made).toMatchObject({ assetId: 'vid', trimStart: 2, duration: 4 });
    expect(r.clips).toEqual([made.id]);
    expect(made.id).toMatch(/^clp_/);
    expect(ed().selection).toEqual([made.id]);
    expect(usePlayback.getState().time).toBe(7);
  });

  it('insert names locked tracks', () => {
    const tracks = TRACKS.map((t) => (t.id === 'a2' ? { ...t, locked: true } : t));
    open([video('a', 'v1', 0, 6), audio('d', 'a2', 2, 6), audio('e', 'a1', 4, 2)], {}, tracks);
    const r = runEdit(input({ playhead: 3 }));
    expect(r.ok).toBe(true);
    expect(r.lockedTracks).toEqual(['a2']);
    expect(clipOf('d')).toMatchObject({ start: 2, duration: 6 });
    expect(spans('a1')).toEqual([[8, 10]]);
    open([video('a', 'v1', 0, 6), audio('d', 'a2', 4, 2)], {}, tracks);
    editNow('insert');
    expect(toasts().at(-1)).toContain('locked tracks did not move: a2');
  });

  it('insert at a join drops the moved transition', () => {
    const tr = { id: 'fade', duration: 0.5 } as unknown as ImageClip['transition'];
    open([image('a', 'v1', 0, 3), image('b', 'v1', 3, 3, { transition: tr })]);
    runEdit(input({ playhead: 3 }));
    expect((clipOf('b') as ImageClip).transition ?? null).toBeNull();
    expect(clipOf('b').start).toBe(7);
    // an insert elsewhere keeps it
    open([image('a', 'v1', 0, 3), image('b', 'v1', 3, 3, { transition: tr })]);
    runEdit(input({ playhead: 8 }));
    expect((clipOf('b') as ImageClip).transition).toEqual(tr);
  });

  it('overwrite changes only the landing tracks', () => {
    open([video('a', 'v1', 0, 10), audio('b', 'a1', 0, 10), video('c', 'v2', 3, 2)], { range: { in: 2, out: 4 } });
    const b = clipOf('b');
    const c = clipOf('c');
    const r = runEdit(input({ mode: 'overwrite' }));
    expect(r).toMatchObject({ ok: true, start: 2, length: 2, split: 1, removed: 0, moved: 0 });
    expect(spans('v1')).toEqual([[0, 2], [2, 4], [4, 10]]);
    expect(clipOf('b')).toBe(b);
    expect(clipOf('c')).toBe(c);
    expect(onTrack('v1')[1]).toMatchObject({ trimStart: 2, duration: 2 });
    // the clip covered whole goes
    open([image('a', 'v1', 3, 1), image('x', 'v1', 8, 1)]);
    const r2 = runEdit(input({ mode: 'overwrite', playhead: 2 }));
    expect(r2.removed).toBe(1);
    expect(spans('v1')).toEqual([[2, 6], [8, 9]]);
  });

  it('fit sets the speed', () => {
    open([video('a', 'v1', 0, 10)], { range: { in: 1, out: 3 } });
    const r = runEdit(input({ mode: 'fit' }));
    expect(r).toMatchObject({ ok: true, start: 1, length: 2, from: 2, speed: 2 });
    const made = onTrack('v1')[1] as VideoClip;
    expect(made).toMatchObject({ speed: 2, duration: 2, trimStart: 2 });
    expect(spans('v1')).toEqual([[0, 1], [1, 3], [3, 10]]);
    expect(proj().range).toBeUndefined();
    // a range that needs a faster speed than 4x stops
    open([video('a', 'v1', 0, 10)], { range: { in: 1, out: 1.5 } });
    const bad = runEdit(input({ mode: 'fit' }));
    expect(bad).toMatchObject({ ok: false, failed: 'plan' });
    expect(bad.reason).toContain('faster than 4x');
    expect(proj().range).toEqual({ in: 1, out: 1.5 });
  });

  it('replace keeps id, length, look and sound sync', () => {
    const look = { ...DEFAULT_TRANSFORM, x: 0.3 };
    open([video('c', 'v1', 2, 6, { trimStart: 1, group: 'g', transform: look, fadeIn: 0.5 }), audio('s', 'a1', 2, 6, { trimStart: 1, group: 'g' })]);
    usePlayback.setState({ time: 4 });
    const r = runEdit(input({ mode: 'replace', playhead: 4, sourceTime: 5 }));
    expect(r).toMatchObject({ ok: true, clips: ['c', 's'], start: 2, length: 6, from: 3 });
    const c = clipOf('c') as VideoClip;
    const s = clipOf('s') as AudioClip;
    expect(c).toMatchObject({ id: 'c', assetId: 'vid', start: 2, duration: 6, trimStart: 3, group: 'g', fadeIn: 0.5 });
    expect(c.transform).toEqual(look);
    expect(s).toMatchObject({ assetId: 'vid', start: 2, duration: 6, trimStart: 3 });
    // the frame of the media at the playhead
    expect(c.trimStart + (4 - c.start)).toBe(5);
    // the playhead stays, the clip and its sound clip are selected
    expect(usePlayback.getState().time).toBe(4);
    expect(ed().selection.sort()).toEqual(['c', 's']);
    expect(ed().past).toHaveLength(1);
  });

  it('append', () => {
    open([video('a', 'v1', 0, 3), audio('b', 'a1', 0, 9)], { range: { in: 1, out: 2 } });
    const before = proj().clips;
    const r = runEdit(input({ mode: 'append' }));
    expect(r).toMatchObject({ ok: true, start: 3, length: 4, moved: 0, split: 0, removed: 0 });
    expect(spans('v1')).toEqual([[0, 3], [3, 7]]);
    expect(proj().clips.slice(0, 2)).toEqual(before);
    expect(proj().range).toEqual({ in: 1, out: 2 });
    expect(r.rangeCleared).toBeNull();
    expect(usePlayback.getState().time).toBe(7);
  });

  it('a plan stop keeps redo', () => {
    open([video('a', 'v1', 0, 6)]);
    runEdit(input({ playhead: 3 }));
    ed().undo();
    expect(ed().future).toHaveLength(1);
    const before = proj();
    const r = runEdit(input({ targets: { picture: false, sound: false } }));
    expect(r).toMatchObject({ ok: false, failed: 'plan', reason: EDIT_TEXT.targetsOff, clips: [], moved: 0 });
    expect(proj()).toBe(before);
    expect(ed().future).toHaveLength(1);
    expect(ed().past).toHaveLength(0);
    expect(runEdit(input({ assetId: 'gone' }))).toMatchObject({ failed: 'plan', reason: EDIT_TEXT.mediaGone });
  });

  it('a failed split rolls back', () => {
    open([video('a', 'v1', 0, 6), image('b', 'v1', 6, 2)]);
    const before = JSON.stringify(proj());
    const keep = ed().splitClips;
    useEditor.setState({ splitClips: () => [] });
    const r = runEdit(input({ playhead: 3 }));
    useEditor.setState({ splitClips: keep });
    expect(r).toMatchObject({ ok: false, failed: 'apply', moved: 0, clips: [] });
    expect(r.reason).toBe('insert stopped: "a" could not be split at the edit');
    expect(JSON.stringify(proj())).toBe(before);
    expect(ed().past).toHaveLength(0);
    // a toast says it as an error
    useEditor.setState({ splitClips: () => [] });
    open([video('a', 'v1', 0, 6)]);
    usePlayback.setState({ time: 3 });
    editNow('insert');
    useEditor.setState({ splitClips: keep });
    expect(useUi.getState().toasts.at(-1)).toMatchObject({ kind: 'error' });
  });

  it('a failed split after a write rolls back that write and loses redo', () => {
    const tracks = [track('v1', 'video', { locked: true }), track('a1', 'audio')];
    open([audio('s', 'a1', 0, 6)], {}, tracks);
    // an undone step first, so there is a redo to lose
    ed().updateClip('s', { volume: 0.5 });
    ed().undo();
    expect(ed().future).toHaveLength(1);
    const before = JSON.stringify(proj());
    const keep = ed().splitClips;
    let tracksAtSplit = 0;
    useEditor.setState({ splitClips: () => { tracksAtSplit = proj().tracks.length; return []; } });
    const r = runEdit(input({ playhead: 3, assetId: 'silent' }));
    useEditor.setState({ splitClips: keep });
    // the new video track was already written when the split failed
    expect(tracksAtSplit).toBe(3);
    expect(r).toMatchObject({ ok: false, failed: 'apply', moved: 0, clips: [] });
    expect(proj().tracks).toHaveLength(2);
    expect(JSON.stringify(proj())).toBe(before);
    expect(ed().past).toHaveLength(0);
    expect(ed().future).toHaveLength(0);
  });

  it('a new track when all are locked', () => {
    const locked = TRACKS.map((t) => ({ ...t, locked: true }));
    open([video('a', 'v1', 0, 6)], {}, locked);
    const r = runEdit(input({ playhead: 1 }));
    expect(r.ok).toBe(true);
    expect(r.newTracks).toHaveLength(1);
    expect(proj().tracks).toHaveLength(5);
    const made = clipOf(r.clips[0]!);
    expect(made.trackId).toBe(r.newTracks[0]);
    expect(proj().tracks.find((t) => t.id === made.trackId)).toMatchObject({ kind: 'video', locked: false });
    expect(clipOf('a')).toMatchObject({ start: 0, duration: 6 });
    ed().undo();
    expect(proj().tracks).toHaveLength(4);
    // a locked target that is named stops and writes nothing
    open([video('a', 'v1', 0, 6)], {}, locked);
    const before = proj();
    expect(runEdit(input({ targets: { picture: 'v1', sound: null } }))).toMatchObject({ failed: 'plan' });
    expect(proj()).toBe(before);
  });

  it('a sound pair with separate sound on', () => {
    open([]);
    const r = runEdit(input({ apart: true, playhead: 1 }));
    expect(r.ok).toBe(true);
    expect(r.clips).toHaveLength(2);
    const v = clipOf(r.clips[0]!) as VideoClip;
    const s = clipOf(r.clips[1]!) as AudioClip;
    expect(v).toMatchObject({ trackId: 'v1', muted: true, start: 1, trimStart: 2, duration: 4 });
    expect(s).toMatchObject({ trackId: 'a1', muted: false, start: 1, trimStart: 2, duration: 4 });
    expect(v.group).toBeTruthy();
    expect(s.group).toBe(v.group);
    expect(v.group).toMatch(/^grp_/);
    expect(ed().selection).toEqual(r.clips);
    // the setting off: one clip with its sound
    open([]);
    const one = runEdit(input({ playhead: 1 }));
    expect(one.clips).toHaveLength(1);
    expect((clipOf(one.clips[0]!) as VideoClip).muted).toBe(false);
  });
});

describe('editNow', () => {
  it('the range is cleared only when used, the toast undo only right after', () => {
    open([video('a', 'v1', 0, 6)], { range: { in: 1, out: 3 } });
    editNow('insert');
    expect(proj().range).toBeUndefined();
    const t = useUi.getState().toasts.at(-1)!;
    expect(t.message).toContain('inserted 2s of "vid" at 00:01:00');
    expect(t.message).toContain('the in and out points were cleared');
    expect(t.action?.label).toBe('undo');
    t.action!.run();
    expect(proj().range).toEqual({ in: 1, out: 3 });
    expect(proj().clips).toHaveLength(1);
    // ctrl+z alone does not bring it back
    open([video('a', 'v1', 0, 6)], { range: { in: 1, out: 3 } });
    editNow('insert');
    ed().undo();
    expect(proj().range).toBeUndefined();
    // the project changed since: the toast undo says so and undoes nothing
    open([video('a', 'v1', 0, 6)], { range: { in: 1, out: 3 } });
    editNow('insert');
    const late = useUi.getState().toasts.at(-1)!;
    ed().updateClip('a', { name: 'renamed' });
    const done = proj();
    late.action!.run();
    expect(proj()).toBe(done);
    expect(toasts().at(-1)).toBe(EDIT_TEXT.undoLate);
    // no range used: no button
    open([video('a', 'v1', 0, 6)]);
    editNow('insert');
    expect(useUi.getState().toasts.at(-1)!.action).toBeUndefined();
    // a range that was given is never cleared
    open([video('a', 'v1', 0, 6)], { range: { in: 1, out: 3 } });
    runEdit(input({ range: { in: 4, out: 5 } }));
    expect(proj().range).toEqual({ in: 1, out: 3 });
    // only the in point was used: the toast says which
    open([video('a', 'v1', 0, 6)], { range: { in: 1 } });
    editNow('overwrite');
    expect(toasts().at(-1)).toContain('the in point was cleared');
  });

  it('source marks and markers stay', () => {
    open([video('a', 'v1', 0, 6)], { markers: [{ id: 'm', time: 4, name: 'm' } as unknown as NonNullable<Project['markers']>[number]], range: { in: 1, out: 3 } });
    const markers = proj().markers;
    runEdit(input());
    expect(proj().markers).toBe(markers);
    expect(proj().assets.find((a) => a.id === 'vid')!.marks).toEqual({ in: 2, out: 6 });
    // a marker after the edit point does not move
    open([video('a', 'v1', 0, 6)], { markers: [{ id: 'm', time: 4, name: 'm' } as unknown as NonNullable<Project['markers']>[number]] });
    runEdit(input({ playhead: 2 }));
    expect(proj().markers![0]!.time).toBe(4);
  });

  it('playhead and selection', () => {
    open([video('a', 'v1', 0, 6)]);
    usePlayback.setState({ time: 1 });
    useEditor.setState({ selection: ['a'] });
    editNow('overwrite');
    const made = onTrack('v1').find((c) => c.id !== 'a' && c.start === 1)!;
    expect(made).toBeTruthy();
    expect(ed().selection).toEqual([made.id]);
    expect(usePlayback.getState().time).toBe(5);
    // a refused edit leaves both
    useEditor.setState({ selection: ['a'] });
    usePlayback.setState({ time: 2 });
    editNow('fit');
    expect(toasts().at(-1)).toBe(EDIT_TEXT.needsRange);
    expect(ed().selection).toEqual(['a']);
    expect(usePlayback.getState().time).toBe(2);
  });

  it('players pause first', () => {
    open([video('a', 'v1', 0, 6)]);
    usePlayback.setState({ playing: true });
    useSource.setState({ playing: true });
    const i = editInputNow('insert');
    expect(i).toMatchObject({ mode: 'insert', assetId: 'vid', playhead: 0, sourceTime: 0, apart: false, selection: [] });
    expect(usePlayback.getState().playing).toBe(false);
    expect(useSource.getState().playing).toBe(false);
    expect(i!.targets).toEqual(AUTO_TARGETS);
    // the targets and the setting come along
    setEditTarget('picture', 'v2');
    useSoundApart.setState({ apart: true });
    expect(editInputNow('append')).toMatchObject({ mode: 'append', apart: true, targets: { picture: 'v2', sound: null } });
    // no source media: nothing to edit, and a toast says so
    useSource.setState({ assetId: null });
    expect(editInputNow('insert')).toBeNull();
    const before = proj();
    editNow('insert');
    expect(proj()).toBe(before);
    expect(toasts().at(-1)).toContain('click a media card first');
  });

  it('replace says which clip was replaced and slipped', () => {
    open([video('c', 'v1', 0, 5, { trimStart: 1, assetId: 'vid' })]);
    usePlayback.setState({ time: 2 });
    useSource.setState({ time: 5 });
    editNow('replace');
    expect(toasts().at(-1)).toBe('slipped "c": this frame of the media is at the playhead now');
    open([video('c', 'v1', 0, 5, { trimStart: 1 })]);
    usePlayback.setState({ time: 2 });
    useSource.setState({ time: 5 });
    editNow('replace');
    expect(toasts().at(-1)).toBe('replaced "c" with "vid", frame matched');
    expect((clipOf('c') as VideoClip).assetId).toBe('vid');
  });
});

describe('targets rows', () => {
  it('targetsAutoNow and targetSelectedNow', () => {
    open([video('a', 'v2', 0, 4), audio('b', 'a2', 0, 4)]);
    setEditTarget('picture', false);
    targetsAutoNow();
    expect(currentTargets(proj().id)).toEqual(AUTO_TARGETS);
    expect(toasts().at(-1)).toBe(EDIT_TEXT.targetsAuto);
    targetSelectedNow();
    expect(toasts().at(-1)).toBe(EDIT_TEXT.targetsNone);
    useEditor.setState({ selection: ['a', 'b'] });
    targetSelectedNow();
    expect(currentTargets(proj().id)).toEqual({ picture: 'v2', sound: 'a2' });
    expect(toasts().at(-1)).toBe('targets: v2 and a2');
  });
});
