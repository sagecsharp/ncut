import { describe, expect, it } from 'vitest';
import { EFFECTS } from './registry';

const MOVES = [
  'shake', 'shake-hop', 'tilt', 'tilt-swing', 'zoom-pulse', 'zoom-punch', 'whip', 'whip-spin', 'drift',
  'directional-blur', 'zoom-blur', 'spin-blur', 'gaussian-blur', 'tilt-shift', 'lens-blur', 'sharpen',
  'soft-focus', 'rgb-trail', 'lens', 'pinch', 'ripple', 'wave', 'swirl', 'mirror', 'fisheye', 'tunnel',
  'stretch', 'tile', 'heat-haze', 'glass', 'prism', 'led-screen', 'hologram', 'rgb-split', 'blur', 'crt',
  'glitch', 'vhs', 'static', 'pixelate', 'old-film', 'dither', 'bloom',
];
const TEMPORAL = ['motion-blur', 'echo', 'frame-blend', 'strobe'];
const EDGE_FINDERS = ['halftone', 'edges', 'thermal', 'neon-edges', 'emboss', 'sketch', 'oil-paint'];

/** the 47 keep effects: no alpha, not temporal */
const keeps = () => EFFECTS.filter((d) => !d.alpha && !d.temporal);

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** the argument text of every tex( call, found by walking to the matching paren */
function texArgs(code: string): string[] {
  const out: string[] = [];
  const re = /\btex\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < code.length && depth > 0) {
      if (code[i] === '(') depth++;
      else if (code[i] === ')') depth--;
      i++;
    }
    out.push(code.slice(start, i - 1).trim());
  }
  return out;
}

/** fnv-1a hashes of the glsl of every keep effect, taken at the base of the fx work */
const KEEP_HASHES: Record<string, string> = {
  'speed-lines': '6e1300ac',
  'duotone-strobe': '39ec71db',
  'duotone-glide': 'b38abeea',
  'hue-wash': '9a99450f',
  'hue-gel': '755146b6',
  flash: '139f8b20',
  'soft-flash': 'c395def1',
  flicker: '6c637a75',
  'light-leak': '120cc283',
  vignette: 'f8f1dabc',
  adjust: '16cf780d',
  'black-and-white': '5e2ca769',
  sepia: '4af50eda',
  invert: 'ce087b48',
  posterize: 'e50becdd',
  threshold: '34ff904d',
  tint: 'fac6dda9',
  'fade-film': '25f90e37',
  'color-pop': '99df5a31',
  'teal-orange': '8b7fcfd1',
  grain: 'f8a7b489',
  halftone: '11b23c2f',
  edges: 'ce620b18',
  scanlines: '09b8dadc',
  duotone: 'd8dc52ca',
  'night-vision': '077e944d',
  thermal: 'bc037946',
  letterbox: '4cbe7e28',
  'neon-edges': '024336a7',
  emboss: '3f80a7eb',
  sketch: 'a8f9667e',
  'oil-paint': '51cf55ae',
  snow: 'aee80f15',
  rain: '93baaaaa',
  confetti: '248e4e39',
  embers: 'a2884ef2',
  bokeh: '688d7e8c',
  'light-rays': '18f30603',
  'lens-flare': '4fcf1a1f',
  fireflies: '1cb3e336',
  bubbles: '0131ced9',
  stars: 'e1f663be',
  dust: '93da41d1',
  mist: 'cc421d2f',
  hearts: '64b2f911',
  spotlight: '03c55fb8',
  // the grade effect, with its chunk (engine/grade.ts GRADE_GLSL) as it ships
  grade: 'e3685703',
};

describe('effect alpha kinds', () => {
  it('pins the 43 effects that move the picture', () => {
    const ids = EFFECTS.filter((d) => d.alpha === 'moves').map((d) => d.id);
    expect(ids).toHaveLength(43);
    expect([...ids].sort()).toEqual([...MOVES].sort());
  });
  it('pins chroma-key as the only effect with its own alpha', () => {
    expect(EFFECTS.filter((d) => d.alpha === 'own').map((d) => d.id)).toEqual(['chroma-key']);
  });
  it('temporal effects have no alpha', () => {
    for (const id of TEMPORAL) {
      const def = EFFECTS.find((d) => d.id === id);
      expect(def, id).toBeDefined();
      expect(def!.temporal, id).toBeTypeOf('function');
      expect(def!.alpha, id).toBeUndefined();
    }
  });
  it('every other effect keeps the outline (47)', () => {
    expect(keeps()).toHaveLength(47);
    expect(EFFECTS).toHaveLength(95);
  });
  it('keep effects read only the pixel they draw, except the edge finders', () => {
    for (const def of keeps()) {
      if (EDGE_FINDERS.includes(def.id)) continue;
      for (const arg of texArgs(stripComments(def.glsl))) expect(arg, `${def.id} reads ${arg}`).toBe('uv');
    }
  });
  it('keep effects do not use the alpha helpers', () => {
    for (const def of keeps()) {
      const code = stripComments(def.glsl);
      for (const word of ['unpm(', 'repm(', 'pick3(', 'FX_ALPHA']) expect(code.includes(word), `${def.id} uses ${word}`).toBe(false);
    }
  });
  it('keep effects keep their glsl', () => {
    expect(Object.keys(KEEP_HASHES).sort()).toEqual(keeps().map((d) => d.id).sort());
    for (const def of keeps()) expect(fnv1a(def.glsl), def.id).toBe(KEEP_HASHES[def.id]);
  });
});
