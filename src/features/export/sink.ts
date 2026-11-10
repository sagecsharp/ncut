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

async function removeAll(dir: FileSystemDirectoryHandle, keep?: string): Promise<void> {
  const names: string[] = [];
  try {
    for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(name);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === keep) continue;
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
    const handle = await dir.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
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
        // the export before this one has been saved or dropped by now
        void removeAll(dir, name);
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
      },
    };
  } catch {
    return memorySink();
  }
}
