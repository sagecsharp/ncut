import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VideoClip } from '../types';
import { DEFAULT_TRANSFORM } from '../types';
import { createProject } from '../lib/factory';
import { useEditor } from './editorStore';
import { advanceClock, mediaPlaybackRate, nextShuttleRate, rateAudible, resetPlayback, usePlayback } from './playback';

const pb = () => usePlayback.getState();

let frames: Array<(now: number) => void> = [];
let clock = 0;

/** run the queued animation frame callbacks once, `ms` later */
function frame(ms = 16): void {
  clock += ms;
  const run = frames;
  frames = [];
  for (const cb of run) cb(clock);
}

beforeEach(() => {
  frames = [];
  clock = 1000;
  vi.stubGlobal('requestAnimationFrame', (cb: (n: number) => void) => frames.push(cb));
  vi.stubGlobal('cancelAnimationFrame', () => {
    frames = [];
  });
  vi.stubGlobal('performance', { now: () => clock });
  const p = createProject('pb');
  const clip: VideoClip = {
    id: 'c1',
    type: 'video',
    trackId: p.tracks[0]!.id,
    start: 0,
    duration: 10,
    name: 'c',
    fadeIn: 0,
    fadeOut: 0,
    assetId: 'a',
    trimStart: 0,
    speed: 1,
    volume: 1,
    muted: false,
    transform: { ...DEFAULT_TRANSFORM },
  } as unknown as VideoClip;
  useEditor.getState().openProject({ ...p, clips: [clip] });
  resetPlayback();
  usePlayback.setState({ time: 0, playing: false, loop: false, speed: 1, rate: 1 });
});

afterEach(() => {
  resetPlayback();
  vi.unstubAllGlobals();
});

describe('nextShuttleRate', () => {
  it('starts at 1x in the asked direction when paused', () => {
    expect(nextShuttleRate(1, false, 1)).toBe(1);
    expect(nextShuttleRate(1, false, -1)).toBe(-1);
  });
  it('climbs 1 2 4 8 and stays', () => {
    let r = nextShuttleRate(1, false, 1);
    const seen = [r];
    for (let i = 0; i < 5; i++) seen.push((r = nextShuttleRate(r, true, 1)));
    expect(seen).toEqual([1, 2, 4, 8, 8, 8]);
    expect(nextShuttleRate(-4, true, -1)).toBe(-8);
  });
  it('the other direction resets to 1x', () => {
    expect(nextShuttleRate(4, true, -1)).toBe(-1);
    expect(nextShuttleRate(-8, true, 1)).toBe(1);
  });
  it('goes to the next rung from an in between speed', () => {
    expect(nextShuttleRate(0.5, true, 1)).toBe(1);
    expect(nextShuttleRate(1.5, true, 1)).toBe(2);
  });
});

describe('advanceClock', () => {
  it('moves forward and backwards', () => {
    expect(advanceClock(5, 0.5, 2, 10, false)).toEqual({ time: 6, ended: false });
    expect(advanceClock(5, 0.5, -2, 10, false)).toEqual({ time: 4, ended: false });
  });
  it('stops at both ends without loop', () => {
    expect(advanceClock(9.9, 0.5, 1, 10, false)).toEqual({ time: 10, ended: true });
    expect(advanceClock(0.1, 0.5, -1, 10, false)).toEqual({ time: 0, ended: true });
  });
  it('wraps with loop in both directions', () => {
    expect(advanceClock(9.5, 1, 1, 10, true).time).toBeCloseTo(0.5);
    expect(advanceClock(0.5, 1, -1, 10, true).time).toBeCloseTo(9.5);
    expect(advanceClock(0.5, 1, -1, 10, true).ended).toBe(false);
  });
});

describe('media rate', () => {
  it('multiplies clip speed and rate inside the browser range', () => {
    expect(mediaPlaybackRate(1, 1)).toBe(1);
    expect(mediaPlaybackRate(0.5, 2)).toBe(1);
    expect(mediaPlaybackRate(2, 8)).toBe(16);
  });
  it('returns 0 (seek instead) backwards or out of range', () => {
    expect(mediaPlaybackRate(1, -1)).toBe(0);
    expect(mediaPlaybackRate(4, 8)).toBe(0);
    expect(mediaPlaybackRate(0.01, 1)).toBe(0);
  });
  it('audio is on up to 4x forward only', () => {
    expect(rateAudible(1)).toBe(true);
    expect(rateAudible(4)).toBe(true);
    expect(rateAudible(8)).toBe(false);
    expect(rateAudible(-1)).toBe(false);
  });
});

describe('playback store', () => {
  it('shuttle steps 1 2 4 8 and stays', () => {
    const seen: number[] = [];
    for (let i = 0; i < 5; i++) {
      pb().shuttle(1);
      seen.push(pb().rate);
    }
    expect(seen).toEqual([1, 2, 4, 8, 8]);
    expect(pb().playing).toBe(true);
  });
  it('the other direction resets to 1x', () => {
    pb().shuttle(1);
    pb().shuttle(1);
    pb().shuttle(-1);
    expect(pb().rate).toBe(-1);
    pb().shuttle(-1);
    expect(pb().rate).toBe(-2);
    pb().shuttle(1);
    expect(pb().rate).toBe(1);
  });
  it('pause puts the rate back to the speed', () => {
    pb().setSpeed(1.5);
    pb().shuttle(-1);
    pb().shuttle(-1);
    pb().pause();
    expect(pb().playing).toBe(false);
    expect(pb().rate).toBe(1.5);
  });
  it('play while shuttling goes back to forward at speed', () => {
    pb().setSpeed(0.5);
    pb().shuttle(-1);
    pb().play();
    expect(pb().playing).toBe(true);
    expect(pb().rate).toBe(0.5);
  });
  it('setSpeed clamps and applies when plain', () => {
    pb().setSpeed(100);
    expect(pb().speed).toBe(4);
    expect(pb().rate).toBe(4);
    pb().setSpeed(0.01);
    expect(pb().speed).toBe(0.25);
    pb().setSpeed(NaN);
    expect(pb().speed).toBe(1);
  });
  it('setSpeed does not disturb a shuttle', () => {
    pb().shuttle(1);
    pb().shuttle(1);
    pb().setSpeed(0.5);
    expect(pb().speed).toBe(0.5);
    expect(pb().rate).toBe(2);
    pb().pause();
    expect(pb().rate).toBe(0.5);
  });
  it('plays forward at the rate and stops at the end', () => {
    pb().shuttle(1);
    pb().shuttle(1);
    pb().seek(9.9);
    frame();
    frame(100);
    expect(pb().time).toBe(10);
    expect(pb().playing).toBe(false);
    expect(pb().rate).toBe(1);
  });
  it('backwards stops at 0 without loop', () => {
    pb().seek(0.2);
    pb().shuttle(-1);
    frame();
    frame(500);
    expect(pb().time).toBe(0);
    expect(pb().playing).toBe(false);
    expect(pb().rate).toBe(1);
  });
  it('backwards wraps with loop and keeps playing', () => {
    pb().setLoop(true);
    pb().seek(0.1);
    pb().shuttle(-1);
    frame();
    frame(200);
    expect(pb().playing).toBe(true);
    expect(pb().time).toBeGreaterThan(9.5);
    expect(pb().rate).toBe(-1);
  });
  it('shuttle backwards from the very start begins at the end', () => {
    pb().shuttle(-1);
    expect(pb().time).toBe(10);
  });
  it('resetPlayback rewinds and restores the rate', () => {
    pb().shuttle(1);
    pb().shuttle(1);
    resetPlayback();
    expect(pb().playing).toBe(false);
    expect(pb().time).toBe(0);
    expect(pb().rate).toBe(pb().speed);
  });
});
