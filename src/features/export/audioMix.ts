/**
 * offline audio mix of a project. no react.
 * decodes only the used range of each clip (streaming), schedules every audible clip on an OfflineAudioContext with a gain
 * envelope (volume + fades) and renders the whole timeline to one stereo buffer.
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

export interface AudioMixResult {
  /** null when nothing is audible */
  buffer: AudioBuffer | null;
  warnings: string[];
}

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

export async function renderAudioMix(
  project: Project,
  duration: number,
  signal?: AbortSignal,
  onProgress?: (fraction: number) => void,
): Promise<AudioMixResult> {
  const warnings: string[] = [];
  const clips = getAudibleClips(project);
  if (clips.length === 0 || duration <= 0) return { buffer: null, warnings };

  const length = Math.max(1, Math.ceil(duration * MIX_SAMPLE_RATE));
  const ctx = new OfflineAudioContext(MIX_CHANNELS, length, MIX_SAMPLE_RATE);

  const inputs = new Map<string, Input>();
  const tracks = new Map<string, InputAudioTrack | null>();
  const fallback = new Map<string, AudioBuffer | null>();
  const warned = new Set<string>();
  const warn = (assetId: string, fallbackName: string) => {
    if (warned.has(assetId)) return;
    warned.add(assetId);
    const asset = project.assets.find((a) => a.id === assetId);
    warnings.push(`could not decode audio of "${asset?.name ?? fallbackName}", it is silent in the export`);
  };

  try {
    let scheduled = 0;
    for (let ci = 0; ci < clips.length; ci++) {
      const clip = clips[ci]!;
      if (signal?.aborted) throw abortError();
      const blob = getAssetBlob(clip.assetId);
      if (!blob) {
        warn(clip.assetId, clip.name);
        continue;
      }
      const from = Math.max(0, clip.trimStart);
      const span = clip.duration * clip.speed;

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
      let offset = 0;
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
        offset = from;
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
      const pts = gainPoints(clip);
      const first = pts[0]!;
      gain.gain.setValueAtTime(first[1], clip.start + first[0]);
      for (let i = 1; i < pts.length; i++) {
        const p = pts[i]!;
        gain.gain.linearRampToValueAtTime(p[1], clip.start + p[0]);
      }
      src.connect(gain);
      gain.connect(ctx.destination);
      src.start(clip.start, offset, span);
      scheduled++;
      onProgress?.((ci + 1) / clips.length);
    }
    if (scheduled === 0) return { buffer: null, warnings };

    if (signal?.aborted) throw abortError();
    const buffer = await ctx.startRendering();
    return { buffer, warnings };
  } finally {
    for (const input of inputs.values()) {
      try {
        input.dispose();
      } catch {
        // ignore
      }
    }
  }
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
