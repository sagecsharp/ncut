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
