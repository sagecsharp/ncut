import { beforeEach, describe, expect, it } from 'vitest';
import type { Clip, EffectClip, ImageClip, MediaAsset, Project } from '../types';
import { DEFAULT_TRANSFORM } from '../types';
import { createProject } from '../lib/factory';
import { useEditor } from './editorStore';

const ed = () => useEditor.getState();
const proj = (): Project => ed().project!;
const clipOf = <T extends Clip>(id: string): T => proj().clips.find((c) => c.id === id) as T;

const asset = (id: string, name = id): MediaAsset => ({ id, name, kind: 'image', mime: 'image/png', size: 1, duration: 0, width: 100, height: 100, hasAudio: false, createdAt: 0 });
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
const fx = (trackId: string, id: string, target: string | null, start = 0, duration = 4): EffectClip => ({
  id,
  type: 'effect',
  trackId,
  start,
  duration,
  name: id,
  fadeIn: 0,
  fadeOut: 0,
  effect: 'shake',
  params: {},
  amount: 1,
  seed: 1,
  target,
});

function open(make: (a: string, b: string) => Clip[], assets = [asset('img1'), asset('img2')]): [string, string] {
  const p = createProject('r9');
  const a = p.tracks[0]!.id;
  ed().openProject({ ...p, assets, clips: [] });
  const b = ed().addTrack('video');
  useEditor.setState({ project: { ...proj(), clips: make(a, b) }, past: [], future: [] });
  return [a, b];
}

beforeEach(() => {
  useEditor.setState({ project: null, selection: [], past: [], future: [], clipboard: [] });
});

describe('split keeps links between right halves', () => {
  it('points a cut child at the cut parent right half', () => {
    open((a, b) => [image(a, 'child', 0, 4, { parent: 'p', lookTarget: 'p' }), image(b, 'p', 0, 4)]);
    const made = ed().splitClips(2, ['child', 'p']);
    expect(made).toHaveLength(2);
    const [childRight, parentRight] = made;
    expect(clipOf<ImageClip>(childRight!).parent).toBe(parentRight);
    expect(clipOf<ImageClip>(childRight!).lookTarget).toBe(parentRight);
    expect(clipOf<ImageClip>('child').parent).toBe('p');
  });

  it('keeps the link when the parent was not cut', () => {
    open((a, b) => [image(a, 'child', 0, 4, { parent: 'p' }), image(b, 'p', 0, 4)]);
    const made = ed().splitClips(2, ['child']);
    expect(clipOf<ImageClip>(made[0]!).parent).toBe('p');
  });
});

describe('split cuts the effects on the clip', () => {
  it('cuts an effect on the clip and the right half follows the right half', () => {
    open((a, b) => [fx(a, 'fx', 'x'), image(b, 'x', 0, 4)]);
    const made = ed().splitClips(2, ['x']);
    // the right halves of the asked clips first, then the extra effect halves
    expect(made).toHaveLength(2);
    const [xr, fxr] = made;
    expect(clipOf<EffectClip>(fxr!).type).toBe('effect');
    expect(clipOf<EffectClip>(fxr!).target).toBe(xr);
    expect(clipOf<EffectClip>(fxr!).start).toBe(2);
    expect(clipOf<EffectClip>('fx').duration).toBe(2);
    expect(clipOf<EffectClip>('fx').target).toBe('x');
  });

  it('is one undo step', () => {
    open((a, b) => [fx(a, 'fx', 'x'), image(b, 'x', 0, 4)]);
    ed().splitClips(2, ['x']);
    expect(ed().past).toHaveLength(1);
    ed().undo();
    expect(proj().clips).toHaveLength(2);
  });

  it('leaves effects that are off screen or on other clips alone', () => {
    open((a, b) => [fx(a, 'late', 'x', 3, 1), fx(a, 'other', 'y', 5, 2), image(b, 'x', 0, 4), image(b, 'y', 5, 2)]);
    expect(ed().splitClips(2, ['x'])).toHaveLength(1);
    expect(proj().clips.filter((c) => c.type === 'effect')).toHaveLength(2);
  });

  it('skips an effect on a locked track', () => {
    const [a] = open((a, b) => [fx(a, 'fx', 'x'), image(b, 'x', 0, 4)]);
    ed().updateTrack(a, { locked: true });
    expect(ed().splitClips(2, ['x'])).toHaveLength(1);
    expect(clipOf<EffectClip>('fx').duration).toBe(4);
  });

  it('an effect already in the list is cut once', () => {
    open((a, b) => [fx(a, 'fx', 'x'), image(b, 'x', 0, 4)]);
    const made = ed().splitClips(2, ['x', 'fx']);
    expect(made).toHaveLength(2);
    expect(proj().clips).toHaveLength(4);
  });
});

describe('replaceClipAsset names', () => {
  it('takes the new name when the clip still had the old asset name', () => {
    open((a) => [image(a, 'x', 0, 2, { name: 'img1' })], [asset('img1', 'img1'), asset('img2', 'second')]);
    expect(ed().replaceClipAsset('x', 'img2')).toBe(true);
    expect(clipOf('x').name).toBe('second');
  });

  it('takes the new name when the clip has no name', () => {
    open((a) => [image(a, 'x', 0, 2, { name: '' })], [asset('img1'), asset('img2', 'second')]);
    ed().replaceClipAsset('x', 'img2');
    expect(clipOf('x').name).toBe('second');
  });

  it('keeps a name the user gave', () => {
    open((a) => [image(a, 'x', 0, 2, { name: 'my shot' })], [asset('img1'), asset('img2', 'second')]);
    ed().replaceClipAsset('x', 'img2');
    expect(clipOf('x').name).toBe('my shot');
  });
});
