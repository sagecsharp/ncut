/**
 * scene fog (types.ts SceneFog) as pure math. renderer.ts runs the same math in its fragment shader
 * (the block marked FOG MATH in PLANE_FS): the two must match. if you change one, change the other.
 *
 *   f = clamp((dist - near) / (far - near), 0, 1) * amount
 *   rgb = mix(rgb, fogColor, f)        // on the un-premultiplied color; alpha is kept
 *
 * dist = distance from the eye to the fragment in world units (pixels of the canvas).
 */
import type { SceneFog } from '../../types';

export type Rgb = [number, number, number];

/** true when the fog does anything: amount above 0 and far past near */
export function fogOn(fog: SceneFog | null | undefined): fog is SceneFog {
  return !!fog && fog.amount > 0 && fog.far > fog.near;
}

/** 0..1, how much of the fog color is mixed in at a distance. 0 when the fog is off. */
export function fogFactor(dist: number, fog: SceneFog | null | undefined): number {
  if (!fogOn(fog)) return 0;
  const t = (dist - fog.near) / (fog.far - fog.near);
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  const amount = fog.amount > 1 ? 1 : fog.amount;
  const f = clamped * amount;
  return f === f ? f : 0;
}

/** a color (0..1 floats, not premultiplied) moved toward the fog color by f (0 = unchanged, 1 = the fog color) */
export function mixFog(rgb: Rgb, fogRgb: Rgb, f: number): Rgb {
  return [rgb[0] + (fogRgb[0] - rgb[0]) * f, rgb[1] + (fogRgb[1] - rgb[1]) * f, rgb[2] + (fogRgb[2] - rgb[2]) * f];
}

const colorCache = new Map<string, Rgb>();
const BLACK: Rgb = [0, 0, 0];

/**
 * a css hex color (#rgb, #rgba, #rrggbb, #rrggbbaa; alpha ignored) as 0..1 floats. anything else is
 * black. cached per string, so the returned array must not be changed.
 */
export function parseFogColor(css: string): Rgb {
  const hit = colorCache.get(css);
  if (hit) return hit;
  let out: Rgb = BLACK;
  const m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(css.trim());
  if (m) {
    let h = m[1]!;
    if (h.length <= 4) h = h.replace(/./g, (c) => c + c);
    out = [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
  }
  if (colorCache.size > 64) colorCache.clear();
  colorCache.set(css, out);
  return out;
}

/**
 * the six numbers the shader reads, written into `out` (no allocation):
 * [r, g, b, near, far - near, amount]. amount is 0 when the fog is off, which switches the shader part off.
 */
export function writeFogUniforms(fog: SceneFog | null | undefined, out: Float32Array | number[]): void {
  if (!fogOn(fog)) {
    out[5] = 0;
    return;
  }
  const c = parseFogColor(fog.color);
  out[0] = c[0];
  out[1] = c[1];
  out[2] = c[2];
  out[3] = fog.near;
  out[4] = fog.far - fog.near;
  out[5] = fog.amount > 1 ? 1 : fog.amount;
}
