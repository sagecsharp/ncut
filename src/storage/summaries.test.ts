import { describe, expect, it } from 'vitest';
import type { ProjectSummary } from '../types';
import { decodeSummary, encodeSummary, pruneSummaries, readSummary, removeSummary, sortSummaries, summaryKey, writeSummary, writeSummaryIfMissing, type StorageLike } from './summaries';

function memory(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
  };
}

const sum = (id: string, over: Partial<ProjectSummary> = {}): ProjectSummary => ({
  id,
  name: 'a project',
  createdAt: 1,
  updatedAt: 2,
  width: 1920,
  height: 1080,
  fps: 30,
  duration: 12.5,
  clipCount: 4,
  ...over,
});

describe('summaries', () => {
  it('round-trips a summary', () => {
    const s = sum('p1');
    expect(decodeSummary(encodeSummary(s), 'p1')).toEqual(s);
  });

  it('does not trust anything malformed or for another project', () => {
    const s = sum('p1');
    expect(decodeSummary(null, 'p1')).toBeNull();
    expect(decodeSummary('nope', 'p1')).toBeNull();
    expect(decodeSummary(encodeSummary(s), 'p2')).toBeNull();
    expect(decodeSummary(JSON.stringify({ v: 2, s }), 'p1')).toBeNull();
    expect(decodeSummary(JSON.stringify({ v: 1, s: { ...s, fps: 'x' } }), 'p1')).toBeNull();
    expect(decodeSummary(JSON.stringify({ v: 1, s: { ...s, name: 5 } }), 'p1')).toBeNull();
    expect(decodeSummary(JSON.stringify({ v: 1, s: { ...s, clipCount: undefined } }), 'p1')).toBeNull();
    expect(decodeSummary(JSON.stringify({ v: 1 }), 'p1')).toBeNull();
  });

  it('writes, reads and removes', () => {
    const st = memory();
    expect(writeSummary(sum('p1'), st)).toBe(true);
    expect(readSummary('p1', st)).toEqual(sum('p1'));
    removeSummary('p1', st);
    expect(readSummary('p1', st)).toBeNull();
  });

  it('a failed write leaves no old summary behind', () => {
    const st = memory();
    writeSummary(sum('p1', { updatedAt: 1 }), st);
    st.setItem = () => {
      throw new Error('quota');
    };
    expect(writeSummary(sum('p1', { updatedAt: 9 }), st)).toBe(false);
    expect(readSummary('p1', st)).toBeNull();
  });

  it('writeSummaryIfMissing keeps a summary that is already there', () => {
    const st = memory();
    writeSummary(sum('p1', { updatedAt: 9 }), st);
    writeSummaryIfMissing(sum('p1', { updatedAt: 1 }), st);
    expect(readSummary('p1', st)?.updatedAt).toBe(9);
    writeSummaryIfMissing(sum('p2'), st);
    expect(readSummary('p2', st)).toEqual(sum('p2'));
  });

  it('prunes only summaries of unknown projects', () => {
    const st = memory();
    writeSummary(sum('p1'), st);
    writeSummary(sum('p2'), st);
    st.setItem('ncut.poster.p3', 'data:image/jpeg;base64,xx');
    expect(pruneSummaries(['p1'], st)).toBe(1);
    expect(readSummary('p1', st)).not.toBeNull();
    expect(readSummary('p2', st)).toBeNull();
    expect(st.getItem('ncut.poster.p3')).not.toBeNull();
    expect(st.getItem(summaryKey('p1'))).not.toBeNull();
  });

  it('sorts newest first and keeps id order for equal times', () => {
    const list = [sum('b', { updatedAt: 5 }), sum('c', { updatedAt: 9 }), sum('a', { updatedAt: 5 }), sum('d', { updatedAt: 1 })];
    expect(sortSummaries(list).map((s) => s.id)).toEqual(['c', 'a', 'b', 'd']);
  });

  it('does nothing without storage', () => {
    expect(readSummary('p1', null)).toBeNull();
    expect(writeSummary(sum('p1'), null)).toBe(false);
    expect(pruneSummaries([], null)).toBe(0);
  });
});
