'use strict';

// HTTP-level tests for server.js: /api/data, /api/save, /api/proxy, and
// static file serving. Run with `node --test`.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'volley-test-http-'));
process.env.VOLLEY_DATA_DIR = DATA_DIR;

const { server, parseDigestChallenge, wsAcceptKey, encodeWsFrame, WsFrameDecoder, WS_OP } = require('../server.js');

let base;

test.before(() => new Promise(resolve => {
  server.listen(0, '127.0.0.1', () => {
    base = `http://127.0.0.1:${server.address().port}`;
    resolve();
  });
}));

test.after(() => {
  server.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

test('GET /api/data returns default envs/hist for an empty data dir', async () => {
  const res = await fetch(`${base}/api/data`);
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/json/);

  const data = await res.json();
  assert.deepStrictEqual(data.cols, []);
  assert.deepStrictEqual(data.envs, [{ id: 'default', name: 'No Environment', vars: [] }]);
  assert.strictEqual(data.activeEnv, 'default');
  assert.deepStrictEqual(data.hist, []);
  assert.deepStrictEqual(data.openTabs, []);
  assert.strictEqual(data.activeIndex, -1);
});

test('POST /api/save then GET /api/data round trips collections', async () => {
  const payload = {
    cols: [{ name: 'Demo', requests: [{ id: 'r1', name: 'Ping', method: 'GET', url: '/ping' }], folders: [] }],
    envs: [{ id: 'default', name: 'No Environment', vars: [{ id: 'v1', key: 'token', value: 'abc', enabled: true }] }],
    activeEnv: 'default',
    hist: [{ method: 'GET', url: '/ping', status: 200, elapsed: 5 }],
    openTabs: [{ col: 'Demo', folder: null, name: 'Ping', reqTab: 'body' }],
    activeIndex: 0,
  };

  const saveRes = await fetch(`${base}/api/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  assert.strictEqual(saveRes.status, 200);
  assert.deepStrictEqual(await saveRes.json(), { ok: true });

  const dataRes = await fetch(`${base}/api/data`);
  const data = await dataRes.json();
  assert.strictEqual(data.cols.length, 1);
  assert.strictEqual(data.cols[0].name, 'Demo');
  assert.strictEqual(data.cols[0].requests[0].name, 'Ping');
  assert.strictEqual(data.envs[0].vars[0].value, 'abc');
  assert.strictEqual(data.activeEnv, 'default');
  assert.strictEqual(data.hist[0].url, '/ping');
  assert.deepStrictEqual(data.openTabs, [{ col: 'Demo', folder: null, name: 'Ping', reqTab: 'body' }]);
  assert.strictEqual(data.activeIndex, 0);
});

test('POST /api/save with invalid JSON returns ok:false', async () => {
  const res = await fetch(`${base}/api/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: 'not json',
  });
  assert.strictEqual(res.status, 500);
  const data = await res.json();
  assert.strictEqual(data.ok, false);
  assert.ok(data.error);
});

test('POST /api/proxy forwards a request to the target URL and returns the response', async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'X-Test': 'yes' });
    res.end(JSON.stringify({ hello: 'world' }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}/`;

  try {
    const res = await fetch(`${base}/api/proxy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: upstreamUrl, method: 'GET', headers: {} }),
    });
    assert.strictEqual(res.status, 200);

    const data = await res.json();
    assert.strictEqual(data.ok, true);
    assert.strictEqual(data.status, 200);
    assert.strictEqual(data.headers['x-test'], 'yes');

    const body = JSON.parse(Buffer.from(data.bodyBase64, 'base64').toString('utf8'));
    assert.deepStrictEqual(body, { hello: 'world' });
  } finally {
    upstream.close();
  }
});

test('POST /api/proxy supports a raw request body', async () => {
  const received = [];
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      received.push(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}/`;

  try {
    const res = await fetch(`${base}/api/proxy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: upstreamUrl, method: 'POST', headers: { 'Content-Type': 'application/json' },
        bodyKind: 'raw', body: '{"hello":"world"}',
      }),
    });
    assert.strictEqual((await res.json()).ok, true);
    assert.strictEqual(received[0], '{"hello":"world"}');
  } finally {
    upstream.close();
  }
});

test('POST /api/proxy supports formdata and urlencoded request bodies', async () => {
  const received = [];
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      received.push({ contentType: req.headers['content-type'], body });
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}/`;

  try {
    const formdataRes = await fetch(`${base}/api/proxy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: upstreamUrl, method: 'POST', headers: {},
        bodyKind: 'formdata', body: [{ key: 'name', value: 'salvo' }],
      }),
    });
    assert.strictEqual((await formdataRes.json()).ok, true);
    assert.match(received[0].contentType, /multipart\/form-data/);
    assert.match(received[0].body, /name="name"[\s\S]*salvo/);

    const urlencodedRes = await fetch(`${base}/api/proxy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: upstreamUrl, method: 'POST', headers: {},
        bodyKind: 'urlencoded', body: [{ key: 'a', value: 'b' }],
      }),
    });
    assert.strictEqual((await urlencodedRes.json()).ok, true);
    assert.strictEqual(received[1].body, 'a=b');
  } finally {
    upstream.close();
  }
});

test('POST /api/proxy supports a form-data file upload and a binary body', async () => {
  const received = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      received.push({ contentType: req.headers['content-type'], body: Buffer.concat(chunks) });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}/`;

  try {
    const fileData = Buffer.from('hello file').toString('base64');
    const fileRes = await fetch(`${base}/api/proxy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: upstreamUrl, method: 'POST', headers: {},
        bodyKind: 'formdata',
        body: [{ key: 'upload', type: 'file', fileName: 'a.txt', fileMimeType: 'text/plain', fileData }],
      }),
    });
    assert.strictEqual((await fileRes.json()).ok, true);
    assert.match(received[0].contentType, /multipart\/form-data/);
    const formBody = received[0].body.toString('utf8');
    assert.match(formBody, /name="upload"; filename="a\.txt"/);
    assert.match(formBody, /hello file/);

    const binaryData = Buffer.from('binary payload').toString('base64');
    const binaryRes = await fetch(`${base}/api/proxy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: upstreamUrl, method: 'POST', headers: {},
        bodyKind: 'binary',
        body: { fileName: 'data.bin', fileMimeType: 'application/octet-stream', fileData: binaryData },
      }),
    });
    assert.strictEqual((await binaryRes.json()).ok, true);
    assert.strictEqual(received[1].body.toString('utf8'), 'binary payload');
  } finally {
    upstream.close();
  }
});

test('GET/POST /api/mock/* starts, status-checks, and stops the local mock server', async () => {
  const startRes = await fetch(`${base}/api/mock/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      port: 0,
      routes: [{ method: 'GET', path: '/ping', status: 200, headers: [], body: '{"pong":true}', delay: 0 }],
    }),
  });
  const start = await startRes.json();
  assert.strictEqual(start.ok, true);
  assert.strictEqual(start.routes, 1);
  assert.ok(start.port > 0);

  const statusRes = await fetch(`${base}/api/mock/status`);
  const status = await statusRes.json();
  assert.strictEqual(status.running, true);
  assert.strictEqual(status.port, start.port);

  const mockRes = await fetch(`http://127.0.0.1:${start.port}/ping`);
  assert.deepStrictEqual(await mockRes.json(), { pong: true });

  const stopRes = await fetch(`${base}/api/mock/stop`, { method: 'POST' });
  assert.deepStrictEqual(await stopRes.json(), { ok: true });

  const statusAfter = await (await fetch(`${base}/api/mock/status`)).json();
  assert.strictEqual(statusAfter.running, false);
});

test('GET/POST /api/webhooks/* starts capture, logs an incoming request, and stops', async () => {
  const startRes = await fetch(`${base}/api/webhooks/start`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ port: 0 }),
  });
  const start = await startRes.json();
  assert.strictEqual(start.ok, true);
  assert.ok(start.port > 0);

  const hookRes = await fetch(`http://127.0.0.1:${start.port}/hooks/ping`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hello: 'world' }),
  });
  assert.strictEqual(hookRes.status, 200);
  assert.deepStrictEqual(await hookRes.json(), { ok: true });

  const statusRes = await fetch(`${base}/api/webhooks/status`);
  const status = await statusRes.json();
  assert.strictEqual(status.running, true);
  assert.strictEqual(status.count, 1);

  const logRes = await fetch(`${base}/api/webhooks/log`);
  const { requests } = await logRes.json();
  assert.strictEqual(requests.length, 1);
  assert.strictEqual(requests[0].method, 'POST');
  assert.strictEqual(requests[0].path, '/hooks/ping');
  assert.strictEqual(requests[0].body, JSON.stringify({ hello: 'world' }));

  const clearRes = await fetch(`${base}/api/webhooks/clear`, { method: 'POST' });
  assert.deepStrictEqual(await clearRes.json(), { ok: true });
  assert.strictEqual((await (await fetch(`${base}/api/webhooks/log`)).json()).requests.length, 0);

  const stopRes = await fetch(`${base}/api/webhooks/stop`, { method: 'POST' });
  assert.deepStrictEqual(await stopRes.json(), { ok: true });

  const statusAfter = await (await fetch(`${base}/api/webhooks/status`)).json();
  assert.strictEqual(statusAfter.running, false);
});

test('POST /api/proxy transparently answers a Digest auth challenge', async () => {
  const creds = { username: 'alice', password: 'secret' };
  const realm = 'testrealm@host.com';
  const nonce = 'dcd98b7102dd2f0e8b11d0f600bfb0c093';
  const qop   = 'auth';

  const upstream = http.createServer((req, res) => {
    const auth = req.headers['authorization'];
    if (!auth || !auth.startsWith('Digest')) {
      res.writeHead(401, {
        'WWW-Authenticate': `Digest realm="${realm}", nonce="${nonce}", qop="${qop}"`,
      });
      res.end();
      return;
    }

    // Recompute the expected digest response using the cnonce/nc the client sent,
    // since buildDigestHeader generates a fresh random cnonce each call.
    const sent = parseDigestChallenge(auth);
    const md5  = s => require('crypto').createHash('md5').update(s).digest('hex');
    const ha1  = md5(`${creds.username}:${realm}:${creds.password}`);
    const ha2  = md5(`GET:/`);
    const expectedResponse = md5(`${ha1}:${nonce}:${sent.nc}:${sent.cnonce}:${qop}:${ha2}`);

    if (sent.username === creds.username && sent.response === expectedResponse) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('authenticated');
    } else {
      res.writeHead(401);
      res.end();
    }
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}/`;

  try {
    const res = await fetch(`${base}/api/proxy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: upstreamUrl, method: 'GET', headers: {},
        digestAuth: creds,
      }),
    });
    const data = await res.json();
    assert.strictEqual(data.ok, true);
    assert.strictEqual(data.status, 200);
    assert.strictEqual(Buffer.from(data.bodyBase64, 'base64').toString('utf8'), 'authenticated');
  } finally {
    upstream.close();
  }
});

test('POST /api/proxy returns ok:false when the upstream is unreachable', async () => {
  const res = await fetch(`${base}/api/proxy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'http://127.0.0.1:1/', method: 'GET', headers: {} }),
  });
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.ok, false);
  assert.ok(data.error);
});

test('POST /api/proxy stores Set-Cookie responses and resends them on later requests', async () => {
  const receivedCookies = [];
  const upstream = http.createServer((req, res) => {
    receivedCookies.push(req.headers['cookie'] || null);
    if (!req.headers['cookie']) {
      res.writeHead(200, { 'Set-Cookie': ['session=abc123; Path=/', 'theme=dark; Path=/'] });
    } else {
      res.writeHead(200);
    }
    res.end('ok');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}/`;

  try {
    // First request: upstream sets two cookies.
    const res1 = await fetch(`${base}/api/proxy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: upstreamUrl, method: 'GET', headers: {} }),
    });
    assert.strictEqual((await res1.json()).ok, true);
    assert.strictEqual(receivedCookies[0], null);

    // The jar should now contain both cookies.
    const jarRes = await fetch(`${base}/api/cookies`);
    const { cookies } = await jarRes.json();
    const names = cookies.map(c => c.name).sort();
    assert.deepStrictEqual(names, ['session', 'theme']);

    // Second request: cookies should be sent back to the upstream.
    const res2 = await fetch(`${base}/api/proxy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: upstreamUrl, method: 'GET', headers: {} }),
    });
    assert.strictEqual((await res2.json()).ok, true);
    assert.match(receivedCookies[1], /session=abc123/);
    assert.match(receivedCookies[1], /theme=dark/);

    // DELETE /api/cookies removes a single cookie.
    const delRes = await fetch(`${base}/api/cookies`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: cookies[0].domain, path: cookies[0].path, name: cookies[0].name }),
    });
    const delData = await delRes.json();
    assert.strictEqual(delData.ok, true);
    assert.strictEqual(delData.cookies.length, 1);

    // DELETE with no body clears the whole jar.
    const clearRes = await fetch(`${base}/api/cookies`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.deepStrictEqual((await clearRes.json()).cookies, []);
  } finally {
    upstream.close();
  }
});

test('GET / serves index.html', async () => {
  const res = await fetch(`${base}/`);
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const text = await res.text();
  assert.match(text, /<html/i);
});

test('GET /js/state.js serves a JS file with the right content type', async () => {
  const res = await fetch(`${base}/js/state.js`);
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/javascript/);
});

test('GET /does-not-exist returns 404', async () => {
  const res = await fetch(`${base}/does-not-exist`);
  assert.strictEqual(res.status, 404);
});

// ─── OAuth2 Authorization Code callback ─────────────────────────────────────

test('GET /api/oauth/callback posts code/state back to the opener and closes itself', async () => {
  const res = await fetch(`${base}/api/oauth/callback?code=abc123&state=xyz`);
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);

  const html = await res.text();
  assert.match(html, /"source":"volley-oauth"/);
  assert.match(html, /"code":"abc123"/);
  assert.match(html, /"state":"xyz"/);
  assert.match(html, /window\.close\(\)/);
});

test('GET /api/oauth/callback reports an error result and escapes "<" to prevent script injection', async () => {
  const res = await fetch(`${base}/api/oauth/callback?error=${encodeURIComponent('access_denied</script><script>alert(1)')}`);
  assert.strictEqual(res.status, 200);

  const html = await res.text();
  assert.doesNotMatch(html, /<\/script><script>alert/);
  assert.match(html, /access_denied/);
  assert.match(html, /Authorization failed/);
});

// ─── /api/proxy-stream (SSE) ────────────────────────────────────────────────

test('POST /api/proxy-stream streams an SSE response and forwards upstream status/headers', async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Test': 'yes' });
    res.write('event: ping\ndata: hello\n\n');
    setTimeout(() => {
      res.write('data: world\n\n');
      res.end();
    }, 10);
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}/`;

  try {
    const res = await fetch(`${base}/api/proxy-stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: upstreamUrl, method: 'GET', headers: {} }),
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('x-volley-stream'), 'ok');
    assert.strictEqual(res.headers.get('x-volley-upstream-status'), '200');

    const upstreamHeaders = JSON.parse(Buffer.from(res.headers.get('x-volley-upstream-headers'), 'base64').toString('utf8'));
    assert.strictEqual(upstreamHeaders['x-test'], 'yes');

    const text = await res.text();
    assert.match(text, /event: ping\ndata: hello\n\n/);
    assert.match(text, /data: world\n\n/);
  } finally {
    upstream.close();
  }
});

test('POST /api/proxy-stream returns an error payload when the upstream is unreachable', async () => {
  const res = await fetch(`${base}/api/proxy-stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'http://127.0.0.1:1/', method: 'GET', headers: {} }),
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get('x-volley-stream'), 'error');

  const data = await res.json();
  assert.strictEqual(data.ok, false);
  assert.ok(data.error);
});

test('POST /api/proxy-stream transparently answers a Digest auth challenge', async () => {
  const creds = { username: 'alice', password: 'secret' };
  const realm = 'testrealm@host.com';
  const nonce = 'dcd98b7102dd2f0e8b11d0f600bfb0c093';
  const qop   = 'auth';

  const upstream = http.createServer((req, res) => {
    const auth = req.headers['authorization'];
    if (!auth || !auth.startsWith('Digest')) {
      res.writeHead(401, {
        'WWW-Authenticate': `Digest realm="${realm}", nonce="${nonce}", qop="${qop}"`,
      });
      res.end();
      return;
    }

    const sent = parseDigestChallenge(auth);
    const md5  = s => require('crypto').createHash('md5').update(s).digest('hex');
    const ha1  = md5(`${creds.username}:${realm}:${creds.password}`);
    const ha2  = md5(`GET:/`);
    const expectedResponse = md5(`${ha1}:${nonce}:${sent.nc}:${sent.cnonce}:${qop}:${ha2}`);

    if (sent.username === creds.username && sent.response === expectedResponse) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('authenticated');
    } else {
      res.writeHead(401);
      res.end();
    }
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}/`;

  try {
    const res = await fetch(`${base}/api/proxy-stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: upstreamUrl, method: 'GET', headers: {},
        digestAuth: creds,
      }),
    });
    assert.strictEqual(res.headers.get('x-volley-upstream-status'), '200');
    assert.strictEqual(await res.text(), 'authenticated');
  } finally {
    upstream.close();
  }
});

test('POST /api/proxy-stream stores Set-Cookie responses and resends them on later requests', async () => {
  const receivedCookies = [];
  const upstream = http.createServer((req, res) => {
    receivedCookies.push(req.headers['cookie'] || null);
    if (!req.headers['cookie']) {
      res.writeHead(200, { 'Set-Cookie': ['session=abc123; Path=/', 'theme=dark; Path=/'] });
    } else {
      res.writeHead(200);
    }
    res.end('ok');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}/`;

  try {
    await fetch(`${base}/api/proxy-stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: upstreamUrl, method: 'GET', headers: {} }),
    });
    assert.strictEqual(receivedCookies[0], null);

    const jarRes = await fetch(`${base}/api/cookies`);
    const { cookies } = await jarRes.json();
    assert.deepStrictEqual(cookies.map(c => c.name).sort(), ['session', 'theme']);

    await fetch(`${base}/api/proxy-stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: upstreamUrl, method: 'GET', headers: {} }),
    });
    assert.match(receivedCookies[1], /session=abc123/);
    assert.match(receivedCookies[1], /theme=dark/);

    // Clean up the jar so this test doesn't affect later ones.
    await fetch(`${base}/api/cookies`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
  } finally {
    upstream.close();
  }
});

// ─── /api/ws-proxy (WebSocket relay) ────────────────────────────────────────

// Minimal WS server built from server.js's own frame primitives — echoes
// back any text frame it receives, prefixed with "echo:".
function createEchoWsServer() {
  return http.createServer().on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${wsAcceptKey(key)}\r\n\r\n`
    );
    const decoder = new WsFrameDecoder();
    socket.on('data', chunk => {
      for (const frame of decoder.push(chunk)) {
        if (frame.opcode === WS_OP.CLOSE) { socket.end(); return; }
        if (frame.opcode === WS_OP.TEXT) {
          socket.write(encodeWsFrame(WS_OP.TEXT, `echo:${frame.payload.toString('utf8')}`, false));
        }
      }
    });
  });
}

function wsProxyUrl() {
  return `ws://127.0.0.1:${server.address().port}/api/ws-proxy`;
}

// Queues incoming messages from `ws` so nextMessage() can be awaited
// sequentially without missing messages that arrive back-to-back before the
// next nextMessage() call registers its listener.
function queueMessages(ws) {
  const queue = [];
  const waiters = [];
  ws.addEventListener('message', ev => {
    const msg = JSON.parse(ev.data);
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(msg);
    else queue.push(msg);
  });
  ws.addEventListener('error', err => {
    const waiter = waiters.shift();
    if (waiter) waiter.reject(err);
  });
  return () => {
    if (queue.length) return Promise.resolve(queue.shift());
    return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
  };
}

test('WS proxy relays messages between the browser and an upstream WebSocket server', async () => {
  const upstream = createEchoWsServer();
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamUrl = `ws://127.0.0.1:${upstream.address().port}/`;

  const ws = new WebSocket(wsProxyUrl());
  try {
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    const nextMessage = queueMessages(ws);
    ws.send(JSON.stringify({ url: upstreamUrl, headers: {} }));

    const opened = await nextMessage();
    assert.strictEqual(opened.type, 'open');

    ws.send('hello');
    const echoed = await nextMessage();
    assert.deepStrictEqual(echoed, { type: 'message', binary: false, data: 'echo:hello' });
  } finally {
    ws.close();
    upstream.close();
  }
});

test('WS proxy forwards custom headers to the upstream target', async () => {
  const upstream = http.createServer().on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${wsAcceptKey(key)}\r\n\r\n`
    );
    socket.write(encodeWsFrame(WS_OP.TEXT, JSON.stringify({ authorization: req.headers['authorization'] || null }), false));
    socket.resume();
    socket.on('end', () => socket.end());
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamUrl = `ws://127.0.0.1:${upstream.address().port}/`;

  const ws = new WebSocket(wsProxyUrl());
  try {
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    const nextMessage = queueMessages(ws);
    ws.send(JSON.stringify({ url: upstreamUrl, headers: { Authorization: 'Bearer abc123' } }));

    const opened = await nextMessage();
    assert.strictEqual(opened.type, 'open');

    const echoed = await nextMessage();
    assert.deepStrictEqual(JSON.parse(echoed.data), { authorization: 'Bearer abc123' });
  } finally {
    ws.close();
    upstream.close();
  }
});

test('WS proxy reports an error when the upstream is unreachable', async () => {
  const ws = new WebSocket(wsProxyUrl());
  try {
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    const nextMessage = queueMessages(ws);
    ws.send(JSON.stringify({ url: 'ws://127.0.0.1:1/', headers: {} }));

    const msg = await nextMessage();
    assert.strictEqual(msg.type, 'error');
    assert.ok(msg.message);
  } finally {
    ws.close();
  }
});

test('WS proxy notifies the browser when the upstream closes the connection', async () => {
  const upstream = http.createServer().on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${wsAcceptKey(key)}\r\n\r\n`
    );
    socket.end();
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamUrl = `ws://127.0.0.1:${upstream.address().port}/`;

  const ws = new WebSocket(wsProxyUrl());
  try {
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    const nextMessage = queueMessages(ws);
    ws.send(JSON.stringify({ url: upstreamUrl, headers: {} }));

    const opened = await nextMessage();
    assert.strictEqual(opened.type, 'open');

    const closed = await nextMessage();
    assert.strictEqual(closed.type, 'close');
  } finally {
    ws.close();
    upstream.close();
  }
});

// ─── /api/mcp-stdio (MCP stdio relay) ───────────────────────────────────────

function mcpStdioUrl() {
  return `ws://127.0.0.1:${server.address().port}/api/mcp-stdio`;
}

// A tiny line-delimited JSON-RPC "MCP server": echoes back each request with
// its params, also emitting one stderr line per request for good measure.
const ECHO_MCP_SERVER_SCRIPT = `
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  process.stderr.write('got ' + msg.method + '\\n');
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { echo: msg.params || null } }) + '\\n');
});
`;

test('MCP stdio relay spawns a process and relays newline-delimited JSON-RPC', async () => {
  const ws = new WebSocket(mcpStdioUrl());
  try {
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    const nextMessage = queueMessages(ws);
    ws.send(JSON.stringify({ command: 'node', args: ['-e', ECHO_MCP_SERVER_SCRIPT] }));

    const opened = await nextMessage();
    assert.strictEqual(opened.type, 'open');

    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { hello: 'world' } }));

    let msg = await nextMessage();
    if (msg.type === 'stderr') msg = await nextMessage();
    assert.strictEqual(msg.type, 'message');
    assert.deepStrictEqual(msg.data, { jsonrpc: '2.0', id: 1, result: { echo: { hello: 'world' } } });
  } finally {
    ws.close();
  }
});

test('MCP stdio relay reports an error for a command that cannot be spawned', async () => {
  const ws = new WebSocket(mcpStdioUrl());
  try {
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    const nextMessage = queueMessages(ws);
    ws.send(JSON.stringify({ command: '/no/such/command-salvo-test', args: [] }));

    const msg = await nextMessage();
    assert.strictEqual(msg.type, 'error');
    assert.ok(msg.message);
  } finally {
    ws.close();
  }
});

test('MCP stdio relay notifies the browser when the process exits', async () => {
  const ws = new WebSocket(mcpStdioUrl());
  try {
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    const nextMessage = queueMessages(ws);
    ws.send(JSON.stringify({ command: 'node', args: ['-e', 'process.exit(0)'] }));

    const opened = await nextMessage();
    assert.strictEqual(opened.type, 'open');

    const closed = await nextMessage();
    assert.strictEqual(closed.type, 'close');
    assert.strictEqual(closed.code, 0);
  } finally {
    ws.close();
  }
});
