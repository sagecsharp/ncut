import type { Easing } from '../../types';

/** the camera values a move starts from (the camera clip's values at its first frame) */
export interface CameraValues {
  x: number;
  y: number;
  z: number;
  pan: number;
  tilt: number;
  roll: number;
  fov: number;
}

export type CameraMoveId = 'pushIn' | 'pullOut' | 'panLeft' | 'panRight' | 'rise' | 'orbitLeft' | 'orbitRight' | 'dollyZoom' | 'handheld';

export interface MoveKey {
  prop: keyof CameraValues;
  /** clip-local seconds */
  t: number;
  v: number;
  ease: Easing;
}

export const CAMERA_MOVES: { id: CameraMoveId; label: string; title: string }[] = [
  { id: 'pushIn', label: 'push in', title: 'move the camera forward' },
  { id: 'pullOut', label: 'pull out', title: 'move the camera backward' },
  { id: 'panLeft', label: 'pan left', title: 'turn the camera to the left' },
  { id: 'panRight', label: 'pan right', title: 'turn the camera to the right' },
  { id: 'rise', label: 'rise', title: 'lift the camera up' },
  { id: 'orbitLeft', label: 'orbit left', title: 'swing the camera around to the left while it keeps looking ahead' },
  { id: 'orbitRight', label: 'orbit right', title: 'swing the camera around to the right while it keeps looking ahead' },
  { id: 'dollyZoom', label: 'dolly zoom', title: 'move forward while the view widens, so the middle keeps its size and the background stretches' },
  { id: 'handheld', label: 'handheld', title: 'small shaky drift, like a camera held in the hands' },
];

const PUSH = 300;
const PAN = 15;
const RISE = 120;
const ORBIT_SIDE = 400;
const ORBIT_TURN = 20;
/** the distance (px) to the subject assumed by the dolly zoom */
const DOLLY_DISTANCE = 1000;
const DOLLY_PUSH = 400;
const FOV_MIN = 5;
const FOV_MAX = 150;
const HAND_MOVE = 6;
const HAND_ROLL = 0.6;
const HAND_STEP = 0.5;

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** deterministic noise in -1..1 */
function noise(i: number, salt: number): number {
  const s = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
  return (s - Math.floor(s)) * 2 - 1;
}

function ends(prop: keyof CameraValues, from: number, to: number, duration: number): MoveKey[] {
  return [
    { prop, t: 0, v: round3(from), ease: 'ease' },
    { prop, t: duration, v: round3(to), ease: 'ease' },
  ];
}

/**
 * the keyframes for a named camera move over a clip of `duration` seconds. starts from the camera's
 * current values so moves can be combined (each move only writes the properties it uses).
 */
export function cameraMove(id: CameraMoveId, cur: CameraValues, duration: number, fps: number): MoveKey[] {
  if (!(duration > 0)) return [];
  const d = duration;
  switch (id) {
    case 'pushIn':
      return ends('z', cur.z, cur.z + PUSH, d);
    case 'pullOut':
      return ends('z', cur.z, cur.z - PUSH, d);
    case 'panLeft':
      return ends('pan', cur.pan, cur.pan - PAN, d);
    case 'panRight':
      return ends('pan', cur.pan, cur.pan + PAN, d);
    case 'rise':
      return ends('y', cur.y, cur.y - RISE, d);
    case 'orbitLeft':
      return [...ends('x', cur.x, cur.x - ORBIT_SIDE, d), ...ends('pan', cur.pan, cur.pan + ORBIT_TURN, d)];
    case 'orbitRight':
      return [...ends('x', cur.x, cur.x + ORBIT_SIDE, d), ...ends('pan', cur.pan, cur.pan - ORBIT_TURN, d)];
    case 'dollyZoom': {
      const half = Math.tan((cur.fov * Math.PI) / 360);
      const wide = 2 * Math.atan((half * DOLLY_DISTANCE) / (DOLLY_DISTANCE - DOLLY_PUSH)) * (180 / Math.PI);
      const fov = Math.min(FOV_MAX, Math.max(FOV_MIN, wide));
      return [...ends('z', cur.z, cur.z + DOLLY_PUSH, d), ...ends('fov', cur.fov, fov, d)];
    }
    case 'handheld': {
      const step = Math.max(HAND_STEP, 2 / Math.max(1, fps));
      const inner = Math.max(0, Math.min(20, Math.floor(d / step) - 1));
      const times = [0];
      for (let i = 1; i <= inner; i++) times.push(round3((d * i) / (inner + 1)));
      times.push(d);
      const out: MoveKey[] = [];
      const props: { prop: 'x' | 'y' | 'roll'; amp: number; salt: number }[] = [
        { prop: 'x', amp: HAND_MOVE, salt: 1 },
        { prop: 'y', amp: HAND_MOVE, salt: 2 },
        { prop: 'roll', amp: HAND_ROLL, salt: 3 },
      ];
      for (const { prop, amp, salt } of props) {
        times.forEach((t, i) => {
          const edge = i === 0 || i === times.length - 1;
          out.push({ prop, t, v: round3(cur[prop] + (edge ? 0 : noise(i, salt) * amp)), ease: 'ease' });
        });
      }
      return out;
    }
  }
}

/** the properties a move writes keys for */
export function moveProps(keys: readonly MoveKey[]): (keyof CameraValues)[] {
  return [...new Set(keys.map((k) => k.prop))];
}
