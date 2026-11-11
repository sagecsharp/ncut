'use strict';
/**
 * the mcp server of the desktop app (docs/MCP.md): a small http server on 127.0.0.1 that relays tool calls to the page.
 * main owns the socket, the token, the files and the clipboard, the page owns the tools. everything electron-ish
 * is handed in (createMcp options) so this runs under plain node in the tests. the decisions are in mcpRules.cjs.
 * nothing here may throw into main, and the token and request bodies are never logged.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const rules = require('./mcpRules.cjs');

/**
 * @param {object} opts
 * @param {string} opts.userDataDir where mcp.json and mcp-bridge.cjs live
 * @param {string} opts.appVersion
 * @param {string} opts.bridgeSource the text of mcpBridge.cjs
 * @param {(call: object) => boolean} opts.sendCall hands a call to the page, false when there is no ready window
 * @param {(text: string) => void} opts.writeClipboard
 * @param {() => string} opts.saveFolder the folder a ticket save goes to (exists)
 * @param {(message: string) => void} [opts.log]
 * @param {(file: string) => void} [opts.onSaved] a ticket file was saved to this path
 * @param {{ list?: number, call?: number, arm?: number, ttl?: number }} [opts.timing] in ms, for tests
 * @param {{ first?: number, tries?: number }} [opts.ports] for tests
 * @param {{ inFlight?: number }} [opts.limits] for tests
 */
function createMcp(opts) {
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const timing = { list: rules.LIST_TIMEOUT_MS, call: rules.CALL_TIMEOUT_MS, arm: rules.ARM_TIMEOUT_MS, ttl: rules.TICKET_TTL_MS, ...(opts.timing ?? {}) };
  const limits = { inFlight: rules.MAX_BYTES_IN_FLIGHT, ...(opts.limits ?? {}) };
  const configFile = path.join(opts.userDataDir, 'mcp.json');
  const bridgeFile = path.join(opts.userDataDir, 'mcp-bridge.cjs');

  let config = { enabled: false, port: 0, token: '' };
  let server = null;
  let livePort = 0;
  let running = false;
  let error = null;
  let bridgeOk = false;
  let disposed = false;
  /** bumped when the server stops: a call that began before does not go on after */
  let epoch = 0;
  /** bytes of files read for calls that have not settled yet */
  let inFlightBytes = 0;
  const sockets = new Set();
  const listeners = new Set();

  // ---------- small io helpers ----------

  /** a file that is either the old content or the new one, never half of it */
  function writeAtomic(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(tmp, text, { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (e) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* nothing was written */
      }
      throw e;
    }
  }

  function saveConfig() {
    try {
      writeAtomic(configFile, JSON.stringify(config));
      return true;
    } catch (e) {
      log(`mcp: could not save mcp.json (${e && e.code ? e.code : 'error'})`);
      return false;
    }
  }

  function loadConfig() {
    try {
      config = rules.cleanConfig(JSON.parse(fs.readFileSync(configFile, 'utf8')));
    } catch {
      config = { enabled: false, port: 0, token: '' };
    }
  }

  function newToken() {
    return crypto.randomBytes(32).toString('base64url');
  }

  /** the bridge script next to mcp.json: written when missing or different. returns whether it is in place */
  function syncBridge(write) {
    const src = opts.bridgeSource;
    if (typeof src !== 'string' || src === '') return (bridgeOk = false);
    try {
      let same = false;
      try {
        same = fs.readFileSync(bridgeFile, 'utf8') === src;
      } catch {
        same = false;
      }
      if (!same && write) writeAtomic(bridgeFile, src);
      bridgeOk = same || write;
    } catch (e) {
      log(`mcp: could not write the bridge script (${e && e.code ? e.code : 'error'})`);
      bridgeOk = false;
    }
    return bridgeOk;
  }

  // ---------- state ----------

  function state() {
    return { enabled: config.enabled, running, port: running ? livePort : config.port, error, bridge: bridgeOk };
  }

  function emit() {
    for (const cb of [...listeners]) {
      try {
        cb(state());
      } catch (e) {
        log(`mcp: a state listener failed (${e && e.message ? e.message : 'error'})`);
      }
    }
  }

  function onChange(cb) {
    if (typeof cb !== 'function') return () => {};
    listeners.add(cb);
    return () => listeners.delete(cb);
  }

  // ---------- the pending calls ----------

  let nextId = 1;
  /** calls that hold a slot (reading files or waiting for the page) */
  let slots = 0;
  /** id -> { kind, resolve, timer } for calls the page has in its hands */
  const pending = new Map();

  function settle(id, out) {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    p.resolve(out);
  }

  /** hand a call to the page and wait. resolves { notReady } | { timeout } | { bad } | { gone } | { value } */
  function ask(call, timeoutMs) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => settle(call.id, { timeout: true }), timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      pending.set(call.id, { kind: call.kind, resolve, timer });
      let sent = false;
      try {
        sent = opts.sendCall(call) === true;
      } catch (e) {
        log(`mcp: sending a call failed (${e && e.message ? e.message : 'error'})`);
      }
      if (!sent) settle(call.id, { notReady: true });
    });
  }

  /** the page answered (ncut:mcp-reply). anything it should not send is dropped */
  function reply(id, json) {
    try {
      if (typeof id !== 'number' || !Number.isSafeInteger(id)) return;
      const p = pending.get(id);
      if (!p) return;
      const got = rules.cleanReply(json, p.kind);
      settle(id, got.ok ? { value: got.value } : { bad: true });
    } catch (e) {
      log(`mcp: a reply could not be read (${e && e.message ? e.message : 'error'})`);
    }
  }

  const OFF_TEXT = 'the mcp server was turned off while this ran';
  const RELOADED_TEXT = 'the ncut window was reloaded or closed while this ran';

  /** every call the page holds ends now. `why` is what the client reads */
  function failAllPending(why) {
    for (const id of [...pending.keys()]) settle(id, { gone: why });
  }

  /** the page was reloaded or is gone: nothing will answer the calls that wait on it */
  function failPending(reason) {
    try {
      failAllPending(typeof reason === 'string' && reason !== '' ? reason : RELOADED_TEXT);
    } catch (e) {
      log(`mcp: failing the waiting calls went wrong (${e && e.message ? e.message : 'error'})`);
    }
  }

  // ---------- save tickets ----------

  /** ticket -> { at, armed, resolve, timer } */
  const tickets = new Map();
  /** ticket -> full path of the finished file */
  const savedPaths = new Map();
  const failed = () => ({ ok: false, name: null });

  function dropTicket(ticket) {
    const t = tickets.get(ticket);
    if (!t) return;
    tickets.delete(ticket);
    clearTimeout(t.timer);
    if (t.resolve) t.resolve(failed());
  }

  function pruneTickets() {
    const now = Date.now();
    for (const [ticket, t] of [...tickets]) if (now - t.at > timing.ttl) dropTicket(ticket);
  }

  function grantTicket(ticket) {
    pruneTickets();
    // the oldest ticket that was never armed goes first: a running export's ticket is armed
    while (tickets.size >= rules.MAX_TICKETS) {
      let victim;
      for (const [k, t] of tickets) {
        if (!t.armed) {
          victim = k;
          break;
        }
      }
      dropTicket(victim === undefined ? tickets.keys().next().value : victim);
    }
    tickets.set(ticket, { at: Date.now(), armed: false, resolve: null, timer: null });
    return ticket;
  }

  /** the page is about to start the download of a ticket's file. resolves when it is on disk (or not) */
  function armSave(ticket) {
    return new Promise((resolve) => {
      try {
        pruneTickets();
        const t = typeof ticket === 'number' && Number.isSafeInteger(ticket) ? tickets.get(ticket) : undefined;
        if (!t || t.armed) {
          resolve(failed());
          return;
        }
        t.armed = true;
        t.resolve = resolve;
        // a download that never comes must not keep the page waiting
        t.timer = setTimeout(() => dropTicket(ticket), timing.arm);
        if (typeof t.timer.unref === 'function') t.timer.unref();
      } catch (e) {
        log(`mcp: arming a save failed (${e && e.message ? e.message : 'error'})`);
        resolve(failed());
      }
    });
  }

  /** a file made now, named like the wanted one but never over another: ` (2)`, ` (3)` ... */
  function reserveName(folder, wanted) {
    let made = null;
    try {
      const name = rules.uniqueName(wanted, (candidate) => {
        const full = path.join(folder, candidate);
        try {
          fs.closeSync(fs.openSync(full, 'wx'));
          made = full;
          return false;
        } catch (e) {
          // only a name that exists is taken. any other error (no folder, no rights) would fail 9999 times
          if (e && e.code === 'EEXIST') return true;
          throw e;
        }
      });
      return name === null || made === null ? null : { name, path: made };
    } catch (e) {
      log(`mcp: could not make a file for a ticket download (${e && e.code ? e.code : 'error'})`);
      return null;
    }
  }

  function dropEmpty(file) {
    try {
      if (fs.statSync(file).size === 0) fs.unlinkSync(file);
    } catch {
      /* already gone */
    }
  }

  /**
   * main's download handler asks first. true = this download belongs to a ticket (handled: saved or cancelled),
   * false = a normal download, the caller goes on
   */
  function claimDownload(item) {
    let mark = null;
    try {
      mark = rules.parseDownloadName(item.getFilename());
    } catch {
      return false;
    }
    if (!mark) return false;
    let t;
    let target = null;
    try {
      pruneTickets();
      t = tickets.get(mark.ticket);
      // not armed, not ours, too old: the marker alone grants nothing
      if (!t || !t.armed) {
        item.cancel();
        return true;
      }
      // a ticket works once
      tickets.delete(mark.ticket);
      clearTimeout(t.timer);
      const clean = rules.savedFileName(mark.file);
      // only what export_video makes is saved without a dialog
      if (!rules.ticketExtOk(clean)) {
        item.cancel();
        t.resolve(failed());
        return true;
      }
      target = reserveName(opts.saveFolder(), clean);
      if (!target) {
        item.cancel();
        t.resolve(failed());
        return true;
      }
      const done = target;
      const resolve = t.resolve;
      item.setSavePath(done.path);
      item.once('done', (_event, st) => {
        if (st !== 'completed') {
          dropEmpty(done.path);
          resolve(failed());
          return;
        }
        savedPaths.set(mark.ticket, done.path);
        while (savedPaths.size > rules.MAX_SAVED) savedPaths.delete(savedPaths.keys().next().value);
        try {
          if (typeof opts.onSaved === 'function') opts.onSaved(done.path);
        } catch {
          /* the window is gone */
        }
        resolve({ ok: true, name: path.win32.basename(done.path) });
      });
    } catch (e) {
      log(`mcp: a ticket download failed (${e && e.message ? e.message : 'error'})`);
      if (target) dropEmpty(target.path);
      try {
        item.cancel();
      } catch {
        /* already cancelled */
      }
      if (t && t.resolve) t.resolve(failed());
    }
    return true;
  }

  // ---------- files a tool needs ----------

  function readProblem(e) {
    const code = e && e.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'the file does not exist';
    if (code === 'EACCES' || code === 'EPERM' || code === 'EBUSY') return 'ncut is not allowed to read it';
    return 'the file could not be read';
  }

  /** read the checked paths: plain files only, 1 gib in total. { ok, files } or { ok: false, error } */
  async function readFiles(paths, budget) {
    const sizes = [];
    let total = 0;
    for (const p of paths) {
      let st;
      try {
        st = await fs.promises.stat(p);
      } catch (e) {
        return { ok: false, error: rules.pathProblem(p, readProblem(e)) };
      }
      if (!st.isFile()) return { ok: false, error: rules.pathProblem(p, 'it is not a plain file') };
      total += st.size;
      if (total > rules.MAX_FILE_BYTES_PER_CALL) return { ok: false, error: 'the files together are bigger than 1 gib, import fewer at a time' };
      sizes.push(st.size);
    }
    // one budget for all calls: many big imports at once must not fill main's memory
    if (inFlightBytes + total > limits.inFlight) {
      return { ok: false, error: 'other imports are still being read, try again in a moment' };
    }
    inFlightBytes += total;
    budget.held = total;
    const files = [];
    let read = 0;
    for (let i = 0; i < paths.length; i++) {
      let bytes;
      try {
        bytes = await fs.promises.readFile(paths[i]);
      } catch (e) {
        return { ok: false, error: rules.pathProblem(paths[i], readProblem(e)) };
      }
      // a file that grew after the check
      read += bytes.length;
      if (read > rules.MAX_FILE_BYTES_PER_CALL) return { ok: false, error: 'the files together are bigger than 1 gib, import fewer at a time' };
      files.push({ name: path.win32.basename(paths[i]), bytes });
    }
    return { ok: true, files };
  }

  // ---------- one json-rpc request ----------

  const STARTING = 'ncut is still starting or has no editor window ready yet. try again in a moment';

  async function relayList(id) {
    const out = await ask({ id: nextId++, kind: 'list', name: '', args: {}, files: [], ticket: null }, timing.list);
    if (out.value) return rules.rpcResult(id, out.value);
    if (out.notReady) return rules.rpcError(id, rules.SERVER_ERROR, STARTING);
    if (out.timeout) return rules.rpcError(id, rules.SERVER_ERROR, 'ncut did not answer in time. try again in a moment');
    if (out.gone) return rules.rpcError(id, rules.SERVER_ERROR, out.gone);
    return rules.rpcError(id, rules.SERVER_ERROR, 'ncut could not list its tools');
  }

  /** a ticket whose call ended without the page arming it is of no use to anyone */
  function dropUnarmed(ticket) {
    const t = ticket === null ? undefined : tickets.get(ticket);
    if (t && !t.armed) dropTicket(ticket);
  }

  /** the bytes of the files stay counted until the call settles */
  async function relayCall(id, name, args) {
    const budget = { held: 0 };
    try {
      return await relayCallInner(id, name, args, budget);
    } finally {
      inFlightBytes -= budget.held;
    }
  }

  async function relayCallInner(id, name, args, budget) {
    const gen = epoch;
    let files = [];
    let sendArgs = args;
    const spec = rules.fileSpec(name);
    if (spec) {
      const plan = rules.planFiles(spec, args);
      if (!plan.ok) return rules.rpcResult(id, rules.textResult(plan.error, true));
      const read = await readFiles(plan.paths, budget);
      if (!read.ok) return rules.rpcResult(id, rules.textResult(read.error, true));
      // switched off while the files were read: nothing goes to the page now
      if (gen !== epoch || !running) return rules.rpcResult(id, rules.textResult(OFF_TEXT, true));
      files = read.files;
      sendArgs = rules.withoutPathArg(spec, args);
    }
    const callId = nextId++;
    const ticket = rules.wantsTicket(name) ? grantTicket(callId) : null;
    const out = await ask({ id: callId, kind: 'call', name, args: sendArgs, files, ticket }, timing.call);
    // an error answer, or none at all: the export never started, so its ticket is not needed
    if (out.notReady || out.gone || out.bad || (out.value && out.value.isError === true)) dropUnarmed(ticket);
    if (out.notReady) return rules.rpcResult(id, rules.textResult(STARTING, true));
    if (out.timeout) {
      const secs = Math.round(timing.call / 1000);
      return rules.rpcResult(id, rules.textResult(`${name} did not finish within ${secs} seconds. ncut may be busy: call get_state and try again`, true));
    }
    if (out.gone) return rules.rpcResult(id, rules.textResult(out.gone, true));
    if (!out.value) return rules.rpcResult(id, rules.textResult('ncut sent an answer that could not be used', true));
    if (out.value.unknown) return rules.rpcError(id, rules.INVALID_PARAMS, `unknown tool: ${name}`);
    const result = { content: [...out.value.content] };
    if (typeof out.value.isError === 'boolean') result.isError = out.value.isError;
    if (typeof out.value.saved === 'number' && savedPaths.has(out.value.saved)) result.content.push(rules.savedItem(savedPaths.get(out.value.saved)));
    return rules.rpcResult(id, result);
  }

  /** the json-rpc answer for one request message */
  async function answer(msg) {
    const { id, method, params } = msg;
    if (method === 'initialize') return rules.rpcResult(id, rules.initializeResult(params.protocolVersion, opts.appVersion));
    if (method === 'ping') return rules.rpcResult(id, {});
    if (method !== 'tools/list' && method !== 'tools/call') return rules.rpcError(id, rules.METHOD_NOT_FOUND, `method not found: ${method}`);
    let name = '';
    let args = {};
    if (method === 'tools/call') {
      if (typeof params.name !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(params.name)) {
        return rules.rpcError(id, rules.INVALID_PARAMS, 'unknown tool');
      }
      name = params.name;
      const a = params.arguments;
      if (a !== undefined && (typeof a !== 'object' || a === null || Array.isArray(a))) {
        return rules.rpcError(id, rules.INVALID_PARAMS, 'arguments has to be an object');
      }
      args = a ?? {};
    }
    if (slots >= rules.MAX_PENDING) return rules.rpcError(id, rules.SERVER_ERROR, 'too many calls are waiting, try again in a moment');
    slots++;
    try {
      return method === 'tools/list' ? await relayList(id) : await relayCall(id, name, args);
    } finally {
      slots--;
    }
  }

  // ---------- http ----------

  function send(res, status, body, headers) {
    try {
      if (res.headersSent || res.destroyed) return;
      const text = body === null ? '' : JSON.stringify(body);
      const h = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Length': String(Buffer.byteLength(text)), ...(headers ?? {}) };
      if (body !== null) h['Content-Type'] = 'application/json; charset=utf-8';
      // an answer that left a body unread ends the connection
      if (status >= 400) h.Connection = 'close';
      res.writeHead(status, h);
      res.end(text);
    } catch (e) {
      log(`mcp: could not answer (${e && e.message ? e.message : 'error'})`);
    }
  }

  /** the body as text, null when it is over the cap (reading stops), undefined when the client went away */
  function readBody(req) {
    return new Promise((resolve) => {
      const chunks = [];
      let size = 0;
      let finished = false;
      const end = (v) => {
        if (finished) return;
        finished = true;
        resolve(v);
      };
      req.on('data', (chunk) => {
        if (finished) return;
        size += chunk.length;
        if (size > rules.MAX_BODY_BYTES) {
          chunks.length = 0;
          end(null);
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => end(Buffer.concat(chunks).toString('utf8')));
      req.on('error', () => end(undefined));
      req.on('close', () => end(undefined));
    });
  }

  async function handle(req, res, expectContinue) {
    const h = req.headers;
    const lengthHeader = typeof h['content-length'] === 'string' ? Number(h['content-length']) : undefined;
    const bad = rules.checkRequest(
      {
        method: req.method,
        url: req.url,
        host: h.host,
        origin: h.origin,
        authorization: h.authorization,
        contentType: h['content-type'],
        contentLength: lengthHeader,
      },
      { port: livePort, token: config.token },
    );
    if (bad) {
      send(res, bad.status, { error: bad.message }, bad.headers);
      return;
    }
    if (expectContinue) res.writeContinue();
    const body = await readBody(req);
    if (body === undefined) return;
    if (body === null) {
      res.once('finish', () => setImmediate(() => req.destroy()));
      send(res, 413, { error: 'the body is too big' });
      return;
    }
    if (!rules.versionHeaderOk(h['mcp-protocol-version'])) {
      send(res, 400, rules.rpcError(null, rules.INVALID_REQUEST, 'unsupported MCP-Protocol-Version'));
      return;
    }
    const msg = rules.classifyMessage(body);
    if (msg.type === 'parse-error') {
      send(res, 400, rules.rpcError(null, rules.PARSE_ERROR, 'parse error'));
      return;
    }
    if (msg.type === 'invalid') {
      send(res, 400, rules.rpcError(msg.id, rules.INVALID_REQUEST, msg.why));
      return;
    }
    if (msg.type !== 'request') {
      send(res, 202, null);
      return;
    }
    send(res, 200, await answer(msg));
  }

  function onHttp(req, res, expectContinue) {
    handle(req, res, expectContinue === true).catch((e) => {
      log(`mcp: a request failed (${e && e.message ? e.message : 'error'})`);
      send(res, 500, rules.rpcError(null, rules.SERVER_ERROR, 'internal error'));
    });
  }

  function listenOn(port) {
    return new Promise((resolve, reject) => {
      const s = http.createServer({ maxHeaderSize: 16 * 1024 }, (req, res) => onHttp(req, res, false));
      s.maxConnections = rules.MAX_SOCKETS;
      // short and checked often: a local client that trickles bytes must not hold all the sockets
      s.connectionsCheckingInterval = 2000;
      s.headersTimeout = 3000;
      s.requestTimeout = 30 * 1000;
      s.keepAliveTimeout = 5 * 1000;
      s.on('checkContinue', (req, res) => onHttp(req, res, true));
      s.on('connection', (sock) => {
        sockets.add(sock);
        sock.on('close', () => sockets.delete(sock));
        sock.on('error', () => {});
      });
      s.once('error', reject);
      s.listen({ port, host: '127.0.0.1' }, () => {
        s.removeListener('error', reject);
        s.on('error', (e) => log(`mcp: server error (${e && e.code ? e.code : 'error'})`));
        resolve(s);
      });
    });
  }

  // ---------- on and off ----------

  async function start() {
    if (server || disposed) return;
    error = null;
    if (!config.token) config.token = newToken();
    syncBridge(true);
    const tries = rules.portCandidates(config.port, opts.ports && opts.ports.first, opts.ports && opts.ports.tries);
    tries.push(0);
    let lastCode = '';
    for (const port of tries) {
      try {
        server = await listenOn(port);
        break;
      } catch (e) {
        lastCode = e && e.code ? String(e.code) : 'error';
      }
    }
    if (!server) {
      running = false;
      error = `could not open a local port (${lastCode})`;
      log(`mcp: ${error}`);
      saveConfig();
      return;
    }
    const addr = server.address();
    livePort = addr && typeof addr === 'object' ? addr.port : 0;
    // the saved port was not free: old client configs point there, and what sits there now must not get a token that works
    if (livePort > 0 && config.port > 0 && livePort !== config.port) {
      config.token = newToken();
      log('mcp: the port moved, a new token was made');
    }
    running = livePort > 0;
    config.port = livePort;
    saveConfig();
  }

  async function stop() {
    const s = server;
    server = null;
    running = false;
    epoch++;
    failAllPending(OFF_TEXT);
    if (!s) return;
    await new Promise((resolve) => {
      try {
        s.close(() => resolve());
      } catch {
        resolve();
      }
      for (const sock of [...sockets]) sock.destroy();
    });
  }

  // on, off and the start run one after another
  let chain = Promise.resolve();
  function queue(fn) {
    const next = chain.then(fn, fn);
    chain = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  function init() {
    return queue(async () => {
      loadConfig();
      syncBridge(false);
      if (config.enabled) await start();
      emit();
      return state();
    }).catch((e) => {
      log(`mcp: init failed (${e && e.message ? e.message : 'error'})`);
      return state();
    });
  }

  function setEnabled(on) {
    return queue(async () => {
      config.enabled = on === true;
      if (config.enabled) {
        await start();
      } else {
        await stop();
        error = null;
        saveConfig();
      }
      emit();
      return state();
    }).catch((e) => {
      log(`mcp: switching failed (${e && e.message ? e.message : 'error'})`);
      return state();
    });
  }

  function rotate() {
    return queue(async () => {
      config.token = newToken();
      saveConfig();
      emit();
      return state();
    }).catch(() => state());
  }

  /** puts a connect text on the clipboard. false when there is nothing to connect to */
  function copy(kind) {
    try {
      if (!running) return false;
      if (kind === 'stdio' && !bridgeOk) syncBridge(true);
      const text = rules.clipboardText(kind, { port: livePort, token: config.token, bridgePath: bridgeOk ? bridgeFile : '' });
      if (text === null) return false;
      opts.writeClipboard(text);
      return true;
    } catch (e) {
      log(`mcp: copy failed (${e && e.message ? e.message : 'error'})`);
      return false;
    }
  }

  async function dispose() {
    disposed = true;
    listeners.clear();
    await queue(async () => {
      await stop();
      for (const ticket of [...tickets.keys()]) dropTicket(ticket);
    }).catch(() => {});
  }

  return { init, state, setEnabled, rotate, copy, reply, armSave, claimDownload, failPending, onChange, dispose };
}

module.exports = { createMcp };
