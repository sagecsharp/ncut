import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaAsset, Project, VideoClip } from '../types';
import { DEFAULT_TRANSFORM } from '../types';
import { beginExport, endExport } from '../engine/exportState';
import { createProject } from '../lib/factory';
import { useEditor } from './editorStore';
import { usePlayback } from './playback';
import { setSourceMaster, sourceAsset, sourceVisible, useSource } from './source';
import { useUi } from './ui';

const src = () => useSource.getState();
const ed = () => useEditor.getState();
const FPS = 30;
const LAST = 299 / FPS; // the last frame of a 10 s file at 30 fps

let frames: Array<(now: number) => void> = [];
let clock = 0;

/** run the queued animation frame callbacks once, `ms` later */
function frame(ms = 16): void {
  clock += ms;
  const run = frames;
  frames = [];
  for (const cb of run) cb(clock);
}

const video: MediaAsset = { id: 'va', name: 'clip', kind: 'video', mime: 'video/mp4', size: 1, duration: 10, width: 1920, height: 1080, hasAudio: true, createdAt: 0 };
const sound: MediaAsset = { id: 'au', name: 'sound', kind: 'audio', mime: 'audio/mpeg', size: 1, duration: 6, width: 0, height: 0, hasAudio: true, createdAt: 0 };
const image: MediaAsset = { id: 'img', name: 'img', kind: 'image', mime: 'image/png', size: 1, duration: 0, width: 100, height: 100, hasAudio: false, createdAt: 0 };

function openProject(): Project {
  const p = createProject('source', undefined, FPS);
  const clip: VideoClip = { id: 'c1', type: 'video', trackId: p.tracks[0]!.id, start: 0, duration: 10, name: 'c', fadeIn: 0, fadeOut: 0, assetId: 'va', trimStart: 0, speed: 1, volume: 1, muted: false, transform: { ...DEFAULT_TRANSFORM } };
  const project = { ...p, assets: [{ ...video }, { ...sound }, { ...image }], clips: [clip] };
  ed().openProject(project);
  return project;
}

beforeEach(() => {
  frames = [];
  clock = 1000;
  vi.stubGlobal('requestAnimationFrame', (cb: (n: number) => void) => frames.push(cb));
  vi.stubGlobal('cancelAnimationFrame', () => {
    frames = [];
  });
  vi.stubGlobal('performance', { now: () => clock });
  setSourceMaster(null);
  useUi.setState({ previewMode: 'output', programMode: 'output', dialog: null });
  useSource.setState({ assetId: null, time: 0, playing: false, rate: 1, toOut: false, split: false });
  usePlayback.setState({ time: 0, playing: false, loop: false, speed: 1, rate: 1 });
  openProject();
});

afterEach(() => {
  setSourceMaster(null);
  vi.unstubAllGlobals();
});

describe('the source store', () => {
  it('open clamps and remembers', () => {
    src().open('va', 99);
    expect(src().assetId).toBe('va');
    expect(src().time).toBeCloseTo(LAST, 9);
    // same media, no time: nothing. a time always seeks
    src().open('va');
    expect(src().time).toBeCloseTo(LAST, 9);
    src().open('va', 2);
    expect(src().time).toBe(2);
    src().seek(-5);
    expect(src().time).toBe(0);
    src().seek(2.5);
    // another media: where it was left is where it opens again
    src().open('au');
    expect(src().assetId).toBe('au');
    expect(src().time).toBe(0);
    src().open('va');
    expect(src().time).toBe(2.5);
    // an id that is not in the project: nothing
    src().open('gone', 1);
    expect(src().assetId).toBe('va');
    // close remembers too
    src().seek(4);
    src().close();
    expect(src().assetId).toBeNull();
    expect(src().time).toBe(0);
    src().seek(5);
    expect(src().time).toBe(0);
    src().open('va');
    expect(src().time).toBe(4);
    expect(sourceAsset()?.id).toBe('va');
  });

  it('play stops on the last frame', () => {
    src().open('va', 9.9);
    src().play();
    expect(src().playing).toBe(true);
    expect(src().rate).toBe(1);
    for (let i = 0; i < 10 && src().playing; i++) frame(50);
    expect(src().playing).toBe(false);
    expect(src().time).toBeCloseTo(LAST, 9);
    // play again from the end: from the start
    src().play();
    expect(src().playing).toBe(true);
    expect(src().time).toBe(0);
    // play while playing keeps going, and ends a shuttle
    src().shuttle(1);
    expect(src().rate).toBe(2);
    src().play();
    expect(src().rate).toBe(1);
    expect(src().playing).toBe(true);
    // nothing to play
    src().close();
    src().play();
    expect(src().playing).toBe(false);
  });

  it('loop inside the marks', () => {
    ed().setMediaMarks('va', { in: 2, out: 4 });
    usePlayback.setState({ loop: true });
    src().open('va', 0);
    src().play();
    // from outside the marks: at the in point
    expect(src().time).toBe(2);
    src().seek(3.9);
    frame(100);
    // 3.9 + 0.1 reaches the out point: back to the in point
    expect(src().playing).toBe(true);
    expect(src().time).toBe(2);
    // backwards from the in point: to the last frame inside
    src().shuttle(-1);
    frame(16);
    expect(src().time).toBeLessThan(4);
    expect(src().time).toBeGreaterThanOrEqual(2);
    // a tick that crosses the in point backwards wraps to the last frame inside
    src().seek(2.01);
    frame(100);
    expect(src().time).toBeCloseTo(119 / FPS, 9);
    expect(src().playing).toBe(true);
    src().pause();
    // loop off: marks do not bound a plain play
    usePlayback.setState({ loop: false });
    src().seek(3.9);
    src().play();
    frame(100);
    expect(src().time).toBeGreaterThan(3.99);
    expect(src().playing).toBe(true);
  });

  it('play in to out twice', () => {
    ed().setMediaMarks('va', { in: 1, out: 2 });
    src().open('va', 5);
    expect(src().playInToOut()).toBe(true);
    expect(src().playing).toBe(true);
    expect(src().toOut).toBe(true);
    expect(src().time).toBe(1);
    // a second call pauses
    frame(100);
    expect(src().playInToOut()).toBe(true);
    expect(src().playing).toBe(false);
    expect(src().toOut).toBe(false);
    // and it plays on to the out point and stops on the last frame inside
    expect(src().playInToOut()).toBe(true);
    for (let i = 0; i < 10 && src().playing; i++) frame(250);
    expect(src().playing).toBe(false);
    expect(src().time).toBeCloseTo(59 / FPS, 9);
    expect(src().toOut).toBe(false);
    // a seek out of the marks ends it
    expect(src().playInToOut()).toBe(true);
    src().seek(6);
    expect(src().toOut).toBe(false);
    src().pause();
    // no marks: false
    src().open('au');
    expect(src().playInToOut()).toBe(false);
    expect(src().playing).toBe(false);
    // with loop on: again and again
    usePlayback.setState({ loop: true });
    src().open('va');
    expect(src().playInToOut()).toBe(true);
    for (let i = 0; i < 8; i++) frame(250);
    expect(src().playing).toBe(true);
    expect(src().time).toBeGreaterThanOrEqual(1);
    expect(src().time).toBeLessThan(2);
  });

  it('shuttle', () => {
    src().open('va', 3);
    src().shuttle(1);
    expect(src().playing).toBe(true);
    expect(src().rate).toBe(1);
    src().shuttle(1);
    expect(src().rate).toBe(2);
    src().shuttle(1);
    expect(src().rate).toBe(4);
    // the other way: 1x back
    src().shuttle(-1);
    expect(src().rate).toBe(-1);
    frame(100);
    expect(src().time).toBeCloseTo(2.9, 6);
    // back to the start stops there
    src().seek(0.1);
    for (let i = 0; i < 5 && src().playing; i++) frame(100);
    expect(src().playing).toBe(false);
    expect(src().time).toBe(0);
    expect(src().rate).toBe(1);
    // at the start paused, back plays from the last frame. forward at the end plays from 0
    src().shuttle(-1);
    expect(src().time).toBeCloseTo(LAST, 9);
    expect(src().rate).toBe(-1);
    src().pause();
    src().seek(99);
    src().shuttle(1);
    expect(src().time).toBe(0);
  });

  it('pause snaps down', () => {
    src().open('va', 1.01);
    src().play();
    frame(50);
    const t = src().time;
    expect(t).toBeCloseTo(1.06, 6);
    src().pause();
    expect(src().time).toBeCloseTo(31 / FPS, 9);
    expect(src().playing).toBe(false);
    expect(src().rate).toBe(1);
    // paused: a pause does nothing to the time
    src().seek(1.01);
    src().pause();
    expect(src().time).toBe(1.01);
  });

  it('steps', () => {
    src().open('va', 1);
    src().stepFrames(1);
    expect(src().time).toBeCloseTo(31 / FPS, 9);
    src().stepFrames(-1);
    expect(src().time).toBeCloseTo(1, 9);
    src().seek(0);
    src().stepFrames(-1);
    expect(src().time).toBe(0);
    src().seek(99);
    src().stepFrames(1);
    expect(src().time).toBeCloseTo(LAST, 9);
    // a step pauses
    src().seek(1);
    src().play();
    src().stepFrames(1);
    expect(src().playing).toBe(false);
    // from between frames, back lands on the frame start
    src().seek(1.01);
    src().stepFrames(-1);
    expect(src().time).toBeCloseTo(1, 9);
    // no media: nothing
    src().close();
    src().stepFrames(1);
    expect(src().time).toBe(0);
  });

  it('master', () => {
    let m: number | null = 3;
    setSourceMaster(() => m);
    src().open('va', 0);
    src().play();
    frame(16);
    expect(src().time).toBe(3);
    // the element cannot lead yet: time holds, the loop goes on
    m = null;
    frame(16);
    expect(src().time).toBe(3);
    expect(src().playing).toBe(true);
    m = 3.5;
    frame(16);
    expect(src().time).toBe(3.5);
    // the element ended
    m = Infinity;
    frame(16);
    expect(src().playing).toBe(false);
    expect(src().time).toBeCloseTo(LAST, 9);
    // backwards the clock leads
    src().seek(5);
    src().shuttle(-1);
    m = 99;
    frame(100);
    expect(src().time).toBeCloseTo(4.9, 6);
  });

  it('one plays at a time', () => {
    src().open('va', 1);
    usePlayback.getState().play();
    expect(usePlayback.getState().playing).toBe(true);
    src().play();
    expect(src().playing).toBe(true);
    expect(usePlayback.getState().playing).toBe(false);
    usePlayback.getState().play();
    expect(usePlayback.getState().playing).toBe(true);
    expect(src().playing).toBe(false);
    // the time of the paused one is kept
    expect(src().time).toBeCloseTo(1, 9);
  });

  it('hidden pauses', () => {
    src().open('va', 1);
    // the source view active, the timeline plays: switching to the source view stops the timeline
    usePlayback.getState().play();
    useUi.getState().activateSource();
    expect(usePlayback.getState().playing).toBe(false);
    expect(sourceVisible()).toBe(true);
    src().play();
    // back to the timeline: the source is hidden
    useUi.getState().activateProgram();
    expect(src().playing).toBe(false);
    expect(sourceVisible()).toBe(false);
    // side by side: nothing is hidden by a switch
    src().setSplit(true);
    expect(sourceVisible()).toBe(true);
    src().play();
    useUi.getState().activateSource();
    useUi.getState().activateProgram();
    expect(src().playing).toBe(true);
    // the split closes while the timeline side is shown: the source pane goes
    src().setSplit(false);
    expect(src().playing).toBe(false);
    // the split closes while the source view is active: the timeline side goes
    src().setSplit(true);
    useUi.getState().activateSource();
    usePlayback.getState().play();
    expect(usePlayback.getState().playing).toBe(true);
    src().setSplit(false);
    expect(usePlayback.getState().playing).toBe(false);
  });

  it('the page going hidden pauses', async () => {
    const doc = Object.assign(new EventTarget(), { hidden: false });
    vi.stubGlobal('document', doc);
    vi.resetModules();
    const fresh = await import('./source');
    const freshEd = (await import('./editorStore')).useEditor;
    freshEd.getState().openProject({ ...createProject('source', undefined, FPS), assets: [{ ...video }] });
    fresh.useSource.getState().open('va', 1);
    fresh.useSource.getState().play();
    expect(fresh.useSource.getState().playing).toBe(true);
    doc.hidden = true;
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(fresh.useSource.getState().playing).toBe(false);
  });

  it('export stops it', () => {
    src().open('va', 1);
    src().play();
    expect(src().playing).toBe(true);
    useUi.getState().openDialog('export');
    expect(src().playing).toBe(false);
    useUi.getState().closeDialog();
    beginExport();
    try {
      src().play();
      expect(src().playing).toBe(false);
      src().shuttle(1);
      expect(src().playing).toBe(false);
      ed().setMediaMarks('va', { in: 1, out: 2 });
      expect(src().playInToOut()).toBe(false);
    } finally {
      endExport();
    }
    src().play();
    expect(src().playing).toBe(true);
  });

  it('an export that starts while it plays stops it on the next tick', () => {
    src().open('va', 1);
    src().play();
    expect(src().playing).toBe(true);
    beginExport();
    try {
      frame();
      expect(src().playing).toBe(false);
    } finally {
      endExport();
    }
  });

  it('project change closes', () => {
    src().open('va', 2);
    useUi.getState().activateSource();
    expect(useUi.getState().previewMode).toBe('source');
    openProject();
    expect(src().assetId).toBeNull();
    expect(useUi.getState().previewMode).toBe('output');
    // where media was left is forgotten with the project
    src().open('va');
    expect(src().time).toBe(0);
    // the same project changing is no close
    src().seek(3);
    ed().updateProject({ name: 'renamed' });
    expect(src().assetId).toBe('va');
    expect(src().time).toBe(3);
  });

  it('removed media closes', () => {
    src().open('au', 1);
    ed().removeAsset('va');
    expect(src().assetId).toBe('au');
    ed().removeAsset('au');
    expect(src().assetId).toBeNull();
    expect(sourceAsset()).toBeNull();
  });

  it('pictures never play', () => {
    src().open('img', 5);
    expect(src().assetId).toBe('img');
    expect(src().time).toBe(0);
    src().play();
    expect(src().playing).toBe(false);
    src().shuttle(1);
    expect(src().playing).toBe(false);
    src().toggle();
    expect(src().playing).toBe(false);
    src().seek(3);
    expect(src().time).toBe(0);
    src().stepFrames(1);
    expect(src().time).toBe(0);
    expect(src().playInToOut()).toBe(false);
  });
});
