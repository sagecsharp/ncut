/**
 * indexeddb persistence. everything stays on this machine.
 *  - 'projects': Project json, keyed by id
 *  - 'media':    { id: assetId, projectId, blob } imported files, keyed by asset id
 */
import type { Project, ProjectSummary } from '../types';
import { projectDuration } from '../lib/timelineOps';
import { pruneSummaries, sortSummaries, readSummary, removeSummary, writeSummary, writeSummaryIfMissing } from './summaries';

const DB_NAME = 'ncut';
const DB_VERSION = 1;
const PROJECTS = 'projects';
const MEDIA = 'media';

interface MediaRow {
  id: string;
  projectId: string;
  blob: Blob;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(PROJECTS)) db.createObjectStore(PROJECTS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(MEDIA)) {
        const store = db.createObjectStore(MEDIA, { keyPath: 'id' });
        store.createIndex('projectId', 'projectId', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error ?? new Error('could not open the local database'));
    };
  });
  return dbPromise;
}

function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });
}

export function summarize(p: Project): ProjectSummary {
  return {
    id: p.id,
    name: p.name,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    width: p.width,
    height: p.height,
    fps: p.fps,
    duration: projectDuration(p),
    clipCount: p.clips.length,
  };
}

export async function saveProject(project: Project): Promise<void> {
  // the card summary goes before the write and comes back after it committed: it can never describe an older project
  const summary = summarize(project);
  removeSummary(project.id);
  const db = await openDb();
  const tx = db.transaction(PROJECTS, 'readwrite');
  tx.objectStore(PROJECTS).put(project);
  await txDone(tx);
  writeSummary(summary);
}

export async function loadProject(id: string): Promise<Project | undefined> {
  const db = await openDb();
  return done<Project | undefined>(db.transaction(PROJECTS).objectStore(PROJECTS).get(id));
}

/**
 * newest first. the cards come from the small per-project summaries (see summaries.ts); only a project without
 * a valid summary is read whole (and gets one).
 */
export async function listProjects(): Promise<ProjectSummary[]> {
  const db = await openDb();
  const ids = (await done<IDBValidKey[]>(db.transaction(PROJECTS).objectStore(PROJECTS).getAllKeys())).filter(
    (k): k is string => typeof k === 'string',
  );
  const out: ProjectSummary[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    const s = readSummary(id);
    if (s) out.push(s);
    else missing.push(id);
  }
  if (missing.length > 0) {
    const store = db.transaction(PROJECTS).objectStore(PROJECTS);
    const loaded = await Promise.all(missing.map((id) => done<Project | undefined>(store.get(id))));
    for (const p of loaded) {
      if (!p) continue;
      const s = summarize(p);
      out.push(s);
      writeSummaryIfMissing(s);
    }
  }
  pruneSummaries(ids);
  return sortSummaries(out);
}

/** deletes the project and all of its media blobs */
export async function deleteProject(id: string): Promise<void> {
  removeSummary(id);
  const db = await openDb();
  const tx = db.transaction([PROJECTS, MEDIA], 'readwrite');
  tx.objectStore(PROJECTS).delete(id);
  const index = tx.objectStore(MEDIA).index('projectId');
  const cursorReq = index.openKeyCursor(IDBKeyRange.only(id));
  cursorReq.onsuccess = () => {
    const cursor = cursorReq.result;
    if (!cursor) return;
    tx.objectStore(MEDIA).delete(cursor.primaryKey);
    cursor.continue();
  };
  await txDone(tx);
  removeSummary(id);
}

export async function putMediaBlob(projectId: string, assetId: string, blob: Blob): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(MEDIA, 'readwrite');
  const row: MediaRow = { id: assetId, projectId, blob };
  tx.objectStore(MEDIA).put(row);
  await txDone(tx);
}

export async function getMediaBlob(assetId: string): Promise<Blob | undefined> {
  const db = await openDb();
  const row = await done<MediaRow | undefined>(db.transaction(MEDIA).objectStore(MEDIA).get(assetId));
  return row?.blob;
}

export async function deleteMediaBlob(assetId: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(MEDIA, 'readwrite');
  tx.objectStore(MEDIA).delete(assetId);
  await txDone(tx);
}
