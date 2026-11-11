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
 */
import { isVisualClip } from '../../types';
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
