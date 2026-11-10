import { describe, expect, it } from 'vitest';
import { createTextClip } from '../lib/factory';
import type { TextClip } from '../types';
import {
  REST,
  TEXT_ANIMS_IN,
  TEXT_ANIMS_LOOP,
  TEXT_ANIMS_OUT,
  blockState,
  centerIndex,
  elasticOut,
  glyphState,
  scrambleChar,
  shuffledIndex,
  textAnimUnits,
  type GlyphState,
} from './textAnim';

const DUR = 5;
const base = createTextClip('t1', 0, { duration: DUR });

const withIn = (id: string, d = 1): TextClip => ({ ...base, animIn: { id, duration: d } });
const withOut = (id: string, d = 1): TextClip => ({ ...base, animOut: { id, duration: d } });
const withLoop = (id: string, d = 2): TextClip => ({ ...base, animLoop: { id, duration: d } });

/** state of one letter (i of n, one word, one line) */
function letter(clip: TextClip, local: number, i = 0, n = 1): GlyphState {
  return glyphState(clip, local, i, n, 0, 1, 0, 1, textAnimUnits(clip));
}
/** the whole picture: block state plus the first letter */
function all(clip: TextClip, local: number, i = 0, n = 1): GlyphState[] {
  return [blockState(clip, local), letter(clip, local, i, n)];
}
const plain = (s: GlyphState) => ({ ...s });

const NEW_IN = ['blur', 'scramble', 'flip', 'wave-in', 'glitch', 'expand', 'swing', 'bounce', 'split-flap', 'elastic', 'random', 'unfold'];
const NEW_LOOP = ['glitch', 'typing', 'neon', 'heartbeat', 'spin', 'colors', 'flicker', 'tilt', 'breathe'];

describe('animation lists', () => {
  it('keeps the old ids first and in order, then the new ones', () => {
    const ids = TEXT_ANIMS_IN.map((a) => a.id);
    expect(ids.slice(0, 14)).toEqual([
      'fade', 'typewriter', 'cascade', 'rise', 'drop', 'slide-left', 'slide-right', 'pop', 'zoom', 'spin', 'stretch', 'flicker', 'words', 'lines',
    ]);
    expect(ids.slice(14)).toEqual(NEW_IN);
    expect(TEXT_ANIMS_OUT).toBe(TEXT_ANIMS_IN);
    const loops = TEXT_ANIMS_LOOP.map((a) => a.id);
    expect(loops.slice(0, 10)).toEqual(['wave', 'wobble', 'pulse', 'bounce', 'shake', 'float', 'pendulum', 'jelly', 'blink', 'rainbow']);
    expect(loops.slice(10)).toEqual(NEW_LOOP);
  });

  it('has unique lowercase ids and names', () => {
    for (const list of [TEXT_ANIMS_IN, TEXT_ANIMS_LOOP]) {
      expect(new Set(list.map((a) => a.id)).size).toBe(list.length);
      for (const a of list) {
        expect(a.id).toBe(a.id.toLowerCase());
        expect(a.name).toBe(a.name.toLowerCase());
      }
    }
  });

  it('every listed animation is implemented', () => {
    for (const a of TEXT_ANIMS_IN) {
      const u = textAnimUnits(withIn(a.id));
      expect(u.enter, a.id).not.toBeNull();
      expect(textAnimUnits(withOut(a.id)).exit, a.id).not.toBeNull();
      expect(u.loop).toBeNull();
    }
    for (const a of TEXT_ANIMS_LOOP) expect(textAnimUnits(withLoop(a.id)).loop, a.id).not.toBeNull();
  });
});

describe('entrances and exits', () => {
  it('rest after the entrance, and also at the start of an exit', () => {
    for (const a of TEXT_ANIMS_IN) {
      expect(letter(withIn(a.id), 1), a.id).toBe(REST);
      expect(blockState(withIn(a.id), 3), a.id).toBe(REST);
      expect(letter(withOut(a.id), DUR - 1), a.id).toBe(REST);
    }
  });

  it('are nearly at rest just before the end of the entrance', () => {
    for (const id of NEW_IN) {
      const clip = withIn(id);
      const [b, l] = all(clip, 0.9995);
      for (const st of [b, l]) {
        expect(st.alpha, id).toBeGreaterThan(0.99);
        expect(Math.abs(st.dx), id).toBeLessThan(0.02);
        expect(Math.abs(st.dy), id).toBeLessThan(0.02);
        expect(Math.abs(st.rot), id).toBeLessThan(0.02);
        expect(st.sx, id).toBeCloseTo(1, 1);
        expect(st.sy, id).toBeCloseTo(1, 1);
        expect(st.spacing, id).toBeLessThan(0.02);
        expect(st.blur ?? 0, id).toBeLessThan(0.02);
      }
    }
  });

  it('start changed at the beginning', () => {
    for (const id of NEW_IN) {
      const [b, l] = all(withIn(id), 0);
      expect(b === REST && l === REST, id).toBe(false);
    }
  });

  it('exits mirror entrances', () => {
    for (const a of TEXT_ANIMS_IN) {
      if (a.id === 'flicker') continue; // flicker follows the wall time, not the progress
      for (const p of [0, 0.125, 0.375, 0.75]) {
        const inn = all(withIn(a.id), p, 1, 4);
        const out = all(withOut(a.id), DUR - p, 1, 4);
        expect(out.map(plain), `${a.id} @ ${p}`).toEqual(inn.map(plain));
      }
    }
  });

  it('letters one after the other: the first is done before the last', () => {
    const clip = withIn('bounce');
    const n = 10;
    expect(letter(clip, 0.7, 0, n)).toBe(REST);
    expect(letter(clip, 0.7, n - 1, n)).not.toBe(REST);
  });

  it('are deterministic', () => {
    for (const id of NEW_IN) {
      const a = all(withIn(id), 0.33, 2, 7).map(plain);
      const b = all(withIn(id), 0.33, 2, 7).map(plain);
      expect(a).toEqual(b);
    }
  });

  it('blur starts blurred and has no blur at rest', () => {
    expect(letter(withIn('blur'), 0).blur).toBeGreaterThan(0.1);
    expect(letter(withIn('blur'), 0).alpha).toBeLessThan(0.1);
  });

  it('flip turns the letter through zero height', () => {
    const clip = withIn('flip');
    expect(letter(clip, 0).sy).toBeLessThan(-0.9);
    const mids = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8].map((p) => letter(clip, p).sy);
    expect(Math.min(...mids.map(Math.abs))).toBeLessThan(0.35);
    expect(mids.some((v) => v < 0) && mids.some((v) => v > 0)).toBe(true);
    expect(letter(clip, 0.9995).sy).toBeCloseTo(1, 1);
  });

  it('wave in overshoots to the other side of rest', () => {
    const clip = withIn('wave-in');
    const dys = Array.from({ length: 40 }, (_, k) => letter(clip, (k + 0.5) / 40).dy);
    expect(Math.max(...dys)).toBeGreaterThan(0.2);
    expect(Math.min(...dys)).toBeLessThan(-0.02);
  });

  it('bounce lands twice: it leaves the ground two more times after the first landing', () => {
    const clip = withIn('bounce');
    const dys = Array.from({ length: 200 }, (_, k) => letter(clip, (k + 0.5) / 200).dy);
    // dy < 0 = above the ground. count the arcs separated by touching the ground
    let arcs = 0;
    let inAir = false;
    for (const dy of dys) {
      if (dy < -0.04 && !inAir) {
        arcs++;
        inAir = true;
      } else if (dy > -0.02) inAir = false;
    }
    expect(arcs).toBe(3); // the fall and two bounces
  });

  it('swing hangs from the top edge', () => {
    const b = blockState(withIn('swing'), 0.3);
    expect(b.pivotY).toBe(-0.5);
    expect(blockState(withIn('swing'), 0).rot).toBeGreaterThan(0.5);
  });

  it('expand collapses the letter spacing', () => {
    expect(blockState(withIn('expand'), 0).spacing).toBeGreaterThan(1);
    expect(blockState(withIn('expand'), 0.5).spacing).toBeLessThan(blockState(withIn('expand'), 0.1).spacing);
  });

  it('glitch is calm at the end and rough at the start', () => {
    const clip = withIn('glitch');
    const spread = (p: number) => {
      let s = 0;
      for (let i = 0; i < 20; i++) s += Math.abs(glyphState(clip, p, i, 1, 0, 1, 0, 1, textAnimUnits(clip)).dx);
      return s;
    };
    expect(spread(0.02)).toBeGreaterThan(spread(0.98));
  });
});

describe('split flap, elastic, random, unfold', () => {
  it('shuffledIndex and centerIndex are permutations', () => {
    for (let n = 1; n <= 40; n++) {
      const a = Array.from({ length: n }, (_, i) => shuffledIndex(i, n)).sort((x, y) => x - y);
      const b = Array.from({ length: n }, (_, i) => centerIndex(i, n)).sort((x, y) => x - y);
      const want = Array.from({ length: n }, (_, i) => i);
      expect(a, `shuffle ${n}`).toEqual(want);
      expect(b, `center ${n}`).toEqual(want);
    }
  });

  it('shuffle is not left to right, center starts in the middle', () => {
    expect(Array.from({ length: 8 }, (_, i) => shuffledIndex(i, 8))).not.toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(centerIndex(2, 5)).toBe(0);
    expect(centerIndex(0, 5)).toBeGreaterThan(centerIndex(1, 5));
    expect(centerIndex(4, 5)).toBeGreaterThan(centerIndex(3, 5));
  });

  it('random reveals letters out of order, unfold from the middle', () => {
    const n = 9;
    // the letter that starts second is not the one next to the first
    const order = [...Array(n).keys()].sort((a, b) => shuffledIndex(a, n) - shuffledIndex(b, n));
    expect(order[0]).toBe(0);
    expect(order[1]).not.toBe(1);
    const unf = withIn('unfold');
    const mid = letter(unf, 0.3, 4, n);
    const edge = letter(unf, 0.3, 0, n);
    expect(mid.sx).toBeGreaterThan(edge.sx);
  });

  it('split flap passes through zero height and lands upright', () => {
    const clip = withIn('split-flap');
    let min = 1;
    for (let k = 1; k < 100; k++) min = Math.min(min, letter(clip, k / 100, 0, 1).sy);
    expect(min).toBeLessThan(0.1);
    expect(letter(clip, 1, 0, 1)).toBe(REST);
  });

  it('elastic overshoots and settles', () => {
    expect(elasticOut(0)).toBe(0);
    expect(elasticOut(1)).toBe(1);
    let max = 0;
    for (let k = 1; k < 100; k++) max = Math.max(max, elasticOut(k / 100));
    expect(max).toBeGreaterThan(1.05);
    expect(letter(withIn('elastic'), 0.2, 0, 1).sx).toBeGreaterThan(1);
  });
});

describe('tilt and breathe loops', () => {
  it('tilt rocks letters and keeps their base in place', () => {
    const st = letter(withLoop('tilt'), 0.5, 2, 6);
    expect(st.rot).not.toBe(0);
    // turning about the foot (0.4 below the middle) = turning about the middle + this shift
    expect(st.dx).toBeCloseTo(Math.sin(st.rot) * 0.4, 9);
    expect(st.dy).toBeCloseTo((1 - Math.cos(st.rot)) * 0.4, 9);
  });

  it('breathe spreads letters away from the middle and back', () => {
    const clip = withLoop('breathe');
    const left = letter(clip, 0.5, 0, 7);
    const right = letter(clip, 0.5, 6, 7);
    const mid = letter(clip, 0.5, 3, 7);
    expect(left.dx).toBeCloseTo(-right.dx, 9);
    expect(left.dx).not.toBe(0);
    expect(Math.abs(mid.dx)).toBeLessThan(1e-9);
  });
});

describe('scramble', () => {
  it('shows stand-ins while it runs and the real letter once it is done', () => {
    const clip = withIn('scramble');
    const during = letter(clip, 0.4);
    expect(during.scramble).toBeGreaterThanOrEqual(1);
    // at the end the letter is untouched: no stand-in
    expect(letter(clip, 1)).toBe(REST);
    expect(letter(clip, 1).scramble).toBeUndefined();
    // just before the end it still shuffles, then it is the real letter
    expect(letter(clip, 0.999).scramble).toBeDefined();
  });

  it('steps change over time', () => {
    const clip = withIn('scramble');
    const steps = new Set(Array.from({ length: 30 }, (_, k) => letter(clip, (k + 0.5) / 30).scramble));
    expect(steps.size).toBeGreaterThan(5);
  });

  it('exit scrambles too', () => {
    expect(letter(withOut('scramble'), DUR - 0.4).scramble).toBeDefined();
  });

  it('scrambleChar is deterministic and keeps the kind of character', () => {
    for (let step = 1; step < 20; step++) {
      expect(scrambleChar('a', 3, step)).toBe(scrambleChar('a', 3, step));
      expect(scrambleChar('a', 3, step)).toMatch(/^[a-z]$/);
      expect(scrambleChar('Q', 3, step)).toMatch(/^[A-Z]$/);
      expect(scrambleChar('7', 3, step)).toMatch(/^[0-9]$/);
      expect(scrambleChar('!', 3, step)).toMatch(/^[^a-zA-Z0-9]$/);
    }
  });

  it('scrambleChar varies with the step and with the letter position', () => {
    const bySteps = new Set(Array.from({ length: 30 }, (_, s) => scrambleChar('a', 0, s + 1)));
    expect(bySteps.size).toBeGreaterThan(5);
    const byIndex = new Set(Array.from({ length: 30 }, (_, i) => scrambleChar('a', i, 4)));
    expect(byIndex.size).toBeGreaterThan(5);
  });
});

describe('loops', () => {
  const PERIODIC = NEW_LOOP.concat(['wave', 'wobble', 'pulse', 'bounce', 'float', 'pendulum', 'jelly', 'blink', 'rainbow']);
  const norm = (s: GlyphState) => ({ ...s, hue: s.hue === undefined ? undefined : s.hue - Math.floor(s.hue) });

  it('repeat after one cycle', () => {
    const d = 2;
    for (const id of PERIODIC) {
      const clip = withLoop(id, d);
      for (const f of [0.013, 0.2, 0.41, 0.6037, 0.77, 0.97]) {
        for (const i of [0, 3, 8]) {
          const a = all(clip, f * d, i, 10).map(norm);
          const b = all(clip, (f + 2) * d, i, 10).map(norm);
          for (let k = 0; k < 2; k++) {
            const x = a[k]!;
            const y = b[k]!;
            for (const key of ['dx', 'dy', 'sx', 'sy', 'rot', 'alpha', 'pivotY', 'spacing'] as const) {
              expect(y[key], `${id} ${key} @ ${f}`).toBeCloseTo(x[key], 6);
            }
            if (x.hue !== undefined) expect(y.hue).toBeCloseTo(x.hue, 6);
          }
        }
      }
    }
  });

  it('are deterministic', () => {
    for (const id of NEW_LOOP) {
      const a = all(withLoop(id), 0.77, 2, 7).map(plain);
      const b = all(withLoop(id), 0.77, 2, 7).map(plain);
      expect(a).toEqual(b);
    }
  });

  it('typing types, holds, deletes and starts over', () => {
    const clip = withLoop('typing', 2);
    const n = 10;
    const shown = (f: number) => Array.from({ length: n }, (_, i) => letter(clip, f * 2, i, n).alpha > 0.5).filter(Boolean).length;
    expect(shown(0)).toBe(0);
    expect(shown(0.2)).toBe(5);
    expect(shown(0.5)).toBe(n);
    expect(shown(0.8)).toBe(5);
    expect(shown(0.999)).toBeLessThanOrEqual(1);
    // it types from the left
    expect(letter(clip, 0.4, 0, n).alpha).toBe(1);
    expect(letter(clip, 0.4, 9, n).alpha).toBe(0);
  });

  it('heartbeat pulses twice per cycle and rests in between', () => {
    const clip = withLoop('heartbeat', 2);
    const s = (f: number) => blockState(clip, f * 2).sx;
    expect(s(0.09)).toBeGreaterThan(1.05);
    expect(s(0.32)).toBeGreaterThan(1.03);
    expect(s(0.2)).toBeCloseTo(1, 3);
    expect(s(0.7)).toBeCloseTo(1, 6);
  });

  it('neon is mostly on and never fully dark', () => {
    const clip = withLoop('neon', 2);
    const as = Array.from({ length: 400 }, (_, k) => blockState(clip, (k + 0.5) / 400 * 2).alpha);
    expect(Math.min(...as)).toBeGreaterThanOrEqual(0.2);
    expect(Math.max(...as)).toBeLessThanOrEqual(1);
    expect(as.filter((a) => a > 0.85).length).toBeGreaterThan(300);
    expect(as.filter((a) => a < 0.5).length).toBeGreaterThan(0);
  });

  it('glitch only twitches in short bursts', () => {
    const clip = withLoop('glitch', 2);
    const moves = Array.from({ length: 12 }, (_, slot) => Math.abs(letter(clip, ((slot + 0.5) / 12) * 2, 0, 5).dx) > 0);
    const n = moves.filter(Boolean).length;
    expect(n).toBeGreaterThanOrEqual(0);
    expect(n).toBeLessThan(12);
    // a burst covers 3 slots in a row
    for (let b = 0; b < 4; b++) expect(new Set(moves.slice(b * 3, b * 3 + 3)).size).toBe(1);
  });

  it('spin turns every letter once per cycle, one after the other', () => {
    const clip = withLoop('spin', 2);
    const n = 6;
    expect(letter(clip, 0, 0, n).rot).toBeCloseTo(0, 6);
    expect(letter(clip, 0.36 * 2, 0, n).rot).toBeCloseTo(Math.PI * 2, 6); // first letter done at 0.35
    expect(letter(clip, 0.36 * 2, n - 1, n).rot).toBeCloseTo(0, 6); // last has not started
    expect(letter(clip, 0.999 * 2, n - 1, n).rot).toBeGreaterThan(Math.PI * 1.5);
  });

  it('colors steps through hues, each letter one step ahead', () => {
    const clip = withLoop('colors', 2);
    const h0 = letter(clip, 0.1, 0, 5).hue!;
    const h1 = letter(clip, 0.1, 1, 5).hue!;
    expect(h1 - h0).toBeCloseTo(1 / 6, 6);
    const later = letter(clip, 0.1 + 2 / 6, 0, 5).hue!;
    expect(later - h0).toBeCloseTo(1 / 6, 6);
  });

  it('flicker blinks single letters in an irregular pattern and never moves them', () => {
    const c = withLoop('flicker', 2);
    const n = 12;
    const alphas = new Set<number>();
    let dark = 0;
    let samples = 0;
    for (let k = 0; k < 36; k++) {
      for (let i = 0; i < n; i++) {
        const st = letter(c, (k / 36) * 2, i, n);
        alphas.add(st.alpha);
        if (st.alpha < 1) dark++;
        samples++;
        expect(st.alpha).toBeGreaterThan(0);
        expect(st.dx).toBe(0);
        expect(st.dy).toBe(0);
      }
    }
    expect(dark).toBeGreaterThan(0);
    expect(dark).toBeLessThan(samples / 2);
    expect(alphas.size).toBeGreaterThan(1);
    // letters do not all blink together
    const pattern = (i: number) => Array.from({ length: 18 }, (_, k) => letter(c, (k / 18) * 2 + 0.01, i, n).alpha).join();
    expect(new Set(Array.from({ length: n }, (_, i) => pattern(i))).size).toBeGreaterThan(1);
  });
});
