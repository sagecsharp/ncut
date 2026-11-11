import { beforeEach, describe, expect, it } from 'vitest';
import { usePlayback } from '../../store/playback';
import { call, clipOf, ed, fresh, oneStepOf, proj, refused } from './editKit';

let video = '';
let audio = '';
beforeEach(() => {
  ({ video, audio } = fresh());
});

describe('add_text', () => {
  it('adds plain text at the playhead in one undo step', async () => {
    usePlayback.setState({ time: 3 });
    const r = await oneStepOf(() => call('add_text', { text: 'hello' }));
    expect(r.data.type).toBe('text');
    expect(r.data.text).toBe('hello');
    expect(r.data.start).toBe(3);
    expect(r.data.end).toBe(7);
  });

  it('uses a preset, lets text override it, takes fields in the same step', async () => {
    const r = await oneStepOf(() => call('add_text', { preset: 'caption', text: 'my words', start: 1, duration: 2, fields: { fontSize: 33, transform: { x: 40 } } }));
    const c = clipOf(r.data.id) as any;
    expect(c.text).toBe('my words');
    expect(c.fontSize).toBe(33);
    expect(c.transform.x).toBe(40);
    expect(c.background).toBeTruthy(); // the caption card's box
    expect(c.start).toBe(1);
    expect(c.duration).toBe(2);
  });

  it('takes a track, refuses audio / locked / unknown tracks and a bad field without leaving anything', async () => {
    const r = await call('add_text', { track: video, start: 0 });
    expect(r.data.track).toBe(video);
    await refused('add_text', { track: audio }, /audio track/);
    await refused('add_text', { track: 'nope' }, /no track/);
    await refused('add_text', { preset: 'nope' }, /not one of|must be one of/);
    await refused('add_text', { fields: { banana: 1 } }, /no banana field/);
    await refused('add_text', { fields: { start: 4 } }, /move_clip/);
    ed().updateTrack(video, { locked: true });
    await refused('add_text', { track: video }, /locked/);
    await refused('add_text', { bogus: 1 }, /not a known field/);
  });
});

describe('add_shape', () => {
  it('adds a preset', async () => {
    const r = await oneStepOf(() => call('add_shape', { preset: 'circle', start: 0 }));
    expect(r.data.kind).toBe('ellipse');
    const bg = await call('add_shape', { preset: 'background', start: 10 });
    expect((clipOf(bg.data.id) as any).width).toBe(proj().width);
  });

  it('adds a flat kind, and a solid that reads as 3d', async () => {
    const r = await oneStepOf(() => call('add_shape', { kind: 'star', start: 0 }));
    expect(r.data.kind).toBe('star');
    expect(r.data.threeD).toBeUndefined();
    const s = await oneStepOf(() => call('add_shape', { shape3d: 'box', start: 5 }));
    const c = clipOf(s.data.id) as any;
    expect(c.threeD).toBe(true);
    expect(c.shape).toBe('box');
    expect(c.transform.rotY).toBeGreaterThan(0);
    // a solid with a card of its own uses the card's size
    const cone = await call('add_shape', { shape3d: 'capsule', start: 10 });
    expect((clipOf(cone.data.id) as any).height).toBe(480);
    // kind and shape3d together
    const both = await call('add_shape', { kind: 'heart', shape3d: 'cylinder', start: 15 });
    expect((clipOf(both.data.id) as any).kind).toBe('heart');
    expect((clipOf(both.data.id) as any).shape).toBe('cylinder');
  });

  it('takes fields, and refuses mixed or unknown choices', async () => {
    const r = await oneStepOf(() => call('add_shape', { preset: 'rectangle', fields: { color: '#00ff00', width: 100 } }));
    expect((clipOf(r.data.id) as any).color).toBe('#00ff00');
    await refused('add_shape', { preset: 'circle', kind: 'rect' }, /not both/);
    await refused('add_shape', { shape3d: 'plane' }, /must be one of/);
    await refused('add_shape', { kind: 'blob' }, /must be one of/);
    await refused('add_shape', { fields: { nope: 1 } }, /no nope field/);
  });
});

describe('add_effect', () => {
  it('adds a layer on the top track with amount and params in one step', async () => {
    const r = await oneStepOf(() => call('add_effect', { effect: 'echo', start: 1, duration: 2, amount: 0.4, params: { count: 7 } }));
    expect(r.data.effect).toBe('echo');
    expect(r.data.amount).toBe(0.4);
    expect(r.data.params.count).toBe(7);
    expect(r.data.start).toBe(1);
  });

  it('puts a targeted effect over its clip in time, on a track above', async () => {
    const t = (await call('add_text', { text: 'x', start: 2, duration: 3, track: video })).data.id as string;
    const r = await oneStepOf(() => call('add_effect', { effect: 'echo', target: t }));
    expect(r.data.target).toBe(t);
    expect(r.data.start).toBe(2);
    expect(r.data.end).toBe(5);
    expect(r.data.track).not.toBe(video);
    const tracks = proj().tracks.map((x) => x.id);
    expect(tracks.indexOf(r.data.track)).toBeLessThan(tracks.indexOf(video));
    // explicit range
    const r2 = await call('add_effect', { effect: 'echo', target: t, start: 3, duration: 1 });
    expect(r2.data.start).toBe(3);
    expect(r2.data.end).toBe(4);
  });

  it('refuses an unknown effect, param, target and a bad target kind', async () => {
    await refused('add_effect', { effect: 'nope' }, /list_options/);
    await refused('add_effect', { effect: 'echo', params: { nope: 1 } }, /no param nope/);
    await refused('add_effect', { effect: 'echo', target: 'nope' }, /no clip/);
    const cam = (await call('add_camera', {})).data.id;
    await refused('add_effect', { effect: 'echo', target: cam }, /video, image, text or shape/);
    await refused('add_effect', { effect: 'echo', amount: 3 }, /at most 1/);
    await refused('add_effect', { effect: 'echo', track: audio }, /audio track/);
  });
});

describe('add_camera', () => {
  it('adds a camera with fields in one step', async () => {
    const r = await oneStepOf(() => call('add_camera', { start: 1, duration: 3, fields: { fov: 40, z: 100 } }));
    const c = clipOf(r.data.id) as any;
    expect(c.type).toBe('camera');
    expect(c.fov).toBe(40);
    expect(c.z).toBe(100);
    expect(r.data.end).toBe(4);
    await refused('add_camera', { fields: { fov: 'wide' } }, /fov must be a number/);
    await refused('add_camera', { fields: { transform: { x: 1 } } }, /no transform/);
  });
});

describe('no project', () => {
  it('says so', async () => {
    ed().closeProject();
    const r = await call('add_text', {});
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/no project is open/);
  });
});
