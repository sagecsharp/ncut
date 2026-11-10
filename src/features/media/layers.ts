/**
 * the scene outline of the layers tab: which clips are on screen (or all), nested by attachment.
 * pure, no react, no store.
 */
import type { Clip, ClipType, Project } from '../../types';
import { isCameraClip, isVisualClip } from '../../types';
import { MAX_PARENT_DEPTH, canBeParent, parentOf, wouldCycle } from '../../lib/links';

export type LayersMode = 'now' | 'all';

export interface LayerNode {
  id: string;
  /** 0 = root. capped at MAX_PARENT_DEPTH */
  depth: number;
  name: string;
  type: ClipType;
  threeD: boolean;
  /** its track is hidden */
  hidden: boolean;
  /** its track is locked */
  locked: boolean;
  group: string | null;
  hasChildren: boolean;
  /** name of the clip this one is attached to, when that clip is not its parent in this list */
  attachedTo: string | null;
}

/** how close to a clip's end still counts as inside, avoids float edges */
const EPS = 1e-6;

function clipName(clip: Clip): string {
  if (clip.type === 'text') {
    const t = clip.text.replace(/\s+/g, ' ').trim();
    return t || clip.name || 'text';
  }
  if (clip.type === 'shape') return clip.name || clip.kind;
  return clip.name || clip.type;
}

/** clips that can show in the outline: everything that draws something (not audio) */
function isLayerClip(clip: Clip): boolean {
  return isVisualClip(clip) || isCameraClip(clip) || clip.type === 'effect';
}

/** the layer clips of a project in draw order (track index, then start), top row first */
export function layerClips(project: Pick<Project, 'tracks' | 'clips'>, time: number, mode: LayersMode): Clip[] {
  const trackIndex = new Map<string, number>();
  project.tracks.forEach((t, i) => trackIndex.set(t.id, i));
  return project.clips
    .filter((c) => isLayerClip(c) && (mode === 'all' || (time >= c.start - EPS && time < c.start + c.duration - EPS)))
    .sort((a, b) => (trackIndex.get(a.trackId) ?? 1e9) - (trackIndex.get(b.trackId) ?? 1e9) || a.start - b.start);
}

export function buildLayerTree(project: Project, time: number, mode: LayersMode): LayerNode[] {
  const list = layerClips(project, time, mode);
  const inList = new Set(list.map((c) => c.id));
  const trackOf = new Map(project.tracks.map((t) => [t.id, t]));
  const children = new Map<string, Clip[]>();
  const rootAttach = new Map<string, string>();
  const roots: Clip[] = [];
  for (const c of list) {
    const p = parentOf(project, c);
    if (p && inList.has(p.id)) {
      const arr = children.get(p.id);
      if (arr) arr.push(c);
      else children.set(p.id, [c]);
    } else {
      roots.push(c);
      if (p) rootAttach.set(c.id, clipName(p));
    }
  }

  const out: LayerNode[] = [];
  const seen = new Set<string>();
  const visit = (clip: Clip, depth: number, attachedTo: string | null) => {
    // iterative, so a very deep chain cannot blow the stack
    const stack: { clip: Clip; depth: number; attachedTo: string | null }[] = [{ clip, depth, attachedTo }];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (seen.has(cur.clip.id)) continue;
      seen.add(cur.clip.id);
      const kids = (children.get(cur.clip.id) ?? []).filter((k) => !seen.has(k.id));
      const track = trackOf.get(cur.clip.trackId);
      out.push({
        id: cur.clip.id,
        depth: Math.min(cur.depth, MAX_PARENT_DEPTH),
        name: clipName(cur.clip),
        type: cur.clip.type,
        threeD: isVisualClip(cur.clip) && !!cur.clip.threeD,
        hidden: !!track?.hidden,
        locked: !!track?.locked,
        group: cur.clip.group ?? null,
        hasChildren: kids.length > 0,
        attachedTo: cur.attachedTo,
      });
      for (let i = kids.length - 1; i >= 0; i--) stack.push({ clip: kids[i]!, depth: cur.depth + 1, attachedTo: null });
    }
  };
  for (const r of roots) visit(r, 0, rootAttach.get(r.id) ?? null);
  // clips left over sit in a loop of the data: show them at the root so nothing disappears
  for (const c of list) if (!seen.has(c.id)) visit(c, 0, null);
  return out;
}

/** can clip `childId` be attached to clip `parentId`? (parent is a picture / camera, no loops) */
export function canAttach(project: Pick<Project, 'clips'>, childId: string, parentId: string): boolean {
  if (childId === parentId) return false;
  const child = project.clips.find((c) => c.id === childId);
  const parent = project.clips.find((c) => c.id === parentId);
  if (!child || !parent) return false;
  if (!isVisualClip(child)) return false; // only pictures carry a parent
  if (!canBeParent(parent)) return false;
  return !wouldCycle(project, childId, parentId);
}
