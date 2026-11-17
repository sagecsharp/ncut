import { describe, expect, it } from 'vitest';
import { FLIP_DELAY_MS, RESTORE_MS, SKIM_COUNT, SKIM_H, SKIM_REST_MS, coverRect, marksBar, marksTitle, restoreModeFor, skimIndex, skimTime } from './cardMath';
import type { CardPress } from './cardMath';

describe('cardMath', () => {
  it('has the house constants', () => {
    expect([FLIP_DELAY_MS, RESTORE_MS, SKIM_REST_MS, SKIM_COUNT, SKIM_H]).toEqual([250, 600, 150, 24, 48]);
  });

  it('restore only for the same flipped card', () => {
    const p: CardPress = { id: 'a', at: 1000, prevMode: 'scene', flipped: true };
    expect(restoreModeFor(p, 'a', 1500)).toBe('scene');
    expect(restoreModeFor(p, 'a', 1000 + RESTORE_MS)).toBe('scene');
    expect(restoreModeFor(p, 'a', 1000 + RESTORE_MS + 1)).toBeNull();
    expect(restoreModeFor(p, 'b', 1100)).toBeNull();
    expect(restoreModeFor({ ...p, flipped: false }, 'a', 1100)).toBeNull();
    expect(restoreModeFor(null, 'a', 1100)).toBeNull();
  });

  it('skimTime', () => {
    expect(skimTime(50, 100, 8)).toBe(4);
    expect(skimTime(-5, 100, 8)).toBe(0);
    expect(skimTime(500, 100, 8)).toBe(8);
    expect(skimTime(10, 0, 8)).toBe(0);
  });

  it('skimIndex', () => {
    expect(skimIndex([], 1)).toBe(-1);
    expect(skimIndex([0, 2, 4, 6], 2.9)).toBe(1);
    expect(skimIndex([0, 2, 4, 6], 3.1)).toBe(2);
    expect(skimIndex([0, 2, 4, 6], 99)).toBe(3);
    expect(skimIndex([0, 2, 4, 6], -3)).toBe(0);
  });

  it('coverRect', () => {
    // a wide picture in a 16 / 10 box: the sides are cropped
    const r = coverRect(200, 100, 160, 100);
    expect(r.sh).toBeCloseTo(100, 9);
    expect(r.sw).toBeCloseTo(160, 9);
    expect(r.sx).toBeCloseTo(20, 9);
    expect(r.sy).toBeCloseTo(0, 9);
    // a tall one: top and bottom
    const t = coverRect(100, 200, 160, 100);
    expect(t.sw).toBeCloseTo(100, 9);
    expect(t.sh).toBeCloseTo(62.5, 9);
    expect(t.sy).toBeCloseTo(68.75, 9);
    // the same shape: all of it
    expect(coverRect(160, 100, 80, 50)).toEqual({ sx: 0, sy: 0, sw: 160, sh: 100 });
  });

  it('marksBar', () => {
    expect(marksBar(null, 10)).toBeNull();
    expect(marksBar({ in: 2, out: 6 }, 10)).toEqual({ left: 20, width: 40 });
    expect(marksBar({ in: 5 }, 10)).toEqual({ left: 50, width: 50 });
    expect(marksBar({ in: 2, out: 6 }, 0)).toBeNull();
  });

  it('marksTitle', () => {
    expect(marksTitle('clip.mp4 - 2 mb', { in: 1, out: 4 }, 10, 30)).toBe('clip.mp4 - 2 mb - marked 00:01:00 to 00:03:29');
    expect(marksTitle('x', { in: 2 }, 10, 30)).toBe('x - marked 00:02:00 to 00:09:29');
  });
});
