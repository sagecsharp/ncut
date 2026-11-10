import { describe, expect, it } from 'vitest';
import { MAX_PARENT_DEPTH, canBeParent, indexClips, parentChain, parentChainIn, wouldCycle, wouldCycleAny } from '../../lib/links';
import type { Clip, Project } from '../../types';
import { isVisualClip } from '../../types';
import { overlapTest, parentOptions } from './parentOptions';
import type { ParentOption } from './parentOptions';

/* ---- the old implementation, kept as the reference ---- */
type Clips = Pick<Project, 'clips'>;
const pid = (c: Clip): string | null => (isVisualClip(c) ? (c.parent ?? null) : null);
function oldParentOf(project: Clips, clip: Clip): Clip | null {
  const id = pid(clip);
  if (!id || id === clip.id) return null;
  const parent = project.clips.find((c) => c.id === id);
  return parent && canBeParent(parent) ? parent : null;
}
function oldChain(project: Clips, clip: Clip): Clip[] {
  const chain: Clip[] = [];
  const seen = new Set<string>([clip.id]);
  let cur: Clip | null = oldParentOf(project, clip);
  while (cur && !seen.has(cur.id) && chain.length < MAX_PARENT_DEPTH) {
    chain.push(cur);
    seen.add(cur.id);
    cur = oldParentOf(project, cur);
  }
  return chain;
}
function oldWouldCycle(project: Clips, childId: string, parentId: string): boolean {
  if (childId === parentId) return true;
  const parent = project.clips.find((c) => c.id === parentId);
  if (!parent) return false;
  return parent.id === childId || oldChain(project, parent).some((c) => c.id === childId);
}
const MAX_LABEL = 24;
function baseName(c: Clip): string {
  if (c.type === 'text') {
    const line = c.text.split('\n').find((l) => l.trim() !== '')?.trim() ?? '';
    if (line) return line.length > MAX_LABEL ? `${line.slice(0, MAX_LABEL - 1)}...` : line;
  }
  return c.name.trim() || c.type;
}
function oldLabel(cands: Clip[], from: Clip[]): ParentOption[] {
  const names = cands.map(baseName);
  const count = new Map<string, number>();
  for (const n of names) count.set(n, (count.get(n) ?? 0) + 1);
  const typed = cands.map((c, i) => ((count.get(names[i]!) ?? 0) > 1 && names[i] !== c.type ? `${names[i]} (${c.type})` : names[i]!));
  const total = new Map<string, number>();
  for (const l of typed) total.set(l, (total.get(l) ?? 0) + 1);
  const seen = new Map<string, number>();
  const all = cands.map((c, i): ParentOption => {
    const l = typed[i]!;
    let label = l;
    if ((total.get(l) ?? 0) > 1) {
      const n = (seen.get(l) ?? 0) + 1;
      seen.set(l, n);
      label = `${l} ${n}`;
    }
    const overlaps = from.some((f) => f.start < c.start + c.duration && c.start < f.start + f.duration);
    return { id: c.id, label, overlaps };
  });
  return [...all.filter((o) => o.overlaps), ...all.filter((o) => !o.overlaps)];
}
function oldParentOptions(project: Clips, ids: readonly string[]): ParentOption[] {
  const from = project.clips.filter((c) => ids.includes(c.id) && isVisualClip(c));
  if (from.length === 0) return [];
  const cands = project.clips.filter((c) => canBeParent(c) && !ids.includes(c.id) && !ids.some((id) => oldWouldCycle(project, id, c.id)));
  return oldLabel(cands, from);
}

/* ---- random clip graphs ---- */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const tf = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 };
function graph(seed: number, n: number): Clip[] {
  const r = rng(seed);
  const names = ['a', 'b', 'title', '', 'x'];
  const clips: Clip[] = [];
  for (let i = 0; i < n; i++) {
    const kind = Math.floor(r() * 6);
    const base = { id: `c${i}`, trackId: 't', start: Math.floor(r() * 20), duration: 1 + Math.floor(r() * 6), name: names[Math.floor(r() * names.length)]!, fadeIn: 0, fadeOut: 0 };
    // parent: none, a clip, itself, an unknown id, or anything (loops happen)
    const pr = r();
    const parent = pr < 0.35 ? undefined : pr < 0.4 ? base.id : pr < 0.45 ? 'ghost' : `c${Math.floor(r() * n)}`;
    if (kind === 0) clips.push({ ...base, type: 'camera', x: 0, y: 0, z: 0, pan: 0, tilt: 0, roll: 0, fov: 50 } as unknown as Clip);
    else if (kind === 1) clips.push({ ...base, type: 'audio', assetId: 'a' } as unknown as Clip);
    else if (kind === 2) clips.push({ ...base, type: 'text', text: ['hello\nworld', 'title', ''][Math.floor(r() * 3)]!, transform: tf, parent } as unknown as Clip);
    else if (kind === 3) clips.push({ ...base, type: 'effect', effect: 'x', amount: 1, params: {} } as unknown as Clip);
    else clips.push({ ...base, type: 'image', assetId: 'a', transform: tf, parent } as unknown as Clip);
  }
  return clips;
}

describe('links index functions match the linear ones', () => {
  it('parentChainIn / wouldCycle(index) / wouldCycleAny on random graphs', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const clips = graph(seed, 4 + (seed % 30));
      const project = { clips };
      const index = indexClips(clips);
      const r = rng(seed * 7);
      for (const c of clips) {
        expect(parentChainIn(index, c).map((x) => x.id)).toEqual(oldChain(project, c).map((x) => x.id));
        expect(parentChain(project, c).map((x) => x.id)).toEqual(oldChain(project, c).map((x) => x.id));
      }
      for (let k = 0; k < 40; k++) {
        const a = clips[Math.floor(r() * clips.length)]!.id;
        const b = r() < 0.1 ? 'nope' : clips[Math.floor(r() * clips.length)]!.id;
        expect(wouldCycle(project, a, b)).toBe(oldWouldCycle(project, a, b));
        expect(wouldCycle(project, a, b, index)).toBe(oldWouldCycle(project, a, b));
      }
    }
  });
  it('a long chain is cut at MAX_PARENT_DEPTH the same way', () => {
    const clips: Clip[] = [];
    for (let i = 0; i < 14; i++) {
      clips.push({ id: `c${i}`, trackId: 't', start: 0, duration: 1, name: `c${i}`, fadeIn: 0, fadeOut: 0, type: 'image', assetId: 'a', transform: tf, parent: i > 0 ? `c${i - 1}` : undefined } as unknown as Clip);
    }
    const index = indexClips(clips);
    for (const a of clips) {
      for (const b of clips) {
        expect(wouldCycle({ clips }, a.id, b.id, index)).toBe(oldWouldCycle({ clips }, a.id, b.id));
        expect(wouldCycleAny(index, new Set([a.id]), b.id)).toBe(oldWouldCycle({ clips }, a.id, b.id));
      }
    }
  });
  it('duplicate ids resolve to the first clip like find', () => {
    const mk = (parent?: string) => ({ id: 'd', trackId: 't', start: 0, duration: 1, name: 'd', fadeIn: 0, fadeOut: 0, type: 'image', assetId: 'a', transform: tf, parent }) as unknown as Clip;
    const clips = [mk('e'), mk(), { ...mk('d'), id: 'e' } as Clip];
    const index = indexClips(clips);
    for (const a of ['d', 'e']) {
      for (const b of ['d', 'e']) expect(wouldCycle({ clips }, a, b, index)).toBe(oldWouldCycle({ clips }, a, b));
    }
  });
});

describe('parentOptions is identical to the old implementation', () => {
  it('random graphs, single and multi selections', () => {
    for (let seed = 1; seed <= 80; seed++) {
      const n = 3 + (seed % 40);
      const clips = graph(seed * 13, n);
      const project = { clips };
      const r = rng(seed * 31);
      const sels: string[][] = [[clips[0]!.id], clips.filter(() => r() < 0.3).map((c) => c.id), clips.filter(() => r() < 0.7).map((c) => c.id), [], ['unknown'], clips.map((c) => c.id)];
      // a selection with an id twice and out of order
      if (clips.length > 2) sels.push([clips[2]!.id, clips[0]!.id, clips[2]!.id]);
      for (const ids of sels) expect(parentOptions(project, ids)).toEqual(oldParentOptions(project, ids));
    }
  });
});

describe('overlapTest', () => {
  it('matches some() for many and few clips, with edges touching', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const r = rng(seed);
      const mk = (i: number) => ({ id: `o${i}`, start: Math.floor(r() * 30), duration: Math.floor(r() * 5) }) as unknown as Clip;
      const from = Array.from({ length: seed % 2 ? 4 : 25 }, (_, i) => mk(i));
      const test = overlapTest(from);
      for (let i = 0; i < 80; i++) {
        const c = mk(100 + i);
        expect(test(c)).toBe(from.some((f) => f.start < c.start + c.duration && c.start < f.start + f.duration));
      }
    }
  });
  it('falls back when a value is not a number', () => {
    const from = Array.from({ length: 12 }, (_, i) => ({ id: `o${i}`, start: i, duration: i === 3 ? NaN : 1 }) as unknown as Clip);
    const c = { id: 'x', start: 5, duration: 2 } as unknown as Clip;
    expect(overlapTest(from)(c)).toBe(from.some((f) => f.start < c.start + c.duration && c.start < f.start + f.duration));
  });
});
