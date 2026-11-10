import { describe, expect, it } from 'vitest';
import { GLSL_PACK2 } from './defs2';
import { GLSL_3D } from './defs3d';
import { TRANSITION_GLSL } from './defs';
import { getTransition, transitionsInCategory, TRANSITIONS, TRANSITION_CATEGORIES } from './registry';
import { easeTransition, transitionFragmentSource } from './runner';
import { wrapAll, wrapTransition } from './wrap';

const OLD_IDS = [
  'cross-fade', 'dip-black', 'dip-white', 'blur-fade', 'dissolve',
  'slide-left', 'slide-right', 'slide-up', 'slide-down',
  'push-left', 'push-right', 'push-up', 'push-down',
  'whip-left', 'whip-right', 'zoom-in', 'zoom-out', 'spin',
  'wipe-left', 'wipe-right', 'wipe-up', 'wipe-down', 'iris', 'clock', 'blinds', 'checker',
  'glitch', 'pixelate', 'rgb-split', 'flash', 'ripple',
];

const NEW_3D = [
  'cube-left', 'cube-right', 'cube-up', 'cube-down', 'flip-horizontal', 'flip-vertical',
  'door', 'fold', 'page-turn', 'fly-in', 'swing',
];
const NEW_PACK = [...Object.keys(GLSL_PACK2), ...Object.keys(GLSL_3D)];

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

function strip(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/** index of the brace that closes the one at `open` */
function closeOf(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return src.length;
}

const READ = /(?<![\w.])(?:a|b|ac|bc)\(/g;
const reads = (s: string) => (s.match(READ) ?? []).length;

/** texture reads per pixel, worst case: textual reads, loop bodies multiplied by their bound */
function estimateReads(src: string): number {
  const code = strip(src);
  const loop = /for\s*\(\s*int\s+\w+\s*=\s*0\s*;\s*\w+\s*<\s*(\d+)\s*;\s*\w+\+\+\s*\)\s*\{/g;
  let total = 0;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = loop.exec(code))) {
    const open = m.index + m[0].length - 1;
    const end = closeOf(code, open);
    total += reads(code.slice(last, m.index));
    total += reads(code.slice(open, end)) * Number(m[1]);
    last = end;
    loop.lastIndex = end;
  }
  return total + reads(code.slice(last));
}

describe('wrapTransition', () => {
  it('returns a at p = 0 and b at p = 1 and calls tr_main in between', () => {
    const w = wrapTransition('vec4 tr_main(vec2 uv, float p) { return vec4(p); }');
    expect(w).toContain('vec4 transition(vec2 uv, float p)');
    expect(w.indexOf('p <= 0.0) return a(uv)')).toBeGreaterThan(-1);
    expect(w.indexOf('p >= 1.0) return b(uv)')).toBeGreaterThan(w.indexOf('p <= 0.0'));
    expect(w.indexOf('return tr_main(uv, p)')).toBeGreaterThan(w.indexOf('p >= 1.0'));
  });
  it('wrapAll keeps the keys and wraps every value', () => {
    const out = wrapAll({ x: 'vec4 tr_main(vec2 uv, float p) { return a(uv); }', y: 'vec4 tr_main(vec2 uv, float p) { return b(uv); }' });
    expect(Object.keys(out)).toEqual(['x', 'y']);
    for (const v of Object.values(out)) expect(v).toContain('vec4 transition(vec2 uv, float p)');
  });
});

describe('registry', () => {
  it('keeps the old ids first and unchanged', () => {
    expect(TRANSITIONS.slice(0, OLD_IDS.length).map((t) => t.id)).toEqual(OLD_IDS);
    for (const id of OLD_IDS) expect(getTransition(id)!.glsl).toBe(TRANSITION_GLSL[id]);
  });
  it('ids are unique and lowercase kebab', () => {
    const ids = TRANSITIONS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id, id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });
  it('names are short and lowercase', () => {
    for (const t of TRANSITIONS) {
      expect(t.name, t.id).toBe(t.name.toLowerCase());
      expect(t.name.length, t.id).toBeGreaterThan(0);
      expect(t.name.length, t.id).toBeLessThanOrEqual(16);
    }
  });
  it('has a 3d category that the ui lists', () => {
    expect(TRANSITION_CATEGORIES.map((c) => c.id)).toContain('3d');
    expect(transitionsInCategory('3d').map((t) => t.id)).toEqual(NEW_3D);
  });
  it('every transition has a known category', () => {
    const cats = new Set(TRANSITION_CATEGORIES.map((c) => c.id));
    for (const t of TRANSITIONS) expect(cats.has(t.category), t.id).toBe(true);
  });
  it('every pack transition is registered with its own glsl', () => {
    for (const id of NEW_PACK) {
      const t = getTransition(id);
      expect(t, id).toBeDefined();
      expect(t!.glsl, id).toBe({ ...GLSL_PACK2, ...GLSL_3D }[id]);
    }
    expect(NEW_PACK.length).toBeGreaterThanOrEqual(40);
  });
  it('no registered transition silently falls back to cross-fade', () => {
    for (const t of TRANSITIONS) {
      if (t.id !== 'cross-fade') expect(t.glsl, t.id).not.toBe(TRANSITION_GLSL['cross-fade']);
    }
  });
});

describe.each(TRANSITIONS.map((t) => [t.id, t] as const))('transition %s (static glsl checks)', (_id, def) => {
  const code = strip(def.glsl);
  it('defines vec4 transition(vec2 uv, float p)', () => {
    expect(code).toMatch(/vec4\s+transition\s*\(\s*vec2\s+uv\s*,\s*float\s+p\s*\)\s*\{/);
  });
  it('has balanced braces, parentheses and brackets', () => {
    expect(balanced(code, '{', '}')).toBe(true);
    expect(balanced(code, '(', ')')).toBe(true);
    expect(balanced(code, '[', ']')).toBe(true);
  });
  it('uses the progress', () => {
    expect(code.replace(/float\s+p\s*\)/g, '')).toMatch(/\bp\b/);
  });
  it('is deterministic: no frag coord, derivatives, time or random', () => {
    expect(code).not.toMatch(/gl_FragCoord|dFdx|dFdy|fwidth|u_time|Math\.random/);
  });
  it('does not redeclare the injected helpers', () => {
    for (const name of ['a', 'b', 'ac', 'bc', 'over', 'bump', 'reveal', 'aspect', 'rot', 'luma', 'fbm']) {
      expect(code, name).not.toMatch(new RegExp(`\\b(?:vec4|float|vec2|vec3)\\s+${name}\\s*\\(`));
    }
  });
  it('only has constant bound loops', () => {
    const loops = code.match(/\bfor\s*\([^)]*\)/g) ?? [];
    for (const l of loops) expect(l).toMatch(/^for\s*\(\s*int\s+\w+\s*=\s*0\s*;\s*\w+\s*<\s*\d+\s*;\s*\w+\+\+\s*\)$/);
    expect(code).not.toMatch(/\bwhile\b/);
  });
  it('builds a complete fragment source', () => {
    const src = transitionFragmentSource(def);
    expect(src.startsWith('#version 300 es')).toBe(true);
    expect(src).toContain('void main()');
    expect(balanced(strip(src), '{', '}')).toBe(true);
  });
});

describe.each(NEW_PACK.map((id) => [id, getTransition(id)!] as const))('pack 2 transition %s', (_id, def) => {
  const code = strip(def.glsl);
  it('returns exactly a at p = 0 and exactly b at p = 1', () => {
    expect(code).toMatch(/if\s*\(\s*p\s*<=\s*0\.0\s*\)\s*return a\(uv\);/);
    expect(code).toMatch(/if\s*\(\s*p\s*>=\s*1\.0\s*\)\s*return b\(uv\);/);
    expect(code).toMatch(/return tr_main\(uv, p\);/);
  });
  it('defines tr_main once and prefixes its helpers with tr_', () => {
    expect((code.match(/vec4\s+tr_main\s*\(/g) ?? []).length).toBe(1);
    const defined = [...code.matchAll(/^(?:float|vec2|vec3|vec4|mat3|bool)\s+(\w+)\s*\(/gm)].map((m) => m[1]!);
    for (const name of defined) {
      if (name !== 'transition') expect(name, name).toMatch(/^tr_/);
    }
  });
  it('stays under ~24 texture reads per pixel', () => {
    expect(estimateReads(code)).toBeLessThanOrEqual(26);
    expect(estimateReads(code)).toBeGreaterThan(0);
  });
});

describe('estimateReads (the test helper)', () => {
  it('counts loop bodies times their bound', () => {
    const src = 'vec4 f(vec2 uv) { vec4 s = a(uv); for (int i = 0; i < 4; i++) { s += ac(uv) + bc(uv); } return s; }';
    expect(estimateReads(src)).toBe(1 + 8);
  });
  it('does not count other functions that merely end in a or b', () => {
    expect(estimateReads('float extra(vec2 q) { return tr_data(q); }')).toBe(0);
  });
});

describe('easeTransition', () => {
  it('maps the ends to exactly 0 and 1 (the shaders rely on it)', () => {
    expect(easeTransition(0)).toBe(0);
    expect(easeTransition(1)).toBe(1);
    expect(easeTransition(-3)).toBe(0);
    expect(easeTransition(9)).toBe(1);
  });
});
