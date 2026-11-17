import { describe, expect, it } from 'vitest';
import { trimStopText } from './trimText';
import type { P, TrimStop } from './trimModes';

const proj = (a: string, b: string): P => ({ clips: [{ id: 'a', type: 'text', text: a }, { id: 'b', type: 'text', text: b }], tracks: [], assets: [] }) as unknown as P;
const stop = (why: TrimStop['why']): TrimStop => ({ why, clipId: 'a', otherId: 'b' }) as TrimStop;

describe('trimStopText', () => {
  it('fills the clip and the other clip', () => {
    expect(trimStopText(stop('overlap'), proj('one', 'two'))).toBe('"one" would run into "two"');
  });
  it('does not read dollar patterns in a name', () => {
    expect(trimStopText(stop('overlap'), proj('save $$$', 'x $& y'))).toBe('"save $$$" would run into "x $& y"');
    expect(trimStopText(stop('overlap'), proj("x $' y", 'b'))).toBe('"x $\' y" would run into "b"');
  });
  it('does not fill a slot that a name put in', () => {
    expect(trimStopText(stop('overlap'), proj('{other}', 'b'))).toBe('"{other}" would run into "b"');
  });
});
