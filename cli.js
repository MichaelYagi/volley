#!/usr/bin/env node
'use strict';

// Headless Collection Runner — runs every request in a collection (or a
// single folder within one) sequentially, the same way the in-browser
// Collection Runner (js/runner.js) does, but from the command line. Useful
// for CI/CD pipelines. The actual sandbox/run logic lives in
// lib/headless-runner.js, shared with server.js's Monitors scheduler.
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

const { server } = require('./server.js');
const { runCollectionHeadless } = require('./lib/headless-runner.js');

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
    const { results, failed } = await runCollectionHeadless({ baseUrl, collection, folder, envName, dataFile });
    if (!results.length) {
      console.log('No requests to run.');
      return;
    }
    printResults(results);
    process.exitCode = failed ? 1 : 0;
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    server.close();
  }
}

main();
