import { describe, expect, it } from 'vitest';
import { DEFAULT_FOV, cameraRig, projectPoint } from '../../engine/scene3d/camera';
import { type Orbit, cameraToOrbit, defaultOrbit, frameOrbit, orbitEye, orbitForward, orbitToCameraValues, toCamera3D, viewPreset } from './sceneCamera';
import { closestOnAxis, pointInQuad } from './overlayMath';

const project = { width: 1920, height: 1080 };

describe('scene camera', () => {
  it('looks at its target from the default view', () => {
    const o = defaultOrbit(project);
    const rig = cameraRig(toCamera3D(o, project), project.width, project.height);
    const p = projectPoint(rig, o.targetX, o.targetY, o.targetZ, project.width, project.height);
    expect(p.visible).toBe(true);
    expect(p.x).toBeCloseTo(960, 1);
    expect(p.y).toBeCloseTo(540, 1);
    const f = orbitForward(o);
    expect(rig.forward[0]).toBeCloseTo(f[0], 5);
    expect(rig.forward[1]).toBeCloseTo(f[1], 5);
    expect(rig.forward[2]).toBeCloseTo(f[2], 5);
  });

  it('sees the whole output frame by default', () => {
    const o = defaultOrbit(project);
    const rig = cameraRig(toCamera3D(o, project), project.width, project.height);
    for (const [x, y] of [[0, 0], [1920, 0], [1920, 1080], [0, 1080]] as const) {
      const p = projectPoint(rig, x, y, 0, project.width, project.height);
      expect(p.visible).toBe(true);
      expect(p.x).toBeGreaterThan(0);
      expect(p.x).toBeLessThan(project.width);
      expect(p.y).toBeGreaterThan(0);
      expect(p.y).toBeLessThan(project.height);
    }
  });
});

describe('overlay math', () => {
  it('point in quad works for both windings', () => {
    const cw = [0, 0, 10, 0, 10, 10, 0, 10];
    const ccw = [0, 0, 0, 10, 10, 10, 10, 0];
    expect(pointInQuad(cw, 5, 5)).toBe(true);
    expect(pointInQuad(ccw, 5, 5)).toBe(true);
    expect(pointInQuad(cw, 11, 5)).toBe(false);
  });

  it('finds the closest point on an axis', () => {
    // ray from (0,0,-10) along +z, axis along x through (3,0,0): closest axis param is 0 shifted by 3 => -3
    const t = closestOnAxis([0, 0, -10], [0, 0, 1], [3, 0, 0], [1, 0, 0]);
    expect(t).toBeCloseTo(-3, 6);
    expect(closestOnAxis([0, 0, -10], [1, 0, 0], [3, 0, 0], [1, 0, 0])).toBeNull();
  });
});

describe('orbit <-> camera values', () => {
  const orbits: Orbit[] = [
    defaultOrbit(project),
    { targetX: 100, targetY: -50, targetZ: 300, yaw: 40, pitch: 25, distance: 2000 },
    { targetX: 960, targetY: 540, targetZ: 0, yaw: -170, pitch: -60, distance: 900 },
    { targetX: -400, targetY: 800, targetZ: -1200, yaw: 90, pitch: 0, distance: 3000 },
  ];

  it('camera values put the renderer eye and forward where the orbit has them', () => {
    for (const o of orbits) {
      const v = orbitToCameraValues(o, project);
      expect(v.roll).toBe(0);
      const rig = cameraRig({ ...v, fov: DEFAULT_FOV }, project.width, project.height);
      const eye = orbitEye(o);
      const f = orbitForward(o);
      for (let i = 0; i < 3; i++) {
        expect(rig.eye[i]).toBeCloseTo(eye[i]!, 3);
        expect(rig.forward[i]).toBeCloseTo(f[i]!, 5);
      }
    }
  });

  it('round trips orbit -> camera -> orbit', () => {
    for (const o of orbits) {
      const back = cameraToOrbit(orbitToCameraValues(o, project), project, o.distance);
      expect(back.yaw).toBeCloseTo(o.yaw, 6);
      expect(back.pitch).toBeCloseTo(o.pitch, 6);
      expect(back.targetX).toBeCloseTo(o.targetX, 3);
      expect(back.targetY).toBeCloseTo(o.targetY, 3);
      expect(back.targetZ).toBeCloseTo(o.targetZ, 3);
    }
  });

  it('looks through a camera: same eye and direction as the camera rig', () => {
    const cam = { x: 120, y: -80, z: 300, pan: 25, tilt: -10 };
    const o = cameraToOrbit(cam, project);
    const rig = cameraRig({ ...cam, roll: 0, fov: DEFAULT_FOV }, project.width, project.height);
    const eye = orbitEye(o);
    const f = orbitForward(o);
    for (let i = 0; i < 3; i++) {
      expect(eye[i]).toBeCloseTo(rig.eye[i]!, 3);
      expect(f[i]).toBeCloseTo(rig.forward[i]!, 5);
    }
  });

  it('holds a camera tilt past straight up inside the orbit limit', () => {
    expect(cameraToOrbit({ x: 0, y: 0, z: 0, pan: 0, tilt: 120 }, project).pitch).toBe(89);
  });
});

describe('view presets', () => {
  it('front looks straight at the middle of the frame and sees all of it', () => {
    const o = viewPreset('front', project);
    const rig = cameraRig(toCamera3D(o, project), project.width, project.height);
    for (const [x, y] of [[0, 0], [1920, 1080], [960, 540]] as const) {
      const p = projectPoint(rig, x, y, 0, project.width, project.height);
      expect(p.visible).toBe(true);
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(project.width);
    }
  });
  it('top looks down and side looks along x', () => {
    expect(orbitForward(viewPreset('top', project))[1]).toBeGreaterThan(0.99);
    expect(orbitForward(viewPreset('side', project))[0]).toBeCloseTo(1, 6);
  });
});

describe('frameOrbit', () => {
  it('centers the target and fills about half the view', () => {
    const o = frameOrbit(defaultOrbit(project), [300, 200, 100], 100, project, 0.5);
    const rig = cameraRig(toCamera3D(o, project), project.width, project.height);
    const c = projectPoint(rig, 300, 200, 100, project.width, project.height);
    expect(c.x).toBeCloseTo(960, 1);
    expect(c.y).toBeCloseTo(540, 1);
    // a point one radius above the center sits half way to the top edge
    const up = projectPoint(rig, 300 - rig.down[0] * 100, 200 - rig.down[1] * 100, 100 - rig.down[2] * 100, project.width, project.height);
    expect(Math.abs(up.y - 540)).toBeCloseTo(270, 0);
  });
});
