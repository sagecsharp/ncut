import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useMcpCursors } from '../store/mcpCursors';
import { CURSOR_ARG, CURSOR_SCHEMA } from './cursor';
import { ok } from './helpers';
import { callTool, listTools, TOOLS } from './registry';
import { addVideoClip, ed, fresh, proj } from './tools/editKit';
import type { ToolCtx, ToolDef, ToolResult } from './types';

const text = (r: unknown): string => {
  const first = (r as ToolResult).content[0];
  return first && first.type === 'text' ? first.text : '';
};

beforeEach(() => {
  useMcpCursors.setState({ enabled: true, cursors: [] });
});

describe('the cursor argument in the tool list', () => {
  it('every listed tool takes it, as a short string', () => {
    const { tools } = listTools();
    expect(tools.length).toBe(TOOLS.length);
    for (const t of tools) {
      expect(t.inputSchema.properties?.[CURSOR_ARG], t.name).toEqual(CURSOR_SCHEMA);
      expect(t.inputSchema.properties?.[CURSOR_ARG]?.type, t.name).toBe('string');
      expect(t.inputSchema.properties?.[CURSOR_ARG]?.maxLength, t.name).toBe(24);
      // it is optional
      expect(t.inputSchema.required ?? [], t.name).not.toContain(CURSOR_ARG);
      expect(t.inputSchema.type, t.name).toBe('object');
    }
  });

  it('the stored tools stay as they are, and none of them has a property of that name', () => {
    for (const t of TOOLS) expect(Object.keys(t.inputSchema.properties ?? {}), t.name).not.toContain(CURSOR_ARG);
    listTools();
    listTools();
    for (const t of TOOLS) expect(Object.keys(t.inputSchema.properties ?? {}), t.name).not.toContain(CURSOR_ARG);
  });

  it('keeps every other property of every schema', () => {
    const listed = new Map(listTools().tools.map((t) => [t.name, t]));
    for (const t of TOOLS) {
      const got = { ...listed.get(t.name)!.inputSchema.properties };
      delete got[CURSOR_ARG];
      expect(got, t.name).toEqual(t.inputSchema.properties ?? {});
      expect(listed.get(t.name)!.inputSchema.required, t.name).toEqual(t.inputSchema.required);
    }
  });

  it('point_at is listed, after the output tools', () => {
    const names = TOOLS.map((t) => t.name);
    expect(names.indexOf('point_at')).toBe(names.length - 1);
    expect(names.indexOf('export_cancel')).toBe(names.length - 2);
  });
});

describe('callTool and the cursor argument', () => {
  let ran: { args: Record<string, unknown>; ctx: ToolCtx }[] = [];
  const spy: ToolDef = {
    name: 'spy_tool',
    title: 'spy',
    description: 'a tool for the test that records what it was given',
    inputSchema: { type: 'object', properties: { n: { type: 'number' } } },
    run(args, ctx) {
      ran.push({ args, ctx });
      return ok({ n: args.n });
    },
  };
  beforeEach(() => {
    ran = [];
    (TOOLS as ToolDef[]).push(spy);
  });
  afterEach(() => {
    (TOOLS as ToolDef[]).splice((TOOLS as ToolDef[]).indexOf(spy), 1);
  });

  it('takes it off before the tool and the validation see the arguments', async () => {
    const r = await callTool('spy_tool', { n: 3, cursor: 'sub 1' });
    expect((r as ToolResult).isError).toBeUndefined();
    expect(ran).toHaveLength(1);
    expect(ran[0]!.args).toEqual({ n: 3 });
    expect(ran[0]!.ctx.cursor).toBe('sub 1');
  });

  it('a call without it runs as the default cursor', async () => {
    await callTool('spy_tool', { n: 3 });
    expect(ran[0]!.args).toEqual({ n: 3 });
    expect(ran[0]!.ctx.cursor).toBe('agent');
  });

  it('keeps the files and the ticket of the call', async () => {
    await callTool('spy_tool', { cursor: 'x' }, { files: [], ticket: 7 });
    expect(ran[0]!.ctx).toMatchObject({ files: [], ticket: 7, cursor: 'x' });
  });

  it('a bad name is an error that says what a name may be, and the tool did not run', async () => {
    for (const cursor of ['', '   ', 'x'.repeat(25), 'a/b', 5, null, ['a'], 'emoji \u{1F600}']) {
      const r = (await callTool('spy_tool', { n: 1, cursor })) as ToolResult;
      expect(r.isError, JSON.stringify(cursor)).toBe(true);
      expect(text(r)).toMatch(/cursor/);
      expect(text(r)).toMatch(/1 to 24 characters/);
    }
    expect(ran).toHaveLength(0);
    expect(useMcpCursors.getState().cursors).toEqual([]);
  });

  it('a tool still refuses a field it does not know, with or without a cursor', async () => {
    for (const args of [{ bogus: 1 }, { bogus: 1, cursor: 'main' }]) {
      const r = (await callTool('spy_tool', args)) as ToolResult;
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/arguments\.bogus is not a known field/);
    }
    // the cursor is not in the list of known fields the error shows: it is not a field of the tool
    expect(ran).toHaveLength(0);
  });

  it('still validates the arguments that are left', async () => {
    const r = (await callTool('spy_tool', { n: 'x', cursor: 'main' })) as ToolResult;
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/arguments\.n must be a number/);
  });

  it('an unknown tool still answers { unknown: true }, whatever the cursor says', async () => {
    expect(await callTool('no_such_tool', {})).toEqual({ unknown: true });
    expect(await callTool('no_such_tool', { cursor: 'main' })).toEqual({ unknown: true });
    expect(await callTool('no_such_tool', { cursor: '!!' })).toEqual({ unknown: true });
    expect(useMcpCursors.getState().cursors).toEqual([]);
  });

  it('never throws, even for arguments that are not an object', async () => {
    for (const args of [null, undefined, 5, 'x', []] as unknown as Record<string, unknown>[]) {
      const r = (await callTool('get_state', args)) as ToolResult;
      expect(r).toBeTruthy();
    }
  });
});

describe('the cursors around a call', () => {
  beforeEach(() => {
    fresh();
  });

  it('each name has its own cursor, all visible at once', async () => {
    await callTool('get_state', { cursor: 'main' });
    await callTool('get_state', { cursor: 'sub 1' });
    await callTool('get_state', { cursor: 'sub 2' });
    await callTool('get_state', {});
    const list = useMcpCursors.getState().cursors;
    expect(list.map((c) => c.name)).toEqual(['main', 'sub 1', 'sub 2', 'agent']);
    expect(list.map((c) => c.slot)).toEqual([0, 1, 2, 3]);
    expect(list.every((c) => c.phase === 'done' && c.pulses === 1)).toBe(true);
  });

  it('a failed call marks its cursor failed', async () => {
    const r = (await callTool('move_clip', { id: 'nope', start: 1, cursor: 'main' })) as ToolResult;
    expect(r.isError).toBe(true);
    expect(useMcpCursors.getState().cursors[0]).toMatchObject({ name: 'main', phase: 'failed', pulses: 1, tool: 'move_clip' });
  });

  it('a call refused by validation is shown as failed too', async () => {
    await callTool('move_clip', { bogus: 1, cursor: 'main' });
    expect(useMcpCursors.getState().cursors[0]).toMatchObject({ name: 'main', phase: 'failed' });
  });

  it('a tool that makes a clip ends up pointing at the clip it made', async () => {
    const r = await callTool('add_text', { text: 'hi', cursor: 'main' });
    const id = JSON.parse(text(r)).id as string;
    expect(useMcpCursors.getState().cursors[0]!.target).toEqual({ kind: 'clip', id });
  });

  it('a tool that removes its target points at it before it is gone', async () => {
    const { video } = fresh();
    const id = addVideoClip(video, 0);
    const seen: { target: unknown; stillThere: boolean }[] = [];
    const off = useMcpCursors.subscribe((s) => {
      const c = s.cursors[0];
      if (c && c.phase === 'working') seen.push({ target: c.target, stillThere: proj().clips.some((x) => x.id === id) });
    });
    const r = (await callTool('delete_clips', { ids: [id], cursor: 'main' })) as ToolResult;
    off();
    expect(r.isError).toBeUndefined();
    expect(proj().clips.some((x) => x.id === id)).toBe(false);
    expect(seen[0]).toEqual({ target: { kind: 'clips', ids: [id] }, stillThere: true });
    expect(useMcpCursors.getState().cursors[0]).toMatchObject({ phase: 'done', target: { kind: 'clips', ids: [id] } });
  });

  it('a marker that is removed is pointed at by its time', async () => {
    const m = JSON.parse(text(await callTool('add_marker', { time: 4 }))).id as string;
    await callTool('remove_marker', { id: m, cursor: 'main' });
    expect(useMcpCursors.getState().cursors[0]!.target).toEqual({ kind: 'time', time: 4 });
  });

  it('a position edit points at the canvas spot', async () => {
    const { video } = fresh();
    const id = addVideoClip(video, 0);
    await callTool('update_clip', { id, patch: { transform: { x: 120, y: -40 } }, cursor: 'main' });
    expect(useMcpCursors.getState().cursors[0]!.target).toEqual({ kind: 'canvas', x: 120, y: -40 });
  });

  it('with cursors off nothing is tracked and the tools work the same', async () => {
    useMcpCursors.getState().setEnabled(false);
    const r = (await callTool('add_text', { text: 'hi', cursor: 'main' })) as ToolResult;
    expect(r.isError).toBeUndefined();
    expect(useMcpCursors.getState().cursors).toEqual([]);
    useMcpCursors.getState().setEnabled(true);
  });

  it('a cursor never costs an undo step', async () => {
    const n = ed().past.length;
    await callTool('get_state', { cursor: 'main' });
    await callTool('point_at', { time: 1, cursor: 'main' });
    expect(ed().past.length).toBe(n);
  });
});
