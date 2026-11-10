/**
 * opening / closing / creating projects, url routing (#/project/<id>) and autosave.
 * the glue between the pure editor store and indexeddb.
 */
import type { Project } from '../types';
import type { CanvasPreset } from '../lib/factory';
import { createProject } from '../lib/factory';
import { uid } from '../lib/id';
import { loadProjectMedia, releaseAllAssets } from '../media/registry';
import { deleteProject as dbDeleteProject, getMediaBlob, loadProject, putMediaBlob, saveProject } from '../storage/db';
import { useEditor } from './editorStore';
import { resetPlayback } from './playback';
import { useUi } from './ui';

const AUTOSAVE_MS = 600;

export function projectIdFromHash(hash = location.hash): string | null {
  const m = /^#\/project\/([\w-]+)/.exec(hash);
  return m ? m[1]! : null;
}

function setHash(hash: string): void {
  if (location.hash !== hash) history.pushState(null, '', hash || location.pathname + location.search);
}

/** load a project + its media from indexeddb and open it in the editor. false when not found. */
export async function openProjectById(id: string): Promise<boolean> {
  const project = await loadProject(id);
  if (!project) return false;
  await flushAutosave();
  releaseAllAssets();
  resetPlayback();
  const missing = await loadProjectMedia(project);
  useEditor.getState().openProject(project);
  setHash(`#/project/${project.id}`);
  if (missing.length > 0) {
    useUi.getState().toast(`${missing.length} media file(s) could not be loaded`, 'error');
  }
  return true;
}

export async function createAndOpenProject(name?: string, preset?: CanvasPreset, fps?: number): Promise<Project> {
  const project = createProject(name, preset, fps);
  await saveProject(project);
  await openProjectById(project.id);
  return project;
}

/** save and go back to the projects screen */
export async function closeProject(): Promise<void> {
  await flushAutosave();
  resetPlayback();
  useEditor.getState().closeProject();
  releaseAllAssets();
  setHash('');
}

/** deep copy a stored project including its media blobs. returns the new project id. */
export async function duplicateProject(id: string): Promise<string | null> {
  const source = await loadProject(id);
  if (!source) return null;
  const now = Date.now();
  const copy: Project = structuredClone(source);
  copy.id = uid('prj');
  copy.name = `${source.name} copy`;
  copy.createdAt = now;
  copy.updatedAt = now;
  const idMap = new Map<string, string>();
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
}

/* ---------- autosave ---------- */

let timer: ReturnType<typeof setTimeout> | null = null;
let dirty: Project | null = null;
let saving: Promise<void> = Promise.resolve();

function persist(project: Project): Promise<void> {
  saving = saving
    .then(() => saveProject({ ...project, updatedAt: Date.now() }))
    .catch((err) => {
      console.error('autosave failed', err);
      useUi.getState().toast('could not save the project', 'error');
    });
  return saving;
}

export async function flushAutosave(): Promise<void> {
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
  window.addEventListener('beforeunload', () => {
    if (dirty) void persist(dirty);
  });
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flushAutosave();
  });
}
