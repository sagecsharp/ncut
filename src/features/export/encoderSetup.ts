/**
 * getting the gpu encoder for big and fast exports.
 *
 * browsers only hand out the hardware encoder up to a frame rate per size (measured in chromium on windows: full hd
 * up to 120 fps, anything bigger up to 30 fps). past that an export quietly runs on the software encoder: 4k at 60
 * fps came out at 43 frames per second where the gpu does 81. an export is not live though, the encoder never
 * has to keep up with the frame rate. so a part's encoder is told a rate it takes (segment.ts): the frames get
 * timestamps at that rate and the bitrate is scaled with it, which leaves every frame exactly the bits it would
 * have had. the join writes the real times into the file (exporter.ts), where no trace of the told rate is left.
 *
 * measured (rtx 5070, 28 threads, h264, quality high, software -> gpu):
 *   4k 60 fps      89 -> 124 frames per second, psnr 48.8 -> 55.3 db
 *   1440p 60 fps  216 -> 252 frames per second, psnr 47.6 -> 52.4 db
 *   1080p 240 fps 403 -> 395 with footage that has 240 different frames a second, 568 -> 440 with 60 fps footage
 * so it is done above full hd only: at full hd and below the software encoder keeps up and is left alone.
 */
import { Quality, canEncodeVideo } from 'mediabunny';
import type { VideoCodec } from 'mediabunny';

export interface EncoderSetup {
  /** the frame rate the encoder is told; the part's timestamps are on this grid */
  fps: number;
  /** the full codec string. h264: with the level the real size, frame rate and bitrate need. missing = the muxer library's */
  codecString?: string;
}

/** pictures up to this many pixels are left to the plain setup (see the numbers above) */
export const GPU_SETUP_MIN_PIXELS = 1920 * 1088;

/** the rates an encoder is told, highest first (the nearer to the real one the better the encoder's own guesses) */
export const DECLARED_RATES: readonly number[] = [120, 60, 30];

/** h264 levels: [level_idc, macroblocks per second, macroblocks per frame, bits per second] (itu-t h.264 table a-1) */
const AVC_LEVELS: ReadonlyArray<readonly [number, number, number, number]> = [
  [0x0a, 1485, 99, 64_000],
  [0x0b, 3000, 396, 192_000],
  [0x0c, 6000, 396, 384_000],
  [0x0d, 11880, 396, 768_000],
  [0x14, 11880, 396, 2_000_000],
  [0x15, 19800, 792, 4_000_000],
  [0x16, 20250, 1620, 4_000_000],
  [0x1e, 40500, 1620, 10_000_000],
  [0x1f, 108000, 3600, 14_000_000],
  [0x20, 216000, 5120, 20_000_000],
  [0x28, 245760, 8192, 20_000_000],
  [0x29, 245760, 8192, 50_000_000],
  [0x2a, 522240, 8704, 50_000_000],
  [0x32, 589824, 22080, 135_000_000],
  [0x33, 983040, 36864, 240_000_000],
  [0x34, 2073600, 36864, 240_000_000],
  [0x3c, 4177920, 139264, 240_000_000],
  [0x3d, 8355840, 139264, 480_000_000],
  [0x3e, 16711680, 139264, 800_000_000],
];

/** the lowest h264 level (level_idc) that allows a size, frame rate and bitrate. the highest one when nothing does. */
export function avcLevel(width: number, height: number, fps: number, bitrate: number): number {
  const frame = Math.ceil(width / 16) * Math.ceil(height / 16);
  const perSecond = frame * fps;
  for (const [level, maxPerSecond, maxFrame, maxBitrate] of AVC_LEVELS) {
    if (frame <= maxFrame && perSecond <= maxPerSecond && bitrate <= maxBitrate) return level;
  }
  return AVC_LEVELS[AVC_LEVELS.length - 1]![0];
}

/** high profile h264 at the level the stream really needs */
export function avcCodecString(width: number, height: number, fps: number, bitrate: number): string {
  return `avc1.6400${avcLevel(width, height, fps, bitrate).toString(16).padStart(2, '0')}`;
}

/** the bitrate an encoder is given when it is told `told` frames per second for a film of `fps`: the same bits per frame */
export function scaledBitrate(bitrate: number, told: number, fps: number): number {
  return Math.max(1, Math.round(bitrate * (told / fps)));
}

type CanEncode = (codec: VideoCodec, options: NonNullable<Parameters<typeof canEncodeVideo>[1]>) => Promise<boolean>;

/**
 * how to set up the encoders of an export so the gpu does the work. null = nothing to arrange: the gpu encoder
 * takes the real frame rate (the plain setup gets it already), or there is none for this codec and size.
 */
export async function pickEncoderSetup(
  codec: VideoCodec,
  width: number,
  height: number,
  fps: number,
  bitrate: number,
  can: CanEncode = canEncodeVideo,
): Promise<EncoderSetup | null> {
  if (!(fps > 0) || !(bitrate > 0)) return null;
  if (width * height <= GPU_SETUP_MIN_PIXELS) return null;
  const gpu = async (told: number, codecString?: string): Promise<boolean> => {
    try {
      return await can(codec, {
        width,
        height,
        frameRate: told,
        quality: new Quality({ bitrate: scaledBitrate(bitrate, told, fps) }),
        hardwareAcceleration: 'prefer-hardware',
        ...(codecString ? { fullCodecString: codecString } : {}),
      });
    } catch {
      return false;
    }
  };
  if (await gpu(fps)) return null;
  const codecString = codec === 'avc' ? avcCodecString(width, height, fps, bitrate) : undefined;
  for (const told of DECLARED_RATES) {
    if (told >= fps) continue;
    if (codecString && (await gpu(told, codecString))) return { fps: told, codecString };
    if (await gpu(told)) return { fps: told };
  }
  return null;
}

// ---- the h264 level in the file ----
// an encoder that was told a lower frame rate writes the level of that rate into its stream (4k: 5.1 instead of the
// 5.2 that 60 fps needs). the level is one whole byte, so the join puts the true one in without touching the pictures.

/** the level in an h264 decoder setup record (avcC). null when the bytes are not one. */
export function avcLevelOf(description: Uint8Array): number | null {
  if (description.length < 7 || description[0] !== 1) return null;
  return description[3]!;
}

/** bytes of a nal unit length in the packets that go with a setup record (avcC) */
export function avcLengthSize(description: Uint8Array): number {
  return ((description[4] ?? 3) & 3) + 1;
}

/**
 * a copy of an h264 decoder setup record (avcC) with a higher level: the record's own level byte and the one in each
 * of its sequence parameter sets. null when the bytes are not such a record or already say at least that level.
 */
export function raiseAvcLevel(description: Uint8Array, level: number): Uint8Array | null {
  if (description.length < 7 || description[0] !== 1) return null;
  const out = description.slice();
  let changed = false;
  if (out[3]! < level) {
    out[3] = level;
    changed = true;
  }
  const count = out[5]! & 0x1f;
  let at = 6;
  for (let k = 0; k < count; k++) {
    if (at + 2 > out.length) return null;
    const length = (out[at]! << 8) | out[at + 1]!;
    const sps = at + 2;
    if (length < 4 || sps + length > out.length) return null;
    // [nal header][profile][constraint flags][level]
    if ((out[sps]! & 0x1f) === 7 && out[sps + 3]! < level) {
      out[sps + 3] = level;
      changed = true;
    }
    at = sps + length;
  }
  return changed ? out : null;
}

/** the codec string that goes with a setup record: avc1.[profile][constraint flags][level] */
export function avcCodecStringOf(description: Uint8Array): string {
  const hex = (n: number) => n.toString(16).padStart(2, '0');
  return `avc1.${hex(description[1] ?? 0)}${hex(description[2] ?? 0)}${hex(description[3] ?? 0)}`;
}

/**
 * the same for sequence parameter sets inside a packet (length prefixed nal units, key frames may repeat them).
 * returns the bytes it was given when nothing had to change, a patched copy otherwise.
 */
export function raiseAvcLevelInPacket(data: Uint8Array, lengthSize: number, level: number): Uint8Array {
  let out = data;
  let at = 0;
  while (at + lengthSize <= data.length) {
    let length = 0;
    for (let k = 0; k < lengthSize; k++) length = length * 256 + data[at + k]!;
    const nal = at + lengthSize;
    if (length <= 0 || nal + length > data.length) break;
    if ((data[nal]! & 0x1f) === 7 && length >= 4 && data[nal + 3]! < level) {
      if (out === data) out = data.slice();
      out[nal + 3] = level;
    }
    at = nal + length;
  }
  return out;
}
