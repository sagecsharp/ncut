import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Download, FolderOpen, X } from 'lucide-react';
import { exportProgressToShell, shell } from '../../lib/shell';
import { Dialog } from '../../components/ui/Dialog';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { FPS_OPTIONS } from '../../lib/factory';
import { EXPORT_PRESETS, matchingPreset, presetChoices } from './presets';
import type { ExportPreset } from './presets';
import { formatBytes, formatDuration } from '../../lib/time';
import { dbtpText, luText, lufsText } from '../../lib/loudness';
import { projectDuration } from '../../lib/timelineOps';
import { cleanRange, inOutSpan } from '../../lib/inOut';
import { CODEC_LABEL, exportProject, isAudioContainer, isGifContainer, outputSize, planExport } from './exporter';
import { createPlanMemo, probeDelay } from './planMemo';
import type { ExportContainer, ExportOptions, ExportPlan, ExportProgress, ExportQuality, PlanRequest, VideoContainer } from './exporter';
import { clampRange, markerRange, rangeFrameCount, resolveRange } from './range';
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
import { loadExportSettings, saveAdvancedOpen, saveExportSettings, savedDelivery } from './settings';
import { AUDIO_HOLDS, DEFAULT_DELIVERY, TEXT, changedCount, seeThroughTwin, deliverySize, estimateBytes, formatBitrate, isDefaultDelivery, resolveDelivery } from './delivery';
import type { ExportDelivery, VideoCodecChoice } from './delivery';
import { AdvancedExport } from './AdvancedExport';
import { LoudnessRow } from './LoudnessRow';
import { useDeliveryStatus } from './useDeliveryStatus';
import { clipWindow, getAudibleClips } from './audioMix';
import { loudnessLine, wantsLoudness } from './loudnessTypes';
import type { LoudnessReport } from './loudnessTypes';
import { useLoudnessPref } from './loudnessPrefs';
import { isStillContainer, stillSize } from './still';
import { isExporting } from '../../engine/exportState';
import { mcpExportJob } from '../../mcp/exportJob';
import { setBusy } from '../../lib/busy';
import { useUi } from '../../store/ui';
import type { ExportFocus } from '../../store/ui';
import { tip } from '../shell/tip';
import { SoloNote } from '../media/mixer/SoloNote';
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
  /** what the loudness choice did to the sound, when it was sent */
  loudness: LoudnessReport | null;
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

/** the newest search row ask the dialog has applied (the ask is read once per count) */
let appliedAsk = 0;

/** the rows of the advanced part and the loudness row that each format shows (for a search row that asks for one) */
function showsRow(c: ExportContainer, focus: ExportFocus): boolean {
  const video = c === 'mp4' || c === 'webm';
  const picture = c === 'png' || c === 'jpg';
  if (focus === 'codec' || focus === 'bitrate' || focus === 'interval') return video;
  if (focus === 'size' || focus === 'transparent') return video || picture;
  return video || c === 'wav' || c === 'ogg';
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

/** frame rate + resolution are remembered apart for gif and for video. a picture goes with the video's resolution */
type PrefGroup = 'gif' | 'video';
function groupOf(c: ExportContainer): PrefGroup | null {
  return c === 'gif' ? 'gif' : c === 'mp4' || c === 'webm' || isStillContainer(c) ? 'video' : null;
}

const PHASE_TEXT: Record<ExportProgress['phase'], string> = {
  loudness: 'measuring loudness',
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
  // a transparent canvas starts on the see-through twin of a file that cannot be see-through (mp4 -> webm, jpg -> png)
  const [container, setContainer] = useState<ExportContainer>(() => seeThroughTwin(saved.container ?? 'mp4', !!project?.transparent));
  const [scale, setScale] = useState(saved.container === 'gif' ? (saved.gif?.scale ?? GIF_DEFAULT_SCALE) : (saved.scale ?? 1));
  const [fps, setFps] = useState(() => (groupOf(saved.container ?? 'mp4') === 'gif' ? (saved.gif?.fps ?? GIF_DEFAULT_FPS) : 30));
  const [quality, setQuality] = useState<ExportQuality>(saved.quality ?? 'medium');
  const [includeAudio, setIncludeAudio] = useState(true);
  // the advanced choices and whether that part is open come back with the rest
  // (a transparent canvas starts with a see-through background)
  const [delivery, setDelivery] = useState<ExportDelivery>(() => {
    const d = savedDelivery(saved, project?.width ?? 0, project?.height ?? 0);
    return project?.transparent ? { ...d, transparent: true } : d;
  });
  const [advancedOpen, setAdvancedOpen] = useState(saved.advanced === true);
  const exportAsk = useUi((s) => s.exportAsk);
  /** the row a search row asked for: scrolled to and focused once the dialog shows it */
  const [focusRow, setFocusRow] = useState<{ row: ExportFocus; n: number } | null>(null);
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
    const p = useEditor.getState().project;
    const span = p ? inOutSpan(p.range, projectDuration(p)) : null;
    if (p && span) {
      setRangeMode('inout');
      setRangeFrom(String(Math.round(span.start * 1000) / 1000));
      setRangeTo(cleanRange(p.range)?.out !== undefined ? String(Math.round(span.end * 1000) / 1000) : '');
    } else {
      setRangeMode('all');
      setRangeFrom('0');
      setRangeTo('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, projectId]);

  // what the format makes of the advanced choices, and the size of the file
  const resolved = resolveDelivery(container, delivery);
  const isStill = isStillContainer(container);
  const baseSize = isStill ? stillSize({ width: projectW, height: projectH }, scale) : outputSize({ width: projectW, height: projectH }, scale);
  const outSize = deliverySize(baseSize, container, resolved);
  // what the plan asks of the browser for each video format: the codec and bitrate only when they are set (a string, so it is a plain effect dependency)
  const planAsks = JSON.stringify(
    (['mp4', 'webm'] as const).map((c) => {
      const r = resolveDelivery(c, delivery);
      const sz = deliverySize(outputSize({ width: projectW, height: projectH }, scale), c, r);
      const req: PlanRequest = { container: c, width: sz.width, height: sz.height, fps, quality };
      if (r.codec !== 'auto') req.codec = r.codec;
      if (r.bitrate !== null) req.bitrate = r.bitrate;
      return req;
    }),
  );

  // ask the browser what it can encode for the chosen size + fps + quality (debounced, cancelled by the next change)
  useEffect(() => {
    if (!open || phase !== 'setup' || projectW <= 0 || isAudioContainer(container) || isGifContainer(container) || isStillContainer(container)) return;
    const videoContainer: VideoContainer = container;
    const [askMp4, askWebm] = JSON.parse(planAsks) as PlanRequest[];
    const ask = (c: VideoContainer): PlanRequest => (c === 'mp4' ? askMp4! : askWebm!);
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
  }, [open, phase, projectW, container, planAsks]);

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
      const c = presetChoices(preset, projectFps, { width: projectW, height: projectH });
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
      // a preset puts every advanced choice where it says (auto where it says nothing). loudness is never part of it
      setDelivery(c.delivery ?? { ...DEFAULT_DELIVERY });
    },
    [fps, scale, projectFps, projectW, projectH],
  );
  const activePreset = matchingPreset({ container, quality, fps, scale, delivery }, projectFps, { width: projectW, height: projectH });

  // a search row opened the dialog with a part asked for. declared after the open reset effect, so it runs after it in the same commit
  useEffect(() => {
    if (!open || !exportAsk || exportAsk.n === appliedAsk) return;
    appliedAsk = exportAsk.n;
    let target = container;
    const preset = exportAsk.preset ? EXPORT_PRESETS.find((p) => p.id === exportAsk.preset) : undefined;
    if (preset) {
      applyPreset(preset);
      target = preset.container;
    }
    if (exportAsk.advanced) setAdvancedOpen(true);
    const focus = exportAsk.focus;
    if (focus) {
      // a format that has no such row: mp4 has them all
      if (!showsRow(target, focus)) {
        if (preset) {
          groupRef.current = 'video';
          setContainer('mp4');
        } else changeContainer('mp4');
      }
      if (focus === 'loudness') setIncludeAudio(true);
      setFocusRow({ row: focus, n: exportAsk.n });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, exportAsk?.n]);

  // the asked row is on screen after that render: scroll to it and focus its first control
  useEffect(() => {
    if (!focusRow) return;
    const row = document.querySelector<HTMLElement>(`[data-delivery-row="${focusRow.row}"]`);
    if (!row) return;
    row.scrollIntoView({ block: 'nearest' });
    row.querySelector<HTMLElement>('button, select, input')?.focus();
  }, [focusRow]);

  const projectLength = project ? projectDuration(project) : 0;
  const markers = project?.markers;
  const hasMarkerRange = markerRange(markers) !== null;
  // a marker choice that stopped being possible (a marker was removed) falls back to the whole project
  // an in to out choice that stopped being possible (the points were cleared) falls back the same way
  // a picture (png / jpg) is the first frame of the range: only where the range starts matters
  const inOut = project ? inOutSpan(project.range, projectLength) : null;
  const hasInOut = inOut !== null && (!isStill || cleanRange(project?.range)?.in !== undefined);
  const mode: RangeMode = (rangeMode === 'markers' && !hasMarkerRange) || (rangeMode === 'inout' && !hasInOut) ? 'all' : rangeMode;
  const customStart = Number.parseFloat(rangeFrom);
  const customEnd = isStill || rangeTo.trim() === '' ? projectLength : Number.parseFloat(rangeTo);
  const range = useMemo(
    () => resolveRange(mode, projectLength, markers, { start: customStart, end: customEnd }, project?.range),
    [mode, projectLength, markers, customStart, customEnd, project?.range],
  );
  const audioOnly = isAudioContainer(container);
  const empty = !project || projectLength <= 0;
  const duration = range ? range.end - range.start : 0;
  // a gif cannot play faster than 50 fps
  const effFps = isGif ? gifExportFps(fps) : fps;
  const totalFrames = range ? (isStill ? 1 : rangeFrameCount(range, effFps)) : 0;

  // does the file have sound: include audio on (or a sound format) and an audible clip inside the range
  const sound = useMemo(() => {
    if (!project || !range || !(includeAudio || audioOnly)) return false;
    return getAudibleClips(project).some((c) => clipWindow(c.start, c.duration, c.speed, range.start, duration) !== null);
  }, [project, range, includeAudio, audioOnly, duration]);
  const soundOn = !isGif && !isStill && (includeAudio || audioOnly);
  const loudnessShown = container === 'mp4' || container === 'webm' || container === 'wav' || container === 'ogg';
  const plan = container === 'mp4' || container === 'webm' ? plans[container] : undefined;

  // what this machine can encode for the advanced choices: every codec while that part is open, else only a set codec that got no plan
  const videoFile = container === 'mp4' || container === 'webm' ? container : null;
  const soundFile = container === 'mp4' || container === 'webm' || container === 'ogg' ? container : null;
  const noPlanCodec: VideoCodecChoice | null = plan === null && resolved.codec !== 'auto' ? resolved.codec : null;
  const probeVideo = open && phase === 'setup' && videoFile !== null && projectW > 0 && (advancedOpen || noPlanCodec !== null);
  const status = useDeliveryStatus({
    video:
      probeVideo && videoFile
        ? { container: videoFile, width: outSize.width, height: outSize.height, fps, quality, bitrate: resolved.bitrate, transparent: resolved.transparent }
        : null,
    only: advancedOpen ? null : noPlanCodec,
    audio:
      open && phase === 'setup' && advancedOpen && soundFile && soundOn
        ? { container: soundFile, codec: resolved.audioCodec === 'auto' ? AUDIO_HOLDS[soundFile][0] : resolved.audioCodec, sampleRate: resolved.sampleRate }
        : null,
  });

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
    // an export started by an mcp client (src/mcp/exportJob.ts) is still at it: two at once would fight over the encoder
    if (isExporting() || mcpExportJob.running()) {
      useUi.getState().toast('another export is still running', 'error');
      return;
    }
    usePlayback.getState().pause();
    revokeUrl();
    const ac = new AbortController();
    abortRef.current = ac;
    const warnings: string[] = [];
    startRef.current = performance.now();
    lastUiRef.current = 0;
    setElapsed(0);
    setSavedName(null);
    // the loudness choice goes along only when its row is live (the file has sound) and asks for something
    const loud = useLoudnessPref.getState().loudness;
    const sendLoud = loudnessShown && (audioOnly || includeAudio) && wantsLoudness(loud);
    setProgress({ phase: isStill ? 'video' : sendLoud ? 'loudness' : 'audio', progress: 0, frame: 0, totalFrames });
    setPhase('exporting');
    const name = `${sanitizeName(fileName || project.name)}.${container}`;
    // the see-through background a transparent canvas turned on is not kept for the next project
    const keep = project.transparent ? { ...delivery, transparent: saved.delivery?.transparent === true } : delivery;
    saveExportSettings({ container, quality, fps, scale, delivery: keep, sizeFor: { width: project.width, height: project.height } });
    const options: ExportOptions = { container, scale, fps: effFps, quality, includeAudio: !isGif && !isStill && (includeAudio || audioOnly), range };
    if (!isDefaultDelivery(delivery)) options.delivery = delivery;
    if (sendLoud) options.loudness = loud;
    let loudReport: LoudnessReport | null = null;
    try {
      const blob = await exportProject(
        project,
        options,
        {
          onLoudness: (r) => {
            loudReport = r;
          },
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
      setDone({ url, size: blob.size, seconds: (performance.now() - startRef.current) / 1000, fileName: name, warnings, loudness: loudReport });
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
  }, [project, phase, range, totalFrames, audioOnly, isGif, isStill, effFps, fileName, container, scale, fps, quality, includeAudio, delivery, loudnessShown, revokeUrl, triggerDownload]);

  const cancel = useCallback(() => abortRef.current?.abort(), []);

  if (!project) return null;

  const sizeAt = (s: number) => (isStill ? stillSize(project, s) : outputSize(project, s));
  // the size of the file: the resolution choice, or the custom size of the advanced part
  const size = outSize;
  const outName = `${sanitizeName(fileName || project.name)}.${container}`;
  const frac = progress ? progress.progress : 0;
  // the measure of the loudness has no pace to tell
  const eta = frac > 0.02 && progress?.phase !== 'loudness' ? (elapsed / frac) * (1 - frac) : null;

  let body;
  let footer;
  if (phase === 'setup') {
    // audio only files and gifs need no video encoder and no plan
    const other: VideoContainer = container === 'mp4' ? 'webm' : 'mp4';
    const needsEncoder = !audioOnly && !isGif && !isStill;
    const probing = needsEncoder && plan === undefined;
    const noEncoder = needsEncoder && typeof VideoEncoder === 'undefined';
    const gifWarn = isGif && range ? gifSizeWarning(size.width, size.height, totalFrames) : '';
    let note = '';
    if (noEncoder) note = 'this browser cannot encode video, try a recent chrome or edge';
    else if (!empty && !range) note = isStill ? 'pick a time before the end of the project' : 'the range is empty, the start must be before the end';
    else if (plan === null && resolved.codec !== 'auto') {
      // a set codec: the reason this machine gave (the plan said no), until it is known the general one
      const why = status.video[resolved.codec];
      note = why && !why.ok ? why.reason : TEXT.noPlan(CODEC_LABEL[resolved.codec] ?? resolved.codec, size.width, size.height, fps, resolved.bitrate);
    } else if (plan === null) {
      note = `${container} cannot be encoded at ${size.width}x${size.height} and ${fps} fps here${
        plans[other] ? `, try ${other}, or` : ', try'
      } a lower frame rate or resolution`;
    }
    // the estimate of the file: the bitrates times the length. wav and ogg need sound to say it, a video says it without
    const holds = container === 'mp4' || container === 'webm' || container === 'ogg' ? AUDIO_HOLDS[container] : null;
    const audioCodec = resolved.audioCodec === 'auto' ? (holds ? holds[0] : 'pcm-s16') : resolved.audioCodec;
    const estimate =
      range && (container === 'mp4' || container === 'webm' || container === 'wav' || container === 'ogg') && (plan || audioOnly) && (!audioOnly || sound)
        ? estimateBytes({
            container,
            seconds: duration,
            frames: totalFrames,
            videoBitrate: plan ? plan.bitrate : 0,
            alpha: resolved.transparent,
            audio: sound ? { codec: audioCodec, bitrate: resolved.audioBitrate, sampleRate: resolved.sampleRate } : null,
          })
        : null;
    const khz = resolved.sampleRate / 1000;
    const audioSummary =
      container === 'wav'
        ? estimate
          ? TEXT.summaryWav(khz, formatBytes(estimate.total))
          : `uncompressed 16 bit stereo, ${khz} khz`
        : estimate
          ? TEXT.summaryOgg(formatBytes(estimate.total))
          : 'opus sound in an ogg file';
    const codecName = plan ? (CODEC_LABEL[plan.codec] ?? plan.codec) : '';
    const videoSummary: ReactNode = !plan ? (
      ''
    ) : estimate ? (
      <span
        {...tip('file size', {
          does: TEXT.sizeDoes(formatBytes(estimate.video), estimate.alpha > 0 ? formatBytes(estimate.alpha) : null, estimate.audio > 0 ? formatBytes(estimate.audio) : null),
        })}
      >
        {TEXT.summary(codecName, resolved.transparent, plan.bitrate, formatBytes(estimate.total))}
      </span>
    ) : (
      `codec ${codecName}${resolved.transparent ? ', see-through' : ''}, about ${formatBitrate(plan.bitrate)}`
    );
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
              {...tip(p.label, { does: p.title })}
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
              <optgroup label="image (first frame)">
                <option value="png">png</option>
                <option value="jpg">jpg</option>
              </optgroup>
            </select>
          </label>
          <label className="field">
            <span className="field-label">{isStill ? 'frame' : 'range'}</span>
            <select
              className="select"
              value={mode}
              title={isStill ? 'which frame of the timeline becomes the picture' : 'which part of the timeline to export'}
              onChange={(e) => setRangeMode(e.target.value as RangeMode)}
            >
              <option value="all">{isStill ? 'first frame' : 'whole project'}</option>
              {hasInOut && <option value="inout">{isStill ? 'at the in point' : 'in to out'}</option>}
              {hasMarkerRange && <option value="markers">{isStill ? 'at the first marker' : 'first to last marker'}</option>}
              <option value="custom">{isStill ? 'at a time' : 'custom'}</option>
            </select>
          </label>
          {mode === 'custom' && (
            <>
              <label className="field">
                <span className="field-label">{isStill ? 'time (s)' : 'start (s)'}</span>
                <input
                  className="input"
                  type="number"
                  min={0}
                  step={0.1}
                  value={rangeFrom}
                  title={isStill ? 'the timeline second of the frame' : 'start of the range in seconds'}
                  onChange={(e) => setRangeFrom(e.target.value)}
                />
              </label>
              {!isStill && (
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
              )}
            </>
          )}
          {!audioOnly && (
          <label className="field">
            <span className="field-label">resolution</span>
            <select
              className="select"
              value={resolved.size ? 'custom' : scale}
              title="output resolution"
              onChange={(e) => {
                if (e.target.value === 'custom') return;
                setScale(Number(e.target.value));
                // a resolution choice takes the custom size back
                if (resolved.size) setDelivery({ ...delivery, size: null });
              }}
            >
              {SCALES.map((s) => {
                const sz = sizeAt(s.value);
                return (
                  <option key={s.value} value={s.value}>
                    {s.label} ({sz.width}x{sz.height})
                  </option>
                );
              })}
              {resolved.size && <option value="custom">{`custom, ${size.width}x${size.height}`}</option>}
            </select>
          </label>
          )}
          {!audioOnly && !isStill && (
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
          {!audioOnly && !isGif && container !== 'png' && (
          <label className="field">
            <span className="field-label">quality</span>
            <select
              className="select"
              value={resolved.bitrate !== null ? 'custom' : quality}
              title={isStill ? 'how much the jpg is compressed' : 'video bitrate'}
              onChange={(e) => {
                if (e.target.value === 'custom') return;
                setQuality(e.target.value as ExportQuality);
                // low, medium or high takes the custom bitrate back
                if (resolved.bitrate !== null) setDelivery({ ...delivery, bitrate: null });
              }}
            >
              {QUALITIES.map((q) => (
                <option key={q} value={q}>
                  {q}
                </option>
              ))}
              {resolved.bitrate !== null && <option value="custom">{`custom, ${Math.round(resolved.bitrate / 1e5) / 10} mbps`}</option>}
            </select>
          </label>
          )}
        </div>
        {!audioOnly && !isGif && !isStill && (
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
        {loudnessShown && <LoudnessRow project={project} range={range ? clampRange(range, projectLength) : null} live={audioOnly || includeAudio} rate={resolved.sampleRate} />}
        <button
          type="button"
          className="btn btn-sm export-advanced-toggle"
          aria-expanded={advancedOpen && !isGif}
          aria-disabled={isGif ? 'true' : undefined}
          {...tip(TEXT.advanced, { does: TEXT.advancedDoes, keys: 'export-advanced', off: isGif ? TEXT.advancedGif : null })}
          onClick={() => {
            if (isGif) return;
            setAdvancedOpen(!advancedOpen);
            saveAdvancedOpen(!advancedOpen);
          }}
        >
          {TEXT.advanced}
          {!advancedOpen && !isGif && changedCount(container, delivery) > 0 ? TEXT.changed(changedCount(container, delivery)) : ''}
        </button>
        {advancedOpen && !isGif && (
          <AdvancedExport
            project={project}
            container={container}
            delivery={delivery}
            resolved={resolved}
            onChange={setDelivery}
            quality={quality}
            fps={fps}
            baseSize={baseSize}
            outSize={outSize}
            planCodec={plan ? plan.codec : null}
            sound={soundOn}
            range={range}
            status={status}
          />
        )}
        <div className="export-summary">
          {empty
            ? 'the project is empty, add some clips first'
            : !range
              ? isStill
                ? 'there is no frame at that time'
                : 'nothing to export in this range'
              : isStill
                ? `one picture, ${size.width}x${size.height}, ${mode === 'all' ? 'the first frame of the project' : `the frame at ${range.start.toFixed(2)}s`}`
              : audioOnly
                ? `${formatDuration(duration)} (${duration.toFixed(2)}s) of audio, from ${range.start.toFixed(2)}s to ${range.end.toFixed(2)}s`
                : `${formatDuration(duration)} (${duration.toFixed(2)}s), ${totalFrames} frames, ${size.width}x${size.height} at ${effFps} fps${
                    mode === 'all' ? '' : `, from ${range.start.toFixed(2)}s to ${range.end.toFixed(2)}s`
                  }`}
        </div>
        <div className="export-summary">
          {audioOnly
            ? audioSummary
            : isStill
              ? container === 'png'
                ? 'png: no loss, the bigger file'
                : `jpg: ${quality} quality, the smaller file`
            : isGif
              ? range
                ? `256 colors, no sound, loops forever, about ${formatBytes(estimateGifBytes(size.width, size.height, totalFrames))}`
                : ''
              : probing
                ? 'checking encoders...'
                : videoSummary}
        </div>
        <SoloNote sound={!isGif && !isStill && (includeAudio || audioOnly)} />
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
        {done.loudness && (
          <div
            className="export-summary"
            {...tip('loudness of the file', {
              does: `before: ${lufsText(done.loudness.before.integrated)}, range ${luText(done.loudness.before.lra)}, peak ${dbtpText(done.loudness.before.truePeak)}. after: ${lufsText(done.loudness.after.integrated)}, range ${luText(done.loudness.after.lra)}, peak ${dbtpText(done.loudness.after.truePeak)}`,
            })}
          >
            {loudnessLine(done.loudness)}
          </div>
        )}
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
