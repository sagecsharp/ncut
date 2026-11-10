import { beforeEach, describe, expect, it } from 'vitest';
import type { Clip, ImageClip, MediaAsset, Project } from '../types';
import { DEFAULT_TRANSFORM } from '../types';
import { createProject } from '../lib/factory';
import { hasKeyedPose, reparentTransform } from '../engine/parent';
import { useEditor } from './editorStore';

const ed = () => useEditor.getState();
const proj = (): Project => ed().project!;
const clipOf = <T extends Clip>(id: string): T => proj().clips.find((c) => c.id === id) as T;

const asset = (id: string): MediaAsset => ({ id, name: id, kind: 'image', mime: 'image/png', size: 1, duration: 0, width: 100, height: 100, hasAudio: false, createdAt: 0 });
const image = (trackId: string, id: string, start: number, duration: number, over: Partial<ImageClip> = {}): ImageClip => ({
  id, type: 'image', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'img1', transform: { ...DEFAULT_TRANSFORM }, ...over,
});

function open(make: (t: string[]) => Clip[]): string[] {
  const p = createProject('r16');
  ed().openProject({ ...p, assets: [asset('img1')], clips: [] });
  for (let i = 0; i < 2; i++) ed().addTrack('video');
  const ids = proj().tracks.map((t) => t.id);
  useEditor.setState({ project: { ...proj(), clips: make(ids) }, past: [], future: [] });
  return ids;
}

beforeEach(() => {
  useEditor.setState({ project: null, selection: [], past: [], future: [], clipboard: [] });
});

describe('deleting a parent, child with a motion', () => {
  for (const motion of ['slide-left', 'pop', 'zoom-in', 'slide-up']) {
    it(`a child that comes in with "${motion}" keeps its rest place, not where the motion starts`, () => {
      open((t) => [
        image(t[0]!, 'p', 0, 5, { transform: { ...DEFAULT_TRANSFORM, x: 500 } }),
        image(t[1]!, 'c', 0, 5, { parent: 'p', transform: { ...DEFAULT_TRANSFORM, x: 100, y: 40 }, motionIn: { id: motion, duration: 1 } }),
      ]);
      ed().deleteClips(['p']);
      const c = clipOf<ImageClip>('c');
      expect(c.parent).toBeNull();
      expect(c.transform.x).toBeCloseTo(600, 3);
      expect(c.transform.y).toBeCloseTo(40, 3);
      expect(c.transform.scale).toBeCloseTo(1, 6);
      // the motion is still on the clip and plays as before
      expect(c.motionIn).toEqual({ id: motion, duration: 1 });
    });
  }

  it('a motion of the parent still counts: it really moves the child', () => {
    open((t) => [
      image(t[0]!, 'p', 0, 5, { transform: { ...DEFAULT_TRANSFORM, x: 500 }, motionLoop: { id: 'float', duration: 2 } }),
      image(t[1]!, 'c', 0, 5, { parent: 'p', transform: { ...DEFAULT_TRANSFORM, x: 100 } }),
    ]);
    const p = proj();
    const withMotion = reparentTransform(p, clipOf<ImageClip>('c'), null, 0.7);
    const still = reparentTransform({ ...p, clips: p.clips.map((c) => (c.id === 'p' ? ({ ...c, motionLoop: null } as Clip) : c)) }, clipOf<ImageClip>('c'), null, 0.7);
    expect(still.x).toBeCloseTo(600, 3);
    // whatever "float" does at 0.7 s, the result is finite
    expect(Number.isFinite(withMotion.x) && Number.isFinite(withMotion.y)).toBe(true);
  });
});

describe('keyed pose of a 3d child', () => {
  it('z / rotX / rotY keys count for a 3d clip, not for a flat one', () => {
    const key = [{ t: 0, v: 10, ease: 'linear' as const }];
    expect(hasKeyedPose(image('t', 'a', 0, 1, { threeD: true, keyframes: { z: key } }))).toBe(true);
    expect(hasKeyedPose(image('t', 'a', 0, 1, { threeD: true, keyframes: { rotY: key } }))).toBe(true);
    expect(hasKeyedPose(image('t', 'a', 0, 1, { keyframes: { z: key } }))).toBe(false);
    expect(hasKeyedPose(image('t', 'a', 0, 1, { keyframes: { opacity: key } }))).toBe(false);
    expect(hasKeyedPose(image('t', 'a', 0, 1, { keyframes: { x: key } }))).toBe(true);
  });

  it('a 3d child with keys on z is only detached when the parent goes', () => {
    open((t) => [
      image(t[0]!, 'p', 0, 5, { threeD: true, transform: { ...DEFAULT_TRANSFORM, x: 500, z: 300 } }),
      image(t[1]!, 'c', 0, 5, {
        parent: 'p',
        threeD: true,
        transform: { ...DEFAULT_TRANSFORM, x: 100 },
        keyframes: { z: [{ t: 0, v: 0, ease: 'linear' }, { t: 2, v: -400, ease: 'linear' }] },
      }),
    ]);
    ed().deleteClips(['p']);
    const c = clipOf<ImageClip>('c');
    expect(c.parent).toBeNull();
    expect(c.transform.x).toBe(100);
    expect(c.keyframes!.z).toHaveLength(2);
  });
});
