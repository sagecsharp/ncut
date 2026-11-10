import { describe, expect, it } from 'vitest';
import type { Clip, ClipType, Project, Track } from '../../types';
import { isCameraClip, isVisualClip } from '../../types';
import { MAX_PARENT_DEPTH, parentOf } from '../../lib/links';
import { buildLayerTree } from './layers';
import type { LayerNode, LayersMode } from './layers';
import { createLayerView, shareNodes } from './layerView';

/* ---- the old implementation (linear finds), kept as the reference ---- */
const EPS = 1e-6;
function clipName(clip: Clip): string {
  if (clip.type === 'text') {
    const t = clip.text.replace(/\s+/g, ' ').trim();
    return t || clip.name || 'text';
  }
  if (clip.type === 'shape') return clip.name || clip.kind;
  return clip.name || clip.type;
}
function oldLookTargetName(project: Pick<Project, 'clips'>, clip: Clip): string | null {
  if (!isVisualClip(clip) || clip.lookAt !== 'clip' || !clip.lookTarget || clip.lookTarget === clip.id) return null;
  const target = project.clips.find((c) => c.id === clip.lookTarget);
  return target && isVisualClip(target) ? clipName(target) : null;
}
function oldBuild(project: Project, time: number, mode: LayersMode): LayerNode[] {
  const trackIndex = new Map<string, number>();
  project.tracks.forEach((t, i) => trackIndex.set(t.id, i));
  const list = project.clips
    .filter((c) => (isVisualClip(c) || isCameraClip(c) || c.type === 'effect') && (mode === 'all' || (time >= c.start - EPS && time < c.start + c.duration - EPS)))
    .sort((a, b) => (trackIndex.get(a.trackId) ?? 1e9) - (trackIndex.get(b.trackId) ?? 1e9) || a.start - b.start);
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
        trackId: cur.clip.trackId,
        firstOfTrack: false,
        masked: isVisualClip(cur.clip) && !!cur.clip.mask,
        looksAt: oldLookTargetName(project, cur.clip),
        canRename: cur.clip.type !== 'text',
      });
      for (let i = kids.length - 1; i >= 0; i--) stack.push({ clip: kids[i]!, depth: cur.depth + 1, attachedTo: null });
    }
  };
  for (const r of roots) visit(r, 0, rootAttach.get(r.id) ?? null);
  for (const c of list) if (!seen.has(c.id)) visit(c, 0, null);
  const tracksSeen = new Set<string>();
  for (const n of out) {
    n.firstOfTrack = !tracksSeen.has(n.trackId);
    tracksSeen.add(n.trackId);
  }
  return out;
}
function oldAttachedNames(project: Project, nodes: LayerNode[]): Map<string, string> {
  const m = new Map<string, string>();
  const byId = new Map(project.clips.map((c) => [c.id, c]));
  for (const n of nodes) {
    const c = byId.get(n.id);
    const par = c ? parentOf(project, c) : null;
    if (par) m.set(n.id, par.type === 'text' ? par.text.replace(/\s+/g, ' ').trim() || par.name : par.name || par.type);
  }
  return m;
}

/* ---- random projects ---- */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const tf = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 };
function project(seed: number): Project {
  const r = rng(seed);
  const tracks: Track[] = Array.from({ length: 4 }, (_, i) => ({ id: `t${i}`, kind: 'video', name: `t${i}`, muted: false, hidden: r() < 0.2, locked: r() < 0.2 }) as Track);
  const n = 4 + Math.floor(r() * 40);
  const clips: Clip[] = [];
  for (let i = 0; i < n; i++) {
    const base = { id: `c${i}`, trackId: `t${Math.floor(r() * 4)}`, start: Math.floor(r() * 12), duration: 1 + Math.floor(r() * 6), name: r() < 0.3 ? '' : `n${Math.floor(r() * 5)}`, fadeIn: 0, fadeOut: 0, group: r() < 0.2 ? 'g' : undefined };
    const k = r();
    const parent = r() < 0.4 ? `c${Math.floor(r() * n)}` : r() < 0.05 ? 'ghost' : undefined;
    if (k < 0.12) clips.push({ ...base, type: 'audio', assetId: 'a' } as unknown as Clip);
    else if (k < 0.22) clips.push({ ...base, type: 'camera', x: 0, y: 0, z: 0, pan: 0, tilt: 0, roll: 0, fov: 50 } as unknown as Clip);
    else if (k < 0.3) clips.push({ ...base, type: 'effect', effect: 'x', amount: 1, params: {} } as unknown as Clip);
    else if (k < 0.45) clips.push({ ...base, type: 'text', text: ['hello  world', '', 'x\ny'][Math.floor(r() * 3)]!, transform: tf, parent } as unknown as Clip);
    else
      clips.push({
        ...base, type: 'shape', kind: 'rect', transform: tf, parent, threeD: r() < 0.3, mask: r() < 0.2 ? {} : undefined,
        lookAt: r() < 0.4 ? 'clip' : 'none', lookTarget: r() < 0.5 ? `c${Math.floor(r() * n)}` : null,
      } as unknown as Clip);
  }
  return { tracks, clips, assets: [], width: 1920, height: 1080, fps: 30 } as unknown as Project;
}

describe('layer tree and view equal the old implementation', () => {
  it('buildLayerTree and attached names on random projects, both modes and several times', () => {
    for (let seed = 1; seed <= 70; seed++) {
      const p = project(seed);
      const view = createLayerView();
      for (const mode of ['now', 'all'] as const) {
        for (const time of [0, 2.5, 5, 9, 30]) {
          const expected = oldBuild(p, time, mode);
          expect(buildLayerTree(p, time, mode)).toEqual(expected);
          const v = view(p, time, mode);
          expect(v.nodes).toEqual(expected);
          expect([...v.attachedNames]).toEqual([...oldAttachedNames(p, expected)]);
        }
      }
    }
  });
});

describe('layer view cache', () => {
  const mk = () => {
    const p = project(5);
    return { ...p, clips: [...p.clips] } as Project;
  };
  it('returns the same view when only clips the outline does not read change', () => {
    const p = mk();
    const view = createLayerView();
    const a = view(p, 0, 'all');
    // an audio clip edit: a new clips array and a new audio object, nothing the rows read
    const audioIdx = p.clips.findIndex((c) => c.type === 'audio');
    if (audioIdx >= 0) {
      const clips = [...p.clips];
      clips[audioIdx] = { ...clips[audioIdx]!, name: 'renamed' } as Clip;
      expect(view({ ...p, clips }, 0, 'all')).toBe(a);
    }
    expect(view({ ...p, clips: [...p.clips] }, 0, 'all')).toBe(a);
  });
  it('now mode: the same set of active clips gives the same view at another time', () => {
    const clips = [
      { id: 'a', trackId: 't0', start: 0, duration: 10, name: 'a', fadeIn: 0, fadeOut: 0, type: 'shape', kind: 'rect', transform: tf },
      { id: 'b', trackId: 't0', start: 20, duration: 5, name: 'b', fadeIn: 0, fadeOut: 0, type: 'shape', kind: 'rect', transform: tf },
    ] as unknown as Clip[];
    const p = { tracks: [{ id: 't0', kind: 'video', name: 't0', muted: false, hidden: false, locked: false }], clips } as unknown as Project;
    const view = createLayerView();
    const a = view(p, 1, 'now');
    expect(view(p, 7, 'now')).toBe(a);
    expect(view(p, 21, 'now').nodes.map((n) => n.id)).toEqual(['b']);
  });
  it('rebuilds when a listed clip, its parent, its look target or the tracks change', () => {
    const base = (id: string, extra: Record<string, unknown> = {}) =>
      ({ id, trackId: 't0', start: 0, duration: 10, name: id, fadeIn: 0, fadeOut: 0, type: 'shape', kind: 'rect', transform: tf, ...extra }) as unknown as Clip;
    const tracks = [{ id: 't0', kind: 'video', name: 't0', muted: false, hidden: false, locked: false }] as unknown as Track[];
    const clips = [base('p'), base('c', { parent: 'p', lookAt: 'clip', lookTarget: 'q' }), base('q', { start: 50 })];
    const p = { tracks, clips } as unknown as Project;
    const view = createLayerView();
    const a = view(p, 1, 'now');
    expect(a.attachedNames.get('c')).toBe('p');
    expect(a.nodes.find((n) => n.id === 'c')!.looksAt).toBe('q');

    // the look target is not on screen but its name is read
    const renamedQ = view({ tracks, clips: clips.map((c) => (c.id === 'q' ? ({ ...c, name: 'Q2' } as Clip) : c)) } as Project, 1, 'now');
    expect(renamedQ).not.toBe(a);
    expect(renamedQ.nodes.find((n) => n.id === 'c')!.looksAt).toBe('Q2');
    // rows that did not change keep their object
    expect(renamedQ.nodes.find((n) => n.id === 'p')).toBe(a.nodes.find((n) => n.id === 'p'));

    const renamedP = view({ tracks, clips: clips.map((c) => (c.id === 'p' ? ({ ...c, name: 'P2' } as Clip) : c)) } as Project, 1, 'now');
    expect(renamedP.attachedNames.get('c')).toBe('P2');

    const hidden = view({ tracks: [{ ...tracks[0]!, hidden: true }], clips } as Project, 1, 'now');
    expect(hidden.nodes.every((n) => n.hidden)).toBe(true);
  });
  it('no project change at all gives back the old rows array', () => {
    const p = mk();
    const view = createLayerView();
    const a = view(p, 0, 'all');
    const same = view({ ...p, tracks: [...p.tracks] }, 0, 'all');
    expect(same.nodes).toBe(a.nodes);
    expect(same).toBe(a);
  });
});

describe('shareNodes', () => {
  const node = (id: string, name = id): LayerNode =>
    ({ id, depth: 0, name, type: 'shape' as ClipType, threeD: false, hidden: false, locked: false, group: null, hasChildren: false, attachedTo: null, trackId: 't', firstOfTrack: false, masked: false, looksAt: null, canRename: true });
  it('keeps old objects for equal rows and the old array when all are equal', () => {
    const prev = [node('a'), node('b')];
    const same = shareNodes(prev, [node('a'), node('b')]);
    expect(same).toBe(prev);
    const part = shareNodes(prev, [node('a'), node('b', 'B')]);
    expect(part).not.toBe(prev);
    expect(part[0]).toBe(prev[0]);
    expect(part[1]!.name).toBe('B');
  });
});


