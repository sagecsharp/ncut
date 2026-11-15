import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createProject } from '../../lib/factory';
import { SkyError } from '../../media/skyImport';
import * as skyImport from '../../media/skyImport';
import { useEditor } from '../../store/editorStore';
import { useUi } from '../../store/ui';
import type { MediaAsset, SceneSky } from '../../types';
import { importSky, keepOf, makeSky, offerSky, rearrangeSky, removeAssetText, skyNotesOf, skyNotesState, skyPicturesLabel, swapSide, turnSide } from './skyLogic';

vi.mock('../../media/skyImport', () => {
  class SkyError extends Error {}
  return { SkyError, skyFromAssets: vi.fn(), importSkyFiles: vi.fn(), skyFromFaces: vi.fn() };
});

const LIGHT = { sky: '#6080c0', horizon: '#a0b0c0', ground: '#605040', sun: 0.3, sunColor: '#fff4e0', sunTurn: 10, sunHeight: 40 };
const SIDES = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];

function picture(id: string, name: string, w = 512, h = 512): MediaAsset {
  return { id, name, kind: 'image', mime: '', size: 10, duration: 0, width: w, height: h, hasAudio: false, createdAt: 0 };
}
const sixAssets = () => SIDES.map((s) => picture(`id_${s}`, `sky_${s}.png`));
const madeSky = (over: Partial<SceneSky> = {}): SceneSky => ({ faces: sixAssets().map((a) => a.id), turn: 0, brightness: 1, blur: 0, light: LIGHT, ...over });
const toasts = () => useUi.getState().toasts;
const project = () => useEditor.getState().project!;

beforeEach(() => {
  vi.mocked(skyImport.skyFromAssets).mockReset();
  vi.mocked(skyImport.skyFromFaces).mockReset();
  vi.mocked(skyImport.importSkyFiles).mockReset();
  useUi.setState({ toasts: [] });
  useEditor.getState().closeProject();
  useEditor.getState().openProject(createProject('sky'));
  for (const a of sixAssets()) useEditor.getState().addAsset(a);
});

describe('skyLogic', () => {
  it('skyPicturesLabel names one picture or six', () => {
    const assets = sixAssets();
    expect(skyPicturesLabel(assets, ['id_px'])).toBe('sky_px.png');
    expect(skyPicturesLabel(assets, ['gone'])).toBe('gone');
    expect(skyPicturesLabel(assets, assets.map((a) => a.id))).toBe('sky: 6 pictures');
    expect(skyPicturesLabel([picture('a', 'dusk_right.png'), ...assets.slice(1)], ['a', ...assets.slice(1).map((x) => x.id)])).toBe('dusk: 6 pictures');
    expect(skyPicturesLabel([], [])).toBe('sky: 0 pictures');
  });

  it('removeAssetText for the sky, clips, both and neither', () => {
    expect(removeAssetText('a.png', 0, false)).toBeNull();
    expect(removeAssetText('a.png', 2, false)).toBe('"a.png" is used by 2 clips on the timeline. removing it deletes those clips too. this clears undo history.');
    expect(removeAssetText('a.png', 1, false)).toBe('"a.png" is used by 1 clip on the timeline. removing it deletes that clip too. this clears undo history.');
    expect(removeAssetText('a.png', 0, true)).toBe('"a.png" is part of the sky. removing it takes the sky off.');
    expect(removeAssetText('a.png', 1, true)).toBe('"a.png" is part of the sky and used by 1 clip on the timeline. removing it takes the sky off and deletes that clip too. this clears undo history.');
    expect(removeAssetText('a.png', 3, true)).toContain('used by 3 clips');
    expect(removeAssetText('a.png', 3, true)).toContain('deletes those clips too');
  });

  it('swapSide swaps two sides with their turns', () => {
    const faces = ['a', 'b', 'c', 'd', 'e', 'f'];
    const r = swapSide(faces, [1, 0, 2, 0, 0, 3], 0, 'f');
    expect(r.faces).toEqual(['f', 'b', 'c', 'd', 'e', 'a']);
    expect(r.turns).toEqual([3, 0, 2, 0, 0, 1]);
    // the same picture on the same side changes nothing, missing turns count as 0
    expect(swapSide(faces, [], 2, 'c')).toEqual({ faces, turns: [0, 0, 0, 0, 0, 0] });
    // the input is left alone
    expect(faces).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('turnSide adds a quarter turn and wraps', () => {
    expect(turnSide([], 2)).toEqual([0, 0, 1, 0, 0, 0]);
    expect(turnSide([0, 0, 3, 0, 0, 0], 2)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(turnSide([1, 1, 1, 1, 1, 1], 5)).toEqual([1, 1, 1, 1, 1, 2]);
  });

  it('keepOf takes turn, brightness and blur', () => {
    expect(keepOf(null)).toEqual({});
    expect(keepOf(undefined)).toEqual({});
    expect(keepOf(madeSky({ turn: 40, brightness: 1.5, blur: 0.2 }))).toEqual({ turn: 40, brightness: 1.5, blur: 0.2 });
  });

  it('makeSky sets the sky in one undo step and says so', async () => {
    const ids = sixAssets().map((a) => a.id);
    vi.mocked(skyImport.skyFromAssets).mockResolvedValue({ sky: madeSky(), notes: [] });
    const before = useEditor.getState().past.length;
    expect(await makeSky(ids)).toBe(true);
    expect(skyImport.skyFromAssets).toHaveBeenCalledWith(ids, {});
    expect(project().sky).toEqual(madeSky());
    expect(useEditor.getState().past.length).toBe(before + 1);
    expect(toasts().map((t) => [t.kind, t.message])).toEqual([['success', 'sky set']]);
    // a second one keeps turn, brightness and blur and shows the notes
    useEditor.getState().updateProject({ sky: madeSky({ turn: 40, brightness: 1.5, blur: 0.2 }) });
    useUi.setState({ toasts: [] });
    vi.mocked(skyImport.skyFromAssets).mockResolvedValue({ sky: madeSky(), notes: ['fixed the sides to fit their seams: swapped left and right'] });
    await makeSky(ids);
    expect(skyImport.skyFromAssets).toHaveBeenLastCalledWith(ids, { turn: 40, brightness: 1.5, blur: 0.2 });
    expect(toasts()[0]!.message).toBe('sky set. fixed the sides to fit their seams: swapped left and right');
  });

  it('makeSky shows the refusal and changes nothing', async () => {
    vi.mocked(skyImport.skyFromAssets).mockRejectedValueOnce(new SkyError('"a.png" is a 2:1 panorama.'));
    const before = useEditor.getState().past.length;
    expect(await makeSky(['id_px'])).toBe(false);
    expect(toasts().map((t) => [t.kind, t.message])).toEqual([['error', '"a.png" is a 2:1 panorama.']]);
    expect(project().sky ?? null).toBeNull();
    expect(useEditor.getState().past.length).toBe(before);
    vi.mocked(skyImport.skyFromAssets).mockRejectedValueOnce(new Error('boom'));
    expect(await makeSky(['id_px'])).toBe(false);
    expect(toasts()[1]!.message).toBe('could not make a sky of that');
  });

  it('makeSky changes nothing when another project opened meanwhile', async () => {
    vi.mocked(skyImport.skyFromAssets).mockImplementation(async () => {
      useEditor.getState().openProject(createProject('other'));
      return { sky: madeSky(), notes: [] };
    });
    expect(await makeSky(['id_px'])).toBe(false);
    expect(project().name).toBe('other');
    expect(project().sky ?? null).toBeNull();
    expect(toasts()).toHaveLength(0);
    // the project closed meanwhile
    vi.mocked(skyImport.skyFromAssets).mockImplementation(async () => {
      useEditor.getState().closeProject();
      return { sky: madeSky(), notes: [] };
    });
    expect(await makeSky(['id_px'])).toBe(false);
    expect(useEditor.getState().project).toBeNull();
  });

  it('importSky and rearrangeSky go through the same steps', async () => {
    const file = new File([new Uint8Array([1])], 'sky.png');
    vi.mocked(skyImport.importSkyFiles).mockResolvedValue({ sky: madeSky(), notes: [] });
    expect(await importSky([file])).toBe(true);
    expect(skyImport.importSkyFiles).toHaveBeenCalledWith([file], {});
    expect(toasts()[0]!.message).toBe('sky set');
    useUi.setState({ toasts: [] });
    const faces = madeSky().faces!;
    vi.mocked(skyImport.skyFromFaces).mockResolvedValue({ sky: madeSky({ turns: [0, 0, 1, 0, 0, 0] }), notes: [] });
    expect(await rearrangeSky(faces, [0, 0, 1, 0, 0, 0])).toBe(true);
    expect(skyImport.skyFromFaces).toHaveBeenCalledWith(faces, [0, 0, 1, 0, 0, 0], { turn: 0, brightness: 1, blur: 0 });
    expect(project().sky!.turns).toEqual([0, 0, 1, 0, 0, 0]);
    // no toast for a rearrange
    expect(toasts()).toHaveLength(0);
  });

  it('offerSky offers "use as sky" for a skybox and stays quiet otherwise', async () => {
    offerSky(sixAssets());
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0]!.message).toBe('these pictures look like a skybox');
    expect(toasts()[0]!.kind).toBe('info');
    expect(toasts()[0]!.action?.label).toBe('use as sky');
    vi.mocked(skyImport.skyFromAssets).mockResolvedValue({ sky: madeSky(), notes: [] });
    toasts()[0]!.action!.run();
    await vi.waitFor(() => expect(project().sky).toBeTruthy());
    expect(skyImport.skyFromAssets).toHaveBeenCalledWith(sixAssets().map((a) => a.id), {});
    useUi.setState({ toasts: [] });
    offerSky([picture('photo', 'holiday.png', 1920, 1080)]);
    expect(toasts()).toHaveLength(0);
    offerSky([]);
    expect(toasts()).toHaveLength(0);
    // a strip is one picture
    offerSky([picture('strip', 'anything.png', 6144, 1024)]);
    expect(toasts()[0]!.message).toBe('this picture looks like a skybox');
  });
});

describe('the notes of a sky', () => {
  it('show under the sky they were made for, not under another one', async () => {
    const ids = sixAssets().map((a) => a.id);
    vi.mocked(skyImport.skyFromAssets).mockResolvedValue({ sky: madeSky(), notes: ['fixed the sides to fit their seams: swapped left and right'] });
    await makeSky(ids);
    const state = skyNotesState();
    expect(skyNotesOf(state, project().sky)).toEqual(['fixed the sides to fit their seams: swapped left and right']);
    // turn, brightness and blur are not part of the pictures
    expect(skyNotesOf(state, madeSky({ turn: 50, blur: 0.3 }))).toHaveLength(1);
    expect(skyNotesOf(state, madeSky({ faces: [...ids].reverse() }))).toEqual([]);
    expect(skyNotesOf(state, null)).toEqual([]);
  });
});
