// ─── Show / sync the request editor pane ─────────────────────────────────────

function showReqEditor() {
  document.getElementById('empty-state').style.display = 'none';
  document.getElementById('hist-panel').style.display  = 'none';
  document.getElementById('req-editor').style.display  = 'flex';
  state.showHist = false;
  document.getElementById('hist-toggle').textContent   = '⏱ History';
  renderTabStrip();
  syncReqEditor();
}

function showEmptyState() {
  document.getElementById('req-editor').style.display  = 'none';
  document.getElementById('hist-panel').style.display  = 'none';
  document.getElementById('empty-state').style.display = 'flex';
  renderTabStrip();
}

function syncReqEditor() {
  const tab = activeTab();
  if (!tab) return;
  const r  = tab.req;
  const ms = document.getElementById('method-select');
  ms.value       = r.method;
  ms.style.color = MC[r.method] || 'var(--text)';
  document.getElementById('url-input').value      = r.url;
  document.getElementById('req-name-input').value = r.name;
  document.getElementById('protocol-select').value = r.protocol || 'http';
  applyProtocolUI(r.protocol || 'http');
  syncPathVarsFromUrl();
  updateTabBadges();
  renderReqPanel();
  renderRespPanel();
  updateSendBtn();
}

// Shows/hides the method selector and swaps the URL field's placeholder
// based on the request's protocol (mcp-stdio uses the URL field as a
// command line, so the HTTP method is meaningless there).
function applyProtocolUI(protocol) {
  const ms  = document.getElementById('method-select');
  const url = document.getElementById('url-input');
  if (protocol === 'mcp-stdio') {
    ms.style.display = 'none';
    url.placeholder  = 'node mcp-server.js --flag {{var}}';
  } else {
    ms.style.display = '';
    url.placeholder  = 'https://api.example.com/endpoint {{var}}';
  }
}

// ─── Method / protocol / name change handlers (called from inline HTML events) ─

function onMethodChange() {
  const tab = activeTab();
  const v = document.getElementById('method-select').value;
  document.getElementById('method-select').style.color = MC[v] || 'var(--text)';
  tab.req.method = v;
  scheduleAutoSave();
  renderTabStrip();
  if (tab.reqTab === 'curl') renderReqPanel();

  const r = findReq(tab.reqId);
  if (r) { r.method = v; renderSidebar(); }
}

function onProtocolChange() {
  const tab = activeTab();
  const v = document.getElementById('protocol-select').value;
  tab.req.protocol = v;
  applyProtocolUI(v);
  scheduleAutoSave();
  renderReqPanel();
  updateSendBtn();
}

function onReqNameChange(v) {
  const tab = activeTab();
  tab.req.name = v;
  scheduleAutoSave();
  renderTabStrip();

  const r = findReq(tab.reqId);
  if (r) { r.name = v; renderSidebar(); }
}

// ─── Tab switching ────────────────────────────────────────────────────────────

function updateTabBadges() {
  const tab = activeTab();
  if (!tab) return;
  const pCount = tab.req.params.filter(p => p.enabled && p.key).length;
  const hCount = tab.req.headers.filter(h => h.enabled && h.key).length;

  document.querySelectorAll('#req-tabbar .tab').forEach(t => {
    const name = t.dataset.tab;
    t.classList.toggle('active', name === tab.reqTab);

    let label = name.charAt(0).toUpperCase() + name.slice(1);
    if (name === 'params'  && pCount > 0) label += `<span class="tab-badge">${pCount}</span>`;
    if (name === 'headers' && hCount > 0) label += `<span class="tab-badge">${hCount}</span>`;
    if (name === 'scripts' && (tab.req.preRequestScript || tab.req.testScript)) label += `<span class="tab-badge">●</span>`;
    if (name === 'docs'     && (tab.req.description || tab.req.comments.length)) label += `<span class="tab-badge">${tab.req.comments.length || '●'}</span>`;
    if (name === 'examples' && tab.req.examples.length) label += `<span class="tab-badge">${tab.req.examples.length}</span>`;
    if (name === 'mock'     && tab.req.mock.enabled) label += `<span class="tab-badge">●</span>`;
    t.innerHTML = label;
  });
}

function switchReqTab(tabName) {
  const tab = activeTab();
  if (!tab) return;
  tab.reqTab = tabName;
  updateTabBadges();
  renderReqPanel();
  scheduleDiskSave();
  if (tabName === 'curl') refreshMockServerStatus();
}

// ─── Request panel dispatcher ─────────────────────────────────────────────────

function renderReqPanel() {
  const el  = document.getElementById('req-panel');
  const tab = activeTab();
  if (!tab) return;

  switch (tab.reqTab) {
    case 'params':   el.innerHTML = kvEditorHTML(tab.req.params,  'params');  break;
    case 'headers':  el.innerHTML = kvEditorHTML(tab.req.headers, 'headers'); break;
    case 'auth':     el.innerHTML = authHTML(tab.req.auth);                   break;
    case 'body':     el.innerHTML = bodyHTML(tab.req.body);                   break;
    case 'curl':     el.innerHTML = curlPanelHTML();                          break;
    case 'scripts':  el.innerHTML = scriptsHTML(tab.req);                     break;
    case 'docs':     el.innerHTML = docsHTML(tab.req);                        break;
    case 'examples': el.innerHTML = examplesHTML(tab.req);                    break;
    case 'mock':     el.innerHTML = mockHTML(tab.req);                        break;
  }
}

// ─── Header name/value autocomplete ───────────────────────────────────────────
// Common header names, suggested for the "name" field of header rows.
const HEADER_NAME_SUGGESTIONS = [
  'Accept', 'Accept-Charset', 'Accept-Encoding', 'Accept-Language', 'Accept-Ranges',
  'Authorization', 'Cache-Control', 'Connection', 'Content-Disposition',
  'Content-Encoding', 'Content-Length', 'Content-Type', 'Cookie', 'DNT', 'Host',
  'If-Modified-Since', 'If-None-Match', 'Origin', 'Pragma', 'Referer', 'TE',
  'Transfer-Encoding', 'Upgrade-Insecure-Requests', 'User-Agent',
  'X-API-Key', 'X-Auth-Token', 'X-Correlation-ID', 'X-CSRF-Token',
  'X-Forwarded-For', 'X-Request-ID', 'X-Requested-With',
];

// Common values for headers whose value is a known set of tokens (MIME types,
// encodings, cache directives, ...). Keyed by lowercased header name.
const HEADER_VALUE_SUGGESTIONS = (() => {
  const mimeTypes = [
    'application/json',
    'application/xml',
    'application/x-www-form-urlencoded',
    'application/javascript',
    'application/octet-stream',
    'application/pdf',
    'application/zip',
    'application/graphql',
    'application/ld+json',
    'application/vnd.api+json',
    'application/xhtml+xml',
    'multipart/form-data',
    'multipart/mixed',
    'text/plain',
    'text/html',
    'text/css',
    'text/csv',
    'text/javascript',
    'text/xml',
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/svg+xml',
    'image/webp',
    'audio/mpeg',
    'video/mp4',
  ];

  return {
    'content-type':      mimeTypes,
    'accept':            ['*/*', ...mimeTypes],
    'accept-encoding':   ['gzip', 'deflate', 'br', 'compress', 'identity', '*'],
    'content-encoding':  ['gzip', 'deflate', 'br', 'compress', 'identity'],
    'transfer-encoding': ['chunked', 'gzip', 'deflate', 'identity'],
    'accept-charset':    ['utf-8', 'iso-8859-1', 'us-ascii', '*'],
    'accept-language':   ['en-US', 'en-GB', 'en', 'fr', 'de', 'es', 'it', 'pt-BR', 'pt', 'ru', 'zh-CN', 'zh-TW', 'ja', 'ko', 'nl', 'sv', 'pl', 'tr', 'ar', 'hi', '*'],
    'cache-control':     ['no-cache', 'no-store', 'no-transform', 'max-age=0', 'max-age=3600', 'max-age=86400', 'must-revalidate', 'proxy-revalidate', 'private', 'public', 'immutable', 'only-if-cached'],
    'connection':        ['keep-alive', 'close'],
    'content-disposition': ['inline', 'attachment', 'form-data'],
    'pragma':            ['no-cache'],
    'te':                ['trailers', 'compress', 'deflate', 'gzip'],
    'accept-ranges':     ['bytes', 'none'],
    'x-requested-with':  ['XMLHttpRequest'],
  };
})();

function getHeaderSuggestions(headerName) {
  return HEADER_VALUE_SUGGESTIONS[String(headerName ?? '').trim().toLowerCase()] || null;
}

// `field` is 'key' (header name) or 'value' (header value).
function showHeaderSuggest(i, field) {
  const row = activeTab().req.headers[i];
  const all = field === 'key' ? HEADER_NAME_SUGGESTIONS : getHeaderSuggestions(row.key);
  hideHeaderSuggest();
  if (!all) return;

  const q = (row[field] || '').toLowerCase();
  const matches = all.filter(v => v.toLowerCase().includes(q));
  if (!matches.length) return;

  const input = document.getElementById(`kv-${field}-headers-${i}`);
  const box   = document.getElementById('header-suggest');
  if (!input || !box) return;

  box.innerHTML = '';
  box.dataset.target = `${i}:${field}`;
  matches.forEach((m, idx) => {
    const el = document.createElement('div');
    el.className = 'hs-item' + (idx === 0 ? ' active' : '');
    el.textContent = m;
    // Hovering an item makes it the "active" one, so Tab fills whatever is highlighted.
    el.addEventListener('mouseenter', () => {
      box.querySelector('.hs-item.active')?.classList.remove('active');
      el.classList.add('active');
    });
    // mousedown (not click) fires before the input's blur, so we can accept
    // the suggestion without the dropdown disappearing first.
    el.addEventListener('mousedown', e => { e.preventDefault(); acceptHeaderSuggest(i, field, m); });
    box.appendChild(el);
  });

  const rect = input.getBoundingClientRect();
  box.style.display = '';
  box.style.left    = (rect.left + window.scrollX) + 'px';
  box.style.top     = (rect.bottom + window.scrollY) + 'px';
  box.style.width   = rect.width + 'px';
}

function hideHeaderSuggest() {
  const box = document.getElementById('header-suggest');
  if (box) box.style.display = 'none';
}

function acceptHeaderSuggest(i, field, value) {
  const tab = activeTab();
  tab.req.headers[i][field] = value;
  scheduleAutoSave();
  updateTabBadges();
  if (tab.reqTab === 'curl') renderReqPanel();

  const input = document.getElementById(`kv-${field}-headers-${i}`);
  if (input) {
    input.value = value;
    input.focus();
    input.setSelectionRange(value.length, value.length);
  }
  hideHeaderSuggest();

  // Picking a header name immediately surfaces value suggestions for it.
  if (field === 'key') {
    const valueInput = document.getElementById(`kv-value-headers-${i}`);
    if (valueInput) { valueInput.focus(); showHeaderSuggest(i, 'value'); }
  }
}

function kvHeaderKeydown(i, field, event) {
  const box = document.getElementById('header-suggest');
  if (!box || box.style.display === 'none' || box.dataset.target !== `${i}:${field}`) return;

  const items = [...box.querySelectorAll('.hs-item')];
  if (!items.length) return;

  if (event.key === 'Tab' || event.key === 'Enter') {
    event.preventDefault();
    const active = box.querySelector('.hs-item.active') || items[0];
    acceptHeaderSuggest(i, field, active.textContent);
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    let idx = items.findIndex(el => el.classList.contains('active'));
    items[idx]?.classList.remove('active');
    idx = event.key === 'ArrowDown' ? (idx + 1) % items.length : (idx - 1 + items.length) % items.length;
    items[idx].classList.add('active');
    items[idx].scrollIntoView({ block: 'nearest' });
  } else if (event.key === 'Escape') {
    hideHeaderSuggest();
  }
}

function kvHeaderBlur() {
  // Delay so a click/mousedown on a suggestion can be handled first.
  setTimeout(hideHeaderSuggest, 150);
}

// ─── {{variable}} Autocomplete ─────────────────────────────────────────────
// Suggests environment variables when the cursor sits inside an unclosed
// `{{...}}` in any field that's interpolated at send time (URL, params,
// headers, form-data, raw body, auth fields).

function getEnvVarNames() {
  const env = state.envs.find(e => e.id === state.activeEnv);
  const envNames    = (env?.vars || []).filter(v => v.enabled && v.key).map(v => v.key);
  const globalNames = state.globals.filter(v => v.enabled && v.key).map(v => v.key);
  return [...new Set([...envNames, ...globalNames])];
}

// If the cursor sits inside an unclosed `{{...}}`, return { start, prefix } —
// `start` is the index of the `{{`, `prefix` is the (identifier-only) text typed since.
function findVarContext(value, cursorPos) {
  const open = value.lastIndexOf('{{', cursorPos - 1);
  if (open === -1) return null;
  const between = value.slice(open + 2, cursorPos);
  if (!/^\w*$/.test(between)) return null;
  return { start: open, prefix: between };
}

function showVarSuggest(inputEl) {
  const ctx = findVarContext(inputEl.value, inputEl.selectionStart);
  if (!ctx) { hideVarSuggest(); return false; }

  const names = getEnvVarNames().filter(n => n.toLowerCase().includes(ctx.prefix.toLowerCase()));
  if (!names.length) { hideVarSuggest(); return false; }

  const box = document.getElementById('var-suggest');
  box.innerHTML = '';
  box._target = inputEl;
  box._ctx    = ctx;
  names.forEach((name, idx) => {
    const el = document.createElement('div');
    el.className = 'hs-item' + (idx === 0 ? ' active' : '');
    el.textContent = name;
    el.addEventListener('mouseenter', () => {
      box.querySelector('.hs-item.active')?.classList.remove('active');
      el.classList.add('active');
    });
    // mousedown (not click) fires before the input's blur, so we can accept
    // the suggestion without the dropdown disappearing first.
    el.addEventListener('mousedown', e => { e.preventDefault(); acceptVarSuggest(name); });
    box.appendChild(el);
  });

  const rect = inputEl.getBoundingClientRect();
  box.style.display = '';
  box.style.left    = (rect.left + window.scrollX) + 'px';
  box.style.top     = (rect.bottom + window.scrollY) + 'px';
  box.style.width   = Math.max(rect.width, 160) + 'px';

  hideHeaderSuggest();
  return true;
}

function hideVarSuggest() {
  const box = document.getElementById('var-suggest');
  if (box) box.style.display = 'none';
}

function acceptVarSuggest(name) {
  const box     = document.getElementById('var-suggest');
  const inputEl = box._target;
  const ctx     = box._ctx;
  if (!inputEl || !ctx) return;

  const value     = inputEl.value;
  const before    = value.slice(0, ctx.start);
  const after     = value.slice(ctx.start + 2 + ctx.prefix.length);
  const inserted  = `{{${name}}}`;
  inputEl.value   = before + inserted + after;
  const pos = (before + inserted).length;

  hideVarSuggest();
  inputEl.focus();
  inputEl.setSelectionRange(pos, pos);
  // Re-fire input so the field's own oninput handler syncs state/auto-saves.
  inputEl.dispatchEvent(new Event('input', { bubbles: true }));
}

// Returns true if the keypress was consumed (caller should not also act on it).
function varSuggestKeydown(inputEl, event) {
  const box = document.getElementById('var-suggest');
  if (!box || box.style.display === 'none' || box._target !== inputEl) return false;

  const items = [...box.querySelectorAll('.hs-item')];
  if (!items.length) return false;

  if (event.key === 'Tab' || event.key === 'Enter') {
    event.preventDefault();
    const active = box.querySelector('.hs-item.active') || items[0];
    acceptVarSuggest(active.textContent);
    return true;
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    let idx = items.findIndex(el => el.classList.contains('active'));
    items[idx]?.classList.remove('active');
    idx = event.key === 'ArrowDown' ? (idx + 1) % items.length : (idx - 1 + items.length) % items.length;
    items[idx].classList.add('active');
    items[idx].scrollIntoView({ block: 'nearest' });
    return true;
  }
  if (event.key === 'Escape') {
    hideVarSuggest();
    return true;
  }
  return false;
}

function varSuggestBlur() {
  // Delay so a click/mousedown on a suggestion can be handled first.
  setTimeout(hideVarSuggest, 150);
}

// ─── URL <-> Params sync ───────────────────────────────────────────────────────
// Keeps the URL bar's query string and the Params table in sync, like Postman.

function splitUrlQuery(url) {
  const i = url.indexOf('?');
  return i === -1 ? { base: url, query: '' } : { base: url.slice(0, i), query: url.slice(i + 1) };
}

function parseQueryString(query) {
  if (!query) return [];
  return query.split('&').map(pair => {
    const i = pair.indexOf('=');
    return i === -1 ? { key: pair, value: '' } : { key: pair.slice(0, i), value: pair.slice(i + 1) };
  });
}

// Rebuild req.params from the URL's query string after the user edits the URL bar,
// preserving notes/ids of rows whose key is unchanged and keeping disabled/blank rows.
function syncParamsFromUrl() {
  const req     = activeTab().req;
  const parsed  = parseQueryString(splitUrlQuery(req.url).query);
  const used    = new Set();

  const newParams = parsed.map(p => {
    const idx = req.params.findIndex((op, i) => !used.has(i) && op.key === p.key);
    if (idx !== -1) {
      used.add(idx);
      return { ...req.params[idx], value: p.value, enabled: true };
    }
    return { id: uid(), key: p.key, value: p.value, enabled: true, note: '' };
  });

  const leftover = req.params.filter((op, i) => !used.has(i) && (!op.enabled || !op.key));
  req.params = [...newParams, ...leftover];
}

// Rebuild the URL's query string from req.params after the user edits the Params table.
function syncUrlFromParams() {
  const req   = activeTab().req;
  const base  = splitUrlQuery(req.url).base;
  const query = req.params.filter(p => p.enabled && p.key).map(p => `${p.key}=${p.value}`).join('&');

  req.url = query ? `${base}?${query}` : base;
  const urlInput = document.getElementById('url-input');
  if (urlInput) urlInput.value = req.url;
}

// ─── Path Variables ────────────────────────────────────────────────────────────
// Keeps req.pathVars in sync with `:name` segments in the URL's path, like Postman.
// Variable names come from the URL; only the values are user-editable.

function parsePathVarNames(url) {
  const base    = splitUrlQuery(url).base;
  const matches = base.match(/:([A-Za-z_][A-Za-z0-9_]*)/g) || [];
  return matches.map(m => m.slice(1));
}

// Rebuild req.pathVars from the URL's `:name` segments after the user edits the URL bar,
// preserving values for names that still appear and dropping ones that don't.
function syncPathVarsFromUrl() {
  const req   = activeTab().req;
  const names = parsePathVarNames(req.url);
  const used  = new Set();

  req.pathVars = names.map(name => {
    const idx = req.pathVars.findIndex((pv, i) => !used.has(i) && pv.key === name);
    if (idx !== -1) { used.add(idx); return req.pathVars[idx]; }
    return { id: uid(), key: name, value: '' };
  });
}

// Substitute `:name` segments in a URL with their (interpolated) path-variable values.
function substitutePathVars(url, pathVars) {
  let result = url;
  (pathVars || []).forEach(pv => {
    result = result.replace(new RegExp(`:${pv.key}\\b`, 'g'), interp(pv.value));
  });
  return result;
}

function pathVarSet(i, value) {
  activeTab().req.pathVars[i].value = value;
  scheduleAutoSave();
  if (activeTab().reqTab === 'curl') renderReqPanel();
}

// ─── Auth/Body -> computed headers preview ────────────────────────────────────
// Mirrors the headers send.js's buildRequestArgs() adds on top of req.headers,
// shown read-only on the Headers tab (Postman calls these "auto-generated").

function computedAuthHeaders(auth) {
  switch (auth.type) {
    case 'bearer':
      return auth.token ? [{ key: 'Authorization', value: `Bearer ${interp(auth.token)}` }] : [];
    case 'basic':
      return (auth.username || auth.password)
        ? [{ key: 'Authorization', value: `Basic ${btoa(`${interp(auth.username)}:${interp(auth.password)}`)}` }]
        : [];
    case 'apikey':
      return auth.apiKey ? [{ key: interp(auth.apiKey), value: interp(auth.apiValue) }] : [];
    case 'oauth2_cc':
    case 'oauth2_pwd':
      return [{ key: 'Authorization', value: `Bearer ${auth.cachedToken || '<fetched automatically when sent>'}` }];
    case 'oauth2_auth_code':
      return [{ key: 'Authorization', value: `Bearer ${auth.cachedToken || '<sign in via "Get Access Token">'}` }];
    case 'jwt':
      return auth.jwtSecret ? [{ key: 'Authorization', value: 'Bearer <generated automatically when sent>' }] : [];
    default:
      return [];
  }
}

// Content-Type Body adds when the user hasn't set one explicitly.
function computedBodyHeaders(req) {
  const hasContentType = req.headers.some(h => h.enabled && h.key.toLowerCase() === 'content-type');
  if (hasContentType) return [];

  const b = req.body;
  if (b.type === 'formdata') return [{ key: 'Content-Type', value: 'multipart/form-data; boundary=...' }];
  if (b.type === 'graphql')  return [{ key: 'Content-Type', value: 'application/json' }];
  return [];
}

// Mirrors server.js's cookieMatches() — does a jar cookie apply to this request's URL?
function cookieMatchesClient(cookie, urlObj) {
  if (cookie.expires && Date.now() > cookie.expires) return false;
  if (cookie.secure && urlObj.protocol !== 'https:') return false;

  const host = urlObj.hostname;
  if (host !== cookie.domain && !host.endsWith('.' + cookie.domain)) return false;

  const reqPath = urlObj.pathname || '/';
  const cPath   = cookie.path || '/';
  if (reqPath !== cPath && !reqPath.startsWith(cPath.endsWith('/') ? cPath : cPath + '/')) return false;

  return true;
}

// Cookie header the server will append from the cookie jar (data/_salvo/cookies.json)
// for this request's domain/path — see _cookieJar in js/modals.js.
function computedCookieHeader(req) {
  if (!_cookieJar.length) return [];

  let raw = interp(req.url);
  raw = substitutePathVars(raw, req.pathVars);
  if (!raw.match(/^https?:\/\//i)) raw = 'https://' + raw;

  let urlObj;
  try { urlObj = new URL(raw); } catch { return []; }

  const matched = _cookieJar.filter(c => cookieMatchesClient(c, urlObj));
  if (!matched.length) return [];

  const value = matched.map(c => `${c.name}=${c.value}`).join('; ');
  return [{ key: 'Cookie', value, source: 'Cookie Jar' }];
}

function computedHeaders(req) {
  return [
    ...computedAuthHeaders(req.auth).map(h => ({ ...h, source: 'Auth tab' })),
    ...computedBodyHeaders(req).map(h => ({ ...h, source: 'Body tab' })),
    ...computedCookieHeader(req),
  ];
}

// ─── KV Editor (params / headers / form-data fields) ─────────────────────────

function kvEditorHTML(rows, key) {
  const hasNotes = key === 'params' || key === 'headers';
  const authHeaderKeys = key === 'headers'
    ? new Set(computedAuthHeaders(activeTab().req.auth).map(h => h.key.toLowerCase()))
    : null;
  let html = '';

  const bulkMode = state.bulkEdit.has(key);
  html += `<div class="kv-bulk-bar">
    <button class="kv-bulk-toggle" onclick="toggleBulkEdit('${key}')">${bulkMode ? 'Form Edit' : 'Bulk Edit'}</button>
  </div>`;

  if (bulkMode) {
    html += `<textarea class="kv-bulk-textarea"
        placeholder="name: value&#10;// disabledName: value"
        oninput="applyBulkEdit('${key}',this.value)">${esc(kvRowsToBulkText(rows))}</textarea>`;
    return html + kvComputedSectionsHTML(key);
  }

  const isFormData = key === 'formData';

  rows.forEach((row, i) => {
    const op = row.enabled ? 1 : .45;
    const conflict = authHeaderKeys && row.enabled && row.key && authHeaderKeys.has(row.key.toLowerCase());
    const suggestAttrs = field => key === 'headers'
      ? `id="kv-${field}-headers-${i}"
               onfocus="showHeaderSuggest(${i},'${field}')"
               onkeydown="if(!varSuggestKeydown(this,event))kvHeaderKeydown(${i},'${field}',event)"
               onblur="kvHeaderBlur();varSuggestBlur()"
               autocomplete="off"`
      : `onkeydown="varSuggestKeydown(this,event)"
               onblur="varSuggestBlur()"`;
    const varInput = field => key === 'headers'
      ? `if(!showVarSuggest(this))showHeaderSuggest(${i},'${field}')`
      : `showVarSuggest(this)`;

    if (isFormData) {
      const isFile = row.type === 'file';
      html += `
        <div class="kv-grid-formdata${conflict ? ' kv-conflict' : ''}"
             ondragover="kvRowDragOver(event,'${key}',${i})" ondragleave="kvRowDragLeave(event)"
             ondrop="kvRowDrop(event,'${key}',${i})">
          <span class="kv-drag-handle" draggable="true" ondragstart="kvDragStart(event,'${key}',${i})" ondragend="kvDragEnd(event)">&#8942;&#8942;</span>
          <input type="checkbox" ${row.enabled ? 'checked' : ''} onchange="kvToggle('${key}',${i},this.checked)">
          <input value="${esc(row.key)}"
                 onkeydown="varSuggestKeydown(this,event)" onblur="varSuggestBlur()"
                 oninput="kvSet('${key}',${i},'key',this.value);showVarSuggest(this)"
                 placeholder="name"
                 style="opacity:${op}">
          <select onchange="kvFormDataTypeChange(${i},this.value)" style="opacity:${op}">
            <option value="text" ${!isFile ? 'selected' : ''}>Text</option>
            <option value="file" ${isFile ? 'selected' : ''}>File</option>
          </select>
          ${isFile
            ? `<div class="kv-file-cell" style="opacity:${op}">
                 <input type="file" id="kv-formdata-file-${i}" style="display:none" onchange="kvFormDataFile(${i},this)">
                 <button type="button" class="kv-file-btn" onclick="document.getElementById('kv-formdata-file-${i}').click()">Choose File</button>
                 <span class="kv-file-name">${row.fileName ? esc(row.fileName) + (row.fileSize != null ? ` (${formatBytes(row.fileSize)})` : '') : 'No file selected'}</span>
               </div>`
            : `<input value="${esc(row.value)}"
                 onkeydown="varSuggestKeydown(this,event)" onblur="varSuggestBlur()"
                 oninput="kvSet('${key}',${i},'value',this.value);showVarSuggest(this)"
                 placeholder="value"
                 style="opacity:${op}">`}
          <button class="kv-del" onclick="kvDel('${key}',${i})">×</button>
        </div>`;
      return;
    }

    html += `
      <div class="${hasNotes ? 'kv-grid-notes' : 'kv-grid'}${conflict ? ' kv-conflict' : ''}"
           ${conflict ? `title="This header will be overridden by the Auth tab's ${esc(row.key)} value when the request is sent"` : ''}
           ondragover="kvRowDragOver(event,'${key}',${i})" ondragleave="kvRowDragLeave(event)"
           ondrop="kvRowDrop(event,'${key}',${i})">
        <span class="kv-drag-handle" draggable="true" ondragstart="kvDragStart(event,'${key}',${i})" ondragend="kvDragEnd(event)">&#8942;&#8942;</span>
        <input type="checkbox" ${row.enabled ? 'checked' : ''} onchange="kvToggle('${key}',${i},this.checked)">
        <input value="${esc(row.key)}"
               ${suggestAttrs('key')}
               oninput="kvSet('${key}',${i},'key',this.value);${varInput('key')}"
               placeholder="name"
               style="opacity:${op}">
        <input value="${esc(row.value)}"
               ${suggestAttrs('value')}
               oninput="kvSet('${key}',${i},'value',this.value);${varInput('value')}"
               placeholder="value"
               style="opacity:${op}">
        ${hasNotes ? `<input value="${esc(row.note || '')}"
               oninput="kvSet('${key}',${i},'note',this.value)"
               placeholder="note"
               class="kv-note"
               style="opacity:${op}">` : ''}
        <button class="kv-del" onclick="kvDel('${key}',${i})">×</button>
      </div>`;
  });

  const addLabel = key === 'params' ? 'query param' : (key === 'headers' || key === 'mockHeaders') ? 'header' : key === 'envVars' || key === 'globalVars' ? 'variable' : 'field';
  html += `<button class="kv-add" onclick="kvAdd('${key}')">+ Add ${addLabel}</button>`;

  return html + kvComputedSectionsHTML(key);
}

// Renders the read-only "Path Variables" (params) and "Auto-generated" (headers)
// sections, shared between the row editor and bulk-edit textarea views.
function kvComputedSectionsHTML(key) {
  let html = '';

  if (key === 'params') {
    const pathVars = activeTab().req.pathVars;
    if (pathVars.length) {
      html += `<div class="kv-computed-label">Path Variables</div>`;
      pathVars.forEach((pv, i) => {
        html += `
          <div class="kv-grid-notes">
            <span></span>
            <span></span>
            <input value="${esc(pv.key)}" disabled>
            <input value="${esc(pv.value)}" oninput="pathVarSet(${i},this.value)" placeholder="value">
            <span></span>
            <span></span>
          </div>`;
      });
    }
  }

  if (key === 'headers') {
    const req = activeTab().req;
    const computed = computedHeaders(req);
    if (computed.length) {
      html += `<div class="kv-computed-label">Auto-generated</div>`;
      computed.forEach(h => {
        const enabled = !isAutoHeaderDisabled(req, h.key);
        const op = enabled ? 1 : .45;
        html += `
          <div class="kv-grid-notes kv-computed">
            <span></span>
            <input type="checkbox" ${enabled ? 'checked' : ''} onchange="toggleAutoHeader('${esc(h.key)}',this.checked)">
            <input value="${esc(h.key)}" disabled style="opacity:${op}">
            <input value="${esc(h.value)}" disabled style="opacity:${op}">
            <input value="" disabled class="kv-note" placeholder="${esc(h.source)}" style="opacity:${op}">
            <span></span>
          </div>`;
      });
    }
  }

  return html;
}

function getKvTarget(key) {
  if (key === 'envVars')    return getSelEnv()?.vars;
  if (key === 'globalVars') return state.globals;
  const r = activeTab().req;
  if (key === 'params')      return r.params;
  if (key === 'headers')     return r.headers;
  if (key === 'formData')    return r.body.formData;
  if (key === 'mockHeaders') return r.mock.headers;
}

// Toggling an "Auto-generated" header's checkbox records its key in
// req.disabledAutoHeaders so send.js can skip adding it. Checked (enabled) by default.
function toggleAutoHeader(key, enabled) {
  const req = activeTab().req;
  const disabled = new Set((req.disabledAutoHeaders || []).map(k => k.toLowerCase()));
  if (enabled) disabled.delete(key.toLowerCase());
  else disabled.add(key.toLowerCase());
  req.disabledAutoHeaders = [...disabled];
  scheduleAutoSave(); updateTabBadges();
  renderReqPanel();
}

function kvToggle(key, i, v) {
  getKvTarget(key)[i].enabled = v;
  if (key === 'envVars' || key === 'globalVars') return scheduleDiskSave();
  if (key === 'params') syncUrlFromParams();
  scheduleAutoSave(); updateTabBadges();
  if (activeTab().reqTab === 'curl') renderReqPanel();
}
function kvSet(key, i, field, v) {
  getKvTarget(key)[i][field] = v;
  if (key === 'envVars' || key === 'globalVars') return scheduleDiskSave();
  if (key === 'params' && (field === 'key' || field === 'value')) syncUrlFromParams();
  scheduleAutoSave(); updateTabBadges();
  if (activeTab().reqTab === 'curl') renderReqPanel();
}
function kvDel(key, i) {
  getKvTarget(key).splice(i, 1);
  if (key === 'envVars' || key === 'globalVars') { scheduleDiskSave(); renderEnvDetail(); return; }
  if (key === 'params') syncUrlFromParams();
  scheduleAutoSave(); updateTabBadges(); renderReqPanel();
}
// ─── KV Row Drag & Drop Reordering ────────────────────────────────────────────
let _kvDragKey   = null;
let _kvDragIndex = null;

function kvDragStart(event, key, i) {
  _kvDragKey   = key;
  _kvDragIndex = i;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', String(i));
}

function kvDragEnd() {
  _kvDragKey   = null;
  _kvDragIndex = null;
  document.querySelectorAll('.kv-grid.drag-over-top, .kv-grid.drag-over-bottom, .kv-grid-notes.drag-over-top, .kv-grid-notes.drag-over-bottom, .kv-grid-formdata.drag-over-top, .kv-grid-formdata.drag-over-bottom')
    .forEach(el => el.classList.remove('drag-over-top', 'drag-over-bottom'));
}

function kvRowDragOver(event, key, i) {
  if (_kvDragKey !== key || _kvDragIndex === i) return;
  event.preventDefault();
  event.stopPropagation();
  event.dataTransfer.dropEffect = 'move';
  const el     = event.currentTarget;
  const before = (event.clientY - el.getBoundingClientRect().top) < el.offsetHeight / 2;
  el.classList.toggle('drag-over-top', before);
  el.classList.toggle('drag-over-bottom', !before);
}

function kvRowDragLeave(event) {
  event.currentTarget.classList.remove('drag-over-top', 'drag-over-bottom');
}

function kvRowDrop(event, key, i) {
  if (_kvDragKey !== key || _kvDragIndex === i) return;
  event.preventDefault();
  event.stopPropagation();
  const el     = event.currentTarget;
  const before = el.classList.contains('drag-over-top');
  el.classList.remove('drag-over-top', 'drag-over-bottom');

  let to = before ? i : i + 1;
  if (_kvDragIndex < to) to--;
  kvReorder(key, _kvDragIndex, to);
}

function kvReorder(key, from, to) {
  if (from === to) return;
  const rows = getKvTarget(key);
  const [item] = rows.splice(from, 1);
  rows.splice(to, 0, item);
  if (key === 'envVars' || key === 'globalVars') { scheduleDiskSave(); renderEnvDetail(); return; }
  if (key === 'params') syncUrlFromParams();
  scheduleAutoSave(); updateTabBadges(); renderReqPanel();
}

function kvAdd(key) {
  const row = { id: uid(), key: '', value: '', enabled: true };
  if (key === 'formData') row.type = 'text';
  getKvTarget(key).push(row);
  if (key === 'envVars' || key === 'globalVars') { scheduleDiskSave(); renderEnvDetail(); return; }
  scheduleAutoSave(); renderReqPanel();
}

// Switches a form-data row between a plain text value and a file upload.
function kvFormDataTypeChange(i, type) {
  const row = activeTab().req.body.formData[i];
  row.type = type;
  if (type === 'file') {
    row.value = '';
  } else {
    row.fileName = ''; row.fileData = ''; row.fileSize = null; row.fileMimeType = '';
  }
  scheduleAutoSave(); renderReqPanel();
}

// Reads the chosen file as base64 and stashes it on the form-data row.
function kvFormDataFile(i, input) {
  const file = input.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const row = activeTab().req.body.formData[i];
    row.fileName     = file.name;
    row.fileSize     = file.size;
    row.fileMimeType = file.type || 'application/octet-stream';
    row.fileData     = String(reader.result).split(',')[1] || '';
    scheduleAutoSave(); renderReqPanel();
  };
  reader.readAsDataURL(file);
}

// ─── Bulk Edit ─────────────────────────────────────────────────────────────────
// Toggles a kv editor between its row-based form and a `key: value` textarea
// (one per line, `// ` prefix = disabled). Switching back to form mode just
// re-renders from the already-applied rows.

function toggleBulkEdit(key) {
  if (state.bulkEdit.has(key)) state.bulkEdit.delete(key);
  else state.bulkEdit.add(key);
  if (key === 'envVars' || key === 'globalVars') renderEnvDetail();
  else renderReqPanel();
}

function kvRowsToBulkText(rows) {
  return rows.map(r => `${r.enabled ? '' : '// '}${r.key}: ${r.value}`).join('\n');
}

function bulkTextToRows(text, oldRows) {
  return text.split('\n').map(line => {
    let l = line;
    let enabled = true;
    const commented = l.match(/^\s*\/\/\s?(.*)$/);
    if (commented) { enabled = false; l = commented[1]; }
    const idx = l.indexOf(':');
    const key   = (idx === -1 ? l : l.slice(0, idx)).trim();
    const value = (idx === -1 ? '' : l.slice(idx + 1)).trim();
    if (!key) return null;
    const old = oldRows.find(r => r.key === key);
    return { id: old?.id ?? uid(), key, value, enabled, note: old?.note ?? '' };
  }).filter(Boolean);
}

function applyBulkEdit(key, text) {
  const target = getKvTarget(key);
  const rows = bulkTextToRows(text, target);
  target.length = 0;
  target.push(...rows);
  if (key === 'envVars' || key === 'globalVars') return scheduleDiskSave();
  if (key === 'params') syncUrlFromParams();
  scheduleAutoSave(); updateTabBadges();
}

// ─── Auth Editor ──────────────────────────────────────────────────────────────

const AUTH_LABEL_STYLE = 'display:block;color:var(--text-muted);font-size:11px;margin-bottom:4px';

function authHTML(a) {
  let html = `
    <div class="auth-row">
      <select onchange="authTypeChange(this.value)">
        <option value="none"      ${a.type === 'none'      ? 'selected' : ''}>No Auth</option>
        <option value="bearer"    ${a.type === 'bearer'    ? 'selected' : ''}>Bearer Token</option>
        <option value="basic"     ${a.type === 'basic'     ? 'selected' : ''}>Basic Auth</option>
        <option value="apikey"    ${a.type === 'apikey'    ? 'selected' : ''}>API Key</option>
        <option value="oauth2_cc" ${a.type === 'oauth2_cc' ? 'selected' : ''}>OAuth 2.0 - Client Credentials</option>
        <option value="oauth2_pwd" ${a.type === 'oauth2_pwd' ? 'selected' : ''}>OAuth 2.0 - Password Grant</option>
        <option value="oauth2_auth_code" ${a.type === 'oauth2_auth_code' ? 'selected' : ''}>OAuth 2.0 - Authorization Code</option>
        <option value="digest"    ${a.type === 'digest'    ? 'selected' : ''}>Digest Auth</option>
        <option value="jwt"       ${a.type === 'jwt'       ? 'selected' : ''}>JWT Bearer (HS256)</option>
      </select>
    </div>`;

  if (a.type === 'bearer') {
    html += `
      <label style="${AUTH_LABEL_STYLE}">Token</label>
      <input value="${esc(a.token)}" oninput="authSet('token',this.value);showVarSuggest(this)"
             onkeydown="varSuggestKeydown(this,event)" onblur="varSuggestBlur()"
             placeholder="Bearer token…" style="width:100%;font-family:monospace">`;
  }

  if (a.type === 'basic') {
    html += `
      <div class="two-col">
        <div>
          <label style="${AUTH_LABEL_STYLE}">Username</label>
          <input value="${esc(a.username)}" oninput="authSet('username',this.value);showVarSuggest(this)"
                 onkeydown="varSuggestKeydown(this,event)" onblur="varSuggestBlur()" style="width:100%">
        </div>
        <div>
          <label style="${AUTH_LABEL_STYLE}">Password</label>
          <input type="password" value="${esc(a.password)}" oninput="authSet('password',this.value);showVarSuggest(this)"
                 onkeydown="varSuggestKeydown(this,event)" onblur="varSuggestBlur()" style="width:100%">
        </div>
      </div>`;
  }

  if (a.type === 'apikey') {
    html += `
      <div class="two-col">
        <div>
          <label style="${AUTH_LABEL_STYLE}">Header Name</label>
          <input value="${esc(a.apiKey)}" oninput="authSet('apiKey',this.value);showVarSuggest(this)"
                 onkeydown="varSuggestKeydown(this,event)" onblur="varSuggestBlur()"
                 placeholder="X-API-Key" style="width:100%;font-family:monospace">
        </div>
        <div>
          <label style="${AUTH_LABEL_STYLE}">Value</label>
          <input value="${esc(a.apiValue)}" oninput="authSet('apiValue',this.value);showVarSuggest(this)"
                 onkeydown="varSuggestKeydown(this,event)" onblur="varSuggestBlur()"
                 style="width:100%;font-family:monospace">
        </div>
      </div>`;
  }

  if (a.type === 'oauth2_cc' || a.type === 'oauth2_pwd') {
    html += `
      <label style="${AUTH_LABEL_STYLE}">Access Token URL</label>
      <input value="${esc(a.accessTokenUrl)}" oninput="authSet('accessTokenUrl',this.value);showVarSuggest(this)"
             onkeydown="varSuggestKeydown(this,event)" onblur="varSuggestBlur()"
             placeholder="https://auth.example.com/oauth/token" style="width:100%;font-family:monospace;margin-bottom:8px">
      <div class="two-col">
        <div>
          <label style="${AUTH_LABEL_STYLE}">Client ID</label>
          <input value="${esc(a.clientId)}" oninput="authSet('clientId',this.value);showVarSuggest(this)"
                 onkeydown="varSuggestKeydown(this,event)" onblur="varSuggestBlur()" style="width:100%">
        </div>
        <div>
          <label style="${AUTH_LABEL_STYLE}">Client Secret</label>
          <input type="password" value="${esc(a.clientSecret)}" oninput="authSet('clientSecret',this.value);showVarSuggest(this)"
                 onkeydown="varSuggestKeydown(this,event)" onblur="varSuggestBlur()" style="width:100%">
        </div>
      </div>`;

    if (a.type === 'oauth2_pwd') {
      html += `
      <div class="two-col">
        <div>
          <label style="${AUTH_LABEL_STYLE}">Username</label>
          <input value="${esc(a.username)}" oninput="authSet('username',this.value);showVarSuggest(this)"
                 onkeydown="varSuggestKeydown(this,event)" onblur="varSuggestBlur()" style="width:100%">
        </div>
        <div>
          <label style="${AUTH_LABEL_STYLE}">Password</label>
          <input type="password" value="${esc(a.password)}" oninput="authSet('password',this.value);showVarSuggest(this)"
                 onkeydown="varSuggestKeydown(this,event)" onblur="varSuggestBlur()" style="width:100%">
        </div>
      </div>`;
    }

    html += `
      <label style="${AUTH_LABEL_STYLE}">Scope (optional)</label>
      <input value="${esc(a.scope)}" oninput="authSet('scope',this.value);showVarSuggest(this)"
             onkeydown="varSuggestKeydown(this,event)" onblur="varSuggestBlur()" style="width:100%;font-family:monospace;margin-bottom:8px">
      <div style="display:flex;align-items:center;gap:10px;margin-top:8px">
        <button class="btn-primary" onclick="manualFetchOAuthToken()">Get Access Token</button>
        <span style="font-size:11px;color:var(--text-muted)">${
          a.cachedToken
            ? `Token cached, expires ${new Date(a.cachedExpiry).toLocaleTimeString()}`
            : 'No token yet — fetched automatically on Send'
        }</span>
      </div>`;
  }

  if (a.type === 'oauth2_auth_code') {
    const defaultRedirect = `${location.origin}/api/oauth/callback`;
    html += `
      <label style="${AUTH_LABEL_STYLE}">Authorization URL</label>
      <input value="${esc(a.authorizationUrl)}" oninput="authSet('authorizationUrl',this.value);showVarSuggest(this)"
             onkeydown="varSuggestKeydown(this,event)" onblur="varSuggestBlur()"
             placeholder="https://auth.example.com/oauth/authorize" style="width:100%;font-family:monospace;margin-bottom:8px">
      <label style="${AUTH_LABEL_STYLE}">Access Token URL</label>
      <input value="${esc(a.accessTokenUrl)}" oninput="authSet('accessTokenUrl',this.value);showVarSuggest(this)"
             onkeydown="varSuggestKeydown(this,event)" onblur="varSuggestBlur()"
             placeholder="https://auth.example.com/oauth/token" style="width:100%;font-family:monospace;margin-bottom:8px">
      <label style="${AUTH_LABEL_STYLE}">Redirect URI</label>
      <input value="${esc(a.redirectUri)}" oninput="authSet('redirectUri',this.value);showVarSuggest(this)"
             onkeydown="varSuggestKeydown(this,event)" onblur="varSuggestBlur()"
             placeholder="${esc(defaultRedirect)}" style="width:100%;font-family:monospace;margin-bottom:8px">
      <p class="muted">Register <code>${esc(defaultRedirect)}</code> as an allowed redirect URI with your OAuth provider, or set a custom one above (e.g. if Salvo runs on a different port).</p>
      <div class="two-col">
        <div>
          <label style="${AUTH_LABEL_STYLE}">Client ID</label>
          <input value="${esc(a.clientId)}" oninput="authSet('clientId',this.value);showVarSuggest(this)"
                 onkeydown="varSuggestKeydown(this,event)" onblur="varSuggestBlur()" style="width:100%">
        </div>
        <div>
          <label style="${AUTH_LABEL_STYLE}">Client Secret (optional with PKCE)</label>
          <input type="password" value="${esc(a.clientSecret)}" oninput="authSet('clientSecret',this.value);showVarSuggest(this)"
                 onkeydown="varSuggestKeydown(this,event)" onblur="varSuggestBlur()" style="width:100%">
        </div>
      </div>
      <label style="${AUTH_LABEL_STYLE}">Scope (optional)</label>
      <input value="${esc(a.scope)}" oninput="authSet('scope',this.value);showVarSuggest(this)"
             onkeydown="varSuggestKeydown(this,event)" onblur="varSuggestBlur()" style="width:100%;font-family:monospace;margin-bottom:8px">
      <label style="display:flex;align-items:center;gap:6px;color:var(--text);font-size:13px;margin-bottom:8px">
        <input type="checkbox" ${a.pkce ? 'checked' : ''} onchange="authSet('pkce',this.checked)">
        Use PKCE (recommended)
      </label>
      <div style="display:flex;align-items:center;gap:10px;margin-top:8px">
        <button class="btn-primary" onclick="manualFetchOAuthToken()">Get Access Token</button>
        <span style="font-size:11px;color:var(--text-muted)">${
          a.cachedToken
            ? `Token cached, expires ${new Date(a.cachedExpiry).toLocaleTimeString()}`
            : 'Not signed in — opens a popup to log in and authorize'
        }</span>
      </div>
      <p class="muted">Opens a popup to the Authorization URL. After you log in and approve access, the provider redirects back to the Redirect URI, which exchanges the resulting code for an access token (and refresh token, if the provider returns one).</p>`;
  }

  if (a.type === 'digest') {
    html += `
      <div class="two-col">
        <div>
          <label style="${AUTH_LABEL_STYLE}">Username</label>
          <input value="${esc(a.username)}" oninput="authSet('username',this.value);showVarSuggest(this)"
                 onkeydown="varSuggestKeydown(this,event)" onblur="varSuggestBlur()" style="width:100%">
        </div>
        <div>
          <label style="${AUTH_LABEL_STYLE}">Password</label>
          <input type="password" value="${esc(a.password)}" oninput="authSet('password',this.value);showVarSuggest(this)"
                 onkeydown="varSuggestKeydown(this,event)" onblur="varSuggestBlur()" style="width:100%">
        </div>
      </div>
      <p class="muted">Salvo automatically responds to the server's digest challenge.</p>`;
  }

  if (a.type === 'jwt') {
    html += `
      <label style="${AUTH_LABEL_STYLE}">Secret (HS256)</label>
      <input type="password" value="${esc(a.jwtSecret)}" oninput="authSet('jwtSecret',this.value);showVarSuggest(this)"
             onkeydown="varSuggestKeydown(this,event)" onblur="varSuggestBlur()"
             style="width:100%;font-family:monospace;margin-bottom:8px">
      <label style="${AUTH_LABEL_STYLE}">Payload (JSON claims)</label>
      <textarea oninput="authSet('jwtPayload',this.value);showVarSuggest(this)"
                onkeydown="varSuggestKeydown(this,event)" onblur="varSuggestBlur()"
                style="width:100%;min-height:100px;font-family:monospace;font-size:12px">${esc(a.jwtPayload)}</textarea>
      <p class="muted"><code>iat</code> and <code>exp</code> (1 hour) are added automatically if not present.</p>`;
  }

  if (a.type === 'none') {
    html += `<p class="muted">No authentication will be sent.</p>`;
  }

  return html;
}

function authTypeChange(v) { activeTab().req.auth.type = v; scheduleAutoSave(); renderReqPanel(); }
function authSet(field, v) { activeTab().req.auth[field] = v; scheduleAutoSave(); }

// ─── Body Editor ──────────────────────────────────────────────────────────────

function bodyHTML(b) {
  const types = ['none', 'raw', 'formdata', 'urlencoded', 'binary', 'graphql'];
  const labels = { none: 'none', raw: 'raw', formdata: 'form-data', urlencoded: 'x-www-form-urlencoded', binary: 'binary', graphql: 'GraphQL' };

  let html = `<div class="body-types">`;

  types.forEach(t => {
    html += `
      <label class="${b.type === t ? 'active-type' : ''}">
        <input type="radio" name="btype" value="${t}" ${b.type === t ? 'checked' : ''}
               onchange="bodyTypeChange('${t}')">
        ${labels[t]}
      </label>`;
  });

  if (b.type === 'raw') {
    html += `
      <select style="margin-left:auto;width:auto;font-size:11px;padding:2px 6px"
              onchange="bodySet('contentType',this.value)">
        ${['json','xml','html','text'].map(t => `<option ${b.contentType === t ? 'selected' : ''}>${t}</option>`).join('')}
      </select>`;
  }

  html += `</div>`;

  if (b.type === 'none') {
    html += `<p class="muted">No body will be sent.</p>`;
  } else if (b.type === 'raw') {
    html += `<textarea id="body-raw-area" oninput="bodySet('raw',this.value);showVarSuggest(this)"
               onkeydown="varSuggestKeydown(this,event)" onblur="varSuggestBlur()">${esc(b.raw)}</textarea>`;
  } else if (b.type === 'binary') {
    html += `
      <div class="kv-file-cell">
        <input type="file" id="body-binary-file" style="display:none" onchange="bodyBinaryFile(this)">
        <button type="button" class="kv-file-btn" onclick="document.getElementById('body-binary-file').click()">Choose File</button>
        <span class="kv-file-name">${b.fileName ? esc(b.fileName) + (b.fileSize != null ? ` (${formatBytes(b.fileSize)})` : '') : 'No file selected'}</span>
      </div>
      ${b.fileName ? `<p class="muted" style="margin-top:8px">Content-Type: <code>${esc(b.binaryMimeType || 'application/octet-stream')}</code></p>` : ''}`;
  } else if (b.type === 'graphql') {
    const gql = b.graphql || { query: '', variables: '' };
    html += `
      <div class="gql-editor">
        <label class="kv-computed-label" style="margin-top:0">Query</label>
        <textarea class="gql-textarea" spellcheck="false" placeholder="query { ... }"
                  oninput="bodyGraphqlSet('query',this.value)">${esc(gql.query)}</textarea>
        <label class="kv-computed-label">Variables (JSON)</label>
        <textarea class="gql-textarea" spellcheck="false" placeholder="{}"
                  oninput="bodyGraphqlSet('variables',this.value)">${esc(gql.variables)}</textarea>
      </div>`;
  } else {
    html += kvEditorHTML(b.formData, 'formData');
  }

  return html;
}

function bodyTypeChange(t) { activeTab().req.body.type = t; scheduleAutoSave(); renderReqPanel(); }
function bodySet(field, v) { activeTab().req.body[field] = v; scheduleAutoSave(); }

function bodyGraphqlSet(field, v) {
  const b = activeTab().req.body;
  if (!b.graphql) b.graphql = { query: '', variables: '' };
  b.graphql[field] = v;
  scheduleAutoSave();
}

// Reads the chosen file as base64 for the "binary" body type.
function bodyBinaryFile(input) {
  const file = input.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const b = activeTab().req.body;
    b.fileName       = file.name;
    b.fileSize       = file.size;
    b.binaryMimeType = file.type || 'application/octet-stream';
    b.fileData       = String(reader.result).split(',')[1] || '';
    scheduleAutoSave(); renderReqPanel();
  };
  reader.readAsDataURL(file);
}

// ─── Scripts Editor (pre-request / test) ───────────────────────────────────────

function scriptsHTML(req) {
  return `
    <div class="scripts-editor">
      <div class="scripts-col">
        <h4>Pre-request Script</h4>
        <p class="muted">Runs before the request is sent. Use <code>pm.environment.set(key, value)</code> /
           <code>pm.environment.get(key)</code> to read or write environment variables.</p>
        <textarea class="script-area" spellcheck="false"
                  oninput="scriptSet('preRequestScript', this.value)"
                  placeholder="pm.environment.set('timestamp', Date.now());">${esc(req.preRequestScript || '')}</textarea>
      </div>
      <div class="scripts-col">
        <h4>Test Script</h4>
        <p class="muted">Runs after the response is received. Use <code>pm.test(name, fn)</code> and
           <code>pm.expect(value)</code> for assertions, <code>pm.response.json()</code> /
           <code>pm.response.text()</code> / <code>pm.response.status</code> to inspect the response, and
           <code>pm.environment.set(key, value)</code> to extract values for later requests.</p>
        <textarea class="script-area" spellcheck="false"
                  oninput="scriptSet('testScript', this.value)"
                  placeholder="pm.test('status is 200', () => pm.expect(pm.response.status).toBe(200));
const data = pm.response.json();
pm.environment.set('token', data.token);">${esc(req.testScript || '')}</textarea>
      </div>
    </div>`;
}

function scriptSet(field, v) {
  activeTab().req[field] = v;
  scheduleAutoSave();
  updateTabBadges();
}

// ─── Docs & Comments ────────────────────────────────────────────────────────────

function docsHTML(req) {
  const author = localStorage.getItem('salvo_comment_author') || '';

  let html = `
    <div class="docs-editor">
      <h4>Description</h4>
      <p class="muted">Notes about what this request does, shown to anyone working in this collection.</p>
      <textarea class="docs-desc-area" placeholder="Describe what this request does..."
                oninput="docsSetDescription(this.value)">${esc(req.description)}</textarea>

      <h4 style="margin-top:16px">Comments</h4>
      <div class="comments-list">`;

  if (!req.comments.length) {
    html += `<p class="muted">No comments yet.</p>`;
  } else {
    const editingId = activeTab().editingCommentId;
    req.comments.forEach(c => {
      const dateLabel = esc(new Date(c.createdAt).toLocaleString()) + (c.editedAt ? ' (edited)' : '');
      if (c.id === editingId) {
        html += `
          <div class="comment-item">
            <div class="comment-meta">
              <span class="comment-author">${esc(c.author || 'Anonymous')}</span>
              <span class="comment-date">${dateLabel}</span>
            </div>
            <textarea id="comment-edit-${c.id}" class="comment-edit-area">${esc(c.text)}</textarea>
            <div class="comment-edit-actions">
              <button class="btn-primary" onclick="saveEditComment('${c.id}')">Save</button>
              <button onclick="cancelEditComment()">Cancel</button>
            </div>
          </div>`;
      } else {
        html += `
          <div class="comment-item">
            <div class="comment-meta">
              <span class="comment-author">${esc(c.author || 'Anonymous')}</span>
              <span class="comment-date">${dateLabel}</span>
              <div class="comment-actions">
                <button class="comment-edit-btn" onclick="startEditComment('${c.id}')">Edit</button>
                <button class="comment-del" onclick="deleteComment('${c.id}')">×</button>
              </div>
            </div>
            <div class="comment-text">${esc(c.text)}</div>
          </div>`;
      }
    });
  }

  html += `</div>
      <div class="comment-add">
        <input id="comment-author-input" placeholder="Your name" value="${esc(author)}" oninput="saveCommentAuthor(this.value)">
        <textarea id="comment-text-input" placeholder="Add a comment..."></textarea>
        <button class="btn-primary" onclick="addComment()">Add Comment</button>
      </div>
    </div>`;

  return html;
}

function docsSetDescription(v) {
  activeTab().req.description = v;
  scheduleAutoSave();
  updateTabBadges();
}

function saveCommentAuthor(v) {
  localStorage.setItem('salvo_comment_author', v);
}

function addComment() {
  const textEl = document.getElementById('comment-text-input');
  const text = textEl.value.trim();
  if (!text) return;
  const author = document.getElementById('comment-author-input').value.trim() || 'Anonymous';
  activeTab().req.comments.push({ id: uid(), author, text, createdAt: Date.now() });
  scheduleAutoSave();
  updateTabBadges();
  renderReqPanel();
}

function startEditComment(id) {
  activeTab().editingCommentId = id;
  renderReqPanel();
}

function cancelEditComment() {
  activeTab().editingCommentId = null;
  renderReqPanel();
}

function saveEditComment(id) {
  const tab = activeTab();
  const textEl = document.getElementById(`comment-edit-${id}`);
  const text = textEl.value.trim();
  if (!text) return;
  const comment = tab.req.comments.find(c => c.id === id);
  if (!comment) return;
  comment.text = text;
  comment.editedAt = Date.now();
  tab.editingCommentId = null;
  scheduleAutoSave();
  renderReqPanel();
}

async function deleteComment(id) {
  const req = activeTab().req;
  const comment = req.comments.find(c => c.id === id);
  const preview = comment?.text.length > 60 ? comment.text.slice(0, 60) + '…' : comment?.text;
  if (!await confirmDialog(`Delete comment "${preview}"?`, { okLabel: 'Delete', danger: true })) return;
  req.comments = req.comments.filter(c => c.id !== id);
  scheduleAutoSave();
  updateTabBadges();
  renderReqPanel();
}

// ─── Saved Response Examples ───────────────────────────────────────────────────

function examplesHTML(req) {
  if (!req.examples.length) {
    return `<p class="muted">No saved examples yet. Send a request, then click "Save as Example" above the response body.</p>`;
  }

  return `<div class="examples-list">` + req.examples.map(ex => {
    const color = statusColor(ex.status);
    return `
      <div class="example-item">
        <span class="example-name">${esc(ex.name)}</span>
        <span class="status-badge" style="background:${color}22;color:${color}">${esc(String(ex.status))} ${esc(ex.statusText || '')}</span>
        <span class="example-date">${esc(new Date(ex.createdAt).toLocaleString())}</span>
        <button onclick="viewExample('${ex.id}')">View</button>
        <button class="comment-del" onclick="deleteExample('${ex.id}')">×</button>
      </div>`;
  }).join('') + `</div>`;
}

// Loads a saved example into the response panel for viewing.
function viewExample(id) {
  const tab = activeTab();
  const ex = tab.req.examples.find(e => e.id === id);
  if (!ex) return;
  let bodyJson = ex.bodyJson;
  if (bodyJson === undefined && ex.bodyType === 'json') {
    try { bodyJson = JSON.parse(ex.body); } catch {}
  }
  tab.resp = {
    status: ex.status, statusText: ex.statusText, headers: ex.headers,
    body: ex.body, bodyJson, bodyType: ex.bodyType, elapsed: 0, size: ex.body?.length ?? null,
  };
  tab.respTab = 'body';
  document.querySelectorAll('[data-rtab]').forEach(t => t.classList.toggle('active', t.dataset.rtab === 'body'));
  renderRespPanel();
  notify(`Viewing example "${ex.name}"`, 'info');
}

async function deleteExample(id) {
  const req = activeTab().req;
  const example = req.examples.find(e => e.id === id);
  if (!await confirmDialog(`Delete example "${example?.name}"?`, { okLabel: 'Delete', danger: true })) return;
  req.examples = req.examples.filter(e => e.id !== id);
  scheduleAutoSave();
  updateTabBadges();
  renderReqPanel();
}

// ─── Mock Response ──────────────────────────────────────────────────────────────

function mockHTML(req) {
  const m = req.mock;
  return `
    <div class="mock-editor">
      <label class="mock-enable" style="display:flex;align-items:center;gap:6px;cursor:pointer">
        <input type="checkbox" ${m.enabled ? 'checked' : ''} onchange="mockSet('enabled',this.checked)">
        Enable mock response for this request
      </label>
      <p class="muted">When the local mock server (topbar → "Mock Server") is running, it will answer
        <strong>${esc(req.method)} ${esc(extractMockPath(req.url))}</strong> with the response below
        instead of forwarding to a real server.</p>

      <label>Status Code</label>
      <input type="number" value="${m.status}" style="width:120px"
             oninput="mockSet('status', parseInt(this.value,10) || 200)">

      <label style="margin-top:12px">Headers</label>
      ${kvEditorHTML(m.headers, 'mockHeaders')}

      <label style="margin-top:12px">Delay (ms)</label>
      <input type="number" value="${m.delay}" min="0" style="width:120px"
             oninput="mockSet('delay', parseInt(this.value,10) || 0)">

      <label style="margin-top:12px">Body</label>
      <textarea id="mock-body-area" oninput="mockSet('body',this.value)">${esc(m.body)}</textarea>
    </div>`;
}

function mockSet(field, v) {
  activeTab().req.mock[field] = v;
  scheduleAutoSave();
  updateTabBadges();
  if (field === 'enabled') renderReqPanel();
}
