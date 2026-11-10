/**
 * offline audio mix of a project. no react.
 * decodes only the used range of each clip (streaming), schedules the audible clips on an OfflineAudioContext with a gain
 * envelope (volume + fades) and renders the timeline to stereo in chunks of MIX_CHUNK_SECONDS (flat memory).
 */
import { ALL_FORMATS, AudioBufferSink, BlobSource, Input } from 'mediabunny';
import type { InputAudioTrack } from 'mediabunny';
import type { Clip, Project } from '../../types';
import { isTimedClip } from '../../types';
import { fadeFactor } from '../../lib/timelineOps';
import { isAnimated, keyTimes, valueAt } from '../../lib/anim';
import { getAssetBlob } from '../../media/registry';

export const MIX_SAMPLE_RATE = 48000;
export const MIX_CHANNELS = 2;

type TimedAudible = Extract<Clip, { type: 'video' | 'audio' }>;

/** clips that contribute sound: audio clips and video clips with an audio track, not muted */
export function getAudibleClips(project: Project): TimedAudible[] {
  const out: TimedAudible[] = [];
  for (const clip of project.clips) {
    if (!isTimedClip(clip) || clip.muted || clip.duration <= 0) continue;
    if (clip.volume <= 0 && !isAnimated(clip, 'volume')) continue;
    const track = project.tracks.find((t) => t.id === clip.trackId);
    if (!track || track.muted) continue;
    const asset = project.assets.find((a) => a.id === clip.assetId);
    if (!asset || !asset.hasAudio) continue;
    if (!getAssetBlob(asset.id)) continue;
    out.push(clip);
  }
  return out;
}

/** spacing of the gain samples (clip time) when the volume is animated */
const GAIN_STEP = 0.01;
/** a hold key jumps: sample this close on both sides of a key so the step stays sharp */
const KEY_SNAP = 0.0005;

/** gain breakpoints (local clip time -> gain) following volume and the fades */
function gainPoints(clip: TimedAudible): Array<[number, number]> {
  const d = clip.duration;
  const times = new Set<number>([0, d]);
  if (clip.fadeIn > 0) times.add(Math.min(clip.fadeIn, d));
  if (clip.fadeOut > 0) times.add(Math.max(0, d - clip.fadeOut));
  if (clip.fadeIn > 0 && clip.fadeOut > 0 && clip.fadeIn + clip.fadeOut > d) {
    times.add((d * clip.fadeIn) / (clip.fadeIn + clip.fadeOut));
  }
  const animated = isAnimated(clip, 'volume');
  if (animated) {
    // exact key times, just around them (steps / bounces), and a regular grid in between
    for (const k of keyTimes(clip.keyframes, 'volume')) {
      if (k <= 0 || k >= d) continue;
      times.add(k);
      times.add(Math.max(0, k - KEY_SNAP));
      times.add(Math.min(d, k + KEY_SNAP));
    }
    const n = Math.ceil(d / GAIN_STEP);
    for (let i = 1; i < n; i++) times.add((d * i) / n);
  }
  return [...times]
    .sort((a, b) => a - b)
    .map((local) => {
      const vol = animated ? Math.max(0, valueAt(clip, 'volume', clip.start + local) ?? clip.volume) : clip.volume;
      return [local, vol * fadeFactor(clip, clip.start + local)] as [number, number];
    });
}

/** where a clip lands in a mix that covers [offset, offset + length) of the timeline */
export interface ClipWindow {
  /** seconds from the start of the mix when the clip's first audible sample plays */
  when: number;
  /** clip-local seconds (timeline time) cut off the head of the clip because the mix starts later */
  localFrom: number;
  /** clip-local seconds where the mix ends (or the clip ends) */
  localTo: number;
  /** source seconds to skip at the head of the used range, and source seconds to play */
  skip: number;
  span: number;
}

/** null when the clip is entirely outside the window */
export function clipWindow(clipStart: number, clipDuration: number, speed: number, offset: number, length: number): ClipWindow | null {
  const from = Math.max(clipStart, offset);
  const to = Math.min(clipStart + clipDuration, offset + length);
  if (to - from <= 1e-9) return null;
  const localFrom = from - clipStart;
  const localTo = to - clipStart;
  return { when: from - offset, localFrom, localTo, skip: localFrom * speed, span: (localTo - localFrom) * speed };
}

/**
 * keep the part of a gain envelope inside [from, to] (clip-local seconds) and re-base it to 0. the new ends are
 * interpolated like a linear ramp would, so cutting the head or tail does not change the sound that is left.
 */
export function trimGainPoints(pts: ReadonlyArray<[number, number]>, from: number, to: number): Array<[number, number]> {
  if (pts.length === 0 || to <= from) return [];
  const at = (t: number): number => {
    if (t <= pts[0]![0]) return pts[0]![1];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]!;
      const b = pts[i]!;
      if (t <= b[0]) {
        // two points at one time are a step: take the value after it
        if (b[0] - a[0] <= 1e-12) return b[1];
        return a[1] + ((b[1] - a[1]) * (t - a[0])) / (b[0] - a[0]);
      }
    }
    return pts[pts.length - 1]![1];
  };
  const out: Array<[number, number]> = [[0, at(from)]];
  for (const [t, g] of pts) {
    if (t > from + 1e-9 && t < to - 1e-9) out.push([t - from, g]);
  }
  out.push([to - from, at(to)]);
  return out;
}

const FALLBACK_MAX_BYTES = 200 * 1024 * 1024;

function abortError(): DOMException {
  return new DOMException('export cancelled', 'AbortError');
}

/** decode only the source range a clip uses (streaming, via mediabunny). null when the track cannot be decoded. */
async function decodeClipRange(
  ctx: OfflineAudioContext,
  track: InputAudioTrack,
  from: number,
  to: number,
  signal?: AbortSignal,
): Promise<AudioBuffer | null> {
  const rate = track.sampleRate;
  const channels = Math.max(1, Math.min(track.numberOfChannels, 8));
  const length = Math.max(1, Math.ceil((to - from) * rate) + 1);
  const out = ctx.createBuffer(channels, length, rate);
  const sink = new AudioBufferSink(track);
  for await (const wrapped of sink.buffers(from, to)) {
    if (signal?.aborted) throw abortError();
    const buf = wrapped.buffer;
    let offset = Math.round((wrapped.timestamp - from) * rate);
    let skip = 0;
    if (offset < 0) {
      skip = -offset;
      offset = 0;
    }
    const n = Math.min(buf.length - skip, length - offset);
    if (n <= 0) continue;
    for (let ch = 0; ch < channels; ch++) {
      const data = buf.getChannelData(Math.min(ch, buf.numberOfChannels - 1));
      out.copyToChannel(data.subarray(skip, skip + n), ch, offset);
    }
  }
  return out;
}

/** seconds of sound mixed in one offline context. 30 s of stereo float32 at 48 khz is 11.5 mb, however long the project is. */
export const MIX_CHUNK_SECONDS = 30;

/** a piece of the mix: frames [startFrame, startFrame + frames) of the whole range */
export interface MixChunk {
  startFrame: number;
  frames: number;
}

/** cut `totalFrames` into pieces of at most `chunkFrames` (the last one is the rest). pure. */
export function planMixChunks(totalFrames: number, chunkFrames: number): MixChunk[] {
  const out: MixChunk[] = [];
  const size = Math.max(1, Math.floor(chunkFrames));
  for (let at = 0; at < totalFrames; at += size) out.push({ startFrame: at, frames: Math.min(size, totalFrames - at) });
  return out;
}

export interface AudioMixer {
  /** frames of the whole mix (MIX_SAMPLE_RATE) */
  totalFrames: number;
  chunks: MixChunk[];
  /** false = no audible clip touches the range, there is nothing to mix */
  hasAudio: boolean;
  /**
   * mix one chunk (call them in order). never rejects except for a cancel: when the browser cannot mix, the chunk is
   * silent and `onWarning` says so once, so the file keeps its length and the video still exports.
   */
  renderChunk(index: number): Promise<AudioBuffer>;
  /** close the decoders. call once when done (also after a failure or cancel). */
  dispose(): void;
}

function silence(frames: number): AudioBuffer {
  return new AudioBuffer({ length: Math.max(1, frames), numberOfChannels: MIX_CHANNELS, sampleRate: MIX_SAMPLE_RATE });
}

/**
 * a mixer for `duration` seconds of the timeline starting at `offset` (an export range). the mix is rendered in
 * chunks (MIX_CHUNK_SECONDS each), every chunk in its own OfflineAudioContext that only schedules the clips touching
 * it, so memory stays flat for a 90 minute project. chunk 0 starts at the timeline's `offset`.
 */
export function createAudioMixer(
  project: Project,
  duration: number,
  signal?: AbortSignal,
  onWarning?: (message: string) => void,
  offset = 0,
): AudioMixer {
  const clips = duration > 0 ? getAudibleClips(project) : [];
  const totalFrames = Math.max(1, Math.ceil(duration * MIX_SAMPLE_RATE));
  const chunks = planMixChunks(totalFrames, MIX_CHUNK_SECONDS * MIX_SAMPLE_RATE);
  const hasAudio = clips.some((c) => clipWindow(c.start, c.duration, c.speed, offset, duration) !== null);

  const inputs = new Map<string, Input>();
  const tracks = new Map<string, InputAudioTrack | null>();
  const fallback = new Map<string, AudioBuffer | null>();
  const warned = new Set<string>();
  let mixFailed = false;
  const warn = (assetId: string, fallbackName: string) => {
    if (warned.has(assetId)) return;
    warned.add(assetId);
    const asset = project.assets.find((a) => a.id === assetId);
    onWarning?.(`could not decode audio of "${asset?.name ?? fallbackName}", it is silent in the export`);
  };

  const mixChunk = async (chunk: MixChunk): Promise<AudioBuffer | null> => {
    const chunkOffset = offset + chunk.startFrame / MIX_SAMPLE_RATE;
    const chunkLength = chunk.frames / MIX_SAMPLE_RATE;
    const here = clips.filter((c) => clipWindow(c.start, c.duration, c.speed, chunkOffset, chunkLength) !== null);
    if (here.length === 0) return null;
    const ctx = new OfflineAudioContext(MIX_CHANNELS, chunk.frames, MIX_SAMPLE_RATE);
    let scheduled = 0;
    for (const clip of here) {
      if (signal?.aborted) throw abortError();
      const blob = getAssetBlob(clip.assetId);
      if (!blob) {
        warn(clip.assetId, clip.name);
        continue;
      }
      const win = clipWindow(clip.start, clip.duration, clip.speed, chunkOffset, chunkLength)!;
      // the part of the source this clip plays inside the chunk
      const from = Math.max(0, clip.trimStart) + win.skip;
      const span = win.span;

      // streaming path: decode just the used range
      if (!tracks.has(clip.assetId)) {
        let track: InputAudioTrack | null = null;
        try {
          const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
          inputs.set(clip.assetId, input);
          const t = await input.getPrimaryAudioTrack();
          if (t && (await t.canDecode())) track = t;
        } catch {
          track = null;
        }
        tracks.set(clip.assetId, track);
      }
      const track = tracks.get(clip.assetId) ?? null;
      let buf: AudioBuffer | null = null;
      let bufferOffset = 0;
      if (track) {
        try {
          buf = await decodeClipRange(ctx, track, from, from + span, signal);
        } catch (e) {
          if (e instanceof DOMException && e.name === 'AbortError') throw e;
          buf = null;
        }
      } else {
        // whole-file fallback, only for files that are not huge
        if (!fallback.has(clip.assetId)) {
          let whole: AudioBuffer | null = null;
          try {
            if (blob.size > FALLBACK_MAX_BYTES) throw new Error('too large');
            whole = await ctx.decodeAudioData(await blob.arrayBuffer());
          } catch {
            whole = null;
          }
          fallback.set(clip.assetId, whole);
        }
        buf = fallback.get(clip.assetId) ?? null;
        bufferOffset = from;
      }
      if (!buf) {
        warn(clip.assetId, clip.name);
        continue;
      }

      const src = ctx.createBufferSource();
      src.buffer = buf;
      // pitch follows speed here (resampling), same as no time-stretch
      src.playbackRate.value = clip.speed;
      const gain = ctx.createGain();
      const pts = trimGainPoints(gainPoints(clip), win.localFrom, win.localTo);
      const first = pts[0]!;
      gain.gain.setValueAtTime(first[1], win.when + first[0]);
      for (let i = 1; i < pts.length; i++) {
        const p = pts[i]!;
        gain.gain.linearRampToValueAtTime(p[1], win.when + p[0]);
      }
      src.connect(gain);
      gain.connect(ctx.destination);
      src.start(win.when, bufferOffset, span);
      scheduled++;
    }
    if (scheduled === 0) return null;
    if (signal?.aborted) throw abortError();
    return ctx.startRendering();
  };

  return {
    totalFrames,
    chunks,
    hasAudio,
    async renderChunk(index: number): Promise<AudioBuffer> {
      const chunk = chunks[index]!;
      if (signal?.aborted) throw abortError();
      if (!mixFailed) {
        try {
          return (await mixChunk(chunk)) ?? silence(chunk.frames);
        } catch (e) {
          if (e instanceof DOMException && e.name === 'AbortError') throw e;
          if (signal?.aborted) throw abortError();
          // a context the browser refuses (memory) or a broken decoder: carry on without sound
          mixFailed = true;
          onWarning?.('the sound could not be mixed, exporting without sound');
        }
      }
      return silence(chunk.frames);
    },
    dispose() {
      for (const input of inputs.values()) {
        try {
          input.dispose();
        } catch {
          // ignore
        }
      }
      inputs.clear();
    },
  };
}

/** copy a time slice of a buffer into a new buffer (so it can be encoded in pieces) */
export function sliceAudioBuffer(buffer: AudioBuffer, startFrame: number, endFrame: number): AudioBuffer {
  const len = Math.max(1, Math.min(buffer.length, endFrame) - startFrame);
  const out = new AudioBuffer({ length: len, numberOfChannels: buffer.numberOfChannels, sampleRate: buffer.sampleRate });
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    out.copyToChannel(buffer.getChannelData(ch).subarray(startFrame, startFrame + len), ch, 0);
  }
  return out;
}
