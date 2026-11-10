/**
 * the page's only door to the desktop shell (electron/preload.cjs exposes window.ncutShell).
 * in a plain browser every function is a harmless no-op, and nothing here ever throws.
 */

export interface ShellFile {
  name: string;
  bytes: ArrayBuffer;
}

interface RawShell {
  version?: unknown;
  setProgress?: (fraction: number | null) => void;
  keepAwake?: (on: boolean) => void;
  attention?: () => void;
  revealLastSave?: () => Promise<boolean>;
  lastSaveName?: () => Promise<string | null>;
  onSaved?: (cb: (name: string) => void) => () => void;
  onOpenFile?: (cb: (file: ShellFile) => void) => () => void;
  ready?: () => void;
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
  /** the page can take onOpenFile events now. call it after onOpenFile is subscribed */
  ready(): void {
    call((s) => s.ready?.());
  },
};

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
