import { describe, expect, it } from 'vitest';
import { MAIN_ALPHA } from './glsl';
import { EFFECTS, getEffect } from './registry';
import { fragmentSource } from './runner';

const moves = () => EFFECTS.filter((d) => d.alpha === 'moves');

/** the glsl without comments and without the `#else ... #endif` part of an `#if` block */
function code(src: string): string {
  const noComments = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  return noComments.replace(/#else[\s\S]*?#endif/g, ' ');
}

/** the characters right after every tex( call, found by walking to the matching paren */
function afterTaps(src: string): string[] {
  const out: string[] = [];
  const re = /\btex\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < src.length && depth > 0) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') depth--;
      i++;
    }
    out.push(src.slice(i, i + 2));
  }
  return out;
}

describe('effects that move the picture carry the alpha', () => {
  it('no moves effect returns a hand made alpha of 1', () => {
    for (const d of moves()) {
      expect(code(d.glsl), d.id).not.toMatch(/return\s+(vec4\([^;]*,\s*1(\.0*)?\)|repm\([^;]*,\s*1(\.0*)?\))\s*;/);
    }
  });

  it('no moves effect drops the alpha of a tap', () => {
    // only .a may follow a tap, any other swizzle or a vec3 cast would throw the alpha away
    for (const d of moves()) {
      for (const next of afterTaps(code(d.glsl))) {
        expect(next, d.id).not.toMatch(/^\.[rgbxyzstp]/);
      }
      expect(code(d.glsl), d.id).not.toContain('vec3(tex(');
    }
  });

  it('the per colour effects take the outline of all three colours', () => {
    for (const id of ['lens', 'ripple', 'rgb-trail', 'rgb-split', 'glitch']) {
      expect(code(getEffect(id)!.glsl), id).toContain('pick3(');
    }
    expect(code(getEffect('prism')!.glsl)).toContain('max(a3.r, max(a3.g, a3.b))');
  });

  it('light that spreads brings its own alpha', () => {
    expect(code(getEffect('bloom')!.glsl)).toContain('1.0 - (1.0 - c.a)');
    expect(code(getEffect('soft-focus')!.glsl)).toContain('soft.a = 1.0 - (1.0 - soft.a)');
  });

  it('effects that blend or shift colour take the premultiplied colour apart first', () => {
    const ids = ['whip', 'whip-spin', 'soft-focus', 'hologram', 'glitch', 'vhs', 'static', 'old-film', 'dither', 'bloom'];
    for (const id of ids) {
      expect(code(getEffect(id)!.glsl), id).toContain('unpm(');
    }
  });

  it('shading inside a look touches colour only', () => {
    expect(code(getEffect('tunnel')!.glsl)).toContain('t.rgb *=');
    expect(code(getEffect('glass')!.glsl)).toContain('c.rgb *=');
  });

  it('builds the plain and the alpha variant of every moves effect', () => {
    for (const d of moves()) {
      expect(() => fragmentSource(d, 'plain'), d.id).not.toThrow();
      const alpha = fragmentSource(d, 'alpha');
      expect(alpha.endsWith(MAIN_ALPHA), d.id).toBe(true);
    }
  });
});
