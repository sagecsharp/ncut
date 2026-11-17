/** the grade actions: one undo step each. the toggle, reset, copy and paste return the toast text and do not toast themselves */
import { GRADE_EFFECT, canGrade, hasGrade } from '../../lib/gradeData';
import { clamp } from '../../lib/time';
import { clipEnd } from '../../lib/timelineOps';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { useUi } from '../../store/ui';
import { clipDisplayName } from '../timeline/effectTarget';
import { clipLabel } from '../timeline/trimText';
import { getGradeCopy, setGradeCopy } from './gradeClipboard';
import { captureGrade, planGradeOnOff, planPasteGrade, planResetGrade } from './gradePlan';
import type { GradeEdit } from './gradePlan';

export const GRADE_TEXT = {
  gradeFirst: 'select a video, image, text or shape clip, or a grade effect, first',
  noGrade: 'the selected clips have no grade',
  copyGradeFirst: 'copy a grade first',
  trackLocked: 'the track is locked',
} as const;

const clips = (n: number): string => (n === 1 ? '1 clip' : `${n} clips`);

/** all edits in one undo step. the keys on the wheels go at the playhead, clamped into the clip */
export function applyGradeEdits(edits: readonly GradeEdit[]): void {
  const ed = useEditor.getState();
  if (edits.length === 0 || !ed.project) return;
  const playhead = usePlayback.getState().time;
  ed.pushHistory();
  for (const edit of edits) {
    const c = useEditor.getState().project?.clips.find((x) => x.id === edit.id);
    if (!c) continue;
    const t = clamp(playhead, c.start, clipEnd(c));
    for (const prop of edit.clearKeys) useEditor.getState().clearKeyframes(edit.id, t, prop, { skipHistory: true });
    useEditor.getState().updateClip(edit.id, { grade: edit.grade }, { skipHistory: true });
  }
}

/** why nothing can happen to these clips: no grade clip at all, or none with a grade */
function nothingText(ids: readonly string[]): string {
  const p = useEditor.getState().project;
  const can = p ? p.clips.filter((c) => ids.includes(c.id) && canGrade(c)) : [];
  if (can.length === 0) return GRADE_TEXT.gradeFirst;
  if (!can.some(hasGrade)) return GRADE_TEXT.noGrade;
  return GRADE_TEXT.trackLocked;
}

export function toggleGradeOn(ids: readonly string[]): string {
  const p = useEditor.getState().project;
  if (!p) return GRADE_TEXT.gradeFirst;
  const plan = planGradeOnOff(p.clips, p.tracks, ids);
  if (plan.edits.length === 0) return nothingText(ids);
  applyGradeEdits(plan.edits);
  return `grade ${plan.on ? 'on' : 'off'}: ${clips(plan.edits.length)}`;
}

export function resetGrades(ids: readonly string[]): string {
  const p = useEditor.getState().project;
  if (!p) return GRADE_TEXT.gradeFirst;
  const edits = planResetGrade(p.clips, p.tracks, ids);
  if (edits.length === 0) return nothingText(ids);
  applyGradeEdits(edits);
  return `reset the grade of ${clips(edits.length)}`;
}

/** remembers the grade of the first selected clip that has one, as it shows at the playhead */
export function copyGradeOf(ids: readonly string[]): string {
  const p = useEditor.getState().project;
  if (!p) return GRADE_TEXT.gradeFirst;
  for (const id of ids) {
    const c = p.clips.find((x) => x.id === id);
    if (!c || !canGrade(c) || !hasGrade(c)) continue;
    setGradeCopy(captureGrade(c, usePlayback.getState().time), clipDisplayName(c));
    return `copied the grade of ${clipLabel(p, id)}`;
  }
  return nothingText(ids);
}

export function pasteGradeOn(ids: readonly string[]): string {
  const p = useEditor.getState().project;
  if (!p || !p.clips.some((c) => ids.includes(c.id) && canGrade(c))) return GRADE_TEXT.gradeFirst;
  const copy = getGradeCopy();
  if (!copy) return GRADE_TEXT.copyGradeFirst;
  const edits = planPasteGrade(p.clips, p.tracks, ids, copy.grade);
  if (edits.length === 0) return GRADE_TEXT.trackLocked;
  applyGradeEdits(edits);
  return `pasted the grade on ${clips(edits.length)}`;
}

/** shows the grade in the look tab: the section of one clip, or of several */
export function showGrade(ids: readonly string[]): void {
  useUi.getState().revealSection(ids.length > 1 ? 'm-grade' : 'grade');
}

/** a grade effect at the playhead */
export function addGradeEffect(): void {
  const id = useEditor.getState().addEffect(GRADE_EFFECT, { start: usePlayback.getState().time });
  if (id) useUi.getState().revealSection('grade');
}
