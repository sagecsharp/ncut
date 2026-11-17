/**
 * the advanced choices of an export (codec, bitrate, key frames, size, sound, see-through) as one object, and what they
 * mean for each format. pure: the types come from exporter.ts, nothing else is imported, so exporter.ts can import this.
 * a missing delivery is DEFAULT_DELIVERY = what an export always did.
 */
import type { ExportContainer } from './exporter';
import type { FitMode } from './frameFit';

export type DeliveryCodec = 'auto' | 'avc' | 'hevc' | 'av1' | 'vp9';
export type VideoCodecChoice = Exclude<DeliveryCodec, 'auto'>;
export type DeliveryAudioCodec = 'auto' | 'aac' | 'opus';
export interface DeliverySize { width: number; height: number; fit: FitMode }
export interface ExportDelivery {
  codec: DeliveryCodec; // 'auto' = VIDEO_CODECS order
  bitrate: number | null; // whole bps. null = videoBitrate of the quality
  keySeconds: number | null; // null = KEYFRAME_SECONDS
  size: DeliverySize | null; // null = project size x scale
  audioCodec: DeliveryAudioCodec;
  audioBitrate: number | null; // bps. null = QUALITY_MEDIUM
  sampleRate: 44100 | 48000;
  transparent: boolean; // webm and png only
}
export const DEFAULT_DELIVERY: Readonly<ExportDelivery> = { codec: 'auto', bitrate: null, keySeconds: null, size: null, audioCodec: 'auto', audioBitrate: null, sampleRate: 48000, transparent: false };
export const KEY_SECONDS_CHOICES: readonly number[] = [0.5, 1, 2, 4, 5, 10]; // 2 is stored as null
export const AUDIO_KBPS_CHOICES: readonly number[] = [128, 160, 192, 256, 320];
export const MBPS_MIN = 0.5, MBPS_MAX = 240, SIZE_MIN = 16, SIZE_MAX = 8192;
export const DELIVERY_LABEL: Record<VideoCodecChoice, string> = { avc: 'h.264', hevc: 'h.265', av1: 'av1', vp9: 'vp9' }; // = CODEC_LABEL, tested

/** what each format can hold */
export const CODEC_HOLDS = { mp4: ['avc', 'hevc', 'av1', 'vp9'], webm: ['vp9', 'av1'] } as const;
export const AUDIO_HOLDS = { mp4: ['aac', 'opus'], webm: ['opus'], ogg: ['opus'] } as const;

/** the same wording the export dialog always had for a bitrate */
export function formatBitrate(bps: number): string {
  return bps >= 1e6 ? `${(bps / 1e6).toFixed(bps >= 1e7 ? 0 : 1)} mbps` : `${Math.round(bps / 1e3)} kbps`;
}

/** megabits per second as the texts say them: one decimal */
export function mbpsOf(bps: number): number {
  return Math.round(bps / 1e5) / 10;
}

/** a video side is even, at least 2 (the exporter's own rule) */
export function evenSide(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2);
}

export function canBeTransparent(c: ExportContainer): boolean {
  return c === 'webm' || c === 'png';
}

/** opus is the only sound there: webm, ogg, or opus asked for */
export function opusOnly(c: ExportContainer, a: DeliveryAudioCodec): boolean {
  return c === 'webm' || c === 'ogg' || a === 'opus';
}

const isVideoFile = (c: ExportContainer): c is 'mp4' | 'webm' => c === 'mp4' || c === 'webm';
const isPictureFile = (c: ExportContainer): boolean => c === 'png' || c === 'jpg';
const hasSound = (c: ExportContainer): boolean => c === 'mp4' || c === 'webm' || c === 'wav' || c === 'ogg';

// ---- the texts (the ui, the export warnings and the mcp say these) ----

const label = (c: VideoCodecChoice): string => DELIVERY_LABEL[c];

export const TEXT = {
  // what a format does to a choice (resolveDelivery notes)
  transparentMp4: 'an mp4 cannot be see-through, the file has its background',
  transparentJpg: 'a jpg cannot be see-through, the picture has its background',
  alphaIsVp9: 'a see-through webm is always vp9, so vp9 is used',
  webmAuto: (name: string): string => `a webm file cannot hold ${name}, so auto picks the codec`,
  webmOpus: 'a webm file holds opus sound, so auto picks opus',
  oggOpus: 'an ogg file holds opus sound, so auto picks opus',
  opusRate: 'opus sound is always 48 khz, so 48 khz is used',
  // why a video codec is greyed
  webmHolds: (name: string): string => `a webm file holds vp9 or av1. pick mp4 for ${name}`,
  alphaIsVp9Button: 'a see-through file is always vp9',
  noWebcodecs: 'this browser cannot encode video, try a recent chrome or edge',
  noEncoder: (name: string, codec: VideoCodecChoice): string => `this machine has no ${name} encoder${codec === 'hevc' ? ': h.265 needs a graphics card that encodes it' : ''}`,
  tooBig: (name: string, w: number, h: number): string => `${name} cannot be encoded at ${w}x${h} here: try a smaller size`,
  tooFast: (name: string, w: number, h: number, fps: number): string => `${name} cannot be encoded at ${w}x${h} and ${fps} fps here: try a lower frame rate`,
  tooMuchBitrate: (name: string, mbps: number): string => `${name} cannot be encoded at ${mbps} mbps here: try a lower bitrate`,
  // why a sound choice is greyed
  webmAac: 'a webm file holds opus sound. pick mp4 for aac',
  oggAac: 'an ogg file holds opus. pick mp4 for aac',
  audioNo: (name: string): string => `this machine cannot encode ${name} sound`,
  kbpsMax: (name: string, max: number): string => `this machine encodes ${name} at up to ${max} kbps`,
  kbpsNone: (name: string, k: number): string => `this machine cannot encode ${name} at ${k} kbps`,
  rateNo: (name: string, khz: number): string => `this machine cannot encode ${name} at ${khz} khz`,
  rateOpus: 'opus sound is always 48 khz',
  audioOff: 'include audio is off',
  // what breaks a see-through file
  sky: 'the sky fills the whole picture, so nothing is see-through. remove the sky in the project panel to export see-through',
  effect: (name: string, a: number, b: number): string => `the effect "${name}" works on the whole picture: from ${a} s to ${b} s nothing is see-through and empty parts turn black`,
  blend: (name: string, blend: string): string => `"${name}" uses the ${blend} blend: where nothing is under it, it is drawn as normal, and the blend is not in the file`,
  alphaLost: 'the file came out without its see-through part: this browser dropped the alpha',
  // the export
  noPlan: (name: string, w: number, h: number, fps: number, bitrate: number | null): string =>
    `this browser cannot encode ${name} at ${w}x${h} and ${fps} fps${bitrate ? ` at ${mbpsOf(bitrate)} mbps` : ''}, pick another codec, a lower frame rate, a smaller size or a lower bitrate`,
  audioFallback: (name: string, kbps: number, khz: number, name2: string): string => `${name} at ${kbps} kbps and ${khz} khz cannot be encoded here, the file has ${name2} at the standard rate`,
  // the dialog
  advanced: 'advanced',
  advancedDoes: 'codec, bitrate, key frames, size, see-through and sound',
  advancedGif: 'a gif has its own size and frame rate, nothing advanced applies',
  changed: (n: number): string => ` (${n} changed)`,
  backToAuto: 'back to auto',
  backToAutoDoes: 'every advanced choice back to auto, the file the export always made',
  checking: 'checking the encoders of this machine...',
  autoPicks: (name: string, where: string): string => `auto picks ${name} here, ${where}`,
  codecWhere: (name: string, where: string): string => `${name}, ${where}`,
  onGpu: 'on the graphics card',
  onCpu: 'on the processor: slower to make',
  codecAuto: 'the first codec this machine can encode for this file.',
  codecAvc: 'plays everywhere, the safe choice for uploads.',
  codecHevc: 'the same look in about three quarters of the size. not every player opens it.',
  codecAv1: 'the smallest files, newer players only. slow without a graphics card that encodes it.',
  codecVp9: 'small files that play in browsers. a see-through webm always uses it.',
  madeOnGpu: ' made on the graphics card',
  madeOnCpu: ' made on the processor',
  bitrateDoes: 'from quality: the quality choice sets it for the size, frame rate and codec. custom: the megabits per second you set',
  bitrateFromQuality: (planned: string): string => `from quality (${planned})`,
  bitrateTitle: 'megabits per second of picture. 8 to 16 is plenty for 1080p, 35 to 70 for 4k',
  intervalDoes: 'how often the file holds a whole picture (a key frame of the video, not a keyframe of an animation). more often: quicker seeking and cutting in other editors, a bigger file',
  intervalAuto: 'auto (every 2 s)',
  intervalChoice: (s: number): string => `every ${s} s`,
  sizeWidthTitle: 'width of the file in pixels',
  sizeHeightTitle: 'height of the file in pixels',
  sizeEvenTitle: '. a video needs even numbers, odd ones are rounded',
  fitFit: 'fit to the size: the whole picture, with bars',
  fitFill: 'fill the size: no bars, the edges are cut',
  fitDoes: 'fit shows the whole picture with bars in the background color. fill covers the whole file and cuts the edges, it draws the picture bigger first',
  fitNote: (pw: number, ph: number, bars: 'above and below' | 'at the sides', transparent: boolean): string => `the project is ${pw}x${ph}: bars ${bars}${transparent ? ', see-through' : ''}`,
  fillNote: (pw: number, ph: number, cut: 'sides are' | 'top and bottom are'): string => `the project is ${pw}x${ph}: the ${cut} cut`,
  roundedNote: (w: number, h: number): string => `the file is ${w}x${h}`,
  transparentLabel: 'see-through background',
  transparentDoes: 'no background: the file is see-through (transparent) where nothing is drawn. webm is made as vp9 with alpha, png keeps alpha',
  transparentOffMp4: 'an mp4 cannot hold a see-through picture: pick webm or png',
  transparentOffJpg: 'a jpg cannot be see-through: pick png',
  transparentInfo: 'the background color is left out. browsers and most editors show the see-through part, some players show black instead',
  audioAutoDoes: (mp4: boolean): string => `the usual sound of this format: ${mp4 ? 'aac' : 'opus'}`,
  audioAacDoes: 'plays everywhere, the usual sound of an mp4',
  audioOpusDoes: 'better sound for its size. some players do not open it inside an mp4',
  kbpsAutoDoes: 'the standard rate: aac 128 kbps, opus 69 kbps',
  kbpsDoes: (k: number): string => `${k} kbps of sound`,
  rate48Does: 'the video standard, the default',
  rate44Does: 'the cd and music standard',
  summary: (name: string, transparent: boolean, bps: number, bytes: string): string => `codec ${name}${transparent ? ', see-through' : ''}, about ${formatBitrate(bps)}, file about ${bytes}`,
  summaryWav: (khz: number, size: string): string => `uncompressed 16 bit stereo, ${khz} khz, about ${size}`,
  summaryOgg: (size: string): string => `opus sound in an ogg file, about ${size}`,
  sizeDoes: (video: string, alpha: string | null, audio: string | null): string =>
    `picture ${video}${alpha ? `, see-through part about ${alpha}` : ''}${audio ? `, sound ${audio}` : ''}. the bitrate times the length: a still or simple picture often comes out smaller`,
  presetUnknown: (id: string): string => `no preset called ${id}`,
};

// ---- resolve ----

export interface ResolvedDelivery extends ExportDelivery { notes: string[] }

/**
 * what a delivery means for a format: the fields that do not apply are put back to their defaults, a choice the
 * format cannot hold is put back to auto with a note (a quiet drop where it can never have been meant).
 */
export function resolveDelivery(container: ExportContainer, d: ExportDelivery | undefined): ResolvedDelivery {
  if (!d || container === 'gif') return { ...DEFAULT_DELIVERY, notes: [] };
  const notes: string[] = [];
  // 2. see-through
  const transparent = d.transparent && canBeTransparent(container);
  if (d.transparent && !transparent) {
    if (container === 'mp4') notes.push(TEXT.transparentMp4);
    else if (container === 'jpg') notes.push(TEXT.transparentJpg);
  }
  // 3. the video codec
  let codec: DeliveryCodec = 'auto';
  if (isVideoFile(container)) {
    if (transparent && container === 'webm') {
      codec = 'vp9';
      if (d.codec !== 'auto' && d.codec !== 'vp9') notes.push(TEXT.alphaIsVp9);
    } else if (d.codec !== 'auto' && !(CODEC_HOLDS[container] as readonly string[]).includes(d.codec)) {
      notes.push(TEXT.webmAuto(label(d.codec)));
    } else codec = d.codec;
  }
  // 4. bitrate and key frames
  const video = isVideoFile(container);
  const bitrate = video ? d.bitrate : null;
  const keySeconds = video && d.keySeconds !== 2 ? d.keySeconds : null;
  // 5. size
  const size = video || isPictureFile(container) ? (d.size ? { ...d.size } : null) : null;
  // 6. the sound codec
  let audioCodec: DeliveryAudioCodec = 'auto';
  if (container === 'mp4') audioCodec = d.audioCodec;
  else if (container === 'webm' || container === 'ogg') {
    if (d.audioCodec === 'aac') notes.push(container === 'webm' ? TEXT.webmOpus : TEXT.oggOpus);
    else audioCodec = d.audioCodec;
  }
  // 7. sound bitrate and rate
  const audioBitrate = container === 'mp4' || container === 'webm' || container === 'ogg' ? d.audioBitrate : null;
  let sampleRate: 44100 | 48000 = hasSound(container) ? d.sampleRate : 48000;
  if (sampleRate === 44100 && opusOnly(container, audioCodec)) {
    sampleRate = 48000;
    notes.push(TEXT.opusRate);
  }
  return { codec, bitrate, keySeconds, size, audioCodec, audioBitrate, sampleRate, transparent, notes };
}

/** the size of the file: the project size x scale (base) unless a size is set. a video rounds each side to even, a picture keeps it */
export function deliverySize(base: { width: number; height: number }, container: ExportContainer, d: ResolvedDelivery): { width: number; height: number } {
  if (!d.size) return base;
  if (isPictureFile(container)) return { width: d.size.width, height: d.size.height };
  if (isVideoFile(container)) return { width: evenSide(d.size.width), height: evenSide(d.size.height) };
  return base;
}

export function sameDelivery(a: ExportDelivery, b: ExportDelivery): boolean {
  const sa = a.size;
  const sb = b.size;
  const sameSize = sa === sb || (!!sa && !!sb && sa.width === sb.width && sa.height === sb.height && sa.fit === sb.fit);
  return (
    a.codec === b.codec &&
    a.bitrate === b.bitrate &&
    a.keySeconds === b.keySeconds &&
    sameSize &&
    a.audioCodec === b.audioCodec &&
    a.audioBitrate === b.audioBitrate &&
    a.sampleRate === b.sampleRate &&
    a.transparent === b.transparent
  );
}

export function isDefaultDelivery(d: ExportDelivery | undefined): boolean {
  return !d || sameDelivery(d, DEFAULT_DELIVERY);
}

/** how many choices differ from auto once the format has dropped what does not apply to it (the size is one) */
export function changedCount(container: ExportContainer, d: ExportDelivery | undefined): number {
  const r = resolveDelivery(container, d);
  let n = 0;
  if (r.codec !== DEFAULT_DELIVERY.codec) n++;
  if (r.bitrate !== DEFAULT_DELIVERY.bitrate) n++;
  if (r.keySeconds !== DEFAULT_DELIVERY.keySeconds) n++;
  if (r.size) n++;
  if (r.audioCodec !== DEFAULT_DELIVERY.audioCodec) n++;
  if (r.audioBitrate !== DEFAULT_DELIVERY.audioBitrate) n++;
  if (r.sampleRate !== DEFAULT_DELIVERY.sampleRate) n++;
  if (r.transparent !== DEFAULT_DELIVERY.transparent) n++;
  return n;
}

// ---- the file size estimate ----

/** the part of a see-through file the alpha adds, a guess measured later (the proof page) */
export const ALPHA_SHARE = 0.25;

/** the bits per second QUALITY_MEDIUM gives a sound codec */
export function autoAudioBitrate(codec: 'aac' | 'opus' | 'vorbis'): number {
  return codec === 'aac' ? 128_000 : 69_000;
}

export interface EstimateInput {
  container: 'mp4' | 'webm' | 'wav' | 'ogg';
  seconds: number;
  frames: number;
  videoBitrate: number;
  alpha: boolean;
  audio: { codec: 'aac' | 'opus' | 'vorbis' | 'pcm-s16'; bitrate: number | null; sampleRate: number } | null;
}
export interface SizeEstimate { video: number; alpha: number; audio: number; overhead: number; total: number }

/** bytes of the file, each part rounded: the bitrates times the length plus what the container adds. display only */
export function estimateBytes(i: EstimateInput): SizeEstimate {
  const video = Math.round((i.videoBitrate * i.seconds) / 8);
  const alpha = i.alpha ? Math.round(video * ALPHA_SHARE) : 0;
  const a = i.audio;
  const audioBps = !a ? 0 : a.codec === 'pcm-s16' ? a.sampleRate * 2 * 16 : (a.bitrate ?? autoAudioBitrate(a.codec));
  const audio = Math.round((audioBps * i.seconds) / 8);
  const packets = !a ? 0 : a.codec === 'aac' ? Math.ceil((i.seconds * a.sampleRate) / 1024) : a.codec === 'opus' ? Math.ceil(i.seconds * 50) : 0;
  let overhead: number;
  if (i.container === 'mp4') overhead = 4096 + 12 * i.frames + 8 * packets;
  else if (i.container === 'webm') overhead = 4096 + 12 * i.frames + 12 * packets;
  else if (i.container === 'ogg') overhead = 4096 + Math.round(audio * 0.01);
  else overhead = 44;
  return { video, alpha, audio, overhead, total: video + alpha + audio + overhead };
}
