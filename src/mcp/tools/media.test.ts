import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearBusy, setBusy } from '../../lib/busy';
import { createProject } from '../../lib/factory';
import { currentTargets, resetEditTargets, setEditTarget } from '../../features/timeline/editTargets';
import { separateSound } from '../../features/timeline/soundActions';
import { useSoundApart } from '../../features/timeline/soundSetting';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { useSource } from '../../store/source';
import { useUi } from '../../store/ui';
import type { MediaAsset } from '../../types';
import { callTool } from '../registry';
import type { ToolCtx, ToolResult } from '../types';

const mocks = vi.hoisted(() => ({ importFiles: vi.fn(), importProjectFile: vi.fn(), deleteAsset: vi.fn(), importing: { count: 0 } }));
vi.mock('../../media/importer', () => ({ importFiles: mocks.importFiles, deleteAsset: mocks.deleteAsset, useImporting: { getState: () => mocks.importing } }));
vi.mock('../../store/session', () => ({
  openProjectById: async () => true,
  createAndOpenProject: async () => ({}),
  closeProject: async () => {},
  flushAutosave: async () => {},
  importProjectFile: mocks.importProjectFile,
  useSaveState: { getState: () => ({ state: 'saved' }) },
}));
vi.mock('../../storage/db', () => ({ listProjects: async () => [] }));

async function call(name: string, args: Record<string, unknown> = {}, ctx?: ToolCtx) {
  const r = (await callTool(name, args, ctx)) as ToolResult;
  const text = r.content[0]?.type === 'text' ? r.content[0].text : '';
  return { error: r.isError === true, text, json: r.isError ? null : (JSON.parse(text) as Record<string, any>) };
}

function asset(id: string, kind: MediaAsset['kind'], duration: number, name = id): MediaAsset {
  return { id, name, kind, mime: '', size: 10, duration, width: kind === 'audio' ? 0 : 640, height: kind === 'audio' ? 0 : 360, hasAudio: kind !== 'image', createdAt: 0 };
}

const SIDES = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];
function square(id: string, name: string): MediaAsset {
  return { ...asset(id, 'image', 0, name), width: 512, height: 512 };
}

const past = () =>useEditor.getState().past.length;
const project = () => useEditor.getState().project!;

beforeEach(() => {
  mocks.importFiles.mockReset();
  mocks.importProjectFile.mockReset();
  // the real one also drops the media from the store
  mocks.deleteAsset.mockReset().mockImplementation(async (id: string) => useEditor.getState().removeAsset(id));
  mocks.importing.count = 0;
  clearBusy();
  useEditor.getState().closeProject();
  useEditor.getState().openProject(createProject('media'));
  const s = useEditor.getState();
  s.addAsset(asset('v1', 'video', 10, 'clip one'));
  s.addAsset(asset('v2', 'video', 4, 'clip two'));
  s.addAsset(asset('i1', 'image', 0));
  s.addAsset(asset('a1', 'audio', 30));
});

describe('import_media', () => {
  const bytes = new Uint8Array([1, 2, 3]).buffer;

  it('only works with files from the desktop shell', async () => {
    const r = await call('import_media', { paths: ['C:/a.mp4'] });
    expect(r.text).toMatch(/only works in the ncut desktop app/);
    expect(mocks.importFiles).not.toHaveBeenCalled();
  });

  it('hands the files to the importer and answers the new media', async () => {
    mocks.importFiles.mockResolvedValue([asset('n1', 'video', 2.5, 'a.mp4'), asset('n2', 'image', 0, 'b.png')]);
    const r = await call('import_media', {}, { files: [{ name: 'a.mp4', bytes }, { name: 'b.png', bytes }], ticket: null });
    const files = mocks.importFiles.mock.calls[0]![0] as File[];
    expect(files.map((f) => f.name)).toEqual(['a.mp4', 'b.png']);
    expect(files[0]!.size).toBe(3);
    expect(r.json!.media).toEqual([
      { id: 'n1', name: 'a.mp4', kind: 'video', duration: 2.5, width: 640, height: 360, hasAudio: true },
      { id: 'n2', name: 'b.png', kind: 'image', duration: 0, width: 640, height: 360, hasAudio: false },
    ]);
    expect(r.json!.skipped).toBeUndefined();
  });

  it('names the skipped files and why, quietly, and fails naming them when nothing came in', async () => {
    mocks.importFiles.mockImplementationOnce(async (_f: File[], o: { onSkip: (n: string, w: string) => void }) => {
      o.onSkip('x.txt', 'unsupported file type');
      return [asset('n1', 'video', 2, 'a.mp4')];
    });
    const some = await call('import_media', {}, { files: [{ name: 'a.mp4', bytes }, { name: 'x.txt', bytes }], ticket: null });
    expect(some.json!.skipped).toEqual([{ name: 'x.txt', why: 'unsupported file type' }]);
    expect(mocks.importFiles.mock.calls[0]![1]).toMatchObject({ quiet: true });
    mocks.importFiles.mockImplementationOnce(async (_f: File[], o: { onSkip: (n: string, w: string) => void }) => {
      o.onSkip('empty.mp3', 'unreadable');
      return [];
    });
    const none = await call('import_media', {}, { files: [{ name: 'empty.mp3', bytes }], ticket: null });
    expect(none.text).toContain('none of the files could be imported: empty.mp3 (unreadable)');
  });

  it('import_media says when the new files look like a skybox', async () => {
    const six = SIDES.map((s) => square(`sky_${s}`, `sky_${s}.png`));
    mocks.importFiles.mockImplementationOnce(async () => {
      for (const a of six) useEditor.getState().addAsset(a);
      return [...six].reverse();
    });
    const r = await call('import_media', {}, { files: six.map((a) => ({ name: a.name, bytes })), ticket: null });
    expect(r.json!.looksLikeSky).toEqual(six.map((a) => a.id));
    mocks.importFiles.mockResolvedValueOnce([asset('n1', 'image', 0, 'photo.png')]);
    const plain = await call('import_media', {}, { files: [{ name: 'photo.png', bytes }], ticket: null });
    expect(plain.json!.looksLikeSky).toBeUndefined();
  });

  it('needs an open project and a sane argument', async () => {
    useEditor.getState().closeProject();
    expect((await call('import_media', {}, { files: [{ name: 'a.mp4', bytes }], ticket: null })).text).toMatch(/no project is open/);
    expect((await call('import_media', { paths: [] })).error).toBe(true);
    expect((await call('import_media', { paths: 'C:/a.mp4' })).error).toBe(true);
    expect((await call('import_media', { files: [] })).text).toMatch(/not a known field/);
  });
});

describe('import_project', () => {
  it('answers the new id and does not open it', async () => {
    mocks.importProjectFile.mockResolvedValue('prj_new');
    const r = await call('import_project', {}, { files: [{ name: 'a.ncut', bytes: new ArrayBuffer(4) }], ticket: null });
    expect(r.json).toMatchObject({ id: 'prj_new' });
    expect(mocks.importProjectFile.mock.calls[0]![0]).toBeInstanceOf(Blob);
    expect(mocks.importProjectFile.mock.calls[0]![0].size).toBe(4);
    expect(project().name).toBe('media');
  });

  it('bumps the projects version on success only', async () => {
    const v0 = useUi.getState().projectsVersion;
    mocks.importProjectFile.mockRejectedValue(new Error('QuotaExceededError'));
    await call('import_project', {}, { files: [{ name: 'a.ncut', bytes: new ArrayBuffer(4) }], ticket: null });
    expect(useUi.getState().projectsVersion).toBe(v0);
    mocks.importProjectFile.mockResolvedValue('prj_new');
    await call('import_project', {}, { files: [{ name: 'a.ncut', bytes: new ArrayBuffer(4) }], ticket: null });
    expect(useUi.getState().projectsVersion).toBe(v0 + 1);
  });

  it('does not blame the file for a storage failure', async () => {
    mocks.importProjectFile.mockRejectedValue(new Error('QuotaExceededError'));
    const r = await call('import_project', {}, { files: [{ name: 'a.ncut', bytes: new ArrayBuffer(4) }], ticket: null });
    expect(r.text).toMatch(/could not import a.ncut: QuotaExceededError/);
    expect(r.text).not.toMatch(/not a project ncut can read/);
  });

  it('says why a file is not a project, and is desktop only', async () => {
    mocks.importProjectFile.mockRejectedValue(new Error('not an ncut project file'));
    const r = await call('import_project', {}, { files: [{ name: 'a.ncut', bytes: new ArrayBuffer(4) }], ticket: null });
    expect(r.text).toMatch(/could not import a.ncut: not an ncut project file. the file is not a project ncut can read/);
    expect((await call('import_project', { path: 'C:/a.ncut' })).text).toMatch(/desktop app/);
  });
});

describe('add_media_clip', () => {
  it('puts media on the timeline as one undo step', async () => {
    const before = past();
    const r = await call('add_media_clip', { asset: 'v1', start: 2 });
    expect(r.json).toMatchObject({ type: 'video', asset: 'v1', start: 2, end: 12, name: 'clip one' });
    expect(past()).toBe(before + 1);
    expect(project().clips).toHaveLength(1);
    const next = await call('add_media_clip', { asset: 'v2' });
    expect(next.json).toMatchObject({ start: 12, end: 16 });
    expect(past()).toBe(before + 2);
  });

  it('audio goes to the audio track, an image gets its default length', async () => {
    const audio = await call('add_media_clip', { asset: 'a1' });
    const track = project().tracks.find((t) => t.id === audio.json!.track)!;
    expect(track.kind).toBe('audio');
    const img = await call('add_media_clip', { asset: 'i1' });
    expect(img.json).toMatchObject({ type: 'image', end: 5 });
  });

  it('uses the track asked for and slides past a clip that is in the way', async () => {
    const trackId = project().tracks[0]!.id;
    await call('add_media_clip', { asset: 'v1', track: trackId, start: 0 });
    const r = await call('add_media_clip', { asset: 'v2', track: trackId, start: 5 });
    expect(r.json).toMatchObject({ track: trackId, start: 10 });
  });

  it('refuses unknown media, unknown tracks, the wrong kind of track and a locked one', async () => {
    const [video, audio] = project().tracks;
    const before = past();
    expect((await call('add_media_clip', { asset: 'nope' })).text).toMatch(/no media with the id nope/);
    expect((await call('add_media_clip', { asset: 'v1', track: 'nope' })).text).toMatch(/no track with the id nope/);
    expect((await call('add_media_clip', { asset: 'v1', track: audio!.id })).text).toMatch(/is an audio track, video media goes on a video track/);
    expect((await call('add_media_clip', { asset: 'a1', track: video!.id })).text).toMatch(/audio media goes on an audio track/);
    useEditor.getState().updateTrack(video!.id, { locked: true });
    const locked = past();
    expect((await call('add_media_clip', { asset: 'v1', track: video!.id })).text).toMatch(/is locked/);
    expect((await call('add_media_clip', { asset: 'v1', start: -1 })).error).toBe(true);
    expect(past()).toBe(locked);
    expect(past()).toBe(before + 1);
    expect(project().clips).toHaveLength(0);
  });
});

describe('replace_media', () => {
  it('swaps the media in one undo step and keeps the clip', async () => {
    const id = useEditor.getState().insertAsset('v1', { start: 1 })!;
    const before = past();
    const r = await call('replace_media', { id, asset: 'v2' });
    expect(r.json).toMatchObject({ id, asset: 'v2', start: 1, end: 5, name: 'clip two' });
    expect(past()).toBe(before + 1);
    await call('undo');
  });

  it('refuses the wrong kind, the same media, a clip without media and a locked track', async () => {
    const s = useEditor.getState();
    const v = s.insertAsset('v1')!;
    const text = s.addText();
    const before = past();
    expect((await call('replace_media', { id: v, asset: 'i1' })).text).toMatch(/is a video clip but the media i1 is image/);
    expect((await call('replace_media', { id: v, asset: 'v1' })).text).toMatch(/already shows/);
    expect((await call('replace_media', { id: text, asset: 'v1' })).text).toMatch(/only video, image and audio clips/);
    expect((await call('replace_media', { id: 'nope', asset: 'v1' })).text).toMatch(/no clip with the id nope/);
    expect((await call('replace_media', { id: v, asset: 'nope' })).text).toMatch(/no media with the id nope/);
    s.updateTrack(project().clips.find((c) => c.id === v)!.trackId, { locked: true });
    const locked = past();
    expect((await call('replace_media', { id: v, asset: 'v2' })).text).toMatch(/locked track/);
    expect(past()).toBe(locked);
    expect(before).toBeLessThanOrEqual(locked);
  });
});

describe('remove_media', () => {
  const ids = () => project().assets.map((a) => a.id);
  const addClip = async (asset: string) => (await call('add_media_clip', { asset })).json!.id as string;

  it('removes one unused media and answers it', async () => {
    const r = await call('remove_media', { ids: ['v2'] });
    expect(r.json).toEqual({ removed: [{ id: 'v2', name: 'clip two' }], clips: 0, undoCleared: false, media: 3 });
    expect(ids()).toEqual(['v1', 'i1', 'a1']);
  });

  it('removes several, a duplicate id counts once', async () => {
    const r = await call('remove_media', { ids: ['v1', 'a1', 'v1'] });
    expect(r.json!.removed.map((x: { id: string }) => x.id)).toEqual(['v1', 'a1']);
    expect(mocks.deleteAsset).toHaveBeenCalledTimes(2);
    expect(ids()).toEqual(['v2', 'i1']);
  });

  it('unused: true removes the unused ones and keeps the used ones', async () => {
    await addClip('v1');
    const r = await call('remove_media', { unused: true });
    expect(r.json!.removed.map((x: { id: string }) => x.id)).toEqual(['v2', 'i1', 'a1']);
    expect(r.json!.media).toBe(1);
    expect(ids()).toEqual(['v1']);
    expect(project().clips).toHaveLength(1);
  });

  const withSky = () => {
    const six = SIDES.map((s) => square(`sky_${s}`, `sky_${s}.png`));
    for (const a of six) useEditor.getState().addAsset(a);
    const light = { sky: '#808080', horizon: '#808080', ground: '#404040', sun: 0, sunColor: '#ffffff', sunTurn: 0, sunHeight: 45 };
    useEditor.getState().updateProject({ sky: { faces: six.map((a) => a.id), turn: 0, brightness: 1, blur: 0, light } });
    return six;
  };

  it('remove_media refuses a sky picture by id', async () => {
    const six = withSky();
    const r = await call('remove_media', { ids: [six[2]!.id] });
    expect(r.error).toBe(true);
    expect(r.text).toBe(`the media ${six[2]!.id} ("${six[2]!.name}") is part of the sky. take the sky off first (update_project sky: null)`);
    expect(ids()).toContain(six[2]!.id);
    expect(project().sky).toBeTruthy();
    expect(mocks.deleteAsset).not.toHaveBeenCalled();
  });

  it('remove_media unused leaves the sky pictures', async () => {
    const six = withSky();
    const r = await call('remove_media', { unused: true });
    expect(r.json!.removed.map((x: { id: string }) => x.id)).toEqual(['v1', 'v2', 'i1', 'a1']);
    expect(ids()).toEqual(six.map((a) => a.id));
    expect(project().sky).toBeTruthy();
  });

  it('unused: true with nothing unused is refused', async () => {
    for (const id of ['v1', 'v2', 'i1', 'a1']) await addClip(id);
    const r = await call('remove_media', { unused: true });
    expect(r.text).toMatch(/no unused media, nothing changed/);
    expect(mocks.deleteAsset).not.toHaveBeenCalled();
  });

  it('refuses used media without with_clips and names it and the clip count', async () => {
    await addClip('v1');
    await addClip('v1');
    await addClip('v2');
    const r = await call('remove_media', { ids: ['v1', 'v2', 'a1'] });
    expect(r.error).toBe(true);
    expect(r.text).toContain('v1 ("clip one") is used by 2 clips');
    expect(r.text).toContain('v2 ("clip two") is used by 1 clip');
    expect(r.text).toMatch(/with_clips: true/);
    expect(mocks.deleteAsset).not.toHaveBeenCalled();
    expect(ids()).toHaveLength(4);
  });

  it('with_clips removes the clips too and reports clips and undoCleared', async () => {
    await addClip('v1');
    await addClip('v1');
    expect(past()).toBeGreaterThan(0);
    const r = await call('remove_media', { ids: ['v1'], with_clips: true });
    expect(r.json).toEqual({ removed: [{ id: 'v1', name: 'clip one' }], clips: 2, undoCleared: true, media: 3 });
    expect(project().clips).toHaveLength(0);
    expect(past()).toBe(0);
  });

  it('refuses a clip on a locked track even with with_clips', async () => {
    const id = await addClip('v1');
    useEditor.getState().updateTrack(project().clips.find((c) => c.id === id)!.trackId, { locked: true });
    const r = await call('remove_media', { ids: ['v1'], with_clips: true });
    expect(r.text).toMatch(/locked track/);
    expect(mocks.deleteAsset).not.toHaveBeenCalled();
    expect(project().clips).toHaveLength(1);
  });

  it('refuses an unknown id and removes nothing, also as the second id', async () => {
    const r = await call('remove_media', { ids: ['v1', 'nope'] });
    expect(r.text).toMatch(/no media with the id nope/);
    expect(mocks.deleteAsset).not.toHaveBeenCalled();
    expect(ids()).toHaveLength(4);
  });

  it('wants exactly one of ids and unused, and with_clips does not go with unused', async () => {
    expect((await call('remove_media', { ids: ['v1'], unused: true })).text).toMatch(/ids .* or unused: true/);
    expect((await call('remove_media', {})).text).toMatch(/ids .* or unused: true/);
    expect((await call('remove_media', { unused: false })).text).toMatch(/ids .* or unused: true/);
    expect((await call('remove_media', { unused: true, with_clips: true })).text).toMatch(/with_clips/);
    expect((await call('remove_media', { ids: [] })).error).toBe(true);
    expect(mocks.deleteAsset).not.toHaveBeenCalled();
  });

  it('is refused while an export runs but not while imported media is being saved', async () => {
    setBusy('export', 'an export is still running');
    expect((await call('remove_media', { ids: ['v2'] })).text).toMatch(/cannot remove media while an export is still running/);
    setBusy('export', null);
    setBusy('mcp-export', 'an export is still running');
    expect((await call('remove_media', { ids: ['v2'] })).error).toBe(true);
    setBusy('mcp-export', null);
    expect(ids()).toHaveLength(4);
    setBusy('media-store', 'saving imported media');
    expect((await call('remove_media', { ids: ['v2'] })).error).toBe(false);
    expect(ids()).toHaveLength(3);
  });

  it('needs an open project', async () => {
    useEditor.getState().closeProject();
    expect((await call('remove_media', { ids: ['v1'] })).error).toBe(true);
  });

  it('says what was removed when one fails, the rest still go', async () => {
    mocks.deleteAsset.mockImplementation(async (id: string) => {
      useEditor.getState().removeAsset(id);
      if (id === 'i1') throw new Error('disk gone');
    });
    const r = await call('remove_media', { ids: ['v1', 'v2', 'i1', 'a1'] });
    expect(r.error).toBe(true);
    expect(r.text).toMatch(/i1 \(disk gone\)/);
    expect(r.text).toMatch(/removed: v1, v2, a1/);
  });

  it('takes every media out before waiting on a stored copy', async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    mocks.deleteAsset.mockImplementation(async (id: string) => {
      useEditor.getState().removeAsset(id);
      if (id === 'v1') await gate;
    });
    const running = call('remove_media', { ids: ['v1', 'v2'] });
    await vi.waitFor(() => expect(mocks.deleteAsset).toHaveBeenCalledWith('v1'));
    expect(ids()).toEqual(['i1', 'a1']);
    release();
    const r = await running;
    expect(r.json!.removed.map((x: { id: string }) => x.id)).toEqual(['v1', 'v2']);
  });

  it('counts clips and the undo history before the wait, edits made meanwhile do not change the answer', async () => {
    await addClip('v1');
    await addClip('v1');
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    mocks.deleteAsset.mockImplementation(async (id: string) => {
      useEditor.getState().removeAsset(id);
      await gate;
    });
    const running = call('remove_media', { ids: ['v1'], with_clips: true });
    await vi.waitFor(() => expect(mocks.deleteAsset).toHaveBeenCalledWith('v1'));
    // the user edits while the stored copy is waited on: a new clip and a new undo step
    await addClip('v2');
    expect(past()).toBeGreaterThan(0);
    release();
    const r = await running;
    expect(r.json).toEqual({ removed: [{ id: 'v1', name: 'clip one' }], clips: 2, undoCleared: true, media: 3 });
    expect(project().clips).toHaveLength(1);
  });

  it('names what was removed when the project closes during the call', async () => {
    mocks.deleteAsset.mockImplementation(async (id: string) => {
      useEditor.getState().removeAsset(id);
      if (id === 'v2') useEditor.getState().closeProject();
    });
    const r = await call('remove_media', { ids: ['v1', 'v2'] });
    expect(r.error).toBe(true);
    expect(r.text).toMatch(/closed or switched/);
    expect(r.text).toMatch(/removed: v1, v2/);
  });

  it('unused: true is refused while files are being imported, ids still work', async () => {
    mocks.importing.count = 1;
    const r = await call('remove_media', { unused: true });
    expect(r.text).toMatch(/being imported/);
    expect(mocks.deleteAsset).not.toHaveBeenCalled();
    expect(ids()).toHaveLength(4);
    expect((await call('remove_media', { ids: ['v2'] })).error).toBe(false);
    mocks.importing.count = 0;
    expect((await call('remove_media', { unused: true })).error).toBe(false);
  });

  it('is marked destructive', async () => {
    const { TOOLS } = await import('../registry');
    expect(TOOLS.find((t) => t.name === 'remove_media')!.annotations?.destructiveHint).toBe(true);
  });
});

const silent = (): MediaAsset => ({ ...asset('sv', 'video', 6), hasAudio: false });
const marksOf = (id: string) => project().assets.find((a) => a.id === id)?.marks;

describe('set_media_marks', () => {
  it('one alone keeps the other, no undo step', async () => {
    const before = past();
    const both = await call('set_media_marks', { asset: 'v1', in: 2, out: 6 });
    expect(both.json).toEqual({ asset: 'v1', marks: { in: 2, out: 6 }, length: 4 });
    expect(marksOf('v1')).toEqual({ in: 2, out: 6 });
    expect((await call('set_media_marks', { asset: 'v1', in: 3 })).json).toMatchObject({ marks: { in: 3, out: 6 }, length: 3 });
    expect((await call('set_media_marks', { asset: 'v1', out: 8.12345678 })).json).toMatchObject({ marks: { in: 3, out: 8.1235 } });
    expect(past()).toBe(before);
    expect((await call('set_media_marks', { asset: 'a1', out: 5 })).json).toMatchObject({ marks: { out: 5 }, length: 5 });
    expect(past()).toBe(before);
  });

  it('clear', async () => {
    await call('set_media_marks', { asset: 'v1', in: 2, out: 6 });
    const r = await call('set_media_marks', { asset: 'v1', clear: true });
    expect(r.json).toEqual({ asset: 'v1', marks: null, length: 10 });
    expect(marksOf('v1')).toBeUndefined();
    expect((await call('set_media_marks', { asset: 'v1', clear: true })).text).toBe('the media already has these marks, nothing changed');
    // false counts as not given
    expect((await call('set_media_marks', { asset: 'v1', clear: false })).text).toMatch(/nothing to set/);
    expect((await call('set_media_marks', { asset: 'v1', in: 1, clear: false })).json).toMatchObject({ marks: { in: 1 } });
  });

  it('refuses in the spec order', async () => {
    const before = past();
    const text = async (args: Record<string, unknown>) => {
      const r = await call('set_media_marks', args);
      expect(r.error, JSON.stringify(args)).toBe(true);
      return r.text;
    };
    expect(await text({ asset: 'nope', clear: true, in: 1 })).toMatch(/no media with the id nope/);
    expect(await text({ asset: 'i1', clear: true, in: 1 })).toBe('the media i1 is a picture: pictures have no in or out, their length is set on the timeline');
    expect(await text({ asset: 'v1', clear: true, in: 1 })).toBe('clear does not go with in or out');
    expect(await text({ asset: 'v1', clear: true, out: 1 })).toBe('clear does not go with in or out');
    expect(await text({ asset: 'v1' })).toBe('nothing to set: give in, out or clear: true');
    expect(await text({ asset: 'v1', in: 12.5, out: 3 })).toBe('in 12.5 is after the end of the media (10 s)');
    expect(await text({ asset: 'v1', out: 10.5 })).toBe('out 10.5 is after the end of the media (10 s)');
    expect(await text({ asset: 'v1', in: 5, out: 3 })).toBe('in has to be before out');
    expect(await text({ asset: 'v1', in: 5, out: 5 })).toBe('in has to be before out');
    expect(await text({ asset: 'v1', in: 9.98 })).toBe('the marked part has to be at least 0.05 s long');
    expect(await text({ asset: 'v1', out: 0 })).toBe('the marked part has to be at least 0.05 s long');
    expect(await text({ asset: 'v1', in: 2, out: 2.02 })).toBe('the marked part has to be at least 0.05 s long');
    expect(await text({ asset: 'v1', in: 2, out: 2.0000005 })).toBe('the marked part has to be at least 0.05 s long');
    await call('set_media_marks', { asset: 'v1', in: 2, out: 4 });
    expect(await text({ asset: 'v1', in: 5 })).toBe('in has to be before out (the kept out is 4 s)');
    expect(await text({ asset: 'v1', out: 1 })).toBe('in has to be before out (the kept in is 2 s)');
    expect(await text({ asset: 'v1', in: 3.99 })).toBe('the marked part has to be at least 0.05 s long');
    expect(await text({ asset: 'v1', in: 2, out: 4 })).toBe('the media already has these marks, nothing changed');
    expect(marksOf('v1')).toEqual({ in: 2, out: 4 });
    expect(past()).toBe(before);
  });
});

describe('add_media_clip parts and marks', () => {
  it('in 1 out 3 is 2 s from 1', async () => {
    const before = past();
    const r = await call('add_media_clip', { asset: 'v1', in: 1, out: 3 });
    expect(r.json).toMatchObject({ type: 'video', start: 0, end: 2, source: { in: 1, out: 3 }, usedMarks: false });
    expect((project().clips[0] as any).trimStart).toBe(1);
    expect(past()).toBe(before + 1);
    // one alone takes the start or the end for the other
    expect((await call('add_media_clip', { asset: 'v1', in: 8 })).json).toMatchObject({ source: { in: 8, out: 10 } });
    expect((await call('add_media_clip', { asset: 'v1', out: 4 })).json).toMatchObject({ source: { in: 0, out: 4 } });
    // in / out win over the marks
    await call('set_media_marks', { asset: 'v1', in: 5, out: 6 });
    expect((await call('add_media_clip', { asset: 'v1', in: 1, out: 3 })).json).toMatchObject({ source: { in: 1, out: 3 }, usedMarks: false });
  });

  it('marks without in and out', async () => {
    await call('set_media_marks', { asset: 'v1', in: 2, out: 6 });
    const r = await call('add_media_clip', { asset: 'v1' });
    expect(r.json).toMatchObject({ end: 4, source: { in: 2, out: 6 }, usedMarks: true });
    expect(marksOf('v1')).toEqual({ in: 2, out: 6 });
    const plain = await call('add_media_clip', { asset: 'v2' });
    expect(plain.json).toMatchObject({ source: { in: 0, out: 4 }, usedMarks: false });
    // a picture has no source
    const img = await call('add_media_clip', { asset: 'i1' });
    expect(img.json!.source).toBeUndefined();
    expect(img.json!.usedMarks).toBe(false);
  });

  it('sound and picture parts', async () => {
    const [video, audio] = project().tracks;
    const sound = await call('add_media_clip', { asset: 'v1', parts: 'sound' });
    expect(sound.json).toMatchObject({ type: 'audio', asset: 'v1', track: audio!.id, end: 10 });
    const pic = await call('add_media_clip', { asset: 'v1', parts: 'picture' });
    expect(pic.json).toMatchObject({ type: 'video', track: video!.id });
    expect((project().clips.find((c) => c.id === pic.json!.id) as any).muted).toBe(true);
    const both = await call('add_media_clip', { asset: 'v2', parts: 'both', start: 20 });
    expect((project().clips.find((c) => c.id === both.json!.id) as any).muted).toBe(false);
    // the words of the track text
    expect((await call('add_media_clip', { asset: 'v1', parts: 'sound', track: video!.id })).text).toBe(`the track ${video!.id} is a video track, the sound of a video goes on an audio track`);
    expect((await call('add_media_clip', { asset: 'v1', track: audio!.id })).text).toMatch(/video media goes on a video track/);
    expect((await call('add_media_clip', { asset: 'a1', parts: 'sound', track: audio!.id })).json).toMatchObject({ type: 'audio' });
  });

  it('refuses parts the media lacks', async () => {
    useEditor.getState().addAsset(silent());
    const before = past();
    expect((await call('add_media_clip', { asset: 'a1', parts: 'picture' })).text).toBe('the media a1 is audio: it has no picture');
    expect((await call('add_media_clip', { asset: 'i1', parts: 'sound' })).text).toBe('the media i1 has no sound');
    expect((await call('add_media_clip', { asset: 'sv', parts: 'sound' })).text).toBe('the media sv has no sound');
    expect((await call('add_media_clip', { asset: 'i1', in: 1 })).text).toBe('the media i1 is a picture: pictures have no in or out, their length is set on the timeline');
    expect((await call('add_media_clip', { asset: 'v1', in: 12.5 })).text).toBe('in 12.5 is after the end of the media (10 s)');
    expect((await call('add_media_clip', { asset: 'v1', in: 4, out: 4 })).text).toBe('in has to be before out');
    expect((await call('add_media_clip', { asset: 'v1', in: 9.99 })).text).toBe('the marked part has to be at least 0.05 s long');
    expect((await call('add_media_clip', { asset: 'v1', parts: 'other' })).error).toBe(true);
    expect(past()).toBe(before);
    expect(project().clips).toHaveLength(0);
  });

  it('never reads the setting', async () => {
    useSoundApart.setState({ apart: true });
    try {
      const r = await call('add_media_clip', { asset: 'v1' });
      expect(project().clips).toHaveLength(1);
      expect(r.json!.group).toBeUndefined();
      expect(project().clips[0]!.group).toBeUndefined();
    } finally {
      useSoundApart.setState({ apart: false });
    }
  });
});

describe('replace_media and sound clips', () => {
  it('an audio clip takes a video with sound only', async () => {
    useEditor.getState().addAsset(silent());
    const id = useEditor.getState().insertAsset('a1', { start: 0 })!;
    const before = past();
    const r = await call('replace_media', { id, asset: 'v1' });
    expect(r.json).toMatchObject({ id, type: 'audio', asset: 'v1' });
    expect(past()).toBe(before + 1);
    const bad = (await call('replace_media', { id, asset: 'sv' })).text;
    expect(bad).toBe(`the clip ${id} is a audio clip but the media sv is video. pick media of the same kind (an audio clip also takes a video with sound)`);
    expect((await call('replace_media', { id, asset: 'i1' })).text).toMatch(/pick media of the same kind \(an audio clip also takes a video with sound\)/);
    // a video clip does not take audio
    const v = useEditor.getState().insertAsset('v2', { start: 20 })!;
    expect((await call('replace_media', { id: v, asset: 'a1' })).text).toMatch(/is a video clip but the media a1 is audio/);
    expect(past()).toBe(before + 2);
  });

  it('a picture swaps its sound clip too', async () => {
    const [video] = project().tracks;
    const pic = useEditor.getState().insertAsset('v1', { trackId: video!.id, start: 0 })!;
    const done = separateSound([pic]);
    expect(typeof done).not.toBe('string');
    const sound = project().clips.find((c) => c.type === 'audio')!;
    expect((sound as any).assetId).toBe('v1');
    const before = past();
    const r = await call('replace_media', { id: pic, asset: 'v2' });
    expect(r.error, r.text).toBe(false);
    expect(past()).toBe(before + 1);
    expect((project().clips.find((c) => c.id === sound.id) as any).assetId).toBe('v2');
    expect(project().clips.find((c) => c.id === pic)).toMatchObject({ assetId: 'v2' });
  });
});

describe('match_frame', () => {
  /** a clip of v1 from 2 s of the file at speed 2, on the timeline from 1 s to 4 s */
  function fast(): string {
    const id = useEditor.getState().insertAsset('v1', { start: 1, range: { in: 2, out: 8 } })!;
    useEditor.getState().setClipSpeed(id, 2);
    const c = project().clips.find((x) => x.id === id) as any;
    expect(c.speed).toBe(2);
    return id;
  }

  it('speed 2 frame, its part as marks', async () => {
    const id = fast();
    const c = project().clips.find((x) => x.id === id) as any;
    const end = c.start + c.duration;
    const before = past();
    usePlayback.getState().seek(0.25);
    const r = await call('match_frame', { clip: id, time: 2.5 });
    expect(r.json).toEqual({ clip: id, asset: 'v1', sourceTime: 2 + 1.5 * 2, marks: { in: 2, out: 2 + c.duration * 2 }, replaced: false });
    expect(end).toBeCloseTo(c.start + c.duration);
    expect(marksOf('v1')).toEqual({ in: 2, out: 2 + c.duration * 2 });
    expect(useSource.getState().assetId).toBe('v1');
    expect(useSource.getState().time).toBe(5);
    expect(useUi.getState().previewMode).toBe('source');
    // the playhead stays and there is no undo step
    expect(usePlayback.getState().time).toBe(0.25);
    expect(past()).toBe(before);
  });

  it('without clip like f, no undo step', async () => {
    const [video] = project().tracks;
    useEditor.getState().insertAsset('v2', { trackId: video!.id, start: 0 });
    const id = useEditor.getState().insertAsset('v1', { trackId: video!.id, start: 4 })!;
    const before = past();
    usePlayback.getState().seek(6);
    const r = await call('match_frame');
    expect(r.json).toMatchObject({ clip: id, asset: 'v1', sourceTime: 2, marks: { in: 0, out: 10 } });
    const t = await call('match_frame', { time: 1 });
    expect(t.json).toMatchObject({ asset: 'v2', sourceTime: 1 });
    expect(usePlayback.getState().time).toBe(6);
    expect(past()).toBe(before);
    // a picture has no marks
    useEditor.getState().insertAsset('i1', { trackId: video!.id, start: 20 });
    expect((await call('match_frame', { time: 21 })).json).toMatchObject({ asset: 'i1', sourceTime: 0, marks: null, replaced: false });
  });

  it('replaced', async () => {
    const id = useEditor.getState().insertAsset('v2', { start: 0 })!;
    useEditor.getState().setMediaMarks('v2', { in: 0, out: 1 });
    expect((await call('match_frame', { clip: id, time: 1 })).json).toMatchObject({ replaced: true, marks: { in: 0, out: 4 } });
    expect((await call('match_frame', { clip: id, time: 2 })).json).toMatchObject({ replaced: false });
  });

  it('refusals', async () => {
    const id = useEditor.getState().insertAsset('v2', { start: 2 })!;
    const text = useEditor.getState().addText();
    const before = past();
    expect((await call('match_frame', { clip: 'nope' })).text).toMatch(/no clip with the id nope/);
    expect((await call('match_frame', { clip: text })).text).toBe(`the clip ${text} is a text clip: only video, audio and image clips have media`);
    expect((await call('match_frame', { clip: id, time: 12 })).text).toBe(`time 12 s is outside the clip ${id} (2 s to 6 s)`);
    expect((await call('match_frame', { clip: id, time: 6 })).text).toMatch(/is outside the clip/);
    expect((await call('match_frame', { time: 12 })).text).toBe('no video, audio or image clip at 12 s');
    expect((await call('match_frame', { time: 0 })).text).toBe('no video, audio or image clip at 0 s');
    expect((await call('match_frame', { clip: id, time: 2 })).error).toBe(false);
    expect(past()).toBe(before);
  });
});

describe('edit_media', () => {
  const clips = () => project().clips;
  const audioTrack = () => project().tracks.find((t) => t.kind === 'audio')!.id;
  const videoTrack = () => project().tracks.find((t) => t.kind === 'video')!.id;

  it('insert at 0', async () => {
    useEditor.getState().setMediaMarks('v1', { in: 2, out: 6 });
    const before = past();
    const r = await call('edit_media', { asset: 'v1', mode: 'insert', at: 0 });
    expect(r.error, r.text).toBe(false);
    expect(r.json).toMatchObject({ mode: 'insert', start: 0, length: 4, sourceIn: 2, speed: 1, split: 0, moved: 0, playhead: 4 });
    expect(r.json!.clips).toHaveLength(1);
    expect(r.json!.clips[0]).toMatchObject({ type: 'video', asset: 'v1', start: 0, end: 4 });
    expect((clips()[0] as any).trimStart).toBe(2);
    expect(usePlayback.getState().time).toBe(4);
    expect(past()).toBe(before + 1);
    expect(marksOf('v1')).toEqual({ in: 2, out: 6 });
  });

  it('insert splits, one undo restores', async () => {
    const under = useEditor.getState().insertAsset('a1', { start: 0 })!;
    const later = useEditor.getState().insertAsset('v2', { start: 8 })!;
    const snapshot = JSON.stringify(clips());
    const before = past();
    const r = await call('edit_media', { asset: 'v1', mode: 'insert', at: 3, in: 0, out: 4 });
    expect(r.error, r.text).toBe(false);
    expect(past()).toBe(before + 1);
    expect(r.json).toMatchObject({ start: 3, length: 4, split: 1, playhead: 7 });
    expect(r.json!.moved).toBeGreaterThanOrEqual(2);
    const rest = clips().filter((c) => c.type === 'audio' && c.id !== under);
    expect(rest.map((c) => c.start)).toEqual([7]);
    expect(clips().find((c) => c.id === later)!.start).toBe(12);
    await call('undo');
    expect(JSON.stringify(clips())).toBe(snapshot);
    expect(past()).toBe(before);
  });

  it('a locked track is named', async () => {
    useEditor.getState().insertAsset('a1', { start: 0 });
    useEditor.getState().updateTrack(audioTrack(), { locked: true });
    const r = await call('edit_media', { asset: 'v2', mode: 'insert', at: 3 });
    expect(r.error, r.text).toBe(false);
    expect(r.json!.lockedTracks).toEqual([audioTrack()]);
    // the locked clip was not touched
    expect(clips().filter((c) => c.trackId === audioTrack())).toHaveLength(1);
    expect(clips().find((c) => c.trackId === audioTrack())).toMatchObject({ start: 0, duration: 30 });
  });

  it('fit at speed 2 clears the range', async () => {
    useEditor.getState().setRange({ in: 1, out: 3 });
    useEditor.getState().setMediaMarks('v2', { in: 0, out: 4 });
    const before = past();
    const r = await call('edit_media', { asset: 'v2', mode: 'fit' });
    expect(r.error, r.text).toBe(false);
    expect(r.json).toMatchObject({ mode: 'fit', start: 1, length: 2, speed: 2, rangeCleared: { in: 1, out: 3 } });
    expect(project().range).toBeUndefined();
    expect(past()).toBe(before + 1);
    expect((clips()[0] as any).speed).toBe(2);
  });

  it('overwrite with at keeps the range', async () => {
    useEditor.getState().setRange({ in: 1, out: 3 });
    useEditor.getState().insertAsset('v1', { start: 0 });
    const before = past();
    const r = await call('edit_media', { asset: 'v2', mode: 'overwrite', at: 0.5, until: 1.5, parts: 'picture' });
    expect(r.error, r.text).toBe(false);
    expect(r.json).toMatchObject({ start: 0.5, length: 1 });
    expect(r.json!.rangeCleared).toBeUndefined();
    expect(project().range).toEqual({ in: 1, out: 3 });
    expect(past()).toBe(before + 1);
    expect(r.json!.moved).toBe(0);
  });

  it('replace keeps id and length', async () => {
    const id = useEditor.getState().insertAsset('v1', { start: 0, range: { in: 0, out: 3 } })!;
    const before = past();
    const r = await call('edit_media', { asset: 'v2', mode: 'replace', at: 1, source_time: 2 });
    expect(r.error, r.text).toBe(false);
    expect(r.json!.clips[0]).toMatchObject({ id, asset: 'v2', start: 0, end: 3 });
    expect(r.json).toMatchObject({ mode: 'replace', start: 0, length: 3, sourceIn: 1 });
    expect((clips().find((c) => c.id === id) as any).trimStart).toBe(1);
    expect(past()).toBe(before + 1);
    // clip by id
    const named = await call('edit_media', { asset: 'v1', mode: 'replace', clip: id, at: 1, source_time: 5 });
    expect(named.error, named.text).toBe(false);
    expect(named.json!.clips[0]).toMatchObject({ id, asset: 'v1' });
  });

  it('append', async () => {
    useEditor.getState().insertAsset('v2', { start: 0 });
    const r = await call('edit_media', { asset: 'v1', mode: 'append', in: 1, out: 3 });
    expect(r.error, r.text).toBe(false);
    expect(r.json).toMatchObject({ mode: 'append', start: 4, length: 2, sourceIn: 1, playhead: 6 });
  });

  it('never reads the ui targets or the setting', async () => {
    const lowest = videoTrack();
    const top = useEditor.getState().addTrack('video');
    // the ui would pick the new track on top and a grouped pair, the tool takes the lowest video track and a single clip
    setEditTarget('picture', top);
    useSoundApart.setState({ apart: true });
    useEditor.getState().select([]);
    try {
      const r = await call('edit_media', { asset: 'v1', mode: 'insert', at: 0, in: 0, out: 2 });
      expect(r.error, r.text).toBe(false);
      expect(r.json!.clips).toHaveLength(1);
      expect(clips()).toHaveLength(1);
      expect(clips()[0]!.group).toBeUndefined();
      expect(clips()[0]!.trackId).toBe(lowest);
      expect(currentTargets(project().id)).toEqual({ picture: top, sound: null });
      // sound_apart asks for the pair
      const pair = await call('edit_media', { asset: 'v1', mode: 'overwrite', at: 10, in: 0, out: 2, sound_apart: true });
      expect(pair.error, pair.text).toBe(false);
      expect(pair.json!.clips).toHaveLength(2);
      expect(pair.json!.clips[0].group).toBeTruthy();
    } finally {
      useSoundApart.setState({ apart: false });
      resetEditTargets();
    }
  });

  it('each refusal once', async () => {
    useEditor.getState().addAsset(silent());
    const [video, audio] = project().tracks;
    const locked = useEditor.getState().addTrack('video');
    useEditor.getState().updateTrack(locked, { locked: true });
    useEditor.getState().insertAsset('v2', { start: 0 });
    const before = past();
    const snapshot = JSON.stringify(clips());
    const refusals: [Record<string, unknown>, string | RegExp][] = [
      [{ asset: 'nope', mode: 'insert' }, /no media with the id nope/],
      [{ asset: 'v1', mode: 'splice' }, /mode must be one of: insert, overwrite, replace, fit, append/],
      [{ asset: 'v1', mode: 'insert', track: 'nope' }, /no track with the id nope/],
      [{ asset: 'v1', mode: 'insert', track: audio!.id }, `the track ${audio!.id} is an audio track: track is the video track for the picture, sound_track the audio track`],
      [{ asset: 'v1', mode: 'insert', sound_track: video!.id }, `the track ${video!.id} is a video track: sound_track is the audio track for the sound, track the video track`],
      [{ asset: 'v1', mode: 'insert', track: locked }, new RegExp(`the track ${locked} \\(.*\\) is locked. unlock it with update_track first`)],
      [{ asset: 'a1', mode: 'insert', track: video!.id }, 'track is for the picture: give the audio track as sound_track'],
      [{ asset: 'v1', mode: 'insert', parts: 'sound', track: video!.id }, 'track is for the picture: give the audio track as sound_track'],
      [{ asset: 'a1', mode: 'insert', parts: 'picture' }, 'the media a1 is audio: it has no picture'],
      [{ asset: 'sv', mode: 'insert', parts: 'sound' }, 'the media sv has no sound'],
      [{ asset: 'i1', mode: 'insert', in: 1 }, 'the media i1 is a picture: pictures have no in or out, their length is set on the timeline'],
      [{ asset: 'v1', mode: 'insert', in: 12 }, 'in 12 is after the end of the media (10 s)'],
      [{ asset: 'v1', mode: 'insert', in: 4, out: 3 }, 'in has to be before out'],
      [{ asset: 'v1', mode: 'insert', in: 9.99 }, 'the marked part has to be at least 0.05 s long'],
      [{ asset: 'v1', mode: 'overwrite', at: 3, until: 2 }, 'until has to be after at'],
      [{ asset: 'v1', mode: 'overwrite', at: 3, until: 3.02 }, 'the range has to be at least 0.05 s long'],
      [{ asset: 'v1', mode: 'overwrite', until: 0 }, 'until has to be after 0'],
      [{ asset: 'v1', mode: 'append', at: 1 }, 'append goes after the last clip of the target tracks: leave at and until out'],
      [{ asset: 'v1', mode: 'append', until: 2 }, 'append goes after the last clip of the target tracks: leave at and until out'],
      [{ asset: 'v1', mode: 'replace', at: 1, until: 2 }, 'replace keeps the clip length: leave until out'],
      [{ asset: 'v1', mode: 'insert', clip: 'x' }, 'clip only goes with mode replace'],
      [{ asset: 'v1', mode: 'fit', at: 0, until: 2, source_time: 1 }, 'source_time only goes with mode replace'],
      [{ asset: 'v1', mode: 'replace', clip: 'nope' }, /no clip with the id nope/],
      [{ asset: 'v1', mode: 'replace', at: 1, source_time: 11 }, 'source_time 11 is after the end of the media (10 s)'],
      [{ asset: 'v1', mode: 'fit' }, 'fit needs at and until, or both in and out points of the project (set_range)'],
      [{ asset: 'v1', mode: 'fit', at: 1 }, 'fit needs at and until, or both in and out points of the project (set_range)'],
      [{ asset: 'v1', mode: 'fit', until: 3 }, 'fit needs at and until, or both in and out points of the project (set_range)'],
    ];
    for (const [args, want] of refusals) {
      const r = await call('edit_media', args);
      expect(r.error, JSON.stringify(args)).toBe(true);
      if (typeof want === 'string') expect(r.text, JSON.stringify(args)).toBe(want);
      else expect(r.text, JSON.stringify(args)).toMatch(want);
    }
    // only one project mark is not enough for fit
    useEditor.getState().setRange({ in: 1 });
    expect((await call('edit_media', { asset: 'v1', mode: 'fit' })).text).toMatch(/^fit needs at and until/);
    // a plan stop of the editor comes back as its own reason and writes nothing
    const stop = await call('edit_media', { asset: 'v1', mode: 'replace', at: 20 });
    expect(stop.error).toBe(true);
    expect(stop.text.length).toBeGreaterThan(5);
    expect(past()).toBe(before);
    expect(JSON.stringify(clips())).toBe(snapshot);
  });
});
