import { beforeEach, describe, expect, it } from 'vitest';
import { busyFor, busyReason, clearBusy, setBusy } from './busy';

beforeEach(() => clearBusy());

describe('busyFor', () => {
  it('is null when none of the keys is busy', () => {
    setBusy('media-store', 'saving imported media');
    expect(busyFor(['export', 'mcp-export'])).toBeNull();
    expect(busyReason()).toBe('saving imported media');
  });

  it('answers the label of a key that is busy, whatever else is', () => {
    setBusy('media-store', 'saving imported media');
    setBusy('mcp-export', 'an export is still running');
    expect(busyFor(['export', 'mcp-export'])).toBe('an export is still running');
  });

  it('is null again when the key is cleared', () => {
    setBusy('export', 'an export is still running');
    setBusy('export', null);
    expect(busyFor(['export'])).toBeNull();
  });
});
