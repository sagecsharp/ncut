import { beforeEach, describe, expect, it } from 'vitest';
import type { AudioClip, Clip, ImageClip, MediaAsset, Project } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import { createProject } from '../../lib/factory';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { useUi } from '../../store/ui';
import { applyPath, removePath } from './pathActions';
import { DEFAULT_PATH, PATH_KINDS } from './pathMoves';
import type { PathKind, PathOptions } from './pathMoves';

const ed = () => useEditor.getState();
const proj = (): Project => ed().project!;
const clipOf = <T extends Clip>(id: string): T => proj().clips.find((c) => c.id === id) as T;
const lastToast = (): string => useUi.getState().toasts.at(-1)?.message ?? '';
const path = (over: Partial<PathOptions> = {}): PathOptions => ({ ...DEFAULT_PATH, ...over });
const lin = (...pairs: [number, number][]) => pairs.map(([t, v]) => ({ t, v, ease: 'linear' as const }));

const asset = (id: string): MediaAsset => ({ id, name: id, kind: 'image', mime: 'image/png', size: 1, duration: 0, width: 100, height: 100, hasAudio: false, createdAt: 0 });
const image = (trackId: string, id: string, start: number, duration: number, over: Partial<ImageClip> = {}): ImageClip => ({
  id, type: 'image', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'img1', transform: { ...DEFAULT_TRANSFORM }, ...over,
});

function open(make: (t: string[]) => Clip[]): string[] {
  const p = createProject('r17');
  ed().openProject({ ...p, assets: [asset('img1')], clips: [] });
  ed().addTrack('video');
  const ids = proj().tracks.map((t) => t.id);
  useEditor.setState({ project: { ...proj(), clips: make(ids) }, past: [], future: [] });
  return ids;
}

function oneStep(run: () => void): void {
  const before = proj();
  run();
  const after = proj();
  expect(ed().past.length).toBe(1);
  ed().undo();
  expect(proj()).toEqual(before);
  ed().redo();
  expect(proj()).toEqual(after);
}

beforeEach(() => {
  useEditor.setState({ project: null, selection: [], past: [], future: [], clipboard: [] });
  useUi.setState({ toasts: [] });
  usePlayback.setState({ time: 0 });
});

describe('applyPath', () => {
  it('every kind on a flat clip writes x / y (hop only y), one undo step', () => {
    for (const { id } of PATH_KINDS) {
      open((t) => [image(t[0]!, 'a', 0, 4, { transform: { ...DEFAULT_TRANSFORM, x: 50, y: 20 } })]);
      oneStep(() => expect(applyPath('a', path({ kind: id }))).toBe(true));
      const kf = clipOf('a').keyframes!;
      expect(Object.keys(kf).sort()).toEqual(id === 'hop' ? ['y'] : ['x', 'y']);
      // the first point is the pose the clip had
      expect(kf.y![0]!.v).toBeCloseTo(20, 2);
      if (id !== 'hop') expect(kf.x![0]!.v).toBeCloseTo(50, 2);
      expect(kf.y![0]!.t).toBe(0);
      expect(kf.y!.at(-1)!.t).toBe(4);
      expect(lastToast()).toBe('path added');
    }
  });

  it('a 3d clip moves in x / z (spiral also y, hop only y)', () => {
    const want: Record<PathKind, string[]> = { circle: ['x', 'z'], eight: ['x', 'z'], spiral: ['x', 'y', 'z'], swing: ['x', 'y'], hop: ['y'], zigzag: ['x', 'z'], drift: ['x', 'z'] };
    for (const { id } of PATH_KINDS) {
      open((t) => [image(t[0]!, 'a', 0, 4, { threeD: true })]);
      applyPath('a', path({ kind: id }));
      expect(Object.keys(clipOf('a').keyframes!).sort()).toEqual(want[id]);
    }
  });

  it('face: rotation on a flat clip, rotY on a 3d clip (swing tilts in rotation), never for hop', () => {
    const run = (over: Partial<ImageClip>, kind: PathKind, face: boolean) => {
      open((t) => [image(t[0]!, 'a', 0, 4, over)]);
      applyPath('a', path({ kind, face }));
      return Object.keys(clipOf('a').keyframes!).sort();
    };
    expect(run({}, 'circle', true)).toEqual(['rotation', 'x', 'y']);
    expect(run({}, 'circle', false)).toEqual(['x', 'y']);
    expect(run({ threeD: true }, 'circle', true)).toEqual(['rotY', 'x', 'z']);
    expect(run({ threeD: true }, 'swing', true)).toEqual(['rotation', 'x', 'y']);
    expect(run({}, 'hop', true)).toEqual(['y']);
  });

  it('a clip with x / y keys: they are replaced and the toast says so, opacity keys stay', () => {
    const opacity = lin([0, 0], [1, 1]);
    open((t) => [image(t[0]!, 'a', 0, 4, { keyframes: { x: lin([0, 10], [2, 90]), y: lin([0, 5], [2, 6]), opacity } })]);
    oneStep(() => applyPath('a', path({ kind: 'circle' })));
    const kf = clipOf('a').keyframes!;
    expect(kf.opacity).toEqual(opacity);
    expect(kf.x![0]!.v).toBeCloseTo(10, 2);
    expect(kf.x!.length).toBeGreaterThan(2);
    expect(lastToast()).toBe('path replaced the keys on x / y');
  });

  it('applying the same path twice gives the same keys and no second undo step', () => {
    open((t) => [image(t[0]!, 'a', 1, 4)]);
    applyPath('a', path({ kind: 'eight' }));
    const first = clipOf('a').keyframes;
    applyPath('a', path({ kind: 'eight' }));
    expect(clipOf('a').keyframes).toEqual(first);
    expect(ed().past.length).toBe(1);
  });

  it('applying another kind over a path replaces it, one more step', () => {
    open((t) => [image(t[0]!, 'a', 0, 4)]);
    applyPath('a', path({ kind: 'circle' }));
    applyPath('a', path({ kind: 'hop' }));
    expect(ed().past.length).toBe(2);
    expect(Object.keys(clipOf('a').keyframes!)).toContain('y');
    expect(lastToast()).toBe('path replaced the keys on y');
  });

  it('laps are held to 0.25 .. 10 and a path never has more than 240 keys', () => {
    open((t) => [image(t[0]!, 'a', 0, 40)]);
    applyPath('a', path({ turns: 1000 }));
    const many = clipOf('a').keyframes!.x!;
    expect(many.length).toBeLessThanOrEqual(240);
    expect(many.at(-1)!.t).toBe(40);
    // 10 laps come back to the start
    expect(many.at(-1)!.v).toBeCloseTo(many[0]!.v, 2);
    applyPath('a', path({ turns: 0 }));
    const few = clipOf('a').keyframes!.x!;
    // a quarter lap of a circle ends a radius to the side
    expect(few.at(-1)!.v - few[0]!.v).toBeCloseTo(200, 2);
    expect(many.length).toBeGreaterThan(few.length);
  });

  it('a very short clip (2 frames) still gets sorted keys that end on its length', () => {
    const two = 2 / 30;
    open((t) => [image(t[0]!, 'a', 0, two)]);
    expect(applyPath('a', path({ kind: 'circle' }))).toBe(true);
    const x = clipOf('a').keyframes!.x!;
    expect(x.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < x.length; i++) expect(x[i]!.t).toBeGreaterThan(x[i - 1]!.t);
    expect(x.at(-1)!.t).toBeCloseTo(two, 6);
  });

  it('a clip too short for a path: toast, no step', () => {
    open((t) => [image(t[0]!, 'a', 0, 0.001)]);
    expect(applyPath('a', path())).toBe(false);
    expect(lastToast()).toBe('this clip is too short for a path');
    expect(ed().past.length).toBe(0);
  });

  it('a locked track: nothing changes and the toast says why', () => {
    const t = open((t) => [image(t[0]!, 'a', 0, 4)]);
    ed().updateTrack(t[0]!, { locked: true }, { skipHistory: true });
    const before = proj();
    expect(applyPath('a', path())).toBe(false);
    expect(proj()).toBe(before);
    expect(ed().past.length).toBe(0);
    expect(lastToast()).toBe('this clip is on a locked track: unlock it to change its path');
  });

  it('an audio clip or an unknown id is refused without a step', () => {
    const audio: AudioClip = { id: 'au', type: 'audio', trackId: '', start: 0, duration: 2, name: 'au', fadeIn: 0, fadeOut: 0, assetId: 'img1', trimStart: 0, speed: 1, volume: 1, muted: false };
    open((t) => [{ ...audio, trackId: t[0]! }]);
    expect(applyPath('au', path())).toBe(false);
    expect(applyPath('nope', path())).toBe(false);
    expect(ed().past.length).toBe(0);
  });
});

describe('removePath', () => {
  it('takes the position keys off and leaves the clip at its start pose, one undo step', () => {
    open((t) => [image(t[0]!, 'a', 2, 4, { transform: { ...DEFAULT_TRANSFORM, x: 50, y: 20 } })]);
    applyPath('a', path({ kind: 'circle' }));
    useEditor.setState({ past: [], future: [] });
    // the playhead somewhere else does not matter: the clip rests at local 0
    usePlayback.setState({ time: 4 });
    oneStep(() => expect(removePath('a')).toBe(true));
    const c = clipOf<ImageClip>('a');
    expect(c.keyframes).toBeUndefined();
    expect(c.transform.x).toBeCloseTo(50, 2);
    expect(c.transform.y).toBeCloseTo(20, 2);
    expect(lastToast()).toBe('path removed');
  });

  it('keeps the face keys and the other keys', () => {
    const opacity = lin([0, 0], [1, 1]);
    open((t) => [image(t[0]!, 'a', 0, 4, { keyframes: { opacity } })]);
    applyPath('a', path({ face: true }));
    removePath('a');
    expect(Object.keys(clipOf('a').keyframes!).sort()).toEqual(['opacity', 'rotation']);
    expect(clipOf('a').keyframes!.opacity).toEqual(opacity);
  });

  it('a 3d clip: z goes back to its start value too', () => {
    open((t) => [image(t[0]!, 'a', 0, 4, { threeD: true, transform: { ...DEFAULT_TRANSFORM, z: 30 } })]);
    applyPath('a', path({ kind: 'spiral', size: 100 }));
    removePath('a');
    const c = clipOf<ImageClip>('a');
    expect(c.transform.z).toBeCloseTo(30, 2);
    expect(c.keyframes).toBeUndefined();
  });

  it('no position keys: a toast, no step', () => {
    open((t) => [image(t[0]!, 'a', 0, 4, { keyframes: { opacity: lin([0, 0], [1, 1]) } })]);
    expect(removePath('a')).toBe(false);
    expect(lastToast()).toBe('no position keys to remove');
    expect(ed().past.length).toBe(0);
  });

  it('a locked track: refused', () => {
    const t = open((t) => [image(t[0]!, 'a', 0, 4)]);
    applyPath('a', path());
    ed().updateTrack(t[0]!, { locked: true }, { skipHistory: true });
    const before = proj();
    expect(removePath('a')).toBe(false);
    expect(proj()).toBe(before);
    expect(lastToast()).toBe('this clip is on a locked track: unlock it to change its path');
  });
});
