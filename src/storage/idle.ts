/**
 * run something when the browser is idle (requestIdleCallback, at the latest after `timeoutMs`).
 * where that does not exist it is a plain setTimeout(fn, 0). returns a function that cancels it.
 */
export interface IdleEnv {
  requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
  setTimeout: (cb: () => void, ms: number) => unknown;
  clearTimeout: (handle: never) => void;
}

export function whenIdle(fn: () => void, timeoutMs: number, env: IdleEnv = globalThis as unknown as IdleEnv): () => void {
  let live = true;
  const run = () => {
    if (!live) return;
    live = false;
    fn();
  };
  if (typeof env.requestIdleCallback === 'function') {
    const handle = env.requestIdleCallback(run, { timeout: timeoutMs });
    return () => {
      live = false;
      env.cancelIdleCallback?.(handle);
    };
  }
  const handle = env.setTimeout(run, 0);
  return () => {
    live = false;
    env.clearTimeout(handle as never);
  };
}
