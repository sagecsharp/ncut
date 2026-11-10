/**
 * benchmarks and pixel comparisons, reachable as window.__ncut.bench in dev and bench builds
 * (`vite build --mode bench`). never part of a normal build.
 *
 * - `render`  times renderFrame alone, with the gpu forced to finish every frame
 * - `export`  runs the real exporter and reports where the time went
 * - `golden`  stores frames in indexeddb ('ncut-bench') and compares later builds against them, so a
 *             speedup can prove that it did not change a single pixel
 */
import { ALL_FORMATS, BlobSource, CanvasSink, EncodedPacketSink, Input } from 'mediabunny';
import type { Clip, MediaAsset, Project, VideoClip } from '../types';
import { CANVAS_PRESETS, createCameraClip, createClipFromAsset, createEffectClip, createProject, createShapeClip, createTextClip, createTrack } from '../lib/factory';
import { PROJECT_TEMPLATES, getTemplate } from '../lib/templates';
import { ensureProjectFonts } from '../lib/fonts';
import { projectDuration } from '../lib/timelineOps';
import { releaseRenderResources, renderFrame } from '../engine/draw';
import { beginExport, endExport } from '../engine/exportState';
import { exportProject, outputSize } from '../features/export/exporter';
import type { ExportOptions, ExportStats } from '../features/export/exporter';
import { importFiles } from '../media/importer';
import { useEditor } from '../store/editorStore';
import * as session from '../store/session';

const nothing = () => null;

function preset(width: number, height: number) {
  return { ...CANVAS_PRESETS[0]!, width, height };
}

/** a template as a project of its own (not opened, not saved) */
function templateProject(id: string, width = 1920, height = 1080, fps = 60): Project {
  const t = getTemplate(id);
  if (!t) throw new Error(`no template "${id}"`);
  return t.build(createProject(`bench ${id}`, preset(width, height), fps));
}

/** a video file made by the exporter itself, imported into the open project (made once, found again by name) */
async function footage(width = 1920, height = 1080, fps = 60, seconds = 5, template = 'winter'): Promise<MediaAsset> {
  if (!useEditor.getState().project) await session.createAndOpenProject('bench');
  const name = `bench-${template}-${width}x${height}-${fps}-${seconds}s.mp4`;
  const have = useEditor.getState().project!.assets.find((a) => a.name === name);
  if (have) return have;
  const src = templateProject(template, width, height, fps);
  const end = Math.min(seconds, projectDuration(src));
  const blob = await exportProject(src, { container: 'mp4', scale: 1, fps, quality: 'high', includeAudio: false, range: { start: 0, end } });
  const [asset] = await importFiles([new File([blob], name, { type: 'video/mp4' })]);
  if (!asset) throw new Error('the footage could not be imported');
  return asset;
}

/** a still picture (a png with a gradient, a grid, a pure green field and a see-through corner) imported into the open project */
async function picture(width = 1000, height = 800): Promise<MediaAsset> {
  if (!useEditor.getState().project) await session.createAndOpenProject('bench');
  const name = `bench-picture-${width}x${height}.png`;
  const have = useEditor.getState().project!.assets.find((a) => a.name === name);
  if (have) return have;
  const c = new OffscreenCanvas(width, height);
  const x = c.getContext('2d')!;
  const g = x.createLinearGradient(0, 0, width, height);
  g.addColorStop(0, '#d04020');
  g.addColorStop(0.5, '#f0e060');
  g.addColorStop(1, '#2050c0');
  x.fillStyle = g;
  x.fillRect(0, 0, width, height);
  x.fillStyle = '#00ff00';
  x.fillRect(width * 0.55, height * 0.1, width * 0.35, height * 0.45);
  x.strokeStyle = '#101010';
  x.lineWidth = 3;
  for (let i = 1; i < 10; i++) {
    x.beginPath();
    x.moveTo((width * i) / 10, 0);
    x.lineTo((width * i) / 10, height);
    x.moveTo(0, (height * i) / 10);
    x.lineTo(width, (height * i) / 10);
    x.stroke();
  }
  x.fillStyle = '#ffffff';
  x.beginPath();
  x.arc(width * 0.3, height * 0.6, height * 0.2, 0, Math.PI * 2);
  x.fill();
  x.clearRect(0, height * 0.85, width * 0.2, height * 0.15);
  const blob = await c.convertToBlob({ type: 'image/png' });
  const [asset] = await importFiles([new File([blob], name, { type: 'image/png' })]);
  if (!asset) throw new Error('the picture could not be imported');
  return asset;
}

/** a sound file (two sine tones, stereo wav) imported into the open project (made once, found again by name) */
async function tone(seconds = 10): Promise<MediaAsset> {
  if (!useEditor.getState().project) await session.createAndOpenProject('bench');
  const name = `bench-tone-${seconds}s.wav`;
  const have = useEditor.getState().project!.assets.find((a) => a.name === name);
  if (have) return have;
  const rate = 48000;
  const frames = Math.round(seconds * rate);
  const buf = new ArrayBuffer(44 + frames * 4);
  const v = new DataView(buf);
  const text = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i));
  };
  text(0, 'RIFF');
  v.setUint32(4, 36 + frames * 4, true);
  text(8, 'WAVEfmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 2, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 4, true);
  v.setUint16(32, 4, true);
  v.setUint16(34, 16, true);
  text(36, 'data');
  v.setUint32(40, frames * 4, true);
  for (let i = 0; i < frames; i++) {
    const t = i / rate;
    v.setInt16(44 + i * 4, Math.round(Math.sin(t * 2 * Math.PI * 440) * 9000), true);
    v.setInt16(46 + i * 4, Math.round(Math.sin(t * 2 * Math.PI * 660) * 9000), true);
  }
  const [asset] = await importFiles([new File([buf], name, { type: 'audio/wav' })]);
  if (!asset) throw new Error('the tone could not be imported');
  return asset;
}

interface VideoProjectOptions {
  /** a sound asset laid under the whole timeline (repeated) */
  sound?: MediaAsset;
  width?: number;
  height?: number;
  fps?: number;
  /** length of the timeline. the footage loops by putting clips one after another. */
  seconds?: number;
  /** stacked video layers (the upper ones are scaled down into a grid) */
  layers?: number;
  /** effect ids, the first one is the top layer */
  effects?: string[];
  /** a title over the picture */
  text?: boolean;
  /** a transition id between every two clips of the bottom layer */
  transition?: string;
  /** per clip motion blur on a moving, smaller copy of the picture */
  motionBlur?: number;
}

/** a project around one piece of footage */
function videoProject(asset: MediaAsset, o: VideoProjectOptions = {}): Project {
  const width = o.width ?? 1920;
  const height = o.height ?? 1080;
  const fps = o.fps ?? 60;
  const seconds = o.seconds ?? Math.max(1, asset.duration);
  const p = createProject('bench video', preset(width, height), fps);
  p.assets = [asset];
  p.tracks = [];
  const clips: Clip[] = [];
  const fit = Math.max(width / Math.max(1, asset.width), height / Math.max(1, asset.height));

  for (const id of o.effects ?? []) {
    const track = createTrack('video', `fx ${id}`);
    p.tracks.push(track);
    clips.push(createEffectClip(id, id, track.id, 0, { duration: seconds, seed: 7 }));
  }
  if (o.text) {
    const track = createTrack('video', 'title');
    p.tracks.push(track);
    clips.push(createTextClip(track.id, 0, { text: 'benchmark title\nsecond line', duration: seconds }));
  }
  if (o.motionBlur) {
    const track = createTrack('video', 'moving');
    p.tracks.push(track);
    const c = createClipFromAsset(asset, track.id, 0) as VideoClip;
    c.duration = Math.min(seconds, asset.duration);
    c.transform = { ...c.transform, scale: fit * 0.4 };
    c.keyframes = {
      x: [
        { t: 0, v: -width * 0.3, ease: 'linear' },
        { t: c.duration, v: width * 0.3, ease: 'linear' },
      ],
      rotation: [
        { t: 0, v: -40, ease: 'linear' },
        { t: c.duration, v: 40, ease: 'linear' },
      ],
    };
    c.motionBlur = { shutter: 0.5, samples: o.motionBlur };
    clips.push(c);
  }
  const layers = Math.max(1, o.layers ?? 1);
  for (let l = layers - 1; l >= 0; l--) {
    const track = createTrack('video', `layer ${l}`);
    p.tracks.push(track);
    const len = Math.max(0.5, Math.min(asset.duration, seconds));
    for (let start = 0, n = 0; start < seconds - 1e-6; start += len, n++) {
      const c = createClipFromAsset(asset, track.id, start) as VideoClip;
      c.duration = Math.min(len, seconds - start);
      if (l === 0) c.transform = { ...c.transform, scale: fit };
      else {
        // upper layers: small tiles along the top
        const s = 0.22;
        c.transform = { ...c.transform, scale: fit * s, x: (-0.5 + (l - 0.5) / Math.max(1, layers - 1)) * width * 0.8, y: -height * 0.33 };
      }
      if (o.transition && l === 0 && n > 0) c.transition = { id: o.transition, duration: Math.min(1, len / 2) };
      clips.push(c);
    }
  }
  const audioTrack = createTrack('audio', 'audio 1');
  p.tracks.push(audioTrack);
  if (o.sound) {
    p.assets = [asset, o.sound];
    for (let start = 0; start < seconds - 1e-6; start += o.sound.duration) {
      const c = createClipFromAsset(o.sound, audioTrack.id, start);
      c.duration = Math.min(o.sound.duration, seconds - start);
      clips.push(c);
    }
  }
  p.clips = clips;
  return p;
}

// ---------- timing ----------

function summary(ms: number[]) {
  const s = [...ms].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0;
  const total = ms.reduce((a, b) => a + b, 0);
  const r = (v: number) => Math.round(v * 100) / 100;
  return { frames: ms.length, mean: r(total / Math.max(1, ms.length)), p50: r(at(0.5)), p95: r(at(0.95)), max: r(s[s.length - 1] ?? 0), total: Math.round(total) };
}

function makeCanvas(project: Project, scale: number) {
  const { width, height } = outputSize(project, scale);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('2d canvas is not available');
  ctx.setTransform(width / project.width, 0, 0, height / project.height, 0, 0);
  return { canvas, ctx, width, height };
}

/** a 1 px cpu canvas: drawing the gpu canvas into it makes the gpu finish, without turning the big canvas into a cpu one */
function makeProbe() {
  const c = new OffscreenCanvas(1, 1);
  const x = c.getContext('2d', { willReadFrequently: true })!;
  return (src: OffscreenCanvas) => {
    x.drawImage(src, 0, 0, 1, 1);
    x.getImageData(0, 0, 1, 1);
  };
}

interface RenderOptions {
  scale?: number;
  /** how many frames, spread evenly over the project in playing order */
  frames?: number;
  /** include the gpu's work in every frame time (default true) */
  flush?: boolean;
  from?: number;
  to?: number;
}

/** time renderFrame over a project without media (templates, text, shapes, 3d, effects on them) */
async function render(project: Project, o: RenderOptions = {}) {
  await ensureProjectFonts(project);
  const { canvas, ctx } = makeCanvas(project, o.scale ?? 1);
  const flush = o.flush === false ? null : makeProbe();
  const from = o.from ?? 0;
  const to = o.to ?? projectDuration(project);
  const n = Math.max(1, o.frames ?? 120);
  const times: number[] = [];
  beginExport();
  try {
    // warm up: shaders, textures, fonts
    renderFrame(ctx, project, from, nothing);
    flush?.(canvas);
    for (let i = 0; i < n; i++) {
      const t = from + ((to - from) * i) / n;
      const t0 = performance.now();
      renderFrame(ctx, project, t, nothing);
      flush?.(canvas);
      times.push(performance.now() - t0);
      if (i % 30 === 29) await new Promise((r) => setTimeout(r, 0));
    }
  } finally {
    endExport();
    releaseRenderResources('export');
    canvas.width = 0;
    canvas.height = 0;
  }
  return summary(times);
}

/** the file of the last bench export (for checks on the file itself) */
let lastBlob: Blob | null = null;

/** run the real exporter and report its stage times. the file is kept only until the next run. */
async function exportRun(project: Project, o: Partial<ExportOptions> & { cancelAfterMs?: number } = {}) {
  const { cancelAfterMs, ...rest } = o;
  if (cancelAfterMs !== undefined) {
    // cancel in the middle: the export must reject with an AbortError and leave nothing running
    const stop = new AbortController();
    const t0 = performance.now();
    const timer = setTimeout(() => stop.abort(), cancelAfterMs);
    let progress = 0;
    try {
      await exportProject(
        project,
        { container: 'mp4', scale: 1, fps: project.fps, quality: 'high', includeAudio: false, ...rest },
        { signal: stop.signal, onProgress: (p) => (progress = p.progress) },
      );
      return { cancelled: false, ms: Math.round(performance.now() - t0), progress };
    } catch (err) {
      return { cancelled: err instanceof DOMException && err.name === 'AbortError', error: String(err), ms: Math.round(performance.now() - t0), progress: Math.round(progress * 100) / 100 };
    } finally {
      clearTimeout(timer);
    }
  }
  let stats: ExportStats | null = null;
  const warnings: string[] = [];
  let fallback: string | null = null;
  const t0 = performance.now();
  const blob = await exportProject(
    project,
    { container: 'mp4', scale: 1, fps: project.fps, quality: 'high', includeAudio: false, ...rest },
    { onStats: (s) => (stats = s), onWarning: (w) => warnings.push(w), onFallback: (reason) => (fallback = reason) },
  );
  lastBlob = blob;
  const ms = performance.now() - t0;
  const s = stats as ExportStats | null;
  const r = (v: number) => Math.round(v);
  return {
    ms: r(ms),
    bytes: blob.size,
    type: blob.type,
    framesPerSecond: s ? Math.round((s.frames / ms) * 1000 * 10) / 10 : 0,
    stats: s ? { ...s, setupMs: r(s.setupMs), decodeMs: r(s.decodeMs), renderMs: r(s.renderMs), encodeMs: r(s.encodeMs), audioMs: r(s.audioMs), muxMs: r(s.muxMs), finalizeMs: r(s.finalizeMs), totalMs: r(s.totalMs) } : null,
    warnings,
    fallback,
  };
}

// ---------- the exported file itself ----------

interface FileCheckOptions extends Partial<ExportOptions> {
  /** frames whose decoded picture is compared with what was drawn */
  at: number[];
}

/**
 * export, then read the file back: how many frames, where the key frames are, whether the times are the frame grid,
 * and how close the decoded frames are to the frames that went into the encoder (psnr over rgb, in db).
 */
async function fileCheck(project: Project, o: FileCheckOptions) {
  const { at, ...opts } = o;
  const drawn = new Map<number, Uint8ClampedArray>();
  let fallback: string | null = null;
  let stats: ExportStats | null = null;
  const options: ExportOptions = { container: 'mp4', scale: 1, fps: project.fps, quality: 'high', includeAudio: false, ...opts };
  const blob = await exportProject(project, options, {
    captureFrames: at,
    onFrame: (i, picture) => drawn.set(i, readPixels(picture)),
    onFallback: (reason) => (fallback = reason),
    onStats: (s) => (stats = s),
  });
  const fps = options.fps > 0 ? options.fps : project.fps;
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('the file has no video track');
    const config = await track.getDecoderConfig();
    const packets = new EncodedPacketSink(track);
    let frames = 0;
    let offGrid = 0;
    let outOfOrder = 0;
    let last = -1;
    const keys: number[] = [];
    for await (const p of packets.packets(undefined, undefined, { metadataOnly: true })) {
      const index = p.timestamp * fps;
      if (Math.abs(index - Math.round(index)) > 0.01) offGrid++;
      if (Math.round(index) !== last + 1) outOfOrder++;
      last = Math.round(index);
      if (p.type === 'key') keys.push(last);
      frames++;
    }
    let widest = 0;
    for (let k = 1; k < keys.length; k++) widest = Math.max(widest, keys[k]! - keys[k - 1]!);
    const audio = await input.getPrimaryAudioTrack();
    let audioPackets = 0;
    if (audio) for await (const p of new EncodedPacketSink(audio).packets(undefined, undefined, { metadataOnly: true })) audioPackets += p ? 1 : 0;
    // decoded pictures against the drawn ones
    const sink = new CanvasSink(track, { poolSize: 1 });
    const psnr: number[] = [];
    let k = 0;
    const want = at.filter((i) => drawn.has(i)).sort((a, b) => a - b);
    for await (const got of sink.canvasesAtTimestamps(want.map((i) => i / fps))) {
      const i = want[k++]!;
      if (!got) continue;
      const a = drawn.get(i)!;
      const b = readPixels(got.canvas as OffscreenCanvas);
      if (a.length !== b.length) {
        psnr.push(0);
        continue;
      }
      let sum = 0;
      for (let p = 0; p < a.length; p += 4) {
        const dr = a[p]! - b[p]!;
        const dg = a[p + 1]! - b[p + 1]!;
        const db = a[p + 2]! - b[p + 2]!;
        sum += dr * dr + dg * dg + db * db;
      }
      const mse = sum / ((a.length / 4) * 3);
      psnr.push(mse === 0 ? 99 : Math.round(10 * Math.log10((255 * 255) / mse) * 100) / 100);
    }
    const s = stats as ExportStats | null;
    return {
      workers: s?.workers ?? 0,
      encoderFps: s?.encoderFps ?? 0,
      onDisk: !!s?.onDisk,
      fallback,
      bytes: blob.size,
      frames,
      expected: s?.frames ?? 0,
      offGrid,
      outOfOrder,
      keyFrames: keys.length,
      widestKeyGap: widest,
      firstKeys: keys.slice(0, 8),
      keys,
      codec: config?.codec ?? '',
      colorSpace: config?.colorSpace ? JSON.stringify(config.colorSpace) : '',
      duration: Math.round((await input.computeDuration()) * 1000) / 1000,
      audioPackets,
      psnrMin: psnr.length ? Math.min(...psnr) : 0,
      psnrMean: psnr.length ? Math.round((psnr.reduce((x, y) => x + y, 0) / psnr.length) * 100) / 100 : 0,
      psnr,
    };
  } finally {
    input.dispose();
  }
}

// ---------- golden frames ----------

interface Golden {
  width: number;
  height: number;
  frames: { key: string; data: Uint8ClampedArray; index?: number }[];
}

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('ncut-bench', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('golden');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function dbPut(name: string, value: Golden): Promise<void> {
  const d = await db();
  await new Promise<void>((resolve, reject) => {
    const tx = d.transaction('golden', 'readwrite');
    tx.objectStore('golden').put(value, name);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  d.close();
}

async function dbGet(name: string): Promise<Golden | undefined> {
  const d = await db();
  const out = await new Promise<Golden | undefined>((resolve, reject) => {
    const q = d.transaction('golden', 'readonly').objectStore('golden').get(name);
    q.onsuccess = () => resolve(q.result as Golden | undefined);
    q.onerror = () => reject(q.error);
  });
  d.close();
  return out;
}

async function dbKeys(): Promise<string[]> {
  const d = await db();
  const out = await new Promise<string[]>((resolve, reject) => {
    const q = d.transaction('golden', 'readonly').objectStore('golden').getAllKeys();
    q.onsuccess = () => resolve(q.result.map(String));
    q.onerror = () => reject(q.error);
  });
  d.close();
  return out;
}

/** copy a (gpu) canvas into a cpu one and read it there */
function readPixels(src: OffscreenCanvas | ImageBitmap): Uint8ClampedArray {
  const c = new OffscreenCanvas(src.width, src.height);
  const x = c.getContext('2d', { willReadFrequently: true })!;
  x.drawImage(src, 0, 0);
  return x.getImageData(0, 0, src.width, src.height).data;
}

interface FrameSet {
  /** timeline seconds for projects without media; frame indices of the export for projects with video */
  at: number[];
  scale?: number;
  /** render through the exporter (needed when the project has video clips) */
  viaExport?: boolean;
  /** with viaExport: parts rendered at once (default 1 = the plain way on this thread, the reference) */
  workers?: number;
  /** with viaExport and workers > 1: the parts on this thread instead of in web workers */
  partsOnMain?: boolean;
  /** with viaExport: the part of the timeline to export (frame indices count from its start) */
  range?: { start: number; end: number };
}

async function grab(project: Project, set: FrameSet): Promise<Golden> {
  const scale = set.scale ?? 0.5;
  const frames: Golden['frames'] = [];
  if (set.viaExport) {
    const want = new Set(set.at);
    let size = { width: 0, height: 0 };
    await exportProject(
      project,
      { container: 'mp4', scale, fps: project.fps, quality: 'low', includeAudio: false, workers: set.workers ?? 1, partsOnMain: set.partsOnMain, range: set.range },
      {
        captureFrames: set.at,
        onFallback: (reason) => {
          throw new Error(`the export fell back to one thread: ${reason}`);
        },
        onFrame: (i, canvas) => {
          if (!want.has(i)) return;
          size = { width: canvas.width, height: canvas.height };
          frames.push({ key: `f${i}`, data: readPixels(canvas), index: i });
        },
      },
    );
    // parts finish in any order
    frames.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return { ...size, frames };
  }
  await ensureProjectFonts(project);
  const { canvas, ctx, width, height } = makeCanvas(project, scale);
  beginExport();
  try {
    for (const t of set.at) {
      // twice: the first drawing of a frame may still be loading a texture
      renderFrame(ctx, project, t, nothing);
      renderFrame(ctx, project, t, nothing);
      frames.push({ key: `t${t}`, data: readPixels(canvas) });
    }
  } finally {
    endExport();
    releaseRenderResources('export');
    canvas.width = 0;
    canvas.height = 0;
  }
  return { width, height, frames };
}

interface Diff {
  key: string;
  /** largest difference of one channel of one pixel, 0..255 */
  max: number;
  /** pixels that differ at all / by more than 2 levels, as a share of the frame */
  differing: number;
  visible: number;
}

function compare(a: Golden, b: Golden): { same: boolean; worst: number; frames: Diff[]; note?: string } {
  if (a.width !== b.width || a.height !== b.height || a.frames.length !== b.frames.length) {
    return { same: false, worst: 255, frames: [], note: `size or frame count changed (${a.width}x${a.height} x${a.frames.length} vs ${b.width}x${b.height} x${b.frames.length})` };
  }
  const out: Diff[] = [];
  let worst = 0;
  for (let f = 0; f < a.frames.length; f++) {
    const x = a.frames[f]!.data;
    const y = b.frames[f]!.data;
    let max = 0;
    let differing = 0;
    let visible = 0;
    for (let i = 0; i < x.length; i += 4) {
      const d = Math.max(Math.abs(x[i]! - y[i]!), Math.abs(x[i + 1]! - y[i + 1]!), Math.abs(x[i + 2]! - y[i + 2]!));
      if (d === 0) continue;
      differing++;
      if (d > 2) visible++;
      if (d > max) max = d;
    }
    const px = x.length / 4;
    worst = Math.max(worst, max);
    out.push({ key: a.frames[f]!.key, max, differing: Math.round((differing / px) * 1e5) / 1e5, visible: Math.round((visible / px) * 1e5) / 1e5 });
  }
  return { same: worst === 0, worst, frames: out.filter((d) => d.max > 0) };
}

const golden = {
  /** store the frames of a project under a name */
  async save(name: string, project: Project, set: FrameSet) {
    const g = await grab(project, set);
    await dbPut(name, g);
    return { name, width: g.width, height: g.height, frames: g.frames.length };
  },
  /** draw the same frames again and compare with what was stored */
  async check(name: string, project: Project, set: FrameSet) {
    const old = await dbGet(name);
    if (!old) return { same: false, worst: 255, frames: [], note: 'nothing stored under this name' };
    return compare(old, await grab(project, set));
  },
  /** draw the frames twice now and compare the two runs (how much does the same build differ from itself?) */
  async noise(project: Project, set: FrameSet) {
    return compare(await grab(project, set), await grab(project, set));
  },
  /** the same frames rendered two ways now (for example { workers: 1 } against { workers: 3 }) */
  async cross(project: Project, set: FrameSet, other: Partial<FrameSet>) {
    return compare(await grab(project, set), await grab(project, { ...set, ...other }));
  },
  keys: dbKeys,
};

export const bench = {
  templates: () => PROJECT_TEMPLATES.map((t) => t.id),
  templateProject,
  footage,
  picture,
  make: { createCameraClip, createClipFromAsset, createEffectClip, createShapeClip, createTextClip, createTrack },
  tone,
  videoProject,
  render,
  export: exportRun,
  lastBlob: () => lastBlob,
  fileCheck,
  golden,
};
