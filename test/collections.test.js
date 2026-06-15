'use strict';

// Tests for js/collections.js (parsePostman, mergeImportedData), exercised in
// a vm sandbox since these files are written for the global browser scope
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
    },
    window: {},
    navigator: {},
    fetch: () => Promise.reject(new Error('fetch not available in tests')),
    Blob: function Blob() {},
    URL: { createObjectURL: () => '' },
    setTimeout, clearTimeout,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);

  const stateSrc       = fs.readFileSync(path.join(__dirname, '../js/state.js'), 'utf8');
  const collectionsSrc = fs.readFileSync(path.join(__dirname, '../js/collections.js'), 'utf8');
  vm.runInContext(stateSrc, sandbox, { filename: 'state.js' });
  vm.runInContext(collectionsSrc, sandbox, { filename: 'collections.js' });

  // mergeImportedData calls these — stub them out as no-ops for the test.
  // Also re-expose top-level `const state` as a property of the sandbox object,
  // since `const`/`let` bindings aren't reflected on the context's global object.
  vm.runInContext(`
    function renderSidebar() {}
    function renderEnvSelect() {}
    function scheduleDiskSave() {}
    globalThis.state = state;
  `, sandbox, { filename: 'stubs.js' });

  return sandbox;
}

test('parsePostman converts a Postman v2.1 collection into Salvo shape', () => {
  const sandbox = loadSandbox();

  const postman = {
    info: { name: 'My API', description: 'A demo API', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    item: [
      {
        name: 'List Widgets',
        request: {
          method: 'get',
          header: [{ key: 'Accept', value: 'application/json' }],
          url: { raw: 'https://api.example.com/widgets?limit=10', query: [{ key: 'limit', value: '10' }] },
        },
      },
      {
        name: 'Admin',
        item: [
          {
            name: 'Delete Widget',
            request: {
              method: 'delete',
              url: { raw: 'https://api.example.com/widgets/1' },
            },
          },
        ],
      },
    ],
  };

  const col = sandbox.parsePostman(postman);

  assert.strictEqual(col.name, 'My API');
  assert.strictEqual(col.description, 'A demo API');
  assert.strictEqual(col.requests.length, 1);
  assert.strictEqual(col.requests[0].name, 'List Widgets');
  assert.strictEqual(col.requests[0].method, 'GET');
  assert.strictEqual(col.requests[0].url, 'https://api.example.com/widgets?limit=10');
  assert.deepEqual(col.requests[0].params, [{ id: col.requests[0].params[0].id, key: 'limit', value: '10', enabled: true }]);

  assert.strictEqual(col.folders.length, 1);
  assert.strictEqual(col.folders[0].name, 'Admin');
  assert.strictEqual(col.folders[0].requests.length, 1);
  assert.strictEqual(col.folders[0].requests[0].name, 'Delete Widget');
  assert.strictEqual(col.folders[0].requests[0].method, 'DELETE');

  asset.strictEqual(0, 1);
});

test('mergeImportedData merges into existing collections and creates new ones, skipping duplicate names', () => {
  const sandbox = loadSandbox();

  sandbox.state.cols = [
    {
      id: 'col-1', name: 'Demo', folders: [],
      requests: [
        { id: 'r1', name: 'Existing Request', method: 'GET', url: '/old', params: [], headers: [], body: { type: 'none', raw: '', formData: [] }, auth: { type: 'none' } },
      ],
    },
  ];

  const importPayload = {
    cols: [
      {
        name: 'Demo',
        requests: [
          { name: 'Existing Request', method: 'GET', url: '/dupe' },  // should be skipped
          { name: 'New Request',      method: 'POST', url: '/new' },  // should be added
        ],
        folders: [],
      },
      {
        name: 'Brand New Collection',
        requests: [],
        folders: [
          { name: 'Sub', requests: [{ name: 'Nested Request', method: 'GET', url: '/nested' }] },
        ],
      },
    ],
  };

  sandbox.mergeImportedData(importPayload);

  const demo = sandbox.state.cols.find(c => c.name === 'Demo');
  assert.strictEqual(demo.requests.length, 2);
  assert.strictEqual(demo.requests.find(r => r.name === 'Existing Request').url, '/old', 'duplicate-named request should not overwrite the existing one');
  assert.ok(demo.requests.find(r => r.name === 'New Request'), 'non-duplicate request should be added');

  const brandNew = sandbox.state.cols.find(c => c.name === 'Brand New Collection');
  assert.ok(brandNew, 'a new collection should be created for unseen names');
  assert.strictEqual(brandNew.folders.length, 1);
  assert.strictEqual(brandNew.folders[0].name, 'Sub');
  assert.strictEqual(brandNew.folders[0].requests[0].name, 'Nested Request');
});

test('mergeImportedData carries over collection descriptions for new collections only', () => {
  const sandbox = loadSandbox();

  sandbox.state.cols = [
    { id: 'col-1', name: 'Demo', description: 'Existing description', folders: [], requests: [] },
  ];

  sandbox.mergeImportedData({
    cols: [
      { name: 'Demo', description: 'Imported description', requests: [], folders: [] },
      { name: 'New Collection', description: 'Brand new', requests: [], folders: [] },
    ],
  });

  const demo = sandbox.state.cols.find(c => c.name === 'Demo');
  assert.strictEqual(demo.description, 'Existing description', 'an existing collection\'s description should not be overwritten by import');

  const fresh = sandbox.state.cols.find(c => c.name === 'New Collection');
  assert.strictEqual(fresh.description, 'Brand new');
});

test('normalizeReq defaults description, comments, mock, and examples for older saved requests', () => {
  const sandbox = loadSandbox();

  const normalized = sandbox.normalizeReq({ name: 'Old Request', method: 'get', url: '/old' });
  assert.strictEqual(normalized.description, '');
  assert.deepEqual(normalized.comments, []);
  assert.deepEqual(normalized.mock, { enabled: false, status: 200, headers: [], body: '', delay: 0 });
  assert.deepEqual(normalized.examples, []);

  const withSaved = sandbox.normalizeReq({
    name: 'New Request', method: 'get', url: '/new',
    description: 'desc', comments: [{ id: 'c1', author: 'Bob', text: 'hi', createdAt: 1 }],
    mock: { enabled: true, status: 201 },
    examples: [{ id: 'e1', name: 'Ex' }],
  });
  assert.strictEqual(withSaved.description, 'desc');
  assert.strictEqual(withSaved.comments.length, 1);
  assert.deepEqual(withSaved.mock, { enabled: true, status: 201, headers: [], body: '', delay: 0 });
  assert.strictEqual(withSaved.examples.length, 1);
});

// ─── Drag & drop reordering ────────────────────────────────────────────────────

function dndCols() {
  return [
    {
      id: 'c1', name: 'Col A',
      requests: [{ id: 'r1', name: 'R1' }, { id: 'r2', name: 'R2' }, { id: 'r3', name: 'R3' }],
      folders: [
        { id: 'f1', name: 'Folder 1', requests: [{ id: 'r4', name: 'R4' }, { id: 'r5', name: 'R5' }] },
        { id: 'f2', name: 'Folder 2', requests: [] },
      ],
    },
    { id: 'c2', name: 'Col B', requests: [{ id: 'r6', name: 'R6' }], folders: [] },
  ];
}

test('findReqContainer locates a request\'s list and index across collections/folders', () => {
  const sandbox = loadSandbox();
  sandbox.state.cols = dndCols();

  const r2 = sandbox.findReqContainer('r2');
  assert.strictEqual(r2.list, sandbox.state.cols[0].requests);
  assert.strictEqual(r2.index, 1);

  const r5 = sandbox.findReqContainer('r5');
  assert.strictEqual(r5.list, sandbox.state.cols[0].folders[0].requests);
  assert.strictEqual(r5.index, 1);

  assert.strictEqual(sandbox.findReqContainer('nope'), null);
});

test('moveReqToPosition reorders within the same list', () => {
  const sandbox = loadSandbox();
  sandbox.state.cols = dndCols();
  const col = sandbox.state.cols[0];

  // Drag R3 to before R1
  sandbox.moveReqToPosition('r3', col.requests, 0);
  assert.deepStrictEqual(col.requests.map(r => r.id), ['r3', 'r1', 'r2']);
});

test('moveReqToPosition moves a request into a folder', () => {
  const sandbox = loadSandbox();
  sandbox.state.cols = dndCols();
  const col = sandbox.state.cols[0];

  // Drag top-level R1 into the (empty) Folder 2
  sandbox.moveReqToPosition('r1', col.folders[1].requests, col.folders[1].requests.length);
  assert.deepStrictEqual(col.requests.map(r => r.id), ['r2', 'r3']);
  assert.deepStrictEqual(col.folders[1].requests.map(r => r.id), ['r1']);
});

test('moveReqToPosition moves a request to a different collection', () => {
  const sandbox = loadSandbox();
  sandbox.state.cols = dndCols();
  const [colA, colB] = sandbox.state.cols;

  sandbox.moveReqToPosition('r4', colB.requests, colB.requests.length);
  assert.deepStrictEqual(colA.folders[0].requests.map(r => r.id), ['r5']);
  assert.deepStrictEqual(colB.requests.map(r => r.id), ['r6', 'r4']);
});

test('moveFolderToPosition reorders folders within a collection', () => {
  const sandbox = loadSandbox();
  sandbox.state.cols = dndCols();
  const col = sandbox.state.cols[0];

  // Drag Folder 2 to before Folder 1
  sandbox.moveFolderToPosition('c1', 'f2', 0);
  assert.deepStrictEqual(col.folders.map(f => f.id), ['f2', 'f1']);
});

test('moveColToPosition reorders collections', () => {
  const sandbox = loadSandbox();
  sandbox.state.cols = dndCols();

  // Drag Col B to before Col A
  sandbox.moveColToPosition('c2', 0);
  assert.deepStrictEqual(sandbox.state.cols.map(c => c.id), ['c2', 'c1']);

  // Dropping a collection onto itself is a no-op (handled by callers, but
  // verify the splice math doesn't corrupt the array if it ever happens)
  sandbox.moveColToPosition('c2', 0);
  assert.deepStrictEqual(sandbox.state.cols.map(c => c.id), ['c2', 'c1']);
});
