import { describe, expect, it } from 'vitest';
import type { Clip, Project, Track } from '../../types';
import { isVisualClip } from '../../types';
import { alignableClips } from './alignActions';
import { arrangeTargets } from './arrange3d';
import { alignCounts, anyGrouped, arrangeCounts, firstVisual, sharedParent, visualIdsOf } from './selectionSets';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const tf = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 };

function world(seed: number) {
  const r = rng(seed);
  const tracks: Track[] = Array.from({ length: 4 }, (_, i) => ({ id: `t${i}`, kind: 'video', name: `t${i}`, muted: false, hidden: false, locked: r() < 0.3 }) as Track);
  const n = 5 + Math.floor(r() * 40);
  const clips: Clip[] = [];
  for (let i = 0; i < n; i++) {
    const base = { id: `c${i}`, trackId: r() < 0.1 ? 'gone' : `t${Math.floor(r() * 4)}`, start: Math.floor(r() * 20), duration: 2, name: `n${i}`, fadeIn: 0, fadeOut: 0, group: r() < 0.2 ? 'g' : undefined };
    const k = r();
    if (k < 0.15) clips.push({ ...base, type: 'audio', assetId: 'a' } as unknown as Clip);
    else if (k < 0.25) clips.push({ ...base, type: 'camera', x: 0, y: 0, z: 0, pan: 0, tilt: 0, roll: 0, fov: 50 } as unknown as Clip);
    else clips.push({ ...base, type: 'image', assetId: 'a', transform: tf, threeD: r() < 0.3, parent: r() < 0.3 ? `c${Math.floor(r() * n)}` : r() < 0.1 ? '' : undefined } as unknown as Clip);
  }
  const project = { clips, tracks } as unknown as Project;
  const sel = clips.filter(() => r() < 0.5).map((c) => c.id);
  if (r() < 0.2) sel.push('missing');
  return { project, sel };
}

describe('selection counts match the array based originals', () => {
  it('align / arrange counts, visual ids, first visual, shared parent, any group', () => {
    for (let seed = 1; seed <= 120; seed++) {
      const { project, sel } = world(seed);
      const want = new Set(sel);
      const { clips, tracks } = project;

      expect(alignCounts(project, want)).toEqual({
        usable: alignableClips(project, sel).length,
        visual: clips.filter((c) => sel.includes(c.id) && isVisualClip(c)).length,
      });

      const t = arrangeTargets(project, sel);
      expect(arrangeCounts(project, want)).toEqual({
        usable: t.clips.length,
        visual: t.clips.length + t.skipped,
        threeD: clips.filter((c) => sel.includes(c.id) && isVisualClip(c) && c.threeD && !tracks.find((tr) => tr.id === c.trackId)?.locked).length,
      });

      expect(visualIdsOf(clips, want)).toEqual(clips.filter((c) => sel.includes(c.id) && isVisualClip(c)).map((c) => c.id));
      expect(firstVisual(clips, want)).toBe(clips.find((k) => sel.includes(k.id) && isVisualClip(k)));

      const parents = new Set(clips.filter((c) => sel.includes(c.id) && isVisualClip(c)).map((c) => (isVisualClip(c) ? (c.parent ?? '') : '')));
      expect(sharedParent(clips, want)).toBe(parents.size === 1 ? [...parents][0]! : null);

      expect(anyGrouped(clips, sel)).toBe(!!clips.some((c) => c.group && sel.includes(c.id)));
    }
  });
  it('no project / no clips', () => {
    expect(alignCounts(null, new Set())).toEqual({ usable: 0, visual: 0 });
    expect(arrangeCounts(null, new Set())).toEqual({ usable: 0, visual: 0, threeD: 0 });
    expect(visualIdsOf(undefined, new Set(['a']))).toEqual([]);
    expect(sharedParent(undefined, new Set(['a']))).toBeNull();
    expect(anyGrouped(undefined, ['a'])).toBe(false);
    expect(firstVisual(undefined, new Set(['a']))).toBeUndefined();
  });
});
