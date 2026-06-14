'use strict';

// Tests for the pure SSE-parsing helpers in js/send.js, exercised in a vm
// sandbox since these files are written for the global browser scope (no
// modules/exports). Run with `node --test`.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadSandbox() {
  const sandbox = {
    console,
    document: { getElementById: () => null, querySelectorAll: () => [] },
    window: {},
    navigator: {},
    URL,
    setTimeout, clearTimeout,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);

  const stateSrc = fs.readFileSync(path.join(__dirname, '../js/state.js'), 'utf8');
  const sendSrc  = fs.readFileSync(path.join(__dirname, '../js/send.js'), 'utf8');
  vm.runInContext(stateSrc, sandbox, { filename: 'state.js' });
  vm.runInContext(sendSrc, sandbox, { filename: 'send.js' });

  return sandbox;
}

test('parseSseBlock parses event/data/id/retry fields', () => {
  const sandbox = loadSandbox();
  const evt = sandbox.parseSseBlock('event: ping\ndata: hello\nid: 42\nretry: 5000');
  assert.strictEqual(evt.event, 'ping');
  assert.strictEqual(evt.data, 'hello');
  assert.strictEqual(evt.id, '42');
  assert.strictEqual(evt.retry, 5000);
  assert.strictEqual(typeof evt.receivedAt, 'number');
});

test('parseSseBlock defaults event to "message" and joins multi-line data', () => {
  const sandbox = loadSandbox();
  const evt = sandbox.parseSseBlock('data: line one\ndata: line two');
  assert.strictEqual(evt.event, 'message');
  assert.strictEqual(evt.data, 'line one\nline two');
  assert.strictEqual(evt.id, undefined);
});

test('parseSseBlock ignores comment lines and returns null for comment-only blocks', () => {
  const sandbox = loadSandbox();
  const evt = sandbox.parseSseBlock(': this is a comment\ndata: hi');
  assert.strictEqual(evt.data, 'hi');

  assert.strictEqual(sandbox.parseSseBlock(': just a comment'), null);
  assert.strictEqual(sandbox.parseSseBlock(''), null);
});

test('parseSseBlock handles a field with no colon and a value with a leading space stripped', () => {
  const sandbox = loadSandbox();
  // "data:value" (no space) keeps the value as-is; "data: value" strips one leading space.
  const evt = sandbox.parseSseBlock('data:value\ndata: value2');
  assert.strictEqual(evt.data, 'value\nvalue2');
});

test('extractSseEvents splits a buffer into complete events and a remainder', () => {
  const sandbox = loadSandbox();
  const buffer = 'event: foo\ndata: 1\n\ndata: 2\n\ndata: partial';
  const { events, remainder } = sandbox.extractSseEvents(buffer);

  assert.strictEqual(events.length, 2);
  assert.strictEqual(events[0].event, 'foo');
  assert.strictEqual(events[0].data, '1');
  assert.strictEqual(events[1].event, 'message');
  assert.strictEqual(events[1].data, '2');
  assert.strictEqual(remainder, 'data: partial');
});

test('extractSseEvents normalizes \\r\\n line endings', () => {
  const sandbox = loadSandbox();
  const buffer = 'event: foo\r\ndata: bar\r\n\r\ndata: baz\r\n\r\n';
  const { events, remainder } = sandbox.extractSseEvents(buffer);

  assert.strictEqual(events.length, 2);
  assert.strictEqual(events[0].data, 'bar');
  assert.strictEqual(events[1].data, 'baz');
  assert.strictEqual(remainder, '');
});

test('extractSseEvents skips comment-only blocks while preserving the remainder', () => {
  const sandbox = loadSandbox();
  const buffer = ': keep-alive\n\ndata: real\n\n';
  const { events, remainder } = sandbox.extractSseEvents(buffer);

  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].data, 'real');
  assert.strictEqual(remainder, '');
});
