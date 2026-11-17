/** what a clip box shows at a given inner height: the filmstrip, the sound band. pure: no dom */
import { CLIP_LABEL_H } from './layout';

/** a video clip shorter than this inside shows no filmstrip */
export const FILM_MIN_H = 24;
/** the sound band of a video clip never grows past this */
export const VIDEO_WAVE_MAX = 40;

/** the height the filmstrip is decoded at: 48 up to 48 px, then 96. the cache serves any smaller height */
export function filmstripHeight(innerH: number): number {
  return innerH <= 48 ? 48 : 96;
}

/** the bands of a clip box of inner height h. video: the strip on top, the sound at the bottom. audio: the sound under the label */
export function clipBands(type: 'video' | 'audio', h: number): { film: boolean; waveTop: number; waveH: number } {
  if (type === 'audio') return { film: false, waveTop: CLIP_LABEL_H, waveH: h - CLIP_LABEL_H };
  const waveH = Math.min(Math.round(0.4 * h), VIDEO_WAVE_MAX);
  return { film: h >= FILM_MIN_H, waveTop: h - waveH, waveH };
}
