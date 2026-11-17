/* the pure side of the grade lut: who gets it, what the grade becomes, the cleaning of a pasted one, the size line. */
import { canGrade, lutOf, normalizeGrade, normalizeLut } from '../../lib/gradeData';
import type { Clip, ClipGrade, LutInfo, MediaAsset, Track } from '../../types';
import type { GradeEdit } from './gradePlan';

/** audio and camera clips have no grade field */
const gradeOf = (c: Clip): ClipGrade | null | undefined => (c as { grade?: ClipGrade | null }).grade;

/** the clips of ids in project order that can take an edit: canGrade and on an unlocked track */
function unlockedTargets(clips: readonly Clip[], tracks: readonly Track[], ids: readonly string[]): Clip[] {
  const want = new Set(ids);
  const locked = new Set(tracks.filter((t) => t.locked).map((t) => t.id));
  return clips.filter((c) => want.has(c.id) && canGrade(c) && !locked.has(c.trackId));
}

/** the clip has a list of keys on a grade number */
const keyedGrade = (c: Clip): boolean => !!c.keyframes && Object.keys(c.keyframes).some((k) => k.startsWith('grade.') && c.keyframes![k]!.length > 0);

/** unlocked clips that can grade get the lut. one that had a lut keeps its mix and order, made for goes when the file changes (it belongs to the file) */
export function planLutOn(clips: readonly Clip[], tracks: readonly Track[], ids: readonly string[], mediaId: string): GradeEdit[] {
  return unlockedTargets(clips, tracks, ids).map((c): GradeEdit => {
    const stored = gradeOf(c) ?? {};
    const old = lutOf(stored);
    const grade = normalizeGrade({ ...stored, lut: { media: mediaId, mix: old?.mix, last: old?.last, tv: old?.media === mediaId ? old.tv : undefined } }) ?? {};
    return { id: c.id, grade, clearKeys: [] };
  });
}

/** unlocked clips with a lut lose it. a grade with nothing else is null (which takes its keys too), or {} when it has keys */
export function planLutOff(clips: readonly Clip[], tracks: readonly Track[], ids: readonly string[]): GradeEdit[] {
  return unlockedTargets(clips, tracks, ids)
    .filter((c) => lutOf(gradeOf(c)))
    .map((c): GradeEdit => {
      const { lut: _lut, ...rest } = gradeOf(c) as ClipGrade;
      void _lut;
      const g = normalizeGrade(rest) ?? {};
      const keyed = keyedGrade(c);
      if (Object.keys(g).some((k) => k !== 'off') || (g.off && keyed)) return { id: c.id, grade: g, clearKeys: [] };
      return { id: c.id, grade: keyed ? {} : null, clearKeys: [] };
    });
}

/** what the lut row changes. false flags are real here (a Partial of the stored lut cannot say false) */
export interface LutPatch {
  media?: string;
  mix?: number;
  last?: boolean;
  tv?: boolean;
}

/** the grade with the lut changed. the lut goes through normalizeLut (mix clamped, false flags dropped), the whole through normalizeGrade. no lut and no media: the grade as it was */
export function lutPatch(grade: ClipGrade | null | undefined, patch: LutPatch): ClipGrade {
  const cur = lutOf(grade);
  const media = patch.media ?? cur?.media;
  if (!media) return grade ?? {};
  const lut = normalizeLut({
    media,
    mix: patch.mix ?? cur?.mix,
    last: patch.last ?? cur?.last,
    tv: patch.tv ?? cur?.tv,
  });
  return normalizeGrade({ ...grade, lut }) ?? {};
}

/** the same grade object unless its lut names no lut media of this project: then a copy without the lut */
export function keepKnownLut(grade: ClipGrade, assets: readonly MediaAsset[]): ClipGrade {
  const l = lutOf(grade);
  if (!l) return grade;
  if (assets.some((a) => a.id === l.media && a.kind === 'lut')) return grade;
  const { lut: _lut, ...rest } = grade;
  void _lut;
  return rest;
}

/** '3d, 33 points', '1d, 4096 points', '1d and 3d, 33 points', plus ' · title'. '' for none */
export function lutSizeText(info: LutInfo | undefined): string {
  if (!info) return '';
  const has3 = info.size3 > 0;
  const has1 = info.size1 > 0;
  let text: string;
  if (has3 && has1) text = `1d and 3d, ${info.size3} points`;
  else if (has3) text = `3d, ${info.size3} points`;
  else if (has1) text = `1d, ${info.size1} points`;
  else return '';
  return info.title ? `${text} · ${info.title}` : text;
}
