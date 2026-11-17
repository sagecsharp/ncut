/**
 * helpers the sky section, the media panel and the mcp share. the pure parts are tested, the actions use the stores.
 * no name here starts with "use": react would take it for a hook.
 */
import { skyCandidates, skyKey, skyStemOf, withSkyValues } from '../../engine/scene3d/sky';
import { SkyError, importSkyFiles, skyFromAssets, skyFromFaces } from '../../media/skyImport';
import type { SkyKeep, SkyMade } from '../../media/skyImport';
import { useEditor } from '../../store/editorStore';
import { useUi } from '../../store/ui';
import type { MediaAsset, SceneSky } from '../../types';

/** the pictures of a sky or a candidate in words: one picture by its name, six as "<stem>: 6 pictures" (stem "sky" when the names have none) */
export function skyPicturesLabel(assets: readonly MediaAsset[], ids: readonly string[]): string {
  const nameOf = (id: string) => assets.find((a) => a.id === id)?.name ?? id;
  if (ids.length === 1) return nameOf(ids[0]!);
  const first = ids.length > 0 ? assets.find((a) => a.id === ids[0]) : undefined;
  const stem = first ? skyStemOf(first.name) : '';
  return `${stem || 'sky'}: ${ids.length} pictures`;
}

/** the text of the remove dialog of the media panel (null = no dialog: no clip and not in the sky) */
export function removeAssetText(name: string, clips: number, inSky: boolean): string | null {
  const s = clips === 1 ? '' : 's';
  const that = clips === 1 ? 'that clip' : 'those clips';
  if (inSky && clips > 0) {
    return `"${name}" is part of the sky and used by ${clips} clip${s} on the timeline. removing it removes the sky and deletes ${that} too. this clears undo history.`;
  }
  if (inSky) return `"${name}" is part of the sky. removing it removes the sky.`;
  if (clips > 0) return `"${name}" is used by ${clips} clip${s} on the timeline. removing it deletes ${that} too. this clears undo history.`;
  return null;
}

/** six faces with side i set to `id`: the side that had `id` gets side i's picture (a swap, the turns go with the pictures) */
export function swapSide(faces: readonly string[], turns: readonly number[], i: number, id: string): { faces: string[]; turns: number[] } {
  const nextFaces = [...faces];
  const nextTurns = [0, 1, 2, 3, 4, 5].map((k) => turns[k] ?? 0);
  const j = faces.indexOf(id);
  if (j < 0 || j === i) {
    if (j < 0) nextFaces[i] = id;
    return { faces: nextFaces, turns: nextTurns };
  }
  nextFaces[j] = faces[i]!;
  nextFaces[i] = id;
  nextTurns[j] = turns[i] ?? 0;
  nextTurns[i] = turns[j] ?? 0;
  return { faces: nextFaces, turns: nextTurns };
}

/** six turns with side i turned a quarter clockwise more */
export function turnSide(turns: readonly number[], i: number): number[] {
  const next = [0, 1, 2, 3, 4, 5].map((k) => turns[k] ?? 0);
  next[i] = (next[i]! + 1) % 4;
  return next;
}

/** what a new sky keeps of the one before */
export function keepOf(sky: SceneSky | null | undefined): SkyKeep {
  return sky ? { turn: sky.turn, brightness: sky.brightness, blur: sky.blur } : {};
}

/** the notes of the last sky made from the section, with the pictures of that sky (so they show under that sky only) */
export interface SkyNotes {
  key: string;
  notes: string[];
}
const NO_NOTES: SkyNotes = { key: '', notes: [] };
let lastNotes: SkyNotes = NO_NOTES;
const noteListeners = new Set<() => void>();
export function skyNotesState(): SkyNotes {
  return lastNotes;
}
/** the notes to show under this sky: none unless it has the pictures of the sky they were made for */
export function skyNotesOf(state: SkyNotes, sky: SceneSky | null | undefined): string[] {
  return sky && state.notes.length > 0 && skyKey(sky) === state.key ? state.notes : NO_NOTES.notes;
}
export function onSkyNotes(fn: () => void): () => void {
  noteListeners.add(fn);
  return () => void noteListeners.delete(fn);
}
export function clearSkyNotes(): void {
  setNotes(NO_NOTES);
}
function setNotes(next: SkyNotes): void {
  lastNotes = next;
  noteListeners.forEach((fn) => fn());
}

/**
 * read a sky with `make`, then put it on the open project: the project is read before the await and after it, and a
 * different one after it changes nothing. false = refused or nothing done.
 */
async function applySky(make: (keep: SkyKeep) => Promise<SkyMade>, toastDone: boolean): Promise<boolean> {
  const before = useEditor.getState().project;
  const ui = useUi.getState();
  if (!before) {
    ui.toast('open a project first', 'error');
    return false;
  }
  let made: SkyMade;
  try {
    made = await make(keepOf(before.sky));
  } catch (e) {
    ui.toast(e instanceof SkyError ? e.message : 'could not make a sky of that', 'error');
    return false;
  }
  const now = useEditor.getState().project;
  if (!now || now.id !== before.id) return false;
  const sky = now.sky ? withSkyValues(made.sky, keepOf(now.sky)) : made.sky;
  useEditor.getState().updateProject({ sky });
  setNotes({ key: skyKey(made.sky), notes: made.notes });
  if (toastDone) ui.toast(made.notes.length ? `sky set. ${made.notes.join('. ')}` : 'sky set', 'success');
  return true;
}

/** make the sky of the open project from media (one undo step), with a toast. false = refused (an error toast) */
export function makeSky(ids: readonly string[]): Promise<boolean> {
  return applySky((keep) => skyFromAssets(ids, keep), true);
}

/** import files as the sky (sky section: the button, a drop), with a toast */
export function importSky(files: readonly File[]): Promise<boolean> {
  return applySky((keep) => importSkyFiles(files, keep), true);
}

/** the sides of a six picture sky set by hand (swap or turn), measured again, one undo step */
export function rearrangeSky(faces: readonly string[], turns: readonly number[]): Promise<boolean> {
  return applySky((keep) => skyFromFaces(faces, turns, keep), false);
}

/** after a media panel import: a toast with "use as sky" when the new media look like a skybox */
export function offerSky(added: readonly MediaAsset[]): void {
  const sets = skyCandidates(added);
  if (sets.length === 0) return;
  const first = sets[0]!;
  useUi.getState().toast(first.length === 6 ? 'these pictures look like a skybox' : 'this picture looks like a skybox', 'info', {
    label: 'use as sky',
    run: () => void makeSky(first),
  });
}
