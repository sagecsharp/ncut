/**
 * why an action would do nothing right now. a reason is only given when the action provably changes nothing
 * (project, selection, playhead, clipboard), so a reason can never take power away from anyone.
 * pure on purpose: it must not import the shortcut table, timeline/actions, the session or anything that touches the dom.
 */
import { MIN_CLIP_DURATION, isTimedClip, isVisualClip } from '../../types';
import type { Clip, Project } from '../../types';
import { hasKeyframes } from '../../lib/anim';
import { canGrade, hasGrade } from '../../lib/gradeData';
import { cleanRange, inOutSpan, markClipSpan, rangeEditBlock, selectionSpan } from '../../lib/inOut';
import { parentOf } from '../../lib/links';
import { NO_SOLO, isMixFlat, soloActive } from '../../lib/mix';
import { marksOf } from '../../lib/marks';
import { matchFrameAt, planReverseMatch } from '../../lib/matchFrame';
import { clipEnd, projectDuration } from '../../lib/timelineOps';
import { MAX_ZOOM, MIN_ZOOM, useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { useSolo } from '../../store/solo';
import { useSource } from '../../store/source';
import { useUi } from '../../store/ui';
import type { TrimEdge } from '../../store/ui';
import { hasGradeCopy } from '../properties/gradeClipboard';
import { planTrimToPlayhead } from '../timeline/trimPlan';
import { pickFreezeTarget } from '../preview/freezePlan';
import { canCutAtMarkers, sequenceableIds } from '../timeline/sequenceActions';
import { effectsOn } from '../timeline/effectTarget';
import { planCloseGaps } from '../timeline/gaps';
import { GAP_SECONDS, planInsertGap } from '../timeline/gapInsert';
import { clipHasSound } from '../timeline/beatActions';
import { AUTO_TARGETS, editReason, selectedTargets } from '../timeline/editPlan';
import type { EditMode, EditTargets } from '../timeline/editPlan';
import { EDIT_TEXT } from '../timeline/editText';
import { currentTargets } from '../timeline/editTargets';
import { SOUND_TEXT } from '../timeline/soundText';
import { soundKeyReason } from '../timeline/soundPlan';
import { NUDGE_ROWS, liveEdge, planEditStep, planNudge } from '../timeline/timeNudge';
import type { EditScope } from '../timeline/timeNudge';
import { edgePlan, editsAt, planRippleToPlayhead, planSlide, planSlip, selectedTrimClip } from '../timeline/trimModes';
import { trimStopText } from '../timeline/trimText';

export interface ReasonInput {
  project: Project | null;
  selection: readonly string[];
  time: number;
  canUndo: boolean;
  canRedo: boolean;
  /** clips on the clipboard */
  clipboard: number;
  zoom: number;
  /** the selected trim edge (optional: tests build literals) */
  trimEdge?: TrimEdge | null;
  /** the source view: is it the active view, the open media and its time */
  source?: { active: boolean; assetId: string | null; time: number };
  /** track ids on solo (store/solo.ts) */
  solo?: readonly string[];
  /** a grade is on the grade clipboard */
  gradeCopied?: boolean;
  /** the three point edit targets */
  editTargets?: EditTargets;
}

export const REASON_TEXT = {
  ...SOUND_TEXT,
  noUndo: 'nothing to undo',
  noRedo: 'nothing to redo',
  addClip: 'add a clip first',
  selectClip: 'select a clip first',
  selectTwo: 'select 2 or more clips first',
  playheadOnClip: 'move the playhead onto the selected clip first',
  noClipUnder: 'no clip under the playhead',
  copyFirst: 'copy a clip first',
  nothingGrouped: 'nothing in the selection is grouped',
  playheadOnVideo: 'move the playhead onto a video clip first',
  keyTarget: 'select a video, image, text, shape or camera clip first',
  visualFirst: 'select a video, image, text or shape clip first',
  timedFirst: 'select a video or audio clip first',
  noKeys: 'the selection has no keyframes',
  noKeysToClear: 'the selected clips have no keyframes',
  noMarkers: 'no markers yet: mark the beats of a clip first',
  noMarkerInside: 'no marker inside the selected clips',
  zoomedIn: 'zoomed in all the way',
  zoomedOut: 'zoomed out all the way',
  notAttached: 'no selected clip is attached',
  noEffects: 'no effect is put on the selected clips',
  noClipsAfter: 'no clips after the playhead',
  noGaps: 'no gaps on the track of the selected clip',
  noMarkerHere: 'no marker at the playhead',
  soundFirst: 'select a clip with sound first',
  trackLocked: 'the track is locked',
  noEdgeHere: 'no clip edge at the playhead: up and down go to one',
  pickEdge: 'select an edge first: click one in trim mode or press u at an edit',
  sourceEmpty: 'click a media card first: it opens in the source view',
  sourcePicture: 'a picture has no time to play or mark: its length is set on the timeline',
  sourceMissing: 'this media could not be loaded',
  sourceExport: 'the source view waits while the export runs',
  noMediaUnder: 'no video, audio or picture clip under the playhead',
  notOnTimeline: 'no clip on the timeline uses this frame of the media',
  noSound: 'this media has no sound',
  noPicture: 'this media has no picture',
  previewNarrow: 'the preview is too narrow for two views: make it wider',
  splitScene: 'side by side shows the output, not the scene view',
  noInPoint: 'mark an in point first',
  noOutPoint: 'mark an out point first',
  noInOut: 'mark an in or out point first',
  inOutBoth: 'mark both an in and an out point first',
  inOutPast: 'the in point is after the end of the project',
  inOutNothing: 'nothing between the in and out points',
  inOutLocked: 'the clips between the in and out points are on locked tracks',
  noSolo: 'no track is on solo',
  mixFlat: 'every fader is at 0 db and every pan in the middle already',
  sourceHasKeys: 'the source view has the keys: click the timeline first',
  noEditBefore: 'no earlier edit',
  noEditAfter: 'no later edit',
  noEditBeforeSel: 'no earlier edit on the tracks of the selected clips',
  noEditAfterSel: 'no later edit on the tracks of the selected clips',
  noEditBeforeEdge: 'no earlier edit on the track of the selected edge',
  noEditAfterEdge: 'no later edit on the track of the selected edge',
  gradeFirst: 'select a video, image, text or shape clip, or a grade effect, first',
  noGrade: 'the selected clips have no grade',
  copyGradeFirst: 'copy a grade first',
  exactExport: 'an export is running: exact waits until it ends',
  scopesNoPicture: 'this view has no picture to measure',
  lastScope: 'one scope always shows: close the scopes to hide them all',
} as const;

/** every id reasonFor answers */
export const REASON_IDS: ReadonlySet<string> = new Set([
  'undo',
  'redo',
  'split',
  'split-all',
  'trim-start',
  'trim-end',
  'delete',
  'ripple-delete',
  'duplicate',
  'copy',
  'cut',
  'clip-menu',
  'zoom-selection',
  'select-like',
  'paste',
  'group',
  'ungroup',
  'freeze-frame',
  'key-add',
  'toggle-3d',
  'mute',
  'key-prev',
  'key-next',
  'clear-keys',
  'marker-prev',
  'marker-next',
  'fit-markers-1',
  'fit-markers-2',
  'fit-markers-4',
  'clips-in-a-row',
  'cut-at-markers',
  'zoom-in',
  'zoom-out',
  'detach',
  'select-effects',
  'insert-gap',
  'close-gaps',
  'marker-delete',
  'mark-beats',
  'ripple-start',
  'ripple-end',
  'edit-select',
  'edge-prev',
  'edge-next',
  'slip-earlier',
  'slip-later',
  'slide-left',
  'slide-right',
  'match-frame',
  'source-add',
  'mark-in',
  'mark-out',
  'mark-clip',
  'mark-selection',
  'clear-in-out',
  'clear-in',
  'clear-out',
  'go-in',
  'go-out',
  'play-in-out',
  'lift',
  'extract',
  'separate-sound',
  'join-sound',
  'move-into-sync',
  'slip-into-sync',
  'select-sound',
  'select-picture',
  'solo-selection',
  'solo-off',
  'mixer-reset',
  'go-to-time',
  'edit-prev',
  'edit-next',
  'nudge-left',
  'nudge-right',
  'nudge-left-big',
  'nudge-right-big',
  'grade-show',
  'grade-on-off',
  'grade-reset',
  'grade-copy',
  'grade-paste',
  'insert-edit',
  'overwrite-edit',
  'replace-edit',
  'fit-edit',
  'append-edit',
  'edit-targets-selected',
  'export',
]);

/** the six "no edit" texts by scope and direction */
export function editEndReason(scope: EditScope, dir: -1 | 1): string {
  const T = REASON_TEXT;
  if (scope === 'edge') return dir < 0 ? T.noEditBeforeEdge : T.noEditAfterEdge;
  if (scope === 'selection') return dir < 0 ? T.noEditBeforeSel : T.noEditAfterSel;
  return dir < 0 ? T.noEditBefore : T.noEditAfter;
}

const TIME_KEY_IDS = new Set(['go-to-time', 'edit-prev', 'edit-next', 'nudge-left', 'nudge-right', 'nudge-left-big', 'nudge-right-big']);
const EDGE_ROW: Readonly<Record<number, string>> = { [-1]: 'edge-prev', 1: 'edge-next', [-10]: 'key-prev', 10: 'key-next' };

function timeKeyReason(id: string, s: ReasonInput, p: Project): string | null {
  const T = REASON_TEXT;
  if (s.source?.active) return T.sourceHasKeys;
  if (p.clips.length === 0) return T.addClip;
  if (id === 'go-to-time') return null;
  const edge = liveEdge(p, s.trimEdge ?? null);
  if (id === 'edit-prev' || id === 'edit-next') {
    const dir = id === 'edit-prev' ? -1 : 1;
    const st = planEditStep(p, s.selection, edge, s.time, dir);
    return st.time === null ? editEndReason(st.scope, dir) : null;
  }
  const n = NUDGE_ROWS[id]!;
  if (edge) return reasonFor(EDGE_ROW[n]!, s); // trim modes' edge rows: edgePlan's stop or pickEdge
  const plan = planNudge(p, s.selection, n);
  if (plan.stop) return trimStopText(plan.stop, p);
  return plan.moves.length === 0 ? T.selectClip : null;
}

const SOURCE_IDS = new Set(['mark-in', 'mark-out', 'mark-clip', 'clear-in-out', 'go-in', 'go-out', 'play-in-out', 'match-frame']);

/** the keys that go to the source view while it is the active view. undefined: not a source question */
function sourceReason(id: string, s: ReasonInput, p: Project): string | null | undefined {
  const T = REASON_TEXT;
  const sid = s.source?.assetId ?? null;
  const a = sid ? (p.assets.find((x) => x.id === sid) ?? null) : null;
  if (id === 'source-add') return a ? null : T.sourceEmpty;
  if (!s.source?.active || !SOURCE_IDS.has(id)) return undefined;
  if (!a) return T.sourceEmpty;
  if (id === 'match-frame') return planReverseMatch(p, a.id, s.source.time, s.time, s.selection) ? null : T.notOnTimeline;
  if (a.kind === 'image') return T.sourcePicture;
  const m = marksOf(a);
  if (id === 'go-in') return m?.in !== undefined ? null : T.noInPoint;
  if (id === 'go-out') return m?.out !== undefined ? null : T.noOutPoint;
  if (id === 'clear-in-out' || id === 'play-in-out') return m ? null : T.noInOut;
  return null;
}

const EDIT_MODE_OF: Record<string, EditMode> = { 'insert-edit': 'insert', 'overwrite-edit': 'overwrite', 'replace-edit': 'replace', 'fit-edit': 'fit', 'append-edit': 'append' };

/** the state the reasons read, taken from the stores right now */
export function reasonSnapshot(): ReasonInput {
  const s = useEditor.getState();
  const ui = useUi.getState();
  const src = useSource.getState();
  return {
    project: s.project,
    selection: s.selection,
    time: usePlayback.getState().time,
    canUndo: s.past.length > 0,
    canRedo: s.future.length > 0,
    clipboard: s.clipboard.length,
    zoom: s.zoom,
    trimEdge: ui.trimEdge,
    source: { active: ui.previewMode === 'source', assetId: src.assetId, time: src.time },
    solo: useSolo.getState().solo,
    gradeCopied: hasGradeCopy(),
    editTargets: currentTargets(s.project?.id ?? null),
  };
}

/** why this action would do nothing now, or null when it can work (or when the id is not known) */
export function reasonFor(id: string, s: ReasonInput): string | null {
  const p = s.project;
  if (!p) return null;
  const T = REASON_TEXT;
  const sel = s.selection;
  const time = s.time;
  const picked = p.clips.filter((c) => sel.includes(c.id));
  const locked = new Set(p.tracks.filter((t) => t.locked).map((t) => t.id));
  const cuttable = (c: Clip): boolean => time > c.start + MIN_CLIP_DURATION && time < clipEnd(c) - MIN_CLIP_DURATION && !locked.has(c.trackId);
  const outside = (c: Clip): boolean => time < c.start - 1e-6 || time > c.start + c.duration + 1e-6;
  const markers = p.markers ?? [];
  const noClips = p.clips.length === 0;
  const noSel = sel.length === 0;
  const src = sourceReason(id, s, p);
  if (src !== undefined) return src;
  if (TIME_KEY_IDS.has(id)) return timeKeyReason(id, s, p);

  switch (id) {
    case 'undo':
      return s.canUndo ? null : T.noUndo;
    case 'redo':
      return s.canRedo ? null : T.noRedo;
    case 'split': {
      if (noClips) return T.addClip;
      const scope = sel.length > 0 ? picked : p.clips;
      if (scope.some(cuttable)) return null;
      return noSel ? T.noClipUnder : T.playheadOnClip;
    }
    case 'split-all':
      if (noClips) return T.addClip;
      return p.clips.some(cuttable) ? null : T.noClipUnder;
    case 'trim-start':
    case 'trim-end': {
      if (noClips) return T.addClip;
      const steps = planTrimToPlayhead(p.clips, p.tracks, sel, time, id === 'trim-start' ? 'start' : 'end');
      if (steps.length > 0) return null;
      return noSel ? T.noClipUnder : T.playheadOnClip;
    }
    case 'delete':
    case 'ripple-delete':
    case 'duplicate':
    case 'copy':
    case 'cut':
    case 'clip-menu':
    case 'zoom-selection':
    case 'select-like':
      return noSel ? T.selectClip : null;
    case 'paste':
      return s.clipboard === 0 ? T.copyFirst : null;
    case 'group':
      return sel.length < 2 ? T.selectTwo : null;
    case 'ungroup':
      if (noSel) return T.selectClip;
      return picked.some((c) => c.group) ? null : T.nothingGrouped;
    case 'freeze-frame':
      if (noClips) return T.addClip;
      return pickFreezeTarget(p, sel, time) ? null : T.playheadOnVideo;
    case 'key-add': {
      const keyable = picked.filter((c) => isVisualClip(c) || c.type === 'camera');
      if (keyable.length === 0) return T.keyTarget;
      return keyable.every(outside) ? T.playheadOnClip : null;
    }
    case 'toggle-3d':
      return picked.some((c) => isVisualClip(c)) ? null : T.visualFirst;
    case 'mute':
      return picked.some((c) => isTimedClip(c)) ? null : T.timedFirst;
    case 'ripple-start':
    case 'ripple-end': {
      if (noClips) return T.addClip;
      const r = planRippleToPlayhead(p, sel, time, id === 'ripple-start' ? 'start' : 'end');
      if (r.stop) return trimStopText(r.stop, p);
      if (!r.plan) return r.reason === 'not-on-selection' ? T.playheadOnClip : T.noClipUnder;
      if (r.plan.stop) return trimStopText(r.plan.stop, p);
      return r.plan.ops.length === 0 ? T.noClipUnder : null;
    }
    case 'edit-select':
      return editsAt(p, time, p.fps, sel).length === 0 ? T.noEdgeHere : null;
    case 'edge-prev':
    case 'edge-next':
    case 'key-prev':
    case 'key-next': {
      const e = s.trimEdge ?? null;
      if (e) {
        const n = id === 'edge-prev' ? -1 : id === 'edge-next' ? 1 : id === 'key-prev' ? -10 : 10;
        const tp = edgePlan(p, e, n / p.fps, e.alone ? [e.clipId] : sel);
        if (!tp) return T.pickEdge;
        if (tp.stop) return trimStopText(tp.stop, p);
        return tp.ops.length === 0 ? T.pickEdge : null;
      }
      if (id === 'edge-prev' || id === 'edge-next') return null;
      if (noSel) return T.selectClip;
      return picked.some((c) => hasKeyframes(c)) ? null : T.noKeys;
    }
    case 'slip-earlier':
    case 'slip-later': {
      const c = selectedTrimClip(p, sel, true);
      if (!c) return T.timedFirst;
      const plan = planSlip(p, c.id, ((id === 'slip-earlier' ? -1 : 1) * (isTimedClip(c) ? c.speed : 1)) / p.fps, sel);
      return plan.stop ? trimStopText(plan.stop, p) : null;
    }
    case 'slide-left':
    case 'slide-right': {
      const c = selectedTrimClip(p, sel);
      if (!c) return T.selectClip;
      const plan = planSlide(p, c.id, (id === 'slide-left' ? -1 : 1) / p.fps, sel);
      return plan.stop ? trimStopText(plan.stop, p) : null;
    }
    case 'clear-keys':
      if (noSel) return T.selectClip;
      return picked.some((c) => hasKeyframes(c)) ? null : T.noKeysToClear;
    case 'marker-prev':
    case 'marker-next':
      return markers.length === 0 ? T.noMarkers : null;
    case 'fit-markers-1':
    case 'fit-markers-2':
    case 'fit-markers-4':
      if (markers.length === 0) return T.noMarkers;
      return sequenceableIds(p, sel).length < 2 ? T.selectTwo : null;
    case 'clips-in-a-row':
      return sequenceableIds(p, sel).length < 2 ? T.selectTwo : null;
    case 'cut-at-markers':
      if (noSel) return T.selectClip;
      if (markers.length === 0) return T.noMarkers;
      return picked.some((c) => canCutAtMarkers(p, c)) ? null : T.noMarkerInside;
    case 'zoom-in':
      return s.zoom >= MAX_ZOOM ? T.zoomedIn : null;
    case 'zoom-out':
      return s.zoom <= MIN_ZOOM ? T.zoomedOut : null;
    case 'detach':
      if (noSel) return T.selectClip;
      return picked.some((c) => isVisualClip(c) && parentOf(p, c)) ? null : T.notAttached;
    case 'select-effects':
      if (noSel) return T.selectClip;
      return picked.some((c) => effectsOn(p.clips, c.id).length > 0) ? null : T.noEffects;
    case 'insert-gap':
      return planInsertGap(p.clips, p.tracks, time, GAP_SECONDS).length === 0 ? T.noClipsAfter : null;
    case 'close-gaps':
      if (picked.length === 0) return T.selectClip;
      return planCloseGaps(p.clips, picked[0]!.trackId).length === 0 ? T.noGaps : null;
    case 'marker-delete': {
      const here = markers.some((m) => Math.abs(m.time - time) <= 0.5 / p.fps);
      return here ? null : T.noMarkerHere;
    }
    case 'mark-beats':
      return picked.some((c) => clipHasSound(p, c)) ? null : T.soundFirst;
    case 'mark-in':
    case 'mark-out':
      return noClips ? T.addClip : null;
    case 'mark-clip':
      if (noClips) return T.addClip;
      return markClipSpan(p, time, sel) ? null : T.noClipUnder;
    case 'mark-selection':
      return selectionSpan(p, sel) ? null : T.selectClip;
    case 'clear-in-out':
      return cleanRange(p.range) ? null : T.noInOut;
    case 'clear-in':
    case 'go-in':
      return cleanRange(p.range)?.in !== undefined ? null : T.noInPoint;
    case 'clear-out':
    case 'go-out':
      return cleanRange(p.range)?.out !== undefined ? null : T.noOutPoint;
    case 'play-in-out':
      if (noClips) return T.addClip;
      if (!cleanRange(p.range)) return T.noInOut;
      return inOutSpan(p.range, projectDuration(p)) ? null : T.inOutPast;
    case 'lift':
    case 'extract': {
      const b = rangeEditBlock(p, id === 'extract');
      return b === 'both' ? T.inOutBoth : b === 'locked' ? T.inOutLocked : b === 'nothing' ? T.inOutNothing : null;
    }
    case 'match-frame':
      return matchFrameAt(p, time, sel) ? null : T.noMediaUnder;
    case 'separate-sound':
    case 'join-sound':
    case 'move-into-sync':
    case 'slip-into-sync':
    case 'select-sound':
    case 'select-picture':
      return soundKeyReason(id, p, sel);
    case 'solo-selection':
      if (noSel) return T.selectClip;
      return picked.some((c) => clipHasSound(p, c)) ? null : T.soundFirst;
    case 'solo-off':
      return soloActive(p, s.solo ?? NO_SOLO) ? null : T.noSolo;
    case 'mixer-reset':
      return isMixFlat(p) ? T.mixFlat : null;
    case 'grade-show':
    case 'grade-on-off':
    case 'grade-reset':
    case 'grade-copy':
    case 'grade-paste': {
      const can = picked.filter(canGrade);
      if (can.length === 0) return T.gradeFirst;
      if (id === 'grade-show') return null;
      if (id === 'grade-copy') return can.some(hasGrade) ? null : T.noGrade;
      if (id === 'grade-paste') {
        if (!s.gradeCopied) return T.copyGradeFirst;
        return can.every((c) => locked.has(c.trackId)) ? T.trackLocked : null;
      }
      const graded = can.filter(hasGrade);
      if (graded.length === 0) return T.noGrade;
      return graded.every((c) => locked.has(c.trackId)) ? T.trackLocked : null;
    }
    case 'insert-edit':
    case 'overwrite-edit':
    case 'replace-edit':
    case 'fit-edit':
    case 'append-edit': {
      const sid = s.source?.assetId ?? null;
      if (!sid) return T.sourceEmpty;
      return editReason(EDIT_MODE_OF[id]!, p, { assetId: sid, sourceTime: s.source?.time ?? 0, playhead: time, selection: sel, targets: s.editTargets ?? AUTO_TARGETS });
    }
    case 'edit-targets-selected':
      return selectedTargets(p, sel) ? null : EDIT_TEXT.targetsNone;
    case 'export':
      return noClips ? T.addClip : null;
    default:
      return null;
  }
}
