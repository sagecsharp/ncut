import { describe, expect, it } from 'vitest';
import { createProject, createShapeClip, createTrack } from '../../lib/factory';
import type { Project, SceneLight, ShapeClip } from '../../types';
import {
  AUTO_GROUND,
  autoLightAt,
  backdropColorAt,
  backdropShapes,
  hexToLinear,
  lightRigFrom,
  linearToHex,
  litFactor,
  planeLight,
  sceneLightAt,
  sunDirection,
  toLinear,
  toSrgb,
  usesLight,
} from './light';

function lightOf(over: Partial<SceneLight> = {}): SceneLight {
  return { sky: '#6080a0', horizon: '#a0b0c0', ground: '#302010', sun: 0, sunColor: '#ffffff', sunTurn: 0, sunHeight: 45, ...over };
}

/** a project with two video tracks: tracks[0] the top layer, tracks[1] the bottom one */
function twoTracks(): { p: Project; top: string; bottom: string } {
  const p = createProject('t');
  const top = createTrack('video', 'top');
  const bottom = createTrack('video', 'bottom');
  p.tracks = [top, bottom];
  p.background = '#000000';
  return { p, top: top.id, bottom: bottom.id };
}

function threeD(trackId: string, over: Partial<ShapeClip> = {}): ShapeClip {
  return createShapeClip(trackId, 0, { threeD: true, duration: 10, ...over });
}

function fullRect(p: Project, trackId: string, over: Partial<ShapeClip> = {}): ShapeClip {
  return createShapeClip(trackId, 0, {
    duration: 10,
    width: p.width,
    height: p.height,
    color: '#101830',
    color2: '#c0d0e0',
    gradientAngle: 90,
    ...over,
  });
}

function sum(c: readonly number[]): number {
  return c[0]! + c[1]! + c[2]!;
}

function hexSum(hex: string): number {
  return sum(hexToLinear(hex));
}

describe('color helpers', () => {
  it('toLinear and toSrgb round trip', () => {
    for (let i = 0; i <= 20; i++) {
      const v = i / 20;
      expect(Math.abs(toSrgb(toLinear(v)) - v)).toBeLessThan(1e-9);
    }
  });

  it('hexToLinear reads hex and gives black for the rest', () => {
    expect(hexToLinear('#ffffff')).toEqual([1, 1, 1]);
    expect(hexToLinear('red')).toEqual([0, 0, 0]);
    expect(hexToLinear(undefined as unknown as string)).toEqual([0, 0, 0]);
  });

  it('linearToHex round trips a hex color', () => {
    expect(linearToHex(hexToLinear('#336699'))).toBe('#336699');
    expect(linearToHex([0, 0, 0])).toBe('#000000');
    expect(linearToHex([1, 1, 1])).toBe('#ffffff');
  });
});

describe('sunDirection', () => {
  it('has the named corners', () => {
    const a = sunDirection(0, 0);
    expect(a[0]).toBeCloseTo(0, 9);
    expect(a[1]).toBeCloseTo(0, 9);
    expect(a[2]).toBeCloseTo(-1, 9);
    const b = sunDirection(90, 0);
    expect(b[0]).toBeCloseTo(1, 9);
    expect(b[1]).toBeCloseTo(0, 9);
    expect(b[2]).toBeCloseTo(0, 9);
    const c = sunDirection(40, 90);
    expect(c[0]).toBeCloseTo(0, 9);
    expect(c[1]).toBeCloseTo(-1, 9);
    expect(c[2]).toBeCloseTo(0, 9);
  });

  it('has unit length over a grid', () => {
    for (let t = -180; t <= 180; t += 15) {
      for (let h = 0; h <= 90; h += 15) {
        const d = sunDirection(t, h);
        expect(Math.hypot(d[0], d[1], d[2])).toBeCloseTo(1, 9);
      }
    }
  });

  it('gives finite numbers for nan and infinity', () => {
    for (const d of [sunDirection(NaN, NaN), sunDirection(Infinity, -Infinity), sunDirection(NaN, 30)]) {
      for (const v of d) expect(Number.isFinite(v)).toBe(true);
    }
  });
});

describe('litFactor', () => {
  it('k 0 gives 1 for any env and normal', () => {
    const rig = lightRigFrom(lightOf({ sun: 0.7 }));
    const out = [0, 0, 0];
    for (const n of [[0, -1, 0], [0, 1, 0], [0, 0, -1], [1, 0, 0]] as const) {
      litFactor(n[0], n[1], n[2], 0, rig.env, out);
      expect(out).toEqual([1, 1, 1]);
    }
  });

  it('an all white dome without sun gives 1 for every normal at k 1', () => {
    const rig = lightRigFrom(lightOf({ sky: '#ffffff', horizon: '#ffffff', ground: '#ffffff', sun: 0 }));
    const out = [0, 0, 0];
    for (const n of [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0.6, -0.8, 0]] as const) {
      litFactor(n[0], n[1], n[2], 1, rig.env, out);
      for (const v of out) expect(v).toBeCloseTo(1, 6);
    }
  });

  it('a normal straight up at k 1 gives the sky in srgb', () => {
    const rig = lightRigFrom(lightOf({ sky: '#6080a0' }));
    const out = new Float32Array(3);
    litFactor(0, -1, 0, 1, rig.env, out);
    for (let i = 0; i < 3; i++) expect(out[i]!).toBeCloseTo(parseInt('6080a0'.slice(i * 2, i * 2 + 2), 16) / 255, 5);
  });

  it('a normal toward the sun gets more than one away from it', () => {
    const rig = lightRigFrom(lightOf({ sun: 0.6, sunTurn: 90, sunHeight: 0, sunColor: '#ffffff' }));
    const to = [0, 0, 0];
    const away = [0, 0, 0];
    litFactor(1, 0, 0, 1, rig.env, to);
    litFactor(-1, 0, 0, 1, rig.env, away);
    for (let i = 0; i < 3; i++) expect(to[i]!).toBeGreaterThan(away[i]!);
  });

  it('stays in 0..1 and never nan over 500 random cases', () => {
    let seed = 12345;
    const rnd = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const env = new Float32Array(15);
    const out = new Float32Array(3);
    for (let n = 0; n < 500; n++) {
      const sun = rnd();
      for (let i = 0; i < 9; i++) env[i] = rnd() * (1 - sun);
      const d = sunDirection(rnd() * 360 - 180, rnd() * 90);
      for (let i = 0; i < 3; i++) {
        env[9 + i] = d[i]!;
        env[12 + i] = rnd() * sun;
      }
      let x = rnd() * 2 - 1;
      let y = rnd() * 2 - 1;
      let z = rnd() * 2 - 1;
      const len = Math.hypot(x, y, z) || 1;
      x /= len;
      y /= len;
      z /= len;
      litFactor(x, y, z, rnd(), env, out);
      for (const v of out) {
        expect(Number.isNaN(v)).toBe(false);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('planeLight', () => {
  // column major, like the renderer's model matrices
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const floor = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1];
  const rig = lightRigFrom(lightOf());
  const sky = new Float32Array(3);
  const horizon = new Float32Array(3);
  const ground = new Float32Array(3);
  litFactor(0, -1, 0, 1, rig.env, sky);
  litFactor(0, 0, -1, 1, rig.env, horizon);
  litFactor(0, 1, 0, 1, rig.env, ground);

  it('a plane facing the eye takes the horizon', () => {
    const out = new Float32Array(3);
    planeLight(identity, [0, 0, -1000], 1, rig.env, out);
    expect(Array.from(out)).toEqual(Array.from(horizon));
    planeLight(identity, [0, 0, 1000], 1, rig.env, out);
    expect(Array.from(out)).toEqual(Array.from(horizon));
    planeLight(identity, [0, 0, -1000], 1, rig.env, out);
    // planeLight gives display values, so the hand numbers are plain hex over 255
    const h = [0xa0, 0xb0, 0xc0];
    for (let i = 0; i < 3; i++) expect(out[i]!).toBeCloseTo(h[i]! / 255, 5);
  });

  it('a floor takes the sky from above and the ground from below', () => {
    const out = new Float32Array(3);
    planeLight(floor, [0, -1000, 0], 1, rig.env, out);
    expect(Array.from(out)).toEqual(Array.from(sky));
    planeLight(floor, [0, 1000, 0], 1, rig.env, out);
    expect(Array.from(out)).toEqual(Array.from(ground));
    const g = [0x30, 0x20, 0x10];
    for (let i = 0; i < 3; i++) expect(out[i]!).toBeCloseTo(g[i]! / 255, 5);
    planeLight(floor, [0, -1000, 0], 1, rig.env, out);
    const s = [0x60, 0x80, 0xa0];
    for (let i = 0; i < 3; i++) expect(out[i]!).toBeCloseTo(s[i]! / 255, 5);
  });

  it('a mirrored plane gets the same light', () => {
    const mirrored = floor.slice();
    mirrored[0] = -1;
    const a = new Float32Array(3);
    const b = new Float32Array(3);
    planeLight(floor, [0, -1000, 0], 1, rig.env, a);
    planeLight(mirrored, [0, -1000, 0], 1, rig.env, b);
    expect(Array.from(b)).toEqual(Array.from(a));
  });

  it('an all zero model gives finite numbers', () => {
    const out = new Float32Array(3);
    planeLight(new Array(16).fill(0), [0, 0, -1000], 1, rig.env, out);
    for (const v of out) expect(Number.isFinite(v)).toBe(true);
  });
});

describe('lightRigFrom', () => {
  it('lays out the 15 numbers', () => {
    const dome = lightRigFrom(lightOf({ sun: 0 })).env;
    expect(dome.length).toBe(15);
    for (let i = 12; i < 15; i++) expect(dome[i]).toBe(0);
    const sky = hexToLinear('#6080a0');
    for (let i = 0; i < 3; i++) expect(dome[i]!).toBeCloseTo(sky[i]!, 6);
    const hor = hexToLinear('#a0b0c0');
    const gnd = hexToLinear('#302010');
    for (let i = 0; i < 3; i++) expect(dome[3 + i]!).toBeCloseTo(hor[i]!, 6);
    for (let i = 0; i < 3; i++) expect(dome[6 + i]!).toBeCloseTo(gnd[i]!, 6);

    const l = lightOf({ sun: 1, sunTurn: 30, sunHeight: 60 });
    const sun = lightRigFrom(l).env;
    for (let i = 0; i < 9; i++) expect(sun[i]).toBe(0);
    const d = sunDirection(30, 60);
    for (let i = 0; i < 3; i++) expect(sun[9 + i]!).toBeCloseTo(d[i]!, 6);
    const sc = hexToLinear(l.sunColor);
    for (let i = 0; i < 3; i++) expect(sun[12 + i]!).toBeCloseTo(sc[i]!, 6);
  });

  it('gives the same rig object for the same light', () => {
    const l = lightOf();
    expect(lightRigFrom(l)).toBe(lightRigFrom(l));
    expect(lightRigFrom(lightOf())).not.toBe(lightRigFrom(l));
  });
});

describe('autoLightAt', () => {
  it('takes the background when nothing is behind', () => {
    const p = createProject('a');
    p.background = '#336699';
    const a = autoLightAt(p, 0);
    expect(a.sky).toBe('#336699');
    expect(a.horizon).toBe('#336699');
    const lin = hexToLinear('#336699');
    expect(a.ground).toBe(linearToHex([lin[0] * AUTO_GROUND, lin[1] * AUTO_GROUND, lin[2] * AUTO_GROUND]));
  });

  it('pulls the horizon toward the fog color', () => {
    const mk = (fog: Project['fog']): Project => {
      const p = createProject('a');
      p.background = '#336699';
      p.fog = fog;
      return p;
    };
    const full = autoLightAt(mk({ color: '#ffffff', near: 0, far: 10, amount: 1 }), 0);
    expect(full.horizon).toBe('#ffffff');
    expect(full.sky).toBe('#336699');
    const base = hexToLinear('#336699');
    const mid = autoLightAt(mk({ color: '#ffffff', near: 0, far: 10, amount: 0.5 }), 0);
    expect(mid.horizon).toBe(linearToHex([base[0] + (1 - base[0]) * 0.5, base[1] + (1 - base[1]) * 0.5, base[2] + (1 - base[2]) * 0.5]));
    expect(autoLightAt(mk({ color: '#ffffff', near: 0, far: 10, amount: 0 }), 0).horizon).toBe('#336699');
    expect(autoLightAt(mk({ color: '#ffffff', near: 10, far: 10, amount: 1 }), 0).horizon).toBe('#336699');
    expect(autoLightAt(mk({ color: '#ffffff', near: 10, far: 5, amount: 1 }), 0).horizon).toBe('#336699');
  });

  it('reads a gradient rect under the lowest 3d clip: sky darker than horizon', () => {
    const { p, top, bottom } = twoTracks();
    p.clips = [fullRect(p, bottom), threeD(top)];
    const a = autoLightAt(p, 1);
    expect(hexSum(a.sky)).toBeLessThan(hexSum(a.horizon));
  });

  it('ignores a rect above the lowest 3d clip', () => {
    const { p, top, bottom } = twoTracks();
    p.background = '#336699';
    p.clips = [fullRect(p, top), threeD(bottom)];
    const a = autoLightAt(p, 1);
    expect(a.sky).toBe('#336699');
    expect(a.horizon).toBe('#336699');
  });

  it('ignores a hidden track and an unfilled shape', () => {
    const a = twoTracks();
    a.p.background = '#336699';
    a.p.tracks[1]!.hidden = true;
    a.p.clips = [fullRect(a.p, a.bottom), threeD(a.top)];
    expect(autoLightAt(a.p, 1).sky).toBe('#336699');
    const b = twoTracks();
    b.p.background = '#336699';
    b.p.clips = [fullRect(b.p, b.bottom, { filled: false }), threeD(b.top)];
    expect(autoLightAt(b.p, 1).sky).toBe('#336699');
  });

  it('ignores a shape that is not active at the time', () => {
    const { p, top, bottom } = twoTracks();
    p.background = '#336699';
    p.clips = [fullRect(p, bottom, { duration: 2 }), threeD(top)];
    expect(autoLightAt(p, 5).sky).toBe('#336699');
    expect(hexSum(autoLightAt(p, 1).sky)).not.toBe(hexSum('#336699'));
  });

  it('mixes a half opaque shape half way in srgb', () => {
    const { p, top, bottom } = twoTracks();
    const rect = createShapeClip(bottom, 0, { duration: 10, width: p.width, height: p.height, color: '#ffffff' });
    rect.transform = { ...rect.transform, opacity: 0.5 };
    p.clips = [rect, threeD(top)];
    const shapes = backdropShapes(p, 1);
    expect(shapes.length).toBe(1);
    const c = backdropColorAt(p, shapes, p.width / 2, p.height / 2);
    for (const v of c) expect(v).toBeCloseTo(0.5, 9);
  });

  it('an ellipse in the middle third changes the middle column point only', () => {
    const { p, top, bottom } = twoTracks();
    const e = createShapeClip(bottom, 0, { kind: 'ellipse', duration: 10, width: p.width / 3, height: p.height / 3, color: '#ffffff' });
    p.clips = [e, threeD(top)];
    const shapes = backdropShapes(p, 1);
    const at = (cx: number, cy: number) => backdropColorAt(p, shapes, cx * p.width, cy * p.height);
    expect(at(0.5, 0.5)).toEqual([1, 1, 1]);
    expect(at(0.3, 0.5)).toEqual([0, 0, 0]);
    expect(at(0.7, 0.5)).toEqual([0, 0, 0]);
    expect(at(0.5, 0.1)).toEqual([0, 0, 0]);
    expect(at(0.34, 0.34)).toEqual([0, 0, 0]);
  });

  it('a shape with a null color or a project with a null background does not throw', () => {
    const { p, top, bottom } = twoTracks();
    const rect = fullRect(p, bottom);
    (rect as { color: unknown }).color = null;
    (rect as { color2: unknown }).color2 = null;
    (p as { background: unknown }).background = null;
    p.clips = [rect, threeD(top)];
    expect(() => autoLightAt(p, 1)).not.toThrow();
    expect(() => sceneLightAt(p, 1)).not.toThrow();
  });

  it('ignores clips that are shown on a side of a solid', () => {
    const { p, top, bottom } = twoTracks();
    p.background = '#336699';
    const solid = threeD(top, { shape: 'box' });
    const rect = fullRect(p, bottom);
    solid.faces = { front: { clip: rect.id } };
    p.clips = [rect, solid];
    expect(autoLightAt(p, 1).sky).toBe('#336699');
  });
});

describe('sceneLightAt', () => {
  it('gives the rig of the own light when one is set', () => {
    const p = createProject('a');
    p.light = lightOf();
    expect(sceneLightAt(p, 0)).toBe(lightRigFrom(p.light));
  });

  it('gives the auto light otherwise, the same object for the same project and time', () => {
    const p = createProject('a');
    p.background = '#336699';
    const a = sceneLightAt(p, 0);
    expect(sceneLightAt(p, 0)).toBe(a);
    expect(sceneLightAt(p, 1)).not.toBe(a);
    const lin = hexToLinear('#336699');
    for (let i = 0; i < 3; i++) expect(a.env[i]!).toBeCloseTo(lin[i]!, 6);
  });
});

describe('usesLight', () => {
  it('is false without a 3d clip, with lit 0 and for a 2d clip', () => {
    const { p, top } = twoTracks();
    expect(usesLight(p)).toBe(false);
    p.clips = [threeD(top)];
    expect(usesLight(p)).toBe(false);
    p.clips = [threeD(top, { lit: 0 })];
    expect(usesLight(p)).toBe(false);
    p.clips = [createShapeClip(top, 0, { lit: 0.5 })];
    expect(usesLight(p)).toBe(false);
  });

  it('is true for lit above 0 and for keys on lit', () => {
    const { p, top } = twoTracks();
    p.clips = [threeD(top, { lit: 0.5 })];
    expect(usesLight(p)).toBe(true);
    p.clips = [threeD(top, { keyframes: { lit: [{ t: 0, v: 0, ease: 'linear' }] } })];
    expect(usesLight(p)).toBe(true);
  });

  it('reads a new clips array again', () => {
    const { p, top } = twoTracks();
    p.clips = [threeD(top)];
    expect(usesLight(p)).toBe(false);
    p.clips = [threeD(top, { lit: 0.75 })];
    expect(usesLight(p)).toBe(true);
    p.clips = [];
    expect(usesLight(p)).toBe(false);
  });
});

describe('auto light cache', () => {
  /** the same scene worked out with nothing remembered: a copy of the project is a new object, so it never hits */
  const fresh = (p: Project, t: number) => autoLightAt({ ...p }, t);

  it('a static backdrop gives the same numbers at other times without working them out again', () => {
    const { p, top, bottom } = twoTracks();
    p.clips = [fullRect(p, bottom), threeD(top, { lit: 0.75 })];
    const a = sceneLightAt(p, 1);
    const b = sceneLightAt(p, 2.5);
    const c = sceneLightAt(p, 7);
    expect(b.env).toBe(a.env);
    expect(c.env).toBe(a.env);
    expect(sceneLightAt(p, 2.5)).toBe(b);
  });

  it('gives the same result as the uncached path over changing times', () => {
    const { p, top, bottom } = twoTracks();
    p.clips = [fullRect(p, bottom, { duration: 4 }), threeD(top, { lit: 0.75 })];
    for (let i = 0; i < 40; i++) {
      const t = i * 0.25;
      expect(autoLightAt(p, t)).toEqual(fresh(p, t));
      expect(Array.from(sceneLightAt(p, t).env)).toEqual(Array.from(sceneLightAt({ ...p }, t).env));
    }
  });

  it('sees the backdrop when a shape ends and starts', () => {
    const { p, top, bottom } = twoTracks();
    p.background = '#336699';
    const late = fullRect(p, bottom, { start: 3, duration: 2 });
    p.clips = [late, threeD(top, { lit: 0.75 })];
    expect(autoLightAt(p, 1).sky).toBe('#336699');
    expect(autoLightAt(p, 4).sky).not.toBe('#336699');
    expect(autoLightAt(p, 6).sky).toBe('#336699');
    expect(autoLightAt(p, 1.5).sky).toBe('#336699');
  });

  it('sees a keyed, a fading and a moved backdrop shape', () => {
    const { p, top, bottom } = twoTracks();
    p.background = '#000000';
    const rect = createShapeClip(bottom, 0, { duration: 10, width: p.width / 6, height: p.height, color: '#ffffff' });
    rect.transform = { ...rect.transform, x: -p.width * 0.4 };
    rect.keyframes = {
      scale: [
        { t: 0, v: 1, ease: 'linear' },
        { t: 8, v: 5, ease: 'linear' },
      ],
    };
    p.clips = [rect, threeD(top, { lit: 0.75 })];
    const h0 = autoLightAt(p, 0).horizon;
    const h4 = autoLightAt(p, 4).horizon;
    const h8 = autoLightAt(p, 8).horizon;
    expect(h0).not.toBe(h4);
    expect(h4).not.toBe(h8);
    for (const t of [0, 1, 2, 4, 6, 8, 3.3]) expect(autoLightAt(p, t)).toEqual(fresh(p, t));
    const fade = fullRect(p, bottom, { color: '#ffffff', color2: undefined });
    fade.fadeIn = 4;
    p.clips = [fade, threeD(top, { lit: 0.75 })];
    expect(autoLightAt(p, 1).sky).not.toBe(autoLightAt(p, 3).sky);
    expect(autoLightAt(p, 1)).toEqual(fresh(p, 1));
  });

  it('a changed project is not answered from the old one', () => {
    const { p, top, bottom } = twoTracks();
    p.clips = [fullRect(p, bottom), threeD(top, { lit: 0.75 })];
    const before = autoLightAt(p, 1);
    const q = { ...p, clips: [fullRect(p, bottom, { color: '#ff0000', color2: '#ff0000' }), threeD(top, { lit: 0.75 })] };
    expect(autoLightAt(q, 1)).not.toEqual(before);
    expect(autoLightAt(p, 1)).toEqual(before);
  });
});

describe('shape colors in the auto light', () => {
  const sky = (color: string, color2?: string) => {
    const { p, top, bottom } = twoTracks();
    p.background = '#336699';
    p.clips = [createShapeClip(bottom, 0, { duration: 10, width: p.width, height: p.height, color, color2 }), threeD(top)];
    return autoLightAt(p, 1);
  };

  it('reads rgb() and hsl() like the screen does', () => {
    expect(sky('#ff0000').sky).toBe('#ff0000');
    expect(sky('rgb(255, 0, 0)').sky).toBe('#ff0000');
    expect(sky('rgba(255 0 0 / 100%)').sky).toBe('#ff0000');
    expect(sky('hsl(0, 100%, 50%)').sky).toBe('#ff0000');
    expect(sky('hsl(120deg 100% 50%)').sky).toBe('#00ff00');
  });

  it('takes the alpha of a color into account', () => {
    expect(sky('#ff000000').sky).toBe('#336699');
    expect(sky('#f000').sky).toBe('#336699');
    expect(sky('#ff0000ff').sky).toBe('#ff0000');
    expect(sky('rgba(255, 0, 0, 0)').sky).toBe('#336699');
    expect(sky('rgba(255, 0, 0, 0.5)').sky).not.toBe('#336699');
    expect(sky('rgba(255, 0, 0, 0.5)').sky).not.toBe('#ff0000');
  });

  it('leaves a color it cannot read out of the light, never black', () => {
    expect(sky('rgb(1, 2)').sky).toBe('#336699');
    expect(sky('rgb(a, b, c)').sky).toBe('#336699');
    expect(sky('#ff0000', 'banana').sky).toBe('#ff0000');
  });
});
