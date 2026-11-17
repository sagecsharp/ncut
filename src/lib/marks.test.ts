import { describe, expect, it } from 'vitest';
import { lastFrameStart } from './inOut';
import {
  frameIndexAt,
  frameStart,
  goOutTime,
  inLabelTime,
  markMediaIn,
  markMediaOut,
  marksOf,
  outLabelTime,
  shownStart,
  stepTime,
  wholeMarks,
} from './marks';

describe('frame index', () => {
  it('forgives float noise', () => {
    expect(frameIndexAt(0.1 * 3, 30)).toBe(9);
    expect(frameIndexAt(1.999, 30)).toBe(59);
    expect(frameStart(9, 30)).toBeCloseTo(0.3, 12);
  });
  it('frame index forgives float noise', () => {
    // 48 / 23.976 is a hair under frame 48 and would floor to 47 without the tolerance
    expect(frameIndexAt(48 / 23.976 - 1e-9, 23.976)).toBe(48);
  });
});

describe('last frame start', () => {
  it('stepTime and goOutTime land on inOut', () => {
    expect(stepTime(0, 1000, 30, 2)).toBe(lastFrameStart(0, 2, 30));
    expect(goOutTime({ in: 0, out: 2 }, 5, 30)).toBe(lastFrameStart(0, 2, 30));
    expect(goOutTime({}, 2, 30)).toBe(lastFrameStart(0, 2, 30));
  });
  it('an end between lines is the frame it falls in', () => {
    expect(goOutTime({ out: 1.01 }, 5, 30)).toBeCloseTo(1, 9);
  });
});

describe('steps', () => {
  it('steps land on the grid', () => {
    expect(stepTime(1, 1, 30, 10)).toBeCloseTo(31 / 30, 9);
    expect(stepTime(1, -1, 30, 10)).toBeCloseTo(29 / 30, 9);
    expect(stepTime(1, 10, 30, 10)).toBeCloseTo(40 / 30, 9);
  });
  it('from between frames, forward goes to the next frame and back to the frame start', () => {
    expect(stepTime(1.01, 1, 30, 10)).toBeCloseTo(31 / 30, 9);
    expect(stepTime(1.01, -1, 30, 10)).toBeCloseTo(1, 9);
  });
  it('steps clamp', () => {
    expect(stepTime(0, -1, 30, 10)).toBe(0);
    expect(stepTime(9.99, 5, 30, 10)).toBeCloseTo(299 / 30, 9);
    expect(stepTime(5, 1, 30, 0)).toBe(0);
  });
});

describe('shownStart', () => {
  it('snaps down while playing, stays put while paused', () => {
    expect(shownStart(1.01, true, 30)).toBeCloseTo(1, 9);
    expect(shownStart(1.01, false, 30)).toBe(1.01);
  });
});

describe('o includes the shown frame', () => {
  it('i takes the frame start', () => {
    expect(markMediaIn(null, 1.01, 30)).toEqual({ range: { in: 1 }, dropped: false });
    expect(markMediaIn({ out: 3 }, 1.01, 30).range.in).toBeCloseTo(1, 9);
  });
  it('o ends after the frame on screen', () => {
    const r = markMediaOut({ in: 0 }, 2.01, 30, 10).range;
    expect(r.out).toBeCloseTo(2 + 1 / 30, 9);
    expect(r.in).toBe(0);
  });
  it('o at the end is the media end', () => {
    expect(markMediaOut(null, 9.999, 30, 10).range.out).toBe(10);
  });
  it('the last frame inside is the one on screen', () => {
    const m = markMediaOut({ in: 0 }, 2.01, 30, 10).range;
    expect(goOutTime(m, 10, 30)).toBeCloseTo(2, 9);
  });
});

describe('crossing drops the other mark', () => {
  it('an in after the out drops the out', () => {
    const r = markMediaIn({ in: 1, out: 2 }, 3, 30);
    expect(r).toEqual({ range: { in: 3 }, dropped: true });
  });
  it('an out before the in drops the in', () => {
    const r = markMediaOut({ in: 3, out: 4 }, 1, 30, 10);
    expect(r.dropped).toBe(true);
    expect(r.range.in).toBeUndefined();
    expect(r.range.out).toBeCloseTo(1 + 1 / 30, 9);
  });
});

describe('marksOf', () => {
  it('is null for a picture or no media', () => {
    expect(marksOf(null)).toBeNull();
    expect(marksOf(undefined)).toBeNull();
    expect(marksOf({ kind: 'image', marks: { in: 1, out: 2 } })).toBeNull();
  });
  it('cleans the stored marks', () => {
    expect(marksOf({ kind: 'video' })).toBeNull();
    expect(marksOf({ kind: 'video', marks: { in: 1, out: 2 } })).toEqual({ in: 1, out: 2 });
    expect(marksOf({ kind: 'audio', marks: { in: 2, out: 1 } })).toEqual({ in: 2 });
    expect(marksOf({ kind: 'video', marks: {} })).toBeNull();
  });
  it('wholeMarks spans the file', () => {
    expect(wholeMarks(12)).toEqual({ in: 0, out: 12 });
  });
});

describe('go out never before in', () => {
  it('stays at the in point', () => {
    expect(goOutTime({ in: 3, out: 3 + 1 / 60 }, 10, 30)).toBe(3);
  });
  it('is the last frame of a normal range', () => {
    expect(goOutTime({ in: 1, out: 2 }, 10, 30)).toBeCloseTo(59 / 30, 9);
  });
  it('is cut to the media end', () => {
    expect(goOutTime({ in: 1, out: 20 }, 10, 30)).toBeCloseTo(299 / 30, 9);
  });
});

describe('one frame labels', () => {
  const f = 1 / 30;
  it('a one frame range shows the same frame for in and out', () => {
    const m = { in: 2, out: 2 + f };
    expect(inLabelTime(m, 30)).toBeCloseTo(2, 9);
    expect(outLabelTime(m, 10, 30)).toBeCloseTo(2, 9);
  });
  it('out never reads before in', () => {
    expect(outLabelTime({ in: 5, out: 5 + f / 4 }, 10, 30)).toBeCloseTo(5, 9);
  });
  it('a missing in is the start, a missing out the last frame', () => {
    expect(inLabelTime({ out: 3 }, 30)).toBe(0);
    expect(outLabelTime({ in: 1 }, 10, 30)).toBeCloseTo(299 / 30, 9);
  });
});
