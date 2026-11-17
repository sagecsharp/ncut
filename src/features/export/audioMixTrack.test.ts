import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { AudioClip, MediaAsset, Project, Track } from '../../types';
import { createProject } from '../../lib/factory';
import { clipMix, outputGain, panGains } from '../../lib/mix';
import { clipSchedule, createAudioMixer, getAudibleClips, panPoints, scaleGain, trimGainPoints } from './audioMix';

vi.mock('../../media/registry', () => ({ getAssetBlob: () => new Blob(['x']) }));
vi.mock('mediabunny', async (orig) => ({
  ...(await orig<typeof import('mediabunny')>()),
  Input: class {
    getPrimaryAudioTrack() {
      return Promise.reject(new Error('no track'));
    }
  },
}));

const snd: MediaAsset = { id: 'snd', name: 'snd', kind: 'audio', mime: 'audio/wav', size: 1, duration: 60, width: 0, height: 0, hasAudio: true, createdAt: 0 } as MediaAsset;

const audio = (over: Partial<AudioClip> = {}): AudioClip => ({
  id: 'c', name: 'c', type: 'audio', trackId: 't', assetId: 'snd', start: 2, duration: 10, trimStart: 0, speed: 1, volume: 1, muted: false, fadeIn: 0, fadeOut: 0, ...over,
});

function proj(clips: AudioClip[], track: Partial<Track> = {}, output?: { volume: number } | null): Project {
  const p = createProject('exp');
  const t: Track = { ...p.tracks[1]!, id: 't', ...track };
  return { ...p, tracks: [t], clips, assets: [snd], ...(output === undefined ? {} : { output }) };
}

describe('audioMix track and output', () => {
  it('scaleGain is the same array at 1', () => {
    const pts: Array<[number, number]> = [[0, 0.5], [1, 1]];
    expect(scaleGain(pts, 1)).toBe(pts);
    expect(scaleGain(pts, 0.5)).toEqual([[0, 0.25], [1, 0.5]]);
    expect(pts).toEqual([[0, 0.5], [1, 1]]);
  });

  it('panPoints is null when neutral', () => {
    expect(panPoints(audio(), 0)).toBeNull();
  });

  it('a constant pan is two points', () => {
    const p = panPoints(audio({ pan: 0.5 }), 0)!;
    expect(p.l).toHaveLength(2);
    expect(p.r).toHaveLength(2);
    expect(p.l.map((x) => x[0])).toEqual([0, 10]);
    expect(p.l[0]![1]).toBeCloseTo(Math.cos(Math.PI / 4), 12);
    expect(p.r[0]![1]).toBe(1);
    // a track pan alone needs the block too
    expect(panPoints(audio(), -1)!.r.map((x) => x[1])).toEqual([0, 0]);
  });

  it('keyed pan samples key times and the grid', () => {
    const c = audio({ keyframes: { pan: [{ t: 0, v: -1, ease: 'linear' }, { t: 2.5, v: 1, ease: 'hold' }, { t: 10, v: 0, ease: 'linear' }] } });
    const p = panPoints(c, 0)!;
    const times = p.l.map((x) => x[0]);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(times[0]).toBe(0);
    expect(times[times.length - 1]).toBe(10);
    expect(times).toContain(2.5);
    expect(times).toContain(2.5 - 0.0005);
    expect(times).toContain(2.5 + 0.0005);
    // the grid: 1000 steps of 0.01 over 10 s
    expect(times.some((t) => Math.abs(t - 5) < 1e-9)).toBe(true);
    expect(times.length).toBeGreaterThan(900);
    expect(p.r.map((x) => x[0])).toEqual(times);
    // far left at the start, centered after the hold key
    expect(p.l[0]![1]).toBe(1);
    expect(p.r[0]![1]).toBe(0);
  });

  it('track and clip pan multiply per side', () => {
    const p = panPoints(audio({ pan: 0.5 }), 0.5)!;
    const [cl] = panGains(0.5);
    expect(p.l[0]![1]).toBeCloseTo(cl * cl, 12);
    expect(p.r[0]![1]).toBe(1);
    const q = panPoints(audio({ pan: -0.5 }), 0.5)!;
    expect(q.l[0]![1]).toBeCloseTo(cl, 12);
    expect(q.r[0]![1]).toBeCloseTo(cl, 12);
  });

  it('getAudibleClips skips a track at 0', () => {
    const c = audio();
    expect(getAudibleClips(proj([c]))).toEqual([c]);
    expect(getAudibleClips(proj([c], { volume: 0 }))).toEqual([]);
    expect(getAudibleClips(proj([c], { volume: 0.5 }))).toEqual([c]);
  });

  it('getAudibleClips is empty at output 0', () => {
    const c = audio();
    expect(getAudibleClips(proj([c], {}, { volume: 0 }))).toEqual([]);
    expect(getAudibleClips(proj([c], {}, { volume: 0.5 }))).toEqual([c]);
  });

  it('the export gain follows the one rule', () => {
    const clip = audio({
      volume: 0.9,
      fadeIn: 1.5,
      fadeOut: 2,
      keyframes: { volume: [{ t: 0, v: 0.2, ease: 'linear' }, { t: 4, v: 1, ease: 'linear' }, { t: 10, v: 0.4, ease: 'linear' }] },
    });
    const p = proj([clip], { volume: 0.7 }, { volume: 0.8 });
    const sch = clipSchedule(clip, 0, 20)!;
    const pts = scaleGain(sch.gain, 0.7 * 0.8);
    expect(pts.length).toBeGreaterThan(30);
    for (let i = 0; i < 30; i++) {
      const [t, g] = pts[Math.round((i * (pts.length - 1)) / 29)]!;
      expect(Math.abs(g - clipMix(p, clip, t, null).gain * outputGain(p))).toBeLessThan(1e-9);
    }
  });

  it('audioMix.ts never imports store/solo', () => {
    const text = readFileSync(new URL('./audioMix.ts', import.meta.url), 'utf8');
    expect(text).not.toContain('store/solo');
    expect(text).not.toContain('/store/');
  });
});

type Call = [string, ...unknown[]];

/** an OfflineAudioContext that only records what the mixer does */
function stubContext() {
  const made: Array<{ kind: string; id: number; calls: Call[] }> = [];
  const dest = { kind: 'destination' };
  const node = (kind: string, extra: object = {}) => {
    const rec = { kind, id: made.length, calls: [] as Call[] };
    made.push(rec);
    const log = (name: string) => (...args: unknown[]) => void rec.calls.push([name, ...args]);
    const o: Record<string, unknown> = {
      rec,
      connect: (...a: unknown[]) => void rec.calls.push(['connect', ...a]),
      start: log('start'),
      gain: { setValueAtTime: log('set'), linearRampToValueAtTime: log('ramp') },
      playbackRate: { value: 1 },
      ...extra,
    };
    return o;
  };
  class Ctx {
    destination = dest;
    createBufferSource = () => node('source');
    createGain = () => node('gain');
    createChannelSplitter = () => node('splitter');
    createChannelMerger = () => node('merger');
    decodeAudioData = () => Promise.resolve({ duration: 60 });
    startRendering = () => Promise.resolve({ done: true });
  }
  vi.stubGlobal('OfflineAudioContext', Ctx);
  const points = (n: { calls: Call[] }): Array<[number, number]> => n.calls.filter((c) => c[0] === 'set' || c[0] === 'ramp').map((c) => [c[2] as number, c[1] as number]);
  return { made, dest, points };
}

describe('createAudioMixer wiring', () => {
  it('a neutral project has no pan block and connects the gain to the destination', async () => {
    const s = stubContext();
    const clip = audio();
    const mixer = createAudioMixer(proj([clip]), 12);
    await mixer.renderChunk(0);
    mixer.dispose();
    expect(s.made.filter((n) => n.kind === 'splitter' || n.kind === 'merger')).toHaveLength(0);
    const gains = s.made.filter((n) => n.kind === 'gain');
    expect(gains).toHaveLength(1);
    // no factor at all: the points are exactly the clip's envelope
    const sch = clipSchedule(clip, 0, 12)!;
    const want = sch.gain.map(([t, g]) => [t, g]);
    expect(s.points(gains[0]).map(([t, g]) => [t, g])).toEqual(want);
    expect(gains[0]!.calls.filter((c) => c[0] === 'connect')).toEqual([['connect', s.dest]]);
    vi.unstubAllGlobals();
  });

  it('a fader, a pan and the output level reach the graph', async () => {
    const s = stubContext();
    const clip = audio({ pan: 0.5 });
    const p = proj([clip], { volume: 0.5 }, { volume: 0.8 });
    const mixer = createAudioMixer(p, 12);
    await mixer.renderChunk(0);
    mixer.dispose();
    const sch = clipSchedule(clip, 0, 12)!;
    const gains = s.made.filter((n) => n.kind === 'gain');
    expect(gains).toHaveLength(3);
    expect(s.points(gains[0])).toEqual(scaleGain(sch.gain, 0.5 * 0.8));
    expect(s.made.filter((n) => n.kind === 'splitter')).toHaveLength(1);
    const merger = s.made.filter((n) => n.kind === 'merger');
    expect(merger).toHaveLength(1);
    const pan = panPoints(clip, 0)!;
    [pan.l, pan.r].forEach((side, ch) => {
      const want = trimGainPoints(side, sch.win.localFrom, sch.win.localTo).map(([t, g]) => [sch.when + t, g]);
      expect(s.points(gains[1 + ch])).toEqual(want);
    });
    expect(merger[0]!.calls.filter((c) => c[0] === 'connect')).toEqual([['connect', s.dest]]);
    // the clip's own gain feeds the splitter and not the destination
    expect(gains[0]!.calls.some((c) => c[0] === 'connect' && c[1] === s.dest)).toBe(false);
    vi.unstubAllGlobals();
  });
});
