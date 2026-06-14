# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Salvo is a local-first HTTP client — a lightweight Postman alternative. Single-page app, pure HTML/CSS/JS, no framework, no build step, no dependencies. Runs from a local web server.

## Running locally

```bash
node server.js
# then open http://localhost:5874
```

Pick a different port with `--port=<port>` (or `--port <port>`), or the `PORT` env var (`--port` takes precedence):

```bash
node server.js --port=3000
```

`server.js` is a stdlib-only Node HTTP server (no `npm install`, no dependencies). It serves the static files (`index.html`, `js/`, `css/`) and exposes a small JSON API used to load and save data from the `data/` directory:

- `GET /api/data` — reads `data/` and returns `{ cols, envs, hist }`
- `POST /api/save` — accepts `{ cols, envs, hist }` and writes it back to `data/`
- `/api/ws-proxy` (WebSocket upgrade) — relays a browser WebSocket connection to an upstream `ws(s)://` target (see `js/websocket.js`)
- `/api/mcp-stdio` (WebSocket upgrade) — spawns a local child process for `mcp+stdio://` URLs and relays newline-delimited JSON-RPC over its stdin/stdout (see `js/mcp.js`)

A plain static server (e.g. `python3 -m http.server`) won't work — Salvo needs these API endpoints to load and save its data.

## Data storage (`data/`)

`data/` is gitignored — it holds the user's local collections, environments, and history, all as plain JSON files.

- **Collections are directories**: `data/<Collection Name>/`
- **Requests are files**: `data/<Collection Name>/<Request Name>.json`, containing the Request object (see below), minus its `id` (ids are ephemeral and regenerated on load)
- **Folders are NOT directories** — a request that belongs to a Postman-style folder has an extra `"folder": "<Folder Name>"` field in its JSON file. The directory layout is always flat, one level deep.
- **Envs, history, and open tabs**: `data/_salvo/envs.json`, `data/_salvo/history.json`, and `data/_salvo/tabs.json`

On load, `server.js` walks `data/`, groups requests by their `folder` field back into `Collection.folders`, and regenerates `id`s. On save, it wipes and rewrites every collection directory from the current in-memory state — renames/deletions are handled by this wipe-and-rewrite, not by diffing. Filenames are sanitized and de-duplicated (` (2)`, ` (3)`, ...) via `sanitizeName`/`uniqueName` in `server.js`.

## Architecture

All JS files share the **global browser scope** and are loaded as plain `<script>` tags in `index.html`. There are no modules, no imports, no exports. Load order matters — `state.js` must come first. Functions defined in one file are freely callable from any other.

### JS files and their responsibilities

| File | Owns |
|------|------|
| `js/state.js` | Global `state` object, `MC` method colours, `defaultAuth()`, `scheduleAutoSave()`, `syncTabIntoCols()`/`syncAllTabsIntoCols()`, `uid()`, `clone()`, `esc()`, `interp()`, `notify()` |
| `js/tabs.js` | `activeTab()`, `openTab()`, `closeTab()`, `switchTab()`, `renderTabStrip()` |
| `js/sidebar.js` | `renderSidebar()`, collection/folder/request HTML generation, `toggleCol()`, `toggleFolder()`, `showCtxMenu()`, `hideCtxMenu()`, `colCtx()`, `reqCtx()` |
| `js/curl.js` | `buildCurl()`, `curlPanelHTML()`, `copyCurl()` |
| `js/request.js` | `showReqEditor()`, `showEmptyState()`, `syncReqEditor()`, `renderReqPanel()`, `switchReqTab()`, `updateTabBadges()`, `kvEditorHTML()`, `kvToggle/Set/Del/Add()`, `authHTML()`, `authTypeChange/Set()`, `bodyHTML()`, `bodyTypeChange/Set()`, `onMethodChange()`, `onReqNameChange()` |
| `js/response.js` | `renderRespPanel()`, `switchRespTab()`, `copyResponse()`, `buildJsonTree()` |
| `js/send.js` | `sendRequest()`, `cancelReq()`, `buildRequestArgs()`, `parseResponse()`, `ensureOAuthToken()`/`fetchOAuthToken()`/`manualFetchOAuthToken()`, `buildJwt()` |
| `js/websocket.js` | `isWsUrl()`, `connectWs()`, `disconnectWs()`, `sendWsMessage()`, `sendWsComposerMessage()`, `updateSendBtn()` |
| `js/mcp.js` | MCP (Model Context Protocol) client — `isMcpUrl()`, `mcpTransport()`, `connectMcp()`/`disconnectMcp()`, `connectMcpStdio()`, `mcpSend()`/`sendMcpHttp()`, `handleMcpMessage()`, `sendMcpComposerMessage()`, `splitCommandLine()` |
| `js/collections.js` | `findReq()`, `selectReq()`, `addCollection/Folder/Req()`, `deleteCol/Req()`, `dupReq()`, `renameCol()`, `exportCol()`, `importFile()`, `parsePostman()` |
| `js/modals.js` | `openEnvModal()`, `closeEnvModal()`, `renderEnvSelect()`, `renderEnvModal()`, `renderEnvList()`, `renderEnvDetail()` (vars edited via `kvEditorHTML(env.vars, 'envVars')`), `envSelect/Rename/Use/Delete()`, `envQuickSwitch()`, `addEnv()`, `getSelEnv()` |
| `js/app.js` | `init()`, `loadData()`, `saveAll()`, `setupResizer()`, `toggleHistPanel()`, `renderHistPanel()`, `replayHistory()`, `clearHistory()` |

> **Note:** `css/curl.js` is a stray file — it is not loaded by `index.html` and should be ignored. The active curl code is `js/curl.js`.

### CSS files and their responsibilities

| File | Owns |
|------|------|
| `css/base.css` | Reset, `#app`/`#workspace`/`#main` layout, `#topbar`, form controls, buttons (`.btn-primary`, `.btn-danger`), `.tabbar`/`.tab`/`.tab-badge`, `.panel`, `.spinner` |
| `css/sidebar.css` | `#sidebar`, `#resizer`, `.col-header`, `.col-arrow`, `.col-name`, `.col-body`, `.folder-header`, `.req-row`, `.req-method`, `.req-name`, `.ctx-menu`, `.ctx-item` |
| `css/request.css` | `#empty-state`, `#url-bar`, `#req-name-input`, `.kv-grid`, `.kv-grid-notes`, `.kv-note`, `.kv-del`, `.kv-add`, `.body-types`, `#body-raw-area`, `.auth-row` |
| `css/response.css` | `#resp-section`, `#resp-header`, `.resp-label`, `.status-badge`, `#resp-body-wrap`, JSON tree classes (`.jt-*`), SSE event log (`.sse-event-*`), WebSocket transcript (`.ws-*`), MCP composer (`.mcp-*`), `#hist-panel`, `.hist-item` |
| `css/modals.css` | `.modal-bg`, `.modal`, `.modal-footer`, `.env-layout`, `.env-item`, `.env-kv-grid`, `.notif` (toasts) |

## State shape

```js
state = {
  // loaded from data/ via GET /api/data on init, auto-saved back via POST /api/save
  cols:    [],          // array of Collection objects
  envs:    [],          // array of { id, name, vars: [{ id, key, value, enabled }] }
  hist:    [],          // array of { method, url, status, elapsed } — capped at 200

  // runtime only — open tabs are restored from data/_salvo/tabs.json on load
  // (see openTabs/activeIndex below) and re-saved via serializeOpenTabs()/activeOpenTabIndex()
  activeEnv:       'default',
  tabs:            [],   // array of Tab objects (browser-style request tabs), see below
  activeTabId:     null, // id of the focused tab, or null when state.tabs is empty
  expandedCols:    Set,
  expandedFolders: Set,
  showHist:        false,
  envSelId:        'default',
  selectedReqIds:  Set,
  lastSelReqId:    null,
}
```

### Tab shape

```js
{
  id:        String,
  reqId:     String | null,  // null for scratch tabs (e.g. history replay) — never persisted to cols
  req:       Request,        // working copy — auto-saved back to cols after 500ms via syncTabIntoCols()
  resp:      Object | null,
  reqTab:    'params' | 'headers' | 'auth' | 'body' | 'curl',
  respTab:   'body' | 'headers',
  loading:   Boolean,
  abortCtrl: AbortController | null,
}
```

On a fresh load with no saved tabs, the app starts with zero tabs
(`#empty-state` shown). Otherwise `loadData()` restores `state.tabs` from
`data/_salvo/tabs.json` (`{ openTabs: [{col, folder, name, reqTab}],
activeIndex }`, written by `saveData()`/the `beforeunload` handler). Request
`id`s are ephemeral and regenerated on every load, so each open tab is keyed
by a stable `{col, folder, name}` location instead — `findReqLocation(id)`/
`findReqByLocation(loc)` (in `js/collections.js`) translate between a tab's
`reqId` and that location. Each `openTabs` entry that still resolves via
`findReqByLocation()` becomes a tab (a fresh `clone()` of the saved request,
`reqTab` restored, `resp: null`), and `activeIndex` selects which one is
focused. `openTab(reqId)` opens a request in a new tab (defaulting to the
`headers` reqTab) or focuses its existing tab. `activeTab()` returns
`state.tabs.find(t => t.id === state.activeTabId) || null` and is the single
accessor used everywhere in place of the old singular `state.req`/
`state.resp`/etc. fields. Closing the last tab returns to the empty state.
`serializeOpenTabs()` and `activeOpenTabIndex()` (in `js/app.js`) build the
persisted `openTabs`/`activeIndex` payload — `openTab`/`closeTab`/
`switchTab`/`switchReqTab` each call `scheduleDiskSave()` so the open-tab set
and per-tab `reqTab` survive a refresh.

### Collection shape

```js
{
  id: String,
  name: String,
  folders: [{ id, name, requests: [Request] }],
  requests: [Request],
}
```

### Request shape

```js
{
  id: String,
  name: String,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS',
  url: String,                          // may contain {{variables}}
  params:  [{ id, key, value, enabled, note }],
  headers: [{ id, key, value, enabled, note }],
  body: {
    type: 'none' | 'raw' | 'formdata' | 'urlencoded',
    raw: String,
    contentType: 'json' | 'xml' | 'html' | 'text',
    formData: [{ id, key, value, enabled }],
  },
  auth: {
    type: 'none' | 'bearer' | 'basic' | 'apikey' | 'oauth2_cc' | 'oauth2_pwd' | 'digest' | 'jwt',
    token: String,
    username: String, password: String,
    apiKey: String, apiValue: String,
    accessTokenUrl: String, clientId: String, clientSecret: String, scope: String,
    cachedToken: String, cachedExpiry: Number,  // OAuth2 token cache (ms epoch)
    jwtSecret: String, jwtPayload: String,      // JWT Bearer (HS256) — payload is a JSON string
  },
}
```

`defaultAuth()` (in `js/state.js`) is the single source of truth for this
shape — `normalizeReq`, `newRequestTemplate`, `parsePostman`, and
`replayHistory` all build on it (`{ ...defaultAuth(), ...savedAuth }`) so
older saved requests get the new fields with sane defaults.

## Key conventions

**HTML generation** — most dynamic UI is built by returning HTML strings from functions (`kvEditorHTML`, `authHTML`, `bodyHTML`, `curlPanelHTML`, `colHTML`, etc.) and assigning to `el.innerHTML`. Inline `onclick`/`oninput` handlers reference global functions by name. The exception is `buildJsonTree()` which builds DOM nodes directly to avoid XSS risks with arbitrary API response content.

**`esc(s)`** — always use this when interpolating user-controlled strings into HTML. Don't skip it.

**`interp(s)`** — replaces `{{var}}` placeholders with values from the active environment. Call this in `send.js` when building the actual fetch request, not when storing/displaying.

**`scheduleAutoSave()`** — captures `activeTab()` at call time, then debounces (500ms) writing that tab's `req` back into `state.cols` via `syncTabIntoCols()`, then calls `scheduleDiskSave()`. Capturing the tab up front (rather than inside the timeout) means switching tabs during the 500ms window doesn't sync edits into the wrong request. Call it from any function that mutates `activeTab().req`. Scratch tabs (`reqId === null`, e.g. history replay) are never synced.

**`scheduleDiskSave()`** — debounces (800ms) a silent `saveAll(true)` call, which `POST`s `{ cols, envs, hist }` to `/api/save`. Call it after any state-mutating action (collection/folder/request CRUD, env edits, history changes) so changes persist to disk automatically. Errors still surface via a "Save failed" toast; silent saves don't show a "Saved" toast.

**Saving to disk** — `Ctrl+S`/`Cmd+S` (handled in `init()` in `app.js`) still works and calls `saveAll()` (non-silent, shows a "Saved" toast) for an explicit manual save. On `beforeunload`, `init()` also flushes any pending edits via `syncAllTabsIntoCols()` and writes to disk with `navigator.sendBeacon('/api/save', ...)` so closing the tab doesn't lose in-flight changes.

**Tab rendering** — `renderReqPanel()` is the single dispatcher for the request editor panel. Adding a new tab means: adding a button to `#req-tabbar` in `index.html`, adding a case in the `switch` in `renderReqPanel()`, and implementing the HTML-returning function.

**Non-HTTP URL schemes** — `sendRequest()` (`js/send.js`) dispatches on the request URL's scheme before falling back to a normal `fetch`: `ws://`/`wss://` (`isWsUrl()`) go to `connectWs()`, and `mcp+http://`/`mcp+https://`/`mcp+stdio://` (`isMcpUrl()`) go to `connectMcp()`. Both replace the usual send/response flow with a persistent session: a Connect/Disconnect button (`updateSendBtn()` in `js/websocket.js`) and a transcript + composer in the response panel (`renderRespPanel()` in `js/response.js`). For MCP, `mcp+http(s)://` strips the `mcp+` prefix and speaks the Streamable HTTP transport via `/api/proxy-stream`; `mcp+stdio://<command line>` spawns that command line as a local child process via the `/api/mcp-stdio` WebSocket relay and speaks newline-delimited JSON-RPC over its stdin/stdout.

## Things to be aware of

- **No module system** — all functions are global. Name collisions will cause silent bugs. Keep function names specific (e.g. `renderEnvList` not `renderList`).
- **`Set` objects in state** (`expandedCols`, `expandedFolders`) are runtime-only — they don't serialise to JSON, so they're not persisted and are always initialised fresh.
- **Working copy pattern** — each tab's `req` is a `clone()` of the selected request. Edits go there first, then auto-save writes it back to `state.cols`. Always use `clone()` when copying a request object to avoid shared references.
- **Multi-tab editing** — `state.tabs` holds one entry per open request; `activeTab()` is the single accessor for "the currently focused tab" and replaces all former singular `state.req`/`resp`/`reqTab`/`respTab`/`loading`/`abortCtrl`/`activeReqId` fields. `openTab`/`closeTab`/`switchTab`/`renderTabStrip` live in `js/tabs.js`. With zero tabs, `showEmptyState()` is shown instead of `showReqEditor()`.
- **innerHTML vs DOM** — use `innerHTML` for rendering panels and sidebar rows (strings are `esc()`'d). Use DOM methods (`createElement`, `appendChild`) when rendering untrusted content like API response bodies (`buildJsonTree`).
- **Auto-saves to disk** — any state-mutating action triggers a debounced (800ms) write to `data/` via `/api/save`, and `beforeunload` flushes pending changes via `sendBeacon`. Ctrl+S still works for an explicit save with a "Saved" toast.
