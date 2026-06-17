#!/usr/bin/env node
'use strict';

// Salvo dev server — static file serving + a tiny JSON file API for the
// data/ directory (collections, environments, history). No dependencies.

const http   = require('http');
const net    = require('net');
const tls    = require('tls');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const os     = require('os');
const { spawn } = require('child_process');

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

// Git sync
const CONFIG_DIR      = path.join(ROOT, 'config');
const GIT_CONFIG_FILE = path.join(CONFIG_DIR, 'git.json');
const SYNC_DIR        = path.join(ROOT, 'salvo-sync');

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

// Builds the body for a proxied fetch from the request's bodyKind/reqBody,
// as sent by buildRequestArgs() (js/send.js). Shared by /api/proxy and
// /api/proxy-stream.
function buildFetchBody(bodyKind, reqBody) {
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

// Merges any jar cookies that match `reqUrl` into `headers`, returning the
// (possibly new) headers object. Shared by /api/proxy and /api/proxy-stream.
function attachJarCookies(headers, jar, reqUrl) {
  const matched = jar.filter(c => cookieMatches(c, reqUrl));
  if (!matched.length) return headers;

  const cookieStr = matched.map(c => `${c.name}=${c.value}`).join('; ');
  const cookieKey = Object.keys(headers || {}).find(k => k.toLowerCase() === 'cookie');
  if (cookieKey) return { ...headers, [cookieKey]: `${headers[cookieKey]}; ${cookieStr}` };
  return { ...headers, Cookie: cookieStr };
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

// ─── WebSocket relay (RFC 6455) ─────────────────────────────────────────────────
// Browsers can't open ws(s):// connections to arbitrary hosts with custom
// headers (auth, cookies, ...) directly from the page, so Salvo relays them:
// the page opens a WebSocket to /api/ws-proxy, sends a single JSON "connect"
// control message ({ url, headers }), and from then on raw frames are
// forwarded 1:1 between the page and the upstream target. Frames *from* the
// upstream are wrapped as JSON control messages ({ type: 'open'|'message'|
// 'close'|'error', ... }) so the page can distinguish them from its own echo.

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function wsAcceptKey(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

const WS_OP = { CONTINUATION: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xA };

// Encodes a single, unfragmented WebSocket frame. `masked` must be true for
// client-to-server frames (Salvo -> upstream) and false for server-to-client
// frames (Salvo -> browser), per RFC 6455.
function encodeWsFrame(opcode, payload, masked) {
  payload = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const len = payload.length;

  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode; // FIN=1, no extensions

  if (!masked) return Buffer.concat([header, payload]);

  header[1] |= 0x80;
  const mask = crypto.randomBytes(4);
  const body = Buffer.alloc(len);
  for (let i = 0; i < len; i++) body[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, body]);
}

// Incremental frame decoder — feed it raw bytes via push(chunk), get back any
// complete frames as { fin, opcode, payload }. Buffers a partial trailing
// frame across calls.
class WsFrameDecoder {
  constructor() { this.buf = Buffer.alloc(0); }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const frames = [];
    while (true) {
      if (this.buf.length < 2) break;

      const b0 = this.buf[0], b1 = this.buf[1];
      const fin    = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (this.buf.length < offset + 2) break;
        len = this.buf.readUInt16BE(offset);
        offset += 2;
      } else if (len === 127) {
        if (this.buf.length < offset + 8) break;
        len = Number(this.buf.readBigUInt64BE(offset));
        offset += 8;
      }

      let maskKey;
      if (masked) {
        if (this.buf.length < offset + 4) break;
        maskKey = this.buf.subarray(offset, offset + 4);
        offset += 4;
      }

      if (this.buf.length < offset + len) break;

      let payload = Buffer.from(this.buf.subarray(offset, offset + len));
      if (masked) for (let i = 0; i < len; i++) payload[i] ^= maskKey[i % 4];

      frames.push({ fin, opcode, payload });
      this.buf = this.buf.subarray(offset + len);
    }
    return frames;
  }
}

// Returns a per-direction assembler that accumulates fragmented messages
// (CONTINUATION frames) and calls onComplete(opcode, payload) once fin=true.
function makeFragmentAssembler() {
  let pending = null; // { opcode, chunks }
  return (frame, onComplete) => {
    if (frame.opcode === WS_OP.CONTINUATION) {
      if (!pending) return;
      pending.chunks.push(frame.payload);
    } else {
      pending = { opcode: frame.opcode, chunks: [frame.payload] };
    }
    if (!frame.fin) return;
    const { opcode, chunks } = pending;
    pending = null;
    onComplete(opcode, Buffer.concat(chunks));
  };
}

// Opens a raw TCP/TLS socket to `targetUrl` and performs the client-side
// WebSocket handshake (RFC 6455 section 4.1). Resolves with the connected
// socket and any bytes already received past the handshake response.
function wsConnectUpstream(targetUrl, extraHeaders) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(targetUrl); } catch (err) { reject(err); return; }
    if (u.protocol !== 'ws:' && u.protocol !== 'wss:') {
      reject(new Error(`Unsupported WebSocket URL scheme: ${u.protocol}`));
      return;
    }

    const isTls = u.protocol === 'wss:';
    const port  = u.port || (isTls ? 443 : 80);
    const key   = crypto.randomBytes(16).toString('base64');

    const connectOpts = { host: u.hostname, port: Number(port) };
    const socket = isTls
      ? tls.connect({ ...connectOpts, servername: u.hostname })
      : net.connect(connectOpts);

    socket.once('connect', () => {
      const lines = [
        `GET ${u.pathname || '/'}${u.search} HTTP/1.1`,
        `Host: ${u.host}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
      ];
      for (const [k, v] of Object.entries(extraHeaders || {})) lines.push(`${k}: ${v}`);
      socket.write(lines.join('\r\n') + '\r\n\r\n');
    });

    let buf = Buffer.alloc(0);
    const onData = chunk => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx === -1) return;

      socket.removeListener('data', onData);
      const head = buf.subarray(0, idx).toString('latin1');
      const rest = buf.subarray(idx + 4);

      const statusLine = head.split('\r\n')[0];
      if (!/^HTTP\/1\.\d 101\b/.test(statusLine)) {
        socket.destroy();
        reject(new Error(`Upstream WebSocket handshake failed: ${statusLine}`));
        return;
      }

      const acceptMatch = head.match(/^Sec-WebSocket-Accept:\s*(.+)$/im);
      if (!acceptMatch || acceptMatch[1].trim() !== wsAcceptKey(key)) {
        socket.destroy();
        reject(new Error('Upstream WebSocket handshake failed: invalid Sec-WebSocket-Accept'));
        return;
      }

      resolve({ socket, rest });
    };

    socket.on('data', onData);
    socket.once('error', reject);
  });
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

// ─── Git sync helpers ──────────────────────────────────────────────────────────

function readGitCfg() {
  try { return JSON.parse(fs.readFileSync(GIT_CONFIG_FILE, 'utf8')); } catch { return null; }
}

function writeGitCfg(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(GIT_CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

function gitAuthUrl(remoteUrl, pat) {
  if (!pat) return remoteUrl;
  try {
    const u = new URL(remoteUrl);
    u.username = 'oauth2';
    u.password = pat;
    return u.toString();
  } catch { return remoteUrl; }
}

function gitRun(args, cwd) {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'true' },
    });
    let out = '', err = '';
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { err += d; });
    proc.on('close', code => {
      if (code === 0) resolve(out.trim());
      else reject(new Error((err || out).trim() || `git exited ${code}`));
    });
    proc.on('error', e => reject(new Error('git not found: ' + e.message)));
  });
}

const SYNC_EXCLUDES = new Set(['_salvo/history.json', '_salvo/tabs.json', '_salvo/cookies.json']);

function listJsonFiles(dir) {
  const results = [];
  function walk(cur, rel) {
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === '.git') continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (SYNC_EXCLUDES.has(r)) continue;
      if (e.isDirectory()) walk(path.join(cur, e.name), r);
      else if (e.name.endsWith('.json')) results.push(r);
    }
  }
  walk(dir, '');
  return results;
}

function readOrNull(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

function syncDataToRepo(dataDir, syncDir) {
  function clean(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === '.git') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { clean(full); try { fs.rmdirSync(full); } catch {} }
      else fs.unlinkSync(full);
    }
  }
  clean(syncDir);
  for (const rel of listJsonFiles(dataDir)) {
    const dest = path.join(syncDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(dataDir, rel), dest);
  }
}

function getLocalChanges(dataDir, syncDir) {
  const df = new Set(listJsonFiles(dataDir));
  const sf = new Set(listJsonFiles(syncDir));
  const added    = [...df].filter(f => !sf.has(f));
  const deleted  = [...sf].filter(f => !df.has(f));
  const modified = [...df].filter(f => sf.has(f) &&
    readOrNull(path.join(dataDir, f)) !== readOrNull(path.join(syncDir, f)));
  return { added, modified, deleted };
}

function isSyncInit() {
  return fs.existsSync(path.join(SYNC_DIR, '.git'));
}

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

function createMockServer() {
  return http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    const match = findMockMatch(mockState.routes, req.method, u.pathname);

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
    mockState = { port: null, routes: routes || [] };
    const srv = createMockServer();
    srv.once('error', reject);
    srv.listen(port, () => {
      mockServer = srv;
      mockState.port = srv.address().port;
      resolve({ port: mockState.port, routes: mockState.routes.length });
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

function updateMockRoutes(routes) {
  if (!mockServer) throw new Error('Mock server is not running');
  mockState.routes = routes || [];
}

function mockStatus() {
  return { running: !!mockServer, port: mockState.port, routes: mockState.routes.length };
}

// ─── HTTP server ────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const start = Date.now();
  const u = new URL(req.url, `http://${req.headers.host}`);

  res.on('finish', () => {
    if (u.pathname !== '/api/ping')
      log('INFO', `${req.method} ${u.pathname} ${res.statusCode} ${Date.now() - start}ms`);
  });

  if (u.pathname === '/api/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }

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

  if (u.pathname === '/api/mock/update' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { routes } = JSON.parse(body || '{}');
        updateMockRoutes(routes);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, routes: mockState.routes.length }));
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
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

        // Attach cookies from the jar that match this request's URL.
        const reqUrl = new URL(url);
        const jar     = skipCookieJar ? [] : loadCookies();
        headers = attachJarCookies(headers, jar, reqUrl);

        const doFetch = hdrs => fetch(url, {
          method,
          headers: hdrs,
          body: ['GET', 'HEAD'].includes(method) ? undefined : buildFetchBody(bodyKind, reqBody),
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

  // Streaming variant of /api/proxy for SSE (Server-Sent Events). Streams the
  // upstream response body back as it arrives via chunked transfer-encoding;
  // status/statusText/headers are passed via X-Salvo-* response headers since
  // the body itself carries the raw event stream. js/send.js's connectSSE()
  // parses the stream incrementally.
  if (u.pathname === '/api/proxy-stream' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      let url, method;
      try {
        let headers, reqBody, bodyKind, digestAuth, skipCookieJar;
        ({ url, method, headers, body: reqBody, bodyKind, digestAuth, skipCookieJar } = JSON.parse(body));

        const reqUrl = new URL(url);
        const jar     = skipCookieJar ? [] : loadCookies();
        headers = attachJarCookies(headers, jar, reqUrl);

        const upstreamAbort = new AbortController();
        res.on('close', () => upstreamAbort.abort());

        const doFetch = hdrs => fetch(url, {
          method,
          headers: hdrs,
          body: ['GET', 'HEAD'].includes(method) ? undefined : buildFetchBody(bodyKind, reqBody),
          signal: upstreamAbort.signal,
        });

        let upstream = await doFetch(headers);

        // Transparently answer a Digest auth challenge and retry once.
        if (digestAuth && upstream.status === 401) {
          const challengeHeader = upstream.headers.get('www-authenticate') || '';
          if (/digest/i.test(challengeHeader)) {
            upstream.body?.cancel();
            const challenge   = parseDigestChallenge(challengeHeader);
            const uri         = reqUrl.pathname + reqUrl.search;
            const digestValue = buildDigestHeader(digestAuth, method, uri, challenge);
            upstream = await doFetch({ ...headers, Authorization: digestValue });
          }
        }

        // Store any cookies the upstream server sets.
        const setCookies = upstream.headers.getSetCookie?.() || [];
        if (setCookies.length) {
          for (const sc of setCookies) {
            const cookie = parseSetCookie(sc, reqUrl.hostname);
            if (cookie) updateJarCookie(jar, cookie);
          }
          saveCookies(jar);
        }

        const respHeaders = {};
        upstream.headers.forEach((v, k) => { respHeaders[k] = v; });

        res.writeHead(200, {
          'Content-Type':               'text/event-stream; charset=utf-8',
          'X-Salvo-Stream':             'ok',
          'X-Salvo-Upstream-Status':     String(upstream.status),
          'X-Salvo-Upstream-Statustext': encodeURIComponent(upstream.statusText || ''),
          'X-Salvo-Upstream-Headers':    Buffer.from(JSON.stringify(respHeaders)).toString('base64'),
        });

        if (!upstream.body) { res.end(); return; }

        const reader = upstream.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(Buffer.from(value));
          }
        } catch (err) {
          if (err.name !== 'AbortError') log('ERROR', `proxy-stream ${method} ${url} failed: ${err.message}`);
        }
        res.end();
      } catch (err) {
        log('ERROR', `proxy-stream ${method} ${url} failed: ${err.message}`);
        res.writeHead(200, { 'Content-Type': 'application/json', 'X-Salvo-Stream': 'error' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // ── Git sync endpoints ────────────────────────────────────────────────────

  if (u.pathname === '/api/git/config' && req.method === 'GET') {
    const cfg = readGitCfg();
    const safe = cfg ? { remoteUrl: cfg.remoteUrl || '', branch: cfg.branch || 'main',
      autoSync: !!cfg.autoSync, intervalMinutes: cfg.intervalMinutes || 5, patSet: !!cfg.pat } : null;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, config: safe }));
    return;
  }

  if (u.pathname === '/api/git/config' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const incoming = JSON.parse(body);
        const existing = readGitCfg() || {};
        const cfg = { ...existing, ...incoming };
        if (!incoming.pat && existing.pat) cfg.pat = existing.pat;
        writeGitCfg(cfg);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  if (u.pathname === '/api/git/status' && req.method === 'GET') {
    (async () => {
      try {
        const cfg = readGitCfg();
        if (!isSyncInit()) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, initialized: false, configured: !!cfg?.remoteUrl }));
          return;
        }
        const { added, modified, deleted } = getLocalChanges(DATA_DIR, SYNC_DIR);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true, initialized: true, configured: true,
          localChanges: added.length + modified.length + deleted.length,
          lastSync: cfg?.lastSync || null,
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    })();
    return;
  }

  if (u.pathname === '/api/git/init' && req.method === 'POST') {
    (async () => {
      try {
        const cfg = readGitCfg();
        if (!cfg?.remoteUrl) throw new Error('No remote URL configured');
        const authUrl = gitAuthUrl(cfg.remoteUrl, cfg.pat || '');
        if (fs.existsSync(SYNC_DIR)) fs.rmSync(SYNC_DIR, { recursive: true, force: true });
        await gitRun(['clone', authUrl, SYNC_DIR], ROOT);
        // Remove PAT from stored remote URL
        await gitRun(['remote', 'set-url', 'origin', cfg.remoteUrl], SYNC_DIR);
        await gitRun(['config', 'user.email', 'salvo@local'], SYNC_DIR);
        await gitRun(['config', 'user.name', 'Salvo Sync'], SYNC_DIR);
        // Populate data/ from the cloned repo.
        // Salvo export files ({ cols: [...] }) are expanded via saveData so they
        // land in the correct directory structure. All other .json files are copied as-is.
        const syncFiles = listJsonFiles(SYNC_DIR);
        let filesCopied = 0;
        let expandedExport = false;
        for (const rel of syncFiles) {
          const content = readOrNull(path.join(SYNC_DIR, rel));
          if (!content) continue;
          let parsed;
          try { parsed = JSON.parse(content); } catch { parsed = null; }
          if (parsed && Array.isArray(parsed.cols)) {
            saveData(parsed);
            filesCopied += (parsed.cols || []).length;
            expandedExport = true;
            log('INFO', `git init: expanded Salvo export ${rel} (${parsed.cols.length} collection(s))`);
          } else {
            const dest = path.join(DATA_DIR, rel);
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.writeFileSync(dest, content);
            filesCopied++;
          }
        }
        // If we expanded an export, sync the new data/ layout back into salvo-sync/
        // so getLocalChanges returns 0 (no phantom local changes after re-clone).
        if (expandedExport) syncDataToRepo(DATA_DIR, SYNC_DIR);
        writeGitCfg({ ...cfg, lastSync: new Date().toISOString() });
        log('INFO', `git init: cloned ${cfg.remoteUrl}, processed ${syncFiles.length} file(s)`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, filesCopied, files: syncFiles }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    })();
    return;
  }

  if (u.pathname === '/api/git/push' && req.method === 'POST') {
    (async () => {
      try {
        if (!isSyncInit()) throw new Error('Repository not connected');
        const cfg = readGitCfg();
        if (!cfg?.remoteUrl) throw new Error('No remote URL configured');
        syncDataToRepo(DATA_DIR, SYNC_DIR);
        const dirty = await gitRun(['status', '--porcelain'], SYNC_DIR);
        if (!dirty) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, committed: false, message: 'Nothing to push' }));
          return;
        }
        await gitRun(['add', '-A'], SYNC_DIR);
        const count = dirty.split('\n').filter(Boolean).length;
        await gitRun(['commit', '-m', `Sync ${new Date().toISOString()}`], SYNC_DIR);
        const branch   = cfg.branch || 'main';
        const authUrl  = gitAuthUrl(cfg.remoteUrl, cfg.pat || '');
        await gitRun(['push', authUrl, `HEAD:${branch}`], SYNC_DIR);
        writeGitCfg({ ...cfg, lastSync: new Date().toISOString() });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, committed: true, message: `Pushed ${count} change${count !== 1 ? 's' : ''}` }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    })();
    return;
  }

  if (u.pathname === '/api/git/pull' && req.method === 'POST') {
    (async () => {
      try {
        if (!isSyncInit()) throw new Error('Repository not connected');
        const cfg     = readGitCfg();
        const branch  = cfg?.branch || 'main';
        const authUrl = gitAuthUrl(cfg?.remoteUrl || '', cfg?.pat || '');
        await gitRun(['fetch', authUrl, branch], SYNC_DIR);
        // What changed between our last sync point and remote?
        const diffOut = await gitRun(['diff', '--name-status', 'HEAD', 'FETCH_HEAD'], SYNC_DIR).catch(() => '');
        if (!diffOut) {
          writeGitCfg({ ...cfg, lastSync: new Date().toISOString() });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, autoApplied: 0, conflicts: [], upToDate: true }));
          return;
        }
        // Parse remote changes
        const remoteChanges = diffOut.split('\n').filter(Boolean).map(line => {
          const [action, ...rest] = line.split('\t');
          return { path: rest[0], action: action.trim() };
        });
        // Detect local edits (data/ vs salvo-sync/ HEAD)
        const localDiff = getLocalChanges(DATA_DIR, SYNC_DIR);
        const localModified = new Set([...localDiff.added, ...localDiff.modified, ...localDiff.deleted]);
        const autoApply = [], conflicts = [];
        for (const change of remoteChanges) {
          const remoteContent = change.action !== 'D'
            ? await gitRun(['show', `FETCH_HEAD:${change.path}`], SYNC_DIR).catch(() => null)
            : null;
          const localContent = readOrNull(path.join(DATA_DIR, change.path));
          if (localModified.has(change.path)) {
            conflicts.push({ path: change.path, action: change.action, localContent, remoteContent });
          } else {
            autoApply.push({ path: change.path, action: change.action, remoteContent });
          }
        }
        // Apply non-conflicted remote changes to data/
        for (const item of autoApply) {
          const dest = path.join(DATA_DIR, item.path);
          if (item.action === 'D' || item.remoteContent === null) {
            try { fs.unlinkSync(dest); } catch {}
          } else {
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.writeFileSync(dest, item.remoteContent);
          }
        }
        // Advance salvo-sync/ HEAD if no conflicts
        if (conflicts.length === 0) {
          await gitRun(['reset', '--hard', 'FETCH_HEAD'], SYNC_DIR);
          writeGitCfg({ ...cfg, lastSync: new Date().toISOString() });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, autoApplied: autoApply.length, conflicts }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    })();
    return;
  }

  if (u.pathname === '/api/git/apply' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { resolutions } = JSON.parse(body);
        const cfg = readGitCfg();
        for (const { path: p, choice, remoteContent } of resolutions) {
          const dest = path.join(DATA_DIR, p);
          if (choice === 'remote') {
            if (!remoteContent) { try { fs.unlinkSync(dest); } catch {} }
            else { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, remoteContent); }
          }
        }
        await gitRun(['reset', '--hard', 'FETCH_HEAD'], SYNC_DIR);
        writeGitCfg({ ...cfg, lastSync: new Date().toISOString() });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
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

// Cleanup callbacks for active /api/ws-proxy and /api/mcp-stdio relay
// connections (closes the upstream socket / kills the spawned child), so
// shutdown() can tear them down instead of leaving them as orphans.
const activeRelays = new Set();

// ─── WebSocket / MCP-stdio relay endpoints ─────────────────────────────────────
// Both /api/ws-proxy and /api/mcp-stdio are plain WebSocket upgrades from the
// page; dispatch on pathname.
server.on('upgrade', (req, socket, head) => {
  const u = new URL(req.url, 'http://localhost');
  if ((req.headers.upgrade || '').toLowerCase() !== 'websocket') { socket.destroy(); return; }

  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }

  if (u.pathname === '/api/ws-proxy')  return handleWsProxyUpgrade(socket, head, key);
  if (u.pathname === '/api/mcp-stdio') return handleMcpStdioUpgrade(socket, head, key);
  socket.destroy();
});

// See the "WebSocket relay" section above for the wire protocol.
function handleWsProxyUpgrade(socket, head, key) {
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${wsAcceptKey(key)}\r\n\r\n`
  );

  const toBrowser = (type, extra) => socket.write(encodeWsFrame(WS_OP.TEXT, JSON.stringify({ type, ...extra }), false));

  // Ends the browser-facing connection cleanly: a WS server must answer a
  // Close frame (or initiate one) before closing the TCP connection, or the
  // browser sees an abnormal (1006) closure and the socket can linger.
  const closeBrowser = payload => { socket.write(encodeWsFrame(WS_OP.CLOSE, payload || Buffer.alloc(0), false)); socket.end(); };

  let upstream   = null;
  let connecting = false;

  const browserAssemble  = makeFragmentAssembler();
  const upstreamAssemble = makeFragmentAssembler();

  const browserDecoder = new WsFrameDecoder();
  let upstreamDecoder  = null;

  function handleUpstreamData(chunk) {
    for (const frame of upstreamDecoder.push(chunk)) {
      if (frame.opcode === WS_OP.PING) { upstream.write(encodeWsFrame(WS_OP.PONG, frame.payload, true)); continue; }
      if (frame.opcode === WS_OP.PONG) continue;
      if (frame.opcode === WS_OP.CLOSE) {
        upstream.write(encodeWsFrame(WS_OP.CLOSE, frame.payload, true));
        upstream.end();
        toBrowser('close');
        closeBrowser();
        return;
      }

      upstreamAssemble(frame, (opcode, payload) => {
        toBrowser('message', {
          binary: opcode === WS_OP.BINARY,
          data: opcode === WS_OP.BINARY ? payload.toString('base64') : payload.toString('utf8'),
        });
      });
    }
  }

  function handleBrowserFrame(frame) {
    if (frame.opcode === WS_OP.PING) { socket.write(encodeWsFrame(WS_OP.PONG, frame.payload, false)); return; }
    if (frame.opcode === WS_OP.PONG) return;
    if (frame.opcode === WS_OP.CLOSE) {
      socket.write(encodeWsFrame(WS_OP.CLOSE, frame.payload, false));
      socket.end();
      if (upstream) {
        upstream.write(encodeWsFrame(WS_OP.CLOSE, Buffer.alloc(0), true));
        upstream.end();
      }
      return;
    }

    if (!upstream) {
      if (connecting) return;
      browserAssemble(frame, (opcode, payload) => {
        if (opcode !== WS_OP.TEXT) { toBrowser('error', { message: 'First message must be a JSON connect request' }); closeBrowser(); return; }

        let url, headers;
        try { ({ url, headers } = JSON.parse(payload.toString('utf8'))); }
        catch { toBrowser('error', { message: 'Invalid connect message' }); closeBrowser(); return; }

        connecting = true;
        wsConnectUpstream(url, headers).then(({ socket: upSock, rest }) => {
          upstream        = upSock;
          upstreamDecoder = new WsFrameDecoder();
          connecting      = false;
          toBrowser('open');
          if (rest.length) handleUpstreamData(rest);
          upSock.on('data', handleUpstreamData);
          upSock.on('close', () => { toBrowser('close'); closeBrowser(); });
          upSock.on('error', err => { toBrowser('error', { message: err.message }); closeBrowser(); });
        }).catch(err => {
          connecting = false;
          toBrowser('error', { message: err.message });
          closeBrowser();
        });
      });
      return;
    }

    browserAssemble(frame, (opcode, payload) => {
      upstream.write(encodeWsFrame(opcode, payload, true));
    });
  }

  const cleanup = () => { activeRelays.delete(cleanup); upstream?.end(); };
  activeRelays.add(cleanup);

  socket.on('data', chunk => {
    for (const frame of browserDecoder.push(chunk)) handleBrowserFrame(frame);
  });
  socket.on('close', cleanup);
  socket.on('error', cleanup);

  if (head && head.length) {
    for (const frame of browserDecoder.push(head)) handleBrowserFrame(frame);
  }
}

// ─── MCP stdio relay (/api/mcp-stdio) ──────────────────────────────────────────
// MCP servers using the stdio transport are local child processes, so the
// browser can't talk to them directly: the page opens a WebSocket to
// /api/mcp-stdio, sends one JSON "connect" control message
// ({ command, args, env, cwd }), and Salvo spawns that process. From then on,
// each WS text frame from the browser is written to the child's stdin as a
// line of JSON-RPC; each newline-delimited line on the child's stdout is
// wrapped as a JSON control message ({ type: 'message', data }) and sent to
// the browser. stderr lines are forwarded as { type: 'stderr', data } for
// debugging. { type: 'open' } is sent once the process spawns, and
// { type: 'close', code, signal } once it exits.
function handleMcpStdioUpgrade(socket, head, key) {
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${wsAcceptKey(key)}\r\n\r\n`
  );

  const toBrowser    = (type, extra) => socket.write(encodeWsFrame(WS_OP.TEXT, JSON.stringify({ type, ...extra }), false));
  const closeBrowser = payload => { socket.write(encodeWsFrame(WS_OP.CLOSE, payload || Buffer.alloc(0), false)); socket.end(); };

  let child      = null;
  let connecting = false;
  let stdoutBuf  = '';

  function forwardLines(buf, chunk, type) {
    buf += chunk.toString('utf8');
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      if (type === 'message') {
        let data;
        try { data = JSON.parse(line); } catch { data = line; }
        toBrowser('message', { data });
      } else {
        toBrowser('stderr', { data: line });
      }
    }
    return buf;
  }

  const browserAssemble = makeFragmentAssembler();
  const browserDecoder  = new WsFrameDecoder();

  function handleBrowserFrame(frame) {
    if (frame.opcode === WS_OP.PING) { socket.write(encodeWsFrame(WS_OP.PONG, frame.payload, false)); return; }
    if (frame.opcode === WS_OP.PONG) return;
    if (frame.opcode === WS_OP.CLOSE) {
      socket.write(encodeWsFrame(WS_OP.CLOSE, frame.payload, false));
      socket.end();
      child?.kill();
      return;
    }

    if (!child) {
      if (connecting) return;
      browserAssemble(frame, (opcode, payload) => {
        if (opcode !== WS_OP.TEXT) { toBrowser('error', { message: 'First message must be a JSON connect request' }); closeBrowser(); return; }

        let command, args, env, cwd;
        try {
          const msg = JSON.parse(payload.toString('utf8'));
          command = msg.command;
          args    = msg.args || [];
          env     = msg.env  || {};
          cwd     = msg.cwd  || undefined;
          if (typeof command !== 'string' || !command) throw new Error('"command" must be a non-empty string');
          if (!Array.isArray(args) || !args.every(a => typeof a === 'string')) throw new Error('"args" must be an array of strings');
        } catch (err) {
          toBrowser('error', { message: `Invalid connect message: ${err.message}` });
          closeBrowser();
          return;
        }

        connecting = true;
        try {
          child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
        } catch (err) {
          connecting = false;
          toBrowser('error', { message: err.message });
          closeBrowser();
          return;
        }

        let stderrBuf = '';

        child.on('spawn', () => { connecting = false; toBrowser('open'); });
        child.stdout.on('data', chunk => { stdoutBuf = forwardLines(stdoutBuf, chunk, 'message'); });
        child.stderr.on('data', chunk => { stderrBuf = forwardLines(stderrBuf, chunk, 'stderr'); });
        child.on('error', err => {
          connecting = false;
          toBrowser('error', { message: err.message });
          closeBrowser();
        });
        child.on('close', (code, signal) => {
          toBrowser('close', { code, signal });
          closeBrowser();
        });
      });
      return;
    }

    browserAssemble(frame, (opcode, payload) => {
      if (opcode !== WS_OP.TEXT) return;
      if (child.stdin.writable) child.stdin.write(payload.toString('utf8') + '\n');
    });
  }

  const cleanup = () => { activeRelays.delete(cleanup); child?.kill(); };
  activeRelays.add(cleanup);

  socket.on('data', chunk => {
    for (const frame of browserDecoder.push(chunk)) handleBrowserFrame(frame);
  });
  socket.on('close', cleanup);
  socket.on('error', cleanup);

  if (head && head.length) {
    for (const frame of browserDecoder.push(head)) handleBrowserFrame(frame);
  }
}

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

// ─── Graceful shutdown ──────────────────────────────────────────────────────────
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('INFO', `${signal} received, shutting down...`);
  await stopMockServer();
  for (const cleanup of activeRelays) cleanup();
  server.close(() => {
    log('INFO', 'Server closed');
    process.exit(0);
  });
  // Open WebSocket/MCP relay connections keep the server from closing on
  // their own — force exit shortly after if it's still up.
  setTimeout(() => process.exit(0), 1000).unref();
}

if (require.main === module) {
  server.listen(PORT, () => {
    log('INFO', `Salvo running at http://localhost:${PORT}`);
    for (const addr of lanAddresses()) log('INFO', `  also available at http://${addr}:${PORT}`);
  });
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

module.exports = {
  sanitizeName, uniqueName, buildColsFromFiles, walkDataDir, loadData, saveData, server,
  parseDigestChallenge, buildDigestHeader, normalizeEnvs, log,
  loadCookies, saveCookies, cookieMatches, parseSetCookie, updateJarCookie,
  buildFetchBody, attachJarCookies,
  findMockMatch, createMockServer, startMockServer, stopMockServer, mockStatus,
  getCliArg,
  wsAcceptKey, encodeWsFrame, WsFrameDecoder, wsConnectUpstream, WS_OP,
};
