import { beforeEach, describe, expect, it } from 'vitest';
import type { Clip, ImageClip, MediaAsset, Project, VideoClip } from '../types';
import { DEFAULT_TRANSFORM } from '../types';
import { createProject } from '../lib/factory';
import { useEditor } from './editorStore';

const ed = () => useEditor.getState();
const proj = (): Project => ed().project!;
const clipOf = <T extends Clip>(id: string): T => proj().clips.find((c) => c.id === id) as T;

const asset = (id: string, kind: MediaAsset['kind'], duration: number): MediaAsset => ({
  id,
  name: id,
  kind,
  mime: kind === 'image' ? 'image/png' : 'video/mp4',
  size: 1,
  duration,
  width: 100,
  height: 100,
  hasAudio: kind !== 'image',
  createdAt: 0,
});

function open(make: (v: string) => Clip[]): string {
  const p = createProject('r7');
  const v = p.tracks[0]!.id;
  ed().openProject({
    ...p,
    assets: [asset('img1', 'image', 0), asset('img2', 'image', 0), asset('long', 'video', 20), asset('short', 'video', 3), asset('mid', 'video', 8)],
    clips: make(v),
  });
  return v;
}

const image = (trackId: string, id: string, start: number, over: Partial<ImageClip> = {}): ImageClip => ({
  id,
  type: 'image',
  trackId,
  start,
  duration: 2,
  name: id,
  fadeIn: 0,
  fadeOut: 0,
  assetId: 'img1',
  transform: { ...DEFAULT_TRANSFORM },
  ...over,
});

const video = (trackId: string, id: string, start: number, over: Partial<VideoClip> = {}): VideoClip => ({
  id,
  type: 'video',
  trackId,
  start,
  duration: 5,
  name: id,
  fadeIn: 0,
  fadeOut: 0,
  assetId: 'long',
  trimStart: 6,
  speed: 1,
  volume: 1,
  muted: false,
  transform: { ...DEFAULT_TRANSFORM },
  ...over,
});

beforeEach(() => {
  useEditor.setState({ project: null, selection: [], past: [], future: [], clipboard: [] });
});

describe('replaceClipAsset', () => {
  it('swaps an image and keeps the look', () => {
    open((v) => [image(v, 'a', 0, { radius: 0.5, transform: { ...DEFAULT_TRANSFORM, x: 40 } })]);
    expect(ed().replaceClipAsset('a', 'img2')).toBe(true);
    const c = clipOf<ImageClip>('a');
    expect(c.assetId).toBe('img2');
    expect(c.name).toBe('img2');
    expect(c.radius).toBe(0.5);
    expect(c.transform.x).toBe(40);
    ed().undo();
    expect(clipOf<ImageClip>('a').assetId).toBe('img1');
  });

  it('keeps the trim when the new video is long enough', () => {
    open((v) => [video(v, 'a', 0, { trimStart: 2 })]);
    expect(ed().replaceClipAsset('a', 'mid')).toBe(true);
    const c = clipOf<VideoClip>('a');
    expect(c.trimStart).toBe(2);
    expect(c.duration).toBe(5);
  });

  it('moves the trim back, then shortens the clip, for shorter media', () => {
    open((v) => [video(v, 'a', 0)]);
    expect(ed().replaceClipAsset('a', 'mid')).toBe(true);
    let c = clipOf<VideoClip>('a');
    // 8s of media, the clip wants 5s: the trim start moves from 6 back to 3
    expect(c.trimStart).toBe(3);
    expect(c.duration).toBe(5);
    expect(ed().replaceClipAsset('a', 'short')).toBe(true);
    c = clipOf<VideoClip>('a');
    expect(c.trimStart).toBe(0);
    expect(c.duration).toBe(3);
  });

  it('respects speed', () => {
    open((v) => [video(v, 'a', 0, { speed: 2, duration: 4, trimStart: 0 })]);
    // 4s at 2x needs 8s of media; the 3s asset gives 1.5s
    expect(ed().replaceClipAsset('a', 'short')).toBe(true);
    expect(clipOf<VideoClip>('a').duration).toBe(1.5);
  });

  it('refuses other kinds, the same asset, unknown ids and locked tracks', () => {
    const v = open((t) => [image(t, 'a', 0), video(t, 'b', 3)]);
    const steps = ed().past.length;
    expect(ed().replaceClipAsset('a', 'long')).toBe(false);
    expect(ed().replaceClipAsset('b', 'img1')).toBe(false);
    expect(ed().replaceClipAsset('a', 'img1')).toBe(false);
    expect(ed().replaceClipAsset('a', 'nope')).toBe(false);
    expect(ed().replaceClipAsset('nope', 'img2')).toBe(false);
    ed().updateTrack(v, { locked: true }, { skipHistory: true });
    expect(ed().replaceClipAsset('a', 'img2')).toBe(false);
    expect(ed().past.length).toBe(steps);
  });
});

describe('look targets and fog', () => {
  it('stores a look target, clears it when the target is deleted, relinks copies', () => {
    open((v) => [image(v, 'a', 0), image(v, 'b', 2)]);
    ed().updateClip('b', { lookAt: 'clip', lookTarget: 'a', threeD: true });
    expect(clipOf<ImageClip>('b').lookTarget).toBe('a');
    const made = ed().duplicateClips(['a', 'b']);
    const copies = made.map((id) => clipOf<ImageClip>(id));
    const looker = copies.find((c) => c.lookTarget)!;
    expect(made).toContain(looker.lookTarget);
    ed().deleteClips(['a']);
    expect(clipOf<ImageClip>('b').lookTarget).toBeNull();
  });

  it('sets and clears fog as one undo step each, no step for no change', () => {
    open(() => []);
    const steps = ed().past.length;
    ed().updateProject({ fog: null });
    expect(ed().past.length).toBe(steps);
    ed().updateProject({ fog: { color: '#000000', near: 500, far: 4000, amount: 1 } });
    expect(proj().fog?.far).toBe(4000);
    expect(ed().past.length).toBe(steps + 1);
    ed().updateProject({ fog: null });
    expect(proj().fog).toBeNull();
    expect(ed().past.length).toBe(steps + 2);
  });
});
