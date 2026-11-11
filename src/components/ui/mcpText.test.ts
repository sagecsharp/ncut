import { describe, expect, it } from 'vitest';
import { mcpAddress, mcpCopyButtons, mcpStatusText } from './mcpText';

describe('mcpAddress', () => {
  it('is the local mcp url, and empty without a port', () => {
    expect(mcpAddress({ port: 41713 })).toBe('http://127.0.0.1:41713/mcp');
    expect(mcpAddress({ port: 0 })).toBe('');
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
    expect(mcpCopyButtons({ bridge: false }).map((b) => b.kind)).toEqual(['claude', 'http']);
    expect(mcpCopyButtons({ bridge: true }).map((b) => b.kind)).toEqual(['claude', 'http', 'stdio']);
  });
});
