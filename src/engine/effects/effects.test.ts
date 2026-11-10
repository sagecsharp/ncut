import { describe, expect, it } from 'vitest';
import { MAIN, PRELUDE } from './glsl';
import { EFFECTS, effectParamValue, effectsInCategory, getEffect } from './registry';
import { checkEffects, effectsSupported, fragmentSource, renderEffects } from './runner';
import { EFFECT_CATEGORIES } from './types';
import type { EffectDef, EffectPass } from './types';

const CATEGORY_IDS = EFFECT_CATEGORIES.map((c) => c.id);
const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const KEY = /^[a-z][a-zA-Z0-9]*$/;
const PRELUDE_NAMES = [
  'tex',
  'aspect',
  'sat',
  'hash11',
  'hash21',
  'hash22',
  'hash31',
  'noise1',
  'snoise1',
  'noise2',
  'fbm',
  'rot',
  'luma',
  'hsv2rgb',
  'rgb2hsv',
  'xform',
];

const isLower = (s: string) => s === s.toLowerCase();

/** glsl without comments, so words in comments do not count as code */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/** keys of every p_<key> uniform the code mentions */
function usedParamKeys(glsl: string): Set<string> {
  const out = new Set<string>();
  for (const m of stripComments(glsl).matchAll(/\bp_([A-Za-z0-9_]+)\b/g)) out.add(m[1]!);
  return out;
}

function balanced(src: string, open: string, close: string): boolean {
  let depth = 0;
  for (const ch of src) {
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

function fake(over: Partial<EffectDef> = {}): EffectDef {
  return {
    id: 'fake',
    name: 'fake',
    category: 'motion',
    description: 'a fake effect',
    params: [
      { key: 'strength', label: 'strength', min: 0, max: 100, step: 1, default: 30 },
      { key: 'fooBar2', label: 'foo bar', min: -1, max: 1, step: 0.1, default: 0 },
    ],
    glsl: 'vec4 effect(vec2 uv) { return tex(uv) * (p_strength + p_fooBar2); }',
    ...over,
  };
}

describe('effects registry', () => {
  it('has at least one effect', () => {
    expect(EFFECTS.length).toBeGreaterThan(0);
  });

  it('ids are unique', () => {
    const ids = EFFECTS.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('category list has no duplicates', () => {
    expect(new Set(CATEGORY_IDS).size).toBe(CATEGORY_IDS.length);
  });

  describe.each(EFFECTS.map((e) => [e.id, e] as const))('effect %s', (_id, def) => {
    it('has a lowercase kebab id', () => {
      expect(def.id).toMatch(KEBAB);
    });

    it('has a non-empty lowercase name and description', () => {
      expect(def.name.trim().length).toBeGreaterThan(0);
      expect(isLower(def.name)).toBe(true);
      expect(def.description.trim().length).toBeGreaterThan(0);
      expect(isLower(def.description)).toBe(true);
    });

    it('has a known category', () => {
      expect(CATEGORY_IDS).toContain(def.category);
    });

    it('has a valid poster time when given', () => {
      if (def.posterTime !== undefined) {
        expect(Number.isFinite(def.posterTime)).toBe(true);
        expect(def.posterTime).toBeGreaterThanOrEqual(0);
      }
    });

    it('defines vec4 effect(vec2 uv)', () => {
      expect(def.glsl).toContain('vec4 effect(vec2 uv)');
    });

    it('does not use gl_FragCoord or derivatives', () => {
      const code = stripComments(def.glsl);
      expect(code).not.toContain('gl_FragCoord');
      expect(code).not.toContain('dFdx');
      expect(code).not.toContain('dFdy');
    });

    it('has balanced braces and parentheses', () => {
      const code = stripComments(def.glsl);
      expect(balanced(code, '{', '}')).toBe(true);
      expect(balanced(code, '(', ')')).toBe(true);
      expect(balanced(code, '[', ']')).toBe(true);
    });

    it('does not redeclare prelude functions', () => {
      const code = stripComments(def.glsl);
      for (const name of PRELUDE_NAMES) {
        const re = new RegExp(`\\b(?:float|int|bool|void|vec[234]|ivec[234]|mat[234])\\s+${name}\\s*\\(`);
        expect(re.test(code), `redeclares ${name}`).toBe(false);
      }
    });

    it('has valid params', () => {
      const keys = def.params.map((p) => p.key);
      expect(new Set(keys).size).toBe(keys.length);
      for (const p of def.params) {
        expect(p.key, `key ${p.key}`).toMatch(KEY);
        expect(p.label.trim().length, `label of ${p.key}`).toBeGreaterThan(0);
        expect(isLower(p.label), `label of ${p.key} is lowercase`).toBe(true);
        for (const n of [p.min, p.max, p.step, p.default]) expect(Number.isFinite(n), `${p.key} numbers`).toBe(true);
        expect(p.min, `${p.key} min < max`).toBeLessThan(p.max);
        expect(p.step, `${p.key} step > 0`).toBeGreaterThan(0);
        expect(p.default, `${p.key} default >= min`).toBeGreaterThanOrEqual(p.min);
        expect(p.default, `${p.key} default <= max`).toBeLessThanOrEqual(p.max);
        if (p.unit !== undefined) expect(isLower(p.unit)).toBe(true);
      }
    });

    it('declares every p_ uniform it uses and uses every declared param', () => {
      const used = usedParamKeys(def.glsl);
      const declared = new Set(def.params.map((p) => p.key));
      for (const k of used) expect(declared.has(k), `p_${k} is used but not declared in params`).toBe(true);
      for (const k of declared) expect(used.has(k), `param ${k} is declared but p_${k} is not used`).toBe(true);
    });

    it('builds a fragment source', () => {
      const src = fragmentSource(def);
      expect(src).toContain(def.glsl);
      expect(src.startsWith('#version 300 es')).toBe(true);
    });
  });

  it('getEffect finds every effect and nothing else', () => {
    for (const e of EFFECTS) expect(getEffect(e.id)).toBe(e);
    expect(getEffect('nope')).toBeUndefined();
    expect(getEffect('')).toBeUndefined();
    expect(getEffect('SHAKE')).toBeUndefined();
  });

  it('effectsInCategory filters by category and keeps registry order', () => {
    let total = 0;
    for (const cat of EFFECT_CATEGORIES) {
      const list = effectsInCategory(cat.id);
      total += list.length;
      expect(list.every((e) => e.category === cat.id)).toBe(true);
      expect(list).toEqual(EFFECTS.filter((e) => e.category === cat.id));
    }
    expect(total).toBe(EFFECTS.length);
    expect(effectsInCategory('nope' as never)).toEqual([]);
  });

  it('shake lives in the motion category', () => {
    expect(effectsInCategory('motion').map((e) => e.id)).toContain('shake');
  });
});

describe('effectParamValue', () => {
  const def = fake();
  it('falls back to the default when missing', () => {
    expect(effectParamValue(def, {}, 'strength')).toBe(30);
    expect(effectParamValue(def, {}, 'fooBar2')).toBe(0);
  });
  it('returns saved values inside the range', () => {
    expect(effectParamValue(def, { strength: 55 }, 'strength')).toBe(55);
    expect(effectParamValue(def, { fooBar2: -0.5 }, 'fooBar2')).toBe(-0.5);
    expect(effectParamValue(def, { strength: 0 }, 'strength')).toBe(0);
  });
  it('clamps to the range', () => {
    expect(effectParamValue(def, { strength: 500 }, 'strength')).toBe(100);
    expect(effectParamValue(def, { strength: -500 }, 'strength')).toBe(0);
    expect(effectParamValue(def, { fooBar2: -9 }, 'fooBar2')).toBe(-1);
  });
  it('uses the default for NaN and infinity', () => {
    expect(effectParamValue(def, { strength: NaN }, 'strength')).toBe(30);
    expect(effectParamValue(def, { strength: Infinity }, 'strength')).toBe(30);
    expect(effectParamValue(def, { strength: -Infinity }, 'strength')).toBe(30);
  });
  it('uses the default for non numbers', () => {
    expect(effectParamValue(def, { strength: '5' as unknown as number }, 'strength')).toBe(30);
    expect(effectParamValue(def, { strength: null as unknown as number }, 'strength')).toBe(30);
  });
  it('returns 0 for an unknown key', () => {
    expect(effectParamValue(def, { nope: 4 }, 'nope')).toBe(0);
    expect(effectParamValue(def, {}, 'nope')).toBe(0);
  });
  it('works on the real defs', () => {
    for (const e of EFFECTS) {
      for (const p of e.params) {
        expect(effectParamValue(e, {}, p.key)).toBe(p.default);
        expect(effectParamValue(e, { [p.key]: p.max + 1e6 }, p.key)).toBe(p.max);
        expect(effectParamValue(e, { [p.key]: p.min - 1e6 }, p.key)).toBe(p.min);
      }
    }
  });
});

describe('fragmentSource', () => {
  it('contains the prelude, the uniforms, the glsl and a main in that order', () => {
    const def = fake();
    const src = fragmentSource(def);
    expect(src).toContain(PRELUDE);
    expect(src).toContain(def.glsl);
    expect(src).toContain(MAIN);
    expect(src).toContain('void main()');
    const iPrelude = src.indexOf(PRELUDE);
    const iUniform = src.indexOf('uniform float p_strength;');
    const iGlsl = src.indexOf(def.glsl);
    const iMain = src.lastIndexOf(MAIN);
    expect(iPrelude).toBe(0);
    expect(iUniform).toBeGreaterThan(iPrelude);
    expect(iGlsl).toBeGreaterThan(iUniform);
    expect(iMain).toBeGreaterThan(iGlsl);
  });
  it('declares exactly one uniform float per param', () => {
    const def = fake();
    const src = fragmentSource(def);
    for (const p of def.params) {
      const count = src.split(`uniform float p_${p.key};`).length - 1;
      expect(count).toBe(1);
    }
    const afterPrelude = src.slice(PRELUDE.length);
    expect(afterPrelude.match(/uniform float p_/g)).toHaveLength(def.params.length);
  });
  it('declares no param uniforms for an effect without params', () => {
    const src = fragmentSource(fake({ params: [], glsl: 'vec4 effect(vec2 uv) { return tex(uv); }' }));
    expect(src.slice(PRELUDE.length)).not.toContain('uniform float p_');
  });
  it('throws on a bad param key', () => {
    for (const key of ['', 'Upper', '1abc', 'a-b', 'a b', 'a_b', 'x;y']) {
      const def = fake({ params: [{ key, label: 'x', min: 0, max: 1, step: 0.1, default: 0 }] });
      expect(() => fragmentSource(def), `key "${key}"`).toThrow(/bad param key/);
    }
  });
  it('works for every registered effect', () => {
    for (const e of EFFECTS) {
      const src = fragmentSource(e);
      for (const p of e.params) expect(src).toContain(`uniform float p_${p.key};`);
    }
  });
});

describe('runner without webgl (node)', () => {
  const pass = (): EffectPass => ({ def: fake(), time: 0, duration: 1, amount: 1, seed: 1, params: {} });
  const source = { tag: 'src' } as unknown as TexImageSource;

  it('renderEffects returns null for empty passes', () => {
    expect(renderEffects(source, 100, 100, [])).toBeNull();
  });
  it('renderEffects returns null when webgl2 is missing', () => {
    expect(renderEffects(source, 100, 100, [pass()])).toBeNull();
    expect(renderEffects(source, 100, 100, [pass()], { channel: 'export' })).toBeNull();
  });
  it('renderEffects returns null for an empty size', () => {
    expect(renderEffects(source, 0, 100, [pass()])).toBeNull();
    expect(renderEffects(source, 100, 0, [pass()])).toBeNull();
  });
  it('effectsSupported is false', () => {
    expect(effectsSupported()).toBe(false);
  });
  it('checkEffects reports webgl missing', () => {
    expect(checkEffects(EFFECTS)).toEqual([{ id: '*', error: 'webgl2 is not available' }]);
    expect(checkEffects([])).toEqual([{ id: '*', error: 'webgl2 is not available' }]);
  });
});
