/** the words of the updates section (UpdateSettings.tsx), kept apart so they test without a dom */
import type { UpdateState } from '../../lib/shell';

type StateView = Pick<UpdateState, 'kind' | 'auto' | 'phase' | 'current' | 'latest' | 'progress' | 'error' | 'checkedAt'>;

const VERSION_RE = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})$/;

/** a version of exactly three numbers, or null (the shell has its own compare, this is the page's) */
export function parseVersion(v: unknown): [number, number, number] | null {
  if (typeof v !== 'string') return null;
  const m = VERSION_RE.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** -1, 0 or 1 like a sort compare. null when one of them is not three numbers */
export function compareVersions(a: unknown, b: unknown): -1 | 0 | 1 | null {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  }
  return 0;
}

/** a newer version than the running one is known */
export function newerKnown(state: Pick<StateView, 'current' | 'latest'>): boolean {
  return compareVersions(state.latest, state.current) === 1;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** "checked 5 min ago". `now` comes in so a test can drive it. a time in the future counts as just now */
export function checkedText(checkedAt: number, now: number): string {
  if (!Number.isFinite(checkedAt) || !Number.isFinite(now)) return '';
  const age = Math.max(0, now - checkedAt);
  if (age < MIN) return 'checked just now';
  if (age < HOUR) return `checked ${Math.floor(age / MIN)} min ago`;
  if (age < DAY) return `checked ${Math.floor(age / HOUR)} h ago`;
  if (age < 2 * DAY) return 'checked yesterday';
  return `checked ${Math.floor(age / DAY)} days ago`;
}

/** the percent of a download, 0..100 */
function percent(progress: number): number {
  return Number.isFinite(progress) ? Math.round(Math.min(1, Math.max(0, progress)) * 100) : 0;
}

/** one plain line for what the updater is doing */
export function updateStatusText(state: StateView, now: number): string {
  const newer = newerKnown(state);
  const latest = state.latest;
  switch (state.phase) {
    case 'checking':
      return 'checking...';
    case 'downloading':
      return `downloading ${latest ?? 'the update'} (${percent(state.progress)}%)`;
    case 'ready': {
      const what = latest ?? 'the update';
      if (state.kind === 'manual') return `${what} is out. this copy does not update itself`;
      // with the switch off a normal close applies nothing: only restart does
      if (!state.auto) return `${what} is ready. press restart to update`;
      if (state.kind === 'portable') return `${what} is ready. it replaces this exe when you close ncut`;
      return `${what} is ready. it installs when you close ncut`;
    }
    case 'failed': {
      const base = state.error ? `could not update: ${state.error}` : 'could not update';
      // the last known newest version stays in the line: as news when it is newer, as plain information when not
      if (latest === null) return base;
      return newer ? `${base} (${latest} is out)` : `${base} (newest known: ${latest})`;
    }
    default:
      break;
  }
  if (latest === null) return 'not checked yet';
  if (newer) return state.kind === 'manual' ? `${latest} is out. this copy does not update itself` : `${latest} is out`;
  const when = state.checkedAt === null ? '' : checkedText(state.checkedAt, now);
  return when ? `up to date, ${when}` : 'up to date';
}

export type UpdateButtonId = 'check' | 'restart' | 'page';

export interface UpdateButton {
  id: UpdateButtonId;
  label: string;
  title: string;
  disabled: boolean;
  primary: boolean;
}

/** the buttons to show, in order. restart only when an update is ready, the page only for a copy that cannot update itself or a failure */
export function updateButtons(state: Pick<StateView, 'kind' | 'phase' | 'current' | 'latest'>): UpdateButton[] {
  const busy = state.phase === 'checking' || state.phase === 'downloading';
  const out: UpdateButton[] = [
    { id: 'check', label: 'check now', title: 'ask github now which version is the newest', disabled: busy, primary: false },
  ];
  if (state.phase === 'ready' && (state.kind === 'installed' || state.kind === 'portable')) {
    out.push({ id: 'restart', label: 'restart to update', title: 'close ncut, install the new version and start it again', disabled: false, primary: true });
  }
  if ((state.kind === 'manual' && newerKnown(state)) || state.phase === 'failed') {
    out.push({ id: 'page', label: 'download page', title: 'open the page with the newest version in your browser', disabled: false, primary: false });
  }
  return out;
}

/**
 * which state the section shows after a new one came in. an answer to a question the page asked (stale = an event
 * came after the question) is older than that event and is dropped. a "none" state never replaces a real one: it is
 * what a shell that did not answer or sent garbage cleans to, and a copy does not lose its updater while it runs
 */
export function acceptUpdateState(shown: UpdateState | null, incoming: UpdateState, stale: boolean): UpdateState | null {
  if (stale) return shown;
  if (incoming.kind === 'none' && shown !== null && shown.kind !== 'none') return shown;
  return incoming;
}
