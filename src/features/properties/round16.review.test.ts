import { describe, expect, it } from 'vitest';
import { evalKeys } from '../../lib/anim';
import { createTextClip } from '../../lib/factory';
import type { Easing, Keyframe } from '../../types';
import { placeKeys } from './keyClipboard';
import { reverseKeys } from './keyTools';
import { verticalExtent } from './place3d';
import { middlePiece, splitNotes } from './textSplit';

const k = (t: number, v: number, ease: Easing = 'linear'): Keyframe => ({ t, v, ease });

describe('paste near the end of a clip', () => {
  const clip = createTextClip('t', 0, { text: 'a', duration: 2 });

  it('keys past the end are cut, but the curve inside the clip stays the copied one', () => {
    const out = placeKeys({ x: [k(0, 0), k(1, 400)] }, clip, 1.5);
    expect(out.x!.map((q) => q.t)).toEqual([1.5, 2]);
    // half way through the copied ramp at the end of the clip
    expect(out.x![1]!.v).toBeCloseTo(200, 6);
    expect(evalKeys(out.x!, 1.75)).toBeCloseTo(100, 6);
  });

  it('keys that fit are pasted as they are', () => {
    const out = placeKeys({ x: [k(0, 0), k(1, 400)] }, clip, 0.5);
    expect(out.x).toEqual([k(0.5, 0), k(1.5, 400)]);
  });

  it('at the very end only the first key is left, no key is doubled', () => {
    const out = placeKeys({ x: [k(0, 7), k(1, 400)] }, clip, 2);
    expect(out.x).toEqual([k(2, 7)]);
  });
});

describe('reverse, decided per property', () => {
  it('a stray key outside the clip does not move an animation that lies inside it', () => {
    const kf = { x: [k(0, 0), k(2, 100)], opacity: [k(12, 1)] };
    const out = reverseKeys(kf, 10);
    expect(out.x!.map((q) => [q.t, q.v])).toEqual([
      [0, 100],
      [2, 0],
    ]);
    // the stray property mirrors about the clip
    expect(out.opacity![0]!.t).toBeCloseTo(-2, 6);
  });

  it('properties inside the clip still mirror together, in the span they share', () => {
    const kf = { x: [k(0, 0), k(1, 10)], y: [k(1, 0), k(3, 10)] };
    const out = reverseKeys(kf, 10);
    expect(out.x!.map((q) => q.t)).toEqual([2, 3]);
    expect(out.y!.map((q) => q.t)).toEqual([0, 2]);
  });

  it('every property outside: the clip is the mirror', () => {
    const kf = { x: [k(-2, 0), k(0, 20), k(2, 40)] };
    const out = reverseKeys(kf, 2);
    for (const t of [0, 1, 2]) expect(evalKeys(out.x!, t)).toBeCloseTo(evalKeys(kf.x, 2 - t), 6);
  });
});

describe('drop to floor, a ball', () => {
  const s = Math.SQRT1_2;
  it('a ball turned 45 degrees reaches as far as an upright one', () => {
    const upright = verticalExtent(100, 100, [1, 0, 0], [0, 1, 0], 100, [0, 0, 1], true);
    const turned = verticalExtent(100, 100, [s, s, 0], [-s, s, 0], 100, [0, 0, 1], true);
    expect(upright).toBeCloseTo(100, 6);
    expect(turned).toBeCloseTo(100, 6);
  });
  it('a box turned 45 degrees stands on its corner', () => {
    expect(verticalExtent(100, 100, [s, s, 0], [-s, s, 0], 100, [0, 0, 1])).toBeCloseTo(141.42, 1);
  });
});

describe('split text, who takes over and what the toast says', () => {
  it('the piece nearest the middle of the old box', () => {
    expect(middlePiece([{ cx: -200, cy: 0 }, { cx: -10, cy: 0 }, { cx: 190, cy: 0 }])).toBe(1);
    // a tie keeps the earlier piece
    expect(middlePiece([{ cx: -50, cy: 0 }, { cx: 50, cy: 0 }])).toBe(0);
    expect(middlePiece([{ cx: 0, cy: -40 }, { cx: 0, cy: 10 }])).toBe(1);
  });

  it('one box becomes many: said for words and lines, not for letters or a box per line split into lines', () => {
    const boxed = createTextClip('t', 0, { text: 'a b\nc', background: '#000000' });
    expect(splitNotes(boxed, 'words')).toContain('the background is now a box per piece');
    expect(splitNotes(boxed, 'lines')).toContain('the background is now a box per piece');
    expect(splitNotes(boxed, 'letters')).toEqual([]);
    expect(splitNotes({ ...boxed, backgroundPerLine: true }, 'lines')).toEqual([]);
    expect(splitNotes({ ...boxed, backgroundPerLine: true }, 'words')).toContain('the background is now a box per piece');
    expect(splitNotes(createTextClip('t', 0, { text: 'a b' }), 'words')).toEqual([]);
  });
});
