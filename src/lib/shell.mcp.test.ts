import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanMcpCall, cleanMcpState, mcpDownloadName, shell } from './shell';

type G = { window?: unknown };
const g = globalThis as unknown as G;

afterEach(() => {
  delete g.window;
});

describe('shell.mcp in a plain browser or an older shell', () => {
  it('is unavailable and harmless', async () => {
    expect(shell.mcp.available).toBe(false);
    g.window = { ncutShell: { version: '1' } };
    expect(shell.mcp.available).toBe(false);
    expect(await shell.mcp.state()).toEqual({ enabled: false, running: false, port: 0, error: null, bridge: false });
    expect(await shell.mcp.setEnabled(true)).toEqual({ enabled: false, running: false, port: 0, error: null, bridge: false });
    expect(await shell.mcp.copy('claude')).toBe(false);
    expect(await shell.mcp.save(3)).toEqual({ ok: false, name: null });
    expect(() => shell.mcp.reply(1, '{}')).not.toThrow();
    expect(() => shell.mcp.onCall(() => {})()).not.toThrow();
    expect(() => shell.mcp.onState(() => {})()).not.toThrow();
  });
});

describe('shell.mcp with the bridge', () => {
  it('forwards and cleans both ways', async () => {
    const reply = vi.fn();
    const setEnabled = vi.fn(async () => ({ enabled: true, running: true, port: 41713, error: '', bridge: true, token: 'never shown' }));
    let onCall: ((c: unknown) => void) | null = null;
    g.window = {
      ncutShell: {
        mcp: {
          state: async () => ({ enabled: 'yes', port: 70000 }),
          setEnabled,
          copy: async () => true,
          save: async () => ({ ok: true, name: 'a.mp4', path: 'C:/secret' }),
          reply,
          onCall: (cb: (c: unknown) => void) => {
            onCall = cb;
            return () => {
              onCall = null;
            };
          },
        },
      },
    };
    expect(shell.mcp.available).toBe(true);
    expect(await shell.mcp.state()).toEqual({ enabled: false, running: false, port: 0, error: null, bridge: false });
    expect(await shell.mcp.setEnabled('x' as unknown as boolean)).toEqual({ enabled: true, running: true, port: 41713, error: null, bridge: true });
    expect(setEnabled).toHaveBeenCalledWith(false);
    expect(await shell.mcp.copy('http')).toBe(true);
    expect(await shell.mcp.save(4)).toEqual({ ok: true, name: 'a.mp4' });
    shell.mcp.reply(7, '{"content":[]}');
    expect(reply).toHaveBeenCalledWith(7, '{"content":[]}');

    const got: unknown[] = [];
    const off = shell.mcp.onCall((c) => got.push(c));
    const send = onCall as unknown as (c: unknown) => void;
    send({ id: 1, kind: 'call', name: 'seek', args: { time: 2 }, files: 'no', ticket: '5' });
    send({ id: 'x', kind: 'call' });
    send({ id: 2, kind: 'boom' });
    send(null);
    expect(got).toEqual([{ id: 1, kind: 'call', name: 'seek', args: { time: 2 }, files: [], ticket: null }]);
    off();
    expect(onCall).toBeNull();
  });
});

describe('cleanMcpCall', () => {
  it('keeps real files and drops the rest', () => {
    const bytes = new ArrayBuffer(4);
    const c = cleanMcpCall({ id: 3, kind: 'call', name: 'import_media', args: [], files: [{ name: 'a.mp4', bytes }, { name: 5, bytes }, { name: 'b', bytes: 'x' }], ticket: 9 });
    expect(c).toEqual({ id: 3, kind: 'call', name: 'import_media', args: {}, files: [{ name: 'a.mp4', bytes }], ticket: 9 });
  });
});

describe('cleanMcpState', () => {
  it('reads only what it knows', () => {
    expect(cleanMcpState({ enabled: true, running: false, port: 41713, error: 'the port is taken', bridge: false })).toEqual({
      enabled: true,
      running: false,
      port: 41713,
      error: 'the port is taken',
      bridge: false,
    });
    expect(cleanMcpState('x')).toEqual({ enabled: false, running: false, port: 0, error: null, bridge: false });
  });
});

describe('mcpDownloadName', () => {
  it('marks a download for a ticket', () => {
    expect(mcpDownloadName(12, 'my video.mp4')).toBe('ncut-mcp-12-my video.mp4');
  });
});
