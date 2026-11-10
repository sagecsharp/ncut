import { describe, expect, it } from 'vitest';
import { visibleMotions } from './motionLogic';

const list = [
  { id: 'fade', name: 'fade' },
  { id: 'flip3d', name: 'flip 3d', threeD: true },
];

describe('visibleMotions', () => {
  it('shows everything for a 3d clip', () => {
    expect(visibleMotions(list, true, undefined).map((m) => m.id)).toEqual(['fade', 'flip3d']);
  });
  it('hides 3d-only motions for a 2d clip', () => {
    expect(visibleMotions(list, false, undefined).map((m) => m.id)).toEqual(['fade']);
    expect(visibleMotions(list, false, 'fade').map((m) => m.id)).toEqual(['fade']);
  });
  it('keeps a stored 3d-only motion on a 2d clip', () => {
    expect(visibleMotions(list, false, 'flip3d').map((m) => m.id)).toEqual(['fade', 'flip3d']);
  });
});
