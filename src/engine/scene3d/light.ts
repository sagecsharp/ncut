/**
 * light for lit 3d clips (Spatial.lit), as pure math (no dom, no gl). renderer.ts runs the per-normal part in LIT_VS (the
 * block marked LIGHT MATH): the two must match. if you change one, change the other.
 *
 * a sky dome and one sun, in linear light (srgb ^ LIGHT_GAMMA). n = the unit normal in the world, world y points down:
 *   up   = -n.y
 *   dome = sky * max(up, 0) + horizon * (1 - |up|) + ground * max(-up, 0)
 *   L    = (1 - sun) * dome + sun * sunColor * max(dot(n, toSun), 0)
 *   f    = (1 + (L - 1) * k) ^ (1 / LIGHT_GAMMA)     k = the clip's lit, 0..1
 * the picture stays srgb: rgb * f is the linear picture lit by L, back in srgb. every term is 0..1, so f is 0..1: a
 * premultiplied color stays valid and nothing is clamped.
 *
 * without an own light, a project with a usable sky (Project.sky) takes the light that was measured from the sky
 * pictures when the sky was set (skyLightOf): turned with the sky, times its brightness, the horizon mixed with the fog.
 * without a sky the dome is read off the project data behind the 3d clips, never off pixels (preview, export and
 * export workers agree): the background and the 2d shape clips painted under the lowest 3d
 * clip, at fixed points of the frame. sky = the upper part, horizon = the middle row mixed with the fog color by the fog
 * amount, ground = AUTO_GROUND of the horizon. no sun.
 */
import type { Clip, MediaAsset, Project, SceneFog, SceneLight, SceneSky, ShapeClip, Transform } from '../../types';
import { isVisualClip, stretchX, stretchY } from '../../types';
import { resolveClip } from '../../lib/anim';
import { clipEnd, fadeFactor } from '../../lib/timelineOps';
import { applyClipMotion, hasClipMotion } from '../clipAnim';
import { worldTransformOf } from '../parent';
import { pivotFraction } from '../pivot';
import { faceSourceSet } from './faces';
import { matteSourceSet } from '../matte';
import { fogOn, parseFogColor, type Rgb } from './fog';
import { skyBrightness, skyTurn, skyUsable, wrapDeg } from './sky';

/** srgb to linear light and back. LIT_VS has the same number (1.0 / 2.2): keep them equal */
export const LIGHT_GAMMA = 2.2;
/** the light from the scene: what comes up from the ground, as a share of the horizon (linear) */
export const AUTO_GROUND = 0.35;
/** what the inspector's lit switch sets */
export const LIT_ON = 0.75;
/** the sun of an own light when it is switched on (its dome comes from the scene at the playhead) */
export const DEFAULT_SUN = { sun: 0.4, sunColor: '#fff4e0', sunTurn: -35, sunHeight: 45 } as const;

/** the light of one render */
export interface LightRig {
  /**
   * the 15 numbers of the shader's u_env, in this order: sky, horizon, ground (linear, already times 1 - sun), the unit
   * direction toward the sun, the sun color (linear, already times sun). never changed after it is made.
   */
  readonly env: Float32Array;
}

/** what the scene gives when there is no own light, as #rrggbb (for the inspector and the mcp) */
export interface AutoLight {
  sky: string;
  horizon: string;
  ground: string;
}

function clamp01(v: number): number {
  return v > 0 ? (v < 1 ? v : 1) : 0;
}

export function toLinear(c: number): number {
  return Math.pow(clamp01(c), LIGHT_GAMMA);
}

export function toSrgb(c: number): number {
  return Math.pow(clamp01(c), 1 / LIGHT_GAMMA);
}

/** a css hex color as linear light. not a hex = black */
export function hexToLinear(hex: string): Rgb {
  const c = parseFogColor(typeof hex === 'string' ? hex : '');
  return [toLinear(c[0]), toLinear(c[1]), toLinear(c[2])];
}

/** linear light as #rrggbb */
export function linearToHex(c: Rgb): string {
  let out = '#';
  for (let i = 0; i < 3; i++) out += Math.round(toSrgb(c[i]!) * 255).toString(16).padStart(2, '0');
  return out;
}

/**
 * the unit vector toward the sun. turn 0 = toward -z (behind the camera), 90 = +x. height 90 = -y (straight above,
 * world y points down). a number that is not finite counts as 0 for the turn and 45 for the height.
 */
export function sunDirection(turnDeg: number, heightDeg: number): Rgb {
  const t = (Number.isFinite(turnDeg) ? turnDeg : 0) * (Math.PI / 180);
  const hd = Number.isFinite(heightDeg) ? heightDeg : 45;
  const h = (hd < 0 ? 0 : hd > 90 ? 90 : hd) * (Math.PI / 180);
  const ch = Math.cos(h);
  return [Math.sin(t) * ch, -Math.sin(h), -Math.cos(t) * ch];
}

function writeEnv(out: Float32Array, sky: Rgb, horizon: Rgb, ground: Rgb, sun: number, toSun: Rgb, sunColor: Rgb): void {
  const s = Number.isFinite(sun) ? clamp01(sun) : 0;
  const d = 1 - s;
  for (let i = 0; i < 3; i++) {
    out[i] = sky[i]! * d;
    out[3 + i] = horizon[i]! * d;
    out[6 + i] = ground[i]! * d;
    out[9 + i] = toSun[i]!;
    out[12 + i] = sunColor[i]! * s;
  }
}

const rigMemo = new WeakMap<SceneLight, LightRig>();

/** the rig of an own light. the same light object gives the same rig object */
export function lightRigFrom(light: SceneLight): LightRig {
  const hit = rigMemo.get(light);
  if (hit) return hit;
  const env = new Float32Array(15);
  writeEnv(
    env,
    hexToLinear(light.sky),
    hexToLinear(light.horizon),
    hexToLinear(light.ground),
    light.sun,
    sunDirection(light.sunTurn, light.sunHeight),
    hexToLinear(light.sunColor),
  );
  const rig: LightRig = { env };
  rigMemo.set(light, rig);
  return rig;
}

/** true when a stored light has the fields the math reads (the light of a sky read from a file is checked here) */
function lightShaped(l: unknown): l is SceneLight {
  const o = l as Record<string, unknown> | null;
  return (
    !!o &&
    typeof o === 'object' &&
    typeof o.sky === 'string' &&
    typeof o.horizon === 'string' &&
    typeof o.ground === 'string' &&
    typeof o.sunColor === 'string' &&
    typeof o.sun === 'number' &&
    typeof o.sunTurn === 'number' &&
    typeof o.sunHeight === 'number'
  );
}

const skyMemo = new WeakMap<object, { fog: SceneFog | null | undefined; assets: readonly MediaAsset[]; light: SceneLight | null }>();

/**
 * the light the sky gives lit 3d clips: its measured light (turn 0, brightness 1) with the sun turned by the sky's
 * turn, the colors times brightness ^ LIGHT_GAMMA in linear light (at most 1), the horizon mixed with the fog color by
 * the fog amount like the scene light. null = no sky, its pictures are gone or its light is broken. the same sky, fog
 * and media list give the same object (so lightRigFrom keeps one rig).
 */
export function skyLightOf(project: Pick<Project, 'sky' | 'fog' | 'assets'>): SceneLight | null {
  const sky: SceneSky | null | undefined = project.sky;
  if (!sky || typeof sky !== 'object') return null;
  const hit = skyMemo.get(sky);
  if (hit && hit.fog === project.fog && hit.assets === project.assets) return hit.light;
  let light: SceneLight | null = null;
  if (skyUsable(project) && lightShaped(sky.light)) {
    const l = sky.light;
    const k = Math.pow(skyBrightness(sky), LIGHT_GAMMA);
    const lin = (hex: string): Rgb => {
      const c = hexToLinear(hex);
      return [Math.min(1, c[0] * k), Math.min(1, c[1] * k), Math.min(1, c[2] * k)];
    };
    let horizon = lin(l.horizon);
    const fog = project.fog;
    if (fogOn(fog)) {
      const f = Math.min(1, fog.amount);
      const fc = hexToLinear(fog.color);
      horizon = [horizon[0] + (fc[0] - horizon[0]) * f, horizon[1] + (fc[1] - horizon[1]) * f, horizon[2] + (fc[2] - horizon[2]) * f];
    }
    light = {
      sky: linearToHex(lin(l.sky)),
      horizon: linearToHex(horizon),
      ground: linearToHex(lin(l.ground)),
      sun: l.sun,
      sunColor: linearToHex(lin(l.sunColor)),
      sunTurn: wrapDeg(l.sunTurn + skyTurn(sky)),
      sunHeight: l.sunHeight,
    };
  }
  skyMemo.set(sky, { fog: project.fog, assets: project.assets, light });
  return light;
}

/**
 * LIGHT MATH (keep in sync with LIT_VS in renderer.ts): the factor a picture is multiplied by, for a unit world normal
 * and a lit amount k (0..1), written into out[0..2]
 */
export function litFactor(nx: number, ny: number, nz: number, k: number, env: ArrayLike<number>, out: Float32Array | number[]): void {
  const up = -ny;
  const wSky = up > 0 ? up : 0;
  const wGround = up < 0 ? -up : 0;
  const wSide = 1 - Math.abs(up);
  const ds = nx * env[9]! + ny * env[10]! + nz * env[11]!;
  const wSun = ds > 0 ? ds : 0;
  const kk = clamp01(k);
  for (let i = 0; i < 3; i++) {
    const L = env[i]! * wSky + env[3 + i]! * wSide + env[6 + i]! * wGround + env[12 + i]! * wSun;
    const m = 1 + (L - 1) * kk;
    out[i] = Math.pow(m > 1e-6 ? m : 1e-6, 1 / LIGHT_GAMMA);
  }
}

/**
 * the light of a plane, one normal for all of it: x axis cross y axis of its model, turned to the side the eye is on
 * (a plane shows both faces). out[0..2] = litFactor
 */
export function planeLight(
  model: ArrayLike<number>,
  eye: ArrayLike<number>,
  k: number,
  env: ArrayLike<number>,
  out: Float32Array | number[],
): void {
  let nx = model[1]! * model[6]! - model[2]! * model[5]!;
  let ny = model[2]! * model[4]! - model[0]! * model[6]!;
  let nz = model[0]! * model[5]! - model[1]! * model[4]!;
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len > 0) {
    nx /= len;
    ny /= len;
    nz /= len;
  } else {
    nx = 0;
    ny = 0;
    nz = -1;
  }
  const ex = eye[0]! - model[12]!;
  const ey = eye[1]! - model[13]!;
  const ez = eye[2]! - model[14]!;
  if (nx * ex + ny * ey + nz * ez < 0) {
    nx = -nx;
    ny = -ny;
    nz = -nz;
  }
  litFactor(nx, ny, nz, k, env, out);
}

const COLS = [0.1, 0.3, 0.5, 0.7, 0.9];
const SKY_ROWS = [0.1, 0.25, 0.4];
const HORIZON_ROW = 0.5;

/** a 2d shape clip behind the 3d clips, resolved at the time. transform = its world transform when it has a parent. alpha = opacity x fade, 0..1 */
export interface BackdropShape {
  clip: ShapeClip;
  transform: Transform;
  alpha: number;
}

const EMPTY_CLIPS: readonly Clip[] = [];
const clipsByTrackCache = new WeakMap<object, { n: number; map: Map<string, Clip[]> }>();
function clipsOnTrack(project: Project, trackId: string): readonly Clip[] {
  const arr = project.clips;
  let hit = clipsByTrackCache.get(arr);
  if (!hit || hit.n !== arr.length) {
    const map = new Map<string, Clip[]>();
    for (const c of arr) {
      const list = map.get(c.trackId);
      if (list) list.push(c);
      else map.set(c.trackId, [c]);
    }
    hit = { n: arr.length, map };
    clipsByTrackCache.set(arr, hit);
  }
  return hit.map.get(trackId) ?? EMPTY_CLIPS;
}

/** the 2d shape clips painted under the lowest 3d clip at a time, bottom first. a matte clip is not painted on its own, so it is no shape here; a matted shape counts with its full outline */
export function backdropShapes(project: Project, time: number): BackdropShape[] {
  const out: BackdropShape[] = [];
  const onSides = faceSourceSet(project);
  const mattes = matteSourceSet(project);
  for (let i = project.tracks.length - 1; i >= 0; i--) {
    const track = project.tracks[i]!;
    if (track.kind !== 'video' || track.hidden) continue;
    for (const raw of clipsOnTrack(project, track.id)) {
      if (!isVisualClip(raw) || onSides.has(raw.id) || mattes.has(raw.id)) continue;
      if (time < raw.start - 1e-6 || time >= clipEnd(raw) - 1e-6) continue;
      if (raw.threeD) return out;
      if (raw.type !== 'shape' || raw.filled === false) continue;
      const r = resolveClip(raw, time);
      const c = hasClipMotion(raw) ? applyClipMotion(r, time, project) : r;
      const alpha = c.transform.opacity * fadeFactor(c, time);
      if (!(alpha > 0.001)) continue;
      out.push({ clip: c, transform: c.parent ? worldTransformOf(project, c, time) : c.transform, alpha: Math.min(1, alpha) });
    }
  }
  return out;
}

const BLACK_OPAQUE: { rgb: Rgb; a: number } = { rgb: [0, 0, 0], a: 1 };
const shapeColors = new Map<string, { rgb: Rgb; a: number } | null>();

function num(s: string): number {
  return s.endsWith('%') ? parseFloat(s) / 100 : parseFloat(s);
}

/**
 * a shape color as srgb 0..1 and its alpha: #rgb, #rgba, #rrggbb, #rrggbbaa, rgb() / rgba() and hsl() / hsla() (comma or
 * space separated). null when it cannot be read (the shape is then left out of the light). cached, do not change the result.
 */
function parseShapeColor(css: string): { rgb: Rgb; a: number } | null {
  const hit = shapeColors.get(css);
  if (hit !== undefined) return hit;
  let out: { rgb: Rgb; a: number } | null = null;
  const s = css.trim().toLowerCase();
  if (s[0] === '#') {
    if (/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(s)) {
      let h = s.slice(1);
      if (h.length <= 4) h = h.replace(/./g, (ch) => ch + ch);
      const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
      out = { rgb: [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255], a };
    }
  } else {
    const m = /^(rgba?|hsla?)\(([^)]*)\)$/.exec(s);
    const parts = m ? m[2]!.split(/[\s,/]+/).filter(Boolean) : [];
    if (m && (parts.length === 3 || parts.length === 4)) {
      const v = parts.map((p) => p.replace(/deg$/, ''));
      const a = v.length === 4 ? num(v[3]!) : 1;
      if (m[1]!.startsWith('rgb')) {
        const ch = (p: string) => (p.endsWith('%') ? parseFloat(p) / 100 : parseFloat(p) / 255);
        const rgb: Rgb = [ch(v[0]!), ch(v[1]!), ch(v[2]!)];
        if (rgb.every((x) => Number.isFinite(x)) && Number.isFinite(a)) out = { rgb: [clamp01(rgb[0]), clamp01(rgb[1]), clamp01(rgb[2])], a: clamp01(a) };
      } else {
        const hh = (((parseFloat(v[0]!) % 360) + 360) % 360) / 60;
        const sat = num(v[1]!);
        const lig = num(v[2]!);
        const c = (1 - Math.abs(2 * lig - 1)) * sat;
        const x = c * (1 - Math.abs((hh % 2) - 1));
        const mm = lig - c / 2;
        const k = Math.floor(hh) % 6;
        const base: Rgb = k === 0 ? [c, x, 0] : k === 1 ? [x, c, 0] : k === 2 ? [0, c, x] : k === 3 ? [0, x, c] : k === 4 ? [x, 0, c] : [c, 0, x];
        const rgb: Rgb = [clamp01(base[0] + mm), clamp01(base[1] + mm), clamp01(base[2] + mm)];
        if (Number.isFinite(sat) && Number.isFinite(lig) && Number.isFinite(hh) && Number.isFinite(a)) out = { rgb, a: clamp01(a) };
      }
    }
  }
  if (shapeColors.size > 500) shapeColors.clear();
  shapeColors.set(css, out);
  return out;
}

/** the color a shape gives at a canvas point (srgb 0..1) and how much of the point it covers, or null outside */
function shapeColorAt(c: ShapeClip, t: Transform, W: number, H: number, px: number, py: number): { rgb: Rgb; cover: number } | null {
  const w = Math.max(1, c.width) * t.scale * stretchX(t);
  const h = Math.max(1, c.height) * t.scale * stretchY(t);
  const dx = px - (W / 2 + t.x);
  const dy = py - (H / 2 + t.y);
  const a = -(t.rotation || 0) * (Math.PI / 180);
  // a pivot: the shape hangs off its position (engine/pivot.ts), its middle is p away in its own axes
  const lx = dx * Math.cos(a) - dy * Math.sin(a) + (c.pivot ? pivotFraction(c.pivot.x) * w : 0);
  const ly = dx * Math.sin(a) + dy * Math.cos(a) + (c.pivot ? pivotFraction(c.pivot.y) * h : 0);
  if (!(Math.abs(lx) <= w / 2 && Math.abs(ly) <= h / 2)) return null;
  let cover = 0.5;
  if (c.kind === 'rect' || c.kind === 'line') cover = 1;
  else if (c.kind === 'ellipse') {
    const ex = lx / (w / 2);
    const ey = ly / (h / 2);
    if (ex * ex + ey * ey <= 1) cover = 1;
    else return null;
  }
  const c1 = typeof c.color === 'string' && c.color ? parseShapeColor(c.color) : BLACK_OPAQUE;
  if (!c1) return null;
  const c2 = typeof c.color2 === 'string' && c.color2 ? parseShapeColor(c.color2) : null;
  if (!c2) return { rgb: c1.rgb, cover: cover * c1.a };
  let g: number;
  if (c.gradientRadial) g = Math.hypot(lx, ly) / (Math.max(w, h) / 2);
  else {
    const ga = (c.gradientAngle ?? 90) * (Math.PI / 180);
    const ca = Math.cos(ga);
    const sa = Math.sin(ga);
    const half = (Math.abs(ca) * w + Math.abs(sa) * h) / 2;
    g = half > 0 ? (lx * ca + ly * sa + half) / (2 * half) : 0;
  }
  g = clamp01(g);
  const a1 = c1.rgb;
  const a2 = c2.rgb;
  return { rgb: [a1[0] + (a2[0] - a1[0]) * g, a1[1] + (a2[1] - a1[1]) * g, a1[2] + (a2[2] - a1[2]) * g], cover: cover * (c1.a + (c2.a - c1.a) * g) };
}

/** the srgb color of the backdrop (the background with the shapes laid over it, bottom first) at a canvas point */
export function backdropColorAt(project: Project, shapes: readonly BackdropShape[], x: number, y: number): Rgb {
  const bg = parseFogColor(typeof project.background === 'string' && project.background ? project.background : '#000000');
  const rgb: Rgb = [bg[0], bg[1], bg[2]];
  for (const s of shapes) {
    const hit = shapeColorAt(s.clip, s.transform, project.width, project.height, x, y);
    if (!hit) continue;
    const a = s.alpha * hit.cover;
    rgb[0] += (hit.rgb[0] - rgb[0]) * a;
    rgb[1] += (hit.rgb[1] - rgb[1]) * a;
    rgb[2] += (hit.rgb[2] - rgb[2]) * a;
  }
  return rgb;
}

const autoMemo: { project: Project; time: number; rig: LightRig; shapes: BackdropShape[] }[] = [];

function sameShapes(a: readonly BackdropShape[], b: readonly BackdropShape[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.clip !== y.clip || x.transform !== y.transform || x.alpha !== y.alpha) return false;
  }
  return true;
}

/** the light the scene gives at a time, kept for the last 4 (project, time) pairs */
function autoRig(project: Project, time: number): LightRig {
  for (const m of autoMemo) if (m.project === project && m.time === time) return m.rig;
  let shapes: BackdropShape[] = [];
  try {
    shapes = backdropShapes(project, time);
  } catch {
    shapes = [];
  }
  // time only reaches the light through the shapes: the same project and the same shapes (same objects, same alpha) give
  // the same light. a keyed, moving, parented or fading shape is a new object each time, so it never matches
  for (let i = autoMemo.length - 1; i >= 0; i--) {
    const m = autoMemo[i]!;
    if (m.project !== project) continue;
    if (sameShapes(m.shapes, shapes)) {
      // a rig of its own for this time (one rig per time), sharing the numbers
      const rig: LightRig = { env: m.rig.env };
      autoMemo.push({ project, time, rig, shapes });
      if (autoMemo.length > 4) autoMemo.shift();
      return rig;
    }
    break;
  }
  const W = project.width;
  const H = project.height;
  const sky: Rgb = [0, 0, 0];
  for (const row of SKY_ROWS) {
    for (const col of COLS) {
      const c = backdropColorAt(project, shapes, col * W, row * H);
      for (let i = 0; i < 3; i++) sky[i] = sky[i]! + toLinear(c[i]!);
    }
  }
  const nSky = SKY_ROWS.length * COLS.length;
  for (let i = 0; i < 3; i++) sky[i] = sky[i]! / nSky;
  let horizon: Rgb = [0, 0, 0];
  for (const col of COLS) {
    const c = backdropColorAt(project, shapes, col * W, HORIZON_ROW * H);
    for (let i = 0; i < 3; i++) horizon[i] = horizon[i]! + toLinear(c[i]!);
  }
  for (let i = 0; i < 3; i++) horizon[i] = horizon[i]! / COLS.length;
  const fog = project.fog;
  if (fogOn(fog)) {
    const f = Math.min(1, fog.amount);
    const fc = hexToLinear(fog.color);
    horizon = [horizon[0]! + (fc[0] - horizon[0]!) * f, horizon[1]! + (fc[1] - horizon[1]!) * f, horizon[2]! + (fc[2] - horizon[2]!) * f];
  }
  const ground: Rgb = [horizon[0]! * AUTO_GROUND, horizon[1]! * AUTO_GROUND, horizon[2]! * AUTO_GROUND];
  const env = new Float32Array(15);
  writeEnv(env, sky, horizon, ground, 0, [0, -1, 0], [0, 0, 0]);
  const rig: LightRig = { env };
  autoMemo.push({ project, time, rig, shapes });
  if (autoMemo.length > 4) autoMemo.shift();
  return rig;
}

/** the light of lit planes at a time: the own light, the light of the sky, or the one from the scene */
export function sceneLightAt(project: Project, time: number): LightRig {
  if (project.light) return lightRigFrom(project.light);
  const sky = project.sky ? skyLightOf(project) : null;
  return sky ? lightRigFrom(sky) : autoRig(project, time);
}

/** what the scene gives at a time, whether or not an own light is set: the sky's dome when there is a usable sky */
export function autoLightAt(project: Project, time: number): AutoLight {
  const sky = project.sky ? skyLightOf(project) : null;
  if (sky) return { sky: sky.sky, horizon: sky.horizon, ground: sky.ground };
  const e = autoRig(project, time).env;
  return {
    sky: linearToHex([e[0]!, e[1]!, e[2]!]),
    horizon: linearToHex([e[3]!, e[4]!, e[5]!]),
    ground: linearToHex([e[6]!, e[7]!, e[8]!]),
  };
}

const usesCache = new WeakMap<object, { n: number; v: boolean }>();

/** true when a 3d clip of the project is lit (lit > 0 or keys on lit): the renderer may compile the lit program ahead */
export function usesLight(project: Project): boolean {
  const arr = project.clips;
  const hit = usesCache.get(arr);
  if (hit && hit.n === arr.length) return hit.v;
  let v = false;
  for (const c of arr) {
    if (isVisualClip(c) && c.threeD && ((c.lit ?? 0) > 0 || (c.keyframes?.lit?.length ?? 0) > 0)) {
      v = true;
      break;
    }
  }
  usesCache.set(arr, { n: arr.length, v });
  return v;
}
