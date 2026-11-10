import { describe, expect, it } from 'vitest';
import { FORWARD_MAX, KEY_GAIN, feedIsNearer, feedStep, frameDistance, heldLength, movedBack, startsBy } from './scrubPlan';

const F = 1 / 60;
const frame = (i: number) => ({ start: i * F, length: F });

describe('frameDistance', () => {
  it('is 0 inside the frame, from its start up to the next frame', () => {
    expect(frameDistance(1, F, 1)).toBe(0);
    expect(frameDistance(1, F, 1 + F / 2)).toBe(0);
    expect(frameDistance(1, F, 1 + F - 0.001)).toBe(0);
  });
  it('counts the start of the next frame as outside', () => {
    expect(frameDistance(1, F, 1 + F)).toBeGreaterThan(0);
  });
  it('is the distance to the frame on both sides', () => {
    expect(frameDistance(1, F, 0.5)).toBeCloseTo(0.5, 6);
    expect(frameDistance(1, F, 2)).toBeCloseTo(1 - F, 3);
  });
  it('takes times that differ by rounding as the same', () => {
    expect(frameDistance(1, F, 1 - 0.00001)).toBe(0);
  });
  it('gives a frame without a length one', () => {
    expect(frameDistance(1, 0, 1.01)).toBe(0);
    expect(frameDistance(1, 0, 1.5)).toBeGreaterThan(0);
  });
});

describe('heldLength', () => {
  it('is the length the file gives when nothing else is known', () => {
    expect(heldLength(1, 0.04, null, false)).toBe(0.04);
  });
  it('reaches to the start of the next frame (a gap between frames belongs to the frame before it)', () => {
    expect(heldLength(1, 0.016, 1.04, false)).toBeCloseTo(0.04, 9);
    expect(frameDistance(1, heldLength(1, 0.016, 1.04, false), 1.03)).toBe(0);
  });
  it('never ends for the last frame of the file', () => {
    expect(frameDistance(59.98, heldLength(59.98, 0.016, null, true), 75)).toBe(0);
    expect(feedStep({ start: 59.98, length: heldLength(59.98, 0.016, null, true) }, false, 61, false, 58)).toBe('have');
  });
  it('ignores a next frame that does not start later', () => {
    expect(heldLength(1, 0.04, 1, false)).toBe(0.04);
  });
});

describe('startsBy', () => {
  it('leaves no time between a frame and the next one that belongs to neither', () => {
    const next = 301 * F;
    for (const at of [next - 0.001, next - 0.00011, next - 0.0001, next - 0.00005, next, next + 0.00005]) {
      const inHeld = frameDistance(300 * F, heldLength(300 * F, F, next, false), at) === 0;
      expect(inHeld !== startsBy(next, at)).toBe(true);
    }
  });
});

describe('feedStep', () => {
  it('starts at the wanted time when it holds nothing', () => {
    expect(feedStep(null, false, 5, false)).toBe('restart');
  });
  it('has the frame when the wanted time is inside it', () => {
    expect(feedStep(frame(300), true, 300 * F + 0.004, false)).toBe('have');
    expect(feedStep(frame(300), false, 300 * F, true)).toBe('have');
  });
  it('decodes on for a time a little ahead', () => {
    expect(feedStep(frame(300), true, 301 * F, false)).toBe('pull');
    expect(feedStep(frame(300), true, 300 * F + FORWARD_MAX, false)).toBe('pull');
  });
  it('starts again for a time far ahead', () => {
    expect(feedStep(frame(300), true, 300 * F + FORWARD_MAX + 0.5, false)).toBe('restart');
  });
  it('starts again when its decoder is not running', () => {
    expect(feedStep(frame(300), false, 301 * F, false)).toBe('restart');
  });
  it('stays out of it while the playhead moves back', () => {
    expect(feedStep(frame(300), true, 299 * F, true)).toBe('idle');
    expect(feedStep(null, false, 2, true)).toBe('idle');
  });
  it('still decodes on after a small step back that stays ahead of its frame', () => {
    expect(feedStep(frame(300), true, 302 * F, true)).toBe('pull');
  });
  it('starts again for a jump back that is not a drag', () => {
    expect(feedStep(frame(300), true, 2, false)).toBe('restart');
  });
  it('decodes on, however far, while no key frame lies between its frame and the wanted one', () => {
    // key frame at 4 s, the feed holds 4 s (just started there), the wanted time is 5.9 s
    expect(feedStep({ start: 4, length: F }, true, 5.9, false, 4)).toBe('pull');
    expect(feedStep({ start: 4.5, length: F }, true, 5.9, false, 4)).toBe('pull');
  });
  it('starts again at a key frame that skips enough decoding', () => {
    expect(feedStep({ start: 4.5, length: F }, true, 6.5, false, 6)).toBe('restart');
    expect(feedStep({ start: 4.5, length: F }, true, 6.5, true, 6)).toBe('idle');
  });
  it('decodes on over a key frame that is right ahead', () => {
    expect(feedStep({ start: 5.9, length: F }, true, 6.1, false, 6)).toBe('pull');
    expect(feedStep({ start: 6 - KEY_GAIN, length: F }, true, 6.1, false, 6)).toBe('pull');
  });
  it('knows the wanted frame it holds whatever the key frame', () => {
    expect(feedStep(frame(300), true, 300 * F, false, 4)).toBe('have');
  });
});

describe('feedIsNearer', () => {
  it('is when the element still shows an older frame', () => {
    expect(feedIsNearer(frame(300), 290 * F, 300 * F + 0.002)).toBe(true);
  });
  it('is not when the element shows the same frame', () => {
    expect(feedIsNearer(frame(300), 300 * F, 300 * F + 0.002)).toBe(false);
    expect(feedIsNearer(frame(300), 300 * F + 0.00002, 300 * F + 0.002)).toBe(false);
  });
  it('is not when the element shows the wanted frame and the feed another', () => {
    expect(feedIsNearer(frame(299), 300 * F, 300 * F + 0.002)).toBe(false);
    expect(feedIsNearer(frame(301), 300 * F, 300 * F + F - 0.001)).toBe(false);
  });
  it('is when both are off and the feed is closer', () => {
    expect(feedIsNearer(frame(298), 280 * F, 300 * F)).toBe(true);
    expect(feedIsNearer(frame(280), 298 * F, 300 * F)).toBe(false);
  });
  it('is not without a known element frame or wanted time', () => {
    expect(feedIsNearer(frame(300), Number.NaN, 5)).toBe(false);
    expect(feedIsNearer(frame(300), 4, Number.NaN)).toBe(false);
  });
});

describe('movedBack', () => {
  it('knows the direction of the last move', () => {
    expect(movedBack(null, 5, true)).toBe(false);
    expect(movedBack(5, 4, false)).toBe(true);
    expect(movedBack(5, 6, true)).toBe(false);
  });
  it('keeps the direction when the time did not move', () => {
    expect(movedBack(5, 5, true)).toBe(true);
    expect(movedBack(5, 5.00001, false)).toBe(false);
  });
});
