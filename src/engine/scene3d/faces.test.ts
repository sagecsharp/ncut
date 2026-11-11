import { describe, expect, it } from 'vitest';
import { createProject, createShapeClip, createTextClip } from '../../lib/factory';
import { SHAPES_3D } from '../../types';
import type { Project } from '../../types';
import { FACE_ALL, defaultFit, faceClipId, faceColor, faceFill, faceFit, faceNames, faceSource, faceSourceIds, filledFaces, hasSides, remapFaces, withFace } from './faces';

function scene(): { p: Project; solid: ReturnType<typeof createShapeClip>; pic: ReturnType<typeof createShapeClip>; txt: ReturnType<typeof createTextClip> } {
  const p = createProject();
  const t = p.tracks.find((x) => x.kind === 'video')!;
  const solid = createShapeClip(t.id, 0, { threeD: true, shape: 'box' });
  const pic = createShapeClip(t.id, 0, {});
  const txt = createTextClip(t.id, 0, {});
  p.clips.push(solid, pic, txt);
  return { p, solid, pic, txt };
}

describe('the sides of a shape', () => {
  it('every shape is known, a plane has none, names do not repeat', () => {
    for (const s of SHAPES_3D) {
      const names = faceNames(s);
      expect(new Set(names).size).toBe(names.length);
      expect(names.includes(FACE_ALL)).toBe(false);
      expect(names.length > 0).toBe(s !== 'plane');
    }
    expect(faceNames(undefined)).toEqual([]);
    expect(faceNames('box')).toEqual(['front', 'back', 'right', 'left', 'top', 'bottom']);
    expect(faceNames('cylinder')).toEqual(['side', 'top', 'bottom']);
    expect(faceNames('cone')).toEqual(['side', 'bottom']);
    expect(faceNames('star')).toEqual(['front', 'back', 'side']);
    expect(faceNames('sphere')).toEqual(['surface']);
  });
  it('only a 3d solid has sides', () => {
    expect(hasSides({ threeD: true, shape: 'box' })).toBe(true);
    expect(hasSides({ threeD: false, shape: 'box' })).toBe(false);
    expect(hasSides({ threeD: true })).toBe(false);
    expect(hasSides({ threeD: true, shape: 'plane' })).toBe(false);
  });
});

describe('what a side shows', () => {
  it('its own entry, else the one for all, else nothing', () => {
    const c = { threeD: true, shape: 'box' as const, faces: { all: { color: '#ff0000' }, top: { clip: 'x' }, left: null } };
    expect(faceFill(c, 'top')).toEqual({ clip: 'x' });
    expect(faceFill(c, 'front')).toEqual({ color: '#ff0000' });
    expect(faceFill(c, 'left')).toBeNull();
    expect(filledFaces(c)).toEqual(['front', 'back', 'right', 'top', 'bottom']);
    expect(faceFill({ threeD: true, shape: 'box' }, 'top')).toBeNull();
    // a flat clip keeps the field but shows nothing from it
    expect(faceFill({ ...c, threeD: false }, 'top')).toBeNull();
    expect(filledFaces({ ...c, shape: 'plane' })).toEqual([]);
  });
  it('reads a color or a clip id out of a fill', () => {
    expect(faceColor({ color: '#00ff00' })).toBe('#00ff00');
    expect(faceColor({ clip: 'a' })).toBeNull();
    expect(faceClipId({ clip: 'a' })).toBe('a');
    expect(faceClipId({ clip: '' })).toBeNull();
    expect(faceClipId(null)).toBeNull();
  });
  it('pictures cover a side, text and figures fit inside it, unless the fill says so', () => {
    expect(defaultFit({ type: 'video' })).toBe('fill');
    expect(defaultFit({ type: 'image' })).toBe('fill');
    expect(defaultFit({ type: 'text' })).toBe('fit');
    expect(defaultFit({ type: 'shape' })).toBe('fit');
    expect(faceFit({ clip: 'a', fit: 'stretch' }, { type: 'video' })).toBe('stretch');
    expect(faceFit({ clip: 'a' }, { type: 'text' })).toBe('fit');
    expect(faceFit({ clip: 'a', fit: 'nope' as never }, { type: 'image' })).toBe('fill');
  });
});

describe('the clip on a side', () => {
  it('is found by id', () => {
    const { p, solid, pic } = scene();
    solid.faces = { top: { clip: pic.id } };
    expect(faceSource(p, solid, 'top')).toBe(pic);
    expect(faceSource(p, solid, 'front')).toBeNull();
  });
  it('not the solid itself, not a missing clip, not one on a hidden track', () => {
    const { p, solid, pic } = scene();
    solid.faces = { top: { clip: solid.id }, front: { clip: 'gone' }, back: { clip: pic.id } };
    expect(faceSource(p, solid, 'top')).toBeNull();
    expect(faceSource(p, solid, 'front')).toBeNull();
    expect(faceSource(p, solid, 'back')).toBe(pic);
    p.tracks.find((t) => t.id === pic.trackId)!.hidden = true;
    expect(faceSource(p, solid, 'back')).toBeNull();
  });
  it('lists every clip that lives on a solid with the solids that show it', () => {
    const { p, solid, pic, txt } = scene();
    expect(faceSourceIds(p).size).toBe(0);
    solid.faces = { all: { clip: pic.id }, top: { clip: txt.id }, bottom: { color: '#000000' } };
    const ids = faceSourceIds(p);
    expect(ids.get(pic.id)).toEqual([solid.id]);
    expect(ids.get(txt.id)).toEqual([solid.id]);
    expect(ids.has(solid.id)).toBe(false);
  });
  it('a fill on a flat clip or on a side the shape does not have does not hide anything', () => {
    const { p, solid, pic } = scene();
    solid.faces = { top: { clip: pic.id } };
    solid.threeD = false;
    expect(faceSourceIds(p).size).toBe(0);
    solid.threeD = true;
    solid.shape = 'sphere';
    expect(faceSourceIds(p).size).toBe(0);
  });
});

describe('changing the fills', () => {
  it('sets, clears and tidies', () => {
    let f = withFace(undefined, 'top', { color: '#112233' });
    expect(f).toEqual({ top: { color: '#112233' } });
    f = withFace(f, FACE_ALL, { clip: 'a' });
    f = withFace(f, 'left', null);
    expect(f).toEqual({ top: { color: '#112233' }, all: { clip: 'a' }, left: null });
    // 'all' emptied: the "own picture here" entry says nothing any more
    f = withFace(f, FACE_ALL, null);
    expect(f).toEqual({ top: { color: '#112233' } });
    expect(withFace(f, 'top', undefined)).toBeUndefined();
    // "own picture" on a side while nothing is set for all: nothing to store
    expect(withFace(undefined, 'top', null)).toBeUndefined();
  });
  it('does not change the object it was given', () => {
    const f = { top: { color: '#112233' } };
    withFace(f, 'top', { color: '#000000' });
    expect(f).toEqual({ top: { color: '#112233' } });
  });
  it('swaps and drops clip ids', () => {
    const f = { all: { clip: 'a', fit: 'fit' as const }, top: { clip: 'b' }, left: null, bottom: { color: '#000000' } };
    expect(remapFaces(f, (id) => (id === 'a' ? 'a2' : undefined))).toEqual({ all: { clip: 'a2', fit: 'fit' }, top: { clip: 'b' }, left: null, bottom: { color: '#000000' } });
    // the clip for all sides is gone: its entry goes, and the "own picture" entry with it
    expect(remapFaces(f, (id) => (id === 'a' ? null : undefined))).toEqual({ top: { clip: 'b' }, bottom: { color: '#000000' } });
    expect(remapFaces({ top: { clip: 'b' } }, () => null)).toBeUndefined();
    // nothing to do: the same object comes back
    expect(remapFaces(f, () => undefined)).toBe(f);
    expect(remapFaces(undefined, () => null)).toBeUndefined();
  });
});
