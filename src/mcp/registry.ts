import { fail, ToolError } from './helpers';
import { addTools } from './tools/add';
import { catalogTools } from './tools/catalog';
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
];

export function listTools(): { tools: ToolInfo[] } {
  return {
    tools: TOOLS.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: t.inputSchema,
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
 * the client can read (a crash also goes to the console).
 */
export async function callTool(name: string, args: Record<string, unknown>, ctx: ToolCtx = NO_CTX): Promise<ToolResult | UnknownTool> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { unknown: true };
  const bad = validate(tool.inputSchema, args);
  if (bad) return fail(bad);
  try {
    return await tool.run(args, ctx);
  } catch (e) {
    if (e instanceof ToolError) return fail(e.message);
    console.error(`mcp tool ${name} failed`, e);
    return fail(`${name} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
