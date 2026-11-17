import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioClip, Clip, MediaAsset, Project, Track, VideoClip } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import { createProject } from '../../lib/factory';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { useSource } from '../../store/source';
import { useUi } from '../../store/ui';
import { AUTO_TARGETS } from '../timeline/editPlan';
import type { EditMode, EditTargets } from '../timeline/editPlan';
import { EDIT_TEXT } from '../timeline/editText';
import { editNow, targetSelectedNow } from '../timeline/editActions';
import { currentTargets, resetEditTargets, setEditTarget } from '../timeline/editTargets';
import { useSoundApart } from '../timeline/soundSetting';
import { REASON_IDS, REASON_TEXT, reasonFor, reasonSnapshot } from './reasons';

const ed = () => useEditor.getState();

const track = (id: string, kind: 'video' | 'audio', over: Partial<Track> = {}): Track => ({ id, kind, name: id, muted: false, hidden: false, locked: false, ...over });
const asset = (id: string, kind: MediaAsset['kind'], duration: number, hasAudio: boolean, over: Partial<MediaAsset> = {}): MediaAsset => ({
  id, name: id, kind, mime: kind + '/x', size: 1, duration, width: 100, height: 100, hasAudio, createdAt: 0, ...over,
});
const video = (id: string, trackId: string, start: number, duration: number, over: Partial<VideoClip> = {}): VideoClip => ({
  id, type: 'video', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'old', trimStart: 0, speed: 1, volume: 1, muted: false, transform: { ...DEFAULT_TRANSFORM }, ...over,
});
const audio = (id: string, trackId: string, start: number, duration: number, over: Partial<AudioClip> = {}): AudioClip => ({
  id, type: 'audio', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'old', trimStart: 0, speed: 1, volume: 1, muted: false, ...over,
});

const TRACKS = [track('v1', 'video'), track('a1', 'audio')];
const ASSETS = [asset('vid', 'video', 10, true, { marks: { in: 2, out: 6 } }), asset('old', 'video', 10, true), asset('short', 'video', 0.03, true)];
const IDS: [string, EditMode][] = [['insert-edit', 'insert'], ['overwrite-edit', 'overwrite'], ['replace-edit', 'replace'], ['fit-edit', 'fit'], ['append-edit', 'append']];

interface Fixture { name: string; clips: Clip[]; tracks?: Track[]; range?: Project['range']; source?: string | null; targets?: EditTargets; time?: number; selection?: string[]; apart?: boolean }
const FIXTURES: Fixture[] = [
  { name: 'an empty timeline', clips: [] },
  { name: 'a clip under the playhead', clips: [video('c', 'v1', 0, 8, { trimStart: 1 })], time: 3 },
  { name: 'a range', clips: [video('c', 'v1', 0, 8)], range: { in: 1, out: 3 }, time: 3 },
  { name: 'a range too long for the media', clips: [video('c', 'v1', 0, 8)], range: { in: 0, out: 12 } },
  { name: 'a range too short', clips: [video('c', 'v1', 0, 8)], range: { in: 1, out: 1.02 } },
  { name: 'a range too fast to fit', clips: [video('c', 'v1', 0, 8)], range: { in: 1, out: 1.5 } },
  { name: 'both targets off', clips: [video('c', 'v1', 0, 8)], targets: { picture: false, sound: false }, time: 3 },
  { name: 'the picture target off', clips: [video('c', 'v1', 0, 8)], targets: { picture: false, sound: null }, time: 3 },
  { name: 'a locked video track', clips: [video('c', 'v1', 0, 8)], tracks: [track('v1', 'video', { locked: true }), track('a1', 'audio')], targets: { picture: 'v1', sound: null }, time: 3 },
  { name: 'every track locked', clips: [video('c', 'v1', 0, 8)], tracks: TRACKS.map((t) => ({ ...t, locked: true })), time: 3 },
  { name: 'a sound clip under the playhead', clips: [audio('s', 'a1', 0, 8)], time: 3 },
  { name: 'a clip selected away from the playhead', clips: [video('c', 'v1', 0, 4)], selection: ['c'], time: 6 },
  { name: 'media too short', clips: [video('c', 'v1', 0, 8)], source: 'short', time: 3 },
  { name: 'the same media at the same frame', clips: [video('c', 'v1', 0, 8, { assetId: 'vid', trimStart: 2 })], time: 3 },
];

function open(f: Fixture): void {
  ed().openProject({ ...createProject('reasons'), tracks: f.tracks ?? TRACKS, assets: ASSETS, clips: f.clips, ...(f.range ? { range: f.range } : {}) });
  useEditor.setState({ selection: f.selection ?? [], past: [], future: [], clipboard: [] });
  usePlayback.setState({ time: f.time ?? 0, playing: false });
  useSource.setState({ assetId: f.source === undefined ? 'vid' : f.source, time: 0, playing: false });
  resetEditTargets();
  if (f.targets) {
    if (f.targets.picture !== null) setEditTarget('picture', f.targets.picture);
    if (f.targets.sound !== null) setEditTarget('sound', f.targets.sound);
  }
  useSoundApart.setState({ apart: f.apart ?? false });
}

const snap = () => ({ ...reasonSnapshot() });

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  useEditor.setState({ project: null, selection: [], past: [], future: [], clipboard: [] });
  useUi.setState({ toasts: [], previewMode: 'output' });
  resetEditTargets();
  useSoundApart.setState({ apart: false });
  useSource.setState({ assetId: null, time: 0, playing: false });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('edit reasons', () => {
  it('edit ids are known', () => {
    for (const [id] of IDS) expect(REASON_IDS).toContain(id);
    expect(REASON_IDS).toContain('edit-targets-selected');
  });

  it('no source view media', () => {
    open({ name: 'none', clips: [video('c', 'v1', 0, 8)], source: null, time: 3 });
    for (const [id] of IDS) expect(reasonFor(id, snap()), id).toBe(REASON_TEXT.sourceEmpty);
    // media open in the source view but the project has lost it
    useSource.setState({ assetId: 'gone' });
    for (const [id] of IDS) expect(reasonFor(id, snap()), id).toBe(EDIT_TEXT.mediaGone);
    // media there: no reason for an insert
    open({ name: 'some', clips: [video('c', 'v1', 0, 8)], time: 3 });
    expect(reasonFor('insert-edit', snap())).toBeNull();
    expect(reasonFor('append-edit', snap())).toBeNull();
  });

  it('a reason means the edit changes nothing', () => {
    let reasons = 0;
    let free = 0;
    for (const f of FIXTURES) {
      for (const [id, mode] of IDS) {
        open(f);
        const why = reasonFor(id, snap());
        if (why === null) {
          free++;
          continue;
        }
        reasons++;
        const project = ed().project;
        const selection = ed().selection;
        const time = usePlayback.getState().time;
        editNow(mode);
        expect(ed().project, `${f.name}: ${id}`).toBe(project);
        expect(ed().selection, `${f.name}: ${id}`).toBe(selection);
        expect(usePlayback.getState().time, `${f.name}: ${id}`).toBe(time);
        expect(useUi.getState().toasts.at(-1)?.message, `${f.name}: ${id}`).toBe(why);
      }
    }
    // the fixtures cover both answers
    expect(reasons).toBeGreaterThan(20);
    expect(free).toBeGreaterThan(10);
  });

  it('what has no reason works', () => {
    for (const f of FIXTURES) {
      for (const [id, mode] of IDS) {
        open(f);
        if (reasonFor(id, snap()) !== null) continue;
        const project = ed().project;
        editNow(mode);
        expect(ed().project, `${f.name}: ${id}`).not.toBe(project);
      }
    }
  });

  it('fit without a range', () => {
    open({ name: 'plain', clips: [video('c', 'v1', 0, 8)] });
    expect(reasonFor('fit-edit', snap())).toBe(EDIT_TEXT.needsRange);
    open({ name: 'one mark', clips: [video('c', 'v1', 0, 8)], range: { in: 1 } });
    expect(reasonFor('fit-edit', snap())).toBe(EDIT_TEXT.needsRange);
    open({ name: 'a range', clips: [video('c', 'v1', 0, 8)], range: { in: 1, out: 3 } });
    expect(reasonFor('fit-edit', snap())).toBeNull();
    // replace names what it needs
    open({ name: 'nothing under', clips: [], time: 3 });
    expect(reasonFor('replace-edit', snap())).toBe(EDIT_TEXT.noClipUnderAny);
  });

  it('targets of the selection', () => {
    open({ name: 'none', clips: [video('c', 'v1', 0, 8)] });
    expect(reasonFor('edit-targets-selected', snap())).toBe(EDIT_TEXT.targetsNone);
    open({ name: 'one', clips: [video('c', 'v1', 0, 8)], selection: ['c'] });
    expect(reasonFor('edit-targets-selected', snap())).toBeNull();
    open({ name: 'locked', clips: [video('c', 'v1', 0, 8)], tracks: [track('v1', 'video', { locked: true }), track('a1', 'audio')], selection: ['c'] });
    expect(reasonFor('edit-targets-selected', snap())).toBe(EDIT_TEXT.targetsNone);
    // the row sets the targets
    open({ name: 'two', clips: [video('c', 'v1', 0, 8), audio('s', 'a1', 0, 8)], selection: ['c', 's'] });
    targetSelectedNow();
    expect(currentTargets(ed().project!.id)).toEqual({ picture: 'v1', sound: 'a1' });
    // the snapshot reads the targets of the open project
    expect(snap().editTargets).toEqual({ picture: 'v1', sound: 'a1' });
    open({ name: 'auto', clips: [] });
    expect(snap().editTargets).toEqual(AUTO_TARGETS);
  });
});

describe('separate sound on', () => {
  it('a locked sound target shows only on the click', () => {
    open({ name: 'apart', clips: [video('c', 'v1', 0, 8)], tracks: [track('v1', 'video'), track('a1', 'audio', { locked: true })], targets: { picture: null, sound: 'a1' }, time: 3, apart: true });
    // the reasons plan with the setting off, where the sound target gets nothing
    expect(reasonFor('insert-edit', snap())).toBeNull();
    const project = ed().project;
    editNow('insert');
    expect(ed().project).toBe(project);
    expect(useUi.getState().toasts.at(-1)?.message).toBe('a1 is locked: unlock it or pick another target');
  });
});
