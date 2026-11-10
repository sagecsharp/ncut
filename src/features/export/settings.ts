/**
 * the export dialog remembers the last used format / quality / frame rate / resolution (localStorage, per browser).
 * parsing is pure and strict: anything unexpected is ignored, so a broken value never breaks the dialog.
 */
import type { ExportContainer, ExportQuality } from './exporter';

export interface SavedExportSettings {
  container?: ExportContainer;
  quality?: ExportQuality;
  fps?: number;
  scale?: number;
}

export const EXPORT_SETTINGS_KEY = 'ncut-export-settings';

const CONTAINERS: readonly string[] = ['mp4', 'webm', 'wav', 'ogg'];
const QUALITIES: readonly string[] = ['low', 'medium', 'high'];
const SCALES: readonly number[] = [1, 0.75, 0.5];

export function parseExportSettings(raw: string | null): SavedExportSettings {
  if (!raw) return {};
  try {
    const o: unknown = JSON.parse(raw);
    if (!o || typeof o !== 'object') return {};
    const r = o as Record<string, unknown>;
    const out: SavedExportSettings = {};
    if (typeof r.container === 'string' && CONTAINERS.includes(r.container)) out.container = r.container as ExportContainer;
    if (typeof r.quality === 'string' && QUALITIES.includes(r.quality)) out.quality = r.quality as ExportQuality;
    if (typeof r.fps === 'number' && Number.isFinite(r.fps) && r.fps >= 1 && r.fps <= 240) out.fps = r.fps;
    if (typeof r.scale === 'number' && SCALES.includes(r.scale)) out.scale = r.scale;
    return out;
  } catch {
    return {};
  }
}

export function loadExportSettings(): SavedExportSettings {
  try {
    return parseExportSettings(localStorage.getItem(EXPORT_SETTINGS_KEY));
  } catch {
    return {};
  }
}

export function saveExportSettings(s: Required<SavedExportSettings>): void {
  try {
    localStorage.setItem(EXPORT_SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* storage can be blocked */
  }
}
