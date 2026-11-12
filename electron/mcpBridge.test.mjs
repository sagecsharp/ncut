import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { createMcp } = require('./mcp.cjs');

const BRIDGE = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'mcpBridge.cjs'), 'utf8');

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

const cleanups = [];

/** the bridge script in a temp folder, next to the mcp.json a real server writes there */
async function setup({ server = true, delayList = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncut-bridge-test-'));
  const script = path.join(dir, 'mcp-bridge.cjs');
  fs.writeFileSync(script, BRIDGE);
  const calls = [];
  let mcp = null;
  if (server) {
    mcp = createMcp({
      userDataDir: dir,
      appVersion: '1.0.0',
      bridgeSource: BRIDGE,
      sendCall(call) {
        calls.push(call);
        setTimeout(() => mcp.reply(call.id, JSON.stringify(call.kind === 'list' ? { tools: [{ name: 'get_state' }] } : { content: [{ type: 'text', text: `ran ${call.name}` }] })), call.kind === 'list' ? delayList : 0);
        return true;
      },
      writeClipboard: () => {},
      saveFolder: () => dir,
      ports: { first: await freePort(), tries: 3 },
    });
    await mcp.setEnabled(true);
  }
  const ctx = { dir, mcp, calls };
  cleanups.push(async () => {
    if (mcp) await mcp.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  /** run the bridge with these input lines, resolve with the stdout lines, the stderr text and the exit code */
  ctx.run = (lines, { endAfter = true, between } = {}) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', (c) => (out += c));
      child.stderr.on('data', (c) => (err += c));
      child.on('error', reject);
      child.on('close', (code) => resolve({ lines: out.split('\n').filter((l) => l !== ''), raw: out, err, code }));
      /** resolves once the bridge has written n answer lines (a fixed pause is too short on a busy machine) */
      const answered = (n) =>
        new Promise((done) => {
          const tick = () => (out.split('\n').length - 1 >= n ? done() : setTimeout(tick, 10));
          tick();
        });
      void (async () => {
        for (const line of lines) {
          child.stdin.write(`${line}\n`);
          if (between) await between({ answered });
        }
        if (endAfter) child.stdin.end();
      })();
    });
  return ctx;
}

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

const msg = (o) => JSON.stringify({ jsonrpc: '2.0', ...o });

describe('the stdio bridge', () => {
  it('relays requests, writes one json line per answer and nothing for a notification', async () => {
    const ctx = await setup();
    const got = await ctx.run([
      msg({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }),
      msg({ method: 'notifications/initialized' }),
      msg({ id: 2, method: 'ping' }),
      msg({ id: 'three', method: 'tools/call', params: { name: 'get_state', arguments: {} } }),
    ]);
    expect(got.code).toBe(0);
    const answers = got.lines.map((l) => JSON.parse(l));
    expect(answers.map((a) => a.id)).toEqual([1, 2, 'three']);
    expect(answers[0].result.serverInfo.name).toBe('ncut');
    expect(answers[1].result).toEqual({});
    expect(answers[2].result.content[0].text).toBe('ran get_state');
    // stdout holds json lines only
    expect(got.raw.endsWith('\n')).toBe(true);
    for (const l of got.lines) expect(() => JSON.parse(l)).not.toThrow();
    expect(got.err).toBe('');
  });

  it('answers come out in the order of the requests even when the first is slow', async () => {
    const ctx = await setup({ delayList: 200 });
    const got = await ctx.run([msg({ id: 1, method: 'tools/list' }), msg({ id: 2, method: 'ping' }), msg({ id: 3, method: 'ping' })]);
    expect(got.lines.map((l) => JSON.parse(l).id)).toEqual([1, 2, 3]);
    expect(JSON.parse(got.lines[0]).result.tools[0].name).toBe('get_state');
  });

  it('ends after stdin ends, once the answers on their way are written', async () => {
    const ctx = await setup({ delayList: 150 });
    const got = await ctx.run([msg({ id: 1, method: 'tools/list' })]);
    expect(got.lines).toHaveLength(1);
    expect(got.code).toBe(0);
  });

  it('takes a last line without a newline', async () => {
    const ctx = await setup();
    const got = await new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(ctx.dir, 'mcp-bridge.cjs')], { stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (c) => (out += c));
      child.on('close', () => resolve(out));
      child.stdin.end(msg({ id: 1, method: 'ping' }));
    });
    expect(JSON.parse(got.trim()).id).toBe(1);
  });

  it('reads the token again for every message', async () => {
    const ctx = await setup();
    // the token changes only between two messages: after the answer to the one before is out
    let sent = 0;
    const got = await ctx.run(
      [msg({ id: 1, method: 'ping' }), msg({ id: 2, method: 'ping' })],
      {
        between: async ({ answered }) => {
          sent++;
          await answered(sent);
          await ctx.mcp.rotate();
        },
      },
    );
    const answers = got.lines.map((l) => JSON.parse(l));
    expect(answers.map((a) => a.result)).toEqual([{}, {}]);
  });

  it('a bad token in mcp.json is an error for a request, nothing for a notification', async () => {
    const ctx = await setup();
    const file = path.join(ctx.dir, 'mcp.json');
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...cfg, token: 'x'.repeat(43) }));
    const got = await ctx.run([msg({ id: 1, method: 'ping' }), msg({ method: 'notifications/initialized' })]);
    expect(got.lines).toHaveLength(1);
    const a = JSON.parse(got.lines[0]);
    expect(a.id).toBe(1);
    expect(a.error.code).toBe(-32000);
    expect(a.error.message).toContain('ncut is not running or its mcp server is off');
  });

  it('ncut not running: an error with the id, silence for a notification', async () => {
    const ctx = await setup({ server: false });
    const got = await ctx.run([msg({ id: 7, method: 'tools/list' }), msg({ method: 'notifications/initialized' }), msg({ id: 'b', method: 'ping' })]);
    const answers = got.lines.map((l) => JSON.parse(l));
    expect(answers.map((a) => a.id)).toEqual([7, 'b']);
    for (const a of answers) {
      expect(a.jsonrpc).toBe('2.0');
      expect(a.error.code).toBe(-32000);
      expect(a.error.message).toContain('not running');
    }
    expect(got.code).toBe(0);
  });

  it('the server is off: the same error', async () => {
    const ctx = await setup();
    await ctx.mcp.setEnabled(false);
    const got = await ctx.run([msg({ id: 1, method: 'ping' })]);
    expect(JSON.parse(got.lines[0]).error.code).toBe(-32000);
  });

  it('a stale mcp.json whose port nobody listens on is the same error', async () => {
    const ctx = await setup({ server: false });
    fs.writeFileSync(path.join(ctx.dir, 'mcp.json'), JSON.stringify({ enabled: true, port: await freePort(), token: 'A'.repeat(43) }));
    const got = await ctx.run([msg({ id: 1, method: 'ping' })]);
    expect(JSON.parse(got.lines[0]).error.code).toBe(-32000);
  });

  it('passes the server json-rpc errors on (a batch, bad json)', async () => {
    const ctx = await setup();
    const got = await ctx.run([JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }]), '{broken', msg({ id: 2, method: 'ping' })]);
    const answers = got.lines.map((l) => JSON.parse(l));
    expect(answers[0].error.code).toBe(-32600);
    expect(answers[1].error.code).toBe(-32700);
    expect(answers[2].id).toBe(2);
  });

  it('skips empty lines and handles windows line ends', async () => {
    const ctx = await setup();
    const got = await ctx.run(['', `${msg({ id: 1, method: 'ping' })}\r`, '   ']);
    expect(got.lines).toHaveLength(1);
    expect(JSON.parse(got.lines[0]).id).toBe(1);
  });
});
