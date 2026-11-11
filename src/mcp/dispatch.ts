import { shell, type McpCall } from '../lib/shell';
import { useUi } from '../store/ui';
import { fail } from './helpers';
import { callTool, listTools } from './registry';

/** an answer bigger than this is not sent (the shell has the same cap, electron/mcpRules.cjs MAX_REPLY_CHARS) */
export const MAX_REPLY_CHARS = 24 * 1024 * 1024;

/** the json text for one call. never throws */
export async function answerCall(call: McpCall): Promise<string> {
  let out: unknown;
  try {
    out = call.kind === 'list' ? listTools() : await callTool(call.name, call.args, { files: call.files, ticket: call.ticket });
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
 * answer the tool requests the desktop shell relays (docs/MCP.md). one at a time, in the order they came,
 * so two clients (or one in a hurry) never interleave inside a tool that waits. a no-op in a browser.
 * returns the stop function.
 */
export function startMcp(): () => void {
  if (!shell.mcp.available) return () => {};
  let chain: Promise<void> = Promise.resolve();
  let told = false;
  return shell.mcp.onCall((call) => {
    if (!told && call.kind === 'call') {
      told = true;
      useUi.getState().toast('an mcp client is working in this window');
    }
    chain = chain.then(async () => {
      shell.mcp.reply(call.id, await answerCall(call));
    });
  });
}
