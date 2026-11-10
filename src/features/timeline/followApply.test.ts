import { describe, expect, it } from 'vitest';
import type { Project } from '../../types';
import { followBase, markFollowGesture } from './followApply';

const p = (n: number) => ({ n }) as unknown as Project;

describe('followBase', () => {
  it('keeps the project from before the first change of a gesture', () => {
    markFollowGesture();
    expect(followBase(p(1))).toEqual(p(1));
    expect(followBase(p(2))).toEqual(p(1));
    expect(followBase(p(3))).toEqual(p(1));
  });
  it('a new gesture takes a new snapshot', () => {
    markFollowGesture();
    expect(followBase(p(5))).toEqual(p(5));
  });
});
