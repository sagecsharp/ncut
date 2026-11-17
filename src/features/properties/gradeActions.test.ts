import { beforeEach, describe, expect, it } from 'vitest';
import type { ClipGrade, Project } from '../../types';
import { createEffectClip, createProject, createShapeClip, createTextClip, createTrack } from '../../lib/factory';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { copyGradeOf, GRADE_TEXT, pasteGradeOn, resetGrades, toggleGradeOn } from './gradeActions';
import { getGradeCopy } from './gradeClipboard';

const ed = () => useEditor.getState();
const json = () => JSON.stringify(ed().project);

const GA: ClipGrade = { liftY: 0.2, curves: { y: [[0, 0], [0.5, 0.6], [1, 1]] } };
const GB: ClipGrade = { gainR: 0.3 };

// t1 is open, t2 is locked. a and b are graded, u has no grade, fx is a blur (it cannot grade), l is graded on the locked track
function setup(): void {
  useEditor.setState({ project: null, selection: [], past: [], future: [], clipboard: [] });
  usePlayback.setState({ time: 1 });
  const p = createProject('grade actions');
  const t1 = { ...createTrack('video', 'one'), id: 't1' };
  const t2 = { ...createTrack('video', 'two'), id: 't2', locked: true };
  const q: Project = {
    ...p,
    tracks: [t1, t2],
    clips: [
      createTextClip('t1', 0, { id: 'a', text: 'hello', duration: 5, grade: structuredClone(GA) }),
      createShapeClip('t1', 6, { id: 'b', duration: 5, grade: structuredClone(GB) }),
      createTextClip('t1', 12, { id: 'u', duration: 5 }),
      createEffectClip('blur', 'blur', 't1', 18, { id: 'fx', duration: 5 }),
      createTextClip('t2', 0, { id: 'l', duration: 5, grade: { liftB: 0.1 } }),
    ],
  };
  ed().openProject(q);
}

beforeEach(setup);

// the grade clipboard is module state: this case runs first, while nothing is copied
describe('grade actions', () => {
  it('nothing to do', () => {
    expect(pasteGradeOn(['a'])).toBe(GRADE_TEXT.copyGradeFirst);
    expect(toggleGradeOn(['fx'])).toBe(GRADE_TEXT.gradeFirst);
    expect(resetGrades(['fx'])).toBe(GRADE_TEXT.gradeFirst);
    expect(copyGradeOf(['fx'])).toBe(GRADE_TEXT.gradeFirst);
    expect(pasteGradeOn(['fx'])).toBe(GRADE_TEXT.gradeFirst);
    expect(toggleGradeOn([])).toBe(GRADE_TEXT.gradeFirst);
    expect(toggleGradeOn(['u'])).toBe(GRADE_TEXT.noGrade);
    expect(resetGrades(['u'])).toBe(GRADE_TEXT.noGrade);
    expect(copyGradeOf(['u'])).toBe(GRADE_TEXT.noGrade);
    expect(toggleGradeOn(['l'])).toBe(GRADE_TEXT.trackLocked);
    expect(resetGrades(['l'])).toBe(GRADE_TEXT.trackLocked);
    copyGradeOf(['a']);
    expect(pasteGradeOn(['l'])).toBe(GRADE_TEXT.trackLocked);
    expect(ed().past).toHaveLength(0);
    useEditor.setState({ project: null });
    expect(toggleGradeOn(['a'])).toBe(GRADE_TEXT.gradeFirst);
    expect(pasteGradeOn(['a'])).toBe(GRADE_TEXT.gradeFirst);
  });

  it('toggle, reset and paste are one undo step and count the clips', () => {
    const before = json();
    expect(toggleGradeOn(['a', 'b', 'u', 'l'])).toBe('grade off: 2 clips');
    expect(ed().past).toHaveLength(1);
    expect(toggleGradeOn(['a', 'b'])).toBe('grade on: 2 clips');
    expect(ed().past).toHaveLength(2);
    ed().undo();
    ed().undo();
    expect(json()).toBe(before);

    expect(resetGrades(['a', 'u'])).toBe('reset the grade of 1 clip');
    expect(ed().past).toHaveLength(1);
    expect('grade' in ed().project!.clips.find((c) => c.id === 'a')!).toBe(false);
    ed().undo();
    expect(json()).toBe(before);

    copyGradeOf(['a']);
    expect(pasteGradeOn(['u', 'b', 'l'])).toBe('pasted the grade on 2 clips');
    expect(ed().past).toHaveLength(1);
    expect((ed().project!.clips.find((c) => c.id === 'b') as { grade?: ClipGrade }).grade).toEqual(GA);
    ed().undo();
    expect(json()).toBe(before);
  });

  it('copy names the clip and keeps a deep copy', () => {
    expect(copyGradeOf(['u', 'b', 'a'])).toBe('copied the grade of "rect"');
    const copy = getGradeCopy()!;
    expect(copy.grade).toEqual(GB);
    expect(copyGradeOf(['a'])).toBe('copied the grade of "hello"');
    const kept = getGradeCopy()!;
    expect(kept.grade).toEqual(GA);
    const live = (ed().project!.clips.find((c) => c.id === 'a') as { grade?: ClipGrade }).grade!;
    expect(kept.grade.curves).not.toBe(live.curves);
    ed().updateClip('a', { grade: { liftY: -0.5 } });
    expect(getGradeCopy()!.grade).toEqual(GA);
  });
});
