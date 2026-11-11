import { beforeEach, describe, expect, it } from 'vitest';
import type { Clip, ImageClip, MediaAsset, Project, VisualClip } from '../types';
import { DEFAULT_TRANSFORM } from '../types';
import { createProject } from '../lib/factory';
import { useEditor } from './editorStore';
import { useUi } from './ui';

const ed = () => useEditor.getState();
const proj = (): Project => ed().project!;
const clipOf = (id: string): VisualClip => proj().clips.find((c) => c.id === id) as VisualClip;

const asset = (id: string): MediaAsset => ({ id, name: id, kind: 'image', mime: 'image/png', size: 1, duration: 0, width: 100, height: 100, hasAudio: false, createdAt: 0 });
const image = (trackId: string, id: string, start: number, duration: number, over: Partial<ImageClip> = {}): ImageClip => ({
  id, type: 'image', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'img1', transform: { ...DEFAULT_TRANSFORM }, ...over,
});

/** a solid `s` (box, 0..10) that shows pictures `a` (front, 0..10) and `b` (all the rest, 0..10); `c` is a plain clip */
function open(extra: (t: string) => Clip[] = () => []): string {
  const p = createProject('faces');
  ed().openProject({ ...p, assets: [asset('img1')], clips: [] });
  const track = proj().tracks.find((t) => t.kind === 'video')!.id;
  const clips: Clip[] = [
    image(track, 's', 0, 10, { threeD: true, shape: 'box', faces: { front: { clip: 'a' }, all: { clip: 'b', fit: 'stretch' }, top: { color: '#ff0000' } } }),
    image(track, 'a', 0, 10),
    image(track, 'b', 0, 10),
    ...extra(track),
  ];
  useEditor.setState({ project: { ...proj(), clips }, past: [], future: [] });
  return track;
}

beforeEach(() => {
  useEditor.setState({ project: null, selection: [], past: [], future: [], clipboard: [] });
  useUi.setState({ toasts: [] });
});

describe('deleting a clip that is on a side', () => {
  it('drops the side entries that name it, in one step', () => {
    open();
    ed().deleteClips(['a']);
    // front is gone (the own picture shows again), the rest stays
    expect(clipOf('s').faces).toEqual({ all: { clip: 'b', fit: 'stretch' }, top: { color: '#ff0000' } });
    expect(proj().clips.some((c) => c.id === 'a')).toBe(false);
  });
  it('one undo brings the clip and the side back together', () => {
    open();
    ed().deleteClips(['a']);
    ed().undo();
    expect(proj().clips.some((c) => c.id === 'a')).toBe(true);
    expect(clipOf('s').faces).toEqual({ front: { clip: 'a' }, all: { clip: 'b', fit: 'stretch' }, top: { color: '#ff0000' } });
  });
  it('deleting the clip under "all" leaves the named sides alone; a null entry that meant "own picture" goes with it', () => {
    open();
    useEditor.setState({ project: { ...proj(), clips: proj().clips.map((c) => (c.id === 's' ? ({ ...c, faces: { all: { clip: 'b' }, left: null, front: { clip: 'a' } } } as Clip) : c)) } });
    ed().deleteClips(['b']);
    expect(clipOf('s').faces).toEqual({ front: { clip: 'a' } });
  });
  it('removing the last fill removes the field', () => {
    open();
    useEditor.setState({ project: { ...proj(), clips: proj().clips.map((c) => (c.id === 's' ? ({ ...c, faces: { all: { clip: 'a' } } } as Clip) : c)) } });
    ed().deleteClips(['a']);
    expect('faces' in clipOf('s')).toBe(false);
  });
  it('deleting the solid itself is fine', () => {
    open();
    ed().deleteClips(['s']);
    expect(proj().clips.map((c) => c.id)).toEqual(['a', 'b']);
  });
});

describe('copies of a solid', () => {
  it('a copy shows the copy of its picture clip when both were copied', () => {
    open();
    const copies = new Map<string, string>();
    ed().duplicateClips(['s', 'a'], { sameTime: true, copies });
    const s2 = clipOf(copies.get('s')!);
    expect(s2.faces!.front).toEqual({ clip: copies.get('a')! });
    // not copied: still the original
    expect(s2.faces!.all).toEqual({ clip: 'b', fit: 'stretch' });
    expect(s2.faces!.top).toEqual({ color: '#ff0000' });
    // the original is untouched
    expect(clipOf('s').faces!.front).toEqual({ clip: 'a' });
  });
  it('the fit of a side is kept when its clip is swapped', () => {
    open();
    const copies = new Map<string, string>();
    ed().duplicateClips(['s', 'b'], { sameTime: true, copies });
    expect(clipOf(copies.get('s')!).faces!.all).toEqual({ clip: copies.get('b')!, fit: 'stretch' });
  });
  it('a copy of the solid alone keeps naming the originals', () => {
    open();
    const copies = new Map<string, string>();
    ed().duplicateClips(['s'], { sameTime: true, copies });
    expect(clipOf(copies.get('s')!).faces).toEqual(clipOf('s').faces);
  });
  it('copy and paste remap the same way', () => {
    open();
    ed().select(['s', 'a']);
    ed().copySelection();
    const made = ed().paste(20);
    const s2 = proj().clips.find((c) => made.includes(c.id) && (c as VisualClip).faces) as VisualClip;
    const a2 = made.find((id) => id !== s2.id)!;
    expect(s2.faces!.front).toEqual({ clip: a2 });
    expect(s2.faces!.all).toEqual({ clip: 'b', fit: 'stretch' });
  });
});

describe('splitting', () => {
  it('splitting a solid and its picture clip: the right half of the solid shows the right half of the picture', () => {
    open();
    const made = ed().splitClips(5, ['s', 'a']);
    expect(made).toHaveLength(2);
    const sRight = made.map(clipOf).find((c) => c.faces)!;
    const aRight = made.find((id) => id !== sRight.id)!;
    expect(sRight.faces!.front).toEqual({ clip: aRight });
    // the left halves keep the old ids
    expect(clipOf('s').faces!.front).toEqual({ clip: 'a' });
  });
  it('splitting only the picture clip cuts the solid that shows it too, so the right half is not left on screen on its own', () => {
    open();
    const made = ed().splitClips(5, ['a']);
    expect(made).toHaveLength(2);
    const sRight = made.map(clipOf).find((c) => c.faces)!;
    const aRight = made.find((id) => id !== sRight.id)!;
    expect(sRight.faces!.front).toEqual({ clip: aRight });
  });
  it('a picture clip whose solid cannot be cut with it is not cut: a half without its solid would paint on its own', () => {
    // the solid starts after the cut
    open((t) => [image(t, 's2', 6, 3, { threeD: true, shape: 'box', faces: { top: { clip: 'p2' } } }), image(t, 'p2', 2, 6)]);
    expect(ed().splitClips(4, ['p2'])).toHaveLength(0);
    expect(clipOf('p2').duration).toBe(6);
    // the solid is on a locked track
    const track = open();
    ed().addTrack('video');
    const lockedTrack = proj().tracks.find((t) => t.id !== track && t.kind === 'video')!.id;
    useEditor.setState({ project: { ...proj(), clips: proj().clips.map((c) => (c.id === 's' ? { ...c, trackId: lockedTrack } : c)) } });
    ed().updateTrack(lockedTrack, { locked: true });
    expect(ed().splitClips(5, ['a'])).toHaveLength(0);
    expect(clipOf('a').duration).toBe(10);
  });
  it('splitting only the solid leaves both halves showing the same picture clip', () => {
    open();
    const made = ed().splitClips(5, ['s']);
    expect(made).toHaveLength(1);
    expect(clipOf(made[0]!).faces!.front).toEqual({ clip: 'a' });
  });
});

describe('writing the sides through updateClip', () => {
  it('a clip that never had sides takes them, and an empty value takes the field away again', () => {
    open((t) => [image(t, 'c', 0, 10, { threeD: true, shape: 'box' })]);
    expect('faces' in clipOf('c')).toBe(false);
    ed().updateClip('c', { faces: { top: { color: '#ff0000' } } });
    expect(clipOf('c').faces).toEqual({ top: { color: '#ff0000' } });
    ed().updateClip('c', { faces: null as never });
    expect('faces' in clipOf('c')).toBe(false);
    ed().updateClip('c', { faces: { top: { clip: 'a' } } });
    ed().updateClip('c', { faces: {} });
    expect('faces' in clipOf('c')).toBe(false);
    ed().undo();
    expect(clipOf('c').faces).toEqual({ top: { clip: 'a' } });
  });
});
