/**
 * the export an mcp client starts (tool export_video). a job: it answers at once, runs in the background, and its
 * state is read with export_status. one at a time, and never together with the export dialog's own export.
 * the state machine takes its exporter, saver and side effects as deps, so it tests without a browser.
 */
import { clampRange, rangeFrameCount } from '../features/export/range';
import type { TimeRange } from '../features/export/range';
import { exportProject, isAudioContainer, isGifContainer, outputSize } from '../features/export/exporter';
import type { ExportContainer, ExportHooks, ExportOptions, ExportProgress, ExportQuality } from '../features/export/exporter';
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
  const wanted: TimeRange = { start: args.start ?? 0, end: args.end ?? duration };
  const range = clampRange(wanted, duration);
  if (!range) {
    throw new ToolError(
      `the range ${wanted.start} to ${wanted.end} s holds nothing: the project is ${Math.round(duration * 1000) / 1000} s long and start has to be before end`,
    );
  }
  const notes: string[] = [];
  const gif = isGifContainer(container);
  const audioOnly = isAudioContainer(container);
  let fps = args.fps ?? project.fps;
  if (gif && fps > effectiveGifFps(fps)) {
    fps = effectiveGifFps(fps);
    notes.push(`a gif plays at most ${fps} fps, so it is ${fps} fps`);
  }
  if (gif && args.audio === true) notes.push('a gif has no sound, audio was ignored');
  if (audioOnly && args.audio === false) notes.push('an audio file is only sound, audio false was ignored');
  const scale = args.scale ?? 1;
  const size = outputSize(project, scale);
  const options: ExportOptions = {
    container,
    scale,
    fps,
    quality: args.quality ?? 'high',
    includeAudio: !gif && (audioOnly || args.audio !== false),
    range,
  };
  const base = cleanFileName(args.name ?? '', cleanFileName(project.name, 'ncut-export'));
  return {
    options,
    range,
    container,
    width: size.width,
    height: size.height,
    frames: rangeFrameCount(range, fps),
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
  width: number;
  height: number;
  fps: number;
  frames: number;
  seconds: number;
  notes: string[];
}

export interface ExportJob {
  /** begins the export and returns at once. throws ToolError when one runs already or the arguments do not make an export */
  start(project: Project, args: ExportArgs, ticket: number | null): StartInfo;
  status(): JobState;
  /** false when nothing runs */
  cancel(): boolean;
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

  const finish = (next: JobState) => {
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
      // arm the shell first, then start the download it is waiting for
      const saving = deps.save(ticket);
      try {
        deps.download(blob, mcpDownloadName(ticket, planned.fileName));
      } catch (e) {
        void saving.catch(() => {});
        throw e;
      }
      const result = await saving;
      if (!result.ok) return finish({ state: 'failed', message: 'the export finished but the shell could not save the file' });
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
      return {
        status: 'started',
        file: planned.fileName,
        format: planned.container,
        width: planned.width,
        height: planned.height,
        fps: planned.fps,
        frames: planned.frames,
        seconds: Math.round((planned.range.end - planned.range.start) * 1000) / 1000,
        notes: planned.notes,
      };
    },
    status() {
      // the clock of a running job is read now, not at the last progress report
      if (state.state === 'running') return { ...state, seconds: (deps.now() - startedAt) / 1000 };
      return state;
    },
    cancel() {
      if (!live) return false;
      live.ac.abort();
      return true;
    },
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
    setBusy('export', on ? 'an export is still running' : null);
    shell.keepAwake(on);
  },
  progress: (p) => exportProgressToShell(p),
  attention: () => shell.attention(),
  now: () => performance.now(),
};

/** the one export job of the page */
export const mcpExportJob: ExportJob = createExportJob(jobDeps);
