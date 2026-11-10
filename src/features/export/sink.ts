/**
 * where the bytes of an export go while it is written.
 *
 * small files are built in memory, as always. a big one (ten minutes of 4k is several gigabytes) used to be built
 * in memory too: one array that has to grow and be copied again and again, and that the browser may refuse past a
 * few gigabytes, after minutes of rendering. such a file is now written to the origin private file system (a
 * folder of the browser's profile on disk, the same in the desktop app) while it is made. what comes out is a
 * blob that lives on disk: the preview, the download and the save dialog read it like any other blob.
 */
import { BufferTarget, StreamTarget } from 'mediabunny';
import type { StreamTargetChunk, Target } from 'mediabunny';

/** exports expected to be at least this big are written to disk */
export const DISK_MIN_BYTES = 256 * 1024 * 1024;
/** free space wanted per byte of the file: the browser writes into a swap file first and swaps it in at the end */
export const DISK_HEADROOM = 2.5;
const FOLDER = 'ncut-exports';

export interface ExportSink {
  target: Target;
  /** true = the bytes go to disk as they are written */
  onDisk: boolean;
  /** after the output is finalized: the file. a sink on disk forgets the older export files here. */
  finish(mime: string): Promise<Blob>;
  /** the export failed or was cancelled: let go of what was written */
  discard(): Promise<void>;
}

/** bytes a video export will be about: the bitrates times the length (encoders stay within half and double of it) */
export function expectedExportBytes(videoBitrate: number, audioBitrate: number, seconds: number): number {
  return Math.max(0, Math.round(((videoBitrate + audioBitrate) * Math.max(0, seconds)) / 8));
}

/** whether an export of that size should be written to disk, given what the browser says is free there */
export function wantsDisk(expectedBytes: number, freeBytes: number | null, minBytes = DISK_MIN_BYTES): boolean {
  if (!(expectedBytes >= minBytes)) return false;
  // no number from the browser: try, the memory way is still there when opening the file fails
  if (freeBytes === null) return true;
  return freeBytes >= expectedBytes * DISK_HEADROOM;
}

function memorySink(): ExportSink {
  const target = new BufferTarget();
  return {
    target,
    onDisk: false,
    finish: async (mime) => {
      const buffer = target.buffer;
      if (!buffer) throw new Error('the encoder produced no data');
      return new Blob([buffer], { type: mime });
    },
    discard: async () => undefined,
  };
}

async function exportFolder(): Promise<FileSystemDirectoryHandle | null> {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return null;
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(FOLDER, { create: true });
  } catch {
    return null;
  }
}

/** the name of the web lock a page holds while it owns an export file */
export function lockName(file: string): string {
  return `ncut-export:${file}`;
}

/** the export file a folder entry belongs to: the swap file of the browser (`<name>.crswap`) belongs to `<name>` */
export function fileOfEntry(entryName: string): string {
  return entryName.endsWith('.crswap') ? entryName.slice(0, -'.crswap'.length) : entryName;
}

/** whether the cleanup may remove a folder entry: not the file to keep, not one that some page holds a lock for */
export function mayRemove(entryName: string, keep: string | undefined, heldLockNames: ReadonlySet<string>): boolean {
  const file = fileOfEntry(entryName);
  if (file === keep || entryName === keep) return false;
  return !heldLockNames.has(lockName(file));
}

/** the export files this page owns, with the function that lets go of the lock on each */
const owned = new Map<string, () => void>();

/**
 * hold the lock on an export file until the returned function is called (or the page ends: the browser drops locks
 * of closed and crashed pages, so their files are cleaned up at the next start). without web locks it does nothing.
 */
function holdLock(file: string): () => void {
  let release = (): void => undefined;
  try {
    if (typeof navigator === 'undefined' || !navigator.locks) return release;
    const until = new Promise<void>((resolve) => {
      release = resolve;
    });
    navigator.locks.request(lockName(file), () => until).catch(() => undefined);
  } catch {
    // no lock: the cleanup then works as it did before
  }
  return release;
}

/** this page lets go of the locks on all its export files except `keep` (they are removed next) */
function releaseOwned(keep?: string): Set<string> {
  const released = new Set<string>();
  for (const [file, release] of owned) {
    if (file === keep) continue;
    owned.delete(file);
    release();
    released.add(lockName(file));
  }
  return released;
}

/** the names of the locks held right now by any page; null when the browser has no web locks */
async function heldLocks(ignore: ReadonlySet<string>): Promise<Set<string> | null> {
  try {
    if (typeof navigator === 'undefined' || !navigator.locks) return null;
    const state = await navigator.locks.query();
    const held = new Set<string>();
    for (const lock of state.held ?? []) {
      // a lock this page just let go of may still be listed
      if (lock.name && !ignore.has(lock.name)) held.add(lock.name);
    }
    return held;
  } catch {
    return null;
  }
}

async function removeAll(dir: FileSystemDirectoryHandle, keep?: string, released: ReadonlySet<string> = new Set()): Promise<void> {
  const names: string[] = [];
  try {
    for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(name);
  } catch {
    return;
  }
  // a file another tab or window is writing, or has not saved yet, is not ours to remove
  const held = (await heldLocks(released)) ?? new Set<string>();
  for (const name of names) {
    if (!mayRemove(name, keep, held)) continue;
    try {
      await dir.removeEntry(name);
    } catch {
      // still open somewhere: the next start of the app takes it
    }
  }
}

let cleaned = false;
/** export files of earlier runs of the app are of no use to anyone: remove them, once */
export async function forgetOldExports(): Promise<void> {
  if (cleaned) return;
  cleaned = true;
  const dir = await exportFolder();
  if (dir) await removeAll(dir);
}

let counter = 0;

/**
 * the sink for an export of about `expectedBytes`. `minBytes` is the size from which the disk is used (tests pass
 * 0). anything that goes wrong with the disk gives the memory sink.
 */
export async function openExportSink(expectedBytes: number, extension: string, minBytes = DISK_MIN_BYTES): Promise<ExportSink> {
  if (!(expectedBytes >= minBytes)) return memorySink();
  try {
    await forgetOldExports();
    let free: number | null = null;
    try {
      const e = await navigator.storage.estimate();
      if (typeof e.quota === 'number' && typeof e.usage === 'number') free = e.quota - e.usage;
    } catch {
      free = null;
    }
    if (!wantsDisk(expectedBytes, free, minBytes)) return memorySink();
    const dir = await exportFolder();
    if (!dir) return memorySink();
    const name = `export-${Date.now().toString(36)}-${counter++}.${extension}`;
    // owned from here until this page removes the file
    owned.set(name, holdLock(name));
    let handle: FileSystemFileHandle;
    let writable: FileSystemWritableFileStream;
    try {
      handle = await dir.getFileHandle(name, { create: true });
      writable = await handle.createWritable();
    } catch (e) {
      owned.get(name)?.();
      owned.delete(name);
      throw e;
    }
    let open = true;
    const target = new StreamTarget(writable as unknown as WritableStream<StreamTargetChunk>, { chunked: true });
    return {
      target,
      onDisk: true,
      finish: async (mime) => {
        // the output closed the stream when it was finalized, which put the file in place
        open = false;
        const file = await handle.getFile();
        if (file.size === 0) throw new Error('the encoder produced no data');
        // the export before this one has been saved or dropped by now, this page lets go of its lock
        void removeAll(dir, name, releaseOwned(name));
        return file.slice(0, file.size, mime);
      },
      discard: async () => {
        if (open) {
          open = false;
          try {
            await writable.abort();
          } catch {
            // already closed or aborted by the output
          }
        }
        try {
          await dir.removeEntry(name);
        } catch {
          // ignore
        }
        // when the abort was refused the browser still keeps the data in the swap file
        try {
          await dir.removeEntry(`${name}.crswap`);
        } catch {
          // ignore
        }
        owned.get(name)?.();
        owned.delete(name);
      },
    };
  } catch {
    return memorySink();
  }
}
