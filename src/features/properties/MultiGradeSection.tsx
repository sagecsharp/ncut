import { memo } from 'react';
import { ClipboardPaste, RotateCcw } from 'lucide-react';
import { canGrade, hasGrade } from '../../lib/gradeData';
import { useEditor } from '../../store/editorStore';
import { useUi } from '../../store/ui';
import type { Clip } from '../../types';
import { tip } from '../shell/tip';
import { Row, Section, Switch } from './controls';
import { pasteGradeOn, resetGrades, toggleGradeOn } from './gradeActions';
import { useGradeCopy } from './gradeClipboard';
import { MultiField } from './MultiField';

const LEVELS = [
  { prop: 'grade.liftY', label: 'lift level', feel: 'gradeLiftY', title: 'how much brighter or darker the dark parts get, for every selected clip' },
  { prop: 'grade.gammaY', label: 'gamma level', feel: 'gradeGammaY', title: 'how much brighter or darker the middle tones get, for every selected clip' },
  { prop: 'grade.gainY', label: 'gain level', feel: 'gradeGainY', title: 'how much brighter or darker the bright parts get, for every selected clip' },
  { prop: 'grade.offsetY', label: 'offset level', feel: 'gradeOffsetY', title: 'how much every tone moves, for every selected clip' },
] as const;

const toast = (text: string): void => useUi.getState().toast(text);

/** the clips of ids that can grade and have a grade */
const gradedOf = (clips: readonly Clip[] | undefined, want: ReadonlySet<string>): Clip[] => (clips ?? []).filter((c) => want.has(c.id) && canGrade(c) && hasGrade(c));

/** the grade of several clips: one switch, the four levels, paste and reset */
export const MultiGradeSection = memo(function MultiGradeSection({ ids, want }: { ids: string[]; want: ReadonlySet<string> }) {
  // booleans, so the section renders only when one of them flips
  const anyGraded = useEditor((s) => gradedOf(s.project?.clips, want).length > 0);
  // the same clips the switch acts on: graded ones on unlocked tracks. every graded one locked: all of them
  const anyShown = useEditor((s) => {
    const graded = gradedOf(s.project?.clips, want);
    const locked = new Set((s.project?.tracks ?? []).filter((t) => t.locked).map((t) => t.id));
    const open = graded.filter((c) => !locked.has(c.trackId));
    return (open.length > 0 ? open : graded).some((c) => (c as { grade?: { off?: boolean } | null }).grade?.off !== true);
  });
  const copied = useGradeCopy();
  return (
    <Section id="m-grade" title="grade">
      {anyGraded ? (
        <Row label="grade on" title="off shows the clips without their grade, to compare. the grades are kept, and the export follows the switch" wide>
          <Switch checked={anyShown} title="grade on or off" onChange={() => toast(toggleGradeOn(ids))} />
        </Row>
      ) : null}
      {LEVELS.map((l) => (
        <MultiField key={l.prop} want={want} label={l.label} title={l.title} feel={l.feel} prop={l.prop} pick={canGrade} />
      ))}
      <div className="props-buttons">
        <button
          type="button"
          className="btn btn-sm"
          disabled={!copied}
          {...tip('paste grade', { does: 'puts the copied grade on every selected clip. their own grade keys go', why: 'grade-paste' })}
          onClick={() => toast(pasteGradeOn(ids))}
        >
          <ClipboardPaste size={14} />
          paste grade
        </button>
        <button
          type="button"
          className="btn btn-sm"
          disabled={!anyGraded}
          {...tip('reset grade', { does: 'wheels, curves and keys of every selected clip back to no grade', why: 'grade-reset' })}
          onClick={() => toast(resetGrades(ids))}
        >
          <RotateCcw size={14} />
          reset grade
        </button>
      </div>
      <div className="props-hint">for the wheels and curves of several clips, grade one and paste its grade</div>
    </Section>
  );
});
