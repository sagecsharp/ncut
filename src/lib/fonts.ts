/**
 * fonts for text clips. STUB: the real catalog + loading lands with the fonts feature.
 * the api below is the contract the renderer, the preview and the exporter use.
 */
import type { Project } from '../types';

export interface FontInfo {
  /** css font-family name, saved in the clip */
  family: string;
  category: 'sans' | 'serif' | 'display' | 'handwriting' | 'mono' | 'system' | 'local' | 'imported';
  /** weights that exist for the family (text clips use 400 and 700) */
  weights: number[];
  italic: boolean;
}

/** every font the picker offers right now (bundled + system + local + imported) */
export function listFonts(): FontInfo[] {
  return [];
}

/** make a family usable on a canvas. resolves when it is loaded (or cannot be: never rejects). */
export async function ensureFont(_family: string, _weight: number = 400, _italic = false, _text?: string): Promise<void> {}

/** load every font the project's text clips use. the exporter awaits this before the first frame. */
export async function ensureProjectFonts(_project: Project): Promise<void> {}

/** bumps every time a font finishes loading. cached text (measurements, textures) is keyed on it. */
export function fontsVersion(): number {
  return 0;
}

/** call back whenever a font finishes loading (redraw the preview). returns the unsubscribe. */
export function onFontsChanged(_cb: () => void): () => void {
  return () => {};
}
