import { describe, expect, it } from 'vitest';
import type { Project, Track, VideoClip } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import {
  MAX_SEGMENT_SECONDS,
  MIN_PARALLEL_FRAMES,
  keyFrameIndex,
  keyGroupOf,
  pickWorkers,
  planSegments,
  runAhead,
  sameDecoderConfig,
} from './parallel';
import { clipTimestamps, heldAtFrame } from './sources';
import { neededForFrame } from './reach';
import { frameTime } from './range';

describe('planSegments', () => {
  it('covers every frame exactly once, in order', () => {
    for (const total of [1, 2, 119, 120, 121, 599, 600, 3600, 36001, 144000]) {
      for (const fps of [24, 30, 60, 120, 240]) {
        for (const workers of [1, 2, 3, 4, 8]) {
          const parts = planSegments(total, fps, workers);
          expect(parts.length).toBeGreaterThan(0);
          expect(parts[0]!.from).toBe(0);
          expect(parts[parts.length - 1]!.to).toBe(total);
          for (let k = 0; k < parts.length; k++) {
            expect(parts[k]!.to).toBeGreaterThan(parts[k]!.from);
            if (k > 0) expect(parts[k]!.from).toBe(parts[k - 1]!.to);
          }
        }
      }
    }
  });
  it('starts every part on a key frame of the one-thread rhythm (a whole number of key frame intervals)', () => {
    for (const fps of [24, 30, 60, 240]) {
      const gop = 2 * fps;
      for (const p of planSegments(100 * fps + 7, fps, 3)) expect(p.from % gop).toBe(0);
    }
  });
  it('gives each worker one part on a short export and caps the length on a long one', () => {
    expect(planSegments(3600, 60, 3)).toEqual([
      { from: 0, to: 1200 },
      { from: 1200, to: 2400 },
      { from: 2400, to: 3600 },
    ]);
    const long = planSegments(60 * 600, 60, 3);
    expect(long.length).toBe(600 / MAX_SEGMENT_SECONDS);
    for (const p of long) expect(p.to - p.from).toBeLessThanOrEqual(MAX_SEGMENT_SECONDS * 60);
  });
  it('lets a short tail join the part before it', () => {
    // 2 parts of 120 would leave 10 frames over
    const parts = planSegments(250, 60, 2);
    expect(parts[parts.length - 1]!.to).toBe(250);
    for (const p of parts) expect(p.to - p.from).toBeGreaterThanOrEqual(60);
  });
  it('cuts where one encoder starts a key frame group, also at frame rates that are not whole numbers', () => {
    for (const fps of [23.976, 29.97, 59.94, 119.88, 12.5, 24, 60, 0.7, 0.3]) {
      for (const total of [481, 1000, 5000, 36001]) {
        for (const workers of [2, 3, 8]) {
          const parts = planSegments(total, fps, workers);
          expect(parts[0]!.from).toBe(0);
          expect(parts[parts.length - 1]!.to).toBe(total);
          for (let k = 1; k < parts.length; k++) {
            const from = parts[k]!.from;
            expect(from).toBe(parts[k - 1]!.to);
            // the frame before it belongs to the group before: one encoder writes a key frame exactly here
            expect(keyGroupOf(from, fps)).toBeGreaterThan(keyGroupOf(from - 1, fps));
          }
          // a tail shorter than half a group joins the last part
          for (const p of parts) expect(p.to - p.from).toBeLessThanOrEqual(Math.ceil((MAX_SEGMENT_SECONDS + 1) * fps) + 1);
        }
      }
    }
  });
  it('is the old plan at whole frame rates', () => {
    // the plan before key frame groups were counted: lengths of round(2 * fps) frames
    const old = (total: number, fps: number, workers: number) => {
      const gop = Math.max(1, Math.round(2 * fps));
      const cap = Math.max(gop, Math.floor((MAX_SEGMENT_SECONDS * fps) / gop) * gop);
      const len = Math.max(gop, Math.min(cap, Math.ceil(total / workers / gop) * gop));
      const out: Array<{ from: number; to: number }> = [];
      for (let from = 0; from < total; from += len) out.push({ from, to: Math.min(total, from + len) });
      if (out.length > 1 && out[out.length - 1]!.to - out[out.length - 1]!.from < gop / 2) {
        out.pop();
        out[out.length - 1]!.to = total;
      }
      return out;
    };
    for (const fps of [1, 12, 24, 25, 30, 50, 60, 120, 144, 240, 12.5]) {
      for (const total of [1, 50, 119, 120, 121, 250, 480, 599, 3600, 36001, 144000]) {
        for (const workers of [1, 2, 3, 4, 8]) expect(planSegments(total, fps, workers)).toEqual(old(total, fps, workers));
      }
    }
  });
  it('is empty for nothing and one part for less than a key frame interval', () => {
    expect(planSegments(0, 60, 3)).toEqual([]);
    expect(planSegments(50, 60, 3)).toEqual([{ from: 0, to: 50 }]);
  });
});

describe('keyFrameIndex', () => {
  it('is the first frame of a group', () => {
    for (const fps of [23.976, 24, 29.97, 30, 59.94, 60, 240, 0.7]) {
      let last = -1;
      for (let k = 0; k < 400; k++) {
        const i = keyFrameIndex(k, fps);
        expect(keyGroupOf(i, fps)).toBeGreaterThanOrEqual(k);
        if (i > 0) expect(keyGroupOf(i - 1, fps)).toBeLessThan(k);
        expect(i).toBeGreaterThanOrEqual(last);
        last = i;
      }
    }
    expect(keyFrameIndex(0, 60)).toBe(0);
    expect(keyFrameIndex(1, 60)).toBe(120);
    expect(keyFrameIndex(3, 30)).toBe(180);
    // 29.97: the groups are 60, 60, 60, ... frames with a 59 in between
    expect(keyFrameIndex(1, 29.97)).toBe(60);
    expect(keyFrameIndex(17, 29.97)).toBe(1019);
  });
});

describe('runAhead', () => {
  it('keeps a few parts ahead, never less than two', () => {
    expect(runAhead(1)).toBe(2);
    expect(runAhead(3)).toBe(6);
    expect(runAhead(8)).toBe(16);
    expect(runAhead(0)).toBe(2);
  });
});

describe('pickWorkers', () => {
  it('stays on one thread for short exports and small machines', () => {
    expect(pickWorkers(1920, 1080, MIN_PARALLEL_FRAMES - 1, 60, 16)).toBe(1);
    expect(pickWorkers(1920, 1080, 6000, 60, 2)).toBe(1);
    expect(pickWorkers(1920, 1080, 6000, 0, 16)).toBe(1);
  });
  it('uses three up to full hd and two above', () => {
    expect(pickWorkers(1920, 1080, 6000, 60, 16)).toBe(3);
    expect(pickWorkers(1280, 720, 6000, 30, 16)).toBe(3);
    expect(pickWorkers(3840, 2160, 6000, 60, 16)).toBe(2);
    expect(pickWorkers(1920, 1080, 6000, 60, 6)).toBe(2);
  });
  it('never asks for more workers than there are parts', () => {
    for (const total of [480, 500, 700, 1000]) {
      for (const fps of [24, 60, 240]) {
        const n = pickWorkers(1920, 1080, total, fps, 16);
        expect(n).toBeLessThanOrEqual(Math.max(1, planSegments(total, fps, n).length));
      }
    }
  });
});

describe('sameDecoderConfig', () => {
  const base = { codec: 'avc1.64002a', codedWidth: 1920, codedHeight: 1080 };
  it('compares codec, size and the setup bytes', () => {
    const a = { ...base, description: new Uint8Array([1, 2, 3, 4]) };
    expect(sameDecoderConfig(a, { ...base, description: new Uint8Array([1, 2, 3, 4]).buffer })).toBe(true);
    expect(sameDecoderConfig(a, { ...base, description: new Uint8Array([1, 2, 3, 5]) })).toBe(false);
    expect(sameDecoderConfig(a, { ...base, description: new Uint8Array([1, 2, 3]) })).toBe(false);
    expect(sameDecoderConfig(a, { ...base, codec: 'avc1.640033', description: new Uint8Array([1, 2, 3, 4]) })).toBe(false);
    expect(sameDecoderConfig(a, { ...base, codedHeight: 1088, description: new Uint8Array([1, 2, 3, 4]) })).toBe(false);
  });
  it('treats two streams without setup bytes as the same and one with as different', () => {
    expect(sameDecoderConfig(base, { ...base })).toBe(true);
    expect(sameDecoderConfig(base, { ...base, description: new Uint8Array([1]) })).toBe(false);
  });
  it('reads a view at its offset', () => {
    const big = new Uint8Array([9, 9, 1, 2, 3, 9]);
    expect(sameDecoderConfig({ ...base, description: big.subarray(2, 5) }, { ...base, description: new Uint8Array([1, 2, 3]) })).toBe(true);
  });
});

let seq = 0;
function video(trackId: string, start: number, duration: number, extra: Partial<VideoClip> = {}): VideoClip {
  return {
    id: `v${++seq}`, type: 'video', trackId, start, duration, name: 'v', fadeIn: 0, fadeOut: 0,
    assetId: 'vid', trimStart: 0, speed: 1, volume: 1, muted: false, transform: { ...DEFAULT_TRANSFORM }, ...extra,
  };
}
function project(clips: Project['clips'], fps = 30): Project {
  const tracks: Track[] = [{ id: 'a', kind: 'video', name: 'a', muted: false, hidden: false, locked: false }];
  return { id: 'p', name: 'p', createdAt: 0, updatedAt: 0, width: 1920, height: 1080, fps, background: '#000', assets: [], tracks, clips };
}

describe('clipTimestamps for a part of the grid', () => {
  it('the parts put together are the whole', () => {
    const clip = video('a', 1.3, 7.7, { trimStart: 0.4, speed: 1.5 });
    const whole = Array.from(clipTimestamps(clip, 60, 600, 30, 0.02, 0.25));
    const joined: number[] = [];
    for (const [from, to] of [[0, 120], [120, 360], [360, 600]] as const) {
      joined.push(...clipTimestamps(clip, 60, 600, 30, 0.02, 0.25, undefined, from, to));
    }
    expect(joined).toEqual(whole);
  });
  it('is empty for a part the clip does not play in', () => {
    const clip = video('a', 0, 1);
    expect(clipTimestamps(clip, 60, 600, 30, 0, 0, undefined, 120, 240).length).toBe(0);
  });
});

describe('heldAtFrame', () => {
  const grid = { fps: 30, rangeStart: 0, totalFrames: 600 };
  it('a clip that is no longer needed right after its last frame is not held later', () => {
    const a = video('a', 0, 2);
    const b = video('a', 2, 10);
    const p = project([a, b]);
    // a plays in frames 0..59
    expect(heldAtFrame(p, a, grid, 59, 60)).toBe(false);
    expect(heldAtFrame(p, a, grid, 59, 200)).toBe(false);
  });
  it('agrees with walking the frames the way the exporter frees pictures', () => {
    // a transition out of `a` (if the project format gives one a reach past the cut) keeps it for a while
    const a = video('a', 0, 2);
    const b = video('a', 2, 10, { transition: { id: 'crossfade', duration: 1 } });
    const p = project([a, b]);
    const last = 59;
    for (const from of [60, 61, 70, 74, 75, 76, 90, 200]) {
      // the reference: needed at every frame from the one after its last up to `from`
      let held = true;
      for (let j = last + 1; j <= from && held; j++) held = neededForFrame(p, frameTime(0, j, 30)).includes(a);
      expect(heldAtFrame(p, a, grid, last, from)).toBe(held);
    }
    // and it is really held somewhere past the cut, otherwise this test checks nothing
    expect(heldAtFrame(p, a, grid, last, 62)).toBe(true);
  });
});
