import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseCube, writeCube } from '../lib/cube';
import type { Clip, MediaAsset } from '../types';
import { dropLuts, loadLutTables, lutProblem, lutTableOf, onLutChange, putLut, requestLut, usedLutIds } from './lutTables';

const text = writeCube({ title: 't', size: 2, sample: (r, g, b) => [r, g, b] });
function blobOf(t: string): { blob: Blob; texts: ReturnType<typeof vi.fn> } {
  const texts = vi.fn(async () => t);
  return { blob: { text: texts } as unknown as Blob, texts };
}

beforeEach(() => dropLuts(new Set()));

describe('lutTables', () => {
  it('one parse, one shared promise', async () => {
    const { blob, texts } = blobOf(text);
    const a = requestLut('m1', () => blob);
    const b = requestLut('m1', () => blob);
    expect(b).toBe(a);
    const t = await a;
    expect(t?.key).toBe('m1');
    expect(await requestLut('m1', () => blob)).toBe(t);
    expect(texts).toHaveBeenCalledTimes(1);
    expect(lutTableOf('m1')).toBe(t);
  });
  it('a broken file notes the problem', async () => {
    const { blob, texts } = blobOf('LUT_3D_SIZE 2\n0 0 0\n');
    const heard = vi.fn();
    const off = onLutChange(heard);
    expect(await requestLut('bad', () => blob)).toBeNull();
    expect(lutProblem('bad')).toBe('the file has 1 rows of numbers, a 2 point lut has 8');
    expect(heard).toHaveBeenCalledTimes(1);
    expect(await requestLut('bad', () => blob)).toBeNull();
    expect(texts).toHaveBeenCalledTimes(1);
    off();
  });
  it('a file that cannot be read notes a lowercase reason', async () => {
    const blob = { text: async () => Promise.reject(new Error('The requested file could not be read')) } as unknown as Blob;
    expect(await requestLut('x', () => blob)).toBeNull();
    expect(lutProblem('x')).toBe('the file could not be read');
  });
  it('no blob: null, no problem, no parse', async () => {
    expect(await requestLut('none', () => undefined)).toBeNull();
    expect(lutProblem('none')).toBeNull();
    expect(lutTableOf('none')).toBeNull();
  });
  it('putLut primes', async () => {
    const heard = vi.fn();
    const off = onLutChange(heard);
    const t = putLut('p', parseCube(text));
    expect(t.key).toBe('p');
    expect(lutTableOf('p')).toBe(t);
    expect(heard).toHaveBeenCalledTimes(1);
    const { blob, texts } = blobOf(text);
    expect(await requestLut('p', () => blob)).toBe(t);
    expect(texts).not.toHaveBeenCalled();
    off();
  });
  it('dropLuts keeps the given ids', async () => {
    putLut('a', parseCube(text));
    putLut('b', parseCube(text));
    await requestLut('c', () => blobOf('nope').blob);
    expect(lutProblem('c')).not.toBeNull();
    dropLuts(new Set(['a']));
    expect(lutTableOf('a')).not.toBeNull();
    expect(lutTableOf('b')).toBeNull();
    expect(lutProblem('c')).toBeNull();
  });
  it('a loaded map outlives dropLuts', async () => {
    const map = await loadLutTables(['m'], () => blobOf(text).blob);
    dropLuts(new Set());
    expect(lutTableOf('m')).toBeNull();
    expect(map.get('m')?.size3).toBe(2);
  });
  it('loadLutTables warns once and leaves it out', async () => {
    const warn = vi.fn();
    const map = await loadLutTables(['ok', 'gone', 'gone'], (id) => (id === 'ok' ? blobOf(text).blob : undefined), warn, (id) => `${id}.cube`);
    expect([...map.keys()]).toEqual(['ok']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('could not read the lut "gone.cube", its clips are exported without it');
  });
  it('the key is the media id', async () => {
    const map = await loadLutTables(['k1'], () => blobOf(text).blob);
    expect(map.get('k1')?.key).toBe('k1');
  });
});

describe('usedLutIds', () => {
  const asset = (id: string, kind: MediaAsset['kind']): MediaAsset => ({ id, name: id, kind, mime: '', size: 0, duration: 0, width: 0, height: 0, hasAudio: false, createdAt: 0 });
  const clip = (id: string, grade: unknown): Clip => ({ id, type: 'image', trackId: 't', start: 0, duration: 1, grade }) as unknown as Clip;
  it('lists the lut media the grades name, in clip order', () => {
    const clips = [clip('c1', { lut: { media: 'l2' } }), clip('c2', { lut: { media: 'v' } }), clip('c3', { lut: { media: 'l1' } }), clip('c4', { lut: { media: 'gone' } }), clip('c5', { lut: { media: 'l2' } })];
    const assets = [asset('l1', 'lut'), asset('l2', 'lut'), asset('l3', 'lut'), asset('v', 'video')];
    expect(usedLutIds({ clips, assets })).toEqual(['l2', 'l1']);
    expect(usedLutIds({ clips: [], assets })).toEqual([]);
  });
});
