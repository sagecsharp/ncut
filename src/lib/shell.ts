/**
 * the page's only door to the desktop shell (electron/preload.cjs exposes window.ncutShell).
 * in a plain browser every function is a harmless no-op, and nothing here ever throws.
 */

export interface ShellFile {
  name: string;
  bytes: ArrayBuffer;
}

/** the mcp server of the desktop app, as the page may know it (never the token) */
export interface McpState {
  /** the user turned it on */
  enabled: boolean;
  /** it is listening right now */
  running: boolean;
  /** the local port, 0 while it never ran */
  port: number;
  /** why it is not running although it is on, or null */
  error: string | null;
  /** the stdio bridge script is in place */
  bridge: boolean;
}

/** what the shell can put on the clipboard: the claude code command, the http config, the stdio config */
export type McpCopyKind = 'claude' | 'http' | 'stdio';

/** one tool request of an mcp client, relayed by the shell. docs/MCP.md */
export interface McpCall {
  id: number;
  /** 'list' = the tool list, 'call' = run the tool `name` */
  kind: 'list' | 'call';
  name: string;
  args: Record<string, unknown>;
  /** files the shell read for this call (a path never reaches the page) */
  files: ShellFile[];
  /** set when this call may save one file without a dialog (shell.mcp.save) */
  ticket: number | null;
}

export interface McpSaved {
  ok: boolean;
  /** the file name it was saved under */
  name: string | null;
}

/** what kind of copy this is: installed (setup exe), portable (one file exe), manual (unpacked folder), none (no updater) */
export type UpdateKind = 'installed' | 'portable' | 'manual' | 'none';

export type UpdatePhase = 'idle' | 'checking' | 'downloading' | 'ready' | 'failed';

/** the updater of the desktop app, as the page may know it (never a url or a path) */
export interface UpdateState {
  kind: UpdateKind;
  /** the user's switch */
  auto: boolean;
  phase: UpdatePhase;
  /** the running version, like 0.2.0 ('' when the shell sent nothing usable) */
  current: string;
  /** the newest version github has as far as known, null = never checked */
  latest: string | null;
  /** 0..1 while downloading, else 0 */
  progress: number;
  /** why the last check or download failed, or null */
  error: string | null;
  /** ms since epoch of the last check that finished (fine or failed) */
  checkedAt: number | null;
}

interface RawUpdate {
  state?: () => Promise<unknown>;
  setAuto?: (on: boolean) => Promise<unknown>;
  check?: () => Promise<unknown>;
  restart?: () => Promise<unknown>;
  openPage?: () => Promise<unknown>;
  onState?: (cb: (state: unknown) => void) => () => void;
}

interface RawMcp {
  state?: () => Promise<unknown>;
  setEnabled?: (on: boolean) => Promise<unknown>;
  rotate?: () => Promise<unknown>;
  copy?: (kind: McpCopyKind) => Promise<unknown>;
  save?: (ticket: number) => Promise<unknown>;
  reply?: (id: number, json: string) => void;
  onState?: (cb: (state: unknown) => void) => () => void;
  onCall?: (cb: (call: unknown) => void) => () => void;
}

const MCP_OFF: McpState = { enabled: false, running: false, port: 0, error: null, bridge: false };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** whatever the shell sent, as a state the ui can trust */
export function cleanMcpState(v: unknown): McpState {
  if (!isObject(v)) return MCP_OFF;
  const port = typeof v.port === 'number' && Number.isInteger(v.port) && v.port > 0 && v.port < 65536 ? v.port : 0;
  return {
    enabled: v.enabled === true,
    running: v.running === true,
    port,
    error: typeof v.error === 'string' && v.error !== '' ? v.error : null,
    bridge: v.bridge === true,
  };
}

/** whatever the shell sent, as a call the tools can trust. null = not a call */
export function cleanMcpCall(v: unknown): McpCall | null {
  if (!isObject(v)) return null;
  if (typeof v.id !== 'number' || !Number.isFinite(v.id)) return null;
  if (v.kind !== 'list' && v.kind !== 'call') return null;
  const files: ShellFile[] = [];
  if (Array.isArray(v.files)) {
    for (const f of v.files) {
      if (isObject(f) && typeof f.name === 'string' && f.bytes instanceof ArrayBuffer) files.push({ name: f.name, bytes: f.bytes });
    }
  }
  return {
    id: v.id,
    kind: v.kind,
    name: typeof v.name === 'string' ? v.name : '',
    args: isObject(v.args) ? v.args : {},
    files,
    ticket: typeof v.ticket === 'number' && Number.isFinite(v.ticket) ? v.ticket : null,
  };
}

const UPDATE_KINDS: readonly UpdateKind[] = ['installed', 'portable', 'manual', 'none'];
const UPDATE_PHASES: readonly UpdatePhase[] = ['idle', 'checking', 'downloading', 'ready', 'failed'];
/** the longest error text the page keeps */
const UPDATE_ERROR_MAX = 200;
/** a version is three numbers (each at most 9 digits, so the compare stays exact) */
const VERSION_RE = /^\d{1,9}\.\d{1,9}\.\d{1,9}$/;

function cleanVersion(v: unknown): string | null {
  return typeof v === 'string' && VERSION_RE.test(v) ? v : null;
}

/** whatever the shell sent, as an update state the ui can trust. anything unusable is the "none" state (no updater) */
export function cleanUpdateState(v: unknown): UpdateState {
  try {
    return cleanUpdateStateUnsafe(v);
  } catch {
    // an object with a getter that throws is not a state
    return noUpdateState();
  }
}

function noUpdateState(): UpdateState {
  return { kind: 'none', auto: true, phase: 'idle', current: '', latest: null, progress: 0, error: null, checkedAt: null };
}

function cleanUpdateStateUnsafe(v: unknown): UpdateState {
  const none = noUpdateState();
  if (!isObject(v)) return none;
  const kind = UPDATE_KINDS.find((k) => k === v.kind) ?? 'none';
  const phase = UPDATE_PHASES.find((p) => p === v.phase) ?? 'idle';
  const progress = typeof v.progress === 'number' && Number.isFinite(v.progress) ? Math.min(1, Math.max(0, v.progress)) : 0;
  const error = typeof v.error === 'string' && v.error !== '' ? v.error.slice(0, UPDATE_ERROR_MAX) : null;
  const checkedAt = typeof v.checkedAt === 'number' && Number.isFinite(v.checkedAt) && v.checkedAt > 0 ? v.checkedAt : null;
  return {
    kind,
    // missing = the default (on). a value that is not a real boolean is not trusted to mean on: off is the quiet side
    auto: v.auto === undefined ? true : v.auto === true,
    phase,
    current: cleanVersion(v.current) ?? '',
    latest: cleanVersion(v.latest),
    progress: phase === 'downloading' ? progress : 0,
    error,
    checkedAt,
  };
}

interface RawShell {
  mcp?: RawMcp;
  update?: RawUpdate;
  version?: unknown;
  setProgress?: (fraction: number | null) => void;
  keepAwake?: (on: boolean) => void;
  attention?: () => void;
  revealLastSave?: () => Promise<boolean>;
  lastSaveName?: () => Promise<string | null>;
  onSaved?: (cb: (name: string) => void) => () => void;
  onOpenFile?: (cb: (file: ShellFile) => void) => () => void;
  ready?: (dark?: boolean) => void;
}

function raw(): RawShell | null {
  try {
    const w = (globalThis as { window?: { ncutShell?: unknown } }).window;
    const s = w?.ncutShell;
    return s && typeof s === 'object' ? (s as RawShell) : null;
  } catch {
    return null;
  }
}

const NOOP = (): void => {};

function call(run: (s: RawShell) => void): void {
  try {
    const s = raw();
    if (s) run(s);
  } catch {
    /* the shell is optional */
  }
}

async function ask<T>(fallback: T, run: (s: RawShell) => Promise<T> | undefined): Promise<T> {
  try {
    const s = raw();
    if (!s) return fallback;
    const got = await run(s);
    return got ?? fallback;
  } catch {
    return fallback;
  }
}

function subscribe<T>(cb: (v: T) => void, attach: (s: RawShell, safe: (v: T) => void) => (() => void) | undefined): () => void {
  try {
    const s = raw();
    if (!s || typeof cb !== 'function') return NOOP;
    const off = attach(s, (v) => {
      try {
        cb(v);
      } catch {
        /* the listener's problem */
      }
    });
    if (typeof off !== 'function') return NOOP;
    return () => {
      try {
        off();
      } catch {
        /* already gone */
      }
    };
  } catch {
    return NOOP;
  }
}

export const shell = {
  /** true inside the desktop app */
  get available(): boolean {
    return raw() !== null;
  },
  /** the app version, '' in a browser */
  get version(): string {
    const v = raw()?.version;
    return typeof v === 'string' ? v : '';
  },
  /** taskbar progress 0..1; null (or anything outside 0..1) clears it */
  setProgress(fraction: number | null): void {
    call((s) => s.setProgress?.(typeof fraction === 'number' && Number.isFinite(fraction) ? fraction : null));
  },
  /** keep the machine from suspending while true */
  keepAwake(on: boolean): void {
    call((s) => s.keepAwake?.(on === true));
  },
  /** flash the taskbar button when the window is not focused */
  attention(): void {
    call((s) => s.attention?.());
  },
  /** show the last saved download in the file explorer. false when there is none or it is gone */
  revealLastSave(): Promise<boolean> {
    return ask(false, (s) => s.revealLastSave?.());
  },
  /** the file name of the last saved download, or null */
  lastSaveName(): Promise<string | null> {
    return ask<string | null>(null, (s) => s.lastSaveName?.());
  },
  /** called with the file name when a download of this window was saved. returns the unsubscribe */
  onSaved(cb: (name: string) => void): () => void {
    return subscribe<string>(cb, (s, safe) => s.onSaved?.(safe));
  },
  /** called when the app was opened with a project file (or a second start handed one over) */
  onOpenFile(cb: (file: ShellFile) => void): () => void {
    return subscribe<ShellFile>(cb, (s, safe) => s.onOpenFile?.(safe));
  },
  /**
   * the page has its first screen and can take onOpenFile events now. call it after onOpenFile is subscribed.
   * `dark`: the theme of the page, the shell gives its window that background (seen before the first paint)
   */
  ready(dark?: boolean): void {
    call((s) => s.ready?.(dark));
  },
  /** the updater of the desktop app. the page never sends a url, a path or a version */
  update: {
    /** true when this shell has an updater (an older shell does not) */
    get available(): boolean {
      const u = raw()?.update;
      return (
        typeof u === 'object' &&
        u !== null &&
        typeof u.state === 'function' &&
        typeof u.setAuto === 'function' &&
        typeof u.check === 'function' &&
        typeof u.restart === 'function' &&
        typeof u.openPage === 'function' &&
        typeof u.onState === 'function'
      );
    },
    state(): Promise<UpdateState> {
      return ask<unknown>(null, (s) => s.update?.state?.()).then(cleanUpdateState);
    },
    /** the user's switch for automatic updates. the answer is the new state */
    setAuto(on: boolean): Promise<UpdateState> {
      return ask<unknown>(null, (s) => s.update?.setAuto?.(on === true)).then(cleanUpdateState);
    },
    /** start a check now. the answer is the state right after it started */
    check(): Promise<UpdateState> {
      return ask<unknown>(null, (s) => s.update?.check?.()).then(cleanUpdateState);
    },
    /** install the ready update now and start the new version. false when nothing is ready */
    restart(): Promise<boolean> {
      return ask<unknown>(false, (s) => s.update?.restart?.()).then((v) => v === true);
    },
    /** open the releases page in the browser. false when the shell could not */
    openPage(): Promise<boolean> {
      return ask<unknown>(false, (s) => s.update?.openPage?.()).then((v) => v === true);
    },
    onState(cb: (state: UpdateState) => void): () => void {
      return subscribe<UpdateState>(cb, (s, safe) => s.update?.onState?.((v) => safe(cleanUpdateState(v))));
    },
  },
  /** the mcp server of the desktop app (docs/MCP.md). the token never comes to the page */
  mcp: {
    /** true when this shell has an mcp server */
    get available(): boolean {
      const m = raw()?.mcp;
      return typeof m === 'object' && m !== null;
    },
    state(): Promise<McpState> {
      return ask<unknown>(null, (s) => s.mcp?.state?.()).then(cleanMcpState);
    },
    /** turn the server on or off. the answer is the new state, null when the shell did not answer (nothing is known to have changed) */
    setEnabled(on: boolean): Promise<McpState | null> {
      return ask<unknown>(null, (s) => s.mcp?.setEnabled?.(on === true)).then((v) => (v === null ? null : cleanMcpState(v)));
    },
    /** a new token: every client has to be set up again. null when the shell did not answer */
    rotate(): Promise<McpState | null> {
      return ask<unknown>(null, (s) => s.mcp?.rotate?.()).then((v) => (v === null ? null : cleanMcpState(v)));
    },
    /** the shell puts the connect text on the clipboard (it holds the token, the page never sees it) */
    copy(kind: McpCopyKind): Promise<boolean> {
      return ask<unknown>(false, (s) => s.mcp?.copy?.(kind)).then((v) => v === true);
    },
    /**
     * the next download named `ncut-mcp-<ticket>-<file name>` is saved without a dialog into the save folder.
     * resolves when that file is on disk (or failed). call it, then start the download
     */
    save(ticket: number): Promise<McpSaved> {
      return ask<unknown>(null, (s) => s.mcp?.save?.(ticket)).then((v) =>
        isObject(v) && v.ok === true ? { ok: true, name: typeof v.name === 'string' ? v.name : null } : { ok: false, name: null },
      );
    },
    /** the answer to a call, as json text (docs/MCP.md) */
    reply(id: number, json: string): void {
      call((s) => s.mcp?.reply?.(id, json));
    },
    onState(cb: (state: McpState) => void): () => void {
      return subscribe<McpState>(cb, (s, safe) => s.mcp?.onState?.((v) => safe(cleanMcpState(v))));
    },
    /** called for every tool request of a client */
    onCall(cb: (call: McpCall) => void): () => void {
      return subscribe<McpCall>(cb, (s, safe) =>
        s.mcp?.onCall?.((v) => {
          const c = cleanMcpCall(v);
          if (c) safe(c);
        }),
      );
    },
  },
};

/** how a download has to be named so the shell saves it for an mcp ticket (electron/mcpRules.cjs reads the same shape) */
export function mcpDownloadName(ticket: number, fileName: string): string {
  return `ncut-mcp-${ticket}-${fileName}`;
}

// ---------- export progress ----------

/** at most this often goes to the taskbar */
export const PROGRESS_MIN_GAP_MS = 100;

let lastSent = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let queued: number | null = null;

function clearTimer(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

/**
 * export progress for the taskbar: ~10 calls a second at most (the newest value wins), and null
 * (done, failed or cancelled) always goes through at once and cancels anything still waiting.
 */
export function exportProgressToShell(progress: number | null): void {
  const now = Date.now();
  if (progress === null || typeof progress !== 'number' || !Number.isFinite(progress)) {
    clearTimer();
    queued = null;
    lastSent = now;
    shell.setProgress(null);
    return;
  }
  const value = Math.min(1, Math.max(0, progress));
  const wait = lastSent + PROGRESS_MIN_GAP_MS - now;
  if (wait <= 0) {
    clearTimer();
    queued = null;
    lastSent = now;
    shell.setProgress(value);
    return;
  }
  queued = value;
  if (timer === null) {
    timer = setTimeout(() => {
      timer = null;
      if (queued === null) return;
      const v = queued;
      queued = null;
      lastSent = Date.now();
      shell.setProgress(v);
    }, wait);
  }
}

/** test hook: forget the throttle state */
export function resetExportProgress(): void {
  clearTimer();
  queued = null;
  lastSent = 0;
}
