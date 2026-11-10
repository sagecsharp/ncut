import { describe, expect, it } from 'vitest';
import { cameraRig, projectPoint } from '../../engine/scene3d/camera';
import { defaultOrbit, orbitForward, toCamera3D } from './sceneCamera';
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
