import { describe, expect, it } from 'vitest';
import { BEAT_EVERY_MAX, BEAT_EVERY_MIN, LINE_NUDGE, clipGrid, cycleLength, cyclePhase, effectBeatGrid, parseEffectBeat, pulseEnvelope, rankTempoClips, sameEffectBeat } from './tempo';
import type { BeatGrid } from './tempo';

type Pool = Parameters<typeof rankTempoClips>[0];

function sound(id: string, start: number, duration: number, bpm: number | null, over: Record<string, unknown> = {}) {
  return { id, type: 'audio', start, duration, name: id, assetId: 'aud', trimStart: 0, speed: 1, bpm, ...over };
}
const assets = [
  { id: 'aud', hasAudio: true },
  { id: 'mute', hasAudio: false },
  { id: 'vid', hasAudio: true },
];
const pool = (clips: unknown[]): Pool => ({ clips, assets }) as unknown as Pool;

describe('parseEffectBeat', () => {
  it('cleans the shape', () => {
    expect(parseEffectBeat({ source: 'a', every: 2, pulse: 0.5, lock: true })).toEqual({ source: 'a', every: 2, pulse: 0.5, lock: true });
    expect(parseEffectBeat({ every: 1, pulse: 3, lock: 'yes' })).toEqual({ source: null, every: 1, pulse: 1, lock: false });
    expect(parseEffectBeat({ source: '', every: 1, pulse: -1, lock: false })).toEqual({ source: null, every: 1, pulse: 0, lock: false });
    expect(parseEffectBeat({ source: 5, every: 1, pulse: NaN, lock: true })).toEqual({ source: null, every: 1, pulse: 0, lock: true });
  });

  it('clamps every into 1/16 .. 64', () => {
    expect(parseEffectBeat({ every: 0, pulse: 0, lock: false })!.every).toBe(BEAT_EVERY_MIN);
    expect(parseEffectBeat({ every: -4, pulse: 0, lock: false })!.every).toBe(BEAT_EVERY_MIN);
    expect(parseEffectBeat({ every: 1000, pulse: 0, lock: false })!.every).toBe(BEAT_EVERY_MAX);
    expect(parseEffectBeat({ every: 0.25, pulse: 0, lock: false })!.every).toBe(0.25);
  });

  it('bad input is no link', () => {
    for (const bad of [null, undefined, 3, 'x', [], {}, { every: NaN }, { every: Infinity }, { every: '2' }]) expect(parseEffectBeat(bad)).toBeNull();
  });
});

describe('sameEffectBeat', () => {
  it('compares by what the link says', () => {
    const a = { source: null, every: 1, pulse: 0.5, lock: false };
    expect(sameEffectBeat(a, { ...a })).toBe(true);
    expect(sameEffectBeat(a, { ...a, pulse: 0.6 })).toBe(false);
    expect(sameEffectBeat(a, null)).toBe(false);
    expect(sameEffectBeat(null, undefined)).toBe(true);
  });
});

describe('pulseEnvelope', () => {
  it('is 1 on the line and 1 - pulse at the end, falling in between', () => {
    expect(pulseEnvelope(0.7, 0)).toBe(1);
    expect(pulseEnvelope(0.7, 1)).toBeCloseTo(0.3, 12);
    let last = 1;
    for (let i = 1; i <= 20; i++) {
      const v = pulseEnvelope(0.7, i / 20);
      expect(v).toBeLessThanOrEqual(last);
      last = v;
    }
    // a hit: more than half of the fall is done a quarter of the way in
    expect(1 - pulseEnvelope(1, 0.25)).toBeGreaterThan(0.5);
  });

  it('pulse 0 never changes anything', () => {
    for (const ph of [0, 0.3, 0.99]) expect(pulseEnvelope(0, ph)).toBe(1);
  });
});

describe('cyclePhase', () => {
  const g: BeatGrid = { origin: 1, step: 0.5 };

  it('finds the line at or before a time, also before the origin', () => {
    const p = cyclePhase(g, 2, 3.25); // cycle = 1 s, lines at 1, 2, 3 ...
    expect(p.index).toBe(2);
    expect(p.line).toBe(3);
    expect(p.phase).toBeCloseTo(0.25, 12);
    const q = cyclePhase(g, 2, -0.5);
    expect(q.index).toBe(-2);
    expect(q.line).toBe(-1);
    expect(q.phase).toBeCloseTo(0.5, 12);
    expect(cycleLength(g, 2)).toBe(1);
  });

  it('a time on a line is phase 0, never 0.9999', () => {
    for (const bpm of [128, 174.3]) {
      const grid = clipGrid({ start: 0.123, trimStart: 0, speed: 1, bpm, beatOffset: 0.0371 })!;
      for (const every of [0.25, 0.5, 1, 2, 4, 8, 16]) {
        for (let k = -20; k < 500; k++) {
          // the line the way a person's code would write it, and a hair off it either way
          if (every >= 1 && k % every !== 0) continue;
          if (every < 1 && (k / every) % 1 !== 0) continue;
          const line = grid.origin + k * grid.step;
          for (const t of [line, line + 1e-12, line - 1e-12]) {
            expect(cyclePhase(grid, every, t).phase).toBe(0);
          }
        }
      }
    }
  });

  it('frames of 23.976, 30, 60 and 240 fps that lie on a line are phase 0, the others are where the distance says', () => {
    for (const fps of [24000 / 1001, 30, 60, 240]) {
      for (const bpm of [128, 174.3]) {
        const grid: BeatGrid = { origin: 0, step: 60 / bpm };
        let seen = 0;
        for (let k = 0; k < 500; k++) {
          const line = k * grid.step;
          const t = Math.round(line * fps) / fps;
          const p = cyclePhase(grid, 1, t);
          if (Math.abs(t - line) < 1e-9) {
            seen++;
            expect(p.phase).toBe(0);
          } else {
            const d = (t - line) / grid.step;
            expect(p.phase).toBeCloseTo(d >= 0 ? d : 1 + d, 6);
          }
        }
        // 30 and 60 fps hit lines of some tempos exactly; the rest only come close, which is checked above
        if (fps === 30 && bpm === 128) expect(seen).toBeGreaterThan(0);
      }
    }
  });

  it('a frame that is exactly on a line (frame grid = beat grid) is phase 0 for 500 beats', () => {
    // 120 bpm at 30, 60 and 240 fps: every beat is a whole number of frames
    for (const fps of [30, 60, 240]) {
      const grid: BeatGrid = { origin: 0, step: 0.5 };
      for (let k = 0; k < 500; k++) {
        const t = (k * fps * 0.5) / fps;
        expect(cyclePhase(grid, 1, t).phase).toBe(0);
      }
    }
  });

  it('phase counts up inside a cycle and drops back at the next line', () => {
    const grid: BeatGrid = { origin: 0.2, step: 60 / 128 };
    let last = -1;
    for (let i = 0; i < 400; i++) {
      const t = 0.2 + i * 0.01;
      const p = cyclePhase(grid, 1, t).phase;
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThan(1);
      if (p < last) expect(last).toBeGreaterThan(0.9);
      last = p;
    }
  });

  it('LINE_NUDGE stays far below a frame', () => {
    expect(LINE_NUDGE).toBeLessThan(1e-3);
  });
});

describe('rankTempoClips / effectBeatGrid', () => {
  it('ranks by overlap, then by start, and the clip itself first when asked', () => {
    const p = pool([sound('far', 20, 5, 100), sound('part', 3, 4, 110), sound('under', 0, 10, 120), sound('self', 50, 2, 90)]);
    const span = { start: 2, duration: 6 };
    expect(rankTempoClips(p, span).map((r) => r.clip.id)).toEqual(['under', 'part', 'far', 'self']);
    expect(rankTempoClips(p, span, 'self').map((r) => r.clip.id)).toEqual(['self', 'under', 'part', 'far']);
  });

  it('only clips with sound and a tempo', () => {
    const p = pool([
      sound('none', 0, 10, null),
      sound('okay', 0, 10, 120),
      sound('mutevid', 0, 10, 120, { type: 'video', assetId: 'mute' }),
      sound('vid', 0, 10, 100, { type: 'video', assetId: 'vid' }),
      { id: 'img', type: 'image', start: 0, duration: 10, assetId: 'vid' },
    ]);
    expect(rankTempoClips(p, { start: 0, duration: 10 }).map((r) => r.clip.id)).toEqual(['okay', 'vid']);
  });

  it('reports what is heard (the tempo times the speed)', () => {
    const p = pool([sound('fast', 0, 10, 100, { speed: 2 })]);
    expect(rankTempoClips(p, { start: 0, duration: 1 })[0]!.heard).toBe(200);
  });

  it('effectBeatGrid: the named clip, else the sound under the effect, else nothing', () => {
    const p = pool([sound('a', 0, 4, 120), sound('b', 4, 10, 90)]);
    const fx = { start: 5, duration: 2 };
    // no link, no grid
    expect(effectBeatGrid(p, fx)).toBeNull();
    expect(effectBeatGrid(p, { ...fx, beat: {} })).toEqual({ origin: 4, step: 60 / 90 });
    expect(effectBeatGrid(p, { ...fx, beat: { source: 'a' } })).toEqual({ origin: 0, step: 0.5 });
    // a source that is gone or has no tempo any more: the sound under it
    expect(effectBeatGrid(p, { ...fx, beat: { source: 'deleted' } })).toEqual({ origin: 4, step: 60 / 90 });
    expect(effectBeatGrid(pool([sound('a', 0, 4, null), sound('b', 4, 10, 90)]), { ...fx, beat: { source: 'a' } })).toEqual({ origin: 4, step: 60 / 90 });
    expect(effectBeatGrid(pool([sound('a', 0, 4, null)]), { ...fx, beat: {} })).toBeNull();
    expect(effectBeatGrid(pool([]), { ...fx, beat: { source: 'a' } })).toBeNull();
  });
});
