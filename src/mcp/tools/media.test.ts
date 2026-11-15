import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearBusy, setBusy } from '../../lib/busy';
import { createProject } from '../../lib/factory';
import { useEditor } from '../../store/editorStore';
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
