import { describe, expect, it, vi } from 'vitest';
import type { Project } from '../../types';
import { loadExportSky } from './sources';

const sky = { asset: 'a', turn: 0, brightness: 1, blur: 0 };
const assets = [{ id: 'a', kind: 'image', name: 'sky', width: 4000, height: 3000, duration: 0 }];

describe('loadExportSky', () => {
  it('does nothing for a project without a sky', async () => {
    const blobOf = vi.fn();
    const onWarning = vi.fn();
    expect(await loadExportSky({ project: { assets: [] } as unknown as Project, blobOf, onWarning })).toBeNull();
    expect(blobOf).not.toHaveBeenCalled();
    expect(onWarning).not.toHaveBeenCalled();
  });
  it('warns once and leaves the sky out when a file is missing', async () => {
    const onWarning = vi.fn();
    const project = { sky, assets, height: 1080 } as unknown as Project;
    expect(await loadExportSky({ project, blobOf: () => undefined, onWarning })).toBeNull();
    expect(onWarning).toHaveBeenCalledTimes(1);
    expect(onWarning).toHaveBeenCalledWith('could not read the sky pictures, the sky is left out');
  });
});
