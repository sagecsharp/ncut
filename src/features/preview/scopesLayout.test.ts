import { describe, expect, it } from 'vitest';
import { BELOW_MIN, cellGrid, fitArea, placeScopes, scopesSize, SIDE_MIN } from './scopesLayout';

describe('placeScopes', () => {
  it('a wide body puts the scopes at the side', () => {
    expect(placeScopes(800, 450, 1920, 1080)).toBe('side');
    expect(placeScopes(1200, 500, 1920, 1080)).toBe('side');
  });
  it('a tall narrow body puts them below', () => {
    expect(placeScopes(600, 900, 1920, 1080)).toBe('below');
  });
  it('a vertical project goes to the side', () => {
    expect(placeScopes(800, 450, 1080, 1920)).toBe('side');
  });
  it('it judges the default sizes, not the dragged ones', () => {
    // with a dragged side of 400 or a dragged below of 120 the below layout would win here
    expect(fitArea(800 - 400 - 24, 426, 1920, 1080)).toBeLessThan(fitArea(776, 450 - 120 - 24, 1920, 1080));
    expect(placeScopes(800, 450, 1920, 1080, 'side')).toBe('side');
  });
  it('it stays unless the other is 5% better', () => {
    let held = 0;
    let flipped = 0;
    for (let h = 300; h <= 1000; h += 5) {
      const fresh = placeScopes(800, h, 1920, 1080);
      const other = fresh === 'side' ? 'below' : 'side';
      const stay = placeScopes(800, h, 1920, 1080, other);
      if (stay === other) held++;
      else flipped++;
      // the current placement is never left for no reason
      expect(placeScopes(800, h, 1920, 1080, fresh)).toBe(fresh);
    }
    expect(held).toBeGreaterThan(0);
    expect(flipped).toBeGreaterThan(0);
  });
  it('fitArea is 0 for anything not positive', () => {
    expect(fitArea(0, 100, 16, 9)).toBe(0);
    expect(fitArea(100, 100, 0, 9)).toBe(0);
    expect(Math.round(fitArea(476, 426, 1920, 1080))).toBe(Math.round((476 * (476 * 9)) / 16));
  });
});

describe('scopesSize', () => {
  it('scopesSize clamps', () => {
    expect(scopesSize('side', 300, 800, 450)).toBe(300);
    expect(scopesSize('side', 50, 800, 450)).toBe(SIDE_MIN);
    expect(scopesSize('side', 5000, 800, 450)).toBe(400);
    expect(scopesSize('below', 50, 800, 450)).toBe(BELOW_MIN);
    expect(scopesSize('below', 5000, 800, 450)).toBe(225);
    // a body too small for the minimum: half of it
    expect(scopesSize('side', 300, 300, 200)).toBe(150);
    expect(scopesSize('below', 220, 300, 200)).toBe(100);
  });
});

describe('cellGrid', () => {
  it('cellGrid', () => {
    expect(cellGrid(2, 300, 400)).toEqual({ cols: 1, rows: 2 });
    expect(cellGrid(2, 776, 190)).toEqual({ cols: 2, rows: 1 });
    expect(cellGrid(4, 400, 400)).toEqual({ cols: 2, rows: 2 });
    expect(cellGrid(1, 100, 100)).toEqual({ cols: 1, rows: 1 });
    expect(cellGrid(0, 100, 100)).toEqual({ cols: 1, rows: 1 });
    // a tie keeps fewer columns
    expect(cellGrid(2, 200, 200)).toEqual({ cols: 1, rows: 2 });
  });
});
