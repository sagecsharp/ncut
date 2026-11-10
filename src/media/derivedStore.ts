/**
 * persistent cache for thumbnails and waveform peaks, in its own small indexeddb database
 * ('ncut-derived', separate from the app's main database). assets never change after import (same id =
 * same bytes), so a value computed once is valid for good. the cache can only be missing, never wrong:
 * every failure (no indexeddb, quota, private mode, timeout) just means "not cached" and callers compute
 * the value like before.
 */
import { MAX_AGE_MS, MAX_TOTAL_BYTES, needsTouch, planCleanup } from './derivedCachePlan';
import type { CacheEntryInfo } from './derivedCachePlan';

const DB_NAME = 'ncut-derived';
const DB_VERSION = 1;
const STORE = 'entries';
/** a lookup that takes longer than this counts as a miss */
const LOOKUP_TIMEOUT_MS = 1500;

interface Row {
  key: string;
  blob?: Blob;
  peaks?: Float32Array;
  bytes: number;
  usedAt: number;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;
let cleanupScheduled = false;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'key' });
          store.createIndex('usedAt', 'usedAt', { unique: false });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => {
          db.close();
          dbPromise = Promise.resolve(null);
        };
        resolve(db);
        scheduleCleanup();
      };
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function readRow(key: string): Promise<Row | null> {
  const db = await openDb();
  if (!db) return null;
  try {
    const tx = db.transaction(STORE, 'readonly');
    const row = (await request(tx.objectStore(STORE).get(key))) as Row | undefined;
    if (!row) return null;
    if (needsTouch(row.usedAt, Date.now())) void touch(row);
    return row;
  } catch {
    return null;
  }
}

async function touch(row: Row): Promise<void> {
  try {
    const db = await openDb();
    if (!db) return;
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({ ...row, usedAt: Date.now() });
    await txDone(tx);
  } catch {
    /* a missed touch only makes the entry older */
  }
}

async function writeRow(row: Row): Promise<void> {
  try {
    const db = await openDb();
    if (!db) return;
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(row);
    await txDone(tx);
  } catch {
    /* quota, private mode...: not cached, nothing else changes */
  }
}

function withTimeout<T>(p: Promise<T | null>): Promise<T | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), LOOKUP_TIMEOUT_MS);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(null);
      },
    );
  });
}

/** the encoded thumbnail stored under `key`, or null */
export function getCachedBlob(key: string): Promise<Blob | null> {
  return withTimeout(readRow(key).then((r) => (r && r.blob instanceof Blob && r.blob.size > 0 ? r.blob : null)));
}

/** the waveform peaks stored under `key`, or null (structured clone: a fresh array each time) */
export function getCachedPeaks(key: string): Promise<Float32Array | null> {
  return withTimeout(
    readRow(key).then((r) => (r && r.peaks instanceof Float32Array && r.peaks.length > 0 ? r.peaks : null)),
  );
}

/** fire and forget */
export function putCachedBlob(key: string, blob: Blob): void {
  if (blob.size <= 0) return;
  void writeRow({ key, blob, bytes: blob.size, usedAt: Date.now() });
}

/** fire and forget. stores its own copy of the peaks. */
export function putCachedPeaks(key: string, peaks: Float32Array): void {
  if (peaks.length <= 0) return;
  const copy = peaks.slice();
  void writeRow({ key, peaks: copy, bytes: copy.byteLength, usedAt: Date.now() });
}

/* ---------- cleanup: once per session, in idle time ---------- */

function scheduleCleanup(): void {
  if (cleanupScheduled) return;
  cleanupScheduled = true;
  const run = () => void cleanup();
  const w = globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
  if (typeof w.requestIdleCallback === 'function') w.requestIdleCallback(run, { timeout: 15000 });
  else setTimeout(run, 5000);
}

async function cleanup(): Promise<void> {
  try {
    const db = await openDb();
    if (!db) return;
    const infos: CacheEntryInfo[] = [];
    const tx = db.transaction(STORE, 'readonly');
    await new Promise<void>((resolve, reject) => {
      const cur = tx.objectStore(STORE).openCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c) return resolve();
        const v = c.value as Partial<Row>;
        infos.push({
          key: String(c.key),
          bytes: typeof v.bytes === 'number' ? v.bytes : 0,
          usedAt: typeof v.usedAt === 'number' ? v.usedAt : NaN,
        });
        c.continue();
      };
      cur.onerror = () => reject(cur.error);
    });
    const drop = planCleanup(infos, Date.now(), MAX_AGE_MS, MAX_TOTAL_BYTES);
    if (drop.length === 0) return;
    const wtx = db.transaction(STORE, 'readwrite');
    const store = wtx.objectStore(STORE);
    for (const k of drop) store.delete(k);
    await txDone(wtx);
  } catch {
    /* next session tries again */
  }
}
