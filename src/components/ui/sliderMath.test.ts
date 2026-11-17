import { describe, expect, it } from 'vitest';
import {
  MIN_TRAVEL,
  beginDrag,
  decimalsOf,
  faceOf,
  gestureHint,
  isPastThreshold,
  keptDrag,
  moveDrag,
  nudge,
  parseTyped,
  rateOf,
  roundTo,
  unitText,
  type SliderSpec,
} from './sliderMath';

const spec = (o: Partial<SliderSpec> = {}): SliderSpec => ({
  min: -Infinity,
  max: Infinity,
  soft: [0, 100],
  step: 1,
  precision: 0,
  snap: 10,
  perPx: 0.25,
  origin: null,
  ...o,
});

describe('sliderMath', () => {
  it('decimalsOf gives the decimals of a step', () => {
    expect(decimalsOf(1)).toBe(0);
    expect(decimalsOf(0.1)).toBe(1);
    expect(decimalsOf(0.05)).toBe(2);
    expect(decimalsOf(0.25)).toBe(2);
    expect(decimalsOf(0.001)).toBe(3);
    expect(decimalsOf(2)).toBe(0);
    expect(decimalsOf(1e-9)).toBe(6);
  });

  it('roundTo lands on the grid without float noise and never gives -0', () => {
    expect(roundTo(0.1 + 0.2, 0.1, 1)).toBe(0.3);
    expect(roundTo(7.4, 5, 0)).toBe(5);
    expect(roundTo(7.6, 5, 0)).toBe(10);
    expect(roundTo(-0.4, 1, 0)).toBe(0);
    expect(Object.is(roundTo(-0.4, 1, 0), -0)).toBe(false);
    expect(roundTo(1.2345, 0.05, 2)).toBe(1.25);
  });

  it('faceOf fills from 0 when 0 is inside the face', () => {
    const f = faceOf(50, [-100, 100], null)!;
    expect(f.a).toBeCloseTo(0.5, 9);
    expect(f.b).toBeCloseTo(0.75, 9);
    expect(f.v).toBeCloseTo(0.75, 9);
    expect(f.pin).toBeNull();
    const g = faceOf(-50, [-100, 100], null)!;
    expect(g.a).toBeCloseTo(0.25, 9);
    expect(g.b).toBeCloseTo(0.5, 9);
  });

  it('faceOf fills from the low end when 0 is outside the face', () => {
    const f = faceOf(30, [10, 110], null)!;
    expect(f.a).toBe(0);
    expect(f.b).toBeCloseTo(0.2, 9);
  });

  it('faceOf uses a given origin', () => {
    const f = faceOf(50, [50, 150], 100)!;
    expect(f.a).toBe(0);
    expect(f.b).toBe(0.5);
    const g = faceOf(125, [50, 150], 100)!;
    expect(g.a).toBe(0.5);
    expect(g.b).toBe(0.75);
  });

  it('faceOf pins over and under past the face', () => {
    const over = faceOf(130, [0, 100], null)!;
    expect(over.pin).toBe('over');
    expect(over.v).toBe(1);
    expect(over.b).toBe(1);
    const under = faceOf(-5, [0, 100], null)!;
    expect(under.pin).toBe('under');
    expect(under.v).toBe(0);
    expect(faceOf(100, [0, 100], null)!.pin).toBeNull();
  });

  it('faceOf is null without a face, with an empty face or a value that is not finite', () => {
    expect(faceOf(5, null, null)).toBeNull();
    expect(faceOf(5, [3, 3], null)).toBeNull();
    expect(faceOf(5, [4, 3], null)).toBeNull();
    expect(faceOf(Number.NaN, [0, 10], null)).toBeNull();
    expect(faceOf(Infinity, [0, 10], null)).toBeNull();
  });

  it('rateOf is the face over the width, MIN_TRAVEL for a narrow field, perPx without a face', () => {
    expect(rateOf(spec({ soft: [0, 200] }), 400)).toBe(0.5);
    expect(rateOf(spec({ soft: [0, 120] }), 60)).toBe(120 / MIN_TRAVEL);
    expect(rateOf(spec({ soft: null, perPx: 0.02 }), 300)).toBe(0.02);
  });

  it('a drag starts at its start value', () => {
    const s = spec();
    const d = beginDrag(42, 300, s, 100, false, false);
    expect(d.out).toBe(42);
    expect(d.anchorV).toBe(42);
    expect(moveDrag(d, 300, false, false, s).out).toBe(42);
  });

  it('a straight drag is linear and rounds to the step', () => {
    const s = spec({ soft: [0, 120] });
    const d0 = beginDrag(10, 0, s, 120, false, false);
    expect(moveDrag(d0, 20, false, false, s).out).toBe(30);
    expect(moveDrag(d0, 20.4, false, false, s).out).toBe(30);
    const s2 = spec({ soft: [0, 1], step: 0.1, precision: 1 });
    const e0 = beginDrag(0, 0, s2, 120, false, false);
    const e1 = moveDrag(e0, 30, false, false, s2);
    expect(e1.out).toBe(0.3);
  });

  it('shift mid drag does not jump, then moves a tenth as fast on the fine grid', () => {
    const s = spec({ soft: [0, 120] });
    let d = beginDrag(0, 0, s, 120, false, false);
    d = moveDrag(d, 50, false, false, s);
    expect(d.out).toBe(50);
    d = moveDrag(d, 50, true, false, s);
    expect(d.out).toBe(50);
    d = moveDrag(d, 60, true, false, s);
    expect(d.out).toBe(51);
    // back to the normal speed: no jump either
    d = moveDrag(d, 60, false, false, s);
    expect(d.out).toBe(51);
    d = moveDrag(d, 70, false, false, s);
    expect(d.out).toBe(61);
  });

  it('ctrl snaps at once without a pointer move', () => {
    const s = spec({ soft: [0, 120] });
    let d = beginDrag(0, 0, s, 120, false, false);
    d = moveDrag(d, 47, false, false, s);
    expect(d.out).toBe(47);
    d = moveDrag(d, 47, false, true, s);
    expect(d.out).toBe(50);
    expect(d.snap).toBe(true);
  });

  it('past the face the value goes on at the same rate', () => {
    const s = spec({ soft: [0, 120] });
    let d = beginDrag(100, 0, s, 120, false, false);
    d = moveDrag(d, 20, false, false, s);
    expect(d.out).toBe(120);
    d = moveDrag(d, 60, false, false, s);
    expect(d.out).toBe(160);
    expect(faceOf(d.out, s.soft, null)!.pin).toBe('over');
  });

  it('a hard limit stops the value and the first pixel back moves it', () => {
    const s = spec({ soft: [0, 120], min: 0, max: 120 });
    let d = beginDrag(90, 0, s, 120, false, false);
    d = moveDrag(d, 500, false, false, s);
    expect(d.out).toBe(120);
    d = moveDrag(d, 499, false, false, s);
    expect(d.out).toBe(119);
    d = moveDrag(d, -500, false, false, s);
    expect(d.out).toBe(0);
    d = moveDrag(d, -499, false, false, s);
    expect(d.out).toBe(1);
  });

  it('a start value past a hard limit does not move by itself', () => {
    const s = spec({ soft: [0, 120], min: 0, max: 120 });
    let d = beginDrag(150, 20, s, 120, false, false);
    expect(d.hi).toBe(150);
    d = moveDrag(d, 20, false, false, s);
    expect(d.out).toBe(150);
    d = moveDrag(d, 30, false, false, s);
    expect(d.out).toBe(150);
    d = moveDrag(d, 10, false, false, s);
    expect(d.out).toBe(130);
  });

  it('keptDrag goes on from the kept value', () => {
    const s = spec({ soft: [0, 120], min: 0, max: 120 });
    let d = beginDrag(10, 0, s, 120, false, false);
    d = moveDrag(d, 60, false, false, s);
    expect(d.out).toBe(70);
    d = keptDrag(d, 40);
    expect(d.out).toBe(40);
    d = moveDrag(d, 70, false, false, s);
    expect(d.out).toBe(50);
  });

  it('nudge steps, ten steps when big, stays inside the hard range', () => {
    const s = spec({ step: 0.1, precision: 1, min: 0, max: 1 });
    expect(nudge(0.2, 1, false, s)).toBe(0.3);
    expect(nudge(0.3, -1, false, s)).toBe(0.2);
    expect(nudge(0.1, 1, true, s)).toBe(1);
    expect(nudge(0.5, 1, true, s)).toBe(1);
    expect(nudge(0.5, -1, true, s)).toBe(0);
    expect(nudge(0, -1, false, s)).toBe(0);
    expect(Object.is(nudge(0.1, -1, false, s), 0)).toBe(true);
  });

  it('parseTyped reads numbers, commas, units and maths', () => {
    expect(parseTyped('12')).toBe(12);
    expect(parseTyped('1,5')).toBe(1.5);
    expect(parseTyped('1920/2')).toBe(960);
    expect(parseTyped('-(10+5)*2')).toBe(-30);
    expect(parseTyped('50%')).toBe(50);
    expect(parseTyped('2 s')).toBe(2);
    expect(parseTyped('90deg')).toBe(90);
    expect(parseTyped('90°')).toBe(90);
    expect(parseTyped('1.5x')).toBe(1.5);
    expect(parseTyped('1e3')).toBe(1000);
    expect(parseTyped('.5')).toBe(0.5);
    expect(parseTyped(' 7 px ')).toBe(7);
  });

  it('parseTyped refuses junk', () => {
    for (const t of ['abc', '', '1/0', '2*(3', '1 2', 'px']) expect(parseTyped(t), t).toBeNull();
  });

  it('isPastThreshold: 3 px for a mouse, 8 px for touch and pen', () => {
    expect(isPastThreshold(2, 'mouse')).toBe(false);
    expect(isPastThreshold(-3, 'mouse')).toBe(true);
    expect(isPastThreshold(7, 'touch')).toBe(false);
    expect(isPastThreshold(8, 'pen')).toBe(true);
  });

  it('unitText puts no space before %, ° and x', () => {
    expect(unitText('100', '%')).toBe('100%');
    expect(unitText('15', '°')).toBe('15°');
    expect(unitText('1', 'x')).toBe('1x');
    expect(unitText('15', 'deg')).toBe('15 deg');
    expect(unitText('10', 'px')).toBe('10 px');
    expect(unitText('0.5', 's')).toBe('0.5 s');
    expect(unitText('8', '')).toBe('8');
  });

  it('gestureHint with and without a rest value', () => {
    expect(gestureHint('15 deg', '0 deg')).toBe('drag sideways or click to type. shift: finer. ctrl: steps of 15 deg. double click: back to 0 deg');
    expect(gestureHint('10%', null)).toBe('drag sideways or click to type. shift: finer. ctrl: steps of 10%');
  });
});
