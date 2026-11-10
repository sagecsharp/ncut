import { describe, expect, it, beforeEach } from 'vitest';
import { busyReason, clearBusy } from '../lib/busy';
import { pendingMediaCount, trackMediaWrite, whenAssetStored, whenMediaStored } from './pendingMedia';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('pendingMedia', () => {
  beforeEach(() => clearBusy());

  it('resolves at once when nothing is pending', async () => {
    await whenMediaStored();
    expect(pendingMediaCount()).toBe(0);
    expect(busyReason()).toBeNull();
  });

  it('waits for every pending copy and reports busy meanwhile', async () => {
    const a = deferred();
    const b = deferred();
    trackMediaWrite('a', a.promise);
    trackMediaWrite('b', b.promise);
    expect(pendingMediaCount()).toBe(2);
    expect(busyReason()).toBe('saving imported media');
    let settled = false;
    const w = whenMediaStored().then(() => {
      settled = true;
    });
    a.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    b.resolve();
    await w;
    expect(settled).toBe(true);
    expect(pendingMediaCount()).toBe(0);
    expect(busyReason()).toBeNull();
  });

  it('waits for one asset only', async () => {
    const a = deferred();
    const b = deferred();
    trackMediaWrite('a', a.promise);
    trackMediaWrite('b', b.promise);
    a.resolve();
    await whenAssetStored('a');
    expect(pendingMediaCount()).toBe(1);
    await whenAssetStored('nope');
    b.resolve();
    await whenMediaStored();
    expect(busyReason()).toBeNull();
  });
});
