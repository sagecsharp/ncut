/**
 * the scope plots: images from the bins and the graticules. dom free: it needs only a 2d context (the strip paints
 * on screen, mcp paints offscreen). the plots are black with measured colors in both themes (a stated exception to
 * the theme rule, see ARCHITECTURE.md). the strip chrome around them uses tokens.
 */
import { VECTOR_N, VECTOR_RANGE, SKIN_DIR, channelMeans, lumaStats, vectorTargets, type ScopeBins } from './scopes';
import type { ScopeKind } from './scopesState';

/** css px: space around a plot, the width of the level labels, the gap between the parade's traces */
export const PLOT_PAD = 6,
  LABEL_W = 22,
  PARADE_GAP = 4;
/** vector bins are rare: this brings a share of the pixels up to a visible alpha */
export const VECTOR_GAIN = 400;
export const TRACE = {
  luma: [225, 232, 225],
  r: [255, 72, 72],
  g: [72, 220, 96],
  b: [86, 136, 255],
} as const;
type Rgb = readonly [number, number, number];

/** how strong a trace dot is for the share of the column (or of the picture) that sits there, 0..1 */
export const traceAlpha = (share: number): number => (share > 0 ? Math.max(0.1, 1 - Math.exp(-share * 30)) : 0);

/**
 * rgba of a trace: cols x 256, row 0 = level 255. counts is one plane (x * 256 + level), colPixels the pixels in a
 * column. a reused out is written whole. node has no ImageData: the caller wraps it.
 */
export function traceImage(counts: Uint32Array, cols: number, colPixels: number, color: Rgb, out?: Uint8ClampedArray): Uint8ClampedArray {
  const img = out && out.length === cols * 256 * 4 ? out : new Uint8ClampedArray(cols * 256 * 4);
  const [r, g, b] = color;
  for (let row = 0; row < 256; row++) {
    const level = 255 - row;
    for (let x = 0; x < cols; x++) {
      const n = counts[x * 256 + level] ?? 0;
      const p = (row * cols + x) * 4;
      img[p] = r;
      img[p + 1] = g;
      img[p + 2] = b;
      img[p + 3] = n > 0 ? Math.round(255 * traceAlpha(n / colPixels)) : 0;
    }
  }
  return img;
}

/** rgba of the vectorscope: 256 x 256, each bin in the color it stands for, mixed toward the trace gray near the middle */
export function vectorImage(vector: Uint32Array, pixels: number, zoom: 1 | 2, out?: Uint8ClampedArray):Uint8ClampedArray {
  const img = out && out.length === VECTOR_N * VECTOR_N * 4 ? out : new Uint8ClampedArray(VECTOR_N * VECTOR_N * 4);
  const s = VECTOR_N / (2 * (VECTOR_RANGE / zoom));
  const half = VECTOR_N / 2;
  const luma = TRACE.luma;
  for (let row = 0; row < VECTOR_N; row++) {
    const cr = (half - (row + 0.5)) / s;
    for (let col = 0; col < VECTOR_N; col++) {
      const i = row * VECTOR_N + col;
      const p = i * 4;
      const n = vector[i] ?? 0;
      if (!(n > 0) || !(pixels > 0)) {
        img[p] = luma[0];
        img[p + 1] = luma[1];
        img[p + 2] = luma[2];
        img[p + 3] = 0;
        continue;
      }
      const cb = (col + 0.5 - half) / s;
      const y = 0.6;
      const rr = Math.max(0, Math.min(1, y + 1.5748 * cr));
      const bb = Math.max(0, Math.min(1, y + 1.8556 * cb));
      const gg = Math.max(0, Math.min(1, (y - 0.2126 * rr - 0.0722 * bb) / 0.7152));
      const top = Math.max(rr, gg, bb, 1e-6);
      const t = Math.min(1, Math.hypot(cb, cr) / 0.1);
      img[p] = Math.round(luma[0] * (1 - t) + (rr / top) * 255 * t);
      img[p + 1] = Math.round(luma[1] * (1 - t) + (gg / top) * 255 * t);
      img[p + 2] = Math.round(luma[2] * (1 - t) + (bb / top) * 255 * t);
      img[p + 3] = Math.round(255 * traceAlpha((n / pixels) * VECTOR_GAIN * zoom * zoom));
    }
  }
  return img;
}

/** the biggest count of levels 1..254 over r, g, b and luma (the ends clip and would flatten the rest), at least 1 */
export function histogramPeak(hist: Uint32Array): number {
  let peak = 1;
  for (let c = 0; c < 4; c++) {
    for (let v = 1; v < 255; v++) peak = Math.max(peak, hist[c * 256 + v] ?? 0);
  }
  return peak;
}

/** the level labels of a cell css px high: 0 to 100 by 20, 0 50 100 when it is small */
export const gridLabels = (cssH: number): number[] => (cssH < 120 ? [0, 50, 100] : [0, 20, 40, 60, 80, 100]);

/** 0%, <0.1%, 0.4%, 12.3% */
export function percentText(share: number): string {
  const p = share * 100;
  if (!(p > 0)) return '0%';
  if (p < 0.1) return '<0.1%';
  return `${Math.round(p * 10) / 10}%`;
}

/** the stats line under a cell, '' for the vectorscope and for 0 pixels */
export function statsLine(kind: ScopeKind, hist: Uint32Array, pixels: number): string {
  if (kind === 'vectorscope' || !(pixels > 0)) return '';
  if (kind === 'waveform') {
    const s = lumaStats(hist, pixels);
    return s ? `luma ${Math.round(s.min)} to ${Math.round(s.max)}, mean ${Math.round(s.mean)}` : '';
  }
  if (kind === 'parade') {
    const m = channelMeans(hist, pixels);
    return m ? `mean r ${Math.round(m.r)}, g ${Math.round(m.g)}, b ${Math.round(m.b)}` : '';
  }
  const s = lumaStats(hist, pixels);
  return s ? `black ${percentText(s.black)}, white ${percentText(s.white)}` : '';
}

/** the plot area inside a cell in backing px. the vectorscope is a centered square without labels */
export function plotRect(kind: ScopeKind, w: number, h: number, k: number): { x: number; y: number; w: number; h: number } {
  const pad = Math.round(PLOT_PAD * k);
  if (kind === 'vectorscope') {
    const side = Math.max(0, Math.floor(Math.min(w, h) - 2 * pad));
    return { x: Math.floor((w - side) / 2), y: Math.floor((h - side) / 2), w: side, h: side };
  }
  const x = pad + Math.round(LABEL_W * k);
  return { x, y: pad, w: Math.max(0, w - x - pad), h: Math.max(0, h - 2 * pad) };
}

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** buffers, a scratch canvas and the graticule cache: keep one per strip, a fresh one per call is fine for one picture */
export interface PlotScratch {
  trace: Uint8ClampedArray | null;
  vec: Uint8ClampedArray | null;
  canvas: OffscreenCanvas | null;
  gratKey: string;
  grat: OffscreenCanvas | null;
}
export const plotScratch = (): PlotScratch => ({ trace: null, vec: null, canvas: null, gratKey: '', grat: null });

const GRID = 'rgba(255,255,255,0.12)';
const GRID_EDGE = 'rgba(255,255,255,0.25)';
const LABEL = 'rgba(255,255,255,0.45)';
const hasOffscreen = (): boolean => typeof OffscreenCanvas !== 'undefined';
const font = (k: number): string => `${10 * k}px "Kode Mono"`;

/** the graticule of one cell, drawn on ctx */
function drawGraticule(ctx: Ctx, kind: ScopeKind, w: number, h: number, k: number, zoom: 1 | 2): void {
  const r = plotRect(kind, w, h, k);
  if (r.w < 1 || r.h < 1) return;
  const line = Math.max(1, Math.round(k));
  ctx.font = font(k);
  ctx.textBaseline = 'middle';
  if (kind === 'waveform' || kind === 'parade') {
    for (let v = 0; v <= 100; v += 10) {
      ctx.fillStyle = v === 0 || v === 100 ? GRID_EDGE : GRID;
      const y = Math.round(r.y + r.h * (1 - v / 100));
      ctx.fillRect(r.x, Math.min(y, r.y + r.h - line), r.w, line);
    }
    ctx.fillStyle = LABEL;
    ctx.textAlign = 'right';
    for (const v of gridLabels(h / k)) ctx.fillText(String(v), r.x - 3 * k, r.y + r.h * (1 - v / 100));
    if (kind === 'parade') {
      const gap = PARADE_GAP * k;
      const third = (r.w - 2 * gap) / 3;
      const names = ['r', 'g', 'b'] as const;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      for (let i = 0; i < 3; i++) {
        ctx.fillStyle = `rgba(${TRACE[names[i]!].join(',')},0.6)`;
        ctx.fillText(names[i]!, r.x + i * (third + gap) + 3 * k, r.y + 2 * k);
      }
    }
    return;
  }
  if (kind === 'histogram') {
    for (let v = 0; v <= 100; v += 10) {
      ctx.fillStyle = v === 0 || v === 100 ? GRID_EDGE : GRID;
      const x = Math.round(r.x + (r.w * v) / 100);
      ctx.fillRect(Math.min(x, r.x + r.w - line), r.y, line, r.h);
    }
    ctx.fillStyle = LABEL;
    ctx.textBaseline = 'bottom';
    for (const v of [0, 50, 100]) {
      ctx.textAlign = v === 0 ? 'left' : v === 100 ? 'right' : 'center';
      ctx.fillText(String(v), r.x + (r.w * v) / 100 + (v === 0 ? 2 * k : v === 100 ? -2 * k : 0), r.y + r.h - 2 * k);
    }
    return;
  }
  // vectorscope
  const u = r.w / 2 / (VECTOR_RANGE / zoom);
  const cx = r.x + r.w / 2,
    cy = r.y + r.h / 2;
  const px = (cb: number): number => cx + cb * u;
  const py = (cr: number): number => cy - cr * u;
  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.clip();
  ctx.lineWidth = line;
  ctx.strokeStyle = GRID;
  ctx.beginPath();
  ctx.arc(cx, cy, 0.5 * u, 0, Math.PI * 2);
  ctx.moveTo(r.x, cy);
  ctx.lineTo(r.x + r.w, cy);
  ctx.moveTo(cx, r.y);
  ctx.lineTo(cx, r.y + r.h);
  ctx.stroke();
  // the 75% boxes with their names, the 100% dots
  const box = Math.max(3 * k, 0.03 * u);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.strokeStyle = GRID_EDGE;
  ctx.fillStyle = LABEL;
  for (const t of vectorTargets(0.75)) {
    ctx.strokeRect(px(t.cb) - box, py(t.cr) - box, 2 * box, 2 * box);
    // the name sits outside the box, away from the middle
    const d = Math.hypot(t.cb, t.cr) || 1;
    ctx.fillText(t.id, px(t.cb) + (t.cb / d) * (box + 7 * k), py(t.cr) - (t.cr / d) * (box + 7 * k));
  }
  for (const t of vectorTargets(1)) {
    ctx.beginPath();
    ctx.arc(px(t.cb), py(t.cr), Math.max(1.2 * k, 1), 0, Math.PI * 2);
    ctx.fill();
  }
  // the skin line
  const reach = Math.min(0.5, VECTOR_RANGE / zoom) * u;
  ctx.setLineDash([4 * k, 3 * k]);
  ctx.strokeStyle = 'rgba(255,200,150,0.5)';
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + SKIN_DIR.cb * reach, cy - SKIN_DIR.cr * reach);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(255,200,150,0.7)';
  ctx.textAlign = 'right';
  ctx.fillText('skin', cx + SKIN_DIR.cb * reach - 2 * k, cy - SKIN_DIR.cr * reach - 5 * k);
  ctx.restore();
}

/** the traces of a cell */
function drawTrace(ctx: Ctx, kind: ScopeKind, bins: ScopeBins, hist: Uint32Array, pixels: number, w: number, h: number, k: number, scratch: PlotScratch): void {
  const r = plotRect(kind, w, h, k);
  if (r.w < 1 || r.h < 1) return;
  // putImageData neither blends nor scales: the trace goes on a scratch canvas, then drawImage
  const put = (img: Uint8ClampedArray, iw: number, ih: number, dx: number, dy: number, dw: number, dh: number): void => {
    if (!hasOffscreen()) return;
    const c = scratch.canvas ?? (scratch.canvas = new OffscreenCanvas(iw, ih));
    if (c.width !== iw) c.width = iw;
    if (c.height !== ih) c.height = ih;
    const g = c.getContext('2d');
    if (!g) return;
    g.putImageData(new ImageData(img as Uint8ClampedArray<ArrayBuffer>, iw, ih), 0, 0);
    ctx.drawImage(c, 0, 0, iw, ih, dx, dy, dw, dh);
  };
  if (kind === 'waveform') {
    if (bins.wave.length === 0) return;
    scratch.trace = traceImage(bins.wave, bins.w, bins.h, TRACE.luma, scratch.trace ?? undefined);
    put(scratch.trace, bins.w, 256, r.x, r.y, r.w, r.h);
  } else if (kind === 'parade') {
    if (bins.parade.length === 0) return;
    const gap = PARADE_GAP * k;
    const third = (r.w - 2 * gap) / 3;
    const colors = [TRACE.r, TRACE.g, TRACE.b] as const;
    for (let i = 0; i < 3; i++) {
      const plane = bins.parade.subarray(i * bins.w * 256, (i + 1) * bins.w * 256);
      scratch.trace = traceImage(plane, bins.w, bins.h, colors[i]!, scratch.trace ?? undefined);
      put(scratch.trace, bins.w, 256, r.x + i * (third + gap), r.y, third, r.h);
    }
  } else if (kind === 'vectorscope') {
    if (bins.vector.length === 0) return;
    scratch.vec = vectorImage(bins.vector, bins.pixels, bins.zoom, scratch.vec ?? undefined);
    put(scratch.vec, VECTOR_N, VECTOR_N, r.x, r.y, r.w, r.h);
  } else {
    const peak = histogramPeak(hist);
    const bw = r.w / 256;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const names = [TRACE.r, TRACE.g, TRACE.b] as const;
    for (let c = 0; c < 3; c++) {
      ctx.fillStyle = `rgba(${names[c]!.join(',')},0.55)`;
      for (let v = 0; v < 256; v++) {
        const n = hist[c * 256 + v] ?? 0;
        if (n === 0) continue;
        const bh = Math.min(1, n / peak) * r.h;
        ctx.fillRect(r.x + v * bw, r.y + r.h - bh, Math.ceil(bw) + 0.5, bh);
      }
    }
    ctx.restore();
    // luma: a 1 px line
    ctx.strokeStyle = `rgb(${TRACE.luma.join(',')})`;
    ctx.lineWidth = Math.max(1, Math.round(k));
    ctx.beginPath();
    for (let v = 0; v < 256; v++) {
      const y = r.y + r.h - Math.min(1, (hist[768 + v] ?? 0) / peak) * r.h;
      if (v === 0) ctx.moveTo(r.x + v * bw, y);
      else ctx.lineTo(r.x + v * bw, y);
    }
    ctx.stroke();
    // a clip mark at an end over 0.1%
    const clipBlack = Math.max(hist[0]!, hist[256]!, hist[512]!, hist[768]!) / pixels;
    const clipWhite = Math.max(hist[255]!, hist[511]!, hist[767]!, hist[1023]!) / pixels;
    ctx.fillStyle = `rgb(${TRACE.r.join(',')})`;
    if (clipBlack > 0.001) ctx.fillRect(r.x, r.y, 3 * k, r.h);
    if (clipWhite > 0.001) ctx.fillRect(r.x + r.w - 3 * k, r.y, 3 * k, r.h);
  }
}

/**
 * paints one cell: black, the trace, the graticule. w, h backing px, k backing px per css px. no bins, or 0 pixels:
 * black plus the graticule. cells under 24 css px are not painted.
 */
export function paintScope(ctx: Ctx, kind: ScopeKind, bins: ScopeBins | null, hist: Uint32Array | null, pixels: number, size: { w: number; h: number; k: number; zoom: 1 | 2 }, scratch: PlotScratch = plotScratch()): void {
  const { w, h, k, zoom } = size;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  if (w / k < 24 || h / k < 24) return;
  if (bins && hist && pixels > 0) drawTrace(ctx, kind, bins, hist, pixels, w, h, k, scratch);
  const key = `${kind}|${w}|${h}|${zoom}|${k}`;
  if (hasOffscreen()) {
    if (scratch.gratKey !== key || !scratch.grat) {
      const c = new OffscreenCanvas(w, h);
      const g = c.getContext('2d');
      if (g) {
        drawGraticule(g, kind, w, h, k, zoom);
        scratch.grat = c;
        scratch.gratKey = key;
      } else {
        scratch.grat = null;
      }
    }
    if (scratch.grat) {
      ctx.drawImage(scratch.grat, 0, 0);
      return;
    }
  }
  drawGraticule(ctx, kind, w, h, k, zoom);
}
