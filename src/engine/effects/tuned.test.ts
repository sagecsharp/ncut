import { describe, expect, it } from 'vitest';
import { EFFECTS } from './registry';
import type { EffectDef } from './types';

/**
 * the effects that were tuned frame by frame against a 60 fps reference. they are effects of their own (hop shake,
 * swing, zoom punch, spin whip, duotone glide, color gel, soft flash, flicker): the ones they grew out of keep their
 * look and their numbers. the numbers here are the measured ones.
 */
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
const keys = (id: string) => def(id).params.map((p) => p.key);
/** the shader without its comments */
const code = (id: string) => def(id).glsl.replace(/\/\/[^\n]*/g, ' ');

describe('the tuned effects are effects of their own', () => {
  it('hop shake: 20 hops a second, 2% of the frame, a hop is a held spot', () => {
    expect(keys('shake-hop')).toEqual(['strength', 'speed']);
    expect(param('shake-hop', 'speed').default).toBe(20);
    // strength 100% = 8% of the frame
    expect(0.08 * (param('shake-hop', 'strength').default / 100)).toBeCloseTo(0.02, 6);
    expect(code('shake-hop')).toMatch(/floor\(u_time \* p_speed/);
    expect(def('shake-hop').sync).toEqual({ param: 'speed', cycles: 1 });
  });

  it('swing rests at both ends and is slow', () => {
    expect(param('tilt-swing', 'speed').default).toBeCloseTo(0.55, 6);
    expect(param('tilt-swing', 'angle').default).toBe(6);
    expect(def('tilt-swing').sync).toEqual({ param: 'speed', cycles: 1 });
  });

  it('zoom punch stays on the punch for a moment: it has a hold, and the twist changes side', () => {
    expect(param('zoom-punch', 'hold').default).toBeGreaterThan(0);
    expect(param('zoom-punch', 'rate').default).toBeCloseTo(1.05, 6);
    expect(code('zoom-punch')).toMatch(/mod\(n, 2\.0\)/);
  });

  it('spin whip is a whole number of turns, so the picture lands the way it started', () => {
    const turns = param('whip-spin', 'turns');
    expect(turns.options).toEqual(['no turn', 'one turn', 'two turns']);
    expect(turns.default).toBe(1);
    // the whole move fades with the strength, a turn cannot be half done
    expect(code('whip-spin')).toMatch(/mix\(c, col, u_amount\)/);
    // the flash is light added on top, not a fade to white
    expect(code('whip-spin')).not.toMatch(/mix\(col, vec3\(1\.0\)/);
    expect(def('whip-spin').sync).toBeUndefined();
  });

  it('duotone glide travels around a wheel of 6 colors, 3.9 steps a second, and can still cut hard', () => {
    expect(code('duotone-glide')).toMatch(/const vec3 DS_W\[6\]/);
    expect(param('duotone-glide', 'rate').default).toBeCloseTo(3.9, 6);
    expect(param('duotone-glide', 'glide').default).toBe(100);
    expect(param('duotone-glide', 'glide').min).toBe(0);
    // one loop of the wheel = 3 steps = 46 frames at 60 fps
    expect((3 / param('duotone-glide', 'rate').default) * 60).toBeCloseTo(46, 0);
  });

  it('color gel: the weakest channel goes down to about 0.79, one loop takes 72 frames', () => {
    const k = param('hue-gel', 'strength').default / 100;
    const sat = param('hue-gel', 'saturation').default / 100;
    expect(1 - k * sat).toBeCloseTo(0.79, 2);
    expect(60 / param('hue-gel', 'speed').default).toBeCloseTo(72, 0);
    expect(code('hue-gel')).toMatch(/c \* mix\(vec3\(1\.0\), wash, k\)/);
  });

  it('soft flash adds the same light to darks and lights and falls to 0.82 of itself every frame', () => {
    expect(code('soft-flash')).toMatch(/c \+ vec3\(k\)/);
    expect(param('soft-flash', 'strength').default).toBe(30);
    // one flash = 30 frames at the default rate
    const perFrame = Math.exp(-param('soft-flash', 'decay').default / (60 / param('soft-flash', 'rate').default));
    expect(perFrame).toBeCloseTo(0.82, 2);
  });

  it('flicker: 8 frames a cycle, down to 0.8 at the dark end, and it can follow the tempo', () => {
    const d = def('flicker');
    expect(d.category).toBe('color');
    expect(60 / param('flicker', 'rate').default).toBe(8);
    expect(1 - param('flicker', 'depth').default / 100).toBeCloseTo(0.8, 6);
    expect(param('flicker', 'shape').options).toEqual(['ramp', 'on / off', 'random']);
    expect(d.sync).toEqual({ param: 'rate', cycles: 1 });
  });

  it('each one sits right after the effect it grew out of', () => {
    const order = EFFECTS.map((e) => e.id);
    const pairs: [string, string][] = [
      ['shake', 'shake-hop'],
      ['tilt', 'tilt-swing'],
      ['zoom-pulse', 'zoom-punch'],
      ['whip', 'whip-spin'],
      ['duotone-strobe', 'duotone-glide'],
      ['hue-wash', 'hue-gel'],
      ['flash', 'soft-flash'],
      ['soft-flash', 'flicker'],
    ];
    for (const [old, tuned] of pairs) expect(order.indexOf(tuned), tuned).toBe(order.indexOf(old) + 1);
  });
});

describe('the effects they grew out of are as they were', () => {
  it('shake is the smooth handheld wobble: 12 hz, 30%, no style switch, no tempo lock', () => {
    expect(keys('shake')).toEqual(['strength', 'speed']);
    expect(param('shake', 'speed').default).toBe(12);
    expect(param('shake', 'strength').default).toBe(30);
    expect(code('shake')).toMatch(/snoise1\(t \+ u_seed\)/);
    expect(def('shake').sync).toBeUndefined();
  });

  it('tilt, zoom pulse and whip keep their settings', () => {
    expect(param('tilt', 'speed').default).toBe(2.5);
    expect(param('tilt', 'angle').default).toBe(8);
    expect(keys('zoom-pulse')).toEqual(['zoom', 'rate', 'twist', 'sharpness']);
    expect(param('zoom-pulse', 'rate').default).toBe(1.5);
    expect(keys('whip')).toEqual(['spin', 'zoom', 'blur', 'flash']);
    expect(param('whip', 'spin').default).toBe(120);
    expect(param('whip', 'flash').default).toBe(85);
  });

  it('duotone strobe, hue wash and flash keep their settings', () => {
    expect(keys('duotone-strobe')).toEqual(['rate', 'contrast', 'saturation']);
    expect(param('duotone-strobe', 'rate').default).toBe(8);
    expect(code('duotone-strobe')).toMatch(/DS_DK\[idx\]/);
    expect(param('hue-wash', 'speed').default).toBeCloseTo(0.42, 6);
    expect(param('hue-wash', 'strength').default).toBe(35);
    expect(param('flash', 'strength').default).toBe(80);
    expect(param('flash', 'decay').default).toBe(8);
    expect(code('flash')).toMatch(/c \* \(1\.0 \+ 3\.0 \* k\) \+ vec3\(k\)/);
  });

  it('lens, pinch and light leak move like before', () => {
    expect(param('lens', 'pulse').default).toBe(30);
    expect(param('pinch', 'breathe').default).toBe(30);
    expect(param('light-leak', 'drift').default).toBeCloseTo(0.4, 6);
  });

  it('there are 94 effects, every id once', () => {
    expect(EFFECTS.length).toBe(94);
    expect(new Set(EFFECTS.map((e) => e.id)).size).toBe(94);
  });
});
