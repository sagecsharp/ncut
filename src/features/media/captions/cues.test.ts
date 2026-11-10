import { describe, expect, it } from 'vitest';
import { createTextClip } from '../../../lib/factory';
import { CAPTION_WRAP, CAPTION_Y, captionStyle, clipsToCues, cueName, cuesToClips, splitTextClip } from './cues';

describe('cueName', () => {
  it('takes the first words', () => {
    expect(cueName('one two three four five six')).toBe('one two three four');
    expect(cueName('   ')).toBe('caption');
    expect(cueName('x'.repeat(60)).length).toBeLessThanOrEqual(24);
  });
});

describe('cuesToClips', () => {
  it('builds caption clips at the bottom, sized by the project', () => {
    const clips = cuesToClips([{ start: 1, end: 3.5, text: 'hello there\nfriend' }], 1920, 1080);
    expect(clips).toHaveLength(1);
    const c = clips[0]!;
    expect(c.type).toBe('text');
    expect(c.start).toBe(1);
    expect(c.duration).toBeCloseTo(2.5, 9);
    expect(c.text).toBe('hello there\nfriend');
    expect(c.name).toBe('hello there friend');
    expect(c.transform.y).toBe(Math.round(1080 * CAPTION_Y));
    expect(c.wrapWidth).toBe(Math.round(1920 * CAPTION_WRAP));
    expect(c.fontSize).toBe(49);
    expect(c.color).toBe('#ffffff');
    expect(c.stroke?.color).toBe('#000000');
  });
  it('skips cues that are too short or empty', () => {
    expect(cuesToClips([{ start: 0, end: 0.01, text: 'x' }, { start: 0, end: 1, text: ' ' }], 100, 100)).toEqual([]);
  });
  it('scales with the project', () => {
    expect(captionStyle(1080, 1920).fontSize).toBe(86);
  });
});

describe('clipsToCues', () => {
  it('sorts text clips by start and keeps overlaps, ignores other clips', () => {
    const a = createTextClip('t', 5, { text: 'late', duration: 2 });
    const b = createTextClip('t', 1, { text: 'early', duration: 3 });
    const c = createTextClip('u', 2, { text: 'overlap', duration: 1 });
    const blank = createTextClip('u', 0, { text: '  ' });
    expect(clipsToCues([a, b, c, blank])).toEqual([
      { start: 1, end: 4, text: 'early' },
      { start: 2, end: 3, text: 'overlap' },
      { start: 5, end: 7, text: 'late' },
    ]);
    expect(clipsToCues([])).toEqual([]);
  });
});

describe('splitTextClip', () => {
  const long = createTextClip('t', 10, {
    text: 'This is the first sentence of a long caption. And here is the second sentence which is long too.',
    duration: 8,
    color: '#ff0000',
    group: 'g1',
    fontSize: 33,
  });
  it('cuts over the same range and keeps the style', () => {
    const pieces = splitTextClip(long, 45);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces[0]!.start).toBe(10);
    const last = pieces[pieces.length - 1]!;
    expect(last.start + last.duration).toBeCloseTo(18, 9);
    for (let i = 1; i < pieces.length; i++) expect(pieces[i]!.start).toBeCloseTo(pieces[i - 1]!.start + pieces[i - 1]!.duration, 9);
    for (const p of pieces) {
      expect(p.color).toBe('#ff0000');
      expect(p.fontSize).toBe(33);
      expect(p.trackId).toBe('t');
      expect(p.group).toBeUndefined();
      expect(p.text.length).toBeLessThanOrEqual(45);
    }
  });
  it('returns nothing when the text is already short', () => {
    expect(splitTextClip(createTextClip('t', 0, { text: 'short' }))).toEqual([]);
  });
});
