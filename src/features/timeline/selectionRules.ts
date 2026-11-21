/**
 * pure selection rules of the timeline: groups select together, alt picks one clip, plus the
 * "select after the playhead / on this track" sets. no store access, so it can be tested.
 */
import type { Clip, Project } from '../../types';
import { expandGroups } from '../../lib/links';

type Clips = Pick<Project, 'clips'>;

export type PressMode = 'replace' | 'add' | 'toggle';

/** the ids a click on `id` stands for: the whole group, or just the clip when `single` (alt) */
export function groupIds(project: Clips, id: string, single = false): string[] {
  return single ? [id] : expandGroups(project, [id]);
}

/**
 * the selection after a press on a clip.
 * replace: its group (or itself). add (shift): current plus its group. toggle (ctrl / meta): when the
 * clip is selected its whole group leaves the selection, else the whole group joins it.
 * `single` (alt) ignores the group.
 */
export function pressedSelection(project: Clips, selection: readonly string[], id: string, mode: PressMode, single = false): string[] {
  const ids = groupIds(project, id, single);
  if (mode === 'replace') return ids;
  if (mode === 'add') return [...new Set([...selection, ...ids])];
  if (selection.includes(id)) {
    const drop = new Set(ids);
    return selection.filter((s) => !drop.has(s));
  }
  return [...new Set([...selection, ...ids])];
}

/** marquee hits widened to whole groups */
export function marqueeSelection(project: Clips, hits: readonly string[]): string[] {
  return expandGroups(project, hits);
}

/**
 * the list to hand to select(list, 'replace') in ONE call for a marquee over `hits` that started with the
 * selection `base`. select(base, 'replace') followed by select(widened hits, 'add') ends with the base
 * followed by the hits not already in it (add merges through a Set); filtering out missing / locked clips
 * happens per id, so it gives the same list whether it runs before or after the merge.
 */
export function marqueeReplaceList(project: Clips, base: readonly string[], hits: readonly string[]): string[] {
  if (hits.length === 0) return [...base];
  return [...new Set([...base, ...marqueeSelection(project, hits)])];
}

/** clips that start at or after `time` (optionally one track only), widened to whole groups */
export function idsAfter(project: Clips, time: number, trackId?: string): string[] {
  const eps = 1e-6;
  const hit = project.clips.filter((c) => c.start >= time - eps && (trackId === undefined || c.trackId === trackId));
  return expandGroups(
    project,
    hit.map((c) => c.id),
  );
}

/** what makes two clips "the same kind": the type, for effects the effect, for shapes the figure */
function kindOf(c: Clip): string {
  if (c.type === 'effect') return 'effect:' + c.effect;
  if (c.type === 'shape') return 'shape:' + c.shape;
  return c.type;
}

/** every clip of the same kind as one of `ids` (all texts, all clips of this effect ...), in project order */
export function idsLike(clips: readonly Clip[], ids: readonly string[]): string[] {
  const picked = new Set(ids);
  const kinds = new Set(clips.filter((c) => picked.has(c.id)).map(kindOf));
  if (kinds.size === 0) return [];
  return clips.filter((c) => kinds.has(kindOf(c))).map((c) => c.id);
}

/** every clip of a track */
export function idsOnTrack(clips: readonly Clip[], trackId: string): string[] {
  return clips.filter((c) => c.trackId === trackId).map((c) => c.id);
}

/**
 * shift+click: every clip from the anchor (the clip clicked last without shift) to the clicked one. the range is the
 * box they span: the tracks from the higher one to the lower one and the time from the earlier start to the later
 * end; a clip that reaches into that box is in. groups are widened like a marquee. no anchor (or one that is gone):
 * just the clicked clip's group joins the selection, as before.
 */
export function rangeSelection(project: Pick<Project, 'clips' | 'tracks'>, selection: readonly string[], anchorId: string | null, id: string): string[] {
  const anchor = anchorId ? project.clips.find((c) => c.id === anchorId) : undefined;
  const clicked = project.clips.find((c) => c.id === id);
  if (!anchor || !clicked) return pressedSelection(project, selection, id, 'add');
  const ia = project.tracks.findIndex((t) => t.id === anchor.trackId);
  const ic = project.tracks.findIndex((t) => t.id === clicked.trackId);
  if (ia < 0 || ic < 0) return pressedSelection(project, selection, id, 'add');
  const top = Math.min(ia, ic);
  const bottom = Math.max(ia, ic);
  const from = Math.min(anchor.start, clicked.start);
  const to = Math.max(anchor.start + anchor.duration, clicked.start + clicked.duration);
  const rows = new Set(project.tracks.slice(top, bottom + 1).map((t) => t.id));
  const hits: string[] = [];
  for (const c of project.clips) {
    if (!rows.has(c.trackId)) continue;
    if (c.start < to - 1e-9 && c.start + c.duration > from + 1e-9) hits.push(c.id);
  }
  // the anchor first: the range keeps it as the start of the next shift+click
  return marqueeSelection(project, [anchor.id, ...hits.filter((h) => h !== anchor.id)]);
}
