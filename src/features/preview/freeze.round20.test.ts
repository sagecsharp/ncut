import { describe, expect, it } from 'vitest';
import { createTextClip } from '../../lib/factory';
import type { Clip, EffectClip, TextClip, VisualClip } from '../../types';
import { keepRun } from '../properties/lookClipboard';
import { effectShiftMoves, shiftMoves } from './freezePlan';

const clip = (id: string, trackId: string, start: number, duration: number, extra: Record<string, unknown> = {}): Clip =>
  ({ id, type: 'image', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'a', transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, ...extra }) as unknown as Clip;
const fx = (id: string, trackId: string, start: number, duration: number, target: string): EffectClip =>
  ({ id, type: 'effect', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, effect: 'blur', amount: 1, seed: 1, params: {}, target }) as unknown as EffectClip;

describe('effects that do not cover their clip exactly still follow it in a freeze', () => {
  const tracks = [{ id: 'fxt' }, { id: 'v' }, { id: 'lock', locked: true }];
  // after a freeze at 2 s: the right half of the video (2..10) moves to 4..12
  const clips: Clip[] = [
    clip('left', 'v', 0, 2),
    clip('right', 'v', 2, 8),
    fx('e-left', 'fxt', 1, 1, 'left'),
    fx('e-right', 'fxt', 2, 1, 'right'), // trimmed shorter than its clip: the usual follower rule misses it
    fx('e-late', 'fxt', 6, 2, 'right'),
    fx('e-locked', 'lock', 3, 1, 'right'),
    fx('e-other', 'fxt', 9, 1, 'someone-else'),
  ];
  const moves = shiftMoves(clips, 'v', 2, 2);

  it('moves the effects on the moving clip that start at or after the cut', () => {
    expect(moves.map((m) => m.id)).toEqual(['right']);
    expect(effectShiftMoves(clips, tracks, moves, 2, 2)).toEqual([
      { id: 'e-right', trackId: 'fxt', start: 4 },
      { id: 'e-late', trackId: 'fxt', start: 8 },
    ]);
  });

  it('leaves effects on clips that stay, on locked tracks, and the ones already in the list', () => {
    const withOne = [...moves, { id: 'e-right', trackId: 'fxt', start: 4 }];
    expect(effectShiftMoves(clips, tracks, withOne, 2, 2).map((m) => m.id)).toEqual(['e-late']);
    expect(effectShiftMoves(clips, tracks, [], 2, 2)).toEqual([]);
  });
});

describe('a pasted karaoke style keeps where a cut left the run of the target', () => {
  const target = { ...createTextClip('t', 1, { text: 'a b c', duration: 1 }), highlight: { color: '#fff', mode: 'fill', offset: 1, fullDuration: 2 } } as TextClip;
  it('offset and fullDuration of the target survive', () => {
    const out = keepRun({ highlight: { color: '#f00', mode: 'word' }, color: '#000' }, target as VisualClip);
    expect(out.highlight).toEqual({ color: '#f00', mode: 'word', offset: 1, fullDuration: 2 });
    expect(out.color).toBe('#000');
  });
  it('nothing changes for a target without a run, a look without karaoke, or a clip that is no text', () => {
    const plain = createTextClip('t', 0, { text: 'a' }) as VisualClip;
    const patch = { highlight: { color: '#f00', mode: 'word' } };
    expect(keepRun(patch, plain)).toBe(patch);
    const off = { highlight: null };
    expect(keepRun(off, target as VisualClip)).toBe(off);
    expect(keepRun(patch, clip('i', 'v', 0, 1) as VisualClip)).toBe(patch);
  });
});
