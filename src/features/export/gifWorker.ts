/**
 * a web worker that does the slow part of gif frames (palette lookup with dithering + lzw, lib/gif.ts
 * encodeGifFrame). the exporter draws the frames itself and hands the pixels to a few of these (gifPool.ts).
 * pure number work: no dom, no canvas.
 */
import { encodeGifFrame } from '../../lib/gif';
import type { FromGifWorker, ToGifWorker } from './gifPool';

const scope = self as unknown as {
  postMessage(message: FromGifWorker, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<ToGifWorker>) => void) | null;
};

let palette: Uint8Array | null = null;
let width = 0;
let scratch: Uint8Array | undefined;

scope.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') {
    palette = m.palette;
    width = m.width;
    return;
  }
  try {
    if (!palette) throw new Error('no palette');
    const rgba = new Uint8Array(m.rgba);
    if (!scratch || scratch.length !== rgba.length >> 2) scratch = new Uint8Array(rgba.length >> 2);
    const lzw = encodeGifFrame(rgba, width, palette, scratch);
    scope.postMessage({ type: 'done', id: m.id, lzw: lzw.buffer as ArrayBuffer }, [lzw.buffer as ArrayBuffer]);
  } catch (err) {
    scope.postMessage({ type: 'error', id: m.id, message: err instanceof Error ? err.message : String(err) });
  }
};
