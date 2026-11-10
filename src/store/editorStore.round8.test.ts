import { beforeEach, describe, expect, it } from 'vitest';
import type { Clip, EffectClip, ImageClip, MediaAsset, Project, TextClip } from '../types';
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

describe('effects on one clip', () => {
  const fx = (trackId: string, target: string | null): EffectClip => ({ id: 'fx', type: 'effect', trackId, start: 0, duration: 2, name: 'fx', fadeIn: 0, fadeOut: 0, effect: 'shake', params: {}, amount: 1, seed: 1, target });

  it('updateClip sets and clears the target', () => {
    open((a, b) => [fx(a, null), image(b, 'x', 0, 2)]);
    ed().updateClip('fx', { target: 'x' });
    expect(clipOf<EffectClip>('fx').target).toBe('x');
    ed().updateClip('fx', { target: null });
    expect(clipOf<EffectClip>('fx').target).toBeNull();
  });

  it('copies of a clip and its effect point at each other', () => {
    open((a, b) => [fx(a, 'x'), image(b, 'x', 0, 2)]);
    const made = ed().duplicateClips(['fx', 'x']);
    const copyFx = made.map((id) => clipOf(id)).find((c) => c.type === 'effect') as EffectClip;
    const copyX = made.map((id) => clipOf(id)).find((c) => c.type === 'image')!;
    expect(copyFx.target).toBe(copyX.id);
    // the original still points at the original
    expect(clipOf<EffectClip>('fx').target).toBe('x');
  });

  it('a copy of only the effect keeps the original target', () => {
    open((a, b) => [fx(a, 'x'), image(b, 'x', 0, 2)]);
    const made = ed().duplicateClips(['fx']);
    expect(clipOf<EffectClip>(made[0]!).target).toBe('x');
  });

  it('deleting a clip takes the effects on it along, in one undo step', () => {
    open((a, b) => [fx(a, 'x'), image(b, 'x', 0, 2)]);
    ed().deleteClips(['x']);
    expect(proj().clips).toHaveLength(0);
    ed().undo();
    expect(proj().clips.map((c) => c.id).sort()).toEqual(['fx', 'x']);
    expect(clipOf<EffectClip>('fx').target).toBe('x');
  });

  it('an effect on a locked track stays and does not turn into a layer over everything', () => {
    const [a] = open((a2, b) => [fx(a2, 'x'), image(b, 'x', 0, 2)]);
    ed().updateTrack(a, { locked: true });
    ed().deleteClips(['x']);
    expect(proj().clips.map((c) => c.id)).toEqual(['fx']);
    expect(clipOf<EffectClip>('fx').target).toBe('x');
  });

  it('cut and paste keeps the effect on the clip', () => {
    open((a, b) => [fx(a, 'x'), image(b, 'x', 0, 2)]);
    ed().select(['x'], 'replace');
    ed().cutSelection();
    expect(proj().clips).toHaveLength(0);
    const made = ed().paste(5);
    expect(made).toHaveLength(2);
    const pasted = made.map((id) => clipOf(id));
    const img = pasted.find((c) => c.type === 'image')!;
    const eff = pasted.find((c) => c.type === 'effect') as EffectClip;
    expect(eff.target).toBe(img.id);
    expect(eff.start).toBe(img.start);
  });

  it('ripple delete moves the effect with the clip it sits on, when there is room', () => {
    open((a, b) => [{ ...fx(a, 'c'), start: 4 }, image(b, 'x', 0, 2), image(b, 'y', 2, 2), image(b, 'c', 4, 2)]);
    ed().deleteClips(['y'], { ripple: true });
    expect(clipOf('c').start).toBe(2);
    expect(clipOf('fx').start).toBe(2);
    ed().undo();
    expect(clipOf('fx').start).toBe(4);
  });

  it('ripple delete leaves the effect where it is when its track has no room', () => {
    open((a, b) => [
      { ...fx(a, 'c'), start: 4 },
      { ...fx(a, null), id: 'other', start: 1, duration: 2.5 },
      image(b, 'y', 2, 2),
      image(b, 'c', 4, 2),
    ]);
    ed().deleteClips(['y'], { ripple: true });
    expect(clipOf('c').start).toBe(2);
    expect(clipOf('fx').start).toBe(4);
  });

  it('removing a track takes the effects on its clips along', () => {
    const [, b] = open((a2, b2) => [fx(a2, 'x'), image(b2, 'x', 0, 2)]);
    ed().removeTrack(b);
    expect(proj().clips).toHaveLength(0);
  });

  it('a split cuts what hangs on the clip, and the right halves point at each other', () => {
    open((a, b) => [image(a, 'child', 0, 4, { parent: 'x' }), image(b, 'x', 0, 4)]);
    const made = ed().splitClips(2, ['x']);
    expect(proj().clips).toHaveLength(4);
    const rightX = proj().clips.find((c) => c.trackId === clipOf('x').trackId && c.start === 2)!;
    const rightChild = proj().clips.find((c) => c.trackId === clipOf('child').trackId && c.start === 2) as ImageClip;
    expect(made).toContain(rightX.id);
    expect(clipOf<ImageClip>('child').parent).toBe('x');
    expect(rightChild.parent).toBe(rightX.id);
    ed().undo();
    expect(proj().clips).toHaveLength(2);
  });

  it('a running number carries on across a split and a head trim', () => {
    open((a) => [
      {
        ...fx(a, null),
        id: 'n',
        type: 'text',
        text: '{n}',
        duration: 10,
        counter: { from: 0, to: 100, decimals: 0, ease: 'linear' },
      } as unknown as Clip,
    ]);
    const made = ed().splitClips(4, ['n']);
    expect(clipOf<TextClip>('n').counter).toMatchObject({ fullDuration: 10 });
    expect(clipOf<TextClip>('n').counter?.offset ?? 0).toBe(0);
    expect(clipOf<TextClip>(made[0]!).counter).toMatchObject({ offset: 4, fullDuration: 10 });
    ed().trimClip(made[0]!, 'start', 6);
    expect(clipOf<TextClip>(made[0]!).counter).toMatchObject({ offset: 6, fullDuration: 10 });
  });

  it('a split or a head trim keeps the length the look was spread over', () => {
    open((a) => [{ ...fx(a, null), duration: 4 }]);
    const made = ed().splitClips(1, ['fx']);
    expect(clipOf<EffectClip>('fx').fullDuration).toBe(4);
    expect(clipOf<EffectClip>(made[0]!).fullDuration).toBe(4);
    ed().trimClip(made[0]!, 'start', 2);
    expect(clipOf<EffectClip>(made[0]!).fullDuration).toBe(4);
    expect(clipOf<EffectClip>(made[0]!).timeOffset).toBeCloseTo(2);
  });
});
