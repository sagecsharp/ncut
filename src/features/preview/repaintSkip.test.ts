import { describe, expect, it } from 'vitest';
import { MAX_SKIP_TIME_STEP, SKIP_UNCHANGED_FRAMES, canSkipRepaint } from './repaintSkip';
import type { FrameRecord, SkipFlags } from './repaintSkip';

const project = {};
const rec = (over: Partial<FrameRecord> = {}): FrameRecord => ({ project, key: 'a,|a,', allStatic: true, time: 1, frames: 10, width: 960, height: 540, ...over });
const flags = (over: Partial<SkipFlags> = {}): SkipFlags => ({ enabled: true, playing: true, sceneView: false, pending: false, videosReady: true, ...over });

describe('canSkipRepaint', () => {
  it('the kill switch is on', () => {
    expect(SKIP_UNCHANGED_FRAMES).toBe(true);
  });
  it('skips when nothing changed', () => {
    expect(canSkipRepaint(rec(), rec({ time: 1.016 }), flags())).toBe(true);
  });
  it('never skips without a last frame', () => {
    expect(canSkipRepaint(null, rec(), flags())).toBe(false);
  });
  it('kill switch off, not playing, scene view', () => {
    expect(canSkipRepaint(rec(), rec(), flags({ enabled: false }))).toBe(false);
    expect(canSkipRepaint(rec(), rec(), flags({ playing: false }))).toBe(false);
    expect(canSkipRepaint(rec(), rec(), flags({ sceneView: true }))).toBe(false);
  });
  it('something asked for a draw', () => {
    expect(canSkipRepaint(rec(), rec(), flags({ pending: true }))).toBe(false);
  });
  it('a video presented a new frame', () => {
    expect(canSkipRepaint(rec(), rec({ frames: 11 }), flags())).toBe(false);
  });
  it('a video that is not ready or cannot report frames', () => {
    expect(canSkipRepaint(rec(), rec(), flags({ videosReady: false }))).toBe(false);
  });
  it('another set of clips, or the same clips in another order', () => {
    expect(canSkipRepaint(rec(), rec({ key: 'a,b,|a,b,' }), flags())).toBe(false);
    expect(canSkipRepaint(rec({ key: 'a,b,|a,b,' }), rec({ key: 'b,a,|b,a,' }), flags())).toBe(false);
  });
  it('something on screen is not static now or was not at the last draw', () => {
    expect(canSkipRepaint(rec(), rec({ allStatic: false }), flags())).toBe(false);
    expect(canSkipRepaint(rec({ allStatic: false }), rec(), flags())).toBe(false);
  });
  it('an edit (another project object) or another canvas size', () => {
    expect(canSkipRepaint(rec(), rec({ project: {} }), flags())).toBe(false);
    expect(canSkipRepaint(rec(), rec({ width: 1920 }), flags())).toBe(false);
    expect(canSkipRepaint(rec(), rec({ height: 1080 }), flags())).toBe(false);
  });
  it('a jump of the clock either way', () => {
    expect(canSkipRepaint(rec(), rec({ time: 1 + MAX_SKIP_TIME_STEP + 0.01 }), flags())).toBe(false);
    expect(canSkipRepaint(rec(), rec({ time: 1 - MAX_SKIP_TIME_STEP - 0.01 }), flags())).toBe(false);
    expect(canSkipRepaint(rec(), rec({ time: 0.99 }), flags())).toBe(true);
  });
  it('a time that is not a number', () => {
    expect(canSkipRepaint(rec(), rec({ time: NaN }), flags())).toBe(false);
  });
});
