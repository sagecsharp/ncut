/**
 * offline audio mix of a project. no react.
 * decodes each asset once, schedules every audible clip on an OfflineAudioContext with a gain
 * envelope (volume + fades) and renders the whole timeline to one stereo buffer.
 */
import type { Clip, Project } from '../../types';
import { isTimedClip } from '../../types';
import { fadeFactor } from '../../lib/timelineOps';
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
    if (!isTimedClip(clip) || clip.muted || clip.volume <= 0 || clip.duration <= 0) continue;
    const track = project.tracks.find((t) => t.id === clip.trackId);
    if (!track || track.muted) continue;
    const asset = project.assets.find((a) => a.id === clip.assetId);
    if (!asset || !asset.hasAudio) continue;
    if (!getAssetBlob(asset.id)) continue;
    out.push(clip);
  }
  return out;
}

/** gain breakpoints (local clip time -> gain) following volume and the fades */
function gainPoints(clip: TimedAudible): Array<[number, number]> {
  const d = clip.duration;
  const times = new Set<number>([0, d]);
  if (clip.fadeIn > 0) times.add(Math.min(clip.fadeIn, d));
  if (clip.fadeOut > 0) times.add(Math.max(0, d - clip.fadeOut));
  if (clip.fadeIn > 0 && clip.fadeOut > 0 && clip.fadeIn + clip.fadeOut > d) {
    times.add((d * clip.fadeIn) / (clip.fadeIn + clip.fadeOut));
  }
  return [...times]
    .sort((a, b) => a - b)
    .map((local) => [local, clip.volume * fadeFactor(clip, clip.start + local)] as [number, number]);
}

export async function renderAudioMix(project: Project, duration: number, signal?: AbortSignal): Promise<AudioMixResult> {
  const warnings: string[] = [];
  const clips = getAudibleClips(project);
  if (clips.length === 0 || duration <= 0) return { buffer: null, warnings };

  const length = Math.max(1, Math.ceil(duration * MIX_SAMPLE_RATE));
  const ctx = new OfflineAudioContext(MIX_CHANNELS, length, MIX_SAMPLE_RATE);

  // decode once per asset
  const decoded = new Map<string, AudioBuffer | null>();
  for (const clip of clips) {
    if (decoded.has(clip.assetId)) continue;
    if (signal?.aborted) throw new DOMException('export cancelled', 'AbortError');
    const blob = getAssetBlob(clip.assetId);
    const asset = project.assets.find((a) => a.id === clip.assetId);
    let buf: AudioBuffer | null = null;
    try {
      if (!blob) throw new Error('missing file');
      const data = await blob.arrayBuffer(); // fresh copy, decodeAudioData detaches it
      buf = await ctx.decodeAudioData(data);
    } catch {
      warnings.push(`could not decode audio of "${asset?.name ?? clip.name}", it is silent in the export`);
    }
    decoded.set(clip.assetId, buf);
  }

  let scheduled = 0;
  for (const clip of clips) {
    const buf = decoded.get(clip.assetId);
    if (!buf) continue;
    const src = ctx.createBufferSource();
    src.buffer = buf;
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
    src.start(clip.start, Math.max(0, clip.trimStart), clip.duration * clip.speed);
    scheduled++;
  }
  if (scheduled === 0) return { buffer: null, warnings };

  if (signal?.aborted) throw new DOMException('export cancelled', 'AbortError');
  const buffer = await ctx.startRendering();
  return { buffer, warnings };
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
