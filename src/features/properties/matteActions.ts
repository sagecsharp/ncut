/** the matte actions: one undo step each. the ones that answer return the toast text and do not toast themselves, only showMatte toasts */
import { MATTE_TEXT, matteField, matteSelectIds, matteUserIds, planMatteAbove, planMatteMode, planMatteRelease, planMatteRemove, planMatteSet } from '../../engine/matte';
import type { MatteEdit } from '../../engine/matte';
import { useEditor } from '../../store/editorStore';
import { selectableIds } from '../../store/selectableIds';
import { useUi } from '../../store/ui';
import type { MatteMode } from '../../types';
import { isVisualClip } from '../../types';
import { clipDisplayName } from '../timeline/effectTarget';

/** all edits in one undo step. an edit that changes nothing is dropped first */
export function applyMatteEdits(edits: readonly MatteEdit[]): void {
  const ed = useEditor.getState();
  const p = ed.project;
  if (!p) return;
  const real = edits.filter((e) => {
    const now = matteField(p.clips.find((c) => c.id === e.id));
    if (!e.matte) return now !== null;
    return !now || now.clip !== e.matte.clip || now.mode !== e.matte.mode;
  });
  if (real.length === 0) return;
  ed.pushHistory();
  for (const e of real) useEditor.getState().updateClip(e.id, { matte: e.matte }, { skipHistory: true });
}

/** the clip gets srcId as its matte (null takes it off). the mode is the one asked for, else the current one, else alpha */
export function setMatte(id: string, srcId: string | null, mode?: MatteMode): void {
  const p = useEditor.getState().project;
  if (!p) return;
  if (srcId === null) {
    applyMatteEdits(planMatteRemove(p, [id]));
    return;
  }
  const clip = p.clips.find((c) => c.id === id);
  applyMatteEdits(planMatteSet(p, [id], srcId, mode ?? matteField(clip)?.mode ?? 'alpha'));
}

export function setMatteMode(id: string, mode: MatteMode): void {
  const p = useEditor.getState().project;
  if (!p) return;
  applyMatteEdits(planMatteMode(p, [id], mode));
}

/** "use the clip above": the answer is the toast text, a stop text when nothing happened */
export function matteAbove(ids: readonly string[]): string {
  const p = useEditor.getState().project;
  if (!p) return MATTE_TEXT.pickOneOrTwo;
  const plan = planMatteAbove(p, ids);
  if ('stop' in plan) return plan.stop;
  applyMatteEdits(plan.edits);
  const e = plan.edits[0]!;
  const clip = p.clips.find((c) => c.id === e.id);
  const src = p.clips.find((c) => c.id === e.matte?.clip);
  return `${src ? clipDisplayName(src) : ''} is now the matte of ${clip ? clipDisplayName(clip) : ''}`;
}

function took(edits: readonly MatteEdit[], none: boolean): string {
  if (edits.length === 0) return none ? MATTE_TEXT.noMatte : MATTE_TEXT.trackLocked;
  applyMatteEdits(edits);
  return edits.length === 1 ? 'took the matte off 1 clip' : `took the matte off ${edits.length} clips`;
}

export function removeMattes(ids: readonly string[]): string {
  const p = useEditor.getState().project;
  if (!p) return MATTE_TEXT.noMatte;
  const want = new Set(ids);
  const none = !p.clips.some((c) => want.has(c.id) && isVisualClip(c) && matteField(c));
  return took(planMatteRemove(p, ids), none);
}

export function releaseMatte(srcId: string): string {
  const p = useEditor.getState().project;
  if (!p) return MATTE_TEXT.noMatte;
  return took(planMatteRelease(p, srcId), matteUserIds(p.clips, srcId).length === 0);
}

/** selects the other side of each pair: null when it did, else the text */
export function selectMatteOther(ids: readonly string[]): string | null {
  const p = useEditor.getState().project;
  if (!p) return MATTE_TEXT.noPair;
  const out = matteSelectIds(p, ids);
  if (out.length === 0) return MATTE_TEXT.noPair;
  const ok = selectableIds(p, out);
  if (ok.length === 0) return MATTE_TEXT.trackLocked;
  useEditor.getState().select(ok, 'replace');
  return null;
}

/** opens the matte section of the one picture clip that is picked, else says what to pick */
export function showMatte(ids: readonly string[]): void {
  const p = useEditor.getState().project;
  const want = new Set(ids);
  const picked = p ? p.clips.filter((c) => want.has(c.id)) : [];
  if (picked.filter(isVisualClip).length === 1) {
    // the project panel hides the clip inspector: go back to it first
    useUi.getState().showProjectPanel(false);
    useUi.getState().revealSection('matte');
  } else useUi.getState().toast('select one video, image, text or shape clip first');
}
