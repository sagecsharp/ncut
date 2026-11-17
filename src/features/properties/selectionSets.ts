/**
 * what the multi inspector and its button groups read from the clips of a selection, in one pass over the
 * clips with the selected ids in a Set (the old code ran ids.includes inside a filter over every clip).
 * pure: results are plain numbers / strings / id lists so a store selector can return them and react
 * re-renders only when they change.
 */
import type { Clip, Project, VisualClip } from '../../types';
import { isVisualClip } from '../../types';
import { indexClips, parentChainIn } from '../../lib/links';
import { isAlignable } from './alignLogic';
import { INHERITED_PROPS } from './multiEdit';

type Clips = readonly Clip[] | undefined;

/** true when one of the selected clips is in a group */
export function anyGrouped(clips: Clips, selection: readonly string[]): boolean {
  if (!clips) return false;
  const want = new Set(selection);
  for (const c of clips) if (c.group && want.has(c.id)) return true;
  return false;
}

/** ids of the selected visual clips, in project order */
export function visualIdsOf(clips: Clips, want: ReadonlySet<string>): string[] {
  const out: string[] = [];
  if (!clips) return out;
  for (const c of clips) if (want.has(c.id) && isVisualClip(c)) out.push(c.id);
  return out;
}

/** the first selected visual clip (project order) */
export function firstVisual(clips: Clips, want: ReadonlySet<string>): VisualClip | undefined {
  if (!clips) return undefined;
  for (const c of clips) if (want.has(c.id) && isVisualClip(c)) return c;
  return undefined;
}

/** the parent id all selected visual clips share ('' = none), or null when they differ or there are none */
export function sharedParent(clips: Clips, want: ReadonlySet<string>): string | null {
  const parents = new Set<string>();
  if (clips) for (const c of clips) if (want.has(c.id) && isVisualClip(c)) parents.add(c.parent ?? '');
  return parents.size === 1 ? [...parents][0]! : null;
}

export interface AlignCounts {
  /** visual clips align can move (flat, not attached, unlocked track): alignableClips().length */
  usable: number;
  /** selected visual clips */
  visual: number;
}

export function alignCounts(project: Pick<Project, 'clips' | 'tracks'> | null, want: ReadonlySet<string>): AlignCounts {
  if (!project) return { usable: 0, visual: 0 };
  const locked = new Set<string>();
  for (const t of project.tracks) if (t.locked) locked.add(t.id);
  let usable = 0;
  let visual = 0;
  for (const c of project.clips) {
    if (!want.has(c.id) || !isVisualClip(c)) continue;
    visual += 1;
    if (isAlignable(c) && !locked.has(c.trackId)) usable += 1;
  }
  return { usable, visual };
}

export interface ArrangeCounts {
  /** clips the arrange buttons can place: arrangeTargets().clips.length */
  usable: number;
  /** selected visual clips: usable + skipped */
  visual: number;
  /** selected 3d clips that are not on a locked track */
  threeD: number;
}

export function arrangeCounts(project: Pick<Project, 'clips' | 'tracks'> | null, want: ReadonlySet<string>): ArrangeCounts {
  if (!project) return { usable: 0, visual: 0, threeD: 0 };
  const locked = new Set<string>();
  const firstLocked = new Map<string, boolean>();
  for (const t of project.tracks) {
    if (t.locked) locked.add(t.id);
    if (!firstLocked.has(t.id)) firstLocked.set(t.id, !!t.locked);
  }
  let usable = 0;
  let visual = 0;
  let threeD = 0;
  for (const c of project.clips) {
    if (!want.has(c.id) || !isVisualClip(c)) continue;
    visual += 1;
    if (!c.parent && !locked.has(c.trackId)) usable += 1;
    if (c.threeD && !firstLocked.get(c.trackId)) threeD += 1;
  }
  return { usable, visual, threeD };
}

/**
 * the selected clips an offset of prop should be written to. for an inherited prop (INHERITED_PROPS) a clip whose
 * parent, grandparent ... is also selected is left out: it already moves with that parent. other props: every id.
 * ids that are not clips are dropped. walks with lib/links indexClips + parentChainIn (8 hops, stops on a loop).
 */
export function offsetTargets(clips: Clips, ids: readonly string[], prop: string): string[] {
  if (!clips) return [];
  const index = indexClips(clips);
  const inherited = INHERITED_PROPS.has(prop);
  const want = new Set(ids);
  const out: string[] = [];
  for (const id of ids) {
    const clip = index.get(id);
    if (!clip) continue;
    if (inherited && parentChainIn(index, clip).some((a) => want.has(a.id))) continue;
    out.push(id);
  }
  return out;
}
