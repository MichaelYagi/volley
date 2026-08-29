'use strict';

// HTTP-level tests for the Monitors feature (/api/monitors*, runMonitor())
// and the API Documentation page (GET /docs) in server.js. Monitors reuse
// lib/headless-runner.js (shared with cli.js) to run a saved collection
// in-process against this same server instance. Run with `node --test`.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'volley-test-monitors-'));
process.env.VOLLEY_DATA_DIR = DATA_DIR;

const { server, saveData } = require('../server.js');

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

function seedCollection(overrides = {}) {
  saveData({
    cols: [{
      id: 'c1', name: 'Demo API', description: '', folders: [],
      requests: [{
        id: 'r1', name: 'Ping', method: 'GET', url: '', protocol: 'http',
        params: [], headers: [], body: { type: 'none', raw: '', formData: [] },
        auth: { type: 'none' }, examples: [],
        ...overrides,
      }],
    }],
    envs: [], hist: [],
  });
}

// ─── Monitors CRUD + run ──────────────────────────────────────────────────────

test('POST /api/monitors creates a monitor, GET /api/monitors lists it', async () => {
  seedCollection();

  const createRes = await fetch(`${base}/api/monitors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'My Monitor', collection: 'Demo API', intervalMinutes: 10 }),
  });
  assert.strictEqual(createRes.status, 200);
  const created = await createRes.json();
  assert.strictEqual(created.ok, true);
  assert.strictEqual(created.monitor.name, 'My Monitor');
  assert.strictEqual(created.monitor.intervalMinutes, 10);
  assert.strictEqual(created.monitor.enabled, true);

  const listRes = await fetch(`${base}/api/monitors`);
  const { monitors } = await listRes.json();
  const found = monitors.find(m => m.id === created.monitor.id);
  assert.ok(found);
  assert.deepStrictEqual(found.runs, []);

  // cleanup
  await fetch(`${base}/api/monitors/delete`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: created.monitor.id }),
  });
});

test('POST /api/monitors rejects a missing name/collection', async () => {
  const res = await fetch(`${base}/api/monitors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '', collection: '' }),
  });
  assert.strictEqual(res.status, 400);
  const data = await res.json();
  assert.strictEqual(data.ok, false);
});

test('POST /api/monitors/update edits a monitor, POST /api/monitors/delete removes it', async () => {
  seedCollection();
  const created = await (await fetch(`${base}/api/monitors`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Orig', collection: 'Demo API', intervalMinutes: 5 }),
  })).json();

  const updRes = await fetch(`${base}/api/monitors/update`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: created.monitor.id, name: 'Renamed', enabled: false }),
  });
  const updated = await updRes.json();
  assert.strictEqual(updated.monitor.name, 'Renamed');
  assert.strictEqual(updated.monitor.enabled, false);
  assert.strictEqual(updated.monitor.collection, 'Demo API'); // untouched fields survive

  const delRes = await fetch(`${base}/api/monitors/delete`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: created.monitor.id }),
  });
  assert.strictEqual((await delRes.json()).ok, true);

  const { monitors } = await (await fetch(`${base}/api/monitors`)).json();
  assert.ok(!monitors.find(m => m.id === created.monitor.id));
});

test('POST /api/monitors/run actually sends the collection\'s requests and records a passing run', async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}/ping`;

  try {
    seedCollection({ url: upstreamUrl });
    const created = await (await fetch(`${base}/api/monitors`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Live', collection: 'Demo API', intervalMinutes: 60 }),
    })).json();

    const runRes = await fetch(`${base}/api/monitors/run`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: created.monitor.id }),
    });
    assert.strictEqual(runRes.status, 200);
    const { run } = await runRes.json();
    assert.strictEqual(run.ok, true);
    assert.strictEqual(run.total, 1);
    assert.strictEqual(run.passed, 1);
    assert.strictEqual(run.error, null);

    const { monitors } = await (await fetch(`${base}/api/monitors`)).json();
    const found = monitors.find(m => m.id === created.monitor.id);
    assert.strictEqual(found.runs.length, 1);
    assert.strictEqual(found.runs[0].ok, true);
  } finally {
    upstream.close();
  }
});

test('POST /api/monitors/run records a failing run for a 500 response, and errors for an unknown monitor id', async () => {
  const upstream = http.createServer((req, res) => { res.writeHead(500); res.end('nope'); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}/`;

  try {
    seedCollection({ url: upstreamUrl });
    const created = await (await fetch(`${base}/api/monitors`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Failing', collection: 'Demo API', intervalMinutes: 60 }),
    })).json();

    const { run } = await (await fetch(`${base}/api/monitors/run`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: created.monitor.id }),
    })).json();
    assert.strictEqual(run.ok, false);
    assert.strictEqual(run.total, 1);
    assert.strictEqual(run.passed, 0);

    const badRes = await fetch(`${base}/api/monitors/run`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'does-not-exist' }),
    });
    assert.strictEqual(badRes.status, 400);
  } finally {
    upstream.close();
  }
});

// ─── API Documentation (GET /docs) ────────────────────────────────────────────

test('GET /docs renders collections/requests and redacts Authorization/Cookie header values', async () => {
  seedCollection({
    url: 'https://api.example.com/widgets',
    headers: [
      { id: 'h1', key: 'Authorization', value: 'Bearer top-secret', enabled: true },
      { id: 'h2', key: 'X-Client', value: 'volley-test', enabled: true },
    ],
    description: 'Fetches widgets.',
  });

  const res = await fetch(`${base}/docs`);
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);

  const html = await res.text();
  assert.match(html, /Demo API/);
  assert.match(html, /Ping/);
  assert.match(html, /Fetches widgets\./);
  assert.match(html, /api\.example\.com\/widgets/);
  assert.match(html, /volley-test/);       // non-auth header value shown
  assert.doesNotMatch(html, /top-secret/); // Authorization value never appears
  assert.match(html, /&lt;redacted&gt;/);
});

test('GET /docs omits Auth-tab credentials (shows only the auth type)', async () => {
  seedCollection({
    auth: { type: 'bearer', token: 'super-secret-token' },
  });

  const html = await (await fetch(`${base}/docs`)).text();
  assert.match(html, /Bearer Token/);
  assert.doesNotMatch(html, /super-secret-token/);
});
