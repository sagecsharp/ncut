import { PIVOT_SPOTS } from '../../engine/pivot';
import { EASINGS } from '../../lib/anim';
import { parentOf } from '../../lib/links';
import type { TimeDisplay } from '../../lib/time';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { closeProject, exportProjectFile } from '../../store/session';
import { soloSelectedTracks, useSolo } from '../../store/solo';
import { useTimeDisplay } from '../../store/timeDisplay';
import { useUi } from '../../store/ui';
import type { ExportAskInput } from '../../store/ui';
import { isVisualClip } from '../../types';
import { LAYOUT_RESET_EVENT } from '../editor/layoutReset';
import { useGuides } from '../preview/guides';
import { useCameraInset } from '../preview/insetState';
import { usePivotMode } from '../preview/pivotMode';
import { usePreviewQuality } from '../preview/quality';
import type { PreviewQuality } from '../preview/quality';
import { useSceneGrid, useSceneTool } from '../preview/sceneTool';
import { useScopes } from '../preview/scopesState';
import type { ScopeKind } from '../preview/scopesState';
import { emptySource, sourceAdd } from '../preview/sourceKeys';
import { useSourcePrefs } from '../preview/sourcePrefs';
import type { SceneTool } from '../preview/sceneGizmo';
import { attachClips } from '../properties/attachActions';
import { bendLeader, bendTogether, flattenBends } from '../properties/bendActions';
import { addGradeEffect, copyGradeOf, pasteGradeOn, resetGrades, showGrade, toggleGradeOn } from '../properties/gradeActions';
import { importLutFor, lutOffOn, saveGradeCube } from '../properties/lutActions';
import { matteAbove, removeMattes, selectMatteOther, showMatte } from '../properties/matteActions';
import { pivotModeBlocker, setPivotMany } from '../properties/pivotActions';
import { clearKeysOf, closeGapsOnTrack, insertGapAt, selectEffectsOf, selectLike } from '../timeline/actions';
import { clipHasSound, markBeats } from '../timeline/beatActions';
import { timelineCommands } from '../timeline/commands';
import { crossfadeTracksNow, fadeShapeNow } from '../timeline/crossfadeActions';
import { fitGraphAll, fitGraphSelected, joinHandlesNow, showGraph, toggleAutoFit } from '../timeline/graphActions';
import { copyKeysNow, deleteKeysNow, nudgeKeysBy, pasteKeysNow, selectAllKeysNow, setKeysEaseNow } from '../timeline/keyLaneActions';
import { editNow, targetSelectedNow, targetsAutoNow } from '../timeline/editActions';
import { clearIn, clearOut, markSelection } from '../timeline/rangeActions';
import { cutAtMarkers, fitToMarkers, makeRow } from '../timeline/sequenceActions';
import { joinSoundNow, selectSideNow, syncSoundNow } from '../timeline/soundActions';
import { slideBy, slipBy } from '../timeline/trimActions';
import { moveSelectedTrack, normalTrackHeights, toggleSelectedSyncLock } from '../timeline/trackActions';
import type { FitSpan } from '../timeline/sequenceActions';
import { interaction } from '../timeline/view';
import { REASON_IDS, reasonFor } from './reasons';
import type { ReasonInput } from './reasons';
import { openExport, SHORTCUTS } from './shortcuts';

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

/** a row that opens the export dialog at a part of it or with a preset */
const exportRow = (id: string, title: string, ask: ExportAskInput, also: readonly string[]): PaletteAction => ({ id, title, group: 'app', keys: [], also, run: () => openExport(ask) });

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

const scopeAction = (kind: ScopeKind, title: string, also: string[]): PaletteAction => ({
  id: `scopes-${kind}`,
  title,
  group: 'preview',
  keys: [],
  also,
  run: () => useScopes.getState().showKind(kind),
});

const displayAction = (mode: TimeDisplay, title: string, also: readonly string[]): PaletteAction => ({
  id: `time-display-${mode}`, title, group: 'timeline', keys: [], also,
  why: () => (useTimeDisplay.getState().mode === mode ? `times already show as ${mode}` : null),
  run: () => { useTimeDisplay.getState().setMode(mode); toast(`times show as ${mode}`); },
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
  // the keyframe panel
  { id: 'keys-delete', title: 'delete the selected keyframes', group: 'animation', keys: [], also: ['remove keyframes', 'delete keys'], run: guarded(deleteKeysNow) },
  { id: 'keys-copy', title: 'copy the selected keyframes', group: 'animation', keys: [], also: ['copy keys'], run: guarded(copyKeysNow) },
  { id: 'keys-paste', title: 'paste keyframes at the playhead onto the selected clips', group: 'animation', keys: [], also: ['paste keys'], run: guarded(pasteKeysNow) },
  { id: 'keys-select-all', title: 'select every keyframe of the selected clips', group: 'animation', keys: [], also: ['select all keys'], run: guarded(selectAllKeysNow) },
  { id: 'keys-nudge-left', title: 'move the selected keyframes 1 frame left', group: 'animation', keys: [], run: guarded(() => nudgeKeysBy(-1)) },
  { id: 'keys-nudge-right', title: 'move the selected keyframes 1 frame right', group: 'animation', keys: [], run: guarded(() => nudgeKeysBy(1)) },
  ...EASINGS.map(
    (e): PaletteAction => ({
      id: `keys-ease-${e.id}`,
      title: `ease of the selected keyframes: ${e.label}`,
      group: 'animation',
      keys: [],
      also: ['keyframe interpolation', 'easing'],
      run: guarded(() => setKeysEaseNow(e.id)),
    }),
  ),
  // the graph
  { id: 'keys-ease-bezier', title: 'ease of the selected keyframes: custom', group: 'animation', keys: [], also: ['bezier', 'custom ease', 'keyframe handles'], run: guarded(() => setKeysEaseNow('bezier')) },
  { id: 'keys-join-handles', title: 'join the handles of the selected keyframes', group: 'animation', keys: [], also: ['continuous bezier', 'unify handles'], run: guarded(joinHandlesNow) },
  { id: 'graph-value', title: 'show the value graph', group: 'animation', keys: [], also: ['value graph', 'graph editor'], run: guarded(() => showGraph('value')) },
  { id: 'graph-speed', title: 'show the speed graph', group: 'animation', keys: [], also: ['speed graph', 'velocity graph'], run: guarded(() => showGraph('speed')) },
  { id: 'graph-fit-all', title: 'graph: fit every line', group: 'animation', keys: [], also: ['frame all'], run: guarded(fitGraphAll) },
  { id: 'graph-fit-selected', title: 'graph: fit the selected keyframes', group: 'animation', keys: [], also: ['frame selected'], run: guarded(fitGraphSelected) },
  { id: 'graph-auto-fit', title: 'graph: auto fit on or off', group: 'animation', keys: [], also: ['auto zoom graph'], run: guarded(toggleAutoFit) },
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
    title: 'insert a 1 second gap at the playhead (unlocked tracks with sync lock on)',
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
    id: 'tracks-normal',
    title: 'normal track heights: every track back to its normal height',
    group: 'timeline',
    keys: [],
    also: ['reset track height', 'default track height'],
    run: normalTrackHeights,
  },
  {
    id: 'track-up',
    title: 'move the track of the selected clip up (a video track higher up draws on top)',
    group: 'timeline',
    keys: [],
    also: ['reorder tracks', 'track order', 'raise track', 'bring track forward', 'layer order'],
    run: guarded(() => moveSelectedTrack(-1)),
  },
  {
    id: 'track-down',
    title: 'move the track of the selected clip down',
    group: 'timeline',
    keys: [],
    also: ['reorder tracks', 'lower track', 'send track back'],
    run: guarded(() => moveSelectedTrack(1)),
  },
  {
    id: 'sync-lock-toggle',
    title: 'sync lock on or off for the tracks of the selected clips',
    group: 'editing',
    keys: [],
    also: ['sync lock', 'track sync', 'keep in sync', 'ripple other tracks', 'pin track'],
    run: guarded(toggleSelectedSyncLock),
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
  scopeAction('waveform', 'scopes: show the waveform', ['luma waveform', 'waveform monitor', 'exposure']),
  scopeAction('parade', 'scopes: show the rgb parade', ['rgb parade', 'color balance', 'white balance check']),
  scopeAction('vectorscope', 'scopes: show the vectorscope', ['vector scope', 'skin tone line', 'saturation check']),
  scopeAction('histogram', 'scopes: show the histogram', ['levels', 'clipping', 'exposure histogram']),
  {
    id: 'scopes-exact',
    title: 'scopes: exact reading on or off (every pixel, like the export)',
    group: 'preview',
    keys: [],
    also: ['full resolution scopes', 'export quality scopes'],
    run: () => {
      const s = useScopes.getState();
      s.setExact(!s.exact);
      s.setOpen(true);
    },
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
  // export: advanced part and presets
  exportRow('export-transparent', 'export with a see-through background (webm or png)', { focus: 'transparent' }, ['transparent background', 'alpha channel', 'alpha', 'transparency', 'no background', 'cutout']),
  exportRow('export-codec', 'export: pick the video codec (h.264, h.265, av1, vp9)', { focus: 'codec' }, ['hevc', 'avc', 'x264', 'x265', 'encoder', 'vp9', 'av1']),
  exportRow('export-bitrate', 'export: set the bitrate in mbps', { focus: 'bitrate' }, ['data rate', 'mbps', 'vbr', 'file size', 'compression']),
  exportRow('export-interval', 'export: key frame interval', { focus: 'interval' }, ['gop', 'keyframe interval', 'i-frame', 'seek points']),
  exportRow('export-size', 'export at a custom size (width x height)', { focus: 'size' }, ['custom resolution', 'dimensions', 'letterbox', 'crop to fill', 'output size']),
  exportRow('export-audio', 'export: audio codec, bitrate and sample rate', { focus: 'audio' }, ['aac', 'opus', 'kbps', '44.1 khz', '48 khz', 'audio bitrate', 'sample rate']),
  exportRow('export-youtube', 'export for youtube (1080p)', { preset: 'youtube-1080' }, ['upload', 'youtube preset', 'web video', 'full hd']),
  exportRow('export-youtube-4k', 'export for youtube (4k)', { preset: 'youtube-4k' }, ['uhd', '2160p', '4k upload']),
  exportRow('export-vimeo', 'export for vimeo', { preset: 'vimeo' }, ['vimeo preset', 'upload']),
  exportRow('export-reels', 'export vertical for reels, shorts and tiktok', { preset: 'reels' }, ['vertical video', '9:16', 'portrait', 'instagram', 'shorts', 'tiktok']),
  exportRow('export-master', 'export a high bitrate master', { preset: 'master' }, ['mezzanine', 'archive copy', 'intermediate', 'high quality file']),
  exportRow('export-loudness', 'export at a loudness target with a peak limit', { focus: 'loudness' }, ['normalize', 'loudness normalization', 'limiter', 'brickwall', 'peak limit', 'true peak limit', '-14 lufs', 'podcast loudness']),
  // trim modes
  {
    id: 'slip-earlier',
    title: 'slip the selected clip 1 frame earlier in its media',
    group: 'editing',
    keys: [],
    also: ['slip clip selection left', 'slip tool'],
    run: guarded(() => slipBy(-1)),
  },
  {
    id: 'slip-later',
    title: 'slip the selected clip 1 frame later in its media',
    group: 'editing',
    keys: [],
    also: ['slip clip selection right'],
    run: guarded(() => slipBy(1)),
  },
  {
    id: 'slide-left',
    title: 'slide the selected clip 1 frame left',
    group: 'editing',
    keys: [],
    also: ['slide clip selection left', 'slide tool'],
    run: guarded(() => slideBy(-1)),
  },
  {
    id: 'slide-right',
    title: 'slide the selected clip 1 frame right',
    group: 'editing',
    keys: [],
    also: ['slide clip selection right'],
    run: guarded(() => slideBy(1)),
  },
  // source view
  {
    id: 'side-by-side',
    title: 'show the source view and the output side by side',
    group: 'preview',
    keys: [],
    also: ['dual viewer', 'two up', 'source and program', 'two monitors', 'single viewer'],
    run: () => {
      useSourcePrefs.getState().toggleSideBySide();
      toast(useSourcePrefs.getState().sideBySide ? 'side by side on' : 'side by side off');
    },
  },
  {
    id: 'media-skim',
    title: 'skim video cards when the mouse moves over them',
    group: 'preview',
    keys: [],
    also: ['hover scrub', 'skimming', 'scrub thumbnails'],
    run: () => {
      useSourcePrefs.getState().toggleSkim();
      toast(useSourcePrefs.getState().skim ? 'skimming on' : 'skimming off');
    },
  },
  {
    id: 'source-empty',
    title: 'empty the source view',
    group: 'preview',
    keys: [],
    also: ['close source', 'unload source'],
    run: () => emptySource(),
  },
  {
    id: 'source-add',
    title: 'add the media of the source view at the playhead (its marked part)',
    group: 'editing',
    keys: [],
    also: ['insert source', 'add source clip'],
    run: guarded(sourceAdd),
  },
  // in and out
  {
    id: 'mark-selection',
    title: 'mark in and out around the selected clips',
    group: 'inout',
    keys: [],
    also: ['mark selection', 'in and out from the selection'],
    run: guarded(markSelection),
  },
  { id: 'clear-in', title: 'clear the in point', group: 'inout', keys: [], also: ['remove the in point'], run: guarded(clearIn) },
  { id: 'clear-out', title: 'clear the out point', group: 'inout', keys: [], also: ['remove the out point'], run: guarded(clearOut) },
  // split sound
  {
    id: 'join-sound',
    title: 'join sound back (the sound clip goes, the picture plays its own sound again)',
    group: 'editing',
    keys: [],
    also: ['link audio', 'relink', 'merge audio', 'reattach audio'],
    run: guarded(() => joinSoundNow(selection())),
  },
  {
    id: 'move-into-sync',
    title: 'move the selected clips into sync with their picture or sound',
    group: 'editing',
    keys: [],
    also: ['resync', 'fix sync', 'out of sync', 'sync audio'],
    run: guarded(() => syncSoundNow(selection(), 'move')),
  },
  {
    id: 'slip-into-sync',
    title: 'slip the selected clips into sync (they stay, their media slides)',
    group: 'editing',
    keys: [],
    also: ['resync', 'fix sync', 'out of sync'],
    run: guarded(() => syncSoundNow(selection(), 'slip')),
  },
  {
    id: 'select-sound',
    title: 'select only the sound of the selected clips',
    group: 'editing',
    keys: [],
    also: ['audio only', 'j cut', 'l cut', 'split edit'],
    run: guarded(() => selectSideNow(selection(), 'sound')),
  },
  {
    id: 'select-picture',
    title: 'select only the picture of the selected clips',
    group: 'editing',
    keys: [],
    also: ['video only'],
    run: guarded(() => selectSideNow(selection(), 'picture')),
  },
  // mixer
  {
    id: 'solo-selection',
    title: 'solo the tracks of the selected clips (again: hear every track)',
    group: 'playback',
    keys: [],
    also: ['solo', 'listen alone', 'isolate track'],
    run: () => soloSelectedTracks(),
  },
  {
    id: 'solo-off',
    title: 'solo off: hear every track',
    group: 'playback',
    keys: [],
    also: ['unsolo', 'clear solo'],
    run: () => useSolo.getState().clearSolo(),
  },
  {
    id: 'mixer-reset',
    title: 'reset the mixer: every fader to 0 db, every pan to the middle',
    group: 'editing',
    keys: [],
    also: ['reset faders', 'reset levels', 'unity gain'],
    run: guarded(() => useEditor.getState().resetMixer()),
  },
  {
    id: 'measure-loudness',
    title: 'measure the loudness of the mix (lufs, range, true peak)',
    group: 'app',
    keys: [],
    also: ['lufs', 'loudness meter', 'ebu r128', 'true peak', 'loudness range', 'lra', 'measure mix'],
    run: () => {
      useUi.getState().showMixer();
      void import('../export/measureMix').then((m) => m.measureMixNow());
    },
  },
  // time display
  displayAction('timecode', 'show times as timecode (hours:minutes:seconds:frames)', ['time display', 'timecode display', 'display format', 'time format', 'show timecode']),
  displayAction('frames', 'show times as frames', ['frame count', 'frame numbers', 'show frames', 'display frames']),
  displayAction('seconds', 'show times as seconds', ['show seconds', 'display seconds', 'time in seconds']),
  // grade
  {
    id: 'grade-show',
    title: 'show the grade of the selected clip',
    group: 'editing',
    keys: [],
    also: ['color grading', 'color wheels', 'lift gamma gain', 'curves', 'primaries', 'lumetri color'],
    run: guarded(() => showGrade(selection())),
  },
  {
    id: 'grade-on-off',
    title: 'turn the grade of the selected clips off or on',
    group: 'editing',
    keys: [],
    also: ['bypass', 'before and after', 'compare grade', 'disable grade'],
    run: guarded(() => {
      const t = toggleGradeOn(selection());
      if (t) toast(t);
    }),
  },
  {
    id: 'grade-reset',
    title: 'reset the grade of the selected clips',
    group: 'editing',
    keys: [],
    also: ['clear grade', 'remove grade', 'reset color wheels', 'reset curves'],
    run: guarded(() => {
      const t = resetGrades(selection());
      if (t) toast(t);
    }),
  },
  {
    id: 'grade-copy',
    title: 'copy the grade of the selected clip',
    group: 'editing',
    keys: [],
    also: ['copy color', 'match shots'],
    run: guarded(() => {
      const t = copyGradeOf(selection());
      if (t) toast(t);
    }),
  },
  {
    id: 'grade-paste',
    title: 'paste the grade on the selected clips',
    group: 'editing',
    keys: [],
    also: ['apply grade', 'paste color', 'match shots'],
    run: guarded(() => {
      const t = pasteGradeOn(selection());
      if (t) toast(t);
    }),
  },
  {
    id: 'grade-add',
    title: 'add a grade effect over everything below',
    group: 'editing',
    keys: [],
    also: ['adjustment layer', 'color correction layer', 'grading layer'],
    run: guarded(() => addGradeEffect()),
  },
  // three point edits
  {
    id: 'replace-edit',
    title: 'replace edit: the clip under the playhead shows the source media, frame matched',
    group: 'editing',
    keys: [],
    also: ['replace', 'replace edit', 'replace with source', 'swap shot', 'match frame replace'],
    run: guarded(() => editNow('replace')),
  },
  {
    id: 'fit-edit',
    title: 'fit to the range: the marked part fills in to out at another speed',
    group: 'editing',
    keys: [],
    also: ['fit to fill', 'fit edit', 'fit to range', 'speed to fill'],
    run: guarded(() => editNow('fit')),
  },
  {
    id: 'append-edit',
    title: 'append: the marked part after the last clip of the target tracks',
    group: 'editing',
    keys: [],
    also: ['append', 'append to end', 'append at end', 'add to end'],
    run: guarded(() => editNow('append')),
  },
  {
    id: 'edit-targets-auto',
    title: 'edit targets back to auto (the lowest video track, the top audio track)',
    group: 'editing',
    keys: [],
    also: ['reset targets', 'auto track targeting', 'source patching', 'patch tracks'],
    run: targetsAutoNow,
  },
  {
    id: 'edit-targets-selected',
    title: 'target the tracks of the selected clips',
    group: 'editing',
    keys: [],
    also: ['target selected tracks', 'patch to selection', 'destination track'],
    run: targetSelectedNow,
  },
  // lut
  {
    id: 'lut-import',
    title: 'import a lut (.cube) and put it on the selected clips',
    group: 'editing',
    keys: [],
    also: ['lut', 'look up table', 'load lut', 'cube file', 'creative lut', 'technical lut', 'camera lut', 'input lut', 'log to rec 709', 'lumetri input lut', 'film look'],
    run: guarded(() => void importLutFor(selection()).then((t) => t && toast(t))),
  },
  {
    id: 'lut-off',
    title: 'take the lut off the selected clips',
    group: 'editing',
    keys: [],
    also: ['remove lut', 'clear lut', 'no lut', 'lut off'],
    run: guarded(() => {
      const t = lutOffOn(selection());
      if (t) toast(t);
    }),
  },
  {
    id: 'lut-save',
    title: 'save the color and grade of the selected clip as a .cube lut',
    group: 'editing',
    keys: [],
    also: ['save grade as .cube', 'export lut', 'generate lut', 'bake grade', 'save lut', 'make lut', 'export look'],
    run: guarded(() => void saveGradeCube(selection()).then((t) => t && toast(t))),
  },
  // crossfades
  { id: 'crossfade-track', title: 'crossfade every edit on the tracks of the selected clips', group: 'editing', keys: [], run: guarded(() => crossfadeTracksNow(null, 'add')) },
  { id: 'crossfade-track-off', title: 'remove every crossfade on the tracks of the selected clips', group: 'editing', keys: [], run: guarded(() => crossfadeTracksNow(null, 'remove')) },
  { id: 'fade-shape-power', title: 'fade shape of the selected clips: equal power', group: 'editing', keys: [], run: guarded(() => fadeShapeNow(null, 'power')) },
  { id: 'fade-shape-linear', title: 'fade shape of the selected clips: linear', group: 'editing', keys: [], run: guarded(() => fadeShapeNow(null, 'linear')) },
  { id: 'fade-shape-smooth', title: 'fade shape of the selected clips: smooth', group: 'editing', keys: [], run: guarded(() => fadeShapeNow(null, 'smooth')) },
  // mattes
  {
    id: 'matte-show',
    title: 'show the matte of the selected clip',
    group: 'editing',
    keys: [],
    also: ['track matte', 'alpha matte', 'luma matte', 'stencil'],
    run: guarded(() => showMatte(selection())),
  },
  {
    id: 'matte-above',
    title: 'use the clip above as the matte of the selected clip',
    group: 'editing',
    keys: [],
    also: ['set matte', 'track matte', 'clipping mask', 'video inside text'],
    run: guarded(() => toast(matteAbove(selection()))),
  },
  {
    id: 'matte-remove',
    title: 'take the matte off the selected clips',
    group: 'editing',
    keys: [],
    also: ['remove matte', 'release clipping mask', 'remove track matte'],
    run: guarded(() => toast(removeMattes(selection()))),
  },
  {
    id: 'matte-select',
    title: 'select the matte clip of the selected clip, or the clips it is the matte of',
    group: 'editing',
    keys: [],
    also: ['select matte', 'go to matte', 'find matte'],
    run: guarded(() => {
      const t = selectMatteOther(selection());
      if (t) toast(t);
    }),
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
