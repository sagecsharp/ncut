import { describe, expect, it } from 'vitest';
import { meshNeedsBlur } from './focus';
import { identity, mul, scaling, translation } from './math';
import { LIGHT_GAMMA, planeLight } from './light';
import { BENT_VS, LIGHT_LINE, LIT_VS, OUTLINE_CACHE_LIMIT, PLANE_FS, SKY_FS, SKY_VS, bentNeedsBlur, canReuseScratch, lightUniform, litFragment, lruOverflow, outlineKey, planeNeedsBlur, skyCubeSize, skyLevels, stackedTexelAlpha, uvWrapsU } from './renderer';

// a camera at the origin looking down +z: depth = z (w = z), no perspective needed for the depth test
const viewProj = (() => {
  const m = new Float32Array(16);
  m[0] = 1;
  m[5] = 1;
  m[10] = 1;
  m[11] = 1; // w = z
  return m;
})();
const focus = { distance: 1000, strength: 1, range: 50 };

describe('planeNeedsBlur', () => {
  it('a flat plane exactly in focus needs no blur', () => {
    const model = mul(translation(0, 0, 1000), scaling(400, 300, 1));
    expect(planeNeedsBlur(model, viewProj, focus)).toBe(false);
    // the bounding sphere would have said yes (a 500 wide sphere does not fit the 50 range)
    expect(meshNeedsBlur(model, viewProj, focus)).toBe(true);
  });
  it('a plane outside the sharp range needs it', () => {
    expect(planeNeedsBlur(mul(translation(0, 0, 1200), scaling(100, 100, 1)), viewProj, focus)).toBe(true);
    expect(planeNeedsBlur(mul(translation(0, 0, 900), scaling(100, 100, 1)), viewProj, focus)).toBe(true);
  });
  it('a tilted plane that reaches out of the range at one end needs it', () => {
    // 200 px edge along z: its ends sit 100 px from the center, beyond the range of 50
    const tilted = new Float32Array(identity());
    tilted[10] = 1;
    tilted[0] = 0;
    tilted[2] = 200; // the x edge now runs along z
    tilted[14] = 1000;
    expect(planeNeedsBlur(tilted, viewProj, focus)).toBe(true);
    tilted[2] = 60; // ends at 30 px: inside
    expect(planeNeedsBlur(tilted, viewProj, focus)).toBe(false);
  });
  it('no focus, no blur', () => {
    expect(planeNeedsBlur(identity(), viewProj, null)).toBe(false);
  });
});

describe('uvWrapsU', () => {
  it('the round shapes wrap, the flat ones do not', () => {
    for (const s of ['sphere', 'cylinder', 'capsule'] as const) expect(uvWrapsU(s)).toBe(true);
    for (const s of ['plane', 'box', 'pyramid'] as const) expect(uvWrapsU(s)).toBe(false);
  });
});

describe('stackedTexelAlpha', () => {
  const composite = (per: number, n: number) => 1 - Math.pow(1 - per, n);
  it('n planes with the corrected alpha composite to the texel alpha, not to 1 - (1 - a)^n', () => {
    for (const n of [4, 10, 48]) {
      for (const a of [0.02, 0.1, 0.5, 0.9]) {
        expect(composite(stackedTexelAlpha(a, n), n)).toBeCloseTo(a, 9);
        // the old way: the uncorrected stack is far more solid than the texel
        if (a <= 0.5) expect(composite(a, n)).toBeGreaterThan(a + 0.05);
      }
    }
  });
  it('opaque stays opaque, empty stays empty, one plane is unchanged', () => {
    expect(stackedTexelAlpha(1, 10)).toBe(1);
    expect(stackedTexelAlpha(0, 10)).toBe(0);
    expect(stackedTexelAlpha(Number.NaN, 10)).toBe(0);
    expect(stackedTexelAlpha(0.4, 1)).toBe(0.4);
  });
  it('a clip at opacity o composites to texel alpha x o (the shader corrects the product)', () => {
    const o = 0.5;
    const a = 0.8;
    expect(composite(stackedTexelAlpha(a * o, 20), 20)).toBeCloseTo(0.4, 9);
  });
});

describe('outline cache', () => {
  it('the key tells shape, the three sizes and the width apart', () => {
    const k = outlineKey('box', 100, 50, 25, 4);
    expect(outlineKey('box', 100, 50, 25, 4)).toBe(k);
    expect(outlineKey('sphere', 100, 50, 25, 4)).not.toBe(k);
    expect(outlineKey('box', 101, 50, 25, 4)).not.toBe(k);
    expect(outlineKey('box', 100, 51, 25, 4)).not.toBe(k);
    expect(outlineKey('box', 100, 50, 26, 4)).not.toBe(k);
    expect(outlineKey('box', 100, 50, 25, 4.5)).not.toBe(k);
  });
  it('drops the oldest keys past the limit and nothing below it', () => {
    const keys = Array.from({ length: OUTLINE_CACHE_LIMIT + 3 }, (_, i) => 'k' + i);
    expect(lruOverflow(keys, keys.length, OUTLINE_CACHE_LIMIT)).toEqual(['k0', 'k1', 'k2']);
    expect(lruOverflow(keys.slice(0, OUTLINE_CACHE_LIMIT), OUTLINE_CACHE_LIMIT, OUTLINE_CACHE_LIMIT)).toEqual([]);
  });
});

describe('the lit plane shader', () => {
  const lit = litFragment(PLANE_FS);
  const count = (hay: string, needle: string) => hay.split(needle).length - 1;
  it('has its inputs and the light line once', () => {
    expect(count(lit, 'uniform vec4 u_light;')).toBe(1);
    expect(count(lit, 'in vec3 v_light;')).toBe(1);
    expect(count(lit, LIGHT_LINE)).toBe(1);
  });
  it('the light line sits after the last discard and before the fog', () => {
    expect(lit.indexOf(LIGHT_LINE)).toBeGreaterThan(lit.lastIndexOf('discard;'));
    expect(lit.indexOf(LIGHT_LINE)).toBeLessThan(lit.indexOf('  if (u_fogOn > 0.0) {'));
  });
  it('without the two insertions it is the plane shader again', () => {
    expect(lit.replace('uniform vec4 u_light;\nin vec3 v_light;\n', '').replace(LIGHT_LINE, '')).toBe(PLANE_FS);
  });
  it('the plane shader knows nothing of light', () => {
    expect(PLANE_FS).not.toContain('u_light');
  });
  it('throws when an anchor is gone', () => {
    expect(() => litFragment('void main() {}')).toThrow();
  });
  it('the vertex shader has its normal, its outputs and the same gamma as light.ts', () => {
    expect(LIT_VS).toContain('layout(location = 2) in vec3 a_normal;');
    for (const o of ['out vec3 v_light;', 'out vec2 v_uv;', 'out vec3 v_world;', 'out float v_depth;']) expect(LIT_VS).toContain(o);
    expect(LIT_VS).toContain('1.0 / ' + LIGHT_GAMMA.toFixed(1));
  });
});

describe('canReuseScratch', () => {
  const img = {};
  it('keeps an upload only for the same serial, image and mips', () => {
    expect(canReuseScratch(img, 3, false, img, 3, false)).toBe(true);
    expect(canReuseScratch(img, undefined, false, img, undefined, false)).toBe(false);
    expect(canReuseScratch(img, 3, false, img, undefined, false)).toBe(false);
    expect(canReuseScratch(img, 3, false, img, 4, false)).toBe(false);
    expect(canReuseScratch(img, 3, false, {}, 3, false)).toBe(false);
    expect(canReuseScratch(img, 3, false, img, 3, true)).toBe(false);
    expect(canReuseScratch(null, undefined, false, img, 3, false)).toBe(false);
  });
});

describe('lightUniform', () => {
  const env = new Float32Array([0.3, 0.4, 0.6, 0.5, 0.45, 0.4, 0.1, 0.1, 0.1, 0, -1, 0, 0.2, 0.2, 0.1]);
  const model = identity();
  const eye = [0, 0, -10];
  const run = (lit: number | undefined, shape: 'plane' | 'box') => {
    const out = new Float32Array(4);
    lightUniform(lit, shape, model, eye, env, out);
    return [...out];
  };
  it('no light, a zero, a negative or a nan lit is unlit', () => {
    for (const v of [undefined, 0, -1, NaN]) expect(run(v, 'plane')).toEqual([1, 1, 1, 0]);
    for (const v of [undefined, 0, -1, NaN]) expect(run(v, 'box')).toEqual([1, 1, 1, 0]);
  });
  it('a lit solid is lit in the vertex shader, with the amount clamped', () => {
    expect(run(0.5, 'box')).toEqual([1, 1, 1, 0.5]);
    expect(run(3, 'box')).toEqual([1, 1, 1, 1]);
  });
  it('a lit plane gets its own light with w 0', () => {
    const want = new Float32Array(4);
    planeLight(model, eye, 0.5, env, want);
    want[3] = 0;
    expect(run(0.5, 'plane')).toEqual([...want]);
  });
});

describe('sky', () => {
  it('SKY_VS draws one triangle from u_ray and gl_VertexID', () => {
    expect(SKY_VS).toContain('uniform mat3 u_ray;');
    expect(SKY_VS).toContain('gl_VertexID');
    expect(SKY_VS).toContain('v_dir = u_ray * vec3(p, 1.0);');
  });
  it('SKY_FS samples the cube with the blur as a bias and keeps the color under its alpha', () => {
    expect(SKY_FS).toContain('uniform samplerCube u_sky;');
    expect(SKY_FS).toContain('texture(u_sky, v_dir, u_bias)');
    expect(SKY_FS).toContain('min(c.rgb * u_gain, vec3(c.a))');
  });
  it('the plane and lit shaders do not know the sky', () => {
    for (const src of [PLANE_FS, LIT_VS, litFragment(PLANE_FS)]) {
      expect(src).not.toContain('u_sky');
      expect(src).not.toContain('samplerCube');
    }
  });
  it('skyCubeSize takes the smallest of the picture, the channel and the gpu', () => {
    expect(skyCubeSize(2048, 512, 16384)).toBe(512);
    expect(skyCubeSize(1000, 2048, 0)).toBe(1000);
    expect(skyCubeSize(4096, 2048, 1024)).toBe(1024);
    expect(skyCubeSize(0.4, 2048, 0)).toBe(1);
  });
  it('skyLevels counts the mips down to 1', () => {
    expect(skyLevels(2048)).toBe(12);
    expect(skyLevels(1000)).toBe(10);
    expect(skyLevels(1)).toBe(1);
    expect(skyLevels(0)).toBe(1);
  });
});

describe('bent program', () => {
  it('BENT_VS reads bp for both positions and bn for the normal', () => {
    expect(BENT_VS).toContain('vec3 bp = bendPos(a_pos, bn);');
    // v_world, gl_Position and the eye test of the normal
    expect(BENT_VS.split('vec4(bp, 1.0)').length - 1).toBe(3);
    expect(BENT_VS).not.toContain('vec4(a_pos, 1.0)');
    expect(BENT_VS).toContain('* bn *');
    expect(BENT_VS).not.toContain('* a_normal *');
    expect(BENT_VS).toContain('uniform vec4 u_bend;');
    // the fragment shader is the lit one: it still links with the same varyings
    expect(LIT_VS).not.toContain('bendPos');
  });
});

describe('lightUniform with a bent plane', () => {
  const env = new Float32Array([0.3, 0.4, 0.6, 0.5, 0.45, 0.4, 0.1, 0.1, 0.1, 0, -1, 0, 0.2, 0.2, 0.1]);
  const model = identity();
  const eye = [0, 0, -10];
  it('gives a bent plane (1, 1, 1, k) and a flat one planeLight', () => {
    const bent = new Float32Array(4);
    lightUniform(0.5, 'plane', model, eye, env, bent, true);
    expect([...bent]).toEqual([1, 1, 1, 0.5]);
    const flat = new Float32Array(4);
    lightUniform(0.5, 'plane', model, eye, env, flat);
    const want = new Float32Array(4);
    planeLight(model, eye, 0.5, env, want);
    want[3] = 0;
    expect([...flat]).toEqual([...want]);
    // unlit stays unlit, bent or not
    lightUniform(undefined, 'plane', model, eye, new Float32Array(15), bent, true);
    expect([...bent]).toEqual([1, 1, 1, 0]);
  });
});

describe('bentNeedsBlur', () => {
  const flatBox = [-0.5, 0.5, -0.5, 0.5, 0, 0];
  it('equals planeNeedsBlur for a flat box', () => {
    for (const z of [800, 940, 1000, 1040, 1200]) {
      for (const [w, h] of [[100, 100], [400, 300], [20, 20]]) {
        const model = mul(translation(0, 0, z), scaling(w!, h!, 1));
        expect(bentNeedsBlur(model, flatBox, viewProj, focus)).toBe(planeNeedsBlur(model, viewProj, focus));
      }
    }
    expect(bentNeedsBlur(identity(), flatBox, viewProj, null)).toBe(false);
  });
  it('sees bent ends that leave the sharp range', () => {
    const model = mul(translation(0, 0, 1000), scaling(400, 300, 1));
    expect(bentNeedsBlur(model, flatBox, viewProj, focus)).toBe(false);
    // the ends come 80 px toward the viewer (z is px, the model keeps z at scale 1): out of the range of 50
    expect(bentNeedsBlur(model, [-0.5, 0.5, -0.5, 0.5, -80, 0], viewProj, focus)).toBe(true);
    // 30 px stays inside
    expect(bentNeedsBlur(model, [-0.5, 0.5, -0.5, 0.5, -30, 0], viewProj, focus)).toBe(false);
    // and away from the viewer
    expect(bentNeedsBlur(model, [-0.5, 0.5, -0.5, 0.5, 0, 80], viewProj, focus)).toBe(true);
  });
});
