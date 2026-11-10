import { describe, expect, it } from 'vitest';
import { EFFECTS } from './registry';
import type { EffectDef } from './types';

/** the effects that were retuned frame by frame against a 60 fps reference. the numbers here are the measured ones. */
const def = (id: string): EffectDef => {
  const d = EFFECTS.find((e) => e.id === id);
  if (!d) throw new Error(`no effect ${id}`);
  return d;
};
const param = (id: string, key: string) => {
  const p = def(id).params.find((x) => x.key === key);
  if (!p) throw new Error(`${id} has no param ${key}`);
  return p;
};
/** the shader without its comments */
const code = (id: string) => def(id).glsl.replace(/\/\/[^\n]*/g, ' ');

describe('retuned effects', () => {
  it('shake hops between spots by default: 20 a second, 2% of the frame, and keeps the smooth wobble as a choice', () => {
    expect(param('shake', 'mode').options).toEqual(['hops', 'smooth']);
    expect(param('shake', 'mode').default).toBe(0);
    expect(param('shake', 'speed').default).toBe(20);
    // strength 100% = 8% of the frame
    expect(0.08 * (param('shake', 'strength').default / 100)).toBeCloseTo(0.02, 6);
    // a hop is a held spot: the time is stepped
    expect(code('shake')).toMatch(/floor\(u_time \* p_speed/);
    expect(def('shake').sync).toEqual({ param: 'speed', cycles: 1 });
  });

  it('zoom pulse stays on the punch for a moment: it has a hold, and the twist changes side', () => {
    expect(param('zoom-pulse', 'hold').default).toBeGreaterThan(0);
    expect(param('zoom-pulse', 'rate').default).toBeCloseTo(1.05, 6);
    expect(code('zoom-pulse')).toMatch(/mod\(n, 2\.0\)/);
  });

  it('whip is a whole number of turns, so the picture lands the way it started', () => {
    const turns = param('whip', 'turns');
    expect(turns.options).toEqual(['no turn', 'one turn', 'two turns']);
    expect(turns.default).toBe(1);
    expect(def('whip').params.some((p) => p.key === 'spin')).toBe(false);
    // the whole move fades with the strength, a turn cannot be half done
    expect(code('whip')).toMatch(/mix\(c, col, u_amount\)/);
    // the flash is light added on top, not a fade to white
    expect(code('whip')).not.toMatch(/mix\(col, vec3\(1\.0\)/);
    expect(def('whip').sync).toBeUndefined();
  });

  it('duotone glides around a wheel of 6 colors, 3.9 steps a second, and can still cut hard', () => {
    expect(code('duotone-strobe')).toMatch(/const vec3 DS_W\[6\]/);
    expect(param('duotone-strobe', 'rate').default).toBeCloseTo(3.9, 6);
    expect(param('duotone-strobe', 'glide').default).toBe(100);
    expect(param('duotone-strobe', 'glide').min).toBe(0);
    // one loop of the wheel = 3 steps = 46 frames at 60 fps
    expect((3 / param('duotone-strobe', 'rate').default) * 60).toBeCloseTo(46, 0);
  });

  it('hue wash is a gel: the weakest channel goes down to about 0.79, one loop takes 72 frames', () => {
    const k = param('hue-wash', 'strength').default / 100;
    const sat = param('hue-wash', 'saturation').default / 100;
    expect(1 - k * sat).toBeCloseTo(0.79, 2);
    expect(60 / param('hue-wash', 'speed').default).toBeCloseTo(72, 0);
    expect(code('hue-wash')).toMatch(/c \* mix\(vec3\(1\.0\), wash, k\)/);
  });

  it('flash adds the same light to darks and lights and falls to 0.82 of itself every frame', () => {
    expect(code('flash')).toMatch(/c \+ vec3\(k\)/);
    expect(param('flash', 'strength').default).toBe(30);
    // one flash = 30 frames at the default rate
    const perFrame = Math.exp(-param('flash', 'decay').default / (60 / param('flash', 'rate').default));
    expect(perFrame).toBeCloseTo(0.82, 2);
  });

  it('flicker is there: 8 frames a cycle, down to 0.8 at the dark end, and it can follow the tempo', () => {
    const d = def('flicker');
    expect(d.category).toBe('color');
    expect(60 / param('flicker', 'rate').default).toBe(8);
    expect(1 - param('flicker', 'depth').default / 100).toBeCloseTo(0.8, 6);
    expect(param('flicker', 'shape').options).toEqual(['ramp', 'on / off', 'random']);
    expect(d.sync).toEqual({ param: 'rate', cycles: 1 });
  });

  it('lens and pinch hold still unless asked, the light leak barely moves', () => {
    expect(param('lens', 'pulse').default).toBe(0);
    expect(param('pinch', 'breathe').default).toBe(0);
    expect(param('light-leak', 'drift').default).toBeCloseTo(0.1, 6);
  });

  it('there are 87 effects', () => {
    expect(EFFECTS.length).toBe(87);
  });
});
