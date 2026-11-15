/**
 * the light of a sky for lit 3d clips (types.ts SceneLight), worked out once from small samples of its six sides
 * (sky.ts SKY_SAMPLE square, rgba, side order, turned, drawn on black). at turn 0 and brightness 1: light.ts
 * skyLightOf turns and scales it. in linear light (light.ts toLinear). per texel: d = its unit direction in cube space
 * (y up), w = its solid angle (1 / r^3 of the face point, r its distance from the center).
 *   sky     = the mean of the upper half weighted by up (what a top facing up gets)
 *   ground  = the same for the lower half
 *   horizon = the mean of all weighted by sqrt(1 - up^2) (what a wall gets, averaged around)
 *   sun     = the brightest spot above the horizon, as strong as the half of the sky it faces is brighter than the other half
 */
import type { SceneLight } from '../../types';
import { DEFAULT_SUN, linearToHex, toLinear } from './light';
import { faceDirection, wrapDeg } from './sky';
import { DEG } from './math';

/** a spot this many degrees around the brightest texel ... */
export const SUN_SPOT_DEG = 15;
/** ... with at least this share of its brightness is the sun */
export const SUN_SPOT_SHARE = 0.9;
/** the sun stands above this (unit up) */
export const SUN_MIN_UP = 0.02;
/** the most the sun takes of the light */
export const SUN_MAX = 0.5;
/** a sunny half this many times brighter than the other gives SUN_MAX (contrast 1 gives 0) */
export const SUN_CONTRAST_RANGE = 4;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export function measureSkyLight(faces: readonly Uint8ClampedArray[], n: number): SceneLight {
  const count = 6 * n * n;
  const dir = new Float32Array(count * 3);
  const w = new Float32Array(count);
  const lin = new Float32Array(count * 3);
  const lum = new Float32Array(count);
  // 1. direction, solid angle, linear color and luminance of every texel
  let k = 0;
  for (let f = 0; f < 6; f++) {
    const px = faces[f]!;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++, k++) {
        const v = faceDirection(f, (x + 0.5) / n, (y + 0.5) / n);
        const r2 = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
        const r = Math.sqrt(r2);
        w[k] = 1 / (r2 * r);
        dir[k * 3] = v[0] / r;
        dir[k * 3 + 1] = v[1] / r;
        dir[k * 3 + 2] = v[2] / r;
        const o = (y * n + x) * 4;
        const lr = toLinear(px[o]! / 255);
        const lg = toLinear(px[o + 1]! / 255);
        const lb = toLinear(px[o + 2]! / 255);
        lin[k * 3] = lr;
        lin[k * 3 + 1] = lg;
        lin[k * 3 + 2] = lb;
        lum[k] = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
      }
    }
  }
  // 2. the three means
  const mean = (weight: (up: number) => number): [number, number, number] => {
    let r = 0;
    let g = 0;
    let b = 0;
    let sum = 0;
    for (let i = 0; i < count; i++) {
      const q = w[i]! * weight(dir[i * 3 + 1]!);
      if (q === 0) continue;
      r += lin[i * 3]! * q;
      g += lin[i * 3 + 1]! * q;
      b += lin[i * 3 + 2]! * q;
      sum += q;
    }
    return sum > 0 ? [r / sum, g / sum, b / sum] : [0, 0, 0];
  };
  const sky = mean((up) => Math.max(up, 0));
  const ground = mean((up) => Math.max(-up, 0));
  const horizon = mean((up) => Math.sqrt(Math.max(0, 1 - up * up)));

  // 3. the sun. 4. no sun keeps the look of the default sun (sun 0)
  let sun = 0;
  let sunColor: string = DEFAULT_SUN.sunColor;
  let sunTurn: number = DEFAULT_SUN.sunTurn;
  let sunHeight: number = DEFAULT_SUN.sunHeight;
  let m = -1;
  for (let i = 0; i < count; i++) {
    if (dir[i * 3 + 1]! > SUN_MIN_UP && (m < 0 || lum[i]! > lum[m]!)) m = i;
  }
  if (m >= 0 && lum[m]! > 1e-4) {
    const cosSpot = Math.cos(SUN_SPOT_DEG * DEG);
    const mx = dir[m * 3]!;
    const my = dir[m * 3 + 1]!;
    const mz = dir[m * 3 + 2]!;
    let sx = 0;
    let sy = 0;
    let sz = 0;
    let cr = 0;
    let cg = 0;
    let cb = 0;
    let cw = 0;
    for (let i = 0; i < count; i++) {
      const dx = dir[i * 3]!;
      const dy = dir[i * 3 + 1]!;
      const dz = dir[i * 3 + 2]!;
      if (dx * mx + dy * my + dz * mz < cosSpot || lum[i]! < SUN_SPOT_SHARE * lum[m]!) continue;
      const q = lum[i]! * w[i]!;
      sx += dx * q;
      sy += dy * q;
      sz += dz * q;
      cr += lin[i * 3]! * w[i]!;
      cg += lin[i * 3 + 1]! * w[i]!;
      cb += lin[i * 3 + 2]! * w[i]!;
      cw += w[i]!;
    }
    const len = Math.hypot(sx, sy, sz);
    if (len > 0 && cw > 0) {
      const d: [number, number, number] = [sx / len, sy / len, sz / len];
      const hl = Math.hypot(d[0], d[2]);
      const axis: [number, number, number] = hl >= 0.05 ? [d[0] / hl, 0, d[2] / hl] : d;
      const energy = (a: [number, number, number]) => {
        let num = 0;
        let den = 0;
        for (let i = 0; i < count; i++) {
          const p = dir[i * 3]! * a[0] + dir[i * 3 + 1]! * a[1] + dir[i * 3 + 2]! * a[2];
          // an axis along the horizon counts the half of the sky it faces only, the ground gives no contrast
          if (p <= 0 || (a[1] === 0 && dir[i * 3 + 1]! <= 0)) continue;
          num += lum[i]! * w[i]! * p;
          den += w[i]! * p;
        }
        return den > 0 ? num / den : 0;
      };
      const contrast = energy(axis) / Math.max(energy([-axis[0], -axis[1], -axis[2]]), 1e-4);
      const share = Number((clamp((contrast - 1) / SUN_CONTRAST_RANGE, 0, 1) * SUN_MAX).toFixed(4));
      if (share >= 0.01) {
        sun = share;
        const rgb: [number, number, number] = [cr / cw, cg / cw, cb / cw];
        const top = Math.max(rgb[0], rgb[1], rgb[2]);
        sunColor = linearToHex(top > 0 ? [rgb[0] / top, rgb[1] / top, rgb[2] / top] : [1, 1, 1]);
        sunTurn = wrapDeg(Math.atan2(d[0], -d[2]) / DEG);
        sunHeight = Math.round(clamp(Math.asin(clamp(d[1], -1, 1)) / DEG, 0, 90) * 10) / 10;
      }
    }
  }
  // 5.
  return {
    sky: linearToHex(sky),
    horizon: linearToHex(horizon),
    ground: linearToHex(ground),
    sun,
    sunColor,
    sunTurn,
    sunHeight,
  };
}
