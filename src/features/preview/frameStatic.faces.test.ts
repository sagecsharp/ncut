import { describe, expect, it } from 'vitest';
import { createProject, createShapeClip } from '../../lib/factory';
import type { Project, VideoClip } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import { neededForFrame } from '../export/reach';
import { frameInfo, isStaticAt } from './frameStatic';
import { pickFreezeTarget, stillClipFrom } from './freezePlan';

const video = (trackId: string, id: string, start: number, duration: number, over: Partial<VideoClip> = {}): VideoClip => ({
  id, type: 'video', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'vid', trimStart: 0, speed: 1, volume: 1, muted: false, transform: { ...DEFAULT_TRANSFORM }, ...over,
});

/** a figure (not 3d) and a box that shows a video on its front */
function scene(): { p: Project; pic: VideoClip } {
  const p = createProject();
  const t = p.tracks.find((x) => x.kind === 'video')!;
  const pic = video(t.id, 'pic', 1, 4);
  const solid = createShapeClip(t.id, 0, { threeD: true, shape: 'box', duration: 10, faces: { front: { clip: 'pic' } } });
  p.clips.push(solid, pic);
  return { p, pic };
}

describe('frames with a picture on a side of a solid', () => {
  it('a solid is never a still frame: a video on its side changes the picture', () => {
    const { p } = scene();
    const solid = p.clips.find((c) => c.type === 'shape')!;
    expect(isStaticAt(p, solid, 2)).toBe(false);
    expect(frameInfo(p, 2).allStatic).toBe(false);
  });
  it('the video on the side is one of the videos the frame needs, and part of its key', () => {
    const { p, pic } = scene();
    expect(frameInfo(p, 2).videos.map((v) => v.id)).toEqual([pic.id]);
    expect(frameInfo(p, 2).key).not.toBe(frameInfo(p, 7).key);
    // outside its range the frame does not need it
    expect(frameInfo(p, 7).videos).toEqual([]);
  });
  it('the export asks for it like for a visible clip', () => {
    const { p, pic } = scene();
    expect(neededForFrame(p, 2).map((c) => c.id)).toContain(pic.id);
    expect(neededForFrame(p, 7).map((c) => c.id)).not.toContain(pic.id);
  });
  it('a freeze frame is not taken from a clip that is only on a side (unless it was selected)', () => {
    const { p, pic } = scene();
    expect(pickFreezeTarget(p, [], 2)).toBeNull();
    expect(pickFreezeTarget(p, [pic.id], 2)?.id).toBe(pic.id);
  });
  it('a still made from a solid video keeps its sides', () => {
    const v = video('t', 'v', 0, 5, { threeD: true, shape: 'box', faces: { top: { color: '#112233' } } });
    const still = stillClipFrom(v, v.transform, 'asset', 0, 1);
    expect(still.faces).toEqual({ top: { color: '#112233' } });
    expect(still.faces).not.toBe(v.faces);
  });
});
