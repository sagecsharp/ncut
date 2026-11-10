/**
 * small 3d math for the scene renderer. matrices are column-major Float32Array(16), like webgl.
 *
 * world space (the same numbers the 2d editor uses, so 2d and 3d mix):
 *   x right, y DOWN, z AWAY from the viewer. units = project pixels.
 *   (0, 0, 0) is the top left corner of the canvas, z = 0 is the canvas plane.
 * positive rotations follow the right hand rule in that space:
 *   around z: clockwise on screen (same as the 2d rotation)
 *   around x: the bottom edge swings away from the viewer (the top comes toward it). model.ts negates the
 *             user facing tilt, so a positive tilt there leans the top edge away.
 *   around y: the left edge swings away from the viewer
 */
export type Mat4 = Float32Array;
export type Vec3 = [number, number, number];

export const DEG = Math.PI / 180;

export function identity(): Mat4 {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

/** a * b (b is applied to a point first) */
export function mul(a: Mat4, b: Mat4): Mat4 {
  const o = new Float32Array(16);
  mulInto(o, a, b);
  return o;
}

/**
 * mul that writes into `o` instead of allocating (for per-plane work in the render loop). `o` must not be `a` or `b`.
 * the numbers are exactly the ones mul gives: mul is this function on a fresh array.
 */
export function mulInto(o: Mat4, a: Mat4, b: Mat4): Mat4 {
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4]!;
    const b1 = b[c * 4 + 1]!;
    const b2 = b[c * 4 + 2]!;
    const b3 = b[c * 4 + 3]!;
    o[c * 4] = a[0]! * b0 + a[4]! * b1 + a[8]! * b2 + a[12]! * b3;
    o[c * 4 + 1] = a[1]! * b0 + a[5]! * b1 + a[9]! * b2 + a[13]! * b3;
    o[c * 4 + 2] = a[2]! * b0 + a[6]! * b1 + a[10]! * b2 + a[14]! * b3;
    o[c * 4 + 3] = a[3]! * b0 + a[7]! * b1 + a[11]! * b2 + a[15]! * b3;
  }
  return o;
}

export function translation(x: number, y: number, z: number): Mat4 {
  const m = identity();
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
}

export function scaling(x: number, y: number, z: number): Mat4 {
  const m = identity();
  m[0] = x;
  m[5] = y;
  m[10] = z;
  return m;
}

export function rotationX(rad: number): Mat4 {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const m = identity();
  m[5] = c;
  m[6] = s;
  m[9] = -s;
  m[10] = c;
  return m;
}

export function rotationY(rad: number): Mat4 {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const m = identity();
  m[0] = c;
  m[2] = -s;
  m[8] = s;
  m[10] = c;
  return m;
}

export function rotationZ(rad: number): Mat4 {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const m = identity();
  m[0] = c;
  m[1] = s;
  m[4] = -s;
  m[5] = c;
  return m;
}

/** rotation whose columns are the given axes (where local x, y, z point in world space) */
export function basis(x: Vec3, y: Vec3, z: Vec3): Mat4 {
  const m = identity();
  m[0] = x[0];
  m[1] = x[1];
  m[2] = x[2];
  m[4] = y[0];
  m[5] = y[1];
  m[6] = y[2];
  m[8] = z[0];
  m[9] = z[1];
  m[10] = z[2];
  return m;
}

/** transform a point, returns [x, y, z, w] (not divided by w) */
export function transformPoint(m: Mat4, x: number, y: number, z: number): [number, number, number, number] {
  return [
    m[0]! * x + m[4]! * y + m[8]! * z + m[12]!,
    m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
    m[2]! * x + m[6]! * y + m[10]! * z + m[14]!,
    m[3]! * x + m[7]! * y + m[11]! * z + m[15]!,
  ];
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
export function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}
export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
export function length(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}
export function normalize(a: Vec3): Vec3 {
  const l = length(a);
  return l > 1e-9 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
}

/** rotate v around a unit axis by rad (right hand rule) */
export function rotateAround(v: Vec3, axis: Vec3, rad: number): Vec3 {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const d = dot(axis, v);
  const x = cross(axis, v);
  return [
    v[0] * c + x[0] * s + axis[0] * d * (1 - c),
    v[1] * c + x[1] * s + axis[1] * d * (1 - c),
    v[2] * c + x[2] * s + axis[2] * d * (1 - c),
  ];
}
