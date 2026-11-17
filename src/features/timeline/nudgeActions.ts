/**
 * nudges in time (alt + arrows) and the up / down steps through edits. the module state, the toast and the key routing are
 * real, and so are nudgeBy, stepEdit and applyNudge.
 */
import type { Project } from '../../types';
import { CUT_EPS } from '../../lib/transitions';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { useUi } from '../../store/ui';
import type { TrimEdge } from '../../store/ui';
import { REASON_TEXT, editEndReason, reasonSnapshot } from '../shell/reasons';
import { selectableIds } from '../../store/selectableIds';
import { keyPanelHasKeys, nudgeKeysBy } from './keyLaneActions';
import { groupIds } from './selectionRules';
import { NUDGE_TEXT, isFollowerClip, liveEdge, planEditStep, planNudge } from './timeNudge';
import type { NudgePlan } from './timeNudge';
import { edgePlan } from './trimModes';
import { clearTrimEdge, nudgeTrimEdge } from './trimActions';
import { TRIM_TEXT, lockedTracksText, trimStopText } from './trimText';
import { interaction } from './view';

/** the project object the last nudge made: a repeat joins its step only while nothing else changed it */
let lastNudged: Project | null = null;
/** the toast shown last, and when */
let lastToast: { text: string; at: number } | null = null;
/** the edge an up / down step selected, and the kind it keeps for the next step */
let stepLike: { at: TrimEdge; like: TrimEdge } | null = null;

/** a toast's life, ms */
const TOAST_LIFE = 3000;

/** clears all three (tests) */
export function resetNudgeState(): void {
  lastNudged = null;
  lastToast = null;
  stepLike = null;
}

/** false inside the preview stage or the source view: there the arrows belong to the picture */
export function keysOnTimeline(target: EventTarget | null | undefined): boolean {
  const el = target as { closest?: (s: string) => unknown } | null | undefined;
  return !(el && typeof el.closest === 'function' && el.closest('.preview-stage, .preview-pane.is-source'));
}

/** a held key toasts once: the same text again within 3000 ms (a toast's life) is dropped */
export function toastOnce(message: string): void {
  const now = Date.now();
  if (lastToast && lastToast.text === message && now - lastToast.at < TOAST_LIFE) return;
  lastToast = { text: message, at: now };
  useUi.getState().toast(message);
}

/** is the source view the active view */
export function sourceActive(): boolean {
  return reasonSnapshot().source?.active === true;
}

export function nudgeKey(frames: number, e: KeyboardEvent): void {
  if (keysOnTimeline(e.target)) nudgeBy(frames, e.repeat);
  else toastOnce(sourceActive() ? REASON_TEXT.sourceHasKeys : NUDGE_TEXT.previewKeys);
}

/** the plan is applied in one moveClips call. a held key joins the step of the press before (skipHistory). false when nothing moved */
export function applyNudge(plan: NudgePlan, join: boolean): boolean {
  if (interaction.gestureActive || plan.stop || plan.moves.length === 0) return false;
  if (!useEditor.getState().moveClips(plan.moves, join ? { skipHistory: true } : undefined)) return false;
  const p = useEditor.getState().project!;
  lastNudged = p; // any other change makes a new project object: the next press is a new step
  if (plan.lockedStay.length > 0) toastOnce(TRIM_TEXT.lockedStay.replace('{tracks}', lockedTracksText(p, plan.lockedStay)));
  return true;
}

/** alt + arrows: the selected edge goes by frames, else the selected clips. a blocked press says why, once */
export function nudgeBy(frames: number, repeat = false): void {
  const st = useEditor.getState();
  const p = st.project;
  if (!p || interaction.gestureActive) return;
  if (keyPanelHasKeys()) { nudgeKeysBy(frames, repeat); return; }
  if (sourceActive()) { toastOnce(REASON_TEXT.sourceHasKeys); return; }
  if (p.clips.length === 0) { toastOnce(REASON_TEXT.addClip); return; }
  const e = liveEdge(p, useUi.getState().trimEdge);
  if (e) {
    const tp = edgePlan(p, e, frames / p.fps, e.alone ? [e.clipId] : st.selection);
    if (!tp || tp.stop || tp.ops.length === 0) toastOnce(tp?.stop ? trimStopText(tp.stop, p) : REASON_TEXT.pickEdge);
    else nudgeTrimEdge(frames);
    return;
  }
  clearTrimEdge(); // a stored edge whose clip is gone
  const plan = planNudge(p, st.selection, frames);
  if (plan.stop) { toastOnce(trimStopText(plan.stop, p)); return; }
  if (plan.moves.length === 0) { toastOnce(REASON_TEXT.selectClip); return; }
  applyNudge(plan, repeat && lastNudged === p);
}

/** up / down: the playhead goes to the previous or next edit. with an edge selected the edge goes there too */
export function stepEdit(dir: -1 | 1): void {
  if (interaction.gestureActive) return;
  const st = useEditor.getState();
  const p = st.project;
  if (!p) return;
  if (sourceActive()) { toastOnce(REASON_TEXT.sourceHasKeys); return; }
  if (p.clips.length === 0) { toastOnce(REASON_TEXT.addClip); return; }
  const edge = liveEdge(p, useUi.getState().trimEdge);
  const same = !!stepLike && !!edge && stepLike.at.clipId === edge.clipId && stepLike.at.edge === edge.edge && stepLike.at.both === edge.both && stepLike.at.alone === edge.alone;
  const like = same ? stepLike!.like : edge;
  const step = planEditStep(p, st.selection, edge, usePlayback.getState().time, dir, like);
  if (step.time === null) { toastOnce(editEndReason(step.scope, dir)); return; }
  if (step.edge) {
    const ids = step.edge.alone ? [step.edge.clipId] : groupIds(p, step.edge.clipId);
    if (step.edge.both) {
      const c = p.clips.find((x) => x.id === step.edge!.clipId)!;
      const r = p.clips.find((x) => x.trackId === c.trackId && !isFollowerClip(x) && Math.abs(x.start - step.time!) <= CUT_EPS);
      if (r) ids.push(...(step.edge.alone ? [r.id] : groupIds(p, r.id)));
    }
    // only ids that can be selected: a locked group mate never is, so it must not count as missing
    const want = selectableIds(p, [...new Set(ids)]);
    if (!want.every((id) => st.selection.includes(id))) st.select(want, 'replace');
    useUi.getState().setTrimEdge(step.edge);
    stepLike = { at: step.edge, like: like ?? step.edge };
  }
  usePlayback.getState().seek(step.time);
}
