/**
 * text clips: measuring and drawing, including style (letter spacing, outline, shadow, rounded box,
 * gradient fill, wrapping, curved lines) and the per letter text animations.
 * shared by the 2d frame renderer and the 3d text textures.
 */
import { ensureFont, fontsVersion } from '../lib/fonts';
import { isExporting } from './exportState';
import type { TextAlign, TextClip, TextGradient, TextStroke } from '../types';
import type { CounterMark, DigitRange } from './counter';
import { type GlyphState, REST, blockState, glyphState, scrambleChar, textAnimActive, textAnimUnits } from './textAnim';

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

/** where one letter sits (relative to the box center) */
export interface TextGlyph {
  ch: string;
  /** center x and width */
  x: number;
  w: number;
  /** middle of the line */
  y: number;
  /** rotation of the letter in radians (curved text), 0 on a straight line */
  rot: number;
  /** index among the drawn letters (spaces count too), and of its word and line */
  index: number;
  word: number;
  line: number;
}

export interface TextBox {
  /** unscaled size of the box (text + padding). for curved text: the bounding box of the curved lines. */
  width: number;
  height: number;
  /** the lines after wrapping */
  lines: string[];
  lineHeight: number;
  pad: number;
  /** width of each line without padding (along the line, also when it is curved) */
  lineWidths: number[];
  /** extra pixels between letters */
  spacing: number;
  /** degrees of arc of the widest line, 0 = straight */
  curve: number;
  /** curved text: width of the widest line, the reference for the radius */
  curveRef: number;
  /** curved text: center of the curved layout in its own coordinates */
  curveCx: number;
  curveCy: number;
  /** letter layout at rest, filled the first time it is needed */
  glyphCache: { glyphs: TextGlyph[]; words: number } | null;
  /** prefix widths of every line (see lineEdges), filled the first time they are needed */
  edges: number[][] | null;
  /** steady digits: per line, which letters are counter digits that take the same width. null / missing = none. */
  digits?: boolean[][] | null;
}

/* ---------- wrapping (pure) ---------- */

export type Measure = (text: string) => number;

/** width of a string with letter spacing between its letters (not after the last) */
function spacedWidth(measure: Measure, s: string, spacing: number): number {
  const w = measure(s);
  return spacing !== 0 ? w + spacing * Math.max(0, Array.from(s).length - 1) : w;
}

/**
 * break one line at spaces so no piece is wider than maxWidth. a single word wider than that stays whole.
 * the space where it breaks is dropped. maxWidth <= 0 = no wrapping.
 */
export function wrapLine(line: string, maxWidth: number, measure: Measure, spacing = 0): string[] {
  if (!(maxWidth > 0) || !line.includes(' ')) return [line];
  if (spacedWidth(measure, line, spacing) <= maxWidth) return [line];
  const words = line.split(' ');
  const out: string[] = [];
  let cur = words[0]!;
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!;
    const cand = cur + ' ' + w;
    if (spacedWidth(measure, cand, spacing) <= maxWidth) cur = cand;
    else {
      out.push(cur);
      cur = w;
    }
  }
  out.push(cur);
  return out;
}

/** split text at its line breaks, then wrap every line */
export function wrapText(text: string, maxWidth: number, measure: Measure, spacing = 0): string[] {
  const raw = text.split('\n');
  if (!(maxWidth > 0)) return raw;
  const out: string[] = [];
  for (const l of raw) for (const p of wrapLine(l, maxWidth, measure, spacing)) out.push(p);
  return out;
}

/* ---------- curved layout (pure) ---------- */

export interface CurvedGlyph {
  line: number;
  /** index in the line */
  i: number;
  x: number;
  y: number;
  rot: number;
  w: number;
}

export interface CurveLayout {
  glyphs: CurvedGlyph[];
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/**
 * lay lines out along circles. `edges[line][k]` = width of the first k letters (so edges[line].length - 1 letters).
 * the widest line (refWidth) spans |curveDeg| degrees, the radius is refWidth / radians. lines further down sit
 * on concentric circles lineHeight apart: curveDeg > 0 is an arch (center of the circle below, later lines
 * closer to it), < 0 a smile. coordinates: x = 0 on the axis of the circle, y = 0 at the top of the first line's
 * slot, so the first line's apex is at y = lineHeight / 2. letters are rotated to the tangent.
 */
export function curveLayout(
  edges: number[][],
  spacing: number,
  lineHeight: number,
  curveDeg: number,
  align: TextAlign,
  refWidth: number,
): CurveLayout {
  const arc = (Math.min(360, Math.abs(curveDeg)) * Math.PI) / 180;
  const k = curveDeg >= 0 ? 1 : -1;
  const ref = Math.max(1, refWidth);
  const r0 = ref / Math.max(arc, 1e-6);
  const minR = lineHeight * 0.25;
  const yc = lineHeight * 0.5 + k * r0;
  const glyphs: CurvedGlyph[] = [];
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  const hh = lineHeight / 2;
  for (let li = 0; li < edges.length; li++) {
    const e = edges[li]!;
    const n = e.length - 1;
    const lineW = (e[n] ?? 0) + spacing * Math.max(0, n - 1);
    const r = Math.max(minR, r0 - k * li * lineHeight);
    // arc length of the line's left end, measured from the top of the circle
    const s0 = align === 'left' ? -ref / 2 : align === 'right' ? ref / 2 - lineW : -lineW / 2;
    for (let i = 0; i < n; i++) {
      const w = e[i + 1]! - e[i]!;
      const phi = (s0 + e[i]! + spacing * i + w / 2) / r;
      const x = r * Math.sin(phi);
      const y = yc - k * r * Math.cos(phi);
      const rot = k * phi;
      const c = Math.abs(Math.cos(rot));
      const sn = Math.abs(Math.sin(rot));
      const ex = (w / 2) * c + hh * sn;
      const ey = (w / 2) * sn + hh * c;
      if (x - ex < minX) minX = x - ex;
      if (x + ex > maxX) maxX = x + ex;
      if (y - ey < minY) minY = y - ey;
      if (y + ey > maxY) maxY = y + ey;
      glyphs.push({ line: li, i, x, y, rot, w });
    }
  }
  if (!glyphs.length) {
    minX = maxX = 0;
    minY = maxY = 0;
  }
  return { glyphs, minX, maxX, minY, maxY };
}

/* ---------- extrude (pure) ---------- */

/** most copies drawn for one extrude, deeper blocks use larger steps */
export const EXTRUDE_MAX_STEPS = 64;

/**
 * the offsets of the copies that make the side of the letters, from the far end toward the face (the last one is
 * one step away from the face, the face itself is drawn on top). one copy per pixel of depth, at most `cap` copies
 * (then the steps get larger so the block stays solid). angle = degrees clockwise from the right (90 = down).
 * depthPx <= 0 = no copies.
 */
export function extrudeOffsets(depthPx: number, angleDeg: number, cap = EXTRUDE_MAX_STEPS): { dx: number; dy: number }[] {
  if (!(depthPx > 0) || !(cap >= 1)) return [];
  const n = Math.min(Math.floor(cap), Math.max(1, Math.ceil(depthPx)));
  const a = (angleDeg * Math.PI) / 180;
  const cx = Math.cos(a);
  const cy = Math.sin(a);
  const out: { dx: number; dy: number }[] = [];
  for (let i = 0; i < n; i++) {
    const d = (depthPx * (n - i)) / n;
    out.push({ dx: cx * d, dy: cy * d });
  }
  return out;
}

/**
 * the alpha each of `copies` stacked copies needs so that together they composite to `alpha`:
 * 1 - (1 - a')^copies = alpha. exact where all the copies overlap, an approximation at the edges of the side.
 */
export function stackAlpha(alpha: number, copies: number): number {
  if (!(alpha < 1)) return 1;
  if (!(alpha > 0)) return 0;
  if (!(copies > 1)) return alpha;
  return 1 - Math.pow(1 - alpha, 1 / copies);
}

/** most copies of a side that cover one point inside a stem of a letter: stem width / distance between two copies (stem ~ 0.15 em) */
export function sideOverlap(copies: number, depthPx: number, fontSizePx: number): number {
  if (copies <= 1 || !(depthPx > 0)) return 1;
  const step = depthPx / copies;
  return Math.min(copies, Math.max(1, Math.round((fontSizePx * 0.15) / step)));
}

/** line width of the outline of hollow letters without an outline of their own, in block units */
export function hollowEdgeWidth(fontSize: number): number {
  return Math.max(1, fontSize / 30);
}

/**
 * line widths of the outlines, in block units (the context's line width: half of it is hidden under the fill).
 * `inner` = the first outline (hollow letters have no fill, so their line is drawn at its real width and a hollow
 * text without an outline gets the thin one), `outer` = the line that reaches around everything: the first outline's
 * width plus twice the second outline's own. the side of the letters and the shadow follow `outer`.
 * hollow + stroke2: the second line is a ring around the ring, it also grows into the hole by its own width (the hole
 * stays a hole, just smaller); the first outline is drawn on top of it.
 */
export function strokeWidths(
  stroke: TextStroke | null | undefined,
  stroke2: TextStroke | null | undefined,
  hollow: boolean,
  fontSize: number,
): { inner: number; outer: number } {
  const s = stroke && stroke.width > 0 ? stroke : null;
  const inner = hollow ? (s ? s.width * fontSize : hollowEdgeWidth(fontSize)) : s ? s.width * fontSize * 2 : 0;
  const outer = stroke2 && stroke2.width > 0 ? inner + stroke2.width * fontSize * 2 : inner;
  return { inner, outer };
}

/* ---------- steady digits (pure) ---------- */

function cpCount(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/**
 * can a code point of this line not be drawn alone? right-to-left scripts (letters join and reorder), combining marks
 * (they sit on the letter before), joiners, variation selectors, emoji modifiers, flags (regional indicator pairs).
 * steady digits draw one code point at a time, which would break these.
 */
const NEEDS_WHOLE_LINE = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]|\p{M}|[\u200C\u200D\uFE00-\uFE0F\u{E0100}-\u{E01EF}]|\p{Emoji_Modifier}|\p{Regional_Indicator}/u;
export function needsWholeLine(line: string): boolean {
  return NEEDS_WHOLE_LINE.test(line);
}

/**
 * which letters of the wrapped lines are digits of the counter's number. `ranges` are code point ranges of the whole
 * text; wrapping drops one separator (a line break or a space) between neighbouring lines, so a line starts one letter
 * after the previous one ended. null when no letter qualifies or the lines do not add up to the text.
 * also null when a line holds something that cannot be drawn one code point at a time (needsWholeLine): the digit
 * layout draws the whole text per code point, so it is skipped and the text is drawn as one string per line as
 * without the switch.
 */
export function counterDigitFlags(lines: string[], ranges: readonly DigitRange[] | undefined, textLength: number): boolean[][] | null {
  if (!ranges || ranges.length === 0) return null;
  if (lines.some(needsWholeLine)) return null;
  const chars = lines.map((l) => Array.from(l));
  let total = Math.max(0, chars.length - 1);
  for (const c of chars) total += c.length;
  if (total !== textLength) return null;
  const out: boolean[][] = [];
  let any = false;
  let pos = 0;
  for (const c of chars) {
    const flags = new Array<boolean>(c.length).fill(false);
    for (let i = 0; i < c.length; i++) {
      const ch = c[i]!;
      if (ch < '0' || ch > '9') continue;
      const at = pos + i;
      for (const r of ranges) {
        if (at >= r[0] && at < r[1]) {
          flags[i] = true;
          any = true;
          break;
        }
      }
    }
    out.push(flags);
    pos += c.length + 1;
  }
  return any ? out : null;
}

/** prefix widths where every flagged letter takes `cell` and the others keep their natural advance */
export function fixedDigitEdges(natural: number[], flags: readonly boolean[], cell: number): number[] {
  const out: number[] = [0];
  for (let i = 0; i + 1 < natural.length; i++) out.push(out[i]! + (flags[i] ? cell : natural[i + 1]! - natural[i]!));
  return out;
}

/** the digit marker of a resolved counter clip, if there is one */
function digitRangesOf(clip: TextClip): readonly DigitRange[] | undefined {
  return (clip as TextClip & CounterMark).digitRanges;
}

const extrudeCache = { depth: -1, angle: 0, dev: 0, list: [] as { dx: number; dy: number }[] };
/** extrudeOffsets in the units of the block (not device pixels), the last result is kept */
function blockExtrudeOffsets(depthUnits: number, angle: number, dev: number): { dx: number; dy: number }[] {
  const c = extrudeCache;
  if (c.depth === depthUnits && c.angle === angle && c.dev === dev) return c.list;
  c.depth = depthUnits;
  c.angle = angle;
  c.dev = dev;
  c.list = extrudeOffsets(depthUnits * dev, angle).map((o) => ({ dx: o.dx / dev, dy: o.dy / dev }));
  return c.list;
}

/* ---------- line geometry (pure) ---------- */

export interface LineRect {
  x: number;
  y: number;
  w: number;
  h: number;
  /** index of the line it belongs to */
  line: number;
}

export interface LineSpan {
  /** left edge and width of the drawn line (without padding), relative to the block's center */
  left: number;
  width: number;
}

/** letters per line (code points, the same count the glyph layout uses) */
export function lineLengths(lines: string[]): number[] {
  return lines.map((l) => {
    let n = 0;
    for (const _ of l) n++;
    return n;
  });
}

/**
 * where every line is drawn horizontally. `lineWidths` = the measured widths, `innerW` = the block without padding,
 * `extra` = extra letter spacing in pixels (a spacing animation) which needs `letters` (letters per line).
 */
export function lineSpans(lineWidths: number[], letters: number[] | null, innerW: number, align: TextAlign, extra = 0): LineSpan[] {
  return lineWidths.map((lw, i) => {
    const width = extra !== 0 && letters ? lw + extra * Math.max(0, (letters[i] ?? 0) - 1) : lw;
    const left = align === 'left' ? -innerW / 2 : align === 'right' ? innerW / 2 - width : -width / 2;
    return { left, width };
  });
}

/** thickness of an underline / strike as a fraction of the font size */
export const TEXT_LINE_THICKNESS = 1 / 14;
/** distance of the underline's middle below the middle of the line, and of the strike, as fractions of the font size */
export const TEXT_UNDERLINE_OFFSET = 0.42;
export const TEXT_STRIKE_OFFSET = 0.05;

/**
 * the rectangles of the underline / strike of every line. `top` = y of the first line's slot. lines without width get none.
 */
export function lineDecorations(
  spans: LineSpan[],
  lineHeight: number,
  top: number,
  fontSize: number,
  underline: boolean,
  strike: boolean,
): LineRect[] {
  const out: LineRect[] = [];
  const t = fontSize * TEXT_LINE_THICKNESS;
  for (let i = 0; i < spans.length; i++) {
    const sp = spans[i]!;
    if (!(sp.width > 0)) continue;
    const cy = top + lineHeight * (i + 0.5);
    if (strike) out.push({ x: sp.left, y: cy + fontSize * TEXT_STRIKE_OFFSET - t / 2, w: sp.width, h: t, line: i });
    if (underline) out.push({ x: sp.left, y: cy + fontSize * TEXT_UNDERLINE_OFFSET - t / 2, w: sp.width, h: t, line: i });
  }
  return out;
}

/**
 * one box per line, each as wide as its line plus the padding. neighbours touch (every box fills its line slot); the first
 * box reaches `pad` above the text and the last `pad` below it, like the single block box does.
 */
export function lineBackgrounds(spans: LineSpan[], lineHeight: number, top: number, pad: number): LineRect[] {
  const out: LineRect[] = [];
  const last = spans.length - 1;
  for (let i = 0; i <= last; i++) {
    const sp = spans[i]!;
    if (!(sp.width > 0)) continue;
    const y0 = top + lineHeight * i - (i === 0 ? pad : 0);
    const y1 = top + lineHeight * (i + 1) + (i === last ? pad : 0);
    out.push({ x: sp.left - pad, y: y0, w: sp.width + pad * 2, h: y1 - y0, line: i });
  }
  return out;
}

/** how much of a line shows while its letters animate: the span of the visible letters and the strongest alpha */
export interface LineVisibility {
  x0: number;
  x1: number;
  alpha: number;
  /** every letter of the line shows */
  all: boolean;
}

/** per line: null = no letter shows */
export function lineVisibility(
  glyphs: ArrayLike<Pick<TextGlyph, 'ch' | 'x' | 'w' | 'line'>>,
  alphas: ArrayLike<number>,
  lineCount: number,
): (LineVisibility | null)[] {
  const out: (LineVisibility | null)[] = new Array<LineVisibility | null>(lineCount).fill(null);
  const hidden: boolean[] = new Array<boolean>(lineCount).fill(false);
  for (let i = 0; i < glyphs.length; i++) {
    const g = glyphs[i]!;
    if (g.ch.trim() === '') continue;
    const a = alphas[i] ?? 1;
    if (a <= 0.001) {
      hidden[g.line] = true;
      continue;
    }
    const cur = out[g.line];
    const x0 = g.x - g.w / 2;
    const x1 = g.x + g.w / 2;
    if (!cur) out[g.line] = { x0, x1, alpha: a, all: true };
    else {
      cur.x0 = Math.min(cur.x0, x0);
      cur.x1 = Math.max(cur.x1, x1);
      cur.alpha = Math.max(cur.alpha, a);
    }
  }
  for (let l = 0; l < lineCount; l++) {
    const v = out[l];
    if (v && hidden[l]) v.all = false;
  }
  return out;
}

/* ---------- gradient (pure) ---------- */

/**
 * the two ends of a linear gradient across a w x h block centered on the origin.
 * angle 0 = left to right, 90 = top to bottom. the line is long enough that the corners get the end colors.
 */
export function gradientLine(angle: number, w: number, h: number): [number, number, number, number] {
  const a = (angle * Math.PI) / 180;
  const dx = Math.cos(a);
  const dy = Math.sin(a);
  const half = (Math.abs(w * dx) + Math.abs(h * dy)) / 2 || 1;
  return [-dx * half, -dy * half, dx * half, dy * half];
}

interface Mat {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

/**
 * a point given in the space of matrix `from` (the block), in the space of matrix `to` (a letter inside it).
 * both are the full transform from their space to the canvas, `to` = `from` followed by the letter's own moves.
 */
export function remapPoint(from: Mat, to: Mat, x: number, y: number): [number, number] {
  const wx = from.a * x + from.c * y + from.e;
  const wy = from.b * x + from.d * y + from.f;
  const det = to.a * to.d - to.b * to.c || 1;
  const px = wx - to.e;
  const py = wy - to.f;
  return [(to.d * px - to.c * py) / det, (-to.b * px + to.a * py) / det];
}

/* ---------- measuring ---------- */

const requested = new Set<string>();
/** fonts whose load failed: not asked again before `at` (ms), the wait doubles with every failure */
const retryAfter = new Map<string, { at: number; delay: number }>();
const FONT_RETRY_FIRST_MS = 2000;
const FONT_RETRY_MAX_MS = 60000;

/** how long to wait before asking again after a failed font load (prev = the last wait, 0 for the first failure) */
export function fontRetryDelay(prev: number): number {
  return prev <= 0 ? FONT_RETRY_FIRST_MS : Math.min(FONT_RETRY_MAX_MS, prev * 2);
}

/**
 * ask for the clip's font (it loads in the background, the preview redraws when it arrives).
 * asked once; when the load fails it is asked again later (with a growing pause), so the preview does not stay in the
 * fallback font until a reload while the export, which loads again, would use the real one.
 */
function wantFont(clip: TextClip): void {
  const key = `${clip.fontFamily}|${clip.fontWeight}|${clip.italic}`;
  if (requested.has(key)) return;
  const wait = retryAfter.get(key);
  // no retries while an export runs: a font arriving half way would change the look in the middle of the file
  if (wait && (isExporting() || Date.now() < wait.at)) return;
  requested.add(key);
  const failed = (): void => {
    requested.delete(key);
    const delay = fontRetryDelay(retryAfter.get(key)?.delay ?? 0);
    retryAfter.set(key, { at: Date.now() + delay, delay });
  };
  ensureFont(clip.fontFamily, clip.fontWeight, clip.italic).then((ok) => {
    if (ok) retryAfter.delete(key);
    else failed();
  }, failed);
}

/**
 * add to a cache keyed by text and drop the oldest entries past `max`: a text that changes every frame (a running
 * counter that reaches here unresolved) cannot make the cache grow, and does not wipe the other clips' entries.
 */
function capSet<V>(map: Map<string, V>, key: string, value: V, max: number): void {
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

const boxCache = new Map<string, TextBox>();
/** clips are immutable: the box of the very same object only needs looking up once per font version */
const boxByClip = new WeakMap<TextClip, { v: number; box: TextBox }>();

const edgesCache = new Map<string, number[]>();
/** widths of the first 0..n letters of a line (prefixes are measured so kerning stays right). the font must be set on ctx. */
function lineEdges(ctx: Ctx, font: string, line: string): number[] {
  const key = `${fontsVersion()}|${font}|${line}`;
  const hit = edgesCache.get(key);
  if (hit) return hit;
  const edges: number[] = [0];
  let acc = '';
  for (const ch of line) {
    acc += ch;
    edges.push(ctx.measureText(acc).width);
  }
  capSet(edgesCache, key, edges, 600);
  return edges;
}

const digitCellCache = new Map<string, number>();
/** advance of the widest digit 0..9 of a font. measured once per font (and fonts version). the font must be set on ctx. */
function digitCell(ctx: Ctx, font: string): number {
  const key = `${fontsVersion()}|${font}`;
  const hit = digitCellCache.get(key);
  if (hit !== undefined) return hit;
  let cell = 0;
  for (let d = 0; d < 10; d++) cell = Math.max(cell, ctx.measureText(String(d)).width);
  capSet(digitCellCache, key, cell, 100);
  return cell;
}

const widestCache = new Map<string, string>();
/** the digit character with the largest advance in a font (what a steady digit is measured as) */
function widestDigit(ctx: Ctx, font: string): string {
  const key = `${fontsVersion()}|${font}`;
  const hit = widestCache.get(key);
  if (hit !== undefined) return hit;
  let best = '0';
  let w = -1;
  for (let d = 0; d < 10; d++) {
    const x = ctx.measureText(String(d)).width;
    if (x > w) {
      w = x;
      best = String(d);
    }
  }
  capSet(widestCache, key, best, 100);
  return best;
}

const fixedEdgesCache = new Map<string, number[]>();
/** lineEdges, with the flagged letters (counter digits) widened to the font's widest digit */
function lineEdgesFor(ctx: Ctx, font: string, line: string, flags: readonly boolean[] | null): number[] {
  if (!flags) return lineEdges(ctx, font, line);
  const key = `${fontsVersion()}|${font}|${line}|${flags.map((f) => (f ? 1 : 0)).join('')}`;
  const hit = fixedEdgesCache.get(key);
  if (hit) return hit;
  const edges = fixedDigitEdges(lineEdges(ctx, font, line), flags, digitCell(ctx, font));
  capSet(fixedEdgesCache, key, edges, 600);
  return edges;
}

/** unscaled size of a text clip's box (text + padding) and its lines */
export function measureText(clip: TextClip): TextBox {
  const v = fontsVersion();
  if (retryAfter.size > 0) wantFont(clip); // cheap: only while some font failed to load
  const front = boxByClip.get(clip);
  if (front && front.v === v) return front.box;
  wantFont(clip);
  const text = displayText(clip);
  const spacing = (clip.letterSpacing ?? 0) * clip.fontSize;
  const lineHeight = clip.fontSize * (clip.lineHeight ?? TEXT_LINE_HEIGHT);
  const pad = clip.fontSize * (clip.backgroundPadding ?? TEXT_PADDING);
  const font = textFont(clip);
  const wrap = clip.wrapWidth !== undefined && clip.wrapWidth > 0 ? clip.wrapWidth : 0;
  const rawCurve = clip.curve ?? 0;
  const curve = Math.abs(rawCurve) >= 0.01 ? Math.max(-360, Math.min(360, rawCurve)) : 0;
  const ranges = digitRangesOf(clip);
  // steady digits only apply when the drawn text has the same letters as the resolved one (capitals can change a length)
  const fixedRanges = ranges && ranges.length > 0 && cpCount(text) === cpCount(clip.text) ? ranges : undefined;
  const key = `${v}|${font}|${spacing}|${lineHeight}|${pad}|${wrap}|${curve}|${clip.align}|${text}${fixedRanges ? '|d' + fixedRanges.map((r) => r[0] + '-' + r[1]).join(',') : ''}`;
  const hit = boxCache.get(key);
  if (hit) {
    boxByClip.set(clip, { v, box: hit });
    return hit;
  }
  const ctx = getMeasureCtx();
  ctx.font = font;
  // steady digits: wrap as if every digit had the widest digit's width, so the breaks do not move while it counts
  let wrapMeasure: Measure = (s) => ctx.measureText(s).width;
  if (fixedRanges) {
    const wide = widestDigit(ctx, font);
    wrapMeasure = (s) => ctx.measureText(s.replace(/[0-9]/g, wide)).width;
  }
  const lines = wrapText(text, wrap, wrapMeasure, spacing);
  const digits = fixedRanges ? counterDigitFlags(lines, fixedRanges, cpCount(text)) : null;
  const lineWidths = lines.map((l, i) => {
    const flags = digits?.[i];
    if (!flags || !flags.includes(true)) return spacedWidth((s) => ctx.measureText(s).width, l, spacing);
    const e = lineEdgesFor(ctx, font, l, flags);
    return e[e.length - 1]! + spacing * Math.max(0, e.length - 2);
  });
  let max = 0;
  for (const w of lineWidths) max = Math.max(max, w);
  const box: TextBox = {
    width: Math.max(1, max + pad * 2),
    height: lines.length * lineHeight + pad * 2,
    lines,
    lineHeight,
    pad,
    lineWidths,
    spacing,
    curve,
    curveRef: Math.max(1, max),
    curveCx: 0,
    curveCy: 0,
    glyphCache: null,
    edges: null,
    digits,
  };
  if (digits) box.edges = lines.map((l, i) => lineEdgesFor(ctx, font, l, digits[i] ?? null));
  if (curve !== 0) {
    const edges = (box.edges ??= lines.map((l, i) => lineEdgesFor(ctx, font, l, digits?.[i] ?? null)));
    const cl = curveLayout(edges, spacing, lineHeight, curve, clip.align, box.curveRef);
    box.curveCx = (cl.minX + cl.maxX) / 2;
    box.curveCy = (cl.minY + cl.maxY) / 2;
    box.width = Math.max(1, cl.maxX - cl.minX + pad * 2);
    box.height = Math.max(1, cl.maxY - cl.minY + pad * 2);
  }
  capSet(boxCache, key, box, 300);
  boxByClip.set(clip, { v, box });
  return box;
}

/** how far (as a fraction of the font size) letters can reach outside the box: outline, shadow, animation */
export function textSpill(clip: TextClip, animated: boolean, noExtrude = false): number {
  let s = 0.05;
  if (clip.stroke) s += clip.stroke.width;
  if (clip.stroke2 && clip.stroke2.width > 0) s += clip.stroke2.width; // the second outline reaches its own width past the first
  if (clip.shadow) s += clip.shadow.distance + clip.shadow.blur * 2;
  if (animated) s += 1.5;
  if (!noExtrude && clip.extrude && clip.extrude.depth > 0) s += Math.min(1, clip.extrude.depth); // the side reaches this far in any direction (3d depth text has no flat side)
  if (clip.highlight?.background) s += 0.15; // the box behind the lit word reaches a little past the letters
  return s;
}

const sigCache = new WeakMap<TextClip, { v: number; sig: string }>();
/** everything that changes how a text clip looks at rest (a cache key for rendered text; position and animation not included) */
export function textSignature(clip: TextClip): string {
  const v = fontsVersion();
  const hit = sigCache.get(clip);
  if (hit && hit.v === v) return hit.sig;
  const sig = [
    v,
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
    clip.stroke2 ? JSON.stringify(clip.stroke2) : '',
    JSON.stringify(clip.shadow ?? 0),
    clip.backgroundRadius,
    clip.backgroundPadding,
    JSON.stringify(clip.gradient ?? 0),
    clip.curve,
    clip.wrapWidth,
    clip.highlight ? JSON.stringify(clip.highlight) : '',
    clip.extrude ? JSON.stringify(clip.extrude) : '',
    clip.underline ? 'u' : '',
    clip.strike ? 's' : '',
    clip.hollow ? 'h' : '',
    clip.backgroundPerLine ? 'p' : '',
    digitRangesOf(clip) ? 'd' + digitRangesOf(clip)!.map((r) => r[0] + '-' + r[1]).join(',') : '',
  ].join('|');
  sigCache.set(clip, { v, sig });
  return sig;
}

/**
 * true when some animation moves letters (or words / lines) on their own at this clip-local time. block animations
 * (pulse, wobble ...) move the whole text and do not need the letters laid out one by one.
 */
export function glyphAnimActive(clip: TextClip, local: number, units: ReturnType<typeof textAnimUnits>): boolean {
  if (units.enter && units.enter.unit !== 'block' && clip.animIn && local < clip.animIn.duration) return true;
  if (units.exit && units.exit.unit !== 'block' && clip.animOut && local > clip.duration - clip.animOut.duration) return true;
  if (units.loop && units.loop.unit !== 'block' && clip.animLoop) return true;
  return false;
}

/* ---------- karaoke (pure) ---------- */

/**
 * which word is current at `progress` (0..1 over the clip's length). every word holds the stage for a slice of the
 * clip proportional to its number of letters. -1 when there are no words.
 */
export function highlightIndexFromCounts(counts: ArrayLike<number>, progress: number): number {
  const n = counts.length;
  if (n === 0) return -1;
  let total = 0;
  for (let i = 0; i < n; i++) total += Math.max(1, counts[i]!);
  const p = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0;
  const at = p * total;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += Math.max(1, counts[i]!);
    if (at < acc) return i;
  }
  return n - 1;
}

/** same as highlightIndexFromCounts for a list of words */
export function highlightIndex(words: string[], progress: number): number {
  return highlightIndexFromCounts(
    words.map((w) => Array.from(w).length),
    progress,
  );
}

/** is the word lit? `current` = the current word (-1 = none) */
export function wordLit(mode: 'word' | 'fill', word: number, current: number): boolean {
  if (current < 0) return false;
  return mode === 'fill' ? word <= current : word === current;
}

/** letters per word of a laid out text (spaces do not count) */
function wordLetterCounts(layout: { glyphs: TextGlyph[]; words: number }): number[] {
  const hit = wordCountCache.get(layout.glyphs);
  if (hit) return hit;
  const counts = new Array<number>(layout.words).fill(0);
  for (const g of layout.glyphs) if (g.ch.trim() !== '') counts[g.word] = (counts[g.word] ?? 0) + 1;
  wordCountCache.set(layout.glyphs, counts);
  return counts;
}
const wordCountCache = new WeakMap<TextGlyph[], number[]>();

/** padding and corner radius of the box behind the lit word, as fractions of the font size */
const HL_PAD = 0.12;
const HL_RADIUS = 0.2;

/* ---------- letter layout ---------- */

/** where every letter sits. only needed when letters are drawn one by one. */
function layoutGlyphs(ctx: Ctx, clip: TextClip, m: TextBox, extraSpacing: number): { glyphs: TextGlyph[]; words: number } {
  const glyphs: TextGlyph[] = [];
  const font = textFont(clip);
  const innerW = m.width - m.pad * 2;
  const top = -m.height / 2 + m.pad;
  const spacing = m.spacing + extraSpacing;
  const edgesOf = (m.edges ??= m.lines.map((l, i) => lineEdgesFor(ctx, font, l, m.digits?.[i] ?? null)));
  const curved = m.curve !== 0 ? curveLayout(edgesOf, spacing, m.lineHeight, m.curve, clip.align, m.curveRef) : null;
  let cg = 0;
  let index = 0;
  let word = 0;
  for (let li = 0; li < m.lines.length; li++) {
    const chars = Array.from(m.lines[li]!);
    const edges = edgesOf[li]!;
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
      if (curved) {
        const p = curved.glyphs[cg++]!;
        glyphs.push({ ch, x: p.x - m.curveCx, w, y: p.y - m.curveCy, rot: p.rot, index, word, line: li });
      } else {
        glyphs.push({ ch, x: left + edges[i]! + spacing * i + w / 2, w, y, rot: 0, index, word, line: li });
      }
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

/** a gradient across the block, in the space of ctx as it is now */
function blockGradient(ctx: Ctx, g: TextGradient, w: number, h: number): CanvasGradient | null {
  const [x0, y0, x1, y1] = gradientLine(g.angle, w, h);
  return makeGradient(ctx, g, x0, y0, x1, y1);
}

function makeGradient(ctx: Ctx, g: TextGradient, x0: number, y0: number, x1: number, y1: number): CanvasGradient | null {
  try {
    const grad = ctx.createLinearGradient(x0, y0, x1, y1);
    grad.addColorStop(0, g.from);
    grad.addColorStop(1, g.to);
    return grad;
  } catch {
    return null; // a color the canvas does not understand
  }
}

export interface DrawTextOptions {
  /** leave the flat extrude out (3d depth text draws its side as planes, see engine/textDepth.ts) */
  noExtrude?: boolean;
  /** letters only: no background boxes and no shadow (the picture a flat silhouette is made from) */
  bare?: boolean;
}

/**
 * draw a text clip centered on the origin of the context (the caller already moved / rotated it).
 * applies transform.scale. `local` = seconds since the clip started (drives the text animations);
 * leave it out for a still picture of the text at rest.
 */
export function drawText(ctx: Ctx, clip: TextClip, local?: number, opts?: DrawTextOptions): void {
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

  const extra = animated ? block.spacing * fs : 0;
  const innerW = m.width - m.pad * 2;
  const innerH = m.height - m.pad * 2;
  const top = -m.height / 2 + m.pad;
  // underline / strike / per line boxes follow the straight lines (curved text keeps its single box and gets no lines)
  const straight = m.curve === 0;
  const wantLines = straight && (!!clip.underline || !!clip.strike);
  const perLine = straight && !!clip.backgroundPerLine && !!clip.background;
  const spans = wantLines || perLine ? lineSpans(m.lineWidths, extra !== 0 ? lineLengths(m.lines) : null, innerW, clip.align, extra) : null;

  if (clip.background && !opts?.bare) {
    ctx.fillStyle = clip.background;
    const rad = Math.min(1, Math.max(0, clip.backgroundRadius ?? 0));
    if (perLine && spans) {
      // one box per line, hugging the line (the caption look)
      for (const b of lineBackgrounds(spans, m.lineHeight, top, m.pad)) {
        roundedRect(ctx, b.x, b.y, b.w, b.h, rad * Math.min(b.w, b.h) * 0.5);
        ctx.fill();
      }
    } else {
      // curved text: the box behind it is the bounding box of the curved lines (the same box the selection uses)
      roundedRect(ctx, -m.width / 2, -m.height / 2, m.width, m.height, rad * Math.min(m.width, m.height) * 0.5);
      ctx.fill();
    }
  }

  ctx.font = textFont(clip);
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;

  const units = animated ? textAnimUnits(clip) : null;
  // letters are only drawn one by one when something needs it: spacing, a curve, a letter animation. a block animation
  // (pulse, wobble ...) moves the whole text, which stays on the cheap one fill per line path.
  const letterAnim = animated && glyphAnimActive(clip, local!, units!);
  // karaoke needs the letters one by one too, but only while there is a time to light words at
  const hl = local !== undefined && clip.highlight ? clip.highlight : null;
  // steady digits are laid out in cells, which a whole line fill cannot do
  const perGlyph = letterAnim || extra !== 0 || m.spacing !== 0 || m.curve !== 0 || hl !== null || !!m.digits;
  let layout: { glyphs: TextGlyph[]; words: number } | null = null;
  if (perGlyph) {
    if (extra !== 0) layout = layoutGlyphs(ctx, clip, m, extra);
    else layout = m.glyphCache ??= layoutGlyphs(ctx, clip, m, 0);
  }
  const count = layout ? layout.glyphs.length : 0;
  let litWord = -1;
  if (hl && layout) litWord = highlightIndexFromCounts(wordLetterCounts(layout), clip.duration > 0 ? local! / clip.duration : 0);
  // letter states once per frame, shared by the shadow / outline / fill passes
  const states: GlyphState[] | null =
    layout && letterAnim ? layout.glyphs.map((g) => glyphState(clip, local!, g.index, count, g.word, layout.words, g.line, m.lines.length, units!)) : null;

  const lineX = clip.align === 'left' ? -innerW / 2 : clip.align === 'right' ? innerW / 2 : 0;

  const gradient = clip.gradient ?? null;
  // the transform of the whole block: letters that move on their own need the gradient mapped into their frame
  const ext = !opts?.noExtrude && clip.extrude && clip.extrude.depth > 0 ? clip.extrude : null;
  const blockT = gradient || animated || ext ? ctx.getTransform() : null;
  const dev = blockT ? Math.hypot(blockT.a, blockT.b) || 1 : 1;
  const canFilter = 'filter' in ctx;

  /**
   * run `paint(text, x, y, state, moved)` for every piece of text with the letter transforms applied.
   * moved = the letter has its own transform (the context is not the block's any more).
   * blurred letters use ctx.filter when `filter` is set, a fade otherwise.
   */
  const each = (
    paint: (text: string, x: number, y: number, st: GlyphState | null, moved: boolean, glyph: TextGlyph | null) => void,
    filter: boolean,
  ): void => {
    if (!layout) {
      ctx.textAlign = clip.align;
      for (let i = 0; i < m.lines.length; i++) paint(m.lines[i]!, lineX, top + m.lineHeight * (i + 0.5), null, false, null);
      return;
    }
    ctx.textAlign = 'center';
    for (let i = 0; i < layout.glyphs.length; i++) {
      const g = layout.glyphs[i]!;
      if (g.ch.trim() === '') continue;
      const st = states ? states[i]! : null;
      if (!st || st === REST) {
        if (!g.rot) {
          paint(g.ch, g.x, g.y, null, false, g);
          continue;
        }
        ctx.save();
        ctx.translate(g.x, g.y);
        ctx.rotate(g.rot);
        paint(g.ch, 0, 0, null, true, g);
        ctx.restore();
        continue;
      }
      if (st.alpha <= 0.001) continue;
      ctx.save();
      ctx.translate(g.x, g.y);
      if (g.rot) ctx.rotate(g.rot);
      ctx.translate(st.dx * fs, st.dy * fs);
      if (st.rot) ctx.rotate(st.rot);
      if (st.sx !== 1 || st.sy !== 1) ctx.scale(st.sx, st.sy);
      ctx.globalAlpha *= st.alpha;
      if (st.blur) {
        if (filter && canFilter) ctx.filter = `blur(${(st.blur * fs * dev).toFixed(2)}px)`;
        else ctx.globalAlpha *= 1 - 0.7 * Math.min(1, st.blur * 4);
      }
      paint(st.scramble !== undefined ? scrambleChar(g.ch, g.index, st.scramble) : g.ch, 0, 0, st, true, g);
      ctx.restore();
    }
  };

  const stroke = clip.stroke && clip.stroke.width > 0 ? clip.stroke : null;
  const stroke2 = clip.stroke2 && clip.stroke2.width > 0 ? clip.stroke2 : null;
  const hollow = !!clip.hollow;
  // half of the line is hidden under the fill. hollow letters have no fill: the line is drawn at its real width.
  // outerW = the line of the second outline (the widest one), which the shadow and the side follow.
  const { inner: strokeW, outer: outerW } = strokeWidths(stroke, stroke2, hollow, fs);
  const outlined = !!stroke || !!stroke2 || hollow;

  if (hl && hl.background && !opts?.bare && layout && litWord >= 0 && m.curve === 0) {
    // the box behind the current word sits under every letter pass (shadow, outline, fill)
    let x0 = Infinity;
    let x1 = -Infinity;
    let yc = 0;
    for (const g of layout.glyphs) {
      if (g.word !== litWord || g.ch.trim() === '') continue;
      x0 = Math.min(x0, g.x - g.w / 2);
      x1 = Math.max(x1, g.x + g.w / 2);
      yc = g.y;
    }
    if (x1 > x0) {
      const pad = HL_PAD * fs;
      ctx.fillStyle = hl.background;
      roundedRect(ctx, x0 - pad, yc - fs / 2 - pad, x1 - x0 + pad * 2, fs + pad * 2, HL_RADIUS * fs);
      ctx.fill();
    }
  }

  const offs = ext && blockT ? blockExtrudeOffsets(Math.min(1, ext.depth) * fs, ext.angle, dev) : null;
  // the block's directions in the frame of the current letter: where a block space step lands inside the letter's own transform
  let bax = 1;
  let bay = 0;
  let bbx = 0;
  let bby = 1;
  const setBasis = (moved: boolean): void => {
    if (!moved || !blockT) {
      bax = 1;
      bay = 0;
      bbx = 0;
      bby = 1;
      return;
    }
    const here = ctx.getTransform();
    const [ox, oy] = remapPoint(blockT, here, 0, 0);
    const [ux, uy] = remapPoint(blockT, here, 1, 0);
    const [vx, vy] = remapPoint(blockT, here, 0, 1);
    bax = ux - ox;
    bay = uy - oy;
    bbx = vx - ox;
    bby = vy - oy;
  };

  const shadow = clip.shadow && clip.shadow.opacity > 0 && !opts?.bare ? clip.shadow : null;
  if (shadow) {
    // draw the letters far outside the canvas and let only their shadow land on it: the shadow of one
    // letter then never covers its neighbour, and it can be softer than the letter
    const t = ctx.getTransform();
    const sdev = Math.hypot(t.a, t.b) || 1; // device pixels per unit (shadow sizes ignore the transform)
    const rad = (shadow.angle * Math.PI) / 180;
    ctx.save();
    ctx.setTransform(t.a, t.b, t.c, t.d, t.e - FAR, t.f);
    ctx.shadowColor = shadow.color;
    ctx.shadowBlur = shadow.blur * fs * sdev;
    ctx.shadowOffsetX = FAR + Math.cos(rad) * shadow.distance * fs * sdev;
    ctx.shadowOffsetY = Math.sin(rad) * shadow.distance * fs * sdev;
    ctx.globalAlpha *= Math.min(1, shadow.opacity);
    ctx.fillStyle = '#000';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = outerW;
    // with a side, the shadow belongs to its far end: it is cast by the farthest copy only
    const far = offs && offs.length > 0 ? offs[0]! : null;
    each((text, x, y, _st, moved) => {
      if (far) {
        setBasis(moved);
        x += far.dx * bax + far.dy * bbx;
        y += far.dx * bay + far.dy * bby;
      }
      if (outlined) ctx.strokeText(text, x, y);
      if (!hollow) ctx.fillText(text, x, y);
    }, false);
    ctx.restore();
  }

  if (offs && offs.length > 0 && ext) {
    // the side: flat copies from the far end to the face, under the outline and the fill
    ctx.fillStyle = ext.color;
    ctx.strokeStyle = ext.color;
    ctx.lineWidth = outerW;
    // a letter or block that is see-through would get a nearly opaque side from the stacked copies: each copy gets
    // the alpha that makes the whole stack composite to the wanted one (stackAlpha)
    const stepLen = Math.hypot(offs[offs.length - 1]!.dx, offs[offs.length - 1]!.dy);
    const overlap = sideOverlap(offs.length, stepLen * offs.length, fs);
    // hollow letters: the side is a swept outline, so the face stays see-through (filled copies would cover it)
    each((text, x, y, _st, moved) => {
      setBasis(moved);
      const ga = ctx.globalAlpha;
      if (ga < 1 && overlap > 1) ctx.globalAlpha = stackAlpha(ga, overlap);
      for (let k = 0; k < offs.length; k++) {
        const o = offs[k]!;
        const px = x + o.dx * bax + o.dy * bbx;
        const py = y + o.dx * bay + o.dy * bby;
        if (outlined) ctx.strokeText(text, px, py);
        if (!hollow) ctx.fillText(text, px, py);
      }
      ctx.globalAlpha = ga;
    }, true);
  }

  const blockGrad = gradient ? blockGradient(ctx, gradient, innerW, innerH) : null;
  const base: string | CanvasGradient = blockGrad ?? clip.color;

  if (hollow) {
    // hollow: nothing is filled, the outline is the letter. its color: the outline's own, else the fill (gradient included).
    if (stroke2) {
      // the second outline: a wider ring under the first one, so it shows on both sides of it
      ctx.strokeStyle = stroke2.color;
      ctx.lineWidth = outerW;
      each((text, x, y) => ctx.strokeText(text, x, y), true);
    }
    ctx.lineWidth = strokeW;
    const edge: string | CanvasGradient = stroke ? stroke.color : base;
    each((text, x, y, st, moved, glyph) => {
      let style: string | CanvasGradient = edge;
      if (hl && glyph && wordLit(hl.mode, glyph.word, litWord)) style = hl.color;
      else if (st && st.hue !== undefined) style = hueColor(st.hue);
      else if (!stroke && gradient && moved && blockGrad && blockT) {
        const [x0, y0, x1, y1] = gradientLine(gradient.angle, innerW, innerH);
        const here = ctx.getTransform();
        const [lx0, ly0] = remapPoint(blockT, here, x0, y0);
        const [lx1, ly1] = remapPoint(blockT, here, x1, y1);
        style = makeGradient(ctx, gradient, lx0, ly0, lx1, ly1) ?? edge;
      }
      ctx.strokeStyle = style;
      ctx.strokeText(text, x, y);
    }, true);
  } else {
  if (stroke2) {
    // under the first outline and the fill, around the first outline
    ctx.strokeStyle = stroke2.color;
    ctx.lineWidth = outerW;
    each((text, x, y) => ctx.strokeText(text, x, y), true);
  }
  if (stroke) {
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = strokeW;
    each((text, x, y) => ctx.strokeText(text, x, y), true);
  }

  ctx.fillStyle = base;
  each((text, x, y, st, moved, glyph) => {
    if (hl && glyph && wordLit(hl.mode, glyph.word, litWord)) {
      // a lit word takes the karaoke color whatever the fill or a color animation says
      ctx.fillStyle = hl.color;
      ctx.fillText(text, x, y);
      ctx.fillStyle = base;
    } else if (st && st.hue !== undefined) {
      // the color animations replace the gradient while they run
      ctx.fillStyle = hueColor(st.hue);
      ctx.fillText(text, x, y);
      ctx.fillStyle = base;
    } else if (gradient && moved && blockGrad && blockT) {
      // keep the gradient fixed to the block while the letter moves: map its ends into the letter's frame
      const [x0, y0, x1, y1] = gradientLine(gradient.angle, innerW, innerH);
      const here = ctx.getTransform();
      const [lx0, ly0] = remapPoint(blockT, here, x0, y0);
      const [lx1, ly1] = remapPoint(blockT, here, x1, y1);
      const g = makeGradient(ctx, gradient, lx0, ly0, lx1, ly1);
      if (g) ctx.fillStyle = g;
      ctx.fillText(text, x, y);
      ctx.fillStyle = base;
    } else ctx.fillText(text, x, y);
  }, true);
  }

  if (wantLines && spans) {
    // underline / strike: plain bars in the fill, on top of the letters. while letters animate, a line shows over the
    // span of its visible letters with their strongest alpha (so it grows in with typed / revealed letters).
    const vis = layout && states ? lineVisibility(layout.glyphs, states.map((st) => st.alpha), m.lines.length) : null;
    ctx.fillStyle = base;
    const ga = ctx.globalAlpha;
    for (const r of lineDecorations(spans, m.lineHeight, top, fs, !!clip.underline, !!clip.strike)) {
      let x = r.x;
      let w = r.w;
      let a = 1;
      if (vis) {
        const v = vis[r.line];
        if (!v) continue;
        if (!v.all) {
          const x0 = Math.max(x, v.x0);
          const x1 = Math.min(x + w, v.x1);
          x = x0;
          w = x1 - x0;
        }
        a = v.alpha;
      }
      if (!(w > 0)) continue;
      ctx.globalAlpha = ga * Math.min(1, a);
      ctx.fillRect(x, r.y, w, r.h);
    }
    ctx.globalAlpha = ga;
  }
  ctx.restore();
}
