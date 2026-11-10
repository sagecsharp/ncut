/**
 * overlay of the scene view: orbit / pan / dolly navigation of the free editor camera, click to select a
 * 3d plane, and a gizmo for the selected clip or camera clip with three tools:
 * move (x, y, z arrows), rotate (three rings: tilt, turn, roll) and scale (one handle).
 *
 * like the output overlay nothing renders per frame in react: the svg is rewritten imperatively from store
 * subscriptions, and pointer moves are coalesced to one update per animation frame.
 */
import { useLayoutEffect, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent, WheelEvent as ReactWheelEvent } from 'react';
import { Maximize2, Move, RotateCw } from 'lucide-react';
import { getClipBox, visibleClipsAt } from '../../engine/draw';
import { parentModelMatrix } from '../../engine/parent';
import { type CameraRig, cameraClipAt, cameraRig, homeDistance, projectPoint, screenRay } from '../../engine/scene3d/camera';
import { type Vec3, add, dot, scale as vscale } from '../../engine/scene3d/math';
import { resolveClip } from '../../lib/anim';
import { parentOf } from '../../lib/links';
import { clipEnd } from '../../lib/timelineOps';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import type { Project } from '../../types';
import { isVisualClip } from '../../types';
import { isAttached, localDelta, localDelta3, worldClip } from './attached';
import { beginPreviewGesture, endPreviewGesture } from './gesture';
import { type Quad, asScenePlane, clipQuad, closestOnAxis, rayQuad, sceneCenter, segDist, unwrapStep, usesParentFrame, worldCenter3d } from './overlayMath';
import { type Orbit, currentOrbit, frameOrbit, toCamera3D, useSceneCamera } from './sceneCamera';
import { RING_LABELS, RING_PROPS, type RingProp, type SceneTool, nearestPolyline, ringAxes, ringPoints, ringValueSign, scaleFromDrag } from './sceneGizmo';
import { useSceneTool } from './sceneTool';
import { frameTarget, viewRig } from './sceneViews';

const GIZMO_PX = 84;
const AXIS_HIT_PX = 8;
const RING_HIT_PX = 7;
const SCALE_HIT_PX = 11;
/** the scale handle sits this far up and to the right of the clip center, css px */
const SCALE_OFFSET_PX = 60;
const CAMERA_HIT_PX = 12;
const DRAG_THRESHOLD_PX = 3;
const ORBIT_DEG_PER_PX = 0.3;
const MIN_SCALE = 0.01;
const MAX_SCALE = 100;
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
  { tool: 'scale', label: 'scale', key: 'r', Icon: Maximize2, hint: 'drag the square away from the center to grow' },
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
  /** world axes of the tilt, turn and roll rings */
  axes: [Vec3, Vec3, Vec3];
}

type Hover = { kind: 'axis' | 'ring' | 'scale'; i: number } | null;

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
  target: Target | null;
}

type SceneGesture =
  | { kind: 'orbit'; pointerId: number; startX: number; startY: number; o0: Orbit; moved: boolean; click: boolean }
  | { kind: 'pan'; pointerId: number; startX: number; startY: number; o0: Orbit; moved: boolean; click: boolean }
  | {
      kind: 'axis';
      pointerId: number;
      startX: number;
      startY: number;
      started: boolean;
      axis: number;
      id: string;
      t0: number;
      c0: Vec3;
      v0: number;
      /** own x / y at the grab: an attached clip writes both so it follows a world axis exactly */
      x0: number;
      y0: number;
      z0: number;
      rig: CameraRig;
      /** a 2d clip dragged along z becomes 3d when the drag really starts */
      to3d: boolean;
    }
  | {
      kind: 'ring';
      pointerId: number;
      startX: number;
      startY: number;
      started: boolean;
      ring: number;
      prop: RingProp;
      id: string;
      v0: number;
      /** projected center, css px relative to the overlay */
      cx: number;
      cy: number;
      /** pointer angle at the last step, degrees */
      last: number;
      /** unwrapped clockwise pointer rotation since the grab, degrees */
      acc: number;
      /** value change per clockwise degree */
      sign: 1 | -1;
      to3d: boolean;
    }
  | { kind: 'scale'; pointerId: number; startX: number; startY: number; started: boolean; id: string; cx: number; cy: number; d0: number; s0: number };

interface PointerSnapshot {
  x: number;
  y: number;
}

const inRange = (c: { start: number; duration: number }, time: number) => time >= c.start - 1e-6 && time < clipEnd(c) - 1e-6;

/** the selected clip the gizmo works on: the first selected visual clip or camera clip that is active now */
function gizmoTarget(project: Project, selection: string[], time: number, rig: CameraRig): Target | null {
  for (const id of selection) {
    const clip = project.clips.find((c) => c.id === id);
    if (!clip || !inRange(clip, time)) continue;
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
        axes: AXES as [Vec3, Vec3, Vec3],
      };
    }
    if (isVisualClip(clip)) {
      // the gizmo sits at the world pose (an attached clip is drawn there); the values it edits stay the clip's own
      const r = resolveClip(clip, time);
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
          axes: ringAxes(getClipBox(project, r), { x: r.transform.x, y: r.transform.y, z: r.transform.z ?? 0, rotX: r.transform.rotX ?? 0, rotY: r.transform.rotY ?? 0 }, clip.lookAt, rig.eye, parent),
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
        axes: ringAxes(box, { z, rotX, rotY }, threeD ? clip.lookAt : undefined, rig.eye),
      };
    }
  }
  return null;
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
  const centerDot = useRef<SVGCircleElement>(null);
  const targetUnder = useRef<SVGLineElement>(null);
  const targetLine = useRef<SVGLineElement>(null);
  /** some camera clip has a target: the time subscription keeps its line fresh even without a selection */
  const hasTargetCam = useRef(false);
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
    target: null,
  });
  const hover = useRef<Hover>(null);
  const gestureRef = useRef<SceneGesture | null>(null);
  const pendingRef = useRef<PointerSnapshot | null>(null);
  const rafRef = useRef(0);
  const originRef = useRef({ left: 0, top: 0 });
  /** shift held at the last pointer event (rings snap to 15 degree steps) */
  const dragShift = useRef(false);
  const tool = useSceneTool((s) => s.tool);
  const setTool = useSceneTool((s) => s.setTool);

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
          const tr = resolveClip(tClip, time);
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

      // a handle is "hover" under the pointer and "active" while it is being dragged
      const g = gestureRef.current;
      const hv = hover.current;
      const stateOf = (kind: 'axis' | 'ring' | 'scale', i: number): [boolean, boolean] => {
        if (g) {
          const act = (g.kind === 'axis' && kind === 'axis' && g.axis === i) || (g.kind === 'ring' && kind === 'ring' && g.ring === i) || (g.kind === 'scale' && kind === 'scale');
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

      // scale: one handle
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
      }
    };
    redrawRef.current = redraw;

    let lastW = 0;
    const measure = (w: number) => {
      lastW = w;
      const project = useEditor.getState().project;
      viewF.current = project && project.width > 0 ? w / project.width : 0;
      redraw();
    };
    const ro = new ResizeObserver((entries) => {
      const e = entries[0];
      if (e) measure(e.contentRect.width);
    });
    ro.observe(root);

    const unEditor = useEditor.subscribe((s, p) => {
      if (s.project && p.project && s.project.width !== p.project.width && lastW > 0) measure(lastW);
      else if (s.project !== p.project || s.selection !== p.selection) redraw();
    });
    const unTime = usePlayback.subscribe((s, p) => {
      if (s.time !== p.time && (hasTargetCam.current || useEditor.getState().selection.length > 0)) redraw();
    });
    const unCam = useSceneCamera.subscribe(redraw);
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
      unTool();
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
    if (!gz.visible || !gz.target) return null;
    if (gz.tool === 'move') {
      const a = nearestAxis(x, y);
      return a >= 0 ? { kind: 'axis', i: a } : null;
    }
    if (gz.tool === 'rotate') {
      const r = nearestPolyline(gz.rings, x, y, RING_HIT_PX);
      return r ? { kind: 'ring', i: r.index } : null;
    }
    const tip = gz.scaleTip;
    const hit = Math.hypot(x - tip.x, y - tip.y) <= SCALE_HIT_PX || segDist(x, y, gz.cx, gz.cy, tip.x, tip.y) <= 5;
    return hit ? { kind: 'scale', i: 0 } : null;
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
    const origin = originRef.current;
    const lx = snap.x - origin.left;
    const ly = snap.y - origin.top;
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
      // dragging z, tilt or turn of a 2d clip turns it 3d; a plain click never does
      if ((g.kind === 'axis' || g.kind === 'ring') && g.to3d) store.updateClip(g.id, { threeD: true }, { skipHistory: true });
    }
    const time = usePlayback.getState().time;
    if (g.kind === 'ring') {
      let v = g.v0 + g.sign * g.acc;
      if (dragShift.current) v = Math.round(v / 15) * 15;
      store.setClipValue(g.id, g.prop, time, Math.round(v * 100) / 100, { skipHistory: true });
      return;
    }
    if (g.kind === 'scale') {
      const d = Math.hypot(lx - g.cx, ly - g.cy);
      const s = scaleFromDrag(g.s0, g.d0, d, MIN_SCALE, MAX_SCALE);
      store.setClipValue(g.id, 'scale', time, Math.round(s * 1000) / 1000, { skipHistory: true });
      return;
    }
    // axis drag
    const ray = screenRay(g.rig, lx / f, ly / f, project.width, project.height);
    const t1 = closestOnAxis(ray.origin, ray.dir, g.c0, AXES[g.axis]!);
    if (t1 === null) return;
    const delta = t1 - g.t0;
    // read again: the first step of a z drag has just turned a 2d clip into a 3d one
    const now = useEditor.getState().project ?? project;
    const raw = now.clips.find((c) => c.id === g.id);
    if (raw && isVisualClip(raw) && isAttached(raw)) {
      if (raw.threeD) {
        // the arrow is a world axis: the world movement along it, in the parent's frame (moved, turned and scaled
        // parents are exact), becomes the clip's own x / y / z. only what really changes is written.
        const d: Vec3 = [0, 0, 0];
        d[g.axis] = delta;
        const l = localDelta3(now, raw, time, d);
        const start = [g.x0, g.y0, g.z0];
        for (let i = 0; i < 3; i++) {
          if (i !== g.axis && Math.abs(l[i]!) < 1e-9) continue;
          store.setClipValue(g.id, AXIS_NAMES[i]!, time, Math.round((start[i]! + l[i]!) * 100) / 100, { skipHistory: true });
        }
        return;
      }
      if (g.axis < 2) {
        // a 2d clip: x and y follow the parent's turn and scale in the canvas plane
        const l = localDelta(now, raw, time, g.axis === 0 ? delta : 0, g.axis === 1 ? delta : 0);
        store.setClipValue(g.id, 'x', time, Math.round((g.x0 + l.x) * 100) / 100, { skipHistory: true });
        store.setClipValue(g.id, 'y', time, Math.round((g.y0 + l.y) * 100) / 100, { skipHistory: true });
        return;
      }
    }
    store.setClipValue(g.id, AXIS_NAMES[g.axis]!, time, Math.round((g.v0 + delta) * 100) / 100, { skipHistory: true });
  };

  const queue = (e: ReactPointerEvent<HTMLDivElement>) => {
    pendingRef.current = { x: e.clientX, y: e.clientY };
    dragShift.current = e.shiftKey;
    if (!rafRef.current) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0;
        const snap = pendingRef.current;
        pendingRef.current = null;
        if (snap) apply(snap);
      });
    }
  };

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

    const begin = (g: SceneGesture) => {
      gestureRef.current = g;
      root.setPointerCapture(e.pointerId);
      beginPreviewGesture();
    };

    if (e.button === 1 || e.button === 2 || (e.button === 0 && e.shiftKey)) {
      begin({ kind: 'pan', ...base, o0, moved: false, click: false });
      return;
    }
    if (e.button !== 0) return;
    if (e.altKey) {
      begin({ kind: 'orbit', ...base, o0, moved: false, click: false });
      return;
    }

    const lx = e.clientX - rect.left;
    const ly = e.clientY - rect.top;
    const h = handleAt(lx, ly);
    const target = gizmo.current.target;
    if (h && target) {
      const gz = gizmo.current;
      const rig = viewRig(project);
      if (h.kind === 'axis') {
        const f = viewF.current;
        const ray = screenRay(rig, lx / f, ly / f, project.width, project.height);
        const t0 = closestOnAxis(ray.origin, ray.dir, target.center, AXES[h.i]!);
        if (t0 !== null) {
          begin({ kind: 'axis', ...base, started: false, axis: h.i, id: target.id, t0, c0: target.center, v0: target.v[h.i]!, x0: target.v[0], y0: target.v[1], z0: target.v[2], rig, to3d: target.kind === 'clip' && !target.threeD && h.i === 2 });
          redrawRef.current();
          return;
        }
      } else if (h.kind === 'ring') {
        const prop = RING_PROPS[h.i]!;
        begin({
          kind: 'ring',
          ...base,
          started: false,
          ring: h.i,
          prop,
          id: target.id,
          v0: target.rot[h.i]!,
          cx: gz.cx,
          cy: gz.cy,
          last: (Math.atan2(ly - gz.cy, lx - gz.cx) * 180) / Math.PI,
          acc: 0,
          sign: ringValueSign(prop, target.axes[h.i]!, rig.forward),
          to3d: target.kind === 'clip' && !target.threeD && h.i < 2,
        });
        redrawRef.current();
        return;
      } else {
        begin({
          kind: 'scale',
          ...base,
          started: false,
          id: target.id,
          cx: gz.cx,
          cy: gz.cy,
          d0: Math.max(8, Math.hypot(lx - gz.cx, ly - gz.cy)),
          s0: target.scale,
        });
        redrawRef.current();
        return;
      }
    }
    begin({ kind: 'orbit', ...base, o0, moved: false, click: true });
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
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
    const root = rootRef.current;
    if (!root) return;
    const r = root.getBoundingClientRect();
    originRef.current = { left: r.left, top: r.top };
  };

  const onPointerLeave = () => {
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
      apply({ x: e.clientX, y: e.clientY });
    }
    pendingRef.current = null;
    gestureRef.current = null;
    endPreviewGesture();
    const root = rootRef.current;
    if (root && root.hasPointerCapture(e.pointerId)) root.releasePointerCapture(e.pointerId);
    // a click (no drag) selects the plane under the pointer, or clears the selection on empty space
    if (g.kind === 'orbit' && g.click && !g.moved && e.type === 'pointerup' && root) {
      const store = useEditor.getState();
      const project = store.project;
      const f = viewF.current;
      if (project && f > 0) {
        const o = originRef.current;
        const id = sceneHit(project, usePlayback.getState().time, viewRig(project), (e.clientX - o.left) / f, (e.clientY - o.top) / f, f);
        if (id) store.select([id], 'replace');
        else store.clearSelection();
      }
    }
    redrawRef.current();
  };

  const onWheel = (e: ReactWheelEvent<HTMLDivElement>) => {
    const root = rootRef.current;
    const project = useEditor.getState().project;
    if (!root || !project) return;
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
    if (!root || !project || e.altKey || e.shiftKey) return;
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
      onWheel={onWheel}
      onDoubleClick={onDoubleClick}
      onContextMenu={(e) => e.preventDefault()}
    >
      <svg className="scene-svg" aria-hidden="true">
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
        <g ref={scaleGroup} className="scene-scale" style={{ display: 'none' }}>
          <line ref={scaleUnder} className="scene-axis-under" />
          <line ref={scaleLine} className="scene-axis-line" />
          <rect ref={scaleRect} className="scene-axis-tip" width="10" height="10" />
        </g>
        <circle ref={centerDot} className="scene-center" r="3" />
      </svg>
      <div className="scene-tools" role="group" aria-label="scene tool" onPointerDown={stop} onDoubleClick={stop} onWheel={stop} onContextMenu={stop}>
        {TOOLS.map(({ tool: t, label, key, Icon, hint }) => (
          <button
            key={t}
            type="button"
            className={`icon-btn icon-btn-sm${tool === t ? ' is-active' : ''}`}
            title={`${label} (${key}): ${hint}`}
            aria-label={label}
            aria-pressed={tool === t}
            onClick={() => setTool(t)}
          >
            <Icon size={14} />
          </button>
        ))}
      </div>
      <div className="preview-scene-hint">drag: orbit   shift drag: pan   wheel: zoom   w e r: tool   f: frame</div>
    </div>
  );
}
