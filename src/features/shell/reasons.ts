/**
 * why an action would do nothing right now. a reason is only given when the action provably changes nothing
 * (project, selection, playhead, clipboard), so a reason can never take power away from anyone.
 * pure on purpose: it must not import the shortcut table, timeline/actions, the session or anything that touches the dom.
 */
import { MIN_CLIP_DURATION, isTimedClip, isVisualClip } from '../../types';
import type { Clip, Project } from '../../types';
import { hasKeyframes } from '../../lib/anim';
import { parentOf } from '../../lib/links';
import { clipEnd } from '../../lib/timelineOps';
import { MAX_ZOOM, MIN_ZOOM, useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { planTrimToPlayhead } from '../timeline/trimPlan';
import { pickFreezeTarget } from '../preview/freezePlan';
import { canCutAtMarkers, sequenceableIds } from '../timeline/sequenceActions';
import { effectsOn } from '../timeline/effectTarget';
import { planCloseGaps } from '../timeline/gaps';
import { GAP_SECONDS, planInsertGap } from '../timeline/gapInsert';
import { clipHasSound } from '../timeline/beatActions';

export interface ReasonInput {
  project: Project | null;
  selection: readonly string[];
  time: number;
  canUndo: boolean;
  canRedo: boolean;
  /** clips on the clipboard */
  clipboard: number;
  zoom: number;
}

export const REASON_TEXT = {
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
  'export',
]);

/** the state the reasons read, taken from the stores right now */
export function reasonSnapshot(): ReasonInput {
  const s = useEditor.getState();
  return {
    project: s.project,
    selection: s.selection,
    time: usePlayback.getState().time,
    canUndo: s.past.length > 0,
    canRedo: s.future.length > 0,
    clipboard: s.clipboard.length,
    zoom: s.zoom,
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
    case 'key-prev':
    case 'key-next':
      if (noSel) return T.selectClip;
      return picked.some((c) => hasKeyframes(c)) ? null : T.noKeys;
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
    case 'export':
      return noClips ? T.addClip : null;
    default:
      return null;
  }
}
