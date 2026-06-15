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
        clientInfo:      { name: 'Salvo', version: '1.0' },
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

// ─── Tab panel HTML ───────────────────────────────────────────────────────────

function curlPanelHTML() {
  const r = activeTab()?.req;
  if (r?.protocol === 'mcp-stdio') {
    return `<p class="muted">MCP · stdio requests run as a local process over stdin/stdout — there's no curl equivalent.</p>`;
  }
  const cmd = buildCurl();
  if (!cmd) return `<p class="muted">Enter a URL to see the curl command.</p>`;

  let html = `
    <div style="display:flex;justify-content:flex-end;margin-bottom:8px">
      <button class="btn-primary" onclick="copyCurl()" style="font-size:11px;padding:4px 12px">Copy</button>
    </div>
    <pre id="curl-output" style="margin:0;background:var(--bg);border:1px solid var(--bg-input);border-radius:4px;
         padding:12px 14px;font-family:monospace;font-size:12px;line-height:1.7;
         color:var(--text);white-space:pre-wrap;word-break:break-all">${esc(cmd)}</pre>`;

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
