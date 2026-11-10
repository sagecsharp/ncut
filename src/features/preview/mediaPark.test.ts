import { describe, expect, it } from 'vitest';
import { ParkingLot } from './mediaPark';

describe('ParkingLot', () => {
  it('takes back the most recent item of a url, once', () => {
    const lot = new ParkingLot<string>();
    lot.park('a', 'a1');
    lot.park('a', 'a2');
    expect(lot.take('a')).toBe('a2');
    expect(lot.take('a')).toBe('a1');
    expect(lot.take('a')).toBeUndefined();
    expect(lot.size).toBe(0);
  });

  it('does not hand out an item of another url', () => {
    const lot = new ParkingLot<string>();
    lot.park('a', 'a1');
    expect(lot.take('b')).toBeUndefined();
    expect(lot.size).toBe(1);
  });

  it('keeps at most 2 per url: the oldest of that url is evicted', () => {
    const lot = new ParkingLot<string>();
    expect(lot.park('a', 'a1')).toEqual([]);
    expect(lot.park('a', 'a2')).toEqual([]);
    expect(lot.park('a', 'a3')).toEqual(['a1']);
    expect(lot.countFor('a')).toBe(2);
  });

  it('keeps at most 6 in total: the oldest overall is evicted', () => {
    const lot = new ParkingLot<string>();
    const gone: string[] = [];
    for (let i = 0; i < 8; i++) gone.push(...lot.park(`u${i}`, `i${i}`));
    expect(gone).toEqual(['i0', 'i1']);
    expect(lot.size).toBe(6);
    expect(lot.take('u0')).toBeUndefined();
    expect(lot.take('u7')).toBe('i7');
  });

  it('evicts by url and by predicate', () => {
    const lot = new ParkingLot<string>();
    lot.park('a', 'a1');
    lot.park('b', 'b1');
    lot.park('c', 'c1');
    expect(lot.evictUrl('b')).toEqual(['b1']);
    expect(lot.evictWhere((u) => u !== 'a')).toEqual(['c1']);
    expect(lot.size).toBe(1);
  });

  it('clear returns everything', () => {
    const lot = new ParkingLot<number>();
    lot.park('a', 1);
    lot.park('b', 2);
    expect(lot.clear()).toEqual([1, 2]);
    expect(lot.size).toBe(0);
    expect(lot.clear()).toEqual([]);
  });

  it('a parked item that is taken no longer counts against the caps', () => {
    const lot = new ParkingLot<string>();
    lot.park('a', 'a1');
    lot.park('a', 'a2');
    lot.take('a');
    expect(lot.park('a', 'a3')).toEqual([]);
  });
});
