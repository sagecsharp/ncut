import { describe, expect, it } from 'vitest';
import { EFFECTS, effectsInCategory, getEffect } from './registry';
import { EFFECT_CATEGORIES } from './types';

const OVERLAY_IDS = [
  'snow',
  'rain',
  'confetti',
  'embers',
  'bokeh',
  'light-rays',
  'lens-flare',
  'fireflies',
  'bubbles',
  'stars',
  'dust',
  'mist',
  'hearts',
  'spotlight',
];
const NEW_BLUR_IDS = ['soft-focus', 'rgb-trail'];

/** these existed before the pack, so the pack must not add a second one */
const ALREADY_THERE: [string, string][] = [
  ['speed-lines', 'motion'],
  ['light-leak', 'color'],
  ['tilt-shift', 'blur'],
  ['lens-blur', 'blur'],
];

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

describe('overlay category', () => {
  it('is the last category and is labelled overlay', () => {
    const last = EFFECT_CATEGORIES[EFFECT_CATEGORIES.length - 1]!;
    expect(last).toEqual({ id: 'overlay', label: 'overlay' });
  });

  it('holds exactly the overlay pack', () => {
    expect(effectsInCategory('overlay').map((e) => e.id)).toEqual(OVERLAY_IDS);
  });

  it('comes after every other effect in the registry order', () => {
    const firstOverlay = EFFECTS.findIndex((e) => e.category === 'overlay');
    expect(firstOverlay).toBeGreaterThan(0);
    expect(EFFECTS.slice(firstOverlay).every((e) => e.category === 'overlay')).toBe(true);
  });
});

describe('pack 3 registry', () => {
  it('registers every new effect exactly once', () => {
    for (const id of [...OVERLAY_IDS, ...NEW_BLUR_IDS]) {
      expect(getEffect(id), id).toBeDefined();
      expect(EFFECTS.filter((e) => e.id === id), id).toHaveLength(1);
    }
  });

  it('does not duplicate effects that already existed', () => {
    for (const [id, cat] of ALREADY_THERE) {
      expect(EFFECTS.filter((e) => e.id === id), id).toHaveLength(1);
      expect(getEffect(id)!.category).toBe(cat);
    }
    // no two effects share a display name either, they would be indistinguishable in the tab
    const names = EFFECTS.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('the new blurs live in the blur category', () => {
    for (const id of NEW_BLUR_IDS) expect(getEffect(id)!.category).toBe('blur');
  });

  it('none of the pack is temporal', () => {
    for (const id of [...OVERLAY_IDS, ...NEW_BLUR_IDS]) expect(getEffect(id)!.temporal).toBeUndefined();
  });
});

describe.each(OVERLAY_IDS.map((id) => [id, getEffect(id)!] as const))('overlay %s', (_id, def) => {
  it('has 2 to 4 params', () => {
    expect(def.params.length).toBeGreaterThanOrEqual(2);
    expect(def.params.length).toBeLessThanOrEqual(4);
  });

  it('reads the picture once and ends with the amount mix, so amount 0 is the untouched picture', () => {
    const code = strip(def.glsl);
    expect(code.match(/\btex\(/g)).toHaveLength(1);
    const returns = [...code.matchAll(/return\s+vec4\(([^;]*)\);/g)];
    const last = returns[returns.length - 1]![1]!;
    expect(last).toContain('u_amount');
  });

  it('keeps a small fixed amount of work per pixel', () => {
    const code = strip(def.glsl);
    for (const m of code.matchAll(/for\s*\(int \w+ = 0; \w+ < (\d+); \w+\+\+\)/g)) {
      expect(Number(m[1])).toBeLessThanOrEqual(5);
    }
    // at most three nested loops: layers, rows, columns
    let depth = 0;
    let max = 0;
    const forRe = /\bfor\s*\(|[{}]/g;
    const stack: boolean[] = [];
    for (const m of code.matchAll(forRe)) {
      if (m[0] === '{') {
        stack.push(false);
      } else if (m[0] === '}') {
        if (stack.pop()) depth--;
      } else {
        // the next { opens this loop's body
        depth++;
        max = Math.max(max, depth);
        stack.push(true);
      }
    }
    expect(max).toBeLessThanOrEqual(3);
  });

  it('is seeded: random numbers come from hashes of u_seed, not from the clock alone', () => {
    const code = strip(def.glsl);
    // spotlight has nothing random at all
    if (def.id === 'spotlight') return;
    expect(code).toMatch(/u_seed|crand\(/);
  });

  it('never draws outside aspect space: no u_res sized pixel math except footprints', () => {
    const code = strip(def.glsl);
    // u_res may only appear as 1 / u_res.y style footprints or cells / u_res.y
    for (const m of code.matchAll(/u_res[^;]*/g)) expect(m[0]).toMatch(/^u_res\.y/);
  });
});

describe('overlay params', () => {
  it('every default shows the effect (density, size and speed never default to 0)', () => {
    for (const id of OVERLAY_IDS) {
      for (const p of getEffect(id)!.params) {
        if (['density', 'size', 'speed', 'rays', 'reach', 'ghosts'].includes(p.key)) {
          expect(p.default, `${id}.${p.key}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('the lens flare and spotlight take a position that can leave the frame a little', () => {
    for (const id of ['lens-flare', 'spotlight', 'light-rays']) {
      const def = getEffect(id)!;
      for (const key of ['x', 'y']) {
        const p = def.params.find((q) => q.key === key)!;
        expect(p, `${id}.${key}`).toBeDefined();
        expect(p.min).toBeLessThan(0);
        expect(p.max).toBeGreaterThan(100);
      }
    }
  });
});

describe('new blurs', () => {
  it('soft focus mixes the blur with the picture and the amount', () => {
    const def = getEffect('soft-focus')!;
    expect(def.params.map((p) => p.key)).toEqual(['radius', 'softness', 'glow']);
    expect(strip(def.glsl)).toContain('mix(c, soft, u_amount)');
  });

  it('rgb trail smears the three channels by different lengths and is identity at amount 0', () => {
    const def = getEffect('rgb-trail')!;
    const code = strip(def.glsl);
    expect(def.params.map((p) => p.key)).toEqual(['distance', 'angle', 'spread']);
    expect(code).toMatch(/acc\.r \+= tex\(uv - dir \* t\)\.r/);
    expect(code).toContain('.g;');
    expect(code).toContain('.b;');
    expect(code).toContain('mix(c, acc / 10.0, u_amount)');
    // 1 center tap + 3 channels x 10 loop iterations stays inside the 32 tap budget
    expect(code.match(/\btex\(/g)).toHaveLength(4);
  });

  it('soft focus uses at most 31 taps', () => {
    const code = strip(getEffect('soft-focus')!.glsl);
    expect(code.match(/\btex\(/g)).toHaveLength(2);
    expect(code).toMatch(/i < 30/);
  });
});
