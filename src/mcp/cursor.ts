/**
 * the pure part of the mcp cursors (docs/MCP.md, "cursors"): the "cursor" argument every tool takes, and what each
 * call points at in the window. no dom and no store in here, so it tests in node. the store that holds the cursors
 * is src/store/mcpCursors.ts, the drawing is src/features/mcp/*.
 */
import type { JsonSchema, ToolResult } from './types';

// ---------- the name ----------

/** the name of the extra argument every tool takes */
export const CURSOR_ARG = 'cursor';
/** the name a call without the argument gets */
export const DEFAULT_CURSOR = 'agent';
export const MAX_CURSOR_NAME = 24;

const NAME_CHARS = /^[\p{L}\p{N} ._-]+$/u;

/** what a name may be, as a sentence for the client (it is part of every name error) */
export const CURSOR_NAME_RULE = `a cursor name is 1 to ${MAX_CURSOR_NAME} characters: letters, digits, space, dot, dash or underscore`;

/** the schema property tools/list adds to every tool (the stored tool definitions do not have it) */
export const CURSOR_SCHEMA: JsonSchema = {
  type: 'string',
  maxLength: MAX_CURSOR_NAME,
  description:
    'your own short name (letters, digits, space, dot, dash, underscore, up to 24 characters). pass the same name on every call: ncut draws a cursor with this name in its window, ' +
    'so the user sees where you work. if you start subagents give each one its own name, then each has its own cursor and they can work at the same time. default "agent".',
};

export type CleanName = { ok: true; name: string } | { ok: false; error: string };

/** a cursor name from an argument: missing = the default, anything that is not a good name is an error that says why */
export function cleanCursorName(v: unknown): CleanName {
  if (v === undefined) return { ok: true, name: DEFAULT_CURSOR };
  if (typeof v !== 'string') return { ok: false, error: `${CURSOR_ARG} must be a string, got ${v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v}. ${CURSOR_NAME_RULE}` };
  const name = v.trim();
  if (name.length === 0) return { ok: false, error: `${CURSOR_ARG} is empty. ${CURSOR_NAME_RULE}` };
  if (name.length > MAX_CURSOR_NAME) return { ok: false, error: `${CURSOR_ARG} is too long (${name.length} characters). ${CURSOR_NAME_RULE}` };
  if (!NAME_CHARS.test(name)) return { ok: false, error: `${CURSOR_ARG} "${name}" has a character that is not allowed. ${CURSOR_NAME_RULE}` };
  return { ok: true, name };
}

export type Taken = { ok: true; name: string; args: Record<string, unknown> } | { ok: false; error: string };

/**
 * takes the cursor argument off a call's arguments: the name (checked) and the rest, which is what the tool and the
 * validation get. arguments that are not an object pass through untouched (validate reports them).
 */
export function takeCursor(args: Record<string, unknown>): Taken {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return { ok: true, name: DEFAULT_CURSOR, args };
  const { [CURSOR_ARG]: raw, ...rest } = args;
  const clean = cleanCursorName(raw);
  if (!clean.ok) return clean;
  return { ok: true, name: clean.name, args: rest };
}

/** a tool's input schema with the cursor property added (the stored schema is not changed) */
export function withCursorSchema(schema: JsonSchema): JsonSchema {
  return { ...schema, properties: { ...schema.properties, [CURSOR_ARG]: CURSOR_SCHEMA } };
}

// ---------- targets ----------

/** what a call points at. the view turns it into a spot on the screen (src/features/mcp/locate.ts) */
export type Target =
  | { kind: 'clip'; id: string }
  /** the cursor goes to the first one */
  | { kind: 'clips'; ids: string[] }
  | { kind: 'track'; id: string }
  /** a spot on the time ruler, in timeline seconds */
  | { kind: 'time'; time: number }
  /** a spot on the canvas in project pixels, 0 / 0 is the middle */
  | { kind: 'canvas'; x: number; y: number }
  | { kind: 'preview' }
  /** the media panel, or one card of it */
  | { kind: 'media'; id?: string }
  | { kind: 'inspector' }
  | { kind: 'button'; which: 'undo' | 'redo' | 'export' }
  /** the projects screen: one card, the new project button, or the screen itself */
  | { kind: 'projects'; id?: string; create?: boolean }
  /** a pure lookup: the cursor stays where it was */
  | { kind: 'nowhere' };

export const NOWHERE: Target = { kind: 'nowhere' };

/** what the rules may ask the open project (the registry answers from the stores, so this file stays free of them) */
export interface CursorLookup {
  /** the time of a marker */
  markerTime(id: string): number | undefined;
  /** where a clip sits on the canvas now (its transform x / y) */
  clipPos(id: string): { x: number; y: number } | undefined;
}

export const NO_LOOKUP: CursorLookup = { markerTime: () => undefined, clipPos: () => undefined };

type Args = Record<string, unknown>;

function obj(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function strs(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : [];
}

const clip = (id: unknown): Target => {
  const s = str(id);
  return s ? { kind: 'clip', id: s } : NOWHERE;
};
const clips = (ids: string[]): Target => (ids.length > 0 ? { kind: 'clips', ids } : NOWHERE);
const track = (id: unknown): Target => {
  const s = str(id);
  return s ? { kind: 'track', id: s } : NOWHERE;
};
const time = (t: unknown): Target => {
  const n = num(t);
  return n !== undefined ? { kind: 'time', time: n } : NOWHERE;
};
const media = (id?: unknown): Target => ({ kind: 'media', ...(str(id) ? { id: str(id) } : {}) });
const button = (which: 'undo' | 'redo' | 'export'): Target => ({ kind: 'button', which });
const INSPECTOR: Target = { kind: 'inspector' };
const PREVIEW: Target = { kind: 'preview' };

/** the first text of a tool result as json, or undefined (an error sentence, an image answer) */
export function resultData(result: ToolResult): Record<string, unknown> | undefined {
  const first = result.content[0];
  if (!first || first.type !== 'text') return undefined;
  try {
    return obj(JSON.parse(first.text));
  } catch {
    return undefined;
  }
}

/** the ids of a list of briefs ({ id, ... }) in an answer */
function briefIds(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => str(obj(x)?.id)).filter((x): x is string => x !== undefined) : [];
}

/** where a clip sits when an edit sets its x and / or y: the values given, the rest from where it is */
function placed(id: unknown, x: number | undefined, y: number | undefined, pos: { x: number; y: number } | undefined): Target {
  if (x !== undefined && y !== undefined) return { kind: 'canvas', x, y };
  if (!pos) return clip(id);
  return { kind: 'canvas', x: x ?? pos.x, y: y ?? pos.y };
}

function patchXY(a: Args): { x?: number; y?: number } {
  const tr = obj(obj(a.patch)?.transform);
  return { x: num(tr?.x), y: num(tr?.y) };
}

/** point_at's own target: exactly one kind (clip, track, time, or x and y together), else null */
export function pointTarget(a: Args): Target | null {
  const kinds: Target[] = [];
  if (str(a.clip)) kinds.push(clip(a.clip));
  if (str(a.track)) kinds.push(track(a.track));
  if (num(a.time) !== undefined) kinds.push(time(a.time));
  if (num(a.x) !== undefined || num(a.y) !== undefined) {
    const x = num(a.x);
    const y = num(a.y);
    if (x === undefined || y === undefined) return null;
    kinds.push({ kind: 'canvas', x, y });
  }
  return kinds.length === 1 ? kinds[0]! : null;
}

interface Rule {
  /** a few words for the tag under the name: what the tool does */
  label: string;
  /** what the call points at before it runs (a tool that removes its target has to point at it now) */
  before(a: Args, look: CursorLookup): Target;
  /** what it points at when it made its target or moved it, read from the arguments and the answer. null = keep the first one */
  after?(a: Args, res: Record<string, unknown> | undefined, look: CursorLookup): Target | null;
}

const lookup = (label: string): Rule => ({ label, before: () => NOWHERE });
const onClip = (label: string): Rule => ({ label, before: (a) => clip(a.id) });
const onClips = (label: string): Rule => ({ label, before: (a) => clips(strs(a.ids)) });
/** a tool that makes one clip: it is found by the id in the answer */
const makesClip = (label: string, first?: (a: Args) => Target): Rule => ({
  label,
  before: (a) => first?.(a) ?? NOWHERE,
  after: (_a, res) => clip(res?.id),
});

/**
 * one rule per tool. a test walks TOOLS and fails for a tool that has none, so a tool added later cannot be forgotten
 * (the rule can be { before: () => NOWHERE } when it points at nothing).
 */
export const CURSOR_RULES: Record<string, Rule> = {
  // project and view
  get_state: lookup('looks at the editor'),
  list_projects: { label: 'looks at the projects', before: () => ({ kind: 'projects' }) },
  open_project: { label: 'opens a project', before: (a) => ({ kind: 'projects', ...(str(a.id) ? { id: str(a.id) } : {}) }), after: () => PREVIEW },
  create_project: { label: 'makes a project', before: () => ({ kind: 'projects', create: true }), after: () => PREVIEW },
  close_project: { label: 'closes the project', before: () => ({ kind: 'projects' }) },
  update_project: { label: 'changes the project settings', before: () => INSPECTOR },
  get_project: lookup('reads the project'),
  get_clip: { label: 'reads a clip', before: () => INSPECTOR },
  select_clips: onClips('selects clips'),
  seek: { label: 'moves the playhead', before: (a) => time(a.time) },
  undo: { label: 'undoes', before: () => button('undo') },
  redo: { label: 'redoes', before: () => button('redo') },
  add_track: { label: 'adds a track', before: () => NOWHERE, after: (_a, res) => track(res?.id) },
  update_track: { label: 'changes a track', before: (a) => track(a.id) },
  remove_track: { label: 'removes a track', before: (a) => track(a.id) },
  add_marker: { label: 'adds a marker', before: (a) => time(a.time) },
  remove_marker: { label: 'removes a marker', before: (a, look) => time(look.markerTime(str(a.id) ?? '')) },
  // choices
  list_options: lookup('looks up options'),
  // media
  import_media: { label: 'imports media', before: () => media(), after: (_a, res) => media(briefIds(res?.media)[0]) },
  import_project: { label: 'imports a project', before: () => ({ kind: 'projects' }) },
  add_media_clip: { label: 'puts media on the timeline', before: (a) => media(a.asset), after: (_a, res) => clip(res?.id) },
  replace_media: { label: 'swaps the media of a clip', before: (a) => media(a.asset), after: (a) => clip(a.id) },
  // new clips
  add_text: makesClip('adds text', (a) => track(a.track)),
  add_shape: makesClip('adds a shape', (a) => track(a.track)),
  add_effect: makesClip('adds an effect', (a) => (str(a.target) ? clip(a.target) : track(a.track))),
  add_camera: makesClip('adds a camera', (a) => track(a.track)),
  // edits
  update_clip: {
    label: 'edits a clip',
    before: (a, look) => {
      const { x, y } = patchXY(a);
      if (x === undefined && y === undefined) return INSPECTOR;
      return placed(a.id, x, y, look.clipPos(str(a.id) ?? ''));
    },
    // the clip has its new place now
    after: (a, _res, look) => {
      const { x, y } = patchXY(a);
      if (x === undefined && y === undefined) return null;
      const pos = look.clipPos(str(a.id) ?? '');
      return pos ? { kind: 'canvas', x: pos.x, y: pos.y } : null;
    },
  },
  set_sides: onClip('puts pictures on a solid'),
  move_clip: onClip('moves a clip'),
  trim_clip: onClip('trims a clip'),
  split_clips: {
    label: 'splits clips',
    before: (a) => time(a.time),
    after: (_a, res) => clips(strs(res?.created)),
  },
  delete_clips: onClips('deletes clips'),
  duplicate_clips: {
    label: 'duplicates clips',
    before: (a) => clips(strs(a.ids)),
    after: (_a, res) => clips(briefIds(res?.copies)),
  },
  group_clips: onClips('groups clips'),
  ungroup_clips: onClips('ungroups clips'),
  // keyframes
  set_keyframe: {
    label: 'sets a keyframe',
    before: (a, look) => {
      // a key on x or y is a place on the canvas
      const v = num(a.value);
      const pos = look.clipPos(str(a.id) ?? '');
      if (v !== undefined && pos && a.prop === 'x') return { kind: 'canvas', x: v, y: pos.y };
      if (v !== undefined && pos && a.prop === 'y') return { kind: 'canvas', x: pos.x, y: v };
      return clip(a.id);
    },
  },
  remove_keyframe: onClip('removes a keyframe'),
  set_keyframes: onClip('sets keyframes'),
  clear_keyframes: onClip('clears keyframes'),
  // output
  render_frame: { label: 'renders a frame', before: () => PREVIEW },
  export_video: { label: 'starts an export', before: () => button('export') },
  export_status: { label: 'checks the export', before: () => button('export') },
  export_cancel: { label: 'cancels the export', before: () => button('export') },
  // cursors
  point_at: { label: 'points at something', before: (a) => pointTarget(a) ?? NOWHERE },
};

/** the short text for a tool's cursor tag */
export function cursorLabel(tool: string): string {
  return CURSOR_RULES[tool]?.label ?? 'works';
}

/** what a call points at before it runs. never throws, whatever the arguments hold (they are not validated yet) */
export function targetBefore(tool: string, args: Args, look: CursorLookup = NO_LOOKUP): Target {
  try {
    return CURSOR_RULES[tool]?.before(args, look) ?? NOWHERE;
  } catch {
    return NOWHERE;
  }
}

/** what a finished call points at when it differs from the first target: null = keep it. a failed call keeps it too */
export function targetAfter(tool: string, args: Args, result: ToolResult, look: CursorLookup = NO_LOOKUP): Target | null {
  if (result.isError) return null;
  try {
    const after = CURSOR_RULES[tool]?.after;
    if (!after) return null;
    const t = after(args, resultData(result), look);
    return t && t.kind !== 'nowhere' ? t : null;
  } catch {
    return null;
  }
}

/** a target in words, for point_at's answer */
export function describeTarget(t: Target): string {
  switch (t.kind) {
    case 'clip':
      return `the clip ${t.id}`;
    case 'clips':
      return `the clip ${t.ids[0] ?? ''}`;
    case 'track':
      return `the track ${t.id}`;
    case 'time':
      return `${Math.round(t.time * 1000) / 1000} s on the time ruler`;
    case 'canvas':
      return `the canvas at x ${Math.round(t.x * 100) / 100}, y ${Math.round(t.y * 100) / 100} (project pixels, 0 / 0 is the middle)`;
    case 'preview':
      return 'the preview';
    case 'media':
      return t.id ? `the media ${t.id}` : 'the media panel';
    case 'inspector':
      return 'the inspector';
    case 'button':
      return `the ${t.which} button`;
    case 'projects':
      return t.id ? `the project ${t.id}` : t.create ? 'the new project button' : 'the projects screen';
    case 'nowhere':
      return 'nothing';
  }
}

/** the key of a target: two targets with the same key are the same spot to look for */
export function targetKey(t: Target): string {
  switch (t.kind) {
    case 'clip':
    case 'track':
      return `${t.kind}:${t.id}`;
    case 'clips':
      return `clip:${t.ids[0] ?? ''}`;
    case 'time':
      return `time:${t.time}`;
    case 'canvas':
      return `canvas:${t.x}:${t.y}`;
    case 'media':
      return `media:${t.id ?? ''}`;
    case 'button':
      return `button:${t.which}`;
    case 'projects':
      return `projects:${t.id ?? ''}:${t.create ? 'new' : ''}`;
    default:
      return t.kind;
  }
}
