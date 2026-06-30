// ─── cURL Generator ───────────────────────────────────────────────────────────

function buildCurl() {
  const r = activeTab()?.req;
  if (!r || !r.url) return '';

  // mcp-stdio requests spawn a local process over stdin/stdout — no HTTP
  // request is made, so there's no curl equivalent.
  if (r.protocol === 'mcp-stdio') return '';

  const isMcpHttp = r.protocol === 'mcp-http';
  const parts = ['curl'];

  // Method (omit -X for GET since it's the default; mcp-http always POSTs
  // a JSON-RPC message regardless of the request's method field)
  if (isMcpHttp) {
    parts.push('-X POST');
  } else if (r.method !== 'GET') {
    parts.push(`-X ${r.method}`);
  }

  // URL + path variables + query params
  let rawUrl = interp(r.url);
  rawUrl = substitutePathVars(rawUrl, r.pathVars);
  if (!rawUrl.match(/^(https?|wss?):\/\//i)) rawUrl = 'https://' + rawUrl;
  try {
    const urlObj = new URL(rawUrl);
    r.params
      .filter(p => p.enabled && p.key)
      .forEach(p => urlObj.searchParams.set(interp(p.key), interp(p.value)));
    rawUrl = urlObj.toString();
  } catch { /* URL still being typed */ }
  parts.push(`'${rawUrl}'`);

  // Auth
  const auth = r.auth;
  if (auth.type === 'bearer' && auth.token) {
    parts.push(`-H 'Authorization: Bearer ${interp(auth.token)}'`);
  } else if (auth.type === 'basic' && (auth.username || auth.password)) {
    parts.push(`-u '${auth.username}:${auth.password}'`);
  } else if (auth.type === 'apikey' && auth.apiKey) {
    parts.push(`-H '${auth.apiKey}: ${auth.apiValue}'`);
  } else if ((auth.type === 'oauth2_cc' || auth.type === 'oauth2_pwd' || auth.type === 'oauth2_auth_code') && auth.cachedToken) {
    parts.push(`-H 'Authorization: Bearer ${auth.cachedToken}'`);
  } else if (auth.type === 'digest' && (auth.username || auth.password)) {
    parts.push(`--digest -u '${auth.username}:${auth.password}'`);
  } else if (auth.type === 'jwt' && auth.jwtSecret) {
    parts.push(`-H 'Authorization: Bearer <JWT signed with HS256, computed at send time>'`);
  }

  // Headers
  r.headers
    .filter(h => h.enabled && h.key)
    .forEach(h => parts.push(`-H '${interp(h.key)}: ${interp(h.value)}'`));

  // mcp-http sends an initial `initialize` JSON-RPC request over a
  // Streamable HTTP POST — show that as the representative request and
  // skip the normal body handling below (req.body is unused for mcp-http).
  if (isMcpHttp) {
    const hasContentType = r.headers.some(h => h.enabled && h.key.toLowerCase() === 'content-type');
    const hasAccept      = r.headers.some(h => h.enabled && h.key.toLowerCase() === 'accept');
    if (!hasContentType) parts.push(`-H 'Content-Type: application/json'`);
    if (!hasAccept)      parts.push(`-H 'Accept: application/json, text/event-stream'`);
    const payload = JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities:    {},
        clientInfo:      { name: 'Volley', version: '1.0' },
      },
    });
    parts.push(`-d '${payload.replace(/'/g, `'\\''`)}'`);
    return parts.join(' \\\n  ');
  }

  // Body
  const body = r.body;
  if (body.type === 'raw' && body.raw) {
    const escaped = interp(body.raw).replace(/'/g, `'\\''`);
    parts.push(`-d '${escaped}'`);
  }
  if (body.type === 'formdata') {
    body.formData
      .filter(f => f.enabled && f.key)
      .forEach(f => parts.push(f.type === 'file'
        ? `-F '${f.key}=@${f.fileName || 'file'}'`
        : `-F '${f.key}=${f.value}'`));
  }
  if (body.type === 'urlencoded') {
    const pairs = body.formData
      .filter(f => f.enabled && f.key)
      .map(f => `${encodeURIComponent(f.key)}=${encodeURIComponent(f.value)}`)
      .join('&');
    if (pairs) parts.push(`--data-urlencode '${pairs}'`);
  }
  if (body.type === 'binary' && body.fileName) {
    parts.push(`--data-binary '@${body.fileName}'`);
  }
  if (body.type === 'graphql' && body.graphql?.query) {
    let variables = {};
    try { variables = JSON.parse(interp(body.graphql.variables || '') || '{}'); } catch {}
    const payload = JSON.stringify({ query: interp(body.graphql.query), variables });
    const hasContentType = r.headers.some(h => h.enabled && h.key.toLowerCase() === 'content-type');
    if (!hasContentType) parts.push(`-H 'Content-Type: application/json'`);
    parts.push(`-d '${payload.replace(/'/g, `'\\''`)}'`);
  }

  // One flag per line for readability
  return parts.join(' \\\n  ');
}

// Builds a curl command targeting this request's mock route directly on the
// running mock server (host:port from /api/mock/status, path from extractMockPath).
function buildMockCurl() {
  const r = activeTab()?.req;
  if (!r || !_mockStatus?.running) return '';

  const host = (typeof location !== 'undefined' && location.hostname) || 'localhost';
  const parts = ['curl'];
  if (r.method !== 'GET') parts.push(`-X ${r.method}`);
  parts.push(`'http://${host}:${_mockStatus.port}${extractMockPath(r.url)}'`);
  return parts.join(' \\\n  ');
}

// Builds a curl command from a request object without variable interpolation —
// used for export so {{variables}} are preserved as-is in the output.
function buildExportCurl(req) {
  if (!req?.url || req.protocol === 'mcp-stdio') return '';
  const r = req;
  const parts = ['curl'];

  if (r.method !== 'GET') parts.push(`-X ${r.method}`);

  let url = r.url;
  if (!url.match(/^https?:\/\//i)) url = 'https://' + url;
  parts.push(`'${url.replace(/'/g, `'\\''`)}'`);

  const auth = r.auth || {};
  if (auth.type === 'bearer' && auth.token)
    parts.push(`-H 'Authorization: Bearer ${auth.token}'`);
  else if (auth.type === 'basic' && (auth.username || auth.password))
    parts.push(`-u '${auth.username}:${auth.password}'`);
  else if (auth.type === 'apikey' && auth.apiKey)
    parts.push(`-H '${auth.apiKey}: ${auth.apiValue}'`);

  (r.headers || []).filter(h => h.enabled && h.key)
    .forEach(h => parts.push(`-H '${h.key}: ${h.value}'`));

  const body = r.body || {};
  if (body.type === 'raw' && body.raw)
    parts.push(`-d '${body.raw.replace(/'/g, `'\\''`)}'`);
  else if (body.type === 'formdata')
    (body.formData || []).filter(f => f.enabled && f.key && f.type !== 'file')
      .forEach(f => parts.push(`-F '${f.key}=${f.value}'`));
  else if (body.type === 'urlencoded') {
    const pairs = (body.formData || []).filter(f => f.enabled && f.key)
      .map(f => `${encodeURIComponent(f.key)}=${encodeURIComponent(f.value)}`).join('&');
    if (pairs) parts.push(`-d '${pairs}'`);
  }

  return parts.join(' \\\n  ');
}

// ─── Tab panel HTML ───────────────────────────────────────────────────────────

function curlPanelHTML() {
  const tab = activeTab();
  const r   = tab?.req;
  if (r?.protocol === 'mcp-stdio') {
    return `<p class="muted">MCP · stdio requests run as a local process over stdin/stdout — there's no curl equivalent.</p>`;
  }

  if (tab?._curlEditMode) return _curlEditPanelHTML(tab);

  const cmd = buildCurl();
  const copyDisabled = !cmd;

  let html = `
    <div style="display:flex;justify-content:flex-end;gap:6px;margin-bottom:8px">
      <button onclick="enterCurlEditMode()" style="font-size:11px;padding:4px 12px">Edit</button>
      <button class="btn-primary" onclick="copyCurl()"
              style="font-size:11px;padding:4px 12px${copyDisabled ? ';opacity:0.4;cursor:not-allowed' : ''}"
              ${copyDisabled ? 'disabled' : ''}>Copy</button>
    </div>
    <pre id="curl-output" style="margin:0;background:var(--bg);border:1px solid var(--bg-input);border-radius:4px;
         padding:12px 14px;font-family:monospace;font-size:12px;line-height:1.7;
         color:var(--text);white-space:pre-wrap;word-break:break-all;min-height:48px">${esc(cmd)}</pre>`;

  if (r?.mock?.enabled && _mockStatus?.running) {
    html += `
      <div class="kv-computed-label" style="margin-top:16px">Mock Server</div>
      <p class="muted">This request's mock is enabled. Test it directly against the running mock server:</p>
      <div style="display:flex;justify-content:flex-end;margin-bottom:8px">
        <button class="btn-primary" onclick="copyMockCurl()" style="font-size:11px;padding:4px 12px">Copy</button>
      </div>
      <pre id="mock-curl-output" style="margin:0;background:var(--bg);border:1px solid var(--bg-input);border-radius:4px;
           padding:12px 14px;font-family:monospace;font-size:12px;line-height:1.7;
           color:var(--text);white-space:pre-wrap;word-break:break-all">${esc(buildMockCurl())}</pre>`;
  }

  return html;
}

function _curlEditPanelHTML(tab) {
  const errors   = tab._curlErrors   || [];
  const warnings = tab._curlWarnings || [];
  const disabled = errors.length > 0;
  const draft    = tab._curlDraft ?? '';

  let msgHtml = '';
  errors.forEach(e   => { msgHtml += `<div class="curl-msg-error">✕ ${esc(e)}</div>`; });
  warnings.forEach(w => { msgHtml += `<div class="curl-msg-warn">⚠ ${esc(w)}</div>`; });

  return `
    <div style="display:flex;align-items:center;justify-content:flex-end;gap:6px;margin-bottom:8px">
      <button id="curl-save-btn" onclick="saveCurlEdit()"
              ${disabled ? 'disabled' : ''}
              class="curl-save-btn${disabled ? ' curl-save-disabled' : ''}"
              style="font-size:11px;padding:4px 12px">Save</button>
      <button class="btn-primary" onclick="cancelCurlEdit()" style="font-size:11px;padding:4px 12px">Cancel</button>
    </div>
    <p class="muted curl-edit-notice">
      Variable references are resolved here — saving replaces them with literal values.
      Changes to other tabs won't apply until saved or cancelled.
    </p>
    <textarea id="curl-edit-area" spellcheck="false"
              oninput="_onCurlEditInput(this.value)"
              class="curl-edit-area">${esc(draft)}</textarea>
    <div id="curl-edit-messages" class="curl-edit-messages"${msgHtml ? '' : ' style="display:none"'}>${msgHtml}</div>`;
}

// ─── Edit mode ────────────────────────────────────────────────────────────────

function enterCurlEditMode() {
  const tab = activeTab();
  if (!tab) return;
  tab._curlEditMode  = true;
  tab._curlDraft     = buildCurl();
  tab._curlErrors    = [];
  tab._curlWarnings  = [];
  renderReqPanel();
  setTimeout(() => document.getElementById('curl-edit-area')?.focus(), 0);
}

function cancelCurlEdit() {
  const tab = activeTab();
  if (!tab) return;
  delete tab._curlEditMode;
  delete tab._curlDraft;
  delete tab._curlErrors;
  delete tab._curlWarnings;
  renderReqPanel();
}

function saveCurlEdit() {
  const tab = activeTab();
  if (!tab) return;
  const text   = document.getElementById('curl-edit-area')?.value ?? tab._curlDraft ?? '';
  const result = parseCurlCommand(text);
  tab._curlErrors   = result.errors;
  tab._curlWarnings = result.warnings;

  if (!result.ok) {
    _updateCurlMessages(result);
    const btn = document.getElementById('curl-save-btn');
    if (btn) { btn.disabled = true; btn.classList.add('curl-save-disabled'); }
    return;
  }

  applyParsedCurl(result, tab);
  delete tab._curlEditMode;
  delete tab._curlDraft;
  delete tab._curlErrors;
  delete tab._curlWarnings;
  syncReqEditor();
  renderReqPanel();
  notify('curl applied', 'success');
}

function _onCurlEditInput(value) {
  const tab = activeTab();
  if (!tab) return;
  tab._curlDraft = value;
  // Re-validate live only after a failed save attempt, so the Save button
  // re-enables as the user fixes errors.
  if (!tab._curlErrors?.length) return;
  const result = parseCurlCommand(value);
  tab._curlErrors   = result.errors;
  tab._curlWarnings = result.warnings;
  _updateCurlMessages(result);
  const btn = document.getElementById('curl-save-btn');
  if (btn) {
    btn.disabled = result.errors.length > 0;
    btn.classList.toggle('curl-save-disabled', result.errors.length > 0);
  }
}

function _updateCurlMessages(result) {
  const el = document.getElementById('curl-edit-messages');
  if (!el) return;
  let html = '';
  result.errors.forEach(e   => { html += `<div class="curl-msg-error">✕ ${esc(e)}</div>`; });
  result.warnings.forEach(w => { html += `<div class="curl-msg-warn">⚠ ${esc(w)}</div>`; });
  el.innerHTML    = html;
  el.style.display = html ? '' : 'none';
}

// ─── curl parser ──────────────────────────────────────────────────────────────

function tokenizeCurl(text) {
  const flat = text.replace(/\\\r?\n\s*/g, ' ').trim();
  const tokens = [];
  let i = 0;
  while (i < flat.length) {
    while (i < flat.length && /\s/.test(flat[i])) i++;
    if (i >= flat.length) break;

    if (flat[i] === '$' && flat[i + 1] === "'") {
      // $'...' ANSI-C quoting (Chrome DevTools uses this for special chars)
      i += 2;
      let tok = '';
      while (i < flat.length && flat[i] !== "'") {
        if (flat[i] === '\\' && i + 1 < flat.length) {
          i++;
          const esc_map = { n: '\n', t: '\t', r: '\r', "'": "'", '\\': '\\' };
          tok += esc_map[flat[i]] ?? ('\\' + flat[i]);
          i++;
        } else {
          tok += flat[i++];
        }
      }
      i++;
      tokens.push(tok);
    } else if (flat[i] === "'") {
      i++;
      let tok = '';
      while (i < flat.length) {
        // '\'' → literal single quote (shell escape)
        if (flat[i] === "'" && flat[i+1] === '\\' && flat[i+2] === "'" && flat[i+3] === "'") {
          tok += "'"; i += 4;
        } else if (flat[i] === "'") {
          i++; break;
        } else {
          tok += flat[i++];
        }
      }
      tokens.push(tok);
    } else if (flat[i] === '"') {
      i++;
      let tok = '';
      while (i < flat.length && flat[i] !== '"') {
        if (flat[i] === '\\' && i + 1 < flat.length) { i++; tok += flat[i++]; }
        else tok += flat[i++];
      }
      i++;
      tokens.push(tok);
    } else {
      let tok = '';
      while (i < flat.length && !/\s/.test(flat[i])) tok += flat[i++];
      tokens.push(tok);
    }
  }
  return tokens;
}

function parseCurlCommand(text) {
  const errors   = [];
  const warnings = [];

  if (/\{\{/.test(text)) {
    errors.push('Variable references ({{...}}) are not supported here — use literal values');
  }

  const tokens = tokenizeCurl(text);
  if (!tokens.length || tokens[0].toLowerCase() !== 'curl') {
    errors.push('Command must start with curl');
    return { ok: false, errors, warnings };
  }

  let method = null;
  let url    = null;
  const headerLines = [];
  let bodyRaw       = null;
  const formParts   = [];
  const urlEncParts = [];
  const unsupported = [];
  let isFormData    = false;
  let isUrlEncoded  = false;

  // Flags that take no value (safe to ignore without consuming next token)
  const NO_VAL_FLAGS = new Set([
    '--compressed', '-v', '--verbose', '-s', '--silent', '-i', '--include',
    '-L', '--location', '-k', '--insecure', '-g', '--globoff',
    '--http1.1', '--http2', '-I', '--head', '--no-keepalive',
  ]);
  // Flags that take a value but whose value we don't use
  const SKIP_VAL_FLAGS = new Set([
    '-A', '--user-agent', '-e', '--referer', '-m', '--max-time',
    '--connect-timeout', '-o', '--output', '-x', '--proxy',
    '--cacert', '--cert', '--key', '--proxy-user',
  ]);

  let i = 1;
  while (i < tokens.length) {
    const tok = tokens[i];

    if (tok === '-X' || tok === '--request') {
      method = tokens[++i]?.toUpperCase() ?? null;
      if (!method) errors.push('Missing value for -X/--request');
    } else if (tok === '-H' || tok === '--header') {
      const hdr = tokens[++i];
      if (!hdr) {
        errors.push('Missing value for -H/--header');
      } else {
        const colon = hdr.indexOf(':');
        if (colon < 1) errors.push(`Invalid header "${hdr}" — expected "Key: Value"`);
        else headerLines.push(hdr);
      }
    } else if (tok === '-d' || tok === '--data' || tok === '--data-raw') {
      bodyRaw = tokens[++i] ?? null;
      if (bodyRaw === null) errors.push(`Missing value for ${tok}`);
    } else if (tok === '--data-binary') {
      const val = tokens[++i] ?? '';
      if (val.startsWith('@')) warnings.push('--data-binary @file is not supported — body will be empty');
      else bodyRaw = val;
    } else if (tok === '-F' || tok === '--form' || tok === '--form-string') {
      const val = tokens[++i];
      if (!val) {
        errors.push(`Missing value for ${tok}`);
      } else {
        isFormData = true;
        const eq = val.indexOf('=');
        if (eq < 1) errors.push(`Invalid form field "${val}" — expected "key=value"`);
        else formParts.push({ key: val.slice(0, eq), value: val.slice(eq + 1) });
      }
    } else if (tok === '--data-urlencode') {
      const val = tokens[++i];
      if (!val) {
        errors.push('Missing value for --data-urlencode');
      } else {
        isUrlEncoded = true;
        const eq = val.indexOf('=');
        urlEncParts.push(eq >= 1
          ? { key: val.slice(0, eq), value: val.slice(eq + 1) }
          : { key: val, value: '' });
      }
    } else if (tok === '-u' || tok === '--user') {
      const val = tokens[++i];
      if (!val) {
        errors.push('Missing value for -u/--user');
      } else {
        const colon = val.indexOf(':');
        const user  = colon >= 0 ? val.slice(0, colon) : val;
        const pass  = colon >= 0 ? val.slice(colon + 1) : '';
        headerLines.push(`Authorization: Basic ${btoa(`${user}:${pass}`)}`);
        warnings.push('-u/--user converted to Authorization: Basic header; Auth tab will be cleared');
      }
    } else if (tok === '--digest') {
      warnings.push('--digest is not supported — configure Digest auth in the Auth tab');
    } else if (NO_VAL_FLAGS.has(tok)) {
      unsupported.push(tok);
    } else if (SKIP_VAL_FLAGS.has(tok)) {
      unsupported.push(tok);
      i++; // skip the value
    } else if (!tok.startsWith('-')) {
      url = tok; // positional arg = URL
    } else {
      unsupported.push(tok);
      // Heuristic: if next token looks like a value (not a flag), skip it
      if (i + 1 < tokens.length && !tokens[i + 1].startsWith('-')) i++;
    }
    i++;
  }

  if (!url) errors.push('No URL found');
  if (unsupported.length) warnings.push(`Ignored unsupported flags: ${unsupported.join(', ')}`);

  // Parse URL — normalise (add https:// if missing), keep query string intact.
  // Use new URL() only for validation; store the original string so that
  // characters like commas in query values are not percent-encoded.
  let parsedUrl = url || '';
  if (url) {
    try {
      let raw = url;
      if (!raw.match(/^https?:\/\//i)) raw = 'https://' + raw;
      new URL(raw); // throws if invalid
      parsedUrl = raw;
    } catch (e) {
      errors.push(`Invalid URL: ${e.message}`);
    }
  }

  // Body type + content
  let bodyType        = 'none';
  let bodyContent     = null;
  let bodyContentType = 'text';

  if (isFormData) {
    bodyType    = 'formdata';
    bodyContent = formParts;
  } else if (isUrlEncoded) {
    bodyType    = 'urlencoded';
    bodyContent = urlEncParts;
  } else if (bodyRaw !== null) {
    bodyType    = 'raw';
    bodyContent = bodyRaw;
    const ctLine = headerLines.find(h => /^content-type:/i.test(h));
    if (ctLine) {
      const ct = ctLine.slice(ctLine.indexOf(':') + 1).trim().toLowerCase();
      if (ct.includes('json')) {
        bodyContentType = 'json';
        if (!/^\s*[\[{]/.test(bodyRaw)) {
          errors.push('Body does not look like valid JSON');
        } else {
          try { JSON.parse(bodyRaw); } catch (e) {
            errors.push(`Body is not valid JSON: ${e.message}`);
          }
        }
      } else if (ct.includes('xml'))  bodyContentType = 'xml';
      else if (ct.includes('html')) bodyContentType = 'html';
    }
  }

  // Infer method if not provided
  if (!method) method = bodyType !== 'none' ? 'POST' : 'GET';

  const clearAuth = headerLines.some(h => /^authorization:/i.test(h));

  return {
    ok: errors.length === 0,
    errors, warnings,
    method, url: parsedUrl,
    headers: headerLines,
    bodyType, bodyContent, bodyContentType,
    clearAuth,
  };
}

function applyParsedCurl(result, tab) {
  const req = tab.req;

  req.method = result.method;
  req.url    = result.url; // full URL including query string

  // Let Volley's own sync function extract params from the URL — this keeps
  // req.url and req.params in the same state as when the user types in the URL bar.
  req.params = [];
  syncParamsFromUrl();

  // Replace headers — no trailing empty row (the kv editor's "+ Add" button handles that)
  req.headers = result.headers.map(h => {
    const colon = h.indexOf(':');
    return { id: uid(), key: h.slice(0, colon).trim(), value: h.slice(colon + 1).trim(), enabled: true, note: '' };
  });

  // Replace body
  req.body = defaultBody();
  if (result.bodyType === 'raw') {
    req.body.type        = 'raw';
    req.body.raw         = result.bodyContent;
    req.body.contentType = result.bodyContentType;
  } else if (result.bodyType === 'formdata') {
    req.body.type     = 'formdata';
    req.body.formData = result.bodyContent.map(f => ({ id: uid(), key: f.key, value: f.value, enabled: true }));
  } else if (result.bodyType === 'urlencoded') {
    req.body.type     = 'urlencoded';
    req.body.formData = result.bodyContent.map(f => ({ id: uid(), key: f.key, value: f.value, enabled: true }));
  }

  // Clear auth if an Authorization header was found in the curl
  if (result.clearAuth) req.auth = defaultAuth();

  scheduleAutoSave();
}

// ─── Bulk curl batch parser ───────────────────────────────────────────────────

function parseCurlBatch(text) {
  const lines  = text.split(/\r?\n/);
  const blocks = [];
  let pendingName = null;
  let curlLines   = [];
  let inCurl      = false;

  const flush = () => {
    if (curlLines.length) {
      blocks.push({ name: pendingName, curlText: curlLines.join('\n') });
    }
    curlLines   = [];
    pendingName = null;
    inCurl      = false;
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed) {
      // Blank line ends a curl block unless mid-continuation
      if (inCurl && !curlLines[curlLines.length - 1]?.trimEnd().endsWith('\\')) flush();
      continue;
    }

    if (trimmed.startsWith('#')) {
      if (inCurl) {
        // Mid-continuation: # is inside the curl command, skip it
        if (curlLines[curlLines.length - 1]?.trimEnd().endsWith('\\')) continue;
        // Otherwise end of curl block — flush before treating # as a name
        flush();
      }
      if (!trimmed.startsWith('#!')) {
        const n = trimmed.slice(1).trim();
        pendingName = n || null;
      }
      continue;
    }

    if (/^curl\b/i.test(trimmed)) {
      if (inCurl) flush();
      inCurl    = true;
      curlLines = [line];
    } else if (inCurl) {
      curlLines.push(line);
    } else {
      // Non-curl, non-comment line resets pending name
      pendingName = null;
    }
  }

  flush();
  return blocks;
}

// Derives a request name from a URL: path if non-root, else hostname without www.
function curlBatchNameFromUrl(url) {
  try {
    const safe = url.replace(/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/g, 'VAR');
    const withScheme = /^https?:\/\//i.test(safe) ? safe : 'https://' + safe;
    const u = new URL(withScheme);
    if (u.pathname && u.pathname !== '/') return u.pathname;
    const host = u.hostname.replace(/^www\./i, '');
    return u.port ? `${host}:${u.port}` : host;
  } catch {
    return url.replace(/^https?:\/\/(www\.)?/i, '').split(/[?#]/)[0] || 'Request';
  }
}

// ─── Copy to clipboard ────────────────────────────────────────────────────────

function copyCurl() {
  const cmd = buildCurl();
  if (!cmd) return;
  copyText(cmd).then(() => notify('curl copied', 'success'));
}

function copyMockCurl() {
  const cmd = buildMockCurl();
  if (!cmd) return;
  copyText(cmd).then(() => notify('mock curl copied', 'success'));
}
