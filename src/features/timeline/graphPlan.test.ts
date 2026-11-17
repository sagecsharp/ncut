import { describe, expect, it } from 'vitest';
import type { Clip, Easing, ImageClip, KeyHandle, Keyframe, Project } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import { createProject } from '../../lib/factory';
import { evalKeys } from '../../lib/anim';
import { INFLUENCE_EASY, isJoined, partHandles } from '../../lib/keyBezier';
import type { KeyRef } from '../../store/ui';
import { MAX_KEYS_PER_PROP } from '../properties/keyTools';
import { laneId } from './keySelection';
import { EMPTY_PLAN, planKeyMove } from './keyPlan';
import type { KeyPlan } from './keyPlan';
import { planAddKey, planEase, planGraphMove, planHandleSet, planJoin, planKeyValue, planValueStep } from './graphPlan';

const k = (t: number, v: number, ease: Easing = 'linear', extra: { in?: KeyHandle; out?: KeyHandle } = {}): Keyframe => ({ t, v, ease, ...extra });
const h = (speed: number, influence = INFLUENCE_EASY): KeyHandle => ({ speed, influence });
const image = (id: string, trackId: string, start: number, duration: number, keyframes: ImageClip['keyframes']): ImageClip => ({
  id, type: 'image', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'img1', transform: { ...DEFAULT_TRANSFORM }, keyframes,
});
function make(clips: (v: string, a: string) => Clip[], lockAudio = false): Project {
  const p = createProject('graph', undefined, 30);
  const v = p.tracks[0]!.id;
  const a = p.tracks[1]!.id;
  return { ...p, tracks: p.tracks.map((t) => (lockAudio && t.kind === 'audio' ? { ...t, locked: true } : t)), clips: clips(v, a) };
}
/** one clip 'a' of 10 s with these keys of x */
const one = (keys: Keyframe[], prop = 'x', duration = 10): Project => make((v) => [image('a', v, 0, duration, { [prop]: keys })]);
const ref = (clipId: string, prop: string, t: number): KeyRef => ({ clipId, prop, t });
const keysOf = (plan: KeyPlan, id = 'a', prop = 'x'): Keyframe[] => plan.writes.find((w) => w.id === id)!.keyframes[prop]!;
/** the largest gap between two key lists as lines, 101 points over 0 .. end */
function drift(p: Project, a: readonly Keyframe[], b: readonly Keyframe[], end: number, prop = 'x'): number {
  const clip = p.clips[0]!;
  let worst = 0;
  for (let i = 0; i <= 100; i++) worst = Math.max(worst, Math.abs(evalKeys(a, (end * i) / 100, clip, prop) - evalKeys(b, (end * i) / 100, clip, prop)));
  return worst;
}

describe('graphPlan', () => {
  it('move time like planKeyMove, value by the lane amount', () => {
    const p = one([k(0, 0), k(1, 10), k(2, 20), k(6, 60)]);
    const sel = [ref('a', 'x', 1), ref('a', 'x', 2)];
    const upp = new Map([[laneId('a', 'x'), 0.5]]);
    const plan = planGraphMove(p, sel, 2, -20, upp);
    const base = planKeyMove(p, sel, 2);
    expect(plan.stop).toBeNull();
    expect(plan.amount).toBe(base.amount);
    expect(plan.sel).toEqual(base.sel);
    const keys = keysOf(plan);
    expect(keys.map((x) => x.t)).toEqual(keysOf(base).map((x) => x.t));
    // 20 px up at 0.5 per px: +10
    expect(keys.map((x) => x.v)).toEqual([0, 20, 30, 60]);
    // a lane with no amount: its values stay, time still moves
    const flat = planGraphMove(p, sel, 1, 50, new Map());
    expect(keysOf(flat).map((x) => x.v)).toEqual([0, 10, 20, 60]);
    expect(keysOf(flat).map((x) => x.t)).toEqual([0, 2, 3, 6]);
    // the pointer that is not a number moves nothing in value
    expect(keysOf(planGraphMove(p, sel, 1, NaN, upp)).map((x) => x.v)).toEqual([0, 10, 20, 60]);
    // no live key
    expect(planGraphMove(p, [ref('zz', 'x', 1)], 1, 1, upp)).toEqual({ ...EMPTY_PLAN, sel: [ref('zz', 'x', 1)] });
  });

  it('value limits clamp, refuse, never block a key outside', () => {
    const p = one([k(0, 0.5), k(1, 0.9), k(2, 0.2)], 'opacity');
    const lane = laneId('a', 'opacity');
    const upp = new Map([[lane, 0.01]]);
    const sel = [ref('a', 'opacity', 0), ref('a', 'opacity', 1)];
    // 0.9 has 10 px up before 1, 0.5 has 50
    const up = planGraphMove(p, sel, 0, -20, upp);
    expect(up.stop).toEqual({ kind: 'valueMax', clipId: 'a', prop: 'opacity', t: 1 });
    expect(keysOf(up, 'a', 'opacity').map((x) => Number(x.v.toFixed(9)))).toEqual([0.6, 1, 0.2]);
    // 0.5 has 50 px down, 0.9 has 90
    const down = planGraphMove(p, sel, 0, 80, upp);
    expect(down.stop).toEqual({ kind: 'valueMin', clipId: 'a', prop: 'opacity', t: 0 });
    expect(keysOf(down, 'a', 'opacity').map((x) => Number(x.v.toFixed(9)))).toEqual([0, 0.4, 0.2]);
    // inside the room: no stop
    expect(planGraphMove(p, sel, 0, -5, upp).stop).toBeNull();
    // refuse: the stop and no write
    const no = planGraphMove(p, sel, 0, -20, upp, 'refuse');
    expect(no.writes).toEqual([]);
    expect(no.stop).toEqual({ kind: 'valueMax', clipId: 'a', prop: 'opacity', t: 1 });
    expect(no.sel).toEqual(sel);
    // a key already above the limit never blocks the way back down, and cannot go further up
    const out = one([k(0, 0.5), k(1, 1.5)], 'opacity');
    const back = planGraphMove(out, [ref('a', 'opacity', 0), ref('a', 'opacity', 1)], 0, 20, upp);
    expect(back.stop).toBeNull();
    expect(keysOf(back, 'a', 'opacity').map((x) => Number(x.v.toFixed(9)))).toEqual([0.3, 1.3]);
    const further = planGraphMove(out, [ref('a', 'opacity', 1)], 0, -20, upp);
    expect(further.stop?.kind).toBe('valueMax');
    expect(keysOf(further, 'a', 'opacity')[1]!.v).toBeCloseTo(1.5, 9);
    // keys without limits (x) never stop
    expect(planGraphMove(one([k(0, 0), k(1, 1)]), [ref('a', 'x', 0)], 0, -1e6, new Map([[laneId('a', 'x'), 1]])).stop).toBeNull();
    // set and add stay inside the limits
    const set = planKeyValue(p, sel, { set: 2 });
    expect(keysOf(set, 'a', 'opacity').map((x) => x.v)).toEqual([1, 1, 0.2]);
    expect(set.amount).toBe(2);
    const add = planKeyValue(p, sel, { add: -0.6 });
    expect(keysOf(add, 'a', 'opacity').map((x) => Number(x.v.toFixed(9)))).toEqual([0, 0.3, 0.2]);
    expect(planKeyValue(p, sel, {}).writes).toEqual([]);
    expect(planKeyValue(p, [ref('a', 'opacity', 2)], { set: 0.2 }).amount).toBe(0);
  });

  it('a time stop wins', () => {
    const p = one([k(0, 0.5), k(3, 0.9), k(8, 0.2)], 'opacity');
    const upp = new Map([[laneId('a', 'opacity'), 0.01]]);
    const sel = [ref('a', 'opacity', 3)];
    // 7 s of room, 5 s more asked, and 20 px up with 10 px of room
    const both = planGraphMove(p, sel, 9, -20, upp);
    expect(both.stop).toEqual({ kind: 'end', clipId: 'a' });
    expect(keysOf(both, 'a', 'opacity')[2]!.t).toBeCloseTo(10, 9);
    // refuse: the time stop, never written
    const refuse = planGraphMove(p, sel, 9, -20, upp, 'refuse');
    expect(refuse.stop).toEqual({ kind: 'end', clipId: 'a' });
    expect(refuse.writes).toEqual([]);
    // a key in the way: no write, whatever the value
    const q = one([k(0, 0.5), k(1, 0.9), k(2, 0.2)], 'opacity');
    const way = planGraphMove(q, [ref('a', 'opacity', 1)], 1, -50, upp);
    expect(way.stop?.kind).toBe('inTheWay');
    expect(way.writes).toEqual([]);
  });

  it('handles ride along', () => {
    const keys = [k(0, 0, 'bezier', { out: h(50, 0.4) }), k(1, 10, 'bezier', { in: h(5, 0.2), out: h(7, 0.6) }), k(3, 30, 'linear', { in: h(9, 0.3) })];
    const p = one(keys);
    const plan = planGraphMove(p, [ref('a', 'x', 0), ref('a', 'x', 1)], 0.5, -10, new Map([[laneId('a', 'x'), 1]]));
    const out = keysOf(plan);
    expect(out.map((x) => x.t)).toEqual([0.5, 1.5, 3]);
    expect(out.map((x) => x.v)).toEqual([10, 20, 30]);
    expect(out[0]!.out).toEqual(h(50, 0.4));
    expect(out[1]!.in).toEqual(h(5, 0.2));
    expect(out[1]!.out).toEqual(h(7, 0.6));
    expect(out[2]!.in).toEqual(h(9, 0.3));
  });

  it('no jump on smooth', () => {
    const keys = [k(0, 0, 'ease'), k(1, 100, 'ease'), k(3, 40, 'linear'), k(4, 90, 'ease-in'), k(5, 10)];
    const p = one(keys);
    // each side of each key, its own effective handle written back
    for (let i = 0; i < keys.length; i++) {
      for (const side of ['in', 'out'] as const) {
        const j = side === 'out' ? i : i - 1;
        if (j < 0 || j >= keys.length - 1) continue;
        const eff = partHandles(keys[j]!, keys[j + 1]!)![side];
        const plan = planHandleSet(p, [ref('a', 'x', keys[i]!.t)], side, { speed: eff.speed, influence: eff.influence }, true);
        expect(plan.stop).toBeNull();
        const next = keysOf(plan);
        expect(drift(p, keys, next, 5)).toBeLessThan(1e-9);
        // the part gets its name back
        expect(next).toEqual(keys);
      }
    }
    // a real change: the speed at the key is the one given, the other end stays
    const plan = planHandleSet(p, [ref('a', 'x', 1)], 'out', { speed: 30 }, true);
    const next = keysOf(plan);
    expect(next[1]!.ease).toBe('bezier');
    expect(next[1]!.out).toEqual(h(30));
    expect(next[2]!.in).toEqual(h(0));
    expect(plan.amount).toBe(1);
    expect(evalKeys(next, 3, p.clips[0]!, 'x')).toBeCloseTo(40, 9);
    // the same handle again changes nothing
    expect(planHandleSet({ ...p, clips: [{ ...p.clips[0]!, keyframes: { x: next } } as Clip] }, [ref('a', 'x', 1)], 'out', { speed: 30 }, true).amount).toBe(0);
  });

  it('joined vs alone', () => {
    const keys = [k(0, 0, 'bezier', { out: h(10, 0.3) }), k(1, 10, 'bezier', { in: h(20, 0.3), out: h(20, 0.4) }), k(2, 0, 'linear', { in: h(-5, 0.5) })];
    const p = one(keys);
    expect(isJoined(keys, 1)).toBe(true);
    const sel = [ref('a', 'x', 1)];
    // joined: the speed goes to both sides, the influences stay
    const both = keysOf(planHandleSet(p, sel, 'out', { speed: 50 }, false));
    expect(both[1]!.out).toEqual(h(50, 0.4));
    expect(both[1]!.in).toEqual(h(50, 0.3));
    const fromIn = keysOf(planHandleSet(p, sel, 'in', { speed: 40 }, false));
    expect(fromIn[1]!.in).toEqual(h(40, 0.3));
    expect(fromIn[1]!.out).toEqual(h(40, 0.4));
    // alone (alt): the handles break
    const alone = keysOf(planHandleSet(p, sel, 'out', { speed: 50 }, true));
    expect(alone[1]!.out).toEqual(h(50, 0.4));
    expect(alone[1]!.in).toEqual(h(20, 0.3));
    // an influence never rides along
    const infl = keysOf(planHandleSet(p, sel, 'out', { influence: 0.7 }, false));
    expect(infl[1]!.out).toEqual(h(20, 0.7));
    expect(infl[1]!.in).toEqual(h(20, 0.3));
    // a key that is not joined keeps its other side
    const broken = one([keys[0]!, { ...keys[1]!, out: h(25, 0.4) }, keys[2]!]);
    expect(isJoined(broken.clips[0]!.keyframes!.x!, 1)).toBe(false);
    const single = keysOf(planHandleSet(broken, sel, 'out', { speed: 60 }, false));
    expect(single[1]!.out).toEqual(h(60, 0.4));
    expect(single[1]!.in).toEqual(h(20, 0.3));
  });

  it('noHandles on hold, bounce, elastic and the ends', () => {
    const p = one([k(0, 0, 'hold'), k(1, 10, 'bounce'), k(2, 20, 'elastic'), k(3, 30)]);
    const at = (t: number) => [ref('a', 'x', t)];
    for (const [t, side] of [[0, 'in'], [0, 'out'], [1, 'in'], [1, 'out'], [2, 'in'], [2, 'out'], [3, 'in'], [3, 'out']] as const) {
      const plan = planHandleSet(p, at(t), side, { speed: 5 }, true);
      expect(plan.stop).toEqual({ kind: 'noHandles', clipId: 'a' });
      expect(plan.writes).toEqual([]);
      expect(plan.sel).toEqual(at(t));
    }
    expect(planJoin(p, [ref('a', 'x', 1), ref('a', 'x', 2)]).stop).toEqual({ kind: 'noHandles', clipId: 'a' });
    expect(planJoin(p, [ref('a', 'x', 0), ref('a', 'x', 3)]).stop?.kind).toBe('noHandles');
    // one key with a handle among others without: it is the only one written
    const mixed = one([k(0, 0, 'hold'), k(1, 10), k(2, 20)]);
    const plan = planHandleSet(mixed, [ref('a', 'x', 0), ref('a', 'x', 1)], 'out', { speed: 4 }, true);
    expect(plan.stop).toBeNull();
    expect(plan.amount).toBe(1);
    expect(keysOf(plan)[0]!.ease).toBe('hold');
    expect(keysOf(plan)[1]!.out).toEqual(h(4));
  });

  it('easy ease on linear keys gives ease', () => {
    const p = one([k(0, 0), k(1, 10)]);
    const both = planEase(p, [ref('a', 'x', 0), ref('a', 'x', 1)], 'easy');
    expect(both.amount).toBe(2);
    expect(both.holds).toBe(0);
    expect(both.stop).toBeNull();
    expect(keysOf(both)).toEqual([k(0, 0, 'ease'), k(1, 10, 'linear')]);
    // already eased: it still counts
    const again = one([k(0, 0, 'ease'), k(1, 10)]);
    expect(planEase(again, [ref('a', 'x', 0), ref('a', 'x', 1)], 'easy').amount).toBe(2);
    // a middle key: custom parts around it, both sides flat
    const mid = one([k(0, 0), k(1, 10), k(2, 40)]);
    const easy = keysOf(planEase(mid, [ref('a', 'x', 1)], 'easy'));
    expect(easy[0]!.ease).toBe('bezier');
    expect(easy[0]!.out).toEqual(h(10));
    expect(easy[1]!.in).toEqual(h(0));
    expect(easy[1]!.out).toEqual(h(0));
    expect(easy[2]!.in).toEqual(h(30));
    // into and out of: one side
    const into = keysOf(planEase(mid, [ref('a', 'x', 1)], 'into'));
    expect(into[1]!.in).toEqual(h(0));
    expect(into[1]!.ease).toBe('linear');
    const outOf = planEase(mid, [ref('a', 'x', 1)], 'outOf');
    expect(keysOf(outOf)[1]!.out).toEqual(h(0));
    expect(keysOf(outOf)[1]!.in).toBeUndefined();
    expect(drift(mid, mid.clips[0]!.keyframes!.x!, keysOf(planEase(mid, [ref('a', 'x', 0), ref('a', 'x', 2)], 'easy')), 2)).toBeGreaterThan(0);
    // the first key has no side arriving, the last none leaving
    expect(planEase(mid, [ref('a', 'x', 0)], 'into').amount).toBe(0);
    expect(planEase(mid, [ref('a', 'x', 2)], 'outOf').amount).toBe(0);
    // no live key
    const none = planEase(mid, [ref('zz', 'x', 0)], 'easy');
    expect(none.holds).toBe(0);
    expect(none.sel).toEqual([ref('zz', 'x', 0)]);
  });

  it('holds kept and counted', () => {
    const p = one([k(0, 0, 'hold'), k(1, 10), k(2, 20)]);
    const easy = planEase(p, [ref('a', 'x', 1)], 'easy');
    expect(easy.holds).toBe(1);
    expect(easy.amount).toBe(1);
    expect(keysOf(easy)[0]!.ease).toBe('hold');
    expect(keysOf(easy)[1]!.out).toEqual(h(0));
    expect(keysOf(easy)[1]!.in).toBeUndefined();
    // only the held side asked: nothing to do, and it says why
    const into = planEase(p, [ref('a', 'x', 1)], 'into');
    expect(into.holds).toBe(1);
    expect(into.amount).toBe(0);
    expect(into.writes).toEqual([]);
    expect(into.stop).toBeNull();
    // two keys next to holds
    const two = one([k(0, 0, 'hold'), k(1, 10, 'hold'), k(2, 20)]);
    expect(planEase(two, [ref('a', 'x', 1), ref('a', 'x', 2)], 'easy').holds).toBe(2);
  });

  it('join averages', () => {
    const keys = [k(0, 0, 'bezier', { out: h(0, 0.3) }), k(1, 10, 'bezier', { in: h(10, 0.25), out: h(30, 0.4) }), k(2, 5, 'linear', { in: h(0, 0.3) })];
    const p = one(keys);
    const plan = planJoin(p, [ref('a', 'x', 1)]);
    expect(plan.amount).toBe(1);
    expect(plan.stop).toBeNull();
    const out = keysOf(plan);
    expect(out[1]!.in).toEqual(h(20, 0.25));
    expect(out[1]!.out).toEqual(h(20, 0.4));
    expect(isJoined(out, 1)).toBe(true);
    // joined already: nothing, no stop
    const done = one(out);
    const again = planJoin(done, [ref('a', 'x', 1)]);
    expect(again.amount).toBe(0);
    expect(again.stop).toBeNull();
    expect(again.writes).toEqual([]);
    // named parts: their twins give the speeds
    const lin = one([k(0, 0), k(1, 10), k(2, 0)]);
    const j = keysOf(planJoin(lin, [ref('a', 'x', 1)]));
    expect(j[1]!.in).toEqual(h(0));
    expect(j[1]!.out).toEqual(h(0));
    // the ends have one side only
    expect(planJoin(lin, [ref('a', 'x', 0), ref('a', 'x', 2)]).stop?.kind).toBe('noHandles');
    // a key that cannot join and one that can: the one that can is written
    expect(planJoin(lin, [ref('a', 'x', 0), ref('a', 'x', 1)]).amount).toBe(1);
  });

  it('value step refuses at a limit', () => {
    const p = one([k(0, 0.5), k(1, 0.995), k(2, 0.005)], 'opacity');
    const step = new Map([[laneId('a', 'opacity'), 0.01]]);
    const mid = planValueStep(p, [ref('a', 'opacity', 0)], 1, step);
    expect(mid.stop).toBeNull();
    expect(keysOf(mid, 'a', 'opacity')[0]!.v).toBeCloseTo(0.51, 9);
    expect(mid.amount).toBe(1);
    expect(keysOf(planValueStep(p, [ref('a', 'opacity', 0)], -10, step), 'a', 'opacity')[0]!.v).toBeCloseTo(0.4, 9);
    // one key that would pass the top refuses every key
    const top = planValueStep(p, [ref('a', 'opacity', 0), ref('a', 'opacity', 1)], 1, step);
    expect(top.stop).toEqual({ kind: 'valueMax', clipId: 'a', prop: 'opacity', t: 1 });
    expect(top.writes).toEqual([]);
    expect(top.amount).toBe(0);
    const low = planValueStep(p, [ref('a', 'opacity', 0), ref('a', 'opacity', 2)], -1, step);
    expect(low.stop).toEqual({ kind: 'valueMin', clipId: 'a', prop: 'opacity', t: 2 });
    expect(low.writes).toEqual([]);
    // landing on the limit is allowed
    const edge = one([k(0, 0.99)], 'opacity');
    const hit = planValueStep(edge, [ref('a', 'opacity', 0)], 1, step);
    expect(hit.stop).toBeNull();
    expect(keysOf(hit, 'a', 'opacity')[0]!.v).toBeLessThanOrEqual(1);
    expect(keysOf(hit, 'a', 'opacity')[0]!.v).toBeCloseTo(1, 9);
    // a lane without a step stays, the others step
    const two = make((v) => [image('a', v, 0, 10, { opacity: [k(0, 0.5)], x: [k(0, 7)] })]);
    const plan = planValueStep(two, [ref('a', 'opacity', 0), ref('a', 'x', 0)], 2, step);
    expect(keysOf(plan, 'a', 'opacity')[0]!.v).toBeCloseTo(0.52, 9);
    expect(keysOf(plan, 'a', 'x')[0]!.v).toBe(7);
    expect(plan.amount).toBe(1);
    // no step at all: nothing is written
    expect(planValueStep(two, [ref('a', 'x', 0)], 1, step).writes).toEqual([]);
    expect(planValueStep(two, [ref('a', 'opacity', 0)], 0, step).writes).toEqual([]);
    // handles ride along
    const hd = one([k(0, 0, 'bezier', { out: h(3) }), k(1, 5, 'linear', { in: h(4) })]);
    const r = keysOf(planValueStep(hd, [ref('a', 'x', 0)], 1, new Map([[laneId('a', 'x'), 2]])));
    expect(r[0]!.v).toBe(2);
    expect(r[0]!.out).toEqual(h(3));
  });

  it('add key keeps the line', () => {
    // custom
    const custom = [k(0, 0, 'bezier', { out: h(200, 0.4) }), k(2, 100, 'linear', { in: h(-30, 0.3) })];
    const pc = one(custom);
    const plan = planAddKey(pc, 'a', 'x', 0.7);
    const next = keysOf(plan);
    expect(next.length).toBe(3);
    expect(next[1]!.t).toBe(0.7);
    expect(plan.sel).toEqual([ref('a', 'x', 0.7)]);
    expect(plan.amount).toBe(1);
    expect(plan.stop).toBeNull();
    // the time solve stops at 1e-9 of a share: speeds of 200 show it as 1e-7
    expect(drift(pc, custom, next, 2)).toBeLessThan(1e-6);
    // named parts: a smooth one becomes two custom halves on the same line
    for (const ease of ['ease', 'ease-in', 'ease-out', 'back'] as const) {
      const keys = [k(0, 0, ease), k(2, 100)];
      const pn = one(keys);
      const n = keysOf(planAddKey(pn, 'a', 'x', 0.9));
      expect(n.length).toBe(3);
      expect(drift(pn, keys, n, 2)).toBeLessThan(1e-9);
    }
    // a straight part stays straight, named again
    const lin = keysOf(planAddKey(one([k(0, 0), k(2, 100)]), 'a', 'x', 0.5));
    expect(lin.map((x) => x.ease)).toEqual(['linear', 'linear', 'linear']);
    expect(lin.some((x) => x.in || x.out)).toBe(false);
    expect(lin[1]!.v).toBeCloseTo(25, 9);
    // a cut value outside the limits sits on the bound: the store would clamp it and bend the halves
    const op = one([k(0, 1, 'bezier', { out: h(-5, 1 / 3) }), k(2, 0)], 'opacity');
    const cut = keysOf(planAddKey(op, 'a', 'opacity', 1.5), 'a', 'opacity');
    expect(cut.length).toBe(3);
    expect(cut.every((x) => x.v >= 0 && x.v <= 1)).toBe(true);
    expect(cut[1]!.v).toBe(0);
    expect(cut[1]!.in!.speed).toBe(0);
    expect(cut[1]!.out!.speed).toBe(0);
    // a hold is still a hold, at the value it holds
    const hold = keysOf(planAddKey(one([k(0, 3, 'hold'), k(2, 10)]), 'a', 'x', 1));
    expect(hold).toEqual([k(0, 3, 'hold'), k(1, 3, 'hold'), k(2, 10)]);
    // after the last key: the value stays
    const tail = one([k(0, 0), k(2, 100)]);
    const after = keysOf(planAddKey(tail, 'a', 'x', 3));
    expect(after.map((x) => x.t)).toEqual([0, 2, 3]);
    expect(after[2]!.v).toBe(100);
    expect(drift(tail, tail.clips[0]!.keyframes!.x!, after, 5)).toBe(0);
    // on a key: select it, write nothing
    const on = planAddKey(pc, 'a', 'x', 2.00005);
    expect(on.writes).toEqual([]);
    expect(on.sel).toEqual([ref('a', 'x', 2)]);
    // a part a hair long: the nearest key
    const hair = planAddKey(one([k(0, 0, 'bezier'), k(0.00015, 1)]), 'a', 'x', 0.00008);
    expect(hair.writes).toEqual([]);
    expect(hair.sel.length).toBe(1);
    // bounce has no handles: a key at the value there
    const bounce = keysOf(planAddKey(one([k(0, 0, 'bounce'), k(2, 100)]), 'a', 'x', 1));
    expect(bounce.length).toBe(3);
    expect(bounce[1]!.v).toBeCloseTo(evalKeys([k(0, 0, 'bounce'), k(2, 100)], 1), 9);
    // the other keys of the clip are carried along
    const pair = make((v) => [image('a', v, 0, 10, { x: [k(0, 0), k(2, 100)], y: [k(0, 1)] })]);
    expect(plan.writes.length).toBe(1);
    expect(planAddKey(pair, 'a', 'x', 1).writes[0]!.keyframes.y).toEqual([k(0, 1)]);
    // nothing to add to
    expect(planAddKey(pair, 'zz', 'x', 1)).toEqual({ ...EMPTY_PLAN, sel: [] });
    expect(planAddKey(pair, 'a', 'rotation', 1)).toEqual({ ...EMPTY_PLAN, sel: [] });
    expect(planAddKey(pair, 'a', 'x', NaN)).toEqual({ ...EMPTY_PLAN, sel: [] });
    expect(planAddKey(pair, 'a', 'x', -1).stop).toEqual({ kind: 'start', clipId: 'a', prop: 'x' });
    expect(planAddKey(pair, 'a', 'x', 11).stop).toEqual({ kind: 'end', clipId: 'a', prop: 'x' });
  });

  it('add key refuses at 240', () => {
    const many = (n: number) => one(Array.from({ length: n }, (_, i) => k(i, i)), 'x', 300);
    const full = planAddKey(many(MAX_KEYS_PER_PROP), 'a', 'x', 10.5);
    expect(full.stop).toEqual({ kind: 'end', clipId: 'a', prop: 'x' });
    expect(full.writes).toEqual([]);
    const room = planAddKey(many(MAX_KEYS_PER_PROP - 1), 'a', 'x', 10.5);
    expect(room.stop).toBeNull();
    expect(keysOf(room).length).toBe(MAX_KEYS_PER_PROP);
  });

  it('locked skipped', () => {
    const p = make((v, a) => [image('a', v, 0, 10, { x: [k(0, 0), k(1, 10), k(2, 30)] }), image('b', a, 0, 10, { x: [k(0, 0), k(1, 10), k(2, 30)] })], true);
    const both = [ref('a', 'x', 1), ref('b', 'x', 1)];
    const upp = new Map([[laneId('a', 'x'), 1], [laneId('b', 'x'), 1]]);
    const move = planGraphMove(p, both, 0.5, -5, upp);
    expect(move.writes.map((w) => w.id)).toEqual(['a']);
    expect(planKeyValue(p, both, { add: 3 }).writes.map((w) => w.id)).toEqual(['a']);
    expect(planValueStep(p, both, 1, upp).writes.map((w) => w.id)).toEqual(['a']);
    expect(planEase(p, both, 'easy').writes.map((w) => w.id)).toEqual(['a']);
    expect(planJoin(p, both).writes.map((w) => w.id)).toEqual(['a']);
    expect(planHandleSet(p, both, 'out', { speed: 3 }, true).writes.map((w) => w.id)).toEqual(['a']);
    // only a locked one: nothing, the selection stays
    const only = [ref('b', 'x', 1)];
    for (const plan of [planGraphMove(p, only, 1, 1, upp), planKeyValue(p, only, { set: 1 }), planValueStep(p, only, 1, upp), planEase(p, only, 'easy'), planJoin(p, only), planHandleSet(p, only, 'in', { speed: 1 }, true)]) {
      expect(plan.writes).toEqual([]);
      expect(plan.stop).toBeNull();
      expect(plan.sel).toEqual(only);
    }
    expect(planAddKey(p, 'b', 'x', 0.5).stop).toEqual({ kind: 'locked', clipId: 'b', prop: 'x' });
  });
});
