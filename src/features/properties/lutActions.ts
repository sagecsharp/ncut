/**
 * the lut actions of the grade, the media panel, the preview and the search rows. each answers the text to toast,
 * '' = nothing to toast. none toasts itself, every write is one undo step (applyGradeEdits).
 */
import { isAdjustActive } from '../../engine/clipLook';
import { canGrade, hasGrade, lutOf } from '../../lib/gradeData';
import { importFiles } from '../../media/importer';
import { lutTableOf, requestLut } from '../../media/lutTables';
import { getAssetBlob } from '../../media/registry';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { isVisualClip } from '../../types';
import type { ClipGrade } from '../../types';
import { REASON_TEXT, reasonFor, reasonSnapshot } from '../shell/reasons';
import { applyGradeEdits } from './gradeActions';
import { planLutOff, planLutOn } from './lutPlan';
import { cubeOfClip, downloadText } from './lutSave';

const clips = (n: number): string => `${n} clip${n === 1 ? '' : 's'}`;

/** a private file picker: the first .cube the person picks, null on cancel */
function pickCube(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.cube';
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null));
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

/**
 * puts a lut media in the grade of these clips. answers `the lut is on ${n} clip${s}`, or the gradeFirst / trackLocked
 * reason when no clip can take it.
 */
export function putLutOn(ids: readonly string[], mediaId: string): string {
  const p = useEditor.getState().project;
  if (!p) return '';
  if (!p.assets.some((a) => a.id === mediaId && a.kind === 'lut')) return '';
  const plan = planLutOn(p.clips, p.tracks, ids, mediaId);
  if (plan.length === 0) return p.clips.some((c) => ids.includes(c.id) && canGrade(c)) ? REASON_TEXT.trackLocked : REASON_TEXT.gradeFirst;
  applyGradeEdits(plan);
  return `the lut is on ${clips(plan.length)}`;
}

/** takes the lut off these clips. answers `took the lut off ${n} clip${s}`, or the reason when it cannot */
export function lutOffOn(ids: readonly string[]): string {
  const p = useEditor.getState().project;
  if (!p) return '';
  const why = reasonFor('lut-off', { ...reasonSnapshot(), selection: ids });
  if (why) return why;
  const plan = planLutOff(p.clips, p.tracks, ids);
  if (plan.length === 0) return REASON_TEXT.noLut;
  applyGradeEdits(plan);
  return `took the lut off ${clips(plan.length)}`;
}

/**
 * picks a .cube file, imports it and puts it on these clips. answers `imported "${name}" and put it on ${n} clip${s}`
 * or `imported "${name}". drag it onto a clip, or pick it in the grade`. an import error uses the importer's toast, so
 * it answers ''.
 */
export async function importLutFor(ids: readonly string[]): Promise<string> {
  if (!useEditor.getState().project) return '';
  const file = await pickCube();
  if (!file) return '';
  const added = (await importFiles([file])).find((a) => a.kind === 'lut');
  if (!added) return '';
  const p = useEditor.getState().project;
  const plan = p ? planLutOn(p.clips, p.tracks, ids, added.id) : [];
  if (plan.length === 0) return `imported "${added.name}". drag it onto a clip, or pick it in the grade`;
  applyGradeEdits(plan);
  return `imported "${added.name}" and put it on ${clips(plan.length)}`;
}

/** saves the grade of the first of these clips as a .cube file. answers `saved "${file}"`, or `saved "${file}" without the lut (it could not be read)`. */
export async function saveGradeCube(ids: readonly string[]): Promise<string> {
  const p = useEditor.getState().project;
  if (!p) return '';
  const first = p.clips.find((c) => ids.includes(c.id) && canGrade(c));
  if (!first) return REASON_TEXT.gradeFirst;
  if (!(isVisualClip(first) && isAdjustActive(first.adjust)) && !hasGrade(first)) return REASON_TEXT.nothingToSave;
  const lut = lutOf((first as { grade?: ClipGrade | null }).grade);
  if (lut) await requestLut(lut.media, getAssetBlob);
  const out = cubeOfClip(first, usePlayback.getState().time, lutTableOf);
  downloadText(out.name, out.text);
  return out.lutLeftOut ? `saved "${out.name}" without the lut (it could not be read)` : `saved "${out.name}"`;
}
