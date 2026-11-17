/**
 * the pixel probe maths: hold alt over the picture to read one pixel. pure (no dom, no store).
 */
import { lumaOf } from './scopes';

/** the picture pixel under a pointer, null outside the picture rect */
export function probePixel(cx: number, cy: number, rect: { left: number; top: number; width: number; height: number }, bw: number, bh: number): { x: number; y: number } | null {
  if (!(rect.width > 0) || !(rect.height > 0) || !(bw >= 1) || !(bh >= 1)) return null;
  const fx = (cx - rect.left) / rect.width;
  const fy = (cy - rect.top) / rect.height;
  if (!(fx >= 0 && fx < 1 && fy >= 0 && fy < 1)) return null;
  return { x: Math.min(bw - 1, Math.floor(fx * bw)), y: Math.min(bh - 1, Math.floor(fy * bh)) };
}

/** where the box goes: right and below the pointer by gap, flipped at the edges, kept inside the area */
export function probePlace(x: number, y: number, boxW: number, boxH: number, areaW: number, areaH: number, gap = 14): { x: number; y: number } {
  let px = x + gap;
  let py = y + gap;
  if (px + boxW > areaW) px = x - gap - boxW;
  if (py + boxH > areaH) py = y - gap - boxH;
  return { x: Math.max(0, Math.min(Math.max(0, areaW - boxW), px)), y: Math.max(0, Math.min(Math.max(0, areaH - boxH), py)) };
}

const pad = (n: number, width: number): string => String(n).padStart(width, ' ');

/** hsl by the hex cone formula: h 0..359, s and l 0..100 (a gray is h 0, s 0) */
function hslOf(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  const d = max - min;
  const l = (max + min) / 2 / 255;
  if (d === 0) return { h: 0, s: 0, l: Math.round(l * 100) };
  const s = d / 255 / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = ((g - b) / d + 6) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: Math.round(h * 60) % 360, s: Math.round(s * 100), l: Math.round(l * 100) };
}

/** three padded lines: (235, 120, 64) gives 'rgb 235 120  64', 'hsl  20  81%  59%', 'luma  54.9 #eb7840' */
export function probeText(r: number, g: number, b: number): string[] {
  const hsl = hslOf(r, g, b);
  const hex = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
  const luma = ((lumaOf(r, g, b) * 100) / 255).toFixed(1).padStart(5, ' ');
  return [`rgb ${pad(r, 3)} ${pad(g, 3)} ${pad(b, 3)}`, `hsl ${pad(hsl.h, 3)} ${pad(hsl.s, 3)}% ${pad(hsl.l, 3)}%`, `luma ${luma} ${hex}`];
}

/** the probe works in the output view only, with alt held and no mouse button down */
export const probeShows = (alt: boolean, buttons: number, mode: string): boolean => alt && buttons === 0 && mode === 'output';
