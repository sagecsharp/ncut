/**
 * benchmarks and pixel comparisons, reachable as window.__ncut.bench in dev and bench builds
 * (`vite build --mode bench`). never part of a normal build.
 *
 * - `render`  times renderFrame alone, with the gpu forced to finish every frame
 * - `export`  runs the real exporter and reports where the time went
 * - `golden`  stores frames in indexeddb ('ncut-bench') and compares later builds against them, so a
 *             speedup can prove that it did not change a single pixel
 */
import type { Clip, MediaAsset, Project, VideoClip } from '../types';
import { CANVAS_PRESETS, createClipFromAsset, createEffectClip, createProject, createTextClip, createTrack } from '../lib/factory';
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

interface VideoProjectOptions {
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
  p.tracks.push(createTrack('audio', 'audio 1'));
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

/** run the real exporter and report its stage times. the file is thrown away. */
async function exportRun(project: Project, o: Partial<ExportOptions> = {}) {
  let stats: ExportStats | null = null;
  const warnings: string[] = [];
  const t0 = performance.now();
  const blob = await exportProject(
    project,
    { container: 'mp4', scale: 1, fps: project.fps, quality: 'high', includeAudio: false, ...o },
    { onStats: (s) => (stats = s), onWarning: (w) => warnings.push(w) },
  );
  const ms = performance.now() - t0;
  const s = stats as ExportStats | null;
  const r = (v: number) => Math.round(v);
  return {
    ms: r(ms),
    bytes: blob.size,
    type: blob.type,
    framesPerSecond: s ? Math.round((s.frames / ms) * 1000 * 10) / 10 : 0,
    stats: s ? { ...s, setupMs: r(s.setupMs), decodeMs: r(s.decodeMs), renderMs: r(s.renderMs), encodeMs: r(s.encodeMs), audioMs: r(s.audioMs), finalizeMs: r(s.finalizeMs), totalMs: r(s.totalMs) } : null,
    warnings,
  };
}

// ---------- golden frames ----------

interface Golden {
  width: number;
  height: number;
  frames: { key: string; data: Uint8ClampedArray }[];
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
function readPixels(src: OffscreenCanvas): Uint8ClampedArray {
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
}

async function grab(project: Project, set: FrameSet): Promise<Golden> {
  const scale = set.scale ?? 0.5;
  const frames: Golden['frames'] = [];
  if (set.viaExport) {
    const want = new Set(set.at);
    let size = { width: 0, height: 0 };
    await exportProject(
      project,
      { container: 'mp4', scale, fps: project.fps, quality: 'low', includeAudio: false },
      {
        onFrame: (i, canvas) => {
          if (!want.has(i)) return;
          size = { width: canvas.width, height: canvas.height };
          frames.push({ key: `f${i}`, data: readPixels(canvas) });
        },
      },
    );
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
  keys: dbKeys,
};

export const bench = {
  templates: () => PROJECT_TEMPLATES.map((t) => t.id),
  templateProject,
  footage,
  videoProject,
  render,
  export: exportRun,
  golden,
};
