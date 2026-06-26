# Changelog

## v0.1.0-alpha — 2026-06-26

First public release.

### Core request editor

- Method, URL, query params, headers, auth, and body in a single request editor
- URL ↔ Params sync — editing the query string updates the Params table and vice versa
- Path variables — `:name` segments in the URL appear as an editable table; values are substituted on send and in the cURL preview
- Notes on individual params and header rows
- Per-request tab memory — the last open sub-tab (Params / Headers / Auth / Body / cURL) is restored when switching back to a request

### Body types

- Raw (JSON, XML, HTML, plain text)
- Form-data, including file upload rows
- x-www-form-urlencoded
- Raw binary file upload
- GraphQL — sends `{ query, variables }` as JSON; both fields support `{{variable}}` interpolation

### Auth

- Bearer Token
- Basic Auth
- API Key (header or query param)
- OAuth 2.0 Client Credentials
- OAuth 2.0 Password Grant
- OAuth 2.0 Authorization Code (with PKCE; handled via a popup and a local `/api/oauth/callback` redirect)
- Digest Auth — transparently handles the WWW-Authenticate challenge/retry cycle
- JWT Bearer (HS256) — signs a fresh token at send time; `iat`/`exp` added automatically

Fetched OAuth2 tokens are cached on the request and reused until expiry. The resulting `Authorization` header is shown read-only in the Auto-generated headers section.

### Auto-generated headers preview

The Headers tab shows a read-only section previewing the `Authorization`/API key header from the Auth tab, the `Content-Type` the Body tab will add, and any `Cookie` header the cookie jar will attach. A manual header that will be silently overridden by Auth is highlighted with a warning.

### CORS handling

Salvo tries a direct `fetch()` first; if the browser blocks it, the request is automatically retried through the local Node server. SSE and Digest Auth always go through the server.

### Realtime and streaming

- **Server-Sent Events (SSE)** — any response with `Content-Type: text/event-stream` switches the response panel to a live event log showing `event`, `id`, `retry`, `data`, and timestamp per event
- **WebSocket** — `ws://`/`wss://` URLs switch the editor to a Connect/Disconnect flow with a transcript and a message composer; connections are proxied through the local server so browser CORS restrictions don't apply
- **MCP (Model Context Protocol)** — a Protocol dropdown in the URL bar selects the transport:
  - *MCP · Streamable HTTP* — enter a normal `https://` URL; proxied server-side
  - *MCP · stdio* — the URL field becomes a command line; Salvo spawns the process and speaks newline-delimited JSON-RPC over its stdin/stdout

  Either way, `initialize`/`notifications/initialized` are sent automatically. A transcript and composer (with method autocomplete for common MCP methods) appear in the response panel.

### Collections and organisation

- Collections with unlimited folders (one level deep), each with any number of requests
- Right-click context menus on collections, folders, and requests for rename, duplicate, delete, move, export, and more
- Drag-and-drop reordering of requests and folders within a collection, or a request into a folder
- Sidebar search — filter by name or URL as you type
- Multi-select — `Ctrl`/`Cmd`-click or `Shift`-click to select multiple requests, then move or delete them all at once
- Request and collection descriptions (a request's Docs tab, or right-click → Edit Description on a collection)
- Comments — timestamped, named comments on a request from its Docs tab
- Saved response Examples — snapshot a response by name; view one to reload it into the response viewer

### Environment variables

- `{{variable}}` placeholders resolved from the active environment at send time
- Global variables — a fallback layer available regardless of which environment is active
- Environment editor with add/rename/delete and a per-variable enabled toggle
- Quick-switch between environments from the topbar dropdown
- `{{variable}}` autocomplete — type `{{` in any field for a dropdown of matching variable names; navigate with arrow keys, accept with Tab/Enter
- Save response values as variables — hover any leaf in the JSON tree and click `→{{}}` to save the value to the active environment

### Bulk Edit

Any params/headers/form-data/variables table has a Bulk Edit button that switches to a plain-text `name: value` editor (one per line; `// ` prefix to disable a row). Click Form Edit to switch back; rows are matched by name to preserve ids and notes.

### Pre-request and test scripts

A Scripts tab on each request holds a pre-request script (runs before send) and a test script (runs after response). Both have access to a `pm` API:

- `pm.environment.get/set/unset` and `pm.globals.get/set/unset`
- `pm.iterationData.get` for data-driven runs
- `pm.response.status`, `.statusText`, `.headers`, `.responseTime`, `.json()`, `.text()`
- `pm.test(name, fn)` and `pm.expect(value)` with chainable matchers (`.toBe`, `.toEqual`, `.toBeTruthy`, `.toBeFalsy`, `.toBeDefined`, `.toBeNull`, `.toContain`, `.toHaveProperty`, `.toBeGreaterThan`, `.toBeLessThan`, `.not`)

Test results appear in a Tests tab in the response panel with a pass/fail badge.

### Collection Runner

Right-click a collection or folder and choose Run Collection / Run Folder to send every request sequentially. Scripts share the active environment and globals across the run (values set in one request's test script are available to the next request's pre-request script). Live results show method, name, status, timing, and test counts. A Stop button ends the run after the current request finishes.

#### Data-driven runs

Attach a CSV or JSON data file before starting a run to repeat the full run once per row. Row columns are available as `{{variables}}` and via `pm.iterationData.get()`. Each result in the runner modal is tagged with its iteration number.

### CLI Runner

`node cli.js <collection> [folder]` runs a collection headlessly — useful for CI/CD. Options: `--env`, `--data`, `--data-dir`. Exits non-zero on any error, 4xx/5xx, or failed test.

### Mock Server

Any request's Mock tab defines a canned status, headers, body, and delay. The topbar Mock Server button opens a modal listing all enabled mocks; pick a port and click Start. Routes are matched by method and path (`:name` segments match any value). Useful for developing against an API that doesn't exist yet.

### Cookie Jar

`Set-Cookie` responses are stored automatically and replayed on later requests to matching domains. The Cookies topbar button opens a modal to view or delete stored cookies.

### Tabs

Multiple requests open side by side in browser-style tabs. Each tab keeps its own edits, response, and active sub-tab. Open tabs and their active sub-tab are persisted across page reloads.

### cURL

Every request has a live cURL preview that updates as you edit. One-click copy. Click Edit to edit the curl directly and Save to apply it back to the request fields.

### Export / Import

**Export ▾** dropdown offers three formats:

- **Salvo** — `salvo-export.json` with all collections and environments
- **Postman v2.1** — one `.postman_collection.json` per collection
- **cURL commands** — `salvo-export.sh`, a bash-compatible file with every request as a named `curl` command; `{{variable}}` placeholders are preserved and the file can be pasted straight back into Import cURL

Individual collections can also be exported as Salvo JSON or Postman v2.1 via their right-click menu.

**Import ▾** dropdown accepts:

- **From file** — a local Salvo export, Postman v2.x collection, or Postman environment JSON
- **From URL** — Salvo fetches it server-side (no CORS issues) and feeds it through the same pipeline
- **Import cURL** — paste one or many curl commands; a preview shows what will be imported before anything is written

Importing a Salvo export shows a preview modal (new / changed / identical) before applying anything.

### Import cURL

Paste any number of curl commands (from a block, a bash script, or back-to-back with no separator). A `# Name` comment immediately before a curl becomes that request's name (bash-compatible). Requests are named from the URL path or hostname when no comment is present. Duplicate names within the collection are auto-suffixed (` (2)`, ` (3)`, …).

### Git Sync (experimental)

Push and pull collections against a remote git repository (HTTPS, any host). Salvo maintains a local clone as a bridge; `data/` itself is never a git repo. Conflict resolution modal for files changed on both sides. Optional auto-sync on a configurable interval; multi-tab safe via `localStorage` coordination.

### Log Viewer (opt-in)

Enable in Settings to add a Logs button to the topbar. Opens a live-streaming view of server output via SSE, with an in-memory ring buffer (configurable size, default 500 lines) replayed on open. Errors highlighted red, warnings amber.

### Settings

A Settings modal (⚙ in the topbar) with feature flags stored in `localStorage`:

- Show logs / buffer size
- Git sync (experimental)

### Themes

Dark, Light, Nord, Carnival, and Garbagefire — selected from a topbar picker and remembered per device.

### Shared data folder / local-network sync

Pass `--data-dir=<path>` to point Salvo at any folder — a Dropbox folder, a network share, a separate git repo — so multiple machines can work from the same collections and environments.

### About modal

Click the Salvo logo in the topbar to see a short description, a link to the documentation, the MIT license text, and links to GitHub and YouTube. Shows the current release version.

### CI

GitHub Actions workflow runs `node --test` on every push to `main` and every pull request. A separate release workflow runs tests on every version tag push and, if they pass, creates the GitHub release automatically (pre-release when the tag contains a `-`).

### Data storage

Collections, environments, history, globals, open tabs, and cookies are plain JSON files in a gitignored `data/` directory. No account, no cloud, no telemetry.

### Tests

116 tests across seven test files covering the server (unit and HTTP integration), the frontend send/SSE logic, collection CRUD and Postman import, request editor state, the collection runner, and cURL generation. No dependencies — runs with `node --test` on Node 18+.
