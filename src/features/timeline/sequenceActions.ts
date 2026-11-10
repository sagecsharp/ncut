/**
 * the sequence tools on the store: "in a row", "fit to the markers", "cut at the markers".
 * every action is one undo step. the planning lives in sequence.ts.
 */
import { MIN_CLIP_DURATION, trackKindForClip } from '../../types';
import type { Clip, Project } from '../../types';
import { clipEnd, maxClipDuration } from '../../lib/timelineOps';
import { useEditor } from '../../store/editorStore';
import type { ClipMove } from '../../store/editorStore';
import { useUi } from '../../store/ui';
import { applyFollowerSpans } from './followApply';
import { withFollowerMoves } from './followMoves';
import { markersInside, orderForRow, planFit, planRow } from './sequence';
import type { SeqClip, SeqPlace } from './sequence';

/** how many markers each clip spans: every beat, every 2nd, every 4th */
export type FitSpan = 1 | 2 | 4;

const EPS = 1e-6;

/** effect and camera clips are not part of a sequence */
export function isSequenceable(c: Clip): boolean {
  return c.type !== 'effect' && c.type !== 'camera';
}

/** the selected clips a sequence can be made of */
export function sequenceableIds(project: Project | null | undefined, ids: readonly string[]): string[] {
  if (!project) return [];
  return project.clips.filter((c) => ids.includes(c.id) && isSequenceable(c)).map((c) => c.id);
}

/** the marker times of the project, sorted */
function markerList(project: Project): number[] {
  return (project.markers ?? []).map((m) => m.time).sort((a, b) => a - b);
}

/** true when a marker lies inside this clip (a frame away from its edges) */
export function markerInsideClip(project: Project | null | undefined, clip: Clip): boolean {
  if (!project?.markers?.length) return false;
  return markersInside(markerList(project), clip.start, clipEnd(clip), cutMargin(project)).length > 0;
}

/** a marker closer than this to a clip edge is not a cut */
function cutMargin(project: Project): number {
  return Math.max(MIN_CLIP_DURATION, 1 / (project.fps || 30));
}

interface Prepared {
  /** in row order */
  clips: Clip[];
  seq: SeqClip[];
  leftOut: number;
}

/** pick, check and order the clips for a sequence. null (with a toast) when it cannot be done. */
function prepare(project: Project, ids: readonly string[]): Prepared | null {
  const toast = useUi.getState().toast;
  const picked = project.clips.filter((c) => ids.includes(c.id) && isSequenceable(c));
  const layer = new Map(project.tracks.map((t, i) => [t.id, i]));
  const open = picked.filter((c) => !project.tracks.find((t) => t.id === c.trackId)?.locked);
  const leftOut = picked.length - open.length;
  if (open.length < 2) {
    toast(leftOut > 0 ? 'those clips are on locked tracks' : 'select 2 or more clips');
    return null;
  }
  const kinds = new Set(open.map((c) => trackKindForClip(c.type)));
  if (kinds.size > 1) {
    toast('pick pictures or audio, not both');
    return null;
  }
  const ordered = orderForRow(open.map((c) => ({ c, start: c.start, layer: layer.get(c.trackId) ?? 0 }))).map((x) => x.c);
  const seq = ordered.map((c) => ({
    id: c.id,
    start: c.start,
    duration: c.duration,
    maxDuration: maxClipDuration(c, project.assets.find((a) => a.id === (c.type === 'video' || c.type === 'audio' ? c.assetId : ''))?.duration),
  }));
  return { clips: ordered, seq, leftOut };
}

/** true when the places collide with a clip that stays (on the track they are going to) */
function collides(project: Project, trackId: string, places: readonly SeqPlace[]): boolean {
  const moving = new Set(places.map((p) => p.id));
  for (const o of project.clips) {
    if (o.trackId !== trackId || moving.has(o.id)) continue;
    const oe = clipEnd(o);
    for (const p of places) if (p.start < oe - EPS && p.start + p.duration > o.start + EPS) return true;
  }
  return false;
}

/**
 * put the clips at their places on one track: the track of the first clip when everything fits there,
 * else a new track above it. all or nothing, one undo step. returns false (with a toast) when it fails.
 */
function apply(project: Project, prep: Prepared, places: readonly SeqPlace[]): boolean {
  const st = useEditor.getState();
  const first = prep.clips[0]!;
  const byId = new Map(prep.clips.map((c) => [c.id, c]));
  const home = collides(project, first.trackId, places) ? null : first.trackId;
  const needsMove = places.some((p) => {
    const c = byId.get(p.id)!;
    return home === null || c.trackId !== home || Math.abs(c.start - p.start) > EPS;
  });
  const shrinks = places.filter((p) => p.duration < byId.get(p.id)!.duration - EPS);
  const grows = places.filter((p) => p.duration > byId.get(p.id)!.duration + EPS);
  if (!needsMove && shrinks.length === 0 && grows.length === 0) {
    useUi.getState().toast('already like that');
    return false;
  }

  st.pushHistory();
  const opts = { skipHistory: true };
  const fail = (): false => {
    // only what this plan wrote so far (nothing written: nothing is taken back)
    st.rollback();
    useUi.getState().toast('could not move the clips');
    return false;
  };
  let target = home;
  if (target === null) {
    const index = project.tracks.findIndex((t) => t.id === first.trackId);
    target = st.addTrack(trackKindForClip(first.type), { index: Math.max(0, index), skipHistory: true });
  }
  // shorter first (while they are still where they were), then the move, then the longer ones
  for (const p of shrinks) {
    const before = useEditor.getState().project;
    const c = byId.get(p.id)!;
    useEditor.getState().trimClip(p.id, 'end', c.start + p.duration, opts);
    applyFollowerSpans(before, p.id, opts);
  }
  const cur = useEditor.getState().project;
  if (!cur) return fail();
  if (needsMove) {
    const moves: ClipMove[] = places.map((p) => ({ id: p.id, trackId: target, start: p.start }));
    const all = withFollowerMoves(cur.clips, cur.tracks, moves);
    if (!useEditor.getState().moveClips(all, opts)) return fail();
  }
  for (const p of grows) {
    const before = useEditor.getState().project;
    useEditor.getState().trimClip(p.id, 'end', p.start + p.duration, opts);
    applyFollowerSpans(before, p.id, opts);
  }
  return true;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** "make a sequence": the selected clips end to end on one track, in order of their start. */
export function makeRow(ids: readonly string[]): void {
  const project = useEditor.getState().project;
  if (!project) return;
  const prep = prepare(project, ids);
  if (!prep) return;
  if (!apply(project, prep, planRow(prep.seq))) return;
  const n = prep.clips.length;
  useUi.getState().toast(`${n} clips in a row${prep.leftOut > 0 ? `, ${prep.leftOut} on locked tracks left out` : ''}`);
}

/** how many places start AND end on a marker, and how many follow after the last marker */
export function fitCounts(places: readonly SeqPlace[], markers: readonly number[]): { fitted: number; after: number } {
  const on = (t: number) => markers.some((m) => Math.abs(m - t) < 1e-4);
  const last = markers.length ? markers[markers.length - 1]! : 0;
  let fitted = 0;
  let after = 0;
  for (const p of places) {
    if (on(p.start) && on(p.start + p.duration)) fitted++;
    if (p.start > last + 1e-4) after++;
  }
  return { fitted, after };
}

/** "fit to the markers": clip i starts on a marker and ends on the marker `span` markers later. */
export function fitToMarkers(ids: readonly string[], span: FitSpan = 1): void {
  const project = useEditor.getState().project;
  if (!project) return;
  const markers = markerList(project);
  if (markers.length === 0) {
    useUi.getState().toast('no markers on the timeline, mark the beats first');
    return;
  }
  const prep = prepare(project, ids);
  if (!prep) return;
  const plan = planFit(prep.seq, markers, span, MIN_CLIP_DURATION);
  if (plan.onMarkers === 0) {
    useUi.getState().toast('no markers after the first clip');
    return;
  }
  if (!apply(project, prep, plan.places)) return;
  const { fitted, after } = fitCounts(plan.places, markers);
  let msg = `${fitted} ${plural(fitted, 'clip', 'clips')} on the markers`;
  if (after > 0) msg += `, ${after} after the last marker`;
  if (plan.short > 0) msg += `, ${plan.short} ${plural(plan.short, 'clip is shorter than its beat', 'clips are shorter than their beat')}`;
  if (prep.leftOut > 0) msg += `, ${prep.leftOut} on locked tracks left out`;
  useUi.getState().toast(msg);
}

/** true when "cut at the markers" would cut this clip: not effect / camera, not on a locked track, a marker inside */
export function canCutAtMarkers(project: Project | null | undefined, clip: Clip): boolean {
  if (!project || !isSequenceable(clip)) return false;
  if (project.tracks.find((t) => t.id === clip.trackId)?.locked) return false;
  return markerInsideClip(project, clip);
}

/** "cut at the markers": every selected clip is split at every marker inside it. one undo step. */
export function cutAtMarkers(ids: readonly string[]): void {
  const st = useEditor.getState();
  const project = st.project;
  if (!project) return;
  const margin = cutMargin(project);
  const times = markerList(project);
  const clips = project.clips.filter((c) => ids.includes(c.id) && canCutAtMarkers(project, c));
  const all = new Set<number>();
  for (const c of clips) for (const t of markersInside(times, c.start, clipEnd(c), margin)) all.add(t);
  if (all.size === 0) {
    useUi.getState().toast('no marker inside the selected clips');
    return;
  }
  // right to left: the left half keeps the id of the clip, so the same ids stay valid for the next cut
  const cuts = [...all].sort((a, b) => b - a);
  const scope = clips.map((c) => c.id);
  st.pushHistory();
  let n = 0;
  for (const t of cuts) {
    if (useEditor.getState().splitClips(t, scope, { skipHistory: true }).length > 0) n++;
  }
  useUi.getState().toast(`${n} ${plural(n, 'cut', 'cuts')}`);
}
