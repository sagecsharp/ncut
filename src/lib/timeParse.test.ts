import { describe, expect, it } from 'vitest';
import { FPS_OPTIONS } from './factory';
import { formatAmount, formatDuration, formatTimeAs, formatTimecode, parseTimeEntry, rulerLabelFor } from './time';
import type { ParsedTime, TimeDisplay } from './time';

const at = (frame: number): ParsedTime => ({ kind: 'at', frame });
const by = (frames: number): ParsedTime => ({ kind: 'by', frames });
const bad = (why: 'bad' | 'frames-whole' | 'too-far' | 'zero'): ParsedTime => ({ kind: 'error', why });

describe('parseTimeEntry', () => {
  it('the 3.1 examples at 30 fps', () => {
    const at30: Array<[string, number]> = [
      ['1:2:3:4', 111694], ['02:03:04', 3694], ['1:30', 60], ['1:30:00', 2700], ['1m30s', 2700], ['1;15', 45], ['90F', 90],
      ['12.5s', 375], ['12.5', 375], ['.5s', 15], ['12.', 360], ['15', 15], ['2s12f', 72], ['1.5h', 162000], ['1.5s2f', 47],
    ];
    for (const [text, frame] of at30) expect(parseTimeEntry(text, 30), text).toEqual(at(frame));
    const by30: Array<[string, number]> = [['+15', 15], ['-1:00', -30], ['- 2s', -60], ['−2s', -60], ['+ 1_5', 15]];
    for (const [text, frames] of by30) expect(parseTimeEntry(text, 30), text).toEqual(by(frames));
    expect(parseTimeEntry('  1M30S ', 30)).toEqual(at(2700));
    expect(parseTimeEntry('25:00:00:00', 30)).toEqual(bad('too-far'));
    expect(parseTimeEntry('24:00:00:00', 30)).toEqual(at(86400 * 30));
  });

  it('the grammar at 24, 120 and 240 fps', () => {
    expect(parseTimeEntry('1:30', 24)).toEqual(at(54));
    expect(parseTimeEntry('1:100', 120)).toEqual(at(220));
    expect(parseTimeEntry('1:02:03', 24)).toEqual(at((62 * 24) + 3));
    expect(parseTimeEntry('1m2s3f', 24)).toEqual(at(62 * 24 + 3));
    expect(parseTimeEntry('12.5', 24)).toEqual(at(300));
    expect(parseTimeEntry('1:02:03', 120)).toEqual(at(62 * 120 + 3));
    expect(parseTimeEntry('1m2s3f', 120)).toEqual(at(62 * 120 + 3));
    expect(parseTimeEntry('12.5', 120)).toEqual(at(1500));
    expect(parseTimeEntry('1:02:03', 240)).toEqual(at(62 * 240 + 3));
    expect(parseTimeEntry('1m2s3f', 240)).toEqual(at(62 * 240 + 3));
    expect(parseTimeEntry('12.5', 240)).toEqual(at(3000));
  });

  it('errors and empties', () => {
    for (const text of ['1:2:3:4:5', '+-5', '1:30.5', '1ms', 'abc']) expect(parseTimeEntry(text, 30), text).toEqual(bad('bad'));
    expect(parseTimeEntry('2.5f', 30)).toEqual(bad('frames-whole'));
    expect(parseTimeEntry('1s2.5f', 30)).toEqual(bad('frames-whole'));
    expect(parseTimeEntry('25h', 30)).toEqual(bad('too-far'));
    expect(parseTimeEntry('+0', 30)).toEqual(bad('zero'));
    expect(parseTimeEntry('+0.01s', 30)).toEqual(bad('zero'));
    expect(parseTimeEntry('+', 30)).toEqual({ kind: 'empty', relative: true });
    expect(parseTimeEntry('-  ', 30)).toEqual({ kind: 'empty', relative: true });
    expect(parseTimeEntry('', 30)).toEqual({ kind: 'empty', relative: false });
    expect(parseTimeEntry('  ', 30)).toEqual({ kind: 'empty', relative: false });
    expect(parseTimeEntry('0', 30)).toEqual(at(0));
  });

  it('every display text reads back', () => {
    const modes: TimeDisplay[] = ['timecode', 'frames', 'seconds'];
    for (const fps of FPS_OPTIONS) {
      for (const mode of modes) {
        const ks = [...Array.from({ length: 3 * fps + 1 }, (_, k) => k), 3600 * fps, 86400 * fps];
        for (const k of ks) {
          const text = formatTimeAs(k / fps, fps, mode);
          expect(parseTimeEntry(text, fps), `${fps} ${mode} ${k} ${text}`).toEqual(at(k));
        }
      }
    }
  });

  it('formatAmount', () => {
    expect(formatAmount(12, 30, 'timecode')).toBe('+12f');
    expect(formatAmount(-30, 30, 'timecode')).toBe('-00:01:00');
    expect(formatAmount(375, 30, 'frames')).toBe('+375f');
    expect(formatAmount(375, 30, 'seconds')).toBe('+12.50s');
    expect(formatAmount(0, 30, 'timecode')).toBe('0f');
  });

  it('rulerLabelFor timecode is today\'s expression', () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < 2000; i++) {
      const t = rnd() * 7200;
      const fps = FPS_OPTIONS[Math.floor(rnd() * FPS_OPTIONS.length)]!;
      expect(rulerLabelFor(t, fps, true, 'timecode')).toBe(formatTimecode(t, fps));
      expect(rulerLabelFor(t, fps, false, 'timecode')).toBe(formatDuration(t));
    }
  });
});
