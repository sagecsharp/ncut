/**
 * the frame renderer. draws one frame of a project onto a 2d canvas (effects, transitions and 3d
 * clips run on the gpu, see engine/effects, engine/transitions and engine/scene3d).
 * shared by the live preview and the exporter so both always look the same.
 * it does not know where pixels come from: the caller passes a resolver that returns the
 * current image for a video/image clip (a <video>, <img>, ImageBitmap, VideoFrame, canvas...).
 */
import type { EffectClip, ImageClip, Project, ShapeClip, TextClip, Transform, VideoClip, VisualClip } from '../types';
import { isVisualClip } from '../types';
import { clipEnd, fadeFactor, sourceTimeAt } from '../lib/timelineOps';
import { resolveClip } from '../lib/anim';
import { fontsVersion } from '../lib/fonts';
import { type TransitionSpan, transitionSpan } from '../lib/transitions';
import { getEffect } from './effects/registry';
import { renderEffects } from './effects/runner';
import type { EffectPass, TemporalSample } from './effects/types';
import { type Camera3D, type CameraRig, DEFAULT_CAMERA, cameraAt, cameraClipAt, cameraFromClip, cameraRig, frustumCorners, homeDistance } from './scene3d/camera';
import { mul, scaling } from './scene3d/math';
import { clipModelMatrix } from './scene3d/model';
import { type Lines3D, type Plane3D, renderScene } from './scene3d/renderer';
import { drawShape, shapeSignature, shapeSpill } from './shape';
import { drawText, measureText, textSpill } from './text';
import { textAnimActive } from './textAnim';
import { getTransition } from './transitions/registry';
import { easeTransition, renderTransition } from './transitions/runner';

export { TEXT_LINE_HEIGHT, TEXT_PADDING, measureText, textFont } from './text';

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

/** the gpu pass for an effect clip at a time, or null (unknown effect, temporal effect, faded to nothing) */
export function effectPassAt(raw: EffectClip, time: number): EffectPass | null {
  const def = getEffect(raw.effect);
  if (!def || def.temporal) return null;
  const clip = resolveClip(raw, time);
  const amount = clip.amount * fadeFactor(clip, time);
  if (!(amount > 0.001)) return null;
  return { def, time: Math.max(0, time - clip.start), duration: clip.duration, amount, seed: clip.seed, params: clip.params };
}

type Channel = 'default' | 'export';

function channelOf(ctx: Ctx): Channel {
  const canvas = ctx.canvas as AnyCanvas | undefined;
  // the export draws on an OffscreenCanvas and can run while the preview is on screen
  return typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas ? 'export' : 'default';
}

/** run effect passes over what is already on the canvas and put the result back */
function applyEffects(ctx: Ctx, project: Project, passes: EffectPass[]): void {
  const canvas = ctx.canvas as AnyCanvas | undefined;
  if (!canvas || passes.length === 0) return;
  const out = renderEffects(canvas, canvas.width, canvas.height, passes, {
    projectWidth: project.width,
    projectHeight: project.height,
    channel: channelOf(ctx),
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

/** a helper canvas with the same size and transform as the canvas of `like`, kept per channel + name */
function scratchFor(like: Ctx, channel: Channel, name: string): Scratch | null {
  const src = like.canvas as AnyCanvas | undefined;
  if (!src) return null;
  const key = `${channel}:${name}`;
  let sc = scratches.get(key);
  if (sc === undefined) {
    let canvas: AnyCanvas | null = null;
    if (typeof OffscreenCanvas !== 'undefined') canvas = new OffscreenCanvas(src.width, src.height);
    else if (typeof document !== 'undefined') canvas = document.createElement('canvas');
    const c = canvas ? (canvas.getContext('2d') as Ctx | null) : null;
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

interface Layer3D {
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
  const q = Math.min(4, Math.max(1, clip.transform.scale * 1.5), 4096 / Math.max(fullW, fullH, 1));
  const w = Math.max(2, Math.ceil(fullW * q));
  const h = Math.max(2, Math.ceil(fullH * q));
  const sig = animated
    ? ''
    : [
        fontsVersion(),
        clip.text,
        clip.fontFamily,
        clip.fontSize,
        clip.fontWeight,
        clip.italic,
        clip.color,
        clip.background,
        clip.align,
        clip.letterSpacing,
        clip.lineHeight,
        clip.uppercase,
        JSON.stringify(clip.stroke ?? 0),
        JSON.stringify(clip.shadow ?? 0),
        clip.backgroundRadius,
        clip.backgroundPadding,
        w,
        h,
      ].join('|');
  const hit = textTextures.get(clip.id);
  if (hit && !animated && hit.sig === sig) return hit;
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
  const entry: TextTexture = { sig, canvas, key: animated ? undefined : `text:${clip.id}:${++textTextureSerial}`, margin };
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
  if (hit && hit.sig === sig) return hit;
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
  shapeTextures.set(clip.id, entry);
  if (shapeTextures.size > 64) {
    const first = shapeTextures.keys().next().value;
    if (first !== undefined) shapeTextures.delete(first);
  }
  return entry;
}

function planeFor(project: Project, layer: Layer3D, rig: CameraRig): Plane3D | null {
  const { clip, source } = layer;
  const box = getClipBox(project, clip, source ? { width: source.width, height: source.height } : undefined);
  const shape = clip.shape ?? 'plane';
  let image: TexImageSource;
  let cacheKey: string | undefined;
  if (clip.type === 'text') {
    const t = textTexture(clip, layer.time);
    if (!t) return null;
    // the texture has room around the text for outlines, shadows and moving letters
    box.width += t.margin * 2 * clip.transform.scale;
    box.height += t.margin * 2 * clip.transform.scale;
    image = t.canvas;
    cacheKey = t.key;
  } else if (clip.type === 'shape') {
    const t = shapeTexture(clip);
    if (!t) return null;
    box.width += t.margin * 2 * clip.transform.scale;
    box.height += t.margin * 2 * clip.transform.scale;
    image = t.canvas;
    cacheKey = t.key;
  } else {
    if (!source) return null;
    image = source.image as TexImageSource;
    // still images keep their texture between frames, video uploads every frame
    cacheKey = clip.type === 'image' ? `img:${clip.assetId}:${source.width}x${source.height}` : undefined;
  }
  let model = clipModelMatrix(box, clip.transform, clip.lookAt, rig.eye);
  if (shape !== 'plane') {
    // thickness: a box is as deep as the clip is tall unless set, round shapes are as deep as they are wide
    const fallback = shape === 'box' ? box.height : box.width;
    const depth = clip.shapeDepth !== undefined && clip.shapeDepth > 0 && shape !== 'sphere' ? clip.shapeDepth * clip.transform.scale : fallback;
    model = mul(model, scaling(1, 1, Math.max(1, depth)));
  }
  return { image, cacheKey, model, alpha: layer.alpha, shape };
}

/** render a run of 3d clips through the camera and lay the result over what is already on the canvas */
function draw3d(ctx: Ctx, project: Project, layers: Layer3D[], rig: CameraRig, lines: Lines3D[] = []): void {
  const canvas = ctx.canvas as AnyCanvas | undefined;
  if (!canvas) return;
  const planes: Plane3D[] = [];
  for (const layer of layers) {
    const p = planeFor(project, layer, rig);
    if (p) planes.push(p);
  }
  const out = renderScene(planes, lines, rig.viewProj, rig.eye, canvas.width, canvas.height, channelOf(ctx));
  if (!out) return;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
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
    for (const clip of project.clips) {
      if (clip.trackId !== track.id) continue;
      if (clip.type === 'effect') {
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
  const samples = def.temporal(params, Math.min(1, amount), fps, quality).filter((sm) => sm.weight > 0);
  return samples.length > 1 ? samples : null;
}

/** draw one flat (2d) clip */
function paintFlat(ctx: Ctx, project: Project, clip: VisualClip, source: DrawSource | null, alpha: number, time: number): void {
  const box = getClipBox(project, clip, source ? { width: source.width, height: source.height } : undefined);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(box.cx, box.cy);
  if (box.rotation) ctx.rotate((box.rotation * Math.PI) / 180);
  if (clip.type === 'text') {
    drawText(ctx, clip, time - clip.start);
  } else if (clip.type === 'shape') {
    drawShape(ctx, clip, box.width, box.height, clip.transform.scale);
  } else if (source) {
    try {
      ctx.drawImage(source.image, -box.width / 2, -box.height / 2, box.width, box.height);
    } catch {
      // a source that is not ready (e.g. a video with no decoded frame yet) is skipped
    }
  }
  ctx.restore();
}

/** draw one clip by itself (2d or 3d) at a time, e.g. onto a transition layer. false when nothing was drawn. */
function paintAlone(ctx: Ctx, project: Project, raw: VisualClip, time: number, env: Env, rig: () => CameraRig): boolean {
  const clip = resolveClip(raw, time);
  const alpha = clip.transform.opacity * fadeFactor(clip, time);
  if (alpha <= 0.001) return false;
  let source: DrawSource | null = null;
  if (raw.type === 'video' || raw.type === 'image') {
    source = env.resolve(raw, raw.type === 'video' ? sourceTimeAt(raw, time) : 0);
    if (!source) return false;
  }
  if (clip.threeD) draw3d(ctx, project, [{ clip, source, alpha, time }], rig());
  else paintFlat(ctx, project, clip, source, alpha, time);
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
    paintAlone(ctx, project, natural, natural === span.to ? timeB : timeA, env, rig);
    return;
  }
  let hasA = false;
  if (la && span.from) {
    clearScratch(la);
    hasA = paintAlone(la.ctx, project, span.from, timeA, env, rig);
  }
  clearScratch(lb);
  const hasB = paintAlone(lb.ctx, project, span.to, timeB, env, rig);
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
  ctx.globalCompositeOperation = 'source-over';
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
      const canvas = ctx.canvas as AnyCanvas | undefined;
      if (!sc || !canvas) break;
      const inner: Env = { ...env, depth: env.depth + 1 };
      let total = 0;
      for (const sm of samples) {
        paintLayers(sc.ctx, project, Math.max(0, time + sm.offset), inner, it.track);
        const isFirst = total === 0;
        total += sm.weight;
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        // a running weighted average: each new moment replaces its share of what is there
        ctx.globalAlpha = isFirst ? 1 : sm.weight / total;
        ctx.globalCompositeOperation = isFirst ? 'copy' : 'source-over';
        ctx.drawImage(sc.canvas, 0, 0, canvas.width, canvas.height);
        ctx.restore();
      }
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
    draw3d(ctx, project, bin, getRig());
    bin = [];
  };
  // effect clips stack up until the next picture is drawn on top of them (or the frame ends),
  // then run together in one gpu round trip
  let pending: EffectPass[] = [];
  const flushEffects = () => {
    if (pending.length === 0) return;
    applyEffects(ctx, project, pending);
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
    const clip = resolveClip(raw, time);
    const alpha = clip.transform.opacity * fadeFactor(clip, time);
    if (alpha <= 0.001) continue;
    let source: DrawSource | null = null;
    if (raw.type === 'video' || raw.type === 'image') {
      source = env.resolve(raw, raw.type === 'video' ? sourceTimeAt(raw, time) : 0);
      if (!source) continue;
    }
    if (clip.threeD) {
      bin.push({ clip, source, alpha, time });
      continue;
    }
    flush3d();
    paintFlat(ctx, project, clip, source, alpha, time);
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
  paintLayers(ctx, project, time, { resolve, opts, channel: channelOf(ctx), quality, depth: 0 }, -1);
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
