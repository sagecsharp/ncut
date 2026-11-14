import { describe, expect, it } from 'vitest';
import type { UpdateState } from '../../lib/shell';
import { acceptUpdateState, checkedText, compareVersions, newerKnown, parseVersion, updateButtons, updateStatusText } from './updateText';

const NOW = 1_700_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function st(over: Partial<UpdateState> = {}): UpdateState {
  return { kind: 'installed', auto: true, phase: 'idle', current: '0.2.0', latest: null, progress: 0, error: null, checkedAt: null, ...over };
}

describe('versions', () => {
  it('parses exactly three numbers', () => {
    expect(parseVersion('0.2.0')).toEqual([0, 2, 0]);
    expect(parseVersion('10.20.30')).toEqual([10, 20, 30]);
    for (const bad of ['1.2', '1.2.3.4', 'v1.2.3', '1.2.x', '', '1.2.3-b', 5, null, undefined]) expect(parseVersion(bad)).toBeNull();
  });

  it('compares number by number, not as text', () => {
    expect(compareVersions('0.2.0', '0.2.0')).toBe(0);
    expect(compareVersions('0.3.0', '0.2.0')).toBe(1);
    expect(compareVersions('0.2.0', '0.10.0')).toBe(-1);
    expect(compareVersions('1.0.0', '0.99.99')).toBe(1);
    expect(compareVersions('0.2.1', '0.2.10')).toBe(-1);
    expect(compareVersions('0.2', '0.2.0')).toBeNull();
    expect(compareVersions('0.2.0', null)).toBeNull();
  });

  it('newerKnown needs both versions', () => {
    expect(newerKnown({ current: '0.2.0', latest: '0.3.0' })).toBe(true);
    expect(newerKnown({ current: '0.2.0', latest: '0.2.0' })).toBe(false);
    expect(newerKnown({ current: '0.3.0', latest: '0.2.0' })).toBe(false);
    expect(newerKnown({ current: '', latest: '0.3.0' })).toBe(false);
    expect(newerKnown({ current: '0.2.0', latest: null })).toBe(false);
  });
});

describe('checkedText', () => {
  it('says how long ago', () => {
    expect(checkedText(NOW - 10_000, NOW)).toBe('checked just now');
    expect(checkedText(NOW - 5 * MIN, NOW)).toBe('checked 5 min ago');
    expect(checkedText(NOW - 59 * MIN, NOW)).toBe('checked 59 min ago');
    expect(checkedText(NOW - HOUR, NOW)).toBe('checked 1 h ago');
    expect(checkedText(NOW - 3 * HOUR - 20 * MIN, NOW)).toBe('checked 3 h ago');
    expect(checkedText(NOW - 30 * HOUR, NOW)).toBe('checked yesterday');
    expect(checkedText(NOW - 5 * DAY, NOW)).toBe('checked 5 days ago');
  });

  it('a time in the future is just now, garbage is empty', () => {
    expect(checkedText(NOW + HOUR, NOW)).toBe('checked just now');
    expect(checkedText(NaN, NOW)).toBe('');
    expect(checkedText(NOW, NaN)).toBe('');
  });
});

describe('updateStatusText', () => {
  it('checking and downloading', () => {
    expect(updateStatusText(st({ phase: 'checking' }), NOW)).toBe('checking...');
    expect(updateStatusText(st({ phase: 'downloading', latest: '0.3.0', progress: 0.42 }), NOW)).toBe('downloading 0.3.0 (42%)');
    expect(updateStatusText(st({ phase: 'downloading', latest: null, progress: 0.5 }), NOW)).toBe('downloading the update (50%)');
    expect(updateStatusText(st({ phase: 'downloading', latest: '0.3.0', progress: 7 }), NOW)).toBe('downloading 0.3.0 (100%)');
    expect(updateStatusText(st({ phase: 'downloading', latest: '0.3.0', progress: NaN }), NOW)).toBe('downloading 0.3.0 (0%)');
  });

  it('ready, by kind', () => {
    expect(updateStatusText(st({ phase: 'ready', latest: '0.3.0' }), NOW)).toBe('0.3.0 is ready. it installs when you close ncut');
    expect(updateStatusText(st({ phase: 'ready', kind: 'portable', latest: '0.3.0' }), NOW)).toBe('0.3.0 is ready. it replaces this exe when you close ncut');
    expect(updateStatusText(st({ phase: 'ready', kind: 'portable', latest: null }), NOW)).toBe('the update is ready. it replaces this exe when you close ncut');
    expect(updateStatusText(st({ phase: 'ready', kind: 'manual', latest: '0.3.0' }), NOW)).toBe('0.3.0 is out. this copy does not update itself');
  });

  it('ready with the switch off says restart: a normal close applies nothing then', () => {
    expect(updateStatusText(st({ phase: 'ready', auto: false, latest: '0.3.0' }), NOW)).toBe('0.3.0 is ready. press restart to update');
    expect(updateStatusText(st({ phase: 'ready', auto: false, kind: 'portable', latest: '0.3.0' }), NOW)).toBe('0.3.0 is ready. press restart to update');
  });

  it('failed, with and without the newest version', () => {
    expect(updateStatusText(st({ phase: 'failed', error: 'no network' }), NOW)).toBe('could not update: no network');
    expect(updateStatusText(st({ phase: 'failed', error: 'no network', latest: '0.3.0' }), NOW)).toBe('could not update: no network (0.3.0 is out)');
    expect(updateStatusText(st({ phase: 'failed', error: null }), NOW)).toBe('could not update');
    expect(updateStatusText(st({ phase: 'failed', error: 'no network', latest: '0.2.0' }), NOW)).toBe('could not update: no network (newest known: 0.2.0)');
  });

  it('idle with a newer version', () => {
    expect(updateStatusText(st({ auto: false, latest: '0.3.0' }), NOW)).toBe('0.3.0 is out');
    expect(updateStatusText(st({ auto: false, kind: 'portable', latest: '0.3.0' }), NOW)).toBe('0.3.0 is out');
    expect(updateStatusText(st({ kind: 'manual', latest: '0.3.0' }), NOW)).toBe('0.3.0 is out. this copy does not update itself');
  });

  it('idle and current', () => {
    expect(updateStatusText(st({ latest: '0.2.0', checkedAt: NOW - 5 * MIN }), NOW)).toBe('up to date, checked 5 min ago');
    expect(updateStatusText(st({ latest: '0.2.0', checkedAt: NOW - 3 * HOUR }), NOW)).toBe('up to date, checked 3 h ago');
    expect(updateStatusText(st({ latest: '0.2.0', checkedAt: NOW - 30 * HOUR }), NOW)).toBe('up to date, checked yesterday');
    expect(updateStatusText(st({ latest: '0.2.0', checkedAt: null }), NOW)).toBe('up to date');
    // a dev build newer than the release is not behind
    expect(updateStatusText(st({ current: '0.9.0', latest: '0.2.0' }), NOW)).toBe('up to date');
  });

  it('never checked', () => {
    expect(updateStatusText(st(), NOW)).toBe('not checked yet');
  });
});

describe('updateButtons', () => {
  const ids = (s: UpdateState) => updateButtons(s).map((b) => b.id);

  it('check now is off while a check or download runs', () => {
    expect(updateButtons(st())[0]).toMatchObject({ id: 'check', label: 'check now', disabled: false });
    expect(updateButtons(st({ phase: 'checking' }))[0].disabled).toBe(true);
    expect(updateButtons(st({ phase: 'downloading' }))[0].disabled).toBe(true);
    expect(updateButtons(st({ phase: 'ready' }))[0].disabled).toBe(false);
  });

  it('restart is primary and only for a ready update of a self updating copy', () => {
    expect(ids(st({ phase: 'ready', latest: '0.3.0' }))).toEqual(['check', 'restart']);
    expect(updateButtons(st({ phase: 'ready' }))[1]).toMatchObject({ label: 'restart to update', primary: true });
    expect(ids(st({ phase: 'ready', kind: 'portable' }))).toEqual(['check', 'restart']);
    expect(ids(st({ phase: 'ready', kind: 'manual' }))).not.toContain('restart');
    expect(ids(st())).toEqual(['check']);
  });

  it('the download page is for a manual copy with a newer version, or a failure', () => {
    expect(ids(st({ kind: 'manual', latest: '0.3.0' }))).toEqual(['check', 'page']);
    expect(updateButtons(st({ kind: 'manual', latest: '0.3.0' }))[1].label).toBe('download page');
    expect(ids(st({ kind: 'manual', latest: '0.2.0' }))).toEqual(['check']);
    expect(ids(st({ kind: 'manual' }))).toEqual(['check']);
    expect(ids(st({ phase: 'failed' }))).toEqual(['check', 'page']);
    expect(ids(st({ latest: '0.3.0' }))).toEqual(['check']);
  });
});

describe('acceptUpdateState', () => {
  const real = st({ phase: 'ready', latest: '0.3.0' });
  const none = st({ kind: 'none' });

  it('takes a new state', () => {
    expect(acceptUpdateState(null, real, false)).toBe(real);
    expect(acceptUpdateState(st({ phase: 'downloading' }), real, false)).toBe(real);
  });

  it('drops an answer that an event overtook', () => {
    const shown = st({ phase: 'failed', error: 'x' });
    expect(acceptUpdateState(shown, st({ phase: 'checking' }), true)).toBe(shown);
    expect(acceptUpdateState(null, real, true)).toBeNull();
  });

  it('a none state never replaces a real one, but it is the first answer when nothing was shown', () => {
    expect(acceptUpdateState(real, none, false)).toBe(real);
    expect(acceptUpdateState(null, none, false)).toBe(none);
  });
});
