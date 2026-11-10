import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioClip, Clip, ImageClip, Keyframe, MediaAsset, Project } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import { createProject } from '../../lib/factory';
import { evalKeys } from '../../lib/anim';
import { clipGrid, gridLines } from '../../lib/tempo';
import { getWaveform } from '../../media/derived';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { useUi } from '../../store/ui';
import { fitKeysToBeatAction, loopKeysOnBeatAction, snapKeysToBeatAction } from '../properties/keyActions';
import { markBeats } from './beatActions';
import { beatSources, detectBpm } from './tempoActions';

vi.mock('../../media/derived', () => ({ getWaveform: vi.fn() }));

const ed = () => useEditor.getState();
const proj = (): Project => ed().project!;
const clipOf = <T extends Clip>(id: string): T => proj().clips.find((c) => c.id === id) as T;
const keysOf = (id: string, prop: string): Keyframe[] => clipOf(id).keyframes?.[prop] ?? [];
const tv = (keys: Keyframe[]) => keys.map((k) => [+k.t.toFixed(6), +k.v.toFixed(6)]);
const lastToast = (): string => useUi.getState().toasts.at(-1)?.message ?? '';
const lin = (...pairs: [number, number][]): Keyframe[] => pairs.map(([t, v]) => ({ t, v, ease: 'linear' as const }));

const sound = (id: string, duration = 60): MediaAsset => ({ id, name: id, kind: 'audio', mime: 'audio/wav', size: 1, duration, width: 0, height: 0, hasAudio: true, createdAt: 0 });
const picture = (id: string): MediaAsset => ({ id, name: id, kind: 'image', mime: 'image/png', size: 1, duration: 0, width: 100, height: 100, hasAudio: false, createdAt: 0 });
const audio = (trackId: string, id: string, start: number, duration: number, over: Partial<AudioClip> = {}): AudioClip => ({
  id, type: 'audio', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'song', trimStart: 0, speed: 1, volume: 1, muted: false, ...over,
});
const image = (trackId: string, id: string, start: number, duration: number, over: Partial<ImageClip> = {}): ImageClip => ({
  id, type: 'image', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'img', transform: { ...DEFAULT_TRANSFORM }, ...over,
});

function open(make: (t: string[]) => Clip[]): string[] {
  const p = createProject('tempo');
  ed().openProject({ ...p, assets: [sound('song'), sound('other'), picture('img')], clips: [] });
  for (let i = 0; i < 3; i++) ed().addTrack('video');
  const ids = proj().tracks.map((t) => t.id);
  useEditor.setState({ project: { ...proj(), clips: make(ids) }, past: [], future: [] });
  return ids;
}

function oneStep(run: () => void): void {
  const before = proj();
  run();
  const after = proj();
  expect(ed().past.length).toBe(1);
  expect(after).not.toEqual(before);
  ed().undo();
  expect(proj()).toEqual(before);
  ed().redo();
  expect(proj()).toEqual(after);
}
function noStep(run: () => void): void {
  const before = proj();
  run();
  expect(ed().past.length).toBe(0);
  expect(proj()).toBe(before);
}

/** click track peaks: a spike at each beat */
function clicks(bpm: number, seconds: number, offset = 0, pps = 50) {
  const peaks = new Float32Array(Math.round(seconds * pps));
  let s = 7;
  const rand = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0), s / 4294967296);
  for (let i = 0; i < peaks.length; i++) peaks[i] = rand() * 0.05;
  for (let t = offset; t < seconds - 0.1; t += 60 / bpm) {
    const i = Math.floor(t * pps);
    peaks[i] = 1;
    if (i + 1 < peaks.length) peaks[i + 1] = 0.5;
  }
  return { peaks, peaksPerSecond: pps };
}

beforeEach(() => {
  useEditor.setState({ project: null, selection: [], past: [], future: [], clipboard: [] });
  useUi.setState({ toasts: [] });
  usePlayback.setState({ time: 0 });
  vi.mocked(getWaveform).mockReset();
});

describe('the tempo on a clip (store)', () => {
  it('sets, rounds, clamps and clears, each one undo step', () => {
    open((t) => [audio(t[0]!, 'a', 0, 10)]);
    oneStep(() => ed().updateClip('a', { bpm: 127.456, beatOffset: 0.12345 }));
    expect(clipOf<AudioClip>('a').bpm).toBe(127.456);
    expect(clipOf<AudioClip>('a').beatOffset).toBe(0.123);
    ed().updateClip('a', { bpm: 5000 });
    expect(clipOf<AudioClip>('a').bpm).toBe(400);
    ed().updateClip('a', { bpm: 1 });
    expect(clipOf<AudioClip>('a').bpm).toBe(20);
    ed().updateClip('a', { bpm: NaN });
    expect(clipOf<AudioClip>('a').bpm ?? null).toBeNull();
    ed().updateClip('a', { bpm: 90 });
    ed().updateClip('a', { bpm: null, beatOffset: null });
    expect(clipOf<AudioClip>('a').bpm ?? null).toBeNull();
    expect(clipGrid(clipOf<AudioClip>('a'))).toBeNull();
  });

  it('a value that cleans to what is stored is no change: no empty undo step', () => {
    open((t) => [audio(t[0]!, 'a', 0, 10, { bpm: 120, beatOffset: 0 })]);
    noStep(() => ed().updateClip('a', { bpm: 120.00001 }));
    noStep(() => ed().updateClip('a', { beatOffset: 0.0004 }));
    open((t) => [audio(t[0]!, 'a', 0, 10, { bpm: 400 })]);
    noStep(() => ed().updateClip('a', { bpm: 9999 }));
  });

  it('a clip without sound in it takes no tempo', () => {
    open((t) => [image(t[0]!, 'i', 0, 4)]);
    noStep(() => ed().updateClip('i', { bpm: 120 } as never));
    expect('bpm' in clipOf('i')).toBe(false);
  });

  it('a split keeps the tempo and the beats stay where they are', () => {
    open((t) => [audio(t[0]!, 'a', 1, 10, { bpm: 100, beatOffset: 0.25, trimStart: 2 })]);
    const before = gridLines(clipGrid(clipOf<AudioClip>('a'))!, 1, 11).map((l) => +l.time.toFixed(6));
    ed().splitClips(5.3, ['a']);
    const parts = proj().clips.filter((c): c is AudioClip => c.type === 'audio').sort((x, y) => x.start - y.start);
    expect(parts.length).toBe(2);
    const after = parts.flatMap((c) => gridLines(clipGrid(c)!, c.start, c.start + c.duration - 1e-6).map((l) => +l.time.toFixed(6)));
    expect(after).toEqual(before.filter((t) => t < 11 - 1e-6));
    for (const c of parts) expect(c.bpm).toBe(100);
  });

  it('other media, other tempo: a swap forgets it', () => {
    open((t) => [audio(t[0]!, 'a', 0, 10, { bpm: 100, beatOffset: 0.25 })]);
    expect(ed().replaceClipAsset('a', 'other')).toBe(true);
    const a = clipOf<AudioClip>('a');
    expect('bpm' in a).toBe(false);
    expect('beatOffset' in a).toBe(false);
  });
});

describe('detectBpm', () => {
  it('listens and stores the tempo and where a beat falls, one undo step', async () => {
    open((t) => [audio(t[0]!, 'a', 0, 30)]);
    vi.mocked(getWaveform).mockResolvedValue(clicks(120, 40, 0.2) as never);
    await detectBpm('a');
    const a = clipOf<AudioClip>('a');
    // settled on the whole number the click track was made at
    expect(a.bpm).toBe(120);
    // a beat falls at 0.2 s (and every half second from there)
    const grid = clipGrid(a)!;
    const off = (((0.2 - grid.origin) % grid.step) + grid.step) % grid.step;
    expect(Math.min(off, grid.step - off)).toBeLessThan(0.04);
    expect(ed().past.length).toBe(1);
    expect(lastToast()).toBe('120 bpm');
    ed().undo();
    expect(clipOf<AudioClip>('a').bpm ?? null).toBeNull();
  });

  it('no steady beat: says so and changes nothing', async () => {
    open((t) => [audio(t[0]!, 'a', 0, 30)]);
    const flat = { peaks: new Float32Array(2000).fill(0.3), peaksPerSecond: 50 };
    vi.mocked(getWaveform).mockResolvedValue(flat as never);
    const before = proj();
    await detectBpm('a');
    expect(proj()).toBe(before);
    expect(lastToast()).toMatch(/type the bpm in, or tap it$/);
  });

  it('unreadable audio, a locked track, a clip without sound', async () => {
    const t = open((tr) => [audio(tr[0]!, 'a', 0, 30), image(tr[1]!, 'i', 0, 4)]);
    vi.mocked(getWaveform).mockRejectedValue(new Error('nope'));
    const before = proj();
    await detectBpm('a');
    expect(proj()).toBe(before);
    expect(lastToast()).toBe('could not read the audio');
    await detectBpm('i');
    await detectBpm('gone');
    expect(vi.mocked(getWaveform)).toHaveBeenCalledTimes(1);
    ed().updateTrack(t[0]!, { locked: true }, { skipHistory: true });
    await detectBpm('a');
    expect(lastToast()).toBe('this track is locked');
    expect(vi.mocked(getWaveform)).toHaveBeenCalledTimes(1);
  });

  it('a track locked while listening: nothing stored, and no toast that says it was', async () => {
    const t = open((tr) => [audio(tr[0]!, 'a', 0, 30)]);
    vi.mocked(getWaveform).mockImplementation(async () => {
      ed().updateTrack(t[0]!, { locked: true }, { skipHistory: true });
      return clicks(120, 40) as never;
    });
    await detectBpm('a');
    expect(clipOf<AudioClip>('a').bpm ?? null).toBeNull();
    expect(lastToast()).toBe('this track is locked');
    expect(ed().past.length).toBe(0);
  });

  it('a clip that got other media while listening is left alone', async () => {
    open((t) => [audio(t[0]!, 'a', 0, 30)]);
    vi.mocked(getWaveform).mockImplementation(async () => {
      ed().replaceClipAsset('a', 'other');
      return clicks(120, 40) as never;
    });
    await detectBpm('a');
    expect(clipOf<AudioClip>('a').bpm ?? null).toBeNull();
  });
});

describe('beatSources', () => {
  it('lists the clips with a tempo: itself first, then the longest overlap, then by time', () => {
    open((t) => [
      audio(t[0]!, 'early', 0, 3, { bpm: 100, name: 'intro' }),
      audio(t[0]!, 'main', 3, 20, { bpm: 128, name: 'drop' }),
      audio(t[1]!, 'late', 40, 5, { bpm: 90, name: 'outro', speed: 2 }),
      audio(t[1]!, 'mute', 0, 30, { name: 'no tempo' }),
      image(t[2]!, 'v', 2, 6),
    ]);
    const list = beatSources(proj(), clipOf('v'));
    expect(list.map((s) => s.id)).toEqual(['main', 'early', 'late']);
    expect(list.map((s) => s.label)).toEqual(['drop · 128 bpm', 'intro · 100 bpm', 'outro · 180 bpm']);
    expect(list[0]!.grid).toEqual(clipGrid(clipOf<AudioClip>('main')));
    expect(beatSources(proj(), clipOf('early'))[0]!.id).toBe('early');
  });

  it('nothing without a tempo anywhere', () => {
    open((t) => [audio(t[0]!, 'a', 0, 3), image(t[1]!, 'v', 0, 3)]);
    expect(beatSources(proj(), clipOf('v'))).toEqual([]);
  });
});

describe('mark the beats with a tempo set', () => {
  it('follows the tempo without listening, numbered from the first beat of the sound', async () => {
    open((t) => [audio(t[0]!, 'a', 10, 2, { bpm: 120, beatOffset: 1.25, trimStart: 1 })]);
    await markBeats('a');
    expect(vi.mocked(getWaveform)).not.toHaveBeenCalled();
    const marks = (proj().markers ?? []).map((m) => [+m.time.toFixed(6), m.name]).sort((x, y) => (x[0] as number) - (y[0] as number));
    // source beats at 0.25, 0.75, 1.25 ...: the clip plays source 1 .. 3 from timeline second 10
    expect(marks).toEqual([[10.25, '3'], [10.75, '4'], [11.25, '5'], [11.75, '6']]);
    expect(ed().past.length).toBe(1);
  });

  it('a long song is marked to its end', async () => {
    open((t) => [audio(t[0]!, 'a', 0, 3000, { bpm: 180 })]);
    await markBeats('a', 4);
    const times = (proj().markers ?? []).map((m) => m.time);
    // 9000 beats, every 4th, and the one on the cut at the end
    expect(times.length).toBe(2251);
    expect(Math.max(...times)).toBeGreaterThan(2998);
  });

  it('every 4th counts from the beat at the offset', async () => {
    open((t) => [audio(t[0]!, 'a', 0, 4, { bpm: 120, beatOffset: 1 })]);
    await markBeats('a', 4);
    const times = (proj().markers ?? []).map((m) => +m.time.toFixed(6)).sort((x, y) => x - y);
    expect(times).toEqual([1, 3]);
  });
});

describe('keyframes on the beat (actions)', () => {
  const setup = (keys: Keyframe[]) =>
    open((t) => [audio(t[0]!, 'a', 0, 20, { bpm: 120, beatOffset: 0.1 }), image(t[1]!, 'v', 2, 4, { keyframes: { x: keys } })]);

  it('snap: the keys of another clip land on the beats of the song, one undo step', () => {
    setup(lin([0.07, 0], [0.4, 100], [1.3, 50]));
    // beats at timeline 0.1 + k / 2: in the clip (it starts at 2) that is 0.1, 0.6, 1.1 ...
    oneStep(() => snapKeysToBeatAction('v', 'a', 1));
    expect(tv(keysOf('v', 'x'))).toEqual([[0.1, 0], [0.6, 100], [1.1, 50]]);
    expect(lastToast()).toBe('3 keyframes moved onto the beat');
    useEditor.setState({ past: [], future: [] });
    noStep(() => snapKeysToBeatAction('v', 'a', 1));
    expect(lastToast()).toBe('the keyframes are on the beat already');
  });

  it('fit: the animation lasts the beats', () => {
    setup(lin([0.07, 0], [0.4, 100]));
    oneStep(() => fitKeysToBeatAction('v', 'a', 4));
    expect(tv(keysOf('v', 'x'))).toEqual([[0.1, 0], [2.1, 100]]);
    expect(lastToast()).toBe('keyframes fit to 4 beats');
  });

  it('loop and ping pong: the first beats repeat to the end of the clip', () => {
    setup(lin([0.07, 0], [0.4, 100]));
    oneStep(() => loopKeysOnBeatAction('v', 'a', 2, false));
    const x = keysOf('v', 'x');
    for (let round = 0; round < 3; round++) {
      expect(evalKeys(x, 0.1 + round)).toBeCloseTo(0, 6);
      expect(evalKeys(x, 0.1 + round + 0.165)).toBeCloseTo(50, 4);
      expect(evalKeys(x, 0.1 + round + 0.9)).toBeCloseTo(100, 6);
    }
    for (const k of x) expect(k.t <= 4 + 1e-9).toBe(true);
    expect(lastToast()).toBe('looping every 2 beats: 4 rounds');
    useEditor.setState({ past: [], future: [] });
    noStep(() => loopKeysOnBeatAction('v', 'a', 2, false));
    expect(lastToast()).toBe('it loops like that already');
    oneStep(() => loopKeysOnBeatAction('v', 'a', 2, true));
    const pp = keysOf('v', 'x');
    expect(evalKeys(pp, 0.1 + 1 + 0.9)).toBeCloseTo(evalKeys(pp, 0.1 + 0.1), 4);
    expect(lastToast()).toBe('looping every 2 beats, ping pong: 4 rounds');
  });

  it('a clip with sound can follow its own beat', () => {
    open((t) => [audio(t[0]!, 'a', 3, 8, { bpm: 60, keyframes: { volume: lin([0.2, 1], [0.7, 0.2]) } })]);
    oneStep(() => loopKeysOnBeatAction('a', 'a', 1, false));
    const v = keysOf('a', 'volume');
    expect(v[0]!.t).toBe(0);
    expect(evalKeys(v, 5.25)).toBeCloseTo(evalKeys(v, 0.25), 6);
  });

  it('says what is missing and changes nothing', () => {
    const t = open((tr) => [audio(tr[0]!, 'a', 0, 20, { bpm: 120 }), audio(tr[0]!, 'b', 20, 5), image(tr[1]!, 'v', 2, 4), image(tr[2]!, 'k', 2, 4, { keyframes: { x: lin([0, 0], [1, 5]) } })]);
    noStep(() => snapKeysToBeatAction('v', 'a', 1));
    expect(lastToast()).toBe('no keyframes to change');
    noStep(() => loopKeysOnBeatAction('v', 'a', 2, false));
    expect(lastToast()).toBe('no keyframes to change');
    noStep(() => fitKeysToBeatAction('v', 'a', 2));
    expect(lastToast()).toBe('no keyframes to change');
    // a source that has no tempo (any more)
    noStep(() => loopKeysOnBeatAction('k', 'b', 2, false));
    expect(lastToast()).toBe('set a bpm on a clip with sound first');
    noStep(() => snapKeysToBeatAction('k', 'gone', 1));
    expect(lastToast()).toBe('set a bpm on a clip with sound first');
    ed().updateTrack(t[2]!, { locked: true }, { skipHistory: true });
    noStep(() => loopKeysOnBeatAction('k', 'a', 2, false));
    noStep(() => fitKeysToBeatAction('k', 'a', 2));
    noStep(() => snapKeysToBeatAction('k', 'a', 2));
  });
});
