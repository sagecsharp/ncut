/**
 * what this machine can encode, asked of the browser for the advanced part of the export dialog: each video codec
 * for the size, frame rate and bitrate chosen, and the sound codecs, bitrates and rates. every answer that is a no
 * comes with its reason in plain words (delivery.ts TEXT). nothing here is a list of machines: it only asks.
 */
import { QUALITY_MEDIUM, Quality, canEncodeAudio, canEncodeVideo } from 'mediabunny';
import type { AudioCodec } from 'mediabunny';
import { AUDIO_HOLDS, AUDIO_KBPS_CHOICES, CODEC_HOLDS, DELIVERY_LABEL, TEXT, mbpsOf, opusOnly } from './delivery';
import type { VideoCodecChoice } from './delivery';
import { GPU_SETUP_MIN_PIXELS, pickEncoderSetup } from './encoderSetup';
import { videoBitrate } from './exporter';
import type { CanEncodeVideo, ExportQuality } from './exporter';
import { MIX_CHANNELS } from './audioMix';

export type CanEncodeAudio = (codec: AudioCodec, options: NonNullable<Parameters<typeof canEncodeAudio>[1]>) => Promise<boolean>;
export type CodecStatus = { ok: true; bitrate: number; gpu: boolean } | { ok: false; reason: string };
export interface VideoAsk { container: 'mp4' | 'webm'; width: number; height: number; fps: number; quality: ExportQuality; bitrate: number | null; transparent: boolean }

const VIDEO_CHOICES: readonly VideoCodecChoice[] = ['avc', 'hevc', 'av1', 'vp9'];

function abortError(): DOMException {
  return new DOMException('export cancelled', 'AbortError');
}

/** a probe that throws is a no */
async function asks<T extends unknown[]>(can: (...a: T) => Promise<boolean>, ...a: T): Promise<boolean> {
  try {
    return await can(...a);
  } catch {
    return false;
  }
}

/** the codecs of a file, each with a yes (the bitrate it is asked at, and whether the graphics card makes it) or the reason for a no */
export async function probeVideoCodecs(
  ask: VideoAsk,
  o: { only?: VideoCodecChoice; signal?: AbortSignal; can?: CanEncodeVideo } = {},
): Promise<Partial<Record<VideoCodecChoice, CodecStatus>>> {
  const can = o.can ?? canEncodeVideo;
  const out: Partial<Record<VideoCodecChoice, CodecStatus>> = {};
  const { width, height, fps } = ask;
  for (const codec of o.only ? [o.only] : VIDEO_CHOICES) {
    if (o.signal?.aborted) throw abortError();
    const name = DELIVERY_LABEL[codec];
    if (!(CODEC_HOLDS[ask.container] as readonly string[]).includes(codec)) {
      out[codec] = { ok: false, reason: TEXT.webmHolds(name) };
      continue;
    }
    if (ask.transparent && codec !== 'vp9') {
      out[codec] = { ok: false, reason: TEXT.alphaIsVp9Button };
      continue;
    }
    if (typeof VideoEncoder === 'undefined') {
      out[codec] = { ok: false, reason: TEXT.noWebcodecs };
      continue;
    }
    const bitrate = ask.bitrate ?? videoBitrate(width, height, fps, ask.quality, codec);
    const base = { width, height, frameRate: fps, quality: new Quality({ bitrate }) };
    if (await asks(can, codec, base)) {
      let gpu = await asks(can, codec, { ...base, hardwareAcceleration: 'prefer-hardware' as const });
      // the arranged setup (encoderSetup.ts) gets the graphics card for sizes the plain one gives the processor
      if (!gpu && !ask.transparent && width * height > GPU_SETUP_MIN_PIXELS) gpu = (await pickEncoderSetup(codec, width, height, fps, bitrate, can)) !== null;
      out[codec] = { ok: true, bitrate, gpu };
      continue;
    }
    // the first of these that a medium file would not do either is the reason
    if (!(await asks(can, codec, { width: 1280, height: 720, frameRate: 30, quality: new Quality({ bitrate: 2_000_000 }) }))) {
      out[codec] = { ok: false, reason: TEXT.noEncoder(name, codec) };
    } else if (!(await asks(can, codec, { width, height, frameRate: 30, quality: new Quality({ bitrate: videoBitrate(width, height, 30, 'medium', codec) }) }))) {
      out[codec] = { ok: false, reason: TEXT.tooBig(name, width, height) };
    } else if (!(await asks(can, codec, { width, height, frameRate: fps, quality: new Quality({ bitrate: videoBitrate(width, height, fps, 'medium', codec) }) }))) {
      out[codec] = { ok: false, reason: TEXT.tooFast(name, width, height, fps) };
    } else out[codec] = { ok: false, reason: TEXT.tooMuchBitrate(name, mbpsOf(bitrate)) };
  }
  return out;
}

export type AudioStatus = { ok: true } | { ok: false; reason: string };
export interface AudioAsk { container: 'mp4' | 'webm' | 'ogg'; codec: 'aac' | 'opus'; sampleRate: 44100 | 48000 }

/** the sound codecs of a file, the bitrates of the codec asked and the two rates, each a yes or its reason */
export async function probeAudio(
  ask: AudioAsk,
  o: { signal?: AbortSignal; can?: CanEncodeAudio } = {},
): Promise<{ codecs: Record<'aac' | 'opus', AudioStatus>; kbps: Record<number, AudioStatus>; rates: Record<44100 | 48000, AudioStatus> }> {
  const can = o.can ?? canEncodeAudio;
  const check = () => {
    if (o.signal?.aborted) throw abortError();
  };
  const held = AUDIO_HOLDS[ask.container] as readonly string[];
  const codecs = {} as Record<'aac' | 'opus', AudioStatus>;
  for (const codec of ['aac', 'opus'] as const) {
    check();
    if (!held.includes(codec)) {
      codecs[codec] = { ok: false, reason: ask.container === 'webm' ? TEXT.webmAac : TEXT.oggAac };
      continue;
    }
    // opus is always made at 48 khz
    const rate = codec === 'opus' ? 48000 : ask.sampleRate;
    codecs[codec] = (await asks(can, codec, { numberOfChannels: MIX_CHANNELS, sampleRate: rate, quality: QUALITY_MEDIUM })) ? { ok: true } : { ok: false, reason: TEXT.audioNo(codec) };
  }
  const rateOf = opusOnly(ask.container, ask.codec) ? 48000 : ask.sampleRate;
  const kbps: Record<number, AudioStatus> = {};
  let top = 0;
  const failed: number[] = [];
  for (const k of AUDIO_KBPS_CHOICES) {
    check();
    if (await asks(can, ask.codec, { numberOfChannels: MIX_CHANNELS, sampleRate: rateOf, quality: new Quality({ bitrate: k * 1000 }) })) {
      kbps[k] = { ok: true };
      top = Math.max(top, k);
    } else failed.push(k);
  }
  for (const k of failed) kbps[k] = { ok: false, reason: top > 0 && k > top ? TEXT.kbpsMax(ask.codec, top) : TEXT.kbpsNone(ask.codec, k) };
  const rates = {} as Record<44100 | 48000, AudioStatus>;
  for (const rate of [44100, 48000] as const) {
    check();
    if (rate === 44100 && opusOnly(ask.container, ask.codec)) {
      rates[rate] = { ok: false, reason: TEXT.rateOpus };
      continue;
    }
    rates[rate] = (await asks(can, ask.codec, { numberOfChannels: MIX_CHANNELS, sampleRate: rate, quality: QUALITY_MEDIUM })) ? { ok: true } : { ok: false, reason: TEXT.rateNo(ask.codec, rate / 1000) };
  }
  return { codecs, kbps, rates };
}
