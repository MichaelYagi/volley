'use strict';

// Shared headless Collection Runner core. Builds a vm sandbox running
// js/state.js, js/request.js, js/send.js, and js/runner.js — the same
// request-building, sending, and sequencing logic the browser uses — with
// browser-only globals stubbed out or pointed at a given server, then runs
// a collection (or one folder within it) against it.
//
// Used by both cli.js (a one-shot process against its own ephemeral
// server) and server.js's Monitors scheduler (in-process, against the
// already-running server, on an interval).

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

function buildSandbox(baseUrl) {
  const sandbox = {
    console,
    setTimeout, clearTimeout,
    URL, URLSearchParams,
    TextEncoder, TextDecoder,
    btoa: s => Buffer.from(s, 'binary').toString('base64'),
    atob: s => Buffer.from(s, 'base64').toString('binary'),
    crypto: require('crypto').webcrypto,
    Blob: class Blob {},
    navigator: {},
    document: {
      getElementById: () => null,
      querySelectorAll: () => [],
      createElement: () => ({ remove: () => {} }),
    },
    fetch: (urlOrPath, opts) => {
      const url = String(urlOrPath).startsWith('/') ? baseUrl + urlOrPath : urlOrPath;
      return fetch(url, opts);
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);

  for (const file of ['state.js', 'request.js', 'send.js', 'runner.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'js', file), 'utf8');
    vm.runInContext(src, sandbox, { filename: file });
  }

  vm.runInContext(`
    function activeTab() { return null; }
    function scheduleDiskSave() {}
    function renderHistPanel() {}
    function renderRunnerModal() {}
    function notify() {}
    // Headless replacement for the Worker-based JSON pretty-printer.
    function parseJsonOffMainThread(text) {
      try {
        const value = JSON.parse(text);
        return Promise.resolve({ value, pretty: JSON.stringify(value, null, 2) });
      } catch {
        return Promise.resolve(null);
      }
    }
    globalThis.state = state;
  `, sandbox, { filename: 'headless-stubs.js' });

  return sandbox;
}

// Runs `collection` (or just `folder` within it) headlessly against
// `baseUrl`, optionally under `envName` and a `dataFile` (CSV/JSON, for a
// data-driven run). Returns { results, failed } — `failed` mirrors cli.js's
// exit-code logic: true if any request errored/4xx/5xx or any test failed.
// Throws if the collection, folder, or environment isn't found.
async function runCollectionHeadless({ baseUrl, collection, folder, envName, dataFile }) {
  const sandbox = buildSandbox(baseUrl);
  const data = await (await fetch(`${baseUrl}/api/data`)).json();

  sandbox.state.cols = (data.cols || []).map(c => ({
    id: sandbox.uid(), name: c.name, description: c.description || '',
    requests: (c.requests || []).map(sandbox.normalizeReq),
    folders: (c.folders || []).map(f => ({
      id: sandbox.uid(), name: f.name, requests: (f.requests || []).map(sandbox.normalizeReq),
    })),
  }));
  sandbox.state.envs    = data.envs?.length ? data.envs : [{ id: 'default', name: 'No Environment', vars: [] }];
  sandbox.state.globals = data.globals || [];
  sandbox.state.hist    = data.hist || [];

  if (envName) {
    const env = sandbox.state.envs.find(e => e.name === envName || e.id === envName);
    if (!env) throw new Error(`Environment not found: ${envName}`);
    sandbox.state.activeEnv = env.id;
  } else {
    sandbox.state.activeEnv = data.activeEnv || 'default';
  }

  const col = sandbox.state.cols.find(c => c.name === collection);
  if (!col) throw new Error(`Collection not found: ${collection}`);

  let requests;
  if (folder) {
    const f = col.folders.find(f => f.name === folder);
    if (!f) throw new Error(`Folder not found: ${folder}`);
    requests = f.requests;
  } else {
    requests = sandbox.collectRunnerRequests(col);
  }

  if (!requests.length) return { results: [], failed: false };

  let dataRows = null;
  if (dataFile) {
    const text = fs.readFileSync(dataFile, 'utf8');
    dataRows = sandbox.parseRunnerDataFile(text, dataFile);
  }

  const results = await sandbox.runRequestsHeadless(requests, dataRows);

  const failedRequests = results.filter(r => r.error || (r.status != null && r.status >= 400)).length;
  const testFailed     = results.reduce((s, r) => s + (r.tests?.filter(t => !t.passed).length || 0), 0);

  return { results, failed: failedRequests > 0 || testFailed > 0 };
}

module.exports = { buildSandbox, runCollectionHeadless };
