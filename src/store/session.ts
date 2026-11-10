/**
 * opening / closing / creating projects, url routing (#/project/<id>) and autosave.
 * the glue between the pure editor store and indexeddb.
 */
import { create } from 'zustand';
import type { Project } from '../types';
import type { CanvasPreset } from '../lib/factory';
import { createProject } from '../lib/factory';
import { busyReason } from '../lib/busy';
import { addFontFiles, importedFontFiles } from '../lib/fonts';
import { getTemplate } from '../lib/templates';
import { uid } from '../lib/id';
import { releaseAllDerived } from '../media/derived';
import { loadProjectMedia, releaseAllAssets } from '../media/registry';
import { deleteProject as dbDeleteProject, getMediaBlob, listProjects, loadProject, putMediaBlob, saveProject } from '../storage/db';
import { whenMediaStored } from '../storage/pendingMedia';
import { capturePoster, copyPoster, deletePoster, isPoster, pruneOrphanPosters, savePoster } from '../storage/posters';
import { packProject, projectFileName, unpackProject } from '../storage/projectFile';
import { useEditor } from './editorStore';
import { resetPlayback } from './playback';
import { useUi } from './ui';

const AUTOSAVE_MS = 600;

export type SaveStatus = 'saved' | 'unsaved' | 'saving' | 'error';

/** what the header shows about autosave. it only changes on edits and saves, never per frame. */
export const useSaveState = create<{ state: SaveStatus }>(() => ({ state: 'saved' }));

function setSaveState(state: SaveStatus): void {
  if (useSaveState.getState().state !== state) useSaveState.setState({ state });
}

export function projectIdFromHash(hash = location.hash): string | null {
  const m = /^#\/project\/([\w-]+)/.exec(hash);
  return m ? m[1]! : null;
}

function setHash(hash: string): void {
  if (location.hash !== hash) history.pushState(null, '', hash || location.pathname + location.search);
}

/** load a project + its media from indexeddb and open it in the editor. false when not found. */
export function openProjectById(id: string): Promise<boolean> {
  // popstate + hashchange both fire for one history step: share the open that is already running
  if (opening && opening.id === id) return opening.promise;
  const promise = doOpen(id).finally(() => {
    if (opening?.promise === promise) opening = null;
  });
  opening = { id, promise };
  return promise;
}

let opening: { id: string; promise: Promise<boolean> } | null = null;

async function doOpen(id: string): Promise<boolean> {
  const project = await loadProject(id);
  if (!project) return false;
  await flushAutosave();
  releaseAllAssets();
  releaseAllDerived();
  resetPlayback();
  const missing = await loadProjectMedia(project);
  useEditor.getState().openProject(project);
  setSaveState('saved');
  setHash(`#/project/${project.id}`);
  if (missing.length > 0) {
    useUi.getState().toast(`${missing.length} media file(s) could not be loaded`, 'error');
  }
  return true;
}

/** template: id of a starter timeline in lib/templates.ts. unknown / missing = an empty project. */
export async function createAndOpenProject(name?: string, preset?: CanvasPreset, fps?: number, template?: string | null): Promise<Project> {
  const empty = createProject(name, preset, fps);
  const project = getTemplate(template)?.build(empty) ?? empty;
  await saveProject(project);
  await openProjectById(project.id);
  return project;
}

/**
 * keep a small picture of the preview for the project's card. only in the output view (the scene view
 * shows helper lines) and only when the preview canvas is on screen.
 */
function snapPoster(): void {
  const project = useEditor.getState().project;
  if (!project || useUi.getState().previewMode !== 'output') return;
  if (typeof document === 'undefined') return;
  const canvas = document.querySelector<HTMLCanvasElement>('canvas.preview-canvas');
  if (!canvas) return;
  const poster = capturePoster(canvas);
  if (!poster || savePoster(project.id, poster)) return;
  // it did not fit: the old poster no longer matches the project, so it goes
  const id = project.id;
  deletePoster(id);
  if (!isPoster(poster)) return;
  // storage may be full of posters of deleted projects: drop those and try once more
  void listProjects()
    .then((list) => {
      const known = list.map((p) => p.id);
      pruneOrphanPosters(known);
      // the project may have been deleted while this was waiting: no poster for something that is gone
      if (known.includes(id)) savePoster(id, poster);
    })
    .catch(() => {});
}

/** save and go back to the projects screen */
export async function closeProject(): Promise<void> {
  snapPoster();
  await flushAutosave();
  resetPlayback();
  useEditor.getState().closeProject();
  setSaveState('saved');
  releaseAllAssets();
  releaseAllDerived();
  setHash('');
}

/** a copy failed half way: drop the media blobs already stored under its id. never throws (the original error wins). */
async function discardPartialCopy(projectId: string): Promise<void> {
  try {
    await dbDeleteProject(projectId);
  } catch {
    /* nothing more to do */
  }
}

/** deep copy a stored project including its media blobs. returns the new project id. */
export async function duplicateProject(id: string): Promise<string | null> {
  // media of the open project may still be on its way into the database
  await whenMediaStored();
  const source = await loadProject(id);
  if (!source) return null;
  const now = Date.now();
  const copy: Project = structuredClone(source);
  copy.id = uid('prj');
  copy.name = `${source.name} copy`;
  copy.createdAt = now;
  copy.updatedAt = now;
  const idMap = new Map<string, string>();
  try {
    for (const asset of copy.assets) {
      const newId = uid('ast');
      idMap.set(asset.id, newId);
      const blob = await getMediaBlob(asset.id);
      if (blob) await putMediaBlob(copy.id, newId, blob);
      asset.id = newId;
    }
    for (const clip of copy.clips) {
      if ('assetId' in clip) clip.assetId = idMap.get(clip.assetId) ?? clip.assetId;
    }
    await saveProject(copy);
  } catch (e) {
    await discardPartialCopy(copy.id);
    throw e;
  }
  copyPoster(id, copy.id);
  return copy.id;
}

/** a stored project as one .ncut file (project + media), or null when the project does not exist */
export async function exportProjectFile(id: string): Promise<{ blob: Blob; fileName: string } | null> {
  // the open project may have edits that are not on disk yet
  if (useEditor.getState().project?.id === id) await flushAutosave();
  const project = await loadProject(id);
  if (!project) return null;
  const media = new Map<string, Blob>();
  for (const asset of project.assets) {
    const blob = await getMediaBlob(asset.id);
    if (blob) media.set(asset.id, blob);
  }
  const families = new Set<string>();
  for (const c of project.clips) if (c.type === 'text' && c.fontFamily) families.add(c.fontFamily);
  const fonts = await importedFontFiles(families);
  return { blob: packProject(project, media, fonts), fileName: projectFileName(project.name) };
}

/**
 * add the project inside a .ncut file to this browser as a NEW project (fresh ids, so importing the
 * same file twice gives two projects). returns the new project id. throws with a plain message when
 * the file is not a project.
 */
export async function importProjectFile(file: Blob): Promise<string> {
  const { project: source, media, fonts } = await unpackProject(file);
  // fonts first, so the text looks right the moment the project opens. a failure here never fails the import
  try {
    if (fonts.length > 0) {
      const files = await Promise.all(fonts.map(async (f) => ({ family: f.family, weight: f.weight, italic: f.italic, bytes: await f.blob.arrayBuffer() })));
      await addFontFiles(files);
    }
  } catch {
    /* the text falls back to another font */
  }
  const now = Date.now();
  const copy: Project = structuredClone(source);
  copy.id = uid('prj');
  copy.updatedAt = now;
  const idMap = new Map<string, string>();
  try {
    for (const asset of copy.assets) {
      const newId = uid('ast');
      idMap.set(asset.id, newId);
      const blob = media.get(asset.id);
      if (blob) await putMediaBlob(copy.id, newId, blob);
      asset.id = newId;
    }
    for (const clip of copy.clips) {
      if ('assetId' in clip) clip.assetId = idMap.get(clip.assetId) ?? clip.assetId;
    }
    await saveProject(copy);
  } catch (e) {
    await discardPartialCopy(copy.id);
    throw e;
  }
  return copy.id;
}

export async function renameStoredProject(id: string, name: string): Promise<void> {
  const project = await loadProject(id);
  if (!project) return;
  await saveProject({ ...project, name: name.trim() || project.name, updatedAt: Date.now() });
}

export async function deleteStoredProject(id: string): Promise<void> {
  if (useEditor.getState().project?.id === id) await closeProject();
  await dbDeleteProject(id);
  deletePoster(id);
}

/* ---------- autosave ---------- */

let timer: ReturnType<typeof setTimeout> | null = null;
let dirty: Project | null = null;
let saving: Promise<void> = Promise.resolve();
let pendingSaves = 0;
let lastFailed = false;

function persist(project: Project): Promise<void> {
  pendingSaves++;
  setSaveState('saving');
  saving = saving
    // a saved project never points at imported media that is not stored yet
    .then(() => whenMediaStored())
    .then(() => saveProject({ ...project, updatedAt: Date.now() }))
    .then(() => {
      lastFailed = false;
    })
    .catch((err) => {
      lastFailed = true;
      console.error('autosave failed', err);
      useUi.getState().toast('could not save the project', 'error');
    })
    .finally(() => {
      pendingSaves--;
      if (pendingSaves > 0) return;
      setSaveState(lastFailed ? 'error' : dirty ? 'unsaved' : 'saved');
    });
  return saving;
}

export async function flushAutosave(): Promise<void> {
  // imported files still being copied: a copy that fails takes its asset out of the project, so wait before reading `dirty`
  await whenMediaStored();
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (dirty) {
    const p = dirty;
    dirty = null;
    await persist(p);
  } else {
    await saving;
  }
}

let started = false;

/** call once at startup. saves the open project shortly after every change. */
export function startAutosave(): void {
  if (started) return;
  started = true;
  useEditor.subscribe((state, prev) => {
    if (state.project === prev.project || !state.project) return;
    // opening a project is not a change
    if (!prev.project || prev.project.id !== state.project.id) return;
    dirty = state.project;
    if (pendingSaves === 0) setSaveState('unsaved');
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (dirty) {
        const p = dirty;
        dirty = null;
        void persist(p);
      }
    }, AUTOSAVE_MS);
  });
  window.addEventListener('beforeunload', (e) => {
    if (dirty) void persist(dirty);
    // a running export would be gone: let the browser ask first
    if (busyReason() !== null) e.preventDefault();
  });
  // the desktop shell (electron/main.cjs) calls these before it closes the window
  const shell = window as unknown as { __ncutBusy?: () => string | null; __ncutBeforeClose?: () => Promise<void> };
  shell.__ncutBusy = () => busyReason();
  shell.__ncutBeforeClose = async () => {
    snapPoster();
    await flushAutosave();
  };
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden') return;
    snapPoster();
    void flushAutosave();
  });
}
