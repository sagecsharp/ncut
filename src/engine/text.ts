/**
 * text clips: measuring and drawing, including style (letter spacing, outline, shadow, rounded box)
 * and the per letter text animations. shared by the 2d frame renderer and the 3d text textures.
 */
import { ensureFont, fontsVersion } from '../lib/fonts';
import type { TextClip } from '../types';
import { type GlyphState, REST, blockState, glyphState, textAnimActive, textAnimUnits } from './textAnim';

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

/** the characters that are actually drawn */
export function displayText(clip: Pick<TextClip, 'text' | 'uppercase'>): string {
  const t = clip.text.length > 0 ? clip.text : ' ';
  return clip.uppercase ? t.toUpperCase() : t;
}

export interface TextBox {
  /** unscaled size of the box (text + padding) */
  width: number;
  height: number;
  lines: string[];
  lineHeight: number;
  pad: number;
  /** width of each line without padding */
  lineWidths: number[];
  /** extra pixels between letters */
  spacing: number;
}

const requested = new Set<string>();
/** ask for the clip's font once (it loads in the background, the preview redraws when it arrives) */
function wantFont(clip: TextClip): void {
  const key = `${clip.fontFamily}|${clip.fontWeight}|${clip.italic}`;
  if (requested.has(key)) return;
  requested.add(key);
  void ensureFont(clip.fontFamily, clip.fontWeight, clip.italic);
}

const boxCache = new Map<string, TextBox>();

function lineWidth(ctx: Ctx, line: string, spacing: number): number {
  const w = ctx.measureText(line).width;
  // spacing goes between letters, not after the last one
  return spacing !== 0 ? w + spacing * Math.max(0, Array.from(line).length - 1) : w;
}

/** unscaled size of a text clip's box (text + padding) and its lines */
export function measureText(clip: TextClip): TextBox {
  wantFont(clip);
  const text = displayText(clip);
  const spacing = (clip.letterSpacing ?? 0) * clip.fontSize;
  const lineHeight = clip.fontSize * (clip.lineHeight ?? TEXT_LINE_HEIGHT);
  const pad = clip.fontSize * (clip.backgroundPadding ?? TEXT_PADDING);
  const font = textFont(clip);
  const key = `${fontsVersion()}|${font}|${spacing}|${lineHeight}|${pad}|${text}`;
  const hit = boxCache.get(key);
  if (hit) return hit;
  const ctx = getMeasureCtx();
  ctx.font = font;
  const lines = text.split('\n');
  const lineWidths = lines.map((l) => lineWidth(ctx, l, spacing));
  let max = 0;
  for (const w of lineWidths) max = Math.max(max, w);
  const box: TextBox = { width: Math.max(1, max + pad * 2), height: lines.length * lineHeight + pad * 2, lines, lineHeight, pad, lineWidths, spacing };
  if (boxCache.size > 300) boxCache.clear();
  boxCache.set(key, box);
  return box;
}

/** how far (as a fraction of the font size) letters can reach outside the box: outline, shadow, animation */
export function textSpill(clip: TextClip, animated: boolean): number {
  let s = 0.05;
  if (clip.stroke) s += clip.stroke.width;
  if (clip.shadow) s += clip.shadow.distance + clip.shadow.blur * 2;
  if (animated) s += 1.5;
  return s;
}

interface Glyph {
  ch: string;
  /** center x and width, relative to the box center */
  x: number;
  w: number;
  /** middle of the line, relative to the box center */
  y: number;
  /** index among the drawn letters (spaces count too), and of its word and line */
  index: number;
  word: number;
  line: number;
}

/** where every letter sits. only needed when letters are drawn one by one. */
function layoutGlyphs(ctx: Ctx, clip: TextClip, m: TextBox, extraSpacing: number): { glyphs: Glyph[]; words: number } {
  const glyphs: Glyph[] = [];
  const innerW = m.width - m.pad * 2;
  const top = -m.height / 2 + m.pad;
  let index = 0;
  let word = 0;
  for (let li = 0; li < m.lines.length; li++) {
    const chars = Array.from(m.lines[li]!);
    const spacing = m.spacing + extraSpacing;
    // measure prefixes so kerning stays right
    const edges: number[] = [0];
    let acc = '';
    for (const ch of chars) {
      acc += ch;
      edges.push(ctx.measureText(acc).width);
    }
    const lineW = (edges[chars.length] ?? 0) + spacing * Math.max(0, chars.length - 1);
    const left = clip.align === 'left' ? -innerW / 2 : clip.align === 'right' ? innerW / 2 - lineW : -lineW / 2;
    const y = top + m.lineHeight * (li + 0.5);
    let inWord = false;
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i]!;
      const w = edges[i + 1]! - edges[i]!;
      const space = ch.trim() === '';
      if (!space && !inWord) inWord = true;
      if (space && inWord) {
        inWord = false;
        word++;
      }
      glyphs.push({ ch, x: left + edges[i]! + spacing * i + w / 2, w, y, index, word, line: li });
      index++;
    }
    if (inWord) word++;
  }
  return { glyphs, words: Math.max(1, word) };
}

function roundedRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  if (r > 0 && typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

function hueColor(h: number): string {
  return `hsl(${Math.round((((h % 1) + 1) % 1) * 360)} 90% 60%)`;
}

const FAR = 30000;

/**
 * draw a text clip centered on the origin of the context (the caller already moved / rotated it).
 * applies transform.scale. `local` = seconds since the clip started (drives the text animations);
 * leave it out for a still picture of the text at rest.
 */
export function drawText(ctx: Ctx, clip: TextClip, local?: number): void {
  const m = measureText(clip);
  const s = clip.transform.scale;
  const fs = clip.fontSize;
  const animated = local !== undefined && textAnimActive(clip, local);
  const block = animated ? blockState(clip, local!) : REST;
  if (block.alpha <= 0.001) return;

  ctx.save();
  ctx.scale(s, s);
  if (block !== REST) {
    ctx.translate(block.dx * fs, block.dy * fs);
    if (block.pivotY !== 0) ctx.translate(0, block.pivotY * m.height);
    if (block.rot) ctx.rotate(block.rot);
    if (block.sx !== 1 || block.sy !== 1) ctx.scale(block.sx, block.sy);
    if (block.pivotY !== 0) ctx.translate(0, -block.pivotY * m.height);
    ctx.globalAlpha *= block.alpha;
  }

  if (clip.background) {
    ctx.fillStyle = clip.background;
    const r = Math.min(1, Math.max(0, clip.backgroundRadius ?? 0)) * Math.min(m.width, m.height) * 0.5;
    roundedRect(ctx, -m.width / 2, -m.height / 2, m.width, m.height, r);
    ctx.fill();
  }

  ctx.font = textFont(clip);
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;

  const perGlyph = animated || m.spacing !== 0;
  const units = animated ? textAnimUnits(clip) : null;
  const layout = perGlyph ? layoutGlyphs(ctx, clip, m, animated ? block.spacing * fs : 0) : null;
  const count = layout ? layout.glyphs.length : 0;
  // letter states once per frame, shared by the shadow / outline / fill passes
  const states: GlyphState[] | null =
    layout && animated ? layout.glyphs.map((g) => glyphState(clip, local!, g.index, count, g.word, layout.words, g.line, m.lines.length, units!)) : null;

  const innerW = m.width - m.pad * 2;
  const lineX = clip.align === 'left' ? -innerW / 2 : clip.align === 'right' ? innerW / 2 : 0;
  const top = -m.height / 2 + m.pad;

  /** run `paint(text, x, y)` for every piece of text with the letter transforms applied */
  const each = (paint: (text: string, x: number, y: number, st: GlyphState | null) => void): void => {
    if (!layout) {
      ctx.textAlign = clip.align;
      for (let i = 0; i < m.lines.length; i++) paint(m.lines[i]!, lineX, top + m.lineHeight * (i + 0.5), null);
      return;
    }
    ctx.textAlign = 'center';
    for (let i = 0; i < layout.glyphs.length; i++) {
      const g = layout.glyphs[i]!;
      if (g.ch.trim() === '') continue;
      const st = states ? states[i]! : null;
      if (!st || st === REST) {
        paint(g.ch, g.x, g.y, null);
        continue;
      }
      if (st.alpha <= 0.001) continue;
      ctx.save();
      ctx.translate(g.x + st.dx * fs, g.y + st.dy * fs);
      if (st.rot) ctx.rotate(st.rot);
      if (st.sx !== 1 || st.sy !== 1) ctx.scale(st.sx, st.sy);
      ctx.globalAlpha *= st.alpha;
      paint(g.ch, 0, 0, st);
      ctx.restore();
    }
  };

  const stroke = clip.stroke && clip.stroke.width > 0 ? clip.stroke : null;
  const strokeW = stroke ? stroke.width * fs * 2 : 0; // half of the line is hidden under the fill

  const shadow = clip.shadow && clip.shadow.opacity > 0 ? clip.shadow : null;
  if (shadow) {
    // draw the letters far outside the canvas and let only their shadow land on it: the shadow of one
    // letter then never covers its neighbour, and it can be softer than the letter
    const t = ctx.getTransform();
    const dev = Math.hypot(t.a, t.b) || 1; // device pixels per unit (shadow sizes ignore the transform)
    const rad = (shadow.angle * Math.PI) / 180;
    ctx.save();
    ctx.setTransform(t.a, t.b, t.c, t.d, t.e - FAR, t.f);
    ctx.shadowColor = shadow.color;
    ctx.shadowBlur = shadow.blur * fs * dev;
    ctx.shadowOffsetX = FAR + Math.cos(rad) * shadow.distance * fs * dev;
    ctx.shadowOffsetY = Math.sin(rad) * shadow.distance * fs * dev;
    ctx.globalAlpha *= Math.min(1, shadow.opacity);
    ctx.fillStyle = '#000';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = strokeW;
    each((text, x, y) => {
      if (stroke) ctx.strokeText(text, x, y);
      ctx.fillText(text, x, y);
    });
    ctx.restore();
  }

  if (stroke) {
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = strokeW;
    each((text, x, y) => ctx.strokeText(text, x, y));
  }

  ctx.fillStyle = clip.color;
  each((text, x, y, st) => {
    if (st && st.hue !== undefined) {
      ctx.fillStyle = hueColor(st.hue);
      ctx.fillText(text, x, y);
      ctx.fillStyle = clip.color;
    } else ctx.fillText(text, x, y);
  });
  ctx.restore();
}
