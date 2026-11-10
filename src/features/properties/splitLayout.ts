import type { Crop } from '../../types';

/**
 * split screen: pure math. the canvas is cut into cells and every clip is put into one: pictures fill
 * their cell (the overflow is cropped off evenly), text and shapes are fitted inside it.
 * cells are in canvas pixels with the origin at the top left, like the align boxes.
 */

export type SplitKind = 'columns' | 'rows' | 'grid' | 'bigLeft' | 'bigTop' | 'pip';

export const SPLIT_KINDS: SplitKind[] = ['columns', 'rows', 'grid', 'bigLeft', 'bigTop', 'pip'];

export interface SplitCell {
  /** center of the cell on the canvas */
  cx: number;
  cy: number;
  width: number;
  height: number;
}

/** a clip to place: its size on the canvas at scale 1, uncropped */
export interface SplitSource {
  id: string;
  width: number;
  height: number;
  /** video / image: fills the cell and is cropped. false (text, shape): fitted inside the cell */
  media: boolean;
}

export interface SplitPlacement {
  id: string;
  /** transform x / y (offsets from the canvas center) */
  x: number;
  y: number;
  scale: number;
  /** null = no crop (also for text and shapes, which have none) */
  crop: Crop | null;
}

/** most clips one layout takes. the rest stay where they are. */
export const MAX_SPLIT = 16;

/** share of the canvas the big cell of bigLeft / bigTop takes along the split axis */
const BIG_SHARE = 2 / 3;
/** width of a picture in picture window as a share of the canvas width */
const PIP_SHARE = 0.28;
/** text and shapes keep this share of their cell (a little air around them) */
const INSIDE = 0.92;

const cell = (left: number, top: number, width: number, height: number): SplitCell => ({
  cx: left + width / 2,
  cy: top + height / 2,
  width: Math.max(1, width),
  height: Math.max(1, height),
});

/** n equal pieces of `total` with `gap` between them: [start, size] of each */
function slices(total: number, n: number, gap: number): [number, number][] {
  const size = (total - gap * (n - 1)) / n;
  return Array.from({ length: n }, (_, i) => [i * (size + gap), size] as [number, number]);
}

/**
 * the cells of a layout for n clips, in the order the clips are given.
 * columns / rows: n equal strips. grid: as square as possible, a short last row is stretched to the full width.
 * bigLeft / bigTop: the first clip gets two thirds, the others share the rest. pip: the first clip gets the
 * whole canvas, the others are small windows along the bottom, from the right (a second row above when full).
 */
export function splitCells(kind: SplitKind, count: number, canvasW: number, canvasH: number, gap = 0): SplitCell[] {
  const n = Math.min(MAX_SPLIT, Math.floor(count));
  if (!(n >= 1) || !(canvasW > 0) || !(canvasH > 0)) return [];
  const g = Math.max(0, Math.min(gap, Math.min(canvasW, canvasH) / (n + 1)));
  if (n === 1) return [cell(0, 0, canvasW, canvasH)];

  if (kind === 'columns') return slices(canvasW, n, g).map(([x, w]) => cell(x, 0, w, canvasH));
  if (kind === 'rows') return slices(canvasH, n, g).map(([y, h]) => cell(0, y, canvasW, h));

  if (kind === 'grid') {
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    const out: SplitCell[] = [];
    slices(canvasH, rows, g).forEach(([y, h], r) => {
      const inRow = r === rows - 1 ? n - cols * (rows - 1) : cols;
      for (const [x, w] of slices(canvasW, inRow, g)) out.push(cell(x, y, w, h));
    });
    return out;
  }

  if (kind === 'bigLeft') {
    const bigW = (canvasW - g) * BIG_SHARE;
    const restX = bigW + g;
    return [cell(0, 0, bigW, canvasH), ...slices(canvasH, n - 1, g).map(([y, h]) => cell(restX, y, canvasW - restX, h))];
  }

  if (kind === 'bigTop') {
    const bigH = (canvasH - g) * BIG_SHARE;
    const restY = bigH + g;
    return [cell(0, 0, canvasW, bigH), ...slices(canvasW, n - 1, g).map(([x, w]) => cell(x, restY, w, canvasH - restY))];
  }

  // pip: windows with the shape of the canvas, a margin around them (at least 2% of the short side)
  const margin = Math.max(g, Math.min(canvasW, canvasH) * 0.02);
  const w = canvasW * PIP_SHARE;
  const h = canvasH * PIP_SHARE;
  const perRow = Math.max(1, Math.floor((canvasW - margin) / (w + margin)));
  const out: SplitCell[] = [cell(0, 0, canvasW, canvasH)];
  for (let i = 0; i < n - 1; i++) {
    const col = i % perRow;
    const row = Math.floor(i / perRow);
    out.push(cell(canvasW - margin - w - col * (w + margin), canvasH - margin - h - row * (h + margin), w, h));
  }
  return out;
}

const round = (v: number, digits: number) => {
  const m = 10 ** digits;
  return Math.round(v * m) / m;
};

/** where a clip goes so it sits in a cell: pictures cover it and lose the overflow, the rest fit inside */
export function placeInCell(src: SplitSource, c: SplitCell, canvasW: number, canvasH: number): SplitPlacement {
  const x = round(c.cx - canvasW / 2, 2);
  const y = round(c.cy - canvasH / 2, 2);
  if (!(src.width > 0) || !(src.height > 0)) return { id: src.id, x, y, scale: 1, crop: null };
  if (!src.media) {
    const scale = Math.min(c.width / src.width, c.height / src.height) * INSIDE;
    return { id: src.id, x, y, scale: round(scale, 4), crop: null };
  }
  const scale = Math.max(c.width / src.width, c.height / src.height);
  // what sticks out of the cell, as a share of the picture's own size, cut evenly from both sides
  const overX = Math.max(0, 1 - c.width / (src.width * scale));
  const overY = Math.max(0, 1 - c.height / (src.height * scale));
  const crop: Crop | null =
    overX > 1e-4 || overY > 1e-4
      ? { left: round(overX / 2, 4), right: round(overX / 2, 4), top: round(overY / 2, 4), bottom: round(overY / 2, 4) }
      : null;
  return { id: src.id, x, y, scale: round(scale, 4), crop };
}

/** every clip in its cell. clips beyond the cells of the layout are left out. */
export function planSplit(kind: SplitKind, sources: readonly SplitSource[], canvasW: number, canvasH: number, gap = 0): SplitPlacement[] {
  const cells = splitCells(kind, sources.length, canvasW, canvasH, gap);
  return cells.map((c, i) => placeInCell(sources[i]!, c, canvasW, canvasH));
}
