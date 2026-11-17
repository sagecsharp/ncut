import { beforeEach, describe, expect, it } from 'vitest';
import type { Project, VideoClip } from '../types';
import { DEFAULT_TRANSFORM } from '../types';
import { createProject } from '../lib/factory';
import { useEditor } from './editorStore';

const ed = () => useEditor.getState();
const proj = (): Project => ed().project!;
const height = (id: string) => proj().tracks.find((t) => t.id === id)!.height;

/** one video track, one audio track, a clip on the video track. returns the track ids */
function open(): { v: string; a: string } {
  const p = createProject('tracks');
  const v = p.tracks.find((t) => t.kind === 'video')!.id;
  const a = p.tracks.find((t) => t.kind === 'audio')!.id;
  const clip: VideoClip = { id: 'c1', type: 'video', trackId: v, start: 0, duration: 10, name: 'c', fadeIn: 0, fadeOut: 0, assetId: 'a', trimStart: 0, speed: 1, volume: 1, muted: false, transform: { ...DEFAULT_TRANSFORM } };
  ed().openProject({ ...p, clips: [clip] });
  return { v, a };
}

let ids = { v: '', a: '' };

beforeEach(() => {
  useEditor.setState({ project: null, selection: [], past: [], future: [], clipboard: [] });
  ids = open();
});

describe('setTrackHeights', () => {
  it('setTrackHeights is not an undo step', () => {
    expect(ed().setTrackHeights({ [ids.v]: 96 })).toBe(true);
    expect(height(ids.v)).toBe(96);
    expect(ed().past).toHaveLength(0);
    expect(ed().future).toHaveLength(0);
    // the same patch changes nothing
    const p = proj();
    expect(ed().setTrackHeights({ [ids.v]: 96 })).toBe(false);
    expect(proj()).toBe(p);
    // null on a default track changes nothing
    expect(ed().setTrackHeights({ [ids.a]: null })).toBe(false);
    expect(proj()).toBe(p);
    // an unknown id changes nothing
    expect(ed().setTrackHeights({ nope: 96 })).toBe(false);
    expect(proj()).toBe(p);
    // the default stores as missing
    expect(ed().setTrackHeights({ [ids.v]: null })).toBe(true);
    expect('height' in proj().tracks[0]!).toBe(false);
    expect(ed().past).toHaveLength(0);
  });

  it('no project gives false', () => {
    useEditor.setState({ project: null });
    expect(ed().setTrackHeights({ x: 96 })).toBe(false);
  });

  it('only the listed tracks change, the clips stay the same objects', () => {
    const before = proj();
    ed().setTrackHeights({ [ids.a]: 72 });
    expect(height(ids.a)).toBe(72);
    expect(height(ids.v)).toBeUndefined();
    expect(proj().clips).toBe(before.clips);
    expect(proj().tracks.find((t) => t.id === ids.v)).toBe(before.tracks.find((t) => t.id === ids.v));
  });
});

describe('heights through history', () => {
  it('undo, redo and rollback keep the heights of now', () => {
    ed().addMarker(1, 'm');
    ed().setTrackHeights({ [ids.v]: 96 });
    ed().undo();
    expect(proj().markers).toBeUndefined();
    expect(height(ids.v)).toBe(96);
    ed().redo();
    expect(proj().markers).toHaveLength(1);
    expect(height(ids.v)).toBe(96);
    // a height set after the step was made survives its undo and redo, and a height taken back too
    ed().setTrackHeights({ [ids.a]: 128, [ids.v]: null });
    ed().undo();
    expect(height(ids.a)).toBe(128);
    expect(height(ids.v)).toBeUndefined();
    ed().redo();
    expect(height(ids.a)).toBe(128);
    // rollback
    ed().pushHistory();
    ed().updateTrack(ids.a, { muted: true });
    ed().setTrackHeights({ [ids.a]: 176 });
    ed().rollback();
    expect(proj().tracks.find((t) => t.id === ids.a)!.muted).toBe(false);
    expect(height(ids.a)).toBe(176);
  });

  it('with a moveTrack step the heights follow the track id', () => {
    const second = ed().addTrack('video');
    ed().setTrackHeights({ [ids.v]: 96 });
    const order = proj().tracks.map((t) => t.id);
    // swap the two video tracks: one step
    const to = order.indexOf(second) === 0 ? 1 : 0;
    ed().moveTrack(second, to);
    const moved = proj().tracks.map((t) => t.id);
    expect(moved).not.toEqual(order);
    ed().setTrackHeights({ [second]: 72 });
    ed().undo();
    // the reorder is undone, each height stays with its track
    expect(proj().tracks.map((t) => t.id)).toEqual(order);
    expect(height(second)).toBe(72);
    expect(height(ids.v)).toBe(96);
    ed().redo();
    expect(proj().tracks.map((t) => t.id)).toEqual(moved);
    expect(height(second)).toBe(72);
    expect(height(ids.v)).toBe(96);
  });

  it('undo without a height change keeps the tracks array', () => {
    ed().addMarker(1, 'm');
    const tracks = proj().tracks;
    ed().undo();
    expect(proj().markers).toBeUndefined();
    expect(proj().tracks).toBe(tracks);
    ed().redo();
    expect(proj().tracks).toBe(tracks);
  });

  it('an open gesture keeps its step whole', () => {
    ed().pushHistory();
    ed().setTrackHeights({ [ids.v]: 96 });
    // the height did not close the gesture: the first real change is its one step
    ed().updateTrack(ids.a, { muted: true }, { skipHistory: true });
    expect(ed().past).toHaveLength(1);
    expect(height(ids.v)).toBe(96);
    ed().undo();
    expect(proj().tracks.find((t) => t.id === ids.a)!.muted).toBe(false);
    expect(height(ids.v)).toBe(96);
    expect(ed().past).toHaveLength(0);
  });

  it('a height written while a step is on the past stays after undo', () => {
    ed().updateTrack(ids.a, { muted: true });
    ed().setTrackHeights({ [ids.a]: 72 });
    ed().undo();
    expect(proj().tracks.find((t) => t.id === ids.a)!.muted).toBe(false);
    expect(height(ids.a)).toBe(72);
  });
});

describe('updateTrack syncLock', () => {
  it('updateTrack syncLock is one step', () => {
    ed().updateTrack(ids.a, { syncLock: false });
    expect(proj().tracks.find((t) => t.id === ids.a)!.syncLock).toBe(false);
    expect(ed().past).toHaveLength(1);
    // the same value is no step
    ed().updateTrack(ids.a, { syncLock: false });
    expect(ed().past).toHaveLength(1);
    ed().updateTrack(ids.a, { syncLock: true });
    expect('syncLock' in proj().tracks.find((t) => t.id === ids.a)!).toBe(false);
    expect(ed().past).toHaveLength(2);
    ed().undo();
    expect(proj().tracks.find((t) => t.id === ids.a)!.syncLock).toBe(false);
    ed().undo();
    expect('syncLock' in proj().tracks.find((t) => t.id === ids.a)!).toBe(false);
  });
});
