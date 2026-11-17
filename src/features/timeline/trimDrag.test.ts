import { describe, expect, it } from 'vitest';
import type { Clip, MediaAsset, Project, Track, VideoClip } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import { createProject } from '../../lib/factory';
import { dragDelta, formatTrimDelta, planFor, readoutText } from './trimDrag';
import { planMoveEdit, planRipple, planSlide, planSlip, planStretch } from './trimModes';
import type { TrimPlan } from './trimModes';
import { trimPress } from './trimPress';
import type { PressMods, PressZone } from './trimPress';

const track = (id: string, locked = false): Track => ({ id, kind: 'video', name: id, muted: false, hidden: false, locked });
const asset = (id: string, duration: number): MediaAsset => ({ id, name: id, kind: 'video', mime: 'video/x', size: 1, duration, width: 100, height: 100, hasAudio: true, createdAt: 0 });
const video = (trackId: string, id: string, start: number, duration: number, o: Partial<VideoClip> = {}): VideoClip => ({
  id, type: 'video', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'long', trimStart: 0, speed: 1, volume: 1, muted: false, transform: { ...DEFAULT_TRANSFORM }, ...o,
});
function proj(clips: Clip[]): Project {
  return { ...createProject('drag'), tracks: [track('v1'), track('v2')], assets: [asset('long', 100)], clips };
}
const NONE: PressMods = { ctrl: false, shift: false, alt: false };
const press = (p: Project, id: string, zone: PressZone, m: Partial<PressMods> = {}) => trimPress(p, id, zone, { ...NONE, ...m }, true)!;

const P = proj([video('v1', 'a', 0, 4, { trimStart: 5 }), video('v1', 'b', 4, 4, { trimStart: 5 }), video('v1', 'c', 10, 4, { trimStart: 5 }), video('v2', 'x', 0, 2)]);

describe('dragDelta', () => {
  it('drags move whole frames at 24, 25, 30 and 60 fps', () => {
    for (const fps of [24, 25, 30, 60]) {
      for (const raw of [0, 0.013, 0.2, -0.37, 1.234, -2.9]) {
        const r = dragDelta({ raw, fps, edges: [3], points: [], threshold: 0.1 });
        expect(r.snap).toBeNull();
        const frames = r.delta * fps;
        expect(Math.abs(frames - Math.round(frames))).toBeLessThan(1e-9);
        expect(Math.abs(r.delta - raw)).toBeLessThanOrEqual(0.5 / fps + 1e-9);
      }
    }
    expect(dragDelta({ raw: 0.04, fps: 24, edges: [], points: [], threshold: 1 }).delta).toBeCloseTo(1 / 24, 9);
    expect(Object.is(dragDelta({ raw: -0.001, fps: 24, edges: [], points: [], threshold: 1 }).delta, 0)).toBe(true);
  });

  it('the nearest point in the threshold snaps any edge', () => {
    // two edges at 2 and 6, the pointer moved 1.03: they would land on 3.03 and 7.03
    const a = { raw: 1.03, fps: 30, edges: [2, 6], points: [3, 7.05, 9], threshold: 0.1 };
    const r = dragDelta(a);
    expect(r.snap).toBe(7.05);
    expect(r.delta).toBeCloseTo(1.05, 9);
    // the first edge wins when it is nearer
    const n = dragDelta({ ...a, points: [3.01, 7.06] });
    expect(n.snap).toBe(3.01);
    expect(n.delta).toBeCloseTo(1.01, 9);
    // out of the threshold: whole frames
    const far = dragDelta({ ...a, points: [3.5, 8], threshold: 0.1 });
    expect(far.snap).toBeNull();
    expect(far.delta).toBeCloseTo(31 / 30, 9);
    // a point exactly at the threshold still counts
    expect(dragDelta({ raw: 0.5, fps: 30, edges: [0], points: [0.75], threshold: 0.25 }).snap).toBe(0.75);
  });

  it('slip has no edges and never snaps', () => {
    const r = dragDelta({ raw: 1.03, fps: 30, edges: [], points: [1, 1.02, 1.04], threshold: 5 });
    expect(r.snap).toBeNull();
    expect(r.delta).toBeCloseTo(31 / 30, 9);
  });
});

describe('formatTrimDelta', () => {
  it('formatTrimDelta gives 0f, +12f, -3f, +00:01:04 at 24 fps', () => {
    expect(formatTrimDelta(0, 24)).toBe('0f');
    expect(formatTrimDelta(0.5, 24)).toBe('+12f');
    expect(formatTrimDelta(-3 / 24, 24)).toBe('-3f');
    expect(formatTrimDelta(28 / 24, 24)).toBe('+00:01:04');
    expect(formatTrimDelta(-28 / 24, 24)).toBe('-00:01:04');
  });
});

describe('readoutText', () => {
  const clip = (p: Project, id: string, o: Partial<VideoClip>) => ({ ...p, clips: p.clips.map((c) => (c.id === id ? ({ ...c, ...o } as Clip) : c)) });

  it('readoutText for every mode', () => {
    const fps = P.fps;
    const q = clip(P, 'a', { duration: 3 });
    const base = (mode: TrimPlan['mode'], o: Partial<TrimPlan>): TrimPlan => ({ mode, ops: [], delta: 0, stop: null, moved: [], lockedBehind: [], key: mode + ':0', ...o });
    expect(readoutText(base('ripple', { delta: -3 / fps }), null, q, 'a', fps)).toBe('ripple -3f, length 00:03:00');
    expect(readoutText(base('move-edit', { delta: 12 / fps }), null, q, 'a', fps)).toBe('move the edit +12f');
    expect(readoutText(base('slip', { delta: -2 / fps, trimStart: 2 }), null, q, 'a', fps)).toBe('slip -2f, first frame at 00:02:00 of the media');
    expect(readoutText(base('slide', { delta: 0 }), null, q, 'a', fps)).toBe('slide 0f');
    expect(readoutText(base('stretch', { delta: 1 / fps, speed: 0.5 }), null, q, 'a', fps)).toBe('stretch 0.50x, length 00:03:00');
    expect(readoutText(base('stretch', { speed: 1.3333 }), null, q, 'a', fps)).toBe('stretch 1.33x, length 00:03:00');
  });

  it('readoutText on an empty slip or stretch plan reads the clip', () => {
    const fps = P.fps;
    const q = clip(P, 'a', { trimStart: 20, speed: 2 });
    const base = (mode: TrimPlan['mode']): TrimPlan => ({ mode, ops: [], delta: 0, stop: null, moved: [], lockedBehind: [], key: mode + ':0' });
    expect(readoutText(base('slip'), null, q, 'a', fps)).toBe('slip 0f, first frame at 00:20:00 of the media');
    expect(readoutText(base('stretch'), null, q, 'a', fps)).toMatch(/^stretch 2\.00x, length /);
  });

  it('readoutText adds the stop and the locked suffix', () => {
    const fps = P.fps;
    const plan: TrimPlan = { mode: 'ripple', ops: [], delta: 0.5, stop: { why: 'overlap', clipId: 'b', otherId: 'c' }, moved: [], lockedBehind: ['v2'], key: 'ripple:0.5' };
    expect(readoutText(plan, plan.stop, P, 'a', fps)).toBe(`ripple ${formatTrimDelta(0.5, fps)}, length 00:04:00, stops: "b" would run into "c", locked tracks stay`);
    expect(readoutText({ ...plan, lockedBehind: [] }, plan.stop, P, 'a', fps)).toBe(`ripple ${formatTrimDelta(0.5, fps)}, length 00:04:00, stops: "b" would run into "c"`);
    expect(readoutText({ ...plan, stop: null }, null, P, 'a', fps)).toBe(`ripple ${formatTrimDelta(0.5, fps)}, length 00:04:00, locked tracks stay`);
    // a clip that is gone has no length
    expect(readoutText({ ...plan, stop: null, lockedBehind: [] }, null, P, 'zz', fps)).toBe(`ripple ${formatTrimDelta(0.5, fps)}, length 00:00:00`);
  });
});

describe('planFor', () => {
  it('planFor picks the planner of the press', () => {
    const d = 0.5;
    const same = (a: TrimPlan | null, b: TrimPlan) => expect(a).toEqual(b);
    same(planFor(press(P, 'c', 'end'), P, d, []), planRipple(P, 'c', 'end', d, []));
    same(planFor(press(P, 'c', 'start'), P, d, ['c', 'x']), planRipple(P, 'c', 'start', d, ['c', 'x']));
    same(planFor(press(P, 'a', 'end'), P, d, ['a']), planMoveEdit(P, 'a', 'b', d, ['a']));
    same(planFor(press(P, 'b', 'start'), P, d, []), planMoveEdit(P, 'a', 'b', d, []));
    same(planFor(press(P, 'b', 'band'), P, d, []), planMoveEdit(P, 'a', 'b', d, []));
    same(planFor(press(P, 'c', 'end', { shift: true }), P, d, []), planStretch(P, 'c', 'end', d, []));
    same(planFor(press(P, 'c', 'body', { alt: true }), P, d, []), planSlide(P, 'c', d, []));
    // a slip: the media goes with the pointer, so the delta is turned around and takes the speed
    same(planFor(press(P, 'c', 'body'), P, d, []), planSlip(P, 'c', -d, []));
    const fast = proj([video('v1', 'f', 0, 4, { trimStart: 10, speed: 2 })]);
    same(planFor(press(fast, 'f', 'body'), fast, 0.5, []), planSlip(fast, 'f', -1, []));
    // nothing for a plain move or a clip that is gone
    expect(planFor({ ...press(P, 'a', 'body'), mode: 'move' }, P, d, [])).toBeNull();
    expect(planFor(press(P, 'c', 'end'), { ...P, clips: P.clips.filter((c) => c.id !== 'c') }, d, [])).toBeNull();
    expect(planFor(press(P, 'a', 'end'), { ...P, clips: P.clips.filter((c) => c.id !== 'b') }, d, [])).toBeNull();
  });
});
