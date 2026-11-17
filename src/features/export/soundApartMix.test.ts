import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioClip, Clip, Keyframe, MediaAsset, Project, Track, VideoClip } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import { createProject } from '../../lib/factory';
import { useEditor } from '../../store/editorStore';
import { joinSound, separateSound } from '../timeline/soundActions';
import { outputGain, trackPan, trackVolume } from '../../lib/mix';
import { MIX_SAMPLE_RATE, clipSchedule, getAudibleClips, panPoints, planMixChunks, scaleGain, trimGainPoints } from './audioMix';
import type { ClipSchedule } from './audioMix';

vi.mock('../../media/registry', async (orig) => ({ ...(await orig<typeof import('../../media/registry')>()), getAssetBlob: () => new Blob(['x']) }));

const ed = () => useEditor.getState();
const proj = (): Project => ed().project!;

const track = (id: string, kind: 'video' | 'audio', over: Partial<Track> = {}): Track => ({ id, kind, name: id, muted: false, hidden: false, locked: false, ...over });
const asset = (id: string, kind: MediaAsset['kind'], hasAudio: boolean): MediaAsset => ({ id, name: id, kind, mime: '', size: 1, duration: 60, width: 100, height: 100, hasAudio, createdAt: 0 });
const video = (id: string, start: number, duration: number, over: Partial<VideoClip> = {}): VideoClip => ({
  id, type: 'video', trackId: 'v1', start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'av', trimStart: 0, speed: 1, volume: 1, muted: false, transform: { ...DEFAULT_TRANSFORM }, ...over,
});
const audio = (id: string, start: number, duration: number, over: Partial<AudioClip> = {}): AudioClip => ({
  id, type: 'audio', trackId: 'a1', start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'song', trimStart: 0, speed: 1, volume: 1, muted: false, ...over,
});
const lin = (...pairs: [number, number][]): Keyframe[] => pairs.map(([t, v]) => ({ t, v, ease: 'linear' as const }));

function open(picture: Partial<VideoClip> = {}): void {
  const clips: Clip[] = [
    audio('x', 0, 6),
    video('a', 0.2, 3, { trimStart: 0.5, speed: 1.25, volume: 1.2, fadeIn: 0.3, fadeOut: 0.5, pan: 0.4, keyframes: { volume: lin([0, 1], [1, 1.6], [2.5, 0.3]), pan: lin([0, -0.5], [2, 0.8]) }, ...picture }),
    video('b', 1, 2, { trackId: 'v2', assetId: 'other', trimStart: 2 }),
    audio('y', 5, 2, { trackId: 'a2' }),
  ];
  ed().openProject({
    ...createProject('mix'),
    assets: [asset('av', 'video', true), asset('other', 'video', true), asset('song', 'audio', true)],
    output: { volume: 0.8 },
    // a fader and a pan on the picture's track: the sound clip's new track has to take both
    tracks: [track('v1', 'video', { volume: 0.5, pan: -0.3 }), track('v2', 'video'), track('a1', 'audio'), track('a2', 'audio')],
    clips,
  });
  useEditor.setState({ past: [], future: [], selection: [] });
}

/** what the export would schedule, chunk by chunk: the audible order and every number of every schedule */
function mixNumbers(p: Project, chunkSeconds = 1.7, total = 8): (number | string)[][] {
  const out: (number | string)[][] = [];
  const list = getAudibleClips(p);
  for (const chunk of planMixChunks(total * MIX_SAMPLE_RATE, chunkSeconds * MIX_SAMPLE_RATE)) {
    const offset = chunk.startFrame / MIX_SAMPLE_RATE;
    const length = chunk.frames / MIX_SAMPLE_RATE;
    const row: (number | string)[] = [];
    for (const clip of list) {
      const s: ClipSchedule | null = clipSchedule(clip, offset, length);
      if (!s) continue;
      row.push(s.assetId, s.from, s.span, s.when, s.rate, s.win.skip, s.win.localFrom, s.win.localTo);
      const tr = p.tracks.find((x) => x.id === clip.trackId)!;
      // the same numbers mixChunk hands to the graph: the fader times the output, and the pan of each side
      for (const [t, g] of scaleGain(s.gain, trackVolume(tr) * outputGain(p))) row.push(t, g);
      row.push('pan');
      const pan = panPoints(clip, trackPan(tr));
      if (pan) for (const side of [pan.l, pan.r]) for (const [t, g] of trimGainPoints(side, s.win.localFrom, s.win.localTo)) row.push(s.when + t, g);
      row.push('end');
    }
    out.push(row);
  }
  return out;
}

function same(a: (number | string)[][], b: (number | string)[][]): void {
  expect(b.length).toBe(a.length);
  for (let c = 0; c < a.length; c++) {
    expect(b[c]!.length, `chunk ${c}`).toBe(a[c]!.length);
    for (let i = 0; i < a[c]!.length; i++) expect(Object.is(b[c]![i], a[c]![i]), `chunk ${c} value ${i}: ${String(a[c]![i])} against ${String(b[c]![i])}`).toBe(true);
  }
}

beforeEach(() => {
  useEditor.setState({ project: null, selection: [], past: [], future: [], clipboard: [] });
});

describe('separate sound keeps the mix', () => {
  it('audible order and clipSchedule per chunk are bit identical', () => {
    open();
    const before = mixNumbers(proj());
    // two other clips play, and a chunk edge (1.7 s) falls inside the pair
    expect(getAudibleClips(proj()).map((c) => c.id)).toEqual(['x', 'a', 'b', 'y']);
    expect(before.some((row) => row.length > 0)).toBe(true);
    expect(typeof separateSound(['a'])).toBe('object');
    const list = getAudibleClips(proj());
    expect(list).toHaveLength(4);
    // the sound clip takes the place of its picture in the list
    expect(list.map((c) => c.type)).toEqual(['audio', 'audio', 'video', 'audio']);
    expect(list[1]!.id).not.toBe('a');
    same(before, mixNumbers(proj()));
    // one more run with other chunk sizes, one of them with the edge on the start of the clip
    for (const size of [0.2, 1, 2.9]) {
      expect(typeof joinSound(['a'])).toBe('object');
      const b = mixNumbers(proj(), size);
      separateSound(['a']);
      same(b, mixNumbers(proj(), size));
    }
  });

  it('a muted picture stays silent', () => {
    open({ muted: true });
    expect(getAudibleClips(proj()).map((c) => c.id)).toEqual(['x', 'b', 'y']);
    const before = mixNumbers(proj());
    expect(typeof separateSound(['a'])).toBe('object');
    // the sound clip is muted like its picture: nothing new is heard
    expect(getAudibleClips(proj()).map((c) => c.id)).toEqual(['x', 'b', 'y']);
    same(before, mixNumbers(proj()));
  });

  it('join gives it back', () => {
    open();
    const before = mixNumbers(proj());
    const ids = getAudibleClips(proj()).map((c) => c.id);
    separateSound(['a']);
    joinSound(['a']);
    expect(getAudibleClips(proj()).map((c) => c.id)).toEqual(ids);
    same(before, mixNumbers(proj()));
  });
});
