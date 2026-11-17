import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearBusy, setBusy } from '../../lib/busy';
import { defaultFog } from '../../features/properties/fogLogic';
import { autoLightAt, skyLightOf } from '../../engine/scene3d/light';
import { defaultLight } from '../../features/properties/lightLogic';
import { CANVAS_PRESETS, createProject } from '../../lib/factory';
import { useEditor } from '../../store/editorStore';
import { editEndReason } from '../../features/shell/reasons';
import { usePlayback } from '../../store/playback';
import { useSource } from '../../store/source';
import { useTimeDisplay } from '../../store/timeDisplay';
import { useUi } from '../../store/ui';
import type { CanvasPreset } from '../../lib/factory';
import { SkyError, skyFromAssets } from '../../media/skyImport';
import type { MediaAsset, Project, SceneLight } from '../../types';
import { callTool } from '../registry';
import type { ToolResult } from '../types';

// the session talks to indexeddb and the dom: stand in for it with the same effect on the store
const session = vi.hoisted(() => ({
  stored: [] as unknown[],
  openProjectById: vi.fn(),
  createAndOpenProject: vi.fn(),
  closeProject: vi.fn(),
  deleteStoredProject: vi.fn(),
  // runs while listProjects waits, to change things like the ui would
  whileListing: null as (() => void) | null,
}));
vi.mock('../../store/session', async () => {
  const { create } = await import('zustand');
  return {
    openProjectById: session.openProjectById,
    createAndOpenProject: session.createAndOpenProject,
    closeProject: session.closeProject,
    deleteStoredProject: session.deleteStoredProject,
    flushAutosave: async () => {},
    importProjectFile: async () => 'prj_x',
    useSaveState: create(() => ({ state: 'saved' })),
  };
});
vi.mock('../../storage/db', () => ({ listProjects: async () => {
    session.whileListing?.();
    return session.stored;
  },
}));
vi.mock('../../media/importer', () => ({ importFiles: async () => [] }));

// the made sky: the pictures from the ids, turn, brightness and blur from keep, a fixed light
const sky = vi.hoisted(() => ({
  light: { sky: '#6080c0', horizon: '#a0b0c0', ground: '#605040', sun: 0.3, sunColor: '#fff4e0', sunTurn: 10, sunHeight: 40 },
  notes: [] as string[],
}));
vi.mock('../../media/skyImport', () => {
  class SkyError extends Error {}
  const made = (source: Record<string, unknown>, keep: { turn?: number; brightness?: number; blur?: number } = {}) => ({
    sky: { ...source, turn: keep.turn ?? 0, brightness: keep.brightness ?? 1, blur: keep.blur ?? 0, light: { ...sky.light } },
    notes: [...sky.notes],
  });
  return {
    SkyError,
    skyFromAssets: vi.fn(async (ids: string[], keep?: object) => (ids.length === 1 ? made({ asset: ids[0] }, keep) : made({ faces: [...ids] }, keep))),
    skyFromFaces: vi.fn(async (faces: string[], turns: number[], keep?: object) => made({ faces: [...faces], ...(turns.some((t) => t) ? { turns: [...turns] } : {}) }, keep)),
    importSkyFiles: vi.fn(),
  };
});

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
  session.whileListing = null;
  session.openProjectById.mockReset().mockResolvedValue(true);
  session.deleteStoredProject.mockReset().mockResolvedValue(undefined);
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

  it('open_project with the open id does not reopen it and keeps the undo history', async () => {
    useEditor.getState().addText();
    const before = past();
    session.openProjectById.mockClear();
    const r = await call('open_project', { id: project().id });
    expect(r.json!.note).toMatch(/already open/);
    expect(session.openProjectById).not.toHaveBeenCalled();
    expect(past()).toBe(before);
    expect(project().clips).toHaveLength(1);
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
    expect((await call('update_project', { bogus: 1 })).text).toMatch(/not a known field/);
  });
});

describe('fog', () => {
  const FOG = { color: '#223344', near: 500, far: 3000, amount: 0.5 };
  const fogNow = () => project().fog;

  it('sets a full fog as one undo step and answers it', async () => {
    const before = past();
    const r = await call('update_project', { fog: { color: '#ABCDEF', near: 500.4, far: 3000, amount: 0.123456 } });
    expect(r.json!.fog).toEqual({ color: '#abcdef', near: 500, far: 3000, amount: 0.1235 });
    expect(fogNow()).toEqual({ color: '#abcdef', near: 500, far: 3000, amount: 0.1235 });
    expect(past()).toBe(before + 1);
  });

  it('lays a part over the fog the project has', async () => {
    await call('update_project', { fog: FOG });
    const r = await call('update_project', { fog: { amount: 0.25 } });
    expect(r.json!.fog).toEqual({ ...FOG, amount: 0.25 });
  });

  it('an object when there is no fog starts from the defaults', async () => {
    const d = defaultFog(project().background, project().height);
    const r = await call('update_project', { fog: {} });
    expect(r.json!.fog).toEqual(d);
    const other = await call('update_project', { fog: { amount: 0.5 } });
    expect(other.json!.fog).toEqual({ ...d, amount: 0.5 });
  });

  it('the default fog follows a height and background sent in the same call', async () => {
    const r = await call('update_project', { height: 2160, background: '#336699', fog: {} });
    expect(r.json!.fog).toEqual(defaultFog('#336699', 2160));
    expect(fogNow()).toEqual(defaultFog('#336699', 2160));
  });

  it('a part over the default uses the new height too', async () => {
    const r = await call('update_project', { height: 2160, fog: { amount: 0.5 } });
    expect(r.json!.fog).toEqual({ ...defaultFog(project().background, 2160), amount: 0.5 });
  });

  it('null switches it off, and is refused when there is none', async () => {
    expect((await call('update_project', { fog: null })).text).toMatch(/nothing changed/);
    await call('update_project', { fog: FOG });
    const before = past();
    const r = await call('update_project', { fog: null });
    expect(r.json!.fog).toBeNull();
    expect(fogNow() ?? null).toBeNull();
    expect(past()).toBe(before + 1);
  });

  it('the same values are refused as nothing changed', async () => {
    await call('update_project', { fog: FOG });
    const before = past();
    expect((await call('update_project', { fog: { ...FOG } })).text).toMatch(/nothing changed/);
    expect((await call('update_project', { fog: { near: 500 } })).text).toMatch(/nothing changed/);
    expect((await call('update_project', { fog: { color: '#223344' }, width: 1920 })).text).toMatch(/nothing changed/);
    expect(past()).toBe(before);
  });

  it('a fog change next to another setting still goes through', async () => {
    await call('update_project', { fog: FOG });
    const r = await call('update_project', { fog: { ...FOG }, name: 'both' });
    expect(r.json).toMatchObject({ name: 'both', fog: FOG });
  });

  it('refuses bad values and leaves the project as it was', async () => {
    await call('update_project', { fog: FOG });
    const before = past();
    const kept = fogNow();
    expect((await call('update_project', { fog: { color: 'red' } })).text).toMatch(/fog.color must be a hex color like #101010/);
    expect((await call('update_project', { fog: { far: 120 } })).text).toMatch(/fog.far \(120\) must be at least 10 past fog.near \(500\)/);
    expect((await call('update_project', { fog: { near: 2995 } })).text).toMatch(/fog.far \(3000\) must be at least 10 past fog.near \(2995\)/);
    for (const bad of [{ near: -1 }, { near: 50000 }, { far: 5 }, { far: 50001 }, { amount: 1.5 }, { amount: -0.1 }, { near: 'x' }]) {
      expect((await call('update_project', { fog: bad })).error, JSON.stringify(bad)).toBe(true);
    }
    for (const bad of [1, 'x', [], true]) {
      expect((await call('update_project', { fog: bad })).text, JSON.stringify(bad)).toMatch(/fog must be an object like \{ color, near, far, amount \} or null/);
    }
    expect((await call('update_project', { fog: { density: 1 } })).text).toMatch(/not a known field/);
    expect(fogNow()).toBe(kept);
    expect(past()).toBe(before);
  });

  it('an empty call names fog', async () => {
    expect((await call('update_project', {})).text).toMatch(/fps, background, fog, light, sky or output/);
  });

  it('get_project shows the fog, or null', async () => {
    expect((await call('get_project')).json!.fog).toBeNull();
    await call('update_project', { fog: FOG });
    expect((await call('get_project')).json!.fog).toEqual(FOG);
    // the short brief stays without it
    expect((await call('get_state')).json!.project).not.toHaveProperty('fog');
  });
});

describe('light', () => {
  const LIGHT = { sky: '#334455', horizon: '#556677', ground: '#111111', sun: 0.4, sunColor: '#fff4e0', sunTurn: -35, sunHeight: 45 };
  const lightNow = () => project().light;

  it('a part over no light starts from the light of the scene and is one undo step', async () => {
    await call('update_project', { background: '#336699' });
    const d = defaultLight(project(), 0);
    const before = past();
    const r = await call('update_project', { light: { sun: 0.7 } });
    expect(d.sky).toBe('#336699');
    expect(d.horizon).toBe('#336699');
    expect(r.json!.light).toEqual({ ...d, sun: 0.7 });
    expect(lightNow()).toEqual({ ...d, sun: 0.7 });
    expect(past()).toBe(before + 1);
    useEditor.getState().undo();
    expect(lightNow() ?? null).toBeNull();
  });

  it('the dome of a part sees the background and fog sent in the same call', async () => {
    const r = await call('update_project', { background: '#336699', light: { sun: 0.5 } });
    expect(r.json!.light).toMatchObject({ sky: '#336699', horizon: '#336699', sun: 0.5 });
    const f = await call('update_project', { light: null });
    expect(f.json!.light).toBeNull();
    const g = await call('update_project', { fog: { color: '#ff0000', amount: 1 }, light: { sun: 0.6 } });
    expect(g.json!.light.horizon).toBe(autoLightAt({ ...project(), light: null }, 0).horizon);
    expect(g.json!.light.horizon).toBe('#ff0000');
  });

  it('a part over a light keeps the rest', async () => {
    await call('update_project', { light: LIGHT });
    const r = await call('update_project', { light: { sunTurn: 90, sunHeight: 10.04 } });
    expect(r.json!.light).toEqual({ ...LIGHT, sunTurn: 90, sunHeight: 10 });
  });

  it('colors are lowercased and a bad hex is an error', async () => {
    const r = await call('update_project', { light: { sky: '#ABCDEF', sunColor: '#FFF' } });
    expect(r.json!.light).toMatchObject({ sky: '#abcdef', sunColor: '#fff' });
    const before = past();
    expect((await call('update_project', { light: { ground: 'red' } })).text).toMatch(/light.ground must be a hex color like #101010/);
    expect(past()).toBe(before);
  });

  it('refuses what is not an object', async () => {
    for (const bad of [1, 'x', [], true]) {
      expect((await call('update_project', { light: bad })).text, JSON.stringify(bad)).toMatch(/light must be an object like/);
    }
  });

  it('null on no light is nothing changed, null on a light removes it', async () => {
    expect((await call('update_project', { light: null })).text).toMatch(/nothing changed/);
    await call('update_project', { light: LIGHT });
    const before = past();
    const r = await call('update_project', { light: null });
    expect(r.json!.light).toBeNull();
    expect(lightNow() ?? null).toBeNull();
    expect(past()).toBe(before + 1);
  });

  it('the same light again is nothing changed', async () => {
    await call('update_project', { light: LIGHT });
    const before = past();
    expect((await call('update_project', { light: { ...LIGHT } })).text).toMatch(/nothing changed/);
    expect((await call('update_project', { light: { sun: 0.4, sky: '#334455' } })).text).toMatch(/nothing changed/);
    expect(past()).toBe(before);
  });

  it('an empty call names light', async () => {
    expect((await call('update_project', {})).text).toMatch(/background, fog, light, sky or output/);
  });

  it('get_project has light null and the light the scene gives', async () => {
    await call('update_project', { background: '#336699' });
    const r = await call('get_project');
    expect(r.json!.light).toBeNull();
    expect(r.json!.autoLight.sky).toBe('#336699');
    expect(r.json!.autoLight.horizon).toMatch(/^#[0-9a-f]{6}$/);
    expect(r.json!.autoLight.ground).toMatch(/^#[0-9a-f]{6}$/);
    await call('update_project', { light: LIGHT });
    expect((await call('get_project')).json!.light).toEqual(LIGHT);
  });
});

describe('sky', () => {
  const SKY_LIGHT: SceneLight = { ...sky.light };
  const picture = (id: string, w: number, h: number, name = id): MediaAsset => ({ id, name, kind: 'image', mime: '', size: 10, duration: 0, width: w, height: h, hasAudio: false, createdAt: 0 });
  const skyNow = () => project().sky;
  beforeEach(() => {
    sky.notes = [];
    useEditor.getState().addAsset(picture('cross', 1024, 768));
    for (const s of ['px', 'nx', 'py', 'ny', 'pz', 'nz']) useEditor.getState().addAsset(picture(`f_${s}`, 512, 512));
  });

  it('sky media makes a sky in one undo step and answers it', async () => {
    const before = past();
    const r = await call('update_project', { sky: { media: ['cross'] } });
    expect(r.json!.sky).toEqual({ asset: 'cross', layout: 'cross', turn: 0, brightness: 1, blur: 0, light: SKY_LIGHT });
    expect(skyNow()).toMatchObject({ asset: 'cross', turn: 0, brightness: 1, blur: 0 });
    expect(past()).toBe(before + 1);
    expect(r.json!.notes).toBeUndefined();
    useEditor.getState().undo();
    expect(skyNow() ?? null).toBeNull();
  });

  it('sky null takes it off, and again is nothing changed', async () => {
    expect((await call('update_project', { sky: null })).text).toMatch(/nothing changed/);
    await call('update_project', { sky: { media: ['cross'] } });
    const before = past();
    const r = await call('update_project', { sky: null });
    expect(r.json!.sky).toBeNull();
    expect(skyNow() ?? null).toBeNull();
    expect(past()).toBe(before + 1);
    expect((await call('update_project', { sky: null })).text).toMatch(/nothing changed/);
    expect(past()).toBe(before + 1);
  });

  it('sky turn alone changes the sky, and is refused without one', async () => {
    const none = await call('update_project', { sky: { turn: 90 } });
    expect(none.text).toBe('the project has no sky. send sky.media (1 picture or 6) to make one');
    await call('update_project', { sky: { media: ['cross'], blur: 0.5 } });
    const before = past();
    const r = await call('update_project', { sky: { turn: 90, brightness: 1.5 } });
    expect(r.json!.sky).toMatchObject({ asset: 'cross', turn: 90, brightness: 1.5, blur: 0.5 });
    expect(past()).toBe(before + 1);
    expect((await call('update_project', { sky: { turn: 90 } })).text).toMatch(/nothing changed/);
    // new pictures keep the values of the sky before
    const again = await call('update_project', { sky: { media: ['f_px', 'f_nx', 'f_py', 'f_ny', 'f_pz', 'f_nz'] } });
    expect(again.json!.sky).toMatchObject({ faces: ['f_px', 'f_nx', 'f_py', 'f_ny', 'f_pz', 'f_nz'], turns: [0, 0, 0, 0, 0, 0], turn: 90, brightness: 1.5, blur: 0.5 });
  });

  it('media and faces together are refused', async () => {
    const six = ['f_px', 'f_nx', 'f_py', 'f_ny', 'f_pz', 'f_nz'];
    expect((await call('update_project', { sky: { media: ['cross'], faces: six } })).text).toBe('send sky.media or sky.faces, not both');
    expect((await call('update_project', { sky: { media: ['cross'], turns: [0, 0, 0, 0, 0, 0] } })).text).toBe('sky.turns goes with sky.faces');
    expect((await call('update_project', { sky: [1] })).text).toMatch(/sky must be an object like/);
    expect(skyNow() ?? null).toBeNull();
  });

  it('a light on the sky is refused', async () => {
    const r = await call('update_project', { sky: { media: ['cross'], light: SKY_LIGHT } });
    expect(r.error).toBe(true);
    expect(r.text).toBe('the light of a sky is measured from its pictures and cannot be sent. send light for an own light instead');
    expect(skyNow() ?? null).toBeNull();
  });

  it('a sky read while another project opened changes nothing', async () => {
    const made = await skyFromAssets(['cross'], {});
    vi.mocked(skyFromAssets).mockImplementationOnce(async () => {
      useEditor.getState().openProject(createProject('other'));
      return made;
    });
    const r = await call('update_project', { sky: { media: ['cross'] }, name: 'x' });
    expect(r.error).toBe(true);
    expect(r.text).toBe('the open project changed while the sky pictures were read. nothing changed');
    expect(project().name).toBe('other');
    expect(skyNow() ?? null).toBeNull();
    expect(past()).toBe(0);
  });

  it('a SkyError comes back as the tool error', async () => {
    const mod = await import('../../media/skyImport');
    vi.mocked(mod.skyFromAssets).mockRejectedValueOnce(new SkyError('"cross" is not a picture'));
    const before = past();
    const r = await call('update_project', { sky: { media: ['cross'] } });
    expect(r.error).toBe(true);
    expect(r.text).toBe('"cross" is not a picture');
    expect(past()).toBe(before);
  });

  it('notes come back when the sides were changed', async () => {
    sky.notes = ['fixed the sides to fit their seams: swapped left and right'];
    const r = await call('update_project', { sky: { media: ['f_px', 'f_nx', 'f_py', 'f_ny', 'f_pz', 'f_nz'] } });
    expect(r.json!.notes).toEqual(['fixed the sides to fit their seams: swapped left and right']);
  });

  it('get_project lists the sky and autoLight is its dome', async () => {
    expect((await call('get_project')).json!.sky).toBeNull();
    // a sky on a project with a usable picture and a light
    useEditor.getState().updateProject({ sky: { asset: 'cross', turn: 0, brightness: 1, blur: 0, light: { ...SKY_LIGHT } } });
    const r = await call('get_project');
    expect(r.json!.sky).toMatchObject({ asset: 'cross', layout: 'cross' });
    expect(r.json!.sky.missing).toBeUndefined();
    const dome = skyLightOf(project())!;
    expect(r.json!.autoLight).toEqual({ sky: dome.sky, horizon: dome.horizon, ground: dome.ground });
    // the picture is gone: missing, and autoLight falls back to the scene
    useEditor.getState().removeAsset('cross');
    expect(project().sky ?? null).toBeNull();
    useEditor.getState().updateProject({ sky: { asset: 'cross', turn: 0, brightness: 1, blur: 0, light: { ...SKY_LIGHT } } });
    expect((await call('get_project')).json!.sky.missing).toBe(true);
  });
});

describe('delete_project', () => {
  const listed = (id: string, name: string) => ({ id, name, width: 1920, height: 1080, fps: 30, duration: 0, clipCount: 0, updatedAt: 1, createdAt: 1 });

  it('deletes a stored project that is not open', async () => {
    session.stored = [listed('prj_a', 'old cut')];
    const r = await call('delete_project', { id: 'prj_a', name: ' old cut ' });
    expect(r.json).toEqual({ deleted: 'prj_a', name: 'old cut', wasOpen: false });
    expect(session.deleteStoredProject).toHaveBeenCalledWith('prj_a');
  });

  it('says wasOpen for the open one', async () => {
    const open = project();
    session.stored = [listed(open.id, open.name)];
    const r = await call('delete_project', { id: open.id, name: open.name });
    expect(r.json).toEqual({ deleted: open.id, name: open.name, wasOpen: true });
    expect(session.deleteStoredProject).toHaveBeenCalledWith(open.id);
  });

  it('a wrong name is refused, points at the project with that name and never hands out the name of the one at the id', async () => {
    session.stored = [listed('prj_a', 'old cut'), listed('prj_b', 'new cut')];
    const r = await call('delete_project', { id: 'prj_a', name: 'new cut' });
    expect(r.error).toBe(true);
    expect(r.text).toMatch(/nothing was deleted: the id prj_a and the name "new cut" are not the same project/);
    expect(r.text).toMatch(/the project called "new cut" has the id prj_b/);
    expect(r.text).not.toMatch(/old cut/);
    expect(r.text).not.toMatch(/send its exact name/);
    const r2 = await call('delete_project', { id: 'prj_a', name: 'Old Cut' });
    expect(r2.error).toBe(true);
    expect(r2.text).toMatch(/no stored project has that name/);
    expect(session.deleteStoredProject).not.toHaveBeenCalled();
  });

  it('a shared name needs updated too', async () => {
    session.stored = [listed('prj_a', 'untitled project'), { ...listed('prj_b', 'untitled project'), updatedAt: 2 }];
    expect((await call('delete_project', { id: 'prj_a', name: 'untitled project' })).text).toMatch(/2 projects are called "untitled project". send updated/);
    expect((await call('delete_project', { id: 'prj_a', name: 'untitled project', updated: 2 })).error).toBe(true);
    expect(session.deleteStoredProject).not.toHaveBeenCalled();
    const r = await call('delete_project', { id: 'prj_a', name: 'untitled project', updated: 1 });
    expect(r.json).toEqual({ deleted: 'prj_a', name: 'untitled project', wasOpen: false });
    expect(session.deleteStoredProject).toHaveBeenCalledWith('prj_a');
  });

  it('a wrong updated gets its own text, with and without a twin, a missing one keeps the old text', async () => {
    session.stored = [listed('prj_a', 'old cut')];
    const lone = await call('delete_project', { id: 'prj_a', name: 'old cut', updated: 5 });
    expect(lone.error).toBe(true);
    expect(lone.text).toMatch(/nothing was deleted: updated \(5\) is not the last change time of the project prj_a/);
    expect(lone.text).toMatch(/call list_projects again/);
    session.stored = [listed('prj_a', 'untitled project'), { ...listed('prj_b', 'untitled project'), updatedAt: 2 }];
    const twin = await call('delete_project', { id: 'prj_a', name: 'untitled project', updated: 2 });
    expect(twin.text).toMatch(/updated \(2\) is not the last change time of the project prj_a/);
    expect(twin.text).not.toMatch(/projects are called/);
    expect(twin.text).not.toMatch(/prj_b/);
    expect((await call('delete_project', { id: 'prj_a', name: 'untitled project' })).text).toMatch(/2 projects are called/);
    expect(session.deleteStoredProject).not.toHaveBeenCalled();
  });

  it('names every id when more than one project has the sent name', async () => {
    session.stored = [listed('prj_a', 'old cut'), listed('prj_b', 'new cut'), listed('prj_c', 'new cut')];
    const r = await call('delete_project', { id: 'prj_a', name: 'new cut' });
    expect(r.text).toMatch(/the projects called "new cut" have the ids prj_b, prj_c/);
  });

  it('is refused when an export starts while the list is read', async () => {
    session.stored = [listed('prj_a', 'old cut')];
    session.whileListing = () => setBusy('export', 'an export is still running');
    const r = await call('delete_project', { id: 'prj_a', name: 'old cut' });
    expect(r.error).toBe(true);
    expect(r.text).toMatch(/cannot delete a project while an export is still running/);
    expect(session.deleteStoredProject).not.toHaveBeenCalled();
  });

  it('a stored name longer than 200 characters can still be deleted', async () => {
    const long = `${'x'.repeat(200)} copy`;
    session.stored = [listed('prj_a', long)];
    const r = await call('delete_project', { id: 'prj_a', name: long });
    expect(r.json).toEqual({ deleted: 'prj_a', name: long, wasOpen: false });
    expect(session.deleteStoredProject).toHaveBeenCalledWith('prj_a');
  });

  it('an unknown id is refused', async () => {
    expect((await call('delete_project', { id: 'nope', name: 'x' })).text).toMatch(/no project with the id nope. list_projects lists the projects/);
    expect(session.deleteStoredProject).not.toHaveBeenCalled();
  });

  it('the schema needs both id and name', async () => {
    session.stored = [listed('prj_a', 'old cut')];
    expect((await call('delete_project', { id: 'prj_a' })).text).toMatch(/name is missing/);
    expect((await call('delete_project', { name: 'old cut' })).text).toMatch(/id is missing/);
    expect(session.deleteStoredProject).not.toHaveBeenCalled();
  });

  it('is refused while an export runs', async () => {
    session.stored = [listed('prj_a', 'old cut')];
    setBusy('export', 'an export is still running');
    expect((await call('delete_project', { id: 'prj_a', name: 'old cut' })).text).toMatch(/cannot delete a project while an export is still running/);
    expect(session.deleteStoredProject).not.toHaveBeenCalled();
  });

  it('a failing delete comes back as an error', async () => {
    session.stored = [listed('prj_a', 'old cut')];
    session.deleteStoredProject.mockRejectedValue(new Error('disk full'));
    const r = await call('delete_project', { id: 'prj_a', name: 'old cut' });
    expect(r.error).toBe(true);
    expect(r.text).toMatch(/could not delete the project prj_a: disk full/);
  });

  it('tells the projects screen to reload after a delete, also a failed one', async () => {
    session.stored = [listed('prj_a', 'old cut')];
    const v0 = useUi.getState().projectsVersion;
    await call('delete_project', { id: 'prj_a', name: 'old cut' });
    expect(useUi.getState().projectsVersion).toBe(v0 + 1);
    session.deleteStoredProject.mockRejectedValue(new Error('disk full'));
    await call('delete_project', { id: 'prj_a', name: 'old cut' });
    expect(useUi.getState().projectsVersion).toBe(v0 + 2);
  });

  it('does not touch the projects version on a refusal', async () => {
    session.stored = [listed('prj_a', 'old cut')];
    const v0 = useUi.getState().projectsVersion;
    await call('delete_project', { id: 'prj_a', name: 'new cut' });
    await call('delete_project', { id: 'nope', name: 'x' });
    setBusy('export', 'an export is still running');
    await call('delete_project', { id: 'prj_a', name: 'old cut' });
    expect(useUi.getState().projectsVersion).toBe(v0);
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

  it('remove_track refuses a locked track, empty or not', async () => {
    const trackId = project().tracks[0]!.id;
    useEditor.getState().addText();
    useEditor.getState().updateTrack(trackId, { locked: true });
    const r = await call('remove_track', { id: trackId });
    expect(r.text).toMatch(/is locked. unlock it with update_track first/);
    expect(project().tracks.some((t) => t.id === trackId)).toBe(true);
    const empty = project().tracks.find((t) => t.id !== trackId && !project().clips.some((c) => c.trackId === t.id))!;
    useEditor.getState().updateTrack(empty.id, { locked: true });
    expect((await call('remove_track', { id: empty.id })).error).toBe(true);
  });

  it('seek and add_marker have a day as the maximum', async () => {
    expect((await call('seek', { time: 86401 })).error).toBe(true);
    expect((await call('add_marker', { time: 86401 })).error).toBe(true);
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
    for (const n of ['get_state', 'list_projects', 'open_project', 'create_project', 'close_project', 'delete_project', 'update_project', 'get_project', 'get_clip', 'select_clips', 'seek', 'undo', 'redo', 'add_track', 'update_track', 'remove_track', 'add_marker', 'remove_marker']) {
      expect(tools.has(n), n).toBe(true);
    }
    expect(tools.get('remove_track')!.annotations?.destructiveHint).toBe(true);
    expect(tools.get('delete_project')!.annotations?.destructiveHint).toBe(true);
    expect(tools.get('delete_project')!.description).toMatch(/when it is the open project, it is closed first/);
    expect(tools.get('get_project')!.annotations?.readOnlyHint).toBe(true);
  });
});

describe('set_range', () => {
  const addClips = () => {
    const ed = useEditor.getState();
    ed.addText();
    ed.addText();
    return project().clips;
  };

  it('in and out snap to frames, no undo step', async () => {
    const json = JSON.stringify(project());
    // an empty project has nothing to play: no span
    expect((await call('set_range', { in: 1.02, out: 3.2 })).json).toEqual({ range: { in: 1.0333, out: 3.2 }, span: null });
    await call('set_range', { clear: 'both' });
    useEditor.getState().addText();
    const id = project().clips[0]!.id;
    useEditor.getState().trimClip(id, 'end', 10);
    const json2 = JSON.stringify(project());
    const before = past();
    const r = await call('set_range', { in: 1.02, out: 3.2 });
    expect(r.json).toEqual({ range: { in: 1.0333, out: 3.2 }, span: { start: 1.0333, end: 3.2 } });
    expect(past()).toBe(before);
    expect(project().range).toEqual({ in: 31 / 30, out: 3.2 });
    expect((await call('set_range', { clear: 'both' })).json).toEqual({ range: null, span: null });
    expect(JSON.stringify(project())).toBe(json2);
    expect(past()).toBe(before);
    expect(json).not.toBe(json2);
  });

  it('clip marks its edges exactly', async () => {
    const [c] = addClips();
    useEditor.getState().moveClips([{ id: c!.id, trackId: c!.trackId, start: 1.011 }]);
    const clip = project().clips.find((x) => x.id === c!.id)!;
    const r = await call('set_range', { clip: c!.id });
    expect(r.json!.range).toEqual({ in: Math.round(clip.start * 10000) / 10000, out: Math.round((clip.start + clip.duration) * 10000) / 10000 });
    expect(project().range).toEqual({ in: clip.start, out: clip.start + clip.duration });
  });

  it('clear goes first', async () => {
    await call('set_range', { in: 1, out: 3 });
    expect((await call('set_range', { clear: 'in' })).json!.range).toEqual({ out: 3 });
    expect((await call('set_range', { clear: 'out', in: 2 })).json!.range).toEqual({ in: 2 });
    await call('set_range', { in: 1, out: 3 });
    expect((await call('set_range', { clear: 'both', in: 2 })).json!.range).toEqual({ in: 2 });
    expect((await call('set_range', { clear: 'in', out: 5 })).json!.range).toEqual({ out: 5 });
  });

  it('a dropped mark is noted', async () => {
    await call('set_range', { in: 1, out: 3 });
    const a = await call('set_range', { in: 4 });
    expect(a.json!.range).toEqual({ in: 4 });
    expect(a.json!.notes).toEqual(['the out point before the new in point was cleared']);
    const b = await call('set_range', { out: 2 });
    expect(b.json!.range).toEqual({ out: 2 });
    expect(b.json!.notes).toEqual(['the in point after the new out point was cleared']);
    // both given: nothing to note
    const c = await call('set_range', { in: 5, out: 6 });
    expect(c.json!.notes).toBeUndefined();
    expect(c.json!.range).toEqual({ in: 5, out: 6 });
  });

  it('every refusal', async () => {
    const [c] = addClips();
    expect((await call('set_range', {})).text).toMatch(/nothing to set: give in, out, clip or clear/);
    expect((await call('set_range', { clip: c!.id, in: 1 })).text).toMatch(/give clip or in \/ out, not both/);
    expect((await call('set_range', { in: 3, out: 2 })).text).toMatch(/in has to be before out/);
    expect((await call('set_range', { in: 3, out: 3.01 })).text).toMatch(/in has to be before out/);
    expect((await call('set_range', { clip: 'ghost' })).text).toMatch(/no clip with the id ghost/);
    expect((await call('set_range', { out: 0 })).text).toMatch(/out has to be after 0/);
    expect((await call('set_range', { out: 0.01 })).text).toMatch(/out has to be after 0/);
    expect((await call('set_range', { in: -1 })).error).toBe(true);
    expect((await call('set_range', { clear: 'some' })).error).toBe(true);
    expect((await call('set_range', { clear: 'both' })).text).toMatch(/already like that, nothing changed/);
    await call('set_range', { in: 1, out: 2 });
    expect((await call('set_range', { in: 1, out: 2 })).text).toMatch(/already like that, nothing changed/);
    useEditor.getState().closeProject();
    expect((await call('set_range', { in: 1 })).text).toMatch(/no project is open/);
  });

  it('get_project shows the range', async () => {
    expect((await call('get_project')).json!.range).toBeNull();
    await call('set_range', { in: 1, out: 2.5 });
    expect((await call('get_project')).json!.range).toEqual({ in: 1, out: 2.5 });
    await call('set_range', { clear: 'out' });
    expect((await call('get_project')).json!.range).toEqual({ in: 1 });
  });
});

describe('undo names set_range', () => {
  it('the description says the range is not history', async () => {
    const { listTools } = await import('../registry');
    const undo = listTools().tools.find((t) => t.name === 'undo')!;
    expect(undo.description).toMatch(/in and out points \(set_range\) are not part of history/);
  });
});

describe('mixer fields', () => {
  it('update_track volume, volumeDb and pan in one step', async () => {
    const a = project().tracks[1]!;
    const before = past();
    const r = await call('update_track', { id: a.id, volume: 0.5, pan: -0.25 });
    expect(r.json).toMatchObject({ id: a.id, volume: 0.5, volumeDb: -6, pan: -0.25 });
    expect(past()).toBe(before + 1);
    expect(project().tracks[1]).toMatchObject({ volume: 0.5, pan: -0.25 });
    const db = await call('update_track', { id: a.id, volumeDb: -12 });
    expect(db.json!.volumeDb).toBe(-12);
    expect(db.json!.volume).toBeCloseTo(0.2512, 4);
    expect(past()).toBe(before + 2);
    const off = await call('update_track', { id: a.id, volumeDb: -90 });
    expect(off.json).toMatchObject({ volume: 0, volumeDb: '-inf' });
    const loud = await call('update_track', { id: a.id, volumeDb: 12, pan: 1 });
    expect(loud.json).toMatchObject({ volumeDb: 12, pan: 1 });
    // 0 db and a middle pan take the fields away
    const flat = await call('update_track', { id: a.id, volume: 1, pan: 0 });
    expect(flat.json!.volume).toBeUndefined();
    expect(flat.json!.pan).toBeUndefined();
    expect('volume' in project().tracks[1]!).toBe(false);
    // one undo takes the last step back
    useEditor.getState().undo();
    expect(project().tracks[1]).toMatchObject({ pan: 1 });
  });

  it('update_track refusals and an equal level', async () => {
    const a = project().tracks[1]!;
    expect((await call('update_track', { id: a.id, volume: 0.5, volumeDb: -6 })).text).toMatch(/send volume or volumeDb, not both/);
    expect((await call('update_track', { id: a.id, volume: 4 })).text).toMatch(/volume must be/);
    expect((await call('update_track', { id: a.id, volume: -1 })).text).toMatch(/volume must be/);
    expect((await call('update_track', { id: a.id, volumeDb: 13 })).text).toMatch(/volumeDb must be/);
    expect((await call('update_track', { id: a.id, pan: 2 })).text).toMatch(/pan must be/);
    expect((await call('update_track', { id: a.id })).text).toMatch(/nothing to change: send name, muted, hidden, locked, syncLock, volume, volumeDb, pan, height or index/);
    const before = past();
    // 1 and 0 are what a track has without them
    expect((await call('update_track', { id: a.id, volume: 1 })).text).toMatch(/already has those settings, nothing changed/);
    expect((await call('update_track', { id: a.id, pan: 0 })).text).toMatch(/already has those settings, nothing changed/);
    expect(past()).toBe(before);
    await call('update_track', { id: a.id, volume: 0.5 });
    expect((await call('update_track', { id: a.id, volume: 0.5 })).text).toMatch(/already has those settings/);
    expect(past()).toBe(before + 1);
  });

  it('update_project output and null', async () => {
    const before = past();
    const r = await call('update_project', { output: { volumeDb: -6 } });
    expect(r.json!.output).toMatchObject({ volumeDb: -6 });
    expect(past()).toBe(before + 1);
    expect(project().output!.volume).toBeCloseTo(0.5012, 4);
    expect((await call('update_project', { output: { volume: 0.5 } })).json!.output).toMatchObject({ volume: 0.5, volumeDb: -6 });
    expect((await call('update_project', { output: { volume: 0.5 } })).text).toMatch(/already has those settings/);
    expect((await call('update_project', { output: { volume: 0.5, volumeDb: -6 } })).text).toMatch(/send volume or volumeDb, not both/);
    expect((await call('update_project', { output: {} })).text).toMatch(/output needs volume or volumeDb, or null for 0 db/);
    expect((await call('update_project', { output: 'loud' })).text).toMatch(/output must be \{ volume \} or \{ volumeDb \}, or null/);
    expect((await call('update_project', { output: { volume: 9 } })).text).toMatch(/volume must be/);
    expect((await call('update_project', { output: { volumeDb: 20 } })).text).toMatch(/volumeDb must be/);
    const steps = past();
    const off = await call('update_project', { output: null });
    expect(off.json!.output).toBeUndefined();
    expect(project().output ?? null).toBeNull();
    expect(past()).toBe(steps + 1);
    // null again: nothing changed
    expect((await call('update_project', { output: null })).text).toMatch(/already has those settings/);
    expect(past()).toBe(steps + 1);
  });

  it('get_project lists them only when set', async () => {
    const plain = (await call('get_project')).json!;
    expect(plain.output).toBeUndefined();
    for (const t of plain.trackList) {
      expect(t.volume).toBeUndefined();
      expect(t.volumeDb).toBeUndefined();
      expect(t.pan).toBeUndefined();
    }
    const a = project().tracks[1]!;
    await call('update_track', { id: a.id, volumeDb: -3, pan: 0.5 });
    await call('update_project', { output: { volumeDb: -90 } });
    const r = (await call('get_project')).json!;
    expect(r.trackList[1]).toMatchObject({ volume: 0.7079, volumeDb: -3, pan: 0.5 });
    expect(r.trackList[0].volume).toBeUndefined();
    expect(r.output).toEqual({ volume: 0, volumeDb: '-inf' });
  });
});

describe('get_clip pair', () => {
  const asset: MediaAsset = { id: 'av', name: 'av', kind: 'video', mime: 'video/mp4', size: 1, duration: 20, width: 1920, height: 1080, hasAudio: true, createdAt: 0 };

  it('a pair, speeds that differ, a plain clip', async () => {
    const ed = useEditor.getState();
    ed.addAsset(asset);
    const v = project().tracks.find((t) => t.kind === 'video')!;
    const pic = ed.insertAsset('av', { trackId: v.id, start: 0 })!;
    expect((await call('get_clip', { id: pic })).json!.pair).toBeUndefined();
    const sep = await call('separate_sound', { ids: [pic] });
    expect(sep.error, sep.text).toBe(false);
    const sound = sep.json!.pairs[0].sound as string;
    expect((await call('get_clip', { id: pic })).json!.pair).toEqual({ other: sound, offset: 0 });
    expect((await call('get_clip', { id: sound })).json!.pair).toEqual({ other: pic, offset: 0 });
    // the sound later by 0.5 s
    const track = project().clips.find((c) => c.id === sound)!.trackId;
    useEditor.getState().moveClips([{ id: sound, trackId: track, start: 0.5 }]);
    expect((await call('get_clip', { id: sound })).json!.pair).toEqual({ other: pic, offset: 0.5 });
    expect((await call('get_clip', { id: pic })).json!.pair).toEqual({ other: sound, offset: -0.5 });
    // another speed on one side
    useEditor.getState().setClipSpeed(sound, 2);
    expect((await call('get_clip', { id: pic })).json!.pair).toEqual({ other: sound, speeds: 'differ' });
    // a text clip has none
    useEditor.getState().addText();
    const t = project().clips.find((c) => c.type === 'text')!;
    expect((await call('get_clip', { id: t.id })).json!.pair).toBeUndefined();
  });
});

function mediaAsset(id: string, kind: MediaAsset['kind'], duration: number): MediaAsset {
  return { id, name: id, kind, mime: '', size: 1, duration, width: 640, height: 360, hasAudio: kind !== 'image', createdAt: 0 };
}

describe('get_state source and timeDisplay', () => {
  it('get_state source and timeDisplay', async () => {
    const idle = await call('get_state');
    expect(idle.json!.source).toBeNull();
    expect(idle.json!.timeDisplay).toBe('timecode');
    useEditor.getState().addAsset(mediaAsset('v1', 'video', 10));
    useSource.getState().open('v1', 2.5);
    const open = await call('get_state');
    expect(open.json!.source).toEqual({ media: 'v1', time: 2.5, playing: false, active: false });
    useUi.getState().activateSource();
    expect((await call('get_state')).json!.source).toMatchObject({ active: true });
    useTimeDisplay.getState().setMode('frames');
    const frames = await call('get_state');
    expect(frames.json!.timeDisplay).toBe('frames');
    expect(frames.text.length).toBeLessThan(800);
    // no tool sets it
    expect((await call('get_state', { timeDisplay: 'seconds' })).error).toBe(true);
    useTimeDisplay.getState().setMode('timecode');
    useUi.getState().activateProgram();
    useSource.getState().close();
    expect((await call('get_state')).json!.source).toBeNull();
    const desc = (await import('../registry')).TOOLS.find((t) => t.name === 'get_state')!.description;
    expect(desc).toMatch(/source view/);
    expect(desc).toMatch(/timeDisplay/);
  });
});

describe('get_project media marks', () => {
  it('mediaList marks only when set', async () => {
    useEditor.getState().addAsset(mediaAsset('v1', 'video', 10));
    useEditor.getState().addAsset(mediaAsset('a1', 'audio', 30));
    useEditor.getState().addAsset({ ...mediaAsset('i1', 'image', 0) });
    useEditor.getState().setMediaMarks('v1', { in: 2.123456, out: 6 });
    useEditor.getState().setMediaMarks('a1', { out: 5 });
    const list = (await call('get_project')).json!.mediaList as Record<string, any>[];
    expect(list.find((m) => m.id === 'v1')!.marks).toEqual({ in: 2.1235, out: 6 });
    expect(list.find((m) => m.id === 'a1')!.marks).toEqual({ out: 5 });
    expect('marks' in list.find((m) => m.id === 'i1')!).toBe(false);
    useEditor.getState().setMediaMarks('v1', null);
    const after = (await call('get_project')).json!.mediaList as Record<string, any>[];
    expect('marks' in after.find((m) => m.id === 'v1')!).toBe(false);
  });
});

describe('seek by frame and by edit', () => {
  const clipsAt = () => {
    const s = useEditor.getState();
    const a = s.addText({ start: 0, duration: 2 });
    const b = s.addText({ start: 5, duration: 2 });
    s.select([]);
    return { a, b };
  };

  it('by frame', async () => {
    clipsAt();
    const r = await call('seek', { frame: 45 });
    expect(r.json).toMatchObject({ time: 1.5, frame: 45, duration: 7 });
    expect(usePlayback.getState().time).toBe(1.5);
    // time answers its frame too
    expect((await call('seek', { time: 2.5 })).json).toMatchObject({ time: 2.5, frame: 75 });
    expect((await call('seek', { frame: 0 })).json).toMatchObject({ time: 0, frame: 0 });
    const far = await call('seek', { frame: 9000 });
    expect(far.json).toMatchObject({ time: 7, frame: 210, clamped: true });
    expect((await call('seek', { frame: -1 })).error).toBe(true);
    expect((await call('seek', { frame: 1.5 })).error).toBe(true);
    expect((await call('seek', { frame: 2592001 })).text).toBe('frame is more than a day');
    expect((await call('seek', { frame: 2592000 })).error).toBe(false);
  });

  it('previous and next edit, still playing', async () => {
    clipsAt();
    usePlayback.setState({ playing: true });
    usePlayback.getState().seek(3);
    expect((await call('seek', { edit: 'next' })).json).toMatchObject({ time: 5, frame: 150 });
    expect((await call('seek', { edit: 'previous' })).json).toMatchObject({ time: 2, frame: 60 });
    expect((await call('seek', { edit: 'previous' })).json).toMatchObject({ time: 0 });
    expect(usePlayback.getState().playing).toBe(true);
    // the tracks of the selected clips only
    const other = useEditor.getState().addTrack('video');
    const c = useEditor.getState().addText({ start: 3, duration: 1, trackId: other });
    useEditor.getState().select([c]);
    usePlayback.getState().seek(0);
    expect((await call('seek', { edit: 'next' })).json).toMatchObject({ time: 3 });
    expect((await call('seek', { edit: 'next' })).json).toMatchObject({ time: 4 });
    expect((await call('seek', { edit: 'next' })).text).toBe(editEndReason('selection', 1));
    usePlayback.setState({ playing: false });
  });

  it('exactly one of time, frame or edit', async () => {
    clipsAt();
    const text = 'give one of time, frame or edit';
    expect((await call('seek')).text).toBe(text);
    expect((await call('seek', { time: 1, frame: 3 })).text).toBe(text);
    expect((await call('seek', { frame: 3, edit: 'next' })).text).toBe(text);
    expect((await call('seek', { time: 1, edit: 'next' })).text).toBe(text);
    expect((await call('seek', { edit: 'later' })).error).toBe(true);
    expect((await call('seek', { time: 0 })).error).toBe(false);
    const listed = (await import('../registry')).TOOLS.find((t) => t.name === 'seek')!;
    expect(listed.inputSchema.required ?? []).toEqual([]);
    expect(listed.description).toMatch(/exactly one/);
  });

  it('no edit that way says why', async () => {
    clipsAt();
    usePlayback.getState().seek(7);
    const end = await call('seek', { edit: 'next' });
    expect(end.error).toBe(true);
    expect(end.text).toBe(editEndReason('all', 1));
    usePlayback.getState().seek(0);
    expect((await call('seek', { edit: 'previous' })).text).toBe(editEndReason('all', -1));
    const other = useEditor.getState().addTrack('video');
    const c = useEditor.getState().addText({ start: 0, duration: 1, trackId: other });
    useEditor.getState().select([c]);
    usePlayback.getState().seek(1);
    expect((await call('seek', { edit: 'next' })).text).toBe(editEndReason('selection', 1));
    expect((await call('seek', { edit: 'previous' })).json).toMatchObject({ time: 0 });
    usePlayback.getState().seek(0);
    expect((await call('seek', { edit: 'previous' })).text).toBe(editEndReason('selection', -1));
    expect(usePlayback.getState().time).toBe(0);
  });
});

describe('update_track height, index and syncLock', () => {
  it('update_track height is 28 to 240 px or null, no undo step', async () => {
    const v = project().tracks[0]!;
    const before = past();
    const r = await call('update_track', { id: v.id, height: 128 });
    expect(r.json).toMatchObject({ id: v.id, height: 128, syncLock: true, index: 0 });
    expect(project().tracks[0]!.height).toBe(128);
    expect(past()).toBe(before);
    expect((await call('update_track', { id: v.id, height: 128 })).text).toMatch(/already has those settings/);
    expect((await call('update_track', { id: v.id, height: 20 })).text).toMatch(/height must be 28 to 240 px, or null for the normal height/);
    expect((await call('update_track', { id: v.id, height: 241 })).text).toMatch(/height must be 28 to 240/);
    expect((await call('update_track', { id: v.id, height: 'tall' })).error).toBe(true);
    const back = await call('update_track', { id: v.id, height: null });
    expect(back.json).toMatchObject({ height: 56 });
    expect(project().tracks[0]).not.toHaveProperty('height');
    expect(past()).toBe(before);
  });

  it('update_track index moves inside its kind in one step', async () => {
    useEditor.getState().addTrack('video');
    const ids = project().tracks.map((t) => t.id);
    const top = ids[0]!;
    const before = past();
    const r = await call('update_track', { id: top, index: 1 });
    expect(r.json).toMatchObject({ id: top, index: 1 });
    expect(project().tracks.map((t) => t.id)).toEqual([ids[1], top, ...ids.slice(2)]);
    expect(past()).toBe(before + 1);
    // clamped into the video group: the audio track stays last
    expect((await call('update_track', { id: top, index: 200 })).text).toMatch(/already has those settings/);
    expect(project().tracks[project().tracks.length - 1]!.kind).toBe('audio');
    // a name and a move together are one step
    const n = past();
    await call('update_track', { id: top, name: 'first', index: 0 });
    expect(past()).toBe(n + 1);
    expect(project().tracks[0]).toMatchObject({ id: top, name: 'first' });
    useEditor.getState().undo();
    expect(project().tracks[1]).toMatchObject({ id: top });
    expect(project().tracks[1]!.name).not.toBe('first');
  });

  it('update_track syncLock is one step, only false is stored', async () => {
    const v = project().tracks[0]!;
    const before = past();
    const off = await call('update_track', { id: v.id, syncLock: false });
    expect(off.json).toMatchObject({ syncLock: false });
    expect(project().tracks[0]!.syncLock).toBe(false);
    expect(past()).toBe(before + 1);
    expect((await call('update_track', { id: v.id, syncLock: false })).text).toMatch(/already has those settings/);
    const on = await call('update_track', { id: v.id, syncLock: true });
    expect(on.json).toMatchObject({ syncLock: true });
    expect(project().tracks[0]).not.toHaveProperty('syncLock');
    expect(past()).toBe(before + 2);
  });

  it('update_track index on a locked track is refused', async () => {
    useEditor.getState().addTrack('video');
    const top = project().tracks[0]!.id;
    useEditor.getState().updateTrack(top, { locked: true });
    const before = past();
    const order = project().tracks.map((t) => t.id);
    const r = await call('update_track', { id: top, index: 1 });
    expect(r.text).toMatch(/the track .* is locked. unlock it with update_track first/);
    expect(project().tracks.map((t) => t.id)).toEqual(order);
    expect(past()).toBe(before);
    // unlocking in the same call lets the move through, locking in it does not
    const open = await call('update_track', { id: top, locked: false, index: 1 });
    expect(open.error, open.text).toBe(false);
    expect((await call('update_track', { id: top, locked: true, index: 0 })).error).toBe(true);
    expect(project().tracks[1]!.locked).toBe(false);
  });

  it('get_project lists height and syncLock only when set', async () => {
    const [v, a] = project().tracks;
    let list = (await call('get_project')).json!.trackList as Record<string, any>[];
    expect(list[0]).not.toHaveProperty('height');
    expect(list[0]).not.toHaveProperty('syncLock');
    await call('update_track', { id: v!.id, height: 96 });
    await call('update_track', { id: a!.id, syncLock: false });
    list = (await call('get_project')).json!.trackList as Record<string, any>[];
    expect(list[0]).toMatchObject({ height: 96 });
    expect(list[0]).not.toHaveProperty('syncLock');
    expect(list[1]).toMatchObject({ syncLock: false });
    expect(list[1]).not.toHaveProperty('height');
  });
});

describe('get_clip matteOf and the lut media', () => {
  it('get_clip lists matteOf', async () => {
    const ed = useEditor.getState();
    const v = project().tracks[0]!.id;
    const a = ed.addText({ start: 0, duration: 2, trackId: v });
    const m = ed.addText({ start: 0, duration: 2, trackId: ed.addTrack('video') });
    expect((await call('get_clip', { id: m })).json!.matteOf).toBeUndefined();
    ed.updateClip(a, { matte: { clip: m, mode: 'alpha' } });
    expect((await call('get_clip', { id: m })).json!.matteOf).toEqual([a]);
    expect((await call('get_clip', { id: a })).json!.matteOf).toBeUndefined();
  });

  it('mediaList shows a lut with its lut field', async () => {
    const lut: MediaAsset = { id: 'cube1', name: 'film.cube', kind: 'lut', mime: '', size: 1, duration: 0, width: 0, height: 0, hasAudio: false, createdAt: 0, lut: { size3: 33, size1: 0, title: 'film' } };
    const plain: MediaAsset = { id: 'cube2', name: 'b.cube', kind: 'lut', mime: '', size: 1, duration: 0, width: 0, height: 0, hasAudio: false, createdAt: 0, lut: { size3: 17, size1: 256 } };
    useEditor.getState().addAsset(lut);
    useEditor.getState().addAsset(plain);
    useEditor.getState().addAsset(mediaAsset('vid', 'video', 5));
    const list = (await call('get_project')).json!.mediaList as Record<string, any>[];
    expect(list.find((x) => x.id === 'cube1')).toMatchObject({ kind: 'lut', lut: { size3: 33, size1: 0, title: 'film' } });
    expect(list.find((x) => x.id === 'cube2')!.lut).toEqual({ size3: 17, size1: 256 });
    expect(list.find((x) => x.id === 'vid')).not.toHaveProperty('lut');
  });
});
