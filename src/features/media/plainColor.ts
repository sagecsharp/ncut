/**
 * the "plain color" card of the media tab: a full frame picture of one color that every project has without
 * importing anything. it is not an asset and nothing is stored for it: the card makes a shape clip (a rect of
 * the project size), so the color stays editable in the properties and the clip takes transforms, 3d, crop,
 * blend and transitions like an image. the color the card is set to is kept per browser (localStorage), not
 * in the project.
 */
import { create } from 'zustand';
import { DEFAULT_IMAGE_DURATION } from '../../lib/factory';
import type { ShapeClip } from '../../types';
import type { MediaFilter } from './mediaList';

export const PLAIN_COLOR_NAME = 'plain color';
export const PLAIN_COLOR_DEFAULT = '#ffffff';

const KEY = 'ncut.plainColor';

/** a stored or typed color as '#rrggbb' in lowercase. anything else is the default (white). */
export function parsePlainColor(raw: unknown): string {
  if (typeof raw !== 'string') return PLAIN_COLOR_DEFAULT;
  const v = raw.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  // the short form is spelled out, so a color input can show it
  if (/^#[0-9a-f]{3}$/.test(v)) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  return PLAIN_COLOR_DEFAULT;
}

/** the clip the card makes: one flat color over the whole frame, as long as a still image */
export function plainColorPreset(canvasW: number, canvasH: number, color: string): Partial<ShapeClip> {
  const side = (v: number, fallback: number) => (Number.isFinite(v) && v >= 1 ? Math.round(v) : fallback);
  return {
    name: PLAIN_COLOR_NAME,
    kind: 'rect',
    width: side(canvasW, 1920),
    height: side(canvasH, 1080),
    color: parsePlainColor(color),
    duration: DEFAULT_IMAGE_DURATION,
  };
}

/**
 * is the card in the list: it counts as an image, is found by its name, and "not used" hides it (that filter
 * is about imported files that can be removed)
 */
export function showsPlainColor(o: { kind: MediaFilter; query: string; unusedOnly: boolean }): boolean {
  if (o.unusedOnly) return false;
  if (o.kind !== 'all' && o.kind !== 'image') return false;
  const q = o.query.trim().toLowerCase();
  return !q || PLAIN_COLOR_NAME.includes(q);
}

function load(): string {
  try {
    return parsePlainColor(typeof localStorage === 'undefined' ? null : localStorage.getItem(KEY));
  } catch {
    return PLAIN_COLOR_DEFAULT;
  }
}

interface PlainColorState {
  color: string;
  setColor(color: string): void;
}

export const usePlainColor = create<PlainColorState>()((set, get) => ({
  color: load(),
  setColor(color) {
    const next = parsePlainColor(color);
    if (next === get().color) return;
    set({ color: next });
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // storage is full or blocked: the color holds until the page is closed
    }
  },
}));
