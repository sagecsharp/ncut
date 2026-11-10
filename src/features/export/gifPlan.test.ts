import { describe, expect, it } from 'vitest';
import {
  GIF_FPS_OPTIONS,
  GIF_PIXEL_WARN,
  estimateGifBytes,
  gifExportFps,
  gifFpsNote,
  gifSizeWarning,
  paletteSampleFrames,
  sampleSize,
} from './gifPlan';
import { frameCount } from './exporter';
import { gifDelayCs } from '../../lib/gif';

describe('gif plan', () => {
  it('caps the frame rate at 50', () => {
    expect(gifExportFps(240)).toBe(50);
    expect(gifExportFps(15)).toBe(15);
    expect(gifFpsNote(60)).toContain('50');
    expect(gifFpsNote(30)).toBe('');
    expect(GIF_FPS_OPTIONS.every((f) => f <= 50)).toBe(true);
  });
  it('frame count and delays give the right length', () => {
    const project = { clips: [{ id: 'a', type: 'effect', start: 0, duration: 2, trackId: 't' }] } as never;
    const fps = gifExportFps(15);
    const n = frameCount(project, fps);
    expect(n).toBe(30);
    let cs = 0;
    for (let i = 0; i < n; i++) cs += gifDelayCs(i, fps);
    expect(cs).toBe(200);
  });
  it('estimates size and warns only for huge exports', () => {
    expect(estimateGifBytes(100, 100, 10)).toBe(12000);
    expect(gifSizeWarning(480, 270, 100)).toBe('');
    expect(gifSizeWarning(1920, 1080, Math.ceil(GIF_PIXEL_WARN / (1920 * 1080)) + 1)).not.toBe('');
  });
  it('picks palette frames evenly and in range', () => {
    expect(paletteSampleFrames(1)).toEqual([0]);
    expect(paletteSampleFrames(3)).toEqual([0, 1, 2]);
    const f = paletteSampleFrames(1000);
    expect(f.length).toBe(24);
    expect(new Set(f).size).toBe(24);
    expect(Math.min(...f)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...f)).toBeLessThan(1000);
  });
  it('shrinks the sample canvas only when big', () => {
    expect(sampleSize(1920, 1080)).toEqual({ width: 160, height: 90 });
    expect(sampleSize(100, 50)).toEqual({ width: 100, height: 50 });
  });
});
