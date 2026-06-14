#!/usr/bin/env node
'use strict';

// Headless Collection Runner — runs every request in a collection (or a
// single folder within one) sequentially, the same way the in-browser
// Collection Runner (js/runner.js) does, but from the command line. Useful
// for CI/CD pipelines.
//
// Usage:
//   node cli.js <collection> [folder] [options]
//
// Options:
//   --env <name>       Use this environment (by name) instead of the active one
//   --data <file>      CSV/JSON data file — the collection runs once per row,
//                       with each row's columns available as {{variables}}
//   --data-dir <dir>   Same as server.js's --data-dir (defaults to ./data)
//
// Exit code is 0 if every request succeeded (no errors, no 4xx/5xx
// responses, and any test scripts passed), 1 otherwise.

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const { server } = require('./server.js');

function parseArgs() {
  const args = process.argv.slice(2);
  const positional = [];
  let envName = null;
  let dataFile = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--env')  { envName  = args[++i]; continue; }
    if (arg === '--data') { dataFile = args[++i]; continue; }
    // Other flags (e.g. --data-dir, --port, handled by server.js's getCliArg) —
    // skip the flag and, if not in --flag=value form, its value too.
    if (arg.startsWith('--')) {
      if (!arg.includes('=')) i++;
      continue;
    }
    positional.push(arg);
  }

  return { collection: positional[0], folder: positional[1], envName, dataFile };
}

// Build a vm context that runs js/state.js, js/send.js, and js/runner.js —
// the same request-building, sending, and sequencing logic the browser uses
// — with browser-only globals stubbed out or pointed at our local server.
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
    const src = fs.readFileSync(path.join(__dirname, 'js', file), 'utf8');
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
  `, sandbox, { filename: 'cli-stubs.js' });

  return sandbox;
}

function printResults(results) {
  let anyTests = false;

  for (const r of results) {
    const prefix = r.iteration ? `[#${r.iteration}] ` : '';
    const status = r.error ? `ERROR ${r.error}` : `${r.status} ${r.statusText || ''}`.trim();
    console.log(`${prefix}${r.method.padEnd(7)} ${r.name.padEnd(30)} ${status.padEnd(24)} ${r.elapsed}ms`);

    if (r.tests?.length) {
      anyTests = true;
      for (const t of r.tests) {
        console.log(`    ${t.passed ? 'PASS' : 'FAIL'}  ${t.name}${t.error ? ` — ${t.error}` : ''}`);
      }
    }
  }

  const total      = results.length;
  const failed     = results.filter(r => r.error || (r.status != null && r.status >= 400)).length;
  const testTotal  = results.reduce((s, r) => s + (r.tests?.length || 0), 0);
  const testFailed = results.reduce((s, r) => s + (r.tests?.filter(t => !t.passed).length || 0), 0);

  console.log('');
  let summary = `${total - failed}/${total} requests succeeded`;
  if (anyTests) summary += `, ${testTotal - testFailed}/${testTotal} tests passed`;
  console.log(summary);

  return failed > 0 || testFailed > 0;
}

async function main() {
  const { collection, folder, envName, dataFile } = parseArgs();
  if (!collection) {
    console.error('Usage: node cli.js <collection> [folder] [--env <name>] [--data <file>]');
    process.exit(1);
  }

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const sandbox = buildSandbox(baseUrl);
    const data = await (await fetch(`${baseUrl}/api/data`)).json();

    sandbox.state.cols = (data.cols || []).map(c => ({
      id: sandbox.uid(), name: c.name, description: c.description || '',
      requests: (c.requests || []).map(sandbox.normalizeReq),
      folders: (c.folders || []).map(f => ({
        id: sandbox.uid(), name: f.name, requests: (f.requests || []).map(sandbox.normalizeReq),
      })),
    }));
    sandbox.state.envs      = data.envs?.length ? data.envs : [{ id: 'default', name: 'No Environment', vars: [] }];
    sandbox.state.globals   = data.globals || [];
    sandbox.state.hist      = data.hist || [];

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

    if (!requests.length) {
      console.log('No requests to run.');
      process.exit(0);
    }

    let dataRows = null;
    if (dataFile) {
      const text = fs.readFileSync(dataFile, 'utf8');
      dataRows = sandbox.parseRunnerDataFile(text, dataFile);
    }

    const results = await sandbox.runRequestsHeadless(requests, dataRows);
    const failed  = printResults(results);
    process.exitCode = failed ? 1 : 0;
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    server.close();
  }
}

main();
