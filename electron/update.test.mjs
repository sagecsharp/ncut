import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { createUpdater, createRequest } = require('./update.cjs');
const rules = require('./updateRules.cjs');

const MIB = 1024 * 1024;
const API = rules.API_URL;
const DL_PREFIX = 'https://github.com/sagecsharp/ncut/releases/download/';
const CDN = 'https://release-assets.githubusercontent.com/obj/1?sig=x';

// ---------- the world, made of fakes ----------

const dirs = [];
const toDispose = [];

afterEach(() => {
  while (toDispose.length) {
    try {
      toDispose.pop()();
    } catch {
      /* already gone */
    }
  }
  while (dirs.length) {
    try {
      fs.rmSync(dirs.pop(), { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    } catch {
      /* the temp folder is cleaned by the system anyway */
    }
  }
});

function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ncut-upd-'));
  dirs.push(d);
  return d;
}

/** a clock and timers that only move when the test says so */
function clockAndTimers() {
  const clock = { t: 1_800_000_000_000 };
  const queue = [];
  let seq = 0;
  const timers = {
    setTimeout(fn, ms) {
      const t = { id: ++seq, at: clock.t + ms, fn, unref() {} };
      queue.push(t);
      return t;
    },
    clearTimeout(t) {
      const i = queue.indexOf(t);
      if (i >= 0) queue.splice(i, 1);
    },
  };
  async function advance(ms) {
    const target = clock.t + ms;
    for (;;) {
      queue.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = queue[0];
      if (!next || next.at > target) break;
      queue.shift();
      clock.t = Math.max(clock.t, next.at);
      next.fn();
      await flush();
    }
    clock.t = target;
    await flush();
  }
  return { clock, timers, advance, pending: () => queue.length };
}

async function flush() {
  for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r));
}

/** waits for real io (fs works on other threads), up to 10 s */
async function until(pred, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 1));
  }
  throw new Error('the condition never came true');
}

/** an answer of the fake network. body: bytes, text, a list of chunks or any readable / async iterable */
function reply(status, headers = {}, body = []) {
  let stream;
  if (body instanceof Readable) stream = body;
  else if (Buffer.isBuffer(body) || typeof body === 'string') stream = Readable.from([Buffer.from(body)]);
  else stream = Readable.from(body);
  const r = {
    status,
    headers,
    body: stream,
    destroyed: false,
    destroy() {
      r.destroyed = true;
      stream.destroy();
    },
  };
  return r;
}

const json = (obj) => reply(200, { 'content-type': 'application/json; charset=utf-8' }, JSON.stringify(obj));

/** a body that gives one chunk and then never says anything again */
function stalling(first) {
  let sent = false;
  return new Readable({
    read() {
      if (!sent) {
        sent = true;
        this.push(first);
      }
    },
  });
}

function makeNet(handler) {
  const net = { handler, calls: [], responses: [] };
  net.request = (req) => {
    net.calls.push({ url: req.url, headers: req.headers, timeoutMs: req.timeoutMs, signal: req.signal });
    return Promise.resolve(net.handler(req.url, net.calls.length, req)).then((r) => {
      if (r instanceof Error) throw r;
      net.responses.push(r);
      return r;
    });
  };
  return net;
}

const payload = (seed, len = MIB + 777) => Buffer.alloc(len, seed);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function chunked(bytes, size = 256 * 1024) {
  const out = [];
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.subarray(i, i + size));
  return out;
}

function releaseFor(bytes, { version = '0.3.0', kind = 'installed' } = {}) {
  const name = `ncut-${version}-${kind === 'portable' ? 'portable' : 'setup'}.exe`;
  return {
    tag_name: `v${version}`,
    draft: false,
    prerelease: false,
    body: `## sha256\n\n${sha(bytes)}  ${name}\n`,
    assets: [{ name, size: bytes.length, digest: `sha256:${sha(bytes)}`, browser_download_url: `${DL_PREFIX}v${version}/${name}` }],
  };
}

/** the api answers `rel`, the first hop of the download redirects to the cdn, the cdn gives `bytes` */
function github(rel, bytes, extra = {}) {
  return (url) => {
    if (url === API) return json(rel);
    if (url.startsWith(DL_PREFIX)) return reply(302, { location: CDN });
    if (url === CDN) return reply(200, { 'content-length': String(bytes.length) }, extra.body ?? chunked(bytes));
    return new Error(`the test did not expect ${url}`);
  };
}

function setup(over = {}) {
  const h = over.h ?? clockAndTimers();
  const dir = over.dir ?? tmpDir();
  const spawned = [];
  const spawn = (file, args, options) => {
    spawned.push({ file, args, options });
    return { pid: 4242, on() {}, unref() {} };
  };
  const logs = [];
  const net = over.net ?? makeNet(over.handler ?? (() => new Error('no network in this test')));
  if (over.handler && over.net) net.handler = over.handler;
  const t = { h, dir, net, spawned, logs, updates: path.join(dir, 'updates'), stateFile: path.join(dir, 'update.json'), states: [] };
  t.u = createUpdater({
    userDataDir: dir,
    appVersion: '0.2.0',
    kind: 'installed',
    execPath: path.join(dir, 'app', 'ncut.exe'),
    request: net.request,
    spawn,
    now: () => h.clock.t,
    timers: h.timers,
    log: (m) => logs.push(m),
    ...(over.opts ?? {}),
  });
  t.u.onChange((s) => t.states.push(s));
  toDispose.push(() => t.u.dispose());
  return t;
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const apiCalls = (t) => t.net.calls.filter((c) => c.url === API).length;

/** starts, checks and waits until the update is downloaded and verified */
async function downloaded(t) {
  await t.u.init();
  t.u.check();
  await until(() => t.u.state().phase === 'ready' || t.u.state().phase === 'failed');
  expect(t.u.state().phase).toBe('ready');
}

// ---------- the one https GET ----------

describe('the default request', () => {
  function fakeHttps() {
    const gets = [];
    const api = {
      gets,
      mode: 'answer',
      get(url, options, cb) {
        gets.push({ url, options });
        const req = new EventEmitter();
        req.destroyed = false;
        req.destroy = (e) => {
          req.destroyed = true;
          if (e) queueMicrotask(() => req.emit('error', e));
        };
        if (api.mode === 'answer') {
          const res = Readable.from([Buffer.from('hello')]);
          res.statusCode = 200;
          res.headers = { 'content-type': 'text/plain' };
          queueMicrotask(() => cb(res));
        } else if (api.mode === 'error') {
          queueMicrotask(() => req.emit('error', Object.assign(new Error('boom'), { code: 'ECONNRESET' })));
        }
        return req;
      },
    };
    return api;
  }

  it('passes the headers on and hands back status, headers and body', async () => {
    const f = fakeHttps();
    const res = await createRequest(f)({ url: API, headers: { Accept: 'x', 'User-Agent': 'y' }, timeoutMs: 1234 });
    expect(f.gets[0].url).toBe(API);
    expect(f.gets[0].options.headers).toEqual({ Accept: 'x', 'User-Agent': 'y' });
    expect(f.gets[0].options.timeout).toBe(1234);
    expect(f.gets[0].options.agent).toBe(false);
    expect(f.gets[0].options.minVersion).toBe('TLSv1.2');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/plain');
    const parts = [];
    for await (const c of res.body) parts.push(c);
    expect(Buffer.concat(parts).toString()).toBe('hello');
  });

  it('rejects on a network error, on a timeout and on an abort', async () => {
    const f = fakeHttps();
    f.mode = 'error';
    await expect(createRequest(f)({ url: API, headers: {}, timeoutMs: 1 })).rejects.toMatchObject({ code: 'ECONNRESET' });
    f.mode = 'hang';
    const ac = new AbortController();
    const p = createRequest(f)({ url: API, headers: {}, timeoutMs: 1, signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toThrow();
    // a signal that is already aborted never lets a request through
    const done = new AbortController();
    done.abort();
    await expect(createRequest(f)({ url: API, headers: {}, timeoutMs: 1, signal: done.signal })).rejects.toThrow();
  });

  it('rejects when https itself throws', async () => {
    await expect(createRequest({ get: () => { throw new Error('bad'); } })({ url: API, headers: {}, timeoutMs: 1 })).rejects.toThrow('bad');
  });
});

// ---------- asking github ----------

describe('checking', () => {
  const notNewer = () => json(releaseFor(payload(1), { version: '0.2.0' }));

  it('is one anonymous get with two headers and a timeout, 15 s after the start', async () => {
    const t = setup({ handler: notNewer });
    await t.u.init();
    await t.h.advance(14_000);
    expect(t.net.calls).toHaveLength(0);
    await t.h.advance(1_000);
    await until(() => t.u.state().checkedAt !== null);
    expect(t.net.calls).toHaveLength(1);
    const c = t.net.calls[0];
    expect(c.url).toBe(API);
    expect(c.headers).toEqual({ Accept: 'application/vnd.github+json', 'User-Agent': 'ncut-updater/0.2.0' });
    expect(c.timeoutMs).toBe(20_000);
    expect(t.u.state()).toMatchObject({ kind: 'installed', phase: 'idle', current: '0.2.0', latest: '0.2.0', error: null, checkedAt: t.h.clock.t });
    expect(readJson(t.stateFile).checkedAt).toBe(t.h.clock.t);
  });

  it('asks again every 6 hours', async () => {
    const t = setup({ handler: notNewer });
    await t.u.init();
    await t.h.advance(15_000);
    await until(() => apiCalls(t) === 1);
    await t.h.advance(6 * 3600_000 - 60_000);
    expect(apiCalls(t)).toBe(1);
    await t.h.advance(60_000);
    await until(() => apiCalls(t) === 2);
    await t.h.advance(6 * 3600_000);
    await until(() => apiCalls(t) === 3);
  });

  it('after a failed check tries again in an hour, not at once', async () => {
    const t = setup({ handler: () => reply(500) });
    await t.u.init();
    await t.h.advance(15_000);
    await until(() => t.u.state().phase === 'failed');
    await t.h.advance(3600_000 - 1000);
    expect(apiCalls(t)).toBe(1);
    await t.h.advance(1000);
    await until(() => apiCalls(t) === 2);
  });

  it('a failure is a short reason in the state, never a throw', async () => {
    const cases = [
      [reply(403, { 'content-type': 'application/json' }, '{}'), /limiting requests/],
      [reply(429, {}, '{}'), /limiting requests/],
      [reply(500, {}, 'x'), /status 500/],
      [reply(404, {}, 'x'), /status 404/],
      [reply(204), /status 204/],
      [reply(301, { location: API }), /status 301/],
      [reply(200, { 'content-type': 'text/html' }, '<html>'), /not json/],
      [reply(200, { 'content-type': 'application/json' }, '{"tag_name": '), /not json/],
      [reply(200, { 'content-type': 'application/json' }, 'x'), /not json/],
      [Object.assign(new Error('getaddrinfo ENOTFOUND api.github.com'), { code: 'ENOTFOUND' }), /can not be reached/],
      [Object.assign(new Error('certificate has expired'), { code: 'CERT_HAS_EXPIRED' }), /secure connection/],
      [new Error('something odd with C:\\Users\\me\\x'), /update failed/],
    ];
    for (const [answer, want] of cases) {
      const t = setup({ handler: () => answer });
      await t.u.init();
      t.u.check();
      await until(() => t.u.state().phase === 'failed');
      const s = t.u.state();
      expect(s.error, String(want)).toMatch(want);
      expect(s.error).not.toMatch(/[A-Za-z]:\\/);
      expect(s.checkedAt).toBe(t.h.clock.t);
      t.u.dispose();
    }
  });

  it('a redirect of the api answer is not followed', async () => {
    const t = setup({ handler: () => reply(302, { location: 'https://evil.example/x' }) });
    await t.u.init();
    t.u.check();
    await until(() => t.u.state().phase === 'failed');
    expect(t.net.calls).toHaveLength(1);
  });

  it('an answer bigger than 1 MiB is refused, announced or not', async () => {
    const big = Buffer.alloc(600 * 1024, 0x20);
    let t = setup({ handler: () => reply(200, { 'content-type': 'application/json' }, [big, big]) });
    await t.u.init();
    t.u.check();
    await until(() => t.u.state().phase === 'failed');
    expect(t.u.state().error).toMatch(/too big/);
    expect(t.net.responses[0].destroyed).toBe(true);
    t = setup({ handler: () => reply(200, { 'content-type': 'application/json', 'content-length': String(5 * MIB) }, '{}') });
    await t.u.init();
    t.u.check();
    await until(() => t.u.state().phase === 'failed');
    expect(t.u.state().error).toMatch(/too big/);
  });

  it('gives up after 20 s without an answer', async () => {
    const t = setup({ handler: () => new Promise(() => {}) });
    await t.u.init();
    t.u.check();
    expect(t.u.state().phase).toBe('checking');
    await t.h.advance(19_000);
    expect(t.u.state().phase).toBe('checking');
    await t.h.advance(1_000);
    await until(() => t.u.state().phase === 'failed');
    expect(t.u.state().error).toMatch(/did not answer in time/);
    expect(t.net.calls[0].signal.aborted).toBe(true);
  });

  it('gives up when the body stops in the middle', async () => {
    const t = setup({ handler: () => reply(200, { 'content-type': 'application/json' }, stalling(Buffer.from('{"a":'))) });
    await t.u.init();
    t.u.check();
    await flush();
    await t.h.advance(20_000);
    await until(() => t.u.state().phase === 'failed');
    expect(t.u.state().error).toMatch(/did not answer in time/);
  });

  it('a refused release says why', async () => {
    const rel = releaseFor(payload(1));
    delete rel.assets[0].digest;
    const t = setup({ handler: () => json(rel) });
    await t.u.init();
    t.u.check();
    await until(() => t.u.state().phase === 'failed');
    expect(t.u.state().error).toMatch(/no checksum/);
    expect(t.net.calls).toHaveLength(1);
  });

  it('check() answers with the state right after it started', async () => {
    const t = setup({ handler: notNewer });
    await t.u.init();
    const s = t.u.check();
    expect(s.phase).toBe('checking');
    expect(t.net.calls).toHaveLength(1);
    await until(() => t.u.state().phase === 'idle');
  });

  it('a second check while one runs does not start a second request', async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const t = setup({ handler: () => gate });
    await t.u.init();
    t.u.check();
    t.u.check();
    t.u.check();
    await t.h.advance(15_000);
    expect(t.net.calls).toHaveLength(1);
    release(json(releaseFor(payload(1), { version: '0.2.0' })));
    await until(() => t.u.state().checkedAt !== null);
    // done, and not long ago: the page that asks again gets the state back and no request goes out
    t.u.check();
    expect(t.net.calls).toHaveLength(1);
    // a while later a new one may start
    await t.h.advance(rules.MIN_MANUAL_GAP_MS);
    t.u.check();
    expect(t.net.calls).toHaveLength(2);
  });

  it('a page that asks for a check in a loop makes one request per 10 s at most', async () => {
    const t = setup({ handler: notNewer });
    await t.u.init();
    for (let i = 0; i < 30; i++) {
      t.u.check();
      await until(() => t.u.state().phase !== 'checking');
      await t.h.advance(1_000);
    }
    // 30 asks over 30 s: answered at 0 s, 10 s and 20 s. the 15 s timer is held back by the hour rule
    expect(apiCalls(t)).toBe(3);
  });

  it('a check that was stopped (auto switched off) does not count for the 10 s rule', async () => {
    const bytes = payload(5);
    const t = setup({ handler: github(releaseFor(bytes), bytes, { body: stalling(bytes.subarray(0, 100)) }) });
    await t.u.init();
    await t.h.advance(15_000);
    await until(() => t.u.state().phase === 'downloading');
    t.u.setAuto(false);
    await until(() => t.u.state().phase === 'idle');
    // the user asks right after: that goes out
    t.u.check();
    expect(apiCalls(t)).toBe(2);
  });

  it('check() asks now, whatever the hour rule says, even with auto off', async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'update.json'), JSON.stringify({ auto: false, checkedAt: 1_800_000_000_000 - 1000 }));
    const t = setup({ dir, handler: notNewer });
    await t.u.init();
    t.u.check();
    await until(() => t.u.state().phase === 'idle' && apiCalls(t) === 1);
    expect(t.u.state().auto).toBe(false);
  });
});

describe('when it asks on its own', () => {
  const notNewer = () => json(releaseFor(payload(1), { version: '0.2.0' }));

  it('never more than once an hour, counting the last check of the state file', async () => {
    const dir = tmpDir();
    const h = clockAndTimers();
    fs.writeFileSync(path.join(dir, 'update.json'), JSON.stringify({ auto: true, checkedAt: h.clock.t - 10 * 60_000 }));
    const t = setup({ dir, h, handler: notNewer });
    await t.u.init();
    await t.h.advance(15_000);
    expect(apiCalls(t)).toBe(0);
    await t.h.advance(30 * 60_000);
    expect(apiCalls(t)).toBe(0);
    // 10 + 15 s + 30 min so far: the hour of the old check ends 19 min 45 s from now
    await t.h.advance(19 * 60_000);
    expect(apiCalls(t)).toBe(0);
    await t.h.advance(60_000);
    await until(() => apiCalls(t) === 1);
  });

  it('starting the app ten times in a row asks github once', async () => {
    const dir = tmpDir();
    const h = clockAndTimers();
    const net = makeNet(notNewer);
    for (let i = 0; i < 10; i++) {
      const t = setup({ dir, h, net });
      await t.u.init();
      await h.advance(20_000);
      t.u.dispose();
      await h.advance(10_000);
    }
    expect(net.calls).toHaveLength(1);
  });

  it('with auto off no request is ever made on its own', async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'update.json'), JSON.stringify({ auto: false, checkedAt: null }));
    for (const kind of ['installed', 'portable', 'manual']) {
      const t = setup({ dir, handler: notNewer, opts: { kind, portableFile: path.join(dir, 'ncut.exe') } });
      await t.u.init();
      await t.h.advance(48 * 3600_000);
      expect(t.net.calls, kind).toHaveLength(0);
      expect(t.h.pending()).toBe(0);
      t.u.dispose();
    }
  });

  it('switching auto off stops the timers and a download nobody asked for; switching on asks again', async () => {
    const bytes = payload(3);
    const t = setup({ handler: github(releaseFor(bytes), bytes, { body: stalling(bytes.subarray(0, 1000)) }) });
    await t.u.init();
    await t.h.advance(15_000);
    await until(() => t.u.state().phase === 'downloading');
    t.u.setAuto(false);
    await until(() => t.u.state().phase === 'idle');
    expect(t.u.state().error).toBeNull();
    expect(fs.existsSync(path.join(t.updates, 'ncut-0.3.0-setup.exe.part'))).toBe(false);
    expect(readJson(t.stateFile).auto).toBe(false);
    expect(t.h.pending()).toBe(0);
    const before = t.net.calls.length;
    await t.h.advance(24 * 3600_000);
    expect(t.net.calls).toHaveLength(before);
    t.u.setAuto(true);
    expect(t.h.pending()).toBe(1);
  });

  it('setAuto takes only true as on', () => {
    const t = setup({});
    expect(t.u.state().auto).toBe(true);
    expect(t.u.setAuto('true').auto).toBe(false);
    expect(t.u.setAuto(1).auto).toBe(false);
    expect(t.u.setAuto(true).auto).toBe(true);
    expect(t.u.setAuto(undefined).auto).toBe(false);
  });

  it('a download the user asked for goes on when auto is switched off', async () => {
    const bytes = payload(4);
    const t = setup({ handler: github(releaseFor(bytes), bytes, { body: stalling(bytes.subarray(0, 1000)) }) });
    await t.u.init();
    t.u.check();
    await until(() => t.u.state().phase === 'downloading');
    t.u.setAuto(false);
    await flush();
    expect(t.u.state().phase).toBe('downloading');
  });
});

// ---------- the download ----------

describe('downloading', () => {
  it('goes through the redirect, checks size and hash, then the file is ready', async () => {
    const bytes = payload(5);
    const t = setup({ handler: github(releaseFor(bytes), bytes) });
    await downloaded(t);
    const file = path.join(t.updates, 'ncut-0.3.0-setup.exe');
    expect(fs.readFileSync(file).equals(bytes)).toBe(true);
    expect(fs.readdirSync(t.updates)).toEqual(['ncut-0.3.0-setup.exe']);
    expect(readJson(t.stateFile).ready).toEqual({ version: '0.3.0', file, sha256: sha(bytes), size: bytes.length });
    expect(t.u.state()).toMatchObject({ phase: 'ready', latest: '0.3.0', progress: 0, error: null });
    // api, the asset address on github.com, the cdn: nothing else, no credentials, no cookies
    expect(t.net.calls.map((c) => c.url)).toEqual([API, `${DL_PREFIX}v0.3.0/ncut-0.3.0-setup.exe`, CDN]);
    for (const c of t.net.calls.slice(1)) {
      expect(Object.keys(c.headers).sort()).toEqual(['Accept', 'User-Agent']);
      expect(c.timeoutMs).toBe(30_000);
    }
    expect(t.net.responses.every((r) => r.destroyed)).toBe(true);
  });

  it('tells the page about progress at most 4 times a second', async () => {
    const bytes = payload(6);
    const h = clockAndTimers();
    async function* slow() {
      const parts = chunked(bytes, Math.ceil(bytes.length / 100));
      for (const p of parts) {
        h.clock.t += 10;
        yield p;
      }
    }
    const t = setup({ h, handler: github(releaseFor(bytes), bytes, { body: Readable.from(slow()) }) });
    await downloaded(t);
    const moving = t.states.filter((s) => s.phase === 'downloading' && s.progress > 0);
    expect(moving.length).toBeGreaterThanOrEqual(1);
    expect(moving.length).toBeLessThanOrEqual(6);
    for (let i = 1; i < moving.length; i++) expect(moving[i].progress).toBeGreaterThanOrEqual(moving[i - 1].progress);
    expect(t.states.some((s) => s.phase === 'downloading' && s.progress === 0)).toBe(true);
  });

  it('follows up to 5 redirects and no more', async () => {
    const bytes = payload(7);
    const rel = releaseFor(bytes);
    const chain = (n) => (url, _i) => {
      if (url === API) return json(rel);
      const m = /^https:\/\/objects\.githubusercontent\.com\/hop(\d+)$/.exec(url);
      const hop = url.startsWith(DL_PREFIX) ? 0 : m ? Number(m[1]) : -1;
      if (hop < 0) return new Error(`unexpected ${url}`);
      if (hop < n) return reply(302, { location: `https://objects.githubusercontent.com/hop${hop + 1}` });
      return reply(200, { 'content-length': String(bytes.length) }, chunked(bytes));
    };
    let t = setup({ handler: chain(5) });
    await downloaded(t);
    expect(t.net.calls).toHaveLength(1 + 1 + 5);
    t = setup({ handler: chain(6) });
    await t.u.init();
    t.u.check();
    await until(() => t.u.state().phase === 'failed');
    expect(t.u.state().error).toMatch(/sent around too often/);
    expect(t.net.calls).toHaveLength(1 + 1 + 5);
    expect(fs.existsSync(t.updates) ? fs.readdirSync(t.updates) : []).toEqual([]);
    expect(readJson(t.stateFile).ready).toBeNull();
  });

  it('a redirect to a bad host on the second hop is not followed', async () => {
    const bytes = payload(8);
    const rel = releaseFor(bytes);
    for (const bad of [
      'https://evil.example/ncut.exe',
      'https://githubusercontent.com.evil.example/x',
      'https://xgithubusercontent.com/x',
      'http://objects.githubusercontent.com/x',
      'https://objects.githubusercontent.com:8443/x',
      'https://user:pw@objects.githubusercontent.com/x',
      'https://github.com@evil.example/x',
      'https://127.0.0.1/x',
    ]) {
      const t = setup({
        handler: (url) => {
          if (url === API) return json(rel);
          if (url.startsWith(DL_PREFIX)) return reply(302, { location: CDN });
          if (url === CDN) return reply(302, { location: bad });
          return new Error(`must never be asked: ${url}`);
        },
      });
      await t.u.init();
      t.u.check();
      await until(() => t.u.state().phase === 'failed');
      expect(t.net.calls.map((c) => c.url), bad).toEqual([API, `${DL_PREFIX}v0.3.0/ncut-0.3.0-setup.exe`, CDN]);
      expect(t.u.state().error).toMatch(/not usable|not one/);
      expect(readJson(t.stateFile).ready).toBeNull();
      expect(fs.readdirSync(t.updates)).toEqual([]);
      t.u.dispose();
    }
  });

  it('a redirect without an address, or the first hop leaving github.com, fails', async () => {
    const bytes = payload(9);
    const rel = releaseFor(bytes);
    let t = setup({ handler: (url) => (url === API ? json(rel) : reply(302, {})) });
    await t.u.init();
    t.u.check();
    await until(() => t.u.state().phase === 'failed');
    expect(t.u.state().error).toMatch(/not usable/);
    // a release whose asset address points elsewhere never gets as far as a request
    const odd = releaseFor(bytes);
    odd.assets[0].browser_download_url = 'https://objects.githubusercontent.com/x';
    t = setup({ handler: (url) => (url === API ? json(odd) : new Error('never')) });
    await t.u.init();
    t.u.check();
    await until(() => t.u.state().phase === 'failed');
    expect(t.net.calls).toHaveLength(1);
  });

  it('other statuses of the download fail', async () => {
    const bytes = payload(10);
    const rel = releaseFor(bytes);
    const t = setup({ handler: (url) => (url === API ? json(rel) : url.startsWith(DL_PREFIX) ? reply(302, { location: CDN }) : reply(404, {}, 'x')) });
    await t.u.init();
    t.u.check();
    await until(() => t.u.state().phase === 'failed');
    expect(t.u.state().error).toMatch(/status 404/);
  });

  it('stops reading at the first byte over the announced size and keeps nothing', async () => {
    const small = payload(11, MIB);
    const rel = releaseFor(small);
    const many = [payload(12, 400 * 1024), payload(12, 400 * 1024), payload(12, 400 * 1024), payload(12, 400 * 1024)];
    const t = setup({
      handler: (url) => (url === API ? json(rel) : url.startsWith(DL_PREFIX) ? reply(302, { location: CDN }) : reply(200, {}, many)),
    });
    await t.u.init();
    t.u.check();
    await until(() => t.u.state().phase === 'failed');
    expect(t.u.state().error).toMatch(/bigger than announced/);
    expect(t.net.responses.at(-1).destroyed).toBe(true);
    expect(fs.readdirSync(t.updates)).toEqual([]);
    expect(readJson(t.stateFile).ready).toBeNull();
  });

  it('a content-length that is not the announced size fails before a byte is written', async () => {
    const bytes = payload(13);
    const rel = releaseFor(bytes);
    const t = setup({
      handler: (url) => (url === API ? json(rel) : url.startsWith(DL_PREFIX) ? reply(302, { location: CDN }) : reply(200, { 'content-length': String(bytes.length + 1) }, chunked(bytes))),
    });
    await t.u.init();
    t.u.check();
    await until(() => t.u.state().phase === 'failed');
    expect(t.u.state().error).toMatch(/not the size/);
    expect(fs.readdirSync(t.updates)).toEqual([]);
  });

  it('a short file is refused and its .part is deleted', async () => {
    const bytes = payload(14);
    const rel = releaseFor(bytes);
    const t = setup({
      handler: (url) => (url === API ? json(rel) : url.startsWith(DL_PREFIX) ? reply(302, { location: CDN }) : reply(200, {}, chunked(bytes).slice(0, 2))),
    });
    await t.u.init();
    t.u.check();
    await until(() => t.u.state().phase === 'failed');
    expect(t.u.state().error).toMatch(/shorter than announced/);
    expect(fs.readdirSync(t.updates)).toEqual([]);
    expect(readJson(t.stateFile).ready).toBeNull();
  });

  it('a wrong hash is refused even when the size is right', async () => {
    const bytes = payload(15);
    const rel = releaseFor(bytes);
    const other = payload(16, bytes.length);
    const t = setup({ handler: github(rel, other) });
    await t.u.init();
    t.u.check();
    await until(() => t.u.state().phase === 'failed');
    expect(t.u.state().error).toMatch(/checksum/);
    expect(fs.readdirSync(t.updates)).toEqual([]);
    expect(readJson(t.stateFile).ready).toBeNull();
    expect(t.u.canRestart()).toBe(false);
  });

  it('a download that goes quiet for 30 s dies and leaves nothing', async () => {
    const bytes = payload(17);
    const t = setup({ handler: github(releaseFor(bytes), bytes, { body: stalling(bytes.subarray(0, 5000)) }) });
    await t.u.init();
    t.u.check();
    await until(() => fs.existsSync(path.join(t.updates, 'ncut-0.3.0-setup.exe.part')) && fs.statSync(path.join(t.updates, 'ncut-0.3.0-setup.exe.part')).size > 0);
    await t.h.advance(29_000);
    expect(t.u.state().phase).toBe('downloading');
    await t.h.advance(1_000);
    await until(() => t.u.state().phase === 'failed');
    expect(t.u.state().error).toMatch(/stalled/);
    expect(fs.readdirSync(t.updates)).toEqual([]);
  });

  it('closing the app in the middle stops the request and deletes the .part, without a failure', async () => {
    const bytes = payload(18);
    const t = setup({ handler: github(releaseFor(bytes), bytes, { body: stalling(bytes.subarray(0, 5000)) }) });
    await t.u.init();
    t.u.check();
    const part = path.join(t.updates, 'ncut-0.3.0-setup.exe.part');
    await until(() => fs.existsSync(part) && fs.statSync(part).size > 0);
    t.u.dispose();
    await until(() => !fs.existsSync(part));
    expect(t.net.calls.at(-1).signal.aborted).toBe(true);
    expect(t.u.state().phase).not.toBe('failed');
    expect(t.u.state().error).toBeNull();
  });

  it('a check the user asked for downloads even when auto is off', async () => {
    const bytes = payload(19);
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'update.json'), JSON.stringify({ auto: true }));
    const t = setup({ dir, handler: github(releaseFor(bytes), bytes) });
    await t.u.init();
    t.u.setAuto(false);
    // a manual check with auto off still downloads (the user asked)
    t.u.check();
    await until(() => t.u.state().phase === 'ready');
  });

  it('a second check or restart while downloading does nothing extra', async () => {
    const bytes = payload(20);
    const t = setup({ handler: github(releaseFor(bytes), bytes, { body: stalling(bytes.subarray(0, 100)) }) });
    await t.u.init();
    t.u.check();
    await until(() => t.u.state().phase === 'downloading');
    t.u.check();
    t.u.check();
    expect(apiCalls(t)).toBe(1);
    expect(t.u.canRestart()).toBe(false);
  });

  it('an update that is ready needs no new check on its own', async () => {
    const bytes = payload(21);
    const t = setup({ handler: github(releaseFor(bytes), bytes) });
    await downloaded(t);
    const n = t.net.calls.length;
    await t.h.advance(48 * 3600_000);
    expect(t.net.calls).toHaveLength(n);
  });

  describe('check now while an update is ready', () => {
    async function readyWith(version, seed) {
      const bytes = payload(seed);
      const t = setup({ handler: github(releaseFor(bytes, { version }), bytes) });
      await downloaded(t);
      await t.h.advance(rules.MIN_MANUAL_GAP_MS);
      return { t, bytes };
    }

    it('asks github, finds the same version, downloads nothing again and stays ready', async () => {
      const { t } = await readyWith('0.3.0', 24);
      const before = t.net.calls.length;
      const checkedBefore = t.u.state().checkedAt;
      t.u.check();
      await until(() => apiCalls(t) === 2 && t.u.state().phase !== 'checking');
      expect(t.net.calls).toHaveLength(before + 1);
      expect(t.u.state()).toMatchObject({ phase: 'ready', latest: '0.3.0', error: null });
      expect(t.u.state().checkedAt).toBeGreaterThan(checkedBefore);
      expect(t.u.canRestart()).toBe(true);
      expect(fs.readdirSync(t.updates)).toEqual(['ncut-0.3.0-setup.exe']);
    });

    it('a newer version replaces the ready one and the old file goes', async () => {
      const { t } = await readyWith('0.3.0', 25);
      const next = payload(26);
      t.net.handler = github(releaseFor(next, { version: '0.3.1' }), next);
      t.u.check();
      await until(() => t.u.state().latest === '0.3.1' && t.u.state().phase === 'ready');
      expect(fs.readdirSync(t.updates)).toEqual(['ncut-0.3.1-setup.exe']);
      expect(readJson(t.stateFile).ready).toMatchObject({ version: '0.3.1', sha256: sha(next) });
    });

    it('a check that fails keeps the ready update ready and says nothing is wrong with it', async () => {
      const { t } = await readyWith('0.3.0', 27);
      t.net.handler = () => new Error('offline');
      t.u.check();
      await until(() => apiCalls(t) === 2 && t.u.state().phase !== 'checking');
      expect(t.u.state()).toMatchObject({ phase: 'ready', error: null, latest: '0.3.0' });
      expect(t.u.canRestart()).toBe(true);
      expect(readJson(t.stateFile).ready).not.toBeNull();
    });

    it('a newer download that fails keeps the older ready one', async () => {
      const { t, bytes } = await readyWith('0.3.0', 28);
      const next = payload(29);
      t.net.handler = github(releaseFor(next, { version: '0.3.1' }), payload(30, next.length));
      t.u.check();
      await until(() => apiCalls(t) === 2 && t.u.state().phase !== 'checking' && t.u.state().phase !== 'downloading');
      expect(t.u.state().phase).toBe('ready');
      expect(readJson(t.stateFile).ready).toMatchObject({ version: '0.3.0', sha256: sha(bytes) });
      expect(fs.readdirSync(t.updates)).toEqual(['ncut-0.3.0-setup.exe']);
    });
  });

  describe('a download that fails its checks', () => {
    // the same bytes are not fetched again on their own, the cheap api question still is asked
    const downloads = (t) => t.net.calls.filter((c) => c.url.startsWith(DL_PREFIX)).length;

    async function rejectedOnce() {
      const bytes = payload(35);
      const t = setup({ handler: github(releaseFor(bytes), payload(36, bytes.length)) });
      await t.u.init();
      await t.h.advance(15_000);
      await until(() => t.u.state().phase === 'failed');
      expect(downloads(t)).toBe(1);
      return { t, bytes };
    }

    it('is not downloaded again on its own for a day, however often github is asked', async () => {
      const { t } = await rejectedOnce();
      await t.h.advance(23 * 3600_000);
      expect(apiCalls(t)).toBeGreaterThan(5);
      expect(downloads(t)).toBe(1);
      expect(t.u.state().phase).toBe('failed');
      expect(t.u.state().error).toMatch(/not trying it again yet/);
      expect(fs.readdirSync(t.updates)).toEqual([]);
    });

    it('is tried again after a day', async () => {
      const { t } = await rejectedOnce();
      await t.h.advance(25 * 3600_000);
      expect(downloads(t)).toBeGreaterThanOrEqual(2);
    });

    it('is tried again at once when the user asks', async () => {
      const { t } = await rejectedOnce();
      await t.h.advance(rules.MIN_MANUAL_GAP_MS);
      t.u.check();
      await until(() => downloads(t) === 2);
    });

    it('is tried again when github names other bytes for the version, or a newer version is out', async () => {
      const { t } = await rejectedOnce();
      const good = payload(37);
      t.net.handler = github(releaseFor(good), good);
      await t.h.advance(3600_000);
      await until(() => t.u.state().phase === 'ready');
      expect(downloads(t)).toBe(2);
    });

    it('a download that goes through clears the memory', async () => {
      const { t } = await rejectedOnce();
      await t.h.advance(rules.MIN_MANUAL_GAP_MS);
      const good = payload(35);
      t.net.handler = github(releaseFor(good), good);
      t.u.check();
      await until(() => t.u.state().phase === 'ready');
    });

    it('an api call or a stalled download is not a failed check of the bytes', async () => {
      const bytes = payload(38);
      const t = setup({ handler: github(releaseFor(bytes), bytes, { body: stalling(bytes.subarray(0, 100)) }) });
      await t.u.init();
      await t.h.advance(15_000);
      await until(() => t.u.state().phase === 'downloading');
      await t.h.advance(30_000);
      await until(() => t.u.state().phase === 'failed');
      await t.h.advance(3600_000);
      await until(() => downloads(t) === 2);
    });
  });

  it('a ready update is found again after the app was started again', async () => {
    const a = payload(22);
    const t = setup({ handler: github(releaseFor(a, { version: '0.3.0' }), a) });
    await downloaded(t);
    const b = payload(23);
    // the same updater is told nothing: a restart of the app finds 0.3.0 ready, then 0.4.0 is out
    t.u.dispose();
    const t2 = setup({ dir: t.dir, h: t.h, handler: github(releaseFor(b, { version: '0.4.0' }), b) });
    await t2.u.init();
    expect(t2.u.state().phase).toBe('ready');
    expect(t2.u.state().latest).toBe('0.3.0');
    expect(fs.readdirSync(t.updates)).toEqual(['ncut-0.3.0-setup.exe']);
  });
});

// ---------- the start ----------

describe('starting', () => {
  it('a broken state file means the defaults', async () => {
    for (const text of ['{', '[]', 'null', '"x"', '{"auto": "no", "ready": 5}']) {
      const dir = tmpDir();
      fs.writeFileSync(path.join(dir, 'update.json'), text);
      const t = setup({ dir });
      await t.u.init();
      expect(t.u.state()).toMatchObject({ auto: true, checkedAt: null, phase: 'idle', latest: null });
      t.u.dispose();
    }
  });

  it('writes update.json whole, with no temp file left', async () => {
    const t = setup({});
    await t.u.init();
    t.u.setAuto(false);
    expect(readJson(t.stateFile)).toEqual({ auto: false, checkedAt: null, ready: null });
    expect(fs.readdirSync(t.dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('deletes old downloads, folders and .part files that are left over', async () => {
    const dir = tmpDir();
    const updates = path.join(dir, 'updates');
    fs.mkdirSync(path.join(updates, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(updates, 'ncut-0.3.0-setup.exe.part'), 'half');
    fs.writeFileSync(path.join(updates, 'ncut-0.1.0-setup.exe'), 'old');
    fs.writeFileSync(path.join(updates, 'sub', 'x'), 'x');
    fs.writeFileSync(path.join(updates, 'notes.txt'), 'x');
    const t = setup({ dir });
    await t.u.init();
    expect(fs.readdirSync(updates)).toEqual([]);
  });

  it('believes a ready entry only after its file is hashed again', async () => {
    const bytes = payload(24);
    const dir = tmpDir();
    const file = path.join(dir, 'updates', 'ncut-0.3.0-setup.exe');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
    fs.writeFileSync(path.join(dir, 'updates', 'junk.part'), 'x');
    fs.writeFileSync(path.join(dir, 'update.json'), JSON.stringify({ auto: true, checkedAt: 5, ready: { version: '0.3.0', file, sha256: sha(bytes), size: bytes.length } }));
    const t = setup({ dir });
    await t.u.init();
    expect(t.u.state()).toMatchObject({ phase: 'ready', latest: '0.3.0' });
    expect(t.u.canRestart()).toBe(true);
    expect(fs.readdirSync(path.join(dir, 'updates'))).toEqual(['ncut-0.3.0-setup.exe']);
  });

  it('a ready file that changed since is deleted and not believed', async () => {
    const bytes = payload(25);
    for (const content of [payload(26, bytes.length), payload(25, bytes.length - 1), payload(25, bytes.length + 1)]) {
      const dir = tmpDir();
      const file = path.join(dir, 'updates', 'ncut-0.3.0-setup.exe');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
      fs.writeFileSync(path.join(dir, 'update.json'), JSON.stringify({ ready: { version: '0.3.0', file, sha256: sha(bytes), size: bytes.length } }));
      const t = setup({ dir });
      await t.u.init();
      expect(t.u.state().phase).toBe('idle');
      expect(t.u.canRestart()).toBe(false);
      expect(fs.existsSync(file)).toBe(false);
      expect(readJson(path.join(dir, 'update.json')).ready).toBeNull();
      t.u.dispose();
    }
  });

  it('a ready entry whose file is gone is dropped', async () => {
    const bytes = payload(27);
    const dir = tmpDir();
    const file = path.join(dir, 'updates', 'ncut-0.3.0-setup.exe');
    fs.writeFileSync(path.join(dir, 'update.json'), JSON.stringify({ ready: { version: '0.3.0', file, sha256: sha(bytes), size: bytes.length } }));
    const t = setup({ dir });
    await t.u.init();
    expect(t.u.state().phase).toBe('idle');
    expect(readJson(path.join(dir, 'update.json')).ready).toBeNull();
  });

  it('a ready entry pointing outside the updates folder is ignored and its file is left alone', async () => {
    const bytes = payload(28);
    const dir = tmpDir();
    const elsewhere = tmpDir();
    const outside = path.join(elsewhere, 'ncut-0.3.0-setup.exe');
    fs.writeFileSync(outside, bytes);
    const traversal = path.join(dir, 'updates', '..', '..', path.basename(elsewhere), 'ncut-0.3.0-setup.exe');
    const nested = path.join(dir, 'updates', 'sub', 'ncut-0.3.0-setup.exe');
    for (const file of [outside, traversal, nested, path.join(dir, 'ncut-0.3.0-setup.exe')]) {
      fs.writeFileSync(path.join(dir, 'update.json'), JSON.stringify({ ready: { version: '0.3.0', file, sha256: sha(bytes), size: bytes.length } }));
      const t = setup({ dir });
      await t.u.init();
      expect(t.u.state().phase, file).toBe('idle');
      expect(t.u.canRestart()).toBe(false);
      expect(readJson(path.join(dir, 'update.json')).ready).toBeNull();
      expect(t.u.applyAtQuit({ restart: true })).toMatchObject({ applied: false });
      expect(t.spawned).toEqual([]);
      t.u.dispose();
    }
    expect(fs.readFileSync(outside).equals(bytes)).toBe(true);
  });

  it('a ready entry with the wrong file name for this kind is ignored', async () => {
    const bytes = payload(29);
    const dir = tmpDir();
    const file = path.join(dir, 'updates', 'ncut-0.3.0-portable.exe');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
    fs.writeFileSync(path.join(dir, 'update.json'), JSON.stringify({ ready: { version: '0.3.0', file, sha256: sha(bytes), size: bytes.length } }));
    const t = setup({ dir });
    await t.u.init();
    expect(t.u.state().phase).toBe('idle');
    expect(fs.existsSync(file)).toBe(false);
  });

  it('a ready version that is not newer than the running one (the update happened) is dropped and deleted', async () => {
    for (const version of ['0.2.0', '0.1.0']) {
      const bytes = payload(30);
      const dir = tmpDir();
      const file = path.join(dir, 'updates', `ncut-${version}-setup.exe`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes);
      fs.writeFileSync(path.join(dir, 'update.json'), JSON.stringify({ ready: { version, file, sha256: sha(bytes), size: bytes.length } }));
      const t = setup({ dir });
      await t.u.init();
      expect(t.u.state().phase).toBe('idle');
      expect(fs.existsSync(file)).toBe(false);
      expect(readJson(path.join(dir, 'update.json')).ready).toBeNull();
      t.u.dispose();
    }
  });

  it('a planted link in place of the updates folder is removed, never followed', async () => {
    const dir = tmpDir();
    const target = tmpDir();
    fs.writeFileSync(path.join(target, 'precious.txt'), 'keep me');
    try {
      fs.symlinkSync(target, path.join(dir, 'updates'), 'junction');
    } catch {
      return; // no permission to make links here
    }
    const t = setup({ dir });
    await t.u.init();
    expect(fs.readFileSync(path.join(target, 'precious.txt'), 'utf8')).toBe('keep me');
    expect(fs.existsSync(path.join(dir, 'updates')) ? fs.lstatSync(path.join(dir, 'updates')).isSymbolicLink() : false).toBe(false);
  });
});

// ---------- applying: the installer ----------

describe('applying an update of the installed app', () => {
  async function ready(over = {}) {
    const bytes = payload(31);
    const t = setup({ handler: github(releaseFor(bytes), bytes), ...over });
    await downloaded(t);
    return { t, bytes, file: path.join(t.updates, 'ncut-0.3.0-setup.exe') };
  }

  it('starts the setup exe silent and updating, and with force-run for a restart', async () => {
    const { t, file } = await ready();
    expect(t.u.canRestart()).toBe(true);
    expect(t.u.wantsApply(true)).toBe(true);
    const result = t.u.applyAtQuit({ restart: true });
    expect(result).toEqual({ applied: true, started: true });
    expect(t.spawned).toHaveLength(1);
    expect(t.spawned[0].file).toBe(file);
    expect(t.spawned[0].args).toEqual(['--updated', '/S', '--force-run']);
    expect(t.spawned[0].options).toEqual({ shell: false, stdio: 'ignore', detached: true, windowsHide: true, cwd: t.updates });
  });

  it('closing normally with auto on installs without starting the new version', async () => {
    const { t, file } = await ready();
    expect(t.u.wantsApply(false)).toBe(true);
    expect(t.u.applyAtQuit({ restart: false })).toEqual({ applied: true, started: false });
    expect(t.spawned[0].file).toBe(file);
    expect(t.spawned[0].args).toEqual(['--updated', '/S']);
    expect(t.spawned[0].options.detached).toBe(true);
  });

  it('closing normally with auto off applies nothing, a restart still does', async () => {
    const { t } = await ready();
    t.u.setAuto(false);
    expect(t.u.wantsApply(false)).toBe(false);
    expect(t.u.applyAtQuit({ restart: false })).toMatchObject({ applied: false });
    expect(t.spawned).toEqual([]);
    expect(readJson(t.stateFile).ready).not.toBeNull();
    expect(t.u.applyAtQuit({ restart: true })).toEqual({ applied: true, started: true });
    expect(t.spawned).toHaveLength(1);
  });

  it('runs once, however often it is asked', async () => {
    const { t } = await ready();
    t.u.applyAtQuit({ restart: true });
    expect(t.u.applyAtQuit({ restart: true })).toMatchObject({ applied: false });
    expect(t.u.applyAtQuit({ restart: false })).toMatchObject({ applied: false });
    expect(t.spawned).toHaveLength(1);
  });

  it('hands the update over once: the entry goes from update.json, so a refused installer does not come back at every close', async () => {
    const { t } = await ready();
    t.u.applyAtQuit({ restart: false });
    expect(readJson(t.stateFile).ready).toBeNull();
  });

  it('a file that was changed between download and apply is not started and is deleted', async () => {
    for (const change of [
      (file, bytes) => fs.writeFileSync(file, payload(99, bytes.length)),
      (file, bytes) => fs.writeFileSync(file, bytes.subarray(0, bytes.length - 1)),
      (file, bytes) => fs.appendFileSync(file, 'x'),
      (file) => fs.rmSync(file),
    ]) {
      for (const restart of [true, false]) {
        const { t, bytes, file } = await ready();
        change(file, bytes);
        const result = t.u.applyAtQuit({ restart });
        expect(result.applied).toBe(false);
        expect(result.why).toMatch(/changed on disk/);
        expect(t.spawned).toEqual([]);
        expect(fs.existsSync(file)).toBe(false);
        expect(readJson(t.stateFile).ready).toBeNull();
        expect(t.u.state().phase).toBe('failed');
        t.u.dispose();
      }
    }
  });

  it('a failed restart says which file main should bring back, and never starts anything itself', async () => {
    const { t, bytes, file } = await ready();
    fs.writeFileSync(file, payload(98, bytes.length));
    const result = t.u.applyAtQuit({ restart: true });
    expect(result.relaunch).toBe(path.join(t.dir, 'app', 'ncut.exe'));
    expect(t.spawned).toEqual([]);
    const { t: t2, bytes: b2, file: f2 } = await ready();
    fs.writeFileSync(f2, payload(98, b2.length));
    expect(t2.u.applyAtQuit({ restart: false }).relaunch).toBeUndefined();
  });

  it('a hash that is not done in time applies nothing and keeps the file', async () => {
    const h = clockAndTimers();
    const slowFs = { ...fs, readSync: (...a) => { h.clock.t += 5_000; return fs.readSync(...a); } };
    const { t, file } = await ready({ h, opts: { fs: slowFs, applyBudgetMs: 2000 } });
    const result = t.u.applyAtQuit({ restart: true });
    expect(result).toMatchObject({ applied: false });
    expect(result.why).toMatch(/took too long/);
    expect(t.spawned).toEqual([]);
    expect(fs.existsSync(file)).toBe(true);
    expect(readJson(t.stateFile).ready).not.toBeNull();
  });

  it('a spawn that throws is an error in the result, not a crash, and the download stays ready', async () => {
    const bytes = payload(32);
    const h = clockAndTimers();
    const t = setup({ h, handler: github(releaseFor(bytes), bytes), opts: { spawn: () => { throw Object.assign(new Error('nope'), { code: 'EACCES' }); } } });
    await downloaded(t);
    const result = t.u.applyAtQuit({ restart: true });
    expect(result.applied).toBe(false);
    expect(result.why).toMatch(/could not be started/);
    expect(result.relaunch).toBe(path.join(t.dir, 'app', 'ncut.exe'));
    expect(readJson(t.stateFile).ready).not.toBeNull();
    expect(fs.existsSync(path.join(t.updates, 'ncut-0.3.0-setup.exe'))).toBe(true);
  });

  it('an installer that has no process (it could not be started) is not reported as applied and stays ready', async () => {
    const bytes = payload(34);
    const spawned = [];
    const noPid = (file, args) => {
      spawned.push({ file, args });
      return { pid: undefined, on() {}, unref() {} };
    };
    for (const restart of [true, false]) {
      const t = setup({ handler: github(releaseFor(bytes), bytes), opts: { spawn: noPid } });
      await downloaded(t);
      const result = t.u.applyAtQuit({ restart });
      expect(result).toMatchObject({ applied: false, started: false });
      expect(result.why).toMatch(/installer could not be started/);
      expect(readJson(t.stateFile).ready).toMatchObject({ version: '0.3.0' });
      expect(fs.existsSync(path.join(t.updates, 'ncut-0.3.0-setup.exe'))).toBe(true);
      expect(t.u.state()).toMatchObject({ phase: 'failed' });
      t.u.dispose();
    }
    expect(spawned).toHaveLength(2);
  });

  it('an error event of the started installer is logged, not thrown', async () => {
    const bytes = payload(39);
    const child = new EventEmitter();
    child.pid = 77;
    child.unref = () => {};
    const t = setup({ handler: github(releaseFor(bytes), bytes), opts: { spawn: () => child } });
    await downloaded(t);
    expect(t.u.applyAtQuit({ restart: false })).toEqual({ applied: true, started: false });
    child.emit('error', Object.assign(new Error('late'), { code: 'EACCES' }));
    expect(t.logs.join('\n')).toMatch(/a started file failed \(EACCES\)/);
  });

  it('the apply step still works after dispose (main applies in will-quit and disposes after that)', async () => {
    const { t } = await ready();
    expect(t.u.wantsApply(true)).toBe(true);
    t.u.dispose();
    expect(t.u.wantsApply(true)).toBe(true);
    expect(t.u.applyAtQuit({ restart: true }).applied).toBe(true);
  });

  it('nothing ready, nothing to apply', async () => {
    const t = setup({});
    await t.u.init();
    expect(t.u.wantsApply(true)).toBe(false);
    expect(t.u.canRestart()).toBe(false);
    expect(t.u.applyAtQuit({ restart: true })).toMatchObject({ applied: false });
    expect(t.spawned).toEqual([]);
  });

  it('a running download is stopped when the app applies', async () => {
    const bytes = payload(33);
    const t = setup({ handler: github(releaseFor(bytes), bytes, { body: stalling(bytes.subarray(0, 100)) }) });
    await t.u.init();
    t.u.check();
    await until(() => t.u.state().phase === 'downloading');
    expect(t.u.wantsApply(true)).toBe(false);
    t.u.dispose();
    await until(() => !fs.existsSync(path.join(t.updates, 'ncut-0.3.0-setup.exe.part')));
  });
});

// ---------- applying: the portable file ----------

describe('applying an update of the portable app', () => {
  /** a portable ncut with a downloaded update: the exe in its own folder, the helper as it sits in the app */
  async function portable(over = {}) {
    const bytes = payload(40);
    const pdir = tmpDir();
    const exe = path.join(pdir, 'ncut.exe');
    fs.writeFileSync(exe, 'OLD-EXE');
    const helper = path.join(tmpDir(), 'ncut-swap.exe');
    fs.writeFileSync(helper, 'HELPER');
    const t = setup({
      handler: github(releaseFor(bytes, { kind: 'portable' }), bytes),
      ...over,
      opts: { kind: 'portable', portableFile: exe, swapHelper: helper, ...(over.opts ?? {}) },
    });
    await downloaded(t);
    return { t, bytes, exe, pdir, helper, file: path.join(t.updates, 'ncut-0.3.0-portable.exe') };
  }

  it('downloads the portable file', async () => {
    const { t } = await portable();
    expect(t.net.calls[1].url).toBe(`${DL_PREFIX}v0.3.0/ncut-0.3.0-portable.exe`);
    expect(t.u.state().kind).toBe('portable');
  });

  it('hands the swap to the helper: a copy of it in the updates folder, started detached with the file, the place, the hash and the size', async () => {
    const { t, bytes, exe, pdir, file } = await portable();
    const result = t.u.applyAtQuit({ restart: true });
    expect(result).toEqual({ applied: true, started: true });
    const copy = path.join(t.updates, 'ncut-swap.exe');
    expect(fs.readFileSync(copy, 'utf8')).toBe('HELPER');
    expect(t.spawned).toHaveLength(1);
    expect(t.spawned[0].file).toBe(copy);
    expect(t.spawned[0].args).toEqual([file, exe, sha(bytes), String(bytes.length), 'start']);
    expect(t.spawned[0].options).toMatchObject({ shell: false, stdio: 'ignore', detached: true, windowsHide: true, cwd: t.updates });
    // the app itself touches neither the exe nor the download: the helper does that once ncut is gone
    expect(fs.readFileSync(exe, 'utf8')).toBe('OLD-EXE');
    expect(fs.readdirSync(pdir)).toEqual(['ncut.exe']);
    expect(fs.readFileSync(file).equals(bytes)).toBe(true);
    // and the entry stays: the new version drops it when it starts, a swap that did not happen is tried again
    expect(readJson(t.stateFile).ready).toMatchObject({ version: '0.3.0', file });
  });

  it('a normal close tells the helper not to start the new exe', async () => {
    const { t, exe, file, bytes } = await portable();
    expect(t.u.applyAtQuit({ restart: false })).toEqual({ applied: true, started: false });
    expect(t.spawned).toHaveLength(1);
    expect(t.spawned[0].args).toEqual([file, exe, sha(bytes), String(bytes.length), 'quiet']);
  });

  it('a restart passes the profile folder the app was started with on to the new exe, and nothing else', async () => {
    const { t } = await portable({ opts: { restartArgs: ['--user-data-dir=E:\\profile', 7, '--other'] } });
    expect(t.u.applyAtQuit({ restart: true })).toEqual({ applied: true, started: true });
    expect(t.spawned[0].args.slice(4)).toEqual(['start', '--user-data-dir=E:\\profile']);
  });

  it('closing normally with auto off hands nothing over, a restart still does', async () => {
    const { t } = await portable();
    t.u.setAuto(false);
    expect(t.u.applyAtQuit({ restart: false })).toMatchObject({ applied: false });
    expect(t.spawned).toEqual([]);
    expect(t.u.applyAtQuit({ restart: true })).toEqual({ applied: true, started: true });
    expect(t.spawned).toHaveLength(1);
  });

  it('runs once, however often it is asked', async () => {
    const { t } = await portable();
    t.u.applyAtQuit({ restart: false });
    expect(t.u.applyAtQuit({ restart: true })).toMatchObject({ applied: false });
    expect(t.spawned).toHaveLength(1);
  });

  it('a folder that can not be written is found before any helper starts, and the download stays ready', async () => {
    for (const code of ['EACCES', 'EPERM', 'EROFS', 'ENOSPC']) {
      const calls = [];
      const fsApi = {
        ...fs,
        openSync(file, flags, ...rest) {
          calls.push([String(file), flags]);
          if (flags === 'wx') throw Object.assign(new Error(code), { code });
          return fs.openSync(file, flags, ...rest);
        },
      };
      const { t, exe, pdir, file } = await portable({ opts: { fs: fsApi } });
      const result = t.u.applyAtQuit({ restart: true });
      expect(result.applied, code).toBe(false);
      expect(result.why, code).toBe(code === 'ENOSPC' ? 'there is no room left next to ncut' : 'the folder of ncut can not be written');
      // a failed restart: main brings the exe back that was running
      expect(result.relaunch).toBe(exe);
      expect(calls).toContainEqual([`${exe}.check`, 'wx']);
      expect(t.spawned).toEqual([]);
      expect(fs.existsSync(path.join(t.updates, 'ncut-swap.exe'))).toBe(false);
      expect(fs.readdirSync(pdir)).toEqual(['ncut.exe']);
      expect(fs.existsSync(file)).toBe(true);
      expect(readJson(t.stateFile).ready).toMatchObject({ version: '0.3.0' });
      expect(t.u.state()).toMatchObject({ phase: 'failed', error: result.why });
    }
  });

  it('the probe leaves nothing next to the exe, also when an old probe file was in the way', async () => {
    const { t, exe, pdir } = await portable();
    fs.writeFileSync(`${exe}.check`, 'left over');
    expect(t.u.applyAtQuit({ restart: false })).toEqual({ applied: true, started: false });
    expect(fs.readdirSync(pdir)).toEqual(['ncut.exe']);
  });

  it('a helper that is still at work from the close before is left to it: nothing is started twice', async () => {
    for (const code of ['EBUSY', 'EPERM']) {
      const fsApi = {
        ...fs,
        copyFileSync() {
          throw Object.assign(new Error(code), { code });
        },
      };
      const { t, file } = await portable({ opts: { fs: fsApi } });
      const result = t.u.applyAtQuit({ restart: false });
      expect(result).toMatchObject({ applied: false, why: 'an earlier update step is still running' });
      expect(result.relaunch).toBeUndefined();
      expect(t.spawned).toEqual([]);
      expect(fs.existsSync(file)).toBe(true);
      expect(readJson(t.stateFile).ready).toMatchObject({ version: '0.3.0' });
    }
  });

  it('a helper that can not be copied or started is an error in the result, and the download stays ready', async () => {
    const noCopy = await portable({
      opts: {
        fs: {
          ...fs,
          copyFileSync() {
            throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
          },
        },
      },
    });
    expect(noCopy.t.u.applyAtQuit({ restart: true })).toMatchObject({ applied: false, why: 'the update helper could not be put in place', relaunch: noCopy.exe });
    expect(noCopy.t.spawned).toEqual([]);

    for (const spawn of [
      () => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      },
      // no process came to be: nothing has a pid
      () => ({ on() {}, unref() {} }),
    ]) {
      const { t, exe, file } = await portable({ opts: { spawn } });
      const result = t.u.applyAtQuit({ restart: true });
      expect(result).toMatchObject({ applied: false, started: false, why: 'the update helper could not be started', relaunch: exe });
      expect(fs.existsSync(file)).toBe(true);
      expect(readJson(t.stateFile).ready).toMatchObject({ version: '0.3.0' });
    }
  });

  it('a download that is gone is dropped and nothing is started', async () => {
    const { t, file } = await portable();
    fs.unlinkSync(file);
    const result = t.u.applyAtQuit({ restart: false });
    expect(result).toMatchObject({ applied: false, why: 'the downloaded update is gone' });
    expect(t.spawned).toEqual([]);
    expect(readJson(t.stateFile).ready).toBeNull();
  });

  it('an exe that is not at its place any more gets no helper', async () => {
    const { t, exe } = await portable();
    fs.unlinkSync(exe);
    expect(t.u.applyAtQuit({ restart: false })).toMatchObject({ applied: false, why: 'ncut is not at the place it was started from' });
    expect(t.spawned).toEqual([]);
  });

  it('closing does not hash the big file: the helper checks it, so a slow disk can not hold the quit', async () => {
    let reads = 0;
    const fsApi = {
      ...fs,
      readSync(...a) {
        reads++;
        return fs.readSync(...a);
      },
    };
    const { t } = await portable({ opts: { fs: fsApi, applyBudgetMs: -1 } });
    expect(t.u.applyAtQuit({ restart: false })).toEqual({ applied: true, started: false });
    expect(reads).toBe(0);
  });

  it('the new version drops the entry when it starts, and the helper copy and its note go with the clean up', async () => {
    const { t, exe, file } = await portable();
    t.u.applyAtQuit({ restart: true });
    t.u.dispose();
    // what the helper leaves when it worked: the download is gone, its own exe and its note are still there
    fs.unlinkSync(file);
    fs.writeFileSync(path.join(t.updates, 'swap.log'), '0\n');
    const next = setup({ dir: t.dir, opts: { kind: 'portable', portableFile: exe, swapHelper: path.join(t.updates, '..', 'h.exe'), appVersion: '0.3.0' } });
    // (no helper file at that path: the app is a manual one then, and still cleans up)
    await next.u.init();
    expect(readJson(t.stateFile).ready).toBeNull();
    expect(fs.readdirSync(t.updates)).toEqual([]);
    expect(next.logs.join('\n')).not.toMatch(/swap/);
  });

  it('a swap that did not work is found at the next start: it goes to the log, and the update is ready again', async () => {
    const { t, exe, helper } = await portable();
    t.u.applyAtQuit({ restart: false });
    t.u.dispose();
    fs.writeFileSync(path.join(t.updates, 'swap.log'), '7\n');
    const next = setup({ dir: t.dir, opts: { kind: 'portable', portableFile: exe, swapHelper: helper } });
    await next.u.init();
    expect(next.logs.join('\n')).toContain('the last swap of the exe did not work: the exe stayed in use');
    expect(next.u.state()).toMatchObject({ phase: 'ready', latest: '0.3.0' });
    expect(next.u.wantsApply(false)).toBe(true);
    // the note is read once: the clean up took it
    expect(fs.existsSync(path.join(t.updates, 'swap.log'))).toBe(false);
  });

  it('a note of the helper that is not a small number is ignored', async () => {
    const { t, exe, helper } = await portable();
    t.u.dispose();
    for (const text of ['', 'C:\\somewhere\\x.exe', '9999', '-1', '7 and more text that goes on']) {
      fs.writeFileSync(path.join(t.updates, 'swap.log'), text);
      const next = setup({ dir: t.dir, opts: { kind: 'portable', portableFile: exe, swapHelper: helper } });
      await next.u.init();
      expect(next.logs.join('\n'), text).not.toMatch(/swap/);
      next.u.dispose();
    }
  });

  it('on the next start the .old next to the exe goes, a fresh .new stays (a helper may still need it), a stale one goes', async () => {
    const { t, exe, pdir, helper } = await portable();
    t.u.dispose();
    fs.writeFileSync(`${exe}.old`, 'the exe of before');
    fs.writeFileSync(`${exe}.old2`, 'x');
    fs.writeFileSync(path.join(pdir, 'other.exe.old'), 'x');
    fs.writeFileSync(`${exe}.new`, 'a copy in the making');
    // the test clock is far from the real one: the file gets a time on that clock
    const stamp = (ms) => fs.utimesSync(`${exe}.new`, new Date(ms), new Date(ms));
    stamp(t.h.clock.t - 60_000);
    const next = setup({ dir: t.dir, h: t.h, opts: { kind: 'portable', portableFile: exe, swapHelper: helper } });
    await next.u.init();
    expect(fs.readdirSync(pdir).sort()).toEqual(['ncut.exe', 'ncut.exe.new', 'ncut.exe.old2', 'other.exe.old']);
    next.u.dispose();
    stamp(t.h.clock.t - rules.STALE_NEW_MS - 1000);
    const later = setup({ dir: t.dir, h: t.h, opts: { kind: 'portable', portableFile: exe, swapHelper: helper } });
    await later.u.init();
    expect(fs.readdirSync(pdir).sort()).toEqual(['ncut.exe', 'ncut.exe.old2', 'other.exe.old']);
    // a folder with that name is not touched
    fs.mkdirSync(`${exe}.old`);
    fs.writeFileSync(path.join(`${exe}.old`, 'inside'), 'x');
    later.u.dispose();
    const again = setup({ dir: t.dir, h: t.h, opts: { kind: 'portable', portableFile: exe, swapHelper: helper } });
    await again.u.init();
    expect(fs.existsSync(path.join(`${exe}.old`, 'inside'))).toBe(true);
  });

  it('a portable app without the helper can not replace itself: it is a manual one', async () => {
    const pdir = tmpDir();
    const exe = path.join(pdir, 'ncut.exe');
    fs.writeFileSync(exe, 'x');
    for (const swapHelper of [undefined, null, '', path.join(pdir, 'missing.exe'), pdir]) {
      const t = setup({ opts: { kind: 'portable', portableFile: exe, swapHelper } });
      expect(t.u.state().kind, String(swapHelper)).toBe('manual');
    }
    const helper = path.join(pdir, 'ncut-swap.exe');
    fs.writeFileSync(helper, 'x');
    expect(setup({ opts: { kind: 'portable', portableFile: exe, swapHelper: helper } }).u.state().kind).toBe('portable');
  });

  it('a portable file that is not believable makes the app a manual one', () => {
    const helper = path.join(tmpDir(), 'ncut-swap.exe');
    fs.writeFileSync(helper, 'x');
    for (const bad of ['ncut.exe', '', null, undefined, 'C:\\x\\a"b.exe', path.join(os.tmpdir(), 'x.txt')]) {
      const t = setup({ opts: { kind: 'portable', portableFile: bad, swapHelper: helper } });
      expect(t.u.state().kind, String(bad)).toBe('manual');
    }
  });
});

// ---------- the other kinds ----------

describe('the kinds that download nothing', () => {
  it('manual checks and says a version is out, but never downloads', async () => {
    const bytes = payload(50);
    const t = setup({ handler: github(releaseFor(bytes), bytes), opts: { kind: 'manual' } });
    await t.u.init();
    await t.h.advance(15_000);
    await until(() => t.u.state().latest === '0.3.0');
    expect(t.u.state()).toMatchObject({ kind: 'manual', phase: 'idle', latest: '0.3.0', current: '0.2.0', error: null });
    expect(t.net.calls).toHaveLength(1);
    expect(t.u.canRestart()).toBe(false);
    expect(t.u.wantsApply(true)).toBe(false);
    expect(t.u.applyAtQuit({ restart: true })).toMatchObject({ applied: false });
    expect(t.spawned).toEqual([]);
    expect(fs.existsSync(t.updates) ? fs.readdirSync(t.updates) : []).toEqual([]);
  });

  it('manual needs no file in the release', async () => {
    const t = setup({ handler: () => json({ tag_name: 'v0.5.0', draft: false, prerelease: false, assets: [] }), opts: { kind: 'manual' } });
    await t.u.init();
    t.u.check();
    await until(() => t.u.state().latest === '0.5.0');
    expect(t.u.state().phase).toBe('idle');
  });

  it('manual with auto off asks nothing on its own', async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'update.json'), JSON.stringify({ auto: false }));
    const t = setup({ dir, opts: { kind: 'manual' } });
    await t.u.init();
    await t.h.advance(24 * 3600_000);
    expect(t.net.calls).toHaveLength(0);
  });

  it('none has no updater at all', async () => {
    for (const opts of [{ kind: 'none' }, { kind: 'banana' }, { appVersion: 'dev' }]) {
      const t = setup({ opts });
      await t.u.init();
      expect(t.u.check().kind).toBe('none');
      await t.h.advance(48 * 3600_000);
      expect(t.net.calls).toHaveLength(0);
      expect(t.u.canRestart()).toBe(false);
      expect(t.u.applyAtQuit({ restart: true })).toMatchObject({ applied: false });
      expect(t.h.pending()).toBe(0);
      expect(fs.existsSync(t.stateFile)).toBe(false);
    }
  });
});

// ---------- what the page is told ----------

describe('the state that leaves', () => {
  it('has exactly the contract fields and never a path, an address or a file name', async () => {
    const bytes = payload(60);
    const pdir = tmpDir();
    const exe = path.join(pdir, 'ncut.exe');
    fs.writeFileSync(exe, 'OLD-EXE');
    const failingFs = {
      ...fs,
      openSync: (p, flags, ...rest) => {
        if (String(p).endsWith('.check')) throw Object.assign(new Error(`denied ${p}`), { code: 'EACCES' });
        return fs.openSync(p, flags, ...rest);
      },
    };
    const helper = path.join(pdir, 'ncut-swap.exe');
    fs.writeFileSync(helper, 'HELPER');
    const t = setup({
      handler: github(releaseFor(bytes, { kind: 'portable' }), bytes),
      opts: { kind: 'portable', portableFile: exe, swapHelper: helper, fs: failingFs },
    });
    await downloaded(t);
    t.u.applyAtQuit({ restart: true });
    expect(t.states.length).toBeGreaterThan(3);
    for (const s of [...t.states, t.u.state()]) {
      expect(Object.keys(s).sort()).toEqual(['auto', 'checkedAt', 'current', 'error', 'kind', 'latest', 'phase', 'progress']);
      const text = JSON.stringify(s);
      expect(text).not.toMatch(/[A-Za-z]:[\\/]|\\\\|\.exe|\.part|https?:|githubusercontent/);
      expect(text).not.toContain(path.basename(t.dir));
      expect(text).not.toContain(path.basename(pdir));
    }
  });

  it('a listener that throws does not break the updater', async () => {
    const t = setup({ handler: () => json(releaseFor(payload(1), { version: '0.2.0' })) });
    t.u.onChange(() => {
      throw new Error('bad listener');
    });
    await t.u.init();
    t.u.check();
    await until(() => t.u.state().phase === 'idle' && t.u.state().checkedAt !== null);
  });
});

// ---------- the bridge of the page: preload.cjs ----------

describe('the update bridge in preload.cjs', () => {
  /** runs the real preload source against a fake electron and hands back what it exposed and what it sent */
  function loadPreload() {
    const exposed = {};
    const invoked = [];
    const handlers = new Map();
    let answer = () => undefined;
    const ipcRenderer = {
      sendSync: () => '0.2.0',
      send() {},
      invoke(channel, ...args) {
        invoked.push({ channel, args });
        return Promise.resolve().then(() => answer(channel, ...args));
      },
      on(channel, fn) {
        handlers.set(channel, fn);
      },
      removeListener(channel, fn) {
        if (handlers.get(channel) === fn) handlers.delete(channel);
      },
    };
    const fakeRequire = (name) => {
      if (name !== 'electron') throw new Error(`the preload may only require electron, not ${name}`);
      return { contextBridge: { exposeInMainWorld: (key, api) => (exposed[key] = api) }, ipcRenderer };
    };
    const source = fs.readFileSync(path.join(path.dirname(require.resolve('./update.cjs')), 'preload.cjs'), 'utf8');
    new Function('require', 'module', 'exports', source)(fakeRequire, { exports: {} }, {});
    return { api: exposed.ncutShell, invoked, handlers, setAnswer: (fn) => (answer = fn) };
  }

  const fromMain = (over = {}) => ({
    kind: 'installed',
    auto: true,
    phase: 'ready',
    current: '0.2.0',
    latest: '0.3.0',
    progress: 0,
    error: null,
    checkedAt: 1_800_000_000_000,
    ...over,
  });

  it('exposes a frozen update object with exactly the contract functions', () => {
    const { api } = loadPreload();
    expect(Object.isFrozen(api.update)).toBe(true);
    expect(Object.keys(api.update).sort()).toEqual(['check', 'onState', 'openPage', 'restart', 'setAuto', 'state']);
  });

  it('passes the running and the newest version through (a real version is not dropped)', async () => {
    const { api, setAnswer } = loadPreload();
    setAnswer(() => fromMain());
    for (const call of [() => api.update.state(), () => api.update.check(), () => api.update.setAuto(true)]) {
      expect(await call()).toEqual(fromMain());
    }
    setAnswer(() => fromMain({ current: '12.345.6789', latest: '99999.0.1' }));
    expect(await api.update.state()).toMatchObject({ current: '12.345.6789', latest: '99999.0.1' });
  });

  it('events from main are cleaned the same way and a version stays a version', () => {
    const { api, handlers } = loadPreload();
    const seen = [];
    const off = api.update.onState((s) => seen.push(s));
    const handler = handlers.get('ncut:update-changed');
    handler({}, fromMain({ phase: 'downloading', progress: 0.5 }));
    handler({}, 'not a state');
    expect(seen).toEqual([fromMain({ phase: 'downloading', progress: 0.5 })]);
    off();
    expect(handlers.has('ncut:update-changed')).toBe(false);
  });

  it('a value that is not a version is dropped, and the contract fields are all that is left', async () => {
    const { api, setAnswer } = loadPreload();
    for (const bad of ['0.3', 'v0.3.0', '0.3.0 ', '01.2.3', '1.2.3.4', '1.2.-3', '123456.0.0', 'd.d.d', '0.3.0\n', 5, null, {}]) {
      setAnswer(() => fromMain({ latest: bad, current: bad, secret: String.raw`C:\Users\me\x.exe`, file: '/tmp/x' }));
      const s = await api.update.state();
      expect(s.latest, String(bad)).toBeNull();
      expect(s.current, String(bad)).toBe('');
      expect(Object.keys(s).sort()).toEqual(['auto', 'checkedAt', 'current', 'error', 'kind', 'latest', 'phase', 'progress']);
    }
  });

  it('an answer that is no state, or no answer at all, is "no updater"', async () => {
    const { api, setAnswer } = loadPreload();
    for (const answer of [() => null, () => 'x', () => { throw new Error('gone'); }]) {
      setAnswer(answer);
      expect(await api.update.state()).toEqual({ kind: 'none', auto: true, phase: 'idle', current: '0.2.0', latest: null, progress: 0, error: null, checkedAt: null });
    }
  });

  it('agrees with the rules file about what a version is', async () => {
    const { api, setAnswer } = loadPreload();
    for (const v of ['0.0.0', '0.2.0', '1.22.3', '99999.99999.99999', '00.1.2', '1.2', '1.2.3.4', 'a.b.c', '100000.0.0', '-1.0.0', '1.02.3']) {
      setAnswer(() => fromMain({ latest: v }));
      const got = (await api.update.state()).latest;
      expect(got, v).toBe(rules.parseVersion(v) ? v : null);
    }
  });

  it('sends nothing but a boolean, and only to the channels of the contract', async () => {
    const { api, invoked, setAnswer } = loadPreload();
    setAnswer(() => fromMain());
    await api.update.setAuto('yes');
    await api.update.setAuto(1);
    await api.update.setAuto(true);
    await api.update.check(String.raw`C:\evil.exe`);
    await api.update.restart({ file: 'x' });
    await api.update.openPage('https://evil.example');
    await api.update.state('x');
    expect(invoked).toEqual([
      { channel: 'ncut:update-auto', args: [false] },
      { channel: 'ncut:update-auto', args: [false] },
      { channel: 'ncut:update-auto', args: [true] },
      { channel: 'ncut:update-check', args: [] },
      { channel: 'ncut:update-restart', args: [] },
      { channel: 'ncut:update-open', args: [] },
      { channel: 'ncut:update-state', args: [] },
    ]);
  });

  it('restart and openPage answer true only for true', async () => {
    const { api, setAnswer } = loadPreload();
    setAnswer(() => 1);
    expect(await api.update.restart()).toBe(false);
    expect(await api.update.openPage()).toBe(false);
    setAnswer(() => true);
    expect(await api.update.restart()).toBe(true);
    expect(await api.update.openPage()).toBe(true);
    setAnswer(() => { throw new Error('gone'); });
    expect(await api.update.restart()).toBe(false);
  });
});
