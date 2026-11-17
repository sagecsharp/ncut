/**
 * the graph's canvas drawing. pure: no react, no store, no view.ts. colors only through css(token), a token like '--graph-red'.
 * every x and y here is in css px from the plot's top left: x = (line.start + t) * zoom - scrollLeft, y = yOf(value * scale).
 * the hit index is filled in the same walk, so a press tests what is on screen.
 */
import { SPAN_EPS, isJoined, partHandles } from '../../lib/keyBezier';
import type { KeyRef } from '../../store/ui';
import type { Keyframe } from '../../types';
import type { GraphHitIndex, GraphLine, GraphViewport } from './graphModel';
import { lineValue, niceTicks, yOf } from './graphModel';
import type { GraphKind, Win } from './graphState';

export interface GraphFrame {
  lines: readonly GraphLine[];
  kind: GraphKind;
  windows: Record<string, Win>;
  vp: GraphViewport;
  dpr: number;
  /** a line id */
  active: string | null;
  hover: string | null;
  /** selKey(line id, index in line.keys) of the selected keys */
  sel: ReadonlySet<string>;
  /** the timeline in / out marks, timeline seconds */
  range: { in?: number; out?: number } | null;
  /** the y of the value a drag snapped to */
  snapY: number | null;
  box: { x0: number; x1: number; y0: number; y1: number } | null;
  handlesOff: boolean;
}

/** the id of one key in GraphFrame.sel */
export const selKey = (line: string, i: number): string => `${line}\u0000${i}`;

/** half the diagonal of a key diamond, px */
const KEY_R = 4;
const HANDLE_R = 3.5;
/** handles are drawn for this many keys at most */
const MAX_HANDLED = 200;
/** a line is sampled every this many px where no exact curve draws it */
const SAMPLE_PX = 2;
/** keys this far outside the plot are still drawn and hit */
const VIEW_PAD = 8;
const KEY_EPS = 1e-4;
/** a part ends a hair before its last key, so a speed jump is read from the part it belongs to */
const END_NUDGE = 1e-9;

function growKeys(h: GraphHitIndex): void {
  const n = Math.max(64, h.kx.length * 2);
  const kx = new Float32Array(n);
  const ky = new Float32Array(n);
  kx.set(h.kx);
  ky.set(h.ky);
  h.kx = kx;
  h.ky = ky;
}

function growHandles(h: GraphHitIndex): void {
  const n = Math.max(64, h.hx.length * 2);
  const hx = new Float32Array(n);
  const hy = new Float32Array(n);
  hx.set(h.hx);
  hy.set(h.hy);
  h.hx = hx;
  h.hy = hy;
}

function pushKey(h: GraphHitIndex, x: number, y: number, ref: KeyRef): void {
  if (h.kn >= h.kx.length) growKeys(h);
  h.kx[h.kn] = x;
  h.ky[h.kn] = y;
  h.kref[h.kn] = ref;
  h.kn++;
}

function pushHandle(h: GraphHitIndex, x: number, y: number, ref: KeyRef, side: 'in' | 'out'): void {
  if (h.hn >= h.hx.length) growHandles(h);
  h.hx[h.hn] = x;
  h.hy[h.hn] = y;
  h.href[h.hn] = { ref, side };
  h.hn++;
}

/** the first index whose key time is above t (binary search) */
function firstAfter(keys: readonly Keyframe[], t: number): number {
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (keys[mid]!.t <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** the control values of a custom part lie inside the range the line is clamped to (no range: always) */
function inRange(line: GraphLine, a: Keyframe, b: Keyframe, y1: number, y2: number): boolean {
  const r = line.range;
  if (!r) return true;
  const lo = Math.min(r.lo, a.v, b.v);
  const hi = Math.max(r.hi, a.v, b.v);
  return y1 >= lo && y1 <= hi && y2 >= lo && y2 <= hi;
}

/** puts the line on the path. returns the parts walked: a part is the stretch between two keys that touches the plot */
function trace(ctx: CanvasRenderingContext2D, line: GraphLine, kind: GraphKind, win: Win, vp: GraphViewport): number {
  const keys = line.keys;
  const n = keys.length;
  if (n === 0) return 0;
  const sc = line.feel.scale;
  const H = vp.height;
  const X = (t: number): number => (line.start + t) * vp.zoom - vp.scrollLeft;
  const tS = Math.max(0, (-2 + vp.scrollLeft) / vp.zoom - line.start);
  const tE = Math.min(line.duration, (vp.width + 2 + vp.scrollLeft) / vp.zoom - line.start);
  if (!(tE > tS)) return 0;
  const yv = (v: number): number => yOf(v * sc, win, H);
  const at = (t: number): number => yv(lineValue(line, kind, t));
  const kv = (k: Keyframe): number => (line.int ? Math.round(k.v) : k.v);
  const dt = SAMPLE_PX / vp.zoom;
  let started = false;
  const point = (t: number, y: number): void => {
    const x = X(t);
    if (started) ctx.lineTo(x, y);
    else {
      ctx.moveTo(x, y);
      started = true;
    }
  };
  /** every 2 px of lineValue from ta to tb */
  const sampled = (ta: number, tb: number): void => {
    for (let t = ta; t < tb; t += dt) point(t, at(t));
    point(tb, at(tb - END_NUDGE > ta ? tb - END_NUDGE : tb));
  };

  let parts = 0;
  const i0 = firstAfter(keys, tS) - 1;
  // before the first key the line is flat
  if (i0 < 0) {
    const te = Math.min(keys[0]!.t, tE);
    if (te > tS) {
      const y = at(tS);
      point(tS, y);
      point(te, y);
    }
  }
  for (let i = Math.max(i0, 0); i < n - 1; i++) {
    const a = keys[i]!;
    const b = keys[i + 1]!;
    if (a.t >= tE) break;
    parts++;
    const inside = a.t >= -KEY_EPS && b.t <= line.duration + KEY_EPS;
    const ta = Math.max(a.t, tS);
    const tb = Math.min(b.t, tE);
    const span = b.t - a.t;
    if (kind === 'value' && inside) {
      if (span < SPAN_EPS) {
        point(a.t, yv(kv(a)));
        point(b.t, yv(kv(b)));
        continue;
      }
      if (a.ease === 'hold') {
        point(a.t, yv(kv(a)));
        point(b.t, yv(kv(a)));
        point(b.t, yv(kv(b)));
        continue;
      }
      const ph = line.int ? null : partHandles(a, b);
      if (ph) {
        const y1 = a.v + ph.out.speed * ph.out.influence * span;
        const y2 = b.v - ph.in.speed * ph.in.influence * span;
        if (a.ease !== 'bezier' || inRange(line, a, b, y1, y2)) {
          if (!started) {
            ctx.moveTo(X(a.t), yv(a.v));
            started = true;
          }
          ctx.bezierCurveTo(X(a.t + ph.out.influence * span), yv(y1), X(b.t - ph.in.influence * span), yv(y2), X(b.t), yv(b.v));
          continue;
        }
      }
    }
    if (tb > ta) sampled(ta, tb);
  }
  // after the last key the line is flat again
  const last = keys[n - 1]!;
  if (last.t < tE) {
    const t0 = Math.max(last.t, tS);
    const y = at(Math.max(t0, last.t + 1e-6));
    point(t0, y);
    point(tE, y);
  }
  return parts;
}

/** the keys of one line, then their handles. fills the hit index */
function drawKeys(ctx: CanvasRenderingContext2D, line: GraphLine, f: GraphFrame, win: Win, css: (token: string) => string, hits: GraphHitIndex): void {
  const { vp } = f;
  const keys = line.keys;
  const n = keys.length;
  const sc = line.feel.scale;
  const H = vp.height;
  const X = (t: number): number => (line.start + t) * vp.zoom - vp.scrollLeft;
  const yv = (v: number): number => yOf(v * sc, win, H);
  const tMin = (-VIEW_PAD + vp.scrollLeft) / vp.zoom - line.start;
  let i = Math.max(0, firstAfter(keys, tMin) - 1);
  const picked: { i: number; x: number; y: number; ref: KeyRef }[] = [];
  const color = css(line.color);
  ctx.fillStyle = color;
  ctx.beginPath();
  for (; i < n; i++) {
    const k = keys[i]!;
    const x = X(k.t);
    if (x > vp.width + VIEW_PAD) break;
    if (x < -VIEW_PAD || k.t < -KEY_EPS || k.t > line.duration + KEY_EPS) continue;
    const y = yv(f.kind === 'speed' ? lineValue(line, 'speed', k.t) : line.int ? Math.round(k.v) : k.v);
    const ref: KeyRef = { clipId: line.clipId, prop: line.prop, t: k.t };
    pushKey(hits, x, y, ref);
    if (f.sel.has(selKey(line.id, i))) {
      picked.push({ i, x, y, ref });
      continue;
    }
    ctx.moveTo(x, y - KEY_R);
    ctx.lineTo(x + KEY_R, y);
    ctx.lineTo(x, y + KEY_R);
    ctx.lineTo(x - KEY_R, y);
    ctx.closePath();
  }
  ctx.fill();
  if (picked.length === 0) return;

  // selected keys: light diamonds with the line's color around them
  ctx.fillStyle = css('--text');
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.25;
  ctx.beginPath();
  for (const p of picked) {
    ctx.moveTo(p.x, p.y - KEY_R);
    ctx.lineTo(p.x + KEY_R, p.y);
    ctx.lineTo(p.x, p.y + KEY_R);
    ctx.lineTo(p.x - KEY_R, p.y);
    ctx.closePath();
  }
  ctx.fill();
  ctx.stroke();
  if (f.handlesOff) return;

  // handles: a 1 px line to a dot, round when the key is joined, square when its two sides are free
  const bars: number[] = [];
  const rounds: [number, number][] = [];
  const squares: [number, number][] = [];
  let handled = 0;
  for (const p of picked) {
    if (handled >= MAX_HANDLED) break;
    const k = keys[p.i]!;
    const joined = isJoined(keys, p.i);
    let any = false;
    for (const side of ['out', 'in'] as const) {
      const nb = side === 'out' ? keys[p.i + 1] : keys[p.i - 1];
      if (!nb) continue;
      const ph = side === 'out' ? partHandles(k, nb) : partHandles(nb, k);
      if (!ph) continue;
      const h = side === 'out' ? ph.out : ph.in;
      const span = Math.abs(nb.t - k.t);
      const dir = side === 'out' ? 1 : -1;
      const hx = X(k.t + dir * h.influence * span);
      let hy: number;
      if (f.kind === 'speed') {
        // a flat bar at the speed of that side
        hy = yv(h.speed);
        bars.push(p.x, hy, hx, hy);
      } else {
        hy = yv(k.v + dir * h.speed * h.influence * span);
        bars.push(p.x, p.y, hx, hy);
      }
      (joined ? rounds : squares).push([hx, hy]);
      pushHandle(hits, hx, hy, p.ref, side);
      any = true;
    }
    if (any) handled++;
  }
  if (handled === 0) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let q = 0; q < bars.length; q += 4) {
    ctx.moveTo(bars[q]!, bars[q + 1]!);
    ctx.lineTo(bars[q + 2]!, bars[q + 3]!);
  }
  ctx.stroke();
  ctx.fillStyle = css('--surface-0');
  ctx.strokeStyle = color;
  ctx.beginPath();
  for (const [x, y] of rounds) {
    ctx.moveTo(x + HANDLE_R, y);
    ctx.arc(x, y, HANDLE_R, 0, Math.PI * 2);
  }
  for (const [x, y] of squares) ctx.rect(x - HANDLE_R, y - HANDLE_R, HANDLE_R * 2, HANDLE_R * 2);
  ctx.fill();
  ctx.stroke();
}

/** one frame. fills `hits` as it goes (its arrays grow by doubling) and answers how many parts it walked */
export function drawGraph(ctx: CanvasRenderingContext2D, f: GraphFrame, css: (token: string) => string, hits: GraphHitIndex): { segments: number } {
  const { vp } = f;
  const W = vp.width;
  const H = vp.height;
  ctx.setTransform(f.dpr, 0, 0, f.dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  hits.kn = 0;
  hits.hn = 0;

  // the in / out band
  if (f.range) {
    const x0 = Math.max(0, f.range.in === undefined ? 0 : f.range.in * vp.zoom - vp.scrollLeft);
    const x1 = Math.min(W, f.range.out === undefined ? W : f.range.out * vp.zoom - vp.scrollLeft);
    if (x1 > x0) {
      ctx.globalAlpha = 0.08;
      ctx.fillStyle = css('--accent');
      ctx.fillRect(x0, 0, x1 - x0, H);
      ctx.globalAlpha = 1;
    }
  }

  const live = f.lines.filter((l) => f.windows[l.group] !== undefined);

  // the span of each clip
  const seen = new Set<string>();
  ctx.fillStyle = css('--surface-2');
  for (const l of live) {
    if (seen.has(l.clipId)) continue;
    seen.add(l.clipId);
    const x0 = Math.max(0, l.start * vp.zoom - vp.scrollLeft);
    const x1 = Math.min(W, (l.start + l.duration) * vp.zoom - vp.scrollLeft);
    if (x1 <= x0) continue;
    ctx.globalAlpha = 0.5;
    ctx.fillRect(x0, 0, x1 - x0, H);
  }
  ctx.globalAlpha = 1;

  // the grid of the active line's group
  const base = live.find((l) => l.id === f.active) ?? live[0];
  if (base) {
    const win = f.windows[base.group]!;
    ctx.strokeStyle = css('--border-soft');
    ctx.fillStyle = css('--text-faint');
    ctx.font = `10px ${css('--font')}`;
    ctx.lineWidth = 1;
    ctx.textBaseline = 'bottom';
    for (const tick of niceTicks(win, H)) {
      const y = Math.round(yOf(tick, win, H)) + 0.5;
      ctx.globalAlpha = tick === 0 ? 0.9 : 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillText(String(Math.round(tick * 1e6) / 1e6), 4, y - 1);
    }
  }

  // the lines: quiet ones first, the active and hovered ones over them
  let segments = 0;
  const strong = (l: GraphLine): boolean => l.id === f.active || l.id === f.hover;
  const ordered = [...live.filter((l) => !strong(l)), ...live.filter(strong)];
  ctx.lineJoin = 'round';
  for (const l of ordered) {
    const win = f.windows[l.group]!;
    const on = strong(l);
    ctx.strokeStyle = css(l.color);
    ctx.lineWidth = on ? 2 : 1.25;
    ctx.globalAlpha = on ? 1 : 0.7;
    ctx.setLineDash(l.dash as number[]);
    ctx.beginPath();
    segments += trace(ctx, l, f.kind, win, vp);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;

  // keys and handles
  for (const l of ordered) drawKeys(ctx, l, f, f.windows[l.group]!, css, hits);
  hits.kref.length = hits.kn;
  hits.href.length = hits.hn;

  if (f.snapY !== null) {
    ctx.strokeStyle = css('--snap-line');
    ctx.lineWidth = 1;
    const y = Math.round(f.snapY) + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }
  if (f.box) {
    const x = Math.min(f.box.x0, f.box.x1);
    const y = Math.min(f.box.y0, f.box.y1);
    const w = Math.abs(f.box.x1 - f.box.x0);
    const h = Math.abs(f.box.y1 - f.box.y0);
    ctx.globalAlpha = 0.1;
    ctx.fillStyle = css('--accent');
    ctx.fillRect(x, y, w, h);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = css('--accent');
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w, h);
  }
  return { segments };
}
