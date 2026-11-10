/**
 * the single table of keyboard shortcuts. useShortcuts() dispatches from it and ShortcutsDialog
 * renders it, so the two can never drift.
 */
import { isTimedClip } from '../../types';
import type { TimedClip } from '../../types';
import { MAX_ZOOM, MIN_ZOOM, useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { useUi } from '../../store/ui';
import { getLastEffect, setLastEffect } from './lastEffect';
import { collectSnapPoints, clipEnd, projectDuration } from '../../lib/timelineOps';

export type ShortcutGroup = 'playback' | 'editing' | 'timeline' | 'app';

export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = ['playback', 'editing', 'timeline', 'app'];

export interface Shortcut {
  id: string;
  /** alternatives; each alternative is a list of key caps shown with .kbd */
  keys: readonly (readonly string[])[];
  group: ShortcutGroup;
  description: string;
  /** true when holding the key should repeat the action */
  repeat?: boolean;
  match(e: KeyboardEvent): boolean;
  run(): void;
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
  const targets = project.clips.filter((c): c is TimedClip => selection.includes(c.id) && isTimedClip(c));
  if (targets.length === 0) return;
  const mute = targets.some((c) => !c.muted);
  // first change records one undo step, the rest ride along
  targets.forEach((c, i) => updateClip(c.id, { muted: mute }, { skipHistory: i > 0 }));
}

function trimToPlayhead(edge: 'start' | 'end'): void {
  const { project, selection, trimClip } = useEditor.getState();
  if (!project || selection.length === 0) return;
  const time = usePlayback.getState().time;
  const targets = project.clips.filter(
    (c) => selection.includes(c.id) && (edge === 'start' ? time < clipEnd(c) : time > c.start),
  );
  if (targets.length === 0) {
    toast('move the playhead onto the selected clip first');
    return;
  }
  targets.forEach((c, i) => trimClip(c.id, edge, time, { skipHistory: i > 0 }));
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

function openExport(): void {
  const project = useEditor.getState().project;
  if (project && project.clips.length > 0) useUi.getState().openDialog('export');
  else toast('add a clip before exporting');
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
    run: () => usePlayback.getState().toggle(),
  },
  {
    id: 'pause',
    keys: [['k']],
    group: 'playback',
    description: 'pause',
    match: byKey('k'),
    run: () => usePlayback.getState().pause(),
  },
  {
    id: 'play',
    keys: [['l']],
    group: 'playback',
    description: 'play',
    match: byKey('l'),
    run: () => usePlayback.getState().play(),
  },
  {
    id: 'frame-back',
    keys: [['←']],
    group: 'playback',
    description: 'back 1 frame',
    repeat: true,
    match: byKey('ArrowLeft'),
    run: () => usePlayback.getState().stepFrames(-1),
  },
  {
    id: 'frame-forward',
    keys: [['→']],
    group: 'playback',
    description: 'forward 1 frame',
    repeat: true,
    match: byKey('ArrowRight'),
    run: () => usePlayback.getState().stepFrames(1),
  },
  {
    id: 'frames-back',
    keys: [['shift', '←']],
    group: 'playback',
    description: 'back 10 frames',
    repeat: true,
    match: byKey('ArrowLeft', { shift: true }),
    run: () => usePlayback.getState().stepFrames(-10),
  },
  {
    id: 'frames-forward',
    keys: [['shift', '→']],
    group: 'playback',
    description: 'forward 10 frames',
    repeat: true,
    match: byKey('ArrowRight', { shift: true }),
    run: () => usePlayback.getState().stepFrames(10),
  },
  {
    id: 'seek-start',
    keys: [['home']],
    group: 'playback',
    description: 'go to start',
    match: byKey('Home'),
    run: () => usePlayback.getState().seek(0),
  },
  {
    id: 'seek-end',
    keys: [['end']],
    group: 'playback',
    description: 'go to end',
    match: byKey('End'),
    run: seekEnd,
  },
  {
    id: 'edge-prev',
    keys: [[',']],
    group: 'playback',
    description: 'previous clip edge',
    repeat: true,
    match: byCode('Comma'),
    run: () => seekEdge(-1),
  },
  {
    id: 'edge-next',
    keys: [['.']],
    group: 'playback',
    description: 'next clip edge',
    repeat: true,
    match: byCode('Period'),
    run: () => seekEdge(1),
  },

  // editing
  {
    id: 'split',
    keys: [['s'], ['ctrl', 'b']],
    group: 'editing',
    description: 'split at playhead',
    match: anyOf(byKey('s'), byKey('b', { mod: true })),
    run: () => useEditor.getState().splitClips(usePlayback.getState().time),
  },
  {
    id: 'delete',
    keys: [['delete'], ['backspace']],
    group: 'editing',
    description: 'delete selection',
    match: anyOf(byKey('Delete'), byKey('Backspace')),
    run: () => deleteSelection(false),
  },
  {
    id: 'ripple-delete',
    keys: [['shift', 'delete']],
    group: 'editing',
    description: 'ripple delete (close the gap)',
    match: anyOf(byKey('Delete', { shift: true }), byKey('Backspace', { shift: true })),
    run: () => deleteSelection(true),
  },
  {
    id: 'undo',
    keys: [['ctrl', 'z']],
    group: 'editing',
    description: 'undo',
    repeat: true,
    match: byKey('z', { mod: true }),
    run: () => useEditor.getState().undo(),
  },
  {
    id: 'redo',
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
    run: () => useEditor.getState().copySelection(),
  },
  {
    id: 'cut',
    keys: [['ctrl', 'x']],
    group: 'editing',
    description: 'cut',
    match: byKey('x', { mod: true }),
    run: () => useEditor.getState().cutSelection(),
  },
  {
    id: 'paste',
    keys: [['ctrl', 'v']],
    group: 'editing',
    description: 'paste at playhead',
    match: byKey('v', { mod: true }),
    run: () => useEditor.getState().paste(usePlayback.getState().time),
  },
  {
    id: 'duplicate',
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
    run: () => useEditor.getState().selectAll(),
  },
  {
    id: 'deselect',
    keys: [['esc']],
    group: 'editing',
    description: 'clear selection',
    match: byKey('Escape'),
    run: () => useEditor.getState().clearSelection(),
  },
  {
    id: 'add-text',
    keys: [['t']],
    group: 'editing',
    description: 'add text at playhead',
    match: byKey('t'),
    run: () => useEditor.getState().addText({ start: usePlayback.getState().time }),
  },
  {
    id: 'add-effect',
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
    id: 'mute',
    keys: [['m']],
    group: 'editing',
    description: 'mute / unmute selected clips',
    match: byKey('m'),
    run: toggleMute,
  },
  {
    id: 'trim-start',
    keys: [['[']],
    group: 'editing',
    description: 'trim clip start to playhead',
    match: (e) => byCode('BracketLeft')(e) && notMapped(e),
    run: () => trimToPlayhead('start'),
  },
  {
    id: 'trim-end',
    keys: [[']']],
    group: 'editing',
    description: 'trim clip end to playhead',
    match: (e) => byCode('BracketRight')(e) && notMapped(e),
    run: () => trimToPlayhead('end'),
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

  // app
  {
    id: 'export',
    keys: [['ctrl', 'e']],
    group: 'app',
    description: 'export',
    match: byKey('e', { mod: true }),
    run: openExport,
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
    id: 'settings',
    keys: [['ctrl', ',']],
    group: 'app',
    description: 'project settings',
    match: byCode('Comma', { mod: true }),
    run: () => useUi.getState().openDialog('settings'),
  },
];

export function findShortcut(e: KeyboardEvent): Shortcut | undefined {
  return SHORTCUTS.find((s) => s.match(e));
}
