import { describe, expect, it } from 'vitest';
import type { Clip, Track } from '../../types';
import { targetOptions } from './targets';
import { coverScale, defaultSecondColor, hasPoints } from './shapeLogic';

const tracks: Track[] = [
  { id: 't1', kind: 'video', name: 'video 1', muted: false, hidden: false, locked: false },
  { id: 't2', kind: 'video', name: 'video 2', muted: false, hidden: false, locked: false },
];
const mk = (id: string, trackId: string, extra: Record<string, unknown>): Clip =>
  ({ id, trackId, start: 0, duration: 1, name: '', fadeIn: 0, fadeOut: 0, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, ...extra }) as Clip;

describe('camera targets', () => {
  it('lists visual clips only, using names and text', () => {
    const clips = [
      mk('a', 't1', { type: 'image', assetId: 'x', name: 'logo' }),
      mk('b', 't1', { type: 'text', text: 'hello\nworld' }),
      mk('c', 't1', { type: 'audio', assetId: 'x' }),
      mk('d', 't2', { type: 'effect' }),
    ];
    expect(targetOptions(clips, tracks).map((o) => o.label)).toEqual(['logo', 'hello']);
  });
  it('adds the track name when labels repeat, then a number', () => {
    const clips = [
      mk('a', 't1', { type: 'text', text: 'hi' }),
      mk('b', 't2', { type: 'text', text: 'hi' }),
      mk('c', 't2', { type: 'text', text: 'hi' }),
    ];
    expect(targetOptions(clips, tracks).map((o) => o.label)).toEqual(['hi (video 1)', 'hi (video 2) 1', 'hi (video 2) 2']);
  });
  it('falls back to the type for unnamed clips', () => {
    expect(targetOptions([mk('a', 't1', { type: 'shape', kind: 'rect' })], tracks)[0]!.label).toBe('shape');
  });
});

describe('shape helpers', () => {
  it('knows which kinds have corners', () => {
    expect(hasPoints('star')).toBe(true);
    expect(hasPoints('polygon')).toBe(true);
    expect(hasPoints('rect')).toBe(false);
  });
  it('picks a readable second color', () => {
    expect(defaultSecondColor('#000000')).toBe('#ffffff');
    expect(defaultSecondColor('#fff')).toBe('#000000');
    expect(defaultSecondColor('red')).toBe('#ffffff');
  });
  it('covers the canvas', () => {
    expect(coverScale(1, 100, 50, 200, 200)).toBe(4);
    expect(coverScale(2, 0, 0, 10, 10)).toBe(2);
  });
});
