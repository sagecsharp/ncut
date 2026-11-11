import { describe, expect, it } from 'vitest';
import { withFace } from '../../engine/scene3d/faces';
import { createProject, createShapeClip, createTextClip } from '../../lib/factory';
import type { Project, VisualClip } from '../../types';
import { COLOR, OWN, SAME, choiceOf, facesPatch, fillFromChoice, headChoices, rowColor, rowFit, sideRows, solidsShowing, startColor, takeOffPatches, withFit } from './facesLogic';
import { faceClipOptions } from './parentOptions';

function scene() {
  const p: Project = createProject();
  const t = p.tracks.find((x) => x.kind === 'video')!;
  const solid = createShapeClip(t.id, 0, { threeD: true, shape: 'box' }) as VisualClip;
  const other = createShapeClip(t.id, 0, { threeD: true, shape: 'cylinder' }) as VisualClip;
  const pic = createShapeClip(t.id, 0, {});
  const txt = createTextClip(t.id, 0, {});
  p.clips.push(solid, other, pic, txt);
  return { p, solid, other, pic, txt };
}

const std = { type: 'image' };

describe('rows', () => {
  it('all sides first, then one per side', () => {
    const rows = sideRows('box');
    expect(rows.map((r) => r.label)).toEqual(['all sides', 'front', 'back', 'right', 'left', 'top', 'bottom']);
    expect(rows[0]!.all).toBe(true);
    expect(rows.slice(1).every((r) => !r.all)).toBe(true);
    expect(sideRows('cone').map((r) => r.name)).toEqual(['all', 'side', 'bottom']);
  });
  it('a shape with one side has one row, stored under all', () => {
    for (const s of ['sphere', 'torus', 'capsule'] as const) expect(sideRows(s)).toEqual([{ name: 'all', label: 'surface', all: true }]);
  });
  it('a plane has no rows', () => {
    expect(sideRows('plane')).toEqual([]);
    expect(sideRows(undefined)).toEqual([]);
  });
});

describe('choices', () => {
  const [all, front] = sideRows('box');
  it('same as all only while all has a fill', () => {
    expect(headChoices(front!, undefined).map((c) => c[0])).toEqual([OWN, COLOR]);
    expect(headChoices(front!, { all: { color: '#f00000' } }).map((c) => c[0])).toEqual([SAME, OWN, COLOR]);
    expect(headChoices(all!, { all: { color: '#f00000' } }).map((c) => c[0])).toEqual([OWN, COLOR]);
  });
  it('reads the value of a row', () => {
    expect(choiceOf(undefined, all!)).toBe(OWN);
    expect(choiceOf(undefined, front!)).toBe(OWN);
    expect(choiceOf({ all: { color: '#fff' } }, front!)).toBe(SAME);
    expect(choiceOf({ all: { color: '#fff' }, front: null }, front!)).toBe(OWN);
    expect(choiceOf({ all: { color: '#fff' }, front: { clip: 'a' } }, front!)).toBe('a');
    expect(choiceOf({ front: { color: '#fff' } }, front!)).toBe(COLOR);
    // a null that says nothing (no all) reads as the own picture
    expect(choiceOf({ front: null }, front!)).toBe(OWN);
    expect(choiceOf({ front: { clip: 'a' } }, all!)).toBe(OWN);
  });
});

describe('value to fill', () => {
  const [all, front] = sideRows('box');
  it('own picture removes the entry, or is null while all has a fill', () => {
    expect(fillFromChoice(OWN, all!, { all: { color: '#fff' } }, std)).toBeUndefined();
    expect(fillFromChoice(OWN, front!, undefined, std)).toBeUndefined();
    expect(fillFromChoice(OWN, front!, { all: { color: '#fff' } }, std)).toBeNull();
  });
  it('same as all removes the entry', () => {
    expect(fillFromChoice(SAME, front!, { all: { color: '#fff' } }, std)).toBeUndefined();
  });
  it('color starts with white, the fill of a shape, or the color it already has', () => {
    expect(fillFromChoice(COLOR, front!, undefined, std)).toEqual({ color: '#ffffff' });
    expect(fillFromChoice(COLOR, front!, undefined, { type: 'shape', color: '#336699' })).toEqual({ color: '#336699' });
    expect(fillFromChoice(COLOR, front!, { front: { color: '#123456' } }, std)).toEqual({ color: '#123456' });
    expect(startColor({ type: 'text' })).toBe('#ffffff');
  });
  it('a clip keeps the fit that was set on the row', () => {
    expect(fillFromChoice('a', front!, undefined, std)).toEqual({ clip: 'a' });
    expect(fillFromChoice('b', front!, { front: { clip: 'a', fit: 'stretch' } }, std)).toEqual({ clip: 'b', fit: 'stretch' });
    expect(fillFromChoice('b', front!, { front: { color: '#fff' } }, std)).toEqual({ clip: 'b' });
  });
  it('a fit writes only on a row that shows a clip', () => {
    expect(withFit({ front: { clip: 'a' } }, front!, 'fit')).toEqual({ clip: 'a', fit: 'fit' });
    expect(withFit({ front: { color: '#fff' } }, front!, 'fit')).toBeUndefined();
    expect(rowFit({ front: { clip: 'a', fit: 'fill' } }, front!)).toBe('fill');
    expect(rowColor({ front: { color: '#fff' } }, front!)).toBe('#fff');
  });
  it('goes through withFace to what the store gets', () => {
    const top = sideRows('box')[5]!;
    let faces = withFace(undefined, 'all', fillFromChoice(COLOR, all!, undefined, std));
    faces = withFace(faces, 'top', fillFromChoice(OWN, top, faces, std));
    expect(faces).toEqual({ all: { color: '#ffffff' }, top: null });
    // all emptied: the null that said own picture here goes with it, nothing is left, the store gets null
    faces = withFace(faces, 'all', fillFromChoice(OWN, all!, faces, std));
    expect(faces).toBeUndefined();
    expect(facesPatch(faces)).toBeNull();
  });
  it('the one side of a sphere is stored under all', () => {
    const [surface] = sideRows('sphere');
    expect(withFace(undefined, surface!.name, fillFromChoice('a', surface!, undefined, std))).toEqual({ all: { clip: 'a' } });
  });
});

describe('the clips a side can show', () => {
  it('picture clips except the solid itself', () => {
    const { p, solid, other, pic, txt } = scene();
    const ids = faceClipOptions(p, solid.id).map((o) => o.id);
    expect(ids.sort()).toEqual([other.id, pic.id, txt.id].sort());
  });
  it('a gone clip is not an option, the row still reads its id (missing clip) and can be changed', () => {
    const { p, solid } = scene();
    const [, front] = sideRows('box');
    const faces = { front: { clip: 'gone' } };
    expect(faceClipOptions(p, solid.id).some((o) => o.id === 'gone')).toBe(false);
    expect(choiceOf(faces, front!)).toBe('gone');
    expect(withFace(faces, 'front', fillFromChoice(OWN, front!, faces, std))).toBeUndefined();
  });
});

describe('take off', () => {
  it('removes the clip from every solid that shows it', () => {
    const { p, solid, other, pic, txt } = scene();
    solid.faces = { front: { clip: pic.id }, top: { clip: txt.id } };
    other.faces = { all: { clip: pic.id, fit: 'stretch' }, side: { color: '#fff' } };
    expect(solidsShowing(p, pic.id).map((s) => s.id)).toEqual([solid.id, other.id]);
    expect(takeOffPatches(p, pic.id)).toEqual([
      { id: solid.id, faces: { top: { clip: txt.id } } },
      { id: other.id, faces: { side: { color: '#fff' } } },
    ]);
  });
  it('nothing left is null, and a clip on no side has no patches', () => {
    const { p, solid, pic, txt } = scene();
    solid.faces = { all: { clip: pic.id }, top: null };
    expect(takeOffPatches(p, pic.id)).toEqual([{ id: solid.id, faces: null }]);
    expect(takeOffPatches(p, txt.id)).toEqual([]);
    expect(solidsShowing(p, txt.id)).toEqual([]);
  });
});
