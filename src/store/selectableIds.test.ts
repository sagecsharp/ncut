import { describe, expect, it } from 'vitest';
import { selectableIds } from './selectableIds';

const clip = (id: string, trackId: string) => ({ id, trackId });
const project = (clips: { id: string; trackId: string }[], tracks: { id: string; locked?: boolean }[]) =>
  ({ clips, tracks }) as unknown as Parameters<typeof selectableIds>[0];

describe('selectableIds', () => {
  const p = project([clip('a', 't1'), clip('b', 't2'), clip('c', 't1'), clip('d', 'gone')], [{ id: 't1' }, { id: 't2', locked: true }]);

  it('keeps the order asked and drops unknown ids and clips on locked tracks', () => {
    expect(selectableIds(p, ['c', 'x', 'b', 'a'])).toEqual(['c', 'a']);
  });

  it('a clip whose track is missing is selectable (like isLocked)', () => {
    expect(selectableIds(p, ['d'])).toEqual(['d']);
  });

  it('keeps an id asked twice', () => {
    expect(selectableIds(p, ['a', 'a'])).toEqual(['a', 'a']);
  });

  it('empty in, empty out', () => {
    expect(selectableIds(p, [])).toEqual([]);
    expect(selectableIds(project([], []), ['a'])).toEqual([]);
  });

  it('the first clip / track with an id counts', () => {
    const dup = project([clip('a', 't2'), clip('a', 't1')], [{ id: 't1' }, { id: 't2', locked: true }, { id: 't2', locked: false }]);
    expect(selectableIds(dup, ['a'])).toEqual([]);
  });

  it('matches the old per-id scan on a bigger project', () => {
    const tracks = Array.from({ length: 6 }, (_, i) => ({ id: `t${i}`, locked: i % 3 === 0 }));
    const clips = Array.from({ length: 400 }, (_, i) => clip(`c${i}`, `t${i % 7}`));
    const ids = Array.from({ length: 300 }, (_, i) => `c${(i * 7) % 450}`);
    const old = ids.filter((id) => {
      const c = clips.find((x) => x.id === id);
      return c && !(tracks.find((t) => t.id === c.trackId)?.locked ?? false);
    });
    expect(selectableIds(project(clips, tracks), ids)).toEqual(old);
  });
});
