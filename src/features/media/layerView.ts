/**
 * the rows of the layers tab, kept between project changes. the outline only reads the listed clips, the
 * clips they are attached to / face, and the tracks, so an edit to anything else (an audio clip, another
 * track's clip that is not on screen, a marker, an asset) returns the same rows without rebuilding. when
 * something that is read did change, rows whose content is the same keep their object, so memoised rows do
 * not re-render. pure, no react, no store.
 */
import type { Clip, Project } from '../../types';
import { indexClips, parentOfIn } from '../../lib/links';
import { buildLayerTree, layerFilter } from './layers';
import type { LayerNode, LayersMode } from './layers';

export interface LayerView {
  nodes: LayerNode[];
  /** row id -> name of the clip it is attached to (also for nested rows) */
  attachedNames: Map<string, string>;
}

type LayerProject = Pick<Project, 'tracks' | 'clips'>;

/** name of the clip a row is attached to, shown by the link icon */
function attachName(par: Clip): string {
  return par.type === 'text' ? par.text.replace(/\s+/g, ' ').trim() || par.name : par.name || par.type;
}

/** id -> name of the clip each row is attached to. `rowClip` is how the clip of a row is found (last clip with that id wins). */
export function attachedNameMap(index: ReadonlyMap<string, Clip>, rowClip: ReadonlyMap<string, Clip>, nodes: readonly LayerNode[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const n of nodes) {
    const c = rowClip.get(n.id);
    const par = c ? parentOfIn(index, c) : null;
    if (par) m.set(n.id, attachName(par));
  }
  return m;
}

function sameList<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function sameNode(a: LayerNode, b: LayerNode): boolean {
  const keys = Object.keys(a) as (keyof LayerNode)[];
  if (keys.length !== Object.keys(b).length) return false;
  for (const k of keys) if (a[k] !== b[k]) return false;
  return true;
}

/** the new rows, with the object of the old row wherever the content did not change (and the old array when nothing did) */
export function shareNodes(prev: readonly LayerNode[] | null, next: LayerNode[]): LayerNode[] {
  if (!prev) return next;
  const old = new Map(prev.map((n) => [n.id, n]));
  const out = next.map((n) => {
    const o = old.get(n.id);
    return o && sameNode(o, n) ? o : n;
  });
  return sameList(prev, out) ? (prev as LayerNode[]) : out;
}

/**
 * a function that gives the layer view of a project at a time. keep one per tab. the result is the same as
 * buildLayerTree + attachedNameMap on that project, only cheaper when little changed.
 */
export function createLayerView(): (project: LayerProject, time: number, mode: LayersMode) => LayerView {
  let prev: { tracks: LayerProject['tracks']; listed: Clip[]; linked: (Clip | undefined)[]; view: LayerView } | null = null;
  return (project, time, mode) => {
    const index = indexClips(project.clips);
    const listed = layerFilter(project.clips, time, mode);
    // everything besides the listed clips themselves that the rows read: the clip each one is attached to and the one it faces
    const linked: (Clip | undefined)[] = [];
    for (const c of listed) {
      const link = c as { parent?: string | null; lookTarget?: string | null };
      linked.push(link.parent ? index.get(link.parent) : undefined, link.lookTarget ? index.get(link.lookTarget) : undefined);
    }
    if (prev && prev.tracks === project.tracks && sameList(prev.listed, listed) && sameList(prev.linked, linked)) return prev.view;

    const nodes = shareNodes(prev ? prev.view.nodes : null, buildLayerTree(project, time, mode));
    const rowClip = new Map(project.clips.map((c) => [c.id, c]));
    const attached = attachedNameMap(index, rowClip, nodes);
    const old = prev?.view;
    const view: LayerView =
      old && nodes === old.nodes && sameMap(old.attachedNames, attached) ? old : { nodes, attachedNames: attached };
    prev = { tracks: project.tracks, listed, linked, view };
    return view;
  };
}

function sameMap(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}
