import { describe, expect, it } from 'vitest';
import { menuStep } from './menuBehavior';

describe('menuStep', () => {
  it('down from the last wraps to the first, up from the first wraps to the last', () => {
    expect(menuStep([true, true, true], 2, 'ArrowDown')).toBe(0);
    expect(menuStep([true, true, true], 0, 'ArrowUp')).toBe(2);
    expect(menuStep([true, true, true], 0, 'ArrowDown')).toBe(1);
    expect(menuStep([true, true, true], 2, 'ArrowUp')).toBe(1);
  });
  it('disabled items are skipped', () => {
    expect(menuStep([true, false, true], 0, 'ArrowDown')).toBe(2);
    expect(menuStep([true, false, true], 2, 'ArrowUp')).toBe(0);
    expect(menuStep([true, false, false], 0, 'ArrowDown')).toBe(0);
  });
  it('home and end go to the first and last enabled item', () => {
    expect(menuStep([false, true, true, false], 2, 'Home')).toBe(1);
    expect(menuStep([false, true, true, false], 1, 'End')).toBe(2);
  });
  it('from nothing focused, down takes the first and up the last', () => {
    expect(menuStep([false, true, true], -1, 'ArrowDown')).toBe(1);
    expect(menuStep([true, true, false], -1, 'ArrowUp')).toBe(1);
  });
  it('no enabled item or another key gives -1', () => {
    expect(menuStep([false, false], 0, 'ArrowDown')).toBe(-1);
    expect(menuStep([false, false], -1, 'Home')).toBe(-1);
    expect(menuStep([], -1, 'End')).toBe(-1);
    expect(menuStep([true, true], 0, 'a')).toBe(-1);
    expect(menuStep([true, true], 0, 'Enter')).toBe(-1);
  });
});
