/**
 * a .ncut file the desktop app was started with (double click, dropped on the exe, a second start) arrives from
 * the shell as { name, bytes }. it goes through the same import the projects screen's "import project" uses
 * (importProjectFile), and the new project is opened the way a project card opens one (openProjectById, which
 * saves the project that is open now first). in a plain browser the shell is not there and nothing happens.
 */
import { shell } from '../../lib/shell';
import type { ShellFile } from '../../lib/shell';

export interface OpenFileDeps {
  importFile(file: File): Promise<string>;
  openProject(id: string): Promise<boolean>;
  toast(message: string, kind: 'error'): void;
  log(e: unknown): void;
}

/** the message a failed import shows (same text the projects screen uses) */
export function importFailureMessage(e: unknown, fileName: string): string {
  return e instanceof Error && e.message ? e.message : 'could not open ' + fileName;
}

/** import one file the shell handed over and open it. never throws: a failure is a toast. */
export async function openShellFile(file: ShellFile, deps: OpenFileDeps): Promise<void> {
  let name = 'project';
  try {
    name = typeof file.name === 'string' && file.name !== '' ? file.name : name;
    const id = await deps.importFile(new File([file.bytes], name));
    const ok = await deps.openProject(id);
    if (!ok) deps.toast('project not found', 'error');
  } catch (e) {
    deps.log(e);
    deps.toast(importFailureMessage(e, name), 'error');
  }
}

/** files are handled one after the other: two quick hand-overs must not open two projects at once */
export function createFileQueue(deps: OpenFileDeps): (file: ShellFile) => Promise<void> {
  let tail: Promise<void> = Promise.resolve();
  return (file) => {
    tail = tail.then(() => openShellFile(file, deps));
    return tail;
  };
}

let attached = false;
let readySent = false;

/**
 * once, at startup: listen for hand-over files. the shell only sends a file after ready(), so ready() (see
 * signalShellReady) always comes after this.
 */
export function attachShellOpenFile(deps: OpenFileDeps, onFile?: () => void): void {
  if (attached || !shell.available) return;
  attached = true;
  const queue = createFileQueue(deps);
  shell.onOpenFile((file) => {
    onFile?.();
    void queue(file);
  });
}

/** tell the shell the page has its first screen and can take files (the shell shows its window on this) */
export function signalShellReady(): void {
  if (readySent) return;
  readySent = true;
  shell.ready(typeof document !== 'undefined' ? document.documentElement.dataset.theme !== 'light' : undefined);
}
