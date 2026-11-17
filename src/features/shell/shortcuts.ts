/**
 * the single table of keyboard shortcuts. useShortcuts() dispatches from it and ShortcutsDialog
 * renders it, so the two can never drift.
 */
import { isVisualClip, stretchX, stretchY, stretchZ } from '../../types';
import type { VisualClip } from '../../types';
import { animProps, keyTimes } from '../../lib/anim';
import { muteTargets } from '../../lib/soundPair';
import { MAX_ZOOM, MIN_ZOOM, useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { useUi } from '../../store/ui';
import type { ExportAskInput } from '../../store/ui';
import { getLastEffect, setLastEffect } from './lastEffect';
import { SHAPE_PRESETS } from '../media/shapePresets';
import { openPalette } from './paletteStore';
import { nextMarkerTime, prevMarkerTime } from './markerNav';
import { collectSnapPoints, projectDuration } from '../../lib/timelineOps';
import { freezeAtPlayhead, groupIdsNow, selectAfterPlayhead, trimToPlayhead, ungroupIdsNow } from '../timeline/actions';
import { reasonFor, reasonSnapshot, REASON_TEXT } from './reasons';
import { timelineCommands } from '../timeline/commands';
import { clearTrimEdge, hasTrimEdge, nudgeTrimEdge, rippleToPlayhead, selectEditAtPlayhead, toggleTrimMode } from '../timeline/trimActions';
import { onView, runMatchFrame, toggleSource } from '../preview/sourceKeys';
import { clearInOut, extract, goIn, goOut, lift, markClip, markIn, markOut, playInOut } from '../timeline/rangeActions';
import { toggleSoundNow } from '../timeline/soundActions';
import { keysOnTimeline, nudgeBy, nudgeKey, stepEdit } from '../timeline/nudgeActions';
import { goToTime, goToTimeKey } from '../preview/timeEntry';
import { useScopes } from '../preview/scopesState';
import { editNow } from '../timeline/editActions';
import { keyPanelHasKeys } from '../timeline/keyPanelState';
import { clearKeySel, copyKeysNow, cutKeysNow, deleteKeysNow, keyPanelCommands, pasteKeysNow, selectAllKeysNow, toggleKeyPanel } from '../timeline/keyLaneActions';
import { easeKeysNow, stepKeyValuesBy, toggleGraphView } from '../timeline/graphActions';
import { clearCrossfadePick, crossfadeMenuNow, crossfadeNow, nudgeCrossfade, removePickedCrossfade } from '../timeline/crossfadeActions';
import { stepTrackHeights } from '../timeline/trackActions';

export type ShortcutGroup = 'playback' | 'editing' | 'animation' | 'markers' | 'inout' | 'timeline' | 'preview' | 'mouse' | 'fields' | 'app';

export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = ['playback', 'editing', 'animation', 'markers', 'inout', 'timeline', 'preview', 'mouse', 'fields', 'app'];

export const GROUP_LABEL: Readonly<Record<ShortcutGroup, string>> = {
  playback: 'playback',
  editing: 'editing',
  animation: 'keyframes and 3d',
  markers: 'markers',
  inout: 'in and out',
  timeline: 'timeline',
  preview: 'preview and scene view',
  mouse: 'mouse',
  fields: 'fields',
  app: 'app',
};

/** the display name of a group id (palette extras use the same ids) */
export function groupLabel(group: string): string {
  return (GROUP_LABEL as Readonly<Record<string, string>>)[group] ?? group;
}

export interface Shortcut {
  id: string;
  /** old or other words that find this row in search actions and in the ? dialog */
  also?: readonly string[];
  /** alternatives; each alternative is a list of key caps shown with .kbd */
  keys: readonly (readonly string[])[];
  group: ShortcutGroup;
  description: string;
  /** true when holding the key should repeat the action */
  repeat?: boolean;
  /** true when run() changes the project: ignored while a pointer gesture is active */
  mutates?: boolean;
  /** true for rows that only document a key handled elsewhere: shown in the ? dialog, not runnable from the palette */
  info?: boolean;
  match(e: KeyboardEvent): boolean;
  run(): void;
  /** the key handler's own run: it gets the event (focus target, repeat). search actions keep run() */
  runKey?(e: KeyboardEvent): void;
}

/* ---------- matching helpers ---------- */

const isMod = (e: KeyboardEvent) => e.ctrlKey || e.metaKey;

/** letter / named key, compared case-insensitively on e.key (works on non-us layouts) */
function keyIs(e: KeyboardEvent, key: string): boolean {
  return e.key.length === 1 ? e.key.toLowerCase() === key : e.key === key;
}

interface Mods {
  mod?: boolean;
  shift?: boolean;
}

function modsOk(e: KeyboardEvent, { mod = false, shift = false }: Mods): boolean {
  return isMod(e) === mod && e.shiftKey === shift && !e.altKey;
}

/** key matched on e.key (letters, named keys) */
const byKey = (key: string, mods: Mods = {}) => (e: KeyboardEvent) => modsOk(e, mods) && keyIs(e, key);
/** alt + a physical key, no other modifier (alt+letter types symbols on some layouts, so only punctuation uses it) */
const byAltCode = (code: string) => (e: KeyboardEvent) => e.altKey && !isMod(e) && !e.shiftKey && e.code === code;
/** alt + an arrow, shift as given. alt+left is the browser's back key: useShortcuts prevents it anyway */
const altArrow = (key: 'ArrowLeft' | 'ArrowRight', shift: boolean) => (e: KeyboardEvent) =>
  e.altKey && !isMod(e) && e.shiftKey === shift && e.key === key;
/** up / down only while the timeline has the keys: in the preview stage the arrows stay the preview's */
const timelineArrow = (key: 'ArrowUp' | 'ArrowDown') => (e: KeyboardEvent) => byKey(key)(e) && keysOnTimeline(e.target);
/** key matched on the physical position (punctuation that moves around between layouts) */
/** keys whose character is owned by another shortcut (zoom, help) on layouts where they share a physical key */
const notMapped = (e: KeyboardEvent) => !['+', '-', '=', '_', '?'].includes(e.key);
const byCode = (code: string, mods: Mods = {}) => (e: KeyboardEvent) => modsOk(e, mods) && e.code === code;
const anyOf =
  (...fns: ((e: KeyboardEvent) => boolean)[]) =>
  (e: KeyboardEvent) =>
    fns.some((f) => f(e));

/* ---------- state helpers ---------- */

function toast(message: string): void {
  useUi.getState().toast(message);
}

function seekEdge(dir: -1 | 1): void {
  const project = useEditor.getState().project;
  if (!project) return;
  const playback = usePlayback.getState();
  const t = playback.time;
  const points = collectSnapPoints(project);
  const eps = 1e-3;
  let target: number | null = null;
  if (dir < 0) {
    for (let i = points.length - 1; i >= 0; i--) {
      if (points[i]! < t - eps) {
        target = points[i]!;
        break;
      }
    }
  } else {
    for (const p of points) {
      if (p > t + eps) {
        target = p;
        break;
      }
    }
  }
  if (target !== null) playback.seek(target);
}

function seekEnd(): void {
  const project = useEditor.getState().project;
  if (project) usePlayback.getState().seek(projectDuration(project));
}

function toggleMute(): void {
  const { project, selection, updateClip } = useEditor.getState();
  if (!project) return;
  const targets = muteTargets(project.clips, selection);
  if (targets.length === 0) {
    toast(REASON_TEXT.timedFirst);
    return;
  }
  const mute = targets.some((c) => !c.muted);
  useEditor.getState().pushHistory();
  for (const c of targets) updateClip(c.id, { muted: mute }, { skipHistory: true });
}

/** jump to the previous / next keyframe of the selected clips */
function seekKeyframe(dir: -1 | 1): void {
  const { project, selection } = useEditor.getState();
  if (!project) return;
  const playback = usePlayback.getState();
  const t = playback.time;
  const eps = 1e-3;
  let target: number | null = null;
  for (const c of project.clips) {
    if (!selection.includes(c.id)) continue;
    for (const k of keyTimes(c.keyframes, undefined, c.duration)) {
      const at = c.start + k;
      if (dir < 0 ? at < t - eps && (target === null || at > target) : at > t + eps && (target === null || at < target)) {
        target = at;
      }
    }
  }
  if (target === null) toast(dir < 0 ? 'no earlier keyframe on the selection' : 'no later keyframe on the selection');
  else playback.seek(target);
}

const KEY_PROPS_VISUAL = ['x', 'y', 'scale', 'rotation', 'opacity'];

/**
 * what the key-everything shortcut keys on a visual clip: the usual props, plus a stretch only on an axis the clip is
 * stretched on or already has keys on (a clip nobody stretched does not get stretch keys it never asked for)
 */
export function visualKeyProps(c: VisualClip): string[] {
  const t = c.transform;
  const props = [...KEY_PROPS_VISUAL];
  const keyed = (p: string) => !!c.keyframes?.[p]?.length;
  if (stretchX(t) !== 1 || keyed('scaleX')) props.splice(3, 0, 'scaleX');
  if (stretchY(t) !== 1 || keyed('scaleY')) props.splice(props.includes('scaleX') ? 4 : 3, 0, 'scaleY');
  // depth only means something on a solid or on extruded 3d text
  // (any clip wrapped on a solid, text included; extruded text only when it has a depth: the same rule as the scene view)
  const solid = !!c.threeD && ((!!c.shape && c.shape !== 'plane') || (c.type === 'text' && !!c.extrude && c.extrude.depth > 0));
  if (solid && (stretchZ(t) !== 1 || keyed('scaleZ'))) props.splice(props.indexOf('rotation'), 0, 'scaleZ');
  return props;
}

/** key position, scale, rotation and opacity of the selected visual clips (every prop for cameras) at the playhead */
function addKeyframes(): void {
  const { project, selection, setKeyframe } = useEditor.getState();
  if (!project) return;
  const time = usePlayback.getState().time;
  const jobs: { id: string; prop: string }[] = [];
  let outside = false;
  for (const c of project.clips) {
    if (!selection.includes(c.id)) continue;
    const props = c.type === 'camera' ? animProps(c).map((p) => p.prop) : isVisualClip(c) ? visualKeyProps(c) : [];
    if (props.length === 0) continue;
    if (time < c.start - 1e-6 || time > c.start + c.duration + 1e-6) {
      outside = true;
      continue;
    }
    for (const prop of props) jobs.push({ id: c.id, prop });
  }
  if (jobs.length === 0) {
    toast(outside ? REASON_TEXT.playheadOnClip : REASON_TEXT.keyTarget);
    return;
  }
  useEditor.getState().pushHistory();
  for (const j of jobs) setKeyframe(j.id, j.prop, time, undefined, undefined, { skipHistory: true });
}

function toggle3d(): void {
  const { project, selection, updateClip } = useEditor.getState();
  if (!project) return;
  const targets = project.clips.filter((c) => selection.includes(c.id) && isVisualClip(c));
  if (targets.length === 0) {
    toast(REASON_TEXT.visualFirst);
    return;
  }
  const on = !targets.every((c) => isVisualClip(c) && c.threeD);
  useEditor.getState().pushHistory();
  for (const c of targets) updateClip(c.id, { threeD: on }, { skipHistory: true });
  toast(on ? '3d on' : '3d off');
}

function toggleScene(): void {
  const ui = useUi.getState();
  ui.setPreviewMode(ui.previewMode === 'scene' ? 'output' : 'scene');
}

function addMarkerHere(): void {
  const time = usePlayback.getState().time;
  const { project, addMarker } = useEditor.getState();
  if (!project) return;
  const had = project.markers?.length ?? 0;
  addMarker(time);
  const now = useEditor.getState().project?.markers?.length ?? 0;
  toast(now > had ? 'marker added' : 'there is already a marker here');
}

function seekMarker(dir: -1 | 1): void {
  const project = useEditor.getState().project;
  if (!project) return;
  const playback = usePlayback.getState();
  const target = dir < 0 ? prevMarkerTime(project.markers, playback.time) : nextMarkerTime(project.markers, playback.time);
  if (target === null) toast(dir < 0 ? 'no earlier marker' : 'no later marker');
  else playback.seek(target);
}

function addCameraHere(): void {
  useEditor.getState().addCamera({ start: usePlayback.getState().time });
}

function deleteSelection(ripple: boolean): void {
  const { selection, deleteClips } = useEditor.getState();
  if (selection.length > 0) deleteClips(selection, { ripple });
}

function zoomBy(factor: number): void {
  const { zoom, setZoom } = useEditor.getState();
  const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * factor));
  if (next !== zoom) setZoom(next);
}

export function openExport(ask?: ExportAskInput): void {
  const project = useEditor.getState().project;
  if (project && project.clips.length > 0) {
    if (ask) useUi.getState().askExport(ask);
    else useUi.getState().openDialog('export');
  } else toast('add a clip before exporting');
}

/** rows that only document a mouse move or a number box: shown in the ? dialog, never run */
function infoRows(group: ShortcutGroup, rows: readonly (readonly [string, readonly (readonly string[])[], string])[]): Shortcut[] {
  return rows.map(([id, keys, description]) => ({ id, keys, group, description, info: true, match: () => false, run: () => undefined }));
}

/* ---------- the table ---------- */

export const SHORTCUTS: readonly Shortcut[] = [
  // playback
  {
    id: 'play-pause',
    keys: [['space']],
    group: 'playback',
    description: 'play / pause',
    match: (e) => modsOk(e, {}) && (e.code === 'Space' || e.key === ' '),
    run: () => onView('play-pause', () => usePlayback.getState().toggle()),
  },
  {
    id: 'play-in-out',
    keys: [['shift', 'space']],
    group: 'playback',
    description: 'play from the in point to the out point (again = pause)',
    also: ['play in to out', 'play range', 'play the range', 'work area'],
    match: (e) => modsOk(e, { shift: true }) && (e.code === 'Space' || e.key === ' '),
    run: () => onView('play-in-out', playInOut),
  },
  {
    id: 'shuttle-back',
    keys: [['j']],
    group: 'playback',
    description: 'play backwards, again = faster',
    match: byKey('j'),
    run: () => onView('shuttle-back', () => usePlayback.getState().shuttle(-1)),
  },
  {
    id: 'pause',
    keys: [['k']],
    group: 'playback',
    description: 'pause',
    match: byKey('k'),
    run: () => onView('pause', () => usePlayback.getState().pause()),
  },
  {
    id: 'shuttle-forward',
    keys: [['l']],
    group: 'playback',
    description: 'play forward, again = faster',
    match: byKey('l'),
    run: () => onView('shuttle-forward', () => usePlayback.getState().shuttle(1)),
  },
  {
    id: 'frame-back',
    keys: [['←']],
    group: 'playback',
    description: 'back 1 frame',
    repeat: true,
    match: byKey('ArrowLeft'),
    run: () => onView('frame-back', () => usePlayback.getState().stepFrames(-1)),
  },
  {
    id: 'frame-forward',
    keys: [['→']],
    group: 'playback',
    description: 'forward 1 frame',
    repeat: true,
    match: byKey('ArrowRight'),
    run: () => onView('frame-forward', () => usePlayback.getState().stepFrames(1)),
  },
  {
    id: 'frames-back',
    keys: [['shift', '←']],
    group: 'playback',
    description: 'back 10 frames',
    repeat: true,
    match: byKey('ArrowLeft', { shift: true }),
    run: () => onView('frames-back', () => usePlayback.getState().stepFrames(-10)),
  },
  {
    id: 'frames-forward',
    keys: [['shift', '→']],
    group: 'playback',
    description: 'forward 10 frames',
    repeat: true,
    match: byKey('ArrowRight', { shift: true }),
    run: () => onView('frames-forward', () => usePlayback.getState().stepFrames(10)),
  },
  {
    id: 'seek-start',
    keys: [['home']],
    group: 'playback',
    description: 'go to start',
    match: byKey('Home'),
    run: () => onView('seek-start', () => usePlayback.getState().seek(0)),
  },
  {
    id: 'seek-end',
    keys: [['end']],
    group: 'playback',
    description: 'go to end',
    match: byKey('End'),
    run: () => onView('seek-end', seekEnd),
  },
  {
    id: 'go-to-time',
    keys: [['g']],
    group: 'playback',
    description: 'type a time: 1:30:00, 90f or 12.5s goes there, + or - moves by it (15 is 15 frames). from the timeline the + or - moves the selected clips, or trims the selected edge',
    also: ['go to timecode', 'go to time', 'go to frame', 'enter timecode', 'type a timecode', 'jump to time', 'move playhead to time', 'timecode entry'],
    match: byKey('g'),
    run: () => goToTime('timeline'),
    runKey: goToTimeKey,
  },
  {
    id: 'edge-prev',
    keys: [[',']],
    group: 'playback',
    description: 'previous clip edge (with an edge selected: trim it 1 frame left)',
    repeat: true,
    match: byCode('Comma'),
    run: () => {
      if (nudgeCrossfade(-1)) return;
      if (hasTrimEdge()) nudgeTrimEdge(-1);
      else seekEdge(-1);
    },
  },
  {
    id: 'edge-next',
    keys: [['.']],
    group: 'playback',
    description: 'next clip edge (with an edge selected: trim it 1 frame right)',
    repeat: true,
    match: byCode('Period'),
    run: () => {
      if (nudgeCrossfade(1)) return;
      if (hasTrimEdge()) nudgeTrimEdge(1);
      else seekEdge(1);
    },
  },
  {
    id: 'edit-prev',
    keys: [['↑']],
    group: 'playback',
    description: 'previous edit: the clip start or end before the playhead on the tracks of the selected clips (every track when none is selected). with an edge selected: select the edit before it on its track',
    also: ['go to previous edit point', 'previous edit point', 'previous edit', 'jump to previous edit', 'previous cut'],
    repeat: true,
    match: timelineArrow('ArrowUp'),
    run: () => stepEdit(-1),
  },
  {
    id: 'edit-next',
    keys: [['↓']],
    group: 'playback',
    description: 'next edit: the clip start or end after the playhead on the tracks of the selected clips (every track when none is selected). with an edge selected: select the edit after it on its track',
    also: ['go to next edit point', 'next edit point', 'next edit', 'jump to next edit', 'next cut'],
    repeat: true,
    match: timelineArrow('ArrowDown'),
    run: () => stepEdit(1),
  },

  // editing
  {
    id: 'split',
    mutates: true,
    keys: [['s'], ['ctrl', 'b']],
    group: 'editing',
    description: 'split at playhead',
    match: anyOf(byKey('s'), byKey('b', { mod: true })),
    run: () => {
      const r = reasonFor('split', reasonSnapshot());
      if (r) {
        toast(r);
        return;
      }
      useEditor.getState().splitClips(usePlayback.getState().time);
    },
  },
  {
    id: 'delete',
    mutates: true,
    keys: [['delete'], ['backspace']],
    group: 'editing',
    description: 'delete selection',
    match: anyOf(byKey('Delete'), byKey('Backspace')),
    run: () => {
      if (keyPanelHasKeys()) {
        deleteKeysNow();
        return;
      }
      if (removePickedCrossfade()) return;
      deleteSelection(false);
    },
  },
  {
    id: 'ripple-delete',
    mutates: true,
    keys: [['shift', 'delete']],
    group: 'editing',
    description: 'ripple delete (close the gap)',
    match: anyOf(byKey('Delete', { shift: true }), byKey('Backspace', { shift: true })),
    run: () => {
      if (keyPanelHasKeys()) {
        deleteKeysNow();
        return;
      }
      if (removePickedCrossfade()) return;
      deleteSelection(true);
    },
  },
  {
    id: 'lift',
    mutates: true,
    keys: [[';']],
    group: 'editing',
    description: 'lift: take out what is between in and out on unlocked tracks, the gap stays',
    also: ['lift', 'delete in to out', 'remove range', 'lift edit'],
    match: (e) => byCode('Semicolon')(e) && notMapped(e) && !/^[a-z]$/i.test(e.key),
    run: lift,
  },
  {
    id: 'extract',
    mutates: true,
    keys: [["'"]],
    group: 'editing',
    description: 'extract: take out what is between in and out and close up every unlocked track',
    also: ['extract', 'ripple delete in to out', 'ripple delete range', 'extract edit'],
    match: (e) => byCode('Quote')(e) && notMapped(e) && !/^[a-z]$/i.test(e.key),
    run: extract,
  },
  {
    id: 'insert-edit',
    mutates: true,
    keys: [['f9']],
    group: 'editing',
    description: 'insert: the marked part of the source view at the in point or the playhead, the clips after it move later',
    also: ['insert edit', 'insert', 'splice in', 'three point edit', 'source insert', 'insert from source'],
    match: byKey('F9'),
    run: () => (keyPanelHasKeys() ? easeKeysNow('easy') : editNow('insert')),
  },
  {
    id: 'overwrite-edit',
    mutates: true,
    keys: [['f10']],
    group: 'editing',
    description: 'overwrite: the marked part of the source view over what is on the target tracks',
    also: ['overwrite edit', 'overwrite', 'overlay edit', 'overlay', 'three point edit', 'source overwrite'],
    match: byKey('F10'),
    run: () => editNow('overwrite'),
  },
  {
    id: 'undo',
    mutates: true,
    keys: [['ctrl', 'z']],
    group: 'editing',
    description: 'undo',
    repeat: true,
    match: byKey('z', { mod: true }),
    run: () => useEditor.getState().undo(),
  },
  {
    id: 'redo',
    mutates: true,
    keys: [['ctrl', 'shift', 'z'], ['ctrl', 'y']],
    group: 'editing',
    description: 'redo',
    repeat: true,
    match: anyOf(byKey('z', { mod: true, shift: true }), byKey('y', { mod: true })),
    run: () => useEditor.getState().redo(),
  },
  {
    id: 'copy',
    keys: [['ctrl', 'c']],
    group: 'editing',
    description: 'copy',
    match: byKey('c', { mod: true }),
    run: () => (keyPanelHasKeys() ? copyKeysNow() : useEditor.getState().copySelection()),
  },
  {
    id: 'cut',
    mutates: true,
    keys: [['ctrl', 'x']],
    group: 'editing',
    description: 'cut (copy, then delete)',
    match: byKey('x', { mod: true }),
    run: () => (keyPanelHasKeys() ? cutKeysNow() : useEditor.getState().cutSelection()),
  },
  {
    id: 'paste',
    mutates: true,
    keys: [['ctrl', 'v']],
    group: 'editing',
    description: 'paste at playhead',
    match: byKey('v', { mod: true }),
    run: () => (keyPanelHasKeys() ? pasteKeysNow() : useEditor.getState().paste(usePlayback.getState().time)),
  },
  {
    id: 'duplicate',
    mutates: true,
    keys: [['ctrl', 'd']],
    group: 'editing',
    description: 'duplicate selection',
    match: byKey('d', { mod: true }),
    run: () => {
      const { selection, duplicateClips } = useEditor.getState();
      if (selection.length > 0) duplicateClips(selection);
    },
  },
  {
    id: 'select-all',
    keys: [['ctrl', 'a']],
    group: 'editing',
    description: 'select all',
    match: byKey('a', { mod: true }),
    run: () => (keyPanelHasKeys() ? selectAllKeysNow() : useEditor.getState().selectAll()),
  },
  {
    id: 'select-after',
    keys: [['ctrl', 'shift', 'a']],
    group: 'editing',
    description: 'select everything after the playhead',
    match: byKey('a', { mod: true, shift: true }),
    run: () => selectAfterPlayhead(),
  },
  {
    id: 'group',
    mutates: true,
    keys: [['ctrl', 'g']],
    group: 'editing',
    description: 'group the selected clips',
    match: byKey('g', { mod: true }),
    run: () => groupIdsNow(useEditor.getState().selection),
  },
  {
    id: 'ungroup',
    mutates: true,
    keys: [['ctrl', 'shift', 'g']],
    group: 'editing',
    description: 'ungroup the selected clips',
    match: byKey('g', { mod: true, shift: true }),
    run: () => ungroupIdsNow(useEditor.getState().selection),
  },
  {
    id: 'separate-sound',
    mutates: true,
    keys: [['ctrl', 'l']],
    group: 'editing',
    description: 'separate sound / join sound back',
    also: ['unlink', 'link', 'detach audio', 'split audio', 'extract audio', 'audio from video', 'linked selection', 'break apart', 'j cut', 'l cut'],
    match: byKey('l', { mod: true }),
    run: () => {
      const r = reasonFor('separate-sound', reasonSnapshot());
      if (r) toast(r);
      else toggleSoundNow(useEditor.getState().selection);
    },
  },
  {
    id: 'crossfade',
    mutates: true,
    keys: [['shift', 't'], ['ctrl', 'shift', 'd']],
    group: 'editing',
    description: 'crossfade the sound at the selected edit (again: remove it)',
    also: ['audio crossfade', 'audio transition', 'apply audio transition', 'equal power', 'constant power', 'constant gain', 's curve', 'audio dissolve', 'xfade'],
    match: anyOf(byKey('t', { shift: true }), byKey('d', { mod: true, shift: true })),
    run: () => {
      const r = reasonFor('crossfade', reasonSnapshot());
      if (r) toast(r);
      else crossfadeNow();
    },
  },
  {
    id: 'freeze-frame',
    mutates: true,
    keys: [['shift', 'f']],
    group: 'editing',
    description: 'freeze frame at the playhead',
    match: byKey('f', { shift: true }),
    run: freezeAtPlayhead,
  },
  {
    id: 'deselect',
    keys: [['esc']],
    group: 'editing',
    description: 'clear the selected edge, then the selection',
    match: byKey('Escape'),
    run: () => {
      if (keyPanelHasKeys()) {
        clearKeySel();
        return;
      }
      if (clearCrossfadePick()) return;
      if (!clearTrimEdge()) useEditor.getState().clearSelection();
    },
  },
  {
    id: 'add-text',
    mutates: true,
    keys: [['t']],
    group: 'editing',
    description: 'add text at playhead',
    match: byKey('t'),
    run: () => useEditor.getState().addText({ start: usePlayback.getState().time }),
  },
  {
    id: 'add-effect',
    mutates: true,
    keys: [['e']],
    group: 'editing',
    description: 'add the last used effect at playhead',
    match: byKey('e'),
    run: () => {
      const id = getLastEffect();
      const made = useEditor.getState().addEffect(id, { start: usePlayback.getState().time });
      if (made) setLastEffect(id);
    },
  },
  {
    id: 'add-shape',
    mutates: true,
    keys: [['r']],
    group: 'editing',
    description: 'add a rectangle at playhead',
    match: byKey('r'),
    run: () => {
      const { project, addShape } = useEditor.getState();
      if (project) addShape({ start: usePlayback.getState().time, preset: SHAPE_PRESETS[0]!.build(project.width, project.height) });
    },
  },
  {
    id: 'mute',
    mutates: true,
    keys: [['shift', 'm']],
    group: 'editing',
    description: 'mute / unmute selected clips',
    match: byKey('m', { shift: true }),
    run: toggleMute,
  },
  {
    id: 'trim-start',
    mutates: true,
    keys: [['[']],
    group: 'editing',
    description: 'trim start: the clip starts at the playhead',
    also: ['cut off the left side'],
    match: (e) => byCode('BracketLeft')(e) && notMapped(e),
    run: () => trimToPlayhead('start'),
  },
  {
    id: 'trim-end',
    mutates: true,
    keys: [[']']],
    group: 'editing',
    description: 'trim end: the clip ends at the playhead',
    also: ['cut off the right side'],
    match: (e) => byCode('BracketRight')(e) && notMapped(e),
    run: () => trimToPlayhead('end'),
  },
  {
    id: 'trim-mode',
    keys: [['y']],
    group: 'editing',
    description: 'trim mode on / off: edges ripple trim, where two clips touch the edit moves, the middle of a clip slips (alt: slides), shift on an edge stretches',
    also: ['ripple tool', 'ripple edit tool', 'rolling edit tool', 'rolling edit', 'roll edit', 'slip tool', 'slide tool', 'rate stretch tool', 'trim tool', 'trim edit mode'],
    match: byKey('y'),
    run: () => toggleTrimMode(),
  },
  {
    id: 'ripple-start',
    mutates: true,
    keys: [['q']],
    group: 'editing',
    description: 'ripple trim start: the clip under the playhead loses the part before it and what follows moves left, no gap',
    also: ['ripple trim previous edit to playhead', 'trim and close up'],
    match: byKey('q'),
    run: () => rippleToPlayhead('start'),
  },
  {
    id: 'ripple-end',
    mutates: true,
    keys: [['w']],
    group: 'editing',
    description: 'ripple trim end: the clip under the playhead loses the part after it and what follows moves left, no gap (in the scene view w stays the move tool)',
    also: ['ripple trim next edit to playhead'],
    match: byKey('w'),
    run: () => rippleToPlayhead('end'),
  },
  {
    id: 'edit-select',
    keys: [['u']],
    group: 'editing',
    description: 'select the edit at the playhead and turn trim mode on (again: one side, the other side, both)',
    also: ['select nearest edit point', 'edit point type', 'toggle trim side', 'select edit point'],
    match: byKey('u'),
    run: () => selectEditAtPlayhead(),
  },
  {
    id: 'nudge-left',
    mutates: true,
    keys: [['alt', '←']],
    group: 'editing',
    description: 'nudge the selected clips 1 frame left (with an edge selected: trim it 1 frame left)',
    also: ['nudge clip selection left one frame', 'nudge left', 'nudge', 'move clip one frame left'],
    repeat: true,
    match: altArrow('ArrowLeft', false),
    run: () => nudgeBy(-1),
    runKey: (e) => nudgeKey(-1, e),
  },
  {
    id: 'nudge-right',
    mutates: true,
    keys: [['alt', '→']],
    group: 'editing',
    description: 'nudge the selected clips 1 frame right (with an edge selected: trim it 1 frame right)',
    also: ['nudge clip selection right one frame', 'nudge right', 'move clip one frame right'],
    repeat: true,
    match: altArrow('ArrowRight', false),
    run: () => nudgeBy(1),
    runKey: (e) => nudgeKey(1, e),
  },
  {
    id: 'nudge-left-big',
    mutates: true,
    keys: [['alt', 'shift', '←']],
    group: 'editing',
    description: 'nudge the selected clips 10 frames left (with an edge selected: trim it 10 frames left)',
    also: ['nudge clip selection left five frames', 'nudge left ten frames', 'move clip ten frames left'],
    repeat: true,
    match: altArrow('ArrowLeft', true),
    run: () => nudgeBy(-10),
    runKey: (e) => nudgeKey(-10, e),
  },
  {
    id: 'nudge-right-big',
    mutates: true,
    keys: [['alt', 'shift', '→']],
    group: 'editing',
    description: 'nudge the selected clips 10 frames right (with an edge selected: trim it 10 frames right)',
    also: ['nudge clip selection right five frames', 'nudge right ten frames', 'move clip ten frames right'],
    repeat: true,
    match: altArrow('ArrowRight', true),
    run: () => nudgeBy(10),
    runKey: (e) => nudgeKey(10, e),
  },
  {
    id: 'clip-menu',
    keys: [['shift', 'f10'], ['menu']],
    group: 'editing',
    description: 'open the clip menu of the selection (like a right click)',
    match: anyOf(byKey('F10', { shift: true }), byKey('ContextMenu')),
    run: () => {
      if (keyPanelHasKeys() && keyPanelCommands.openMenu) {
        keyPanelCommands.openMenu();
        return;
      }
      if (crossfadeMenuNow()) return;
      const r = reasonFor('clip-menu', reasonSnapshot());
      if (r) toast(r);
      else timelineCommands.openClipMenu?.({ focusFirst: true });
    },
  },

  // animation and 3d
  {
    id: 'key-prev',
    keys: [['shift', ',']],
    group: 'animation',
    description: 'previous keyframe of the selection (with an edge selected: trim it 10 frames left)',
    repeat: true,
    match: byCode('Comma', { shift: true }),
    run: () => {
      if (nudgeCrossfade(-10)) return;
      if (hasTrimEdge()) nudgeTrimEdge(-10);
      else seekKeyframe(-1);
    },
  },
  {
    id: 'key-next',
    keys: [['shift', '.']],
    group: 'animation',
    description: 'next keyframe of the selection (with an edge selected: trim it 10 frames right)',
    repeat: true,
    match: byCode('Period', { shift: true }),
    run: () => {
      if (nudgeCrossfade(10)) return;
      if (hasTrimEdge()) nudgeTrimEdge(10);
      else seekKeyframe(1);
    },
  },
  {
    id: 'key-add',
    mutates: true,
    keys: [['shift', 'k']],
    group: 'animation',
    description: 'keyframe position, scale, rotation and opacity (all of a camera) at playhead',
    also: ['add keyframes', 'key everything', 'was i'],
    match: byKey('k', { shift: true }),
    run: addKeyframes,
  },
  {
    id: 'key-panel',
    keys: [['shift', 'u']],
    group: 'animation',
    description: 'keyframe panel on / off: one row per animated value of the selected clips, under the tracks',
    also: ['dope sheet', 'keyframe lanes', 'timeline keyframes', 'reveal animated properties', 'show keyframes', 'property rows', 'key editor'],
    match: byKey('u', { shift: true }),
    run: toggleKeyPanel,
  },
  {
    id: 'key-panel-keys',
    keys: [['delete'], ['ctrl', 'c'], ['ctrl', 'x'], ['ctrl', 'v'], ['ctrl', 'a'], ['alt', '←'], ['alt', '→'], ['enter'], ['esc']],
    group: 'animation',
    description: 'in the keyframe panel these keys work on the selected keyframes, never on clips: delete, copy, copy and delete, paste at the playhead, select every keyframe, nudge one frame (shift: ten), enter selects the keyframes at the playhead, esc clears',
    info: true,
    match: () => false,
    run: () => undefined,
  },
  {
    id: 'key-graph',
    keys: [['shift', 'g']],
    group: 'animation',
    description: 'graph view of the keyframe panel on / off: one line per animated value, with its handles and speed',
    also: ['graph editor', 'curve editor', 'f-curve', 'function curves', 'value graph', 'speed graph'],
    match: byKey('g', { shift: true }),
    run: toggleGraphView,
  },
  {
    id: 'key-easy-ease',
    mutates: true,
    keys: [['shift', 'e']],
    group: 'animation',
    description: 'easy ease the selected keyframes: the value slows down into and out of them. in the keyframe panel f9 does it too',
    also: ['easy ease', 'f9', 'ease in and out', 'auto bezier'],
    match: byKey('e', { shift: true }),
    run: () => easeKeysNow('easy'),
  },
  {
    id: 'key-ease-into',
    mutates: true,
    keys: [['shift', 'f9']],
    group: 'animation',
    description: 'ease into the selected keyframes: the value slows down as it arrives',
    also: ['easy ease in', 'slow in'],
    match: byKey('F9', { shift: true }),
    run: () => easeKeysNow('into'),
  },
  {
    id: 'key-ease-out-of',
    mutates: true,
    keys: [['ctrl', 'shift', 'f9']],
    group: 'animation',
    description: 'ease out of the selected keyframes: the value starts slowly as it leaves',
    also: ['easy ease out', 'slow out'],
    match: byKey('F9', { mod: true, shift: true }),
    run: () => easeKeysNow('outOf'),
  },
  {
    id: 'key-value-up',
    mutates: true,
    repeat: true,
    keys: [['alt', '↑'], ['alt', 'shift', '↑']],
    group: 'animation',
    description: 'raise the selected keyframes one step (shift: ten), in the keyframe panel',
    match: (e) => e.altKey && !isMod(e) && e.key === 'ArrowUp' && keyPanelHasKeys(),
    runKey: (e) => stepKeyValuesBy(e.shiftKey ? 10 : 1, e.repeat),
    run: () => stepKeyValuesBy(1),
  },
  {
    id: 'key-value-down',
    mutates: true,
    repeat: true,
    keys: [['alt', '↓'], ['alt', 'shift', '↓']],
    group: 'animation',
    description: 'lower the selected keyframes one step (shift: ten), in the keyframe panel',
    match: (e) => e.altKey && !isMod(e) && e.key === 'ArrowDown' && keyPanelHasKeys(),
    runKey: (e) => stepKeyValuesBy(e.shiftKey ? -10 : -1, e.repeat),
    run: () => stepKeyValuesBy(-1),
  },
  {
    id: 'key-graph-keys',
    keys: [['f'], ['f9']],
    group: 'animation',
    description: 'in the keyframe panel f9 is easy ease on the selected keyframes (elsewhere it inserts from the source view). in the graph f frames the selected keyframes, none selected: every line',
    info: true,
    match: () => false,
    run: () => undefined,
  },
  {
    id: 'toggle-3d',
    mutates: true,
    keys: [['3']],
    group: 'animation',
    description: 'turn 3d on / off for selected clips',
    match: byKey('3'),
    run: toggle3d,
  },
  {
    id: 'toggle-scene',
    keys: [['v']],
    group: 'animation',
    description: 'switch the preview between output and scene view',
    match: byKey('v'),
    run: toggleScene,
  },
  {
    id: 'add-camera',
    mutates: true,
    keys: [['c']],
    group: 'animation',
    description: 'add a camera at playhead',
    match: byKey('c'),
    run: addCameraHere,
  },

  // markers
  {
    id: 'marker-add',
    mutates: true,
    keys: [['m']],
    group: 'markers',
    description: 'add a marker at playhead',
    match: byKey('m'),
    run: addMarkerHere,
  },
  {
    id: 'marker-prev',
    keys: [['alt', ',']],
    group: 'markers',
    description: 'previous marker',
    repeat: true,
    match: byAltCode('Comma'),
    run: () => seekMarker(-1),
  },
  {
    id: 'marker-next',
    keys: [['alt', '.']],
    group: 'markers',
    description: 'next marker',
    repeat: true,
    match: byAltCode('Period'),
    run: () => seekMarker(1),
  },

  // in and out
  {
    id: 'mark-in',
    mutates: true,
    keys: [['i']],
    group: 'inout',
    description: 'mark the in point: the frame under the playhead is the first one inside',
    also: ['in point', 'set in', 'mark in', 'set range start'],
    match: byKey('i'),
    run: () => onView('mark-in', markIn),
  },
  {
    id: 'mark-out',
    mutates: true,
    keys: [['o']],
    group: 'inout',
    description: 'mark the out point: the frame under the playhead is the last one inside',
    also: ['out point', 'set out', 'mark out', 'set range end'],
    match: byKey('o'),
    run: () => onView('mark-out', markOut),
  },
  {
    id: 'mark-clip',
    mutates: true,
    keys: [['x']],
    group: 'inout',
    description: 'mark in and out around the clip under the playhead (or the gap there)',
    also: ['mark clip', 'mark the clip', 'select clip range'],
    match: byKey('x'),
    run: () => onView('mark-clip', markClip),
  },
  {
    id: 'clear-in-out',
    mutates: true,
    keys: [['shift', 'x']],
    group: 'inout',
    description: 'clear the in and out points',
    also: ['clear in and out', 'clear marks', 'clear both marks', 'clear range', 'work area'],
    match: byKey('x', { shift: true }),
    run: () => onView('clear-in-out', clearInOut),
  },
  {
    id: 'go-in',
    keys: [['shift', 'i']],
    group: 'inout',
    description: 'go to the in point',
    also: ['go to in', 'jump to the in point'],
    match: byKey('i', { shift: true }),
    run: () => onView('go-in', goIn),
  },
  {
    id: 'go-out',
    keys: [['shift', 'o']],
    group: 'inout',
    description: 'go to the out point (the last frame inside)',
    also: ['go to out', 'jump to the out point'],
    match: byKey('o', { shift: true }),
    run: () => onView('go-out', goOut),
  },

  // timeline
  {
    id: 'zoom-in',
    keys: [['='], ['+']],
    group: 'timeline',
    description: 'zoom in',
    repeat: true,
    match: (e) =>
      !isMod(e) && !e.altKey && (e.key === '=' || e.key === '+' || e.code === 'NumpadAdd'),
    run: () => zoomBy(1.25),
  },
  {
    id: 'zoom-out',
    keys: [['-']],
    group: 'timeline',
    description: 'zoom out',
    repeat: true,
    match: (e) =>
      !isMod(e) && !e.altKey && (e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract'),
    run: () => zoomBy(1 / 1.25),
  },
  {
    id: 'snapping',
    keys: [['n']],
    group: 'timeline',
    description: 'toggle snapping',
    match: byKey('n'),
    run: () => {
      const { snapping, setSnapping } = useEditor.getState();
      setSnapping(!snapping);
      toast(snapping ? 'snapping off' : 'snapping on');
    },
  },
  {
    id: 'tracks-taller',
    mutates: true,
    repeat: true,
    keys: [['alt', '=']],
    group: 'timeline',
    description: 'taller tracks: every track one step taller',
    also: ['increase track height', 'expand tracks', 'expand all tracks', 'bigger tracks', 'track size', 'track height'],
    match: anyOf(byAltCode('Equal'), byAltCode('NumpadAdd')),
    run: () => stepTrackHeights(1),
  },
  {
    id: 'tracks-shorter',
    mutates: true,
    repeat: true,
    keys: [['alt', '-']],
    group: 'timeline',
    description: 'shorter tracks: every track one step shorter',
    also: ['decrease track height', 'minimize tracks', 'minimize all tracks', 'collapse tracks', 'smaller tracks'],
    match: anyOf(byAltCode('Minus'), byAltCode('NumpadSubtract')),
    run: () => stepTrackHeights(-1),
  },
  {
    id: 'zoom-fit',
    keys: [['shift', 'z']],
    group: 'timeline',
    description: 'zoom to fit the whole project',
    match: byKey('z', { shift: true }),
    run: () => timelineCommands.fit?.(),
  },

  {
    id: 'toggle-source',
    keys: [['shift', 'v']],
    group: 'preview',
    description: 'switch the preview to the source view and back',
    also: ['source monitor', 'source viewer', 'viewer', 'clip viewer', 'program monitor'],
    match: byKey('v', { shift: true }),
    run: toggleSource,
  },
  {
    id: 'match-frame',
    mutates: true,
    keys: [['f']],
    group: 'preview',
    description: 'match frame: show the media of the clip under the playhead at the same frame. in the source view: find this frame on the timeline',
    also: ['match frame', 'reveal in source', 'find source frame', 'reverse match frame', 'load clip into source'],
    match: byKey('f'),
    run: runMatchFrame,
  },
  {
    id: 'source-view-keys',
    keys: [['space'], ['j'], ['k'], ['l'], ['←'], ['→'], ['i'], ['o'], ['x']],
    group: 'preview',
    description: 'with the source view active, the playback and in and out keys work on its media',
    info: true,
    match: () => false,
    run: () => undefined,
  },

  // preview: the scopes
  {
    id: 'toggle-scopes',
    also: ['video scopes', 'lumetri scopes', 'waveform monitor', 'rgb parade', 'vectorscope', 'histogram', 'levels', 'ire', 'color scopes'],
    keys: [['shift', 'w']],
    group: 'preview',
    description: 'show or hide the scopes (waveform, parade, vectorscope, histogram)',
    match: byKey('w', { shift: true }),
    run: () => useScopes.getState().toggleOpen(),
  },

  // preview (handled by the preview itself; listed here so the dialog shows them)
  {
    id: 'preview-nudge',
    keys: [['←', '↑', '→', '↓']],
    group: 'preview',
    description: 'nudge the selected clip 1 px (preview focused)',
    info: true,
    match: () => false,
    run: () => undefined,
  },
  {
    id: 'preview-nudge-big',
    keys: [['shift', '←', '↑', '→', '↓']],
    group: 'preview',
    description: 'nudge the selected clip 10 px (preview focused)',
    info: true,
    match: () => false,
    run: () => undefined,
  },
  {
    id: 'preview-no-snap',
    keys: [['alt']],
    group: 'preview',
    description: 'hold while dragging to turn snapping off',
    info: true,
    match: () => false,
    run: () => undefined,
  },
  {
    id: 'preview-pivot-done',
    keys: [['esc']],
    group: 'preview',
    description: 'move pivot: done',
    info: true,
    match: () => false,
    run: () => undefined,
  },
  {
    id: 'preview-probe',
    keys: [['alt', 'hover']],
    group: 'preview',
    description: 'output view: hold over the picture to read the color of the pixel under the pointer',
    info: true,
    match: () => false,
    run: () => undefined,
  },
  {
    id: 'scene-tools',
    keys: [['w'], ['e'], ['r']],
    group: 'preview',
    description: 'scene view, unity controls: move, rotate, scale tool (scene view focused)',
    info: true,
    match: () => false,
    run: () => undefined,
  },
  {
    id: 'scene-frame',
    keys: [['f']],
    group: 'preview',
    description: 'scene view: frame the selection',
    info: true,
    match: () => false,
    run: () => undefined,
  },
  {
    id: 'scene-grab',
    keys: [['g'], ['r'], ['s']],
    group: 'preview',
    description: 'scene view, blender controls: move, rotate, scale the selection (pointer over the view). x y z pick the axis, a typed number the amount, click keeps, right click cancels',
    info: true,
    match: () => false,
    run: () => undefined,
  },
  {
    id: 'scene-clear',
    keys: [['alt', 'g'], ['alt', 'r'], ['alt', 's']],
    group: 'preview',
    description: 'scene view, blender controls: put the position, rotation or scale of the selection back',
    info: true,
    match: () => false,
    run: () => undefined,
  },
  {
    id: 'scene-copy',
    keys: [['shift', 'd']],
    group: 'preview',
    description: 'scene view, blender controls: copy the selection and move the copy',
    info: true,
    match: () => false,
    run: () => undefined,
  },
  {
    id: 'scene-delete',
    keys: [['x']],
    group: 'preview',
    description: 'scene view, blender controls: delete the selection',
    info: true,
    match: () => false,
    run: () => undefined,
  },
  {
    id: 'scene-select-all',
    keys: [['a'], ['alt', 'a']],
    group: 'preview',
    description: 'scene view, blender controls: select everything in the scene, or nothing',
    info: true,
    match: () => false,
    run: () => undefined,
  },
  {
    id: 'scene-views',
    keys: [['num 1'], ['num 3'], ['num 7'], ['num 0']],
    group: 'preview',
    description: 'scene view, blender controls: front, right, top (ctrl: the other side), through the camera. 9 flips, 2 4 6 8 rotate, + - zoom',
    info: true,
    match: () => false,
    run: () => undefined,
  },
  {
    id: 'scene-frame-all',
    keys: [['home']],
    group: 'preview',
    description: 'scene view, blender controls: everything in view',
    info: true,
    match: () => false,
    run: () => undefined,
  },
  {
    id: 'swap-media',
    keys: [['alt', 'drop']],
    group: 'mouse',
    description: 'drop media on a clip of the same kind: swap its media',
    info: true,
    match: () => false,
    run: () => undefined,
  },

  // mouse and fields (info rows: they document what the mouse and the number boxes do)
  ...infoRows('mouse', [
    ['mouse-move', [['drag']], 'a clip: move it. onto the line between two tracks: a new track there'],
    ['mouse-trim', [['drag']], 'the edge of a clip: trim it (selected clips trim together)'],
    ['mouse-ripple', [['ctrl', 'drag']], 'the edge of a clip: ripple trim it (what follows moves with it, no gap). in trim mode no ctrl is needed'],
    ['mouse-move-edit', [['drag']], 'in trim mode, where two clips touch: move the edit (one gets longer, the other shorter, nothing else moves)'],
    ['mouse-slip', [['drag']], 'in trim mode, the middle of a video or audio clip: slip it (same place and length, another part of its media)'],
    ['mouse-slide', [['alt', 'drag']], 'in trim mode, the middle of a clip: slide it (its neighbours trim to stay touching)'],
    ['mouse-stretch', [['shift', 'drag']], 'in trim mode, the edge of a video or audio clip: stretch it (the speed follows the length, 0.25x to 4x)'],
    ['mouse-edge-pick', [['click']], 'in trim mode, a clip edge: select it, then , and . trim it 1 frame (shift: 10)'],
    ['mouse-edge-alone', [['alt', 'drag']], 'in trim mode, a clip edge: trim only that clip, not its group or the other selected clips'],
    ['mouse-trim-cancel', [['esc']], 'while dragging in trim mode: put everything back'],
    ['mouse-marquee', [['drag']], 'an empty spot of a track: draw a box to select clips'],
    ['mouse-add', [['shift', 'click']], 'a clip: add it to the selection'],
    ['mouse-toggle', [['ctrl', 'click']], 'a clip: add it to the selection or take it out'],
    ['mouse-one', [['alt', 'click']], 'a clip in a group: select only that clip (one side of a separated sound: trim it alone for a j or l cut)'],
    ['mouse-key', [['drag']], 'a keyframe diamond on a clip: move the keyframe'],
    ['mouse-key-panel', [['click'], ['shift', 'click'], ['ctrl', 'click'], ['drag']], 'the keyframe panel: click a diamond to select it (shift adds, ctrl adds or drops), drag on empty space for a box, drag selected diamonds to move them'],
    ['mouse-key-stretch', [['alt', 'drag']], 'the keyframe panel: stretch the selected keyframes in time around the playhead'],
    ['mouse-graph-key', [['drag'], ['shift', 'drag'], ['double click']], 'the graph: drag keyframes in time and value (shift: only the way it moved more), double click a line to add a keyframe'],
    ['mouse-graph-handle', [['drag'], ['alt', 'drag']], 'the graph: drag a handle to shape the ease (alt: only this side, the handles break)'],
    ['mouse-graph-wheel', [['wheel'], ['alt', 'wheel']], 'the graph: wheel moves the values up and down, alt+wheel zooms them, ctrl+wheel and shift+wheel zoom and scroll time'],
    ['mouse-transition', [['drag']], 'the edge of a transition on a clip: change its length'],
    ['mouse-crossfade', [['drag']], 'the end of a crossfade: change its length (both ends while centered, alt: this end only)'],
    ['mouse-crossfade-move', [['drag']], 'the middle of a crossfade: move it across the edit (centered, starts at and ends at the edit catch it)'],
    ['mouse-crossfade-pick', [['click'], ['double click'], ['right click']], 'a crossfade: pick it (delete removes it, , and . change its length), double click: its part of the sound tab, right click: its menu'],
    ['mouse-menus', [['right click']], 'a clip, a track or the ruler: its menu (the clip menu button in the properties and the track icon open them too)'],
    ['mouse-ruler', [['click'], ['drag']], 'the ruler: move the playhead'],
    ['mouse-range', [['drag']], 'an in or out bracket on the ruler: move it (it snaps like a marker)'],
    ['mouse-marker-rename', [['double click']], 'a marker on the ruler: rename it'],
    ['mouse-track-rename', [['double click']], 'a track name: rename it'],
    ['mouse-track-move', [['drag']], 'a track header: move the track up or down among its kind (a video track higher up draws on top)'],
    ['mouse-track-height', [['drag'], ['shift', 'drag']], 'the bottom edge of a track header: the track gets taller or shorter (shift: every track of its kind). double click: normal height'],
    ['mouse-media', [['double click'], ['enter']], 'a media card: add it at the playhead, the marked part when it has an in or out point (f2 renames it)'],
    ['mouse-media-open', [['click'], ['shift', 'enter']], 'a media card: show it in the source view'],
    ['mouse-media-skim', [['hover']], 'a video card: skim through its frames (search actions turns it off)'],
    ['mouse-source-drag', [['drag']], 'the source view picture: put the marked part on the timeline. picture only and sound only take one half'],
    ['mouse-source-scrub', [['drag']], 'the bar under the source view: move its playhead. an in or out grip: move it (double click clears it)'],
    ['mouse-edit-target', [['click']], 'the target button of a track header: where insert and overwrite put the picture or the sound (shown while the source view has media)'],
    ['mouse-effect-on', [['alt', 'drop']], 'drop an effect on a clip: put it on that clip only'],
    ['mouse-lut-card', [['double click'], ['enter']], 'a lut card: put the lut on the selected clips'],
    ['mouse-lut-drop', [['drag']], 'a lut card onto a clip in the timeline: put the lut in its grade'],
    ['mouse-tl-zoom', [['ctrl', 'wheel']], 'over the timeline: zoom in or out'],
    ['mouse-tl-scroll', [['shift', 'wheel']], 'over the timeline: scroll sideways'],
    ['mouse-pv-zoom', [['ctrl', 'wheel']], 'over the preview: zoom the picture'],
    ['mouse-pv-pan', [['space', 'drag'], ['middle drag']], 'over a zoomed preview: move the picture'],
    ['mouse-pv-fit', [['double click']], 'the zoom percent of the preview: fit the picture'],
    ['mouse-canvas', [['drag']], 'the box of the selected clip in the preview: move it, scale it by a corner, rotate it by the round handle (shift: 15 degree steps)'],
    [
      'mouse-pivot',
      [['drag'], ['alt', 'drag'], ['double click']],
      'the pivot mark of the selected clip in the preview: drag it to move the pivot, the clip stays where it is. alt: no snapping. double click: back to the middle',
    ],
    ['mouse-splitter', [['double click']], 'the line between two panels: back to its default size'],
    ['mouse-fader', [['drag'], ['double click']], 'a fader in the mixer: drag up or down to change the level (shift: finer, ctrl: whole db). double click: 0 db'],
    ['mouse-solo-only', [['alt', 'click']], 'the solo button of a track: solo only that track'],
    ['mouse-meter-clear', [['click']], 'the over light of a meter: clear it'],
  ]),
  ...infoRows('fields', [
    ['field-drag', [['drag']], 'a number in the properties: drag it sideways to change it, click it to type (maths like 1920/2 works)'],
    ['field-fine', [['shift', 'drag']], 'a number in the properties: finer while dragging'],
    ['field-snap', [['ctrl', 'drag']], 'a number in the properties: round steps while dragging'],
    ['field-reset', [['double click']], 'a number in the properties: back to its rest value'],
    ['field-cancel', [['esc']], 'while dragging a number in the properties: put it back'],
    ['grade-wheel-drag', [['drag']], 'a grade wheel: drag the dot toward a color. it moves from where it is'],
    ['grade-wheel-fine', [['shift', 'drag']], 'a grade wheel: finer while dragging'],
    ['grade-wheel-hue', [['ctrl', 'drag']], 'a grade wheel: round hue steps while dragging'],
    ['grade-wheel-reset', [['double click']], 'a grade wheel: the color back to the middle, the level stays'],
    ['grade-wheel-keys', [['←'], ['→'], ['↑'], ['↓']], 'a focused grade wheel: move the dot. shift: more. delete: back to the middle'],
    ['grade-curve-add', [['click']], 'the grade curves: add a point and drag it'],
    ['grade-curve-remove', [['double click'], ['delete']], 'the grade curves: take the point off'],
    ['grade-curve-fine', [['shift', 'drag']], 'the grade curves: finer while dragging. ctrl: up and down only'],
    ['grade-curve-keys', [['['], [']'], ['←'], ['→'], ['↑'], ['↓']], 'the focused grade curves: the point before or after, move it. shift: more. enter: add a point'],
    ['field-arrows', [['↑'], ['↓']], 'a number in the properties: one step up or down (shift: 10 steps)'],
    ['field-enter', [['enter'], ['esc']], 'while typing a number in the properties: keep the typed value, or go back'],
    ['field-tabs', [['←'], ['→']], 'on the property tabs: next or previous tab (home, end: first, last)'],
    ['field-fader-keys', [['↑'], ['↓'], ['home'], ['end']], 'a fader in the mixer: half a db up or down (shift: 5 db). home: 0 db. end: off'],
  ]),

  // app
  {
    id: 'open-mixer',
    keys: [['shift', '6']],
    group: 'app',
    description: 'mixer: track levels, pan, solo and meters',
    also: ['audio track mixer', 'audio mixer', 'master', 'master volume', 'faders', 'audio levels', 'track volume', 'balance'],
    match: byCode('Digit6', { shift: true }),
    run: () => useUi.getState().showMixer(),
  },
  {
    id: 'export',
    keys: [['ctrl', 'e']],
    group: 'app',
    description: 'export',
    match: byKey('e', { mod: true }),
    run: () => openExport(),
  },
  {
    id: 'export-advanced',
    keys: [['ctrl', 'shift', 'e']],
    group: 'app',
    description: 'export, with the advanced part open',
    also: ['delivery settings', 'encoding settings', 'render settings', 'codec', 'bitrate'],
    match: byKey('e', { mod: true, shift: true }),
    run: () => openExport({ advanced: true }),
  },
  {
    id: 'shortcuts',
    keys: [['?']],
    group: 'app',
    description: 'keyboard shortcuts',
    match: (e) => !isMod(e) && !e.altKey && e.key === '?',
    run: () => useUi.getState().openDialog('shortcuts'),
  },
  {
    id: 'palette',
    keys: [['ctrl', 'k']],
    group: 'app',
    description: 'search actions (command palette)',
    match: byKey('k', { mod: true }),
    run: openPalette,
  },
  {
    id: 'settings',
    keys: [['ctrl', ',']],
    group: 'app',
    description: 'settings (app and project)',
    also: ['project settings', 'preferences'],
    match: byCode('Comma', { mod: true }),
    run: () => useUi.getState().openDialog('settings'),
  },
];

export function findShortcut(e: KeyboardEvent): Shortcut | undefined {
  return SHORTCUTS.find((s) => s.match(e));
}
