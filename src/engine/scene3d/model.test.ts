import { describe, expect, it } from 'vitest';
import type { Transform } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import type { ClipBox } from '../draw';
import { clipModelMatrix, planeCorners } from './model';
import { cross, dot, length, mul, normalize, rotationZ, scaling, sub, translation, type Mat4, type Vec3 } from './math';

const box = (o: Partial<ClipBox> = {}): ClipBox => ({ cx: 500, cy: 300, width: 400, height: 200, rotation: 0, ...o });
const tf = (o: Partial<Transform> = {}): Transform => ({ ...DEFAULT_TRANSFORM, ...o });
const EYE: Vec3 = [960, 540, -1000];
const corners = (b: ClipBox, t: Transform, look?: 'none' | 'camera' | 'cameraY', eye: Vec3 = EYE) =>
  planeCorners(clipModelMatrix(b, t, look, eye));
function near(a: Vec3, b: Vec3, digits = 3) {
  for (let i = 0; i < 3; i++) expect(a[i]).toBeCloseTo(b[i]!, digits);
}
/** local z axis (plane normal) of a model matrix, unit length */
const normalOf = (m: Mat4): Vec3 => normalize([m[8]!, m[9]!, m[10]!]);

describe('flat plane (no 3d rotation)', () => {
  it('corners are the 2d box corners at z = 0', () => {
    const c = corners(box(), tf());
    near(c[0], [300, 200, 0]);
    near(c[1], [700, 200, 0]);
    near(c[2], [700, 400, 0]);
    near(c[3], [300, 400, 0]);
  });
  it('transform.z moves the plane in depth', () => {
    for (const z of [-200, 150, 1000]) {
      const c = corners(box(), tf({ z }));
      for (const p of c) expect(p[2]).toBeCloseTo(z, 3);
      near(c[0], [300, 200, z]);
    }
  });
  it('missing z / rotX / rotY count as 0', () => {
    const c = corners(box(), tf());
    for (const p of c) expect(p[2]).toBeCloseTo(0, 6);
  });
  it('size follows width and height', () => {
    const c = corners(box({ width: 100, height: 50, cx: 0, cy: 0 }), tf());
    near(c[0], [-50, -25, 0]);
    near(c[2], [50, 25, 0]);
  });
  it('does not depend on the eye without lookAt', () => {
    const a = corners(box(), tf(), 'none', [0, 0, -5]);
    const b = corners(box(), tf(), undefined, [9999, -9999, 123]);
    for (let i = 0; i < 4; i++) near(a[i]!, b[i]!, 6);
  });
  it('model matrix of a box sends the unit quad center to the box center', () => {
    const m = clipModelMatrix(box(), tf({ z: 40 }), undefined, EYE);
    expect([m[12], m[13], m[14]]).toEqual([500, 300, 40]);
  });
  it('the plane normal points away from the viewer (+z)', () => {
    const m = clipModelMatrix(box(), tf(), undefined, EYE);
    near(normalOf(m), [0, 0, 1], 6);
  });
});

describe('in-plane rotation (box.rotation)', () => {
  it('90 degrees is clockwise on screen, like 2d', () => {
    // tl of a 400x200 box (offset -200,-100) rotates clockwise to (+100,-200)
    const c = corners(box({ rotation: 90 }), tf());
    near(c[0], [600, 100, 0]);
    near(c[1], [600, 500, 0]);
    near(c[2], [400, 500, 0]);
    near(c[3], [400, 100, 0]);
  });
  it('180 degrees swaps opposite corners', () => {
    const c = corners(box({ rotation: 180 }), tf());
    near(c[0], [700, 400, 0]);
    near(c[2], [300, 200, 0]);
  });
  it('matches the 2d canvas rotation formula for any angle', () => {
    for (const deg of [10, 33, 90, 200, -45]) {
      const a = (deg * Math.PI) / 180;
      const c = corners(box({ rotation: deg }), tf());
      const local = [
        [-200, -100],
        [200, -100],
        [200, 100],
        [-200, 100],
      ];
      for (let i = 0; i < 4; i++) {
        const [lx, ly] = local[i]!;
        // canvas rotate(a): x' = x cos a - y sin a, y' = x sin a + y cos a (y down => clockwise)
        near(c[i]!, [500 + lx! * Math.cos(a) - ly! * Math.sin(a), 300 + lx! * Math.sin(a) + ly! * Math.cos(a), 0]);
      }
    }
  });
  it('the top edge of a clockwise rotated clip leans right', () => {
    const c = corners(box({ rotation: 20 }), tf());
    expect(c[1][1]).toBeGreaterThan(c[0][1]); // right end of the top edge is lower on screen
  });
  it('keeps the plane flat in depth', () => {
    for (const p of corners(box({ rotation: 70 }), tf({ z: 33 }))) expect(p[2]).toBeCloseTo(33, 4);
  });
});

describe('turn (rotY) and tilt (rotX)', () => {
  it('turn > 0 moves the right edge away (larger z) and the left edge closer', () => {
    const c = corners(box(), tf({ rotY: 30 }));
    expect(c[1][2]).toBeGreaterThan(0);
    expect(c[2][2]).toBeGreaterThan(0);
    expect(c[0][2]).toBeLessThan(0);
    expect(c[3][2]).toBeLessThan(0);
    // symmetric around the center
    expect(c[1][2]).toBeCloseTo(-c[0][2], 3);
  });
  it('turn amount: the right edge depth is (width / 2) sin(angle)', () => {
    const c = corners(box(), tf({ rotY: 30 }));
    expect(c[1][2]).toBeCloseTo(200 * Math.sin(Math.PI / 6), 3);
  });
  it('turn 90 stands the plane edge-on to the viewer', () => {
    const c = corners(box(), tf({ rotY: 90 }));
    expect(c[0][0]).toBeCloseTo(500, 3);
    expect(c[1][0]).toBeCloseTo(500, 3);
    expect(c[1][2]).toBeCloseTo(200, 3);
  });
  it('turn keeps the vertical size', () => {
    const c = corners(box(), tf({ rotY: 50 }));
    expect(c[3][1] - c[0][1]).toBeCloseTo(200, 3);
    expect(c[0][1]).toBeCloseTo(c[1][1], 4);
  });
  it('turn < 0 does the opposite', () => {
    const c = corners(box(), tf({ rotY: -30 }));
    expect(c[1][2]).toBeLessThan(0);
    expect(c[0][2]).toBeGreaterThan(0);
  });
  it('tilt > 0 moves the top edge away (larger z) and the bottom edge closer', () => {
    const c = corners(box(), tf({ rotX: 30 }));
    expect(c[0][2]).toBeGreaterThan(0);
    expect(c[1][2]).toBeGreaterThan(0);
    expect(c[2][2]).toBeLessThan(0);
    expect(c[3][2]).toBeLessThan(0);
    expect(c[0][2]).toBeCloseTo(100 * Math.sin(Math.PI / 6), 3);
  });
  it('tilt < 0 does the opposite', () => {
    const c = corners(box(), tf({ rotX: -30 }));
    expect(c[0][2]).toBeLessThan(0);
    expect(c[2][2]).toBeGreaterThan(0);
  });
  it('tilt keeps the horizontal size', () => {
    const c = corners(box(), tf({ rotX: 40 }));
    expect(c[1][0] - c[0][0]).toBeCloseTo(400, 3);
  });
  it('turn and tilt rotate around the plane center at the clip z', () => {
    const c = corners(box(), tf({ rotY: 25, rotX: 15, z: 120 }));
    const mid: Vec3 = [
      (c[0][0] + c[2][0]) / 2,
      (c[0][1] + c[2][1]) / 2,
      (c[0][2] + c[2][2]) / 2,
    ];
    near(mid, [500, 300, 120]);
  });
  it('rotation keeps the size of the plane', () => {
    const c = corners(box(), tf({ rotY: 25, rotX: 15, z: 120 }));
    expect(length(sub(c[1], c[0]))).toBeCloseTo(400, 2);
    expect(length(sub(c[3], c[0]))).toBeCloseTo(200, 2);
    expect(dot(sub(c[1], c[0]), sub(c[3], c[0]))).toBeCloseTo(0, 1);
  });
  it('turn is applied after the spin: an upright (spun 90) plane turned 90 is edge-on', () => {
    // spin 90 makes the 400x200 plane 200 wide and 400 tall. turn 90 then swings its width into depth.
    const c = corners(box({ rotation: 90 }), tf({ rotY: 90 }));
    const xs = c.map((p) => p[0]);
    const zs = c.map((p) => p[2]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(0, 2);
    expect(Math.max(...zs) - Math.min(...zs)).toBeCloseTo(200, 2);
  });
  it('normal of a turned plane leans toward x', () => {
    const n = normalOf(clipModelMatrix(box(), tf({ rotY: 30 }), undefined, EYE));
    // the right edge moves away, so the front of the plane faces right-ish (normal gets a -x part)
    expect(Math.abs(n[0])).toBeGreaterThan(0.4);
    expect(n[1]).toBeCloseTo(0, 6);
  });
});

describe('lookAt', () => {
  const b = box({ cx: 700, cy: 100, width: 300, height: 150 });
  const center: Vec3 = [700, 100, 0];
  it("'camera': the plane normal points from the eye to the center", () => {
    for (const eye of [EYE, [0, 0, -800] as Vec3, [1500, 900, -300] as Vec3, [-400, 1200, -2000] as Vec3]) {
      const m = clipModelMatrix(b, tf(), 'camera', eye);
      const want = normalize(sub(center, eye));
      near(normalOf(m), want, 5);
    }
  });
  it("'camera': the plane is a rigid rotation (size is kept, axes orthogonal)", () => {
    const c = corners(b, tf(), 'camera');
    expect(length(sub(c[1], c[0]))).toBeCloseTo(300, 2);
    expect(length(sub(c[3], c[0]))).toBeCloseTo(150, 2);
    expect(dot(sub(c[1], c[0]), sub(c[3], c[0]))).toBeCloseTo(0, 1);
  });
  it("'camera': the center stays put", () => {
    const c = corners(b, tf({ z: 50 }), 'camera');
    near([(c[0][0] + c[2][0]) / 2, (c[0][1] + c[2][1]) / 2, (c[0][2] + c[2][2]) / 2], [700, 100, 50], 3);
  });
  it("'camera': the plane faces the eye (all corners at the same distance along the view line)", () => {
    const eye = EYE;
    const c = corners(b, tf(), 'camera', eye);
    const f = normalize(sub(center, eye));
    const d0 = dot(sub(c[0], center), f);
    for (const p of c) expect(dot(sub(p, center), f)).toBeCloseTo(d0, 3);
    expect(d0).toBeCloseTo(0, 3);
  });
  it("'camera': local right stays horizontal (no roll)", () => {
    const c = corners(b, tf(), 'camera', [100, 900, -400]);
    expect(c[1][1]).toBeCloseTo(c[0][1], 3);
  });
  it("'camera' with the eye exactly in front changes nothing", () => {
    const eye: Vec3 = [700, 100, -1000];
    const a = corners(b, tf(), 'camera', eye);
    const flat = corners(b, tf(), 'none', eye);
    for (let i = 0; i < 4; i++) near(a[i]!, flat[i]!, 5);
  });
  it("'cameraY' with the eye exactly in front changes nothing", () => {
    const eye: Vec3 = [700, 100, -1000];
    const a = corners(b, tf(), 'cameraY', eye);
    const flat = corners(b, tf(), 'none', eye);
    for (let i = 0; i < 4; i++) near(a[i]!, flat[i]!, 5);
  });
  it("'cameraY' keeps the vertical edges vertical, whatever the eye height", () => {
    for (const eye of [EYE, [0, -900, -500] as Vec3, [1800, 1500, -200] as Vec3]) {
      const c = corners(b, tf(), 'cameraY', eye);
      expect(c[3][0]).toBeCloseTo(c[0][0], 3);
      expect(c[3][2]).toBeCloseTo(c[0][2], 3);
      expect(c[2][0]).toBeCloseTo(c[1][0], 3);
      expect(c[2][2]).toBeCloseTo(c[1][2], 3);
      expect(c[3][1] - c[0][1]).toBeCloseTo(150, 3);
    }
  });
  it("'cameraY' turns toward the eye horizontally only", () => {
    const eye: Vec3 = [2000, -800, -500];
    const n = normalOf(clipModelMatrix(b, tf(), 'cameraY', eye));
    expect(n[1]).toBeCloseTo(0, 6);
    const flat = normalize([center[0] - eye[0], 0, center[2] - eye[2]]);
    near(n, flat, 5);
  });
  it("'cameraY' differs from 'camera' when the eye is above or below", () => {
    const eye: Vec3 = [700, -900, -500];
    const a = normalOf(clipModelMatrix(b, tf(), 'camera', eye));
    const y = normalOf(clipModelMatrix(b, tf(), 'cameraY', eye));
    expect(Math.abs(a[1])).toBeGreaterThan(0.3);
    expect(y[1]).toBeCloseTo(0, 6);
  });
  it("'camera' follows z of the clip", () => {
    const eye: Vec3 = [0, 0, -1000];
    const m = clipModelMatrix(b, tf({ z: 500 }), 'camera', eye);
    near(normalOf(m), normalize(sub([700, 100, 500], eye)), 5);
  });
  it('turn and tilt apply on top of lookAt', () => {
    const eye: Vec3 = [700, 100, -1000];
    // eye straight in front: lookAt is the identity, so turn behaves like on a plain plane
    const withLook = corners(b, tf({ rotY: 30 }), 'camera', eye);
    const plain = corners(b, tf({ rotY: 30 }), 'none', eye);
    for (let i = 0; i < 4; i++) near(withLook[i]!, plain[i]!, 5);
    const withLookX = corners(b, tf({ rotX: 30 }), 'cameraY', eye);
    const plainX = corners(b, tf({ rotX: 30 }), 'none', eye);
    for (let i = 0; i < 4; i++) near(withLookX[i]!, plainX[i]!, 5);
  });
  it('an eye exactly at the plane center falls back to a flat plane (no NaN)', () => {
    const c = corners(b, tf(), 'camera', [700, 100, 0]);
    for (const p of c) for (const v of p) expect(Number.isFinite(v)).toBe(true);
    near(c[0], [550, 25, 0], 4);
  });
  it('an eye directly above the plane center still yields finite corners', () => {
    const c = corners(b, tf(), 'camera', [700, -500, 0]);
    for (const p of c) for (const v of p) expect(Number.isFinite(v)).toBe(true);
    expect(length(sub(c[1], c[0]))).toBeCloseTo(300, 2);
  });
  it('lookAt basis is right handed (x cross y = z)', () => {
    const m = clipModelMatrix(box({ width: 1, height: 1 }), tf(), 'camera', [0, 0, -500]);
    const x: Vec3 = [m[0]!, m[1]!, m[2]!];
    const y: Vec3 = [m[4]!, m[5]!, m[6]!];
    const z: Vec3 = [m[8]!, m[9]!, m[10]!];
    near(cross(x, y), z, 5);
  });
});

describe('planeCorners', () => {
  it('returns tl, tr, br, bl of the unit quad under the model matrix', () => {
    const c = planeCorners(clipModelMatrix(box(), tf(), undefined, EYE));
    expect(c).toHaveLength(4);
    expect(c[0][0]).toBeLessThan(c[1][0]);
    expect(c[0][1]).toBeLessThan(c[3][1]);
    expect(c[1][1]).toBeCloseTo(c[0][1], 4);
    expect(c[2][0]).toBeCloseTo(c[1][0], 4);
  });
});

describe('with a parent matrix', () => {
  it('x / y / z are offsets in the parent frame', () => {
    const parent = translation(500, 300, 20);
    const m = clipModelMatrix(box({ cx: 9999, cy: 9999 }), tf({ x: 10, y: -5, z: 3 }), undefined, EYE, parent);
    expect([m[12], m[13], m[14]]).toEqual([510, 295, 23]);
  });
  it('the parent rotation and scale come along', () => {
    const parent = mul(translation(100, 100, 0), mul(rotationZ(Math.PI / 2), scaling(2, 2, 2)));
    const c = planeCorners(clipModelMatrix(box({ width: 10, height: 10 }), tf({ x: 10 }), undefined, EYE, parent));
    // child center (10, 0) -> turned 90 deg clockwise and doubled: (100, 120). 10 wide -> 20
    near([(c[0][0] + c[2][0]) / 2, (c[0][1] + c[2][1]) / 2, 0], [100, 120, 0]);
    expect(length(sub(c[1], c[0]))).toBeCloseTo(20, 3);
  });
  it('lookAt keeps the parent scale but faces the eye', () => {
    const parent = mul(translation(960, 540, 400), scaling(3, 3, 3));
    const m = clipModelMatrix(box({ width: 10, height: 10 }), tf(), 'camera', EYE, parent);
    near(normalOf(m), normalize(sub([960, 540, 400], EYE)), 4);
    const c = planeCorners(m);
    expect(length(sub(c[1], c[0]))).toBeCloseTo(30, 3);
  });
  it('null parent is the plain path', () => {
    const a = clipModelMatrix(box(), tf({ z: 5 }), undefined, EYE, null);
    const b = clipModelMatrix(box(), tf({ z: 5 }), undefined, EYE);
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});

describe("lookAt 'clip' (a look point instead of the eye)", () => {
  const b = box({ cx: 700, cy: 100, width: 300, height: 150 });
  const center: Vec3 = [700, 100, 0];
  const model = (point: Vec3 | null | undefined, look: 'clip' | 'camera' | 'none' = 'clip', t: Transform = tf(), parent?: Mat4 | null) =>
    clipModelMatrix(b, t, look, EYE, parent, point);
  it('the front faces the point: the normal runs from the point through the plane', () => {
    for (const p of [[0, 0, -500], [1500, 900, -300], [200, -400, 900], [700, 100, 800]] as Vec3[]) {
      near(normalOf(model(p)), normalize(sub(center, p)), 5);
    }
  });
  it('it is the same turn as lookAt camera with the eye at that point', () => {
    for (const p of [[0, 0, -500], [1500, 900, -300]] as Vec3[]) {
      expect(Array.from(model(p))).toEqual(Array.from(clipModelMatrix(b, tf(), 'camera', p)));
    }
  });
  it('is a full facing, not upright only: a point above tilts the plane', () => {
    const n = normalOf(model([700, -900, -300]));
    expect(Math.abs(n[1]!)).toBeGreaterThan(0.5);
  });
  it('the eye is ignored', () => {
    const a = clipModelMatrix(b, tf(), 'clip', [0, 0, -1], null, [10, 20, -300]);
    const c = clipModelMatrix(b, tf(), 'clip', [999, 999, 999], null, [10, 20, -300]);
    expect(Array.from(a)).toEqual(Array.from(c));
  });
  it('the center stays put and size is kept', () => {
    const c = planeCorners(model([100, 700, -200], 'clip', tf({ z: 50 })));
    near([(c[0][0] + c[2][0]) / 2, (c[0][1] + c[2][1]) / 2, (c[0][2] + c[2][2]) / 2], [700, 100, 50], 3);
    expect(length(sub(c[1], c[0]))).toBeCloseTo(300, 2);
    expect(length(sub(c[3], c[0]))).toBeCloseTo(150, 2);
  });
  it('no point, null point, or the plane own center = no turn', () => {
    const plain = Array.from(clipModelMatrix(b, tf(), 'none', EYE));
    expect(Array.from(model(undefined))).toEqual(plain);
    expect(Array.from(model(null))).toEqual(plain);
    expect(Array.from(model(center))).toEqual(plain);
  });
  it('a point is only used by lookAt clip', () => {
    const plain = Array.from(clipModelMatrix(b, tf(), 'none', EYE));
    expect(Array.from(model([0, 0, -500], 'none'))).toEqual(plain);
    expect(Array.from(model([0, 0, -500], 'camera'))).toEqual(Array.from(clipModelMatrix(b, tf(), 'camera', EYE)));
  });
  it('turn / tilt are applied on top, like with the camera', () => {
    const p: Vec3 = [0, 0, -500];
    const a = normalOf(model(p, 'clip', tf({ rotY: 30 })));
    const base = normalOf(model(p));
    expect(dot(a, base)).toBeLessThan(0.9999);
  });
  it('with a parent: the parent rotation is replaced by the look, its scale kept', () => {
    const parent = mul(translation(960, 540, 400), scaling(3, 3, 3));
    const p: Vec3 = [0, 0, -500];
    const m = model(p, 'clip', tf(), parent);
    near(normalOf(m), normalize(sub([960, 540, 400], p)), 4);
    const c = planeCorners(clipModelMatrix(box({ width: 10, height: 10 }), tf(), 'clip', EYE, parent, p));
    expect(length(sub(c[1], c[0]))).toBeCloseTo(30, 3);
  });
});
