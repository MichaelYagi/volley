'use strict';

// Tests for js/request.js (path variables, computed-headers preview), exercised
// in a vm sandbox since these files are written for the global browser scope
// (no modules/exports). Run with `node --test`.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadSandbox() {
  const sandbox = {
    console,
    document: {
      createElement: () => ({ remove: () => {} }),
      body: { appendChild: () => {} },
      getElementById: () => null,
      querySelectorAll: () => [],
    },
    window: {},
    navigator: {},
    fetch: () => Promise.reject(new Error('fetch not available in tests')),
    Blob: function Blob() {},
    Event: function Event(type) { this.type = type; },
    URL,
    btoa: s => Buffer.from(s, 'binary').toString('base64'),
    setTimeout, clearTimeout,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);

  const stateSrc   = fs.readFileSync(path.join(__dirname, '../js/state.js'), 'utf8');
  const requestSrc = fs.readFileSync(path.join(__dirname, '../js/request.js'), 'utf8');
  vm.runInContext(stateSrc, sandbox, { filename: 'state.js' });
  vm.runInContext(requestSrc, sandbox, { filename: 'request.js' });

  // request.js calls activeTab() (js/tabs.js) and reads _cookieJar (js/modals.js) —
  // provide minimal stand-ins and re-expose top-level `const`/`let` bindings as
  // sandbox properties since they aren't reflected on the context's global object.
  vm.runInContext(`
    let _cookieJar = [];
    let _activeTab = null;
    function activeTab() { return _activeTab; }
    function scheduleDiskSave() {}
    function syncMockRoutes() {}
    function syncTabIntoCols() {}
    function confirmDialog() { return Promise.resolve(true); }
    globalThis.state = state;
    globalThis.setActiveTab = t => { _activeTab = t; };
    globalThis.setCookieJar = j => { _cookieJar = j; };
  `, sandbox, { filename: 'stubs.js' });

  return sandbox;
}

function makeReq(overrides = {}) {
  return {
    url: '', params: [], pathVars: [], headers: [], method: 'GET',
    body: { type: 'none', raw: '', formData: [] },
    auth: { type: 'none', token: '', username: '', password: '', apiKey: '', apiValue: '', cachedToken: '', jwtSecret: '' },
    description: '', comments: [],
    mock: { enabled: false, status: 200, headers: [], body: '', delay: 0 },
    examples: [],
    disabledAutoHeaders: [],
    ...overrides,
  };
}

function makeTab(req) {
  return { req, reqTab: 'params' };
}

// ─── Path Variables ─────────────────────────────────────────────────────────

test('parsePathVarNames extracts :name segments from the URL path, ignoring ports', () => {
  const sandbox = loadSandbox();
  assert.deepEqual(sandbox.parsePathVarNames('https://api.example.com/users/:userId/orders/:orderId?foo=bar'), ['userId', 'orderId']);
  assert.deepEqual(sandbox.parsePathVarNames('localhost:3000/users/:id'), ['id']);
  assert.deepEqual(sandbox.parsePathVarNames('https://example.com/no/vars'), []);
});

test('syncPathVarsFromUrl rebuilds pathVars from the URL, preserving values and dropping removed names', () => {
  const sandbox = loadSandbox();
  const req = makeReq({ url: 'https://api.example.com/users/:userId/orders/:orderId' });
  sandbox.setActiveTab(makeTab(req));

  sandbox.syncPathVarsFromUrl();
  assert.strictEqual(req.pathVars.length, 2);
  assert.strictEqual(req.pathVars[0].key, 'userId');
  assert.strictEqual(req.pathVars[1].key, 'orderId');

  req.pathVars[0].value = '123';
  req.pathVars[1].value = '456';

  // Remove :orderId from the URL — its pathVar entry should be dropped, :userId's value kept.
  req.url = 'https://api.example.com/users/:userId';
  sandbox.syncPathVarsFromUrl();
  assert.strictEqual(req.pathVars.length, 1);
  assert.strictEqual(req.pathVars[0].key, 'userId');
  assert.strictEqual(req.pathVars[0].value, '123');
});

test('substitutePathVars replaces :name segments with interpolated values', () => {
  const sandbox = loadSandbox();
  const req = makeReq();
  sandbox.setActiveTab(makeTab(req));

  const url = sandbox.substitutePathVars(
    'https://api.example.com/users/:userId/orders/:orderId',
    [{ key: 'userId', value: '123' }, { key: 'orderId', value: '456' }]
  );
  assert.strictEqual(url, 'https://api.example.com/users/123/orders/456');

  // A name that's a prefix of another shouldn't be partially substituted.
  const url2 = sandbox.substitutePathVars('/things/:id/:identifier', [{ key: 'id', value: 'X' }, { key: 'identifier', value: 'Y' }]);
  assert.strictEqual(url2, '/things/X/Y');
});

// ─── Computed headers preview ───────────────────────────────────────────────

test('computedAuthHeaders reflects the Auth tab (Bearer)', () => {
  const sandbox = loadSandbox();
  const auth = { type: 'bearer', token: 'abc123' };
  assert.deepEqual(sandbox.computedAuthHeaders(auth), [{ key: 'Authorization', value: 'Bearer abc123' }]);
});

test('computedAuthHeaders reflects the Auth tab (OAuth2 Authorization Code)', () => {
  const sandbox = loadSandbox();
  assert.deepEqual(
    sandbox.computedAuthHeaders({ type: 'oauth2_auth_code', cachedToken: '' }),
    [{ key: 'Authorization', value: 'Bearer <sign in via "Get Access Token">' }]
  );
  assert.deepEqual(
    sandbox.computedAuthHeaders({ type: 'oauth2_auth_code', cachedToken: 'tok123' }),
    [{ key: 'Authorization', value: 'Bearer tok123' }]
  );
});

test('defaultAuth includes Authorization Code grant fields with PKCE on by default', () => {
  const sandbox = loadSandbox();
  const auth = sandbox.defaultAuth();
  assert.strictEqual(auth.authorizationUrl, '');
  assert.strictEqual(auth.redirectUri, '');
  assert.strictEqual(auth.pkce, true);
  assert.strictEqual(auth.cachedRefreshToken, '');
});

// ─── Auto-generated header opt-out (disabledAutoHeaders) ────────────────────

test('isAutoHeaderDisabled is false by default and true once a key is recorded (case-insensitive)', () => {
  const sandbox = loadSandbox();
  const req = makeReq({ disabledAutoHeaders: ['Authorization'] });
  assert.strictEqual(sandbox.isAutoHeaderDisabled(req, 'Authorization'), true);
  assert.strictEqual(sandbox.isAutoHeaderDisabled(req, 'authorization'), true);
  assert.strictEqual(sandbox.isAutoHeaderDisabled(req, 'Cookie'), false);
});

test('toggleAutoHeader records/clears a disabled auto-header on the active request', () => {
  const sandbox = loadSandbox();
  const req = makeReq({ auth: { type: 'bearer', token: 'abc123' } });
  sandbox.setActiveTab({ ...makeTab(req), reqTab: 'headers' });
  sandbox.document.getElementById = () => makeMockEl();

  sandbox.toggleAutoHeader('Authorization', false);
  assert.deepEqual(req.disabledAutoHeaders, ['authorization']);

  sandbox.toggleAutoHeader('Authorization', true);
  assert.deepEqual(req.disabledAutoHeaders, []);
});

test('kvComputedSectionsHTML renders the Auto-generated checkbox checked by default, unchecked once disabled', () => {
  const sandbox = loadSandbox();
  const req = makeReq({ auth: { type: 'bearer', token: 'abc123' } });
  sandbox.setActiveTab(makeTab(req));

  let html = sandbox.kvComputedSectionsHTML('headers');
  assert.match(html, /<input type="checkbox" checked onchange="toggleAutoHeader\('Authorization',this\.checked\);this\.closest\('\.kv-row'\)\.classList\.toggle\('kv-disabled',!this\.checked\)">/);

  req.disabledAutoHeaders = ['authorization'];
  html = sandbox.kvComputedSectionsHTML('headers');
  assert.match(html, /<input type="checkbox"  onchange="toggleAutoHeader\('Authorization',this\.checked\);this\.closest\('\.kv-row'\)\.classList\.toggle\('kv-disabled',!this\.checked\)">/);
});

test('computedCookieHeader adds a Cookie header for cookies matching the request URL', () => {
  const sandbox = loadSandbox();
  const req = makeReq({ url: 'https://api.example.com/widgets' });
  sandbox.setActiveTab(makeTab(req));
  sandbox.setCookieJar([
    { name: 'session', value: 'abc', domain: 'api.example.com', path: '/', secure: false, expires: null },
    { name: 'other',   value: 'xyz', domain: 'other.com',       path: '/', secure: false, expires: null },
  ]);

  const headers = sandbox.computedCookieHeader(req);
  assert.deepEqual(headers, [{ key: 'Cookie', value: 'session=abc', source: 'Cookie Jar' }]);
});

test('computedCookieHeader excludes expired and cross-domain cookies', () => {
  const sandbox = loadSandbox();
  const req = makeReq({ url: 'https://api.example.com/widgets' });
  sandbox.setActiveTab(makeTab(req));
  sandbox.setCookieJar([
    { name: 'expired', value: 'abc', domain: 'api.example.com', path: '/', secure: false, expires: Date.now() - 1000 },
    { name: 'other',   value: 'xyz', domain: 'other.com',       path: '/', secure: false, expires: null },
  ]);

  assert.deepEqual(sandbox.computedCookieHeader(req), []);
});

test('computedHeaders combines Auth and Cookie Jar sources (raw body Content-Type is not auto-generated)', () => {
  const sandbox = loadSandbox();
  const req = makeReq({
    url: 'https://api.example.com/widgets',
    auth: { type: 'bearer', token: 'tok' },
    body: { type: 'raw', raw: '{"a":1}', formData: [], contentType: 'json' },
  });
  sandbox.setActiveTab(makeTab(req));
  sandbox.setCookieJar([{ name: 'session', value: 'abc', domain: 'api.example.com', path: '/', secure: false, expires: null }]);

  const headers = sandbox.computedHeaders(req);
  assert.deepEqual(headers, [
    { key: 'Authorization', value: 'Bearer tok', source: 'Auth tab' },
    { key: 'Cookie', value: 'session=abc', source: 'Cookie Jar' },
  ]);
});

// ─── kvEditorHTML rendering ──────────────────────────────────────────────────

test('kvEditorHTML renders a Path Variables section with read-only keys and editable values', () => {
  const sandbox = loadSandbox();
  const req = makeReq({ pathVars: [{ id: '1', key: 'userId', value: '123' }] });
  sandbox.setActiveTab(makeTab(req));

  const html = sandbox.kvEditorHTML(req.params, 'params');
  assert.match(html, /Path Variables/);
  assert.match(html, /value="userId" disabled/);
  assert.match(html, /value="123"[^>]*oninput="pathVarSet\(0,this\.value\)"/);
});

test('kvEditorHTML flags a manual header that conflicts with the Auth tab', () => {
  const sandbox = loadSandbox();
  const req = makeReq({
    auth: { type: 'bearer', token: 'tok' },
    headers: [{ id: '1', key: 'Authorization', value: 'Bearer manual', enabled: true, note: '' }],
  });
  sandbox.setActiveTab(makeTab(req));

  const html = sandbox.kvEditorHTML(req.headers, 'headers');
  assert.match(html, /kv-conflict/);
  assert.match(html, /overridden by the Auth tab/);
});

test('kvEditorHTML does not flag a disabled header that shadows an Auth header', () => {
  const sandbox = loadSandbox();
  const req = makeReq({
    auth: { type: 'bearer', token: 'tok' },
    headers: [{ id: '1', key: 'Authorization', value: 'Bearer manual', enabled: false, note: '' }],
  });
  sandbox.setActiveTab(makeTab(req));

  const html = sandbox.kvEditorHTML(req.headers, 'headers');
  assert.doesNotMatch(html, /kv-conflict/);
});

// ─── Form-data file rows ─────────────────────────────────────────────────────

test('kvEditorHTML renders a type select and file picker for form-data rows', () => {
  const sandbox = loadSandbox();
  const req = makeReq({
    body: { type: 'formdata', raw: '', formData: [
      { id: '1', key: 'name', value: 'salvo', enabled: true, type: 'text' },
      { id: '2', key: 'upload', enabled: true, type: 'file', fileName: 'a.txt', fileSize: 10, fileMimeType: 'text/plain', fileData: 'aGVsbG8=' },
    ] },
  });
  sandbox.setActiveTab(makeTab(req));

  const html = sandbox.kvEditorHTML(req.body.formData, 'formData');
  assert.match(html, /kv-grid-formdata/);
  assert.match(html, /<option value="file" selected>File<\/option>/);
  assert.match(html, /Choose File/);
  assert.match(html, /a\.txt/);
});

test('kvFormDataTypeChange toggles a row between text and file, clearing the other shape', () => {
  const sandbox = loadSandbox();
  const req = makeReq({
    body: { type: 'formdata', raw: '', formData: [{ id: '1', key: 'f', value: 'x', enabled: true, type: 'text' }] },
  });
  sandbox.setActiveTab({ ...makeTab(req), reqTab: 'body' });
  sandbox.document.getElementById = () => makeMockEl();

  sandbox.kvFormDataTypeChange(0, 'file');
  assert.strictEqual(req.body.formData[0].type, 'file');
  assert.strictEqual(req.body.formData[0].value, '');

  sandbox.kvFormDataTypeChange(0, 'text');
  assert.strictEqual(req.body.formData[0].type, 'text');
  assert.strictEqual(req.body.formData[0].fileData, '');
});

test('kvAdd("formData") defaults new rows to type "text"', () => {
  const sandbox = loadSandbox();
  const req = makeReq({ body: { type: 'formdata', raw: '', formData: [] } });
  sandbox.setActiveTab({ ...makeTab(req), reqTab: 'body' });
  sandbox.document.getElementById = () => makeMockEl();

  sandbox.kvAdd('formData');
  assert.strictEqual(req.body.formData.length, 1);
  assert.strictEqual(req.body.formData[0].type, 'text');
});

// ─── Binary body type ────────────────────────────────────────────────────────

test('bodyHTML renders a file picker for the binary body type (Content-Type is not auto-generated)', () => {
  const sandbox = loadSandbox();
  const body = { type: 'binary', raw: '', formData: [], fileName: 'data.bin', fileSize: 1536, binaryMimeType: 'application/octet-stream', fileData: 'AAA=' };
  const req = makeReq({ body });
  sandbox.setActiveTab(makeTab(req));

  const html = sandbox.bodyHTML(body);
  assert.match(html, /Choose File/);
  assert.match(html, /data\.bin/);
  assert.match(html, /1\.5 KB/);
  assert.match(html, /Content-Type:.*application\/octet-stream/);

  assert.deepEqual(sandbox.computedBodyHeaders(req), []);
});

// ─── Mock server path extraction & per-request mock config ──────────────────

test('extractMockPath strips {{var}} prefixes, protocol/host, and query strings', () => {
  const sandbox = loadSandbox();
  assert.strictEqual(sandbox.extractMockPath('{{baseUrl}}/users/:id?x=1'), '/users/:id');
  assert.strictEqual(sandbox.extractMockPath('https://api.example.com/users/:id'), '/users/:id');
  assert.strictEqual(sandbox.extractMockPath('users/:id'), '/users/:id');
  assert.strictEqual(sandbox.extractMockPath(''), '/');
});

test('mockHTML renders the enable toggle, matched route, and mockSet updates req.mock', () => {
  const sandbox = loadSandbox();
  const req = makeReq({ method: 'GET', url: 'https://api.example.com/ping' });
  sandbox.setActiveTab({ ...makeTab(req), reqTab: 'mock' });
  sandbox.document.getElementById = () => makeMockEl();

  let html = sandbox.mockHTML(req);
  assert.match(html, /Enable mock response/);
  assert.match(html, /GET \/ping/);

  sandbox.mockSet('enabled', true);
  assert.strictEqual(req.mock.enabled, true);

  sandbox.mockSet('status', 201);
  assert.strictEqual(req.mock.status, 201);

  sandbox.mockSet('body', '{"ok":true}');
  assert.strictEqual(req.mock.body, '{"ok":true}');

  html = sandbox.mockHTML(req);
  assert.match(html, /value="201"/);
});

// ─── Docs & Comments ──────────────────────────────────────────────────────────

test('docsHTML renders the description textarea and comments, addComment/deleteComment update req.comments', async () => {
  const sandbox = loadSandbox();
  sandbox.localStorage = { getItem: () => '', setItem: () => {} };
  const req = makeReq({ description: 'Fetches the ping endpoint' });
  sandbox.setActiveTab(makeTab(req));

  let html = sandbox.docsHTML(req);
  assert.match(html, /Fetches the ping endpoint/);
  assert.match(html, /No comments yet/);

  sandbox.setActiveTab({ ...makeTab(req), reqTab: 'docs' });
  sandbox.document.getElementById = id => {
    if (id === 'comment-text-input')   return { value: 'Looks good' };
    if (id === 'comment-author-input') return { value: 'Alice' };
    return makeMockEl();
  };
  sandbox.addComment();
  assert.strictEqual(req.comments.length, 1);
  assert.strictEqual(req.comments[0].author, 'Alice');
  assert.strictEqual(req.comments[0].text, 'Looks good');

  html = sandbox.docsHTML(req);
  assert.match(html, /Alice/);
  assert.match(html, /Looks good/);

  await sandbox.deleteComment(req.comments[0].id);
  assert.strictEqual(req.comments.length, 0);
});

// ─── Saved Response Examples ─────────────────────────────────────────────────

test('examplesHTML lists saved examples and deleteExample removes one', async () => {
  const sandbox = loadSandbox();
  const req = makeReq({ examples: [
    { id: 'ex1', name: 'Success', status: 200, statusText: 'OK', headers: {}, body: '{}', bodyType: 'json', createdAt: Date.now() },
  ] });
  sandbox.setActiveTab({ ...makeTab(req), reqTab: 'examples' });
  sandbox.document.getElementById = () => makeMockEl();

  let html = sandbox.examplesHTML(req);
  assert.match(html, /Success/);
  assert.match(html, /200 OK/);

  await sandbox.deleteExample('ex1');
  assert.strictEqual(req.examples.length, 0);

  html = sandbox.examplesHTML(req);
  assert.match(html, /No saved examples yet/);
});

// ─── Tab badges ───────────────────────────────────────────────────────────────

test('updateTabBadges shows badges for docs, examples, and an enabled mock', () => {
  const sandbox = loadSandbox();
  const req = makeReq({
    description: 'has docs',
    examples: [{ id: 'ex1', name: 'Ex', status: 200, headers: {}, body: '', createdAt: Date.now() }],
    mock: { enabled: true, status: 200, headers: [], body: '', delay: 0 },
  });
  sandbox.setActiveTab({ req, reqTab: 'docs' });

  const tabs = ['docs', 'examples', 'mock'].map(name => makeMockEl());
  tabs.forEach((el, i) => { el.dataset = { tab: ['docs', 'examples', 'mock'][i] }; });
  sandbox.document.querySelectorAll = () => tabs;

  sandbox.updateTabBadges();

  assert.match(tabs[0].innerHTML, /tab-badge/);   // docs: has description
  assert.match(tabs[1].innerHTML, /tab-badge">1</); // examples: count
  assert.match(tabs[2].innerHTML, /tab-badge">●/); // mock: enabled
});

// ─── {{variable}} autocomplete ──────────────────────────────────────────────

function makeMockEl() {
  const classes = new Set();
  return {
    textContent: '',
    get className() { return [...classes].join(' '); },
    set className(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach(c => classes.add(c)); },
    classList: {
      add: c => classes.add(c),
      remove: c => classes.delete(c),
      contains: c => classes.has(c),
      toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); },
    },
    addEventListener() {},
    scrollIntoView() {},
  };
}

function makeSuggestBox() {
  const box = {
    style: {},
    _children: [],
    set innerHTML(_v) { box._children = []; },
    appendChild(el) { box._children.push(el); },
    querySelector(sel) {
      if (sel === '.hs-item.active') return box._children.find(c => c.classList.contains('active')) || null;
      return null;
    },
    querySelectorAll(sel) {
      return sel === '.hs-item' ? box._children : [];
    },
    getBoundingClientRect: () => ({ left: 0, top: 0, bottom: 0, width: 100 }),
  };
  return box;
}

function makeMockInput(value, cursorPos) {
  return {
    value,
    selectionStart: cursorPos,
    _events: {},
    focus() {},
    setSelectionRange(s) { this.selectionStart = s; },
    dispatchEvent(ev) { this._dispatched = ev; },
    getBoundingClientRect: () => ({ left: 0, top: 0, bottom: 0, width: 100 }),
  };
}

function loadSandboxWithSuggestBox() {
  const sandbox = loadSandbox();
  const box = makeSuggestBox();
  sandbox.document.getElementById = id => (id === 'var-suggest' ? box : null);
  sandbox.document.createElement = () => makeMockEl();
  sandbox.scrollX = 0;
  sandbox.scrollY = 0;
  sandbox.suggestBox = box;
  return sandbox;
}

test('findVarContext detects an unclosed {{ before the cursor', () => {
  const sandbox = loadSandbox();
  assert.deepEqual(sandbox.findVarContext('{{base', 6), { start: 0, prefix: 'base' });
  assert.strictEqual(sandbox.findVarContext('{{base}}', 8), null);
  assert.strictEqual(sandbox.findVarContext('hello world', 5), null);
  assert.deepEqual(sandbox.findVarContext('{{base}}/{{tok', 14), { start: 9, prefix: 'tok' });
});

test('getEnvVarNames returns enabled var keys from the active environment', () => {
  const sandbox = loadSandbox();
  sandbox.state.envs.push({
    id: 'env1', name: 'Env1', vars: [
      { id: '1', key: 'baseUrl', value: 'https://x', enabled: true },
      { id: '2', key: 'token', value: 'abc', enabled: true },
      { id: '3', key: 'disabled', value: 'x', enabled: false },
    ],
  });
  sandbox.state.activeEnv = 'env1';
  assert.deepEqual(sandbox.getEnvVarNames(), ['baseUrl', 'token']);
});

test('getEnvVarNames includes enabled global variable keys, deduped against env vars', () => {
  const sandbox = loadSandbox();
  sandbox.state.envs.push({
    id: 'env1', name: 'Env1', vars: [
      { id: '1', key: 'baseUrl', value: 'https://x', enabled: true },
    ],
  });
  sandbox.state.activeEnv = 'env1';
  sandbox.state.globals.push(
    { id: 'g1', key: 'baseUrl', value: 'https://global', enabled: true },
    { id: 'g2', key: 'apiKey', value: 'secret', enabled: true },
    { id: 'g3', key: 'disabled', value: 'x', enabled: false },
  );
  assert.deepEqual(sandbox.getEnvVarNames(), ['baseUrl', 'apiKey']);
});

test('showVarSuggest populates the dropdown with matching env var names', () => {
  const sandbox = loadSandboxWithSuggestBox();
  sandbox.state.envs.push({
    id: 'env1', name: 'Env1', vars: [
      { id: '1', key: 'baseUrl', value: 'https://x', enabled: true },
      { id: '2', key: 'token', value: 'abc', enabled: true },
    ],
  });
  sandbox.state.activeEnv = 'env1';

  const input = makeMockInput('{{ba', 4);
  const shown = sandbox.showVarSuggest(input);
  assert.strictEqual(shown, true);
  assert.deepEqual(sandbox.suggestBox._children.map(c => c.textContent), ['baseUrl']);
  assert.notStrictEqual(sandbox.suggestBox.style.display, 'none');
});

test('showVarSuggest hides the dropdown when not in a {{ context', () => {
  const sandbox = loadSandboxWithSuggestBox();
  sandbox.suggestBox.style.display = '';
  const input = makeMockInput('hello', 5);
  const shown = sandbox.showVarSuggest(input);
  assert.strictEqual(shown, false);
  assert.strictEqual(sandbox.suggestBox.style.display, 'none');
});

test('acceptVarSuggest inserts {{name}} and dispatches an input event', () => {
  const sandbox = loadSandboxWithSuggestBox();
  sandbox.state.envs.push({
    id: 'env1', name: 'Env1', vars: [{ id: '1', key: 'baseUrl', value: 'https://x', enabled: true }],
  });
  sandbox.state.activeEnv = 'env1';

  const input = makeMockInput('url: {{ba', 9);
  sandbox.showVarSuggest(input);
  sandbox.acceptVarSuggest('baseUrl');

  assert.strictEqual(input.value, 'url: {{baseUrl}}');
  assert.strictEqual(input.selectionStart, 'url: {{baseUrl}}'.length);
  assert.ok(input._dispatched);
  assert.strictEqual(input._dispatched.type, 'input');
});

test('varSuggestKeydown accepts the active suggestion on Tab', () => {
  const sandbox = loadSandboxWithSuggestBox();
  sandbox.state.envs.push({
    id: 'env1', name: 'Env1', vars: [{ id: '1', key: 'baseUrl', value: 'https://x', enabled: true }],
  });
  sandbox.state.activeEnv = 'env1';

  const input = makeMockInput('{{ba', 4);
  sandbox.showVarSuggest(input);

  let prevented = false;
  const handled = sandbox.varSuggestKeydown(input, { key: 'Tab', preventDefault: () => { prevented = true; } });
  assert.strictEqual(handled, true);
  assert.strictEqual(prevented, true);
  assert.strictEqual(input.value, '{{baseUrl}}');
});

// ─── Global Variables ────────────────────────────────────────────────────────

test('interp falls back to globals when no active-environment var matches', () => {
  const sandbox = loadSandbox();
  sandbox.state.envs.push({
    id: 'env1', name: 'Env1', vars: [{ id: '1', key: 'baseUrl', value: 'https://env', enabled: true }],
  });
  sandbox.state.activeEnv = 'env1';
  sandbox.state.globals.push(
    { id: 'g1', key: 'baseUrl', value: 'https://global', enabled: true },
    { id: 'g2', key: 'apiKey', value: 'secret', enabled: true },
    { id: 'g3', key: 'disabled', value: 'x', enabled: false },
  );

  // Env var wins over a same-named global.
  assert.strictEqual(sandbox.interp('{{baseUrl}}'), 'https://env');
  // Falls back to a global when no env var matches.
  assert.strictEqual(sandbox.interp('{{apiKey}}'), 'secret');
  // A disabled global is not used.
  assert.strictEqual(sandbox.interp('{{disabled}}'), '{{disabled}}');
  // Unknown var left as-is.
  assert.strictEqual(sandbox.interp('{{nope}}'), '{{nope}}');
});

test('interp prefers the Collection Runner\'s current data row over environment/global variables', () => {
  const sandbox = loadSandbox();
  sandbox.state.envs.push({
    id: 'env1', name: 'Env1', vars: [{ id: '1', key: 'userId', value: 'env-user', enabled: true }],
  });
  sandbox.state.activeEnv = 'env1';
  sandbox.state.globals.push({ id: 'g1', key: 'apiKey', value: 'global-key', enabled: true });

  sandbox.state.runner = { currentRow: { userId: '42', name: 'Row Name' } };

  // Row data wins over the active environment.
  assert.strictEqual(sandbox.interp('{{userId}}'), '42');
  // Falls back to globals for keys not present in the row.
  assert.strictEqual(sandbox.interp('{{apiKey}}'), 'global-key');
  // Row-only key resolves too.
  assert.strictEqual(sandbox.interp('{{name}}'), 'Row Name');

  sandbox.state.runner = null;
  assert.strictEqual(sandbox.interp('{{userId}}'), 'env-user');
});

// ─── Bulk Edit ────────────────────────────────────────────────────────────────

test('kvRowsToBulkText renders one "key: value" line per row, prefixing disabled rows with "// "', () => {
  const sandbox = loadSandbox();
  const text = sandbox.kvRowsToBulkText([
    { id: '1', key: 'a', value: '1', enabled: true },
    { id: '2', key: 'b', value: '2', enabled: false },
  ]);
  assert.strictEqual(text, 'a: 1\n// b: 2');
});

test('bulkTextToRows parses "key: value" lines, "// " disables a row, and preserves ids/notes by key', () => {
  const sandbox = loadSandbox();
  const oldRows = [{ id: 'old-a', key: 'a', value: '1', enabled: true, note: 'kept' }];
  const rows = sandbox.bulkTextToRows('a: new-value\n// b: 2\n\nc:3', oldRows);

  assert.deepEqual(rows, [
    { id: 'old-a', key: 'a', value: 'new-value', enabled: true, note: 'kept' },
    { id: rows[1].id, key: 'b', value: '2', enabled: false, note: '' },
    { id: rows[2].id, key: 'c', value: '3', enabled: true, note: '' },
  ]);
});

test('applyBulkEdit replaces the kv target rows in place and re-syncs the URL for params', () => {
  const sandbox = loadSandbox();
  const req = makeReq({ url: 'https://api.example.com', params: [{ id: '1', key: 'old', value: 'x', enabled: true }] });
  sandbox.setActiveTab(makeTab(req));

  sandbox.applyBulkEdit('params', 'q: search\n// debug: 1');

  assert.deepEqual(req.params.map(r => ({ key: r.key, value: r.value, enabled: r.enabled })), [
    { key: 'q', value: 'search', enabled: true },
    { key: 'debug', value: '1', enabled: false },
  ]);
  assert.strictEqual(req.url, 'https://api.example.com?q=search');
});

test('toggleBulkEdit and kvEditorHTML render a textarea in bulk mode', () => {
  const sandbox = loadSandbox();
  const req = makeReq({ headers: [{ id: '1', key: 'X-Test', value: 'abc', enabled: true, note: '' }] });
  sandbox.setActiveTab(makeTab(req));

  let html = sandbox.kvEditorHTML(req.headers, 'headers');
  assert.match(html, /Bulk Edit/);
  assert.doesNotMatch(html, /<textarea/);

  sandbox.state.bulkEdit.add('headers');
  html = sandbox.kvEditorHTML(req.headers, 'headers');
  assert.match(html, /Form Edit/);
  assert.match(html, /<textarea[^>]*>X-Test: abc<\/textarea>/);
});
