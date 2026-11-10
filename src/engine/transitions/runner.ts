/**
 * runs a transition on the gpu: two pictures in, one mixed picture out.
 * STUB until the transition engine lands: returns null (callers fall back to a plain cut / an icon).
 */
import type { TransitionDef } from './registry';

export interface TransitionRenderOptions {
  /** project size in project pixels (u_size) */
  projectWidth: number;
  projectHeight: number;
  /** which gl context to use. 'default' = preview, 'export' = export, 'thumb' = small ui previews. */
  channel?: 'default' | 'export' | 'thumb';
}

/**
 * mix picture `a` (outgoing, may be null = transparent) into picture `b` (incoming, may be null) at
 * progress 0..1. returns a canvas of width x height holding premultiplied rgba, valid until the next
 * call on the same channel. null when webgl2 is not available.
 */
export function renderTransition(
  _a: TexImageSource | null,
  _b: TexImageSource | null,
  _def: TransitionDef,
  _progress: number,
  _width: number,
  _height: number,
  _opts: TransitionRenderOptions,
): HTMLCanvasElement | OffscreenCanvas | null {
  return null;
}
