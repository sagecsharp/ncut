/**
 * links between clips by id: parent (Spatial.parent), look targets (Spatial.lookTarget), groups
 * (ClipBase.group), camera targets and the clip an effect is put on (EffectClip.target).
 * pure, no math: the geometry of parenting lives in engine/parent.ts.
 */
import type { Clip, Project } from '../types';
import { isCameraClip, isVisualClip } from '../types';
import { uid } from './id';

/** how many parents are followed before the chain is cut */
export const MAX_PARENT_DEPTH = 8;

type Clips = Pick<Project, 'clips'>;

function parentId(clip: Clip): string | null {
  return isVisualClip(clip) ? (clip.parent ?? null) : null;
}

/** true when a clip of this type can be a parent (pictures and cameras) */
export function canBeParent(clip: Clip): boolean {
  return isVisualClip(clip) || isCameraClip(clip);
}

/**
 * the clip this one is attached to, or null. unknown ids, a clip pointing at itself and clips that
 * cannot be a parent (audio, effects) all count as no parent.
 */
export function parentOf(project: Clips, clip: Clip): Clip | null {
  const id = parentId(clip);
  if (!id || id === clip.id) return null;
  const parent = project.clips.find((c) => c.id === id);
  return parent && canBeParent(parent) ? parent : null;
}

/**
 * the parents of a clip, nearest first. stops at MAX_PARENT_DEPTH and before a clip that is already
 * in the chain, so a loop in the data never hangs or throws.
 */
export function parentChain(project: Clips, clip: Clip): Clip[] {
  const chain: Clip[] = [];
  const seen = new Set<string>([clip.id]);
  let cur: Clip | null = parentOf(project, clip);
  while (cur && !seen.has(cur.id) && chain.length < MAX_PARENT_DEPTH) {
    chain.push(cur);
    seen.add(cur.id);
    cur = parentOf(project, cur);
  }
  return chain;
}

/** true when attaching childId to parentId would make a loop (or is the clip itself) */
export function wouldCycle(project: Clips, childId: string, parentId: string): boolean {
  if (childId === parentId) return true;
  const parent = project.clips.find((c) => c.id === parentId);
  if (!parent) return false;
  return parent.id === childId || parentChain(project, parent).some((c) => c.id === childId);
}

/** the clips attached directly to a clip */
export function childrenOf(project: Clips, id: string): Clip[] {
  return project.clips.filter((c) => c.id !== id && parentId(c) === id);
}

/** ids plus every clip that shares a group with one of them. keeps the order of project.clips. */
export function expandGroups(project: Clips, ids: readonly string[]): string[] {
  const want = new Set(ids);
  const groups = new Set<string>();
  for (const c of project.clips) if (want.has(c.id) && c.group) groups.add(c.group);
  if (groups.size === 0) return [...ids];
  const out: string[] = [];
  for (const c of project.clips) if (want.has(c.id) || (c.group && groups.has(c.group))) out.push(c.id);
  // ids that are not clips (should not happen) are kept so callers do not lose them
  for (const id of ids) if (!out.includes(id)) out.push(id);
  return out;
}

/**
 * after copying clips: point the links of the copies at each other instead of at the originals.
 * idMap: original id -> copy id. a parent / camera target that was copied too is swapped for its
 * copy, one that was not is kept. a group shared by two or more copies becomes a new group, a copy
 * that left its group behind is ungrouped.
 */
export function relinkCopies(copies: Clip[], idMap: ReadonlyMap<string, string>, originals: readonly Clip[]): Clip[] {
  const groupCount = new Map<string, number>();
  for (const c of originals) if (c.group) groupCount.set(c.group, (groupCount.get(c.group) ?? 0) + 1);
  const newGroup = new Map<string, string>();
  return copies.map((c) => {
    let next = c;
    if (isVisualClip(next) && next.parent && idMap.has(next.parent)) next = { ...next, parent: idMap.get(next.parent)! };
    if (isVisualClip(next) && next.lookTarget && idMap.has(next.lookTarget)) next = { ...next, lookTarget: idMap.get(next.lookTarget)! };
    if (isCameraClip(next) && next.target && idMap.has(next.target)) next = { ...next, target: idMap.get(next.target)! };
    if (next.type === 'effect' && next.target && idMap.has(next.target)) next = { ...next, target: idMap.get(next.target)! };
    if (next.group) {
      if ((groupCount.get(next.group) ?? 0) >= 2) {
        let g = newGroup.get(next.group);
        if (!g) {
          g = uid('grp');
          newGroup.set(next.group, g);
        }
        next = { ...next, group: g };
      } else {
        const { group: _drop, ...rest } = next;
        void _drop;
        next = rest as Clip;
      }
    }
    return next;
  });
}

/** clips with every link to one of the removed ids cleared (parents, camera targets) */
export function unlinkRemoved(clips: Clip[], removed: ReadonlySet<string>): Clip[] {
  return clips.map((c0) => {
    let c = c0;
    if (isVisualClip(c) && c.lookTarget && removed.has(c.lookTarget)) c = { ...c, lookTarget: null };
    if (isVisualClip(c) && c.parent && removed.has(c.parent)) return { ...c, parent: null };
    if (isCameraClip(c) && c.target && removed.has(c.target)) return { ...c, target: null };
    // an effect that was on one clip does not turn into an effect on everything when that clip goes:
    // it keeps pointing at the id that is gone, which means "does nothing" (see EffectClip.target)
    return c;
  });
}
