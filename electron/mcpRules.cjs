'use strict';
/**
 * every decision of the mcp server, as pure functions (no electron, no fs, no sockets): what a request has to look
 * like before it is answered, how a json-rpc message is read, what a path may be, what a page reply may hold.
 * electron/mcp.cjs does the io and only asks these. the contract is docs/MCP.md. this guards a local socket,
 * so every rule here refuses by default.
 */
const crypto = require('node:crypto');
const shellRules = require('./rules.cjs');

// ---------- numbers ----------

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const LATEST = PROTOCOLS[0];
const ENDPOINT = '/mcp';
const MAX_BODY_BYTES = 1024 * 1024;
/** the same number as MAX_REPLY_CHARS in src/mcp/dispatch.ts */
const MAX_REPLY_CHARS = 24 * 1024 * 1024;
const FIRST_PORT = 41713;
/** the first port and the 20 after it */
const PORT_TRIES = 21;
const MAX_SOCKETS = 16;
const MAX_PENDING = 8;
const LIST_TIMEOUT_MS = 10 * 1000;
const CALL_TIMEOUT_MS = 180 * 1000;
const MAX_FILES = 16;
const MAX_FILE_BYTES_PER_CALL = 1024 * 1024 * 1024;
/** all calls together: the bytes main holds while files wait for the page */
const MAX_BYTES_IN_FLIGHT = 1024 * 1024 * 1024;
const TICKET_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_TICKETS = 8;
const ARM_TIMEOUT_MS = 60 * 1000;
const MAX_SAVED = 32;
const MAX_NAME_CHARS = 200;

// json-rpc codes
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const SERVER_ERROR = -32000;

// ---------- protocol ----------

/** the version to answer an initialize with: the asked one when it is ours, else the newest */
function negotiateVersion(asked) {
  return typeof asked === 'string' && PROTOCOLS.includes(asked) ? asked : LATEST;
}

/** the MCP-Protocol-Version header: absent is fine, present has to be one of ours */
function versionHeaderOk(header) {
  if (header === undefined) return true;
  return typeof header === 'string' && PROTOCOLS.includes(header);
}

const INSTRUCTIONS =
  'ncut is a video editor and this server works in the window the user has open. call get_state first to see what is open. ' +
  'call list_options to learn the ids of effects, transitions, presets and fonts before you use them. ' +
  'times are in seconds on the timeline and sizes are project pixels. every edit you make is one undo step, so the user can undo it.';

function initializeResult(version, appVersion) {
  return {
    protocolVersion: negotiateVersion(version),
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: 'ncut', title: 'ncut', version: typeof appVersion === 'string' && appVersion !== '' ? appVersion : '0.0.0' },
    instructions: INSTRUCTIONS,
  };
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } };
}

/** a tool result with one text item */
function textResult(text, isError) {
  return isError === true ? { content: [{ type: 'text', text }], isError: true } : { content: [{ type: 'text', text }] };
}

function isPlain(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isRpcId(v) {
  return (typeof v === 'string' && v.length <= 1000) || (typeof v === 'number' && Number.isFinite(v));
}

/**
 * read the body of one post. a json-rpc message is a request (has method and id), a notification (method, no id),
 * a response (result or error and an id) or invalid. a batch (array) is invalid on purpose: this server has none.
 * returns { type: 'parse-error' } | { type: 'invalid', id, why } | { type: 'request', id, method, params } |
 * { type: 'notification', method } | { type: 'response' }
 */
function classifyMessage(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { type: 'parse-error' };
  }
  if (Array.isArray(value)) return { type: 'invalid', id: null, why: 'batches are not supported, send one message per post' };
  if (!isPlain(value)) return { type: 'invalid', id: null, why: 'a json-rpc message is an object' };
  const id = isRpcId(value.id) ? value.id : null;
  if (value.jsonrpc !== '2.0') return { type: 'invalid', id, why: 'jsonrpc has to be "2.0"' };
  if ('method' in value) {
    if (typeof value.method !== 'string' || value.method === '' || value.method.length > 200) return { type: 'invalid', id, why: 'method has to be a text' };
    if ('params' in value && !isPlain(value.params) && !Array.isArray(value.params)) return { type: 'invalid', id, why: 'params has to be an object' };
    if ('id' in value) {
      if (!isRpcId(value.id)) return { type: 'invalid', id: null, why: 'id has to be a text or a number' };
      return { type: 'request', id: value.id, method: value.method, params: isPlain(value.params) ? value.params : {} };
    }
    return { type: 'notification', method: value.method };
  }
  if (isRpcId(value.id) && ('result' in value) !== ('error' in value)) return { type: 'response' };
  return { type: 'invalid', id, why: 'not a request, a notification or a response' };
}

// ---------- the request, in the order of docs/MCP.md ----------

/** the saved mcp.json content, cleaned. anything wrong falls back to off / no port / no token */
function cleanConfig(raw) {
  const o = isPlain(raw) ? raw : {};
  return {
    enabled: o.enabled === true,
    port: Number.isInteger(o.port) && o.port >= 1024 && o.port <= 65535 ? o.port : 0,
    token: typeof o.token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(o.token) ? o.token : '',
  };
}

/** the ports to try, in order: the saved one, then the first one and the 20 after it. 0 (any free port) is the caller's last resort */
function portCandidates(saved, first, tries) {
  const out = [];
  if (Number.isInteger(saved) && saved >= 1024 && saved <= 65535) out.push(saved);
  const start = Number.isInteger(first) ? first : FIRST_PORT;
  const count = Number.isInteger(tries) ? tries : PORT_TRIES;
  for (let i = 0; i < count; i++) {
    const p = start + i;
    if (p >= 1024 && p <= 65535 && !out.includes(p)) out.push(p);
  }
  return out;
}

/** dns rebinding guard: only the two names of this machine with the port we listen on */
function hostAllowed(host, port) {
  if (typeof host !== 'string') return false;
  const h = host.toLowerCase();
  return h === `127.0.0.1:${port}` || h === `localhost:${port}`;
}

/** a browser page always sends an Origin on a cross site post: no Origin header at all, or no entry */
function originAllowed(origin) {
  return origin === undefined;
}

/** the token of an `Authorization: Bearer <token>` header, or null */
function bearerToken(header) {
  if (typeof header !== 'string' || header.length > 4096) return null;
  const m = /^bearer[ \t]+([^\s]+)$/i.exec(header.trim());
  return m ? m[1] : null;
}

function digest(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest();
}

/** constant time: both sides are hashed first, so the length of the token is not leaked either */
function tokenMatches(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || expected === '') return false;
  return crypto.timingSafeEqual(digest(given), digest(expected));
}

function jsonContentType(header) {
  return typeof header === 'string' && /^application\/json[ \t]*(;.*)?$/i.test(header.trim());
}

/**
 * steps 1 to 5 of "every request, in this order", from the headers alone. null = go on, else what to answer:
 * { status, message, headers? }. the body size is checked once more while the body is read.
 * req: { method, url, host, origin, authorization, contentType, contentLength } as node gives them (strings or undefined).
 */
function checkRequest(req, cfg) {
  const path = typeof req.url === 'string' ? req.url.split('?')[0] : '';
  if (path !== ENDPOINT) return { status: 404, message: 'not found' };
  if (req.method !== 'POST') return { status: 405, message: 'method not allowed', headers: { Allow: 'POST' } };
  if (!hostAllowed(req.host, cfg.port)) return { status: 403, message: 'forbidden host' };
  if (!originAllowed(req.origin)) return { status: 403, message: 'forbidden origin' };
  const bearer = bearerToken(req.authorization);
  if (!cfg.token || bearer === null || !tokenMatches(bearer, cfg.token)) {
    return { status: 401, message: 'unauthorized', headers: { 'WWW-Authenticate': 'Bearer' } };
  }
  if (!jsonContentType(req.contentType)) return { status: 415, message: 'content-type has to be application/json' };
  if (typeof req.contentLength === 'number' && req.contentLength > MAX_BODY_BYTES) return { status: 413, message: 'the body is too big' };
  return null;
}

// ---------- the tools that take files ----------

const MEDIA_EXTS = [
  'mp4', 'm4v', 'mov', 'webm', 'mkv', 'ogv', 'avi', 'ts', 'mts', '3gp',
  'mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus', 'weba', 'aiff', 'aif',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'svg',
];

/** which argument holds the paths, how many, which extensions */
const FILE_TOOLS = {
  import_media: { arg: 'paths', many: true, max: MAX_FILES, exts: MEDIA_EXTS },
  import_project: { arg: 'path', many: false, max: 1, exts: ['ncut'] },
};

/** the file rules of a tool, or null when it takes no files */
function fileSpec(tool) {
  return typeof tool === 'string' && Object.prototype.hasOwnProperty.call(FILE_TOOLS, tool) ? FILE_TOOLS[tool] : null;
}

/** only export_video makes a file the shell saves */
function wantsTicket(tool) {
  return tool === 'export_video';
}

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;

/** one path against the rules. { ok: true, path } or { ok: false, reason } */
function checkFilePath(p, exts) {
  if (typeof p !== 'string' || p === '') return { ok: false, reason: 'the path is empty' };
  if (p.length > 1000) return { ok: false, reason: 'the path is too long' };
  if (p.includes('\0')) return { ok: false, reason: 'the path holds a nul character' };
  if (/[\u0001-\u001f]/.test(p)) return { ok: false, reason: 'the path holds a control character' };
  if (/^[\\/]{2}/.test(p)) return { ok: false, reason: 'network and device paths are not allowed' };
  if (!/^[A-Za-z]:[\\/]/.test(p)) return { ok: false, reason: 'the path has to be absolute with a drive letter, like C:\\folder\\file.mp4' };
  const rest = p.slice(2);
  if (/[<>:"|?*]/.test(rest)) return { ok: false, reason: 'the path holds a character windows does not allow in a name' };
  if (/[\\/]$/.test(p)) return { ok: false, reason: 'the path names a folder, not a file' };
  const parts = rest.split(/[\\/]+/).filter((s) => s !== '');
  if (parts.length === 0) return { ok: false, reason: 'the path names no file' };
  for (const part of parts) {
    if (part === '.' || part === '..') return { ok: false, reason: 'the path may not hold . or .. parts' };
    if (/[. ]$/.test(part)) return { ok: false, reason: 'a name in the path ends with a dot or a space' };
    if (RESERVED.test(part)) return { ok: false, reason: 'the path holds a reserved device name' };
  }
  const base = parts[parts.length - 1];
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  if (!exts.includes(ext)) return { ok: false, reason: `.${ext || '?'} is not a supported file type (${exts.join(' ')})` };
  return { ok: true, path: p };
}

function shown(p) {
  const s = typeof p === 'string' ? p : String(p);
  return s.length > 120 ? `${s.slice(0, 117)}...` : s.replace(/[\u0000-\u001f]/g, '?');
}

/** the message for a path that cannot be used: names the path and the reason */
function pathProblem(p, reason) {
  return `cannot use the path "${shown(p)}": ${reason}`;
}

/**
 * the paths a file tool asked for, checked. { ok: true, paths } or { ok: false, error } (error is the text of a tool result).
 * the caller removes the argument from the call and passes the files it read instead.
 */
function planFiles(spec, args) {
  const raw = isPlain(args) ? args[spec.arg] : undefined;
  let list;
  if (spec.many) {
    if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: `${spec.arg} has to be a list of 1 to ${spec.max} file paths` };
    if (raw.length > spec.max) return { ok: false, error: `at most ${spec.max} files in one call, got ${raw.length}` };
    list = raw;
  } else {
    if (typeof raw !== 'string') return { ok: false, error: `${spec.arg} has to be one file path` };
    list = [raw];
  }
  const paths = [];
  for (const p of list) {
    const got = checkFilePath(p, spec.exts);
    if (!got.ok) return { ok: false, error: pathProblem(p, got.reason) };
    paths.push(got.path);
  }
  return { ok: true, paths };
}

/** the call arguments without the path argument (files take its place) */
function withoutPathArg(spec, args) {
  const out = {};
  if (isPlain(args)) for (const k of Object.keys(args)) if (k !== spec.arg) out[k] = args[k];
  return out;
}

// ---------- what the page answers ----------

function cleanContent(list) {
  const out = [];
  for (const item of list) {
    if (!isPlain(item)) continue;
    if (item.type === 'text' && typeof item.text === 'string') out.push({ type: 'text', text: item.text });
    else if (item.type === 'image' && typeof item.data === 'string' && typeof item.mimeType === 'string') {
      out.push({ type: 'image', data: item.data, mimeType: item.mimeType });
    }
  }
  return out;
}

/**
 * a reply of the page, checked again. kind 'list' or 'call'.
 * { ok: true, value } with value { tools } | { unknown: true } | { content, isError?, saved? }, or { ok: false }
 */
function cleanReply(json, kind) {
  if (typeof json !== 'string' || json.length > MAX_REPLY_CHARS) return { ok: false };
  let v;
  try {
    v = JSON.parse(json);
  } catch {
    return { ok: false };
  }
  if (!isPlain(v)) return { ok: false };
  if (kind === 'list') {
    if (!Array.isArray(v.tools)) return { ok: false };
    return { ok: true, value: { tools: v.tools.filter((t) => isPlain(t) && typeof t.name === 'string' && t.name !== '') } };
  }
  if (v.unknown === true) return { ok: true, value: { unknown: true } };
  if (!Array.isArray(v.content)) return { ok: false };
  const value = { content: cleanContent(v.content) };
  if (typeof v.isError === 'boolean') value.isError = v.isError;
  if (typeof v.saved === 'number' && Number.isSafeInteger(v.saved)) value.saved = v.saved;
  return { ok: true, value };
}

/** the text item added to a reply that holds a saved file */
function savedItem(file) {
  return { type: 'text', text: `saved to ${file}` };
}

// ---------- connect texts ----------

/** what "copy ..." puts on the clipboard. null for an unknown kind or when there is nothing to connect to yet */
function clipboardText(kind, info) {
  if (kind !== 'claude' && kind !== 'http' && kind !== 'stdio') return null;
  if (!info || !Number.isInteger(info.port) || info.port <= 0) return null;
  const url = `http://127.0.0.1:${info.port}${ENDPOINT}`;
  if (kind === 'stdio') {
    if (typeof info.bridgePath !== 'string' || info.bridgePath === '') return null;
    return JSON.stringify({ mcpServers: { ncut: { command: 'node', args: [info.bridgePath] } } }, null, 2);
  }
  if (typeof info.token !== 'string' || info.token === '') return null;
  const header = `Bearer ${info.token}`;
  if (kind === 'claude') return `claude mcp add --transport http ncut ${url} --header "Authorization: ${header}"`;
  return JSON.stringify({ mcpServers: { ncut: { type: 'http', url, headers: { Authorization: header } } } }, null, 2);
}

// ---------- downloads of a tool ----------

/** the marker src/lib/shell.ts mcpDownloadName writes: ncut-mcp-<ticket>-<file name>. { ticket, file } or null */
function parseDownloadName(name) {
  const m = /^ncut-mcp-(\d{1,15})-([\s\S]+)$/.exec(String(name ?? ''));
  if (!m) return null;
  const ticket = Number(m[1]);
  return Number.isSafeInteger(ticket) ? { ticket, file: m[2] } : null;
}

/** the file name to save under: cleaned like every download, never a path */
function savedFileName(file) {
  return shellRules.safeFileName(file).slice(0, MAX_NAME_CHARS);
}

/** the only extensions a ticket download may have: what export_video makes. nothing else is saved without a dialog */
const TICKET_EXTS = ['mp4', 'webm', 'gif', 'wav', 'ogg', 'png', 'jpg'];

function ticketExtOk(name) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(name ?? ''));
  return m !== null && TICKET_EXTS.includes(m[1].toLowerCase());
}

/** the clipboard gets the token only for a known kind and only while the window is the one in use */
function copyAllowed(kind, focused) {
  return focused === true && (kind === 'claude' || kind === 'http' || kind === 'stdio');
}

/**
 * the first of `name`, `name (2).ext`, `name (3).ext` ... that `taken` does not know. null when 9999 are taken.
 * `taken(candidate)` may reserve the name it returns false for.
 */
function uniqueName(name, taken) {
  if (!taken(name)) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 2; n <= 9999; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!taken(candidate)) return candidate;
  }
  return null;
}

module.exports = {
  PROTOCOLS,
  LATEST,
  ENDPOINT,
  MAX_BODY_BYTES,
  MAX_REPLY_CHARS,
  FIRST_PORT,
  PORT_TRIES,
  MAX_SOCKETS,
  MAX_PENDING,
  LIST_TIMEOUT_MS,
  CALL_TIMEOUT_MS,
  MAX_FILES,
  MAX_FILE_BYTES_PER_CALL,
  MAX_BYTES_IN_FLIGHT,
  TICKET_EXTS,
  ticketExtOk,
  copyAllowed,
  TICKET_TTL_MS,
  MAX_TICKETS,
  ARM_TIMEOUT_MS,
  MAX_SAVED,
  PARSE_ERROR,
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  INVALID_PARAMS,
  SERVER_ERROR,
  MEDIA_EXTS,
  INSTRUCTIONS,
  negotiateVersion,
  versionHeaderOk,
  initializeResult,
  rpcResult,
  rpcError,
  textResult,
  classifyMessage,
  cleanConfig,
  portCandidates,
  hostAllowed,
  originAllowed,
  bearerToken,
  tokenMatches,
  jsonContentType,
  checkRequest,
  fileSpec,
  wantsTicket,
  checkFilePath,
  pathProblem,
  planFiles,
  withoutPathArg,
  cleanReply,
  savedItem,
  clipboardText,
  parseDownloadName,
  savedFileName,
  uniqueName,
};
