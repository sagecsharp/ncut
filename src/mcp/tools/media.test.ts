import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createProject } from '../../lib/factory';
import { useEditor } from '../../store/editorStore';
import type { MediaAsset } from '../../types';
import { callTool } from '../registry';
import type { ToolCtx, ToolResult } from '../types';

const mocks = vi.hoisted(() => ({ importFiles: vi.fn(), importProjectFile: vi.fn() }));
vi.mock('../../media/importer', () => ({ importFiles: mocks.importFiles }));
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

const past = () => useEditor.getState().past.length;
const project = () => useEditor.getState().project!;

beforeEach(() => {
  mocks.importFiles.mockReset();
  mocks.importProjectFile.mockReset();
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

  it('counts skipped files and fails when nothing came in', async () => {
    mocks.importFiles.mockResolvedValueOnce([asset('n1', 'video', 2, 'a.mp4')]);
    const some = await call('import_media', {}, { files: [{ name: 'a.mp4', bytes }, { name: 'x.txt', bytes }], ticket: null });
    expect(some.json!.skipped).toBe(1);
    mocks.importFiles.mockResolvedValueOnce([]);
    const none = await call('import_media', {}, { files: [{ name: 'x.txt', bytes }], ticket: null });
    expect(none.text).toMatch(/none of the files could be imported/);
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

  it('says why a file is not a project, and is desktop only', async () => {
    mocks.importProjectFile.mockRejectedValue(new Error('not a ncut project file'));
    const r = await call('import_project', {}, { files: [{ name: 'a.ncut', bytes: new ArrayBuffer(4) }], ticket: null });
    expect(r.text).toMatch(/a\.ncut is not a project ncut can read \(not a ncut project file\)/);
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
