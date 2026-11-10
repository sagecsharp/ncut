import { describe, expect, it } from 'vitest';
import type { Project } from '../../types';
import { neededImageAssets } from './imageWindow';

const project = {
  clips: [
    { id: 'a', type: 'image', assetId: 'imgA', start: 0, duration: 4 },
    { id: 'b', type: 'image', assetId: 'imgB', start: 4, duration: 4 },
    { id: 'v', type: 'video', assetId: 'vid', start: 0, duration: 4 },
  ],
} as unknown as Project;

describe('neededImageAssets', () => {
  it('covers the lookahead and the linger around each image clip', () => {
    expect([...neededImageAssets(project, 3, new Map(), 1.5, 0.25)].sort()).toEqual(['imgA', 'imgB']);
    expect([...neededImageAssets(project, 20, new Map(), 1.5, 0.25)]).toEqual([]);
    expect([...neededImageAssets(project, 8.2, new Map(), 1.5, 0.25)]).toEqual(['imgB']);
  });
  it('keeps the outgoing image for its transition hold', () => {
    const t = 8 + 1;
    expect(neededImageAssets(project, t, new Map(), 1.5, 0.25).has('imgB')).toBe(false);
    expect(neededImageAssets(project, t, new Map([['b', { before: 0, after: 1.5 }]]), 1.5, 0.25).has('imgB')).toBe(true);
  });
  it('keeps the incoming image from before its start by the hold', () => {
    const t = 4 - 1.5 - 0.5;
    expect(neededImageAssets(project, t, new Map(), 1.5, 0.25).has('imgB')).toBe(false);
    expect(neededImageAssets(project, t, new Map([['b', { before: 1, after: 0 }]]), 1.5, 0.25).has('imgB')).toBe(true);
  });
});
