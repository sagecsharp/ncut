/**
 * the "sides" block of the 3d inspector as plain data: which rows a shape gets, what each row's select offers, how a
 * select value turns into a stored fill and back, and "take off" for a clip that lives on a solid. no react, no store.
 */
import { FACE_ALL, faceClipId, faceColor, faceNames, faceSourceIds, remapFaces } from '../../engine/scene3d/faces';
import type { FaceFill, FaceFit, Project, Shape3D } from '../../types';
import { isVisualClip } from '../../types';
import { baseName } from './parentOptions';

export type Faces = Record<string, FaceFill | null>;

/** select values that are not a clip id */
export const SAME = '__same';
export const OWN = '__own';
export const COLOR = '__color';

export interface SideRow {
  /** the name the fill is stored under ('all' for the all sides row and for a shape with one side) */
  name: string;
  /** what the row is called */
  label: string;
  /** the row for every side that has no fill of its own */
  all: boolean;
}

/**
 * the rows for a shape: "all sides" first, then one per side. a shape with one side ('surface') has just that row,
 * stored under 'all'.
 */
export function sideRows(shape: Shape3D | undefined): SideRow[] {
  const names = faceNames(shape);
  if (names.length === 0) return [];
  if (names.length === 1) return [{ name: FACE_ALL, label: names[0]!, all: true }];
  return [{ name: FACE_ALL, label: 'all sides', all: true }, ...names.map((n): SideRow => ({ name: n, label: n, all: false }))];
}

/** the choices before the clips: "same as all" only while 'all' has a fill */
export function headChoices(row: SideRow, faces: Faces | undefined): [string, string][] {
  const out: [string, string][] = [];
  if (!row.all && faces?.[FACE_ALL]) out.push([SAME, 'same as all']);
  out.push([OWN, 'own picture'], [COLOR, 'color']);
  return out;
}

/** the entry stored under the row's name: undefined = none (follows 'all'), null = the own picture on purpose */
export function entryOf(faces: Faces | undefined, row: SideRow): FaceFill | null | undefined {
  return faces?.[row.name];
}

/** the select value for a row: SAME, OWN, COLOR or the id of the clip it shows (which may be gone) */
export function choiceOf(faces: Faces | undefined, row: SideRow): string {
  const e = entryOf(faces, row);
  if (e === undefined) return row.all || !faces?.[FACE_ALL] ? OWN : SAME;
  if (e === null) return OWN;
  if (faceColor(e) !== null) return COLOR;
  return faceClipId(e) ?? OWN;
}

/** the color a row shows (the one its control edits), or null */
export function rowColor(faces: Faces | undefined, row: SideRow): string | null {
  return faceColor(entryOf(faces, row));
}

/** the stored fit of a row that shows a clip, or undefined while it follows the default */
export function rowFit(faces: Faces | undefined, row: SideRow): FaceFit | undefined {
  const e = entryOf(faces, row);
  return e && 'clip' in e ? e.fit : undefined;
}

/** the color "color" starts with: the clip's own fill when it is a shape, else white */
export function startColor(clip: { type: string; color?: string }): string {
  return clip.type === 'shape' && typeof clip.color === 'string' && clip.color ? clip.color : '#ffffff';
}

/**
 * what to store for a picked select value, in withFace's terms: undefined removes the entry, null is "own picture here
 * on purpose", otherwise a fill. a clip keeps the fit that was chosen before when the row showed a clip already.
 */
export function fillFromChoice(value: string, row: SideRow, faces: Faces | undefined, clip: { type: string; color?: string }): FaceFill | null | undefined {
  if (value === SAME) return undefined;
  if (value === OWN) return row.all || !faces?.[FACE_ALL] ? undefined : null;
  if (value === COLOR) return { color: rowColor(faces, row) ?? startColor(clip) };
  const fit = rowFit(faces, row);
  return fit ? { clip: value, fit } : { clip: value };
}

/** the fill for a new fit on a row that shows a clip */
export function withFit(faces: Faces | undefined, row: SideRow, fit: FaceFit): FaceFill | undefined {
  const id = faceClipId(entryOf(faces, row));
  return id ? { clip: id, fit } : undefined;
}

/**
 * what to hand updateClip for `faces`: the store keeps an optional field that is set to null as "not there" and ignores
 * undefined, so a result with nothing left is written as null.
 */
export function facesPatch(faces: Faces | undefined): Faces | null {
  return faces ?? null;
}

/** the solids that show a clip on a side, as [id, name] in project order. empty when it is not on any side. */
export function solidsShowing(project: Project, clipId: string): { id: string; name: string }[] {
  const users = faceSourceIds(project).get(clipId);
  if (!users) return [];
  const out: { id: string; name: string }[] = [];
  for (const c of project.clips) if (users.includes(c.id)) out.push({ id: c.id, name: baseName(c) });
  return out;
}

/** "take off": for each solid that shows the clip, its faces without it (null = nothing left). nothing when it is on no side. */
export function takeOffPatches(project: Project, clipId: string): { id: string; faces: Faces | null }[] {
  const out: { id: string; faces: Faces | null }[] = [];
  for (const s of solidsShowing(project, clipId)) {
    const solid = project.clips.find((c) => c.id === s.id);
    if (!solid || !isVisualClip(solid)) continue;
    out.push({ id: s.id, faces: facesPatch(remapFaces(solid.faces, (id) => (id === clipId ? null : undefined))) });
  }
  return out;
}
