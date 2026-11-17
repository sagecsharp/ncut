import { beforeEach, describe, expect, it } from 'vitest';
import type { ClipType } from '../../types';
import { AUDIO_FIELDS, CAMERA_FIELDS, COMMON_FIELDS, EFFECT_FIELDS, PICTURE_FIELDS, SHAPE_FIELDS, TEXT_FIELDS, VIDEO_FIELDS, type FieldRow } from './catalogFields';
import { useEditor } from '../../store/editorStore';
import { knowsField } from './editCheck';
import { addVideoClip, call, clipOf, fresh, oneStepOf, refused } from './editKit';

let text = '';
let shape = '';

beforeEach(async () => {
  fresh();
  text = (await call('add_text', { text: 'hi', start: 0, duration: 4 })).data.id;
  shape = (await call('add_shape', { kind: 'rect', start: 0, duration: 4 })).data.id;
});

describe('update_clip checks what a field may hold', () => {
  it('refuses made up ids and names', async () => {
    await refused('update_clip', { id: text, patch: { blend: 'nope' } }, /blend must be one of: normal, add/);
    await refused('update_clip', { id: text, patch: { transition: { id: 'nope', duration: 1 } } }, /no transition "nope".*list_options/);
    await refused('update_clip', { id: text, patch: { motionIn: { id: 'nope' } } }, /no clip motion "nope"/);
    await refused('update_clip', { id: text, patch: { animLoop: { id: 'fade', duration: 1 } } }, /no looping text animation "fade"/);
    await refused('update_clip', { id: text, patch: { align: 'middle' } }, /align must be one of: left, center, right/);
    await refused('update_clip', { id: text, patch: { fontWeight: 500 } }, /fontWeight must be one of: 400, 700/);
    await refused('update_clip', { id: shape, patch: { kind: 'blob' } }, /kind must be one of/);
    await refused('update_clip', { id: shape, patch: { shape: 'donut' } }, /shape must be one of: plane, box/);
    await refused('update_clip', { id: shape, patch: { lookTarget: 'clp_missing' } }, /no clip with the id clp_missing/);
    await refused('update_clip', { id: shape, patch: { lookTarget: shape } }, /cannot be the clip itself/);
  });

  it('refuses values of the wrong kind or out of range', async () => {
    await refused('update_clip', { id: text, patch: { transition: 5 } }, /transition must be an object/);
    await refused('update_clip', { id: text, patch: { crop: 'x' } }, /crop must be an object/);
    await refused('update_clip', { id: text, patch: { crop: { left: 2 } } }, /crop\.left must be between 0 and 0\.95/);
    await refused('update_clip', { id: text, patch: { crop: { lefty: 0.1 } } }, /crop\.lefty is not a known field/);
    await refused('update_clip', { id: text, patch: { color: 'bluish' } }, /color must be a color like #ff8800/);
    await refused('update_clip', { id: text, patch: { stroke: { width: 'a' } } }, /stroke\.width must be a number/);
    await refused('update_clip', { id: text, patch: { stroke: { width: 0.1 } } }, /stroke also needs color/);
    await refused('update_clip', { id: text, patch: { fontSize: 2 } }, /fontSize must be between 4 and 1000/);
    await refused('update_clip', { id: text, patch: { italic: 'yes' } }, /italic must be true or false/);
    await refused('update_clip', { id: shape, patch: { points: 4.5 } }, /points must be a whole number/);
    await refused('update_clip', { id: shape, patch: { mask: {} } }, /mask also needs shape/);
  });

  it('completes a partial object from neutral values and from what the clip has', async () => {
    await oneStepOf(() => call('update_clip', { id: text, patch: { crop: { left: 0.2 } } }));
    expect((clipOf(text) as { crop?: unknown }).crop).toEqual({ left: 0.2, top: 0, right: 0, bottom: 0 });
    await oneStepOf(() => call('update_clip', { id: text, patch: { crop: { top: 0.1 } } }));
    expect((clipOf(text) as { crop?: unknown }).crop).toEqual({ left: 0.2, top: 0.1, right: 0, bottom: 0 });
    await oneStepOf(() => call('update_clip', { id: text, patch: { transition: { id: 'cross-fade' } } }));
    expect((clipOf(text) as { transition?: unknown }).transition).toEqual({ id: 'cross-fade', duration: 0.6 });
    await oneStepOf(() => call('update_clip', { id: text, patch: { stroke: { color: '#000000', width: 0.08 } } }));
    await oneStepOf(() => call('update_clip', { id: text, patch: { stroke: { width: 0.2 } } }));
    expect((clipOf(text) as { stroke?: unknown }).stroke).toEqual({ color: '#000000', width: 0.2 });
    await oneStepOf(() => call('update_clip', { id: shape, patch: { mask: { shape: 'ellipse', feather: 0.2 } } }));
    expect((clipOf(shape) as { mask?: unknown }).mask).toEqual({ shape: 'ellipse', x: 0, y: 0, width: 1, height: 1, rotation: 0, feather: 0.2, invert: false });
    await oneStepOf(() => call('update_clip', { id: shape, patch: { adjust: { hue: 90 } } }));
    expect((clipOf(shape) as { adjust?: unknown }).adjust).toEqual({ brightness: 0, contrast: 0, saturation: 0, temperature: 0, hue: 90 });
  });

  it('null takes an optional object away', async () => {
    await call('update_clip', { id: text, patch: { crop: { left: 0.2 } } });
    await oneStepOf(() => call('update_clip', { id: text, patch: { crop: null } }));
    expect((clipOf(text) as { crop?: unknown }).crop ?? null).toBeNull();
  });

  it('lit takes a number 0..1 or null (off)', async () => {
    await call('update_clip', { id: shape, patch: { threeD: true } });
    await call('update_clip', { id: shape, patch: { lit: 0.5 } });
    expect((clipOf(shape) as { lit?: unknown }).lit).toBe(0.5);
    await oneStepOf(() => call('update_clip', { id: shape, patch: { lit: null } }));
    expect((clipOf(shape) as { lit?: unknown }).lit ?? null).toBeNull();
    await refused('update_clip', { id: shape, patch: { lit: 2 } }, /lit must be between 0 and 1/);
  });

  it('the same checks guard the fields of the add tools', async () => {
    const r = await call('add_text', { text: 'x', start: 5, fields: { blend: 'nope' } });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/blend must be one of/);
  });
});

describe('the fields reference and the checks agree', () => {
  // these go through their own store actions or the store's own parsers
  const ELSEWHERE = new Set(['transform', 'params', 'speed', 'parent', 'bpm', 'beatOffset', 'beat']);
  const cases: [ClipType, FieldRow[]][] = [
    ['video', [...COMMON_FIELDS, ...PICTURE_FIELDS, ...VIDEO_FIELDS]],
    ['image', [...COMMON_FIELDS, ...PICTURE_FIELDS]],
    ['audio', [...COMMON_FIELDS, ...AUDIO_FIELDS]],
    ['text', [...COMMON_FIELDS, ...PICTURE_FIELDS, ...TEXT_FIELDS]],
    ['shape', [...COMMON_FIELDS, ...PICTURE_FIELDS, ...SHAPE_FIELDS]],
    ['effect', [...COMMON_FIELDS, ...EFFECT_FIELDS]],
    ['camera', [...COMMON_FIELDS, ...CAMERA_FIELDS]],
  ];
  it.each(cases)('every listed %s field has a check', (type, rows) => {
    const unchecked = rows.map((r) => r.field).filter((f) => !ELSEWHERE.has(f) && !knowsField(type, f));
    expect(unchecked).toEqual([]);
  });
});

describe('effect params keep inside the effect\'s ranges', () => {
  it('refuses a value the store would clamp', async () => {
    fresh();
    const fx = (await call('add_effect', { effect: 'vignette', start: 0, duration: 2 })).data.id;
    await refused('update_clip', { id: fx, patch: { params: { strength: 500 } } }, /params\.strength must be between 0 and 100/);
    await oneStepOf(() => call('update_clip', { id: fx, patch: { params: { strength: 40 } } }));
    expect((clipOf(fx) as { params: Record<string, number> }).params.strength).toBe(40);
  });
});

describe('update_clip bend and pivot', () => {
  it('bend refuses angle 400 and along sideways, merges angle over the current bend', async () => {
    await refused('update_clip', { id: shape, patch: { bend: { angle: 400 } } }, /bend\.angle must be between -360 and 360/);
    await refused('update_clip', { id: shape, patch: { bend: { angle: 10, along: 'sideways' } } }, /bend\.along must be one of: width, height/);
    await call('update_clip', { id: shape, patch: { bend: { angle: 45, along: 'height', center: 0.25, span: 800 } } });
    await oneStepOf(() => call('update_clip', { id: shape, patch: { bend: { angle: 90 } } }));
    expect((clipOf(shape) as { bend?: unknown }).bend).toEqual({ angle: 90, along: 'height', center: 0.25, span: 800 });
    await oneStepOf(() => call('update_clip', { id: shape, patch: { bend: null } }));
    expect((clipOf(shape) as { bend?: unknown }).bend ?? null).toBeNull();
  });

  it('pivot takes { x, y }, a partial object, a spot name and null', async () => {
    await oneStepOf(() => call('update_clip', { id: shape, patch: { pivot: { x: -0.5, y: 0.25 } } }));
    expect((clipOf(shape) as { pivot?: unknown }).pivot).toEqual({ x: -0.5, y: 0.25 });
    await oneStepOf(() => call('update_clip', { id: shape, patch: { pivot: { x: 0.5 } } }));
    expect((clipOf(shape) as { pivot?: unknown }).pivot).toEqual({ x: 0.5, y: 0.25 });
    await oneStepOf(() => call('update_clip', { id: shape, patch: { pivot: 'bottom-left' } }));
    expect((clipOf(shape) as { pivot?: unknown }).pivot).toEqual({ x: -0.5, y: 0.5 });
    await oneStepOf(() => call('update_clip', { id: shape, patch: { pivot: null } }));
    expect((clipOf(shape) as { pivot?: unknown }).pivot ?? null).toBeNull();
    await call('update_clip', { id: shape, patch: { pivot: 'left' } });
    await oneStepOf(() => call('update_clip', { id: shape, patch: { pivot: 'middle' } }));
    expect((clipOf(shape) as { pivot?: unknown }).pivot ?? null).toBeNull();
  });

  it('pivot refuses out of range numbers, unknown names and other fields', async () => {
    await refused('update_clip', { id: shape, patch: { pivot: { x: 11, y: 0 } } }, /pivot\.x must be between -10 and 10/);
    await refused('update_clip', { id: shape, patch: { pivot: 'nowhere' } }, /pivot must be \{ x, y \}, null or one of: top-left/);
    await refused('update_clip', { id: shape, patch: { pivot: { x: 0, y: 0, z: 1 } } }, /pivot\.z is not a known field/);
    await refused('update_clip', { id: shape, patch: { pivot: 5 } }, /pivot must be an object/);
  });
});

describe('update_clip grade and pan', () => {
  let video = '';
  const gradeOf = (id: string) => (clipOf(id) as { grade?: Record<string, unknown> | null }).grade;
  beforeEach(() => {
    const t = fresh().video;
    video = addVideoClip(t, 0);
  });

  it('a partial grade lies over the current one', async () => {
    await oneStepOf(() => call('update_clip', { id: video, patch: { grade: { liftR: 0.2, gammaY: -0.1 } } }));
    expect(gradeOf(video)).toMatchObject({ liftR: 0.2, gammaY: -0.1 });
    await oneStepOf(() => call('update_clip', { id: video, patch: { grade: { liftB: 0.3 } } }));
    expect(gradeOf(video)).toMatchObject({ liftR: 0.2, gammaY: -0.1, liftB: 0.3 });
    await oneStepOf(() => call('update_clip', { id: video, patch: { grade: { off: true } } }));
    expect(gradeOf(video)).toMatchObject({ liftR: 0.2, off: true });
  });

  it('zeroing the last wheel number takes the grade away, it is not an unknown field', async () => {
    await oneStepOf(() => call('update_clip', { id: video, patch: { grade: { liftR: 0.2 } } }));
    await oneStepOf(() => call('update_clip', { id: video, patch: { grade: { liftR: 0 } } }));
    expect(gradeOf(video) ?? null).toBeNull();
  });

  it('a grade on an audio or camera clip is still refused', async () => {
    const t = fresh().audio;
    useEditor.getState().addAsset({ id: 'song', name: 'song', kind: 'audio', mime: 'audio/mpeg', size: 1, duration: 10, width: 0, height: 0, hasAudio: true, createdAt: 0 });
    const aud = useEditor.getState().insertAsset('song', { trackId: t, start: 0 })!;
    const cam = (await call('add_camera', {})).data.id as string;
    await refused('update_clip', { id: aud, patch: { grade: { liftR: 0.1 } } }, /a audio clip has no grade field/);
    await refused('update_clip', { id: aud, patch: { grade: null } }, /a audio clip has no grade field/);
    await refused('update_clip', { id: cam, patch: { grade: { liftR: 0.1 } } }, /a camera clip has no grade field/);
    await refused('update_clip', { id: cam, patch: { grade: null } }, /a camera clip has no grade field/);
  });

  it('grade numbers are -1..1', async () => {
    await refused('update_clip', { id: video, patch: { grade: { liftR: 3 } } }, /grade\.liftR must be between -1 and 1, got 3/);
    await refused('update_clip', { id: video, patch: { grade: { offsetY: 'a' } } }, /grade\.offsetY must be a number/);
    await refused('update_clip', { id: video, patch: { grade: { off: 1 } } }, /grade\.off must be true or false/);
    await refused('update_clip', { id: video, patch: { grade: { tint: 0.1 } } }, /grade\.tint is not a known field/);
    await refused('update_clip', { id: video, patch: { grade: 5 } }, /grade must be an object/);
  });

  it('curves take the seven kinds only', async () => {
    await refused('update_clip', { id: video, patch: { grade: { curves: { q: [] } } } }, /grade\.curves\.q is not a known field \(known: y, r, g, b, hueSat, hueHue, lumaSat\)/);
    await oneStepOf(() => call('update_clip', { id: video, patch: { grade: { curves: { lumaSat: [[0, 0.5], [1, 0.5]], hueHue: [[0, 0.5], [1, 0.5]] } } } }));
  });

  it('a curve is a list of [x, y] points 0..1, at most 16', async () => {
    const text = /grade\.curves\.y must be a list of \[x, y\] points, x and y from 0 to 1, at most 16/;
    const seventeen = Array.from({ length: 17 }, (_, i) => [i / 16, i / 16]);
    await refused('update_clip', { id: video, patch: { grade: { curves: { y: seventeen } } } }, text);
    await refused('update_clip', { id: video, patch: { grade: { curves: { y: [[0, 0], [1, 2]] } } } }, text);
    await refused('update_clip', { id: video, patch: { grade: { curves: { y: [[0, 0, 1]] } } } }, text);
    await refused('update_clip', { id: video, patch: { grade: { curves: { y: 'up' } } } }, text);
    await refused('update_clip', { id: video, patch: { grade: { curves: { y: [[0, 'a']] } } } }, text);
    const sixteen = Array.from({ length: 16 }, (_, i) => [i / 15, i / 15]);
    await oneStepOf(() => call('update_clip', { id: video, patch: { grade: { curves: { y: sixteen } } } }));
  });

  it('a null curve takes that list away', async () => {
    await call('update_clip', { id: video, patch: { grade: { curves: { y: [[0, 0], [0.25, 0.2], [0.75, 0.8], [1, 1]], r: [[0, 0], [0.5, 0.6], [1, 1]] } } } });
    const curves = () => (gradeOf(video) as { curves?: Record<string, unknown> }).curves ?? {};
    expect(curves().y).toBeTruthy();
    await oneStepOf(() => call('update_clip', { id: video, patch: { grade: { curves: { y: null } } } }));
    expect(curves().y ?? null).toBeNull();
    expect(curves().r).toBeTruthy();
  });

  it('grade is refused on a blur effect and lands on a grade effect', async () => {
    const blur = (await call('add_effect', { effect: 'blur', start: 0, duration: 2 })).data.id as string;
    await refused('update_clip', { id: blur, patch: { grade: { liftR: 0.1 } } }, /grade is only for the grade effect\. a picture clip has its own grade/);
    await refused('update_clip', { id: blur, patch: { grade: null } }, /grade is only for the grade effect/);
    const fx = (await call('add_effect', { effect: 'grade', start: 0, duration: 2 })).data.id as string;
    await oneStepOf(() => call('update_clip', { id: fx, patch: { grade: { gainG: 0.25 } } }));
    expect(gradeOf(fx)).toMatchObject({ gainG: 0.25 });
    await refused('update_clip', { id: fx, patch: { grade: { gainG: 2 } } }, /grade\.gainG must be between -1 and 1/);
  });

  it('pan is -1..1 on sound clips', async () => {
    await refused('update_clip', { id: video, patch: { pan: 2 } }, /pan must be between -1 and 1, got 2/);
    await refused('update_clip', { id: video, patch: { pan: 'left' } }, /pan must be a number/);
    await oneStepOf(() => call('update_clip', { id: video, patch: { pan: -0.5 } }));
    expect((clipOf(video) as { pan?: number }).pan).toBe(-0.5);
    // the store drops the key for a centered pan: that is not an unknown field
    await oneStepOf(() => call('update_clip', { id: video, patch: { pan: 0 } }));
    expect('pan' in clipOf(video)).toBe(false);
    // a text clip has no sound
    const title = (await call('add_text', { text: 't', start: 0, duration: 1 })).data.id as string;
    await refused('update_clip', { id: title, patch: { pan: 0.5 } }, /a text clip has no pan field/);
  });
});
