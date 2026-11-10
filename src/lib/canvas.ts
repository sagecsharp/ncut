/**
 * one place that makes a canvas, on the main thread and inside a dedicated worker.
 * import-safe in node and in a worker: nothing here touches the dom at module load.
 */

/**
 * a canvas for drawing: a real <canvas> when there is a document (the main thread keeps exactly what it always
 * had), otherwise an OffscreenCanvas (a worker). sizes are optional; an element without sizes is 300 x 150 and an
 * OffscreenCanvas without sizes is 1 x 1, so pass them when they matter.
 *
 * an OffscreenCanvas has width, height, getContext('2d' | 'webgl2' | ...) and addEventListener (webglcontextlost /
 * webglcontextrestored work) and can be drawn from and uploaded as a texture. it does NOT have style, toDataURL,
 * toBlob (it has convertToBlob), getBoundingClientRect, isConnected, or anything else of an element: code that
 * must run in a worker uses only width / height / getContext on what this returns.
 * throws when the environment has neither a document nor OffscreenCanvas (node without a stub).
 */
export function createCanvas(width?: number, height?: number): HTMLCanvasElement {
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    if (width !== undefined) c.width = width;
    if (height !== undefined) c.height = height;
    return c;
  }
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(width ?? 1, height ?? 1) as unknown as HTMLCanvasElement;
  }
  throw new Error('no canvas is available here');
}

/** true inside a dedicated worker (no document, but a worker global). false on the main thread and in plain node. */
export function inWorker(): boolean {
  return typeof document === 'undefined' && typeof self !== 'undefined';
}
