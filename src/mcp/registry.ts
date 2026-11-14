import { takeCursor, withCursorSchema } from './cursor';
import { cursorBegin, cursorEnd } from './cursorRun';
import { fail, ToolError } from './helpers';
import { addTools } from './tools/add';
import { catalogTools } from './tools/catalog';
import { cursorTools } from './tools/cursor';
import { editTools } from './tools/edit';
import { keyTools } from './tools/keys';
import { mediaTools } from './tools/media';
import { outputTools } from './tools/output';
import { projectTools } from './tools/project';
import type { ToolCtx, ToolDef, ToolInfo, ToolResult } from './types';
import { validate } from './validate';

/** every tool, in the order a client sees them */
export const TOOLS: readonly ToolDef[] = [
  ...projectTools,
  ...catalogTools,
  ...mediaTools,
  ...addTools,
  ...editTools,
  ...keyTools,
  ...outputTools,
  ...cursorTools,
];

export function listTools(): { tools: ToolInfo[] } {
  return {
    tools: TOOLS.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      // every tool takes the cursor argument: it is added here, so the 40+ definitions do not repeat it
      inputSchema: withCursorSchema(t.inputSchema),
      ...(t.annotations ? { annotations: t.annotations } : {}),
    })),
  };
}

/** the answer for a tool name nobody has (the shell turns it into the protocol's "unknown tool" error) */
export interface UnknownTool {
  unknown: true;
}

const NO_CTX: ToolCtx = { files: [], ticket: null };

/**
 * run one tool. never throws: bad arguments, a ToolError and a crash all come back as an error result
 * the client can read (a crash also goes to the console). the "cursor" argument is taken off first: the
 * tool and the validation never see it, a bad name is an error and the tool is not run.
 */
export async function callTool(name: string, args: Record<string, unknown>, ctx: ToolCtx = NO_CTX): Promise<ToolResult | UnknownTool> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { unknown: true };
  const taken = takeCursor(args);
  if (!taken.ok) return fail(taken.error);
  // the cursor flies to the target before the tool runs (a tool that removes its target has to be pointed at first)
  const shown = cursorBegin(taken.name, tool.name, taken.args);
  const result = await run(tool, taken.args, { ...ctx, cursor: taken.name });
  cursorEnd(shown, taken.args, result);
  return result;
}

async function run(tool: ToolDef, args: Record<string, unknown>, ctx: ToolCtx): Promise<ToolResult> {
  const bad = validate(tool.inputSchema, args);
  if (bad) return fail(bad);
  try {
    return await tool.run(args, ctx);
  } catch (e) {
    if (e instanceof ToolError) return fail(e.message);
    console.error(`mcp tool ${tool.name} failed`, e);
    return fail(`${tool.name} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
