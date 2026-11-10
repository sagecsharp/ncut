import { describe, expect, it } from 'vitest';
import type { Clip, Project, TextClip } from '../../types';
import { resolveShown, worldClip } from './attached';

const text = (over: Partial<TextClip> = {}): TextClip =>
  ({
    id: 't',
    type: 'text',
    trackId: 'v',
    start: 2,
    duration: 4,
    name: 't',
    fadeIn: 0,
    fadeOut: 0,
    text: 'score {n}',
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    ...over,
  }) as TextClip;

const project = (clips: Clip[]): Project => ({ width: 1000, height: 500, tracks: [], clips, assets: [] }) as unknown as Project;

describe('resolveShown', () => {
  const counter = { from: 0, to: 100, decimals: 0, separator: false, ease: 'linear' as const, hold: 0 };

  it('writes the running number into a counter text and takes the counter off', () => {
    const c = text({ counter });
    const mid = resolveShown(c, 4);
    expect(mid.counter).toBeNull();
    expect(mid.text).toBe('score 50');
    expect(resolveShown(c, 2).text).toBe('score 0');
  });
  it('a text without a counter keeps its text', () => {
    const c = text();
    expect(resolveShown(c, 4).text).toBe('score {n}');
  });
  it('worldClip shows the number too, so the box measures the drawn text', () => {
    const c = text({ counter, text: '{n}' });
    expect(worldClip(project([c]), c, 6 - 1e-9).text).toBe('100');
  });
});
