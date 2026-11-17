/**
 * the export dialog remembers the last used format / quality / frame rate / resolution (localStorage, per browser).
 * gif keeps its own frame rate + resolution (`gif`), so picking gif never overwrites the video choices.
 * a picture (png / jpg) only remembers that it was picked (and the quality a jpg used).
 * the advanced choices (delivery.ts) are kept with them, and whether the advanced part was left open.
 * parsing is pure and strict: anything unexpected is ignored, so a broken value never breaks the dialog.
 */
import type { ExportContainer, ExportQuality } from './exporter';
import { GIF_MAX_FPS } from './gifPlan';
import { AUDIO_KBPS_CHOICES, DEFAULT_DELIVERY, KEY_SECONDS_CHOICES, SIZE_MAX, SIZE_MIN, isDefaultDelivery } from './delivery';
import type { DeliveryAudioCodec, DeliveryCodec, ExportDelivery } from './delivery';
import { cleanLoudness, wantsLoudness } from './loudnessTypes';
import type { ExportLoudness } from './loudnessTypes';

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
  /** the advanced choices. missing = all auto. the rate in it is what the loudness meter measures at */
  delivery?: ExportDelivery;
  /** the loudness target and peak limit. missing = off (kept per browser, never in the project) */
  loudness?: ExportLoudness;
  /** the project size a custom size in `delivery` was set on: it is kept only for projects of that size */
  sizeFor?: { width: number; height: number };
  /** the advanced part of the dialog was left open */
  advanced?: true;
}

/** what the dialog hands to save: the current choices, `fps` / `scale` belong to gif when the container is gif */
export interface ExportChoices {
  container: ExportContainer;
  quality: ExportQuality;
  fps: number;
  scale: number;
  /** the advanced choices. missing = leave the saved ones alone */
  delivery?: ExportDelivery;
  /** the project size a custom size was set on */
  sizeFor?: { width: number; height: number };
}

export const EXPORT_SETTINGS_KEY = 'ncut-export-settings';

const CONTAINERS: readonly string[] = ['mp4', 'webm', 'gif', 'wav', 'ogg', 'png', 'jpg'];
const QUALITIES: readonly string[] = ['low', 'medium', 'high'];
const SCALES: readonly number[] = [1, 0.75, 0.5];

function parseFps(v: unknown, max: number): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 1 && v <= max ? v : undefined;
}
function parseScale(v: unknown): number | undefined {
  return typeof v === 'number' && SCALES.includes(v) ? v : undefined;
}

const CODEC_CHOICES: readonly string[] = ['auto', 'avc', 'hevc', 'av1', 'vp9'];
const AUDIO_CODEC_CHOICES: readonly string[] = ['auto', 'aac', 'opus'];
const whole = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/** a saved delivery, each field checked alone (a bad one takes its default). undefined = not an object, or all auto */
export function parseDelivery(v: unknown): ExportDelivery | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const r = v as Record<string, unknown>;
  const out: ExportDelivery = { ...DEFAULT_DELIVERY };
  if (typeof r.codec === 'string' && CODEC_CHOICES.includes(r.codec)) out.codec = r.codec as DeliveryCodec;
  if (whole(r.bitrate) && r.bitrate >= 500_000 && r.bitrate <= 240_000_000) out.bitrate = r.bitrate;
  if (typeof r.keySeconds === 'number' && KEY_SECONDS_CHOICES.includes(r.keySeconds) && r.keySeconds !== 2) out.keySeconds = r.keySeconds;
  const s = r.size;
  if (s && typeof s === 'object') {
    const z = s as Record<string, unknown>;
    if (whole(z.width) && whole(z.height) && z.width >= SIZE_MIN && z.width <= SIZE_MAX && z.height >= SIZE_MIN && z.height <= SIZE_MAX && (z.fit === 'fit' || z.fit === 'fill')) {
      out.size = { width: z.width, height: z.height, fit: z.fit };
    }
  }
  if (typeof r.audioCodec === 'string' && AUDIO_CODEC_CHOICES.includes(r.audioCodec)) out.audioCodec = r.audioCodec as DeliveryAudioCodec;
  if (whole(r.audioBitrate) && AUDIO_KBPS_CHOICES.some((k) => k * 1000 === r.audioBitrate)) out.audioBitrate = r.audioBitrate;
  if (r.sampleRate === 44100 || r.sampleRate === 48000) out.sampleRate = r.sampleRate;
  if (r.transparent === true) out.transparent = true;
  return isDefaultDelivery(out) ? undefined : out;
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
    if (r.delivery !== undefined) {
      const delivery = parseDelivery(r.delivery);
      if (delivery) out.delivery = delivery;
    }
    if (r.loudness !== undefined) {
      const l = cleanLoudness(r.loudness);
      if (wantsLoudness(l)) out.loudness = l;
    }
    const f = r.sizeFor;
    if (f && typeof f === 'object') {
      const z = f as Record<string, unknown>;
      if (whole(z.width) && whole(z.height) && z.width > 0 && z.height > 0) out.sizeFor = { width: z.width, height: z.height };
    }
    if (r.advanced === true) out.advanced = true;
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
  // the advanced choices: missing keeps the saved ones, all auto removes them, else they are stored with the size they were set on
  if (next.delivery !== undefined) {
    if (isDefaultDelivery(next.delivery)) {
      delete out.delivery;
      delete out.sizeFor;
    } else {
      out.delivery = { ...next.delivery, size: next.delivery.size ? { ...next.delivery.size } : null };
      if (next.delivery.size && next.sizeFor) out.sizeFor = { ...next.sizeFor };
      else delete out.sizeFor;
    }
  }
  return out;
}

/** a copy of the saved settings with the loudness choice set, or the key removed when it is off */
export function withLoudness(prev: SavedExportSettings, l: ExportLoudness): SavedExportSettings {
  const out: SavedExportSettings = { ...prev };
  if (wantsLoudness(l)) out.loudness = { target: l.target, ceiling: l.ceiling };
  else delete out.loudness;
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

/** remember whether the advanced part of the dialog is open (the rest of what was saved stays) */
export function saveAdvancedOpen(open: boolean): void {
  try {
    const saved = loadExportSettings();
    if (open) saved.advanced = true;
    else delete saved.advanced;
    localStorage.setItem(EXPORT_SETTINGS_KEY, JSON.stringify(saved));
  } catch {
    /* storage can be blocked */
  }
}

/** the advanced choices for a project: a copy of the saved ones, a custom size only when it was set on a project of this size */
export function savedDelivery(saved: SavedExportSettings, projectW: number, projectH: number): ExportDelivery {
  const d = saved.delivery ?? DEFAULT_DELIVERY;
  const sameSize = !!saved.sizeFor && saved.sizeFor.width === projectW && saved.sizeFor.height === projectH;
  return { ...d, size: d.size && sameSize ? { ...d.size } : null };
}
