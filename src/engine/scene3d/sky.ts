/**
 * the skybox (Project.sky) as pure math: no dom, no gl. a cube map seen from inside, far away, turning with the camera.
 * renderer.ts draws it (SKY_VS / SKY_FS), light.ts takes the light of lit 3d clips from it (skyLightOf).
 *
 * the cube follows the gl table (es 3.0 table 3.21): sides in the order px nx py ny pz nz (right, left, top, bottom,
 * front, back), the first row of a picture is t = 0. cube space is the world with y flipped (x right, y up, z away from
 * the viewer), so the home camera sees the front (pz) upright and not mirrored, a pan of 90 shows the right (px) and a
 * tilt up shows the top (py) with the front at its bottom edge.
 */
import type { MediaAsset, Project, SceneSky } from '../../types';
import type { CameraRig } from './camera';
import { DEG, type Vec3 } from './math';

export const SKY_SIDES = ['px', 'nx', 'py', 'ny', 'pz', 'nz'] as const;
/** the sides in plain words, same order (what the inspector and the mcp say) */
export const SKY_SIDE_WORDS = ['right', 'left', 'top', 'bottom', 'front', 'back'] as const;
/** the side length of the samples the light and the seam check are worked out on */
export const SKY_SAMPLE = 32;
/** the largest face the preview and the export upload */
export const SKY_FACE_MAX = 2048;
/** the largest face of the camera inset (it draws at 240 px) */
export const SKY_INSET_MAX = 512;
/** blur 1 = this many mip levels softer */
export const SKY_BLUR_LEVELS = 4;
/** the id a failed sky draw is reported under (draw.ts guarded) */
export const SKY_ID = 'sky';

export type SkyLayout = 'cross' | 'tallcross' | 'strip' | 'column';
export interface SkyLayoutCells {
  cols: number;
  rows: number;
  /** the cell of each side in side order, [column, row] from the top left */
  cells: readonly (readonly [number, number])[];
  /** quarter turns clockwise that make each cell the gl face */
  turns: readonly number[];
}
export const SKY_LAYOUTS: Readonly<Record<SkyLayout, SkyLayoutCells>> = {
  // . py . .
  // nx pz px nz
  // . ny . .
  cross: { cols: 4, rows: 3, cells: [[2, 1], [0, 1], [1, 0], [1, 2], [1, 1], [3, 1]], turns: [0, 0, 0, 0, 0, 0] },
  // . py .
  // nx pz px
  // . ny .
  // . nz .    (the back hangs under the bottom, upside down)
  tallcross: { cols: 3, rows: 4, cells: [[2, 1], [0, 1], [1, 0], [1, 2], [1, 1], [1, 3]], turns: [0, 0, 0, 0, 0, 2] },
  strip: { cols: 6, rows: 1, cells: [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0]], turns: [0, 0, 0, 0, 0, 0] },
  column: { cols: 1, rows: 6, cells: [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4], [0, 5]], turns: [0, 0, 0, 0, 0, 0] },
};

/** the sky's pictures as the renderer uploads them */
export interface SkyPicture {
  /** the same key = the same pixels: the renderer keeps its upload while the key stays */
  readonly key: string;
  /** the side length of every face in pixels */
  readonly size: number;
  /** six square pictures of `size` in side order, already turned */
  readonly faces: readonly TexImageSource[];
  /** give the pictures back (bitmaps closed, canvases zero sized) */
  close(): void;
}
/** what a resolver gives for a sky (draw.ts SourceResolver.sky). null = not ready (still loading) or unreadable */
export type SkyPictureOf = (sky: SceneSky) => SkyPicture | null;
/** one sky draw of one render (renderer.ts renderScene `sky`) */
export interface SkyDraw {
  pic: SkyPicture;
  /** column major mat3: clip position (x, y, 1) to the cube direction (skyRay) */
  ray: Float32Array;
  /** the brightness: the srgb color times this */
  gain: number;
  /** the blur as a mip bias */
  bias: number;
  /** the largest face this channel uploads (skyChannelCap) */
  maxFace: number;
}

// shapes and readers

/** the layout of one picture by its shape (1% off is fine). null = not a cube map */
export function layoutOf(width: number, height: number): SkyLayout | null {
  if (!(width > 0 && height > 0)) return null;
  const r = width / height;
  const near = (v: number) => Math.abs(r / v - 1) <= 0.01;
  if (near(4 / 3)) return 'cross';
  if (near(3 / 4)) return 'tallcross';
  if (near(6)) return 'strip';
  if (near(1 / 6)) return 'column';
  return null;
}

/** true for a 2:1 picture (2% off is fine): a panorama, which a sky does not take */
export function isPanorama(width: number, height: number): boolean {
  return width > 0 && height > 0 && Math.abs(width / height / 2 - 1) <= 0.02;
}

/** degrees in 0.1 steps, wrapped into -180..180 (180 stays 180). not finite = 0 */
export function wrapDeg(deg: number): number {
  if (!Number.isFinite(deg)) return 0;
  let t = Math.round((deg % 360) * 10) / 10;
  if (t > 180) t -= 360;
  else if (t < -180) t += 360;
  return Math.round(t * 10) / 10 + 0;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export function skyTurn(sky: SceneSky): number {
  return finite(sky.turn) ? wrapDeg(sky.turn) : 0;
}
export function skyBrightness(sky: SceneSky): number {
  return finite(sky.brightness) ? clamp(sky.brightness, 0, 2) : 1;
}
export function skyBlur(sky: SceneSky): number {
  return finite(sky.blur) ? clamp(sky.blur, 0, 1) : 0;
}

/**
 * the sky with a new turn, brightness or blur: turn wrapped in 0.1 steps, brightness 0..2 and blur 0..1 with 4
 * decimals. values that are missing or not finite are left out. the same object back when nothing changes.
 */
export function withSkyValues(sky: SceneSky, v: { turn?: unknown; brightness?: unknown; blur?: unknown }): SceneSky {
  const next: SceneSky = { ...sky };
  let changed = false;
  if (finite(v.turn)) {
    const t = wrapDeg(v.turn);
    if (t !== sky.turn) {
      next.turn = t;
      changed = true;
    }
  }
  if (finite(v.brightness)) {
    const b = Number(clamp(v.brightness, 0, 2).toFixed(4));
    if (b !== sky.brightness) {
      next.brightness = b;
      changed = true;
    }
  }
  if (finite(v.blur)) {
    const b = Number(clamp(v.blur, 0, 1).toFixed(4));
    if (b !== sky.blur) {
      next.blur = b;
      changed = true;
    }
  }
  return changed ? next : sky;
}

/** the quarter turns of the six sides, 0..3 each (missing or bad = 0). a one picture sky ignores sky.turns */
export function skyTurnsOf(sky: SceneSky): number[] {
  const t = Array.isArray(sky.turns) ? sky.turns : [];
  const out: number[] = [];
  for (let i = 0; i < 6; i++) {
    const v = t[i];
    out.push(finite(v) ? ((Math.round(v) % 4) + 4) % 4 : 0);
  }
  return out;
}

// ids, validity, usability

/** true when v names its pictures right: one non-empty asset id, or six non-empty face ids (not both) */
export function validSky(v: unknown): v is SceneSky {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  const one = typeof o.asset === 'string' && o.asset.length > 0;
  const six = Array.isArray(o.faces) && o.faces.length === 6 && o.faces.every((f) => typeof f === 'string' && f.length > 0);
  return one !== six;
}

/** the media ids a sky uses ([] for none or a broken one) */
export function skyAssetIds(sky: SceneSky | null | undefined): string[] {
  if (!validSky(sky)) return [];
  return typeof sky.asset === 'string' && sky.asset ? [sky.asset] : [...sky.faces!];
}

export function skyUses(sky: SceneSky | null | undefined, assetId: string): boolean {
  return skyAssetIds(sky).includes(assetId);
}

/** the same sky on other media ids (a duplicated or imported project). ids not in the map stay */
export function remapSky(sky: SceneSky, map: ReadonlyMap<string, string>): SceneSky {
  const next: SceneSky = { ...sky };
  if (typeof sky.asset === 'string') next.asset = map.get(sky.asset) ?? sky.asset;
  if (Array.isArray(sky.faces)) next.faces = sky.faces.map((f) => map.get(f) ?? f);
  return next;
}

/** what the pictures of a sky are: the same key = the same six faces. turn, brightness and blur are not in it */
export function skyKey(sky: SceneSky): string {
  if (!validSky(sky)) return '';
  if (typeof sky.asset === 'string' && sky.asset) return `a:${sky.asset}`;
  return `f:${sky.faces!.join(',')}:${skyTurnsOf(sky).join('')}`;
}

/** the media of a sky in id order, or null when one is missing, not a picture, or the one picture is not a cube map */
export function skyAssets(sky: SceneSky, assets: readonly MediaAsset[]): MediaAsset[] | null {
  if (!validSky(sky)) return null;
  const out: MediaAsset[] = [];
  for (const id of skyAssetIds(sky)) {
    const a = assets.find((x) => x.id === id);
    if (!a || a.kind !== 'image' || !(a.width > 0 && a.height > 0)) return null;
    out.push(a);
  }
  if (out.length === 1 && layoutOf(out[0]!.width, out[0]!.height) === null) return null;
  return out;
}

const usableMemo = new WeakMap<object, { assets: readonly MediaAsset[]; ok: boolean }>();

/** true when the project has a sky that can be drawn (its pictures are all there). kept per sky object and media list */
export function skyUsable(project: Pick<Project, 'sky' | 'assets'>): boolean {
  const sky = project.sky;
  if (!sky || typeof sky !== 'object') return false;
  const hit = usableMemo.get(sky);
  if (hit && hit.assets === project.assets) return hit.ok;
  const ok = skyAssets(sky, project.assets) !== null;
  usableMemo.set(sky, { assets: project.assets, ok });
  return ok;
}

/** the side length of one face in the source pictures (0 when the sky is not usable) */
export function sourceFaceOf(sky: SceneSky, assets: readonly MediaAsset[]): number {
  const list = skyAssets(sky, assets);
  if (!list) return 0;
  if (list.length === 1) {
    const a = list[0]!;
    const l = SKY_LAYOUTS[layoutOf(a.width, a.height)!];
    return Math.floor(Math.min(a.width / l.cols, a.height / l.rows));
  }
  return Math.max(...list.map((a) => Math.min(a.width, a.height)));
}

/**
 * the face size the preview and the export read a sky at: the source face, at most SKY_FACE_MAX, and no more than
 * twice the project height (the home camera's 50 degree view needs about 2.1 x the height for one texel per pixel).
 * at least 16. a source face of 0 or a bad height counts as SKY_FACE_MAX.
 */
export function skyFaceSize(sourceFace: number, projectHeight: number): number {
  const src = Number.isFinite(sourceFace) && sourceFace > 0 ? Math.floor(sourceFace) : SKY_FACE_MAX;
  const want = Number.isFinite(projectHeight) && projectHeight > 0 ? Math.round(2 * projectHeight) : SKY_FACE_MAX;
  return Math.max(16, Math.min(src, want, SKY_FACE_MAX));
}

/** the largest face a channel uploads ('inset' is the small camera picture) */
export function skyChannelCap(channel: string): number {
  return channel === 'inset' ? SKY_INSET_MAX : SKY_FACE_MAX;
}

// cube math

/** the side a cube space direction looks at and where on it (s, t in 0..1, t = 0 is the first row). the gl table */
export function cubeFace(x: number, y: number, z: number): { face: number; s: number; t: number } {
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  const az = Math.abs(z);
  let face: number;
  let sc: number;
  let tc: number;
  let ma: number;
  if (ax >= ay && ax >= az) {
    ma = ax;
    if (x >= 0) {
      face = 0;
      sc = -z;
      tc = -y;
    } else {
      face = 1;
      sc = z;
      tc = -y;
    }
  } else if (ay >= az) {
    ma = ay;
    if (y >= 0) {
      face = 2;
      sc = x;
      tc = z;
    } else {
      face = 3;
      sc = x;
      tc = -z;
    }
  } else {
    ma = az;
    if (z >= 0) {
      face = 4;
      sc = x;
      tc = -y;
    } else {
      face = 5;
      sc = -x;
      tc = -y;
    }
  }
  if (!(ma > 0)) return { face: 4, s: 0.5, t: 0.5 };
  return { face, s: (sc / ma + 1) / 2, t: (tc / ma + 1) / 2 };
}

/** the cube space direction (not unit: one coordinate is +-1) at (s, t) of a side. the inverse of cubeFace */
export function faceDirection(face: number, s: number, t: number): Vec3 {
  const sc = 2 * s - 1;
  const tc = 2 * t - 1;
  switch (face) {
    case 0:
      return [1, -tc, -sc];
    case 1:
      return [-1, -tc, sc];
    case 2:
      return [sc, 1, tc];
    case 3:
      return [sc, -1, -tc];
    case 4:
      return [sc, -tc, 1];
    default:
      return [-sc, -tc, -1];
  }
}

/** which source pixel lands on (x, y) of an n x n picture turned k quarter turns clockwise */
export function turnedSource(n: number, k: number, x: number, y: number): [number, number] {
  switch (((Math.round(k) % 4) + 4) % 4) {
    case 1:
      return [y, n - 1 - x];
    case 2:
      return [n - 1 - x, n - 1 - y];
    case 3:
      return [n - 1 - y, x];
    default:
      return [x, y];
  }
}

/** an n x n rgba picture turned k quarter turns clockwise (k 0 = a copy) */
export function turnSample(rgba: Uint8ClampedArray, n: number, k: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const [sx, sy] = turnedSource(n, k, x, y);
      const o = (y * n + x) * 4;
      const i = (sy * n + sx) * 4;
      out[o] = rgba[i]!;
      out[o + 1] = rgba[i + 1]!;
      out[o + 2] = rgba[i + 2]!;
      out[o + 3] = rgba[i + 3]!;
    }
  }
  return out;
}

/**
 * the mat3 (column major) the sky shader turns a clip position (x, y, 1) into a cube direction with. the world ray of
 * camera.ts screenRay (right * x * tanHalf * aspect + down * -y * tanHalf + forward, clip y points up), turned about
 * the world y axis by the sky's turn like a pan (Ry(a)(x, y, z) = (x c + z s, y, z c - x s)), then y flipped.
 */
export function skyRay(rig: Pick<CameraRig, 'right' | 'down' | 'forward' | 'tanHalf' | 'aspect'>, turnDeg: number, out: Float32Array = new Float32Array(9)): Float32Array {
  const a = (Number.isFinite(turnDeg) ? turnDeg : 0) * DEG;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const put = (i: number, v: Vec3, k: number) => {
    const x = v[0] * k;
    const y = v[1] * k;
    const z = v[2] * k;
    out[i] = x * c + z * s;
    out[i + 1] = -y;
    out[i + 2] = z * c - x * s;
  };
  put(0, rig.right, rig.tanHalf * rig.aspect);
  put(3, rig.down, -rig.tanHalf);
  put(6, rig.forward, 1);
  return out;
}

/** u_ray * (x, y, 1): the cube direction the sky shows at clip position (x, y), y up. what SKY_VS does, for tests */
export function skyDirAt(ray: ArrayLike<number>, x: number, y: number): Vec3 {
  return [ray[0]! * x + ray[3]! * y + ray[6]!, ray[1]! * x + ray[4]! * y + ray[7]!, ray[2]! * x + ray[5]! * y + ray[8]!];
}

/**
 * what one render of a channel needs to draw the sky, or null: no sky, not usable, no picture source (the resolver
 * has no `sky`: the bench, a thumbnail) or the pictures are not ready yet.
 */
export function skyDrawFor(project: Project, pictureOf: SkyPictureOf | undefined, channel: string, rig: CameraRig): SkyDraw | null {
  const sky = project.sky;
  if (!sky || !pictureOf || !skyUsable(project)) return null;
  const pic = pictureOf(sky);
  if (!pic) return null;
  return { pic, ray: skyRay(rig, skyTurn(sky)), gain: skyBrightness(sky), bias: skyBlur(sky) * SKY_BLUR_LEVELS, maxFace: skyChannelCap(channel) };
}

// names and candidates

const SIDE_NAMES: readonly (readonly string[])[] = [
  ['px', 'posx', 'positivex', 'right', 'rt'],
  ['nx', 'negx', 'negativex', 'left', 'lf'],
  ['py', 'posy', 'positivey', 'top', 'up'],
  ['ny', 'negy', 'negativey', 'bottom', 'bot', 'down', 'dn'],
  ['pz', 'posz', 'positivez', 'front', 'ft'],
  ['nz', 'negz', 'negativez', 'back', 'bk'],
];
/** side names that are words: packs that use them follow different conventions, so their seams are checked */
const SIDE_WORDS = new Set(['right', 'rt', 'left', 'lf', 'top', 'up', 'bottom', 'bot', 'down', 'dn', 'front', 'ft', 'back', 'bk']);
/** words that make a 4:3 or 3:4 picture a skybox candidate (a 4:3 photo is common, a 6:1 picture is not) */
const SKY_NAME_WORDS = new Set(['sky', 'skybox', 'skymap', 'cubemap', 'cube', 'env', 'envmap', 'environment']);

function sideOfToken(t: string): number {
  for (let i = 0; i < 6; i++) if (SIDE_NAMES[i]!.includes(t)) return i;
  return -1;
}

/** the words of a file name: no extension, +x / -x spelled posx / negx, camelCase split, lowercase, trailing digits off */
export function nameTokens(fileName: string): string[] {
  const base = fileName.replace(/\.[a-z0-9]{1,5}$/i, '');
  const spelled = base.replace(/\+([xyz])(?![a-z0-9])/gi, ' pos$1 ').replace(/-([xyz])(?![a-z0-9])/gi, ' neg$1 ');
  return spelled
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((t) => t.replace(/\d+$/, ''))
    .filter((t) => t.length > 0);
}

export interface SkySideName {
  side: number;
  /** named with a word (right, rt, top ...), not px / posx / positivex */
  word: boolean;
  /** the tokens [from, to) of nameTokens that hold the side */
  from: number;
  to: number;
}

/** the side a file name says, looking from its last word back (a word alone, or two joined: pos x, negative x). null = none */
export function skySideOf(fileName: string): SkySideName | null {
  const t = nameTokens(fileName);
  for (let i = t.length - 1; i >= 0; i--) {
    const one = sideOfToken(t[i]!);
    if (one >= 0) return { side: one, word: SIDE_WORDS.has(t[i]!), from: i, to: i + 1 };
    if (i > 0) {
      const two = sideOfToken(t[i - 1]! + t[i]!);
      if (two >= 0) return { side: two, word: false, from: i - 1, to: i + 1 };
    }
  }
  return null;
}

/** a file name without its side words (what six sides of one sky share). no side = all its words */
export function skyStemOf(fileName: string): string {
  const t = nameTokens(fileName);
  const s = skySideOf(fileName);
  return (s ? [...t.slice(0, s.from), ...t.slice(s.to)] : t).join(' ');
}

/**
 * six pictures in side order by their names, or null. every name must say a different side. fallback: names ending in
 * the numbers 0..5 or 1..6 (side order). words = the seam check should run (word names or numbers).
 */
export function guessFaces(assets: readonly { id: string; name: string }[]): { faces: string[]; words: boolean } | null {
  if (assets.length !== 6) return null;
  const faces: (string | undefined)[] = [undefined, undefined, undefined, undefined, undefined, undefined];
  let words = false;
  let ok = true;
  for (const a of assets) {
    const s = skySideOf(a.name);
    if (!s || faces[s.side] !== undefined) {
      ok = false;
      break;
    }
    faces[s.side] = a.id;
    if (s.word) words = true;
  }
  if (ok) return { faces: faces as string[], words };
  const nums = assets.map((a) => {
    const m = /(\d+)\D*$/.exec(a.name.replace(/\.[a-z0-9]{1,5}$/i, ''));
    return m ? Number(m[1]) : NaN;
  });
  const lo = Math.min(...nums);
  if ((lo !== 0 && lo !== 1) || new Set(nums).size !== 6 || nums.some((n) => !(n >= lo && n <= lo + 5))) return null;
  const out: string[] = ['', '', '', '', '', ''];
  assets.forEach((a, i) => {
    out[nums[i]! - lo] = a.id;
  });
  return { faces: out, words: true };
}

/**
 * media that look like a skybox, best first: sets of six square pictures of one size whose names say six sides around
 * the same stem (ids in side order), then single pictures shaped like a strip or a column, then crosses whose name
 * has a sky word (sky, skybox, cubemap, cube, env ...). image media only.
 */
export function skyCandidates(assets: readonly MediaAsset[]): string[][] {
  const images = assets.filter((a) => a.kind === 'image' && a.width > 0 && a.height > 0 && !/svg/i.test(a.mime) && !/[.]svg$/i.test(a.name));
  const out: string[][] = [];
  const groups = new Map<string, MediaAsset[]>();
  for (const a of images) {
    if (a.width !== a.height || !skySideOf(a.name)) continue;
    const key = `${skyStemOf(a.name)}|${a.width}`;
    const g = groups.get(key);
    if (g) g.push(a);
    else groups.set(key, [a]);
  }
  for (const g of groups.values()) {
    const f = guessFaces(g);
    if (f) out.push(f.faces);
  }
  for (const a of images) {
    const l = layoutOf(a.width, a.height);
    if (l === 'strip' || l === 'column') out.push([a.id]);
  }
  for (const a of images) {
    const l = layoutOf(a.width, a.height);
    if ((l === 'cross' || l === 'tallcross') && nameTokens(a.name).some((t) => SKY_NAME_WORDS.has(t))) out.push([a.id]);
  }
  return out;
}
