import { describe, expect, it } from 'vitest';
import { createProject } from '../../lib/factory';
import type { MediaAsset, Project, SceneLight, SceneSky } from '../../types';
import { autoLightAt, hexToLinear, lightRigFrom, linearToHex, sceneLightAt, skyLightOf } from './light';

const img = (id: string, name: string, w: number, h: number): MediaAsset => ({ id, name, kind: 'image', mime: 'image/png', size: 1, duration: 0, width: w, height: h, hasAudio: false, createdAt: 0 });
const LIGHT: SceneLight = { sky: '#8090a0', horizon: '#808080', ground: '#404040', sun: 0.5, sunColor: '#fff4e0', sunTurn: -35, sunHeight: 45 };
const skyOf = (over: Partial<SceneSky> = {}): SceneSky => ({ asset: 'a1', turn: 0, brightness: 1, blur: 0, light: LIGHT, ...over });

function make(over: Partial<Project> = {}): Project {
  const p = createProject('t');
  p.background = '#336699';
  p.assets = [img('a1', 'sky', 1024, 768)];
  return { ...p, ...over };
}
const env = (p: Project) => Array.from(sceneLightAt(p, 0).env);

describe('light from the sky', () => {
  it('without a sky the light is what it was', () => {
    const never = make();
    delete never.sky;
    expect(env(make({ sky: undefined }))).toEqual(env(never));
    expect(env(make({ sky: null }))).toEqual(env(never));
    expect(autoLightAt(make({ sky: null }), 0)).toEqual(autoLightAt(never, 0));
  });

  it('a usable sky gives its light to lit planes', () => {
    const p = make({ sky: skyOf() });
    expect(env(p)).toEqual(Array.from(lightRigFrom(skyLightOf(p)!).env));
    expect(env(p)).toEqual(Array.from(lightRigFrom(LIGHT).env));
    expect(env(p)).not.toEqual(env(make()));
  });

  it('an own light still wins over the sky', () => {
    const own: SceneLight = { ...LIGHT, sky: '#ff0000' };
    const p = make({ sky: skyOf(), light: own });
    expect(sceneLightAt(p, 0)).toBe(lightRigFrom(own));
  });

  it('a sky whose picture is gone falls back to the scene', () => {
    const p = make({ sky: skyOf(), assets: [] });
    expect(skyLightOf(p)).toBeNull();
    expect(env(p)).toEqual(env(make({ assets: [] })));
  });

  it('a broken light on the sky falls back to the scene', () => {
    const p = make({ sky: skyOf({ light: { sky: 1 } as unknown as SceneLight }) });
    expect(skyLightOf(p)).toBeNull();
    expect(env(p)).toEqual(env(make()));
    expect(skyLightOf(make({ sky: skyOf({ light: undefined as unknown as SceneLight }) }))).toBeNull();
  });

  it('brightness 1, turn 0 and no fog give the stored light', () => {
    expect(skyLightOf(make({ sky: skyOf() }))).toEqual(LIGHT);
  });

  it('the turn of the sky turns the sun', () => {
    expect(skyLightOf(make({ sky: skyOf({ turn: 90 }) }))!.sunTurn).toBe(55);
    expect(skyLightOf(make({ sky: skyOf({ turn: 30, light: { ...LIGHT, sunTurn: 170 } }) }))!.sunTurn).toBe(-160);
    expect(skyLightOf(make({ sky: skyOf({ turn: 90 }) }))!.sunHeight).toBe(45);
  });

  it('brightness scales the colors in linear light and stops at white', () => {
    const k = Math.pow(0.5, 2.2);
    const half = skyLightOf(make({ sky: skyOf({ brightness: 0.5 }) }))!;
    const want = (hex: string) => {
      const c = hexToLinear(hex);
      return linearToHex([c[0] * k, c[1] * k, c[2] * k]);
    };
    expect(half.sky).toBe(want(LIGHT.sky));
    expect(half.horizon).toBe(want(LIGHT.horizon));
    expect(half.ground).toBe(want(LIGHT.ground));
    expect(half.sunColor).toBe(want(LIGHT.sunColor));
    const white = skyLightOf(make({ sky: skyOf({ brightness: 2, light: { ...LIGHT, sky: '#ffffff' } }) }))!;
    expect(white.sky).toBe('#ffffff');
    expect(skyLightOf(make({ sky: skyOf({ brightness: 0 }) }))!.sky).toBe('#000000');
  });

  it('fog mixes the horizon like the scene light', () => {
    const fog = { color: '#ff0000', near: 0, far: 1000, amount: 0.5 };
    const l = skyLightOf(make({ sky: skyOf(), fog }))!;
    const h = hexToLinear(LIGHT.horizon);
    const f = hexToLinear(fog.color);
    expect(l.horizon).toBe(linearToHex([h[0] + (f[0] - h[0]) * 0.5, h[1] + (f[1] - h[1]) * 0.5, h[2] + (f[2] - h[2]) * 0.5]));
    expect(l.sky).toBe(LIGHT.sky);
    // a fog that is off changes nothing
    expect(skyLightOf(make({ sky: skyOf(), fog: { ...fog, amount: 0 } }))).toEqual(LIGHT);
  });

  it('the same project data gives the same light object', () => {
    const p = make({ sky: skyOf({ brightness: 0.8 }) });
    const a = skyLightOf(p);
    expect(skyLightOf({ ...p })).toBe(a);
    expect(sceneLightAt(p, 0)).toBe(sceneLightAt({ ...p }, 5));
    // another media list is worked out again
    const other = skyLightOf({ ...p, assets: [...p.assets] });
    expect(other).not.toBe(a);
    expect(other).toEqual(a);
  });

  it('autoLightAt gives the sky dome', () => {
    const p = make({ sky: skyOf() });
    expect(autoLightAt(p, 0)).toEqual({ sky: LIGHT.sky, horizon: LIGHT.horizon, ground: LIGHT.ground });
  });
});
