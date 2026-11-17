import { describe, expect, it } from 'vitest';
import type { Easing } from '../../types';
import { KEY_HIT_PX, KEY_MERGE_PX, KEY_STRIP_H, hitKey, hitKeyAt, keyShape, keyX, mergeKeys } from './keyGeometry';

describe('keyGeometry', () => {
  it('keyShape for the eight eases on both sides', () => {
    const right: Record<string, string> = { linear: 'point', ease: 'round', 'ease-in': 'round', 'ease-out': 'point', back: 'point', bounce: 'point', elastic: 'point', hold: 'square' };
    const left: Record<string, string> = { linear: 'point', ease: 'round', 'ease-in': 'point', 'ease-out': 'round', back: 'round', bounce: 'point', elastic: 'round', hold: 'square' };
    for (const id of Object.keys(right) as Easing[]) {
      // a key in the middle: the left half comes from the key before, the right half from its own ease
      expect(keyShape('linear', id).right).toBe(right[id]);
      expect(keyShape(id, 'linear').left).toBe(left[id]);
      expect(keyShape(id, id)).toEqual({ left: left[id], right: right[id] });
    }
  });

  it('first, last, single and unknown eases', () => {
    // the first key copies its right half to the left, the last its left half to the right
    expect(keyShape(null, 'hold')).toEqual({ left: 'square', right: 'square' });
    expect(keyShape(null, 'ease')).toEqual({ left: 'round', right: 'round' });
    expect(keyShape('ease-out', null)).toEqual({ left: 'round', right: 'round' });
    expect(keyShape('bounce', null)).toEqual({ left: 'point', right: 'point' });
    expect(keyShape(null, null)).toEqual({ left: 'point', right: 'point' });
    // custom and unknown eases are round
    expect(keyShape('bezier', 'bezier')).toEqual({ left: 'round', right: 'round' });
    expect(keyShape('nope' as Easing, 'nope' as Easing)).toEqual({ left: 'round', right: 'round' });
  });

  it('hitKeyAt nearest within px', () => {
    const times = [0, 1, 2, 3, 10];
    const x = (t: number) => t * 10;
    expect(hitKeyAt(times, x, 10, 5)).toBe(1);
    expect(hitKeyAt(times, x, 13, 5)).toBe(1);
    expect(hitKeyAt(times, x, 17, 5)).toBe(2);
    expect(hitKeyAt(times, x, 45, 5)).toBe(-1);
    expect(hitKeyAt(times, x, 100, 5)).toBe(4);
    expect(hitKeyAt(times, x, 105, 5)).toBe(4);
    expect(hitKeyAt(times, x, 106, 5)).toBe(-1);
    expect(hitKeyAt(times, x, -5, 5)).toBe(0);
    expect(hitKeyAt([], x, 0, 5)).toBe(-1);
    // a tie takes the earlier index
    expect(hitKeyAt(times, x, 15, 5)).toBe(1);
    // x need not be t * zoom: a scrolled origin works
    expect(hitKeyAt(times, (t) => t * 10 - 100, 0, 3)).toBe(4);
  });

  it('keyX, mergeKeys and hitKey unchanged', () => {
    expect(KEY_STRIP_H).toBe(11);
    expect(KEY_MERGE_PX).toBe(3);
    expect(KEY_HIT_PX).toBe(5);
    // kept inside the clip box
    expect(keyX(0, 10, 100)).toBe(5);
    expect(keyX(5, 10, 100)).toBe(50);
    expect(keyX(20, 10, 100)).toBe(95);
    expect(keyX(0, 10, 4)).toBe(5);
    // groups start at the first key and span less than KEY_MERGE_PX
    expect(mergeKeys([1, 1.1, 1.2, 1.4, 3], 10, 100)).toEqual([[1, 1.1, 1.2], [1.4], [3]]);
    expect(mergeKeys([], 10, 100)).toEqual([]);
    // a press must be in the strip along the bottom of the clip box
    expect(hitKey([1, 3], 10, 100, 40, 10, 35)).toBe(1);
    expect(hitKey([1, 3], 10, 100, 40, 10, 10)).toBeNull();
    expect(hitKey([1, 3], 10, 100, 40, 17, 35)).toBeNull();
    expect(hitKey([1, 1.2], 10, 100, 40, 11.5, 35)).toBe(1.2);
  });
});
