'use strict';

// Tests for the data layer in server.js: filename sanitization/dedup and the
// saveData()/loadData() round trip against data/. Uses Node's built-in test
// runner — run with `node --test`.

const test = require('node:test');
const assert = require('node:assert');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

// server.js reads VOLLEY_DATA_DIR at module-load time, so set it before requiring.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'volley-test-'));
process.env.VOLLEY_DATA_DIR = DATA_DIR;

const { sanitizeName, uniqueName, buildColsFromFiles, loadData, saveData, normalizeEnvs, parseDigestChallenge, buildDigestHeader, parseSetCookie, cookieMatches, updateJarCookie, loadCookies, saveCookies, getCliArg, findMockMatch, startMockServer, stopMockServer, mockStatus, startCaptureServer, stopCaptureServer, captureStatus, clearCaptureLog, getCaptureLog, wsAcceptKey, encodeWsFrame, WsFrameDecoder, WS_OP } = require('../server.js');

function resetData() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

test('sanitizeName replaces illegal filesystem characters and falls back to "untitled"', () => {
  assert.strictEqual(sanitizeName('My/Coll:ection*?'), 'My_Coll_ection__');
  assert.strictEqual(sanitizeName('   '), 'untitled');
  assert.strictEqual(sanitizeName(''), 'untitled');
});

test('uniqueName de-duplicates case-insensitively with (2), (3), ...', () => {
  const used = new Set();
  assert.strictEqual(uniqueName('Request', used), 'Request');
  assert.strictEqual(uniqueName('Request', used), 'Request (2)');
  assert.strictEqual(uniqueName('request', used), 'request (3)');
});

test('buildColsFromFiles groups requests, nests folders, and reads _volley/*', () => {
  const files = [
    { path: 'Demo/Get Users.json', content: JSON.stringify({ name: 'Get Users', method: 'GET', url: '/users' }) },
    { path: 'Demo/Create User.json', content: JSON.stringify({ name: 'Create User', method: 'POST', url: '/users', folder: 'Admin' }) },
    { path: '_volley/envs.json', content: JSON.stringify([{ id: 'e1', name: 'Dev', vars: {} }]) },
    { path: '_volley/history.json', content: JSON.stringify([{ method: 'GET', url: '/x', status: 200, elapsed: 12 }]) },
    { path: 'not-json.txt', content: 'ignored' },
  ];

  const { cols, envs, hist } = buildColsFromFiles(files);

  assert.strictEqual(cols.length, 1);
  assert.strictEqual(cols[0].name, 'Demo');
  assert.strictEqual(cols[0].requests.length, 1);
  assert.strictEqual(cols[0].requests[0].name, 'Get Users');
  assert.strictEqual(cols[0].folders.length, 1);
  assert.strictEqual(cols[0].folders[0].name, 'Admin');
  assert.strictEqual(cols[0].folders[0].requests[0].name, 'Create User');
  assert.deepStrictEqual(envs, [{ id: 'e1', name: 'Dev', vars: {} }]);
  assert.deepStrictEqual(hist, [{ method: 'GET', url: '/x', status: 200, elapsed: 12 }]);
});

test('normalizeEnvs migrates legacy {key: value} vars to the array-of-rows shape', () => {
  const envs = normalizeEnvs([
    { id: 'e1', name: 'Dev', vars: { baseUrl: 'http://localhost', token: 'abc' } },
    { id: 'e2', name: 'Prod', vars: [{ id: 'v1', key: 'baseUrl', value: 'https://api.example.com', enabled: true }] },
  ]);

  assert.strictEqual(envs[0].vars.length, 2);
  assert.deepStrictEqual(envs[0].vars.map(v => [v.key, v.value, v.enabled]), [
    ['baseUrl', 'http://localhost', true],
    ['token', 'abc', true],
  ]);
  assert.ok(envs[0].vars.every(v => typeof v.id === 'string' && v.id));

  // Already-array vars pass through unchanged.
  assert.deepStrictEqual(envs[1].vars, [{ id: 'v1', key: 'baseUrl', value: 'https://api.example.com', enabled: true }]);
});

test('saveData + loadData round trip preserves collections, folders, envs, and history', () => {
  resetData();

  const cols = [
    {
      name: 'Demo',
      requests: [
        { id: 'r1', name: 'Get Users', method: 'GET', url: '/users', params: [], headers: [], body: { type: 'none', raw: '', formData: [] }, auth: { type: 'none' } },
      ],
      folders: [
        {
          id: 'f1', name: 'Admin', requests: [
            { id: 'r2', name: 'Create User', method: 'POST', url: '/users', params: [], headers: [], body: { type: 'none', raw: '', formData: [] }, auth: { type: 'none' } },
          ],
        },
      ],
    },
  ];
  const envs = [{ id: 'default', name: 'No Environment', vars: [{ id: 'v1', key: 'baseUrl', value: 'http://localhost', enabled: true }] }];
  const globals = [{ id: 'g1', key: 'apiKey', value: 'secret', enabled: true }];
  const hist = [{ method: 'GET', url: '/users', status: 200, elapsed: 10 }];
  const activeEnv = 'default';
  const openTabs = [
    { col: 'Demo', folder: null, name: 'Get Users', reqTab: 'body' },
    { col: 'Demo', folder: 'Admin', name: 'Create User', reqTab: 'auth' },
  ];
  const activeIndex = 1;

  saveData({ cols, envs, activeEnv, globals, hist, openTabs, activeIndex });

  // On-disk layout: flat <Collection>/<Request>.json, folder requests get a "folder" field, ids stripped
  assert.ok(fs.existsSync(path.join(DATA_DIR, 'Demo', 'Get Users.json')));
  assert.ok(fs.existsSync(path.join(DATA_DIR, 'Demo', 'Create User.json')));

  const createUser = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'Demo', 'Create User.json'), 'utf8'));
  assert.strictEqual(createUser.folder, 'Admin');
  assert.strictEqual(createUser.id, undefined);

  const loaded = loadData();
  assert.strictEqual(loaded.cols.length, 1);
  assert.strictEqual(loaded.cols[0].name, 'Demo');
  assert.strictEqual(loaded.cols[0].requests[0].name, 'Get Users');
  assert.strictEqual(loaded.cols[0].folders[0].name, 'Admin');
  assert.strictEqual(loaded.cols[0].folders[0].requests[0].name, 'Create User');
  assert.deepStrictEqual(loaded.envs, envs);
  assert.strictEqual(loaded.activeEnv, activeEnv);
  assert.deepStrictEqual(loaded.globals, globals);
  assert.deepStrictEqual(loaded.hist, hist);
  assert.deepStrictEqual(loaded.openTabs, openTabs);
  assert.strictEqual(loaded.activeIndex, activeIndex);
});

test('loadData defaults openTabs/activeIndex when tabs.json is absent', () => {
  resetData();
  saveData({ cols: [], envs: [], hist: [] });

  const loaded = loadData();
  assert.deepStrictEqual(loaded.openTabs, []);
  assert.strictEqual(loaded.activeIndex, -1);
});

test('loadData defaults globals to [] when globals.json is absent', () => {
  resetData();
  saveData({ cols: [], envs: [], hist: [] });

  const loaded = loadData();
  assert.deepStrictEqual(loaded.globals, []);
});

test('saveData removes deleted collection directories and de-duplicates request file names', () => {
  resetData();

  saveData({ cols: [{ name: 'A', requests: [{ name: 'Req' }], folders: [] }], envs: [], hist: [] });
  assert.ok(fs.existsSync(path.join(DATA_DIR, 'A')));

  saveData({ cols: [{ name: 'B', requests: [{ name: 'Req' }, { name: 'Req' }], folders: [] }], envs: [], hist: [] });

  assert.ok(!fs.existsSync(path.join(DATA_DIR, 'A')), 'old collection directory should be removed');
  assert.ok(fs.existsSync(path.join(DATA_DIR, 'B', 'Req.json')));
  assert.ok(fs.existsSync(path.join(DATA_DIR, 'B', 'Req (2).json')));
});

test('saveData wipes a collection\'s old request files when a request is renamed', () => {
  resetData();

  saveData({ cols: [{ name: 'A', requests: [{ name: 'Old Name' }], folders: [] }], envs: [], hist: [] });
  assert.ok(fs.existsSync(path.join(DATA_DIR, 'A', 'Old Name.json')));

  saveData({ cols: [{ name: 'A', requests: [{ name: 'New Name' }], folders: [] }], envs: [], hist: [] });

  assert.ok(!fs.existsSync(path.join(DATA_DIR, 'A', 'Old Name.json')), 'stale request file should be removed');
  assert.ok(fs.existsSync(path.join(DATA_DIR, 'A', 'New Name.json')));
});

test('saveData stamps each request with its array index as `order`, and loadData sorts by it', () => {
  resetData();

  // Write requests/folders in one order...
  saveData({
    cols: [{
      name: 'A',
      requests: [{ name: 'Charlie' }, { name: 'Alice' }, { name: 'Bob' }],
      folders: [{ name: 'F', requests: [{ name: 'Z' }, { name: 'Y' }] }],
    }],
    envs: [], hist: [],
  });

  const charlie = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'A', 'Charlie.json'), 'utf8'));
  const alice   = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'A', 'Alice.json'), 'utf8'));
  assert.strictEqual(charlie.order, 0);
  assert.strictEqual(alice.order, 1);

  // ... shuffle the on-disk files by renaming so directory order no longer
  // matches `order` (simulates readdir() returning a different order) ...
  fs.renameSync(path.join(DATA_DIR, 'A', 'Alice.json'), path.join(DATA_DIR, 'A', 'AAA-renamed.json'));

  // ... loadData() should still return them sorted by the stored `order`, not filename.
  const loaded = loadData();
  assert.deepStrictEqual(loaded.cols[0].requests.map(r => r.name), ['Charlie', 'Alice', 'Bob']);
  assert.deepStrictEqual(loaded.cols[0].folders[0].requests.map(r => r.name), ['Z', 'Y']);
});

test('saveData writes a per-collection _meta.json that preserves folder order and empty folders', () => {
  resetData();

  saveData({
    cols: [{
      name: 'A',
      requests: [],
      folders: [
        { name: 'Empty Folder', requests: [] },
        { name: 'Has Requests', requests: [{ name: 'Req' }] },
      ],
    }],
    envs: [], hist: [],
  });

  const meta = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'A', '_meta.json'), 'utf8'));
  assert.deepStrictEqual(meta.folders, ['Empty Folder', 'Has Requests']);

  const loaded = loadData();
  assert.deepStrictEqual(loaded.cols[0].folders.map(f => f.name), ['Empty Folder', 'Has Requests']);
  assert.deepStrictEqual(loaded.cols[0].folders[0].requests, []);
  assert.strictEqual(loaded.cols[0].folders[1].requests[0].name, 'Req');
});

test('saveData writes _volley/colOrder.json and loadData sorts collections by it', () => {
  resetData();

  saveData({ cols: [{ name: 'Alpha', requests: [], folders: [] }, { name: 'Beta', requests: [], folders: [] }], envs: [], hist: [] });
  const colOrder = JSON.parse(fs.readFileSync(path.join(DATA_DIR, '_volley', 'colOrder.json'), 'utf8'));
  assert.deepStrictEqual(colOrder, ['Alpha', 'Beta']);

  // Re-save with the collections swapped — colOrder.json (and thus load order) should follow.
  saveData({ cols: [{ name: 'Beta', requests: [], folders: [] }, { name: 'Alpha', requests: [], folders: [] }], envs: [], hist: [] });
  const loaded = loadData();
  assert.deepStrictEqual(loaded.cols.map(c => c.name), ['Beta', 'Alpha']);
});

test('parseDigestChallenge parses quoted and unquoted directives', () => {
  const out = parseDigestChallenge('Digest realm="testrealm@host.com", qop="auth", nonce="abc123", opaque="xyz", algorithm=MD5');
  assert.deepStrictEqual(out, { realm: 'testrealm@host.com', qop: 'auth', nonce: 'abc123', opaque: 'xyz', algorithm: 'MD5' });
});

test('buildDigestHeader computes a response matching RFC 2617\'s worked example', () => {
  // RFC 2617 §3.5 example vectors (algorithm=MD5, qop=auth)
  const creds = { username: 'Mufasa', password: 'Circle Of Life' };
  const challenge = { realm: 'testrealm@host.com', nonce: 'dcd98b7102dd2f0e8b11d0f600bfb0c093', qop: 'auth', opaque: '5ccc069c403ebaf9f0171e9517f40e41' };

  const header = buildDigestHeader(creds, 'GET', '/dir/index.html', challenge);
  const fields = parseDigestChallenge(header);

  assert.strictEqual(fields.username, 'Mufasa');
  assert.strictEqual(fields.realm, challenge.realm);
  assert.strictEqual(fields.nonce, challenge.nonce);
  assert.strictEqual(fields.opaque, challenge.opaque);
  assert.strictEqual(fields.qop, 'auth');
  assert.strictEqual(fields.nc, '00000001');
  assert.match(fields.response, /^[a-f0-9]{32}$/);

  // The response should be reproducible with the same nc/cnonce
  const md5 = s => require('crypto').createHash('md5').update(s).digest('hex');
  const ha1 = md5(`${creds.username}:${challenge.realm}:${creds.password}`);
  const ha2 = md5(`GET:/dir/index.html`);
  const expected = md5(`${ha1}:${challenge.nonce}:${fields.nc}:${fields.cnonce}:${challenge.qop}:${ha2}`);
  assert.strictEqual(fields.response, expected);
});

test('parseSetCookie parses name/value and attributes', () => {
  const cookie = parseSetCookie('session=abc123; Path=/api; Domain=example.com; Secure; Max-Age=3600', 'fallback.com');
  assert.strictEqual(cookie.name, 'session');
  assert.strictEqual(cookie.value, 'abc123');
  assert.strictEqual(cookie.path, '/api');
  assert.strictEqual(cookie.domain, 'example.com');
  assert.strictEqual(cookie.secure, true);
  assert.ok(cookie.expires > Date.now());
});

test('parseSetCookie defaults domain/path when not specified', () => {
  const cookie = parseSetCookie('foo=bar', 'example.com');
  assert.strictEqual(cookie.domain, 'example.com');
  assert.strictEqual(cookie.path, '/');
  assert.strictEqual(cookie.expires, null);
  assert.strictEqual(cookie.secure, false);
});

test('cookieMatches checks domain, path, expiry, and secure', () => {
  const cookie = { name: 'a', value: '1', domain: 'example.com', path: '/api', expires: null, secure: false };

  assert.strictEqual(cookieMatches(cookie, new URL('https://example.com/api/users')), true);
  assert.strictEqual(cookieMatches(cookie, new URL('https://sub.example.com/api')), true);
  assert.strictEqual(cookieMatches(cookie, new URL('https://other.com/api')), false);
  assert.strictEqual(cookieMatches(cookie, new URL('https://example.com/other')), false);

  const expired = { ...cookie, expires: Date.now() - 1000 };
  assert.strictEqual(cookieMatches(expired, new URL('https://example.com/api')), false);

  const secureCookie = { ...cookie, secure: true };
  assert.strictEqual(cookieMatches(secureCookie, new URL('http://example.com/api')), false);
  assert.strictEqual(cookieMatches(secureCookie, new URL('https://example.com/api')), true);
});

test('updateJarCookie inserts, updates, and removes cookies', () => {
  const jar = [];
  updateJarCookie(jar, { name: 'a', value: '1', domain: 'example.com', path: '/', expires: null });
  assert.strictEqual(jar.length, 1);

  updateJarCookie(jar, { name: 'a', value: '2', domain: 'example.com', path: '/', expires: null });
  assert.strictEqual(jar.length, 1);
  assert.strictEqual(jar[0].value, '2');

  updateJarCookie(jar, { name: 'a', value: '3', domain: 'example.com', path: '/', expires: Date.now() - 1000 });
  assert.strictEqual(jar.length, 0, 'an expired cookie should remove the existing entry');
});

test('saveCookies + loadCookies round trip', () => {
  resetData();
  saveCookies([{ name: 'a', value: '1', domain: 'example.com', path: '/', expires: null, secure: false }]);
  const jar = loadCookies();
  assert.strictEqual(jar.length, 1);
  assert.strictEqual(jar[0].name, 'a');
});

// ─── CLI args ───────────────────────────────────────────────────────────────────

test('getCliArg parses --name=value and --name value forms', () => {
  const origArgv = process.argv;
  try {
    process.argv = [...origArgv.slice(0, 2), '--data-dir=/tmp/shared', '--port', '3000'];
    assert.strictEqual(getCliArg('data-dir'), '/tmp/shared');
    assert.strictEqual(getCliArg('port'), '3000');
    assert.strictEqual(getCliArg('missing'), undefined);
  } finally {
    process.argv = origArgv;
  }
});

// ─── Mock server ──────────────────────────────────────────────────────────────

test('findMockMatch matches method and :param path segments', () => {
  const routes = [
    { method: 'GET', path: '/users/:id', status: 200, body: '{"ok":true}' },
    { method: 'POST', path: '/users', status: 201, body: '{}' },
  ];

  assert.deepEqual(findMockMatch(routes, 'GET', '/users/42'), routes[0]);
  assert.strictEqual(findMockMatch(routes, 'GET', '/users/42/orders'), null);
  assert.deepEqual(findMockMatch(routes, 'POST', '/users'), routes[1]);
  assert.strictEqual(findMockMatch(routes, 'DELETE', '/users/42'), null);
});

test('startMockServer/stopMockServer/mockStatus round trip and serve a route', async () => {
  assert.deepEqual(mockStatus(), { running: false, port: null, routes: 0 });

  const routes = [{ method: 'GET', path: '/ping', status: 200, headers: [{ key: 'X-Mock', value: '1' }], body: '{"pong":true}', delay: 0 }];
  const { port } = await startMockServer(0, routes);
  assert.deepEqual(mockStatus(), { running: true, port, routes: 1 });

  const res = await fetch(`http://127.0.0.1:${port}/ping`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get('x-mock'), '1');
  assert.deepEqual(await res.json(), { pong: true });

  const missing = await fetch(`http://127.0.0.1:${port}/nope`);
  assert.strictEqual(missing.status, 404);

  await stopMockServer();
  assert.deepEqual(mockStatus(), { running: false, port: null, routes: 0 });
});

test('startCaptureServer/stopCaptureServer/captureStatus round trip and log an incoming request', async () => {
  clearCaptureLog();
  assert.deepEqual(captureStatus(), { running: false, port: null, count: 0 });

  const { port } = await startCaptureServer(0);
  assert.deepEqual(captureStatus(), { running: true, port, count: 0 });

  const res = await fetch(`http://127.0.0.1:${port}/hooks/order-created?id=42`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'X-Signature': 'abc123' },
    body:    JSON.stringify({ hello: 'world' }),
  });
  assert.strictEqual(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });

  assert.strictEqual(captureStatus().count, 1);
  const [entry] = getCaptureLog();
  assert.strictEqual(entry.method, 'POST');
  assert.strictEqual(entry.path, '/hooks/order-created');
  assert.strictEqual(entry.query, '?id=42');
  assert.strictEqual(entry.headers['x-signature'], 'abc123');
  assert.strictEqual(entry.body, JSON.stringify({ hello: 'world' }));

  clearCaptureLog();
  assert.strictEqual(captureStatus().count, 0);

  await stopCaptureServer();
  assert.deepEqual(captureStatus(), { running: false, port: null, count: 0 });
});

// ─── WebSocket relay primitives ──────────────────────────────────────────────

test('wsAcceptKey computes the RFC 6455 example Sec-WebSocket-Accept value', () => {
  // From RFC 6455 section 1.3.
  assert.strictEqual(wsAcceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('encodeWsFrame/WsFrameDecoder round trip a masked and an unmasked text frame', () => {
  const decoder = new WsFrameDecoder();

  const masked = encodeWsFrame(WS_OP.TEXT, 'hello', true);
  let frames = decoder.push(masked);
  assert.strictEqual(frames.length, 1);
  assert.strictEqual(frames[0].opcode, WS_OP.TEXT);
  assert.strictEqual(frames[0].fin, true);
  assert.strictEqual(frames[0].payload.toString('utf8'), 'hello');

  const unmasked = encodeWsFrame(WS_OP.BINARY, Buffer.from([1, 2, 3]), false);
  frames = decoder.push(unmasked);
  assert.strictEqual(frames.length, 1);
  assert.strictEqual(frames[0].opcode, WS_OP.BINARY);
  assert.deepStrictEqual([...frames[0].payload], [1, 2, 3]);
});

test('WsFrameDecoder handles a frame split across multiple chunks and a payload >= 65536 bytes', () => {
  const decoder = new WsFrameDecoder();
  const payload = Buffer.alloc(70000, 0x41); // 'A' * 70000 -> 64-bit length field
  const frame   = encodeWsFrame(WS_OP.BINARY, payload, false);

  const mid = 10;
  assert.deepStrictEqual(decoder.push(frame.subarray(0, mid)), []);
  const frames = decoder.push(frame.subarray(mid));
  assert.strictEqual(frames.length, 1);
  assert.strictEqual(frames[0].payload.length, 70000);
  assert.ok(frames[0].payload.every(b => b === 0x41));
});

test.after(() => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});
