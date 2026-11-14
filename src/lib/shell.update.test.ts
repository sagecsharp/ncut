import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanUpdateState, shell } from './shell';

type G = { window?: unknown };
const g = globalThis as unknown as G;

afterEach(() => {
  delete g.window;
});

const NONE = { kind: 'none', auto: true, phase: 'idle', current: '', latest: null, progress: 0, error: null, checkedAt: null };

function fullUpdate(over: Record<string, unknown> = {}) {
  return {
    state: async () => ({}),
    setAuto: async () => ({}),
    check: async () => ({}),
    restart: async () => true,
    openPage: async () => true,
    onState: () => () => {},
    ...over,
  };
}

describe('shell.update in a plain browser or an older shell', () => {
  it('is unavailable and harmless', async () => {
    expect(shell.update.available).toBe(false);
    g.window = { ncutShell: { version: '1', mcp: {} } };
    expect(shell.update.available).toBe(false);
    expect(await shell.update.state()).toEqual(NONE);
    expect(await shell.update.setAuto(true)).toEqual(NONE);
    expect(await shell.update.check()).toEqual(NONE);
    expect(await shell.update.restart()).toBe(false);
    expect(await shell.update.openPage()).toBe(false);
    expect(() => shell.update.onState(() => {})()).not.toThrow();
  });

  it('is unavailable when a function is missing', () => {
    const partial: Record<string, unknown> = fullUpdate();
    delete partial.restart;
    g.window = { ncutShell: { update: partial } };
    expect(shell.update.available).toBe(false);
  });

  it('survives a shell that throws or answers nothing', async () => {
    g.window = {
      ncutShell: {
        update: fullUpdate({
          state: async () => {
            throw new Error('boom');
          },
          check: () => undefined,
          restart: async () => 'yes',
        }),
      },
    };
    expect(await shell.update.state()).toEqual(NONE);
    expect(await shell.update.check()).toEqual(NONE);
    expect(await shell.update.restart()).toBe(false);
  });
});

describe('shell.update with an updater', () => {
  it('forwards and cleans both ways', async () => {
    const setAuto = vi.fn(async () => ({ kind: 'portable', auto: false, phase: 'idle', current: '0.2.0', latest: '0.3.0', progress: 0, error: '', checkedAt: 5, path: 'C:/secret' }));
    let push: ((s: unknown) => void) | null = null;
    g.window = {
      ncutShell: {
        update: fullUpdate({
          state: async () => ({ kind: 'installed', auto: true, phase: 'downloading', current: '0.2.0', latest: '0.3.0', progress: 0.4, error: null, checkedAt: 9 }),
          setAuto,
          openPage: async () => true,
          onState: (cb: (s: unknown) => void) => {
            push = cb;
            return () => {
              push = null;
            };
          },
        }),
      },
    };
    expect(shell.update.available).toBe(true);
    expect(await shell.update.state()).toEqual({ kind: 'installed', auto: true, phase: 'downloading', current: '0.2.0', latest: '0.3.0', progress: 0.4, error: null, checkedAt: 9 });
    expect(await shell.update.setAuto('x' as unknown as boolean)).toEqual({ kind: 'portable', auto: false, phase: 'idle', current: '0.2.0', latest: '0.3.0', progress: 0, error: null, checkedAt: 5 });
    expect(setAuto).toHaveBeenCalledWith(false);
    expect(await shell.update.openPage()).toBe(true);

    const got: unknown[] = [];
    const off = shell.update.onState((s) => got.push(s));
    const send = push as unknown as (s: unknown) => void;
    send({ kind: 'manual', phase: 'ready', current: '1.0.0', latest: '1.0.1' });
    send(null);
    expect(got).toEqual([{ kind: 'manual', auto: true, phase: 'ready', current: '1.0.0', latest: '1.0.1', progress: 0, error: null, checkedAt: null }, NONE]);
    off();
    expect(push).toBeNull();
  });

  it('a listener that throws does not break the shell', () => {
    let push: ((s: unknown) => void) | null = null;
    g.window = {
      ncutShell: {
        update: fullUpdate({
          onState: (cb: (s: unknown) => void) => {
            push = cb;
            return () => {};
          },
        }),
      },
    };
    shell.update.onState(() => {
      throw new Error('listener');
    });
    expect(() => (push as unknown as (s: unknown) => void)({})).not.toThrow();
  });
});

describe('cleanUpdateState', () => {
  it('turns anything into the none state', () => {
    for (const v of [null, undefined, 5, 'x', [], true]) expect(cleanUpdateState(v)).toEqual(NONE);
  });

  it('keeps a good state and drops unknown fields', () => {
    const good = { kind: 'installed', auto: false, phase: 'ready', current: '0.2.0', latest: '0.3.0', progress: 0, error: null, checkedAt: 1000 };
    expect(cleanUpdateState({ ...good, url: 'https://x', path: 'C:/x' })).toEqual(good);
  });

  it('unknown kind is none, unknown phase is idle', () => {
    expect(cleanUpdateState({ kind: 'deb', phase: 'dancing' })).toMatchObject({ kind: 'none', phase: 'idle' });
    expect(cleanUpdateState({ kind: 5, phase: null })).toMatchObject({ kind: 'none', phase: 'idle' });
  });

  it('the auto switch is on when missing, and a value that is not a real boolean does not count as on', () => {
    expect(cleanUpdateState({ auto: false }).auto).toBe(false);
    expect(cleanUpdateState({ auto: true }).auto).toBe(true);
    expect(cleanUpdateState({}).auto).toBe(true);
    for (const bad of [0, 1, 'false', 'true', null, []]) expect(cleanUpdateState({ kind: 'installed', auto: bad }).auto).toBe(false);
  });

  it('an object that throws when it is read is the none state, not a throw', () => {
    const getter = { kind: 'installed', get phase(): string { throw new Error('boom'); } };
    const proxy = new Proxy({}, { get() { throw new Error('boom'); }, has() { throw new Error('boom'); }, getPrototypeOf() { throw new Error('boom'); } });
    expect(cleanUpdateState(getter)).toEqual(NONE);
    expect(cleanUpdateState(proxy)).toEqual(NONE);
  });

  it('state() and onState() survive a state that throws when it is read', async () => {
    const bad = { get kind(): string { throw new Error('x'); } };
    let push: ((s: unknown) => void) | null = null;
    g.window = {
      ncutShell: {
        update: {
          ...fullUpdate(),
          state: async () => bad,
          onState: (cb: (s: unknown) => void) => {
            push = cb;
            return () => {};
          },
        },
      },
    };
    expect(await shell.update.state()).toEqual(NONE);
    const got: unknown[] = [];
    shell.update.onState((s) => got.push(s));
    expect(() => (push as unknown as (s: unknown) => void)(bad)).not.toThrow();
    expect(got).toEqual([NONE]);
  });

  it('versions are three numbers or nothing', () => {
    for (const bad of ['1.2', '1.2.3.4', 'v1.2.3', '1.2.x', '', '1.2.3-beta', ' 1.2.3', '1234567890.1.1', 5, null]) {
      const s = cleanUpdateState({ kind: 'installed', current: bad, latest: bad });
      expect(s.current).toBe('');
      expect(s.latest).toBeNull();
    }
    expect(cleanUpdateState({ current: '10.20.30', latest: '0.0.1' })).toMatchObject({ current: '10.20.30', latest: '0.0.1' });
  });

  it('the progress stays in 0..1, only while downloading', () => {
    const dl = (progress: unknown) => cleanUpdateState({ phase: 'downloading', progress }).progress;
    expect(dl(0.5)).toBe(0.5);
    expect(dl(3)).toBe(1);
    expect(dl(-1)).toBe(0);
    expect(dl(NaN)).toBe(0);
    expect(dl(Infinity)).toBe(0);
    expect(dl('0.5')).toBe(0);
    expect(cleanUpdateState({ phase: 'ready', progress: 0.5 }).progress).toBe(0);
  });

  it('cuts a long error and drops an empty or wrong one', () => {
    expect(cleanUpdateState({ error: 'x'.repeat(500) }).error).toBe('x'.repeat(200));
    expect(cleanUpdateState({ error: '' }).error).toBeNull();
    expect(cleanUpdateState({ error: 5 }).error).toBeNull();
    expect(cleanUpdateState({ error: 'no network' }).error).toBe('no network');
  });

  it('checkedAt is a finite positive time or null', () => {
    expect(cleanUpdateState({ checkedAt: 123 }).checkedAt).toBe(123);
    for (const bad of [NaN, Infinity, -5, 0, '5', null]) expect(cleanUpdateState({ checkedAt: bad }).checkedAt).toBeNull();
  });
});
