/**
 * the free editor camera of the scene view: an orbit around a target point.
 * kept in a tiny store (not persisted). `orbit: null` = the default view for the current project.
 */
import { create } from 'zustand';
import { type Camera3D, DEFAULT_FOV, homeDistance } from '../../engine/scene3d/camera';
import { DEG, type Vec3 } from '../../engine/scene3d/math';
import type { Project } from '../../types';

export interface Orbit {
  targetX: number;
  targetY: number;
  targetZ: number;
  /** degrees, same meaning as camera pan: + looks right */
  yaw: number;
  /** degrees, same meaning as camera tilt: + looks up */
  pitch: number;
  distance: number;
}

const MAX_PITCH = 89;

/** front right and slightly above, far enough to see the output frame and the project camera */
export function defaultOrbit(project: Pick<Project, 'width' | 'height'>): Orbit {
  const d0 = homeDistance(project.height);
  return {
    targetX: project.width / 2,
    targetY: project.height / 2,
    targetZ: -d0 * 0.4,
    yaw: -32,
    pitch: -18,
    distance: d0 * 2.5,
  };
}

interface SceneCameraState {
  orbit: Orbit | null;
  set(orbit: Orbit): void;
  reset(): void;
}

export const useSceneCamera = create<SceneCameraState>()((set) => ({
  orbit: null,
  set(orbit) {
    set({ orbit: { ...orbit, pitch: Math.max(-MAX_PITCH, Math.min(MAX_PITCH, orbit.pitch)), distance: Math.max(1, orbit.distance) } });
  },
  reset() {
    set({ orbit: null });
  },
}));

export function currentOrbit(project: Pick<Project, 'width' | 'height'>): Orbit {
  return useSceneCamera.getState().orbit ?? defaultOrbit(project);
}

/** unit direction the orbit camera looks along */
export function orbitForward(o: Orbit): Vec3 {
  const y = o.yaw * DEG;
  const p = o.pitch * DEG;
  return [Math.sin(y) * Math.cos(p), -Math.sin(p), Math.cos(y) * Math.cos(p)];
}

/** the orbit as the Camera3D the renderer wants (offsets from the home pose) */
export function toCamera3D(o: Orbit, project: Pick<Project, 'width' | 'height'>): Camera3D {
  const f = orbitForward(o);
  const eyeX = o.targetX - f[0] * o.distance;
  const eyeY = o.targetY - f[1] * o.distance;
  const eyeZ = o.targetZ - f[2] * o.distance;
  return {
    x: eyeX - project.width / 2,
    y: eyeY - project.height / 2,
    z: eyeZ + homeDistance(project.height),
    pan: o.yaw,
    tilt: o.pitch,
    roll: 0,
    fov: DEFAULT_FOV,
  };
}

/** where the orbit camera's eye is (world) */
export function orbitEye(o: Orbit): Vec3 {
  const f = orbitForward(o);
  return [o.targetX - f[0] * o.distance, o.targetY - f[1] * o.distance, o.targetZ - f[2] * o.distance];
}

/** the values a camera clip stores to look exactly through this view: toCamera3D without the roll and fov */
export interface CameraValues {
  x: number;
  y: number;
  z: number;
  pan: number;
  tilt: number;
  roll: number;
}

export function orbitToCameraValues(o: Orbit, project: Pick<Project, 'width' | 'height'>): CameraValues {
  const c = toCamera3D(o, project);
  return { x: c.x, y: c.y, z: c.z, pan: c.pan, tilt: c.tilt, roll: 0 };
}

/**
 * the inverse of toCamera3D: the orbit that looks through a camera. the eye and the look direction are exact;
 * the target sits `distance` ahead of the eye. an orbit has no roll or fov, so those are dropped, and a tilt past
 * +-89 degrees is held there.
 */
export function cameraToOrbit(
  cam: Pick<Camera3D, 'x' | 'y' | 'z' | 'pan' | 'tilt'>,
  project: Pick<Project, 'width' | 'height'>,
  distance = homeDistance(project.height),
): Orbit {
  const eye: Vec3 = [project.width / 2 + cam.x, project.height / 2 + cam.y, -homeDistance(project.height) + cam.z];
  const o: Orbit = { targetX: 0, targetY: 0, targetZ: 0, yaw: cam.pan, pitch: Math.max(-MAX_PITCH, Math.min(MAX_PITCH, cam.tilt)), distance: Math.max(1, distance) };
  const f = orbitForward(o);
  o.targetX = eye[0] + f[0] * o.distance;
  o.targetY = eye[1] + f[1] * o.distance;
  o.targetZ = eye[2] + f[2] * o.distance;
  return o;
}

export type ViewPreset = 'front' | 'top' | 'side';

/** straight-on views around the output frame: front (like the project camera), top (looking down), side (from the left) */
export function viewPreset(name: ViewPreset, project: Pick<Project, 'width' | 'height'>): Orbit {
  const d0 = homeDistance(project.height);
  const target = { targetX: project.width / 2, targetY: project.height / 2, targetZ: 0 };
  switch (name) {
    case 'front':
      return { ...target, yaw: 0, pitch: 0, distance: d0 * 1.4 };
    case 'top':
      return { ...target, yaw: 0, pitch: -MAX_PITCH, distance: d0 * 1.6 };
    case 'side':
      return { ...target, yaw: 90, pitch: 0, distance: d0 * 1.6 };
  }
}

/** move the orbit so a sphere (center, radius) fills `fill` of the shorter side of the view, keeping the direction */
export function frameOrbit(o: Orbit, center: Vec3, radius: number, project: Pick<Project, 'width' | 'height'>, fill = 0.5): Orbit {
  const tanHalf = Math.tan((DEFAULT_FOV * DEG) / 2);
  const aspect = project.width / project.height;
  const distance = Math.max(20, Math.max(1, radius) / (fill * tanHalf * Math.min(1, aspect)));
  return { ...o, targetX: center[0], targetY: center[1], targetZ: center[2], distance };
}
