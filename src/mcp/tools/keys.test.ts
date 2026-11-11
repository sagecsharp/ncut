import { beforeEach, describe, expect, it } from 'vitest';
import { usePlayback } from '../../store/playback';
import { call, clipOf, ed, fresh, oneStepOf, refused } from './editKit';

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
