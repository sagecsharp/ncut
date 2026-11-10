import { beforeEach, describe, expect, it } from 'vitest';
import type { Clip, EffectClip, ImageClip, MediaAsset, Project } from '../types';
import { DEFAULT_TRANSFORM } from '../types';
import { createProject } from '../lib/factory';
import { useEditor } from './editorStore';

const ed = () => useEditor.getState();
const proj = (): Project => ed().project!;
const clipOf = <T extends Clip>(id: string): T => proj().clips.find((c) => c.id === id) as T;

const asset = (id: string): MediaAsset => ({
  id,
  name: id,
  kind: 'image',
  mime: 'image/png',
  size: 1,
  duration: 0,
  width: 100,
  height: 100,
  hasAudio: false,
  createdAt: 0,
});

const image = (trackId: string, id: string, start: number, duration: number, over: Partial<ImageClip> = {}): ImageClip => ({
  id,
  type: 'image',
  trackId,
  start,
  duration,
  name: id,
  fadeIn: 0,
  fadeOut: 0,
  assetId: 'img1',
  transform: { ...DEFAULT_TRANSFORM },
  ...over,
});

/** opens a project with two video tracks; returns their ids (top first) */
function open(make: (a: string, b: string) => Clip[]): [string, string] {
  const p = createProject('r8');
  const a = p.tracks[0]!.id;
  ed().openProject({ ...p, assets: [asset('img1'), asset('img2')], clips: [] });
  const b = ed().addTrack('video');
  useEditor.setState({ project: { ...proj(), clips: make(a, b) }, past: [], future: [] });
  return [a, b];
}

beforeEach(() => {
  useEditor.setState({ project: null, selection: [], past: [], future: [], clipboard: [] });
});

describe('split and groups', () => {
  it('gives the right halves a group of their own', () => {
    open((a, b) => [image(a, 'x', 0, 4, { group: 'g' }), image(b, 'y', 0, 4, { group: 'g' })]);
    const made = ed().splitClips(2, ['x', 'y']);
    expect(made).toHaveLength(2);
    const left = [clipOf('x'), clipOf('y')].map((c) => c.group);
    const right = made.map((id) => clipOf(id).group);
    expect(left).toEqual(['g', 'g']);
    expect(right[0]).toBeTruthy();
    expect(right[0]).toBe(right[1]);
    expect(right[0]).not.toBe('g');
  });

  it('drops a group that is left with one clip', () => {
    open((a, b) => [image(a, 'x', 0, 4, { group: 'g' }), image(b, 'y', 0, 1, { group: 'g' })]);
    // only x is under the playhead: its right half would be alone in a new group
    const made = ed().splitClips(2, ['x', 'y']);
    expect(made).toHaveLength(1);
    expect(clipOf(made[0]!).group).toBeUndefined();
    expect(clipOf('x').group).toBe('g');
    expect(clipOf('y').group).toBe('g');
  });

  it('leaves clips without a group alone', () => {
    open((a) => [image(a, 'x', 0, 4)]);
    const made = ed().splitClips(2, ['x']);
    expect(clipOf(made[0]!).group).toBeUndefined();
    expect('group' in clipOf('x')).toBe(false);
  });
});

describe('duplicate keeps timing', () => {
  it('shifts every copy by the same amount', () => {
    open((a, b) => [image(a, 'x', 0, 2), image(b, 'y', 0, 5)]);
    const made = ed().duplicateClips(['x', 'y']);
    const starts = made.map((id) => clipOf(id).start).sort();
    expect(starts).toEqual([5, 5]);
  });

  it('keeps offsets between tracks', () => {
    open((a, b) => [image(a, 'x', 1, 2), image(b, 'y', 0, 2)]);
    const made = ed().duplicateClips(['x', 'y']);
    const byTrack = new Map(made.map((id) => [clipOf(id).name, clipOf(id).start]));
    // the selection is 3s long: copies sit 3s later
    expect(byTrack.get('x')).toBe(4);
    expect(byTrack.get('y')).toBe(3);
  });

  it('moves further when a later clip is in the way, still as one', () => {
    open((a, b) => [image(a, 'x', 0, 2), image(b, 'y', 0, 2), image(b, 'wall', 2.5, 2)]);
    const made = ed().duplicateClips(['x', 'y']);
    const xs = made.map((id) => clipOf(id).start);
    expect(xs[0]).toBe(xs[1]);
    expect(xs[0]).toBe(4.5);
  });

  it('one clip still lands right after itself', () => {
    open((a) => [image(a, 'x', 1, 2)]);
    const made = ed().duplicateClips(['x']);
    expect(clipOf(made[0]!).start).toBe(3);
  });
});

describe('effect head trim', () => {
  it('keeps the effect phase', () => {
    const fx: Omit<EffectClip, 'trackId'> = { id: 'fx', type: 'effect', start: 2, duration: 4, name: 'fx', fadeIn: 0, fadeOut: 0, effect: 'shake', params: {}, amount: 1, seed: 1 };
    open((a) => [{ ...fx, trackId: a } as EffectClip]);
    ed().trimClip('fx', 'start', 3);
    const c = clipOf<EffectClip>('fx');
    expect(c.start).toBe(3);
    // effect time at t = 3.5 was 3.5 - 2 + 0 = 1.5 and still is
    expect(3.5 - c.start + (c.timeOffset ?? 0)).toBeCloseTo(1.5);
  });
});

describe('links survive removals', () => {
  it('removing a track detaches clips that pointed into it', () => {
    const [, b] = open((a, b2) => [image(a, 'child', 0, 2, { parent: 'p', lookAt: 'clip', lookTarget: 'p', threeD: true }), image(b2, 'p', 0, 2)]);
    ed().removeTrack(b);
    const c = clipOf<ImageClip>('child');
    expect(c.parent).toBeNull();
    expect(c.lookTarget).toBeNull();
    ed().undo();
    expect(clipOf<ImageClip>('child').parent).toBe('p');
  });

  it('removing an asset detaches clips that pointed at its clips', () => {
    open((a, b) => [image(a, 'child', 0, 2, { parent: 'p' }), image(b, 'p', 0, 2, { assetId: 'img2' })]);
    ed().removeAsset('img2');
    expect(proj().clips.map((c) => c.id)).toEqual(['child']);
    expect(clipOf<ImageClip>('child').parent).toBeNull();
  });

  it('removing an unused asset keeps undo and redo', () => {
    open((a) => [image(a, 'x', 0, 2)]);
    ed().updateClip('x', { name: 'renamed' });
    ed().updateClip('x', { name: 'again' });
    ed().undo();
    expect(ed().past.length).toBe(1);
    expect(ed().future.length).toBe(1);
    ed().removeAsset('img2');
    expect(proj().assets.map((x) => x.id)).toEqual(['img1']);
    expect(ed().past.length).toBe(1);
    expect(ed().future.length).toBe(1);
  });

  it('removing an asset that history still uses clears history', () => {
    open((a) => [image(a, 'x', 0, 2), image(a, 'y', 3, 2, { assetId: 'img2' })]);
    ed().deleteClips(['y']);
    expect(ed().past.length).toBe(1);
    ed().removeAsset('img2');
    expect(ed().past.length).toBe(0);
  });
});
