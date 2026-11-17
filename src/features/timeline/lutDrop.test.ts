import { describe, expect, it } from 'vitest';
import type { Clip, Track } from '../../types';
import { lutDropTarget, lutGhostLabel } from './lutDrop';

const track = (id: string, kind: string, locked = false) => ({ id, kind, locked, name: id }) as unknown as Track;
const clip = (id: string, type: string, trackId: string, start: number, duration: number, extra: Record<string, unknown> = {}) =>
  ({ id, type, trackId, start, duration, speed: 1, ...extra }) as unknown as Clip;

const tracks = [track('v1', 'video'), track('v2', 'video', true), track('a1', 'audio')];
const clips = [
  clip('pic', 'video', 'v1', 0, 4),
  clip('img', 'image', 'v1', 4, 2),
  clip('fx', 'effect', 'v1', 6, 2, { effect: 'grade' }),
  clip('blur', 'effect', 'v1', 8, 2, { effect: 'blur' }),
  clip('cam', 'camera', 'v1', 10, 2),
  clip('locked', 'video', 'v2', 0, 4),
  clip('snd', 'audio', 'a1', 0, 4),
];
const project = { clips, tracks };

describe('lutDropTarget', () => {
  it('picture clips and grade effects take a lut', () => {
    expect(lutDropTarget(project, 'v1', 1)?.id).toBe('pic');
    expect(lutDropTarget(project, 'v1', 0)?.id).toBe('pic');
    expect(lutDropTarget(project, 'v1', 4)?.id).toBe('img');
    expect(lutDropTarget(project, 'v1', 7)?.id).toBe('fx');
  });

  it('locked, audio, camera and other effects do not', () => {
    expect(lutDropTarget(project, 'v2', 1)).toBeNull();
    expect(lutDropTarget(project, 'a1', 1)).toBeNull();
    expect(lutDropTarget(project, 'v1', 9)).toBeNull();
    expect(lutDropTarget(project, 'v1', 11)).toBeNull();
    expect(lutDropTarget(project, undefined, 1)).toBeNull();
    expect(lutDropTarget(project, 'nope', 1)).toBeNull();
    expect(lutDropTarget(project, 'v1', 12)).toBeNull();
  });

  it('the ghost label', () => {
    expect(lutGhostLabel(clips[0]!)).toBe('lut on this clip');
    expect(lutGhostLabel(clips[2]!)).toBe('lut on this grade');
  });
});
