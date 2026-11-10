/**
 * align and distribute: pure math on boxes in canvas pixels. a box is the clip's rectangle after scale
 * (rotation is ignored: the unrotated box is used). x / y of a transform are offsets from the canvas
 * center, so moving a box by (dx, dy) adds dx / dy to them.
 */

export interface AlignBox {
  id: string;
  /** center of the box on the canvas, canvas pixels */
  cx: number;
  cy: number;
  width: number;
  height: number;
}

export type AlignKind = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom';
export type SpreadAxis = 'x' | 'y';

export interface AlignBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface AlignMove {
  id: string;
  dx: number;
  dy: number;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** the canvas as the thing to align to */
export function canvasBounds(width: number, height: number): AlignBounds {
  return { left: 0, top: 0, right: width, bottom: height };
}

/** the smallest rectangle around all boxes (null for no boxes) */
export function boxesBounds(boxes: readonly AlignBox[]): AlignBounds | null {
  if (boxes.length === 0) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const b of boxes) {
    left = Math.min(left, b.cx - b.width / 2);
    right = Math.max(right, b.cx + b.width / 2);
    top = Math.min(top, b.cy - b.height / 2);
    bottom = Math.max(bottom, b.cy + b.height / 2);
  }
  return { left, top, right, bottom };
}

/** how far each box moves so it sits on the given edge / middle of the bounds. boxes that already sit there are left out. */
export function alignMoves(boxes: readonly AlignBox[], kind: AlignKind, bounds: AlignBounds): AlignMove[] {
  const out: AlignMove[] = [];
  for (const b of boxes) {
    let dx = 0;
    let dy = 0;
    if (kind === 'left') dx = bounds.left - (b.cx - b.width / 2);
    else if (kind === 'right') dx = bounds.right - (b.cx + b.width / 2);
    else if (kind === 'center') dx = (bounds.left + bounds.right) / 2 - b.cx;
    else if (kind === 'top') dy = bounds.top - (b.cy - b.height / 2);
    else if (kind === 'bottom') dy = bounds.bottom - (b.cy + b.height / 2);
    else dy = (bounds.top + bounds.bottom) / 2 - b.cy;
    dx = round2(dx);
    dy = round2(dy);
    if (dx !== 0 || dy !== 0) out.push({ id: b.id, dx, dy });
  }
  return out;
}

/**
 * equal gaps between the boxes along one axis. the first and the last (by center) stay where they are,
 * the ones between are moved. needs 3 boxes, otherwise nothing moves.
 */
export function spreadMoves(boxes: readonly AlignBox[], axis: SpreadAxis): AlignMove[] {
  if (boxes.length < 3) return [];
  const horizontal = axis === 'x';
  const center = (b: AlignBox) => (horizontal ? b.cx : b.cy);
  const size = (b: AlignBox) => (horizontal ? b.width : b.height);
  const sorted = [...boxes].sort((a, b) => center(a) - center(b));
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  const start = center(first) - size(first) / 2;
  const end = center(last) + size(last) / 2;
  const total = sorted.reduce((sum, b) => sum + size(b), 0);
  const gap = (end - start - total) / (sorted.length - 1);
  const out: AlignMove[] = [];
  let edge = start;
  for (const b of sorted) {
    const delta = round2(edge + size(b) / 2 - center(b));
    if (delta !== 0) out.push(horizontal ? { id: b.id, dx: delta, dy: 0 } : { id: b.id, dx: 0, dy: delta });
    edge += size(b) + gap;
  }
  return out;
}

/** clips that can be aligned by their own x / y: not 3d (perspective) and not attached (their x / y is local to the parent) */
export function isAlignable(clip: { threeD?: boolean; parent?: string | null }): boolean {
  return !clip.threeD && !clip.parent;
}
