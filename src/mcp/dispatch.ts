import { shell, type McpCall } from '../lib/shell';
import { useUi } from '../store/ui';
import { fail } from './helpers';
import { callTool, listTools } from './registry';

/** an answer bigger than this is not sent (the shell has the same cap, electron/mcpRules.cjs MAX_REPLY_CHARS) */
export const MAX_REPLY_CHARS = 24 * 1024 * 1024;

/**
 * how long a call may take from the moment it reached the page, waiting included. a little under the shell's
 * own 180 s: after that the shell has told the client it failed, so running it would be an edit nobody asked for anymore.
 */
export const CALL_BUDGET_MS = 170_000;

type Run = typeof callTool;

function late<T>(ms: number, value: T): { promise: Promise<T>; stop: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const promise = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(value), Math.max(0, ms));
  });
  return { promise, stop: () => timer !== null && clearTimeout(timer) };
}

/**
 * the json text for one call. never throws. a tool that is not done after `budgetMs` is answered as failed
 * (it cannot be stopped, so the text says it may still finish).
 */
export async function answerCall(call: McpCall, budgetMs: number = CALL_BUDGET_MS, run: Run = callTool): Promise<string> {
  let out: unknown;
  try {
    if (call.kind === 'list') out = listTools();
    else {
      const slow = late(budgetMs, null);
      const done = await Promise.race([run(call.name, call.args, { files: call.files, ticket: call.ticket }), slow.promise]);
      slow.stop();
      out = done ?? fail(`${call.name} did not finish in time. it may still be working in ncut: look with get_state before trying again`);
    }
  } catch (e) {
    out = fail(`ncut could not run that: ${e instanceof Error ? e.message : String(e)}`);
  }
  let json: string;
  try {
    json = JSON.stringify(out);
  } catch {
    json = JSON.stringify(fail('the result could not be put into json'));
  }
  if (json.length > MAX_REPLY_CHARS) json = JSON.stringify(fail('the result is too big to send'));
  return json;
}

/**
 * answer the tool requests the desktop shell relays (docs/MCP.md). tool calls run one at a time, in the order
 * they came, so two clients (or one in a hurry) never interleave inside a tool that waits. the tool list is
 * answered at once (a client that connects while a long tool runs still gets its tools). a call that waited
 * past its budget is not run at all. a no-op in a browser. returns the stop function.
 */
export function startMcp(now: () => number = Date.now): () => void {
  if (!shell.mcp.available) return () => {};
  let chain: Promise<void> = Promise.resolve();
  let told = false;
  return shell.mcp.onCall((call) => {
    if (call.kind === 'list') {
      void answerCall(call).then((json) => shell.mcp.reply(call.id, json));
      return;
    }
    if (!told) {
      told = true;
      useUi.getState().toast('an mcp client is working in this window');
    }
    const came = now();
    chain = chain.then(async () => {
      const left = CALL_BUDGET_MS - (now() - came);
      if (left <= 0) {
        shell.mcp.reply(call.id, JSON.stringify(fail(`${call.name} was not run: ncut was busy with an earlier request for too long. try again`)));
        return;
      }
      shell.mcp.reply(call.id, await answerCall(call, left));
    });
  });
}
