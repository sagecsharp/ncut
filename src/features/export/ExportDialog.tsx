import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, X } from 'lucide-react';
import { Dialog } from '../../components/ui/Dialog';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { FPS_OPTIONS } from '../../lib/factory';
import { formatBytes, formatDuration } from '../../lib/time';
import { projectDuration } from '../../lib/timelineOps';
import { exportProject, frameCount, outputSize, probeFormats } from './exporter';
import type { ExportContainer, ExportProgress, ExportQuality } from './exporter';
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

const PHASE_TEXT: Record<ExportProgress['phase'], string> = {
  audio: 'mixing audio',
  video: 'rendering frames',
  finalizing: 'finalizing file',
};

export function ExportDialog({ open, onClose }: ExportDialogProps) {
  const project = useEditor((s) => s.project);

  const [phase, setPhase] = useState<Phase>('setup');
  const [fileName, setFileName] = useState('');
  const [container, setContainer] = useState<ExportContainer>('mp4');
  const [scale, setScale] = useState(1);
  const [fps, setFps] = useState(30);
  const [quality, setQuality] = useState<ExportQuality>('medium');
  const [includeAudio, setIncludeAudio] = useState(true);
  const [support, setSupport] = useState<Record<ExportContainer, boolean> | null>(null);

  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [done, setDone] = useState<DoneInfo | null>(null);
  const [error, setError] = useState('');

  const abortRef = useRef<AbortController | null>(null);
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
    if (!open) return;
    setPhase('setup');
    setFileName(sanitizeName(projectName));
    setFps(projectFps);
    setProgress(null);
    setDone(null);
    setError('');
    setSupport(null);
    let cancelled = false;
    void probeFormats({ width: projectW, height: projectH, fps: projectFps }).then((res) => {
      if (cancelled) return;
      setSupport(res);
      setContainer((cur) => (res[cur] ? cur : res.mp4 ? 'mp4' : res.webm ? 'webm' : cur));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, projectId]);

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

  // elapsed clock while exporting (2 ticks per second, not per frame)
  useEffect(() => {
    if (phase !== 'exporting') return;
    const id = window.setInterval(() => setElapsed((performance.now() - startRef.current) / 1000), 500);
    return () => window.clearInterval(id);
  }, [phase]);

  const fpsChoices = useMemo(() => {
    const set = new Set<number>(FPS_OPTIONS.filter((f) => f <= projectFps));
    set.add(projectFps);
    return [...set].sort((a, b) => a - b);
  }, [projectFps]);

  const duration = project ? projectDuration(project) : 0;
  const empty = !project || duration <= 0;
  const totalFrames = project ? frameCount(project, fps) : 0;

  const triggerDownload = useCallback((url: string, name: string) => {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, []);

  const start = useCallback(async () => {
    if (!project || phase === 'exporting') return;
    usePlayback.getState().pause();
    revokeUrl();
    const ac = new AbortController();
    abortRef.current = ac;
    const warnings: string[] = [];
    startRef.current = performance.now();
    lastUiRef.current = 0;
    setElapsed(0);
    setProgress({ phase: 'audio', progress: 0, frame: 0, totalFrames });
    setPhase('exporting');
    const name = `${sanitizeName(fileName || project.name)}.${container}`;
    try {
      const blob = await exportProject(
        project,
        { container, scale, fps, quality, includeAudio },
        {
          signal: ac.signal,
          onWarning: (m) => {
            if (!warnings.includes(m)) warnings.push(m);
          },
          onProgress: (p) => {
            const now = performance.now();
            if (now - lastUiRef.current < 100 && p.progress < 1) return;
            lastUiRef.current = now;
            setProgress(p);
          },
        },
      );
      if (ac.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      doneUrlRef.current = url;
      setDone({ url, size: blob.size, seconds: (performance.now() - startRef.current) / 1000, fileName: name, warnings });
      setPhase('done');
      triggerDownload(url, name);
    } catch (err) {
      if (ac.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
        setPhase('setup');
        return;
      }
      setError(err instanceof Error ? err.message : 'export failed');
      setPhase('error');
    } finally {
      if (abortRef.current === ac) abortRef.current = null;
    }
  }, [project, phase, totalFrames, fileName, container, scale, fps, quality, includeAudio, revokeUrl, triggerDownload]);

  const cancel = useCallback(() => abortRef.current?.abort(), []);

  if (!project) return null;

  const size = outputSize(project, scale);
  const frac = progress ? progress.progress : 0;
  const eta = frac > 0.02 ? (elapsed / frac) * (1 - frac) : null;

  let body;
  let footer;
  if (phase === 'setup') {
    const noneSupported = support !== null && !support.mp4 && !support.webm;
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
        <div className="export-grid">
          <label className="field">
            <span className="field-label">format</span>
            <select
              className="select"
              value={container}
              title="container format"
              onChange={(e) => setContainer(e.target.value as ExportContainer)}
            >
              <option value="mp4" disabled={support !== null && !support.mp4}>
                mp4 (h.264)
              </option>
              <option value="webm" disabled={support !== null && !support.webm}>
                webm (vp9)
              </option>
            </select>
          </label>
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
          <label className="field">
            <span className="field-label">frame rate</span>
            <select className="select" value={fps} title="frames per second" onChange={(e) => setFps(Number(e.target.value))}>
              {fpsChoices.map((f) => (
                <option key={f} value={f}>
                  {f} fps
                </option>
              ))}
            </select>
          </label>
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
        </div>
        <label className="field-row export-check" title="mix all audible clips into the file">
          <input
            type="checkbox"
            className="checkbox"
            checked={includeAudio}
            onChange={(e) => setIncludeAudio(e.target.checked)}
          />
          <span>include audio</span>
        </label>
        <div className="export-summary">
          {empty
            ? 'the project is empty, add some clips first'
            : `${formatDuration(duration)} (${duration.toFixed(2)}s), ${totalFrames} frames, ${size.width}x${size.height} at ${fps} fps`}
        </div>
        {noneSupported ? <div className="export-note is-error">this browser cannot encode video, try a recent chrome or edge</div> : null}
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
          disabled={empty || noneSupported || (support !== null && !support[container])}
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
          <span className="mono">
            frame {progress?.frame ?? 0} / {progress?.totalFrames ?? totalFrames}
          </span>
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
