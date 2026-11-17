import { PIVOT_SPOTS } from '../../engine/pivot';
import { parentOf } from '../../lib/links';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { closeProject, exportProjectFile } from '../../store/session';
import { useUi } from '../../store/ui';
import { isVisualClip } from '../../types';
import { LAYOUT_RESET_EVENT } from '../editor/layoutReset';
import { useGuides } from '../preview/guides';
import { useCameraInset } from '../preview/insetState';
import { usePivotMode } from '../preview/pivotMode';
import { usePreviewQuality } from '../preview/quality';
import type { PreviewQuality } from '../preview/quality';
import { useSceneGrid, useSceneTool } from '../preview/sceneTool';
import type { SceneTool } from '../preview/sceneGizmo';
import { attachClips } from '../properties/attachActions';
import { bendLeader, bendTogether, flattenBends } from '../properties/bendActions';
import { pivotModeBlocker, setPivotMany } from '../properties/pivotActions';
import { clearKeysOf, closeGapsOnTrack, insertGapAt, selectEffectsOf, selectLike } from '../timeline/actions';
import { clipHasSound, markBeats } from '../timeline/beatActions';
import { timelineCommands } from '../timeline/commands';
import { cutAtMarkers, fitToMarkers, makeRow } from '../timeline/sequenceActions';
import type { FitSpan } from '../timeline/sequenceActions';
import { interaction } from '../timeline/view';
import { REASON_IDS, reasonFor } from './reasons';
import type { ReasonInput } from './reasons';
import { SHORTCUTS } from './shortcuts';

export interface PaletteAction {
  id: string;
  title: string;
  group: string;
  /** key caps, same shape as Shortcut.keys */
  keys: readonly (readonly string[])[];
  /** old or other words that find the row one tier later than its title */
  also?: readonly string[];
  /** why it would do nothing now, from one snapshot taken when the palette opens */
  why?: (s: ReasonInput) => string | null;
  run(): void;
}

async function saveProjectFile(): Promise<void> {
  const project = useEditor.getState().project;
  if (!project) return;
  const file = await exportProjectFile(project.id);
  if (!file) {
    useUi.getState().toast('could not save the project file', 'error');
    return;
  }
  const url = URL.createObjectURL(file.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/** an edit that is ignored in the middle of a pointer drag */
const guarded = (run: () => void) => (): void => {
  if (interaction.gestureActive) return;
  run();
};

const toast = (message: string): void => useUi.getState().toast(message);
const selection = (): string[] => useEditor.getState().selection;

/** a sequence command on the selected clips, ignored in the middle of a drag */
function sequenceAction(id: string, title: string, run: (ids: string[]) => void, also?: readonly string[]): PaletteAction {
  return {
    id,
    title,
    group: 'timeline',
    keys: [],
    also,
    run: guarded(() => run(selection())),
  };
}

const fitAction = (span: FitSpan, title: string) => sequenceAction(`fit-markers-${span}`, title, (ids) => fitToMarkers(ids, span));

/** a row that opens one section of the project panel */
const showSection = (id: string, title: string, also?: readonly string[]): PaletteAction => ({
  id: `show-${id}`,
  title,
  group: 'app',
  keys: [],
  also,
  run: () => {
    useUi.getState().showProjectPanel(true);
    useUi.getState().revealSection(id);
  },
});

const qualityAction = (q: PreviewQuality, title: string): PaletteAction => ({
  id: `quality-${q}`,
  title,
  group: 'preview',
  keys: [],
  run: () => usePreviewQuality.getState().setQuality(q),
});

const toolAction = (tool: SceneTool, title: string): PaletteAction => ({
  id: `tool-${tool}`,
  title,
  group: 'preview',
  keys: [],
  run: () => {
    useSceneTool.getState().setTool(tool);
    useUi.getState().setPreviewMode('scene');
  },
});

/** actions without a key: reachable through the stores like the header buttons do */
const EXTRA: readonly PaletteAction[] = [
  { id: 'back-to-projects', title: 'back to projects', group: 'app', keys: [], run: () => void closeProject() },
  { id: 'save-file', title: 'save project file', group: 'app', keys: [], run: () => void saveProjectFile() },
  {
    id: 'toggle-loop',
    title: 'toggle loop',
    group: 'playback',
    keys: [],
    run: () => {
      const pb = usePlayback.getState();
      pb.setLoop(!pb.loop);
      useUi.getState().toast(pb.loop ? 'loop off' : 'loop on');
    },
  },
  { id: 'speed-half', title: 'preview speed 0.5x', group: 'playback', keys: [], run: () => usePlayback.getState().setSpeed(0.5) },
  { id: 'speed-one', title: 'preview speed 1x', group: 'playback', keys: [], run: () => usePlayback.getState().setSpeed(1) },
  { id: 'select-like', title: 'select every clip like the selected one (all texts, all of this effect ...)', group: 'editing', keys: [], run: () => selectLike() },
  sequenceAction('clips-in-a-row', 'put the selected clips in a row', makeRow),
  fitAction(1, 'fit the selected clips to the markers (every beat)'),
  fitAction(2, 'fit the selected clips to the markers (every 2nd)'),
  fitAction(4, 'fit the selected clips to the markers (every 4th)'),
  sequenceAction('cut-at-markers', 'split the selected clips at the markers', cutAtMarkers, ['cut at the markers']),
  { id: 'speed-double', title: 'preview speed 2x', group: 'playback', keys: [], run: () => usePlayback.getState().setSpeed(2) },
  // the tools rows: things that only lived in a right click menu, a header widget or a store
  { id: 'zoom-selection', title: 'zoom the timeline to the selected clips', group: 'timeline', keys: [], run: () => timelineCommands.fitSelection?.() },
  {
    id: 'split-all',
    title: 'split every track at the playhead',
    group: 'editing',
    keys: [],
    run: guarded(() => {
      const st = useEditor.getState();
      st.splitClips(usePlayback.getState().time, st.project?.clips.map((c) => c.id) ?? []);
    }),
  },
  {
    id: 'clear-keys',
    title: 'clear the keyframes of the selected clips',
    group: 'animation',
    keys: [],
    run: guarded(() => clearKeysOf(selection())),
  },
  {
    id: 'detach',
    title: 'detach the selected clips (they stay where they are)',
    group: 'editing',
    keys: [],
    run: guarded(() => {
      const p = useEditor.getState().project;
      if (!p) return;
      const ids = p.clips.filter((c) => selection().includes(c.id) && isVisualClip(c) && parentOf(p, c)).map((c) => c.id);
      if (ids.length > 0) attachClips(ids, null);
    }),
  },
  { id: 'select-effects', title: 'select the effects on the selected clips', group: 'editing', keys: [], run: () => selectEffectsOf(selection()) },
  {
    id: 'insert-gap',
    title: 'insert a 1 second gap at the playhead (all unlocked tracks)',
    group: 'timeline',
    keys: [],
    run: guarded(() => insertGapAt()),
  },
  {
    id: 'close-gaps',
    title: 'close the gaps on the track of the selected clip',
    group: 'timeline',
    keys: [],
    run: guarded(() => {
      const p = useEditor.getState().project;
      const first = p?.clips.find((c) => selection().includes(c.id));
      if (first) closeGapsOnTrack(first.trackId);
    }),
  },
  {
    id: 'marker-delete',
    title: 'delete the marker at the playhead',
    group: 'markers',
    keys: [],
    run: guarded(() => {
      const st = useEditor.getState();
      const p = st.project;
      if (!p) return;
      const time = usePlayback.getState().time;
      const m = (p.markers ?? []).find((x) => Math.abs(x.time - time) <= 0.5 / p.fps);
      if (m) st.removeMarker(m.id);
    }),
  },
  {
    id: 'mark-beats',
    title: 'put a marker on every beat of the selected clip',
    group: 'markers',
    keys: [],
    run: () => {
      const p = useEditor.getState().project;
      const clip = p?.clips.find((c) => selection().includes(c.id) && clipHasSound(p, c));
      if (clip) void markBeats(clip.id, 1);
    },
  },
  showSection('sky', 'show the sky settings', ['skybox']),
  showSection('fog', 'show the fog settings'),
  showSection('light', 'show the light settings'),
  { id: 'project-panel', title: 'show the project panel (canvas, sky, fog, light)', group: 'app', keys: [], run: () => useUi.getState().showProjectPanel(true) },
  { id: 'guides', title: 'show or hide the guides', group: 'preview', keys: [], run: () => useGuides.getState().toggle() },
  { id: 'floor-grid', title: 'show or hide the floor grid (scene view)', group: 'preview', keys: [], run: () => useSceneGrid.getState().toggle() },
  {
    id: 'output-inset',
    title: 'show or hide the output inset (scene view)',
    group: 'preview',
    keys: [],
    also: ['camera view'],
    run: () => useCameraInset.getState().toggle(),
  },
  qualityAction('full', 'preview quality: full'),
  qualityAction('half', 'preview quality: half (faster)'),
  qualityAction('quarter', 'preview quality: quarter (fastest)'),
  toolAction('move', 'scene tool: move'),
  toolAction('rotate', 'scene tool: rotate'),
  toolAction('scale', 'scene tool: scale'),
  { id: 'speed-quarter', title: 'preview speed 0.25x', group: 'playback', keys: [], run: () => usePlayback.getState().setSpeed(0.25) },
  { id: 'speed-one-half', title: 'preview speed 1.5x', group: 'playback', keys: [], run: () => usePlayback.getState().setSpeed(1.5) },
  {
    id: 'reset-layout',
    title: 'reset the panel layout (default sizes)',
    group: 'app',
    keys: [],
    run: () => void window.dispatchEvent(new Event(LAYOUT_RESET_EVENT)),
  },
  // bend and pivot, last on purpose. no `why`: reasons.ts does not know them, the rows toast their own messages
  {
    id: 'bend-together',
    title: 'bend the selected clips together',
    group: 'editing',
    keys: [],
    also: ['curve', 'warp', 'wrap', 'roll', 'curved wall'],
    run: guarded(() => {
      const st = useEditor.getState();
      const time = usePlayback.getState().time;
      const lead = bendLeader(st.project, st.selection);
      // a keyed leader only gets fitted (no new key at the playhead), else its angle, or a quarter turn
      const keyed = (lead?.keyframes?.['bend.angle']?.length ?? 0) > 0;
      const now = lead?.bend?.angle ?? 0;
      const done = bendTogether(st.selection, keyed ? { fit: true } : { angle: now !== 0 ? now : 90, fit: true }, time, {});
      if (!done) toast('select two or more clips that can bend first');
      else toast(`bent ${done.bent.length} clips together`);
    }),
  },
  {
    id: 'bend-flat',
    title: 'take the bend off the selected clips',
    group: 'editing',
    keys: [],
    also: ['flatten', 'unbend', 'curve', 'warp'],
    run: guarded(() => {
      const n = flattenBends(selection(), {});
      toast(n === 0 ? 'none of the selected clips is bent' : n === 1 ? 'took the bend off 1 clip' : `took the bend off ${n} clips`);
    }),
  },
  {
    id: 'move-pivot',
    title: 'move the pivot of the selected clip on the preview',
    group: 'editing',
    keys: [],
    also: ['anchor point', 'origin', 'joint', 'hinge', 'rig'],
    run: guarded(() => {
      const st = useEditor.getState();
      const blocker = pivotModeBlocker(st.project, st.selection);
      if (blocker) toast(blocker);
      else usePivotMode.getState().set(true);
    }),
  },
  {
    id: 'pivot-middle',
    title: 'pivot of the selected clips back to the middle (they stay where they are)',
    group: 'editing',
    keys: [],
    also: ['anchor point', 'origin', 'center pivot', 'reset pivot'],
    run: guarded(() => {
      const st = useEditor.getState();
      const sel = st.selection;
      if (!st.project?.clips.some((c) => sel.includes(c.id) && isVisualClip(c))) {
        toast('select a picture clip first');
        return;
      }
      const before = useUi.getState().toasts;
      const n = setPivotMany(sel, PIVOT_SPOTS[4]);
      // setPivotMany toasts by itself when clips were left out
      if (n === 0 && useUi.getState().toasts === before) toast('the pivot is already in the middle');
    }),
  },
];

const whyOf = (id: string) => (s: ReasonInput) => reasonFor(id, s);
const withWhy = (a: PaletteAction): PaletteAction => (a.why || !REASON_IDS.has(a.id) ? a : { ...a, why: whyOf(a.id) });

/** every runnable shortcut row (same run() as the keyboard) followed by the extras */
export function paletteActions(): PaletteAction[] {
  const rows: PaletteAction[] = SHORTCUTS.filter((s) => !s.info && s.id !== 'palette').map((s) => ({
    id: s.id,
    title: s.description,
    group: s.group,
    keys: s.keys,
    also: s.also,
    why: REASON_IDS.has(s.id) ? whyOf(s.id) : undefined,
    // same guard as the keyboard: no edits in the middle of a drag
    run: () => {
      if (s.mutates && interaction.gestureActive) return;
      s.run();
    },
  }));
  return [...rows, ...EXTRA.map(withWhy)];
}
