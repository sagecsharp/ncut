/**
 * the tools an mcp client can call (docs/MCP.md). the desktop shell owns the http side and the token,
 * the page owns the tools: each one is a small function over the stores.
 */
import type { ShellFile } from '../lib/shell';

/** the part of json schema the tools use (validate.ts checks exactly this) */
export interface JsonSchema {
  type?: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array';
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
  /** objects: false = no other keys (the default for tool inputs is false, see validate.ts) */
  additionalProperties?: boolean;
  items?: JsonSchema;
  enum?: readonly (string | number | boolean)[];
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  maxLength?: number;
}

export interface ToolText {
  type: 'text';
  text: string;
}

export interface ToolImage {
  type: 'image';
  /** base64 */
  data: string;
  mimeType: string;
}

export type ToolContent = ToolText | ToolImage;

export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
  /** a ticket whose file was saved by the shell: the shell adds the full path to the answer */
  saved?: number | null;
}

/** what a tool gets besides its arguments */
export interface ToolCtx {
  /** files the shell read for this call (import_media, import_project) */
  files: ShellFile[];
  /** this call may save one file without a dialog (shell.mcp.save) */
  ticket: number | null;
  /** the name of the caller's cursor (the "cursor" argument, already taken off the arguments) */
  cursor?: string;
}

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDef {
  /** snake_case, unique */
  name: string;
  title: string;
  /** written for a model: what it does, units, what comes back */
  description: string;
  /** always type 'object' */
  inputSchema: JsonSchema;
  annotations?: ToolAnnotations;
  /** throw ToolError (helpers.ts) for anything the client did wrong */
  run(args: Record<string, unknown>, ctx: ToolCtx): ToolResult | Promise<ToolResult>;
}

/** what tools/list hands out */
export interface ToolInfo {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  annotations?: ToolAnnotations;
}
