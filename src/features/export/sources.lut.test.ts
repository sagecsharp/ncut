import { describe, expect, it, vi } from 'vitest';
import type { Project } from '../../types';
import { writeCube } from '../../lib/cube';
import { dropLuts } from '../../media/lutTables';
import { loadExportLuts } from './sources';

const text = writeCube({ title: '', size: 2, sample: (r, g, b) => [r, g, b] });
const blob = { text: async () => text } as unknown as Blob;
const asset = (id: string, kind: string) => ({ id, name: `${id}.${kind}`, kind, mime: '', size: 0, duration: 0, width: 0, height: 0, hasAudio: false, createdAt: 0 });
const clip = (id: string, media: string) => ({ id, type: 'image', trackId: 't', assetId: 'img', start: 0, duration: 1, grade: { lut: { media } } });

describe('loadExportLuts', () => {
  it('reads only lut media used by grades', async () => {
    dropLuts(new Set());
    const project = {
      clips: [clip('c1', 'used'), clip('c2', 'vid'), clip('c3', 'gone')],
      assets: [asset('used', 'lut'), asset('unused', 'lut'), asset('vid', 'video'), asset('img', 'image')],
    } as unknown as Project;
    const blobOf = vi.fn((_id: string) => blob);
    const onWarning = vi.fn();
    const map = await loadExportLuts({ project, blobOf, onWarning });
    expect([...map.keys()]).toEqual(['used']);
    expect(blobOf.mock.calls.map((c) => c[0])).toEqual(['used']);
    expect(onWarning).not.toHaveBeenCalled();
  });
  it('a lut whose file is missing is left out with one warning', async () => {
    dropLuts(new Set());
    const project = { clips: [clip('c1', 'l'), clip('c2', 'l')], assets: [asset('l', 'lut')] } as unknown as Project;
    const onWarning = vi.fn();
    const map = await loadExportLuts({ project, blobOf: () => undefined, onWarning });
    expect(map.size).toBe(0);
    expect(onWarning).toHaveBeenCalledTimes(1);
    expect(onWarning).toHaveBeenCalledWith('could not read the lut "l.lut", its clips are exported without it');
  });
});
