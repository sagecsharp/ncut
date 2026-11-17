import './grade.css';
import { memo, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { ClipboardPaste, Copy, Download, RotateCcw } from 'lucide-react';
import { GRADE_EPS, GRADE_KEYS, GRADE_PROPS, GRADE_WHEELS, MAX_CURVE_POINTS, gradeNum, hasGrade, isCurveNeutral, isToneKind, lutOf } from '../../lib/gradeData';
import type { CurveKind } from '../../lib/gradeData';
import { HUE_SWATCHES, hueColor } from '../../lib/gradeMath';
import { focusedByKeyboard } from '../../lib/pressKey';
import { useEditor } from '../../store/editorStore';
import { useUi } from '../../store/ui';
import type { ClipGrade, EffectClip, GradePoint, VisualClip } from '../../types';
import { tip } from '../shell/tip';
import { AnimField } from './AnimField';
import { resetWithKeys } from './animEdit';
import { FeelField, Pair, Row, Section, Switch } from './controls';
import { liveOpts, patchClip } from './edit';
import type { FeelKey } from './fieldFeel';
import { GradeCurves } from './GradeCurves';
import { copyGradeOf, pasteGradeOn, resetGrades } from './gradeActions';
import { useGradeCopy } from './gradeClipboard';
import { CURVE_TABS, addPoint, curvesPatch, gradeSummary, movePoint, pointFields, pointsOf } from './gradeLogic';
import { GradeLut } from './GradeLut';
import { saveGradeCube } from './lutActions';
import { GradeWheel } from './GradeWheel';
import { useGradeValues } from './useGradeValues';

/** not saved: the numbers box and the tab stay as they were while the app is open */
let numbersOpen = false;
let lastKind: CurveKind = 'y';

const FULL = '16 points at most here';

const TAB_TIPS: Record<CurveKind, string> = {
  y: 'brightness only, colors keep their hue. an s shape adds contrast',
  r: 'one channel alone',
  g: 'one channel alone',
  b: 'one channel alone',
  hueSat: 'pull a point down to make that hue gray',
  hueHue: 'turns one hue toward its neighbours',
  lumaSat: 'pull the ends down for clean shadows and highlights',
};

const cap = (w: string): string => w.charAt(0).toUpperCase() + w.slice(1);
const PARTS = [
  ['R', 'red'],
  ['G', 'green'],
  ['B', 'blue'],
] as const;

/** the grade of the clip as the store has it now */
function gradeNow(id: string): ClipGrade | null | undefined {
  return (useEditor.getState().project?.clips.find((c) => c.id === id) as { grade?: ClipGrade | null } | undefined)?.grade;
}

/** the color grade: four wheels with a level each, seven lists of points, reset, copy and paste */
export const GradeSection = memo(function GradeSection({ clip }: { clip: VisualClip | EffectClip }) {
  const id = clip.id;
  const grade = clip.grade;
  // like the pivot row: a locked track dims the body and the wheels and points take no input
  const locked = useEditor((s) => {
    const c = s.project?.clips.find((k) => k.id === id);
    return !!c && !!s.project?.tracks.find((t) => t.id === c.trackId)?.locked;
  });
  const lut = lutOf(grade);
  // the name of the lut media, null when it is gone: a string, so the selector compares equal
  const lutName = useEditor((s) => (lut ? (s.project?.assets.find((a) => a.id === lut.media && a.kind === 'lut')?.name ?? null) : null));
  const copied = useGradeCopy();
  const values = useGradeValues(clip);
  const [numbers, setNumbers] = useState(numbersOpen);
  const [kind, setKindState] = useState<CurveKind>(lastKind);
  const [sel, setSel] = useState(-1);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => setSel(-1), [id]);

  const setKind = (k: CurveKind): void => {
    lastKind = k;
    setKindState(k);
    setSel(-1);
  };
  const toast = (text: string): void => useUi.getState().toast(text);

  const graded = hasGrade(clip);
  const off = grade?.off === true;
  const pts = pointsOf(grade, kind);
  const picked: GradePoint | null = sel >= 0 && sel < pts.length ? pts[sel]! : null;
  const toneEnd = isToneKind(kind) && picked !== null && (sel === 0 || sel === pts.length - 1);
  const fields = pointFields(kind);
  const label = CURVE_TABS.find((t) => t.kind === kind)?.label ?? kind;
  const hueTab = kind === 'hueSat' || kind === 'hueHue';
  const listsSet = CURVE_TABS.some((t) => (grade?.curves?.[t.kind]?.length ?? 0) > 0);
  const listStored = (grade?.curves?.[kind]?.length ?? 0) > 0;
  const wheelsSet = GRADE_KEYS.some((k) => Math.abs(gradeNum(grade, k)) >= GRADE_EPS) || GRADE_PROPS.some((p) => (clip.keyframes?.[p]?.length ?? 0) > 0);

  const setOn = (on: boolean): void => {
    const g = { ...(gradeNow(id) ?? {}) };
    if (on) delete g.off;
    else g.off = true;
    patchClip(id, { grade: g });
  };

  const resetWheels = (): void => {
    const g = gradeNow(id);
    const keep: ClipGrade = {};
    if (g?.curves) keep.curves = g.curves;
    if (g?.lut) keep.lut = g.lut;
    if (g?.off) keep.off = true;
    resetWithKeys(id, GRADE_PROPS, { grade: Object.keys(keep).length > 0 ? keep : null });
  };

  const resetCurves = (): void => {
    const { curves: _curves, ...rest } = gradeNow(id) ?? {};
    patchClip(id, { grade: rest });
  };

  /** a swatch: a point at its hue with a quiet one each side, or the nearest point when there is no room */
  const addAtHue = (h: number): void => {
    const g = gradeNow(id);
    const list = pointsOf(g, kind);
    const add = addPoint(kind, list, h);
    if (add) {
      patchClip(id, { grade: curvesPatch(g, kind, add.pts) });
      setSel(add.sel);
      return;
    }
    if (list.length >= MAX_CURVE_POINTS) {
      toast(FULL);
      return;
    }
    let best = -1;
    let bestD = 2;
    list.forEach((p, i) => {
      const d = Math.abs(p[0] - h);
      const wrapped = Math.min(d, 1 - d);
      if (wrapped < bestD) {
        bestD = wrapped;
        best = i;
      }
    });
    if (best >= 0) setSel(best);
  };

  /** a box of the picked point: the other axis stays where it is */
  const setPoint = (axis: 0 | 1, shown: number): number => {
    const g = gradeNow(id);
    const list = pointsOf(g, kind);
    const cur = list[sel];
    if (!cur) return shown;
    const v = fields[axis].fromShown(shown);
    const next = movePoint(kind, list, sel, axis === 0 ? v : cur[0], axis === 1 ? v : cur[1]);
    useEditor.getState().updateClip(id, { grade: curvesPatch(g, kind, next) }, liveOpts());
    return fields[axis].toShown(next[sel]![axis]);
  };

  const onTabKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || !focusedByKeyboard()) return;
    const at = CURVE_TABS.findIndex((t) => t.kind === kind);
    let to = -1;
    if (e.key === 'ArrowRight') to = (at + 1) % CURVE_TABS.length;
    else if (e.key === 'ArrowLeft') to = (at + CURVE_TABS.length - 1) % CURVE_TABS.length;
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = CURVE_TABS.length - 1;
    if (to < 0) return;
    e.preventDefault();
    setKind(CURVE_TABS[to]!.kind);
    tabs.current[to]?.focus();
  };

  return (
    <Section id="grade" title="grade">
      {graded || off ? (
        <Row label="grade on" title="off shows the clip without its grade, to compare. the grade is kept, and the export follows the switch" wide>
          <Switch checked={!off} title="grade on or off" onChange={setOn} />
        </Row>
      ) : null}
      <div className="props-hint grade-summary">{gradeSummary(values, grade?.curves, lut ? { name: lutName === null ? null : lutName.replace(/\.cube$/i, ''), last: lut.last === true } : null)}</div>
      <div className={`grade-body${locked ? ' is-locked' : ''}`}>
        <GradeLut clip={clip} locked={locked} />
        <div className="grade-wheels">
          {GRADE_WHEELS.map((w) => (
            <GradeWheel key={w} clip={clip} wheel={w} values={values} disabled={locked} />
          ))}
        </div>
        <div className="props-buttons">
          <button
            type="button"
            className="btn btn-sm"
            aria-expanded={numbers}
            {...tip('numbers', { does: 'the red, green and blue of each wheel as number boxes' })}
            onClick={() => {
              numbersOpen = !numbers;
              setNumbers(!numbers);
            }}
          >
            numbers
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={!wheelsSet}
            {...tip('reset wheels', { does: 'all four wheels and their keys back to no change. the curves stay', off: wheelsSet ? false : 'the wheels are already at no change' })}
            onClick={resetWheels}
          >
            <RotateCcw size={14} />
            reset wheels
          </button>
        </div>
        {numbers ? (
          <div className="grade-numbers" inert={locked || undefined}>
            {GRADE_WHEELS.map((w) =>
              PARTS.map(([p, name]) => (
                <AnimField
                  key={`${w}${p}`}
                  id={id}
                  prop={`grade.${w}${p}`}
                  label={name}
                  title={`${w}, ${name} only (-100 to 100)`}
                  feel={`grade${cap(w)}${p}` as FeelKey}
                />
              )),
            )}
          </div>
        ) : null}
        <div className="grade-subhead">curves</div>
        <div className="grade-tabs" role="tablist" aria-label="curves" onKeyDown={onTabKey}>
          {CURVE_TABS.map((t, i) => (
            <button
              key={t.kind}
              ref={(el) => {
                tabs.current[i] = el;
              }}
              type="button"
              role="tab"
              className={`btn btn-sm grade-tab${t.kind === kind ? ' is-active' : ''}`}
              aria-selected={t.kind === kind}
              tabIndex={t.kind === kind ? 0 : -1}
              {...tip(t.label, { does: TAB_TIPS[t.kind] })}
              onClick={() => setKind(t.kind)}
            >
              {t.label}
              {isCurveNeutral(t.kind, grade?.curves?.[t.kind]) ? null : <span className="grade-tab-dot" aria-hidden="true" />}
            </button>
          ))}
        </div>
        <GradeCurves id={id} grade={grade} kind={kind} sel={picked ? sel : -1} onSel={setSel} disabled={locked} />
        {hueTab ? (
          <div className="grade-swatches">
            {HUE_SWATCHES.map((s) => {
              const c = hueColor(s.h);
              return (
                <button
                  key={s.name}
                  type="button"
                  className="grade-swatch"
                  style={{ backgroundColor: `rgb(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)})` }}
                  {...tip(s.name, { does: 'a point at this hue with a quiet point each side' })}
                  aria-label={`a point at ${s.name}`}
                  onClick={() => addAtHue(s.h)}
                />
              );
            })}
          </div>
        ) : null}
        <Row label="point" title={picked ? 'the picked point' : 'pick a point'}>
          <Pair>
            {fields.map((f, axis) => (
              <FeelField
                key={f.label + axis}
                feel={f.feel}
                label={f.label}
                title={picked ? f.title : 'pick a point'}
                value={picked ? f.toShown(picked[axis]!) : 0}
                disabled={locked || !picked || (axis === 0 && toneEnd)}
                onChange={(v) => setPoint(axis as 0 | 1, v)}
              />
            ))}
          </Pair>
        </Row>
        <div className="props-buttons">
          <button
            type="button"
            className="btn btn-sm"
            disabled={!listStored}
            {...tip(`reset ${label}`, { does: 'this one back to no change', off: listStored ? false : 'this one has no points' })}
            onClick={() => patchClip(id, { grade: curvesPatch(gradeNow(id), kind, null) })}
          >
            {`reset ${label}`}
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={!listsSet}
            {...tip('reset curves', { does: 'all seven back to no change. the wheels stay', off: listsSet ? false : 'there are no points on any list' })}
            onClick={resetCurves}
          >
            reset curves
          </button>
        </div>
        <div className="props-hint">curves stay the same for the whole clip. key the wheels to change over time</div>
      </div>
      <div className="props-buttons">
        <button
          type="button"
          className="btn btn-sm"
          disabled={!graded}
          {...tip('copy grade', { does: 'the wheels, curves and lut as they are at the playhead', why: 'grade-copy' })}
          onClick={() => toast(copyGradeOf([id]))}
        >
          <Copy size={14} />
          copy grade
        </button>
        <button
          type="button"
          className="btn btn-sm"
          disabled={!copied}
          {...tip('paste grade', { does: 'puts the copied grade on this clip. its own grade keys go', why: 'grade-paste' })}
          onClick={() => toast(pasteGradeOn([id]))}
        >
          <ClipboardPaste size={14} />
          paste grade
        </button>
        <button
          type="button"
          className="btn btn-sm"
          disabled={!graded}
          {...tip('reset grade', { does: 'wheels, curves, lut and keys back to no grade', why: 'grade-reset' })}
          onClick={() => toast(resetGrades([id]))}
        >
          <RotateCcw size={14} />
          reset grade
        </button>
        <button
          type="button"
          className="btn btn-sm"
          {...tip('save grade as .cube', {
            does: 'the color and grade of this clip at the playhead as a 33 point .cube file, for other apps. the key, masks and effects are not in it',
            why: 'lut-save',
          })}
          onClick={() => void saveGradeCube([id]).then((t) => t && toast(t))}
        >
          <Download size={14} />
          save as .cube
        </button>
      </div>
    </Section>
  );
});
