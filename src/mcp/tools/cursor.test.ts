import { beforeEach, describe, expect, it } from 'vitest';
import { useMcpCursors } from '../../store/mcpCursors';
import { addVideoClip, call, ed, fresh, proj, refused } from './editKit';

let video = '';
let clip = '';
beforeEach(() => {
  ({ video } = fresh());
  clip = addVideoClip(video, 0);
  useMcpCursors.setState({ enabled: true, cursors: [] });
});

describe('point_at', () => {
  it('points at a clip, a track, a time or a spot on the canvas', async () => {
    const c = await call('point_at', { clip, cursor: 'main' });
    expect(c.ok).toBe(true);
    expect(c.data.pointing).toBe(`the clip ${clip}`);
    expect(c.data.shown).toBe(true);
    expect(useMcpCursors.getState().cursors[0]!.target).toEqual({ kind: 'clip', id: clip });

    const t = await call('point_at', { track: video, cursor: 'main' });
    expect(t.data.pointing).toBe(`the track ${video}`);
    expect(useMcpCursors.getState().cursors[0]!.target).toEqual({ kind: 'track', id: video });

    const time = await call('point_at', { time: 2.5, cursor: 'main' });
    expect(time.data.pointing).toBe('2.5 s on the time ruler');
    expect(useMcpCursors.getState().cursors[0]!.target).toEqual({ kind: 'time', time: 2.5 });

    const xy = await call('point_at', { x: 0, y: 0, cursor: 'main' });
    expect(xy.ok).toBe(true);
    expect(xy.data.pointing).toContain('x 0, y 0');
    expect(useMcpCursors.getState().cursors[0]!.target).toEqual({ kind: 'canvas', x: 0, y: 0 });
  });

  it('time 0 and x / y of 0 are real targets', async () => {
    expect((await call('point_at', { time: 0 })).ok).toBe(true);
    expect((await call('point_at', { x: 0, y: -5 })).ok).toBe(true);
  });

  it('shows the note in a bubble on the callers own cursor, other cursors are left alone', async () => {
    await call('point_at', { clip, note: '  this one is too long  ', cursor: 'main' });
    await call('point_at', { time: 1, note: 'and here', cursor: 'sub 1' });
    const list = useMcpCursors.getState().cursors;
    expect(list.map((c) => [c.name, c.note, c.phase])).toEqual([
      ['main', 'this one is too long', 'done'],
      ['sub 1', 'and here', 'done'],
    ]);
  });

  it('a call without a name is the default cursor', async () => {
    await call('point_at', { clip, note: 'hi' });
    expect(useMcpCursors.getState().cursors.map((c) => c.name)).toEqual(['agent']);
  });

  it('changes nothing in the project and makes no undo step', async () => {
    const before = proj();
    const steps = ed().past.length;
    const redo = ed().future.length;
    await call('point_at', { clip, note: 'x' });
    await call('point_at', { track: video });
    expect(proj()).toBe(before);
    expect(ed().past.length).toBe(steps);
    expect(ed().future.length).toBe(redo);
  });

  it('is read only', async () => {
    const { TOOLS } = await import('../registry');
    expect(TOOLS.find((t) => t.name === 'point_at')!.annotations?.readOnlyHint).toBe(true);
  });

  it('none or more than one kind of target is an error that says so', async () => {
    await refused('point_at', {}, /say what to point at/);
    await refused('point_at', { note: 'hi' }, /say what to point at/);
    await refused('point_at', { clip, track: video }, /exactly one thing.*clip, track/);
    await refused('point_at', { clip, time: 1 }, /exactly one thing/);
    await refused('point_at', { time: 1, x: 1, y: 1 }, /exactly one thing.*time, x and y/);
    await refused('point_at', { clip, track: video, time: 1 }, /exactly one thing to point at, not 3/);
  });

  it('x and y only go together', async () => {
    await refused('point_at', { x: 5 }, /x needs y too/);
    await refused('point_at', { y: 5 }, /y needs x too/);
    await refused('point_at', { clip, x: 5 }, /x needs y too/);
  });

  it('an unknown clip or track is an error like in the other tools', async () => {
    await refused('point_at', { clip: 'nope' }, /no clip with the id nope/);
    await refused('point_at', { track: 'nope' }, /no track with the id nope/);
  });

  it('an empty note, a long note and out of range numbers are refused', async () => {
    await refused('point_at', { clip, note: '   ' }, /note is empty/);
    await refused('point_at', { clip, note: 'x'.repeat(121) }, /note is too long \(at most 120/);
    expect((await call('point_at', { clip, note: 'x'.repeat(120) })).ok).toBe(true);
    await refused('point_at', { time: -1 }, /time must be at least 0/);
    await refused('point_at', { time: 90000 }, /time must be at most 86400/);
    await refused('point_at', { x: 1e9, y: 0 }, /x must be at most/);
    await refused('point_at', { clip: 5 }, /clip must be a string/);
    await refused('point_at', { clip, bogus: 1 }, /not a known field/);
  });

  it('needs an open project', async () => {
    ed().closeProject();
    const r = await call('point_at', { time: 1 });
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/no project is open/);
  });

  it('says plainly when the user switched cursors off, and that is not an error', async () => {
    useMcpCursors.getState().setEnabled(false);
    const r = await call('point_at', { clip, note: 'look' });
    expect(r.ok).toBe(true);
    expect(r.data.shown).toBe(false);
    expect(r.data.cursors).toMatch(/switched cursors off/);
    expect(r.data.cursors).toMatch(/nothing was changed/);
    expect(useMcpCursors.getState().cursors).toEqual([]);
    useMcpCursors.getState().setEnabled(true);
  });
});
