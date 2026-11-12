import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const r = createRequire(import.meta.url)('./mcpRules.cjs');

const TOKEN = 'A'.repeat(43);
const cfg = { port: 41713, token: TOKEN };
const good = {
  method: 'POST',
  url: '/mcp',
  host: '127.0.0.1:41713',
  origin: undefined,
  authorization: `Bearer ${TOKEN}`,
  contentType: 'application/json',
  contentLength: 10,
};

describe('protocol', () => {
  it('answers the asked version when it is ours, else the newest', () => {
    for (const v of r.PROTOCOLS) expect(r.negotiateVersion(v)).toBe(v);
    expect(r.negotiateVersion('1999-01-01')).toBe('2025-06-18');
    expect(r.negotiateVersion(undefined)).toBe('2025-06-18');
    expect(r.negotiateVersion(5)).toBe('2025-06-18');
    expect(r.negotiateVersion(null)).toBe('2025-06-18');
  });

  it('the version header is optional but never a stranger', () => {
    expect(r.versionHeaderOk(undefined)).toBe(true);
    expect(r.versionHeaderOk('2024-11-05')).toBe(true);
    expect(r.versionHeaderOk('2020-01-01')).toBe(false);
    expect(r.versionHeaderOk('')).toBe(false);
  });

  it('builds the initialize result', () => {
    const out = r.initializeResult('2025-03-26', '1.2.3');
    expect(out.protocolVersion).toBe('2025-03-26');
    expect(out.capabilities).toEqual({ tools: { listChanged: false } });
    expect(out.serverInfo).toEqual({ name: 'ncut', title: 'ncut', version: '1.2.3' });
    expect(out.instructions).toContain('get_state');
    expect(out.instructions).toContain('list_options');
    expect(out.instructions).toContain('undo step');
    expect(r.initializeResult('x', '').serverInfo.version).toBe('0.0.0');
    expect(r.initializeResult('x', '1').protocolVersion).toBe('2025-06-18');
  });

  it('builds results and errors', () => {
    expect(r.rpcResult(3, { a: 1 })).toEqual({ jsonrpc: '2.0', id: 3, result: { a: 1 } });
    expect(r.rpcError('x', -32601, 'no')).toEqual({ jsonrpc: '2.0', id: 'x', error: { code: -32601, message: 'no' } });
    expect(r.rpcError(undefined, -32700, 'no').id).toBeNull();
    expect(r.textResult('hi')).toEqual({ content: [{ type: 'text', text: 'hi' }] });
    expect(r.textResult('bad', true)).toEqual({ content: [{ type: 'text', text: 'bad' }], isError: true });
  });
});

describe('json-rpc messages', () => {
  it('a request has a method and an id (text or number)', () => {
    expect(r.classifyMessage('{"jsonrpc":"2.0","id":1,"method":"ping"}')).toEqual({ type: 'request', id: 1, method: 'ping', params: {} });
    expect(r.classifyMessage('{"jsonrpc":"2.0","id":"a","method":"x","params":{"b":2}}')).toEqual({ type: 'request', id: 'a', method: 'x', params: { b: 2 } });
    expect(r.classifyMessage('{"jsonrpc":"2.0","id":0,"method":"ping"}').type).toBe('request');
  });

  it('a notification has a method and no id', () => {
    expect(r.classifyMessage('{"jsonrpc":"2.0","method":"notifications/initialized"}')).toEqual({ type: 'notification', method: 'notifications/initialized' });
  });

  it('a response has an id and a result or an error, not both', () => {
    expect(r.classifyMessage('{"jsonrpc":"2.0","id":1,"result":{}}').type).toBe('response');
    expect(r.classifyMessage('{"jsonrpc":"2.0","id":"z","error":{"code":1,"message":"x"}}').type).toBe('response');
    expect(r.classifyMessage('{"jsonrpc":"2.0","id":1,"result":{},"error":{}}').type).toBe('invalid');
    expect(r.classifyMessage('{"jsonrpc":"2.0","result":{}}').type).toBe('invalid');
  });

  it('refuses everything else', () => {
    expect(r.classifyMessage('{nope').type).toBe('parse-error');
    expect(r.classifyMessage('').type).toBe('parse-error');
    expect(r.classifyMessage('[{"jsonrpc":"2.0","id":1,"method":"ping"}]').type).toBe('invalid');
    expect(r.classifyMessage('[]').type).toBe('invalid');
    expect(r.classifyMessage('null').type).toBe('invalid');
    expect(r.classifyMessage('5').type).toBe('invalid');
    expect(r.classifyMessage('"x"').type).toBe('invalid');
    expect(r.classifyMessage('{"id":1,"method":"ping"}').type).toBe('invalid');
    expect(r.classifyMessage('{"jsonrpc":"1.0","id":1,"method":"ping"}').type).toBe('invalid');
    expect(r.classifyMessage('{"jsonrpc":"2.0","id":1,"method":5}').type).toBe('invalid');
    expect(r.classifyMessage('{"jsonrpc":"2.0","id":1,"method":""}').type).toBe('invalid');
    expect(r.classifyMessage('{"jsonrpc":"2.0","id":null,"method":"ping"}').type).toBe('invalid');
    expect(r.classifyMessage('{"jsonrpc":"2.0","id":{},"method":"ping"}').type).toBe('invalid');
    expect(r.classifyMessage('{"jsonrpc":"2.0","id":1,"method":"ping","params":5}').type).toBe('invalid');
    expect(r.classifyMessage('{"jsonrpc":"2.0"}').type).toBe('invalid');
  });

  it('an invalid message keeps its id when it has a usable one', () => {
    expect(r.classifyMessage('{"jsonrpc":"1.0","id":7,"method":"ping"}').id).toBe(7);
    expect(r.classifyMessage('[1]').id).toBeNull();
  });
});

describe('the saved config', () => {
  it('keeps good values', () => {
    expect(r.cleanConfig({ enabled: true, port: 41713, token: TOKEN })).toEqual({ enabled: true, port: 41713, token: TOKEN });
  });

  it('drops everything wrong', () => {
    expect(r.cleanConfig(null)).toEqual({ enabled: false, port: 0, token: '' });
    expect(r.cleanConfig([])).toEqual({ enabled: false, port: 0, token: '' });
    expect(r.cleanConfig('x')).toEqual({ enabled: false, port: 0, token: '' });
    expect(r.cleanConfig({ enabled: 'yes' }).enabled).toBe(false);
    expect(r.cleanConfig({ enabled: 1 }).enabled).toBe(false);
    for (const port of [0, 80, 1023, 65536, 1.5, '41713', NaN, -1]) expect(r.cleanConfig({ port }).port).toBe(0);
    expect(r.cleanConfig({ port: 1024 }).port).toBe(1024);
    expect(r.cleanConfig({ port: 65535 }).port).toBe(65535);
    for (const token of ['', 'short', 'A'.repeat(42), 'A'.repeat(44), `${'A'.repeat(42)}!`, 5, null]) expect(r.cleanConfig({ token }).token).toBe('');
  });

  it('port candidates: the saved one, then 21 from the first', () => {
    const list = r.portCandidates(0);
    expect(list).toHaveLength(21);
    expect(list[0]).toBe(41713);
    expect(list[20]).toBe(41733);
    expect(r.portCandidates(50000)[0]).toBe(50000);
    expect(r.portCandidates(50000)).toHaveLength(22);
    // no duplicate when the saved one is in the range
    const again = r.portCandidates(41715);
    expect(again[0]).toBe(41715);
    expect(again).toHaveLength(21);
    expect(r.portCandidates(80)[0]).toBe(41713);
    expect(r.portCandidates(0, 50000, 3)).toEqual([50000, 50001, 50002]);
  });
});

describe('host and origin', () => {
  it('only 127.0.0.1 and localhost with our port', () => {
    expect(r.hostAllowed('127.0.0.1:41713', 41713)).toBe(true);
    expect(r.hostAllowed('localhost:41713', 41713)).toBe(true);
    expect(r.hostAllowed('LOCALHOST:41713', 41713)).toBe(true);
    for (const h of ['127.0.0.1', 'localhost', '127.0.0.1:41714', 'evil.com', 'evil.com:41713', '127.0.0.1.evil.com:41713', '[::1]:41713', '0.0.0.0:41713', '', undefined, 5]) {
      expect(r.hostAllowed(h, 41713)).toBe(false);
    }
  });

  it('any Origin header is refused, even an empty or a null one', () => {
    expect(r.originAllowed(undefined)).toBe(true);
    expect(r.originAllowed('')).toBe(false);
    expect(r.originAllowed('null')).toBe(false);
    expect(r.originAllowed('http://localhost:41713')).toBe(false);
    expect(r.originAllowed('https://evil.com')).toBe(false);
  });
});

describe('the token', () => {
  it('reads a bearer header', () => {
    expect(r.bearerToken('Bearer abc')).toBe('abc');
    expect(r.bearerToken('bearer abc')).toBe('abc');
    expect(r.bearerToken('BEARER   abc ')).toBe('abc');
    for (const h of [undefined, '', 'Bearer', 'Bearer ', 'Basic abc', 'abc', 'Bearer a b', `Bearer ${'x'.repeat(5000)}`, 5, null]) {
      expect(r.bearerToken(h)).toBeNull();
    }
  });

  it('compares in a way that never throws', () => {
    expect(r.tokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(r.tokenMatches(`${'A'.repeat(42)}B`, TOKEN)).toBe(false);
    expect(r.tokenMatches('', TOKEN)).toBe(false);
    expect(r.tokenMatches('A', TOKEN)).toBe(false);
    expect(r.tokenMatches(`${TOKEN}A`, TOKEN)).toBe(false);
    expect(r.tokenMatches(TOKEN, '')).toBe(false);
    expect(r.tokenMatches('', '')).toBe(false);
    expect(r.tokenMatches(undefined, TOKEN)).toBe(false);
    expect(r.tokenMatches(TOKEN, undefined)).toBe(false);
    expect(r.tokenMatches(5, TOKEN)).toBe(false);
  });
});

describe('the ordered request check', () => {
  it('lets a good request through', () => {
    expect(r.checkRequest(good, cfg)).toBeNull();
    expect(r.checkRequest({ ...good, url: '/mcp?x=1', contentType: 'application/json; charset=utf-8' }, cfg)).toBeNull();
    expect(r.checkRequest({ ...good, host: 'localhost:41713', contentType: 'Application/JSON' }, cfg)).toBeNull();
    expect(r.checkRequest({ ...good, contentLength: undefined }, cfg)).toBeNull();
    expect(r.checkRequest({ ...good, contentLength: r.MAX_BODY_BYTES }, cfg)).toBeNull();
  });

  it('404 for another path, whatever else is wrong', () => {
    for (const url of ['/', '/mcp/', '/mcpx', '/MCP', '/a/mcp', '', undefined, 'http://127.0.0.1:41713/mcp']) {
      expect(r.checkRequest({ ...good, url, host: 'evil.com', authorization: undefined }, cfg).status).toBe(404);
    }
  });

  it('405 for another method, with Allow', () => {
    for (const method of ['GET', 'PUT', 'DELETE', 'OPTIONS', 'HEAD', 'PATCH']) {
      const got = r.checkRequest({ ...good, method }, cfg);
      expect(got.status).toBe(405);
      expect(got.headers).toEqual({ Allow: 'POST' });
    }
  });

  it('403 for a wrong host, before the token is looked at', () => {
    expect(r.checkRequest({ ...good, host: 'evil.com:41713', authorization: undefined }, cfg).status).toBe(403);
    expect(r.checkRequest({ ...good, host: undefined }, cfg).status).toBe(403);
  });

  it('403 for any origin, even with a right token', () => {
    expect(r.checkRequest({ ...good, origin: 'http://localhost:41713' }, cfg).status).toBe(403);
    expect(r.checkRequest({ ...good, origin: '' }, cfg).status).toBe(403);
    expect(r.checkRequest({ ...good, origin: 'null', authorization: undefined }, cfg).status).toBe(403);
  });

  it('401 for no or a wrong token, with WWW-Authenticate', () => {
    for (const authorization of [undefined, '', 'Bearer', 'Bearer nope', `Basic ${TOKEN}`, TOKEN, `Bearer ${TOKEN}x`]) {
      const got = r.checkRequest({ ...good, authorization }, cfg);
      expect(got.status).toBe(401);
      expect(got.headers).toEqual({ 'WWW-Authenticate': 'Bearer' });
    }
  });

  it('401 when the server has no token at all', () => {
    expect(r.checkRequest({ ...good, authorization: 'Bearer ' }, { port: 41713, token: '' }).status).toBe(401);
    expect(r.checkRequest({ ...good, authorization: 'Bearer x' }, { port: 41713, token: '' }).status).toBe(401);
  });

  it('415 for another content type, 413 for a declared big body', () => {
    for (const contentType of [undefined, '', 'text/plain', 'application/jsonx', 'application/x-www-form-urlencoded', 'multipart/form-data']) {
      expect(r.checkRequest({ ...good, contentType }, cfg).status).toBe(415);
    }
    expect(r.checkRequest({ ...good, contentLength: r.MAX_BODY_BYTES + 1 }, cfg).status).toBe(413);
    expect(r.checkRequest({ ...good, contentType: 'text/plain', contentLength: 1e9 }, cfg).status).toBe(415);
  });

  it('the order is path, method, host, origin, token, type, size', () => {
    const all = { method: 'GET', url: '/other', host: 'x', origin: 'o', authorization: 'no', contentType: 'x', contentLength: 1e9 };
    expect(r.checkRequest(all, cfg).status).toBe(404);
    expect(r.checkRequest({ ...all, url: '/mcp' }, cfg).status).toBe(405);
    expect(r.checkRequest({ ...all, url: '/mcp', method: 'POST' }, cfg).status).toBe(403);
    expect(r.checkRequest({ ...all, url: '/mcp', method: 'POST', host: '127.0.0.1:41713' }, cfg).status).toBe(403);
    expect(r.checkRequest({ ...all, url: '/mcp', method: 'POST', host: '127.0.0.1:41713', origin: undefined }, cfg).status).toBe(401);
    expect(r.checkRequest({ ...all, url: '/mcp', method: 'POST', host: '127.0.0.1:41713', origin: undefined, authorization: good.authorization }, cfg).status).toBe(415);
    expect(r.checkRequest({ ...good, contentLength: 1e9 }, cfg).status).toBe(413);
  });

  it('the cap and the numbers are the documented ones', () => {
    expect(r.MAX_BODY_BYTES).toBe(1024 * 1024);
    expect(r.MAX_REPLY_CHARS).toBe(24 * 1024 * 1024);
    expect(r.MAX_PENDING).toBe(8);
    expect(r.LIST_TIMEOUT_MS).toBe(10000);
    expect(r.CALL_TIMEOUT_MS).toBe(180000);
    expect(r.MAX_TICKETS).toBe(8);
    expect(r.TICKET_TTL_MS).toBe(12 * 3600 * 1000);
    expect(r.MAX_SAVED).toBe(32);
    expect(r.MAX_FILE_BYTES_PER_CALL).toBe(1024 ** 3);
    expect(r.MAX_SOCKETS).toBe(16);
  });
});

describe('paths of file tools', () => {
  const media = r.MEDIA_EXTS;

  it('takes absolute drive letter paths with either slash', () => {
    expect(r.checkFilePath('C:\\clips\\a.mp4', media)).toEqual({ ok: true, path: 'C:\\clips\\a.mp4' });
    expect(r.checkFilePath('c:/clips/a.MOV', media).ok).toBe(true);
    expect(r.checkFilePath('D:\\a b\\c.png', media).ok).toBe(true);
    expect(r.checkFilePath('C:/mixed\\slashes/a.wav', media).ok).toBe(true);
    expect(r.checkFilePath('C:\\p.ncut', ['ncut']).ok).toBe(true);
  });

  it('refuses everything that is not that', () => {
    const bad = [
      '',
      undefined,
      null,
      5,
      ['C:\\a.mp4'],
      'a.mp4',
      'clips\\a.mp4',
      '.\\a.mp4',
      '..\\a.mp4',
      '/a.mp4',
      '\\a.mp4',
      'C:a.mp4',
      'C:',
      'C:\\',
      '\\\\server\\share\\a.mp4',
      '//server/share/a.mp4',
      '\\\\?\\C:\\a.mp4',
      '\\\\.\\C:\\a.mp4',
      '//?/C:/a.mp4',
      'C:\\a.mp4\0',
      'C:\\a\0.mp4',
      'C:\\a\n.mp4',
      'C:\\a.mp4:stream',
      'C:\\a.mp4::$DATA',
      'C:\\a?.mp4',
      'C:\\a*.mp4',
      'C:\\<a>.mp4',
      'C:\\"a".mp4',
      'C:\\a|b.mp4',
      'C:\\clips\\..\\a.mp4',
      'C:\\clips\\.\\a.mp4',
      'C:\\clips\\',
      'C:\\clips/',
      'C:\\con.mp4',
      'C:\\clips\\nul',
      'C:\\clips\\NUL.mp4',
      'C:\\com1\\a.mp4',
      'C:\\clips \\a.mp4',
      'C:\\clips.\\a.mp4',
      'C:\\a.mp4.',
      'C:\\a.mp4 ',
      'C:\\a.exe',
      'C:\\a',
      'C:\\.mp4',
      'C:\\a.mp4.exe',
      `C:\\${'a'.repeat(1000)}.mp4`,
    ];
    for (const p of bad) {
      const got = r.checkFilePath(p, media);
      expect(got.ok, String(p)).toBe(false);
      expect(typeof got.reason).toBe('string');
    }
  });

  it('the extension has to be in the list of the tool', () => {
    expect(r.checkFilePath('C:\\a.ncut', media).ok).toBe(false);
    expect(r.checkFilePath('C:\\a.mp4', ['ncut']).ok).toBe(false);
    expect(r.checkFilePath('C:\\a.NCUT', ['ncut']).ok).toBe(true);
  });

  it('the media list is the importers list', () => {
    for (const e of ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'ogv', 'avi', 'ts', 'mts', '3gp', 'mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus', 'weba', 'aiff', 'aif', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'svg']) {
      expect(media).toContain(e);
    }
    expect(media).toHaveLength(29);
  });

  it('names the path and the reason', () => {
    const text = r.pathProblem('C:\\x.exe', 'because');
    expect(text).toContain('C:\\x.exe');
    expect(text).toContain('because');
    expect(r.pathProblem('a'.repeat(500), 'x').length).toBeLessThan(250);
    expect(r.pathProblem('a\nb', 'x')).not.toContain('\n');
  });

  it('which tools take files and which get a ticket', () => {
    expect(r.fileSpec('import_media')).toMatchObject({ arg: 'paths', many: true, max: 16 });
    expect(r.fileSpec('import_project')).toMatchObject({ arg: 'path', many: false, exts: ['ncut'] });
    for (const t of ['get_state', 'export_video', 'toString', '__proto__', 'constructor', '', undefined, 5]) expect(r.fileSpec(t)).toBeNull();
    expect(r.wantsTicket('export_video')).toBe(true);
    for (const t of ['export_status', 'import_media', 'export_cancel', '', undefined]) expect(r.wantsTicket(t)).toBe(false);
  });

  it('plans the files of a call', () => {
    const media_ = r.fileSpec('import_media');
    expect(r.planFiles(media_, { paths: ['C:\\a.mp4', 'D:/b.png'] })).toEqual({ ok: true, paths: ['C:\\a.mp4', 'D:/b.png'] });
    expect(r.planFiles(media_, { paths: Array.from({ length: 16 }, (_, i) => `C:\\a${i}.mp4`) }).ok).toBe(true);
    expect(r.planFiles(media_, { paths: Array.from({ length: 17 }, (_, i) => `C:\\a${i}.mp4`) }).ok).toBe(false);
    for (const args of [{}, undefined, null, { paths: [] }, { paths: 'C:\\a.mp4' }, { paths: [5] }, { paths: ['C:\\a.mp4', 'a.mp4'] }, { paths: ['\\\\s\\a.mp4'] }]) {
      const got = r.planFiles(media_, args);
      expect(got.ok).toBe(false);
      expect(typeof got.error).toBe('string');
    }
    expect(r.planFiles(media_, { paths: ['C:\\ok.mp4', 'C:\\bad.exe'] }).error).toContain('bad.exe');
    const one = r.fileSpec('import_project');
    expect(r.planFiles(one, { path: 'C:\\p.ncut' })).toEqual({ ok: true, paths: ['C:\\p.ncut'] });
    expect(r.planFiles(one, { path: ['C:\\p.ncut'] }).ok).toBe(false);
    expect(r.planFiles(one, { path: 'C:\\p.mp4' }).ok).toBe(false);
    expect(r.planFiles(one, {}).ok).toBe(false);
  });

  it('removes only the path argument', () => {
    expect(r.withoutPathArg(r.fileSpec('import_media'), { paths: ['x'], other: 1 })).toEqual({ other: 1 });
    expect(r.withoutPathArg(r.fileSpec('import_project'), { path: 'x' })).toEqual({});
    expect(r.withoutPathArg(r.fileSpec('import_project'), null)).toEqual({});
  });
});

describe('what the page answers', () => {
  it('a list keeps only plain tools with a name', () => {
    const got = r.cleanReply(JSON.stringify({ tools: [{ name: 'a', x: 1 }, { name: '' }, { title: 'no name' }, 5, null, [], { name: 7 }, { name: 'b' }], extra: 1 }), 'list');
    expect(got).toEqual({ ok: true, value: { tools: [{ name: 'a', x: 1 }, { name: 'b' }] } });
    expect(r.cleanReply('{"tools":[]}', 'list')).toEqual({ ok: true, value: { tools: [] } });
    expect(r.cleanReply('{"tools":{}}', 'list').ok).toBe(false);
    expect(r.cleanReply('{}', 'list').ok).toBe(false);
  });

  it('a call keeps text and image items, isError and saved, nothing else', () => {
    const json = JSON.stringify({
      content: [
        { type: 'text', text: 'hi', evil: 1 },
        { type: 'image', data: 'AAAA', mimeType: 'image/png', evil: 1 },
        { type: 'text', text: 5 },
        { type: 'image', data: 'AAAA' },
        { type: 'resource', uri: 'file:///c:/x' },
        'text',
        null,
      ],
      isError: true,
      saved: 4,
      extra: { a: 1 },
    });
    expect(r.cleanReply(json, 'call')).toEqual({
      ok: true,
      value: {
        content: [
          { type: 'text', text: 'hi' },
          { type: 'image', data: 'AAAA', mimeType: 'image/png' },
        ],
        isError: true,
        saved: 4,
      },
    });
  });

  it('isError and saved are dropped when they have the wrong type', () => {
    expect(r.cleanReply('{"content":[],"isError":"yes","saved":"4"}', 'call')).toEqual({ ok: true, value: { content: [] } });
    expect(r.cleanReply('{"content":[],"saved":null}', 'call')).toEqual({ ok: true, value: { content: [] } });
    expect(r.cleanReply('{"content":[],"saved":1.5}', 'call')).toEqual({ ok: true, value: { content: [] } });
    expect(r.cleanReply('{"content":[],"isError":false}', 'call')).toEqual({ ok: true, value: { content: [], isError: false } });
  });

  it('knows the unknown tool answer', () => {
    expect(r.cleanReply('{"unknown":true}', 'call')).toEqual({ ok: true, value: { unknown: true } });
    expect(r.cleanReply('{"unknown":1}', 'call').ok).toBe(false);
    // not for a list
    expect(r.cleanReply('{"unknown":true}', 'list').ok).toBe(false);
  });

  it('refuses what is no answer', () => {
    for (const json of ['', 'nope', '[]', 'null', '5', '"x"', '{}', '{"content":"x"}', undefined, null, 5, {}]) {
      expect(r.cleanReply(json, 'call').ok, String(json)).toBe(false);
    }
  });

  it('refuses an answer over the cap', () => {
    const big = `{"content":[{"type":"text","text":"${'x'.repeat(r.MAX_REPLY_CHARS)}"}]}`;
    expect(r.cleanReply(big, 'call').ok).toBe(false);
    expect(r.cleanReply(big, 'list').ok).toBe(false);
  });

  it('the saved text item', () => {
    expect(r.savedItem('C:\\out\\a.mp4')).toEqual({ type: 'text', text: 'saved to C:\\out\\a.mp4' });
  });
});

describe('connect texts', () => {
  const info = { port: 41713, token: TOKEN, bridgePath: 'C:\\Users\\me\\AppData\\Roaming\\ncut\\mcp-bridge.cjs' };

  it('the claude code command', () => {
    expect(r.clipboardText('claude', info)).toBe(`claude mcp add --transport http ncut http://127.0.0.1:41713/mcp --header "Authorization: Bearer ${TOKEN}"`);
  });

  it('the http config holds the url and the header', () => {
    const cfgText = JSON.parse(r.clipboardText('http', info));
    expect(cfgText.mcpServers.ncut).toEqual({ type: 'http', url: 'http://127.0.0.1:41713/mcp', headers: { Authorization: `Bearer ${TOKEN}` } });
  });

  it('the stdio config has the bridge and never the token', () => {
    const text = r.clipboardText('stdio', info);
    expect(text).not.toContain(TOKEN);
    expect(JSON.parse(text).mcpServers.ncut).toEqual({ command: 'node', args: [info.bridgePath] });
    // the backslashes survive as a path
    expect(JSON.parse(text).mcpServers.ncut.args[0]).toBe(info.bridgePath);
  });

  it('null for a stranger kind or when there is nothing to connect to', () => {
    for (const kind of ['', 'other', 'CLAUDE', undefined, null, 5, '__proto__']) expect(r.clipboardText(kind, info)).toBeNull();
    expect(r.clipboardText('claude', { ...info, port: 0 })).toBeNull();
    expect(r.clipboardText('claude', { ...info, token: '' })).toBeNull();
    expect(r.clipboardText('http', { ...info, token: '' })).toBeNull();
    expect(r.clipboardText('stdio', { ...info, bridgePath: '' })).toBeNull();
    expect(r.clipboardText('stdio', { ...info, token: '' })).not.toBeNull();
    expect(r.clipboardText('claude', null)).toBeNull();
  });
});

describe('the marked download', () => {
  it('reads ncut-mcp-<ticket>-<file name>', () => {
    expect(r.parseDownloadName('ncut-mcp-7-my video.mp4')).toEqual({ ticket: 7, file: 'my video.mp4' });
    expect(r.parseDownloadName('ncut-mcp-123-a-b-c.webm')).toEqual({ ticket: 123, file: 'a-b-c.webm' });
  });

  it('is not fooled by other names', () => {
    for (const n of ['video.mp4', 'ncut-mcp-x-a.mp4', 'ncut-mcp--a.mp4', 'ncut-mcp-7-', 'ncut-mcp-7', 'xncut-mcp-7-a.mp4', ' ncut-mcp-7-a.mp4', 'ncut-mcp-1234567890123456-a.mp4', '', undefined, null]) {
      expect(r.parseDownloadName(n), String(n)).toBeNull();
    }
  });

  it('reads exactly what src/lib/shell.ts mcpDownloadName writes', () => {
    // mcpDownloadName(ticket, file) = `ncut-mcp-${ticket}-${file}`
    const write = (ticket, file) => `ncut-mcp-${ticket}-${file}`;
    expect(r.parseDownloadName(write(41, 'export.mp4'))).toEqual({ ticket: 41, file: 'export.mp4' });
  });

  it('the saved name is cleaned like every download and never a path', () => {
    expect(r.savedFileName('a.mp4')).toBe('a.mp4');
    expect(r.savedFileName('..\\..\\evil.mp4')).not.toMatch(/[\\/]/);
    expect(r.savedFileName('con.mp4')).toBe('_con.mp4');
    expect(r.savedFileName('')).toBe('ncut file');
    expect(r.savedFileName('x'.repeat(500) + '.mp4').length).toBeLessThanOrEqual(180);
  });

  it('picks the first free name', () => {
    expect(r.uniqueName('a.mp4', () => false)).toBe('a.mp4');
    expect(r.uniqueName('a.mp4', (n) => n === 'a.mp4')).toBe('a (2).mp4');
    expect(r.uniqueName('a.mp4', (n) => n === 'a.mp4' || n === 'a (2).mp4')).toBe('a (3).mp4');
    expect(r.uniqueName('noext', (n) => n === 'noext')).toBe('noext (2)');
    expect(r.uniqueName('.hidden', (n) => n === '.hidden')).toBe('.hidden (2)');
    expect(r.uniqueName('a.b.mp4', (n) => n === 'a.b.mp4')).toBe('a.b (2).mp4');
    expect(r.uniqueName('a.mp4', () => true)).toBeNull();
  });
});

describe('what a ticket download and a copy may be', () => {
  it('ticketExtOk takes what export_video makes, in any case, and nothing else', () => {
    for (const n of ['a.mp4', 'a.WEBM', 'a.Gif', 'a.wav', 'x.y.ogg', 'a.png', 'a.JPG']) expect(r.ticketExtOk(n)).toBe(true);
    for (const n of ['a.bat', 'a.lnk', 'a.exe', 'a', 'mp4', 'a.mp4.exe', 'a.jpeg', 'a.svg', 'a.png.lnk', '', undefined]) expect(r.ticketExtOk(n)).toBe(false);
  });

  it('copyAllowed needs a known kind and a focused window', () => {
    expect(r.copyAllowed('claude', true)).toBe(true);
    expect(r.copyAllowed('http', true)).toBe(true);
    expect(r.copyAllowed('stdio', true)).toBe(true);
    expect(r.copyAllowed('claude', false)).toBe(false);
    expect(r.copyAllowed('claude', undefined)).toBe(false);
    expect(r.copyAllowed('other', true)).toBe(false);
  });
});
