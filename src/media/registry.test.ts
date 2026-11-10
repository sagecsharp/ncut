import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../types';

const getMediaBlobs = vi.fn<(ids: readonly string[]) => Promise<Map<string, Blob | undefined | Error>>>();
vi.mock('../storage/db', () => ({ getMediaBlobs: (ids: readonly string[]) => getMediaBlobs(ids) }));

const { hasAsset, loadProjectMedia, releaseAllAssets } = await import('./registry');

function projectWith(ids: string[]): Project {
  return { assets: ids.map((id) => ({ id })) } as unknown as Project;
}

describe('loadProjectMedia', () => {
  beforeEach(() => {
    releaseAllAssets();
    getMediaBlobs.mockReset();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => undefined }));
  });

  it('reads every file in one batched call and reports the missing ones', async () => {
    getMediaBlobs.mockResolvedValue(new Map<string, Blob | undefined | Error>([['a', new Blob(['1'])], ['b', undefined], ['c', new Error('boom')]]));
    const missing = await loadProjectMedia(projectWith(['a', 'b', 'c']));
    expect(getMediaBlobs).toHaveBeenCalledTimes(1);
    expect(getMediaBlobs).toHaveBeenCalledWith(['a', 'b', 'c']);
    expect(hasAsset('a')).toBe(true);
    expect(missing.sort()).toEqual(['b', 'c']);
  });

  it('only asks for what is not registered or already known', async () => {
    getMediaBlobs.mockResolvedValue(new Map<string, Blob | undefined | Error>([['c', new Blob(['3'])]]));
    const missing = await loadProjectMedia(projectWith(['a', 'b', 'c']), new Map([['a', new Blob(['1'])], ['b', new Blob(['2'])]]));
    expect(getMediaBlobs).toHaveBeenCalledWith(['c']);
    expect(missing).toEqual([]);
    expect(hasAsset('a') && hasAsset('b') && hasAsset('c')).toBe(true);
    getMediaBlobs.mockClear();
    expect(await loadProjectMedia(projectWith(['a', 'b', 'c']))).toEqual([]);
    expect(getMediaBlobs).not.toHaveBeenCalled();
  });

  it('counts everything as missing when the database cannot be read', async () => {
    getMediaBlobs.mockRejectedValue(new Error('no db'));
    expect((await loadProjectMedia(projectWith(['a', 'b']))).sort()).toEqual(['a', 'b']);
  });
});
