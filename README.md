# Volley

[![Tests](https://github.com/MichaelYagi/volley/actions/workflows/test.yml/badge.svg)](https://github.com/MichaelYagi/volley/actions/workflows/test.yml)
[![npm](https://img.shields.io/npm/v/%40michaelyagi%2Fvolley.svg)](https://www.npmjs.com/package/@michaelyagi/volley)

> **AI-authored.** 100% of the code was written by Claude (Anthropic); I shaped the architecture, scope, and every decision, and did all the testing.

![Volley screenshot](img/screenshot.png)

A fast, free, local-first HTTP client — the core Postman workflow you already know, without the account walls, forced cloud sync, telemetry, or subscription nags.

Volley is just a small Node server and some plain HTML/JS/CSS. Clone it, run one command, and you have a full-featured API client: collections and folders, environments and globals, OAuth2/JWT/Digest auth, pre-request and test scripts, a collection runner with CSV/JSON data-driven runs, scheduled Monitors, a mock server, a cookie jar, and one-click cURL — all working offline, all stored as plain JSON files you fully own. Import your existing Postman collections and environments and you're up and running in minutes.

No npm install, no Docker, no sign-up, no rate limits, no paywalled "team" features. MIT licensed — use it, fork it, ship it.

## Running it

```bash
node server.js
```

Then open `http://localhost:5874`. No dependencies — `server.js` only uses Node's standard library. Prefer not to clone the repo?

```bash
npx @michaelyagi/volley
```

See [Getting Started](docs/guides/getting-started.html) for ports, `--data-dir` (sharing `data/` across machines), and project layout.

## Features

- **Collections & organization** — folders, drag-and-drop, sidebar search & multi-select, descriptions, comments, saved response examples.
- **Full request editing** — method/URL/params/headers/auth/body (raw JSON/XML/text, form-data with file uploads, urlencoded, raw binary, GraphQL), path variables, bulk edit, live cURL preview.
- **Auth** — Bearer, Basic, API Key, OAuth 2.0 (Client Credentials, Password, Authorization Code), Digest, JWT Bearer (HS256).
- **Environment & global variables** — `{{variable}}` interpolation with autocomplete, and saving response values straight into an environment.
- **Pre-request & test scripts** — a small Postman-compatible `pm` API, with pass/fail results per request.
- **Collection Runner & CLI** — run a whole collection or folder, in the UI or headlessly (`node cli.js`) for CI/CD, with optional CSV/JSON data-driven runs.
- **Monitors** — schedule a collection/folder to run on an interval with pass/fail history, no external cron.
- **Realtime protocols** — Server-Sent Events, WebSocket, and MCP (Model Context Protocol, both Streamable HTTP and stdio).
- **Mock Server** — serve canned responses for requests you mark as mocks.
- **Cookie Jar** — automatic `Set-Cookie` capture and replay.
- **Webhooks** — a local listener for inspecting what one service sends another.
- **API Documentation** — an auto-generated, credential-redacted docs page for your own collections at `/docs`.
- **Multi-tab editing & Changes Panel** — work on several requests at once; see a field-by-field diff of everything you've edited this session.
- **Export / Import** — Volley JSON, Postman v2.1, and cURL, in both directions.
- **Git Sync** *(experimental)* — push/pull collections against a remote git repo.
- **Auto-save, request history, color themes, responsive layout** — and it all just works offline.

Full details on every feature: **[michaelyagi.github.io/volley](https://michaelyagi.github.io/volley)** or [`docs/index.html`](docs/index.html) (same content, as local static HTML — open directly, no build step).

## Docs

- **[michaelyagi.github.io/volley](https://michaelyagi.github.io/volley)** — the published docs site, auto-deployed from `main`.
- **[npmjs.com/package/@michaelyagi/volley](https://www.npmjs.com/package/@michaelyagi/volley)** — the published package, auto-published on tagged releases.
- [`docs/index.html`](docs/index.html) — the same guides, as local static HTML.
- [`CHANGELOG.md`](CHANGELOG.md) — what shipped in each release.

## Development

```bash
node --test   # run the test suite (no dependencies, Node 18+)
```

See [Testing & Development](docs/guides/testing.html) for what's covered and the no-build-step philosophy.

## Releasing

1. Bump `package.json`'s `version`, commit, and push to `main`.
2. Tag that same version and push the tag:

```bash
git tag v<version>   # "v" + package.json's version, e.g. v0.1.0-beta.3
git push origin v<version>
```

Pushing the tag triggers `.github/workflows/release.yml` — it runs the test suite first and only publishes to npm (tagged `latest`) and creates a GitHub release if that passes.

## License

[MIT](LICENSE) — © 2026 Michael Yagi.
