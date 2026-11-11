/**
 * overlay of the scene view: orbit / pan / dolly navigation of the free editor camera, click to select a
 * 3d plane, and a gizmo for the selected clip or camera clip with three tools:
 * move (x, y, z arrows), rotate (three rings: tilt, turn, roll) and scale (one handle for all sides, three along the
 * clip's own axes to stretch one).
 *
 * like the output overlay nothing renders per frame in react: the svg is rewritten imperatively from store
 * subscriptions, and pointer moves are coalesced to one update per animation frame.
 */
import { useLayoutEffect, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent, WheelEvent as ReactWheelEvent } from 'react';
import { Grid3x3, Maximize2, Move, RotateCw } from 'lucide-react';
import { getClipBox, visibleClipsAt } from '../../engine/draw';
import { parentModelMatrix } from '../../engine/parent';
import { type CameraRig, cameraClipAt, cameraFromClip, cameraRig, homeDistance, projectPoint, rayPlane, screenRay } from '../../engine/scene3d/camera';
import { type Vec3, add, dot, scale as vscale } from '../../engine/scene3d/math';
import { resolveClip } from '../../lib/anim';
import { parentOf } from '../../lib/links';
import { clipEnd } from '../../lib/timelineOps';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { useUi } from '../../store/ui';
import type { Project, VisualClip } from '../../types';
import { MAX_SCALE, MIN_SCALE, isVisualClip, stretchX, stretchY, stretchZ } from '../../types';
import { floorY } from '../properties/place3d';
import { isAttached, localDelta, localDelta3, resolveShown, withoutRidingChildren, worldClip } from './attached';
import { beginPreviewGesture, endPreviewGesture } from './gesture';
import { type Quad, asScenePlane, clipQuad, closestOnAxis, rayQuad, sceneCenter, segDist, unwrapStep, usesParentFrame, worldCenter3d } from './overlayMath';
import { type Orbit, currentOrbit, frameOrbit, toCamera3D, useSceneCamera } from './sceneCamera';
import {
  MIN_STRETCH_HANDLE_PX,
  RING_LABELS,
  RING_PROPS,
  type RingProp,
  STRETCH_PROPS,
  type ScaleProp,
  type SceneTool,
  axisPull,
  hasDepth,
  nearestPolyline,
  ownAxes,
  ringAxes,
  ringPoints,
  ringValueSign,
  scaledValue,
  stretchesToClear,
} from './sceneGizmo';
import {
  type AxisLock,
  clipPolygonNear,
  copyReadout,
  floorGrid,
  focusFromDrag,
  focusPlanes,
  isTypingTarget,
  lockForKey,
  moveReadout,
  nextLock,
  rotateReadout,
  scaleLock,
  scaleReadout,
  sectionCorners,
  shouldWriteAxis,
} from './sceneHelpers';
import {
  SCENE_HINTS,
  type SceneCommand,
  blenderCommand,
  blenderPress,
  blenderView,
  boundingSphere,
  clampOrbitDistance,
  dollyDistance,
  pointInRect,
  quadTouchesRect,
  rectOf,
  typeNumber,
  typedValue,
  useSceneControls,
} from './sceneControls';
import { snapAngle, snapDelta } from './sceneSnap';
import { useSceneGrid, useSceneTool } from './sceneTool';
import { cameraToView, frameSelected, frameTarget, viewRig, viewThroughCamera } from './sceneViews';

const GIZMO_PX = 84;
const AXIS_HIT_PX = 8;
const CENTER_HIT_PX = 7;
const FOCUS_HIT_PX = 9;
const RING_HIT_PX = 7;
const SCALE_HIT_PX = 11;
/** the scale handle sits this far up and to the right of the clip center, css px */
const SCALE_OFFSET_PX = 60;
const CAMERA_HIT_PX = 12;
const DRAG_THRESHOLD_PX = 3;
const ORBIT_DEG_PER_PX = 0.3;
/** how far along its axis a stretch handle reaches, of the move arrow's length */
const STRETCH_LEN = 0.75;
const STRETCH_HIT_PX = 9;
const AXES: Vec3[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];
const AXIS_NAMES = ['x', 'y', 'z'] as const;
const SVG_NS = 'http://www.w3.org/2000/svg';

const TOOLS: ReadonlyArray<{ tool: SceneTool; label: string; key: string; Icon: typeof Move; hint: string }> = [
  { tool: 'move', label: 'move', key: 'w', Icon: Move, hint: 'drag an arrow to move along x, y or z' },
  { tool: 'rotate', label: 'rotate', key: 'e', Icon: RotateCw, hint: 'drag a ring to tilt, turn or roll' },
  { tool: 'scale', label: 'scale', key: 'r', Icon: Maximize2, hint: 'drag the square away from the center to grow, a small square on an axis stretches only that axis' },
];

interface Target {
  id: string;
  /** a camera clip only moves; a clip also rotates and scales */
  kind: 'camera' | 'clip';
  /** false = a 2d clip: dragging tilt, turn or z turns it 3d first */
  threeD: boolean;
  center: Vec3;
  /** current x y z (clip.transform or camera values) */
  v: [number, number, number];
  /** current tilt, turn and roll (clips) */
  rot: [number, number, number];
  scale: number;
  /** the clip's own stretch along x, y and z (1 = none) */
  st: [number, number, number];
  /** depth means something here (a 3d solid, extruded 3d text): the z stretch exists */
  depth: boolean;
  /** world axes of the tilt, turn and roll rings */
  axes: [Vec3, Vec3, Vec3];
  /** the clip's own x, y and z axes in the world (the stretch handles lie along them) */
  own: [Vec3, Vec3, Vec3];
}

type Hover = { kind: 'axis' | 'ring' | 'scale' | 'stretch' | 'center' | 'focus'; i: number } | null;

interface GizmoState {
  visible: boolean;
  tool: SceneTool;
  /** css px relative to the overlay */
  cx: number;
  cy: number;
  tips: Array<{ x: number; y: number; ok: boolean }>;
  /** flat x y arrays per ring (null = not fully in front of the camera) */
  rings: Array<number[] | null>;
  scaleTip: { x: number; y: number };
  /** the ends of the three stretch handles (css px); ok = shown (long enough on screen, z only with a depth) */
  stretchTips: Array<{ x: number; y: number; ok: boolean }>;
  target: Target | null;
}

/** one clip a move writes to */
interface MoveItem {
  id: string;
  /** own x y z at the grab (an attached clip writes all of them so it follows a world axis exactly) */
  v3: Vec3;
  /** axes this gesture has written, so a lock pressed later still resets them to the grab value */
  written: [boolean, boolean, boolean];
  /** a 2d clip moved along z becomes 3d the moment z is the moved axis */
  to3d: boolean;
}

/** one clip a turn writes to */
interface RingItem {
  id: string;
  v0: number;
  /** value change per clockwise degree */
  sign: 1 | -1;
  to3d: boolean;
}

interface ScaleItem {
  id: string;
  /** the values at the grab: scale and the three stretches */
  v0: Record<ScaleProp, number>;
  /** the z stretch means something for this clip */
  depth: boolean;
  /** props this gesture has written, so a lock pressed later sends the others back to their grab values */
  written: Set<ScaleProp>;
}

/**
 * `modal`: a g / r / s transform of the blender controls. no button is held: the pointer just moves, a click or
 * enter keeps it, a right click or escape takes it back. `typed` is the number typed so far ("g x 100").
 */
type SceneGesture =
  | { kind: 'orbit'; pointerId: number; startX: number; startY: number; o0: Orbit; moved: boolean; click: boolean }
  | { kind: 'pan'; pointerId: number; startX: number; startY: number; o0: Orbit; moved: boolean; click: boolean }
  | { kind: 'dolly'; pointerId: number; startX: number; startY: number; o0: Orbit; moved: boolean; click: boolean }
  /** blender controls, left button on empty space: a click selects what is under it, a drag draws a selection box. `add`: shift */
  | { kind: 'box'; pointerId: number; startX: number; startY: number; moved: boolean; add: boolean }
  | {
      kind: 'axis';
      pointerId: number;
      startX: number;
      startY: number;
      started: boolean;
      modal: boolean;
      typed: string;
      /** the arrow that was grabbed (0 x, 1 y, 2 z) or -1 for the center dot (free move) */
      axis: number;
      /** x / y / z key lock, null = none (the grabbed arrow, or the free move, applies) */
      lock: AxisLock;
      /** where the grab ray was along each axis line (null = that axis is edge on) */
      t0s: [number | null, number | null, number | null];
      /** the grab point on the plane of a free move, and that plane's normal (the canvas plane for a 2d clip, else facing the view) */
      p0: Vec3 | null;
      normal: Vec3;
      c0: Vec3;
      /** x y z of the clip with the gizmo at the grab: what the grid snap counts from */
      v3: Vec3;
      /** the clips that are moved: the one with the gizmo, with the blender controls every selected one */
      items: MoveItem[];
      rig: CameraRig;
      /** alt was held on the grab (unity controls) or shift + d was pressed (blender): the move leaves a copy behind and moves the copy */
      copy: boolean;
    }
  | {
      kind: 'focus';
      pointerId: number;
      startX: number;
      startY: number;
      started: boolean;
      id: string;
      /** the camera's view axis (unit) and eye at the grab */
      eye: Vec3;
      fwd: Vec3;
      t0: number;
      d0: number;
      max: number;
      rig: CameraRig;
    }
  | {
      kind: 'ring';
      pointerId: number;
      startX: number;
      startY: number;
      started: boolean;
      modal: boolean;
      typed: string;
      ring: number;
      prop: RingProp;
      /** projected center, css px relative to the overlay */
      cx: number;
      cy: number;
      /** pointer angle at the last step, degrees */
      last: number;
      /** unwrapped clockwise pointer rotation since the grab, degrees */
      acc: number;
      /** the clips that are turned, the one with the gizmo first */
      items: RingItem[];
    }
  | {
      kind: 'scale';
      pointerId: number;
      startX: number;
      startY: number;
      started: boolean;
      modal: boolean;
      typed: string;
      cx: number;
      cy: number;
      d0: number;
      items: ScaleItem[];
      /** null = every side (scale), 0 / 1 / 2 = only that axis of the clip (scaleX / scaleY / scaleZ) */
      lock: AxisLock;
      /** a dragged axis handle: its direction on screen, the pull along it counts. null = the distance from the center */
      dir: { x: number; y: number } | null;
    };

type ModalMode = 'grab' | 'rotate' | 'scale';
const MODAL_TOOL: Readonly<Record<ModalMode, SceneTool>> = { grab: 'move', rotate: 'rotate', scale: 'scale' };

function isModal(g: SceneGesture | null): g is Extract<SceneGesture, { modal: boolean }> {
  return !!g && (g.kind === 'axis' || g.kind === 'ring' || g.kind === 'scale') && g.modal;
}

interface PointerSnapshot {
  x: number;
  y: number;
}

const inRange = (c: { start: number; duration: number }, time: number) => time >= c.start - 1e-6 && time < clipEnd(c) - 1e-6;

/**
 * the running move gesture's handler for the x / y / z lock keys, null when no move is being dragged.
 * the listener is installed once when this module loads, so it runs BEFORE the shortcut guard that gesture.ts
 * installs later on window (that guard swallows every key during a drag).
 */
let keyHook: ((e: KeyboardEvent) => void) | null = null;
/**
 * blender controls. `modalKeys`: a g / r / s transform is running and every key belongs to it (also on release,
 * for ctrl and shift). `sceneKeys`: nothing is running, the mounted scene view looks whether the key is one of
 * its own (only while the pointer is over it). both run before the editor's shortcuts, like `keyHook`.
 */
let modalKeys: ((e: KeyboardEvent, up: boolean) => void) | null = null;
let sceneKeys: ((e: KeyboardEvent) => void) | null = null;
if (typeof window !== 'undefined') {
  window.addEventListener(
    'keydown',
    (e) => {
      if (modalKeys) modalKeys(e, false);
      else if (keyHook) {
        if (!e.ctrlKey && !e.metaKey) keyHook(e);
      } else if (sceneKeys) sceneKeys(e);
    },
    true,
  );
  window.addEventListener(
    'keyup',
    (e) => {
      if (modalKeys) modalKeys(e, true);
    },
    true,
  );
}

/** the selected clip the gizmo works on: the first selected visual clip or camera clip that is active now */
function gizmoTarget(project: Project, selection: readonly string[], time: number, rig: CameraRig): Target | null {
  for (const id of selection) {
    const t = targetOf(project, id, time, rig);
    if (t) return t;
  }
  return null;
}

/** every selected clip a transform can work on, in the order of the selection */
function allTargets(project: Project, selection: readonly string[], time: number, rig: CameraRig): Target[] {
  const out: Target[] = [];
  for (const id of selection) {
    const t = targetOf(project, id, time, rig);
    if (t) out.push(t);
  }
  return out;
}

/** a clip as something the gizmo can move: null when it is not active now, locked, or not a visual or camera clip */
function targetOf(project: Project, id: string, time: number, rig: CameraRig): Target | null {
  {
    const clip = project.clips.find((c) => c.id === id);
    if (!clip || !inRange(clip, time)) return null;
    // a clip on a locked track cannot be edited: no handles (a drag would do nothing, an alt drag would copy it)
    if (project.tracks.find((t) => t.id === clip.trackId)?.locked) return null;
    if (clip.type === 'camera') {
      const r = resolveClip(clip, time);
      return {
        id,
        kind: 'camera',
        threeD: true,
        center: [project.width / 2 + r.x, project.height / 2 + r.y, -homeDistance(project.height) + r.z],
        v: [r.x, r.y, r.z],
        rot: [0, 0, 0],
        scale: 1,
        st: [1, 1, 1],
        depth: false,
        axes: AXES as [Vec3, Vec3, Vec3],
        own: AXES as [Vec3, Vec3, Vec3],
      };
    }
    if (isVisualClip(clip)) {
      // the gizmo sits at the world pose (an attached clip is drawn there); the values it edits stay the clip's own
      const r = resolveShown(clip, time);
      const threeD = !!clip.threeD;
      if (usesParentFrame(clip)) {
        // a real 3d clip under a parent: center and rings come from the parent's matrix, so z and the rings are exact
        const parent = parentModelMatrix(project, clip, time);
        const center = worldCenter3d(project, clip, time);
        return {
          id,
          kind: 'clip',
          threeD,
          center,
          v: [r.transform.x, r.transform.y, r.transform.z ?? 0],
          rot: [r.transform.rotX ?? 0, r.transform.rotY ?? 0, r.transform.rotation],
          scale: r.transform.scale,
          st: [stretchX(r.transform), stretchY(r.transform), stretchZ(r.transform)],
          depth: hasDepth(clip),
          axes: ringAxes(getClipBox(project, r), { x: r.transform.x, y: r.transform.y, z: r.transform.z ?? 0, rotX: r.transform.rotX ?? 0, rotY: r.transform.rotY ?? 0 }, clip.lookAt, rig.eye, parent),
          own: ownAxes(getClipBox(project, r), { x: r.transform.x, y: r.transform.y, z: r.transform.z ?? 0, rotX: r.transform.rotX ?? 0, rotY: r.transform.rotY ?? 0 }, clip.lookAt, rig.eye, parent),
        };
      }
      const w = worldClip(project, clip, time);
      const box = getClipBox(project, w);
      const z = threeD ? (w.transform.z ?? 0) : 0;
      const rotX = threeD ? (w.transform.rotX ?? 0) : 0;
      const rotY = threeD ? (w.transform.rotY ?? 0) : 0;
      return {
        id,
        kind: 'clip',
        threeD,
        center: [box.cx, box.cy, z],
        v: [r.transform.x, r.transform.y, threeD ? (r.transform.z ?? 0) : 0],
        rot: [threeD ? (r.transform.rotX ?? 0) : 0, threeD ? (r.transform.rotY ?? 0) : 0, r.transform.rotation],
        scale: r.transform.scale,
        st: [stretchX(r.transform), stretchY(r.transform), stretchZ(r.transform)],
        depth: hasDepth(clip),
        axes: ringAxes(box, { z, rotX, rotY }, threeD ? clip.lookAt : undefined, rig.eye),
        own: ownAxes(box, { z, rotX, rotY }, threeD ? clip.lookAt : undefined, rig.eye),
      };
    }
  }
  return null;
}

/**
 * the clips a transform writes to. unity controls: the one with the gizmo. blender controls: every selected
 * clip, except one that rides a selected parent (it follows its parent, moving it too would move it twice).
 */
function writeTargets(project: Project, primary: Target, time: number, rig: CameraRig): Target[] {
  if (useSceneControls.getState().scheme !== 'blender') return [primary];
  const all = allTargets(project, useEditor.getState().selection, time, rig);
  const clips: VisualClip[] = [];
  for (const t of all) {
    const c = t.kind === 'clip' ? project.clips.find((x) => x.id === t.id) : undefined;
    if (c && isVisualClip(c)) clips.push(c);
  }
  const keep = new Set(withoutRidingChildren(project, clips).map((c) => c.id));
  const out = all.filter((t) => t.kind === 'camera' || keep.has(t.id));
  return out.length > 0 ? out : [primary];
}

const moveItem = (t: Target): MoveItem => ({ id: t.id, v3: [t.v[0], t.v[1], t.v[2]], written: [false, false, false], to3d: t.kind === 'clip' && !t.threeD });

/** the turn of `ring` (0 tilt, 1 turn, 2 roll) for every clip among the targets. a camera clip only moves. */
function ringItems(targets: readonly Target[], ring: number, forward: Vec3): RingItem[] {
  const prop = RING_PROPS[ring]!;
  return targets
    .filter((t) => t.kind === 'clip')
    .map((t) => ({ id: t.id, v0: t.rot[ring]!, sign: ringValueSign(prop, t.axes[ring]!, forward), to3d: !t.threeD && ring < 2 }));
}

const scaleItems = (targets: readonly Target[]): ScaleItem[] =>
  targets
    .filter((t) => t.kind === 'clip')
    .map((t) => ({ id: t.id, v0: { scale: t.scale, scaleX: t.st[0], scaleY: t.st[1], scaleZ: t.st[2] }, depth: t.depth, written: new Set<ScaleProp>() }));

/** what a click or a selection box can pick in the scene view: the camera in charge and the 3d planes on open tracks */
function sceneCandidates(project: Project, time: number): { camera: string | null; clips: VisualClip[] } {
  const clips: VisualClip[] = [];
  for (const clip of visibleClipsAt(project, time)) {
    if (!clip.threeD) continue;
    const track = project.tracks.find((t) => t.id === clip.trackId);
    if (!track || track.locked) continue;
    clips.push(clip);
  }
  return { camera: cameraClipAt(project, time)?.id ?? null, clips };
}

/** the ids a selection box picks. the box is in canvas pixels, like the projected planes. */
function boxHits(project: Project, time: number, rig: CameraRig, x0: number, y0: number, x1: number, y1: number): string[] {
  const box = rectOf(x0, y0, x1, y1);
  const out: string[] = [];
  const { camera, clips } = sceneCandidates(project, time);
  const camClip = camera ? project.clips.find((c) => c.id === camera) : undefined;
  if (camClip && camClip.type === 'camera') {
    const r = resolveClip(camClip, time);
    const e = projectPoint(rig, project.width / 2 + r.x, project.height / 2 + r.y, -homeDistance(project.height) + r.z, project.width, project.height);
    if (e.visible && pointInRect(e.x, e.y, box)) out.push(camClip.id);
  }
  for (const clip of clips) {
    const q = clipQuad(project, clip, time, rig);
    if (q.visible && quadTouchesRect(q.p, box)) out.push(clip.id);
  }
  return out;
}

/** what is under a canvas point in the scene view: the project camera (its eye) or the nearest 3d plane */
function sceneHit(project: Project, time: number, rig: CameraRig, px: number, py: number, f: number): string | null {
  const camClip = cameraClipAt(project, time);
  if (camClip) {
    const r = resolveClip(camClip, time);
    const e = projectPoint(rig, project.width / 2 + r.x, project.height / 2 + r.y, -homeDistance(project.height) + r.z, project.width, project.height);
    if (e.visible && Math.hypot(e.x - px, e.y - py) * f <= CAMERA_HIT_PX) return camClip.id;
  }
  const ray = screenRay(rig, px, py, project.width, project.height);
  let best: string | null = null;
  let bestT = Infinity;
  for (const clip of visibleClipsAt(project, time)) {
    if (!clip.threeD) continue;
    const track = project.tracks.find((t) => t.id === clip.trackId);
    if (!track || track.locked) continue;
    const q = clipQuad(project, clip, time, rig);
    const t = rayQuad(ray.origin, ray.dir, q.world);
    if (t !== null && t < bestT) {
      best = clip.id;
      bestT = t;
    }
  }
  return best;
}

export function SceneOverlay() {
  const rootRef = useRef<HTMLDivElement>(null);
  const polyGroup = useRef<SVGGElement>(null);
  const linkGroup = useRef<SVGGElement>(null);
  const lookGroup = useRef<SVGGElement>(null);
  const axisLine = useRef<Array<SVGLineElement | null>>([null, null, null]);
  const axisUnder = useRef<Array<SVGLineElement | null>>([null, null, null]);
  const axisTip = useRef<Array<SVGRectElement | null>>([null, null, null]);
  const axisText = useRef<Array<SVGTextElement | null>>([null, null, null]);
  const axisGroup = useRef<Array<SVGGElement | null>>([null, null, null]);
  const ringGroup = useRef<Array<SVGGElement | null>>([null, null, null]);
  const ringUnder = useRef<Array<SVGPolylineElement | null>>([null, null, null]);
  const ringLine = useRef<Array<SVGPolylineElement | null>>([null, null, null]);
  const ringText = useRef<Array<SVGTextElement | null>>([null, null, null]);
  const scaleGroup = useRef<SVGGElement>(null);
  const scaleUnder = useRef<SVGLineElement>(null);
  const scaleLine = useRef<SVGLineElement>(null);
  const scaleRect = useRef<SVGRectElement>(null);
  const stretchGroup = useRef<Array<SVGGElement | null>>([null, null, null]);
  const stretchUnder = useRef<Array<SVGLineElement | null>>([null, null, null]);
  const stretchLine = useRef<Array<SVGLineElement | null>>([null, null, null]);
  const stretchRect = useRef<Array<SVGRectElement | null>>([null, null, null]);
  const stretchText = useRef<Array<SVGTextElement | null>>([null, null, null]);
  const centerDot = useRef<SVGCircleElement>(null);
  const targetUnder = useRef<SVGLineElement>(null);
  const targetLine = useRef<SVGLineElement>(null);
  /** some camera clip has a target: the time subscription keeps its line fresh even without a selection */
  const hasTargetCam = useRef(false);
  const gridPath = useRef<SVGPathElement>(null);
  const axisXPath = useRef<SVGPathElement>(null);
  const axisZPath = useRef<SVGPathElement>(null);
  const focusPoly = useRef<Array<SVGPolygonElement | null>>([null, null, null]);
  const focusLabel = useRef<SVGTextElement>(null);
  const focusHandleEl = useRef<HTMLDivElement>(null);
  /** the focus handle of the camera in charge: where it is (css px), and whether it can be dragged */
  const focusHandle = useRef({ ok: false, x: 0, y: 0, id: '', disabled: false, max: 1 });
  /** some camera clip has depth of field on: the time subscription keeps the focus plane fresh */
  const hasFocusCam = useRef(false);
  const focusShown = useRef(false);
  const readoutEl = useRef<SVGTextElement>(null);
  /** live text of the running drag ("x +240"), empty = none */
  const readout = useRef('');
  const lastPointer = useRef<PointerSnapshot | null>(null);
  const viewF = useRef(0);
  const redrawRef = useRef<() => void>(() => undefined);
  const gizmo = useRef<GizmoState>({
    visible: false,
    tool: 'move',
    cx: 0,
    cy: 0,
    tips: [0, 1, 2].map(() => ({ x: 0, y: 0, ok: false })),
    rings: [null, null, null],
    scaleTip: { x: 0, y: 0 },
    stretchTips: [0, 1, 2].map(() => ({ x: 0, y: 0, ok: false })),
    target: null,
  });
  const hover = useRef<Hover>(null);
  const gestureRef = useRef<SceneGesture | null>(null);
  const pendingRef = useRef<PointerSnapshot | null>(null);
  const rafRef = useRef(0);
  const originRef = useRef({ left: 0, top: 0 });
  /** shift held at the last pointer event (rings snap to 15 degree steps) */
  const dragShift = useRef(false);
  /** ctrl / cmd held at the last pointer event (arrows snap to the grid, rings to 15 degree steps) */
  const dragCtrl = useRef(false);
  /** the selection when the running drag began (escape puts it back) */
  const selBefore = useRef<string[]>([]);
  /** the selection box of the blender controls */
  const boxRect = useRef<SVGRectElement>(null);
  /** where the pointer was last seen over the scene view (client px): a g / r / s transform starts from there */
  const hoverXY = useRef<PointerSnapshot | null>(null);
  /** the pointer is over the scene view: its keys are live (blender controls) */
  const inside = useRef(false);
  /** takes the window listeners of a running g / r / s transform away */
  const modalOff = useRef<(() => void) | null>(null);
  /** the time a g / r / s transform started at: everything it writes lands there, also if the playhead moves */
  const modalTime = useRef<number | null>(null);
  const scheme = useSceneControls((s) => s.scheme);
  const tool = useSceneTool((s) => s.tool);
  const setTool = useSceneTool((s) => s.setTool);
  const gridOn = useSceneGrid((s) => s.on);
  const toggleGrid = useSceneGrid((s) => s.toggle);

  /* ---------- imperative drawing ---------- */
  useLayoutEffect(() => {
    const root = rootRef.current;
    const group = polyGroup.current;
    if (!root || !group) return;
    const unders: SVGPolygonElement[] = [];
    const lines: SVGPolygonElement[] = [];
    const scratch: Quad = { p: [0, 0, 0, 0, 0, 0, 0, 0], visible: true, depth: 0, world: [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]], cx: 0, cy: 0 };

    const poly = (i: number) => {
      while (unders.length <= i) {
        const u = document.createElementNS(SVG_NS, 'polygon');
        u.setAttribute('class', 'scene-poly-under');
        const l = document.createElementNS(SVG_NS, 'polygon');
        l.setAttribute('class', 'scene-poly');
        group.appendChild(u);
        group.appendChild(l);
        unders.push(u);
        lines.push(l);
      }
      return i;
    };

    const linkGroupEl = linkGroup.current;
    const linkLines: SVGLineElement[] = [];
    const linkLine = (i: number) => {
      while (linkLines.length <= i && linkGroupEl) {
        const l = document.createElementNS(SVG_NS, 'line');
        l.setAttribute('class', 'scene-link-line');
        linkGroupEl.appendChild(l);
        linkLines.push(l);
      }
      return linkLines[i]!;
    };

    const lookGroupEl = lookGroup.current;
    const lookLines: SVGLineElement[] = [];
    const lookLine = (i: number) => {
      while (lookLines.length <= i && lookGroupEl) {
        const l = document.createElementNS(SVG_NS, 'line');
        l.setAttribute('class', 'scene-look-line');
        lookGroupEl.appendChild(l);
        lookLines.push(l);
      }
      return lookLines[i]!;
    };

    /** the focus plane of the camera in charge: where things are sharp, as rectangles across its view pyramid */
    const drawFocus = (project: Project | null, f: number) => {
      const polys = focusPoly.current;
      const label = focusLabel.current;
      const handle = focusHandleEl.current;
      const fh = focusHandle.current;
      fh.ok = false;
      hasFocusCam.current = !!project && project.clips.some((c) => c.type === 'camera' && ((c.focusStrength ?? 0) > 0 || (c.keyframes?.focusStrength?.length ?? 0) > 0));
      let on = false;
      if (project && f > 0 && hasFocusCam.current) {
        const time = usePlayback.getState().time;
        const camClip = cameraClipAt(project, time);
        const cr = camClip ? cameraRig(cameraFromClip(camClip, time, project), project.width, project.height) : null;
        const focus = camClip && cr ? cr.focus : null;
        if (camClip && cr && focus) {
          on = true;
          const rig = viewRig(project);
          const planes = focusPlanes(focus, cr.near);
          for (let k = 0; k < 3; k++) {
            const el = polys[k];
            if (!el) continue;
            const plane = planes[k];
            let pts = '';
            if (plane) {
              // cut at the scene camera's near plane, so a rectangle that reaches behind the view still shows its front part
              const corners = clipPolygonNear(sectionCorners(cr, plane.distance), rig.eye, rig.forward, rig.near);
              for (let ci = 0; ci < corners.length; ci++) {
                const c = corners[ci]!;
                const sp = projectPoint(rig, c[0], c[1], c[2], project.width, project.height);
                if (!sp.visible) {
                  pts = '';
                  break;
                }
                pts += `${sp.x * f},${sp.y * f} `;
                if (k === 0 && label && ci === 0) {
                  label.setAttribute('x', String(sp.x * f + 4));
                  label.setAttribute('y', String(sp.y * f + 13));
                }
              }
            }
            if (pts) el.setAttribute('points', pts);
            el.style.display = pts ? '' : 'none';
            if (k === 0 && label) {
              label.style.display = pts ? '' : 'none';
              label.textContent = `focus ${Math.round(focus.distance)}`;
            }
          }
          // the handle rides the view axis at the focus distance, only while the camera clip is selected
          if (useEditor.getState().selection.includes(camClip.id)) {
            const hp = projectPoint(
              rig,
              cr.eye[0] + cr.forward[0] * focus.distance,
              cr.eye[1] + cr.forward[1] * focus.distance,
              cr.eye[2] + cr.forward[2] * focus.distance,
              project.width,
              project.height,
            );
            if (hp.visible) {
              fh.ok = true;
              fh.x = hp.x * f;
              fh.y = hp.y * f;
              fh.id = camClip.id;
              fh.max = Math.round(homeDistance(project.height) * 6);
              fh.disabled = !!camClip.focusOnTarget && !!camClip.target && project.clips.some((c) => c.id === camClip.target && isVisualClip(c));
            }
          }
        }
      }
      if (on || focusShown.current) {
        focusShown.current = on;
        if (!on) {
          for (const el of polys) if (el) el.style.display = 'none';
          if (label) label.style.display = 'none';
        }
      }
      if (handle) {
        handle.style.display = fh.ok ? '' : 'none';
        if (fh.ok) {
          handle.style.transform = `translate3d(${fh.x - 6}px, ${fh.y - 6}px, 0)`;
          handle.classList.toggle('is-disabled', fh.disabled);
          handle.classList.toggle('is-active', gestureRef.current?.kind === 'focus');
          const title = fh.disabled
            ? 'focus distance: the focus follows the camera target. turn off follow target in the inspector to drag it'
            : 'focus distance: drag along the view axis. the focus distance field in the inspector does the same';
          if (handle.title !== title) handle.title = title;
        }
      }
    };

    const redraw = () => {
      const project = useEditor.getState().project;
      const f = viewF.current;
      const gz = gizmo.current;
      let used = 0;
      gz.visible = false;
      gz.target = null;
      if (project && f > 0) {
        const time = usePlayback.getState().time;
        const selection = useEditor.getState().selection;
        const rig = viewRig(project);
        // outlines of the selected clips (a 2d clip lies flat on the canvas plane)
        for (const id of selection) {
          const clip = project.clips.find((c) => c.id === id);
          if (!clip || !isVisualClip(clip) || !inRange(clip, time)) continue;
          const q = clipQuad(project, asScenePlane(clip), time, rig, scratch);
          if (!q.visible) continue;
          const i = poly(used++);
          const pts = `${q.p[0] * f},${q.p[1] * f} ${q.p[2] * f},${q.p[3] * f} ${q.p[4] * f},${q.p[5] * f} ${q.p[6] * f},${q.p[7] * f}`;
          unders[i]!.setAttribute('points', pts);
          lines[i]!.setAttribute('points', pts);
        }
        // the gizmo of the active tool
        const target = gizmoTarget(project, selection, time, rig);
        if (target) {
          const tl: SceneTool = target.kind === 'clip' ? useSceneTool.getState().tool : 'move';
          const c = projectPoint(rig, target.center[0], target.center[1], target.center[2], project.width, project.height);
          if (c.visible) {
            const focal = project.height / 2 / rig.tanHalf;
            const len = ((GIZMO_PX / f) * c.depth) / focal;
            gz.visible = true;
            gz.target = target;
            gz.tool = tl;
            gz.cx = c.x * f;
            gz.cy = c.y * f;
            if (tl === 'move') {
              for (let a = 0; a < 3; a++) {
                const ax = AXES[a]!;
                const t = projectPoint(
                  rig,
                  target.center[0] + ax[0] * len,
                  target.center[1] + ax[1] * len,
                  target.center[2] + ax[2] * len,
                  project.width,
                  project.height,
                );
                const tip = gz.tips[a]!;
                tip.ok = t.visible;
                tip.x = t.x * f;
                tip.y = t.y * f;
              }
            } else if (tl === 'rotate') {
              for (let a = 0; a < 3; a++) {
                const pts = ringPoints(target.center, target.axes[a]!, len * 0.9);
                const flat: number[] = [];
                let ok = true;
                for (const p of pts) {
                  const s = projectPoint(rig, p[0], p[1], p[2], project.width, project.height);
                  if (!s.visible) {
                    ok = false;
                    break;
                  }
                  flat.push(s.x * f, s.y * f);
                }
                gz.rings[a] = ok ? flat : null;
              }
            } else {
              gz.scaleTip.x = gz.cx + SCALE_OFFSET_PX;
              gz.scaleTip.y = gz.cy - SCALE_OFFSET_PX;
              for (let a = 0; a < 3; a++) {
                const ax = target.own[a]!;
                const t = projectPoint(
                  rig,
                  target.center[0] + ax[0] * len * STRETCH_LEN,
                  target.center[1] + ax[1] * len * STRETCH_LEN,
                  target.center[2] + ax[2] * len * STRETCH_LEN,
                  project.width,
                  project.height,
                );
                const tip = gz.stretchTips[a]!;
                tip.x = t.x * f;
                tip.y = t.y * f;
                // an axis that points at the viewer would be a dot: no handle. z only where depth means something.
                tip.ok = t.visible && Math.hypot(tip.x - gz.cx, tip.y - gz.cy) >= MIN_STRETCH_HANDLE_PX && (a < 2 || target.depth);
              }
            }
          }
        }
      }
      // thin line from each selected attached clip to the center of its parent
      let links = 0;
      if (project && f > 0) {
        const time = usePlayback.getState().time;
        for (const id of useEditor.getState().selection) {
          const clip = project.clips.find((c) => c.id === id);
          if (!clip || !isVisualClip(clip) || !isAttached(clip) || !inRange(clip, time)) continue;
          const parent = parentOf(project, clip);
          if (!parent) continue;
          const rig = viewRig(project);
          const a = sceneCenter(project, clip, time);
          const b = sceneCenter(project, parent, time);
          if (!a || !b) continue;
          const pa = projectPoint(rig, a[0], a[1], a[2], project.width, project.height);
          const pb = projectPoint(rig, b[0], b[1], b[2], project.width, project.height);
          if (!pa.visible || !pb.visible) continue;
          const ln = linkLine(links++);
          ln.setAttribute('x1', String(pa.x * f));
          ln.setAttribute('y1', String(pa.y * f));
          ln.setAttribute('x2', String(pb.x * f));
          ln.setAttribute('y2', String(pb.y * f));
        }
      }
      for (let i = 0; i < linkLines.length; i++) linkLines[i]!.style.display = i < links ? '' : 'none';

      // dashed line from each selected 3d clip that looks at a clip to the center of that clip
      let looks = 0;
      if (project && f > 0) {
        const time = usePlayback.getState().time;
        for (const id of useEditor.getState().selection) {
          const clip = project.clips.find((c) => c.id === id);
          if (!clip || !isVisualClip(clip) || !clip.threeD || clip.lookAt !== 'clip' || !clip.lookTarget || !inRange(clip, time)) continue;
          const target = project.clips.find((c) => c.id === clip.lookTarget);
          if (!target || target.id === clip.id || !isVisualClip(target) || !inRange(target, time)) continue;
          const rig = viewRig(project);
          const a = sceneCenter(project, clip, time);
          const b = sceneCenter(project, target, time);
          if (!a || !b) continue;
          const pa = projectPoint(rig, a[0], a[1], a[2], project.width, project.height);
          const pb = projectPoint(rig, b[0], b[1], b[2], project.width, project.height);
          if (!pa.visible || !pb.visible) continue;
          const ln = lookLine(looks++);
          ln.setAttribute('x1', String(pa.x * f));
          ln.setAttribute('y1', String(pa.y * f));
          ln.setAttribute('x2', String(pb.x * f));
          ln.setAttribute('y2', String(pb.y * f));
        }
      }
      for (let i = 0; i < lookLines.length; i++) lookLines[i]!.style.display = i < looks ? '' : 'none';

      // thin line from the project camera to the center of the clip it keeps looking at
      let lineOn = false;
      hasTargetCam.current = !!project && project.clips.some((c) => c.type === 'camera' && !!c.target);
      const under = targetUnder.current;
      const line = targetLine.current;
      if (project && f > 0 && under && line) {
        const time = usePlayback.getState().time;
        const camClip = cameraClipAt(project, time);
        const tid = camClip?.target;
        const tClip = tid ? project.clips.find((c) => c.id === tid) : undefined;
        if (camClip && tClip && isVisualClip(tClip) && inRange(tClip, time)) {
          const rig = viewRig(project);
          const r = resolveClip(camClip, time);
          const tr = resolveShown(tClip, time);
          const tb = getClipBox(project, tr);
          const a = projectPoint(rig, project.width / 2 + r.x, project.height / 2 + r.y, -homeDistance(project.height) + r.z, project.width, project.height);
          const b = projectPoint(rig, tb.cx, tb.cy, tr.transform.z ?? 0, project.width, project.height);
          if (a.visible && b.visible) {
            lineOn = true;
            for (const ln of [under, line]) {
              ln.setAttribute('x1', String(a.x * f));
              ln.setAttribute('y1', String(a.y * f));
              ln.setAttribute('x2', String(b.x * f));
              ln.setAttribute('y2', String(b.y * f));
            }
          }
        }
      }
      if (under) under.style.display = lineOn ? '' : 'none';
      if (line) line.style.display = lineOn ? '' : 'none';
      for (let i = 0; i < unders.length; i++) {
        const show = i < used ? '' : 'none';
        unders[i]!.style.display = show;
        lines[i]!.style.display = show;
      }

      drawFocus(project, f);

      // a handle is "hover" under the pointer and "active" while it is being dragged
      const g = gestureRef.current;
      const hv = hover.current;
      const stateOf = (kind: 'axis' | 'ring' | 'scale' | 'stretch', i: number): [boolean, boolean] => {
        if (g) {
          const act =
            (g.kind === 'axis' && kind === 'axis' && g.axis === i) ||
            (g.kind === 'ring' && kind === 'ring' && g.ring === i) ||
            (g.kind === 'scale' && kind === 'scale' && g.lock === null) ||
            (g.kind === 'scale' && kind === 'stretch' && g.lock === i);
          return [false, act];
        }
        return [hv?.kind === kind && hv.i === i, false];
      };

      // move: three arrows
      for (let a = 0; a < 3; a++) {
        const ag = axisGroup.current[a];
        if (!ag) continue;
        const tip = gz.tips[a]!;
        if (!gz.visible || gz.tool !== 'move' || !tip.ok) {
          ag.style.display = 'none';
          continue;
        }
        ag.style.display = '';
        const x1 = String(gz.cx);
        const y1 = String(gz.cy);
        const x2 = String(tip.x);
        const y2 = String(tip.y);
        for (const ln of [axisLine.current[a], axisUnder.current[a]]) {
          if (!ln) continue;
          ln.setAttribute('x1', x1);
          ln.setAttribute('y1', y1);
          ln.setAttribute('x2', x2);
          ln.setAttribute('y2', y2);
        }
        axisTip.current[a]?.setAttribute('x', String(tip.x - 4));
        axisTip.current[a]?.setAttribute('y', String(tip.y - 4));
        const text = axisText.current[a];
        if (text) {
          // the label sits a little past the tip, along the axis
          const dx = tip.x - gz.cx;
          const dy = tip.y - gz.cy;
          const l = Math.hypot(dx, dy) || 1;
          text.setAttribute('x', String(tip.x + (dx / l) * 12));
          text.setAttribute('y', String(tip.y + (dy / l) * 12 + 4));
        }
        const [h, act] = stateOf('axis', a);
        ag.classList.toggle('is-hover', h);
        ag.classList.toggle('is-active', act);
      }

      // rotate: three rings
      for (let a = 0; a < 3; a++) {
        const rg = ringGroup.current[a];
        if (!rg) continue;
        const pts = gz.rings[a];
        if (!gz.visible || gz.tool !== 'rotate' || !pts) {
          rg.style.display = 'none';
          continue;
        }
        rg.style.display = '';
        let s = '';
        for (let i = 0; i < pts.length; i += 2) s += `${pts[i]},${pts[i + 1]} `;
        ringUnder.current[a]?.setAttribute('points', s);
        ringLine.current[a]?.setAttribute('points', s);
        const text = ringText.current[a];
        if (text) {
          // the label rides on the ring, at its point farthest from the center (top right)
          let bi = 0;
          let bd = -Infinity;
          for (let i = 0; i < pts.length; i += 2) {
            const d = pts[i]! - gz.cx - (pts[i + 1]! - gz.cy);
            if (d > bd) {
              bd = d;
              bi = i;
            }
          }
          text.setAttribute('x', String(pts[bi]! + 8));
          text.setAttribute('y', String(pts[bi + 1]! - 6));
        }
        const [h, act] = stateOf('ring', a);
        rg.classList.toggle('is-hover', h);
        rg.classList.toggle('is-active', act);
      }

      // scale: a handle along each of the clip's own axes (stretch one axis)
      for (let a = 0; a < 3; a++) {
        const stg = stretchGroup.current[a];
        if (!stg) continue;
        const tip = gz.stretchTips[a]!;
        if (!gz.visible || gz.tool !== 'scale' || !tip.ok) {
          stg.style.display = 'none';
          continue;
        }
        stg.style.display = '';
        for (const ln of [stretchUnder.current[a], stretchLine.current[a]]) {
          if (!ln) continue;
          ln.setAttribute('x1', String(gz.cx));
          ln.setAttribute('y1', String(gz.cy));
          ln.setAttribute('x2', String(tip.x));
          ln.setAttribute('y2', String(tip.y));
        }
        stretchRect.current[a]?.setAttribute('x', String(tip.x - 4));
        stretchRect.current[a]?.setAttribute('y', String(tip.y - 4));
        const text = stretchText.current[a];
        if (text) {
          const dx = tip.x - gz.cx;
          const dy = tip.y - gz.cy;
          const l = Math.hypot(dx, dy) || 1;
          text.setAttribute('x', String(tip.x + (dx / l) * 12));
          text.setAttribute('y', String(tip.y + (dy / l) * 12 + 4));
        }
        const [h, act] = stateOf('stretch', a);
        stg.classList.toggle('is-hover', h);
        stg.classList.toggle('is-active', act);
      }

      // scale: one handle for every side
      const sg = scaleGroup.current;
      if (sg) {
        if (!gz.visible || gz.tool !== 'scale') sg.style.display = 'none';
        else {
          sg.style.display = '';
          for (const ln of [scaleUnder.current, scaleLine.current]) {
            if (!ln) continue;
            ln.setAttribute('x1', String(gz.cx));
            ln.setAttribute('y1', String(gz.cy));
            ln.setAttribute('x2', String(gz.scaleTip.x));
            ln.setAttribute('y2', String(gz.scaleTip.y));
          }
          scaleRect.current?.setAttribute('x', String(gz.scaleTip.x - 5));
          scaleRect.current?.setAttribute('y', String(gz.scaleTip.y - 5));
          const [h, act] = stateOf('scale', 0);
          sg.classList.toggle('is-hover', h);
          sg.classList.toggle('is-active', act);
        }
      }

      const dot = centerDot.current;
      if (dot) {
        dot.style.display = gz.visible ? '' : 'none';
        dot.setAttribute('cx', String(gz.cx));
        dot.setAttribute('cy', String(gz.cy));
        dot.classList.toggle('is-hover', !g && hv?.kind === 'center');
        dot.classList.toggle('is-active', g?.kind === 'axis' && g.axis < 0);
      }
      const ro = readoutEl.current;
      if (ro) {
        const text = gz.visible ? readout.current : '';
        ro.style.display = text ? '' : 'none';
        if (text) {
          ro.textContent = text;
          ro.setAttribute('x', String(gz.cx + 14));
          ro.setAttribute('y', String(gz.cy + 30));
        }
      }
    };
    redrawRef.current = redraw;

    /** floor grid and world axis lines. depends on the view and the project size only, never on time */
    const gridEl = gridPath.current;
    const axXEl = axisXPath.current;
    const axZEl = axisZPath.current;
    const pathOf = (seg: ArrayLike<number>, f: number, w: number, h: number, rig: CameraRig): string => {
      let d = '';
      for (let i = 0; i + 5 < seg.length; i += 6) {
        const a = projectPoint(rig, seg[i]!, seg[i + 1]!, seg[i + 2]!, w, h);
        const b = projectPoint(rig, seg[i + 3]!, seg[i + 4]!, seg[i + 5]!, w, h);
        if (!a.visible || !b.visible) continue;
        d += `M${(a.x * f).toFixed(1)} ${(a.y * f).toFixed(1)}L${(b.x * f).toFixed(1)} ${(b.y * f).toFixed(1)}`;
      }
      return d;
    };
    const drawGrid = () => {
      if (!gridEl || !axXEl || !axZEl) return;
      const project = useEditor.getState().project;
      const f = viewF.current;
      if (!project || f <= 0 || !useSceneGrid.getState().on) {
        gridEl.style.display = 'none';
        axXEl.style.display = 'none';
        axZEl.style.display = 'none';
        return;
      }
      const o = currentOrbit(project);
      const rig = viewRig(project);
      const g = floorGrid({
        eye: rig.eye,
        forward: rig.forward,
        targetX: o.targetX,
        targetZ: o.targetZ,
        orbitDistance: o.distance,
        floorY: floorY(project.height),
        near: rig.near,
      });
      gridEl.setAttribute('d', pathOf(g.lines, f, project.width, project.height, rig));
      axXEl.setAttribute('d', g.axisX ? pathOf(g.axisX, f, project.width, project.height, rig) : '');
      axZEl.setAttribute('d', g.axisZ ? pathOf(g.axisZ, f, project.width, project.height, rig) : '');
      gridEl.style.display = '';
      axXEl.style.display = '';
      axZEl.style.display = '';
    };

    let lastW = 0;
    const measure = (w: number) => {
      lastW = w;
      const project = useEditor.getState().project;
      viewF.current = project && project.width > 0 ? w / project.width : 0;
      drawGrid();
      redraw();
    };
    const ro = new ResizeObserver((entries) => {
      const e = entries[0];
      if (e) measure(e.contentRect.width);
    });
    ro.observe(root);

    const unEditor = useEditor.subscribe((s, p) => {
      if (s.project && p.project && s.project.width !== p.project.width && lastW > 0) measure(lastW);
      else if (s.project && p.project && s.project.height !== p.project.height) {
        drawGrid();
        redraw();
      } else if (s.project !== p.project || s.selection !== p.selection) redraw();
    });
    const unTime = usePlayback.subscribe((s, p) => {
      if (s.time !== p.time && (hasTargetCam.current || hasFocusCam.current || useEditor.getState().selection.length > 0)) redraw();
    });
    const unCam = useSceneCamera.subscribe(() => {
      drawGrid();
      redraw();
    });
    const unGrid = useSceneGrid.subscribe(drawGrid);
    const unTool = useSceneTool.subscribe((s, p) => {
      if (s.tool !== p.tool) {
        hover.current = null;
        redraw();
      }
    });
    redraw();
    return () => {
      ro.disconnect();
      unEditor();
      unTime();
      unCam();
      unGrid();
      unTool();
      keyHook = null;
      modalKeys = null;
      modalOff.current?.();
      modalOff.current = null;
      cancelAnimationFrame(rafRef.current);
      endPreviewGesture();
    };
  }, []);

  /* ---------- gestures ---------- */

  const nearestAxis = (x: number, y: number): number => {
    const gz = gizmo.current;
    let best = -1;
    let bestD = AXIS_HIT_PX;
    for (let a = 0; a < 3; a++) {
      const tip = gz.tips[a]!;
      if (!tip.ok) continue;
      const d = segDist(x, y, gz.cx, gz.cy, tip.x, tip.y);
      if (d <= bestD) {
        best = a;
        bestD = d;
      }
    }
    return best;
  };

  /** the gizmo handle under a point (css px relative to the overlay) */
  const handleAt = (x: number, y: number): Hover => {
    const gz = gizmo.current;
    const fh = focusHandle.current;
    if (fh.ok && !fh.disabled && Math.hypot(x - fh.x, y - fh.y) <= FOCUS_HIT_PX) return { kind: 'focus', i: 0 };
    if (!gz.visible || !gz.target) return null;
    if (gz.tool === 'move') {
      if (Math.hypot(x - gz.cx, y - gz.cy) <= CENTER_HIT_PX) return { kind: 'center', i: 0 };
      const a = nearestAxis(x, y);
      return a >= 0 ? { kind: 'axis', i: a } : null;
    }
    if (gz.tool === 'rotate') {
      const r = nearestPolyline(gz.rings, x, y, RING_HIT_PX);
      return r ? { kind: 'ring', i: r.index } : null;
    }
    const tip = gz.scaleTip;
    // the square of the uniform handle first, then the axis handles (nearest), then the uniform handle's line
    if (Math.hypot(x - tip.x, y - tip.y) <= SCALE_HIT_PX) return { kind: 'scale', i: 0 };
    let best = -1;
    let bestD = STRETCH_HIT_PX;
    for (let a = 0; a < 3; a++) {
      const st = gz.stretchTips[a]!;
      if (!st.ok) continue;
      const d = Math.min(Math.hypot(x - st.x, y - st.y), segDist(x, y, gz.cx, gz.cy, st.x, st.y) + 3);
      if (d <= bestD) {
        best = a;
        bestD = d;
      }
    }
    if (best >= 0) return { kind: 'stretch', i: best };
    return segDist(x, y, gz.cx, gz.cy, tip.x, tip.y) <= 5 ? { kind: 'scale', i: 0 } : null;
  };

  /** the selection box of the blender controls, css px relative to the overlay. null hides it */
  const drawBox = (r: { x0: number; y0: number; x1: number; y1: number } | null) => {
    const el = boxRect.current;
    if (!el) return;
    if (!r) {
      el.style.display = 'none';
      return;
    }
    el.setAttribute('x', String(r.x0));
    el.setAttribute('y', String(r.y0));
    el.setAttribute('width', String(r.x1 - r.x0));
    el.setAttribute('height', String(r.y1 - r.y0));
    el.style.display = '';
  };

  /** leave a copy over what is moved and move the copies. part of the gesture's one undo step */
  const makeCopies = (g: Extract<SceneGesture, { kind: 'axis' }>) => {
    const store = useEditor.getState();
    const project = store.project;
    if (!project) return;
    // blender controls: everything selected is copied in one go, so a copied child stays attached to its copied parent
    const ids =
      useSceneControls.getState().scheme === 'blender'
        ? allTargets(project, store.selection, usePlayback.getState().time, g.rig).map((t) => t.id)
        : [];
    for (const it of g.items) if (!ids.includes(it.id)) ids.push(it.id);
    const copies = new Map<string, string>();
    store.duplicateClips(ids, { sameTime: true, skipHistory: true, copies });
    let made = 0;
    for (const it of g.items) {
      const to = copies.get(it.id);
      if (!to) continue;
      it.id = to;
      made++;
    }
    if (made === 0) g.copy = false;
  };

  /** write a movement in the world to one clip: its own x y z change so that it moves by `D` on screen */
  const writeMove = (it: MoveItem, D: Vec3, eff: number, time: number) => {
    const store = useEditor.getState();
    // a 2d clip moved along z becomes 3d the moment z is the moved axis
    if (it.to3d && eff === 2) {
      store.updateClip(it.id, { threeD: true }, { skipHistory: true });
      it.to3d = false;
    }
    // read again: a z move has just turned a 2d clip into a 3d one
    const now = useEditor.getState().project;
    if (!now) return;
    const raw = now.clips.find((c) => c.id === it.id);
    if (raw && isVisualClip(raw) && isAttached(raw)) {
      if (raw.threeD) {
        // the arrow is a world axis: the world movement along it, in the parent's frame (moved, turned and scaled
        // parents are exact), becomes the clip's own x / y / z. only what really changes is written.
        const l = localDelta3(now, raw, time, D);
        for (let i = 0; i < 3; i++) {
          if (!shouldWriteAxis(i, eff, l[i]!, it.written)) continue;
          it.written[i] = true;
          store.setClipValue(it.id, AXIS_NAMES[i]!, time, Math.round((it.v3[i]! + l[i]!) * 100) / 100, { skipHistory: true });
        }
        return;
      }
      if (eff !== 2) {
        // a 2d clip: x and y follow the parent's turn and scale in the canvas plane
        const l = localDelta(now, raw, time, D[0], D[1]);
        store.setClipValue(it.id, 'x', time, Math.round((it.v3[0]! + l.x) * 100) / 100, { skipHistory: true });
        store.setClipValue(it.id, 'y', time, Math.round((it.v3[1]! + l.y) * 100) / 100, { skipHistory: true });
        it.written[0] = true;
        it.written[1] = true;
        return;
      }
    }
    for (let i = 0; i < 3; i++) {
      if (!shouldWriteAxis(i, eff, D[i]!, it.written)) continue;
      it.written[i] = true;
      store.setClipValue(it.id, AXIS_NAMES[i]!, time, Math.round((it.v3[i]! + D[i]!) * 100) / 100, { skipHistory: true });
    }
  };

  const apply = (snap: PointerSnapshot) => {
    const g = gestureRef.current;
    const store = useEditor.getState();
    const project = store.project;
    const f = viewF.current;
    if (!g || !project || f <= 0) return;
    const dx = snap.x - g.startX;
    const dy = snap.y - g.startY;
    if (g.kind === 'orbit') {
      if (!g.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      g.moved = true;
      useSceneCamera.getState().set({ ...g.o0, yaw: g.o0.yaw + dx * ORBIT_DEG_PER_PX, pitch: g.o0.pitch - dy * ORBIT_DEG_PER_PX });
      return;
    }
    if (g.kind === 'pan') {
      if (!g.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      g.moved = true;
      const rig = cameraRig(toCamera3D(g.o0, project), project.width, project.height);
      // world units per css px at the distance of the target
      const k = (2 * rig.tanHalf * g.o0.distance) / (project.height * f);
      useSceneCamera.getState().set({
        ...g.o0,
        targetX: g.o0.targetX - (rig.right[0] * dx + rig.down[0] * dy) * k,
        targetY: g.o0.targetY - (rig.right[1] * dx + rig.down[1] * dy) * k,
        targetZ: g.o0.targetZ - (rig.right[2] * dx + rig.down[2] * dy) * k,
      });
      return;
    }
    if (g.kind === 'dolly') {
      if (!g.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      g.moved = true;
      useSceneCamera.getState().set({ ...g.o0, distance: clampOrbitDistance(dollyDistance(g.o0.distance, dy), homeDistance(project.height)) });
      return;
    }
    const origin = originRef.current;
    const lx = snap.x - origin.left;
    const ly = snap.y - origin.top;
    if (g.kind === 'box') {
      if (!g.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      g.moved = true;
      drawBox(rectOf(g.startX - origin.left, g.startY - origin.top, lx, ly));
      return;
    }
    if (g.kind === 'ring') {
      // follow the pointer's angle around the projected center step by step (unwrapped, no jump at the branch cut)
      const a = (Math.atan2(ly - g.cy, lx - g.cx) * 180) / Math.PI;
      g.acc += unwrapStep(g.last, a);
      g.last = a;
    }
    if (!g.started) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      g.started = true;
      store.pushHistory();
      // alt: leave a copy over the original and drag the copy (still the same single undo step)
      if (g.kind === 'axis' && g.copy) makeCopies(g);
      // dragging tilt or turn of a 2d clip turns it 3d; a plain click never does (z does it below, once z is the moved axis)
      if (g.kind === 'ring') {
        for (const it of g.items) {
          if (!it.to3d) continue;
          store.updateClip(it.id, { threeD: true }, { skipHistory: true });
          it.to3d = false;
        }
      }
      if (g.kind === 'focus') {
        // a camera that never stored a focus distance draws the home distance: write it down so it can be dragged
        const cam = project.clips.find((c) => c.id === g.id);
        if (cam && cam.type === 'camera' && cam.focusDistance === undefined && !cam.keyframes?.focusDistance?.length) {
          store.updateClip(g.id, { focusDistance: Math.round(g.d0) }, { skipHistory: true });
        }
      }
    }
    const time = modalTime.current ?? usePlayback.getState().time;
    if (g.kind === 'focus') {
      const ray = screenRay(g.rig, lx / f, ly / f, project.width, project.height);
      const t1 = closestOnAxis(ray.origin, ray.dir, g.eye, g.fwd);
      if (t1 === null) return;
      store.setClipValue(g.id, 'focusDistance', time, focusFromDrag(g.d0, g.t0, t1, 1, g.max), { skipHistory: true });
      return;
    }
    // blender controls: a typed number takes over from the pointer ("r 4 5", "g x 1 0 0")
    const typed = typedValue(g.typed);
    if (g.kind === 'ring') {
      const turned = (it: RingItem) => Math.round((typed !== null ? it.v0 + it.sign * typed : snapAngle(it.v0 + it.sign * g.acc, dragCtrl.current, dragShift.current)) * 100) / 100;
      const first = g.items[0];
      if (first) readout.current = rotateReadout(RING_LABELS[g.ring]!, typed ?? turned(first) - first.v0);
      for (const it of g.items) {
        const v = turned(it);
        // g / r / s: a 2d clip becomes 3d once its tilt or turn really changes, not when the key is pressed
        if (it.to3d && v !== it.v0) {
          store.updateClip(it.id, { threeD: true }, { skipHistory: true });
          it.to3d = false;
        }
        store.setClipValue(it.id, g.prop, time, v, { skipHistory: true });
      }
      return;
    }
    if (g.kind === 'scale') {
      // a dragged axis handle counts the pull along its direction, the s key the distance from the center
      const d = g.dir ? axisPull(g.cx, g.cy, g.cx + g.dir.x, g.cy + g.dir.y, lx, ly) : Math.hypot(lx - g.cx, ly - g.cy);
      const prop: ScaleProp = g.lock === null ? 'scale' : STRETCH_PROPS[g.lock];
      // the z stretch only goes to clips that have a depth
      const writes = g.items.filter((it) => g.lock !== 2 || it.depth);
      const first = writes[0];
      if (first) readout.current = scaleReadout(scaledValue(first.v0[prop], g.d0, d, typed, MIN_SCALE, MAX_SCALE) / Math.max(1e-6, first.v0[prop]), g.lock);
      for (const it of writes) {
        store.setClipValue(it.id, prop, time, scaledValue(it.v0[prop], g.d0, d, typed, MIN_SCALE, MAX_SCALE), { skipHistory: true });
        // a lock pressed mid drag: what was written before goes back to the grab value
        for (const p of Array.from(it.written)) {
          if (p === prop) continue;
          store.setClipValue(it.id, p, time, it.v0[p], { skipHistory: true });
          it.written.delete(p);
        }
        it.written.add(prop);
      }
      return;
    }
    // move: an arrow moves along its axis, the center dot (and g) moves freely; x / y / z lock it to one axis
    let eff: number = g.lock ?? g.axis;
    const D: Vec3 = [0, 0, 0];
    if (typed !== null) {
      // the typed number is the distance along the locked axis (x without one)
      if (eff < 0) eff = 0;
      D[eff] = typed;
    } else {
      const ray = screenRay(g.rig, lx / f, ly / f, project.width, project.height);
      if (eff >= 0) {
        const t1 = closestOnAxis(ray.origin, ray.dir, g.c0, AXES[eff]!);
        const t0 = g.t0s[eff];
        if (t1 === null || t0 === null || t0 === undefined) return;
        // ctrl / cmd: the clip lands on a grid line (50 px, 10 with shift) along the moved axis
        D[eff] = snapDelta(g.v3[eff]!, t1 - t0, dragCtrl.current, dragShift.current);
      } else {
        const hit = g.p0 ? rayPlane(ray.origin, ray.dir, g.c0, g.normal) : null;
        if (!hit || !g.p0) return;
        for (let i = 0; i < 3; i++) D[i] = snapDelta(g.v3[i]!, hit[i]! - g.p0[i]!, dragCtrl.current, dragShift.current);
      }
    }
    const mr = moveReadout(D, eff >= 0 ? (eff as AxisLock) : null);
    readout.current = g.copy ? copyReadout(mr) : mr;
    // a 2d clip stays on the canvas plane unless z itself is the moved axis (that turns it 3d)
    for (const it of g.items) writeMove(it, it.to3d && eff !== 2 ? [D[0], D[1], 0] : D, eff, time);
  };

  const queue = (e: { clientX: number; clientY: number; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => {
    pendingRef.current = { x: e.clientX, y: e.clientY };
    lastPointer.current = pendingRef.current;
    dragShift.current = e.shiftKey;
    dragCtrl.current = e.ctrlKey || e.metaKey;
    if (!rafRef.current) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0;
        const snap = pendingRef.current;
        pendingRef.current = null;
        if (snap) apply(snap);
      });
    }
  };

  /** forget the running gesture: its flags, listeners, readout and selection box. what it wrote stays */
  const dropGesture = () => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    pendingRef.current = null;
    lastPointer.current = null;
    gestureRef.current = null;
    keyHook = null;
    modalKeys = null;
    modalOff.current?.();
    modalOff.current = null;
    modalTime.current = null;
    readout.current = '';
    drawBox(null);
    endPreviewGesture();
  };

  /** escape: drop the running drag. a drag that already changed things is undone (its one history step) */
  const cancelGesture = () => {
    const g = gestureRef.current;
    if (!g) return;
    dropGesture();
    const root = rootRef.current;
    if (root && g.pointerId >= 0 && root.hasPointerCapture(g.pointerId)) root.releasePointerCapture(g.pointerId);
    if (g.kind === 'orbit' || g.kind === 'pan' || g.kind === 'dolly') {
      useSceneCamera.getState().set(g.o0);
    } else if (g.kind !== 'box' && g.started) {
      const store = useEditor.getState();
      // only what this drag wrote: a drag that changed nothing must not take back an earlier edit
      store.rollback();
      store.select(selBefore.current.filter((id) => useEditor.getState().project?.clips.some((c) => c.id === id)), 'replace');
    }
    redrawRef.current();
  };

  /* ---------- blender controls: g / r / s without a button held ---------- */

  /** click or enter: keep what the running transform did */
  const finishModal = () => {
    if (!isModal(gestureRef.current)) return;
    cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    const snap = pendingRef.current;
    pendingRef.current = null;
    if (snap) apply(snap);
    dropGesture();
    redrawRef.current();
  };

  const modalKey = (ev: KeyboardEvent, up: boolean) => {
    const cur = gestureRef.current;
    if (!isModal(cur)) return;
    // browser and system keys stay theirs (f5, f12 ...)
    if (ev.metaKey || /^F\d{1,2}$/.test(ev.key)) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    dragShift.current = ev.shiftKey;
    dragCtrl.current = ev.ctrlKey;
    const again = () => {
      const last = lastPointer.current;
      if (last) apply(last);
      redrawRef.current();
    };
    // ctrl and shift change the snapping at once, also without a pointer move
    if (ev.key === 'Control' || ev.key === 'Shift') {
      again();
      return;
    }
    if (up) return;
    if (ev.key === 'Escape') {
      cancelGesture();
      return;
    }
    if (ev.key === 'Enter' || ev.key === ' ') {
      if (!ev.repeat) finishModal();
      return;
    }
    if (ev.ctrlKey || ev.altKey) return;
    const text = typeNumber(cur.typed, ev.key);
    if (text !== null) {
      cur.typed = text;
      again();
      return;
    }
    if (ev.repeat) return;
    const k = lockForKey(ev.key);
    if (k !== null) {
      if (cur.kind === 'axis') {
        cur.lock = nextLock(cur.lock, k);
        again();
      } else if (cur.kind === 'ring') {
        // x tilts, y turns, z rolls. the key of the running one goes back to the roll
        const ring = cur.ring === k ? 2 : k;
        if (ring !== cur.ring) restartModal('rotate', ring);
      } else if (cur.kind === 'scale') {
        // x y z stretch one axis of the clip, the same key again goes back to every side
        const lock = scaleLock(cur.lock, k, cur.items.some((it) => it.depth));
        if (lock !== cur.lock) {
          cur.lock = lock;
          again();
        }
      }
      return;
    }
    // g, r or s while another one runs: that one is taken back and the new one starts
    const key = ev.key.toLowerCase();
    const mode: ModalMode | null = key === 'g' ? 'grab' : key === 'r' ? 'rotate' : key === 's' ? 'scale' : null;
    const now: ModalMode = cur.kind === 'axis' ? 'grab' : cur.kind === 'ring' ? 'rotate' : 'scale';
    if (mode && mode !== now && !(cur.kind === 'axis' && cur.copy)) restartModal(mode);
  };

  /**
   * g, r, s (and shift + d): the selection follows the pointer from where it is now, no button held.
   * `ring`: which turn r starts with (0 tilt, 1 turn, 2 roll).
   */
  const beginModal = (mode: ModalMode, copy = false, ring = 2) => {
    const root = rootRef.current;
    const store = useEditor.getState();
    const project = store.project;
    if (!root || !project || gestureRef.current) return;
    const rect = root.getBoundingClientRect();
    if (rect.width <= 0) return;
    originRef.current = { left: rect.left, top: rect.top };
    viewF.current = rect.width / project.width;
    const f = viewF.current;
    const gz = gizmo.current;
    const target = gz.target;
    const ui = useUi.getState();
    if (!target || !gz.visible) {
      ui.toast('select a clip that is on screen first');
      return;
    }
    // a transform during playback would write a key at every frame that passes: stop, and work at this time
    if (usePlayback.getState().playing) usePlayback.getState().pause();
    const time = usePlayback.getState().time;
    const rig = viewRig(project);
    const targets = writeTargets(project, target, time, rig);
    const p = hoverXY.current ?? { x: rect.left + gz.cx, y: rect.top + gz.cy };
    const lx = p.x - rect.left;
    const ly = p.y - rect.top;
    const base = { pointerId: -1, startX: p.x, startY: p.y, started: true, modal: true, typed: '' };
    let g: Extract<SceneGesture, { modal: boolean }>;
    if (mode === 'grab') {
      const ray = screenRay(rig, lx / f, ly / f, project.width, project.height);
      const t0s = AXES.map((a) => closestOnAxis(ray.origin, ray.dir, target.center, a)) as [number | null, number | null, number | null];
      const normal: Vec3 = target.kind === 'clip' && !target.threeD ? [0, 0, 1] : rig.forward;
      g = {
        kind: 'axis',
        ...base,
        axis: -1,
        lock: null,
        t0s,
        p0: rayPlane(ray.origin, ray.dir, target.center, normal),
        normal,
        c0: target.center,
        v3: [target.v[0], target.v[1], target.v[2]],
        items: targets.map(moveItem),
        rig,
        copy,
      };
      readout.current = copy ? copyReadout(moveReadout([0, 0, 0], null)) : moveReadout([0, 0, 0], null);
    } else if (mode === 'rotate') {
      const items = ringItems(targets, ring, rig.forward);
      if (items.length === 0) {
        ui.toast('a camera only moves here. turn it with pan, tilt and roll in the properties');
        return;
      }
      g = { kind: 'ring', ...base, ring, prop: RING_PROPS[ring]!, cx: gz.cx, cy: gz.cy, last: (Math.atan2(ly - gz.cy, lx - gz.cx) * 180) / Math.PI, acc: 0, items };
      readout.current = rotateReadout(RING_LABELS[ring]!, 0);
    } else {
      const items = scaleItems(targets);
      if (items.length === 0) {
        ui.toast('a camera has no size to scale');
        return;
      }
      g = { kind: 'scale', ...base, cx: gz.cx, cy: gz.cy, d0: Math.max(8, Math.hypot(lx - gz.cx, ly - gz.cy)), items, lock: null, dir: null };
      readout.current = scaleReadout(1);
    }
    selBefore.current = store.selection;
    store.pushHistory();
    gestureRef.current = g;
    modalTime.current = time;
    if (g.kind === 'axis' && g.copy) makeCopies(g);
    beginPreviewGesture();
    lastPointer.current = p;
    useSceneTool.getState().setTool(MODAL_TOOL[mode]);

    // no button is held, so nothing captures the pointer: follow it on the window
    const onMove = (ev: PointerEvent) => {
      hoverXY.current = { x: ev.clientX, y: ev.clientY };
      queue(ev);
    };
    const swallow = (ev: Event) => {
      ev.preventDefault();
      ev.stopPropagation();
    };
    const onDown = (ev: PointerEvent) => {
      // the press that ends the transform must not also press what is under the pointer
      swallow(ev);
      const act = blenderPress({ button: ev.button, shift: ev.shiftKey, ctrl: ev.ctrlKey || ev.metaKey, alt: ev.altKey }, true);
      if (act !== 'confirm' && act !== 'cancel') return;
      // nor may its click or context menu, which come right after the release
      const off = () => {
        window.removeEventListener('click', swallow, true);
        window.removeEventListener('auxclick', swallow, true);
        window.removeEventListener('contextmenu', swallow, true);
        window.removeEventListener('pointerup', onUp, true);
      };
      const onUp = () => window.setTimeout(off, 0);
      window.addEventListener('click', swallow, true);
      window.addEventListener('auxclick', swallow, true);
      window.addEventListener('contextmenu', swallow, true);
      window.addEventListener('pointerup', onUp, true);
      window.setTimeout(off, 5000);
      if (act === 'confirm') finishModal();
      else cancelGesture();
    };
    const onBlur = () => cancelGesture();
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('blur', onBlur);
    modalOff.current = () => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('blur', onBlur);
    };
    modalKeys = modalKey;
    redrawRef.current();
  };

  const restartModal = (mode: ModalMode, ring = 2) => {
    cancelGesture();
    beginModal(mode, false, ring);
  };

  /** alt + g / r / s: put the selection back to the middle, unturned, or to its own size */
  const clearTransform = (kind: 'clear-move' | 'clear-rotate' | 'clear-scale') => {
    const store = useEditor.getState();
    const project = store.project;
    if (!project) return;
    const time = usePlayback.getState().time;
    const targets = allTargets(project, store.selection, time, viewRig(project));
    if (targets.length === 0) return;
    store.pushHistory();
    const o = { skipHistory: true } as const;
    for (const t of targets) {
      if (kind === 'clear-move') {
        store.setClipValue(t.id, 'x', time, 0, o);
        store.setClipValue(t.id, 'y', time, 0, o);
        if (t.kind === 'camera' || t.threeD) store.setClipValue(t.id, 'z', time, 0, o);
      } else if (t.kind === 'clip' && kind === 'clear-rotate') {
        if (t.threeD) {
          store.setClipValue(t.id, 'rotX', time, 0, o);
          store.setClipValue(t.id, 'rotY', time, 0, o);
        }
        store.setClipValue(t.id, 'rotation', time, 0, o);
      } else if (t.kind === 'clip') {
        store.setClipValue(t.id, 'scale', time, 1, o);
        // the stretch goes back too: only the axes that are stretched or keyed get a write
        const raw = project.clips.find((c) => c.id === t.id);
        if (raw && isVisualClip(raw)) {
          for (const p of stretchesToClear(resolveClip(raw, time).transform, raw.keyframes)) store.setClipValue(t.id, p, time, 1, o);
        }
      }
    }
  };

  /** home: everything in the scene in view. nothing in it: the default view */
  const frameAll = () => {
    const project = useEditor.getState().project;
    if (!project) return;
    const time = usePlayback.getState().time;
    const rig = viewRig(project);
    const spheres: Array<{ center: Vec3; radius: number }> = [];
    for (const c of sceneCandidates(project, time).clips) {
      const t = frameTarget(project, c, time, rig);
      if (t) spheres.push(t);
    }
    const all = boundingSphere(spheres);
    if (!all) useSceneCamera.getState().reset();
    else useSceneCamera.getState().set(frameOrbit(currentOrbit(project), all.center, all.radius, project, 0.8));
  };

  const runCommand = (cmd: SceneCommand) => {
    const store = useEditor.getState();
    const project = store.project;
    if (!project) return;
    switch (cmd.kind) {
      case 'grab':
        beginModal('grab');
        break;
      case 'rotate':
        beginModal('rotate');
        break;
      case 'scale':
        beginModal('scale');
        break;
      case 'duplicate':
        beginModal('grab', true);
        break;
      case 'clear-move':
      case 'clear-rotate':
      case 'clear-scale':
        clearTransform(cmd.kind);
        break;
      case 'delete':
        if (store.selection.length > 0) store.deleteClips(store.selection, { ripple: false });
        break;
      case 'select-all': {
        const { camera, clips } = sceneCandidates(project, usePlayback.getState().time);
        const ids = clips.map((c) => c.id);
        if (camera) ids.push(camera);
        if (ids.length > 0) store.select(ids, 'replace');
        break;
      }
      case 'select-none':
        store.clearSelection();
        break;
      case 'frame':
        frameSelected();
        break;
      case 'frame-all':
        frameAll();
        break;
      case 'camera-view':
        viewThroughCamera();
        break;
      case 'camera-to-view':
        cameraToView();
        break;
      case 'view': {
        const o = blenderView(cmd.code, cmd.ctrl, currentOrbit(project));
        if (o) useSceneCamera.getState().set({ ...o, distance: clampOrbitDistance(o.distance, homeDistance(project.height)) });
        break;
      }
    }
  };

  // the keys of the blender controls belong to the scene view while the pointer is over it, like in blender
  useLayoutEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (useSceneControls.getState().scheme !== 'blender' || !inside.current || gestureRef.current) return;
      if (isTypingTarget(ev.target as HTMLElement | null)) return;
      if (useUi.getState().dialog !== null || document.querySelector('.dialog-backdrop')) return;
      const cmd = blenderCommand({ key: ev.key, code: ev.code, shift: ev.shiftKey, ctrl: ev.ctrlKey, alt: ev.altKey, meta: ev.metaKey });
      if (!cmd) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      // a held key only repeats the view steps
      if (ev.repeat && cmd.kind !== 'view') return;
      runCommand(cmd);
    };
    sceneKeys = onKey;
    return () => {
      if (sceneKeys === onKey) sceneKeys = null;
    };
  });

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const root = rootRef.current;
    const project = useEditor.getState().project;
    if (!root || !project || gestureRef.current) return;
    e.preventDefault();
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body) active.blur();
    const rect = root.getBoundingClientRect();
    if (rect.width <= 0) return;
    originRef.current = { left: rect.left, top: rect.top };
    viewF.current = rect.width / project.width;
    const o0 = currentOrbit(project);
    const base = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY };
    dragShift.current = e.shiftKey;
    dragCtrl.current = e.ctrlKey || e.metaKey;

    const begin = (g: SceneGesture) => {
      gestureRef.current = g;
      selBefore.current = useEditor.getState().selection;
      try {
        root.setPointerCapture(e.pointerId);
      } catch {
        // the pointer is already gone: pointerup / lostpointercapture will not come, the next pointerdown starts clean
      }
      beginPreviewGesture();
      // escape cancels the drag; the move tool also takes x / y / z (never while typing in a field)
      keyHook = (ev) => {
        if (isTypingTarget(ev.target as HTMLElement | null)) return;
        if (ev.key === 'Escape') {
          ev.preventDefault();
          ev.stopImmediatePropagation();
          cancelGesture();
          return;
        }
        const k = lockForKey(ev.key);
        if (k === null || g.kind !== 'axis') return;
        ev.preventDefault();
        ev.stopImmediatePropagation();
        if (ev.repeat || gestureRef.current !== g) return;
        g.lock = nextLock(g.lock, k);
        const last = lastPointer.current;
        if (last) apply(last);
      };
    };

    const lx = e.clientX - rect.left;
    const ly = e.clientY - rect.top;

    /** a press on a gizmo handle starts its drag. false = nothing was grabbed. `copy`: the move leaves a copy behind */
    const grabHandle = (h: Hover, copy: boolean): boolean => {
      const target = gizmo.current.target;
      if (h && h.kind === 'focus') {
        // the focus handle of the camera in charge: slide along its view axis
        const fh = focusHandle.current;
        const time = usePlayback.getState().time;
        const camClip = project.clips.find((c) => c.id === fh.id);
        if (camClip && camClip.type === 'camera') {
          const cr = cameraRig(cameraFromClip(camClip, time, project), project.width, project.height);
          const f = viewF.current;
          const rig = viewRig(project);
          const ray = screenRay(rig, lx / f, ly / f, project.width, project.height);
          const t0 = closestOnAxis(ray.origin, ray.dir, cr.eye, cr.forward);
          if (cr.focus && t0 !== null) {
            begin({ kind: 'focus', ...base, started: false, id: camClip.id, eye: cr.eye, fwd: cr.forward, t0, d0: cr.focus.distance, max: fh.max, rig });
            redrawRef.current();
            return true;
          }
        }
        return false;
      }
      if (!h || !target) return false;
      const gz = gizmo.current;
      const rig = viewRig(project);
      const targets = writeTargets(project, target, usePlayback.getState().time, rig);
      if (h.kind === 'axis' || h.kind === 'center') {
        const f = viewF.current;
        const ray = screenRay(rig, lx / f, ly / f, project.width, project.height);
        const t0s = AXES.map((a) => closestOnAxis(ray.origin, ray.dir, target.center, a)) as [number | null, number | null, number | null];
        const normal: Vec3 = target.kind === 'clip' && !target.threeD ? [0, 0, 1] : rig.forward;
        const p0 = h.kind === 'center' ? rayPlane(ray.origin, ray.dir, target.center, normal) : null;
        if (h.kind === 'axis' ? t0s[h.i] === null : p0 === null) return false;
        begin({
          kind: 'axis',
          ...base,
          started: false,
          modal: false,
          typed: '',
          axis: h.kind === 'axis' ? h.i : -1,
          lock: null,
          t0s,
          p0,
          normal,
          c0: target.center,
          v3: [target.v[0], target.v[1], target.v[2]],
          items: targets.map(moveItem),
          rig,
          copy,
        });
        redrawRef.current();
        return true;
      }
      if (h.kind === 'ring') {
        const items = ringItems(targets, h.i, rig.forward);
        if (items.length === 0) return false;
        begin({
          kind: 'ring',
          ...base,
          started: false,
          modal: false,
          typed: '',
          ring: h.i,
          prop: RING_PROPS[h.i]!,
          cx: gz.cx,
          cy: gz.cy,
          last: (Math.atan2(ly - gz.cy, lx - gz.cx) * 180) / Math.PI,
          acc: 0,
          items,
        });
        redrawRef.current();
        return true;
      }
      const items = scaleItems(targets);
      if (items.length === 0) return false;
      if (h.kind === 'stretch') {
        // an axis handle: the pull along its direction on screen, from the center, stretches that axis
        const tip = gz.stretchTips[h.i]!;
        if (!tip.ok) return false;
        const d0 = Math.max(8, axisPull(gz.cx, gz.cy, tip.x, tip.y, lx, ly));
        const l = Math.hypot(tip.x - gz.cx, tip.y - gz.cy) || 1;
        begin({
          kind: 'scale',
          ...base,
          started: false,
          modal: false,
          typed: '',
          cx: gz.cx,
          cy: gz.cy,
          d0,
          items,
          lock: h.i as AxisLock,
          dir: { x: (tip.x - gz.cx) / l, y: (tip.y - gz.cy) / l },
        });
        redrawRef.current();
        return true;
      }
      begin({ kind: 'scale', ...base, started: false, modal: false, typed: '', cx: gz.cx, cy: gz.cy, d0: Math.max(8, Math.hypot(lx - gz.cx, ly - gz.cy)), items, lock: null, dir: null });
      redrawRef.current();
      return true;
    };

    if (useSceneControls.getState().scheme === 'blender') {
      // the middle button turns the view (shift pans, ctrl zooms), the left one works on what is in the scene
      const act = blenderPress({ button: e.button, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey }, false);
      if (act === 'orbit') begin({ kind: 'orbit', ...base, o0, moved: false, click: false });
      else if (act === 'pan') begin({ kind: 'pan', ...base, o0, moved: false, click: false });
      else if (act === 'dolly') begin({ kind: 'dolly', ...base, o0, moved: false, click: false });
      else if (act === 'primary' && !grabHandle(handleAt(lx, ly), false)) begin({ kind: 'box', ...base, moved: false, add: e.shiftKey });
      return;
    }

    if (e.button === 1 || e.button === 2 || (e.button === 0 && e.shiftKey)) {
      begin({ kind: 'pan', ...base, o0, moved: false, click: false });
      return;
    }
    if (e.button !== 0) return;

    const h = handleAt(lx, ly);
    // alt orbits, except on a move handle: there it leaves a copy behind
    const copy = e.altKey && !!h && !!gizmo.current.target && (h.kind === 'axis' || h.kind === 'center');
    if (e.altKey && !copy) {
      begin({ kind: 'orbit', ...base, o0, moved: false, click: false });
      return;
    }
    if (grabHandle(h, copy)) return;
    begin({ kind: 'orbit', ...base, o0, moved: false, click: true });
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    hoverXY.current = { x: e.clientX, y: e.clientY };
    inside.current = true;
    const g = gestureRef.current;
    if (!g) {
      // hover highlight of the gizmo handles. the overlay origin is cached from the last gesture / hover
      const root = rootRef.current;
      if (!root || !gizmo.current.visible) return;
      if (e.movementX === 0 && e.movementY === 0) return;
      const h = handleAt(e.clientX - originRef.current.left, e.clientY - originRef.current.top);
      const cur = hover.current;
      if (h?.kind !== cur?.kind || h?.i !== cur?.i) {
        hover.current = h;
        root.style.cursor = h ? 'pointer' : '';
        redrawRef.current();
      }
      return;
    }
    if (g.pointerId !== e.pointerId) return;
    queue(e);
  };

  // measured once when the pointer arrives (not per move)
  const onPointerEnter = () => {
    inside.current = true;
    const root = rootRef.current;
    if (!root) return;
    const r = root.getBoundingClientRect();
    originRef.current = { left: r.left, top: r.top };
  };

  const onPointerLeave = () => {
    inside.current = false;
    if (hover.current && !gestureRef.current) {
      hover.current = null;
      if (rootRef.current) rootRef.current.style.cursor = '';
      redrawRef.current();
    }
  };

  const endGesture = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gestureRef.current;
    if (!g || g.pointerId !== e.pointerId) return;
    cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    if (e.type === 'pointerup') {
      dragShift.current = e.shiftKey;
      dragCtrl.current = e.ctrlKey || e.metaKey;
      apply({ x: e.clientX, y: e.clientY });
    }
    dropGesture();
    const root = rootRef.current;
    if (root && root.hasPointerCapture(e.pointerId)) root.releasePointerCapture(e.pointerId);
    const store = useEditor.getState();
    const project = store.project;
    const f = viewF.current;
    if (e.type === 'pointerup' && root && project && f > 0) {
      const o = originRef.current;
      const time = usePlayback.getState().time;
      const px = (e.clientX - o.left) / f;
      const py = (e.clientY - o.top) / f;
      if (g.kind === 'orbit' && g.click && !g.moved) {
        // a click (no drag) selects the plane under the pointer, or clears the selection on empty space
        const id = sceneHit(project, time, viewRig(project), px, py, f);
        if (id) store.select([id], 'replace');
        else store.clearSelection();
      } else if (g.kind === 'box' && !g.moved) {
        // blender controls: a click selects, with shift it adds to the selection or takes out of it
        const id = sceneHit(project, time, viewRig(project), px, py, f);
        if (id) store.select([id], g.add ? 'toggle' : 'replace');
        else if (!g.add) store.clearSelection();
      } else if (g.kind === 'box') {
        const ids = boxHits(project, time, viewRig(project), (g.startX - o.left) / f, (g.startY - o.top) / f, px, py);
        if (g.add) {
          if (ids.length > 0) store.select(ids, 'add');
        } else if (ids.length > 0) store.select(ids, 'replace');
        else store.clearSelection();
      }
    }
    redrawRef.current();
  };

  const onWheel = (e: ReactWheelEvent<HTMLDivElement>) => {
    const root = rootRef.current;
    const project = useEditor.getState().project;
    // a running g / r / s works in the view it started in
    if (!root || !project || isModal(gestureRef.current)) return;
    const rect = root.getBoundingClientRect();
    if (rect.width <= 0) return;
    const f = rect.width / project.width;
    const o = currentOrbit(project);
    const d0 = homeDistance(project.height);
    const factor = Math.exp(Math.max(-200, Math.min(200, e.deltaY)) * 0.0015);
    const distance = Math.min(d0 * 60, Math.max(20, o.distance * factor));
    const k = distance / o.distance;
    // keep the point under the pointer where it is: it lies on the plane through the target facing the camera
    const rig = cameraRig(toCamera3D(o, project), project.width, project.height);
    const ray = screenRay(rig, (e.clientX - rect.left) / f, (e.clientY - rect.top) / f, project.width, project.height);
    const along = dot(ray.dir, rig.forward);
    const p: Vec3 = along > 1e-6 ? add(ray.origin, vscale(ray.dir, o.distance / along)) : [o.targetX, o.targetY, o.targetZ];
    useSceneCamera.getState().set({
      ...o,
      targetX: o.targetX + (p[0] - o.targetX) * (1 - k),
      targetY: o.targetY + (p[1] - o.targetY) * (1 - k),
      targetZ: o.targetZ + (p[2] - o.targetZ) * (1 - k),
      distance,
    });
  };

  /** double click: frame the plane under the pointer; on empty space (not on a gizmo handle) reset the view */
  const onDoubleClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    const root = rootRef.current;
    const project = useEditor.getState().project;
    if (!root || !project || e.altKey || e.shiftKey || useSceneControls.getState().scheme !== 'unity') return;
    const rect = root.getBoundingClientRect();
    if (rect.width <= 0) return;
    const f = rect.width / project.width;
    const time = usePlayback.getState().time;
    const rig = viewRig(project);
    const id = sceneHit(project, time, rig, (e.clientX - rect.left) / f, (e.clientY - rect.top) / f, f);
    if (!id) {
      if (!handleAt(e.clientX - rect.left, e.clientY - rect.top)) useSceneCamera.getState().reset();
      return;
    }
    const clip = project.clips.find((c) => c.id === id);
    const t = clip ? frameTarget(project, clip, time, rig) : null;
    if (!t) return;
    useEditor.getState().select([id], 'replace');
    useSceneCamera.getState().set(frameOrbit(currentOrbit(project), t.center, t.radius, project, 0.8));
  };

  const stop = (e: { stopPropagation(): void }) => e.stopPropagation();

  return (
    <div
      ref={rootRef}
      className="preview-overlay scene-overlay"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onPointerUp={endGesture}
      onPointerCancel={endGesture}
      onLostPointerCapture={endGesture}
      onWheel={onWheel}
      onDoubleClick={onDoubleClick}
      onContextMenu={(e) => e.preventDefault()}
    >
      <svg className="scene-svg" aria-hidden="true">
        <path ref={gridPath} className="scene-grid" style={{ display: 'none' }} />
        <path ref={axisXPath} className="scene-grid-axis" style={{ display: 'none' }} />
        <path ref={axisZPath} className="scene-grid-axis" style={{ display: 'none' }} />
        <polygon
          className="scene-focus-range"
          style={{ display: 'none' }}
          ref={(n) => {
            focusPoly.current[1] = n;
          }}
        />
        <polygon
          className="scene-focus-range"
          style={{ display: 'none' }}
          ref={(n) => {
            focusPoly.current[2] = n;
          }}
        />
        <polygon
          className="scene-focus"
          style={{ display: 'none' }}
          ref={(n) => {
            focusPoly.current[0] = n;
          }}
        />
        <text ref={focusLabel} className="scene-focus-label" style={{ display: 'none' }} />
        <g ref={polyGroup} />
        <g ref={linkGroup} />
        <g ref={lookGroup} />
        <line ref={targetUnder} className="scene-target-under" style={{ display: 'none' }} />
        <line ref={targetLine} className="scene-target-line" style={{ display: 'none' }} />
        {AXIS_NAMES.map((name, a) => (
          <g
            key={name}
            className="scene-axis"
            ref={(n) => {
              axisGroup.current[a] = n;
            }}
          >
            <line
              className="scene-axis-under"
              ref={(n) => {
                axisUnder.current[a] = n;
              }}
            />
            <line
              className="scene-axis-line"
              ref={(n) => {
                axisLine.current[a] = n;
              }}
            />
            <rect
              className="scene-axis-tip"
              width="8"
              height="8"
              ref={(n) => {
                axisTip.current[a] = n;
              }}
            />
            <text
              className="scene-axis-label"
              textAnchor="middle"
              ref={(n) => {
                axisText.current[a] = n;
              }}
            >
              {name}
            </text>
          </g>
        ))}
        {RING_LABELS.map((name, a) => (
          <g
            key={name}
            className="scene-ring"
            style={{ display: 'none' }}
            ref={(n) => {
              ringGroup.current[a] = n;
            }}
          >
            <polyline
              className="scene-ring-under"
              ref={(n) => {
                ringUnder.current[a] = n;
              }}
            />
            <polyline
              className="scene-ring-line"
              ref={(n) => {
                ringLine.current[a] = n;
              }}
            />
            <text
              className="scene-axis-label"
              ref={(n) => {
                ringText.current[a] = n;
              }}
            >
              {name}
            </text>
          </g>
        ))}
        {AXIS_NAMES.map((name, a) => (
          <g
            key={`stretch-${name}`}
            className="scene-scale"
            style={{ display: 'none' }}
            ref={(n) => {
              stretchGroup.current[a] = n;
            }}
          >
            <line
              className="scene-axis-under"
              ref={(n) => {
                stretchUnder.current[a] = n;
              }}
            />
            <line
              className="scene-axis-line"
              ref={(n) => {
                stretchLine.current[a] = n;
              }}
            />
            <rect
              className="scene-axis-tip"
              width="8"
              height="8"
              ref={(n) => {
                stretchRect.current[a] = n;
              }}
            />
            <text
              className="scene-axis-label"
              textAnchor="middle"
              ref={(n) => {
                stretchText.current[a] = n;
              }}
            >
              {name}
            </text>
          </g>
        ))}
        <g ref={scaleGroup} className="scene-scale" style={{ display: 'none' }}>
          <line ref={scaleUnder} className="scene-axis-under" />
          <line ref={scaleLine} className="scene-axis-line" />
          <rect ref={scaleRect} className="scene-axis-tip" width="10" height="10" />
        </g>
        <circle ref={centerDot} className="scene-center" r="3" />
        <rect ref={boxRect} className="scene-box" style={{ display: 'none' }} />
        <text ref={readoutEl} className="scene-readout" style={{ display: 'none' }} />
      </svg>
      <div ref={focusHandleEl} className="scene-focus-handle" style={{ display: 'none' }} role="img" aria-label="focus distance handle" />
      <div className="scene-tools" role="group" aria-label="scene tool" onPointerDown={stop} onDoubleClick={stop} onWheel={stop} onContextMenu={stop}>
        {TOOLS.map(({ tool: t, label, key, Icon, hint }) => (
          <button
            key={t}
            type="button"
            className={`icon-btn icon-btn-sm${tool === t ? ' is-active' : ''}`}
            title={scheme === 'unity' ? `${label} (${key}): ${hint}` : `${label}: ${hint}`}
            aria-label={label}
            aria-pressed={tool === t}
            onClick={() => setTool(t)}
          >
            <Icon size={14} />
          </button>
        ))}
        <button
          type="button"
          className={`icon-btn icon-btn-sm${gridOn ? ' is-active' : ''}`}
          title={gridOn ? 'hide the floor grid and axis lines' : 'show the floor grid and axis lines (x right, z away)'}
          aria-label="floor grid"
          aria-pressed={gridOn}
          onClick={toggleGrid}
        >
          <Grid3x3 size={14} />
        </button>
      </div>
      <div className="preview-scene-hint">{SCENE_HINTS[scheme]}</div>
    </div>
  );
}
