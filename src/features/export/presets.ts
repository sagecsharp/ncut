/**
 * one-click choices for the export dialog. a preset only fills in format / quality / frame rate /
 * resolution; everything stays editable afterwards. pure.
 */
import type { ExportChoices } from './settings';
import { GIF_DEFAULT_FPS, GIF_DEFAULT_SCALE } from './gifPlan';

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
}

export const EXPORT_PRESETS: readonly ExportPreset[] = [
  { id: 'best', label: 'best', title: 'mp4, high quality, full size, the project frame rate', container: 'mp4', quality: 'high', fps: 'project', scale: 1 },
  { id: 'smooth', label: 'smooth 60', title: 'mp4, high quality, full size, 60 frames per second', container: 'mp4', quality: 'high', fps: 60, scale: 1 },
  { id: 'share', label: 'quick share', title: 'mp4, medium quality, three quarter size, 30 frames per second: uploads fast', container: 'mp4', quality: 'medium', fps: 30, scale: 0.75 },
  { id: 'small', label: 'small file', title: 'mp4, low quality, half size, 30 frames per second', container: 'mp4', quality: 'low', fps: 30, scale: 0.5 },
  { id: 'gif', label: 'gif', title: 'animated gif, half size, 15 frames per second, no sound', container: 'gif', quality: 'medium', fps: GIF_DEFAULT_FPS, scale: GIF_DEFAULT_SCALE },
];

/** the choices a preset stands for in a project */
export function presetChoices(preset: ExportPreset, projectFps: number): ExportChoices {
  return {
    container: preset.container,
    quality: preset.quality,
    fps: preset.fps === 'project' ? projectFps : preset.fps,
    scale: preset.scale,
  };
}

/** the id of the preset the current choices are equal to, or null. gif has no quality setting, so it is not compared there. */
export function matchingPreset(choices: ExportChoices, projectFps: number): string | null {
  for (const p of EXPORT_PRESETS) {
    const c = presetChoices(p, projectFps);
    if (c.container !== choices.container || c.fps !== choices.fps || c.scale !== choices.scale) continue;
    if (c.container !== 'gif' && c.quality !== choices.quality) continue;
    return p.id;
  }
  return null;
}
