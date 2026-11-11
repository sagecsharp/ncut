/** the words and numbers of the mcp server section (McpSettings.tsx), kept apart so they test without a dom */
import type { McpState } from '../../lib/shell';

/** where a client connects. empty while the server does not listen (the saved port is not an address yet) */
export function mcpAddress(state: Pick<McpState, 'port' | 'running'>): string {
  return state.running && state.port > 0 ? `http://127.0.0.1:${state.port}/mcp` : '';
}

/** one plain line for what the server is doing */
export function mcpStatusText(state: Pick<McpState, 'enabled' | 'running' | 'error'>): string {
  if (!state.enabled) return 'off';
  if (state.running) return 'running';
  if (state.error) return state.error;
  return 'starting...';
}

export type McpCopyButton = 'claude' | 'http' | 'stdio';

/** the copy buttons to show: the stdio one needs the bridge script in place */
export function mcpCopyButtons(state: Pick<McpState, 'bridge' | 'running'>): { kind: McpCopyButton; label: string; title: string }[] {
  // the shell copies nothing while the server is not running
  if (!state.running) return [];
  const out: { kind: McpCopyButton; label: string; title: string }[] = [
    { kind: 'claude', label: 'copy claude code command', title: 'copy the command that adds ncut to claude code. run it in a terminal' },
    { kind: 'http', label: 'copy http config', title: 'copy the address and the authorization header for a client that speaks http' },
  ];
  if (state.bridge) {
    out.push({ kind: 'stdio', label: 'copy stdio config', title: 'copy the config for a client that only speaks stdio (needs node on the path)' });
  }
  return out;
}
