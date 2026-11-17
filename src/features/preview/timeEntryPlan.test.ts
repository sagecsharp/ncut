import { describe, expect, it } from 'vitest';
import type { Clip, Project, VideoClip } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import { createProject } from '../../lib/factory';
import type { TimeDisplay } from '../../lib/time';
import type { TrimEdge } from '../../store/ui';
import { REASON_TEXT } from '../shell/reasons';
import { emptyNudge } from '../timeline/timeNudge';
import type { NudgePlan } from '../timeline/timeNudge';
import type { TrimPlan, TrimStop } from '../timeline/trimModes';
import { ENTRY_TEXT, planTimeEntry } from './timeEntryPlan';
import type { EntryDeps, EntryState } from './timeEntryPlan';
import type { EntryFrom } from './timeEntry';

const base = createProject('entry');
const track = base.tracks[0]!.id;

function clip(id: string, name: string, start: number, duration: number): VideoClip {
  return {
    id, type: 'video', trackId: track, start, duration, name, fadeIn: 0, fadeOut: 0, assetId: 'va',
    trimStart: 0, speed: 1, volume: 1, muted: false, transform: { ...DEFAULT_TRANSFORM },
  };
}

function project(clips: Clip[]): Project {
  return { ...base, fps: 30, clips };
}

/** "intro" at 2 s (2 s long), a second clip after it, the playhead at 5 s */
function state(over: Partial<EntryState> = {}): EntryState {
  return {
    project: project([clip('a', 'intro', 2, 2), clip('b', 'outro', 4, 2)]),
    selection: [], edge: null, time: 5, from: 'playhead', mode: 'timecode', ...over,
  };
}

interface Calls { edge: unknown[][]; nudge: unknown[][] }

/** fake planners that record what they were asked */
function deps(edge: TrimPlan | null, nudge: NudgePlan | null): { deps: EntryDeps; calls: Calls } {
  const calls: Calls = { edge: [], nudge: [] };
  return {
    calls,
    deps: {
      edgePlan: ((...a: unknown[]) => { calls.edge.push(a); return edge; }) as unknown as EntryDeps['edgePlan'],
      planNudge: ((...a: unknown[]) => { calls.nudge.push(a); return nudge ?? emptyNudge(0); }) as unknown as EntryDeps['planNudge'],
    },
  };
}

const okTrim = { mode: 'ripple', ops: [{}], delta: 0.5, stop: null, moved: [], lockedBehind: [], key: 'ripple:0.5' } as unknown as TrimPlan;
const stopTrim = (stop: TrimStop): TrimPlan => ({ ...okTrim, ops: [], stop });
const okMove = (ids: string[], lockedStay: string[] = []): NudgePlan => ({ moves: ids.map((id) => ({ id, start: 3 })) as unknown as NudgePlan['moves'], ids, stop: null, lockedStay, frames: 15 });
const edgeEnd: TrimEdge = { clipId: 'a', edge: 'end', both: false, alone: false };

const run = (text: string, s: EntryState, d = deps(null, null)) => planTimeEntry(text, s, d.deps);

describe('planTimeEntry', () => {
  it('empty and error texts', () => {
    expect(run('', state())).toEqual({ kind: 'none', text: ENTRY_TEXT.hint });
    expect(run('+', state())).toEqual({ kind: 'none', text: ENTRY_TEXT.hintBy });
    expect(run('abc', state())).toEqual({ kind: 'error', text: ENTRY_TEXT.bad });
    expect(run('2.5f', state())).toEqual({ kind: 'error', text: ENTRY_TEXT['frames-whole'] });
    expect(run('25h', state())).toEqual({ kind: 'error', text: ENTRY_TEXT['too-far'] });
    expect(run('+0', state())).toEqual({ kind: 'error', text: ENTRY_TEXT.zero });
  });

  it('an absolute time goes there, past the end it stops at the end', () => {
    const a = run('1:00', state());
    expect(a).toEqual({ kind: 'seek', time: 1, clamped: false, text: 'go to 00:01:00' });
    expect(run('1:00', state({ from: 'timeline' })).kind).toBe('seek');
    // the project ends at 6 s
    const end = run('10:00', state());
    expect(end).toEqual({ kind: 'seek', time: 6, clamped: true, text: 'go to 00:06:00, the end of the project' });
    expect(run('6s', state())).toMatchObject({ kind: 'seek', time: 6, clamped: false });
  });

  it('an amount from the playhead steps', () => {
    const d = deps(null, null);
    expect(run('+15', state(), d)).toEqual({ kind: 'step', frames: 15, text: 'move the playhead +15f' });
    expect(run('+15', state({ selection: ['a'] }), d)).toMatchObject({ kind: 'step', frames: 15 });
    expect(run('-1:00', state(), d)).toEqual({ kind: 'step', frames: -30, text: 'move the playhead -00:01:00' });
    expect(run('-10s', state(), d)).toMatchObject({ kind: 'step', text: 'move the playhead -00:10:00, it stops at the start' });
    expect(run('+10s', state(), d)).toMatchObject({ kind: 'step', text: 'move the playhead +00:10:00, it stops at the end' });
    expect(d.calls.edge.length + d.calls.nudge.length).toBe(0);
  });

  it('from the timeline the selected edge trims', () => {
    const d = deps(okTrim, null);
    const s = state({ from: 'timeline', edge: edgeEnd, selection: ['a', 'b'] });
    expect(run('+15', s, d)).toEqual({ kind: 'trim', frames: 15, edge: edgeEnd, text: 'ripple trim the end of "intro" +15f', blocked: false });
    expect(d.calls.edge[0]![2]).toBeCloseTo(0.5);
    expect(d.calls.edge[0]![3]).toEqual(['a', 'b']);
    const alone = { ...edgeEnd, alone: true };
    run('+15', state({ from: 'timeline', edge: alone, selection: ['a', 'b'] }), d);
    expect(d.calls.edge[1]![3]).toEqual(['a']);
    const start = { ...edgeEnd, edge: 'start' as const };
    expect(run('-15', state({ from: 'timeline', edge: start }), d).text).toBe('ripple trim the start of "intro" -15f');
    const both = { ...edgeEnd, both: true };
    expect(run('+15', state({ from: 'timeline', edge: both }), d)).toMatchObject({ kind: 'trim', text: 'move the edit +15f', blocked: false });
  });

  it('a trim that leaves a locked track behind says so', () => {
    const locked = { ...okTrim, lockedBehind: ['lk'] } as unknown as TrimPlan;
    const s = state({ from: 'timeline', edge: edgeEnd });
    expect(run('+15', s, deps(locked, null)).text).toBe('ripple trim the end of "intro" +15f' + ENTRY_TEXT.lockedSuffix);
  });

  it('a blocked trim says why', () => {
    const stop: TrimStop = { why: 'timeline-start', clipId: 'a' };
    const s = state({ from: 'timeline', edge: edgeEnd });
    expect(run('-1:00', s, deps(stopTrim(stop), null))).toMatchObject({ kind: 'trim', blocked: true, text: 'cannot trim -00:01:00: "intro" would start before 0' });
    expect(run('+15', s, deps(null, null))).toMatchObject({ blocked: true, text: `cannot trim +15f: ${REASON_TEXT.pickEdge}` });
    expect(run('+15', s, deps({ ...okTrim, ops: [] }, null))).toMatchObject({ blocked: true, text: `cannot trim +15f: ${REASON_TEXT.pickEdge}` });
  });

  it('from the timeline the selection moves', () => {
    const one = deps(null, okMove(['a']));
    const s = state({ from: 'timeline', selection: ['a'] });
    expect(run('+15', s, one)).toMatchObject({ kind: 'move', frames: 15, blocked: false, text: 'move "intro" +15f' });
    expect(one.calls.nudge[0]![1]).toEqual(['a']);
    expect(one.calls.nudge[0]![2]).toBe(15);
    const many = deps(null, okMove(['a', 'b']));
    expect(run('-15', state({ from: 'timeline', selection: ['a', 'b'] }), many).text).toBe('move 2 clips -15f');
    const locked = deps(null, okMove(['a'], ['t2']));
    expect(run('+15', s, locked).text).toBe('move "intro" +15f, locked tracks stay');
  });

  it('a blocked move says why', () => {
    const s = state({ from: 'timeline', selection: ['a'] });
    const stop: TrimStop = { why: 'timeline-start', clipId: 'a' };
    const d = deps(null, { ...emptyNudge(-30, stop), frames: -30 });
    expect(run('-1:00', s, d)).toMatchObject({ kind: 'move', blocked: true, text: 'cannot move -00:01:00: "intro" would start before 0' });
    // no moves and no stop
    const none = deps(null, emptyNudge(15, null, ['t2']));
    expect(run('+15', s, none)).toMatchObject({ blocked: true, text: `cannot move +15f: ${REASON_TEXT.selectClip}` });
  });

  it('a gone edge falls back to move', () => {
    const d = deps(okTrim, okMove(['a']));
    const gone: TrimEdge = { clipId: 'zzz', edge: 'end', both: false, alone: false };
    const r = run('+15', state({ from: 'timeline', edge: gone, selection: ['a'] }), d);
    expect(r.kind).toBe('move');
    expect(d.calls.edge.length).toBe(0);
  });

  it('nothing selected from the timeline steps the playhead', () => {
    const d = deps(okTrim, okMove(['a']));
    expect(run('+15', state({ from: 'timeline' }), d)).toEqual({ kind: 'step', frames: 15, text: 'move the playhead +15f' });
    expect(d.calls.nudge.length).toBe(0);
  });

  it('amounts follow the mode', () => {
    const modes: Array<[TimeDisplay, string, string]> = [
      ['frames', 'move the playhead +45f', 'go to 60'],
      ['seconds', 'move the playhead +1.50s', 'go to 2.00s'],
      ['timecode', 'move the playhead +00:01:15', 'go to 00:02:00'],
    ];
    for (const [mode, step, go] of modes) {
      expect(run('+1:15', state({ mode, time: 2 })).text, mode).toBe(step);
      expect(run('60', state({ mode })).text, mode).toBe(go);
    }
    const from: EntryFrom = 'timeline';
    const mv = deps(null, okMove(['a']));
    expect(run('+1:15', state({ mode: 'seconds', from, selection: ['a'] }), mv).text).toBe('move "intro" +1.50s');
  });
});
