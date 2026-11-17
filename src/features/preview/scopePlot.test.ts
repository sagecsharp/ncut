import { describe, expect, it } from 'vitest';
import { gridLabels, histogramPeak, LABEL_W, percentText, PLOT_PAD, plotRect, statsLine, TRACE, traceAlpha, traceImage, VECTOR_GAIN, vectorImage } from './scopePlot';
import { VECTOR_N } from './scopes';

const hist = (): Uint32Array => new Uint32Array(1024);

describe('traces', () => {
  it('traceAlpha bounds', () => {
    expect(traceAlpha(0)).toBe(0);
    expect(traceAlpha(-1)).toBe(0);
    expect(traceAlpha(1e-9)).toBe(0.1);
    expect(traceAlpha(1)).toBeLessThanOrEqual(1);
    expect(traceAlpha(1)).toBeGreaterThan(0.99);
    expect(traceAlpha(0.01)).toBeGreaterThan(traceAlpha(0.001));
  });
  it('traceImage puts level 255 on top', () => {
    const counts = new Uint32Array(2 * 256);
    counts[0 * 256 + 255] = 10;
    counts[1 * 256 + 0] = 10;
    const img = traceImage(counts, 2, 10, TRACE.r);
    expect(img.length).toBe(2 * 256 * 4);
    // column 0, row 0: level 255, alpha full, the trace color
    expect(Array.from(img.subarray(0, 4))).toEqual([255, 72, 72, 255]);
    // column 1, row 255: level 0
    expect(img[(255 * 2 + 1) * 4 + 3]).toBeGreaterThan(0);
    // empty
    expect(img[(100 * 2 + 0) * 4 + 3]).toBe(0);
    // a reused buffer is written whole
    const again = traceImage(new Uint32Array(2 * 256), 2, 10, TRACE.r, img);
    expect(again).toBe(img);
    expect(again[3]).toBe(0);
  });
  it('vectorImage colors', () => {
    const v = new Uint32Array(VECTOR_N * VECTOR_N);
    v[21 * 256 + 103] = 50; // red
    v[137 * 256 + 234] = 50; // blue
    v[128 * 256 + 128] = 50; // the middle
    const img = vectorImage(v, 1000, 1);
    const px = (col: number, row: number) => Array.from(img.subarray((row * 256 + col) * 4, (row * 256 + col) * 4 + 4));
    const red = px(103, 21);
    expect(red[0]).toBe(255);
    expect(red[0]!).toBeGreaterThan(red[1]!);
    expect(red[0]!).toBeGreaterThan(red[2]!);
    const blue = px(234, 137);
    expect(blue[2]).toBe(255);
    expect(blue[2]!).toBeGreaterThan(blue[0]!);
    expect(blue[2]!).toBeGreaterThan(blue[1]!);
    // next to the middle the color is the trace gray
    const mid = px(128, 128);
    expect(Math.abs(mid[0]! - TRACE.luma[0])).toBeLessThan(15);
    expect(Math.abs(mid[2]! - TRACE.luma[2])).toBeLessThan(15);
    expect(mid[3]).toBeGreaterThan(0);
    // an empty bin has no alpha
    expect(px(0, 0)[3]).toBe(0);
  });
  it('vector gain grows with zoom squared', () => {
    const v = new Uint32Array(VECTOR_N * VECTOR_N);
    v[21 * 256 + 103] = 1;
    const pixels = 100000;
    const a1 = vectorImage(v, pixels, 1)[(21 * 256 + 103) * 4 + 3]!;
    const a2 = vectorImage(v, pixels, 2)[(21 * 256 + 103) * 4 + 3]!;
    expect(a1).toBe(Math.round(255 * traceAlpha((1 / pixels) * VECTOR_GAIN)));
    expect(a2).toBe(Math.round(255 * traceAlpha((1 / pixels) * VECTOR_GAIN * 4)));
    expect(a2).toBeGreaterThan(a1);
  });
});

describe('numbers and text', () => {
  it('histogramPeak ignores the ends', () => {
    const h = hist();
    h[0] = 1000;
    h[255] = 900;
    h[768] = 800;
    h[100] = 5;
    h[256 + 200] = 7;
    expect(histogramPeak(h)).toBe(7);
    expect(histogramPeak(hist())).toBe(1);
  });
  it('gridLabels', () => {
    expect(gridLabels(200)).toEqual([0, 20, 40, 60, 80, 100]);
    expect(gridLabels(119)).toEqual([0, 50, 100]);
    expect(gridLabels(120)).toEqual([0, 20, 40, 60, 80, 100]);
  });
  it('statsLine', () => {
    const w = hist();
    w[768 + 5] = 1;
    w[768 + 250] = 1;
    w[768 + 97] = 1;
    expect(statsLine('waveform', w, 3)).toBe('luma 2 to 98, mean 46');
    const p = hist();
    p[133] = 1;
    p[256 + 120] = 1;
    p[512 + 102] = 1;
    expect(statsLine('parade', p, 1)).toBe('mean r 52, g 47, b 40');
    const h = hist();
    h[768] = 4;
    h[1023] = 12;
    h[768 + 100] = 984;
    expect(statsLine('histogram', h, 1000)).toBe('black 0.4%, white 1.2%');
    expect(statsLine('vectorscope', h, 1000)).toBe('');
    expect(statsLine('waveform', h, 0)).toBe('');
  });
  it('percentText', () => {
    expect(percentText(0)).toBe('0%');
    expect(percentText(0.0004)).toBe('<0.1%');
    expect(percentText(0.004)).toBe('0.4%');
    expect(percentText(0.5)).toBe('50%');
    expect(percentText(1)).toBe('100%');
  });
});

describe('plotRect', () => {
  it('plotRect keeps the vectorscope square', () => {
    const v = plotRect('vectorscope', 300, 200, 1);
    expect(v.w).toBe(v.h);
    expect(v.h).toBe(200 - 2 * PLOT_PAD);
    expect(v.x).toBe((300 - v.w) / 2);
    expect(v.y).toBe(PLOT_PAD);
    const t = plotRect('vectorscope', 100, 400, 2);
    expect(t.w).toBe(t.h);
    expect(t.w).toBe(100 - 4 * PLOT_PAD);
    const w = plotRect('waveform', 300, 200, 2);
    expect(w.x).toBe(2 * (PLOT_PAD + LABEL_W));
    expect(w.y).toBe(2 * PLOT_PAD);
    expect(w.w).toBe(300 - w.x - 2 * PLOT_PAD);
    expect(w.h).toBe(200 - 4 * PLOT_PAD);
    expect(plotRect('parade', 10, 10, 1).w).toBe(0);
  });
});
