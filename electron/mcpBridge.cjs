'use strict';
/**
 * the stdio side of ncut's mcp server, for clients that only start a command (docs/MCP.md).
 * ncut writes this file next to its settings; it needs nothing but node 18+. it reads newline delimited json-rpc
 * from stdin, posts each message to the running ncut and writes each answer as one line on stdout, in the order
 * the messages came. nothing else ever goes to stdout (a client would choke on it): problems go to stderr.
 * the port and the token are read from mcp.json in this folder for every message, so a new token just works.
 */
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const CONFIG = path.join(__dirname, 'mcp.json');
const MAX_ANSWER_BYTES = 64 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 200 * 1000;
const NOT_RUNNING = 'ncut is not running or its mcp server is off';

function warn(text) {
  try {
    process.stderr.write(`ncut-mcp-bridge: ${text}\n`);
  } catch {
    /* nowhere to say it */
  }
}

/** { port, token } of a running server, or null */
function readConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
    if (!c || c.enabled !== true) return null;
    if (!Number.isInteger(c.port) || c.port < 1 || c.port > 65535) return null;
    if (typeof c.token !== 'string' || c.token === '') return null;
    return { port: c.port, token: c.token };
  } catch {
    return null;
  }
}

/** the id of a json-rpc request line, or undefined when it is a notification / not json */
function idOf(line) {
  try {
    const m = JSON.parse(line);
    if (m && typeof m === 'object' && !Array.isArray(m) && (typeof m.id === 'string' || typeof m.id === 'number')) return m.id;
  } catch {
    /* handled by the caller */
  }
  return undefined;
}

function rpcError(id, code, message) {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

/** one post. resolves { status, body } or { failed: true } */
function post(cfg, body) {
  return new Promise((resolve) => {
    let done = false;
    const end = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    const req = http.request(
      {
        host: '127.0.0.1',
        port: cfg.port,
        path: '/mcp',
        method: 'POST',
        agent: false,
        timeout: REQUEST_TIMEOUT_MS,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${cfg.token}`,
        },
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > MAX_ANSWER_BYTES) {
            req.destroy();
            end({ failed: true });
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => end({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', () => end({ failed: true }));
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => end({ failed: true }));
    req.end(body);
  });
}

/** the line to write for one input line, or null for nothing */
async function handleLine(line) {
  const id = idOf(line);
  const cfg = readConfig();
  const fallback = id === undefined ? null : rpcError(id, -32000, NOT_RUNNING);
  if (!cfg) {
    warn(NOT_RUNNING);
    return fallback;
  }
  const got = await post(cfg, line);
  if (got.failed) {
    warn(NOT_RUNNING);
    return fallback;
  }
  if (got.status === 202) return null;
  let parsed = null;
  try {
    parsed = JSON.parse(got.body);
  } catch {
    parsed = null;
  }
  const isRpc = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.jsonrpc === '2.0';
  if (got.status >= 200 && got.status < 300) {
    if (isRpc) return JSON.stringify(parsed);
    warn(`ncut answered something that is not json-rpc (http ${got.status})`);
    return id === undefined ? null : rpcError(id, -32000, 'ncut answered something that is not json-rpc');
  }
  // an http error: a json-rpc error body (bad json, bad version) is passed on as it is
  if (isRpc && parsed.error) return JSON.stringify(parsed);
  warn(`ncut answered http ${got.status}`);
  return id === undefined ? null : rpcError(id, -32000, `${NOT_RUNNING} (ncut answered http ${got.status}, the token may have changed)`);
}

function main() {
  // answers are written in the order of the requests, but the requests run side by side
  let out = Promise.resolve();
  let buffer = '';
  const take = (line) => {
    const text = line.trim();
    if (text === '') return;
    const job = handleLine(text).catch((e) => {
      warn(`failed: ${e && e.message ? e.message : 'error'}`);
      const id = idOf(text);
      return id === undefined ? null : rpcError(id, -32000, 'the ncut bridge failed');
    });
    out = out.then(() => job).then((answer) => {
      if (answer !== null) process.stdout.write(`${answer}\n`);
    });
  };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let at = buffer.indexOf('\n');
    while (at >= 0) {
      take(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
      at = buffer.indexOf('\n');
    }
  });
  process.stdin.on('end', () => {
    take(buffer);
    buffer = '';
    // the process ends by itself once the answers on their way are written
    void out;
  });
  process.stdout.on('error', () => process.exit(0));
}

main();
