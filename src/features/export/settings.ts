/**
 * the export dialog remembers the last used format / quality / frame rate / resolution (localStorage, per browser).
 * gif keeps its own frame rate + resolution (`gif`), so picking gif never overwrites the video choices.
 * parsing is pure and strict: anything unexpected is ignored, so a broken value never breaks the dialog.
 */
import type { ExportContainer, ExportQuality } from './exporter';
import { GIF_MAX_FPS } from './gifPlan';

export interface SavedGifSettings {
  fps?: number;
  scale?: number;
}

export interface SavedExportSettings {
  container?: ExportContainer;
  quality?: ExportQuality;
  fps?: number;
  scale?: number;
  gif?: SavedGifSettings;
}

/** what the dialog hands to save: the current choices, `fps` / `scale` belong to gif when the container is gif */
export interface ExportChoices {
  container: ExportContainer;
  quality: ExportQuality;
  fps: number;
  scale: number;
}

export const EXPORT_SETTINGS_KEY = 'ncut-export-settings';

const CONTAINERS: readonly string[] = ['mp4', 'webm', 'gif', 'wav', 'ogg'];
const QUALITIES: readonly string[] = ['low', 'medium', 'high'];
const SCALES: readonly number[] = [1, 0.75, 0.5];

function parseFps(v: unknown, max: number): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 1 && v <= max ? v : undefined;
}
function parseScale(v: unknown): number | undefined {
  return typeof v === 'number' && SCALES.includes(v) ? v : undefined;
}

export function parseExportSettings(raw: string | null): SavedExportSettings {
  if (!raw) return {};
  try {
    const o: unknown = JSON.parse(raw);
    if (!o || typeof o !== 'object') return {};
    const r = o as Record<string, unknown>;
    const out: SavedExportSettings = {};
    if (typeof r.container === 'string' && CONTAINERS.includes(r.container)) out.container = r.container as ExportContainer;
    if (typeof r.quality === 'string' && QUALITIES.includes(r.quality)) out.quality = r.quality as ExportQuality;
    const fps = parseFps(r.fps, 240);
    if (fps !== undefined) out.fps = fps;
    const scale = parseScale(r.scale);
    if (scale !== undefined) out.scale = scale;
    if (r.gif && typeof r.gif === 'object') {
      const g = r.gif as Record<string, unknown>;
      const gif: SavedGifSettings = {};
      const gfps = parseFps(g.fps, GIF_MAX_FPS);
      if (gfps !== undefined) gif.fps = gfps;
      const gscale = parseScale(g.scale);
      if (gscale !== undefined) gif.scale = gscale;
      if (gif.fps !== undefined || gif.scale !== undefined) out.gif = gif;
    }
    return out;
  } catch {
    return {};
  }
}

/** the settings to store after an export: gif choices go to `gif`, everything else to the top level, the rest is kept */
export function mergeExportSettings(prev: SavedExportSettings, next: ExportChoices): SavedExportSettings {
  const out: SavedExportSettings = { ...prev, container: next.container, quality: next.quality };
  if (next.container === 'gif') out.gif = { fps: Math.min(GIF_MAX_FPS, next.fps), scale: next.scale };
  else if (next.container === 'mp4' || next.container === 'webm') {
    out.fps = next.fps;
    out.scale = next.scale;
  }
  return out;
}

export function loadExportSettings(): SavedExportSettings {
  try {
    return parseExportSettings(localStorage.getItem(EXPORT_SETTINGS_KEY));
  } catch {
    return {};
  }
}

export function saveExportSettings(next: ExportChoices): void {
  try {
    localStorage.setItem(EXPORT_SETTINGS_KEY, JSON.stringify(mergeExportSettings(loadExportSettings(), next)));
  } catch {
    /* storage can be blocked */
  }
}
