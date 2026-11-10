import { beforeEach, describe, expect, it } from 'vitest';
import type { AudioClip, Clip, ImageClip, MediaAsset, Project, TextClip } from '../types';
import { DEFAULT_TRANSFORM } from '../types';
import { createProject, createTextClip } from '../lib/factory';
import { highlightIndex, highlightProgress } from '../engine/text';
import { captureLook, lookPatch } from '../features/properties/lookClipboard';
import { selectLike, selectTrackClips } from '../features/timeline/actions';
import { useEditor } from './editorStore';
import { useUi } from './ui';

const ed = () => useEditor.getState();
const proj = (): Project => ed().project!;
const clipOf = <T extends Clip>(id: string): T => proj().clips.find((c) => c.id === id) as T;
const lastToast = (): string => useUi.getState().toasts.at(-1)?.message ?? '';

const asset = (id: string): MediaAsset => ({ id, name: id, kind: 'image', mime: 'image/png', size: 1, duration: 0, width: 100, height: 100, hasAudio: false, createdAt: 0 });
const image = (trackId: string, id: string, start: number, duration: number, over: Partial<ImageClip> = {}): ImageClip => ({
  id, type: 'image', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'img1', transform: { ...DEFAULT_TRANSFORM }, ...over,
});
const audio = (trackId: string, id: string, start: number, duration: number, over: Partial<AudioClip> = {}): AudioClip =>
  ({ id, type: 'audio', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'img1', trimStart: 0, speed: 1, volume: 1, ...over }) as AudioClip;

/** tracks: [video, video, audio] */
function open(make: (t: string[]) => Clip[]): string[] {
  const p = createProject('r19');
  ed().openProject({ ...p, assets: [asset('img1')], clips: [] });
  while (proj().tracks.filter((t) => t.kind === 'video').length < 2) ed().addTrack('video');
  if (!proj().tracks.some((t) => t.kind === 'audio')) ed().addTrack('audio');
  const ids = [...proj().tracks.filter((t) => t.kind === 'video').map((t) => t.id), proj().tracks.find((t) => t.kind === 'audio')!.id];
  useEditor.setState({ project: { ...proj(), clips: make(ids) }, past: [], future: [] });
  return ids;
}

beforeEach(() => {
  useEditor.setState({ project: null, selection: [], past: [], future: [], clipboard: [] });
  useUi.setState({ toasts: [] });
});

describe('karaoke carries on across a cut', () => {
  const words = ['one', 'two', 'six', 'ten', 'fun', 'sun'];
  const lit = (c: TextClip, time: number): number => highlightIndex(words, highlightProgress(c, time - c.start));
  const karaoke = (t: string[]): Clip[] => [
    { ...createTextClip(t[0]!, 0, { text: words.join(' '), duration: 6 }), id: 'k', highlight: { color: '#ffffff', mode: 'fill' } } as TextClip,
  ];

  it('a plain clip runs through the words once', () => {
    open(karaoke);
    const k = clipOf<TextClip>('k');
    expect([0.1, 1.1, 2.1, 3.1, 4.1, 5.1].map((t) => lit(k, t))).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('both halves of a split show the word the whole clip showed at every time', () => {
    open(karaoke);
    const whole = clipOf<TextClip>('k');
    const want = [0.1, 1.1, 2.1, 2.9, 3.1, 4.1, 5.1, 5.9].map((t) => lit(whole, t));
    ed().splitClips(3, ['k']);
    const left = clipOf<TextClip>('k');
    const right = proj().clips.find((c) => c.id !== 'k') as TextClip;
    expect(left.highlight).toMatchObject({ fullDuration: 6 });
    expect(right.highlight).toMatchObject({ offset: 3, fullDuration: 6 });
    const got = [0.1, 1.1, 2.1, 2.9, 3.1, 4.1, 5.1, 5.9].map((t) => lit(t < 3 ? left : right, t));
    expect(got).toEqual(want);
    // a second cut in the right half keeps adding up
    ed().splitClips(4.5, [right.id]);
    const last = proj().clips.find((c) => c.start === 4.5) as TextClip;
    expect(last.highlight).toMatchObject({ offset: 4.5, fullDuration: 6 });
    expect(lit(last, 5.1)).toBe(5);
  });

  it('a head trim keeps the word under every frame that is left', () => {
    open(karaoke);
    const whole = clipOf<TextClip>('k');
    const want = [2.1, 3.1, 5.1].map((t) => lit(whole, t));
    ed().trimClip('k', 'start', 2);
    const k = clipOf<TextClip>('k');
    expect(k.start).toBe(2);
    expect(k.highlight).toMatchObject({ offset: 2, fullDuration: 6 });
    expect([2.1, 3.1, 5.1].map((t) => lit(k, t))).toEqual(want);
  });

  it('progress never leaves 0..1 and survives bad numbers', () => {
    expect(highlightProgress({ duration: 0, highlight: {} }, 1)).toBe(0);
    expect(highlightProgress({ duration: 4, highlight: { offset: 10, fullDuration: 4 } }, 1)).toBe(1);
    expect(highlightProgress({ duration: 4, highlight: { offset: NaN } }, 1)).toBe(0);
    expect(highlightProgress({ duration: 4 }, 1)).toBe(0.25);
  });
});

describe('paste look takes the whole text style', () => {
  it('copies the newer fields and clears them when the source has none', () => {
    const rich = {
      ...createTextClip('t', 0, { text: 'a b' }),
      stroke2: { color: '#ff0000', width: 4 },
      extrude: { depth: 20, color: '#333333', angle: 45 },
      underline: true,
      strike: true,
      hollow: true,
      backgroundPerLine: true,
      highlight: { color: '#00ff00', mode: 'word', offset: 3, fullDuration: 6 },
    } as unknown as TextClip;
    const patch = lookPatch(captureLook(rich), 'text');
    expect(patch.stroke2).toEqual({ color: '#ff0000', width: 4 });
    expect(patch.extrude).toEqual({ depth: 20, color: '#333333', angle: 45 });
    expect(patch.underline).toBe(true);
    expect(patch.strike).toBe(true);
    expect(patch.hollow).toBe(true);
    expect(patch.backgroundPerLine).toBe(true);
    // where a cut left the run is not part of the look
    expect(patch.highlight).toEqual({ color: '#00ff00', mode: 'word' });
    expect((rich.highlight as { offset?: number }).offset).toBe(3);

    const plain = createTextClip('t', 0, { text: 'c' });
    const clear = lookPatch(captureLook(plain), 'text');
    for (const k of ['stroke2', 'extrude', 'underline', 'strike', 'hollow', 'backgroundPerLine', 'highlight']) expect(clear[k]).toBeNull();
    // and none of it goes to a picture
    const toImage = lookPatch(captureLook(rich), 'image');
    expect('extrude' in toImage).toBe(false);
    expect('hollow' in toImage).toBe(false);
  });
});

describe('select like keeps groups whole', () => {
  const three = (t: string[]): Clip[] => [
    image(t[0]!, 'v1', 0, 2, { group: 'g1' }),
    audio(t[2]!, 'a1', 0, 2, { group: 'g1' }),
    image(t[0]!, 'v2', 2, 2, { group: 'g2' }),
    audio(t[2]!, 'a2', 2, 2, { group: 'g2' }),
    image(t[1]!, 'v3', 0, 2),
  ];

  it('a picture brings its grouped sound along', () => {
    open(three);
    ed().select(['v1', 'a1']);
    selectLike();
    expect([...ed().selection].sort()).toEqual(['a1', 'a2', 'v1', 'v2', 'v3']);
    expect(lastToast()).toBe('5 clips selected');
  });

  it('a group mate that only comes along does not count as "like it"', () => {
    open((t) => [image(t[0]!, 'v1', 0, 2, { group: 'g1' }), audio(t[2]!, 'a1', 0, 2, { group: 'g1' })]);
    ed().select(['v1']);
    selectLike();
    expect([...ed().selection].sort()).toEqual(['a1', 'v1']);
    expect(lastToast()).toBe('nothing else like it');
  });

  it('says so when nothing else is like it', () => {
    open((t) => [image(t[0]!, 'v1', 0, 2), audio(t[2]!, 'a1', 0, 2)]);
    ed().select(['v1']);
    selectLike();
    expect(ed().selection).toEqual(['v1']);
    expect(lastToast()).toBe('nothing else like it');
  });

  it('clips on locked tracks are left out and counted', () => {
    const t = open(three);
    ed().updateTrack(t[1]!, { locked: true });
    ed().select(['v1']);
    selectLike();
    expect(ed().selection).not.toContain('v3');
    expect(lastToast()).toContain('1 on locked tracks left out');

    open((tt) => [image(tt[0]!, 'v1', 0, 2), image(tt[1]!, 'v3', 0, 2)]);
    ed().updateTrack(proj().tracks.filter((x) => x.kind === 'video')[1]!.id, { locked: true });
    ed().select(['v1']);
    selectLike();
    expect(ed().selection).toEqual(['v1']);
    expect(lastToast()).toBe('the other clips like it are on locked tracks');
  });

  it('select track takes the group mates on other tracks too', () => {
    const t = open(three);
    selectTrackClips(t[0]!);
    expect([...ed().selection].sort()).toEqual(['a1', 'a2', 'v1', 'v2']);
  });
});
