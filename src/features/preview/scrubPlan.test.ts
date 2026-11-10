import { describe, expect, it } from 'vitest';
import {
  BACK_STRIDE_MAX,
  FORWARD_MAX,
  KEY_GAIN,
  backFrames,
  backStretch,
  backStride,
  coverIndex,
  feedIsNearer,
  feedStep,
  frameDistance,
  heldLength,
  movedBack,
  startsBy,
} from './scrubPlan';

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
  it('is at the end of the file, where the last frame stands for every later time', () => {
    const last = { start: 59.98, length: Number.POSITIVE_INFINITY };
    // the element still shows a frame from a second ago
    expect(feedIsNearer(last, 58.9, 60.4)).toBe(true);
    // the element shows the last frame too
    expect(feedIsNearer(last, 59.98, 60.4)).toBe(false);
  });
  it('is not without a known element frame or wanted time', () => {
    expect(feedIsNearer(frame(300), Number.NaN, 5)).toBe(false);
    expect(feedIsNearer(frame(300), 4, Number.NaN)).toBe(false);
  });
});

describe('backFrames', () => {
  it('keeps as many frames as the memory allows, at most 48', () => {
    expect(backFrames(1920, 1080)).toBe(48);
    expect(backFrames(1280, 720)).toBe(48);
    expect(backFrames(2560, 1440)).toBe(43);
  });
  it('keeps none of a picture too big for enough of them, or without a size', () => {
    expect(backFrames(3840, 2160)).toBe(0);
    expect(backFrames(0, 0)).toBe(0);
    expect(backFrames(Number.NaN, 1080)).toBe(0);
  });
});

describe('backStride', () => {
  // seconds of the file per ms: 1x is 0.001
  it('keeps every frame of a drag at the speed of the video', () => {
    expect(backStride(-0.001, F)).toBe(1);
    expect(backStride(0, F)).toBe(1);
  });
  it('keeps every nth frame of a drag that passes n frames per picture', () => {
    expect(backStride(-0.004, F)).toBe(4);
    // a 30 fps file at 4x passes 2 frames per picture
    expect(backStride(-0.004, 1 / 30)).toBe(2);
  });
  it('widens the step when a fill takes longer than its frames last', () => {
    // 24 frames at 60 fps last 400 ms at 1x: a fill of 300 ms fits, one of 700 ms needs every third frame
    expect(backStride(-0.001, F, 300, 24)).toBe(1);
    expect(backStride(-0.001, F, 700, 24)).toBe(3);
  });
  it('gives up (0) on a drag too fast for the widest step', () => {
    expect(backStride(-0.015, F)).toBe(0);
    expect(backStride(-0.001 * BACK_STRIDE_MAX, F)).toBe(BACK_STRIDE_MAX);
    expect(backStride(-0.001, F, 5000, 24)).toBe(0);
  });
});

describe('backStretch', () => {
  it('ends with the frame the playhead is in and reaches the kept frames further back', () => {
    const s = backStretch(10, 0, 100, 24, 1, F);
    expect(s.end).toBeCloseTo(10 + F, 9);
    expect(s.from).toBeCloseTo(10 - 24 * F, 9);
  });
  it('reaches further for a playhead that moves on while the fill runs', () => {
    // 1x for 100 ms: 0.1 s further
    const s = backStretch(10, -0.001, 100, 24, 1, F);
    expect(s.from).toBeCloseTo(10 - 0.1 - 24 * F, 9);
    // never more than one stretch further
    const far = backStretch(10, -0.05, 100, 24, 1, F);
    expect(far.from).toBeCloseTo(10 - 2 * 24 * F, 9);
  });
  it('does not start before the file', () => {
    expect(backStretch(0.1, -0.001, 100, 24, 2, F).from).toBe(0);
  });
});

describe('coverIndex', () => {
  const kept = [0, 1, 2, 3].map((i) => ({ timestamp: 5 + i * F, duration: F }));
  it('finds the kept frame a time lies in', () => {
    expect(coverIndex(kept, 5)).toBe(0);
    expect(coverIndex(kept, 5 + 1.5 * F)).toBe(1);
    expect(coverIndex(kept, 5 + 3.9 * F)).toBe(3);
  });
  it('finds none before the first, after the last, or among no frames', () => {
    expect(coverIndex(kept, 4.99)).toBe(-1);
    expect(coverIndex(kept, 5 + 4 * F)).toBe(-1);
    expect(coverIndex([], 5)).toBe(-1);
    expect(coverIndex(kept, Number.NaN)).toBe(-1);
  });
  it('takes a frame kept for several (a wide step) as the picture for all of them', () => {
    const wide = [0, 1, 2].map((i) => ({ timestamp: 5 + i * 4 * F, duration: 4 * F }));
    expect(coverIndex(wide, 5 + 3 * F)).toBe(0);
    expect(coverIndex(wide, 5 + 4 * F)).toBe(1);
  });
  it('finds none in a hole between two kept frames', () => {
    const holed = [
      { timestamp: 5, duration: F },
      { timestamp: 6, duration: F },
    ];
    expect(coverIndex(holed, 5.5)).toBe(-1);
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
