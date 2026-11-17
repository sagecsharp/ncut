import { beforeEach, describe, expect, it } from 'vitest';
import { addVideoClip, call, clipOf, ed, fresh, oneStepOf, proj, refused } from './editKit';

let video = '';
let audio = '';
beforeEach(() => {
  ({ video, audio } = fresh());
});

async function text(t = 'hi', start = 0): Promise<string> {
  const r = await call('add_text', { text: t, start, duration: 2 });
  expect(r.ok, r.text).toBe(true);
  return r.data.id as string;
}

describe('chroma key', () => {
  it('chroma key has no fill param any more', async () => {
    const id = (await call('add_effect', { effect: 'chroma-key' })).data.id as string;
    await refused('update_clip', { id, patch: { params: { fill: 0 } } }, /no param fill/);
  });
});

describe('update_clip', () => {
  it('mixes transform, a plain field and effect params in ONE undo step', async () => {
    const t = await text();
    const r = await oneStepOf(() => call('update_clip', { id: t, patch: { transform: { x: 120, scale: 2 }, color: '#ff0000', fontSize: 50 } }));
    expect(r.data.changed.sort()).toEqual(['color', 'fontSize', 'transform']);
    const c = clipOf(t) as any;
    expect(c.transform.x).toBe(120);
    expect(c.transform.scale).toBe(2);
    expect(c.color).toBe('#ff0000');
    const id = (await call('add_effect', { effect: 'echo' })).data.id as string;
    const r2 = await oneStepOf(() => call('update_clip', { id, patch: { params: { count: 8 }, amount: 0.5, name: 'my echo' } }));
    expect(r2.data.changed.sort()).toEqual(['amount', 'name', 'params']);
    const ec = clipOf(id) as any;
    expect(ec.params.count).toBe(8);
    expect(ec.amount).toBe(0.5);
    expect(ec.name).toBe('my echo');
  });

  it('refuses a value the store would clamp instead of storing another one', async () => {
    const t = await text();
    await refused('update_clip', { id: t, patch: { transform: { opacity: 5 } } }, /transform\.opacity must be between 0 and 1/);
    await refused('update_clip', { id: t, patch: { transform: { scale: 5000 } } }, /transform\.scale must be between 0\.01 and 100/);
    await refused('update_clip', { id: t, patch: { fadeIn: 5 } }, /fadeIn cannot be longer than the clip \(the clip is 2 s long\)/);
    const v = addVideoClip(video, 5);
    await refused('update_clip', { id: v, patch: { speed: 100 } }, /speed must be between 0\.25 and 4/);
    await refused('update_clip', { id: v, patch: { bpm: 5000 } }, /bpm must be between 20 and 400/);
    const ok1 = await call('update_clip', { id: v, patch: { transform: { x: 99999 }, bpm: 120 } });
    expect(ok1.ok, ok1.text).toBe(true);
    const ok2 = await call('update_clip', { id: v, patch: { bpm: null } });
    expect(ok2.ok, ok2.text).toBe(true);
  });

  it('refuses a field that is keyed on the clip and names the keyframe tools', async () => {
    const t = await text();
    await call('set_keyframe', { id: t, prop: 'x', time: 0, value: -100 });
    await call('set_keyframe', { id: t, prop: 'fontSize', time: 0, value: 50 });
    await refused('update_clip', { id: t, patch: { transform: { x: 500 } } }, /x is keyed on this clip.*set_keyframe.*clear_keyframes/);
    await refused('update_clip', { id: t, patch: { fontSize: 60 } }, /fontSize is keyed/);
    await refused('update_clip', { id: t, patch: { color: '#ff0000', transform: { y: 3, x: 1 } } }, /x is keyed/);
    const ok1 = await call('update_clip', { id: t, patch: { transform: { y: 3 } } });
    expect(ok1.ok, ok1.text).toBe(true);
    await call('clear_keyframes', { id: t, prop: 'x' });
    const ok2 = await call('update_clip', { id: t, patch: { transform: { x: 500 } } });
    expect(ok2.ok, ok2.text).toBe(true);
    // nested: crop.left keyed, the patch gives crop
    await call('update_clip', { id: t, patch: { crop: { left: 0.1 } } });
    await call('set_keyframe', { id: t, prop: 'crop.left', time: 0, value: 0.2 });
    await refused('update_clip', { id: t, patch: { crop: { left: 0.3 } } }, /crop\.left is keyed/);
    await refused('update_clip', { id: t, patch: { crop: null } }, /crop\.left is keyed/);
    const e = (await call('add_effect', { effect: 'echo' })).data.id as string;
    await call('set_keyframe', { id: e, prop: 'amount', time: 0, value: 0.5 });
    await call('set_keyframe', { id: e, prop: 'p.count', time: 0, value: 4 });
    await refused('update_clip', { id: e, patch: { amount: 0.1 } }, /amount is keyed/);
    await refused('update_clip', { id: e, patch: { params: { count: 8 } } }, /p\.count is keyed/);
  });

  it('re-times a video clip through speed', async () => {
    const v = addVideoClip(video, 0);
    const before = clipOf(v).duration;
    const r = await oneStepOf(() => call('update_clip', { id: v, patch: { speed: 2 } }));
    expect(r.data.changed).toEqual(['speed']);
    expect((clipOf(v) as any).speed).toBe(2);
    expect(clipOf(v).duration).toBeCloseTo(before / 2);
  });

  it('refuses what has a tool of its own and names the tool', async () => {
    const t = await text();
    await refused('update_clip', { id: t, patch: { start: 3 } }, /move_clip/);
    await refused('update_clip', { id: t, patch: { duration: 3 } }, /trim_clip/);
    await refused('update_clip', { id: t, patch: { trimStart: 3 } }, /trim_clip/);
    await refused('update_clip', { id: t, patch: { trackId: video } }, /move_clip/);
    await refused('update_clip', { id: t, patch: { keyframes: {} } }, /set_keyframes/);
    await refused('update_clip', { id: t, patch: { faces: {} } }, /set_sides/);
    await refused('update_clip', { id: t, patch: { id: 'x' } }, /never changes/);
    const v = addVideoClip(video, 5);
    await refused('update_clip', { id: v, patch: { assetId: 'zzz' } }, /replace_media/);
    await refused('update_clip', { id: v, patch: { group: 'g' } }, /group_clips/);
    const e = (await call('add_effect', { effect: 'echo' })).data.id as string;
    await refused('update_clip', { id: e, patch: { effect: 'blur' } }, /add_effect/);
    await refused('update_clip', { id: t, patch: { type: 'shape' } }, /type/);
  });

  it('refuses unknown fields, bad effect params and wrong types, with nothing written', async () => {
    const t = await text();
    await refused('update_clip', { id: t, patch: { color: '#00ff00', banana: 1 } }, /no banana field/);
    await refused('update_clip', { id: t, patch: { fontSize: 'big' } }, /fontSize must be a number/);
    await refused('update_clip', { id: t, patch: { transform: { wobble: 1 } } }, /transform\.wobble/);
    await refused('update_clip', { id: t, patch: { params: { a: 1 } } }, /only exist on effect/);
    await refused('update_clip', { id: t, patch: { speed: 2 } }, /video and audio/);
    const e = (await call('add_effect', { effect: 'echo' })).data.id as string;
    await refused('update_clip', { id: e, patch: { params: { nope: 1 } } }, /no param nope.*count/);
    await refused('update_clip', { id: e, patch: { transform: { x: 1 } } }, /no transform/);
    await refused('update_clip', { id: 'nope', patch: { name: 'a' } }, /no clip with the id/);
    await refused('update_clip', { id: t, patch: {} }, /empty/);
  });

  it('says so when nothing changed, and on a locked track', async () => {
    const t = await text();
    await refused('update_clip', { id: t, patch: { name: (clipOf(t) as any).name } }, /nothing changed/);
    await refused('update_clip', { id: t, patch: { transform: { opacity: 1 } } }, /nothing changed/);
    ed().updateTrack(clipOf(t).trackId, { locked: true });
    await refused('update_clip', { id: t, patch: { color: '#123456' } }, /locked/);
  });

  it('refuses a parent loop', async () => {
    const a = await text('a', 0);
    const b = await text('b', 3);
    await call('update_clip', { id: b, patch: { parent: a } });
    expect((clipOf(b) as any).parent).toBe(a);
    await refused('update_clip', { id: a, patch: { parent: b } }, /loop/);
  });
});

describe('set_sides', () => {
  async function solid(): Promise<string> {
    const r = await call('add_shape', { shape3d: 'box', start: 0, duration: 4 });
    expect(r.ok, r.text).toBe(true);
    return r.data.id as string;
  }

  it('puts a clip and a color on sides, merges, and takes a side away', async () => {
    const box = await solid();
    const pic = await text('pic', 5);
    const r = await oneStepOf(() => call('set_sides', { id: box, sides: { front: { clip: pic, fit: 'stretch' }, top: { color: '#FF8800' } } }));
    expect(r.data.sides).toEqual({ front: { clip: pic, fit: 'stretch' }, top: { color: '#ff8800' } });
    const r2 = await oneStepOf(() => call('set_sides', { id: box, sides: { back: { color: '#000000' } } }));
    expect(Object.keys(r2.data.sides).sort()).toEqual(['back', 'front', 'top']);
    const r3 = await oneStepOf(() => call('set_sides', { id: box, sides: { front: null } }));
    expect(Object.keys(r3.data.sides).sort()).toEqual(['back', 'top']);
    expect(r3.data.names).toEqual(['front', 'back', 'right', 'left', 'top', 'bottom']);
  });

  it('all, with a hole, and an empty result removes the field', async () => {
    const box = await solid();
    const r = await call('set_sides', { id: box, sides: { back: null, all: { color: '#112233' } } });
    expect(r.data.sides).toEqual({ all: { color: '#112233' }, back: null });
    const r2 = await oneStepOf(() => call('set_sides', { id: box, sides: { all: null } }));
    expect(r2.data.sides).toEqual({});
    expect('faces' in clipOf(box)).toBe(false);
  });

  it('refuses a flat clip, a bad side, a bad value, itself, a clip without a picture', async () => {
    const flat = await call('add_shape', { kind: 'rect' });
    await refused('set_sides', { id: flat.data.id, sides: { front: null } }, /flat 2d/);
    const box = await solid();
    await refused('set_sides', { id: box, sides: { middle: null } }, /no side "middle".*front/);
    await refused('set_sides', { id: box, sides: { front: { color: 'red' } } }, /#rrggbb/);
    await refused('set_sides', { id: box, sides: { front: { clip: box } } }, /cannot show itself/);
    await refused('set_sides', { id: box, sides: { front: { clip: 'nope' } } }, /no clip with the id/);
    await refused('set_sides', { id: box, sides: { front: { clip: flat.data.id, fit: 'wide' } } }, /fit must be/);
    await refused('set_sides', { id: box, sides: { front: 5 } }, /must be/);
    await refused('set_sides', { id: box, sides: { back: null } }, /nothing changed/);
    const eff = await call('add_effect', { effect: 'echo' });
    await refused('set_sides', { id: eff.data.id, sides: { front: null } }, /no sides/);
    const cam = await call('add_camera', {});
    await refused('set_sides', { id: box, sides: { front: { clip: cam.data.id } } }, /no picture/);
  });
});

describe('set_sides aliases and loops', () => {
  it('a second identical call is an error with no undo step', async () => {
    const box = (await call('add_shape', { shape3d: 'box', start: 0, duration: 4 })).data.id as string;
    const r = await call('set_sides', { id: box, sides: { front: { color: '#ff0000' } } });
    expect(r.ok, r.text).toBe(true);
    await refused('set_sides', { id: box, sides: { front: { color: '#ff0000' } } }, /nothing changed/);
  });

  it('stores the one side of a sphere under all, takes its own name as an alias and drops a stale entry', async () => {
    const ball = (await call('add_shape', { shape3d: 'sphere', start: 0, duration: 4 })).data.id as string;
    // an entry an older call left under the own name
    ed().updateClip(ball, { faces: { surface: { color: '#00ff00' } } } as any);
    const r = await call('set_sides', { id: ball, sides: { surface: { color: '#ff0000' } } });
    expect(r.ok, r.text).toBe(true);
    expect(r.data.sides).toEqual({ all: { color: '#ff0000' } });
    expect(r.data.names).toEqual(['all']);
    await refused('set_sides', { id: ball, sides: { surface: { color: '#ff0000' } } }, /nothing changed/);
    await refused('set_sides', { id: ball, sides: { surface: { color: '#0000ff' }, all: { color: '#ff0000' } } }, /same side/);
    const r2 = await call('set_sides', { id: ball, sides: { surface: null } });
    expect(r2.data.sides).toEqual({});
  });

  it('refuses a source that shows the solid on a side, directly or through a chain', async () => {
    const a = (await call('add_shape', { shape3d: 'box', start: 0, duration: 4 })).data.id as string;
    const b = (await call('add_shape', { shape3d: 'box', start: 5, duration: 4 })).data.id as string;
    const c = (await call('add_shape', { shape3d: 'box', start: 10, duration: 4 })).data.id as string;
    const r = await call('set_sides', { id: a, sides: { front: { clip: b } } });
    expect(r.ok, r.text).toBe(true);
    // b is a solid itself: said, not refused
    expect(r.data.note).toMatch(/solid with sides itself/);
    await refused('set_sides', { id: b, sides: { front: { clip: a } } }, /would hide each other/);
    const r2 = await call('set_sides', { id: b, sides: { front: { clip: c } } });
    expect(r2.ok, r2.text).toBe(true);
    await refused('set_sides', { id: c, sides: { top: { clip: a } } }, /would hide each other/);
  });
});

describe('move_clip / trim_clip', () => {
  it('moves in time and across tracks, one undo step', async () => {
    const t = await text('a', 0);
    const r = await oneStepOf(() => call('move_clip', { id: t, start: 5 }));
    expect(r.data.start).toBe(5);
    const other = ed().addTrack('video');
    const r2 = await oneStepOf(() => call('move_clip', { id: t, track: other }));
    expect(r2.data.track).toBe(other);
  });

  it('refuses overlap, wrong track kind, locked, no change, no arguments', async () => {
    const a = await text('a', 0);
    const b = await text('b', 5);
    await refused('move_clip', { id: b, start: 1, track: clipOf(a).trackId }, /overlap/);
    await refused('move_clip', { id: a, track: audio }, /cannot go on the audio track/);
    await refused('move_clip', { id: a, start: 0 }, /already there/);
    await refused('move_clip', { id: a }, /give start/);
    await refused('move_clip', { id: a, track: 'nope' }, /no track/);
    const other = ed().addTrack('video');
    ed().updateTrack(other, { locked: true });
    await refused('move_clip', { id: a, track: other }, /locked/);
    ed().updateTrack(clipOf(a).trackId, { locked: true });
    await refused('move_clip', { id: a, start: 1 }, /locked/);
  });

  it('trims both edges and notes a clamp', async () => {
    const t = await text('a', 1);
    const r = await oneStepOf(() => call('trim_clip', { id: t, edge: 'end', time: 2 }));
    expect(r.data.end).toBe(2);
    const r2 = await oneStepOf(() => call('trim_clip', { id: t, edge: 'start', time: 1.5 }));
    expect(r2.data.start).toBe(1.5);
    const r3 = await oneStepOf(() => call('trim_clip', { id: t, edge: 'end', time: 1.51 }));
    expect(r3.data.note).toMatch(/stopped at/);
  });

  it('says why a trim did nothing', async () => {
    const t = await text('a', 1);
    await refused('trim_clip', { id: t, edge: 'start', time: 1 }, /nothing changed/);
    await refused('trim_clip', { id: 'nope', edge: 'start', time: 1 }, /no clip/);
  });
});

describe('split / delete / duplicate / group', () => {
  it('splits under a time, answers the right halves, refuses a time outside', async () => {
    const t = await text('a', 0);
    const r = await oneStepOf(() => call('split_clips', { time: 1 }));
    expect(r.data.created.length).toBe(1);
    expect(r.data.clips[0].start).toBe(1);
    expect(clipOf(t).duration).toBe(1);
    await refused('split_clips', { time: 50 }, /inside a clip/);
    await refused('split_clips', { time: 0.01, ids: [t] }, /0.05/);
    await refused('split_clips', { time: 0.5, ids: ['nope'] }, /no clip/);
    ed().updateTrack(clipOf(t).trackId, { locked: true });
    await refused('split_clips', { time: 0.5, ids: [t] }, /nothing was cut/);
  });

  it('splits only the asked clips (not the selection)', async () => {
    const a = await text('a', 0);
    const track2 = ed().addTrack('video');
    const b = (await call('add_text', { text: 'b', start: 0, duration: 2, track: track2 })).data.id as string;
    ed().select([b]);
    const r = await call('split_clips', { time: 1, ids: [a] });
    expect(r.data.created.length).toBe(1);
    expect(clipOf(b).duration).toBe(2);
  });

  it('deletes, counts, ripples, refuses locked', async () => {
    const a = await text('a', 0);
    const b = await text('b', 2);
    const r = await oneStepOf(() => call('delete_clips', { ids: [a] }));
    expect(r.data.deleted).toBe(1);
    expect(proj().clips.some((c) => c.id === a)).toBe(false);
    const c = await text('c', 6);
    const r2 = await oneStepOf(() => call('delete_clips', { ids: [b], ripple: true }));
    expect(r2.data.ids).toEqual([b]);
    expect(clipOf(c).start).toBe(4);
    ed().updateTrack(clipOf(c).trackId, { locked: true });
    await refused('delete_clips', { ids: [c] }, /locked/);
    await refused('delete_clips', { ids: ['nope'] }, /no clip/);
    await refused('delete_clips', { ids: [] }, /at least 1/);
  });

  it('a delete takes the effects on a clip along', async () => {
    const t = await text('a', 0);
    await call('add_effect', { effect: 'echo', target: t });
    const r = await call('delete_clips', { ids: [t] });
    expect(r.data.deleted).toBe(2);
  });

  it('duplicates, with from, after or over the originals', async () => {
    const a = await text('a', 0);
    const r = await oneStepOf(() => call('duplicate_clips', { ids: [a] }));
    expect(r.data.copies.length).toBe(1);
    expect(r.data.copies[0].from).toBe(a);
    expect(r.data.copies[0].start).toBeGreaterThanOrEqual(2);
    const r2 = await oneStepOf(() => call('duplicate_clips', { ids: [a], same_time: true }));
    expect(r2.data.copies[0].start).toBe(0);
    expect(r2.data.copies[0].track).not.toBe(clipOf(a).trackId);
    // a clip on a locked track is still copied (the copy goes to another track)
    ed().updateTrack(clipOf(a).trackId, { locked: true });
    const r3 = await call('duplicate_clips', { ids: [a] });
    expect(r3.ok, r3.text).toBe(true);
    await refused('duplicate_clips', { ids: ['nope'] }, /no clip/);
  });

  it('groups and ungroups', async () => {
    const a = await text('a', 0);
    const b = await text('b', 3);
    const r = await oneStepOf(() => call('group_clips', { ids: [a, b] }));
    expect(r.data.clips.sort()).toEqual([a, b].sort());
    await refused('group_clips', { ids: [a, b] }, /already/);
    await refused('group_clips', { ids: [a] }, /at least two/);
    const u = await oneStepOf(() => call('ungroup_clips', { ids: [a] }));
    expect(u.data.ungrouped.sort()).toEqual([a, b].sort());
    expect(clipOf(a).group).toBeUndefined();
    await refused('ungroup_clips', { ids: [a] }, /none of these clips is in a group/);
  });

  it('rejects unknown arguments', async () => {
    await refused('move_clip', { id: 'x', where: 1 }, /not a known field/);
  });
});

async function shapeAt(track: string, x: number, parent?: string): Promise<string> {
  const r = await call('add_shape', { kind: 'rect', track, start: 0, duration: 4, fields: { width: 200, height: 100, transform: { x }, ...(parent ? { parent } : {}) } });
  expect(r.ok, r.text).toBe(true);
  return r.data.id as string;
}

describe('bend_clips', () => {
  let second = '';
  beforeEach(() => {
    second = ed().addTrack('video');
  });

  it('bends two cards together, groups them, one undo step', async () => {
    const a = await shapeAt(video, -150);
    const b = await shapeAt(second, 150);
    const r = await oneStepOf(() => call('bend_clips', { ids: [a, b], angle: 60 }));
    expect(r.data.together).toBe(true);
    expect(r.data.bent.sort()).toEqual([a, b].sort());
    expect(r.data.angle).toBe(60);
    expect(r.data.along).toBe('width');
    expect(r.data.group).toBeTruthy();
    expect((clipOf(a) as any).group).toBe((clipOf(b) as any).group);
    expect((clipOf(a) as any).bend.angle).toBe(60);
    expect((clipOf(a) as any).bend.span).toBeGreaterThan(0);
  });

  it('angle 0 takes the bend off', async () => {
    const a = await shapeAt(video, -150);
    const b = await shapeAt(second, 150);
    await refused('bend_clips', { ids: [a, b], angle: 0 }, /nothing to take off/);
    await call('bend_clips', { ids: [a, b], angle: 60 });
    const r = await oneStepOf(() => call('bend_clips', { ids: [a, b], angle: 0 }));
    expect(r.data.flat.sort()).toEqual([a, b].sort());
    expect((clipOf(a) as any).bend ?? null).toBeNull();
    expect((clipOf(b) as any).bend ?? null).toBeNull();
  });

  it('angle 0 skips a bent clip on a locked track', async () => {
    const a = await shapeAt(video, -150);
    const b = await shapeAt(second, 150);
    await call('bend_clips', { ids: [a, b], angle: 30, together: false });
    ed().updateTrack(clipOf(b).trackId, { locked: true });
    await refused('bend_clips', { ids: [b], angle: 0 }, /nothing to take off: .*its track is locked/);
    const r = await call('bend_clips', { ids: [a, b], angle: 0 });
    expect(r.ok, r.text).toBe(true);
    expect(r.data.flat).toEqual([a]);
    expect(r.data.skipped).toEqual([{ id: b, why: 'its track is locked' }]);
    expect((clipOf(a) as any).bend ?? null).toBeNull();
    expect((clipOf(b) as any).bend).toBeTruthy();
  });

  it('skips solids with a why', async () => {
    const a = await shapeAt(video, -150);
    const b = await shapeAt(second, 150);
    const solid = await shapeAt(ed().addTrack('video'), 0);
    await call('update_clip', { id: solid, patch: { threeD: true, shape: 'box' } });
    const r = await call('bend_clips', { ids: [a, b, solid], angle: 40 });
    expect(r.ok, r.text).toBe(true);
    expect(r.data.skipped).toEqual([{ id: solid, why: expect.stringMatching(/3d shape/) }]);
    expect((clipOf(solid) as any).bend ?? null).toBeNull();
    await refused('bend_clips', { ids: [solid], angle: 40 }, /nothing was bent: .*3d shape/);
    await refused('bend_clips', { ids: [a, solid], angle: 40 }, /needs two or more clips/);
    await refused('bend_clips', { ids: [a], angle: 400 }, /angle must be at most 360/);
  });

  it('together false bends each', async () => {
    const a = await shapeAt(video, -150);
    const b = await shapeAt(second, 150);
    const r = await oneStepOf(() => call('bend_clips', { ids: [a, b], angle: 30, together: false, along: 'height' }));
    expect(r.data.together).toBe(false);
    expect(r.data.group).toBeNull();
    expect((clipOf(a) as any).bend).toEqual({ angle: 30, along: 'height' });
    expect((clipOf(b) as any).bend).toEqual({ angle: 30, along: 'height' });
    expect((clipOf(a) as any).group).toBeUndefined();
  });
});

describe('update_clip pivot and parent keep the place', () => {
  let second = '';
  beforeEach(() => {
    second = ed().addTrack('video');
  });

  const x = (id: string): number => (clipOf(id) as any).transform.x as number;

  it('pivot keeps the clip and its attached clips in place and lists them in moved', async () => {
    const a = await shapeAt(video, 0);
    const b = await shapeAt(second, 300, a);
    const bx = x(b);
    const r = await oneStepOf(() => call('update_clip', { id: a, patch: { pivot: 'left' } }));
    expect(r.data.changed).toEqual(expect.arrayContaining(['pivot', 'transform']));
    expect(r.data.moved).toEqual([b]);
    expect((clipOf(a) as any).pivot).toEqual({ x: -0.5, y: 0 });
    // the pivot is 100 px left of the middle: the clip x moves by -100 and the child offset by +100
    expect(x(a)).toBeCloseTo(-100, 6);
    expect(x(b)).toBeCloseTo(bx + 100, 6);
  });

  it('pivot with transform is written as given', async () => {
    const a = await shapeAt(video, 0);
    const r = await oneStepOf(() => call('update_clip', { id: a, patch: { pivot: 'left', transform: { x: 40 } } }));
    expect(r.data.moved).toBeUndefined();
    expect(x(a)).toBe(40);
    expect((clipOf(a) as any).pivot).toEqual({ x: -0.5, y: 0 });
  });

  it('parent keeps the clip in place', async () => {
    const a = await shapeAt(video, 100);
    const b = await shapeAt(second, 300);
    const r = await oneStepOf(() => call('update_clip', { id: b, patch: { parent: a } }));
    expect(r.data.changed).toEqual(expect.arrayContaining(['parent', 'transform']));
    expect((clipOf(b) as any).parent).toBe(a);
    // 300 on screen, the parent is at 100: 200 from it
    expect(x(b)).toBeCloseTo(200, 6);
  });

  it('parent with transform writes the transform as given', async () => {
    const a = await shapeAt(video, 100);
    const b = await shapeAt(second, 300);
    await oneStepOf(() => call('update_clip', { id: b, patch: { parent: a, transform: { x: 300 } } }));
    expect((clipOf(b) as any).parent).toBe(a);
    expect(x(b)).toBe(300);
  });

  it('pivot with an attached clip on a locked track is an error and changes nothing', async () => {
    const a = await shapeAt(video, 0);
    await shapeAt(second, 300, a);
    ed().updateTrack(second, { locked: true });
    await refused('update_clip', { id: a, patch: { pivot: 'left' } }, /attached to this one is on a locked track/);
    expect((clipOf(a) as any).pivot ?? null).toBeNull();
  });

  it('pivot null on a clip without one says nothing changed', async () => {
    const a = await shapeAt(video, 0);
    await refused('update_clip', { id: a, patch: { pivot: null } }, /nothing changed/);
  });
});

/** two video clips that touch: a is 0 to 4, b is 4 to 9, both on the video track */
async function touching(): Promise<{ a: string; b: string }> {
  const a = addVideoClip(video, 0);
  await call('trim_clip', { id: a, edge: 'end', time: 4 });
  const b = addVideoClip(video, 4);
  await call('trim_clip', { id: b, edge: 'end', time: 9 });
  return { a, b };
}

describe('trim_clip modes', () => {
  it('no mode answers as before', async () => {
    const { a, b } = await touching();
    const plain = await call('trim_clip', { id: a, edge: 'end', time: 3 });
    expect(plain.ok, plain.text).toBe(true);
    expect(plain.data.mode).toBeUndefined();
    expect(plain.data.end).toBe(3);
    // a gap stays, b does not move
    expect(clipOf(b).start).toBe(4);
    // mode trim is the same code, alone changes nothing
    const same = await call('trim_clip', { id: a, edge: 'end', time: 2, mode: 'trim', alone: true });
    expect(same.data.mode).toBeUndefined();
    expect(same.data.end).toBe(2);
    expect(clipOf(b).start).toBe(4);
  });

  it('ripple, move-edit and stretch are one step each', async () => {
    const { a, b } = await touching();
    const r = await oneStepOf(() => call('trim_clip', { id: a, edge: 'end', time: 3, mode: 'ripple' }));
    expect(r.data).toMatchObject({ id: a, mode: 'ripple', end: 3 });
    expect(r.data.moved).toContain(b);
    expect(clipOf(b).start).toBe(3);
    expect(r.data.note).toBeUndefined();
    const m = await oneStepOf(() => call('trim_clip', { id: a, edge: 'end', time: 3.5, mode: 'move-edit' }));
    expect(m.data.mode).toBe('move-edit');
    expect(clipOf(a).start + clipOf(a).duration).toBeCloseTo(3.5, 6);
    expect(clipOf(b).start).toBeCloseTo(3.5, 6);
    expect(clipOf(b).start + clipOf(b).duration).toBeCloseTo(8, 6);
    // from the start side of b: the same edit, back to 3
    const m2 = await oneStepOf(() => call('trim_clip', { id: b, edge: 'start', time: 3, mode: 'move-edit' }));
    expect(m2.data.mode).toBe('move-edit');
    expect(clipOf(a).duration).toBeCloseTo(3, 6);
    const s = await oneStepOf(() => call('trim_clip', { id: b, edge: 'end', time: 13, mode: 'stretch' }));
    expect(s.data).toMatchObject({ mode: 'stretch', speed: 0.5 });
    expect((clipOf(b) as any).speed).toBe(0.5);
    expect(clipOf(b).duration).toBe(10);
  });

  it('alone leaves the group mates', async () => {
    const { a } = await touching();
    const top = ed().addTrack('video');
    const c = addVideoClip(top, 0);
    await call('trim_clip', { id: c, edge: 'end', time: 4 });
    await call('group_clips', { ids: [a, c] });
    const r = await call('trim_clip', { id: a, edge: 'end', time: 3, mode: 'ripple' });
    expect(r.ok, r.text).toBe(true);
    expect(clipOf(c).duration).toBe(3);
    const r2 = await call('trim_clip', { id: a, edge: 'end', time: 2, mode: 'ripple', alone: true });
    expect(r2.ok, r2.text).toBe(true);
    expect(clipOf(a).duration).toBe(2);
    expect(clipOf(c).duration).toBe(3);
  });

  it('a stop notes where the edge ended', async () => {
    const { a, b } = await touching();
    // a clip stays at least 0.05 s long
    const r = await call('trim_clip', { id: a, edge: 'end', time: 0, mode: 'ripple' });
    expect(r.ok, r.text).toBe(true);
    expect(r.data.end).toBe(0.05);
    expect(r.data.note).toMatch(/^the end edge stopped at 0\.05 s, not 0 s: .*0\.05 s/);
    expect(clipOf(b).start).toBeCloseTo(0.05, 6);
  });

  it('a start stop notes where the edge ended', async () => {
    const { b } = await touching();
    const r = await call('trim_clip', { id: b, edge: 'start', time: 10, mode: 'ripple' });
    expect(r.ok, r.text).toBe(true);
    expect(r.data.note).toMatch(/^the start edge stopped at 8.95 s, not 10 s: /);
  });

  it('nothing possible is an error with no step', async () => {
    const { a, b } = await touching();
    await refused('trim_clip', { id: a, edge: 'end', time: 4, mode: 'ripple' }, /nothing changed: the edge is already there/);
    // a clip that shows all its media cannot grow
    const full = addVideoClip(video, 20);
    await refused('trim_clip', { id: full, edge: 'end', time: 45, mode: 'ripple' }, /nothing changed: .*no more media after its last frame/);
    ed().updateTrack(video, { locked: true });
    await refused('trim_clip', { id: b, edge: 'end', time: 8, mode: 'ripple' }, /locked track/);
  });

  it('move-edit needs a touching clip', async () => {
    const { a, b } = await touching();
    await call('trim_clip', { id: a, edge: 'end', time: 3 });
    await refused('trim_clip', { id: a, edge: 'end', time: 2, mode: 'move-edit' }, /the end of .* does not touch another clip: use mode "ripple" or "trim"/);
    await refused('trim_clip', { id: b, edge: 'start', time: 5, mode: 'move-edit' }, /the start of .* does not touch another clip/);
    await refused('trim_clip', { id: a, edge: 'start', time: 1, mode: 'move-edit' }, /does not touch another clip/);
    await refused('trim_clip', { id: a, edge: 'end', time: 2, mode: 'sideways' }, /mode must be one of/);
    void audio;
  });
});

describe('slip_clip and slide_clip', () => {
  it('slip by and by trim_start', async () => {
    const a = addVideoClip(video, 0);
    await call('trim_clip', { id: a, edge: 'end', time: 5 });
    const r = await oneStepOf(() => call('slip_clip', { id: a, by: 2 }));
    expect(r.data).toMatchObject({ id: a, start: 0, end: 5, trim_start: 2 });
    expect((clipOf(a) as any).trimStart).toBe(2);
    expect(clipOf(a).duration).toBe(5);
    const r2 = await oneStepOf(() => call('slip_clip', { id: a, trim_start: 1 }));
    expect(r2.data.trim_start).toBe(1);
    expect((clipOf(a) as any).trimStart).toBe(1);
    // limited by the media: 20 s long, the clip shows 5 s
    const r3 = await call('slip_clip', { id: a, by: 100 });
    expect(r3.ok, r3.text).toBe(true);
    expect(r3.data.trim_start).toBe(15);
    expect(r3.data.note).toMatch(/^slipped 14 s of media, not 100 s: /);
  });

  it('a separated sound slips along unless alone', async () => {
    const a = addVideoClip(video, 0);
    await call('trim_clip', { id: a, edge: 'end', time: 5 });
    const sep = await call('separate_sound', { ids: [a] });
    const sound = sep.data.pairs[0].sound as string;
    const r = await call('slip_clip', { id: a, by: 1 });
    expect(r.ok, r.text).toBe(true);
    expect((clipOf(a) as any).trimStart).toBe(1);
    expect((clipOf(sound) as any).trimStart).toBe(1);
    const r2 = await call('slip_clip', { id: a, by: 1, alone: true });
    expect(r2.ok, r2.text).toBe(true);
    expect((clipOf(a) as any).trimStart).toBe(2);
    expect((clipOf(sound) as any).trimStart).toBe(1);
  });

  it('slide by and to start, the neighbours trim', async () => {
    const { a, b } = await touching();
    const c = addVideoClip(video, 9);
    await call('trim_clip', { id: c, edge: 'end', time: 14 });
    const r = await oneStepOf(() => call('slide_clip', { id: b, by: 1 }));
    expect(r.data).toMatchObject({ id: b, start: 5, end: 10 });
    expect([...r.data.trimmed].sort()).toEqual([a, c].sort());
    expect(clipOf(a).duration).toBe(5);
    expect(clipOf(c).start).toBe(10);
    const r2 = await oneStepOf(() => call('slide_clip', { id: b, start: 4.5 }));
    expect(r2.data).toMatchObject({ start: 4.5, end: 9.5 });
    expect(clipOf(a).duration).toBe(4.5);
    // a stop notes how far it slid
    const r3 = await call('slide_clip', { id: b, by: 50 });
    expect(r3.ok, r3.text).toBe(true);
    expect(r3.data.note).toMatch(/^slid .* s, not 50 s: /);
  });

  it('every refusal', async () => {
    const { a, b } = await touching();
    await refused('slip_clip', { id: a }, /give by or trim_start$/);
    await refused('slip_clip', { id: a, by: 1, trim_start: 1 }, /give by or trim_start, not both/);
    await refused('slide_clip', { id: b }, /give by or start$/);
    await refused('slide_clip', { id: b, by: 1, start: 5 }, /give by or start, not both/);
    const t = await text();
    await refused('slip_clip', { id: t, by: 1 }, /slip needs a video or audio clip/);
    await refused('slip_clip', { id: a, by: 0 }, /nothing changed: the clip already shows that part of its media/);
    await refused('slip_clip', { id: a, by: -1 }, /nothing changed: .*first frame/);
    await refused('slide_clip', { id: b, by: 0 }, /nothing changed: the clip is already there/);
    await refused('slide_clip', { id: b, start: 4 }, /nothing changed: the clip is already there/);
    await refused('slip_clip', { id: 'ghost', by: 1 }, /no clip with the id ghost/);
    await refused('slip_clip', { id: a, trim_start: -1 }, /trim_start must be at least 0/);
    ed().updateTrack(video, { locked: true });
    await refused('slip_clip', { id: a, by: 1 }, /locked track/);
    await refused('slide_clip', { id: b, by: 1 }, /locked track/);
  });
});

describe('lift_range and extract_range', () => {
  it('lift is one step and keeps the range', async () => {
    const a = addVideoClip(video, 0);
    const track2 = ed().addTrack('video');
    const o = addVideoClip(track2, 12);
    await call('set_range', { in: 5, out: 8 });
    const r = await oneStepOf(() => call('lift_range'));
    // the middle piece is a clip of its own, so nothing that was there is gone: one split, no removed
    expect(r.data).toEqual({ in: 5, out: 8, removed: 0, split: 1, trimmed: 0 });
    expect(proj().range).toEqual({ in: 5, out: 8 });
    expect(proj().clips.filter((c) => c.trackId === video)).toHaveLength(2);
    // the gap stays: nothing after it moved
    expect(clipOf(o).start).toBe(12);
    expect(clipOf(a).duration).toBe(5);
  });

  it('extract closes up and keeps only the in', async () => {
    const a = addVideoClip(video, 0);
    const o = addVideoClip(ed().addTrack('video'), 12);
    await call('set_range', { in: 5, out: 8 });
    const r = await oneStepOf(() => call('extract_range'));
    expect(r.data).toEqual({ in: 5, out: 8, seconds: 3, removed: 0, split: 1, trimmed: 0, moved: 2, range: { in: 5 } });
    expect(proj().range).toEqual({ in: 5 });
    expect(clipOf(o).start).toBe(9);
    expect(clipOf(a).duration).toBe(5);
  });

  it('extract answers the range rounded like set_range', async () => {
    addVideoClip(video, 0);
    await call('set_range', { in: 1.0333, out: 2 });
    const r = await call('extract_range');
    expect(r.ok, r.text).toBe(true);
    expect(r.data.in).toBe(1.0333);
    expect(r.data.range).toEqual({ in: 1.0333 });
  });

  it('without both marks the error names set_range', async () => {
    addVideoClip(video, 0);
    await refused('lift_range', {}, /set_range marks the range, get_project shows it/);
    await refused('extract_range', {}, /set_range marks the range/);
    await call('set_range', { in: 2 });
    await refused('lift_range', {}, /set_range marks the range/);
    await call('set_range', { in: 30, out: 40 });
    await refused('extract_range', {}, /set_range marks the range/);
  });

  it('both are destructive', async () => {
    const { listTools } = await import('../registry');
    const tools = new Map(listTools().tools.map((t) => [t.name, t]));
    expect(tools.get('lift_range')!.annotations?.destructiveHint).toBe(true);
    expect(tools.get('extract_range')!.annotations?.destructiveHint).toBe(true);
    expect(tools.get('slip_clip')!.annotations?.destructiveHint).toBeUndefined();
  });
});

describe('nudge_clips', () => {
  const track = () => proj().tracks.find((t) => t.kind === 'video')!.id;

  it('one undo step, effects come along', async () => {
    const a = await text('a', 1);
    const b = await text('b', 6);
    const fx = (await call('add_effect', { effect: 'echo', target: a })).data.id as string;
    const startA = clipOf(a).start;
    const startFx = clipOf(fx).start;
    const r = await oneStepOf(() => call('nudge_clips', { ids: [a, b], frames: 3 }));
    expect(r.data).toMatchObject({ moved: [a, b], frames: 3, seconds: 0.1 });
    expect(r.data.followers).toEqual([fx]);
    expect(r.data.clips.map((c: any) => c.id)).toEqual([a, b]);
    expect(clipOf(a).start).toBeCloseTo(startA + 0.1, 6);
    expect(clipOf(b).start).toBeCloseTo(6.1, 6);
    expect(clipOf(fx).start).toBeCloseTo(startFx + 0.1, 6);
    expect(r.data.clips[0].start).toBeCloseTo(startA + 0.1, 4);
    const back = await call('nudge_clips', { ids: [a], frames: -3 });
    expect(back.ok, back.text).toBe(true);
    expect(back.data.seconds).toBe(-0.1);
    expect(clipOf(a).start).toBeCloseTo(startA, 6);
  });

  it('all or nothing names the clip', async () => {
    const a = await text('a', 0);
    const b = await text('b', 2);
    await refused('nudge_clips', { ids: [a], frames: 15 }, /^nothing moved: /);
    const r = await call('nudge_clips', { ids: [a], frames: 15 });
    expect(r.text).toBe('nothing moved: "a" would run into "b"');
    await refused('nudge_clips', { ids: [a, b], frames: -1 }, /^nothing moved: /);
    expect(clipOf(a).start).toBe(0);
    expect(clipOf(b).start).toBe(2);
  });

  it('refuses unknown and locked clips, 0 and over a day', async () => {
    const a = await text('a', 3);
    const b = await text('b', 8);
    await refused('nudge_clips', { ids: ['ghost'], frames: 1 }, /no clip with the id ghost/);
    await refused('nudge_clips', { ids: [a, 'ghost'], frames: 1 }, /no clip with the id ghost/);
    await refused('nudge_clips', { ids: [a], frames: 0 }, /^nothing changed: frames is 0$/);
    await refused('nudge_clips', { ids: [a], frames: 2592001 }, /^frames is more than a day$/);
    await refused('nudge_clips', { ids: [a], frames: -2592001 }, /^frames is more than a day$/);
    await refused('nudge_clips', { ids: [a], frames: 1.5 }, /must be an integer/);
    await refused('nudge_clips', { ids: [], frames: 1 }, /at least 1 item/);
    await refused('nudge_clips', { ids: [a] }, /frames is missing/);
    ed().updateTrack(clipOf(b).trackId, { locked: true });
    await refused('nudge_clips', { ids: [a], frames: 1 }, /locked track/);
    expect(clipOf(a).start).toBe(3);
    void track;
  });

  it('group mates are not added', async () => {
    const a = await text('a', 1);
    const other = ed().addTrack('video');
    const m = (await call('add_text', { text: 'm', start: 1, duration: 2, track: other })).data.id as string;
    await call('group_clips', { ids: [a, m] });
    expect(clipOf(a).group).toBeTruthy();
    const r = await oneStepOf(() => call('nudge_clips', { ids: [a], frames: 3 }));
    expect(r.data.moved).toEqual([a]);
    expect(r.data.followers).toEqual([]);
    expect(clipOf(a).start).toBeCloseTo(1.1, 6);
    expect(clipOf(m).start).toBe(1);
    // the same ids twice count once
    const twice = await call('nudge_clips', { ids: [a, a], frames: 1 });
    expect(twice.data.moved).toEqual([a]);
  });
});
