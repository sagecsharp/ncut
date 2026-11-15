import type { Project, SceneLight } from '../../types';
import { DEFAULT_SUN, autoLightAt } from '../../engine/scene3d/light';
import { clampFrameTime } from '../../lib/frameTime';
import { projectDuration } from '../../lib/timelineOps';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const tenth = (v: number) => Math.round(v * 10) / 10;

/** the time the scene is read at: the playhead, but never the empty end of the timeline (the last frame instead) */
export function sceneTime(project: Project, time: number): number {
  return clampFrameTime(time, projectDuration(project), project.fps);
}

/** the own light when it is switched on: the dome the scene gives at the time, and the default sun */
export function defaultLight(project: Project, time: number): SceneLight {
  const { sky, horizon, ground } = autoLightAt(project, sceneTime(project, time));
  return { sky, horizon, ground, ...DEFAULT_SUN };
}

/** sun share typed as percent 0..100 (4 decimals stored, like the fog strength) */
export function setSunPercent(light: SceneLight, percent: number): SceneLight {
  return { ...light, sun: Number((clamp(Number.isFinite(percent) ? percent : 0, 0, 100) / 100).toFixed(4)) };
}

/** turn in degrees, 0.1 degree steps, then wrapped into -180..180 (-180 and 180 both stay as given). not finite = unchanged */
export function setSunTurn(light: SceneLight, deg: number): SceneLight {
  if (!Number.isFinite(deg)) return light;
  let t = tenth(deg % 360);
  if (t > 180) t -= 360;
  else if (t < -180) t += 360;
  return { ...light, sunTurn: tenth(t) + 0 };
}

/** height clamped to 0..90, 0.1 degree steps. not finite = unchanged */
export function setSunHeight(light: SceneLight, deg: number): SceneLight {
  if (!Number.isFinite(deg)) return light;
  return { ...light, sunHeight: tenth(clamp(deg, 0, 90)) + 0 };
}

/** true when two lights say the same (colors compared lowercased) */
export function sameLight(a: SceneLight, b: SceneLight): boolean {
  return (
    a.sky.toLowerCase() === b.sky.toLowerCase() &&
    a.horizon.toLowerCase() === b.horizon.toLowerCase() &&
    a.ground.toLowerCase() === b.ground.toLowerCase() &&
    a.sunColor.toLowerCase() === b.sunColor.toLowerCase() &&
    a.sun === b.sun &&
    a.sunTurn === b.sunTurn &&
    a.sunHeight === b.sunHeight
  );
}

/** the auto light at a time as one string (sky horizon ground), for a selector that re-renders only when a color changes */
export function autoKey(project: Project, time: number): string {
  const { sky, horizon, ground } = autoLightAt(project, sceneTime(project, time));
  return `${sky} ${horizon} ${ground}`;
}
