import { describe, expect, it } from 'vitest';
import type { ParentOption } from './parentOptions';
import { closedModel, currentLabel, openModel, shownLabel } from './selectModel';

const opts: ParentOption[] = [
  { id: 'a', label: 'title 1', overlaps: true },
  { id: 'b', label: 'title 2', overlaps: false },
  { id: 'c', label: 'cam', overlaps: false },
];

describe('closed picker shows what the open picker shows', () => {
  for (const value of [null, '', 'a', 'b', 'c', 'gone'] as const) {
    for (const none of ['nothing', 'everything below']) {
      it(`value ${String(value)} / ${none}`, () => {
        const open = openModel(value, opts, none);
        const closed = closedModel(value, currentLabel(opts, value), none);
        expect(closed.selected).toBe(open.selected);
        expect(shownLabel(closed)).toBe(shownLabel(open));
        // the closed select holds exactly one entry
        expect(closed.head.length + closed.near.length + closed.far.length).toBe(1);
      });
    }
  }
  it('the open model is the old layout: various, nothing, missing, then the two groups', () => {
    const m = openModel(null, opts, 'nothing');
    expect(m.head.map((h) => h.label)).toEqual(['various', 'nothing']);
    expect(m.head[0]!.disabled).toBe(true);
    expect(m.near.map((o) => o.id)).toEqual(['a']);
    expect(m.far.map((o) => o.id)).toEqual(['b', 'c']);
    expect(openModel('gone', opts, 'nothing').head.map((h) => h.label)).toEqual(['nothing', 'missing clip']);
    expect(openModel('a', opts, 'nothing').head.map((h) => h.label)).toEqual(['nothing']);
  });
  it('currentLabel is null for nothing, mixed and unknown ids', () => {
    expect(currentLabel(opts, '')).toBeNull();
    expect(currentLabel(opts, null)).toBeNull();
    expect(currentLabel(opts, 'zzz')).toBeNull();
    expect(currentLabel(opts, 'c')).toBe('cam');
  });
});
