/**
 * feeds the chunks of an audio mixer to an audio source in 1 s slices, in order. `to(seconds)` mixes (one chunk at a
 * time) and adds everything up to that time of the mix. with an output stage (gain and limiter, lib/limiter.ts) the
 * slices go through it first: the stage keeps its state across slices and chunks, drops its latency at the start and
 * flushes the tail at the end, so the file has exactly the frames of the mix. without one it is the plain pump.
 */
import type { AudioBufferSource } from 'mediabunny';
import type { OutputStage, StageReport } from '../../lib/limiter';
import { sliceAudioBuffer } from './audioMix';
import type { AudioMixer } from './audioMix';

export interface AudioPump {
  /** frames handed to the source so far */
  position(): number;
  to(untilSeconds: number): Promise<void>;
  /** what the stage did, null without a stage */
  stageReport(): StageReport | null;
}

type MakeBuffer = (l: Float32Array, r: Float32Array, rate: number) => AudioBuffer;

function webAudioBuffer(l: Float32Array, r: Float32Array, rate: number): AudioBuffer {
  const out = new AudioBuffer({ numberOfChannels: 2, length: l.length, sampleRate: rate });
  out.copyToChannel(l as Float32Array<ArrayBuffer>, 0);
  out.copyToChannel(r as Float32Array<ArrayBuffer>, 1);
  return out;
}

export function createAudioPump(mixer: AudioMixer, source: AudioBufferSource, stage: OutputStage | null = null, makeBuffer: MakeBuffer = webAudioBuffer): AudioPump {
  if (!stage) {
    let pos = 0;
    let idx = 0;
    let cur: AudioBuffer | null = null;
    return {
      /** frames fed so far */
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
      stageReport: () => null,
    };
  }
  const rate = mixer.sampleRate;
  let outPos = 0;
  let inPos = 0;
  let idx = 0;
  let cur: AudioBuffer | null = null;
  let flushed = false;
  const add = async (w: { l: Float32Array; r: Float32Array }): Promise<void> => {
    if (w.l.length === 0) return;
    await source.add(makeBuffer(w.l, w.r, rate));
    outPos += w.l.length;
  };
  return {
    position: () => outPos,
    async to(untilSeconds: number): Promise<void> {
      const target = Math.min(mixer.totalFrames, Math.ceil(untilSeconds * rate));
      while (outPos < target) {
        const chunk = mixer.chunks[idx];
        if (inPos >= mixer.totalFrames || !chunk) {
          if (flushed) return;
          flushed = true;
          await add(stage.flush());
          continue;
        }
        if (!cur) cur = await mixer.renderChunk(idx);
        const chunkEnd = chunk.startFrame + chunk.frames;
        const end = Math.min(chunkEnd, inPos + rate);
        const off = inPos - chunk.startFrame;
        const len = end - inPos;
        await add(stage.process(cur.getChannelData(0).subarray(off, off + len), cur.getChannelData(1).subarray(off, off + len)));
        inPos = end;
        if (inPos >= chunkEnd) {
          cur = null;
          idx++;
        }
      }
    },
    stageReport: () => stage.report(),
  };
}
