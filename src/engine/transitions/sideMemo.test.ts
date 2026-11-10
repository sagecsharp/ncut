import { describe, expect, it } from 'vitest';
import { type SideKeyInput, SideMemo, constantSideKind, frozenSideKey, objectSerial, textureHolds } from './sideMemo';

const clip = {};
const project = {};
const clips = [{}];
const tracks = [{}];
const bitmap = {};

function input(over: Partial<SideKeyInput> = {}): SideKeyInput {
  return {
    clip,
    project,
    clips,
    clipCount: 1,
    tracks,
    paintTime: 4.9999,
    fxTime: 4.9999,
    width: 1920,
    height: 1080,
    matrix: [1, 0, 0, 1, 0, 0],
    channel: 'default',
    quality: 1,
    fonts: 3,
    image: null,
    ...over,
  };
}

describe('objectSerial', () => {
  it('is stable per object and different between objects', () => {
    const a = {};
    const b = {};
    expect(objectSerial(a)).toBe(objectSerial(a));
    expect(objectSerial(a)).not.toBe(objectSerial(b));
  });
});

describe('frozenSideKey', () => {
  it('the same inputs give the same key', () => {
    expect(frozenSideKey(input())).toBe(frozenSideKey(input()));
    const withImage = { source: bitmap, width: 100, height: 50 };
    expect(frozenSideKey(input({ image: withImage }))).toBe(frozenSideKey(input({ image: { ...withImage } })));
  });
  it('every input changes the key', () => {
    const base = frozenSideKey(input({ image: { source: bitmap, width: 100, height: 50 } }));
    const changes: Partial<SideKeyInput>[] = [
      { clip: {} },
      { project: {} },
      { clips: [] },
      { clipCount: 2 },
      { tracks: [] },
      { paintTime: 5 },
      { fxTime: 5 },
      { width: 1280 },
      { height: 720 },
      { matrix: [2, 0, 0, 2, 0, 0] },
      { matrix: [1, 0, 0, 1, 0.5, 0] },
      { channel: 'export' },
      { quality: 0.5 },
      { fonts: 4 },
      { image: null },
      { image: { source: {}, width: 100, height: 50 } },
      { image: { source: bitmap, width: 200, height: 50 } },
      { image: { source: bitmap, width: 100, height: 60 } },
    ];
    const seen = new Set([base]);
    for (const c of changes) {
      const k = frozenSideKey(input({ image: { source: bitmap, width: 100, height: 50 }, ...c }));
      expect(seen.has(k)).toBe(false);
      seen.add(k);
    }
  });
});

describe('constantSideKind', () => {
  it('only a frozen, flat text / shape / image side is constant', () => {
    expect(constantSideKind('text', undefined, true)).toBe(true);
    expect(constantSideKind('shape', false, true)).toBe(true);
    expect(constantSideKind('image', undefined, true)).toBe(true);
    // a video frame object can hold another frame
    expect(constantSideKind('video', undefined, true)).toBe(false);
    // a live side changes with the time
    expect(constantSideKind('text', undefined, false)).toBe(false);
    // 3d reads the camera at the frame time
    expect(constantSideKind('image', true, true)).toBe(false);
    expect(constantSideKind('effect', undefined, true)).toBe(false);
  });
});

describe('SideMemo', () => {
  it('holds a key per canvas until it is painted for no key', () => {
    const m = new SideMemo();
    const a = {};
    const b = {};
    expect(m.holds(a, 'k')).toBe(false);
    m.set(a, 'k');
    expect(m.holds(a, 'k')).toBe(true);
    expect(m.holds(a, 'k2')).toBe(false);
    expect(m.holds(b, 'k')).toBe(false);
    // a side without a key is never "held", even right after another one without a key
    expect(m.holds(a, null)).toBe(false);
    m.set(a, null);
    expect(m.holds(a, 'k')).toBe(false);
  });
});

describe('textureHolds', () => {
  it('skips the upload only for the same key that was uploaded last', () => {
    expect(textureHolds('k', 'k')).toBe(true);
    expect(textureHolds('k', 'j')).toBe(false);
    expect(textureHolds(null, 'k')).toBe(false);
    expect(textureHolds('k', undefined)).toBe(false);
    expect(textureHolds(null, undefined)).toBe(false);
  });
});
