import { describe, expect, it } from 'vitest';
import { GLSL_PACK4, PACK4_IDS } from './defs4';
import { getTransition, TRANSITIONS, TRANSITION_CATEGORIES } from './registry';
import { transitionFragmentSource } from './runner';

const EXPECTED = [
  'ink-bleed', 'hex-reveal', 'dots', 'plus', 'zigzag', 'tile-pop', 'curtains', 'comb',
  'melt', 'flip-tiles', 'shatter', 'swirl-through', 'pinch', 'liquid', 'prism', 'glass-tiles',
];

const RESERVED = [
  'half', 'fixed', 'sample', 'smooth', 'flat', 'centroid', 'patch', 'cast', 'packed', 'active', 'filter',
  'input', 'output', 'union', 'template', 'this', 'resource', 'inline', 'noinline', 'public', 'static',
  'extern', 'external', 'interface', 'long', 'short', 'double', 'unsigned', 'superp', 'namespace', 'using',
  'goto', 'switch', 'default', 'volatile', 'sizeof', 'enum', 'typedef', 'asm', 'class', 'common',
  'partition', 'row_major', 'precision', 'layout', 'discard', 'struct', 'varying', 'attribute',
];
/** names the shared prelude / transition head already define: a local or helper must not reuse them */
const PRELUDE_NAMES = [
  'a', 'b', 'ac', 'bc', 'over', 'bump', 'reveal', 'tex', 'aspect', 'sat', 'hash11', 'hash21', 'hash22',
  'hash31', 'noise1', 'snoise1', 'noise2', 'fbm', 'rot', 'luma', 'hsv2rgb', 'rgb2hsv', 'transition',
];

function strip(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}
function balanced(src: string, open: string, close: string): boolean {
  let depth = 0;
  for (const ch of src) {
    if (ch === open) depth++;
    else if (ch === close && --depth < 0) return false;
  }
  return depth === 0;
}
function closeOf(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return i;
  }
  return src.length;
}
const READ = /(?<![\w.])(?:a|b|ac|bc)\(/g;
const reads = (s: string) => (s.match(READ) ?? []).length;
/** texture reads per pixel, worst case: loop bodies multiplied by their bound */
function estimateReads(code: string): number {
  const loop = /for\s*\(\s*int\s+\w+\s*=\s*0\s*;\s*\w+\s*<\s*(\d+)\s*;\s*\w+\+\+\s*\)\s*\{/g;
  let total = 0;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = loop.exec(code))) {
    const open = m.index + m[0].length - 1;
    const end = closeOf(code, open);
    total += reads(code.slice(last, m.index)) + reads(code.slice(open, end)) * Number(m[1]);
    last = end;
    loop.lastIndex = end;
  }
  return total + reads(code.slice(last));
}

describe('pack 4 registration', () => {
  it('lists the 16 new ids, unique, in the registry order', () => {
    expect(PACK4_IDS).toEqual(EXPECTED);
    expect(new Set(PACK4_IDS).size).toBe(PACK4_IDS.length);
    const ids = TRANSITIONS.map((t) => t.id);
    expect(ids.slice(ids.length - EXPECTED.length)).toEqual(EXPECTED);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('every new id is registered with its own glsl and a listed category', () => {
    const cats = new Set(TRANSITION_CATEGORIES.map((c) => c.id));
    for (const id of EXPECTED) {
      const t = getTransition(id);
      expect(t, id).toBeDefined();
      expect(t!.glsl, id).toBe(GLSL_PACK4[id]);
      expect(cats.has(t!.category), id).toBe(true);
      expect(t!.category, id).not.toBe('3d');
      expect(t!.name, id).toBe(t!.name.toLowerCase());
    }
  });
  it('searching by name finds them (the ui filters on the lowercase name)', () => {
    for (const id of EXPECTED) {
      const t = getTransition(id)!;
      expect(TRANSITIONS.filter((x) => x.name.toLowerCase().includes(t.name)).map((x) => x.id)).toContain(id);
    }
  });
});

describe.each(EXPECTED.map((id) => [id, GLSL_PACK4[id]!] as const))('pack 4 transition %s', (id, src) => {
  const code = strip(src);
  it('is wrapped: exactly a at p = 0, exactly b at p = 1, one tr_main', () => {
    expect(code).toMatch(/if\s*\(\s*p\s*<=\s*0\.0\s*\)\s*return a\(uv\);/);
    expect(code).toMatch(/if\s*\(\s*p\s*>=\s*1\.0\s*\)\s*return b\(uv\);/);
    expect((code.match(/vec4\s+tr_main\s*\(/g) ?? []).length).toBe(1);
  });
  it('prefixes its helpers with tr_ and avoids prelude names', () => {
    const defined = [...code.matchAll(/^(?:float|vec2|vec3|vec4|mat3|bool)\s+(\w+)\s*\(/gm)].map((m) => m[1]!);
    for (const name of defined) if (name !== 'transition') expect(name).toMatch(/^tr_/);
    for (const name of PRELUDE_NAMES) {
      expect(code, name).not.toMatch(new RegExp(`\b(?:int|float|bool|vec[234])\s+${name}\b`));
    }
  });
  it('uses no reserved word as a name', () => {
    for (const w of RESERVED) {
      expect(code, w).not.toMatch(new RegExp(`\b(?:int|float|bool|vec[234]|mat[234])\s+${w}\b`));
    }
  });
  it('has no bare integer literals outside loop headers (glsl es has no implicit int to float)', () => {
    const noLoops = code.replace(/for\s*\([^)]*\)/g, '');
    expect(noLoops.match(/(?<![\w.])\d+(?![\w.])/g) ?? []).toEqual([]);
  });
  it('has balanced brackets, only constant loops, no clock or derivatives', () => {
    expect(balanced(code, '{', '}') && balanced(code, '(', ')') && balanced(code, '[', ']')).toBe(true);
    const loops = code.match(/\bfor\s*\([^)]*\)/g) ?? [];
    for (const l of loops) expect(l).toMatch(/^for\s*\(\s*int\s+\w+\s*=\s*0\s*;\s*\w+\s*<\s*\d+\s*;\s*\w+\+\+\s*\)$/);
    expect(code).not.toMatch(/\bwhile\b|gl_FragCoord|dFdx|dFdy|fwidth|u_time|random/);
  });
  it('stays at a handful of texture reads (blur styles up to 16)', () => {
    const n = estimateReads(code);
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThanOrEqual(16);
  });
  it('builds a complete fragment source', () => {
    const full = transitionFragmentSource(getTransition(id)!);
    expect(full.startsWith('#version 300 es')).toBe(true);
    expect(full).toContain('void main()');
    expect(balanced(strip(full), '{', '}')).toBe(true);
  });
});
