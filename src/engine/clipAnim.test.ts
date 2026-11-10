import { describe, expect, it } from 'vitest';
import type { ClipAnim, TextClip } from '../types';
import { DEFAULT_TRANSFORM } from '../types';
import { createTextClip } from '../lib/factory';
import { CLIP_MOTIONS_IN, CLIP_MOTIONS_LOOP, applyClipMotion, hasClipMotion } from './clipAnim';

const SIZE = { width: 1920, height: 1080 };
const make = (o: Partial<TextClip> = {}): TextClip =>
  createTextClip('t', 2, { duration: 6, transform: { ...DEFAULT_TRANSFORM, x: 10, y: 20, scale: 1.5, rotation: 3, opacity: 0.8 }, ...o });
const anim = (id: string, duration = 1): ClipAnim => ({ id, duration });
// the 2d ones: the 3d-only motions are covered in their own block at the end
const IN_IDS = CLIP_MOTIONS_IN.filter((m) => !m.threeD).map((m) => m.id);
const LOOP_IDS = CLIP_MOTIONS_LOOP.filter((m) => !m.threeD).map((m) => m.id);
const IN_3D = CLIP_MOTIONS_IN.filter((m) => m.threeD).map((m) => m.id);
const LOOP_3D = CLIP_MOTIONS_LOOP.filter((m) => m.threeD).map((m) => m.id);

describe('applyClipMotion', () => {
  it('returns the same object when there is no motion or none is active', () => {
    const c = make();
    expect(hasClipMotion(c)).toBe(false);
    expect(applyClipMotion(c, 3, SIZE)).toBe(c);
    const m = make({ motionIn: anim('pop'), motionOut: anim('pop') });
    expect(applyClipMotion(m, 5, SIZE)).toBe(m);
    expect(applyClipMotion(make({ motionIn: anim('pop', 0) }), 2, SIZE).transform.scale).toBe(1.5);
  });
  it('rest pose after the entrance ends, and at exactly its end', () => {
    for (const id of IN_IDS) {
      const c = make({ motionIn: anim(id) });
      expect(applyClipMotion(c, 3.5, SIZE), id).toBe(c);
      expect(applyClipMotion(c, 3, SIZE), id).toBe(c);
    }
  });
  it('starts hidden or off screen at the first frame', () => {
    const at0 = (id: string) => applyClipMotion(make({ motionIn: anim(id) }), 2, SIZE).transform;
    expect(at0('slide-left').x).toBeGreaterThanOrEqual(10 + SIZE.width);
    expect(at0('slide-right').x).toBeLessThanOrEqual(10 - SIZE.width);
    expect(at0('slide-up').y).toBeGreaterThanOrEqual(20 + SIZE.height);
    expect(at0('slide-down').y).toBeLessThanOrEqual(20 - SIZE.height);
    expect(at0('fade').opacity).toBe(0);
    expect(at0('pop').scale).toBeCloseTo(0, 9);
    expect(at0('zoom-in').scale).toBeCloseTo(0.3 * 1.5, 9);
    expect(at0('zoom-out').scale).toBeCloseTo(1.8 * 1.5, 9);
    expect(at0('spin').rotation).toBeCloseTo(3 - 360, 9);
    expect(at0('drop').y).toBeLessThan(20 - SIZE.height);
  });
  it('every entrance changes something in the middle of its window', () => {
    for (const id of IN_IDS) {
      const c = make({ motionIn: anim(id) });
      const out = applyClipMotion(c, 2.5, SIZE);
      expect(out, id).not.toBe(c);
      expect(out.transform, id).not.toEqual(c.transform);
    }
  });
  it('every loop changes something at 0.55 of a cycle', () => {
    for (const id of LOOP_IDS) {
      const c = make({ motionLoop: anim(id, 2) });
      const out = applyClipMotion(c, 2 + 0.55 * 2, SIZE);
      expect(out.transform, id).not.toEqual(c.transform);
    }
  });
  it('the exit mirrors the entrance', () => {
    for (const id of IN_IDS) {
      const c = make({ motionIn: anim(id), motionOut: anim(id) });
      // clip 2..8
      expect(applyClipMotion(c, 8 - 0.25, SIZE).transform, id).toEqual(applyClipMotion(c, 2 + 0.25, SIZE).transform);
      expect(applyClipMotion(c, 8 - 0.7, SIZE).transform, id).toEqual(applyClipMotion(c, 2 + 0.7, SIZE).transform);
    }
  });
  it('the exit ends at the entrance start', () => {
    const c = make({ motionOut: anim('fade') });
    expect(applyClipMotion(c, 8, SIZE).transform.opacity).toBe(0);
    expect(applyClipMotion(c, 7, SIZE)).toBe(c);
  });
  it('in and out are limited to half of the clip', () => {
    const c = make({ duration: 1, motionIn: anim('fade', 5), motionOut: anim('fade', 5) });
    expect(applyClipMotion(c, 2.25, SIZE).transform.opacity).toBeCloseTo(0.4, 9);
    expect(applyClipMotion(c, 2.75, SIZE).transform.opacity).toBeCloseTo(0.4, 9);
  });
  it('loops are periodic and deterministic', () => {
    for (const id of LOOP_IDS) {
      const c = make({ motionLoop: anim(id, 1.5) });
      for (const ph of [0.1, 0.37, 0.9]) {
        const a = applyClipMotion(c, 2 + ph * 1.5, SIZE).transform;
        const b = applyClipMotion(c, 2 + ph * 1.5 + 3, SIZE).transform;
        expect(b.x, id).toBeCloseTo(a.x, 6);
        expect(b.y, id).toBeCloseTo(a.y, 6);
        expect(b.scale, id).toBeCloseTo(a.scale, 6);
        expect(b.rotation, id).toBeCloseTo(a.rotation, 6);
        expect(b.opacity, id).toBeCloseTo(a.opacity, 6);
        expect(applyClipMotion(c, 2 + ph * 1.5, SIZE).transform).toEqual(a);
      }
    }
  });
  it('loop amplitudes', () => {
    const at = (id: string, ph: number) => applyClipMotion(make({ motionLoop: anim(id, 4) }), 2 + ph * 4, SIZE).transform;
    expect(at('pulse', 0.25).scale).toBeCloseTo(1.5 * 1.06, 9);
    expect(at('float', 0.25).y).toBeCloseTo(20 + 0.025 * SIZE.height, 9);
    expect(at('wobble', 0.25).rotation).toBeCloseTo(3 + 4, 9);
    expect(at('swing', 0.75).rotation).toBeCloseTo(3 - 12, 9);
    expect(at('rotate', 0.5).rotation).toBeCloseTo(3 + 180, 9);
    expect(at('bounce', 0.25).y).toBeLessThan(20);
    expect(at('bounce', 0).y).toBeCloseTo(20, 9);
    expect(at('blink', 0.2).opacity).toBeCloseTo(0.8, 9);
    expect(at('blink', 0.7).opacity).toBe(0);
    const o = at('orbit', 0.25);
    expect(o.x).toBeCloseTo(10 + 0.04 * SIZE.height, 9);
    expect(o.y).toBeCloseTo(20, 9);
    // shake holds within a step and stays small
    expect(at('shake', 0.05).x).toBe(at('shake', 0.01).x);
    for (const ph of [0, 0.1, 0.3, 0.6, 0.9]) {
      const s = at('shake', ph);
      expect(Math.abs(s.x - 10)).toBeLessThanOrEqual(0.01 * SIZE.width + 1e-9);
      expect(Math.abs(s.y - 20)).toBeLessThanOrEqual(0.01 * SIZE.width + 1e-9);
    }
  });
  it('in, out and loop compose', () => {
    const both = applyClipMotion(make({ motionIn: anim('fade'), motionLoop: anim('pulse', 4) }), 2.5, SIZE).transform;
    const fade = applyClipMotion(make({ motionIn: anim('fade') }), 2.5, SIZE).transform;
    const pulse = applyClipMotion(make({ motionLoop: anim('pulse', 4) }), 2.5, SIZE).transform;
    expect(both.opacity).toBeCloseTo(fade.opacity, 9);
    expect(both.scale).toBeCloseTo(pulse.scale, 9);
    const x = applyClipMotion(make({ motionIn: anim('slide-left'), motionLoop: anim('float', 4) }), 2.25, SIZE).transform;
    expect(x.x).toBeGreaterThan(10);
    expect(x.y).not.toBe(20);
  });
  it('never mutates the input', () => {
    const c = make({ motionIn: anim('spin'), motionOut: anim('drop'), motionLoop: anim('shake', 1) });
    const snap = JSON.stringify(c);
    for (const t of [0, 2, 2.3, 4, 5, 7.8, 8, 9]) applyClipMotion(c, t, SIZE);
    expect(JSON.stringify(c)).toBe(snap);
  });
  it('flip turns a 3d clip and only dips the scale of a 2d clip', () => {
    const flat = applyClipMotion(make({ motionIn: anim('flip') }), 2.25, SIZE).transform;
    expect(flat.rotY).toBeUndefined();
    expect(flat.scale).toBeLessThan(1.5);
    const d3 = applyClipMotion(make({ threeD: true, motionIn: anim('flip') }), 2.25, SIZE).transform;
    expect(d3.rotY).toBeLessThan(0);
    expect(d3.scale).toBe(1.5);
  });
  it('times outside the clip use the nearest edge', () => {
    const c = make({ motionIn: anim('fade'), motionOut: anim('fade') });
    expect(applyClipMotion(c, -5, SIZE).transform.opacity).toBe(0);
    expect(applyClipMotion(c, 99, SIZE).transform.opacity).toBe(0);
  });
  it('opacity stays within 0..1', () => {
    for (const id of IN_IDS) {
      for (let t = 2; t <= 8; t += 0.07) {
        const o = applyClipMotion(make({ transform: { ...DEFAULT_TRANSFORM }, motionIn: anim(id), motionOut: anim(id) }), t, SIZE).transform.opacity;
        expect(o).toBeGreaterThanOrEqual(0);
        expect(o).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('3d clip motions', () => {
  const make3 = (o: Partial<TextClip> = {}) => make({ threeD: true, ...o });
  const tf = (c: TextClip, t: number) => applyClipMotion(c, t, SIZE).transform;
  const turnDiff = (a: number, b: number) => {
    const d = (((b - a) % 360) + 360) % 360;
    return Math.min(d, 360 - d);
  };
  it('are listed and flagged', () => {
    expect(IN_3D).toEqual(['fly-in', 'flip-in-y', 'flip-in-x', 'swing-in']);
    expect(LOOP_3D).toEqual(['turntable', 'tumble', 'sway-3d', 'hover']);
  });
  it('a 2d clip ignores them', () => {
    for (const id of IN_3D) {
      const c = make({ motionIn: anim(id), motionOut: anim(id) });
      expect(applyClipMotion(c, 2.25, SIZE), id).toBe(c);
      expect(applyClipMotion(c, 7.75, SIZE), id).toBe(c);
    }
    for (const id of LOOP_3D) {
      const c = make({ motionLoop: anim(id, 2) });
      expect(applyClipMotion(c, 3.1, SIZE), id).toBe(c);
    }
  });
  it('entrances end at the identity pose', () => {
    for (const id of IN_3D) {
      const c = make3({ motionIn: anim(id) });
      expect(applyClipMotion(c, 3, SIZE), id).toBe(c);
      expect(applyClipMotion(c, 4, SIZE), id).toBe(c);
      const t = tf(c, 2.999);
      expect(Math.abs(t.z ?? 0), id).toBeLessThan(1);
      expect(Math.abs(t.rotX ?? 0), id).toBeLessThan(1);
      expect(Math.abs(t.rotY ?? 0), id).toBeLessThan(1);
    }
  });
  it('entrance start poses', () => {
    expect(tf(make3({ motionIn: anim('fly-in') }), 2).z).toBeCloseTo(2000, 9);
    expect(tf(make3({ motionIn: anim('fly-in') }), 2).opacity).toBe(0);
    expect(tf(make3({ motionIn: anim('flip-in-y') }), 2).rotY).toBeCloseTo(90, 9);
    expect(tf(make3({ motionIn: anim('flip-in-x') }), 2).rotX).toBeCloseTo(-90, 9);
    expect(tf(make3({ motionIn: anim('swing-in') }), 2).rotY).toBeCloseTo(-120, 9);
  });
  it('swing-in overshoots a little', () => {
    let max = -Infinity;
    for (let t = 2; t <= 3; t += 0.01) max = Math.max(max, tf(make3({ motionIn: anim('swing-in') }), t).rotY ?? 0);
    expect(max).toBeGreaterThan(0);
    expect(max).toBeLessThan(25);
  });
  it('adds on top of the clip transform', () => {
    const base = { ...DEFAULT_TRANSFORM, x: 10, y: 20, scale: 1.5, rotation: 3, opacity: 0.8, z: 100, rotX: 5, rotY: 7 };
    expect(tf(make3({ transform: base, motionIn: anim('fly-in') }), 2).z).toBeCloseTo(2100, 9);
    const d = tf(make3({ transform: base, motionLoop: anim('tumble', 4) }), 3);
    expect(d.rotX).toBeCloseTo(5 + 90, 9);
    expect(d.rotY).toBeCloseTo(7 + 180, 9);
  });
  it('the exit is the entrance backwards', () => {
    for (const id of IN_3D) {
      const c = make3({ motionIn: anim(id), motionOut: anim(id) });
      expect(tf(c, 8 - 0.3), id).toEqual(tf(c, 2 + 0.3));
    }
  });
  it('loops are seamless at the period and deterministic', () => {
    for (const id of LOOP_3D) {
      const c = make3({ motionLoop: anim(id, 1.5) });
      for (const ph of [0, 0.2, 0.61]) {
        const a = tf(c, 2 + ph * 1.5);
        const b = tf(c, 2 + ph * 1.5 + 3);
        expect(b.z ?? 0, id).toBeCloseTo(a.z ?? 0, 6);
        expect(b.y, id).toBeCloseTo(a.y, 6);
        expect(turnDiff(a.rotX ?? 0, b.rotX ?? 0), `${id} rotX`).toBeLessThan(1e-6);
        expect(turnDiff(a.rotY ?? 0, b.rotY ?? 0), `${id} rotY`).toBeLessThan(1e-6);
        expect(tf(c, 2 + ph * 1.5)).toEqual(a);
      }
      // the end of a cycle meets its start
      const end = tf(c, 2 + 1.5 - 1e-9);
      const start = tf(c, 2);
      expect(turnDiff(start.rotX ?? 0, end.rotX ?? 0), `${id} rotX wrap`).toBeLessThan(1e-3);
      expect(turnDiff(start.rotY ?? 0, end.rotY ?? 0), `${id} rotY wrap`).toBeLessThan(1e-3);
      expect(end.z ?? 0, id).toBeCloseTo(start.z ?? 0, 3);
    }
  });
  it('loop amplitudes', () => {
    const at = (id: string, ph: number) => tf(make3({ motionLoop: anim(id, 4) }), 2 + ph * 4);
    expect(at('turntable', 0.5).rotY).toBeCloseTo(180, 9);
    expect(at('turntable', 0.25).rotX).toBeUndefined();
    expect(at('sway-3d', 0.25).rotY).toBeCloseTo(25, 9);
    expect(at('sway-3d', 0.75).rotY).toBeCloseTo(-25, 9);
    expect(at('hover', 0.25).z).toBeCloseTo(120, 9);
    expect(at('hover', 0.75).z).toBeCloseTo(-120, 9);
    expect(Math.abs(at('hover', 0.125).y - 20)).toBeLessThan(0.011 * SIZE.height);
    for (const id of LOOP_3D) expect(at(id, 0.55), id).not.toEqual(make3().transform);
  });
  it('every entrance changes something mid-way', () => {
    for (const id of IN_3D) {
      const c = make3({ motionIn: anim(id) });
      expect(tf(c, 2.25), id).not.toEqual(c.transform);
    }
  });
  it('never mutates the input', () => {
    const c = make3({ motionIn: anim('swing-in'), motionOut: anim('fly-in'), motionLoop: anim('hover', 1) });
    const snap = JSON.stringify(c);
    for (const t of [0, 2, 2.3, 4, 7.8, 9]) applyClipMotion(c, t, SIZE);
    expect(JSON.stringify(c)).toBe(snap);
  });
});
