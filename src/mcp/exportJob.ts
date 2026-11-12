/**
 * the export an mcp client starts (tool export_video). a job: it answers at once, runs in the background, and its
 * state is read with export_status. one at a time, and never together with the export dialog's own export.
 * the state machine takes its exporter, saver and side effects as deps, so it tests without a browser.
 */
import { clampRange, rangeFrameCount } from '../features/export/range';
import type { TimeRange } from '../features/export/range';
import { exportProject, isAudioContainer, isGifContainer, outputSize } from '../features/export/exporter';
import type { ExportContainer, ExportHooks, ExportOptions, ExportProgress, ExportQuality } from '../features/export/exporter';
import { isStillContainer, stillSize } from '../features/export/still';
import { effectiveGifFps } from '../lib/gif';
import { isExporting } from '../engine/exportState';
import { setBusy } from '../lib/busy';
import { exportProgressToShell, mcpDownloadName, shell } from '../lib/shell';
import type { McpSaved } from '../lib/shell';
import { projectDuration } from '../lib/timelineOps';
import { usePlayback } from '../store/playback';
import { useEditor } from '../store/editorStore';
import type { Project } from '../types';
import { ToolError } from './helpers';

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export const EXPORT_BUSY = 'an export is already running (the export dialog or an earlier export_video). export_status tells how far it is, export_cancel stops it';

/** what export_video takes (validate.ts already checked the types and enums) */
export interface ExportArgs {
  format?: ExportContainer;
  quality?: ExportQuality;
  scale?: number;
  fps?: number;
  start?: number;
  end?: number;
  audio?: boolean;
  name?: string;
}

/** everything decided from the arguments, before anything runs */
export interface ExportPlanned {
  options: ExportOptions;
  range: TimeRange;
  container: ExportContainer;
  width: number;
  height: number;
  frames: number;
  fps: number;
  fileName: string;
  /** things the client should know about what it asked for (a gif fps cap, audio ignored) */
  notes: string[];
}

/** a file name without characters a file system or the shell's save refuse (same rule as the export dialog) */
export function cleanFileName(name: string, fallback: string): string {
  const s = name
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  if (s.length > 0) return s.slice(0, 80);
  return fallback;
}

/** the part of the arguments that makes the export: defaults, the range, the size, the file name. throws ToolError */
export function planMcpExport(project: Project, args: ExportArgs): ExportPlanned {
  const container: ExportContainer = args.format ?? 'mp4';
  const duration = projectDuration(project);
  if (!(duration > 0)) throw new ToolError('the project is empty, there is nothing to export. add clips first');
  // a picture is the frame at start: it has no end, no frame rate and no sound
  const still = isStillContainer(container);
  const wanted: TimeRange = { start: args.start ?? 0, end: still ? duration : (args.end ?? duration) };
  const range = clampRange(wanted, duration);
  if (!range && still) {
    throw new ToolError(
      `start ${wanted.start} s is not inside the project (${Math.round(duration * 1000) / 1000} s long): a picture is the frame at start, which has to be before the end`,
    );
  }
  if (!range) {
    throw new ToolError(
      `the range ${wanted.start} to ${wanted.end} s holds nothing: the project is ${Math.round(duration * 1000) / 1000} s long and start has to be before end`,
    );
  }
  const notes: string[] = [];
  const cut = (args.start !== undefined && args.start !== range.start) || (!still && args.end !== undefined && args.end !== range.end);
  if (cut) notes.push(`start / end were cut to the project, the part that is exported is ${round3(range.start)} to ${round3(range.end)} s`);
  const gif = isGifContainer(container);
  const audioOnly = isAudioContainer(container);
  let fps = args.fps ?? project.fps;
  if (gif && fps > effectiveGifFps(fps)) {
    fps = effectiveGifFps(fps);
    notes.push(`a gif plays at most ${fps} fps, so it is ${fps} fps`);
  }
  if (gif && args.audio === true) notes.push('a gif has no sound, audio was ignored');
  if (audioOnly && args.audio === false) notes.push('an audio file is only sound, audio false was ignored');
  if (still) {
    fps = project.fps;
    const unused = [args.end !== undefined ? 'end' : '', args.fps !== undefined ? 'fps' : '', args.audio === true ? 'audio' : ''].filter((s) => s !== '');
    if (unused.length > 0) notes.push(`a picture is one frame (the one at start) without sound: ${unused.join(', ')} ${unused.length > 1 ? 'were' : 'was'} ignored`);
    if (container === 'png' && args.quality !== undefined) notes.push('a png has no loss, quality was ignored');
  }
  const scale = args.scale ?? 1;
  const size = still ? stillSize(project, scale) : outputSize(project, scale);
  const options: ExportOptions = {
    container,
    scale,
    fps,
    quality: args.quality ?? 'high',
    includeAudio: !gif && !still && (audioOnly || args.audio !== false),
    range,
  };
  const base = cleanFileName(args.name ?? '', cleanFileName(project.name, 'ncut-export'));
  return {
    options,
    range,
    container,
    width: size.width,
    height: size.height,
    frames: still ? 1 : rangeFrameCount(range, fps),
    fps,
    fileName: `${base}.${container}`,
    notes,
  };
}

export type JobState =
  | { state: 'none' }
  | { state: 'running'; fileName: string; phase: ExportProgress['phase']; progress: number; frame: number; totalFrames: number; seconds: number }
  | {
      state: 'done';
      fileName: string;
      bytes: number;
      seconds: number;
      /** the ticket of the file the shell saved (it adds the full path to the answer), or null */
      saved: number | null;
      /** a plain note: where the file went, or that it only stayed in memory */
      note: string;
      warnings: string[];
    }
  | { state: 'failed'; message: string }
  | { state: 'cancelled' };

/** what the job does besides exporting. the defaults are the real ones (jobDeps), tests hand in fakes */
export interface JobDeps {
  exportFn(project: Project, options: ExportOptions, hooks: ExportHooks): Promise<Blob>;
  /** arm the shell for a ticket: resolves when the file is on disk */
  save(ticket: number): Promise<McpSaved>;
  /** start the download of the blob under this name */
  download(blob: Blob, name: string): void;
  /** the dialog's export, or any other export on this page, runs */
  otherExportRuns(): boolean;
  /** the id of the open project, null when none */
  projectId(): string | null;
  /** the job starts / ends (busy mark, no sleep, pause playback) */
  working(on: boolean): void;
  progress(p: number | null): void;
  attention(): void;
  now(): number;
}

export interface StartInfo {
  status: 'started';
  file: string;
  format: ExportContainer;
  /** not for wav / ogg: a sound file has no picture */
  width?: number;
  height?: number;
  /** not for png / jpg: a picture has no frame rate */
  fps?: number;
  frames?: number;
  /** png / jpg only: the timeline second the picture shows */
  time?: number;
  /** the length of the file (0 for a picture) */
  seconds: number;
  notes: string[];
}

export interface ExportJob {
  /** begins the export and returns at once. throws ToolError when one runs already or the arguments do not make an export */
  start(project: Project, args: ExportArgs, ticket: number | null): StartInfo;
  status(): JobState;
  /** false when nothing runs */
  cancel(): boolean;
  /** the finished file is being handed to the shell: too late to cancel */
  saving(): boolean;
  running(): boolean;
  /** resolves when the current (or last) run has ended, for tests and the dev console */
  settled(): Promise<void>;
  /** without a ticket the file stays here (a browser or dev page has nobody to save it) */
  lastFile(): { name: string; blob: Blob } | null;
}

export function createExportJob(deps: JobDeps): ExportJob {
  let state: JobState = { state: 'none' };
  let live: { ac: AbortController; projectId: string } | null = null;
  let run: Promise<void> = Promise.resolve();
  let file: { name: string; blob: Blob } | null = null;
  let startedAt = 0;
  let saving = false;

  const finish = (next: JobState) => {
    saving = false;
    state = next;
    live = null;
    deps.working(false);
    deps.progress(null);
  };

  async function execute(project: Project, planned: ExportPlanned, ticket: number | null, ac: AbortController, t0: number): Promise<void> {
    const warnings: string[] = [];
    const total = planned.frames;
    const hooks: ExportHooks = {
      signal: ac.signal,
      onWarning: (m) => {
        if (!warnings.includes(m)) warnings.push(m);
      },
      onFallback: () => {
        const m = 'the fast export did not work here, the file was made the slower way';
        if (!warnings.includes(m)) warnings.push(m);
      },
      onProgress: (p) => {
        if (live?.ac !== ac) return;
        // another project was opened: this export is stopped like the dialog's is
        if (deps.projectId() !== live.projectId) ac.abort();
        state = {
          state: 'running',
          fileName: planned.fileName,
          phase: p.phase,
          progress: p.progress,
          frame: p.frame,
          totalFrames: p.totalFrames || total,
          seconds: (deps.now() - t0) / 1000,
        };
        deps.progress(p.progress);
      },
    };
    try {
      const blob = await deps.exportFn(project, planned.options, hooks);
      if (ac.signal.aborted) return finish({ state: 'cancelled' });
      const seconds = (deps.now() - t0) / 1000;
      if (ticket === null) {
        file = { name: planned.fileName, blob };
        deps.attention();
        return finish({
          state: 'done',
          fileName: planned.fileName,
          bytes: blob.size,
          seconds,
          saved: null,
          note: 'not written to disk: there is no desktop shell here, the file stays in memory',
          warnings,
        });
      }
      // from here on the file is on its way to disk, a cancel can not stop that
      saving = true;
      // arm the shell first, then start the download it is waiting for
      const armed = deps.save(ticket);
      try {
        deps.download(blob, mcpDownloadName(ticket, planned.fileName));
      } catch (e) {
        void armed.catch(() => {});
        throw e;
      }
      const result = await armed;
      if (!result.ok) {
        // the render is not thrown away: a plain download makes the app ask the user where to put it
        file = { name: planned.fileName, blob };
        deps.download(blob, planned.fileName);
        deps.attention();
        return finish({
          state: 'done',
          fileName: planned.fileName,
          bytes: blob.size,
          seconds,
          saved: null,
          note: 'the shell could not save the file by itself, so the app asked the user where to save it. there is no known path, do not assume one',
          warnings,
        });
      }
      deps.attention();
      finish({
        state: 'done',
        fileName: result.name ?? planned.fileName,
        bytes: blob.size,
        seconds,
        saved: ticket,
        note: 'saved to the save folder',
        warnings,
      });
    } catch (e) {
      if (ac.signal.aborted || (e instanceof DOMException && e.name === 'AbortError')) return finish({ state: 'cancelled' });
      finish({ state: 'failed', message: e instanceof Error ? e.message : 'export failed' });
    }
  }

  return {
    start(project, args, ticket) {
      if (live || deps.otherExportRuns()) throw new ToolError(EXPORT_BUSY);
      const planned = planMcpExport(project, args);
      const ac = new AbortController();
      const t0 = deps.now();
      startedAt = t0;
      live = { ac, projectId: project.id };
      file = null;
      state = {
        state: 'running',
        fileName: planned.fileName,
        phase: 'audio',
        progress: 0,
        frame: 0,
        totalFrames: planned.frames,
        seconds: 0,
      };
      deps.working(true);
      run = execute(project, planned, ticket, ac, t0);
      const picture = isAudioContainer(planned.container)
        ? {}
        : isStillContainer(planned.container)
          ? { width: planned.width, height: planned.height, frames: 1, time: round3(planned.range.start) }
          : { width: planned.width, height: planned.height, fps: planned.fps, frames: planned.frames };
      return {
        status: 'started',
        file: planned.fileName,
        format: planned.container,
        ...picture,
        seconds: isStillContainer(planned.container) ? 0 : round3(planned.range.end - planned.range.start),
        notes: planned.notes,
      };
    },
    status() {
      // the clock of a running job is read now, not at the last progress report
      if (state.state === 'running') return { ...state, seconds: (deps.now() - startedAt) / 1000 };
      return state;
    },
    cancel() {
      if (!live || saving) return false;
      live.ac.abort();
      return true;
    },
    saving: () => saving,
    running: () => live !== null,
    settled: () => run,
    lastFile: () => file,
  };
}

// ---- the real one ----

function anchorDownload(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // the download has taken the blob by now, the shell waits for it on its own
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const jobDeps: JobDeps = {
  exportFn: exportProject,
  save: (ticket) => shell.mcp.save(ticket),
  download: anchorDownload,
  otherExportRuns: () => isExporting(),
  projectId: () => useEditor.getState().project?.id ?? null,
  working(on) {
    // closing the window asks first, the machine stays awake, playback stops (like the dialog's export)
    if (on) usePlayback.getState().pause();
    // its own key: the dialog's export clears 'export' when it ends
    setBusy('mcp-export', on ? 'an export is still running' : null);
    shell.keepAwake(on);
  },
  progress: (p) => exportProgressToShell(p),
  attention: () => shell.attention(),
  now: () => performance.now(),
};

/** the one export job of the page */
export const mcpExportJob: ExportJob = createExportJob(jobDeps);
