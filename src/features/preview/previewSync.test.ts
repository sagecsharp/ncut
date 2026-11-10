import { describe, expect, it } from 'vitest';
import { blocksPaint, isScrubbing, onSeekedAction } from './previewSync';

describe('isScrubbing', () => {
  it('only a running clock on a video that cannot play at that rate', () => {
    expect(isScrubbing(true, -1, 0, true)).toBe(true);
    expect(isScrubbing(true, 8, 0, true)).toBe(true);
    expect(isScrubbing(false, -1, 0, true)).toBe(false);
    expect(isScrubbing(true, 1, 0, true)).toBe(false);
    expect(isScrubbing(true, 2, 2, true)).toBe(false);
    expect(isScrubbing(true, -1, 0, false)).toBe(false);
  });
});

describe('blocksPaint', () => {
  const base = { seeking: false, readyState: 4, loading: false, scrubbing: false, playing: true };
  it('a seeking element holds the picture as before', () => {
    expect(blocksPaint({ ...base, seeking: true })).toBe(true);
    expect(blocksPaint({ ...base, seeking: true, playing: false, scrubbing: true })).toBe(true);
  });
  it('a loading element holds', () => {
    expect(blocksPaint({ ...base, readyState: 0, loading: true })).toBe(true);
    expect(blocksPaint({ ...base, readyState: 4, loading: true })).toBe(false);
  });
  it('a scrubbing element under a running clock does not hold while it has a frame', () => {
    expect(blocksPaint({ ...base, seeking: true, scrubbing: true })).toBe(false);
    expect(blocksPaint({ ...base, seeking: true, scrubbing: true, readyState: 1 })).toBe(true);
    expect(blocksPaint({ ...base, readyState: 0, loading: true, scrubbing: true })).toBe(true);
  });
  it('nothing in flight never holds', () => {
    expect(blocksPaint(base)).toBe(false);
  });
});

describe('onSeekedAction', () => {
  it('no deferred target: just redraw', () => {
    expect(onSeekedAction({ playing: true, scrubbing: true, want: null, current: 1 })).toEqual({ draw: false, seek: false, invalidate: true });
  });
  it('paused scrub paints first and leaves the seek to draw()', () => {
    expect(onSeekedAction({ playing: false, scrubbing: false, want: 5, current: 1 })).toEqual({ draw: true, seek: false, invalidate: false });
  });
  it('running clock scrub paints, then chases the target', () => {
    expect(onSeekedAction({ playing: true, scrubbing: true, want: 0.5, current: 1 })).toEqual({ draw: true, seek: true, invalidate: false });
    expect(onSeekedAction({ playing: true, scrubbing: true, want: 1.005, current: 1 })).toEqual({ draw: true, seek: false, invalidate: false });
  });
  it('normal playback keeps its old behaviour', () => {
    expect(onSeekedAction({ playing: true, scrubbing: false, want: 3, current: 1 })).toEqual({ draw: false, seek: true, invalidate: false });
    expect(onSeekedAction({ playing: true, scrubbing: false, want: 1, current: 1 })).toEqual({ draw: false, seek: false, invalidate: true });
  });
});
