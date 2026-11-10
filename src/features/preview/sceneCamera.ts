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
