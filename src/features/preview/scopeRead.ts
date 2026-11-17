/**
 * reading pixels back for the scopes and the probe: a gpu shrink with smoothing off (nearest, never averaging) into an
 * OffscreenCanvas, drawn into a willReadFrequently one, read there. never getImageData on the preview canvas itself
 * (that would turn it into a cpu canvas, see makeProbe in src/dev/bench.ts).
 */
import type { TapImage } from './scopeTap';

export class FrameReader {
  private gpu: OffscreenCanvas | null = null;
  private cpu: OffscreenCanvas | null = null;
  private g: OffscreenCanvasRenderingContext2D | null = null;
  private c: OffscreenCanvasRenderingContext2D | null = null;

  /** the rect (sx, sy, sw, sh) of src shrunk to w x h, nearest. null when the read is refused (a tainted source) or fails */
  read(src: CanvasImageSource, sx: number, sy: number, sw: number, sh: number, w: number, h: number): ImageData | null {
    if (!(w >= 1) || !(h >= 1)) return null;
    try {
      if (!this.gpu || !this.cpu || !this.g || !this.c) {
        this.gpu = new OffscreenCanvas(w, h);
        this.cpu = new OffscreenCanvas(w, h);
        this.g = this.gpu.getContext('2d', { alpha: false });
        this.c = this.cpu.getContext('2d', { alpha: false, willReadFrequently: true });
        if (!this.g || !this.c) return null;
      }
      const { gpu, cpu, g, c } = this;
      // a resize resets the context, so smoothing is set after it
      if (gpu.width !== w) gpu.width = w;
      if (gpu.height !== h) gpu.height = h;
      if (cpu.width !== w) cpu.width = w;
      if (cpu.height !== h) cpu.height = h;
      g.imageSmoothingEnabled = false;
      g.drawImage(src, sx, sy, sw, sh, 0, 0, w, h);
      c.drawImage(gpu, 0, 0);
      return c.getImageData(0, 0, w, h);
    } catch {
      // a SecurityError (a source from another origin) or a lost context
      return null;
    }
  }

  dispose(): void {
    if (this.gpu) {
      this.gpu.width = 0;
      this.gpu.height = 0;
    }
    if (this.cpu) {
      this.cpu.width = 0;
      this.cpu.height = 0;
    }
    this.gpu = this.cpu = null;
    this.g = this.c = null;
  }
}

/**
 * the image still has the size the tap told: a resized canvas was cleared (the redraw taps again), a video has a
 * frame to show (readyState >= 2), a picture is decoded
 */
export function tapSizeOk(image: TapImage, w: number, h: number): boolean {
  if (typeof HTMLVideoElement !== 'undefined' && image instanceof HTMLVideoElement) return image.readyState >= 2 && image.videoWidth === w && image.videoHeight === h;
  if (typeof HTMLImageElement !== 'undefined' && image instanceof HTMLImageElement) return image.complete && image.naturalWidth === w && image.naturalHeight === h;
  const c = image as HTMLCanvasElement | OffscreenCanvas;
  return c.width === w && c.height === h;
}
