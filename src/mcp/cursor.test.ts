import { describe, expect, it } from 'vitest';
import {
  CURSOR_ARG,
  CURSOR_RULES,
  CURSOR_SCHEMA,
  cleanCursorName,
  cursorLabel,
  describeTarget,
  DEFAULT_CURSOR,
  NO_LOOKUP,
  pointTarget,
  targetAfter,
  targetBefore,
  targetKey,
  takeCursor,
  withCursorSchema,
  type CursorLookup,
  type Target,
} from './cursor';
import { fail, ok } from './helpers';
import { TOOLS } from './registry';

describe('cursor names', () => {
  it('a missing name is the default', () => {
    expect(cleanCursorName(undefined)).toEqual({ ok: true, name: DEFAULT_CURSOR });
    expect(DEFAULT_CURSOR).toBe('agent');
  });

  it('takes letters, digits, space, dot, dash and underscore, trimmed', () => {
    for (const name of ['agent', 'sub agent 2', 'a.b-c_d', 'x', 'a'.repeat(24), 'Émile', '7']) {
      expect(cleanCursorName(name), name).toEqual({ ok: true, name });
    }
    expect(cleanCursorName('  main  ')).toEqual({ ok: true, name: 'main' });
  });

  it('refuses anything else with a sentence that says what a name may be', () => {
    const bad: unknown[] = [5, null, true, ['a'], { a: 1 }, '', '   ', 'a'.repeat(25), '  ' + 'a'.repeat(25), 'a/b', 'a\tb', 'a\nb', 'a<b>', 'hi!', 'smile \u{1F600}', 'a:b'];
    for (const v of bad) {
      const r = cleanCursorName(v);
      expect(r.ok, JSON.stringify(v)).toBe(false);
      if (!r.ok) {
        expect(r.error).toContain('cursor');
        expect(r.error).toContain('1 to 24 characters');
        expect(r.error).toContain('letters, digits, space, dot, dash or underscore');
      }
    }
  });

  it('says which part was wrong', () => {
    expect(cleanCursorName(5)).toMatchObject({ error: expect.stringContaining('must be a string, got number') });
    expect(cleanCursorName('  ')).toMatchObject({ error: expect.stringContaining('is empty') });
    expect(cleanCursorName('a'.repeat(30))).toMatchObject({ error: expect.stringContaining('too long') });
    expect(cleanCursorName('a/b')).toMatchObject({ error: expect.stringContaining('not allowed') });
  });
});

describe('takeCursor', () => {
  it('takes the argument off and leaves the rest', () => {
    const args = { id: 'x', cursor: 'sub 1' };
    expect(takeCursor(args)).toEqual({ ok: true, name: 'sub 1', args: { id: 'x' } });
    expect(args).toEqual({ id: 'x', cursor: 'sub 1' }); // the caller's object is not touched
    expect(takeCursor({ id: 'x' })).toEqual({ ok: true, name: 'agent', args: { id: 'x' } });
  });

  it('a bad name is an error', () => {
    const r = takeCursor({ cursor: 'a/b' });
    expect(r.ok).toBe(false);
  });

  it('arguments that are not an object pass through for validate to report', () => {
    expect(takeCursor(null as unknown as Record<string, unknown>)).toMatchObject({ ok: true, name: 'agent' });
    expect(takeCursor([] as unknown as Record<string, unknown>)).toMatchObject({ ok: true, name: 'agent' });
  });
});

describe('the schema', () => {
  it('describes the argument for a model', () => {
    expect(CURSOR_SCHEMA.type).toBe('string');
    expect(CURSOR_SCHEMA.maxLength).toBe(24);
    expect(CURSOR_SCHEMA.description).toMatch(/same name on every call/);
    expect(CURSOR_SCHEMA.description).toMatch(/subagent/);
  });

  it('adds the property without changing the schema it got', () => {
    const base = { type: 'object' as const, properties: { id: { type: 'string' as const } }, required: ['id'] };
    const out = withCursorSchema(base);
    expect(out.properties).toEqual({ id: { type: 'string' }, [CURSOR_ARG]: CURSOR_SCHEMA });
    expect(out.required).toEqual(['id']);
    expect(base.properties).toEqual({ id: { type: 'string' } });
    expect(withCursorSchema({ type: 'object' }).properties).toEqual({ [CURSOR_ARG]: CURSOR_SCHEMA });
  });
});

describe('a rule for every tool', () => {
  it('every tool has a rule and a label', () => {
    for (const t of TOOLS) {
      const rule = CURSOR_RULES[t.name];
      expect(rule, `no cursor rule for the tool ${t.name}: add one to CURSOR_RULES in src/mcp/cursor.ts`).toBeTruthy();
      expect(rule!.label.length, t.name).toBeGreaterThan(3);
      expect(rule!.label.length, t.name).toBeLessThan(40);
      expect(cursorLabel(t.name)).toBe(rule!.label);
      expect(rule!.label, t.name).toBe(rule!.label.toLowerCase());
    }
  });

  it('no rule is left for a tool that is gone', () => {
    const names = new Set(TOOLS.map((t) => t.name));
    for (const key of Object.keys(CURSOR_RULES)) expect(names.has(key), key).toBe(true);
  });

  it('a rule never throws, whatever the arguments hold', () => {
    const junk: Record<string, unknown>[] = [{}, { id: 5, ids: 'x', patch: 5, time: 'a', asset: {}, track: [], target: null }, { patch: { transform: 5 } }, { patch: null, ids: [1, 2, null] }];
    for (const t of TOOLS) {
      for (const args of junk) {
        expect(() => targetBefore(t.name, args), t.name).not.toThrow();
        expect(() => targetAfter(t.name, args, ok({ id: 5, media: 5, created: 'x', copies: [null] })), t.name).not.toThrow();
      }
    }
  });

  it('a tool nobody knows points nowhere and is called "works"', () => {
    expect(targetBefore('no_such_tool', {})).toEqual({ kind: 'nowhere' });
    expect(cursorLabel('no_such_tool')).toBe('works');
  });
});

describe('what a call points at before it runs', () => {
  const look: CursorLookup = {
    markerTime: (id) => (id === 'mk1' ? 7.5 : undefined),
    clipPos: (id) => (id === 'c1' ? { x: 100, y: -50 } : undefined),
  };
  const before = (tool: string, args: Record<string, unknown>) => targetBefore(tool, args, look);

  it('clips', () => {
    expect(before('move_clip', { id: 'c1', start: 3 })).toEqual({ kind: 'clip', id: 'c1' });
    expect(before('trim_clip', { id: 'c1', edge: 'end', time: 3 })).toEqual({ kind: 'clip', id: 'c1' });
    expect(before('set_sides', { id: 'c1', sides: {} })).toEqual({ kind: 'clip', id: 'c1' });
    expect(before('remove_keyframe', { id: 'c1', prop: 'x', time: 1 })).toEqual({ kind: 'clip', id: 'c1' });
    expect(before('set_keyframes', { id: 'c1', keyframes: {} })).toEqual({ kind: 'clip', id: 'c1' });
    expect(before('clear_keyframes', { id: 'c1' })).toEqual({ kind: 'clip', id: 'c1' });
    expect(before('set_keyframe', { id: 'c1', prop: 'opacity', time: 1, value: 0.5 })).toEqual({ kind: 'clip', id: 'c1' });
  });

  it('several clips: the first one is where the cursor goes, an empty list points nowhere', () => {
    expect(before('delete_clips', { ids: ['a', 'b'] })).toEqual({ kind: 'clips', ids: ['a', 'b'] });
    expect(before('duplicate_clips', { ids: ['a'] })).toEqual({ kind: 'clips', ids: ['a'] });
    expect(before('group_clips', { ids: ['a', 'b'] })).toEqual({ kind: 'clips', ids: ['a', 'b'] });
    expect(before('ungroup_clips', { ids: ['a'] })).toEqual({ kind: 'clips', ids: ['a'] });
    expect(before('select_clips', { ids: ['a'] })).toEqual({ kind: 'clips', ids: ['a'] });
    expect(before('select_clips', { ids: [] })).toEqual({ kind: 'nowhere' });
  });

  it('tracks, times and markers', () => {
    expect(before('update_track', { id: 't1' })).toEqual({ kind: 'track', id: 't1' });
    expect(before('remove_track', { id: 't1' })).toEqual({ kind: 'track', id: 't1' });
    expect(before('seek', { time: 4 })).toEqual({ kind: 'time', time: 4 });
    expect(before('add_marker', { time: 2 })).toEqual({ kind: 'time', time: 2 });
    expect(before('split_clips', { time: 2.5 })).toEqual({ kind: 'time', time: 2.5 });
    // a marker that is about to go is pointed at by its time
    expect(before('remove_marker', { id: 'mk1' })).toEqual({ kind: 'time', time: 7.5 });
    expect(before('remove_marker', { id: 'nope' })).toEqual({ kind: 'nowhere' });
  });

  it('a tool that makes something does not know its target yet', () => {
    expect(before('add_track', { kind: 'video' })).toEqual({ kind: 'nowhere' });
    expect(before('add_text', { text: 'hi' })).toEqual({ kind: 'nowhere' });
    expect(before('add_shape', {})).toEqual({ kind: 'nowhere' });
    expect(before('add_camera', {})).toEqual({ kind: 'nowhere' });
    expect(before('add_text', { track: 't1' })).toEqual({ kind: 'track', id: 't1' });
    expect(before('add_effect', { effect: 'blur', target: 'c1' })).toEqual({ kind: 'clip', id: 'c1' });
    expect(before('add_effect', { effect: 'blur' })).toEqual({ kind: 'nowhere' });
  });

  it('media', () => {
    expect(before('import_media', { paths: [] })).toEqual({ kind: 'media' });
    expect(before('add_media_clip', { asset: 'a1' })).toEqual({ kind: 'media', id: 'a1' });
    expect(before('replace_media', { id: 'c1', asset: 'a2' })).toEqual({ kind: 'media', id: 'a2' });
  });

  it('the canvas: a transform with x / y points at where the clip now sits', () => {
    expect(before('update_clip', { id: 'c1', patch: { transform: { x: 200, y: 10 } } })).toEqual({ kind: 'canvas', x: 200, y: 10 });
    // one of the two: the other comes from where the clip is
    expect(before('update_clip', { id: 'c1', patch: { transform: { x: 200 } } })).toEqual({ kind: 'canvas', x: 200, y: -50 });
    expect(before('update_clip', { id: 'c1', patch: { transform: { y: 8 } } })).toEqual({ kind: 'canvas', x: 100, y: 8 });
    // unknown place: the clip itself
    expect(before('update_clip', { id: 'zzz', patch: { transform: { x: 200 } } })).toEqual({ kind: 'clip', id: 'zzz' });
    // a keyframe on x / y
    expect(before('set_keyframe', { id: 'c1', prop: 'x', time: 1, value: 300 })).toEqual({ kind: 'canvas', x: 300, y: -50 });
    expect(before('set_keyframe', { id: 'c1', prop: 'y', time: 1, value: 40 })).toEqual({ kind: 'canvas', x: 100, y: 40 });
    expect(before('set_keyframe', { id: 'c1', prop: 'x', time: 1 })).toEqual({ kind: 'clip', id: 'c1' });
  });

  it('inspector, preview, buttons, projects', () => {
    expect(before('update_clip', { id: 'c1', patch: { color: '#fff' } })).toEqual({ kind: 'inspector' });
    expect(before('update_clip', { id: 'c1', patch: { transform: { scale: 2 } } })).toEqual({ kind: 'inspector' });
    expect(before('get_clip', { id: 'c1' })).toEqual({ kind: 'inspector' });
    expect(before('update_project', { name: 'x' })).toEqual({ kind: 'inspector' });
    expect(before('render_frame', {})).toEqual({ kind: 'preview' });
    expect(before('undo', {})).toEqual({ kind: 'button', which: 'undo' });
    expect(before('redo', {})).toEqual({ kind: 'button', which: 'redo' });
    for (const tool of ['export_video', 'export_status', 'export_cancel']) expect(before(tool, {})).toEqual({ kind: 'button', which: 'export' });
    expect(before('list_projects', {})).toEqual({ kind: 'projects' });
    expect(before('open_project', { id: 'p1' })).toEqual({ kind: 'projects', id: 'p1' });
    expect(before('create_project', {})).toEqual({ kind: 'projects', create: true });
    expect(before('close_project', {})).toEqual({ kind: 'projects' });
    expect(before('import_project', {})).toEqual({ kind: 'projects' });
  });

  it('pure lookups point nowhere', () => {
    for (const tool of ['get_state', 'list_options', 'get_project']) expect(before(tool, {})).toEqual({ kind: 'nowhere' });
  });
});

describe('what a finished call points at', () => {
  const after = (tool: string, args: Record<string, unknown>, data: unknown, look: CursorLookup = NO_LOOKUP) => targetAfter(tool, args, ok(data), look);

  it('a tool that makes a clip: the id in the answer', () => {
    for (const tool of ['add_text', 'add_shape', 'add_effect', 'add_camera', 'add_media_clip']) {
      expect(after(tool, {}, { id: 'clp_new', type: 'text' }), tool).toEqual({ kind: 'clip', id: 'clp_new' });
    }
  });

  it('add_track: the new track', () => {
    expect(after('add_track', { kind: 'video' }, { id: 'trk_new', kind: 'video' })).toEqual({ kind: 'track', id: 'trk_new' });
  });

  it('import_media: the first new media', () => {
    expect(after('import_media', {}, { media: [{ id: 'm1' }, { id: 'm2' }] })).toEqual({ kind: 'media', id: 'm1' });
    // nothing came in: the panel
    expect(after('import_media', {}, { media: [] })).toEqual({ kind: 'media' });
  });

  it('split_clips: the new halves, duplicate_clips: the copies', () => {
    expect(after('split_clips', { time: 2 }, { created: ['n1', 'n2'], clips: [] })).toEqual({ kind: 'clips', ids: ['n1', 'n2'] });
    expect(after('duplicate_clips', { ids: ['a'] }, { copies: [{ id: 'k1', from: 'a' }, { id: 'k2' }] })).toEqual({ kind: 'clips', ids: ['k1', 'k2'] });
  });

  it('open_project and create_project end on the preview, replace_media on the clip', () => {
    expect(after('open_project', { id: 'p' }, {})).toEqual({ kind: 'preview' });
    expect(after('create_project', {}, {})).toEqual({ kind: 'preview' });
    expect(after('replace_media', { id: 'c1', asset: 'a' }, {})).toEqual({ kind: 'clip', id: 'c1' });
  });

  it('update_clip with a position: where the clip sits now', () => {
    const look: CursorLookup = { markerTime: () => undefined, clipPos: () => ({ x: 33, y: 44 }) };
    expect(after('update_clip', { id: 'c', patch: { transform: { x: 33 } } }, {}, look)).toEqual({ kind: 'canvas', x: 33, y: 44 });
    expect(after('update_clip', { id: 'c', patch: { color: 'red' } }, {}, look)).toBeNull();
  });

  it('tools that remove their target keep the first target', () => {
    expect(after('delete_clips', { ids: ['a'] }, { deleted: 1 })).toBeNull();
    expect(after('remove_track', { id: 't' }, { removed: 't' })).toBeNull();
    expect(after('remove_marker', { id: 'm' }, { removed: 'm' })).toBeNull();
  });

  it('a failed call, an answer that is not json and a tool without an after rule keep the first target', () => {
    expect(targetAfter('add_text', {}, fail('no project is open'))).toBeNull();
    expect(targetAfter('add_text', {}, { content: [{ type: 'text', text: 'not json' }] })).toBeNull();
    expect(targetAfter('add_text', {}, { content: [{ type: 'image', data: 'x', mimeType: 'image/png' }] })).toBeNull();
    expect(after('move_clip', { id: 'c' }, { id: 'c' })).toBeNull();
  });
});

describe('point_at targets', () => {
  it('exactly one kind', () => {
    expect(pointTarget({ clip: 'c1' })).toEqual({ kind: 'clip', id: 'c1' });
    expect(pointTarget({ track: 't1' })).toEqual({ kind: 'track', id: 't1' });
    expect(pointTarget({ time: 0 })).toEqual({ kind: 'time', time: 0 });
    expect(pointTarget({ x: 0, y: 0 })).toEqual({ kind: 'canvas', x: 0, y: 0 });
  });

  it('none, two kinds or half a position are no target', () => {
    expect(pointTarget({})).toBeNull();
    expect(pointTarget({ note: 'hi' })).toBeNull();
    expect(pointTarget({ clip: 'c', track: 't' })).toBeNull();
    expect(pointTarget({ clip: 'c', x: 1, y: 2 })).toBeNull();
    expect(pointTarget({ x: 1 })).toBeNull();
    expect(pointTarget({ y: 1 })).toBeNull();
    expect(targetBefore('point_at', { x: 1 })).toEqual({ kind: 'nowhere' });
    expect(targetBefore('point_at', { clip: 'c1' })).toEqual({ kind: 'clip', id: 'c1' });
  });
});

describe('words and keys', () => {
  it('describes targets', () => {
    const t = (x: Target) => describeTarget(x);
    expect(t({ kind: 'clip', id: 'c1' })).toBe('the clip c1');
    expect(t({ kind: 'clips', ids: ['c1', 'c2'] })).toBe('the clip c1');
    expect(t({ kind: 'track', id: 't1' })).toBe('the track t1');
    expect(t({ kind: 'time', time: 2.5 })).toBe('2.5 s on the time ruler');
    expect(t({ kind: 'canvas', x: 0, y: 12 })).toContain('x 0, y 12');
    expect(t({ kind: 'media' })).toBe('the media panel');
    expect(t({ kind: 'projects', create: true })).toBe('the new project button');
    expect(t({ kind: 'button', which: 'undo' })).toBe('the undo button');
  });

  it('a clips target and a clip target are the same spot', () => {
    expect(targetKey({ kind: 'clips', ids: ['a', 'b'] })).toBe(targetKey({ kind: 'clip', id: 'a' }));
    expect(targetKey({ kind: 'time', time: 1 })).not.toBe(targetKey({ kind: 'time', time: 2 }));
    expect(targetKey({ kind: 'canvas', x: 1, y: 2 })).not.toBe(targetKey({ kind: 'canvas', x: 2, y: 1 }));
  });
});
