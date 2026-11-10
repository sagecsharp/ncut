/**
 * store side of the 3d placement helpers (place3d.ts has the math). every action is ONE undo step:
 * pushHistory() once (or the history step of addCamera), then { skipHistory: true } on each store call.
 * values go through setClipValue at the playhead, so a keyframed value gets a key and the others a static value.
 */
import { getClipBox } from '../../engine/draw';
import { parentModelMatrix } from '../../engine/parent';
import { DEFAULT_FOV, cameraAt, cameraClipAt, cameraRig } from '../../engine/scene3d/camera';
import { resolveClip, valueAt } from '../../lib/anim';
import { clamp } from '../../lib/time';
import { useEditor } from '../../store/editorStore';
import type { Vec3 } from '../../engine/scene3d/math';
import { usePlayback } from '../../store/playback';
import { useUi } from '../../store/ui';
import type { Project, Transform, VisualClip } from '../../types';
import { isVisualClip } from '../../types';
import {
  axesOf,
  flatDistance,
  floorCenterY,
  frameCamera,
  frameMatrix,
  frameScale,
  placeInFront,
  poseFromWorld,
  worldMatrix,
} from './place3d';
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
  /** the clip with keyframes baked in at t */
  now: VisualClip;
  parent: Float64Array | Float32Array | null;
  pose: PoseValues;
  /** world frame of the clip's own values (motions are not part of it) */
  frame: Float64Array;
}

function poseOf(tf: Transform): PoseValues {
  return { x: tf.x, y: tf.y, z: tf.z ?? 0, rotX: tf.rotX ?? 0, rotY: tf.rotY ?? 0, rotation: tf.rotation, scale: tf.scale };
}

/** selected visual clips on unlocked tracks, with their frames at the playhead. `skipped` counts the rest. */
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
    const now = resolveClip(c, t) as VisualClip;
    const parent = parentModelMatrix(project, c, t);
    const pose = poseOf(now.transform);
    list.push({ clip: c, t, now, parent, pose, frame: frameMatrix(parent, project.width, project.height, pose, !!now.threeD) });
  }
  return { list, locked };
}

/** write the pose values that differ from the current ones (so a keyframed value only gets a key where it changes) */
function writePose(id: string, t: number, cur: PoseValues, next: PoseValues, withScale: boolean): void {
  const st = useEditor.getState();
  const props = ['x', 'y', 'z', 'rotX', 'rotY', 'rotation'] as const;
  for (const k of props) {
    const v = round2(next[k]);
    if (Math.abs(v - cur[k]) > 1e-4) st.setClipValue(id, k, t, v, SKIP);
  }
  if (withScale && Math.abs(next.scale - cur.scale) > 1e-6) st.setClipValue(id, 'scale', t, Math.round(next.scale * 1e4) / 1e4, SKIP);
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
  const plans: { it: Target; next: PoseValues }[] = [];
  let skipped = 0;
  list.forEach((it, i) => {
    const scale = frameScale(it.frame);
    const next = poseFromWorld(it.parent, p.width, p.height, worldMatrix(centers[i]!, rig.right, rig.down, rig.forward, scale));
    if (next) plans.push({ it, next });
    else skipped++;
  });
  if (skipped > 0) toast(`${skipped === 1 ? 'a clip was' : `${skipped} clips were`} left out: the clip it is attached to cannot place it`);
  if (plans.length === 0) return 0;
  st.pushHistory();
  for (const { it, next } of plans) {
    makeThreeD(it.clip);
    const cur = it.now.threeD ? it.pose : { ...it.pose, z: 0, rotX: 0, rotY: 0 };
    writePose(it.clip.id, it.t, cur, next, !!it.parent);
  }
  return plans.length;
}

/** world size of a visual clip at its playhead time: the clip box times the scale its parents add */
function worldSize(p: Project, it: Target): { w: number; h: number } {
  const box = getClipBox(p, it.now);
  const extra = it.parent ? frameScale(it.parent) : 1;
  return { w: box.width * extra, h: box.height * extra };
}

/**
 * move the camera clip in charge at the playhead so the clip fills about 80% of the frame, seen straight on
 * from its front side (x / y / z, pan / tilt / roll). no camera clip there: one is made on a new camera track
 * for the length of the clip. the clip turns 3d (a flat clip is not seen through the camera). one undo step.
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

  let camId: string;
  let cleared = false;
  if (existing) {
    camId = existing.id;
    st.pushHistory();
    cleared = !!existing.target;
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
  if (cam.target) {
    // a target makes the camera aim at that clip and fight the framing
    after.updateClip(camId, { target: null }, SKIP);
    cleared = true;
  }
  const tc = clamp(now, cam.start, cam.start + cam.duration);
  for (const [prop, val] of [
    ['x', v.x],
    ['y', v.y],
    ['z', v.z],
    ['pan', v.pan],
    ['tilt', v.tilt],
    ['roll', v.roll],
  ] as const) {
    after.setClipValue(camId, prop, tc, round2(val), SKIP);
  }
  makeThreeD(it.clip);
  after.select([it.clip.id]); // addCamera selects the new camera: keep the clip selected
  if (cleared) toast('the camera had a target: cleared it so it can frame the clip');
  return true;
}

/** tilt every selected clip to a fixed angle (3d on): 90 = lying flat like a floor, 0 = standing */
function setTilt(ids: readonly string[], angle: number): number {
  const st = useEditor.getState();
  const p = st.project;
  if (!p) return 0;
  const { list, locked } = targetsOf(p, ids);
  if (locked > 0) toast('clips on locked tracks were left out');
  if (list.length === 0) return 0;
  st.pushHistory();
  for (const it of list) {
    makeThreeD(it.clip);
    st.setClipValue(it.clip.id, 'rotX', it.t, angle, SKIP);
  }
  return list.length;
}

export const layFlat = (ids: readonly string[]) => setTilt(ids, 90);
export const standUp = (ids: readonly string[]) => setTilt(ids, 0);

/**
 * move the clips down (in the world) so their lowest edge rests on the floor line: the bottom of the frame
 * at z 0. the clip's real reach counts (tilt, turn, spin, scale, parents). one undo step.
 */
export function dropToFloor(ids: readonly string[]): number {
  const st = useEditor.getState();
  const p = st.project;
  if (!p) return 0;
  const { list, locked } = targetsOf(p, ids);
  if (locked > 0) toast('clips on locked tracks were left out');
  const plans: { it: Target; next: PoseValues }[] = [];
  let skipped = 0;
  for (const it of list) {
    const a = axesOf(it.frame);
    const size = worldSize(p, it);
    const y = floorCenterY(p.height, size.w, size.h, a.right, a.down);
    const next = poseFromWorld(it.parent, p.width, p.height, worldMatrix([a.center[0], y, a.center[2]], a.right, a.down, a.normal, frameScale(it.frame)));
    if (next) plans.push({ it, next });
    else skipped++;
  }
  if (skipped > 0) toast(`${skipped === 1 ? 'a clip was' : `${skipped} clips were`} left out: the clip it is attached to cannot place it`);
  if (plans.length === 0) return 0;
  st.pushHistory();
  for (const { it, next } of plans) writePose(it.clip.id, it.t, it.pose, next, !!it.parent);
  return plans.length;
}
