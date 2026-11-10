import { describe, expect, it } from 'vitest';
import { parseFavorites, pickFavorites, toggleIn } from './favorites';

describe('parseFavorites', () => {
  it('starts empty for nothing, junk and wrong shapes', () => {
    const empty = { effects: [], transitions: [] };
    expect(parseFavorites(null)).toEqual(empty);
    expect(parseFavorites('')).toEqual(empty);
    expect(parseFavorites('{nope')).toEqual(empty);
    expect(parseFavorites('[1,2]')).toEqual(empty);
    expect(parseFavorites('{"effects":"blur","transitions":5}')).toEqual(empty);
  });
  it('keeps strings once, in order', () => {
    expect(parseFavorites('{"effects":["blur",3,"","glitch","blur"],"transitions":["fade"]}')).toEqual({
      effects: ['blur', 'glitch'],
      transitions: ['fade'],
    });
  });
});

describe('toggleIn', () => {
  it('adds at the end and takes out', () => {
    expect(toggleIn([], 'a')).toEqual(['a']);
    expect(toggleIn(['a', 'b'], 'c')).toEqual(['a', 'b', 'c']);
    expect(toggleIn(['a', 'b', 'c'], 'b')).toEqual(['a', 'c']);
  });
  it('does not change the list it was given', () => {
    const list = ['a'];
    toggleIn(list, 'b');
    expect(list).toEqual(['a']);
  });
});

describe('pickFavorites', () => {
  const all = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  it('keeps the starred order and drops ids that no longer exist', () => {
    expect(pickFavorites(['c', 'gone', 'a'], all).map((x) => x.id)).toEqual(['c', 'a']);
  });
  it('applies the search', () => {
    expect(pickFavorites(['c', 'a'], all, (x) => x.id !== 'c').map((x) => x.id)).toEqual(['a']);
  });
  it('is empty without stars', () => {
    expect(pickFavorites([], all)).toEqual([]);
  });
});
