/**
 * the advanced choices of an export as the mcp tools take them (export_video's arguments): checked, put over a
 * preset, and turned into a delivery with the notes of what a format left out. pure. the mcp makes the ToolError.
 */
import type { ExportContainer } from './exporter';
import { AUDIO_KBPS_CHOICES, DEFAULT_DELIVERY, KEY_SECONDS_CHOICES, MBPS_MAX, MBPS_MIN, SIZE_MAX, SIZE_MIN, isDefaultDelivery, resolveDelivery } from './delivery';
import type { DeliveryCodec, ExportDelivery } from './delivery';
import { EXPORT_PRESETS, presetChoices } from './presets';
import type { ExportPreset } from './presets';

export interface DeliveryArgs {
  codec?: 'auto' | 'h264' | 'h265' | 'av1' | 'vp9';
  bitrate_mbps?: number;
  key_seconds?: number;
  width?: number;
  height?: number;
  fit?: 'fit' | 'fill';
  audio_codec?: 'auto' | 'aac' | 'opus';
  audio_kbps?: number;
  sample_rate?: number;
  transparent?: boolean;
  preset?: 'youtube-1080' | 'youtube-4k' | 'vimeo' | 'reels' | 'master';
}
export type DeliveryArgsResult = { ok: true; delivery: ExportDelivery | undefined; notes: string[]; preset: ExportPreset | null } | { ok: false; message: string };

const CODEC_OF: Record<NonNullable<DeliveryArgs['codec']>, DeliveryCodec> = { auto: 'auto', h264: 'avc', h265: 'hevc', av1: 'av1', vp9: 'vp9' };

type Name = 'bitrate_mbps' | 'key_seconds' | 'width' | 'height' | 'fit' | 'audio_codec' | 'audio_kbps' | 'sample_rate';

/** the formats an argument means something for */
const APPLIES: Record<Name, readonly ExportContainer[]> = {
  bitrate_mbps: ['mp4', 'webm'],
  key_seconds: ['mp4', 'webm'],
  width: ['mp4', 'webm', 'png', 'jpg'],
  height: ['mp4', 'webm', 'png', 'jpg'],
  fit: ['mp4', 'webm', 'png', 'jpg'],
  audio_codec: ['mp4', 'webm', 'ogg'],
  audio_kbps: ['mp4', 'webm', 'ogg'],
  sample_rate: ['mp4', 'webm', 'ogg', 'wav'],
};
const SOUND_ARGS: readonly Name[] = ['audio_codec', 'audio_kbps', 'sample_rate'];
const ORDER: readonly Name[] = ['bitrate_mbps', 'key_seconds', 'width', 'height', 'fit', 'audio_codec', 'audio_kbps', 'sample_rate'];

/** 'a', 'a and b', 'a, b and c' */
function joined(names: readonly string[]): string {
  return names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

const fail = (message: string): DeliveryArgsResult => ({ ok: false, message });

/**
 * the delivery the arguments ask for in a format: the preset's choices (or all auto) with each given argument over
 * them. `audio` is whether the file gets sound at all. undefined delivery = nothing set (the export as it always was).
 */
export function deliveryFromArgs(container: ExportContainer, args: DeliveryArgs, project: { width: number; height: number; fps: number }, audio: boolean): DeliveryArgsResult {
  // errors, in this order
  if (args.transparent === true && container !== 'webm' && container !== 'png') {
    return fail(container === 'mp4' ? 'transparent needs format webm or png: an mp4 cannot hold a see-through picture' : `transparent needs format webm or png: a ${container} cannot be see-through`);
  }
  if (container === 'webm' && (args.codec === 'h264' || args.codec === 'h265')) return fail(`a webm holds vp9 or av1: codec ${args.codec} needs format mp4`);
  if (args.transparent === true && container === 'webm' && args.codec !== undefined && args.codec !== 'auto' && args.codec !== 'vp9') {
    return fail('a transparent webm is always vp9: leave codec out or give vp9');
  }
  if ((args.width === undefined) !== (args.height === undefined)) return fail('give both width and height, or neither');
  if (args.width !== undefined && args.height !== undefined) {
    const ok = (n: number) => Number.isFinite(n) && n >= SIZE_MIN && n <= SIZE_MAX;
    if (!ok(args.width) || !ok(args.height)) return fail(`width and height are ${SIZE_MIN} to ${SIZE_MAX} pixels`);
  }
  if (args.bitrate_mbps !== undefined && !(Number.isFinite(args.bitrate_mbps) && args.bitrate_mbps >= MBPS_MIN && args.bitrate_mbps <= MBPS_MAX)) return fail('bitrate_mbps is 0.5 to 240');
  if (args.key_seconds !== undefined && !KEY_SECONDS_CHOICES.includes(args.key_seconds)) return fail('key_seconds is one of 0.5, 1, 2, 4, 5, 10');
  if (args.audio_kbps !== undefined && !AUDIO_KBPS_CHOICES.includes(args.audio_kbps)) return fail('audio_kbps is one of 128, 160, 192, 256, 320');
  if (args.sample_rate !== undefined && args.sample_rate !== 44100 && args.sample_rate !== 48000) return fail('sample_rate is 44100 or 48000');
  if (args.audio_codec === 'aac' && (container === 'webm' || container === 'ogg')) return fail(`a ${container} holds opus sound: audio_codec aac needs format mp4`);

  let preset: ExportPreset | null = null;
  if (args.preset !== undefined) {
    preset = EXPORT_PRESETS.find((p) => p.id === args.preset) ?? null;
    if (!preset) return fail(`preset is one of ${EXPORT_PRESETS.slice(5).map((p) => p.id).join(', ')}`);
  }
  // the start: what the preset sets, else everything auto. the given arguments win
  const d: ExportDelivery = preset ? { ...presetChoices(preset, project.fps, project).delivery! } : { ...DEFAULT_DELIVERY };
  if (args.codec !== undefined) d.codec = CODEC_OF[args.codec];
  if (args.bitrate_mbps !== undefined) d.bitrate = Math.round(args.bitrate_mbps * 1e6);
  if (args.key_seconds !== undefined) d.keySeconds = args.key_seconds;
  if (args.width !== undefined && args.height !== undefined) {
    d.size = { width: Math.round(args.width), height: Math.round(args.height), fit: args.fit ?? d.size?.fit ?? 'fit' };
  } else if (args.fit !== undefined && d.size) d.size = { ...d.size, fit: args.fit };
  if (args.audio_codec !== undefined) d.audioCodec = args.audio_codec;
  if (args.audio_kbps !== undefined) d.audioBitrate = args.audio_kbps * 1000;
  if (args.sample_rate !== undefined) d.sampleRate = args.sample_rate;
  if (args.transparent !== undefined) d.transparent = args.transparent;
  // no sound in the file: the sound choices (the preset's too) have nothing to act on
  if (!audio) {
    d.audioCodec = 'auto';
    d.audioBitrate = null;
    d.sampleRate = 48000;
  }

  const notes: string[] = [];
  const given = ORDER.filter((n) => args[n] !== undefined);
  const outside = given.filter((n) => !APPLIES[n].includes(container));
  if (outside.length > 0) notes.push(`${joined(outside)} ${outside.length === 1 ? 'does' : 'do'} not apply to a ${container} and ${outside.length === 1 ? 'was' : 'were'} ignored`);
  const mute = !audio ? given.filter((n) => SOUND_ARGS.includes(n) && APPLIES[n].includes(container)) : [];
  if (mute.length > 0) notes.push(`${joined(mute)} ${mute.length === 1 ? 'was' : 'were'} ignored: the file has no sound`);
  if (preset && container !== 'mp4') notes.push(`the preset is made for mp4, format ${container} was kept and the preset's size and sound were used where they fit`);

  const { notes: resolved, ...fields } = resolveDelivery(container, d);
  notes.push(...resolved);
  return { ok: true, delivery: isDefaultDelivery(fields) ? undefined : fields, notes, preset };
}
