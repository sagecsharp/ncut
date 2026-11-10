/**
 * a web worker that renders and encodes parts of an export (segment.ts). the exporter starts a few of these,
 * hands each the project and the media files once, then one part after the other (parallel.ts).
 * everything here runs without a dom.
 */
import type { Project } from '../../types';
import { beginExport } from '../../engine/exportState';
import { ensureProjectFonts } from '../../lib/fonts';
import { installFontKit } from '../../lib/fontKit';
import { renderSegment } from './segment';
import type { SegmentJob } from './segment';
import type { FromWorker, ToWorker } from './parallel';

const scope = self as unknown as {
  postMessage(message: FromWorker, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<ToWorker>) => void) | null;
};

let project: Project | null = null;
let blobs = new Map<string, Blob>();
const stop = new AbortController();
/** the worker starts taking parts only after the fonts are in */
let ready: Promise<void> = Promise.resolve();

const post = (m: FromWorker, transfer?: Transferable[]) => scope.postMessage(m, transfer ?? []);

async function init(m: Extract<ToWorker, { type: 'init' }>): Promise<void> {
  project = m.project;
  blobs = new Map(m.blobs);
  // the renderer must not use wall clock retry pauses here (see engine/exportState.ts)
  beginExport();
  // text must be drawn in its real font from the first frame: install what the main thread loaded, then ask the
  // same question the main thread asks (never rejects)
  if (m.fontKit) await installFontKit(m.fontKit);
  const missing = await ensureProjectFonts(m.project);
  post({ type: 'ready', missingFonts: missing });
}

async function run(job: SegmentJob): Promise<void> {
  try {
    await ready;
    if (!project) throw new Error('the worker got a part before the project');
    let last = 0;
    const frames = job.to - job.from;
    const result = await renderSegment(project, job, {
      blobOf: (id) => blobs.get(id),
      // an <img> does not exist here: a picture only it can read sends the export back to the main thread
      strictImages: true,
      // the same for a video this worker cannot decode: no file with a clip missing
      strictVideo: true,
      signal: stop.signal,
      onWarning: (message) => post({ type: 'warning', message }),
      onProgress: (done) => {
        const now = performance.now();
        if (now - last < 60 && done < frames) return;
        last = now;
        post({ type: 'progress', id: job.id, frames: done });
      },
      onCapture: async (frame, canvas) => {
        const bitmap = await createImageBitmap(canvas);
        post({ type: 'capture', frame, bitmap }, [bitmap]);
      },
    });
    post({ type: 'done', result }, [result.buffer]);
  } catch (err) {
    post({ type: 'error', id: job.id, message: err instanceof Error ? err.message : String(err) });
  }
}

scope.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') ready = init(m).catch((err) => post({ type: 'error', id: -1, message: err instanceof Error ? err.message : String(err) }));
  else if (m.type === 'segment') void run(m.job);
  else if (m.type === 'cancel') stop.abort();
};
