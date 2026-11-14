/**
 * toasts for the updater of the desktop app: one when a version is ready, one when a check the user
 * started with "check now" fails. a background failure (no network) stays quiet.
 */
import { useUi } from '../store/ui';
import type { Toast } from '../store/ui';
import type { UpdateState } from './shell';
import { shell } from './shell';

/** how long the press on "check now" counts: a check is quick, so a failure much later is a background one */
export const USER_CHECK_MS = 60_000;

export interface NoticeMemory {
  /** versions that were announced as ready in this run */
  told: readonly string[];
  /** when the user pressed "check now" and that check has not finished yet. null = no wish */
  askedAt: number | null;
}

export interface NoticeDecision {
  toast: { text: string; kind: Toast['kind'] } | null;
  memory: NoticeMemory;
}

export const NOTICE_START: NoticeMemory = { told: [], askedAt: null };

/** the memory after the user pressed "check now" */
export function withUserCheck(memory: NoticeMemory, now: number = Date.now()): NoticeMemory {
  return { told: memory.told, askedAt: now };
}

/** the memory without the user's wish (the press got no answer from the shell) */
export function withoutUserCheck(memory: NoticeMemory): NoticeMemory {
  return memory.askedAt === null ? memory : { told: memory.told, askedAt: null };
}

/** does this change of state deserve a toast, and what does the notice remember afterwards. pure */
export function decideNotice(prev: UpdateState | null, next: UpdateState, memory: NoticeMemory, now: number = Date.now()): NoticeDecision {
  // a wish older than the window is gone: a failure after it is a background one
  const asked = memory.askedAt !== null && now - memory.askedAt >= 0 && now - memory.askedAt <= USER_CHECK_MS;
  const quiet: NoticeMemory = { told: memory.told, askedAt: null };

  // nothing to say about a shell without an updater
  if (next.kind === 'none') return { toast: null, memory: quiet };

  if (next.phase === 'ready' && next.latest !== null && !memory.told.includes(next.latest)) {
    return {
      toast: { text: `ncut ${next.latest} is ready. it installs when you close ncut`, kind: 'success' },
      memory: { told: [...memory.told, next.latest], askedAt: null },
    };
  }

  if (next.phase === 'failed') {
    // the same failure arriving twice is one failure
    const fresh = prev === null || prev.phase !== 'failed' || prev.checkedAt !== next.checkedAt || prev.error !== next.error;
    if (asked && fresh) {
      return {
        toast: { text: next.error ? `could not update: ${next.error}` : 'could not update', kind: 'error' },
        memory: quiet,
      };
    }
    return { toast: null, memory: asked ? memory : quiet };
  }

  if (!asked) return { toast: null, memory: quiet };
  // a check the user started that goes on into a download is still that check: the window starts again.
  // a download that already ran before the press does not get this
  if (next.phase === 'downloading' && prev !== null && prev.phase === 'checking') {
    return { toast: null, memory: { told: memory.told, askedAt: now } };
  }
  // a check or download still runs: the wish stays. anything else means it finished without a failure
  if (next.phase === 'checking' || next.phase === 'downloading') return { toast: null, memory };
  return { toast: null, memory: quiet };
}

let memory: NoticeMemory = NOTICE_START;
let last: UpdateState | null = null;

function handle(next: UpdateState): void {
  const d = decideNotice(last, next, memory);
  last = next;
  memory = d.memory;
  if (d.toast) useUi.getState().toast(d.toast.text, d.toast.kind);
}

/** UpdateSettings calls this when the user presses "check now", so a failure of that check is told */
export function noteUserCheck(): void {
  memory = withUserCheck(memory);
}

/** UpdateSettings calls this when the press got no answer from the shell, so nothing waits for a failure that never comes */
export function clearUserCheck(): void {
  memory = withoutUserCheck(memory);
}

/** listen to the updater of the desktop app. a no-op in a browser. returns the stop function */
export function startUpdateNotice(): () => void {
  if (!shell.update.available) return () => {};
  let heard = false;
  let alive = true;
  const off = shell.update.onState((s) => {
    heard = true;
    handle(s);
  });
  // a version that is already ready when the page starts; an event that came first is newer than this answer
  void shell.update.state().then((s) => {
    if (alive && !heard) handle(s);
  });
  return () => {
    alive = false;
    off();
  };
}

/** test hook: forget what was told */
export function resetUpdateNotice(): void {
  memory = NOTICE_START;
  last = null;
}
