import { describe, expect, it } from 'vitest';
import type { Clip } from '../../types';
import { groupIds, idsAfter, idsLike, idsOnTrack, marqueeReplaceList, marqueeSelection, pressedSelection } from './selectionRules';
import { planCloseGaps } from './gaps';

const clip = (id: string, trackId: string, start: number, duration: number, group?: string) =>
  ({ id, trackId, start, duration, ...(group ? { group } : {}) }) as unknown as Clip;

const project = {
  clips: [clip('a', 't1', 0, 2, 'g'), clip('b', 't2', 1, 2, 'g'), clip('c', 't1', 5, 1), clip('d', 't1', 9, 1, 'h'), clip('e', 't2', 10, 1, 'h')],
};

describe('group selection', () => {
  it('replace selects the whole group, alt only the clip', () => {
    expect(groupIds(project, 'a')).toEqual(['a', 'b']);
    expect(groupIds(project, 'a', true)).toEqual(['a']);
    expect(pressedSelection(project, ['c'], 'a', 'replace')).toEqual(['a', 'b']);
    expect(pressedSelection(project, ['c'], 'a', 'replace', true)).toEqual(['a']);
  });
  it('add joins the group, toggle flips the whole group', () => {
    expect(pressedSelection(project, ['c'], 'b', 'add')).toEqual(['c', 'a', 'b']);
    expect(pressedSelection(project, ['c'], 'a', 'toggle')).toEqual(['c', 'a', 'b']);
    expect(pressedSelection(project, ['c', 'a', 'b'], 'b', 'toggle')).toEqual(['c']);
    expect(pressedSelection(project, ['a', 'b', 'c'], 'a', 'toggle', true)).toEqual(['b', 'c']);
  });
  it('a clip without a group stays alone', () => {
    expect(pressedSelection(project, [], 'c', 'replace')).toEqual(['c']);
  });
  it('marquee hits widen to groups', () => {
    expect(marqueeSelection(project, ['b', 'c'])).toEqual(['a', 'b', 'c']);
  });
  it('select after the playhead (whole project / one track) widens groups', () => {
    expect(idsAfter(project, 5)).toEqual(['c', 'd', 'e']);
    expect(idsAfter(project, 5, 't1')).toEqual(['c', 'd', 'e']);
    expect(idsAfter(project, 1, 't2')).toEqual(['b', 'a', 'e', 'd'].sort((x, y) => 'abcde'.indexOf(x) - 'abcde'.indexOf(y)));
    expect(idsAfter(project, 100)).toEqual([]);
  });
  it('ids on a track', () => {
    expect(idsOnTrack(project.clips, 't1')).toEqual(['a', 'c', 'd']);
  });
});

describe('select the same kind', () => {
  const k = (id: string, type: string, extra: object = {}) => ({ id, type, trackId: 't', start: 0, duration: 1, ...extra }) as unknown as Clip;
  const clips = [
    k('t1', 'text'),
    k('v1', 'video'),
    k('t2', 'text'),
    k('e1', 'effect', { effect: 'blur' }),
    k('e2', 'effect', { effect: 'glitch' }),
    k('e3', 'effect', { effect: 'blur' }),
    k('s1', 'shape', { shape: 'rect' }),
    k('s2', 'shape', { shape: 'star' }),
  ];
  it('all clips of the type', () => {
    expect(idsLike(clips, ['t2'])).toEqual(['t1', 't2']);
    expect(idsLike(clips, ['v1'])).toEqual(['v1']);
  });
  it('effects by effect, shapes by figure', () => {
    expect(idsLike(clips, ['e1'])).toEqual(['e1', 'e3']);
    expect(idsLike(clips, ['s2'])).toEqual(['s2']);
  });
  it('several kinds at once, nothing for nothing', () => {
    expect(idsLike(clips, ['t1', 'e2'])).toEqual(['t1', 't2', 'e2']);
    expect(idsLike(clips, [])).toEqual([]);
    expect(idsLike(clips, ['gone'])).toEqual([]);
  });
});

describe('close gaps', () => {
  it('packs clips end to end from the first start', () => {
    const clips = [clip('x', 't1', 2, 1), clip('y', 't1', 5, 2), clip('z', 't1', 10, 1), clip('o', 't2', 30, 1)];
    expect(planCloseGaps(clips, 't1')).toEqual([
      { id: 'y', trackId: 't1', start: 3 },
      { id: 'z', trackId: 't1', start: 5 },
    ]);
  });
  it('plans nothing when there is no gap or one clip', () => {
    expect(planCloseGaps([clip('x', 't1', 0, 1), clip('y', 't1', 1, 1)], 't1')).toEqual([]);
    expect(planCloseGaps([clip('x', 't1', 4, 1)], 't1')).toEqual([]);
  });
  it('works on unsorted input', () => {
    const moves = planCloseGaps([clip('y', 't1', 5, 1), clip('x', 't1', 1, 1)], 't1');
    expect(moves).toEqual([{ id: 'y', trackId: 't1', start: 2 }]);
  });
});

describe('marquee in one select call', () => {
  // the store's select() for 'replace' and 'add', with clip e on a locked track
  const valid = (ids: string[]) => ids.filter((id) => id !== 'e' && project.clips.some((c) => c.id === id));
  const twoCalls = (base: string[], hits: string[]) => {
    let sel = valid(base);
    if (hits.length > 0) sel = [...new Set([...sel, ...valid(marqueeSelection(project, hits))])];
    return sel;
  };
  const oneCall = (base: string[], hits: string[]) => valid(marqueeReplaceList(project, base, hits));

  it('ends with the same selection, order included', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'gone'];
    let seed = 5;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    for (let i = 0; i < 300; i++) {
      const pick = () => ids.filter(() => rnd() < 0.4).sort(() => rnd() - 0.5);
      const base = [...new Set(pick())];
      const hits = pick().filter((h) => h !== 'gone');
      expect(oneCall(base, hits)).toEqual(twoCalls(base, hits));
    }
  });
  it('no hits keeps the base', () => {
    expect(oneCall(['c', 'a'], [])).toEqual(['c', 'a']);
  });
  it('group members that are in the base are not doubled', () => {
    expect(marqueeReplaceList(project, ['b', 'c'], ['a'])).toEqual(['b', 'c', 'a']);
  });
});
