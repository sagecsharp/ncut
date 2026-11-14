/**
 * the cursors an mcp client moves over the window (docs/MCP.md, "cursors"): one entry per cursor name, what it points
 * at, what the tool does, how the last call went. no dom in here, so it tests in node. src/mcp/registry.ts writes it
 * around every tool call, src/features/mcp/McpCursors.tsx draws it. the time always comes in as an argument of the
 * pure parts, the actions default it to the clock.
 */
import { create } from 'zustand';
import { cursorLabel, NOWHERE, type Target } from '../mcp/cursor';

export type CursorPhase = 'working' | 'done' | 'failed';

export interface McpCursor {
  name: string;
  /** 0..7: picks one of the 8 colors, the lowest free one when the cursor appeared, kept while it lives */
  slot: number;
  /** the tool of the last call */
  tool: string;
  target: Target;
  /** a few words for what the tool does */
  label: string;
  phase: CursorPhase;
  /** from point_at, shown in a bubble. later calls of the cursor keep it until NOTE_IDLE_MS after it was set */
  note: string | null;
  /** when the note was set (ms) */
  noteAt: number;
  /** goes up on every finished call, the view pulses on it */
  pulses: number;
  /** time of the last activity (ms) */
  last: number;
}

/** electron lets 8 calls wait at once, so 8 clients can be around */
export const MAX_CURSORS = 8;
export const SLOTS = 8;
/** a cursor goes away this long after its last activity */
export const IDLE_MS = 12_000;
/** ... and this long when it carries a note */
export const NOTE_IDLE_MS = 30_000;
/** a call that never ended (the page was busy for good) does not keep its cursor forever */
export const WORKING_MAX_MS = 200_000;
/** the view fades a cursor out this long before it goes */
export const FADE_MS = 1_000;

/** the localStorage key of the "show cursors" setting: json { show: boolean } */
export const STORAGE_KEY = 'ncut.mcpCursors';

// ---------- pure parts ----------

/** the setting from what localStorage holds: bad json, a wrong shape or nothing = on */
export function parseShow(raw: string | null | undefined): boolean {
  if (!raw) return true;
  try {
    const v = JSON.parse(raw) as unknown;
    if (typeof v === 'object' && v !== null && 'show' in v && typeof (v as { show: unknown }).show === 'boolean') return (v as { show: boolean }).show;
  } catch {
    /* bad json */
  }
  return true;
}

function loadShow(): boolean {
  try {
    return parseShow(localStorage.getItem(STORAGE_KEY));
  } catch {
    return true;
  }
}

function saveShow(show: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ show }));
  } catch {
    /* no storage: the setting lasts until the window closes */
  }
}

/** the lowest slot nobody uses */
export function lowestFreeSlot(used: readonly number[]): number {
  for (let i = 0; i < SLOTS; i++) if (!used.includes(i)) return i;
  return 0;
}

/** how long after its last activity a cursor stays */
export function stayMs(c: Pick<McpCursor, 'note' | 'phase'>): number {
  if (c.phase === 'working') return WORKING_MAX_MS;
  return c.note ? NOTE_IDLE_MS : IDLE_MS;
}

export function isExpired(c: McpCursor, now: number): boolean {
  return now - c.last >= stayMs(c);
}

/** the last moments before it goes: the view fades it out */
export function isFading(c: McpCursor, now: number): boolean {
  return c.phase !== 'working' && now - c.last >= stayMs(c) - FADE_MS;
}

/** the cursor that has been idle the longest (a working one only when every other one is working too) */
export function longestIdle(list: readonly McpCursor[]): number {
  let best = -1;
  for (let i = 0; i < list.length; i++) {
    const c = list[i]!;
    if (best < 0) best = i;
    else {
      const b = list[best]!;
      const idler = (c.phase !== 'working' && b.phase === 'working') || ((c.phase === 'working') === (b.phase === 'working') && c.last < b.last);
      if (idler) best = i;
    }
  }
  return best;
}

// ---------- the store ----------

export interface McpCursorsState {
  /** the user setting "show cursors". off = nothing is tracked */
  enabled: boolean;
  cursors: McpCursor[];
  /** a tool call starts. a pure lookup (target nowhere) keeps the place the cursor had */
  begin(name: string, tool: string, target: Target, now?: number): void;
  /** the call ended. target = where the tool ended up pointing (null = where it was). counts a finished call */
  end(name: string, target: Target | null, ok: boolean, now?: number): void;
  /** point_at: the cursor goes to the target and shows the note */
  point(name: string, target: Target, note: string | null, now?: number): void;
  /** drops the cursors that were idle long enough */
  sweep(now: number): void;
  setEnabled(on: boolean): void;
}

function put(list: McpCursor[], c: McpCursor): McpCursor[] {
  const i = list.findIndex((x) => x.name === c.name);
  if (i < 0) return [...list, c];
  const next = list.slice();
  next[i] = c;
  return next;
}

/** the cursor for a name, new when there is none. a 9th cursor takes the place of the one that was idle the longest */
function open(list: McpCursor[], name: string, now: number): { cursor: McpCursor; list: McpCursor[] } {
  const have = list.find((c) => c.name === name);
  if (have) return { cursor: have, list };
  let rest = list;
  if (rest.length >= MAX_CURSORS) {
    const gone = longestIdle(rest);
    rest = rest.filter((_, i) => i !== gone);
  }
  const cursor: McpCursor = {
    name,
    slot: lowestFreeSlot(rest.map((c) => c.slot)),
    tool: '',
    target: NOWHERE,
    label: '',
    phase: 'working',
    note: null,
    noteAt: now,
    pulses: 0,
    last: now,
  };
  return { cursor, list: rest };
}

export const useMcpCursors = create<McpCursorsState>()((set, get) => ({
  enabled: loadShow(),
  cursors: [],
  begin(name, tool, target, now = Date.now()) {
    const s = get();
    if (!s.enabled) return;
    const { cursor, list } = open(s.cursors, name, now);
    const next: McpCursor = {
      ...cursor,
      tool,
      label: cursorLabel(tool),
      // a lookup leaves the cursor where it was
      target: target.kind === 'nowhere' ? cursor.target : target,
      phase: 'working',
      // the note of point_at stays through the calls that follow, sweep takes it away when its time is up
      last: now,
    };
    set({ cursors: put(list, next) });
  },
  end(name, target, ok, now = Date.now()) {
    const s = get();
    if (!s.enabled) return;
    const have = s.cursors.find((c) => c.name === name);
    // gone meanwhile (the setting was switched, or 8 newer cursors took its place): nothing to finish
    if (!have) return;
    const next: McpCursor = {
      ...have,
      target: target && target.kind !== 'nowhere' ? target : have.target,
      phase: ok ? 'done' : 'failed',
      pulses: have.pulses + 1,
      last: now,
    };
    set({ cursors: put(s.cursors, next) });
  },
  point(name, target, note, now = Date.now()) {
    const s = get();
    if (!s.enabled) return;
    const { cursor, list } = open(s.cursors, name, now);
    const next: McpCursor = {
      ...cursor,
      tool: 'point_at',
      label: cursorLabel('point_at'),
      target: target.kind === 'nowhere' ? cursor.target : target,
      note,
      noteAt: now,
      last: now,
    };
    set({ cursors: put(list, next) });
  },
  sweep(now) {
    const s = get();
    let changed = false;
    // a note whose time is up goes first: the cursor then falls back to the short idle time
    const aged = s.cursors.map((c) => {
      if (c.note === null || now - c.noteAt < NOTE_IDLE_MS) return c;
      changed = true;
      return { ...c, note: null };
    });
    const left = aged.filter((c) => !isExpired(c, now));
    if (left.length !== aged.length) changed = true;
    if (changed) set({ cursors: left });
  },
  setEnabled(on) {
    saveShow(on);
    if (get().enabled === on && (on || get().cursors.length === 0)) return;
    set(on ? { enabled: true } : { enabled: false, cursors: [] });
  },
}));
