import { GRADE_PROPS, canGrade, hasGrade, normalizeGrade } from '../../lib/gradeData';
import { resolveClip } from '../../lib/anim';
import type { Clip, ClipGrade, Track } from '../../types';

export interface GradeEdit {
  id: string;
  grade: ClipGrade | null;
  /** the 'grade.*' keyframe lists to take off */
  clearKeys: string[];
}

/** audio and camera clips have no grade field */
const gradeOf = (c: Clip): ClipGrade | null | undefined => (c as { grade?: ClipGrade | null }).grade;

/** the clips of ids in project order that can take an edit: canGrade and on an unlocked track */
function unlockedTargets(clips: readonly Clip[], tracks: readonly Track[], ids: readonly string[]): Clip[] {
  const want = new Set(ids);
  const locked = new Set(tracks.filter((t) => t.locked).map((t) => t.id));
  return clips.filter((c) => want.has(c.id) && canGrade(c) && !locked.has(c.trackId));
}

/** the grade as it shows at time (clamped into the clip): keys resolved, curves deep copied, off dropped, normalized */
export function captureGrade(clip: Clip, time: number): ClipGrade {
  const t = Math.min(clip.start + clip.duration, Math.max(clip.start, time));
  const shown = resolveClip(clip, t);
  const grade = normalizeGrade(structuredClone(gradeOf(shown) ?? {})) ?? {};
  delete grade.off;
  return grade;
}

/** targets: canGrade, unlocked, hasGrade. any shown: all off, else all on */
export function planGradeOnOff(clips: readonly Clip[], tracks: readonly Track[], ids: readonly string[]): { edits: GradeEdit[]; on: boolean } {
  const targets = unlockedTargets(clips, tracks, ids).filter(hasGrade);
  if (targets.length === 0) return { edits: [], on: true };
  const on = !targets.some((c) => gradeOf(c)?.off !== true);
  const edits = targets.map((c): GradeEdit => {
    const grade = normalizeGrade(structuredClone(gradeOf(c) ?? {})) ?? {};
    if (on) delete grade.off;
    else grade.off = true;
    return { id: c.id, grade, clearKeys: [] };
  });
  return { edits, on };
}

/** unlocked targets with a grade: null takes the field and its keys */
export function planResetGrade(clips: readonly Clip[], tracks: readonly Track[], ids: readonly string[]): GradeEdit[] {
  return unlockedTargets(clips, tracks, ids)
    .filter(hasGrade)
    .map((c): GradeEdit => ({ id: c.id, grade: null, clearKeys: [] }));
}

/** every unlocked clip that can grade gets the grade, and loses its keys on the wheels */
export function planPasteGrade(clips: readonly Clip[], tracks: readonly Track[], ids: readonly string[], grade: ClipGrade): GradeEdit[] {
  return unlockedTargets(clips, tracks, ids).map(
    (c): GradeEdit => ({
      id: c.id,
      grade: structuredClone(grade),
      clearKeys: GRADE_PROPS.filter((p) => (c.keyframes?.[p]?.length ?? 0) > 0),
    }),
  );
}
