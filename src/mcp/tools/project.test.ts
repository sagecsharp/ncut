import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearBusy, setBusy } from '../../lib/busy';
import { CANVAS_PRESETS, createProject } from '../../lib/factory';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import type { CanvasPreset } from '../../lib/factory';
import type { Project } from '../../types';
import { callTool } from '../registry';
import type { ToolResult } from '../types';

// the session talks to indexeddb and the dom: stand in for it with the same effect on the store
const session = vi.hoisted(() => ({
  stored: [] as unknown[],
  openProjectById: vi.fn(),
  createAndOpenProject: vi.fn(),
  closeProject: vi.fn(),
}));
vi.mock('../../store/session', async () => {
  const { create } = await import('zustand');
  return {
    openProjectById: session.openProjectById,
    createAndOpenProject: session.createAndOpenProject,
    closeProject: session.closeProject,
    flushAutosave: async () => {},
    importProjectFile: async () => 'prj_x',
    useSaveState: create(() => ({ state: 'saved' })),
  };
});
vi.mock('../../storage/db', () => ({ listProjects: async () => session.stored }));
vi.mock('../../media/importer', () => ({ importFiles: async () => [] }));

async function call(name: string, args: Record<string, unknown> = {}) {
  const r = (await callTool(name, args)) as ToolResult;
  const text = r.content[0]?.type === 'text' ? r.content[0].text : '';
  return { error: r.isError === true, text, json: r.isError ? null : (JSON.parse(text) as Record<string, any>) };
}

const past = () => useEditor.getState().past.length;
const project = () => useEditor.getState().project!;

beforeEach(() => {
  clearBusy();
  useEditor.getState().closeProject();
  useEditor.getState().openProject(createProject('test'));
  usePlayback.getState().seek(0);
  session.stored = [];
  session.openProjectById.mockReset().mockResolvedValue(true);
  session.closeProject.mockReset().mockImplementation(async () => useEditor.getState().closeProject());
  session.createAndOpenProject.mockReset().mockImplementation(async (name?: string, preset?: CanvasPreset, fps?: number) => {
    const p = createProject(name, preset, fps);
    useEditor.getState().openProject(p);
    return p;
  });
});

describe('get_state', () => {
  it('says there is no project', async () => {
    useEditor.getState().closeProject();
    const r = await call('get_state');
    expect(r.json!.project).toBeNull();
    expect(r.json!.undoSteps).toBe(0);
  });

  it('is small and carries the counts', async () => {
    useEditor.getState().addText();
    const r = await call('get_state');
    expect(r.json!.project).toMatchObject({ name: 'test', width: 1920, height: 1080, fps: 30, clips: 1, tracks: 2, media: 0 });
    expect(r.json!.undoSteps).toBe(1);
    expect(r.json!.selection).toHaveLength(1);
    expect(r.json!.exporting).toBe(false);
    setBusy('export', 'an export is still running');
    expect((await call('get_state')).json).toMatchObject({ exporting: true, busy: 'an export is still running' });
    expect(r.text.length).toBeLessThan(800);
  });
});

describe('projects', () => {
  it('list_projects marks the open one', async () => {
    session.stored = [
      { id: project().id, name: 'a', createdAt: 1, updatedAt: 5, width: 10, height: 10, fps: 30, duration: 1.23456, clipCount: 2 },
      { id: 'other', name: 'b', createdAt: 1, updatedAt: 4, width: 10, height: 10, fps: 30, duration: 0, clipCount: 0 },
    ];
    const r = await call('list_projects');
    expect(r.json!.projects.map((p: any) => p.open)).toEqual([true, false]);
    expect(r.json!.projects[0].duration).toBe(1.2346);
  });

  it('open_project: unknown id, busy, and the happy path', async () => {
    session.openProjectById.mockResolvedValueOnce(false);
    expect((await call('open_project', { id: 'nope' })).text).toMatch(/no stored project/);
    setBusy('export', 'an export is still running');
    expect((await call('open_project', { id: 'x' })).text).toMatch(/while an export is still running/);
    clearBusy();
    const r = await call('open_project', { id: 'x' });
    expect(r.json!.name).toBe('test');
    expect(session.openProjectById).toHaveBeenLastCalledWith('x');
  });

  it('create_project: the final size is in the answer and history is empty', async () => {
    const r = await call('create_project', { name: ' reel ', preset: '9:16', width: 1000, fps: 24 });
    expect(r.json).toMatchObject({ name: 'reel', width: 1000, height: 1920, fps: 24 });
    expect(past()).toBe(0);
    expect(project().width).toBe(1000);
    const plain = await call('create_project', {});
    expect(plain.json).toMatchObject({ width: 1920, height: 1080, fps: 30 });
    expect(session.createAndOpenProject).toHaveBeenLastCalledWith(undefined, undefined, undefined);
  });

  it('create_project refuses unknown presets, bad sizes and an empty name', async () => {
    expect((await call('create_project', { preset: '5:7' })).error).toBe(true);
    expect((await call('create_project', { width: 8 })).text).toMatch(/at least 16/);
    expect((await call('create_project', { name: '   ' })).text).toMatch(/name cannot be empty/);
    expect(session.createAndOpenProject).not.toHaveBeenCalled();
    for (const p of CANVAS_PRESETS) expect((await call('create_project', { preset: p.id })).json).toMatchObject({ width: p.width, height: p.height });
  });

  it('close_project saves and closes, and needs a project', async () => {
    expect((await call('close_project')).json).toMatchObject({ closed: expect.any(String) });
    expect(session.closeProject).toHaveBeenCalled();
    expect(useEditor.getState().project).toBeNull();
    expect((await call('close_project')).text).toMatch(/no project is open/);
  });

  it('update_project is one undo step, clamps, and refuses a no-op', async () => {
    const before = past();
    const r = await call('update_project', { name: 'new', width: 1280, height: 720, fps: 60, background: '#101010' });
    expect(r.json).toMatchObject({ name: 'new', width: 1280, height: 720, fps: 60, background: '#101010' });
    expect(past()).toBe(before + 1);
    const same = await call('update_project', { width: 1280 });
    expect(same.text).toMatch(/nothing changed/);
    expect(past()).toBe(before + 1);
    expect((await call('update_project', {})).text).toMatch(/nothing to change/);
    expect((await call('update_project', { background: 'red' })).text).toMatch(/hex color/);
    expect((await call('update_project', { fps: 500 })).error).toBe(true);
    expect((await call('update_project', { fog: 1 })).text).toMatch(/not a known field/);
  });
});

describe('reading', () => {
  it('get_project lists tracks, clips, media and markers without values', async () => {
    const s = useEditor.getState();
    const t = s.addText({ preset: { text: 'hello' } });
    s.setKeyframe(t, 'x', 0, 50);
    s.addMarker(2, 'beat');
    const r = await call('get_project');
    expect(r.json!.trackList).toHaveLength(2);
    expect(r.json!.trackList[0]).toMatchObject({ kind: 'video', muted: false, hidden: false, locked: false });
    expect(r.json!.clipList[0]).toMatchObject({ id: t, type: 'text', text: 'hello', keyed: ['x'] });
    expect(r.json!.markerList).toEqual([expect.objectContaining({ time: 2, name: 'beat' })]);
    expect(r.text).not.toContain('"transform"');
    expect(r.text).not.toContain('"v":');
    expect((await call('get_clip', { id: 'nope' })).text).toMatch(/no clip with the id nope/);
  });

  it('get_project needs a project', async () => {
    useEditor.getState().closeProject();
    expect((await call('get_project')).text).toMatch(/no project is open/);
  });

  it('get_clip gives a copy, the animatable list and the sides of a solid', async () => {
    const s = useEditor.getState();
    const id = s.addShape({ preset: { threeD: true, shape: 'box' } });
    const r = await call('get_clip', { id });
    expect(r.json!.clip).toMatchObject({ id, type: 'shape', shape: 'box' });
    expect(r.json!.animatable.map((a: any) => a.prop)).toContain('opacity');
    expect(r.json!.animatable.find((a: any) => a.prop === 'opacity')).toMatchObject({ min: 0, max: 1 });
    expect(r.json!.sides).toEqual(['front', 'back', 'right', 'left', 'top', 'bottom']);
    const plain = await call('get_clip', { id: s.addText() });
    expect(plain.json!.sides).toBeUndefined();
  });

  it('get_clip adds the params of an effect as p.<key>', async () => {
    const id = useEditor.getState().addEffect('shake')!;
    const r = await call('get_clip', { id });
    const props = r.json!.animatable.map((a: any) => a.prop);
    expect(props).toContain('amount');
    expect(props.some((p: string) => p.startsWith('p.'))).toBe(true);
  });
});

describe('selection, playhead, history', () => {
  it('select_clips refuses unknown ids and locked tracks, clears with []', async () => {
    const s = useEditor.getState();
    const a = s.addText();
    const b = s.addText({ start: 10 });
    expect((await call('select_clips', { ids: [a, b] })).json).toEqual({ selection: [a, b] });
    expect((await call('select_clips', { ids: [a, 'ghost'] })).text).toMatch(/no clip with the id ghost/);
    expect(useEditor.getState().selection).toEqual([a, b]);
    s.updateTrack(project().tracks[0]!.id, { locked: true });
    expect((await call('select_clips', { ids: [a] })).text).toMatch(/locked track/);
    expect((await call('select_clips', { ids: [] })).json).toEqual({ selection: [] });
  });

  it('seek clamps to the project length and does not pause', async () => {
    useEditor.getState().addText({ duration: 4 });
    usePlayback.setState({ playing: true });
    expect((await call('seek', { time: 2.5 })).json).toMatchObject({ time: 2.5, duration: 4 });
    const far = await call('seek', { time: 99 });
    expect(far.json).toMatchObject({ time: 4, clamped: true });
    expect(usePlayback.getState().playing).toBe(true);
    usePlayback.setState({ playing: false });
    expect((await call('seek', { time: -1 })).error).toBe(true);
  });

  it('undo and redo count the steps they really did', async () => {
    const s = useEditor.getState();
    s.addText();
    s.addText({ start: 20 });
    const r = await call('undo', { steps: 5 });
    expect(r.json).toMatchObject({ done: 2, requested: 5, undoSteps: 0, redoSteps: 2 });
    expect((await call('undo')).text).toMatch(/nothing to undo/);
    expect(project().clips).toHaveLength(0);
    expect((await call('redo')).json).toMatchObject({ done: 1, undoSteps: 1, redoSteps: 1 });
    expect((await call('redo', { steps: 9 })).json).toMatchObject({ done: 1, redoSteps: 0 });
    expect((await call('redo')).text).toMatch(/nothing to redo/);
    expect((await call('undo', { steps: 51 })).error).toBe(true);
    expect((await call('undo', { steps: 0 })).error).toBe(true);
  });
});

describe('tracks', () => {
  it('add_track is one undo step, takes a name and an index', async () => {
    const before = past();
    const r = await call('add_track', { kind: 'video', name: 'titles', index: 0 });
    expect(r.json).toMatchObject({ kind: 'video', name: 'titles', index: 0 });
    expect(past()).toBe(before + 1);
    const audio = await call('add_track', { kind: 'audio' });
    expect(audio.json!.index).toBe(project().tracks.length - 1);
    expect(past()).toBe(before + 2);
    expect((await call('add_track', { kind: 'photo' })).error).toBe(true);
    expect((await call('add_track', { kind: 'video', name: ' ' })).text).toMatch(/name cannot be empty/);
  });

  it('update_track: one step, refuses hidden on audio and a no-op', async () => {
    const [v, a] = project().tracks;
    const before = past();
    const r = await call('update_track', { id: v!.id, name: 'main', muted: true, locked: true });
    expect(r.json).toMatchObject({ name: 'main', muted: true, locked: true, hidden: false });
    expect(past()).toBe(before + 1);
    expect((await call('update_track', { id: v!.id, muted: true })).text).toMatch(/nothing changed/);
    expect((await call('update_track', { id: a!.id, hidden: true })).text).toMatch(/only applies to video/);
    expect((await call('update_track', { id: v!.id })).text).toMatch(/nothing to change/);
    expect((await call('update_track', { id: 'ghost', muted: true })).text).toMatch(/no track with the id ghost/);
    expect(past()).toBe(before + 1);
  });

  it('remove_track takes its clips along as one step and undo brings them back', async () => {
    const s = useEditor.getState();
    const trackId = project().tracks[0]!.id;
    s.addText();
    s.addText({ start: 10 });
    const before = past();
    const r = await call('remove_track', { id: trackId });
    expect(r.json).toMatchObject({ removed: trackId, clipsRemoved: 2 });
    expect(past()).toBe(before + 1);
    expect(project().clips).toHaveLength(0);
    await call('undo');
    expect(project().clips).toHaveLength(2);
    expect((await call('remove_track', { id: 'ghost' })).error).toBe(true);
  });
});

describe('markers', () => {
  it('adds, refuses a second one at the same time, removes', async () => {
    const before = past();
    const r = await call('add_marker', { time: 1.5, name: 'drop' });
    expect(r.json).toMatchObject({ time: 1.5, name: 'drop' });
    expect(past()).toBe(before + 1);
    expect((await call('add_marker', { time: 1.5004 })).text).toMatch(/already sits at 1.5/);
    expect(past()).toBe(before + 1);
    expect((await call('add_marker', { time: -2 })).error).toBe(true);
    const id = r.json!.id as string;
    expect((await call('remove_marker', { id })).json).toEqual({ removed: id });
    expect(past()).toBe(before + 2);
    expect((await call('remove_marker', { id })).text).toMatch(/no marker with the id/);
    expect((project() as Project).markers ?? []).toHaveLength(0);
  });
});

describe('the schema', () => {
  it('has the documented tools with annotations', async () => {
    const { listTools } = await import('../registry');
    const tools = new Map(listTools().tools.map((t) => [t.name, t]));
    for (const n of ['get_state', 'list_projects', 'open_project', 'create_project', 'close_project', 'update_project', 'get_project', 'get_clip', 'select_clips', 'seek', 'undo', 'redo', 'add_track', 'update_track', 'remove_track', 'add_marker', 'remove_marker']) {
      expect(tools.has(n), n).toBe(true);
    }
    expect(tools.get('remove_track')!.annotations?.destructiveHint).toBe(true);
    expect(tools.get('get_project')!.annotations?.readOnlyHint).toBe(true);
  });
});
