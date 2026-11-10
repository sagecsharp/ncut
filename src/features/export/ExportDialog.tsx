import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, FolderOpen, X } from 'lucide-react';
import { exportProgressToShell, shell } from '../../lib/shell';
import { Dialog } from '../../components/ui/Dialog';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { FPS_OPTIONS } from '../../lib/factory';
import { EXPORT_PRESETS, matchingPreset, presetChoices } from './presets';
import type { ExportPreset } from './presets';
import { formatBytes, formatDuration } from '../../lib/time';
import { projectDuration } from '../../lib/timelineOps';
import { CODEC_LABEL, exportProject, isAudioContainer, isGifContainer, outputSize, planExport } from './exporter';
import { createPlanMemo, probeDelay } from './planMemo';
import type { ExportContainer, ExportPlan, ExportProgress, ExportQuality, VideoContainer } from './exporter';
import { markerRange, rangeFrameCount, resolveRange } from './range';
import type { RangeMode } from './range';
import {
  GIF_DEFAULT_FPS,
  GIF_DEFAULT_SCALE,
  GIF_FPS_OPTIONS,
  estimateGifBytes,
  gifExportFps,
  gifFpsNote,
  gifSizeWarning,
} from './gifPlan';
import { loadExportSettings, saveExportSettings } from './settings';
import { setBusy } from '../../lib/busy';
import './export.css';

export interface ExportDialogProps {
  open: boolean;
  onClose: () => void;
}

type Phase = 'setup' | 'exporting' | 'done' | 'error';

interface DoneInfo {
  url: string;
  size: number;
  seconds: number;
  fileName: string;
  warnings: string[];
}

const SCALES = [
  { value: 1, label: '100%' },
  { value: 0.75, label: '75%' },
  { value: 0.5, label: '50%' },
];
const QUALITIES: ExportQuality[] = ['low', 'medium', 'high'];
/** wait this long after the last settings change before asking the browser what it can encode */
const PROBE_DEBOUNCE_MS = 250;

/** what the browser can encode for the current settings: undefined = still probing, null = nothing */
type Plans = Record<VideoContainer, ExportPlan | null | undefined>;
const PROBING: Plans = { mp4: undefined, webm: undefined };
/** what the browser said it can encode, for the session (planMemo.ts) */
const planMemo = createPlanMemo();

function formatBitrate(bps: number): string {
  return bps >= 1e6 ? `${(bps / 1e6).toFixed(bps >= 1e7 ? 0 : 1)} mbps` : `${Math.round(bps / 1e3)} kbps`;
}

function sanitizeName(name: string): string {
  const s = name
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  return s.length > 0 ? s.slice(0, 80) : 'ncut-export';
}

function formatClock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** frame rate + resolution are remembered apart for gif and for video */
type PrefGroup = 'gif' | 'video';
function groupOf(c: ExportContainer): PrefGroup | null {
  return c === 'gif' ? 'gif' : c === 'mp4' || c === 'webm' ? 'video' : null;
}

const PHASE_TEXT: Record<ExportProgress['phase'], string> = {
  audio: 'mixing audio',
  palette: 'choosing colors',
  video: 'rendering frames',
  finalizing: 'finalizing file',
};

/** mounted always by the editor, so it must not subscribe to the project while closed */
export function ExportDialog({ open, onClose }: ExportDialogProps) {
  if (!open) return null;
  return <ExportDialogInner open onClose={onClose} />;
}

function ExportDialogInner({ open, onClose }: ExportDialogProps) {
  const project = useEditor((s) => s.project);

  const [phase, setPhase] = useState<Phase>('setup');
  const [fileName, setFileName] = useState('');
  // the last used choices come back (the dialog mounts fresh every time it opens)
  const [saved] = useState(loadExportSettings);
  const [container, setContainer] = useState<ExportContainer>(saved.container ?? 'mp4');
  const [scale, setScale] = useState(saved.container === 'gif' ? (saved.gif?.scale ?? GIF_DEFAULT_SCALE) : (saved.scale ?? 1));
  const [fps, setFps] = useState(30);
  const [quality, setQuality] = useState<ExportQuality>(saved.quality ?? 'medium');
  const [includeAudio, setIncludeAudio] = useState(true);
  const [plans, setPlans] = useState<Plans>(PROBING);
  const [rangeMode, setRangeMode] = useState<RangeMode>('all');
  const [rangeFrom, setRangeFrom] = useState('0');
  const [rangeTo, setRangeTo] = useState('');

  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [done, setDone] = useState<DoneInfo | null>(null);
  const [error, setError] = useState('');
  /** desktop app: the name the last export was saved under (the folder is known only to the shell) */
  const [savedName, setSavedName] = useState<string | null>(null);

  // frame rate + resolution of the group (gif / video) that is not showing right now
  const groupRef = useRef<PrefGroup>(groupOf(saved.container ?? 'mp4') ?? 'video');
  const stashRef = useRef<Record<PrefGroup, { fps?: number; scale?: number }>>({
    gif: { fps: saved.gif?.fps ?? GIF_DEFAULT_FPS, scale: saved.gif?.scale ?? GIF_DEFAULT_SCALE },
    video: { fps: saved.fps, scale: saved.scale ?? 1 },
  });
  const abortRef = useRef<AbortController | null>(null);
  const lastProbeRef = useRef(Number.NEGATIVE_INFINITY);
  const startRef = useRef(0);
  const lastUiRef = useRef(0);
  const doneUrlRef = useRef<string | null>(null);

  const revokeUrl = useCallback(() => {
    if (doneUrlRef.current) {
      URL.revokeObjectURL(doneUrlRef.current);
      doneUrlRef.current = null;
    }
  }, []);

  // reset and probe whenever the dialog opens
  const projectId = project?.id;
  const projectName = project?.name ?? '';
  const projectFps = project?.fps ?? 30;
  const projectW = project?.width ?? 0;
  const projectH = project?.height ?? 0;
  useEffect(() => {
    // another project was opened (or the dialog closed) while an export runs: that export is stopped, and since
    // abortRef is cleared nothing it says afterwards (result, error, progress) may touch the dialog again
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
      setPhase('setup');
    }
    if (!open) return;
    setPhase('setup');
    setFileName(sanitizeName(projectName));
    const first = groupOf(container) ?? groupRef.current;
    if (first === 'gif') setFps(saved.gif?.fps ?? GIF_DEFAULT_FPS);
    else setFps(saved.fps !== undefined && (FPS_OPTIONS as readonly number[]).includes(saved.fps) ? saved.fps : projectFps);
    setProgress(null);
    setDone(null);
    setError('');
    setRangeMode('all');
    setRangeFrom('0');
    setRangeTo('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, projectId]);

  // ask the browser what it can encode for the chosen size + fps + quality (debounced, cancelled by the next change)
  useEffect(() => {
    if (!open || phase !== 'setup' || projectW <= 0 || isAudioContainer(container) || isGifContainer(container)) return;
    const videoContainer: VideoContainer = container;
    const size = outputSize({ width: projectW, height: projectH }, scale);
    const ask = (c: VideoContainer) => ({ container: c, width: size.width, height: size.height, fps, quality });
    // asked before in this session: the answer is there at once (undefined = still asking)
    const known: Plans = { mp4: planMemo.get(ask('mp4')), webm: planMemo.get(ask('webm')) };
    setPlans(known);
    if (known.mp4 && known.webm) return;
    const ac = new AbortController();
    // right away when the dialog just opened or after one click, debounced while a number is typed or dragged
    const delay = probeDelay(performance.now() - lastProbeRef.current, PROBE_DEBOUNCE_MS);
    lastProbeRef.current = performance.now();
    const timer = window.setTimeout(() => {
      void (async () => {
        const next: Plans = { mp4: null, webm: null };
        try {
          for (const c of [videoContainer, videoContainer === 'mp4' ? 'webm' : 'mp4'] as const) {
            next[c] = known[c] ?? (await planExport(ask(c), ac.signal));
            planMemo.put(ask(c), next[c]);
          }
        } catch {
          return; // cancelled
        }
        if (!ac.signal.aborted) setPlans(next);
      })();
    }, delay);
    return () => {
      window.clearTimeout(timer);
      ac.abort();
    };
  }, [open, phase, projectW, projectH, container, scale, fps, quality]);

  // closing the dialog (or unmounting) frees the result and stops a running export
  useEffect(() => {
    if (open) return;
    revokeUrl();
  }, [open, revokeUrl]);
  useEffect(
    () => () => {
      abortRef.current?.abort();
      revokeUrl();
    },
    [revokeUrl],
  );

  // closing the tab / the desktop window asks first while an export runs
  useEffect(() => {
    if (phase !== 'exporting') return;
    setBusy('export', 'an export is still running');
    return () => setBusy('export', null);
  }, [phase]);

  // desktop app: taskbar progress, no sleep while exporting, and the name a finished file was saved under
  useEffect(() => {
    if (phase !== 'exporting') return;
    shell.keepAwake(true);
    return () => {
      shell.keepAwake(false);
      exportProgressToShell(null);
    };
  }, [phase]);
  useEffect(() => shell.onSaved((name) => setSavedName(name)), []);

  // elapsed clock while exporting (2 ticks per second, not per frame)
  useEffect(() => {
    if (phase !== 'exporting') return;
    const id = window.setInterval(() => setElapsed((performance.now() - startRef.current) / 1000), 500);
    return () => window.clearInterval(id);
  }, [phase]);

  const isGif = container === 'gif';
  const fpsChoices = useMemo(() => {
    const set = new Set<number>(isGif ? GIF_FPS_OPTIONS : FPS_OPTIONS);
    if (isGif) set.add(Math.min(50, fps));
    else set.add(projectFps);
    return [...set].sort((a, b) => a - b);
  }, [projectFps, isGif, fps]);

  // switching between gif and video swaps the frame rate + resolution, so neither overwrites the other
  const changeContainer = useCallback(
    (next: ExportContainer) => {
      const to = groupOf(next);
      const from = groupRef.current;
      if (to && to !== from) {
        stashRef.current[from] = { fps, scale };
        const got = stashRef.current[to];
        setFps(got.fps ?? (to === 'gif' ? GIF_DEFAULT_FPS : projectFps));
        setScale(got.scale ?? (to === 'gif' ? GIF_DEFAULT_SCALE : 1));
        groupRef.current = to;
      }
      setContainer(next);
    },
    [fps, scale, projectFps],
  );

  // a preset fills in format / quality / frame rate / size in one click. everything stays editable.
  const applyPreset = useCallback(
    (preset: ExportPreset) => {
      const c = presetChoices(preset, projectFps);
      const to = groupOf(c.container);
      const from = groupRef.current;
      if (to && to !== from) {
        stashRef.current[from] = { fps, scale };
        groupRef.current = to;
      }
      setContainer(c.container);
      setQuality(c.quality);
      setFps(c.fps);
      setScale(c.scale);
    },
    [fps, scale, projectFps],
  );
  const activePreset = matchingPreset({ container, quality, fps, scale }, projectFps);

  const projectLength = project ? projectDuration(project) : 0;
  const markers = project?.markers;
  const hasMarkerRange = markerRange(markers) !== null;
  // a marker choice that stopped being possible (a marker was removed) falls back to the whole project
  const mode: RangeMode = rangeMode === 'markers' && !hasMarkerRange ? 'all' : rangeMode;
  const customStart = Number.parseFloat(rangeFrom);
  const customEnd = rangeTo.trim() === '' ? projectLength : Number.parseFloat(rangeTo);
  const range = useMemo(
    () => resolveRange(mode, projectLength, markers, { start: customStart, end: customEnd }),
    [mode, projectLength, markers, customStart, customEnd],
  );
  const audioOnly = isAudioContainer(container);
  const empty = !project || projectLength <= 0;
  const duration = range ? range.end - range.start : 0;
  // a gif cannot play faster than 50 fps
  const effFps = isGif ? gifExportFps(fps) : fps;
  const totalFrames = range ? rangeFrameCount(range, effFps) : 0;

  const triggerDownload = useCallback((url: string, name: string) => {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, []);

  const start = useCallback(async () => {
    if (!project || phase === 'exporting' || !range) return;
    usePlayback.getState().pause();
    revokeUrl();
    const ac = new AbortController();
    abortRef.current = ac;
    const warnings: string[] = [];
    startRef.current = performance.now();
    lastUiRef.current = 0;
    setElapsed(0);
    setSavedName(null);
    setProgress({ phase: 'audio', progress: 0, frame: 0, totalFrames });
    setPhase('exporting');
    const name = `${sanitizeName(fileName || project.name)}.${container}`;
    saveExportSettings({ container, quality, fps, scale });
    try {
      const blob = await exportProject(
        project,
        { container, scale, fps: effFps, quality, includeAudio: !isGif && (includeAudio || audioOnly), range },
        {
          signal: ac.signal,
          onWarning: (m) => {
            if (!warnings.includes(m)) warnings.push(m);
          },
          onFallback: () => {
            // the bar starts over: say why the export took longer
            const m = 'the fast export did not work here, the file was made the slower way';
            if (!warnings.includes(m)) warnings.push(m);
          },
          onProgress: (p) => {
            // a stopped or replaced run is silent
            if (abortRef.current !== ac) return;
            exportProgressToShell(p.progress);
            const now = performance.now();
            if (now - lastUiRef.current < 100 && p.progress < 1) return;
            lastUiRef.current = now;
            setProgress(p);
          },
        },
      );
      // stopped because the project changed or the dialog closed: the dialog was reset already
      if (abortRef.current !== ac) return;
      if (ac.signal.aborted) {
        setPhase('setup');
        return;
      }
      const url = URL.createObjectURL(blob);
      doneUrlRef.current = url;
      setDone({ url, size: blob.size, seconds: (performance.now() - startRef.current) / 1000, fileName: name, warnings });
      setPhase('done');
      shell.attention();
      triggerDownload(url, name);
    } catch (err) {
      if (abortRef.current !== ac) return;
      if (ac.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
        setPhase('setup');
        return;
      }
      setError(err instanceof Error ? err.message : 'export failed');
      setPhase('error');
    } finally {
      if (abortRef.current === ac) abortRef.current = null;
    }
  }, [project, phase, range, totalFrames, audioOnly, isGif, effFps, fileName, container, scale, fps, quality, includeAudio, revokeUrl, triggerDownload]);

  const cancel = useCallback(() => abortRef.current?.abort(), []);

  if (!project) return null;

  const size = outputSize(project, scale);
  const outName = `${sanitizeName(fileName || project.name)}.${container}`;
  const frac = progress ? progress.progress : 0;
  const eta = frac > 0.02 ? (elapsed / frac) * (1 - frac) : null;

  let body;
  let footer;
  if (phase === 'setup') {
    // audio only files and gifs need no video encoder and no plan
    const plan = container === 'mp4' || container === 'webm' ? plans[container] : undefined;
    const other: VideoContainer = container === 'mp4' ? 'webm' : 'mp4';
    const needsEncoder = !audioOnly && !isGif;
    const probing = needsEncoder && plan === undefined;
    const noEncoder = needsEncoder && typeof VideoEncoder === 'undefined';
    const gifWarn = isGif && range ? gifSizeWarning(size.width, size.height, totalFrames) : '';
    let note = '';
    if (noEncoder) note = 'this browser cannot encode video, try a recent chrome or edge';
    else if (!empty && !range) note = 'the range is empty, the start must be before the end';
    else if (plan === null) {
      note = `${container} cannot be encoded at ${size.width}x${size.height} and ${fps} fps here${
        plans[other] ? `, try ${other}, or` : ', try'
      } a lower frame rate or resolution`;
    }
    body = (
      <>
        <label className="field">
          <span className="field-label">file name</span>
          <input
            className="input"
            value={fileName}
            title="file name without extension"
            onChange={(e) => setFileName(e.target.value)}
            spellCheck={false}
          />
        </label>
        <div className="export-summary" title="the file that will be saved">
          saves as <span className="mono">{outName}</span>
        </div>
        <div className="export-presets" role="group" aria-label="quick choices">
          {EXPORT_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`btn btn-sm${activePreset === p.id ? ' is-active' : ''}`}
              aria-pressed={activePreset === p.id}
              title={p.title}
              onClick={() => applyPreset(p)}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="export-grid">
          <label className="field">
            <span className="field-label">format</span>
            <select
              className="select"
              value={container}
              title="container format"
              onChange={(e) => changeContainer(e.target.value as ExportContainer)}
            >
              <optgroup label="video">
                <option value="mp4">mp4</option>
                <option value="webm">webm</option>
                <option value="gif">gif (animated)</option>
              </optgroup>
              <optgroup label="audio only">
                <option value="wav">wav</option>
                <option value="ogg">ogg (opus)</option>
              </optgroup>
            </select>
          </label>
          <label className="field">
            <span className="field-label">range</span>
            <select
              className="select"
              value={mode}
              title="which part of the timeline to export"
              onChange={(e) => setRangeMode(e.target.value as RangeMode)}
            >
              <option value="all">whole project</option>
              {hasMarkerRange && <option value="markers">first to last marker</option>}
              <option value="custom">custom</option>
            </select>
          </label>
          {mode === 'custom' && (
            <>
              <label className="field">
                <span className="field-label">start (s)</span>
                <input
                  className="input"
                  type="number"
                  min={0}
                  step={0.1}
                  value={rangeFrom}
                  title="start of the range in seconds"
                  onChange={(e) => setRangeFrom(e.target.value)}
                />
              </label>
              <label className="field">
                <span className="field-label">end (s)</span>
                <input
                  className="input"
                  type="number"
                  min={0}
                  step={0.1}
                  value={rangeTo}
                  placeholder={projectLength.toFixed(2)}
                  title="end of the range in seconds, empty = the end of the project"
                  onChange={(e) => setRangeTo(e.target.value)}
                />
              </label>
            </>
          )}
          {!audioOnly && (
          <label className="field">
            <span className="field-label">resolution</span>
            <select
              className="select"
              value={scale}
              title="output resolution"
              onChange={(e) => setScale(Number(e.target.value))}
            >
              {SCALES.map((s) => {
                const sz = outputSize(project, s.value);
                return (
                  <option key={s.value} value={s.value}>
                    {s.label} ({sz.width}x{sz.height})
                  </option>
                );
              })}
            </select>
          </label>
          )}
          {!audioOnly && (
          <label className="field">
            <span className="field-label">frame rate</span>
            <select className="select" value={fps} title="frames per second" onChange={(e) => setFps(Number(e.target.value))}>
              {fpsChoices.map((f) => (
                <option key={f} value={f}>
                  {f} fps{f === projectFps ? ' (project)' : ''}
                </option>
              ))}
            </select>
          </label>
          )}
          {!audioOnly && !isGif && (
          <label className="field">
            <span className="field-label">quality</span>
            <select
              className="select"
              value={quality}
              title="video bitrate"
              onChange={(e) => setQuality(e.target.value as ExportQuality)}
            >
              {QUALITIES.map((q) => (
                <option key={q} value={q}>
                  {q}
                </option>
              ))}
            </select>
          </label>
          )}
        </div>
        {!audioOnly && !isGif && (
          <label className="field-row export-check" title="mix all audible clips into the file">
            <input
              type="checkbox"
              className="checkbox"
              checked={includeAudio}
              onChange={(e) => setIncludeAudio(e.target.checked)}
            />
            <span>include audio</span>
          </label>
        )}
        <div className="export-summary">
          {empty
            ? 'the project is empty, add some clips first'
            : !range
              ? 'nothing to export in this range'
              : audioOnly
                ? `${formatDuration(duration)} (${duration.toFixed(2)}s) of audio, from ${range.start.toFixed(2)}s to ${range.end.toFixed(2)}s`
                : `${formatDuration(duration)} (${duration.toFixed(2)}s), ${totalFrames} frames, ${size.width}x${size.height} at ${effFps} fps${
                    mode === 'all' ? '' : `, from ${range.start.toFixed(2)}s to ${range.end.toFixed(2)}s`
                  }`}
        </div>
        <div className="export-summary">
          {audioOnly
            ? container === 'wav'
              ? 'uncompressed 16 bit stereo, 48 khz'
              : 'opus audio in an ogg file'
            : isGif
              ? range
                ? `256 colors, no sound, loops forever, about ${formatBytes(estimateGifBytes(size.width, size.height, totalFrames))}`
                : ''
              : probing
                ? 'checking encoders...'
                : plan
                  ? `codec ${CODEC_LABEL[plan.codec] ?? plan.codec}, about ${formatBitrate(plan.bitrate)}${
                      range ? `, about ${formatBytes((plan.bitrate * duration) / 8)} without audio` : ''
                    }`
                  : ''}
        </div>
        {isGif && gifFpsNote(fps) ? <div className="export-note">{gifFpsNote(fps)}</div> : null}
        {gifWarn ? <div className="export-note">{gifWarn}</div> : null}
        {note ? <div className="export-note is-error">{note}</div> : null}
      </>
    );
    footer = (
      <>
        <button className="btn" onClick={onClose} title="close without exporting">
          close
        </button>
        <button
          className="btn btn-primary"
          onClick={start}
          disabled={empty || !range || (needsEncoder && !plan)}
          title="render the project to a file"
        >
          export
        </button>
      </>
    );
  } else if (phase === 'exporting') {
    body = (
      <>
        <div
          className="export-bar"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(frac * 100)}
        >
          <div className="export-bar-fill" style={{ transform: `scaleX(${frac})` }} />
        </div>
        <div className="export-stats">
          <span>{progress ? PHASE_TEXT[progress.phase] : ''}</span>
          <span className="mono">{Math.round(frac * 100)}%</span>
        </div>
        <div className="export-stats export-dim">
          <span className="mono">{(progress?.totalFrames ?? totalFrames) > 0 ? `frame ${progress?.frame ?? 0} / ${progress?.totalFrames ?? totalFrames}` : ''}</span>
          <span className="mono">
            {formatClock(elapsed)} elapsed{eta !== null ? `, about ${formatClock(eta)} left` : ''}
          </span>
        </div>
      </>
    );
    footer = (
      <button className="btn btn-danger" onClick={cancel} title="stop the export and discard it">
        <X size={14} />
        cancel
      </button>
    );
  } else if (phase === 'done' && done) {
    body = (
      <>
        <div className="export-done-name mono">{done.fileName}</div>
        <div className="export-stats export-dim">
          <span>{formatBytes(done.size)}</span>
          <span>done in {formatClock(done.seconds)}</span>
        </div>
        {done.warnings.map((w) => (
          <div key={w} className="export-note">
            {w}
          </div>
        ))}
      </>
    );
    footer = (
      <>
        <button className="btn" onClick={onClose} title="close">
          close
        </button>
        {shell.available && savedName && (
          <button className="btn" onClick={() => void shell.revealLastSave()} title={`show ${savedName} in its folder`}>
            <FolderOpen size={14} />
            show in folder
          </button>
        )}
        <button
          className="btn btn-primary"
          onClick={() => triggerDownload(done.url, done.fileName)}
          title="save the file again"
        >
          <Download size={14} />
          save file
        </button>
      </>
    );
  } else {
    body = <div className="export-note is-error">{error || 'export failed'}</div>;
    footer = (
      <>
        <button className="btn" onClick={onClose} title="close">
          close
        </button>
        <button className="btn btn-primary" onClick={() => setPhase('setup')} title="back to the settings">
          back
        </button>
      </>
    );
  }

  return (
    <Dialog
      open={open}
      title="export video"
      onClose={onClose}
      dismissable={phase !== 'exporting'}
      width={460}
      footer={footer}
    >
      {body}
    </Dialog>
  );
}
