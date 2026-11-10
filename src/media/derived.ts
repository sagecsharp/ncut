/**
 * STUB - owned by the media agent. keep the exported signatures.
 *
 * things derived from media files, computed lazily and cached in memory per asset id:
 * poster thumbnails, filmstrips for timeline clips, audio waveforms.
 */

export interface WaveformData {
  /** how many peaks describe one second of audio */
  peaksPerSecond: number;
  /** absolute peak amplitude per bucket, 0..1 */
  peaks: Float32Array;
}

/**
 * small poster image (object/data url) for an asset: a frame for video, the picture for images.
 * null for audio or when it cannot be produced. cached.
 */
export async function getThumbnail(_assetId: string): Promise<string | null> {
  return null;
}

/**
 * frames across a video asset for drawing inside timeline clips.
 * `count` evenly spaced frames, each `height` css px tall. frames[i] is taken at times[i] seconds.
 * null for non-video assets or on failure. cached per asset (largest count wins).
 */
export async function getFilmstrip(
  _assetId: string,
  _count: number,
  _height: number,
): Promise<{ times: number[]; frames: ImageBitmap[] } | null> {
  return null;
}

/** audio peaks for an audio asset or a video asset with audio. null when there is no audio. cached. */
export async function getWaveform(_assetId: string): Promise<WaveformData | null> {
  return null;
}

/** drop cached data for an asset (call when the asset is deleted) */
export function releaseDerived(_assetId: string): void {}
