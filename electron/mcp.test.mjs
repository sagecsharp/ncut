import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { createMcp } = require('./mcp.cjs');
const rules = require('./mcpRules.cjs');

const winOnly = process.platform === 'win32' ? it : it.skip;
const BRIDGE_TEXT = '// a fake bridge script\n';

/** a port nobody listens on right now */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** a raw http post / get: bad hosts and origins need headers fetch would not send */
/**
 * hold: the request is not ended and nothing is sent past what was asked for (the headers alone, or the chunks one
 * after the other), the answer is waited for. a server that refuses a body closes the connection, and a client that
 * is still pushing bytes into it then gets a reset instead of the answer every now and then (windows, a busy machine)
 */
function request(port, { method = 'POST', url = '/mcp', headers = {}, body, chunks, hold = false } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      if (hold) req.destroy();
      resolve(v);
    };
    const req = http.request({ host: '127.0.0.1', port, path: url, method, headers, agent: false }, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      const finish = () => done({ status: res.statusCode, headers: res.headers, text: Buffer.concat(parts).toString('utf8') });
      res.on('end', finish);
      res.on('close', finish);
    });
    req.on('error', (e) => {
      if (!settled) {
        settled = true;
        reject(e);
      }
    });
    if (hold) {
      if (!chunks) {
        req.flushHeaders();
        return;
      }
      (async () => {
        for (const c of chunks) {
          if (settled) return;
          await new Promise((next) => req.write(c, () => next()));
        }
      })();
    } else if (chunks) {
      for (const c of chunks) req.write(c);
      req.end();
    } else {
      req.end(body);
    }
  });
}

const contexts = [];

/** a server in a temp user data dir with a fake page */
async function setup(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncut-mcp-test-'));
  const saveDir = path.join(dir, 'saves');
  fs.mkdirSync(saveDir);
  const first = options.first ?? (await freePort());
  const ctx = {
    dir,
    saveDir,
    calls: [],
    clip: [],
    logs: [],
    saved: [],
    ready: true,
    /** the page: json text for a call, or undefined for no answer */
    answer: (call) => {
      if (call.kind === 'list') return JSON.stringify({ tools: [{ name: 'get_state', title: 'state', description: 'd', inputSchema: { type: 'object' } }] });
      return JSON.stringify({ content: [{ type: 'text', text: `ran ${call.name}` }] });
    },
  };
  ctx.mcp = createMcp({
    userDataDir: dir,
    appVersion: '9.9.9',
    bridgeSource: BRIDGE_TEXT,
    sendCall(call) {
      if (!ctx.ready) return false;
      ctx.calls.push(call);
      setImmediate(() => {
        const json = ctx.answer(call);
        if (json !== undefined) ctx.mcp.reply(call.id, json);
      });
      return true;
    },
    writeClipboard: (t) => ctx.clip.push(t),
    saveFolder: () => options.saveFolder ?? saveDir,
    onSaved: (file) => ctx.saved.push(file),
    log: (m) => ctx.logs.push(m),
    timing: options.timing,
    limits: options.limits,
    ports: { first, tries: options.tries ?? 5 },
  });
  contexts.push(ctx);
  ctx.config = () => JSON.parse(fs.readFileSync(path.join(dir, 'mcp.json'), 'utf8'));
  /** post one json-rpc message with the current token */
  ctx.rpc = async (message, extra = {}) => {
    const st = ctx.mcp.state();
    const token = extra.token ?? ctx.config().token;
    const text = typeof message === 'string' ? message : JSON.stringify(message);
    const res = await request(st.port, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(extra.headers ?? {}) },
      body: text,
    });
    return { ...res, json: res.text ? JSON.parse(res.text) : null };
  };
  ctx.call = (name, args = {}, id = 1) => ctx.rpc({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
  if (options.on !== false) {
    await ctx.mcp.setEnabled(true);
  }
  return ctx;
}

afterEach(async () => {
  while (contexts.length) {
    const ctx = contexts.pop();
    await ctx.mcp.dispose();
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  }
});

describe('on and off', () => {
  it('is off until asked, then listens on 127.0.0.1 and keeps its settings', async () => {
    const ctx = await setup({ on: false });
    expect(ctx.mcp.state()).toEqual({ enabled: false, running: false, port: 0, error: null, bridge: false });
    const state = await ctx.mcp.setEnabled(true);
    expect(state.enabled).toBe(true);
    expect(state.running).toBe(true);
    expect(state.port).toBeGreaterThan(1023);
    expect(state.error).toBeNull();
    expect(state.bridge).toBe(true);
    const saved = ctx.config();
    expect(saved.enabled).toBe(true);
    expect(saved.port).toBe(state.port);
    expect(saved.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // the page never learns the token
    expect(JSON.stringify(state)).not.toContain(saved.token);
    // nothing half written is left behind
    expect(fs.readdirSync(ctx.dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    expect(fs.readFileSync(path.join(ctx.dir, 'mcp-bridge.cjs'), 'utf8')).toBe(BRIDGE_TEXT);
  });

  it('only listens on the loopback address', async () => {
    const ctx = await setup();
    const { port } = ctx.mcp.state();
    const lan = Object.values(os.networkInterfaces())
      .flat()
      .find((i) => i && i.family === 'IPv4' && !i.internal);
    // another address of this machine must not reach it (nothing to check on a machine without one)
    if (lan) {
      await expect(
        new Promise((resolve, reject) => {
          const s = net.connect({ host: lan.address, port, timeout: 2000 }, () => {
            s.destroy();
            resolve('connected');
          });
          s.on('error', reject);
          s.on('timeout', () => {
            s.destroy();
            reject(new Error('timeout'));
          });
        }),
      ).rejects.toThrow();
    }
    expect((await request(port, { method: 'GET' })).status).toBe(405);
  });

  it('starts by itself when mcp.json says enabled, with the same token and port', async () => {
    const first = await setup();
    const { port, token } = first.config();
    await first.mcp.dispose();
    const dir = first.dir;
    // a new object on the same folder
    const again = createMcp({ userDataDir: dir, appVersion: '1', bridgeSource: BRIDGE_TEXT, sendCall: () => false, writeClipboard: () => {}, saveFolder: () => dir, ports: { first: port, tries: 3 } });
    const state = await again.init();
    expect(state.running).toBe(true);
    expect(state.port).toBe(port);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'mcp.json'), 'utf8')).token).toBe(token);
    await again.dispose();
  });

  it('does not start when mcp.json says off, and survives a broken file', async () => {
    const ctx = await setup({ on: false });
    fs.writeFileSync(path.join(ctx.dir, 'mcp.json'), '{broken');
    const state = await ctx.mcp.init();
    expect(state.running).toBe(false);
    expect(state.enabled).toBe(false);
  });

  it('setEnabled(false) closes the port, on again opens one', async () => {
    const ctx = await setup();
    const { port } = ctx.mcp.state();
    const token = ctx.config().token;
    const off = await ctx.mcp.setEnabled(false);
    expect(off.running).toBe(false);
    expect(off.enabled).toBe(false);
    await expect(request(port, { headers: { 'Content-Type': 'application/json' }, body: '{}' })).rejects.toThrow();
    expect(ctx.config().enabled).toBe(false);
    const on = await ctx.mcp.setEnabled(true);
    expect(on.running).toBe(true);
    // the token survives an off and on
    expect(ctx.config().token).toBe(token);
    const res = await ctx.rpc({ jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(res.status).toBe(200);
  });

  it('quick on, off, on ends in the last wish', async () => {
    const ctx = await setup({ on: false });
    const a = ctx.mcp.setEnabled(true);
    const b = ctx.mcp.setEnabled(false);
    const c = ctx.mcp.setEnabled(true);
    await Promise.all([a, b, c]);
    expect(ctx.mcp.state().running).toBe(true);
    expect((await ctx.rpc({ jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(200);
  });

  it('a taken port moves on to another one and saves it', async () => {
    const taken = await freePort();
    const blocker = net.createServer();
    await new Promise((resolve) => blocker.listen(taken, '127.0.0.1', resolve));
    try {
      const ctx = await setup({ on: false, first: taken });
      const state = await ctx.mcp.setEnabled(true);
      expect(state.running).toBe(true);
      expect(state.port).not.toBe(taken);
      expect(ctx.config().port).toBe(state.port);
      // a saved port that is taken later moves on too
      await ctx.mcp.setEnabled(false);
      fs.writeFileSync(path.join(ctx.dir, 'mcp.json'), JSON.stringify({ enabled: true, port: taken, token: ctx.config().token }));
      const again = await ctx.mcp.init();
      expect(again.running).toBe(true);
      expect(again.port).not.toBe(taken);
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });

  it('falls back to any free port when every candidate is taken', async () => {
    const taken = await freePort();
    const blocker = net.createServer();
    await new Promise((resolve) => blocker.listen(taken, '127.0.0.1', resolve));
    try {
      // every candidate taken: only the "any port" last resort is left, so it still runs
      const ctx = await setup({ first: taken, tries: 1 });
      expect(ctx.mcp.state().running).toBe(true);
      expect(ctx.mcp.state().port).not.toBe(taken);
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });

  it('tells listeners about every change', async () => {
    const ctx = await setup({ on: false });
    const seen = [];
    const off = ctx.mcp.onChange((s) => seen.push(s));
    await ctx.mcp.setEnabled(true);
    await ctx.mcp.rotate();
    await ctx.mcp.setEnabled(false);
    expect(seen.map((s) => s.running)).toEqual([true, true, false]);
    off();
    await ctx.mcp.setEnabled(true);
    expect(seen).toHaveLength(3);
  });

  it('a listener that throws does not break anything', async () => {
    const ctx = await setup({ on: false });
    ctx.mcp.onChange(() => {
      throw new Error('boom');
    });
    const state = await ctx.mcp.setEnabled(true);
    expect(state.running).toBe(true);
  });
});

describe('the http rules', () => {
  it('404 for another path', async () => {
    const ctx = await setup();
    const { port } = ctx.mcp.state();
    for (const url of ['/', '/mcp/', '/other']) {
      const res = await request(port, { url, headers: { 'Content-Type': 'application/json' }, body: '{}' });
      expect(res.status).toBe(404);
    }
  });

  it('405 for GET and others, with Allow', async () => {
    const ctx = await setup();
    const { port } = ctx.mcp.state();
    for (const method of ['GET', 'PUT', 'DELETE', 'OPTIONS']) {
      const res = await request(port, { method });
      expect(res.status).toBe(405);
      expect(res.headers.allow).toBe('POST');
    }
  });

  it('403 for a wrong Host, even with the token', async () => {
    const ctx = await setup();
    const { port } = ctx.mcp.state();
    const token = ctx.config().token;
    for (const host of ['evil.com', `evil.com:${port}`, `127.0.0.1:${port + 1}`, '127.0.0.1']) {
      const res = await request(port, { headers: { Host: host, 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: '{}' });
      expect(res.status, host).toBe(403);
    }
    // localhost is fine
    const ok = await request(port, {
      headers: { Host: `localhost:${port}`, 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    expect(ok.status).toBe(200);
  });

  it('403 for an Origin header, even with the token', async () => {
    const ctx = await setup();
    const res = await ctx.rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { headers: { Origin: `http://127.0.0.1:${ctx.mcp.state().port}` } });
    expect(res.status).toBe(403);
    const none = await ctx.rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { headers: { Origin: 'null' } });
    expect(none.status).toBe(403);
    expect(ctx.calls).toHaveLength(0);
  });

  it('401 without a token or with a wrong one', async () => {
    const ctx = await setup();
    const { port } = ctx.mcp.state();
    const none = await request(port, { headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(none.status).toBe(401);
    expect(none.headers['www-authenticate']).toBe('Bearer');
    const wrong = await ctx.rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { token: 'x'.repeat(43) });
    expect(wrong.status).toBe(401);
    const basic = await request(port, { headers: { 'Content-Type': 'application/json', Authorization: `Basic ${ctx.config().token}` }, body: '{}' });
    expect(basic.status).toBe(401);
  });

  it('415 for another content type', async () => {
    const ctx = await setup();
    const res = await ctx.rpc('{}', { headers: { 'Content-Type': 'text/plain' } });
    expect(res.status).toBe(415);
  });

  it('413 for a body over 1 MiB, declared or streamed', async () => {
    const ctx = await setup();
    const { port } = ctx.mcp.state();
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.config().token}` };
    // a length over the cap is refused from the headers alone, before a byte of the body
    const declared = await request(port, { headers: { ...headers, 'Content-Length': String(rules.MAX_BODY_BYTES + 10) }, hold: true });
    expect(declared.status).toBe(413);
    // no length given: the server stops reading at the cap. just enough to cross it, then the answer is waited for
    const piece = 32 * 1024;
    const parts = [];
    for (let i = 0; i < Math.floor(rules.MAX_BODY_BYTES / piece) + 1; i++) parts.push(Buffer.alloc(piece, 0x20));
    const streamed = await request(port, { headers, chunks: parts, hold: true });
    expect(streamed.status).toBe(413);
    // a body just under the cap is read
    const pad = ' '.repeat(rules.MAX_BODY_BYTES - 100);
    const ok = await request(port, { headers, body: `{"jsonrpc":"2.0","id":1,"method":"ping"}${pad}` });
    expect(ok.status).toBe(200);
  });

  it('400 -32700 for bad json, 400 -32600 for a batch or a wrong shape', async () => {
    const ctx = await setup();
    const bad = await ctx.rpc('{nope');
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe(-32700);
    const batch = await ctx.rpc([{ jsonrpc: '2.0', id: 1, method: 'ping' }]);
    expect(batch.status).toBe(400);
    expect(batch.json.error.code).toBe(-32600);
    const shape = await ctx.rpc({ hello: 'world' });
    expect(shape.status).toBe(400);
    expect(shape.json.error.code).toBe(-32600);
    const noVersion = await ctx.rpc({ id: 1, method: 'ping' });
    expect(noVersion.status).toBe(400);
  });

  it('400 for an unknown MCP-Protocol-Version', async () => {
    const ctx = await setup();
    const res = await ctx.rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { headers: { 'MCP-Protocol-Version': '1999-01-01' } });
    expect(res.status).toBe(400);
    const good = await ctx.rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { headers: { 'MCP-Protocol-Version': '2025-03-26' } });
    expect(good.status).toBe(200);
  });

  it('the headers of every answer', async () => {
    const ctx = await setup();
    const res = await ctx.rpc({ jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-type']).toContain('application/json');
    expect(Object.keys(res.headers).filter((k) => k.startsWith('access-control'))).toEqual([]);
    const refused = await request(ctx.mcp.state().port, { method: 'GET' });
    expect(Object.keys(refused.headers).filter((k) => k.startsWith('access-control'))).toEqual([]);
    expect(refused.headers['cache-control']).toBe('no-store');
  });

  it('never logs the token or a body', async () => {
    const ctx = await setup();
    await ctx.rpc('{secret-body-text');
    await ctx.call('get_state', {}, 2);
    const token = ctx.config().token;
    for (const line of ctx.logs) {
      expect(line).not.toContain(token);
      expect(line).not.toContain('secret-body-text');
    }
  });
});

describe('the methods', () => {
  it('initialize answers a known version as asked', async () => {
    const ctx = await setup();
    for (const v of rules.PROTOCOLS) {
      const res = await ctx.rpc({ jsonrpc: '2.0', id: 'i', method: 'initialize', params: { protocolVersion: v, capabilities: {}, clientInfo: { name: 't', version: '1' } } });
      expect(res.status).toBe(200);
      expect(res.json.id).toBe('i');
      expect(res.json.result.protocolVersion).toBe(v);
      expect(res.json.result.serverInfo).toEqual({ name: 'ncut', title: 'ncut', version: '9.9.9' });
      expect(res.json.result.capabilities).toEqual({ tools: { listChanged: false } });
      expect(res.json.result.instructions).toContain('get_state');
    }
  });

  it('initialize answers the newest version for an unknown one', async () => {
    const ctx = await setup();
    const res = await ctx.rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2030-01-01' } });
    expect(res.json.result.protocolVersion).toBe('2025-06-18');
    const none = await ctx.rpc({ jsonrpc: '2.0', id: 2, method: 'initialize' });
    expect(none.json.result.protocolVersion).toBe('2025-06-18');
  });

  it('ping answers an empty result, without asking the page', async () => {
    const ctx = await setup();
    const res = await ctx.rpc({ jsonrpc: '2.0', id: 4, method: 'ping' });
    expect(res.json).toEqual({ jsonrpc: '2.0', id: 4, result: {} });
    expect(ctx.calls).toHaveLength(0);
  });

  it('a notification and a response get 202 with no body', async () => {
    const ctx = await setup();
    const note = await ctx.rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(note.status).toBe(202);
    expect(note.text).toBe('');
    const resp = await ctx.rpc({ jsonrpc: '2.0', id: 1, result: {} });
    expect(resp.status).toBe(202);
  });

  it('another method is -32601', async () => {
    const ctx = await setup();
    const res = await ctx.rpc({ jsonrpc: '2.0', id: 1, method: 'resources/list' });
    expect(res.status).toBe(200);
    expect(res.json.error.code).toBe(-32601);
  });

  it('tools/list is relayed to the page', async () => {
    const ctx = await setup();
    const res = await ctx.rpc({ jsonrpc: '2.0', id: 9, method: 'tools/list' });
    expect(res.status).toBe(200);
    expect(res.json.id).toBe(9);
    expect(res.json.result.tools.map((t) => t.name)).toEqual(['get_state']);
    expect(ctx.calls[0]).toMatchObject({ kind: 'list', ticket: null, files: [] });
    expect(typeof ctx.calls[0].id).toBe('number');
  });

  it('tools/call is relayed with name and arguments', async () => {
    const ctx = await setup();
    const res = await ctx.call('seek', { time: 2.5 }, 'abc');
    expect(res.json).toEqual({ jsonrpc: '2.0', id: 'abc', result: { content: [{ type: 'text', text: 'ran seek' }] } });
    expect(ctx.calls[0]).toMatchObject({ kind: 'call', name: 'seek', args: { time: 2.5 }, files: [], ticket: null });
  });

  it('the cursor argument is relayed as it came: main does not look at it, the page decides', async () => {
    const ctx = await setup();
    // a name the page would refuse and one it would take: both reach the page untouched
    await ctx.call('seek', { time: 1, cursor: 'sub agent 2' }, 1);
    await ctx.call('seek', { time: 1, cursor: 'x'.repeat(40) }, 2);
    await ctx.call('seek', { time: 1, cursor: 5 }, 3);
    expect(ctx.calls[0].args).toEqual({ time: 1, cursor: 'sub agent 2' });
    expect(ctx.calls[1].args).toEqual({ time: 1, cursor: 'x'.repeat(40) });
    expect(ctx.calls[2].args).toEqual({ time: 1, cursor: 5 });
  });

  it('a call without arguments gets {}, bad params are -32602', async () => {
    const ctx = await setup();
    await ctx.rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_state' } });
    expect(ctx.calls[0].args).toEqual({});
    for (const params of [{}, { name: 5 }, { name: '' }, { name: 'a b' }, { name: 'x'.repeat(200) }, { name: 'ok', arguments: [] }, { name: 'ok', arguments: 'x' }, { name: 'ok', arguments: null }]) {
      const res = await ctx.rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params });
      expect(res.json.error.code, JSON.stringify(params)).toBe(-32602);
    }
    expect(ctx.calls).toHaveLength(1);
  });

  it('the page saying "no such tool" is -32602', async () => {
    const ctx = await setup();
    ctx.answer = () => JSON.stringify({ unknown: true });
    const res = await ctx.call('nope');
    expect(res.json.error.code).toBe(-32602);
    expect(res.json.error.message).toContain('nope');
  });

  it('isError and images come through, other fields do not', async () => {
    const ctx = await setup();
    ctx.answer = () => JSON.stringify({ content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png', x: 1 }, { type: 'text', text: 'bad' }], isError: true, junk: 1 });
    const res = await ctx.call('render_frame');
    expect(res.json.result).toEqual({ content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }, { type: 'text', text: 'bad' }], isError: true });
  });

  it('an answer the page should not send becomes an error result', async () => {
    const ctx = await setup();
    ctx.answer = () => 'not json';
    const res = await ctx.call('get_state');
    expect(res.json.result.isError).toBe(true);
    ctx.answer = () => JSON.stringify({ content: 'x' });
    expect((await ctx.call('get_state', {}, 2)).json.result.isError).toBe(true);
    ctx.answer = (c) => (c.kind === 'list' ? JSON.stringify({ nope: 1 }) : undefined);
    expect((await ctx.rpc({ jsonrpc: '2.0', id: 3, method: 'tools/list' })).json.error.code).toBe(-32000);
  });

  it('an answer over the cap is dropped', async () => {
    const ctx = await setup();
    ctx.answer = () => `{"content":[{"type":"text","text":"${'x'.repeat(rules.MAX_REPLY_CHARS)}"}]}`;
    const res = await ctx.call('get_state');
    expect(res.json.result.isError).toBe(true);
  });

  it('a reply for an id nobody waits for is ignored', async () => {
    const ctx = await setup();
    ctx.mcp.reply(99999, '{"content":[]}');
    ctx.mcp.reply('x', '{}');
    ctx.mcp.reply(1.5, '{}');
    ctx.mcp.reply(NaN, '{}');
    ctx.mcp.reply(undefined, undefined);
    expect((await ctx.rpc({ jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(200);
  });

  it('a second reply to the same call changes nothing', async () => {
    const ctx = await setup();
    ctx.answer = (call) => {
      // the page answers twice
      setImmediate(() => ctx.mcp.reply(call.id, JSON.stringify({ content: [{ type: 'text', text: 'second' }] })));
      return JSON.stringify({ content: [{ type: 'text', text: 'first' }] });
    };
    const res = await ctx.call('get_state');
    expect(res.json.result.content[0].text).toBe('first');
  });
});

describe('the page is not there or slow', () => {
  it('no ready window: a tool result that says ncut is starting', async () => {
    const ctx = await setup();
    ctx.ready = false;
    const res = await ctx.call('get_state');
    expect(res.status).toBe(200);
    expect(res.json.result.isError).toBe(true);
    expect(res.json.result.content[0].text).toContain('starting');
    const list = await ctx.rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(list.json.error.code).toBe(-32000);
    // ping and initialize work without a page
    expect((await ctx.rpc({ jsonrpc: '2.0', id: 3, method: 'ping' })).json.result).toEqual({});
  });

  it('a send that throws counts as no window', async () => {
    const ctx = await setup({ on: false });
    const other = createMcp({
      userDataDir: ctx.dir,
      appVersion: '1',
      bridgeSource: BRIDGE_TEXT,
      sendCall: () => {
        throw new Error('window gone');
      },
      writeClipboard: () => {},
      saveFolder: () => ctx.dir,
      ports: { first: await freePort(), tries: 2 },
    });
    await other.setEnabled(true);
    const cfg = JSON.parse(fs.readFileSync(path.join(ctx.dir, 'mcp.json'), 'utf8'));
    const res = await request(other.state().port, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'x' } }),
    });
    expect(JSON.parse(res.text).result.isError).toBe(true);
    await other.dispose();
  });

  it('a call that gets no answer ends with an error result after the timeout', async () => {
    const ctx = await setup({ timing: { call: 60, list: 60 } });
    ctx.answer = () => undefined;
    const res = await ctx.call('get_state');
    expect(res.json.result.isError).toBe(true);
    expect(res.json.result.content[0].text).toContain('get_state');
    const list = await ctx.rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(list.json.error.code).toBe(-32000);
    // a late answer is ignored and the server still works
    ctx.mcp.reply(ctx.calls[0].id, '{"content":[]}');
    ctx.answer = undefined;
    ctx.answer = () => JSON.stringify({ content: [] });
    expect((await ctx.call('get_state', {}, 3)).json.result.content).toEqual([]);
  });

  it('at most 8 calls wait, the 9th is -32000', async () => {
    const ctx = await setup({ timing: { call: 5000 } });
    ctx.answer = () => undefined;
    const waiting = [];
    for (let i = 0; i < 8; i++) waiting.push(ctx.call('get_state', {}, i));
    for (let i = 0; i < 100 && ctx.calls.length < 8; i++) await new Promise((r) => setTimeout(r, 10));
    expect(ctx.calls).toHaveLength(8);
    const ninth = await ctx.call('get_state', {}, 'nine');
    expect(ninth.json.error.code).toBe(-32000);
    for (const c of ctx.calls) ctx.mcp.reply(c.id, JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }));
    const done = await Promise.all(waiting);
    expect(done.every((r) => r.json.result.content[0].text === 'ok')).toBe(true);
    // the slots are free again
    ctx.answer = () => JSON.stringify({ content: [] });
    expect((await ctx.call('get_state', {}, 'again')).json.result).toBeDefined();
  });

  it('turning the server off while a call waits does not hang or crash', async () => {
    const ctx = await setup({ timing: { call: 5000 } });
    ctx.answer = () => undefined;
    const pendingCall = ctx.call('get_state').catch((e) => e);
    for (let i = 0; i < 100 && ctx.calls.length < 1; i++) await new Promise((r) => setTimeout(r, 10));
    await ctx.mcp.setEnabled(false);
    await pendingCall;
    expect(ctx.mcp.state().running).toBe(false);
  });
});

describe('the token', () => {
  it('rotate makes the old token useless and the new one work', async () => {
    const ctx = await setup();
    const oldToken = ctx.config().token;
    const state = await ctx.mcp.rotate();
    const newToken = ctx.config().token;
    expect(newToken).not.toBe(oldToken);
    expect(state.running).toBe(true);
    expect(JSON.stringify(state)).not.toContain(newToken);
    expect((await ctx.rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { token: oldToken })).status).toBe(401);
    expect((await ctx.rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { token: newToken })).status).toBe(200);
  });

  it('copies the connect texts through the clipboard', async () => {
    const ctx = await setup();
    const { port } = ctx.mcp.state();
    const token = ctx.config().token;
    expect(ctx.mcp.copy('claude')).toBe(true);
    expect(ctx.clip[0]).toBe(`claude mcp add --transport http ncut http://127.0.0.1:${port}/mcp --header "Authorization: Bearer ${token}"`);
    expect(ctx.mcp.copy('http')).toBe(true);
    expect(JSON.parse(ctx.clip[1]).mcpServers.ncut.url).toBe(`http://127.0.0.1:${port}/mcp`);
    expect(ctx.mcp.copy('stdio')).toBe(true);
    expect(ctx.clip[2]).not.toContain(token);
    expect(JSON.parse(ctx.clip[2]).mcpServers.ncut.args[0]).toBe(path.join(ctx.dir, 'mcp-bridge.cjs'));
    expect(ctx.mcp.copy('other')).toBe(false);
    expect(ctx.mcp.copy(undefined)).toBe(false);
    expect(ctx.clip).toHaveLength(3);
  });

  it('copies nothing while the server is off', async () => {
    const ctx = await setup({ on: false });
    expect(ctx.mcp.copy('claude')).toBe(false);
    await ctx.mcp.setEnabled(true);
    await ctx.mcp.setEnabled(false);
    expect(ctx.mcp.copy('claude')).toBe(false);
    expect(ctx.clip).toEqual([]);
  });

  it('a clipboard that throws gives false', async () => {
    const ctx = await setup();
    const other = createMcp({
      userDataDir: ctx.dir,
      appVersion: '1',
      bridgeSource: BRIDGE_TEXT,
      sendCall: () => false,
      writeClipboard: () => {
        throw new Error('no clipboard');
      },
      saveFolder: () => ctx.dir,
      ports: { first: await freePort(), tries: 2 },
    });
    await other.setEnabled(true);
    expect(other.copy('claude')).toBe(false);
    await other.dispose();
  });
});

describe('files a tool needs', () => {
  let file;
  const bytes = Buffer.from('not really a video, but bytes');

  function tmpFile(ctx, name, content = bytes) {
    file = path.join(ctx.dir, name);
    fs.writeFileSync(file, content);
    return file;
  }

  winOnly('import_media reads the file, drops the argument and passes name and bytes', async () => {
    const ctx = await setup();
    const p = tmpFile(ctx, 'a.mp4');
    const res = await ctx.call('import_media', { paths: [p] });
    expect(res.json.result.isError).toBeUndefined();
    const call = ctx.calls[0];
    expect(call.args).toEqual({});
    expect(call.files).toHaveLength(1);
    expect(call.files[0].name).toBe('a.mp4');
    expect(Buffer.from(call.files[0].bytes).equals(bytes)).toBe(true);
    expect(JSON.stringify(call.args)).not.toContain(ctx.dir.replace(/\\/g, '\\\\'));
  });

  winOnly('forward slashes and several files work, other arguments stay', async () => {
    const ctx = await setup();
    const a = tmpFile(ctx, 'a.png', Buffer.from('1')).replace(/\\/g, '/');
    const b = tmpFile(ctx, 'b.wav', Buffer.from('22'));
    await ctx.call('import_media', { paths: [a, b], extra: 5 });
    expect(ctx.calls[0].args).toEqual({ extra: 5 });
    expect(ctx.calls[0].files.map((f) => f.name)).toEqual(['a.png', 'b.wav']);
  });

  winOnly('import_project takes one .ncut file', async () => {
    const ctx = await setup();
    const p = tmpFile(ctx, 'p.ncut', Buffer.from('{}'));
    await ctx.call('import_project', { path: p });
    expect(ctx.calls[0].args).toEqual({});
    expect(ctx.calls[0].files[0].name).toBe('p.ncut');
    const wrong = await ctx.call('import_project', { path: tmpFile(ctx, 'q.mp4') }, 2);
    expect(wrong.json.result.isError).toBe(true);
    expect(ctx.calls).toHaveLength(1);
  });

  it('a bad path is a tool result naming the path, the page is not asked', async () => {
    const ctx = await setup();
    for (const p of ['relative\\a.mp4', '\\\\server\\share\\a.mp4', '\\\\?\\C:\\a.mp4', 'C:\\a.exe', 'C:\\nul', 'C:\\a.mp4:evil']) {
      const res = await ctx.call('import_media', { paths: [p] });
      expect(res.status).toBe(200);
      expect(res.json.result.isError, p).toBe(true);
      expect(res.json.result.content[0].text).toContain('cannot use the path');
    }
    const many = await ctx.call('import_media', { paths: Array.from({ length: 17 }, (_, i) => `C:\\a${i}.mp4`) });
    expect(many.json.result.isError).toBe(true);
    const none = await ctx.call('import_media', {});
    expect(none.json.result.isError).toBe(true);
    expect(ctx.calls).toHaveLength(0);
  });

  winOnly('a missing file and a folder are refused with a reason', async () => {
    const ctx = await setup();
    const missing = path.join(ctx.dir, 'gone.mp4');
    const res = await ctx.call('import_media', { paths: [missing] });
    expect(res.json.result.isError).toBe(true);
    expect(res.json.result.content[0].text).toContain('does not exist');
    const folder = path.join(ctx.dir, 'folder.mp4');
    fs.mkdirSync(folder);
    const asFolder = await ctx.call('import_media', { paths: [folder] }, 2);
    expect(asFolder.json.result.isError).toBe(true);
    expect(asFolder.json.result.content[0].text).toContain('not a plain file');
    expect(ctx.calls).toHaveLength(0);
  });

  winOnly('one bad path among good ones refuses the whole call', async () => {
    const ctx = await setup();
    const good = tmpFile(ctx, 'ok.mp4');
    const res = await ctx.call('import_media', { paths: [good, path.join(ctx.dir, 'gone.mp4')] });
    expect(res.json.result.isError).toBe(true);
    expect(ctx.calls).toHaveLength(0);
  });

  it('other tools never get files and keep their arguments', async () => {
    const ctx = await setup();
    await ctx.call('add_text', { paths: ['C:\\x.mp4'], text: 'hi' });
    expect(ctx.calls[0].files).toEqual([]);
    expect(ctx.calls[0].args).toEqual({ paths: ['C:\\x.mp4'], text: 'hi' });
  });
});

/** a download item like electron's */
function fakeItem(name) {
  const item = new EventEmitter();
  item.cancelled = false;
  item.savePath = null;
  item.getFilename = () => name;
  item.setSavePath = (p) => {
    item.savePath = p;
  };
  item.cancel = () => {
    item.cancelled = true;
  };
  return item;
}

describe('files a tool makes', () => {
  /** start an export call and return its ticket */
  async function exportTicket(ctx, id = 1) {
    const before = ctx.calls.length;
    const res = await ctx.call('export_video', {}, id);
    expect(res.status).toBe(200);
    const call = ctx.calls[before];
    expect(typeof call.ticket).toBe('number');
    expect(call.ticket).toBe(call.id);
    return call.ticket;
  }

  it('only export_video gets a ticket', async () => {
    const ctx = await setup();
    for (const name of ['get_state', 'export_status', 'import_media', 'export_cancel']) await ctx.call(name, {});
    expect(ctx.calls.filter((c) => c.name !== 'import_media').map((c) => c.ticket)).toEqual([null, null, null]);
    const t = await exportTicket(ctx);
    // a ticket the shell never gave is not armed
    expect(await ctx.mcp.armSave(t + 1000)).toEqual({ ok: false, name: null });
    expect(await ctx.mcp.armSave(ctx.calls[0].id)).toEqual({ ok: false, name: null });
  });

  it('arm, download, done: saved into the save folder under the clean name', async () => {
    const ctx = await setup();
    const ticket = await exportTicket(ctx);
    const armed = ctx.mcp.armSave(ticket);
    const item = fakeItem(`ncut-mcp-${ticket}-my:video.mp4`);
    expect(ctx.mcp.claimDownload(item)).toBe(true);
    expect(item.cancelled).toBe(false);
    expect(path.dirname(item.savePath)).toBe(ctx.saveDir);
    expect(path.basename(item.savePath)).toBe('my_video.mp4');
    fs.writeFileSync(item.savePath, 'data');
    item.emit('done', {}, 'completed');
    expect(await armed).toEqual({ ok: true, name: 'my_video.mp4' });
    expect(ctx.saved).toEqual([item.savePath]);
  });

  it('a later answer with saved: <ticket> carries the full path', async () => {
    const ctx = await setup();
    const ticket = await exportTicket(ctx);
    const armed = ctx.mcp.armSave(ticket);
    const item = fakeItem(`ncut-mcp-${ticket}-out.mp4`);
    ctx.mcp.claimDownload(item);
    fs.writeFileSync(item.savePath, 'x');
    item.emit('done', {}, 'completed');
    await armed;
    ctx.answer = () => JSON.stringify({ content: [{ type: 'text', text: 'done' }], saved: ticket });
    const res = await ctx.call('export_status', {}, 5);
    expect(res.json.result.content).toEqual([
      { type: 'text', text: 'done' },
      { type: 'text', text: `saved to ${item.savePath}` },
    ]);
    // a ticket that saved nothing adds nothing
    ctx.answer = () => JSON.stringify({ content: [{ type: 'text', text: 'done' }], saved: ticket + 777 });
    expect((await ctx.call('export_status', {}, 6)).json.result.content).toHaveLength(1);
  });

  it('never over an existing file: (2), (3)', async () => {
    const ctx = await setup();
    const names = [];
    for (let i = 0; i < 3; i++) {
      const ticket = await exportTicket(ctx, i + 1);
      const armed = ctx.mcp.armSave(ticket);
      const item = fakeItem(`ncut-mcp-${ticket}-same.mp4`);
      ctx.mcp.claimDownload(item);
      fs.writeFileSync(item.savePath, `file ${i}`);
      item.emit('done', {}, 'completed');
      names.push((await armed).name);
    }
    expect(names).toEqual(['same.mp4', 'same (2).mp4', 'same (3).mp4']);
    expect(fs.readFileSync(path.join(ctx.saveDir, 'same.mp4'), 'utf8')).toBe('file 0');
  });

  it('a ticket works once', async () => {
    const ctx = await setup();
    const ticket = await exportTicket(ctx);
    const armed = ctx.mcp.armSave(ticket);
    const first = fakeItem(`ncut-mcp-${ticket}-a.mp4`);
    ctx.mcp.claimDownload(first);
    first.emit('done', {}, 'completed');
    await armed;
    const second = fakeItem(`ncut-mcp-${ticket}-b.mp4`);
    expect(ctx.mcp.claimDownload(second)).toBe(true);
    expect(second.cancelled).toBe(true);
    expect(second.savePath).toBeNull();
    expect(await ctx.mcp.armSave(ticket)).toEqual({ ok: false, name: null });
  });

  it('a marked download without an armed ticket is cancelled', async () => {
    const ctx = await setup();
    const ticket = await exportTicket(ctx);
    // given but not armed
    const item = fakeItem(`ncut-mcp-${ticket}-a.mp4`);
    expect(ctx.mcp.claimDownload(item)).toBe(true);
    expect(item.cancelled).toBe(true);
    expect(item.savePath).toBeNull();
    // never given
    const stranger = fakeItem('ncut-mcp-424242-a.mp4');
    expect(ctx.mcp.claimDownload(stranger)).toBe(true);
    expect(stranger.cancelled).toBe(true);
    expect(fs.readdirSync(ctx.saveDir)).toEqual([]);
  });

  it('a normal download is not ours', async () => {
    const ctx = await setup();
    const item = fakeItem('video.mp4');
    expect(ctx.mcp.claimDownload(item)).toBe(false);
    expect(item.cancelled).toBe(false);
    expect(item.savePath).toBeNull();
    const broken = { getFilename: () => { throw new Error('x'); } };
    expect(ctx.mcp.claimDownload(broken)).toBe(false);
  });

  it('a download that fails resolves not ok and leaves no empty file', async () => {
    const ctx = await setup();
    const ticket = await exportTicket(ctx);
    const armed = ctx.mcp.armSave(ticket);
    const item = fakeItem(`ncut-mcp-${ticket}-a.mp4`);
    ctx.mcp.claimDownload(item);
    item.emit('done', {}, 'interrupted');
    expect(await armed).toEqual({ ok: false, name: null });
    expect(fs.readdirSync(ctx.saveDir)).toEqual([]);
    expect(ctx.saved).toEqual([]);
  });

  it('an armed ticket without a download resolves not ok after the wait', async () => {
    const ctx = await setup({ timing: { arm: 50 } });
    const ticket = await exportTicket(ctx);
    expect(await ctx.mcp.armSave(ticket)).toEqual({ ok: false, name: null });
    // the ticket is gone: a late download is cancelled
    const late = fakeItem(`ncut-mcp-${ticket}-a.mp4`);
    ctx.mcp.claimDownload(late);
    expect(late.cancelled).toBe(true);
  });

  it('a ticket arms once', async () => {
    const ctx = await setup({ timing: { arm: 5000 } });
    const ticket = await exportTicket(ctx);
    const first = ctx.mcp.armSave(ticket);
    expect(await ctx.mcp.armSave(ticket)).toEqual({ ok: false, name: null });
    const item = fakeItem(`ncut-mcp-${ticket}-a.mp4`);
    ctx.mcp.claimDownload(item);
    item.emit('done', {}, 'completed');
    expect((await first).ok).toBe(true);
  });

  it('a ticket lapses', async () => {
    const ctx = await setup({ timing: { ttl: 30 } });
    const ticket = await exportTicket(ctx);
    await new Promise((r) => setTimeout(r, 80));
    expect(await ctx.mcp.armSave(ticket)).toEqual({ ok: false, name: null });
    const item = fakeItem(`ncut-mcp-${ticket}-a.mp4`);
    ctx.mcp.claimDownload(item);
    expect(item.cancelled).toBe(true);
  });

  it('at most 8 tickets are open, the oldest goes first', async () => {
    const ctx = await setup({ timing: { arm: 5000 } });
    const tickets = [];
    for (let i = 0; i < 9; i++) tickets.push(await exportTicket(ctx, i + 1));
    expect(await ctx.mcp.armSave(tickets[0])).toEqual({ ok: false, name: null });
    const last = ctx.mcp.armSave(tickets[8]);
    const item = fakeItem(`ncut-mcp-${tickets[8]}-a.mp4`);
    ctx.mcp.claimDownload(item);
    item.emit('done', {}, 'completed');
    expect((await last).ok).toBe(true);
  });

  it('a bad ticket number is not ok', async () => {
    const ctx = await setup();
    for (const t of [undefined, null, 'x', NaN, 1.5, -1, {}]) expect(await ctx.mcp.armSave(t)).toEqual({ ok: false, name: null });
  });

  it('a name that tries to leave the folder stays in it', async () => {
    const ctx = await setup();
    const ticket = await exportTicket(ctx);
    const armed = ctx.mcp.armSave(ticket);
    const item = fakeItem(`ncut-mcp-${ticket}-..\\..\\evil.mp4`);
    ctx.mcp.claimDownload(item);
    expect(path.dirname(item.savePath)).toBe(ctx.saveDir);
    item.emit('done', {}, 'completed');
    expect((await armed).ok).toBe(true);
  });

  it('a save folder that fails cancels the download', async () => {
    const ctx = await setup({ on: false });
    const other = createMcp({
      userDataDir: ctx.dir,
      appVersion: '1',
      bridgeSource: BRIDGE_TEXT,
      sendCall: (c) => {
        setImmediate(() => other.reply(c.id, '{"content":[]}'));
        return true;
      },
      writeClipboard: () => {},
      saveFolder: () => path.join(ctx.dir, 'does', 'not', 'exist'),
      timing: { arm: 5000 },
      ports: { first: await freePort(), tries: 2 },
    });
    await other.setEnabled(true);
    const token = JSON.parse(fs.readFileSync(path.join(ctx.dir, 'mcp.json'), 'utf8')).token;
    let ticket = null;
    const sent = other;
    void sent;
    const res = await request(other.state().port, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'export_video', arguments: {} } }),
    });
    expect(res.status).toBe(200);
    // the ticket is the call id: the first call of a new object is 1
    ticket = 1;
    const armed = other.armSave(ticket);
    const item = fakeItem(`ncut-mcp-${ticket}-a.mp4`);
    expect(other.claimDownload(item)).toBe(true);
    expect(item.cancelled).toBe(true);
    expect(await armed).toEqual({ ok: false, name: null });
    await other.dispose();
  });
});

describe('dispose', () => {
  it('closes the port and drops everything, and never throws', async () => {
    const ctx = await setup();
    const { port } = ctx.mcp.state();
    await ctx.mcp.dispose();
    await expect(request(port, { method: 'GET' })).rejects.toThrow();
    // twice is fine, and nothing starts again
    await ctx.mcp.dispose();
    const state = await ctx.mcp.setEnabled(true);
    expect(state.running).toBe(false);
  });
});

describe('review fixes: security and shutdown', () => {
  const NOT_OK = { ok: false, name: null };

  async function exportTicket(ctx, id) {
    const before = ctx.calls.length;
    await ctx.call('export_video', {}, id);
    return ctx.calls[before].ticket;
  }

  async function waitFor(fn) {
    for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 10));
  }

  winOnly('a call that is reading files when the server is turned off never reaches the page', async () => {
    const ctx = await setup();
    const p = path.join(ctx.dir, 'a.png');
    fs.writeFileSync(p, 'x');
    const orig = fs.promises.readFile;
    let entered = false;
    let open;
    const gate = new Promise((r) => (open = r));
    fs.promises.readFile = async (...a) => {
      entered = true;
      await gate;
      return orig(...a);
    };
    try {
      const sent = ctx.call('import_media', { paths: [p] }).catch((e) => e);
      await waitFor(() => entered);
      await ctx.mcp.setEnabled(false);
      open();
      await sent;
      await new Promise((r) => setTimeout(r, 50));
      expect(ctx.calls).toEqual([]);
    } finally {
      fs.promises.readFile = orig;
    }
  });

  winOnly('the files of all calls share one budget, and it is free again when a call settles', async () => {
    const ctx = await setup({ timing: { call: 5000 }, limits: { inFlight: 100 } });
    const p = path.join(ctx.dir, 'a.png');
    fs.writeFileSync(p, Buffer.alloc(80));
    ctx.answer = () => undefined;
    const first = ctx.call('import_media', { paths: [p] }, 1);
    await waitFor(() => ctx.calls.length === 1);
    const second = await ctx.call('import_media', { paths: [p] }, 2);
    expect(second.json.result.isError).toBe(true);
    expect(second.json.result.content[0].text).toContain('other imports are still being read');
    expect(ctx.calls).toHaveLength(1);
    ctx.mcp.failPending();
    await first;
    ctx.answer = () => JSON.stringify({ content: [] });
    const third = await ctx.call('import_media', { paths: [p] }, 3);
    expect(third.json.result.isError).toBeUndefined();
  });

  it('a ticket download is only saved with an extension export_video makes', async () => {
    const ctx = await setup({ timing: { arm: 5000 } });
    for (const bad of ['evil.bat', 'evil.lnk', 'noext', 'a.mp4.exe']) {
      const t = await exportTicket(ctx, 1);
      const armed = ctx.mcp.armSave(t);
      const item = fakeItem(`ncut-mcp-${t}-${bad}`);
      expect(ctx.mcp.claimDownload(item)).toBe(true);
      expect(item.cancelled).toBe(true);
      expect(item.savePath).toBeNull();
      expect(await armed).toEqual(NOT_OK);
    }
    for (const good of ['a.MP4', 'b.webm', 'c.gif', 'd.wav', 'e.Ogg']) {
      const t = await exportTicket(ctx, 1);
      const armed = ctx.mcp.armSave(t);
      const item = fakeItem(`ncut-mcp-${t}-${good}`);
      ctx.mcp.claimDownload(item);
      expect(item.cancelled).toBe(false);
      fs.writeFileSync(item.savePath, 'x');
      item.emit('done', {}, 'completed');
      expect((await armed).ok).toBe(true);
    }
    expect(fs.readdirSync(ctx.saveDir).sort()).toEqual(['a.MP4', 'b.webm', 'c.gif', 'd.wav', 'e.Ogg']);
  });

  it('a save folder that cannot be used fails at once, naming the code and not the folder', async () => {
    const missing = path.join(os.tmpdir(), 'ncut-mcp-missing-folder', 'inner');
    const ctx = await setup({ saveFolder: missing, timing: { arm: 5000 } });
    const t = await exportTicket(ctx, 1);
    const armed = ctx.mcp.armSave(t);
    const orig = fs.openSync;
    let opens = 0;
    fs.openSync = (...a) => {
      if (String(a[0]).startsWith(missing)) opens++;
      return orig(...a);
    };
    const item = fakeItem(`ncut-mcp-${t}-a.mp4`);
    try {
      expect(ctx.mcp.claimDownload(item)).toBe(true);
    } finally {
      fs.openSync = orig;
    }
    expect(opens).toBe(1);
    expect(item.cancelled).toBe(true);
    expect(await armed).toEqual(NOT_OK);
    expect(ctx.logs.some((l) => l.includes('ENOENT'))).toBe(true);
    expect(ctx.logs.join('\n')).not.toContain('ncut-mcp-missing-folder');
  });

  it('a port that moved gets a new token', async () => {
    const ctx = await setup();
    const oldToken = ctx.config().token;
    const oldPort = ctx.mcp.state().port;
    await ctx.mcp.setEnabled(false);
    const blocker = net.createServer();
    await new Promise((resolve) => blocker.listen(oldPort, '127.0.0.1', resolve));
    try {
      const state = await ctx.mcp.setEnabled(true);
      expect(state.running).toBe(true);
      expect(state.port).not.toBe(oldPort);
      expect(ctx.config().token).not.toBe(oldToken);
      expect((await ctx.rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { token: oldToken })).status).toBe(401);
      expect((await ctx.rpc({ jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(200);
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });

  it('a port that did not move keeps its token', async () => {
    const ctx = await setup();
    const oldToken = ctx.config().token;
    await ctx.mcp.setEnabled(false);
    await ctx.mcp.setEnabled(true);
    expect(ctx.config().token).toBe(oldToken);
  });

  it('a reload fails the waiting calls at once: a call gets a tool result, a list the -32000 error', async () => {
    const ctx = await setup({ timing: { call: 5000, list: 5000 } });
    ctx.answer = () => undefined;
    const call = ctx.call('get_state', {}, 1);
    const list = ctx.rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    await waitFor(() => ctx.calls.length === 2);
    ctx.mcp.failPending();
    const [c, l] = await Promise.all([call, list]);
    expect(c.json.result.isError).toBe(true);
    expect(c.json.result.content[0].text).toBe('the ncut window was reloaded or closed while this ran');
    expect(l.json.error.code).toBe(rules.SERVER_ERROR);
    expect(l.json.error.message).toContain('reloaded or closed');
    // nothing waits any more: this is harmless
    ctx.mcp.failPending();
  });

  it('a ticket of a call that ended in an error and was never armed is dropped', async () => {
    const ctx = await setup({ timing: { arm: 5000 } });
    ctx.answer = () => JSON.stringify({ content: [{ type: 'text', text: 'an export is already running' }], isError: true });
    const t = await exportTicket(ctx, 1);
    expect(await ctx.mcp.armSave(t)).toEqual(NOT_OK);
    const item = fakeItem(`ncut-mcp-${t}-a.mp4`);
    ctx.mcp.claimDownload(item);
    expect(item.cancelled).toBe(true);
  });

  it('more tickets than fit push out the unarmed ones, not the running export', async () => {
    const ctx = await setup({ timing: { arm: 5000 } });
    const running = await exportTicket(ctx, 1);
    const armed = ctx.mcp.armSave(running);
    for (let i = 0; i < 12; i++) await exportTicket(ctx, i + 2);
    const item = fakeItem(`ncut-mcp-${running}-a.mp4`);
    ctx.mcp.claimDownload(item);
    expect(item.cancelled).toBe(false);
    fs.writeFileSync(item.savePath, 'x');
    item.emit('done', {}, 'completed');
    expect((await armed).ok).toBe(true);
  });

  it('a connection that trickles a header is closed within seconds', async () => {
    const ctx = await setup();
    const sock = net.connect(ctx.mcp.state().port, '127.0.0.1');
    sock.on('error', () => {});
    sock.resume();
    const closed = new Promise((resolve) => sock.on('close', () => resolve(Date.now())));
    await new Promise((r) => sock.on('connect', r));
    const t0 = Date.now();
    sock.write('POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\n');
    const t1 = await Promise.race([closed, new Promise((r) => setTimeout(() => r(-1), 9000))]);
    expect(t1).toBeGreaterThan(0);
    expect(t1 - t0).toBeLessThan(8000);
    sock.destroy();
  }, 15000);

  it('a normal client keeps its socket between requests', async () => {
    const ctx = await setup();
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const ports = [];
    const once = () =>
      new Promise((resolve, reject) => {
        const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
        const req = http.request(
          {
            host: '127.0.0.1',
            port: ctx.mcp.state().port,
            path: '/mcp',
            method: 'POST',
            agent,
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.config().token}`, 'Content-Length': Buffer.byteLength(body) },
          },
          (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode));
          },
        );
        req.on('socket', (s) => ports.push(s.localPort));
        req.on('error', reject);
        req.end(body);
      });
    try {
      expect(await once()).toBe(200);
      // idle for longer than the header timeout, shorter than the keep-alive one
      await new Promise((r) => setTimeout(r, 3600));
      expect(await once()).toBe(200);
      expect(ports[1]).toBe(ports[0]);
    } finally {
      agent.destroy();
    }
  }, 15000);
});
