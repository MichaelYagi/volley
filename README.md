# Salvo

A fast, free, local-first HTTP client — the core Postman workflow you already know, without the account walls, forced cloud sync, telemetry, or subscription nags.

Salvo is just a small Node server and some plain HTML/JS/CSS. Clone it, run one command, and you have a full-featured API client: collections and folders, environments and globals, OAuth2/JWT/Digest auth, pre-request and test scripts, a collection runner with CSV/JSON data-driven runs, a mock server, a cookie jar, and one-click cURL — all working offline, all stored as plain JSON files you fully own. Import your existing Postman collections and environments and you're up and running in minutes.

No npm install, no Docker, no sign-up, no rate limits, no paywalled "team" features. MIT licensed — use it, fork it, ship it.

## Running it

Salvo needs its local server — it's what reads/writes `data/` and proxies outbound requests.

```bash
node server.js
```

Then open `http://localhost:5874`. No `npm install`, no dependencies — `server.js` only uses Node's standard library.

To use a different port, pass `--port=<port>` (or set the `PORT` env var):

```bash
node server.js --port=3000
```

### Sharing `data/` (local-network sync)

By default Salvo reads/writes `data/` next to `server.js`. Pass `--data-dir=<path>` (or set `SALVO_DATA_DIR`) to point it at a different folder — e.g. a Dropbox/Google Drive folder, a network share, or a separate git repo — so multiple machines or teammates can work from the same collections, environments, and history:

```bash
node server.js --data-dir=/path/to/shared/salvo-data
```

There's no real-time sync or accounts — it's the same wipe-and-rewrite-on-save model described below, just pointed at a folder that something else (Dropbox, a sync tool, git) keeps in sync between machines. Avoid running two instances against the same `data/` at the same time, since the last save wins.

## Table of Contents

- [Features](#features)
- [Project structure](#project-structure)
- [Data storage (`data/`)](#data-storage-data)
  - [Request shape](#request-shape)
- [Environment variables](#environment-variables)
  - [Global variables](#global-variables)
  - [Saving response values as variables](#saving-response-values-as-variables)
- [Bulk Edit](#bulk-edit)
- [Auth types](#auth-types)
- [Pre-request & Test Scripts](#pre-request--test-scripts)
  - [`pm` API](#pm-api)
- [Collection Runner](#collection-runner)
  - [Data-driven runs (CSV/JSON)](#data-driven-runs-csvjson)
- [CLI Runner](#cli-runner)
- [Mock Server](#mock-server)
- [Cookie Jar](#cookie-jar)
- [Tabs](#tabs)
- [Export / Import](#export--import)
- [Tests](#tests)
- [No build step](#no-build-step)
- [License](#license)

## Features

- **Collections** — organise requests into collections and folders. Import Postman v2.x JSON, or Salvo's own export format. Right-click a request to rename, duplicate, copy its URL, move it, or delete it; right-click a collection or folder to add requests/folders, run them, edit a description, rename, export, or delete.
- **Sidebar search & multi-select** — filter the sidebar by request name or URL as you type. `Ctrl`/`Cmd`-click or `Shift`-click to select multiple requests, then move or delete them all at once.
- **Drag-and-drop organization** — reorder requests and folders within a collection, move a request into a folder, or reorder collections and folders themselves by dragging their rows.
- **Multi-tab editing** — open several requests at once in browser-style tabs above the editor; each tab keeps its own edits, response, and active sub-tab.
- **Full request editing** — method, URL, query params, headers, auth, and body (raw JSON/XML/text, form-data with file uploads, x-www-form-urlencoded, raw binary, GraphQL)
- **URL ↔ Params sync** — editing the URL's query string updates the Params table and vice versa, like Postman.
- **Path variables** — `:name` segments in the URL (e.g. `/users/:id`) show up as an editable "Path Variables" table on the Params tab; the names come from the URL, you fill in the values, and they're substituted in when the request is sent (and in the cURL preview).
- **Auto-generated headers preview** — the Headers tab shows a read-only "Auto-generated" section previewing the `Authorization`/API key header from the Auth tab, the `Content-Type` the Body tab will add, and any `Cookie` header the cookie jar will attach for this request's domain. A manual header that will be silently overridden by the Auth tab (e.g. a hand-typed `Authorization`) is highlighted with a warning.
- **Auth** — Bearer Token, Basic Auth, API Key, OAuth 2.0 (Client Credentials & Password Grant), Digest Auth, and JWT Bearer (HS256)
- **Environment variables** — `{{variable}}` placeholders are resolved from the active environment when sending. Switch environments from the topbar dropdown, or manage them via "Manage Env".
- **Global variables** — a "Globals" section in "Manage Env" holds variables that are available no matter which environment is active. `{{variable}}` placeholders fall back to a global when the active environment doesn't define that variable, and `pm.globals.get/set/unset` works the same way as `pm.environment.*` in scripts.
- **`{{variable}}` autocomplete** — type `{{` in the URL bar, any params/headers/form-data row, the raw body editor, or an auth field, and a dropdown suggests matching variable names from the active environment and globals. Filter by typing, navigate with the arrow keys, and accept with `Tab`/`Enter` (or click) to insert `{{varName}}`.
- **Save response values as variables** — hover any value in the response's JSON tree and click `→{{}}` to save it straight into the active environment.
- **Bulk edit** — click "Bulk Edit" above any params/headers/form-data/variables table to switch to a plain-text `name: value` editor (one per line, `// ` prefix to disable a row). Click "Form Edit" to switch back; edits are parsed back into rows, preserving each row's id/notes where the name matches.
- **Pre-request & test scripts** — run JavaScript before a request is sent or after its response arrives, via a small `pm`-style API. Extract values into environment/global variables, assert on the response with `pm.test`/`pm.expect`, and see pass/fail results in a "Tests" tab.
- **Collection Runner** — right-click a collection ("Run Collection") or a folder ("Run Folder") to send every request in it sequentially. Each request's pre-request/test scripts run as usual (sharing environment/global variables across the run, so values extracted by one request are available to the next), and results — status, timing, and test pass/fail counts — are shown live in a runner modal. Optionally attach a CSV or JSON data file before starting a run to repeat the whole run once per row, with each row's columns available as `{{variables}}` and via `pm.iterationData.get(key)`. Stop a run early with the "Stop" button.
- **CLI runner** — run a collection or folder from the command line with `node cli.js <collection> [folder]`, exiting non-zero on any error/4xx/5xx response or failed test — handy for CI/CD pipelines. See [CLI Runner](#cli-runner).
- **Request & collection descriptions** — give any request or collection a free-text description (a request's "Docs" tab, or a collection's right-click "Edit Description") to document what it does for anyone else working in the same `data/` folder.
- **Comments** — leave timestamped, named comments on a request from its "Docs" tab — handy for leaving notes for teammates sharing the same `data/` folder.
- **Saved response Examples** — after sending a request, click "Save as Example" above the response body to snapshot its status/headers/body under a name. Saved examples live on the request's "Examples" tab — view one to load it back into the response viewer, or delete it.
- **Mock servers** — enable "Mock" on a request (its "Mock" tab) to define a canned status/headers/body/delay, then start the local mock server (topbar → "Mock Server") to serve every enabled mock on a chosen port. Routes are matched by method and path, with `:name` path segments matching anything (mirroring a request's `{{baseUrl}}/users/:id`-style URL).
- **Cookie jar** — `Set-Cookie` responses are stored automatically and replayed on later requests to matching domains. View or clear stored cookies from the "Cookies" topbar button.
- **Response viewer** — status, timing, size, collapsible JSON tree, raw body, response headers. Large JSON responses (>1MB) fall back to raw text to avoid freezing the tab.
- **cURL tab** — live curl equivalent for every request, updates as you type, one-click copy
- **Notes on params/headers** — annotate individual rows ("Dev key", "pagination cursor", etc.)
- **Request history** — every sent request logged with method, status, and timing; click to replay
- **Per-request tab memory** — remembers which tab (Params/Headers/Auth/Body/cURL) you last had open for each request
- **CORS-free sending** — requests are proxied through the local server, so the browser never makes the cross-origin call directly
- **Color themes** — pick Dark, Light, Nord, or Carnival from the topbar theme picker; your choice is remembered per device.
- **Responsive layout** — on narrow/tablet/phone widths, the sidebar collapses behind a `☰` toggle and slides over the request panel.
- **Export / Import** — export all collections to a single JSON file (or a single collection, as Salvo or Postman v2.1.0 JSON, via its right-click menu), share it with a team, and import it elsewhere. Imports accept a Salvo export, a Postman collection, or a Postman environment, and merge with existing collections/environments by name, skipping requests with duplicate names.
- **Auto-save** — every change is saved to disk automatically (debounced), with a save-status indicator in the topbar. `Ctrl+S`/`Cmd+S` still works for an explicit save.
- **About** — click the Salvo logo/title in the topbar for an About modal with a short description and the MIT license text.

## Project structure

```
salvo/
├── server.js               — stdlib-only Node server: static files + /api/data, /api/save, /api/proxy
├── cli.js                   — headless Collection Runner (CI/CD), see [CLI Runner](#cli-runner)
├── data/                    — gitignored; your collections, environments, history, and globals (plain JSON)
├── index.html               — markup only, no inline JS or CSS
├── css/
│   ├── base.css            — reset, layout shell, form controls, buttons, tabs, spinner
│   ├── themes.css          — Dark/Light/Nord/Carnival theme variable sets
│   ├── sidebar.css         — sidebar, resizer, collection/folder/request rows, context menu
│   ├── request.css         — URL bar, KV editor, auth editor, body editor, bulk edit
│   ├── response.css        — response panel, status badge, JSON tree, history panel
│   └── modals.css          — modal backdrop, environment modal, runner modal, toast notifications
└── js/
    ├── state.js            — global state, auto-save scheduling, shared utilities
    ├── theme.js            — color theme picker
    ├── tabs.js             — open-request tab strip
    ├── sidebar.js          — sidebar rendering, search, context menus
    ├── curl.js             — curl command generation
    ├── request.js          — request editor: tabs, KV/auth/body editors, bulk edit
    ├── response.js         — response panel rendering, DOM-based JSON tree
    ├── send.js             — request execution (via /api/proxy), response parsing
    ├── collections.js      — collection/folder/request CRUD, Postman & Salvo import/export
    ├── modals.js           — environment & global variables modal
    ├── runner.js           — Collection Runner (run a collection/folder, CSV/JSON data files, results modal)
    ├── mock.js             — Mock Server modal (build routes from requests with mocking enabled, start/stop)
    └── app.js              — init, sidebar resizer, history panel, save/load
```

All JS files share the global scope and load in order. `state.js` must be first — everything else depends on it. `app.js` is last and calls `init()` to boot.

## Data storage (`data/`)

`data/` is gitignored — it holds your local collections, environments, and history as plain JSON files.

- **Collections are directories**: `data/<Collection Name>/`
- **Requests are files**: `data/<Collection Name>/<Request Name>.json`
- **Folders are not directories** — a request inside a Postman-style folder just has an extra `"folder": "<Folder Name>"` field; the layout on disk is always flat, one level deep.
- **Environments, globals, history, open tabs, and cookies**: `data/_salvo/envs.json`, `data/_salvo/globals.json`, `data/_salvo/history.json`, `data/_salvo/tabs.json`, and `data/_salvo/cookies.json`

### Request shape

```json
{
  "name": "Get user",
  "method": "GET",
  "url": "https://api.example.com/users/:userId",
  "description": "Fetches a single user by id.",
  "params":  [{ "id": "x", "key": "include", "value": "profile", "enabled": true, "note": "" }],
  "pathVars": [{ "id": "z", "key": "userId", "value": "123" }],
  "headers": [{ "id": "y", "key": "Authorization", "value": "Bearer {{token}}", "enabled": true, "note": "Dev key" }],
  "body": {
    "type": "raw",
    "raw": "{\"key\": \"value\"}",
    "contentType": "json",
    "formData": [],
    "graphql": { "query": "", "variables": "" }
  },
  "auth": {
    "type": "bearer",
    "token": "{{token}}",
    "username": "", "password": "", "apiKey": "", "apiValue": "",
    "accessTokenUrl": "", "clientId": "", "clientSecret": "", "scope": "",
    "cachedToken": "", "cachedExpiry": 0,
    "jwtSecret": "", "jwtPayload": "{\"sub\":\"user123\"}"
  },
  "preRequestScript": "pm.environment.set('timestamp', Date.now());",
  "testScript": "pm.test('status is 200', () => pm.expect(pm.response.status).toBe(200));",
  "comments": [{ "id": "c1", "author": "Alice", "text": "Returns 404 for soft-deleted users.", "createdAt": 1718000000000 }],
  "mock": { "enabled": false, "status": 200, "headers": [], "body": "{\"id\":123,\"name\":\"Ada\"}", "delay": 0 },
  "examples": [{ "id": "e1", "name": "200 OK", "status": 200, "statusText": "OK", "headers": {}, "body": "{\"id\":123}", "bodyType": "json", "createdAt": 1718000000000 }]
}
```

Collections also carry a `"description"` field, set via right-click → "Edit Description" on a collection.

A form-data body's `formData` rows can be files instead of plain text values, and a `"binary"` body type sends a raw file as the request body:

```json
{
  "body": {
    "type": "formdata",
    "formData": [
      { "id": "a", "key": "name",   "value": "salvo",  "enabled": true, "type": "text" },
      { "id": "b", "key": "upload", "enabled": true,   "type": "file", "fileName": "photo.png", "fileSize": 12345, "fileMimeType": "image/png", "fileData": "<base64>" }
    ]
  }
}
```

```json
{
  "body": {
    "type": "binary",
    "fileName": "report.pdf", "fileSize": 98765, "binaryMimeType": "application/pdf", "fileData": "<base64>"
  }
}
```

File contents (`fileData`) are stored as base64 in the request's saved JSON, sent to the server as part of `/api/proxy`'s body, and reassembled into a multipart `Blob`/raw `Buffer` server-side.

A `"graphql"` body type sends a `POST` (or whatever method the request uses) with a JSON body of `{ "query": ..., "variables": ... }`, and adds a `Content-Type: application/json` header automatically (unless you've set your own or disabled it):

```json
{
  "body": {
    "type": "graphql",
    "graphql": {
      "query": "query GetUser($id: ID!) { user(id: $id) { id name } }",
      "variables": "{\"id\": \"{{userId}}\"}"
    }
  }
}
```

Both `query` and `variables` support `{{variable}}` interpolation; `variables` is parsed as JSON when the request is sent.

## Environment variables

Use `{{variable}}` placeholders anywhere in a request's URL, params, headers, or body — they're resolved against the **active environment** when the request is sent.

1. Click **Manage Env** in the topbar to open the environment editor.
2. Add a variable, e.g. `baseUrl` = `https://api.example.com` and `token` = `your-dev-token`.
3. Pick that environment from the dropdown next to **Manage Env**.
4. In a request, set the URL to `{{baseUrl}}/users/{{userId}}` and add a header `Authorization: Bearer {{token}}`.

`{{userId}}` would come from another environment variable, or you can leave params un-interpolated for ones you fill in per-request. Switching environments from the topbar dropdown instantly changes what every `{{...}}` placeholder resolves to — handy for flipping between dev/staging/prod without editing requests.

### Global variables

The **Globals** entry in **Manage Env** (above your list of environments) holds variables that aren't tied to any one environment. When a `{{variable}}` placeholder isn't found in the active environment, Salvo falls back to a matching global variable before leaving it un-interpolated. Use globals for values that are the same everywhere (an API key, a shared account id) so you don't have to duplicate them into every environment.

### Saving response values as variables

After sending a request, expand the JSON tree in the response viewer and hover over any leaf value (string, number, boolean, null). A `→{{}}` button appears — click it to save that value into the active environment under a variable name you choose. The same thing can be done from a test script with `pm.environment.set(...)` (see below).

## Bulk Edit

Every params/headers/form-data/variables table has a **Bulk Edit** button above it. Click it to switch to a plain-text editor with one `name: value` pair per line — handy for pasting in a block of headers or query params at once. Prefix a line with `// ` to add it as a disabled row. Click **Form Edit** to switch back to the table view; rows are matched back to their previous id/notes by name where possible.

## Auth types

Configure auth on the **Auth** tab of a request. Salvo supports:

- **Bearer Token** — sets `Authorization: Bearer <token>`. Token field supports `{{variables}}`.
- **Basic Auth** — sets `Authorization: Basic <base64(username:password)>`.
- **API Key** — adds a custom header (or query param) with a key/value you choose.
- **OAuth 2.0 — Client Credentials** — set **Access Token URL**, **Client ID**, **Client Secret**, and optionally **Scope**. Click **Get Access Token** to fetch and cache a token, or just hit Send — Salvo fetches one automatically if none is cached (or the cached one has expired).
- **OAuth 2.0 — Password Grant** — same as above, plus **Username**/**Password**, sent with `grant_type=password`.
- **Digest Auth** — set **Username**/**Password**. Salvo sends the request, and if the server responds with a `WWW-Authenticate: Digest` challenge, transparently retries with the computed digest response — no manual nonce handling needed.
- **JWT Bearer (HS256)** — set a **Secret** and a JSON **payload** (e.g. `{"sub":"user123"}`). Salvo signs a fresh HS256 JWT at send time, adding `iat`/`exp` (1 hour) automatically if you don't specify them, and sends it as `Authorization: Bearer <jwt>`.

For OAuth2, the fetched token is cached on the request (`cachedToken`/`cachedExpiry`) and reused until it expires.

## Pre-request & Test Scripts

Each request has a **Scripts** tab with two editors: a **pre-request script**, run just before the request is sent, and a **test script**, run after the response arrives. Both are plain JavaScript with access to a small `pm` object, similar to Postman's sandbox.

### `pm` API

- `pm.environment.get(key)` — read a variable from the active environment
- `pm.environment.set(key, value)` — create or update a variable in the active environment
- `pm.environment.unset(key)` — remove a variable
- `pm.globals.get(key)` / `pm.globals.set(key, value)` / `pm.globals.unset(key)` — same, but for [global variables](#global-variables)
- `pm.response.status` / `pm.response.statusText` — response status (test scripts only)
- `pm.response.headers` — response headers object (test scripts only)
- `pm.response.responseTime` — elapsed time in ms (test scripts only)
- `pm.response.json()` — parse the response body as JSON (test scripts only)
- `pm.response.text()` — raw response body as a string (test scripts only)
- `pm.test(name, fn)` — register a named test; `fn` throwing marks it failed
- `pm.expect(value)` — chainable matchers: `.toBe()`, `.toEqual()`, `.toBeTruthy()`, `.toBeFalsy()`, `.toBeDefined()`, `.toBeNull()`, `.toContain()`, `.toHaveProperty()`, `.toBeGreaterThan()`, `.toBeLessThan()`, plus `.not` to negate any of them

### Example: pre-request script

Set a fresh timestamp on every send:

```js
pm.environment.set('timestamp', Date.now());
```

### Example: test script

Assert on the response and pull a value into an environment variable for later requests:

```js
pm.test('status is 200', () => {
  pm.expect(pm.response.status).toBe(200);
});

pm.test('response is not an error', () => {
  pm.expect(pm.response.json()).not.toHaveProperty('error');
});

pm.environment.set('userId', pm.response.json().id);
```

Test results show up in a **Tests** tab in the response panel, with a pass/fail count badge. Scripts that throw outside of `pm.test()` (a syntax error, etc.) show up as a single failed test.

## Collection Runner

Right-click a collection and choose **Run Collection** (or right-click a folder and choose **Run Folder**) to send every request in it, one after another. Each request runs the same way it would from its tab — pre-request script, send, test script — except nothing happens in the UI; instead a runner modal shows live results: method, name, status (or error), response time, and a `passed/total tests` badge for any test scripts.

Pre-request and test scripts share the same active environment and globals across the whole run, so a value extracted by `pm.environment.set(...)` (or `pm.globals.set(...)`) in one request's test script is available to later requests' pre-request scripts — useful for chains like "log in, then use the returned token for the rest of the requests in the collection". Click **Stop** to end the run after the current request finishes.

### Data-driven runs (CSV/JSON)

Before clicking **Start Run**, optionally choose a `.csv` or `.json` data file:

- **CSV** — the first row is treated as headers; every other row becomes a data row, one column per header.
- **JSON** — must be an array of objects; each object becomes a data row.

When a data file is attached, the whole run repeats once per row. While a row is active, its columns take priority over environment/global variables for `{{variable}}` interpolation, and are also readable from scripts via `pm.iterationData.get('columnName')`. Each result in the runner modal is tagged with its iteration number when running with data.

## CLI Runner

`cli.js` runs the same Collection Runner logic from the command line, without a browser — useful for CI/CD pipelines.

```bash
node cli.js <collection> [folder] [options]
```

- `<collection>` — name of the collection to run (required)
- `[folder]` — name of a folder within that collection to run instead of the whole collection (optional)

Options:

- `--env <name>` — use this environment (by name) instead of the active one
- `--data <file>` — a CSV/JSON data file for a [data-driven run](#data-driven-runs-csvjson)
- `--data-dir <dir>` — same as `server.js`'s `--data-dir`, defaults to `./data`

```bash
node cli.js "My API" --env Staging --data rows.csv
```

For each request, prints its method, name, status (or error), and elapsed time, plus `PASS`/`FAIL` lines for any test scripts, followed by a summary line. The process exits with code `1` if any request errored or returned a 4xx/5xx response, or if any test failed — `0` otherwise.

## Mock Server

Any request can act as a mock: open its **Mock** tab, check **Enable mock response for this request**, and set a status code, headers, delay (ms), and a response body. The tab shows the method + path (derived from the request's URL — `{{var}}` prefixes, host, and query string are stripped, e.g. `{{baseUrl}}/users/:id?x=1` → `/users/:id`) that the mock server will answer for.

Click **Mock Server** in the topbar to open the mock modal, which lists every request with mocking enabled across all collections. Pick a port (default `5875`) and click **Start** to launch a local HTTP server that answers each enabled mock at its method + path — `:name` path segments match any value, so `/users/:id` matches `/users/42`. Headers and body support `{{variable}}` interpolation against the active environment/globals. Click **Stop** to shut it down. Useful for developing a frontend against an API that doesn't exist yet, or for demoing without a live backend.

The route list is a snapshot taken when you click **Start** — if you enable/edit a mock while the server is already running, click **Stop** then **Start** again to pick it up.

Matching is **method + path only** — incoming request headers, query strings, auth, and body are not checked, so any request to a matching method/path gets the same mocked response. The headers configured on the Mock tab are *response* headers (sent back with the reply, e.g. a custom `Content-Type`), not a requirement on the incoming request.

## Cookie Jar

Salvo keeps a server-side cookie jar at `data/_salvo/cookies.json`. Whenever a response includes `Set-Cookie` headers, the cookies are parsed and stored automatically; on later requests, any stored cookie whose domain, path, expiry, and `Secure` flag match the request URL is sent back in the `Cookie` header — no manual copying of session cookies between requests.

Click **Cookies** in the topbar to open the cookie jar modal, where you can see every stored cookie's name, value, domain/path, and expiry, delete individual cookies, or clear the jar entirely.

Any cookie that would be attached to the current request also shows up as a read-only `Cookie` row in the Headers tab's "Auto-generated" section, so you can see exactly what will be sent.

## Tabs

Opening a request from the sidebar opens it in a new tab (or focuses its existing tab if already open). Each tab keeps its own unsaved edits, response, and active sub-tab (Params/Headers/Auth/Body/cURL), so you can work on multiple requests side by side. Close a tab with its `×` button; closing the last tab returns to the "Select or create a request" empty state.

## Export / Import

The **Export** button (topbar) downloads a `salvo-export.json` containing all collections, folders, requests, and environments (history is left out — it's local clutter, not something worth sharing).

A single collection can also be exported on its own via its right-click menu, as either a Salvo JSON file (**Export JSON**) or a Postman v2.1.0 collection (**Export as Postman**) — handy for sharing one collection with someone still on Postman.

The **Import** button accepts any of:
- A Salvo export (`{ "cols": [...], "envs": [...] }`) — collections/folders are merged into your existing ones by name (skipping any request whose name already exists), and environments are merged by name, var-by-var (existing vars are left untouched)
- A Postman v2.x collection — added as a new collection; any collection-level Postman variables are imported as an environment named after the collection
- A Postman environment export — merged into a matching (or newly created) environment by name

## Tests

```bash
node --test
```

Runs the test suite with Node's built-in test runner — no dependencies needed (Node 18+). Covers:

- `test/server.test.js` — `sanitizeName`/`uniqueName`, `buildColsFromFiles`, the `saveData`/`loadData` round trip (including `globals.json`) against a temporary data directory (the real `data/` is never touched), `getCliArg` (`--data-dir`/`--port` parsing), and `findMockMatch`/`startMockServer`/`stopMockServer`/`mockStatus`
- `test/server-http.test.js` — `/api/data`, `/api/save`, `/api/proxy` (raw, formdata including file uploads, urlencoded, binary bodies, and unreachable upstreams), `/api/mock/start`/`/api/mock/status`/`/api/mock/stop`, and static file serving, against a real server instance
- `test/collections.test.js` — `parsePostman` and `mergeImportedData` (including collection descriptions) and `normalizeReq`'s defaults for description/comments/mock/examples, run in a sandboxed copy of the global-scope frontend JS
- `test/request.test.js` — path variables, computed-headers preview, the KV editor (including bulk edit and form-data file rows), the binary body type, `{{variable}}` autocomplete (including global variable fallback and Collection Runner row data), `extractMockPath`, and the Docs/Examples/Mock tabs and badges, run in a sandboxed copy of the global-scope frontend JS
- `test/runner.test.js` — Collection Runner CSV/JSON data file parsing (`parseCsv`, `parseCsvLine`, `parseRunnerDataFile`), run in a sandboxed copy of the global-scope frontend JS
- `test/curl.test.js` — `buildCurl`'s method/URL/header rendering, and `curlPanelHTML`'s mock-server section (hidden when mocking is disabled or the mock server isn't running, rendered with a working mock-server curl command when it is), run in a sandboxed copy of the global-scope frontend JS

Run `node --test --experimental-test-coverage` for a coverage report (covers `server.js`; the sandboxed frontend tests aren't included in coverage instrumentation).

## No build step

Pure HTML, CSS, and JavaScript on the front end, plus a single stdlib-only Node server. No framework, no bundler, no package manager. Edit any file and refresh.

## License

[MIT](LICENSE) — © 2026 Michael Yagi.
