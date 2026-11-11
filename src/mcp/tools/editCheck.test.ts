import { beforeEach, describe, expect, it } from 'vitest';
import type { ClipType } from '../../types';
import { AUDIO_FIELDS, CAMERA_FIELDS, COMMON_FIELDS, EFFECT_FIELDS, PICTURE_FIELDS, SHAPE_FIELDS, TEXT_FIELDS, VIDEO_FIELDS, type FieldRow } from './catalogFields';
import { knowsField } from './editCheck';
import { call, clipOf, fresh, oneStepOf, refused } from './editKit';

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
