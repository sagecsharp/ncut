import { describe, expect, it } from 'vitest';
import { alignMoves, boxesBounds, canvasBounds, isAlignable, spreadMoves } from './alignLogic';
import type { AlignBox } from './alignLogic';

const box = (id: string, cx: number, cy: number, width: number, height: number): AlignBox => ({ id, cx, cy, width, height });
const canvas = canvasBounds(1000, 500);

describe('align to the canvas', () => {
  const b = box('a', 300, 100, 200, 100); // left 200, right 400, top 50, bottom 150
  it('left / right / center', () => {
    expect(alignMoves([b], 'left', canvas)).toEqual([{ id: 'a', dx: -200, dy: 0 }]);
    expect(alignMoves([b], 'right', canvas)).toEqual([{ id: 'a', dx: 600, dy: 0 }]);
    expect(alignMoves([b], 'center', canvas)).toEqual([{ id: 'a', dx: 200, dy: 0 }]);
  });
  it('top / bottom / middle', () => {
    expect(alignMoves([b], 'top', canvas)).toEqual([{ id: 'a', dx: 0, dy: -50 }]);
    expect(alignMoves([b], 'bottom', canvas)).toEqual([{ id: 'a', dx: 0, dy: 350 }]);
    expect(alignMoves([b], 'middle', canvas)).toEqual([{ id: 'a', dx: 0, dy: 150 }]);
  });
  it('leaves a box that already sits there out', () => {
    expect(alignMoves([box('a', 500, 250, 40, 40)], 'center', canvas)).toEqual([]);
    expect(alignMoves([box('a', 20, 250, 40, 40)], 'left', canvas)).toEqual([]);
  });
  it('a box bigger than the canvas still lines up its edge', () => {
    expect(alignMoves([box('a', 500, 250, 1400, 500)], 'left', canvas)).toEqual([{ id: 'a', dx: 200, dy: 0 }]);
  });
});

describe('align to the selection', () => {
  const boxes = [box('a', 100, 100, 100, 100), box('b', 400, 300, 200, 50), box('c', 250, 200, 20, 20)];
  it('bounds of the boxes', () => {
    expect(boxesBounds(boxes)).toEqual({ left: 50, top: 50, right: 500, bottom: 325 });
    expect(boxesBounds([])).toBeNull();
  });
  it('left edge of the selection', () => {
    const moves = alignMoves(boxes, 'left', boxesBounds(boxes)!);
    expect(moves).toEqual([
      { id: 'b', dx: -250, dy: 0 },
      { id: 'c', dx: -190, dy: 0 },
    ]);
  });
  it('middle of the selection', () => {
    const moves = alignMoves(boxes, 'middle', boxesBounds(boxes)!);
    expect(moves.find((m) => m.id === 'a')).toEqual({ id: 'a', dx: 0, dy: 87.5 });
  });
});

describe('spread out evenly', () => {
  it('needs 3 boxes', () => {
    expect(spreadMoves([box('a', 0, 0, 10, 10), box('b', 50, 0, 10, 10)], 'x')).toEqual([]);
  });
  it('equal gaps, outer two stay', () => {
    const boxes = [box('a', 50, 0, 100, 10), box('b', 120, 0, 40, 10), box('c', 450, 0, 100, 10)];
    // span 0..500, widths 240, gap 130: a 0..100, b 230..270, c 400..500
    expect(spreadMoves(boxes, 'x')).toEqual([{ id: 'b', dx: 130, dy: 0 }]);
  });
  it('sorts by position, not by order', () => {
    const boxes = [box('c', 450, 0, 100, 10), box('a', 50, 0, 100, 10), box('b', 120, 0, 40, 10)];
    expect(spreadMoves(boxes, 'x')).toEqual([{ id: 'b', dx: 130, dy: 0 }]);
  });
  it('works vertically', () => {
    const boxes = [box('a', 0, 10, 10, 20), box('b', 0, 30, 10, 20), box('c', 0, 100, 10, 20)];
    // span 0..110, heights 60, gap 25: b top 45 -> cy 55
    expect(spreadMoves(boxes, 'y')).toEqual([{ id: 'b', dx: 0, dy: 25 }]);
  });
  it('nothing to do when the gaps are equal already', () => {
    const boxes = [box('a', 50, 0, 100, 10), box('b', 250, 0, 100, 10), box('c', 450, 0, 100, 10)];
    expect(spreadMoves(boxes, 'x')).toEqual([]);
  });
});

describe('who can be aligned', () => {
  it('not 3d and not attached', () => {
    expect(isAlignable({})).toBe(true);
    expect(isAlignable({ parent: null, threeD: false })).toBe(true);
    expect(isAlignable({ threeD: true })).toBe(false);
    expect(isAlignable({ parent: 'x' })).toBe(false);
  });
});
