/**
 * how the scene view is driven. two schemes, picked in the settings and kept per browser (localStorage):
 *
 * - 'blender' (the default): the middle button orbits (shift pans, ctrl zooms, alt + left does the same without
 *   a middle button), a left click selects and a left drag draws a selection box. g / r / s grab, rotate and
 *   scale the selection without holding a button: x y z pick the axis, a typed number sets the amount, a click
 *   or enter confirms, a right click or escape cancels. shift + d copies, x deletes, a selects everything,
 *   the numpad picks the view. the keys belong to the scene view while the pointer is over it.
 * - 'unity': a left drag orbits, w e r pick the gizmo tool, alt + drag an arrow leaves a copy.
 *
 * this file is the pure part (what a press or a key means, the view a numpad key gives, typed numbers, the
 * selection box) plus the tiny store. the gestures themselves live in SceneOverlay.
 */
import { create } from 'zustand';
import type { Vec3 } from '../../engine/scene3d/math';
import type { Orbit } from './sceneCamera';

export type SceneScheme = 'blender' | 'unity';
export const SCENE_SCHEME_DEFAULT: SceneScheme = 'blender';

const KEY = 'ncut.scene.controls';

/** what is stored, read defensively: only 'unity' turns the unity controls on */
export function parseScheme(raw: unknown): SceneScheme {
  return raw === 'unity' ? 'unity' : SCENE_SCHEME_DEFAULT;
}

function load(): SceneScheme {
  try {
    return parseScheme(typeof localStorage === 'undefined' ? null : localStorage.getItem(KEY));
  } catch {
    return SCENE_SCHEME_DEFAULT;
  }
}

interface SceneControlsState {
  scheme: SceneScheme;
  setScheme(scheme: SceneScheme): void;
}

export const useSceneControls = create<SceneControlsState>()((set, get) => ({
  scheme: load(),
  setScheme(scheme) {
    const next = parseScheme(scheme);
    if (next === get().scheme) return;
    set({ scheme: next });
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // storage is blocked: the choice still works until the page is closed
    }
  },
}));

/** the line of help at the bottom of the scene view */
export const SCENE_HINTS: Readonly<Record<SceneScheme, string>> = {
  blender:
    'middle drag or alt drag: orbit   shift: pan   wheel: zoom   g r s: move rotate scale   x y z: axis   click: keep   right click: cancel   shift d: copy   x: delete   numpad: views',
  unity: 'drag: orbit   shift drag: pan   wheel: zoom   w e r: tool   f: frame   ctrl: snap   x y z: lock axis   alt drag arrow: copy   esc: cancel',
};

/* ---------- pointer ---------- */

export type PressAction = 'orbit' | 'pan' | 'dolly' | 'primary' | 'confirm' | 'cancel' | 'none';

export interface PressInput {
  button: number;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
}

/**
 * what a press starts with the blender controls. `transforming`: a g / r / s transform is running, the buttons
 * only end it. 'primary' = the left button on its own: a gizmo handle, a click to select, or a selection box.
 */
export function blenderPress(e: PressInput, transforming: boolean): PressAction {
  if (transforming) return e.button === 0 ? 'confirm' : e.button === 2 ? 'cancel' : 'none';
  // alt + left stands in for the middle button (laptops, pens)
  if (e.button === 1 || (e.button === 0 && e.alt)) return e.ctrl ? 'dolly' : e.shift ? 'pan' : 'orbit';
  return e.button === 0 ? 'primary' : 'none';
}

export const MIN_ORBIT_DISTANCE = 20;

/** the orbit distance kept inside what the wheel allows: 20 px to 60 home distances */
export function clampOrbitDistance(distance: number, home: number): number {
  const d = Number.isFinite(distance) ? distance : home;
  return Math.min(Math.max(MIN_ORBIT_DISTANCE, home * 60), Math.max(MIN_ORBIT_DISTANCE, d));
}

/** ctrl + middle drag: up moves in, down moves out. `dy` in css px since the press. */
export function dollyDistance(d0: number, dy: number): number {
  return d0 * Math.exp(Math.max(-2000, Math.min(2000, dy)) * 0.005);
}

/* ---------- keys ---------- */

export type SceneCommand =
  | {
      kind:
        | 'grab'
        | 'rotate'
        | 'scale'
        | 'clear-move'
        | 'clear-rotate'
        | 'clear-scale'
        | 'duplicate'
        | 'delete'
        | 'select-all'
        | 'select-none'
        | 'frame'
        | 'frame-all'
        | 'camera-view'
        | 'camera-to-view';
    }
  | { kind: 'view'; code: string; ctrl: boolean };

export interface KeyInput {
  key: string;
  code: string;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  meta: boolean;
}

/** numpad keys that turn or move the view. the first three also take ctrl (the opposite side). */
const VIEW_SIDES = new Set(['Numpad1', 'Numpad3', 'Numpad7']);
const VIEW_STEPS = new Set(['Numpad9', 'Numpad4', 'Numpad6', 'Numpad8', 'Numpad2', 'NumpadAdd', 'NumpadSubtract']);

/**
 * the blender key a press is, while the pointer is over the scene view and nothing is being transformed.
 * null = not one of them: the key goes on to the editor's own shortcuts (ctrl + z, space, delete ...).
 */
export function blenderCommand(e: KeyInput): SceneCommand | null {
  if (e.meta) return null;
  // the numpad is read by position, so it also works with num lock off
  if (e.code === 'Numpad0') {
    if (e.ctrl && e.alt && !e.shift) return { kind: 'camera-to-view' };
    return !e.ctrl && !e.alt && !e.shift ? { kind: 'camera-view' } : null;
  }
  if (VIEW_SIDES.has(e.code)) return !e.alt && !e.shift ? { kind: 'view', code: e.code, ctrl: e.ctrl } : null;
  if (VIEW_STEPS.has(e.code)) return !e.alt && !e.shift && !e.ctrl ? { kind: 'view', code: e.code, ctrl: false } : null;
  if (e.code === 'NumpadDecimal') return !e.alt && !e.shift && !e.ctrl ? { kind: 'frame' } : null;
  if (e.ctrl) return null;
  if (e.key === 'Home') return !e.alt && !e.shift ? { kind: 'frame-all' } : null;
  if (e.key.length !== 1) return null;
  const k = e.key.toLowerCase();
  const plain = !e.alt && !e.shift;
  const altOnly = e.alt && !e.shift;
  switch (k) {
    case 'g':
      return plain ? { kind: 'grab' } : altOnly ? { kind: 'clear-move' } : null;
    case 'r':
      return plain ? { kind: 'rotate' } : altOnly ? { kind: 'clear-rotate' } : null;
    case 's':
      return plain ? { kind: 'scale' } : altOnly ? { kind: 'clear-scale' } : null;
    case 'd':
      return e.shift && !e.alt ? { kind: 'duplicate' } : null;
    case 'x':
      return plain ? { kind: 'delete' } : null;
    case 'a':
      return plain ? { kind: 'select-all' } : altOnly ? { kind: 'select-none' } : null;
    case 'f':
      return plain ? { kind: 'frame' } : null;
    default:
      return null;
  }
}

/** degrees one press of numpad 4 / 6 / 8 / 2 turns the view */
export const VIEW_STEP_DEG = 15;
const TOP_PITCH = 89;

function wrapDeg(a: number): number {
  const r = ((a % 360) + 360) % 360;
  return r > 180 ? r - 360 : r;
}

/**
 * the view a numpad key gives, from the current one. like blender the point the view turns around and the
 * distance stay, only the direction changes: 1 front, 3 right, 7 top (ctrl: back, left, bottom), 9 the opposite
 * side, 4 / 6 and 8 / 2 turn in steps, + and - move in and out. null = not a view key.
 * yaw + looks right and pitch + looks up (sceneCamera.Orbit), so the camera of the right view looks left.
 */
export function blenderView(code: string, ctrl: boolean, o: Orbit): Orbit | null {
  switch (code) {
    case 'Numpad1':
      return { ...o, yaw: ctrl ? 180 : 0, pitch: 0 };
    case 'Numpad3':
      return { ...o, yaw: ctrl ? 90 : -90, pitch: 0 };
    case 'Numpad7':
      return { ...o, yaw: 0, pitch: ctrl ? TOP_PITCH : -TOP_PITCH };
    case 'Numpad9':
      return { ...o, yaw: wrapDeg(o.yaw + 180), pitch: -o.pitch };
    case 'Numpad4':
      return { ...o, yaw: wrapDeg(o.yaw + VIEW_STEP_DEG) };
    case 'Numpad6':
      return { ...o, yaw: wrapDeg(o.yaw - VIEW_STEP_DEG) };
    case 'Numpad8':
      return { ...o, pitch: Math.max(-TOP_PITCH, o.pitch - VIEW_STEP_DEG) };
    case 'Numpad2':
      return { ...o, pitch: Math.min(TOP_PITCH, o.pitch + VIEW_STEP_DEG) };
    case 'NumpadAdd':
      return { ...o, distance: o.distance / 1.25 };
    case 'NumpadSubtract':
      return { ...o, distance: o.distance * 1.25 };
    default:
      return null;
  }
}

/* ---------- typed numbers ---------- */

/**
 * a key typed into the number of a running transform ("g x 1 0 0"): the new text, or null when the key is not
 * part of a number. minus flips the sign wherever it is typed, backspace takes the last character away.
 */
export function typeNumber(text: string, key: string): string | null {
  if (key === 'Backspace') return text.slice(0, -1);
  if (key === '-') return text.startsWith('-') ? text.slice(1) : `-${text}`;
  if (key === '.' || key === ',') return text.includes('.') ? text : `${text}.`;
  if (key.length === 1 && key >= '0' && key <= '9') return text.replace('-', '').replace('.', '').length >= 9 ? text : text + key;
  return null;
}

/** the number typed so far, null while there is no digit yet (the pointer still decides then) */
export function typedValue(text: string): number | null {
  if (!/[0-9]/.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/* ---------- selection box ---------- */

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** the box between two corners, any order */
export function rectOf(ax: number, ay: number, bx: number, by: number): Rect {
  return { x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx), y1: Math.max(ay, by) };
}

export function pointInRect(x: number, y: number, r: Rect): boolean {
  return x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;
}

function pointInPolygon(x: number, y: number, p: ArrayLike<number>): boolean {
  let inside = false;
  const n = p.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = p[i * 2]!;
    const yi = p[i * 2 + 1]!;
    const xj = p[j * 2]!;
    const yj = p[j * 2 + 1]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function segmentsCross(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): boolean {
  const side = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) => (qx - px) * (ry - py) - (qy - py) * (rx - px);
  const d1 = side(cx, cy, dx, dy, ax, ay);
  const d2 = side(cx, cy, dx, dy, bx, by);
  const d3 = side(ax, ay, bx, by, cx, cy);
  const d4 = side(ax, ay, bx, by, dx, dy);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/**
 * does a projected plane (four corners, x0 y0 x1 y1 ...) touch the selection box: a corner of one inside the
 * other, or two edges crossing. so a big plane with the box drawn in its middle counts, and so does a thin
 * plane seen edge on that the box cuts across.
 */
export function quadTouchesRect(p: ArrayLike<number>, r: Rect): boolean {
  if (p.length < 8) return false;
  for (let i = 0; i < 8; i++) if (!Number.isFinite(p[i]!)) return false;
  for (let i = 0; i < 4; i++) if (pointInRect(p[i * 2]!, p[i * 2 + 1]!, r)) return true;
  const corners = [r.x0, r.y0, r.x1, r.y0, r.x1, r.y1, r.x0, r.y1];
  for (let i = 0; i < 4; i++) if (pointInPolygon(corners[i * 2]!, corners[i * 2 + 1]!, p)) return true;
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    for (let k = 0; k < 4; k++) {
      const l = (k + 1) % 4;
      if (segmentsCross(p[i * 2]!, p[i * 2 + 1]!, p[j * 2]!, p[j * 2 + 1]!, corners[k * 2]!, corners[k * 2 + 1]!, corners[l * 2]!, corners[l * 2 + 1]!)) return true;
    }
  }
  return false;
}

/* ---------- frame everything ---------- */

/** one sphere around several: the middle of their centers, wide enough for the farthest one. null = none given. */
export function boundingSphere(items: readonly { center: Vec3; radius: number }[]): { center: Vec3; radius: number } | null {
  if (items.length === 0) return null;
  const c: Vec3 = [0, 0, 0];
  for (const it of items) for (let i = 0; i < 3; i++) c[i] = c[i]! + it.center[i]! / items.length;
  let radius = 0;
  for (const it of items) radius = Math.max(radius, Math.hypot(it.center[0] - c[0], it.center[1] - c[1], it.center[2] - c[2]) + Math.max(0, it.radius));
  return { center: c, radius };
}
