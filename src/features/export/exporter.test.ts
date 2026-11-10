import { describe, expect, it } from 'vitest';
import type { Project, ShapeClip, VideoClip } from '../../types';
import { neededClipsAt } from '../../engine/draw';
import { projectDuration } from '../../lib/timelineOps';
import { clipEdgeTimestamp, clipTimestamps, frameCount, isAudioContainer, outputSize, planExport, videoBitrate } from './exporter';
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

describe('export range', () => {
  it('counts the frames of the range only', () => {
    const p = withDuration(10);
    expect(frameCount(p, 30)).toBe(300);
    expect(frameCount(p, 30, { start: 2, end: 8 })).toBe(180);
    expect(frameCount(p, 30, { start: 8, end: 99 })).toBe(60);
  });
  it('video clip timestamps follow the range offset', () => {
    const clip = { id: 'v', type: 'video', start: 4, duration: 2, trimStart: 1, speed: 1 } as unknown as VideoClip;
    // range 3..9 at 10 fps: frame 10 is timeline 4s = the clip start = source 1s
    const stamps = clipTimestamps(clip, 10, 60, 100, 0, 3);
    expect(stamps.length).toBe(20);
    expect(stamps[0]).toBeCloseTo(1);
    expect(stamps[19]).toBeCloseTo(2.9);
    // the same clip without a range offset starts at frame 40
    expect(clipTimestamps(clip, 10, 90, 100, 0, 0)[0]).toBeCloseTo(1);
  });
  it('a range that starts inside a clip begins at the matching source time', () => {
    const clip = { id: 'v', type: 'video', start: 0, duration: 10, trimStart: 0, speed: 2 } as unknown as VideoClip;
    const stamps = clipTimestamps(clip, 10, 50, 100, 0, 3);
    expect(stamps[0]).toBeCloseTo(6);
  });
  it('wav and ogg are audio only', () => {
    expect(isAudioContainer('wav')).toBe(true);
    expect(isAudioContainer('ogg')).toBe(true);
    expect(isAudioContainer('mp4')).toBe(false);
  });
});

describe('shape clips', () => {
  const shape = {
    id: 's',
    type: 'shape',
    trackId: 't',
    start: 1,
    duration: 3,
    kind: 'rect',
    width: 100,
    height: 100,
    color: '#fff',
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
  } as unknown as ShapeClip;
  const project = {
    clips: [shape],
    tracks: [{ id: 't', kind: 'video', hidden: false }],
    assets: [],
  } as unknown as Project;
  it('count towards the export length without a source', () => {
    expect(projectDuration(project)).toBe(4);
    expect(frameCount(project, 30)).toBe(120);
  });
  it('are drawn: the exporter asks for them like for images', () => {
    expect(neededClipsAt(project, 2)).toEqual([shape]);
    expect(neededClipsAt(project, 0.5)).toEqual([]);
  });
});

describe('clipEdgeTimestamp', () => {
  const clip = { start: 1, duration: 2, speed: 1, trimStart: 0.5 } as unknown as VideoClip;
  it('a clip that ended before the range holds its last frame on the frame grid', () => {
    // end 3, 10 fps: last frame at 2.9 = 1.9 into the clip, source 0.5 + 1.9
    expect(clipEdgeTimestamp(clip, 10, 100, 0, 5)).toBeCloseTo(2.4);
  });
  it('speed scales the source time', () => {
    const fast = { start: 1, duration: 2, speed: 2, trimStart: 0 } as unknown as VideoClip;
    expect(clipEdgeTimestamp(fast, 10, 100, 0, 5)).toBeCloseTo(3.8);
  });
  it('a clip that starts after the range shows its first frame', () => {
    expect(clipEdgeTimestamp(clip, 10, 100, 0, 0)).toBeCloseTo(0.5);
  });
  it('stays inside the asset', () => {
    expect(clipEdgeTimestamp(clip, 10, 2, 0, 5)).toBeCloseTo(1.999);
    expect(clipEdgeTimestamp(clip, 10, 100, 0.8, 0)).toBeCloseTo(0.8);
  });
});
