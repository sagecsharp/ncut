/**
 * split a text clip into one text clip per letter / word / line, each sitting where that piece was on screen.
 * pure: the glyph layout comes in (so tests need no canvas), the pieces and their transforms come out.
 */
import { curveLayout } from '../../engine/text';
import { textAnimUnits } from '../../engine/textAnim';
import type { TextBox, TextGlyph } from '../../engine/text';
import { evalKeys } from '../../lib/anim';
import { stretchX, stretchY } from '../../types';
import type { Keyframes, TextClip, Transform } from '../../types';

export type SplitMode = 'letters' | 'words' | 'lines';

/** most clips one split may make (more is a mess on the timeline) */
export const MAX_PIECES = 60;

/** one piece: its text and where its center was, relative to the center of the original box (unscaled px) */
export interface SplitPiece {
  text: string;
  cx: number;
  cy: number;
  /** degrees, clockwise. only curved text has one */
  rot: number;
}

export interface SplitPlan {
  /** how many pieces this mode would make, whatever the limits */
  count: number;
  /** the pieces. empty when count < 2 (nothing to split) or count > MAX_PIECES */
  pieces: SplitPiece[];
}

const isSpace = (g: TextGlyph) => g.ch.trim() === '';

/** marks that belong to the letter before them: accents, joiners, variation selectors, skin tones, tag characters */
const JOINS_BACK = /^[\p{M}\u200d\ufe0e\ufe0f\u{1f3fb}-\u{1f3ff}\u{e0020}-\u{e007f}]$/u;
const FLAG_HALF = /^[\u{1f1e6}-\u{1f1ff}]$/u;

/**
 * the glyphs of a line as what a reader calls letters: an accent stays on its letter, an emoji made of several
 * code points (joined people, flags, skin tones) stays one piece. the layout itself is per code point.
 */
export function letterClusters(glyphs: readonly TextGlyph[]): TextGlyph[][] {
  const out: TextGlyph[][] = [];
  let flagOpen = false;
  for (const g of glyphs) {
    const last = out[out.length - 1];
    const prev = last?.[last.length - 1];
    const sameLine = !!prev && prev.line === g.line;
    const joins = sameLine && (JOINS_BACK.test(g.ch) || prev.ch === '\u200d' || (flagOpen && FLAG_HALF.test(g.ch)));
    if (joins && last) {
      last.push(g);
      flagOpen = false;
    } else {
      out.push([g]);
      flagOpen = FLAG_HALF.test(g.ch);
    }
  }
  return out;
}

/** one letter piece out of a cluster of glyphs */
function clusterPiece(cluster: readonly TextGlyph[], curved: boolean): SplitPiece {
  const first = cluster[0]!;
  if (cluster.length === 1) return { text: first.ch, cx: first.x, cy: first.y, rot: (first.rot * 180) / Math.PI };
  const text = cluster.map((g) => g.ch).join('');
  // on a curve the cluster sits where its base letter sits; on a line it spans all its glyphs
  if (curved) return { text, cx: first.x, cy: first.y, rot: (first.rot * 180) / Math.PI };
  const last = cluster[cluster.length - 1]!;
  return { text, cx: (first.x - first.w / 2 + last.x + last.w / 2) / 2, cy: first.y, rot: 0 };
}

/** one piece out of consecutive glyphs of one word / line */
function groupPiece(glyphs: readonly TextGlyph[], curved: boolean): SplitPiece | null {
  let a = 0;
  let b = glyphs.length - 1;
  while (a <= b && isSpace(glyphs[a]!)) a++;
  while (b >= a && isSpace(glyphs[b]!)) b--;
  if (a > b) return null;
  const used = glyphs.slice(a, b + 1);
  const text = used.map((g) => g.ch).join('');
  if (curved) {
    // a word on a curve stands straight, turned like the letter in its middle
    const n = used.length;
    const lo = used[Math.floor((n - 1) / 2)]!;
    const hi = used[Math.floor(n / 2)]!;
    return { text, cx: (lo.x + hi.x) / 2, cy: (lo.y + hi.y) / 2, rot: (((lo.rot + hi.rot) / 2) * 180) / Math.PI };
  }
  const first = used[0]!;
  const last = used[used.length - 1]!;
  return { text, cx: (first.x - first.w / 2 + last.x + last.w / 2) / 2, cy: first.y, rot: 0 };
}

/** the pieces a text splits into. spaces make no piece. */
export function splitPlan(box: Pick<TextBox, 'curve'>, glyphs: readonly TextGlyph[], mode: SplitMode): SplitPlan {
  const curved = box.curve !== 0;
  const pieces: SplitPiece[] = [];
  if (mode === 'letters') {
    for (const cluster of letterClusters(glyphs)) {
      if (isSpace(cluster[0]!)) continue;
      pieces.push(clusterPiece(cluster, curved));
    }
  } else {
    const groups = new Map<number, TextGlyph[]>();
    for (const g of glyphs) {
      if (isSpace(g)) continue;
      const key = mode === 'words' ? g.word : g.line;
      const list = groups.get(key);
      if (list) list.push(g);
      else groups.set(key, [g]);
    }
    for (const list of groups.values()) {
      // a line keeps the spaces between its words: take every glyph between the first and last letter
      const whole = mode === 'lines' ? glyphs.filter((g) => g.line === list[0]!.line) : list;
      const p = groupPiece(whole, curved);
      if (p) pieces.push(p);
    }
  }
  const count = pieces.length;
  return { count, pieces: count < 2 || count > MAX_PIECES ? [] : pieces };
}

/**
 * where every glyph sits, from the line edges (prefix widths per line). the same layout the text drawing uses
 * (engine/text.ts layoutGlyphs), for when the box has not been drawn yet and has no glyph cache.
 */
export function layoutGlyphsFrom(
  box: Pick<TextBox, 'lines' | 'width' | 'height' | 'pad' | 'lineHeight' | 'spacing' | 'curve' | 'curveRef' | 'curveCx' | 'curveCy'>,
  align: TextClip['align'],
  edgesOf: readonly number[][],
): TextGlyph[] {
  const glyphs: TextGlyph[] = [];
  const innerW = box.width - box.pad * 2;
  const top = -box.height / 2 + box.pad;
  const spacing = box.spacing;
  const curved = box.curve !== 0 ? curveLayout(edgesOf as number[][], spacing, box.lineHeight, box.curve, align, box.curveRef) : null;
  let cg = 0;
  let index = 0;
  let word = 0;
  for (let li = 0; li < box.lines.length; li++) {
    const chars = Array.from(box.lines[li]!);
    const edges = edgesOf[li]!;
    const lineW = (edges[chars.length] ?? 0) + spacing * Math.max(0, chars.length - 1);
    const left = align === 'left' ? -innerW / 2 : align === 'right' ? innerW / 2 - lineW : -lineW / 2;
    const y = top + box.lineHeight * (li + 0.5);
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
        glyphs.push({ ch, x: p.x - box.curveCx, w, y: p.y - box.curveCy, rot: p.rot, index, word, line: li });
      } else {
        glyphs.push({ ch, x: left + edges[i]! + spacing * i + w / 2, w, y, rot: 0, index, word, line: li });
      }
      index++;
    }
    if (inWord) word++;
  }
  return glyphs;
}

/* ---------- where a piece goes ---------- */

export interface PieceBase {
  transform: Transform;
  threeD?: boolean;
  keyframes?: Keyframes;
  /** timeline start of the clip (keyframe times are relative to it) */
  start: number;
}

export interface PieceTransform {
  transform: Transform;
  keyframes?: Keyframes;
}

const RAD = Math.PI / 180;

/** a number that may be animated, read at a timeline time */
function at(base: PieceBase, prop: string, fallback: number, time: number): number {
  const keys = base.keyframes?.[prop];
  if (keys && keys.length > 0) return evalKeys(keys, time - base.start);
  return ((base.transform as unknown as Record<string, number | undefined>)[prop] ?? fallback) as number;
}

/**
 * the piece's offset in the world: (cx, cy) scaled by the clip's scale and stretch, turned by its spin, and for a 3d clip
 * tilted and turned the way the 3d renderer does (scene3d/model.ts: turn * tilt * spin, tilt = -rotX, turn = -rotY).
 */
export function pieceOffset(base: PieceBase, piece: Pick<SplitPiece, 'cx' | 'cy'>, time: number): { dx: number; dy: number; dz: number } {
  const s = at(base, 'scale', 1, time);
  const spin = at(base, 'rotation', 0, time) * RAD;
  // the stretch of a side is the clip's own and the pieces keep it: the letters sit where the stretched text shows them
  const px = piece.cx * s * at(base, 'scaleX', 1, time);
  const py = piece.cy * s * at(base, 'scaleY', 1, time);
  const cs = Math.cos(spin);
  const sn = Math.sin(spin);
  let x = cs * px - sn * py;
  let y = sn * px + cs * py;
  let z = 0;
  if (base.threeD) {
    const a = -at(base, 'rotX', 0, time) * RAD;
    const y2 = Math.cos(a) * y;
    const z2 = Math.sin(a) * y;
    y = y2;
    z = z2;
    const b = -at(base, 'rotY', 0, time) * RAD;
    const x3 = Math.cos(b) * x + Math.sin(b) * z;
    const z3 = -Math.sin(b) * x + Math.cos(b) * z;
    x = x3;
    z = z3;
  }
  return { dx: x, dy: y, dz: z };
}

function shifted(keys: Keyframes, prop: string, d: number): Keyframes {
  const list = keys[prop];
  if (!list || list.length === 0 || d === 0) return keys;
  return { ...keys, [prop]: list.map((k) => ({ ...k, v: k.v + d })) };
}

/**
 * the transform (and keyframes) of a piece so it sits where it was. scale, opacity, tilt and turn stay the clip's;
 * a curved letter adds its own rotation. a keyframed x / y / z (and rotation) gets the offset added to every key.
 * the offset itself is worked out with the scale / spin / tilt / turn the clip has at `time` (the playhead): when
 * those are animated too, the pieces are exact at that moment and drift from the original elsewhere.
 */
export function pieceTransform(base: PieceBase, piece: Pick<SplitPiece, 'cx' | 'cy' | 'rot'>, time: number): PieceTransform {
  const { dx, dy, dz } = pieceOffset(base, piece, time);
  const t = base.transform;
  const kf = base.keyframes;
  const transform: Transform = { ...t };
  let keys: Keyframes | undefined = kf;
  const apply = (prop: 'x' | 'y' | 'z' | 'rotation', d: number) => {
    if (d === 0) return;
    if (keys?.[prop] && keys[prop]!.length > 0) keys = shifted(keys, prop, d);
    else transform[prop] = (t[prop] ?? 0) + d;
  };
  apply('x', dx);
  apply('y', dy);
  if (base.threeD) apply('z', dz);
  apply('rotation', piece.rot);
  return keys !== undefined && keys !== kf ? { transform, keyframes: keys } : { transform, ...(kf ? { keyframes: kf } : {}) };
}

/** the piece closest to the middle of the old box: it takes over what hung on the text (children, look targets, cameras) */
export function middlePiece(pieces: readonly Pick<SplitPiece, 'cx' | 'cy'>[]): number {
  let best = 0;
  let dist = Infinity;
  pieces.forEach((pc, i) => {
    const d = pc.cx * pc.cx + pc.cy * pc.cy;
    if (d < dist - 1e-9) {
      dist = d;
      best = i;
    }
  });
  return best;
}

/* ---------- the piece clip ---------- */

/** why a text cannot be split at all, or null */
export function splitBlocker(
  clip: Pick<TextClip, 'counter' | 'highlight' | 'threeD' | 'lookAt' | 'mask' | 'crop' | 'animIn' | 'animOut' | 'animLoop'>,
): string | null {
  if (clip.counter) return 'a running number cannot be split';
  if (clip.highlight) return 'karaoke text cannot be split, turn it off first';
  // every piece would turn on its own spot and the word falls apart
  if (clip.threeD && clip.lookAt && clip.lookAt !== 'none') return 'this text looks at something: turn off look at first';
  // a mask / crop is measured on the whole box, on every piece it would cut something else
  if (clip.mask) return 'this text has a mask: remove it first';
  if (clip.crop && (clip.crop.left > 0 || clip.crop.right > 0 || clip.crop.top > 0 || clip.crop.bottom > 0)) return 'this text is cropped: reset the crop first';
  // an animation that runs letter by letter would start on every piece at once
  const units = textAnimUnits(clip as TextClip);
  if ([units.enter, units.exit, units.loop].some((u) => u && u.unit !== 'block')) return 'the text animation runs letter by letter and would not survive: remove it first';
  return null;
}

const RTL = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]/;

/** why this one mode cannot run on the text, or null. right to left text is laid out by the browser per line. */
export function modeBlocker(clip: Pick<TextClip, 'text'>, mode: SplitMode): string | null {
  if (mode !== 'lines' && RTL.test(clip.text)) return 'right to left text can only be split into lines';
  return null;
}

/** what a split cannot carry over exactly, as words for the toast. empty when the pieces are a true copy. */
export function splitNotes(clip: TextClip, mode?: SplitMode): string[] {
  const notes: string[] = [];
  // one box around the whole text becomes a box per piece (a box per line split into lines looks the same)
  if (clip.background && mode && keepsBackground(mode) && !(mode === 'lines' && clip.backgroundPerLine)) notes.push('the background is now a box per piece');
  const keyed = (prop: string) => (clip.keyframes?.[prop]?.length ?? 0) > 0;
  const moving = ['scale', 'scaleX', 'scaleY', 'rotation', ...(clip.threeD ? ['rotX', 'rotY'] : [])].filter(keyed);
  if (moving.length > 0) notes.push('the size / turn is animated: the pieces match at the playhead only');
  // a letter on a curve that is stretched more one way than the other is slanted: a piece can be turned and stretched, not slanted
  if (clip.curve && Math.abs(stretchX(clip.transform) - stretchY(clip.transform)) > 1e-3) notes.push('curved and stretched: the letters lose their slant');
  const looks: string[] = [];
  if (clip.gradient) looks.push('gradient');
  if (clip.motionIn || clip.motionOut || clip.motionLoop) looks.push('motion');
  if ((clip.radius ?? 0) > 0) looks.push('corners');
  if (looks.length > 0) notes.push(`${looks.join(' / ')} now run${looks.length === 1 ? 's' : ''} on every piece`);
  return notes;
}

/** letters get no background (a box per letter is noise); words and lines keep theirs */
export function keepsBackground(mode: SplitMode): boolean {
  return mode !== 'letters';
}

/** a copy of the text clip for one piece. the id is a placeholder, the store gives the real one. */
export function pieceClip(clip: TextClip, piece: SplitPiece, mode: SplitMode, time: number): TextClip {
  const { wrapWidth: _w, curve: _c, group: _g, ...rest } = clip;
  void _w;
  void _c;
  void _g;
  const { transform, keyframes } = pieceTransform(clip, piece, time);
  const out: TextClip = { ...rest, text: piece.text, align: 'center', transform, name: piece.text.slice(0, 24) };
  if (keyframes) out.keyframes = keyframes;
  if (!keepsBackground(mode)) out.background = null;
  return out;
}
