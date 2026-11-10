import { describe, expect, it } from 'vitest';
import { MAX_SPLIT, SPLIT_KINDS, placeInCell, planSplit, splitCells } from './splitLayout';
import type { SplitCell, SplitSource } from './splitLayout';

const W = 1920;
const H = 1080;

const left = (c: SplitCell) => c.cx - c.width / 2;
const right = (c: SplitCell) => c.cx + c.width / 2;
const top = (c: SplitCell) => c.cy - c.height / 2;
const bottom = (c: SplitCell) => c.cy + c.height / 2;
const area = (c: SplitCell) => c.width * c.height;

function overlap(a: SplitCell, b: SplitCell): number {
  const w = Math.min(right(a), right(b)) - Math.max(left(a), left(b));
  const h = Math.min(bottom(a), bottom(b)) - Math.max(top(a), top(b));
  return w > 1e-6 && h > 1e-6 ? w * h : 0;
}

describe('splitCells', () => {
  it('gives nothing for no clips or an empty canvas', () => {
    expect(splitCells('grid', 0, W, H)).toEqual([]);
    expect(splitCells('grid', 3, 0, H)).toEqual([]);
    expect(splitCells('grid', NaN, W, H)).toEqual([]);
  });

  it('one clip gets the whole canvas in every layout', () => {
    for (const k of SPLIT_KINDS) expect(splitCells(k, 1, W, H, 20)).toEqual([{ cx: W / 2, cy: H / 2, width: W, height: H }]);
  });

  it('every tiling layout covers the canvas exactly without a gap, and cells never overlap', () => {
    for (const k of ['columns', 'rows', 'grid', 'bigLeft', 'bigTop'] as const) {
      for (let n = 2; n <= 9; n++) {
        const cells = splitCells(k, n, W, H);
        expect(cells, `${k} ${n}`).toHaveLength(n);
        expect(cells.reduce((s, c) => s + area(c), 0), `${k} ${n} area`).toBeCloseTo(W * H, 3);
        for (let i = 0; i < n; i++) {
          expect(left(cells[i]!)).toBeGreaterThanOrEqual(-1e-6);
          expect(top(cells[i]!)).toBeGreaterThanOrEqual(-1e-6);
          expect(right(cells[i]!)).toBeLessThanOrEqual(W + 1e-6);
          expect(bottom(cells[i]!)).toBeLessThanOrEqual(H + 1e-6);
          for (let j = i + 1; j < n; j++) expect(overlap(cells[i]!, cells[j]!), `${k} ${n}: ${i} / ${j}`).toBe(0);
        }
      }
    }
  });

  it('columns go left to right and rows top to bottom', () => {
    const cols = splitCells('columns', 3, W, H);
    expect(cols.map((c) => c.cx)).toEqual([320, 960, 1600]);
    expect(cols.every((c) => c.height === H)).toBe(true);
    const rows = splitCells('rows', 2, W, H);
    expect(rows.map((c) => c.cy)).toEqual([270, 810]);
  });

  it('keeps the gap between neighbours, not at the canvas edge', () => {
    const cols = splitCells('columns', 2, W, H, 20);
    expect(left(cols[0]!)).toBe(0);
    expect(right(cols[1]!)).toBeCloseTo(W, 6);
    expect(left(cols[1]!) - right(cols[0]!)).toBeCloseTo(20, 6);
  });

  it('a gap too big for the canvas is cut down, cells stay at least one pixel', () => {
    const cells = splitCells('columns', 4, 100, 100, 5000);
    expect(cells).toHaveLength(4);
    for (const c of cells) expect(c.width).toBeGreaterThanOrEqual(1);
  });

  it('grid: 3 clips are 2 on top and one wide below, 4 are 2 x 2, 5 are 3 + 2', () => {
    const three = splitCells('grid', 3, W, H);
    expect(three.map((c) => c.width)).toEqual([960, 960, 1920]);
    const four = splitCells('grid', 4, W, H);
    expect(four.every((c) => c.width === 960 && c.height === 540)).toBe(true);
    const five = splitCells('grid', 5, W, H);
    expect(five.map((c) => c.width)).toEqual([640, 640, 640, 960, 960]);
  });

  it('bigLeft gives the first clip two thirds of the width and stacks the rest', () => {
    const cells = splitCells('bigLeft', 3, W, H);
    expect(cells[0]!.width).toBeCloseTo(1280, 6);
    expect(cells[0]!.height).toBe(H);
    expect(cells[1]!.width).toBeCloseTo(640, 6);
    expect(cells[1]!.height).toBe(540);
    expect(cells[2]!.cy).toBe(810);
  });

  it('bigTop gives the first clip two thirds of the height', () => {
    const cells = splitCells('bigTop', 3, W, H);
    expect(cells[0]!.height).toBeCloseTo(720, 6);
    expect(cells[1]!.height).toBeCloseTo(360, 6);
    expect(cells[1]!.width).toBe(960);
  });

  it('pip: the first is the whole canvas, the others small windows inside it, bottom right first', () => {
    const cells = splitCells('pip', 3, W, H);
    expect(cells[0]).toEqual({ cx: W / 2, cy: H / 2, width: W, height: H });
    for (const c of cells.slice(1)) {
      expect(c.width / c.height).toBeCloseTo(W / H, 6);
      expect(right(c)).toBeLessThan(W);
      expect(bottom(c)).toBeLessThan(H);
      expect(left(c)).toBeGreaterThan(0);
    }
    expect(cells[1]!.cx).toBeGreaterThan(cells[2]!.cx);
    expect(overlap(cells[1]!, cells[2]!)).toBe(0);
  });

  it('pip starts a second row above when the bottom is full, on wide and on tall canvases', () => {
    for (const [w, h] of [[1920, 1080], [1080, 1920]] as const) {
      const cells = splitCells('pip', 8, w, h).slice(1);
      for (let i = 0; i < cells.length; i++) {
        expect(left(cells[i]!)).toBeGreaterThanOrEqual(0);
        expect(top(cells[i]!)).toBeGreaterThanOrEqual(0);
        for (let j = i + 1; j < cells.length; j++) expect(overlap(cells[i]!, cells[j]!)).toBe(0);
      }
    }
  });

  it('pip never puts a window outside the canvas: clips beyond the rows that fit get no cell', () => {
    for (const [w, h] of [[1920, 1080], [1080, 1920], [1000, 1000]] as const) {
      const cells = splitCells('pip', 16, w, h);
      expect(cells.length).toBeLessThanOrEqual(16);
      expect(cells.length).toBeGreaterThan(4);
      for (const c of cells) {
        expect(top(c)).toBeGreaterThanOrEqual(0);
        expect(left(c)).toBeGreaterThanOrEqual(0);
      }
    }
    expect(splitCells('pip', 16, 1920, 1080)).toHaveLength(10);
  });

  it('never makes more cells than the limit', () => {
    expect(splitCells('grid', 500, W, H)).toHaveLength(MAX_SPLIT);
  });
});

describe('placeInCell', () => {
  const half: SplitCell = { cx: 480, cy: 540, width: 960, height: 1080 };
  const media = (width: number, height: number): SplitSource => ({ id: 'a', width, height, media: true });

  it('a 16:9 picture in the left half: fills the height, loses a quarter on each side', () => {
    const p = placeInCell(media(1920, 1080), half, W, H);
    expect(p).toEqual({ id: 'a', x: -480, y: 0, scale: 1, crop: { left: 0.25, right: 0.25, top: 0, bottom: 0 } });
  });

  it('what is left after the crop is exactly the cell', () => {
    for (const [w, h] of [[1920, 1080], [608, 1080], [1920, 800], [1000, 1000]] as const) {
      for (const c of splitCells('grid', 5, W, H, 12)) {
        const p = placeInCell(media(w, h), c, W, H);
        const cr = p.crop ?? { left: 0, right: 0, top: 0, bottom: 0 };
        expect(w * p.scale * (1 - cr.left - cr.right)).toBeCloseTo(c.width, 0);
        expect(h * p.scale * (1 - cr.top - cr.bottom)).toBeCloseTo(c.height, 0);
        expect(cr.left).toBe(cr.right);
        expect(cr.top).toBe(cr.bottom);
      }
    }
  });

  it('a picture with the shape of its cell is not cropped', () => {
    const p = placeInCell(media(1920, 1080), { cx: 960, cy: 540, width: 960, height: 540 }, W, H);
    expect(p.crop).toBeNull();
    expect(p.scale).toBe(0.5);
  });

  it('text and shapes are fitted inside with a little air and never cropped', () => {
    const p = placeInCell({ id: 't', width: 800, height: 100, media: false }, half, W, H);
    expect(p.crop).toBeNull();
    expect(800 * p.scale).toBeCloseTo(960 * 0.92, 1);
    expect(p.x).toBe(-480);
  });

  it('a clip without a size is only moved', () => {
    expect(placeInCell(media(0, 0), half, W, H)).toEqual({ id: 'a', x: -480, y: 0, scale: 1, crop: null });
  });
});

describe('planSplit', () => {
  it('places the clips in the order given and leaves out the ones beyond the limit', () => {
    const src = Array.from({ length: 20 }, (_, i): SplitSource => ({ id: `c${i}`, width: 1920, height: 1080, media: true }));
    const plan = planSplit('columns', src.slice(0, 2), W, H);
    expect(plan.map((p) => [p.id, p.x])).toEqual([['c0', -480], ['c1', 480]]);
    expect(planSplit('grid', src, W, H)).toHaveLength(MAX_SPLIT);
  });
});
