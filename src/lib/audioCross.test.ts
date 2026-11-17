import { describe, expect, it } from 'vitest';
import type { AudioClip, Clip, Crossfade, FadeShape, ImageClip, Keyframe, MediaAsset, Project, Track, VideoClip } from '../types';
import { DEFAULT_TRANSFORM, FADE_SHAPES } from '../types';
import { createProject } from './factory';
import { valueAt } from './anim';
import { fadeFactor } from './timelineOps';
import {
  EMPTY_SOUNDS,
  SHAPE_STEPS,
  cleanCrossfade,
  cleanFadeShape,
  crossWeight,
  crossfadeRoom,
  crossfadeSpan,
  hasSound,
  headRoom,
  readShape,
  sameCrossfade,
  shapeIn,
  soundAfter,
  soundBefore,
  soundFade,
  soundGainAt,
  soundGainPoints,
  soundIndex,
  tailRoom,
} from './audioCross';
import type { ClipSound } from './audioCross';

const track = (id: string, kind: 'video' | 'audio', over: Partial<Track> = {}): Track => ({ id, kind, name: id, muted: false, hidden: false, locked: false, ...over });
const asset = (id: string, kind: MediaAsset['kind'], hasAudio: boolean, duration = 60): MediaAsset => ({ id, name: id, kind, mime: '', size: 1, duration, width: 100, height: 100, hasAudio, createdAt: 0 });
const video = (id: string, start: number, duration: number, over: Partial<VideoClip> = {}): VideoClip => ({
  id, type: 'video', trackId: 'v1', start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'av', trimStart: 0, speed: 1, volume: 1, muted: false, transform: { ...DEFAULT_TRANSFORM }, ...over,
});
const audio = (id: string, start: number, duration: number, over: Partial<AudioClip> = {}): AudioClip => ({
  id, type: 'audio', trackId: 'a1', start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'song', trimStart: 0, speed: 1, volume: 1, muted: false, ...over,
});
const image = (id: string, start: number, duration: number): ImageClip => ({
  id, type: 'image', trackId: 'v1', start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'pic', transform: { ...DEFAULT_TRANSFORM },
});
const lin = (...pairs: [number, number][]): Keyframe[] => pairs.map(([t, v]) => ({ t, v, ease: 'linear' as const }));

function proj(clips: Clip[]): Project {
  return {
    ...createProject('cross'),
    assets: [asset('av', 'video', true), asset('silent', 'video', false), asset('song', 'audio', true), asset('pic', 'image', false)],
    tracks: [track('v1', 'video'), track('v2', 'video'), track('a1', 'audio'), track('a2', 'audio')],
    clips,
  };
}
const X: Crossfade = { before: 0.25, after: 0.25 };
/** two video clips that touch at 4: a 0..4, b 4..8 */
const two = (a: Partial<VideoClip> = {}, b: Partial<VideoClip> = {}): Project => proj([video('a', 0, 4, a), video('b', 4, 4, { crossfade: X, ...b })]);
const clipOf = (p: Project, id: string): VideoClip | AudioClip => p.clips.find((c) => c.id === id) as VideoClip | AudioClip;
const entry = (p: Project, id: string): ClipSound => soundIndex(p).get(id)!;

describe('shapes', () => {
  it('shapeIn is exactly 0 and 1 at the ends', () => {
    for (const s of [...FADE_SHAPES, null, undefined]) {
      expect(Object.is(shapeIn(s, 0), 0)).toBe(true);
      expect(Object.is(shapeIn(s, -3), 0)).toBe(true);
      expect(Object.is(shapeIn(s, NaN), 0)).toBe(true);
      expect(shapeIn(s, 1)).toBe(1);
      expect(shapeIn(s, 7)).toBe(1);
    }
    expect(shapeIn(null, 0.3)).toBe(0.3);
    expect(shapeIn('linear', 0.3)).toBe(0.3);
  });

  it('power keeps in² + out² = 1, linear and smooth sum to 1', () => {
    for (let i = 0; i <= 100; i++) {
      const u = i / 100;
      expect(shapeIn('power', u) ** 2 + shapeIn('power', 1 - u) ** 2).toBeCloseTo(1, 12);
      expect(shapeIn('linear', u) + shapeIn('linear', 1 - u)).toBeCloseTo(1, 12);
      expect(shapeIn('smooth', u) + shapeIn('smooth', 1 - u)).toBeCloseTo(1, 12);
    }
    // the same sound through equal power peaks 3 db in the middle
    expect(shapeIn('power', 0.5) + shapeIn('power', 0.5)).toBeCloseTo(Math.SQRT2, 12);
  });
});

describe('the data rules', () => {
  it('the cleaners follow the data rules', () => {
    expect(cleanCrossfade(null)).toBeNull();
    expect(cleanCrossfade('x')).toBeNull();
    expect(cleanCrossfade([])).toBeNull();
    expect(cleanCrossfade({ before: 0.0004, after: 0.0004 })).toBeNull();
    expect(cleanCrossfade({ before: 0, after: 0 })).toBeNull();
    expect(cleanCrossfade({ before: 0.001, after: 0 })).toEqual({ before: 0.001, after: 0 });
    // sides: finite, 0..10, rounded to 1e-6, junk is 0
    expect(cleanCrossfade({ before: 15, after: -2 })).toEqual({ before: 10, after: 0 });
    expect(cleanCrossfade({ before: NaN, after: 0.5 })).toEqual({ before: 0, after: 0.5 });
    expect(cleanCrossfade({ before: '1', after: 0.5 })).toEqual({ before: 0, after: 0.5 });
    expect(cleanCrossfade({ before: 0.1234567891, after: 0.5 })).toEqual({ before: 0.123457, after: 0.5 });
    // a shape only for linear and smooth, withTransition only as true
    expect(cleanCrossfade({ ...X, shape: 'power' })).toEqual(X);
    expect(cleanCrossfade({ ...X, shape: 'linear' })).toEqual({ ...X, shape: 'linear' });
    expect(cleanCrossfade({ ...X, shape: 'smooth' })).toEqual({ ...X, shape: 'smooth' });
    expect(cleanCrossfade({ ...X, shape: 'wobble' })).toEqual(X);
    expect(cleanCrossfade({ ...X, withTransition: true })).toEqual({ ...X, withTransition: true });
    expect(cleanCrossfade({ ...X, withTransition: 1 })).toEqual(X);
    expect(cleanCrossfade({ ...X, withTransition: false })).toEqual(X);
    expect(cleanFadeShape('power')).toBe('power');
    expect(cleanFadeShape('smooth')).toBe('smooth');
    expect(cleanFadeShape('linear')).toBeNull();
    expect(cleanFadeShape('x')).toBeNull();
    expect(cleanFadeShape(null)).toBeNull();
    expect(readShape('smooth', 'power')).toBe('smooth');
    expect(readShape('x', 'power')).toBe('power');
    expect(readShape(undefined, 'linear')).toBe('linear');
    // equal by value, a missing shape is power
    expect(sameCrossfade(null, undefined)).toBe(true);
    expect(sameCrossfade(X, null)).toBe(false);
    expect(sameCrossfade(X, { ...X, shape: 'power' })).toBe(true);
    expect(sameCrossfade(X, { ...X, shape: 'linear' })).toBe(false);
    expect(sameCrossfade(X, { ...X, after: 0.3 })).toBe(false);
    expect(sameCrossfade({ ...X, withTransition: true }, X)).toBe(false);
  });
});

describe('spans', () => {
  it('a span is held to the media (speed 2)', () => {
    // b starts 1 s into its file at speed 2: only 0.5 timeline seconds of media before its first frame
    const p = proj([video('a', 0, 4, { trimStart: 10 }), video('b', 4, 4, { trimStart: 1, speed: 2, crossfade: { before: 2, after: 2 } })]);
    const b = clipOf(p, 'b');
    expect(headRoom(b)).toBe(0.5);
    const room = crossfadeRoom(p, 'b')!;
    expect(room.fromId).toBe('a');
    expect(room.before).toBe(0.5);
    expect(room.whyBefore).toBe('media');
    expect(room.whyAfter).toBe('half');
    const span = crossfadeSpan(p, b)!;
    expect(span.before).toBe(0.5);
    expect(span.shortBefore).toBe('media');
    expect(span.after).toBe(2);
    expect(span.shortAfter).toBeNull();
    expect(span.start).toBe(3.5);
    expect(span.end).toBe(6);
    expect(span.plays).toBe(true);
    // no media before the first frame: it plays after the edit only
    const q = proj([video('a', 0, 4, { trimStart: 10 }), video('b', 4, 4, { trimStart: 0, crossfade: { before: 2, after: 2 } })]);
    const s0 = crossfadeSpan(q, clipOf(q, 'b'))!;
    expect(s0.before).toBe(0);
    expect(s0.start).toBe(4);
    expect(s0.shortBefore).toBe('media');
    // a negative trim reads as none
    expect(headRoom(video('n', 0, 1, { trimStart: -2 }))).toBe(0);
    // the clip before ends near the end of its file: little media after the edit
    const r = proj([video('a', 0, 4, { trimStart: 55.5 }), video('b', 4, 4, { trimStart: 5, crossfade: { before: 1, after: 1 } })]);
    expect(tailRoom(r, clipOf(r, 'a'))).toBeCloseTo(0.5, 12);
    const s1 = crossfadeSpan(r, clipOf(r, 'b'))!;
    expect(s1.after).toBeCloseTo(0.5, 12);
    expect(s1.shortAfter).toBe('media');
    // speed 2 on the clip before: source seconds over speed
    const t = proj([video('a', 0, 2, { trimStart: 50, speed: 2 }), video('b', 2, 4, { trimStart: 5, crossfade: { before: 1, after: 1 } })]);
    expect(tailRoom(t, clipOf(t, 'a'))).toBeCloseTo(3, 12);
    // an unknown duration gives no tail
    const u = proj([video('a', 0, 4, { assetId: 'gone' }), video('b', 4, 4)]);
    expect(tailRoom(u, clipOf(u, 'a'))).toBe(0);
  });

  it('a span reaches at most half the clip', () => {
    // a lasts 2 s, b 8 s: half of a is 1 s before the edit, half of b is 4 s after
    const p = proj([video('a', 2, 2, { trimStart: 5 }), video('b', 4, 8, { trimStart: 30, crossfade: { before: 5, after: 5 } })]);
    const span = crossfadeSpan(p, clipOf(p, 'b'))!;
    expect(span.before).toBe(1);
    expect(span.shortBefore).toBe('half');
    expect(span.after).toBe(4);
    expect(span.shortAfter).toBe('half');
    expect(span.wantBefore).toBe(5);
    expect(span.roomBefore).toBe(1);
    expect(span.roomAfter).toBe(4);
    // the span stays inside both clips
    expect(span.start).toBeGreaterThanOrEqual(2);
    expect(span.end).toBeLessThanOrEqual(12);
  });

  it('a side is at most 10 s', () => {
    const p = proj([video('a', 0, 40, { trimStart: 0 }), video('b', 40, 40, { trimStart: 30, crossfade: { before: 30, after: 30 } })]);
    const room = crossfadeRoom(p, 'b')!;
    expect(room.before).toBe(10);
    expect(room.after).toBe(10);
    expect(room.whyBefore).toBe('longest');
    expect(room.whyAfter).toBe('longest');
    const span = crossfadeSpan(p, clipOf(p, 'b'))!;
    expect(span.before).toBe(10);
    expect(span.after).toBe(10);
    // the stored sides were cut to 10 already: nothing is short
    expect(span.shortBefore).toBeNull();
    expect(span.shortAfter).toBeNull();
  });

  it('no span without two touching clips with sound', () => {
    // a gap
    const gap = proj([video('a', 0, 4, { trimStart: 5 }), video('b', 4.5, 4, { trimStart: 5, crossfade: X })]);
    expect(soundBefore(gap, clipOf(gap, 'b'))).toBeNull();
    expect(crossfadeRoom(gap, 'b')).toBeNull();
    expect(crossfadeSpan(gap, clipOf(gap, 'b'))).toBeNull();
    // an image before
    const img = proj([image('a', 0, 4), video('b', 4, 4, { trimStart: 5, crossfade: X })]);
    expect(crossfadeSpan(img, clipOf(img, 'b'))).toBeNull();
    // a video without sound on either side
    const mute1 = proj([video('a', 0, 4, { assetId: 'silent' }), video('b', 4, 4, { trimStart: 5, crossfade: X })]);
    expect(crossfadeSpan(mute1, clipOf(mute1, 'b'))).toBeNull();
    const mute2 = proj([video('a', 0, 4, { trimStart: 5 }), video('b', 4, 4, { assetId: 'silent', trimStart: 5, crossfade: X })]);
    expect(crossfadeSpan(mute2, clipOf(mute2, 'b'))).toBeNull();
    // a picture whose sound is apart, either side
    const apartFrom = proj([video('a', 0, 4, { trimStart: 5, group: 'g' }), audio('s', 0, 4, { assetId: 'av', trimStart: 5, group: 'g' }), video('b', 4, 4, { trimStart: 5, crossfade: X })]);
    expect(hasSound(apartFrom, clipOf(apartFrom, 'a'))).toBe(false);
    expect(crossfadeSpan(apartFrom, clipOf(apartFrom, 'b'))).toBeNull();
    const apartTo = proj([video('a', 0, 4, { trimStart: 5 }), video('b', 4, 4, { trimStart: 5, group: 'g', crossfade: X }), audio('s', 4, 4, { assetId: 'av', trimStart: 5, group: 'g' })]);
    expect(crossfadeSpan(apartTo, clipOf(apartTo, 'b'))).toBeNull();
    // not a clip with sound at all
    expect(crossfadeSpan(gap, image('i', 0, 1))).toBeNull();
    expect(crossfadeRoom(gap, 'nope')).toBeNull();
    // the field waits: the same data plays once the clips touch
    expect(crossfadeSpan(two({ trimStart: 5 }, { trimStart: 5 }), clipOf(two({ trimStart: 5 }, { trimStart: 5 }), 'b'))).not.toBeNull();
  });

  it('the neighbours are the touching clips, never the clip itself', () => {
    const p = proj([video('a', 0, 4), video('b', 4, 4), video('c', 8.0004, 2), video('far', 20, 1), audio('x', 4, 2)]);
    expect(soundBefore(p, clipOf(p, 'b'))!.id).toBe('a');
    expect(soundAfter(p, clipOf(p, 'b'))!.id).toBe('c');
    expect(soundBefore(p, clipOf(p, 'a'))).toBeNull();
    expect(soundAfter(p, clipOf(p, 'c'))).toBeNull();
    // other tracks are other lanes
    expect(soundBefore(p, clipOf(p, 'x'))).toBeNull();
    // two neighbours: the nearest wins
    const q = proj([video('a', 0, 4), video('a2', 0.0005, 3.9996), video('b', 4, 4)]);
    expect(soundBefore(q, clipOf(q, 'b'))!.id).toBe('a');
  });

  it('withTransition follows the transition halves', () => {
    const p = proj([video('a', 0, 4, { trimStart: 5 }), video('b', 4, 4, { trimStart: 5, transition: { id: 'fade', duration: 1 }, crossfade: { before: 0.1, after: 0.1, withTransition: true } })]);
    const span = crossfadeSpan(p, clipOf(p, 'b'))!;
    expect(span.withTransition).toBe(true);
    expect(span.wantBefore).toBe(0.5);
    expect(span.wantAfter).toBe(0.5);
    expect(span.before).toBe(0.5);
    expect(span.after).toBe(0.5);
    // a transition longer than half the clips is held to half, as the picture is
    const q = proj([video('a', 0, 1, { trimStart: 5 }), video('b', 1, 4, { trimStart: 5, transition: { id: 'fade', duration: 3 }, crossfade: { before: 0.1, after: 0.1, withTransition: true } })]);
    const s2 = crossfadeSpan(q, clipOf(q, 'b'))!;
    expect(s2.wantBefore).toBe(0.5);
    expect(s2.wantAfter).toBe(0.5);
    // without the flag the stored sides stay
    const r = proj([video('a', 0, 4, { trimStart: 5 }), video('b', 4, 4, { trimStart: 5, transition: { id: 'fade', duration: 1 }, crossfade: { before: 0.1, after: 0.1 } })]);
    expect(crossfadeSpan(r, clipOf(r, 'b'))!.before).toBe(0.1);
    // an audio clip has no picture transition
    const s = proj([audio('a', 0, 4, { trimStart: 5 }), audio('b', 4, 4, { trimStart: 5, crossfade: { before: 0.1, after: 0.1, withTransition: true } })]);
    expect(crossfadeSpan(s, clipOf(s, 'b'))!.before).toBe(0.1);
  });

  it('a span is cached per project and clip object', () => {
    const p = two({ trimStart: 5 }, { trimStart: 5 });
    const b = clipOf(p, 'b');
    expect(crossfadeSpan(p, b)).toBe(crossfadeSpan(p, b));
    const edited = { ...b, crossfade: { before: 0.1, after: 0.1 } } as VideoClip;
    expect(crossfadeSpan(p, edited)!.before).toBe(0.1);
    expect(crossfadeSpan(p, b)!.before).toBe(0.25);
  });
});

describe('soundIndex', () => {
  it('soundIndex is EMPTY_SOUNDS without fields and with a linear shape', () => {
    const p = proj([video('a', 0, 4, { fadeIn: 1 }), video('b', 4, 4), audio('x', 0, 5)]);
    expect(soundIndex(p)).toBe(EMPTY_SOUNDS);
    expect(soundIndex(p)).toBe(EMPTY_SOUNDS);
    // linear is no field, a junk shape is none
    const q = proj([video('a', 0, 4, { fadeIn: 1, fadeInShape: 'linear' }), audio('x', 0, 5, { fadeOut: 1, fadeOutShape: 'wobble' as unknown as FadeShape })]);
    expect(soundIndex(q)).toBe(EMPTY_SOUNDS);
    // a crossfade that cannot play (a gap) gives no entries either
    const r = proj([video('a', 0, 4), video('b', 5, 4, { crossfade: X })]);
    expect(soundIndex(r)).toBe(EMPTY_SOUNDS);
    // a project with no clips
    expect(soundIndex(proj([]))).toBe(EMPTY_SOUNDS);
  });

  it('only clips in a playing crossfade or with a shaped fade get an entry', () => {
    const p = proj([
      video('a', 0, 4, { trimStart: 5 }),
      video('b', 4, 4, { trimStart: 5, crossfade: X }),
      video('c', 8, 4, { trimStart: 5 }),
      audio('x', 0, 6),
      audio('shaped', 10, 4, { fadeIn: 1, fadeInShape: 'power' }),
      audio('nofade', 20, 4, { fadeIn: 0, fadeInShape: 'smooth' }),
      video('quiet', 0, 4, { trackId: 'v2', assetId: 'silent', fadeOut: 1, fadeOutShape: 'smooth' }),
    ]);
    const idx = soundIndex(p);
    expect([...idx.keys()].sort()).toEqual(['a', 'b', 'shaped']);
    expect(idx.get('b')!.head).toBe(0.25);
    expect(idx.get('b')!.tail).toBe(0);
    expect(idx.get('b')!.xin).toBe(crossfadeSpan(p, clipOf(p, 'b')));
    expect(idx.get('a')!.tail).toBe(0.25);
    expect(idx.get('a')!.head).toBe(0);
    expect(idx.get('a')!.xout).toBe(idx.get('b')!.xin);
    expect(idx.get('a')!.xin).toBeNull();
    expect(idx.get('shaped')).toEqual({ head: 0, tail: 0, xin: null, xout: null, inShape: 'power', outShape: 'linear' });
    // the same map every time
    expect(soundIndex(p)).toBe(idx);
  });

  it('a clip between two crossfades keeps both ends apart', () => {
    const p = proj([
      video('a', 0, 4, { trimStart: 5 }),
      video('b', 4, 4, { trimStart: 5, crossfade: { before: 0.5, after: 0.5 }, fadeInShape: 'smooth', fadeOutShape: 'power', fadeIn: 1, fadeOut: 1 }),
      video('c', 8, 4, { trimStart: 5, crossfade: { before: 0.5, after: 0.5, shape: 'linear' } }),
    ]);
    const b = entry(p, 'b');
    expect(b.head).toBe(0.5);
    expect(b.tail).toBe(0.5);
    expect(b.xin!.shape).toBe('power');
    expect(b.xout!.shape).toBe('linear');
    expect(b.inShape).toBe('smooth');
    expect(b.outShape).toBe('power');
    expect(b.xin!.end).toBeLessThanOrEqual(b.xout!.start);
  });
});

describe('the gain rule', () => {
  const lineSound = (): ClipSound => ({ head: 0, tail: 0, xin: null, xout: null, inShape: 'linear', outShape: 'linear' });

  it('soundGainAt is volume times fadeFactor for a linear entry', () => {
    const plain = video('p', 1, 4, { volume: 0.8, fadeIn: 0.5, fadeOut: 0.7 });
    const keyed = audio('k', 1, 4, { volume: 1, fadeIn: 0.3, fadeOut: 0.3, keyframes: { volume: lin([0, 0.2], [1.5, 1.6], [3, 0.4]) } });
    for (const c of [plain, keyed]) {
      for (let i = 0; i <= 4000; i++) {
        const t = c.start + i / 1000;
        const old = Math.max(0, valueAt(c, 'volume', t) ?? c.volume) * fadeFactor(c, t);
        const now = soundGainAt(c, lineSound(), t);
        if (!Object.is(now, old)) throw new Error(`${c.id} at ${t}: ${old} against ${now}`);
      }
    }
    // outside the clip a plain entry is silent
    expect(soundGainAt(plain, lineSound(), 0.9)).toBe(0);
    expect(soundGainAt(plain, lineSound(), 5.1)).toBe(0);
  });

  it('a crossfade replaces only its end\'s fade', () => {
    const p = proj([
      video('a', 0, 4, { trimStart: 5, fadeOut: 0.5 }),
      video('b', 4, 4, { trimStart: 5, fadeIn: 0.5, fadeOut: 0.5, crossfade: { before: 0.25, after: 0.25 } }),
    ]);
    const a = clipOf(p, 'a'), b = clipOf(p, 'b');
    const sa = entry(p, 'a'), sb = entry(p, 'b');
    // b: the fade in is not heard, the fade out is
    expect(soundFade(b, sb, 4.1)).toBe(1);
    expect(soundFade(b, sb, 8 - 0.1)).toBeCloseTo(0.2, 12);
    // a: its fade out is not heard, only the crossfade is, and it plays on after its end
    expect(soundFade(a, sa, 3.9)).toBe(1);
    expect(soundFade(a, sa, 4.1)).toBe(1);
    expect(soundGainAt(a, sa, 4.1)).toBeCloseTo(shapeIn('power', (4.25 - 4.1) / 0.5), 12);
    expect(soundGainAt(a, sa, 4.25)).toBe(0);
    expect(soundGainAt(a, sa, 4.3)).toBe(0);
    // b plays before its start
    expect(soundGainAt(b, sb, 3.7)).toBe(0);
    expect(soundGainAt(b, sb, 3.9)).toBeCloseTo(shapeIn('power', (3.9 - 3.75) / 0.5), 12);
    expect(soundGainAt(b, sb, 4.25)).toBe(1);
    // equal power: in² + out² = 1 anywhere in the span
    for (let t = 3.75; t <= 4.25; t += 0.01) expect(soundGainAt(a, sa, t) ** 2 + soundGainAt(b, sb, t) ** 2).toBeCloseTo(1, 12);
    expect(crossWeight(sb, 5)).toBe(1);
    expect(crossWeight(sa, 2)).toBe(1);
  });

  it('keyed volume holds its edge value in the handles', () => {
    const p = proj([
      video('a', 0, 4, { trimStart: 5, keyframes: { volume: lin([0, 1], [2, 0.5], [4, 2]) } }),
      video('b', 4, 4, { trimStart: 5, crossfade: { before: 0.5, after: 0.5 }, keyframes: { volume: lin([0, 0.5], [2, 1.5]) } }),
    ]);
    const a = clipOf(p, 'a'), b = clipOf(p, 'b');
    const sa = entry(p, 'a'), sb = entry(p, 'b');
    // before b starts: its first key value, times the weight
    expect(soundGainAt(b, sb, 3.8)).toBe(0.5 * 1 * crossWeight(sb, 3.8));
    // after a ends: its last key value, times the weight
    expect(soundGainAt(a, sa, 4.2)).toBe((valueAt(a, 'volume', 4) ?? 0) * 1 * crossWeight(sa, 4.2));
    expect(valueAt(a, 'volume', 4)).toBe(2);
    expect(soundGainAt(a, sa, 4.2)).toBeGreaterThan(0);
  });

  it('soundGainPoints: 33 points over a curved part, the ramp close to soundGainAt', () => {
    const bounds: Record<FadeShape, number> = { power: 0.0005, smooth: 0.001, linear: 1e-12 };
    for (const shape of FADE_SHAPES) {
      const p = proj([
        video('a', 0, 4, { trimStart: 5 }),
        video('b', 4, 4, { trimStart: 5, volume: 1, crossfade: { before: 0.25, after: 0.25, shape: shape === 'power' ? undefined : shape } }),
      ]);
      for (const id of ['a', 'b']) {
        const c = clipOf(p, id);
        const s = entry(p, id);
        const pts = soundGainPoints(c, s);
        const t0 = c.start - s.head;
        const span = s.xin ?? s.xout!;
        const inSpan = pts.filter(([t]) => t >= span.start - t0 - 1e-9 && t <= span.end - t0 + 1e-9);
        expect(inSpan.length).toBe(shape === 'linear' ? 3 : SHAPE_STEPS + 1);
        // linear has its two ends and the edit, a curve 32 steps (the edit is step 16)
        // sorted, from 0 to the whole length
        expect(pts[0]![0]).toBe(0);
        expect(pts.at(-1)![0]).toBeCloseTo(s.head + c.duration + s.tail, 12);
        for (let i = 1; i < pts.length; i++) expect(pts[i]![0]).toBeGreaterThanOrEqual(pts[i - 1]![0]);
        // every point is the gain rule
        for (const [t, g] of pts) expect(g).toBe(soundGainAt(c, s, t0 + t));
        // the export ramps linearly between the points
        let worst = 0;
        const D = s.head + c.duration + s.tail;
        for (let i = 0; i <= 2000; i++) {
          const t = (D * i) / 2000;
          let k = 1;
          while (k < pts.length - 1 && pts[k]![0] < t) k++;
          const [ta, ga] = pts[k - 1]!, [tb, gb] = pts[k]!;
          const ramp = tb - ta <= 1e-12 ? gb : ga + ((gb - ga) * (t - ta)) / (tb - ta);
          worst = Math.max(worst, Math.abs(ramp - soundGainAt(c, s, t0 + t)));
        }
        expect(worst).toBeLessThan(bounds[shape]);
      }
    }
  });

  it('soundGainPoints adds a clip fade with a shape and keyed volume', () => {
    const c = audio('f', 2, 4, { fadeIn: 1, fadeOut: 1, fadeInShape: 'smooth', keyframes: { volume: lin([0, 1], [2, 0.5]) } });
    const s: ClipSound = { head: 0, tail: 0, xin: null, xout: null, inShape: 'smooth', outShape: 'linear' };
    const pts = soundGainPoints(c, s);
    // the first point is the start, the fade in has 33 points, the keys add the grid
    expect(pts[0]).toEqual([0, 0]);
    expect(pts.some(([t]) => t === 2)).toBe(true);
    expect(pts.length).toBeGreaterThan(SHAPE_STEPS + 1 + 380);
    const plain = soundGainPoints(audio('g', 2, 4, { fadeIn: 1 }), lineSound());
    expect(plain.map(([t]) => t)).toEqual([0, 1, 4]);
  });
});
