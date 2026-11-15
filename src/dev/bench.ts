/**
 * benchmarks and pixel comparisons, reachable as window.__ncut.bench in dev and bench builds
 * (`vite build --mode bench`). never part of a normal build.
 *
 * - `render`  times renderFrame alone, with the gpu forced to finish every frame
 * - `export`  runs the real exporter and reports where the time went
 * - `litScene` a lit 3d scene (sky, floor, cards, solids, a video screen) with options; { lit: false } is the same scene with no lit field
 * - `skyScene` litScene in front of a labelled skybox ({ alone } keeps a 2d clip under everything, { sky: false } is the baseline)
 * - `coldFrame` the first frame on a fresh renderer against the second: what the lit shader compile costs
 * - `golden`  stores frames in indexeddb ('ncut-bench') and compares later builds against them, so a
 *             speedup can prove that it did not change a single pixel
 */
import { ALL_FORMATS, BlobSource, BufferTarget, CanvasSink, EncodedPacketSink, EncodedVideoPacketSource, Input, Mp4OutputFormat, Output, VideoSampleSink } from 'mediabunny';
import type { Clip, ImageClip, MediaAsset, Project, SceneLight, VideoClip } from '../types';
import { CANVAS_PRESETS, createCameraClip, createClipFromAsset, createEffectClip, createProject, createShapeClip, createTextClip, createTrack } from '../lib/factory';
import { PROJECT_TEMPLATES, getTemplate } from '../lib/templates';
import { ensureProjectFonts } from '../lib/fonts';
import { projectDuration } from '../lib/timelineOps';
import type { DrawSource, SourceResolver } from '../engine/draw';
import { releaseRenderResources, renderFrame } from '../engine/draw';
import { SKY_SIDES, type SkyPicture, skyFaceSize, sourceFaceOf } from '../engine/scene3d/sky';
import { beginExport, endExport } from '../engine/exportState';
import { exportProject, outputSize } from '../features/export/exporter';
import type { ExportOptions, ExportStats } from '../features/export/exporter';
import { importFiles } from '../media/importer';
import { getFilmstrip, getThumbnail, getWaveform, releaseDerived } from '../media/derived';
import { pendingMediaCount, whenMediaStored } from '../storage/pendingMedia';
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

interface LitSceneOptions {
  width?: number;
  height?: number;
  fps?: number;
  /** timeline length in seconds (default 6) */
  seconds?: number;
  /** false = the very same scene with no lit field anywhere: the baseline (default true) */
  lit?: boolean;
  /** an own light (project.light with a sun) instead of the light taken from the scene */
  own?: boolean;
  /** fog matching the horizon (default true) */
  fog?: boolean;
  /** standing cards (default 6) */
  cards?: number;
  /** a box, a ball and a can (default true) */
  solids?: boolean;
  /** footage for a lit 3d video screen (bench.footage()). a project with video renders through bench.export or golden viaExport */
  video?: MediaAsset;
  /** motion blur samples on the moving video screen (needs video). missing / 0 = none */
  motionBlur?: number;
  /** the lit clips switch their light on at this time (lit keys 0 until then): for the first lit frame hitch */
  litFrom?: number;
}

const LIT_CARD_COLORS: [string, string][] = [
  ['#e8d9b5', '#a3643a'],
  ['#9ad1ff', '#27408b'],
  ['#ffb3a1', '#a33a2b'],
  ['#b9e6b0', '#3d7a34'],
  ['#d7b3ff', '#5b2b9e'],
  ['#ffe08a', '#a37a12'],
];

type LitKeys = Record<string, { t: number; v: number; ease: 'linear' }[]>;

/** a lit 3d scene: a sky behind, a floor, cards, solids and maybe a video screen. lit: false is the same scene with no lit field at all */
function litScene(o: LitSceneOptions = {}): Project {
  const width = o.width ?? 1920;
  const height = o.height ?? 1080;
  const fps = o.fps ?? 60;
  const seconds = o.seconds ?? 6;
  const lit = o.lit ?? true;
  const u = Math.min(width, height) / 1080;
  const p = createProject('bench lit', preset(width, height), fps);
  p.tracks = [];
  const clips: Clip[] = [];
  const add = (name: string) => {
    const track = createTrack('video', name);
    p.tracks.push(track);
    return track.id;
  };
  /** the lit field of a clip: nothing when lit is off, plus keys when it switches on later */
  const litOf = (v: number): { lit?: number; keys: LitKeys } => {
    if (!lit) return { keys: {} };
    if (o.litFrom === undefined || o.litFrom <= 0.001) return { lit: v, keys: {} };
    const from = o.litFrom;
    return {
      lit: v,
      keys: {
        lit: [
          { t: 0, v: 0, ease: 'linear' },
          { t: Math.max(0.001, from - 0.001), v: 0, ease: 'linear' },
          { t: from, v, ease: 'linear' },
        ],
      },
    };
  };

  clips.push(
    createCameraClip(add('camera'), 0, {
      duration: seconds,
      tilt: -10,
      y: -200 * u,
      keyframes: {
        x: [
          { t: 0, v: -0.25 * width, ease: 'linear' },
          { t: seconds, v: 0.25 * width, ease: 'linear' },
        ],
        pan: [
          { t: 0, v: 18, ease: 'linear' },
          { t: seconds, v: -18, ease: 'linear' },
        ],
      },
    }),
  );

  if (o.video) {
    const asset = o.video;
    const c = createClipFromAsset(asset, add('screen'), 0) as VideoClip;
    c.duration = Math.min(seconds, asset.duration);
    c.threeD = true;
    c.transform = { ...c.transform, scale: Math.max(width / Math.max(1, asset.width), height / Math.max(1, asset.height)) * 0.4, z: 150 * u, y: -60 * u };
    const l = litOf(0.75);
    if (l.lit !== undefined) c.lit = l.lit;
    const keyframes: LitKeys = { ...l.keys };
    if ((o.motionBlur ?? 0) > 0) {
      keyframes.x = [
        { t: 0, v: -0.25 * width, ease: 'linear' },
        { t: c.duration, v: 0.25 * width, ease: 'linear' },
      ];
      keyframes.rotY = [
        { t: 0, v: -30, ease: 'linear' },
        { t: c.duration, v: 30, ease: 'linear' },
      ];
      c.motionBlur = { shutter: 0.5, samples: o.motionBlur! };
    }
    if (Object.keys(keyframes).length) c.keyframes = keyframes;
    clips.push(c);
  }

  const n = Math.max(0, o.cards ?? 6);
  for (let i = 0; i < n; i++) {
    const [color, color2] = LIT_CARD_COLORS[i % LIT_CARD_COLORS.length]!;
    const l = litOf(0.75);
    clips.push(
      createShapeClip(add(`card ${i + 1}`), 0, {
        duration: seconds,
        name: `card ${i + 1}`,
        kind: 'rect',
        width: 300 * u,
        height: 200 * u,
        color,
        color2,
        gradientAngle: 60,
        threeD: true,
        ...(l.lit !== undefined ? { lit: l.lit } : {}),
        ...(Object.keys(l.keys).length ? { keyframes: l.keys } : {}),
        transform: { x: (i - (n - 1) / 2) * 340 * u, y: -40 * u, scale: 1, rotation: 0, opacity: 1, z: (400 + (i % 2) * 160) * u, rotY: (i - (n - 1) / 2) * -8 },
      }),
    );
  }

  if (o.solids ?? true) {
    const solid = (name: string, shape: 'box' | 'sphere' | 'cylinder', x: number, color: string, color2: string) => {
      const l = litOf(1);
      clips.push(
        createShapeClip(add(name), 0, {
          duration: seconds,
          name,
          kind: 'rect',
          width: 300 * u,
          height: 300 * u,
          color,
          color2,
          gradientAngle: 90,
          threeD: true,
          shape,
          shapeDepth: 300 * u,
          ...(l.lit !== undefined ? { lit: l.lit } : {}),
          keyframes: {
            ...l.keys,
            rotY: [
              { t: 0, v: 0, ease: 'linear' },
              { t: seconds, v: 360, ease: 'linear' },
            ],
          },
          transform: { x: x * u, y: 60 * u, scale: 1, rotation: 0, opacity: 1, z: 0, rotY: 0 },
        }),
      );
    };
    solid('box', 'box', -520, '#f2f2f2', '#6b7078');
    solid('ball', 'sphere', 0, '#ffe14d', '#b3541e');
    solid('can', 'cylinder', 520, '#9ad1ff', '#27408b');
  }

  {
    const l = litOf(1);
    clips.push(
      createShapeClip(add('floor'), 0, {
        duration: seconds,
        name: 'floor',
        kind: 'rect',
        width: 2600 * u,
        height: 1800 * u,
        color: '#cfc8b8',
        color2: '#7d776b',
        gradientRadial: true,
        threeD: true,
        ...(l.lit !== undefined ? { lit: l.lit } : {}),
        ...(Object.keys(l.keys).length ? { keyframes: l.keys } : {}),
        transform: { x: 0, y: 215 * u, scale: 1, rotation: 0, opacity: 1, z: 0, rotX: 90 },
      }),
    );
  }
  // the sky: a flat 2d gradient under everything
  clips.push(
    createShapeClip(add('sky'), 0, {
      duration: seconds,
      name: 'sky',
      kind: 'rect',
      width,
      height,
      color: '#2d4470',
      color2: '#e7b98f',
      gradientAngle: 90,
    }),
  );
  p.tracks.push(createTrack('audio', 'audio 1'));
  p.clips = clips;
  p.background = '#1a2230';
  if (o.fog ?? true) p.fog = { color: '#e7b98f', near: 1800 * u, far: 7000 * u, amount: 0.4 };
  if (o.own && lit) p.light = { sky: '#8fa9d6', horizon: '#e7c9a8', ground: '#4a4038', sun: 0.5, sunColor: '#fff1d6', sunTurn: -35, sunHeight: 40 };
  if (o.video) p.assets = [o.video];
  return p;
}

/** px nx py ny pz nz: red, cyan, sky blue, brown, green, magenta (notes/sky/make-cube.js) */
const BENCH_SKY_COLORS = ['#d03030', '#30c0c0', '#a0c8ff', '#604020', '#30b030', '#c030c0'];
/** a fixed light for the labelled sky (the measured one would come from the media package) */
const BENCH_SKY_LIGHT: SceneLight = { sky: '#a0c8ff', horizon: '#808080', ground: '#604020', sun: 0, sunColor: '#fff4e0', sunTurn: -35, sunHeight: 45 };
const benchSkies = new Map<number, SkyPicture>();

/** six labelled sides of size x size: the color, the side name in bold black in the middle, a white square top left */
function benchSky(size: number): SkyPicture {
  const have = benchSkies.get(size);
  if (have) return have;
  const faces = SKY_SIDES.map((name, i) => {
    const c = new OffscreenCanvas(size, size);
    const x = c.getContext('2d')!;
    x.fillStyle = BENCH_SKY_COLORS[i]!;
    x.fillRect(0, 0, size, size);
    x.fillStyle = '#000000';
    x.font = `bold ${Math.round(size * 0.28)}px sans-serif`;
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.fillText(name, size / 2, size / 2);
    x.fillStyle = '#ffffff';
    x.fillRect(size / 32, size / 32, size / 8, size / 8);
    return c;
  });
  // kept for the next run: close does nothing
  const pic: SkyPicture = { key: `bench|${size}`, size, faces, close() {} };
  benchSkies.set(size, pic);
  return pic;
}

interface SkySceneOptions extends LitSceneOptions {
  /** the side of the sky pictures in pixels (default 1024) */
  face?: number;
  /** true: keep the 2d gradient under everything, so the sky is drawn alone (and hidden) */
  alone?: boolean;
  turn?: number;
  brightness?: number;
  blur?: number;
  /** false: the same scene without a sky (the baseline) */
  sky?: boolean;
}

/** litScene in front of the labelled sky: six image media (no files, the bench resolver hands the pictures) and project.sky on them */
function skyScene(o: SkySceneOptions = {}): Project {
  const p = litScene(o);
  if (o.sky === false) return p;
  if (!o.alone) {
    const gone = p.clips.find((c) => c.name === 'sky');
    if (gone) {
      p.clips = p.clips.filter((c) => c !== gone);
      p.tracks = p.tracks.filter((t) => t.id !== gone.trackId);
    }
  }
  const face = o.face ?? 1024;
  const ids = SKY_SIDES.map((s) => `bench-sky-${s}`);
  const assets: MediaAsset[] = SKY_SIDES.map((s, i) => ({
    id: ids[i]!,
    name: `bench_${s}.png`,
    kind: 'image',
    mime: 'image/png',
    size: 0,
    duration: 0,
    width: face,
    height: face,
    hasAudio: false,
    createdAt: 0,
  }));
  p.assets = [...p.assets, ...assets];
  p.sky = { faces: ids, turn: o.turn ?? 0, brightness: o.brightness ?? 1, blur: o.blur ?? 0, light: BENCH_SKY_LIGHT };
  return p;
}

/** what the bench draws pictures with: nothing for a project without a sky (exactly as before), plus the labelled sky */
function resolverFor(project: Project): SourceResolver {
  if (!project.sky) return nothing;
  const size = skyFaceSize(sourceFaceOf(project.sky, project.assets), project.height);
  return Object.assign((_clip: VideoClip | ImageClip, _t: number): DrawSource | null => null, { sky: () => benchSky(size) });
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
  const resolve = resolverFor(project);
  const { canvas, ctx } = makeCanvas(project, o.scale ?? 1);
  const flush = o.flush === false ? null : makeProbe();
  const from = o.from ?? 0;
  const to = o.to ?? projectDuration(project);
  const n = Math.max(1, o.frames ?? 120);
  const times: number[] = [];
  beginExport();
  try {
    // warm up: shaders, textures, fonts
    renderFrame(ctx, project, from, resolve);
    flush?.(canvas);
    for (let i = 0; i < n; i++) {
      const t = from + ((to - from) * i) / n;
      const t0 = performance.now();
      renderFrame(ctx, project, t, resolve);
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

/**
 * the first frame on a fresh renderer against the second one: what a shader compile and the first uploads cost. the lit
 * compile is the hitch of a lit scene minus the hitch of the same scene with lit off (a truly cold number needs a fresh
 * browser profile)
 */
async function coldFrame(project: Project, o: { time?: number; scale?: number } = {}) {
  await ensureProjectFonts(project);
  const resolve = resolverFor(project);
  const { canvas, ctx } = makeCanvas(project, o.scale ?? 1);
  const probe = makeProbe();
  const time = o.time ?? 0;
  const r = (v: number) => Math.round(v * 100) / 100;
  beginExport();
  try {
    // a fresh 3d renderer: its programs compile inside the timed frame
    releaseRenderResources('export');
    const t0 = performance.now();
    renderFrame(ctx, project, time, resolve);
    probe(canvas);
    const cold = performance.now() - t0;
    const t1 = performance.now();
    renderFrame(ctx, project, time, resolve);
    probe(canvas);
    const warm = performance.now() - t1;
    return { coldMs: r(cold), warmMs: r(warm), hitchMs: r(cold - warm) };
  } finally {
    endExport();
    releaseRenderResources('export');
    canvas.width = 0;
    canvas.height = 0;
  }
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
  const resolve = resolverFor(project);
  const { canvas, ctx, width, height } = makeCanvas(project, scale);
  beginExport();
  try {
    for (const t of set.at) {
      // twice: the first drawing of a frame may still be loading a texture
      renderFrame(ctx, project, t, resolve);
      renderFrame(ctx, project, t, resolve);
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
  litScene,
  skyScene,
  coldFrame,
  render,
  export: exportRun,
  lastBlob: () => lastBlob,
  fileCheck,
  golden,
  /** thumbnails, filmstrips and waveforms as the editor asks for them, and the copy of imported files into storage */
  derived: { getFilmstrip, getThumbnail, getWaveform, releaseDerived },
  stored: { pendingMediaCount, whenMediaStored },
  /** the media library itself, for timing experiments from a script */
  mb: { ALL_FORMATS, BlobSource, BufferTarget, CanvasSink, EncodedPacketSink, EncodedVideoPacketSource, Input, Mp4OutputFormat, Output, VideoSampleSink },
};
