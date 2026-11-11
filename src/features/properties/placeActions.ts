/**
 * store side of the 3d placement helpers (place3d.ts has the math). every action is ONE undo step:
 * pushHistory() once (or the history step of addCamera), then { skipHistory: true } on each store call.
 * values go through setClipValue at the playhead, so a keyframed value gets a key and the others a static value.
 * an action that would change nothing (or whose writes would all be refused) pushes no history at all.
 */
import { getClipBox } from '../../engine/draw';
import { parentModelMatrix } from '../../engine/parent';
import { DEFAULT_FOV, cameraAt, cameraClipAt, cameraRig } from '../../engine/scene3d/camera';
import { valueAt } from '../../lib/anim';
import { clamp } from '../../lib/time';
import { useEditor } from '../../store/editorStore';
import type { Vec3 } from '../../engine/scene3d/math';
import { usePlayback } from '../../store/playback';
import { useUi } from '../../store/ui';
import type { Project, Transform, VisualClip } from '../../types';
import { isVisualClip } from '../../types';
import { resolveShown } from '../preview/attached';
import {
  axesOf,
  flatDistance,
  floorCenterY,
  frameCamera,
  frameMatrix,
  frameScale,
  placeInFront,
  poseFromWorld,
  tiltedAxes,
  worldMatrix,
} from './place3d';
import { solidDepthOf } from './place3d';
import type { PoseValues } from './place3d';

const SKIP = { skipHistory: true } as const;
const round2 = (n: number) => {
  const r = Math.round(n * 100) / 100;
  return r === 0 ? 0 : r;
};

function toast(message: string): void {
  useUi.getState().toast(message);
}

/** the playhead held inside a clip (what the transform fields and keyframes use) */
function timeIn(clip: { start: number; duration: number }): number {
  return clamp(usePlayback.getState().time, clip.start, clip.start + clip.duration);
}

interface Target {
  clip: VisualClip;
  t: number;
  /** the clip with keyframes baked in at t (a counter text with its running number, so boxes match what is drawn) */
  now: VisualClip;
  parent: Float64Array | Float32Array | null;
  pose: PoseValues;
  /** world frame of the clip's own values (motions are not part of it) */
  frame: Float64Array;
}

function poseOf(tf: Transform): PoseValues {
  return { x: tf.x, y: tf.y, z: tf.z ?? 0, rotX: tf.rotX ?? 0, rotY: tf.rotY ?? 0, rotation: tf.rotation, scale: tf.scale };
}

/** selected visual clips on unlocked tracks, with their frames at the playhead. `locked` counts the rest. */
function targetsOf(project: Project, ids: readonly string[]): { list: Target[]; locked: number } {
  const lockedTracks = new Set(project.tracks.filter((t) => t.locked).map((t) => t.id));
  const list: Target[] = [];
  let locked = 0;
  for (const c of project.clips) {
    if (!ids.includes(c.id) || !isVisualClip(c)) continue;
    if (lockedTracks.has(c.trackId)) {
      locked++;
      continue;
    }
    const t = timeIn(c);
    const now = resolveShown(c, t);
    const parent = parentModelMatrix(project, c, t);
    const pose = poseOf(now.transform);
    list.push({ clip: c, t, now, parent, pose, frame: frameMatrix(parent, project.width, project.height, pose, !!now.threeD) });
  }
  return { list, locked };
}

type PoseProp = 'x' | 'y' | 'z' | 'rotX' | 'rotY' | 'rotation' | 'scale';

/** the pose values that differ from the current ones (so a keyframed value only gets a key where it changes) */
function poseChanges(cur: PoseValues, next: PoseValues, withScale: boolean): [PoseProp, number][] {
  const out: [PoseProp, number][] = [];
  for (const k of ['x', 'y', 'z', 'rotX', 'rotY', 'rotation'] as const) {
    const v = round2(next[k]);
    if (Math.abs(v - cur[k]) > 1e-4) out.push([k, v]);
  }
  if (withScale && Math.abs(next.scale - cur.scale) > 1e-6) out.push(['scale', Math.round(next.scale * 1e4) / 1e4]);
  return out;
}

interface Plan {
  it: Target;
  changes: [PoseProp, number][];
  /** the clip still has to become 3d */
  make: boolean;
  /** the clip faces something, which would override the rotation: switch that off */
  unlook: boolean;
}

function planOf(it: Target, next: PoseValues, opts: { withScale: boolean; make3d?: boolean; unlook?: boolean }): Plan {
  return {
    it,
    changes: poseChanges(it.pose, next, opts.withScale),
    make: (opts.make3d ?? true) && !it.now.threeD,
    unlook: !!opts.unlook && it.now.threeD === true && (it.now.lookAt ?? 'none') !== 'none',
  };
}

/** one undo step for the plans that change something. returns how many clips change (0 = nothing was pushed). */
function commit(plans: readonly Plan[]): number {
  const todo = plans.filter((p) => p.changes.length > 0 || p.make || p.unlook);
  if (todo.length === 0) return 0;
  const st = useEditor.getState();
  st.pushHistory();
  for (const pl of todo) {
    const c = pl.it.clip;
    if (pl.make) st.updateClip(c.id, { threeD: true }, SKIP);
    if (pl.unlook) st.updateClip(c.id, { lookAt: 'none' }, SKIP);
    for (const [k, v] of pl.changes) st.setClipValue(c.id, k, pl.it.t, v, SKIP);
  }
  return todo.length;
}

function skippedToast(n: number): void {
  toast(`${n === 1 ? 'a clip was' : `${n} clips were`} left out: the clip it is attached to cannot place it`);
}

function makeThreeD(clip: VisualClip): void {
  if (!clip.threeD) useEditor.getState().updateClip(clip.id, { threeD: true }, SKIP);
}

/**
 * move the clips into the camera's view at the playhead: centered, turned to face the camera, 3d on.
 * a flat clip gets the distance where it keeps its 2d size, a 3d clip keeps its distance from the camera.
 * several clips keep their offsets. an attached clip is placed in world space through its parent.
 * returns how many clips were placed.
 */
export function putInFrontOfCamera(ids: readonly string[]): number {
  const st = useEditor.getState();
  const p = st.project;
  if (!p) return 0;
  const { list, locked } = targetsOf(p, ids);
  if (locked > 0) toast('clips on locked tracks were left out');
  if (list.length === 0) return 0;
  const cam = cameraAt(p, usePlayback.getState().time);
  const rig = cameraRig(cam, p.width, p.height);
  const flat = flatDistance(cam.fov, p.height);
  const centers = placeInFront(
    rig,
    list.map((it) => {
      const a = axesOf(it.frame);
      return { center: a.center, keepDepth: !!it.now.threeD };
    }),
    flat,
  );
  const plans: Plan[] = [];
  let skipped = 0;
  list.forEach((it, i) => {
    const scale = frameScale(it.frame);
    const next = poseFromWorld(it.parent, p.width, p.height, worldMatrix(centers[i]!, rig.right, rig.down, rig.forward, scale));
    if (next) plans.push(planOf(it, next, { withScale: !!it.parent }));
    else skipped++;
  });
  if (skipped > 0) skippedToast(skipped);
  if (plans.length === 0) return 0;
  // clips that already sit there write nothing and make no undo step
  commit(plans);
  return plans.length;
}

/** world size of a visual clip at its playhead time: the clip box (counter resolved) times the scale its parents add */
function worldSize(p: Project, it: Target): { w: number; h: number } {
  const box = getClipBox(p, it.now);
  const extra = it.parent ? frameScale(it.parent) : 1;
  return { w: box.width * extra, h: box.height * extra };
}

/** thickness of a 3d solid along its normal in the world (0 for a plane or a flat clip), like engine/draw.ts planeFor picks it */
function solidDepth(it: Target, size: { w: number; h: number }): number {
  const extra = it.parent ? frameScale(it.parent) : 1;
  return solidDepthOf(it.now, size, extra);
}

/**
 * move the camera clip in charge at the playhead so the clip fills about 80% of the frame, seen straight on
 * from its front side (x / y / z, pan / tilt / roll). no camera clip there: one is made on a new camera track
 * for the length of the clip. the clip turns 3d (a flat clip is not seen through the camera). one undo step.
 * a camera on a locked track is not touched: nothing happens and the clip stays as it is.
 */
export function frameWithCamera(id: string): boolean {
  const st = useEditor.getState();
  const p = st.project;
  if (!p) return false;
  const { list } = targetsOf(p, [id]);
  const it = list[0];
  if (!it) {
    toast('this clip is on a locked track');
    return false;
  }
  const now = usePlayback.getState().time;
  const existing = cameraClipAt(p, now);
  if (existing && p.tracks.find((t) => t.id === existing.trackId)?.locked) {
    // every write would be refused: no undo step, no 3d, no wrong toast
    toast('the camera is on a locked track');
    return false;
  }
  const fov = existing ? (valueAt(existing, 'fov', clamp(now, existing.start, existing.start + existing.duration)) ?? existing.fov) : DEFAULT_FOV;
  const ax = axesOf(it.frame);
  // a clip that always faces the camera is seen straight on from anywhere: use the un-turned axes
  const upright = it.now.threeD && (it.now.lookAt ?? 'none') === 'none';
  const right: Vec3 = upright ? ax.right : [1, 0, 0];
  const down: Vec3 = upright ? ax.down : [0, 1, 0];
  const normal: Vec3 = upright ? ax.normal : [0, 0, 1];
  const size = worldSize(p, it);
  const v = frameCamera(ax.center, right, down, normal, size.w, size.h, fov, p.width, p.height);
  if (![v.x, v.y, v.z, v.pan, v.tilt, v.roll].every(Number.isFinite)) return false;
  const wanted = [
    ['x', v.x],
    ['y', v.y],
    ['z', v.z],
    ['pan', v.pan],
    ['tilt', v.tilt],
    ['roll', v.roll],
  ] as const;

  let camId: string;
  if (existing) {
    camId = existing.id;
    const tc0 = clamp(now, existing.start, existing.start + existing.duration);
    const differs = wanted.some(([prop, val]) => Math.abs((valueAt(existing, prop, tc0) ?? 0) - round2(val)) > 1e-4);
    if (!differs && !existing.target && it.now.threeD) return true; // already framed: nothing to undo
    st.pushHistory();
  } else {
    // the new camera's own undo step covers the writes below
    camId = st.addCamera({ start: it.clip.start, duration: it.clip.duration });
    if (!camId) {
      toast('could not add a camera here');
      return false;
    }
  }
  const after = useEditor.getState();
  const cam = after.project?.clips.find((c) => c.id === camId);
  if (!cam || cam.type !== 'camera') return false;
  let cleared = false;
  if (cam.target) {
    // a target makes the camera aim at that clip and fight the framing
    after.updateClip(camId, { target: null }, SKIP);
    const again = useEditor.getState().project?.clips.find((c) => c.id === camId);
    cleared = !!again && again.type === 'camera' && !again.target;
  }
  const tc = clamp(now, cam.start, cam.start + cam.duration);
  for (const [prop, val] of wanted) after.setClipValue(camId, prop, tc, round2(val), SKIP);
  makeThreeD(it.clip);
  after.select([it.clip.id]); // addCamera selects the new camera: keep the clip selected
  if (cleared) toast('the camera had a target: cleared it so it can frame the clip');
  return true;
}

/**
 * tilt every selected clip to a fixed angle (3d on): 90 = lying flat like a floor, 0 = standing.
 * the tilt is a WORLD tilt: an attached clip goes through its parent, so it is flat in the world too.
 * a clip with lookAt stops facing (that would override the tilt). a clip that already has the tilt is
 * left alone and makes no undo step.
 */
function setTilt(ids: readonly string[], angle: number): number {
  const st = useEditor.getState();
  const p = st.project;
  if (!p) return 0;
  const { list, locked } = targetsOf(p, ids);
  if (locked > 0) toast('clips on locked tracks were left out');
  if (list.length === 0) return 0;
  const plans: Plan[] = [];
  let skipped = 0;
  for (const it of list) {
    // a flat clip ignores z / tilt / turn: it starts from a clean 3d pose
    const base = it.now.threeD ? it.pose : { ...it.pose, z: 0, rotX: 0, rotY: 0 };
    if (!it.parent) {
      plans.push(planOf(it, { ...base, rotX: angle }, { withScale: false, unlook: true }));
      continue;
    }
    const a = axesOf(it.frame);
    const t = tiltedAxes(base, angle);
    const next = poseFromWorld(it.parent, p.width, p.height, worldMatrix(a.center, t.right, t.down, t.normal, frameScale(it.frame)));
    if (next) plans.push(planOf(it, next, { withScale: true, unlook: true }));
    else skipped++;
  }
  if (skipped > 0) skippedToast(skipped);
  if (plans.length === 0) return 0;
  const turnedOff = plans.filter((pl) => pl.unlook).length;
  commit(plans);
  if (turnedOff > 0) toast(`${turnedOff === 1 ? 'a clip' : `${turnedOff} clips`} stopped facing something so the tilt shows`);
  return plans.length;
}

export const layFlat = (ids: readonly string[]) => setTilt(ids, 90);
export const standUp = (ids: readonly string[]) => setTilt(ids, 0);

/**
 * move the clips down (in the world) so their lowest edge rests on the floor line: the bottom of the frame
 * at z 0. the clip's real reach counts (tilt, turn, spin, scale, parents). a 3d clip with lookAt is left out
 * (its turn comes from the renderer). one undo step, none when everything already rests there.
 */
export function dropToFloor(ids: readonly string[]): number {
  const st = useEditor.getState();
  const p = st.project;
  if (!p) return 0;
  const { list, locked } = targetsOf(p, ids);
  if (locked > 0) toast('clips on locked tracks were left out');
  const plans: Plan[] = [];
  let skipped = 0;
  let facing = 0;
  for (const it of list) {
    if (it.now.threeD && (it.now.lookAt ?? 'none') !== 'none') {
      facing++;
      continue;
    }
    const a = axesOf(it.frame);
    const size = worldSize(p, it);
    const round = !!it.now.threeD && it.now.shape === 'sphere';
    const y = floorCenterY(p.height, size.w, size.h, a.right, a.down, solidDepth(it, size), a.normal, round);
    const next = poseFromWorld(it.parent, p.width, p.height, worldMatrix([a.center[0], y, a.center[2]], a.right, a.down, a.normal, frameScale(it.frame)));
    if (next) plans.push(planOf(it, next, { withScale: !!it.parent, make3d: false }));
    else skipped++;
  }
  if (facing > 0) toast(`${facing === 1 ? 'a clip' : `${facing} clips`} that face the camera or a clip: turn facing off first`);
  if (skipped > 0) skippedToast(skipped);
  if (plans.length === 0) return 0;
  commit(plans);
  return plans.length;
}
