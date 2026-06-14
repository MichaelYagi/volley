#!/usr/bin/env node
'use strict';

// Salvo dev server — static file serving + a tiny JSON file API for the
// data/ directory (collections, environments, history). No dependencies.

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const os     = require('os');

// ─── CLI args ───────────────────────────────────────────────────────────────────
// `node server.js --<name>=<value>` or `node server.js --<name> <value>`
function getCliArg(name) {
  const args = process.argv.slice(2);
  const prefix = `--${name}=`;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
    if (arg === `--${name}`)    return args[i + 1];
  }
  return undefined;
}

function getCliPort() {
  return getCliArg('port');
}

const ROOT      = __dirname;
// --data-dir lets data/ point at a synced/shared folder (Dropbox, a git repo, a
// network share, ...) so multiple machines/users can work from the same data.
const DATA_DIR  = path.resolve(getCliArg('data-dir') || process.env.SALVO_DATA_DIR || path.join(ROOT, 'data'));
const SALVO_DIR = path.join(DATA_DIR, '_salvo');
const PORT      = getCliPort() || process.env.PORT || 5874;
const LOG_DIR   = process.env.SALVO_LOG_DIR || path.join(ROOT, 'logs');
const LOG_FILE  = path.join(LOG_DIR, 'salvo.log');

// ─── Logging ────────────────────────────────────────────────────────────────────
// Writes to the CLI (console) and appends to logs/salvo.log (gitignored).
function log(level, message) {
  const line = `[${new Date().toISOString()}] [${level}] ${message}`;
  if (level === 'ERROR') console.error(line);
  else console.log(line);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch {}
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

function sanitizeName(name) {
  const cleaned = String(name ?? '').replace(/[\\/:*?"<>|]/g, '_').trim();
  return cleaned || 'untitled';
}

function uniqueName(base, used) {
  let name = base, i = 2;
  while (used.has(name.toLowerCase())) name = `${base} (${i++})`;
  used.add(name.toLowerCase());
  return name;
}

// ─── Cookie jar (data/_salvo/cookies.json) ──────────────────────────────────────
// Persisted as a flat array of { domain, path, name, value, expires, secure }.
// `expires` is a ms-epoch timestamp or null for session cookies.

const COOKIES_FILE = path.join(SALVO_DIR, 'cookies.json');

function loadCookies() {
  try { return JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf8')); } catch { return []; }
}

function saveCookies(jar) {
  fs.mkdirSync(SALVO_DIR, { recursive: true });
  fs.writeFileSync(COOKIES_FILE, JSON.stringify(jar, null, 2));
}

// Does `cookie` apply to the given request URL?
function cookieMatches(cookie, urlObj) {
  if (cookie.expires && Date.now() > cookie.expires) return false;
  if (cookie.secure && urlObj.protocol !== 'https:') return false;

  const host = urlObj.hostname;
  if (host !== cookie.domain && !host.endsWith('.' + cookie.domain)) return false;

  const reqPath = urlObj.pathname || '/';
  const cPath   = cookie.path || '/';
  if (reqPath !== cPath && !reqPath.startsWith(cPath.endsWith('/') ? cPath : cPath + '/')) return false;

  return true;
}

// Parse a single `Set-Cookie` header value into a jar entry.
function parseSetCookie(str, defaultDomain) {
  const parts = String(str).split(';').map(p => p.trim()).filter(Boolean);
  if (!parts.length) return null;

  const eq = parts[0].indexOf('=');
  if (eq === -1) return null;

  const cookie = {
    name:    parts[0].slice(0, eq).trim(),
    value:   parts[0].slice(eq + 1).trim(),
    domain:  defaultDomain,
    path:    '/',
    expires: null,
    secure:  false,
  };

  for (const attr of parts.slice(1)) {
    const aEq = attr.indexOf('=');
    const key = (aEq === -1 ? attr : attr.slice(0, aEq)).toLowerCase();
    const val = aEq === -1 ? '' : attr.slice(aEq + 1).trim();

    if      (key === 'domain'  && val) cookie.domain = val.replace(/^\./, '');
    else if (key === 'path'    && val) cookie.path = val;
    else if (key === 'expires' && val) { const t = Date.parse(val); if (!isNaN(t)) cookie.expires = t; }
    else if (key === 'max-age' && val) { const n = parseInt(val, 10); if (!isNaN(n)) cookie.expires = Date.now() + n * 1000; }
    else if (key === 'secure')         cookie.secure = true;
  }

  return cookie;
}

// Insert/update/remove a cookie in the jar (matched by domain+path+name).
function updateJarCookie(jar, cookie) {
  const idx = jar.findIndex(c => c.domain === cookie.domain && c.path === cookie.path && c.name === cookie.name);
  if (cookie.expires !== null && cookie.expires <= Date.now()) {
    if (idx !== -1) jar.splice(idx, 1);
    return;
  }
  if (idx !== -1) jar[idx] = cookie;
  else jar.push(cookie);
}

// ─── Digest auth (RFC 2617) ─────────────────────────────────────────────────────

function parseDigestChallenge(header) {
  const out = {};
  const re = /(\w+)=(?:"([^"]*)"|([^,\s]+))/g;
  let m;
  while ((m = re.exec(header))) out[m[1]] = m[2] !== undefined ? m[2] : m[3];
  return out;
}

function buildDigestHeader({ username, password }, method, uri, { realm, nonce, qop, opaque, algorithm }) {
  const md5 = s => crypto.createHash('md5').update(s).digest('hex');
  const ha1 = md5(`${username}:${realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);

  const nc     = '00000001';
  const cnonce = crypto.randomBytes(8).toString('hex');
  const response = qop ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${nonce}:${ha2}`);

  let h = `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}"`;
  if (qop)       h += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
  if (opaque)    h += `, opaque="${opaque}"`;
  if (algorithm) h += `, algorithm=${algorithm}`;
  return h;
}

// Sorts by the `order` field saveData() stamps onto each request file
// (its index within its containing list at save time). Items missing
// `order` (e.g. hand-edited files) sort after ordered ones, in file order.
function byOrder(a, b) {
  const ao = a._order, bo = b._order;
  if (ao == null && bo == null) return 0;
  if (ao == null) return 1;
  if (bo == null) return -1;
  return ao - bo;
}

// ─── Build {cols, envs, hist} from a flat list of {path, content} files ───────
// `path` looks like "<Collection>/<Request>.json" or "_salvo/envs.json", mirroring
// the on-disk layout of data/. Used by both loadData() and the zip/folder import.
//
// Two extra files carry ordering info that can't live on a request:
//  - "<Collection>/_meta.json"  -> { folders: [<folder names in order>] }, also
//    used to persist folders that have no requests in them (and thus no files).
//  - "_salvo/colOrder.json"     -> [<collection dir names in order>]
function buildColsFromFiles(files) {
  const colsMap = new Map();
  const folderOrders = new Map(); // dir -> [folder names]
  let envs, hist, colOrder;

  for (const { path: relPath, content } of files) {
    const parts = relPath.split('/').filter(Boolean);
    if (parts.length !== 2) continue;
    const [dir, fileName] = parts;
    if (!fileName.toLowerCase().endsWith('.json')) continue;

    if (dir === '_salvo') {
      if (fileName === 'envs.json')    { try { envs = JSON.parse(content); } catch {} }
      if (fileName === 'history.json') { try { hist = JSON.parse(content); } catch {} }
      if (fileName === 'colOrder.json') { try { colOrder = JSON.parse(content); } catch {} }
      continue;
    }

    const getCol = () => {
      let col = colsMap.get(dir);
      if (!col) { col = { name: dir, requests: [], folders: new Map() }; colsMap.set(dir, col); }
      return col;
    };

    if (fileName === '_meta.json') {
      try {
        const meta = JSON.parse(content);
        if (Array.isArray(meta.folders)) folderOrders.set(dir, meta.folders);
      } catch {}
      getCol();
      continue;
    }

    let raw;
    try { raw = JSON.parse(content); } catch { continue; }
    if (!raw || typeof raw !== 'object') continue;

    const col = getCol();
    const { folder, order, ...request } = raw;
    request._order = order;
    if (folder) {
      let fl = col.folders.get(folder);
      if (!fl) { fl = { name: folder, requests: [] }; col.folders.set(folder, fl); }
      fl.requests.push(request);
    } else {
      col.requests.push(request);
    }
  }

  const cols = [...colsMap.entries()].map(([dir, c]) => {
    c.requests.sort(byOrder);
    c.requests.forEach(r => delete r._order);

    // Order folders per _meta.json, including empty folders that have no
    // request files; any folder not listed there (e.g. legacy data, or
    // imports with no _meta.json) is appended in first-seen order.
    const known = folderOrders.get(dir) || [];
    for (const name of known) if (!c.folders.has(name)) c.folders.set(name, { name, requests: [] });
    const names = [...c.folders.keys()];
    const order = [...known.filter(n => c.folders.has(n)), ...names.filter(n => !known.includes(n))];

    const folders = order.map(name => {
      const f = c.folders.get(name);
      f.requests.sort(byOrder);
      f.requests.forEach(r => delete r._order);
      return f;
    });

    return { name: dir, requests: c.requests, folders };
  });

  if (Array.isArray(colOrder)) {
    const names = cols.map(c => c.name);
    const order = [...colOrder.filter(n => names.includes(n)), ...names.filter(n => !colOrder.includes(n))];
    cols.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  }

  return { cols, envs, hist };
}

// ─── Read every collection/request file under data/ as {path, content} ────────
function walkDataDir() {
  const files = [];
  if (!fs.existsSync(DATA_DIR)) return files;

  for (const entry of fs.readdirSync(DATA_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sub = path.join(DATA_DIR, entry.name);
    for (const f of fs.readdirSync(sub, { withFileTypes: true })) {
      if (!f.isFile() || !f.name.toLowerCase().endsWith('.json')) continue;
      files.push({ path: `${entry.name}/${f.name}`, content: fs.readFileSync(path.join(sub, f.name), 'utf8') });
    }
  }

  return files;
}

// Older saves stored env vars as a {key: value} object; convert to the
// array-of-rows shape ({id, key, value, enabled}) used by the kv editor.
function normalizeEnvs(envs) {
  return envs.map(e => ({
    ...e,
    name: (e.id === 'default' && !e.name) ? 'No Environment' : e.name,
    vars: Array.isArray(e.vars)
      ? e.vars
      : Object.entries(e.vars || {}).map(([key, value]) => ({ id: crypto.randomUUID(), key, value, enabled: true })),
  }));
}

// ─── Load all collections + envs + history from data/ ─────────────────────────
// envs.json is { activeEnv, list } — older saves stored a bare array (no
// activeEnv), which is treated as `list` with activeEnv defaulting to 'default'.
function loadData() {
  const { cols, envs, hist } = buildColsFromFiles(walkDataDir());

  const list      = Array.isArray(envs) ? envs : envs?.list;
  const activeEnv = Array.isArray(envs) ? 'default' : (envs?.activeEnv || 'default');

  let tabsData = {};
  try { tabsData = JSON.parse(fs.readFileSync(path.join(SALVO_DIR, 'tabs.json'), 'utf8')); } catch {}

  let globals = [];
  try { globals = JSON.parse(fs.readFileSync(path.join(SALVO_DIR, 'globals.json'), 'utf8')); } catch {}

  return {
    cols,
    envs: normalizeEnvs(list?.length ? list : [{ id: 'default', name: 'No Environment', vars: [] }]),
    activeEnv,
    globals: normalizeEnvs([{ id: '__globals__', name: 'Globals', vars: globals }])[0].vars,
    hist: hist || [],
    openTabs:    Array.isArray(tabsData.openTabs) ? tabsData.openTabs : [],
    activeIndex: typeof tabsData.activeIndex === 'number' ? tabsData.activeIndex : -1,
  };
}

// ─── Persist collections + envs + history to data/ ─────────────────────────────
function saveData(payload) {
  const cols      = Array.isArray(payload.cols) ? payload.cols : [];
  const envs      = Array.isArray(payload.envs) ? payload.envs : [];
  const globals   = Array.isArray(payload.globals) ? payload.globals : [];
  const hist      = Array.isArray(payload.hist) ? payload.hist : [];
  const activeEnv = payload.activeEnv || 'default';
  const openTabs  = Array.isArray(payload.openTabs) ? payload.openTabs : [];
  const activeIndex = typeof payload.activeIndex === 'number' ? payload.activeIndex : -1;

  fs.mkdirSync(DATA_DIR, { recursive: true });

  // Remove collection directories that no longer exist
  const keepDirs = new Set(cols.map(c => sanitizeName(c.name)));
  for (const entry of fs.readdirSync(DATA_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === '_salvo') continue;
    if (!keepDirs.has(entry.name)) fs.rmSync(path.join(DATA_DIR, entry.name), { recursive: true, force: true });
  }

  for (const col of cols) {
    const colDir = path.join(DATA_DIR, sanitizeName(col.name));
    fs.mkdirSync(colDir, { recursive: true });

    // Wipe existing request files, then rewrite from current state
    for (const f of fs.readdirSync(colDir, { withFileTypes: true })) {
      if (f.isFile() && f.name.toLowerCase().endsWith('.json')) fs.unlinkSync(path.join(colDir, f.name));
    }

    const used = new Set();
    const writeReq = (req, folderName, order) => {
      const fileName = uniqueName(sanitizeName(req.name), used) + '.json';
      const { id, ...rest } = req;
      const data = folderName ? { ...rest, folder: folderName, order } : { ...rest, order };
      fs.writeFileSync(path.join(colDir, fileName), JSON.stringify(data, null, 2));
    };

    (col.requests || []).forEach((r, i) => writeReq(r, null, i));
    (col.folders  || []).forEach(f => (f.requests || []).forEach((r, i) => writeReq(r, f.name, i)));

    // Folders aren't directories, so their order (and the existence of empty
    // folders, which have no request files) is persisted here separately.
    fs.writeFileSync(path.join(colDir, '_meta.json'),
      JSON.stringify({ folders: (col.folders || []).map(f => f.name) }, null, 2));
  }

  fs.mkdirSync(SALVO_DIR, { recursive: true });
  fs.writeFileSync(path.join(SALVO_DIR, 'envs.json'),     JSON.stringify({ activeEnv, list: envs }, null, 2));
  fs.writeFileSync(path.join(SALVO_DIR, 'globals.json'),  JSON.stringify(globals, null, 2));
  fs.writeFileSync(path.join(SALVO_DIR, 'history.json'),  JSON.stringify(hist.slice(-200), null, 2));
  fs.writeFileSync(path.join(SALVO_DIR, 'tabs.json'),     JSON.stringify({ openTabs, activeIndex }, null, 2));
  fs.writeFileSync(path.join(SALVO_DIR, 'colOrder.json'), JSON.stringify(cols.map(c => sanitizeName(c.name)), null, 2));
}

// ─── Mock server ────────────────────────────────────────────────────────────────
// A second, optional HTTP server that serves canned responses for requests
// whose `mock.enabled` is true. Routes are { method, path, status, headers,
// body, delay }, where `path` segments starting with `:` match any value
// (mirroring Salvo's `:name` path variables).

let mockServer = null;
let mockState  = { port: null, routes: [] };

function mockPathSegments(p) {
  return String(p || '/').split('/').filter(Boolean);
}

function findMockMatch(routes, method, pathname) {
  const segs = mockPathSegments(pathname);
  return routes.find(r => {
    if (String(r.method).toUpperCase() !== String(method).toUpperCase()) return false;
    const rsegs = mockPathSegments(r.path);
    if (rsegs.length !== segs.length) return false;
    return rsegs.every((s, i) => s.startsWith(':') || s === segs[i]);
  }) || null;
}

function createMockServer(routes) {
  return http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    const match = findMockMatch(routes, req.method, u.pathname);

    if (!match) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `No mock route for ${req.method} ${u.pathname}` }));
      return;
    }

    const send = () => {
      const headers = {};
      (match.headers || []).forEach(h => { if (h.key) headers[h.key] = h.value; });
      if (!Object.keys(headers).some(k => k.toLowerCase() === 'content-type')) {
        headers['Content-Type'] = 'application/json';
      }
      res.writeHead(match.status || 200, headers);
      res.end(match.body || '');
    };

    if (match.delay > 0) setTimeout(send, match.delay);
    else send();
  });
}

function startMockServer(port, routes) {
  return new Promise((resolve, reject) => {
    if (mockServer) { reject(new Error('Mock server already running')); return; }
    const srv = createMockServer(routes || []);
    srv.once('error', reject);
    srv.listen(port, () => {
      mockServer = srv;
      const actualPort = srv.address().port;
      mockState  = { port: actualPort, routes: routes || [] };
      resolve({ port: actualPort, routes: mockState.routes.length });
    });
  });
}

function stopMockServer() {
  return new Promise(resolve => {
    if (!mockServer) { resolve(); return; }
    mockServer.close(() => {
      mockServer = null;
      mockState  = { port: null, routes: [] };
      resolve();
    });
  });
}

function mockStatus() {
  return { running: !!mockServer, port: mockState.port, routes: mockState.routes.length };
}

// ─── HTTP server ────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const start = Date.now();
  const u = new URL(req.url, `http://${req.headers.host}`);

  res.on('finish', () => {
    log('INFO', `${req.method} ${u.pathname} ${res.statusCode} ${Date.now() - start}ms`);
  });

  if (u.pathname === '/api/data' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(loadData()));
    return;
  }

  if (u.pathname === '/api/save' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        saveData(JSON.parse(body));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        log('ERROR', `save failed: ${err.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  if (u.pathname === '/api/cookies' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ cookies: loadCookies() }));
    return;
  }

  if (u.pathname === '/api/cookies' && req.method === 'DELETE') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { domain, path: cPath, name } = JSON.parse(body || '{}');
        let jar = loadCookies();
        jar = (!domain && !name)
          ? []
          : jar.filter(c => !(c.domain === domain && c.path === cPath && c.name === name));
        saveCookies(jar);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, cookies: jar }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // OAuth 2.0 Authorization Code redirect target — the provider redirects the
  // popup window opened by startAuthCodeFlow() (js/send.js) here with
  // ?code=...&state=... (or ?error=...). Hands the result back to the opener
  // via postMessage and closes itself.
  if (u.pathname === '/api/oauth/callback' && req.method === 'GET') {
    const payload = {
      source: 'salvo-oauth',
      code:  u.searchParams.get('code'),
      state: u.searchParams.get('state'),
      error: u.searchParams.get('error'),
    };
    // Escape '<' so a malicious code/state/error value can't break out of
    // the inline <script> (e.g. via "</script>").
    const esc  = s => JSON.stringify(s).replace(/</g, '\\u003c');
    const json = esc(payload);
    const message = payload.error ? 'Authorization failed: ' + payload.error : 'Authorization complete — you can close this window.';
    const html = `<!DOCTYPE html><html><body>
<script>
  if (window.opener) window.opener.postMessage(${json}, window.location.origin);
  document.body.textContent = ${esc(message)};
  setTimeout(() => window.close(), 500);
</script>
</body></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  if (u.pathname === '/api/mock/status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ...mockStatus() }));
    return;
  }

  if (u.pathname === '/api/mock/start' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { port, routes } = JSON.parse(body || '{}');
        const result = await startMockServer(Number(port), routes);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ...result }));
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  if (u.pathname === '/api/mock/stop' && req.method === 'POST') {
    stopMockServer().then(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  if (u.pathname === '/api/proxy' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      let url, method;
      try {
        let headers, reqBody, bodyKind, digestAuth, skipCookieJar;
        ({ url, method, headers, body: reqBody, bodyKind, digestAuth, skipCookieJar } = JSON.parse(body));

        function buildFetchBody() {
          if (bodyKind === 'raw') return reqBody;
          if (bodyKind === 'formdata') {
            const fd = new FormData();
            (reqBody || []).forEach(entry => {
              if (entry.type === 'file' && entry.fileData) {
                const buf  = Buffer.from(entry.fileData, 'base64');
                const blob = new Blob([buf], { type: entry.fileMimeType || 'application/octet-stream' });
                fd.append(entry.key, blob, entry.fileName || 'file');
              } else {
                fd.append(entry.key, entry.value);
              }
            });
            return fd;
          }
          if (bodyKind === 'urlencoded') {
            return new URLSearchParams((reqBody || []).map(({ key, value }) => [key, value]));
          }
          if (bodyKind === 'binary') {
            return reqBody?.fileData ? Buffer.from(reqBody.fileData, 'base64') : undefined;
          }
          if (bodyKind === 'graphql') {
            return JSON.stringify({ query: reqBody?.query || '', variables: reqBody?.variables || {} });
          }
          return undefined;
        }

        // Attach cookies from the jar that match this request's URL.
        const reqUrl = new URL(url);
        const jar     = skipCookieJar ? [] : loadCookies();
        const matched = jar.filter(c => cookieMatches(c, reqUrl));
        if (matched.length) {
          const cookieStr  = matched.map(c => `${c.name}=${c.value}`).join('; ');
          const cookieKey  = Object.keys(headers || {}).find(k => k.toLowerCase() === 'cookie');
          if (cookieKey) headers[cookieKey] = `${headers[cookieKey]}; ${cookieStr}`;
          else headers = { ...headers, Cookie: cookieStr };
        }

        const doFetch = hdrs => fetch(url, {
          method,
          headers: hdrs,
          body: ['GET', 'HEAD'].includes(method) ? undefined : buildFetchBody(),
        });

        const start = Date.now();
        let upstream = await doFetch(headers);

        // Transparently answer a Digest auth challenge and retry once.
        if (digestAuth && upstream.status === 401) {
          const challengeHeader = upstream.headers.get('www-authenticate') || '';
          if (/digest/i.test(challengeHeader)) {
            const challenge   = parseDigestChallenge(challengeHeader);
            const uri         = reqUrl.pathname + reqUrl.search;
            const digestValue = buildDigestHeader(digestAuth, method, uri, challenge);
            upstream = await doFetch({ ...headers, Authorization: digestValue });
          }
        }

        const elapsed = Date.now() - start;

        // Store any cookies the upstream server sets.
        const setCookies = upstream.headers.getSetCookie?.() || [];
        if (setCookies.length) {
          for (const sc of setCookies) {
            const cookie = parseSetCookie(sc, reqUrl.hostname);
            if (cookie) updateJarCookie(jar, cookie);
          }
          saveCookies(jar);
        }

        const buf         = Buffer.from(await upstream.arrayBuffer());
        const respHeaders = {};
        upstream.headers.forEach((v, k) => { respHeaders[k] = v; });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok:         true,
          status:     upstream.status,
          statusText: upstream.statusText,
          headers:    respHeaders,
          bodyBase64: buf.toString('base64'),
          elapsed,
        }));
      } catch (err) {
        log('ERROR', `proxy ${method} ${url} failed: ${err.message}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // Static file serving
  let filePath = path.join(ROOT, decodeURIComponent(u.pathname));
  if (u.pathname === '/') filePath = path.join(ROOT, 'index.html');

  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

// ─── LAN-accessible addresses, for the startup log ─────────────────────────────
function lanAddresses() {
  const addrs = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces || []) {
      if (iface.family === 'IPv4' && !iface.internal) addrs.push(iface.address);
    }
  }
  return addrs;
}

if (require.main === module) {
  server.listen(PORT, () => {
    log('INFO', `Salvo running at http://localhost:${PORT}`);
    for (const addr of lanAddresses()) log('INFO', `  also available at http://${addr}:${PORT}`);
  });
}

module.exports = {
  sanitizeName, uniqueName, buildColsFromFiles, walkDataDir, loadData, saveData, server,
  parseDigestChallenge, buildDigestHeader, normalizeEnvs, log,
  loadCookies, saveCookies, cookieMatches, parseSetCookie, updateJarCookie,
  findMockMatch, createMockServer, startMockServer, stopMockServer, mockStatus,
  getCliArg,
};
