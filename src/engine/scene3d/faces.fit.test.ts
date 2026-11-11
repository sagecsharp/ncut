import { describe, expect, it } from 'vitest';
import { SHAPES_3D } from '../../types';
import { createProject, createShapeClip } from '../../lib/factory';
import { faceArea, faceNames, faceSourceSet, faceWindow, fitWindow } from './faces';

describe('fitWindow', () => {
  it('stretch is the whole picture', () => {
    expect(fitWindow(1600, 900, 100, 100, 'stretch')).toEqual([0, 0, 1, 1]);
  });
  it('fill: a wide picture on a square side loses the same share left and right', () => {
    const w = fitWindow(200, 100, 100, 100, 'fill');
    expect(w[0]).toBeCloseTo(0.25, 6);
    expect(w[2]).toBeCloseTo(0.5, 6);
    expect(w[1]).toBe(0);
    expect(w[3]).toBe(1);
  });
  it('fill: a tall picture on a square side loses top and bottom', () => {
    const w = fitWindow(100, 400, 100, 100, 'fill');
    expect(w[0]).toBe(0);
    expect(w[2]).toBe(1);
    expect(w[1]).toBeCloseTo(0.375, 6);
    expect(w[3]).toBeCloseTo(0.25, 6);
  });
  it('fit: a wide picture on a square side shows whole, the window reaches above and below', () => {
    const w = fitWindow(200, 100, 100, 100, 'fit');
    expect(w[0]).toBe(0);
    expect(w[2]).toBe(1);
    expect(w[3]).toBeCloseTo(2, 6);
    expect(w[1]).toBeCloseTo(-0.5, 6);
  });
  it('fit: a tall picture on a wide side reaches left and right', () => {
    const w = fitWindow(100, 200, 400, 100, 'fit');
    expect(w[1]).toBe(0);
    expect(w[3]).toBe(1);
    expect(w[2]).toBeCloseTo(8, 6);
    expect(w[0]).toBeCloseTo(-3.5, 6);
  });
  it('the same proportions: every fit is the whole picture', () => {
    for (const f of ['fill', 'fit', 'stretch'] as const) expect(fitWindow(320, 180, 64, 36, f)).toEqual([0, 0, 1, 1]);
  });
  it('sizes that are not positive give the whole picture', () => {
    expect(fitWindow(0, 100, 100, 100, 'fit')).toEqual([0, 0, 1, 1]);
    expect(fitWindow(100, 100, 100, NaN, 'fill')).toEqual([0, 0, 1, 1]);
  });
});

describe('faceWindow', () => {
  it('without a crop, fill needs no clip and fit gets the whole texture as its clip', () => {
    expect(faceWindow(undefined, 200, 100, 100, 100, 'fill').clip).toBeUndefined();
    const f = faceWindow(undefined, 200, 100, 100, 100, 'fit');
    expect(f.clip).toEqual([0, 0, 1, 1]);
    expect(f.uv[3]).toBeCloseTo(2, 6);
  });
  it('a crop moves the window into the texture, and fit clips to the crop', () => {
    // the kept part is 0.5 x 1 of a 200 x 100 picture: 100 x 100, a square, so on a square side nothing is cut or reaches out
    const sq = faceWindow([0.25, 0, 0.5, 1], 200, 100, 50, 50, 'fit');
    expect(sq.uv).toEqual([0.25, 0, 0.5, 1]);
    expect(sq.clip).toBeUndefined();
    // on a wide side the kept square fits with room left and right
    const wide = faceWindow([0.25, 0, 0.5, 1], 200, 100, 200, 100, 'fit');
    expect(wide.clip).toEqual([0.25, 0, 0.5, 1]);
    expect(wide.uv[2]).toBeCloseTo(1, 6);
    expect(wide.uv[0]).toBeCloseTo(0, 6);
    // fill on the same side cuts the crop at the center
    const fill = faceWindow([0.25, 0, 0.5, 1], 200, 100, 200, 100, 'fill');
    expect(fill.clip).toBeUndefined();
    expect(fill.uv[0]).toBeCloseTo(0.25, 6);
    expect(fill.uv[2]).toBeCloseTo(0.5, 6);
    expect(fill.uv[3]).toBeCloseTo(0.5, 6);
    expect(fill.uv[1]).toBeCloseTo(0.25, 6);
  });
});

describe('faceArea', () => {
  it('a box: front and back are w x h, right and left d x h, top and bottom w x d', () => {
    expect(faceArea('box', 'front', 300, 200, 100)).toEqual([300, 200]);
    expect(faceArea('box', 'back', 300, 200, 100)).toEqual([300, 200]);
    expect(faceArea('box', 'right', 300, 200, 100)).toEqual([100, 200]);
    expect(faceArea('box', 'left', 300, 200, 100)).toEqual([100, 200]);
    expect(faceArea('box', 'top', 300, 200, 100)).toEqual([300, 100]);
    expect(faceArea('box', 'bottom', 300, 200, 100)).toEqual([300, 100]);
  });
  it('a cylinder: the side is the length round x h, the caps w x d', () => {
    const [cw, ch] = faceArea('cylinder', 'side', 100, 50, 100);
    expect(cw).toBeCloseTo(Math.PI * 100, 3);
    expect(ch).toBe(50);
    expect(faceArea('cylinder', 'top', 100, 50, 80)).toEqual([100, 80]);
    expect(faceArea('cylinder', 'bottom', 100, 50, 80)).toEqual([100, 80]);
  });
  it('a cone side is as wide as the base is round and as high as the slope is long', () => {
    const [w, h] = faceArea('cone', 'side', 100, 120, 100);
    expect(w).toBeCloseTo(Math.PI * 100, 3);
    expect(h).toBeCloseTo(Math.hypot(120, 50), 6);
  });
  it('a pyramid slope shows the whole picture: base edge x slope length', () => {
    const [fw, fh] = faceArea('pyramid', 'front', 100, 80, 60);
    expect(fw).toBe(100);
    expect(fh).toBeCloseTo(Math.hypot(80, 30), 6);
    const [rw, rh] = faceArea('pyramid', 'right', 100, 80, 60);
    expect(rw).toBe(60);
    expect(rh).toBeCloseTo(Math.hypot(80, 50), 6);
    expect(faceArea('pyramid', 'bottom', 100, 80, 60)).toEqual([100, 60]);
  });
  it('outline shapes use the bounding box, a plane too', () => {
    for (const s of ['prism', 'hexagon', 'star', 'heart', 'plane'] as const) {
      for (const n of [...faceNames(s), 'x']) expect(faceArea(s, n, 120, 80, 40)).toEqual([120, 80]);
    }
  });
  it('every side of every shape gets a finite positive area', () => {
    for (const s of SHAPES_3D) {
      for (const n of faceNames(s)) {
        const [w, h] = faceArea(s, n, 300, 200, 150);
        expect(w).toBeGreaterThan(0);
        expect(h).toBeGreaterThan(0);
        expect(Number.isFinite(w + h)).toBe(true);
      }
    }
  });
  it('round shapes: the picture is longer round than a flat w', () => {
    expect(faceArea('sphere', 'surface', 100, 100, 100)[0]).toBeCloseTo(Math.PI * 100, 3);
    expect(faceArea('sphere', 'surface', 100, 100, 100)[1]).toBeCloseTo(Math.PI * 50, 3);
    expect(faceArea('capsule', 'surface', 100, 200, 100)[0]).toBeCloseTo(Math.PI * 100, 3);
  });
});

describe('faceSourceSet', () => {
  it('is the faceSourceIds of the project, kept per project object', () => {
    const p = createProject();
    const t = p.tracks.find((x) => x.kind === 'video')!;
    const pic = createShapeClip(t.id, 0, {});
    const solid = createShapeClip(t.id, 0, { threeD: true, shape: 'box', faces: { front: { clip: pic.id } } });
    p.clips.push(solid, pic);
    const a = faceSourceSet(p);
    expect([...a.keys()]).toEqual([pic.id]);
    expect(faceSourceSet(p)).toBe(a);
  });
  it('a project edited in place is not served a stale answer', () => {
    const p = createProject();
    const t = p.tracks.find((x) => x.kind === 'video')!;
    const pic = createShapeClip(t.id, 0, {});
    p.clips.push(pic);
    expect(faceSourceSet(p).size).toBe(0);
    p.clips.push(createShapeClip(t.id, 0, { threeD: true, shape: 'box', faces: { all: { clip: pic.id } } }));
    expect(faceSourceSet(p).has(pic.id)).toBe(true);
    // a hidden track takes the clip off
    p.tracks = p.tracks.map((x) => (x.id === t.id ? { ...x, hidden: true } : x));
    expect(faceSourceSet(p).size).toBe(0);
  });
  it('no clip with faces: the same empty answer every time', () => {
    const p = createProject();
    expect(faceSourceSet(p).size).toBe(0);
    expect(faceSourceSet(createProject())).toBe(faceSourceSet(p));
  });
});
