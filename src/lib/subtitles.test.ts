import { describe, expect, it } from 'vitest';
import { parseSubtitles, splitIntoCues, srtTime, toSrt } from './subtitles';

describe('parseSubtitles', () => {
  it('reads srt with crlf, a bom and commas', () => {
    const src = '﻿1\r\n00:00:01,000 --> 00:00:02,500\r\nhello\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nline one\r\nline two\r\n';
    expect(parseSubtitles(src)).toEqual([
      { start: 1, end: 2.5, text: 'hello' },
      { start: 3, end: 4, text: 'line one\nline two' },
    ]);
  });
  it('works without index lines and with dots', () => {
    const cues = parseSubtitles('00:00:01.000 --> 00:00:02.000\na\n\n00:00:02.000 --> 00:00:03.000\nb');
    expect(cues.map((c) => c.text)).toEqual(['a', 'b']);
  });
  it('reads vtt: header, note, style, ids, settings, short hours', () => {
    const src = [
      'WEBVTT - title',
      '',
      'NOTE this is a comment',
      'over two lines',
      '',
      'STYLE',
      '::cue { color: red }',
      '',
      'intro',
      '00:01.500 --> 00:03.000 align:start position:10%',
      'first',
      '',
      '1:00:00.250 --> 1:00:01.000',
      'late',
    ].join('\n');
    expect(parseSubtitles(src)).toEqual([
      { start: 1.5, end: 3, text: 'first' },
      { start: 3600.25, end: 3601, text: 'late' },
    ]);
  });
  it('strips tags and style overrides, decodes entities', () => {
    const src = '00:00:01.000 --> 00:00:02.000\n{\\an8}<i>so</i> <c.yellow>very</c> <00:00:01.500>much &amp; more\n';
    expect(parseSubtitles(src)[0]!.text).toBe('so very much & more');
  });
  it('drops blank, zero length and negative cues and sorts by start', () => {
    const src = [
      '00:00:05,000 --> 00:00:06,000',
      'late',
      '',
      '00:00:01,000 --> 00:00:01,000',
      'zero',
      '',
      '00:00:03,000 --> 00:00:02,000',
      'negative',
      '',
      '00:00:02,000 --> 00:00:03,000',
      '<i> </i>',
      '',
      '00:00:00,000 --> 00:00:01,000',
      'early',
    ].join('\n');
    expect(parseSubtitles(src).map((c) => c.text)).toEqual(['early', 'late']);
  });
  it('copes with a missing blank line between cues', () => {
    const src = '1\n00:00:01,000 --> 00:00:02,000\na\n2\n00:00:02,000 --> 00:00:03,000\nb\n';
    expect(parseSubtitles(src).map((c) => c.text)).toEqual(['a', 'b']);
  });
  it('never throws, garbage gives nothing', () => {
    expect(parseSubtitles('')).toEqual([]);
    expect(parseSubtitles('hello world\nnothing here')).toEqual([]);
    expect(parseSubtitles('--> -->\n99:99 --> x')).toEqual([]);
    expect(parseSubtitles(undefined as unknown as string)).toEqual([]);
    expect(parseSubtitles('\u0000￿<<>>{\\')).toEqual([]);
  });
});

describe('toSrt', () => {
  it('formats times', () => {
    expect(srtTime(0)).toBe('00:00:00,000');
    expect(srtTime(3661.5)).toBe('01:01:01,500');
    expect(srtTime(1.0004)).toBe('00:00:01,000');
    expect(srtTime(-3)).toBe('00:00:00,000');
  });
  it('writes numbered cues with blank lines between', () => {
    const out = toSrt([
      { start: 1, end: 2, text: 'a' },
      { start: 2, end: 3.25, text: 'b\nc' },
    ]);
    expect(out).toBe('1\n00:00:01,000 --> 00:00:02,000\na\n\n2\n00:00:02,000 --> 00:00:03,250\nb\nc\n');
    expect(toSrt([])).toBe('');
  });
  it('round trips', () => {
    const cues = [
      { start: 0.5, end: 1.75, text: 'one' },
      { start: 2, end: 4, text: 'two\nlines' },
    ];
    expect(parseSubtitles(toSrt(cues))).toEqual(cues);
  });
});

describe('splitIntoCues', () => {
  it('keeps short text as one cue over the whole range', () => {
    expect(splitIntoCues('hello there', 2, 3)).toEqual([{ start: 2, end: 5, text: 'hello there' }]);
    expect(splitIntoCues('   ', 0, 1)).toEqual([]);
  });
  it('breaks at sentence ends first', () => {
    const cues = splitIntoCues('This is the first sentence here. And this is the second one, with a comma.', 0, 10, 42);
    expect(cues.map((c) => c.text)).toEqual(['This is the first sentence here.', 'And this is the second one, with a comma.']);
  });
  it('then at commas', () => {
    const cues = splitIntoCues('one two three four five, six seven eight nine ten eleven', 0, 4, 32);
    expect(cues.map((c) => c.text)).toEqual(['one two three four five,', 'six seven eight nine ten eleven']);
  });
  it('then at words, never longer than the limit', () => {
    const text = 'the quick brown fox jumps over the lazy dog and keeps on running far away';
    const cues = splitIntoCues(text, 0, 6, 20);
    for (const c of cues) expect(c.text.length).toBeLessThanOrEqual(20);
    expect(cues.map((c) => c.text).join(' ')).toBe(text);
  });
  it('keeps a single long word whole', () => {
    const cues = splitIntoCues('a supercalifragilisticexpialidocious b', 0, 3, 10);
    expect(cues.map((c) => c.text)).toEqual(['a', 'supercalifragilisticexpialidocious', 'b']);
  });
  it('shares the duration by length, back to back, ending exactly at the end', () => {
    const cues = splitIntoCues('aaaa bbbb cccc dddd', 10, 8, 9);
    expect(cues.map((c) => c.text)).toEqual(['aaaa bbbb', 'cccc dddd']);
    expect(cues[0]!.start).toBe(10);
    expect(cues[0]!.end).toBeCloseTo(14, 9);
    expect(cues[1]!.start).toBe(cues[0]!.end);
    expect(cues[1]!.end).toBe(18);
    const uneven = splitIntoCues('aa. bbbbbb', 0, 8, 5);
    expect(uneven[0]!.end).toBeCloseTo((8 * 3) / 9, 9);
  });
  it('treats line breaks as spaces', () => {
    expect(splitIntoCues('a\nb', 0, 1)[0]!.text).toBe('a b');
  });
});
