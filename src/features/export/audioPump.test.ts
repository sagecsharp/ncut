import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioBufferSource } from 'mediabunny';
import { sliceAudioBuffer } from './audioMix';
import type { AudioMixer } from './audioMix';
import type { OutputStage } from '../../lib/limiter';
import { createAudioPump } from './audioPump';

/** the parts of an AudioBuffer the pump and sliceAudioBuffer touch */
class FakeBuffer {
  readonly length: number;
  readonly numberOfChannels: number;
  readonly sampleRate: number;
  private readonly data: Float32Array[];
  constructor(o: { length: number; numberOfChannels: number; sampleRate: number }) {
    this.length = o.length;
    this.numberOfChannels = o.numberOfChannels;
    this.sampleRate = o.sampleRate;
    this.data = Array.from({ length: o.numberOfChannels }, () => new Float32Array(o.length));
  }
  getChannelData(ch: number): Float32Array {
    return this.data[ch]!;
  }
  copyToChannel(src: Float32Array, ch: number, at = 0): void {
    this.data[ch]!.set(src, at);
  }
}

beforeEach(() => {
  vi.stubGlobal('AudioBuffer', FakeBuffer);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** a mixer of fake chunks: the left channel counts frames, the right one is its negative */
function fakeMixer(rate: number, sizes: number[]) {
  const chunks: { startFrame: number; frames: number }[] = [];
  let at = 0;
  for (const frames of sizes) {
    chunks.push({ startFrame: at, frames });
    at += frames;
  }
  const rendered: number[] = [];
  const mixer = {
    sampleRate: rate,
    totalFrames: at,
    chunks,
    hasAudio: true,
    renderChunk: async (i: number) => {
      rendered.push(i);
      const c = chunks[i]!;
      const b = new FakeBuffer({ length: c.frames, numberOfChannels: 2, sampleRate: rate });
      for (let k = 0; k < c.frames; k++) {
        b.getChannelData(0)[k] = c.startFrame + k;
        b.getChannelData(1)[k] = -(c.startFrame + k);
      }
      return b as unknown as AudioBuffer;
    },
    dispose: () => {},
  } as AudioMixer;
  return { mixer, rendered };
}

function fakeSource() {
  const added: FakeBuffer[] = [];
  const source = {
    add: async (b: FakeBuffer) => {
      added.push(b);
    },
  } as unknown as AudioBufferSource;
  return { source, added };
}
const sum = (b: FakeBuffer) => ({ length: b.length, rate: b.sampleRate, first: b.getChannelData(0)[0], last: b.getChannelData(0)[b.length - 1], right: b.getChannelData(1)[0] });

/** the pump as it was in exporter.ts before the move, a verbatim copy */
function oldPump(mixer: AudioMixer, source: AudioBufferSource) {
  let pos = 0;
  let idx = 0;
  let cur: AudioBuffer | null = null;
  return {
    position: () => pos,
    async to(untilSeconds: number): Promise<void> {
      const target = Math.min(mixer.totalFrames, Math.ceil(untilSeconds * mixer.sampleRate));
      while (pos < target) {
        const chunk = mixer.chunks[idx];
        if (!chunk) return;
        if (!cur) cur = await mixer.renderChunk(idx);
        const chunkEnd = chunk.startFrame + chunk.frames;
        const end = Math.min(target, chunkEnd, pos + mixer.sampleRate);
        await source.add(sliceAudioBuffer(cur, pos - chunk.startFrame, end - chunk.startFrame));
        pos = end;
        if (pos >= chunkEnd) {
          cur = null;
          idx++;
        }
      }
    },
  };
}

/** a stage that changes nothing and holds `latency` frames back, like the limiter */
function delayStage(latency: number): OutputStage {
  let carryL = new Float32Array(0);
  let carryR = new Float32Array(0);
  const cat = (a: Float32Array, b: Float32Array) => {
    const out = new Float32Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  };
  return {
    latency,
    process(l, r) {
      const al = cat(carryL, l);
      const ar = cat(carryR, r);
      const keep = Math.min(latency, al.length);
      carryL = al.slice(al.length - keep);
      carryR = ar.slice(ar.length - keep);
      return { l: al.slice(0, al.length - keep), r: ar.slice(0, ar.length - keep) };
    },
    flush() {
      const out = { l: carryL, r: carryR };
      carryL = new Float32Array(0);
      carryR = new Float32Array(0);
      return out;
    },
    report: () => ({ limitDb: 0, limitShare: 0, after: null }),
  };
}

describe('createAudioPump', () => {
  it('without a stage it feeds what the old pump fed', async () => {
    const a = fakeMixer(48000, [70000, 30000]);
    const b = fakeMixer(48000, [70000, 30000]);
    const sa = fakeSource();
    const sb = fakeSource();
    const old = oldPump(a.mixer, sa.source);
    const now = createAudioPump(b.mixer, sb.source);
    for (const t of [1, 5, 200]) {
      await old.to(t);
      await now.to(t);
      expect(now.position()).toBe(old.position());
      expect(sb.added.map(sum)).toEqual(sa.added.map(sum));
    }
    expect(b.rendered).toEqual(a.rendered);
    expect(now.position()).toBe(100000);
    expect(now.stageReport()).toBeNull();
  });

  it('a stage reaches totalFrames only after the flush', async () => {
    const { mixer } = fakeMixer(1000, [1500, 1000]);
    const outL: number[] = [];
    const outR: number[] = [];
    const rates: number[] = [];
    const make = (l: Float32Array, r: Float32Array, rate: number): AudioBuffer => {
      outL.push(...l);
      outR.push(...r);
      rates.push(rate);
      return new FakeBuffer({ length: l.length, numberOfChannels: 2, sampleRate: rate }) as unknown as AudioBuffer;
    };
    const pump = createAudioPump(mixer, fakeSource().source, delayStage(3), make);
    await pump.to(1);
    expect(pump.position()).toBeLessThan(2500);
    expect(pump.position()).toBeGreaterThanOrEqual(1000);
    await pump.to(2);
    expect(pump.position()).toBe(2497);
    await pump.to(200);
    expect(pump.position()).toBe(2500);
    expect(outL).toHaveLength(2500);
    expect(outL.every((v, i) => v === i)).toBe(true);
    expect(outR.every((v, i) => v === -i)).toBe(true);
    expect(new Set(rates)).toEqual(new Set([1000]));
    expect(pump.stageReport()).toEqual({ limitDb: 0, limitShare: 0, after: null });
    await pump.to(300);
    expect(pump.position()).toBe(2500);
  });

  it('a sound shorter than the latency comes out whole', async () => {
    const { mixer } = fakeMixer(1000, [2]);
    const got: number[] = [];
    const make = (l: Float32Array): AudioBuffer => {
      got.push(...l);
      return new FakeBuffer({ length: l.length, numberOfChannels: 2, sampleRate: 1000 }) as unknown as AudioBuffer;
    };
    const pump = createAudioPump(mixer, fakeSource().source, delayStage(3), make);
    await pump.to(1);
    expect(pump.position()).toBe(2);
    expect(got).toEqual([0, 1]);
  });
});
