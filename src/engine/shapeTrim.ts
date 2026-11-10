/**
 * draw on for shape outlines (types.ts ShapeClip.drawStart / drawEnd), as pure data.
 * an outline is flattened to a polyline with its length; trimPolyline cuts the part between two
 * shares of that length. no canvas, no dom: the recorder below stands in for a canvas context.
 */

export interface Polyline {
  /** x, y per point */
  pts: Float64Array;
  /** distance from the first point, per point (cum[0] = 0) */
  cum: Float64Array;
  length: number;
  /** the outline came back to its start point */
  closed: boolean;
}

/** the canvas calls a shape path uses; every one is recorded as points */
export interface PathRecorder {
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  bezierCurveTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number): void;
  arcTo(x1: number, y1: number, x2: number, y2: number, r: number): void;
  ellipse(x: number, y: number, rx: number, ry: number, rot: number, a0: number, a1: number): void;
  rect(x: number, y: number, w: number, h: number): void;
  closePath(): void;
}

const TAU = Math.PI * 2;
/** target distance between two samples on a curve (px of the box). fine enough to look smooth at 4k */
const STEP = 2;

function clampN(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** run `trace` against a recorder and return the flattened outline */
export function flatten(trace: (ctx: PathRecorder) => void): Polyline {
  const p: number[] = [];
  let sx = 0;
  let sy = 0;
  let cx = 0;
  let cy = 0;
  let closed = false;
  const push = (x: number, y: number): void => {
    const n = p.length;
    cx = x;
    cy = y;
    if (n >= 2 && Math.abs(x - p[n - 2]!) < 1e-9 && Math.abs(y - p[n - 1]!) < 1e-9) return;
    p.push(x, y);
  };
  const rec: PathRecorder = {
    beginPath() {
      p.length = 0;
      closed = false;
    },
    moveTo(x, y) {
      // only the first sub path is followed (shape paths have one)
      if (p.length > 0) return;
      push(x, y);
      sx = x;
      sy = y;
    },
    lineTo(x, y) {
      if (p.length === 0) {
        rec.moveTo(x, y);
        return;
      }
      push(x, y);
    },
    bezierCurveTo(x1, y1, x2, y2, x, y) {
      if (p.length === 0) rec.moveTo(x1, y1);
      const x0 = cx;
      const y0 = cy;
      const approx = Math.hypot(x1 - x0, y1 - y0) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(x - x2, y - y2);
      const steps = clampN(Math.ceil(approx / STEP), 12, 400);
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const s = 1 - t;
        push(
          s * s * s * x0 + 3 * s * s * t * x1 + 3 * s * t * t * x2 + t * t * t * x,
          s * s * s * y0 + 3 * s * s * t * y1 + 3 * s * t * t * y2 + t * t * t * y,
        );
      }
    },
    arcTo(x1, y1, x2, y2, r) {
      if (p.length === 0) rec.moveTo(x1, y1);
      const ax = cx - x1;
      const ay = cy - y1;
      const bx = x2 - x1;
      const by = y2 - y1;
      const la = Math.hypot(ax, ay);
      const lb = Math.hypot(bx, by);
      if (!(r > 0) || la < 1e-9 || lb < 1e-9 || Math.abs(ax * by - ay * bx) < 1e-9) {
        push(x1, y1);
        return;
      }
      const ux = ax / la;
      const uy = ay / la;
      const vx = bx / lb;
      const vy = by / lb;
      const half = Math.acos(clampN(ux * vx + uy * vy, -1, 1)) / 2;
      const dist = r / Math.tan(half);
      const t0x = x1 + ux * dist;
      const t0y = y1 + uy * dist;
      const t1x = x1 + vx * dist;
      const t1y = y1 + vy * dist;
      // the circle's center sits on the bisector of the corner
      let mx = ux + vx;
      let my = uy + vy;
      const ml = Math.hypot(mx, my);
      mx /= ml;
      my /= ml;
      const cd = r / Math.sin(half);
      const ox = x1 + mx * cd;
      const oy = y1 + my * cd;
      push(t0x, t0y);
      const a0 = Math.atan2(t0y - oy, t0x - ox);
      let d = Math.atan2(t1y - oy, t1x - ox) - a0;
      // the short way round
      while (d > Math.PI) d -= TAU;
      while (d < -Math.PI) d += TAU;
      const steps = clampN(Math.ceil((Math.abs(d) * r) / STEP), 6, 120);
      for (let i = 1; i <= steps; i++) {
        const a = a0 + (d * i) / steps;
        push(ox + Math.cos(a) * r, oy + Math.sin(a) * r);
      }
    },
    ellipse(x, y, rx, ry, rot, a0, a1) {
      const sweep = a1 - a0;
      const approx = Math.abs(sweep) * Math.max(Math.abs(rx), Math.abs(ry));
      const steps = clampN(Math.ceil(approx / STEP), 48, 1600);
      const cr = Math.cos(rot);
      const sr = Math.sin(rot);
      for (let i = 0; i <= steps; i++) {
        const a = a0 + (sweep * i) / steps;
        const ex = Math.cos(a) * rx;
        const ey = Math.sin(a) * ry;
        const px = x + ex * cr - ey * sr;
        const py = y + ex * sr + ey * cr;
        if (i === 0 && p.length === 0) rec.moveTo(px, py);
        else push(px, py);
      }
    },
    rect(x, y, w, h) {
      rec.moveTo(x, y);
      push(x + w, y);
      push(x + w, y + h);
      push(x, y + h);
      rec.closePath();
    },
    closePath() {
      if (p.length < 2) return;
      push(sx, sy);
      closed = true;
    },
  };
  trace(rec);
  return fromPoints(p, closed);
}

/** a polyline from x, y pairs */
export function fromPoints(xy: ArrayLike<number>, closed = false): Polyline {
  const n = Math.floor(xy.length / 2);
  const pts = new Float64Array(n * 2);
  const cum = new Float64Array(n);
  let len = 0;
  for (let i = 0; i < n; i++) {
    pts[i * 2] = xy[i * 2]!;
    pts[i * 2 + 1] = xy[i * 2 + 1]!;
    if (i > 0) len += Math.hypot(pts[i * 2]! - pts[i * 2 - 2]!, pts[i * 2 + 1]! - pts[i * 2 - 1]!);
    cum[i] = len;
  }
  return { pts, cum, length: len, closed };
}

/**
 * the visible share of an outline as [start, end] (0..1, clamped), or null when the whole outline is
 * drawn (both missing, or 0 and 1). the cheap check drawShape does first.
 */
export function drawRange(drawStart: number | undefined, drawEnd: number | undefined): [number, number] | null {
  const s = drawStart !== undefined && Number.isFinite(drawStart) ? clampN(drawStart, 0, 1) : 0;
  const e = drawEnd !== undefined && Number.isFinite(drawEnd) ? clampN(drawEnd, 0, 1) : 1;
  return s <= 0 && e >= 1 ? null : [s, e];
}

/**
 * the part of a polyline between two shares of its length, as x, y pairs. start >= end (after
 * clamping to 0..1) gives nothing. pass `out` to reuse an array (it is emptied first).
 */
export function trimPolyline(poly: Polyline, start: number, end: number, out: number[] = []): number[] {
  out.length = 0;
  const n = poly.cum.length;
  if (n < 2 || !(poly.length > 0)) return out;
  const a = clampN(Number.isFinite(start) ? start : 0, 0, 1) * poly.length;
  const b = clampN(Number.isFinite(end) ? end : 1, 0, 1) * poly.length;
  if (!(a < b)) return out;
  const { pts, cum } = poly;
  // first segment [lo, lo + 1] that holds a
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid]! <= a) lo = mid;
    else hi = mid;
  }
  const at = (i: number, d: number): void => {
    const span = cum[i + 1]! - cum[i]!;
    const t = span > 1e-12 ? (d - cum[i]!) / span : 0;
    out.push(pts[i * 2]! + (pts[i * 2 + 2]! - pts[i * 2]!) * t, pts[i * 2 + 1]! + (pts[i * 2 + 3]! - pts[i * 2 + 1]!) * t);
  };
  at(lo, a);
  let i = lo + 1;
  while (i < n - 1 && cum[i]! < b) {
    out.push(pts[i * 2]!, pts[i * 2 + 1]!);
    i++;
  }
  at(i - 1, b);
  return out;
}
