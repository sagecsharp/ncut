import { beforeEach, describe, expect, it } from 'vitest';
import { evalKeys, keyRange } from '../../lib/anim';
import { speedAt } from '../../lib/keyBezier';
import { usePlayback } from '../../store/playback';
import { addVideoClip, call, clipOf, ed, fresh, oneStepOf, refused } from './editKit';

let id = '';
beforeEach(async () => {
  fresh();
  id = (await call('add_text', { text: 'k', start: 2, duration: 4 })).data.id as string;
});

describe('set_keyframe', () => {
  it('adds keys at timeline times, one undo step each, sorted, and answers the keys', async () => {
    const r = await oneStepOf(() => call('set_keyframe', { id, prop: 'x', time: 2, value: -100 }));
    expect(r.data.keys).toEqual([{ t: 0, time: 2, v: -100, ease: 'ease' }]);
    const r2 = await oneStepOf(() => call('set_keyframe', { id, prop: 'x', time: 5, value: 100, ease: 'bounce' }));
    expect(r2.data.keys.map((k: any) => [k.time, k.t, k.v, k.ease])).toEqual([
      [2, 0, -100, 'ease'],
      [5, 3, 100, 'bounce'],
    ]);
    // value defaults to the value there, and values are limited
    const r3 = await call('set_keyframe', { id, prop: 'opacity', time: 3, value: 9 });
    expect(r3.data.keys[0].v).toBe(1);
    const r4 = await call('set_keyframe', { id, prop: 'rotation', time: 3 });
    expect(r4.data.keys[0].v).toBe(0);
  });

  it('refuses a time outside, an unknown prop (listing them), a locked clip, no change', async () => {
    await refused('set_keyframe', { id, prop: 'x', time: 1 }, /outside the clip/);
    await refused('set_keyframe', { id, prop: 'x', time: 7 }, /outside the clip/);
    await refused('set_keyframe', { id, prop: 'banana', time: 3 }, /no animatable property "banana".*opacity/);
    await refused('set_keyframe', { id, prop: 'x', time: 3, ease: 'wobble' }, /must be one of/);
    await call('set_keyframe', { id, prop: 'x', time: 3, value: 5, ease: 'linear' });
    await refused('set_keyframe', { id, prop: 'x', time: 3, value: 5, ease: 'linear' }, /already exists/);
    ed().updateTrack(clipOf(id).trackId, { locked: true });
    await refused('set_keyframe', { id, prop: 'x', time: 4 }, /locked/);
  });

  it('keys an effect param and refuses a wrong one', async () => {
    const e = (await call('add_effect', { effect: 'echo', start: 0, duration: 3 })).data.id as string;
    const r = await oneStepOf(() => call('set_keyframe', { id: e, prop: 'p.count', time: 1, value: 9 }));
    expect(r.data.keys[0].v).toBe(9);
    await refused('set_keyframe', { id: e, prop: 'p.nope', time: 1 }, /no animatable property/);
    await refused('set_keyframe', { id: e, prop: 'x', time: 1 }, /no animatable property/);
  });

  it('asks for a value when the property has none yet', async () => {
    const c = (await call('add_camera', { start: 0, duration: 3 })).data.id as string;
    await refused('set_keyframe', { id: c, prop: 'focusDistance', time: 1 }, /give a value: focusDistance has no value on this clip yet/);
    await refused('set_keyframe', { id: c, prop: 'fov', time: 99999 }, /at most 86400/);
  });

  it('keys a camera', async () => {
    const c = (await call('add_camera', { start: 0, duration: 3 })).data.id as string;
    const r = await call('set_keyframe', { id: c, prop: 'fov', time: 1, value: 30 });
    expect(r.data.keys[0].v).toBe(30);
  });
});

describe('remove_keyframe', () => {
  it('removes a key, one step, and lists the key times when there is none there', async () => {
    await call('set_keyframe', { id, prop: 'x', time: 2, value: 1 });
    await call('set_keyframe', { id, prop: 'x', time: 4, value: 2 });
    const r = await oneStepOf(() => call('remove_keyframe', { id, prop: 'x', time: 4 }));
    expect(r.data.keys.length).toBe(1);
    await refused('remove_keyframe', { id, prop: 'x', time: 3 }, /no key at 3 s.*2/);
    await refused('remove_keyframe', { id, prop: 'y', time: 2 }, /no keys.*keyed: x/);
    // the last key leaves its value
    await call('remove_keyframe', { id, prop: 'x', time: 2 });
    expect(clipOf(id).keyframes).toBeUndefined();
    expect((clipOf(id) as any).transform.x).toBe(1);
  });
});

describe('set_keyframes', () => {
  it('replaces the whole record in one step, t from the clip start', async () => {
    await call('set_keyframe', { id, prop: 'y', time: 3, value: 50 });
    const r = await oneStepOf(() =>
      call('set_keyframes', {
        id,
        keyframes: {
          x: [
            { t: 3, v: 100, ease: 'linear' },
            { t: 0, v: -100 },
          ],
          opacity: [{ t: 0, v: 5 }],
        },
      }),
    );
    expect(Object.keys(r.data.keyframes).sort()).toEqual(['opacity', 'x']);
    expect(r.data.keyframes.x.map((k: any) => k.t)).toEqual([0, 3]);
    expect(r.data.keyframes.x[0].time).toBe(2);
    expect(r.data.keyframes.opacity[0].v).toBe(1);
    expect(clipOf(id).keyframes?.y).toBeUndefined();
  });

  it('{} removes all keys', async () => {
    await call('set_keyframe', { id, prop: 'y', time: 3, value: 50 });
    await oneStepOf(() => call('set_keyframes', { id, keyframes: {} }));
    expect(clipOf(id).keyframes).toBeUndefined();
  });

  it('reports dropped props and bad keys as errors, and no change', async () => {
    await refused('set_keyframes', { id, keyframes: { banana: [{ t: 0, v: 1 }], x: [{ t: 0, v: 1 }] } }, /cannot animate "banana"/);
    await refused('set_keyframes', { id, keyframes: { x: [{ t: 9, v: 1 }] } }, /keys live between 0 and 4/);
    await refused('set_keyframes', { id, keyframes: { x: [{ t: 0 }] } }, /\.v must be a number/);
    await refused('set_keyframes', { id, keyframes: { x: [{ t: 0, v: 1, ease: 'zig' }] } }, /ease must be one of/);
    await refused('set_keyframes', { id, keyframes: { x: 5 } }, /must be an array/);
    await refused('set_keyframes', { id, keyframes: {} }, /already has exactly/);
    await call('set_keyframes', { id, keyframes: { x: [{ t: 0, v: 1, ease: 'ease' }] } });
    await refused('set_keyframes', { id, keyframes: { x: [{ t: 0, v: 1 }] } }, /already has exactly/);
  });
});

describe('clear_keyframes', () => {
  it('clears one prop or all, freezing the value at the playhead', async () => {
    await call('set_keyframes', {
      id,
      keyframes: {
        x: [
          { t: 0, v: 0, ease: 'linear' },
          { t: 4, v: 400, ease: 'linear' },
        ],
        y: [{ t: 0, v: 7 }],
      },
    });
    usePlayback.getState().seek(4);
    const r = await oneStepOf(() => call('clear_keyframes', { id, prop: 'x' }));
    expect(r.data.cleared).toEqual(['x']);
    expect(Object.keys(r.data.keyframes)).toEqual(['y']);
    expect((clipOf(id) as any).transform.x).toBe(200);
    const r2 = await oneStepOf(() => call('clear_keyframes', { id }));
    expect(r2.data.cleared).toEqual(['y']);
    expect(clipOf(id).keyframes).toBeUndefined();
    await refused('clear_keyframes', { id }, /no keyframes/);
  });

  it('refuses a prop without keys', async () => {
    await call('set_keyframe', { id, prop: 'x', time: 3, value: 1 });
    await refused('clear_keyframes', { id, prop: 'y' }, /no keys.*keyed: x/);
  });
});

describe('set_keyframe grade and pan', () => {
  it('keys grade.liftR on a video and a grade effect, refuses it on blur', async () => {
    const v = addVideoClip(fresh().video, 0);
    const r = await oneStepOf(() => call('set_keyframe', { id: v, prop: 'grade.liftR', time: 0, value: 0.2 }));
    expect(r.data.keys[0].v).toBe(0.2);
    await call('set_keyframe', { id: v, prop: 'grade.offsetY', time: 1, value: -0.3 });
    expect((clipOf(v).keyframes?.['grade.offsetY'] ?? []).length).toBe(1);
    const fx = (await call('add_effect', { effect: 'grade', start: 0, duration: 3 })).data.id as string;
    const k = await call('set_keyframe', { id: fx, prop: 'grade.gainB', time: 0, value: 0.4 });
    expect(k.ok, k.text).toBe(true);
    const blur = (await call('add_effect', { effect: 'blur', start: 0, duration: 3 })).data.id as string;
    await refused('set_keyframe', { id: blur, prop: 'grade.liftR', time: 0, value: 0.2 }, /no animatable property "grade.liftR"/);
  });

  it('keys pan on a video clip', async () => {
    const v = addVideoClip(fresh().video, 0);
    const r = await oneStepOf(() => call('set_keyframe', { id: v, prop: 'pan', time: 0, value: -1 }));
    expect(r.data.keys[0].v).toBe(-1);
    const r2 = await call('set_keyframe', { id: v, prop: 'pan', time: 1, value: 5 });
    expect(r2.data.keys.at(-1).v).toBe(1);
  });
});

/** x keys at timeline seconds 2, 3, 4, 5 (local 0, 1, 2, 3) of the 4 s text clip, values 0, 100, 200, 300 */
async function keyed(prop = 'x', ease = 'ease'): Promise<void> {
  const keys = [0, 1, 2, 3].map((t) => ({ t, v: t * 100, ease }));
  const r = await call('set_keyframes', { id, keyframes: { [prop]: keys } });
  expect(r.ok, r.text).toBe(true);
}
const keyTimes = (cid: string, prop = 'x') => (clipOf(cid).keyframes?.[prop] ?? []).map((k) => Math.round(k.t * 1000) / 1000);

describe('retime_keyframes', () => {
  it('moves the named keys by seconds, in one step, and keeps value and ease', async () => {
    await keyed();
    const r = await oneStepOf(() => call('retime_keyframes', { keys: [{ id, prop: 'x', times: [4, 5] }], by: -0.5 }));
    expect(r.data).toEqual({ moved: 2, clips: 1 });
    expect(keyTimes(id)).toEqual([0, 1, 1.5, 2.5]);
    expect(clipOf(id).keyframes!.x!.map((k) => k.v)).toEqual([0, 100, 200, 300]);
  });

  it('no prop and no times: every key inside the clip of every keyed property', async () => {
    await call('set_keyframes', { id, keyframes: { x: [{ t: 0, v: 0 }, { t: 1, v: 1 }], opacity: [{ t: 0, v: 0 }, { t: 1, v: 1 }] } });
    const r = await call('retime_keyframes', { keys: [{ id }], by: 1 });
    expect(r.ok, r.text).toBe(true);
    expect(r.data).toEqual({ moved: 4, clips: 1 });
    expect(keyTimes(id)).toEqual([1, 2]);
    expect(keyTimes(id, 'opacity')).toEqual([1, 2]);
  });

  it('frames move by whole frames, scale stretches around a time', async () => {
    await keyed();
    await call('retime_keyframes', { keys: [{ id, prop: 'x', times: [5] }], frames: -3 });
    expect(keyTimes(id)[3]).toBeCloseTo(2.9, 3);
    await keyed();
    const r = await oneStepOf(() => call('retime_keyframes', { keys: [{ id, prop: 'x', times: [4, 5] }], scale: 0.5, around: 4 }));
    expect(r.data.moved).toBe(2);
    expect(keyTimes(id)).toEqual([0, 1, 2, 2.5]);
  });

  it('scale around the playhead when around is missing', async () => {
    await keyed();
    usePlayback.getState().seek(2);
    const r = await call('retime_keyframes', { keys: [{ id, prop: 'x', times: [3, 4, 5] }], scale: 0.5 });
    expect(r.ok, r.text).toBe(true);
    // the playhead is 2 s on the timeline = local 0: the keys at local 1, 2 and 3 come to 0.5, 1 and 1.5
    expect(keyTimes(id)).toEqual([0, 0.5, 1, 1.5]);
  });

  it('refuses keys that would leave the clip and says how far they can go', async () => {
    await keyed();
    await refused('retime_keyframes', { keys: [{ id, prop: 'x', times: [2, 3] }], by: -1 }, /the keys would leave clip ".*": they can move 0 to 3 s/);
    await refused('retime_keyframes', { keys: [{ id, prop: 'x', times: [4, 5] }], by: 2 }, /they can move -2 to 1 s/);
    await refused('retime_keyframes', { keys: [{ id, prop: 'x', times: [4, 5] }], scale: 10, around: 2 }, /scale can be [\d.]+ to [\d.]+ here/);
  });

  it('refuses keys that would land on a key that stays', async () => {
    await keyed();
    await refused('retime_keyframes', { keys: [{ id, prop: 'x', times: [3] }], by: 1 }, /a key of "x" at 4 s is in the way: name it too or move less/);
    const r = await call('retime_keyframes', { keys: [{ id, prop: 'x', times: [3, 4, 5] }], by: 1 });
    expect(r.ok, r.text).toBe(true);
  });

  it('a missing key, a prop without keys, no change, a bad choice and a locked clip are errors', async () => {
    await keyed();
    await refused('retime_keyframes', { keys: [{ id, prop: 'x', times: [3.5] }], by: 0.1 }, /no key of "x" at 3.5 s. it has keys at: 2, 3, 4, 5 s/);
    await refused('retime_keyframes', { keys: [{ id, prop: 'opacity' }], by: 0.1 }, /"opacity" has no keys on this clip. keyed: x/);
    await refused('retime_keyframes', { keys: [{ id, prop: 'x' }], by: 0 }, /nothing changed/);
    await refused('retime_keyframes', { keys: [{ id, prop: 'x' }] }, /give one of by, frames or scale/);
    await refused('retime_keyframes', { keys: [{ id, prop: 'x' }], by: 1, frames: 2 }, /give one of by, frames or scale/);
    await refused('retime_keyframes', { keys: [{ id, prop: 'x' }], by: 1, around: 1 }, /around goes with scale/);
    await refused('retime_keyframes', { keys: [{ id, prop: 'x' }], frames: 1.5 }, /must be an integer/);
    await refused('retime_keyframes', { keys: [{ id, prop: 'x' }], scale: 0 }, /at least 0.01/);
    await refused('retime_keyframes', { keys: [], by: 1 }, /at least 1 item/);
    await refused('retime_keyframes', { keys: [{ id: 'ghost' }], by: 1 }, /no clip with the id ghost/);
    ed().updateTrack(clipOf(id).trackId, { locked: true });
    await refused('retime_keyframes', { keys: [{ id, prop: 'x' }], by: 0.1 }, /locked/);
  });
});

describe('ease_keyframes', () => {
  it('sets a named ease on the keys, one step, and says what changed', async () => {
    await keyed();
    const r = await oneStepOf(() => call('ease_keyframes', { keys: [{ id, prop: 'x', times: [2, 3] }], ease: 'linear' }));
    expect(r.data).toEqual({ changed: 2, clips: 1 });
    expect(clipOf(id).keyframes!.x!.map((k) => k.ease)).toEqual(['linear', 'linear', 'ease', 'ease']);
  });

  it('nothing to change is an error and leaves no step', async () => {
    await keyed();
    await refused('ease_keyframes', { keys: [{ id, prop: 'x' }], ease: 'ease' }, /nothing changed/);
  });

  it('easy ease makes custom parts and counts the holds it kept', async () => {
    await keyed('x', 'linear');
    const r = await oneStepOf(() => call('ease_keyframes', { keys: [{ id, prop: 'x', times: [3] }], easy: 'both' }));
    expect(r.data.changed).toBe(1);
    expect(r.data.holds_kept).toBe(0);
    expect(clipOf(id).keyframes!.x!.some((k) => k.ease === 'bezier')).toBe(true);
  });
});

describe('copy_keyframes', () => {
  it('copies to other clips and answers left_out', async () => {
    const vid = addVideoClip(fresh().video, 10);
    await call('set_keyframes', { id: vid, keyframes: { volume: [{ t: 0, v: 0.5 }, { t: 1, v: 1 }], x: [{ t: 0, v: 5 }, { t: 1, v: 9 }] } });
    const to = (await call('add_text', { text: 't2', start: 20, duration: 4 })).data.id as string;
    const r = await oneStepOf(() => call('copy_keyframes', { from: vid, to: [to] }));
    expect(r.data).toEqual({ pasted: 2, clips: 1, left_out: ['volume'] });
    expect(keyTimes(to)).toEqual([0, 1]);
    // the source keeps its keys
    expect(keyTimes(vid)).toEqual([0, 1]);
  });

  it('without at keeps the place of the first key in each clip, with at it goes there', async () => {
    await call('set_keyframes', { id, keyframes: { x: [{ t: 1, v: 1 }, { t: 2, v: 2 }] } });
    const to = (await call('add_text', { text: 't2', start: 20, duration: 4 })).data.id as string;
    await call('copy_keyframes', { from: id, to: [to] });
    expect(keyTimes(to)).toEqual([1, 2]);
    const to2 = (await call('add_text', { text: 't3', start: 30, duration: 4 })).data.id as string;
    await call('copy_keyframes', { from: id, to: [to2], at: 30 });
    expect(keyTimes(to2)).toEqual([0, 1]);
  });

  it('onto itself needs at, a place outside the targets and a source without keys are errors', async () => {
    await keyed();
    await refused('copy_keyframes', { from: id, to: [id] }, /copying a clip onto itself needs at/);
    const to = (await call('add_text', { text: 't2', start: 10, duration: 4 })).data.id as string;
    await refused('copy_keyframes', { from: id, to: [to], at: 50 }, /no keys land inside the targets: give at inside them/);
    await refused('copy_keyframes', { from: to, to: [id] }, /has no keyframes/);
    await refused('copy_keyframes', { from: id, props: ['opacity'], to: [to] }, /"opacity" has no keys on this clip. keyed: x/);
  });

  it('leaves the keyframe panel clipboard alone', async () => {
    const { getKeyCopy } = await import('../../features/properties/keyClipboard');
    await keyed();
    const to = (await call('add_text', { text: 't2', start: 10, duration: 4 })).data.id as string;
    const before = getKeyCopy();
    await call('copy_keyframes', { from: id, to: [to] });
    expect(getKeyCopy()).toBe(before);
  });
});

describe('handles', () => {
  const H = (speed: number, influence: number) => ({ speed, influence });

  it('in and out round trip through set_keyframe and answer only when there', async () => {
    const plain = await call('set_keyframe', { id, prop: 'x', time: 2, value: 0 });
    expect(plain.data.keys[0]).toEqual({ t: 0, time: 2, v: 0, ease: 'ease' });
    const r = await oneStepOf(() => call('set_keyframe', { id, prop: 'x', time: 5, value: 100, in: H(0, 0.5) }));
    expect(r.data.keys[0]).toMatchObject({ ease: 'bezier' });
    expect(r.data.keys[1]).toMatchObject({ in: { speed: 0, influence: 0.5 } });
    const o = await call('set_keyframe', { id, prop: 'x', time: 2, out: H(30, 0.25) });
    expect(o.data.keys[0].out).toEqual(H(30, 0.25));
    const back = await call('set_keyframe', { id, prop: 'x', time: 2, out: null });
    expect(back.ok, back.text).toBe(true);
  });

  it('set_keyframes takes in and out and gives them back', async () => {
    const keys = [{ t: 0, v: -300, ease: 'bezier', out: H(0, 1 / 3) }, { t: 2, v: 300, in: H(0, 1 / 3) }];
    const r = await oneStepOf(() => call('set_keyframes', { id, keyframes: { x: keys } }));
    expect(r.data.keyframes.x[0]).toMatchObject({ ease: 'bezier', out: H(0, 1 / 3) });
    expect(r.data.keyframes.x[1]).toMatchObject({ in: H(0, 1 / 3) });
    const same = r.data.keyframes.x.map((k: any) => ({ t: k.t, v: k.v, ease: k.ease, ...(k.in ? { in: k.in } : {}), ...(k.out ? { out: k.out } : {}) }));
    await refused('set_keyframes', { id, keyframes: { x: same } }, /nothing changed/);
  });

  it('the field errors name the field', async () => {
    await refused('set_keyframe', { id, prop: 'x', time: 2, out: 5 }, /out must be \{ speed, influence \} or null/);
    await refused('set_keyframe', { id, prop: 'x', time: 2, in: { speed: 0, influence: 0.5, extra: 1 } }, /in must be \{ speed, influence \} or null/);
    await refused('set_keyframe', { id, prop: 'x', time: 2, out: H(0, 2) }, /out.influence must be between 0.001 and 1/);
    await refused('set_keyframe', { id, prop: 'x', time: 2, out: H(0, 0) }, /out.influence must be between 0.001 and 1/);
    await refused('set_keyframe', { id, prop: 'x', time: 2, out: H(2e9, 0.5) }, /out.speed must be a number between -1000000000 and 1000000000/);
    await refused('set_keyframe', { id, prop: 'x', time: 2, out: { influence: 0.5 } }, /out.speed must be a number/);
    await refused('set_keyframes', { id, keyframes: { x: [{ t: 0, v: 0 }, { t: 1, v: 1 }, { t: 2, v: 2, out: H(0, 3) }] } }, /keyframes.x\[2\].out.influence must be between 0.001 and 1/);
    await refused('set_keyframes', { id, keyframes: { x: [{ t: 0, v: 0, in: 'x' }] } }, /keyframes.x\[0\].in must be \{ speed, influence \} or null/);
    await refused('set_keyframe', { id, prop: 'x', time: 2, value: 0, in: H(0, 0.5) }, /the first key has no in handle/);
  });

  it('ease_keyframes takes exactly one of ease, easy and join', async () => {
    await keyed('x', 'linear');
    await refused('ease_keyframes', { keys: [{ id }] }, /give one of ease, easy or join/);
    await refused('ease_keyframes', { keys: [{ id }], ease: 'linear', easy: 'both' }, /give one of ease, easy or join/);
    await refused('ease_keyframes', { keys: [{ id }], easy: 'both', join: true }, /give one of ease, easy or join/);
    await refused('ease_keyframes', { keys: [{ id }], easy: 'sideways' }, /one of: both, into, out-of/);
    const b = await call('ease_keyframes', { keys: [{ id, prop: 'x', times: [3] }], ease: 'bezier' });
    expect(b.ok, b.text).toBe(true);
    expect(clipOf(id).keyframes!.x![1]!.ease).toBe('bezier');
    const o = await call('ease_keyframes', { keys: [{ id, prop: 'x', times: [4] }], easy: 'out-of' });
    expect(o.ok, o.text).toBe(true);
  });

  it('join gives both handles of a key the same speed', async () => {
    const keys = [{ t: 0, v: 0, ease: 'bezier', out: H(50, 0.4) }, { t: 2, v: 300, ease: 'bezier', in: H(-20, 0.6), out: H(80, 0.3) }, { t: 4, v: 100, in: H(10, 0.5) }];
    const s = await call('set_keyframes', { id, keyframes: { x: keys } });
    expect(s.ok, s.text).toBe(true);
    const c0 = clipOf(id);
    const r0 = keyRange(c0, 'x');
    expect(Math.abs(speedAt(c0.keyframes!.x!, 2 + 1e-6, r0) - speedAt(c0.keyframes!.x!, 2 - 1e-6, r0))).toBeGreaterThan(1);
    const j = await call('ease_keyframes', { keys: [{ id, prop: 'x', times: [clipOf(id).start + 2] }], join: true });
    expect(j.ok, j.text).toBe(true);
    expect(j.data.changed).toBe(1);
    const c = clipOf(id);
    const list = c.keyframes!.x!;
    const range = keyRange(c, 'x');
    expect(Math.abs(speedAt(list, 2 - 1e-6, range) - 30)).toBeLessThan(0.01);
    expect(Math.abs(speedAt(list, 2 + 1e-6, range) - 30)).toBeLessThan(0.01);
  });

  it('easy next to holds only says so', async () => {
    await call('set_keyframes', { id, keyframes: { x: [{ t: 0, v: 0, ease: 'hold' }, { t: 1, v: 1, ease: 'hold' }, { t: 2, v: 2, ease: 'hold' }] } });
    await refused('ease_keyframes', { keys: [{ id, prop: 'x' }], easy: 'both' }, /the keys sit next to holds: a hold has no handles/);
  });

  it('sample_keyframes matches evalKeys and speedAt, one frame apart by default', async () => {
    const keys = [{ t: 0, v: -300, ease: 'bezier', out: H(50, 0.4) }, { t: 2, v: 300, in: H(-20, 0.6) }];
    await call('set_keyframes', { id, keyframes: { x: keys } });
    const n = ed().past.length;
    const r = await call('sample_keyframes', { id, prop: 'x' });
    expect(ed().past.length).toBe(n);
    expect(r.data).toMatchObject({ id, prop: 'x', unit: 'px' });
    const c = clipOf(id);
    expect(r.data.samples).toHaveLength(121);
    for (const s of r.data.samples) {
      expect(Math.abs(s.v - evalKeys(c.keyframes!.x!, s.time - c.start, c, 'x'))).toBeLessThan(1e-4);
      expect(Math.abs(s.speed - speedAt(c.keyframes!.x!, s.time - c.start, keyRange(c, 'x')))).toBeLessThan(1e-4);
    }
    expect(r.data.samples[0]).toMatchObject({ time: 2, v: -300 });
    const part = await call('sample_keyframes', { id, prop: 'x', from: 2.5, to: 3, step: 0.25 });
    expect(part.data.samples.map((s: { time: number }) => s.time)).toEqual([2.5, 2.75, 3]);
  });

  it('sample_keyframes refuses too many samples, a prop without keys, a span outside the clip', async () => {
    await keyed();
    await refused('sample_keyframes', { id, prop: 'x', step: 0.0001 }, /too many samples: use a bigger step/);
    await refused('sample_keyframes', { id, prop: 'opacity' }, /"opacity" has no keys on this clip/);
    await refused('sample_keyframes', { id, prop: 'x', from: 0, to: 3 }, /inside the clip/);
    await refused('sample_keyframes', { id, prop: 'x', from: 5, to: 3 }, /to is before from/);
    await refused('sample_keyframes', { id, prop: 'banana' }, /no animatable property "banana"/);
  });
});
