import { beforeEach, describe, expect, it } from 'vitest';
import type { Target } from '../mcp/cursor';
import {
  FADE_MS,
  IDLE_MS,
  isExpired,
  isFading,
  longestIdle,
  lowestFreeSlot,
  MAX_CURSORS,
  NOTE_IDLE_MS,
  parseShow,
  STORAGE_KEY,
  useMcpCursors,
  WORKING_MAX_MS,
  type McpCursor,
} from './mcpCursors';

const s = () => useMcpCursors.getState();
const clip = (id: string): Target => ({ kind: 'clip', id });
const get = (name: string) => s().cursors.find((c) => c.name === name);

beforeEach(() => {
  useMcpCursors.setState({ enabled: true, cursors: [] });
});

describe('a cursor over a call', () => {
  it('appears when a call begins and is working', () => {
    s().begin('agent', 'move_clip', clip('c1'), 1000);
    expect(s().cursors).toHaveLength(1);
    expect(get('agent')).toEqual({
      name: 'agent',
      slot: 0,
      tool: 'move_clip',
      target: clip('c1'),
      label: 'moves a clip',
      phase: 'working',
      note: null,
      noteAt: 1000,
      pulses: 0,
      last: 1000,
    });
  });

  it('end finishes it: done or failed, the pulse counter goes up each time', () => {
    s().begin('a', 'move_clip', clip('c1'), 0);
    s().end('a', null, true, 10);
    expect(get('a')).toMatchObject({ phase: 'done', pulses: 1, last: 10, target: clip('c1') });
    s().begin('a', 'trim_clip', clip('c1'), 20);
    expect(get('a')).toMatchObject({ phase: 'working', pulses: 1 });
    s().end('a', null, false, 30);
    expect(get('a')).toMatchObject({ phase: 'failed', pulses: 2, last: 30 });
  });

  it('end can move the target (a tool that made something)', () => {
    s().begin('a', 'add_text', { kind: 'nowhere' }, 0);
    s().end('a', clip('new'), true, 5);
    expect(get('a')!.target).toEqual(clip('new'));
    // null and nowhere keep what it had
    s().end('a', null, true, 6);
    s().end('a', { kind: 'nowhere' }, true, 7);
    expect(get('a')!.target).toEqual(clip('new'));
  });

  it('a pure lookup (nowhere) keeps the place the cursor had, only the label changes', () => {
    s().begin('a', 'move_clip', clip('c1'), 0);
    const target = get('a')!.target;
    s().begin('a', 'get_state', { kind: 'nowhere' }, 5);
    expect(get('a')!.target).toBe(target);
    expect(get('a')!.label).toBe('looks at the editor');
    // a cursor that never had a place is nowhere
    s().begin('b', 'get_state', { kind: 'nowhere' }, 5);
    expect(get('b')!.target).toEqual({ kind: 'nowhere' });
  });

  it('a later call keeps the note until its own time is up', () => {
    s().begin('a', 'point_at', clip('c1'), 0);
    s().point('a', clip('c1'), 'look here', 1);
    s().end('a', null, true, 2);
    expect(get('a')!.note).toBe('look here');
    s().begin('a', 'seek', { kind: 'time', time: 1 }, 3);
    s().end('a', null, true, 4);
    expect(get('a')!.note).toBe('look here');
    // the agent keeps working, the note still goes when its own time is up
    s().begin('a', 'seek', { kind: 'time', time: 2 }, 25_000);
    s().end('a', null, true, 25_001);
    s().sweep(1 + NOTE_IDLE_MS - 1);
    expect(get('a')!.note).toBe('look here');
    s().sweep(1 + NOTE_IDLE_MS);
    // the cursor is still there, only the note went
    expect(get('a')!.note).toBeNull();
  });

  it('a new point_at replaces the note, one without a note clears it', () => {
    s().point('a', clip('c1'), 'one', 0);
    s().point('a', clip('c2'), 'two', 5);
    expect(get('a')).toMatchObject({ note: 'two', noteAt: 5 });
    s().point('a', clip('c2'), null, 6);
    expect(get('a')!.note).toBeNull();
  });

  it('end for a cursor that is gone does nothing', () => {
    s().end('ghost', clip('c'), true, 1);
    expect(s().cursors).toEqual([]);
  });

  it('point sets the target and the note without ending the call', () => {
    s().point('a', { kind: 'time', time: 3 }, 'here', 10);
    expect(get('a')).toMatchObject({ tool: 'point_at', label: 'points at something', target: { kind: 'time', time: 3 }, note: 'here', last: 10, pulses: 0 });
  });
});

describe('color slots', () => {
  it('the lowest free slot when a cursor appears, kept while it lives', () => {
    for (const n of ['a', 'b', 'c']) {
      s().begin(n, 'get_state', { kind: 'nowhere' }, 0);
      s().end(n, null, true, 0);
    }
    expect(s().cursors.map((c) => c.slot)).toEqual([0, 1, 2]);
    // b and c are active again, a is not: a goes, b and c keep their slots
    for (const n of ['b', 'c']) {
      s().begin(n, 'seek', { kind: 'time', time: 1 }, 5000);
      s().end(n, null, true, 5000);
    }
    s().sweep(IDLE_MS);
    expect(s().cursors.map((c) => [c.name, c.slot])).toEqual([
      ['b', 1],
      ['c', 2],
    ]);
    // the free slot 0 goes to the next one that comes, then 3
    s().begin('d', 'get_state', { kind: 'nowhere' }, IDLE_MS);
    s().begin('e', 'get_state', { kind: 'nowhere' }, IDLE_MS);
    expect(get('d')!.slot).toBe(0);
    expect(get('e')!.slot).toBe(3);
    s().begin('b', 'seek', { kind: 'time', time: 2 }, IDLE_MS);
    expect(get('b')!.slot).toBe(1);
  });

  it('lowestFreeSlot', () => {
    expect(lowestFreeSlot([])).toBe(0);
    expect(lowestFreeSlot([0, 1, 3])).toBe(2);
    expect(lowestFreeSlot([1])).toBe(0);
  });
});

describe('the cap of 8', () => {
  it('a 9th name takes the place of the cursor that was idle the longest', () => {
    for (let i = 0; i < MAX_CURSORS; i++) {
      s().begin(`c${i}`, 'get_state', { kind: 'nowhere' }, 100 + i);
      s().end(`c${i}`, null, true, 100 + i);
    }
    expect(s().cursors).toHaveLength(8);
    // c0 was idle the longest, but it just worked again: c1 is now the one
    s().begin('c0', 'seek', { kind: 'time', time: 1 }, 500);
    s().end('c0', null, true, 500);
    s().begin('new', 'seek', { kind: 'time', time: 1 }, 600);
    expect(s().cursors).toHaveLength(8);
    expect(get('c1')).toBeUndefined();
    expect(get('c0')).toBeDefined();
    // it takes the slot that became free
    expect(get('new')!.slot).toBe(1);
  });

  it('a cursor that is working is not the one that is replaced while another one is idle', () => {
    for (let i = 0; i < MAX_CURSORS; i++) s().begin(`c${i}`, 'get_state', { kind: 'nowhere' }, 100 + i);
    for (let i = 1; i < MAX_CURSORS; i++) s().end(`c${i}`, null, true, 200 + i);
    s().begin('new', 'seek', { kind: 'time', time: 1 }, 300);
    expect(get('c0')).toBeDefined();
    expect(get('c1')).toBeUndefined();
  });

  it('longestIdle', () => {
    const mk = (name: string, last: number, phase: McpCursor['phase'] = 'done'): McpCursor => ({
      name,
      slot: 0,
      tool: '',
      target: { kind: 'nowhere' },
      label: '',
      phase,
      note: null,
      noteAt: 0,
      pulses: 0,
      last,
    });
    expect(longestIdle([mk('a', 5), mk('b', 2), mk('c', 9)])).toBe(1);
    expect(longestIdle([mk('a', 1, 'working'), mk('b', 9)])).toBe(1);
    expect(longestIdle([mk('a', 1, 'working'), mk('b', 9, 'working')])).toBe(0);
    expect(longestIdle([])).toBe(-1);
  });
});

describe('idle cursors go away', () => {
  it('12 seconds after the last activity', () => {
    s().begin('a', 'seek', { kind: 'time', time: 1 }, 1000);
    s().end('a', null, true, 2000);
    s().sweep(2000 + IDLE_MS - 1);
    expect(s().cursors).toHaveLength(1);
    s().sweep(2000 + IDLE_MS);
    expect(s().cursors).toHaveLength(0);
  });

  it('30 seconds when it carries a note', () => {
    s().point('a', clip('c'), 'this one', 0);
    s().end('a', null, true, 0);
    s().sweep(IDLE_MS + 1);
    expect(s().cursors).toHaveLength(1);
    s().sweep(NOTE_IDLE_MS - 1);
    expect(s().cursors).toHaveLength(1);
    s().sweep(NOTE_IDLE_MS);
    expect(s().cursors).toHaveLength(0);
  });

  it('only the idle ones go', () => {
    s().begin('old', 'seek', { kind: 'time', time: 1 }, 0);
    s().end('old', null, true, 0);
    s().begin('young', 'seek', { kind: 'time', time: 1 }, 10_000);
    s().end('young', null, true, 10_000);
    s().sweep(13_000);
    expect(s().cursors.map((c) => c.name)).toEqual(['young']);
  });

  it('a call that is still working keeps its cursor, up to a limit', () => {
    s().begin('a', 'export_video', { kind: 'button', which: 'export' }, 0);
    s().sweep(IDLE_MS * 5);
    expect(s().cursors).toHaveLength(1);
    s().sweep(WORKING_MAX_MS);
    expect(s().cursors).toHaveLength(0);
  });

  it('does not touch the list when nothing is idle', () => {
    s().begin('a', 'seek', { kind: 'time', time: 1 }, 0);
    const before = s().cursors;
    s().sweep(5);
    expect(s().cursors).toBe(before);
  });

  it('fading starts a second before the end, never while working', () => {
    s().begin('a', 'seek', { kind: 'time', time: 1 }, 0);
    expect(isFading(get('a')!, 10 ** 9)).toBe(false);
    s().end('a', null, true, 0);
    const c = get('a')!;
    expect(isFading(c, IDLE_MS - FADE_MS - 1)).toBe(false);
    expect(isFading(c, IDLE_MS - FADE_MS)).toBe(true);
    expect(isExpired(c, IDLE_MS - 1)).toBe(false);
    expect(isExpired(c, IDLE_MS)).toBe(true);
  });
});

describe('the switch', () => {
  it('off: nothing is tracked and existing cursors are dropped at once', () => {
    s().begin('a', 'seek', { kind: 'time', time: 1 }, 0);
    s().setEnabled(false);
    expect(s().enabled).toBe(false);
    expect(s().cursors).toEqual([]);
    s().begin('a', 'seek', { kind: 'time', time: 1 }, 1);
    s().point('b', clip('c'), 'x', 1);
    s().end('a', null, true, 2);
    expect(s().cursors).toEqual([]);
    s().setEnabled(true);
    s().begin('a', 'seek', { kind: 'time', time: 1 }, 3);
    expect(s().cursors).toHaveLength(1);
  });

  it('the setting is read defensively', () => {
    expect(parseShow(null)).toBe(true);
    expect(parseShow(undefined)).toBe(true);
    expect(parseShow('')).toBe(true);
    expect(parseShow('not json')).toBe(true);
    expect(parseShow('{"show":"no"}')).toBe(true);
    expect(parseShow('5')).toBe(true);
    expect(parseShow('null')).toBe(true);
    expect(parseShow('{}')).toBe(true);
    expect(parseShow('{"show":true}')).toBe(true);
    expect(parseShow('{"show":false}')).toBe(false);
    expect(STORAGE_KEY).toBe('ncut.mcpCursors');
  });

  it('works without localStorage (node has none)', () => {
    expect(() => s().setEnabled(false)).not.toThrow();
    expect(() => s().setEnabled(true)).not.toThrow();
  });
});
