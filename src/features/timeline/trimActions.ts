/** trim mode actions: the keys and search rows that trim by plan. every one is a single undo step, all or nothing, and says why when it cannot */
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { selectableIds } from '../../store/selectableIds';
import { useUi } from '../../store/ui';
import type { TrimEdge } from '../../store/ui';
import type { Project } from '../../types';
import { REASON_TEXT } from '../shell/reasons';
import { groupIds } from './selectionRules';
import { edgePlan, editsAt, planRippleToPlayhead, planSlide, planSlip, selectedTrimClip, touchingAfter } from './trimModes';
import type { Edge, EditAt, TrimPlan } from './trimModes';
import { setTrimView } from './trimLive';
import type { TrimViewReq } from './trimLive';
import { TRIM_TEXT, clipLabel, lockedTracksText, outOfSyncText, trimStopText } from './trimText';
import { interaction } from './view';

export function toggleTrimMode(): void {
  const ui = useUi.getState();
  const on = !ui.trimMode;
  ui.setTrimMode(on);
  ui.toast(on ? TRIM_TEXT.modeOn : TRIM_TEXT.modeOff);
}

/** an edge whose clip is gone still counts: nudgeTrimEdge clears it and says so */
export function hasTrimEdge(): boolean {
  return useUi.getState().trimEdge !== null;
}

export function clearTrimEdge(): boolean {
  const ui = useUi.getState();
  const had = ui.trimEdge !== null;
  if (had) ui.setTrimEdge(null);
  return had;
}

/** the plan is applied in one step. then the locked toast and the two frame view for 1.5 s. false when the store refused it */
function runPlan(p: Project, plan: TrimPlan, req: TrimViewReq): boolean {
  if (!useEditor.getState().applyTrimPlan(plan.ops)) return false;
  if (plan.lockedBehind.length > 0) useUi.getState().toast(TRIM_TEXT.lockedStay.replace('{tracks}', lockedTracksText(p, plan.lockedBehind)));
  if (plan.drift?.length) useUi.getState().toast(outOfSyncText(p, plan.drift));
  setTrimView(req, 1500);
  return true;
}

/** q (edge 'start') puts the playhead at the start of the clip it trimmed, w leaves it */
export function rippleToPlayhead(edge: Edge): void {
  if (interaction.gestureActive) return;
  const st = useEditor.getState();
  const p = st.project;
  if (!p) return;
  const toast = useUi.getState().toast;
  if (p.clips.length === 0) { toast(REASON_TEXT.addClip); return; }
  const r = planRippleToPlayhead(p, st.selection, usePlayback.getState().time, edge);
  if (r.stop) { toast(trimStopText(r.stop, p)); return; }
  if (!r.plan || !r.leader) { toast(r.reason === 'not-on-selection' ? REASON_TEXT.playheadOnClip : REASON_TEXT.noClipUnder); return; }
  if (r.plan.stop) { toast(trimStopText(r.plan.stop, p)); return; }
  if (r.plan.ops.length === 0) { toast(REASON_TEXT.noClipUnder); return; }
  if (!runPlan(p, r.plan, { mode: 'ripple', clipId: r.leader.id, edge })) return;
  if (edge === 'start') usePlayback.getState().seek(r.leader.start);
}

/** u: the edit at the playhead becomes the selected edge. again on a pair: one side, the other side, both */
export function selectEditAtPlayhead(): void {
  if (interaction.gestureActive) return;
  const st = useEditor.getState();
  const p = st.project;
  if (!p) return;
  const ui = useUi.getState();
  const list = editsAt(p, usePlayback.getState().time, p.fps, st.selection);
  if (list.length === 0) { ui.toast(REASON_TEXT.noEdgeHere); return; }
  const cur = ui.trimEdge;
  const isCur = (a: EditAt): boolean => cur !== null && ((a.clipId === cur.clipId && a.edge === cur.edge) || (a.otherId === cur.clipId && cur.edge === 'start'));
  const at = list.find(isCur) ?? list[0]!;
  let next: TrimEdge;
  let ids: string[];
  if (at.otherId === undefined) {
    next = { clipId: at.clipId, edge: at.edge, both: false, alone: false };
    ids = [at.clipId];
  } else if (cur && isCur(at) && cur.both) {
    next = { clipId: at.clipId, edge: 'end', both: false, alone: false };
    ids = [at.clipId];
  } else if (cur && isCur(at) && cur.clipId === at.clipId) {
    next = { clipId: at.otherId, edge: 'start', both: false, alone: false };
    ids = [at.otherId];
  } else {
    next = { clipId: at.clipId, edge: 'end', both: true, alone: false };
    ids = [at.clipId, at.otherId];
  }
  // only ids that can be selected: a locked group mate never is, so it must not count as missing
  const want = selectableIds(p, [...new Set(ids.flatMap((id) => groupIds(p, id)))]);
  if (!want.every((id) => st.selection.includes(id))) st.select(want, 'replace');
  ui.setTrimEdge(next);
  if (next.both) ui.toast(TRIM_TEXT.selectedEdit.replace('{a}', clipLabel(p, next.clipId)).replace('{b}', clipLabel(p, at.otherId!)));
  else ui.toast((next.edge === 'end' ? TRIM_TEXT.selectedEnd : TRIM_TEXT.selectedStart).replace('{a}', clipLabel(p, next.clipId)));
}

/** , and . (shift: 10) with an edge selected: the edge goes by frames. the playhead stays */
export function nudgeTrimEdge(frames: number): void {
  if (interaction.gestureActive) return;
  const st = useEditor.getState();
  const p = st.project;
  if (!p) return;
  const ui = useUi.getState();
  const e = ui.trimEdge;
  if (!e) return;
  const c = p.clips.find((x) => x.id === e.clipId);
  if (!c) { clearTrimEdge(); ui.toast(REASON_TEXT.pickEdge); return; }
  const plan = edgePlan(p, e, frames / p.fps, e.alone ? [e.clipId] : st.selection);
  if (!plan || (plan.ops.length === 0 && !plan.stop)) { ui.toast(REASON_TEXT.pickEdge); return; }
  if (plan.stop) { ui.toast(trimStopText(plan.stop, p)); return; }
  const r = e.both ? touchingAfter(p, c) : null;
  runPlan(p, plan, r ? { mode: 'move-edit', clipId: c.id, edge: 'end', otherId: r.id } : { mode: 'ripple', clipId: c.id, edge: e.edge });
}

/** the selected video or audio clip shows frames earlier or later of its media. a stop says why, no ops and no stop is silent */
export function slipBy(frames: number): void {
  if (interaction.gestureActive) return;
  const st = useEditor.getState();
  const p = st.project;
  if (!p) return;
  const toast = useUi.getState().toast;
  const c = selectedTrimClip(p, st.selection, true);
  if (!c) { toast(REASON_TEXT.timedFirst); return; }
  const plan = planSlip(p, c.id, (frames * (c.type === 'video' || c.type === 'audio' ? c.speed : 1)) / p.fps, st.selection);
  if (plan.stop) { toast(trimStopText(plan.stop, p)); return; }
  if (plan.ops.length === 0) return;
  runPlan(p, plan, { mode: 'slip', clipId: c.id });
}

/** the selected clip moves by frames and its neighbours trim to stay touching */
export function slideBy(frames: number): void {
  if (interaction.gestureActive) return;
  const st = useEditor.getState();
  const p = st.project;
  if (!p) return;
  const toast = useUi.getState().toast;
  const c = selectedTrimClip(p, st.selection);
  if (!c) { toast(REASON_TEXT.selectClip); return; }
  const plan = planSlide(p, c.id, frames / p.fps, st.selection);
  if (plan.stop) { toast(trimStopText(plan.stop, p)); return; }
  if (plan.ops.length === 0) return;
  runPlan(p, plan, { mode: 'slide', clipId: c.id });
}
