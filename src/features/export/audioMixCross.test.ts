import { describe, expect, it, vi } from 'vitest';
import type { AudioClip, Clip, Keyframe, MediaAsset, Project, Track, VideoClip } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import { createProject } from '../../lib/factory';
import { soundGainAt, soundIndex } from '../../lib/audioCross';
import { clipMix, outputGain, panGains, trackPan, trackVolume } from '../../lib/mix';
import { MIX_SAMPLE_RATE, clipSchedule, clipWindow, gainPoints, getAudibleClips, panPoints, planMixChunks, scaleGain, soundWindow, trimGainPoints } from './audioMix';
import type { ClipSchedule, TimedAudible } from './audioMix';

vi.mock('../../media/registry', async (orig) => ({ ...(await orig<typeof import('../../media/registry')>()), getAssetBlob: () => new Blob(['x']) }));

const track = (id: string, kind: 'video' | 'audio', over: Partial<Track> = {}): Track => ({ id, kind, name: id, muted: false, hidden: false, locked: false, ...over });
const asset = (id: string, kind: MediaAsset['kind'], hasAudio: boolean, duration = 120): MediaAsset => ({ id, name: id, kind, mime: '', size: 1, duration, width: 100, height: 100, hasAudio, createdAt: 0 });
const video = (id: string, start: number, duration: number, over: Partial<VideoClip> = {}): VideoClip => ({
  id, type: 'video', trackId: 'v1', start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'av', trimStart: 5, speed: 1, volume: 1, muted: false, transform: { ...DEFAULT_TRANSFORM }, ...over,
});
const audio = (id: string, start: number, duration: number, over: Partial<AudioClip> = {}): AudioClip => ({
  id, type: 'audio', trackId: 'a1', start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'song', trimStart: 0, speed: 1, volume: 1, muted: false, ...over,
});
const lin = (...pairs: [number, number][]): Keyframe[] => pairs.map(([t, v]) => ({ t, v, ease: 'linear' as const }));

function proj(clips: Clip[], over: Partial<Project> = {}): Project {
  return {
    ...createProject('export'),
    assets: [asset('av', 'video', true), asset('song', 'audio', true)],
    tracks: [track('v1', 'video'), track('a1', 'audio')],
    clips,
    ...over,
  };
}
const at = (p: Project, id: string): TimedAudible => p.clips.find((c) => c.id === id) as TimedAudible;
/** every number of a schedule, in order */
const flat = (s: ClipSchedule | null): (number | string)[] => (s ? [s.assetId, s.from, s.span, s.when, s.rate, s.win.skip, s.win.localFrom, s.win.localTo, s.head, ...s.gain.flat()] : ['none']);
const sameNumbers = (a: (number | string)[], b: (number | string)[]): void => {
  expect(b.length).toBe(a.length);
  for (let i = 0; i < a.length; i++) expect(Object.is(a[i], b[i]), `value ${i}: ${String(a[i])} against ${String(b[i])}`).toBe(true);
};
/** the ramp of an envelope (times from the chunk start) at a time */
function ramp(pts: Array<[number, number]>, t: number): number {
  if (t <= pts[0]![0]) return pts[0]![1];
  for (let i = 1; i < pts.length; i++) {
    const [ta, ga] = pts[i - 1]!, [tb, gb] = pts[i]!;
    if (t <= tb) return tb - ta <= 1e-12 ? gb : ga + ((gb - ga) * (t - ta)) / (tb - ta);
  }
  return pts.at(-1)![1];
}

describe('the export reads the sound index', () => {
  it('soundWindow with a null sound is clipWindow', () => {
    const c = video('a', 3, 4, { speed: 1.5 });
    for (const [o, l] of [[0, 30], [0, 3], [5, 1], [6.5, 30], [7, 2], [-1, 100]] as const) {
      expect(soundWindow(c, null, o, l)).toEqual(clipWindow(c.start, c.duration, c.speed, o, l));
    }
  });

  it('clipSchedule with a null sound is the old schedule, head 0', () => {
    const c = video('a', 3, 4, { speed: 1.5, trimStart: 2, volume: 0.7, fadeIn: 0.5, fadeOut: 0.5, keyframes: { volume: lin([0, 1], [2, 0.4]) } });
    for (const [o, l] of [[0, 30], [4, 1.7], [0, 3.5], [6.9, 2]] as const) {
      const old = clipWindow(c.start, c.duration, c.speed, o, l);
      const s = clipSchedule(c, o, l);
      const t = clipSchedule(c, o, l, null);
      if (!old) {
        expect(s).toBeNull();
        expect(t).toBeNull();
        continue;
      }
      const pts = trimGainPoints(gainPoints(c), old.localFrom, old.localTo);
      const want: ClipSchedule = {
        assetId: 'av', from: Math.max(0, c.trimStart) + old.skip, span: old.span, when: old.when, rate: 1.5,
        gain: pts.map(([x, g]) => [old.when + x, g] as [number, number]), win: old, head: 0,
      };
      expect(s).toEqual(want);
      sameNumbers(flat(want), flat(s));
      sameNumbers(flat(want), flat(t));
    }
  });

  it('clips without an entry schedule the same numbers', () => {
    const p = proj([
      video('a', 0, 4),
      video('b', 4, 4, { crossfade: { before: 0.5, after: 0.5 } }),
      audio('x', 1, 9, { fadeIn: 1, fadeOut: 2, keyframes: { volume: lin([0, 1], [3, 0.5]) } }),
      audio('y', 3, 2, { trackId: 'a1', fadeIn: 0.5, fadeInShape: 'linear' }),
    ]);
    const sounds = soundIndex(p);
    expect([...sounds.keys()].sort()).toEqual(['a', 'b']);
    for (const id of ['x', 'y']) {
      const c = at(p, id);
      for (const [o, l] of [[0, 30], [0, 1.7], [1.7, 1.7], [3.4, 1.7], [5.1, 1.7]] as const) {
        sameNumbers(flat(clipSchedule(c, o, l)), flat(clipSchedule(c, o, l, sounds.get(id) ?? null)));
        expect(soundWindow(c, sounds.get(id) ?? null, o, l)).toEqual(clipWindow(c.start, c.duration, c.speed, o, l));
      }
    }
  });

  it('the bystanders of a crossfade mix the same numbers as without it', () => {
    const clips = (cross: boolean): Clip[] => [
      video('a', 0, 4),
      video('b', 4, 4, cross ? { crossfade: { before: 0.5, after: 0.5 } } : {}),
      audio('x', 1, 9, { fadeIn: 1, fadeOut: 2, keyframes: { volume: lin([0, 1], [3, 0.5]) } }),
      audio('y', 3, 2, { fadeIn: 0.5, fadeInShape: 'linear', keyframes: { pan: lin([0, -0.5], [1, 0.8]) } }),
    ];
    const over: Partial<Project> = { output: { volume: 0.8 }, tracks: [track('v1', 'video', { volume: 0.6 }), track('a1', 'audio', { volume: 0.7, pan: 0.2 })] };
    // what mixChunk hands to the graph, chunk by chunk: one row of numbers per clip
    const rows = (p: Project): Map<string, (number | string)[][]> => {
      const sounds = soundIndex(p);
      const out = new Map<string, (number | string)[][]>();
      const list = getAudibleClips(p);
      for (const clip of list) out.set(clip.id, []);
      for (const chunk of planMixChunks(10 * MIX_SAMPLE_RATE, 1.7 * MIX_SAMPLE_RATE)) {
        const offset = chunk.startFrame / MIX_SAMPLE_RATE;
        const length = chunk.frames / MIX_SAMPLE_RATE;
        for (const clip of list) {
          const row: (number | string)[] = [];
          const s = clipSchedule(clip, offset, length, sounds.get(clip.id) ?? null);
          if (s) {
            row.push(s.assetId, s.from, s.span, s.when, s.rate, s.win.skip, s.win.localFrom, s.win.localTo, s.head);
            const tr = p.tracks.find((x) => x.id === clip.trackId)!;
            for (const [t, g] of scaleGain(s.gain, trackVolume(tr) * outputGain(p))) row.push(t, g);
            row.push('pan');
            const pan = panPoints(clip, trackPan(tr));
            if (pan) for (const side of [pan.l, pan.r]) for (const [t, g] of trimGainPoints(side, s.win.localFrom - s.head, s.win.localTo - s.head)) row.push(s.when + t, g);
          }
          out.get(clip.id)!.push(row);
        }
      }
      return out;
    };
    const plain = proj(clips(false), over);
    const crossed = proj(clips(true), over);
    const without = rows(plain);
    const withIt = rows(crossed);
    // the audible order is the clip order, crossfade or not
    expect([...withIt.keys()]).toEqual([...without.keys()]);
    expect([...withIt.keys()]).toEqual(['a', 'b', 'x', 'y']);
    for (const id of ['x', 'y']) {
      const a = without.get(id)!, b = withIt.get(id)!;
      expect(b.length).toBe(a.length);
      expect(a.some((r) => r.length > 0)).toBe(true);
      for (let c = 0; c < a.length; c++) sameNumbers(a[c]!, b[c]!);
    }
    // the crossfaded clip itself does differ
    expect(withIt.get('b')).not.toEqual(without.get('b'));
  });

  it('a crossfaded clip starts early from the media before it', () => {
    const p = proj([video('a', 0, 4), video('b', 4, 4, { trimStart: 5, crossfade: { before: 0.25, after: 0.25 } })]);
    const sounds = soundIndex(p);
    const b = at(p, 'b'), a = at(p, 'a');
    const sb = clipSchedule(b, 0, 30, sounds.get('b'))!;
    expect(sb.head).toBe(0.25);
    expect(sb.when).toBe(3.75);
    expect(sb.from).toBe(4.75);
    expect(sb.span).toBe(4.25);
    expect(sb.gain[0]![0]).toBe(3.75);
    expect(sb.gain[0]![1]).toBe(0);
    expect(sb.gain.at(-1)![0]).toBe(8);
    // the clip before sounds on past its end
    const sa = clipSchedule(a, 0, 30, sounds.get('a'))!;
    expect(sa.head).toBe(0);
    expect(sa.when).toBe(0);
    expect(sa.from).toBe(5);
    expect(sa.span).toBe(4.25);
    expect(sa.gain.at(-1)![0]).toBe(4.25);
    expect(sa.gain.at(-1)![1]).toBe(0);
    // speed 2: the head is source seconds twice as long
    const q = proj([video('a', 0, 4), video('b', 4, 2, { trimStart: 5, speed: 2, crossfade: { before: 0.25, after: 0.25 } })]);
    const sq = clipSchedule(at(q, 'b'), 0, 30, soundIndex(q).get('b'))!;
    expect(sq.from).toBe(4.5);
    expect(sq.span).toBe(4.5);
    expect(sq.when).toBe(3.75);
    expect(sq.rate).toBe(2);
    // a window that starts inside the head skips from the early start
    const part = clipSchedule(b, 3.9, 30, sounds.get('b'))!;
    expect(part.when).toBeCloseTo(0, 12);
    expect(part.from).toBeCloseTo(4.9, 12);
    // a window that ends before the head is outside
    expect(clipSchedule(b, 0, 3.7, sounds.get('b'))).toBeNull();
  });

  it('the chunk border at 30 s cuts the envelope where the ramp is', () => {
    const p = proj([video('a', 26, 4), video('b', 30, 4, { crossfade: { before: 0.5, after: 0.5 } })]);
    const sounds = soundIndex(p);
    const a = at(p, 'a'), b = at(p, 'b');
    const sa = sounds.get('a')!, sb = sounds.get('b')!;
    const h = Math.SQRT1_2;
    // first chunk [0, 30): the clip before ends its ramp at the border, the clip after has just begun to sound
    const a1 = clipSchedule(a, 0, 30, sa)!;
    expect(a1.gain.at(-1)![0]).toBe(30);
    expect(a1.gain.at(-1)![1]).toBeCloseTo(h, 12);
    const b1 = clipSchedule(b, 0, 30, sb)!;
    expect(b1.when).toBe(29.5);
    expect(b1.gain.at(-1)![0]).toBeCloseTo(30, 12);
    expect(b1.gain.at(-1)![1]).toBeCloseTo(h, 12);
    // second chunk [30, 60): the same two values start it
    const a2 = clipSchedule(a, 30, 30, sa)!;
    expect(a2.when).toBe(0);
    expect(a2.gain[0]![1]).toBeCloseTo(h, 12);
    expect(a2.gain.at(-1)![0]).toBeCloseTo(0.5, 12);
    expect(a2.gain.at(-1)![1]).toBeCloseTo(0, 12);
    const b2 = clipSchedule(b, 30, 30, sb)!;
    expect(b2.when).toBe(0);
    expect(b2.gain[0]![1]).toBeCloseTo(h, 12);
    expect(b2.from).toBeCloseTo(5, 12);
    // the two halves of the clip after hold together: gain at the border is the same from both sides
    expect(b1.gain.at(-1)![1]).toBeCloseTo(b2.gain[0]![1], 12);
    expect(a1.gain.at(-1)![1]).toBeCloseTo(a2.gain[0]![1], 12);
    // a clip wholly past the border still has a window in the second chunk, none in the first
    expect(soundWindow(b, sb, 0, 29.4)).toBeNull();
    expect(soundWindow(b, sb, 0, 29.6)).not.toBeNull();
  });

  it('pan points are read through the head', () => {
    const p = proj([video('a', 0, 4), video('b', 4, 4, { crossfade: { before: 0.25, after: 0.25 }, keyframes: { pan: lin([0, -0.5], [2, 0.8]) } })]);
    const sounds = soundIndex(p);
    const b = at(p, 'b');
    const sb = sounds.get('b')!;
    const sch = clipSchedule(b, 0, 30, sb)!;
    const pan = panPoints(b, 0)!;
    // mixChunk's pan trim line of the spec
    const left = trimGainPoints(pan.l, sch.win.localFrom - sch.head, sch.win.localTo - sch.head);
    const right = trimGainPoints(pan.r, sch.win.localFrom - sch.head, sch.win.localTo - sch.head);
    // the head holds the first pan: the first point is at the start of the sound with the first value
    expect(left[0]![0]).toBe(0);
    expect(left[0]![1]).toBe(panGains(-0.5)[0]);
    expect(right[0]![1]).toBe(panGains(-0.5)[1]);
    // the key at 2 s sits 2 s after the clip start on the timeline
    const key = left.find(([t]) => Math.abs(sch.when + t - (b.start + 2)) < 1e-9)!;
    expect(key).toBeDefined();
    expect(key[1]).toBeCloseTo(panGains(0.8)[0], 9);
    // the end is the whole length of the sound
    expect(left.at(-1)![0]).toBeCloseTo(sch.head + b.duration + sb.tail, 12);
    // a point on the ramp sits where the picture says: 1 s into the clip is half way from -0.5 to 0.8
    const mid = left.find(([t]) => Math.abs(sch.when + t - (b.start + 1)) < 1e-9)!;
    expect(mid[1]).toBeCloseTo(panGains(0.15)[0], 9);
  });

  it('the export gain is clipMix gain times the output', () => {
    const p = proj(
      [video('a', 26, 4, { volume: 0.9 }), video('b', 30, 4, { volume: 1.1, fadeOut: 1, crossfade: { before: 0.5, after: 0.5 } })],
      { output: { volume: 0.8 }, tracks: [track('v1', 'video', { volume: 0.6 }), track('a1', 'audio')] },
    );
    const sounds = soundIndex(p);
    const tr = p.tracks[0]!;
    for (const id of ['a', 'b']) {
      const c = at(p, id);
      const s = sounds.get(id)!;
      for (const [o, l] of [[0, 60], [0, 30], [30, 30]] as const) {
        const sch = clipSchedule(c, o, l, s);
        if (!sch) continue;
        const pts = scaleGain(sch.gain, trackVolume(tr) * outputGain(p));
        const lo = Math.max(o, c.start - s.head), hi = Math.min(o + l, c.start + c.duration + s.tail);
        for (let i = 0; i <= 300; i++) {
          const time = lo + ((hi - lo) * i) / 300;
          const want = clipMix(p, c, time, null, s).gain * outputGain(p);
          expect(Math.abs(ramp(pts, time - o) - want), `${id} at ${time}`).toBeLessThan(0.0005);
          expect(Math.abs(soundGainAt(c, s, time) * trackVolume(tr) * outputGain(p) - want)).toBe(0);
        }
      }
    }
  });
});
