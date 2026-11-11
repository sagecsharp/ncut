import { describe, expect, it } from 'vitest';
import { mcpAddress, mcpCopyButtons, mcpStatusText } from './mcpText';

describe('mcpAddress', () => {
  it('is the local mcp url, and empty without a port', () => {
    expect(mcpAddress({ port: 41713, running: true })).toBe('http://127.0.0.1:41713/mcp');
    expect(mcpAddress({ port: 0, running: true })).toBe('');
  });
  it('is empty while the server does not run, the saved port is no address', () => {
    expect(mcpAddress({ port: 41713, running: false })).toBe('');
  });
});

describe('mcpStatusText', () => {
  it('says off, running, the error, or starting', () => {
    expect(mcpStatusText({ enabled: false, running: false, error: null })).toBe('off');
    expect(mcpStatusText({ enabled: true, running: true, error: null })).toBe('running');
    expect(mcpStatusText({ enabled: true, running: false, error: 'port taken' })).toBe('port taken');
    expect(mcpStatusText({ enabled: true, running: false, error: null })).toBe('starting...');
  });
});

describe('mcpCopyButtons', () => {
  it('shows the stdio copy only with the bridge', () => {
    expect(mcpCopyButtons({ bridge: false, running: true }).map((b) => b.kind)).toEqual(['claude', 'http']);
    expect(mcpCopyButtons({ bridge: true, running: true }).map((b) => b.kind)).toEqual(['claude', 'http', 'stdio']);
  });
  it('shows none while the server does not run', () => {
    expect(mcpCopyButtons({ bridge: true, running: false })).toEqual([]);
  });
});
