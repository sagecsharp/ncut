/**
 * the glue between a tool call and the cursor store: points the caller's cursor before the tool runs and after it
 * ended. a cursor is only decoration, so nothing in here may ever break or hold back a tool call.
 */
import { useEditor } from '../store/editorStore';
import { useMcpCursors } from '../store/mcpCursors';
import { targetAfter, targetBefore, type CursorLookup, type Target } from './cursor';
import type { ToolResult } from './types';

/** what the rules may ask the open project, read from the stores */
export const storeLookup: CursorLookup = {
  markerTime: (id) => useEditor.getState().project?.markers?.find((m) => m.id === id)?.time,
  clipPos: (id) => {
    const c = useEditor.getState().project?.clips.find((x) => x.id === id);
    return c && 'transform' in c && c.transform ? { x: c.transform.x, y: c.transform.y } : undefined;
  },
};

/** a call that is being shown: null when cursors are off (nothing is computed then) */
export interface ShownCall {
  name: string;
  tool: string;
  first: Target;
}

export function cursorBegin(name: string, tool: string, args: Record<string, unknown>): ShownCall | null {
  try {
    const cursors = useMcpCursors.getState();
    if (!cursors.enabled) return null;
    const first = targetBefore(tool, args, storeLookup);
    cursors.begin(name, tool, first);
    return { name, tool, first };
  } catch (e) {
    console.error('mcp cursor failed', e);
    return null;
  }
}

export function cursorEnd(call: ShownCall | null, args: Record<string, unknown>, result: ToolResult): void {
  if (!call) return;
  try {
    useMcpCursors.getState().end(call.name, targetAfter(call.tool, args, result, storeLookup), !result.isError);
  } catch (e) {
    console.error('mcp cursor failed', e);
  }
}
