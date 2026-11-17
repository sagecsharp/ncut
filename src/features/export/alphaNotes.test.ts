import { describe, expect, it } from 'vitest';
import type { Project } from '../../types';
import { alphaNotes } from './alphaNotes';
import { TEXT } from './delivery';

const sky = { asset: 'a', turn: 0, brightness: 1, blur: 0 };
const skyAssets = [{ id: 'a', kind: 'image', name: 'sky', width: 4000, height: 3000, duration: 0 }];

/** a project of two video tracks (the second hidden when asked) and the given clips, on track 't' unless they say otherwise */
function project(clips: Array<Record<string, unknown>>, over: Record<string, unknown> = {}): Project {
  return {
    tracks: [
      { id: 't', kind: 'video', hidden: false },
      { id: 'h', kind: 'video', hidden: true },
      { id: 'a', kind: 'audio', hidden: false },
    ],
    assets: [],
    clips: clips.map((c, i) => ({ id: `c${i}`, trackId: 't', start: 0, duration: 4, name: `clip ${i}`, ...c })),
    ...over,
  } as unknown as Project;
}
const effect = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({ type: 'effect', effect: id, amount: 1, params: {}, seed: 0, ...over });
const range = { start: 0, end: 4 };

describe('alphaNotes', () => {
  it('the sky', () => {
    expect(alphaNotes(project([], { sky, assets: skyAssets }), range)).toEqual([{ kind: 'sky', text: TEXT.sky, at: 0 }]);
    // a sky whose pictures are not there is not drawn, so it says nothing
    expect(alphaNotes(project([], { sky, assets: [] }), range)).toEqual([]);
    expect(alphaNotes(project([]), range)).toEqual([]);
  });

  it('a whole picture blur from 1 to 2 s', () => {
    const notes = alphaNotes(project([effect('gaussian-blur', { start: 1, duration: 1 })]), range);
    expect(notes).toEqual([{ kind: 'effect', text: TEXT.effect('gaussian blur', 1, 2), clipId: 'c0', at: 1 }]);
    expect(notes[0]!.text).toContain('from 1 s to 2 s');
    // only the part inside the range counts, rounded to a hundredth
    const cut = alphaNotes(project([effect('blur', { start: 1.234, duration: 5 })]), { start: 0.5, end: 3.456 });
    expect(cut).toHaveLength(1);
    expect(cut[0]!.text).toContain('from 1.23 s to 3.46 s');
    expect(cut[0]!.at).toBe(1.23);
  });

  it('own, targeted, temporal, hidden and outside give nothing', () => {
    const none = (clips: Array<Record<string, unknown>>, r = range) => expect(alphaNotes(project(clips), r)).toEqual([]);
    // the chroma key makes its own outline
    none([effect('chroma-key', { start: 1, duration: 1 })]);
    // an effect on one clip
    none([effect('gaussian-blur', { start: 1, duration: 1, target: 'c9' })]);
    // motion blur looks at other moments, it is a temporal effect
    none([effect('motion-blur', { start: 1, duration: 1 })]);
    // an effect that is not in the registry
    none([effect('no-such-effect', { start: 1, duration: 1 })]);
    // a hidden track
    none([effect('gaussian-blur', { start: 1, duration: 1, trackId: 'h' })]);
    // outside the range, touching it at the end or the start does not count
    none([effect('gaussian-blur', { start: 5, duration: 1 })]);
    none([effect('gaussian-blur', { start: 4, duration: 1 })]);
    none([effect('gaussian-blur', { start: 0, duration: 1 })], { start: 1, end: 3 });
    // a normal blend and no blend say nothing
    none([{ type: 'shape', kind: 'rect', blend: 'normal' }, { type: 'shape', kind: 'rect' }]);
    // a blend on a hidden track
    none([{ type: 'shape', kind: 'rect', blend: 'multiply', trackId: 'h' }]);
  });

  it('a multiply blend', () => {
    const notes = alphaNotes(project([{ type: 'text', blend: 'multiply', name: 'title', start: 2, duration: 1 }]), range);
    expect(notes).toEqual([{ kind: 'blend', text: TEXT.blend('title', 'multiply'), clipId: 'c0', at: 2 }]);
    expect(notes[0]!.text).toBe('"title" uses the multiply blend: where nothing is under it, it is drawn as normal, and the blend is not in the file');
  });

  it('each text once, sorted by time', () => {
    const clips = [
      { type: 'shape', kind: 'rect', blend: 'screen', name: 'glow', start: 3 },
      effect('gaussian-blur', { start: 1, duration: 1 }),
      effect('gaussian-blur', { start: 1, duration: 1 }),
      { type: 'shape', kind: 'rect', blend: 'screen', name: 'glow', start: 0.5 },
    ];
    const notes = alphaNotes(project(clips, { sky, assets: skyAssets }), range);
    expect(notes.map((n) => n.kind)).toEqual(['sky', 'blend', 'effect']);
    expect(notes.map((n) => n.at)).toEqual([0, 0.5, 1]);
    expect(new Set(notes.map((n) => n.text)).size).toBe(notes.length);
  });

  it('a blend inside the range starts where the range does', () => {
    const notes = alphaNotes(project([{ type: 'shape', kind: 'rect', blend: 'add', start: 0, duration: 4 }]), { start: 1.5, end: 3 });
    expect(notes[0]!.at).toBe(1.5);
  });
});
