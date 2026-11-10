/**
 * the frame renderer. draws one frame of a project onto a 2d canvas (effect clips run on the gpu, see engine/effects).
 * shared by the live preview and the exporter so both always look the same.
 * it does not know where pixels come from: the caller passes a resolver that returns the
 * current image for a video/image clip (a <video>, <img>, ImageBitmap, VideoFrame, canvas...).
 */
import type { EffectClip, ImageClip, Project, TextClip, Transform, VideoClip, VisualClip } from '../types';
import { isVisualClip } from '../types';
import { clipEnd, fadeFactor, sourceTimeAt } from '../lib/timelineOps';
import { resolveClip } from '../lib/anim';
import { getEffect } from './effects/registry';
import { renderEffects } from './effects/runner';
import type { EffectPass } from './effects/types';
import { type Camera3D, type CameraRig, DEFAULT_CAMERA, cameraAt, cameraClipAt, cameraFromClip, cameraRig, frustumCorners, homeDistance } from './scene3d/camera';
import { clipModelMatrix } from './scene3d/model';
import { type Lines3D, type Plane3D, renderScene } from './scene3d/renderer';

export interface DrawSource {
  image: CanvasImageSource;
  /** natural size of the image in pixels */
  width: number;
  height: number;
}

/**
 * return the picture for a clip at a source time (seconds into the asset; 0 for images),
 * or null when it is not available (still loading / missing) - the clip is skipped.
 */
export type SourceResolver = (clip: VideoClip | ImageClip, sourceTime: number) => DrawSource | null;

/** axis-aligned box of a clip before rotation, in canvas pixels. cx/cy is the center. */
export interface ClipBox {
  cx: number;
  cy: number;
  width: number;
  height: number;
  /** degrees */
  rotation: number;
}

export const TEXT_LINE_HEIGHT = 1.25;
/** padding of the text background box, as a fraction of the font size */
export const TEXT_PADDING = 0.3;

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

let measureCtx: Ctx | null = null;
function getMeasureCtx(): Ctx {
  if (measureCtx) return measureCtx;
  if (typeof OffscreenCanvas !== 'undefined') {
    measureCtx = new OffscreenCanvas(8, 8).getContext('2d');
  }
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  if (!measureCtx) throw new Error('2d canvas is not available');
  return measureCtx;
}

export function textFont(clip: Pick<TextClip, 'italic' | 'fontWeight' | 'fontSize' | 'fontFamily'>): string {
  return `${clip.italic ? 'italic ' : ''}${clip.fontWeight} ${clip.fontSize}px "${clip.fontFamily}", "Noto Sans", sans-serif`;
}

/** unscaled size of a text clip's box (text + padding) and its lines */
export function measureText(clip: TextClip): { width: number; height: number; lines: string[]; lineHeight: number; pad: number } {
  const ctx = getMeasureCtx();
  ctx.font = textFont(clip);
  const lines = (clip.text.length > 0 ? clip.text : ' ').split('\n');
  let max = 0;
  for (const line of lines) max = Math.max(max, ctx.measureText(line).width);
  const lineHeight = clip.fontSize * TEXT_LINE_HEIGHT;
  const pad = clip.fontSize * TEXT_PADDING;
  return { width: max + pad * 2, height: lines.length * lineHeight + pad * 2, lines, lineHeight, pad };
}

/** size of a media clip at transform.scale = 1: the largest size that fits inside the canvas */
export function containSize(srcW: number, srcH: number, canvasW: number, canvasH: number): { width: number; height: number } {
  if (srcW <= 0 || srcH <= 0) return { width: canvasW, height: canvasH };
  const s = Math.min(canvasW / srcW, canvasH / srcH);
  return { width: srcW * s, height: srcH * s };
}

/**
 * where a visual clip sits on the canvas. for video/image clips pass the asset's natural size
 * (falls back to the asset metadata in the project, then to the full canvas).
 */
export function getClipBox(project: Project, clip: VisualClip, natural?: { width: number; height: number }): ClipBox {
  const t: Transform = clip.transform;
  let width: number;
  let height: number;
  if (clip.type === 'text') {
    const m = measureText(clip);
    width = m.width * t.scale;
    height = m.height * t.scale;
  } else {
    let nat = natural;
    if (!nat) {
      const asset = project.assets.find((a) => a.id === clip.assetId);
      if (asset && asset.width > 0 && asset.height > 0) nat = { width: asset.width, height: asset.height };
    }
    const fit = containSize(nat?.width ?? project.width, nat?.height ?? project.height, project.width, project.height);
    width = fit.width * t.scale;
    height = fit.height * t.scale;
  }
  return { cx: project.width / 2 + t.x, cy: project.height / 2 + t.y, width, height, rotation: t.rotation };
}

/** visual clips under a time in paint order (bottom layer first). skips hidden tracks. */
export function visibleClipsAt(project: Project, time: number): VisualClip[] {
  const out: VisualClip[] = [];
  for (let i = project.tracks.length - 1; i >= 0; i--) {
    const track = project.tracks[i]!;
    if (track.kind !== 'video' || track.hidden) continue;
    for (const clip of project.clips) {
      if (clip.trackId !== track.id || !isVisualClip(clip)) continue;
      if (time >= clip.start - 1e-6 && time < clipEnd(clip) - 1e-6) out.push(clip);
    }
  }
  return out;
}

/**
 * everything that paints at a time, bottom layer first: visual clips and effect clips.
 * an effect clip changes the picture made by the items before it. skips hidden tracks.
 */
export function paintListAt(project: Project, time: number): (VisualClip | EffectClip)[] {
  const out: (VisualClip | EffectClip)[] = [];
  for (let i = project.tracks.length - 1; i >= 0; i--) {
    const track = project.tracks[i]!;
    if (track.kind !== 'video' || track.hidden) continue;
    for (const clip of project.clips) {
      if (clip.trackId !== track.id || (clip.type !== 'effect' && !isVisualClip(clip))) continue;
      if (time >= clip.start - 1e-6 && time < clipEnd(clip) - 1e-6) out.push(clip);
    }
  }
  return out;
}

/** true when at least one effect clip on a visible track is active at the time */
export function hasEffectsAt(project: Project, time: number): boolean {
  for (const clip of project.clips) {
    if (clip.type !== 'effect' || time < clip.start - 1e-6 || time >= clipEnd(clip) - 1e-6) continue;
    const track = project.tracks.find((t) => t.id === clip.trackId);
    if (track && !track.hidden) return true;
  }
  return false;
}

/** the gpu pass for an effect clip at a time, or null (unknown effect, faded to nothing) */
export function effectPassAt(raw: EffectClip, time: number): EffectPass | null {
  const def = getEffect(raw.effect);
  if (!def) return null;
  const clip = resolveClip(raw, time);
  const amount = clip.amount * fadeFactor(clip, time);
  if (!(amount > 0.001)) return null;
  return { def, time: Math.max(0, time - clip.start), duration: clip.duration, amount, seed: clip.seed, params: clip.params };
}

/** run effect passes over what is already on the canvas and put the result back */
function applyEffects(ctx: Ctx, project: Project, passes: EffectPass[]): void {
  const canvas = ctx.canvas as (HTMLCanvasElement | OffscreenCanvas) | undefined;
  if (!canvas || passes.length === 0) return;
  const offscreen = typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas;
  const out = renderEffects(canvas, canvas.width, canvas.height, passes, {
    projectWidth: project.width,
    projectHeight: project.height,
    // the export draws on an OffscreenCanvas and can run while the preview is on screen
    channel: offscreen ? 'export' : 'default',
  });
  if (!out) return;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'copy';
  ctx.drawImage(out, 0, 0, canvas.width, canvas.height);
  ctx.restore();
}

/** true when the canvas point (px, py) is inside the clip's rotated box */
export function hitTestBox(box: ClipBox, px: number, py: number): boolean {
  const rad = (-box.rotation * Math.PI) / 180;
  const dx = px - box.cx;
  const dy = py - box.cy;
  const lx = dx * Math.cos(rad) - dy * Math.sin(rad);
  const ly = dx * Math.sin(rad) + dy * Math.cos(rad);
  return Math.abs(lx) <= box.width / 2 && Math.abs(ly) <= box.height / 2;
}

function drawText(ctx: Ctx, clip: TextClip): void {
  const m = measureText(clip);
  const s = clip.transform.scale;
  ctx.scale(s, s);
  if (clip.background) {
    ctx.fillStyle = clip.background;
    ctx.fillRect(-m.width / 2, -m.height / 2, m.width, m.height);
  }
  ctx.font = textFont(clip);
  ctx.fillStyle = clip.color;
  ctx.textBaseline = 'middle';
  ctx.textAlign = clip.align;
  const innerW = m.width - m.pad * 2;
  const x = clip.align === 'left' ? -innerW / 2 : clip.align === 'right' ? innerW / 2 : 0;
  const top = -m.height / 2 + m.pad;
  for (let i = 0; i < m.lines.length; i++) {
    ctx.fillText(m.lines[i]!, x, top + m.lineHeight * (i + 0.5));
  }
}

/* ---------- 3d ---------- */

interface Layer3D {
  clip: VisualClip;
  source: DrawSource | null;
  alpha: number;
}

const textTextures = new Map<string, { sig: string; canvas: HTMLCanvasElement | OffscreenCanvas; key: string }>();
let textTextureSerial = 0;

/** a text clip rendered to its own canvas (cached until the text or its style changes) for use as a 3d texture */
function textTexture(clip: TextClip): { canvas: HTMLCanvasElement | OffscreenCanvas; key: string } | null {
  const m = measureText(clip);
  // enough pixels for the size it is shown at, within reason
  const q = Math.min(4, Math.max(1, clip.transform.scale * 1.5), 4096 / Math.max(m.width, m.height, 1));
  const w = Math.max(2, Math.ceil(m.width * q));
  const h = Math.max(2, Math.ceil(m.height * q));
  const sig = [clip.text, clip.fontFamily, clip.fontSize, clip.fontWeight, clip.italic, clip.color, clip.background, clip.align, w, h].join('|');
  const hit = textTextures.get(clip.id);
  if (hit && hit.sig === sig) return hit;
  let canvas: HTMLCanvasElement | OffscreenCanvas;
  if (typeof OffscreenCanvas !== 'undefined') canvas = new OffscreenCanvas(w, h);
  else if (typeof document !== 'undefined') {
    canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
  } else return null;
  const c = canvas.getContext('2d') as Ctx | null;
  if (!c) return null;
  c.translate(w / 2, h / 2);
  c.scale(q, q);
  drawText(c, { ...clip, transform: { ...clip.transform, scale: 1 } });
  const entry = { sig, canvas, key: `text:${clip.id}:${++textTextureSerial}` };
  textTextures.set(clip.id, entry);
  if (textTextures.size > 64) {
    const first = textTextures.keys().next().value;
    if (first !== undefined) textTextures.delete(first);
  }
  return entry;
}

function planeFor(project: Project, layer: Layer3D, rig: CameraRig): Plane3D | null {
  const { clip, source } = layer;
  const box = getClipBox(project, clip, source ? { width: source.width, height: source.height } : undefined);
  const model = clipModelMatrix(box, clip.transform, clip.lookAt, rig.eye);
  if (clip.type === 'text') {
    const t = textTexture(clip);
    return t ? { image: t.canvas, cacheKey: t.key, model, alpha: layer.alpha } : null;
  }
  if (!source) return null;
  // still images keep their texture between frames, video uploads every frame
  const cacheKey = clip.type === 'image' ? `img:${clip.assetId}:${source.width}x${source.height}` : undefined;
  return { image: source.image as TexImageSource, cacheKey, model, alpha: layer.alpha };
}

/** render a run of 3d clips through the camera and lay the result over what is already on the canvas */
function draw3d(ctx: Ctx, project: Project, layers: Layer3D[], rig: CameraRig, lines: Lines3D[] = []): void {
  const canvas = ctx.canvas as (HTMLCanvasElement | OffscreenCanvas) | undefined;
  if (!canvas) return;
  const planes: Plane3D[] = [];
  for (const layer of layers) {
    const p = planeFor(project, layer, rig);
    if (p) planes.push(p);
  }
  const offscreen = typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas;
  const out = renderScene(planes, lines, rig.viewProj, rig.eye, canvas.width, canvas.height, offscreen ? 'export' : 'default');
  if (!out) return;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.drawImage(out, 0, 0, canvas.width, canvas.height);
  ctx.restore();
}

export interface RenderOptions {
  /** look through this camera instead of the project's camera clips */
  camera?: Camera3D;
}

/**
 * draw the whole frame at `time`. the context must belong to a canvas of project.width x project.height
 * (or be pre-scaled so that those are its logical units).
 */
export function renderFrame(ctx: Ctx, project: Project, time: number, resolve: SourceResolver, opts: RenderOptions = {}): void {
  let rig: CameraRig | null = null;
  const getRig = (): CameraRig => (rig ??= cameraRig(opts.camera ?? cameraAt(project, time), project.width, project.height));
  // consecutive 3d clips share one depth sorted scene. a 2d clip or an effect in between splits it.
  let bin: Layer3D[] = [];
  const flush3d = () => {
    if (bin.length === 0) return;
    draw3d(ctx, project, bin, getRig());
    bin = [];
  };
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = project.background || '#000000';
  ctx.fillRect(0, 0, project.width, project.height);

  // effect clips stack up until the next picture is drawn on top of them (or the frame ends),
  // then run together in one gpu round trip
  let pending: EffectPass[] = [];
  for (const raw of paintListAt(project, time)) {
    if (raw.type === 'effect') {
      const pass = effectPassAt(raw, time);
      if (pass) {
        flush3d();
        pending.push(pass);
      }
      continue;
    }
    if (pending.length > 0) {
      applyEffects(ctx, project, pending);
      pending = [];
    }
    // keyframes baked in. the resolver still gets the stored clip (it is keyed by identity).
    const clip = resolveClip(raw, time);
    const alpha = clip.transform.opacity * fadeFactor(clip, time);
    if (alpha <= 0.001) continue;

    let source: DrawSource | null = null;
    if (raw.type !== 'text') {
      source = resolve(raw, raw.type === 'video' ? sourceTimeAt(raw, time) : 0);
      if (!source) continue;
    }
    if (clip.threeD) {
      bin.push({ clip, source, alpha });
      continue;
    }
    flush3d();
    const box = getClipBox(project, clip, source ? { width: source.width, height: source.height } : undefined);

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(box.cx, box.cy);
    if (box.rotation) ctx.rotate((box.rotation * Math.PI) / 180);
    if (clip.type === 'text') {
      drawText(ctx, clip);
    } else if (source) {
      try {
        ctx.drawImage(source.image, -box.width / 2, -box.height / 2, box.width, box.height);
      } catch {
        // a source that is not ready (e.g. a video with no decoded frame yet) is skipped
      }
    }
    ctx.restore();
  }
  flush3d();
  if (pending.length > 0) applyEffects(ctx, project, pending);
  ctx.restore();
}

/**
 * the scene view: the 3d world seen from a free editor camera instead of the project camera.
 * shows every active 3d clip as a plane, the output frame (the canvas rectangle at z = 0), a floor grid
 * and the project camera as a wire pyramid. 2d clips and effects are screen space and are not drawn.
 * `lineColor` is straight rgba 0..1 for the helpers (pass a theme color).
 */
export function renderSceneView(
  ctx: Ctx,
  project: Project,
  time: number,
  resolve: SourceResolver,
  viewCamera: Camera3D,
  lineColor: [number, number, number, number] = [1, 1, 1, 0.5],
): void {
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = project.background || '#000000';
  ctx.fillRect(0, 0, project.width, project.height);
  ctx.restore();

  const W = project.width;
  const H = project.height;
  const rig = cameraRig(viewCamera, W, H);
  const layers: Layer3D[] = [];
  for (const raw of paintListAt(project, time)) {
    if (raw.type === 'effect') continue;
    const clip = resolveClip(raw, time);
    if (!clip.threeD) continue;
    const alpha = clip.transform.opacity * fadeFactor(clip, time);
    if (alpha <= 0.001) continue;
    let source: DrawSource | null = null;
    if (raw.type !== 'text') {
      source = resolve(raw, raw.type === 'video' ? sourceTimeAt(raw, time) : 0);
      if (!source) continue;
    }
    layers.push({ clip, source, alpha });
  }

  const dim: [number, number, number, number] = [lineColor[0], lineColor[1], lineColor[2], lineColor[3] * 0.35];
  const seg = (out: number[], a: readonly number[], b: readonly number[]) => out.push(a[0]!, a[1]!, a[2]!, b[0]!, b[1]!, b[2]!);
  // floor grid at the bottom edge of the canvas
  const grid: number[] = [];
  const step = H / 4;
  const x0 = W / 2 - step * 12;
  const x1 = W / 2 + step * 12;
  const z0 = -step * 6;
  const z1 = step * 18;
  for (let i = 0; i <= 24; i++) {
    seg(grid, [x0 + i * step, H, z0], [x0 + i * step, H, z1]);
    seg(grid, [x0, H, z0 + i * step], [x1, H, z0 + i * step]);
  }
  // the output frame
  const frame: number[] = [];
  seg(frame, [0, 0, 0], [W, 0, 0]);
  seg(frame, [W, 0, 0], [W, H, 0]);
  seg(frame, [W, H, 0], [0, H, 0]);
  seg(frame, [0, H, 0], [0, 0, 0]);
  // the project camera
  const camClip = cameraClipAt(project, time);
  const camRig = cameraRig(camClip ? cameraFromClip(camClip, time) : DEFAULT_CAMERA, W, H);
  const far = frustumCorners(camRig, homeDistance(H));
  for (let i = 0; i < 4; i++) {
    seg(frame, camRig.eye, far[i]!);
    seg(frame, far[i]!, far[(i + 1) % 4]!);
  }
  draw3d(ctx, project, layers, rig, [
    { points: grid, color: dim },
    { points: frame, color: lineColor },
  ]);
}
