/**
 * the keys of the source view: the playback keys and the mark keys go to the media in the source view while it is the
 * active view, to the timeline otherwise (onView). also match frame and the ways media gets onto the timeline from there.
 * the marks of a media are not the project's range: Project.range is never touched here.
 */
import { isExporting } from '../../engine/exportState';
import { lastFrameStart, sameRange } from '../../lib/inOut';
import { clipTypeFor } from '../../lib/factory';
import { goOutTime, marksOf, markMediaIn, markMediaOut, shownStart, wholeMarks } from '../../lib/marks';
import { matchFrameAt, planReverseMatch } from '../../lib/matchFrame';
import type { MatchTarget } from '../../lib/matchFrame';
import type { ClipParts } from '../../types';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { projectFps, sourceAsset, useSource } from '../../store/source';
import { useUi } from '../../store/ui';
import { REASON_TEXT } from '../shell/reasons';
import { insertMedia } from '../timeline/insertMedia';
import type { InsertMediaOpts } from '../timeline/insertMedia';

export type ViewKey = 'play-pause' | 'shuttle-back' | 'pause' | 'shuttle-forward' | 'frame-back' | 'frame-forward' | 'frames-back'
  | 'frames-forward' | 'seek-start' | 'seek-end' | 'mark-in' | 'mark-out' | 'mark-clip' | 'clear-in-out' | 'go-in' | 'go-out' | 'play-in-out';

/** held keys: with no media these do nothing and say nothing */
const QUIET_KEYS: ReadonlySet<ViewKey> = new Set<ViewKey>(['frame-back', 'frame-forward', 'frames-back', 'frames-forward', 'seek-start', 'seek-end']);
const PLAYBACK_KEYS: ReadonlySet<ViewKey> = new Set<ViewKey>([...QUIET_KEYS, 'play-pause', 'shuttle-back', 'pause', 'shuttle-forward']);

const toast = (message: string): void => useUi.getState().toast(message);

/** the source view is the active view: its keys. else the timeline's */
export function onView(key: ViewKey, timeline: () => void): void {
  if (useUi.getState().previewMode === 'source') runSourceKey(key);
  else timeline();
}

export function runSourceKey(key: ViewKey): void {
  const T = REASON_TEXT;
  const a = sourceAsset();
  if (!a) {
    if (!QUIET_KEYS.has(key)) toast(T.sourceEmpty);
    return;
  }
  if (a.kind === 'image') {
    if (!PLAYBACK_KEYS.has(key)) toast(T.sourcePicture);
    return;
  }
  const src = useSource.getState();
  const fps = projectFps();
  switch (key) {
    case 'play-pause':
      src.toggle();
      return;
    case 'shuttle-back':
      src.shuttle(-1);
      return;
    case 'pause':
      src.pause();
      return;
    case 'shuttle-forward':
      src.shuttle(1);
      return;
    case 'frame-back':
      src.stepFrames(-1);
      return;
    case 'frame-forward':
      src.stepFrames(1);
      return;
    case 'frames-back':
      src.stepFrames(-10);
      return;
    case 'frames-forward':
      src.stepFrames(10);
      return;
    case 'seek-start':
      src.seek(0);
      return;
    case 'seek-end':
      src.seek(lastFrameStart(0, a.duration, fps));
      return;
    case 'mark-in': {
      const r = markMediaIn(marksOf(a), shownStart(src.time, src.playing, fps), fps);
      useEditor.getState().setMediaMarks(a.id, r.range);
      if (r.dropped) toast('in point set, the out point before it was cleared');
      return;
    }
    case 'mark-out': {
      const r = markMediaOut(marksOf(a), shownStart(src.time, src.playing, fps), fps, a.duration);
      useEditor.getState().setMediaMarks(a.id, r.range);
      if (r.dropped) toast('out point set, the in point after it was cleared');
      return;
    }
    case 'mark-clip':
      useEditor.getState().setMediaMarks(a.id, wholeMarks(a.duration));
      return;
    case 'clear-in-out':
      if (!marksOf(a)) toast(T.noInOut);
      else useEditor.getState().setMediaMarks(a.id, null);
      return;
    case 'go-in': {
      const m = marksOf(a);
      if (m?.in === undefined) toast(T.noInPoint);
      else src.seek(m.in);
      return;
    }
    case 'go-out': {
      const m = marksOf(a);
      if (m?.out === undefined) toast(T.noOutPoint);
      else src.seek(goOutTime(m, a.duration, fps));
      return;
    }
    case 'play-in-out':
      if (!src.playInToOut()) toast(isExporting() ? T.sourceExport : T.noInOut);
      return;
  }
}

/** f: in the source view the timeline moment of this frame, else the media moment of the clip under the playhead */
export function runMatchFrame(): void {
  const T = REASON_TEXT;
  const ed = useEditor.getState();
  const p = ed.project;
  const time = usePlayback.getState().time;
  if (useUi.getState().previewMode === 'source') {
    const a = sourceAsset();
    if (!a || !p) return toast(T.sourceEmpty);
    const r = planReverseMatch(p, a.id, useSource.getState().time, time, ed.selection);
    if (!r) return toast(T.notOnTimeline);
    useSource.getState().pause();
    usePlayback.getState().seek(r.time);
    useUi.getState().activateProgram();
    return;
  }
  const m = p ? matchFrameAt(p, time, ed.selection) : null;
  if (!m) return toast(T.noMediaUnder);
  applyMatch(m);
}

/** open the media at the moment, with the clip's part of it marked. replaced: it had other marks that were overwritten */
export function applyMatch(m: MatchTarget): { replaced: boolean } {
  usePlayback.getState().pause();
  let replaced = false;
  if (m.marks) {
    // the asset of the target may be older than the store's: read the marks that are there now
    const had = marksOf(useEditor.getState().project?.assets.find((a) => a.id === m.asset.id) ?? m.asset);
    useEditor.getState().setMediaMarks(m.asset.id, m.marks);
    replaced = had !== null && !sameRange(had, m.marks);
    if (replaced) toast("the media's in and out now match the clip");
  }
  useSource.getState().open(m.asset.id, m.time);
  useUi.getState().activateSource();
  return { replaced };
}

export function toggleSource(): void {
  const ui = useUi.getState();
  if (ui.previewMode === 'source') ui.activateProgram();
  else ui.activateSource();
}

export function openInSource(assetId: string, time?: number): void {
  useSource.getState().open(assetId, time);
  useUi.getState().activateSource();
}

/** close the source: back to the timeline side when the source was the active view */
export function emptySource(): void {
  const was = useUi.getState().previewMode === 'source';
  useSource.getState().close();
  if (was) useUi.getState().activateProgram();
}

/** media onto the timeline, the marked part of it when it has marks. null when it could not */
export function addMedia(assetId: string, o?: { start?: number; trackId?: string; parts?: ClipParts; skipHistory?: boolean }): string | null {
  const a = useEditor.getState().project?.assets.find((x) => x.id === assetId);
  if (!a) return null;
  const parts = o?.parts ?? 'both';
  if (clipTypeFor(a, parts) === null) {
    toast(parts === 'sound' ? REASON_TEXT.noSound : REASON_TEXT.noPicture);
    return null;
  }
  const opts: InsertMediaOpts = {};
  if (o?.start !== undefined) opts.start = o.start;
  if (o?.trackId !== undefined) opts.trackId = o.trackId;
  if (o?.skipHistory !== undefined) opts.skipHistory = o.skipHistory;
  const range = marksOf(a);
  if (range !== null) opts.range = range;
  if (parts !== 'both') opts.parts = parts;
  return insertMedia(assetId, opts);
}

/** the source's media onto the timeline at the playhead */
export function sourceAdd(): void {
  const a = sourceAsset();
  if (!a) return toast(REASON_TEXT.sourceEmpty);
  addMedia(a.id, { start: usePlayback.getState().time });
}

export function sourceAddPart(parts: 'picture' | 'sound'): void {
  const a = sourceAsset();
  if (!a) return toast(REASON_TEXT.sourceEmpty);
  addMedia(a.id, { start: usePlayback.getState().time, parts });
}
