/**
 * the sides of a 3d solid by name, and what a clip puts on them (types.ts Spatial.faces). pure: no gl, no canvas.
 *
 * the rules, in one place:
 * - only a 3d clip whose shape is a solid (not 'plane') has sides. extruded 3d text is a stack of planes, not a solid.
 * - a side shows the fill stored under its own name; without one, the fill stored under 'all'; without that, the clip's
 *   own picture (what every side showed before this existed). `null` under a name = the own picture even when 'all' is set.
 * - a clip fill names a picture clip (video, image, text, shape) by id. it counts only when that clip exists, is not the
 *   solid itself and is not on a hidden track. at a time outside the clip's range the side shows the own picture.
 * - a clip that is shown on a side of some solid is not painted on its own (faceSourceIds): it lives on the solid.
 *   its place, size, turn and opacity are not used, its picture is (look, mask and crop included).
 * - the clip's picture lies OVER the solid's own picture on that side: where it is see-through (around a picture shown
 *   whole, between letters) the own picture shows. a solid without a fill of its own (only its line) has nothing under it.
 */
import { isVisualClip } from '../../types';
import { CAPSULE_CAP, TORUS_TUBE } from './meshes';
import type { Clip, FaceFill, FaceFit, Project, Shape3D, VisualClip } from '../../types';

/** the name that stands for every side that has no fill of its own */
export const FACE_ALL = 'all';

const NONE: readonly string[] = [];
const BOX: readonly string[] = ['front', 'back', 'right', 'left', 'top', 'bottom'];
const TUBE: readonly string[] = ['side', 'top', 'bottom'];
const CONE: readonly string[] = ['side', 'bottom'];
const PYRAMID: readonly string[] = ['front', 'right', 'back', 'left', 'bottom'];
const CUT: readonly string[] = ['front', 'back', 'side'];
const ROUND: readonly string[] = ['surface'];

const NAMES: Record<Shape3D, readonly string[]> = {
  plane: NONE,
  box: BOX,
  cylinder: TUBE,
  cone: CONE,
  pyramid: PYRAMID,
  prism: CUT,
  hexagon: CUT,
  star: CUT,
  heart: CUT,
  sphere: ROUND,
  torus: ROUND,
  capsule: ROUND,
};

/**
 * the sides of a shape in the order they are listed (and the order meshes.ts builds them in). a plane has none.
 * 'front' faces the viewer of an unturned clip, 'top' is up on screen.
 */
export function faceNames(shape: Shape3D | undefined): readonly string[] {
  return NAMES[shape ?? 'plane'] ?? NONE;
}

type Sided = Pick<VisualClip, 'threeD' | 'shape' | 'faces'>;

/** does this clip have sides at all (a 3d solid)? */
export function hasSides(clip: Pick<VisualClip, 'threeD' | 'shape'>): boolean {
  return !!clip.threeD && faceNames(clip.shape).length > 0;
}

/**
 * what one side of a clip shows as stored: its own entry, else the entry for all sides. null = the clip's own picture.
 * (whether a named clip can be shown right now is the caller's question: faceSource.)
 */
export function faceFill(clip: Sided, name: string): FaceFill | null {
  const faces = clip.faces;
  if (!faces || !hasSides(clip)) return null;
  const own = faces[name];
  if (own !== undefined) return own;
  return faces[FACE_ALL] ?? null;
}

/** a hex color the way the rest of the project writes it, or null */
export function faceColor(fill: FaceFill | null | undefined): string | null {
  return fill && 'color' in fill && typeof fill.color === 'string' ? fill.color : null;
}

/** the id of the clip a fill names, or null */
export function faceClipId(fill: FaceFill | null | undefined): string | null {
  return fill && 'clip' in fill && typeof fill.clip === 'string' && fill.clip ? fill.clip : null;
}

/** how a clip's picture sits on a side when the fill does not say: pictures cover it, text and figures fit inside it */
export function defaultFit(source: Pick<Clip, 'type'>): FaceFit {
  return source.type === 'video' || source.type === 'image' ? 'fill' : 'fit';
}

/** how the picture of `source` sits on a side with this fill */
export function faceFit(fill: FaceFill | null | undefined, source: Pick<Clip, 'type'>): FaceFit {
  const f = fill && 'clip' in fill ? fill.fit : undefined;
  return f === 'fill' || f === 'fit' || f === 'stretch' ? f : defaultFit(source);
}

/**
 * the clip a side shows, when it can be shown at all: it exists, is a picture clip, is not the solid itself and its
 * track is not hidden. time is not looked at here (outside the clip's range the side shows the own picture).
 */
export function faceSource(project: Project, clip: VisualClip, name: string): VisualClip | null {
  const id = faceClipId(faceFill(clip, name));
  if (!id || id === clip.id) return null;
  const src = project.clips.find((c) => c.id === id);
  if (!src || !isVisualClip(src)) return null;
  const track = project.tracks.find((t) => t.id === src.trackId);
  if (!track || track.hidden) return null;
  return src;
}

/** the names of the sides of a clip that show something other than its own picture as stored (a color or a clip id) */
export function filledFaces(clip: Sided): string[] {
  const out: string[] = [];
  for (const name of faceNames(clip.threeD ? clip.shape : 'plane')) if (faceFill(clip, name)) out.push(name);
  return out;
}

/**
 * every clip that is shown on a side of some solid, mapped to the ids of the solids that show it. such a clip is not
 * painted on its own. a fill on a side the shape does not have, on a flat clip or naming a missing clip does not count.
 */
export function faceSourceIds(project: Project): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const c of project.clips) {
    if (!isVisualClip(c) || !c.faces || !hasSides(c)) continue;
    for (const name of faceNames(c.shape)) {
      const src = faceSource(project, c, name);
      if (!src) continue;
      const users = out.get(src.id);
      if (!users) out.set(src.id, [c.id]);
      else if (!users.includes(c.id)) users.push(c.id);
    }
  }
  return out;
}

/**
 * `faces` with one entry changed, as a new object (undefined when nothing is left, so the field goes away).
 * - a fill: stored under the name.
 * - null: under a side's name = "the own picture here", kept only while 'all' has a fill (otherwise it says nothing);
 *   under 'all' = no fill for all sides.
 * - undefined: the entry is removed (the side follows 'all' again).
 * a null entry that stopped meaning anything (because 'all' was emptied) is dropped too.
 */
export function withFace(faces: Record<string, FaceFill | null> | undefined, name: string, fill: FaceFill | null | undefined): Record<string, FaceFill | null> | undefined {
  const next: Record<string, FaceFill | null> = { ...(faces ?? {}) };
  if (fill === undefined || (fill === null && name === FACE_ALL)) delete next[name];
  else next[name] = fill;
  if (!next[FACE_ALL]) for (const k of Object.keys(next)) if (next[k] === null) delete next[k];
  return Object.keys(next).length > 0 ? next : undefined;
}

/**
 * `faces` with clip ids swapped (duplicate / paste: a copied solid shows the copy of its picture clip when that was
 * copied along) or dropped (`map` returns null: the clip is gone, the entry goes away). ids the map does not know stay.
 */
export function remapFaces(faces: Record<string, FaceFill | null> | undefined, map: (id: string) => string | null | undefined): Record<string, FaceFill | null> | undefined {
  if (!faces) return undefined;
  let out: Record<string, FaceFill | null> | undefined = undefined;
  for (const name of Object.keys(faces)) {
    const f = faces[name];
    const id = faceClipId(f);
    if (id === null) continue;
    const to = map(id);
    if (to === undefined || to === id) continue;
    out ??= { ...faces };
    if (to === null) delete out[name];
    else out[name] = { ...(f as { clip: string; fit?: FaceFit }), clip: to };
  }
  if (!out) return faces;
  if (!out[FACE_ALL]) for (const k of Object.keys(out)) if (out[k] === null) delete out[k];
  return Object.keys(out).length > 0 ? out : undefined;
}

/** the length round an ellipse with these two axis lengths (ramanujan's approximation) */
function ellipseRound(w: number, d: number): number {
  const a = Math.abs(w) / 2;
  const b = Math.abs(d) / 2;
  return Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
}

/**
 * the width and height in pixels that uv 0..1 spans on one side of a solid of size w x h x d (what meshes.ts builds).
 * round shapes give a rough but sensible number (the length round the shape, the length over it). it drives the fit.
 * an unknown side or a plane gives w x h.
 */
export function faceArea(shape: Shape3D | undefined, name: string, w: number, h: number, d: number): [number, number] {
  w = Math.abs(w);
  h = Math.abs(h);
  d = Math.abs(d);
  switch (shape) {
    case 'box':
      return name === 'right' || name === 'left' ? [d, h] : name === 'top' || name === 'bottom' ? [w, d] : [w, h];
    case 'cylinder':
      return name === 'side' ? [ellipseRound(w, d), h] : [w, d];
    case 'cone':
      return name === 'side' ? [ellipseRound(w, d), Math.hypot(h, (w + d) / 4)] : [w, d];
    case 'pyramid':
      if (name === 'bottom') return [w, d];
      // the whole picture lies on a slope: the base edge across, the way up the slope from its middle to the tip
      return name === 'right' || name === 'left' ? [d, Math.hypot(h, w / 2)] : [w, Math.hypot(h, d / 2)];
    case 'sphere':
      return [ellipseRound(w, d), (Math.PI * h) / 2];
    case 'torus': {
      // ring radius is the outer radius over (1 + tube), the tube radius a share of it
      const ring = (w + h) / 4 / (1 + TORUS_TUBE);
      return [2 * Math.PI * ring, 2 * Math.PI * ring * TORUS_TUBE];
    }
    case 'capsule': {
      // the straight part plus a quarter of an ellipse at each end
      const a = Math.max(w, d) / 2;
      const b = h * CAPSULE_CAP;
      return [ellipseRound(w, d), h * (1 - 2 * CAPSULE_CAP) + Math.PI * Math.sqrt((a * a + b * b) / 2)];
    }
    default:
      // prism, hexagon, star, heart: uv is the bounding box of the outline on the front, the back and the wall
      return [w, h];
  }
}

/**
 * the window into a picture (0..1 of it) that the uv 0..1 of a side maps to: [u0, v0, du, dv].
 * - 'stretch': the whole picture, squeezed onto the side.
 * - 'fill': the side is covered, the picture is cut at the center where the proportions differ.
 * - 'fit': the whole picture shows inside the side; the window reaches outside 0..1 and that part is see-through.
 * sizes that are not positive give the whole picture.
 */
export function fitWindow(pictureW: number, pictureH: number, sideW: number, sideH: number, fit: FaceFit): [number, number, number, number] {
  if (fit === 'stretch' || !(pictureW > 0 && pictureH > 0 && sideW > 0 && sideH > 0)) return [0, 0, 1, 1];
  const pa = pictureW / pictureH;
  const sa = sideW / sideH;
  const wider = pa > sa;
  if (fit === 'fill') {
    if (wider) {
      const du = sa / pa;
      return [(1 - du) / 2, 0, du, 1];
    }
    const dv = pa / sa;
    return [0, (1 - dv) / 2, 1, dv];
  }
  if (wider) {
    const dv = pa / sa;
    return [0, (1 - dv) / 2, 1, dv];
  }
  const du = sa / pa;
  return [(1 - du) / 2, 0, du, 1];
}

/**
 * the window into the TEXTURE for a picture whose visible part is `crop` ([u0, v0, du, dv] of the texture, missing = all):
 * the fit window of the cropped picture, moved into the crop. `clip` is the crop rectangle when the window reaches
 * outside it (fit): outside it the side is see-through instead of the smeared edge. fill and stretch never need it.
 */
export function faceWindow(
  crop: [number, number, number, number] | undefined,
  texW: number,
  texH: number,
  sideW: number,
  sideH: number,
  fit: FaceFit,
): { uv: [number, number, number, number]; clip?: [number, number, number, number] } {
  const c = crop ?? [0, 0, 1, 1];
  const win = fitWindow(texW * c[2], texH * c[3], sideW, sideH, fit);
  const uv: [number, number, number, number] = [c[0] + win[0] * c[2], c[1] + win[1] * c[3], win[2] * c[2], win[3] * c[3]];
  const reaches = win[0] < -1e-6 || win[1] < -1e-6 || win[0] + win[2] > 1 + 1e-6 || win[1] + win[3] > 1 + 1e-6;
  return reaches ? { uv, clip: [c[0], c[1], c[2], c[3]] } : { uv };
}

const sourceCache = new WeakMap<object, { clips: readonly Clip[]; tracks: unknown; n: number; map: Map<string, string[]> }>();
const NO_SOURCES: Map<string, string[]> = new Map();

/**
 * faceSourceIds, kept per project object. the lists that run every frame ask this. the store replaces the project on
 * every change; the clips array, the tracks array and the clip count are checked too, so a project edited in place
 * (a test, a drag that pushes into the array) is not served a stale answer.
 */
export function faceSourceSet(project: Project): ReadonlyMap<string, string[]> {
  const hit = sourceCache.get(project);
  if (hit && hit.clips === project.clips && hit.tracks === project.tracks && hit.n === project.clips.length) return hit.map;
  let any = false;
  for (const c of project.clips) {
    if (isVisualClip(c) && c.faces) {
      any = true;
      break;
    }
  }
  const map = any ? faceSourceIds(project) : NO_SOURCES;
  sourceCache.set(project, { clips: project.clips, tracks: project.tracks, n: project.clips.length, map });
  return map;
}
