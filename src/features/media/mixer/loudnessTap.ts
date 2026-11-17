/**
 * the loudness strip's tap: a second output of the preview's output level node. the signal goes through the two k
 * weighting filters into two analysers, and plain into two more (for the true peak). built only while somebody holds
 * it and there is sound to listen to; the preview engine knows nothing about it.
 */
import { kWeighting, truePeakOf } from '../../../lib/loudness';
import type { LoudnessMeter } from '../../../lib/loudness';
import { loudnessDebug } from '../../export/loudnessDebug';
import { audioOut } from '../../preview/meterTaps';

const FFT = 16384;

interface Tap {
  ctx: BaseAudioContext;
  node: AudioNode;
  input: GainNode;
  nodes: AudioNode[];
  kL: AnalyserNode;
  kR: AnalyserNode;
  pL: AnalyserNode;
  pR: AnalyserNode;
}

let holds = 0;
let tap: Tap | null = null;
/** the output a build failed on, so a frame loop does not try again every frame */
let failedOn: AudioNode | null = null;
/** the context time of the last read. null: the next read only sets it */
let last: number | null = null;
const kl = new Float32Array(FFT);
const kr = new Float32Array(FFT);
const pl = new Float32Array(FFT);
const pr = new Float32Array(FFT);

function build(ctx: BaseAudioContext, node: AudioNode): Tap | null {
  const made: AudioNode[] = [];
  const add = <T extends AudioNode>(n: T): T => {
    made.push(n);
    return n;
  };
  try {
    const input = add(ctx.createGain());
    input.channelCount = 2;
    input.channelCountMode = 'explicit';
    input.channelInterpretation = 'speakers';
    const [s1, s2] = kWeighting(ctx.sampleRate);
    const f1 = add(new IIRFilterNode(ctx, { feedforward: [s1.b0, s1.b1, s1.b2], feedback: [1, s1.a1, s1.a2] }));
    const f2 = add(new IIRFilterNode(ctx, { feedforward: [s2.b0, s2.b1, s2.b2], feedback: [1, s2.a1, s2.a2] }));
    const splitK = add(ctx.createChannelSplitter(2));
    const splitP = add(ctx.createChannelSplitter(2));
    const analyser = (): AnalyserNode => {
      const a = add(ctx.createAnalyser());
      a.fftSize = FFT;
      return a;
    };
    const kL = analyser();
    const kR = analyser();
    const pL = analyser();
    const pR = analyser();
    input.connect(f1);
    f1.connect(f2);
    f2.connect(splitK);
    splitK.connect(kL, 0);
    splitK.connect(kR, 1);
    input.connect(splitP);
    splitP.connect(pL, 0);
    splitP.connect(pR, 1);
    node.connect(input);
    loudnessDebug.taps++;
    return { ctx, node, input, nodes: made, kL, kR, pL, pR };
  } catch {
    for (const n of made) {
      try {
        n.disconnect();
      } catch {
        // was not linked
      }
    }
    return null;
  }
}

function drop(): void {
  if (!tap) return;
  try {
    tap.node.disconnect(tap.input);
  } catch {
    // was not linked
  }
  for (const n of tap.nodes) {
    try {
      n.disconnect();
    } catch {
      // already disconnected
    }
  }
  tap = null;
  last = null;
  loudnessDebug.taps--;
}

/** counted: the last release drops the tap. a release twice is safe */
export function holdLoudness(): () => void {
  holds++;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    holds--;
    if (holds === 0) drop();
  };
}

/** the sample rate of the tap, null while nothing is held or the sound is not there yet. builds the tap when it can */
export function loudnessTapRate(): number | null {
  if (holds === 0) return null;
  const out = audioOut();
  if (tap && out && tap.ctx === out.ctx && tap.node === out.node) return tap.ctx.sampleRate;
  drop();
  if (!out) return null;
  if (failedOn === out.node) return null;
  tap = build(out.ctx, out.node);
  failedOn = tap ? null : out.node;
  return tap ? tap.ctx.sampleRate : null;
}

/** the first read after a build or a pause only sets the time */
export function pauseLoudnessRead(): void {
  last = null;
}

/** feeds the frames since the last read to the meter (the newest 16384 at most). false when there is no tap */
export function readLoudness(meter: LoudnessMeter): boolean {
  if (!tap) return false;
  const now = tap.ctx.currentTime;
  const before = last;
  last = now;
  if (before === null) return true;
  const n = Math.min(FFT, Math.round((now - before) * tap.ctx.sampleRate));
  if (n <= 0) return true;
  tap.kL.getFloatTimeDomainData(kl);
  tap.kR.getFloatTimeDomainData(kr);
  tap.pL.getFloatTimeDomainData(pl);
  tap.pR.getFloatTimeDomainData(pr);
  meter.pushWeighted(kl, kr, FFT - n, n);
  meter.notePeak(truePeakOf(pl, FFT - n - 7, FFT - 7));
  meter.notePeak(truePeakOf(pr, FFT - n - 7, FFT - 7));
  loudnessDebug.reads++;
  return true;
}
