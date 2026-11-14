import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useUi } from '../store/ui';
import { clearUserCheck, decideNotice, noteUserCheck, NOTICE_START, resetUpdateNotice, startUpdateNotice, USER_CHECK_MS, withUserCheck } from './updateNotice';
import type { NoticeMemory } from './updateNotice';
import type { UpdateState } from './shell';

function st(over: Partial<UpdateState> = {}): UpdateState {
  return { kind: 'installed', auto: true, phase: 'idle', current: '0.2.0', latest: null, progress: 0, error: null, checkedAt: null, ...over };
}

describe('decideNotice, a ready version', () => {
  it('tells it once per version', () => {
    const ready = st({ phase: 'ready', latest: '0.3.0' });
    const first = decideNotice(st({ phase: 'downloading', latest: '0.3.0' }), ready, NOTICE_START);
    expect(first.toast).toEqual({ text: 'ncut 0.3.0 is ready. it installs when you close ncut', kind: 'success' });
    expect(first.memory.told).toEqual(['0.3.0']);
    const again = decideNotice(ready, { ...ready, checkedAt: 5 }, first.memory);
    expect(again.toast).toBeNull();
    // a newer one after it is news again
    const newer = decideNotice(ready, st({ phase: 'ready', latest: '0.4.0' }), first.memory);
    expect(newer.toast?.text).toBe('ncut 0.4.0 is ready. it installs when you close ncut');
    expect(newer.memory.told).toEqual(['0.3.0', '0.4.0']);
  });

  it('with the switch off the toast says restart, not close', () => {
    const d = decideNotice(null, st({ phase: 'ready', auto: false, latest: '0.3.0' }), NOTICE_START);
    expect(d.toast).toEqual({ text: 'ncut 0.3.0 is ready. press restart to update', kind: 'success' });
  });

  it('says nothing for a ready state without a known version', () => {
    expect(decideNotice(null, st({ phase: 'ready', latest: null }), NOTICE_START).toast).toBeNull();
  });
});

describe('decideNotice, a failure', () => {
  const failed = st({ phase: 'failed', error: 'no network', checkedAt: 10 });
  const T0 = 1_000_000;

  it('a background failure is quiet', () => {
    expect(decideNotice(st({ phase: 'checking' }), failed, NOTICE_START).toast).toBeNull();
  });

  it('a failure of the check the user started is told once', () => {
    const asked = withUserCheck(NOTICE_START, T0);
    const d = decideNotice(st({ phase: 'checking' }), failed, asked, T0 + 1000);
    expect(d.toast).toEqual({ text: 'could not update: no network', kind: 'error' });
    expect(d.memory.askedAt).toBeNull();
    expect(decideNotice(failed, failed, d.memory, T0 + 2000).toast).toBeNull();
  });

  it('the same old failure arriving again is not the answer to a new press', () => {
    const asked = withUserCheck(NOTICE_START, T0);
    const d = decideNotice(failed, { ...failed }, asked, T0 + 1000);
    expect(d.toast).toBeNull();
    expect(d.memory.askedAt).toBe(T0);
  });

  it('a new failure after an old one counts', () => {
    const asked = withUserCheck(NOTICE_START, T0);
    expect(decideNotice(failed, { ...failed, checkedAt: 20 }, asked, T0 + 1000).toast?.kind).toBe('error');
  });

  it('a failed download of the user check is told, without an error text too', () => {
    const asked = withUserCheck(NOTICE_START, T0);
    expect(decideNotice(st({ phase: 'downloading' }), st({ phase: 'failed', error: null }), asked, T0 + 1000).toast?.text).toBe('could not update');
  });

  it('the wish survives while the check runs and ends with a good finish', () => {
    const asked = withUserCheck(NOTICE_START, T0);
    const t = T0 + 1000;
    expect(decideNotice(null, st({ phase: 'checking' }), asked, t).memory.askedAt).toBe(T0);
    expect(decideNotice(null, st({ phase: 'downloading' }), asked, t).memory.askedAt).toBe(T0);
    expect(decideNotice(null, st({ phase: 'idle', latest: '0.2.0' }), asked, t).memory.askedAt).toBeNull();
    const ready = decideNotice(null, st({ phase: 'ready', latest: '0.3.0' }), asked, t);
    expect(ready.memory.askedAt).toBeNull();
  });

  it('a failure long after the press is a background one', () => {
    const asked = withUserCheck(NOTICE_START, T0);
    const late = decideNotice(st({ phase: 'checking' }), failed, asked, T0 + USER_CHECK_MS + 1);
    expect(late.toast).toBeNull();
    expect(late.memory.askedAt).toBeNull();
  });

  it('a press during a download that ran already does not cover its late failure', () => {
    const asked = withUserCheck(NOTICE_START, T0);
    const during = decideNotice(st({ phase: 'downloading', progress: 0.1 }), st({ phase: 'downloading', progress: 0.2 }), asked, T0 + 5000);
    expect(during.memory.askedAt).toBe(T0);
    const late = decideNotice(st({ phase: 'downloading' }), st({ phase: 'failed', error: 'cut off', checkedAt: 99 }), during.memory, T0 + 10 * 60_000);
    expect(late.toast).toBeNull();
  });

  it('a check that goes on into a download keeps the wish for a new window', () => {
    const asked = withUserCheck(NOTICE_START, T0);
    const t1 = T0 + 30_000;
    const down = decideNotice(st({ phase: 'checking' }), st({ phase: 'downloading', latest: '0.3.0' }), asked, t1);
    expect(down.memory.askedAt).toBe(t1);
    const fail = decideNotice(st({ phase: 'downloading' }), st({ phase: 'failed', error: 'cut off', checkedAt: 99 }), down.memory, t1 + 50_000);
    expect(fail.toast?.text).toBe('could not update: cut off');
  });

  it('a shell without an updater says nothing', () => {
    const d = decideNotice(null, st({ kind: 'none', phase: 'failed', error: 'x' }), withUserCheck(NOTICE_START, T0));
    expect(d.toast).toBeNull();
    expect(d.memory.askedAt).toBeNull();
  });

  it('does not change the memory it was given', () => {
    const mem: NoticeMemory = { told: ['0.3.0'], askedAt: 5 };
    decideNotice(null, st({ phase: 'ready', latest: '0.4.0' }), mem);
    expect(mem).toEqual({ told: ['0.3.0'], askedAt: 5 });
  });
});

type G = { window?: unknown };
const g = globalThis as unknown as G;

describe('startUpdateNotice', () => {
  beforeEach(() => {
    resetUpdateNotice();
    useUi.setState({ toasts: [] });
  });
  afterEach(() => {
    delete g.window;
    resetUpdateNotice();
    useUi.setState({ toasts: [] });
  });

  it('is a no-op in a browser', () => {
    expect(() => startUpdateNotice()()).not.toThrow();
    expect(useUi.getState().toasts).toEqual([]);
  });

  it('toasts a ready version once, and a failure only after check now', () => {
    let push: ((s: unknown) => void) | null = null;
    g.window = {
      ncutShell: {
        update: {
          state: async () => ({}),
          setAuto: async () => ({}),
          check: async () => ({}),
          restart: async () => true,
          openPage: async () => true,
          onState: (cb: (s: unknown) => void) => {
            push = cb;
            return () => {
              push = null;
            };
          },
        },
      },
    };
    const stop = startUpdateNotice();
    const send = push as unknown as (s: unknown) => void;
    const msgs = () => useUi.getState().toasts.map((t) => t.message);
    const base = { kind: 'installed', current: '0.2.0', latest: '0.3.0' };

    send({ ...base, phase: 'failed', error: 'no network', checkedAt: 1 });
    expect(msgs()).toEqual([]);
    send({ ...base, phase: 'ready' });
    send({ ...base, phase: 'ready', checkedAt: 2 });
    expect(msgs()).toEqual(['ncut 0.3.0 is ready. it installs when you close ncut']);

    noteUserCheck();
    send({ ...base, phase: 'checking' });
    send({ ...base, phase: 'failed', error: 'no network', checkedAt: 3 });
    expect(msgs()).toEqual(['ncut 0.3.0 is ready. it installs when you close ncut', 'could not update: no network']);
    stop();
    expect(push).toBeNull();
  });

  it('a press that the shell never answered does not turn a later background failure into a toast', () => {
    let push: ((s: unknown) => void) | null = null;
    g.window = {
      ncutShell: {
        update: {
          state: async () => ({}),
          setAuto: async () => ({}),
          check: async () => ({}),
          restart: async () => true,
          openPage: async () => true,
          onState: (cb: (s: unknown) => void) => {
            push = cb;
            return () => {};
          },
        },
      },
    };
    startUpdateNotice();
    const send = push as unknown as (s: unknown) => void;
    noteUserCheck();
    clearUserCheck();
    send({ kind: 'installed', current: '0.2.0', latest: '0.3.0', phase: 'failed', error: 'no network', checkedAt: 7 });
    expect(useUi.getState().toasts).toEqual([]);
  });
});
