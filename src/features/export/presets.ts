/**
 * one-click choices for the export dialog. a preset fills in format / quality / frame rate / resolution and, for
 * the newer ones, the advanced choices (size, bitrate, sound); everything stays editable afterwards. pure.
 */
import type { ExportChoices } from './settings';
import { GIF_DEFAULT_FPS, GIF_DEFAULT_SCALE } from './gifPlan';
import { DEFAULT_DELIVERY, sameDelivery } from './delivery';
import type { ExportDelivery } from './delivery';
import { outputSize, videoBitrate } from './exporter';

/** what a preset sets of the advanced choices. a bitrate of 'master' is three times the high one for the project's size and frame rate */
export type PresetDelivery = Partial<Omit<ExportDelivery, 'bitrate'>> & { bitrate?: number | 'master' };

export interface ExportPreset {
  id: string;
  label: string;
  /** what it sets, in plain words (the button's tooltip) */
  title: string;
  container: ExportChoices['container'];
  quality: ExportChoices['quality'];
  /** frames per second, or 'project' = the project's own frame rate */
  fps: number | 'project';
  scale: number;
  /** the advanced choices it sets. missing = all back to auto */
  delivery?: PresetDelivery;
}

export const EXPORT_PRESETS: readonly ExportPreset[] = [
  { id: 'best', label: 'best', title: 'mp4, high quality, full size, the project frame rate', container: 'mp4', quality: 'high', fps: 'project', scale: 1 },
  { id: 'smooth', label: 'smooth 60', title: 'mp4, high quality, full size, 60 frames per second', container: 'mp4', quality: 'high', fps: 60, scale: 1 },
  { id: 'share', label: 'quick share', title: 'mp4, medium quality, three quarter size, 30 frames per second: uploads fast', container: 'mp4', quality: 'medium', fps: 30, scale: 0.75 },
  { id: 'small', label: 'small file', title: 'mp4, low quality, half size, 30 frames per second', container: 'mp4', quality: 'low', fps: 30, scale: 0.5 },
  { id: 'gif', label: 'gif', title: 'animated gif, half size, 15 frames per second, no sound', container: 'gif', quality: 'medium', fps: GIF_DEFAULT_FPS, scale: GIF_DEFAULT_SCALE },
  {
    id: 'youtube-1080',
    label: 'youtube 1080p',
    title: 'mp4, 1920x1080, high quality, the project frame rate, aac 192 kbps at 48 khz',
    container: 'mp4',
    quality: 'high',
    fps: 'project',
    scale: 1,
    delivery: { size: { width: 1920, height: 1080, fit: 'fit' }, audioCodec: 'aac', audioBitrate: 192_000 },
  },
  {
    id: 'youtube-4k',
    label: 'youtube 4k',
    title: 'mp4, 3840x2160, high quality, the project frame rate, aac 192 kbps at 48 khz',
    container: 'mp4',
    quality: 'high',
    fps: 'project',
    scale: 1,
    delivery: { size: { width: 3840, height: 2160, fit: 'fit' }, audioCodec: 'aac', audioBitrate: 192_000 },
  },
  {
    id: 'vimeo',
    label: 'vimeo',
    title: 'mp4, 1920x1080, 20 mbps, the project frame rate, aac 192 kbps at 48 khz',
    container: 'mp4',
    quality: 'high',
    fps: 'project',
    scale: 1,
    delivery: { size: { width: 1920, height: 1080, fit: 'fit' }, bitrate: 20_000_000, audioCodec: 'aac', audioBitrate: 192_000 },
  },
  {
    id: 'reels',
    label: 'vertical reels',
    title: 'mp4, 1080x1920 upright, high quality, 30 frames per second, aac at 48 khz. a wide project gets bars',
    container: 'mp4',
    quality: 'high',
    fps: 30,
    scale: 1,
    delivery: { size: { width: 1080, height: 1920, fit: 'fit' }, audioCodec: 'aac' },
  },
  {
    id: 'master',
    label: 'master',
    title: 'mp4, full size, three times the high bitrate, a key frame every second, aac 192 kbps: a file to keep or to edit further',
    container: 'mp4',
    quality: 'high',
    fps: 'project',
    scale: 1,
    delivery: { bitrate: 'master', keySeconds: 1, audioCodec: 'aac', audioBitrate: 192_000 },
  },
];

/** three times the high h.264 bitrate of a size and frame rate, at most 240 mbps (1080p30: 29_859_840) */
export function masterBitrate(width: number, height: number, fps: number): number {
  return Math.min(240_000_000, 3 * videoBitrate(width, height, fps, 'high', 'avc'));
}

/** the choices a preset stands for in a project. the delivery is always set: a preset puts every advanced choice where it says */
export function presetChoices(preset: ExportPreset, projectFps: number, projectSize: { width: number; height: number } = { width: 1920, height: 1080 }): ExportChoices {
  const fps = preset.fps === 'project' ? projectFps : preset.fps;
  const set = preset.delivery;
  let delivery: ExportDelivery = { ...DEFAULT_DELIVERY };
  if (set) {
    const { bitrate, size, ...rest } = set;
    delivery = { ...DEFAULT_DELIVERY, ...rest, size: size ? { ...size } : null };
    if (bitrate === 'master') {
      const out = outputSize(projectSize, preset.scale);
      delivery.bitrate = masterBitrate(out.width, out.height, fps);
    } else if (bitrate !== undefined) delivery.bitrate = bitrate;
  }
  return { container: preset.container, quality: preset.quality, fps, scale: preset.scale, delivery };
}

/** the id of the preset the current choices are equal to, or null. gif has no quality setting, so it is not compared there. */
export function matchingPreset(choices: ExportChoices, projectFps: number, projectSize?: { width: number; height: number }): string | null {
  for (const p of EXPORT_PRESETS) {
    const c = presetChoices(p, projectFps, projectSize);
    if (c.container !== choices.container || c.fps !== choices.fps || c.scale !== choices.scale) continue;
    if (c.container !== 'gif' && c.quality !== choices.quality) continue;
    if (!sameDelivery(c.delivery ?? DEFAULT_DELIVERY, choices.delivery ?? DEFAULT_DELIVERY)) continue;
    return p.id;
  }
  return null;
}
