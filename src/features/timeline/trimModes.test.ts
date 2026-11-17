import { describe, expect, it } from 'vitest';
import type { AudioClip, Clip, EffectClip, ImageClip, MediaAsset, Project, Track, VideoClip } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import { createProject } from '../../lib/factory';
import { clipEnd } from '../../lib/timelineOps';
import { transitionSpan } from '../../lib/transitions';
import { runTrimOps } from '../../store/editorStore';
import { edgePlan, editsAt, planMoveEdit, planRipple, planRippleToPlayhead, planSlide, planSlip, planStretch, simulateOps } from './trimModes';
import type { TrimPlan, TrimStopWhy } from './trimModes';

const track = (id: string, locked = false): Track => ({ id, kind: id.startsWith('a') ? 'audio' : 'video', name: id, muted: false, hidden: false, locked });
const asset = (id: string, duration: number, kind: 'video' | 'audio' = 'video'): MediaAsset => ({
  id, name: id, kind, mime: kind + '/x', size: 1, duration, width: 100, height: 100, hasAudio: true, createdAt: 0,
});
const video = (trackId: string, id: string, start: number, duration: number, o: Partial<VideoClip> = {}): VideoClip => ({
  id, type: 'video', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'long', trimStart: 0, speed: 1, volume: 1, muted: false, transform: { ...DEFAULT_TRANSFORM }, ...o,
});
const audio = (trackId: string, id: string, start: number, duration: number, o: Partial<AudioClip> = {}): AudioClip => ({
  id, type: 'audio', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'long', trimStart: 0, speed: 1, volume: 1, muted: false, ...o,
});
const image = (trackId: string, id: string, start: number, duration: number): ImageClip => ({
  id, type: 'image', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'pic', transform: { ...DEFAULT_TRANSFORM },
});
const fx = (trackId: string, id: string, target: string | null, start: number, duration: number, o: Partial<EffectClip> = {}): EffectClip => ({
  id, type: 'effect', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, effect: 'shake', params: {}, amount: 1, seed: 1, target, ...o,
});

const TRACKS = ['v1', 'v2', 'v3', 'a1', 'a2'];
function proj(clips: Clip[], o: { locked?: string[]; assets?: MediaAsset[] } = {}): Project {
  return {
    ...createProject('trim'),
    tracks: TRACKS.map((t) => track(t, o.locked?.includes(t))),
    assets: o.assets ?? [asset('long', 100), asset('short', 6), { ...asset('pic', 0), kind: 'image' }],
    clips,
  };
}
const SHORT = [asset('long', 100), asset('short', 6)];

/** the plan applied the way the store does it: it must land */
function apply(p: Project, plan: TrimPlan): Project {
  const out = runTrimOps(p, plan.ops);
  if (!out) throw new Error('runTrimOps refused ' + JSON.stringify(plan.ops));
  return out;
}
const get = (p: Project, id: string): Clip => p.clips.find((c) => c.id === id)!;
const span = (p: Project, id: string): [number, number] => [get(p, id).start, clipEnd(get(p, id))];
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

function expectStop(plan: TrimPlan, why: TrimStopWhy, clipId: string, otherId?: string): void {
  expect(plan.stop).toEqual(otherId === undefined ? { why, clipId } : { why, clipId, otherId });
}

/** a stop: the plan says why, its clamped delta is applied and lands */
function runStop(p: Project, plan: TrimPlan, delta: number, why: TrimStopWhy, clipId: string, otherId?: string): void {
  expectStop(plan, why, clipId, otherId);
  expect(plan.delta).toBeCloseTo(delta, 6);
  apply(p, plan);
}

describe('ripple', () => {
  const base = () => proj([
    video('v1', 'a', 0, 4, { trimStart: 3 }), video('v1', 'b', 4, 4, { trimStart: 2 }), video('v1', 'c', 8, 4),
    video('v2', 'y', 0, 3), video('v2', 'x', 6, 3),
  ]);

  it('ripple keeps no gap', () => {
    const p = base();
    const plan = planRipple(p, 'a', 'end', -1);
    expect(plan.stop).toBeNull();
    expect(plan.delta).toBe(-1);
    expect(plan.key).toBe('ripple:-1');
    expect([...plan.moved].sort()).toEqual(['b', 'c', 'x']);
    const out = apply(p, plan);
    expect(span(out, 'a')).toEqual([0, 3]);
    expect(span(out, 'b')).toEqual([3, 7]);
    expect(span(out, 'c')).toEqual([7, 11]);
    expect(span(out, 'x')).toEqual([5, 8]);
    expect(span(out, 'y')).toEqual([0, 3]);
    // growing pushes the rest right
    const grown = apply(p, planRipple(p, 'a', 'end', 2));
    expect(span(grown, 'a')).toEqual([0, 6]);
    expect(span(grown, 'b')).toEqual([6, 10]);
    expect(span(grown, 'x')).toEqual([8, 11]);
    // the start edge: the clip keeps its place, the rest follows
    const front = apply(p, planRipple(p, 'b', 'start', 1));
    expect(span(front, 'b')).toEqual([4, 7]);
    expect((get(front, 'b') as VideoClip).trimStart).toBe(3);
    expect(span(front, 'c')).toEqual([7, 11]);
    expect(span(front, 'x')).toEqual([5, 8]);
    const back = apply(p, planRipple(p, 'b', 'start', -1));
    expect(span(back, 'b')).toEqual([4, 9]);
    expect((get(back, 'b') as VideoClip).trimStart).toBe(1);
    expect(span(back, 'c')).toEqual([9, 13]);
  });

  it('ripple keeps keys with their picture', () => {
    const keyed = video('v1', 'b', 4, 4, { trimStart: 2, keyframes: { x: [{ t: 3, v: 1, ease: 'linear' }] } });
    const p = proj([video('v1', 'a', 0, 4), keyed, video('v1', 'c', 8, 4)]);
    const front = apply(p, planRipple(p, 'b', 'start', 1));
    expect(get(front, 'b').keyframes!.x![0]!.t).toBe(2);
    const back = apply(p, planRipple(p, 'b', 'start', -1));
    expect(get(back, 'b').keyframes!.x![0]!.t).toBe(4);
    // an end trim leaves them alone
    const tail = apply(p, planRipple(p, 'b', 'end', -1));
    expect(get(tail, 'b').keyframes!.x![0]!.t).toBe(3);
  });

  it('pool clips trim together, one per track', () => {
    const p = proj([
      video('v1', 'a', 0, 4), video('v1', 'e', 4, 2),
      video('v2', 'b', 0, 4), video('v2', 'f', 5, 2),
      video('v3', 'c', 0, 6),
      audio('a1', 'd', 0, 4), audio('a1', 'g', 4, 1),
    ]);
    const plan = planRipple(p, 'a', 'end', -1, ['a', 'b', 'c', 'd']);
    expect(plan.ops.filter((o) => o.kind === 'trim')).toHaveLength(3);
    const out = apply(p, plan);
    expect(span(out, 'a')).toEqual([0, 3]);
    expect(span(out, 'b')).toEqual([0, 3]);
    expect(span(out, 'd')).toEqual([0, 3]);
    // c ends elsewhere: it is not a head
    expect(span(out, 'c')).toEqual([0, 6]);
    expect(span(out, 'e')).toEqual([3, 5]);
    expect(span(out, 'f')).toEqual([4, 6]);
    expect(span(out, 'g')).toEqual([3, 4]);
    // alone: only the grabbed clip is a head
    const alone = apply(p, planRipple(p, 'a', 'end', -1));
    expect(span(alone, 'b')).toEqual([0, 4]);
  });

  it('pool clips on a locked track stay out and the track is told', () => {
    const p = proj([video('v1', 'a', 0, 4), video('v2', 'b', 0, 4), video('v2', 'k', 5, 1)], { locked: ['v2'] });
    const plan = planRipple(p, 'a', 'end', -1, ['a', 'b']);
    expect(plan.lockedBehind).toEqual(['v2']);
    const out = apply(p, plan);
    expect(span(out, 'b')).toEqual([0, 4]);
    expect(span(out, 'k')).toEqual([5, 6]);
  });

  it('followers keep timeOffset', () => {
    const p = proj([
      video('v1', 'a', 0, 4), video('v1', 'b', 4, 4),
      fx('v3', 'e', 'b', 4, 4, { timeOffset: 0.5 }),
    ]);
    // a ripple of an earlier clip moves the follower with its target, its offset is not touched
    const moved = apply(p, planRipple(p, 'a', 'end', -1));
    expect(span(moved, 'e')).toEqual(span(moved, 'b'));
    expect((get(moved, 'e') as EffectClip).timeOffset).toBe(0.5);
    // a ripple of the target itself edits the follower with it, the offset keeps what it shows
    const front = apply(p, planRipple(p, 'b', 'start', 1));
    expect(span(front, 'e')).toEqual(span(front, 'b'));
    expect((get(front, 'e') as EffectClip).timeOffset).toBe(1.5);
    const tail = apply(p, planRipple(p, 'b', 'end', -1));
    expect(span(tail, 'e')).toEqual([4, 7]);
    expect((get(tail, 'e') as EffectClip).timeOffset).toBe(0.5);
  });

  it('transitions keep their span', () => {
    const p = proj([
      video('v1', 'a', 1, 4), video('v1', 'b', 5, 4, { transition: { id: 'fade', duration: 1 } }),
      video('v2', 'z', 0, 1),
    ]);
    const before = transitionSpan(p, get(p, 'b'))!;
    const out = apply(p, planRipple(p, 'z', 'end', 1));
    const after = transitionSpan(out, get(out, 'b'))!;
    expect(after.end - after.start).toBeCloseTo(before.end - before.start, 9);
    expect(after.start - get(out, 'b').start).toBeCloseTo(before.start - get(p, 'b').start, 9);
    expect(after.from?.id).toBe('a');
  });

  it('a transition keeps its span when its own edit is trimmed', () => {
    const p = proj([video('v1', 'a', 1, 4), video('v1', 'b', 5, 4, { transition: { id: 'fade', duration: 1 } })]);
    const before = transitionSpan(p, get(p, 'b'))!;
    for (const plan of [planRipple(p, 'a', 'end', -1), planRipple(p, 'b', 'start', 1)]) {
      const out = apply(p, plan);
      const after = transitionSpan(out, get(out, 'b'))!;
      expect(after.from?.id).toBe('a');
      expect(after.end - after.start).toBeCloseTo(before.end - before.start, 9);
      expect(after.start - get(out, 'b').start).toBeCloseTo(before.start - get(p, 'b').start, 9);
    }
  });

  it('a clip that spans the edit stops it from another track', () => {
    const p = proj([video('v1', 'a', 0, 4), video('v1', 'b', 4, 2), video('v2', 'span', 2, 4), video('v2', 'm', 6, 2)]);
    const plan = planRipple(p, 'a', 'end', -1);
    // the spanning clip ends where m starts: nothing can move left
    expect(plan.delta).toBe(0);
    expectStop(plan, 'overlap', 'm', 'span');
    const grown = apply(p, planRipple(p, 'a', 'end', 1));
    expect(span(grown, 'span')).toEqual([2, 6]);
    expect(span(grown, 'm')).toEqual([7, 9]);
  });
});

describe('move the edit', () => {
  it('move the edit centres transitionSpan', () => {
    const p = proj([video('v1', 'a', 0, 4), video('v1', 'b', 4, 4, { transition: { id: 'fade', duration: 1 } })]);
    const out = apply(p, planMoveEdit(p, 'a', 'b', 1));
    expect(span(out, 'a')).toEqual([0, 5]);
    expect(span(out, 'b')).toEqual([5, 8]);
    const ts = transitionSpan(out, get(out, 'b'))!;
    expect((ts.start + ts.end) / 2).toBeCloseTo(5, 9);
    expect(ts.from?.id).toBe('a');
  });

  it('trims the media of both clips and moves nothing else', () => {
    const p = proj([video('v1', 'a', 0, 4, { trimStart: 1 }), video('v1', 'b', 4, 4, { trimStart: 3 }), video('v1', 'c', 8, 2), video('v2', 'x', 5, 2)]);
    const plan = planMoveEdit(p, 'a', 'b', -1);
    expect(plan.moved).toEqual([]);
    const out = apply(p, plan);
    expect(span(out, 'a')).toEqual([0, 3]);
    expect(span(out, 'b')).toEqual([3, 8]);
    expect((get(out, 'b') as VideoClip).trimStart).toBe(2);
    expect((get(out, 'a') as VideoClip).trimStart).toBe(1);
    expect(span(out, 'c')).toEqual([8, 10]);
    expect(span(out, 'x')).toEqual([5, 7]);
  });

  it('takes the pairs of the pool that sit at the same edit', () => {
    const p = proj([
      video('v1', 'a', 0, 4), video('v1', 'b', 4, 4),
      video('v2', 'c', 1, 3, { trimStart: 5 }), video('v2', 'd', 4, 4),
      video('v3', 'e', 0, 3), video('v3', 'f', 5, 2),
    ]);
    const out = apply(p, planMoveEdit(p, 'a', 'b', 1, ['a', 'b', 'c', 'd', 'e']));
    expect(span(out, 'a')).toEqual([0, 5]);
    expect(span(out, 'c')).toEqual([1, 5]);
    expect(span(out, 'd')).toEqual([5, 8]);
    // e does not end at the edit
    expect(span(out, 'e')).toEqual([0, 3]);
  });

  it('moves the effects that follow the clips', () => {
    const p = proj([video('v1', 'a', 0, 4), video('v1', 'b', 4, 4), fx('v3', 'ea', 'a', 0, 4), fx('v3', 'eb', 'b', 4, 4)]);
    const out = apply(p, planMoveEdit(p, 'a', 'b', 1));
    expect(span(out, 'ea')).toEqual([0, 5]);
    expect(span(out, 'eb')).toEqual([5, 8]);
  });
});

describe('slip', () => {
  it('slip touches only trimStart', () => {
    const v = video('v1', 'v', 2, 4, { trimStart: 5, fadeIn: 0.5, keyframes: { x: [{ t: 1, v: 2, ease: 'linear' }] } });
    const p = proj([v, video('v1', 'w', 6, 2), fx('v3', 'e', 'v', 2, 4)]);
    const plan = planSlip(p, 'v', 2);
    expect(plan.trimStart).toBe(7);
    expect(plan.delta).toBe(2);
    expect(plan.moved).toEqual([]);
    const out = apply(p, plan);
    expect(get(out, 'v')).toEqual({ ...v, trimStart: 7 });
    expect(get(out, 'e')).toEqual(get(p, 'e'));
    expect(get(out, 'w')).toEqual(get(p, 'w'));
  });

  it('a slip takes one clip per track from the pool', () => {
    const p = proj([video('v1', 'v', 0, 4, { trimStart: 5 }), audio('a1', 's1', 0, 2, { trimStart: 5 }), audio('a1', 's2', 2, 2, { trimStart: 5 })]);
    const out = apply(p, planSlip(p, 'v', 1, ['v', 's1', 's2']));
    expect((get(out, 's1') as AudioClip).trimStart).toBe(6);
    expect((get(out, 's2') as AudioClip).trimStart).toBe(5);
  });

  it('a same media sound slips along', () => {
    const p = proj(
      [
        video('v1', 'v', 0, 4, { assetId: 'av', trimStart: 5 }),
        audio('a1', 'au', 0, 4, { assetId: 'av', trimStart: 5 }),
        audio('a2', 'other', 0, 4, { assetId: 'long', trimStart: 5 }),
        audio('a2', 'late', 9, 2, { assetId: 'av', trimStart: 5 }),
      ],
      { assets: [asset('long', 100), asset('av', 50)] },
    );
    const out = apply(p, planSlip(p, 'v', 1, ['v', 'au', 'other', 'late']));
    expect((get(out, 'v') as VideoClip).trimStart).toBe(6);
    expect((get(out, 'au') as AudioClip).trimStart).toBe(6);
    expect((get(out, 'other') as AudioClip).trimStart).toBe(5);
    expect((get(out, 'late') as AudioClip).trimStart).toBe(5);
    const alone = apply(p, planSlip(p, 'v', 1, ['v']));
    expect((get(alone, 'au') as AudioClip).trimStart).toBe(5);
  });
});

describe('slide', () => {
  it('moves the clip and trims the neighbours to stay touching', () => {
    const p = proj([video('v1', 'l', 0, 4), video('v1', 'c', 4, 4), video('v1', 'r', 8, 4, { trimStart: 2 }), fx('v3', 'e', 'c', 4, 4)]);
    const out = apply(p, planSlide(p, 'c', 1));
    expect(span(out, 'l')).toEqual([0, 5]);
    expect(span(out, 'c')).toEqual([5, 9]);
    expect(span(out, 'r')).toEqual([9, 12]);
    expect((get(out, 'r') as VideoClip).trimStart).toBe(3);
    expect(span(out, 'e')).toEqual([5, 9]);
    const left = apply(p, planSlide(p, 'c', -2));
    expect(span(left, 'l')).toEqual([0, 2]);
    expect(span(left, 'c')).toEqual([2, 6]);
    expect(span(left, 'r')).toEqual([6, 12]);
    expect((get(left, 'r') as VideoClip).trimStart).toBe(0);
  });
});

describe('stretch', () => {
  it('stretch keeps the media span', () => {
    const p = proj([video('v1', 'v', 2, 4, { trimStart: 3 })]);
    const slow = planStretch(p, 'v', 'end', 4);
    expect(slow.speed).toBe(0.5);
    const out = apply(p, slow);
    const v = get(out, 'v') as VideoClip;
    expect(v.duration).toBe(8);
    expect(v.speed).toBe(0.5);
    expect(v.trimStart).toBe(3);
    expect(v.duration * v.speed).toBe(4);
    const front = apply(p, planStretch(p, 'v', 'start', -2));
    expect(span(front, 'v')).toEqual([0, 6]);
    expect((get(front, 'v') as VideoClip).speed).toBeCloseTo(4 / 6, 9);
    const fast = apply(p, planStretch(p, 'v', 'start', 2));
    expect(span(fast, 'v')).toEqual([4, 6]);
    expect((get(fast, 'v') as VideoClip).speed).toBe(2);
    const shorter = apply(p, planStretch(p, 'v', 'end', -2));
    expect(span(shorter, 'v')).toEqual([2, 4]);
    expect((get(shorter, 'v') as VideoClip).speed).toBe(2);
  });

  it('a pair stretches together, alone stretches one', () => {
    const p = proj([video('v1', 'v', 0, 4), audio('a1', 'au', 0, 4), audio('a2', 'x', 0, 4, { speed: 2 })]);
    const both = apply(p, planStretch(p, 'v', 'end', 4, ['v', 'au', 'x']));
    expect((get(both, 'v') as VideoClip).speed).toBe(0.5);
    expect((get(both, 'au') as AudioClip).speed).toBe(0.5);
    expect(get(both, 'au').duration).toBe(8);
    // another speed is not a partner
    expect(get(both, 'x')).toEqual(get(p, 'x'));
    const one = apply(p, planStretch(p, 'v', 'end', 4, ['v']));
    expect((get(one, 'v') as VideoClip).speed).toBe(0.5);
    expect(get(one, 'au')).toEqual(get(p, 'au'));
  });

  it('moves the effects that follow the clip', () => {
    const p = proj([video('v1', 'v', 2, 4), fx('v3', 'e', 'v', 2, 4)]);
    const out = apply(p, planStretch(p, 'v', 'start', -2));
    expect(span(out, 'e')).toEqual([0, 6]);
  });
});

describe('stops', () => {
  it('stops: ripple', () => {
    let p = proj([video('v1', 'a', 0, 4), video('v1', 'n', 4, 1)]);
    runStop(p, planRipple(p, 'a', 'end', -4), -3.95, 'min-length', 'a');
    runStop(p, planRipple(p, 'a', 'start', 4), 3.95, 'min-length', 'a');
    p = proj([video('v1', 'a', 0, 4, { assetId: 'short' })], { assets: SHORT });
    runStop(p, planRipple(p, 'a', 'end', 5), 2, 'media-end', 'a');
    p = proj([video('v1', 'a', 10, 4, { trimStart: 1 })]);
    runStop(p, planRipple(p, 'a', 'start', -3), -1, 'media-start', 'a');
    p = proj([video('v1', 'a', 0, 4), video('v2', 's', 0, 5), video('v2', 'c', 5.5, 3)]);
    runStop(p, planRipple(p, 'a', 'end', -1), -0.5, 'overlap', 'c', 's');
    p = proj([video('v1', 'h', 3, 5), video('v2', 'm', 3.5, 1.5)]);
    runStop(p, planRipple(p, 'h', 'start', 4), 3.5, 'timeline-start', 'm');
    p = proj([video('v1', 'a', 0, 4)], { locked: ['v1'] });
    const locked = planRipple(p, 'a', 'end', -1);
    expectStop(locked, 'locked', 'a');
    expect(locked.ops).toEqual([]);
  });

  it('stops: move-edit', () => {
    let p = proj([video('v1', 'a', 0, 4), video('v1', 'b', 4, 4, { trimStart: 10 })]);
    runStop(p, planMoveEdit(p, 'a', 'b', -5), -3.95, 'min-length', 'a');
    runStop(p, planMoveEdit(p, 'a', 'b', 5), 3.95, 'min-length', 'b');
    p = proj([video('v1', 'a', 0, 4, { assetId: 'short' }), video('v1', 'b', 4, 4)], { assets: SHORT });
    runStop(p, planMoveEdit(p, 'a', 'b', 3), 2, 'media-end', 'a');
    p = proj([video('v1', 'a', 0, 4), video('v1', 'b', 4, 4, { trimStart: 1 })]);
    runStop(p, planMoveEdit(p, 'a', 'b', -2), -1, 'media-start', 'b');
    p = proj([video('v1', 'a', 0, 4), video('v1', 'b', 5, 3)]);
    const gap = planMoveEdit(p, 'a', 'b', 1);
    expectStop(gap, 'no-edit', 'a');
    expect(gap.ops).toEqual([]);
    p = proj([video('v1', 'a', 0, 4), video('v1', 'b', 4, 4)], { locked: ['v1'] });
    expectStop(planMoveEdit(p, 'a', 'b', 1), 'locked', 'a');
  });

  it('stops: slip', () => {
    let p = proj([video('v1', 'v', 0, 4, { trimStart: 1 })]);
    runStop(p, planSlip(p, 'v', -3), -1, 'media-start', 'v');
    p = proj([video('v1', 'v', 0, 4, { assetId: 'short', trimStart: 1 })], { assets: SHORT });
    runStop(p, planSlip(p, 'v', 3), 1, 'media-end', 'v');
    p = proj([image('v1', 'i', 0, 4)]);
    expectStop(planSlip(p, 'i', 1), 'needs-media', 'i');
    p = proj([video('v1', 'v', 0, 4)], { locked: ['v1'] });
    expectStop(planSlip(p, 'v', 1), 'locked', 'v');
  });

  it('stops: slide', () => {
    let p = proj([video('v1', 'l', 0, 4), video('v1', 'c', 4, 4), video('v1', 'r', 8, 4, { trimStart: 1 })]);
    runStop(p, planSlide(p, 'c', -5), -1, 'media-start', 'r');
    runStop(p, planSlide(p, 'c', 5), 3.95, 'min-length', 'r');
    p = proj([video('v1', 'l', 0, 4), video('v1', 'c', 4, 4), video('v1', 'r', 8, 4, { trimStart: 9 })]);
    runStop(p, planSlide(p, 'c', -5), -3.95, 'min-length', 'l');
    p = proj([video('v1', 'l', 0, 4, { assetId: 'short' }), video('v1', 'c', 4, 4), video('v1', 'r', 8, 4)], { assets: SHORT });
    runStop(p, planSlide(p, 'c', 3), 2, 'media-end', 'l');
    p = proj([video('v1', 'p', 0, 2), video('v1', 'c', 4, 2)]);
    runStop(p, planSlide(p, 'c', -3), -2, 'overlap', 'c', 'p');
    p = proj([video('v1', 'c', 1, 4)]);
    runStop(p, planSlide(p, 'c', -3), -1, 'timeline-start', 'c');
    p = proj([video('v1', 'c', 0, 4), video('v1', 'n', 6, 2)]);
    runStop(p, planSlide(p, 'c', 3), 2, 'overlap', 'c', 'n');
    p = proj([video('v1', 'c', 0, 4)], { locked: ['v1'] });
    expectStop(planSlide(p, 'c', 1), 'locked', 'c');
  });

  it('stops: stretch', () => {
    let p = proj([video('v1', 'v', 2, 4)]);
    runStop(p, planStretch(p, 'v', 'end', 100), 12, 'speed-slow', 'v');
    runStop(p, planStretch(p, 'v', 'end', -3.5), -3, 'speed-fast', 'v');
    runStop(p, planStretch(p, 'v', 'start', -3), -2, 'timeline-start', 'v');
    p = proj([video('v1', 'v', 2, 0.1)]);
    runStop(p, planStretch(p, 'v', 'end', -0.08), -0.05, 'min-length', 'v');
    p = proj([video('v1', 'v', 2, 4), video('v1', 'n', 7, 2)]);
    runStop(p, planStretch(p, 'v', 'end', 2), 1, 'overlap', 'v', 'n');
    p = proj([video('v1', 'p', 0, 1.5), video('v1', 'v', 2, 4)]);
    runStop(p, planStretch(p, 'v', 'start', -1), -0.5, 'overlap', 'v', 'p');
    p = proj([image('v1', 'i', 0, 4)]);
    expectStop(planStretch(p, 'i', 'end', 1), 'needs-media', 'i');
    p = proj([video('v1', 'v', 0, 4)], { locked: ['v1'] });
    expectStop(planStretch(p, 'v', 'end', 1), 'locked', 'v');
  });

  it('a clip already past a limit does not get worse and does not jump', () => {
    // this clip is longer than the media it has left
    const p = proj([video('v1', 'a', 0, 8, { assetId: 'short', trimStart: 1 })], { assets: SHORT });
    const plan = planRipple(p, 'a', 'end', 1);
    expectStop(plan, 'media-end', 'a');
    expect(plan.ops).toEqual([]);
    // the store would snap a short shrink to the media end: no plan that lands somewhere else
    const short = planRipple(p, 'a', 'end', -1);
    expectStop(short, 'media-end', 'a');
    expect(short.ops).toEqual([]);
    const shrink = planRipple(p, 'a', 'end', -3);
    expect(shrink.stop).toBeNull();
    expect(span(apply(p, shrink), 'a')).toEqual([0, 5]);
  });

  it('a tighter bound on the other side does nothing instead of a plan that is refused', () => {
    // a is 3 s past its media and a clip on v2 stops it earlier than the media end
    const p = proj(
      [video('v1', 'a', 0, 8, { assetId: 'short', trimStart: 1 }), video('v1', 'n', 8, 2), video('v2', 's', 0, 7.6), video('v2', 'm', 8.1, 2)],
      { assets: SHORT },
    );
    const plan = planRipple(p, 'a', 'end', -3);
    expect(plan.delta).toBe(0);
    expect(plan.ops).toEqual([]);
    expect(plan.stop).not.toBeNull();
    const q = proj([video('v1', 'a', 0, 8, { assetId: 'short', trimStart: 1 }), video('v2', 's', 0, 7.5), video('v2', 'c', 8, 1)], { assets: SHORT });
    const tight = planRipple(q, 'a', 'end', -4);
    expect(tight.delta).toBe(0);
    expect(tight.ops).toEqual([]);
    expect(tight.stop).not.toBeNull();
    const move = proj([video('v1', 'a', 0, 8, { assetId: 'short', trimStart: 1 }), video('v1', 'b', 8, 4, { assetId: 'short', trimStart: 1 })], { assets: SHORT });
    const edit = planMoveEdit(move, 'a', 'b', -5);
    expect(edit.delta).toBe(0);
    expect(edit.ops).toEqual([]);
    expect(edit.stop).not.toBeNull();
    // a 0 ask is empty and has no stop
    const zero = planRipple(p, 'a', 'end', 0);
    expect(zero.ops).toEqual([]);
    expect(zero.stop).toBeNull();
  });
});

/** a few tracks of clips, effects and a transition: every mode, both edges and a few asks */
function mixed(): Project {
  return proj([
    video('v1', 'a', 0, 4, { trimStart: 2 }), video('v1', 'b', 4, 3, { trimStart: 1 }), video('v1', 'c', 8, 4, { trimStart: 4 }),
    video('v2', 'd', 0, 4, { trimStart: 2 }), video('v2', 'e', 4, 2), video('v2', 'f', 7, 5),
    audio('a1', 'g', 0, 4, { trimStart: 2 }), audio('a1', 'h', 4, 3, { trimStart: 1 }),
    fx('v3', 'fa', 'a', 0, 4), fx('v3', 'fb', 'b', 4, 3), fx('v3', 'free', null, 9, 2),
    video('v3', 'tail', 12, 3, { transition: { id: 'fade', duration: 1 } }),
  ]);
}

function plansOf(p: Project): TrimPlan[] {
  const out: TrimPlan[] = [];
  const all = ['a', 'd', 'g'];
  for (const delta of [-2, -0.5, 0.5, 1.5, 3]) {
    out.push(planRipple(p, 'a', 'end', delta, all), planRipple(p, 'b', 'start', delta, ['b', 'e']), planMoveEdit(p, 'a', 'b', delta, all), planMoveEdit(p, 'd', 'e', delta));
    out.push(planSlip(p, 'a', delta, all), planSlide(p, 'b', delta), planSlide(p, 'e', delta, ['e', 'b']), planStretch(p, 'a', 'end', delta, all), planStretch(p, 'b', 'start', delta));
  }
  return out;
}

describe('plans and the store', () => {
  it('the simulation equals runTrimOps', () => {
    const p = mixed();
    let checked = 0;
    for (const plan of plansOf(p)) {
      if (plan.ops.length === 0) continue;
      const out = apply(p, plan);
      const sim = simulateOps(p, plan.ops);
      for (const [id, s] of sim) {
        const c = get(out, id);
        expect(c.trackId).toBe(s.trackId);
        expect(near(c.start, s.start)).toBe(true);
        expect(near(clipEnd(c), s.end)).toBe(true);
      }
      // every clip that changed place is in the simulation
      for (const c of out.clips) {
        const was = get(p, c.id);
        if (!near(c.start, was.start) || !near(clipEnd(c), clipEnd(was))) expect(sim.has(c.id)).toBe(true);
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(20);
  });

  it('stop is null exactly when the whole ask is done', () => {
    const p = mixed();
    for (const delta of [-6, -2, -0.5, 0, 0.5, 1.5, 3, 9, 200]) {
      const plans = [
        planRipple(p, 'a', 'end', delta), planMoveEdit(p, 'a', 'b', delta), planSlide(p, 'b', delta),
        planSlip(p, 'a', delta), planStretch(p, 'a', 'end', delta), planStretch(p, 'b', 'start', delta),
      ];
      for (const plan of plans) {
        if (plan.stop === null) {
          expect(near(plan.delta, delta)).toBe(true);
          if (plan.ops.length === 0) expect(delta).toBe(0);
        } else {
          expect(Math.abs(delta - plan.delta)).toBeGreaterThan(1e-6);
        }
        expect(plan.key).toBe(`${plan.mode}:${plan.delta}`);
      }
    }
  });

  it('a missing clip and a zero ask are an empty plan without a stop', () => {
    const p = mixed();
    for (const plan of [planRipple(p, 'nope', 'end', 1), planMoveEdit(p, 'nope', 'b', 1), planSlip(p, 'nope', 1), planSlide(p, 'nope', 1), planStretch(p, 'nope', 'end', 1), planRipple(p, 'a', 'end', 0), planRipple(p, 'a', 'end', NaN)]) {
      expect(plan.ops).toEqual([]);
      expect(plan.stop).toBeNull();
      expect(plan.delta).toBe(0);
    }
  });

  it('a delta sweep over a 300 clip project never gives a plan runTrimOps refuses', () => {
    let seed = 20240607;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const clips: Clip[] = [];
    const layout: { start: number; duration: number }[] = [];
    let cursor = 0;
    for (let i = 0; i < 50; i++) {
      const duration = Math.round((0.2 + rand() * 3) * 30) / 30;
      layout.push({ start: cursor, duration });
      cursor += duration + (rand() < 0.3 ? Math.round(rand() * 20) / 30 : 0);
    }
    layout.forEach((l, i) => {
      const trimStart = Math.round(rand() * 20 * 30) / 30;
      clips.push(video('v1', 'v1_' + i, l.start, l.duration, { trimStart }));
      clips.push(i < 30 ? video('v2', 'v2_' + i, l.start, l.duration, { trimStart: 2 }) : video('v2', 'v2_' + i, l.start + 0.5, l.duration));
      clips.push(audio('a1', 'a1_' + i, l.start, l.duration, { trimStart }));
      clips.push(i < 40 ? fx('v3', 'fx_' + i, 'v1_' + i, l.start, l.duration, { timeOffset: rand() }) : fx('v3', 'fx_' + i, null, l.start, l.duration));
      clips.push(audio('a2', 'a2_' + i, l.start * 1.1 + 0.01, l.duration, { speed: 2 }));
      clips.push(video('v1', 'k_' + i, 200 + i * 3, 2));
    });
    const p = proj(clips, { locked: ['a2'] });
    expect(p.clips).toHaveLength(300);
    const overlaps = (q: Project): boolean => {
      for (const t of q.tracks) {
        const list = q.clips.filter((c) => c.trackId === t.id).sort((x, y) => x.start - y.start);
        for (let i = 1; i < list.length; i++) if (list[i]!.start < clipEnd(list[i - 1]!) - 1e-6) return true;
        if (list.length > 0 && list[0]!.start < -1e-6) return true;
      }
      return false;
    };
    expect(overlaps(p)).toBe(false);
    let applied = 0;
    for (let n = 0; n < 700; n++) {
      const c = p.clips[Math.floor(rand() * p.clips.length)]!;
      const mode = Math.floor(rand() * 5);
      const edge = rand() < 0.5 ? 'start' : 'end';
      const delta = Math.round((rand() - 0.5) * 2 * (rand() < 0.2 ? 40 : 3) * 30) / 30;
      const kind = rand();
      const pool = kind < 0.35 ? [] : kind < 0.7 ? p.clips.filter((x) => Math.abs(x.start - c.start) < 1e-6 && Math.abs(x.duration - c.duration) < 1e-6).map((x) => x.id) : p.clips.filter(() => rand() < 0.15).map((x) => x.id);
      let plan: TrimPlan;
      if (mode === 0) plan = planRipple(p, c.id, edge, delta, pool);
      else if (mode === 1) {
        const r = p.clips.filter((x) => x.trackId === c.trackId && Math.abs(x.start - clipEnd(c)) <= 1e-3)[0];
        plan = planMoveEdit(p, c.id, r ? r.id : 'none', delta, pool);
      } else if (mode === 2) plan = planSlip(p, c.id, delta, pool);
      else if (mode === 3) plan = planSlide(p, c.id, delta, pool);
      else plan = planStretch(p, c.id, edge, delta, pool);
      if (plan.ops.length === 0) continue;
      const out = runTrimOps(p, plan.ops);
      expect(out, `${plan.mode} ${c.id} ${edge} ${delta}`).not.toBeNull();
      expect(overlaps(out!), `${plan.mode} ${c.id} ${edge} ${delta}`).toBe(false);
      applied++;
    }
    expect(applied).toBeGreaterThan(250);
  });
});

describe('planRippleToPlayhead', () => {
  it('a title that would get too short stops the whole trim', () => {
    const p = proj([video('v1', 'v', 5, 5), image('v2', 't', 5, 1)]);
    const q = planRippleToPlayhead(p, [], 8, 'start');
    expect(q.plan?.stop?.why).toBe('min-length');
    expect(q.plan?.stop?.clipId).toBe('t');
  });

  it('planRippleToPlayhead', () => {
    const p = proj([video('v1', 'a', 0, 4), video('v2', 'b', 1, 5), video('v1', 'z', 9, 2)]);
    // q: the leader is the clip with the latest start under the playhead
    const q = planRippleToPlayhead(p, [], 3, 'start');
    expect(q.leader?.id).toBe('b');
    expect(q.reason).toBeNull();
    expect(q.plan?.delta).toBe(2);
    expect(q.plan?.stop).toBeNull();
    expect(span(apply(p, q.plan!), 'b')).toEqual([1, 4]);
    // w: the earliest end
    const w = planRippleToPlayhead(p, [], 3, 'end');
    expect(w.leader?.id).toBe('a');
    expect(w.plan?.delta).toBe(-1);
    expect(span(apply(p, w.plan!), 'a')).toEqual([0, 3]);
    // a selection limits the scope
    expect(planRippleToPlayhead(p, ['a'], 3, 'start').leader?.id).toBe('a');
    const off = planRippleToPlayhead(p, ['z'], 3, 'start');
    expect(off.plan).toBeNull();
    expect(off.reason).toBe('not-on-selection');
    const none = planRippleToPlayhead(p, [], 7.5, 'start');
    expect(none.plan).toBeNull();
    expect(none.leader).toBeNull();
    expect(none.reason).toBe('no-clip');
    // the edge of a clip is not under the playhead
    expect(planRippleToPlayhead(p, [], 4, 'end').leader?.id).toBe('b');
  });

  it('ties go to the first track, same edge clips of the scope trim together, locked tracks and followers are out', () => {
    const p = proj([video('v1', 'a', 0, 4), video('v2', 'b', 0, 4), video('v3', 'k', 0, 4), fx('v3', 'e', 'a', 0, 4)], { locked: ['v3'] });
    const r = planRippleToPlayhead(p, [], 2, 'end');
    expect(r.leader?.id).toBe('a');
    const trimmed = r.plan!.ops.filter((o) => o.kind === 'trim').map((o) => (o as { id: string }).id).sort();
    expect(trimmed).toEqual(['a', 'b']);
    const lockedOnly = proj([video('v1', 'k', 0, 4)], { locked: ['v1'] });
    const shut = planRippleToPlayhead(lockedOnly, [], 2, 'end');
    expect(shut.reason).toBe('locked');
    expect(shut.stop).toEqual({ why: 'locked', clipId: 'k' });
    expect(planRippleToPlayhead(lockedOnly, ['k'], 2, 'end').reason).toBe('locked');
  });

  it('a stop comes with the plan', () => {
    const p = proj([video('v1', 'a', 0, 4), video('v2', 's', 0, 5), video('v2', 'c', 5.5, 3)]);
    const r = planRippleToPlayhead(p, [], 3, 'end');
    // a and s are under the playhead, the earliest end leads. c on the other track is in the way: s ends 0.5 before it
    expect(r.leader?.id).toBe('a');
    expect(r.plan?.stop).toEqual({ why: 'overlap', clipId: 'c', otherId: 's' });
    expect(r.plan?.delta).toBeCloseTo(-0.5, 6);
    const q = planRippleToPlayhead(proj([video('v1', 'a', 0, 4), video('v1', 'n', 4, 1)]), [], 3.99, 'end');
    expect(q.plan?.delta).toBeCloseTo(-0.01, 6);
  });
});

describe('edgePlan', () => {
  it('edgePlan', () => {
    const p = proj([video('v1', 'a', 0, 4), video('v1', 'b', 4, 4), video('v2', 'g', 0, 3)]);
    expect(edgePlan(p, { clipId: 'gone', edge: 'end', both: false, alone: false }, 1, [])).toBeNull();
    const both = edgePlan(p, { clipId: 'a', edge: 'end', both: true, alone: false }, 1, [])!;
    expect(both.mode).toBe('move-edit');
    expect(span(apply(p, both), 'b')).toEqual([5, 8]);
    const none = edgePlan(p, { clipId: 'b', edge: 'end', both: true, alone: false }, 1, [])!;
    expectStop(none, 'no-edit', 'b');
    const single = edgePlan(p, { clipId: 'a', edge: 'end', both: false, alone: false }, -1, [])!;
    expect(single.mode).toBe('ripple');
    expect(span(apply(p, single), 'b')).toEqual([3, 7]);
    const pooled = edgePlan(p, { clipId: 'g', edge: 'end', both: false, alone: false }, 1, ['g', 'a'])!;
    expect(pooled.mode).toBe('ripple');
  });
});

describe('editsAt', () => {
  const p = proj([
    video('v1', 'a', 0, 4), video('v1', 'b', 4, 4), video('v1', 'c', 10, 2),
    video('v2', 'd', 1, 3), audio('a1', 'g', 4.004, 3), video('v3', 'k', 4, 2), fx('v3', 'e', 'a', 0, 4),
  ], { locked: ['v3'] });

  it('editsAt', () => {
    const at = editsAt(p, 4, 30);
    // a touching pair is one entry, the other tracks come in track order
    expect(at).toEqual([
      { clipId: 'a', edge: 'end', otherId: 'b' },
      { clipId: 'd', edge: 'end' },
      { clipId: 'g', edge: 'start' },
    ]);
    expect(editsAt(p, 4.03, 30)).toEqual([]);
    expect(editsAt(p, 4.01, 30)).toHaveLength(3);
    expect(editsAt(p, 10, 30)).toEqual([{ clipId: 'c', edge: 'start' }]);
    expect(editsAt(p, 0, 30)).toEqual([{ clipId: 'a', edge: 'start' }]);
  });

  it('puts the tracks of the preferred clips first and skips locked tracks and followers', () => {
    const at = editsAt(p, 4, 30, ['g']);
    expect(at[0]).toEqual({ clipId: 'g', edge: 'start' });
    expect(at.some((x) => x.clipId === 'k')).toBe(false);
    expect(at.some((x) => x.clipId === 'e')).toBe(false);
  });

  it('the nearer edge comes first on one track', () => {
    const q = proj([video('v1', 'a', 0, 1.99), video('v1', 'b', 2.05, 2)]);
    expect(editsAt(q, 2, 10).map((x) => x.clipId + ':' + x.edge)).toEqual(['a:end', 'b:start']);
  });
});
