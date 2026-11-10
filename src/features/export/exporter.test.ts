import { describe, expect, it } from 'vitest';
import type { Project } from '../../types';
import { frameCount, outputSize, planExport, videoBitrate } from './exporter';
import { MIX_SAMPLE_RATE } from './audioMix';

function withDuration(d: number): Pick<Project, 'clips'> {
  return { clips: [{ id: 'a', type: 'effect', start: 0, duration: d, trackId: 't' }] } as unknown as Pick<Project, 'clips'>;
}

describe('frameCount', () => {
  it('is exact at high frame rates', () => {
    expect(frameCount(withDuration(10), 240)).toBe(2400);
    expect(frameCount(withDuration(1), 240)).toBe(240);
    expect(frameCount(withDuration(0.1), 240)).toBe(24);
  });
  it('covers the whole project and never overshoots by a frame', () => {
    for (const d of [0.01, 0.5, 3.3, 59.99, 600.1, 3600.0166]) {
      for (const fps of [24, 30, 60, 144, 240]) {
        const n = frameCount(withDuration(d), fps);
        expect(n / fps).toBeGreaterThanOrEqual(d - 1e-9);
        expect(n / fps).toBeLessThan(d + 1 / fps + 1e-9);
      }
    }
  });
  it('video and audio lengths agree to within one frame for long exports', () => {
    const d = 3600.0166;
    const audio = Math.ceil(d * MIX_SAMPLE_RATE) / MIX_SAMPLE_RATE;
    const video = frameCount(withDuration(d), 240) / 240;
    expect(Math.abs(video - audio)).toBeLessThan(1 / 240 + 1 / MIX_SAMPLE_RATE);
  });
});

describe('videoBitrate', () => {
  it('grows with fps, sub-linearly', () => {
    const b30 = videoBitrate(1920, 1080, 30, 'medium', 'avc');
    const b240 = videoBitrate(1920, 1080, 240, 'medium', 'avc');
    expect(b240).toBeGreaterThan(b30);
    expect(b240 / b30).toBeLessThan(8);
    expect(b240 / b30).toBeCloseTo(Math.pow(8, 0.7), 1);
  });
  it('orders by quality', () => {
    expect(videoBitrate(1280, 720, 60, 'low', 'vp9')).toBeLessThan(videoBitrate(1280, 720, 60, 'high', 'vp9'));
  });
});

describe('outputSize', () => {
  it('is even', () => {
    expect(outputSize({ width: 1921, height: 1081 }, 0.75).width % 2).toBe(0);
  });
});

describe('planExport', () => {
  it('returns null without webcodecs', async () => {
    expect(await planExport({ container: 'mp4', width: 1920, height: 1080, fps: 240, quality: 'medium' })).toBeNull();
  });
});
