import type { SceneFog } from '../../types';
import { isHex } from './edit';

/** the farthest distance (project pixels) the ui offers */
export const FOG_MAX = 50000;
/** far stays at least this much past near */
export const FOG_GAP = 10;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** fog when switched on: the project background (if it is a plain hex color) as the haze color */
export function defaultFog(background: string): SceneFog {
  return { color: isHex(background) ? background.slice(0, 7).toLowerCase() : '#000000', near: 500, far: 4000, amount: 1 };
}

/** near moved; far is pushed along so it stays past near */
export function setFogNear(fog: SceneFog, near: number): SceneFog {
  const n = clamp(Number.isFinite(near) ? Math.round(near) : 0, 0, FOG_MAX - FOG_GAP);
  return { ...fog, near: n, far: Math.max(fog.far, n + FOG_GAP) };
}

/** far moved; never closer than near + the gap */
export function setFogFar(fog: SceneFog, far: number): SceneFog {
  const f = clamp(Number.isFinite(far) ? Math.round(far) : fog.far, fog.near + FOG_GAP, FOG_MAX);
  return { ...fog, far: f };
}

/** strength typed as percent (0..100) */
export function setFogAmount(fog: SceneFog, percent: number): SceneFog {
  return { ...fog, amount: Number((clamp(Number.isFinite(percent) ? percent : 0, 0, 100) / 100).toFixed(4)) };
}
