/**
 * the frame renderer. draws one frame of a project onto a 2d canvas (effects, transitions and 3d
 * clips run on the gpu, see engine/effects, engine/transitions and engine/scene3d).
 * shared by the live preview and the exporter so both always look the same.
 * it does not know where pixels come from: the caller passes a resolver that returns the
 * current image for a video/image clip (a <video>, <img>, ImageBitmap, VideoFrame, canvas...).
 */
import type { BlendMode, Clip, ClipMotionBlur, Crop, EffectClip, ImageClip, Project, ShapeClip, TextClip, Transform, VideoClip, VisualClip } from '../types';
import { isVisualClip } from '../types';
import { clipEnd, fadeFactor, sourceTimeAt } from '../lib/timelineOps';
import { resolveClip } from '../lib/anim';
import { blurPlan } from './blurStyle';
import { applyClipMotion, hasClipMotion } from './clipAnim';
import { type TargetIndex, effectsOnClip, isTargetedEffect, targetIndex } from './clipFx';
import { resolveCounter } from './counter';
import { clipLookSignature, clipLookTexture, hasClipLook, releaseClipLook } from './clipLook';
import { hasMask, maskSignature, maskedPicture, releaseMaskResources } from './mask';
import { clipLookPoint, parentModelMatrix, worldTransformOf } from './parent';
import { type TransitionSpan, transitionSpan } from '../lib/transitions';
import { getEffect } from './effects/registry';
import { releaseEffectRunner, renderEffects } from './effects/runner';
import type { EffectPass, TemporalSample } from './effects/types';
import { type Camera3D, type CameraRig, DEFAULT_CAMERA, cameraAt, cameraClipAt, cameraFromClip, cameraRig, frustumCorners, homeDistance } from './scene3d/camera';
import { mul, scaling, translation } from './scene3d/math';
import { clipModelMatrix } from './scene3d/model';
import { type Lines3D, type Plane3D, releaseSceneRenderer, renderScene } from './scene3d/renderer';
import { drawShape, shapeSignature, shapeSpill } from './shape';
import { drawText, measureText, textSignature, textSpill } from './text';
import { textAnimActive } from './textAnim';
import { getTransition } from './transitions/registry';
import { easeTransition, releaseTransitionRunner, renderTransition } from './transitions/runner';

export { TEXT_LINE_HEIGHT, TEXT_PADDING, measureText, textFont } from './text';

/**
 * free what the renderer keeps for a channel (scratch canvases, cached textures). the exporter calls
 * it with 'export' when a render ends so a big export does not stay in memory.
 */
export function releaseRenderResources(channel: 'preview' | 'export'): void {
  const prefix = (channel === 'export' ? 'export' : 'default') + ':';
  for (const [key, sc] of scratches) {
    if (!key.startsWith(prefix)) continue;
    // a zero sized canvas gives its backing store back right away
    if (sc) {
      sc.canvas.width = 0;
      sc.canvas.height = 0;
    }
    scratches.delete(key);
  }
  const lc: LookChannel = channel === 'export' ? 'export' : 'preview';
  releaseMaskResources(lc);
  releaseClipLook(lc);
  const gl = channel === 'export' ? 'export' : 'default';
  releaseSceneRenderer(gl);
  releaseEffectRunner(gl);
  releaseTransitionRunner(gl);
  // the per clip copies made for 3d are shared by both channels (keyed by clip id): emptying them is safe, the next
  // plane that needs one rebuilds it (and gets a new texture key)
  emptyCopies(lookCopies);
  emptyCopies(maskCopies);
  // the text / shape texture caches are shared by both channels (the gl runners key their uploads on them),
  // so they stay. they are bounded (64 entries) and pruned when the project changes.
}

/** shrink the canvas of every copy and forget them */
function emptyCopies(map: Map<string, { canvas: AnyCanvas }>): void {
  for (const c of map.values()) {
    c.canvas.width = 0;
    c.canvas.height = 0;
  }
  map.clear();
}

export interface DrawSource {
  image: CanvasImageSource;
  /** natural size of the image in pixels */
  width: number;
  height: number;
}

/**
 * the real pixel size of a picture, for the source rectangle of drawImage (which is in pixels of the image itself).
 * the preview decodes big pictures into a smaller bitmap but reports the natural size in DrawSource, so the size is
 * read from the image: naturalWidth (img), videoWidth (video), displayWidth (VideoFrame), width (bitmap, canvas).
 * falls back to the given size when the object has none of them.
 */
export function imagePixelSize(image: unknown, fallbackW: number, fallbackH: number): { w: number; h: number } {
  const o = image as Record<string, unknown> | null | undefined;
  if (o && typeof o === 'object') {
    const pick = (keys: string[]): number => {
      for (const k of keys) {
        const v = o[k];
        if (typeof v === 'number' && v > 0 && Number.isFinite(v)) return v;
      }
      return 0;
    };
    const w = pick(['naturalWidth', 'videoWidth', 'displayWidth', 'width']);
    const h = pick(['naturalHeight', 'videoHeight', 'displayHeight', 'height']);
    if (w > 0 && h > 0) return { w, h };
  }
  return { w: fallbackW, h: fallbackH };
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

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

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
  } else if (clip.type === 'shape') {
    width = Math.max(1, clip.width) * t.scale;
    height = Math.max(1, clip.height) * t.scale;
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

/**
 * getClipBox that follows clip.parent: the box where the clip really is at a time. `clip` has its keyframes
 * applied (same as for getClipBox). without a parent this is getClipBox itself.
 */
export function getClipBoxWorld(project: Project, clip: VisualClip, time: number, natural?: { width: number; height: number }): ClipBox {
  if (!clip.parent) return getClipBox(project, clip, natural);
  const wt = worldTransformOf(project, clip, time);
  return getClipBox(project, wt === clip.transform ? clip : ({ ...clip, transform: wt } as VisualClip), natural);
}

/* ---------- per-clip motion blur ---------- */

/** most copies a clip's motion blur averages */
export const MAX_MOTION_BLUR_SAMPLES = 32;

/**
 * the timeline moments a clip's motion blur averages: `samples` times spread evenly over the open shutter,
 * [time - shutter / fps / 2, time + shutter / fps / 2], ends included. empty when there is no blur to do.
 * quality < 1 (the live preview) uses proportionally fewer copies, never fewer than 2.
 */
export function motionBlurTimes(time: number, fps: number, blur: ClipMotionBlur | null | undefined, quality = 1): number[] {
  if (!blur || !(fps > 0)) return [];
  const shutter = Math.min(2, blur.shutter);
  if (!(shutter > 0)) return [];
  let n = Math.min(MAX_MOTION_BLUR_SAMPLES, Math.floor(blur.samples));
  if (!(n >= 2)) return [];
  if (quality < 1) n = Math.max(2, Math.ceil(n * Math.max(0.1, quality)));
  const half = shutter / fps / 2;
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(time - half + (2 * half * i) / (n - 1));
  return out;
}

/* ---------- blend, crop, radius (pure helpers) ---------- */

/** the smallest share of a clip that always stays after cropping, per axis */
const MIN_KEPT = 0.01;

/** canvas composite operation for a blend mode, or null for 'normal' / missing (the plain path) */
export function blendOp(mode: BlendMode | undefined): GlobalCompositeOperation | null {
  if (!mode || mode === 'normal') return null;
  return mode === 'add' ? 'lighter' : mode;
}

/**
 * a crop with every edge clamped to 0..1 and at least 1% left on each axis (both edges shrink in
 * proportion when they would eat more). null when nothing is cut, so callers can take the plain path.
 */
export function normalizeCrop(crop: Crop | null | undefined): Crop | null {
  if (!crop) return null;
  const f = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
  let { left, right, top, bottom } = { left: f(crop.left), right: f(crop.right), top: f(crop.top), bottom: f(crop.bottom) };
  const max = 1 - MIN_KEPT;
  if (left + right > max) {
    const k = max / (left + right);
    left *= k;
    right *= k;
  }
  if (top + bottom > max) {
    const k = max / (top + bottom);
    top *= k;
    bottom *= k;
  }
  if (!(left > 0 || right > 0 || top > 0 || bottom > 0)) return null;
  return { left, top, right, bottom };
}

/** the kept rectangle of a width x height box, with the origin at the box center (x, y = its top left corner) */
export interface KeptRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** what stays of a box after the (normalized) crop. null crop = the whole box. */
export function cropRect(width: number, height: number, crop: Crop | null | undefined): KeptRect {
  const c = normalizeCrop(crop);
  if (!c) return { x: -width / 2, y: -height / 2, width, height };
  return {
    x: -width / 2 + c.left * width,
    y: -height / 2 + c.top * height,
    width: width * (1 - c.left - c.right),
    height: height * (1 - c.top - c.bottom),
  };
}

/** corner radius in pixels for a 0..1 roundness of a w x h rectangle (1 = fully round ends) */
export function radiusPx(radius: number | undefined, w: number, h: number): number {
  if (!radius || !(radius > 0)) return 0;
  return (Math.min(1, radius) * Math.min(w, h)) / 2;
}

/** the plane-local crop of a 3d texture that has `pad` extra pixels around the clip box (text / shape) */
function paddedCrop(c: Crop, innerW: number, innerH: number, padX: number, padY: number): Crop {
  const fullW = innerW + padX * 2;
  const fullH = innerH + padY * 2;
  // an edge that is not cut keeps the extra room (outlines, shadows), a cut edge cuts at the clip box
  return {
    left: c.left > 0 ? (padX + c.left * innerW) / fullW : 0,
    right: c.right > 0 ? (padX + c.right * innerW) / fullW : 0,
    top: c.top > 0 ? (padY + c.top * innerH) / fullH : 0,
    bottom: c.bottom > 0 ? (padY + c.bottom * innerH) / fullH : 0,
  };
}

/** path of a rounded rectangle (arcs, so it works in every canvas) */
function roundedRectPath(ctx: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  const k = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + k, y);
  ctx.arcTo(x + w, y, x + w, y + h, k);
  ctx.arcTo(x + w, y + h, x, y + h, k);
  ctx.arcTo(x, y + h, x, y, k);
  ctx.arcTo(x, y, x + w, y, k);
  ctx.closePath();
}

/**
 * the clips of each track in project order, grouped once per clips array (the store replaces the array on every
 * edit, so identity is the cache key; the length guards against in-place pushes). the per-frame paint walks used
 * to scan every clip of the project once per track.
 */
const EMPTY_CLIPS: readonly Clip[] = [];
const clipsByTrackCache = new WeakMap<object, { n: number; map: Map<string, Clip[]> }>();
function clipsOnTrack(project: Project, trackId: string): readonly Clip[] {
  const arr = project.clips;
  let hit = clipsByTrackCache.get(arr);
  if (!hit || hit.n !== arr.length) {
    const map = new Map<string, Clip[]>();
    for (const c of arr) {
      const list = map.get(c.trackId);
      if (list) list.push(c);
      else map.set(c.trackId, [c]);
    }
    hit = { n: arr.length, map };
    clipsByTrackCache.set(arr, hit);
  }
  return hit.map.get(trackId) ?? EMPTY_CLIPS;
}

/**
 * text clips whose counter number was written into their text (see resolveVisual). the 3d texture cache reads this:
 * a text that changes every frame must not get a new cached gl texture every frame.
 */
const counterTexts = new WeakSet<object>();

/**
 * a clip with its keyframes and its ready-made motions applied at a time, and (text) its counter number written
 * into the text. `counterTime` = the time the counter reads when it is not `time` (the sub-times of a motion blur
 * draw the number of the real frame: only the placement is blurred, not the picture).
 */
function resolveVisual<T extends VisualClip>(raw: T, time: number, project: Project, counterTime = time): T {
  const r = resolveClip(raw, time);
  const m = hasClipMotion(raw) ? applyClipMotion(r, time, project) : r;
  if (m.type === 'text' && m.counter) {
    const c = resolveCounter(m as TextClip, counterTime);
    counterTexts.add(c);
    return c as unknown as T;
  }
  return m;
}

/** visual clips under a time in paint order (bottom layer first). skips hidden tracks. */
export function visibleClipsAt(project: Project, time: number): VisualClip[] {
  const out: VisualClip[] = [];
  for (let i = project.tracks.length - 1; i >= 0; i--) {
    const track = project.tracks[i]!;
    if (track.kind !== 'video' || track.hidden) continue;
    for (const clip of clipsOnTrack(project, track.id)) {
      if (!isVisualClip(clip)) continue;
      if (time >= clip.start - 1e-6 && time < clipEnd(clip) - 1e-6) out.push(clip);
    }
  }
  return out;
}

/**
 * every visual clip whose picture is needed to draw the frame at a time: the visible clips plus the
 * frozen side of each running transition (the clip that just ended or is about to start).
 * the preview and the exporter use it to know which sources to keep ready.
 */
export function neededClipsAt(project: Project, time: number): VisualClip[] {
  const out = visibleClipsAt(project, time);
  for (const clip of project.clips) {
    if (!isVisualClip(clip) || !clip.transition) continue;
    const span = transitionSpan(project, clip);
    if (!span || time < span.start - 1e-6 || time >= span.end - 1e-6) continue;
    const track = project.tracks.find((t) => t.id === clip.trackId);
    if (!track || track.hidden) continue;
    if (!out.includes(span.to)) out.push(span.to);
    if (span.from && !out.includes(span.from)) out.push(span.from);
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
    for (const clip of clipsOnTrack(project, track.id)) {
      if (clip.type !== 'effect' && !isVisualClip(clip)) continue;
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

/** the gpu pass for an effect clip at a time, or null (unknown effect, temporal effect, faded to nothing) */
export function effectPassAt(raw: EffectClip, time: number): EffectPass | null {
  const def = getEffect(raw.effect);
  if (!def || def.temporal) return null;
  const clip = resolveClip(raw, time);
  const amount = clip.amount * fadeFactor(clip, time);
  if (!(amount > 0.001)) return null;
  return { def, time: Math.max(0, time - clip.start + (raw.timeOffset ?? 0)), duration: raw.fullDuration ?? clip.duration, amount, seed: clip.seed, params: clip.params };
}

type Channel = 'default' | 'export';

function channelOf(ctx: Ctx): Channel {
  const canvas = ctx.canvas as AnyCanvas | undefined;
  // the export draws on an OffscreenCanvas and can run while the preview is on screen
  return typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas ? 'export' : 'default';
}

/** run effect passes over what is already on the canvas and put the result back */
function applyEffects(ctx: Ctx, project: Project, passes: EffectPass[], channel: Channel): void {
  const canvas = ctx.canvas as AnyCanvas | undefined;
  if (!canvas || passes.length === 0) return;
  const out = renderEffects(canvas, canvas.width, canvas.height, passes, {
    projectWidth: project.width,
    projectHeight: project.height,
    channel,
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

/* ---------- scratch canvases ---------- */

interface Scratch {
  canvas: AnyCanvas;
  ctx: Ctx;
}
const scratches = new Map<string, Scratch | null>();

/**
 * a helper canvas with the same size and transform as the canvas of `like`, kept per channel + name.
 * precise = a canvas that sums samples (motion blur, echo): half float pixels where the browser has them. an
 * 8 bit canvas rounds every added share, so 12 samples of a dark flat color come out as 12 x round(v / 12):
 * level 5 turns black, level 7 turns 12. with float pixels the sum is exact and rounds once at the end.
 * browsers without it fall back to 8 bit (same picture in preview and export either way: same browser).
 */
function scratchFor(like: Ctx, channel: Channel, name: string, precise = false): Scratch | null {
  const src = like.canvas as AnyCanvas | undefined;
  if (!src) return null;
  const key = `${channel}:${name}`;
  let sc = scratches.get(key);
  if (sc === undefined) {
    let canvas: AnyCanvas | null = null;
    if (typeof OffscreenCanvas !== 'undefined') canvas = new OffscreenCanvas(src.width, src.height);
    else if (typeof document !== 'undefined') canvas = document.createElement('canvas');
    let c: Ctx | null = null;
    if (canvas && precise) {
      try {
        // unknown attributes are ignored by older browsers: they hand back a plain 8 bit context
        c = (canvas as OffscreenCanvas).getContext('2d', { colorType: 'float16' } as CanvasRenderingContext2DSettings) as Ctx | null;
      } catch {
        c = null;
      }
    }
    if (canvas && !c) c = canvas.getContext('2d') as Ctx | null;
    sc = canvas && c ? { canvas, ctx: c } : null;
    scratches.set(key, sc);
  }
  if (!sc) return null;
  if (sc.canvas.width !== src.width || sc.canvas.height !== src.height) {
    sc.canvas.width = src.width;
    sc.canvas.height = src.height;
  }
  if (typeof like.getTransform === 'function') sc.ctx.setTransform(like.getTransform());
  return sc;
}

function clearScratch(sc: Scratch): void {
  sc.ctx.save();
  sc.ctx.setTransform(1, 0, 0, 1, 0, 0);
  sc.ctx.clearRect(0, 0, sc.canvas.width, sc.canvas.height);
  sc.ctx.restore();
  sc.ctx.globalAlpha = 1;
  sc.ctx.globalCompositeOperation = 'source-over';
}

/* ---------- 3d ---------- */

export interface Layer3D {
  clip: VisualClip;
  source: DrawSource | null;
  alpha: number;
  /** timeline seconds this layer is shown at (drives text animations) */
  time: number;
}

interface TextTexture {
  sig: string;
  canvas: AnyCanvas;
  key: string | undefined;
  /** unscaled pixels of extra room around the text box on every side */
  margin: number;
}
const textTextures = new Map<string, TextTexture>();
let textTextureSerial = 0;

/**
 * texture resolution factor for 3d text: 1, 2 or 4 pixels per unit by how big it is shown, capped by the max
 * texture size. stepped (not continuous) so an animated scale does not make a new canvas + gl upload every frame.
 */
export function textureQuality(scale: number, fullW: number, fullH: number): number {
  const want = scale * 1.5;
  const step = want <= 1 ? 1 : want <= 2 ? 2 : 4;
  return Math.min(step, 4096 / Math.max(fullW, fullH, 1));
}

/**
 * a text clip rendered to its own canvas for use as a 3d texture. cached until the text or its style
 * changes; while a text animation runs it is redrawn every frame (key undefined = upload every frame).
 */
function textTexture(clip: TextClip, time: number): TextTexture | null {
  const m = measureText(clip);
  const local = time - clip.start;
  const animated = textAnimActive(clip, local);
  // the same room whether or not the animation is running right now, so the plane never changes size
  const margin = textSpill(clip, !!(clip.animIn || clip.animOut || clip.animLoop)) * clip.fontSize;
  const fullW = m.width + margin * 2;
  const fullH = m.height + margin * 2;
  // enough pixels for the size it is shown at, within reason
  const q = textureQuality(clip.transform.scale, fullW, fullH);
  const w = Math.max(2, Math.ceil(fullW * q));
  const h = Math.max(2, Math.ceil(fullH * q));
  const sig = animated ? '' : textSignature(clip) + '|' + w + '|' + h;
  const hit = textTextures.get(clip.id);
  if (hit && !animated && hit.sig === sig) {
    // most recently used goes last, so the first key is the one to evict
    textTextures.delete(clip.id);
    textTextures.set(clip.id, hit);
    return hit;
  }
  let canvas: AnyCanvas | null = hit && hit.canvas.width === w && hit.canvas.height === h ? hit.canvas : null;
  if (!canvas) {
    if (typeof OffscreenCanvas !== 'undefined') canvas = new OffscreenCanvas(w, h);
    else if (typeof document !== 'undefined') {
      canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
    } else return null;
  }
  const c = canvas.getContext('2d') as Ctx | null;
  if (!c) return null;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.globalAlpha = 1;
  c.clearRect(0, 0, w, h);
  c.translate(w / 2, h / 2);
  c.scale(q, q);
  drawText(c, { ...clip, transform: { ...clip.transform, scale: 1 } }, animated ? local : undefined);
  // a counter text changes all the time: no cache key (the gl side uploads it every frame and keeps no copy),
  // so the changing numbers cannot fill the texture cache. the 2d canvas here is replaced per clip id as before.
  const live = animated || counterTexts.has(clip);
  const entry: TextTexture = { sig, canvas, key: live ? undefined : `text:${clip.id}:${++textTextureSerial}`, margin };
  textTextures.delete(clip.id);
  textTextures.set(clip.id, entry);
  if (textTextures.size > 64) {
    const first = textTextures.keys().next().value;
    if (first !== undefined) textTextures.delete(first);
  }
  return entry;
}

/* ---------- shape clips as textures (3d) ---------- */

interface ShapeTexture {
  sig: string;
  canvas: AnyCanvas;
  key: string;
  /** room around the shape for its outline, in canvas pixels at scale 1 */
  margin: number;
}
const shapeTextures = new Map<string, ShapeTexture>();
let shapeTextureSerial = 0;
const SHAPE_TEXTURE_MAX = 2048;

function shapeTexture(clip: ShapeClip): ShapeTexture | null {
  const margin = Math.ceil(shapeSpill(clip));
  const fullW = Math.max(1, clip.width) + margin * 2;
  const fullH = Math.max(1, clip.height) + margin * 2;
  // drawn at the size it has on screen at scale 1, capped so a huge shape stays a sane texture
  const q = Math.min(2, SHAPE_TEXTURE_MAX / Math.max(fullW, fullH));
  const w = Math.max(1, Math.ceil(fullW * q));
  const h = Math.max(1, Math.ceil(fullH * q));
  const sig = shapeSignature(clip) + '|' + w + 'x' + h;
  const hit = shapeTextures.get(clip.id);
  if (hit && hit.sig === sig) {
    shapeTextures.delete(clip.id);
    shapeTextures.set(clip.id, hit);
    return hit;
  }
  let canvas: AnyCanvas | null = hit && hit.canvas.width === w && hit.canvas.height === h ? hit.canvas : null;
  if (!canvas) {
    if (typeof OffscreenCanvas !== 'undefined') canvas = new OffscreenCanvas(w, h);
    else if (typeof document !== 'undefined') {
      canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
    } else return null;
  }
  const c = canvas.getContext('2d') as Ctx | null;
  if (!c) return null;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.globalAlpha = 1;
  c.clearRect(0, 0, w, h);
  c.translate(w / 2, h / 2);
  c.scale(q, q);
  drawShape(c, clip, Math.max(1, clip.width), Math.max(1, clip.height), 1);
  const entry: ShapeTexture = { sig, canvas, key: 'shape:' + clip.id + ':' + ++shapeTextureSerial, margin };
  shapeTextures.delete(clip.id);
  shapeTextures.set(clip.id, entry);
  if (shapeTextures.size > 64) {
    const first = shapeTextures.keys().next().value;
    if (first !== undefined) shapeTextures.delete(first);
  }
  return entry;
}

/** the clips array the texture caches were last checked against */
let cacheClips: readonly Clip[] | null = null;

/** drop cached textures of clips that are not in the project any more (checked when the clips array changes) */
function syncTextureCaches(project: Project): void {
  if (project.clips === cacheClips) return;
  cacheClips = project.clips;
  if (textTextures.size === 0 && shapeTextures.size === 0 && lookCopies.size === 0 && maskCopies.size === 0) return;
  const ids = new Set<string>();
  for (const c of project.clips) ids.add(c.id);
  for (const id of [...lookCopies.keys()]) if (!ids.has(id)) lookCopies.delete(id);
  for (const id of [...maskCopies.keys()]) if (!ids.has(id)) maskCopies.delete(id);
  for (const id of [...textTextures.keys()]) if (!ids.has(id)) textTextures.delete(id);
  for (const id of [...shapeTextures.keys()]) if (!ids.has(id)) shapeTextures.delete(id);
}

/* ---------- clip look (color correction / chroma key) ---------- */

type LookChannel = 'preview' | 'export';
const lookChannel = (c: Channel): LookChannel => (c === 'export' ? 'export' : 'preview');

/** a flat picture to draw. pad (text / shape pictures) = room around the clip box on every side, in pixels at scale 1 */
type FlatSource = DrawSource & {
  pad?: number;
  /** pixel size of `image` when it is not width x height any more (the look caps at 4096, the mask at 2048). crop reads pixels, so it needs these. */
  pw?: number;
  ph?: number;
};

/**
 * the clip's look, then its mask, on a picture. returns `source` itself (no allocation) when the clip has neither.
 * only valid until the next call on the same channel: draw it right away.
 */
function processed(source: FlatSource, clip: VisualClip, channel: Channel): FlatSource {
  let out = source;
  if (hasClipLook(clip)) {
    const image = clipLookTexture(out.image, out.width, out.height, clip, lookChannel(channel));
    if (image !== out.image) {
      const c = image as AnyCanvas;
      out = { ...out, image, pw: c.width || out.width, ph: c.height || out.height };
    }
  }
  if (hasMask(clip)) {
    const image = maskedPicture(out.image, out.pw ?? out.width, out.ph ?? out.height, clip, lookChannel(channel));
    if (image !== out.image) {
      const c = image as AnyCanvas;
      out = { ...out, image, pw: c.width || out.width, ph: c.height || out.height };
    }
  }
  return out;
}

/**
 * true for a text clip with an extrude drawn below full alpha. the extruded side is many copies of the text: drawn
 * straight at a globalAlpha under 1 each copy is composited at that alpha and the side comes out nearly solid while the
 * face fades. such a clip takes the flat picture path (text at alpha 1 into its own canvas, drawn once with the alpha).
 * alpha 1 and clips without extrude keep the direct path.
 */
export function extrudeFades(clip: VisualClip, alpha: number): boolean {
  return clip.type === 'text' && !!clip.extrude && clip.extrude.depth > 0 && alpha < 0.999;
}

/**
 * the picture a flat clip is drawn from: a video / image source with look and mask applied. a text / shape clip
 * with a look or a mask is first rendered into its texture (the one 3d uses), then looked and masked; without
 * either it returns null and is drawn directly.
 */
function prepareFlat(project: Project, clip: VisualClip, source: DrawSource | null, time: number, channel: Channel, alpha = 1): FlatSource | null {
  if (clip.type === 'text' || clip.type === 'shape') {
    if (!hasClipLook(clip) && !hasMask(clip) && !extrudeFades(clip, alpha)) return null;
    syncTextureCaches(project);
    const t = clip.type === 'text' ? textTexture(clip, time) : shapeTexture(clip);
    if (!t) return null;
    return processed({ image: t.canvas, width: t.canvas.width, height: t.canvas.height, pad: t.margin }, clip, channel);
  }
  return source ? processed(source, clip, channel) : null;
}

/**
 * 3d: the looked picture is copied into a canvas of the clip's own, because several planes are uploaded after
 * all of them were built and clipLookTexture reuses one canvas. a still source (key given) is only redone when
 * the look or the source key changes; the returned key then changes with it.
 */
interface LookCopy {
  sig: string;
  srcKey: string | undefined;
  canvas: AnyCanvas;
  key: string | undefined;
}
const lookCopies = new Map<string, LookCopy>();
let lookSerial = 0;

function lookedTexture(
  clip: VisualClip,
  image: TexImageSource,
  w: number,
  h: number,
  key: string | undefined,
  channel: Channel,
): { image: TexImageSource; key: string | undefined } {
  const sig = clipLookSignature(clip);
  const hit = lookCopies.get(clip.id);
  if (key !== undefined && hit && hit.srcKey === key && hit.sig === sig && hit.canvas.width === w && hit.canvas.height === h) {
    return { image: hit.canvas, key: hit.key };
  }
  const out = clipLookTexture(image as CanvasImageSource, w, h, clip, lookChannel(channel));
  if (out === (image as CanvasImageSource)) return { image, key };
  let canvas: AnyCanvas | null = hit && hit.canvas.width === w && hit.canvas.height === h ? hit.canvas : null;
  if (!canvas) {
    if (typeof OffscreenCanvas !== 'undefined') canvas = new OffscreenCanvas(w, h);
    else if (typeof document !== 'undefined') {
      canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
    } else return { image: out as TexImageSource, key: undefined };
  }
  const c = canvas.getContext('2d') as Ctx | null;
  if (!c) return { image: out as TexImageSource, key: undefined };
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.globalAlpha = 1;
  c.globalCompositeOperation = 'copy';
  c.drawImage(out, 0, 0, w, h);
  const outKey = key === undefined ? undefined : `look:${clip.id}:${++lookSerial}`;
  lookCopies.delete(clip.id);
  lookCopies.set(clip.id, { sig, srcKey: key, canvas, key: outKey });
  if (lookCopies.size > 32) {
    const first = lookCopies.keys().next().value;
    if (first !== undefined) lookCopies.delete(first);
  }
  return { image: canvas as TexImageSource, key: outKey };
}

/** 3d: the masked picture of a clip, copied for the same reason as lookedTexture (maskedPicture reuses one canvas per channel) */
interface MaskCopy {
  sig: string;
  srcKey: string | undefined;
  w: number;
  h: number;
  canvas: AnyCanvas;
  key: string | undefined;
}
const maskCopies = new Map<string, MaskCopy>();
let maskSerial = 0;

function maskedTexture(
  clip: VisualClip,
  image: TexImageSource,
  w: number,
  h: number,
  key: string | undefined,
  channel: Channel,
): { image: TexImageSource; key: string | undefined } {
  const sig = maskSignature(clip);
  const hit = maskCopies.get(clip.id);
  if (key !== undefined && hit && hit.srcKey === key && hit.sig === sig && hit.w === w && hit.h === h) {
    return { image: hit.canvas, key: hit.key };
  }
  const out = maskedPicture(image as CanvasImageSource, w, h, clip, lookChannel(channel));
  if (out === (image as CanvasImageSource)) return { image, key };
  const oc = out as AnyCanvas;
  const ow = oc.width;
  const oh = oc.height;
  let canvas: AnyCanvas | null = hit && hit.canvas.width === ow && hit.canvas.height === oh ? hit.canvas : null;
  if (!canvas) {
    if (typeof OffscreenCanvas !== 'undefined') canvas = new OffscreenCanvas(ow, oh);
    else if (typeof document !== 'undefined') {
      canvas = document.createElement('canvas');
      canvas.width = ow;
      canvas.height = oh;
    } else return { image: out as TexImageSource, key: undefined };
  }
  const c = canvas.getContext('2d') as Ctx | null;
  if (!c) return { image: out as TexImageSource, key: undefined };
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.globalAlpha = 1;
  c.globalCompositeOperation = 'copy';
  c.drawImage(out, 0, 0);
  const outKey = key === undefined ? undefined : `mask:${clip.id}:${++maskSerial}`;
  maskCopies.delete(clip.id);
  maskCopies.set(clip.id, { sig, srcKey: key, w, h, canvas, key: outKey });
  if (maskCopies.size > 32) {
    const first = maskCopies.keys().next().value;
    if (first !== undefined) maskCopies.delete(first);
  }
  return { image: canvas as TexImageSource, key: outKey };
}

export function planeFor(project: Project, layer: Layer3D, rig: CameraRig, channel: Channel = 'default'): Plane3D | null {
  syncTextureCaches(project);
  const { clip, source } = layer;
  const box = getClipBox(project, clip, source ? { width: source.width, height: source.height } : undefined);
  const shape = clip.shape ?? 'plane';
  let image: TexImageSource;
  let cacheKey: string | undefined;
  // extra texture room around the clip box (text / shape), in canvas pixels
  let pad = 0;
  // size in pixels of the picture, for the clip look (0 = unknown)
  let lw = 0;
  let lh = 0;
  if (clip.type === 'text') {
    const t = textTexture(clip, layer.time);
    if (!t) return null;
    // the texture has room around the text for outlines, shadows and moving letters
    pad = t.margin * clip.transform.scale;
    box.width += pad * 2;
    box.height += pad * 2;
    image = t.canvas;
    cacheKey = t.key;
    lw = t.canvas.width;
    lh = t.canvas.height;
  } else if (clip.type === 'shape') {
    const t = shapeTexture(clip);
    if (!t) return null;
    pad = t.margin * clip.transform.scale;
    box.width += pad * 2;
    box.height += pad * 2;
    image = t.canvas;
    cacheKey = t.key;
    lw = t.canvas.width;
    lh = t.canvas.height;
  } else {
    if (!source) return null;
    lw = source.width;
    lh = source.height;
    image = source.image as TexImageSource;
    // still images keep their texture between frames, video uploads every frame
    // (the preview decodes big pictures smaller and re-decodes when the project grows: the key follows the real pixels,
    // so a sharper decode replaces the texture and an export never reuses a copy made from the preview's smaller one)
    const px = image as { width?: number; height?: number };
    cacheKey = clip.type === 'image' ? `img:${clip.assetId}:${px.width || source.width}x${px.height || source.height}` : undefined;
  }
  if (lw > 0 && lh > 0 && hasClipLook(clip)) {
    const looked = lookedTexture(clip, image, lw, lh, cacheKey, channel);
    image = looked.image;
    cacheKey = looked.key;
  }
  // the mask comes after the look and before crop / radius / placement
  if (lw > 0 && lh > 0 && hasMask(clip)) {
    const masked = maskedTexture(clip, image, lw, lh, cacheKey, channel);
    image = masked.image;
    cacheKey = masked.key;
  }
  let model = clipModelMatrix(
    box,
    clip.transform,
    clip.lookAt,
    rig.eye,
    clip.parent ? parentModelMatrix(project, clip, layer.time) : null,
    clip.lookAt === 'clip' ? clipLookPoint(project, clip, layer.time) : null,
  );
  let uv: [number, number, number, number] | undefined;
  let radius: number | undefined;
  let size: [number, number] | undefined;
  const crop = normalizeCrop(clip.crop);
  if (crop) {
    let c = crop;
    if (pad > 0) {
      // the texture has room around the clip box: crop relative to the clip box, not to the texture
      c = paddedCrop(crop, box.width - pad * 2, box.height - pad * 2, pad, pad);
    }
    uv = [c.left, c.top, 1 - c.left - c.right, 1 - c.top - c.bottom];
    // a plane shrinks to the kept rectangle, offset inside its local box so it stays in place under
    // rotation. box / sphere / cylinder only show the kept window of the picture, stretched over the
    // whole surface (the geometry keeps its size).
    if (shape === 'plane') {
      model = mul(mul(model, translation((c.left - c.right) / 2, (c.top - c.bottom) / 2, 0)), scaling(uv[2], uv[3], 1));
    }
  }
  // rounded corners: planes of video / image only (a rect shape is rounded inside its own texture,
  // text has backgroundRadius, wraps keep their geometry)
  if (shape === 'plane' && (clip.type === 'video' || clip.type === 'image') && clip.radius && clip.radius > 0) {
    const kw = uv ? box.width * uv[2] : box.width;
    const kh = uv ? box.height * uv[3] : box.height;
    radius = radiusPx(clip.radius, kw, kh);
    size = [kw, kh];
  }
  if (shape !== 'plane') {
    // thickness: a box is as deep as the clip is tall unless set, round shapes are as deep as they are wide
    const fallback = shape === 'box' ? box.height : box.width;
    const depth = clip.shapeDepth !== undefined && clip.shapeDepth > 0 && shape !== 'sphere' ? clip.shapeDepth * clip.transform.scale : fallback;
    model = mul(model, scaling(1, 1, Math.max(1, depth)));
  }
  const plane: Plane3D = { image, cacheKey, model, alpha: layer.alpha, shape };
  if (uv) plane.uv = uv;
  if (radius && size) {
    plane.radius = radius;
    plane.size = size;
  }
  return plane;
}

const NO_LINES: Lines3D[] = [];

/**
 * render a run of 3d clips through the camera and lay the result over what is already on the canvas.
 * `op` is how the result mixes with the canvas (a clip with a blend mode is drawn as a run of its own,
 * see paintLayers: it does not depth-test against its neighbours).
 */
function draw3d(ctx: Ctx, project: Project, layers: Layer3D[], rig: CameraRig, channel: Channel, lines: Lines3D[] = NO_LINES, op: GlobalCompositeOperation = 'source-over'): void {
  const canvas = ctx.canvas as AnyCanvas | undefined;
  if (!canvas) return;
  const planes: Plane3D[] = [];
  for (const layer of layers) {
    const p = planeFor(project, layer, rig, channel);
    if (p) planes.push(p);
  }
  const out = renderScene(planes, lines, rig.viewProj, rig.eye, canvas.width, canvas.height, channel, project.fog ?? null);
  if (!out) return;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = op;
  ctx.drawImage(out, 0, 0, canvas.width, canvas.height);
  ctx.restore();
}

/* ---------- the frame ---------- */

export interface RenderOptions {
  /** look through this camera instead of the project's camera clips */
  camera?: Camera3D;
  /**
   * 1 = full quality (export). lower = the live preview may cut corners that cost time and are hard
   * to see in motion (fewer motion blur samples). default 1.
   */
  quality?: number;
}

type PaintItem =
  | { kind: 'clip'; clip: VisualClip; track: number }
  | { kind: 'effect'; clip: EffectClip; track: number }
  | { kind: 'transition'; span: TransitionSpan; track: number };

/**
 * everything that paints at a time, bottom layer first, for the tracks BELOW track index `above`
 * (-1 = all tracks). a running transition replaces the clip(s) it blends.
 */
function paintItemsAt(project: Project, time: number, above: number): PaintItem[] {
  const out: PaintItem[] = [];
  for (let i = project.tracks.length - 1; i > above; i--) {
    const track = project.tracks[i]!;
    if (track.kind !== 'video' || track.hidden) continue;
    let natural: VisualClip | EffectClip | null = null;
    let span: TransitionSpan | null = null;
    for (const clip of clipsOnTrack(project, track.id)) {
      if (clip.type === 'effect') {
        // an effect with a target is not an adjustment layer: it is run on its clip, see paintWithFx
        if (isTargetedEffect(clip)) continue;
        if (time >= clip.start - 1e-6 && time < clipEnd(clip) - 1e-6) natural = clip;
        continue;
      }
      if (!isVisualClip(clip)) continue;
      if (clip.transition && !span) {
        const sp = transitionSpan(project, clip);
        if (sp && time >= sp.start - 1e-6 && time < sp.end - 1e-6 && getTransition(sp.id)) span = sp;
      }
      if (time >= clip.start - 1e-6 && time < clipEnd(clip) - 1e-6) natural = clip;
    }
    if (span) out.push({ kind: 'transition', span, track: i });
    else if (natural) out.push(natural.type === 'effect' ? { kind: 'effect', clip: natural, track: i } : { kind: 'clip', clip: natural, track: i });
  }
  return out;
}

interface Env {
  resolve: SourceResolver;
  opts: RenderOptions;
  channel: Channel;
  quality: number;
  /** how many temporal effects deep this pass is */
  depth: number;
  /** the effects that sit on one clip, null when the project has none (the old path, nothing extra runs) */
  fx: TargetIndex | null;
}

/** temporal effects nested deeper than this are ignored (each level multiplies the work) */
const MAX_TEMPORAL_DEPTH = 2;

/** the moments a temporal effect clip (motion blur, echo) blends at a time, or null when it does nothing */
function temporalSamples(raw: EffectClip, time: number, fps: number, quality: number): TemporalSample[] | null {
  const def = getEffect(raw.effect);
  if (!def || !def.temporal) return null;
  const clip = resolveClip(raw, time);
  const amount = clip.amount * fadeFactor(clip, time);
  if (!(amount > 0.001)) return null;
  const params: Record<string, number> = {};
  for (const p of def.params) {
    const v = clip.params[p.key];
    params[p.key] = typeof v === 'number' && Number.isFinite(v) ? v : p.default;
  }
  const samples = def.temporal(params, Math.min(1, amount), fps, quality, time).filter((sm) => sm.weight > 0);
  if (samples.length < 2) return null;
  return pruneSamples(samples);
}

/**
 * how far the temporal effects (motion blur, echo, frame blend, strobe) that are on at a time reach into the
 * past and the future, in seconds (both >= 0), or null when none is on. effects stacked on each other add up.
 * the export uses it to keep the pictures of clips that only show in those other moments (around a cut).
 */
export function temporalReach(project: Project, time: number, quality = 1): { back: number; ahead: number } | null {
  let back = 0;
  let ahead = 0;
  let any = false;
  for (const track of project.tracks) {
    if (track.kind !== 'video' || track.hidden) continue;
    for (const clip of project.clips) {
      if (clip.type !== 'effect' || clip.trackId !== track.id || clip.target) continue;
      if (time < clip.start - 1e-6 || time >= clipEnd(clip) - 1e-6) continue;
      const samples = temporalSamples(clip, time, project.fps || 30, quality);
      if (!samples) continue;
      let lo = 0;
      let hi = 0;
      for (const sm of samples) {
        if (sm.offset < lo) lo = sm.offset;
        if (sm.offset > hi) hi = sm.offset;
      }
      back -= lo;
      ahead += hi;
      any = true;
    }
  }
  return any ? { back, ahead } : null;
}

/**
 * drop samples whose share of the total weight is below 1/512 (they cannot change an 8-bit pixel) but
 * always keep the largest one, then renormalize so the weights add up to 1. order is kept.
 */
export function pruneSamples(samples: TemporalSample[]): TemporalSample[] {
  let total = 0;
  let big = 0;
  for (let i = 0; i < samples.length; i++) {
    total += samples[i]!.weight;
    if (samples[i]!.weight > samples[big]!.weight) big = i;
  }
  const kept: TemporalSample[] = [];
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const sm = samples[i]!;
    if (i !== big && sm.weight / total < 1 / 512) continue;
    kept.push(sm);
    sum += sm.weight;
  }
  return kept.map((sm) => ({ offset: sm.offset, weight: sm.weight / sum }));
}

/** reach of a clip path on a side that is not cropped (text / shape keep their outline and shadow room there) */
const OPEN_SIDE = 1e5;

/**
 * draw one flat (2d) clip. `blend` false ignores clip.blend (layers of a transition mix with normal
 * blending, the mixed result carries the blend). a clip without crop / radius / blend takes the plain path.
 */
function paintFlat(ctx: Ctx, project: Project, clip0: VisualClip, source: FlatSource | null, alpha: number, time: number, blend = true, poseTime = time): void {
  // under a parent the clip is drawn with its world pose (a clip without a parent takes the plain path)
  let clip = clip0;
  if (clip0.parent) {
    const wt = worldTransformOf(project, clip0, poseTime);
    if (wt !== clip0.transform) clip = { ...clip0, transform: wt } as VisualClip;
  }
  const box = getClipBox(project, clip, source ? { width: source.width, height: source.height } : undefined);
  const op = blend ? blendOp(clip.blend) : null;
  const crop = normalizeCrop(clip.crop);
  ctx.save();
  ctx.globalAlpha = alpha;
  if (op) ctx.globalCompositeOperation = op;
  ctx.translate(box.cx, box.cy);
  if (box.rotation) ctx.rotate((box.rotation * Math.PI) / 180);
  if (clip.type === 'text' || clip.type === 'shape') {
    if (crop) {
      // clip to the kept rectangle; an edge that is not cut stays open for outlines and shadows
      const w = box.width;
      const h = box.height;
      const x0 = crop.left > 0 ? -w / 2 + crop.left * w : -OPEN_SIDE;
      const x1 = crop.right > 0 ? w / 2 - crop.right * w : OPEN_SIDE;
      const y0 = crop.top > 0 ? -h / 2 + crop.top * h : -OPEN_SIDE;
      const y1 = crop.bottom > 0 ? h / 2 - crop.bottom * h : OPEN_SIDE;
      ctx.beginPath();
      ctx.rect(x0, y0, x1 - x0, y1 - y0);
      ctx.clip();
    }
    // a rect shape rounds itself (shape.ts), other shapes and text ignore radius
    if (source && source.pad !== undefined) {
      // a text / shape picture that went through a look or a mask (a texture with room around the box)
      try {
        const p = source.pad * clip.transform.scale;
        ctx.drawImage(source.image, -box.width / 2 - p, -box.height / 2 - p, box.width + p * 2, box.height + p * 2);
      } catch {
        // not drawable: skipped
      }
    } else if (clip.type === 'text') drawText(ctx, clip, time - clip.start);
    else drawShape(ctx, clip, box.width, box.height, clip.transform.scale);
  } else if (source) {
    try {
      if (!crop && !(clip.radius !== undefined && clip.radius > 0)) {
        ctx.drawImage(source.image, -box.width / 2, -box.height / 2, box.width, box.height);
      } else {
        const k = cropRect(box.width, box.height, crop);
        if (clip.radius !== undefined && clip.radius > 0) {
          roundedRectPath(ctx, k.x, k.y, k.width, k.height, radiusPx(clip.radius, k.width, k.height));
          ctx.clip();
        }
        if (crop) {
          // the source rectangle is in pixels of the image itself, which the preview may have decoded smaller
          const real = source.pw !== undefined && source.ph !== undefined ? null : imagePixelSize(source.image, source.width, source.height);
          const sw = source.pw ?? real!.w;
          const sh = source.ph ?? real!.h;
          ctx.drawImage(source.image, crop.left * sw, crop.top * sh, (1 - crop.left - crop.right) * sw, (1 - crop.top - crop.bottom) * sh, k.x, k.y, k.width, k.height);
        } else {
          ctx.drawImage(source.image, k.x, k.y, k.width, k.height);
        }
      }
    } catch {
      // a source that is not ready (e.g. a video with no decoded frame yet) is skipped
    }
  }
  ctx.restore();
}

/** true when two poses put the clip in the same place with the same alpha */
function samePose(a: Transform, aa: number, b: Transform, ba: number): boolean {
  return (
    Math.abs(a.x - b.x) < 1e-4 &&
    Math.abs(a.y - b.y) < 1e-4 &&
    Math.abs(a.scale - b.scale) < 1e-6 &&
    Math.abs(a.rotation - b.rotation) < 1e-4 &&
    Math.abs(aa - ba) < 1e-4
  );
}

/**
 * draw a flat clip with its motion blur: `samples` copies at moments spread over the shutter, each with its own
 * pose (keyframes, motions, parents, fades), summed premultiplied on a scratch layer ('lighter' at 1 / samples) and
 * laid over the frame with the clip's blend mode. the picture itself (video frame, text animation) is the one of the
 * real time, only the placement is blurred. false = nothing to blur (a still clip), the caller draws it plain.
 * inside a transition (blend false) the layer is mixed with normal blending, the mixed result carries the blend.
 */
function paintBlurred(ctx: Ctx, project: Project, raw: VisualClip, source: FlatSource | null, time: number, env: Env, blend = true): boolean {
  const times = motionBlurTimes(time, project.fps || 30, raw.motionBlur, env.quality);
  if (times.length < 2) return false;
  // 'trail' / 'ghost' choose their own moments and weights; 'even' (or no style) keeps the old times and equal shares
  let weights: number[] | null = null;
  let over = false;
  const style = raw.motionBlur?.style;
  if (style === 'trail' || style === 'ghost') {
    // ghost draws separate copies: their number is the look, so it does not follow the preview quality
    const count = style === 'ghost' ? Math.min(MAX_MOTION_BLUR_SAMPLES, Math.floor(raw.motionBlur!.samples)) : times.length;
    const plan = blurPlan(style, count, Math.min(2, raw.motionBlur!.shutter) / (project.fps || 30));
    times.length = 0;
    weights = [];
    over = plan.over;
    for (const sm of plan.samples) {
      times.push(time + sm.offset);
      weights.push(sm.weight);
    }
  }
  const end = Math.max(raw.start, clipEnd(raw) - 1e-4);
  // a copy never comes from outside the clip (it would fade the first frames)
  for (let i = 0; i < times.length; i++) times[i] = Math.min(end, Math.max(raw.start, times[i]!));
  const pose = (t: number) => {
    const c = resolveVisual(raw, t, project, time);
    return { c, a: c.transform.opacity * fadeFactor(c, t), w: worldTransformOf(project, c, t) };
  };
  // still = every sample has the pose of the first one (not just the two ends: at the turning point of a
  // move the ends match while the middle is somewhere else)
  const poses: ReturnType<typeof pose>[] = [pose(times[0]!)];
  const first = poses[0]!;
  let still = true;
  for (let i = times.length - 1; i >= 1 && still; i--) {
    const p = pose(times[i]!);
    poses[i] = p;
    if (!samePose(first.w, first.a, p.w, p.a)) still = false;
  }
  if (still) return false;
  const canvas = ctx.canvas as AnyCanvas | undefined;
  const copy = scratchFor(ctx, env.channel, 'mbCopy');
  const acc = scratchFor(ctx, env.channel, 'mbAcc', true);
  if (!canvas || !copy || !acc) return false;
  clearScratch(acc);
  const share = 1 / times.length;
  for (let i = 0; i < times.length; i++) {
    const t = times[i]!;
    const p = poses[i] ?? pose(t);
    if (p.a <= 0.001) continue;
    clearScratch(copy);
    paintFlat(copy.ctx, project, p.c, source, p.a, time, false, t);
    acc.ctx.save();
    acc.ctx.setTransform(1, 0, 0, 1, 0, 0);
    acc.ctx.globalAlpha = weights ? weights[i]! : share;
    acc.ctx.globalCompositeOperation = over ? 'source-over' : 'lighter';
    acc.ctx.drawImage(copy.canvas, 0, 0, canvas.width, canvas.height);
    acc.ctx.restore();
  }
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = (blend ? blendOp(raw.blend) : null) ?? 'source-over';
  ctx.drawImage(acc.canvas, 0, 0, canvas.width, canvas.height);
  ctx.restore();
  return true;
}

/**
 * the passes of the effects that sit on a clip at the frame time (EffectClip.target), in run order, or null when
 * there are none (the clip is drawn the old way). temporal effects (motion blur, echo, frame blend, strobe) on one
 * clip are not supported: effectPassAt gives no pass for them, so they do nothing.
 */
function clipFxPasses(project: Project, env: Env, clipId: string, frameTime: number): EffectPass[] | null {
  if (!env.fx) return null;
  const list = effectsOnClip(env.fx, project, clipId, frameTime);
  if (!list) return null;
  let passes: EffectPass[] | null = null;
  for (const e of list) {
    const pass = effectPassAt(e, frameTime);
    if (pass) (passes ??= []).push(pass);
  }
  return passes;
}

/**
 * draw ONE clip with effects on it. `draw` paints the clip alone (nothing else of the frame) into a transparent
 * scratch canvas of the frame's size and transform, so the effect sees the clip where it is on screen. the passes run
 * on that picture, then the result is laid over `ctx` with `op` (the clip's blend mode, null = normal).
 * the clip's opacity, fades and per-clip motion blur are part of the picture `draw` makes (so the effect gets the
 * clip as it would have been drawn); the blend mode is applied at the end.
 * alpha: the effects framework forces the output alpha to 1, so the result is cut back to the alpha of the
 * un-effected picture ('source-in' with it as the destination): a text clip with a glitch is still text on a
 * see-through background. effects that move pixels outside the clip's old outline (shake, zoom, blur halos) get
 * cut at that outline. a simple honest rule: the clip's own shape stays the shape.
 * false = could not (no scratch canvas): nothing was drawn, the caller draws the clip plain.
 */
function paintWithFx(ctx: Ctx, project: Project, passes: EffectPass[], op: GlobalCompositeOperation | null, env: Env, draw: (target: Ctx) => void): boolean {
  const canvas = ctx.canvas as AnyCanvas | undefined;
  const pic = scratchFor(ctx, env.channel, 'fxPic');
  if (!canvas || !pic) return false;
  clearScratch(pic);
  draw(pic.ctx);
  const out = renderEffects(pic.canvas, pic.canvas.width, pic.canvas.height, passes, {
    projectWidth: project.width,
    projectHeight: project.height,
    channel: env.channel,
  });
  if (out) {
    pic.ctx.save();
    pic.ctx.setTransform(1, 0, 0, 1, 0, 0);
    pic.ctx.globalAlpha = 1;
    pic.ctx.globalCompositeOperation = 'source-in';
    pic.ctx.drawImage(out, 0, 0, pic.canvas.width, pic.canvas.height);
    pic.ctx.restore();
  }
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = op ?? 'source-over';
  ctx.drawImage(pic.canvas, 0, 0, canvas.width, canvas.height);
  ctx.restore();
  return true;
}

/**
 * draw one clip by itself (2d or 3d) at a time, e.g. onto a transition layer. false when nothing was drawn.
 * `frameTime` is the time of the frame (a frozen side of a transition is drawn at another time): the effects that sit
 * on the clip are looked up at the frame time.
 */
function paintAlone(ctx: Ctx, project: Project, raw: VisualClip, time: number, env: Env, rig: () => CameraRig, frozen = false, frameTime = time): boolean {
  // a frozen side of a transition sits on its edge frame: its entrance / exit would hold it at nothing, so only the loop runs
  const clip = frozen && (raw.motionIn || raw.motionOut) ? resolveVisual({ ...raw, motionIn: null, motionOut: null }, time, project) : resolveVisual(raw, time, project);
  const alpha = clip.transform.opacity * fadeFactor(clip, time);
  if (alpha <= 0.001) return false;
  let source: DrawSource | null = null;
  if (raw.type === 'video' || raw.type === 'image') {
    source = env.resolve(raw, raw.type === 'video' ? sourceTimeAt(raw, time) : 0);
    if (!source) return false;
  }
  const passes = clipFxPasses(project, env, raw.id, frameTime);
  if (clip.threeD) {
    const run = (c: Ctx) => draw3d(c, project, [{ clip, source, alpha, time }], rig(), env.channel);
    if (!(passes && paintWithFx(ctx, project, passes, null, env, run))) run(ctx);
  } else {
    const pic = prepareFlat(project, clip, source, time, env.channel, raw.motionBlur ? 0 : alpha);
    // the motion blur of a clip inside a transition (a frozen side has no entrance / exit to blur)
    const blurRaw = frozen && (raw.motionIn || raw.motionOut) ? ({ ...raw, motionIn: null, motionOut: null } as VisualClip) : raw;
    const run = (c: Ctx) => {
      if (!(raw.motionBlur && paintBlurred(c, project, blurRaw, pic, time, env, false))) paintFlat(c, project, clip, pic, alpha, time, false);
    };
    if (!(passes && paintWithFx(ctx, project, passes, null, env, run))) run(ctx);
  }
  return true;
}

function seedOf(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 1000;
  return h;
}

/** blend the outgoing and the incoming clip of a transition and lay the result on the canvas */
function paintTransition(ctx: Ctx, project: Project, time: number, span: TransitionSpan, env: Env, rig: () => CameraRig): void {
  const def = getTransition(span.id);
  const canvas = ctx.canvas as AnyCanvas | undefined;
  // each side is frozen on its edge frame while the other one is the clip that is really playing
  const timeA = span.from ? Math.min(time, clipEnd(span.from) - 1e-4) : 0;
  const timeB = Math.max(time, span.to.start);
  const la = def && canvas && span.from ? scratchFor(ctx, env.channel, 'tra') : null;
  const lb = def && canvas ? scratchFor(ctx, env.channel, 'trb') : null;
  if (!def || !canvas || !lb) {
    // no canvas to blend on: a plain cut
    const natural = span.from && time < span.to.start ? span.from : span.to;
    paintAlone(ctx, project, natural, natural === span.to ? timeB : timeA, env, rig, natural === span.to ? timeB !== time : timeA !== time, time);
    return;
  }
  let hasA = false;
  if (la && span.from) {
    clearScratch(la);
    hasA = paintAlone(la.ctx, project, span.from, timeA, env, rig, timeA !== time, time);
  }
  clearScratch(lb);
  const hasB = paintAlone(lb.ctx, project, span.to, timeB, env, rig, timeB !== time, time);
  const p = easeTransition((time - span.start) / Math.max(1e-6, span.end - span.start));
  const out = renderTransition(hasA && la ? la.canvas : null, hasB ? lb.canvas : null, def, p, canvas.width, canvas.height, {
    projectWidth: project.width,
    projectHeight: project.height,
    channel: env.channel,
    seed: seedOf(span.to.id),
  });
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  // the two sides were painted with normal blending, the mixed result blends like the incoming clip
  ctx.globalCompositeOperation = blendOp(span.to.blend) ?? 'source-over';
  if (out) ctx.drawImage(out, 0, 0, canvas.width, canvas.height);
  else {
    // the shader is broken or webgl is gone: a plain cut
    const pick = span.from && time < span.to.start ? (hasA && la ? la.canvas : null) : hasB ? lb.canvas : null;
    if (pick) ctx.drawImage(pick, 0, 0, canvas.width, canvas.height);
  }
  ctx.restore();
}

/**
 * paint the background and every layer below track index `above` (-1 = the whole frame) at a time.
 * the canvas ends up opaque.
 */
function paintLayers(ctx: Ctx, project: Project, time: number, env: Env, above: number): void {
  const items = paintItemsAt(project, time, above);
  let rig: CameraRig | null = null;
  const getRig = (): CameraRig => (rig ??= cameraRig(env.opts.camera ?? cameraAt(project, time), project.width, project.height));

  ctx.save();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';

  // the topmost temporal effect (motion blur, echo) replaces everything under it with a blend of
  // those layers at several moments. lower ones are handled inside each of those passes.
  let first = 0;
  if (env.depth < MAX_TEMPORAL_DEPTH) {
    for (let k = items.length - 1; k >= 0; k--) {
      const it = items[k]!;
      if (it.kind !== 'effect') continue;
      const samples = temporalSamples(it.clip, time, project.fps || 30, env.quality);
      if (!samples) continue;
      const sc = scratchFor(ctx, env.channel, `temporal${env.depth}`);
      const acc = scratchFor(ctx, env.channel, `temporalAcc${env.depth}`, true);
      const canvas = ctx.canvas as AnyCanvas | undefined;
      if (!sc || !acc || !canvas) break;
      const inner: Env = { ...env, depth: env.depth + 1 };
      // the weighted sum of the moments, built on a cleared accumulator with 'lighter' (adds the premultiplied
      // pixels) at alpha = weight / total. a running average at alpha = w / runningTotal rounds to 8 bits on every
      // step and late samples vanish (at 32 samples one that differs by under ~16 levels changes nothing). here
      // every sample adds its own true share. a single sample at weight 1 is copied exactly.
      let total = 0;
      for (const sm of samples) total += sm.weight;
      clearScratch(acc);
      for (const sm of samples) {
        paintLayers(sc.ctx, project, Math.max(0, time + sm.offset), inner, it.track);
        acc.ctx.save();
        acc.ctx.setTransform(1, 0, 0, 1, 0, 0);
        acc.ctx.globalAlpha = sm.weight / total;
        acc.ctx.globalCompositeOperation = 'lighter';
        acc.ctx.drawImage(sc.canvas, 0, 0, canvas.width, canvas.height);
        acc.ctx.restore();
      }
      // the sum can fall a level or two short of opaque from rounding: lay it over the background so the frame stays opaque
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = project.background || '#000000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(acc.canvas, 0, 0, canvas.width, canvas.height);
      ctx.restore();
      first = k + 1;
      break;
    }
  }
  if (first === 0) {
    ctx.fillStyle = project.background || '#000000';
    ctx.fillRect(0, 0, project.width, project.height);
  }

  // consecutive 3d clips share one depth sorted scene. a 2d clip, a transition or an effect in between splits it.
  let bin: Layer3D[] = [];
  const flush3d = () => {
    if (bin.length === 0) return;
    draw3d(ctx, project, bin, getRig(), env.channel);
    bin = [];
  };
  // effect clips stack up until the next picture is drawn on top of them (or the frame ends),
  // then run together in one gpu round trip
  let pending: EffectPass[] = [];
  const flushEffects = () => {
    if (pending.length === 0) return;
    applyEffects(ctx, project, pending, env.channel);
    pending = [];
  };

  for (let k = first; k < items.length; k++) {
    const it = items[k]!;
    if (it.kind === 'effect') {
      // temporal effects were handled above (or sit too deep): effectPassAt skips them
      const pass = effectPassAt(it.clip, time);
      if (pass) {
        flush3d();
        pending.push(pass);
      }
      continue;
    }
    flushEffects();
    if (it.kind === 'transition') {
      flush3d();
      paintTransition(ctx, project, time, it.span, env, getRig);
      continue;
    }
    const raw = it.clip;
    // keyframes baked in. the resolver still gets the stored clip (it is keyed by identity).
    const clip = resolveVisual(raw, time, project);
    const alpha = clip.transform.opacity * fadeFactor(clip, time);
    if (alpha <= 0.001) continue;
    let source: DrawSource | null = null;
    if (raw.type === 'video' || raw.type === 'image') {
      source = env.resolve(raw, raw.type === 'video' ? sourceTimeAt(raw, time) : 0);
      if (!source) continue;
    }
    const passes = clipFxPasses(project, env, raw.id, time);
    if (clip.threeD) {
      const bop = blendOp(clip.blend);
      if (passes) {
        // a 3d clip with effects on it is a run of its own (like a blended one): its picture is rendered alone, the
        // effects run on it, then it is mixed onto the canvas. it does not depth-test against the 3d clips around it.
        flush3d();
        const layer: Layer3D = { clip, source, alpha, time };
        if (paintWithFx(ctx, project, passes, bop, env, (c) => draw3d(c, project, [layer], getRig(), env.channel))) continue;
        draw3d(ctx, project, [layer], getRig(), env.channel, NO_LINES, bop ?? 'source-over');
        continue;
      }
      if (bop) {
        // a blended 3d clip is a run of its own: rendered alone, then mixed onto the canvas. it does not
        // depth-test against the 3d clips around it.
        flush3d();
        draw3d(ctx, project, [{ clip, source, alpha, time }], getRig(), env.channel, NO_LINES, bop);
        continue;
      }
      bin.push({ clip, source, alpha, time });
      continue;
    }
    flush3d();
    const pic = prepareFlat(project, clip, source, time, env.channel, raw.motionBlur ? 0 : alpha);
    if (passes) {
      const run = (c: Ctx) => {
        if (!(raw.motionBlur && paintBlurred(c, project, raw, pic, time, env, false))) paintFlat(c, project, clip, pic, alpha, time, false);
      };
      if (paintWithFx(ctx, project, passes, blendOp(clip.blend), env, run)) continue;
    }
    if (raw.motionBlur && paintBlurred(ctx, project, raw, pic, time, env)) continue;
    paintFlat(ctx, project, clip, pic, alpha, time);
  }
  flush3d();
  flushEffects();
  ctx.restore();
}

/**
 * draw the whole frame at `time`. the context must belong to a canvas of project.width x project.height
 * (or be pre-scaled so that those are its logical units).
 */
export function renderFrame(ctx: Ctx, project: Project, time: number, resolve: SourceResolver, opts: RenderOptions = {}): void {
  const quality = Math.min(1, Math.max(0.1, opts.quality ?? 1));
  paintLayers(ctx, project, time, { resolve, opts, channel: channelOf(ctx), quality, depth: 0, fx: targetIndex(project) }, -1);
}

/**
 * the scene view: the 3d world seen from a free editor camera instead of the project camera.
 * shows every active 3d clip as a plane, the output frame (the canvas rectangle at z = 0), a floor grid
 * and the project camera as a wire pyramid. 2d clips and effects are screen space and are not drawn.
 * crop and radius apply here too; blend modes do not (all planes share one depth sorted run).
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
    const clip = resolveVisual(raw, time, project);
    if (!clip.threeD) continue;
    const alpha = clip.transform.opacity * fadeFactor(clip, time);
    if (alpha <= 0.001) continue;
    let source: DrawSource | null = null;
    if (raw.type === 'video' || raw.type === 'image') {
      source = resolve(raw, raw.type === 'video' ? sourceTimeAt(raw, time) : 0);
      if (!source) continue;
    }
    layers.push({ clip, source, alpha, time });
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
  const camRig = cameraRig(camClip ? cameraFromClip(camClip, time, project) : DEFAULT_CAMERA, W, H);
  const far = frustumCorners(camRig, homeDistance(H));
  for (let i = 0; i < 4; i++) {
    seg(frame, camRig.eye, far[i]!);
    seg(frame, far[i]!, far[(i + 1) % 4]!);
  }
  draw3d(ctx, project, layers, rig, channelOf(ctx), [
    { points: grid, color: dim },
    { points: frame, color: lineColor },
  ]);
}
