'use strict';

// End-to-end tests for protocol paths that weren't otherwise covered:
// GraphQL bodies, OAuth2 token acquisition/refresh, SSE streaming, and the
// MCP Streamable HTTP transport. These run against a real server.js instance
// (like test/server-http.test.js) plus small local upstream servers, and
// exercise the actual js/send.js + js/mcp.js code in a vm sandbox with a real
// `fetch` wired to that server. Run with `node --test`.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const vm = require('vm');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'volley-test-proto-'));
process.env.VOLLEY_DATA_DIR = DATA_DIR;

const { server } = require('../server.js');

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

// Builds a vm sandbox with js/state.js, js/request.js, js/send.js and
// js/mcp.js loaded, a real `fetch` that resolves relative URLs (as used by
// these files for /api/proxy, /api/proxy-stream, etc.) against `base`, and
// minimal UI stubs.
function loadSandbox() {
  const sandbox = {
    console,
    document: {
      createElement: () => ({ remove: () => {}, classList: { toggle() {}, add() {}, remove() {} }, style: {} }),
      body: { appendChild: () => {} },
      getElementById: () => null,
      querySelectorAll: () => [],
    },
    window: {},
    navigator: {},
    location: { origin: base, protocol: 'http:', host: new URL(base).host },
    fetch: (url, opts) => fetch(/^https?:\/\//i.test(url) ? url : `${base}${url}`, opts),
    Blob: function Blob() {},
    Event: function Event(type) { this.type = type; },
    URL, URLSearchParams, TextDecoder,
    btoa: s => Buffer.from(s, 'binary').toString('base64'),
    atob: s => Buffer.from(s, 'base64').toString('binary'),
    setTimeout, clearTimeout,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);

  for (const f of ['state.js', 'request.js', 'send.js', 'mcp.js']) {
    const src = fs.readFileSync(path.join(__dirname, '../js/' + f), 'utf8');
    vm.runInContext(src, sandbox, { filename: f });
  }

  vm.runInContext(`
    let _activeTab = null;
    function activeTab() { return _activeTab; }
    function scheduleDiskSave() {}
    function renderRespPanel() {}
    function updateSendBtn() {}
    function notify() {}
    function confirmDialog() { return Promise.resolve(true); }
    globalThis.state = state;
    globalThis.setActiveTab = t => { _activeTab = t; };
  `, sandbox, { filename: 'stubs.js' });

  return sandbox;
}

function makeReq(overrides = {}) {
  return {
    url: '', protocol: 'http', params: [], pathVars: [], headers: [], method: 'GET',
    body: { type: 'none', raw: '', formData: [], graphql: { query: '', variables: '' } },
    auth: { type: 'none', token: '', username: '', password: '', apiKey: '', apiValue: '', cachedToken: '', cachedExpiry: 0, jwtSecret: '' },
    description: '', comments: [],
    mock: { enabled: false, status: 200, headers: [], body: '', delay: 0 },
    examples: [],
    disabledAutoHeaders: [],
    ...overrides,
  };
}

// ─── GraphQL ────────────────────────────────────────────────────────────────

test('buildRequestArgs builds a GraphQL body (query + variables, interpolated) and sets Content-Type', async () => {
  const sandbox = loadSandbox();
  sandbox.state.envs[0].vars = [{ id: 'v1', key: 'userId', value: '42', enabled: true }];

  const req = makeReq({
    url: 'https://api.example.com/graphql',
    method: 'POST',
    body: { type: 'graphql', graphql: { query: 'query { user(id: "{{userId}}") { name } }', variables: '{"limit": 10}' } },
  });

  const { bodyKind, bodyPayload, headers } = await sandbox.buildRequestArgs(req);
  assert.strictEqual(bodyKind, 'graphql');
  assert.strictEqual(bodyPayload.query, 'query { user(id: "42") { name } }');
  assert.deepEqual(bodyPayload.variables, { limit: 10 });
  assert.strictEqual(headers['Content-Type'], 'application/json');
});

test('POST /api/proxy sends a GraphQL bodyKind as {query, variables} JSON to the upstream', async () => {
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ received: JSON.parse(body) }));
    });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));

  try {
    const upstreamUrl = `http://127.0.0.1:${upstream.address().port}/graphql`;
    const res = await fetch(`${base}/api/proxy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: upstreamUrl, method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        bodyKind: 'graphql',
        body: { query: 'query { ping }', variables: { a: 1 } },
      }),
    });
    const data = await res.json();
    assert.strictEqual(data.ok, true);
    assert.strictEqual(data.status, 200);

    const text = Buffer.from(data.bodyBase64, 'base64').toString('utf8');
    assert.deepStrictEqual(JSON.parse(text), { received: { query: 'query { ping }', variables: { a: 1 } } });
  } finally {
    upstream.close();
  }
});

// ─── OAuth2 token acquisition ──────────────────────────────────────────────

// Local "authorization server" — inspects the urlencoded grant request and
// returns a JSON token response.
function createTokenServer(handler) {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const params = new URLSearchParams(body);
      handler(params, res);
    });
  });
}

test('ensureOAuthToken (Client Credentials) fetches and caches an access token via /api/proxy', async () => {
  const tokenServer = createTokenServer((params, res) => {
    assert.strictEqual(params.get('grant_type'), 'client_credentials');
    assert.strictEqual(params.get('client_id'), 'cid');
    assert.strictEqual(params.get('client_secret'), 'csecret');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ access_token: 'tok-cc', expires_in: 3600 }));
  });
  await new Promise(resolve => tokenServer.listen(0, '127.0.0.1', resolve));

  try {
    const sandbox = loadSandbox();
    const auth = sandbox.defaultAuth();
    auth.type           = 'oauth2_cc';
    auth.accessTokenUrl = `http://127.0.0.1:${tokenServer.address().port}/token`;
    auth.clientId       = 'cid';
    auth.clientSecret   = 'csecret';

    const token = await sandbox.ensureOAuthToken(auth);
    assert.strictEqual(token, 'tok-cc');
    assert.strictEqual(auth.cachedToken, 'tok-cc');
    assert.ok(auth.cachedExpiry > Date.now());

    // A second call within the cache window must not hit the token server again.
    tokenServer.removeAllListeners('request');
    tokenServer.on('request', () => assert.fail('token server should not be called again while cached'));
    const token2 = await sandbox.ensureOAuthToken(auth);
    assert.strictEqual(token2, 'tok-cc');
  } finally {
    tokenServer.close();
  }
});

test('ensureOAuthToken (Authorization Code, expired) refreshes via refresh_token grant', async () => {
  const tokenServer = createTokenServer((params, res) => {
    assert.strictEqual(params.get('grant_type'), 'refresh_token');
    assert.strictEqual(params.get('refresh_token'), 'old-refresh');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ access_token: 'new-access', expires_in: 3600, refresh_token: 'new-refresh' }));
  });
  await new Promise(resolve => tokenServer.listen(0, '127.0.0.1', resolve));

  try {
    const sandbox = loadSandbox();
    const auth = sandbox.defaultAuth();
    auth.type               = 'oauth2_auth_code';
    auth.accessTokenUrl     = `http://127.0.0.1:${tokenServer.address().port}/token`;
    auth.cachedToken        = '';
    auth.cachedExpiry       = 0;
    auth.cachedRefreshToken = 'old-refresh';

    const token = await sandbox.ensureOAuthToken(auth);
    assert.strictEqual(token, 'new-access');
    assert.strictEqual(auth.cachedToken, 'new-access');
    assert.strictEqual(auth.cachedRefreshToken, 'new-refresh');
  } finally {
    tokenServer.close();
  }
});

test('ensureOAuthToken (Authorization Code, no token) throws a "Get Access Token" error without calling the server', async () => {
  const sandbox = loadSandbox();
  const auth = sandbox.defaultAuth();
  auth.type = 'oauth2_auth_code';

  await assert.rejects(sandbox.ensureOAuthToken(auth), /Get Access Token/);
});

// ─── SSE streaming ──────────────────────────────────────────────────────────

test('end-to-end SSE: /api/proxy-stream + extractSseEvents reconstruct events from a chunked upstream', async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('event: greeting\ndata: ' + JSON.stringify({ hello: 'world' }) + '\n\n');
    setTimeout(() => { res.write('data: second\n\n'); res.end(); }, 30);
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));

  try {
    const sandbox = loadSandbox();
    const upstreamUrl = `http://127.0.0.1:${upstream.address().port}/events`;

    const proxyRes = await sandbox.fetch('/api/proxy-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: upstreamUrl, method: 'GET', headers: {} }),
    });

    assert.notStrictEqual(proxyRes.headers.get('x-volley-stream'), 'error');
    const respHeaders = JSON.parse(sandbox.atob(proxyRes.headers.get('x-volley-upstream-headers') || ''));
    assert.match(respHeaders['content-type'], /text\/event-stream/);

    const reader  = proxyRes.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    const events = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { events: evts, remainder } = sandbox.extractSseEvents(buffer);
      buffer = remainder;
      events.push(...evts);
    }

    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[0].event, 'greeting');
    assert.deepStrictEqual(JSON.parse(events[0].data), { hello: 'world' });
    assert.strictEqual(events[1].event, 'message');
    assert.strictEqual(events[1].data, 'second');
  } finally {
    upstream.close();
  }
});

// ─── MCP — Streamable HTTP transport ───────────────────────────────────────

// A minimal Streamable-HTTP MCP server: replies to `initialize` with
// serverInfo + a session id, accepts the `notifications/initialized`
// notification (no id -> 202 empty body), and answers `tools/list`.
function createMockMcpHttpServer() {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let msg;
      try { msg = JSON.parse(body); } catch { msg = null; }

      if (!msg || msg.id === undefined) {
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end();
        return;
      }
      if (msg.method === 'initialize') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'sess-123' });
        res.end(JSON.stringify({
          jsonrpc: '2.0', id: msg.id,
          result: { protocolVersion: '2025-06-18', serverInfo: { name: 'MockMCP', version: '1.0' }, capabilities: {} },
        }));
        return;
      }
      if (msg.method === 'tools/list') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'echo', description: 'Echoes input' }] } }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } }));
    });
  });
}

test('connectMcp (mcp-http) performs the initialize handshake and a tools/list round trip', async () => {
  const mcpServer = createMockMcpHttpServer();
  await new Promise(resolve => mcpServer.listen(0, '127.0.0.1', resolve));

  try {
    const sandbox = loadSandbox();
    const req = makeReq({ url: `http://127.0.0.1:${mcpServer.address().port}/mcp`, protocol: 'mcp-http' });
    const tab = { id: 'mcp-tab', reqId: null, req, resp: null, respTab: 'body' };
    sandbox.setActiveTab(tab);

    await sandbox.connectMcp(tab);

    assert.strictEqual(tab.resp.status, 'open');
    assert.strictEqual(tab.resp.sessionId, 'sess-123');
    assert.deepEqual(tab.resp.serverInfo, { name: 'MockMCP', version: '1.0' });
    assert.strictEqual(tab.resp.protocolVersion, '2025-06-18');

    // initialize request + response, plus the notifications/initialized we sent.
    const methods = tab.resp.messages.filter(m => m.dir === 'sent').map(m => m.data.method);
    assert.deepEqual(methods, ['initialize', 'notifications/initialized']);
    assert.strictEqual(tab.resp.messages.find(m => m.dir === 'received')?.data.result.serverInfo.name, 'MockMCP');

    // Send a tools/list request through the same session.
    await sandbox.mcpSend(tab, { jsonrpc: '2.0', id: sandbox.nextMcpId(tab), method: 'tools/list' });
    const toolsResult = tab.resp.messages.find(m => m.dir === 'received' && m.data.result?.tools)?.data.result;
    assert.deepEqual(toolsResult.tools, [{ name: 'echo', description: 'Echoes input' }]);
  } finally {
    mcpServer.close();
  }
});
