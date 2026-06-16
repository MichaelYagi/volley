// ─── Method colours ───────────────────────────────────────────────────────────
const MC = {
  GET:     '#61affe',
  POST:    '#49cc90',
  PUT:     '#fca130',
  PATCH:   '#50e3c2',
  DELETE:  '#f93e3e',
  HEAD:    '#9012fe',
  OPTIONS: '#0d5aa7',
};

// ─── Global state ─────────────────────────────────────────────────────────────
const state = {
  // Loaded from data/ via /api/data — see loadData() in app.js
  cols:      [],
  envs:      [{ id: 'default', name: 'No Environment', vars: [] }],
  activeEnv: 'default',
  globals:   [],
  hist:      [],

  tabs:            [],     // open request tabs — see js/tabs.js
  activeTabId:     null,
  expandedCols:    new Set(),
  expandedFolders: new Set(),
  showHist:        false,
  showChanges:     false,
  snapshots:       new Map(), // req.id → cloned req at last save, for change tracking
  envSelId:        'default',
  selectedReqIds:  new Set(),
  lastSelReqId:    null,
  ctxOpenReqId:    null,   // id of the request row whose context menu is open, if any
  bulkEdit:        new Set(), // kv editor keys ('params'|'headers'|'formData'|'envVars'|'globalVars') currently in bulk-edit mode
  runner:          null,      // Collection Runner progress/results — see js/runner.js
};

// ─── Auto-sync working request back into state.cols, then auto-save to disk ───
let _autoSaveTimer = null;

function scheduleAutoSave() {
  const tab = activeTab();
  clearTimeout(_autoSaveTimer);
  _autoSaveTimer = setTimeout(() => {
    syncTabIntoCols(tab);
    scheduleDiskSave();
    if (typeof updateChangesBadge === 'function') updateChangesBadge();
  }, 500);
}

function syncTabIntoCols(tab) {
  if (!tab || !tab.reqId) return;
  const r = clone(tab.req);
  state.cols = state.cols.map(c => {
    const inRoot   = c.requests.some(x => x.id === r.id);
    const inFolder = c.folders.some(f => f.requests.some(x => x.id === r.id));
    if (!inRoot && !inFolder) return c;
    return {
      ...c,
      requests: c.requests.map(x => x.id === r.id ? r : x),
      folders:  c.folders.map(f => ({ ...f, requests: f.requests.map(x => x.id === r.id ? r : x) })),
    };
  });
}

function syncAllTabsIntoCols() {
  state.tabs.forEach(syncTabIntoCols);
}

// ─── Debounced disk save — fires after any change (button or keystroke) ───────
let _diskSaveTimer = null;

function scheduleDiskSave() {
  clearTimeout(_diskSaveTimer);
  _diskSaveTimer = setTimeout(() => saveAll(true), 800);
}

// ─── Utilities ────────────────────────────────────────────────────────────────
function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

// Has the user unchecked this auto-generated header (Authorization, Cookie, etc.)
// on the Headers tab's "Auto-generated" section? Checked by default.
function isAutoHeaderDisabled(req, key) {
  return (req.disabledAutoHeaders || []).some(k => k.toLowerCase() === key.toLowerCase());
}

/** Default shape for Request.auth — covers all supported auth types */
function defaultAuth() {
  return {
    type: 'none', token: '', username: '', password: '', apiKey: '', apiValue: '',
    accessTokenUrl: '', clientId: '', clientSecret: '', scope: '',
    cachedToken: '', cachedExpiry: 0, cachedRefreshToken: '',
    authorizationUrl: '', redirectUri: '', pkce: true,
    jwtSecret: '', jwtPayload: '{"sub":"user123"}',
  };
}

/** Default shape for Request.mock — a canned response served by the mock server */
function defaultMock() {
  return { enabled: false, status: 200, headers: [], body: '', delay: 0 };
}

/** Default shape for Request.body — covers all supported body types */
function defaultBody() {
  return { type: 'none', raw: '', formData: [], graphql: { query: '', variables: '' } };
}

/** Normalizes a raw request object (e.g. loaded from data/) into the full
 *  Request shape, filling in defaults for fields older saves may be missing. */
function normalizeReq(r) {
  const body = { ...defaultBody(), ...(r.body || {}) };
  body.graphql = { ...defaultBody().graphql, ...(body.graphql || {}) };

  return {
    id:      uid(),
    name:    r.name || 'Untitled',
    method:  (r.method || 'GET').toUpperCase(),
    url:     r.url || '',
    protocol: r.protocol || 'http',
    params:  r.params  || [],
    pathVars: r.pathVars || [],
    headers: r.headers || [],
    body,
    auth:    { ...defaultAuth(), ...(r.auth || {}) },
    preRequestScript: r.preRequestScript || '',
    testScript:       r.testScript || '',
    description: r.description || '',
    comments: r.comments || [],
    mock: { ...defaultMock(), ...(r.mock || {}) },
    examples: r.examples || [],
    disabledAutoHeaders: r.disabledAutoHeaders || [],
  };
}

/** Color for an HTTP status code: grey if absent (no response yet/network
 *  error), green for 2xx, orange for 3xx, red for 4xx/5xx. */
function statusColor(status) {
  return !status      ? '#8b949e'
       : status < 300 ? '#3fb950'
       : status < 400 ? '#fca130'
       :                '#f85149';
}

/** Stable fingerprint of a request's meaningful fields for change detection.
 *  Excludes ephemeral fields (id, cachedToken, cachedExpiry, comments, etc.). */
function reqFingerprint(r) {
  return JSON.stringify({
    name: r.name, method: r.method, url: r.url, protocol: r.protocol,
    params: r.params, pathVars: r.pathVars, headers: r.headers, body: r.body,
    auth: {
      type: r.auth.type, token: r.auth.token,
      username: r.auth.username, password: r.auth.password,
      apiKey: r.auth.apiKey, apiValue: r.auth.apiValue,
      accessTokenUrl: r.auth.accessTokenUrl, clientId: r.auth.clientId,
      clientSecret: r.auth.clientSecret, scope: r.auth.scope,
      authorizationUrl: r.auth.authorizationUrl, redirectUri: r.auth.redirectUri, pkce: r.auth.pkce,
      jwtSecret: r.auth.jwtSecret, jwtPayload: r.auth.jwtPayload,
    },
    preRequestScript: r.preRequestScript, testScript: r.testScript,
    mock: r.mock,
    description: r.description,
    examples: r.examples,
    disabledAutoHeaders: r.disabledAutoHeaders,
  });
}

/** Human-readable byte size, e.g. 1536 -> "1.5 KB" */
function formatBytes(n) {
  if (n == null) return '';
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

/** Extracts the path (with :pathVar segments preserved) from a request URL,
 *  e.g. "{{baseUrl}}/users/:id?x=1" or "https://api.example.com/users/:id"
 *  -> "/users/:id". Used to match requests to mock server routes. */
function extractMockPath(url) {
  let u = String(url || '').trim();
  u = u.replace(/^\{\{[^}]+\}\}/, '');
  const m = u.match(/^https?:\/\/[^/]+(\/.*)?$/i);
  if (m) u = m[1] || '/';
  else if (!u.startsWith('/')) u = '/' + u;
  return u.split('?')[0] || '/';
}

/** HTML-escape a value for safe innerHTML insertion */
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Interpolate {{variable}} placeholders — Collection Runner iteration data
 *  (state.runner.currentRow) takes priority, then the active environment,
 *  then globals. */
function interp(s) {
  if (!s) return s;
  const row  = state.runner?.currentRow;
  const vars = state.envs.find(e => e.id === state.activeEnv)?.vars ?? [];
  return s.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    if (row && Object.prototype.hasOwnProperty.call(row, k)) return String(row[k]);
    const envRow = vars.find(v => v.key === k && v.enabled);
    if (envRow) return envRow.value;
    const global = state.globals.find(v => v.key === k && v.enabled);
    return global ? global.value : `{{${k}}}`;
  });
}

/** Emit a toast notification (success | error | info) */
function notify(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `notif ${type}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

/**
 * Copy text to the clipboard. `navigator.clipboard` is only available in
 * secure contexts (HTTPS or localhost) — on a plain http:// LAN address
 * (e.g. accessing Salvo via another machine's IP) it's undefined, so fall
 * back to a hidden textarea + execCommand('copy').
 */
function copyText(text) {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity  = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
  } finally {
    ta.remove();
  }
  return Promise.resolve();
}
