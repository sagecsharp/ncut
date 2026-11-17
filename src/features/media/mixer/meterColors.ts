import { APPEARANCE_EVENT } from '../../../lib/appearance';

/** the meter's colors as rgba strings (the tokens are oklch, a canvas wants rgb) */
export interface MeterColors { low: string; mid: string; high: string; empty: string }

const FALLBACK: MeterColors = {
  low: 'rgba(200, 200, 210, 1)',
  mid: 'rgba(230, 190, 90, 1)',
  high: 'rgba(235, 100, 90, 1)',
  empty: 'rgba(60, 60, 66, 1)',
};

let cache: MeterColors | null = null;
let listening = false;
const redraws = new Set<() => void>();

/** call back after the colors were dropped on a theme change, so a paused meter paints again. returns the undo */
export function onMeterColors(fn: () => void): () => void {
  redraws.add(fn);
  return () => {
    redraws.delete(fn);
  };
}

/** one token as rgba: a probe span takes the computed color, a 1x1 canvas turns any css color syntax into rgb */
function resolve(token: string, fallback: string): string {
  try {
    const probe = document.createElement('span');
    probe.style.color = `var(${token})`;
    probe.style.display = 'none';
    document.body.appendChild(probe);
    const css = getComputedStyle(probe).color;
    document.body.removeChild(probe);
    const c = document.createElement('canvas');
    c.width = 1;
    c.height = 1;
    const cx = c.getContext('2d', { willReadFrequently: true });
    if (!cx || !css) return fallback;
    cx.clearRect(0, 0, 1, 1);
    cx.fillStyle = css;
    cx.fillRect(0, 0, 1, 1);
    const d = cx.getImageData(0, 0, 1, 1).data;
    return `rgba(${d[0]}, ${d[1]}, ${d[2]}, ${(d[3]! / 255).toFixed(3)})`;
  } catch {
    return fallback;
  }
}

/** accent below -9 db, warn up to 0 db, danger above, the empty track the raised surface. cached until the theme changes */
export function meterColors(): MeterColors {
  if (cache) return cache;
  if (typeof document === 'undefined') return FALLBACK;
  if (!listening && typeof window !== 'undefined') {
    listening = true;
    window.addEventListener(APPEARANCE_EVENT, () => {
      cache = null;
      for (const fn of [...redraws]) fn();
    });
  }
  cache = {
    low: resolve('--accent', FALLBACK.low),
    mid: resolve('--warn', FALLBACK.mid),
    high: resolve('--danger', FALLBACK.high),
    empty: resolve('--surface-3', FALLBACK.empty),
  };
  return cache;
}
