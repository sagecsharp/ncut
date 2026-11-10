import { beforeEach, describe, expect, it } from 'vitest';
import type { CameraClip, Clip, ImageClip, Project } from '../types';
import { DEFAULT_TRANSFORM } from '../types';
import { createCameraClip, createProject } from '../lib/factory';
import { childrenOf, expandGroups, parentChain, parentOf, wouldCycle } from '../lib/links';
import { useEditor } from './editorStore';

const ed = () => useEditor.getState();
const proj = (): Project => ed().project!;
const clipOf = <T extends Clip>(id: string): T => proj().clips.find((c) => c.id === id) as T;

function open(make: (v: string) => Clip[] = () => []): string {
  const p = createProject('r6');
  const v = p.tracks[0]!.id;
  ed().openProject({
    ...p,
    assets: [{ id: 'img', name: 'img', kind: 'image', mime: 'image/png', size: 1, duration: 0, width: 100, height: 100, hasAudio: false, createdAt: 0 }],
    clips: make(v),
  });
  return v;
}

function image(trackId: string, id: string, start: number, duration: number, over: Partial<ImageClip> = {}): ImageClip {
  return { id, type: 'image', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'img', transform: { ...DEFAULT_TRANSFORM }, ...over };
}

beforeEach(() => {
  useEditor.setState({ project: null, selection: [], past: [], future: [], clipboard: [] });
});

describe('links (pure)', () => {
  const clips: Clip[] = [
    image('t', 'a', 0, 1),
    image('t', 'b', 1, 1, { parent: 'a' }),
    image('t', 'c', 2, 1, { parent: 'b' }),
    image('t', 'self', 3, 1, { parent: 'self' }),
    image('t', 'lost', 4, 1, { parent: 'nope' }),
    image('t', 'x', 5, 1, { parent: 'y' }),
    image('t', 'y', 6, 1, { parent: 'x' }),
  ];
  const p = { clips };
  const get = (id: string) => clips.find((c) => c.id === id)!;

  it('finds parents and chains', () => {
    expect(parentOf(p, get('a'))).toBeNull();
    expect(parentOf(p, get('b'))?.id).toBe('a');
    expect(parentChain(p, get('c')).map((c) => c.id)).toEqual(['b', 'a']);
    expect(childrenOf(p, 'a').map((c) => c.id)).toEqual(['b']);
  });

  it('treats bad links as no parent and survives loops', () => {
    expect(parentOf(p, get('self'))).toBeNull();
    expect(parentOf(p, get('lost'))).toBeNull();
    expect(parentChain(p, get('x')).map((c) => c.id)).toEqual(['y']);
  });

  it('knows which links would loop', () => {
    expect(wouldCycle(p, 'a', 'a')).toBe(true);
    expect(wouldCycle(p, 'a', 'c')).toBe(true);
    expect(wouldCycle(p, 'a', 'b')).toBe(true);
    expect(wouldCycle(p, 'c', 'a')).toBe(false);
    expect(wouldCycle(p, 'a', 'lost')).toBe(false);
  });

  it('expands ids to whole groups', () => {
    const g: Clip[] = [image('t', 'a', 0, 1, { group: 'g1' }), image('t', 'b', 1, 1, { group: 'g1' }), image('t', 'c', 2, 1), image('t', 'd', 3, 1, { group: 'g2' })];
    expect(expandGroups({ clips: g }, ['b'])).toEqual(['a', 'b']);
    expect(expandGroups({ clips: g }, ['c'])).toEqual(['c']);
    expect(expandGroups({ clips: g }, ['d', 'a'])).toEqual(['a', 'b', 'd']);
  });
});

describe('parent links in the store', () => {
  it('sets a parent and refuses a loop', () => {
    open((v) => [image(v, 'a', 0, 1), image(v, 'b', 1, 1), image(v, 'c', 2, 1)]);
    ed().updateClip('b', { parent: 'a' });
    ed().updateClip('c', { parent: 'b' });
    expect(clipOf<ImageClip>('c').parent).toBe('b');
    const before = ed().past.length;
    ed().updateClip('a', { parent: 'c' });
    expect(clipOf<ImageClip>('a').parent).toBeUndefined();
    ed().updateClip('a', { parent: 'a' });
    expect(clipOf<ImageClip>('a').parent).toBeUndefined();
    expect(ed().past.length).toBe(before);
    ed().updateClip('c', { parent: null });
    expect(clipOf<ImageClip>('c').parent).toBeNull();
  });

  it('clears links to deleted clips and brings them back on undo', () => {
    const v = open((t) => [image(t, 'a', 0, 1), image(t, 'b', 1, 1, { parent: 'a' })]);
    const cam: CameraClip = { ...createCameraClip(v, 5), id: 'cam', target: 'a' };
    useEditor.setState({ project: { ...proj(), clips: [...proj().clips, cam] } });
    ed().deleteClips(['a']);
    expect(clipOf<ImageClip>('b').parent).toBeNull();
    expect(clipOf<CameraClip>('cam').target).toBeNull();
    ed().undo();
    expect(clipOf<ImageClip>('b').parent).toBe('a');
    expect(clipOf<CameraClip>('cam').target).toBe('a');
  });

  it('duplicating a parent with its child links the copies to each other', () => {
    open((v) => [image(v, 'a', 0, 1), image(v, 'b', 1, 1, { parent: 'a' })]);
    const made = ed().duplicateClips(['a', 'b']);
    expect(made).toHaveLength(2);
    const copies = made.map((id) => clipOf<ImageClip>(id));
    const child = copies.find((c) => c.parent)!;
    const parent = copies.find((c) => !c.parent)!;
    expect(child.parent).toBe(parent.id);
  });

  it('duplicating only the child keeps it on the original parent', () => {
    open((v) => [image(v, 'a', 0, 1), image(v, 'b', 1, 1, { parent: 'a' })]);
    const [id] = ed().duplicateClips(['b']);
    expect(clipOf<ImageClip>(id!).parent).toBe('a');
  });

  it('paste relinks parents among the pasted clips', () => {
    open((v) => [image(v, 'a', 0, 1), image(v, 'b', 1, 1, { parent: 'a' })]);
    ed().select(['a', 'b']);
    ed().copySelection();
    const made = ed().paste(10);
    const copies = made.map((id) => clipOf<ImageClip>(id));
    const child = copies.find((c) => c.parent)!;
    expect(made).toContain(child.parent);
  });
});

describe('groups', () => {
  it('groups and ungroups in one undo step each', () => {
    open((v) => [image(v, 'a', 0, 1), image(v, 'b', 1, 1), image(v, 'c', 2, 1)]);
    const g = ed().groupClips(['a', 'b']);
    expect(g).toBeTruthy();
    expect(clipOf('a').group).toBe(g);
    expect(clipOf('b').group).toBe(g);
    expect(clipOf('c').group).toBeUndefined();
    expect(expandGroups(proj(), ['a'])).toEqual(['a', 'b']);
    ed().ungroupClips(['b']);
    expect(clipOf('a').group).toBeUndefined();
    expect('group' in clipOf('a')).toBe(false);
    ed().undo();
    expect(clipOf('a').group).toBe(g);
    ed().undo();
    expect(clipOf('a').group).toBeUndefined();
  });

  it('needs two clips and does nothing for a group that already is exactly that', () => {
    open((v) => [image(v, 'a', 0, 1), image(v, 'b', 1, 1)]);
    expect(ed().groupClips(['a'])).toBeNull();
    const g = ed().groupClips(['a', 'b']);
    const steps = ed().past.length;
    expect(ed().groupClips(['a', 'b'])).toBeNull();
    expect(ed().past.length).toBe(steps);
    expect(clipOf('a').group).toBe(g);
  });

  it('copies of a whole group form a new group, a lone copy is ungrouped', () => {
    open((v) => [image(v, 'a', 0, 1), image(v, 'b', 1, 1)]);
    const g = ed().groupClips(['a', 'b']);
    const both = ed().duplicateClips(['a', 'b']);
    const g2 = clipOf(both[0]!).group;
    expect(g2).toBeTruthy();
    expect(g2).not.toBe(g);
    expect(clipOf(both[1]!).group).toBe(g2);
    const [one] = ed().duplicateClips(['a']);
    expect(clipOf(one!).group).toBeUndefined();
  });
});

describe('addClips', () => {
  it('puts clips on one new top track in one undo step', () => {
    const v = open((t) => [image(t, 'a', 0, 5)]);
    const steps = ed().past.length;
    const made = ed().addClips([image('x', 'c1', 0, 2), image('x', 'c2', 2, 2), image('x', 'c3', 6, 1)], { trackName: 'captions' });
    expect(made).toHaveLength(3);
    expect(ed().past.length).toBe(steps + 1);
    const top = proj().tracks[0]!;
    expect(top.id).not.toBe(v);
    expect(top.name).toBe('captions');
    for (const id of made) expect(clipOf(id).trackId).toBe(top.id);
    expect(made).not.toContain('c1');
    expect(ed().selection).toEqual(made);
    ed().undo();
    expect(proj().tracks).toHaveLength(2);
    expect(proj().clips).toHaveLength(1);
  });

  it('pushes overlapping clips back and drops what does not fit', () => {
    open();
    const made = ed().addClips([image('x', 'c1', 0, 2), image('x', 'c2', 1, 2), image('x', 'c3', 1.5, 1.5)]);
    expect(made).toHaveLength(2);
    const second = clipOf(made[1]!);
    expect(second.start).toBe(2);
    expect(second.duration).toBe(1);
  });

  it('refuses mixed kinds and empty input', () => {
    open();
    expect(ed().addClips([])).toEqual([]);
    const audio = { id: 'au', type: 'audio', trackId: 'x', start: 0, duration: 1, name: 'a', fadeIn: 0, fadeOut: 0, assetId: 'img', trimStart: 0, speed: 1, volume: 1, muted: false } as Clip;
    expect(ed().addClips([image('x', 'c1', 0, 1), audio])).toEqual([]);
    expect(proj().clips).toHaveLength(0);
  });

  it('without a new track uses the clip track when it is free', () => {
    const v = open((t) => [image(t, 'a', 0, 5)]);
    const made = ed().addClips([image(v, 'n1', 6, 1), image(v, 'n2', 2, 1)], { newTrack: false });
    expect(made).toHaveLength(2);
    const byStart = made.map((id) => clipOf(id)).sort((a, b) => a.start - b.start);
    // the one at 2s collides with the clip at 0..5 and goes elsewhere
    expect(byStart[0]!.trackId).not.toBe(v);
    expect(byStart[1]!.trackId).toBe(v);
  });
});
